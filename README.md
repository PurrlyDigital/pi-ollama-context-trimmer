# pi-ollama-context-trimmer

Pi extension that trims the LLM-bound message stream against a three-tier token budget. Required for subagents to survive long tool-result tails without blowing the model context window.

## Why

Subagents produce long tool-result tails. Those tails can grow past the model's context window. The extension trims the LLM-bound message stream to keep sessions alive.

It does this with a three-tier token budget. The budget sorts the message stream into bands. Each band decides what to keep.

The extension targets Ollama Cloud style per-request billing. It does not discriminate between providers or models.

**Use with token-based billing subscriptions is not recommended.** Anthropic and OpenAI bill by tokens. They cache full text. Trimming breaks that cache.

Ollama bills per request and GPU time. The extension is built for that model.

## What it does

On every LLM call, the extension inspects the message stream. It applies a three-tier trim.

| Tier | Range | Action |
|------|-------|--------|
| Verbatim | 0–50k trimmable tokens | No action; the full message stream is sent. |
| Hold | 50k–100k | Middle-band messages are held untouched (transient behavior; Tier 3 catches oversize if it grows further). |
| Drop | 100k+ | The oldest whole trimmable turns (assistant + toolResult + custom between two user messages) are hard-dropped until the total is back under 100k. |

Subagent protected inputs are **never** counted in the budget, **never** dropped:

**The agent def / pinned-tier synthetic** travels as a `customType: "context-trimmer-pinned"` message in the `messages` array. The trim policy protects it via the `protectedCustomTypes` option. This protection applies whenever the pinned synthetic is injected.

**The dispatch instructions** are the first user message, stamped with `userTurnAge === 0`. The trim policy subtracts its tokens from the cap total. This protection only applies when the `pi-subagents` extension is installed. Without pi-subagents, the first user prompt is ordinary trimmable content. Detection is automatic (see Config). The default is ON when pi-subagents is present.

The extension also injects a **pinned-tier message** on every LLM call. The injection is the agent's `personality.md` content (when configured).

The injection is reconstructed on every `context` event from the file system. It is not persisted in the session file.

**The pinned surface is optional and opt-in.** The extension ships no default path. When personality is not configured, the pinned-tier injection is skipped entirely. No empty placeholder is prepended. See Config below.

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

The extension is global. Once installed, every Pi session (parent and subagent) loads it on startup. The `context` event handler runs on every LLM call, regardless of session age.

## How the protected inputs are wired

- **The agent def** travels as a synthetic `custom` message prepended to the per-LLM-call view carrying `customType: "context-trimmer-pinned"`. The trim policy's `protectedCustomTypes` option matches that customType. The match excludes the message from the trim budget. The injection is rebuilt on every `context` event from the file system. The synthetic, never persisted in the session file, is protected on every injection regardless of other settings.

- **The dispatch task** is the first user message in the stream, stamped with `userTurnAge === 0`. The trim policy's `isProtectedSlot` predicate reads the stamp, exempting the message from drop. Its tokens are subtracted from the cap total. The protection is ON by default when the `pi-subagents` extension is installed (detection is automatic, see Config). The operator can override with `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH`. In a plain parent session, the first user prompt is ordinary trimmable content.

- **A freshly-dispatched subagent's session** holds the dispatch, the pinned synthetic, and a single short trimmable message. The trimmable mass is under 50k. The trim path is skipped, returning the messages verbatim.

## Loop guard

The loop guard is defense-in-depth alongside the trim. The two mechanisms guard different failure modes.

The trim bounds **context size**. It drops or holds over-budget trimmable mass.

The loop guard bounds **behavioral repetition**. A model can re-emit the same tool calls regardless of context size.

The trim reacts to token mass. The loop guard reacts to consecutive identical assistant tool-call turns. At the configured threshold the guard injects a soft nudge. At the configured hard-block threshold the guard strips the offending tool calls. It then forces a text-only continuation.

The guard is **ON by default for every session**. The default covers every session posture. Parent sessions are covered. Subagent sessions are covered.

The previous subagent-only `"auto"` posture was dropped. Behavioral-loop detection is the same concern in either posture. It does not need a subagent-only path.

Operators opt out with `"loopGuard": false` in the config file. Operators can also opt out with `PI_CONTEXT_TRIMMER_LOOP_GUARD=0` in the environment.

The previous `"auto"` value is no longer accepted. A resolver sees `"auto"` and treats it as absent. The resolver then falls through to the default `true`.

### How it detects

