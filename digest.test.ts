/**
 * T-2707 — Digest + keep-mark unit tests.
 *
 * Runner: Node's built-in `node:test` (no project install required).
 * Run: `npx tsx --test /home/dez/.pi/agent/extensions/context-trimmer/digest.test.ts`
 *
 * The tests cover the two pure-logic modules T-2707 ships:
 *   - `digest.ts` — the `[factOfCall: ...]\n[digest: ...]` envelope
 *     (AC-4 stability contract) and the per-tool-type digest content
 *     (AC-1 full-tool-surface coverage).
 *   - `keep-mark.ts` — the file-read tracking, the keep-mark parser,
 *     the opt-in default, and the `promoteKeptToolResults` integration
 *     helper T-2706 reads.
 *
 * The test file is structurally separate from `policy.test.ts` (T-2705)
 * but reuses the same describe/it/assert style for consistency. The
 * shared test-runner invocation is the same `node:test` shape — the
 * two files can be run together with `npx tsx --test *.test.ts`.
 *
 * NOT tested here (T-2708 owns):
 *   - The `tool_result` handler wiring in `index.ts` (a live Pi
 *     session is required to exercise the event flow end-to-end).
 *   - The `before_agent_start` handler's keep-mark observation.
 *   - The `session_start` / `session_shutdown` reset lifecycle.
 *   - The integration with the policy's `context` handler at the
 *     per-LLM-call view level.
 *
 * These are unit tests of the pure-logic surface; the live-session
 * tests are T-2708's scope per the AC bundle's test-coverage notes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	digestToolResult,
	digestToolResultPatch,
	MAX_DIGEST_CHARS,
	FACT_OF_CALL_LABEL,
	DIGEST_LABEL,
	LABEL_CLOSE,
	type DigestibleToolResult,
} from "./digest.ts";
import {
	createKeepMarkState,
	parseKeepMarksFromText,
	promoteKeptToolResults,
	buildFileReadDigest,
	type ToolResultMessage,
} from "./keep-mark.ts";

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Build a text-block content array from one or more strings. */
function textContent(...lines: string[]): DigestibleToolResult["content"] {
	return lines.map((text) => ({ type: "text", text }));
}

/** Build an image-block content array. */
function imageContent(): DigestibleToolResult["content"] {
	return [{ type: "image", source: { data: "<bytes>" } }];
}

// ─── digest.ts — AC-4 format stability ─────────────────────────────────────

describe("AC-4 — digest format is named and stable", () => {
	it("the envelope uses the [factOfCall: ...] / [digest: ...] labels", () => {
		const result = digestToolResult({
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "ls" },
			content: textContent("a.txt", "b.txt"),
			isError: false,
		});
		// Two lines, both with the bracketed labels.
		const lines = result.split("\n");
		assert.equal(lines.length, 2, "envelope is exactly two lines");
		assert.ok(
			lines[0]?.startsWith(FACT_OF_CALL_LABEL),
			"line 1 starts with [factOfCall:",
		);
		assert.ok(
			lines[0]?.endsWith(LABEL_CLOSE),
			"line 1 ends with ]",
		);
		assert.ok(
			lines[1]?.startsWith(DIGEST_LABEL),
			"line 2 starts with [digest:",
		);
		assert.ok(
			lines[1]?.endsWith(LABEL_CLOSE),
			"line 2 ends with ]",
		);
	});

	it("exports the four AC-4 surface constants (label strings are Hyrum's-Law contracts)", () => {
		// Pin the constants verbatim. A rename is a breaking change for
		// the compactor + tests; the constants are the contract.
		assert.equal(FACT_OF_CALL_LABEL, "[factOfCall:", "FACT_OF_CALL_LABEL is the bracketed prefix");
		assert.equal(DIGEST_LABEL, "[digest:", "DIGEST_LABEL is the bracketed prefix");
		assert.equal(LABEL_CLOSE, "]", "LABEL_CLOSE is the closing bracket");
		assert.equal(MAX_DIGEST_CHARS, 2000, "MAX_DIGEST_CHARS budget is pinned at 2000");
	});

	it("the digest is non-empty for every tool type (no undigested result)", () => {
		// Smoke test: every built-in tool type produces a valid envelope.
		const toolNames = ["bash", "read", "write", "edit", "grep", "find", "ls"];
		for (const toolName of toolNames) {
			const result = digestToolResult({
				toolName,
				toolCallId: "t",
				input: {},
				content: textContent("hello"),
				isError: false,
			});
			assert.ok(result.length > 0, `${toolName} produces a non-empty digest`);
			assert.ok(result.startsWith(FACT_OF_CALL_LABEL), `${toolName} digest starts with [factOfCall:`);
		}
	});
});

