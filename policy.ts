// ─── Token-tier trim policy (three-tier amended design) ────────────────
//
// Three tiers, keyed on the total token count of the trimmable messages
// (chars / 4 per message, summed):
//
//   0–50k          → verbatim, no action
//   50k–100k       → hold middle-band messages untouched (transient
//                    behavior; Tier 3 catches oversize if it grows further)
//   100k+          → hard drop the OLDEST whole turns (user+assistant+
//                    tool+custom together) until the total is back under
//                    100k
//
// Subagent protected inputs (subagent-only, excluded from the 50k/100k
// budget, never dropped):
//   1. The system prompt (agent def). It travels as a SEPARATE field on
//      the LLM call, NOT in the trimmable `messages` array — so the
//      protection is a no-op for this code path (its tokens are never
//      in the budget). Documented here so the invariant is visible.
//   2. The first user message (dispatch instructions). The first user
//      message carries the dispatch task; removing it would lose the
//      subagent's instructions. The message is marked
//      with `userTurnAge === 0` in the stamp; the exemption reads that
//      field. The spec also requires that its tokens be SUBTRACTED from
//      the cap total so the budget measures only the trimmable mass.
//
// The 25-Pi-turn arm gate and the K/M per-Pi-turn digest cadence from
// the prior design are NOT carried forward; the amended spec replaces
// them with the token tiers alone.

import * as path from "node:path";

// ─── Constants ─────────────────────────────────────────────────────────

/** Verbatim tier ceiling. Totals at or below this are untouched. */
export const VERBATIM_TIER_MAX_TOKENS = 50_000;

/** Summarize tier ceiling. Totals above this fall into the drop tier. */
export const SUMMARIZE_TIER_MAX_TOKENS = 100_000;


/**
 * Compile-time default for the per-message token estimator divisor.
 * The wiring layer uses this when neither the env var nor the JSON
 * key sets a value. `3` reflects the chars/3 default that targets
 * JSON/markup/code-heavy trimmable mass; the legacy chars/4
 * behavior is reachable by setting the operator knob to `4`.
 */
export const TOKEN_ESTIMATOR_DIVISOR_DEFAULT = 3;

/**
 * The plain-English aggregate prune reminder the policy injects at
 * the start of the tier-3 prune pass when any turns are dropped.
 * The reminder is a single, model-facing message that lets the LLM
 * know that older trimmable context was pruned; without it, a
 * model can spin ("I thought I had X but it's gone") when the
 * trimmable tail it expected to consult is no longer in view. The
 * reminder names (a) the extension, (b) the action, (c) the scope,
 * and (d) a conditional "get it fresh" retrieval hint — phrased
 * as a possibility, not a directive, so the model treats retrieval
 * as one option among many, not a mandate.
 *
 * The constant lives in `policy.ts` because the reminder is a
 * pure-policy concern: the string is a pure function of the drop
 * event, not of any operator state. No env reads, no fs I/O — the
 * purity contract (AGENTS.md rule 7) holds. The wiring layer does
 * not need to know about the constant; `result.messages` carries
 * the reminder out structurally.
 */
const PRUNE_REMINDER_TEXT =
	"The Context Trimmer extension has automatically pruned older things in context that weren't asked to be kept. " +
	"If you need something that was cut, get it fresh.";

// ─── Public types ──────────────────────────────────────────────────────

/**
 * The shape the policy needs from a trimmable message. The full
 * session message type carries more (provider, timestamp, etc.) but the
 * policy only needs `role`, `content` (text-extractable), `userTurnAge`
 * (the protection marker for the dispatch task), and `customType`
 * (the protection marker for the agent-def / pinned-tier synthetic).
 *
 * `userTurnAge` is the user-turn index stamped at `before_agent_start`
 * view time. The first user message has `userTurnAge === 0`; the
 * dispatch-instruction protection reads that field.
 *
 * `customType` is the magic string the wiring layer stamps on a
 * synthetic message that carries the agent def (e.g.
 * `"context-trimmer-pinned"`). The protection for that slot is via
 * `options.protectedCustomTypes`.
 */
export type TrimmableMessage = {
	role: "user" | "assistant" | "toolResult" | "custom";
	content: unknown;
	userTurnAge?: number;
	customType?: string;
	details?: Record<string, unknown>;
};

/** Options bag for `applyThreeTierTrim`. */
export type TrimOptions = {
	/**
	 * Override the verbatim tier ceiling (default 50k). Useful for tests
	 * that want to exercise the boundary at a smaller scale.
	 */
	verbatimMaxTokens?: number;
	/**
	 * Override the summarize tier ceiling (default 100k).
	 */
	summarizeMaxTokens?: number;

	/**
	 * The set of `customType` values that mark a message as a protected
	 * slot (e.g. the agent-def / pinned-tier synthetic). Protected
	 * custom-type messages are excluded from the budget, never
	 * dropped. The wiring layer passes the
	 * pinning customType (e.g. `"context-trimmer-pinned"`) here.
	 */
	protectedCustomTypes?: ReadonlySet<string>;
	/**
	 * Whether to protect the first user message as a subagent dispatch
	 * slot (exempting it from drop and subtracting its tokens
	 * from the budget). Defaults to `true`. The wiring layer sets this
	 * based on whether the `pi-subagents` extension is installed — the
	 * protection only makes sense in a subagent session, so a plain
	 * parent session with no subagent tool leaves the first user prompt
	 * treated as ordinary trimmable content. The customType-based
	 * protection above is independent of this flag.
	 */
	protectDispatch?: boolean;
	/**
	 * Path patterns that mark a message as a protected slot via its
	 * stamped source path. A message whose `details.sourcePath` matches
	 * a pattern (per the locked fuzzy-vs-absolute grammar; see
	 * `isPathPreserved`) is excluded from the budget, never dropped.
	 * The wiring layer passes the operator-resolved
	 * `preservedPaths` (with `~/` already expanded via `os.homedir()`)
	 * here. Defaults to `[]` (no paths preserved) so the predicate
	 * shape is uniform across all internal call sites.
	 */
	preservedPatterns?: ReadonlyArray<string>;
	/**
	 * The lower bound the tier-3 drop must not undershoot by dropping a
	 * whole turn. When set, `dropOldestTurns` stops one step before the
	 * remaining trimmable mass would dip below this floor; the
	 * fall-through returns the surviving messages as-is (the summarize
	 * path was removed; this is the transient hold-untouched seam).
	 * `undefined` or non-positive values disable the floor
	 * (legacy behavior: drop until the trimmable total ≤
	 * `summarizeMaxTokens`).
	 */
	dropFloorTokens?: number;
	/**
	 * A token count; the most-recent-N-tokens of trimmable content
	 * protected from drop. The recency slice is computed
	 * once at the top of `applyThreeTierTrim` and threaded through
	 * every internal call; messages in the slice are treated as
	 * protected (additive OR with the existing channels) and excluded
	 * from the trimmable budget. `undefined` or non-positive values
	 * disable recency protection (legacy behavior: every trimmable
	 * message is a candidate for drop).
	 */
	recencyFloor?: number;

	/**
	 * Tool-call IDs whose assistant `toolCall` blocks are protected
	 * from drop. The set is computed by the wiring
	 * layer at view time by walking every assistant message's
	 * `toolCall` content blocks and matching `arguments.path`
	 * against `preservedPatterns` (via the existing pure
	 * `isPathPreserved`). The set threads through every internal
	 * call as an additive OR with the existing protected-slot
	 * channels:
	 *
	 *   - A `toolResult` whose `toolCallId` is in this set is a
	 *     protected message-level slot. It is
	 *     excluded from the budget, never dropped — including the
	 *     carve-out of the dropped-turn slice in `dropOldestTurns`.
	 *   - When an assistant turn falls in a dropped turn's range,
	 *     the protected `toolCall` blocks (those whose
	 *     `id` is in this set) survive INSIDE the turn while
	 *     `text`/`thinking` and unprotected `toolCall` blocks are
	 *     dropped. The pair is atomic in both
	 *     directions: an unprotected `toolCall` block that is
	 *     dropped has its matching `toolResult` dropped
	 *     with it (no orphan).
	 *
	 * Defaults to an empty set so the predicate shape is uniform
	 * across every internal call site. The wiring layer is the
	 * sole source of the set; `policy.ts` never reads
	 * `arguments.path` directly (the purity contract keeps all
	 * argument extraction in `index.ts`).
	 */
	protectedToolCallIds?: ReadonlySet<string>;
	/**
	 * Override the per-message token estimator divisor (default 3,
	 * `TOKEN_ESTIMATOR_DIVISOR_DEFAULT`). Used by both
	 * `approximateMessageTokens` and `approximateTextTokens` for
	 * every internal token-count site (trimmable mass, protected
	 * mass, system-prompt mass).
	 * The wiring layer resolves this from
	 * `PI_CONTEXT_TRIMMER_TOKEN_ESTIMATOR_DIVISOR` env var and
	 * the `tokenEstimatorDivisor` JSON key per the existing env >
	 * JSON > default precedence. The policy never reads
	 * `process.env` directly — the resolved value arrives as a
	 * number on this field. `undefined` or non-positive values
	 * fall through to `TOKEN_ESTIMATOR_DIVISOR_DEFAULT`.
	 */
	tokenEstimatorDivisor?: number;
	/**
	 * The system-prompt token count for the current turn. The
	 * wiring layer computes this from
	 * `ctx.getSystemPrompt()` and the same `approximateTextTokens`
	 * estimator the policy uses for messages, with the same
	 * divisor. The system-prompt mass is constant within a single
	 * trim pass (it does not change mid-trim) and is subtracted
	 * from both tier caps alongside the protected-slot mass so
	 * the effective budget reserves space for it. Default 0 —
	 * the policy degrades to the AC-1 `tierNMax − protectedMass`
	 * behavior when the wiring does not pass a count (test mocks,
	 * minimal harness contexts). The policy never calls
	 * `ctx.getSystemPrompt()` itself; the value arrives as a
	 * number on this field. The system-prompt string is a
	 * harness surface and stays in the wiring layer per the
	 * purity contract (AGENTS.md rule 8).
	 */
	systemPromptTokens?: number;
};

