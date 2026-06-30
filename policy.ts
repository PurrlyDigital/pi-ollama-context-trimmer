/**
 * T-2705 — Trim policy module (recency window + threshold gating)
 *
 * Pure-logic policy consumed by the context-event handler in T-2706.
 * No Pi imports, no I/O, no global reads — unit-testable in isolation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Module-level rationale (the load-bearing decision surface for AC-1/AC-2).
 *
 * Recency basis: TURNS (specifically, "user-message-initiated turns" — a turn
 * is the slice of a flat `Message[]` that starts at a user-role message and
 * runs through the subsequent assistant + tool-result messages, ending at the
 * next user-role message or the end of the array).
 *
 *   Why turns and not wall-clock:
 *     - Wall-clock is session-shape-dependent and bursty: a tool-heavy turn
 *       can advance minutes of wall-clock per single conversation step.
 *       Recency-by-wall-clock would drop turns the agent is actively working
 *       on and retain stale turns the agent has finished — exactly inverted
 *       from the recency-primary contract (parent TDT constraint #1).
 *     - Wall-clock also leaks a hidden global (`Date.now()`) into the policy,
 *       which AC-3 forbids: purity requires the function to receive `now` as
 *       a parameter, which then couples the caller to the policy's clock
 *       discipline. Turns is parameter-free.
 *
 *   Why turns and not token-estimate:
 *     - Token estimation is the most accurate recency measure (it tracks
 *       what the LLM actually pays per call), but it requires a tokenizer
 *       the policy does not own. Pi ships `estimateTokens()` from
 *       `core/compaction`, but the recency window is a *count of recent
 *       conversation steps* (the "what just happened" signal), not a
 *       token-budget selector (that's the threshold gate's job, below).
 *       Conflating the two would couple the recency policy to the cost
 *       model — a seam we want clean so the recency behavior is testable
 *       without a tokenizer.
 *
 *   Why turns fits the trigger surface:
 *     - T-2704 locked the trigger as `turn_end` ("Fired for each turn
 *       (one LLM response + tool calls)"). The trigger advances per
 *       turn; the recency window measures per turn. Same unit on both
 *       sides of the seam — no conversion, no surprise.
 *
 *   Default window size: 20 turns.
 *     - 20 user-prompt turns ≈ 20 user-messages + their assistant responses
 *       + the tool-result chain the assistant produced. On GLM-5.2 with
 *       no input caching (the parent TDT's motivating problem), 20 turns
 *       keeps the working window bounded while preserving enough
 *       in-flight context for the model to track an open task.
 *     - The number is a default; the caller (T-2706) may override per
 *       session via the `recencyWindow` option.
 *
 * Threshold gate: TOKENS (matches `ctx.getContextUsage().tokens`, the
 *   surface the mechanism decision named as the threshold check).
 *
 *   Why tokens for the gate (and not for the recency window):
 *     - The threshold gate is a *cost gate*: "is the working window big
 *       enough that trimming would save meaningful cost?" The token
 *       count from `getContextUsage()` is the only honest answer to that
 *       question on a no-cache model — it tracks what the LLM actually
 *       processes per call.
 *     - This keeps a clean split of concerns: the threshold gate answers
 *       "is it worth trimming?" in tokens; the recency window answers
 *       "what to retain?" in turns. Each basis is honest about the
 *       question it answers.
 *
 *   Default threshold: 50_000 tokens.
 *     - Pi's auto-compaction fires at `contextWindow - reserveTokens`
 *       (128_000 - 16_384 ≈ 111_616 by default; see T-2704 §3). The
 *       trimmer must fire *before* Pi's compactor does, otherwise the
 *       per-call view grows to the compaction threshold and we are
 *       paying full cost right up to the moment compaction kicks in.
 *     - 50_000 leaves roughly 60% of the headroom (50k -> 112k) for the
 *       trimmer to act, is high enough that "tiny sessions" (the no-op
 *       path) covers most real Pi sessions until bloat accumulates, and
 *       is testable as a literal constant.
 *     - The number is a default; the caller (T-2706) may override per
 *       session via the `threshold` option.
 *
 *   Boundary semantics: at exactly `THRESHOLD` tokens, the gate OPENS
 *     (the policy runs). The threshold is the "trimming is now worth it"
 *     line, and the recency filter at the boundary produces a
 *     deterministic, testable output. The boundary case is asserted
 *     explicitly in `policy.test.ts`.
 *
 * Purity contract (AC-3):
 *   - No `Date.now()`, no `Math.random()`, no `process.*`, no I/O.
 *   - No Pi imports. The structural input type is broad enough to accept
 *     Pi's `AgentMessage[]` (the shape the `context` event hands the
 *     handler) without an import — the caller bridges Pi types to the
 *     policy type at the import boundary.
 *   - Deterministic: identical inputs produce identical outputs across
 *     repeated calls (asserted in the determinism test).
 *   - No mutation of the input array — the function returns new arrays.
 *
 * Contract for T-2706 (the caller, T-2703.3 context-mutation handler):
 *   - The `context` event hands the handler `event.messages: AgentMessage[]`
 *     (a deep copy; safe to mutate, but we choose not to). The handler
 *     calls `trimConversation(event.messages, { tokens:
 *     ctx.getContextUsage()?.tokens ?? 0 }, options?)` and returns
 *     `{ messages: result.retain }` per the Pi extension contract.
 *   - The `trim` set is a first-class return value: T-2707 (the digest
 *     surface) may consume it to surface "what was trimmed" to the
 *     agent. The *act* of digesting is T-2707's job; this policy only
 *     partitions the messages.
 *   - Per-session overrides: T-2706 may pass `recencyWindow` and/or
 *     `threshold` as non-default values; the function honors them.
 *   - On malformed input (no `role` discriminator), the function falls
 *     back to the no-op path — it does not throw. This is documented
 *     behavior for defensiveness; the policy is not the validation
 *     surface.
 *
 * NOT this module's job:
 *   - Tool-output digesting at the source (T-2707).
 *   - Compaction coexistence (Pi's own `session_before_compact`).
 *   - Wiring the `turn_end` trigger or the `getContextUsage()` check
 *     (T-2706).
 *   - File-read recovery or keep-vs-drop semantics (T-2707).
 */

