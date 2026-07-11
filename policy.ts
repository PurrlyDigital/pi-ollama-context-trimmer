// ─── Token-tier trim policy (three-tier amended design) ────────────────
//
// Three tiers, keyed on the total token count of the trimmable messages
// (chars / 4 per message, summed):
//
//   0–50k          → verbatim, no action
//   50k–100k       → in-place summa summarize the OLDEST non-protected
//                    trimmable messages until the total is back under 50k
//   100k+          → hard drop the OLDEST whole turns (user+assistant+
//                    tool+custom together) until the total is back under
//                    100k
//
// Subagent protected inputs (subagent-only, excluded from the 50k/100k
// budget, never summarize, never drop):
//   1. The system prompt (agent def). It travels as a SEPARATE field on
//      the LLM call, NOT in the trimmable `messages` array — so the
//      protection is a no-op for this code path (its tokens are never
//      in the budget). Documented here so the invariant is visible.
//   2. The first user message (dispatch instructions). The first user
//      message carries the dispatch task; removing or summarizing it
//      would lose the subagent's instructions. The message is marked
//      with `userTurnAge === 0` in the stamp; the exemption reads that
//      field. The spec also requires that its tokens be SUBTRACTED from
//      the cap total so the budget measures only the trimmable mass.
//
// The 25-Pi-turn arm gate and the K/M per-Pi-turn digest cadence from
// the prior design are NOT carried forward; the amended spec replaces
// them with the token tiers alone.

import { spawnSync } from "node:child_process";
import * as path from "node:path";

// ─── Constants ─────────────────────────────────────────────────────────

/** Verbatim tier ceiling. Totals at or below this are untouched. */
export const VERBATIM_TIER_MAX_TOKENS = 50_000;

/** Summarize tier ceiling. Totals above this fall into the drop tier. */
export const SUMMARIZE_TIER_MAX_TOKENS = 100_000;

/** Word budget for summa's per-message in-place summary. */
export const SUMMA_WORDS = 60;

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
	 * The summarizer callback. Production wires this to a Python `summa`
	 * subprocess; tests pass a deterministic in-process stub. Receives
	 * the text to summarize and the word budget, returns the summary.
	 */
	summarizer?: (text: string, words: number) => string;
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
	 * Override the word budget for summa summaries (default 60).
	 */
	summaWords?: number;
	/**
	 * The set of `customType` values that mark a message as a protected
	 * slot (e.g. the agent-def / pinned-tier synthetic). Protected
	 * custom-type messages are excluded from the budget, never
	 * summarized, and never dropped. The wiring layer passes the
	 * pinning customType (e.g. `"context-trimmer-pinned"`) here.
	 */
	protectedCustomTypes?: ReadonlySet<string>;
	/**
	 * Whether to protect the first user message as a subagent dispatch
	 * slot (exempting it from summary/drop and subtracting its tokens
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
	 * `isPathPreserved`) is excluded from the budget, never summarized,
	 * and never dropped. The wiring layer passes the operator-resolved
	 * `preservedPaths` (with `~/` already expanded via `os.homedir()`)
	 * here. Defaults to `[]` (no paths preserved) so the predicate
	 * shape is uniform across all internal call sites.
	 */
	preservedPatterns?: ReadonlyArray<string>;
	/**
	 * The lower bound the tier-3 drop must not undershoot by dropping a
	 * whole turn. When set, `dropOldestTurns` stops one step before the
	 * remaining trimmable mass would dip below this floor; the
	 * fall-through hands the surviving trimmable content off to the
	 * summarize path so the drop tier never collapses the protected
	 * floor. `undefined` or non-positive values disable the floor
	 * (legacy behavior: drop until the trimmable total ≤
	 * `summarizeMaxTokens`).
	 */
	dropFloorTokens?: number;
	/**
	 * A token count; the most-recent-N-tokens of trimmable content
	 * protected from drop AND summarize. The recency slice is computed
	 * once at the top of `applyThreeTierTrim` and threaded through
	 * every internal call; messages in the slice are treated as
	 * protected (additive OR with the existing channels) and excluded
	 * from the trimmable budget. `undefined` or non-positive values
	 * disable recency protection (legacy behavior: every trimmable
	 * message is a candidate for summarize or drop).
	 */
	recencyFloor?: number;
	/**
	 * Fingerprints of messages that were summarized in prior context
	 * events. Messages whose fingerprint is in this set are skipped by
	 * `findOldestSummarizable` (not re-summarized), unless the escape
	 * clause fires (total still over verbatim cap and no non-summarized
	 * candidates remain). The wiring layer builds this set from
	 * persisted state (`pi.appendEntry`) and threads it here.
	 */
	alreadySummarizedHashes?: ReadonlySet<string>;
};

