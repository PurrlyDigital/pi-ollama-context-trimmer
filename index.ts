// ─── Context Trimmer extension wiring (three-tier amended design) ───────
//
// The extension trims an LLM-bound message stream against a three-tier
// budget:
//
//   0–50k trimmable tokens  → verbatim, no action.
//   50k–100k                → hold middle-band messages untouched
//                              (transient behavior; Tier 3 catches
//                              oversize if it grows further).
//   100k+                   → hard-drop the oldest whole turns
//                              (user+assistant+tool+custom) until
//                              back under 100k.
//
// Subagent protected inputs (subagent-only, excluded from the
// 50k/100k budget, never dropped):
//
//   1. The agent def / pinned-tier synthetic. In this implementation
//      the agent def travels as a `customType: "context-trimmer-pinned"`
//      synthetic message IN the `messages` array. The trim policy
//      protects it via the `protectedCustomTypes` option. (The system
//      prompt can also travel as a separate field on the LLM call;
//      that channel is implicitly protected because the trim policy
//      only ever sees the trimmable `messages` array.)
//
//   2. The dispatch instructions. The first user message carries
//      the dispatch task; it is identified by `userTurnAge === 0`
//      and protected by the trim policy directly.
//
// The `pinned-tier.ts` module owns the pinned content (personality)
// and exposes `buildPinnedMessage()`. The wiring below stamps
// `userTurnAge` on every message, prepends the pinned message, calls
// the trim policy, and returns the result.
//
// ─── Config (two channels, env wins over file) ────────────────────────
//
// The trimmer is operator-opted-in. Two config channels, fixed
// precedence (highest first):
//
//   1. Environment variables (`PI_CONTEXT_TRIMMER_*`) — useful for
//      ad-hoc runs, CI, and tests. See `config.ts` for the names.
//   2. Global config file `~/.pi/agent/context-trimmer.json` — the
//      persistent, filesystem-based channel. This is the channel that
//      works when pi is launched by systemd (or any non-interactive
//      supervisor) that does not inherit the operator's shell
//      environment.
//
// All file I/O and `process.env` access lives here in the wiring
// layer; `config.ts` (parse + resolve) and `pinned-tier.ts` stay
// process-free and node-I/O-free.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
	applyIntercomKeepLast,
	findDuplicateSkillReadIds,
	applyReasoningBlockCap,
	applySubagentNotifyKeepLast,
	applyThreeTierTrim,
	approximateMessageTokens,
	approximateTextTokens,
	computeFlatInputTokenSignal,
	dedupSubagentNotify,
	detectConsecutiveIdenticalToolCalls,
	extractText,
	isPathPreserved,
	keepLatestSubagentToolResult,
	LOOP_GUARD_BLOCK_TEXT,
	LOOP_GUARD_NUDGE_TEXT,
	REASONING_BLOCK_CAP_DEFAULT,
	SUMMARIZE_TIER_MAX_TOKENS,
	VERBATIM_TIER_MAX_TOKENS,
	shouldHardBlock,
	type TrimmableMessage,
} from "./policy.ts";
import { createPinnedTier, PINNED_CUSTOM_TYPE } from "./pinned-tier.ts";
import {
	resolveConfig,
	parseConfigFile,
	DEFAULT_INTERCOM_KEEP_LAST,
	ENV,
	type ContextTrimmerConfig,
	type LoopGuardMode,
	type ProtectDispatchMode,
} from "./config.ts";
import {
	stampSourcePath,
	rederiveStamp,
	PRESERVED_CUSTOM_TYPE,
} from "./path-stamp.ts";
import {
	RETAINED_VIEW_CUSTOM_TYPE,
	createRetainedViewState,
	parseRetainedViewState,
	reconstructRetainedView,
	retainedSourceIndex,
	stripRetainedSourceIndex,
	withRetainedSourceIndex,
	type RetainedSourceMessage,
	type RetainedViewState,
} from "./retained-view-state.ts";

// ─── Per-message stamp: userTurnAge ────────────────────────────────────

/**
 * Stamp `userTurnAge` (the user-turn index) on every message. The
 * first user message in the array gets `userTurnAge === 0` and is
 * the protected dispatch slot. The counter increments on each
 * subsequent user message. Non-user messages inherit the most
 * recent `userTurnAge`. The stamp is the source of truth for the
 * dispatch-task protection.
 *
 * The stamp is computed at view time and is a pure function of the
 * input message order — no session state is consulted. This makes
 * the trim path deterministic and easy to test.
 */
function stampUserTurnAge<T extends { role: string }>(messages: ReadonlyArray<T>): Array<T & { userTurnAge: number }> {
	const out: Array<T & { userTurnAge: number }> = [];
	let userTurnAge = 0;
	let lastUserTurnAge = 0;
	for (const m of messages) {
		const stamped = { ...m, userTurnAge: 0 } as T & { userTurnAge: number };
		if (m.role === "user") {
			stamped.userTurnAge = userTurnAge;
			lastUserTurnAge = userTurnAge;
			userTurnAge += 1;
		} else {
			// Non-user messages inherit the most recent user-turn age
			// (or 0 if no user message has been seen yet).
			stamped.userTurnAge = lastUserTurnAge;
		}
		out.push(stamped);
	}
	return out;
}