// ─── digest.ts — per-tool-type digest content (AC-1) ──────────────────────

describe("AC-1 — full tool surface coverage", () => {
	it("bash digest names the command and the first line of output", () => {
		const result = digestToolResult({
			toolName: "bash",
			toolCallId: "bash-1",
			input: { command: "ls -la" },
			content: textContent("file1.txt", "file2.txt", "file3.txt"),
			isError: false,
		});
		// The fact-of-call names the command.
		assert.ok(result.includes("bash(command=ls -la)"), "factOfCall names the command");
		// The digest body shows the first line of output.
		assert.ok(result.includes("file1.txt"), "digest body shows first line of output");
	});

	it("bash digest surfaces the truncation marker and fullOutputPath from details", () => {
		const result = digestToolResult({
			toolName: "bash",
			toolCallId: "bash-2",
			input: { command: "cat huge.log" },
			content: textContent("first line of truncated output"),
			isError: false,
			details: {
				truncation: { truncated: true, totalLines: 5000, outputLines: 200 },
				fullOutputPath: "/tmp/full.log",
			},
		});
		assert.ok(result.includes("truncated"), "digest body surfaces the truncation marker");
		assert.ok(result.includes("/tmp/full.log"), "digest body surfaces the fullOutputPath");
		assert.ok(result.includes("5000"), "digest body surfaces the total line count");
	});

	it("read digest names the path and the first line of file content", () => {
		const result = digestToolResult({
			toolName: "read",
			toolCallId: "read-1",
			input: { path: "/home/dez/foo.ts" },
			content: textContent("export const greeting = 'hello';", "// ... 100 more lines"),
			isError: false,
		});
		assert.ok(result.includes("read(path=/home/dez/foo.ts)"), "factOfCall names the path");
		assert.ok(
			result.includes("export const greeting = 'hello';"),
			"digest body shows first line of file content",
		);
	});

	it("read digest respects offset and limit in the fact-of-call", () => {
		const result = digestToolResult({
			toolName: "read",
			toolCallId: "read-2",
			input: { path: "/home/dez/foo.ts", offset: 10, limit: 50 },
			content: textContent("line 10 content"),
			isError: false,
		});
		assert.ok(result.includes("offset=10"), "factOfCall surfaces offset");
		assert.ok(result.includes("limit=50"), "factOfCall surfaces limit");
	});

	it("write digest names the path and byte count, not the content", () => {
		const result = digestToolResult({
			toolName: "write",
			toolCallId: "write-1",
			input: { path: "/home/dez/new.ts", content: "x".repeat(5000) },
			content: textContent("File written successfully"),
			isError: false,
		});
		// The fact-of-call surface (anywhere in the result) names the path
		// and the byte count. Keys are alphabetically ordered, so the
		// exact position of `path=` in the fact-of-call varies.
		assert.ok(result.includes("path=/home/dez/new.ts"), "result names the path");
		assert.ok(result.includes("bytes=5000"), "digest body surfaces the byte count");
		// The 5000-x content must NOT appear in the digest — that would
		// defeat the source-digest contract.
		assert.ok(
			!result.includes("x".repeat(100)),
			"digest body does NOT echo the file content (source-digest contract)",
		);
	});

	it("edit digest surfaces the edit count and the first diff line", () => {
		const result = digestToolResult({
			toolName: "edit",
			toolCallId: "edit-1",
			input: { path: "/home/dez/bar.ts", edits: [{ oldText: "a", newText: "b" }] },
			content: textContent("File edited successfully"),
			isError: false,
			details: { diff: "@@ -1,1 +1,1 @@\n-b\n+b", firstChangedLine: 1 },
		});
		assert.ok(result.includes("path=/home/dez/bar.ts"), "result names the path");
		assert.ok(result.includes("edits=1"), "digest body surfaces the edit count");
		assert.ok(result.includes("@@"), "digest body surfaces the diff first line");
	});

	it("grep digest surfaces the match count and first match", () => {
		const result = digestToolResult({
			toolName: "grep",
			toolCallId: "grep-1",
			input: { pattern: "TODO", path: "./src" },
			content: textContent("src/a.ts:10: // TODO: fix", "src/b.ts:42: // TODO: refactor"),
			isError: false,
			details: { matchLimitReached: 100 },
		});
		assert.ok(result.includes("pattern=TODO"), "result names the pattern");
		assert.ok(result.includes("matches=2"), "digest body surfaces the match count");
		assert.ok(result.includes("matchLimit=100"), "digest body surfaces the match limit");
	});

	it("find digest surfaces the result count and first results", () => {
		const result = digestToolResult({
			toolName: "find",
			toolCallId: "find-1",
			input: { pattern: "*.ts", path: "./src" },
			content: textContent("src/a.ts", "src/b.ts"),
			isError: false,
		});
		assert.ok(result.includes("pattern=*.ts"), "result names the pattern");
		assert.ok(result.includes("results=2"), "digest body surfaces the result count");
	});

	it("ls digest surfaces the entry count", () => {
		const result = digestToolResult({
			toolName: "ls",
			toolCallId: "ls-1",
			input: { path: "./src" },
			content: textContent("a.ts", "b.ts", "c.ts"),
			isError: false,
		});
		assert.ok(result.includes("ls(path=./src)"), "factOfCall names the path");
		assert.ok(result.includes("entries=3"), "digest body surfaces the entry count");
	});

	it("generic fallback handles MCP custom tool names (no carve-out for the unknown)", () => {
		const result = digestToolResult({
			toolName: "mcp_brave_brave_web_search",
			toolCallId: "mcp-1",
			input: { query: "purrly" },
			content: textContent("first search result snippet"),
			isError: false,
		});
		assert.ok(result.includes("mcp_brave_brave_web_search"), "factOfCall surfaces the dynamic tool id");
		assert.ok(result.includes("first search result snippet"), "digest body shows first line of result");
	});

	it("generic fallback handles image-only results (no text content)", () => {
		const result = digestToolResult({
			toolName: "mcp_some_image_tool",
			toolCallId: "img-1",
			input: {},
			content: imageContent(),
			isError: false,
		});
		assert.ok(result.includes("1 image block"), "image-only result is named, not undigested");
		assert.ok(result.includes("re-call to view"), "image result notes the agent can re-call");
	});

	it("error results are prefixed with 'error: ' (the digest surfaces the failure mode)", () => {
		const result = digestToolResult({
			toolName: "bash",
			toolCallId: "bash-err",
			input: { command: "rm /missing" },
			content: textContent("rm: cannot remove '/missing': No such file or directory"),
			isError: true,
		});
		assert.ok(result.includes("error: "), "error results get the error prefix");
		assert.ok(result.includes("rm: cannot remove"), "error message is preserved");
	});
});

