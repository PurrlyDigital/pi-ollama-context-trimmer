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
| Drop | 100k+ | The oldest eligible turns are hard-dropped until the effective total is under tier 2. A drop stops before the configured tier 1 floor would be undershot. |

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

- **The agent def** travels as a `context-trimmer-pinned` synthetic; the trim policy's `protectedCustomTypes` option excludes it from the budget.
- **The dispatch task** is the first user message, stamped with `userTurnAge === 0`; `isProtectedSlot` exempts it from drop, and its tokens are subtracted from the cap total.
- **A freshly-dispatched subagent's session** holds the dispatch, the pinned synthetic, and a single short trimmable message — under 50k, the trim path is skipped.

The synthetic is rebuilt on every `context` event from the file system and is never persisted in the session file. The dispatch protection is ON by default when `pi-subagents` is installed. Override with `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH=0`. In a plain parent session without `pi-subagents`, the first user prompt is ordinary trimmable content.

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

Reasoning-capable models surface a `type:"thinking"` content block on assistant messages. The block is the model's intermediate chain of thought. Reasoning blocks have the shape `{ type: "thinking"; thinking: string }`. The provider may or may not bill for these blocks or pass them through.

The cap is a count-based gate on those blocks. It keeps the last N reasoning blocks, counted from the latest, and drops the rest. The cap is a count of blocks, not a measurement of tokens.

The cap runs before the three-tier trim, before pinned injection, on every context event. Dropped reasoning blocks are never seen by the trim. Surviving reasoning blocks remain eligible content: they are retained within tier 2 and can be removed oldest-first above tier 2. The pinned synthetic is never at risk. The cap runs unconditionally with no per-model branching.

| Cap value | Effect |
|-----------|--------|
| `-1` (default) | Passthrough. Keep every reasoning block. The default is passthrough. The default ensures no behavior change on upgrade. Existing operators see no change. Opt in by setting the env var or JSON key. |
| `0` | Send no reasoning blocks. |
| `1` | Keep only the last reasoning block. Drop all earlier ones. |
| any positive integer | Keep the last N reasoning blocks. |

The cap value is in `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP` (env) or `reasoningBlockCap` (JSON). Both are integers in `[-1, ∞)`. The default is `-1` (passthrough). Set to `0` to send none, or to a positive integer N to keep the last N.

## Pre-budget collapse

> **Surface split.** Chain and parallel completions emit on both `subagent-notify` and, when an intercom target is set, `intercom_message`. The `subagent-notify` surface is a display notification governed by `subagentNotifyKeepLast`. The `intercom_message` surface is a grouped result governed by `intercomKeepLast`. The two knobs compose independently. See the `subagentNotifyKeepLast` row in the config-file table below for the env-var and JSON-key reference.

Four transcript-entry categories accumulate outside the three-tier budget: repeated skill reads, `intercom_message`, `subagent-notify`, and `toolResult:subagent`. The trimmer collapses each on a separate pre-budget pass. Skill-read deduplication is always active; the other passes are gated on the relevant extension being installed.

| Rule | Category | Gate | Behavior |
|------|----------|------|----------|
| 0 | Completed reads under a `skills` directory | Always active | Keep the newest read when the same skill file was read with the same scope. A whole-file read duplicates only another whole-file read. A bounded read duplicates only the same path, offset, and limit. Overlapping ranges and partial-versus-whole reads remain. The matching older tool call and result are removed together. |
| 1 | `intercom_message` (`role: "custom"`, `customType: "intercom_message"`) | `intercom` tool registered (pi-intercom) | Recency hardtrim. Keep the last N by stream order. Drop the rest. Integer semantics: `-1` keeps all (passthrough, default). `0` keeps none. A positive N keeps the last N. |
| 2 | `subagent-notify` (`role: "custom"`, `customType: "subagent-notify"`) | `intercom` tool registered (pi-intercom) | Dedup. Keep the first occurrence of each run identity in stream order. Drop subsequent duplicates. There is no operator knob. Duplicates are always noise. Run identity priority: `details.sessionValue`, then `details` fingerprint, then content-header agent name, then stream index. |
| 2b | `subagent-notify` (`role: "custom"`, `customType: "subagent-notify"`) | `intercom` tool registered (pi-intercom) | Recency hardtrim. Keep the last N by stream order. Drop the rest. Integer semantics: `-1` keeps all (passthrough). `0` keeps none. A positive N keeps the last N. When unset, the effective value defaults to the resolved `intercomKeepLast`. The pass runs after `dedupSubagentNotify`: dedup first, then recency trim on the deduped stream. |
| 3 | `toolResult:subagent` (`role: "toolResult"`, `toolName: "subagent"`) | `subagent` tool registered (pi-subagents) | Latest-only. Drop every such entry except the last by stream order. There is no operator knob. |

