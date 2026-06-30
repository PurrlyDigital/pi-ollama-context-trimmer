/**
 * T-2717 — Lifecycle state module (the unified keep/digest/retire engine).
 *
 * Replaces the T-2707 `keep-mark.ts` file-read-only surface with a single
 * engine that tracks every tool result the agent has produced this session
 * and applies the keep/digest/retire lifecycle on demand.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Lifecycle states (AC-2 — the engine shape)
 *
 *   `verbatim`  — the message's `content` is shown to the LLM as-is.
 *                 Default on first view; transitions to `digest` on the next
 *                 turn (the producing turn shows verbatim, every later turn
 *                 shows digest — the age-scoped view-time digest from AC-1).
 *   `digest`    — the message's `details.digest` is shown to the LLM in
 *                 place of the verbatim `content`. Pre-computed at
 *                 `tool_result` time (the Gate-5 digest-once + view-time
 *                 pointer-swap from the TDT); never recomputed on `context`.
 *   `retired`   — the message is excluded from the per-LLM-call view
 *                 entirely (the recency comfort window has moved past it).
 *                 The message is still persisted in the session file (for
 *                 the compactor and for re-request), just not shown.
 *   `kept`      — agent override: the message stays in verbatim regardless
 *                 of age. Pinned to the recency window by the agent's
 *                 `keep <key>` decision.
 *   `dropped`   — agent override: the message is excluded from the
 *                 per-LLM-call view regardless of age. Persisted, not
 *                 shown. The agent's `drop <key>` decision.
 *
 * Auto-state transitions (the lifecycle layer):
 *
 *   tool_result writes the record at `verbatim`.
 *   The `context` handler applies `applyLifecycleState`:
 *     - `kept`   → verbatim regardless of age
 *     - `dropped` → excluded (retired-by-agent)
 *     - `verbatim` whose `age < currentTurn` → digest
 *     - `retired` (set by the recency filter) → excluded
 *     - everything else → verbatim (still on the producing turn)
 *
 * The recency filter (`policy.ts`) is the layer that decides WHICH messages
 * age out of the recency comfort window. The lifecycle engine is the layer
 * that decides WHAT to show for the messages that survived. The two layers
 * compose: recency carves the candidate set; lifecycle picks the per-message
 * shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Tool output coverage (AC-2 widen-from-file-reads)
 *
 *   `recordToolResult(toolName, toolCallId, key, turnIndex)` records every
 *   tool output the agent has produced — `read`/`write`/`edit` (key = path),
 *   `bash` (key = command), `grep`/`find` (key = pattern + path), `ls` (key
 *   = path), MCP-custom (key = tool id). The state is keyed on `toolCallId`
 *   so every tool result has exactly one record, regardless of the key shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Parser (the agent's keep/drop affordance)
 *
 *   The parser widens from `keep <path>` / `drop <path>` to `keep <key>` /
 *   `drop <key>`. The known-keys filter widens from the file-read set to the
 *   full tool-output set, so the agent can mark any tool output it has
 *   produced. Bare `keep` / `drop` patterns with no key are no-ops (the
 *   tool result must have happened first).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Session scoping
 *
 *   The state is reset on `session_start` (per AC-2: session-scoped, no
 *   cross-session memory). The `resetSession` method is the seam; the
 *   `index.ts` `session_start` handler calls it.
 *
 * Purity contract:
 *   - No Pi imports (the engine is a pure-logic state machine).
 *   - The text-parsing helpers are pure functions; the state mutation is
 *     method-bound to the state instance (no module-level globals).
 *   - No I/O. The `applyLifecycleState` helper does not read or write Pi
 *     surfaces — it transforms an in-memory message array.
 */

import { digestToolResult, type DigestibleToolResult } from "./digest.ts";

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * The lifecycle state for a single tool result. The auto-state values
 * (`verbatim` / `digest`) are set by the engine at view time; the agent
 * override values (`kept` / `dropped`) are set by the agent's `keep` /
 * `drop` decision. `retired` is the recency-filter set-excluded state.
 */
export type LifecycleState =
	| "verbatim"
	| "digest"
	| "retired"
	| "kept"
	| "dropped";

/**
 * A single tool-output record: the tool identity + the join key + the
 * turn the output was produced. The state map is keyed on `toolCallId`
 * so every tool result has exactly one record.
 */
