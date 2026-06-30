/**
 * T-2705 — Trim policy unit tests.
 *
 * Runner: Node's built-in `node:test` (no project install required).
 * Run: `node --test /home/dez/.pi/agent/extensions/context-trimmer/policy.test.ts`
 * (or with `npx tsx` / `ts-node` if a loader is available; the file is
 * TypeScript and the harness needs a TS-aware runner to execute it as-is).
 *
 * The tests import the same `policy.ts` the production code imports from
 * — no duplicate constants, no shadow modules. The contract is asserted
 * directly on the public API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_RECENCY_WINDOW,
	RECENCY_BASIS,
	THRESHOLD,
	THRESHOLD_UNIT,
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

	it("exports DEFAULT_RECENCY_WINDOW as a positive integer named in turns", () => {
		assert.equal(typeof DEFAULT_RECENCY_WINDOW, "number");
		assert.ok(Number.isInteger(DEFAULT_RECENCY_WINDOW), "DEFAULT_RECENCY_WINDOW must be an integer (turns are countable)");
		assert.ok(DEFAULT_RECENCY_WINDOW > 0, "DEFAULT_RECENCY_WINDOW must be positive (a zero/negative window would trim everything)");
		// The default value is named in the module header. Pin it here so a
		// silent change to the constant is caught at test time.
		assert.equal(DEFAULT_RECENCY_WINDOW, 20, "DEFAULT_RECENCY_WINDOW must equal 20 (the named default in the module header)");
	});
});

// ─── AC-2: threshold gate ──────────────────────────────────────────────────

describe("AC-2 — threshold gate and threshold constant", () => {
	it("exports THRESHOLD as a finite non-negative number named in tokens", () => {
		assert.equal(typeof THRESHOLD, "number");
		assert.ok(Number.isFinite(THRESHOLD), "THRESHOLD must be finite");
		assert.ok(THRESHOLD >= 0, "THRESHOLD must be non-negative");
		// The unit is named in the constant AND the type alias — three
		// independent readings of the same unit (constant, type, this test).
		assert.equal(THRESHOLD_UNIT, "tokens", "THRESHOLD_UNIT must be 'tokens' (the unit named in the module header)");
		// Pin the value: a silent change to the constant is caught here.
		assert.equal(THRESHOLD, 50_000, "THRESHOLD must equal 50_000 tokens (the named default in the module header)");
	});

	it("under-threshold: returns the input unchanged as retain, trim is empty", () => {
		// 30 turns of 3 messages each = 90 messages total. The threshold
		// gate is the FIRST predicate; the recency window does not run.
		const messages = conversation(30);
		const underThreshold = THRESHOLD - 1;
		const result = trimConversation(messages, { tokens: underThreshold });
		assert.deepEqual(result.retain, messages, "under-threshold retain must deep-equal the input");
		assert.deepEqual(result.trim, [], "under-threshold trim must be empty");
		// Union-equals-input invariant: under-threshold is a no-op, so
		// retain holds the entire input.
		assert.equal(result.retain.length, messages.length, "under-threshold retain length must equal input length");
		assert.equal(result.trim.length, 0, "under-threshold trim length must be zero");
	});

	it("threshold accepts a caller override (per-session tuning by T-2706)", () => {
		// Same input as the under-threshold test, but the caller passes a
		// threshold of 10 — well below the input's token count. The gate
		// must open and the recency filter must run.
		const messages = conversation(30);
		const result = trimConversation(messages, { tokens: 100_000 }, { threshold: 10 });
		// 30 turns, window=20 → retain 10 most-recent turns, trim 20 oldest.
		// Each turn is 3 messages; 20*3=60 retained, 10*3=30 trimmed.
		assert.equal(result.retain.length, 60, "caller-overridden threshold opens the gate; recency filter carves the window");
		assert.equal(result.trim.length, 30, "the carve is the 10 oldest turns (10 turns * 3 messages/turn)");
	});
});

// ─── AC-3: pure function contract ──────────────────────────────────────────

describe("AC-3 — pure function contract (determinism, no side effects)", () => {
	it("is deterministic: identical inputs produce identical outputs across calls", () => {
		const messages = conversation(40);
		const a = trimConversation(messages, { tokens: THRESHOLD + 1 });
		const b = trimConversation(messages, { tokens: THRESHOLD + 1 });
		// Deep-equal on the output shape, not just the references.
		assert.deepEqual(a, b, "two calls with identical inputs must return deep-equal results");
	});

	it("does not mutate the input array", () => {
		const messages = conversation(40);
		const snapshot = messages.slice();
		trimConversation(messages, { tokens: THRESHOLD + 1 });
		// Compare element-by-element — the input array is not the output
		// array, and neither reorders nor rewrites the input.
		assert.equal(messages.length, snapshot.length, "input length is unchanged");
		for (let i = 0; i < messages.length; i++) {
			assert.equal(messages[i], snapshot[i], `input[${i}] is the same reference (no in-place mutation)`);
		}
	});

	it("returns fresh arrays on the no-op path (no aliasing of the input)", () => {
		const messages = conversation(5);
		const result = trimConversation(messages, { tokens: 0 });
		// Even on the no-op path, the result must be a new array — the
		// contract says "returns," not "aliases."
		assert.notEqual(result.retain, messages, "no-op retain is a fresh array, not the input aliased");
		assert.notEqual(result.trim, messages, "no-op trim is a fresh array, not the input aliased");
		assert.deepEqual(result.retain, messages, "but the no-op retain deep-equals the input");
	});

	it("honors the union-equals-input invariant on the recency path", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 });
		// Every message in the input must appear in exactly one of the two
		// output sets. The union is a partition; nothing is lost, nothing
		// is invented. The policy returns `trim` first (oldest) then
		// `retain` (newest) — the recency filter carves at a turn boundary
		// in the middle of the array, so the two sets live on opposite
		// sides of the cut, not in a concatenation that preserves order.
		assert.equal(
			result.retain.length + result.trim.length,
			messages.length,
			"retain.length + trim.length must equal messages.length (no messages lost, no messages invented)",
		);
		// Multiset-equality check: sort both sides by identity and compare.
		// The simplest correct check is "every input element appears in
		// either retain or trim, and every retain/trim element came from
		// the input." Reference equality is sufficient — the policy
		// returns slices of the input (no cloning, no reordering of the
		// elements within either side).
		const retainSet = new Set(result.retain);
		const trimSet = new Set(result.trim);
		// Disjoint: no element is in both sets.
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

	it("honors the union-equals-input invariant on the no-op path", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: 0 });
		assert.equal(result.retain.length, messages.length, "no-op retain length equals input");
		assert.equal(result.trim.length, 0, "no-op trim length is zero");
		// The no-op path returns a fresh array, but the elements are the
		// same references as the input (slice preserves references).
		assert.deepEqual(
			result.retain,
			messages,
			"no-op retain is a fresh array but element-wise deep-equals the input",
		);
	});
});

// ─── AC-4: under-threshold, over-threshold, and boundary cases ─────────────

describe("AC-4 — under-threshold no-op, over-threshold recency retention, boundary cases", () => {
	it("under-threshold: messages.length < THRESHOLD returns retain=input, trim=[]", () => {
		// The threshold gate is on `metrics.tokens`, NOT on
		// `messages.length`. The "under-threshold" case is a
		// token-below-threshold case; the input may have any number of
		// messages. The recency filter does NOT run on this path.
		const messages = conversation(100); // 300 messages, but the gate is tokens-based
		const result = trimConversation(messages, { tokens: THRESHOLD - 1 });
		assert.deepEqual(result.retain, messages, "under-threshold retain deep-equals input");
		assert.deepEqual(result.trim, [], "under-threshold trim is empty");
	});

	it("over-threshold: retain is the most recent DEFAULT_RECENCY_WINDOW turns, trim is the rest", () => {
		// Build a deterministic conversation: 50 turns (150 messages).
		// Set the window to 20 (the default) and assert the carve.
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 });

		// 50 turns total, retain 20 most-recent → retain 20*3=60, trim 30*3=90.
		assert.equal(result.retain.length, 20 * 3, "over-threshold retain length = 20 turns * 3 messages/turn");
		assert.equal(result.trim.length, 30 * 3, "over-threshold trim length = 30 turns * 3 messages/turn");

		// The retained messages must be the most recent — the LAST 60
		// messages of the input. Slice and compare element-by-element.
		const expectedRetain = messages.slice(messages.length - 60);
		for (let i = 0; i < expectedRetain.length; i++) {
			assert.equal(result.retain[i], expectedRetain[i], `retain[${i}] is the most-recent message at that position`);
		}
	});

	it("over-threshold respects the caller's recencyWindow override", () => {
		// 50 turns; caller asks for 10 turns retained. Recency filter must
		// honor the override (the function exposes recencyWindow as a
		// parameter; the caller — T-2706 — owns the override decision).
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 }, { recencyWindow: 10 });
		assert.equal(result.retain.length, 10 * 3, "caller-overridden window carves 10 turns = 30 messages");
		assert.equal(result.trim.length, 40 * 3, "the carve is the 40 oldest turns");
	});

	it("boundary === THRESHOLD: the gate opens (the policy runs, recency filter applied)", () => {
		// Boundary semantics: at exactly THRESHOLD tokens, the gate OPENS.
		// The threshold is the "trimming is worth it" line; the recency
		// filter at the boundary is deterministic and asserted.
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD });
		// Gate opened → recency filter applied → 20 turns retained.
		assert.equal(result.retain.length, 20 * 3, "at === THRESHOLD, the gate opens and the recency filter runs");
		assert.equal(result.trim.length, 30 * 3, "at === THRESHOLD, the carve is the same as for tokens > THRESHOLD");
	});

	it("boundary === 0 messages: empty input returns retain=[], trim=[] without throwing", () => {
		const result = trimConversation([], { tokens: 1_000_000 });
		assert.deepEqual(result.retain, [], "empty input → retain is empty");
		assert.deepEqual(result.trim, [], "empty input → trim is empty");
		// Length-only check is also fine; the deep-equal above is the
		// load-bearing assertion.
		assert.equal(result.retain.length + result.trim.length, 0, "empty input → union is empty");
	});

	it("boundary === THRESHOLD - 1 tokens: the no-op path runs", () => {
		// One token under the threshold. The gate stays closed; the
		// recency filter does NOT run. Assert the no-op shape.
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD - 1 });
		assert.deepEqual(result.retain, messages, "one token under threshold → no-op");
		assert.deepEqual(result.trim, [], "one token under threshold → trim is empty");
	});

	it("boundary === THRESHOLD + 1 tokens: the recency-retention path runs", () => {
		// One token over the threshold. The gate opens; the recency
		// filter carves the most-recent N turns. The carve at
		// THRESHOLD + 1 is the same shape as at THRESHOLD + 1_000_000 —
		// the threshold gate is binary, not graded.
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 });
		assert.equal(result.retain.length, 20 * 3, "one token over threshold → recency filter carves the window");
		assert.equal(result.trim.length, 30 * 3, "one token over threshold → trim is the oldest messages");
	});

	it("boundary — recency window larger than available turns: retain all, trim none", () => {
		// 5 turns, window of 20. The window exceeds the available turns;
		// the recency filter cannot carve what does not exist. The whole
		// input is retained; trim is empty. This is the "thin session"
		// path — the gate may be open (tokens are high) but the recency
		// filter has nothing to trim.
		const messages = conversation(5);
		// Token count well above the threshold so the gate opens.
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 });
		assert.deepEqual(result.retain, messages, "window > available turns → retain all");
		assert.deepEqual(result.trim, [], "window > available turns → trim is empty");
		// Union-equals-input holds.
		assert.equal(result.retain.length + result.trim.length, messages.length, "partition union equals input");
	});

	it("boundary — no user messages in the conversation: recency filter has no anchor, fall back to no-op", () => {
		// A session composed entirely of tool-results / assistant messages
		// (no user-role message). The recency contract keys on user turns;
		// without any, the filter cannot anchor. Documented behavior: fall
		// back to the no-op path (retain all, trim none) rather than
		// guessing a boundary.
		const messages: ConversationMessage[] = [
			assistant(0),
			toolResult(0),
			assistant(1),
			toolResult(1),
			assistant(2),
		];
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 });
		assert.deepEqual(result.retain, messages, "no user messages → fall back to no-op retain");
		assert.deepEqual(result.trim, [], "no user messages → trim is empty");
	});
});

// ─── Defensive-options test (documents the malformed-input behavior) ───────

describe("defensive — malformed options collapse to defaults without throwing", () => {
	it("recencyWindow of 0 collapses to the default (positive integer requirement)", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 }, { recencyWindow: 0 });
		// Default window = 20; the carve is the same as the over-threshold test.
		assert.equal(result.retain.length, 20 * 3, "recencyWindow=0 collapses to DEFAULT_RECENCY_WINDOW");
	});

	it("negative threshold collapses to the default (non-negative requirement)", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 }, { threshold: -5 });
		// Default threshold = 50_000; the gate opens (metrics.tokens > THRESHOLD);
		// the recency filter carves the same window.
		assert.equal(result.retain.length, 20 * 3, "threshold=-5 collapses to THRESHOLD; gate opens; carve is the default window");
	});

	it("non-integer recencyWindow collapses to the default (integer requirement)", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 }, { recencyWindow: 7.5 });
		assert.equal(result.retain.length, 20 * 3, "recencyWindow=7.5 collapses to DEFAULT_RECENCY_WINDOW");
	});
});

// ─── Type-level smoke test (compile-time check via runtime assertion) ──────

describe("type surface — public API is consumable from the documented contract", () => {
	it("trimConversation accepts the ConversationMessage shape and returns a TrimResult", () => {
		// The type-level guarantee is enforced by the TypeScript compiler.
		// The runtime assertion is a smoke test that the function returns
		// the documented shape (the destructurable `{ retain, trim }`).
		const messages = conversation(5);
		const result: TrimResult<ConversationMessage> = trimConversation(messages, { tokens: 0 });
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
		// assertion automatically. If a shadow module were introduced,
		// the import paths would diverge and the test would import from
		// the wrong file.
		assert.equal(typeof RECENCY_BASIS, "string", "RECENCY_BASIS is a string");
		assert.equal(typeof THRESHOLD_UNIT, "string", "THRESHOLD_UNIT is a string");
		assert.equal(typeof DEFAULT_RECENCY_WINDOW, "number", "DEFAULT_RECENCY_WINDOW is a number");
		assert.equal(typeof THRESHOLD, "number", "THRESHOLD is a number");
	});
});

// ─── Options type guard (compile-time only; runtime smoke) ────────────────

// The `TrimOptions` type is exported for the caller (T-2706) to type its
// override payload. The runtime smoke below is a touch-up that the
// optional options object flows through correctly.
describe("options object — T-2706's per-call override payload flows through", () => {
	it("an empty options object uses the module defaults", () => {
		const messages = conversation(50);
		const result = trimConversation(messages, { tokens: THRESHOLD + 1 }, {});
		assert.equal(result.retain.length, 20 * 3, "empty options → DEFAULT_RECENCY_WINDOW");
	});

	it("both overrides together (recencyWindow + threshold) compose", () => {
		const messages = conversation(50);
		const result = trimConversation(
			messages,
			{ tokens: 1_000_000 },
			{ recencyWindow: 5, threshold: 10 },
		);
		assert.equal(result.retain.length, 5 * 3, "caller-overridden window honored alongside caller-overridden threshold");
		assert.equal(result.trim.length, 45 * 3, "trim is the rest");
	});
});
