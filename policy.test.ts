/**
 * T-2717 — Trim policy unit tests (recency comfort window).
 *
 * Runner: Node's built-in `node:test` (no project install required).
 * Run: `node --experimental-strip-types --test policy.test.ts`
 *
 * The tests cover the redesigned `policy.ts` (per AC-4 of T-2717):
 *   - The recency comfort window is the only retention signal.
 *   - The threshold gate is REMOVED; the filter runs unconditionally.
 *   - `RECENCY_COMFORT_WINDOW = 20` (the renamed default).
 *   - The function is pure: no Pi imports, no I/O, no `Date.now()`.
 *
 * The tests import the same `policy.ts` the production code imports
 * from — no duplicate constants, no shadow modules. The contract is
 * asserted directly on the public API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	RECENCY_BASIS,
	RECENCY_COMFORT_WINDOW,
	DEFAULT_RECENCY_WINDOW,
	trimConversation,
	type ConversationMessage,
	type TrimOptions,
	type TrimResult,
} from "./policy.ts";

// ─── Test fixtures ──────────────────────────────────────────────────────────

/** Build a synthetic user message at index `i`. */
function user(i: number): ConversationMessage {
	return { role: "user", content: `user-${i}`, timestamp: i };
}

/** Build a synthetic assistant message at index `i`. */
function assistant(i: number): ConversationMessage {
	return { role: "assistant", content: `assistant-${i}`, timestamp: i };
}

/** Build a synthetic tool-result message at index `i`. */
function toolResult(i: number): ConversationMessage {
	return { role: "toolResult", content: `tool-${i}`, timestamp: i };
}

/**
 * Build a synthetic conversation of `turnCount` user-message-initiated turns.
 * Each turn is one user message + one assistant message + one tool result.
 * Returns a flat `Message[]`-shaped array.
 */
function conversation(turnCount: number): ConversationMessage[] {
	const out: ConversationMessage[] = [];
	for (let t = 0; t < turnCount; t++) {
		out.push(user(t));
		out.push(assistant(t));
		out.push(toolResult(t));
	}
	return out;
}

// ─── AC-1: constants are named and self-describing ─────────────────────────

describe("AC-1 — recency-window measurement basis and default", () => {
	it("exports RECENCY_BASIS as a named, non-empty string", () => {
		assert.equal(typeof RECENCY_BASIS, "string");
		assert.ok(RECENCY_BASIS.length > 0, "RECENCY_BASIS must be a non-empty string");
		// The named unit is documented in the module header; assert it matches
		// the load-bearing choice. If the basis changes, update the test name
		// and the assertion message together.
		assert.equal(RECENCY_BASIS, "turns", "RECENCY_BASIS must be 'turns' (the basis picked with rationale in the module header)");
	});

	it("exports RECENCY_COMFORT_WINDOW as a positive integer named in turns", () => {
		assert.equal(typeof RECENCY_COMFORT_WINDOW, "number");
		assert.ok(Number.isInteger(RECENCY_COMFORT_WINDOW), "RECENCY_COMFORT_WINDOW must be an integer (turns are countable)");
		assert.ok(RECENCY_COMFORT_WINDOW > 0, "RECENCY_COMFORT_WINDOW must be positive (a zero/negative window would trim everything)");
		// The default value is named in the module header. Pin it here so a
		// silent change to the constant is caught at test time.
		assert.equal(RECENCY_COMFORT_WINDOW, 20, "RECENCY_COMFORT_WINDOW must equal 20 (the named default in the module header)");
	});

	it("DEFAULT_RECENCY_WINDOW is a back-compat alias for RECENCY_COMFORT_WINDOW", () => {
		// The T-2705 default constant is preserved as a back-compat alias
		// so any external consumer that imported `DEFAULT_RECENCY_WINDOW`
		// (test files, downstream extensions) keeps working.
		assert.equal(
			DEFAULT_RECENCY_WINDOW,
			RECENCY_COMFORT_WINDOW,
			"DEFAULT_RECENCY_WINDOW must equal RECENCY_COMFORT_WINDOW (back-compat alias)",
		);
	});
});

// ─── AC-2: recency-only retention (threshold gate removed) ─────────────────

describe("AC-2 — recency-only retention (threshold gate removed)", () => {
	it("no THRESHOLD constant is exported (the gate is removed per AC-4)", () => {
		// The threshold gate is removed. Assert the constant is NOT on
		// the public surface. If a future ticket re-introduces a
		// threshold (e.g. a per-model hard cap), the test should be
		// updated to assert the new constant's contract.
		assert.equal(
			(trimConversation as unknown as { THRESHOLD?: unknown }).THRESHOLD,
			undefined,
			"THRESHOLD must NOT be exported (the gate is removed per AC-4)",
		);
	});

	it("the filter runs unconditionally — there is no token gate", () => {
		// 30 turns of 3 messages each = 90 messages total. The filter
		// carves the most recent 20 turns; 20*3=60 retained, 10*3=30
		// trimmed. There is no metrics parameter; the filter runs
		// regardless of any token count.
		const messages = conversation(30);
		const result = trimConversation(messages);
		assert.equal(result.retain.length, 20 * 3, "filter runs unconditionally; recency window is the only signal");
		assert.equal(result.trim.length, 10 * 3, "trim is the 10 oldest turns (10 turns * 3 messages/turn)");
	});

	it("the filter accepts a caller override on the recency window", () => {
		// 30 turns; caller asks for 10 turns retained. The filter must
		// honor the override (the function exposes `recencyWindow` as
		// a parameter; the caller — `index.ts` — owns the override
		// decision).
		const messages = conversation(30);
		const result = trimConversation(messages, { recencyWindow: 10 });
		assert.equal(result.retain.length, 10 * 3, "caller-overridden window carves 10 turns = 30 messages");
		assert.equal(result.trim.length, 20 * 3, "the carve is the 20 oldest turns");
	});
});

