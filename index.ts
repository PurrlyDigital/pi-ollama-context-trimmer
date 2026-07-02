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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyThreeTierTrim,
	defaultSummaSummarizer,
	VERBATIM_TIER_MAX_TOKENS,
	SUMMARIZE_TIER_MAX_TOKENS,
	type TrimmableMessage,
} from "./policy.ts";
import { createPinnedTier, PINNED_CUSTOM_TYPE } from "./pinned-tier.ts";

// ─── Per-message stamp: userTurnAge ────────────────────────────────────

/**
 * Stamp `userTurnAge` (the user-turn index) on every message. The
 * first user message in the array gets `userTurnAge === 0` and is
 * the protected dispatch slot. The counter increments on each
 * subsequent user message. Non-user messages inherit the most
 * recent `userTurnAge`. The stamp is the source of truth for the
 * dispatch-task protection.
 *
 * The stamp is computed at `before_agent_start` view time and is
 * a pure function of the input message order — no session state
 * is consulted. This makes the trim path deterministic and easy
 * to test.
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

// ─── Extension entry point ─────────────────────────────────────────────

/**
 * The default-exported extension function. Registers:
 *   - `session_start` to initialize the pinned-tier and track the
 *     current working directory (so the tracker query is scoped).
 *   - `turn_end` to refresh the pinned-tier (the last-5 tickets
 *     pointer advances over time).
 *   - `before_agent_start` to do the three-tier trim.
 */
export default function contextTrimmerExtension(pi: ExtensionAPI): void {
	const pinnedTier = createPinnedTier();

	pi.on("session_start", async (_event, _ctx) => {
		pinnedTier.refresh();
	});

	pi.on("turn_end", async () => {
		pinnedTier.refresh();
		pinnedTier.bumpTurn();
	});

	pi.on("context", async (event, _ctx) => {
		// Read the current message stream.
		const rawMessages = (event.messages ?? []) as unknown as ReadonlyArray<Record<string, unknown>>;
		// Stamp userTurnAge on every message. The stamp is the source
		// of truth for the dispatch-task protection; we pass the
		// minimum shape (role) to the stampee and use the original
		// content/customType downstream.
		const stampedAges = stampUserTurnAge(
			rawMessages.map((m) => ({ role: String(m.role ?? "user") })),
		);
		// Build the pinned-tier synthetic (the agent def). Prepend it
		// to the message stream so the trim policy can mark it
		// protected via `protectedCustomTypes`.
		const pinned = pinnedTier.buildPinnedMessage();
		const withPinned: TrimmableMessage[] = [
			{
				role: "custom",
				content: pinned.content,
				customType: PINNED_CUSTOM_TYPE,
			},
			...rawMessages.map((m, i) => ({
				// Preserve all original pi-specific fields (usage, toolCallId,
				// details, timestamp, id, parentId, model, …). Pi's downstream
				// reads message.usage.totalTokens; reconstructing with only the
				// trim fields dropped usage and threw "reading 'totalTokens'" on
				// undefined. Spread the source, then layer the trim stamps on top.
				...m,
				role: stampedAges[i].role as TrimmableMessage["role"],
				content: m.content,
				userTurnAge: stampedAges[i].userTurnAge,
				customType: typeof m.customType === "string" ? m.customType : undefined,
			})),
		];
		// Run the three-tier trim. Production uses defaultSummaSummarizer
		// (a Python `summa` subprocess). The result excludes the pinned
		// message from the budget.
		const result = applyThreeTierTrim(withPinned, {
			summarizer: defaultSummaSummarizer,
			verbatimMaxTokens: VERBATIM_TIER_MAX_TOKENS,
			summarizeMaxTokens: SUMMARIZE_TIER_MAX_TOKENS,
			protectedCustomTypes: new Set([PINNED_CUSTOM_TYPE]),
		});
		// Cast back to the session message shape and return. The
		// pinned message rides out at the top; the rest are the
		// trimmed trimmable messages. The double-cast mirrors the
		// pattern in the prior wiring: `TrimmableMessage` and
		// `AgentMessage` share a structural core (role, content, etc.)
		// but the session type carries provider-specific fields the
		// policy does not inspect.
		const out = result.messages.map((m) => m as unknown as Record<string, unknown>);
		return { messages: out as unknown as typeof event.messages };
	});
}
