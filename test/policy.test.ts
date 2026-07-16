// ─── Policy tests — three-tier trim ──────────────────────────────────
//
// Covers the three tiers, the protected slots (dispatch task +
// pinned-tier synthetic), the per-message token accounting, the
// oldest-first whole-turn drop, and the summarize-loop semantics.
// The Python `summa` subprocess is mocked via a deterministic
// `summarizer` callback; the integration test in
// `integration.test.ts` exercises the production default separately.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	applyIntercomKeepLast,
	applyReasoningBlockCap,
	applySubagentNotifyKeepLast,
	applyThreeTierTrim,
	approximateMessageTokens,
	approximateTextTokens,
	countReasoningBlocks,
	dedupSubagentNotify,
	extractReasoningText,
	extractText,
	fingerprintToolCall,
	fingerprintAssistantTurn,
	detectConsecutiveIdenticalToolCalls,
	computeFlatInputTokenSignal,
	hasReasoning,
	keepLatestSubagentToolResult,
	REASONING_BLOCK_CAP_DEFAULT,
	shouldHardBlock,
	FLAT_INPUT_TOKEN_TOLERANCE,
	LOOP_GUARD_NUDGE_TEXT,
	LOOP_GUARD_BLOCK_TEXT,
	isPathPreserved,
	isProtectedSlot,
	totalTrimmableTokens,
	VERBATIM_TIER_MAX_TOKENS,
	SUMMARIZE_TIER_MAX_TOKENS,
	TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
	type TrimmableMessage,
} from "../policy.ts";

// ─── Helpers ───────────────────────────────────────────────────────────

/** Build a user-message fixture. */
function userMsg(text: string, userTurnAge?: number): TrimmableMessage {
	return { role: "user", content: text, userTurnAge };
}

/** Build an assistant-message fixture. */
function assistantMsg(text: string): TrimmableMessage {
	return { role: "assistant", content: text };
}

/** Build a tool-result fixture. */
function toolResultMsg(text: string): TrimmableMessage {
	return { role: "toolResult", content: text };
}

/** Build a pinned-tier synthetic (the agent-def carrier). */
function pinnedMsg(text: string): TrimmableMessage {
	return { role: "custom", content: text, customType: "context-trimmer-pinned" };
}

/** Build a tool-result fixture carrying a stamped source path. */
function toolResultWithPath(text: string, sourcePath: string): TrimmableMessage {
	return { role: "toolResult", content: text, details: { sourcePath } };
}

/** Build a tool-result fixture carrying a top-level `toolCallId` (the
 *  matching identifier for an assistant `toolCall` block's `id`). */
function toolResultWithId(text: string, toolCallId: string): TrimmableMessage {
	return { role: "toolResult", content: text, toolCallId } as TrimmableMessage;
}

/** Build an assistant-turn fixture carrying a single toolCall content block
 *  with an `id` and `arguments.path` (the canonical read-tool shape). */
function assistantWithProtectedToolCall(
	id: string,
	path: string,
	name = "read",
): TrimmableMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path } }],
	};
}

/** Build an assistant-turn fixture carrying a single toolCall content block
 *  with an `id` and arbitrary arguments (no `arguments.path`). */
function assistantWithUnprotectedToolCall(
	id: string,
	name = "search",
	args: unknown = { q: "x" },
): TrimmableMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
	};
}

/** Build an assistant-turn fixture carrying a mix of protected and
 *  unprotected `toolCall` blocks alongside `text` and `thinking`
 *  blocks. Used to verify the block-level carve-out keeps ONLY the
 *  protected `toolCall` blocks; text/thinking/unprotected toolCall
 *  blocks are dropped or rewritten. */
function assistantWithMixedToolCalls(
	prose: string,
	calls: Array<{ id: string; name?: string; args: unknown }>,
): TrimmableMessage {
	const content: unknown[] = [];
	if (prose.length > 0) content.push({ type: "text", text: prose });
	for (const c of calls) {
		content.push({ type: "toolCall", id: c.id, name: c.name ?? "read", arguments: c.args });
	}
	return {
		role: "assistant",
		content: content as Array<{ type: string; [k: string]: unknown }>,
	};
}

/** Build an assistant-turn fixture carrying a single toolCall content block. */
function assistantWithToolCall(name: string, args: unknown): TrimmableMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: args }],
	};
}

/** Build an assistant-turn fixture carrying multiple toolCall content blocks. */
function assistantWithToolCalls(toolCalls: Array<{ name: string; arguments: unknown }>): TrimmableMessage {
	return {
		role: "assistant",
		content: toolCalls.map((tc) => ({ type: "toolCall", name: tc.name, arguments: tc.arguments })),
	};
}

/** Build an assistant-turn fixture with mixed content: prose + toolCall. */
function assistantWithMixedBlock(
	prose: string,
	name: string,
	args: unknown,
): TrimmableMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: prose },
			{ type: "toolCall", name, arguments: args },
		],
	};
}

/** Build an assistant-turn fixture carrying N thinking blocks. */
function assistantWithThinking(blocks: string[]): TrimmableMessage {
	return {
		role: "assistant",
		content: blocks.map((t) => ({ type: "thinking", thinking: t })),
	};
}

/** Build an assistant-turn fixture carrying a mix of thinking and text blocks. */
function assistantWithThinkingAndText(thinking: string[], text: string): TrimmableMessage {
	const content: unknown[] = [];
	// Interleave: thinking first, then text. The block order is the
	// message's source order; the cap reverse-walks this list.
	for (const t of thinking) content.push({ type: "thinking", thinking: t });
	content.push({ type: "text", text });
	return {
		role: "assistant",
		content: content as Array<{ type: string; [k: string]: unknown }>,
	};
}

/** Build a trimmable mass of roughly N tokens (chars = N * 3). */
function trimmableMass(n: number): TrimmableMessage[] {
	// Build a single trimmable message of n tokens. The dispatch
	// is a small constant that the policy protects. The new
	// policy default divisor is 3 (chars/3) — the legacy chars/4
	// default is no longer reachable by default; this helper
	// reflects the new default.
	const targetChars = n * 3;
	return [
		userMsg("dispatch task — do X", 0),
		assistantMsg("a".repeat(targetChars)),
	];
}

// ─── Per-message token accounting ─────────────────────────────────────

describe("approximateMessageTokens (chars / 3 default)", () => {
	it("returns ceil(chars / 3) for a string content", async () => {
		assert.equal(approximateMessageTokens({ role: "user", content: "hello world" }), 4);
	});

	it("sums text across an array of content blocks", async () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello " },
				{ type: "text", text: "world" },
			],
		};
		assert.equal(approximateMessageTokens(msg), 4);
	});

	it("returns 0 for an empty string content", async () => {
		assert.equal(approximateMessageTokens({ role: "user", content: "" }), 0);
	});

	it("extracts text from object content via JSON.stringify fallback", async () => {
		const msg: TrimmableMessage = {
			role: "custom",
			content: { foo: "bar" },
		};
		// JSON.stringify({foo:"bar"}) → 13 chars → ceil(13/3) = 5
		assert.equal(approximateMessageTokens(msg), 5);
	});
});

describe("extractText", () => {
	it("returns a string content as-is", async () => {
		assert.equal(extractText("hello"), "hello");
	});

	it("concatenates text blocks from an array", async () => {
		assert.equal(
			extractText([
				{ type: "text", text: "foo " },
				{ type: "text", text: "bar" },
			]),
			"foo bar",
		);
	});

	it("falls back to JSON.stringify for non-text object content", async () => {
		assert.equal(extractText({ a: 1 }), '{"a":1}');
	});
});

// ─── Protected-slot predicate ─────────────────────────────────────────