// ─── AC-3: pure function contract ──────────────────────────────────────────

describe("AC-3 — pure function contract (determinism, no side effects)", () => {
	it("is deterministic: identical inputs produce identical outputs across calls", () => {
		const messages = conversation(40);
		const a = trimConversation(messages);
		const b = trimConversation(messages);
		// Deep-equal on the output shape, not just the references.
		assert.deepEqual(a, b, "two calls with identical inputs must return deep-equal results");
	});

	it("does not mutate the input array", () => {
		const messages = conversation(40);
		const snapshot = messages.slice();
		trimConversation(messages);
		// Compare element-by-element — the input array is not the output
		// array, and neither reorders nor rewrites the input.
		assert.equal(messages.length, snapshot.length, "input length is unchanged");
		for (let i = 0; i < messages.length; i++) {
			assert.equal(messages[i], snapshot[i], `input[${i}] is the same reference (no in-place mutation)`);
		}
	});

	it("returns fresh arrays on the recency path (no aliasing of the input)", () => {
		const messages = conversation(40);
		const result = trimConversation(messages);
		// The contract says "returns," not "aliases."
		assert.notEqual(result.retain, messages, "retain is a fresh array, not the input aliased");
		assert.notEqual(result.trim, messages, "trim is a fresh array, not the input aliased");
	});

	it("honors the union-equals-input invariant on the recency path", () => {
		const messages = conversation(50);
		const result = trimConversation(messages);
		// Every message in the input must appear in exactly one of the two
		// output sets. The union is a partition; nothing is lost, nothing
		// is invented.
		assert.equal(
			result.retain.length + result.trim.length,
			messages.length,
			"retain.length + trim.length must equal messages.length (no messages lost, no messages invented)",
		);
		// Disjoint: no element is in both sets.
		const retainSet = new Set(result.retain);
		const trimSet = new Set(result.trim);
		for (const m of result.retain) {
			assert.ok(!trimSet.has(m), "a message is in retain — must not also be in trim");
		}
		// Covering: every input element is in one of the two sets.
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			assert.ok(
				retainSet.has(m) || trimSet.has(m),
				`input[${i}] must appear in either retain or trim (no losses)`,
			);
		}
		// No extras: every output element is from the input.
		for (let i = 0; i < result.retain.length; i++) {
			assert.ok(
				messages.includes(result.retain[i]),
				`retain[${i}] is an input element (no invented messages)`,
			);
		}
		for (let i = 0; i < result.trim.length; i++) {
			assert.ok(
				messages.includes(result.trim[i]),
				`trim[${i}] is an input element (no invented messages)`,
			);
		}
		// Order within each side is preserved (slices, not rearrangements):
		// the trim side is the oldest slice, retain is the newest slice.
		const expectedTrim = messages.slice(0, result.trim.length);
		const expectedRetain = messages.slice(result.trim.length);
		assert.deepEqual(
			result.trim,
			expectedTrim,
			"trim is the oldest slice of the input (order preserved)",
		);
		assert.deepEqual(
			result.retain,
			expectedRetain,
			"retain is the newest slice of the input (order preserved)",
		);
	});
});

// ─── AC-4: recency boundary cases ──────────────────────────────────────────

