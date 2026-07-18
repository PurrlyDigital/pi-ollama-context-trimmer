# pi-ollama-context-trimmer

Pi extension that trims the LLM-bound message stream against a three-tier token budget. Required for subagents to survive long tool-result tails without blowing the model context window.

This extension is currently targeting Ollama Cloud style per-request billing and does not currently discriminate between providers or models. **Use with token-based billing subscriptions is not recommended.** Anthropic and OpenAI (token-based billing) utilize caching based on the full text. This extension will break that caching model. Ollama bills based on request and how much GPU time a request took. This extension works against that.

## What it does

Every time the LLM is about to be called, the extension inspects the message stream and applies a three-tier trim:

| Tier | Range | Action |
|------|-------|--------|
| Verbatim | 0–50k trimmable tokens | No action; the full message stream is sent. |
| Hold | 50k–100k | Middle-band messages are held untouched (transient behavior; Tier 3 catches oversize if it grows further). |
| Drop | 100k+ | The oldest whole trimmable turns (assistant + toolResult + custom between two user messages) are hard-dropped until the total is back under 100k. |

Subagent protected inputs are **never** counted in the budget, **never** dropped:

1. **The agent def / pinned-tier synthetic** — travels as a `customType: "context-trimmer-pinned"` message in the `messages` array. The trim policy protects it via the `protectedCustomTypes` option. This protection applies whenever the pinned synthetic is injected (i.e. when at least one pinned surface is configured).
2. **The dispatch instructions** — the first user message (identified by `userTurnAge === 0`). The trim policy subtracts its tokens from the cap total so a session whose only over-budget contributor is the dispatch does not trigger a trim. **This protection only applies when the `pi-subagents` extension is installed** — the dispatch concept only exists in a subagent session, so a plain parent session leaves the first user prompt treated as ordinary trimmable content. Detection is automatic (see Config); default is ON when pi-subagents is present.

The extension also injects a **pinned-tier message** on every LLM call: the agent's `personality.md` content (when configured). The injection is reconstructed on every `context` event from the file system; it is not persisted in the session file. **The pinned surface is optional and opt-in** — the extension ships no default path, and when personality is not configured the pinned-tier injection is skipped entirely (no empty placeholder is prepended). See Config below.

## Prerequisites

- **Node.js 20+** (for the extension runtime; tests need 22+ for the test runner)
- **Pi coding agent** installed (`pi --version` should print a version)

## Installation

```bash
pi install git:github.com:PurrlyDigital/pi-ollama-context-trimmer
```

That registers the extension with Pi and adds it to your `settings.json`. You can also install from a local clone:

```bash
pi install /path/to/pi-ollama-context-trimmer
```

The extension is global — once installed, every Pi session (parent and subagent) loads it on startup. The `context` event handler runs on every LLM call, regardless of session age.

## How the protected inputs are wired

- The agent def travels as a **synthetic `custom` message** (`customType: "context-trimmer-pinned"`) prepended to the per-LLM-call view. The trim policy's `protectedCustomTypes` option matches that customType and excludes the synthetic from the budget.
- The dispatch task is the **first user message** in the stream. The wiring layer stamps `userTurnAge === 0` on it; the trim policy's `isProtectedSlot` predicate reads that stamp and exempts the message from drop. The dispatch's tokens are also subtracted from the cap total. **This only happens when dispatch protection is enabled** — which defaults to ON when the `pi-subagents` extension is installed (override with `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH`, see Config). In a plain parent session with no subagent tool, the first user prompt is treated as ordinary trimmable content.
- A session that contains ONLY the dispatch + the pinned synthetic + a single short trimmable message (e.g. a freshly dispatched subagent) never enters the trim path: the trimmable mass is under 50k, so the messages are returned verbatim.

## Loop guard

Defense-in-depth alongside the trim. The trim bounds **context size** (drop / hold-untouched over-budget trimmable mass); the loop guard bounds **behavioral repetition** — a model re-emitting the same tool calls regardless of context. Where the trim reacts to token mass, the loop guard reacts to consecutive identical assistant tool-call turns: at the configured threshold the wiring layer injects a soft nudge, and at the configured hard-block threshold (when set) it strips the offending tool calls and forces a text-only continuation.

The guard is **ON by default for every session** (every session posture — parent and subagent). The previous subagent-only `"auto"` posture was dropped because behavioral-loop detection is the same concern whether the model is in a parent or a subagent session. Operators opt out with `"loopGuard": false` in the config file, or `PI_CONTEXT_TRIMMER_LOOP_GUARD=0` in the environment. The previous `"auto"` value is no longer accepted — it is treated as absent and the resolver falls through to the default `true`.