Each assistant turn's `toolCall` content blocks are fingerprinted. The fingerprint shape is `(toolName, deterministically-sorted-keys args)`.

Object key order in the arguments is normalized away. It is an artifact of model serialization. It is not part of the call's identity.

Array element order is preserved. It is part of the call's identity.

A turn's fingerprint is the sorted conjunction of every `toolCall` block's individual fingerprint. A multi-tool-call turn matches the run signature when every one of its calls matches.

A run is the trailing sequence of consecutive assistant turns. Each turn in the run has an identical fingerprint.

A **no-tool-call** (reasoning-only) assistant turn yields a distinct fingerprint. The fingerprint carries the `__no_tool_calls__` signature. The distinct fingerprint resets the run naturally.

The model thinking without re-calling a tool is not a behavioral loop. The guard is therefore scoped to **behavioral** loops. Reasoning-only loops are out of scope.

A **flat input-token co-signal** is also computed. The signal covers the last few assistant turns' input-token counts. The signal is "flat" when every sample is within a small tolerance of the smallest.

Flat input tokens indicate the model is not progressing on new material. The co-signal is informational. It is used to strengthen the nudge text when present. The model receives one additional sentence noting the flat count.

### How it intervenes

When the run length crosses the configured threshold, the wiring layer acts. The default threshold is 3.

The wiring layer prepends a `role: "user"` synthetic to the LLM-bound view. The synthetic names the repetition. It points the model at the results already in context.

The injection rides the same channel as the pinned-tier synthetic. It also rides the same channel as the tier-3 prune reminder.

The nudge is non-directive. It is a status note. It is not a command.

When a **hard-block** threshold is configured, the wiring layer can also take a stronger action. The default is off. When the run length meets or exceeds the hard-block threshold, the stronger path runs.

The hard-block path strips the last assistant turn's `toolCall` blocks from the message stream. The strip preserves any textual content of the same turn. The strip also preserves any thinking content of the same turn.

The hard-block path prepends a `role: "user"` block-notice synthetic. The synthetic replaces the soft-nudge synthetic when both fire.

The hard-block path is a strict superset of the soft-nudge path. When both fire, only the block text is emitted. The model must then proceed via text because the tool calls are gone.

Re-injection is idempotent. Stripping the tool calls breaks the fingerprint on the next turn. The run then resets. The guard goes quiet. The guard stays quiet until the model re-establishes the run.

### Scope boundary

The guard detects **behavioral** loops via tool-call signatures. **Reasoning-only** loops are out of scope. A no-tool-call turn yields a distinct fingerprint. The distinct fingerprint resets the run naturally. No special case is required.

## Reasoning block cap

Reasoning-capable models surface a `type:"thinking"` content block on assistant messages. The block is the model's intermediate chain of thought.

The provider may or may not bill for these blocks. The provider may or may not pass them through.

The cap is a count-based gate on those blocks. It keeps the LAST N reasoning blocks, counted from the latest. It drops the rest.

The cap runs before the three-tier trim. Dropped reasoning blocks are never seen by the trim.

The cap is a count of blocks. The cap is not a measurement of tokens.

The trim budget accounts for the post-cap mass. Dropping reasoning blocks shrinks the budget the three-tier trim needs to satisfy.

| Cap value | Effect |
|-----------|--------|
| `-1` (default) | Passthrough. Keep every reasoning block. The default is passthrough. The default ensures no behavior change on upgrade. Existing operators see no change. Opt in by setting the env var or JSON key. |
| `0` | Send no reasoning blocks. |
| `1` | Keep only the last reasoning block. Drop all earlier ones. |
| any positive integer | Keep the last N reasoning blocks. |

The cap runs unconditionally. It runs on every context event. There is no per-model branching.

The wiring layer applies the cap to the `base` message stream. The cap runs before pinned injection. The pinned synthetic is never at risk of being dropped.

Reasoning blocks are content blocks of shape `{ type: "thinking"; thinking: string }` on assistant messages.

The default is passthrough. Set the env var or JSON key to `0` to send none. Set the env var or JSON key to a positive integer to keep the last N. The env var is `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP`. The JSON key is `reasoningBlockCap`.

## Pre-budget collapse

Three transcript-entry categories accumulate outside the three-tier budget.

The first category is `intercom_message` custom entries. These are full subagent outputs delivered via the intercom channel.

The second category is `subagent-notify` custom entries. These are status notifications.

The third category is `toolResult` entries from the `subagent` tool. These are full subagent dispatch echoes.