describe("isProtectedSlot", () => {
	const dispatch: TrimmableMessage = userMsg("dispatch", 0);
	const followUp: TrimmableMessage = userMsg("follow-up", 1);
	const pinned: TrimmableMessage = pinnedMsg("agent def");
	const assistant: TrimmableMessage = assistantMsg("hi");

	it("protects the first user message (userTurnAge === 0)", async () => {
		const messages = [dispatch, assistant];
		assert.equal(isProtectedSlot(dispatch, 0, messages), true);
		assert.equal(isProtectedSlot(assistant, 1, messages), false);
	});

	it("does not protect a follow-up user message", async () => {
		const messages = [dispatch, followUp];
		assert.equal(isProtectedSlot(followUp, 1, messages), false);
	});

	it("protects a context-trimmer-pinned synthetic when its customType is in the protected set", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [pinned, dispatch, assistant];
		assert.equal(isProtectedSlot(pinned, 0, messages, protectedSet), true);
		assert.equal(isProtectedSlot(dispatch, 1, messages, protectedSet), true);
		assert.equal(isProtectedSlot(assistant, 2, messages, protectedSet), false);
	});

	it("does not protect a custom message whose customType is not in the protected set", async () => {
		const messages = [pinned, dispatch, assistant];
		assert.equal(isProtectedSlot(pinned, 0, messages, new Set()), false);
	});

	it("falls back to 'first user message by position' when userTurnAge is missing", async () => {
		const messages = [
			{ role: "user", content: "first" } as TrimmableMessage,
			{ role: "user", content: "second" } as TrimmableMessage,
		];
		assert.equal(isProtectedSlot(messages[0], 0, messages), true);
		assert.equal(isProtectedSlot(messages[1], 1, messages), false);
	});

	it("does NOT protect the first user message when protectDispatch is false", async () => {
		const messages = [dispatch, assistant];
		assert.equal(isProtectedSlot(dispatch, 0, messages, new Set(), false), false);
		assert.equal(isProtectedSlot(assistant, 1, messages, new Set(), false), false);
	});

	it("still protects a pinned customType when protectDispatch is false", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [pinned, dispatch, assistant];
		assert.equal(isProtectedSlot(pinned, 0, messages, protectedSet, false), true);
		// dispatch is NOT protected when protectDispatch is false, even
		// with a protected customType set present (the two protections
		// are independent).
		assert.equal(isProtectedSlot(dispatch, 1, messages, protectedSet, false), false);
		assert.equal(isProtectedSlot(assistant, 2, messages, protectedSet, false), false);
	});
});

// ─── Budget accounting ────────────────────────────────────────────────

describe("totalTrimmableTokens", () => {
	it("sums per-message tokens for trimmable messages", async () => {
		const messages = [
			userMsg("hi", 0),
			assistantMsg("hello"),
		];
		// user "hi" is protected; assistant "hello" = 6 chars / 4 = 2 tokens.
		assert.equal(totalTrimmableTokens(messages), 2);
	});

	it("subtracts protected-slot tokens from the total", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [
			pinnedMsg("agent def " + "x".repeat(1000)),
			userMsg("dispatch", 0),
			assistantMsg("hello"),
		];
		// Only the assistant message (6 chars / 4 = 2 tokens) is trimmable.
		assert.equal(totalTrimmableTokens(messages, protectedSet), 2);
	});
});

// ─── Verbatim tier (0–50k) ─────────────────────────────────────────────

describe("applyThreeTierTrim — verbatim tier (total ≤ 50k)", () => {

	it("returns the input unchanged for a small conversation", async () => {
		const messages = [userMsg("dispatch", 0), assistantMsg("hi")];
		const result = await applyThreeTierTrim(messages);
		assert.equal(result.droppedTurns, 0);
		assert.equal(result.droppedTurns, 0);
		assert.equal(result.messages.length, messages.length);
		assert.equal(result.messages[0].content, "dispatch");
		assert.equal(result.messages[1].content, "hi");
	});
});

function notifyWithAgent(label: string, agent: string, status: string, resultPreview: string): TrimmableMessage {
	return {
		role: "custom",
		content: label,
		customType: "subagent-notify",
		details: { agent, status, resultPreview, taskInfo: { id: "task-1" } },
	};
}

/** Build a subagent-notify fixture. */
function notifyMsg(label: string, sessionValue: string): TrimmableMessage {
	return {
		role: "custom",
		content: label,
		customType: "subagent-notify",
		details: { sessionValue, agent: "test-agent", status: "running", resultPreview: "...", taskInfo: { id: "task-1" } },
	};
}

/** Build an intercom_message fixture. */
function intercomMsg(label: string): TrimmableMessage {
	return {
		role: "custom",
		content: label,
		customType: "intercom_message",
	};
}

/** Build a custom-type fixture. */
function customMsg(label: string, customType: string): TrimmableMessage {
	return {
		role: "custom",
		content: label,
		customType,
	};
}

// ─── Pre-budget collapse — applySubagentNotifyKeepLast (AC-2) ────────
//
// `applySubagentNotifyKeepLast` is the recency hardtrim for
// `subagent-notify` custom entries, mirroring `applyIntercomKeepLast`.
// Cap semantics:
//   keepLast === -1  → passthrough (no allocation when the input is
//                      large; the policy returns `messages.slice()`).
//   keepLast ===  0  → drop every subagent-notify entry.
//   keepLast  >  0   → keep the last `keepLast` entries.
// Pure: no I/O, no `process.*`; the wiring layer coerces floats with
// `Math.trunc` (summaWords precedent) and gates by the
// `resolveIntercomInstalled` extension probe.

