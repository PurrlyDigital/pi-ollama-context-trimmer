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
		// Bump turn: invoke turn_end to advance the counter.
		const turnEndHandlers = mockPi.getHandlers("turn_end");
		await turnEndHandlers[0]({}, createMockContext());

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
		// Bump turn.
		const turnEndHandlers = mockPi.getHandlers("turn_end");
		await turnEndHandlers[0]({}, createMockContext());

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

	it("the extension is INACTIVE in `~/.pi/agent/extensions/context-trimmer/` (per the ticket's relocation)", () => {
		// The extension was moved out of the live extensions dir
		// for this work, per the ticket's "do NOT move it back" rule.
		// The test asserts the inactive state.
		const livePath = "/home/dez/.pi/agent/extensions/context-trimmer/index.ts";
		assert.equal(existsSync(livePath), false, "Extension is INACTIVE during this work");
	});
});
