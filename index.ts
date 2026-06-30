/**
 * T-2717 + T-2720 — Context-trimmer extension entrypoint.
 *
 * T-2717 redesigned the T-2703 / T-2706 / T-2707 extension into the
 * keep/digest/retire lifecycle. The shipped T-2703 design was
 * source-digesting at `tool_result` (T-2704 Placement A) — the agent
 * saw the digest, not the verbatim output, on the producing turn.
 * The T-2717 redesign moves digesting to view-time: the agent sees
 * the verbatim output on the producing turn and the digest on all
 * later turns. The redesign also unifies the digest + keep-mark
 * surfaces into one keep/digest/retire engine over all tool outputs,
 * adds a pinned tier (auto-pin by convention) for always-present
 * essentials, and reframes the recency threshold as a comfort knob
 * (no longer a compaction trigger).
 *
 * T-2720 adds a per-Pi-turn cadence to the lifecycle. A subagent
 * is a single-prompt run with many Pi-turns; the T-2717 user-turn
 * cadence never fires inside a subagent, so every tool result a
 * subagent produces stays `verbatim` for the entire subagent run.
 * T-2720 adds:
 *   - A `piTurnIndex` counter bumped at `turn_end` (the Pi-turn
 *     boundary; sibling to `currentTurnIndex` bumped at
 *     `before_agent_start`).
 *   - A `piTurnAge` field on `ToolOutputRecord` and the persisted
 *     message shape, stamped at `tool_result` time.
 *   - A `piTurnAge <= K` clause in `applyLifecycleState` (the K
 *     knob: `PI_TURN_DIGEST_AFTER`, default `Infinity` for the
 *     parent, subagent override via env).
 *   - A `piTurnAge > M` clause in `applyLifecycleState` (the M
 *     knob: `PI_TURN_RETIRE_AFTER`, default `Infinity` for the
 *     parent, subagent override via env).
 *   - An optional hard token cap (Layer 4 of the `context` handler):
 *     force-retire oldest tool outputs when the per-LLM-call view
 *     exceeds `MAX_SESSION_TOKENS` (default 800_000) or
 *     `PI_SESSION_TOKENS` (subagent override).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Five paths (AC-5 — the cross-path contract)
 *
 *   1. `tool_result` handler (write-time):
 *      Stamps the tool-result message with `age = currentTurnIndex`
 *      and stores the side-by-side envelope `content: <verbatim> +
 *      details: { digest: <pre-computed envelope> }` (Storage Shape A
 *      — the per-AC tension resolution; see the storage-shape
 *      rationale below). The handler returns the partial-patch
 *      `{ content: <verbatim>, details: { digest, turnIndex } }` so
 *      Pi persists both payloads naturally through the existing
 *      partial-patch contract.
 *
 *   2. `context` handler (view-time):
 *      - Applies `trimConversation` (recency comfort window; the
 *        threshold gate is removed per AC-4).
 *      - Applies `applyLifecycleState` (the renamed
 *        `promoteKeptToolResults` from AC-2): for each tool-result
 *        message, swap content to digest if the message is on a
 *        turn other than the producing turn; honor `kept` /
 *        `dropped` overrides.
 *      - Prepends the pinned-tier message (AC-3): the synthetic
 *        `context-trimmer-pinned` message built by
 *        `pinnedTier.buildPinnedMessage()`. The LLM sees it at
 *        the top of every per-LLM-call view; the recency filter
 *        cannot retire it (it's added after the filter runs).
 *
 *   3. Pi session persistence: the session file stores the full
 *      `ToolResultMessageShape` (verbatim + digest + age). The
 *      compactor reads the session, sees the digest for all but
 *      the most recent turn, summarizes clean source. Coexistence
 *      with Pi's auto-compaction is unchanged (T-2704 §4 rationale
 *      still holds).
 *
 *   4. `trimConversation` (the recency filter): runs unconditionally
 *      on every `context` event (no threshold gate). Carves the
 *      most recent 20 user-message-initiated turns into `retain`,
 *      the rest into `trim`. The lifecycle engine then runs on
 *      `retain` to apply the per-message swap; `trim` is persisted
 *      in the session, excluded from the view.
 *
 *   5. `applyLifecycleState` (the lifecycle engine): reads the
 *      keep/drop state for each tool-result message in the `retain`
 *      set and applies the swap (verbatim-on-producing-turn, digest
 *      on later turns, kept → verbatim regardless, dropped → excluded).
 *      The function's union-equals-input invariant is preserved.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Storage shape (Tension-1 — Senior BE resolution)
 *
 *   **Shape A: `content: verbatim` + `details: { digest: <envelope> }`.**
 *   Reasons:
 *   - Stays closest to Pi's existing `tool_result` partial-patch
 *     contract (`{ content, details, isError }`). The handler returns
 *     `content: verbatim` and `details: { digest, toolCallId, turnIndex }`
 *     in one partial patch; Pi persists both naturally.
 *   - The view-time handler reads `message.content` for verbatim and
 *     `message.details.digest` for digest — both already-typed paths
 *     in the persisted message shape.
 *   - Shape B (multi-block `content: [verbatim, digest]`) would
 *     require a new field on the tool-result message that the
 *     downstream Pi consumers (compactor, LLM serializer) would
 *     have to learn. Shape A reuses existing paths.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Boundary discipline
 *
 *   - The `context` event is non-destructive by Pi's design
 *     (`event.messages` is a deep copy; the policy returns fresh
 *     arrays via `slice()`). The handler does NOT call any write
 *     surface (`pi.appendEntry`, `ctx.sessionManager` is read-only
 *     per the Pi docs).
 *   - The `tool_result` handler returns a partial patch
 *     (`{ content, details }`) that flows into the persisted
 *     tool-result message; the handler does NOT call
 *     `pi.appendEntry()` or any other write surface — the partial
 *     patch is the write surface, by Pi's design (T-2704 §3).
 *   - The `turn_end` handler does NOT call `ctx.compact()`. Pi's
 *     auto-compaction (`contextWindow - reserveTokens`) is left
 *     intact and reads the digested session source. The trimmer
 *     coexists by keeping the working window small continuously;
 *     the auto-compaction is the safety net that never fires.
 *
 * Per-session overrides are deliberately not exposed here: the
 * trimmer ships with the defaults (`RECENCY_COMFORT_WINDOW = 20`,
 * `DEFAULT_PINNED_TRACKER_COUNT = 5`); per-project override
 * mechanics, if needed later, are a follow-up per T-2704 §5.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	trimConversation,
	type ConversationMessage,
	PI_TURN_DIGEST_AFTER,
	PI_TURN_RETIRE_AFTER,
} from "./policy.ts";
import { digestToolResult, type DigestibleToolResult } from "./digest.ts";
import {
	createLifecycleState,
	parseLifecycleMarksFromText,
	applyLifecycleState,
	buildToolOutputDigest,
	buildToolResultEnvelope,
	type LifecycleState,
	type LifecycleMessage,
} from "./lifecycle-state.ts";
import {
	createPinnedTier,
	type PinnedTier,
	type PinnedMessage,
} from "./pinned-tier.ts";

// ─── State ─────────────────────────────────────────────────────────────────

/**
 * The lifecycle state lives in a module-level variable, scoped to the
 * extension runtime. The runtime is torn down on `session_shutdown` and
 * re-built on `session_start` (per Pi's extension lifecycle); the state
 * is reset on `session_start` to honor the session-scope contract.
 */
