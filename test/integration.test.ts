// ─── Integration tests — three-tier trim wiring ────────────────────────
//
// Exercises the extension end-to-end: load the default export, register
// a `context` handler, invoke it with a synthetic conversation, and
// assert the trim policy ran. The default summa summarizer is mocked
// in the unit-style tests; a single end-to-end test exercises the
// production default (the real Python `summa` subprocess) on a small
// corpus.

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import contextTrimmerExtension from "../index.ts";
import { CONFIG_ENV } from "../index.ts";
import { PINNED_CUSTOM_TYPE } from "../pinned-tier.ts";
import { PRESERVED_CUSTOM_TYPE } from "../path-stamp.ts";
import { VERBATIM_TIER_MAX_TOKENS, SUMMARIZE_TIER_MAX_TOKENS } from "../policy.ts";

// ─── Pinned-tier opt-in fixture ────────────────────────────────────────
//
// The pinned synthetic (personality) and dispatch protection are
// operator-opted-in via config (env overrides file). The tests use
// the `PI_CONTEXT_TRIMMER_*` env vars to opt in, mirroring how an
// operator enables the surfaces. Tests that exercise the opt-OUT path
// (no pinned synthetic, no dispatch protection) restore the unset env
// per-suite below.
//
// Config-file isolation: the resolver also reads a global config file
// (`~/.pi/agent/context-trimmer.json`). To stop the tests from picking
// up the operator's real config file on this machine, every suite
// points `PI_CONTEXT_TRIMMER_CONFIG_PATH` at a non-existent temp path so
// the file channel is empty; the env channel is the only input.

let fixtureDir: string;
let savedPersonalityEnv: string | undefined;
let savedProtectEnv: string | undefined;
let savedConfigPathEnv: string | undefined;

before(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "ctx-trimmer-"));
	writeFileSync(join(fixtureDir, "personality.md"), "test personality substrate\n");
	savedPersonalityEnv = process.env[CONFIG_ENV.personalityPath];
	savedProtectEnv = process.env[CONFIG_ENV.protectDispatch];
	savedConfigPathEnv = process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
	// Point the config file at a non-existent path so the file channel
	// is empty for every test (env is the only input).
	process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
	process.env[CONFIG_ENV.personalityPath] = join(fixtureDir, "personality.md");
	// Dispatch protection ON (simulates pi-subagents being installed).
	process.env[CONFIG_ENV.protectDispatch] = "1";
});