The trimmer collapses them on a separate pass. The pass is extension-gated. The pass runs before the three-tier budget computation. The downstream paths then see the already-collapsed stream.

| Rule | Category | Gate | Behavior |
|------|----------|------|----------|
| 1 | `intercom_message` (`role: "custom"`, `customType: "intercom_message"`) | `intercom` tool registered (pi-intercom) | Recency hardtrim. Keep the last N by stream order. Drop the rest. Integer semantics: `-1` keeps all (passthrough, default). `0` keeps none. A positive N keeps the last N. |
| 2 | `subagent-notify` (`role: "custom"`, `customType: "subagent-notify"`) | `intercom` tool registered (pi-intercom) | Dedup. Keep the first occurrence of each run identity in stream order. Drop subsequent duplicates. There is no operator knob. Duplicates are always noise. Run identity priority: `details.sessionValue`, then `details` fingerprint, then content-header agent name, then stream index. |
| 2b | `subagent-notify` (`role: "custom"`, `customType: "subagent-notify"`) | `intercom` tool registered (pi-intercom) | Recency hardtrim. Keep the last N by stream order. Drop the rest. Integer semantics: `-1` keeps all (passthrough). `0` keeps none. A positive N keeps the last N. When unset, the effective value defaults to the resolved `intercomKeepLast`. The pass runs after `dedupSubagentNotify`: dedup first, then recency trim on the deduped stream. |
| 3 | `toolResult:subagent` (`role: "toolResult"`, `toolName: "subagent"`) | `subagent` tool registered (pi-subagents) | Latest-only. Drop every such entry except the last by stream order. There is no operator knob. |

> **Surface split.** Chain and parallel completions emit on both `subagent-notify` and, when an intercom target is set, `intercom_message`. The `subagent-notify` surface is a display notification governed by `subagentNotifyKeepLast`. The `intercom_message` surface is a grouped result governed by `intercomKeepLast`. The two knobs compose independently. See the `subagentNotifyKeepLast` defaulting paragraph below for the env-var and JSON-key rows.

Each pass is skipped entirely when its gating extension is not present. Skipped means no array allocation and no scan. A session without the gating extension sees no behavior change on any of the rules.

The pre-budget collapse runs before the reasoning-block cap. The pre-budget collapse runs before pinned injection. The pre-budget collapse runs before the three-tier trim. The pinned synthetic is never at risk. It is injected after the pre-budget window, matching the existing `applyReasoningBlockCap` invariant.

## Config

The trim policy's three tier caps live as compile-time constants in `policy.ts`. They are also exposed as operator-configurable knobs through two config channels. The compile-time values are the defaults when neither channel sets a value.

| Constant | Default | Meaning |
|----------|---------|---------|
| `VERBATIM_TIER_MAX_TOKENS` | `50_000` | Trimmable totals at or below this are returned verbatim. |
| `SUMMARIZE_TIER_MAX_TOKENS` | `100_000` | Trimmable totals above this fall into the drop tier. |

The pinned tier exposes one constant in `pinned-tier.ts`.

| Constant | Default | Meaning |
|----------|---------|---------|
| `PINNED_CUSTOM_TYPE` | `"context-trimmer-pinned"` | The customType stamp on the synthetic pinned message. |

The personality file is **opt-in**. It is machine-specific and carries no default.

There are two config channels. The fixed precedence is env, then file, then default.

The first channel is **environment variables** (`PI_CONTEXT_TRIMMER_*`). These are useful for ad-hoc runs, CI, and tests.

The second channel is the **global config file** `~/.pi/agent/context-trimmer.json`. This is the persistent, filesystem-based channel. Use this channel when pi is launched by a non-interactive supervisor.

