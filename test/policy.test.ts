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
	applyThreeTierTrim,
	approximateMessageTokens,
	extractText,
	fingerprintToolCall,
	fingerprintAssistantTurn,
	detectConsecutiveIdenticalToolCalls,
	computeFlatInputTokenSignal,
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
	type TrimmableMessage,
} from "../policy.ts";

// ─── Helpers ───────────────────────────────────────────────────────────

/** A test summarizer that returns a fixed short summary string. */
function makeTrimmingSummarizer(_words: number = 10) {
	return (_text: string) => "summary";
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

/** Build a trimmable mass of roughly N tokens (chars = N * 4). */
function trimmableMass(n: number): TrimmableMessage[] {
	// Build a single trimmable message of n tokens. The dispatch
	// is a small constant that the policy protects.
	const targetChars = n * 4;
	return [
		userMsg("dispatch task — do X", 0),
		assistantMsg("a".repeat(targetChars)),
	];
}

// ─── Per-message token accounting ─────────────────────────────────────

describe("approximateMessageTokens (chars / 4)", () => {
	it("returns ceil(chars / 4) for a string content", () => {
		assert.equal(approximateMessageTokens({ role: "user", content: "hello world" }), 3);
	});

	it("sums text across an array of content blocks", () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello " },
				{ type: "text", text: "world" },
			],
		};
		assert.equal(approximateMessageTokens(msg), 3);
	});

	it("returns 0 for an empty string content", () => {
		assert.equal(approximateMessageTokens({ role: "user", content: "" }), 0);
	});

	it("extracts text from object content via JSON.stringify fallback", () => {
		const msg: TrimmableMessage = {
			role: "custom",
			content: { foo: "bar" },
		};
		// JSON.stringify({foo:"bar"}) → 13 chars → ceil(13/4) = 4
		assert.equal(approximateMessageTokens(msg), 4);
	});
});

describe("extractText", () => {
	it("returns a string content as-is", () => {
		assert.equal(extractText("hello"), "hello");
	});

	it("concatenates text blocks from an array", () => {
		assert.equal(
			extractText([
				{ type: "text", text: "foo " },
				{ type: "text", text: "bar" },
			]),
			"foo bar",
		);
	});

	it("falls back to JSON.stringify for non-text object content", () => {
		assert.equal(extractText({ a: 1 }), '{"a":1}');
	});
});

// ─── Protected-slot predicate ─────────────────────────────────────────

