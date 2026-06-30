/**
 * T-2706 + T-2707 — Context-trimmer extension entrypoint.
 *
 * T-2706 wires the T-2705 trim policy (`./policy.ts`) into Pi's `context`
 * event — the per-LLM-call, non-destructive message-mutation surface. The
 * handler receives the deep-copy `event.messages` Pi hands it, calls
 * `trimConversation` with the threshold check, applies the keep-mark
 * promotion (T-2707), and returns `{ messages: result.retain }` for Pi
 * to consume as the next LLM call's working view. The `turn_end` handler
 * is observational (mirrors the `examples/extensions/trigger-compact.ts`
 * precedent's `getContextUsage()` + threshold pattern) and does NOT
 * call `ctx.compact()` — Pi's auto-compaction is left intact per T-2704
 * §4 Placement A.
 *
 * T-2707 adds the source-digest surface: the `tool_result` handler
 * replaces verbatim tool/MCP output with fact-of-call + short digest at
 * the source, the `before_agent_start` handler injects the file-read
 * digest (the agent's keep-vs-drop affordance per AC-2), and the
 * `session_start` / `session_shutdown` handlers manage the keep-mark
 * state lifecycle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * T-2704 / T-2705 / T-2706 / T-2707 decomposition seam (load-bearing):
 *
 *   - T-2705 owns the policy: `trimConversation(messages, metrics, options?) -> { retain, trim }`
 *     with the threshold gate (50_000 tokens default) and the recency filter
 *     (20 user-message turns default) inside it. Pure-logic; no Pi imports.
 *   - T-2706 (this file) owns the wiring: the `context` event registration,
 *     the `turn_end` observability handler, and the `event.messages` ↔
 *     `ConversationMessage` bridge at the import boundary.
 *   - T-2707 owns the source-digest surface (`tool_result` handler) and the
 *     file-read surface (`before_agent_start` handler) — both registered
 *     in this file. The digester (`./digest.ts`) and the keep-mark state
 *     (`./keep-mark.ts`) are sibling modules in the same extension
 *     directory; the entrypoint composes them.
 *
 * Boundary discipline:
 *   - The `context` event is non-destructive by Pi's design (`event.messages`
 *     is a deep copy; the policy returns fresh arrays via `slice()`). The
 *     handler does NOT call any write surface (`pi.appendEntry`,
 *     `ctx.sessionManager` is read-only per the Pi docs).
 *   - The `tool_result` handler returns a partial patch (`{ content }`)
 *     that flows into the persisted tool-result message; the handler does
 *     NOT call `pi.appendEntry()` or any write surface — the partial
 *     patch is the write surface, by Pi's design (T-2704 §3).
 *   - The `turn_end` handler does NOT call `ctx.compact()`. Pi's
 *     auto-compaction (`contextWindow - reserveTokens`) is left intact and
 *     reads the already-digested session source.
 *
 * Per-session overrides are deliberately not exposed here: T-2705 ships the
 * defaults (`THRESHOLD = 50_000`, `DEFAULT_RECENCY_WINDOW = 20`) and the
 * handler uses them. Per-project override mechanics, if needed later, are a
 * follow-up per T-2704 §5.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	trimConversation,
	THRESHOLD,
	type ConversationMessage,
} from "./policy.ts";
import { digestToolResultPatch, type DigestibleToolResult } from "./digest.ts";
import {
	createKeepMarkState,
	buildFileReadDigest,
	parseKeepMarksFromText,
	promoteKeptToolResults,
	type KeepMarkState,
	type ToolResultMessage,
} from "./keep-mark.ts";

// ─── State ─────────────────────────────────────────────────────────────────

/**
 * The keep-mark state lives in a module-level variable, scoped to the
 * extension runtime. The runtime is torn down on `session_shutdown` and
 * re-built on `session_start` (per Pi's extension lifecycle); the state
 * is reset on `session_start` to honor the session-scope contract (AC-2
 * says no cross-session memory).
 */
let keepMarkState: KeepMarkState = createKeepMarkState();

/** Per-session turn counter (monotonic, resets on `session_start`). */
let currentTurnIndex = 0;

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Extension factory (T-2706 / AC-4 / T-2707). Per Pi's `Extension Styles` →
 * "Directory with index.ts" pattern, this is the subdirectory form
 * `~/.pi/agent/extensions/context-trimmer/index.ts` (T-2704 §5 lock). The
 * factory is sync — handlers are async, but registration is not.
 */
