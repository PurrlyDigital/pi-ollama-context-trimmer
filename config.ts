/**
 * Context-trimmer config resolution (pure).
 *
 * The trimmer is operator-opted-in: nothing is pinned and the dispatch
 * slot is not protected until an operator configures it. There are two
 * config channels, with a fixed precedence:
 *
 *   1. Environment variables (highest precedence) — useful for ad-hoc
 *      runs, CI, and tests. Renamed to the `PI_CONTEXT_TRIMMER_*`
 *      namespace.
 *   2. Global config file `~/.pi/agent/context-trimmer.json` — the
 *      persistent, filesystem-based channel. This is the channel that
 *      works when pi is launched by systemd (or any non-interactive
 *      supervisor) that does not inherit the operator's shell
 *      environment.
 *
 * This module is pure: it takes the parsed file contents and an env
 * record and returns the resolved config. All file I/O and `process.env`
 * access lives in `index.ts` (the wiring layer); the purity contract
 * mirrors `policy.ts` and `pinned-tier.ts`.
 */

/** The dispatch-protection mode. `"auto"` defers to the wiring layer's
 *  pi-subagents detection; `true`/`false` force it on/off. */
export type ProtectDispatchMode = "auto" | boolean;

/** The loop-guard enable mode. `true` (default) turns the guard
 *  ON for every session; `false` turns it off. The guard is
 *  universal — it is not coupled to a subagent-only detection probe
 *  (the wiring layer does not probe `pi-subagents` for the loop
 *  guard; behavioral-loop detection is the same concern in every
 *  session posture). Mirrors the `protectDispatch` opt-in/out
 *  shape semantically; the two surfaces are now independent. */
export type LoopGuardMode = boolean;

/** The resolved trimmer config. Every field is optional — when nothing
 *  is configured the trimmer runs with no pinned surfaces and no
 *  dispatch protection (the opt-out default). */
export interface ContextTrimmerConfig {
	/** Absolute path to a personality/voice file pinned verbatim. */
	readonly personalityPath?: string;
	/** Dispatch-protection mode. */
	readonly protectDispatch: ProtectDispatchMode;
	/** Optional list of path patterns whose matching tool-result
	 *  messages are protected from summary and drop and whose tokens
	 *  are subtracted from the trimmable budget. Patterns are either
	 *  bare filenames (fuzzy basename match) or absolute paths
	 *  (leading `/` or `~/`, with home expansion at the wiring
	 *  layer). Empty / unset means no paths are preserved. */
	readonly preservedPaths?: readonly string[];
	/** Optional verbatim-tier cap (tokens). Overrides the policy
	 *  default when set. */
	readonly tier1MaxTokens?: number;
	/** Optional summarize-tier cap (tokens). Overrides the policy
	 *  default when set. */
	readonly tier2MaxTokens?: number;
	/** Optional per-summary word cap passed to summa. Overrides the
	 *  policy default when set. */
	readonly summaWords?: number;
	/** Optional drop-tier floor as a percentage (0, 100] of the
	 *  trimmable budget. Overrides the policy default when set. */
	readonly dropFloorPercent?: number;
	/** Optional recency-floor token count. Overrides the policy
	 *  default when set. */
	readonly recencyFloor?: number;
	/** Loop-guard enable mode. `true` (default) turns the guard ON
	 *  for every session; `false` turns it off. Overrides the policy
	 *  default when set. */
	readonly loopGuard?: LoopGuardMode;
	/** Loop-guard nudge threshold (consecutive identical assistant
	 *  tool-call turns before the wiring layer injects a nudge).
	 *  Positive integer; the wiring layer coerces with `Math.trunc`
	 *  (summaWords precedent). Overrides the policy default when
	 *  set. */
	readonly loopGuardThreshold?: number;
	/** Loop-guard hard-block threshold (consecutive identical
	 *  assistant tool-call turns before the wiring layer hard-blocks
	 *  the next one). `undefined` means hard-block is off. Positive
	 *  integer; the wiring layer coerces with `Math.trunc` (summaWords
	 *  precedent). Overrides the policy default when set. */
	readonly loopGuardHardBlock?: number;
}

/** Default dispatch-protection mode: auto-detect pi-subagents. */
export const DEFAULT_PROTECT_DISPATCH: ProtectDispatchMode = "auto";

/** Default loop-guard mode: ON for every session. The guard is
 *  universal across session postures; the subagent-only coupling was
 *  dropped because behavioral-loop detection is the same concern
 *  whether the model is in a parent or a subagent session. */
export const DEFAULT_LOOP_GUARD: LoopGuardMode = true;

/** Env-var names (the `PI_CONTEXT_TRIMMER_*` namespace). Exported so
 *  the wiring layer and tests reference a single source of truth. */