export interface ToolOutputRecord {
	/** Tool name (`"read"`, `"bash"`, `"mcp_*"`, etc.). */
	toolName: string;
	/** Tool call id; the join key into the conversation messages. */
	toolCallId: string;
	/**
	 * Tool's primary key:
	 *   - `read`/`write`/`edit` → file path
	 *   - `bash`               → the command string
	 *   - `grep`/`find`        → `<pattern>@<path>`
	 *   - `ls`                 → the path
	 *   - MCP-custom           → the tool id
	 */
	key: string;
	/** Turn index (0-based) at which the tool ran. */
	turnIndex: number;
	/**
	 * The agent's keep/drop override. Absent = no override (auto-state
	 * applies: verbatim-on-producing-turn, digest-after). The agent sets
	 * the override via `setLifecycleOverride`.
	 */
	override?: Exclude<LifecycleState, "verbatim" | "digest" | "retired">;
}

/**
 * The lifecycle state container. Created by `createLifecycleState()`.
 * The instance exposes the records map, the lifecycle mutator methods,
 * and the `applyLifecycleState` helper the `context` handler uses to
 * produce the per-LLM-call view.
 */
export interface LifecycleState {
	/** All tool outputs the agent has produced this session, keyed on `toolCallId`. */
	readonly records: Map<string, ToolOutputRecord>;
	/** Record a new tool result. */
	recordToolResult: (
		toolName: string,
		toolCallId: string,
		key: string,
		turnIndex: number,
	) => void;
	/** Set the agent's keep/drop override on a recorded tool output (keyed by `toolCallId`). */
	setLifecycleOverride: (toolCallId: string, override: "kept" | "dropped") => void;
	/** Look up a record by `toolCallId`. */
	getRecord: (toolCallId: string) => ToolOutputRecord | undefined;
	/** Get the current lifecycle state for a `toolCallId` (default: `verbatim` if no override). */
	getLifecycleState: (toolCallId: string, currentTurn: number) => LifecycleState;
	/** Return the records in turn order (oldest first). */
	getRecordsInOrder: () => ToolOutputRecord[];
	/** Return the set of `toolCallId`s that have a `kept` override. */
	getKeptToolCallIds: () => Set<string>;
	/** Return the set of `toolCallId`s that have a `dropped` override. */
	getDroppedToolCallIds: () => Set<string>;
	/** Reset the state to empty (session-scope reset on `session_start`). */
	resetSession: () => void;
}

/**
 * Conversation-message structural shape. Mirrors the policy's
 * `ConversationMessage` — a minimal `{ role: string; [key: string]: unknown }`
 * shape. The lifecycle engine inspects `role`, `toolCallId`, `age`, and
 * the `details` / `content` shapes; everything else is passed through.
 *
 * For AC-1 (age-scoped view-time digest), the engine reads:
 *   - `role: "toolResult"` — only tool-result messages are candidates
 *   - `age: number` — the turn the result was produced
 *   - `content: ContentBlock[]` — the verbatim tool output (shown when
 *      the result is on its producing turn OR kept)
 *   - `details.digest: string` — the pre-computed digest envelope (shown
 *      when the result is on a later turn and not kept)
 */
export interface LifecycleMessage {
	role: string;
	toolCallId?: string;
	age?: number;
	content?: unknown;
	details?: { digest?: string; [key: string]: unknown };
	[key: string]: unknown;
}

/**
 * The structured tool-result message shape AC-1 names as the contract
 * across all five paths. The five-path contract:
 *   - `tool_result` writes `age`, `content` (verbatim), and `details.digest`.
 *   - `context` reads `age` and picks `content` vs `details.digest`.
 *   - Session persistence stores the full shape.
 *   - `trimConversation` (recency) carves the recency comfort window; the
 *     lifecycle engine then applies the per-message state to that set.
 *   - `applyLifecycleState` (formerly `promoteKeptToolResults`) is the
 *     lifecycle engine's view-time consumer.
 */
export interface ToolResultMessageShape {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	/** The current turn index when the tool result was produced. */
	age: number;
	content: unknown;
	details?: { digest?: string; [key: string]: unknown };
	isError: boolean;
}

// ─── State factory ─────────────────────────────────────────────────────────

/**
 * Create a fresh lifecycle state instance. The instance holds its own
 * Maps (no module-level globals), so tests can construct isolated state
 * without cross-test pollution.
 *
 * The default lifecycle for a newly recorded tool result is `verbatim`
 * on the producing turn and `digest` on every later turn (the age-scoped
 * view-time digest from AC-1). The agent's `keep <key>` override pins
 * the state at `kept`; the agent's `drop <key>` override moves it to
 * `dropped`.
 */
