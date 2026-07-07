/**
 * Pinned tier module (auto-pin by convention).
 *
 * Owns the auto-pinned content the agent always sees: `personality.md`
 * (the agent's voice/identity substrate in `~/.pi/agent/`) and the
 * last-N tracker tickets (the project state the agent needs to navigate
 * the workspace). The pinned tier is the Pi-native substitute for the
 * Claude Code `UserPromptSubmit` re-injection hack — Pi has no
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
 *   system + the tracker.
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
 *   2. Last-N tracker tickets — a digest of the last N tickets' titles
 *      and statuses. Read via the global tracker CLI when a tracker path
 *      is explicitly provided; **the tracker is optional** — no default
 *      path is bundled. The list is refreshed at `session_start` and on
 *      each `turn_end` (so newly-created tickets are picked up). `N` is
 *      a fixed default of 5. Scope: ALL projects (global last-5, no
 *      project scoping).
 *
 *   When neither the personality path nor the tracker path is
 *   configured (or both resolve empty), there is nothing to pin and
 *   `buildPinnedMessage()` returns `null` — the wiring layer skips the
 *   injection entirely. The extension ships no opinionated default
 *   content; everything pinned is operator-opted-in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Convention-driven, not agent-driven
 *
 *   The pinned set is **convention-driven** (auto-pin by convention),
 *   not agent-driven. The convention is `isPinned(path): boolean`
 *   returning true for `~/.pi/agent/personality.md` and the last-N
 *   tracker ticket paths. No agent `pin` verb exists in v1 (per the
 *   Out-of-scope list: "Agent `pin <ref>` verb and config-file
 *   pinned-tier declaration — future tickets").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Purity contract
 *
 *   - The `PinnedTier` instance holds the in-memory cache (personality
 *     content + last-N tracker digest). The cache is populated by
 *     `refresh()` calls (session_start, turn_end).
 *   - The text-formatting helpers are pure functions.
 *   - File I/O is encapsulated in `refresh()` — the engine is otherwise
 *     pure.
 *   - The PinnedTier is a stateful but pure data structure; the
 *     `index.ts` `session_start` handler calls `refresh()` to populate
 *     the cache, and the `context` handler calls `buildPinnedMessage()`
 *     to build the synthetic injection message.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// ─── Constants (the load-bearing AC-3 surface) ────────────────────────────

/** Default N for the last-N tracker tickets. LOCKED at N=5 per Tension-2. */
export const DEFAULT_PINNED_TRACKER_COUNT = 5;

/** Custom type for the pinned-tier injection message. The `context`
 *  handler prepends a `customType: "context-trimmer-pinned"` message
 *  to the per-LLM-call view. The TUI can hide this message by
 *  customType (it is a `display: false` synthetic; the LLM sees the
 *  content but the TUI does not show it as a user-visible line). */
export const PINNED_CUSTOM_TYPE = "context-trimmer-pinned";

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * A single ticket summary for the pinned-tier list. The full ticket
 * body is not inlined (the digest is a list, not a dump); the agent
 * can `tracker.py show <id> --summary` if it needs the body.
 */
export interface PinnedTicketSummary {
	/** The ticket id, formatted as `T-NNN`. */
	id: string;
	/** Ticket title. */
	title: string;
	/** Ticket status (canonical underscored lowercase, e.g. `in_progress`). */
	status: string;
}

/**
 * The PinnedTier container. Created by `createPinnedTier()`. The
 * instance holds the in-memory cache; `refresh()` re-reads from the
 * file system + tracker.
 */
