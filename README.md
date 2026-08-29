# pi-ollama-context-trimmer

Pi extension that trims the message stream sent to the model against a three-tier token budget. It helps subagents keep working when tool-result tails grow too large for the model's context window.

## Why

Subagents can accumulate long tool-result tails. Eventually, those tails exceed the model's context window. This extension trims the copy sent to the model while leaving the session history intact.

It sorts trimmable messages into three bands. Each band has its own rule.

The extension works with any provider or model. It does not require cache reporting.

At the reset boundary, it makes a larger safe cut and saves the retained outbound view as branch-local extension state. Later calls reuse that view and add new messages. The complete session history stays intact.

## What it does

On each LLM call, the extension inspects the message stream and applies one of three rules.

| Tier | Range | Action |
|------|-------|--------|
| Verbatim | 0 to 50k trimmable tokens | Send the full message stream. |
| Hold | over 50k and below 100k | Leave middle-band messages untouched. |
| Reset | 100k or more | Remove duplicate skill-read pairs, then drop the oldest eligible turns toward tier 1. Stop before the configured tier 1 floor is undershot. |

The extension uses its estimate of the current LLM-bound stream as the only reset trigger. Provider status percentages, aggregate totals, cache-hit statistics, and report identity cannot independently remove, rewrite, or reorder existing context. Cache-aware prompt usage can still calibrate the local estimate. Below Tier 2, the extension keeps the existing stream intact and in order.

After a reset, the current stream is the saved retained view plus messages added later. Messages removed by the reset do not return on the next call. The retained view grows through the hold band until it reaches Tier 2 again.

The saved state does not enter model context. On reload, resume, or tree navigation, the extension restores state only from the active branch when the session, source history, and trim settings match. If validation fails, the extension ignores the state and recalculates from the current session without throwing.

Below Tier 2, reusing a retained view writes no new state or drop diagnostic. A reset updates state only when it changes retained messages. The extension writes a drop diagnostic only when it drops at least one turn.

Protected subagent inputs never count toward this budget, and never get dropped.

The agent definition travels as a `customType: "context-trimmer-pinned"` message in the `messages` array. The trim policy protects it through the `protectedCustomTypes` option whenever the pinned synthetic is injected.

Dispatch instructions are the first user message, stamped with `userTurnAge === 0`. The trim policy subtracts their tokens from the cap total. This protection applies only when the `pi-subagents` extension is installed. Without pi-subagents, the first user prompt is ordinary trimmable content. Detection is automatic. The default is on when pi-subagents is present.

When configured, the extension also injects the agent's `personality.md` content as a pinned-tier message on every LLM call. It rebuilds that message on every `context` event instead of saving it in the session file.

The personality injection is optional. The extension ships without a default path. When personality is not configured, the pinned-tier injection is skipped and no empty placeholder is added.

## Prerequisites

- Node.js 20+ for the extension runtime. Tests need 22+ for the test runner.
- The Pi coding agent installed. `pi --version` should print a version.

## Installation

```bash
pi install git:github.com:PurrlyDigital/pi-ollama-context-trimmer
```

That command registers the extension with Pi and adds it to your `settings.json`. You can also install from a local clone:

```bash
pi install /path/to/pi-ollama-context-trimmer
```

The extension is global. After installation, every Pi session, including parent and subagent sessions, loads it at startup. The `context` event handler runs on every LLM call, regardless of session age.

## How the protected inputs are wired

- The agent definition travels as a `context-trimmer-pinned` synthetic. The trim policy's `protectedCustomTypes` option excludes it from the budget.
- The dispatch task is the first user message, stamped with `userTurnAge === 0`. `isProtectedSlot` exempts it from drop, and its tokens are subtracted from the cap total.
- A new subagent session contains the dispatch, the pinned synthetic, and one short trimmable message. With less than 50k tokens, the trim path is skipped.