/** The return value. A fresh `messages` array (possibly shorter or with summarized text in place). */
export type TrimResult = {
	/** The messages that survive, in original order, with possible content rewrites. */
	messages: TrimmableMessage[];
	/** Diagnostic counters (number of messages summarized, dropped, etc.). */
	summarized: number;
	droppedTurns: number;
	/**
	 * Total tokens of the returned messages (including protected slots;
	 * informational only).
	 */
	totalTokens: number;
	/** Fingerprints of messages summarized in this trim pass. The wiring
	 *  layer persists these via `pi.appendEntry` so the next context
	 *  event can skip them. */
	summarizedFingerprints: string[];
};

// ─── Per-message token accounting (chars / 4) ──────────────────────────

/**
 * Approximate the token count of a single message by summing the text
 * content and dividing by 4. The harness convention (per CLAUDE.md and
 * the documented model-card values) is chars / 4 ≈ tokens. Non-text
 * content blocks are stringified; custom roles fall through to JSON.
 *
 * The function is intentionally permissive on input shape — the
 * message type is structural and content blocks vary by role and
 * provider. The accounting is a lower bound (we undercount multi-modal
 * content), which biases toward trim; that's the safe direction.
 */
export function approximateMessageTokens(msg: TrimmableMessage): number {
	const text = extractText(msg.content);
	return Math.ceil(text.length / 4);
}

/**
 * Extract the text content of a message. Handles the common shapes:
 *   - string content (a plain user/assistant message body)
 *   - array of `{ type: "text", text: string }` content blocks
 *   - tool-result content (string or array of blocks)
 *   - any other shape: JSON.stringify as a last resort
 *
 * Exported for test introspection and for downstream consumers that
 * need to inspect the text content of a trimmed message (e.g. to
 * render the [summa: …] envelope).
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

// ─── Already-summarized detection + fingerprinting ────────────────

/**
 * Pure predicate: does this message already carry a summa envelope?
 * The envelope format is `[summa: ~N tokens originally → ~M tokens
 * summary]` placed at the start of the first text block's `text`
 * field. Detecting the leading `[summa: ~` lets the policy skip
 * re-summarizing a message that was already summarized in a prior
 * context event.
 *
 * Pure: no I/O, no `process.*`. Operates only on the message's
 * content shape. Exported so the wiring layer can test or surface
 * the predicate.
 */
export function isAlreadySummarized(msg: TrimmableMessage): boolean {
	if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && typeof block === "object" && "type" in block && (block as { type: unknown }).type === "text") {
				const text = (block as { text?: unknown }).text;
				if (typeof text === "string" && text.startsWith("[summa: ~")) return true;
				return false;
			}
		}
		return false;
	}
	return false;
}

/**
 * Pure extractor: produce a stable fingerprint for a message from
 * the first 200 characters of its first text-block content. String
 * content is used directly; array content walks to the first
 * `{ type: "text" }` block and uses its `text` field. Empty / no
 * text → empty string.
 *
 * The fingerprint is the dedup key the wiring layer persists via
 * `pi.appendEntry` so the next context event can skip messages
 * already summarized in a prior pass. The first 200 chars is a
 * short, stable proxy: summa summary length is bounded by the
 * configured word budget, so two distinct original messages can
 * collide only if their first 200 chars match — which is the
 * dedup fidelity the policy needs.
 *
 * Pure: no I/O, no `process.*`. Exported for the wiring layer and
 * for tests.
 */