/** The return value. A fresh `messages` array (possibly shorter). */
export type TrimResult = {
	/** The messages that survive, in original order. */
	messages: TrimmableMessage[];
	/** Diagnostic counter (number of messages dropped). */
	droppedTurns: number;
	/**
	 * Total tokens of the returned messages (including protected slots;
	 * informational only).
	 */
	totalTokens: number;
};

// ─── Per-message token accounting (chars / divisor) ─────────────────────

/**
 * Approximate the token count of a plain text string by dividing
 * the character count by `divisor`. Returns `Math.ceil(text.length /
 * divisor)`. The estimator is a lower bound on a real provider
 * tokenizer; the divisor lets operators tune the constant to
 * match the provider's actual per-token character ratio (the
 * default `TOKEN_ESTIMATOR_DIVISOR_DEFAULT = 3` targets
 * JSON/markup/code-heavy trimmable mass; the legacy chars/4
 * behavior is reachable by passing `4`).
 *
 * Pure: string in, number out. No I/O, no `process.*`. Exported
 * so the wiring layer can compute the system-prompt token count
 * (a harness surface, `ctx.getSystemPrompt()`) with the same
 * estimator the policy uses for message tokens — the trimmer's
 * view of the system prompt and its view of the messages are
 * then on the same scale.
 */
export function approximateTextTokens(text: string, divisor: number): number {
	return Math.ceil(text.length / divisor);
}

/**
 * Approximate the token count of a single message by summing the
 * text content and dividing by `divisor`. The harness convention
 * (per CLAUDE.md and the documented model-card values) is
 * roughly `chars / N` for some provider-specific `N`; the
 * default `3` reflects chars/3 (the chars/4 legacy is reachable
 * by passing `4`). Non-text content blocks are stringified;
 * custom roles fall through to JSON.
 *
 * The function is intentionally permissive on input shape — the
 * message type is structural and content blocks vary by role and
 * provider. The accounting is a lower bound (we undercount
 * multi-modal content), which biases toward trim; that's the
 * safe direction.
 *
 * The default `divisor` is `TOKEN_ESTIMATOR_DIVISOR_DEFAULT`
 * (= 3) — not 4, the legacy hard-coded value. The legacy
 * behavior is preserved by an operator setting the divisor
 * knob to 4 via the env/JSON channel (the wiring layer is the
 * sole source of the operator-resolved value; this default
 * keeps the policy self-consistent for tests that don't pass
 * a divisor).
 */
export function approximateMessageTokens(
	msg: TrimmableMessage,
	divisor: number = TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
): number {
	const text = extractText(msg.content);
	return approximateTextTokens(text, divisor);
}

/**
 * Extract the text content of a message. Handles the common shapes:
 *   - string content (a plain user/assistant message body)
 *   - array of `{ type: "text", text: string }` content blocks
 *   - tool-result content (string or array of blocks)
 *   - any other shape: JSON.stringify as a last resort
 *
 * Exported for test introspection.
 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const block of content) {
			if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
				out += (block as { text: string }).text;
			} else if (block && typeof block === "object") {
				out += JSON.stringify(block);
			} else {
				out += String(block);
			}
		}
		return out;
	}
	if (content && typeof content === "object") {
		return JSON.stringify(content);
	}
	return String(content ?? "");
}

// ─── Protected-slot predicate ──────────────────────────────────────────

/**
 * The protected-slot predicate. A message is protected if it is:
 *   - The dispatch task (first user message; `userTurnAge === 0`,
 *     or position 0 of the trimmable array if `userTurnAge` is
 *     missing), OR
 *   - A pinned-tier / agent-def synthetic whose `customType` is in
 *     `protectedCustomTypes` (set via `TrimOptions`).
 *
 * The system-prompt travel channel (a separate field on the LLM
 * call, not in `messages`) is implicitly protected because its
 * tokens are never in the budget — there is no code branch for it.
 * The pinned-tier synthetic that travels IN `messages` is the
 * agent-def carrier in this implementation, and it is protected by
 * the `customType` check.
 */

// ─── Path-preserved predicate (preserved-paths channel) ───────────────

/**
 * A pattern is **absolute** iff it begins with `/` or `~/`. Absolute
 * patterns match when the expanded, normalized form equals the
 * source path's normalized form. A **fuzzy** pattern (no leading
 * `/` or `~/`) matches when the source path's basename equals the
 * pattern. The wiring layer expands `~/` to the operator's home
 * directory before the pattern reaches this predicate — the predicate
 * never reads `os.homedir()` and stays pure-functional.
 *
 * `node:path` is a pure-functional Node built-in (no I/O), so it is
 * acceptable inside `policy.ts` per the AGENTS.md purity contract.
 * `path.normalize` collapses redundant separators and `..` / `.`
 * segments without touching the filesystem.
 */
function isAbsolutePattern(pattern: string): boolean {
	return pattern.startsWith("/") || pattern.startsWith("~/");
}

/**
 * Pure predicate: does `sourcePath` match any pattern in `patterns`?
 * Empty `patterns` or `undefined` `sourcePath` short-circuit to
 * `false`. The match grammar:
 *
 *   - Absolute pattern (leading `/` or `~/`): `path.normalize(pattern)
 *     === path.normalize(sourcePath)`. The wiring has already
 *     expanded `~/` to the operator's home directory.
 *   - Fuzzy pattern (no leading `/` or `~/`):
 *     `path.basename(sourcePath) === pattern`.
 *
 * Case-sensitive (Linux default). No glob support. No symlink
 * resolution. All of those are deferred per AC-4.
 */
export function isPathPreserved(
	sourcePath: string | undefined,
	patterns: ReadonlyArray<string>,
): boolean {
	if (sourcePath === undefined) return false;
	if (patterns.length === 0) return false;
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.length === 0) continue;
		if (isAbsolutePattern(pattern)) {
			if (path.normalize(pattern) === path.normalize(sourcePath)) return true;
		} else {
			if (path.basename(sourcePath) === pattern) return true;
		}
	}
	return false;
}

/**
 * Extract the stamped source path from a TrimmableMessage's
 * `details` field. The wiring stamps via `details.sourcePath`; the
 * predicate signature is `sourcePath: string | undefined` regardless
 * of where the value comes from.
 */