describe("applySubagentNotifyKeepLast", () => {
	// ── cap === -1 (passthrough) ──────────────────────────────────

	it("keepLast === -1: returns the input unchanged (passthrough)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			notifyMsg("first", "run-1"),
			assistantMsg("hi"),
			notifyMsg("second", "run-2"),
			notifyMsg("third", "run-3"),
		];
		const out = applySubagentNotifyKeepLast(messages, -1);
		assert.equal(out.length, messages.length);
		for (let i = 0; i < out.length; i++) {
			assert.equal(out[i], messages[i], `message ${i} preserved at keepLast=-1`);
		}
	});

	// ── cap === 0 (drop all) ─────────────────────────────────────

	it("keepLast === 0: drops every subagent-notify entry; non-subagent-notify entries preserved", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			notifyMsg("first", "run-1"),
			assistantMsg("hi"),
			notifyMsg("second", "run-2"),
			notifyMsg("third", "run-3"),
			{ role: "toolResult", content: "ok" },
		];
		const out = applySubagentNotifyKeepLast(messages, 0);
		assert.equal(out.length, 3, "every subagent-notify is dropped (dispatch + assistant + toolResult survive)");
		assert.equal((out[0] as TrimmableMessage).role, "user");
		assert.equal((out[1] as TrimmableMessage).role, "assistant");
		assert.equal((out[2] as TrimmableMessage).role, "toolResult");
		// No `customType: "subagent-notify"` survives.
		for (const m of out) {
			assert.notEqual((m as TrimmableMessage).customType, "subagent-notify");
		}
	});

	// ── cap === 1 (keep last) ────────────────────────────────────

	it("keepLast === 1: only the LAST subagent-notify survives; all earlier ones dropped", async () => {
		const messages: TrimmableMessage[] = [
			notifyMsg("first", "run-1"),
			assistantMsg("hi"),
			notifyMsg("second", "run-2"),
			notifyMsg("third", "run-3"),
		];
		const out = applySubagentNotifyKeepLast(messages, 1);
		assert.equal(out.length, 2, "assistant + 1 surviving subagent-notify");
		assert.equal((out[0] as TrimmableMessage).role, "assistant");
		assert.equal((out[1] as TrimmableMessage).customType, "subagent-notify");
		assert.equal((out[1] as TrimmableMessage).content, "third", "the LAST subagent-notify by stream order survives");
	});

	// ── cap === 3 (keep last 3) ─────────────────────────────────

	it("keepLast === 3: the last 3 subagent-notify entries survive (of 5 total)", async () => {
		const messages: TrimmableMessage[] = [
			notifyMsg("m1", "run-1"),
			notifyMsg("m2", "run-2"),
			notifyMsg("m3", "run-3"),
			notifyMsg("m4", "run-4"),
			notifyMsg("m5", "run-5"),
		];
		const out = applySubagentNotifyKeepLast(messages, 3);
		assert.equal(out.length, 3);
		assert.deepEqual(
			out.map((m) => (m as TrimmableMessage).content),
			["m3", "m4", "m5"],
			"the last 3 subagent-notify entries by stream order survive (m1 and m2 are dropped)",
		);
	});

	// ── cap > total: no over-drop ────────────────────────────────

	it("keepLast > total subagent-notify entries: every entry survives (no over-drop)", async () => {
		const messages: TrimmableMessage[] = [
			notifyMsg("m1", "run-1"),
			notifyMsg("m2", "run-2"),
		];
		const out = applySubagentNotifyKeepLast(messages, 10);
		assert.equal(out.length, 2, "all entries survive when cap > total");
	});

	// ── mixed stream: non-subagent-notify custom entries untouched ─

	it("preserves non-subagent-notify custom entries (intercom_message, pinned, preserved)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			notifyMsg("notify-1", "run-1"),
			customMsg("icm-1", "intercom_message"),
			notifyMsg("notify-2", "run-2"),
			pinnedMsg("agent def"),
			customMsg("preserved-1", "context-trimmer-preserved"),
			notifyMsg("notify-3", "run-3"),
		];
		const out = applySubagentNotifyKeepLast(messages, 1);
		// Surviving: dispatch + intercom_message + pinned + preserved + last subagent-notify = 5.
		assert.equal(out.length, 5);
		const customTypes = out
			.map((m) => (m as TrimmableMessage).customType)
			.filter((ct) => ct !== undefined);
		assert.deepEqual(customTypes, [
			"intercom_message",
			"context-trimmer-pinned",
			"context-trimmer-preserved",
			"subagent-notify",
		], "non-subagent-notify custom entries survive in stream order");
		assert.equal(out[out.length - 1].content, "notify-3", "the LAST subagent-notify by stream order survives");
	});

	// ── no subagent-notify entries: pure passthrough ─────────────

	it("messages with no subagent-notify entries: input returned unchanged (no scan overhead when not present)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("hi"),
			{ role: "toolResult", content: "ok" },
		];
		for (const keepLast of [-1, 0, 1, 5]) {
			const out = applySubagentNotifyKeepLast(messages, keepLast);
			assert.equal(out.length, messages.length, `length preserved at keepLast=${keepLast}`);
			for (let i = 0; i < out.length; i++) {
				assert.equal(out[i], messages[i], `message ${i} preserved at keepLast=${keepLast}`);
			}
		}
	});

	// ── immutability: the input array is not mutated ──────────────

	it("does not mutate the input messages array", async () => {
		const messages: TrimmableMessage[] = [
			notifyMsg("a", "run-1"),
			notifyMsg("b", "run-2"),
			notifyMsg("c", "run-3"),
		];
		const snapshot = JSON.stringify(messages);
		applySubagentNotifyKeepLast(messages, 1);
		assert.equal(JSON.stringify(messages), snapshot, "input messages array must not be mutated");
	});

	// ── purity: function source has no process.* or I/O ──────────

	it("purity: applySubagentNotifyKeepLast source has no process.*, node:fs, node:os, or other I/O", async () => {
		const src = applySubagentNotifyKeepLast.toString();
		assert.ok(!src.includes("process."), "applySubagentNotifyKeepLast must not reference process.*");
		assert.ok(!src.includes("node:fs"), "applySubagentNotifyKeepLast must not import node:fs");
		assert.ok(!src.includes("node:os"), "applySubagentNotifyKeepLast must not import node:os");
		assert.ok(!src.includes("fetch("), "applySubagentNotifyKeepLast must not perform network I/O");
		assert.ok(!src.includes("readFile"), "applySubagentNotifyKeepLast must not perform filesystem I/O");
	});
});

describe("dedupSubagentNotify", () => {
	it("keeps the first occurrence of each run identity; drops subsequent duplicates", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			notifyMsg("first-run-1", "run-1"),
			assistantMsg("hi"),
			// Redelivery of run-1 (same sessionValue) — must be dropped.
			notifyMsg("redeliver-run-1", "run-1"),
			notifyMsg("first-run-2", "run-2"),
			// Redelivery of run-2 — must be dropped.
			notifyMsg("redeliver-run-2", "run-2"),
			notifyMsg("first-run-3", "run-3"),
		];
		const out = dedupSubagentNotify(messages);
		assert.equal(out.length, 5, "2 duplicates dropped (run-1 redelivery, run-2 redelivery)");
		const notifyEntries = out.filter((m) => m.customType === "subagent-notify");
		assert.equal(notifyEntries.length, 3);
		assert.deepEqual(
			notifyEntries.map((m) => m.content),
			["first-run-1", "first-run-2", "first-run-3"],
			"the first occurrence of each run identity survives",
		);
	});

	it("preserves non-subagent-notify custom entries (intercom_message, pinned, preserved)", async () => {
		const messages: TrimmableMessage[] = [
			notifyMsg("n1", "run-1"),
			intercomMsg("icm"),
			notifyMsg("n1-dup", "run-1"),
			pinnedMsg("agent def"),
			notifyMsg("n2", "run-2"),
		];
		const out = dedupSubagentNotify(messages);
		assert.equal(out.length, 4, "the duplicate subagent-notify is dropped; other entries survive");
		const roles = out.map((m) => m.role);
		assert.deepEqual(roles, ["custom", "custom", "custom", "custom"]);
		const customTypes = out.map((m) => m.customType);
		assert.deepEqual(customTypes, [
			"subagent-notify",
			"intercom_message",
			"context-trimmer-pinned",
			"subagent-notify",
		]);
	});

	it("no duplicates: input returned unchanged", async () => {
		const messages: TrimmableMessage[] = [
			notifyMsg("n1", "run-1"),
			notifyMsg("n2", "run-2"),
			notifyMsg("n3", "run-3"),
		];
		const out = dedupSubagentNotify(messages);
		assert.equal(out.length, 3, "no duplicates → all entries survive");
	});

	it("run identity via details fingerprint when sessionValue is absent", async () => {
		// Two entries with the same `agent` + `status` + `resultPreview`
		// + `taskInfo` and no `sessionValue`. The fingerprint-based
		// run identity collapses them to one (the second is a
		// redelivery).
		const messages: TrimmableMessage[] = [
			notifyWithAgent("first", "tester", "completed", "result-A"),
			notifyWithAgent("second-redeliver", "tester", "completed", "result-A"),
		];
		const out = dedupSubagentNotify(messages);
		assert.equal(out.length, 1, "fingerprint-based identity collapses the redelivery");
		assert.equal(out[0].content, "first");
	});

	it("distinct fingerprints: each entry is a distinct run", async () => {
		const messages: TrimmableMessage[] = [
			notifyWithAgent("a", "tester", "completed", "result-A"),
			notifyWithAgent("b", "tester", "completed", "result-B"),
			notifyWithAgent("c", "tester", "failed", "result-A"),
		];
		const out = dedupSubagentNotify(messages);
		assert.equal(out.length, 3, "distinct fingerprints → all entries survive");
	});

	it("entry with no `details` payload: index-fallback identity, treated as distinct runs", async () => {
		// Two entries with the same customType but no `details` (and
		// therefore no `sessionValue` and no fingerprint). The
		// index-fallback path makes each a distinct run — the second
		// is NOT dropped (no identity collision to dedup against).
		const m1: TrimmableMessage = { role: "custom", content: "x", customType: "subagent-notify" };
		const m2: TrimmableMessage = { role: "custom", content: "y", customType: "subagent-notify" };
		const out = dedupSubagentNotify([m1, m2]);
		assert.equal(out.length, 2, "index-fallback identity treats each entry as a distinct run");
	});

	it("first-occurrence retention preserves temporal order (the first delivery is the one the model already saw)", async () => {
		const messages: TrimmableMessage[] = [
			notifyMsg("first", "run-1"),
			notifyMsg("second", "run-1"),
			notifyMsg("third", "run-1"),
		];
		const out = dedupSubagentNotify(messages);
		assert.equal(out.length, 1);
		assert.equal(out[0].content, "first", "the FIRST occurrence is the one that survives (not the latest)");
	});

	it("does not mutate the input messages array", async () => {
		const messages: TrimmableMessage[] = [
			notifyMsg("a", "run-1"),
			notifyMsg("a-dup", "run-1"),
		];
		const snapshot = JSON.stringify(messages);
		dedupSubagentNotify(messages);
		assert.equal(JSON.stringify(messages), snapshot, "input messages array must not be mutated");
	});

	it("purity: dedupSubagentNotify source has no process.*, node:fs, node:os, or other I/O", async () => {
		const src = dedupSubagentNotify.toString();
		assert.ok(!src.includes("process."), "dedupSubagentNotify must not reference process.*");
		assert.ok(!src.includes("node:fs"), "dedupSubagentNotify must not import node:fs");
		assert.ok(!src.includes("node:os"), "dedupSubagentNotify must not import node:os");
		assert.ok(!src.includes("fetch("), "dedupSubagentNotify must not perform network I/O");
		assert.ok(!src.includes("readFile"), "dedupSubagentNotify must not perform filesystem I/O");
	});
});