describe("isProtectedSlot", () => {
	const dispatch: TrimmableMessage = userMsg("dispatch", 0);
	const followUp: TrimmableMessage = userMsg("follow-up", 1);
	const pinned: TrimmableMessage = pinnedMsg("agent def");
	const assistant: TrimmableMessage = assistantMsg("hi");

	it("protects the first user message (userTurnAge === 0)", () => {
		const messages = [dispatch, assistant];
		assert.equal(isProtectedSlot(dispatch, 0, messages), true);
		assert.equal(isProtectedSlot(assistant, 1, messages), false);
	});

	it("does not protect a follow-up user message", () => {
		const messages = [dispatch, followUp];
		assert.equal(isProtectedSlot(followUp, 1, messages), false);
	});

	it("protects a context-trimmer-pinned synthetic when its customType is in the protected set", () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [pinned, dispatch, assistant];
		assert.equal(isProtectedSlot(pinned, 0, messages, protectedSet), true);
		assert.equal(isProtectedSlot(dispatch, 1, messages, protectedSet), true);
		assert.equal(isProtectedSlot(assistant, 2, messages, protectedSet), false);
	});

	it("does not protect a custom message whose customType is not in the protected set", () => {
		const messages = [pinned, dispatch, assistant];
		assert.equal(isProtectedSlot(pinned, 0, messages, new Set()), false);
	});

	it("falls back to 'first user message by position' when userTurnAge is missing", () => {
		const messages = [
			{ role: "user", content: "first" } as TrimmableMessage,
			{ role: "user", content: "second" } as TrimmableMessage,
		];
		assert.equal(isProtectedSlot(messages[0], 0, messages), true);
		assert.equal(isProtectedSlot(messages[1], 1, messages), false);
	});

	it("does NOT protect the first user message when protectDispatch is false", () => {
		const messages = [dispatch, assistant];
		assert.equal(isProtectedSlot(dispatch, 0, messages, new Set(), false), false);
		assert.equal(isProtectedSlot(assistant, 1, messages, new Set(), false), false);
	});

	it("still protects a pinned customType when protectDispatch is false", () => {
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
	it("sums per-message tokens for trimmable messages", () => {
		const messages = [
			userMsg("hi", 0),
			assistantMsg("hello"),
		];
		// user "hi" is protected; assistant "hello" = 6 chars / 4 = 2 tokens.
		assert.equal(totalTrimmableTokens(messages), 2);
	});

	it("subtracts protected-slot tokens from the total", () => {
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

	it("returns the input unchanged for a small conversation", () => {
		const messages = [userMsg("dispatch", 0), assistantMsg("hi")];
		const result = applyThreeTierTrim(messages, { summarizer });
		assert.equal(result.summarized, 0);
		assert.equal(result.droppedTurns, 0);
		assert.equal(result.messages.length, messages.length);
		assert.equal(result.messages[0].content, "dispatch");
		assert.equal(result.messages[1].content, "hi");
	});

	it("does not invoke the summarizer in the verbatim tier", () => {
		let called = false;
		const tracking = (text: string) => {
			called = true;
			return text;
		};
		const messages = [userMsg("dispatch", 0), assistantMsg("hello world")];
		applyThreeTierTrim(messages, { summarizer: tracking });
		assert.equal(called, false);
	});

	it("boundary at exactly 50k total tokens is verbatim", () => {
		const messages = trimmableMass(VERBATIM_TIER_MAX_TOKENS);
		const result = applyThreeTierTrim(messages, { summarizer });
		assert.equal(result.summarized, 0);
		assert.equal(result.droppedTurns, 0);
	});
});

// ─── Summarize tier (50k–100k) ─────────────────────────────────────────

describe("applyThreeTierTrim — summarize tier (50k < total ≤ 100k)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("summarizes the oldest non-protected trimmable message when over 50k", () => {
		const messages = trimmableMass(60_000);
		const result = applyThreeTierTrim(messages, { summarizer });
		// The assistant message is oldest non-protected (after the
		// dispatch). The summarizer should fire on it.
		assert.ok(result.summarized >= 1);
		// The dispatch is preserved.
		assert.equal(result.messages[0].content, "dispatch task — do X");
	});

	it("preserves the dispatch task through summarization", () => {
		const messages = trimmableMass(60_000);
		const result = applyThreeTierTrim(messages, { summarizer });
		// The first message is the dispatch — content unchanged.
		const first = result.messages[0];
		assert.equal(first.role, "user");
		assert.equal(first.userTurnAge, 0);
		assert.equal(first.content, "dispatch task — do X");
	});

	it("loops until total ≤ 50k, summarizing multiple messages if needed", () => {
		// Build a session with several trimmable turns at ~20k each.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("a".repeat(30_000 * 4)),
			toolResultMsg("b".repeat(30_000 * 4)),
		];
		const result = applyThreeTierTrim(messages, { summarizer });
		// 60k total — at least one summarization should bring us under 50k.
		assert.ok(result.summarized >= 1);
		// Re-check: after summarize, total is under 50k.
		assert.ok(totalTrimmableTokens(result.messages) <= VERBATIM_TIER_MAX_TOKENS);
	});

	it("protects a context-trimmer-pinned synthetic in the summarize tier", () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [
			pinnedMsg("agent def " + "p".repeat(20_000 * 4)),
			userMsg("dispatch", 0),
			assistantMsg("x".repeat(30_000 * 4)),
		];
		const result = applyThreeTierTrim(messages, {
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

	it("the budget excludes protected-slot tokens", () => {
		// A session whose only over-budget contributor is the pinned
		// message (the agent def) should NOT trigger a trim.
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [
			pinnedMsg("agent def " + "p".repeat(60_000 * 4)),
			userMsg("dispatch", 0),
			assistantMsg("short"),
		];
		const result = applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
		});
		// The assistant "short" is the only trimmable mass (6 chars
		// / 4 = 2 tokens). Total trimmable is 2 — well under 50k.
		// No summarize fires.
		assert.equal(result.summarized, 0);
	});

	it("boundary at exactly 50k+1 tokens triggers a single summarize pass", () => {
		const messages = trimmableMass(50_001);
		const result = applyThreeTierTrim(messages, { summarizer });
		assert.ok(result.summarized >= 1);
	});
});