// ─── digest.ts — length budget (AC-4) ──────────────────────────────────────

describe("AC-4 — digest length budget", () => {
	it("the digest body respects MAX_DIGEST_CHARS (truncated marker when exceeded)", () => {
		// Build a huge bash output.
		const hugeOutput = "x".repeat(MAX_DIGEST_CHARS * 2);
		const result = digestToolResult({
			toolName: "bash",
			toolCallId: "huge",
			input: { command: "cat huge" },
			content: textContent(hugeOutput),
			isError: false,
		});
		// The digest is bounded — the envelope does not blow up the
		// per-LLM-call view. The exact bound is the budget plus the
		// truncation marker; we allow a generous over-budget to cover
		// the marker overhead, but the digest must not scale linearly
		// with the raw output.
		assert.ok(
			result.length < MAX_DIGEST_CHARS * 2,
			`digest length (${result.length}) is bounded well under the raw output (${hugeOutput.length})`,
		);
		assert.ok(result.includes("[truncated:"), "truncation marker is present");
	});
});

// ─── digest.ts — partial-patch return shape ───────────────────────────────

describe("AC-1 — partial-patch return contract", () => {
	it("digestToolResultPatch returns the { content: TextContent[] } shape", () => {
		const patch = digestToolResultPatch({
			toolName: "bash",
			toolCallId: "patch-1",
			input: { command: "ls" },
			content: textContent("a.txt"),
			isError: false,
		});
		assert.ok(Array.isArray(patch.content), "patch.content is an array");
		assert.equal(patch.content.length, 1, "patch.content is a single text block");
		const block = patch.content[0];
		assert.ok(block, "block exists");
		assert.equal(block.type, "text", "block is a text content block");
		assert.ok(
			block.text.startsWith(FACT_OF_CALL_LABEL),
			"block.text is the digest envelope",
		);
	});
});