type PriorOutbound = {
	sessionId: string;
	sourceCount: number;
	sourceDigest: string;
	promptCharacters: number;
	modelIdentity?: string;
};

function usableAssistantUsage(msg: Record<string, unknown>): { promptTokens: number } | undefined {
	if (msg.role !== "assistant") return undefined;
	const stopReason = msg.stopReason;
	if (stopReason === "aborted" || stopReason === "error") return undefined;
	const usage = msg.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const fields = usage as Record<string, unknown>;
	const input = fields.input;
	if (typeof input !== "number" || !Number.isFinite(input) || input < 0) return undefined;
	let promptTokens = input;
	for (const field of ["cacheRead", "cacheWrite"] as const) {
		const value = fields[field];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
		promptTokens += value;
	}
	return Number.isFinite(promptTokens) && promptTokens > 0 ? { promptTokens } : undefined;
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string | undefined {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? undefined : hashText(encoded);
	} catch {
		return undefined;
	}
}

function rawMessageIdentities(
	messages: ReadonlyArray<Record<string, unknown>>,
): string[] | undefined {
	const identities: string[] = [];
	for (const message of messages) {
		if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return undefined;
		const identity = hashJson(message);
		if (identity === undefined) return undefined;
		identities.push(identity);
	}
	return identities;
}

function identityDigest(
	identities: ReadonlyArray<string> | undefined,
	count: number,
): string | undefined {
	if (identities === undefined || !Number.isSafeInteger(count) || count < 0 || count > identities.length) {
		return undefined;
	}
	return hashJson(identities.slice(0, count));
}

function contextModelIdentity(ctx: ExtensionContext): string | undefined {
	const model = (ctx as unknown as { model?: { provider?: unknown; id?: unknown } }).model;
	if (typeof model?.provider !== "string" || typeof model.id !== "string") return undefined;
	return `${model.provider}/${model.id}`;
}

function assistantModelIdentity(message: Record<string, unknown>): string | undefined {
	if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
	return `${message.provider}/${message.model}`;
}

function derivePairedCalibratedDivisor(
	rawMessages: ReadonlyArray<Record<string, unknown>>,
	identities: ReadonlyArray<string> | undefined,
	sessionId: string,
	currentModelIdentity: string | undefined,
	prior: PriorOutbound | undefined,
): number | undefined {
	if (prior === undefined || prior.sessionId !== sessionId) return undefined;
	if (identityDigest(identities, prior.sourceCount) !== prior.sourceDigest) return undefined;
	const assistants = rawMessages
		.slice(prior.sourceCount)
		.filter((message) => message.role === "assistant");
	if (assistants.length !== 1) return undefined;
	const assistant = assistants[0]!;
	const usage = usableAssistantUsage(assistant);
	if (usage === undefined) return undefined;
	const responseModelIdentity = assistantModelIdentity(assistant);
	if (prior.modelIdentity !== undefined && responseModelIdentity !== prior.modelIdentity) return undefined;
	if (prior.modelIdentity !== undefined && currentModelIdentity !== undefined && currentModelIdentity !== prior.modelIdentity) {
		return undefined;
	}
	const divisor = prior.promptCharacters / usage.promptTokens;
	return Number.isFinite(divisor) && divisor > 0 ? divisor : undefined;
}

function outboundPromptCharacters(
	messages: ReadonlyArray<Record<string, unknown>>,
	systemPrompt: string,
): number {
	let characters = systemPrompt.length;
	for (const message of messages) characters += extractText(message.content).length;
	return characters;
}

// ─── Config file reader (the only file-I/O for config) ─────────────────

/** Default global config file location. */
const DEFAULT_CONFIG_PATH = join(homedir(), ".pi/agent/context-trimmer.json");

/** Env var that overrides the config file path (test seam + operators
 *  who keep their config elsewhere). Unset → `DEFAULT_CONFIG_PATH`. */
const CONFIG_PATH_ENV = "PI_CONTEXT_TRIMMER_CONFIG_PATH";

/**
 * Expand a list of preserved-path patterns at the wiring layer. The
 * only `~/` expansion in the codebase lives here (the pure predicate
 * in `policy.ts` never reads `os.homedir()` — it receives the
 * expanded pattern as input). Patterns that do not begin with `~/`
 * pass through unchanged; patterns that begin with `~/` have the
 * leading `~/` replaced with the operator's home directory. Empty
 * or undefined patterns yield an empty list.
 */
function expandPreservedPaths(
	patterns: ReadonlyArray<string> | undefined,
	home: string,
): ReadonlyArray<string> {
	if (!patterns || patterns.length === 0) return [];
	const out: string[] = [];
	for (const p of patterns) {
		if (typeof p !== "string" || p.length === 0) continue;
		if (p.startsWith("~/")) {
			out.push(home + p.slice(1));
		} else if (p === "~") {
			out.push(home);
		} else {
			out.push(p);
		}
	}
	return out;
}

/**
 * Read and parse the config file best-effort. Missing file, parse
 * error, or bad shape all degrade to an empty partial (the resolver
 * falls back to env / defaults). Never throws — config hiccups must
 * not block the LLM call.
 */
