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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

// ─── Calibrated token-estimator divisor (derived from real usage) ───────
// The trimmer's per-message token estimator is `chars / divisor`. The
// compile-time default is `TOKEN_ESTIMATOR_DIVISOR_DEFAULT = 3`; the
// operator knob (`tokenEstimatorDivisor` env/JSON) overrides it. This
// helper derives a rough chars-per-prompt-token divisor from the latest
// usable assistant usage already attached to the stream. It uses Pi's
// provider-neutral prompt-token components, including cache reads and
// writes when present, instead of guessing how a provider encodes opaque
// reasoning. The current stream is recalculated on every context event;
// no calibration state is retained.

/**
 * Return the prompt-token total reported by a usable assistant message.
 * Mirrors the harness compaction module's validity checks while using the
 * prompt components rather than output-inclusive `totalTokens`. Cache
 * fields are optional because some providers do not report them.
 */
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

type ProviderTotal = {
	totalTokens: number;
	reportKey: string;
};

function providerReportIdentity(msg: Record<string, unknown>, totalTokens: number): string {
	const responseId = msg.responseId;
	if (typeof responseId === "string" && responseId.length > 0) {
		return JSON.stringify(["response", responseId, totalTokens]);
	}
	const timestamp = msg.timestamp;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
		return JSON.stringify(["timestamp", timestamp, totalTokens]);
	}
	const text = extractText(msg.content);
	return JSON.stringify(["fallback", totalTokens, text.length, text.slice(0, 128), text.slice(-128)]);
}

/** Return the latest usable provider aggregate and its stable report identity. */
function latestProviderTotalTokens(rawMessages: ReadonlyArray<Record<string, unknown>>): ProviderTotal | undefined {
	let latest: ProviderTotal | undefined;
	const occurrences = new Map<string, number>();
	for (const msg of rawMessages) {
		if (msg.role !== "assistant") continue;
		const stopReason = msg.stopReason;
		if (stopReason === "aborted" || stopReason === "error") continue;
		const usage = msg.usage;
		if (typeof usage !== "object" || usage === null) continue;
		const totalTokens = (usage as Record<string, unknown>).totalTokens;
		if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens <= 0) continue;
		const identity = providerReportIdentity(msg, totalTokens);
		const occurrence = (occurrences.get(identity) ?? 0) + 1;
		occurrences.set(identity, occurrence);
		latest = { totalTokens, reportKey: JSON.stringify([identity, occurrence]) };
	}
	return latest;
}

/**
 * Derive a calibrated chars-per-token divisor from the latest assistant
 * message in the stream that carries usable prompt-token usage. The
 * numerator is the character count the provider saw for that turn: the
 * system prompt plus every message before the calibration-point assistant.
 * The denominator is `input + cacheRead + cacheWrite`, using the standard
 * Pi usage fields that are present. The current assistant is not part of
 * that prompt, so its output does not distort the calibration.
 *
 * Returns `undefined` when no usable usage is present. The caller then
 * falls back to the configured divisor. No calibration state is retained
 * between context events.
 *
 * Pure: reads `systemPromptChars` (a number) and the raw message array,
 * returns a number or undefined. No I/O, no `process.*`. Kept in the
 * wiring layer because it reads the harness `usage` field; the pure
 * module's estimator signatures remain unchanged.
 */
