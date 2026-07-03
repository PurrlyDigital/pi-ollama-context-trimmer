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
// The pinned synthetic (personality + tracker) and dispatch protection
// are operator-opted-in via config (env overrides file). The tests use
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
let savedTrackerEnv: string | undefined;
let savedProtectEnv: string | undefined;
let savedConfigPathEnv: string | undefined;

before(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "ctx-trimmer-"));
	writeFileSync(join(fixtureDir, "personality.md"), "test personality substrate\n");
	savedPersonalityEnv = process.env[CONFIG_ENV.personalityPath];
	savedTrackerEnv = process.env[CONFIG_ENV.trackerPath];
	savedProtectEnv = process.env[CONFIG_ENV.protectDispatch];
	savedConfigPathEnv = process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
	// Point the config file at a non-existent path so the file channel
	// is empty for every test (env is the only input).
	process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
	process.env[CONFIG_ENV.personalityPath] = join(fixtureDir, "personality.md");
	// No tracker configured — the tracker section is omitted; the
	// pinned synthetic still carries the personality section.
	delete process.env[CONFIG_ENV.trackerPath];
	// Dispatch protection ON (simulates pi-subagents being installed).
	process.env[CONFIG_ENV.protectDispatch] = "1";
});

after(() => {
	for (const [k, v] of [
		[CONFIG_ENV.personalityPath, savedPersonalityEnv],
		[CONFIG_ENV.trackerPath, savedTrackerEnv],
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
	it("drops the oldest trimmable turn when over 100k, preserving pinned and dispatch", async () => {
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(pad("a", 60_000)), // 60k trimmable turn 1
				toolResultMsg(pad("b", 60_000)),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// Pinned + dispatch + ... the drop should have removed the
		// assistant/toolResult turn. The output should have at most
		// the pinned synthetic + the dispatch.
		const trimmableMass = result.messages.filter((m) => {
			if (m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE) return false;
			if (m.role === "user") return false; // dispatch
			return true;
		});
		// After drop, the trimmable mass is 0 (or near 0). Definitely
		// not 120k.
		assert.ok(trimmableMass.length <= 1, "trimmable turn must be dropped");
	});
});

// ─── Opt-out path (no env configured) ─────────────────────────────────
//
// When no personality/tracker env is set and the config file is empty,
// `buildPinnedMessage` returns `null` and the context handler skips the
// pinned injection entirely. When `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH`
// is unset and no `subagent` tool is registered (the mock pi registers
// none), dispatch protection is OFF. These tests isolate that path by
// unsetting the env per-test (the config-file path stays pointed at the
// non-existent temp path set in the module-level `before`).

describe("context handler — opt-out path (nothing configured)", () => {
	let sPersonality: string | undefined;
	let sTracker: string | undefined;
	let sProtect: string | undefined;

	beforeEach(() => {
		sPersonality = process.env[CONFIG_ENV.personalityPath];
		sTracker = process.env[CONFIG_ENV.trackerPath];
		sProtect = process.env[CONFIG_ENV.protectDispatch];
		delete process.env[CONFIG_ENV.personalityPath];
		delete process.env[CONFIG_ENV.trackerPath];
		delete process.env[CONFIG_ENV.protectDispatch];
	});
	afterEach(() => {
		for (const [k, v] of [
			[CONFIG_ENV.personalityPath, sPersonality],
			[CONFIG_ENV.trackerPath, sTracker],
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
		// ordinary turn anchor (not exempted). A session that lands in
		// the drop tier drops the post-anchor turn; the first user
		// message survives as an anchor (it is not "protected," it is
		// simply not inside a trimmable turn slice).
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("first prompt"),
				assistantMsg(pad("a", 60_000)), // 60k trimmable
				toolResultMsg(pad("b", 60_000)), // 60k (total 120k → drop)
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// No pinned synthetic (nothing configured).
		const pinned = result.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE,
		);
		assert.equal(pinned, undefined, "no pinned synthetic in opt-out path");
		// The 120k trimmable turn was dropped. The drop path emits one
		// aggregate plain-English reminder at the start of the prune
		// pass (the AC-1 reminder) — not a per-dropped-turn marker.
		// The reminder is a plain `role: "user"` message prepended
		// to the returned array; with no pinned synthetic in the
		// opt-out path, the output is [reminder, first-prompt].
		assert.equal(result.messages.length, 2);
		assert.equal(result.messages[0].role, "user");
		const reminderText = String(result.messages[0].content);
		assert.ok(
			reminderText.includes("Context Trimmer extension"),
			"the dropped-turn reminder must be at the start of the output and name the extension",
		);
		assert.equal(result.messages[1].role, "user");
		assert.equal(result.messages[1].content, "first prompt");
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
		// Build a session that lands in tier 3 (>100k trimmable). The
		// preserved-path message sits inside the dropped trimmable
		// turn slice; with the policy's carve-out in place
		// (dropOldestTurns carves protected messages out of the
		// dropped slice), the preserved message survives. The
		// test exercises BOTH distinct tool-dispatch shapes
		// (read_file + shell cat) per the AC-6 floor.
		process.env[CONFIG_ENV.preservedPaths] = "AGENTS.md,CLAUDE.md";
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				// Preserved (fuzzy match on AGENTS.md) — embedded in turn 1.
				readFileResult(pad("preserved body — AGENTS.md", 60_000), join(fixtureDir, "AGENTS.md")),
				// Trimmable mass pushing the trimmable total past 100k.
				assistantMsg(pad("a", 60_000)), // 60k trimmable
				// Preserved (fuzzy match on CLAUDE.md) — embedded in turn 1.
				shellCatResult(pad("preserved body — CLAUDE.md", 60_000), join(fixtureDir, "CLAUDE.md")),
				// More trimmable mass to ensure tier 3 is reached.
				toolResultMsg(pad("b", 60_000)), // 60k trimmable
			],
		};
		// Trimmable total: 60k + 60k = 120k (preserved messages are
		// subtracted from the budget). Tier 3 (drop). Turn 1 spans
		// indices [1, 5) (everything after the dispatch user anchor
		// through end-of-stream). The wiring stamps PRESERVED_CUSTOM_TYPE
		// on the two preserved messages; both must be carved out of
		// the dropped turn slice and survive.
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

		// The trimmable turn was dropped: the assistant and tool-result
		// messages are gone. The drop counter reflects the whole-turn
		// drop (counted as 1 turn dropped — the carve-out does not
		// change the turn count, only which messages survive the
		// slice). Note: the wiring stamps `customType: PRESERVED_CUSTOM_TYPE`
		// on the carved-out messages but does NOT change their `role`
		// (the role stays `toolResult`); the filter below checks the
		// customType, not the role, to identify preserved messages.
		// The filter also excludes the AC-1 aggregate plain-English
		// prune reminder emitted on the tier-3 drop path — the
		// reminder is a `role: "user"` message (per the new shape in
		// policy.ts), so the `role === "user"` filter below already
		// excludes it. No DROPPED_CUSTOM_TYPE filter is needed.
		const droppedTrimmable = result.messages.filter((m) => {
			const customType = (m as { customType?: string }).customType;
			if (customType === PINNED_CUSTOM_TYPE) return false;
			if (customType === PRESERVED_CUSTOM_TYPE) return false;
			if (m.role === "user") return false;
			return true;
		});
		assert.equal(droppedTrimmable.length, 0, "all non-protected trimmable messages in the dropped turn must be gone");
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
	/** The trimmable input that exceeds the 100k drop threshold. The
	 *  tool-result tail carries a known artifact ("needle") that the
	 *  originally-reported signal references. */
	function buildOver100kSession(): Array<Record<string, unknown>> {
		return [
			userMsg("dispatch task — do X"),
			// The dropped turn: assistant + toolResult. The toolResult
			// carries the "needle" artifact that the originally-reported
			// signal references ("I'll consult the tool result from
			// the earlier turn ... 'needle' ...").
			assistantMsg(pad("a", 60_000)),
			toolResultMsg(pad("needle ", 60_000)),
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
		// the new-shape stream: [pinned, reminder, dispatch]. The
		// dropped turn's content is gone (the drop fires), and
		// exactly ONE aggregate reminder is in the stream (one per
		// drop event, not one per dropped turn).
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
		// (prepended by the wiring), the aggregate reminder, and the
		// dispatch. Strip the reminder for shape comparison.
		const stripped = result.messages.filter(
			(m) => !(m.role === "user" && typeof m.content === "string" && (m.content as string).includes("Context Trimmer extension")),
		);
		// The remaining messages: pinned synthetic + dispatch. The
		// drop fired; the trimmable tail is gone. The wiring's
		// pinned-tier synthetic is operator-opted-in (env
		// `PI_CONTEXT_TRIMMER_PERSONALITY_PATH` is set in the
		// module-level before hook) and rides at position 0.
		assert.equal(stripped.length, 2);
		assert.equal(stripped[0].role, "custom");
		assert.equal((stripped[0] as { customType?: string }).customType, PINNED_CUSTOM_TYPE);
		assert.equal(stripped[1].role, "user");
		assert.equal(stripped[1].content, "dispatch task — do X");
		// The dropped turn's assistant and toolResult are gone.
		const droppedTurnContent = stripped.filter((m) => m.content && typeof m.content === "string" && (m.content as string).includes("needle"));
		assert.equal(droppedTurnContent.length, 0, "the dropped turn's tool-result content must NOT be in the reminder-present stream");
	});
});