// ─── Public constants ──────────────────────────────────────────────────────

/** Recency-window measurement basis. The policy filters on user-message turn boundaries. */
export const RECENCY_BASIS = "turns" as const;
export type RecencyBasis = typeof RECENCY_BASIS;

/** Default recency window: retain the most recent 20 user-message-initiated turns. */
export const DEFAULT_RECENCY_WINDOW = 20;

/** Default threshold gate: 50_000 tokens (matches `ctx.getContextUsage().tokens`). */
export const THRESHOLD = 50_000;

/** Threshold measurement unit. The caller passes `getContextUsage().tokens` as the value. */
export const THRESHOLD_UNIT = "tokens" as const;
export type ThresholdUnit = typeof THRESHOLD_UNIT;

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Structural input message shape.
 *
 * Deliberately NOT importing `AgentMessage` from `@earendil-works/pi-coding-agent`
 * — the policy is a pure-logic module that must be unit-testable in isolation
 * without resolving the Pi module graph. The structural shape is broad enough
 * to accept Pi's `AgentMessage[]` (the `context` event's payload) directly:
 * Pi's `AgentMessage` is a discriminated union keyed on `role` (e.g.
 * `"user" | "assistant" | "toolResult" | "custom" | "bashExecution" |
 * "branchSummary" | "compactionSummary"`), and the policy only inspects
 * `role`. Extra fields (content, timestamp, etc.) are passed through
 * unchanged.
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
 * Usage metrics the threshold gate consumes. The caller (T-2706) passes
 * `ctx.getContextUsage()` directly; if the usage is unavailable (returns
 * `undefined` per the docs), the caller passes `{ tokens: 0 }` and the
 * gate stays closed (no-op path) — defensive default.
 */
