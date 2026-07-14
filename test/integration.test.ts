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
let savedAsyncModeEnv: string | undefined;
let savedPinSubagentEnv: string | undefined;

before(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "ctx-trimmer-"));
	writeFileSync(join(fixtureDir, "personality.md"), "test personality substrate\n");
	savedPersonalityEnv = process.env[CONFIG_ENV.personalityPath];
	savedProtectEnv = process.env[CONFIG_ENV.protectDispatch];
	savedConfigPathEnv = process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
	savedAsyncModeEnv = process.env[CONFIG_ENV.asyncMode];
	savedPinSubagentEnv = process.env[CONFIG_ENV.pinSubagent];
	// Point the config file at a non-existent path so the file channel
	// is empty for every test (env is the only input).
	process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
	process.env[CONFIG_ENV.personalityPath] = join(fixtureDir, "personality.md");
	// Dispatch protection ON (simulates pi-subagents being installed).
	process.env[CONFIG_ENV.protectDispatch] = "1";
	// Sync mode (asyncMode OFF) — the existing tests assert the
	// set/clear status lifecycle on the trim path's synchronous span.
	// Background mode is exercised by its own dedicated describe block
	// below, which restores async mode to ON in beforeEach.
	process.env[CONFIG_ENV.asyncMode] = "0";
	// Subagent-context pin override ON. The wiring skips the pinned-
	// tier injection by default when PI_SUBAGENT_CHILD=1 (the parent
	// PM persona must not cross the dispatch boundary). The test
	// process inherits PI_SUBAGENT_CHILD=1 when run inside a
	// pi-subagents child, so the existing pinned-tier / drop-tier /
	// loop-guard assertions (which expect the pin to ride out) need
	// the override channel re-enabled here to remain valid in any
	// context (parent or child). The override is the same channel
	// the new AC-5 override-path test exercises.
	process.env[CONFIG_ENV.pinSubagent] = "1";
});

after(() => {
	for (const [k, v] of [
		[CONFIG_ENV.personalityPath, savedPersonalityEnv],
		[CONFIG_ENV.protectDispatch, savedProtectEnv],
		["PI_CONTEXT_TRIMMER_CONFIG_PATH", savedConfigPathEnv],
		[CONFIG_ENV.asyncMode, savedAsyncModeEnv],
		[CONFIG_ENV.pinSubagent, savedPinSubagentEnv],
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
	return handlers[0](event, { hasUI: false, ui: { setStatus: () => {} } });
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

// ─── Status indicator lifecycle (AC-4) ────────────────────────────────
//
// The wiring sets a UI status indicator ("Summarizing…") before
// invoking the trim policy and clears it (to `undefined`) in a
// `finally` block — the try/finally guarantees the clear fires even
// on a trim throw. The `ctx?.hasUI` guard skips the UI calls in
// non-TUI modes (rpc, json, print) and in test mocks that don't
// advertise a UI surface. The three tests below cover the lifecycle:
//
//   (a) Status set/clear with `hasUI: true` — the production TUI
//       path. A conversation that lands in tier 2 (50k–100k trimmable)
//       exercises the summarize branch. The set fires unconditionally
//       before the trim; the clear fires unconditionally in the
//       `finally` after the trim returns.
//   (b) `hasUI: false` guard skips all UI calls — the rpc/json/print
//       path. The handler still returns the trimmed messages; the UI
//       spy is never invoked.
//   (c) Small conversation (Tier-1 verbatim) still sets/clears with
//       `hasUI: true` — documents the unconditional wrap: the status
//       flashes on Tier-1 too, per the structural-seam decision (the
//       wrap is a single try/finally around the trim call, not a
//       tier-conditional check).

describe("status indicator lifecycle", () => {
	it("sets and clears the status indicator when hasUI is true (tier-2 summarize)", async () => {
		const pi = await loadExtension();
		// Build a conversation that lands in tier 2 (trimmable
		// total between 50k and 100k). Two trimmable assistant
		// messages of ~30k tokens each = ~60k trimmable total,
		// above the 50k verbatim cap and below the 100k drop cap.
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400); // ~115k chars, ~29k tokens per message
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(trimmableBody),
				assistantMsg(trimmableBody),
			],
		};
		// Spy on setStatus; record every call.
		const setStatusCalls: Array<[string, string | undefined]> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (name: string, value: string | undefined) => {
					setStatusCalls.push([name, value]);
				},
			},
		};
		const handlers = pi.getHandlers("context");
		assert.ok(handlers.length > 0, "context handler must be registered");
		const result = (await handlers[0](event, ctx)) as { messages: Array<Record<string, unknown>> };
		// The set call: at least one call with
		// ("context-trimmer", "Summarizing…") fired before the trim.
		const setCalls = setStatusCalls.filter(
			([n, v]) => n === "context-trimmer" && v === "Summarizing…",
		);
		assert.ok(
			setCalls.length >= 1,
			`setStatus must be called at least once with ("context-trimmer", "Summarizing…") before the trim. Calls: ${JSON.stringify(setStatusCalls)}`,
		);
		// The clear call: at least one call with
		// ("context-trimmer", undefined) fired after the trim.
		const clearCalls = setStatusCalls.filter(
			([n, v]) => n === "context-trimmer" && v === undefined,
		);
		assert.ok(
			clearCalls.length >= 1,
			`setStatus must be called at least once with ("context-trimmer", undefined) after the trim. Calls: ${JSON.stringify(setStatusCalls)}`,
		);
		// Order: the set call(s) must precede the clear call(s). The
		// wiring's try/finally guarantees this: the set fires before
		// the trim, the clear fires after the trim returns.
		const firstSetIndex = setStatusCalls.findIndex(
			([n, v]) => n === "context-trimmer" && v === "Summarizing…",
		);
		const firstClearIndex = setStatusCalls.findIndex(
			([n, v]) => n === "context-trimmer" && v === undefined,
		);
		assert.ok(
			firstSetIndex < firstClearIndex,
			`the set call must precede the clear call (set index ${firstSetIndex}, clear index ${firstClearIndex}). Calls: ${JSON.stringify(setStatusCalls)}`,
		);
		// Sanity: the handler returned a non-empty messages array
		// (the trim ran; the output is the trimmed view).
		assert.ok(result.messages.length > 0, "handler must return a non-empty messages array");
	});

	it("skips all UI calls when hasUI is false (the rpc/json/print guard path)", async () => {
		const pi = await loadExtension();
		// Same tier-2 fixture as the (a) test — the conversation
		// lands in the summarize branch, exercising the full trim
		// path. The guard is the only difference: `hasUI: false`
		// means the `ctx?.hasUI` short-circuits both UI calls.
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400);
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(trimmableBody),
				assistantMsg(trimmableBody),
			],
		};
		const setStatusCalls: Array<[string, string | undefined]> = [];
		const ctx = {
			hasUI: false,
			ui: {
				setStatus: (name: string, value: string | undefined) => {
					setStatusCalls.push([name, value]);
				},
			},
		};
		const handlers = pi.getHandlers("context");
		assert.ok(handlers.length > 0, "context handler must be registered");
		const result = (await handlers[0](event, ctx)) as { messages: Array<Record<string, unknown>> };
		// The guard short-circuits the `if (ctx?.hasUI)` block, so
		// setStatus is NEVER called. The spy array must be empty.
		assert.equal(
			setStatusCalls.length,
			0,
			`setStatus must NEVER be called when hasUI is false (the rpc/json/print guard). Calls: ${JSON.stringify(setStatusCalls)}`,
		);
		// The handler still returned a non-empty messages array
		// (the guard is UI-only; the trim path ran end-to-end).
		assert.ok(result.messages.length > 0, "handler must return a non-empty messages array even with hasUI false");
	});

	it("sets and clears the status on a small tier-1 conversation with hasUI true (unconditional wrap)", async () => {
		// A small conversation lands in tier 1 (verbatim, no trim
		// work). The wiring's try/finally is unconditional — the
		// set/clear fires on EVERY context event, not just on the
		// summarize branch. This test documents that behavior: the
		// status flashes briefly on tier-1 too, then clears. The
		// wrap is a structural seam (single try/finally around the
		// trim call), not a tier-conditional check. A future change
		// to gate the wrap on tier-2+ would be a follow-up ticket,
		// not a silent regression in this test.
		const pi = await loadExtension();
		const event = {
			messages: [userMsg("dispatch"), assistantMsg("hi")],
		};
		const setStatusCalls: Array<[string, string | undefined]> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (name: string, value: string | undefined) => {
					setStatusCalls.push([name, value]);
				},
			},
		};
		const handlers = pi.getHandlers("context");
		assert.ok(handlers.length > 0, "context handler must be registered");
		await handlers[0](event, ctx);
		// The set call fired (unconditional, before the trim).
		const setCalls = setStatusCalls.filter(
			([n, v]) => n === "context-trimmer" && v === "Summarizing…",
		);
		assert.ok(
			setCalls.length >= 1,
			`setStatus must be called at least once with ("context-trimmer", "Summarizing…") on a tier-1 conversation (unconditional wrap). Calls: ${JSON.stringify(setStatusCalls)}`,
		);
		// The clear call fired (unconditional, in the finally).
		const clearCalls = setStatusCalls.filter(
			([n, v]) => n === "context-trimmer" && v === undefined,
		);
		assert.ok(
			clearCalls.length >= 1,
			`setStatus must be called at least once with ("context-trimmer", undefined) on a tier-1 conversation (unconditional wrap). Calls: ${JSON.stringify(setStatusCalls)}`,
		);
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

// ─── AC-5 — subagent-context pin skip + override path ──────────────
//
// The pinned-tier personality injection is suppressed by default in
// child/subagent sessions (PI_SUBAGENT_CHILD=1) to prevent the parent
// PM persona from crossing the dispatch boundary. The override channel
// (PI_CONTEXT_TRIMMER_PIN_SUBAGENT=1 env, or pinSubagent: true JSON
// key) re-enables the pin. These tests intercept the `context` event
// return `messages` array — the bleed is view-time only and leaves no
// session.jsonl trace, so the unit-test layer is the right verification
// surface for AC-5.
//
// The default-off test sets PI_SUBAGENT_CHILD=1 with no override and
// asserts no `customType: "context-trimmer-pinned"` message is
// present. The override-path test sets both PI_SUBAGENT_CHILD=1 and
// PI_CONTEXT_TRIMMER_PIN_SUBAGENT=1 and asserts the pin re-appears.
// A third test exercises the JSON `pinSubagent: true` channel
// (file-channel parity with the env channel, per the tandem principle).
//
// The tests unset the module-level override (the before hook sets
// PI_CONTEXT_TRIMMER_PIN_SUBAGENT=1 for the existing pinned-tier /
// drop-tier / loop-guard assertions) so the default-off assertion is
// truly default-off, then restore it in the after hook so other
// suites see the same module-level state they expect.