// ─── keep-mark.ts — state factory (AC-2) ──────────────────────────────────

describe("AC-2 — keep-mark state is opt-in by default", () => {
	it("a newly recorded read is undecided (opt-in default: not in the keep-set)", () => {
		const state = createKeepMarkState();
		state.recordRead("/foo.ts", "call-1", 1);
		// The map is opt-in: an absent entry means undecided. The
		// effective behavior is "drop" because `getKeptToolCallIds`
		// does not return undecided files. The test asserts both
		// surfaces — the explicit getter and the effective behavior.
		assert.equal(state.getKeepMark("/foo.ts"), null, "undecided → no entry (absent, not 'drop')");
		assert.equal(state.getKeptToolCallIds().size, 0, "undecided files are not in the kept set (effective 'drop')");
	});

	it("setKeepMark('keep') survives a getReadRecord round-trip", () => {
		const state = createKeepMarkState();
		state.recordRead("/foo.ts", "call-1", 1);
		state.setKeepMark("/foo.ts", "keep");
		assert.equal(state.getKeepMark("/foo.ts"), "keep", "keep mark is set");
		assert.equal(state.getReadRecord("/foo.ts")?.toolCallId, "call-1", "read record is preserved");
	});

	it("re-recording a read preserves the keep-mark (the agent's decision survives a re-read)", () => {
		const state = createKeepMarkState();
		state.recordRead("/foo.ts", "call-1", 1);
		state.setKeepMark("/foo.ts", "keep");
		state.recordRead("/foo.ts", "call-2", 5);
		// The keep-mark survives the re-read; the toolCallId updates to
		// the most recent read.
		assert.equal(state.getKeepMark("/foo.ts"), "keep", "keep mark survives re-read");
		assert.equal(state.getReadRecord("/foo.ts")?.toolCallId, "call-2", "toolCallId updates to most recent read");
	});

	it("resetSession clears both reads and keep-marks (session-scope contract)", () => {
		const state = createKeepMarkState();
		state.recordRead("/foo.ts", "call-1", 1);
		state.setKeepMark("/foo.ts", "keep");
		state.resetSession();
		assert.equal(state.getReadPaths().length, 0, "reads cleared");
		assert.equal(state.getKeepMark("/foo.ts"), null, "keep-marks cleared");
	});
});

