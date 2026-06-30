/**
 * T-2707 — Keep-mark state module: file-read tracking + keep-vs-drop state.
 *
 * Pure-logic state module (no Pi imports) consumed by the `tool_result`
 * and `before_agent_start` handlers in `index.ts`. Owns:
 *
 *   - The in-memory **read-files set** — every file the agent has read
 *     in the current session, with the `toolCallId` of the read tool
 *     result that observed the file. The set is the source of truth for
 *     "what files is the agent working with?" — it feeds the file-read
 *     digest the `before_agent_start` handler injects.
 *   - The in-memory **keep-mark map** — file path → "keep" / "drop",
 *     populated when the agent expresses a keep-vs-drop decision in its
 *     assistant message. The map is the consumer surface T-2706 reads
 *     to promote kept files from the policy's `trim` set to `retain`
 *     (per AC-3: a kept file stays in the per-LLM-call view across turns).
 *
 * Session scoping: both structures are reset on `session_start` (per
 * AC-2: session-scoped, no cross-session memory). The `resetSession`
 * function is the seam; the `index.ts` `session_start` handler calls it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Opt-in vs opt-out (the AC-2 decision)
 *
 *   **Opt-in (agent marks files to keep).** The default is "drop everything
 *   from the read-files list"; the agent must explicitly mark files to keep
 *   them. New reads are recorded with an implicit "drop" mark; the agent
 *   sets a "keep" mark by saying `keep <path>` in its assistant message
 *   (parsed by `parseKeepMarksFromText`).
 *
 *   Rationale: aligns with the operator's "extra re-read turns accepted
 *   over keeping all files resident" stance (parent T-2703 constraint #3).
 *   The default is conservative — the session file does not bloat with
 *   every file the agent touches; only files the agent actively keeps
 *   survive the trim. A dropped file is recoverable by re-read (one
 *   extra turn — the cost the operator accepted).
 *
 *   The opposite (opt-out) was considered and rejected: it would require
 *   the agent to mark every file it wants to drop, which is higher friction
 *   for typical sessions (most reads are intentional). Opt-in concentrates
 *   the agent's decision on the *retain* set, which is the smaller and
 *   more meaningful set.
 *
 * Channel (the AC-2 decision):
 *
 *   **`before_agent_start`** is the digest-injection channel. The handler
 *   returns a `message` (the file-read digest) that the agent sees at
 *   the start of each turn. The agent can mark files to keep in its
 *   response; the next `before_agent_start` reads the keep-mark.
 *
 *   Rationale: `before_agent_start` fires once per turn with a
 *   `message`-injection shape that the LLM consumes naturally (a
 *   persistent message the agent sees at the top of each turn).
 *   Per-LLM-call `context` injection would over-inject (the digest would
 *   appear on every LLM call within a turn, not just the start). `ctx.ui`
 *   `setWidget` is operator-facing, not agent-facing — the agent would
 *   have to be told the widget exists separately, which defeats the
 *   "the agent sees this" affordance.
 *
 * Keep-mark integration with T-2706 (AC-3 seam):
 *
 *   T-2707 owns the keep-mark state. T-2706's `context` handler reads
 *   the state via the `promoteKeptToolResults` helper below and moves
 *   matching tool-result messages from the policy's `trim` set to
 *   `retain` before returning `{ messages: result.retain }` to Pi.
 *
 *   The integration surface is a single function call:
 *
 *     const final = promoteKeptToolResults(result.trim, result.retain, keepMarkState);
 *     return { messages: final };
 *
 *   `index.ts` wires the call into the `context` handler (T-2707's
 *   integration; the same handler is T-2706's wiring surface).
 *
 * Recovery (AC-3):
 *
 *   - A **dropped** file is recoverable: the read-files set is persistent
 *     across the trim (a dropped file is still in the list). The agent
 *     sees the path in the digest and can re-invoke the read tool; the
 *     `tool_result` handler from `digest.ts` produces a fresh digest of
 *     the re-read content. The recovery is one extra turn; the cost the
 *     operator accepted.
 *   - A **kept** file stays in the per-LLM-call view across turns. The
 *     keep-mark is consulted by `promoteKeptToolResults` on every
 *     `context` event; a kept file is effectively pinned to the recency
 *     window regardless of age.
 *
 * Purity contract:
 *   - The state itself is a plain in-memory object — the module exports
 *     a fresh state factory `createKeepMarkState()` so tests can
 *     construct isolated state without shared global mutation.
 *   - The text-parsing helpers are pure functions; the state mutation
 *     is method-bound to the state instance (no module-level globals).
 *   - No Pi imports, no I/O.
 */

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * The keep/drop decision for a single file path. `keep` survives the
 * trim; `drop` may be trimmed (recoverable by re-read).
 */
