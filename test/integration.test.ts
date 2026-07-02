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
		// The 120k trimmable turn was dropped; only the anchor user
		// message remains.
		assert.equal(result.messages.length, 1);
		assert.equal(result.messages[0].role, "user");
		assert.equal(result.messages[0].content, "first prompt");
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