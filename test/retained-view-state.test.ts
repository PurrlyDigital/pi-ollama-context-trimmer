import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRUNE_REMINDER_CUSTOM_TYPE, createPruneReminderMessage } from "../policy.ts";
import {
	RETAINED_SOURCE_INDEX,
	createRetainedViewState,
	parseRetainedViewState,
	reconstructRetainedView,
	stripRetainedSourceIndex,
	withRetainedSourceIndex,
} from "../retained-view-state.ts";

const sourceDigest = "a".repeat(64);
const policyFingerprint = "b".repeat(64);
const sessionId = "session-1";

function message(role: string, content: unknown): Record<string, unknown> {
	return { role, content };
}

describe("retained view state", () => {
	it("reconstructs selected source messages, sparse content overrides, a virtual reminder, and the raw tail", () => {
		const raw = [
			message("user", "dispatch"),
			message("assistant", "removed"),
			message("assistant", [{ type: "thinking", thinking: "raw" }, { type: "text", text: "kept" }]),
		];
		const rewritten = [{ type: "text", text: "kept" }];
		const output = [
			createPruneReminderMessage() as unknown as Record<string, unknown>,
			withRetainedSourceIndex(raw[0]!, 0),
			withRetainedSourceIndex({ ...raw[2]!, content: rewritten }, 2),
		];
		const state = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: output,
		});
		assert.ok(state);
		assert.deepEqual(state.retainedSourceIndices, [0, 2]);
		assert.deepEqual(state.contentOverrides, [{ sourceIndex: 2, content: rewritten }]);
		assert.deepEqual(state.virtualEntries, [{ position: 0, kind: "prune-reminder" }]);

		const tail = message("toolResult", "new result");
		const reconstructed = reconstructRetainedView({
			state,
			sessionId,
			policyFingerprint,
			currentPrefixDigest: sourceDigest,
			rawMessages: [...raw, tail],
		});
		assert.ok(reconstructed);
		assert.equal(reconstructed[0]?.customType, PRUNE_REMINDER_CUSTOM_TYPE);
		assert.deepEqual(reconstructed.slice(1).map((item) => item.content), ["dispatch", rewritten, "new result"]);
		assert.deepEqual(
			reconstructed.slice(1).map((item) => item[RETAINED_SOURCE_INDEX]),
			[0, 2, 3],
		);
		for (const item of reconstructed) {
			assert.equal(Object.getOwnPropertySymbols(stripRetainedSourceIndex(item)).length, 0);
		}
	});

	it("rejects state that cannot be tied to the current session, policy, source prefix, or raw length", () => {
		const state = {
			version: 1,
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
			version: 1,
			sessionId,
			policyFingerprint,
			sourceCount: 3,
			sourceDigest,
			retainedSourceIndices: [0, 2],
			contentOverrides: [{ sourceIndex: 2, content: "changed" }],
			virtualEntries: [{ position: 0, kind: "prune-reminder" }],
		};
		assert.ok(parseRetainedViewState(valid));
		assert.equal(parseRetainedViewState({ ...valid, version: 2 }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, retainedSourceIndices: [2, 0] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, retainedSourceIndices: [0, 0] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentOverrides: [{ sourceIndex: 1, content: "changed" }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, contentOverrides: [{ sourceIndex: 2, content: 42 }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, virtualEntries: [{ position: 0, kind: "other" }] }), undefined);
		assert.equal(parseRetainedViewState({ ...valid, virtualEntries: [{ position: 3, kind: "prune-reminder" }] }), undefined);
	});

	it("rejects output that reorders source positions and keeps one reminder declaration", () => {
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
		const state = createRetainedViewState({
			sessionId,
			policyFingerprint,
			sourceDigest,
			rawMessages: raw,
			outputMessages: [reminder, reminder, withRetainedSourceIndex(raw[0]!, 0)],
		});
		assert.deepEqual(state?.virtualEntries, [{ position: 0, kind: "prune-reminder" }]);
	});
});