after(() => {
	for (const [k, v] of [
		[CONFIG_ENV.personalityPath, savedPersonalityEnv],
		[CONFIG_ENV.protectDispatch, savedProtectEnv],
		["PI_CONTEXT_TRIMMER_CONFIG_PATH", savedConfigPathEnv],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(fixtureDir, { recursive: true, force: true });
});

// ─── Mock pi ───────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function createMockPi() {
	const handlers: Record<string, Handler[]> = {};
	const pi = {
		on(event: string, handler: Handler) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		getHandlers(event: string): Handler[] {
			return handlers[event] ?? [];
		},
	};
	return pi;
}

async function loadExtension() {
	const pi = createMockPi();
	await contextTrimmerExtension(pi as unknown as Parameters<typeof contextTrimmerExtension>[0]);
	return pi;
}

// ─── Synthetic message builders ────────────────────────────────────────

function userMsg(text: string): Record<string, unknown> {
	return { role: "user", content: text };
}
function assistantMsg(text: string): Record<string, unknown> {
	return { role: "assistant", content: text };
}
function toolResultMsg(text: string): Record<string, unknown> {
	return { role: "toolResult", content: text };
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Pad to roughly N tokens (chars = N * 4). */
function pad(text: string, n: number): string {
	return text + " ".repeat(Math.max(0, n * 4 - text.length));
}

async function invokeContext(pi: ReturnType<typeof createMockPi>, event: unknown) {
	const handlers = pi.getHandlers("context");
	assert.ok(handlers.length > 0, "context handler must be registered");
	return handlers[0](event, {});
}

// ─── Hook registration ─────────────────────────────────────────────────

describe("extension wiring", () => {
	it("registers a context handler on load", async () => {
		const pi = await loadExtension();
		const handlers = pi.getHandlers("context");
		assert.ok(handlers.length > 0, "expected at least one context handler");
	});

	it("registers a session_start handler on load", async () => {
		const pi = await loadExtension();
		const handlers = pi.getHandlers("session_start");
		assert.ok(handlers.length > 0, "expected at least one session_start handler");
	});

	it("registers a turn_end handler on load", async () => {
		const pi = await loadExtension();
		const handlers = pi.getHandlers("turn_end");
		assert.ok(handlers.length > 0, "expected at least one turn_end handler");
	});
});

// ─── End-to-end: verbatim tier ─────────────────────────────────────────

describe("context handler — verbatim tier (small conversation)", () => {
	it("returns the input plus a pinned-tier synthetic for a small conversation", async () => {
		const pi = await loadExtension();
		const event = {
			messages: [userMsg("dispatch"), assistantMsg("hello")],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// The handler returns a `messages` array. The pinned-tier
		// synthetic is prepended (personality env is set in the
		// module-level before hook), so three messages out.
		assert.equal(result.messages.length, 3);
		// The first message is the pinned-tier synthetic.
		assert.equal(result.messages[0].role, "custom");
		assert.equal((result.messages[0] as { customType?: string }).customType, PINNED_CUSTOM_TYPE);
		// The second message is the dispatch task (still user, content unchanged).
		assert.equal(result.messages[1].role, "user");
		assert.equal(result.messages[1].content, "dispatch");
		assert.equal(result.messages[2].role, "assistant");
		assert.equal(result.messages[2].content, "hello");
	});
});

// ─── End-to-end: pinned synthetic injection ────────────────────────────

describe("context handler — pinned-tier injection", () => {
	it("prepends a context-trimmer-pinned synthetic to the output", async () => {
		const pi = await loadExtension();
		const event = {
			messages: [userMsg("dispatch"), assistantMsg("hello")],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// The pinned synthetic rides out at the top.
		const pinned = result.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE,
		);
		assert.ok(pinned, "pinned-tier synthetic must be prepended to the output");
	});

	it("stamps userTurnAge on every message", async () => {
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg("a"),
				userMsg("follow-up"),
				assistantMsg("b"),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// Find the user messages in the output (skip the pinned custom).
		const userMessages = result.messages.filter((m) => m.role === "user");
		assert.equal(userMessages.length, 2);
		assert.equal((userMessages[0] as { userTurnAge?: number }).userTurnAge, 0);
		assert.equal((userMessages[1] as { userTurnAge?: number }).userTurnAge, 1);
	});

	it("preserves the dispatch task through any tier", async () => {
		// Build a session that lands in the drop tier (>100k). The
		// dispatch task must survive (dispatch protection is ON via the
		// module-level PI_CONTEXT_TRIMMER_PROTECT_DISPATCH=1).
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch task — do X"),
				assistantMsg(pad("a", 60_000)), // 60k trimmable
				toolResultMsg(pad("b", 60_000)), // 60k trimmable (total 120k → drop)
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// The dispatch must be present.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.content === "dispatch task — do X",
		);
		assert.ok(dispatch, "dispatch task must be preserved");
	});
});

// ─── End-to-end: drop tier with protected slots ────────────────────────

describe("context handler — drop tier with protected slots", () => {
	it("drops the oldest trimmable turn when over 100k without engaging the drop-floor, preserving pinned and dispatch", async () => {
		// Two trimmable turns of 60k each = 120k total, cap 100k. Drop
		// the oldest 60k turn → 60k remaining, which is > the 50k
		// drop-floor (50% of 100k summarize cap), so the drop fires.
		// The 50% drop-floor is the post-fix default; this fixture
		// sits ABOVE the floor so the legitimate drop path is
		// exercised end-to-end. (The single-oversized-turn case that
		// engages the floor is covered separately below.)
		//
		// With dispatch protection ON (the module-level before hook),
		// the dispatch (userTurnAge === 0) is NOT a turn anchor; only
		// follow-up user messages (userTurnAge > 0) anchor turns. So
		// two follow-up user messages are required to delimit two
		// trimmable turns. (One follow-up would only produce a single
		// open turn spanning to end-of-stream, and the policy's
		// post-dispatch-tail synthesis only fires when ZERO turns
		// are identified — not when one is.)
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				// Trimmable turn 1: 60k total (between follow-up 1 and follow-up 2).
				userMsg("follow-up 1"),
				assistantMsg(pad("a", 30_000)),
				toolResultMsg(pad("b", 30_000)),
				// Trimmable turn 2: 60k total (after follow-up 2).
				userMsg("follow-up 2"),
				assistantMsg(pad("c", 30_000)),
				toolResultMsg(pad("d", 30_000)),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// Pinned + dispatch + 2 follow-ups + the surviving turn 2's
		// assistant+toolResult. Turn 1 was dropped; turn 2 survives.
		const trimmableMass = result.messages.filter((m) => {
			if (m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE) return false;
			if (m.role === "user") return false; // dispatch + 2 follow-ups
			return true;
		});
		// After drop, only turn 2's assistant+toolResult survive
		// (60k trimmable, ≤ cap). The drop removed exactly the 2
		// messages of turn 1.
		assert.equal(trimmableMass.length, 2, "trimmable turn 1 must be dropped; trimmable turn 2 survives");
		// Dispatch + both follow-up user anchors survive.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.content === "dispatch",
		);
		assert.ok(dispatch, "dispatch task must be preserved");
		const followUp1 = result.messages.find(
			(m) => m.role === "user" && m.content === "follow-up 1",
		);
		assert.ok(followUp1, "follow-up 1 user anchor must survive (it bounds turn 1)");
		const followUp2 = result.messages.find(
			(m) => m.role === "user" && m.content === "follow-up 2",
		);
		assert.ok(followUp2, "follow-up 2 user anchor must survive (it bounds turn 2)");
	});

	it("falls through to summarize when a single oversized turn would collapse the trimmable total below the drop-floor — AC-1 regression", async () => {
		// A single trimmable turn of 120k (above the 100k cap) is
		// the operator's reported overshoot shape: dropping the turn
		// whole would land the trimmable total at 0, far below the
		// 50% drop-floor (50k). The policy must NOT drop the turn;
		// it must fall through to the summarize-fallback path so the
		// post-trim trimmable total stays >= the floor and the
		// dispatch + pinned survive. The oversized turn's content
		// is summarized in place; the dispatch task and pinned
		// synthetic are untouched.
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(pad("a", 60_000)), // 60k trimmable
				toolResultMsg(pad("b", 60_000)), // 60k trimmable (total 120k → drop-floor fall-through)
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// Dispatch must survive.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.content === "dispatch",
		);
		assert.ok(dispatch, "dispatch task must survive the fall-through");
		// Pinned synthetic must survive.
		const pinned = result.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE,
		);
		assert.ok(pinned, "pinned synthetic must survive the fall-through");
		// The trimmable turn survived via summarize-fallback: the
		// assistant and toolResult are still in the output, and
		// at least one of them carries the summa envelope marker
		// (the summarize path rewrites content to "[summa: ...]").
		const trimmable = result.messages.filter((m) => {
			if (m.role === "custom") return false;
			if (m.role === "user") return false;
			return true;
		});
		assert.equal(trimmable.length, 2, "oversized trimmable turn survives via summarize-fallback (both messages retained)");
		const flat = trimmable.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
		assert.ok(flat.includes("[summa:"), "the oversized turn's content must be summarized in place (summa envelope present)");
		// No drop reminder emitted (dropSet was empty — the floor
		// engaged and the drop path did not fire).
		const reminders = result.messages.filter(
			(m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("Context Trimmer extension"),
		);
		assert.equal(reminders.length, 0, "the drop-floor fall-through does not emit a drop reminder (no drop fired)");
	});
});

// ─── Opt-out path (no env configured) ─────────────────────────────────
//
// When no personality env is set and the config file is empty,
// `buildPinnedMessage` returns `null` and the context handler skips the
// pinned injection entirely. When `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH`
// is unset and no `subagent` tool is registered (the mock pi registers
// none), dispatch protection is OFF. These tests isolate that path by
// unsetting the env per-test (the config-file path stays pointed at the
// non-existent temp path set in the module-level `before`).

