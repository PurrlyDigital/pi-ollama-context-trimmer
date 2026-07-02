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
	isPathPreserved,
	isProtectedSlot,
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
		// The dispatch is preserved.
		assert.equal(result.messages[0].content, "dispatch");
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
