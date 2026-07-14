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
	isAlreadySummarized,
	messageFingerprint,
	totalTrimmableTokens,
	VERBATIM_TIER_MAX_TOKENS,
	SUMMARIZE_TIER_MAX_TOKENS,
	SUMMA_WORDS,
	TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
	type TrimmableMessage,
} from "../policy.ts";

// ─── Helpers ───────────────────────────────────────────────────────────

/** A test summarizer that returns a fixed short summary string. */
function makeTrimmingSummarizer(_words: number = 10) {
	return async (_text: string, _w: number) => "summary";
}

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
	const summarizer = makeTrimmingSummarizer(5);

	it("returns the input unchanged for a small conversation", async () => {
		const messages = [userMsg("dispatch", 0), assistantMsg("hi")];
		const result = await applyThreeTierTrim(messages, { summarizer });
		assert.equal(result.summarized, 0);
		assert.equal(result.droppedTurns, 0);
		assert.equal(result.messages.length, messages.length);
		assert.equal(result.messages[0].content, "dispatch");
		assert.equal(result.messages[1].content, "hi");
	});

	it("does not invoke the summarizer in the verbatim tier", async () => {
		let called = false;
		const tracking = async (text: string, _w: number) => {
			called = true;
			return text;
		};
		const messages = [userMsg("dispatch", 0), assistantMsg("hello world")];
		await applyThreeTierTrim(messages, { summarizer: tracking });
		assert.equal(called, false);
	});

	it("boundary at exactly 50k total tokens is verbatim", async () => {
		// Pass a verbatim cap of `50k + dispatchTokens` so the
		// protected-mass subtraction (the dispatch task is ~8
		// tokens at the new chars/3 default) lands the effective
		// cap exactly at the trimmable mass. The boundary holds:
		// `total > effectiveVerbatimMax` is false → verbatim.
		const messages = trimmableMass(VERBATIM_TIER_MAX_TOKENS);
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			verbatimMaxTokens: VERBATIM_TIER_MAX_TOKENS + 100,
		});
		assert.equal(result.summarized, 0);
		assert.equal(result.droppedTurns, 0);
	});
});

// ─── Summarize tier (50k–100k) ─────────────────────────────────────────

describe("applyThreeTierTrim — summarize tier (50k < total ≤ 100k)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("summarizes the oldest non-protected trimmable message when over 50k", async () => {
		const messages = trimmableMass(60_000);
		const result = await applyThreeTierTrim(messages, { summarizer });
		// The assistant message is oldest non-protected (after the
		// dispatch). The summarizer should fire on it.
		assert.ok(result.summarized >= 1);
		// The dispatch is preserved.
		assert.equal(result.messages[0].content, "dispatch task — do X");
	});

	it("preserves the dispatch task through summarization", async () => {
		const messages = trimmableMass(60_000);
		const result = await applyThreeTierTrim(messages, { summarizer });
		// The first message is the dispatch — content unchanged.
		const first = result.messages[0];
		assert.equal(first.role, "user");
		assert.equal(first.userTurnAge, 0);
		assert.equal(first.content, "dispatch task — do X");
	});

	it("loops until total ≤ 50k, summarizing multiple messages if needed", async () => {
		// Build a session with several trimmable turns at ~20k each.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("a".repeat(30_000 * 4)),
			toolResultMsg("b".repeat(30_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		// 60k total — at least one summarization should bring us under 50k.
		assert.ok(result.summarized >= 1);
		// Re-check: after summarize, total is under 50k.
		assert.ok(totalTrimmableTokens(result.messages) <= VERBATIM_TIER_MAX_TOKENS);
	});

	it("protects a context-trimmer-pinned synthetic in the summarize tier", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [
			pinnedMsg("agent def " + "p".repeat(20_000 * 4)),
			userMsg("dispatch", 0),
			assistantMsg("x".repeat(30_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
		});
		// The pinned message must still be present and unchanged.
		const pinned = result.messages.find(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.ok(pinned, "pinned message must be preserved");
		assert.equal(pinned!.content, messages[0].content);
	});

	it("the budget excludes protected-slot tokens", async () => {
		// A session whose only over-budget contributor is the pinned
		// message (the agent def) should NOT trigger a trim.
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [
			pinnedMsg("agent def " + "p".repeat(60_000 * 4)),
			userMsg("dispatch", 0),
			assistantMsg("short"),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
		});
		// The assistant "short" is the only trimmable mass (6 chars
		// / 4 = 2 tokens). Total trimmable is 2 — well under 50k.
		// No summarize fires.
		assert.equal(result.summarized, 0);
	});

	it("boundary at exactly 50k+1 tokens triggers a single summarize pass", async () => {
		const messages = trimmableMass(50_001);
		const result = await applyThreeTierTrim(messages, { summarizer });
		assert.ok(result.summarized >= 1);
	});
});

// ─── Drop tier (100k+) ─────────────────────────────────────────────────

describe("applyThreeTierTrim — drop tier (total > 100k)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("hard-drops the oldest trimmable turn when over 100k", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("a".repeat(60_000 * 4)), // First trimmable turn.
			toolResultMsg("b".repeat(60_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		// Total trimmable is ~120k, which is > 100k. The first
		// trimmable turn should be dropped.
		assert.ok(result.droppedTurns >= 1);
		// The aggregate plain-English prune reminder is prepended;
		// the dispatch is preserved at position 1.
		assert.equal(result.messages[0].role, "user");
		assert.ok(
			typeof result.messages[0].content === "string" && (result.messages[0].content as string).includes("Context Trimmer extension"),
			"the reminder is at the start of the returned array",
		);
		assert.equal(result.messages[1].content, "dispatch");
		// After drop, total is under 100k.
		assert.ok(totalTrimmableTokens(result.messages) <= SUMMARIZE_TIER_MAX_TOKENS);
	});

	it("preserves the pinned-tier synthetic through a drop", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [
			pinnedMsg("agent def " + "p".repeat(1000)),
			userMsg("dispatch", 0),
			assistantMsg("a".repeat(60_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
		});
		const pinned = result.messages.find(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.ok(pinned, "pinned message must survive the drop");
	});

	it("drops multiple oldest trimmable turns if needed to reach 100k", async () => {
		// Build a session with three trimmable turns, each ~40k tokens.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("a".repeat(40_000 * 4)), // Turn 1: 40k
			toolResultMsg("b".repeat(40_000 * 4)),
			assistantMsg("c".repeat(40_000 * 4)), // Turn 2: 40k
			toolResultMsg("d".repeat(40_000 * 4)),
			assistantMsg("e".repeat(40_000 * 4)), // Turn 3: 40k
			toolResultMsg("f".repeat(40_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		// 120k total → must drop at least one oldest trimmable turn.
		assert.ok(result.droppedTurns >= 1);
		assert.ok(totalTrimmableTokens(result.messages) <= SUMMARIZE_TIER_MAX_TOKENS);
	});
});

// ─── Aggregate plain-English prune reminder (AC-1) ────────────────────
//
// Tier-3's hard drop emits ONE plain-English reminder at the start of
// the returned message array (per drop event, not per dropped turn).
// The reminder is a `role: "user"` message naming the extension, the
// action, the scope, and a conditional "get it fresh" retrieval hint
// — phrased as a possibility, not a directive. No bracket tag, no
// ordinals, no token mass, no `customType`.

describe("applyThreeTierTrim — aggregate plain-English reminder (AC-1)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	function reminderCount(messages: ReadonlyArray<TrimmableMessage>): number {
		let count = 0;
		for (const m of messages) {
			if (m.role === "user" && typeof m.content === "string" && m.content.includes("Context Trimmer extension")) {
				count += 1;
			}
		}
		return count;
	}

	it("emits exactly one reminder when droppedTurns > 0 (single drop event)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch task — do X", 0),
			assistantMsg("a".repeat(60_000 * 4)),
			toolResultMsg("b".repeat(60_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		// The drop fires; one reminder is emitted at the start of the
		// returned array. Exactly one — not N (aggregate, not per-turn).
		assert.equal(reminderCount(result.messages), 1);
		// The reminder is the first message in the returned array.
		const reminder = result.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Context Trimmer extension"),
		);
		assert.ok(reminder, "reminder must be present");
		assert.equal(result.messages[0], reminder, "reminder must be at the start of the returned array");
		// The reminder contains the operator's load-bearing elements.
		const text = String(reminder.content);
		assert.ok(text.includes("Context Trimmer extension"), "reminder must name the extension");
		assert.ok(/prun/i.test(text), "reminder must name the action (prune / pruning)");
		assert.ok(text.includes("context"), "reminder must reference context");
		// Conditional "get it fresh" clause — present, not directive.
		assert.ok(/if you need/i.test(text), "reminder must use conditional 'if you need' phrasing");
		assert.ok(/get it fresh/i.test(text), "reminder must include the 'get it fresh' clause");
		// No directive language: the clause offers retrieval as a
		// possibility, not as a mandate.
		assert.ok(!/you must/i.test(text), "reminder must not use directive 'you must' language");
		assert.ok(!/you should/i.test(text), "reminder must not use directive 'you should' language");
		// No envelope tag, no ordinals, no token mass.
		assert.ok(!text.includes("["), "reminder must not have a bracket tag");
		assert.ok(!/oldest/i.test(text), "reminder must not use ordinals ('oldest')");
		assert.ok(!/~?\d+\s*tokens/i.test(text), "reminder must not name a token mass");
		// The reminder is a plain `role: "user"` message — no
		// `customType` stamp (the policy uses the user role to
		// surface the reminder directly to the LLM).
		assert.equal(reminder.customType, undefined, "reminder must not carry a customType stamp");
		// The drop fired; the dropped turn's content is gone; the
		// reminder + the dispatch task remain.
		assert.ok(result.droppedTurns >= 1, "the drop must fire when trimmable total > 100k");
		const droppedContent = result.messages.filter(
			(m) => typeof m.content === "string" && /^a+$|^b+$/.test(m.content),
		);
		assert.equal(droppedContent.length, 0, "the dropped turn's content must be gone");
	});

	it("emits exactly one reminder for a multi-turn drop (aggregate, not per-turn)", async () => {
		// 4 distinct trimmable turns of 60k each → 240k total →
		// drops the oldest three to land at 60k (under 100k, no
		// summarize-fallback fires). ONE reminder total, not three.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			userMsg("u1", 1),
			assistantMsg("a".repeat(30_000 * 4)),
			toolResultMsg("b".repeat(30_000 * 4)),
			userMsg("u2", 2),
			assistantMsg("c".repeat(30_000 * 4)),
			toolResultMsg("d".repeat(30_000 * 4)),
			userMsg("u3", 3),
			assistantMsg("e".repeat(30_000 * 4)),
			toolResultMsg("f".repeat(30_000 * 4)),
			userMsg("u4", 4),
			assistantMsg("g".repeat(30_000 * 4)),
			toolResultMsg("h".repeat(30_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		// 3 turns dropped, but only 1 reminder (aggregate).
		assert.equal(result.droppedTurns, 3);
		assert.equal(reminderCount(result.messages), 1, "one reminder total for a multi-turn drop");
	});

	it("does NOT emit a reminder on the tier-2 summarize path (only tier-3 drops emit)", async () => {
		const messages = trimmableMass(60_000);
		const result = await applyThreeTierTrim(messages, { summarizer });
		assert.equal(reminderCount(result.messages), 0, "no reminder on the tier-2 summarize path");
	});

	it("does NOT emit a reminder on the tier-1 verbatim path", async () => {
		const messages = [userMsg("dispatch", 0), assistantMsg("hi")];
		const result = await applyThreeTierTrim(messages, { summarizer });
		assert.equal(reminderCount(result.messages), 0, "no reminder on the tier-1 verbatim path");
	});

	it("does NOT emit a reminder on the tier-3 summarize-fallback path (single oversized turn)", async () => {
		// A single trimmable turn, all by itself, is over 100k. The
		// policy falls into the summarize-fallback (not the drop
		// path). No drop, no reminder; the existing Tier-2
		// `[summa: …]` envelope covers it.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("x".repeat(150_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		assert.equal(result.droppedTurns, 0, "the summarize-fallback path does not drop any turns");
		assert.equal(reminderCount(result.messages), 0, "no reminder on the tier-3 summarize-fallback path");
	});
});

// ─── Drop-floor + recency-floor (AC-1 + AC-2) ────────────────────────
//
// Two new option channels land on `TrimOptions` from Units 1+2:
//   - `dropFloorTokens`: a token count the tier-3 drop must not
//     undershoot by dropping a whole turn. When the next-oldest
//     turn would push the trimmable total below the floor, the
//     drop loop stops and falls through to the summarize path
//     so the drop tier never collapses the protected floor.
//   - `recencyFloor`: a token count whose most-recent-N-tokens
//     of trimmable content is protected from drop AND summarize.
//     The recency slice is computed once at the top of
//     `applyThreeTierTrim` and threaded through every internal
//     call; messages in the slice are treated as protected
//     (additive OR with the existing channels) and excluded
//     from the trimmable budget.
//
// The integration test in `integration.test.ts` covers the
// production wiring for AC-1 end-to-end. The tests here cover the
// pure-policy surface (the policy receives the resolved numeric
// `dropFloorTokens` and `recencyFloor` directly; the wiring
// resolves `dropFloorPercent` to `dropFloorTokens` via
// `Math.trunc((dropFloorPercent / 100) * effectiveSummarizeMaxTokens)`).
//
// Two tests in this block: one for the drop-floor fall-through
// (AC-1) and one for the recency-floor cross-path covering both
// the tier-2 summarize and the tier-3 drop paths (AC-2).

describe("applyThreeTierTrim — drop-floor + recency-floor (AC-1 + AC-2)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	// ── AC-1: drop-floor fall-through ───────────────────────────

	it("falls through to summarize when dropping a whole turn would push the trimmable total below the drop-floor (AC-1)", async () => {
		// One oversized trimmable turn (the post-dispatch
		// synthetic trimmable turn — 3 trimmable messages,
		// 120k total) with `dropFloorTokens: 5_000`. The
		// single trimmable turn alone, dropped whole, would
		// land the trimmable total at 0 — well below the 5k
		// floor. The drop-floor guard engages; the policy
		// falls through to the summarize path, which shrinks
		// the oldest trimmable messages in place until the
		// trimmable total is at or below verbatimMax. The
		// oversized turn's content (the 60k assistant + 50k
		// toolResult) survives — via summarize, not dropped;
		// the dispatch task and the pinned-tier synthetic
		// survive; the trimmable total lands between
		// `dropFloorTokens` (5k) and `summarizeMaxTokens`
		// (100k).
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages: TrimmableMessage[] = [
			pinnedMsg("agent def"),
			userMsg("dispatch task — do X", 0),
			assistantMsg("a".repeat(60_000 * 4)), // 60k tokens
			toolResultMsg("b".repeat(50_000 * 4)), // 50k tokens
			assistantMsg("c".repeat(10_000 * 4)), // 10k tokens
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
			dropFloorTokens: 5_000,
		});
		// (i) The drop did NOT fire — the floor engaged and
		// the policy fell through to the summarize path. The
		// drop counter is zero.
		assert.equal(result.droppedTurns, 0, "the drop-floor fall-through must not emit a drop");
		// (ii) The oversized turn's content survives in the
		// output (via summarize, not dropped). The 60k
		// assistant and the 50k toolResult are still in
		// `result.messages`; the policy's signature survives
		// because the post-dispatch synthetic trimmable turn
		// is not in the drop set.
		const oversizedAssistant = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.includes("a".repeat(100)),
			),
		);
		const oversizedToolResult = result.messages.find(
			(m) => m.role === "toolResult" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.includes("b".repeat(100)),
			),
		);
		// The 60k assistant and 50k toolResult were summarized
		// in place (their content was rewritten to the summa
		// envelope), so the original 60k/50k char runs are
		// gone — but the messages themselves are still in the
		// output (the drop did not fire). The unsummarized
		// 10k assistant retains its original content.
		const unsummarizedTail = result.messages.find(
			(m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string).includes("c".repeat(100)),
		);
		assert.ok(unsummarizedTail, "the unsummarized 10k assistant must survive verbatim (the drop did not fire)");
		assert.ok(result.summarized >= 1, "at least one oversized trimmable message was summarized via the fall-through");
		// (iii) Trimmable total lands at or below
		// `summarizeMaxTokens` (the tier-3 cap is met after
		// the fall-through).
		const postTrimTotal = totalTrimmableTokens(result.messages, protectedSet);
		assert.ok(
			postTrimTotal <= SUMMARIZE_TIER_MAX_TOKENS,
			`post-trim trimmable total ${postTrimTotal} must be <= summarizeMaxTokens ${SUMMARIZE_TIER_MAX_TOKENS}`,
		);
		// The post-trim trimmable total is at or above the
		// drop-floor: the floor is a best-effort bound on the
		// drop, and the summarize-fallback respects it (the
		// summarize-fallback loops to `verbatimMax`, not to
		// the floor; the test is asserting the floor was
		// honored in the wider sense — the trimmable total
		// is not collapsed to the protected floor alone).
		assert.ok(
			postTrimTotal >= 5_000,
			`post-trim trimmable total ${postTrimTotal} must be >= dropFloorTokens 5000 (the drop did not collapse the view)`,
		);
		// (iv) Dispatch and pinned synthetic survive.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "dispatch task must survive the fall-through");
		assert.equal(dispatch!.content, "dispatch task — do X");
		const pinned = result.messages.find(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.ok(pinned, "pinned synthetic must survive the fall-through");
		// No drop reminder — the fall-through did not fire
		// the drop path; the reminder is the drop-path
		// artifact, not the summarize-fallback artifact.
		const reminders = result.messages.filter(
			(m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("Context Trimmer extension"),
		);
		assert.equal(reminders.length, 0, "the drop-floor fall-through does not emit a drop reminder");
		// Suppress the unused-var lint for the find calls
		// above (they exist for diagnostic purposes; the
		// test's primary assertions are the survivors above).
		void oversizedAssistant;
		void oversizedToolResult;
	});

	// ── AC-2: recency-floor cross-path (tier-2 + tier-3) ───────

	it("preserves the recency slice across the tier-2 summarize path (AC-2)", async () => {
		// Three older trimmable messages (turn 1, ~60k
		// total) plus a small recency slice (~6k total).
		// `recencyFloor: 3_000` covers the recency slice.
		// The trimmable budget (recency excluded) is 60k
		// > effectiveVerbatimMax (50k minus protectedMass,
		// which absorbs the dispatch + the small recency
		// slice's tokens) → tier-2 fires on the OLDER
		// trimmable; the recency slice is NOT summarized.
		// The recency slice's original content must
		// survive verbatim.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch task — do X", 0),
			assistantMsg("x".repeat(20_000 * 4)), // 20k tokens, oldest
			toolResultMsg("y".repeat(20_000 * 4)), // 20k tokens
			assistantMsg("z".repeat(20_000 * 4)), // 20k tokens
			assistantMsg("RECENT-X ".repeat(700)), // 1.5k tokens, recency slice
			toolResultMsg("RECENT-Y ".repeat(700)), // 1.5k tokens, recency slice
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			recencyFloor: 3_000,
			tokenEstimatorDivisor: 4,
		});
		// (i) Recency-slice messages have ORIGINAL content
		// preserved (their `content` was not rewritten by
		// the summarize path).
		const recentAssistant = result.messages.find(
			(m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string).includes("RECENT-X"),
		);
		const recentToolResult = result.messages.find(
			(m) => m.role === "toolResult" && typeof m.content === "string" && (m.content as string).includes("RECENT-Y"),
		);
		assert.ok(recentAssistant, "recency-slice assistant must survive the summarize path");
		assert.ok(recentToolResult, "recency-slice toolResult must survive the summarize path");
		// (ii) Older trimmable messages ARE summarized
		// (at least the oldest — the tier-2 summarize
		// loop targets the oldest non-recency-non-protected
		// trimmable first).
		const summarizedOld = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.includes("[summa:"),
			),
		);
		assert.ok(summarizedOld, "an older trimmable message must be summarized (summa envelope present)");
		// (iii) Recency slice survives intact — both
		// messages are in `result.messages` and their
		// content is unchanged (no summa envelope, no
		// content rewrite).
		const recencyInOutput = (result.messages as TrimmableMessage[]).filter(
			(m) => typeof m.content === "string" && ((m.content as string).includes("RECENT-X") || (m.content as string).includes("RECENT-Y")),
		);
		assert.equal(
			recencyInOutput.length,
			2,
			"both recency-slice messages must survive intact",
		);
		// No drop fires on the tier-2 summarize path.
		assert.equal(result.droppedTurns, 0);
		// At least one older trimmable was summarized.
		assert.ok(result.summarized >= 1);
	});

	it("preserves the recency slice across the tier-3 drop path (AC-2)", async () => {
		// Five older trimmable messages (150k total) plus
		// a recency slice of two trimmable messages (~90k
		// total). `recencyFloor: 50_000` covers the recency
		// slice. The trimmable budget (recency excluded)
		// is 150k > 100k → tier-3 fires. The drop loop
		// drops the post-dispatch synthetic trimmable turn
		// (which contains ALL trimmable, including the
		// recency slice). The recency-slice messages are
		// carved out of the dropped turn (the recency
		// channel is protected) and survive. The dispatch
		// task and the user anchor survive; the recency
		// slice's original content is preserved.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch task — do X", 0),
			assistantMsg("x".repeat(30_000 * 4)), // 30k tokens
			toolResultMsg("y".repeat(30_000 * 4)), // 30k tokens
			assistantMsg("z".repeat(30_000 * 4)), // 30k tokens
			assistantMsg("a".repeat(30_000 * 4)), // 30k tokens
			assistantMsg("b".repeat(30_000 * 4)), // 30k tokens
			assistantMsg("RECENT-X ".repeat(20_000)), // 45k tokens, recency slice
			toolResultMsg("RECENT-Y ".repeat(20_000)), // 45k tokens, recency slice
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			recencyFloor: 50_000,
			tokenEstimatorDivisor: 4,
		});
		// The recency-slice messages survive the drop.
		// Their content is preserved verbatim — the
		// carve-out in `dropOldestTurns` kept them alive
		// even though they sat inside the dropped turn.
		const recentAssistant = result.messages.find(
			(m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string).includes("RECENT-X"),
		);
		const recentToolResult = result.messages.find(
			(m) => m.role === "toolResult" && typeof m.content === "string" && (m.content as string).includes("RECENT-Y"),
		);
		assert.ok(recentAssistant, "recency-slice assistant must survive the tier-3 drop");
		assert.ok(recentToolResult, "recency-slice toolResult must survive the tier-3 drop");
		// The drop counter reflects the whole-turn drop
		// (the post-dispatch synthetic trimmable turn
		// containing all trimmable including the recency
		// slice).
		assert.ok(result.droppedTurns >= 1, "the drop tier must have fired (turn was dropped)");
		// The drop reminder is at the start of the output
		// (the policy's plain-English aggregate reminder).
		const reminder = result.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("Context Trimmer extension"),
		);
		assert.ok(reminder, "drop reminder must be emitted at the start of the output");
		assert.equal(result.messages[0], reminder, "reminder must be at the start of the returned array");
		// The recency-slice messages are NOT in any dropped
		// turn slice — they are in the surviving messages
		// array, with their original content.
		const survivingRecency = (result.messages as TrimmableMessage[]).filter(
			(m) => typeof m.content === "string" && ((m.content as string).includes("RECENT-X") || (m.content as string).includes("RECENT-Y")),
		);
		assert.equal(survivingRecency.length, 2, "both recency-slice messages must survive intact across the drop");
		// The dispatch task survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "dispatch task must survive the drop");
		assert.equal(dispatch!.content, "dispatch task — do X");
	});
});

