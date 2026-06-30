/**
 * T-2717 — Trim policy module (recency comfort window).
 *
 * Rewritten per AC-4 of the T-2717 redesign. The threshold gate is
 * removed: the recency filter now runs **unconditionally** on every
 * `context` event, carving the recency comfort window (default 20
 * turns). The threshold that previously gated the filter is gone —
 * the operator's reframing positions the recency window as a
 * "comfort knob" (how big the verbatim tail gets before old turns
 * retire), not as a compaction trigger. Pi's auto-compaction is
 * left intact and is the safety net.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Recency basis: TURNS (carried forward from BACKUP T-2705)
 *
 *   Same rationale as the T-2705 docstring: turns are the per-LLM-call
 *   "what just happened" signal, parameter-free (no `Date.now()`), and
 *   honest about the recency question (the threshold gate's question is
 *   different and lives elsewhere now — the question of "is it worth
 *   trimming?" was the gate, and the gate is removed).
 *
 *   Default window size: 20 turns (carried forward from BACKUP).
 *   The constant is renamed `RECENCY_COMFORT_WINDOW` to surface the
 *   new role (the recency window is a comfort knob, not a trigger).
 *
 * Threshold: REMOVED (per AC-4)
 *
 *   The previous `THRESHOLD = 100_000` (BACKUP) was a "is the
 *   working window big enough that trimming would save meaningful
 *   cost?" gate. The operator's reframing: the recency window is
 *   always-on, the threshold is gone. Pi's auto-compaction is the
 *   safety net (the compactor fires at `contextWindow - reserveTokens`
 *   per the Pi docs).
 *
 *   The bound derivation in the integration test is now anchored
 *   to the **live** `ctx.getContextUsage().contextWindow` (per AC-4),
 *   with the test pinning `reserveTokens` to the documented default
 *   16384 (the integration test carries the slack as a constant; the
 *   production handler does not read `reserveTokens`).
 *
 * Purity contract (carried forward from T-2705):
 *   - No `Date.now()`, no `Math.random()`, no `process.*`, no I/O.
 *   - No Pi imports. The structural input type is broad enough to accept
 *     Pi's `AgentMessage[]` (the shape the `context` event hands the
 *     handler) without an import.
 *   - Deterministic: identical inputs produce identical outputs across
 *     repeated calls.
 *   - No mutation of the input array — the function returns new arrays.
 *
 * Contract for the caller (`index.ts` `context` handler):
 *   - The `context` event hands the handler `event.messages: AgentMessage[]`
 *     (a deep copy; safe to mutate, but we choose not to). The handler
 *     calls `trimConversation(event.messages, { recencyWindow? })` and
 *     returns `{ messages: <lifecycle-engine output> }` per the Pi
 *     extension contract. The `recencyWindow` is the only knob; the
 *     function does not consult any external state.
 *   - The `trim` set is the messages the recency filter has aged out.
 *     The caller may surface them to a digest surface (the lifecycle
 *     engine) or discard from the per-LLM-call view. The persisted
 *     session file keeps them (the compactor reads the session).
 *   - On malformed input (no `role` discriminator), the function falls
 *     back to the no-op path — it does not throw. This is documented
 *     behavior for defensiveness; the policy is not the validation
 *     surface.
 *
 * NOT this module's job:
 *   - Tool-output lifecycle (verbatim/digest/kept/dropped) — the
 *     lifecycle engine (`lifecycle-state.ts`) owns that.
 *   - The pinned-tier injection — `pinned-tier.ts` owns that.
 *   - Wiring the `turn_end` or `context` triggers — `index.ts` owns
 *     that.
 *   - The `ctx.getContextUsage()` call — `index.ts` owns that (the
 *     integration test reads it for the bound derivation; the
 *     production handler does not gate on it).
 */

// ─── Public constants ──────────────────────────────────────────────────────

/** Recency-window measurement basis. The policy filters on user-message turn boundaries. */
export const RECENCY_BASIS = "turns" as const;
export type RecencyBasis = typeof RECENCY_BASIS;

/**
 * Default recency window: retain the most recent 20 user-message-initiated
 * turns. The recency window is the "comfort knob" — how big the verbatim
 * tail gets before old turns retire. Per AC-4, this is the only retention
 * signal; the threshold gate is removed.
 */
export const RECENCY_COMFORT_WINDOW = 20;
export { RECENCY_COMFORT_WINDOW as DEFAULT_RECENCY_WINDOW }; // Back-compat alias for the T-2705 constant.

/**
 * T-2720 — Per-Pi-turn digest-after threshold (the K knob).
 *
 * The default is `Number.POSITIVE_INFINITY` so the parent (which sets no
 * env) gets the user-turn-bounded behavior unchanged: the per-Pi-turn
 * clause is a no-op when K = Infinity. The subagent dispatch sets
 * `process.env.PI_TURN_DIGEST_AFTER` at the dispatch boundary to override
 * (a small K — typically 1 or 2 — to force-digest tool results after
 * K Pi-turns have elapsed).
 *
 * The constant lives in `policy.ts` (the pure-logic module) so the
 * default value travels with the rest of the recency/threshold
 * constants; the env-var read is in `index.ts` (the wiring surface).
 * Purity contract preserved: no `process.*`, no I/O.
 */
export const PI_TURN_DIGEST_AFTER = Number.POSITIVE_INFINITY;