### How it detects

Each assistant turn's `toolCall` content blocks are fingerprinted as `(toolName, deterministically-sorted-keys args)`. Object key order in the arguments is normalized away (it is an artifact of model serialization, not of the call's identity); array element order is preserved (it is part of the call's identity). A turn's fingerprint is the sorted conjunction of every `toolCall` block's individual fingerprint; a multi-tool-call turn matches the run signature iff every one of its calls matches.

A run is the trailing sequence of consecutive assistant turns whose fingerprints are identical. A **no-tool-call** (reasoning-only) assistant turn yields a distinct fingerprint (a `__no_tool_calls__` signature) so the run resets naturally — the model thinking without re-calling a tool is not a behavioral loop. The guard is therefore scoped to **behavioral** loops, not **reasoning-only** loops.

A **flat input-token co-signal** is computed over the last few assistant turns' input-token counts: when every sample is within a small tolerance of the smallest sample, the signal is "flat." Flat input tokens indicate the model is not progressing on new material; the co-signal is informational and is used to strengthen the nudge text when present (the model receives a single additional sentence noting the flat count).

### How it intervenes

When the run length crosses the configured threshold (default 3), the wiring layer prepends a `role: "user"` synthetic to the LLM-bound view, naming the repetition and pointing the model at the results already in context. The injection rides the same channel as the pinned-tier synthetic and the tier-3 prune reminder. The nudge is non-directive — it is a status note, not a command.

When a **hard-block** threshold is configured (default: off) AND the run length meets or exceeds it, the wiring layer additionally strips the last assistant turn's `toolCall` blocks from the message stream (preserving any textual / thinking content of the same turn) and prepends a `role: "user"` block-notice synthetic. The hard-block path is a strict superset of the soft-nudge path — when both fire, only the block text is emitted, and the model must proceed via text (the tool calls are gone). Re-injection is idempotent: stripping the tool calls breaks the fingerprint on the next turn, so the run resets and the guard goes quiet until the model re-establishes it.

### Scope boundary

The guard detects **behavioral** loops via tool-call signatures. **Reasoning-only** loops (the model re-reasoning without a tool call) are out of scope — a no-tool-call turn yields a distinct fingerprint and resets the run naturally, no special case required.

## Reasoning block cap

Some reasoning-capable models surface a `type:"thinking"` content block on assistant messages — the model's intermediate "chain of thought" that the provider may or may not bill or pass through. The cap is a count-based gate on those blocks: keep the LAST N reasoning blocks (counted from the latest) and drop the rest before the three-tier trim runs.

The cap is a count of blocks, not a measurement of tokens. The trim budget accounts for the post-cap mass, so dropping reasoning blocks at the cap shrinks the budget the three-tier trim needs to satisfy.

| Cap value | Effect |
|-----------|--------|
| `-1` (default) | Passthrough — keep every reasoning block. The default is passthrough so existing operators see no behavior change when upgrading; opt in to a cap by setting the env var or JSON key. |
| `0` | Send no reasoning blocks. |
| `1` | Keep only the last reasoning block; drop all earlier ones. |
| any positive integer | Keep the last N reasoning blocks. |

The cap runs unconditionally on every context event (no per-model branching). The wiring layer applies the cap to the `base` message stream before pinned injection, so the pinned synthetic is never at risk of being dropped.

Reasoning blocks are content blocks of shape `{ type: "thinking"; thinking: string }` on assistant messages. The default is passthrough; set the env var or JSON key to `0` (send none) or a positive integer to opt in to a cap.

## Pre-budget collapse

Three transcript-entry categories accumulate outside the three-tier budget: `intercom_message` custom entries (full subagent output delivered via the intercom channel), `subagent-notify` custom entries (status notifications), and `toolResult` entries from the `subagent` tool (full subagent dispatch echoes). The trimmer collapses them on a separate, extension-gated pre-budget pass that runs **before** the three-tier budget computation, so the downstream protected-slot, recency-slice, path-stamp, reasoning-cap, and loop-guard paths see the already-collapsed stream.

| Rule | Category | Gate | Behavior |
|------|----------|------|----------|
| 1 | `intercom_message` (`role: "custom"`, `customType: "intercom_message"`) | `intercom` tool registered (pi-intercom) | Recency hardtrim — keep the last N by stream order, drop the rest. Integer semantics: `-1` = keep all (passthrough — default), `0` = keep none, positive N = keep last N. |
| 2 | `subagent-notify` (`role: "custom"`, `customType: "subagent-notify"`) | `intercom` tool registered (pi-intercom) | Dedup — keep the first occurrence of each run identity in stream order; drop subsequent duplicates. No operator knob; duplicates are always noise. Run identity priority: `details.sessionValue` → `details` fingerprint → content-header agent name → stream index. |
| 3 | `toolResult:subagent` (`role: "toolResult"`, `toolName: "subagent"`) | `subagent` tool registered (pi-subagents) | Latest-only — drop every such entry except the last by stream order. No operator knob. |

> **Surface split:** Chain and parallel completions emit on **both** `subagent-notify` (display notification, governed by `subagentNotifyKeepLast`) and, when an intercom target is set, `intercom_message` (grouped result, governed by `intercomKeepLast`). The two knobs compose independently — see the `subagentNotifyKeepLast` defaulting paragraph below and the env-var rows for `PI_CONTEXT_TRIMMER_INTERCOM_KEEP_LAST` / `PI_CONTEXT_TRIMMER_SUBAGENT_NOTIFY_KEEP_LAST`.

Each pass is skipped entirely (no array allocation, no scan) when its gating extension is not present. The pinned synthetic is never at risk — it is injected AFTER the pre-budget window, matching the existing `applyReasoningBlockCap` invariant. A session without the gating extension sees no behavior change on any of the three rules.

## Config

The trim policy's three tier caps live as compile-time constants in `policy.ts` and are also exposed as operator-configurable knobs through the two config channels described below. The compile-time values are the defaults when neither channel sets a value:

| Constant | Default | Meaning |
|----------|---------|---------|
| `VERBATIM_TIER_MAX_TOKENS` | `50_000` | Trimmable totals at or below this are returned verbatim. |
| `SUMMARIZE_TIER_MAX_TOKENS` | `100_000` | Trimmable totals above this fall into the drop tier. |

The pinned tier exposes one constant in `pinned-tier.ts`:

| Constant | Default | Meaning |
|----------|---------|---------|
| `PINNED_CUSTOM_TYPE` | `"context-trimmer-pinned"` | The customType stamp on the synthetic pinned message. |

The personality file is **opt-in** — machine-specific, carrying no default. There are two config channels, with a fixed precedence (highest first):

1. **Environment variables** (`PI_CONTEXT_TRIMMER_*`) — useful for ad-hoc runs, CI, and tests.
2. **Global config file** `~/.pi/agent/context-trimmer.json` — the persistent, filesystem-based channel. This is the channel to use when pi is launched by a non-interactive supervisor (systemd, launchd, a container orchestrator) that does not inherit your shell environment: put the paths in the JSON file instead of exporting them in a shell rc the supervisor never sources.

### Config file

Create `~/.pi/agent/context-trimmer.json`:

```json
{
  "personalityPath": "/absolute/path/to/personality.md",            // falls back to no personality section
  "protectDispatch": "auto",                                        // "auto" (default) | true | false
  "preservedPaths": ["AGENTS.md", "~/secrets/keys.md"],             // falls back to no paths preserved
  "tier1MaxTokens": 50000,                                          // falls back to VERBATIM_TIER_MAX_TOKENS
  "tier2MaxTokens": 100000,                                         // falls back to SUMMARIZE_TIER_MAX_TOKENS
  "loopGuard": true,                                                // true (default) | false
  "loopGuardThreshold": 3,                                          // falls back to 3 (consecutive identical tool-call turns)
  "loopGuardHardBlock": 10,                                         // falls back to off; positive int enables hard-block
  "reasoningBlockCap": -1,                                          // -1 passthrough (default), 0 send none, N keep last N
  "intercomKeepLast": -1,                                            // -1 passthrough (default), 0 send none, N keep last N
  "subagentNotifyKeepLast": -1                                       // -1 passthrough (default), 0 send none, N keep last N; unset → falls through to intercomKeepLast
}
```

All fields are optional. `protectDispatch` accepts `"auto"` (default — ON when `pi-subagents` is installed), or `true` / `false` to force. `loopGuard` accepts `true` (default — ON for every session) or `false` to opt out; the previous `"auto"` sentinel is no longer accepted (a `"auto"` value in the file is treated as absent and the resolver falls through to the default `true`). The two tier-threshold fields (`tier1MaxTokens`, `tier2MaxTokens`) follow the same env-over-file-over-default precedence the other fields already document, with the compile-time constants in `policy.ts` as the final default. Each threshold value must be a positive finite number — non-numeric, zero, negative, `NaN`, and `Infinity` are all treated as absent (the resolver falls back to the other channel / defaults), matching the existing "badly-typed values are treated as absent" rule. `reasoningBlockCap` is an integer in `[-1, ∞)`: `-1` is the passthrough sentinel (the default — every block survives), `0` means "send no reasoning blocks", and any positive integer is the count of blocks to keep from the latest. Non-integer, less than `-1`, `NaN`, and `Infinity` are all treated as absent; the resolver falls through to the env / default layer (`-1`). `intercomKeepLast` is the count-based knob for the Rule 1 pre-budget collapse: integer in `[-1, ∞)`, same validation rules as `reasoningBlockCap`. The default is `-1` (passthrough — every `intercom_message` entry survives). The Rule 1 pass is gated on the `intercom` tool being registered; without the gating extension, the rule is inert regardless of the knob's value. `subagentNotifyKeepLast` is the count-based knob for the Rule 2b pre-budget collapse (recency hardtrim for `subagent-notify` custom entries): integer in `[-1, ∞)`, same validation rules as `intercomKeepLast`. The default is the resolved `intercomKeepLast` value (env > JSON > `DEFAULT_INTERCOM_KEEP_LAST` = `-1` passthrough) — when `subagentNotifyKeepLast` is unset in both channels, the effective value equals the resolved `intercomKeepLast`. The Rule 2b pass is gated on the `intercom` tool being registered (same gate as Rules 1 and 2); without the gating extension, the rule is inert regardless of the knob's value. The pass runs after `dedupSubagentNotify` (dedup first, then recency trim on the deduped stream). Chain and parallel completions emit on both `subagent-notify` and `intercom_message` surfaces — see the surface-split callout in the pre-budget collapse rule table above. The file is read once at extension load; restart pi to pick up an edit. Unknown keys are ignored; badly-typed values are treated as absent.

`preservedPaths` is an optional list of patterns whose matching tool-result messages are protected from drop and whose tokens are subtracted from the trimmable budget. A bare filename like `AGENTS.md` is a **fuzzy** match — it matches any file of that name regardless of path. A pattern beginning with `/` or `~/` is an **absolute** match; the `~/` form is expanded to your home directory (e.g. `~/secrets/keys.md` matches that one file at `$HOME/secrets/keys.md`). When `preservedPaths` is unset, no paths are preserved; when set, the patterns above are protected from the trim budget.

### Environment variables (override the file)

| Env var | Effect |
|---------|--------|
| `PI_CONTEXT_TRIMMER_PERSONALITY_PATH` | Absolute path to a personality/voice file pinned verbatim on every LLM call. Unset/empty → falls back to the file, then no personality section. |
| `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH` | `1` forces dispatch protection ON, `0` forces OFF. Unset/other → falls back to the file, then `"auto"`. |
| `PI_CONTEXT_TRIMMER_PRESERVED_PATHS` | Comma-separated list of path patterns whose matching tool-result messages are protected from drop. Bare filenames are fuzzy matches (e.g. `AGENTS.md` matches any AGENTS.md); patterns beginning with `/` or `~/` are absolute matches (e.g. `~/secrets/keys.md` matches that one file). Unset/empty → falls back to the file, then no paths preserved. |
| `PI_CONTEXT_TRIMMER_TIER1_MAX_TOKENS` | Positive finite number; the verbatim-tier cap (tokens). Unset/empty/non-numeric/zero/negative → falls back to the file, then `VERBATIM_TIER_MAX_TOKENS` (`50_000`). |
| `PI_CONTEXT_TRIMMER_TIER2_MAX_TOKENS` | Positive finite number; the summarize-tier cap (tokens). Unset/empty/non-numeric/zero/negative → falls back to the file, then `SUMMARIZE_TIER_MAX_TOKENS` (`100_000`). |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD` | `1` forces the loop guard ON, `0` forces OFF. Unset/other (including the previous `"auto"` sentinel) → falls back to the file, then the default `true` (ON for every session, independent of `pi-subagents` presence). |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD` | Positive integer; the soft-nudge threshold (consecutive identical tool-call turns before the wiring layer injects a nudge). Unset/empty/non-numeric/zero/negative → falls back to the file, then `3`. |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD_HARD_BLOCK` | Positive integer; the hard-block threshold (consecutive identical tool-call turns before the wiring layer strips the tool calls and forces a text-only continuation). Unset → falls back to the file, then off. Values below the soft-nudge threshold are clamped up to the soft-nudge threshold so the hard-block cannot fire before the soft-nudge. |
| `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP` | Integer in `[-1, ∞)`. The count of `type:"thinking"` content blocks (counted from the latest) to keep per message stream. `-1` is the passthrough (every block survives), `0` sends none, any positive integer is the count. The cap runs before the three-tier trim, so the budget sees the post-cap mass. Unset/empty/non-integer/less than `-1`/non-numeric → falls back to the file, then the default `-1` (passthrough — existing operators see no behavior change when upgrading). |
| `PI_CONTEXT_TRIMMER_INTERCOM_KEEP_LAST` | Integer in `[-1, ∞)`. The count of `intercom_message` custom entries (counted from the latest) to keep per message stream. `-1` is the passthrough (every entry survives), `0` sends none, any positive integer is the count. The pass is gated on the `intercom` tool being registered (pi-intercom installed); without the gating extension, the rule is inert regardless of the knob. The pass runs before the three-tier trim, so the budget sees the post-pass mass. Unset/empty/non-integer/less than `-1`/non-numeric → falls back to the file, then the default `-1` (passthrough — existing operators see no behavior change when upgrading). Chain and parallel completions also emit on `subagent-notify` — see the surface-split callout in the pre-budget collapse rule table. |
| `PI_CONTEXT_TRIMMER_SUBAGENT_NOTIFY_KEEP_LAST` | Integer in `[-1, ∞)`. The count of `subagent-notify` custom entries (counted from the latest) to keep per message stream. `-1` is the passthrough (every entry survives), `0` sends none, any positive integer is the count. The pass is gated on the `intercom` tool being registered (same gate as Rules 1 and 2); without the gating extension, the rule is inert regardless of the knob. The pass runs after `dedupSubagentNotify` (dedup first, then recency trim on the deduped stream). Unset/empty/non-integer/less than `-1`/non-numeric → falls back to the file, then the resolved `intercomKeepLast` value (env > JSON > `DEFAULT_INTERCOM_KEEP_LAST` = `-1` passthrough). Chain and parallel completions also emit on `intercom_message` — see the surface-split callout in the pre-budget collapse rule table. |
| `PI_CONTEXT_TRIMMER_CONFIG_PATH` | Override the config-file location (default `~/.pi/agent/context-trimmer.json`). Useful for tests or operators who keep config elsewhere. |

When neither channel resolves a `personalityPath`, the pinned-tier injection is skipped entirely (the wiring calls `buildPinnedMessage()`, gets `null`, and prepends nothing). The two trim-policy thresholds follow the same env-over-file-over-default precedence as every other field — the compile-time constants in `policy.ts` are the final fallback when neither channel sets a value, so the pre-existing behaviour is preserved for operators who configure nothing.

## How the token count is computed

The extension uses a simple approximation: per message, `Math.ceil(text_length / 4)` where `text_length` is the extracted text content (string content is taken as-is; array content is concatenated across `{ type: "text", text: string }` blocks; tool-result blocks are stringified). Non-text content blocks contribute their JSON-stringified length, which undercounts multi-modal content — that bias is the safe direction (we trim sooner rather than later).

The trimmable total is the sum of per-message tokens **minus** the protected-slot tokens (the pinned synthetic when injected, and the dispatch task when dispatch protection is enabled). The budget is measured against the trimmable mass, not the raw mass.

## Development

Run the test suite (316 tests, ~1s on a modern laptop):

```bash
npm install   # installs tsx as a dev dependency
npm test
```

The test runner is `tsx --test` (NOT `node --test` on `.ts` — native type-stripping without `"type": "module"` thrashes the CPU). Tests use deterministic in-process stubs.

Project structure:

```
index.ts              # Extension wiring: registers session_start / turn_end / context handlers
config.ts             # Pure config resolver (parse file + merge env over file)
policy.ts             # Three-tier trim policy (the trim algorithm)
pinned-tier.ts        # Pinned content reader (personality)
test/policy.test.ts    # Unit tests for the trim policy
test/config.test.ts    # Unit tests for config resolution (precedence + parsing)
test/integration.test.ts # End-to-end tests for the context handler wiring
tsconfig.json         # TypeScript config for the extension
tsconfig.policy.json  # Narrower TypeScript config for the policy module
package.json          # Pi extension manifest (name, pi-package keyword, pi.extensions, peerDependencies)
```

## License

MIT