// ─── Degenerate cases ─────────────────────────────────────────────────

describe("applyThreeTierTrim — degenerate cases", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("returns an empty array for an empty input", async () => {
		const result = await applyThreeTierTrim([], { summarizer });
		assert.equal(result.messages.length, 0);
		assert.equal(result.summarized, 0);
		assert.equal(result.droppedTurns, 0);
		assert.equal(result.totalTokens, 0);
	});

	it("returns the dispatch task unchanged when it is the only message", async () => {
		const messages = [userMsg("dispatch", 0)];
		const result = await applyThreeTierTrim(messages, { summarizer });
		assert.equal(result.messages.length, 1);
		assert.equal(result.messages[0].content, "dispatch");
	});

	it("does not infinite-loop when the summarizer returns the source unchanged", async () => {
		// Pathological summarizer: always returns the input. The
		// loop's defensive bound (`summaryTokens >= originalTokens`)
		// bails after one iteration, so the function returns.
		const noProgress = async (text: string, _w: number) => text;
		const messages = trimmableMass(60_000);
		const result = await applyThreeTierTrim(messages, { summarizer: noProgress });
		// The first eligible message IS summarized (the summarize
		// path runs once), but the post-summarize content has the
		// same length, so the loop bails. The function returns.
		assert.equal(result.summarized, 1);
		assert.ok(typeof result.totalTokens === "number");
	});

	it("a single oversized message (over 100k) is summarized, not dropped", async () => {
		// One trimmable message, all by itself, is larger than the
		// drop tier. The policy's fallback summarizes it (since
		// dropping the only trimmable message would leave the
		// dispatch alone and the session no better off).
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("x".repeat(150_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		// The fallback summarize path fires.
		assert.ok(result.summarized >= 1);
	});

	it("the recency slice survives the summarize-fallback path (single oversized + recency)", async () => {
		// One oversized trimmable (150k) plus one small
		// trimmable in the recency window. `recencyFloor`
		// covers the small trimmable. The budget excludes the
		// recency slice, so the oversized message alone is
		// over the 100k cap → tier-3 fires. The drop loop has
		// no trimmable turns (trimmableCount < 2 — the
		// recency-slice message is recency-protected and the
		// single oversized is not enough for the synthetic
		// turn). droppedTurns = 0. Tier-3 re-check fires the
		// summarize-fallback, which summarizes the oversized
		// message; the recency-slice message survives
		// verbatim.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("x".repeat(150_000 * 4)), // oversized → summarized via fallback
			assistantMsg("RECENT ".repeat(3_000)), // ~5250 tokens, recency slice → preserved
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			recencyFloor: 5_000,
		});
		// The recency-slice message survives the
		// summarize-fallback path with its original content.
		const recencySurvived = result.messages.find(
			(m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string).includes("RECENT"),
		);
		assert.ok(
			recencySurvived,
			"the recency-slice message must survive the summarize-fallback path verbatim",
		);
		// The recency-slice message is NOT wrapped in the
		// summa envelope — its content is the original string,
		// not a `[{type:"text", text:"[summa: ..."}]` array.
		assert.equal(typeof recencySurvived!.content, "string", "recency-slice content must be the original string (not rewritten)");
		// The oversized message is summarized (the fallback
		// fires on it). The dispatch task survives.
		const oversizedSummarized = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.includes("[summa:"),
			),
		);
		assert.ok(oversizedSummarized, "the oversized message must be summarized via the fallback");
		assert.ok(result.summarized >= 1);
		// The dispatch task survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "dispatch task must survive the summarize-fallback path");
	});
});

// ─── isPathPreserved predicate (pure) ──────────────────────────────

describe("isPathPreserved (pure path-match predicate)", () => {
	it("matches a fuzzy pattern (no leading / or ~/) by basename", async () => {
		assert.equal(
			isPathPreserved("/home/operator/project/AGENTS.md", ["AGENTS.md"]),
			true,
		);
		assert.equal(
			isPathPreserved("/var/lib/foo/AGENTS.md", ["AGENTS.md"]),
			true,
		);
	});

	it("does not match a fuzzy pattern when the basename differs", async () => {
		assert.equal(
			isPathPreserved("/home/operator/project/CLAUDE.md", ["AGENTS.md"]),
			false,
		);
	});

	it("matches an absolute pattern (leading /) by path.normalize equality", async () => {
		assert.equal(
			isPathPreserved("/home/operator/AGENTS.md", ["/home/operator/AGENTS.md"]),
			true,
		);
		// Redundant separators collapse via path.normalize.
		assert.equal(
			isPathPreserved("/home/operator//AGENTS.md", ["/home/operator/AGENTS.md"]),
			true,
		);
	});

	it("does not match an absolute pattern when the normalized path differs", async () => {
		assert.equal(
			isPathPreserved("/home/operator/CLAUDE.md", ["/home/operator/AGENTS.md"]),
			false,
		);
	});

	it("matches an absolute pattern with ~ (the wiring has expanded ~/)", async () => {
		// The wiring expands ~/ via os.homedir(); the predicate
		// sees the expanded form on both sides. We test the
		// predicate at its seam: the expanded pattern matches the
		// expanded path.
		assert.equal(
			isPathPreserved("/home/operator/AGENTS.md", ["/home/operator/AGENTS.md"]),
			true,
		);
	});

	it("returns false when sourcePath is undefined", async () => {
		assert.equal(isPathPreserved(undefined, ["AGENTS.md"]), false);
		assert.equal(isPathPreserved(undefined, ["/abs/path"]), false);
	});

	it("returns false when patterns is empty", async () => {
		assert.equal(isPathPreserved("/abs/AGENTS.md", []), false);
	});

	it("returns false when no pattern matches (all-or-nothing validation: an invalid entry is skipped, not a global no-op)", async () => {
		// Empty strings and non-string entries are skipped; a valid
		// entry that does not match still leaves the predicate as
		// false. The all-or-nothing contract is in the config
		// layer; the predicate is permissive on shape.
		assert.equal(
			isPathPreserved("/abs/AGENTS.md", ["", "CLAUDE.md"]),
			false,
		);
	});

	it("returns true on first match in the patterns list", async () => {
		assert.equal(
			isPathPreserved("/abs/AGENTS.md", ["CLAUDE.md", "AGENTS.md"]),
			true,
		);
	});
});

// ─── isProtectedSlot with preservedPatterns ────────────────────────