export function messageFingerprint(msg: TrimmableMessage): string {
	let text: string | undefined;
	if (typeof msg.content === "string") {
		text = msg.content;
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && typeof block === "object" && "type" in block && (block as { type: unknown }).type === "text") {
				const t = (block as { text?: unknown }).text;
				if (typeof t === "string") {
					text = t;
					break;
				}
			}
		}
	}
	if (text === undefined) return "";
	return text.slice(0, 200);
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
): ReadonlySet<number> {
	const out = new Set<number>();
	if (recencyFloorTokens === undefined || recencyFloorTokens <= 0) return out;
	let acc = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns)) continue;
		const tokens = approximateMessageTokens(messages[i]);
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
): number {
	let total = 0;
	for (let i = 0; i < messages.length; i++) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices)) continue;
		total += approximateMessageTokens(messages[i]);
	}
	return total;
}

// ─── Summa subprocess (production summarizer) ──────────────────────────

/**
 * The default production summarizer: shells out to Python `summa`.
 * Reads the source text from argv, prints the summary to stdout. On
 * error (summa missing, input too short, etc.) returns the source text
 * unchanged so the trim path stays total-bounded and the policy still
 * makes progress; the diagnostic is exposed via the
 * `lastSummarizerFailed` export for callers that want to surface it.
 *
 * The subprocess is synchronous and bounded — summa is fast on small
 * inputs and we only ever summarize one message per call. Tests pass
 * their own `summarizer` and never hit this path.
 */
export const defaultSummaSummarizer: (text: string, words: number) => string = (text, words) => {
	if (!text || text.length < 200) return text; // Below summa's useful floor.
	// Python `summa` is installed via `pip install --user summa`; the
	// subprocess is `/usr/bin/python3 -c "..."`. The script reads argv,
	// runs `summarize`, prints to stdout.
	const script =
		"import sys\n" +
		"from summa.summarizer import summarize\n" +
		"text = sys.argv[1]\n" +
		"n = int(sys.argv[2])\n" +
		"out = summarize(text, language='english', words=n)\n" +
		"sys.stdout.write(out or text)\n";
	const result = spawnSync("/usr/bin/python3", ["-c", script, text, String(words)], {
		encoding: "utf-8",
		timeout: 5_000,
	});
	if (result.error || result.status !== 0) {
		lastSummarizerFailed = true;
		return text;
	}
	return result.stdout || text;
};

/** Diagnostic flag: did the last `defaultSummaSummarizer` call fail? */
export let lastSummarizerFailed = false;

// ─── The three-tier trim ───────────────────────────────────────────────

/**
 * Apply the three-tier trim to a conversation message stream. Pure:
 * the input is not mutated; the return is a fresh array. Union-equals-
 * input invariant: every input message is either in the output
 * (verbatim, summarized in place, or protected) or in a dropped turn
 * (in which case the entire turn — user + assistant + tool + custom —
 * is removed).
 *
 * The algorithm:
 *   1. Compute `totalTrimmableTokens` (subtracting protected slots).
 *   2. Tier selection:
 *      - total ≤ verbatimMaxTokens           → return messages as-is.
 *      - verbatimMaxTokens < total ≤ summarizeMaxTokens
 *                                            → summarize oldest non-
 *                                              protected trimmable
 *                                              messages in place until
 *                                              total ≤ verbatimMaxTokens.
 *      - total > summarizeMaxTokens          → hard-drop oldest whole
 *                                              turns until total ≤
 *                                              summarizeMaxTokens.
 *
 * Summarization rewrites `content` to a text block carrying a leading
 * tag `[summa: ~N tokens originally → ~M tokens summary]` plus the
 * summary body, so the LLM can see at view time that the message was
 * summarized and approximately how much was lost. The tag also makes
 * the trim visible in the conversation log for the agent's own
 * debugging.
 *
 * The summarizer callback is invoked once per message being
 * summarized; the policy does not batch — a single trim call
 * summarizes as many messages as it needs, oldest first.
 */