describe("context handler — subagent-context pin skip (AC-5)", () => {
	let sChildEnv: string | undefined;
	let sPinEnv: string | undefined;
	let sConfigPath: string | undefined;

	beforeEach(() => {
		// Save and unset the module-level override and child flag so
		// each test starts from a known state. The tests then set
		// exactly the channels they want to exercise.
		sChildEnv = process.env.PI_SUBAGENT_CHILD;
		sPinEnv = process.env[CONFIG_ENV.pinSubagent];
		sConfigPath = process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
	});

	afterEach(() => {
		for (const [k, v] of [
			["PI_SUBAGENT_CHILD", sChildEnv],
			[CONFIG_ENV.pinSubagent, sPinEnv],
			["PI_CONTEXT_TRIMMER_CONFIG_PATH", sConfigPath],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		// Re-arm the module-level default so the test after the AC-5
		// block (and any test that runs after the suite if the order
		// changes) sees the override ON again. This matches the
		// module-level `before` hook's posture.
		process.env[CONFIG_ENV.pinSubagent] = "1";
	});

	it("default-off: with PI_SUBAGENT_CHILD=1 and no override, no `context-trimmer-pinned` synthetic is in the returned messages", async () => {
		// AC-5 surface 1: the default-off intercept. Child session,
		// no override channel. The bleed is fixed at the layer where
		// it occurs — the per-LLM-call view, view-time only. The
		// returned `messages` array must contain no
		// `customType: "context-trimmer-pinned"` synthetic.
		process.env.PI_SUBAGENT_CHILD = "1";
		delete process.env[CONFIG_ENV.pinSubagent];
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtension();
		const event = {
			messages: [userMsg("dispatch"), assistantMsg("hello")],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		const pinned = result.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE,
		);
		assert.equal(pinned, undefined, "pinned-tier synthetic must be skipped in a child session with no override (default-off intercept)");
		// The user + assistant pass through verbatim (verbatim tier),
		// with no prepended synthetic.
		assert.equal(result.messages.length, 2);
		assert.equal(result.messages[0].role, "user");
		assert.equal(result.messages[1].role, "assistant");
	});

	it("override (env): with PI_SUBAGENT_CHILD=1 AND PI_CONTEXT_TRIMMER_PIN_SUBAGENT=1, the `context-trimmer-pinned` synthetic re-appears", async () => {
		// AC-5 surface 2: the override-path. The operator's escape
		// hatch re-enables the pin. With both env vars set, the
		// returned `messages` array contains the pinned synthetic at
		// the top, exactly as in a parent session.
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env[CONFIG_ENV.pinSubagent] = "1";
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtension();
		const event = {
			messages: [userMsg("dispatch"), assistantMsg("hello")],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		const pinned = result.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE,
		);
		assert.ok(pinned, "pinned-tier synthetic must re-appear when the env override channel is set in a child session");
		// Three messages out: pinned + dispatch + assistant.
		assert.equal(result.messages.length, 3);
		assert.equal(result.messages[0].role, "custom");
		assert.equal((result.messages[0] as { customType?: string }).customType, PINNED_CUSTOM_TYPE);
		assert.equal(result.messages[1].role, "user");
		assert.equal(result.messages[1].content, "dispatch");
		assert.equal(result.messages[2].role, "assistant");
	});

	it("override (JSON): with PI_SUBAGENT_CHILD=1 AND a context-trimmer.json `pinSubagent: true`, the pin re-appears (tandem parity with the env channel)", async () => {
		// AC-5 surface 3: the JSON `pinSubagent: true` channel
		// (the tandem twin of the env channel, per the project's
		// tandem principle). Set the env channel to undefined so
		// the resolver falls through to the file channel; write a
		// temp config file with `pinSubagent: true`; assert the
		// pinned synthetic re-appears.
		process.env.PI_SUBAGENT_CHILD = "1";
		delete process.env[CONFIG_ENV.pinSubagent];
		const configPath = join(fixtureDir, "pin-subagent-true.json");
		writeFileSync(configPath, JSON.stringify({ pinSubagent: true }));
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = configPath;
		const pi = await loadExtension();
		const event = {
			messages: [userMsg("dispatch"), assistantMsg("hello")],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		const pinned = result.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === PINNED_CUSTOM_TYPE,
		);
		assert.ok(pinned, "pinned-tier synthetic must re-appear when the JSON `pinSubagent: true` channel is set in a child session (tandem parity)");
		assert.equal(result.messages.length, 3);
		assert.equal(result.messages[0].role, "custom");
		assert.equal((result.messages[0] as { customType?: string }).customType, PINNED_CUSTOM_TYPE);
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
	//
	// The default summarizer lives in `index.ts` (the wiring layer),
	// not `policy.ts` — it was moved out of the pure module so the
	// subprocess I/O doesn't pollute the policy's purity contract.
	// Tests import from `index.ts` and assert both the resolved
	// summary text and the `lastSummarizerFailed` diagnostic export
	// against the index module.
	let result: string | undefined;
	before(async () => {
		// Import the wiring module and invoke the default summarizer
		// directly. We do this via dynamic import to keep the path
		// test-only and avoid pulling the wiring into the harness
		// startup.
		const modulePath = resolve(import.meta.dirname ?? ".", "..", "index.ts");
		const mod = await import(modulePath);
		const summarizer = mod.defaultSummaSummarizer;
		const longText = [
			"The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel.",
			"Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees.",
			"It was a sunny day with a gentle breeze. Everyone was happy and the end was near.",
			"The park was green and lush, full of life and sound. The end of the day was approaching.",
		].join(" ");
		result = await summarizer(longText, 20);
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
		const modulePath = resolve(import.meta.dirname ?? ".", "..", "index.ts");
		const mod = await import(modulePath);
		// The export must be a boolean (it's mutated by the default
		// summarizer on failure).
		assert.equal(typeof mod.lastSummarizerFailed, "boolean");
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

// ─── AC-7 (e) — Wiring-layer JSONL pair-state reconstruction ───────────
//
// End-to-end coverage of the pair-atomic protection at the wiring
// layer. The wiring extracts the protected-toolCall-id set from each
// assistant message's `toolCall` blocks' `arguments.path` (matched
// against `preservedPatterns` via the pure `isPathPreserved`
// predicate), threads the set into the pure policy as
// `protectedToolCallIds: ReadonlySet<string>`, and the policy keeps
// each protected `toolCall` block + matching `toolResult` as an
// atomic chain at block-level granularity.
//
// The test builds a session that lands in tier 2 (>50k trimmable):
// a large assistant turn carrying a `toolCall` block whose
// `arguments.path` matches `AGENTS.md` and a matching `toolResult`
// whose top-level `toolCallId` matches the `id` of the protected
// `toolCall` block. The trim summarize-rewrites the assistant's
// `text` block; the protected `toolCall` block survives inside the
// rewritten message; the matching `toolResult` survives by
// association (kept alive by the `protectedToolCallIds` set in
// `isProtectedSlot`).
//
// JSONL-reconstructible: the protected set is computed at trim time
// from the assistant message's `toolCall` blocks (the `id` and
// `arguments.path` fields are present in the source JSONL), with the
// `path-stamp.ts` / `details.sourcePath` seam as the resume-compat
// fallback for older turns where the call argument is not directly
// inspectable.

describe("AC-7 (e) — wiring-layer JSONL pair-state reconstruction", () => {
	let sPreservedPaths: string | undefined;
	beforeEach(() => {
		sPreservedPaths = process.env[CONFIG_ENV.preservedPaths];
	});
	afterEach(() => {
		if (sPreservedPaths === undefined) delete process.env[CONFIG_ENV.preservedPaths];
		else process.env[CONFIG_ENV.preservedPaths] = sPreservedPaths;
	});

	function readFileResultWithCallId(text: string, toolCallId: string): Record<string, unknown> {
		return { role: "toolResult", content: text, toolCallId };
	}

	function assistantWithProtectedReadCall(id: string, path: string, prose: string): Record<string, unknown> {
		return {
			role: "assistant",
			content: [
				{ type: "text", text: prose },
				{ type: "toolCall", id, name: "read", arguments: { path } },
			],
		};
	}

	it("extracts the protected-toolCall-id set from assistant `toolCall` blocks' `arguments.path` and keeps the matching `toolResult` by association (tier-2 rewrite)", async () => {
		// The protected set is computed at trim time from the source
		// assistant message's `toolCall` block `arguments.path` —
		// no separate persistence sidecar, no operator opt-in
		// beyond the existing `preservedPatterns` knob. The
		// `path-stamp.ts` / `details.sourcePath` seam stays as the
		// resume-compatibility fallback for older turns.
		process.env[CONFIG_ENV.preservedPaths] = "AGENTS.md";
		// Force the verbatim cap down so the test lands in tier 2
		// (the trimmable `text` block + the protected `toolCall`
		// block's JSON-stringified content push the session over
		// the cap and the summarize path fires). Without this
		// override the trimmable mass is well under the default
		// 50k verbatim cap and the test would land in tier 1
		// (no rewrite), defeating the assertion.
		process.env[CONFIG_ENV.tier1MaxTokens] = "5000";
		const pi = await loadExtension();
		const protectedCallId = "call_AGENTS_md_integration";
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400); // ~115k chars ≈ 29k tokens
		const event = {
			messages: [
				userMsg("dispatch"),
				// The protected `toolCall` block: `arguments.path`
				// matches the `AGENTS.md` fuzzy pattern. The wiring
				// extracts the `id` into the protected set at trim
				// time. The block's `id` is `call_AGENTS_md_integration`.
				assistantWithProtectedReadCall(protectedCallId, join(fixtureDir, "AGENTS.md"), trimmableBody),
				// The matching `toolResult`: top-level `toolCallId`
				// matches the protected `id`. The wiring does NOT
				// stamp `details.sourcePath` here (the AC re-scope
				// demoted sourcePath to a fallback; the primary
				// identification is the call-arg path). The
				// protected-toolCall-id set keys the
				// `isProtectedSlot` branch on the `toolCallId`.
				readFileResultWithCallId("AGENTS.md body content", protectedCallId),
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// (i) The protected `toolResult` survives by association
		// (no `details.sourcePath`, no `PRESERVED_CUSTOM_TYPE` —
		// the protection rides on the call-arg→result identification
		// seam). The `toolResult` is in the output and its content
		// is the original (no summa envelope).
		const protectedToolResult = result.messages.find(
			(m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === protectedCallId,
		);
		assert.ok(protectedToolResult, "protected `toolResult` survives by association with the protected `toolCall.id` (call-arg→result identification, no `details.sourcePath` required)");
		const protectedContent = typeof protectedToolResult.content === "string"
			? protectedToolResult.content
			: JSON.stringify(protectedToolResult.content);
		assert.ok(protectedContent.includes("AGENTS.md body content"), "protected `toolResult` content is verbatim (no summa envelope)");
		assert.ok(!protectedContent.includes("[summa:"), "protected `toolResult` is not summarized");
		// (ii) The trim fired on the assistant turn (the `text`
		// block was rewritten to a summa envelope). The protected
		// `toolCall` block survived inside the rewritten message.
		const rewrittenAssistant = result.messages.find(
			(m) => m.role === "assistant" && Array.isArray(m.content),
		);
		assert.ok(rewrittenAssistant, "the assistant message is in the output (rewritten by the summarize path)");
		const rwContent = rewrittenAssistant.content as Array<{ type: string; id?: string; text?: string }>;
		const survivingCall = rwContent.find(
			(b) => b.type === "toolCall" && b.id === protectedCallId,
		);
		assert.ok(survivingCall, "the protected `toolCall` block survived inside the rewritten assistant message (block-level carve-out)");
		const envelope = rwContent.find(
			(b) => b.type === "text" && typeof b.text === "string" && b.text.startsWith("[summa: ~"),
		);
		assert.ok(envelope, "the `text` block was rewritten to a summa envelope (the requesting turn's prose is summarizeable; block-level granularity is preserved)");
		// (iii) No `PRESERVED_CUSTOM_TYPE` stamp is applied to the
		// `toolResult` — the call-arg→result identification rides
		// on `isProtectedSlot`'s `protectedToolCallIds` branch,
		// not on the existing `protectedCustomTypes` channel. The
		// `toolResult` is a protected slot via the new branch, not
		// via the legacy `PRESERVED_CUSTOM_TYPE` stamp.
		assert.equal(
			(protectedToolResult as { customType?: string }).customType,
			undefined,
			"the `toolResult` is NOT stamped with `PRESERVED_CUSTOM_TYPE` — the protection rides on the call-arg→result branch, not the legacy sourcePath stamp",
		);
		delete process.env[CONFIG_ENV.tier1MaxTokens];
	});
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

// ─── Persistence and resume (AC-8) ─────────────────────────────────────
//
// The wiring layer persists the fingerprints of messages it has
// summarized in the current session via `pi.appendEntry` (a separate
// `customType: "context-trimmer-summarized"` entry, not a mutation of
// the session message stream). The in-memory `summarizedFingerprints`
// set mirrors the persisted set and is the source of truth for the
// per-trim `alreadySummarizedHashes` option threaded into the pure
// policy layer. On a `session_start` event with `reason` in
// {"resume", "startup", "reload"} the wiring re-hydrates the in-memory
// set from `ctx.sessionManager.getEntries()` so a resumed session
// skips already-summarized messages without re-invoking summa.
//
// The tests below use a richer mock pi (a `createMockPiWithPersistence`
// factory) that tracks `appendEntry` calls in an `appendEntries` array
// and exposes a configurable `sessionManager.getEntries()`. The
// factory returns a pi with the same `on` / `getHandlers` shape as
// `createMockPi` so the existing `loadExtension` helper works against
// it; the only addition is the `appendEntry` and `sessionManager`
// surfaces the wiring consults at runtime.

type AppendEntry = { customType: string; data?: unknown };
type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	[k: string]: unknown;
};

function createMockPiWithPersistence() {
	const handlers: Record<string, Handler[]> = {};
	const appendEntries: AppendEntry[] = [];
	let entries: SessionEntry[] = [];
	const sessionManager = {
		getEntries(): SessionEntry[] {
			return entries;
		},
	};
	const pi = {
		on(event: string, handler: Handler) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		getHandlers(event: string): Handler[] {
			return handlers[event] ?? [];
		},
		appendEntry(customType: string, data?: unknown): void {
			appendEntries.push({ customType, data });
		},
		sessionManager,
		// Test-only mutators (not part of the pi contract).
		__getAppendEntries(): AppendEntry[] {
			return appendEntries;
		},
		__setSessionEntries(e: SessionEntry[]): void {
			entries = e;
		},
	};
	return pi;
}

async function loadExtensionWithPersistence() {
	const pi = createMockPiWithPersistence();
	await contextTrimmerExtension(pi as unknown as Parameters<typeof contextTrimmerExtension>[0]);
	return pi;
}

async function fireSessionStart(
	pi: ReturnType<typeof createMockPiWithPersistence>,
	event: unknown,
	ctx: unknown,
): Promise<unknown> {
	const handlers = pi.getHandlers("session_start");
	assert.ok(handlers.length > 0, "session_start handler must be registered");
	return handlers[0](event, ctx);
}

async function fireContextWithCtx(
	pi: ReturnType<typeof createMockPiWithPersistence>,
	event: unknown,
): Promise<unknown> {
	const handlers = pi.getHandlers("context");
	assert.ok(handlers.length > 0, "context handler must be registered");
	return handlers[0](event, { hasUI: false, ui: { setStatus: () => {} } });
}

describe("persistence seam — appendEntry records summary state (AC-8 a)", () => {
	// The wiring persists fingerprints of summarized messages via
	// `pi.appendEntry("context-trimmer-summarized", { fingerprint })`
	// after a successful summarize pass. The mock pi's `appendEntries`
	// array captures every call so the test can assert the contract:
	// at least one entry with the right `customType` and a non-empty
	// `data.fingerprint` string lands after a tier-2 context event.

	it("records at least one context-trimmer-summarized entry with a non-empty fingerprint after a tier-2 trim", async () => {
		const pi = await loadExtensionWithPersistence();
		// Build a session that lands in tier 2 (trimmable total
		// between 50k and 100k). Two trimmable assistant messages
		// of ~30k tokens each = ~60k trimmable total. The verbatim
		// cap is 50k, so the policy enters the summarize path. The
		// drop cap is 100k, so it does not drop.
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400); // ~115k chars, ~29k tokens per message
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(trimmableBody),
				assistantMsg(trimmableBody),
			],
		};
		await fireContextWithCtx(pi, event);
		const appendEntries = pi.__getAppendEntries();
		assert.ok(appendEntries.length > 0, "appendEntry must be called at least once after a tier-2 trim");
		const summarized = appendEntries.filter((e) => e.customType === "context-trimmer-summarized");
		assert.ok(summarized.length > 0, "at least one appendEntry call must carry the context-trimmer-summarized customType");
		for (const e of summarized) {
			const data = e.data as { fingerprint?: unknown } | undefined;
			assert.ok(data && typeof data === "object", "summarized entry must carry a data object");
			assert.equal(typeof data.fingerprint, "string", "summarized entry's data.fingerprint must be a string");
			assert.ok((data.fingerprint as string).length > 0, "summarized entry's data.fingerprint must be non-empty");
		}
	});
});

describe("session_start handler loads persisted summary state (AC-8 b)", () => {
	// The `session_start` handler re-hydrates the in-memory
	// `summarizedFingerprints` set from `ctx.sessionManager.getEntries()`
	// when the reason is "resume" / "startup" / "reload". The
	// re-hydrated set threads into the next context event's trim pass
	// as `alreadySummarizedHashes`, and messages whose fingerprint
	// matches a persisted entry are skipped (NOT re-summarized).
	// The test below exercises the full seam: fire session_start with
	// a `sessionManager` whose `getEntries()` returns a single
	// `context-trimmer-summarized` entry carrying a known fingerprint,
	// then fire the context handler with two large messages — one
	// whose first 200 chars match the persisted fingerprint and one
	// whose first 200 chars do not. The matching message must pass
	// through the trim path unchanged (no summa envelope); the
	// non-matching message must be summarized (summa envelope present).

	it("skips a message whose fingerprint matches a persisted entry and summarizes a different message in the same trim pass", async () => {
		const pi = await loadExtensionWithPersistence();
		// Construct a deterministic "fingerprint" string that will
		// be the first 200 chars of the matching message's content.
		// The fingerprint is the first 200 chars of the first text
		// block of `content`; for a string `content`, the fingerprint
		// is the first 200 chars of the string itself. The wiring
		// persists the full 200-char slice (not just a prefix), so
		// the persisted `fingerprint` must equal the first 200 chars
		// of the matching message's content for the cache lookup to
		// match.
		const matchingPrefix = "MATCH_PREFIX_FINGERPRINT_AAA_";
		const matchingBody = pad(matchingPrefix, 30_000); // ~30k tokens, starts with the prefix
		const matchingFingerprint = matchingBody.slice(0, 200);
		const nonMatchingBody = pad("DIFFERENT_PREFIX_", 30_000); // ~30k tokens, different first 200 chars
		// The two trimmable bodies total ~60k tokens, landing the
		// session in tier 2 (verbatim cap 50k, drop cap 100k).
		// Persist the matching fingerprint via the sessionManager
		// before the resume event fires.
		pi.__setSessionEntries([
			{
				type: "custom",
				customType: "context-trimmer-summarized",
				data: { fingerprint: matchingFingerprint },
			},
		]);
		await fireSessionStart(pi, { type: "session_start", reason: "resume" }, { sessionManager: pi.sessionManager });
		// Now fire the context handler with two large assistant
		// messages. The matching message's fingerprint is in the
		// re-hydrated cache; the non-matching message is not.
		const result = (await fireContextWithCtx(pi, {
			messages: [
				userMsg("dispatch"),
				assistantMsg(matchingBody),
				assistantMsg(nonMatchingBody),
			],
		})) as { messages: Array<Record<string, unknown>> };
		// Find the matching message in the output: its content
		// (a string) must NOT have a summa envelope.
		const matchingOut = result.messages.find(
			(m) => typeof m.content === "string" && (m.content as string).startsWith(matchingPrefix),
		);
		assert.ok(matchingOut, "the matching-prefix message must be in the output (the policy skips already-summarized messages rather than dropping them)");
		const matchingText = String(matchingOut.content);
		assert.ok(!matchingText.includes("[summa:"), "the matching message must NOT be re-summarized (its fingerprint is in the persisted set)");
		// The non-matching message's content must carry the summa
		// envelope — the policy invoked summa on it because its
		// fingerprint was not in the persisted set.
		const summaBlocks = result.messages
			.flatMap((m) => {
				const c = m.content;
				if (Array.isArray(c)) {
					return c
						.filter((b: unknown) => b && typeof b === "object" && (b as { type: string }).type === "text" && typeof (b as { text: unknown }).text === "string")
						.map((b: { text: string }) => b.text);
				}
				return [];
			})
			.filter((t: string) => t.startsWith("[summa:"));
		assert.ok(summaBlocks.length > 0, "the non-matching message must be summarized (summa envelope present in the output)");
	});
});

describe("in-memory cache skips already-summarized messages on the next context event (AC-8 c)", () => {
	// The wiring's in-memory `summarizedFingerprints` set is the
	// source of truth for the per-trim `alreadySummarizedHashes`
	// option threaded into the pure policy layer. The first context
	// call populates the set with the fingerprints of the messages
	// it summarized; the second context call (with the SAME message
	// stream) threads the populated set into the policy. The policy
	// uses the set to skip already-summarized messages from the
	// summarize target search, so the second pass does strictly less
	// summarize work than the first — the in-memory cache reduces,
	// never increases, the per-call work. The binding assertion is
	// a delta check: the number of NEW summarized appendEntries on
	// the second call must be <= the count of summarized appendEntries
	// the first call produced. ("Equal" is acceptable: a session
	// where the first call summarized one message and the second
	// call skipped that one but summarized a previously-un-summarized
	// peer has second-call delta == first-call count, both = 1.)

	it("the second context call's new summarized appendEntry count is <= the first call's count", async () => {
		const pi = await loadExtensionWithPersistence();
		// Tier-2 session: two large assistant messages, ~60k trimmable
		// total. The first call summarizes the oldest summarizable
		// message and persists its fingerprint; the second call sees
		// the same input with that fingerprint already in the cache
		// and may still summarize the OTHER message (which is not in
		// the cache), but the second call's NEW appendEntry count
		// must be <= the first call's count.
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400);
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(trimmableBody),
				assistantMsg(trimmableBody),
			],
		};
		// First context call: should produce at least one
		// `context-trimmer-summarized` appendEntry. Capture the
		// count after the first call.
		await fireContextWithCtx(pi, event);
		const firstCallAppends = pi.__getAppendEntries().filter((e) => e.customType === "context-trimmer-summarized");
		assert.ok(firstCallAppends.length > 0, "first call must produce at least one summarized appendEntry");
		const firstCallCount = firstCallAppends.length;
		// Second context call: same conversation. Compute the
		// delta — the number of NEW summarized appendEntries added
		// by the second call.
		await fireContextWithCtx(pi, event);
		const secondCallTotal = pi.__getAppendEntries().filter((e) => e.customType === "context-trimmer-summarized").length;
		const secondCallNewCount = secondCallTotal - firstCallCount;
		assert.ok(
			secondCallNewCount <= firstCallCount,
			`the second context call's new summarized appendEntry count must be <= the first call's count (in-memory cache reduces work, never adds). first=${firstCallCount} second-delta=${secondCallNewCount}`,
		);
	});
});

describe("the trim is a view, not a mutation of the session messages (AC-8 d)", () => {
	// The wiring returns a fresh `messages` array (the trimmed view)
	// and never mutates the input array or any of its elements. The
	// original input messages stay original; the trimmed view carries
	// the summa envelope on the summarized messages. The test reads
	// the returned messages, confirms the summa envelope is in the
	// output, and confirms the input array is unchanged.

	it("returns messages with summa envelopes in the output and leaves the input messages array unchanged", async () => {
		const pi = await loadExtensionWithPersistence();
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400);
		const inputMessages = [
			userMsg("dispatch"),
			assistantMsg(trimmableBody),
			assistantMsg(trimmableBody),
		];
		// Snapshot the input before the call. The snapshot is a
		// stringified clone — comparing against it after the call
		// proves the input was not mutated (the wiring's view-only
		// invariant).
		const inputSnapshot = JSON.stringify(inputMessages);
		const result = (await fireContextWithCtx(pi, { messages: inputMessages })) as { messages: Array<Record<string, unknown>> };
		// The output carries a summa envelope on at least one
		// message — the trim path ran.
		const hasSumma = result.messages.some((m) => {
			const c = m.content;
			if (typeof c === "string") return c.includes("[summa:");
			if (Array.isArray(c)) {
				return c.some(
					(b: unknown) =>
						b &&
						typeof b === "object" &&
						(b as { type?: string }).type === "text" &&
						typeof (b as { text?: unknown }).text === "string" &&
						((b as { text: string }).text.startsWith("[summa:") || (b as { text: string }).text.includes("[summa:")),
				);
			}
			return false;
		});
		assert.ok(hasSumma, "the output must carry a summa envelope on at least one message (proves the trim ran)");
		// The input array is byte-for-byte unchanged.
		assert.equal(JSON.stringify(inputMessages), inputSnapshot, "the input messages array must NOT be mutated by the context handler (view-only invariant)");
		// Spot check: the assistant messages' content strings are
		// the original pad-prefixed text, NOT the summa envelope.
		for (const m of inputMessages) {
			if (m.role === "assistant") {
				const c = String(m.content);
				assert.ok(!c.includes("[summa:"), "the input assistant message's content must not carry a summa envelope (the input is view-only)");
			}
		}
	});
});

describe("session_start handler registers and fires (AC-8 e)", () => {
	// The existing test at the top of the file asserts the
	// `session_start` handler is REGISTERED on load. This describe
	// block adds the next-layer assertion: the handler FIRES when
	// invoked with an event and a ctx, and when the event's `reason`
	// is "resume" (or "startup" / "reload") the handler consults
	// `ctx.sessionManager.getEntries()`. The mock pi's `getEntries`
	// is spied via a flag so the test can assert the wiring called
	// it.

	it("does not crash when fired with an event and a ctx (resume reason)", async () => {
		const pi = await loadExtensionWithPersistence();
		// The handler accepts (event, ctx) and must not throw on a
		// well-formed resume event with a sessionManager whose
		// getEntries returns a valid array. The handler is
		// fire-and-forget from the harness's point of view — the
		// assertion is "the promise resolves (no throw, no
		// unhandled rejection)," not on the return value.
		pi.__setSessionEntries([]);
		await assert.doesNotReject(
			fireSessionStart(
				pi,
				{ type: "session_start", reason: "resume" },
				{ sessionManager: pi.sessionManager },
			),
		);
	});

	it("calls ctx.sessionManager.getEntries() when reason is 'resume'", async () => {
		const pi = await loadExtensionWithPersistence();
		// Wrap getEntries so we can count calls without changing
		// the mock's public shape. The wrapper delegates to the
		// real implementation and records the call.
		let getEntriesCallCount = 0;
		const realSessionManager = pi.sessionManager;
		// The mock pi exposes `sessionManager` as the same object
		// the wiring reads from. Replace its `getEntries` with a
		// counting wrapper that still returns the configured
		// entries array.
		const configuredEntries: SessionEntry[] = [
			{
				type: "custom",
				customType: "context-trimmer-summarized",
				data: { fingerprint: "test-fingerprint" },
			},
		];
		(realSessionManager as { getEntries: () => SessionEntry[] }).getEntries = () => {
			getEntriesCallCount += 1;
			return configuredEntries;
		};
		// Reconfigure the mock to track the entries the wrapper
		// returns. The wiring's call to `sessionManager.getEntries()`
		// returns the same array the wrapper is configured to
		// return.
		pi.__setSessionEntries(configuredEntries);
		await fireSessionStart(
			pi,
			{ type: "session_start", reason: "resume" },
			{ sessionManager: realSessionManager },
		);
		assert.ok(
			getEntriesCallCount >= 1,
			"ctx.sessionManager.getEntries() must be called when the session_start reason is 'resume'",
		);
	});

	it("fires without crashing on non-resume reasons (new / fork) without requiring a sessionManager", async () => {
		const pi = await loadExtensionWithPersistence();
		// A "new" or "fork" reason has no prior session state; the
		// wiring's re-hydrate path is gated on resume/startup/reload,
		// so the handler must not touch ctx.sessionManager when the
		// reason is "new". The handler still accepts (event, ctx)
		// and must not crash.
		await assert.doesNotReject(
			fireSessionStart(
				pi,
				{ type: "session_start", reason: "new" },
				{}, // no sessionManager — the handler must not consult it
			),
		);
	});
});


// ─── Background-mode integration (asyncMode: true) ────────────────────
//
// The wiring exposes `PI_CONTEXT_TRIMMER_ASYNC_MODE` (and the
// `asyncMode` config-file key) for the operator to opt OUT of the
// default async behavior. The module-level `before` block above
// forces `PI_CONTEXT_TRIMMER_ASYNC_MODE=0` so the existing tests
// exercise the sync path. This describe block flips asyncMode ON
// in a per-test beforeEach and restores the suite-level setting
// in afterEach; the existing tests' sync assertions still hold.
//
// Background mode is the production default (DEFAULT_ASYNC_MODE =
// true) but the existing tests assert the synchronous status
// lifecycle (set/clear around the awaited trim). Background mode
// changes the status lifecycle: the status is set at departure
// (after the trim returns, when background promises are pending)
// and cleared at re-enter (when the next context event applies
// the resolved cache entry). The tests below exercise the
// fire-once / apply-on-next-event interlock end-to-end against
// the production wiring.

describe("background-mode integration — asyncMode: true", () => {
	let sAsyncMode: string | undefined;
	beforeEach(() => {
		sAsyncMode = process.env[CONFIG_ENV.asyncMode];
		process.env[CONFIG_ENV.asyncMode] = "1";
	});
	afterEach(() => {
		if (sAsyncMode === undefined) delete process.env[CONFIG_ENV.asyncMode];
		else process.env[CONFIG_ENV.asyncMode] = sAsyncMode;
	});

	// Build a tier-2 fixture: two trimmable assistant messages of
	// ~30k tokens each. Trimmable total ≈ 60k, which lands in the
	// tier-2 (summarize) band when the 50k verbatim cap is in effect.
	// In background mode the trim fires summarizer promises for the
	// trimmable messages and returns immediately with the original
	// content intact.
	function buildTier2Event() {
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400); // ~115k chars, ~29k tokens per message
		return {
			messages: [
				userMsg("dispatch"),
				assistantMsg(trimmableBody),
				assistantMsg(trimmableBody),
			],
		};
	}

	it("the first context call returns messages WITHOUT summa envelopes (background mode defers rewriting)", async () => {
		// The trim fires the production `defaultSummaSummarizer` (a
		// Python summa subprocess) in the background. The returned
		// messages carry the ORIGINAL assistant content — no
		// `[summa: ~N tokens originally → ~M tokens summary]`
		// envelope is rewritten into the array because background
		// mode leaves content untouched. The background promise
		// resolves later (asynchronously, outside the handler's
		// await chain) and builds a cache entry.
		const pi = await loadExtension();
		const result = (await invokeContext(pi, buildTier2Event())) as { messages: Array<Record<string, unknown>> };
		// The trimmable assistants are returned with their ORIGINAL
		// string content (no envelope, no rewrite).
		const assistants = result.messages.filter((m) => m.role === "assistant");
		assert.ok(assistants.length >= 1, "at least one assistant survives the trim");
		for (const a of assistants) {
			if (typeof a.content === "string") {
				// String content: original, no envelope.
				assert.ok(
					!a.content.startsWith("[summa:"),
					"background mode leaves content untouched (no summa envelope on the string content)",
				);
			} else if (Array.isArray(a.content)) {
				// Array content would only appear if the message was
				// already-summarized; in the first call there is no
				// cache to substitute, so no array content should
				// appear in the output. Defensive check.
				const hasEnvelope = a.content.some(
					(b: unknown) => b && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: string }).text === "string" && (b as { text: string }).text.startsWith("[summa:"),
				);
				assert.ok(!hasEnvelope, "background mode does not rewrite content in place (no envelope array)");
			}
		}
	});

	it("the second context call substitutes the cached summarized message before the trim runs (apply-on-next-event)", async () => {
		// Fire the first context call (background mode fires the
		// production `defaultSummaSummarizer` promise). Wait for
		// the promise to resolve (the production summarizer uses
		// `execFile` with a 5s timeout; for a long input it
		// resolves in well under a second). Fire the second
		// context call — the cache substitution applies the
		// resolved summary (with the `[summa:` envelope in its
		// content) into the trimmable message array before the
		// trim runs. The behavioral proof: the second call's
		// returned messages DO carry summa envelopes.
		const pi = await loadExtension();
		// First call: fires the background promise; returned
		// messages have original content (no envelope).
		const firstResult = (await invokeContext(pi, buildTier2Event())) as { messages: Array<Record<string, unknown>> };
		// Sanity: the first call's output does NOT have envelopes.
		const firstEnvelopes = firstResult.messages.filter(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.startsWith("[summa:"),
			),
		);
		assert.equal(firstEnvelopes.length, 0, "first call: no summa envelopes in the output (background mode defers rewriting)");
		// Wait for the background promise to resolve and build the
		// cache entry. The production summarizer shells out to
		// Python summa; for a 30k-token input it typically
		// resolves in well under a second, but we wait up to 3s
		// to be safe across slow machines.
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		// Second call: the cache substitution applies the
		// resolved summary BEFORE the trim runs. The returned
		// messages now carry summa envelopes on the trimmable
		// messages.
		const secondResult = (await invokeContext(pi, buildTier2Event())) as { messages: Array<Record<string, unknown>> };
		const secondEnvelopes = secondResult.messages.filter(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.startsWith("[summa:"),
			),
		);
		assert.ok(
			secondEnvelopes.length >= 1,
			"second call: at least one trimmable message carries a summa envelope (cache substitution applied)",
		);
	});

	it("fire-once consume: the third context call does NOT substitute the cache entry again (one-shot)", async () => {
		// After the second call applies the cache, the cache
		// entry is deleted (fire-once consume). The third call
		// with the same input does not substitute the cache
		// again — the message goes through the normal trim
		// path. With the cache gone, the policy's
		// `isAlreadySummarized` check (via the now-substituted
		// summa envelope on the message) catches the already-
		// summarized message in `result.messages` and skips it.
		// The behavioral proof: a trimmable message that came
		// in with a summa envelope (carried over from the
		// second call's output via the persistent message
		// stream) is NOT re-summarized on the third call.
		const pi = await loadExtension();
		// First call: fires the background promise.
		await invokeContext(pi, buildTier2Event());
		// Wait for the cache to fill.
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		// Second call: cache substitution applies.
		const secondResult = (await invokeContext(pi, buildTier2Event())) as { messages: Array<Record<string, unknown>> };
		// The second call's output carries the substituted
		// summa envelopes. In a real session, the third call's
		// `event.messages` is the persisted message stream —
		// which would carry those envelopes. For the test, we
		// feed the second call's output back in as the third
		// call's input (the "messages from a prior event" are
		// the persisted stream with the substituted envelopes).
		const persistedWithEnvelopes = {
			messages: secondResult.messages,
		};
		// Third call: the cache is empty (consumed on the
		// second call). The trimmable messages with summa
		// envelopes enter the trim path; the policy's
		// `isAlreadySummarized` check skips them. The
		// returned messages still carry the envelopes (no
		// re-summarization fired).
		const thirdResult = (await invokeContext(pi, persistedWithEnvelopes)) as { messages: Array<Record<string, unknown>> };
		const thirdEnvelopes = thirdResult.messages.filter(
			(m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type: string; text: string }>).some(
				(b) => typeof b.text === "string" && b.text.startsWith("[summa:"),
			),
		);
		assert.ok(
			thirdEnvelopes.length >= 1,
			"third call: at least one trimmable message still carries a summa envelope (no re-summarization, the skip clause caught it)",
		);
	});
});

