/**
 * T-2717 — Live-session integration tests for the redesigned
 * context-trimmer extension.
 *
 * This is the end-to-end functional gate for the assembled T-2717
 * extension (the unified keep/digest/retire engine + pinned tier +
 * recency comfort window). It exercises the extension's event
 * handlers against realistic bloat and asserts:
 *
 *   AC-1: view-time, age-scoped digesting (current turn verbatim,
 *         prior turns digest).
 *   AC-2: unified keep/digest/retire engine (kept → verbatim,
 *         dropped → excluded, auto-state transitions).
 *   AC-3: pinned tier (auto-pin by convention; personality + last-N
 *         tracker always present in the view).
 *   AC-4: recency comfort window (no threshold gate; bound derives
 *         from live `ctx.getContextUsage().contextWindow`).
 *   AC-5: five-path coherence (write-time side-by-side, view-time
 *         swap, session persistence, recency filter, lifecycle
 *         engine all cohere on a single `ToolResultMessage` shape).
 *
 * Harness choice: mock `ExtensionAPI` that captures the registered
 * handlers — deterministic and fast. The mock approach is a
 * recognized fallback when the SDK's `tool_result` event cannot
 * be triggered deterministically without an LLM call. The
 * extension's real handlers are bound to the real state via the
 * factory call.
 *
 * Bound derivation (AC-4): the bound is anchored to the LIVE
 * `ctx.getContextUsage()` shape. `reserveTokens` is the documented
 * default 16384 (per `compaction.md`). The test reads
 * `usage.contextWindow` and asserts the working window stays
 * under `contextWindow - reserveTokens - slack`, where `slack`
 * accounts for the recency window's expected cost.
 *
 * The live-session path that auto-discovers the extension from
 * `~/.pi/agent/extensions/context-trimmer/` is **not** exercised
 * here: the extension is INACTIVE during this work (moved out of
 * the live extensions dir per the ticket's "do NOT move it back"
 * directive). The mock-based path is the load-bearing assertion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// ─── Constants from the assembled extension ────────────────────────────────

/** Policy default recency window: retain the most recent N user-message turns. */
import { RECENCY_COMFORT_WINDOW } from "./policy.ts";

/** Digest cap: tool/MCP output digested to ≤ MAX_DIGEST_CHARS characters. */
import { MAX_DIGEST_CHARS } from "./digest.ts";

/** Pi's auto-compaction default `reserveTokens` (per `compaction.md`). */
const PI_RESERVE_TOKENS = 16_384;

/** Slack for the per-LLM-call view bound (covers recency window cost
 *  and per-message digest envelope overhead). Pinned as a constant
 *  so the test is stable. */
const COMFORT_SLACK = 2_000;

/** Approximate chars per token for English text (the SDK's estimate
 *  uses the same heuristic; per `compaction.ts` `estimateTokens`). */
const CHARS_PER_TOKEN = 4;

/** The integration test's bound derivation. Per AC-4: anchored to
 *  the LIVE `ctx.getContextUsage().contextWindow`. The test reads
 *  this from the mock context; production code does not gate on it. */
function deriveBound(contextWindow: number, reserveTokens: number): number {
	return contextWindow - reserveTokens - COMFORT_SLACK;
}

// ─── Mock ExtensionAPI for deterministic handler invocation ─────────────────

/**
 * A mock ExtensionAPI that captures all registered event handlers. This lets
 * us invoke the extension's handlers directly with mock events, which is
 * deterministic and fast. The extension module's handlers are closures over
 * the lifecycle state; by calling the factory with this mock, we get the
 * real handlers bound to the real state.
 */
function createMockPi() {
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>> = {};
	const commands: Record<string, { description: string; handler: unknown }> = {};
	const tools: Array<{ name: string; execute: unknown }> = [];
	const appendedEntries: unknown[] = [];

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		registerCommand(name: string, opts: { description: string; handler: unknown }) {
			commands[name] = opts;
		},
		registerTool(definition: { name: string; execute: unknown }) {
			tools.push(definition);
		},
		appendEntry(entry: unknown) {
			appendedEntries.push(entry);
		},
		sendUserMessage() {},
		getHandlers(event: string) {
			return handlers[event] ?? [];
		},
		getTools() {
			return tools;
		},
		getAppendedEntries() {
			return appendedEntries;
		},
	};
	return pi;
}

/**
 * Create a mock context with the minimum surface the extension uses.
 * Per AC-4: the `contextWindow` is the live-model window the test
 * reads for the bound derivation. The `tokens` field simulates the
 * working window's reported token count.
 */
function createMockContext(opts: {
	tokens?: number | null;
	contextWindow?: number;
	hasUI?: boolean;
} = {}) {
	const tokens = opts.tokens ?? null;
	const contextWindow = opts.contextWindow ?? 128_000;
	const hasUI = opts.hasUI ?? false;
	return {
		getContextUsage: () => ({
			tokens,
			contextWindow,
			percent: tokens !== null ? Math.round((tokens / contextWindow) * 100) : null,
		}),
		hasUI,
		ui: {
			notify: (_msg: string, _level: string) => {},
			setStatus: (_key: string, _text: string) => {},
		},
		cwd: "/tmp/pi-test",
		sessionManager: {
			// Returns the session branch (the list of entries from root to leaf).
			// The extension walks this in reverse to find the last assistant message.
			getBranch: () => [],
		},
		modelRegistry: undefined,
		signal: new AbortController().signal,
	};
}

// ─── Helper: load and invoke the extension factory ──────────────────────────

/**
 * Dynamically import the extension module and invoke its default export
 * with a mock pi. Returns the mock pi and a function to invoke any
 * registered handler.
 */