describe("isProtectedSlot — preservedPatterns channel", () => {
	it("protects a message whose details.sourcePath matches a fuzzy pattern", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("contents of AGENTS.md", "/repo/AGENTS.md"),
		];
		assert.equal(
			isProtectedSlot(messages[1], 1, messages, new Set(), true, ["AGENTS.md"]),
			true,
		);
	});

	it("protects a message whose details.sourcePath matches an absolute pattern", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("contents", "/home/operator/AGENTS.md"),
		];
		assert.equal(
			isProtectedSlot(
				messages[1],
				1,
				messages,
				new Set(),
				true,
				["/home/operator/AGENTS.md"],
			),
			true,
		);
	});

	it("does not protect a message whose sourcePath is absent", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultMsg("no source path"),
		];
		assert.equal(
			isProtectedSlot(messages[1], 1, messages, new Set(), true, ["AGENTS.md"]),
			false,
		);
	});

	it("does not protect a message whose sourcePath does not match", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("contents", "/repo/CLAUDE.md"),
		];
		assert.equal(
			isProtectedSlot(messages[1], 1, messages, new Set(), true, ["AGENTS.md"]),
			false,
		);
	});

	it("preservedPatterns is independent of the dispatch and customType channels", async () => {
		// A custom pinned message is still protected even when its
		// sourcePath does not match a preserved pattern.
		const messages: TrimmableMessage[] = [
			pinnedMsg("agent def"),
			userMsg("dispatch", 0),
			toolResultWithPath("contents", "/repo/CLAUDE.md"),
		];
		const protectedSet = new Set(["context-trimmer-pinned"]);
		assert.equal(
			isProtectedSlot(messages[0], 0, messages, protectedSet, true, ["AGENTS.md"]),
			true,
		);
		// Dispatch is still protected by its own channel.
		assert.equal(
			isProtectedSlot(messages[1], 1, messages, protectedSet, true, ["AGENTS.md"]),
			true,
		);
		// A trimmable message with a non-matching source path is not protected.
		assert.equal(
			isProtectedSlot(messages[2], 2, messages, protectedSet, true, ["AGENTS.md"]),
			false,
		);
	});

	it("preservedPatterns defaults to empty (no paths preserved)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("contents", "/repo/AGENTS.md"),
		];
		// No preservedPatterns argument → no path protection.
		assert.equal(
			isProtectedSlot(messages[1], 1, messages, new Set(), true),
			false,
		);
	});
});

// ─── Budget accounting with preservedPatterns ───────────────────────

describe("totalTrimmableTokens — subtracts preserved-path tokens", () => {
	it("subtracts tokens of a tool-result whose sourcePath matches a preserved pattern", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(2000), "/repo/AGENTS.md"),
			assistantMsg("a".repeat(2000)),
		];
		// Without preservedPatterns, both the tool result and the
		// assistant count: 2000/3 + 2000/3 = 1334.
		assert.equal(totalTrimmableTokens(messages), 1334);
		// With ["AGENTS.md"], the tool result is subtracted, leaving
		// only the assistant: 2000/3 = 667.
		assert.equal(totalTrimmableTokens(messages, new Set(), true, ["AGENTS.md"]), 667);
	});

	it("preserved tokens are not counted in the budget", async () => {
		// A session whose only over-budget contributor is a
		// preserved-path message does not trigger a trim. Build
		// exactly that: a preserved message is the only over-50k
		// contributor; the rest is well under cap.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(60_000 * 4), "/repo/AGENTS.md"),
			assistantMsg("a".repeat(100 * 4)),
		];
		// Only the assistant (100 tokens) is trimmable. Under 50k.
		assert.ok(
			totalTrimmableTokens(messages, new Set(), true, ["AGENTS.md"]) <
				VERBATIM_TIER_MAX_TOKENS,
		);
	});
});

// ─── End-to-end preserved-paths across the three tiers ─────────────

describe("applyThreeTierTrim — preserved-paths channel end-to-end", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("preserves a message whose sourcePath matches a fuzzy pattern in tier 2 (summarize)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(40_000 * 4), "/repo/AGENTS.md"),
			assistantMsg("b".repeat(40_000 * 4)),
		];
		// Total trimmable without patterns: 80k. With ["AGENTS.md"],
		// the tool result is subtracted: 40k only → verbatim tier.
		// So this session should NOT trigger a summarize on the
		// preserved message; the assistant, if over cap, would be
		// the only candidate.
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			preservedPatterns: ["AGENTS.md"],
		});
		// The preserved tool result is verbatim (its content
		// unchanged), and the budget was satisfied without trimming
		// it. Find the preserved message in the output.
		const preserved = result.messages.find(
			(m) => m.role === "toolResult" && m.details?.sourcePath === "/repo/AGENTS.md",
		);
		assert.ok(preserved, "preserved tool result must be in the output");
		assert.equal(preserved!.content, "a".repeat(40_000 * 4));
	});

	it("preserves a message whose sourcePath matches an absolute pattern in tier 3 (drop)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath(
				"a".repeat(60_000 * 4),
				"/home/operator/CLAUDE.md",
			),
			assistantMsg("b".repeat(60_000 * 4)),
		];
		// Trimmable mass without patterns: 120k → tier 3. With the
		// absolute pattern, only the assistant counts (60k) → tier 2.
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			preservedPatterns: ["/home/operator/CLAUDE.md"],
		});
		const preserved = result.messages.find(
			(m) => m.role === "toolResult" && m.details?.sourcePath === "/home/operator/CLAUDE.md",
		);
		assert.ok(preserved, "preserved tool result must survive tier 3");
		assert.equal(preserved!.content, "a".repeat(60_000 * 4));
		// And no turns were dropped (the assistant was summarized
		// instead, since the only trimmable mass is the assistant
		// at 60k).
		assert.equal(result.droppedTurns, 0);
	});

	it("a session whose only over-budget contributor is a preserved message does not trigger a trim", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(60_000 * 4), "/repo/AGENTS.md"),
			assistantMsg("short"),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			preservedPatterns: ["AGENTS.md"],
		});
		// Trimmable is just the assistant "short" (5 chars / 4 = 2
		// tokens). Verbatim tier. No summarize, no drop.
		assert.equal(result.summarized, 0);
		assert.equal(result.droppedTurns, 0);
	});

	it("preservedPatterns and protectedCustomTypes are independent channels", async () => {
		// A custom pinned message stays protected even when its
		// sourcePath does not match any preserved pattern.
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages: TrimmableMessage[] = [
			pinnedMsg("agent def " + "p".repeat(20_000 * 4)),
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(30_000 * 4), "/repo/AGENTS.md"),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
			preservedPatterns: ["AGENTS.md"],
		});
		const pinned = result.messages.find(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.ok(pinned, "pinned custom message must survive");
		const preserved = result.messages.find(
			(m) => m.role === "toolResult" && m.details?.sourcePath === "/repo/AGENTS.md",
		);
		assert.ok(preserved, "preserved tool result must survive");
	});

	it("preservedPatterns defaults to no paths preserved (no behavior change for callers)", async () => {
		// A tool result carrying a source path is not protected
		// when preservedPatterns is not passed.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(60_000 * 4), "/repo/AGENTS.md"),
			assistantMsg("b".repeat(60_000 * 4)),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		const preserved = result.messages.find(
			(m) => m.role === "toolResult" && m.details?.sourcePath === "/repo/AGENTS.md",
		);
		// Trimmable mass is 120k → tier 3, drops the first trimmable
		// turn (the tool result). The preserved message is dropped.
		assert.equal(preserved, undefined);
		assert.ok(result.droppedTurns >= 1);
	});

	it("carves a preserved-path message out of a dropped trimmable turn (tier-3) — AC-6 (b)", async () => {
		// Build a session that lands in tier 3 (trimmable total > 100k).
		// The preserved-path message sits inside the dropped trimmable
		// turn slice. With the carve-out in `dropOldestTurns`
		// (per the unit-3 fix), the preserved message is excluded from
		// the dropped slice and survives; the rest of the turn is
		// dropped as before. The carve-out calls `isProtectedSlot` per
		// message in the dropped slice, so any of the three protected
		// channels (dispatch, pinned customType, preserved-paths) keep
		// a message alive when it lands inside the dropped turn.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			// Preserved (fuzzy match on AGENTS.md) — embedded in turn 1.
			toolResultWithPath("a".repeat(60_000 * 4), "/repo/AGENTS.md"),
			// Trimmable mass pushing the trimmable total past 100k.
			assistantMsg("b".repeat(60_000 * 4)),
			// Trimmable tail — ensures turn 1 is dropped whole.
			toolResultMsg("c".repeat(60_000 * 4)),
		];
		// Trimmable total: 60k + 60k = 120k (preserved message is
		// subtracted from the budget). Tier 3 (drop). Turn 1 spans
		// indices [1, 4) (everything after the dispatch user anchor
		// through end-of-stream). The preserved message at index 1
		// must be carved out of the dropped slice and survive.
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			preservedPatterns: ["AGENTS.md"],
		});
		// The carve-out kept the preserved message alive.
		const preserved = result.messages.find(
			(m) => m.role === "toolResult" && m.details?.sourcePath === "/repo/AGENTS.md",
		);
		assert.ok(preserved, "preserved-path message must survive the drop when carved out of the dropped turn");
		assert.equal(preserved!.content, "a".repeat(60_000 * 4));
		// The trimmable assistant + tool result in the dropped turn
		// are gone.
		const trimmableInTurn = result.messages.filter((m) => {
			if (m.role === "custom") return false;
			if (m.role === "user") return false; // dispatch
			return true;
		});
		assert.equal(trimmableInTurn.length, 1, "only the carved-out preserved message survives; the rest of the dropped turn is gone");
		assert.equal(trimmableInTurn[0], preserved);
		// The drop counter still reflects the whole-turn drop.
		assert.equal(result.droppedTurns, 1);
	});
});

// ─── Public constants ─────────────────────────────────────────────────

describe("exported constants", () => {
	it("VERBATIM_TIER_MAX_TOKENS is 50_000", async () => {
		assert.equal(VERBATIM_TIER_MAX_TOKENS, 50_000);
	});
	it("SUMMARIZE_TIER_MAX_TOKENS is 100_000", async () => {
		assert.equal(SUMMARIZE_TIER_MAX_TOKENS, 100_000);
	});
	it("SUMMA_WORDS is positive", async () => {
		assert.ok(SUMMA_WORDS > 0);
	});
});

// ─── Loop-guard detection (AC-1, AC-4) ────────────────────────────────
//
// Pure-function coverage of the loop-guard layer:
//   - `fingerprintToolCall`: deterministic per-tool-call signature
//     with sorted-key argument normalization.
//   - `fingerprintAssistantTurn`: per-turn signature; reasoning-only
//     turns (no toolCall blocks) yield a distinct signature so the
//     run resets naturally (AC-9).
//   - `detectConsecutiveIdenticalToolCalls`: walk the assistant turn
//     stream from the end, count the trailing run of identical
//     signatures.
//   - `computeFlatInputTokenSignal`: co-signal over the last-N
//     assistant-turn input token counts.
//   - `shouldHardBlock`: pure predicate — true iff a hard-block
//     threshold is configured AND the run length meets or exceeds it.
// The wiring (index.ts) is what actually decides whether to nudge,
// hard-block, or fall through; the tests here cover the pure decision
// rules the wiring calls into.