The pre-budget collapse runs before the reasoning-block cap, before pinned injection, and before the three-tier trim. The pinned synthetic is never at risk; it is injected after the pre-budget window.

## Config

The trim policy exposes operator-configurable knobs through two channels. Env vars override the file. The file overrides compile-time defaults.

Below: the compile-time defaults, the file schema, and the env-var equivalents.

Use the file when pi runs under a non-interactive supervisor (systemd, launchd, container). The supervisor does not inherit your shell environment.

The personality file is **opt-in**. It is machine-specific and carries no default.

| Constant | Default | Meaning |
|----------|---------|---------|
| `VERBATIM_TIER_MAX_TOKENS` | `50_000` | Trimmable totals at or below this are returned verbatim. |
| `SUMMARIZE_TIER_MAX_TOKENS` | `100_000` | Trimmable totals above this fall into the drop tier. |

The configured tier 1 token limit is also the drop floor. System-prompt and permanently protected mass are accounted for before the floor and tier 2 comparisons. Retained reasoning blocks and user prompts are budget-aware and can be removed oldest-first above tier 2.

The pinned tier exposes one constant in `pinned-tier.ts`.

| Constant | Default | Meaning |
|----------|---------|---------|
| `PINNED_CUSTOM_TYPE` | `"context-trimmer-pinned"` | The customType stamp on the synthetic pinned message. |

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
  "keepOriginalPrompt": true                                        // default true; false → original is eligible above tier 2
}
```

All fields are optional. The file is read once at extension load. Restart pi to pick up an edit. Unknown keys are ignored. Badly-typed values are treated as absent.

| Field | Type | Default | Validation | Env var |
|-------|------|---------|------------|---------|
| `personalityPath` | string (absolute path) | none (no personality section) | Unset/empty → no personality section. | `PI_CONTEXT_TRIMMER_PERSONALITY_PATH` |
| `protectDispatch` | `"auto"` \| `true` \| `false` | `"auto"` (ON when `pi-subagents` installed) | `"auto"` is ON when `pi-subagents` is installed. Set `true` or `false` to force. | `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH` |
| `preservedPaths` | string[] | none (no paths preserved) | Bare filename = **fuzzy** match (any file of that name). `/` or `~/` prefix = **absolute** match. `~/` expanded to home dir. Matching tool-results are protected from drop; their tokens are subtracted from the trimmable budget. | `PI_CONTEXT_TRIMMER_PRESERVED_PATHS` |
| `tier1MaxTokens` | positive finite number | `VERBATIM_TIER_MAX_TOKENS` (`50_000`) | Non-numeric/zero/negative/`NaN`/`Infinity` → absent. Falls back to the other channel or the compile-time default. | `PI_CONTEXT_TRIMMER_TIER1_MAX_TOKENS` |
| `tier2MaxTokens` | positive finite number | `SUMMARIZE_TIER_MAX_TOKENS` (`100_000`) | Same validation as `tier1MaxTokens`. | `PI_CONTEXT_TRIMMER_TIER2_MAX_TOKENS` |
| `loopGuard` | `true` \| `false` | `true` (ON for every session) | The previous `"auto"` sentinel is no longer accepted. A `"auto"` value is treated as absent. The resolver falls through to the default `true`. | `PI_CONTEXT_TRIMMER_LOOP_GUARD` |
| `loopGuardThreshold` | positive integer | `3` | Non-numeric/zero/negative → absent. Falls back to the default `3`. | `PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD` |
| `loopGuardHardBlock` | positive integer | off | Values below the soft-nudge threshold are clamped up to it. | `PI_CONTEXT_TRIMMER_LOOP_GUARD_HARD_BLOCK` |
| `reasoningBlockCap` | integer in `[-1, ∞)` | `-1` (passthrough) | `0` sends none. A positive integer N keeps the last N. Non-integer/less than `-1`/`NaN`/`Infinity` → absent. | `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP` |
| `intercomKeepLast` | integer in `[-1, ∞)` | `-1` (passthrough) | Same validation as `reasoningBlockCap`. Gated on the `intercom` tool being registered; without it, the rule is inert. | `PI_CONTEXT_TRIMMER_INTERCOM_KEEP_LAST` |
| `subagentNotifyKeepLast` | integer in `[-1, ∞)` | resolved `intercomKeepLast` | When unset in both channels, the effective value equals the resolved `intercomKeepLast`. Same gate as `intercomKeepLast`. The pass runs after `dedupSubagentNotify`: dedup first, then recency trim. | `PI_CONTEXT_TRIMMER_SUBAGENT_NOTIFY_KEEP_LAST` |
| `keepLastUserPrompts` | positive integer N | `10` | Retains the last N operator-authored `role: "user"` messages while the effective total is within tier 2. Above tier 2, retained prompts remain eligible for oldest-first trimming. `0`/negative/non-integer/`NaN`/`Infinity` → absent. | `PI_CONTEXT_TRIMMER_KEEP_LAST_USER_PROMPTS` |
| `keepOriginalPrompt` | boolean | `true` | `true` = permanent dispatch-slot protection. `false` = the dispatch slot is eligible for oldest-first trimming above tier 2. The original counts toward N in both modes. | `PI_CONTEXT_TRIMMER_KEEP_ORIGINAL_PROMPT` |

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
| `PI_CONTEXT_TRIMMER_KEEP_LAST_USER_PROMPTS` | Positive integer N: the last N operator-authored `role: "user"` messages are retained within tier 2 and remain eligible for oldest-first trimming above tier 2. See the `keepLastUserPrompts` field above for the full validation rules. |
| `PI_CONTEXT_TRIMMER_KEEP_ORIGINAL_PROMPT` | `1` keeps the dispatch slot permanently protected (the default). `0` makes it eligible for oldest-first trimming above tier 2. See the `keepOriginalPrompt` field above for the full validation rules. |
| `PI_CONTEXT_TRIMMER_CONFIG_PATH` | Override the config-file location (default `~/.pi/agent/context-trimmer.json`). Useful for tests or operators who keep config elsewhere. |

When neither channel resolves a `personalityPath`, the pinned-tier injection is skipped entirely. The wiring calls `buildPinnedMessage()`, gets `null`, and prepends nothing.

The pre-existing behaviour is preserved for operators who configure nothing.

## How the token count is computed

The extension estimates tokens from text length. The default is `Math.ceil(text_length / 3)`. The legacy divisor of `4` is reachable by setting the operator knob.

String content is taken as-is. Array content is concatenated across `{ type: "text", text: string }` blocks. Tool-result blocks are stringified. Non-text content blocks contribute their JSON-stringified length. This undercounts multi-modal content. That bias is the safe direction. The trimmer trims sooner rather than later.

The divisor can also be calibrated. When the first assistant message in the stream carries a `usage.input` value, the trimmer derives a calibrated chars-per-token rate from it. The calibration runs once per context hook. The calibrated rate is the effective divisor for that hook.

When no usable `usage.input` is present, the configured divisor applies. This covers the very first turn on a fresh session. It covers test mocks that do not carry `usage`. It covers assistant turns that were aborted or errored. The configured divisor is the operator knob referenced above, or the default `3`.

When an eligible assistant message reports a positive finite `usage.totalTokens`, that provider total can force a trim when it shows an overage. It includes the system prompt and protected content, so it is compared with the raw tier caps. A smaller preceding provider total cannot suppress the current event's visible-content estimate. Aborted and errored assistant messages are skipped.

The visible-content estimate remains the candidate-sizing signal for whole-turn drops. It is also the fallback when no usable provider total is present. Encrypted reasoning can make candidate sizes fuzzy, so the extension attempts an atomic oldest-turn cut rather than claiming exact per-turn accounting.

Protected-slot tokens continue to be estimated for candidate budgeting and protected content remains preserved. Tool-call and tool-result pairs remain atomic.

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