A supervisor like systemd, launchd, or a container orchestrator does not inherit your shell environment. Put the paths in the JSON file instead of exporting them in a shell rc the supervisor never sources.

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
  "loopGuardThreshold": 3,                                          // falls back to 3
  "loopGuardHardBlock": 10,                                         // falls back to off; positive int enables hard-block
  "reasoningBlockCap": -1,                                          // -1 passthrough (default), 0 send none, N keep last N
  "intercomKeepLast": -1,                                            // -1 passthrough (default), 0 send none, N keep last N
  "subagentNotifyKeepLast": -1,                                     // unset → falls through to intercomKeepLast
  "keepLastUserPrompts": 10,                                        // default 10; 0/negative/absent → no-op
  "keepOriginalPrompt": true                                        // default true; false → original ages out under keepLastUserPrompts
}
```

All fields are optional. The file is read once at extension load. Restart pi to pick up an edit. Unknown keys are ignored. Badly-typed values are treated as absent.

`protectDispatch` accepts `"auto"`, `true`, or `false`. The default is `"auto"`, which is ON when `pi-subagents` is installed. Set `true` or `false` to force.

`loopGuard` accepts `true` or `false`. The default is `true`, ON for every session. The previous `"auto"` sentinel is no longer accepted. A `"auto"` value in the file is treated as absent. The resolver falls through to the default `true`.

The two tier-threshold fields are `tier1MaxTokens` and `tier2MaxTokens`. They follow the same env-over-file-over-default precedence as the other fields. The compile-time constants in `policy.ts` are the final default.

Each threshold value must be a positive finite number. Non-numeric, zero, negative, `NaN`, and `Infinity` are all treated as absent. The resolver falls back to the other channel or the defaults.

`reasoningBlockCap` is an integer in `[-1, ∞)`. The default is `-1`, the passthrough sentinel where every block survives. `0` sends no reasoning blocks. Any positive integer is the count of blocks to keep from the latest. Non-integer, less than `-1`, `NaN`, and `Infinity` are all treated as absent. The resolver falls through to the env or default layer (`-1`).

`intercomKeepLast` is the count-based knob for the Rule 1 pre-budget collapse. It is an integer in `[-1, ∞)`. It follows the same validation rules as `reasoningBlockCap`. The default is `-1`, the passthrough where every `intercom_message` entry survives.

The Rule 1 pass is gated on the `intercom` tool being registered. Without the gating extension, the rule is inert regardless of the knob's value.

`subagentNotifyKeepLast` is the count-based knob for the Rule 2b pre-budget collapse. It is an integer in `[-1, ∞)`. It follows the same validation rules as `intercomKeepLast`. The default is the resolved `intercomKeepLast` value. When `subagentNotifyKeepLast` is unset in both channels, the effective value equals the resolved `intercomKeepLast`.

The Rule 2b pass is gated on the `intercom` tool being registered. This is the same gate as Rules 1 and 2. Without the gating extension, the rule is inert regardless of the knob's value. The pass runs after `dedupSubagentNotify`. It dedups first, then applies recency trim on the deduped stream.

Chain and parallel completions emit on both `subagent-notify` and `intercom_message` surfaces. See the surface-split callout in the pre-budget collapse rule table above.

`keepLastUserPrompts` is a positive integer N. It protects the last N operator-authored `role: "user"` messages from drop and summarize. The messages are counted from the latest. The protection applies regardless of the three-tier budget.

The count is over all user messages. Already-protected ones still count toward N. Double-protection is harmless because the protection check is a boolean.

The knob is protect-list-only. A user prompt outside the window is NOT condemned or force-dropped. It remains a normal trimmable candidate. It only gets dropped when the budget math requires it. `0`, negative, non-integer, `NaN`, and `Infinity` are treated as absent. The default is `10` when neither env nor JSON sets a value.

`keepOriginalPrompt` is a boolean. It governs the eternal dispatch-slot protection on the first user message (`userTurnAge === 0`). When `true` (the default), the dispatch slot stays eternally protected regardless of the keep-last window. The original prompt survives even when it falls outside the last N.

When `false`, the dispatch slot is protected only by `keepLastUserPrompts`. In-window is protected. Outside N is droppable. The original still counts toward the N count in both modes. The flag only governs the eternal-protection layer on top. The default is `true` when neither env nor JSON sets a value.

`preservedPaths` is an optional list of patterns. Matching tool-result messages are protected from drop. Their tokens are subtracted from the trimmable budget.

A bare filename like `AGENTS.md` is a **fuzzy** match. It matches any file of that name regardless of path. A pattern beginning with `/` or `~/` is an **absolute** match. The `~/` form is expanded to your home directory. For example, `~/secrets/keys.md` matches that one file at `$HOME/secrets/keys.md`.

When `preservedPaths` is unset, no paths are preserved. When set, the matching patterns are protected from the trim budget.

### Environment variables (override the file)

| Env var | Effect |
|---------|--------|
| `PI_CONTEXT_TRIMMER_PERSONALITY_PATH` | Absolute path to a personality/voice file pinned verbatim on every LLM call. Unset/empty → falls back to the file, then no personality section. |
| `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH` | `1` forces dispatch protection ON, `0` forces OFF. Unset/other → falls back to the file, then `"auto"`. |
| `PI_CONTEXT_TRIMMER_PRESERVED_PATHS` | Comma-separated list of path patterns whose matching tool-result messages are protected from drop. Bare filenames are fuzzy matches. Patterns beginning with `/` or `~/` are absolute matches. Unset/empty → falls back to the file, then no paths preserved. |
| `PI_CONTEXT_TRIMMER_TIER1_MAX_TOKENS` | Positive finite number; the verbatim-tier cap (tokens). Unset/empty/non-numeric/zero/negative → falls back to the file, then `VERBATIM_TIER_MAX_TOKENS` (`50_000`). |
| `PI_CONTEXT_TRIMMER_TIER2_MAX_TOKENS` | Positive finite number; the summarize-tier cap (tokens). Unset/empty/non-numeric/zero/negative → falls back to the file, then `SUMMARIZE_TIER_MAX_TOKENS` (`100_000`). |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD` | `1` forces the loop guard ON, `0` forces OFF. Unset/other → falls back to the file, then the default `true`. |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD` | Positive integer; the soft-nudge threshold. Unset/empty/non-numeric/zero/negative → falls back to the file, then `3`. |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD_HARD_BLOCK` | Positive integer; the hard-block threshold. Unset → falls back to the file, then off. Values below the soft-nudge threshold are clamped up to it. |
| `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP` | Integer in `[-1, ∞)`. The count of `type:"thinking"` blocks to keep per message stream. See the `reasoningBlockCap` field above for the full validation rules. |
| `PI_CONTEXT_TRIMMER_INTERCOM_KEEP_LAST` | Integer in `[-1, ∞)`. The count of `intercom_message` entries to keep per message stream. See the `intercomKeepLast` field above for the full validation rules. |
| `PI_CONTEXT_TRIMMER_SUBAGENT_NOTIFY_KEEP_LAST` | Integer in `[-1, ∞)`. The count of `subagent-notify` entries to keep per message stream. See the `subagentNotifyKeepLast` field above for the full validation rules. |
| `PI_CONTEXT_TRIMMER_KEEP_LAST_USER_PROMPTS` | Positive integer N: the last N operator-authored `role: "user"` messages are protected from drop and summarize. See the `keepLastUserPrompts` field above for the full validation rules. |
| `PI_CONTEXT_TRIMMER_KEEP_ORIGINAL_PROMPT` | `1` keeps the dispatch slot eternally protected (the default). `0` removes the eternal protection so the original ages out under `keepLastUserPrompts`. See the `keepOriginalPrompt` field above for the full validation rules. |
| `PI_CONTEXT_TRIMMER_CONFIG_PATH` | Override the config-file location (default `~/.pi/agent/context-trimmer.json`). Useful for tests or operators who keep config elsewhere. |