export default function contextTrimmerExtension(pi: ExtensionAPI): void {
	// ── `context` handler (T-2706 / AC-1) ─────────────────────────────────
	// Fired before each LLM call. `event.messages` is a deep copy per the
	// Pi docs ("Modify messages non-destructively"); safe to filter. The
	// handler returns `{ messages: result.retain }` for Pi to consume as
	// the per-LLM-call view for the next LLM call.
	pi.on("context", (event, ctx) => {
		// Bridge: the policy's structural `ConversationMessage` accepts
		// Pi's `AgentMessage` (the policy documents this — the shape is
		// discriminated on `role`; extra fields pass through). We cast at
		// the import boundary to keep the policy free of Pi imports.
		const messages = event.messages as unknown as ConversationMessage[];

		// Threshold-check surface (T-2706 / AC-2): `ctx.getContextUsage()`
		// is the canonical reading per T-2704 §3. `{ tokens: 0 }` defensive
		// default per the policy's "gate-stays-closed on unknown usage"
		// documented behavior.
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? 0;

		// Pure-logic partition. The policy's threshold gate runs inside
		// `trimConversation`: below `THRESHOLD` (50_000 tokens) the policy
		// returns `{ retain: messages.slice(), trim: [] }` — a no-op that
		// preserves the per-call view length-for-length. At or above
		// `THRESHOLD`, the recency filter runs (last 20 user-message
		// turns retained, older messages moved to `trim` for T-2707).
		const result = trimConversation(messages, { tokens });

		// T-2707 keep-mark promotion (AC-3 seam): move kept tool-result
		// messages from the policy's `trim` set to `retain` so the
		// agent's keep-vs-drop decision is honored. The promotion is a
		// pure helper call; the policy's union-equals-input invariant
		// is preserved (the helper returns a fresh partition that is
		// still a partition of the original input).
		const promoted = promoteKeptToolResults(
			result.trim as unknown as ToolResultMessage[],
			result.retain as unknown as ToolResultMessage[],
			keepMarkState,
		);

		// Return shape per the Pi extension contract:
		//   `{ messages: filtered }` — consumed by Pi as the next
		//   LLM call's working view.
		return { messages: promoted.retain as unknown as typeof event.messages };
	});

	// ── `turn_end` handler (T-2706 / AC-2) ────────────────────────────────
	// Fired for each turn (one LLM response + tool calls). The threshold
	// gate check runs here via `ctx.getContextUsage()`, mirroring the
	// `examples/extensions/trigger-compact.ts` precedent (`turn_end` +
	// `getContextUsage()` + threshold). The actual filter call runs from
	// the `context` handler above; this handler is observational — it
	// surfaces the cross/under signal for observability and future
	// enhancements (per T-2704 §4, the precedent's `ctx.compact()` call
	// is NOT replicated here because Pi's auto-compaction is left intact
	// under Placement A).
	pi.on("turn_end", (_event, _ctx) => {
		// Bump the per-session turn counter. The counter feeds the
		// `turnIndex` field on `ReadFileRecord` so the file-read list
		// preserves read order across turns.
		currentTurnIndex += 1;

		const usage = _ctx.getContextUsage();
		const currentTokens = usage?.tokens ?? null;
		if (currentTokens === null) {
			return; // Usage unavailable — no observation to surface.
		}
		// Cross/under signal relative to the policy's threshold. The policy
		// itself runs the gate on the next `context` event; this handler
		// is the precedent-shaped observation surface (no compaction
		// trigger; no redundant filter call).
		// `crossedThreshold` is true once usage meets or exceeds `THRESHOLD`
		// — the boundary semantics the policy honors ("at exactly
		// THRESHOLD, the gate OPENS").
		const crossedThreshold = currentTokens >= THRESHOLD;
		if (!crossedThreshold) {
			return; // Under threshold — next `context` call will no-op.
		}
		// At/over threshold: the next `context` event will run the recency
		// filter. The handler is observational only — the filter is the
		// `context` handler's job, not this one.
	});

	// ── `session_start` handler (T-2707 / AC-2) ───────────────────────────
	// Fired when a session is started, loaded, or reloaded. The handler
	// resets the keep-mark state and the turn counter to honor the
	// session-scope contract (a dropped file in a previous session is
	// dropped in this session until the agent re-reads it). Pi emits
	// `session_start` for `startup`, `new`, `resume`, `fork`, and `reload`
	// reasons — the reset runs on every one of them (the previous
	// extension instance is torn down on `session_shutdown` before
	// the new instance's `session_start` fires; the module-level state
	// is a fresh instance for the new session by construction, but we
	// reset explicitly to make the lifecycle intent obvious).
	pi.on("session_start", () => {
		keepMarkState = createKeepMarkState();
		currentTurnIndex = 0;
	});

	// ── `session_shutdown` handler (T-2707 / AC-2) ────────────────────────
	// Fired before the session runtime is torn down. The handler clears
	// the read-files set and the keep-mark map explicitly so the next
	// session starts with a clean slate (defense in depth — the
	// `session_start` reset above is the primary seam; this is the
	// belt-and-suspenders for reload flows where the module-level state
	// persists across the shutdown/start pair).
	pi.on("session_shutdown", () => {
		keepMarkState.resetSession();
	});

	// ── `tool_result` handler (T-2707 / AC-1) ─────────────────────────────
	// Fired after tool execution finishes and before `tool_execution_end`
	// plus the final tool result message events are emitted. Can modify
	// result (T-2704 §3): handlers chain like middleware and return
	// partial patches `{ content, details, isError }`; omitted fields
	// keep their current values. The handler is the source-digesting
	// surface per T-2704 §4 Placement A: the modified `{ content }`
	// flows into the persisted tool-result message; the session file
	// stores the digest, not the verbatim output.
	pi.on("tool_result", async (event, _ctx) => {
		// Bridge: the digester accepts a structural `DigestibleToolResult`
		// shape. Pi's typed event is a discriminated union by `toolName`;
		// the bridge is the import boundary (the digester is pure-logic,
		// no Pi imports).
		const event_ = event as unknown as DigestibleToolResult;

		// Observe the read-tool subset for the file-read surface
		// (T-2707 / AC-2). Only the read tool produces a file path
		// the agent can mark keep-vs-drop; other tools are digested
		// but not added to the read-files set.
		if (event_.toolName === "read" && !event_.isError) {
			const path = event_.input.path;
			if (typeof path === "string" && path.length > 0) {
				keepMarkState.recordRead(path, event_.toolCallId, currentTurnIndex);
			}
		}

		// Source-digest: produce the partial patch. The patch is a
		// single text block carrying the `[factOfCall: ...]\n[digest: ...]`
		// envelope; `details` and `isError` are not set (they flow through
		// unchanged per the partial-patch return contract).
		return digestToolResultPatch(event_);
	});

	// ── `before_agent_start` handler (T-2707 / AC-2) ──────────────────────
	// Fired after the user submits a prompt, before the agent loop. The
	// handler injects the file-read digest as a persistent message the
	// agent sees at the start of each turn. The agent can mark files
	// to keep/drop in its response; the next `before_agent_start` reads
	// the keep-mark via `parseKeepMarksFromText` applied to the most
	// recent assistant message.
	pi.on("before_agent_start", async (event, ctx) => {
		// Read the agent's most recent assistant message to discover
		// keep-vs-drop marks. The `ctx.sessionManager.getBranch()` returns
		// the current branch in leaf-to-root order; the FIRST assistant-role
		// entry is the most recent one (Pi walks from the leaf back to the
		// root; newer entries come first). No `reverse()` needed.
		const branch = ctx.sessionManager.getBranch();
		const lastAssistant = branch.find((entry) => {
			const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
			return msg?.role === "assistant";
		});
		const lastAssistantText = extractTextFromMessage(lastAssistant);

		// Parse the keep-marks from the assistant's last message and
		// apply them to the state. The parser only acts on paths the
		// digester has already observed via `recordRead`; a keep-mark
		// for an unobserved path is a no-op (the read must happen first).
		if (lastAssistantText) {
			const knownPaths = new Set(keepMarkState.getReadPaths());
			const marks = parseKeepMarksFromText(lastAssistantText, knownPaths);
			for (const { path, decision } of marks) {
				keepMarkState.setKeepMark(path, decision);
			}
		}

		// Build the file-read digest. The message is a persistent
		// `customType` message the agent sees at the start of this turn
		// (the LLM consumes the content as part of the system context).
		// `display: true` makes it visible in the TUI so the operator
		// can audit the file-read list.
		const digestContent = buildFileReadDigest(keepMarkState);

		// Also surface a low-noise status-bar item for the operator.
		// The status carries the read-file count; it does not need UI
		// attention (setStatus is fire-and-forget; it replaces any prior
		// status this extension set).
		const readCount = keepMarkState.getReadPaths().length;
		if (ctx.hasUI) {
			ctx.ui.setStatus("context-trimmer", `read-files: ${readCount}`);
		}

		return {
			message: {
				customType: "context-trimmer-file-reads",
				content: digestContent,
				display: true,
			},
		};
	});
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Extract concatenated text from a session entry's assistant message.
 * Pi's assistant messages carry content as a `ContentBlock[]` where
 * text blocks have `{ type: "text", text: string }`. The function
 * concatenates all text blocks into a single string for keep-mark
 * parsing. Defensive: unknown shapes return an empty string rather
 * than throwing.
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
