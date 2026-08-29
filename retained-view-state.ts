import {
	PRUNE_REMINDER_CUSTOM_TYPE,
	createPruneReminderMessage,
	type TrimmableMessage,
} from "./policy.ts";

export const RETAINED_VIEW_CUSTOM_TYPE = "context-trimmer-retained-view";
export const RETAINED_VIEW_STATE_VERSION = 1;
export const RETAINED_SOURCE_INDEX = Symbol("context-trimmer-source-index");

export type RetainedSourceMessage = Record<string, unknown> & {
	[RETAINED_SOURCE_INDEX]?: number;
};

export type RetainedContentOverride = {
	sourceIndex: number;
	content: unknown;
};

export type RetainedVirtualEntry = {
	position: number;
	kind: "prune-reminder";
};

export type RetainedViewState = {
	version: 1;
	sessionId: string;
	policyFingerprint: string;
	sourceCount: number;
	sourceDigest: string;
	retainedSourceIndices: number[];
	contentOverrides: RetainedContentOverride[];
	virtualEntries: RetainedVirtualEntry[];
};

type CreateRetainedViewStateInput = {
	sessionId: string;
	policyFingerprint: string;
	sourceDigest: string;
	rawMessages: ReadonlyArray<Record<string, unknown>>;
	outputMessages: ReadonlyArray<Record<string, unknown>>;
};

type ReconstructRetainedViewInput = {
	state: unknown;
	sessionId: string;
	policyFingerprint: string;
	currentPrefixDigest: string | undefined;
	rawMessages: ReadonlyArray<Record<string, unknown>>;
};

const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isContent(value: unknown): boolean {
	return typeof value === "string" || Array.isArray(value);
}

function sameContent(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
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
	if (!isRecord(value) || value.version !== RETAINED_VIEW_STATE_VERSION) return undefined;
	if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 256) return undefined;
	if (typeof value.policyFingerprint !== "string" || !SHA256.test(value.policyFingerprint)) return undefined;
	if (!isIndex(value.sourceCount)) return undefined;
	if (typeof value.sourceDigest !== "string" || !SHA256.test(value.sourceDigest)) return undefined;
	if (!Array.isArray(value.retainedSourceIndices) || value.retainedSourceIndices.length > value.sourceCount) return undefined;
	if (!Array.isArray(value.contentOverrides) || value.contentOverrides.length > value.retainedSourceIndices.length) return undefined;
	if (!Array.isArray(value.virtualEntries) || value.virtualEntries.length > 1) return undefined;

	const retainedSourceIndices: number[] = [];
	let previous = -1;
	for (const candidate of value.retainedSourceIndices) {
		if (!isIndex(candidate) || candidate >= value.sourceCount || candidate <= previous) return undefined;
		retainedSourceIndices.push(candidate);
		previous = candidate;
	}
	const retainedSet = new Set(retainedSourceIndices);

	const contentOverrides: RetainedContentOverride[] = [];
	const overrideIndices = new Set<number>();
	for (const candidate of value.contentOverrides) {
		if (!isRecord(candidate) || !isIndex(candidate.sourceIndex)) return undefined;
		if (!retainedSet.has(candidate.sourceIndex) || overrideIndices.has(candidate.sourceIndex)) return undefined;
		if (!isContent(candidate.content)) return undefined;
		overrideIndices.add(candidate.sourceIndex);
		contentOverrides.push({ sourceIndex: candidate.sourceIndex, content: candidate.content });
	}
	contentOverrides.sort((left, right) => left.sourceIndex - right.sourceIndex);

	const virtualEntries: RetainedVirtualEntry[] = [];
	for (const candidate of value.virtualEntries) {
		if (!isRecord(candidate) || candidate.kind !== "prune-reminder") return undefined;
		if (!isIndex(candidate.position) || candidate.position > retainedSourceIndices.length) return undefined;
		virtualEntries.push({ position: candidate.position, kind: "prune-reminder" });
	}

	return {
		version: RETAINED_VIEW_STATE_VERSION,
		sessionId: value.sessionId,
		policyFingerprint: value.policyFingerprint,
		sourceCount: value.sourceCount,
		sourceDigest: value.sourceDigest,
		retainedSourceIndices,
		contentOverrides,
		virtualEntries,
	};
}

export function createRetainedViewState(
	input: CreateRetainedViewStateInput,
): RetainedViewState | undefined {
	if (input.sessionId.length === 0 || input.sessionId.length > 256) return undefined;
	if (!SHA256.test(input.policyFingerprint) || !SHA256.test(input.sourceDigest)) return undefined;

	const retainedSourceIndices: number[] = [];
	const contentOverrides: RetainedContentOverride[] = [];
	const virtualEntries: RetainedVirtualEntry[] = [];
	let previous = -1;
	let sawPruneReminder = false;

	for (const message of input.outputMessages) {
		const sourceIndex = retainedSourceIndex(message);
		if (sourceIndex !== undefined) {
			if (sourceIndex >= input.rawMessages.length || sourceIndex <= previous) return undefined;
			retainedSourceIndices.push(sourceIndex);
			previous = sourceIndex;
			if (!sameContent(message.content, input.rawMessages[sourceIndex]?.content)) {
				if (!isContent(message.content)) return undefined;
				contentOverrides.push({ sourceIndex, content: message.content });
			}
			continue;
		}

		if (message.customType === PRUNE_REMINDER_CUSTOM_TYPE) {
			if (sawPruneReminder) continue;
			sawPruneReminder = true;
			virtualEntries.push({ position: retainedSourceIndices.length, kind: "prune-reminder" });
		}
	}

	return {
		version: RETAINED_VIEW_STATE_VERSION,
		sessionId: input.sessionId,
		policyFingerprint: input.policyFingerprint,
		sourceCount: input.rawMessages.length,
		sourceDigest: input.sourceDigest,
		retainedSourceIndices,
		contentOverrides,
		virtualEntries,
	};
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

	const overrides = new Map(
		state.contentOverrides.map((override) => [override.sourceIndex, override.content] as const),
	);
	const virtualByPosition = new Map<number, RetainedSourceMessage[]>();
	for (const virtual of state.virtualEntries) {
		const entries = virtualByPosition.get(virtual.position) ?? [];
		entries.push(createPruneReminderMessage() as unknown as RetainedSourceMessage);
		virtualByPosition.set(virtual.position, entries);
	}

	const output: RetainedSourceMessage[] = [];
	for (let position = 0; position <= state.retainedSourceIndices.length; position++) {
		for (const virtual of virtualByPosition.get(position) ?? []) output.push(virtual);
		if (position === state.retainedSourceIndices.length) continue;
		const sourceIndex = state.retainedSourceIndices[position]!;
		const source = input.rawMessages[sourceIndex];
		if (source === undefined) return undefined;
		const content = overrides.get(sourceIndex);
		output.push(withRetainedSourceIndex(
			content === undefined ? source : { ...source, content },
			sourceIndex,
		));
	}

	for (let sourceIndex = state.sourceCount; sourceIndex < input.rawMessages.length; sourceIndex++) {
		output.push(withRetainedSourceIndex(input.rawMessages[sourceIndex]!, sourceIndex));
	}
	return output;
}