export type KeepDecision = "keep" | "drop";

/**
 * A single observed file read: the file path + the `toolCallId` of the
 * read tool result that observed it. The `toolCallId` is the join key
 * `promoteKeptToolResults` uses to find the corresponding tool-result
 * message in the conversation stream.
 */
export interface ReadFileRecord {
	/** Absolute file path observed by the read tool. */
	path: string;
	/** The `toolCallId` of the read tool result. Join key for promotion. */
	toolCallId: string;
	/** Turn index (1-based) at which the read occurred. For ordering. */
	turnIndex: number;
}

/**
 * The keep-mark state container. Created by `createKeepMarkState()`.
 * The instance exposes the read-files set, the keep-mark map, and the
 * mutator methods. Tests construct fresh instances; the production
 * `index.ts` constructor uses one instance per session and resets it on
 * `session_start`.
 */
export interface KeepMarkState {
	/** All files the agent has read in the current session, in read order. */
	readonly reads: Map<string, ReadFileRecord>;
	/** Per-file keep decision. Absent = undecided (default opt-in: drop). */
	readonly keepMarks: Map<string, KeepDecision>;
	/** Record a new read. New reads default to "drop" in opt-in mode. */
	recordRead: (path: string, toolCallId: string, turnIndex: number) => void;
	/** Set or clear a keep decision for a file. */
	setKeepMark: (path: string, decision: KeepDecision) => void;
	/** Get the current decision for a file, or null if undecided. */
	getKeepMark: (path: string) => KeepDecision | null;
	/** Test whether a file has been recorded as read. */
	hasRead: (path: string) => boolean;
	/** Return the read record for a path, or undefined. */
	getReadRecord: (path: string) => ReadFileRecord | undefined;
	/** Return all read paths, in read order. */
	getReadPaths: () => string[];
	/** Return the set of `toolCallId`s corresponding to kept files. */
	getKeptToolCallIds: () => Set<string>;
	/** Reset the state to empty (session-scope reset on `session_start`). */
	resetSession: () => void;
}

/**
 * Conversation-message structural shape. Mirrors the policy's
 * `ConversationMessage` — a minimal `{ role: string; [key: string]: unknown }`
 * shape. Deliberately broad: the policy's recency filter does not need
 * the full Pi type, and the keep-mark module does not either.
 *
 * The two fields the promote helper needs:
 *   - `role: string` — must equal `"toolResult"` to be a candidate.
 *   - `toolCallId?: string` — join key for the keep-mark lookup. Pi's
 *     tool-result messages carry `toolCallId` in their `details` or as
 *     a top-level field; the helper inspects both for compatibility.
 */
export interface ToolResultMessage {
	role: string;
	toolCallId?: string;
	[key: string]: unknown;
}

// ─── State factory ─────────────────────────────────────────────────────────

/**
 * Create a fresh keep-mark state instance. The instance holds its own
 * Maps (no module-level globals), so tests can construct isolated state
 * without cross-test pollution.
 *
 * Opt-in default: a newly recorded read is **undecided** (no entry in
 *   the keep-mark map). The effective behavior is "drop" — only paths
 *   with an explicit `"keep"` entry land in `getKeptToolCallIds`. The
 *   agent sets a "keep" mark via `parseKeepMarksFromText` (which the
 *   `before_agent_start` handler in `index.ts` applies on every turn)
 *   or by calling `setKeepMark` directly.
 */
export function createKeepMarkState(): KeepMarkState {
	const reads = new Map<string, ReadFileRecord>();
	const keepMarks = new Map<string, KeepDecision>();

	return {
		reads,
		keepMarks,
		recordRead(path, toolCallId, turnIndex) {
			// Re-recording a read (e.g. a re-read turn) updates the
			// `toolCallId` and `turnIndex` but preserves the keep-mark
			// if one is set (the agent's keep decision survives a
			// re-read — they meant to keep the file, not just the
			// snapshot). The order in the read-files list is the most
			// recent read.
			reads.set(path, { path, toolCallId, turnIndex });
		},
		setKeepMark(path, decision) {
			keepMarks.set(path, decision);
		},
		getKeepMark(path) {
			return keepMarks.get(path) ?? null;
		},
		hasRead(path) {
			return reads.has(path);
		},
		getReadRecord(path) {
			return reads.get(path);
		},
		getReadPaths() {
			return Array.from(reads.keys());
		},
		getKeptToolCallIds() {
			const ids = new Set<string>();
			for (const [path, decision] of keepMarks) {
				if (decision !== "keep") continue;
				const record = reads.get(path);
				if (record) ids.add(record.toolCallId);
			}
			return ids;
		},
		resetSession() {
			reads.clear();
			keepMarks.clear();
		},
	};
}