export function applyThreeTierTrim(
	messages: ReadonlyArray<TrimmableMessage>,
	options: TrimOptions = {},
): TrimResult {
	const verbatimMax = options.verbatimMaxTokens ?? VERBATIM_TIER_MAX_TOKENS;
	const summarizeMax = options.summarizeMaxTokens ?? SUMMARIZE_TIER_MAX_TOKENS;
	const summarizer = options.summarizer ?? defaultSummaSummarizer;
	const summaWords = options.summaWords ?? SUMMA_WORDS;
	const protectedCustomTypes = options.protectedCustomTypes ?? new Set<string>();
	const protectDispatch = options.protectDispatch ?? true;
	const preservedPatterns = options.preservedPatterns ?? [];
	const dropFloorTokens = options.dropFloorTokens;
	const recencyFloor = options.recencyFloor;
	const alreadySummarizedHashes = options.alreadySummarizedHashes ?? new Set<string>();

	// Compute the recency-protected slice once and thread it through
	// every internal call. The slice is the operator's
	// "most-recent-N-tokens of trimmable content" carve-out;
	// messages in the slice are treated as protected (additive OR
	// with the dispatch / pinned / preserved-paths channels). The
	// slice is computed against the other protected-slot channels
	// so already-protected messages are excluded — they are
	// already subtracted from the budget by their own channels.
	const recencyProtectedIndices = computeRecencyProtectedIndices(
		messages,
		recencyFloor,
		protectedCustomTypes,
		protectDispatch,
		preservedPatterns,
	);

	// First, decide the tier based on the trimmable total.
	let total = totalTrimmableTokens(messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices);

	// Tier 3: hard-drop oldest whole turns until total ≤ summarizeMax.
	// The "turn" is bounded by user messages: a turn is everything from
	// one user message (exclusive of protected slots) up to (but not
	// including) the next user message. We carve whole turns from the
	// oldest end.
	if (total > summarizeMax) {
		const { messages: dropped, droppedTurns, shouldFallThrough } = dropOldestTurns(
			messages,
			summarizeMax,
			protectedCustomTypes,
			protectDispatch,
			preservedPatterns,
			dropFloorTokens,
			recencyProtectedIndices,
		);
		// Drop-floor fall-through: when the next-oldest turn would
		// push the trimmable total below `dropFloorTokens`, stop
		// dropping and hand the surviving trimmable content off to
		// the summarize path. The summarize path then trims the
		// older half (trimmable messages OUTSIDE the recency
		// window) down to verbatimMax — the recency slice stays
		// intact and the drop tier never collapses the floor.
		if (shouldFallThrough) {
			const result = summarizeOldestUntilUnder(
				dropped,
				verbatimMax,
				summarizer,
				summaWords,
				protectedCustomTypes,
				protectDispatch,
				preservedPatterns,
				recencyProtectedIndices,
				alreadySummarizedHashes,
			);
			return {
				messages: result.messages,
				summarized: result.summarized,
				droppedTurns,
				totalTokens: totalTrimmableTokens(
					result.messages,
					protectedCustomTypes,
					protectDispatch,
					preservedPatterns,
					recencyProtectedIndices,
				),
				summarizedFingerprints: result.summarizedFingerprints,
			};
		}
		// Re-check; we may have overshot (no trimmable turns left).
		total = totalTrimmableTokens(dropped, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices);
		// If still over summarizeMax (a single trimmable turn is larger
		// than the tier ceiling), summarize that turn's oldest messages
		// as a fallback. This is the only path where summarize fires
		// from tier 3; tier 2's summarize path is the normal one.
		if (total > summarizeMax) {
			const result = summarizeOldestUntilUnder(dropped, verbatimMax, summarizer, summaWords, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, alreadySummarizedHashes);
			return {
				messages: result.messages,
				summarized: result.summarized,
				droppedTurns,
				totalTokens: totalTrimmableTokens(result.messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices),
				summarizedFingerprints: result.summarizedFingerprints,
			};
		}
		return {
			messages: dropped,
			summarized: 0,
			droppedTurns,
			totalTokens: total,
			summarizedFingerprints: [],
		};
	}

	// Tier 2: summarize oldest non-protected trimmable messages until
	// total ≤ verbatimMax.
	if (total > verbatimMax) {
		const result = summarizeOldestUntilUnder(messages, verbatimMax, summarizer, summaWords, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices, alreadySummarizedHashes);
		return {
			messages: result.messages,
			summarized: result.summarized,
			droppedTurns: 0,
			totalTokens: totalTrimmableTokens(result.messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices),
			summarizedFingerprints: result.summarizedFingerprints,
		};
	}

	// Tier 1: verbatim.
	return {
		messages: messages.slice(),
		summarized: 0,
		droppedTurns: 0,
		totalTokens: total,
		summarizedFingerprints: [],
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
): { messages: TrimmableMessage[]; droppedTurns: number; shouldFallThrough: boolean } {
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
				turns.push(makeTurn(messages, turnStart, i, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices));
			}
			turnStart = i + 1; // The trimmable turn starts AFTER this user message.
		} else if (msg.role === "custom" && msg.customType && protectedCustomTypes.has(msg.customType)) {
			// A protected custom slot closes any open trimmable turn.
			if (turnStart !== -1) {
				turns.push(makeTurn(messages, turnStart, i, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices));
				turnStart = -1;
			}
		}
	}
	// Close the final open turn (if any).
	if (turnStart !== -1) {
		turns.push(makeTurn(messages, turnStart, messages.length, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices));
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
	// Exception: a SINGLE trimmable message is left for the
	// summarize-fallback path (the policy summarizes it instead of
	// dropping it, since dropping the only trimmable content would
	// leave the session empty). 2+ trimmable messages are bundled
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
			if (!isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices)) trimmableCount++;
		}
		if (trimmableCount >= 2 && tailStart < messages.length) {
			turns.push(makeTurn(messages, tailStart, messages.length, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices));
		}
	}
	// Compute the total trimmable token mass of the input.
	const totalMass = turns.reduce((s, t) => s + t.tokens, 0);
	// Drop oldest turns until the remaining mass is ≤ cap.
	// Drop-floor guard: when `dropFloorTokens` is set, stop one
	// step before the next-oldest turn would push the remaining
	// trimmable mass below the floor. The caller (applyThreeTierTrim)
	// then hands the surviving trimmable content off to the
	// summarize path so the drop tier never collapses the protected
	// floor.
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
	// of per-turn envelopes. The reminder does NOT mirror the
	// Tier-2 `[summa: …]` envelope grammar: no bracket tag, no
	// ordinals, no token mass. The "get it fresh" clause is
	// conditional ("if you need …"), not a directive.
	const out: TrimmableMessage[] = [];
	if (dropSet.size > 0) {
		out.push({ role: "user", content: PRUNE_REMINDER_TEXT });
	}
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
		if (inDroppedTurn && !isProtectedSlot(msg, i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices)) continue;
		out.push(msg);
	}
	return { messages: out, droppedTurns: dropSet.size, shouldFallThrough };
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
): { start: number; end: number; tokens: number } {
	let tokens = 0;
	for (let i = start; i < end; i++) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices)) continue;
		tokens += approximateMessageTokens(messages[i]);
	}
	return { start, end, tokens };
}