let lifecycleState: LifecycleState = createLifecycleState();

/** The pinned tier: auto-pin-by-convention. Refreshed on
 *  `session_start` and on each `turn_end` (so newly-created tickets
 *  are picked up). */
let pinnedTier: PinnedTier = createPinnedTier();

/** Per-session turn counter (monotonic, resets on `session_start`).
 *  The counter feeds the `age` field on tool-result messages so the
 *  lifecycle engine can compare to the current turn. */
let currentTurnIndex = 0;

/** T-2720 — Per-session per-Pi-turn counter (monotonic, resets on
 *  `session_start`, bumped at `turn_end`). Sibling to `currentTurnIndex`
 *  but tracks a different cadence: `currentTurnIndex` is bumped at
 *  `before_agent_start` (the user-turn boundary, one bump per user
 *  prompt); `piTurnIndex` is bumped at `turn_end` (the Pi-turn boundary,
 *  one bump per LLM-response cycle).
 *
 *  Why two counters: a subagent is a single-prompt run with many
 *  Pi-turns but exactly one user-turn boundary. Reusing
 *  `currentTurnIndex` for both would confl ate the two cadences
 *  and undo the `1202d53` regression fix (which moved the user-turn
 *  bump to `before_agent_start` to keep same-user-turn tool results
 *  verbatim across the agent's work on that prompt). The per-Pi-turn
 *  counter is the load-bearing primitive that lets the lifecycle
 *  engine apply the per-Pi-turn cap inside a subagent where the
 *  user-turn boundary never fires. */