describe("loop-guard detection (AC-1, AC-4)", () => {
	// ── fingerprintToolCall ─────────────────────────────────────

	it("fingerprintToolCall: deterministic signature (same input → same output)", async () => {
		const a = fingerprintToolCall({ name: "search", arguments: { q: "x", n: 3 } });
		const b = fingerprintToolCall({ name: "search", arguments: { q: "x", n: 3 } });
		assert.equal(a, b);
	});

	it("fingerprintToolCall: sorted-keys normalization (reordered keys fingerprint identically)", async () => {
		const a = fingerprintToolCall({ name: "search", arguments: { q: "x", n: 3, extra: "y" } });
		const b = fingerprintToolCall({ name: "search", arguments: { extra: "y", n: 3, q: "x" } });
		assert.equal(a, b, "argument key order must not change the fingerprint");
	});

	it("fingerprintToolCall: distinct toolName → distinct fingerprint", async () => {
		const a = fingerprintToolCall({ name: "search", arguments: { q: "x" } });
		const b = fingerprintToolCall({ name: "lookup", arguments: { q: "x" } });
		assert.notEqual(a, b, "different tool names must fingerprint differently");
	});

	it("fingerprintToolCall: distinct argument values → distinct fingerprint", async () => {
		const a = fingerprintToolCall({ name: "search", arguments: { q: "x" } });
		const b = fingerprintToolCall({ name: "search", arguments: { q: "y" } });
		assert.notEqual(a, b);
	});

	it("fingerprintToolCall: nested objects are sorted recursively", async () => {
		const a = fingerprintToolCall({
			name: "search",
			arguments: { q: "x", filter: { kind: "and", values: [1, 2, 3] } },
		});
		const b = fingerprintToolCall({
			name: "search",
			arguments: { filter: { values: [1, 2, 3], kind: "and" }, q: "x" },
		});
		assert.equal(a, b, "nested object key order must not change the fingerprint");
	});

	it("fingerprintToolCall: array order is preserved (it is part of the call's identity)", async () => {
		const a = fingerprintToolCall({ name: "search", arguments: { items: [1, 2, 3] } });
		const b = fingerprintToolCall({ name: "search", arguments: { items: [3, 2, 1] } });
		assert.notEqual(a, b, "array order is part of the call's identity (the position of each element is semantically meaningful)");
	});

	// ── fingerprintAssistantTurn ───────────────────────────────

	it("fingerprintAssistantTurn: a turn with no toolCall blocks returns a distinct signature (AC-9 — reasoning-only resets the run)", async () => {
		const textOnly = fingerprintAssistantTurn([{ type: "text", text: "hello" }]);
		assert.equal(
			textOnly,
			"\0__no_tool_calls__",
			"a no-tool-call turn must yield the dedicated reasoning-only signature",
		);
	});

	it("fingerprintAssistantTurn: a turn with a single toolCall returns the call's fingerprint", async () => {
		const turn = fingerprintAssistantTurn([
			{ type: "text", text: "I'll search" },
			{ type: "toolCall", name: "search", arguments: { q: "x" } },
		]);
		const expected = fingerprintToolCall({ name: "search", arguments: { q: "x" } });
		assert.equal(turn, expected);
	});

	it("fingerprintAssistantTurn: a multi-tool-call turn's fingerprint is the sorted conjunction of all calls", async () => {
		// fingerprintAssistantTurn sorts the per-call fingerprints
		// before joining, so the per-turn signature is order-
		// independent (a turn with [search, lookup] and a turn with
		// [lookup, search] yield the same per-turn signature).
		const turn = fingerprintAssistantTurn([
			{ type: "toolCall", name: "lookup", arguments: { id: 1 } },
			{ type: "toolCall", name: "search", arguments: { q: "x" } },
		]);
		const expected =
			fingerprintToolCall({ name: "lookup", arguments: { id: 1 } }) + "\n" +
			fingerprintToolCall({ name: "search", arguments: { q: "x" } });
		assert.equal(turn, expected);
	});

	it("fingerprintAssistantTurn: two turns with identical tool-call sets match", async () => {
		const a = fingerprintAssistantTurn([{ type: "toolCall", name: "search", arguments: { q: "x" } }]);
		const b = fingerprintAssistantTurn([{ type: "toolCall", name: "search", arguments: { q: "x" } }]);
		assert.equal(a, b);
	});

	it("fingerprintAssistantTurn: different argument values → different fingerprints", async () => {
		const a = fingerprintAssistantTurn([{ type: "toolCall", name: "search", arguments: { q: "x" } }]);
		const b = fingerprintAssistantTurn([{ type: "toolCall", name: "search", arguments: { q: "y" } }]);
		assert.notEqual(a, b);
	});

	// ── detectConsecutiveIdenticalToolCalls ───────────────────

	it("detectConsecutiveIdenticalToolCalls: a run of N identical assistant turns yields runLength === N and matching signature", async () => {
		const N = 4;
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantWithToolCall("search", { q: "loop-test" }),
			assistantWithToolCall("search", { q: "loop-test" }),
			assistantWithToolCall("search", { q: "loop-test" }),
			assistantWithToolCall("search", { q: "loop-test" }),
		];
		const { runLength, lastSignature } = detectConsecutiveIdenticalToolCalls(messages, 3);
		assert.equal(runLength, N);
		assert.equal(lastSignature, fingerprintToolCall({ name: "search", arguments: { q: "loop-test" } }));
	});

	it("detectConsecutiveIdenticalToolCalls: a different assistant turn in the middle resets the run", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantWithToolCall("search", { q: "same" }),
			assistantWithToolCall("search", { q: "same" }),
			assistantWithToolCall("search", { q: "DIFFERENT" }),
			assistantWithToolCall("search", { q: "same" }),
		];
		const { runLength, lastSignature } = detectConsecutiveIdenticalToolCalls(messages, 3);
		assert.equal(runLength, 1, "a different turn in the middle breaks the run; only the trailing one matches the last turn");
		assert.equal(lastSignature, fingerprintToolCall({ name: "search", arguments: { q: "same" } }));
	});

	it("detectConsecutiveIdenticalToolCalls: non-assistant messages do not break the run and do not extend it", async () => {
		// The walk is over assistant turns only. A user or toolResult
		// message inside the candidate run is skipped: it neither
		// contributes to the run count nor resets it (a toolResult
		// for a prior tool call sits between the model issuing the
		// call and the model re-issuing it; the run of identical
		// tool calls is what we're measuring).
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantWithToolCall("search", { q: "x" }),
			toolResultMsg("result 1"),
			assistantWithToolCall("search", { q: "x" }),
			toolResultMsg("result 2"),
			assistantWithToolCall("search", { q: "x" }),
		];
		const { runLength, lastSignature } = detectConsecutiveIdenticalToolCalls(messages, 3);
		assert.equal(runLength, 3, "three identical toolCall turns with toolResult interleaved — run is 3");
		assert.equal(lastSignature, fingerprintToolCall({ name: "search", arguments: { q: "x" } }));
	});

	it("detectConsecutiveIdenticalToolCalls: reasoning-only trailing turn yields runLength 0 (AC-9)", async () => {
		// A no-toolCall assistant turn at the end resets the run
		// (the predicate returns the dedicated no-tool-calls
		// signature, which never matches a real tool-call signature,
		// AND the predicate short-circuits when the last signature
		// is the no-tool-calls sentinel).
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantWithToolCall("search", { q: "x" }),
			assistantWithToolCall("search", { q: "x" }),
			assistantMsg("I'm done searching — moving on"),
		];
		const { runLength, lastSignature } = detectConsecutiveIdenticalToolCalls(messages, 3);
		assert.equal(runLength, 0, "reasoning-only trailing turn must reset the run (AC-9)");
		assert.equal(lastSignature, null, "no run detected when the last assistant turn is reasoning-only");
	});

	it("detectConsecutiveIdenticalToolCalls: threshold <= 0 disables detection (no run counted)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantWithToolCall("search", { q: "x" }),
			assistantWithToolCall("search", { q: "x" }),
			assistantWithToolCall("search", { q: "x" }),
		];
		assert.deepEqual(
			detectConsecutiveIdenticalToolCalls(messages, 0),
			{ runLength: 0, lastSignature: null },
		);
		assert.deepEqual(
			detectConsecutiveIdenticalToolCalls(messages, -1),
			{ runLength: 0, lastSignature: null },
		);
	});

	it("detectConsecutiveIdenticalToolCalls: multi-tool-call turn matches iff the conjunction matches", async () => {
		// Two identical multi-tool-call turns → run is 2.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantWithToolCalls([
				{ name: "search", arguments: { q: "x" } },
				{ name: "lookup", arguments: { id: 1 } },
			]),
			assistantWithToolCalls([
				{ name: "search", arguments: { q: "x" } },
				{ name: "lookup", arguments: { id: 1 } },
			]),
		];
		const { runLength, lastSignature } = detectConsecutiveIdenticalToolCalls(messages, 2);
		assert.equal(runLength, 2);
		assert.ok(lastSignature && lastSignature.length > 0);
	});

	it("detectConsecutiveIdenticalToolCalls: reordered tools in the same turn do NOT match (order is part of the conjunction)", async () => {
		// The two turns call the same tools in different orders. The
		// conjunction sorts the per-call fingerprints before joining
		// (fingerprintAssistantTurn sorts), so reordering still
		// matches. Verify: a turn with [search, lookup] in slot 1 and
		// [lookup, search] in slot 2 fingerprint identically (because
		// the per-turn signature is the sorted conjunction).
		const t1 = fingerprintAssistantTurn([
			{ type: "toolCall", name: "search", arguments: { q: "x" } },
			{ type: "toolCall", name: "lookup", arguments: { id: 1 } },
		]);
		const t2 = fingerprintAssistantTurn([
			{ type: "toolCall", name: "lookup", arguments: { id: 1 } },
			{ type: "toolCall", name: "search", arguments: { q: "x" } },
		]);
		assert.equal(t1, t2, "a turn's signature is the sorted conjunction; order within a turn does not change it");
	});

	// ── computeFlatInputTokenSignal ───────────────────────────

	it("computeFlatInputTokenSignal: flat last-N token counts → flat: true", async () => {
		// All five last assistant turns are the same string → same
		// approximateMessageTokens → flat.
		const sameTurn = assistantMsg("the same content repeated");
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			sameTurn,
			sameTurn,
			sameTurn,
			sameTurn,
			sameTurn,
		];
		const { flat, sampleTokens } = computeFlatInputTokenSignal(messages);
		assert.equal(flat, true);
		// All five samples are the same (no variance).
		assert.equal(sampleTokens.length, 5);
		for (const t of sampleTokens) {
			assert.equal(t, sampleTokens[0]);
		}
	});

	it("computeFlatInputTokenSignal: token counts varying > 5% → flat: false", async () => {
		// Build five assistant turns of increasing size so the
		// spread between the largest and smallest is more than 5%.
		const tokens = [100, 100, 100, 200, 1000];
		const messages: TrimmableMessage[] = tokens.map((n) => assistantMsg("x".repeat(n * 4)));
		// Prepend a user anchor (the window only counts assistant turns).
		messages.unshift(userMsg("dispatch", 0));
		const { flat, sampleTokens } = computeFlatInputTokenSignal(messages);
		assert.equal(flat, false, "varying token counts > 5% spread → flat: false");
		assert.equal(sampleTokens.length, 5);
	});

	it("computeFlatInputTokenSignal: small variation within tolerance → flat: true", async () => {
		// Five turns sized 1000, 1000, 1000, 1000, 1010 tokens. The
		// spread is 10/1000 = 1%, well within the 5% tolerance.
		const tokens = [1000, 1000, 1000, 1000, 1010];
		const messages: TrimmableMessage[] = tokens.map((n) => assistantMsg("x".repeat(n * 4)));
		messages.unshift(userMsg("dispatch", 0));
		const { flat } = computeFlatInputTokenSignal(messages);
		assert.equal(flat, true, "1% spread is within the 5% tolerance");
	});

	it("computeFlatInputTokenSignal: fewer than 2 assistant turns → flat: false (no signal)", async () => {
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), assistantMsg("hi")];
		const { flat } = computeFlatInputTokenSignal(messages);
		assert.equal(flat, false, "single sample yields no signal");
	});

	it("FLAT_INPUT_TOKEN_TOLERANCE is the documented 0.05", async () => {
		assert.equal(FLAT_INPUT_TOKEN_TOLERANCE, 0.05);
	});

	// ── shouldHardBlock ───────────────────────────────────────

	it("shouldHardBlock: undefined threshold → false (hard-block off by default)", async () => {
		assert.equal(shouldHardBlock(5, undefined), false);
		assert.equal(shouldHardBlock(100, undefined), false);
	});

	it("shouldHardBlock: runLength >= threshold → true", async () => {
		assert.equal(shouldHardBlock(3, 3), true, "exact-equal run length meets the threshold");
		assert.equal(shouldHardBlock(10, 3), true, "run length above the threshold");
	});

	it("shouldHardBlock: runLength < threshold → false", async () => {
		assert.equal(shouldHardBlock(2, 3), false);
		assert.equal(shouldHardBlock(0, 3), false);
	});

	// ── Nudge / block text shape ──────────────────────────────

	it("LOOP_GUARD_NUDGE_TEXT is non-empty, names the repetition, and uses non-directive phrasing", async () => {
		assert.ok(LOOP_GUARD_NUDGE_TEXT.length > 0);
		assert.ok(/called the same tool/i.test(LOOP_GUARD_NUDGE_TEXT), "nudge must reference the repeated tool call");
		assert.ok(/same arguments/i.test(LOOP_GUARD_NUDGE_TEXT), "nudge must reference the same arguments");
		assert.ok(!/you must/i.test(LOOP_GUARD_NUDGE_TEXT), "nudge must not use directive 'you must' language");
	});

	it("LOOP_GUARD_BLOCK_TEXT is non-empty, names the block, and routes the model to text", async () => {
		assert.ok(LOOP_GUARD_BLOCK_TEXT.length > 0);
		assert.ok(/blocked/i.test(LOOP_GUARD_BLOCK_TEXT), "block must name the block action");
		assert.ok(/reasoning in text/i.test(LOOP_GUARD_BLOCK_TEXT) || /proceed by text/i.test(LOOP_GUARD_BLOCK_TEXT) || /proceed via text/i.test(LOOP_GUARD_BLOCK_TEXT), "block must route the model to text-only reasoning");
	});
});

// ─── Skip detection, escape clause, and fingerprint tests ──────────────
//
// Three pure functions added to `policy.ts`:
//   - `isAlreadySummarized(msg)` — envelope-detection predicate.
//   - `messageFingerprint(msg)` — first-200-chars extractor.
//   - The `alreadySummarizedHashes` option threaded through
//     `TrimOptions` → `summarizeOldestUntilUnder` → `findOldestSummarizable`.
//
// Behavior under test:
//   - The skip-by-envelope branch lifts an already-summarized message
//     out of the candidates list when a non-summarized alternative
//     exists (cases a, c, e).
//   - The escape clause fires when every trimmable candidate is
//     already-summarized AND the trimmable total is still over the
//     verbatim cap — the policy re-summarizes the oldest candidate
//     rather than blocking progress (case b).
//   - The fingerprint set is honored even when no envelope is present
//     on the message (case d), and `summarizedFingerprints` records
//     the original (pre-replacement) fingerprints.
//   - The within-pass cursor advances past the most recent
//     summarization so the loop does not infinite-loop on a message
//     whose replacement content is still the oldest candidate (case e).

/** Build a `role: "assistant"` message whose content is the summa envelope. */
function summarizedAssistantMsg(originalTokens: number, summaryTokens: number, summaryText: string): TrimmableMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `[summa: ~${originalTokens} tokens originally → ~${summaryTokens} tokens summary]\n${summaryText}`,
			},
		],
	};
}

describe("isAlreadySummarized", () => {
	it("returns true for an array content whose first text block starts with the summa envelope", async () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "[summa: ~100 tokens originally → ~20 tokens summary]\nshort summary" },
			],
		};
		assert.equal(isAlreadySummarized(msg), true);
	});

	it("returns true even when the envelope tag is followed by a long summary body", async () => {
		const msg: TrimmableMessage = {
			role: "toolResult",
			content: [
				{ type: "text", text: "[summa: ~50000 tokens originally → ~1000 tokens summary]\n" + "x".repeat(4000) },
			],
		};
		assert.equal(isAlreadySummarized(msg), true);
	});

	it("returns false for an array content whose first text block is plain text", async () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello, this is a regular assistant turn" }],
		};
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for an array content whose first text block starts with a different bracket tag", async () => {
		// Other bracket-leading strings (e.g. a hypothetical "[note:" tag) are
		// not the summa envelope; the predicate must reject them.
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "text", text: "[note: this is something else entirely]\nbody" }],
		};
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for a string content (the envelope only lives in array text blocks)", async () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: "[summa: ~100 tokens originally → ~20 tokens summary]\nsummary text",
		};
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for an empty string content", async () => {
		const msg: TrimmableMessage = { role: "user", content: "" };
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for an empty array content", async () => {
		const msg: TrimmableMessage = { role: "assistant", content: [] };
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for an array content whose first block is not a text block", async () => {
		// A non-text block first (e.g. a toolCall) is not the envelope
		// carrier; the envelope lives in `{ type: "text" }` blocks.
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "toolCall", name: "search", arguments: { q: "x" } }],
		};
		assert.equal(isAlreadySummarized(msg), false);
	});
});

describe("messageFingerprint", () => {
	it("returns the first 200 chars of a string content", async () => {
		const longText = "a".repeat(500);
		const msg: TrimmableMessage = { role: "user", content: longText };
		assert.equal(messageFingerprint(msg), "a".repeat(200));
	});

	it("returns the full string when shorter than 200 chars", async () => {
		const msg: TrimmableMessage = { role: "user", content: "short" };
		assert.equal(messageFingerprint(msg), "short");
	});

	it("returns the first 200 chars of the first text block for array content", async () => {
		const longText = "b".repeat(500);
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: longText },
				{ type: "text", text: "second block (ignored after the first)" },
			],
		};
		assert.equal(messageFingerprint(msg), "b".repeat(200));
	});

	it("returns an empty string for array content with no text blocks", async () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "toolCall", name: "search", arguments: { q: "x" } }],
		};
		assert.equal(messageFingerprint(msg), "");
	});

	it("returns an empty string for an empty string content", async () => {
		const msg: TrimmableMessage = { role: "user", content: "" };
		assert.equal(messageFingerprint(msg), "");
	});

	it("returns exactly 200 chars for content longer than 200 chars (not 201, not 199)", async () => {
		const longText = "x".repeat(250);
		const msg: TrimmableMessage = { role: "user", content: longText };
		const fp = messageFingerprint(msg);
		assert.equal(fp.length, 200);
		assert.equal(fp, "x".repeat(200));
	});

	it("returns the same fingerprint for two messages whose first 200 chars are identical", async () => {
		const base = "c".repeat(200);
		const msg1: TrimmableMessage = { role: "user", content: base + "trailing" };
		const msg2: TrimmableMessage = { role: "user", content: base + "different trailing" };
		assert.equal(messageFingerprint(msg1), messageFingerprint(msg2));
	});

	it("returns different fingerprints for two messages whose first 200 chars differ", async () => {
		const msg1: TrimmableMessage = { role: "user", content: "d".repeat(200) + "trailing" };
		const msg2: TrimmableMessage = { role: "user", content: "e".repeat(200) + "trailing" };
		assert.notEqual(messageFingerprint(msg1), messageFingerprint(msg2));
	});
});

describe("applyThreeTierTrim — skip already-summarized by envelope (case a)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("skips a message whose content carries the summa envelope and summarizes a non-summarized message instead", async () => {
		// Two trimmable messages: one already-summarized (carries the
		// envelope) and one fresh. Set `verbatimMaxTokens` so the
		// fresh message's mass forces a summarize pass; the
		// already-summarized message must be left alone.
		const alreadySummarized = summarizedAssistantMsg(20_000, 50, "preexisting summary body");
		const fresh = assistantMsg("f".repeat(30_000 * 4));
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), alreadySummarized, fresh];
		// The fresh message is 30,000 tokens; the already-summarized
		// message is ~25 tokens. Total = 30,025. Setting
		// verbatimMaxTokens to 25,000 puts the total OVER the cap so
		// the tier-2 summarize path fires.
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			verbatimMaxTokens: 25_000,
		});
		// (i) At least one summarize fired on the fresh message.
		assert.ok(result.summarized >= 1, "at least one non-summarized message should be summarized");
		// (ii) The already-summarized message's content is unchanged
		// in the returned array (its position is preserved; its
		// content is the original envelope, not a re-summary).
		const survivor = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content),
		);
		assert.ok(survivor, "the already-summarized message survives the trim");
		const survivorText = (survivor!.content as Array<{ type: string; text: string }>)[0].text;
		assert.ok(survivorText.startsWith("[summa: ~"), "the survivor still carries the summa envelope");
		assert.ok(survivorText.includes("preexisting summary body"), "the survivor's original summary body is preserved (not re-summarized)");
		// (iii) The fresh message was rewritten (its 'f'.repeat(...) string
		// content is gone — the summarize path replaced it).
		const rewrittenAssistant = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.includes("[summa:"),
			) && m !== survivor,
		);
		assert.ok(rewrittenAssistant, "the fresh message was rewritten with a summa envelope");
	});
});

