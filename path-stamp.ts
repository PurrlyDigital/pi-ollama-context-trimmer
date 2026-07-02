// ─── Path-stamp seam (preserved-paths channel) ───────────────────────
//
// The trim policy's pure predicate (`isPathPreserved` in `policy.ts`)
// has no filesystem access and the trim path is purely view-time. The
// source-path information that drives the `isPathPreserved` match
// must therefore be **stamped onto the trimmable message before the
// predicate runs**, and the stamping has to work for any tool-
// dispatch path that can produce a tool result carrying file content
// (`read_file`, shell `cat`, `get_file`, future tools).
//
// This module is the wiring-layer public seam: it exposes the pure
// stampee (`stampSourcePath`) and the view-time re-derivation helpers
// (`persistStamp` / `rederiveStamp`). The wiring's `context` handler
// imports the seam directly (per the locked engineering call #4 —
// direct import + call, not a pi event listener).
//
// The seam is pure-functional: no `process.*`, no `node:fs`, no
// `node:os`. The only state is the module-scoped `Map` backing
// `persistStamp` / `rederiveStamp`; the map survives within a session
// and dies with the module reload.

/** Custom-type stamp the wiring applies to a trimmable message when
 *  its source path matches a `preservedPaths` pattern. The trim
 *  policy protects the message via the existing `protectedCustomTypes`
 *  channel — the new customType rides the same machinery. */
export const PRESERVED_CUSTOM_TYPE = "context-trimmer-preserved";

/**
 * Stamp a trimmable message with its source path. Returns the
 * message with `details.sourcePath` set when `sourcePath` is a
 * non-empty string; returns the message unchanged (with an empty
 * `details: {}` when the message had none) when `sourcePath` is
 * undefined or empty. Pure: no side effects.
 *
 * The stamp rides on the existing `details?: Record<string, unknown>`
 * field on `TrimmableMessage` (per the locked engineering call #2 —
 * `details` over a new top-level `sourcePath` field). The wiring
 * spreads the source message into the trimmable message and stamps
 * via this helper before the predicate runs.
 */
export function stampSourcePath<T extends { details?: Record<string, unknown> }>(
	msg: T,
	sourcePath: string | undefined,
): T & { details: Record<string, unknown> } {
	if (typeof sourcePath !== "string" || sourcePath.length === 0) {
		// Un-stamped: ensure `details` is a present (empty) record so
		// the return type contract holds. The trim policy reads
		// `details.sourcePath` and treats undefined as "no source
		// path."
		return { ...msg, details: msg.details ?? {} };
	}
	const existing = msg.details ?? {};
	return {
		...msg,
		details: { ...existing, sourcePath },
	};
}

/**
 * In-memory map of tool-call-id → source path. Module-scoped — not
 * on `globalThis`, not on a process-wide singleton. The map survives
 * within a session and dies with the module reload; persistence is
 * best-effort by design (a tool result that arrives on a later turn
 * within the same session is the case the landscape's "Mark the
 * async seam" note covers — the stamp persists with the message or
 * is re-derivable on view time).
 */
const persistedStamps: Map<string, string> = new Map();

/**
 * Persist a stamp so a tool result arriving on a later turn carries
 * its source path into the next trim view. Best-effort: stores the
 * `(toolCallId, sourcePath)` pair in the module-scoped map and
 * resolves. Returns `Promise<void>` per the locked signature; the
 * async shape is forward-looking (a future implementation may persist
 * to a sidecar; the v1 in-memory map resolves synchronously).
 */
export function persistStamp(toolCallId: string, sourcePath: string): Promise<void> {
	if (typeof toolCallId !== "string" || toolCallId.length === 0) {
		return Promise.resolve();
	}
	if (typeof sourcePath !== "string" || sourcePath.length === 0) {
		return Promise.resolve();
	}
	persistedStamps.set(toolCallId, sourcePath);
	return Promise.resolve();
}

/**
 * Re-derive a stamp on view time. Returns the source path for a
 * `toolCallId`, or `undefined` if the stamp has not been persisted.
 * The wiring calls this on each trimmable message that arrives
 * without a stamped `details.sourcePath`; the re-derivation lets a
 * tool result from a prior turn carry its source path into the
 * current trim view.
 */
export function rederiveStamp(toolCallId: string): string | undefined {
	if (typeof toolCallId !== "string" || toolCallId.length === 0) {
		return undefined;
	}
	return persistedStamps.get(toolCallId);
}

/** Test seam: clear the persisted-stamps map. NOT exported on the
 *  public surface (the public surface is the three named exports);
 *  tests can import this helper explicitly when they need to reset
 *  state between cases. */
export function _resetPersistedStamps(): void {
	persistedStamps.clear();
}
