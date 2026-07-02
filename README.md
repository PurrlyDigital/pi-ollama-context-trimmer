# pi-ollama-context-trimmer

Pi extension that trims the LLM-bound message stream against a three-tier token budget. Required for subagents to survive long tool-result tails without blowing the model context window.

This extension is currently targeting Ollama Cloud style per-request billing and does not currently discriminate between providers or models. **Use with token-based billing subscriptions is not recommended.** Anthropic and OpenAI (token-based billing) utilize caching based on the full text. This extension will break that caching model. Ollama bills based on request and how much GPU time a request took. This extension works against that.

## What it does

Every time the LLM is about to be called, the extension inspects the message stream and applies a three-tier trim:

| Tier | Range | Action |
|------|-------|--------|
| Verbatim | 0–50k trimmable tokens | No action; the full message stream is sent. |
| Summarize | 50k–100k | The oldest non-protected trimmable messages are rewritten in place with a Python `summa` summary, tagged `[summa: ~N tokens originally → ~M tokens summary]`, until the total is back under 50k. |
| Drop | 100k+ | The oldest whole trimmable turns (assistant + toolResult + custom between two user messages) are hard-dropped until the total is back under 100k. If a single oversized trimmable turn remains, it is summarized as a fallback. |

Subagent protected inputs are **never** counted in the budget, **never** summarized, **never** dropped:

1. **The agent def / pinned-tier synthetic** — travels as a `customType: "context-trimmer-pinned"` message in the `messages` array. The trim policy protects it via the `protectedCustomTypes` option.
2. **The dispatch instructions** — the first user message (identified by `userTurnAge === 0`). The trim policy subtracts its tokens from the cap total so a session whose only over-budget contributor is the dispatch does not trigger a trim.

The extension also injects a **pinned-tier message** on every LLM call: the agent's `personality.md` content plus a live digest of the last 5 tracker tickets across all projects. The injection is reconstructed on every `context` event from the file system + the global tracker; it is not persisted in the session file.

## Prerequisites

- **Node.js 20+** (for the extension runtime; tests need 22+ for the test runner)
- **Pi coding agent** installed (`pi --version` should print a version)
- **Python 3 + summa** for the summarize tier. `summa` is a Python package; it is **not** an npm dependency and is not bundled.

  ```bash
  pip install summa
  ```

  The extension shells out to `/usr/bin/python3` and imports `from summa.summarizer import summarize`. If summa is missing, the summarize path falls back to the source text (the trim path stays total-bounded and never throws).

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
- The dispatch task is the **first user message** in the stream. The wiring layer stamps `userTurnAge === 0` on it; the trim policy's `isProtectedSlot` predicate reads that stamp and exempts the message from summary and drop. The dispatch's tokens are also subtracted from the cap total.
- A session that contains ONLY the dispatch + the pinned synthetic + a single short trimmable message (e.g. a freshly dispatched subagent) never enters the trim path: the trimmable mass is under 50k, so the messages are returned verbatim.

## Config

The extension's trim policy exposes three constants in `policy.ts`:

| Constant | Default | Meaning |
|----------|---------|---------|
| `VERBATIM_TIER_MAX_TOKENS` | `50_000` | Trimmable totals at or below this are returned verbatim. |
| `SUMMARIZE_TIER_MAX_TOKENS` | `100_000` | Trimmable totals above this fall into the drop tier. |
| `SUMMA_WORDS` | `60` | Word budget for each summa in-place summary. |

The pinned tier exposes four constants in `pinned-tier.ts`:

| Constant | Default | Meaning |
|----------|---------|---------|
| `DEFAULT_PINNED_TRACKER_COUNT` | `5` | Number of most-recently-updated tracker tickets injected. |
| `TRACKER_PATH` | `/home/dez/purrly-platform-workspace/.tracker/tracker.py` | The global tracker CLI. |
| `PERSONALITY_MD_PATH` | `~/.pi/agent/personality.md` | The agent's pinned voice/identity file. |
| `PINNED_CUSTOM_TYPE` | `"context-trimmer-pinned"` | The customType stamp on the synthetic pinned message. |

**These are compile-time constants, not environment variables.** To change a threshold, edit the constant in the source file and reinstall. There is no `PI_*` environment-variable knob surface.

The summarize callback can be overridden per-call by passing a `summarizer` option to `applyThreeTierTrim` (this is the test seam — production wires `defaultSummaSummarizer`, which is a Python `summa` subprocess). The `defaultSummaSummarizer` exports a diagnostic flag `lastSummarizerFailed` (let-binding) that flips to `true` if the subprocess errors; consumers can read it after a trim call to surface a warning to the user.

## How the token count is computed

The extension uses a simple approximation: per message, `Math.ceil(text_length / 4)` where `text_length` is the extracted text content (string content is taken as-is; array content is concatenated across `{ type: "text", text: string }` blocks; tool-result blocks are stringified). Non-text content blocks contribute their JSON-stringified length, which undercounts multi-modal content — that bias is the safe direction (we trim sooner rather than later).

The trimmable total is the sum of per-message tokens **minus** the protected-slot tokens (dispatch + any pinned custom). The budget is measured against the trimmable mass, not the raw mass.

## Development

Run the test suite (45 tests, ~1.5s on a modern laptop):

```bash
npm install   # installs tsx as a dev dependency
npm test
```

The test runner is `tsx --test` (NOT `node --test` on `.ts` — native type-stripping without `"type": "module"` thrashes the CPU). Tests use a deterministic in-process `summarizer` stub; the integration test in `integration.test.ts` exercises the production default summa subprocess on a small corpus.

Project structure:

```
index.ts              # Extension wiring: registers session_start / turn_end / context handlers
policy.ts             # Three-tier trim policy (the trim algorithm)
pinned-tier.ts        # Pinned content reader (personality + last-N tracker tickets)
policy.test.ts        # Unit tests for the trim policy
integration.test.ts   # End-to-end tests for the context handler wiring
tsconfig.json         # TypeScript config for the extension
tsconfig.policy.json  # Narrower TypeScript config for the policy module
package.json          # Pi extension manifest (name, pi-package keyword, pi.extensions, peerDependencies)
```

## License

MIT