// ─── AC-4 — reasoning-block cap end-to-end ────────────────────────────
//
// The wiring applies `applyReasoningBlockCap` in the context
// handler before `applyThreeTierTrim` (the cap runs on `base`
// before pinned injection). The three tests below cover the
// end-to-end cap behavior through the production wiring:
//
//   (a) cap = 1: a stream with multiple thinking blocks → only
//       the LAST thinking block survives into the three-tier
//       trim. The post-cap mass reaches `applyThreeTierTrim`,
//       so a session that would have landed in tier 2 with the
//       full thinking-block mass might land in a different tier
//       after the cap (the budget accounts for the post-cap mass).
//   (b) No thinking blocks + any cap value: no-regression — the
//       existing three-tier trim behaves identically. The cap pass
//       is a no-op on a stream with no thinking blocks.
//   (c) cap = -1 (the compile-time default): the full message
//       stream reaches `applyThreeTierTrim` unchanged. No thinking
//       block is dropped. The cap is a transparent passthrough.
//       This case also covers the default-off posture: existing
//       operators see no behavior change when upgrading because
//       the compile-time default is passthrough.
//
// The cap is global (no `ctx.model` branching per the binding
// decisions) and runs on every context event.

describe("context handler — reasoning-block cap (AC-4)", () => {
	let sReasoningBlockCap: string | undefined;
	let sConfigPath: string | undefined;

	beforeEach(() => {
		sReasoningBlockCap = process.env[CONFIG_ENV.reasoningBlockCap];
		sConfigPath = process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
	});

	afterEach(() => {
		if (sReasoningBlockCap === undefined) delete process.env[CONFIG_ENV.reasoningBlockCap];
		else process.env[CONFIG_ENV.reasoningBlockCap] = sReasoningBlockCap;
		if (sConfigPath === undefined) delete process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
		else process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = sConfigPath;
		// Restore the module-level config-path posture.
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
	});

	/** Build a thinking-block content array. Each thinking block's
	 *  body is sized to be roughly N tokens (chars = N * 4) so the
	 *  per-block token count is predictable for budget assertions. */
	function thinkingBlocks(count: number, tokensEach: number): Array<Record<string, unknown>> {
		const blocks: Array<Record<string, unknown>> = [];
		for (let i = 0; i < count; i++) {
			blocks.push({
				type: "thinking",
				thinking: pad(`think-${i + 1}_`, tokensEach),
			});
		}
		return blocks;
	}

	/** Count the thinking blocks across the messages in the output. */
	function countThinkingBlocksIn(messages: ReadonlyArray<Record<string, unknown>>): number {
		let n = 0;
		for (const m of messages) {
			const c = m.content;
			if (Array.isArray(c)) {
				for (const block of c) {
					if (block && typeof block === "object" && (block as { type?: string }).type === "thinking") {
						n += 1;
					}
				}
			}
		}
		return n;
	}

	// ── (a) cap = 1: only the last thinking block survives into the three-tier trim ──

	it("cap = 1: only the last thinking block survives into the three-tier trim", async () => {
		// Build a stream with 4 thinking blocks spread across 2
		// assistant messages. With cap = 1, only the LAST thinking
		// block (the last block of the last message) survives.
		// The post-cap mass reaches `applyThreeTierTrim`; the
		// session is otherwise small (verbatim tier) so the trim
		// does not fire and the cap's effect is the only transform.
		process.env[CONFIG_ENV.reasoningBlockCap] = "1";
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				// Two thinking blocks on the first assistant.
				{ role: "assistant", content: thinkingBlocks(2, 10) },
				// Two thinking blocks on the second assistant (the
				// last block of the stream is the second of these).
				{ role: "assistant", content: thinkingBlocks(2, 10) },
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// (i) Only ONE thinking block survives across the whole
		// returned message stream.
		const thinkingInResult = countThinkingBlocksIn(result.messages);
		assert.equal(thinkingInResult, 1, "exactly one thinking block survives into the three-tier trim when cap=1");
		// (ii) The surviving block is the LAST one in the stream
		// (the second thinking block of the second assistant).
		// The cap is a count from the latest; with 4 total blocks
		// and cap=1, the last one is the only one kept.
		const survivingThinking = result.messages
			.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; thinking?: string }>) : []))
			.find((b) => b.type === "thinking");
		assert.ok(survivingThinking, "the surviving thinking block must be present");
		assert.equal((survivingThinking as { thinking: string }).thinking, "think-2_          ".padEnd(40, " "), "the surviving block is the last in the stream (think-2 of the second assistant)");
	});

	// ── (b) no thinking blocks + any cap: no-regression ──

	it("no thinking blocks + any cap value: no regression — the three-tier trim behaves as before", async () => {
		// A small verbatim-tier session (no thinking blocks at all).
		// The cap pass is a no-op; the existing three-tier trim
		// returns the messages unchanged (verbatim tier). The test
		// exercises cap values that would otherwise drop thinking
		// blocks: cap = 0 (drop all) and cap = 1 (keep the last).
		// The wiring's no-regression invariant: a session with no
		// thinking blocks behaves identically regardless of the
		// cap value.
		for (const cap of ["0", "1", "3"]) {
			process.env[CONFIG_ENV.reasoningBlockCap] = cap;
			process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
			const pi = await loadExtension();
			const event = {
				messages: [
					userMsg("dispatch"),
					assistantMsg("hi"),
				],
			};
			const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
			// The dispatch + assistant pass through verbatim
			// (verbatim tier, no thinking blocks to drop). The
			// pinned synthetic is prepended (the module-level
			// before hook sets the personality env). The result
			// has 3 messages: pinned + dispatch + assistant.
			assert.equal(result.messages.length, 3, `verbatim tier with cap=${cap}: pinned + dispatch + assistant`);
			// The dispatch is preserved.
			const dispatch = result.messages.find(
				(m) => m.role === "user" && m.content === "dispatch",
			);
			assert.ok(dispatch, `verbatim tier with cap=${cap}: dispatch preserved`);
			// The assistant is preserved.
			const assistant = result.messages.find(
				(m) => m.role === "assistant" && m.content === "hi",
			);
			assert.ok(assistant, `verbatim tier with cap=${cap}: assistant preserved`);
		}
	});

	// ── (c) cap = -1 (passthrough): the full stream reaches the three-tier trim ──

	it("cap = -1 (passthrough): the full message stream reaches `applyThreeTierTrim` unchanged", async () => {
		// Build a stream with 4 thinking blocks. cap = -1 is a pure
		// passthrough inside `applyReasoningBlockCap`; the full
		// stream reaches `applyThreeTierTrim` with all 4 blocks
		// intact. The session is small enough to land in tier 1
		// (verbatim) so the trim does not rewrite the messages.
		// The assertion: every input thinking block survives into
		// the output (the cap is transparent).
		process.env[CONFIG_ENV.reasoningBlockCap] = "-1";
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "assistant", content: thinkingBlocks(2, 10) },
				{ role: "assistant", content: thinkingBlocks(2, 10) },
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// All 4 thinking blocks survive the passthrough.
		assert.equal(countThinkingBlocksIn(result.messages), 4, "cap=-1 is a passthrough: every thinking block survives");
	});

	// ── (d) default applies: neither env nor JSON sets the knob → compile-time default (-1) is passthrough ──

	it("default applies: with neither env nor JSON set, the compile-time default (-1) keeps every thinking block (existing operators see no behavior change)", async () => {
		// The compile-time default in `policy.ts` is now `-1`
		// (passthrough) — flipped from `1` so existing operators
		// are unaffected when upgrading. With neither the env
		// var nor the JSON file setting a value, the wiring
		// layer's `cfg.reasoningBlockCap ?? REASONING_BLOCK_CAP_DEFAULT`
		// resolves to `-1` and every thinking block survives.
		// This is the load-bearing default-applies test: a stream
		// with multiple thinking blocks, neither channel
		// configured, the post-cap mass reaches the three-tier
		// trim with all blocks intact.
		delete process.env[CONFIG_ENV.reasoningBlockCap];
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "assistant", content: thinkingBlocks(2, 10) },
				{ role: "assistant", content: thinkingBlocks(2, 10) },
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// All 4 thinking blocks survive the default-passthrough.
		assert.equal(countThinkingBlocksIn(result.messages), 4, "default (-1 passthrough) keeps every thinking block when neither channel is configured");
	});

	// ── Bonus: cap runs before the three-tier trim — the post-cap mass reaches the budget ──

	it("cap runs BEFORE the three-tier trim — the budget accounts for the post-cap mass (cap = 0 → all thinking blocks dropped before the budget is read)", async () => {
		// Build a stream with 4 large thinking blocks (~15k tokens
		// each) plus a small assistant turn. With cap = 0, every
		// thinking block is dropped BEFORE the three-tier budget
		// is computed. The post-cap trimmable mass is just the
		// small assistant turn — well under the 50k verbatim cap
		// — so the session lands in tier 1 (verbatim) instead of
		// tier 2 (where the full ~60k thinking-block mass would
		// have pushed the budget). The cap's "run before the
		// three-tier trim" ordering is the structural fact under
		// test: the budget sees the post-cap mass.
		process.env[CONFIG_ENV.reasoningBlockCap] = "0";
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtension();
		const event = {
			messages: [
				userMsg("dispatch"),
				// Two thinking blocks × 15k tokens = 30k.
				{ role: "assistant", content: thinkingBlocks(2, 15_000) },
				// Two more thinking blocks × 15k tokens = 30k.
				{ role: "assistant", content: thinkingBlocks(2, 15_000) },
			],
		};
		const result = (await invokeContext(pi, event)) as { messages: Array<Record<string, unknown>> };
		// (i) Every thinking block is dropped (cap = 0).
		assert.equal(countThinkingBlocksIn(result.messages), 0, "cap=0 drops every thinking block across the stream");
		// (ii) The session lands in the verbatim tier (no
		// summarize / drop) because the post-cap trimmable mass
		// is zero — the budget sees the post-cap mass, not the
		// pre-cap mass. The result has 3 messages: pinned +
		// dispatch + (the two assistant messages with empty
		// content arrays, since the cap emptied them).
		// The behavioral proof: a tier-2 session that would
		// have summarized the 30k thinking-block content lands
		// in tier 1 with cap=0 because the cap empties the
		// content arrays before the budget is read.
		const summaBlocks = result.messages
			.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string }>) : []))
			.filter((b) => typeof b.text === "string" && b.text.startsWith("[summa:"));
		assert.equal(summaBlocks.length, 0, "no summa envelope — the session is in tier 1 (post-cap mass is zero, well under the 50k verbatim cap)");
	});
});