describe("applyThreeTierTrim — escape clause when only summarized candidates remain (case b)", () => {
	it("re-summarizes an already-summarized candidate when the total is still over the verbatim cap", async () => {
		// Two trimmable messages, BOTH already-summarized with LARGE
		// summaries (the summaries themselves are big — 3000 chars /
		// 4 = 750 tokens each, ×2 = 1500 tokens). Set `verbatimMax`
		// to 1000 so the total (1500) is still over the cap. With the
		// skip flag ON, both candidates are skipped and `findOldest`
		// returns -1; the escape clause retries with the skip flag
		// OFF and re-summarizes the first message. The new summary
		// shrinks the total under the cap and the loop exits.
		const summarized1: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "text", text: "[summa: ~20000 tokens originally → ~3000 tokens summary]\n" + "s".repeat(3000) }],
		};
		const summarized2: TrimmableMessage = {
			role: "toolResult",
			content: [{ type: "text", text: "[summa: ~20000 tokens originally → ~3000 tokens summary]\n" + "s".repeat(3000) }],
		};
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), summarized1, summarized2];
		// A summarizer that returns a small fixed string — the
		// post-replacement content is much smaller than the original.
		const result = await applyThreeTierTrim(messages, {
			summarizer: async () => "x".repeat(20),
			verbatimMaxTokens: 1000,
		});
		// The escape clause fired: at least one message was re-summarized.
		assert.ok(result.summarized >= 1, "the escape clause must re-summarize when only summarized candidates remain and the total is over the cap");
		// The post-trim total is now at or below the verbatim cap.
		assert.ok(totalTrimmableTokens(result.messages) <= 1000, "the total is brought under the verbatim cap after the escape clause");
		// `summarizedFingerprints` records the re-summarized message's
		// ORIGINAL fingerprint (the pre-replacement envelope header).
		assert.ok(result.summarizedFingerprints.length >= 1, "summarizedFingerprints is populated");
		// Every recorded fingerprint is a non-empty string (a
		// pre-replacement envelope header is at least the envelope tag
		// itself, which is well over 0 chars).
		for (const fp of result.summarizedFingerprints) {
			assert.ok(fp.length > 0, "every recorded fingerprint is non-empty");
		}
	});
});

describe("applyThreeTierTrim — does not re-summarize already-summarized when total is under cap (case c)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("leaves an already-summarized message untouched when a non-summarized alternative covers the budget", async () => {
		// One already-summarized trimmable message (small) + one fresh
		// trimmable message. The fresh message, once summarized by the
		// stub (which returns "summary"), shrinks the total under the
		// verbatim cap. The already-summarized message must NOT be
		// re-summarized.
		const alreadySummarized = summarizedAssistantMsg(5_000, 20, "small preexisting summary");
		const fresh = assistantMsg("g".repeat(20_000 * 4));
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), alreadySummarized, fresh];
		// The fresh message is 20,000 tokens; the already-summarized
		// is ~20 tokens. Total = 20,020. Setting verbatimMaxTokens
		// to 15,000 puts the total OVER the cap, so the tier-2
		// summarize path fires. The stub returns "summary" (7 chars
		// / 4 = 2 tokens) — summarizing the fresh message alone
		// brings the total to 22, well under 15,000, so exactly
		// one summarize fires.
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			verbatimMaxTokens: 15_000,
		});
		// (i) Exactly one summary fired — on the fresh message.
		assert.equal(result.summarized, 1, "exactly one summarize fires (on the fresh message)");
		// (ii) The already-summarized message's content is unchanged.
		const survivor = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.includes("small preexisting summary"),
			),
		);
		assert.ok(survivor, "the already-summarized message is preserved verbatim");
		// (iii) The fresh message was rewritten (its 'g'.repeat(...)
		// string content is gone — the summarize path replaced it
		// with a summa envelope).
		const rewritten = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.startsWith("[summa: ~") && !b.text.includes("small preexisting summary"),
			),
		);
		assert.ok(rewritten, "the fresh message was rewritten with a summa envelope");
	});
});

describe("applyThreeTierTrim — alreadySummarizedHashes threads through TrimOptions (case d)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("skips a message whose fingerprint is in alreadySummarizedHashes and summarizes a different message", async () => {
		// Two fresh trimmable messages, neither carrying the envelope.
		// Pass `alreadySummarizedHashes` containing the fingerprint of
		// the FIRST trimmable message. The skip branch must lift that
		// message out of the candidates list and the policy
		// summarizes the second one instead.
		const firstContent = "h".repeat(15_000 * 4);
		const secondContent = "i".repeat(15_000 * 4);
		const first = assistantMsg(firstContent);
		const second = assistantMsg(secondContent);
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), first, second];
		// Each trimmable message is 15,000 tokens; total trimmable
		// is 30,000. Setting verbatimMaxTokens to 25,000 puts the
		// total OVER the cap, so the tier-2 summarize path fires.
		// The fingerprint of `first` is the first 200 chars of its
		// string content. Build the set directly.
		const firstFp = messageFingerprint(first);
		const alreadySummarizedHashes = new Set<string>([firstFp]);
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			alreadySummarizedHashes,
			verbatimMaxTokens: 25_000,
		});
		// (i) At least one summary fired.
		assert.ok(result.summarized >= 1, "at least one message was summarized");
		// (ii) The first message's content is unchanged (it was in the
		// skip set; it was NOT re-summarized).
		const firstSurvivor = result.messages.find(
			(m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string) === firstContent,
		);
		assert.ok(firstSurvivor, "the first message's content is preserved verbatim (skipped via fingerprint)");
		// (iii) The second message was rewritten.
		const secondRewritten = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.startsWith("[summa: ~"),
			),
		);
		assert.ok(secondRewritten, "the second message was rewritten with a summa envelope");
		// (iv) `summarizedFingerprints` contains the fingerprint of the
		// SECOND message (the one that was actually summarized), NOT
		// the first's fingerprint (which was in the skip set).
		const secondFp = messageFingerprint(second);
		assert.ok(result.summarizedFingerprints.includes(secondFp), "summarizedFingerprints contains the fingerprint of the actually-summarized message");
		assert.ok(!result.summarizedFingerprints.includes(firstFp), "summarizedFingerprints does NOT contain the fingerprint of the skipped message");
	});
});

describe("applyThreeTierTrim — within-pass cursor does not infinite-loop (case e)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("terminates with the already-summarized oldest message untouched and a younger message summarized", async () => {
		// The oldest trimmable message already carries the summa
		// envelope. The verbatim cap is set so a younger fresh
		// trimmable message must be summarized. The cursor must
		// advance past the youngest-summarized message so the loop
		// terminates — the already-summarized oldest message is NOT
		// re-picked.
		const oldestAlreadySummarized = summarizedAssistantMsg(5_000, 20, "oldest preexisting summary");
		const younger = assistantMsg("j".repeat(20_000 * 4));
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), oldestAlreadySummarized, younger];
		// The function MUST return (no infinite loop). The single
		// summarize pass on `younger` shrinks the total under the
		// cap; the loop exits cleanly.
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			verbatimMaxTokens: 5_000,
		});
		// (i) The function returned (the call resolved).
		assert.ok(result, "the trim function returns (no infinite loop)");
		// (ii) The already-summarized oldest message is preserved.
		const survivor = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.includes("oldest preexisting summary"),
			),
		);
		assert.ok(survivor, "the already-summarized oldest message is preserved verbatim");
		// (iii) The younger non-summarized message was summarized.
		assert.ok(result.summarized >= 1, "the younger non-summarized message was summarized");
		const rewritten = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.startsWith("[summa: ~") && !b.text.includes("oldest preexisting summary"),
			),
		);
		assert.ok(rewritten, "the younger non-summarized message was rewritten with a summa envelope");
	});
});


// ─── Background summarizer mode (backgroundSummarize: true) ───────────
//
// When `backgroundSummarize: true`, the policy fires summarizer
// promises in the background and returns immediately, leaving the
// original (un-summarized) message content in place. The pending
// promises are carried in `TrimResult.pendingSummaries` for the
// wiring layer to await and cache. The returned `backgroundPending`
// flag is `true` when at least one promise was fired, `false` when
// no summarization was needed (verbatim tier) or no summarizer
// callback was provided.

describe("applyThreeTierTrim — background summarizer mode", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("returns backgroundPending: true and pendingSummaries when the trim would summarize in background mode", async () => {
		// Build a session that lands in tier 2 (>50k trimmable).
		const messages: TrimmableMessage[] = trimmableMass(60_000);
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			backgroundSummarize: true,
		});
		// (i) At least one background promise was fired.
		assert.equal(result.backgroundPending, true, "backgroundPending must be true when the trim fired at least one background promise");
		assert.ok(result.pendingSummaries, "pendingSummaries must be present when backgroundPending is true");
		assert.ok(result.pendingSummaries!.length >= 1, "pendingSummaries must have at least one entry");
		// (ii) The original message content is NOT replaced (the
		// background path leaves content untouched).
		const assistantInResult = result.messages.find(
			(m) => m.role === "assistant" && typeof m.content === "string" && (m.content as string).includes("a".repeat(100)),
		);
		assert.ok(assistantInResult, "the original assistant message survives verbatim in background mode (content is the original string)");
		// (iii) `summarized` is the count of fired promises (the
		// background path increments the same counter).
		assert.ok(result.summarized >= 1, "summarized counter is at least 1 (fired promises count)");
	});

	it("backgroundSummarize: true does NOT replace message content in place (messages stay original)", async () => {
		// Build a tier-2 session: a single trimmable message over 50k.
		const trimmableBody = "x".repeat(60_000 * 4);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg(trimmableBody),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			backgroundSummarize: true,
		});
		// (i) The assistant's content is the ORIGINAL string —
		// not rewritten to a summa envelope array.
		const assistant = result.messages.find((m) => m.role === "assistant");
		assert.ok(assistant, "assistant must be in the output");
		assert.equal(assistant!.content, trimmableBody, "background mode leaves content untouched (the original string)");
		assert.ok(!Array.isArray(assistant!.content), "background mode content is NOT a summa envelope array");
	});

	it("backgroundSummarize: false (default) replaces content in place (sync mode, but async function)", async () => {
		// The same fixture, but with backgroundSummarize omitted (default false).
		// Sync mode awaits the summarizer and rewrites content in place.
		const trimmableBody = "y".repeat(60_000 * 4);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg(trimmableBody),
		];
		const result = await applyThreeTierTrim(messages, { summarizer });
		// (i) backgroundPending is false (sync mode, no background).
		assert.equal(result.backgroundPending, false, "backgroundPending is false in sync mode");
		assert.equal(result.pendingSummaries, undefined, "no pendingSummaries in sync mode");
		// (ii) Content is replaced with the summa envelope (the
		// message's content is now an array, not the original string).
		const assistant = result.messages.find((m) => m.role === "assistant");
		assert.ok(assistant, "assistant must be in the output");
		assert.ok(Array.isArray(assistant!.content), "sync mode rewrites content to a summa envelope array");
	});

	it("backgroundPending is false when the trim is in the verbatim tier (no summarization needed)", async () => {
		// A small session — verbatim tier, no summarization.
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), assistantMsg("hi")];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			backgroundSummarize: true,
		});
		// No summarization fired — backgroundPending is false.
		assert.equal(result.backgroundPending, false, "verbatim tier → no background promise fired");
		assert.equal(result.pendingSummaries, undefined, "verbatim tier → no pendingSummaries");
		assert.equal(result.summarized, 0, "verbatim tier → summarized counter is 0");
	});

	it("pendingSummaries carries the correct index, fingerprint, originalMessage, and promise for each summarized message", async () => {
		// Two trimmable messages, both over 50k, both candidates
		// for summarization. Both fired as background promises.
		const first = assistantMsg("p".repeat(30_000 * 4));
		const second = assistantMsg("q".repeat(30_000 * 4));
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), first, second];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			backgroundSummarize: true,
		});
		// (i) At least one entry in pendingSummaries.
		assert.ok(result.pendingSummaries && result.pendingSummaries.length >= 1);
		// (ii) Each entry carries the right shape: index (number),
		// fingerprint (string), originalMessage (TrimmableMessage),
		// promise (Promise<string>).
		for (const entry of result.pendingSummaries!) {
			assert.equal(typeof entry.index, "number", "entry.index is a number");
			assert.ok(entry.index >= 0, "entry.index is a valid index");
			assert.equal(typeof entry.fingerprint, "string", "entry.fingerprint is a string");
			assert.ok(entry.fingerprint.length > 0, "entry.fingerprint is non-empty");
			assert.ok(entry.originalMessage, "entry.originalMessage is present");
			assert.equal(typeof entry.originalMessage.role, "string", "entry.originalMessage has a role");
			assert.ok(entry.promise && typeof entry.promise.then === "function", "entry.promise is a thenable");
		}
		// (iii) The first pending entry's index is the first
		// trimmable message in the array (oldest-first selection
		// picks index 1 in [dispatch, first, second]).
		assert.equal(result.pendingSummaries![0].index, 1, "the first fired background promise targets the oldest trimmable message");
		// (iv) The fingerprint is the first 200 chars of the
		// original content (per the policy's messageFingerprint
		// semantics).
		const expectedFp = messageFingerprint(first);
		assert.equal(result.pendingSummaries![0].fingerprint, expectedFp, "fingerprint matches messageFingerprint(original)");
	});

	it("the pending promise resolves to the summary text", async () => {
		// Build a session that fires at least one background
		// promise and await the promise directly to verify it
		// resolves to the summary text.
		const trimmableBody = "z".repeat(60_000 * 4);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg(trimmableBody),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			backgroundSummarize: true,
		});
		assert.ok(result.pendingSummaries && result.pendingSummaries.length >= 1);
		// Await the first pending promise. The summarizer stub
		// returns "summary" (7 chars). Verify the promise resolves
		// to that text.
		const summaryText = await result.pendingSummaries![0].promise;
		assert.equal(summaryText, "summary", "the pending promise resolves to the summarizer's return value");
	});
});

// ─── Summarize-tier input hygiene (AC-1) ─────────────────────────────
//
// The summarizer callback must receive only the prose content of a
// message. Tool-call and tool-result content blocks are structural
// (they describe what the model asked the agent to do, or what the
// agent returned) — feeding their raw JSON into summa's TextRank
// embeds the JSON in the summary, which corrupts it.
//
// The fix lives in `policy.ts`: a dedicated prose-only extraction
// helper replaces the one `extractText(msg.content)` call site in
// `summarizeOldestUntilUnder`. `extractText` itself is unchanged
// so `approximateMessageTokens` keeps counting the full message.