function readConfigFile(path: string | undefined): ReturnType<typeof parseConfigFile> {
	if (!path || !existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		return parseConfigFile(JSON.parse(raw));
	} catch {
		return {};
	}
}

/**
 * Pure-evaluating (no I/O, no `process.*`) protected-toolCall-id
 * extractor. Walks every assistant message's content blocks; for
 * every `type: "toolCall"` block whose `arguments` carries a `path`
 * field, runs the existing pure `isPathPreserved` predicate against
 * the (already `~/`-expanded) `preservedPatterns`. When the path
 * matches, the block's `id` is added to the returned set.
 *
 * The set is the call-arg→result identification source the
 * re-scoped bundle names. The wiring layer is the sole source of
 * the set — the pure `policy.ts` module never reads
 * `arguments.path` directly (purity contract). The protected
 * `toolResult` messages whose `toolCallId` is in the set are kept
 * by association via the `isProtectedSlot` branch added in
 * `policy.ts`. The matching `toolCall` block survives inside its
 * assistant message via the block-level carve-out in
 * `dropOldestTurns`. The
 * `path-stamp.ts` `details.sourcePath` seam remains the
 * resume-compatibility fallback (an older `toolResult` whose
 * matching `toolCall` was in a prior turn and was re-derivable via
 * the persisted stamp).
 *
 * Returns an empty set when `preservedPatterns` is empty, when no
 * `toolCall` block matches, or when the input is empty. The set
 * is a `Set<string>` (not `ReadonlySet<string>`) because the
 * caller may want to inspect it; the policy's `TrimOptions` field
 * accepts `ReadonlySet<string>` so the same set threads through.
 */
function extractProtectedToolCallIds(
	base: ReadonlyArray<TrimmableMessage>,
	preservedPatterns: ReadonlyArray<string>,
): Set<string> {
	const out = new Set<string>();
	if (preservedPatterns.length === 0) return out;
	for (const m of base) {
		if (m.role !== "assistant") continue;
		const content = m.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const obj = block as { type?: unknown; id?: unknown; arguments?: unknown };
			if (obj.type !== "toolCall") continue;
			// Extract the path named in the call's `arguments.path`
			// (the canonical shape per the Gate 4 evidence: the
			// `read` tool's argument is `{ path: <sourcePath> }`).
			// Other argument shapes (e.g. `get_file`, shell `cat`)
			// would carry an equivalent field; the operator's
			// `preservedPatterns` matches against whatever path
			// the call's arguments name. The path field is read
			// defensively so an arbitrary `arguments` shape does
			// not crash the wiring.
			const args = obj.arguments;
			if (!args || typeof args !== "object") continue;
			const pathField = (args as Record<string, unknown>).path;
			if (typeof pathField !== "string" || pathField.length === 0) continue;
			if (!isPathPreserved(pathField, preservedPatterns)) continue;
			const id = obj.id;
			if (typeof id === "string" && id.length > 0) {
				out.add(id);
			}
		}
	}
	return out;
}

// ─── Extension entry point ─────────────────────────────────────────────

/**
 * The default-exported extension function. Registers:
 *   - `session_start` to initialize the pinned-tier caches.
 *   - `turn_end` to refresh the pinned-tier.
 *   - `context` to do the three-tier trim on every LLM call.
 *
 * Config is resolved once at load from the config file + env (env
 * wins). To pick up a config-file edit, restart pi. Pinned content
 * is opt-in: when `personalityPath` does not resolve to content,
 * `buildPinnedMessage()` returns `null` and the context handler skips
 * the pinned injection entirely.
 *
 * Dispatch protection (exempting the first user message from the
 * trim budget) is controlled by `protectDispatch` in the config:
 *   - `"auto"` (default) — ON when the `pi-subagents` extension is
 *     installed, detected lazily via its registered `subagent` tool.
 *   - `true` / env `"1"` — always ON.
 *   - `false` / env `"0"` — always OFF.
 */