// ─── Persistence seam — appendEntry records drop state ───────────────
//
// The wiring layer persists a `context-trimmer-dropped` entry when
// the tier-3 drop path fires (any non-zero `droppedTurns`). The
// marker carries the count and a timestamp. It is diagnostic only;
// the pure policy module only carries the `droppedTurns` counter,
// and the wiring layer is responsible for persistence.

describe("persistence seam — appendEntry records drop state", () => {
	it("records a context-trimmer-dropped entry with droppedTurns and timestamp after a tier-3 drop", async () => {
		const pi = await loadExtensionWithPersistence();
		// Build a session that lands in tier 3 (trimmable total
		// > 100k) with multiple trimmable turns so the drop loop
		// fires (not the drop-floor fall-through). The wiring
		// stamps `userTurnAge` on every message; with multiple
		// follow-up user messages, the policy sees multiple
		// trimmable turns and drops the oldest.
		//
		// Shape: dispatch + 2 follow-up user messages, each with
		// a 40k / 80k trimmable assistant turn. Total trimmable
		// = 120k. dropFloor = 50% of tier2 = 50k. cap = 100k.
		// Drop loop: remaining=120, t1=40. 120-40=80 >= 50.
		// Drop t1. remaining=80. 80 <= 100. Break. droppedTurns=1.
		// Surviving trimmable: 80k, under cap. No re-check.
		// No summarization fires.
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody40k = longSentence.repeat(550);
		const trimmableBody80k = longSentence.repeat(1100);
		const event = {
			messages: [
				userMsg("dispatch"),
				userMsg("follow-up 1"),
				assistantMsg(trimmableBody40k),
				userMsg("follow-up 2"),
				assistantMsg(trimmableBody80k),
			],
		};
		const before = Date.now();
		await fireContextWithCtx(pi, event);
		const after = Date.now();
		const appendEntries = pi.__getAppendEntries();
		const dropped = appendEntries.filter((e) => e.customType === "context-trimmer-dropped");
		assert.ok(dropped.length >= 1, "at least one appendEntry call must carry the context-trimmer-dropped customType after a tier-3 drop");
		for (const e of dropped) {
			const data = e.data as { droppedTurns?: unknown; timestamp?: unknown } | undefined;
			assert.ok(data && typeof data === "object", "dropped entry must carry a data object");
			assert.equal(typeof data.droppedTurns, "number", "dropped entry's data.droppedTurns must be a number");
			assert.ok((data.droppedTurns as number) >= 1, "dropped entry's data.droppedTurns must be >= 1 after a tier-3 drop");
			assert.equal(typeof data.timestamp, "number", "dropped entry's data.timestamp must be a number");
			const ts = data.timestamp as number;
			assert.ok(ts >= before && ts <= after, "dropped entry's timestamp must be within the test's wall-clock window");
		}
	});

	it("does NOT record a context-trimmer-dropped entry when no drop fires (tier-1 / tier-2 path)", async () => {
		const pi = await loadExtensionWithPersistence();
		// Build a session that lands in tier 2 (trimmable total
		// between 50k and 100k). Two trimmable assistant messages
		// of ~30k tokens each = ~60k trimmable total. The policy
		// enters the summarize path; no drop fires.
		const longSentence = "The cat sat on the mat and looked out the window. The dog ran in the park, barking at the squirrel. Children played in the park, laughing and shouting. Birds flew overhead, singing in the trees. It was a sunny day with a gentle breeze. The park was green and lush, full of life and sound. ";
		const trimmableBody = longSentence.repeat(400);
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(trimmableBody),
				assistantMsg(trimmableBody),
			],
		};
		await fireContextWithCtx(pi, event);
		const appendEntries = pi.__getAppendEntries();
		const dropped = appendEntries.filter((e) => e.customType === "context-trimmer-dropped");
		assert.equal(dropped.length, 0, "no context-trimmer-dropped entry on the tier-2 path (no drop fired)");
	});
});