let piTurnIndex = 0;

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Extension factory. Per Pi's `Extension Styles` → "Directory with
 * index.ts" pattern, this is the subdirectory form
 * `~/.pi/agent/extensions/context-trimmer/index.ts` (T-2704 §5 lock).
 * The factory is sync — handlers are async, but registration is not.
 */
export default function contextTrimmerExtension(pi: ExtensionAPI): void {
	// ── `context` handler (AC-1 + AC-2 + AC-3 + AC-4 + T-2720) ──────────
	// Fired before each LLM call. The handler applies the four layers
	// in order:
	//   1. trimConversation (recency comfort window; AC-4)
	//   2. applyLifecycleState (verbatim/digest/kept/dropped swap;
	//      AC-1+2; T-2720 adds the per-Pi-turn cap to the engine)
	//   3. Pinned-tier injection (auto-pin by convention; AC-3)
	//   4. T-2720 token-cap check (force-retire oldest tool outputs
	//      when the per-LLM-call view exceeds the configured token
	//      budget; the `or` clause in the per-L7 unified retire rule)
	// The four layers compose: the recency filter carves the candidate
	// set, the lifecycle engine applies the per-message swap, the
	// pinned-tier message is prepended, and the token cap is the
	// last-resort ceiling.
	pi.on("context", (event, ctx) => {
		// T-2720: read the per-Pi-turn knobs and the token cap at the
		// top of the handler. The parent leaves the env vars unset
		// and gets the Infinity defaults (the per-Pi-turn clause
		// becomes a no-op, preserving the T-2717 user-turn-bounded
		// behavior). The subagent dispatch sets the env vars at the
		// dispatch boundary to override. Reading order:
		//   PI_TURN_DIGEST_AFTER → K (digest threshold)
		//   PI_TURN_RETIRE_AFTER → M (retire threshold)
		//   PI_SESSION_TOKENS    → subagent token cap
		//   MAX_SESSION_TOKENS   → parent token cap (default 800_000)
		const piTurnDigestAfter = readEnvNumber(
			"PI_TURN_DIGEST_AFTER",
			PI_TURN_DIGEST_AFTER,
		);
		const piTurnRetireAfter = readEnvNumber(
			"PI_TURN_RETIRE_AFTER",
			PI_TURN_RETIRE_AFTER,
		);
		const sessionTokensCap = readEnvNumber(
			"PI_SESSION_TOKENS",
			readEnvNumber("MAX_SESSION_TOKENS", 800_000),
		);

		// Bridge: the policy's structural `ConversationMessage` accepts
		// Pi's `AgentMessage` (the policy documents this — the shape
		// is discriminated on `role`; extra fields pass through). We
		// cast at the import boundary to keep the policy free of Pi
		// imports.
		const messages = event.messages as unknown as ConversationMessage[];

		// Layer 1: recency comfort window (AC-4). Runs unconditionally;
		// no threshold gate. The recency window is the only retention
		// signal.
		const result = trimConversation(messages);

		// Layer 2: lifecycle state (AC-1 + AC-2 + T-2720). The engine
		// reads the current turn index, the per-message `age` stamp
		// (written at `tool_result` time), the per-message `piTurnAge`
		// stamp (T-2720), the per-Pi-turn thresholds (K, M), and the
		// agent's keep/drop overrides. The output is a fresh `retain`
		// array where each tool-result message has been swapped to
		// its per-age payload (verbatim on the producing turn and
		// within K, digest when prior user turn OR piTurnAge > K,
		// excluded when piTurnAge > M, kept → verbatim regardless,
		// dropped → excluded).
		const withLifecycle = applyLifecycleState(
			result.retain as unknown as LifecycleMessage[],
			lifecycleState,
			currentTurnIndex,
			piTurnIndex,
			piTurnDigestAfter,
			piTurnRetireAfter,
		);

		// Layer 3: pinned-tier injection (AC-3). The synthetic message
		// is prepended to the per-LLM-call view so the LLM sees the
		// always-present essentials (personality + last-N tracker) at
		// the top of every call. The pinned message is `display: false`
		// so the TUI does not render it as a visible line.
		const pinnedMessage: PinnedMessage = pinnedTier.buildPinnedMessage();
		let finalMessages: LifecycleMessage[] = [
			// `custom` role so the LLM sees the content; Pi's existing
			// custom-message support handles this without a new role.
			pinnedMessage as unknown as LifecycleMessage,
			...withLifecycle,
		];

		// Layer 4: T-2720 token-cap check (the per-L7 "or token cap
		// hit" clause in the retire branch). The cap is the
		// last-resort ceiling that runs after the per-Pi-turn cadence
		// and the recency filter have done their per-message work. If
		// the per-LLM-call view's approximate token count exceeds the
		// cap, the handler force-retires the oldest tool-result
		// messages (by `piTurnAge` descending) until the count is
		// under the cap. The "force-retire" is a per-call exclusion
		// from the view, NOT a state mutation — the engine stays pure.
		// Approximate token count: `text.length / 4` for each text
		// block (the standard `chars/4` heuristic). The cap is
		// applied LAST so the per-Pi-turn cadence and the recency
		// filter get first crack at trimming.
		if (Number.isFinite(sessionTokensCap)) {
			finalMessages = applyTokenCap(finalMessages, sessionTokensCap);
		}

		// Surface a low-noise status-bar item for the operator. The
		// status carries the tool-output count; it does not need UI
		// attention (setStatus is fire-and-forget; it replaces any
		// prior status this extension set).
		if (ctx.hasUI) {
			const recordCount = lifecycleState.records.size;
			ctx.ui.setStatus("context-trimmer", `tool-outputs: ${recordCount}`);
		}

		// Return shape per the Pi extension contract:
		//   `{ messages: filtered }` — consumed by Pi as the next
		//   LLM call's working view.
		return { messages: finalMessages as unknown as typeof event.messages };
	});

	// ── `turn_end` handler (AC-3 + T-2720) ─────────────────────────────
	// Fired for each Pi turn (one LLM response + tool calls). The
	// user-turn boundary is `before_agent_start` (one bump per user
	// prompt), NOT here — a single user prompt spans many Pi turns
	// (the agent calls tools and continues across LLM responses), and
	// bumping here aged same-user-turn tool results to "digest" before
	// the agent finished using them (the regression this fix
	// corrects). `turn_end` only refreshes the pinned tier's last-N
	// tracker cache (best-effort; newly-created tickets picked up).
	//
	// T-2720 adds a SECOND counter that DOES bump here: the per-Pi-turn
	// counter. The Pi-turn cadence is the right granularity for the
	// per-Pi-turn cap (a subagent has one user-turn boundary but many
	// Pi-turns; the cap needs the higher-resolution signal to fire
	// inside a subagent). The bump is the FIRST line of the handler
	// (per the AC-5 async seam: the next `context` event must see the
	// incremented value).
	pi.on("turn_end", async (_event, _ctx) => {
		// T-2720: per-Pi-turn cadence. Bumped first so the next
		// `context` event reads the incremented value (the AC-5 async
		// seam: the next `context` event must see the incremented
		// value).
		piTurnIndex += 1;
		pinnedTier.bumpTurn();
		// Refresh the tracker cache on each turn so the pinned
		// message always reflects the latest work. The refresh is
		// best-effort (a tracker hiccup degrades to "no pinned
		// tickets" — see `pinned-tier.ts`).
		pinnedTier.refresh();
	});

	// ── `session_start` handler (AC-2 + AC-3 + T-2720) ─────────────────
	// Fired when a session is started, loaded, or reloaded. The
	// handler resets the lifecycle state, the pinned tier, and BOTH
	// turn counters (user-turn + per-Pi-turn) to honor the session-
	// scope contract (a dropped tool result in a previous session is
	// dropped in this session until the agent re-produces it).
	pi.on("session_start", async () => {
		lifecycleState = createLifecycleState();
		pinnedTier = createPinnedTier();
		currentTurnIndex = 0;
		// T-2720: reset the per-Pi-turn counter alongside the user-turn
		// counter. Both are session-scoped; both are reset together.
		piTurnIndex = 0;
		// First refresh: populate the personality + last-N tracker
		// cache so the first `context` call sees a populated pinned
		// message. The refresh is best-effort.
		pinnedTier.refresh();
	});

	// ── `session_shutdown` handler ─────────────────────────────────────
	// Fired before the session runtime is torn down. The handler
	// clears the state explicitly so the next session starts with a
	// clean slate (defense in depth — the `session_start` reset is
	// the primary seam; this is the belt-and-suspenders for reload
	// flows where the module-level state persists across the
	// shutdown/start pair).
	pi.on("session_shutdown", () => {
		lifecycleState.resetSession();
	});

	// ── `tool_result` handler (AC-1 + AC-2 + T-2720) ─────────────────
	// Fired after tool execution finishes. The handler:
	//   1. Records the tool output in the lifecycle state (so the
	//      engine knows about it for the view-time swap). The record
	//      carries both stamps: the user-turn `turnIndex` (for the
	//      T-2717 user-turn-bounded swap) and the per-Pi-turn
	//      `piTurnAge` (for the T-2720 per-Pi-turn cap).
	//   2. Computes the side-by-side envelope
	//      (`{ content: verbatim, details: { digest, toolCallId, turnIndex, piTurnAge } }`)
	//      and returns it as the partial-patch. Pi persists both
	//      payloads naturally through the existing partial-patch
	//      contract (Storage Shape A — the per-AC tension resolution;
	//      see the storage-shape rationale at the file top).
	pi.on("tool_result", async (event, _ctx) => {
		// Bridge: the digester / lifecycle engine accept a structural
		// `DigestibleToolResult` / `DigestibleToolResult` shape. Pi's
		// typed event is a discriminated union by `toolName`; the
		// bridge is the import boundary (the digester is pure-logic,
		// no Pi imports).
		const event_ = event as unknown as DigestibleToolResult;

		// Record the tool output. The lifecycle engine keys on
		// `toolCallId`; every tool result gets one record. The `key`
		// is the agent's keep/drop affordance handle (path for
		// read/write/edit, command for bash, pattern+path for
		// grep/find, path for ls, tool id for MCP-generic).
		//
		// T-2720: pass the current `piTurnIndex` as the per-Pi-turn
		// stamp. The value is frozen at `recordToolResult` time; the
		// engine reads it at view time to apply the per-Pi-turn cap.
		const key = extractToolKey(event_);
		lifecycleState.recordToolResult(
			event_.toolName,
			event_.toolCallId,
			key,
			currentTurnIndex,
			piTurnIndex,
		);

		// Build the side-by-side envelope. The verbatim content
		// goes in `content`; the pre-computed digest goes in
		// `details.digest`; the per-Pi-turn stamp goes in
		// `details.piTurnAge`. Pi persists all three.
		//
		// T-2720: pass `piTurnIndex` so the envelope carries the
		// per-Pi-turn stamp. The stamp travels with the persisted
		// message; the engine reads it at view time.
		const envelope = buildToolResultEnvelope(event_, currentTurnIndex, piTurnIndex);
		return {
			content: envelope.content as unknown as { type: "text"; text: string }[],
			details: envelope.details,
		};
	});

	// ── `before_agent_start` handler (AC-2 + AC-1 turn boundary) ────────
	// Fired after the user submits a prompt, before the agent loop —
	// the user-turn boundary. The handler:
	//   1. Bumps `currentTurnIndex` ONCE per user prompt (not per Pi
	//      turn). `turn_end` fires per LLM-response cycle, which is more
	//      granular than the user turn; bumping there aged
	//      same-user-turn tool results to "digest" before the agent
	//      finished using them (the regression this fix corrects).
	//      Bumping here keeps tool results verbatim across the agent's
	//      full work on this user prompt (across many Pi turns) and
	//      only thins them to digest on the NEXT user submission.
	//   2. Parses the assistant's most recent message for keep/drop
	//      marks (the agent's keep-vs-drop affordance).
	//   3. Injects the per-tool-output digest (widened from "Read
	//      files" to "Tool outputs" per AC-2).
	pi.on("before_agent_start", async (event, ctx) => {
		// User-turn boundary: bump the turn counter once per user
		// prompt, before any tool_result in this user turn stamps it.
		currentTurnIndex += 1;

		// Read the agent's most recent assistant message to discover
		// keep-vs-drop marks. The `ctx.sessionManager.getBranch()`
		// returns the current branch in leaf-to-root order; the FIRST
		// assistant-role entry is the most recent one (Pi walks from
		// the leaf back to the root; newer entries come first). No
		// `reverse()` needed.
		const branch = ctx.sessionManager.getBranch();
		const lastAssistant = branch.find((entry) => {
			const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
			return msg?.role === "assistant";
		});
		const lastAssistantText = extractTextFromMessage(lastAssistant);

		// Parse the lifecycle marks from the assistant's last message
		// and apply them to the state. The parser only acts on keys
		// the engine has already observed via `recordToolResult`; a
		// keep-mark for an unobserved key is a no-op (the tool
		// result must have happened first).
		if (lastAssistantText) {
			const knownKeys = new Set<string>();
			for (const r of lifecycleState.records.values()) {
				knownKeys.add(r.key);
			}
			const marks = parseLifecycleMarksFromText(lastAssistantText, knownKeys);
			for (const { key, override } of marks) {
				// Look up the toolCallId for the matching key. The
				// engine keys records on toolCallId; the agent marks
				// by key, so we resolve key → toolCallId here.
				for (const [id, r] of lifecycleState.records) {
					if (r.key === key) {
						lifecycleState.setLifecycleOverride(id, override);
					}
				}
			}
		}

		// Build the per-tool-output digest. The message is a
		// `customType: "context-trimmer-tool-outputs"` message the
		// agent sees at the start of this turn. The digest widens
		// from "Read files" (BACKUP) to "Tool outputs" (T-2717).
		const digestContent = buildToolOutputDigest(lifecycleState, currentTurnIndex);

		return {
			message: {
				customType: "context-trimmer-tool-outputs",
				content: digestContent,
				display: true,
			},
		};
	});
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * T-2720 — Read a numeric env var with a fallback default. The function
 * is the seam the per-Pi-turn knobs (K, M) and the token cap use to
 * reach the engine. The function lives in `index.ts` (the wiring
 * surface) because the env read is the wiring; the pure-logic modules
 * (`policy.ts`, `lifecycle-state.ts`) stay process-free.
 *
 * A non-integer or non-parseable value falls back to the default
 * (the parent's Infinity default, or the token cap's 800_000 default).
 * The fallback is documented behavior — the env var is best-effort,
 * not a hard contract.
 */
function readEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return fallback;
	return parsed;
}

