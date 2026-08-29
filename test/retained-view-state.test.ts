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

describe("retained view state", () => {
	it("reconstructs source messages, overrides, ordered virtual slots, and the raw tail", () => {
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
		const state = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: output,
			pinnedCustomType,
		});
		assert.ok(state);
		assert.deepEqual(state.retainedSourceIndices, [0, 2]);
		assert.deepEqual(state.contentOverrides, [{ sourceIndex: 2, content: rewritten }]);
		assert.deepEqual(state.virtualEntries, [
			{ position: 0, kind: "prune-reminder" },
			{ position: 0, kind: "pinned-slot" },
		]);
		assert.equal(JSON.stringify(state).includes("old pin"), false);

		const tail = message("toolResult", "new result");
		const reconstructed = reconstructRetainedView({
			state,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: [...raw, tail],
			pinnedMessage: { role: "custom", content: "new pin", customType: pinnedCustomType },
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
			state,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: [...raw, tail],
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

	it("rejects state that cannot be tied to the current session, policy, source prefix, or raw length", () => {
		const state = {
			version: RETAINED_VIEW_STATE_VERSION,
			sessionId,
			policyFingerprint,
			sourceCount: 2,
			sourceDigest,
			retainedSourceIndices: [1],
			contentOverrides: [],
			virtualEntries: [],
		};
		const raw = [message("user", "one"), message("assistant", "two")];
		const base = {
			state,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: raw,
		};
		assert.ok(reconstructRetainedView(base));
		assert.equal(reconstructRetainedView({ ...base, sessionId: "other" }), undefined);
		assert.equal(reconstructRetainedView({ ...base, policyFingerprint: "c".repeat(64) }), undefined);
		assert.equal(reconstructRetainedView({ ...base, currentPrefixDigest: "d".repeat(64) }), undefined);
		assert.equal(reconstructRetainedView({ ...base, rawMessages: raw.slice(0, 1) }), undefined);
	});

	it("rejects malformed indices, overrides, virtual entries, and versions", () => {
		const valid = {
			version: RETAINED_VIEW_STATE_VERSION,
			sessionId,
			policyFingerprint,
			sourceCount: 3,
			sourceDigest,
			retainedSourceIndices: [0, 2],
			contentOverrides: [{ sourceIndex: 2, content: "changed" }],
			virtualEntries: [{ position: 0, kind: "prune-reminder" }],
		};
		assert.ok(parseRetainedViewState(valid));
		assert.equal(parseRetainedViewState({ ...valid, version: 1 }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, retainedSourceIndices: [2, 0] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, retainedSourceIndices: [0, 0] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentOverrides: [{ sourceIndex: 1, content: "changed" }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentOverrides: [{ sourceIndex: 2, content: 42 }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, virtualEntries: [{ position: 0, kind: "other" }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, virtualEntries: [{ position: 3, kind: "prune-reminder" }] }), undefined);
		assert.equal(parseRetainedViewState({
			...valid,
			virtualEntries: [
				{ position: 0, kind: "pinned-slot" },
				{ position: 1, kind: "pinned-slot" },
			],
		}), undefined);
	});

	it("rejects reordered source positions and keeps one declaration for each virtual kind", () => {
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
		const state = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: [reminder, reminder, pin, pin, withRetainedSourceIndex(raw[0]!, 0)],
			pinnedCustomType,
		});
		assert.deepEqual(state?.virtualEntries, [
			{ position: 0, kind: "prune-reminder" },
			{ position: 0, kind: "pinned-slot" },
		]);
	});
});