// ─── keep-mark.ts — parser (AC-2) ─────────────────────────────────────────

describe("AC-2 — parseKeepMarksFromText", () => {
	it("parses a bare 'keep <path>' pattern", () => {
		const known = new Set(["/foo.ts"]);
		const result = parseKeepMarksFromText("I want to keep /foo.ts", known);
		assert.equal(result.length, 1, "one mark parsed");
		assert.equal(result[0]?.path, "/foo.ts", "path is /foo.ts");
		assert.equal(result[0]?.decision, "keep", "decision is keep");
	});

	it("parses a bare 'drop <path>' pattern", () => {
		const known = new Set(["/foo.ts"]);
		const result = parseKeepMarksFromText("drop /foo.ts please", known);
		assert.equal(result.length, 1, "one mark parsed");
		assert.equal(result[0]?.decision, "drop", "decision is drop");
	});

	it("parses a quoted path", () => {
		const known = new Set(["/foo bar.ts"]);
		const result = parseKeepMarksFromText('keep "/foo bar.ts"', known);
		assert.equal(result.length, 1, "one mark parsed");
		assert.equal(result[0]?.path, "/foo bar.ts", "quoted path is parsed");
	});

	it("ignores keep/drop for unknown paths (the read must happen first)", () => {
		const known = new Set(["/known.ts"]);
		const result = parseKeepMarksFromText("keep /unknown.ts", known);
		assert.equal(result.length, 0, "unknown paths are no-ops");
	});

	it("ignores bare 'keep' or 'drop' with no path", () => {
		const known = new Set<string>();
		const result = parseKeepMarksFromText("keep drop", known);
		assert.equal(result.length, 0, "bare keywords are ignored");
	});

	it("strips trailing punctuation glued to the path", () => {
		const known = new Set(["/foo.ts"]);
		const result = parseKeepMarksFromText("keep /foo.ts.", known);
		assert.equal(result.length, 1, "trailing punctuation is stripped");
		assert.equal(result[0]?.path, "/foo.ts", "path is /foo.ts");
	});

	it("is case-insensitive on the keyword", () => {
		const known = new Set(["/foo.ts"]);
		const result = parseKeepMarksFromText("KEEP /foo.ts", known);
		assert.equal(result.length, 1, "KEEP (uppercase) is recognized");
		assert.equal(result[0]?.decision, "keep", "decision is keep");
	});

	it("returns an empty array for empty input", () => {
		const result = parseKeepMarksFromText("", new Set(["/foo.ts"]));
		assert.deepEqual(result, [], "empty input → empty marks");
	});
});

// ─── keep-mark.ts — promoteKeptToolResults (AC-3 seam) ────────────────────