/**
 * T-2720 — Apply the optional hard token cap (Layer 4 of the
 * `context` handler). If the per-LLM-call view's approximate token
 * count exceeds the cap, the function force-retires the oldest
 * tool-result messages (by `piTurnAge` descending) until the count
 * is under the cap. Non-tool-result messages (user, assistant,
 * pinned, custom) are never retired by the cap — the cap is a
 * per-L7 "or token cap hit" clause for tool outputs.
 *
 * The "force-retire" is a per-call exclusion from the view, NOT a
 * state mutation — the engine stays pure. The function returns a
 * fresh array; if no exclusion is needed, the array is shallow-copied.
 *
 * Token counting heuristic: `Math.ceil(text.length / 4)` per text
 * block (the standard `chars/4` heuristic Pi's `estimateTokens` uses
 * in `compaction.ts`). The heuristic is approximate; the cap is a
 * safety net, not a precise budget.
 */
function applyTokenCap(
	messages: LifecycleMessage[],
	cap: number,
): LifecycleMessage[] {
	if (messages.length === 0) return messages.slice();
	const total = approximateMessageTokens(messages);
	if (total <= cap) return messages.slice();

	// Walk and exclude oldest tool-results by `piTurnAge` desc until
	// under cap. The loop preserves order (splice, not rearrangements);
	// non-tool-result messages and tool-results without a stamp are
	// skipped (they are not candidates for the cap-driven retire).
	const working = messages.slice();
	while (approximateMessageTokens(working) > cap) {
		let oldestIdx = -1;
		let oldestAge = -Infinity;
		for (let i = 0; i < working.length; i++) {
			const m = working[i];
			if (!m || m.role !== "toolResult") continue;
			const details = m.details;
			if (!details || typeof details !== "object") continue;
			const age = details.piTurnAge;
			if (typeof age !== "number" || !Number.isFinite(age)) continue;
			if (age > oldestAge) {
				oldestIdx = i;
				oldestAge = age;
			}
		}
		if (oldestIdx === -1) break; // No more tool-results to retire.
		working.splice(oldestIdx, 1);
	}
	return working;
}