// ─── Pre-budget collapse — keepLatestSubagentToolResult (AC-5) ────
//
// `keepLatestSubagentToolResult` is the Rule 3 pre-budget collapse
// for `toolResult:subagent` entries. Drop every such entry except
// the LAST one (by stream order). No knob — prior subagent tool
// results are not needed once a newer one exists. Identification:
// `role === "toolResult" && toolName === "subagent"`.

function subagentToolResult(text: string): TrimmableMessage {
	return { role: "toolResult", content: text, toolName: "subagent" } as TrimmableMessage;
}

function nonSubagentToolResult(text: string): TrimmableMessage {
	return { role: "toolResult", content: text, toolName: "bash" } as TrimmableMessage;
}

describe("keepLatestSubagentToolResult", () => {
	it("keeps only the LATEST toolResult:subagent entry; all earlier ones dropped", async () => {
		const messages: TrimmableMessage[] = [
			subagentToolResult("result-1"),
			subagentToolResult("result-2"),
			subagentToolResult("result-3"),
		];
		const out = keepLatestSubagentToolResult(messages);
		assert.equal(out.length, 1);
		assert.equal(out[0].content, "result-3", "only the LATEST toolResult:subagent survives");
	});

	it("preserves non-subagent toolResult entries (e.g. toolResult:bash)", async () => {
		const messages: TrimmableMessage[] = [
			subagentToolResult("sub-1"),
			nonSubagentToolResult("bash-1"),
			subagentToolResult("sub-2"),
			nonSubagentToolResult("bash-2"),
			subagentToolResult("sub-3"),
		];
		const out = keepLatestSubagentToolResult(messages);
		// Surviving: bash-1, bash-2, sub-3 (the latest subagent tool result).
		assert.equal(out.length, 3);
		const toolNames = out.map((m) => (m as TrimmableMessage & { toolName?: string }).toolName);
		assert.deepEqual(toolNames, ["bash", "bash", "subagent"]);
		assert.equal(out[2].content, "sub-3", "the latest subagent tool result by stream order is the one that survives");
	});

	it("single toolResult:subagent entry: passthrough", async () => {
		const messages: TrimmableMessage[] = [subagentToolResult("only")];
		const out = keepLatestSubagentToolResult(messages);
		assert.equal(out.length, 1);
		assert.equal(out[0].content, "only");
	});

	it("zero toolResult:subagent entries: passthrough (all entries preserved)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("hi"),
			nonSubagentToolResult("bash-1"),
		];
		const out = keepLatestSubagentToolResult(messages);
		assert.equal(out.length, 3);
		for (let i = 0; i < out.length; i++) {
			assert.equal(out[i], messages[i], `message ${i} preserved`);
		}
	});

	it("empty input: returns an empty array", async () => {
		const out = keepLatestSubagentToolResult([]);
		assert.equal(out.length, 0);
	});

	it("mixed stream: subagent-notify and intercom_message entries untouched", async () => {
		const messages: TrimmableMessage[] = [
			intercomMsg("icm-1"),
			subagentToolResult("sub-1"),
			notifyMsg("n1", "run-1"),
			subagentToolResult("sub-2"),
			notifyMsg("n1-dup", "run-1"),
		];
		const out = keepLatestSubagentToolResult(messages);
		// After Rule 3: icm-1, n1, sub-2 (latest subagent), n1-dup.
		// (Rule 2 is the wiring layer's job, not Rule 3's — Rule 3
		// drops subagent tool results; the duplicate notify survives
		// this pass and would be deduped by Rule 2 earlier in the
		// pipeline. The composition test below pins the
		// pipeline-order behavior.)
		assert.equal(out.length, 4);
		const subagentToolResults = out.filter((m) => (m as TrimmableMessage & { toolName?: string }).toolName === "subagent");
		assert.equal(subagentToolResults.length, 1, "exactly one toolResult:subagent survives");
		assert.equal(subagentToolResults[0].content, "sub-2", "the LATEST one by stream order");
	});

	it("does not mutate the input messages array", async () => {
		const messages: TrimmableMessage[] = [
			subagentToolResult("a"),
			subagentToolResult("b"),
		];
		const snapshot = JSON.stringify(messages);
		keepLatestSubagentToolResult(messages);
		assert.equal(JSON.stringify(messages), snapshot, "input messages array must not be mutated");
	});

	it("purity: keepLatestSubagentToolResult source has no process.*, node:fs, node:os, or other I/O", async () => {
		const src = keepLatestSubagentToolResult.toString();
		assert.ok(!src.includes("process."), "keepLatestSubagentToolResult must not reference process.*");
		assert.ok(!src.includes("node:fs"), "keepLatestSubagentToolResult must not import node:fs");
		assert.ok(!src.includes("node:os"), "keepLatestSubagentToolResult must not import node:os");
		assert.ok(!src.includes("fetch("), "keepLatestSubagentToolResult must not perform network I/O");
		assert.ok(!src.includes("readFile"), "keepLatestSubagentToolResult must not perform filesystem I/O");
	});
});

// ─── Pre-budget collapse — pipeline composition (AC-6) ──────────────
//
// Pins the AC-6 ordering of the three pre-budget collapse rules +
// `applyReasoningBlockCap` against a mixed stream, then verifies the
// composed output feeds a clean three-tier trim. The wiring layer's
// call-site ordering (Rule 1 → Rule 2 → Rule 3 → reasoning cap →
// pinned → three-tier) is replicated here as a pure composition.

describe("pre-budget collapse — pipeline composition (AC-6 ordering)", () => {
	it("all three pre-budget rules + reasoning cap + three-tier trim compose cleanly", async () => {
		// 30 intercom_message entries interleaved with 2 subagent-
		// notify duplicates and 3 toolResult:subagent echoes. With
		// keepLast=5, after Rule 1 only 5 intercom_message entries
		// survive; after Rule 2 the duplicate subagent-notify is
		// dropped; after Rule 3 only the latest toolResult:subagent
		// survives; after the reasoning cap the post-cap mass feeds
		// the three-tier trim, which lands in tier 1 (verbatim)
		// because the surviving mass is small.
		const intercomEntries: TrimmableMessage[] = Array.from({ length: 30 }, (_, i) =>
			intercomMsg(`icm-${i + 1}`),
		);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			...intercomEntries,
			assistantMsg("first response"),
			notifyMsg("n1-first", "run-1"),
			subagentToolResult("sub-echo-1"),
			notifyMsg("n1-redeliver", "run-1"),
			subagentToolResult("sub-echo-2"),
			subagentToolResult("sub-echo-3"),
		];

		// Replicate the AC-6 ordering on the pure layer. The wiring
		// is responsible for the gate checks; this test pins the
		// pure-pipeline composition.
		const afterRule1 = applyIntercomKeepLast(messages, 5);
		const afterRule2 = dedupSubagentNotify(afterRule1);
		const afterRule3 = keepLatestSubagentToolResult(afterRule2);
		const afterCap = applyReasoningBlockCap(afterRule3, -1);

		// Surviving intercom_message count: 5.
		const survivingIcm = afterCap.filter((m) => m.customType === "intercom_message");
		assert.equal(survivingIcm.length, 5, "keepLast=5 yields exactly 5 intercom_message entries");
		// The survivors are the last 5 in stream order: icm-26..icm-30.
		assert.deepEqual(
			survivingIcm.map((m) => m.content),
			["icm-26", "icm-27", "icm-28", "icm-29", "icm-30"],
		);

		// Surviving subagent-notify count: 1 (the duplicate dropped).
		const survivingNotifies = afterCap.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotifies.length, 1, "the duplicate subagent-notify is dropped by Rule 2");
		assert.equal(survivingNotifies[0].content, "n1-first", "the first occurrence survives");

		// Surviving toolResult:subagent count: 1 (the latest one).
		const survivingSubagentToolResults = afterCap.filter(
			(m) => (m as TrimmableMessage & { toolName?: string }).toolName === "subagent",
		);
		assert.equal(survivingSubagentToolResults.length, 1, "only the latest toolResult:subagent survives Rule 3");
		assert.equal(survivingSubagentToolResults[0].content, "sub-echo-3", "the LATEST survives");

		// The composed output feeds a clean three-tier trim (the
		// post-cap mass is well under the 50k verbatim cap, so the
		// trim is a no-op passthrough).
		const result = await applyThreeTierTrim(afterCap, {
		});
		assert.equal(result.messages.length, afterCap.length, "tier 1 (verbatim): every message survives");
	});
});