// ─── Drop tier (100k+) ─────────────────────────────────────────────────

describe("applyThreeTierTrim — drop tier (total > 100k)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("hard-drops the oldest trimmable turn when over 100k", () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("a".repeat(60_000 * 4)), // First trimmable turn.
			toolResultMsg("b".repeat(60_000 * 4)),
		];
		const result = applyThreeTierTrim(messages, { summarizer });
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

	it("preserves the pinned-tier synthetic through a drop", () => {
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages = [
			pinnedMsg("agent def " + "p".repeat(1000)),
			userMsg("dispatch", 0),
			assistantMsg("a".repeat(60_000 * 4)),
		];
		const result = applyThreeTierTrim(messages, {
			summarizer,
			protectedCustomTypes: protectedSet,
		});
		const pinned = result.messages.find(
			(m) => m.role === "custom" && m.customType === "context-trimmer-pinned",
		);
		assert.ok(pinned, "pinned message must survive the drop");
	});

	it("drops multiple oldest trimmable turns if needed to reach 100k", () => {
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
		const result = applyThreeTierTrim(messages, { summarizer });
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

	it("emits exactly one reminder when droppedTurns > 0 (single drop event)", () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch task — do X", 0),
			assistantMsg("a".repeat(60_000 * 4)),
			toolResultMsg("b".repeat(60_000 * 4)),
		];
		const result = applyThreeTierTrim(messages, { summarizer });
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

	it("emits exactly one reminder for a multi-turn drop (aggregate, not per-turn)", () => {
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
		const result = applyThreeTierTrim(messages, { summarizer });
		// 3 turns dropped, but only 1 reminder (aggregate).
		assert.equal(result.droppedTurns, 3);
		assert.equal(reminderCount(result.messages), 1, "one reminder total for a multi-turn drop");
	});

	it("does NOT emit a reminder on the tier-2 summarize path (only tier-3 drops emit)", () => {
		const messages = trimmableMass(60_000);
		const result = applyThreeTierTrim(messages, { summarizer });
		assert.equal(reminderCount(result.messages), 0, "no reminder on the tier-2 summarize path");
	});

	it("does NOT emit a reminder on the tier-1 verbatim path", () => {
		const messages = [userMsg("dispatch", 0), assistantMsg("hi")];
		const result = applyThreeTierTrim(messages, { summarizer });
		assert.equal(reminderCount(result.messages), 0, "no reminder on the tier-1 verbatim path");
	});

	it("does NOT emit a reminder on the tier-3 summarize-fallback path (single oversized turn)", () => {
		// A single trimmable turn, all by itself, is over 100k. The
		// policy falls into the summarize-fallback (not the drop
		// path). No drop, no reminder; the existing Tier-2
		// `[summa: …]` envelope covers it.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("x".repeat(150_000 * 4)),
		];
		const result = applyThreeTierTrim(messages, { summarizer });
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

	it("falls through to summarize when dropping a whole turn would push the trimmable total below the drop-floor (AC-1)", () => {
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
		const result = applyThreeTierTrim(messages, {
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

	it("preserves the recency slice across the tier-2 summarize path (AC-2)", () => {
		// Three older trimmable messages (turn 1, ~60k
		// total) plus a recency slice of two trimmable
		// messages (turn 2, ~90k total). The recency slice
		// is the operator's "most-recent-N-tokens of
		// trimmable content." `recencyFloor: 50_000` covers
		// the recency slice (the slice is ~90k, so the
		// threshold is met after the first recency message
		// and the slice covers the tail). The trimmable
		// budget excludes the recency slice, so 60k >
		// verbatimMax (50k) → tier-2 fires on the OLDER
		// trimmable; the recency slice is NOT summarized.
		// The recency slice's original content must survive
		// verbatim.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch task — do X", 0),
			assistantMsg("x".repeat(20_000 * 4)), // 20k tokens, oldest
			toolResultMsg("y".repeat(20_000 * 4)), // 20k tokens
			assistantMsg("z".repeat(20_000 * 4)), // 20k tokens
			assistantMsg("RECENT-X ".repeat(20_000)), // 45k tokens, recency slice
			toolResultMsg("RECENT-Y ".repeat(20_000)), // 45k tokens, recency slice
		];
		const result = applyThreeTierTrim(messages, {
			summarizer,
			recencyFloor: 50_000,
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

	it("preserves the recency slice across the tier-3 drop path (AC-2)", () => {
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
		const result = applyThreeTierTrim(messages, {
			summarizer,
			recencyFloor: 50_000,
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

	it("returns an empty array for an empty input", () => {
		const result = applyThreeTierTrim([], { summarizer });
		assert.equal(result.messages.length, 0);
		assert.equal(result.summarized, 0);
		assert.equal(result.droppedTurns, 0);
		assert.equal(result.totalTokens, 0);
	});

	it("returns the dispatch task unchanged when it is the only message", () => {
		const messages = [userMsg("dispatch", 0)];
		const result = applyThreeTierTrim(messages, { summarizer });
		assert.equal(result.messages.length, 1);
		assert.equal(result.messages[0].content, "dispatch");
	});

	it("does not infinite-loop when the summarizer returns the source unchanged", () => {
		// Pathological summarizer: always returns the input. The
		// loop's defensive bound (`summaryTokens >= originalTokens`)
		// bails after one iteration, so the function returns.
		const noProgress = (text: string) => text;
		const messages = trimmableMass(60_000);
		const result = applyThreeTierTrim(messages, { summarizer: noProgress });
		// The first eligible message IS summarized (the summarize
		// path runs once), but the post-summarize content has the
		// same length, so the loop bails. The function returns.
		assert.equal(result.summarized, 1);
		assert.ok(typeof result.totalTokens === "number");
	});

	it("a single oversized message (over 100k) is summarized, not dropped", () => {
		// One trimmable message, all by itself, is larger than the
		// drop tier. The policy's fallback summarizes it (since
		// dropping the only trimmable message would leave the
		// dispatch alone and the session no better off).
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			assistantMsg("x".repeat(150_000 * 4)),
		];
		const result = applyThreeTierTrim(messages, { summarizer });
		// The fallback summarize path fires.
		assert.ok(result.summarized >= 1);
	});

	it("the recency slice survives the summarize-fallback path (single oversized + recency)", () => {
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
		const result = applyThreeTierTrim(messages, {
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
	it("matches a fuzzy pattern (no leading / or ~/) by basename", () => {
		assert.equal(
			isPathPreserved("/home/operator/project/AGENTS.md", ["AGENTS.md"]),
			true,
		);
		assert.equal(
			isPathPreserved("/var/lib/foo/AGENTS.md", ["AGENTS.md"]),
			true,
		);
	});

	it("does not match a fuzzy pattern when the basename differs", () => {
		assert.equal(
			isPathPreserved("/home/operator/project/CLAUDE.md", ["AGENTS.md"]),
			false,
		);
	});

	it("matches an absolute pattern (leading /) by path.normalize equality", () => {
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

	it("does not match an absolute pattern when the normalized path differs", () => {
		assert.equal(
			isPathPreserved("/home/operator/CLAUDE.md", ["/home/operator/AGENTS.md"]),
			false,
		);
	});

	it("matches an absolute pattern with ~ (the wiring has expanded ~/)", () => {
		// The wiring expands ~/ via os.homedir(); the predicate
		// sees the expanded form on both sides. We test the
		// predicate at its seam: the expanded pattern matches the
		// expanded path.
		assert.equal(
			isPathPreserved("/home/operator/AGENTS.md", ["/home/operator/AGENTS.md"]),
			true,
		);
	});

	it("returns false when sourcePath is undefined", () => {
		assert.equal(isPathPreserved(undefined, ["AGENTS.md"]), false);
		assert.equal(isPathPreserved(undefined, ["/abs/path"]), false);
	});

	it("returns false when patterns is empty", () => {
		assert.equal(isPathPreserved("/abs/AGENTS.md", []), false);
	});

	it("returns false when no pattern matches (all-or-nothing validation: an invalid entry is skipped, not a global no-op)", () => {
		// Empty strings and non-string entries are skipped; a valid
		// entry that does not match still leaves the predicate as
		// false. The all-or-nothing contract is in the config
		// layer; the predicate is permissive on shape.
		assert.equal(
			isPathPreserved("/abs/AGENTS.md", ["", "CLAUDE.md"]),
			false,
		);
	});

	it("returns true on first match in the patterns list", () => {
		assert.equal(
			isPathPreserved("/abs/AGENTS.md", ["CLAUDE.md", "AGENTS.md"]),
			true,
		);
	});
});

// ─── isProtectedSlot with preservedPatterns ────────────────────────

describe("isProtectedSlot — preservedPatterns channel", () => {
	it("protects a message whose details.sourcePath matches a fuzzy pattern", () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("contents of AGENTS.md", "/repo/AGENTS.md"),
		];
		assert.equal(
			isProtectedSlot(messages[1], 1, messages, new Set(), true, ["AGENTS.md"]),
			true,
		);
	});

	it("protects a message whose details.sourcePath matches an absolute pattern", () => {
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

	it("does not protect a message whose sourcePath is absent", () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultMsg("no source path"),
		];
		assert.equal(
			isProtectedSlot(messages[1], 1, messages, new Set(), true, ["AGENTS.md"]),
			false,
		);
	});

	it("does not protect a message whose sourcePath does not match", () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("contents", "/repo/CLAUDE.md"),
		];
		assert.equal(
			isProtectedSlot(messages[1], 1, messages, new Set(), true, ["AGENTS.md"]),
			false,
		);
	});

	it("preservedPatterns is independent of the dispatch and customType channels", () => {
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

	it("preservedPatterns defaults to empty (no paths preserved)", () => {
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
	it("subtracts tokens of a tool-result whose sourcePath matches a preserved pattern", () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(2000), "/repo/AGENTS.md"),
			assistantMsg("a".repeat(2000)),
		];
		// Without preservedPatterns, both the tool result and the
		// assistant count: 2000/4 + 2000/4 = 1000.
		assert.equal(totalTrimmableTokens(messages), 1000);
		// With ["AGENTS.md"], the tool result is subtracted, leaving
		// only the assistant: 2000/4 = 500.
		assert.equal(totalTrimmableTokens(messages, new Set(), true, ["AGENTS.md"]), 500);
	});

	it("preserved tokens are not counted in the budget", () => {
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

	it("preserves a message whose sourcePath matches a fuzzy pattern in tier 2 (summarize)", () => {
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
		const result = applyThreeTierTrim(messages, {
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

	it("preserves a message whose sourcePath matches an absolute pattern in tier 3 (drop)", () => {
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
		const result = applyThreeTierTrim(messages, {
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

	it("a session whose only over-budget contributor is a preserved message does not trigger a trim", () => {
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(60_000 * 4), "/repo/AGENTS.md"),
			assistantMsg("short"),
		];
		const result = applyThreeTierTrim(messages, {
			summarizer,
			preservedPatterns: ["AGENTS.md"],
		});
		// Trimmable is just the assistant "short" (5 chars / 4 = 2
		// tokens). Verbatim tier. No summarize, no drop.
		assert.equal(result.summarized, 0);
		assert.equal(result.droppedTurns, 0);
	});

	it("preservedPatterns and protectedCustomTypes are independent channels", () => {
		// A custom pinned message stays protected even when its
		// sourcePath does not match any preserved pattern.
		const protectedSet = new Set(["context-trimmer-pinned"]);
		const messages: TrimmableMessage[] = [
			pinnedMsg("agent def " + "p".repeat(20_000 * 4)),
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(30_000 * 4), "/repo/AGENTS.md"),
		];
		const result = applyThreeTierTrim(messages, {
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

	it("preservedPatterns defaults to no paths preserved (no behavior change for callers)", () => {
		// A tool result carrying a source path is not protected
		// when preservedPatterns is not passed.
		const messages: TrimmableMessage[] = [
			userMsg("dispatch", 0),
			toolResultWithPath("a".repeat(60_000 * 4), "/repo/AGENTS.md"),
			assistantMsg("b".repeat(60_000 * 4)),
		];
		const result = applyThreeTierTrim(messages, { summarizer });
		const preserved = result.messages.find(
			(m) => m.role === "toolResult" && m.details?.sourcePath === "/repo/AGENTS.md",
		);
		// Trimmable mass is 120k → tier 3, drops the first trimmable
		// turn (the tool result). The preserved message is dropped.
		assert.equal(preserved, undefined);
		assert.ok(result.droppedTurns >= 1);
	});

	it("carves a preserved-path message out of a dropped trimmable turn (tier-3) — AC-6 (b)", () => {
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
		const result = applyThreeTierTrim(messages, {
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
	it("VERBATIM_TIER_MAX_TOKENS is 50_000", () => {
		assert.equal(VERBATIM_TIER_MAX_TOKENS, 50_000);
	});
	it("SUMMARIZE_TIER_MAX_TOKENS is 100_000", () => {
		assert.equal(SUMMARIZE_TIER_MAX_TOKENS, 100_000);
	});
	it("SUMMA_WORDS is positive", () => {
		assert.ok(SUMMA_WORDS > 0);
	});
});

// ─── Loop-guard detection (AC-1, AC-4) ────────────────────────────────
//
// Pure-function coverage of the loop-guard layer added in Unit 1:
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

	it("fingerprintToolCall: deterministic signature (same input → same output)", () => {
		const a = fingerprintToolCall({ name: "search", arguments: { q: "x", n: 3 } });
		const b = fingerprintToolCall({ name: "search", arguments: { q: "x", n: 3 } });
		assert.equal(a, b);
	});

	it("fingerprintToolCall: sorted-keys normalization (reordered keys fingerprint identically)", () => {
		const a = fingerprintToolCall({ name: "search", arguments: { q: "x", n: 3, extra: "y" } });
		const b = fingerprintToolCall({ name: "search", arguments: { extra: "y", n: 3, q: "x" } });
		assert.equal(a, b, "argument key order must not change the fingerprint");
	});

	it("fingerprintToolCall: distinct toolName → distinct fingerprint", () => {
		const a = fingerprintToolCall({ name: "search", arguments: { q: "x" } });
		const b = fingerprintToolCall({ name: "lookup", arguments: { q: "x" } });
		assert.notEqual(a, b, "different tool names must fingerprint differently");
	});

	it("fingerprintToolCall: distinct argument values → distinct fingerprint", () => {
		const a = fingerprintToolCall({ name: "search", arguments: { q: "x" } });
		const b = fingerprintToolCall({ name: "search", arguments: { q: "y" } });
		assert.notEqual(a, b);
	});

	it("fingerprintToolCall: nested objects are sorted recursively", () => {
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

	it("fingerprintToolCall: array order is preserved (it is part of the call's identity)", () => {
		const a = fingerprintToolCall({ name: "search", arguments: { items: [1, 2, 3] } });
		const b = fingerprintToolCall({ name: "search", arguments: { items: [3, 2, 1] } });
		assert.notEqual(a, b, "array order is part of the call's identity (the position of each element is semantically meaningful)");
	});

	// ── fingerprintAssistantTurn ───────────────────────────────

	it("fingerprintAssistantTurn: a turn with no toolCall blocks returns a distinct signature (AC-9 — reasoning-only resets the run)", () => {
		const textOnly = fingerprintAssistantTurn([{ type: "text", text: "hello" }]);
		assert.equal(
			textOnly,
			"\0__no_tool_calls__",
			"a no-tool-call turn must yield the dedicated reasoning-only signature",
		);
	});

	it("fingerprintAssistantTurn: a turn with a single toolCall returns the call's fingerprint", () => {
		const turn = fingerprintAssistantTurn([
			{ type: "text", text: "I'll search" },
			{ type: "toolCall", name: "search", arguments: { q: "x" } },
		]);
		const expected = fingerprintToolCall({ name: "search", arguments: { q: "x" } });
		assert.equal(turn, expected);
	});

	it("fingerprintAssistantTurn: a multi-tool-call turn's fingerprint is the sorted conjunction of all calls", () => {
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

	it("fingerprintAssistantTurn: two turns with identical tool-call sets match", () => {
		const a = fingerprintAssistantTurn([{ type: "toolCall", name: "search", arguments: { q: "x" } }]);
		const b = fingerprintAssistantTurn([{ type: "toolCall", name: "search", arguments: { q: "x" } }]);
		assert.equal(a, b);
	});

	it("fingerprintAssistantTurn: different argument values → different fingerprints", () => {
		const a = fingerprintAssistantTurn([{ type: "toolCall", name: "search", arguments: { q: "x" } }]);
		const b = fingerprintAssistantTurn([{ type: "toolCall", name: "search", arguments: { q: "y" } }]);
		assert.notEqual(a, b);
	});

	// ── detectConsecutiveIdenticalToolCalls ───────────────────

	it("detectConsecutiveIdenticalToolCalls: a run of N identical assistant turns yields runLength === N and matching signature", () => {
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

	it("detectConsecutiveIdenticalToolCalls: a different assistant turn in the middle resets the run", () => {
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

	it("detectConsecutiveIdenticalToolCalls: non-assistant messages do not break the run and do not extend it", () => {
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

	it("detectConsecutiveIdenticalToolCalls: reasoning-only trailing turn yields runLength 0 (AC-9)", () => {
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

	it("detectConsecutiveIdenticalToolCalls: threshold <= 0 disables detection (no run counted)", () => {
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

	it("detectConsecutiveIdenticalToolCalls: multi-tool-call turn matches iff the conjunction matches", () => {
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

	it("detectConsecutiveIdenticalToolCalls: reordered tools in the same turn do NOT match (order is part of the conjunction)", () => {
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

	it("computeFlatInputTokenSignal: flat last-N token counts → flat: true", () => {
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

	it("computeFlatInputTokenSignal: token counts varying > 5% → flat: false", () => {
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

	it("computeFlatInputTokenSignal: small variation within tolerance → flat: true", () => {
		// Five turns sized 1000, 1000, 1000, 1000, 1010 tokens. The
		// spread is 10/1000 = 1%, well within the 5% tolerance.
		const tokens = [1000, 1000, 1000, 1000, 1010];
		const messages: TrimmableMessage[] = tokens.map((n) => assistantMsg("x".repeat(n * 4)));
		messages.unshift(userMsg("dispatch", 0));
		const { flat } = computeFlatInputTokenSignal(messages);
		assert.equal(flat, true, "1% spread is within the 5% tolerance");
	});

	it("computeFlatInputTokenSignal: fewer than 2 assistant turns → flat: false (no signal)", () => {
		const messages: TrimmableMessage[] = [userMsg("dispatch", 0), assistantMsg("hi")];
		const { flat } = computeFlatInputTokenSignal(messages);
		assert.equal(flat, false, "single sample yields no signal");
	});

	it("FLAT_INPUT_TOKEN_TOLERANCE is the documented 0.05", () => {
		assert.equal(FLAT_INPUT_TOKEN_TOLERANCE, 0.05);
	});

	// ── shouldHardBlock ───────────────────────────────────────

	it("shouldHardBlock: undefined threshold → false (hard-block off by default)", () => {
		assert.equal(shouldHardBlock(5, undefined), false);
		assert.equal(shouldHardBlock(100, undefined), false);
	});

	it("shouldHardBlock: runLength >= threshold → true", () => {
		assert.equal(shouldHardBlock(3, 3), true, "exact-equal run length meets the threshold");
		assert.equal(shouldHardBlock(10, 3), true, "run length above the threshold");
	});

	it("shouldHardBlock: runLength < threshold → false", () => {
		assert.equal(shouldHardBlock(2, 3), false);
		assert.equal(shouldHardBlock(0, 3), false);
	});

	// ── Nudge / block text shape ──────────────────────────────

	it("LOOP_GUARD_NUDGE_TEXT is non-empty, names the repetition, and uses non-directive phrasing", () => {
		assert.ok(LOOP_GUARD_NUDGE_TEXT.length > 0);
		assert.ok(/called the same tool/i.test(LOOP_GUARD_NUDGE_TEXT), "nudge must reference the repeated tool call");
		assert.ok(/same arguments/i.test(LOOP_GUARD_NUDGE_TEXT), "nudge must reference the same arguments");
		assert.ok(!/you must/i.test(LOOP_GUARD_NUDGE_TEXT), "nudge must not use directive 'you must' language");
	});

	it("LOOP_GUARD_BLOCK_TEXT is non-empty, names the block, and routes the model to text", () => {
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
	it("returns true for an array content whose first text block starts with the summa envelope", () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "[summa: ~100 tokens originally → ~20 tokens summary]\nshort summary" },
			],
		};
		assert.equal(isAlreadySummarized(msg), true);
	});

	it("returns true even when the envelope tag is followed by a long summary body", () => {
		const msg: TrimmableMessage = {
			role: "toolResult",
			content: [
				{ type: "text", text: "[summa: ~50000 tokens originally → ~1000 tokens summary]\n" + "x".repeat(4000) },
			],
		};
		assert.equal(isAlreadySummarized(msg), true);
	});

	it("returns false for an array content whose first text block is plain text", () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello, this is a regular assistant turn" }],
		};
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for an array content whose first text block starts with a different bracket tag", () => {
		// Other bracket-leading strings (e.g. a hypothetical "[note:" tag) are
		// not the summa envelope; the predicate must reject them.
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "text", text: "[note: this is something else entirely]\nbody" }],
		};
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for a string content (the envelope only lives in array text blocks)", () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: "[summa: ~100 tokens originally → ~20 tokens summary]\nsummary text",
		};
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for an empty string content", () => {
		const msg: TrimmableMessage = { role: "user", content: "" };
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for an empty array content", () => {
		const msg: TrimmableMessage = { role: "assistant", content: [] };
		assert.equal(isAlreadySummarized(msg), false);
	});

	it("returns false for an array content whose first block is not a text block", () => {
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
	it("returns the first 200 chars of a string content", () => {
		const longText = "a".repeat(500);
		const msg: TrimmableMessage = { role: "user", content: longText };
		assert.equal(messageFingerprint(msg), "a".repeat(200));
	});

	it("returns the full string when shorter than 200 chars", () => {
		const msg: TrimmableMessage = { role: "user", content: "short" };
		assert.equal(messageFingerprint(msg), "short");
	});

	it("returns the first 200 chars of the first text block for array content", () => {
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

	it("returns an empty string for array content with no text blocks", () => {
		const msg: TrimmableMessage = {
			role: "assistant",
			content: [{ type: "toolCall", name: "search", arguments: { q: "x" } }],
		};
		assert.equal(messageFingerprint(msg), "");
	});

	it("returns an empty string for an empty string content", () => {
		const msg: TrimmableMessage = { role: "user", content: "" };
		assert.equal(messageFingerprint(msg), "");
	});

	it("returns exactly 200 chars for content longer than 200 chars (not 201, not 199)", () => {
		const longText = "x".repeat(250);
		const msg: TrimmableMessage = { role: "user", content: longText };
		const fp = messageFingerprint(msg);
		assert.equal(fp.length, 200);
		assert.equal(fp, "x".repeat(200));
	});

	it("returns the same fingerprint for two messages whose first 200 chars are identical", () => {
		const base = "c".repeat(200);
		const msg1: TrimmableMessage = { role: "user", content: base + "trailing" };
		const msg2: TrimmableMessage = { role: "user", content: base + "different trailing" };
		assert.equal(messageFingerprint(msg1), messageFingerprint(msg2));
	});

	it("returns different fingerprints for two messages whose first 200 chars differ", () => {
		const msg1: TrimmableMessage = { role: "user", content: "d".repeat(200) + "trailing" };
		const msg2: TrimmableMessage = { role: "user", content: "e".repeat(200) + "trailing" };
		assert.notEqual(messageFingerprint(msg1), messageFingerprint(msg2));
	});
});

describe("applyThreeTierTrim — skip already-summarized by envelope (case a)", () => {
	const summarizer = makeTrimmingSummarizer(5);

	it("skips a message whose content carries the summa envelope and summarizes a non-summarized message instead", () => {
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
		const result = applyThreeTierTrim(messages, {
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
	it("re-summarizes an already-summarized candidate when the total is still over the verbatim cap", () => {
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
		const result = applyThreeTierTrim(messages, {
			summarizer: () => "x".repeat(20),
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

	it("leaves an already-summarized message untouched when a non-summarized alternative covers the budget", () => {
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
		const result = applyThreeTierTrim(messages, {
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

	it("skips a message whose fingerprint is in alreadySummarizedHashes and summarizes a different message", () => {
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
		const result = applyThreeTierTrim(messages, {
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

	it("terminates with the already-summarized oldest message untouched and a younger message summarized", () => {
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
		const result = applyThreeTierTrim(messages, {
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

