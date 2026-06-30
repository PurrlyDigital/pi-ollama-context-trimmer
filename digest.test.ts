/**
 * T-2717 — Digest + lifecycle unit tests.
 *
 * Runner: Node's built-in `node:test` (no project install required).
 * Run: `node --experimental-strip-types --test digest.test.ts`
 *
 * The tests cover the two pure-logic modules T-2717 ships at the
 * digest + lifecycle layer:
 *   - `digest.ts` — the `[factOfCall: ...]\n[digest: ...]` envelope
 *     (stability contract; the envelope is what the lifecycle engine
 *     stores in `details.digest` and the view-time handler swaps into
 *     the per-LLM-call view on later turns).
 *   - `lifecycle-state.ts` — the unified keep/digest/retire engine
 *     over all tool outputs (replaces the T-2707 `keep-mark.ts`
 *     file-read-only surface). Covers state, the parser, the
 *     apply-at-view-time engine, and the side-by-side envelope
 *     writer (`buildToolResultEnvelope`).
 *
 * The test file is structurally separate from `policy.test.ts` and
 * `integration.test.ts` but reuses the same describe/it/assert style
 * for consistency.
 *
 * NOT tested here (`integration.test.ts` owns):
 *   - The `tool_result` handler wiring in `index.ts` (a live Pi
 *     session is required to exercise the event flow end-to-end).
 *   - The `context` handler's view-time age-scope + lifecycle
 *     composition.
 *   - The pinned-tier injection.
 *   - The session-persistence path (the compactor's view).
 *
 * These are unit tests of the pure-logic surface; the live-session
 * tests are `integration.test.ts`'s scope.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	digestToolResult,
	MAX_DIGEST_CHARS,
	FACT_OF_CALL_LABEL,
	DIGEST_LABEL,
	LABEL_CLOSE,
	type DigestibleToolResult,
} from "./digest.ts";
import {
	createLifecycleState,
	parseLifecycleMarksFromText,
	applyLifecycleState,
	buildToolOutputDigest,
	buildToolResultEnvelope,
	type LifecycleMessage,
} from "./lifecycle-state.ts";

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Build a text-block content array from one or more strings. */
function textContent(...lines: string[]): DigestibleToolResult["content"] {
	return lines.map((text) => ({ type: "text", text }));
}

/** Build an image-block content array. */
function imageContent(): DigestibleToolResult["content"] {
	return [{ type: "image", source: { data: "<bytes>" } }];
}

// ─── digest.ts — format stability ──────────────────────────────────────────