export const ENV = {
	personalityPath: "PI_CONTEXT_TRIMMER_PERSONALITY_PATH",
	protectDispatch: "PI_CONTEXT_TRIMMER_PROTECT_DISPATCH",
	preservedPaths: "PI_CONTEXT_TRIMMER_PRESERVED_PATHS",
	tier1MaxTokens: "PI_CONTEXT_TRIMMER_TIER1_MAX_TOKENS",
	tier2MaxTokens: "PI_CONTEXT_TRIMMER_TIER2_MAX_TOKENS",
	summaWords: "PI_CONTEXT_TRIMMER_SUMMA_WORDS",
	dropFloorPercent: "PI_CONTEXT_TRIMMER_DROP_FLOOR_PERCENT",
	recencyFloor: "PI_CONTEXT_TRIMMER_RECENCY_FLOOR",
	loopGuard: "PI_CONTEXT_TRIMMER_LOOP_GUARD",
	loopGuardThreshold: "PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD",
	loopGuardHardBlock: "PI_CONTEXT_TRIMMER_LOOP_GUARD_HARD_BLOCK",
} as const;

/** A minimal env record for the resolver (so tests can pass a plain
 *  object without pulling in NodeJS.ProcessEnv). */
export type EnvRecord = Record<string, string | undefined>;

/** The parsed config-file shape (mutable, for the builder). Mirrors the
 *  non-readonly fields of `ContextTrimmerConfig` plus `protectDispatch`. */
export interface ParsedConfigFile {
	personalityPath?: string;
	protectDispatch?: ProtectDispatchMode;
	preservedPaths?: readonly string[];
	tier1MaxTokens?: number;
	tier2MaxTokens?: number;
	summaWords?: number;
	dropFloorPercent?: number;
	recencyFloor?: number;
	loopGuard?: LoopGuardMode;
	loopGuardThreshold?: number;
	loopGuardHardBlock?: number;
}

/**
 * Validate and extract the trimmer-relevant fields from a parsed config
 * file object. Unknown keys are ignored; badly-typed values are treated
 * as absent (the resolver falls back to the next precedence layer).
 * Returns a partial config with only the well-typed fields set.
 */
export function parseConfigFile(obj: unknown): ParsedConfigFile {
	if (typeof obj !== "object" || obj === null) return {};
	const o = obj as Record<string, unknown>;
	const out: ParsedConfigFile = {};
	if (typeof o.personalityPath === "string" && o.personalityPath.length > 0) {
		out.personalityPath = o.personalityPath;
	}
	const pd = o.protectDispatch;
	if (pd === "auto" || pd === true || pd === false) {
		out.protectDispatch = pd;
	}
	if (Array.isArray(o.preservedPaths) && o.preservedPaths.every(isNonEmptyString)) {
		out.preservedPaths = o.preservedPaths as readonly string[];
	}
	if (isPositiveNumber(o.tier1MaxTokens)) {
		out.tier1MaxTokens = o.tier1MaxTokens;
	}
	if (isPositiveNumber(o.tier2MaxTokens)) {
		out.tier2MaxTokens = o.tier2MaxTokens;
	}
	if (isPositiveNumber(o.summaWords)) {
		out.summaWords = o.summaWords;
	}
	if (isDropFloorPercent(o.dropFloorPercent)) {
		out.dropFloorPercent = o.dropFloorPercent;
	}
	if (isPositiveNumber(o.recencyFloor)) {
		out.recencyFloor = o.recencyFloor;
	}
	const lg = o.loopGuard;
	if (lg === true || lg === false) {
		out.loopGuard = lg;
	}
	if (isPositiveNumber(o.loopGuardThreshold)) {
		out.loopGuardThreshold = o.loopGuardThreshold;
	}
	if (isPositiveNumber(o.loopGuardHardBlock)) {
		out.loopGuardHardBlock = o.loopGuardHardBlock;
	}
	return out;
}

/**
 * Resolve the effective config from a parsed file (already validated)
 * and an env record. Env wins over file; file wins over defaults.
 *
 * For `protectDispatch`:
 *   - env `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH` = "1" → true, "0" → false
 *     (any other value, including unset, is "no override").
 *   - otherwise the file's `protectDispatch` is used.
 *   - otherwise the default `"auto"` applies.
 */