The synthetic is rebuilt on every `context` event from the file system and is never persisted in the session file. Dispatch protection is on by default when `pi-subagents` is installed. Override it with `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH=0`. In a plain parent session without pi-subagents, the first user prompt is ordinary trimmable content.

## Loop guard

The trim and loop guard solve different problems.

Trim controls context size. It holds or drops over-budget trimmable content.

The loop guard catches repeated behavior. A model can emit the same tool calls even when the context is small.

Trim reacts to token mass. The loop guard reacts to consecutive assistant turns with identical tool calls. At the configured threshold, it injects a soft nudge. At the hard-block threshold, it removes tool calls only after the local stream reaches Tier 2.

The loop guard is on by default for every session. This includes parent and subagent sessions.

The old subagent-only `"auto"` mode no longer exists. Behavioral-loop detection is the same in either session type, so it does not need a separate subagent path.

Operators can disable the guard with `"loopGuard": false` in the config file or `PI_CONTEXT_TRIMMER_LOOP_GUARD=0` in the environment.

The resolver treats the old `"auto"` value as absent and falls through to the default `true`.

### How it detects

The extension fingerprints each assistant turn's `toolCall` content blocks. The fingerprint has the shape `(toolName, deterministically-sorted-keys args)`.

It normalizes object key order because model serialization can change it. Array element order stays intact because it affects call identity.

A turn's fingerprint is the sorted combination of each `toolCall` block's fingerprint. A turn with several tool calls matches the run signature only when every call matches.

A run is the trailing sequence of consecutive assistant turns with the same fingerprint.

A no-tool-call, reasoning-only assistant turn gets a distinct `__no_tool_calls__` fingerprint. That distinct fingerprint resets the run. Reasoning without another tool call is not a behavioral loop, so the guard ignores it.

The extension also checks input-token counts across the last few assistant turns. It treats the counts as flat when every sample is within a small tolerance of the smallest sample.

Flat input tokens suggest that the model is not making progress on new material. This check only changes the nudge wording. When it is present, the model receives one extra sentence about the flat count.

### How it intervenes

When the run reaches the configured threshold, the extension prepends a `role: "user"` synthetic to the LLM-bound view. The synthetic names the repetition and points the model to results already in context. The default threshold is 3.

The notice uses the same channel as the pinned-tier synthetic and the tier-3 prune reminder.

The nudge is a status note, not a command.

When a hard-block threshold is configured, the extension can take a stronger action after a local Tier 2 reset. The default is off. If both the local reset and the hard-block threshold apply, the extension removes the last assistant turn's `toolCall` blocks. It preserves that turn's text and thinking content.

The hard-block path prepends a `role: "user"` block notice. When the stream remains below Tier 2, the guard uses the soft nudge and leaves the tool calls intact.

The extension does not add duplicate notices. Removing the tool calls changes the fingerprint on the next turn, so the run resets. The guard stays quiet until the model establishes the same run again.

### Scope boundary

The guard detects behavioral loops through tool-call signatures. Reasoning-only loops are out of scope. A no-tool-call turn has a distinct fingerprint and resets the run. No special case is required.

## Reasoning block cap

Models with reasoning support may put a `type:"thinking"` content block on assistant messages. The block contains the model's intermediate reasoning. Reasoning blocks have the shape `{ type: "thinking"; thinking: string }`. The provider may or may not bill for these blocks or pass them through.

The cap keeps the last N reasoning blocks, counted from the latest, and drops the rest. It counts blocks, not tokens.

The cap runs only after a local Tier 2 reset. The reset removes duplicate skill-read pairs and drops eligible older turns first. Below Tier 2, the cap leaves every reasoning block intact. The pinned synthetic is never at risk. The cap runs for every model without per-model branching.

| Cap value | Effect |
|-----------|--------|
| `-1` (default) | Passthrough. Keep every reasoning block. The default preserves existing behavior. Set the env var or JSON key to opt in. |
| `0` | Send no reasoning blocks. |
| `1` | Keep only the last reasoning block. Drop all earlier ones. |
| any positive integer | Keep the last N reasoning blocks. |