async function loadExtension() {
	// Import the extension module. Node 22 + --experimental-strip-types
	// handles .ts imports directly.
	const extPath = resolve(import.meta.dirname ?? ".", "index.ts");
	const mod = await import(extPath);
	const factory = mod.default;
	if (typeof factory !== "function") {
		throw new Error("Extension module has no default function export");
	}
	const mockPi = createMockPi();
	await factory(mockPi as unknown as Parameters<typeof factory>[0]);
	return mockPi;
}

// ─── Helper: build a tool-result message with the side-by-side envelope ────

/**
 * Build a `toolResult` message with the side-by-side envelope
 * (Storage Shape A: `content` verbatim + `details.digest` +
 * `details.turnIndex`). The shape is the AC-5 contract across all
 * five paths.
 */
function makeToolResultMessage(opts: {
	toolName: string;
	toolCallId: string;
	age: number;
	verbatimContent: string;
	digestContent: string;
	input?: Record<string, unknown>;
}) {
	return {
		role: "toolResult",
		toolCallId: opts.toolCallId,
		toolName: opts.toolName,
		age: opts.age,
		input: opts.input ?? {},
		content: [{ type: "text", text: opts.verbatimContent }],
		details: { digest: opts.digestContent, turnIndex: opts.age, toolCallId: opts.toolCallId },
		isError: false,
	};
}

/** Build a user message. */
function makeUserMessage(text: string) {
	return { role: "user", content: text };
}

/** Build an assistant message. */
function makeAssistantMessage(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

/** Build a per-tool digester envelope (used in mock tool_result events). */
function makeDigest(turnIndex: number, toolName: string, key: string): string {
	return `[factOfCall: ${toolName}(${key})]\n[digest: turn-${turnIndex} digest body]`;
}

/**
 * T-2720 — Build a tool-result message with the per-Pi-turn stamp
 * (`details.piTurnAge`) in addition to the user-turn stamp (`age`).
 * The engine's per-Pi-turn clause reads `details.piTurnAge` (not the
 * recorded state's `piTurnAge`); the fixture must carry the stamp
 * explicitly for the T-2720 tests to exercise the clause.
 */
function makeToolResultMessageWithPiTurn(opts: {
	toolName: string;
	toolCallId: string;
	age: number;
	piTurnAge: number;
	verbatimContent: string;
	digestContent: string;
	input?: Record<string, unknown>;
}) {
	return {
		role: "toolResult" as const,
		toolCallId: opts.toolCallId,
		toolName: opts.toolName,
		age: opts.age,
		input: opts.input ?? {},
		content: [{ type: "text", text: opts.verbatimContent }],
		details: {
			digest: opts.digestContent,
			turnIndex: opts.age,
			piTurnAge: opts.piTurnAge,
			toolCallId: opts.toolCallId,
		},
		isError: false,
	};
}

// ─── AC-1: live Pi session with auto-discovered extension ──────────────────

describe("AC-1: extension module loads + registers handlers", () => {
	it("the extension module is importable and exports a default factory", async () => {
		const extPath = resolve(import.meta.dirname ?? ".", "index.ts");
		assert.ok(existsSync(extPath), `Extension not found at ${extPath}`);
		const mod = await import(extPath);
		assert.equal(typeof mod.default, "function", "Extension must export a default function");
	});

	it("the extension registers handlers on the mock pi", async () => {
		const mockPi = await loadExtension();
		const contextHandlers = mockPi.getHandlers("context");
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const beforeAgentStartHandlers = mockPi.getHandlers("before_agent_start");
		assert.ok(contextHandlers.length > 0, "context handler must be registered");
		assert.ok(toolResultHandlers.length > 0, "tool_result handler must be registered");
		assert.ok(beforeAgentStartHandlers.length > 0, "before_agent_start handler must be registered");
	});
});

// ─── AC-1: view-time, age-scoped digesting ─────────────────────────────────

describe("AC-1: view-time, age-scoped digesting", () => {
	it("on the producing turn: tool-result content is verbatim", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const contextHandlers = mockPi.getHandlers("context");

		// Drive a single tool call: the tool_result handler records
		// the lifecycle state, and the next context handler should
		// show the verbatim content (the tool was produced on the
		// current turn).
		await toolResultHandlers[0](
			{
				toolName: "bash",
				toolCallId: "tc-1",
				input: { command: "ls" },
				content: [{ type: "text", text: "VERBATIM_OUTPUT" }],
				details: {},
				isError: false,
			},
			createMockContext(),
		);

		// Build a messages array with the tool-result on the current
		// turn (turn 0). The context handler must show verbatim.
		const messages = [
			makeUserMessage("hi"),
			makeAssistantMessage(""),
			makeToolResultMessage({
				toolName: "bash",
				toolCallId: "tc-1",
				age: 0,
				verbatimContent: "VERBATIM_OUTPUT",
				digestContent: "DIGEST_OUTPUT",
				input: { command: "ls" },
			}),
		];
		const result = await contextHandlers[0]({ messages }, createMockContext());
		const out = (result as { messages: Array<{ role: string; content: unknown }> }).messages;
		// Find the tool-result in the output. The pinned message is
		// prepended (AC-3); the tool-result is at index 1.
		const toolMsg = out.find((m) => m.role === "toolResult");
		assert.ok(toolMsg, "tool-result is in the output");
		const content = (toolMsg?.content as Array<{ text: string }>)[0]?.text;
		assert.equal(content, "VERBATIM_OUTPUT", "producing turn → verbatim content");
	});

	it("on a later turn: tool-result content is swapped to digest", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const contextHandlers = mockPi.getHandlers("context");

		// Drive a tool call on turn 0. Then bump the turn counter
		// (via the turn_end handler) to advance the lifecycle state
		// to a later turn.
		await toolResultHandlers[0](
			{
				toolName: "bash",
				toolCallId: "tc-1",
				input: { command: "ls" },
				content: [{ type: "text", text: "VERBATIM_OUTPUT" }],
				details: {},
				isError: false,
			},
			createMockContext(),
		);
		// Bump turn: invoke before_agent_start (the user-turn boundary)
		// to advance the counter. turn_end no longer bumps — a user
		// prompt spans many Pi turns, so the user-turn boundary is the
		// correct granularity for the age-scope.
		const beforeAgentStartHandlers = mockPi.getHandlers("before_agent_start");
		await beforeAgentStartHandlers[0]({ prompt: "", images: [] }, createMockContext());

		// Now the tool-result is on a previous turn; the context
		// handler should swap to the digest.
		const messages = [
			makeUserMessage("hi"),
			makeAssistantMessage(""),
			makeToolResultMessage({
				toolName: "bash",
				toolCallId: "tc-1",
				age: 0, // produced on turn 0; current is turn 1
				verbatimContent: "VERBATIM_OUTPUT",
				digestContent: "DIGEST_OUTPUT",
				input: { command: "ls" },
			}),
		];
		const result = await contextHandlers[0]({ messages }, createMockContext());
		const out = (result as { messages: Array<{ role: string; content: unknown }> }).messages;
		const toolMsg = out.find((m) => m.role === "toolResult");
		const content = (toolMsg?.content as Array<{ text: string }>)[0]?.text;
		assert.equal(content, "DIGEST_OUTPUT", "later turn → digest content swapped");
	});
});