function deriveCalibratedDivisor(
	rawMessages: ReadonlyArray<Record<string, unknown>>,
	systemPromptChars: number,
): number | undefined {
	for (let i = rawMessages.length - 1; i >= 0; i--) {
		const usage = usableAssistantUsage(rawMessages[i]!);
		if (usage === undefined) continue;
		let chars = systemPromptChars;
		for (let j = 0; j < i; j++) {
			chars += extractText(rawMessages[j]!.content).length;
		}
		const divisor = chars / usage.promptTokens;
		if (Number.isFinite(divisor) && divisor > 0) return divisor;
	}
	return undefined;
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
 * `dropOldestTurns` and `summarizeOldestUntilUnder`. The
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
	let lastResetProviderReportKey: string | undefined;

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

	// Pre-budget-collapse extension-gating resolvers. Resolved lazily
	// on the first `context` call and cached for the session, mirroring
	// the existing `resolveProtectDispatch` pattern. Each gates one or
	// more pre-budget collapse rules:
	//   - `intercomInstalled` → Rules 1 + 2 (applyIntercomKeepLast,
	//     dedupSubagentNotify) — both ride the pi-intercom extension.
	//   - `subagentsInstalled` → Rule 3 (keepLatestSubagentToolResult) —
	//     rides the pi-subagents extension.
	// Two independent resolvers rather than one combined flag: the
	// gates are distinct and a combined flag would couple unrelated
	// extensions. The probes reuse `safeGetAllTools(pi)` so a minimal
	// or unavailable API degrades to `[]` (inert) rather than
	// throwing.
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

	pi.on("session_start", async (event, ctx) => {
		lastResetProviderReportKey = undefined;
		pinnedTier.refresh();
	});

	pi.on("turn_end", async () => {
		pinnedTier.refresh();
		pinnedTier.bumpTurn();
	});

	pi.on("context", async (event, ctx) => {
		// Read the current message stream.
		const rawMessages = (event.messages ?? []) as unknown as ReadonlyArray<Record<string, unknown>>;
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
		// Calibrate the divisor from the latest usable assistant usage in the
		// stream. The prompt-token total includes cache reads and writes when
		// the provider reports them, so opaque reasoning already present in a
		// resumed stream contributes to the same rough estimate without a
		// provider-specific conversion. When no usable usage is present
		// (pre-first-turn hooks, test mocks without `usage`, aborted/error
		// turns), the configured `tokenEstimatorDivisor` above is the fallback.
		// Derive it once per hook and thread it through every downstream
		// token-count call. No calibration state is retained between hooks.
		const calibratedDivisor = deriveCalibratedDivisor(rawMessages, systemPromptString.length);
		const providerTotal = latestProviderTotalTokens(rawMessages);
		const authoritativeTotalTokens = providerTotal?.reportKey === lastResetProviderReportKey
			? undefined
			: providerTotal?.totalTokens;
		const effectiveDivisor = calibratedDivisor ?? tokenEstimatorDivisor;
		const systemPromptTokens = approximateTextTokens(systemPromptString, effectiveDivisor);
		// Stamp userTurnAge on every message. The stamp is the source
		// of truth for the dispatch-task protection; we pass the
		// minimum shape (role) to the stampee and use the original
		// content/customType downstream.
		const stampedAges = stampUserTurnAge(
			rawMessages.map((m) => ({ role: String(m.role ?? "user") })),
		);
		// Build the pinned-tier synthetic (the agent def). Opt-in: may
		// return `null` when personality is not configured / resolves
		// empty. Skipped entirely in child/subagent sessions unless an
		// override channel (`PI_CONTEXT_TRIMMER_PIN_SUBAGENT` env var
		// or `pinSubagent` JSON key) has re-enabled the pin — the
		// parent persona must not cross the dispatch boundary by
		// default.
		const pinned = shouldPinForCurrentContext ? pinnedTier.buildPinnedMessage() : null;
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
		const home = homedir();
		const expandedPreservedPatterns = expandPreservedPaths(cfg.preservedPaths, home);
		const base: TrimmableMessage[] = rawMessages.map((m, i) => {
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
			const stamped = stampSourcePath(m, sourcePath) as TrimmableMessage;
			return {
				...stamped,
				role: stampedAges[i].role as TrimmableMessage["role"],
				content: m.content,
				userTurnAge: stampedAges[i].userTurnAge,
				customType: typeof m.customType === "string" ? m.customType : undefined,
			};
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
		// Computed BEFORE the pre-budget transforms and the
		// reasoning-block cap so the set reflects the assistant
		// messages as the model emitted them (the cap / pre-budget
		// transforms may drop assistant message content, but the
		// set is already computed against the source stream).
		const protectedToolCallIds = extractProtectedToolCallIds(base, expandedPreservedPatterns);
		// Apply the reasoning-block-count cap to the base message
		// stream BEFORE the three-tier trim. The cap keeps the
		// last N `type:"thinking"` content blocks across the
		// stream and drops the rest; the three-tier budget then
		// accounts against the post-cap mass so dropped reasoning
		// blocks do not inflate the budget. The cap is global
		// (no `ctx.model` branching); `cfg.reasoningBlockCap` is
		// already resolved at handler entry via `resolveConfig`
		// (env > JSON > compile-time default precedence in
		// `config.ts`). When the resolver returns `undefined` the
		// compile-time default `REASONING_BLOCK_CAP_DEFAULT = -1`
		// (passthrough — every reasoning block survives) applies,
		// so existing operators see no behavior change when
		// upgrading. `cap === -1` is a pure passthrough inside the
		// policy (no overhead beyond the call). The cap runs on
		// `base` (the stream before pinned injection) so the
		// pinned synthetic is never at risk of being dropped.
		const reasoningBlockCap = cfg.reasoningBlockCap ?? REASONING_BLOCK_CAP_DEFAULT;
		const intercomKeepLast = cfg.intercomKeepLast !== undefined ? Math.trunc(cfg.intercomKeepLast) : DEFAULT_INTERCOM_KEEP_LAST;
		const subagentNotifyKeepLast = cfg.subagentNotifyKeepLast !== undefined ? Math.trunc(cfg.subagentNotifyKeepLast) : intercomKeepLast;
		const intercomInstalled = resolveIntercomInstalled();
		const subagentsInstalled = resolveSubagentsInstalled();
		const afterRule1: TrimmableMessage[] = intercomInstalled
			? applyIntercomKeepLast(base, intercomKeepLast)
			: base;
		const afterRule2: TrimmableMessage[] = intercomInstalled
			? dedupSubagentNotify(afterRule1)
			: afterRule1;
		const afterRule2b: TrimmableMessage[] = intercomInstalled
			? applySubagentNotifyKeepLast(afterRule2, subagentNotifyKeepLast)
			: afterRule2;
		const afterRule3: TrimmableMessage[] = subagentsInstalled
			? keepLatestSubagentToolResult(afterRule2b)
			: afterRule2b;
		const cappedBase: TrimmableMessage[] = applyReasoningBlockCap(afterRule3, reasoningBlockCap);
		const withPinned: TrimmableMessage[] = pinned
			? [{ role: "custom", content: pinned.content, customType: PINNED_CUSTOM_TYPE }, ...cappedBase]
			: cappedBase;
		// Run the three-tier trim. Production uses defaultSummaSummarizer
		// (a Python `summa` subprocess). The pinned synthetic (when
		// present) and any preserved-path message are excluded from
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
			authoritativeTotalTokens,
			systemPromptTokens,
			keepLastUserPrompts,
			keepOriginalPrompt,
		});
		if (
			providerTotal !== undefined &&
			providerTotal.reportKey !== lastResetProviderReportKey &&
			providerTotal.totalTokens >= (cfg.tier2MaxTokens ?? SUMMARIZE_TIER_MAX_TOKENS)
		) {
			lastResetProviderReportKey = providerTotal.reportKey;
		}
		// Persist the fingerprints of messages summarized in this
		// pass. The pure policy emits `summarizedFingerprints` as
		// Persisted drop marker: when the tier-3 drop path fired
		// (any non-zero `droppedTurns`), write a
		// `context-trimmer-dropped` entry carrying the count and a
		// timestamp. The marker is diagnostic only — it is not
		// used for policy decisions. The pure `policy.ts` module
		// only carries the `droppedTurns` counter; the wiring
		// layer is responsible for persistence. The try/catch
		// degrades silently when `pi.appendEntry` is unavailable
		// (tests, minimal mocks).
		if (result.droppedTurns > 0) {
			const appendEntry = (pi as unknown as { appendEntry?: (customType: string, data?: unknown) => void }).appendEntry;
			if (typeof appendEntry === "function") {
				try {
					appendEntry("context-trimmer-dropped", { droppedTurns: result.droppedTurns, timestamp: Date.now() });
				} catch {
					// Best-effort: degrade silently
				}
			}
		}
		// Loop-guard integration. Runs AFTER the trim (operates on
		// the trimmed view the LLM is about to see) and BEFORE the
		// handler returns. Re-injection on every qualifying turn is
		// the simpler safe default; the hard-block naturally dedupes
		// because stripping the tool call breaks the fingerprint
		// (`type: "toolCall"` blocks absent → `\0__no_tool_calls__`
		// signature → the run resets on the next invocation).
		const out: TrimmableMessage[] = applyLoopGuard(result.messages);
		// Cast back to the session message shape and return. The
		// pinned message rides out at the top (when injected); the rest
		// are the trimmed trimmable messages. The double-cast mirrors the
		// pattern in the prior wiring: `TrimmableMessage` and
		// `AgentMessage` share a structural core (role, content, etc.)
		// but the session type carries provider-specific fields the
		// policy does not inspect.
		const outCasted = out.map((m) => m as unknown as Record<string, unknown>);
		return { messages: outCasted as unknown as typeof event.messages };
	});

	/**
	 * Loop-guard injection over the trimmed message stream. When the
	 * guard is OFF, returns the input unchanged (the existing path).
	 * When ON, computes the run-length and the flat-input-token
	 * co-signal; on a qualifying run, prepends a `role: "user"`
	 * synthetic with the nudge or block text. The hard-block path
	 * additionally strips the last assistant turn's `toolCall`
	 * blocks (preserving any textual / thinking content) so the
	 * model must proceed via text. Hard-block is a strict superset
	 * of soft-nudge — when both fire, emit ONLY the block text.
	 */
	function applyLoopGuard(trimmed: ReadonlyArray<TrimmableMessage>): TrimmableMessage[] {
		if (!resolveLoopGuard()) return trimmed.slice();
		const { runLength } = detectConsecutiveIdenticalToolCalls(trimmed, loopGuardThreshold);
		if (runLength < loopGuardThreshold) return trimmed.slice();
		const { flat: flatInputTokens } = computeFlatInputTokenSignal(trimmed);
		const hardBlock = shouldHardBlock(runLength, loopGuardHardBlock);
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