Set the cap with `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP` or the `reasoningBlockCap` JSON key. Both accept integers in `[-1, ∞)`. The default is `-1`, which passes every block through. Set it to `0` to send none, or to a positive integer N to keep the last N.

## Transcript cleanup

Chain and parallel completions can appear as both `subagent-notify` and, when an intercom target is set, `intercom_message`. `subagent-notify` is a display notification controlled by `subagentNotifyKeepLast`. `intercom_message` is a grouped result controlled by `intercomKeepLast`. The two limits are independent. See the `subagentNotifyKeepLast` row in the config-file table for the env-var and JSON-key reference.

Four kinds of transcript entries can accumulate outside the three-tier budget: repeated skill reads, `intercom_message`, `subagent-notify`, and `toolResult:subagent`. The trimmer records duplicate skill reads while it builds the message stream. At the local Tier 2 ceiling, it removes marked older pairs, then resets eligible context toward Tier 1. The other cleanup passes run after that reset and only when the relevant extension is installed.

| Rule | Category | Gate | Behavior |
|------|----------|------|----------|
| 0 | Completed reads under a `skills` directory | Tier 2 ceiling reached | Keep every pair below the ceiling. At the ceiling or above, keep the newest read when the same skill file was read with the same scope. A whole-file read duplicates only another whole-file read. A bounded read duplicates only the same path, offset, and limit. Overlapping ranges and partial-versus-whole reads remain. Remove the matching older tool call and result together before the reset. |
| 1 | `intercom_message` (`role: "custom"`, `customType: "intercom_message"`) | Local Tier 2 reset and `intercom` tool registered (pi-intercom) | Keep the last N in stream order. `-1` keeps all, `0` keeps none, and a positive N keeps the last N. |
| 2 | `subagent-notify` (`role: "custom"`, `customType: "subagent-notify"`) | Local Tier 2 reset and `intercom` tool registered (pi-intercom) | Keep the first occurrence of each run identity in stream order. Drop later duplicates. There is no operator knob. Run identity priority is `details.sessionValue`, then the `details` fingerprint, then the content-header agent name, then the stream index. |
| 2b | `subagent-notify` (`role: "custom"`, `customType: "subagent-notify"`) | Local Tier 2 reset and `intercom` tool registered (pi-intercom) | After deduplication, keep the last N in stream order. `-1` keeps all, `0` keeps none, and a positive N keeps the last N. When unset, use the resolved `intercomKeepLast` value. |
| 3 | `toolResult:subagent` (`role: "toolResult"`, `toolName: "subagent"`) | Local Tier 2 reset and `subagent` tool registered (pi-subagents) | Keep only the last entry in stream order. There is no operator knob. |

Rules 1 through 3 run after the ordered reset. Rule 0 records candidates before the reset, then removes older pairs at the local Tier 2 ceiling. The pinned synthetic is never at risk.

## Config

Configure the trim policy through environment variables or a JSON file. Environment variables override the file. The file overrides compile-time defaults.

The sections below list the compile-time defaults, file schema, and environment-variable equivalents.

Use the file when Pi runs under a non-interactive supervisor such as systemd, launchd, or a container. Supervisors do not inherit your shell environment.

The personality file is opt-in. It is machine-specific and has no default path.

| Constant | Default | Meaning |
|----------|---------|---------|
| `VERBATIM_TIER_MAX_TOKENS` | `50_000` | Trimmable totals at or below this value are returned verbatim. |
| `SUMMARIZE_TIER_MAX_TOKENS` | `100_000` | Trimmable totals at or above this value start the reset. |

The configured tier 1 token limit is also the drop floor. The trimmer accounts for system-prompt and permanently protected mass before comparing the floor and tier 2 limits. Retained reasoning blocks and user prompts are budget-aware and can be removed oldest-first above tier 2.