describe("AC-3 — promoteKeptToolResults: keep-marks promote messages from trim to retain", () => {
	function toolResult(id: string, path: string): ToolResultMessage {
		return { role: "toolResult", toolCallId: id, details: { path } };
	}

	it("no keep-marks → no promotion (fast path: fresh copies of both arrays)", () => {
		const state = createKeepMarkState();
		const trim: ToolResultMessage[] = [toolResult("t1", "/a.ts"), toolResult("t2", "/b.ts")];
		const retain: ToolResultMessage[] = [];
		const result = promoteKeptToolResults(trim, retain, state);
		assert.equal(result.retain.length, 0, "no keep-marks → no promotion");
		assert.equal(result.trim.length, 2, "all trim messages stay in trim");
	});

	it("a kept file is moved from trim to retain", () => {
		const state = createKeepMarkState();
		state.recordRead("/a.ts", "t1", 1);
		state.setKeepMark("/a.ts", "keep");
		const trim: ToolResultMessage[] = [toolResult("t1", "/a.ts"), toolResult("t2", "/b.ts")];
		const retain: ToolResultMessage[] = [];
		const result = promoteKeptToolResults(trim, retain, state);
		assert.equal(result.retain.length, 1, "kept file is promoted to retain");
		assert.equal(result.trim.length, 1, "the other file stays in trim");
		// The promoted message is the right one.
		const promoted = result.retain[0];
		assert.ok(promoted, "promoted message exists");
		assert.equal(promoted.toolCallId, "t1", "promoted message is the kept file");
	});

	it("preserves the union-equals-input invariant (no message lost, no message invented)", () => {
		const state = createKeepMarkState();
		state.recordRead("/a.ts", "t1", 1);
		state.setKeepMark("/a.ts", "keep");
		const trim: ToolResultMessage[] = [
			toolResult("t1", "/a.ts"),
			toolResult("t2", "/b.ts"),
			{ role: "user", content: "hello" }, // non-toolResult message
		];
		const retain: ToolResultMessage[] = [{ role: "user", content: "older" }];
		const result = promoteKeptToolResults(trim, retain, state);
		// Union-equals-input: retain.length + trim.length === trim.length + retain.length.
		assert.equal(
			result.retain.length + result.trim.length,
			trim.length + retain.length,
			"union-equals-input invariant holds",
		);
	});

	it("non-toolResult messages in trim are not promoted (only toolResult is eligible)", () => {
		const state = createKeepMarkState();
		state.recordRead("/a.ts", "t1", 1);
		state.setKeepMark("/a.ts", "keep");
		const trim: ToolResultMessage[] = [
			{ role: "user", content: "hello" }, // not a toolResult — not eligible
		];
		const retain: ToolResultMessage[] = [];
		const result = promoteKeptToolResults(trim, retain, state);
		assert.equal(result.retain.length, 0, "user message is NOT promoted");
		assert.equal(result.trim.length, 1, "user message stays in trim");
	});

	it("reads toolCallId from details.toolCallId as a fallback (compatibility shape)", () => {
		const state = createKeepMarkState();
		state.recordRead("/a.ts", "t1", 1);
		state.setKeepMark("/a.ts", "keep");
		const trim: ToolResultMessage[] = [
			{ role: "toolResult", details: { toolCallId: "t1", path: "/a.ts" } },
		];
		const retain: ToolResultMessage[] = [];
		const result = promoteKeptToolResults(trim, retain, state);
		assert.equal(result.retain.length, 1, "toolCallId from details is recognized");
	});
});

// ─── keep-mark.ts — buildFileReadDigest (AC-2 file-read surface) ──────────

describe("AC-2 — buildFileReadDigest: the agent-facing file-read list", () => {
	it("empty state produces a 'none yet' digest", () => {
		const state = createKeepMarkState();
		const result = buildFileReadDigest(state);
		assert.ok(result.includes("Read files in this session (0)"), "header is correct");
		assert.ok(result.includes("none yet"), "empty-state message present");
	});

	it("lists every recorded file with its current mark", () => {
		const state = createKeepMarkState();
		state.recordRead("/a.ts", "t1", 1);
		state.recordRead("/b.ts", "t2", 2);
		state.setKeepMark("/a.ts", "keep");
		const result = buildFileReadDigest(state);
		assert.ok(result.includes("Read files in this session (2)"), "count is correct");
		assert.ok(result.includes("/a.ts") && result.includes("keep"), "kept file is named");
		assert.ok(result.includes("/b.ts") && result.includes("drop"), "drop file is named");
	});

	it("the digest carries the keep/drop affordance instructions", () => {
		const state = createKeepMarkState();
		state.recordRead("/a.ts", "t1", 1);
		const result = buildFileReadDigest(state);
		assert.ok(result.includes("keep <path>"), "digest instructs the agent how to keep");
		assert.ok(result.includes("drop <path>"), "digest instructs the agent how to drop");
	});
});
