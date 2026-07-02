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

/** The resolved trimmer config. Every field is optional — when nothing
 *  is configured the trimmer runs with no pinned surfaces and no
 *  dispatch protection (the opt-out default). */
export interface ContextTrimmerConfig {
	/** Absolute path to a personality/voice file pinned verbatim. */
	readonly personalityPath?: string;
	/** Absolute path to a tracker CLI whose last-N digest is pinned. */
	readonly trackerPath?: string;
	/** Dispatch-protection mode. */
	readonly protectDispatch: ProtectDispatchMode;
	/** Optional list of path patterns whose matching tool-result
	 *  messages are protected from summary and drop and whose tokens
	 *  are subtracted from the trimmable budget. Patterns are either
	 *  bare filenames (fuzzy basename match) or absolute paths
	 *  (leading `/` or `~/`, with home expansion at the wiring
	 *  layer). Empty / unset means no paths are preserved. */
	readonly preservedPaths?: readonly string[];
}

/** Default dispatch-protection mode: auto-detect pi-subagents. */
export const DEFAULT_PROTECT_DISPATCH: ProtectDispatchMode = "auto";

/** Env-var names (the `PI_CONTEXT_TRIMMER_*` namespace). Exported so
 *  the wiring layer and tests reference a single source of truth. */
export const ENV = {
	personalityPath: "PI_CONTEXT_TRIMMER_PERSONALITY_PATH",
	trackerPath: "PI_CONTEXT_TRIMMER_TRACKER_PATH",
	protectDispatch: "PI_CONTEXT_TRIMMER_PROTECT_DISPATCH",
	preservedPaths: "PI_CONTEXT_TRIMMER_PRESERVED_PATHS",
} as const;

/** A minimal env record for the resolver (so tests can pass a plain
 *  object without pulling in NodeJS.ProcessEnv). */
export type EnvRecord = Record<string, string | undefined>;

/** The parsed config-file shape (mutable, for the builder). Mirrors the
 *  non-readonly fields of `ContextTrimmerConfig` plus `protectDispatch`. */
export interface ParsedConfigFile {
	personalityPath?: string;
	trackerPath?: string;
	protectDispatch?: ProtectDispatchMode;
	preservedPaths?: readonly string[];
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
	if (typeof o.trackerPath === "string" && o.trackerPath.length > 0) {
		out.trackerPath = o.trackerPath;
	}
	const pd = o.protectDispatch;
	if (pd === "auto" || pd === true || pd === false) {
		out.protectDispatch = pd;
	}
	if (Array.isArray(o.preservedPaths) && o.preservedPaths.every(isNonEmptyString)) {
		out.preservedPaths = o.preservedPaths as readonly string[];
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
	const trackerPath =
		nonEmpty(env[ENV.trackerPath]) ?? file.trackerPath;

	const preservedPaths =
		parseListEnv(env[ENV.preservedPaths]) ?? file.preservedPaths;

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
		trackerPath,
		protectDispatch,
		preservedPaths,
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

/** Parse a comma-separated env value into a trimmed, non-empty list.
 *  The empty string (and all-whitespace) returns `undefined` so the
 *  caller can fall through to the next precedence layer. */
function parseListEnv(s: string | undefined): readonly string[] | undefined {
	const trimmed = nonEmpty(s);
	if (trimmed === undefined) return undefined;
	const parts = trimmed.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
	return parts.length > 0 ? parts : undefined;
}