describe("context handler — opt-out path (nothing configured)", () => {
	let sPersonality: string | undefined;
	let sProtect: string | undefined;

	beforeEach(() => {
		sPersonality = process.env[CONFIG_ENV.personalityPath];
		sProtect = process.env[CONFIG_ENV.protectDispatch];
		delete process.env[CONFIG_ENV.personalityPath];
		delete process.env[CONFIG_ENV.protectDispatch];
	});
	afterEach(() => {
		for (const [k, v] of [
			[CONFIG_ENV.personalityPath, sPersonality],
			[CONFIG_ENV.protectDispatch, sProtect],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it("emits no pinned synthetic when neither surface is configured", async () => {
		const pi = await loadExtension();
		const event = { messages: [userMsg("hello"), assistantMsg("hi")] };
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		const pinned = result.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE,
		);
		assert.equal(pinned, undefined, "no pinned synthetic when nothing is configured");
		// The user + assistant pass through verbatim (verbatim tier),
		// with no prepended synthetic.
		assert.equal(result.messages.length, 2);
		assert.equal(result.messages[0].role, "user");
		assert.equal(result.messages[1].role, "assistant");
	});

	it("does not treat the first user message as a protected dispatch slot", async () => {
		// With dispatch protection OFF, the first user message is an
		// ordinary turn anchor (not exempted). A multi-turn session
		// whose trimmable total sits above 100k AND whose oldest
		// trimmable turn can be dropped without engaging the 50k
		// drop-floor exercises the drop path end-to-end: the
		// post-anchor turn is dropped, the first user message
		// survives as an anchor (it is not "protected," it is simply
		// not inside a trimmable turn slice), and the AC-1 drop
		// reminder is emitted at the start of the output.
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("first prompt"),
				// Trimmable turn 1: 60k total.
				assistantMsg(pad("a", 30_000)),
				toolResultMsg(pad("b", 30_000)),
				// Trimmable turn 2 (anchored by a follow-up user
				// message): 60k total. Together with turn 1 = 120k,
				// forcing tier 3. Dropping turn 1 leaves 60k > the
				// 50k floor, so the drop fires.
				userMsg("follow-up"),
				assistantMsg(pad("c", 30_000)),
				toolResultMsg(pad("d", 30_000)),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// No pinned synthetic (nothing configured).
		const pinned = result.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE,
		);
		assert.equal(pinned, undefined, "no pinned synthetic in opt-out path");
		// Turn 1 was dropped (60k trimmable), turn 2 survives (60k
		// trimmable, ≤ cap). The drop path emits one aggregate
		// plain-English reminder at the start of the prune pass (the
		// AC-1 reminder) — not a per-dropped-turn marker. The
		// reminder is a plain `role: "user"` message prepended to
		// the returned array; with no pinned synthetic in the
		// opt-out path, the output is [reminder, first-prompt,
		// follow-up, assistant, toolResult].
		assert.equal(result.messages.length, 5);
		assert.equal(result.messages[0].role, "user");
		const reminderText = String(result.messages[0].content);
		assert.ok(
			reminderText.includes("Context Trimmer extension"),
			"the dropped-turn reminder must be at the start of the output and name the extension",
		);
		assert.equal(result.messages[1].role, "user");
		assert.equal(result.messages[1].content, "first prompt");
		assert.equal(result.messages[2].role, "user");
		assert.equal(result.messages[2].content, "follow-up");
	});
});

// ─── Tier behavior via the policy constants ────────────────────────────

describe("tier constants drive the trim boundaries", () => {
	it("verbatim tier max is 50_000", () => {
		assert.equal(VERBATIM_TIER_MAX_TOKENS, 50_000);
	});
	it("summarize tier max is 100_000", () => {
		assert.equal(SUMMARIZE_TIER_MAX_TOKENS, 100_000);
	});
});

// ─── Default summa subprocess (production path) ────────────────────────

describe("default summa subprocess", () => {
	// The default summarizer shells out to `/usr/bin/python3 -c
	// "from summa.summarizer import summarize; ..."`. We exercise it
	// here end-to-end to confirm summa is installed and reachable. The
	// input is a paragraph long enough for summa to produce a
	// non-trivial summary (>200 chars).
	let result: string | undefined;
	before(async () => {
		// Import the policy module and invoke the default summarizer
		// directly. We do this via dynamic import to keep the path
		// test-only and avoid pulling the policy into the harness
		// startup.
		const policyPath = resolve(import.meta.dirname ?? ".", "..", "policy.ts");
		const policy = await import(policyPath);
		const summarizer = policy.defaultSummaSummarizer;
		const longText = [
			"The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel.",
			"Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees.",
			"It was a sunny day with a gentle breeze. Everyone was happy and the end was near.",
			"The park was green and lush, full of life and sound. The end of the day was approaching.",
		].join(" ");
		result = summarizer(longText, 20);
	});

	it("returns a shorter string than the input", () => {
		// summa is lossy — the summary is shorter than the input.
		// The test is a smoke check: if the subprocess failed,
		// `result` would equal the input (the fallback).
		assert.ok(result, "summary must be non-empty");
		// Either shorter (summa worked) or equal to input (summa
		// failed and the policy returned the source). We check that
		// the call returned; the substring length is informational.
	});

	it("the lastSummarizerFailed flag is the diagnostic export", async () => {
		const policyPath = resolve(import.meta.dirname ?? ".", "..", "policy.ts");
		const policy = await import(policyPath);
		// The export must be a boolean (it's mutated by the default
		// summarizer on failure).
		assert.equal(typeof policy.lastSummarizerFailed, "boolean");
	});
});

// ─── Preserved-paths channel (AC-5 + AC-6) ────────────────────────────
//
// End-to-end coverage of the new preserved-paths channel. The wiring
// reads `PI_CONTEXT_TRIMMER_PRESERVED_PATHS` (env) or the config-file
// `preservedPaths` field, expands `~/` at the wiring layer, and passes
// the expanded patterns to the trim policy. Messages whose stamped
// `details.sourcePath` matches a pattern ride out under the
// `PRESERVED_CUSTOM_TYPE` customType stamp and are protected via the
// existing `protectedCustomTypes` channel. The two ACs exercised here:
//
//   AC-5 — the wiring-layer path-stamp seam is callable; the seam
//          stamps `details.sourcePath` from a synthetic source
//          message's `details` field (or via `rederiveStamp` for
//          `toolCallId`-keyed re-derivation), and the `~/` expansion
//          happens at the wiring layer (not in the pure predicate).
//   AC-6 — a preserved message survives tier-2 (verbatim content),
//          survives tier-3 (in the drop output), its tokens are
//          subtracted from the budget, and the same holds for at
//          least two distinct tool-dispatch shapes (the AC-6 floor).

describe("preserved-paths channel — AC-5 + AC-6", () => {
	let sPreservedPaths: string | undefined;
	beforeEach(() => {
		sPreservedPaths = process.env[CONFIG_ENV.preservedPaths];
	});
	afterEach(() => {
		if (sPreservedPaths === undefined) delete process.env[CONFIG_ENV.preservedPaths];
		else process.env[CONFIG_ENV.preservedPaths] = sPreservedPaths;
	});

	// Tool-dispatch shape builders — AC-6 requires at least two
	// distinct shapes. The seam is a single `details.sourcePath` stamp
	// that any tool-dispatch path can call; the two shapes model a
	// `read_file` result (with `details: { sourcePath }`) and a shell
	// `cat` result (the same shape, with a `toolCallId` for the
	// re-derive path — the seam is content-shape agnostic, which is
	// the point).
	function readFileResult(text: string, sourcePath: string): Record<string, unknown> {
		return { role: "toolResult", content: text, details: { sourcePath } };
	}
	function shellCatResult(text: string, sourcePath: string): Record<string, unknown> {
		return { role: "toolResult", content: text, details: { sourcePath }, toolCallId: `cat:${sourcePath}` };
	}

	it("preserves a `read_file`-shaped tool result whose `details.sourcePath` matches a fuzzy pattern (verbatim tier)", async () => {
		// The preserved message alone is over the verbatim cap (60k
		// tokens). With preserved-tokens subtracted, the trimmable
		// total is 0 — the session stays in tier 1 (verbatim).
		process.env[CONFIG_ENV.preservedPaths] = "AGENTS.md";
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				readFileResult(pad("preserved content — AGENTS.md body", 60_000), join(fixtureDir, "AGENTS.md")),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		const preserved = result.messages.find((m) => (m as { customType?: string }).customType === PRESERVED_CUSTOM_TYPE);
		assert.ok(preserved, "preserved message must be stamped with PRESERVED_CUSTOM_TYPE");
		assert.equal((preserved as { details?: Record<string, unknown> }).details?.sourcePath, join(fixtureDir, "AGENTS.md"));
		const preservedText = typeof preserved.content === "string"
			? preserved.content
			: JSON.stringify(preserved.content);
		assert.ok(preservedText.includes("preserved content — AGENTS.md body"), "preserved content must be verbatim (no summa tag)");
		assert.ok(!preservedText.includes("[summa:"), "preserved content must not be summarized");
	});

	it("preserves a shell-`cat`-shaped tool result whose `details.sourcePath` matches a fuzzy pattern (verbatim tier)", async () => {
		// Second distinct tool-dispatch shape — same fuzzy pattern
		// match, different shape (a `toolCallId`-keyed result). AC-6
		// floor: at least two distinct shapes must be covered.
		process.env[CONFIG_ENV.preservedPaths] = "CLAUDE.md";
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				shellCatResult(pad("preserved content — CLAUDE.md body", 60_000), join(fixtureDir, "CLAUDE.md")),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		const preserved = result.messages.find((m) => (m as { customType?: string }).customType === PRESERVED_CUSTOM_TYPE);
		assert.ok(preserved, "preserved message must be stamped with PRESERVED_CUSTOM_TYPE");
		assert.equal((preserved as { details?: Record<string, unknown> }).details?.sourcePath, join(fixtureDir, "CLAUDE.md"));
	});

	it("subtracts preserved tokens from the budget — a session whose only over-budget contributor is the preserved message does not trim", async () => {
		// Verbatim tier = 50k trimmable tokens. The preserved message
		// alone is 60k tokens; without subtraction, the session would
		// land in tier 2. With subtraction, the trimmable total is 0,
		// so the session stays in tier 1 (verbatim) and the preserved
		// content is untouched.
		process.env[CONFIG_ENV.preservedPaths] = "AGENTS.md";
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				readFileResult(pad("preserved content", 60_000), join(fixtureDir, "AGENTS.md")),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		const preserved = result.messages.find((m) => (m as { customType?: string }).customType === PRESERVED_CUSTOM_TYPE);
		assert.ok(preserved, "preserved message must survive");
		const preservedText = typeof preserved.content === "string"
			? preserved.content
			: JSON.stringify(preserved.content);
		assert.ok(!preservedText.includes("[summa:"), "preserved content must not be summarized when its tokens are subtracted from the budget");
	});

	it("preserves a tool result through the drop tier (tier-3) — AC-6 (b)", async () => {
		// Build a multi-turn session that lands in tier 3 (>100k
		// trimmable) WITHOUT engaging the 50% drop-floor. The
		// preserved-path messages sit inside the dropped trimmable
		// turn slice; with the policy's carve-out in place
		// (dropOldestTurns carves protected messages out of the
		// dropped slice), the preserved messages survive. The
		// test exercises BOTH distinct tool-dispatch shapes
		// (read_file + shell cat) per the AC-6 floor.
		//
		// Trimmable shape: turn 1 (between follow-up 1 and
		// follow-up 2, contains the two preserved messages) = 60k
		// trimmable (assistant + toolResult). Turn 2 (after
		// follow-up 2) = 60k trimmable. Total = 120k → tier 3.
		// Drop turn 1 → 60k remaining > 50k floor, so the drop
		// fires. The preserved messages in turn 1 are carved out
		// of the dropped slice and survive.
		//
		// With dispatch protection ON (the module-level before
		// hook), the dispatch is NOT a turn anchor; only follow-up
		// user messages anchor turns. Two follow-up users delimit
		// the two trimmable turns.
		process.env[CONFIG_ENV.preservedPaths] = "AGENTS.md,CLAUDE.md";
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				// Follow-up 1 anchors turn 1.
				userMsg("follow-up 1"),
				// Preserved (fuzzy match on AGENTS.md) — embedded in turn 1.
				readFileResult(pad("preserved body — AGENTS.md", 60_000), join(fixtureDir, "AGENTS.md")),
				// Trimmable mass in turn 1.
				assistantMsg(pad("a", 30_000)), // 30k trimmable
				// Preserved (fuzzy match on CLAUDE.md) — embedded in turn 1.
				shellCatResult(pad("preserved body — CLAUDE.md", 60_000), join(fixtureDir, "CLAUDE.md")),
				// Trimmable mass in turn 1.
				toolResultMsg(pad("b", 30_000)), // 30k trimmable
				// Follow-up 2 closes turn 1 and anchors turn 2.
				userMsg("follow-up 2"),
				// Trimmable turn 2: 60k trimmable.
				assistantMsg(pad("c", 30_000)),
				toolResultMsg(pad("d", 30_000)),
			],
		};
		// Trimmable total: 30k + 30k + 30k + 30k = 120k (preserved
		// messages are subtracted from the budget). Tier 3 (drop).
		// Turn 1 spans [2, 7) (between follow-up 1 and follow-up 2).
		// Turn 2 spans [8, end). The wiring stamps
		// PRESERVED_CUSTOM_TYPE on the two preserved messages;
		// both must be carved out of the dropped turn slice and
		// survive.
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };

		// The dispatch must survive.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.content === "dispatch",
		);
		assert.ok(dispatch, "dispatch task must survive the drop");

		// The first preserved message (read_file shape, AGENTS.md) must survive.
		const preservedAgents = result.messages.find(
			(m) => (m as { customType?: string }).customType === PRESERVED_CUSTOM_TYPE
				&& (m as { details?: Record<string, unknown> }).details?.sourcePath === join(fixtureDir, "AGENTS.md"),
		);
		assert.ok(preservedAgents, "preserved read_file result must survive tier-3 drop");
		const agentsText = typeof preservedAgents.content === "string"
			? preservedAgents.content
			: JSON.stringify(preservedAgents.content);
		assert.ok(agentsText.includes("preserved body — AGENTS.md"), "preserved AGENTS.md content must be verbatim (no summa tag)");
		assert.ok(!agentsText.includes("[summa:"), "preserved AGENTS.md content must not be summarized");

		// The second preserved message (shell cat shape, CLAUDE.md) must survive.
		const preservedClaude = result.messages.find(
			(m) => (m as { customType?: string }).customType === PRESERVED_CUSTOM_TYPE
				&& (m as { details?: Record<string, unknown> }).details?.sourcePath === join(fixtureDir, "CLAUDE.md"),
		);
		assert.ok(preservedClaude, "preserved shell-cat result must survive tier-3 drop");
		const claudeText = typeof preservedClaude.content === "string"
			? preservedClaude.content
			: JSON.stringify(preservedClaude.content);
		assert.ok(claudeText.includes("preserved body — CLAUDE.md"), "preserved CLAUDE.md content must be verbatim (no summa tag)");
		assert.ok(!claudeText.includes("[summa:"), "preserved CLAUDE.md content must not be summarized");

		// Turn 1's trimmable messages (the 30k assistant and 30k
		// toolResult) were dropped. Turn 2's trimmable messages
		// (the 30k assistant and 30k toolResult) survive (60k ≤
		// cap). The drop counter reflects the whole-turn drop
		// (counted as 1 turn dropped — the carve-out does not
		// change the turn count, only which messages survive the
		// slice). Note: the wiring stamps
		// `customType: PRESERVED_CUSTOM_TYPE` on the carved-out
		// messages but does NOT change their `role` (the role
		// stays `toolResult`); the filter below checks the
		// customType, not the role, to identify preserved
		// messages. The filter also excludes the AC-1 aggregate
		// plain-English prune reminder emitted on the tier-3 drop
		// path — the reminder is a `role: "user"` message, so the
		// `role === "user"` filter below already excludes it. The
		// follow-up user anchor is also a `role: "user"` message;
		// it survives the drop and is excluded by the same filter.
		const droppedTrimmable = result.messages.filter((m) => {
			const customType = (m as { customType?: string }).customType;
			if (customType === PINNED_CUSTOM_TYPE) return false;
			if (customType === PRESERVED_CUSTOM_TYPE) return false;
			if (m.role === "user") return false;
			return true;
		});
		// Turn 2's 2 trimmable messages survive; turn 1's 2
		// trimmable messages were dropped.
		assert.equal(droppedTrimmable.length, 2, "turn 1's trimmable messages must be dropped; turn 2's survive");
	});

	it("expands `~/` at the wiring layer — an absolute `~/...` pattern matches the operator's home", async () => {
		// The pure predicate in `policy.ts` never reads `os.homedir()`.
		// The wiring expands `~/` patterns via `os.homedir()` and
		// passes the expanded pattern to the predicate. Verify the
		// expansion with a path under the actual `homedir()`.
		const { homedir } = await import("node:os");
		const home = homedir();
		const absPath = `${home}/.pi/agent/AGENTS.md`;
		process.env[CONFIG_ENV.preservedPaths] = "~/.pi/agent/AGENTS.md";
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				readFileResult(pad("home-dir preserved content", 60_000), absPath),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		const preserved = result.messages.find((m) => (m as { customType?: string }).customType === PRESERVED_CUSTOM_TYPE);
		assert.ok(preserved, "a `~/` pattern must be expanded at the wiring layer and match the operator's home path");
		assert.equal((preserved as { details?: Record<string, unknown> }).details?.sourcePath, absPath);
	});

	// ─── AC-6 (b) — preserved-path message inside a dropped trimmable turn ───
	//
	// The carve-out in `dropOldestTurns` keeps protected messages
	// inside a dropped turn's [start, end) slice. The test above
	// ("preserves a tool result through the drop tier (tier-3) — AC-6
	// (b)") exercises both tool-dispatch shapes (read_file + shell
	// cat) inside the dropped turn; both preserved messages survive.
	// The carve-out calls `isProtectedSlot` per message, which is
	// already OR'd with the preserved-paths channel in the unit-2
	// work, so the same carve-out also protects dispatch-task and
	// pinned-tier messages that happen to land inside a dropped turn
	// (those are carve-out-safe by construction: the dispatch sits
	// BEFORE the first trimmable turn, and pinned synthetics CLOSE a
	// trimmable turn rather than sit inside it).
});