export function createLifecycleState(): LifecycleState {
	const records = new Map<string, ToolOutputRecord>();

	return {
		records,
		recordToolResult(toolName, toolCallId, key, turnIndex) {
			// Re-recording a tool result (e.g. a re-run with the same
			// toolCallId — a re-call) updates the key, turnIndex, and
			// toolName, but PRESERVES the override if one is set. The
			// agent's keep/drop decision survives a re-run — they meant
			// to keep (or drop) the result, not just the snapshot.
			const existing = records.get(toolCallId);
			records.set(toolCallId, {
				toolName,
				toolCallId,
				key,
				turnIndex,
				override: existing?.override,
			});
		},
		setLifecycleOverride(toolCallId, override) {
			const existing = records.get(toolCallId);
			if (!existing) return; // No-op: tool result must have happened first.
			records.set(toolCallId, { ...existing, override });
		},
		getRecord(toolCallId) {
			return records.get(toolCallId);
		},
		getLifecycleState(toolCallId, currentTurn) {
			const record = records.get(toolCallId);
			if (!record) return "retired"; // Unknown tool result → excluded.
			if (record.override === "kept") return "kept";
			if (record.override === "dropped") return "dropped";
			// Auto-state: verbatim on the producing turn, digest on later turns.
			// The `age` was stamped at `tool_result` time; if it equals the
			// current turn, we're on the producing turn. Edge case: a re-run
			// in the same turn (rare; not in scope) would still show verbatim.
			if (record.turnIndex === currentTurn) return "verbatim";
			return "digest";
		},
		getRecordsInOrder() {
			return Array.from(records.values()).sort((a, b) => a.turnIndex - b.turnIndex);
		},
		getKeptToolCallIds() {
			const ids = new Set<string>();
			for (const [id, r] of records) {
				if (r.override === "kept") ids.add(id);
			}
			return ids;
		},
		getDroppedToolCallIds() {
			const ids = new Set<string>();
			for (const [id, r] of records) {
				if (r.override === "dropped") ids.add(id);
			}
			return ids;
		},
		resetSession() {
			records.clear();
		},
	};
}

// ─── Keep/drop parser (text → lifecycle overrides) ────────────────────────

/**
 * Parse keep/drop marks from an agent assistant message. The parser is
 * the agent's affordance surface — it greps the message for two patterns:
 *
 *   `keep <key>`         → set "kept" override for the tool result with that key
 *   `drop <key>`         → set "dropped" override for the tool result with that key
 *
 * Both patterns are case-insensitive and match the first whitespace-
 * bounded token after the keyword. The parser is a pure function
 * (input string + known keys → decisions); the caller wires the
 * decisions into the state via `setLifecycleOverride`.
 *
 * The known-keys filter widens from the file-read set (BACKUP) to the
 * full tool-output set (T-2717): any tool result the engine has
 * recorded is a known key. A `keep /foo/bar` for a tool result the
 * engine has not seen is a no-op (the tool result must have happened
 * first for the override to apply).
 */
export function parseLifecycleMarksFromText(
	text: string,
	knownKeys: ReadonlySet<string>,
): Array<{ key: string; override: "kept" | "dropped" }> {
	const out: Array<{ key: string; override: "kept" | "dropped" }> = [];
	if (!text) return out;

	// Tokenize: split on whitespace, then for each token, check whether
	// the previous word was a keep/drop keyword. Quoted keys (paths with
	// spaces, bash commands with spaces) are reassembled from the next
	// tokens until the matching close-quote.
	const tokens = text.split(/\s+/);
	for (let i = 0; i < tokens.length - 1; i++) {
		const keyword = tokens[i]?.toLowerCase();
		if (keyword !== "keep" && keyword !== "drop") continue;
		// Collect the key: start with the next token, then accumulate
		// additional tokens while the key is unterminated-quote.
		let rawKey = tokens[i + 1] ?? "";
		const openQuote = rawKey.startsWith('"') || rawKey.startsWith("'") ? rawKey[0] : "";
		const startsWithClosingQuote =
			openQuote && rawKey.endsWith(openQuote) && rawKey.length > 1;
		if (openQuote && !startsWithClosingQuote) {
			const collected: string[] = [rawKey];
			for (let j = i + 2; j < tokens.length; j++) {
				const t = tokens[j] ?? "";
				collected.push(t);
				if (t.endsWith(openQuote)) {
					i = j;
					break;
				}
			}
			rawKey = collected.join(" ");
		}
		// Strip a single opening quote.
		if (rawKey.startsWith('"') || rawKey.startsWith("'")) {
			rawKey = rawKey.slice(1);
		}
		// Strip a single closing quote.
		if (rawKey.endsWith('"') || rawKey.endsWith("'")) {
			rawKey = rawKey.slice(0, -1);
		}
		// Strip trailing punctuation that may have been glued to the key.
		rawKey = rawKey.replace(/[.,;:!?)]+$/, "");
		if (!rawKey || !knownKeys.has(rawKey)) continue;
		out.push({ key: rawKey, override: keyword === "keep" ? "kept" : "dropped" });
	}
	return out;
}