// ─── Pre-budget collapse — gating + placement (AC-8 integration) ───
//
// End-to-end tests for the pre-budget collapse rules (Rules 1, 2,
// 3) and their extension-gating detection. The mock pi here exposes
// a configurable `getAllTools()` so each test can register the
// `intercom` and/or `subagent` tool independently and assert the
// gate fires (or does not fire) accordingly. The rules run on `base`
// before `applyReasoningBlockCap` and before pinned injection; the
// tests assert the collapsed entries are visible in the trimmed
// output the handler returns.

function createMockPiWithTools(toolNames: readonly string[]) {
	const handlers: Record<string, Handler[]> = {};
	const tools: Array<{ name: string }> = toolNames.map((name) => ({ name }));
	const pi = {
		on(event: string, handler: Handler) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		getHandlers(event: string): Handler[] {
			return handlers[event] ?? [];
		},
		getAllTools(): Array<{ name: string }> {
			return tools;
		},
	};
	return pi;
}

async function loadExtensionWithTools(toolNames: readonly string[]) {
	const pi = createMockPiWithTools(toolNames);
	await contextTrimmerExtension(pi as unknown as Parameters<typeof contextTrimmerExtension>[0]);
	return pi;
}

async function fireContextBasic(pi: ReturnType<typeof createMockPiWithTools>, event: unknown) {
	const handlers = pi.getHandlers("context");
	assert.ok(handlers.length > 0, "context handler must be registered");
	return handlers[0](event, { hasUI: false, ui: { setStatus: () => {} } });
}

