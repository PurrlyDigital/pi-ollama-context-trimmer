import {
	PRUNE_REMINDER_CUSTOM_TYPE,
	createPruneReminderMessage,
	type TrimmableMessage,
} from "./policy.ts";

export const RETAINED_VIEW_CUSTOM_TYPE = "context-trimmer-retained-view";
export const RETAINED_VIEW_STATE_VERSION = 3;
export const RETAINED_SOURCE_INDEX = Symbol("context-trimmer-source-index");

export type RetainedSourceMessage = Record<string, unknown> & {
	[RETAINED_SOURCE_INDEX]?: number;
};

export type RetainedContentReduction = {
	sourceIndex: number;
	removedBlockIndices: number[];
};

export type RetainedVirtualEntry = {
	position: number;
	kind: "prune-reminder" | "pinned-slot";
};

export type RetainedViewState = {
	version: 3;
	sessionId: string;
	policyFingerprint: string;
	sourceCount: number;
	sourceDigest: string;
	retainedSourceIndices: number[];
	contentReductions: RetainedContentReduction[];
	virtualEntries: RetainedVirtualEntry[];
};

type CreateRetainedViewStateInput = {
	sessionId: string;
	policyFingerprint: string;
	sourceDigest: string;
	rawMessages: ReadonlyArray<Record<string, unknown>>;
	outputMessages: ReadonlyArray<Record<string, unknown>>;
	pinnedCustomType?: string;
};

type ReconstructRetainedViewInput = {
	state: unknown;
	sessionId: string;
	policyFingerprint: string;
	currentPrefixDigest: string | undefined;
	rawMessages: ReadonlyArray<Record<string, unknown>>;
	pinnedMessage?: Record<string, unknown>;
	requiredSourceIndices?: ReadonlySet<number>;
	protectedToolCallIds?: ReadonlySet<string>;
};