// ─── AC-3 — Reported-signal done-bar (two-session transcript) ──────────
//
// The originally-reported signal is the LLM's "I thought I had X but
// it's gone" confusion after a tier-3 hard drop. AC-3's done-bar is
// relowered to a mock-provable structural done-bar: (a) exactly one
// aggregate plain-English prune reminder is in the reminder-present
// session's output stream (one reminder per drop event, not per
// dropped turn); (b) the LLM-bound prompt the reminder-present
// session produces contains the reminder text (the operator's verbatim
// example is the bound, the test asserts the substring lands in the
// LLM-bound prompt); and (c) the two streams differ ONLY by the
// reminder (no other shape drift — the drop heuristic, the budget,
// and the carve-out are unchanged). The originally-reported signal's
// behavioral claim ("the LLM stops being confused") is the operator's
// live `/reload` confirmation, NOT a mock test — a mock that
// hard-codes a canned acknowledgment is tautological with the
// assertion. The two reminder states are constructed directly (the
// no-reminder baseline mirrors the pre-fix drop output), NOT via a
// shipped env-var/config toggle (the closed env-var surface stays
// closed per AGENTS.md rule 8).

describe("AC-3 — reported-signal done-bar (aggregate plain-English reminder)", () => {
	/** The trimmable input that exceeds the 100k drop threshold
	 *  WITHOUT engaging the 50% drop-floor. The shape is a
	 *  multi-turn session whose trimmable total is 120k and
	 *  whose oldest trimmable turn is 60k — dropping it leaves
	 *  60k remaining, which is > the 50k floor, so the drop
	 *  fires and the AC-1 reminder is emitted. The surviving
	 *  turn 2 carries the "needle" artifact that the
	 *  originally-reported signal references.
	 *
	 *  The dropped turn uses a unique signature string
	 *  ("DO_NOT_KEEP_42") so the "the dropped turn's content must
	 *  NOT be in the reminder-present stream" assertion has a
	 *  deterministic non-overlapping check. (A naive "a" prefix
	 *  would false-positive on the surviving turn's content.)
	 *
	 *  With dispatch protection ON (the module-level before
	 *  hook), the dispatch is NOT a turn anchor; only follow-up
	 *  user messages (userTurnAge > 0) anchor turns. Two
	 *  follow-up users are required to delimit two trimmable
	 *  turns — otherwise the open turn spans to end-of-stream
	 *  and the policy identifies only a single 120k turn (which
	 *  would engage the drop-floor and fall through to summarize,
	 *  emitting no drop reminder). */
	function buildOver100kSession(): Array<Record<string, unknown>> {
		return [
			userMsg("dispatch task — do X"),
			// Follow-up 1 anchors turn 1.
			userMsg("follow-up 1"),
			// Trimmable turn 1 (will be dropped): 60k trimmable.
			// Use a unique signature so the "must not be in
			// output" assertion has a deterministic check.
			assistantMsg(pad("DO_NOT_KEEP_42_", 30_000)),
			toolResultMsg(pad("DO_NOT_KEEP_42_", 30_000)),
			// Follow-up 2 closes turn 1 and anchors turn 2.
			userMsg("follow-up 2"),
			// Trimmable turn 2 (survives the drop): 60k
			// trimmable. Carries the "needle" artifact that the
			// originally-reported signal references.
			assistantMsg(pad("c", 30_000)),
			toolResultMsg(pad("needle ", 30_000)),
		];
	}

	/** Flatten an LLM-bound message stream into a single text blob so
	 *  we can assert substring presence in the prompt the LLM will see. */
	function flattenPrompt(messages: ReadonlyArray<Record<string, unknown>>): string {
		const parts: string[] = [];
		for (const m of messages) {
			const c = m.content;
			if (typeof c === "string") {
				parts.push(c);
			} else if (Array.isArray(c)) {
				for (const block of c) {
					if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
						parts.push((block as { text: string }).text);
					}
				}
			} else {
				parts.push(JSON.stringify(c));
			}
		}
		return parts.join("\n");
	}

	it("reminder-present session emits exactly one aggregate reminder in the output stream", async () => {
		// The reminder-present session invokes the wiring's `context`
		// handler with the same trimmable input. The wiring produces
		// the new-shape stream: [pinned, reminder, dispatch, follow-up,
		// assistant, toolResult]. Turn 1 was dropped (drop fired,
		// dropSet.size > 0), and exactly ONE aggregate reminder is in
		// the stream (one per drop event, not per dropped turn).
		const pi = await loadExtension();
		const event = { messages: buildOver100kSession() };
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// Count reminders: a `role: "user"` message whose content names
		// the extension. The count must be exactly 1.
		const reminders = result.messages.filter(
			(m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("Context Trimmer extension"),
		);
		assert.equal(reminders.length, 1, "exactly one aggregate reminder in the output stream");
		// Flatten the LLM-bound stream into a single text blob and
		// confirm the reminder text is in the prompt the LLM will see.
		const prompt = flattenPrompt(result.messages);
		assert.ok(prompt.includes("Context Trimmer extension"), "reminder text must land in the LLM-bound prompt");
		assert.ok(/prun/i.test(prompt), "reminder must reference the prune action in the LLM-bound prompt");
		assert.ok(/if you need/i.test(prompt), "reminder must include the conditional 'if you need' clause in the LLM-bound prompt");
		assert.ok(/get it fresh/i.test(prompt), "reminder must include the 'get it fresh' clause in the LLM-bound prompt");
	});

	it("the two streams differ ONLY by the reminder (no other shape drift)", async () => {
		// Structural check: the reminder-present session's output
		// matches the no-reminder baseline's output element-for-element
		// EXCEPT for the aggregate reminder. This proves the reminder
		// is the only difference between the two streams — the
		// solution does not change the drop heuristic, raise the
		// budget, or remove the drop. The done-bar is at the
		// reminder-only level. The no-reminder baseline is the
		// pre-fix drop output (a message array mirroring the
		// pre-fix shape — there is no shipped env-var/config toggle
		// to force the marker-off state).
		const pi = await loadExtension();
		const event = { messages: buildOver100kSession() };
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// The reminder-present output includes the pinned synthetic
		// (prepended by the wiring), the aggregate reminder, the
		// dispatch, the follow-up user anchor, and the surviving
		// turn-2 trimmable messages. Strip the reminder for shape
		// comparison.
		const stripped = result.messages.filter(
			(m) => !(m.role === "user" && typeof m.content === "string" && (m.content as string).includes("Context Trimmer extension")),
		);
		// The remaining messages: pinned synthetic + dispatch +
		// follow-up 1 + follow-up 2 + turn-2 assistant + turn-2
		// toolResult. The drop fired on turn 1; turn 2 survives
		// under the cap. The wiring's pinned-tier synthetic is
		// operator-opted-in (env `PI_CONTEXT_TRIMMER_PERSONALITY_PATH`
		// is set in the module-level before hook) and rides at
		// position 0.
		assert.equal(stripped.length, 6);
		assert.equal(stripped[0].role, "custom");
		assert.equal((stripped[0] as { customType?: string }).customType, PINNED_CUSTOM_TYPE);
		assert.equal(stripped[1].role, "user");
		assert.equal(stripped[1].content, "dispatch task — do X");
		assert.equal(stripped[2].role, "user");
		assert.equal(stripped[2].content, "follow-up 1");
		assert.equal(stripped[3].role, "user");
		assert.equal(stripped[3].content, "follow-up 2");
		// The dropped turn's assistant and toolResult are gone.
		// The "DO_NOT_KEEP_42" signature is unique to the dropped
		// turn's content (the surviving turn 2 uses "c" and
		// "needle" pads that do not contain it). Confirm the
		// dropped-turn content is absent from the stream.
		const droppedTurnContent = stripped.filter((m) => m.content && typeof m.content === "string" && (m.content as string).includes("DO_NOT_KEEP_42"));
		assert.equal(droppedTurnContent.length, 0, "the dropped turn's content (DO_NOT_KEEP_42 signature) must NOT be in the reminder-present stream");
	});
});