export default function contextTrimmerExtension(pi: ExtensionAPI): void {
	const configPath = process.env[CONFIG_PATH_ENV] ?? DEFAULT_CONFIG_PATH;
	const file = readConfigFile(configPath);
	const cfg: ContextTrimmerConfig = resolveConfig({ file, env: process.env });

	const pinnedTier = createPinnedTier({
		personalityPath: cfg.personalityPath,
	});

	// Subagent-context pin decision. Resolved once at load — the
	// inputs (the `PI_SUBAGENT_CHILD` env var + the resolved
	// `pinSubagent` config field) are stable for the session, and
	// resolving per-call would just repeat the same boolean. The
	// decision is: skip the pin in child sessions UNLESS an override
	// channel has re-enabled it. Default-off for child/subagent
	// sessions prevents the parent PM persona from crossing the
	// dispatch boundary. The env var is read here (the wiring
	// layer) rather than in `config.ts` (the pure module) per the
	// purity contract — `config.ts` only receives the value through
	// `process.env` carried by the `env: process.env` arg that
	// `resolveConfig` already accepts.
	const isChildSession = process.env.PI_SUBAGENT_CHILD === "1";
	const shouldPinForCurrentContext = !isChildSession || cfg.pinSubagent === true;

	// Dispatch-protection resolution. Resolved lazily on the first
	// `context` call (by then every extension, including pi-subagents,
	// has loaded and `pi.getAllTools()` reflects the full tool set) and
	// cached for the session. An explicit true/false short-circuits
	// detection; `"auto"` defers to the pi-subagents tool probe.
	let protectDispatchResolved: boolean | undefined;
	function resolveProtectDispatch(): boolean {
		if (protectDispatchResolved !== undefined) return protectDispatchResolved;
		const mode: ProtectDispatchMode = cfg.protectDispatch;
		if (mode === true) {
			protectDispatchResolved = true;
		} else if (mode === false) {
			protectDispatchResolved = false;
		} else {
			// pi-subagents registers a tool named "subagent". Its
			// presence in the configured tool set means the extension
			// is installed and active — the signal that dispatch
			// protection applies. `getAllTools()` reflects configured
			// tools (independent of the active-tool toggle), so a
			// disabled-but-installed subagent tool still enables
			// protection.
			const tools = safeGetAllTools(pi);
			protectDispatchResolved = tools.some((t) => t?.name === "subagent");
		}
		return protectDispatchResolved;
	}

	// Loop-guard resolution. Resolved lazily on the first `context`
	// call and cached for the session. The guard is universal across
	// session postures — the previous `"auto"` posture probed
	// `pi-subagents` to detect subagent sessions, but behavioral-loop
	// detection is the same concern in every session type, so the
	// auto/subagent-tool coupling was dropped. `true` (default)
	// turns the guard ON for every session; `false` turns it off.
	// Operators opt out with `false` (env `PI_CONTEXT_TRIMMER_LOOP_GUARD=0`
	// or `"loopGuard": false` in the config file).
	let loopGuardResolved: boolean | undefined;
	function resolveLoopGuard(): boolean {
		if (loopGuardResolved !== undefined) return loopGuardResolved;
		const mode: LoopGuardMode = cfg.loopGuard ?? true;
		loopGuardResolved = mode === true;
		return loopGuardResolved;
	}

	// Tier-2 cleanup extension gates resolve lazily and remain fixed for
	// the session. The local trim policy must reach Tier 2 before either
	// gate can authorize content cleanup. `intercomInstalled` controls
	// Rules 1 and 2. `subagentsInstalled` controls Rule 3.
	let intercomInstalledResolved: boolean | undefined;
	function resolveIntercomInstalled(): boolean {
		if (intercomInstalledResolved !== undefined) return intercomInstalledResolved;
		const tools = safeGetAllTools(pi);
		intercomInstalledResolved = tools.some((t) => t?.name === "intercom");
		return intercomInstalledResolved;
	}
	let subagentsInstalledResolved: boolean | undefined;
	function resolveSubagentsInstalled(): boolean {
		if (subagentsInstalledResolved !== undefined) return subagentsInstalledResolved;
		const tools = safeGetAllTools(pi);
		subagentsInstalledResolved = tools.some((t) => t?.name === "subagent");
		return subagentsInstalledResolved;
	}

	// Loop-guard thresholds. `Math.trunc` integer coercion matches
	// the `summaWords` precedent in this file. Default nudge
	// threshold is 3; hard-block defaults to off. The
	// `hardBlockThreshold >= loopGuardThreshold` invariant is
	// enforced at the wiring layer (the predicate in `policy.ts`
	// does not check it): clamp `loopGuardHardBlock` up to
	// `loopGuardThreshold` when the operator sets a value below
	// the nudge threshold, so the hard-block never fires before
	// the soft-nudge.
	const loopGuardThreshold = cfg.loopGuardThreshold !== undefined ? Math.trunc(cfg.loopGuardThreshold) : 3;
	const rawHardBlock = cfg.loopGuardHardBlock !== undefined ? Math.trunc(cfg.loopGuardHardBlock) : undefined;
	const loopGuardHardBlock =
		rawHardBlock !== undefined && rawHardBlock < loopGuardThreshold ? loopGuardThreshold : rawHardBlock;
	const runtimeSessionId = `runtime:${randomUUID()}`;
	let retainedViewState: RetainedViewState | undefined;
	let priorOutbound: PriorOutbound | undefined;

	function sessionInfo(ctx: ExtensionContext): { id: string; persistable: boolean } {
		const manager = (ctx as unknown as {
			sessionManager?: { getSessionId?: () => string; getBranch?: () => unknown[] };
		}).sessionManager;
		try {
			const id = manager?.getSessionId?.();
			if (typeof id === "string" && id.length > 0) {
				return { id, persistable: typeof manager?.getBranch === "function" };
			}
		} catch {
			return { id: runtimeSessionId, persistable: false };
		}
		return { id: runtimeSessionId, persistable: false };
	}

	function restoreRetainedView(ctx: ExtensionContext): void {
		priorOutbound = undefined;
		retainedViewState = undefined;
		const manager = (ctx as unknown as {
			sessionManager?: { getSessionId?: () => string; getBranch?: () => unknown[] };
		}).sessionManager;
		if (typeof manager?.getSessionId !== "function" || typeof manager.getBranch !== "function") return;
		try {
			const sessionId = manager.getSessionId();
			for (const entry of manager.getBranch()) {
				if (
					typeof entry !== "object" ||
					entry === null ||
					(entry as { type?: unknown }).type !== "custom" ||
					(entry as { customType?: unknown }).customType !== RETAINED_VIEW_CUSTOM_TYPE
				) continue;
				const parsed = parseRetainedViewState((entry as { data?: unknown }).data);
				retainedViewState = parsed?.sessionId === sessionId ? parsed : undefined;
			}
		} catch {
			retainedViewState = undefined;
		}
	}

	function policyFingerprint(expandedPreservedPatterns: ReadonlyArray<string>): string {
		return hashJson({
			config: cfg,
			tier1MaxTokens: cfg.tier1MaxTokens ?? VERBATIM_TIER_MAX_TOKENS,
			tier2MaxTokens: cfg.tier2MaxTokens ?? SUMMARIZE_TIER_MAX_TOKENS,
			tokenEstimatorDivisor: cfg.tokenEstimatorDivisor ?? TOKEN_ESTIMATOR_DIVISOR_DEFAULT,
			protectDispatch: resolveProtectDispatch(),
			pinCurrentContext: shouldPinForCurrentContext,
			loopGuard: resolveLoopGuard(),
			loopGuardThreshold,
			loopGuardHardBlock: loopGuardHardBlock ?? null,
			intercomInstalled: resolveIntercomInstalled(),
			subagentsInstalled: resolveSubagentsInstalled(),
			expandedPreservedPatterns: [...expandedPreservedPatterns].sort(),
		}) ?? hashText("context-trimmer-policy-unavailable");
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreRetainedView(ctx);
		pinnedTier.refresh();
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreRetainedView(ctx);
	});

	pi.on("model_select", async () => {
		priorOutbound = undefined;
	});

	pi.on("session_compact", async () => {
		priorOutbound = undefined;
		retainedViewState = undefined;
	});

	pi.on("turn_end", async () => {
		pinnedTier.refresh();
		pinnedTier.bumpTurn();
	});

	pi.on("context", async (event, ctx) => {
		const rawMessages = (event.messages ?? []) as unknown as ReadonlyArray<Record<string, unknown>>;
		const identities = rawMessageIdentities(rawMessages);
		const fullSourceDigest = identityDigest(identities, rawMessages.length);
		const currentSession = sessionInfo(ctx);
		const expandedPreservedPatterns = expandPreservedPaths(cfg.preservedPaths, homedir());
		const currentPolicyFingerprint = policyFingerprint(expandedPreservedPatterns);
		const pinned = shouldPinForCurrentContext ? pinnedTier.buildPinnedMessage() : null;
		const pinnedMessage: TrimmableMessage | undefined = pinned
			? { role: "custom", content: pinned.content, customType: PINNED_CUSTOM_TYPE }
			: undefined;
		let retainedPinnedSlot = false;
		let sourceMessages: RetainedSourceMessage[] = rawMessages.map((message, sourceIndex) =>
			withRetainedSourceIndex(message, sourceIndex),
		);
		if (retainedViewState !== undefined) {
			const reconstructed = reconstructRetainedView({
				state: retainedViewState,
				sessionId: currentSession.id,
				policyFingerprint: currentPolicyFingerprint,
				currentPrefixDigest: identityDigest(identities, retainedViewState.sourceCount),
				rawMessages,
				pinnedMessage,
			});
			if (reconstructed === undefined) retainedViewState = undefined;
			else {
				sourceMessages = reconstructed;
				retainedPinnedSlot = retainedViewState.virtualEntries.some((entry) => entry.kind === "pinned-slot");
			}
		}
		sourceMessages = sourceMessages.filter(
			(message) => message.customType !== RETAINED_VIEW_CUSTOM_TYPE,
		);
		// Capture the fully assembled system prompt the LLM will see
		// for this turn, then approximate its token count using the
		// same text-level estimator the policy uses for message
		// tokens (so the trimmer's view of the system prompt and its
		// view of the messages are on the same scale). The
		// `getSystemPrompt()` guard mirrors the existing
		// `ctx?.hasUI` optional-chaining pattern: when the method is
		// absent (test mocks pass `{}` as `ctx`, where `hasUI` is
		// `undefined`; same shape for `getSystemPrompt`), the string
		// defaults to `""` and the token count is 0 — no crash, no
		// NaN. The harness-derived value threads into
		// `applyThreeTierTrim` as the new `systemPromptTokens` field
		// (AC-2, AC-5 — purity contract holds: the policy never
		// reads `ctx` or `getSystemPrompt`).
		const systemPromptString = typeof (ctx as { getSystemPrompt?: unknown } | null | undefined)?.getSystemPrompt === "function"
			? (ctx as { getSystemPrompt: () => string }).getSystemPrompt()
			: "";
		// Resolve the operator-configured estimator divisor. `cfg.tokenEstimatorDivisor`
		// is `undefined` when the operator did not set the env var or
		// JSON key; the wiring layer applies the policy's
		// compile-time default `TOKEN_ESTIMATOR_DIVISOR_DEFAULT = 3`
		// (AC-3, AC-4). The `Math.trunc` integer coercion matches
		// the `summaWords` precedent in this file:
		// `isPositiveNumber` accepts floats, so a fractional JSON
		// value (e.g. `3.5`) would survive validation; `Math.trunc`
		// enforces the integer contract the policy expects. NaN
		// cannot arrive from the validated channels (`isPositiveNumber`
		// rejects NaN), so the `??` fallback is unreachable for
		// NaN. The resolved divisor is reused at the
		// `applyThreeTierTrim` call site AND the two
		// `approximateMessageTokens` call sites in the
		// background-promise `.then()` — hoisted to a single const.
		const tokenEstimatorDivisor =
			cfg.tokenEstimatorDivisor !== undefined ? Math.trunc(cfg.tokenEstimatorDivisor) : TOKEN_ESTIMATOR_DIVISOR_DEFAULT;
		const calibratedDivisor = derivePairedCalibratedDivisor(
			rawMessages,
			identities,
			currentSession.id,
			contextModelIdentity(ctx),
			priorOutbound,
		);
		const effectiveDivisor = calibratedDivisor ?? tokenEstimatorDivisor;
		const systemPromptTokens = approximateTextTokens(systemPromptString, effectiveDivisor);
		const stampedAges = stampUserTurnAge(
			rawMessages.map((message) => ({ role: String(message.role ?? "user") })),
		);
		// Stamp each trimmable message with its source path so the
		// preserved-paths predicate (pure, in `policy.ts`) can match
		// by `details.sourcePath`. The source path is the union of:
		//   1. `m.details.sourcePath` if the source message carried
		//      one (e.g. a tool result that already shipped with a
		//      source-path stamp from the tool-dispatch path).
		//   2. The re-derived stamp for `m.toolCallId` (a tool result
		//      that arrived on a prior turn and was persisted via
		//      `persistStamp`).
		// Either path yields the source path; the first non-empty
		// wins. The stamp is on `details.sourcePath` (the locked
		// decision — `details` over a new top-level field).
		const base: TrimmableMessage[] = sourceMessages.map((m) => {
			const sourceIndex = retainedSourceIndex(m);
			if (sourceIndex === undefined) {
				return {
					...m,
					role: String(m.role ?? "user") as TrimmableMessage["role"],
					content: m.content,
					customType: typeof m.customType === "string" ? m.customType : undefined,
				} as TrimmableMessage;
			}
			// Source-path extraction: read from `details.sourcePath` first,
			// fall back to the re-derived stamp for `m.toolCallId`.
			const detailsObj = m.details;
			let sourcePath: string | undefined;
			if (detailsObj && typeof detailsObj === "object") {
				const fromDetails = (detailsObj as Record<string, unknown>).sourcePath;
				if (typeof fromDetails === "string" && fromDetails.length > 0) {
					sourcePath = fromDetails;
				}
			}
			if (sourcePath === undefined) {
				const toolCallId = (m as { toolCallId?: unknown }).toolCallId;
				if (typeof toolCallId === "string" && toolCallId.length > 0) {
					sourcePath = rederiveStamp(toolCallId);
				}
			}
			// Build the trimmable message: spread the source (to
			// preserve all pi-specific fields), then layer the trim
			// stamps on top. The source-path stamp goes via the seam
			// helper so the type contract is enforced.
			const stamped = stampSourcePath(
				m as RetainedSourceMessage & { details?: Record<string, unknown> },
				sourcePath,
			) as TrimmableMessage;
			const sourceAge = stampedAges[sourceIndex];
			const trimmable: TrimmableMessage = {
				...stamped,
				role: String(m.role ?? "user") as TrimmableMessage["role"],
				content: m.content,
				userTurnAge: sourceAge?.userTurnAge,
				customType: typeof m.customType === "string" ? m.customType : undefined,
			};
			return trimmable;
		});
		const duplicateSkillReadIds = findDuplicateSkillReadIds(base);
		// When a trimmable message's source path matches a preserved
		// pattern, stamp it with the `PRESERVED_CUSTOM_TYPE` so the
		// existing `protectedCustomTypes` channel protects it. The
		// new channel rides the same machinery; no parallel
		// accounting path needed (per the landscape's "Surrounding-
		// code reality check" note).
		const protectedTypes = new Set<string>([PINNED_CUSTOM_TYPE]);
		if (expandedPreservedPatterns.length > 0) {
			for (const m of base) {
				const sourcePath = (m.details as Record<string, unknown> | undefined)?.sourcePath;
				if (typeof sourcePath === "string" && sourcePath.length > 0) {
					if (isPathPreserved(sourcePath, expandedPreservedPatterns)) {
						m.customType = PRESERVED_CUSTOM_TYPE;
					}
				}
			}
			protectedTypes.add(PRESERVED_CUSTOM_TYPE);
		}
		// Pair-atomic toolCall/toolResult protection: extract the
		// protected-toolCall-id set from the assistant messages'
		// `toolCall` blocks. The set is computed by matching each
		// block's `arguments.path` against the (already `~/`-expanded)
		// `preservedPatterns`; matching blocks contribute their `id`
		// to the set. The set threads into the pure policy as
		// `protectedToolCallIds: ReadonlySet<string>` and drives:
		//   (a) the additive-OR `isProtectedSlot` branch for the
		//       matching `toolResult` messages (kept by association,
		//       excluded from the budget, never dropped/summarized),
		//   (b) the block-level carve-out in `dropOldestTurns` (the protected
		//       `toolCall` block survives inside the dropped
		//       assistant message; `text`/`thinking` and unprotected
		//       `toolCall` blocks are dropped).
		// Compute this before the reset and cleanup passes so it reflects
		// the tool calls the model emitted in the current source stream.
		const protectedToolCallIds = extractProtectedToolCallIds(base, expandedPreservedPatterns);
		// The policy sees the complete current stream. It alone decides
		// whether the local estimate reached Tier 2 before any content
		// transform can run.
		const withPinned: TrimmableMessage[] = pinnedMessage !== undefined && !retainedPinnedSlot
			? [pinnedMessage, ...base]
			: base;
		// Run the three-tier trim against the complete local stream. The
		// pinned synthetic and any preserved-path message are excluded from
		// the budget via `protectedCustomTypes`. Dispatch protection
		// is resolved from config (auto/true/false). The preserved-
		// paths channel is resolved from config (`preservedPaths`),
		// with `~/` expanded at the wiring layer to the operator's
		// home directory (the pure predicate receives the expanded
		// pattern; it never reads `os.homedir()` itself).
		// Drop-floor: use the configured tier 1 token limit as the
		// sole floor authority. The policy subtracts system-prompt and
		// permanently protected mass before applying this floor.
		const dropFloorTokens = Math.trunc(cfg.tier1MaxTokens ?? VERBATIM_TIER_MAX_TOKENS);
		// Keep-last-user-prompts: integer-coerced count passed through
		// to the policy. Per AC-4 the wiring-layer default is `10` (the
		// operator-facing default the ticket title commits to) when
		// neither env nor JSON sets a value; the config.ts field stays
		// `undefined` so the config-resolver test surface is honest about
		// the unset-channel path.
		const keepLastUserPrompts =
			cfg.keepLastUserPrompts !== undefined ? Math.trunc(cfg.keepLastUserPrompts) : 10;
		// Keep-original-prompt: boolean governing permanent dispatch-slot
		// protection on the first user prompt. Default `true` preserves
		// the current dispatch behavior; `false` makes the original
		// eligible for oldest-first trimming above tier 2.
		const keepOriginalPrompt = cfg.keepOriginalPrompt ?? true;
		const result = await applyThreeTierTrim(withPinned, {
			verbatimMaxTokens: cfg.tier1MaxTokens,
			summarizeMaxTokens: cfg.tier2MaxTokens,
			dropFloorTokens,
			protectedCustomTypes: protectedTypes,
			protectDispatch: resolveProtectDispatch(),
			preservedPatterns: expandedPreservedPatterns,
			protectedToolCallIds,
			duplicateSkillReadIds,
			tokenEstimatorDivisor: effectiveDivisor,
			systemPromptTokens,
			keepLastUserPrompts,
			keepOriginalPrompt,
		});

		// Content cleanup is a Tier 2 action. Running it after the
		// ordered policy reset keeps duplicate-pair collapse and oldest-turn
		// dropping ahead of every other content-changing pass.
		let cleaned: TrimmableMessage[] = result.messages;
		if (result.reachedTier2) {
			const reasoningBlockCap = cfg.reasoningBlockCap ?? REASONING_BLOCK_CAP_DEFAULT;
			const intercomKeepLast = cfg.intercomKeepLast !== undefined ? Math.trunc(cfg.intercomKeepLast) : DEFAULT_INTERCOM_KEEP_LAST;
			const subagentNotifyKeepLast = cfg.subagentNotifyKeepLast !== undefined ? Math.trunc(cfg.subagentNotifyKeepLast) : intercomKeepLast;
			const intercomInstalled = resolveIntercomInstalled();
			const subagentsInstalled = resolveSubagentsInstalled();
			const afterRule1 = intercomInstalled
				? applyIntercomKeepLast(cleaned, intercomKeepLast)
				: cleaned;
			const afterRule2 = intercomInstalled
				? dedupSubagentNotify(afterRule1)
				: afterRule1;
			const afterRule2b = intercomInstalled
				? applySubagentNotifyKeepLast(afterRule2, subagentNotifyKeepLast)
				: afterRule2;
			const afterRule3 = subagentsInstalled
				? keepLatestSubagentToolResult(afterRule2b)
				: afterRule2b;
			cleaned = applyReasoningBlockCap(afterRule3, reasoningBlockCap);
		}
		const out: TrimmableMessage[] = applyLoopGuard(cleaned, result.reachedTier2);
		const appendEntry = (pi as unknown as {
			appendEntry?: (customType: string, data?: unknown) => void;
		}).appendEntry;
		if (result.reachedTier2 && fullSourceDigest !== undefined) {
			const stateInput = {
				sessionId: currentSession.id,
				policyFingerprint: currentPolicyFingerprint,
				sourceDigest: fullSourceDigest,
				rawMessages,
				pinnedCustomType: PINNED_CUSTOM_TYPE,
			};
			const candidateState = createRetainedViewState({
				...stateInput,
				outputMessages: withPinned as unknown as ReadonlyArray<Record<string, unknown>>,
			});
			const nextState = createRetainedViewState({
				...stateInput,
				outputMessages: out as unknown as ReadonlyArray<Record<string, unknown>>,
			});
			const stateChanged =
				nextState !== undefined &&
				hashJson(nextState) !== hashJson(candidateState);
			if (stateChanged) {
				retainedViewState = nextState;
				if (currentSession.persistable && typeof appendEntry === "function") {
					try {
						appendEntry.call(pi, RETAINED_VIEW_CUSTOM_TYPE, nextState);
					} catch {
						// Best-effort persistence; the validated runtime state remains active.
					}
				}
			}
		}
		if (result.droppedTurns > 0 && typeof appendEntry === "function") {
			try {
				appendEntry.call(pi, "context-trimmer-dropped", {
					droppedTurns: result.droppedTurns,
					timestamp: Date.now(),
				});
			} catch {
				// Best-effort diagnostic.
			}
		}

		priorOutbound = fullSourceDigest === undefined
			? undefined
			: {
				sessionId: currentSession.id,
				sourceCount: rawMessages.length,
				sourceDigest: fullSourceDigest,
				promptCharacters: outboundPromptCharacters(
					out as unknown as ReadonlyArray<Record<string, unknown>>,
					systemPromptString,
				),
				modelIdentity: contextModelIdentity(ctx),
			};
		const outCasted = out.map((message) =>
			stripRetainedSourceIndex(message as unknown as Record<string, unknown>),
		);
		return { messages: outCasted as unknown as typeof event.messages };
	});

	/**
	 * Loop-guard injection over the trimmed message stream. When the
	 * guard is OFF, returns the input unchanged (the existing path).
	 * When ON, computes the run-length and the flat-input-token
	 * co-signal; on a qualifying run, prepends a `role: "user"`
	 * synthetic with the nudge or block text. The hard-block path can
	 * strip the last assistant turn's `toolCall` blocks only after the
	 * local trim policy reaches Tier 2. Below that boundary, it emits the
	 * non-destructive nudge instead.
	 */
	function applyLoopGuard(
		trimmed: ReadonlyArray<TrimmableMessage>,
		allowHardBlock: boolean,
	): TrimmableMessage[] {
		if (!resolveLoopGuard()) return trimmed.slice();
		const { runLength } = detectConsecutiveIdenticalToolCalls(trimmed, loopGuardThreshold);
		if (runLength < loopGuardThreshold) return trimmed.slice();
		const { flat: flatInputTokens } = computeFlatInputTokenSignal(trimmed);
		const hardBlock = allowHardBlock && shouldHardBlock(runLength, loopGuardHardBlock);
		const out = trimmed.slice();
		if (hardBlock) {
			// Strip the last assistant turn's `toolCall` blocks,
			// preserving any textual / thinking content of the same
			// turn. The strip is per-block: any non-`toolCall` block
			// (e.g. `type: "text"`, `type: "thinking"`) survives.
			for (let i = out.length - 1; i >= 0; i--) {
				const m = out[i];
				if (m.role !== "assistant") continue;
				if (Array.isArray(m.content)) {
					const filtered = (m.content as ReadonlyArray<{ type: string; [k: string]: unknown }>).filter(
						(block) => !(block && typeof block === "object" && (block as { type: string }).type === "toolCall"),
					);
					out[i] = { ...m, content: filtered };
				} else {
					// Non-array content (string or toolResult shape)
					// has no tool-call blocks to strip; the model
					// must have already been proceeding via text.
				}
				break;
			}
			out.unshift({ role: "user", content: LOOP_GUARD_BLOCK_TEXT });
		} else {
			// Soft-nudge. Append the flat-input-token clause when
			// the co-signal is flat — informational, non-directive;
			// the model treats it as a status note. The clause is
			// a single sentence appended to the nudge body.
			const text = flatInputTokens
				? LOOP_GUARD_NUDGE_TEXT + " The input token count has been flat across these calls."
				: LOOP_GUARD_NUDGE_TEXT;
			out.unshift({ role: "user", content: text });
		}
		return out;
	}
}

/**
 * Best-effort wrapper around `pi.getAllTools()`. Returns `[]` if the
 * API is unavailable or throws (e.g. a minimal mock pi in tests), so
 * detection degrades to "pi-subagents not present" rather than crashing
 * the context handler.
 */
function safeGetAllTools(pi: ExtensionAPI): Array<{ name?: string }> {
	try {
		const tools = (pi as ExtensionAPI & { getAllTools?: () => unknown }).getAllTools;
		if (typeof tools !== "function") return [];
		const result = tools.call(pi);
		return Array.isArray(result) ? (result as Array<{ name?: string }>) : [];
	} catch {
		return [];
	}
}

// Export config helpers for tests / introspection.
export { ENV as CONFIG_ENV, DEFAULT_CONFIG_PATH, CONFIG_PATH_ENV };