// ─── Internal: in-place summarization ──────────────────────────────────

/**
 * Summarize the oldest non-protected trimmable messages in place until
 * the trimmable total is ≤ `cap`. The summarizer rewrites the
 * `content` of each summarized message to a single text block carrying
 * the `[summa: …]` tag and the summary body. The protected slots
 * (first user message) are never summarized.
 *
 * The loop iterates oldest-first and stops as soon as the total is
 * under the cap OR no trimmable message remains to summarize.
 *
 * Already-summarized detection: each iteration calls
 * `findOldestSummarizable` with the skip flag ON. When the only
 * remaining candidates are already-summarized messages and the
 * total is still over the cap, the escape clause retries the
 * find with the skip flag OFF — the already-summarized message
 * gets a fresh summary rather than blocking progress.
 *
 * `summarizedFingerprints` is the dedup-key list the wiring layer
 * persists. Each entry is the ORIGINAL message fingerprint
 * (computed against the input array, before the content is
 * rewritten with the summa envelope) — using the original
 * fingerprint keeps the persisted key stable across re-summaries.
 */
function summarizeOldestUntilUnder(
	messages: ReadonlyArray<TrimmableMessage>,
	cap: number,
	summarizer: (text: string, words: number) => string,
	summaWords: number,
	protectedCustomTypes: ReadonlySet<string> = new Set(),
	protectDispatch = true,
	preservedPatterns: ReadonlyArray<string> = [],
	recencyProtectedIndices: ReadonlySet<number> = new Set(),
	alreadySummarizedHashes: ReadonlySet<string> = new Set(),
): { messages: TrimmableMessage[]; summarized: number; summarizedFingerprints: string[] } {
	const out = messages.map((m) => m);
	let summarized = 0;
	const summarizedFingerprints: string[] = [];
	// Cursor: the next index we'll consider for summarization. Starts
	// at 0 and is advanced past each summarized message so we never
	// re-summarize the same message in the same pass (which would
	// infinite-loop: the replacement content is small, but the
	// message remains the "oldest" candidate and gets re-picked).
	let cursor = 0;
	while (totalTrimmableTokens(out, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices) > cap) {
		// Find the oldest non-protected trimmable message at or
		// after the cursor. Skip already-summarized by default.
		let target = findOldestSummarizable(out, protectedCustomTypes, protectDispatch, preservedPatterns, cursor, recencyProtectedIndices, alreadySummarizedHashes, true);
		// Escape clause: when the only candidates are already-
		// summarized messages and the total is still over the cap,
		// retry with the skip flag lifted so an already-summarized
		// message gets a fresh summary rather than blocking progress.
		if (target === -1) {
			target = findOldestSummarizable(out, protectedCustomTypes, protectDispatch, preservedPatterns, cursor, recencyProtectedIndices, alreadySummarizedHashes, false);
			if (target === -1) break;
		}
		// Capture the ORIGINAL fingerprint before the content is
		// replaced with the summa envelope. Using the original keeps
		// the persisted key stable across re-summaries.
		summarizedFingerprints.push(messageFingerprint(messages[target]));
		const msg = out[target];
		const original = extractText(msg.content);
		const originalTokens = approximateMessageTokens(msg);
		const summary = (() => {
			try {
				return summarizer(original, summaWords);
			} catch {
				return original;
			}
		})();
		const summaryText = summary.length > 0 ? summary : original;
		const summaryTokens = approximateMessageTokens({ ...msg, content: summaryText });
		// Replace content with the summa envelope.
		const tag = `[summa: ~${originalTokens} tokens originally → ~${summaryTokens} tokens summary]`;
		out[target] = {
			...msg,
			content: [{ type: "text", text: `${tag}\n${summaryText}` }],
		};
		summarized += 1;
		// Advance the cursor past this message so we don't re-pick it.
		cursor = target + 1;
		// Defensive bound: if the summarizer returned a longer string
		// (it shouldn't — summa is lossy), bail rather than loop forever.
		if (summaryTokens >= originalTokens) break;
	}
	return { messages: out, summarized, summarizedFingerprints };
}