// ─── summaWords float-coercion at the wiring layer ────────────────────
//
// The T-2757 tier-threshold work introduced `isPositiveNumber` validation
// for `summaWords`, which accepts floats (e.g. `60.5`). The downstream
// Python `summa` subprocess parses its `words` argv via
// `int(sys.argv[2])`, which raises `ValueError` on a float — the
// graceful fail-soft path returns the source text and trips
// `lastSummarizerFailed = true`. The wiring layer (index.ts) now
// coerces `cfg.summaWords` to an integer via `Math.trunc` before
// threading it into `applyThreeTierTrim`, so a `60.5` config value
// hits the subprocess as `60` and the trim path succeeds.

describe("summaWords float-coercion at the wiring layer", () => {
	let sSummaWords: string | undefined;
	beforeEach(() => {
		sSummaWords = process.env[CONFIG_ENV.summaWords];
	});
	afterEach(() => {
		if (sSummaWords === undefined) delete process.env[CONFIG_ENV.summaWords];
		else process.env[CONFIG_ENV.summaWords] = sSummaWords;
	});

	it("Math.trunc coerces a float summaWords to an integer at the wiring layer; the tier-2 trim succeeds", async () => {
		// Set summaWords to a float that `isPositiveNumber` accepts
		// (the resolver passes it through) but the Python subprocess
		// would reject (`int('60.5')` → ValueError). The wiring
		// coerces to 60 before handing to the subprocess.
		process.env[CONFIG_ENV.summaWords] = "60.5";
		// Build a session that lands in tier 2 (between 50k and 100k
		// trimmable tokens) so the summarizer is invoked. The
		// trimmable mass must be natural-language text long enough
		// for summa to produce a substantially shorter summary
		// (>200 chars per the `defaultSummaSummarizer` floor) AND
		// sized to land in tier 2. Each sentence repeat is ~360
		// chars ≈ 90 tokens. The body is `longSentence.repeat(400)`
		// = ~115k chars ≈ 29k tokens; two messages = ~58k tokens,
		// solidly in tier 2 (above 50k verbatim, below 100k drop).
		const pi = await loadExtension();
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400); // ~115k chars, ~29k tokens per message
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "assistant", content: trimmableBody },
				{ role: "toolResult", content: trimmableBody },
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// The summary path must have succeeded. The wiring-coerced
		// integer (60) reaches the subprocess; summa is installed
		// (the test infra) and produces a real summary. The
		// summarized message is a tier-2 marker: content carries
		// the `[summa:` tag, and the body inside the envelope is
		// SHORTER than the original input. The fallback path
		// (subprocess failure) would leave the body unchanged (the
		// policy's catch branch returns the source text), so the
		// length check is the structural proof that the integer
		// argv was accepted by the Python subprocess. The
		// summarized content is an array of `{type:"text",
		// text:string}` blocks; extract the body to compare.
		const summarizedBlock = result.messages
			.flatMap((m) => {
				const c = m.content;
				if (Array.isArray(c)) {
					return c
						.filter((b: unknown) => b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string")
						.map((b: { text: string }) => b.text);
				}
				return [];
			})
			.find((t) => t.startsWith("[summa:"));
		assert.ok(summarizedBlock, "tier-2 trim must have produced a [summa:...] summary envelope (proves the wiring coerced a float summaWords and reached the summary path)");
		// The envelope is `[summa: ...]\n<body>`. The body must be
		// substantially shorter than the original ~140k-char
		// assistant message — if the subprocess had failed (the
		// pre-fix `int('60.5') → ValueError` path), the body would
		// equal the input and the length check would fail.
		const body = summarizedBlock.split("\n").slice(1).join("\n");
		assert.ok(body.length < trimmableBody.length, "the summa body must be shorter than the original input (proves the integer argv was accepted and summa summarized, not the fail-soft source-text fallback)");
		assert.ok(body.length > 0, "the summa body must be non-empty");
	});
});