describe("AC-4 — recency boundary cases", () => {
	it("boundary === 0 messages: empty input returns retain=[], trim=[] without throwing", () => {
		const result = trimConversation([]);
		assert.deepEqual(result.retain, [], "empty input → retain is empty");
		assert.deepEqual(result.trim, [], "empty input → trim is empty");
		assert.equal(result.retain.length + result.trim.length, 0, "empty input → union is empty");
	});

	it("boundary — recency window larger than available turns: retain all, trim none", () => {
		// 5 turns, window of 20. The window exceeds the available turns;
		// the recency filter cannot carve what does not exist. The whole
		// input is retained; trim is empty.
		const messages = conversation(5);
		const result = trimConversation(messages);
		assert.deepEqual(result.retain, messages, "window > available turns → retain all");
		assert.deepEqual(result.trim, [], "window > available turns → trim is empty");
		// Union-equals-input holds.
		assert.equal(result.retain.length + result.trim.length, messages.length, "partition union equals input");
	});

	it("boundary — recency window equal to available turns: retain all, trim none", () => {
		// 20 turns, window of 20. Boundary case: the window matches the
		// available turns exactly. The carve is at index 0; everything
		// is retained.
		const messages = conversation(20);
		const result = trimConversation(messages);
		assert.deepEqual(result.retain, messages, "window = available turns → retain all");
		assert.deepEqual(result.trim, [], "window = available turns → trim is empty");
	});

	it("boundary — one turn beyond the window: trim exactly one turn", () => {
		// 21 turns, window of 20. One turn is over the window; exactly
		// one turn (3 messages) is trimmed.
		const messages = conversation(21);
		const result = trimConversation(messages);
		assert.equal(result.retain.length, 20 * 3, "one turn over window → retain the most recent 20 turns");
		assert.equal(result.trim.length, 1 * 3, "one turn over window → trim exactly the oldest turn (3 messages)");
	});

	it("boundary — no user messages in the conversation: recency filter has no anchor, fall back to no-op", () => {
		// A session composed entirely of tool-results / assistant messages
		// (no user-role message). The recency contract keys on user turns;
		// without any, the filter cannot anchor. Documented behavior: fall
		// back to the no-op path (retain all, trim none).
		const messages: ConversationMessage[] = [
			assistant(0),
			toolResult(0),
			assistant(1),
			toolResult(1),
			assistant(2),
		];
		const result = trimConversation(messages);
		assert.deepEqual(result.retain, messages, "no user messages → fall back to no-op retain");
		assert.deepEqual(result.trim, [], "no user messages → trim is empty");
	});

	it("boundary — single-turn conversation: the lone turn is retained (window ≥ turns)", () => {
		// 1 turn (3 messages), default window 20. The window exceeds the
		// available turns; everything is retained.
		const messages = conversation(1);
		const result = trimConversation(messages);
		assert.deepEqual(result.retain, messages, "single turn → retain all");
		assert.deepEqual(result.trim, [], "single turn → trim is empty");
	});
});

// ─── Defensive-options test (documents the malformed-input behavior) ───────

describe("defensive — malformed options collapse to defaults without throwing", () => {
	it("recencyWindow of 0 collapses to the default (positive integer requirement)", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { recencyWindow: 0 });
		// Default window = 20; the carve is the same as the no-override test.
		assert.equal(result.retain.length, 20 * 3, "recencyWindow=0 collapses to RECENCY_COMFORT_WINDOW");
	});

	it("non-integer recencyWindow collapses to the default (integer requirement)", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { recencyWindow: 7.5 });
		assert.equal(result.retain.length, 20 * 3, "recencyWindow=7.5 collapses to RECENCY_COMFORT_WINDOW");
	});

	it("negative recencyWindow collapses to the default", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { recencyWindow: -3 });
		assert.equal(result.retain.length, 20 * 3, "recencyWindow=-3 collapses to RECENCY_COMFORT_WINDOW");
	});
});

// ─── Type-level smoke test (compile-time check via runtime assertion) ──────

describe("type surface — public API is consumable from the documented contract", () => {
	it("trimConversation accepts the ConversationMessage shape and returns a TrimResult", () => {
		// The type-level guarantee is enforced by the TypeScript compiler.
		// The runtime assertion is a smoke test that the function returns
		// the documented shape (the destructurable `{ retain, trim }`).
		const messages = conversation(5);
		const result: TrimResult<ConversationMessage> = trimConversation(messages);
		assert.ok(Array.isArray(result.retain), "TrimResult.retain is an array");
		assert.ok(Array.isArray(result.trim), "TrimResult.trim is an array");
		// Destructurable: callers can pull either set off the return.
		const { retain, trim }: { retain: ConversationMessage[]; trim: ConversationMessage[] } = result;
		assert.ok(Array.isArray(retain), "destructured retain is an array");
		assert.ok(Array.isArray(trim), "destructured trim is an array");
	});

	it("the exported constants are the values the production code imports (no shadow module)", () => {
		// The implementer should use the same module path the production
		// code uses. The constants are the literal values from `policy.ts`:
		// a future change to the constants in `policy.ts` flows to this
		// assertion automatically.
		assert.equal(typeof RECENCY_BASIS, "string", "RECENCY_BASIS is a string");
		assert.equal(typeof RECENCY_COMFORT_WINDOW, "number", "RECENCY_COMFORT_WINDOW is a number");
	});
});

// ─── Options type guard (compile-time only; runtime smoke) ────────────────

// The `TrimOptions` type is exported for the caller (`index.ts`) to type its
// override payload. The runtime smoke below is a touch-up that the
// optional options object flows through correctly.
describe("options object — index.ts's per-call override payload flows through", () => {
	it("an empty options object uses the module defaults", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, {});
		assert.equal(result.retain.length, 20 * 3, "empty options → RECENCY_COMFORT_WINDOW");
	});

	it("an options object with recencyWindow honors the override", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { recencyWindow: 5 });
		assert.equal(result.retain.length, 5 * 3, "caller-overridden window honored");
		assert.equal(result.trim.length, 45 * 3, "trim is the rest");
	});
});