export function resolveConfig(opts: {
	file?: Partial<Omit<ContextTrimmerConfig, "protectDispatch">> & { protectDispatch?: ProtectDispatchMode };
	env?: EnvRecord;
}): ContextTrimmerConfig {
	const file = opts.file ?? {};
	const env = opts.env ?? {};

	const personalityPath =
		nonEmpty(env[ENV.personalityPath]) ?? file.personalityPath;

	const preservedPaths =
		parseListEnv(env[ENV.preservedPaths]) ?? file.preservedPaths;

	const tier1MaxTokens =
		parseNumberEnv(env[ENV.tier1MaxTokens]) ?? file.tier1MaxTokens;
	const tier2MaxTokens =
		parseNumberEnv(env[ENV.tier2MaxTokens]) ?? file.tier2MaxTokens;
	const summaWords =
		parseNumberEnv(env[ENV.summaWords]) ?? file.summaWords;
	const dropFloorPercent =
		parsePercentEnv(env[ENV.dropFloorPercent]) ?? file.dropFloorPercent;
	const recencyFloor =
		parseNumberEnv(env[ENV.recencyFloor]) ?? file.recencyFloor;

	let loopGuard: LoopGuardMode;
	const envLg = env[ENV.loopGuard];
	if (envLg === "1") {
		loopGuard = true;
	} else if (envLg === "0") {
		loopGuard = false;
	} else if (file.loopGuard === true || file.loopGuard === false) {
		loopGuard = file.loopGuard;
	} else {
		loopGuard = DEFAULT_LOOP_GUARD;
	}

	const loopGuardThreshold =
		parseNumberEnv(env[ENV.loopGuardThreshold]) ?? file.loopGuardThreshold;
	const loopGuardHardBlock =
		parseNumberEnv(env[ENV.loopGuardHardBlock]) ?? file.loopGuardHardBlock;

	let protectDispatch: ProtectDispatchMode;
	const envPd = env[ENV.protectDispatch];
	if (envPd === "1") {
		protectDispatch = true;
	} else if (envPd === "0") {
		protectDispatch = false;
	} else if (file.protectDispatch === true || file.protectDispatch === false || file.protectDispatch === "auto") {
		protectDispatch = file.protectDispatch;
	} else {
		protectDispatch = DEFAULT_PROTECT_DISPATCH;
	}

	return {
		personalityPath,
		protectDispatch,
		preservedPaths,
		tier1MaxTokens,
		tier2MaxTokens,
		summaWords,
		dropFloorPercent,
		recencyFloor,
		loopGuard,
		loopGuardThreshold,
		loopGuardHardBlock,
	};
}

/** Return the string if non-empty, else undefined. */
function nonEmpty(s: string | undefined): string | undefined {
	return s && s.length > 0 ? s : undefined;
}

/** Type guard: a value is a non-empty string. Used to validate each
 *  element of the `preservedPaths` array; the field is all-or-nothing
 *  per the existing "badly-typed values are treated as absent" rule. */
function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/** Type guard: a value is a positive finite number. Used to validate
 *  the numeric threshold fields; non-numeric, zero, negative, `NaN`,
 *  and `Infinity` are all treated as absent so the resolver falls
 *  through to the next precedence layer. */
function isPositiveNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Type guard: a value is a finite number in the open-closed interval
 *  (0, 100]. Used to validate the drop-floor percent field; non-numeric,
 *  zero, negative, greater than 100, `NaN`, and `Infinity` are all
 *  treated as absent so the resolver falls through to the next
 *  precedence layer. */
function isDropFloorPercent(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100;
}

/** Parse a comma-separated env value into a trimmed, non-empty list.
 *  The empty string (and all-whitespace) returns `undefined` so the
 *  caller can fall through to the next precedence layer. */
function parseListEnv(s: string | undefined): readonly string[] | undefined {
	const trimmed = nonEmpty(s);
	if (trimmed === undefined) return undefined;
	const parts = trimmed.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
	return parts.length > 0 ? parts : undefined;
}

/** Parse an env-var value as a positive finite number. The empty
 *  string (and all-whitespace) returns `undefined` so the caller can
 *  fall through to the next precedence layer; non-numeric, zero,
 *  negative, `NaN`, and `Infinity` likewise return `undefined`. */
function parseNumberEnv(s: string | undefined): number | undefined {
	const trimmed = nonEmpty(s);
	if (trimmed === undefined) return undefined;
	const n = Number(trimmed);
	return isPositiveNumber(n) ? n : undefined;
}

/** Parse an env-var value as a finite number in (0, 100]. The empty
 *  string (and all-whitespace) returns `undefined` so the caller can
 *  fall through to the next precedence layer; non-numeric, zero,
 *  negative, greater than 100, `NaN`, and `Infinity` likewise return
 *  `undefined`. */
function parsePercentEnv(s: string | undefined): number | undefined {
	const trimmed = nonEmpty(s);
	if (trimmed === undefined) return undefined;
	const n = Number(trimmed);
	return isDropFloorPercent(n) ? n : undefined;
}
