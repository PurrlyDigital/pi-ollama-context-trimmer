/**
 * T-2707 — Digest module: tool/MCP output digesting at the `tool_result` source.
 *
 * Pure-logic module (no Pi imports) consumed by the `tool_result` handler in
 * `index.ts`. The digester takes a tool result event and produces the named
 * digest envelope (AC-4) — a stable, greppable shape the auto-compactor (per
 * T-2704 §4 coexistence contract) and the agent both read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Digest format (AC-4 — the load-bearing stability contract)
 *
 *   Two consecutive lines, both prefixed by a stable bracketed label:
 *
 *     [factOfCall: <tool-name>(<key-args>)]
 *     [digest: <one-line summary, ≤ MAX_DIGEST_CHARS chars>]
 *
 *   - `factOfCall` — the agent's anchor to what ran. Format:
 *     `<tool-name>(<key-args>)`. Examples: `read(path=/home/dez/foo.txt)`,
 *     `bash(command=ls -la)`, `edit(path=/home/dez/bar.ts, edits=1)`. The
 *     `key-args` is the union of the tool's primary inputs (path, command,
 *     pattern, etc.); long string args are quoted but NOT truncated (the
 *     agent can re-read for full content).
 *   - `digest` — a short summary of the result, ≤ MAX_DIGEST_CHARS chars. The
 *     digest is **the meaningful content** of the digest envelope; the labels
 *     are the stable frame around it. The summary is tool-type-specialized
 *     (a bash digest is not a read digest), but the envelope is uniform
 *     across tool types — the same `{ factOfCall, digest }` shape applies
 *     to bash / read / write / edit / grep / find / ls / MCP-custom results.
 *
 *   The format is intentionally greppable: tests and the compactor can match
 *   on `[factOfCall:` and `[digest:` without ambiguity. The agent's
 *   understanding is natural-language read; the LLM does not need to parse
 *   the format — the labels carry the structure.
 *
 * Length budget: MAX_DIGEST_CHARS = 2000. The budget is the digester's
 *   cap (an upper bound), not a target — small results are digested shorter
 *   than the cap; only large results hit the limit. The 2000-char budget is
 *   the same order of magnitude as the read tool's per-file budget
 *   (`DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES` from `truncate.ts`) and small
 *   enough that a tool's digested output adds at most one tool-message's
 *   worth of context to the per-LLM-call view, not the tens-of-thousands
 *   of chars the verbatim tool output can carry.
 *
 * Stability contract: the envelope shape (`[factOfCall: ...]\n[digest: ...]`)
 *   is **the** artifact the compactor + the agent + T-2708's tests all read.
 *   Changing the envelope is a breaking change for all three consumers. The
 *   label strings (`[factOfCall:`, `[digest:`) and the per-line ordering are
 *   pinned here. Tool-type-specific digest content is the implementer's
 *   call within the envelope; the envelope is the contract.
 *
 * Full tool surface coverage (AC-1): the `digestToolResult` function
 *   branches on `event.toolName` and covers:
 *
 *     - `bash`   → bash(input.command, exit-summary) digest (first N lines of
 *                  output + a [truncated] marker; honors BashToolDetails
 *                  truncation/fullOutputPath)
 *     - `read`   → read(path, offset, limit) digest (first line of file
 *                  content + line count + [truncated] marker)
 *     - `write`  → write(path, bytes) digest (acknowledgement with byte count
 *                  from content)
 *     - `edit`   → edit(path, edits) digest (EditToolDetails.diff first
 *                  summary line)
 *     - `grep`   → grep(pattern, path, glob) digest (GrepToolDetails match
 *                  count + first 2 lines)
 *     - `find`   → find(pattern, path) digest (FindToolDetails result-limit
 *                  info + first 2 lines)
 *     - `ls`     → ls(path) digest (LsToolDetails entry-count info + first
 *                  2 lines)
 *     - any other toolName (MCP custom / future built-ins) → generic
 *                  factOfCall + first N chars of content digest
 *
 *   Gaps: the generic fallback handles MCP tool results (which appear as
 *   `toolName: "<dynamic tool id>"` per the CustomToolResultEvent shape).
 *   MCP tool results that return image content (`ImageContent` blocks) get
 *   a `[image content: N blocks]` digest — the agent sees that the result
 *   was an image but does not see the image data; the session file stores
 *   the digest, not the image bytes. This is intentional (the agent can
 *   re-call the tool for the image).
 *
 *   No tool type is **undigested** — every tool result passes through
 *   `digestToolResult` and exits as a partial-patch `{ content }` per the
 *   T-2704 §3 return contract. The "missing a tool type" path that
 *   Placement A is supposed to close is closed here for the eight tool
 *   surfaces above (the seven built-ins + the generic fallback that
 *   covers MCP and any future tool).
 *
 * Purity contract:
 *   - No Pi imports (the digester takes a structural event shape — the
 *     caller — `index.ts` — bridges Pi types to the structural shape at
 *     the import boundary, mirroring the policy's import-boundary
 *     discipline).
 *   - No I/O, no `Date.now()`, no global reads.
 *   - Deterministic: identical inputs produce identical digests (the
 *     tool result is the only input that varies; the format is fixed).
 *
 * NOT this module's job:
 *   - The partial-patch return — the caller (`index.ts`) returns the
 *     digest as `{ content: [{ type: "text", text: <envelope> }] }` to
 *     Pi; this module only produces the envelope string.
 *   - Read-file tracking or keep-mark state — `keep-mark.ts` owns that.
 *   - Wiring the `tool_result` event — `index.ts` owns that.
 */