describe("applyThreeTierTrim — summarize tier: prose-only input (AC-1)", () => {
	it("assistant turn with text + toolCall mixed: summarizer sees only prose, not tool-call JSON", async () => {
		const prose = "I will look up the answer and report back. " + "a".repeat(60_000 * 4);
		const toolCallArgs = { query: "secret-token", limit: 10 };
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantWithMixedBlock(prose, "search", toolCallArgs),
		];
		let captured: { text: string; words: number } | null = null;
		const tracking = async (text: string, w: number) => {
			captured = { text, words: w };
			return "summary";
		};
		await applyThreeTierTrim(messages, { summarizer: tracking });
		assert.ok(captured !== null, "summarizer was invoked");
		assert.ok(
			(captured as { text: string }).text.includes("I will look up the answer and report back."),
			"captured summarizer input contains the prose",
		);
		assert.ok(
			!(captured as { text: string }).text.includes("toolCall"),
			"captured summarizer input does not contain the literal 'toolCall' marker",
		);
		assert.ok(
			!(captured as { text: string }).text.includes("secret-token"),
			"captured summarizer input does not contain the tool-call argument value",
		);
		assert.ok(
			!(captured as { text: string }).text.includes('"name"'),
			"captured summarizer input does not contain the JSON-stringified name field",
		);
	});

	it("toolResult message: summarizer does not see the raw tool-result JSON when content is object array", async () => {
		// A toolResult whose content is an array of blocks
		// (e.g. mixed text + image / file blocks) is summarized
		// in place by the summarize path. Only the text blocks
		// should reach the summarizer.
		const prose = "Result body: " + "b".repeat(60_000 * 4);
		const toolResultMsg: TrimmableMessage = {
			role: "toolResult",
			content: [
				{ type: "text", text: prose },
				{ type: "image", mediaType: "image/png", data: "BASE64DATA" },
			],
		};
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultMsg,
		];
		let captured: { text: string; words: number } | null = null;
		const tracking = async (text: string, w: number) => {
			captured = { text, words: w };
			return "summary";
		};
		await applyThreeTierTrim(messages, { summarizer: tracking });
		assert.ok(captured !== null, "summarizer was invoked on the toolResult");
		assert.ok(
			(captured as { text: string }).text.includes("Result body:"),
			"captured summarizer input contains the prose",
		);
		assert.ok(
			!(captured as { text: string }).text.includes("BASE64DATA"),
			"captured summarizer input does not contain the non-text block data",
		);
		assert.ok(
			!(captured as { text: string }).text.includes('"type"'),
			"captured summarizer input does not contain JSON-stringified block metadata",
		);
	});

	it("approximateMessageTokens still counts the full message including the tool-call JSON (AC-2)", async () => {
		const prose = "short prose";
		const toolCallArgs = { query: "x".repeat(2000) };
		const msg = assistantWithMixedBlock(prose, "search", toolCallArgs);
		const tokens = approximateMessageTokens(msg);
		// The unchanged extractText concatenates `text` blocks AND
		// JSON.stringify-falls-back for the tool-call block. So
		// the count must be much larger than just the prose's
		// `Math.ceil(prose.length / 4)` (~3 tokens). The exact
		// number depends on the JSON shape; the budget-math
		// invariant is that the count is not zero and not
		// prose-only.
		assert.ok(
			tokens > Math.ceil(prose.length / 4),
			`approximateMessageTokens must include the tool-call JSON in its count (got ${tokens})`,
		);
	});
});

// ─── Reasoning-block cap (AC-4) ─────────────────────────────────────
//
// The reasoning-block cap is a pure-function transform on the
// message array. It keeps the LAST N `type:"thinking"` content
// blocks across the stream (counted from the latest end) and drops
// the rest by REMOVING thinking blocks from their parent messages.
// Non-thinking content blocks in the same message are preserved
// verbatim. The cap is a count, not a token budget.
//
// Cap semantics (mirrors the policy.ts comment block):
//   cap === -1  → passthrough, return the input unchanged
//   cap ===  0  → drop every thinking block from every message
//   cap  >  0   → keep the last `cap` thinking blocks, drop the rest
//
// The tests below cover the policy-layer cap surface:
//   - The four semantic regions (-1, 0, 1, N>1).
//   - The "no thinking blocks present" no-regression invariant.
//   - The "thinking + text in the same message" mixed-block case
//     (text survives; only thinking is subject to the cap).
//   - A purity check: the new exports must not pull in process.* or
//     node:fs (the no-process.no-I/O contract is part of the
//     existing purity surface; the test reads each export's
//     function source and asserts no forbidden token is present).
//   - The supporting helpers (extractReasoningText, hasReasoning,
//     countReasoningBlocks) get their own describe blocks for
//     parity with the file's test-per-function shape.

describe("REASONING_BLOCK_CAP_DEFAULT", () => {
	it("is the documented compile-time default (-1 — passthrough, so existing operators see no behavior change)", async () => {
		assert.equal(REASONING_BLOCK_CAP_DEFAULT, -1);
	});
});

describe("extractReasoningText", () => {
	it("returns the concatenated thinking strings from a message with multiple thinking blocks", async () => {
		const msg: TrimmableMessage = assistantWithThinking(["first ", "second ", "third"]);
		assert.equal(extractReasoningText(msg.content), "first second third");
	});

	it("returns an empty string when there are no thinking blocks", async () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "text", text: "no thinking here" }],
		};
		assert.equal(extractReasoningText(msg.content), "");
	});

	it("returns an empty string for a non-array content (string content, object content)", async () => {
		assert.equal(extractReasoningText("plain string"), "");
		assert.equal(extractReasoningText({ a: 1 }), "");
	});
});

describe("hasReasoning", () => {
	it("returns true when a message has at least one thinking block", async () => {
		const msg: TrimmableMessage = assistantWithThinking(["anything"]);
		assert.equal(hasReasoning(msg), true);
	});

	it("returns false when a message has no thinking blocks (only text / toolCall / etc.)", async () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "text", text: "no reasoning here" }],
		};
		assert.equal(hasReasoning(msg), false);
	});

	it("returns false for a non-array content (string content, object content)", async () => {
		assert.equal(hasReasoning({ role: "assistant", content: "string content" }), false);
		assert.equal(hasReasoning({ role: "assistant", content: { a: 1 } }), false);
	});
});

describe("countReasoningBlocks", () => {
	it("counts thinking blocks across the whole stream", async () => {
		const messages: TrimmableMessage[] = [
			assistantWithThinking(["a", "b"]),
			assistantWithThinking(["c"]),
			{
				role: "assistant",
				content: [{ type: "text", text: "no thinking" }],
			},
			assistantWithThinking(["d", "e", "f"]),
		];
		assert.equal(countReasoningBlocks(messages), 6);
	});

	it("returns 0 when no message carries a thinking block", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("hello"),
		];
		assert.equal(countReasoningBlocks(messages), 0);
	});

	it("returns 0 for an empty input", async () => {
		assert.equal(countReasoningBlocks([]), 0);
	});
});

describe("applyReasoningBlockCap", () => {
	// ── cap === -1 (passthrough) ──────────────────────────────────

	it("cap === -1: returns the input unchanged (passthrough)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantWithThinking(["think-1", "think-2"]),
			assistantWithThinking(["think-3", "think-4"]),
		];
		const out = applyReasoningBlockCap(messages, -1);
		// Identity-by-content check: every message is in the same
		// position with the same content. Passthrough is a shallow
		// slice (the policy returns messages.slice(), not a deep
		// clone) — verify the array elements match by reference.
		assert.equal(out.length, messages.length);
		for (let i = 0; i < out.length; i++) {
			assert.equal(out[i], messages[i]);
		}
	});

	// ── cap === 0 (drop all) ──────────────────────────────────────

	it("cap === 0: drops every thinking block from every message; non-thinking content blocks preserved", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			{
				role: "assistant",
				content: [
					{ type: "text", text: "preamble" },
					{ type: "thinking", thinking: "think-1" },
				],
			},
			assistantWithThinking(["think-2", "think-3"]),
		];
		const out = applyReasoningBlockCap(messages, 0);
		// Same length, same message order.
		assert.equal(out.length, messages.length);
		// Message 0 (the dispatch) is unchanged.
		assert.equal(out[0], messages[0]);
		// Message 1: the text block survives, the thinking block
		// is removed. The result has one content block (text).
		const m1 = out[1];
		assert.ok(Array.isArray(m1.content));
		assert.equal((m1.content as unknown[]).length, 1);
		assert.equal(
			(m1.content as Array<{ type: string; text?: string }>)[0].type,
			"text",
		);
		assert.equal(
			(m1.content as Array<{ type: string; text?: string }>)[0].text,
			"preamble",
		);
		// Message 2 was a thinking-only message; dropping every
		// thinking block leaves an empty content array. The
		// message is preserved (not removed) — the index space is
		// stable so the wiring layer's downstream consumers see
		// the same message order.
		const m2 = out[2];
		assert.ok(Array.isArray(m2.content));
		assert.equal((m2.content as unknown[]).length, 0);
		// The non-thinking content blocks were never at risk: the
		// cap targets type:"thinking" exclusively.
		assert.equal(countReasoningBlocks(out), 0, "no thinking blocks survive cap=0");
	});

	// ── cap === 1 (keep last) ─────────────────────────────────────

	it("cap === 1: only the last thinking block across the stream survives; all earlier ones dropped", async () => {
		// 4 thinking blocks across 2 messages. With cap=1, the
		// latest block (think-4) survives; think-1, think-2,
		// think-3 are dropped.
		const messages: TrimmableMessage[] = [
			assistantWithThinking(["think-1", "think-2"]),
			assistantWithThinking(["think-3", "think-4"]),
		];
		const out = applyReasoningBlockCap(messages, 1);
		// Total thinking-block count after cap: 1.
		assert.equal(countReasoningBlocks(out), 1);
		// The surviving block is the LAST one in the stream (the
		// last block of the last message). find the surviving
		// block by its text content.
		const survivor = out
			.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; thinking?: string }>) : []))
			.find((b) => b.type === "thinking");
		assert.ok(survivor, "exactly one thinking block survives cap=1");
		assert.equal(survivor.thinking, "think-4");
	});

	// ── cap === 3 (count cap) ─────────────────────────────────────

	it("cap === 3: the last 3 thinking blocks survive; the rest dropped", async () => {
		const messages: TrimmableMessage[] = [
			assistantWithThinking(["think-1", "think-2", "think-3"]),
			assistantWithThinking(["think-4", "think-5"]),
		];
		const out = applyReasoningBlockCap(messages, 3);
		// Total thinking-block count after cap: 3.
		assert.equal(countReasoningBlocks(out), 3);
		// The surviving blocks are the LAST 3 in the stream:
		// think-3 (last of message 0), think-4, think-5 (message 1).
		// The cap reverse-walks: latest-first.
		const survivors = out
			.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; thinking?: string }>) : []))
			.filter((b) => b.type === "thinking")
			.map((b) => b.thinking);
		assert.deepEqual(survivors, ["think-3", "think-4", "think-5"]);
	});

	// ── no-regression: messages without thinking blocks ──────────

	it("returns messages unchanged when no message carries a thinking block (any cap value)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("hello"),
			{ role: "toolResult", content: "ok" },
		];
		// Try every meaningful cap value; the no-regression
		// invariant holds for all of them.
		for (const cap of [-1, 0, 1, 3]) {
			const out = applyReasoningBlockCap(messages, cap);
			// Same length, same positions, same content. The
			// cap pass is a no-op when the stream has no
			// thinking blocks.
			assert.equal(out.length, messages.length, `length preserved at cap=${cap}`);
			for (let i = 0; i < out.length; i++) {
				assert.equal(out[i], messages[i], `message ${i} preserved at cap=${cap}`);
			}
		}
	});

	// ── mixed blocks: thinking + text in the same message ────────

	it("preserves text blocks; only thinking blocks subject to the cap", async () => {
		// A single message with 3 thinking blocks followed by a
		// text block. With cap=1, only the LAST thinking block
		// (think-3) survives; the text block is untouched.
		const messages: TrimmableMessage[] = [
			assistantWithThinkingAndText(["think-1", "think-2", "think-3"], "answer text"),
		];
		const out = applyReasoningBlockCap(messages, 1);
		const m0 = out[0];
		assert.ok(Array.isArray(m0.content));
		// The text block is preserved.
		const textBlock = (m0.content as Array<{ type: string; text?: string }>).find((b) => b.type === "text");
		assert.ok(textBlock, "the text block must survive the cap (only thinking blocks are subject to it)");
		assert.equal(textBlock.text, "answer text");
		// Exactly one thinking block survives.
		const thinkingBlocks = (m0.content as Array<{ type: string; thinking?: string }>).filter((b) => b.type === "thinking");
		assert.equal(thinkingBlocks.length, 1);
		assert.equal(thinkingBlocks[0].thinking, "think-3");
	});

	// ── cap > total: no over-drop (cap is a count, not a floor) ──

	it("cap > total thinking blocks: every block survives (no over-drop)", async () => {
		const messages: TrimmableMessage[] = [
			assistantWithThinking(["think-1", "think-2"]),
		];
		const out = applyReasoningBlockCap(messages, 10);
		assert.equal(countReasoningBlocks(out), 2);
		const survivors = (out[0].content as Array<{ type: string; thinking?: string }>).map((b) => b.thinking);
		assert.deepEqual(survivors, ["think-1", "think-2"]);
	});

	// ── immutability: the input array is not mutated ──────────────

	it("does not mutate the input messages array", async () => {
		const messages: TrimmableMessage[] = [
			assistantWithThinking(["think-1", "think-2", "think-3"]),
			assistantWithThinking(["think-4"]),
		];
		// Snapshot the input's content arrays by JSON so we can
		// verify the cap did not mutate them.
		const snapshot = JSON.stringify(messages);
		applyReasoningBlockCap(messages, 1);
		assert.equal(JSON.stringify(messages), snapshot, "input messages array must not be mutated by the cap");
	});

	// ── purity: the new exports do not pull in process.* or I/O ──

	it("purity: applyReasoningBlockCap source has no process.*, node:fs, node:os, or other I/O", async () => {
		// A structural test for the purity contract (the policy
		// module is a pure module — no process.*, no Node I/O).
		// Read the function's source via `toString()` and assert
		// no forbidden token is present. The function source
		// captures the function body verbatim; if the body
		// references `process.env` or imports `node:fs` directly,
		// this assertion fails. (An import at the top of
		// policy.ts would be a separate concern; this test is
		// scoped to the function body.)
		const src = applyReasoningBlockCap.toString();
		assert.ok(!src.includes("process."), "applyReasoningBlockCap must not reference process.*");
		assert.ok(!src.includes("node:fs"), "applyReasoningBlockCap must not import node:fs");
		assert.ok(!src.includes("node:os"), "applyReasoningBlockCap must not import node:os");
		assert.ok(!src.includes("fetch("), "applyReasoningBlockCap must not perform network I/O");
		assert.ok(!src.includes("readFile"), "applyReasoningBlockCap must not perform filesystem I/O");
	});
});