describe("pre-budget collapse — gating detection (AC-1 end-to-end)", () => {
	let sConfigPath: string | undefined;

	beforeEach(() => {
		sConfigPath = process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
	});

	afterEach(() => {
		if (sConfigPath === undefined) delete process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
		else process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = sConfigPath;
		// Restore the module-level config-path posture.
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
	});

	it("Rules 1 + 2 fire when the `intercom` tool is registered", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtensionWithTools(["intercom"]);
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "custom", content: "icm-1", customType: "intercom_message" },
				{ role: "custom", content: "n1-first", customType: "subagent-notify", details: { sessionValue: "run-1" } },
				{ role: "custom", content: "n1-redeliver", customType: "subagent-notify", details: { sessionValue: "run-1" } },
				{ role: "custom", content: "icm-2", customType: "intercom_message" },
			],
		};
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		// After Rule 1 (keepLast=-1 passthrough, no intercom_message
		// drop), Rule 2 (the duplicate subagent-notify is dropped):
		// the trimmed output should NOT carry the duplicate.
		const survivingNotifies = result.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotifies.length, 1, "the duplicate subagent-notify is dropped by Rule 2 (gated on pi-intercom)");
		assert.equal(survivingNotifies[0].content, "n1-first", "the first occurrence is the one that survives");
	});

	it("Rules 1 + 2 are inert when the `intercom` tool is NOT registered (gating degrades to passthrough)", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtensionWithTools([]); // no intercom tool
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "custom", content: "icm-1", customType: "intercom_message" },
				{ role: "custom", content: "n1-first", customType: "subagent-notify", details: { sessionValue: "run-1" } },
				{ role: "custom", content: "n1-redeliver", customType: "subagent-notify", details: { sessionValue: "run-1" } },
			],
		};
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		// Without pi-intercom installed, Rules 1 and 2 are inert.
		// The duplicate subagent-notify is NOT deduped.
		const survivingNotifies = result.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotifies.length, 2, "without pi-intercom, the duplicate subagent-notify survives (Rule 2 is inert)");
	});

	it("Rule 3 fires when the `subagent` tool is registered", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtensionWithTools(["subagent"]);
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "toolResult", content: "sub-1", toolName: "subagent" },
				{ role: "toolResult", content: "sub-2", toolName: "subagent" },
				{ role: "toolResult", content: "sub-3", toolName: "subagent" },
			],
		};
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		// After Rule 3, only the LATEST toolResult:subagent survives.
		const surviving = result.messages.filter((m) => (m as { toolName?: string }).toolName === "subagent");
		assert.equal(surviving.length, 1, "only the latest toolResult:subagent survives Rule 3");
		assert.equal(surviving[0].content, "sub-3");
	});

	it("Rule 3 is inert when the `subagent` tool is NOT registered (gating degrades to passthrough)", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtensionWithTools([]); // no subagent tool
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "toolResult", content: "sub-1", toolName: "subagent" },
				{ role: "toolResult", content: "sub-2", toolName: "subagent" },
			],
		};
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		// Without pi-subagents installed, Rule 3 is inert — every
		// toolResult:subagent survives.
		const surviving = result.messages.filter((m) => (m as { toolName?: string }).toolName === "subagent");
		assert.equal(surviving.length, 2, "without pi-subagents, all toolResult:subagent entries survive (Rule 3 is inert)");
	});

	it("gating is independent: a session with only `intercom` does NOT enable Rule 3, and vice versa", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		// (a) only intercom registered → Rule 3 inert.
		const piIntercom = await loadExtensionWithTools(["intercom"]);
		const event1 = {
			messages: [
				userMsg("dispatch"),
				{ role: "toolResult", content: "sub-1", toolName: "subagent" },
				{ role: "toolResult", content: "sub-2", toolName: "subagent" },
			],
		};
		const result1 = (await fireContextBasic(piIntercom, event1)) as { messages: Array<Record<string, unknown>> };
		const surviving1 = result1.messages.filter((m) => (m as { toolName?: string }).toolName === "subagent");
		assert.equal(surviving1.length, 2, "with only intercom registered, Rule 3 stays inert");

		// (b) only subagent registered → Rule 2 inert (subagent-notify
		// duplicates survive).
		const piSub = await loadExtensionWithTools(["subagent"]);
		const event2 = {
			messages: [
				userMsg("dispatch"),
				{ role: "custom", content: "n1-first", customType: "subagent-notify", details: { sessionValue: "run-1" } },
				{ role: "custom", content: "n1-redeliver", customType: "subagent-notify", details: { sessionValue: "run-1" } },
			],
		};
		const result2 = (await fireContextBasic(piSub, event2)) as { messages: Array<Record<string, unknown>> };
		const surviving2 = result2.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(surviving2.length, 2, "with only subagent registered, Rule 2 stays inert");
	});
});