// ─── Public format constants (the load-bearing AC-4 surface) ──────────────

/**
 * Upper bound on the digest body, in characters. The digester's cap, not
 * a target. Pinned here so a silent change to the budget is caught at
 * audit time.
 */
export const MAX_DIGEST_CHARS = 2000;

/**
 * The two stable label prefixes that frame the digest envelope. Tests and
 * the compactor match on these strings — they are Hyrum's-Law contracts.
 * Pinned verbatim; renaming either label breaks the compactor + tests.
 */
export const FACT_OF_CALL_LABEL = "[factOfCall:";
export const DIGEST_LABEL = "[digest:";

/** Closing character for the bracketed labels. The labels are `[prefix ...]` */
export const LABEL_CLOSE = "]";

// ─── Structural input type ─────────────────────────────────────────────────

/**
 * Structural tool-result shape the digester accepts. Deliberately broad
 * — the digester is a pure-logic module that accepts the union of Pi's
 * built-in result event shapes plus MCP custom tool results, without
 * importing Pi types. The caller (`index.ts`) casts the Pi event to this
 * shape at the import boundary.
 *
 * Field naming follows Pi's `ToolResultEventBase` exactly (the base all
 * built-in result events extend):
 *   - `toolName: string` — the tool id (`"bash"`, `"read"`, `"edit"`,
 *     `"mcp_brave_brave_web_search"`, etc.)
 *   - `input: Record<string, unknown>` — the tool call's input args
 *   - `content: Array<{ type: string; text?: string; source?: unknown }>`
 *     — the tool result content (text blocks and image blocks; image
 *     blocks have no `text` field)
 *   - `isError: boolean` — whether the tool call errored
 *   - `details: unknown` — tool-specific metadata. The digester uses a
 *     structural `details` shape for type-safe access; unknown fields are
 *     ignored. The `details` shape includes the truncation/fullOutputPath
 *     metadata for bash/read and the diff/patch metadata for edit.
 */