// ─── Pair-atomic toolCall/toolResult protection (AC-1 through AC-7) ────
//
// The pair-atomicity fix is the contract-correctness fix for the
// `toolResult` orphaning behavior. The trim policy identifies
// protected `toolCall` blocks by their `arguments.path` matching
// `preservedPatterns` (the wiring layer extracts the set and threads
// it as `protectedToolCallIds: ReadonlySet<string>`), and the policy
// keeps each protected `toolCall` block + its matching `toolResult`
// as an atomic chain at block-level granularity. The chain is
// protected from drop AND summarize: the protected `toolResult` is
// a message-level protected slot, and the protected `toolCall` block
// survives inside its assistant message via the block-level
// carve-out. An unprotected `toolCall` block that is dropped or
// summarized has its matching `toolResult` dropped alongside (the
// pair is atomic in both directions, no orphan).
//
// The test surface below covers the five AC-7 cases:
//   (a) call-arg→result identification — a `toolCall` block with
//       `arguments.path` matching a pattern enters the protected
//       set; the matching `toolResult` (by `toolCallId`) is kept
//       by association.
//   (b) block-level granularity — the assistant turn is NOT a
//       protected slot, so the `text`/`thinking` blocks stay
//       trimmable/summarizable while the protected `toolCall` block
//       survives inside the rewritten message.
//   (c) orphan scenario for both tiers — a `toolResult` whose
//       matching `toolCall` is in a dropped or summarized turn
//       does not survive with a dangling `toolCallId` (the
//       protected `toolResult` survives; the unprotected
//       `toolResult` is dropped alongside its `toolCall`).
//   (d) no-regression floor — unprotected pairs drop/summarize as
//       before (the existing behavior is preserved).
//   (e) wiring-layer JSONL reconstruction — exercised in
//       `integration.test.ts` (the protected set is reconstructible
//       from the JSONL `toolCall.id` + `arguments.path` at trim
//       time; the `path-stamp.ts` fallback handles older turns).