The pinned tier defines one constant in `pinned-tier.ts`.

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
  "intercomKeepLast": -1,                                          // -1 passthrough (default), 0 send none, N keep last N
  "subagentNotifyKeepLast": -1,                                     // unset, use intercomKeepLast
  "keepLastUserPrompts": 10,                                        // default 10; 0/negative/absent does nothing
  "keepOriginalPrompt": true                                        // default true; false makes the original eligible above tier 2
}
```

All fields are optional. The file is read once when the extension loads. Restart Pi after editing it. Unknown keys are ignored. Badly typed values are treated as absent.

| Field | Type | Default | Validation | Env var |
|-------|------|---------|------------|---------|
| `personalityPath` | string (absolute path) | none (no personality section) | Unset or empty means no personality section. | `PI_CONTEXT_TRIMMER_PERSONALITY_PATH` |
| `protectDispatch` | `"auto"` \| `true` \| `false` | `"auto"` (on when `pi-subagents` is installed) | `"auto"` is on when `pi-subagents` is installed. Set `true` or `false` to force it. | `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH` |
| `preservedPaths` | string[] | none (no paths preserved) | A bare filename is a fuzzy match for any file with that name. A `/` or `~/` prefix is an absolute match. `~/` expands to the home directory. Matching tool results are protected from drop, and their tokens are subtracted from the trimmable budget. | `PI_CONTEXT_TRIMMER_PRESERVED_PATHS` |
| `tier1MaxTokens` | positive finite number | `VERBATIM_TIER_MAX_TOKENS` (`50_000`) | Non-numeric, zero, negative, `NaN`, or `Infinity` means absent. The resolver falls back to the other channel or compile-time default. | `PI_CONTEXT_TRIMMER_TIER1_MAX_TOKENS` |
| `tier2MaxTokens` | positive finite number | `SUMMARIZE_TIER_MAX_TOKENS` (`100_000`) | Same validation as `tier1MaxTokens`. | `PI_CONTEXT_TRIMMER_TIER2_MAX_TOKENS` |
| `loopGuard` | `true` \| `false` | `true` (on for every session) | The old `"auto"` value is absent. The resolver falls back to `true`. | `PI_CONTEXT_TRIMMER_LOOP_GUARD` |
| `loopGuardThreshold` | positive integer | `3` | Non-numeric, zero, or negative means absent. The resolver falls back to `3`. | `PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD` |
| `loopGuardHardBlock` | positive integer | off | Values below the soft-nudge threshold are raised to that threshold. The hard block can strip calls only after a local Tier 2 reset. | `PI_CONTEXT_TRIMMER_LOOP_GUARD_HARD_BLOCK` |
| `reasoningBlockCap` | integer in `[-1, ∞)` | `-1` (passthrough) | At a local Tier 2 reset, `0` sends none and a positive integer N keeps the last N. Non-integer, less than `-1`, `NaN`, or `Infinity` means absent. | `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP` |
| `intercomKeepLast` | integer in `[-1, ∞)` | `-1` (passthrough) | The setting applies only after a local Tier 2 reset and is gated on the `intercom` tool. Without it, the rule is inert. | `PI_CONTEXT_TRIMMER_INTERCOM_KEEP_LAST` |
| `subagentNotifyKeepLast` | integer in `[-1, ∞)` | resolved `intercomKeepLast` | After a local Tier 2 reset, an unset value uses the resolved `intercomKeepLast`. It uses the same gate. Deduplication runs first, then recency trimming. | `PI_CONTEXT_TRIMMER_SUBAGENT_NOTIFY_KEEP_LAST` |
| `keepLastUserPrompts` | positive integer N | `10` | Retains the last N operator-authored `role: "user"` messages while the effective total is within tier 2. Above tier 2, retained prompts remain eligible for oldest-first trimming. `0`, negative, non-integer, `NaN`, or `Infinity` means absent. | `PI_CONTEXT_TRIMMER_KEEP_LAST_USER_PROMPTS` |
| `keepOriginalPrompt` | boolean | `true` | `true` permanently protects the dispatch slot. `false` makes it eligible for oldest-first trimming above tier 2. The original counts toward N in both modes. | `PI_CONTEXT_TRIMMER_KEEP_ORIGINAL_PROMPT` |

### Environment variables (override the file)

| Env var | Effect |
|---------|--------|
| `PI_CONTEXT_TRIMMER_PERSONALITY_PATH` | Absolute path to a personality or voice file pinned verbatim on every LLM call. Unset or empty falls back to the file, then no personality section. |
| `PI_CONTEXT_TRIMMER_PROTECT_DISPATCH` | `1` forces dispatch protection on. `0` forces it off. Unset or another value falls back to the file, then `"auto"`. |
| `PI_CONTEXT_TRIMMER_PRESERVED_PATHS` | Comma-separated path patterns whose matching tool-result messages are protected from drop. Bare filenames are fuzzy matches. Patterns beginning with `/` or `~/` are absolute matches. Unset or empty falls back to the file, then no preserved paths. |
| `PI_CONTEXT_TRIMMER_TIER1_MAX_TOKENS` | Positive finite number for the verbatim-tier cap. Unset, empty, non-numeric, zero, or negative falls back to the file, then `VERBATIM_TIER_MAX_TOKENS` (`50_000`). |
| `PI_CONTEXT_TRIMMER_TIER2_MAX_TOKENS` | Positive finite number for the tier 2 cap. Unset, empty, non-numeric, zero, or negative falls back to the file, then `SUMMARIZE_TIER_MAX_TOKENS` (`100_000`). |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD` | `1` forces the loop guard on. `0` forces it off. Unset or another value falls back to the file, then the default `true`. |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD` | Positive integer for the soft-nudge threshold. Unset, empty, non-numeric, zero, or negative falls back to the file, then `3`. |
| `PI_CONTEXT_TRIMMER_LOOP_GUARD_HARD_BLOCK` | Positive integer for the hard-block threshold. Unset falls back to the file, then off. The guard strips calls only after a local Tier 2 reset. |
| `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP` | Integer in `[-1, ∞)`. At a local Tier 2 reset, this sets the number of `type:"thinking"` blocks to keep. See the `reasoningBlockCap` field above for validation rules. |
| `PI_CONTEXT_TRIMMER_INTERCOM_KEEP_LAST` | Integer in `[-1, ∞)`. At a local Tier 2 reset, this sets the number of `intercom_message` entries to keep. See the `intercomKeepLast` field above for validation rules. |
| `PI_CONTEXT_TRIMMER_SUBAGENT_NOTIFY_KEEP_LAST` | Integer in `[-1, ∞)`. At a local Tier 2 reset, this sets the number of `subagent-notify` entries to keep. See the `subagentNotifyKeepLast` field above for validation rules. |
| `PI_CONTEXT_TRIMMER_KEEP_LAST_USER_PROMPTS` | Positive integer N. The last N operator-authored `role: "user"` messages stay retained within tier 2 and remain eligible for oldest-first trimming above tier 2. See the `keepLastUserPrompts` field above for validation rules. |
| `PI_CONTEXT_TRIMMER_KEEP_ORIGINAL_PROMPT` | `1` keeps the dispatch slot permanently protected, which is the default. `0` makes it eligible for oldest-first trimming above tier 2. See the `keepOriginalPrompt` field above for validation rules. |
| `PI_CONTEXT_TRIMMER_CONFIG_PATH` | Overrides the config-file location. The default is `~/.pi/agent/context-trimmer.json`. This is useful for tests or operators who keep config elsewhere. |

When neither channel resolves a `personalityPath`, the pinned-tier injection is skipped. The wiring calls `buildPinnedMessage()`, gets `null`, and prepends nothing.

## How the token count is computed

The trimmer estimates tokens with `Math.ceil(text.length / divisor)`. The default divisor is `3`. The legacy divisor of `4` is available through the `tokenEstimatorDivisor` setting, using `PI_CONTEXT_TRIMMER_TOKEN_ESTIMATOR_DIVISOR` or the `tokenEstimatorDivisor` JSON key.

String content is counted as-is. For array content, an object with a string `text` field contributes that text. Other object blocks contribute their `JSON.stringify()` output, and primitive blocks contribute their string value. The trimmer joins those pieces before counting them. This undercounts multimodal content, so it can trim earlier rather than later.

The wiring layer can calibrate the divisor from provider usage. It keeps the prior extension-produced prompt's estimator character count in memory for one request. On the next context event, calibration requires the same session, an unchanged raw source prefix, and exactly one following usable assistant response. The extension divides the saved prompt characters by that response's `input + cacheRead + cacheWrite` total.

This pairing prevents a trimmed request's usage from being applied to the complete session's character count. The pairing is cleared on reload, tree navigation, compaction, and model changes. It is not persisted.

If the extension cannot prove the pairing, the configured divisor applies. This includes a new session's first turn, reload, missing stable message identity, multiple following assistant messages, and assistant messages that are aborted, errored, or have invalid usage. The configured divisor is the operator setting above, or `3` when neither configuration channel sets one.

`usage.totalTokens` does not trigger a reset. Pi exposes its status-line percentage through `ctx.getContextUsage().percent`. Providers can report stale totals, cache-inclusive totals, or a percentage that does not describe the current stream. The extension does not use that percentage as a reset trigger. The local visible-content estimate, after protected mass and system-prompt accounting, is the sole reset predicate.

For the visible estimate, the trimmer subtracts system-prompt tokens and permanently protected message mass from both tier caps. Protected mass includes the dispatch slot when dispatch and original-prompt protection are enabled, pinned or other protected custom messages, preserved-path messages, and tool results paired with protected tool calls. Tier 1 returns the stream unchanged. The middle band holds it unchanged. At the Tier 2 ceiling, the trimmer removes duplicate skill-read pairs, then drops the oldest whole turns toward the effective Tier 1 target. The reset stops before the effective tier 1 floor would be undershot, so a stream can remain above the target when the next whole-turn drop would cross that floor or when no eligible whole turn remains.

Protected messages survive even when they sit inside a dropped turn. A protected tool-call block can remain inside its assistant message with its matching result. When an unprotected tool-call block is dropped, its matching result is dropped too. Opaque reasoning can make exact per-turn sizes unavailable, so the trimmer cuts whole turns instead of claiming exact accounting.

The loop guard has its own informational token signal. It samples up to the last five assistant messages after trimming, estimates them with the default divisor of `3`, and marks the sample flat when the largest and smallest values differ by no more than 5 percent. A sample of all zeroes is flat too. The trim event's calibrated or configured divisor does not change that separate signal.

## Development

Run the test suite. It currently contains 390 tests and takes a few seconds on a modern laptop.

```bash
npm install   # installs tsx as a dev dependency
npm test
```

The test runner is `tsx --test`. Do not use `node --test` on `.ts` files. Native type-stripping without `"type": "module"` is slow.

Tests use deterministic in-process stubs.

For the guarded final-review closure procedure and its disposable check, see [Close an approved pull request](docs/guarded-pr-closure.md).

Project structure:

```
index.ts              # Extension wiring: registers session_start / turn_end / context handlers
config.ts             # Pure config resolver (parse file + merge env over file)
policy.ts             # Three-tier trim policy (the trim algorithm)
pinned-tier.ts        # Pinned content reader (personality)
retained-view-state.ts # Pure retained-view state validation and reconstruction
test/policy.test.ts   # Unit tests for the trim policy
test/config.test.ts   # Unit tests for config resolution (precedence + parsing)
test/retained-view-state.test.ts # Retained-state validation and reconstruction tests
test/integration.test.ts # End-to-end tests for the context handler wiring
tsconfig.json         # TypeScript config for the extension
tsconfig.policy.json  # Narrower TypeScript config for the policy module
package.json          # Pi extension manifest (name, pi-package keyword, pi.extensions, peerDependencies)
```

## License

MIT