// ─── Tool-output digest (the per-tool-output list) ─────────────────────────

/**
 * Build the agent-facing per-turn tool-output digest message. The function
 * returns a string the `before_agent_start` handler passes as the
 * `message.content` field. The format is human-readable and the agent
 * parses it naturally; the LLM does not need a structured format here.
 *
 * The format widens from "Read files in this session" (BACKUP) to
 * "Tool outputs in this session" (T-2717): every tool result the agent
 * has produced, with its `toolName`, `key`, current `lifecycleState`
 * (verbatim / digest / retired / kept / dropped), and the keep/drop
 * affordance instructions. The list is bounded by `maxEntries` (default
 * 50) to avoid an unbounded digest in long sessions. The tail of the
 * list is shown (most recent outputs are most relevant).
 */
export function buildToolOutputDigest(
	state: LifecycleState,
	currentTurn: number,
	maxEntries = 50,
): string {
	const records = state.getRecordsInOrder();
	if (records.length === 0) {
		return "Tool outputs in this session (0): none yet.";
	}
	const total = records.length;
	const start = Math.max(0, total - maxEntries);
	const visible = records.slice(start);

	const lines: string[] = [`Tool outputs in this session (${total}):`];
	for (const r of visible) {
		const lifecycle = state.getLifecycleState(r.toolCallId, currentTurn);
		const mark = lifecycleStateLabel(lifecycle);
		lines.push(`  - [${r.toolName}] ${r.key}  [${mark}]`);
	}
	if (start > 0) {
		lines.push(`  (${start} earlier outputs not shown)`);
	}
	lines.push("To keep an output, reply with:  keep <key>");
	lines.push("To drop an output, reply with:  drop <key>");
	return lines.join("\n");
}

function lifecycleStateLabel(s: LifecycleState): string {
	switch (s) {
		case "verbatim":
			return "verbatim";
		case "digest":
			return "digest";
		case "retired":
			return "retired";
		case "kept":
			return "kept";
		case "dropped":
			return "dropped";
	}
}

// ─── View-time lifecycle engine (the AC-1 + AC-2 consumer) ────────────────

/**
 * Apply the lifecycle state to a conversation message stream. The function
 * is the view-time consumer of the engine: given the policy's
 * `{ retain, trim }` result and the current turn, return a fresh
 * `messages` array where each tool-result message has been replaced with
 * the right per-LLM-call-view shape (verbatim / digest / excluded).
 *
 * Algorithm:
 *   1. For each message in `retain`, if it is a tool-result message and
 *      the lifecycle engine has a record for it, apply the lifecycle:
 *        - `kept`        → leave verbatim content as-is
 *        - `dropped`     → exclude from the view
 *        - `retired`     → exclude from the view (the recency filter
 *                          would have already moved this to `trim`, but
 *                          a message can also be explicitly retired via
 *                          the engine)
 *        - `verbatim`    → leave verbatim content as-is (on producing turn)
 *        - `digest`      → replace `content` with the pre-computed
 *                          `details.digest` (or, if the digest is missing
 *                          because the message was loaded from an old
 *                          session, fall back to a `[digest missing]`
 *                          placeholder so the view stays bounded)
 *   2. The `trim` set is appended to the view as a separate "trimmed
 *      history" indicator? No — the trim set is EXCLUDED from the view
 *      by construction. The function returns just the filtered
 *      `messages` array. The session file preserves both verbatim and
 *      digest; the compactor reads the session, not the view.
 *   3. The order within `retain` is preserved (slices, not rearrangements).
 *
 * The function is pure: it does not mutate `messages` or the state. The
 * output is a fresh array. Union-equals-input invariant: every input
 * message is either in the output (verbatim, digest, or kept) or
 * explicitly excluded (dropped, retired); nothing is lost from the
 * output, nothing is invented.
 */