describe("pair-atomic toolCall/toolResult protection — AC-1 through AC-7", () => {
	const AGENTS_PATH = "/home/operator/AGENTS.md";
	const OTHER_PATH = "/home/operator/CLAUDE.md";

	// (a) call-arg→result identification: a `toolCall` block with
	// `arguments.path` matching the pattern enters the protected
	// set; the matching `toolResult` (by `toolCallId`) is kept by
	// association. The unprotected `toolCall` block's matching
	// `toolResult` is NOT protected and is NOT subtracted from the
	// budget.

	it("(a) call-arg→result: protected `toolCall.id` enters the set; matching `toolResult.toolCallId` is kept (budget subtract)", async () => {
		const protectedCallId = "call_AGENTS_md_1";
		const unprotectedCallId = "call_CLAUDE_md_1";
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			// Assistant with two toolCall blocks: one protected
			// (AGENTS.md), one unprotected (CLAUDE.md).
			assistantWithMixedToolCalls("", [
				{ id: protectedCallId, name: "read", args: { path: AGENTS_PATH } },
				{ id: unprotectedCallId, name: "read", args: { path: OTHER_PATH } },
			]),
			toolResultWithId("contents of AGENTS.md", protectedCallId),
			toolResultWithId("contents of CLAUDE.md", unprotectedCallId),
		];
		// With `protectedToolCallIds: { protectedCallId }`, the
		// matching `toolResult` is a protected slot (budget
		// subtraction). The unprotected `toolResult` is trimmable.
		// The total is well under cap; we assert budget accounting
		// to verify the protected result is excluded.
		const result = await applyThreeTierTrim(messages, {
			preservedPatterns: ["AGENTS.md"],
			protectedToolCallIds: new Set([protectedCallId]),
		});
		// Trimmable mass: the unprotected `toolResult` is the only
		// non-protected trimmable message (~26 chars / 4 = 7
		// tokens). Tier 1 (verbatim); the trim is a passthrough.
		assert.equal(result.droppedTurns, 0);
		assert.equal(result.droppedTurns, 0);
		// Every input message is in the output (verbatim passthrough
		// of a small conversation).
		assert.equal(result.messages.length, messages.length);
		// The protected `toolResult` survives with original content.
		const protectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === protectedCallId,
		);
		assert.ok(protectedResult, "protected `toolResult` survives by association with the protected `toolCall` block");
		assert.equal(protectedResult!.content, "contents of AGENTS.md", "protected `toolResult` content is verbatim");
		// The unprotected `toolResult` is also in the output
		// (trimmable, but the total is under cap so nothing fires).
		const unprotectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.ok(unprotectedResult, "unprotected `toolResult` is in the output (not protected, but no trim fired)");
	});

	// (b) block-level granularity: the assistant message is NOT a
	// protected slot. The `text` block is summarizeable, but the
	// protected `toolCall` block survives inside the rewritten
	// message. The protected `toolResult` survives by association.

	it("(b) block-level: assistant turn stays a trimmable candidate; protected `toolCall` block survives inside the hold-untouched tier", async () => {
		const protectedCallId = "call_AGENTS_md_b";
		// Build a session that lands in tier 2: a large trimmable
		// message. With the summarize path removed, tier 2 holds
		// middle-band messages untouched. The protected `toolCall`
		// block survives inside the message; the `text` block is
		// preserved as-is.
		const longText = "x".repeat(60_000 * 4); // 60k tokens
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			{
				role: "assistant",
				content: [
					{ type: "text", text: longText },
					{ type: "toolCall", id: protectedCallId, name: "read", arguments: { path: AGENTS_PATH } },
				],
			},
			toolResultWithId("contents of AGENTS.md", protectedCallId),
		];
		const result = await applyThreeTierTrim(messages, {
			preservedPatterns: ["AGENTS.md"],
			protectedToolCallIds: new Set([protectedCallId]),
		});
		// (i) Tier 2 hold-untouched: no drop, no summarize.
		assert.equal(result.droppedTurns, 0, "tier 2 hold-untouched");
		// (ii) The protected `toolCall` block survives inside the
		// message — the carve-out kept it.
		const assistant = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content),
		);
		assert.ok(assistant, "the assistant message survives");
		const content = assistant!.content as Array<{ type: string; id?: string; name?: string; arguments?: unknown; text?: string }>;
		const survivingToolCall = content.find(
			(b) => b.type === "toolCall" && b.id === protectedCallId,
		);
		assert.ok(survivingToolCall, "the protected `toolCall` block survives inside the assistant message");
		// (iii) The text block is preserved as-is (no summa envelope).
		const textBlock = content.find(
			(b) => b.type === "text",
		);
		assert.ok(textBlock, "the text block is present (hold-untouched)");
		// (iv) The protected `toolResult` survives by association.
		const survivingToolResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === protectedCallId,
		);
		assert.ok(survivingToolResult, "the protected `toolResult` survives by association (no orphan)");
		assert.equal(survivingToolResult!.content, "contents of AGENTS.md", "protected `toolResult` content is verbatim");
	});

	// (c) orphan scenario — drop tier: the protected `toolResult`
	// survives the drop (the matching `toolCall` block is carved
	// out of the dropped assistant turn); the unprotected
	// `toolResult` is dropped alongside its unprotected `toolCall`
	// block.

	it("(c) orphan — drop tier: protected `toolResult` survives; unprotected pair drops together (no orphan)", async () => {
		const protectedCallId = "call_AGENTS_md_c";
		const unprotectedCallId = "call_CLAUDE_md_c";
		// Build a multi-turn session that lands in tier 3 (>100k
		// trimmable) without engaging the drop-floor. The first
		// trimmable turn (between follow-up 1 and follow-up 2)
		// contains a 60k trimmable assistant with both a protected
		// and an unprotected `toolCall` block, plus a 60k
		// trimmable toolResult. The second trimmable turn (after
		// follow-up 2) is 60k. Total trimmable is 120k.
		// `dropFloorTokens: 0` so the drop path runs without
		// engaging the floor (the floor's separate path is covered
		// in the existing drop-floor tests).
		const trimmableBody = "y".repeat(60_000 * 4); // 60k tokens
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			// Follow-up 1 anchors turn 1.
			userMsg("follow-up 1", 1),
			// Turn 1 assistant: a protected and an unprotected
			// `toolCall` block, plus a 60k trimmable body.
			{
				role: "assistant",
				content: [
					{ type: "text", text: trimmableBody },
					{ type: "toolCall", id: protectedCallId, name: "read", arguments: { path: AGENTS_PATH } },
					{ type: "toolCall", id: unprotectedCallId, name: "read", arguments: { path: OTHER_PATH } },
				],
			},
			toolResultWithId("contents of AGENTS.md", protectedCallId),
			// Turn 1 unprotected toolResult (matching the unprotected
			// call). The fixture places it inside turn 1.
			toolResultWithId("contents of CLAUDE.md", unprotectedCallId),
			// Follow-up 2 closes turn 1 and anchors turn 2.
			userMsg("follow-up 2", 2),
			// Turn 2 assistant: 60k trimmable. The carve-out path
			// does not affect turn 2 (the drop only targets turn 1).
			assistantMsg(trimmableBody),
		];
		const result = await applyThreeTierTrim(messages, {
			preservedPatterns: ["AGENTS.md"],
			protectedToolCallIds: new Set([protectedCallId]),
			dropFloorTokens: 0,
		});
		// (i) The drop fired on turn 1 (60k trimmable dropped; 60k
		// remaining in turn 2, under cap).
		assert.ok(result.droppedTurns >= 1, "the drop fired on the oldest trimmable turn");
		// (ii) The protected `toolResult` survives the drop (the
		// `protectedToolCallIds` set made it a protected slot at
		// the message level; the carve-out in `dropOldestTurns`
		// kept it alive even though it sat inside the dropped
		// turn's slice).
		const survivingProtectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === protectedCallId,
		);
		assert.ok(survivingProtectedResult, "protected `toolResult` survives the tier-3 drop (no orphan, pair-atomic by association)");
		assert.equal(survivingProtectedResult!.content, "contents of AGENTS.md", "protected `toolResult` content is verbatim");
		// (iii) The unprotected `toolResult` is dropped alongside
		// its unprotected `toolCall` block (the pair is atomic in
		// both directions — the unprotected block was carved out
		// of the dropped turn's assistant message, and the
		// matching `toolResult` was dropped in the post-pass).
		const survivingUnprotectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.equal(survivingUnprotectedResult, undefined, "unprotected `toolResult` is dropped alongside its unprotected `toolCall` block (no orphan in the unprotected direction either)");
		// (iv) The protected `toolCall` block survived inside the
		// rewritten turn 1 assistant message (the block-level
		// carve-out kept it; the `text` block and unprotected
		// `toolCall` block were dropped).
		const carvedOutAssistant = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content),
		);
		assert.ok(carvedOutAssistant, "the carved-out assistant message (or a surviving turn-2 assistant) is in the output");
		const carvedContent = carvedOutAssistant!.content as Array<{ type: string; id?: string; text?: string }>;
		const survivingProtectedCall = carvedContent.find(
			(b) => b.type === "toolCall" && b.id === protectedCallId,
		);
		// The carved-out assistant (turn 1) carries the protected
		// `toolCall` block. The turn-2 assistant (unprotected) does
		// not. The find above searches the first array-content
		// assistant; verify the protected call's survival by
		// walking every assistant.
		let protectedCallSurvived = false;
		for (const m of result.messages) {
			if (m.role !== "assistant") continue;
			if (!Array.isArray(m.content)) continue;
			for (const b of m.content as Array<{ type: string; id?: string }>) {
				if (b.type === "toolCall" && b.id === protectedCallId) {
					protectedCallSurvived = true;
				}
			}
		}
		assert.ok(protectedCallSurvived, "the protected `toolCall` block survives inside its assistant message (the block-level carve-out)");
		// The unprotected `toolCall` block is gone (it was dropped
		// with the turn; the rewrite kept only the protected one).
		let unprotectedCallSurvived = false;
		for (const m of result.messages) {
			if (m.role !== "assistant") continue;
			if (!Array.isArray(m.content)) continue;
			for (const b of m.content as Array<{ type: string; id?: string }>) {
				if (b.type === "toolCall" && b.id === unprotectedCallId) {
					unprotectedCallSurvived = true;
				}
			}
		}
		assert.equal(unprotectedCallSurvived, false, "the unprotected `toolCall` block is gone (dropped with the turn)");
		// Sanity: the surviving content of `carvedContent` does
		// not include the `text` block (the carve-out dropped
		// text/thinking/unprotected toolCall blocks).
		void survivingProtectedCall;
		void carvedContent;
	});

	// (c2) orphan scenario — summarize tier: a protected `toolResult`
	// whose matching `toolCall` is in a summarize candidate turn
	// survives by association; the unprotected `toolResult` is
	// dropped alongside its unprotected `toolCall` block when the
	// rewrite drops that block.

	it("(c) orphan — summarize tier: protected `toolResult` survives; unprotected pair survives (tier 2 hold-untouched)", async () => {
		const protectedCallId = "call_AGENTS_md_c2";
		const unprotectedCallId = "call_CLAUDE_md_c2";
		const longText = "z".repeat(60_000 * 4);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			{
				role: "assistant",
				content: [
					{ type: "text", text: longText },
					{ type: "toolCall", id: protectedCallId, name: "read", arguments: { path: AGENTS_PATH } },
					{ type: "toolCall", id: unprotectedCallId, name: "read", arguments: { path: OTHER_PATH } },
				],
			},
			toolResultWithId("contents of AGENTS.md", protectedCallId),
			toolResultWithId("contents of CLAUDE.md", unprotectedCallId),
		];
		const result = await applyThreeTierTrim(messages, {
			preservedPatterns: ["AGENTS.md"],
			protectedToolCallIds: new Set([protectedCallId]),
		});
		// (i) Tier 2 hold-untouched: no drop, no summarize.
		assert.equal(result.droppedTurns, 0, "tier 2 hold-untouched");
		// (ii) The protected `toolResult` survives by association.
		const survivingProtectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === protectedCallId,
		);
		assert.ok(survivingProtectedResult, "protected `toolResult` survives");
		// (iii) The unprotected `toolResult` also survives (tier 2
		// hold-untouched — no rewrite, no drop).
		const survivingUnprotectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.ok(survivingUnprotectedResult, "unprotected `toolResult` survives (tier 2 hold-untouched)");
		// (iv) The protected `toolCall` block survives inside the
		// assistant message.
		const assistant = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content),
		);
		assert.ok(assistant, "the assistant message survives");
		const content = assistant!.content as Array<{ type: string; id?: string }>;
		const survivingProtectedCall = content.find(
			(b) => b.type === "toolCall" && b.id === protectedCallId,
		);
		assert.ok(survivingProtectedCall, "the protected `toolCall` block survives inside the assistant message");
	});

	// (d) no-regression floor: an unprotected pair (no `protectedToolCallIds`
	// entry, no `preservedPatterns` match) drops / summarizes as
	// before. The fix does not change unprotected behavior.

	it("(d) no-regression: unprotected pair (no `protectedToolCallIds`) survives (tier 2 hold-untouched)", async () => {
		const unprotectedCallId = "call_CLAUDE_md_d";
		// A simple tier-2 session: a large assistant with a single
		// unprotected `toolCall` block, plus the matching
		// `toolResult`. With tier 2 hold-untouched, both survive.
		const longText = "w".repeat(60_000 * 4);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			{
				role: "assistant",
				content: [
					{ type: "text", text: longText },
					{ type: "toolCall", id: unprotectedCallId, name: "read", arguments: { path: OTHER_PATH } },
				],
			},
			toolResultWithId("contents of CLAUDE.md", unprotectedCallId),
		];
		const result = await applyThreeTierTrim(messages, {
			// No `preservedPatterns`, no `protectedToolCallIds`.
		});
		// (i) Tier 2 hold-untouched: no drop, no summarize.
		assert.equal(result.droppedTurns, 0, "tier 2 hold-untouched");
		// (ii) The unprotected `toolResult` survives (tier 2
		// hold-untouched — no rewrite, no drop).
		const survivingUnprotectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.ok(survivingUnprotectedResult, "unprotected `toolResult` survives (tier 2 hold-untouched)");
		// (iii) The unprotected `toolCall` block survives.
		let unprotectedCallSurvived = false;
		for (const m of result.messages) {
			if (m.role !== "assistant") continue;
			if (!Array.isArray(m.content)) continue;
			for (const b of m.content as Array<{ type: string; id?: string }>) {
				if (b.type === "toolCall" && b.id === unprotectedCallId) {
					unprotectedCallSurvived = true;
				}
			}
		}
		assert.ok(unprotectedCallSurvived, "the unprotected `toolCall` block survives (tier 2 hold-untouched)");
	});

	// (d2) no-regression floor: an unprotected pair in the drop tier
	// drops as before — the carve-out only affects protected pairs.

	it("(d) no-regression — drop tier: unprotected pair in a dropped turn drops together (pair-atomic in the unprotected direction)", async () => {
		const unprotectedCallId = "call_CLAUDE_md_d2";
		const trimmableBody = "v".repeat(60_000 * 4);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			userMsg("follow-up 1", 1),
			// Turn 1: an unprotected toolCall block + a 60k
			// trimmable body.
			{
				role: "assistant",
				content: [
					{ type: "text", text: trimmableBody },
					{ type: "toolCall", id: unprotectedCallId, name: "read", arguments: { path: OTHER_PATH } },
				],
			},
			toolResultWithId("contents of CLAUDE.md", unprotectedCallId),
			userMsg("follow-up 2", 2),
			assistantMsg(trimmableBody),
		];
		const result = await applyThreeTierTrim(messages, {
			dropFloorTokens: 0,
		});
		// (i) The drop fired on turn 1.
		assert.ok(result.droppedTurns >= 1, "the drop fired on the oldest trimmable turn");
		// (ii) The unprotected `toolResult` is dropped (the
		// `toolCall` block was in the dropped turn, but the
		// matching `toolResult` is in the same turn's slice, so
		// it's already gone via the existing drop path; the
		// pair-atomicity is a no-op for in-turn unprotected pairs).
		const survivingResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.equal(survivingResult, undefined, "unprotected `toolResult` is dropped (the pair is in the same dropped turn)");
	});

	// (e) `protectedToolCallIds` defaults to an empty set — sessions
	// with no preserved patterns see no behavior change (the carve-out
	// is silent).

	it("(e) `protectedToolCallIds` defaults to empty: no behavior change when no preserved patterns are configured", async () => {
		const unprotectedCallId = "call_random_md";
		const longText = "u".repeat(60_000 * 4);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			{
				role: "assistant",
				content: [
					{ type: "text", text: longText },
					{ type: "toolCall", id: unprotectedCallId, name: "read", arguments: { path: "/tmp/random.md" } },
				],
			},
			toolResultWithId("random content", unprotectedCallId),
		];
		const result = await applyThreeTierTrim(messages, {
			// No `preservedPatterns`, no `protectedToolCallIds`.
		});
		assert.equal(result.droppedTurns, 0, "tier 2 hold-untouched");
		// The unprotected `toolResult` survives (tier 2 hold-untouched).
		const survivingResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.ok(survivingResult, "unprotected `toolResult` survives (tier 2 hold-untouched)");
	});

	// Purity check: the new `protectedToolCallIds` shape is plumbed
	// as a `ReadonlySet<string>` predicate argument; the
	// `applyThreeTierTrim` source has no `process.*`, `node:fs`, or
	// `node:os` reference (the contract is unchanged by this fix).

	it("purity: applyThreeTierTrim source has no process.*, node:fs, node:os, or other I/O (the `protectedToolCallIds` seam is a pure predicate argument)", async () => {
		const src = applyThreeTierTrim.toString();
		assert.ok(!src.includes("process."), "applyThreeTierTrim must not reference process.*");
		assert.ok(!src.includes("node:fs"), "applyThreeTierTrim must not import node:fs");
		assert.ok(!src.includes("node:os"), "applyThreeTierTrim must not import node:os");
		assert.ok(!src.includes("fetch("), "applyThreeTierTrim must not perform network I/O");
		assert.ok(!src.includes("readFile"), "applyThreeTierTrim must not perform filesystem I/O");
	});
});
// ─── Effective budget with protected mass + system-prompt term ──────────
//
// The new `systemPromptTokens` field on `TrimOptions` is subtracted
// from the verbatim and summarize tier caps alongside the protected-
// slot mass. The result is the effective cap the policy compares the
// trimmable mass against: `effectiveVerbatimMax = max(0, verbatimMax
// − systemPromptTokens − protectedMass)`. The `Math.max(0, …)` guard
// ensures the effective cap never goes negative — when the protected
// mass and system-prompt term together exceed the raw cap the
// effective cap is 0 and the trim loop compares against 0.
//
// The tests below exercise the new effective-cap math end-to-end on
// `applyThreeTierTrim`. Five scenarios:
//   (1) protected mass subtracted from both tier caps (AC-1).
//   (2) system-prompt tokens subtracted in addition to protected mass
//       (AC-2).
//   (3) `approximateTextTokens` with divisor 3 (the new default) and
//       divisor 4 (the legacy chars/4 default, still reachable through
//       the operator-configured knob) — AC-3.
//   (4) no-regression: when both `systemPromptTokens` and the protected
//       mass are 0 the trim is identical to the legacy behavior
//       (AC-6).
//   (5) degradation: when the protected mass alone exceeds the verbatim
//       cap, the effective cap is 0 and the trim fires against the
//       trimmable mass (AC-6, no `NaN` / `Infinity` / infinite loop).