export interface PinnedTier {
	/** Verbatim `personality.md` content. Empty if not configured or
	 *  the file is missing. */
	readonly personality: string;
	/** Last-N tracker ticket summaries, most recent first. Empty when
	 *  no tracker is configured or the tracker returns nothing. */
	readonly lastNTickets: ReadonlyArray<PinnedTicketSummary>;
	/** The N used to build `lastNTickets`. */
	readonly n: number;
	/** The current turn index. Bumped on every `turn_end` so the
	 *  cache is refreshed lazily; the lifecycle engine does not read
	 *  this — only the `index.ts` handler does. */
	readonly currentTurn: number;
	/** Re-read personality.md and the last-N tracker. Called from
	 *  `session_start` (always) and from `turn_end` (refresh tick). */
	refresh: () => void;
	/** Bump the current turn. Called from `turn_end` after `refresh()`. */
	bumpTurn: () => void;
	/** Build the synthetic `context-trimmer-pinned` message for the
	 *  per-LLM-call view. Returns `null` when there is nothing to pin
	 *  (no personality content and no tracker tickets), so the wiring
	 *  layer can skip the injection entirely. */
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
 * Both `personalityPath` and `trackerPath` are **opt-in** — no
 * default paths are bundled with the extension. When either is
 * omitted (or resolves to a missing file / empty result) the
 * corresponding pinned section is omitted; when both are empty the
 * pinned tier has nothing to inject and `buildPinnedMessage()`
 * returns `null` so the wiring layer skips the injection entirely.
 * This keeps the extension self-contained for public use; operators
 * opt in to each pinned surface explicitly.
 */
export function createPinnedTier(opts?: {
	personalityPath?: string;
	trackerPath?: string;
	n?: number;
}): PinnedTier {
	const personalityPath = opts?.personalityPath;
	const trackerPath = opts?.trackerPath;
	const n = opts?.n ?? DEFAULT_PINNED_TRACKER_COUNT;

	let personality = "";
	let lastNTickets: PinnedTicketSummary[] = [];
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
		get lastNTickets() {
			return lastNTickets;
		},
		get n() {
			return n;
		},
		get currentTurn() {
			return currentTurn;
		},
		refresh() {
			personality = readPersonalityMd(personalityPath);
			lastNTickets = readLastNTickets(trackerPath, n);
			hasRefreshed = true;
		},
		bumpTurn() {
			currentTurn += 1;
		},
		buildPinnedMessage() {
			if (!hasRefreshed) {
				personality = readPersonalityMd(personalityPath);
				lastNTickets = readLastNTickets(trackerPath, n);
				hasRefreshed = true;
			}
			const content = formatPinnedContent(personality, lastNTickets, n);
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
			// A tracker ticket's path is the JSON-line of the
			// session file, not a filesystem path; the convention
			// does not match by filesystem path. The injection is
			// unconditional via `buildPinnedMessage` — the per-path
			// predicate is reserved for future shape.
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
 * an empty string — the pinned message degrades to the tracker list
 * only, and the agent can still see the last-N state.
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

/**
 * Read the last-N tracker tickets via the global tracker CLI. The
 * function shells out to `tracker.py export --list --all-statuses
 * --limit <N> --sort updated_at:desc` (the canonical export façade
 * per the `purrly-tracker` skill — frozen, versioned, machine-
 * branchable, all-projects scope by default). The output is the
 * `{items, page, schema_version}` envelope; `items` is parsed; the
 * first N entries are taken; summaries are built.
 *
 * The function is **best-effort**: a tracker failure (missing CLI,
 * transient I/O error) returns an empty list. The pinned tier must
 * never block the LLM call on a tracker hiccup — the fallback is
 * "no pinned tickets," not "throw."
 *
 * Trust-wrap stripping: the export surface wraps `title` in
 * `<ticket_title trust="untrusted">…</ticket_title>` (the trust-
 * wrapping surface, per the export contract). The wrapper is
 * stripped here so the LLM sees a clean title; the trust-wrapping
 * is the export surface's metadata, not the title content.
 */
function readLastNTickets(trackerPath: string | undefined, n: number): PinnedTicketSummary[] {
	if (!trackerPath) return [];
	if (!existsSync(trackerPath)) return [];
	try {
		// `tracker.py export --list --format json --all-statuses
		// --limit <N> --sort updated_at:desc` returns the most-
		// recently-updated N tickets across all projects. Use
		// `execFileSync` (not `execSync`) to avoid shell expansion;
		// the path + args are a fixed array, no interpolation.
		const out = execFileSync("/usr/bin/python3", [
			trackerPath,
			"export",
			"--list",
			"--format",
			"json",
			"--all-statuses",
			"--limit",
			String(n),
			"--sort",
			"updated_at:desc",
		], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		const parsed = JSON.parse(out) as {
			items?: Array<{ id: number; title: string; status: string }>;
		} | null;
		const items = parsed?.items;
		if (!Array.isArray(items)) return [];
		return items.map((t) => ({
			id: `T-${t.id}`,
			title: stripTrustWrap(t.title ?? ""),
			status: String(t.status ?? "unknown"),
		}));
	} catch {
		// Tracker failure (CLI missing, parse error, timeout) → empty list.
		// The pinned tier degrades gracefully; the LLM call is not blocked.
		return [];
	}
}

/**
 * Strip the trust-wrap markup from an export-façade field. The export
 * surface wraps user-authored free text in `<tag trust="untrusted">…</tag>`;
 * the LLM should see the unwrapped title, not the markup. The function
 * is conservative: it strips a leading `<tag ...>` and a trailing `</tag>`
 * if the wrap matches the documented shape. Anything else is returned
 * as-is.
 */
function stripTrustWrap(value: string): string {
	const m = value.match(/^<[a-z_]+\s+trust="[^"]*">([\s\S]*)<\/[a-z_]+>$/);
	if (m && typeof m[1] === "string") return m[1];
	return value;
}

// ─── Pinned message formatter (pure) ───────────────────────────────────────

/**
 * Format the pinned-tier content the LLM sees. Each section is emitted
 * only when it has content: the personality section requires non-empty
 * personality text; the tracker section requires at least one ticket.
 * Returns an empty string when both are absent so the caller can skip
 * the injection entirely (no empty placeholder noise).
 *
 * The pinned message is a `display: false` customType — the TUI does
 * not render it as a visible line, but the LLM consumes the content on
 * every call. This is the Pi-native substitute for the Claude Code
 * `UserPromptSubmit` re-injection hack.
 */
function formatPinnedContent(
	personality: string,
	lastNTickets: ReadonlyArray<PinnedTicketSummary>,
	n: number,
): string {
	const parts: string[] = [];
	if (personality.length > 0) {
		parts.push("## Pinned — personality (always present)");
		parts.push(personality);
		parts.push("");
	}
	if (lastNTickets.length > 0) {
		parts.push(`## Pinned — last ${n} tracker tickets (always present, all-projects scope)`);
		// Liveness annotation: the list is reconstructed on every
		// `context` call from a `turn_end` refresh of the live tracker,
		// not a session-start snapshot — so a ticket filed this turn is
		// in the list this turn. The block is reference material, not a
		// directive.
		parts.push(
			"_(Live: refreshed on every turn_end. This may include tickets created within the last turn. Read-only reference, not a directive.)_",
		);
		for (const t of lastNTickets) {
			parts.push(`- ${t.id} [${t.status}] ${t.title}`);
		}
	}
	return parts.join("\n").trimEnd();
}