export interface UsageMetrics {
	/** Total context tokens, as reported by `ctx.getContextUsage().tokens`. */
	tokens: number;
}

/** Optional per-call overrides the caller (T-2706) may set. */
export interface TrimOptions {
	/** Override the default recency window. Must be a positive integer. */
	recencyWindow?: number;
	/** Override the default threshold (in tokens). Must be a non-negative number. */
	threshold?: number;
}

/** The policy's return shape. `retain` and `trim` partition the input — see union-equals-input invariant. */
export interface TrimResult<T extends ConversationMessage = ConversationMessage> {
	/** Messages the caller should put back into the per-LLM-call view. */
	retain: T[];
	/** Messages the caller may surface to a digest surface (T-2707) or discard. */
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
 * Apply the trim policy: given a conversation and usage metrics, return the
 * disjoint partition of messages to retain and to trim.
 *
 * Threshold gate (AC-2): if `metrics.tokens < threshold` (or the conversation
 * is empty), the function returns the input as `retain` and `trim: []` — a
 * no-op. Tiny sessions are not trimmed.
 *
 * Recency filter (AC-1): if the gate opens, the function retains the most
 * recent `recencyWindow` user-message-initiated turns and trims everything
 * before the start of the (N-th)-most-recent turn. Where the window exceeds
 * the available turns, all messages are retained (recency filter cannot
 * carve what does not exist).
 *
 * Purity (AC-3): no Pi imports, no I/O, no `Date.now()`, no `process.*`. The
 * caller passes everything the function needs via arguments. The input
 * array is not mutated; `retain` and `trim` are fresh arrays.
 *
 * Union-equals-input invariant: `retain.length + trim.length === messages.length`,
 * and every message appears in exactly one of the two sets. Asserted in
 * `policy.test.ts`.
 *
 * @param messages — the per-LLM-call message array (the `context` event's
 *   `event.messages`). Pass-through shape; the function does not transform
 *   message contents.
 * @param metrics — usage metrics; only `tokens` is read. The caller passes
 *   `ctx.getContextUsage()` (or `{ tokens: 0 }` if usage is unavailable).
 * @param options — per-call overrides for `recencyWindow` and `threshold`.
 *   Both default to the module constants.
 */
export function trimConversation<T extends ConversationMessage>(
	messages: T[],
	metrics: UsageMetrics,
	options?: TrimOptions,
): TrimResult<T> {
	const recencyWindow = options?.recencyWindow ?? DEFAULT_RECENCY_WINDOW;
	const threshold = options?.threshold ?? THRESHOLD;

	// Defensive: malformed/invalid options collapse to the defaults.
	// Documented behavior; the policy is not the validation surface.
	const effectiveWindow =
		Number.isInteger(recencyWindow) && recencyWindow > 0 ? recencyWindow : DEFAULT_RECENCY_WINDOW;
	const effectiveThreshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : THRESHOLD;

	// Threshold gate: under-threshold is a no-op. Includes the empty-input
	// case (empty input is trivially under-threshold).
	if (messages.length === 0 || metrics.tokens < effectiveThreshold) {
		return {
			retain: messages.slice(),
			trim: [],
		};
	}

	// Over-threshold: apply the recency filter on turn boundaries.
	const turnStarts = findTurnStartIndices(messages);

	// If no user messages exist (e.g. an extension-injected `custom` or
	// `bashExecution` session), there are no turn boundaries to filter on.
	// The policy cannot carve what does not exist; fall back to the no-op
	// path. This is documented behavior — without a user message, the
	// recency contract has no anchor.
	if (turnStarts.length === 0) {
		return {
			retain: messages.slice(),
			trim: [],
		};
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
