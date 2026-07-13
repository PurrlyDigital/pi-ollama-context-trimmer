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
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	applyReasoningBlockCap,
	applyThreeTierTrim,
	approximateMessageTokens,
	computeFlatInputTokenSignal,
	detectConsecutiveIdenticalToolCalls,
	isPathPreserved,
	LOOP_GUARD_BLOCK_TEXT,
	LOOP_GUARD_NUDGE_TEXT,
	messageFingerprint,
	REASONING_BLOCK_CAP_DEFAULT,
	SUMMARIZE_TIER_MAX_TOKENS,
	shouldHardBlock,
	type TrimmableMessage,
} from "./policy.ts";
import { createPinnedTier, PINNED_CUSTOM_TYPE } from "./pinned-tier.ts";
import {
	resolveConfig,
	parseConfigFile,
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

// ─── Default async summarizer (summa subprocess, non-blocking) ────────

const execFileAsync = promisify(execFile);

/** Diagnostic flag: did the last defaultSummaSummarizer call fail? */
let lastSummarizerFailed = false;

/**
 * The default production summarizer: shells out to Python `summa`
 * asynchronously via `execFile` (non-blocking — the event loop is
 * not stalled while summa runs). On error (summa missing, input too
 * short, timeout, etc.) returns the source text unchanged so the
 * trim path stays total-bounded; the diagnostic is exposed via the
 * `lastSummarizerFailed` export. Tests pass their own `summarizer`
 * and never hit this path.
 */
async function defaultSummaSummarizer(text: string, words: number): Promise<string> {
	if (!text || text.length < 200) return text;
	const script =
		"import sys\n" +
		"from summa.summarizer import summarize\n" +
		"text = sys.argv[1]\n" +
		"n = int(sys.argv[2])\n" +
		"out = summarize(text, language='english', words=n)\n" +
		"sys.stdout.write(out or text)\n";
	try {
		const { stdout } = await execFileAsync("/usr/bin/python3", ["-c", script, text, String(words)], {
			encoding: "utf-8",
			timeout: 5_000,
		});
		lastSummarizerFailed = false;
		return stdout || text;
	} catch {
		lastSummarizerFailed = true;
		return text;
	}
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

	// Persisted summary-fingerprint cache. Scoped to this extension
	// factory invocation (one per pi runtime). The cache mirrors the
	// `customType: "context-trimmer-summarized"` entries persisted in
	// the session — `pi.appendEntry` writes them after a successful
	// summarize pass, and the `session_start` handler (resume /
	// startup / reload) re-populates this set from
	// `sessionManager.getEntries()`. The cache is the source of truth
	// for the per-trim `alreadySummarizedHashes` option threaded into
	// the pure policy layer; without it, the skip clause
	// cannot fire across context events (pi-core's `emitContext`
	// discards the trimmed view via `structuredClone` each call).
	const summarizedFingerprints = new Set<string>();

	// Background-summarizer cache: keyed by message fingerprint,
	// stores the summarized `TrimmableMessage` (with the `[summa:`
	// envelope in its content) produced by a background `summa`
	// promise from a prior context event. On the next context event
	// the wiring layer substitutes cached entries into the trimmable
	// message array BEFORE the trim runs, so the skip check
	// (`isAlreadySummarized`) sees the envelope and skips the
	// already-summarized message. Fire-once: each substituted entry
	// is deleted from the cache after substitution — a fingerprint
	// never re-fires on a later context event.
	const summaryCache = new Map<string, TrimmableMessage>();

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
		pinnedTier.refresh();
		// Re-hydrate the persisted summary-fingerprint cache on
		// resume / startup / reload. The session file already
		// carries the `customType: "context-trimmer-summarized"`
		// entries; this read pulls them into the in-memory set so
		// the next context event's trim pass can skip those
		// messages. "new" and "fork" create a fresh session with
		// no prior summary state — the cache stays empty.
		if (event?.reason === "resume" || event?.reason === "startup" || event?.reason === "reload") {
			try {
				const sessionManager = ctx?.sessionManager;
				if (sessionManager && typeof sessionManager.getEntries === "function") {
					const entries = sessionManager.getEntries();
					for (const entry of entries) {
						if (entry && entry.type === "custom" && entry.customType === "context-trimmer-summarized") {
							const data = entry.data;
							if (data && typeof data === "object" && "fingerprint" in data && typeof (data as { fingerprint: unknown }).fingerprint === "string") {
								summarizedFingerprints.add((data as { fingerprint: string }).fingerprint);
							}
						}
					}
				}
			} catch {
				// Best-effort: degrade to no skip on read failure
			}
		}
	});

	pi.on("turn_end", async () => {
		pinnedTier.refresh();
		pinnedTier.bumpTurn();
	});

	pi.on("context", async (event, ctx) => {
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
		// Cache substitution: replace messages whose fingerprint is in
		// the background-summary cache with the summarized version.
		// This runs BEFORE the trim so the skip check
		// (`isAlreadySummarized`) sees the `[summa:` envelope and
		// skips the already-summarized message. Fire-once: each
		// substituted cache entry is deleted after substitution — a
		// fingerprint never re-fires on a later context event.
		//
		// Status lifecycle coupling: when the cache applies (i.e. a
		// background summary from a prior context event has resolved
		// in the meantime), the status that was set at departure on
		// the prior handler invocation is cleared at re-enter here.
		// The status is set before the prior handler returned; the
		// cache fulfillment and the status clear are two halves of
		// the same span.
		let cacheApplied = false;
		for (let i = 0; i < base.length; i++) {
			const fp = messageFingerprint(base[i]);
			if (summaryCache.has(fp)) {
				base[i] = summaryCache.get(fp)!;
				summaryCache.delete(fp);
				cacheApplied = true;
			}
		}
		if (cacheApplied && ctx?.hasUI) {
			ctx.ui.setStatus("context-trimmer", undefined);
		}
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
		const cappedBase: TrimmableMessage[] = applyReasoningBlockCap(base, reasoningBlockCap);
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
		// Coerce `summaWords` to an integer at the wiring layer. The
		// downstream Python `summa` subprocess parses its `words` argv
		// via `int(sys.argv[2])`, which raises ValueError on a float
		// (e.g. `60.5` from a config-file value with a trailing
		// `.0` or a deliberately fractional cap). `isPositiveNumber`
		// accepts floats (it's a Number.isFinite check), so the
		// resolver can hand a float through the env>JSON>default
		// precedence — the policy guards the integer contract, not
		// the resolver. `Math.trunc` is the integer-coercion
		// primitive: it preserves a deliberate `60.0` as `60` (the
		// rejected Option A — silently dropping the value via a
		// stricter `isPositiveInteger` predicate — would have lost
		// the operator's setting), strips a deliberate `60.5` to
		// `60`, and returns `NaN` for non-finite inputs. When
		// `cfg.summaWords` is `undefined` (the default path), the
		// `?? DEFAULT` fallback in `applyThreeTierTrim` still wins.
		const summaWordsInt = cfg.summaWords !== undefined ? Math.trunc(cfg.summaWords) : undefined;
		// Drop-floor: a percentage of the effective summarize cap,
		// resolved to a token count at the wiring layer (the policy
		// receives the resolved numeric `dropFloorTokens`, not the
		// operator-configurable percentage). Per AC-3 the compile-time
		// default is 50% — the no-acknowledge operator still gets a
		// bound that engages when a whole-turn drop would collapse
		// the trimmable total below half the summarize cap.
		const effectiveSummarizeMaxTokens = cfg.tier2MaxTokens ?? SUMMARIZE_TIER_MAX_TOKENS;
		const dropFloorPercent = cfg.dropFloorPercent ?? 50;
		const dropFloorTokens = Math.trunc((dropFloorPercent / 100) * effectiveSummarizeMaxTokens);
		// Recency-floor: integer-coerced token count passed through
		// to the policy unchanged in shape. Per AC-3 the compile-time
		// default is `undefined` (off; recency protection is operator
		// opt-in), so the policy's `recencyFloor <= 0 || undefined`
		// guard treats the default as a no-op. `Math.trunc` matches
		// the existing `summaWords` integer-coercion primitive.
		const recencyFloorTokens = cfg.recencyFloor !== undefined ? Math.trunc(cfg.recencyFloor) : undefined;
		// Status lifecycle. The status spans the synchronous summa
		// work, OR the background-departure-to-background-resolved
		// span. The two halves are not concurrent: sync mode never
		// fires the background path; background mode never sets the
		// sync span. The `ctx?.hasUI` guard skips UI calls in
		// non-TUI modes (rpc, json, print) and in test mocks that
		// pass `{}` as ctx (where `hasUI` is `undefined`, falsy).
		//
		// Sync mode: set before the trim (covers the awaited
		// `defaultSummaSummarizer` calls inside the policy), clear
		// after the trim returns. The clear runs in the same tick
		// so the visible "Summarizing…" span tracks the actual work.
		//
		// Background mode: set AFTER the trim returns — the
		// background promises have already been fired by the time
		// the policy returns, and the trim itself did not block
		// waiting for them. The status is cleared at re-enter
		// (above, in the cache-substitution step) when the next
		// context event applies the resolved cache entry.
		const backgroundMode = cfg.asyncMode === true;
		if (!backgroundMode && ctx?.hasUI) {
			ctx.ui.setStatus("context-trimmer", "Summarizing…");
		}
		const result = await applyThreeTierTrim(withPinned, {
			summarizer: defaultSummaSummarizer,
			backgroundSummarize: backgroundMode,
			verbatimMaxTokens: cfg.tier1MaxTokens,
			summarizeMaxTokens: cfg.tier2MaxTokens,
			summaWords: summaWordsInt,
			dropFloorTokens,
			recencyFloor: recencyFloorTokens,
			protectedCustomTypes: protectedTypes,
			protectDispatch: resolveProtectDispatch(),
			preservedPatterns: expandedPreservedPatterns,
			alreadySummarizedHashes: summarizedFingerprints,
		});
		if (!backgroundMode && ctx?.hasUI) {
			ctx.ui.setStatus("context-trimmer", undefined);
		}
		// Background-promise handling. When the policy fires
		// summarizer promises in the background (backgroundMode
		// true), each pending promise will resolve to the summary
		// text. Attach a `.then()` to each so the resolved summary
		// builds a cache entry (a `TrimmableMessage` with the
		// `[summa: ~N tokens originally → ~M tokens summary]` envelope
		// in its content) keyed by the ORIGINAL message's
		// fingerprint. The next context event's cache-substitution
		// step will find the entry and substitute the summarized
		// version into the trimmable message array, where the
		// policy's `isAlreadySummarized` skip check sees the
		// envelope and skips the message. The `.catch()` is
		// best-effort: a rejected promise yields no cache entry,
		// and the original message is re-evaluated on the next
		// context event.
		if (result.pendingSummaries && result.pendingSummaries.length > 0) {
			for (const pending of result.pendingSummaries) {
				pending.promise
					.then((summaryText) => {
						const originalTokens = approximateMessageTokens(pending.originalMessage);
						const summaryTokens = approximateMessageTokens({ ...pending.originalMessage, content: summaryText });
						const tag = `[summa: ~${originalTokens} tokens originally → ~${summaryTokens} tokens summary]`;
						const summarized: TrimmableMessage = {
							...pending.originalMessage,
							content: [{ type: "text", text: `${tag}\n${summaryText}` }],
						};
						summaryCache.set(pending.fingerprint, summarized);
					})
					.catch(() => {
						// Best-effort: no cache entry on rejection;
						// the message will be re-evaluated on the
						// next context event.
					});
			}
		}
		// Persist the fingerprints of messages summarized in this
		// pass. The pure policy emits `summarizedFingerprints` as
		// the ORIGINAL-message fingerprints (computed before the
		// content was rewritten with the summa envelope) so the
		// persisted key matches the fingerprint the policy will
		// recompute on the next context event. `pi.appendEntry`
		// writes a separate `customType: "context-trimmer-summarized"`
		// entry — it does NOT mutate the session message stream.
		// The trim is a view, not a mutation; the persisted
		// messages stay original. The try/catch degrades silently
		// when `pi.appendEntry` is unavailable (tests, minimal
		// mocks); the in-memory set still updates so the same-
		// process skip still works.
		if (result.summarizedFingerprints.length > 0) {
			const appendEntry = (pi as unknown as { appendEntry?: (customType: string, data?: unknown) => void }).appendEntry;
			if (typeof appendEntry === "function") {
				for (const fingerprint of result.summarizedFingerprints) {
					summarizedFingerprints.add(fingerprint);
					try {
						appendEntry("context-trimmer-summarized", { fingerprint });
					} catch {
						// Best-effort: degrade silently
					}
				}
			} else {
				for (const fingerprint of result.summarizedFingerprints) {
					summarizedFingerprints.add(fingerprint);
				}
			}
		}
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
		// Background-mode status: set at departure when there are
		// pending summaries (so the user sees a "Summarizing…" hint
		// while the background subprocess runs), clear at re-enter
		// when the cache substitution applies on the next context
		// event. The set happens AFTER the trim returns because the
		// background promises have already been fired by then and
		// the trim itself is not blocking on them.
		if (backgroundMode && result.backgroundPending && ctx?.hasUI) {
			ctx.ui.setStatus("context-trimmer", "Summarizing…");
		}
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
export { ENV as CONFIG_ENV, DEFAULT_CONFIG_PATH, CONFIG_PATH_ENV, defaultSummaSummarizer, lastSummarizerFailed };