/**
 * T-2720 — Per-Pi-turn retire-after threshold (the M knob).
 *
 * Same shape as `PI_TURN_DIGEST_AFTER` — the default is Infinity for
 * the parent (the per-Pi-turn retire clause is a no-op), and the
 * subagent dispatch sets `process.env.PI_TURN_RETIRE_AFTER` to a
 * finite N to force-retire the oldest tool outputs after N Pi-turns
 * have elapsed.
 */
export const PI_TURN_RETIRE_AFTER = Number.POSITIVE_INFINITY;

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Structural input message shape. Deliberately NOT importing `AgentMessage`
 * from `@earendil-works/pi-coding-agent` — the policy is a pure-logic
 * module that must be unit-testable in isolation. The structural shape
 * is broad enough to accept Pi's `AgentMessage[]` (the `context` event's
 * payload) directly: Pi's `AgentMessage` is a discriminated union keyed
 * on `role` (e.g. `"user" | "assistant" | "toolResult" | "custom" |
 * "bashExecution" | "branchSummary" | "compactionSummary"`), and the
 * policy only inspects `role`. Extra fields are passed through unchanged.
 */
export interface ConversationMessage {
	/** Pi `AgentMessage` role discriminator. Other fields are passed through untouched. */
	role: string;
	/** Additional fields exist on Pi's `AgentMessage` (content, timestamp, etc.) — preserved. */
	[key: string]: unknown;
}

/** A conversation is a flat, ordered array of messages — the shape the `context` event delivers. */
export type Conversation<T extends ConversationMessage = ConversationMessage> = ReadonlyArray<T>;

/**
 * Optional per-call overrides the caller (`index.ts`) may set. The only
 * knob is the recency window; the threshold knob is gone (per AC-4).
 */
export interface TrimOptions {
	/** Override the default recency comfort window. Must be a positive integer. */
	recencyWindow?: number;
}

/** The policy's return shape. `retain` and `trim` partition the input — see union-equals-input invariant. */
export interface TrimResult<T extends ConversationMessage = ConversationMessage> {
	/** Messages the caller should put back into the per-LLM-call view. */
	retain: T[];
	/** Messages the recency window has aged out — excluded from the view, persisted in the session. */
	trim: T[];
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Identify the indices that start a new turn. A turn starts at any
 * `role: "user"` message. The first message of any non-empty
 * conversation is always a turn start.
 *
 * Exported (not via an internal-only export) so the boundary cases
 * are testable in isolation, but treated as a private surface by
 * consumers — only `trimConversation` is the public API.
 */
export function findTurnStartIndices<T extends ConversationMessage>(messages: T[]): number[] {
	const starts: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg && msg.role === "user") {
			starts.push(i);
		}
	}
	return starts;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Apply the recency comfort-window policy: given a conversation, return
 * the disjoint partition of messages to retain and to trim. The function
 * runs **unconditionally** on every `context` event — the threshold gate
 * is removed per AC-4 (the recency window is a comfort knob, not a
 * compaction trigger; Pi's auto-compaction is the safety net).
 *
 * Recency filter: retain the most recent `recencyWindow` user-message-
 * initiated turns and trim everything before the start of the (N-th)-
 * most-recent turn. Where the window exceeds the available turns, all
 * messages are retained (the recency filter cannot carve what does not
 * exist).
 *
 * Purity (AC-3): no Pi imports, no I/O, no `Date.now()`, no `process.*`.
 * The caller passes everything the function needs via arguments. The
 * input array is not mutated; `retain` and `trim` are fresh arrays.
 *
 * Union-equals-input invariant: `retain.length + trim.length === messages.length`,
 * and every message appears in exactly one of the two sets. Asserted in
 * `policy.test.ts`.
 *
 * @param messages — the per-LLM-call message array (the `context` event's
 *   `event.messages`). Pass-through shape; the function does not transform
 *   message contents.
 * @param options — per-call overrides for `recencyWindow`. Defaults to
 *   the module constant.
 */
export function trimConversation<T extends ConversationMessage>(
	messages: T[],
	options?: TrimOptions,
): TrimResult<T> {
	const recencyWindow = options?.recencyWindow ?? RECENCY_COMFORT_WINDOW;

	// Defensive: malformed options collapse to the default. Documented
	// behavior; the policy is not the validation surface.
	const effectiveWindow =
		Number.isInteger(recencyWindow) && recencyWindow > 0
			? recencyWindow
			: RECENCY_COMFORT_WINDOW;

	// Empty input: trivially nothing to trim. Documented no-op.
	if (messages.length === 0) {
		return { retain: messages.slice(), trim: [] };
	}

	// Find the turn boundaries. A turn starts at any `role: "user"`
	// message. The first message of any non-empty conversation is
	// always a turn start (by the recency-contract definition).
	const turnStarts = findTurnStartIndices(messages);

	// No user messages: recency contract has no anchor. Fall back to
	// the no-op path (retain all, trim none). Documented behavior.
	if (turnStarts.length === 0) {
		return { retain: messages.slice(), trim: [] };
	}

	// Retain the most recent `effectiveWindow` turns. The N-th-most-recent
	// turn starts at `turnStarts[turnStarts.length - effectiveWindow]`.
	// If the available turns are fewer than the window, retain all.
	const retainFromIndex =
		turnStarts.length >= effectiveWindow
			? turnStarts[turnStarts.length - effectiveWindow]
			: 0;

	const retain = messages.slice(retainFromIndex);
	const trim = messages.slice(0, retainFromIndex);

	return { retain, trim };
}