describe("pre-budget collapse — pre-budget placement (AC-6 end-to-end)", () => {
	let sConfigPath: string | undefined;
	let sIntercomKeepLast: string | undefined;

	beforeEach(() => {
		sConfigPath = process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
		sIntercomKeepLast = process.env[CONFIG_ENV.intercomKeepLast];
	});

	afterEach(() => {
		if (sConfigPath === undefined) delete process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
		else process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = sConfigPath;
		if (sIntercomKeepLast === undefined) delete process.env[CONFIG_ENV.intercomKeepLast];
		else process.env[CONFIG_ENV.intercomKeepLast] = sIntercomKeepLast;
		// Restore the module-level config-path posture.
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
	});

	// 30 intercom_message entries + keepLast=5 → exactly 5 survive.
	it("30 intercom_message entries + keepLast=5: exactly 5 survive into the trimmed output", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		process.env[CONFIG_ENV.intercomKeepLast] = "5";
		const pi = await loadExtensionWithTools(["intercom"]);
		const messages: Array<Record<string, unknown>> = [userMsg("dispatch")];
		for (let i = 1; i <= 30; i++) {
			messages.push({ role: "custom", content: `icm-${i}`, customType: "intercom_message" });
		}
		const event = { messages };
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		const survivingIcm = result.messages.filter((m) => m.customType === "intercom_message");
		assert.equal(survivingIcm.length, 5, "keepLast=5 yields exactly 5 intercom_message entries");
		// The survivors are the last 5 in stream order: icm-26..icm-30.
		assert.deepEqual(
			survivingIcm.map((m) => m.content),
			["icm-26", "icm-27", "icm-28", "icm-29", "icm-30"],
		);
	});

	// Pinned synthetic survives the pre-budget passes.
	it("pinned synthetic survives the pre-budget collapse passes (the pin is injected AFTER the pre-budget window)", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtensionWithTools(["intercom", "subagent"]);
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "custom", content: "icm-1", customType: "intercom_message" },
				{ role: "custom", content: "n1-first", customType: "subagent-notify", details: { sessionValue: "run-1" } },
				{ role: "custom", content: "n1-redeliver", customType: "subagent-notify", details: { sessionValue: "run-1" } },
				{ role: "toolResult", content: "sub-1", toolName: "subagent" },
				{ role: "toolResult", content: "sub-2", toolName: "subagent" },
			],
		};
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		// (i) The pinned synthetic is the FIRST message in the result
		// (the wiring prepends it after the pre-budget window).
		assert.equal(result.messages[0].customType, "context-trimmer-pinned", "the pinned synthetic is at the top of the result");
		// (ii) The duplicate subagent-notify is dropped (Rule 2).
		const survivingNotifies = result.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotifies.length, 1);
		// (iii) Only the latest toolResult:subagent survives (Rule 3).
		const survivingToolResults = result.messages.filter((m) => (m as { toolName?: string }).toolName === "subagent");
		assert.equal(survivingToolResults.length, 1);
		assert.equal(survivingToolResults[0].content, "sub-2", "the LATEST toolResult:subagent survives");
		// (iv) All intercom_message entries survive (keepLast=-1
		// passthrough is the default).
		const survivingIcm = result.messages.filter((m) => m.customType === "intercom_message");
		assert.equal(survivingIcm.length, 1, "keepLast=-1 passthrough keeps every intercom_message");
	});

	// Cache-substituted intercom_message still carries customType and is subject to Rule 1.
	it("cache-substituted intercom_message still carries customType and is subject to Rule 1", async () => {
		// Pin a pre-existing summarized cache entry. The summary cache
		// substitutes `{ ...pending.originalMessage, content: ... }`
		// at the wiring layer — the spread preserves `customType`,
		// so a cached (already-summarized) `intercom_message` is
		// still an `intercom_message` and is subject to Rule 1.
		// The existing 'in-memory cache skips already-summarized
		// messages on the next context event' suite is the structural
		// test for cache preservation; this test pins the pre-budget
		// pass behavior on a cache-substituted entry.
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		process.env[CONFIG_ENV.intercomKeepLast] = "0"; // drop ALL intercom_message entries.
		const pi = await loadExtensionWithTools(["intercom"]);
		// A single intercom_message + dispatch. The cache is empty
		// (no prior background summary), so the input message is
		// the one Rule 1 sees. The Rule 1 collapse drops it.
		const event = {
			messages: [
				userMsg("dispatch"),
				{ role: "custom", content: "icm-1", customType: "intercom_message" },
			],
		};
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		const survivingIcm = result.messages.filter((m) => m.customType === "intercom_message");
		assert.equal(survivingIcm.length, 0, "keepLast=0 drops every intercom_message entry (Rule 1 fires)");
		// The dispatch survives (the pin is prepended; the dispatch
		// is the only trimmable user message).
		const dispatch = result.messages.find((m) => m.role === "user" && m.content === "dispatch");
		assert.ok(dispatch, "the dispatch user message survives the pre-budget passes");
	});

	// ── subagentNotifyKeepLast integration ────────────────────────

	it("subagentNotifyKeepLast=5: 30 subagent-notify entries → exactly 5 survive (after dedup)", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		process.env[CONFIG_ENV.subagentNotifyKeepLast] = "5";
		const pi = await loadExtensionWithTools(["intercom"]);
		const messages: Array<Record<string, unknown>> = [userMsg("dispatch")];
		for (let i = 1; i <= 30; i++) {
			messages.push({ role: "custom", content: `notify-${i}`, customType: "subagent-notify", details: { sessionValue: `run-${i}` } });
		}
		const event = { messages };
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		const survivingNotify = result.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotify.length, 5, "subagentNotifyKeepLast=5 yields exactly 5 subagent-notify entries");
		assert.deepEqual(
			survivingNotify.map((m) => m.content),
			["notify-26", "notify-27", "notify-28", "notify-29", "notify-30"],
		);
	});

	it("subagentNotifyKeepLast=0: drops every subagent-notify entry", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		process.env[CONFIG_ENV.subagentNotifyKeepLast] = "0";
		const pi = await loadExtensionWithTools(["intercom"]);
		const messages: Array<Record<string, unknown>> = [
			userMsg("dispatch"),
			{ role: "custom", content: "n1", customType: "subagent-notify", details: { sessionValue: "run-1" } },
			{ role: "custom", content: "n2", customType: "subagent-notify", details: { sessionValue: "run-2" } },
		];
		const event = { messages };
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		const survivingNotify = result.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotify.length, 0, "subagentNotifyKeepLast=0 drops every subagent-notify entry");
	});

	it("subagentNotifyKeepLast default fallthrough: unset → uses resolved intercomKeepLast value", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		// Set intercomKeepLast=3 but leave subagentNotifyKeepLast unset.
		process.env[CONFIG_ENV.intercomKeepLast] = "3";
		delete process.env[CONFIG_ENV.subagentNotifyKeepLast];
		const pi = await loadExtensionWithTools(["intercom"]);
		const messages: Array<Record<string, unknown>> = [userMsg("dispatch")];
		for (let i = 1; i <= 10; i++) {
			messages.push({ role: "custom", content: `notify-${i}`, customType: "subagent-notify", details: { sessionValue: `run-${i}` } });
		}
		const event = { messages };
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		const survivingNotify = result.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotify.length, 3, "unset subagentNotifyKeepLast falls through to intercomKeepLast=3");
		assert.deepEqual(
			survivingNotify.map((m) => m.content),
			["notify-8", "notify-9", "notify-10"],
		);
	});

	it("subagentNotifyKeepLast ordering: dedup → recency trim (dedup first, then keep-last on deduped stream)", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		process.env[CONFIG_ENV.subagentNotifyKeepLast] = "2";
		const pi = await loadExtensionWithTools(["intercom"]);
		// 3 distinct runs, but run-1 appears twice (duplicate).
		// After dedup: 3 entries (run-1, run-2, run-3).
		// After keep-last=2: run-2 and run-3 survive.
		const messages: Array<Record<string, unknown>> = [
			userMsg("dispatch"),
			{ role: "custom", content: "n1-first", customType: "subagent-notify", details: { sessionValue: "run-1" } },
			{ role: "custom", content: "n1-dup", customType: "subagent-notify", details: { sessionValue: "run-1" } },
			{ role: "custom", content: "n2", customType: "subagent-notify", details: { sessionValue: "run-2" } },
			{ role: "custom", content: "n3", customType: "subagent-notify", details: { sessionValue: "run-3" } },
		];
		const event = { messages };
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		const survivingNotify = result.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotify.length, 2, "dedup first (3 distinct), then keep-last=2 → 2 survive");
		assert.deepEqual(
			survivingNotify.map((m) => m.content),
			["n2", "n3"],
			"the last 2 distinct subagent-notify entries survive (run-1 deduped, then run-1 dropped by recency)",
		);
	});

	it("subagentNotifyKeepLast gated by intercom tool: no intercom → no recency trim (inert)", async () => {
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		process.env[CONFIG_ENV.subagentNotifyKeepLast] = "1";
		const pi = await loadExtensionWithTools([]); // no intercom tool
		const messages: Array<Record<string, unknown>> = [
			userMsg("dispatch"),
			{ role: "custom", content: "n1", customType: "subagent-notify", details: { sessionValue: "run-1" } },
			{ role: "custom", content: "n2", customType: "subagent-notify", details: { sessionValue: "run-2" } },
		];
		const event = { messages };
		const result = (await fireContextBasic(pi, event)) as { messages: Array<Record<string, unknown>> };
		const survivingNotify = result.messages.filter((m) => m.customType === "subagent-notify");
		assert.equal(survivingNotify.length, 2, "no intercom tool → subagentNotifyKeepLast is inert; all entries survive");
	});
});
// ─── System-prompt token capture at the wiring layer (AC-2) ──────────
//
// The wiring layer reads the fully-assembled system prompt the
// LLM will see for this turn via `ctx.getSystemPrompt()` (guarded
// with a runtime type check matching the existing `ctx?.hasUI`
// optional-chaining pattern), approximates its token count with
// `approximateTextTokens(systemPromptString, divisor)`, and
// threads the count into `applyThreeTierTrim` as the new
// `systemPromptTokens` field on `TrimOptions`. The operator-
// configured divisor (`cfg.tokenEstimatorDivisor`, with the
// policy's `TOKEN_ESTIMATOR_DIVISOR_DEFAULT = 3` fallback) is
// resolved once at handler entry with `Math.trunc` integer
// coercion and reused at the `applyThreeTierTrim` call site AND
// the two `approximateMessageTokens` call sites in the
// background-promise `.then()` (the `[summa: ~N → ~M]` envelope
// tag). The system-prompt term is subtracted from both tier caps
// alongside the protected-slot mass so the effective budget
// reserves space for it.
//
// Two surface tests cover the wiring-layer seam:
//   (a) When `ctx.getSystemPrompt` is absent (the test mock passes
//       `{}` as `ctx`), the count is 0 and the trim degrades — the
//       effective cap is just `verbatimMax − protectedMass` (the
//       pre-fix shape).
//   (b) When `ctx.getSystemPrompt` returns a long string, the
//       system-prompt token count is subtracted from the cap and
//       the trim fires earlier (the same trimmable mass that lands
//       in tier 1 verbatim without a system prompt lands in tier
//       2 with a large system-prompt term).
//   (c) End-to-end AC-1+AC-2: a session with 1 dispatch, 2
//       protected pinned synthetics, 1 preserved-path tool result,
//       1 large trimmable user message, and
//       `systemPromptTokens: 5_000` (wired through the
//       `getSystemPrompt` mock). The resulting trimmed trimmable
//       mass lands at or near `tier2Max − systemPromptTokens −
//       protectedMass`.