// ─── Keep-mark parser (text → keep/drop decisions) ─────────────────────────

/**
 * Parse keep-vs-drop marks from an agent assistant message. The parser
 * is intentionally simple — it greps the message for two patterns:
 *
 *   `keep <path>`         → set "keep" for `<path>`
 *   `drop <path>`         → set "drop" for `<path>` (clears a prior keep)
 *
 * Both patterns are case-insensitive and match the first whitespace-
 * bounded token after the keyword. The parser is a pure function
 * (input string + known paths → decisions); the caller wires the
 * decisions into the state via `setKeepMark`.
 *
 * Why a text parser: the agent's "mark" is whatever it says in its
 * response. Parsing plain text is the lowest-friction way to surface
 * the keep-vs-drop affordance — the agent does not need to call a
 * special tool or use a structured API. A more structured approach
 * (a dedicated tool, JSON output) would be higher-friction and would
 * require the agent to learn a new affordance for every file.
 *
 * Known-paths filter: the parser only acts on paths it has observed
 * via `recordRead`. A `keep /foo/bar` for a path the agent has not
 * read is a no-op (the agent may be referring to a hypothetical file
 * the digester has not yet seen — the read must happen first for the
 * keep-mark to apply).
 */
export function parseKeepMarksFromText(
	text: string,
	knownPaths: ReadonlySet<string>,
): Array<{ path: string; decision: KeepDecision }> {
	const out: Array<{ path: string; decision: KeepDecision }> = [];
	if (!text) return out;

	// Tokenize: split on whitespace, then for each token, check whether
	// the previous word was a keep/drop keyword. The patterns are:
	//   `keep /path/to/file`        (space between)
	//   `keep "/path with spaces"`  (quoted; the parser strips quotes
	//                                and reassembles the inner tokens
	//                                when the path itself contains
	//                                whitespace)
	// Lines with bare `keep` or `drop` (no path) are ignored.
	const tokens = text.split(/\s+/);
	for (let i = 0; i < tokens.length - 1; i++) {
		const keyword = tokens[i]?.toLowerCase();
		if (keyword !== "keep" && keyword !== "drop") continue;
		// Collect the path: start with the next token, then accumulate
		// additional tokens while the path is unterminated-quote.
		let rawPath = tokens[i + 1] ?? "";
		const openQuote = rawPath.startsWith('"') || rawPath.startsWith("'") ? rawPath[0] : "";
		const startsWithClosingQuote = openQuote && rawPath.endsWith(openQuote) && rawPath.length > 1;
		if (openQuote && !startsWithClosingQuote) {
			// The path is quoted but unterminated — accumulate tokens
			// until we find the matching closing quote.
			const collected: string[] = [rawPath];
			for (let j = i + 2; j < tokens.length; j++) {
				const t = tokens[j] ?? "";
				collected.push(t);
				if (t.endsWith(openQuote)) {
					i = j; // skip past the closing-quote token
					break;
				}
			}
			rawPath = collected.join(" ");
		}
		// Strip a single opening quote (when the path token's leading
		// character is a quote but the rest is the path body).
		if (rawPath.startsWith('"') || rawPath.startsWith("'")) {
			rawPath = rawPath.slice(1);
		}
		// Strip a single closing quote.
		if (rawPath.endsWith('"') || rawPath.endsWith("'")) {
			rawPath = rawPath.slice(0, -1);
		}
		// Strip trailing punctuation that may have been glued to the
		// path (e.g. `keep /foo/bar.`).
		rawPath = rawPath.replace(/[.,;:!?)]+$/, "");
		if (!rawPath || !knownPaths.has(rawPath)) continue;
		out.push({ path: rawPath, decision: keyword === "keep" ? "keep" : "drop" });
	}
	return out;
}

// ─── T-2706 integration surface (the keep-mark consumer) ──────────────────