/**
 * T-2720 — Approximate the total token count of a messages array.
 * The heuristic is `Math.ceil(text.length / 4)` per text block,
 * summed across all messages. Non-text content (images, etc.) is
 * counted as 0 — the cap is a safety net for textual tool outputs,
 * not a precise budget for multimedia. The function is pure (no
 * mutation, no I/O).
 */
function approximateMessageTokens(messages: LifecycleMessage[]): number {
	let total = 0;
	for (const m of messages) {
		const content = m.content;
		if (typeof content === "string") {
			total += Math.ceil(content.length / 4);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				total += Math.ceil((block as { text: string }).text.length / 4);
			}
		}
	}
	return total;
}

/**
 * Extract the agent-facing key for a tool result. The key is the
 * handle the agent uses in `keep <key>` / `drop <key>` patterns:
 *   - `read`/`write`/`edit` → file path
 *   - `bash`               → the command string
 *   - `grep`/`find`        → `<pattern>@<path>`
 *   - `ls`                 → the path
 *   - MCP-custom           → the tool id
 * Missing fields produce an empty key (the tool result is still
 * recorded; the agent can still use the toolCallId in the future
 * if a richer key extraction is added).
 */
function extractToolKey(event: DigestibleToolResult): string {
	const input = event.input;
	switch (event.toolName) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return typeof input.path === "string" ? input.path : "";
		case "bash":
			return typeof input.command === "string" ? input.command : "";
		case "grep":
		case "find": {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			const path = typeof input.path === "string" ? input.path : "";
			return path ? `${pattern}@${path}` : pattern;
		}
		default:
			// MCP custom / future built-ins: use the tool id as the key.
			return event.toolName;
	}
}

/**
 * Extract concatenated text from a session entry's assistant message.
 * Pi's assistant messages carry content as a `ContentBlock[]` where
 * text blocks have `{ type: "text", text: string }`. The function
 * concatenates all text blocks into a single string for lifecycle
 * mark parsing. Defensive: unknown shapes return an empty string
 * rather than throwing.
 */
function extractTextFromMessage(entry: unknown): string {
	if (!entry || typeof entry !== "object") return "";
	const message = (entry as { message?: { content?: unknown } }).message;
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: string }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}
