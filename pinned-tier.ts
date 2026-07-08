/**
 * Pinned tier module (auto-pin by convention).
 *
 * Owns the auto-pinned content the agent always sees: `personality.md`
 * (the agent's voice/identity substrate in `~/.pi/agent/`). The pinned
 * tier is the Pi-native substitute for the Claude Code
 * `UserPromptSubmit` re-injection hack — Pi has no
 * `user_prompt_submit` event, so the trimmer injects on `context`
 * instead, every call, regardless of age.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why a pinned tier (AC-3 — the load-bearing motivation)
 *
 *   The operator's three original constraints (keep it recent /
 *   clean / helpful) require the agent to always have access to a small
 *   set of essentials. The BACKUP `keep-mark.ts` opt-in keep-mark
 *   survives the trim, but it requires the agent to explicitly mark
 *   these essentials; the operator wants them auto-pinned by convention.
 *
 *   On Pi, the natural channel is the `context` event's `messages` array.
 *   Every per-LLM-call view runs the `context` handler; the handler
 *   prepends the pinned content as a synthetic message the LLM sees at
 *   the top. The pinned content is **view-time only** — it is not
 *   persisted in the session file (that would bloat the session). The
 *   injection is reconstructed on every `context` call from the file
 *   system.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What's pinned
 *
 *   1. `personality.md` — the agent's voice/identity substrate, read
 *      verbatim (the file is small; the convention treats it as
 *      "always-present file content," not as a tool result that ages).
 *      **The personality pin is opt-in** — no default path is bundled.
 *      An operator who wants the personality substrate injected sets
 *      its path explicitly; when unset (or the file is missing) the
 *      personality section is omitted entirely.
 *
 *   When personality is not configured (or the file resolves empty),
 *   there is nothing to pin and `buildPinnedMessage()` returns `null`
 *   — the wiring layer skips the injection entirely. The extension
 *   ships no opinionated default content; everything pinned is
 *   operator-opted-in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Convention-driven, not agent-driven
 *
 *   The pinned set is **convention-driven** (auto-pin by convention),
 *   not agent-driven. The convention is `isPinned(path): boolean`
 *   returning true for `~/.pi/agent/personality.md`. No agent `pin`
 *   verb exists in v1 (per the Out-of-scope list: "Agent `pin <ref>`
 *   verb and config-file pinned-tier declaration — future tickets").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Purity contract
 *
 *   - The `PinnedTier` instance holds the in-memory cache (personality
 *     content). The cache is populated by `refresh()` calls
 *     (session_start, turn_end).
 *   - The text-formatting helpers are pure functions.
 *   - File I/O is encapsulated in `refresh()` — the engine is otherwise
 *     pure.
 *   - The PinnedTier is a stateful but pure data structure; the
 *     `index.ts` `session_start` handler calls `refresh()` to populate
 *     the cache, and the `context` handler calls `buildPinnedMessage()`
 *     to build the synthetic injection message.
 */

import { readFileSync, existsSync } from "node:fs";

// ─── Constants (the load-bearing AC-3 surface) ────────────────────────────

/** Custom type for the pinned-tier injection message. The `context`
 *  handler prepends a `customType: "context-trimmer-pinned"` message
 *  to the per-LLM-call view. The TUI can hide this message by
 *  customType (it is a `display: false` synthetic; the LLM sees the
 *  content but the TUI does not show it as a user-visible line). */
export const PINNED_CUSTOM_TYPE = "context-trimmer-pinned";

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * The PinnedTier container. Created by `createPinnedTier()`. The
 * instance holds the in-memory cache; `refresh()` re-reads from the
 * file system.
 */
export interface PinnedTier {
	/** Verbatim `personality.md` content. Empty if not configured or
	 *  the file is missing. */
	readonly personality: string;
	/** The current turn index. Bumped on every `turn_end` so the
	 *  cache is refreshed lazily; the lifecycle engine does not read
	 *  this — only the `index.ts` handler does. */
	readonly currentTurn: number;
	/** Re-read personality.md. Called from `session_start` (always)
	 *  and from `turn_end` (refresh tick). */
	refresh: () => void;
	/** Bump the current turn. Called from `turn_end` after `refresh()`. */
	bumpTurn: () => void;
	/** Build the synthetic `context-trimmer-pinned` message for the
	 *  per-LLM-call view. Returns `null` when there is nothing to pin
	 *  (no personality content), so the wiring layer can skip the
	 *  injection entirely. */
	buildPinnedMessage: () => PinnedMessage | null;
	/** Test seam: return whether a path is auto-pinned by convention. */
	isPinned: (path: string) => boolean;
}