describe("digest — format is named and stable", () => {
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

	it("exports the format surface constants (label strings are Hyrum's-Law contracts)", () => {
		// Pin the constants verbatim. A rename is a breaking change for
		// the agent + tests; the constants are the contract.
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

// ─── digest.ts — per-tool-type digest content ──────────────────────────────

describe("digest — full tool surface coverage", () => {
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

// ─── digest.ts — length budget ─────────────────────────────────────────────

describe("digest — length budget", () => {
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

// ─── lifecycle-state.ts — state factory ────────────────────────────────────

describe("lifecycle — state is the unified engine over all tool outputs", () => {
	it("recordToolResult records every tool output with a unique toolCallId", () => {
		const state = createLifecycleState();
		state.recordToolResult("read", "tc-r1", "/foo.ts", 1, 0);
		state.recordToolResult("bash", "tc-b1", "ls -la", 2, 0);
		state.recordToolResult("grep", "tc-g1", "TODO@./src", 3, 0);
		assert.equal(state.records.size, 3, "every tool output gets a record");
		assert.equal(state.getRecord("tc-r1")?.toolName, "read", "read record is preserved");
		assert.equal(state.getRecord("tc-b1")?.key, "ls -la", "bash key is the command");
		assert.equal(state.getRecord("tc-g1")?.key, "TODO@./src", "grep key is pattern@path");
	});

	it("auto-state: verbatim on the producing turn, digest on later turns", () => {
		const state = createLifecycleState();
		state.recordToolResult("read", "tc-1", "/foo.ts", 2, 0);
		// The current turn is 5: the tool was produced on turn 2,
		// which is a previous turn → state is `digest`.
		assert.equal(state.getLifecycleState("tc-1", 5), "digest", "prior turn → digest");
		// On the producing turn (2): state is `verbatim`.
		assert.equal(state.getLifecycleState("tc-1", 2), "verbatim", "producing turn → verbatim");
	});

	it("agent `kept` override pins state at `kept` regardless of age", () => {
		const state = createLifecycleState();
		state.recordToolResult("read", "tc-1", "/foo.ts", 2, 0);
		state.setLifecycleOverride("tc-1", "kept");
		assert.equal(state.getLifecycleState("tc-1", 5), "kept", "kept override pins state regardless of turn");
		assert.equal(state.getLifecycleState("tc-1", 2), "kept", "kept override pins state on producing turn too");
		assert.equal(state.getKeptToolCallIds().size, 1, "kept set is populated");
	});

	it("agent `dropped` override excludes the result from the per-LLM-call view", () => {
		const state = createLifecycleState();
		state.recordToolResult("read", "tc-1", "/foo.ts", 2, 0);
		state.setLifecycleOverride("tc-1", "dropped");
		assert.equal(state.getLifecycleState("tc-1", 5), "dropped", "dropped override excludes the result");
		assert.equal(state.getLifecycleState("tc-1", 2), "dropped", "dropped override excludes on producing turn too");
		assert.equal(state.getDroppedToolCallIds().size, 1, "dropped set is populated");
	});

	it("re-recording a tool result preserves the override (the agent's decision survives a re-run)", () => {
		const state = createLifecycleState();
		state.recordToolResult("read", "tc-1", "/foo.ts", 2, 0);
		state.setLifecycleOverride("tc-1", "kept");
		state.recordToolResult("read", "tc-1", "/foo.ts", 5, 0);
		// The override survives the re-record; the turn updates to 5.
		assert.equal(state.getLifecycleState("tc-1", 5), "kept", "override survives re-record");
		assert.equal(state.getRecord("tc-1")?.turnIndex, 5, "turnIndex updates to most recent record");
	});

	it("unknown toolCallId returns `retired` (excluded from the view)", () => {
		const state = createLifecycleState();
		assert.equal(state.getLifecycleState("unknown", 5), "retired", "unknown toolCallId → retired");
	});

	it("resetSession clears the records (session-scope contract)", () => {
		const state = createLifecycleState();
		state.recordToolResult("read", "tc-1", "/foo.ts", 2, 0);
		state.setLifecycleOverride("tc-1", "kept");
		state.resetSession();
		assert.equal(state.records.size, 0, "records cleared on reset");
		assert.equal(state.getKeptToolCallIds().size, 0, "kept set cleared on reset");
	});
});

// ─── lifecycle-state.ts — parser (AC-2 — agent keep/drop affordance) ───────

describe("lifecycle — parseLifecycleMarksFromText", () => {
	it("parses a bare 'keep <key>' pattern", () => {
		const known = new Set(["/foo.ts"]);
		const result = parseLifecycleMarksFromText("I want to keep /foo.ts", known);
		assert.equal(result.length, 1, "one mark parsed");
		assert.equal(result[0]?.key, "/foo.ts", "key is /foo.ts");
		assert.equal(result[0]?.override, "kept", "override is kept");
	});

	it("parses a bare 'drop <key>' pattern", () => {
		const known = new Set(["/foo.ts"]);
		const result = parseLifecycleMarksFromText("drop /foo.ts please", known);
		assert.equal(result.length, 1, "one mark parsed");
		assert.equal(result[0]?.override, "dropped", "override is dropped");
	});

	it("parses a quoted key (paths with spaces, bash commands with spaces)", () => {
		const known = new Set(["/foo bar.ts"]);
		const result = parseLifecycleMarksFromText('keep "/foo bar.ts"', known);
		assert.equal(result.length, 1, "one mark parsed");
		assert.equal(result[0]?.key, "/foo bar.ts", "quoted key is parsed");
	});

	it("parses a bash-command key (the key is the command string, not a path)", () => {
		// Bash commands typically contain spaces, so the agent must
		// quote them in the keep/drop affordance. The parser handles
		// quoted multi-word keys.
		const known = new Set(["ls -la /tmp"]);
		const result = parseLifecycleMarksFromText('keep "ls -la /tmp"', known);
		assert.equal(result.length, 1, "one mark parsed");
		assert.equal(result[0]?.key, "ls -la /tmp", "command key is parsed");
	});

	it("ignores keep/drop for unknown keys (the tool result must happen first)", () => {
		const known = new Set(["/known.ts"]);
		const result = parseLifecycleMarksFromText("keep /unknown.ts", known);
		assert.equal(result.length, 0, "unknown keys are no-ops");
	});

	it("ignores bare 'keep' or 'drop' with no key", () => {
		const known = new Set<string>();
		const result = parseLifecycleMarksFromText("keep drop", known);
		assert.equal(result.length, 0, "bare keywords are ignored");
	});

	it("strips trailing punctuation glued to the key", () => {
		const known = new Set(["/foo.ts"]);
		const result = parseLifecycleMarksFromText("keep /foo.ts.", known);
		assert.equal(result.length, 1, "trailing punctuation is stripped");
		assert.equal(result[0]?.key, "/foo.ts", "key is /foo.ts");
	});

	it("is case-insensitive on the keyword", () => {
		const known = new Set(["/foo.ts"]);
		const result = parseLifecycleMarksFromText("KEEP /foo.ts", known);
		assert.equal(result.length, 1, "KEEP (uppercase) is recognized");
		assert.equal(result[0]?.override, "kept", "override is kept");
	});

	it("returns an empty array for empty input", () => {
		const result = parseLifecycleMarksFromText("", new Set(["/foo.ts"]));
		assert.deepEqual(result, [], "empty input → empty marks");
	});
});

// ─── lifecycle-state.ts — applyLifecycleState (AC-1 view-time engine) ─────

describe("lifecycle — applyLifecycleState (the view-time consumer)", () => {
	function toolResultMessage(
		toolCallId: string,
		age: number,
		verbatim: string,
		digest: string,
	): LifecycleMessage {
		return {
			role: "toolResult",
			toolCallId,
			age,
			content: [{ type: "text", text: verbatim }],
			details: { digest },
		};
	}

	it("on the producing turn (age === currentTurn): content is verbatim", () => {
		const state = createLifecycleState();
		state.recordToolResult("bash", "tc-1", "ls", 2, 0);
		const messages = [
			toolResultMessage("tc-1", 2, "VERBATIM_OUTPUT", "DIGEST_OUTPUT"),
		];
		const result = applyLifecycleState(messages, state, 2, 0, Infinity, Infinity);
		assert.equal(result.length, 1, "message preserved");
		const content = (result[0]?.content as Array<{ text: string }>)[0]?.text;
		assert.equal(content, "VERBATIM_OUTPUT", "producing turn → verbatim");
	});

	it("on a later turn (age < currentTurn): content is swapped to digest", () => {
		const state = createLifecycleState();
		state.recordToolResult("bash", "tc-1", "ls", 2, 0);
		const messages = [
			toolResultMessage("tc-1", 2, "VERBATIM_OUTPUT", "DIGEST_OUTPUT"),
		];
		const result = applyLifecycleState(messages, state, 5, 0, Infinity, Infinity);
		const content = (result[0]?.content as Array<{ text: string }>)[0]?.text;
		assert.equal(content, "DIGEST_OUTPUT", "later turn → digest");
	});

	it("`kept` override: content stays verbatim regardless of turn", () => {
		const state = createLifecycleState();
		state.recordToolResult("bash", "tc-1", "ls", 2, 0);
		state.setLifecycleOverride("tc-1", "kept");
		const messages = [
			toolResultMessage("tc-1", 2, "VERBATIM_OUTPUT", "DIGEST_OUTPUT"),
		];
		const result = applyLifecycleState(messages, state, 5, 0, Infinity, Infinity);
		const content = (result[0]?.content as Array<{ text: string }>)[0]?.text;
		assert.equal(content, "VERBATIM_OUTPUT", "kept → verbatim regardless of age");
	});

	it("`dropped` override: message is excluded from the view", () => {
		const state = createLifecycleState();
		state.recordToolResult("bash", "tc-1", "ls", 2, 0);
		state.setLifecycleOverride("tc-1", "dropped");
		const messages = [
			toolResultMessage("tc-1", 2, "VERBATIM_OUTPUT", "DIGEST_OUTPUT"),
		];
		const result = applyLifecycleState(messages, state, 5, 0, Infinity, Infinity);
		assert.equal(result.length, 0, "dropped → excluded");
	});

	it("non-tool-result messages pass through unchanged", () => {
		const state = createLifecycleState();
		const userMsg: LifecycleMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
		const result = applyLifecycleState([userMsg], state, 5, 0, Infinity, Infinity);
		assert.equal(result.length, 1, "user message preserved");
		assert.equal(result[0], userMsg, "user message is the same reference");
	});

	it("digest-missing fallback: a placeholder is shown so the view stays bounded", () => {
		const state = createLifecycleState();
		state.recordToolResult("bash", "tc-1", "ls", 2, 0);
		// Message WITHOUT details.digest (old session, message loaded
		// without the side-by-side envelope).
		const msg: LifecycleMessage = {
			role: "toolResult",
			toolCallId: "tc-1",
			age: 2,
			content: [{ type: "text", text: "VERBATIM_OUTPUT" }],
			// details absent
		};
		const result = applyLifecycleState([msg], state, 5, 0, Infinity, Infinity);
		const content = (result[0]?.content as Array<{ text: string }>)[0]?.text;
		assert.ok(content?.includes("digest: missing") ?? false, "missing digest → placeholder, not raw content");
	});
});

// ─── lifecycle-state.ts — buildToolOutputDigest (AC-2 per-tool digest) ────

describe("lifecycle — buildToolOutputDigest (the agent-facing list)", () => {
	it("empty state produces a 'none yet' digest", () => {
		const state = createLifecycleState();
		const result = buildToolOutputDigest(state, 0);
		assert.ok(result.includes("Tool outputs in this session (0)"), "header is correct");
		assert.ok(result.includes("none yet"), "empty-state message present");
	});

	it("lists every recorded tool output with its current state", () => {
		const state = createLifecycleState();
		state.recordToolResult("read", "tc-1", "/a.ts", 1, 0);
		state.recordToolResult("bash", "tc-2", "ls -la", 2, 0);
		state.setLifecycleOverride("tc-1", "kept");
		// currentTurn = 2: tc-1 is on turn 1 (digest), tc-2 is on turn 2 (verbatim)
		const result = buildToolOutputDigest(state, 2);
		assert.ok(result.includes("Tool outputs in this session (2)"), "count is correct");
		assert.ok(result.includes("[read] /a.ts") && result.includes("kept"), "read result is named and kept");
		assert.ok(result.includes("[bash] ls -la") && result.includes("verbatim"), "bash result is named and verbatim on producing turn");
	});

	it("the digest carries the keep/drop affordance instructions", () => {
		const state = createLifecycleState();
		state.recordToolResult("read", "tc-1", "/a.ts", 1, 0);
		const result = buildToolOutputDigest(state, 1);
		assert.ok(result.includes("keep <key>"), "digest instructs the agent how to keep");
		assert.ok(result.includes("drop <key>"), "digest instructs the agent how to drop");
	});
});

// ─── lifecycle-state.ts — buildToolResultEnvelope (the side-by-side writer)

describe("lifecycle — buildToolResultEnvelope (the side-by-side writer)", () => {
	it("writes verbatim content + a pre-computed digest (Storage Shape A)", () => {
		const event: DigestibleToolResult = {
			toolName: "bash",
			toolCallId: "tc-1",
			input: { command: "ls" },
			content: textContent("file1.txt", "file2.txt"),
			isError: false,
		};
		const envelope = buildToolResultEnvelope(event, 2, 0);
		// The envelope is a `{ content, details }` shape (Storage Shape A).
		assert.deepEqual(envelope.content, event.content, "content is the verbatim blocks");
		assert.ok(typeof envelope.details.digest === "string", "details.digest is a string");
		assert.ok(envelope.details.digest.startsWith(FACT_OF_CALL_LABEL), "details.digest is the digest envelope");
		assert.equal(envelope.details.toolCallId, "tc-1", "details carries the toolCallId");
		assert.equal(envelope.details.turnIndex, 2, "details carries the turnIndex");
		assert.equal(envelope.details.piTurnAge, 0, "details carries the piTurnAge (T-2720 per-Pi-turn stamp)");
	});
});