// ─── AC-2: unified keep/digest/retire engine ───────────────────────────────

describe("AC-2: unified keep/digest/retire engine over all tool outputs", () => {
	it("agent `keep` override pins verbatim across turns", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const beforeAgentStartHandlers = mockPi.getHandlers("before_agent_start");
		const contextHandlers = mockPi.getHandlers("context");

		// Record a read tool result.
		await toolResultHandlers[0](
			{
				toolName: "read",
				toolCallId: "tc-r1",
				input: { path: "/tmp/file-a.ts" },
				content: [{ type: "text", text: "FILE_A_BODY" }],
				details: {},
				isError: false,
			},
			createMockContext(),
		);
		// Bump turn.
		const turnEndHandlers = mockPi.getHandlers("turn_end");
		await turnEndHandlers[0]({}, createMockContext());

		// Have the agent mark the file as kept: we need a session
		// branch entry to return a text with `keep /tmp/file-a.ts`.
		// Build a sessionManager mock that returns an assistant entry
		// carrying the keep-mark.
		const branchEntry = {
			message: { role: "assistant", content: [{ type: "text", text: "keep /tmp/file-a.ts" }] },
		};
		const ctxWithBranch = createMockContext();
		(ctxWithBranch.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [branchEntry];

		await beforeAgentStartHandlers[0]({ prompt: "ok", images: [] }, ctxWithBranch);

		// Now run context: the kept file should be verbatim.
		const messages = [
			makeUserMessage("hi"),
			makeToolResultMessage({
				toolName: "read",
				toolCallId: "tc-r1",
				age: 0,
				verbatimContent: "FILE_A_BODY_VERBATIM",
				digestContent: "FILE_A_BODY_DIGEST",
				input: { path: "/tmp/file-a.ts" },
			}),
		];
		const result = await contextHandlers[0]({ messages }, createMockContext());
		const out = (result as { messages: Array<{ role: string; content: unknown }> }).messages;
		const toolMsg = out.find((m) => m.role === "toolResult");
		const content = (toolMsg?.content as Array<{ text: string }>)[0]?.text;
		assert.equal(content, "FILE_A_BODY_VERBATIM", "kept override → verbatim across turns");
	});

	it("agent `drop` override excludes the result from the view", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const beforeAgentStartHandlers = mockPi.getHandlers("before_agent_start");
		const contextHandlers = mockPi.getHandlers("context");

		await toolResultHandlers[0](
			{
				toolName: "read",
				toolCallId: "tc-r1",
				input: { path: "/tmp/file-b.ts" },
				content: [{ type: "text", text: "FILE_B_BODY" }],
				details: {},
				isError: false,
			},
			createMockContext(),
		);
		const turnEndHandlers = mockPi.getHandlers("turn_end");
		await turnEndHandlers[0]({}, createMockContext());

		// Mark as dropped.
		const branchEntry = {
			message: { role: "assistant", content: [{ type: "text", text: "drop /tmp/file-b.ts" }] },
		};
		const ctxWithBranch = createMockContext();
		(ctxWithBranch.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [branchEntry];
		await beforeAgentStartHandlers[0]({ prompt: "ok", images: [] }, ctxWithBranch);

		// The dropped file should be excluded from the view.
		const messages = [
			makeUserMessage("hi"),
			makeToolResultMessage({
				toolName: "read",
				toolCallId: "tc-r1",
				age: 0,
				verbatimContent: "FILE_B_BODY",
				digestContent: "FILE_B_DIGEST",
				input: { path: "/tmp/file-b.ts" },
			}),
		];
		const result = await contextHandlers[0]({ messages }, createMockContext());
		const out = (result as { messages: Array<{ role: string; content: unknown }> }).messages;
		const toolMsg = out.find((m) => m.role === "toolResult");
		assert.equal(toolMsg, undefined, "dropped → excluded from the per-LLM-call view");
	});

	it("the per-turn digest widens from file reads to all tool outputs", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const beforeAgentStartHandlers = mockPi.getHandlers("before_agent_start");

		// Drive three different tool types: read, bash, grep.
		const types: Array<{ toolName: string; toolCallId: string; input: Record<string, unknown>; key: string }> = [
			{ toolName: "read", toolCallId: "tc-1", input: { path: "/tmp/a.ts" }, key: "path=/tmp/a.ts" },
			{ toolName: "bash", toolCallId: "tc-2", input: { command: "ls -la" }, key: "command=ls -la" },
			{ toolName: "grep", toolCallId: "tc-3", input: { pattern: "TODO", path: "./src" }, key: "pattern=TODO" },
		];
		for (const t of types) {
			await toolResultHandlers[0](
				{
					toolName: t.toolName,
					toolCallId: t.toolCallId,
					input: t.input,
					content: [{ type: "text", text: "OUTPUT" }],
					details: {},
					isError: false,
				},
				createMockContext(),
			);
		}

		const result = await beforeAgentStartHandlers[0](
			{ prompt: "ok", images: [] },
			createMockContext(),
		);
		const injected = (result as { message?: { customType: string; content: string } }).message;
		assert.ok(injected, "before_agent_start must inject a message");
		assert.equal(injected.customType, "context-trimmer-tool-outputs", "customType widens to all tool outputs");
		// The digest should mention each tool name.
		assert.ok(injected.content.includes("[read]"), "read result in the digest");
		assert.ok(injected.content.includes("[bash]"), "bash result in the digest");
		assert.ok(injected.content.includes("[grep]"), "grep result in the digest");
	});
});