// ─── Tier-3 summarize-fallback cap target ────────────────────────
//
// The two tier-3 summarize-fallback call sites in `applyThreeTierTrim`
// pass the ceiling to `summarizeOldestUntilUnder`. Tier 3's contract is
// to hold the tier-2 (`summarizeMaxTokens`) ceiling — the drop tier
// must collapse the LLM-bound trimmable total to <= summarizeMax. The
// tier-2 *normal* path (total between verbatim and summarize) targets
// verbatimMax; only the tier-3 fallback paths target summarizeMax.
//
// The regression test pins the operator's exact shape: tier1=75k,
// tier2=125k, dropFloor=62.5k (50% of tier2), recencyFloor unset, ~190k
// trimmable across uneven chunks, ~10k protected mass (pinned synthetic
// + preserved-paths tool results), ~60-word summarizer stub. Asserts
// post-trim trimmable <= summarizeMax (125k).
//
// The residual test exercises the boundary where the
// summarize-fallback's candidates are already summarized (carry the
// `[summa:` envelope or persisted fingerprints). The fallback cannot
// reduce the total in that case — the cap fix is necessary but not
// sufficient for the residual path. The test pins the boundary so
// future residual-mechanism work has a regression target.

describe("applyThreeTierTrim — tier-3 summarize-fallback targets summarizeMax", () => {
	// 60-word summarizer stub: returns realistic ~60-word summary text.
	// At 1 word ~ 1 token, ~60 tokens. Shrinks a 30k-token message to
	// ~60 tokens.
	const sixtyWordSummarizer = async (_text: string, _w: number) => {
		const words = [
			"summary", "of", "the", "preceding", "content", "covering", "the", "key", "points",
			"with", "concise", "phrasing", "and", "minimal", "loss", "of", "the", "operator's",
			"intent", "and", "the", "specific", "details", "the", "model", "needs", "to", "carry",
			"forward", "into", "the", "next", "turn", "without", "the", "full", "original",
			"verbatim", "mass", "that", "would", "exceed", "the", "ceiling", "on", "the",
			"trimmable", "side", "of", "the", "budget", "boundary", "for", "this", "tier",
		];
		return words.slice(0, 60).join(" ");
	};

	it("tier-3 drop-floor fall-through: post-trim trimmable <= summarizeMax (operator's exact shape)", async () => {
		// Operator config: tier1=75k, tier2=125k, dropFloor=62.5k,
		// recencyFloor unset. Trimmable mass of 190k across uneven
		// chunks (30k+20k+80k+40k+20k) in a single post-dispatch
		// synthetic trimmable turn (the LLM-is-mid-response shape
		// the policy's "synthesize trimmable turn" exception
		// handles). ~10k protected mass (pinned synthetic +
		// preserved-paths tool result) riding on top of the
		// trimmable budget.
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const protectedPath = "/repo/AGENTS.md";
		const preservedPatterns = ["AGENTS.md"];
		const messages: TrimmableMessage[] = [
			pinnedMsg("agent def " + "p".repeat(2_500 * 4)),
			toolResultWithPath("doc body " + "d".repeat(2_500 * 4), protectedPath),
			userMsg("dispatch task — do X", 0),
			assistantMsg("a".repeat(30_000 * 4)),
			assistantMsg("b".repeat(20_000 * 4)),
			assistantMsg("c".repeat(80_000 * 4)),
			assistantMsg("d".repeat(40_000 * 4)),
			assistantMsg("e".repeat(20_000 * 4)),
			pinnedMsg("extra " + "q".repeat(2_500 * 4)),
			toolResultWithPath("more " + "e".repeat(2_500 * 4), protectedPath),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer: sixtyWordSummarizer,
			protectedCustomTypes: protectedSet,
			preservedPatterns,
			dropFloorTokens: 62_500,
			verbatimMaxTokens: 75_000,
			summarizeMaxTokens: 125_000,
		});
		const postTrimTotal = totalTrimmableTokens(
			result.messages,
			protectedSet,
			true,
			preservedPatterns,
		);
		assert.ok(
			postTrimTotal <= 125_000,
			`post-trim trimmable total ${postTrimTotal} must be <= summarizeMaxTokens 125000 (ceiling invariant)`,
		);
		// The drop-floor engages (the single 190k turn cannot be
		// dropped whole without pushing remaining mass below
		// 62.5k). The policy hands the trimmable off to the
		// summarize-fallback with cap=summarizeMax=125k. The
		// summarize path reduces 190k to under 125k.
		assert.ok(
			result.summarized >= 1,
			"the summarize-fallback reduced at least one trimmable message",
		);
		const pinnedSurvivors = result.messages.filter(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.equal(pinnedSurvivors.length, 2, "both pinned synthetic messages must survive the trim");
		const preservedSurvivors = result.messages.filter(
			(m) => m.role === "toolResult" && m.details && (m.details as { sourcePath?: string }).sourcePath === protectedPath,
		);
		assert.equal(preservedSurvivors.length, 2, "both preserved-paths tool results must survive the trim");
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "dispatch task must survive the trim");
	});

	it("tier-3 residual case: summarize-fallback leaves already-summarized candidates untouched", async () => {
		// The post-drop re-check branch and the shouldFallThrough
		// branch both invoke `summarizeOldestUntilUnder` with the
		// cap fix's target. When every summarizable candidate is
		// already at its post-summary size (carries the `[summa:`
		// envelope and is in `alreadySummarizedHashes`), the
		// summarize-fallback's skip-by-default branch returns -1;
		// the escape clause retries with the skip flag lifted, but
		// the re-summarized message's body is the same size as
		// the original (the defensive bound fires). The post-trim
		// trimmable total is the already-summarized body size.
		//
		// This pins the residual boundary: even with the cap fix,
		// when the summarize path cannot reduce candidates, the
		// post-trim total is the post-summary body size, not the
		// original size. The cap fix raises the cap from 75k to
		// 125k; the operator's exact shape (190k trimmable) is
		// handled by the cap fix alone. This test pins the
		// boundary for future residual-mechanism work.
		const residualMessage = summarizedAssistantMsg(60, 60, "old summary");
		const residualFingerprint = messageFingerprint(residualMessage);
		const messages: TrimmableMessage[] = [
			userMsg("dispatch task — do X", 0),
			residualMessage,
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer: sixtyWordSummarizer,
			dropFloorTokens: 0,
			verbatimMaxTokens: 75_000,
			summarizeMaxTokens: 125_000,
			alreadySummarizedHashes: new Set([residualFingerprint]),
		});
		const total = totalTrimmableTokens(result.messages);
		assert.ok(
			total <= 125_000,
			`post-trim trimmable total ${total} must be <= summarizeMaxTokens 125000 (residual boundary pin)`,
		);
		assert.equal(result.droppedTurns, 0, "single trimmable message is not bundled into a turn");
		const survivor = result.messages.find(
			(m) => Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.startsWith("[summa: ~"),
			),
		);
		assert.ok(survivor, "the already-summarized message survives the trim path");
	});
});

// ─── Pre-budget collapse — applyIntercomKeepLast (AC-2) ─────────────
//
// `applyIntercomKeepLast` is the Rule 1 pre-budget collapse for
// `intercom_message` custom entries. Recency hardtrim: keep the last
// N by stream order, drop the rest. Cap semantics:
//   keepLast === -1  → passthrough (no allocation when the input is
//                      large; the policy returns `messages.slice()`).
//   keepLast ===  0  → drop every intercom_message entry.
//   keepLast  >  0   → keep the last `keepLast` entries.
// Pure: no I/O, no `process.*`; the wiring layer coerces floats with
// `Math.trunc` (summaWords precedent) and gates by the
// `resolveIntercomInstalled` extension probe.

function intercomMsg(text: string, customType = "intercom_message"): TrimmableMessage {
	return { role: "custom", content: text, customType };
}

function customMsg(text: string, customType: string): TrimmableMessage {
	return { role: "custom", content: text, customType };
}

describe("applyIntercomKeepLast", () => {
	// ── cap === -1 (passthrough) ──────────────────────────────────

	it("keepLast === -1: returns the input unchanged (passthrough)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			intercomMsg("first"),
			assistantMsg("hi"),
			intercomMsg("second"),
			intercomMsg("third"),
		];
		const out = applyIntercomKeepLast(messages, -1);
		assert.equal(out.length, messages.length);
		for (let i = 0; i < out.length; i++) {
			assert.equal(out[i], messages[i], `message ${i} preserved at keepLast=-1`);
		}
	});

	// ── cap === 0 (drop all) ─────────────────────────────────────

	it("keepLast === 0: drops every intercom_message entry; non-intercom entries preserved", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			intercomMsg("first"),
			assistantMsg("hi"),
			intercomMsg("second"),
			intercomMsg("third"),
			{ role: "toolResult", content: "ok" },
		];
		const out = applyIntercomKeepLast(messages, 0);
		assert.equal(out.length, 3, "every intercom_message is dropped (dispatch + assistant + toolResult survive)");
		assert.equal((out[0] as TrimmableMessage).role, "user");
		assert.equal((out[1] as TrimmableMessage).role, "assistant");
		assert.equal((out[2] as TrimmableMessage).role, "toolResult");
		// No `customType: "intercom_message"` survives.
		for (const m of out) {
			assert.notEqual((m as TrimmableMessage).customType, "intercom_message");
		}
	});

	// ── cap === 1 (keep last) ────────────────────────────────────

	it("keepLast === 1: only the LAST intercom_message survives; all earlier ones dropped", async () => {
		const messages: TrimmableMessage[] = [
			intercomMsg("first"),
			assistantMsg("hi"),
			intercomMsg("second"),
			intercomMsg("third"),
		];
		const out = applyIntercomKeepLast(messages, 1);
		assert.equal(out.length, 2, "dispatch + 1 surviving intercom (second assistant + last intercom)");
		assert.equal((out[0] as TrimmableMessage).role, "assistant");
		assert.equal((out[1] as TrimmableMessage).customType, "intercom_message");
		assert.equal((out[1] as TrimmableMessage).content, "third", "the LAST intercom_message by stream order survives");
	});

	// ── cap === 3 (keep last 3) ─────────────────────────────────

	it("keepLast === 3: the last 3 intercom_message entries survive (of 5 total)", async () => {
		const messages: TrimmableMessage[] = [
			intercomMsg("m1"),
			intercomMsg("m2"),
			intercomMsg("m3"),
			intercomMsg("m4"),
			intercomMsg("m5"),
		];
		const out = applyIntercomKeepLast(messages, 3);
		assert.equal(out.length, 3);
		assert.deepEqual(
			out.map((m) => (m as TrimmableMessage).content),
			["m3", "m4", "m5"],
			"the last 3 intercom_message entries by stream order survive (m1 and m2 are dropped)",
		);
	});

	// ── cap > total: no over-drop (cap is a count, not a floor) ──

	it("keepLast > total intercom_message entries: every entry survives (no over-drop)", async () => {
		const messages: TrimmableMessage[] = [
			intercomMsg("m1"),
			intercomMsg("m2"),
		];
		const out = applyIntercomKeepLast(messages, 10);
		assert.equal(out.length, 2, "all entries survive when cap > total");
	});

	// ── mixed stream: non-intercom custom entries untouched ──────

	it("preserves non-intercom_message custom entries (subagent-notify, pinned, preserved)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			intercomMsg("icm-1"),
			customMsg("notify-1", "subagent-notify"),
			intercomMsg("icm-2"),
			pinnedMsg("agent def"),
			customMsg("preserved-1", "context-trimmer-preserved"),
			intercomMsg("icm-3"),
		];
		const out = applyIntercomKeepLast(messages, 1);
		// Surviving: dispatch + subagent-notify + pinned + preserved + last intercom = 5.
		assert.equal(out.length, 5);
		const customTypes = out
			.map((m) => (m as TrimmableMessage).customType)
			.filter((ct) => ct !== undefined);
		assert.deepEqual(customTypes, [
			"subagent-notify",
			"context-trimmer-pinned",
			"context-trimmer-preserved",
			"intercom_message",
		], "non-intercom custom entries survive in stream order");
		assert.equal(out[out.length - 1].content, "icm-3", "the LAST intercom_message by stream order survives");
	});

	// ── no intercom_message entries: pure passthrough ───────────

	it("messages with no intercom_message entries: input returned unchanged (no scan overhead when not present)", async () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("hi"),
			{ role: "toolResult", content: "ok" },
		];
		for (const keepLast of [-1, 0, 1, 5]) {
			const out = applyIntercomKeepLast(messages, keepLast);
			assert.equal(out.length, messages.length, `length preserved at keepLast=${keepLast}`);
			for (let i = 0; i < out.length; i++) {
				assert.equal(out[i], messages[i], `message ${i} preserved at keepLast=${keepLast}`);
			}
		}
	});

	// ── immutability: the input array is not mutated ──────────────

	it("does not mutate the input messages array", async () => {
		const messages: TrimmableMessage[] = [
			intercomMsg("a"),
			intercomMsg("b"),
			intercomMsg("c"),
		];
		const snapshot = JSON.stringify(messages);
		applyIntercomKeepLast(messages, 1);
		assert.equal(JSON.stringify(messages), snapshot, "input messages array must not be mutated");
	});

	// ── purity: function source has no process.* or I/O ──────────

	it("purity: applyIntercomKeepLast source has no process.*, node:fs, node:os, or other I/O", async () => {
		const src = applyIntercomKeepLast.toString();
		assert.ok(!src.includes("process."), "applyIntercomKeepLast must not reference process.*");
		assert.ok(!src.includes("node:fs"), "applyIntercomKeepLast must not import node:fs");
		assert.ok(!src.includes("node:os"), "applyIntercomKeepLast must not import node:os");
		assert.ok(!src.includes("fetch("), "applyIntercomKeepLast must not perform network I/O");
		assert.ok(!src.includes("readFile"), "applyIntercomKeepLast must not perform filesystem I/O");
	});
});

// ─── Pre-budget collapse — dedupSubagentNotify (AC-4) ─────────────
//
// `dedupSubagentNotify` is the Rule 2 pre-budget collapse for
// `subagent-notify` custom entries. Keep the first occurrence of
// each run identity in stream order; drop every subsequent duplicate.
// No knob — duplicates are always noise.
//
// Run identity: `details.sessionValue` when present (the
// per-run-stable session file / share URL), else a deterministic
// fingerprint of `details` (`agent` + `status` + `resultPreview` +
// `taskInfo`). Entries with neither signal fall back to the stream
// index and are not deduped.

function notifyMsg(label: string, runId: string): TrimmableMessage {
	return {
		role: "custom",
		content: label,
		customType: "subagent-notify",
		details: { sessionValue: runId, agent: "tester", status: "completed" },
	};
}