export function applyLifecycleState(
	messages: ReadonlyArray<LifecycleMessage>,
	state: LifecycleState,
	currentTurn: number,
): LifecycleMessage[] {
	const dropped = state.getDroppedToolCallIds();
	const out: LifecycleMessage[] = [];
	for (const msg of messages) {
		if (msg.role !== "toolResult") {
			// Non-tool-result messages pass through unchanged. The
			// recency filter's role discrimination is the policy's job;
			// the lifecycle engine only acts on tool-result messages.
			out.push(msg);
			continue;
		}
		// Resolve the toolCallId (top-level or `details.toolCallId`).
		const id = extractToolCallId(msg);
		if (!id) {
			// No join key — we cannot apply a lifecycle. Pass through.
			out.push(msg);
			continue;
		}
		if (dropped.has(id)) continue; // Agent `drop <key>` → excluded.
		const lifecycle = state.getLifecycleState(id, currentTurn);
		if (lifecycle === "retired") continue; // Recency-comfort retired.
		if (lifecycle === "kept") {
			// Kept overrides: verbatim regardless of age.
			out.push(msg);
			continue;
		}
		if (lifecycle === "digest") {
			// Swap content to the pre-computed digest.
			const digest = readDigest(msg);
			if (digest === null) {
				// Digest missing (old session, or message loaded without
				// the side-by-side envelope). Fall back to a placeholder
				// so the view stays bounded; the agent can re-request.
				out.push({
					...msg,
					content: [{ type: "text", text: "[digest: missing — re-request to view]" }],
				});
				continue;
			}
			out.push({
				...msg,
				content: [{ type: "text", text: digest }],
			});
			continue;
		}
		// `verbatim` (or unknown) — pass through unchanged.
		out.push(msg);
	}
	return out;
}

/**
 * Extract the `toolCallId` from a tool-result message. The function
 * checks the top-level field first, then falls back to
 * `details.toolCallId` for compatibility with shapes that nest the id.
 */
function extractToolCallId(msg: LifecycleMessage): string | undefined {
	if (typeof msg.toolCallId === "string") return msg.toolCallId;
	const details = msg.details;
	if (details && typeof details.toolCallId === "string") return details.toolCallId;
	return undefined;
}

/**
 * Read the pre-computed digest from a tool-result message. The digest
 * lives in `details.digest` (Shape A — the per-AC tension resolution;
 * see the storage-shape choice rationale in the `index.ts` header).
 * Returns `null` if the digest is missing (old session, message
 * loaded without the side-by-side envelope).
 */
function readDigest(msg: LifecycleMessage): string | null {
	const details = msg.details;
	if (!details || typeof details !== "object") return null;
	const digest = details.digest;
	if (typeof digest !== "string") return null;
	return digest;
}

// ─── Tool-result writer (the AC-1 + AC-2 producer) ────────────────────────

/**
 * Build the `tool_result` event's persisted message envelope: a fresh
 * `toolResult` message carrying both the verbatim `content` and the
 * pre-computed `details.digest`. The handler (`index.ts`) returns the
 * verbatim content as the partial-patch `content` (so Pi's existing
 * `tool_result` flow persists the verbatim output) AND carries the
 * digest alongside in the message it persists.
 *
 * Why a producer function and not a partial-patch return: the AC-1
 * "side-by-side" requirement is *the persisted message carries both
 * payloads*. The partial-patch contract `{ content, details, isError }`
 * is the channel Pi hands the handler — the handler returns the
 * verbatim `content` AND a `details` carrying the digest, so the
 * persisted message naturally has both.
 *
 * This function is pure: it takes a `DigestibleToolResult` and a
 * turn-index stamp and returns the side-by-side envelope. The
 * `index.ts` handler wires the call.
 */
export function buildToolResultEnvelope(
	event: DigestibleToolResult,
	turnIndex: number,
): { content: unknown; details: { digest: string; toolCallId: string; turnIndex: number } } {
	const digest = digestToolResult(event);
	return {
		content: event.content,
		details: {
			digest,
			toolCallId: event.toolCallId,
			turnIndex,
		},
	};
}