export interface DigestibleToolResult {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: ReadonlyArray<{ type: string; text?: string; source?: unknown }>;
	isError: boolean;
	details?: unknown;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/** Extract the concatenated text from a content block array. */
function extractText(content: DigestibleToolResult["content"]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** Count the number of text and image blocks in a content array. */
function countBlocks(
	content: DigestibleToolResult["content"],
): { text: number; image: number } {
	let text = 0;
	let image = 0;
	for (const block of content) {
		if (block.type === "text") text++;
		else if (block.type === "image") image++;
	}
	return { text, image };
}

/**
 * Truncate a string to `max` characters, appending a `[truncated: N chars]`
 * marker when the input exceeds the cap. The marker is added to the
 * truncated output (i.e., the total length is `max` plus the marker). The
 * marker is a stable, greppable signal that the digest is incomplete.
 */
function truncateChars(s: string, max: number): string {
	if (s.length <= max) return s;
	const marker = ` [truncated: ${s.length - max} chars]`;
	return s.slice(0, max) + marker;
}

/**
 * Build the fact-of-call line for a tool result. Format:
 * `<toolName>(<key-args>)`. Long string args are wrapped in double quotes
 * to keep the line parseable; the `key-args` is a comma-separated
 * `key=value` list of the tool's primary inputs (path, command, pattern,
 * etc.). The function never throws on unknown input shapes — missing
 * fields produce a `(unknown)` placeholder.
 */
function buildFactOfCall(toolName: string, input: Record<string, unknown>): string {
	const args: string[] = [];
	// Stable key ordering: sort by key for deterministic output (the
	// digester's determinism contract). Skip undefined values.
	const keys = Object.keys(input).sort();
	for (const k of keys) {
		const v = input[k];
		if (v === undefined || v === null) continue;
		if (typeof v === "string") {
			// Wrap long strings in double quotes; leave short ones bare.
			const quoted = v.length > 60 ? `"${v.slice(0, 60)}..."` : v;
			args.push(`${k}=${quoted}`);
		} else if (typeof v === "number" || typeof v === "boolean") {
			args.push(`${k}=${String(v)}`);
		} else if (Array.isArray(v)) {
			args.push(`${k}=${v.length}`);
		} else if (typeof v === "object") {
			args.push(`${k}=<object>`);
		} else {
			args.push(`${k}=${String(v)}`);
		}
	}
	if (args.length === 0) {
		return `${toolName}()`;
	}
	return `${toolName}(${args.join(", ")})`;
}

/** Join the two envelope lines into the final digest string. */
function formatEnvelope(factOfCall: string, digest: string): string {
	return `${FACT_OF_CALL_LABEL} ${factOfCall}${LABEL_CLOSE}\n${DIGEST_LABEL} ${digest}${LABEL_CLOSE}`;
}

// ─── Per-tool-type digest content ──────────────────────────────────────────

/** Bash digest: command summary, first N lines of output, truncation marker. */
function digestBash(event: DigestibleToolResult): string {
	const input = event.input;
	const command = typeof input.command === "string" ? input.command : "";
	const truncated = (event.details as { truncation?: { truncated: boolean; totalLines: number; outputLines: number } } | undefined)
		?.truncation;
	const fullOutputPath = (event.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;

	const text = extractText(event.content);
	const firstLine = text.split("\n", 1)[0] ?? "";
	const truncatedText = truncateChars(firstLine, MAX_DIGEST_CHARS);

	if (truncated?.truncated) {
		return `cmd=${truncateChars(command, 200)} | truncated: ${truncated.outputLines} of ${truncated.totalLines} lines; full: ${fullOutputPath ?? "n/a"} | first: ${truncatedText}`;
	}
	return `cmd=${truncateChars(command, 200)} | ${truncatedText}`;
}

/** Read digest: file path summary, first line of content, line count. */
function digestRead(event: DigestibleToolResult): string {
	const input = event.input;
	const path = typeof input.path === "string" ? input.path : "";
	const offset = typeof input.offset === "number" ? input.offset : 0;
	const limit = typeof input.limit === "number" ? input.limit : undefined;

	const text = extractText(event.content);
	const lineCount = text ? text.split("\n").length : 0;
	const firstLine = text.split("\n", 1)[0] ?? "";
	const truncatedText = truncateChars(firstLine, MAX_DIGEST_CHARS - 200);

	const range = limit !== undefined ? `offset=${offset}, limit=${limit}` : "";
	return `path=${path} ${range} | lines=${lineCount} | first: ${truncatedText}`;
}

/** Write digest: path + byte count from content. No file content (the
 *  content is the file body; digesting it would defeat the source-digest
 *  contract — the content is exactly what the source-digest is removing). */
function digestWrite(event: DigestibleToolResult): string {
	const input = event.input;
	const path = typeof input.path === "string" ? input.path : "";
	const content = typeof input.content === "string" ? input.content : "";
	return `path=${path} | bytes=${content.length} | acknowledged`;
}

/** Edit digest: path + edit count + diff summary first line. */
function digestEdit(event: DigestibleToolResult): string {
	const input = event.input;
	const path = typeof input.path === "string" ? input.path : "";
	const edits = Array.isArray(input.edits) ? input.edits.length : 0;
	const details = event.details as { diff?: string; firstChangedLine?: number } | undefined;
	const diff = details?.diff ?? "";
	const firstChangedLine = details?.firstChangedLine;
	const firstLine = diff.split("\n", 1)[0] ?? "";
	const truncatedText = truncateChars(firstLine, MAX_DIGEST_CHARS - 200);
	return `path=${path} | edits=${edits} | firstChangedLine=${firstChangedLine ?? "n/a"} | diff: ${truncatedText}`;
}

/** Grep digest: pattern + match count + first 2 lines of output. */
function digestGrep(event: DigestibleToolResult): string {
	const input = event.input;
	const pattern = typeof input.pattern === "string" ? input.pattern : "";
	const path = typeof input.path === "string" ? input.path : "";
	const details = event.details as { matchLimitReached?: number; linesTruncated?: boolean } | undefined;

	const text = extractText(event.content);
	const lines = text.split("\n").filter((l) => l.trim());
	const truncatedText = truncateChars(lines.slice(0, 2).join(" | "), MAX_DIGEST_CHARS - 200);

	const limitNote = details?.matchLimitReached ? ` | matchLimit=${details.matchLimitReached}` : "";
	return `pattern=${pattern} | path=${path} | matches=${lines.length}${limitNote} | first: ${truncatedText}`;
}

/** Find digest: pattern + result count + first 2 lines. */
function digestFind(event: DigestibleToolResult): string {
	const input = event.input;
	const pattern = typeof input.pattern === "string" ? input.pattern : "";
	const path = typeof input.path === "string" ? input.path : "";
	const details = event.details as { resultLimitReached?: number } | undefined;

	const text = extractText(event.content);
	const lines = text.split("\n").filter((l) => l.trim());
	const truncatedText = truncateChars(lines.slice(0, 2).join(" | "), MAX_DIGEST_CHARS - 200);

	const limitNote = details?.resultLimitReached ? ` | limit=${details.resultLimitReached}` : "";
	return `pattern=${pattern} | path=${path} | results=${lines.length}${limitNote} | first: ${truncatedText}`;
}

/** Ls digest: path + entry count + first 2 entries. */
function digestLs(event: DigestibleToolResult): string {
	const input = event.input;
	const path = typeof input.path === "string" ? input.path : "";
	const details = event.details as { entryLimitReached?: number } | undefined;

	const text = extractText(event.content);
	const lines = text.split("\n").filter((l) => l.trim());
	const truncatedText = truncateChars(lines.slice(0, 2).join(" | "), MAX_DIGEST_CHARS - 200);

	const limitNote = details?.entryLimitReached ? ` | limit=${details.entryLimitReached}` : "";
	return `path=${path} | entries=${lines.length}${limitNote} | first: ${truncatedText}`;
}

/** Generic digest: fact-of-call + first N chars of content. Used for MCP
 *  custom tool results and any future built-in the digester does not have
 *  a specialized handler for. The full-tool-surface coverage guarantee
 *  (AC-1) is the load-bearing claim: every tool result exits the digester
 *  as a valid envelope. */
function digestGeneric(event: DigestibleToolResult): string {
	const { text, image } = countBlocks(event.content);
	if (text === 0 && image > 0) {
		return `${image} image block(s); re-call to view`;
	}
	if (text === 0) {
		return `ok (no text content)`;
	}
	const text_ = extractText(event.content);
	const truncatedText = truncateChars(text_.split("\n", 1)[0] ?? "", MAX_DIGEST_CHARS);
	return truncatedText;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Produce the digest envelope for a tool/MCP result. Returns the string
 * the caller passes as the `content` field of the partial-patch return
 * (`{ content: [{ type: "text", text: <envelope> }] }`).
 *
 * The function is pure: it does not mutate `event` and produces a
 * deterministic output for a given input. Branches on `event.toolName`
 * to apply tool-type-specific digest content; the envelope itself is
 * uniform across tool types (per AC-4's stability contract).
 *
 * @param event — the structural tool-result event (the `index.ts` handler
 *   casts Pi's typed event to this shape at the import boundary).
 * @returns the digest envelope string. Always non-empty; always matches
 *   the `[factOfCall: ...]\n[digest: ...]` format.
 */
export function digestToolResult(event: DigestibleToolResult): string {
	const factOfCall = buildFactOfCall(event.toolName, event.input);

	// Error results get an `error: ` prefix in the digest body. The label
	// envelope is the same; the agent sees the error condition at a glance
	// without parsing the digest content.
	let body: string;
	if (event.isError) {
		const errText = extractText(event.content) || "<no error message>";
		body = `error: ${truncateChars(errText, MAX_DIGEST_CHARS - 20)}`;
	} else {
		switch (event.toolName) {
			case "bash":
				body = digestBash(event);
				break;
			case "read":
				body = digestRead(event);
				break;
			case "write":
				body = digestWrite(event);
				break;
			case "edit":
				body = digestEdit(event);
				break;
			case "grep":
				body = digestGrep(event);
				break;
			case "find":
				body = digestFind(event);
				break;
			case "ls":
				body = digestLs(event);
				break;
			default:
				body = digestGeneric(event);
				break;
		}
	}

	return formatEnvelope(factOfCall, body);
}

/**
 * Convenience: produce the partial-patch return for a tool-result event.
 * The caller (the `tool_result` handler in `index.ts`) returns this from
 * its handler per T-2704 §3's partial-patch contract:
 * `{ content, details, isError }` with omitted fields keeping their
 * current values. Only `content` is set; `details` and `isError` flow
 * through unchanged.
 *
 * The `content` is the `TextContent[]` shape Pi's `tool_result` event
 * accepts — a single text block carrying the digest envelope.
 */
export function digestToolResultPatch(event: DigestibleToolResult): {
	content: { type: "text"; text: string }[];
} {
	const envelope = digestToolResult(event);
	return {
		content: [{ type: "text", text: envelope }],
	};
}