/**
 * Move kept tool-result messages from the policy's `trim` set to the
 * `retain` set. The function preserves the union-equals-input invariant
 * of the policy's return shape: every input message appears in exactly
 * one of the two output sets.
 *
 * The function takes the policy's `{ retain, trim }` result and the
 * keep-mark state, and returns the post-promotion partition. T-2706's
 * `context` handler is the natural caller:
 *
 *     const result = trimConversation(messages, { tokens }, options);
 *     const final = promoteKeptToolResults(result.trim, result.retain, state);
 *     return { messages: final.retain };
 *
 * Algorithm:
 *   1. For each message in `trim`, check if `role === "toolResult"`.
 *   2. If yes, extract the `toolCallId` (top-level or nested in
 *      `details` for compatibility with the policy's structural shape).
 *   3. If the `toolCallId` is in the kept set, move the message to
 *      `retain`. Otherwise, leave it in `trim`.
 *   4. The order within each output set is preserved (slices, not
 *      rearrangements).
 *
 * The function is pure: it does not mutate `trim`, `retain`, or the
 * state. The two output arrays are fresh.
 */
export function promoteKeptToolResults<M extends ToolResultMessage>(
	trim: ReadonlyArray<M>,
	retain: ReadonlyArray<M>,
	state: KeepMarkState,
): { retain: M[]; trim: M[] } {
	const keptIds = state.getKeptToolCallIds();
	if (keptIds.size === 0) {
		// Fast path: no keep-marks → no promotion. Return fresh arrays
		// of the same content (caller can use the originals; the fresh
		// arrays are the purity contract — the caller can mutate the
		// returns without aliasing the inputs).
		return { retain: retain.slice(), trim: trim.slice() };
	}
	const promoted: M[] = [];
	const kept: M[] = [];
	for (const msg of trim) {
		if (msg.role !== "toolResult") {
			kept.push(msg);
			continue;
		}
		// Extract the `toolCallId`. The policy's `ConversationMessage`
		// shape does not pin a `toolCallId` field; Pi's tool-result
		// messages carry it under `details.toolCallId` or as a top-level
		// field. The helper checks both.
		const id = extractToolCallId(msg);
		if (id && keptIds.has(id)) {
			promoted.push(msg);
		} else {
			kept.push(msg);
		}
	}
	// Append the promoted messages to the end of `retain` (the agent's
	// recent context). Order is preserved: the most recent kept file
	// (highest turn index) ends up at the end.
	return { retain: retain.concat(promoted), trim: kept };
}

/**
 * Extract the `toolCallId` from a tool-result message. The function
 * checks the top-level field first, then falls back to `details.toolCallId`
 * for compatibility with shapes that nest the id.
 */
function extractToolCallId(msg: ToolResultMessage): string | undefined {
	if (typeof msg.toolCallId === "string") return msg.toolCallId;
	const details = msg.details as { toolCallId?: unknown } | undefined;
	if (details && typeof details.toolCallId === "string") return details.toolCallId;
	return undefined;
}

// ─── File-read digest format (the agent-facing list) ──────────────────────

/**
 * Build the agent-facing file-read digest message. The function returns
 * a string the `before_agent_start` handler passes as the `message.content`
 * field. The format is human-readable and the agent parses it
 * naturally; the LLM does not need a structured format here.
 *
 * The format is a simple list:
 *
 *   Read files in this session (N):
 *     - /path/to/file1.ts  [keep]
 *     - /path/to/file2.ts  [drop]
 *     - /path/to/file3.ts  [undecided]
 *   To keep a file, reply with:  keep <path>
 *   To drop a file, reply with:  drop <path>
 *
 * The list is bounded by `maxFiles` (default 50) to avoid an
 * unbounded digest in long sessions. The tail of the list is shown
 * (most recent reads are most relevant); a count of truncated entries
 * is appended.
 */
export function buildFileReadDigest(state: KeepMarkState, maxFiles = 50): string {
	const paths = state.getReadPaths();
	if (paths.length === 0) {
		return "Read files in this session (0): none yet.";
	}
	const total = paths.length;
	const start = Math.max(0, total - maxFiles);
	const visible = paths.slice(start);

	const lines: string[] = [`Read files in this session (${total}):`];
	for (const path of visible) {
		const decision = state.getKeepMark(path);
		const mark = decision === "keep" ? "keep" : decision === "drop" ? "drop" : "undecided";
		lines.push(`  - ${path}  [${mark}]`);
	}
	if (start > 0) {
		lines.push(`  (${start} earlier reads not shown)`);
	}
	lines.push("To keep a file, reply with:  keep <path>");
	lines.push("To drop a file, reply with:  drop <path>");
	return lines.join("\n");
}