function extractSourcePath(msg: TrimmableMessage): string | undefined {
	const details = msg.details;
	if (!details || typeof details !== "object") return undefined;
	const sourcePath = (details as Record<string, unknown>).sourcePath;
	return typeof sourcePath === "string" ? sourcePath : undefined;
}

/**
 * Pure helper for the block-level carve-out in `dropOldestTurns`.
 * Given an assistant message and the protected-toolCall-id set,
 * returns a rewritten message that carries ONLY the protected
 * `toolCall` blocks (the message's `text`, `thinking`, and
 * unprotected `toolCall` blocks are removed). The dropped
 * `toolCall` block IDs are pushed into `droppedToolCallIds` so the
 * post-pass `toolResult` drop in `dropOldestTurns` can carry out
 * the pair-atomic drop in both directions.
 *
 * Returns `null` when the rewritten message would carry no
 * content (no protected `toolCall` blocks and no other kept
 * blocks), signaling to the caller that the message should be
 * dropped from the output entirely.
 *
 * Pure: operates on the message and the predicate arguments; no
 * `process.*`, no Node I/O. The content array is walked in
 * source order; the rewritten content is a fresh array.
 */
function carveProtectedToolCallBlocks(
	msg: TrimmableMessage,
	protectedToolCallIds: ReadonlySet<string>,
	droppedToolCallIds: Set<string>,
): TrimmableMessage | null {
	const content = msg.content;
	if (!Array.isArray(content)) return null;
	const kept: unknown[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall") {
			const id = (block as { id?: unknown }).id;
			if (typeof id === "string" && id.length > 0) {
				if (protectedToolCallIds.has(id)) {
					kept.push(block);
				} else {
					droppedToolCallIds.add(id);
				}
			} else {
				// `toolCall` block without an `id` is unidentifiable;
				// drop it (no pair to associate) and skip without
				// pushing a synthetic id into `droppedToolCallIds`
				// (an empty/non-string id is not a usable key).
			}
			continue;
		}
		// Non-`toolCall` blocks (text, thinking, …) are dropped
		// along with the rest of the turn's content. The block-
		// level carve-out keeps ONLY protected `toolCall` blocks.
	}
	if (kept.length === 0) return null;
	return { ...msg, content: kept };
}

// ─── Recency-floor helper (recency channel) ─────────────────────

/**
 * Walk backward from the end of the messages array, SKIPPING
 * already-protected messages (dispatch via `userTurnAge === 0`,
 * pinned `customType` in `protectedCustomTypes`, or preserved-path
 * matches), accumulating trimmable tokens until the
 * `recencyFloorTokens` threshold is reached. Returns the set of
 * TRIMMABLE-message indices in `[stopIndex, end)`.
 *
 * The recency slice is the "most-recent-N-tokens of trimmable
 * content" the operator asked to protect. The slice is computed
 * once at the top of `applyThreeTierTrim` and threaded through
 * every internal call as an additive OR with the existing
 * protected-slot checks. Already-protected messages are
 * **excluded** from the recency slice — they are already
 * subtracted from the budget by their own channels, so including
 * them here would double-subtract.
 *
 * `recencyFloorTokens <= 0` or `undefined` → empty set (no recency
 * protection, legacy behavior).
 *
 * Pure: no `process.*`, no `node:fs`. Operates on the messages
 * array and the predicate arguments; all input data is the
 * caller's responsibility to thread through.
 */
export function computeRecencyProtectedIndices(
	messages: ReadonlyArray<TrimmableMessage>,
	recencyFloorTokens: number | undefined,
	protectedCustomTypes: ReadonlySet<string> = new Set(),
	protectDispatch = true,
	preservedPatterns: ReadonlyArray<string> = [],
	protectedToolCallIds: ReadonlySet<string> = new Set(),
	divisor: number = TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
): ReadonlySet<number> {
	const out = new Set<number>();
	if (recencyFloorTokens === undefined || recencyFloorTokens <= 0) return out;
	let acc = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, new Set(), protectedToolCallIds)) continue;
		const tokens = approximateMessageTokens(messages[i], divisor);
		out.add(i);
		acc += tokens;
		if (acc >= recencyFloorTokens) break;
	}
	return out;
}

// ─── Protected-slot predicate ──────────────────────────────────────────

export function isProtectedSlot(
	msg: TrimmableMessage,
	index: number,
	messages: ReadonlyArray<TrimmableMessage>,
	protectedCustomTypes: ReadonlySet<string> = new Set(),
	protectDispatch = true,
	preservedPatterns: ReadonlyArray<string> = [],
	recencyProtectedIndices: ReadonlySet<number> = new Set(),
	protectedToolCallIds: ReadonlySet<string> = new Set(),
): boolean {
	// Agent-def / pinned-tier synthetic.
	if (msg.role === "custom" && msg.customType && protectedCustomTypes.has(msg.customType)) {
		return true;
	}
	// Preserved-path slot: the message's stamped source path matches a
	// preserved pattern. Independent of the dispatch / customType
	// channels above — the OR is additive, the existing checks stay
	// first so their semantics are unchanged.
	if (isPathPreserved(extractSourcePath(msg), preservedPatterns)) {
		return true;
	}
	// Recency-floor slot: a trimmable message in the most-recent
	// recency window whose drop or summarize would violate the
	// operator's recency floor. Independent of the three channels
	// above; the OR is additive.
	if (recencyProtectedIndices.has(index)) {
		return true;
	}
	// Pair-atomic toolCall/toolResult protection: a `toolResult`
	// whose top-level `toolCallId` is in the protected-toolCall-id
	// set is protected by association with the assistant `toolCall`
	// block that requested it. The protected set is computed by the
	// wiring layer from the `toolCall` block's `arguments.path`
	// matching `preservedPatterns`; the result-side `details.sourcePath`
	// is the resume-compat fallback. The set is the source of truth
	// for which `toolResult` messages are protected, and it keeps
	// the message-level carve-out working for the dropped-turn and
	// recency paths. Independent of the channels above; the OR is
	// additive. Note: an ASSISTANT message whose `toolCall` block is
	// protected does NOT return true here — block-level protection
	// is the load-bearing seam, not message-level protection; the
	// assistant turn stays a summarize/drop candidate and the
	// protected `toolCall` block survives inside the rewrite.
	if (msg.role === "toolResult") {
		const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
		if (typeof toolCallId === "string" && toolCallId.length > 0 && protectedToolCallIds.has(toolCallId)) {
			return true;
		}
	}
	// Dispatch task: the first user message. Only applies when dispatch
	// protection is enabled (i.e. pi-subagents is installed).
	if (msg.role !== "user") return false;
	if (!protectDispatch) return false;
	if (typeof msg.userTurnAge === "number" && msg.userTurnAge === 0) return true;
	// Fallback for pre-stamp sessions: first user message by position.
	if (typeof msg.userTurnAge !== "number") {
		for (let i = 0; i < index; i++) {
			if (messages[i].role === "user") return false;
		}
		return true;
	}
	return false;
}

// ─── Total-token computation (budget-respecting) ───────────────────────

/**
 * Sum the per-message tokens, SUBTRACTING the protected-slot tokens
 * from the total so the budget measures only the trimmable mass. The
 * spec requires this subtraction so a session whose only over-budget
 * contributor is the dispatch task or the agent-def / pinned-tier
 * synthetic does not trigger a trim.
 */
export function totalTrimmableTokens(
	messages: ReadonlyArray<TrimmableMessage>,
	protectedCustomTypes: ReadonlySet<string> = new Set(),
	protectDispatch = true,
	preservedPatterns: ReadonlyArray<string> = [],
	recencyProtectedIndices: ReadonlySet<number> = new Set(),
	protectedToolCallIds: ReadonlySet<string> = new Set(),
	divisor: number = TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
): number {
	let total = 0;
	for (let i = 0; i < messages.length; i++) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, protectedToolCallIds)) continue;
		total += approximateMessageTokens(messages[i], divisor);
	}
	return total;
}

// ─── The three-tier trim ───────────────────────────────────────────────