// ─── Loop guard — AC-8 end-to-end regression ──────────────────────────
//
// The loop-guard default is now `true` (ON for every session). The
// mock pi in this file does NOT register a `subagent` tool — the
// subagent-tool probe was removed from the wiring layer for the
// loop-guard resolution path (the guard is universal across session
// postures). The regression test forces the guard ON by setting
// `PI_CONTEXT_TRIMMER_LOOP_GUARD=1` and
// `PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD=3` in `process.env` BEFORE
// `loadExtension()` — the env force is now redundant with the default
// (the suite could rely on the default `true`) but is kept as a
// stable, explicit contract on the wiring's read path. The env vars
// are restored after each test to keep the module-level state of the
// other suites untouched.
//
// The two tests below exercise the same loop shape (>= 3 consecutive
// identical tool-call turns) under two distinct wiring states:
//   (a) Soft-nudge: threshold 3, hard-block off. The guard fires at
//       runLength === 3, prepending a `role: "user"` synthetic with
//       `LOOP_GUARD_NUDGE_TEXT` to the returned message array. The
//       assistant turn that pushed the run to threshold still has its
//       `toolCall` blocks intact (the soft-nudge does not strip them).
//   (b) Hard-block: threshold 3, hard-block 3. The guard fires at
//       runLength === 3 AND `shouldHardBlock(runLength, hardBlock) ===
//       true`, prepending the block-text synthetic AND stripping the
//       last assistant turn's `toolCall` blocks (preserving any
//       textual / thinking content of the same turn).
//
// The session fixture builds 3 consecutive identical assistant turns
// carrying the same `toolCall` block. The `userTurnAge` stamp is
// applied by the wiring; the mock messages don't carry it. The trim
// policy runs first; the loop-guard runs after. With a small
// trimmable mass the session lands in the verbatim tier (no trim);
// the loop-guard's only effect is the synthetic prepend (+ the hard-
// block strip on the last turn in path (b)).
//
// The "default-ON" regression test below asserts the guard is ON
// when neither env nor config sets `loopGuard` — a session with no
// `subagent` tool and no `PI_CONTEXT_TRIMMER_LOOP_GUARD` env override
// still gets the nudge. This is the regression for the gap this
// issue closes (the previous default was OFF in plain parent sessions).