When neither channel resolves a `personalityPath`, the pinned-tier injection is skipped entirely. The wiring calls `buildPinnedMessage()`, gets `null`, and prepends nothing.

The two trim-policy thresholds follow the same env-over-file-over-default precedence as every other field. The compile-time constants in `policy.ts` are the final fallback when neither channel sets a value. The pre-existing behaviour is preserved for operators who configure nothing.

## How the token count is computed

The extension estimates tokens from text length. The default is `Math.ceil(text_length / 3)`. The legacy divisor of `4` is reachable by setting the operator knob.

String content is taken as-is. Array content is concatenated across `{ type: "text", text: string }` blocks. Tool-result blocks are stringified. Non-text content blocks contribute their JSON-stringified length. This undercounts multi-modal content. That bias is the safe direction. The trimmer trims sooner rather than later.

The divisor can also be calibrated. When the first assistant message in the stream carries a `usage.input` value, the trimmer derives a calibrated chars-per-token rate from it. The calibration runs once per context hook. The calibrated rate is the effective divisor for that hook.

When no usable `usage.input` is present, the configured divisor applies. This covers the very first turn on a fresh session. It covers test mocks that do not carry `usage`. It covers assistant turns that were aborted or errored. The configured divisor is the operator knob referenced above, or the default `3`.

The trimmable total is the sum of per-message tokens. The protected-slot tokens are subtracted. The protected slots are the pinned synthetic when injected, and the dispatch task when dispatch protection is enabled. The budget is measured against the trimmable mass, not the raw mass.

## Development

Run the test suite (380 tests, ~1s on a modern laptop):

```bash
npm install   # installs tsx as a dev dependency
npm test
```

The test runner is `tsx --test`. Do not use `node --test` on `.ts` files. Native type-stripping without `"type": "module"` thrashes the CPU.

Tests use deterministic in-process stubs.

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