/**
 * Apply the three-tier trim to a conversation message stream. Pure:
 * the input is not mutated; the return is a fresh array. Union-equals-
 * input invariant: every input message is either in the output
 * (verbatim or protected) or in a dropped turn (in which case the
 * entire turn — user + assistant + tool + custom — is removed).
 *
 * The algorithm:
 *   1. Compute `totalTrimmableTokens` (subtracting protected slots).
 *   2. Tier selection:
 *      - total ≤ verbatimMaxTokens           → return messages as-is.
 *      - verbatimMaxTokens < total ≤ summarizeMaxTokens
 *                                            → return messages as-is
 *                                              (transient hold-untouched
 *                                              behavior; Tier 3 catches
 *                                              oversize if it grows
 *                                              further).
 *      - total > summarizeMaxTokens          → hard-drop oldest whole
 *                                              turns until total ≤
 *                                              summarizeMaxTokens.
 *
 * The summarize path was removed. Tier 2 is a transient hold-untouched
 * seam; Tier 3 catches oversize on the next context event if the
 * middle-band mass grows further.
 */
export async function applyThreeTierTrim(
	messages: ReadonlyArray<TrimmableMessage>,
	options: TrimOptions = {},
): Promise<TrimResult> {
	const verbatimMax = options.verbatimMaxTokens ?? VERBATIM_TIER_MAX_TOKENS;
	const summarizeMax = options.summarizeMaxTokens ?? SUMMARIZE_TIER_MAX_TOKENS;
	const protectedCustomTypes = options.protectedCustomTypes ?? new Set<string>();
	const protectDispatch = options.protectDispatch ?? true;
	const preservedPatterns = options.preservedPatterns ?? [];
	const dropFloorTokens = options.dropFloorTokens;
	const recencyFloor = options.recencyFloor;
	const protectedToolCallIds = options.protectedToolCallIds ?? new Set<string>();
	const divisor = options.tokenEstimatorDivisor ?? TOKEN_ESTIMATOR_DIVISOR_DEFAULT;
	const systemPromptTokens = options.systemPromptTokens ?? 0;

	// Compute the recency-protected slice once and thread it through
	// every internal call.
	const recencyProtectedIndices = computeRecencyProtectedIndices(
		messages,
		recencyFloor,
		protectedCustomTypes,
		protectDispatch,
		preservedPatterns,
		protectedToolCallIds,
		divisor,
	);

	// Compute the protected-slot mass once.
	let protectedMass = 0;
	for (let i = 0; i < messages.length; i++) {
		if (
			isProtectedSlot(
				messages[i],
				i,
				messages,
				protectedCustomTypes,
				protectDispatch,
				preservedPatterns,
				recencyProtectedIndices,
				protectedToolCallIds,
			)
		) {
			protectedMass += approximateMessageTokens(messages[i], divisor);
		}
	}

	// Effective caps: the raw tier caps minus the protected mass
	// and the system-prompt term.
	const effectiveVerbatimMax = Math.max(0, verbatimMax - systemPromptTokens - protectedMass);
	const effectiveSummarizeMax = Math.max(0, summarizeMax - systemPromptTokens - protectedMass);

	// First, decide the tier based on the trimmable total.
	const total = totalTrimmableTokens(
		messages,
		protectedCustomTypes,
		protectDispatch,
		preservedPatterns,
		recencyProtectedIndices,
		protectedToolCallIds,
		divisor,
	);

	// Tier 3: hard-drop oldest whole turns until total ≤
	// effectiveSummarizeMax.
	if (total > effectiveSummarizeMax) {
		const { messages: dropped, droppedTurns, shouldFallThrough } = dropOldestTurns(
			messages,
			effectiveSummarizeMax,
			protectedCustomTypes,
			protectDispatch,
			preservedPatterns,
			dropFloorTokens,
			recencyProtectedIndices,
			protectedToolCallIds,
			divisor,
		);
		// Drop-floor fall-through: when the next-oldest turn would
		// push the trimmable total below `dropFloorTokens`, stop
		// dropping and return the surviving messages as-is (Tier 2
		// hold-untouched behavior). The summarize path was removed;
		// this is the transient hold-untouched seam.
		if (shouldFallThrough) {
			return {
				messages: dropped,
				droppedTurns,
				totalTokens: totalTrimmableTokens(
					dropped,
					protectedCustomTypes,
					protectDispatch,
					preservedPatterns,
					recencyProtectedIndices,
					protectedToolCallIds,
					divisor,
				),
			};
		}
		// Re-check; we may have overshot (no trimmable turns left).
		const postDropTotal = totalTrimmableTokens(
			dropped,
			protectedCustomTypes,
			protectDispatch,
			preservedPatterns,
			recencyProtectedIndices,
			protectedToolCallIds,
			divisor,
		);
		// If still over effectiveSummarizeMax (a single trimmable
		// turn is larger than the tier ceiling), return the dropped
		// messages as-is. The summarize fallback was removed; Tier 3
		// catches oversize on the next context event if it grows further.
		return {
			messages: dropped,
			droppedTurns,
			totalTokens: postDropTotal,
		};
	}

	// Tier 2: hold middle-band messages untouched (transient behavior;
	// Tier 3 catches oversize if it grows further).
	if (total > effectiveVerbatimMax) {
		return {
			messages: messages.slice(),
			droppedTurns: 0,
			totalTokens: total,
		};
	}

	// Tier 1: verbatim.
	return {
		messages: messages.slice(),
		droppedTurns: 0,
		totalTokens: total,
	};
}

// ─── Internal: turn boundaries and dropping ────────────────────────────

/**
 * Hard-drop the oldest whole trimmable turns until the trimmable
 * total is ≤ `cap`. A "trimmable turn" is the contiguous block of
 * non-protected messages between two consecutive user messages
 * (exclusive of the dispatch task and any protected custom slots).
 *
 * Dropping is whole-turn and oldest-first: the entire oldest
 * trimmable turn is removed, then the next oldest, and so on, until
 * the trimmable total is under the cap. The dispatch task (first
 * user message, `userTurnAge === 0`) and any pinned-tier / agent-def
 * synthetic (`customType` in `protectedCustomTypes`) are preserved.
 */