const SHA256 = /^[a-f0-9]{64}$/;
const STATE_KEYS = new Set([
	"version",
	"sessionId",
	"policyFingerprint",
	"sourceCount",
	"sourceDigest",
	"retainedSourceIndices",
	"contentReductions",
	"virtualEntries",
]);
const REDUCTION_KEYS = new Set(["sourceIndex", "removedBlockIndices"]);
const VIRTUAL_ENTRY_KEYS = new Set(["position", "kind"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function sameContent(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function removedBlockIndices(rawContent: unknown, retainedContent: unknown): number[] | undefined {
	if (!Array.isArray(rawContent) || !Array.isArray(retainedContent)) return undefined;
	const removed: number[] = [];
	let retainedIndex = 0;
	for (let rawIndex = 0; rawIndex < rawContent.length; rawIndex++) {
		if (
			retainedIndex < retainedContent.length &&
			sameContent(rawContent[rawIndex], retainedContent[retainedIndex])
		) {
			retainedIndex++;
		} else {
			removed.push(rawIndex);
		}
	}
	if (retainedIndex !== retainedContent.length || removed.length === 0) return undefined;
	return removed;
}

function hasProtectedToolCall(
	content: ReadonlyArray<unknown>,
	protectedToolCallIds: ReadonlySet<string>,
): boolean {
	return content.some((block) => {
		if (!isRecord(block) || block.type !== "toolCall") return false;
		return typeof block.id === "string" && protectedToolCallIds.has(block.id);
	});
}

function reduceSourceContent(
	source: Record<string, unknown>,
	removedIndices: ReadonlyArray<number>,
	protectedToolCallIds: ReadonlySet<string>,
): unknown | undefined {
	if (!Array.isArray(source.content) || removedIndices.length === 0) return undefined;
	if (removedIndices.at(-1)! >= source.content.length) return undefined;
	const removed = new Set(removedIndices);
	const retained = source.content.filter((_block, index) => !removed.has(index));
	const protectedCallRemains = hasProtectedToolCall(retained, protectedToolCallIds);

	for (const index of removedIndices) {
		const block = source.content[index];
		if (!isRecord(block) || typeof block.type !== "string") return undefined;
		if (block.type === "thinking") continue;
		if (block.type === "toolCall") {
			if (source.role !== "assistant") return undefined;
			if (typeof block.id === "string" && protectedToolCallIds.has(block.id)) return undefined;
			continue;
		}
		if (block.type === "text" && source.role === "assistant" && protectedCallRemains) continue;
		return undefined;
	}
	return retained;
}

function hasCanonicalVirtualEntries(entries: ReadonlyArray<RetainedVirtualEntry>): boolean {
	if (entries.some((entry) => entry.position !== 0)) return false;
	if (entries.length === 0) return true;
	if (entries.length === 1) {
		return entries[0]!.kind === "prune-reminder" || entries[0]!.kind === "pinned-slot";
	}
	return entries.length === 2 &&
		entries[0]!.kind === "prune-reminder" &&
		entries[1]!.kind === "pinned-slot";
}

export function retainedSourceIndex(message: Record<string, unknown>): number | undefined {
	const index = (message as RetainedSourceMessage)[RETAINED_SOURCE_INDEX];
	return isIndex(index) ? index : undefined;
}

export function withRetainedSourceIndex(
	message: Record<string, unknown>,
	sourceIndex: number,
): RetainedSourceMessage {
	return {
		...message,
		[RETAINED_SOURCE_INDEX]: sourceIndex,
	};
}

export function stripRetainedSourceIndex(
	message: Record<string, unknown>,
): Record<string, unknown> {
	const clone = { ...message } as RetainedSourceMessage;
	delete clone[RETAINED_SOURCE_INDEX];
	return clone;
}

export function parseRetainedViewState(value: unknown): RetainedViewState | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, STATE_KEYS)) return undefined;
	if (value.version !== RETAINED_VIEW_STATE_VERSION) return undefined;
	if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 256) return undefined;
	if (typeof value.policyFingerprint !== "string" || !SHA256.test(value.policyFingerprint)) return undefined;
	if (!isIndex(value.sourceCount)) return undefined;
	if (typeof value.sourceDigest !== "string" || !SHA256.test(value.sourceDigest)) return undefined;
	if (!Array.isArray(value.retainedSourceIndices) || value.retainedSourceIndices.length > value.sourceCount) return undefined;
	if (!Array.isArray(value.contentReductions) || value.contentReductions.length > value.retainedSourceIndices.length) return undefined;
	if (!Array.isArray(value.virtualEntries) || value.virtualEntries.length > 2) return undefined;

	const retainedSourceIndices: number[] = [];
	let previousSourceIndex = -1;
	for (const candidate of value.retainedSourceIndices) {
		if (!isIndex(candidate) || candidate >= value.sourceCount || candidate <= previousSourceIndex) return undefined;
		retainedSourceIndices.push(candidate);
		previousSourceIndex = candidate;
	}
	const retainedSet = new Set(retainedSourceIndices);

	const contentReductions: RetainedContentReduction[] = [];
	const reducedSources = new Set<number>();
	for (const candidate of value.contentReductions) {
		if (!isRecord(candidate) || !hasOnlyKeys(candidate, REDUCTION_KEYS) || !isIndex(candidate.sourceIndex)) return undefined;
		if (!retainedSet.has(candidate.sourceIndex) || reducedSources.has(candidate.sourceIndex)) return undefined;
		if (!Array.isArray(candidate.removedBlockIndices) || candidate.removedBlockIndices.length === 0) return undefined;
		const indices: number[] = [];
		let previousBlockIndex = -1;
		for (const index of candidate.removedBlockIndices) {
			if (!isIndex(index) || index <= previousBlockIndex) return undefined;
			indices.push(index);
			previousBlockIndex = index;
		}
		reducedSources.add(candidate.sourceIndex);
		contentReductions.push({ sourceIndex: candidate.sourceIndex, removedBlockIndices: indices });
	}
	contentReductions.sort((left, right) => left.sourceIndex - right.sourceIndex);

	const virtualEntries: RetainedVirtualEntry[] = [];
	for (const candidate of value.virtualEntries) {
		if (
			!isRecord(candidate) ||
			!hasOnlyKeys(candidate, VIRTUAL_ENTRY_KEYS) ||
			(candidate.kind !== "prune-reminder" && candidate.kind !== "pinned-slot") ||
			!isIndex(candidate.position)
		) return undefined;
		virtualEntries.push({ position: candidate.position, kind: candidate.kind });
	}
	if (!hasCanonicalVirtualEntries(virtualEntries)) return undefined;

	return {
		version: RETAINED_VIEW_STATE_VERSION,
		sessionId: value.sessionId,
		policyFingerprint: value.policyFingerprint,
		sourceCount: value.sourceCount,
		sourceDigest: value.sourceDigest,
		retainedSourceIndices,
		contentReductions,
		virtualEntries,
	};
}