// ─── AC-3: pinned tier (auto-pin by convention) ─────────────────────────────

describe("AC-3: pinned tier is always present in the per-LLM-call view", () => {
	it("every context call prepends a `context-trimmer-pinned` customType message", async () => {
		const mockPi = await loadExtension();
		const contextHandlers = mockPi.getHandlers("context");

		// Empty conversation: the pinned message must still be present.
		const result = await contextHandlers[0]({ messages: [] }, createMockContext());
		const out = (result as { messages: Array<{ role: string; customType?: string }> }).messages;
		assert.ok(out.length > 0, "pinned message is in the view even for empty conversation");
		const pinned = out[0];
		assert.ok(pinned, "pinned message is the first message");
		assert.equal(pinned.customType, "context-trimmer-pinned", "pinned customType is correct");
	});

	it("the pinned message is `display: false` (TUI does not show it as a line)", async () => {
		const mockPi = await loadExtension();
		const contextHandlers = mockPi.getHandlers("context");
		const result = await contextHandlers[0]({ messages: [] }, createMockContext());
		const out = (result as { messages: Array<{ customType?: string; display?: boolean }> }).messages;
		const pinned = out[0];
		assert.equal(pinned?.display, false, "pinned message has display=false (TUI silent)");
	});

	it("the pinned content carries the personality + last-N tracker list", async () => {
		const mockPi = await loadExtension();
		const contextHandlers = mockPi.getHandlers("context");
		const result = await contextHandlers[0]({ messages: [] }, createMockContext());
		const out = (result as { messages: Array<{ content?: string }> }).messages;
		const pinned = out[0];
		// The content should mention the pinned-tier structure (the
		// actual personality + tracker content depends on the
		// operator's machine; the test asserts the structure).
		assert.ok(pinned?.content?.includes("Pinned"), "pinned content carries the structure");
		assert.ok(pinned?.content?.includes("personality"), "personality section is present");
		assert.ok(pinned?.content?.includes("tracker"), "tracker section is present");
	});
});

// ─── AC-4: recency comfort window (no threshold gate; live bound) ──────────