function dropOldestTurns(
	messages: ReadonlyArray<TrimmableMessage>,
	cap: number,
	protectedCustomTypes: ReadonlySet<string>,
	protectDispatch: boolean,
	preservedPatterns: ReadonlyArray<string>,
	dropFloorTokens: number | undefined = undefined,
	recencyProtectedIndices: ReadonlySet<number> = new Set(),
	protectedToolCallIds: ReadonlySet<string> = new Set(),
	divisor: number = TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
): { messages: TrimmableMessage[]; droppedTurns: number; shouldFallThrough: boolean; droppedToolCallIds: Set<string> } {
	// First pass: identify the trimmable turns and their token mass.
	// A trimmable turn starts immediately after a non-dispatch user
	// message and runs to either the next non-dispatch user message
	// (exclusive) or to a protected custom slot, whichever comes
	// first. When dispatch protection is OFF, every user message is a
	// turn anchor (there is no special dispatch slot); when ON, the
	// dispatch (userTurnAge === 0) is NOT a trimmable turn anchor.
	//
	// The post-dispatch tail (everything after the dispatch, when
	// there is no follow-up user message yet) is also a trimmable
	// turn: in real sessions the LLM is often mid-response (no
	// follow-up user message has arrived) when the context handler
	// runs, and a huge tool result tail with no follow-up user
	// message is exactly the case the drop tier exists to handle.
	type Turn = { start: number; end: number; tokens: number };
	const turns: Turn[] = [];
	let turnStart = -1;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const isTurnAnchor = msg.role === "user" && (protectDispatch ? msg.userTurnAge !== 0 : true);
		if (isTurnAnchor) {
			// Close any open trimmable turn at the previous boundary.
			if (turnStart !== -1) {
				turns.push(makeTurn(messages, turnStart, i, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, protectedToolCallIds, divisor));
			}
			turnStart = i + 1; // The trimmable turn starts AFTER this user message.
		} else if (msg.role === "custom" && msg.customType && protectedCustomTypes.has(msg.customType)) {
			// A protected custom slot closes any open trimmable turn.
			if (turnStart !== -1) {
				turns.push(makeTurn(messages, turnStart, i, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, protectedToolCallIds, divisor));
				turnStart = -1;
			}
		}
	}
	// Close the final open turn (if any).
	if (turnStart !== -1) {
		turns.push(makeTurn(messages, turnStart, messages.length, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, protectedToolCallIds, divisor));
	}
	// If no trimmable turn was identified but there is post-dispatch
	// trimmable mass (the "mid-response tool result tail" case),
	// synthesize a trimmable turn spanning the post-dispatch tail.
	// This handles sessions where no follow-up user message has
	// arrived yet — a real and common shape when the context
	// handler runs mid-LLM-response. Only applies when dispatch
	// protection is ON (the tail is "post-dispatch"); with protection
	// OFF, any user message already anchored a turn above.
	//
	// Exception: a SINGLE trimmable message is left untouched
	// (dropping the only trimmable content would leave the session
	// empty). 2+ trimmable messages are bundled
	// into a synthetic trimmable turn and dropped whole.
	if (turns.length === 0 && protectDispatch) {
		// Find the dispatch (first user message with userTurnAge === 0).
		let dispatchIdx = -1;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "user" && messages[i].userTurnAge === 0) {
				dispatchIdx = i;
				break;
			}
		}
		const tailStart = dispatchIdx === -1 ? 0 : dispatchIdx + 1;
		// Count trimmable messages in the post-dispatch tail.
		let trimmableCount = 0;
		for (let i = tailStart; i < messages.length; i++) {
			if (!isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, protectedToolCallIds)) trimmableCount++;
		}
		if (trimmableCount >= 2 && tailStart < messages.length) {
			turns.push(makeTurn(messages, tailStart, messages.length, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, protectedToolCallIds, divisor));
		}
	}
	// Compute the total trimmable token mass of the input.
	const totalMass = turns.reduce((s, t) => s + t.tokens, 0);
	// Drop oldest turns until the remaining mass is ≤ cap.
	// Drop-floor guard: when `dropFloorTokens` is set, stop one
	// step before the next-oldest turn would push the remaining
	// trimmable mass below the floor. The caller (applyThreeTierTrim)
	// then returns the surviving messages as-is (the summarize path
	// was removed; this is the transient hold-untouched seam).
	let remaining = totalMass;
	const dropSet = new Set<number>();
	let shouldFallThrough = false;
	for (const t of turns) {
		if (remaining <= cap) break;
		if (dropFloorTokens !== undefined && remaining - t.tokens < dropFloorTokens) {
			shouldFallThrough = true;
			break;
		}
		dropSet.add(t.start); // Marker: this turn's start index is dropped.
		remaining -= t.tokens;
	}
	// Build the output: every message NOT inside a dropped turn, PLUS
	// any message inside a dropped turn that is itself a protected
	// slot (per `isProtectedSlot`). A protected message is never
	// dropped even when it sits inside a dropped turn's [start, end)
	// slice — the existing predicate (dispatch / pinned customType /
	// preserved-paths) carves the protected message out of the
	// dropped slice so it survives. Without this carve-out, a
	// preserved-path message that lands inside the oldest trimmable
	// turn would be dropped with the rest of the turn, violating
	// AC-6 (b) (a preserved message must survive tier-3 drop).
	//
	// Aggregate prune reminder: when any turns are dropped
	// (`dropSet.size > 0`), one plain-English reminder message is
	// prepended to the output. The reminder is a real entry in the
	// returned `result.messages` array — a `role: "user"` piece of
	// model-facing text that names the extension, the action, the
	// scope, and a conditional "get it fresh" retrieval hint. The
	// reminder is emitted ONCE per drop event (not per dropped turn)
	// so a multi-turn drop is one model-facing note, not a sequence
	// of per-turn envelopes. The reminder carries no bracket tag, no
	// ordinals, no token mass. The "get it fresh" clause is
	// conditional ("if you need …"), not a directive.
	const out: TrimmableMessage[] = [];
	if (dropSet.size > 0) {
		out.push({ role: "user", content: PRUNE_REMINDER_TEXT });
	}
	// Pair-atomic: when an assistant message sits inside a dropped
	// turn, walk its `toolCall` blocks. Protected `toolCall` blocks
	// (those whose `id` is in `protectedToolCallIds`) are retained
	// inside the rewritten message — the message is NOT dropped
	// wholesale, it is rewritten via `carveProtectedToolCallBlocks`
	// to carry only the protected `toolCall` blocks. Unprotected
	// `toolCall` blocks are dropped; their IDs are collected in
	// `droppedToolCallIds` so the matching `toolResult` messages
	// (which may sit in a later turn) are also dropped — the pair
	// is atomic in both directions.
	const droppedToolCallIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		// If this message is inside a dropped turn, skip it UNLESS
		// the message is itself a protected slot. A turn is dropped
		// iff its start index is in dropSet.
		let inDroppedTurn = false;
		for (const t of turns) {
			if (dropSet.has(t.start) && i >= t.start && i < t.end) {
				inDroppedTurn = true;
				break;
			}
		}
		if (inDroppedTurn) {
			// Pair-atomic carve-out: an assistant message inside a
			// dropped turn is rewritten to keep only its protected
			// `toolCall` blocks. If the assistant has no protected
			// `toolCall` blocks (and the message is not itself a
			// protected slot), the message is dropped — and any
			// unprotected `toolCall` block IDs it carried are
			// added to `droppedToolCallIds` for the post-pass
			// toolResult drop.
			if (isProtectedSlot(msg, i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, protectedToolCallIds)) {
				out.push(msg);
				continue;
			}
			if (msg.role === "assistant") {
				const kept = carveProtectedToolCallBlocks(msg, protectedToolCallIds, droppedToolCallIds);
				if (kept !== null) {
					out.push(kept);
				}
				continue;
			}
			// Non-assistant, non-protected, inside a dropped turn:
			// dropped with the turn. This includes `toolResult`
			// messages whose `toolCallId` is in `protectedToolCallIds`
			// are NOT in this branch — the protected check above
			// caught them. Unprotected `toolResult` messages inside
			// a dropped turn are dropped alongside (their matching
			// `toolCall` block was in the same dropped turn or
			// already collected via the assistant carve-out pass).
			continue;
		}
		// Outside a dropped turn: pair-atomic toolResult drop for
		// unprotected `toolCall` blocks that were dropped from a
		// dropped turn earlier in the array. The matching
		// `toolResult` here is dropped alongside (no orphan).
		if (msg.role === "toolResult") {
			const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
			if (
				typeof toolCallId === "string" &&
				toolCallId.length > 0 &&
				droppedToolCallIds.has(toolCallId)
			) {
				continue;
			}
		}
		out.push(msg);
	}
	return { messages: out, droppedTurns: dropSet.size, shouldFallThrough, droppedToolCallIds };
}

/**
 * Build a `Turn` record: the slice [start, end) and its trimmable
 * token mass (sum of non-protected message tokens in the slice).
 */
function makeTurn(
	messages: ReadonlyArray<TrimmableMessage>,
	start: number,
	end: number,
	protectedCustomTypes: ReadonlySet<string>,
	protectDispatch: boolean,
	preservedPatterns: ReadonlyArray<string>,
	recencyProtectedIndices: ReadonlySet<number> = new Set(),
	protectedToolCallIds: ReadonlySet<string> = new Set(),
	divisor: number = TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
): { start: number; end: number; tokens: number } {
	let tokens = 0;
	for (let i = start; i < end; i++) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, protectedToolCallIds)) continue;
		tokens += approximateMessageTokens(messages[i], divisor);
	}
	return { start, end, tokens };
}

// ─── Reasoning-block cap (count-based reasoning trim) ─────────────
//
// A count-based cap on `type: "thinking"` content blocks. The cap
// keeps the LAST N reasoning blocks across the message stream
// (latest message first; within each message, content blocks
// scanned in reverse), and drops the rest by removing the
// thinking blocks from their parent messages. Non-thinking content
// blocks in the same message are preserved. The unit is a count
// of blocks, not a measurement of tokens.
//
// Block shape (verified at `index.ts:680`):
//   { type: "thinking"; thinking: string }
//
// Cap semantics:
//   cap === -1  → passthrough, return the input unchanged
//   cap ===  0  → drop every thinking block from every message
//   cap  >  0   → keep the last `cap` thinking blocks, drop the rest
//
// Pure: no `process.*`, no Node I/O. Operates only on the message
// array. Used by the wiring layer (Unit 3) at the context handler
// before `applyThreeTierTrim` so the three-tier budget sees the
// post-cap message mass.

