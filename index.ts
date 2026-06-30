/**
 * T-2717 — Context-trimmer extension entrypoint.
 *
 * Redesign of the T-2703 / T-2706 / T-2707 extension into the
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

import { trimConversation, type ConversationMessage } from "./policy.ts";
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

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Extension factory. Per Pi's `Extension Styles` → "Directory with
 * index.ts" pattern, this is the subdirectory form
 * `~/.pi/agent/extensions/context-trimmer/index.ts` (T-2704 §5 lock).
 * The factory is sync — handlers are async, but registration is not.
 */
export default function contextTrimmerExtension(pi: ExtensionAPI): void {
	// ── `context` handler (AC-1 + AC-2 + AC-3 + AC-4) ───────────────────
	// Fired before each LLM call. The handler applies the four layers
	// in order:
	//   1. trimConversation (recency comfort window; AC-4)
	//   2. applyLifecycleState (verbatim/digest/kept/dropped swap; AC-1+2)
	//   3. Pinned-tier injection (auto-pin by convention; AC-3)
	// The four layers compose: the recency filter carves the candidate
	// set, the lifecycle engine applies the per-message swap, and the
	// pinned-tier message is prepended to the result.
	pi.on("context", (event, ctx) => {
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

		// Layer 2: lifecycle state (AC-1 + AC-2). The engine reads the
		// current turn index, the per-message `age` stamp (written at
		// `tool_result` time), and the agent's keep/drop overrides.
		// The output is a fresh `retain` array where each tool-result
		// message has been swapped to its per-age payload (verbatim
		// on the producing turn, digest on later turns, kept →
		// verbatim regardless, dropped → excluded).
		const withLifecycle = applyLifecycleState(
			result.retain as unknown as LifecycleMessage[],
			lifecycleState,
			currentTurnIndex,
		);

		// Layer 3: pinned-tier injection (AC-3). The synthetic message
		// is prepended to the per-LLM-call view so the LLM sees the
		// always-present essentials (personality + last-N tracker) at
		// the top of every call. The pinned message is `display: false`
		// so the TUI does not render it as a visible line.
		const pinnedMessage: PinnedMessage = pinnedTier.buildPinnedMessage();
		const finalMessages = [
			// `custom` role so the LLM sees the content; Pi's existing
			// custom-message support handles this without a new role.
			pinnedMessage as unknown as LifecycleMessage,
			...withLifecycle,
		];

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

	// ── `turn_end` handler (AC-3) ───────────────────────────────────────
	// Fired for each Pi turn (one LLM response + tool calls). The
	// user-turn boundary is `before_agent_start` (one bump per user
	// prompt), NOT here — a single user prompt spans many Pi turns
	// (the agent calls tools and continues across LLM responses), and
	// bumping here aged same-user-turn tool results to "digest" before
	// the agent finished using them (the regression this fix
	// corrects). `turn_end` only refreshes the pinned tier's last-N
	// tracker cache (best-effort; newly-created tickets picked up).
	pi.on("turn_end", async (_event, _ctx) => {
		pinnedTier.bumpTurn();
		// Refresh the tracker cache on each turn so the pinned
		// message always reflects the latest work. The refresh is
		// best-effort (a tracker hiccup degrades to "no pinned
		// tickets" — see `pinned-tier.ts`).
		pinnedTier.refresh();
	});

	// ── `session_start` handler (AC-2 + AC-3) ───────────────────────────
	// Fired when a session is started, loaded, or reloaded. The
	// handler resets the lifecycle state, the pinned tier, and the
	// turn counter to honor the session-scope contract (a dropped
	// tool result in a previous session is dropped in this session
	// until the agent re-produces it).
	pi.on("session_start", async () => {
		lifecycleState = createLifecycleState();
		pinnedTier = createPinnedTier();
		currentTurnIndex = 0;
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

	// ── `tool_result` handler (AC-1 + AC-2) ─────────────────────────────
	// Fired after tool execution finishes. The handler:
	//   1. Records the tool output in the lifecycle state (so the
	//      engine knows about it for the view-time swap).
	//   2. Computes the side-by-side envelope
	//      (`{ content: verbatim, details: { digest, toolCallId, turnIndex } }`)
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
		const key = extractToolKey(event_);
		lifecycleState.recordToolResult(
			event_.toolName,
			event_.toolCallId,
			key,
			currentTurnIndex,
		);

		// Build the side-by-side envelope. The verbatim content
		// goes in `content`; the pre-computed digest goes in
		// `details.digest`. Pi persists both.
		const envelope = buildToolResultEnvelope(event_, currentTurnIndex);
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