export function createRetainedViewState(
	input: CreateRetainedViewStateInput,
): RetainedViewState | undefined {
	if (input.sessionId.length === 0 || input.sessionId.length > 256) return undefined;
	if (!SHA256.test(input.policyFingerprint) || !SHA256.test(input.sourceDigest)) return undefined;

	const retainedSourceIndices: number[] = [];
	const contentReductions: RetainedContentReduction[] = [];
	const virtualEntries: RetainedVirtualEntry[] = [];
	let previousSourceIndex = -1;
	let sawPruneReminder = false;
	let sawPinnedSlot = false;

	for (const message of input.outputMessages) {
		const sourceIndex = retainedSourceIndex(message);
		if (sourceIndex !== undefined) {
			if (sourceIndex >= input.rawMessages.length || sourceIndex <= previousSourceIndex) return undefined;
			retainedSourceIndices.push(sourceIndex);
			previousSourceIndex = sourceIndex;
			if (!sameContent(message.content, input.rawMessages[sourceIndex]?.content)) {
				const removed = removedBlockIndices(input.rawMessages[sourceIndex]?.content, message.content);
				if (removed === undefined) return undefined;
				contentReductions.push({ sourceIndex, removedBlockIndices: removed });
			}
			continue;
		}

		if (message.customType === PRUNE_REMINDER_CUSTOM_TYPE) {
			if (sawPruneReminder) continue;
			sawPruneReminder = true;
			virtualEntries.push({ position: retainedSourceIndices.length, kind: "prune-reminder" });
			continue;
		}
		if (input.pinnedCustomType !== undefined && message.customType === input.pinnedCustomType) {
			if (sawPinnedSlot) continue;
			sawPinnedSlot = true;
			virtualEntries.push({ position: retainedSourceIndices.length, kind: "pinned-slot" });
		}
	}

	return parseRetainedViewState({
		version: RETAINED_VIEW_STATE_VERSION,
		sessionId: input.sessionId,
		policyFingerprint: input.policyFingerprint,
		sourceCount: input.rawMessages.length,
		sourceDigest: input.sourceDigest,
		retainedSourceIndices,
		contentReductions,
		virtualEntries,
	});
}

export function reconstructRetainedView(
	input: ReconstructRetainedViewInput,
): RetainedSourceMessage[] | undefined {
	const state = parseRetainedViewState(input.state);
	if (state === undefined) return undefined;
	if (state.sessionId !== input.sessionId) return undefined;
	if (state.policyFingerprint !== input.policyFingerprint) return undefined;
	if (input.rawMessages.length < state.sourceCount) return undefined;
	if (input.currentPrefixDigest === undefined || input.currentPrefixDigest !== state.sourceDigest) return undefined;

	const retainedSet = new Set(state.retainedSourceIndices);
	for (const sourceIndex of input.requiredSourceIndices ?? []) {
		if (!isIndex(sourceIndex)) return undefined;
		if (sourceIndex < state.sourceCount && !retainedSet.has(sourceIndex)) return undefined;
	}

	const reductions = new Map(
		state.contentReductions.map((reduction) => [reduction.sourceIndex, reduction.removedBlockIndices] as const),
	);
	const protectedToolCallIds = input.protectedToolCallIds ?? new Set<string>();
	const output: RetainedSourceMessage[] = [];

	for (const virtual of state.virtualEntries) {
		if (virtual.kind === "prune-reminder") {
			output.push(createPruneReminderMessage() as unknown as RetainedSourceMessage);
		} else if (input.pinnedMessage !== undefined) {
			output.push({ ...input.pinnedMessage } as RetainedSourceMessage);
		}
	}

	for (const sourceIndex of state.retainedSourceIndices) {
		const source = input.rawMessages[sourceIndex];
		if (source === undefined) return undefined;
		const removed = reductions.get(sourceIndex);
		if (removed === undefined) {
			output.push(withRetainedSourceIndex(source, sourceIndex));
			continue;
		}
		const content = reduceSourceContent(source, removed, protectedToolCallIds);
		if (content === undefined) return undefined;
		output.push(withRetainedSourceIndex({ ...source, content }, sourceIndex));
	}

	for (let sourceIndex = state.sourceCount; sourceIndex < input.rawMessages.length; sourceIndex++) {
		output.push(withRetainedSourceIndex(input.rawMessages[sourceIndex]!, sourceIndex));
	}
	return output;
}