/**
 * Compile-time default for the reasoning-block count cap. The
 * wiring layer reads this when neither the env var nor the JSON
 * key (Unit 2) sets a value. `-1` is the passthrough sentinel —
 * "send every reasoning block through" — so existing operators
 * see no behavior change when upgrading. To opt in to the cap,
 * set the env var or JSON key to `0` (send none) or a positive
 * integer (keep the last N).
 */
export const REASONING_BLOCK_CAP_DEFAULT = -1;

/**
 * Pure extractor: concatenate the `thinking` strings from every
 * `type: "thinking"` content block on a single message. Order
 * follows the block order in the message. Non-thinking blocks
 * (text, toolCall, toolResult, …) are skipped. Non-array content
 * (string, object) yields `""`. Returns `""` for an empty array.
 *
 * Used by the wiring layer to surface the full reasoning text of
 * a message for inspection, log, or display; the count cap itself
 * only needs the block identities, not the text.
 */
export function extractReasoningText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "thinking" &&
			typeof (block as { thinking?: unknown }).thinking === "string"
		) {
			out += (block as { thinking: string }).thinking;
		}
	}
	return out;
}

/**
 * Pure predicate: does this message contain at least one
 * `type: "thinking"` content block? Used to short-circuit the cap
 * pass when a message stream has no reasoning blocks at all (the
 * common case in non-reasoning sessions).
 */
export function hasReasoning(msg: TrimmableMessage): boolean {
	const content = msg.content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
			return true;
		}
	}
	return false;
}

/**
 * Count the total number of `type: "thinking"` content blocks
 * across the message stream. Walks every message in order; per
 * message, walks every content block. Used to surface the
 * reasoning-block count to the wiring layer for diagnostics and
 * to gate the cap pass (if the total is ≤ the cap, no work is
 * needed).
 */
export function countReasoningBlocks(messages: ReadonlyArray<TrimmableMessage>): number {
	let n = 0;
	for (const msg of messages) {
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
				n += 1;
			}
		}
	}
	return n;
}

/**
 * Apply the reasoning-block count cap. The cap is a count of
 * reasoning blocks (NOT tokens) to keep, measured from the
 * LATEST end of the stream. The transform:
 *
 *   1. Walks the message stream in REVERSE (latest message first).
 *   2. For each message, walks the content blocks in REVERSE.
 *   3. Collects every `type: "thinking"` block encountered, in
 *      "latest-first" order.
 *   4. Keeps the first `cap` collected (the latest `cap` thinking
 *      blocks across the whole stream) and drops the rest by
 *      REMOVING the thinking block from its parent message
 *      (non-thinking content blocks in the same message are
 *      preserved verbatim).
 *   5. Returns a fresh messages array; the input is not mutated.
 *
 * Cap semantics:
 *   cap === -1  → return the input unchanged (passthrough).
 *   cap ===  0  → drop every thinking block from every message.
 *   cap  >  0   → keep the last `cap` thinking blocks, drop the rest.
 *
 * Edge cases:
 *   - Messages with non-array content (string, object) have no
 *     thinking blocks and pass through untouched.
 *   - Messages with array content but no thinking blocks have
 *     their content array preserved verbatim.
 *   - When a message has its content array rewritten (some
 *     thinking blocks dropped, others kept), the rewrite is a
 *     fresh array — the input message is not mutated.
 *   - Messages whose content array becomes empty after dropping
 *     thinking blocks are rewritten with `content: []` (NOT
 *     removed) so the message order and the wiring layer's
 *     downstream consumers see a stable index space.
 *
 * Pure: no I/O, no `process.*`. Operates only on the message
 * array shape. Called by the wiring layer (Unit 3) at the
 * context handler before `applyThreeTierTrim`.
 */
export function applyReasoningBlockCap(
	messages: ReadonlyArray<TrimmableMessage>,
	cap: number,
): TrimmableMessage[] {
	if (cap === -1) return messages.slice();
	const out: TrimmableMessage[] = new Array(messages.length);
	for (let i = 0; i < messages.length; i++) {
		out[i] = messages[i];
	}
	if (cap === 0) {
		// Drop every thinking block from every message.
		for (let i = 0; i < out.length; i++) {
			const msg = out[i];
			const content = msg.content;
			if (!Array.isArray(content)) continue;
			const filtered = content.filter(
				(block) => !(block && typeof block === "object" && (block as { type?: unknown }).type === "thinking"),
			);
			if (filtered.length !== content.length) {
				out[i] = { ...msg, content: filtered };
			}
		}
		return out;
	}
	// cap > 0: walk in reverse, keep the first `cap` thinking blocks
	// (the latest ones), drop the rest. We do this in a single
	// reverse pass that records which (messageIndex, blockIndex)
	// pairs to KEEP; everything else in the thinking-block set is
	// dropped.
	const keepSet = new Set<string>();
	let seen = 0;
	for (let mi = out.length - 1; mi >= 0 && seen < cap; mi--) {
		const msg = out[mi];
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (let bi = content.length - 1; bi >= 0 && seen < cap; bi--) {
			const block = content[bi];
			if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
				keepSet.add(`${mi}:${bi}`);
				seen += 1;
			}
		}
	}
	if (seen === 0) return out;
	// Apply the keep set: every thinking block NOT in the keep set
	// is dropped. Non-thinking blocks are always preserved.
	let touchedAny = false;
	for (let mi = 0; mi < out.length; mi++) {
		const msg = out[mi];
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		let touched = false;
		const filtered: unknown[] = [];
		for (let bi = 0; bi < content.length; bi++) {
			const block = content[bi];
			const isThinking =
				block && typeof block === "object" && (block as { type?: unknown }).type === "thinking";
			if (isThinking && !keepSet.has(`${mi}:${bi}`)) {
				touched = true;
				continue;
			}
			filtered.push(content[bi]);
		}
		if (touched) {
			out[mi] = { ...msg, content: filtered };
			touchedAny = true;
		}
	}
	if (!touchedAny) return out;
	return out;
}

// ─── Pre-budget collapse (extension-gated category trims) ─────────
//
// Three pure array-in/array-out transforms that collapse transcript
// entries — `intercom_message`, `subagent-notify`, and
// `toolResult:subagent` — that accumulate outside the three-tier
// budget. Each function targets a single category and is tier-blind
// (drops regardless of which three-tier budget slot the entry would
// have occupied). The wiring layer (`index.ts`) invokes them on
// `base` after source-path stamping and before pinned injection,
// and gates each by an extension-presence probe (pi-intercom,
// pi-subagents) so a session without the gating extension sees no
// behavior change.
//
// Identification predicates match the source extensions:
//   - `intercom_message`:  role === "custom" && customType === "intercom_message" (pi-intercom)
//   - `subagent-notify`:   role === "custom" && customType === "subagent-notify"  (pi-intercom)
//   - `toolResult:subagent`: role === "toolResult" && toolName === "subagent"     (pi-subagents)
//
// Purity: each function is a pure array transform — no `process.*`,
// no Node I/O, no `pi` reference. Mirrors the `applyReasoningBlockCap`
// purity contract. The wiring layer is responsible for the gate
// (extension-presence probe) and the integer coercion of the
// `keepLast` knob.

/**
 * Pure recency hardtrim for `intercom_message` custom entries. Drops
 * every `intercom_message` entry except the last `keepLast` (by
 * stream order). Cap semantics:
 *
 *   keepLast === -1  → return the input unchanged (passthrough).
 *   keepLast ===  0  → drop every `intercom_message` entry.
 *   keepLast  >  0   → keep the last `keepLast` `intercom_message`
 *                       entries by stream order, drop the rest.
 *
 * Identification: `role === "custom" && customType === "intercom_message"`.
 * Non-`intercom_message` entries (user / assistant / toolResult /
 * other custom types) are preserved untouched. The function does NOT
 * mutate the input array; it returns a fresh `TrimmableMessage[]`.
 */