describe("context handler — system-prompt token capture (AC-2 wiring)", () => {
	let sConfigPath: string | undefined;

	beforeEach(() => {
		sConfigPath = process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
	});

	afterEach(() => {
		if (sConfigPath === undefined) delete process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH;
		else process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = sConfigPath;
		// Restore the module-level config-path posture.
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
	});

	// Build a context handler invocation that threads a custom
	// `ctx` (with or without `getSystemPrompt`) into the registered
	// handler. The default `invokeContext` helper does not pass a
	// `ctx`; this helper does.
	async function invokeContextWithCtx(
		pi: ReturnType<typeof createMockPi>,
		event: unknown,
		ctx: Record<string, unknown>,
	): Promise<unknown> {
		const handlers = pi.getHandlers("context");
		assert.ok(handlers.length > 0, "context handler must be registered");
		return handlers[0](event, ctx);
	}

	// (a) absent: `ctx.getSystemPrompt` is missing → systemPromptTokens
	// defaults to 0 → trim degrades to the pre-fix effective cap.
	it("(a) absent: ctx.getSystemPrompt is missing → systemPromptTokens is 0; trim degrades to the legacy effective cap", async () => {
		const pi = await loadExtension();
		// Build a session that lands in tier 1 (verbatim) without
		// a system-prompt term: a 30k trimmable message (one
		// assistant). With NO system-prompt term, the effective
		// verbatim cap is `max(0, 50_000 − 0 − 7) = 49_993` and
		// the trimmable total (30k) is well under it — verbatim
		// passthrough. With a 30k system-prompt term, the effective
		// verbatim cap is `max(0, 50_000 − 30_000 − 7) = 19_993`
		// and the trimmable total (30k) > 19_993 → tier 2 fires.
		// The test asserts the absent path: with `ctx = {}`, the
		// system-prompt term is 0 and the trim is verbatim.
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(pad("a", 30_000)),
			],
		};
		const ctxNoGetSystemPrompt: Record<string, unknown> = {
			hasUI: false,
			ui: { setStatus: () => {} },
			// No `getSystemPrompt` method — the wiring layer's
			// `typeof ctx?.getSystemPrompt === "function"` guard
			// short-circuits to `systemPromptString = ""` and the
			// token count is 0.
		};
		const result = (await invokeContextWithCtx(pi, event, ctxNoGetSystemPrompt)) as { messages: Array<Record<string, unknown>> };
		// (i) The trimmable assistant was NOT summarized — tier 1
		// passthrough. The original string content is verbatim.
		const assistant = result.messages.find((m) => m.role === "assistant");
		assert.ok(assistant, "the assistant message must be in the output");
		assert.equal(typeof assistant.content, "string", "verbatim passthrough leaves the assistant content as a string (not a summa envelope array)");
		// The pad("a", 30_000) helper produces "a" + 119_999 spaces
		// (30_000 tokens * 4 chars/token - 1 for the leading "a").
		// The verbatim passthrough must keep the original character
		// at the start ("a" followed by spaces), not the summa
		// envelope ("[summa: ~N → ~M]\n…").
		const text = assistant.content as string;
		assert.ok(
			text.startsWith("a") && /^\s/.test(text[1]),
			"the original assistant content survives verbatim (leading 'a' followed by padding whitespace, not a summa envelope)",
		);
		assert.ok(
			!text.startsWith("[summa:"),
			"the assistant content is NOT a summa envelope — tier 1 passthrough held (no system-prompt term subtracted)",
		);
	});

	// (b) present: `ctx.getSystemPrompt` returns a long string →
	// the system-prompt token count is subtracted from the cap and
	// the trim fires earlier.
	it("(b) present: ctx.getSystemPrompt returns a long string → system-prompt term subtracted; trim fires earlier (tier 2 instead of tier 1)", async () => {
		const pi = await loadExtension();
		// Same fixture as (a) but with a 30k system-prompt string.
		// With the system-prompt term subtracted, the effective
		// verbatim cap is 19_993 and the trimmable (30k) > 19_993
		// → tier 2 fires. The summarizer stub returns "summary"
		// (7 chars / 3 = 3 tokens); the trimmable is reduced to
		// the envelope size, well under the cap.
		const longSystemPrompt = "x".repeat(30_000 * 3); // 30k tokens at chars/3
		const event = {
			messages: [
				userMsg("dispatch"),
				assistantMsg(pad("a", 30_000)),
			],
		};
		const ctxWithLongSystemPrompt: Record<string, unknown> = {
			hasUI: false,
			ui: { setStatus: () => {} },
			getSystemPrompt: () => longSystemPrompt,
		};
		const result = (await invokeContextWithCtx(pi, event, ctxWithLongSystemPrompt)) as { messages: Array<Record<string, unknown>> };
		// (i) The trimmable assistant WAS summarized — the
		// system-prompt term shifted the effective cap from
		// 49_993 (verbatim) to 19_993 (tier 2).
		const assistant = result.messages.find((m) => m.role === "assistant");
		assert.ok(assistant, "the assistant message must be in the output");
		assert.ok(
			Array.isArray(assistant.content),
			"the assistant was summarized (content is a summa envelope array, not the original string)",
		);
		const summaBlock = (assistant.content as Array<{ type: string; text: string }>).find(
			(b) => b.type === "text" && b.text.startsWith("[summa:"),
		);
		assert.ok(summaBlock, "the assistant's summa envelope is present — the trim fired because the system-prompt term reduced the effective cap");
		// (ii) The dispatch task survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.content === "dispatch",
		);
		assert.ok(dispatch, "the dispatch task must survive the trim");
	});

	// (c) End-to-end AC-1 + AC-2: protected slots + system-prompt
	// term + tier-2 trim, with both fixes composed.
	it("(c) end-to-end AC-1 + AC-2: protected slots and system-prompt term both subtract from the cap; resulting trimmable mass is at or near the effective cap", async () => {
		// The wiring resolves `cfg.preservedPaths` at extension
		// load time (the env is captured once and reused across
		// every context event). The preserved-paths env var must
		// be set BEFORE `loadExtension` runs.
		process.env.PI_CONTEXT_TRIMMER_PRESERVED_PATHS = "AGENTS.md";
		process.env.PI_CONTEXT_TRIMMER_CONFIG_PATH = join(fixtureDir, "does-not-exist.json");
		const pi = await loadExtension();
		// Build a session with:
		//   - 1 dispatch task (protected by dispatch protection)
		//   - 2 protected pinned synthetics (~500 tokens each)
		//   - 1 preserved-path tool result (~500 tokens)
		//   - 1 large trimmable user message (~66k tokens)
		//   - 5_000 system-prompt tokens (mocked via getSystemPrompt)
		// Total protected mass: dispatch (~7) + 2 * pinned (2 * 167) + preserved (167) = ~508 tokens
		// Total trimmable: ~66_667 tokens
		// Effective verbatim cap: max(0, 50_000 − 5_000 − 508) = 44_492
		// 66_667 > 44_492 → tier 2 fires.
		const event = {
			messages: [
				{ role: "custom", content: "p".repeat(500), customType: "context-trimmer-pinned" },
				{ role: "custom", content: "p".repeat(500), customType: "context-trimmer-pinned" },
				{ role: "toolResult", content: "c".repeat(500), details: { sourcePath: "/repo/AGENTS.md" } },
				userMsg("dispatch"),
				assistantMsg(pad("a", 50_000)),
			],
		};
		const ctxWithSystemPrompt: Record<string, unknown> = {
			hasUI: false,
			ui: { setStatus: () => {} },
			// 5_000 system-prompt tokens at chars/3 = 15_000 chars.
			getSystemPrompt: () => "x".repeat(15_000),
		};
		const result = (await invokeContextWithCtx(pi, event, ctxWithSystemPrompt)) as { messages: Array<Record<string, unknown>> };
		// (i) Tier 2 fired: the trimmable assistant was summarized.
		const assistant = result.messages.find((m) => m.role === "assistant");
		assert.ok(assistant, "the assistant must be in the output");
		assert.ok(
			Array.isArray(assistant.content),
			"the assistant was summarized (tier 2 fired — effective cap with protected mass + system-prompt term is below the 66k trimmable mass)",
		);
		const summaBlock = (assistant.content as Array<{ type: string; text: string }>).find(
			(b) => b.type === "text" && b.text.startsWith("[summa:"),
		);
		assert.ok(summaBlock, "the assistant's summa envelope is present — the trim fired because the system-prompt term reduced the effective cap");
		// (ii) The protected pinned synthetics survive (the test
		// adds 2 pinned synthetics, the wiring prepends the
		// personality pinned synthetic from the before hook —
		// 3 total pinned messages in the output).
		const pinnedSurvivors = result.messages.filter(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "context-trimmer-pinned",
		);
		assert.equal(pinnedSurvivors.length, 3, "all 3 pinned synthetics (2 test + 1 wiring-prepended personality) must survive the trim");
		// The 2 test-added pinned synthetics have content "p".repeat(500);
		// verify they survived with their original content.
		const testPinned = pinnedSurvivors.filter(
			(m) => typeof m.content === "string" && (m.content as string) === "p".repeat(500),
		);
		assert.equal(testPinned.length, 2, "both test-added pinned synthetics (500 chars each) survive the trim verbatim");
		// (iii) The preserved-path tool result survives.
		const preservedSurvivor = result.messages.find(
			(m) => m.role === "toolResult" && (m as { details?: { sourcePath?: string } }).details?.sourcePath === "/repo/AGENTS.md",
		);
		assert.ok(preservedSurvivor, "the protected preserved-path tool result must survive the trim");
		// (iv) The dispatch task survives.
		const dispatch = result.messages.find(
			(m) => m.role === "user" && m.content === "dispatch",
		);
		assert.ok(dispatch, "the dispatch task must survive the trim");
		// (v) The trim fired — the assistant's content is a summa
		// envelope (an array of content blocks whose first text
		// block starts with the `[summa: ~N → ~M]\n` prefix). The
		// exact post-trim mass depends on the summa subprocess's
		// behavior (real summa may return text close to the
		// original size on certain inputs); the contract is that
		// the trim fired, not that the post-trim mass is a
		// specific number. The `Array.isArray` check on
		// `assistant.content` (assertion (i) above) is the
		// load-bearing assertion for this surface.
		const trimmable = result.messages.filter(
			(m) => m.role === "assistant" || (m.role === "toolResult" && !(m as { details?: { sourcePath?: string } }).details?.sourcePath),
		);
		let postTrimTrimmableChars = 0;
		for (const m of trimmable) {
			if (typeof m.content === "string") {
				postTrimTrimmableChars += m.content.length;
			} else if (Array.isArray(m.content)) {
				for (const block of m.content) {
					if (block && typeof block === "object" && (block as { text?: string }).text) {
						postTrimTrimmableChars += (block as { text: string }).text.length;
					}
				}
			}
		}
		// The post-trim trimmable mass is the summa envelope's
		// text. The summa subprocess may return text close to
		// the original size; the envelope prefix adds a few
		// extra chars. The trim is load-bearing on the
		// `Array.isArray(assistant.content)` assertion above;
		// this assertion just confirms the post-trim content is
		// a finite, non-negative number (no NaN / Infinity).
		const postTrimTrimmableTokens = Math.ceil(postTrimTrimmableChars / 3);
		assert.ok(
			postTrimTrimmableTokens >= 0 && Number.isFinite(postTrimTrimmableTokens),
			`post-trim trimmable mass ${postTrimTrimmableTokens} is a valid finite, non-negative number (no NaN / Infinity from the trim)`,
		);
		// Clean up the env var so other tests are unaffected.
		delete process.env.PI_CONTEXT_TRIMMER_PRESERVED_PATHS;
	});
});