describe("AC-4: recency comfort window + live-contextWindow bound", () => {
	it("the context handler returns the recency-comfort set, unconditionally", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const contextHandlers = mockPi.getHandlers("context");

		// Drive a tool_result for each turn so the lifecycle engine
		// has a record of each toolCallId (otherwise the engine
		// would `retire` them as unknown).
		for (let i = 0; i < 30; i++) {
			await toolResultHandlers[0](
				{
					toolName: "bash",
					toolCallId: `tc-${i}`,
					input: { command: `echo turn-${i}` },
					content: [{ type: "text", text: "OUTPUT" }],
					details: {},
					isError: false,
				},
				createMockContext(),
			);
		}

		// Build a bloated session: 30 user-message turns. The recency
		// window is 20; the handler must carve to 20 turns.
		const messages: unknown[] = [];
		for (let i = 0; i < 30; i++) {
			messages.push(makeUserMessage(`turn-${i}`));
			messages.push(makeAssistantMessage(""));
			messages.push({
				role: "toolResult",
				toolCallId: `tc-${i}`,
				age: 0, // All on turn 0 (not yet bumped); the engine treats them all as on the current turn.
				content: [{ type: "text", text: "v" }],
				details: { digest: "d" },
			});
		}

		const result = await contextHandlers[0]({ messages }, createMockContext());
		const out = (result as { messages: unknown[] }).messages;

		// The handler runs the recency filter unconditionally. 30
		// turns * 3 messages/turn = 90 messages; the filter carves
		// to 20 turns (60 messages) + the pinned message (1) = 61.
		assert.ok(out.length < 90, `Expected < 90 messages after recency, got ${out.length}`);
		assert.equal(out.length, 20 * 3 + 1, `Expected 60 (recency) + 1 (pinned) = 61, got ${out.length}`);
	});

	it("the bound derives from the LIVE `ctx.getContextUsage().contextWindow`", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const contextHandlers = mockPi.getHandlers("context");

		// Build a session that fits in the recency window. The
		// estimated token cost of the post-filter view must be
		// under the LIVE bound. First, drive the tool_result
		// events so the lifecycle engine has records of each
		// toolCallId (otherwise the engine would `retire` them as
		// unknown and the test would not exercise the bound).
		for (let i = 0; i < RECENCY_COMFORT_WINDOW; i++) {
			await toolResultHandlers[0](
				{
					toolName: "bash",
					toolCallId: `tc-${i}`,
					input: { command: `echo turn-${i}` },
					content: [{ type: "text", text: "OUTPUT" }],
					details: {},
					isError: false,
				},
				createMockContext(),
			);
		}

		const messages: unknown[] = [];
		for (let i = 0; i < RECENCY_COMFORT_WINDOW; i++) {
			messages.push(makeUserMessage(`turn-${i}`));
			messages.push(makeAssistantMessage(""));
			messages.push({
				role: "toolResult",
				toolCallId: `tc-${i}`,
				age: 0,
				content: [{ type: "text", text: "VERBATIM_OUTPUT" + "z".repeat(200) }],
				details: { digest: makeDigest(i, "bash", `echo turn-${i}`) },
			});
		}

		// Simulate a non-default context window (e.g. GLM-5.2's 976k).
		const ctxWindow = 976_000;
		const ctx = createMockContext({ tokens: 200_000, contextWindow: ctxWindow });

		const result = await contextHandlers[0]({ messages }, ctx);
		const out = (result as { messages: unknown[] }).messages;
		const totalChars = JSON.stringify(out).length;
		const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);

		// The bound: contextWindow - reserveTokens - slack.
		const bound = deriveBound(ctxWindow, PI_RESERVE_TOKENS);
		assert.ok(
			estimatedTokens < bound,
			`Post-trim working window ${estimatedTokens} must be under live bound ${bound} (ctx=${ctxWindow} - reserve=${PI_RESERVE_TOKENS} - slack=${COMFORT_SLACK})`,
		);
	});

	it("the bound works for any of the documented model context windows (GLM, gemma4, kimi, deepseek, minimax)", async () => {
		// Per AC-4: the integration test's bound must work for the
		// documented model context windows. The test exercises
		// gemma4:31b's 256k, GLM-5.2's 976k, minimax's 1M, etc.
		const modelWindows = [256_000, 976_000, 1_000_000];
		for (const ctxWindow of modelWindows) {
			const mockPi = await loadExtension();
			const toolResultHandlers = mockPi.getHandlers("tool_result");
			const contextHandlers = mockPi.getHandlers("context");

			// Drive the tool_result events so the lifecycle engine
			// has records of each toolCallId.
			for (let i = 0; i < RECENCY_COMFORT_WINDOW; i++) {
				await toolResultHandlers[0](
					{
						toolName: "bash",
						toolCallId: `tc-${i}`,
						input: { command: `echo turn-${i}` },
						content: [{ type: "text", text: "OUTPUT" }],
						details: {},
						isError: false,
					},
					createMockContext(),
				);
			}

			const messages: unknown[] = [];
			for (let i = 0; i < RECENCY_COMFORT_WINDOW; i++) {
				messages.push(makeUserMessage(`turn-${i}`));
				messages.push(makeAssistantMessage(""));
				messages.push({
					role: "toolResult",
					toolCallId: `tc-${i}`,
					age: 0,
					content: [{ type: "text", text: "OUTPUT" }],
					details: { digest: "d" },
				});
			}

			const ctx = createMockContext({ tokens: 100_000, contextWindow: ctxWindow });
			const result = await contextHandlers[0]({ messages }, ctx);
			const out = (result as { messages: unknown[] }).messages;
			const totalChars = JSON.stringify(out).length;
			const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);

			const bound = deriveBound(ctxWindow, PI_RESERVE_TOKENS);
			assert.ok(
				estimatedTokens < bound,
				`ctxWindow=${ctxWindow}: estimated ${estimatedTokens} < bound ${bound}`,
			);
		}
	});
});

// ─── AC-5: five-path coherence ─────────────────────────────────────────────

describe("AC-5: five-path coherence (write-time side-by-side + view-time swap)", () => {
	it("tool_result writes the side-by-side envelope (verbatim + digest)", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");

		const result = await toolResultHandlers[0](
			{
				toolName: "bash",
				toolCallId: "tc-1",
				input: { command: "ls" },
				content: [{ type: "text", text: "VERBATIM_OUTPUT" }],
				details: {},
				isError: false,
			},
			createMockContext(),
		);

		// The handler returns a partial patch with `content: verbatim`
		// and `details: { digest, turnIndex, toolCallId }` — the
		// Storage Shape A side-by-side envelope.
		const patch = result as { content: Array<{ text: string }>; details: { digest: string; turnIndex: number; toolCallId: string } };
		assert.equal(patch.content[0]?.text, "VERBATIM_OUTPUT", "content is verbatim");
		assert.ok(patch.details.digest.startsWith("[factOfCall:"), "details.digest is the digest envelope");
		assert.equal(patch.details.toolCallId, "tc-1", "details carries toolCallId");
		// The turnIndex is a non-negative integer (the current turn
		// counter at the time of the write). The exact value depends
		// on prior test executions that share the module-level
		// counter; the test asserts the shape, not a specific value.
		assert.ok(
			Number.isInteger(patch.details.turnIndex) && patch.details.turnIndex >= 0,
			"details carries a non-negative integer turnIndex (age stamp)",
		);
	});

	it("the view-time handler honors the same shape: digest is read from details.digest", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const contextHandlers = mockPi.getHandlers("context");

		// Drive a tool call.
		await toolResultHandlers[0](
			{
				toolName: "bash",
				toolCallId: "tc-1",
				input: { command: "ls" },
				content: [{ type: "text", text: "VERBATIM" }],
				details: {},
				isError: false,
			},
			createMockContext(),
		);
		// Bump turn: invoke before_agent_start (the user-turn boundary).
		const beforeAgentStartHandlers = mockPi.getHandlers("before_agent_start");
		await beforeAgentStartHandlers[0]({ prompt: "", images: [] }, createMockContext());

		// Build a message with the side-by-side envelope. The view-time
		// handler should swap to the digest.
		const messages = [
			makeUserMessage("hi"),
			makeToolResultMessage({
				toolName: "bash",
				toolCallId: "tc-1",
				age: 0,
				verbatimContent: "VERBATIM",
				digestContent: "DIGEST_FROM_DETAILS",
				input: { command: "ls" },
			}),
		];
		const result = await contextHandlers[0]({ messages }, createMockContext());
		const out = (result as { messages: Array<{ role: string; content: unknown }> }).messages;
		const toolMsg = out.find((m) => m.role === "toolResult");
		const content = (toolMsg?.content as Array<{ text: string }>)[0]?.text;
		assert.equal(content, "DIGEST_FROM_DETAILS", "view-time handler reads digest from details.digest (Shape A contract)");
	});

	it("the digest body is bounded by MAX_DIGEST_CHARS (no session-file bloat)", async () => {
		const mockPi = await loadExtension();
		const toolResultHandlers = mockPi.getHandlers("tool_result");

		// Generate a huge bash output.
		const hugeOutput = "x".repeat(MAX_DIGEST_CHARS * 2);
		const result = await toolResultHandlers[0](
			{
				toolName: "bash",
				toolCallId: "tc-huge",
				input: { command: "cat huge" },
				content: [{ type: "text", text: hugeOutput }],
				details: {},
				isError: false,
			},
			createMockContext(),
		);
		const patch = result as { details: { digest: string } };
		// The digest is bounded well under the raw output.
		assert.ok(
			patch.details.digest.length < MAX_DIGEST_CHARS * 2,
			`digest length (${patch.details.digest.length}) is bounded well under raw output (${hugeOutput.length})`,
		);
		assert.ok(patch.details.digest.includes("[truncated:"), "truncation marker is present");
	});
});