export function applyIntercomKeepLast(
	messages: ReadonlyArray<TrimmableMessage>,
	keepLast: number,
): TrimmableMessage[] {
	if (keepLast === -1) return messages.slice();
	const total = messages.length;
	const indices: number[] = [];
	for (let i = 0; i < total; i++) {
		const m = messages[i];
		if (m.role === "custom" && m.customType === "intercom_message") {
			indices.push(i);
		}
	}
	if (indices.length === 0) return messages.slice();
	if (keepLast === 0) {
		const dropSet = new Set(indices);
		const out: TrimmableMessage[] = new Array(total - indices.length);
		let j = 0;
		for (let i = 0; i < total; i++) {
			if (!dropSet.has(i)) out[j++] = messages[i];
		}
		return out;
	}
	if (keepLast >= indices.length) return messages.slice();
	const dropCount = indices.length - keepLast;
	const dropSet = new Set<number>();
	for (let i = 0; i < dropCount; i++) dropSet.add(indices[i]);
	const out: TrimmableMessage[] = new Array(total - dropCount);
	let j = 0;
	for (let i = 0; i < total; i++) {
		if (!dropSet.has(i)) out[j++] = messages[i];
	}
	return out;
}

/**
 * Pure recency hardtrim for `subagent-notify` custom entries. Keeps
 * the last N `subagent-notify` entries by stream order and drops the
 * rest. Identification: `role === "custom" && customType === "subagent-notify"`.
 * Non-`subagent-notify` entries are preserved untouched. Cap semantics
 * mirror `applyIntercomKeepLast`:
 *   keepLast === -1  → passthrough (returns a shallow copy).
 *   keepLast ===  0  → drop every `subagent-notify` entry.
 *   keepLast  >  0   → keep the last `keepLast` entries.
 * Pure: no I/O, no `process.*`; the wiring layer coerces floats with
 * `Math.trunc` and gates by the
 * `resolveIntercomInstalled` extension probe.
 */
export function applySubagentNotifyKeepLast(
	messages: ReadonlyArray<TrimmableMessage>,
	keepLast: number,
): TrimmableMessage[] {
	if (keepLast === -1) return messages.slice();
	const total = messages.length;
	const indices: number[] = [];
	for (let i = 0; i < total; i++) {
		const m = messages[i];
		if (m.role === "custom" && m.customType === "subagent-notify") {
			indices.push(i);
		}
	}
	if (indices.length === 0) return messages.slice();
	if (keepLast === 0) {
		const dropSet = new Set(indices);
		const out: TrimmableMessage[] = new Array(total - indices.length);
		let j = 0;
		for (let i = 0; i < total; i++) {
			if (!dropSet.has(i)) out[j++] = messages[i];
		}
		return out;
	}
	if (keepLast >= indices.length) return messages.slice();
	const dropCount = indices.length - keepLast;
	const dropSet = new Set<number>();
	for (let i = 0; i < dropCount; i++) dropSet.add(indices[i]);
	const out: TrimmableMessage[] = new Array(total - dropCount);
	let j = 0;
	for (let i = 0; i < total; i++) {
		if (!dropSet.has(i)) out[j++] = messages[i];
	}
	return out;
}

/**
 * Run-identity key for `subagent-notify` entries. The stable
 * identifier that distinguishes one delivery from a redelivery of
 * the same run.
 *
 * Priority chain (first match wins):
 *   1. `details.sessionValue` — fast-path override when the producer
 *      attaches a per-run-stable session file / share URL.
 *   2. `details` fingerprint — deterministic hash of the `details`
 *      payload (agent / status / resultPreview / taskInfo), for
 *      callers that attach `details` without `sessionValue`.
 *   3. Content-header parse — extracts the agent name from the
 *      formatted content header (the `**agent**` segment), matching
 *      the production wire shape from `sendCompletion` which carries
 *      no `details` field.
 *   4. `__idx__:<index>` — last-resort fallback; every entry is
 *      treated as a distinct run (dedup is a no-op for that entry).
 */
function subagentNotifyRunId(msg: TrimmableMessage, index: number): string {
	const details = msg.details as Record<string, unknown> | undefined;
	if (details && typeof details === "object") {
		const sessionValue = details.sessionValue;
		if (typeof sessionValue === "string" && sessionValue.length > 0) {
			return `sessionValue:${sessionValue}`;
		}
		const fpParts: string[] = [];
		const fields = ["agent", "status", "resultPreview", "taskInfo"] as const;
		for (const f of fields) {
			const v = details[f];
			if (v === undefined || v === null) continue;
			try {
				fpParts.push(`${f}=${JSON.stringify(v)}`);
			} catch {
				fpParts.push(`${f}=<unserializable>`);
			}
		}
		if (fpParts.length > 0) {
			return `fingerprint:${fpParts.join("|")}`;
		}
	}
	// Content-header parse: extract the agent name from the formatted
	// content header (the `**agent**` segment). This matches the
	// production wire shape from `sendCompletion` which carries no
	// `details` field. The content format is:
	//   "{taskKind} {status}: **{agent}**{taskInfo?}"
	// e.g. "Background task completed: **test-agent**"
	const contentAgent = extractContentAgent(msg.content as string | undefined);
	if (contentAgent !== null) {
		return `content:${contentAgent}`;
	}
	return `__idx__:${index}`;
}

/**
 * Extract the agent name from a `subagent-notify` content header.
 * The content format is `"{taskKind} {status}: **{agent}**{taskInfo?}"`.
 * Returns the agent name (text between the first pair of `**` markers)
 * or `null` when no `**...**` segment is found.
 */
function extractContentAgent(content: string | undefined): string | null {
	if (typeof content !== "string") return null;
	const match = content.match(/\*\*([^*]+)\*\*/);
	return match ? match[1].trim() : null;
}

/**
 * Pure dedup for `subagent-notify` custom entries. Keeps the FIRST
 * occurrence of each run identity in stream order; drops every
 * subsequent duplicate. Identification:
 * `role === "custom" && customType === "subagent-notify"`.
 * Non-`subagent-notify` entries are preserved untouched. No knob —
 * duplicates are always noise.
 *
 * Run identity priority chain:
 *   1. `details.sessionValue` — fast-path override when the producer
 *      attaches a per-run-stable session file / share URL.
 *   2. `details` fingerprint — deterministic hash of the `details`
 *      payload (`agent` + `status` + `resultPreview` + `taskInfo`).
 *   3. Content-header parse — extracts the agent name from the
 *      formatted content header (the `**agent**` segment), matching
 *      the production wire shape from `sendCompletion`.
 *   4. `__idx__:<index>` — last-resort fallback; each entry is
 *      treated as a distinct run (dedup is a no-op for that entry).
 */
export function dedupSubagentNotify(messages: ReadonlyArray<TrimmableMessage>): TrimmableMessage[] {
	const total = messages.length;
	const seen = new Set<string>();
	const keep: boolean[] = new Array(total).fill(true);
	let dropped = 0;
	for (let i = 0; i < total; i++) {
		const m = messages[i];
		if (m.role !== "custom" || m.customType !== "subagent-notify") continue;
		const runId = subagentNotifyRunId(m, i);
		if (seen.has(runId)) {
			keep[i] = false;
			dropped += 1;
		} else {
			seen.add(runId);
		}
	}
	if (dropped === 0) return messages.slice();
	const out: TrimmableMessage[] = new Array(total - dropped);
	let j = 0;
	for (let i = 0; i < total; i++) {
		if (keep[i]) out[j++] = messages[i];
	}
	return out;
}

/**
 * Pure latest-only hard cut for `toolResult:subagent` entries. Drops
 * every `role: "toolResult"` entry whose `toolName === "subagent"`
 * except the LAST one (by stream order). Identification:
 * `role === "toolResult" && toolName === "subagent"`.
 * Non-`subagent` `toolResult` entries are preserved untouched. No
 * knob — prior subagent tool results are not needed once a newer
 * one exists. Tier-blind — drops regardless of three-tier budget slot.
 */