describe("applyThreeTierTrim — effective budget with protected mass + system-prompt term", () => {

	// (1) protected mass subtracted from both tier caps (AC-1).
	//
	// Build a session whose trimmable mass is 60k tokens (over the
	// 50k verbatim cap and under the 100k drop cap) with a protected
	// mass of 1506 tokens. The effective verbatim cap is
	// `max(0, 50_000 − 0 − 1_506) = 48_494` and the effective
	// summarize cap is `max(0, 100_000 − 0 − 1_506) = 98_494`. The
	// trimmable total (60k) exceeds the effective verbatim cap
	// (48_494) so tier 2 fires; the trimmable total is well below
	// the effective summarize cap (98_494) so the drop tier does not
	// fire. The protected slots survive the trim (their content is
	// verbatim); the trimmable allowance is reduced by the protected
	// mass.
	it("(1) protected mass subtracted from both tier caps (AC-1): the effective cap is verbatimMax − protectedMass; tier 2 holds untouched", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages: TrimmableMessage[] = [
			// Protected pinned synthetic — 500 tokens
			// (1500 chars / 3 = 500 tokens).
			pinnedMsg("p".repeat(1500)),
			// Protected dispatch task — 7 tokens
			// ("dispatch task — do X" = 21 chars / 3 = 7).
			userMsg("dispatch task — do X", 0),
			// Protected preserved-path tool result — 1000 tokens
			// (3000 chars / 3 = 1000).
			toolResultWithPath("c".repeat(3000), "/repo/AGENTS.md"),
			// Trimmable: 60k total (two ~30k assistant messages).
			assistantMsg("a".repeat(30_000 * 3)),
			assistantMsg("b".repeat(30_000 * 3)),
		];
		const result = await applyThreeTierTrim(messages, {
			protectedCustomTypes: protectedSet,
			preservedPatterns: ["AGENTS.md"],
			verbatimMaxTokens: 50_000,
			summarizeMaxTokens: 100_000,
		});
		// Tier 2 hold-untouched: no drop, no summarize.
		assert.equal(result.droppedTurns, 0, "tier 2 hold-untouched");
		// (i) The protected pinned synthetic survives with original content.
		const pinned = result.messages.find(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.ok(pinned, "the protected pinned synthetic must survive the trim");
		assert.equal(pinned!.content, "p".repeat(1500), "the pinned synthetic's content is verbatim");
		// (ii) The protected dispatch task survives with original content.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "the dispatch task must survive the trim");
		assert.equal(dispatch!.content, "dispatch task — do X", "the dispatch task's content is verbatim");
		// (iii) The protected preserved-path tool result survives with original content.
		const preserved = result.messages.find(
			(m) => m.role === "toolResult" && m.details?.sourcePath === "/repo/AGENTS.md",
		);
		assert.ok(preserved, "the protected preserved-path tool result must survive the trim");
		assert.equal(preserved!.content, "c".repeat(3000), "the preserved tool result's content is verbatim");
		// (iv) All messages are returned unchanged (tier 2 hold-untouched).
		assert.equal(result.messages.length, messages.length, "all messages survive (tier 2 hold-untouched)");
	});

	// (2) system-prompt tokens subtracted in addition to protected mass (AC-2).
	it("(2) system-prompt tokens subtracted (AC-2): the effective cap is verbatimMax − systemPromptTokens − protectedMass; tier 2 holds untouched", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages: TrimmableMessage[] = [
			pinnedMsg("p".repeat(1500)),
			userMsg("dispatch task — do X", 0),
			toolResultWithPath("c".repeat(3000), "/repo/AGENTS.md"),
			assistantMsg("a".repeat(30_000 * 3)),
			assistantMsg("b".repeat(30_000 * 3)),
		];
		const result = await applyThreeTierTrim(messages, {
			protectedCustomTypes: protectedSet,
			preservedPatterns: ["AGENTS.md"],
			verbatimMaxTokens: 50_000,
			summarizeMaxTokens: 100_000,
			systemPromptTokens: 30_000,
		});
		// Tier 2 hold-untouched: no drop, no summarize.
		assert.equal(result.droppedTurns, 0, "tier 2 hold-untouched");
		// (i) The protected pinned synthetic survives.
		const pinned = result.messages.find(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.ok(pinned, "the protected pinned synthetic must survive the trim");
		assert.equal(pinned!.content, "p".repeat(1500));
		// (ii) The dispatch task survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "the dispatch task must survive the trim");
		assert.equal(dispatch!.content, "dispatch task — do X");
		// (iii) The preserved-path tool result survives.
		const preserved = result.messages.find(
			(m) => m.role === "toolResult" && m.details?.sourcePath === "/repo/AGENTS.md",
		);
		assert.ok(preserved, "the protected preserved-path tool result must survive the trim");
		assert.equal(preserved!.content, "c".repeat(3000));
		// (iv) All messages are returned unchanged (tier 2 hold-untouched).
		assert.equal(result.messages.length, messages.length, "all messages survive (tier 2 hold-untouched)");
	});

	// (3) `approximateTextTokens` with divisor 3 (the new default) and
	// divisor 4 (the legacy chars/4 default, reachable through the
	// operator-configured knob) — AC-3.
	describe("approximateTextTokens with configurable divisor (AC-3)", () => {
		it("divisor 3: 'hello world' (11 chars) → ceil(11/3) = 4 tokens", async () => {
			assert.equal(approximateTextTokens("hello world", 3), 4);
		});

		it("divisor 4 (the legacy default): 'hello world' (11 chars) → ceil(11/4) = 3 tokens", async () => {
			assert.equal(approximateTextTokens("hello world", 4), 3);
		});

		it("divisor 3: structured content (a JSON-stringified 30-char object) → ceil(30/3) = 10 tokens", async () => {
			const structured = JSON.stringify({ a: 1, b: 2, c: 3, d: 4 });
			const len = structured.length;
			assert.equal(approximateTextTokens(structured, 3), Math.ceil(len / 3));
		});

		it("divisor 3: empty string → 0 tokens", async () => {
			assert.equal(approximateTextTokens("", 3), 0);
		});

		it("divisor 3: TOKEN_ESTIMATOR_DIVISOR_DEFAULT is 3 (the new compile-time default)", async () => {
			assert.equal(TOKEN_ESTIMATOR_DIVISOR_DEFAULT, 3);
		});
	});

	// (4) no-regression: when both `systemPromptTokens` and the
	// protected mass are 0 the trim is identical to the legacy
	// behavior (AC-6).
	it("(4) no-regression (AC-6): systemPromptTokens: 0 + no protected mass → identical to the legacy trim path", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch task — do X", 0),
			assistantMsg("a".repeat(30_000 * 3)),
			assistantMsg("b".repeat(30_000 * 3)),
		];
		const result = await applyThreeTierTrim(messages, {
			verbatimMaxTokens: 50_000,
			summarizeMaxTokens: 100_000,
			systemPromptTokens: 0,
		});
		// Tier 2 hold-untouched.
		assert.equal(result.droppedTurns, 0, "tier 2 hold-untouched");
		// The dispatch task survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "the dispatch task must survive the trim");
		assert.equal(dispatch!.content, "dispatch task — do X");
		// All messages are returned unchanged.
		assert.equal(result.messages.length, messages.length, "all messages survive (tier 2 hold-untouched)");
	});

	// (5) degradation: when the protected mass alone exceeds the
	// verbatim cap, the effective cap is 0 and tier 2 holds
	// untouched (AC-6, no `NaN` / `Infinity` / infinite loop).
	it("(5) degradation (AC-6): protected mass > verbatim cap → effective cap is 0; tier 2 holds untouched; protected slots survive; no NaN/Infinity, no infinite loop", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		// 5 protected pinned synthetics of 12k tokens each
		// (36_000 chars / 3 = 12_000 tokens → total 60k).
		const messages: TrimmableMessage[] = [
			pinnedMsg("p".repeat(36_000)),
			pinnedMsg("p".repeat(36_000)),
			pinnedMsg("p".repeat(36_000)),
			pinnedMsg("p".repeat(36_000)),
			pinnedMsg("p".repeat(36_000)),
			userMsg("dispatch task — do X", 0),
			// 1 trimmable message of ~1k tokens.
			assistantMsg("t".repeat(3_000)),
		];
		const result = await applyThreeTierTrim(messages, {
			protectedCustomTypes: protectedSet,
			verbatimMaxTokens: 50_000,
			summarizeMaxTokens: 100_000,
		});
		// The function returned — no infinite loop.
		assert.ok(result, "the trim function must return (no infinite loop)");
		// The counters are valid finite numbers (no NaN / Infinity).
		assert.equal(typeof result.droppedTurns, "number", "droppedTurns counter is a number");
		assert.ok(Number.isFinite(result.droppedTurns), "droppedTurns counter is finite (no NaN/Infinity)");
		assert.equal(typeof result.totalTokens, "number", "totalTokens counter is a number");
		assert.ok(Number.isFinite(result.totalTokens), "totalTokens counter is finite (no NaN/Infinity)");
		// Tier 2 hold-untouched.
		assert.equal(result.droppedTurns, 0, "tier 2 hold-untouched");
		// The 5 protected pinned synthetics survive.
		const pinnedSurvivors = result.messages.filter(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.equal(pinnedSurvivors.length, 5, "all 5 protected pinned synthetics must survive the trim");
		// The dispatch task survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "the dispatch task must survive the trim");
		assert.equal(dispatch!.content, "dispatch task — do X");
		// All messages are returned unchanged.
		assert.equal(result.messages.length, messages.length, "all messages survive (tier 2 hold-untouched)");
	});
});