/**
 * Find the index of the oldest non-protected trimmable message in the
 * array. A user message with `userTurnAge === 0` (the dispatch) is
 * protected; a `customType` in `protectedCustomTypes` is also protected.
 * Returns -1 if no candidate is found.
 *
 * When `skipAlreadySummarized` is `true` (default), messages that
 * already carry a summa envelope (`isAlreadySummarized`) or whose
 * fingerprint is in `alreadySummarizedHashes` are also skipped. The
 * `false` form is the escape clause: callers retry with the skip
 * lifted when the only remaining trimmable candidates are
 * already-summarized messages and the total is still over the
 * verbatim cap.
 */
function findOldestSummarizable(
	messages: ReadonlyArray<TrimmableMessage>,
	protectedCustomTypes: ReadonlySet<string>,
	protectDispatch: boolean,
	preservedPatterns: ReadonlyArray<string> = [],
	startFrom = 0,
	recencyProtectedIndices: ReadonlySet<number> = new Set(),
	alreadySummarizedHashes: ReadonlySet<string> = new Set(),
	skipAlreadySummarized: boolean = true,
): number {
	for (let i = startFrom; i < messages.length; i++) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns, recencyProtectedIndices)) continue;
		if (skipAlreadySummarized) {
			if (isAlreadySummarized(messages[i])) continue;
			if (alreadySummarizedHashes.has(messageFingerprint(messages[i]))) continue;
		}
		return i;
	}
	return -1;
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