export function keepLatestSubagentToolResult(messages: ReadonlyArray<TrimmableMessage>): TrimmableMessage[] {
	const total = messages.length;
	let lastIdx = -1;
	for (let i = 0; i < total; i++) {
		const m = messages[i];
		if (m.role === "toolResult" && (m as TrimmableMessage & { toolName?: string }).toolName === "subagent") {
			lastIdx = i;
		}
	}
	if (lastIdx < 0) return messages.slice();
	const dropSet = new Set<number>();
	for (let i = 0; i < total; i++) {
		const m = messages[i];
		if (i === lastIdx) continue;
		if (m.role === "toolResult" && (m as TrimmableMessage & { toolName?: string }).toolName === "subagent") {
			dropSet.add(i);
		}
	}
	if (dropSet.size === 0) return messages.slice();
	const out: TrimmableMessage[] = new Array(total - dropSet.size);
	let j = 0;
	for (let i = 0; i < total; i++) {
		if (!dropSet.has(i)) out[j++] = messages[i];
	}
	return out;
}

// ─── Loop guard (defense-in-depth for model-caused loops) ──────────
//
// Detects repeated identical tool-call sequences in the assistant
// turn stream. The detection layer is pure (no `process.*`, no
// `node:fs`); the wiring layer (Unit 3) is what actually decides
// whether to nudge, hard-block, or fall through. The constants
// below are the model-facing strings injected on nudge / hard-block;
// the predicates are the decision rules.
//
// Scope: behavioral loops (identical tool-call sequences with
// deterministic key order). Reasoning-only loops are out of scope —
// a no-tool-call assistant turn yields a distinct fingerprint, so
// the run resets naturally without a special case.

/**
 * Tolerance for the flat-input-token co-signal (AC-4). The last-N
 * assistant-turn input-token counts are considered "flat" iff the
 * spread between the largest and smallest sample is within this
 * fraction of the smallest. A pure default constant; the wiring
 * layer may override per-call.
 */
export const FLAT_INPUT_TOKEN_TOLERANCE = 0.05;

/**
 * Plain-English nudge the wiring layer injects as a `role: "user"`
 * synthetic when the model has issued the same tool call several
 * times in a row. The nudge names (a) the repetition, (b) the fact
 * the prior results are already in context, and (c) the option to
 * proceed to the next step. The phrasing is non-directive — no
 * "you must" — so the model treats it as a status note, not a
 * command.
 */
export const LOOP_GUARD_NUDGE_TEXT =
	"You've called the same tool with the same arguments several times in a row, and the results of the earlier calls are already in the conversation above. " +
	"If those results answer the question, use them; otherwise, try a different approach.";

/**
 * Plain-English hard-block notice the wiring layer injects as a
 * `role: "user"` synthetic when the model has crossed the
 * hard-block threshold. The notice states the repeated tool call
 * was blocked and that the model must proceed via text (the
 * hard-block case). Model-facing; non-directive tone.
 */
export const LOOP_GUARD_BLOCK_TEXT =
	"The repeated tool call has been blocked because the same call has fired too many times in a row with the same arguments. " +
	"Proceed by reasoning in text — use the results already in context or take a different approach.";

/**
 * Sort an object's keys deterministically for fingerprinting.
 * Pure: no I/O, no mutation of the input. Non-object inputs are
 * returned as-is. Arrays preserve order (the position of each
 * element is part of the call's identity for a tool call); only
 * object keys are sorted, since key order is an artifact of the
 * model's serialization, not the call's semantics.
 */
function sortObjectKeysDeep(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return value.map((v) => sortObjectKeysDeep(v));
	}
	const obj = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj).sort()) {
		out[key] = sortObjectKeysDeep(obj[key]);
	}
	return out;
}

/**
 * Fingerprint a single tool call. Two calls fingerprint identically
 * iff they have the same `name` and equivalent `arguments` under
 * deterministic key ordering. Argument value identity matters;
 * argument key order does not.
 */
export function fingerprintToolCall(toolCall: { name: string; arguments: unknown }): string {
	const normalizedArgs = sortObjectKeysDeep(toolCall.arguments);
	return toolCall.name + "|" + JSON.stringify(normalizedArgs);
}

/**
 * Fingerprint a single assistant turn's tool-call blocks. A turn
 * with no `toolCall` blocks returns a distinct signature so the
 * run resets naturally (reasoning-only turns break a behavioral
 * loop). The fingerprint is the sorted conjunction of every
 * toolCall block's individual fingerprint.
 *
 * Scope boundary (AC-9): only behavioral loops (identical tool-call
 * sequences) are detected. Reasoning-only loops are out of scope.
 */
export function fingerprintAssistantTurn(content: ReadonlyArray<{ type: string; [k: string]: unknown }>): string {
	const toolCalls: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && block.type === "toolCall") {
			const blockObj = block as { type: string; name?: unknown; arguments?: unknown };
			const name = typeof blockObj.name === "string" ? blockObj.name : "";
			const args = "arguments" in block ? blockObj.arguments : undefined;
			toolCalls.push(fingerprintToolCall({ name, arguments: args }));
		}
	}
	if (toolCalls.length === 0) {
		// Distinct signature: reasoning-only turns reset the run.
		return "\0__no_tool_calls__";
	}
	toolCalls.sort();
	return toolCalls.join("\n");
}

/**
 * Detect a run of consecutive identical assistant turns ending at
 * the last assistant turn in `messages`. The run joins when the
 * per-turn fingerprint matches the run's signature; a multi-tool-
 * call turn matches iff the conjunction of all its tool calls
 * matches the run signature. Read-only and idempotent over the
 * stream.
 *
 * Returns the run length and the matched signature, or `null` if
 * no run was detected.
 */
export function detectConsecutiveIdenticalToolCalls(
	messages: ReadonlyArray<TrimmableMessage>,
	threshold: number,
): { runLength: number; lastSignature: string | null } {
	if (threshold <= 0) return { runLength: 0, lastSignature: null };
	let runSignature: string | null = null;
	let runLength = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const content = Array.isArray(msg.content) ? (msg.content as ReadonlyArray<{ type: string; [k: string]: unknown }>) : [];
		const fingerprint = fingerprintAssistantTurn(content);
		if (runSignature === null) {
			runSignature = fingerprint;
			runLength = 1;
			continue;
		}
		if (fingerprint === runSignature) {
			runLength += 1;
			continue;
		}
		break;
	}
	if (runSignature === "\0__no_tool_calls__") {
		// Reasoning-only tail — not a behavioral loop.
		return { runLength: 0, lastSignature: null };
	}
	return { runLength, lastSignature: runSignature };
}

/**
 * Compute the flat-input-token co-signal over the last
 * `window` assistant-turn input-token counts. The signal is
 * "flat" when every sample is within `FLAT_INPUT_TOKEN_TOLERANCE`
 * of the smallest sample. Informational only — the wiring layer
 * decides whether and how to use it. Pure.
 */
export function computeFlatInputTokenSignal(
	messages: ReadonlyArray<TrimmableMessage>,
	window: number = 5,
): { flat: boolean; sampleTokens: number[] } {
	const sampleTokens: number[] = [];
	for (let i = messages.length - 1; i >= 0 && sampleTokens.length < window; i--) {
		if (messages[i].role === "assistant") {
			sampleTokens.push(approximateMessageTokens(messages[i]));
		}
	}
	sampleTokens.reverse();
	if (sampleTokens.length < 2) return { flat: false, sampleTokens };
	const min = Math.min(...sampleTokens);
	if (min === 0) {
		const allZero = sampleTokens.every((n) => n === 0);
		return { flat: allZero, sampleTokens };
	}
	const max = Math.max(...sampleTokens);
	const flat = (max - min) / min <= FLAT_INPUT_TOKEN_TOLERANCE;
	return { flat, sampleTokens };
}

/**
 * Pure hard-block predicate. Returns true iff a hard-block threshold
 * is configured AND the run length meets or exceeds it. The wiring
 * layer is responsible for the `hardBlockThreshold >= loopGuardThreshold`
 * invariant; the predicate does not check it.
 */
export function shouldHardBlock(runLength: number, hardBlockThreshold: number | undefined): boolean {
	if (hardBlockThreshold === undefined) return false;
	return runLength >= hardBlockThreshold;
}