/**
 * The synthetic message shape prepended to the per-LLM-call view.
 * The shape is the same as the BACKUP `before_agent_start` injection
 * (a `customType` message), but injected on `context` instead of
 * `before_agent_start` so the LLM sees it on every LLM call, not just
 * at the start of a turn. `display: false` keeps the TUI clean.
 */
export interface PinnedMessage {
	role: "custom";
	customType: typeof PINNED_CUSTOM_TYPE;
	content: string;
	display: boolean;
}

// ─── State factory ─────────────────────────────────────────────────────────

/**
 * Create a fresh PinnedTier instance with empty caches. The caller
 * (`index.ts` `session_start` handler) calls `refresh()` to populate
 * the caches. The caches are then read by the `context` handler on
 * every per-LLM-call view.
 *
 * `personalityPath` is **opt-in** — no default path is bundled with
 * the extension. When omitted (or resolves to a missing file) the
 * pinned tier has nothing to inject and `buildPinnedMessage()`
 * returns `null` so the wiring layer skips the injection entirely.
 * This keeps the extension self-contained for public use; operators
 * opt in to the pinned surface explicitly.
 */
export function createPinnedTier(opts?: {
	personalityPath?: string;
}): PinnedTier {
	const personalityPath = opts?.personalityPath;

	let personality = "";
	let currentTurn = 0;
	// True once any refresh has run. `buildPinnedMessage` lazily refreshes
	// on its first call if nothing has populated the cache yet (covers the
	// case where a `context` event arrives before `session_start`, and the
	// test path that invokes the context handler directly). Subsequent
	// scheduled refreshes (`session_start`, `turn_end`) re-read on cadence.
	let hasRefreshed = false;

	return {
		get personality() {
			return personality;
		},
		get currentTurn() {
			return currentTurn;
		},
		refresh() {
			personality = readPersonalityMd(personalityPath);
			hasRefreshed = true;
		},
		bumpTurn() {
			currentTurn += 1;
		},
		buildPinnedMessage() {
			if (!hasRefreshed) {
				personality = readPersonalityMd(personalityPath);
				hasRefreshed = true;
			}
			const content = formatPinnedContent(personality);
			if (content.length === 0) return null;
			return {
				role: "custom",
				customType: PINNED_CUSTOM_TYPE,
				content,
				display: false,
			};
		},
		isPinned(path: string) {
			if (path === personalityPath) return true;
			void path; // explicit unused
			return false;
		},
	};
}

// ─── File-system readers (the only I/O surface) ────────────────────────────

/**
 * Read the personality.md file from disk. Returns the verbatim content
 * (the file is small; the convention treats it as a pinned verbatim
 * file, not a tool result that ages). If the file is missing, returns
 * an empty string — the pinned message degrades to nothing, and
 * `buildPinnedMessage()` returns `null` so the wiring layer skips
 * the injection.
 */
function readPersonalityMd(path: string | undefined): string {
	if (!path) return "";
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

// ─── Pinned message formatter (pure) ───────────────────────────────────────

/**
 * Format the pinned-tier content the LLM sees. The personality
 * section is emitted only when it has content (non-empty personality
 * text). Returns an empty string when personality is absent so the
 * caller can skip the injection entirely (no empty placeholder noise).
 *
 * The pinned message is a `display: false` customType — the TUI does
 * not render it as a visible line, but the LLM consumes the content on
 * every call. This is the Pi-native substitute for the Claude Code
 * `UserPromptSubmit` re-injection hack.
 */
function formatPinnedContent(
	personality: string,
): string {
	const parts: string[] = [];
	if (personality.length > 0) {
		parts.push("## Pinned — personality (always present)");
		parts.push(personality);
		parts.push("");
	}
	return parts.join("\n").trimEnd();
}
