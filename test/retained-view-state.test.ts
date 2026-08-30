import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRUNE_REMINDER_CUSTOM_TYPE, createPruneReminderMessage } from "../policy.ts";
import {
	RETAINED_SOURCE_INDEX,
	RETAINED_VIEW_STATE_VERSION,
	createRetainedViewState,
	parseRetainedViewState,
	reconstructRetainedView,
	stripRetainedSourceIndex,
	withRetainedSourceIndex,
} from "../retained-view-state.ts";

const sourceDigest = "a".repeat(64);
const policyFingerprint = "b".repeat(64);
const sessionId = "session-1";
const pinnedCustomType = "context-trimmer-pinned";

function message(role: string, content: unknown): Record<string, unknown> {
	return { role, content };
}

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: RETAINED_VIEW_STATE_VERSION,
		sessionId,
		policyFingerprint,
		sourceCount: 3,
		sourceDigest,
		retainedSourceIndices: [0, 2],
		contentReductions: [],
		virtualEntries: [],
		...overrides,
	};
}

describe("retained view state", () => {
	it("reconstructs raw block reductions, canonical virtual slots, and the raw tail", () => {
		const raw = [
			message("user", "dispatch"),
			message("assistant", "removed"),
			message("assistant", [{ type: "thinking", thinking: "raw" }, { type: "text", text: "kept" }]),
		];
		const rewritten = [{ type: "text", text: "kept" }];
		const output = [
			createPruneReminderMessage() as unknown as Record<string, unknown>,
			{ role: "custom", content: "old pin", customType: pinnedCustomType },
			withRetainedSourceIndex(raw[0]!, 0),
			withRetainedSourceIndex({ ...raw[2]!, content: rewritten }, 2),
		];
		const retained = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: output,
			pinnedCustomType,
		});
		assert.ok(retained);
		assert.equal(RETAINED_VIEW_STATE_VERSION, 3);
		assert.deepEqual(retained.retainedSourceIndices, [0, 2]);
		assert.deepEqual(retained.contentReductions, [{ sourceIndex: 2, removedBlockIndices: [0] }]);
		assert.deepEqual(retained.virtualEntries, [
			{ position: 0, kind: "prune-reminder" },
			{ position: 0, kind: "pinned-slot" },
		]);
		assert.equal(JSON.stringify(retained).includes("old pin"), false);

		const tail = message("toolResult", "new result");
		const reconstructed = reconstructRetainedView({
			state: retained,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: [...raw, tail],
			pinnedMessage: { role: "custom", content: "new pin", customType: pinnedCustomType },
			requiredSourceIndices: new Set([0]),
		});
		assert.ok(reconstructed);
		assert.equal(reconstructed[0]?.customType, PRUNE_REMINDER_CUSTOM_TYPE);
		assert.equal(reconstructed[1]?.content, "new pin");
		assert.deepEqual(reconstructed.slice(2).map((item) => item.content), ["dispatch", rewritten, "new result"]);
		assert.deepEqual(
			reconstructed.slice(2).map((item) => item[RETAINED_SOURCE_INDEX]),
			[0, 2, 3],
		);

		const withoutPin = reconstructRetainedView({
			state: retained,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: [...raw, tail],
			requiredSourceIndices: new Set([0]),
		});
		assert.deepEqual(withoutPin?.map((item) => item.content), [
			createPruneReminderMessage().content,
			"dispatch",
			rewritten,
			"new result",
		]);
		for (const item of reconstructed) {
			assert.equal(Object.getOwnPropertySymbols(stripRetainedSourceIndex(item)).length, 0);
		}
	});

	it("rejects state that does not match applicability or required-source constraints", () => {
		const retained = state({ sourceCount: 2, retainedSourceIndices: [1] });
		const raw = [message("user", "one"), message("assistant", "two")];
		const base = {
			state: retained,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: raw,
		};
		assert.ok(reconstructRetainedView(base));
		assert.equal(reconstructRetainedView({ ...base, requiredSourceIndices: new Set([0]) }), undefined);
		assert.equal(reconstructRetainedView({ ...base, sessionId: "other" }), undefined);
		assert.equal(reconstructRetainedView({ ...base, policyFingerprint: "c".repeat(64) }), undefined);
		assert.equal(reconstructRetainedView({ ...base, currentPrefixDigest: "d".repeat(64) }), undefined);
		assert.equal(reconstructRetainedView({ ...base, rawMessages: raw.slice(0, 1) }), undefined);
	});

	it("records removals only and rejects replacement or added content", () => {
		const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } };
		const raw = [
			message("user", "dispatch"),
			message("assistant", [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "kept" },
				toolCall,
			]),
		];
		const valid = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: [
				withRetainedSourceIndex(raw[0]!, 0),
				withRetainedSourceIndex({ ...raw[1]!, content: [{ type: "text", text: "kept" }] }, 1),
			],
		});
		assert.deepEqual(valid?.contentReductions, [{ sourceIndex: 1, removedBlockIndices: [0, 2] }]);
		assert.ok(reconstructRetainedView({
			state: valid,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: raw,
		}));
		assert.equal(reconstructRetainedView({
			state: valid,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: raw,
			protectedToolCallIds: new Set(["call-1"]),
		}), undefined);

		const changed = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: [withRetainedSourceIndex({ ...raw[1]!, content: [{ type: "text", text: "attacker" }] }, 1)],
		});
		assert.equal(changed, undefined);
		assert.equal(createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: [message("user", "raw")],
			outputMessages: [withRetainedSourceIndex(message("user", "replacement"), 0)],
		}), undefined);
	});

	it("accepts a protected-call carve only when the protected call remains", () => {
		const protectedCall = { type: "toolCall", id: "protected", name: "read", arguments: { path: "kept" } };
		const raw = [message("assistant", [
			{ type: "text", text: "removed with dropped turn" },
			protectedCall,
			{ type: "thinking", thinking: "removed" },
		])];
		const retained = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: [withRetainedSourceIndex({ ...raw[0]!, content: [protectedCall] }, 0)],
		});
		assert.ok(retained);
		assert.ok(reconstructRetainedView({
			state: retained,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: raw,
			requiredSourceIndices: new Set([0]),
			protectedToolCallIds: new Set(["protected"]),
		}));
		assert.equal(reconstructRetainedView({
			state: retained,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: raw,
			requiredSourceIndices: new Set([0]),
		}), undefined);
	});

	it("rejects malformed reductions, source selections, virtual entries, and versions", () => {
		const valid = state({
			contentReductions: [{ sourceIndex: 2, removedBlockIndices: [0] }],
			virtualEntries: [{ position: 0, kind: "prune-reminder" }],
		});
		assert.ok(parseRetainedViewState(valid));
		assert.equal(parseRetainedViewState({ ...valid, version: 2 }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentOverrides: [{ content: "attacker" }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, attackerInstruction: "attacker" }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, retainedSourceIndices: [2, 0] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, retainedSourceIndices: [0, 0] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentReductions: [{ sourceIndex: 1, removedBlockIndices: [0] }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentReductions: [{ sourceIndex: 2, removedBlockIndices: [0], content: "attacker" }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentReductions: [{ sourceIndex: 2, removedBlockIndices: [] }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentReductions: [{ sourceIndex: 2, removedBlockIndices: [1, 0] }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentReductions: [{ sourceIndex: 2, removedBlockIndices: [0, 0] }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, virtualEntries: [{ position: 1, kind: "prune-reminder" }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, virtualEntries: [{ position: 0, kind: "other" }] }), undefined);
		assert.equal(parseRetainedViewState({
			...valid,
			virtualEntries: [
				{ position: 0, kind: "pinned-slot" },
				{ position: 0, kind: "prune-reminder" },
			],
		}), undefined);
		assert.equal(parseRetainedViewState({
			...valid,
			virtualEntries: [
				{ position: 0, kind: "pinned-slot" },
				{ position: 0, kind: "pinned-slot" },
			],
		}), undefined);
		for (const virtualEntries of [
			[],
			[{ position: 0, kind: "prune-reminder" }],
			[{ position: 0, kind: "pinned-slot" }],
			[
				{ position: 0, kind: "prune-reminder" },
				{ position: 0, kind: "pinned-slot" },
			],
		]) {
			assert.ok(parseRetainedViewState({ ...state(), virtualEntries }));
		}
	});

	it("rejects reordered source positions and keeps one canonical declaration per virtual kind", () => {
		const raw = [message("user", "one"), message("assistant", "two")];
		assert.equal(
			createRetainedViewState({
				sessionId,
				policyFingerprint,
				sourceDigest,
				rawMessages: raw,
				outputMessages: [withRetainedSourceIndex(raw[1]!, 1), withRetainedSourceIndex(raw[0]!, 0)],
			}),
			undefined,
		);
		const reminder = createPruneReminderMessage() as unknown as Record<string, unknown>;
		const pin = { role: "custom", content: "pin", customType: pinnedCustomType };
		const retained = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: [reminder, reminder, pin, pin, withRetainedSourceIndex(raw[0]!, 0)],
			pinnedCustomType,
		});
		assert.deepEqual(retained?.virtualEntries, [
			{ position: 0, kind: "prune-reminder" },
			{ position: 0, kind: "pinned-slot" },
		]);
	});
});
