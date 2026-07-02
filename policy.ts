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

// ─── Protected-slot predicate ──────────────────────────────────────────

export function isProtectedSlot(
	msg: TrimmableMessage,
	index: number,
	messages: ReadonlyArray<TrimmableMessage>,
	protectedCustomTypes: ReadonlySet<string> = new Set(),
	protectDispatch = true,
	preservedPatterns: ReadonlyArray<string> = [],
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
): number {
	let total = 0;
	for (let i = 0; i < messages.length; i++) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns)) continue;
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

	// First, decide the tier based on the trimmable total.
	let total = totalTrimmableTokens(messages, protectedCustomTypes, protectDispatch, preservedPatterns);

	// Tier 3: hard-drop oldest whole turns until total ≤ summarizeMax.
	// The "turn" is bounded by user messages: a turn is everything from
	// one user message (exclusive of protected slots) up to (but not
	// including) the next user message. We carve whole turns from the
	// oldest end.
	if (total > summarizeMax) {
		const { messages: dropped, droppedTurns } = dropOldestTurns(messages, summarizeMax, protectedCustomTypes, protectDispatch, preservedPatterns);
		// Re-check; we may have overshot (no trimmable turns left).
		total = totalTrimmableTokens(dropped, protectedCustomTypes, protectDispatch, preservedPatterns);
		// If still over summarizeMax (a single trimmable turn is larger
		// than the tier ceiling), summarize that turn's oldest messages
		// as a fallback. This is the only path where summarize fires
		// from tier 3; tier 2's summarize path is the normal one.
		if (total > summarizeMax) {
			const result = summarizeOldestUntilUnder(dropped, verbatimMax, summarizer, summaWords, protectedCustomTypes, protectDispatch, preservedPatterns);
			return {
				messages: result.messages,
				summarized: result.summarized,
				droppedTurns,
				totalTokens: totalTrimmableTokens(result.messages, protectedCustomTypes, protectDispatch, preservedPatterns),
			};
		}
		return {
			messages: dropped,
			summarized: 0,
			droppedTurns,
			totalTokens: total,
		};
	}

	// Tier 2: summarize oldest non-protected trimmable messages until
	// total ≤ verbatimMax.
	if (total > verbatimMax) {
		const result = summarizeOldestUntilUnder(messages, verbatimMax, summarizer, summaWords, protectedCustomTypes, protectDispatch, preservedPatterns);
		return {
			messages: result.messages,
			summarized: result.summarized,
			droppedTurns: 0,
			totalTokens: totalTrimmableTokens(result.messages, protectedCustomTypes, protectDispatch, preservedPatterns),
		};
	}

	// Tier 1: verbatim.
	return {
		messages: messages.slice(),
		summarized: 0,
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
): { messages: TrimmableMessage[]; droppedTurns: number } {
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
				turns.push(makeTurn(messages, turnStart, i, protectedCustomTypes, protectDispatch, preservedPatterns));
			}
			turnStart = i + 1; // The trimmable turn starts AFTER this user message.
		} else if (msg.role === "custom" && msg.customType && protectedCustomTypes.has(msg.customType)) {
			// A protected custom slot closes any open trimmable turn.
			if (turnStart !== -1) {
				turns.push(makeTurn(messages, turnStart, i, protectedCustomTypes, protectDispatch, preservedPatterns));
				turnStart = -1;
			}
		}
	}
	// Close the final open turn (if any).
	if (turnStart !== -1) {
		turns.push(makeTurn(messages, turnStart, messages.length, protectedCustomTypes, protectDispatch, preservedPatterns));
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
			if (!isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns)) trimmableCount++;
		}
		if (trimmableCount >= 2 && tailStart < messages.length) {
			turns.push(makeTurn(messages, tailStart, messages.length, protectedCustomTypes, protectDispatch, preservedPatterns));
		}
	}
	// Compute the total trimmable token mass of the input.
	const totalMass = turns.reduce((s, t) => s + t.tokens, 0);
	// Drop oldest turns until the remaining mass is ≤ cap.
	let remaining = totalMass;
	const dropSet = new Set<number>();
	for (const t of turns) {
		if (remaining <= cap) break;
		dropSet.add(t.start); // Marker: this turn's start index is dropped.
		remaining -= t.tokens;
	}
	// Build the output: every message NOT inside a dropped turn.
	const out: TrimmableMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		// If this message is inside a dropped turn, skip it.
		// A turn is dropped iff its start index is in dropSet.
		let inDroppedTurn = false;
		for (const t of turns) {
			if (dropSet.has(t.start) && i >= t.start && i < t.end) {
				inDroppedTurn = true;
				break;
			}
		}
		if (!inDroppedTurn) out.push(msg);
	}
	return { messages: out, droppedTurns: dropSet.size };
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
): { start: number; end: number; tokens: number } {
	let tokens = 0;
	for (let i = start; i < end; i++) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns)) continue;
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
 */
function summarizeOldestUntilUnder(
	messages: ReadonlyArray<TrimmableMessage>,
	cap: number,
	summarizer: (text: string, words: number) => string,
	summaWords: number,
	protectedCustomTypes: ReadonlySet<string> = new Set(),
	protectDispatch = true,
	preservedPatterns: ReadonlyArray<string> = [],
): { messages: TrimmableMessage[]; summarized: number } {
	const out = messages.map((m) => m);
	let summarized = 0;
	// Cursor: the next index we'll consider for summarization. Starts
	// at 0 and is advanced past each summarized message so we never
	// re-summarize the same message in the same pass (which would
	// infinite-loop: the replacement content is small, but the
	// message remains the "oldest" candidate and gets re-picked).
	let cursor = 0;
	while (totalTrimmableTokens(out, protectedCustomTypes, protectDispatch, preservedPatterns) > cap) {
		// Find the oldest non-protected trimmable message at or
		// after the cursor.
		const target = findOldestSummarizable(out, protectedCustomTypes, protectDispatch, preservedPatterns, cursor);
		if (target === -1) break; // Nothing left to summarize (degenerate: a single message is over cap).
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
	return { messages: out, summarized };
}

/**
 * Find the index of the oldest non-protected trimmable message in the
 * array. A user message with `userTurnAge === 0` (the dispatch) is
 * protected; a `customType` in `protectedCustomTypes` is also protected.
 * Returns -1 if no candidate is found.
 */
function findOldestSummarizable(
	messages: ReadonlyArray<TrimmableMessage>,
	protectedCustomTypes: ReadonlySet<string>,
	protectDispatch: boolean,
	preservedPatterns: ReadonlyArray<string> = [],
	startFrom = 0,
): number {
	for (let i = startFrom; i < messages.length; i++) {
		if (isProtectedSlot(messages[i], i, messages, protectedCustomTypes, protectDispatch, preservedPatterns)) continue;
		return i;
	}
	return -1;
}