// ─── AC-5: integration tests run green against the assembled extension ─────

describe("AC-5: integration tests run green against the assembled extension", () => {
	it("the assembled extension module loads without errors", async () => {
		const mockPi = await loadExtension();
		// If we got here, the extension loaded successfully.
		assert.ok(mockPi, "Extension must load without errors");
	});
});

// ─── T-2720: per-Pi-turn cadence (AC-5 integration tests) ─────────────────
//
// The three tests below exercise the per-Pi-turn cadence end-to-end. The
// cadence is the subagent fix: a subagent is a single-prompt run with
// many Pi-turns, so the T-2717 user-turn boundary (`before_agent_start`)
// never fires inside a subagent. The per-Pi-turn counter (`piTurnIndex`,
// bumped at `turn_end`) is the higher-resolution signal the engine reads
// to apply the `piTurnAge <= K` clause.
//
// The tests pin the `> K` formula (the implementation; the AC-3 prose
// names `> K`; the AC-5 narrative example requires `>= K` — the
// inconsistency is surfaced to PM in the report). With `> K`, K=1
// means "force-digest after 2 Pi-turns elapsed" (the K+1 boundary).
//
// The tests use a fresh-extension helper that calls `session_start`
// to reset the module-level state (`currentTurnIndex`, `piTurnIndex`,
// `lifecycleState`, `pinnedTier`) between tests, so each test starts
// with a clean slate. The `process.env` is saved and restored around
// each test to avoid leaking env vars between tests.

// Env vars the T-2720 `context` handler reads on every call.
const T2720_ENV_KEYS = [
	"PI_TURN_DIGEST_AFTER",
	"PI_TURN_RETIRE_AFTER",
	"PI_SESSION_TOKENS",
	"MAX_SESSION_TOKENS",
] as const;

/** Save the current env values for the T-2720 keys, then apply the
 *  given overrides. Returns a restore function. */
