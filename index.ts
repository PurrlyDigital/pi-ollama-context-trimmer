// ─── Context Trimmer extension wiring (three-tier amended design) ───────
//
// The extension trims an LLM-bound message stream against a three-tier
// budget:
//
//   0–50k trimmable tokens  → verbatim, no action.
//   50k–100k                → in-place summa-summarize the oldest
//                              non-protected trimmable messages until
//                              back under 50k.
//   100k+                   → hard-drop the oldest whole turns
//                              (user+assistant+tool+custom) until
//                              back under 100k.
//
// Subagent protected inputs (subagent-only, excluded from the
// 50k/100k budget, never summarized, never dropped):
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
// The `pinned-tier.ts` module owns the pinned content (personality +
// last-5 tracker tickets) and exposes `buildPinnedMessage()`. The
// wiring below stamps `userTurnAge` on every message, prepends the
// pinned message, calls the trim policy, and returns the result.
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
//      environment. An operator who runs the tracker CLI under
//      systemd puts the tracker path here instead of exporting it in
//      a shell rc the supervisor never sources.
//
// All file I/O and `process.env` access lives here in the wiring
// layer; `config.ts` (parse + resolve) and `pinned-tier.ts` stay
// process-free and node-I/O-free.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	applyThreeTierTrim,
	defaultSummaSummarizer,
	isPathPreserved,
	type TrimmableMessage,
} from "./policy.ts";
import { createPinnedTier, PINNED_CUSTOM_TYPE } from "./pinned-tier.ts";
import {
	resolveConfig,
	parseConfigFile,
	ENV,
	type ContextTrimmerConfig,
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

// ─── Extension entry point ─────────────────────────────────────────────

/**
 * The default-exported extension function. Registers:
 *   - `session_start` to initialize the pinned-tier caches.
 *   - `turn_end` to refresh the pinned-tier (the last-5 tickets
 *     pointer advances over time).
 *   - `context` to do the three-tier trim on every LLM call.
 *
 * Config is resolved once at load from the config file + env (env
 * wins). To pick up a config-file edit, restart pi. Pinned content
 * is opt-in: when neither `personalityPath` nor `trackerPath`
 * resolves to content, `buildPinnedMessage()` returns `null` and the
 * context handler skips the pinned injection entirely.
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
		trackerPath: cfg.trackerPath,
	});

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

	pi.on("session_start", async () => {
		pinnedTier.refresh();
	});

	pi.on("turn_end", async () => {
		pinnedTier.refresh();
		pinnedTier.bumpTurn();
	});

	pi.on("context", async (event) => {
		// Read the current message stream.
		const rawMessages = (event.messages ?? []) as unknown as ReadonlyArray<Record<string, unknown>>;
		// Stamp userTurnAge on every message. The stamp is the source
		// of truth for the dispatch-task protection; we pass the
		// minimum shape (role) to the stampee and use the original
		// content/customType downstream.
		const stampedAges = stampUserTurnAge(
			rawMessages.map((m) => ({ role: String(m.role ?? "user") })),
		);
		// Build the pinned-tier synthetic (the agent def). Opt-in: may
		// return `null` when neither personality nor tracker is
		// configured. Only prepend when there is content to pin.
		const pinned = pinnedTier.buildPinnedMessage();
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
		const withPinned: TrimmableMessage[] = pinned
			? [{ role: "custom", content: pinned.content, customType: PINNED_CUSTOM_TYPE }, ...base]
			: base;
		// Run the three-tier trim. Production uses defaultSummaSummarizer
		// (a Python `summa` subprocess). The pinned synthetic (when
		// present) and any preserved-path message are excluded from
		// the budget via `protectedCustomTypes`. Dispatch protection
		// is resolved from config (auto/true/false). The preserved-
		// paths channel is resolved from config (`preservedPaths`),
		// with `~/` expanded at the wiring layer to the operator's
		// home directory (the pure predicate receives the expanded
		// pattern; it never reads `os.homedir()` itself).
		const result = applyThreeTierTrim(withPinned, {
			summarizer: defaultSummaSummarizer,
			verbatimMaxTokens: cfg.tier1MaxTokens,
			summarizeMaxTokens: cfg.tier2MaxTokens,
			summaWords: cfg.summaWords,
			protectedCustomTypes: protectedTypes,
			protectDispatch: resolveProtectDispatch(),
			preservedPatterns: expandedPreservedPatterns,
		});
		// Cast back to the session message shape and return. The
		// pinned message rides out at the top (when injected); the rest
		// are the trimmed trimmable messages. The double-cast mirrors the
		// pattern in the prior wiring: `TrimmableMessage` and
		// `AgentMessage` share a structural core (role, content, etc.)
		// but the session type carries provider-specific fields the
		// policy does not inspect.
		const out = result.messages.map((m) => m as unknown as Record<string, unknown>);
		return { messages: out as unknown as typeof event.messages };
	});
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