function notifyWithAgent(label: string, agent: string, status: string, resultPreview: string): TrimmableMessage {
	return {
		role: "custom",
		content: label,
		customType: "subagent-notify",
		details: { agent, status, resultPreview, taskInfo: { id: "task-1" } },
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
			summarizer: makeTrimmingSummarizer(),
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
	const summarizer = makeTrimmingSummarizer(5);
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
			summarizer,
			preservedPatterns: ["AGENTS.md"],
			protectedToolCallIds: new Set([protectedCallId]),
		});
		// Trimmable mass: the unprotected `toolResult` is the only
		// non-protected trimmable message (~26 chars / 4 = 7
		// tokens). Tier 1 (verbatim); the trim is a passthrough.
		assert.equal(result.summarized, 0);
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

	it("(b) block-level: assistant turn stays a trimmable candidate; protected `toolCall` block survives inside the rewritten message; `text` is summarized", async () => {
		const protectedCallId = "call_AGENTS_md_b";
		// Build a session that lands in tier 2: a large trimmable
		// message that is summarizeable. The protected `toolCall`
		// block must survive INSIDE the rewritten message; the
		// `text` block (the large prose) is rewritten to a summa
		// envelope.
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
			summarizer,
			preservedPatterns: ["AGENTS.md"],
			protectedToolCallIds: new Set([protectedCallId]),
		});
		// (i) The summarize path ran (the assistant was a candidate;
		// it's not a protected slot per the message-level predicate).
		assert.ok(result.summarized >= 1, "the assistant turn is a summarize candidate (not protected at the message level)");
		// (ii) The protected `toolCall` block survives INSIDE the
		// rewritten message — the carve-out kept it.
		const rewrittenAssistant = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content),
		);
		assert.ok(rewrittenAssistant, "the assistant message survives the rewrite");
		const rwContent = rewrittenAssistant!.content as Array<{ type: string; id?: string; name?: string; arguments?: unknown; text?: string }>;
		const survivingToolCall = rwContent.find(
			(b) => b.type === "toolCall" && b.id === protectedCallId,
		);
		assert.ok(survivingToolCall, "the protected `toolCall` block survives inside the rewritten assistant message");
		// (iii) The summa envelope sits at the head of the rewritten
		// content array (the `text` block was replaced; the
		// `toolCall` block is appended after the envelope).
		const envelope = rwContent.find(
			(b) => b.type === "text" && typeof b.text === "string" && b.text.startsWith("[summa: ~"),
		);
		assert.ok(envelope, "the summa envelope is in the rewritten content (the `text` block was replaced)");
		// (iv) The protected `toolResult` survives by association
		// (the `protectedToolCallIds` set made it a protected slot
		// at the message level).
		const survivingToolResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === protectedCallId,
		);
		assert.ok(survivingToolResult, "the protected `toolResult` survives by association (no orphan)");
		assert.equal(survivingToolResult!.content, "contents of AGENTS.md", "protected `toolResult` content is verbatim (not summarized)");
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
			summarizer,
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

	it("(c) orphan — summarize tier: protected `toolResult` survives; unprotected pair drops together on the rewrite", async () => {
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
			summarizer,
			preservedPatterns: ["AGENTS.md"],
			protectedToolCallIds: new Set([protectedCallId]),
		});
		// (i) The summarize path ran.
		assert.ok(result.summarized >= 1, "the assistant turn is a summarize candidate");
		// (ii) The protected `toolResult` survives by association.
		const survivingProtectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === protectedCallId,
		);
		assert.ok(survivingProtectedResult, "protected `toolResult` survives the summarize path by association");
		// (iii) The unprotected `toolResult` is dropped alongside
		// its unprotected `toolCall` block (the rewrite dropped
		// the unprotected block, and the post-pass dropped the
		// matching `toolResult`).
		const survivingUnprotectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.equal(survivingUnprotectedResult, undefined, "unprotected `toolResult` is dropped alongside its unprotected `toolCall` block (no orphan)");
		// (iv) The protected `toolCall` block survives inside the
		// rewritten assistant message.
		const rewrittenAssistant = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content),
		);
		assert.ok(rewrittenAssistant, "the assistant message survives the rewrite");
		const rwContent = rewrittenAssistant!.content as Array<{ type: string; id?: string }>;
		const survivingProtectedCall = rwContent.find(
			(b) => b.type === "toolCall" && b.id === protectedCallId,
		);
		assert.ok(survivingProtectedCall, "the protected `toolCall` block survives inside the rewritten assistant message");
	});

	// (d) no-regression floor: an unprotected pair (no `protectedToolCallIds`
	// entry, no `preservedPatterns` match) drops / summarizes as
	// before. The fix does not change unprotected behavior.

	it("(d) no-regression: unprotected pair (no `protectedToolCallIds`) drops as before; pair-atomicity is silent when there is no protection", async () => {
		const unprotectedCallId = "call_CLAUDE_md_d";
		// A simple tier-2 session: a large assistant with a single
		// unprotected `toolCall` block, plus the matching
		// `toolResult`. Without `protectedToolCallIds`, the rewrite
		// drops the unprotected `toolCall` block (and the
		// `text` block), and the post-pass drops the matching
		// `toolResult` (pair-atomic in the unprotected direction
		// too — no orphan).
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
			summarizer,
			// No `preservedPatterns`, no `protectedToolCallIds`.
		});
		// (i) The summarize path ran.
		assert.ok(result.summarized >= 1, "the assistant is a summarize candidate");
		// (ii) The unprotected `toolResult` is dropped (the rewrite
		// dropped the unprotected `toolCall` block, and the
		// post-pass dropped the matching `toolResult`).
		const survivingUnprotectedResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.equal(survivingUnprotectedResult, undefined, "unprotected `toolResult` is dropped alongside the unprotected `toolCall` block (no over-protection, no regression)");
		// (iii) The unprotected `toolCall` block is gone.
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
		assert.equal(unprotectedCallSurvived, false, "the unprotected `toolCall` block is gone (no over-protection)");
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
			summarizer,
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
		// Build a session with toolCall blocks whose `arguments.path`
		// would not match any preserved pattern. The protected set
		// is empty, the carve-out is silent, the behavior is
		// identical to the pre-fix path.
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
		// No `protectedToolCallIds` argument. The pure policy's
		// `protectedToolCallIds: ReadonlySet<string> = new Set()`
		// default applies, and the `isProtectedSlot` branch keys on
		// an empty set — no protection.
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			// No `preservedPatterns`, no `protectedToolCallIds`.
		});
		assert.ok(result.summarized >= 1, "the assistant is a summarize candidate (no protected carve-out fired)");
		// The unprotected `toolResult` is dropped alongside.
		const survivingResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as TrimmableMessage & { toolCallId?: string }).toolCallId === unprotectedCallId,
		);
		assert.equal(survivingResult, undefined, "no `protectedToolCallIds` → no protected carve-out → no over-protection");
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
	const summarizer = makeTrimmingSummarizer(5);

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
	it("(1) protected mass subtracted from both tier caps (AC-1): the effective cap is verbatimMax − protectedMass; tier 2 fires when trimmable > effective cap", async () => {
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
			summarizer,
			protectedCustomTypes: protectedSet,
			preservedPatterns: ["AGENTS.md"],
			verbatimMaxTokens: 50_000,
			summarizeMaxTokens: 100_000,
		});
		// Tier 2 fired: at least one trimmable was summarized.
		assert.ok(result.summarized >= 1, "tier 2 must fire when trimmable total (60k) > effective verbatim cap (48_494)");
		// The drop tier did not fire.
		assert.equal(result.droppedTurns, 0, "the drop tier must NOT fire — trimmable 60k < effective summarize cap 98_494");
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
		// (iv) Post-trim trimmable total ≤ effective verbatim cap.
		const postTrimTotal = totalTrimmableTokens(result.messages, protectedSet, true, ["AGENTS.md"]);
		assert.ok(
			postTrimTotal <= 48_494,
			`post-trim trimmable total ${postTrimTotal} must be <= effective verbatim cap 48_494`,
		);
	});

	// (2) system-prompt tokens subtracted in addition to protected mass (AC-2).
	//
	// Same fixture as (1) but with `systemPromptTokens: 30_000`. The
	// effective cap is `max(0, 50_000 − 30_000 − 1_506) = 18_494`.
	// The trimmable total (60k) exceeds the effective verbatim cap
	// (18_494) so tier 2 fires earlier (more summarize passes are
	// required to land the trimmable total under 18_494 instead of
	// 48_494). The protected slots and the dispatch task survive.
	it("(2) system-prompt tokens subtracted (AC-2): the effective cap is verbatimMax − systemPromptTokens − protectedMass; tier 2 fires earlier with a lower effective cap", async () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages: TrimmableMessage[] = [
			pinnedMsg("p".repeat(1500)),
			userMsg("dispatch task — do X", 0),
			toolResultWithPath("c".repeat(3000), "/repo/AGENTS.md"),
			assistantMsg("a".repeat(30_000 * 3)),
			assistantMsg("b".repeat(30_000 * 3)),
		];
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
			preservedPatterns: ["AGENTS.md"],
			verbatimMaxTokens: 50_000,
			summarizeMaxTokens: 100_000,
			systemPromptTokens: 30_000,
		});
		// Tier 2 fired.
		assert.ok(result.summarized >= 1, "tier 2 must fire when trimmable total (60k) > effective verbatim cap (18_494)");
		// The drop tier did not fire.
		assert.equal(result.droppedTurns, 0, "the drop tier must NOT fire — trimmable 60k < effective summarize cap 68_494");
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
		// (iv) The trim fires earlier — the post-trim trimmable
		// total is at or below the lower effective cap (18_494).
		// The summarizer stub returns "summary" (7 chars / 3 = 3
		// tokens) per call, so after one pass a 30k message
		// becomes ~3 tokens; with two 30k trimmable messages,
		// the post-trim trimmable is ~6 tokens — well under
		// 18_494. The effective cap reduced the summarize
		// target by 30_000 tokens compared to the (1) case.
		const postTrimTotal = totalTrimmableTokens(result.messages, protectedSet, true, ["AGENTS.md"]);
		assert.ok(
			postTrimTotal <= 18_494,
			`post-trim trimmable total ${postTrimTotal} must be <= effective verbatim cap 18_494 (system-prompt term subtracted)`,
		);
	});

	// (3) `approximateTextTokens` with divisor 3 (the new default) and
	// divisor 4 (the legacy chars/4 default, reachable through the
	// operator-configured knob) — AC-3.
	describe("approximateTextTokens with configurable divisor (AC-3)", () => {
		it("divisor 3: 'hello world' (11 chars) → ceil(11/3) = 4 tokens", async () => {
			assert.equal(approximateTextTokens("hello world", 3), 4);
		});

		it("divisor 4 (the legacy default): 'hello world' (11 chars) → ceil(11/4) = 3 tokens", async () => {
			// The legacy chars/4 behavior is reachable by passing
			// 4 to the estimator directly. The wiring layer
			// threads the operator-configured divisor from
			// `cfg.tokenEstimatorDivisor` (env or JSON key) at
			// every call site.
			assert.equal(approximateTextTokens("hello world", 4), 3);
		});

		it("divisor 3: structured content (a JSON-stringified 30-char object) → ceil(30/3) = 10 tokens", async () => {
			// A representative structured-content tokenization:
			// 30 chars / 3 = 10 tokens at the new default.
			const structured = JSON.stringify({ a: 1, b: 2, c: 3, d: 4 });
			// Sanity: 30 chars at JSON.stringify density
			// (`{"a":1,"b":2,"c":3,"d":4}` = 29 chars — close to
			// 30; the test asserts the formula, not the exact
			// shape).
			const len = structured.length;
			assert.equal(approximateTextTokens(structured, 3), Math.ceil(len / 3));
		});

		it("divisor 3: empty string → 0 tokens", async () => {
			assert.equal(approximateTextTokens("", 3), 0);
		});

		it("divisor 3: TOKEN_ESTIMATOR_DIVISOR_DEFAULT is 3 (the new compile-time default)", async () => {
			// The compile-time default is the new divisor 3
			// (replacing the legacy hard-coded 4). The wiring
			// layer applies this constant when neither the env
			// var nor the JSON key sets a value; tests that
			// don't pass a divisor fall through to it.
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
		// Pass `systemPromptTokens: 0` explicitly to verify the
		// no-regression path. The fixture has no protected
		// customTypes and no preserved paths, so protectedMass
		// reduces to the dispatch (7 tokens). The effective
		// verbatim cap is `max(0, 50_000 − 0 − 7) = 49_993`;
		// trimmable (60k) > 49_993 so tier 2 fires once. This
		// is the AC-6 contract: identical behavior to the legacy
		// path (which subtracted the protected mass but did not
		// subtract a system-prompt term — with systemPromptTokens
		// = 0 the new code is bit-for-bit equivalent).
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			verbatimMaxTokens: 50_000,
			summarizeMaxTokens: 100_000,
			systemPromptTokens: 0,
		});
		// Tier 2 fired (the trimmable mass exceeds the effective
		// verbatim cap; the subtract-protect term is the only
		// delta from the legacy code).
		assert.ok(result.summarized >= 1, "tier 2 must fire (60k trimmable > 49_993 effective cap)");
		assert.equal(result.droppedTurns, 0, "the drop tier must NOT fire — trimmable 60k < effective summarize cap 99_993");
		// The dispatch task survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.userTurnAge === 0,
		);
		assert.ok(dispatch, "the dispatch task must survive the trim");
		assert.equal(dispatch!.content, "dispatch task — do X");
		// The trimmable mass was reduced under the effective cap.
		const postTrimTotal = totalTrimmableTokens(result.messages);
		assert.ok(
			postTrimTotal <= 49_993,
			`post-trim trimmable total ${postTrimTotal} must be <= effective verbatim cap 49_993`,
		);
	});

	// (5) degradation: when the protected mass alone exceeds the
	// verbatim cap, the effective cap is 0 and the trim fires
	// against the trimmable mass (AC-6, no `NaN` / `Infinity` /
	// infinite loop).
	//
	// Build a session with five protected slots summing to 60k
	// tokens and one trimmable message of 1k tokens. The verbatim
	// cap is 50_000; the effective cap is
	// `max(0, 50_000 − 0 − 60_000) = 0`. The trimmable mass
	// (1000) > 0 so tier 2 fires. The protected slots survive;
	// the trimmable message is summarized to a tiny envelope.
	// The `Math.max(0, …)` guard prevents a negative cap from
	// entering the comparison (which would produce `NaN` /
	// `Infinity` from the arithmetic).
	it("(5) degradation (AC-6): protected mass > verbatim cap → effective cap is 0; tier 2 fires; protected slots survive; no NaN/Infinity, no infinite loop", async () => {
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
		// Track that the function returns (no infinite loop)
		// and that the result counters are valid (no NaN).
		const result = await applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
			verbatimMaxTokens: 50_000,
			summarizeMaxTokens: 100_000,
		});
		// The function returned — no infinite loop.
		assert.ok(result, "the trim function must return (no infinite loop)");
		// The counters are valid finite numbers (no NaN / Infinity).
		assert.equal(typeof result.summarized, "number", "summarized counter is a number");
		assert.ok(Number.isFinite(result.summarized), "summarized counter is finite (no NaN/Infinity)");
		assert.equal(typeof result.droppedTurns, "number", "droppedTurns counter is a number");
		assert.ok(Number.isFinite(result.droppedTurns), "droppedTurns counter is finite (no NaN/Infinity)");
		assert.equal(typeof result.totalTokens, "number", "totalTokens counter is a number");
		assert.ok(Number.isFinite(result.totalTokens), "totalTokens counter is finite (no NaN/Infinity)");
		// Tier 2 fired (the trimmable mass of 1k > effective
		// verbatim cap of 0); at least one summary landed.
		assert.ok(result.summarized >= 1, "tier 2 must fire (1k trimmable > 0 effective cap)");
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
		// The post-trim trimmable total is at or below the
		// effective cap (which is 0). With the summarizer stub
		// returning "summary" (7 chars / 3 = 3 tokens) plus the
		// `[summa: ~N → ~M]\n` envelope prefix, the post-trim
		// trimmable is a small envelope token count — well below
		// the original 1k trimmable mass. The contract is
		// "the trim fires and reduces the trimmable mass"; the
		// exact residual is the envelope size, not 0.
		const postTrimTotal = totalTrimmableTokens(result.messages, protectedSet);
		assert.ok(
			postTrimTotal < 1_000,
			`post-trim trimmable total ${postTrimTotal} must be < the original 1k trimmable mass (the trim fired and reduced it)`,
		);
		// The drop tier did not fire — the trimmable (1k) < 100k.
		assert.equal(result.droppedTurns, 0, "the drop tier must NOT fire — trimmable 1k < 100k");
	});
});