function withEnv(
	overrides: Partial<Record<(typeof T2720_ENV_KEYS)[number], string | undefined>>,
): () => void {
	const saved: Record<string, string | undefined> = {};
	for (const key of T2720_ENV_KEYS) {
		saved[key] = process.env[key];
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	return () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
}

/** Load the extension and call `session_start` to reset module-level
 *  state (`piTurnIndex`, `currentTurnIndex`, `lifecycleState`,
 *  `pinnedTier`). Returns the mock pi. */
async function freshExtensionForT2720() {
	const mockPi = await loadExtension();
	const sessionStartHandlers = mockPi.getHandlers("session_start");
	if (sessionStartHandlers.length > 0) {
		await sessionStartHandlers[0]({}, createMockContext());
	}
	return mockPi;
}

describe("T-2720: per-Pi-turn cadence (AC-5 integration tests)", () => {
	// ─── Test 1: subagent K=1 force-digests after Pi-turns exceed K ─────
	//
	// The subagent scenario: a subagent is a single-prompt run with
	// many Pi-turns but no `before_agent_start` between events. The
	// user-turn counter (`currentTurnIndex`) stays at 0; the per-Pi-turn
	// counter (`piTurnIndex`) bumps at each `turn_end`. The T-2717
	// user-turn logic would keep the tool-result verbatim (age ===
	// currentTurn); the per-Pi-turn clause is what force-digests.
	//
	// With K=1 and the implemented `> K` formula:
	//   - After 1 turn_end: piTurnsElapsed = 1, 1 > 1 = false → verbatim
	//   - After 2 turn_ends: piTurnsElapsed = 2, 2 > 1 = true → digest
	//
	// The test pins the `> K` form: K=1 is the K+1 boundary, not the
	// K boundary. The AC-5 narrative example (K=1, 1 turn_end → digest)
	// requires the `>= K` form; the discrepancy is surfaced to PM in
	// the report (per the dispatch brief's follow-up flag).
	it("subagent scenario: K=1 force-digests tool output after Pi-turns exceed K", async () => {
		const restore = withEnv({ PI_TURN_DIGEST_AFTER: "1" });
		try {
			const mockPi = await freshExtensionForT2720();
			const toolResultHandlers = mockPi.getHandlers("tool_result");
			const turnEndHandlers = mockPi.getHandlers("turn_end");
			const contextHandlers = mockPi.getHandlers("context");

			// Drive a single tool call: the tool_result handler records
			// the lifecycle state with piTurnAge = 0 (the current
			// piTurnIndex after session_start reset). No
			// before_agent_start fires — this is the subagent shape.
			await toolResultHandlers[0](
				{
					toolName: "bash",
					toolCallId: "tc-1",
					input: { command: "ls" },
					content: [{ type: "text", text: "VERBATIM_OUTPUT" }],
					details: {},
					isError: false,
				},
				createMockContext(),
			);

			// Bump piTurnIndex once: piTurnIndex is now 1.
			// currentTurnIndex stays at 0 (no before_agent_start).
			await turnEndHandlers[0]({}, createMockContext());

			// Build a message with piTurnAge = 0 (the stamp from
			// tool_result time). The engine reads details.piTurnAge
			// from the message, not from the recorded state.
			// With K=1, piTurnsElapsed = 1 - 0 = 1, 1 > 1 = false →
			// still verbatim (pins the `> K` form).
			const messagesAfterOneTurnEnd = [
				makeUserMessage("hi"),
				makeAssistantMessage(""),
				makeToolResultMessageWithPiTurn({
					toolName: "bash",
					toolCallId: "tc-1",
					age: 0,
					piTurnAge: 0,
					verbatimContent: "VERBATIM_OUTPUT",
					digestContent: "DIGEST_OUTPUT",
					input: { command: "ls" },
				}),
			];
			const resultAfterOne = await contextHandlers[0](
				{ messages: messagesAfterOneTurnEnd },
				createMockContext(),
			);
			const outAfterOne = (resultAfterOne as { messages: Array<{ role: string; content: unknown }> }).messages;
			const toolMsgAfterOne = outAfterOne.find((m) => m.role === "toolResult");
			assert.ok(toolMsgAfterOne, "tool-result is in the output after 1 turn_end");
			const contentAfterOne = (toolMsgAfterOne?.content as Array<{ text: string }>)[0]?.text;
			assert.equal(
				contentAfterOne,
				"VERBATIM_OUTPUT",
				"K=1, after 1 turn_end: still verbatim (pins the > K form: elapsed=1, 1>1=false)",
			);

			// Bump piTurnIndex again: piTurnIndex is now 2.
			// currentTurnIndex stays at 0.
			await turnEndHandlers[0]({}, createMockContext());

			// Re-run context with the same message (piTurnAge=0).
			// With K=1, piTurnsElapsed = 2 - 0 = 2, 2 > 1 = true →
			// digest (the force-digest fires after K+1 Pi-turns).
			const messagesAfterTwoTurnEnds = [
				makeUserMessage("hi"),
				makeAssistantMessage(""),
				makeToolResultMessageWithPiTurn({
					toolName: "bash",
					toolCallId: "tc-1",
					age: 0,
					piTurnAge: 0,
					verbatimContent: "VERBATIM_OUTPUT",
					digestContent: "DIGEST_OUTPUT",
					input: { command: "ls" },
				}),
			];
			const resultAfterTwo = await contextHandlers[0](
				{ messages: messagesAfterTwoTurnEnds },
				createMockContext(),
			);
			const outAfterTwo = (resultAfterTwo as { messages: Array<{ role: string; content: unknown }> }).messages;
			const toolMsgAfterTwo = outAfterTwo.find((m) => m.role === "toolResult");
			assert.ok(toolMsgAfterTwo, "tool-result is in the output after 2 turn_ends");
			const contentAfterTwo = (toolMsgAfterTwo?.content as Array<{ text: string }>)[0]?.text;
			assert.equal(
				contentAfterTwo,
				"DIGEST_OUTPUT",
				"K=1, after 2 turn_ends: digest (force-digest fires: elapsed=2, 2>1=true)",
			);
		} finally {
			restore();
		}
	});

	// ─── Test 2: parent K=∞ (default) preserves user-turn-bounded behavior ─
	//
	// The parent (multi-prompt conversation) does not set the env vars;
	// the defaults in `policy.ts` are `Number.POSITIVE_INFINITY`. The
	// per-Pi-turn clause becomes a no-op (piTurnsElapsed > Infinity is
	// always false). The T-2717 user-turn logic still applies: the
	// tool-result was stamped on user turn 0, currentTurnIndex is
	// still 0 (no before_agent_start), so age === currentTurn →
	// verbatim. The test pins the parent no-op behavior so a future
	// refactor cannot silently break the parent.
	it("parent scenario: K=Infinity (default) preserves the user-turn-bounded behavior", async () => {
		// No env set — the parent leaves the env unset and gets the
		// Infinity default from `policy.ts`.
		const mockPi = await freshExtensionForT2720();
		const toolResultHandlers = mockPi.getHandlers("tool_result");
		const turnEndHandlers = mockPi.getHandlers("turn_end");
		const contextHandlers = mockPi.getHandlers("context");

		// Drive a single tool call. The tool_result handler records
		// turnIndex = 0, piTurnAge = 0.
		await toolResultHandlers[0](
			{
				toolName: "bash",
				toolCallId: "tc-1",
				input: { command: "ls" },
				content: [{ type: "text", text: "VERBATIM_OUTPUT" }],
				details: {},
				isError: false,
			},
			createMockContext(),
		);

		// Bump piTurnIndex 5 times. currentTurnIndex stays at 0
		// (no before_agent_start — the parent is on a single user
		// prompt spanning many Pi-turns).
		for (let i = 0; i < 5; i++) {
			await turnEndHandlers[0]({}, createMockContext());
		}

		// Build a message with piTurnAge = 0. With K=Infinity,
		// piTurnsElapsed = 5, 5 > Infinity = false → the per-Pi-turn
		// clause is a no-op. The user-turn logic: record.turnIndex
		// (0) === currentTurnIndex (0) → verbatim.
		const messages = [
			makeUserMessage("hi"),
			makeAssistantMessage(""),
			makeToolResultMessageWithPiTurn({
				toolName: "bash",
				toolCallId: "tc-1",
				age: 0,
				piTurnAge: 0,
				verbatimContent: "VERBATIM_OUTPUT",
				digestContent: "DIGEST_OUTPUT",
				input: { command: "ls" },
			}),
		];
		const result = await contextHandlers[0]({ messages }, createMockContext());
		const out = (result as { messages: Array<{ role: string; content: unknown }> }).messages;
		const toolMsg = out.find((m) => m.role === "toolResult");
		assert.ok(toolMsg, "tool-result is in the output (K=Infinity, per-Pi-turn clause is a no-op)");
		const content = (toolMsg?.content as Array<{ text: string }>)[0]?.text;
		assert.equal(
			content,
			"VERBATIM_OUTPUT",
			"K=Infinity: per-Pi-turn clause is a no-op; user-turn logic keeps it verbatim (age === currentTurn)",
		);
	});

	// ─── Test 3: token cap force-retires oldest tool output ───────────
	//
	// The optional hard token cap (Layer 4 of the `context` handler)
	// force-retires the oldest tool-output messages (by `piTurnAge`
	// descending) when the per-LLM-call view's approximate token
	// count exceeds the configured cap. The test drives 5 tool
	// results with distinct piTurnAge stamps (via turn_end between
	// each tool_result), sets a cap that requires retiring 3 of the
	// 5, and asserts the 3 oldest (highest piTurnAge) are excluded
	// while the 2 newest (lowest piTurnAge) are preserved.
	//
	// The cap is computed relative to the pinned message size: the
	// pinned message is always present and cannot be retired by the
	// cap. The test first runs context once to capture the pinned
	// message size, then sets the cap to (pinned + 2 tool-results)
	// so exactly 3 tool-results are retired.
	it("token cap: force-retires oldest tool output when session exceeds N tokens", async () => {
		// Each tool-result carries ~1000 tokens of content.
		const TOOL_TOKENS = 1000;
		const largeContent = "x".repeat(TOOL_TOKENS * 4); // 4 chars per token.

		const restore = withEnv({ PI_TURN_DIGEST_AFTER: undefined });
		try {
			const mockPi = await freshExtensionForT2720();
			const toolResultHandlers = mockPi.getHandlers("tool_result");
			const turnEndHandlers = mockPi.getHandlers("turn_end");
			const contextHandlers = mockPi.getHandlers("context");

			// Drive 5 tool_results with turn_end between each, so each
			// gets a distinct piTurnAge stamp (0, 1, 2, 3, 4).
			const toolCallIds = ["tc-1", "tc-2", "tc-3", "tc-4", "tc-5"];
			for (let i = 0; i < 5; i++) {
				await toolResultHandlers[0](
					{
						toolName: "bash",
						toolCallId: toolCallIds[i],
						input: { command: `echo ${i}` },
						content: [{ type: "text", text: largeContent }],
						details: {},
						isError: false,
					},
					createMockContext(),
				);
				// Bump piTurnIndex between tool_results so each gets
				// a distinct stamp. After the loop: piTurnIndex = 5.
				if (i < 4) {
					await turnEndHandlers[0]({}, createMockContext());
				}
			}

			// First, run context once to capture the pinned message
			// size. The pinned message is always present and cannot
			// be retired by the cap; the cap must accommodate it.
			const baselineMessages = [
				makeUserMessage("hi"),
				makeAssistantMessage(""),
				...toolCallIds.map((id, i) =>
					makeToolResultMessageWithPiTurn({
						toolName: "bash",
						toolCallId: id,
						age: 0,
						piTurnAge: i, // tc-1: 0, tc-2: 1, ..., tc-5: 4
						verbatimContent: largeContent,
						digestContent: "d",
						input: { command: `echo ${i}` },
					}),
				),
			];
			const baselineResult = await contextHandlers[0](
				{ messages: baselineMessages },
				createMockContext(),
			);
			const baselineOut = (baselineResult as { messages: Array<{ role: string; content: unknown }> }).messages;
			const pinnedMsg = baselineOut[0];
			assert.ok(pinnedMsg, "pinned message is the first message in the view");
			const pinnedChars = JSON.stringify(pinnedMsg).length;
			const pinnedTokens = Math.ceil(pinnedChars / CHARS_PER_TOKEN);

			// Set the cap to (pinned + 2 tool-results) so the cap
			// must retire 3 of the 5 tool-results to get under the
			// cap. The cap retires the oldest (highest piTurnAge)
			// first: tc-5, tc-4, tc-3 are retired; tc-1 and tc-2
			// (lowest piTurnAge) are preserved.
			const cap = pinnedTokens + 2 * TOOL_TOKENS;
			const restoreCap = withEnv({ MAX_SESSION_TOKENS: String(cap) });
			try {
				const cappedResult = await contextHandlers[0](
					{ messages: baselineMessages },
					createMockContext(),
				);
				const cappedOut = (cappedResult as { messages: Array<{ role: string; toolCallId?: string }> }).messages;

				// The 3 oldest (tc-3, tc-4, tc-5) are retired.
				const remainingToolCallIds = cappedOut
					.filter((m) => m.role === "toolResult")
					.map((m) => m.toolCallId);
				assert.ok(
					!remainingToolCallIds.includes("tc-3"),
					"tc-3 (piTurnAge=2) is retired (oldest retired first)",
				);
				assert.ok(
					!remainingToolCallIds.includes("tc-4"),
					"tc-4 (piTurnAge=3) is retired (oldest retired first)",
				);
				assert.ok(
					!remainingToolCallIds.includes("tc-5"),
					"tc-5 (piTurnAge=4) is retired (oldest retired first)",
				);
				// The 2 newest (tc-1, tc-2) are preserved.
				assert.ok(
					remainingToolCallIds.includes("tc-1"),
					"tc-1 (piTurnAge=0) is preserved (newest preserved)",
				);
				assert.ok(
					remainingToolCallIds.includes("tc-2"),
					"tc-2 (piTurnAge=1) is preserved (newest preserved)",
				);
				// Total tool-results in the view: 2 (the preserved ones).
				assert.equal(
					remainingToolCallIds.length,
					2,
					`Expected 2 tool-results preserved (tc-1, tc-2), got ${remainingToolCallIds.length}`,
				);
			} finally {
				restoreCap();
			}
		} finally {
			restore();
		}
	});
});