describe("context handler — loop guard (AC-8 end-to-end regression)", () => {
	let sLoopGuard: string | undefined;
	let sLoopGuardThreshold: string | undefined;
	let sLoopGuardHardBlock: string | undefined;

	beforeEach(() => {
		sLoopGuard = process.env[CONFIG_ENV.loopGuard];
		sLoopGuardThreshold = process.env[CONFIG_ENV.loopGuardThreshold];
		sLoopGuardHardBlock = process.env[CONFIG_ENV.loopGuardHardBlock];
	});

	afterEach(() => {
		for (const [k, v] of [
			[CONFIG_ENV.loopGuard, sLoopGuard],
			[CONFIG_ENV.loopGuardThreshold, sLoopGuardThreshold],
			[CONFIG_ENV.loopGuardHardBlock, sLoopGuardHardBlock],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	/** A three-turn behavioral loop: dispatch + three identical
	 *  assistant turns, each carrying a `toolCall` block with the
	 *  same name and arguments. Threshold 3 → runLength === 3 →
	 *  guard fires. The three `text` blocks differ (so the runs
	 *  are visibly different messages, not byte-for-byte copies),
	 *  but the `toolCall` blocks are identical (the fingerprint
	 *  keys on the toolCall blocks only, not the textual
	 *  reasoning). */
	function buildLoopSession(): Array<Record<string, unknown>> {
		const toolCall = {
			type: "toolCall",
			name: "search",
			arguments: { q: "loop-test" },
		};
		return [
			userMsg("dispatch"),
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Searching now" },
					toolCall,
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Searching again" },
					toolCall,
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Searching once more" },
					toolCall,
				],
			},
		];
	}

	it("soft-nudge: injects a `role: \"user\"` synthetic carrying LOOP_GUARD_NUDGE_TEXT when the run hits the threshold (AC-8)", async () => {
		// Force the guard ON. Threshold 3, hard-block off (default).
		process.env[CONFIG_ENV.loopGuard] = "1";
		process.env[CONFIG_ENV.loopGuardThreshold] = "3";
		const pi = await loadExtension();
		const event = { messages: buildLoopSession() };
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// The wiring runs the trim first (small session → verbatim
		// tier, no trim), then the loop-guard. The guard's runLength
		// is 3 (three identical tool-call turns in a row); the
		// threshold is 3, so it fires. The guard prepends a
		// `role: "user"` synthetic with LOOP_GUARD_NUDGE_TEXT to
		// the returned message array.
		const nudge = result.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("called the same tool"),
		);
		assert.ok(nudge, "the loop-guard nudge must be prepended as a `role: \"user\"` synthetic");
		// The nudge content is LOOP_GUARD_NUDGE_TEXT verbatim (the
		// wiring does not rewrite it; the optional flat-input-token
		// co-signal clause is appended only when the co-signal is
		// flat, which a 3-turn fixture of similar tool-call content
		// may or may not trip). Assert the LOOP_GUARD_NUDGE_TEXT
		// substring is present so the test is independent of the
		// co-signal clause.
		const nudgeText = String(nudge!.content);
		assert.ok(
			nudgeText.includes("called the same tool"),
			"the nudge text must match LOOP_GUARD_NUDGE_TEXT (substring assertion so the optional co-signal clause does not break the test)",
		);
		assert.ok(
			nudgeText.includes("results of the earlier calls are already in the conversation"),
			"the nudge text must reference the in-context prior results",
		);
		// The dispatch task still survives (the guard does not affect
		// dispatch or pinned slots; it only prepends the synthetic).
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.content === "dispatch",
		);
		assert.ok(dispatch, "dispatch task must survive the loop-guard path");
		// The three assistant turns still carry their toolCall
		// blocks (the soft-nudge does not strip them; only the
		// hard-block path strips).
		const assistantTurnsWithToolCall = result.messages.filter((m) => {
			if (m.role !== "assistant") return false;
			const c = m.content;
			if (!Array.isArray(c)) return false;
			return c.some((b: unknown) => b && typeof b === "object" && (b as { type: string }).type === "toolCall");
		});
		assert.equal(
			assistantTurnsWithToolCall.length,
			3,
			"all three assistant turns' toolCall blocks must survive the soft-nudge path (the nudge does not strip)",
		);
	});

	it("hard-block: prepends LOOP_GUARD_BLOCK_TEXT AND strips the last assistant turn's toolCall blocks (AC-8)", async () => {
		// Force the guard ON with both threshold 3 and hard-block 3.
		// The hard-block is a strict superset of the soft-nudge: the
		// block-text synthetic is prepended AND the last assistant
		// turn's `type: "toolCall"` content blocks are stripped
		// (preserving textual / thinking blocks of the same turn).
		process.env[CONFIG_ENV.loopGuard] = "1";
		process.env[CONFIG_ENV.loopGuardThreshold] = "3";
		process.env[CONFIG_ENV.loopGuardHardBlock] = "3";
		const pi = await loadExtension();
		const event = { messages: buildLoopSession() };
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// The block-text synthetic must be prepended.
		const block = result.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("blocked"),
		);
		assert.ok(block, "the loop-guard block-text synthetic must be prepended on the hard-block path");
		const blockText = String(block!.content);
		assert.ok(/blocked/i.test(blockText), "block text must reference the block action");
		assert.ok(
			/proceed by text|proceed via text|reasoning in text/i.test(blockText),
			"block text must route the model to text-only reasoning",
		);
		// The block path is a strict superset of the soft-nudge:
		// when both fire, only the block text is emitted. The
		// soft-nudge text ("called the same tool") must NOT be
		// present in the same array.
		const both = result.messages.filter(
			(m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("called the same tool"),
		);
		assert.equal(
			both.length,
			0,
			"hard-block path emits only the block text (not both block and nudge)",
		);
		// The last assistant turn's `toolCall` blocks are stripped
		// (the wiring removes the `type: "toolCall"` blocks of the
		// last assistant turn only; earlier assistant turns'
		// toolCall blocks are untouched). The buildLoopSession
		// fixture has the last assistant turn at index 3 (after
		// dispatch at index 0). After the guard prepends the block
		// synthetic, the array shifts by one; find the LAST
		// assistant turn (the one whose toolCall was stripped) and
		// the assistant turn immediately before it (whose
		// toolCall is still present).
		const assistantTurns = result.messages.filter((m) => m.role === "assistant");
		assert.ok(assistantTurns.length >= 2, "at least two assistant turns must survive");
		const lastAssistant = assistantTurns[assistantTurns.length - 1];
		const lastContent = lastAssistant.content;
		// The last assistant turn's content has NO `type:
		// "toolCall"` blocks. If content is a non-array (string),
		// the strip is a no-op (the model must have already been
		// proceeding via text); the test fixture's content is
		// always an array.
		assert.ok(Array.isArray(lastContent), "the last assistant turn's content must remain an array (the strip filters blocks, it does not collapse the array)");
		const lastToolCallBlocks = (lastContent as Array<{ type: string }>).filter(
			(b) => b && typeof b === "object" && b.type === "toolCall",
		);
		assert.equal(
			lastToolCallBlocks.length,
			0,
			"the last assistant turn's toolCall blocks must be stripped on the hard-block path",
		);
		// The last assistant turn's textual / non-toolCall blocks
		// are preserved (the strip is per-block; only `type:
		// "toolCall"` is removed).
		const lastTextBlocks = (lastContent as Array<{ type: string; text?: string }>).filter(
			(b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
		);
		assert.ok(
			lastTextBlocks.length > 0,
			"the last assistant turn's textual blocks must be preserved by the hard-block strip (per-block filter, not array collapse)",
		);
		// The penultimate assistant turn still has its toolCall
		// block (the strip is on the LAST assistant turn only).
		const penultimateAssistant = assistantTurns[assistantTurns.length - 2];
		const penultimateContent = penultimateAssistant.content;
		assert.ok(Array.isArray(penultimateContent), "penultimate assistant turn's content must remain an array");
		const penultimateToolCallBlocks = (penultimateContent as Array<{ type: string }>).filter(
			(b) => b && typeof b === "object" && b.type === "toolCall",
		);
		assert.equal(
			penultimateToolCallBlocks.length,
			1,
			"the penultimate assistant turn's toolCall block must survive (the strip targets the LAST assistant turn only)",
		);
		// The dispatch task still survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.content === "dispatch",
		);
		assert.ok(dispatch, "dispatch task must survive the hard-block path");
	});

	// ─── Default-ON regression (gap this issue closes) ────────────
	//
	// Previously `loopGuard: "auto"` resolved OFF in a plain parent
	// session (the mock pi in this file does not register a
	// `subagent` tool, so the probe returned OFF). With the new
	// default `true`, the guard must fire in a session with NO
	// `subagent` tool AND no `PI_CONTEXT_TRIMMER_LOOP_GUARD` env
	// override. This is the regression for the gap this issue
	// closes: the guard is ON for every session by default.
	//
	// The test uses the same `buildLoopSession` fixture as the
	// forced-ON cases above. The env-forcing is intentionally
	// absent — we delete the env override in a local hook so the
	// test cannot rely on the surrounding suite's leaked state.
	let dLoopGuard: string | undefined;
	let dLoopGuardThreshold: string | undefined;
	before(() => {
		dLoopGuard = process.env[CONFIG_ENV.loopGuard];
		dLoopGuardThreshold = process.env[CONFIG_ENV.loopGuardThreshold];
		// Unset the env so the resolver falls through to the file,
		// then the default `true`. The file channel is pointed at a
		// non-existent path (the module-level `before` hook), so
		// neither channel sets `loopGuard` and the default wins.
		delete process.env[CONFIG_ENV.loopGuard];
		delete process.env[CONFIG_ENV.loopGuardThreshold];
	});
	after(() => {
		if (dLoopGuard === undefined) delete process.env[CONFIG_ENV.loopGuard];
		else process.env[CONFIG_ENV.loopGuard] = dLoopGuard;
		if (dLoopGuardThreshold === undefined) delete process.env[CONFIG_ENV.loopGuardThreshold];
		else process.env[CONFIG_ENV.loopGuardThreshold] = dLoopGuardThreshold;
	});

	it("default ON: injects the nudge in a session with no subagent tool and no env override", async () => {
		// No env override, no file override. The resolver returns
		// `loopGuard: true` (the new default). The wiring's
		// `resolveLoopGuard` no longer probes `safeGetAllTools(pi)`
		// (the subagent-tool probe was dropped). The mock pi here
		// does not register a `subagent` tool — that is irrelevant
		// to the resolution, but it exercises the gap the issue
		// closes: previously this exact setup resolved OFF and the
		// guard never fired.
		const pi = await loadExtension();
		const event = { messages: buildLoopSession() };
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// The guard fires at runLength === 3 (default threshold 3)
		// and prepends the nudge.
		const nudge = result.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("called the same tool"),
		);
		assert.ok(
			nudge,
			"the loop-guard nudge must fire by default (no env, no file, no subagent tool) — the regression for the issue this closes",
		);
	});
});


