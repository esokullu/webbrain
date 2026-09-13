# LLM tiny browser-agent benchmark

`test/llm-tiny` is a separate, deterministic **end-to-end local browser**
lane for exactly these browser-agent models:

| Adapter | Allowed model(s) | Observation | Native action format |
|---|---|---|---|
| `compass` | `webbrain-one/webbrain-compass-tiny-v2` | Accessibility text | WebBrain functions, including the model's native XML fallback |
| `browser-use` | `browser-use/bu-30b-a3b-preview` | Indexed DOM and screenshot | Browser Use JSON action object |
| `fara` | `microsoft/Fara1.5-4B`, `microsoft/Fara1.5-9B`, `microsoft/Fara1.5-27B` | Screenshot only | Fara `<tool_call>` / `computer_use` action block |
| `openai` | Any explicitly supplied model | Indexed DOM and screenshot | OpenAI-compatible function tools |

The first three adapters are deliberately allow-listed. `openai` is the one
escape hatch for a benchmark endpoint such as Sonnet or Qwen; it requires an
explicit model name and is not silently substituted for any specialized model.

## What it measures

Thirty local Playwright fixtures exercise click, input, select, toggle, and
multi-control form completion. They have no credentials, network calls, or
external-site drift. A task passes only when the fixture's visible UI confirms
the requested state. Results retain every model turn, parsed action, latency,
and token usage.

This is not an equivalence claim: Compass receives its native accessibility
surface, Browser Use receives indexed DOM plus an image, and Fara is
screenshot-only because that is its published interface. The generated report
repeats this distinction so success rates are not mistaken for real-web or
apples-to-apples capability scores.

Dropdowns use Chromium's in-page `base-select` picker so their open options
are included in screenshots. The validation suite checks coordinate-based
selection; native OS popups would otherwise be invisible to screenshot agents.
Text observations include the visible status message, and adapters execute all
actions in a returned batch in order. Keyboard aliases (such as `SPACE`) and
the macOS Select All shortcut are translated into Playwright key names.

## Run one participant

```sh
node test/llm-tiny/run.mjs \
  --adapter compass \
  --base http://127.0.0.1:8000/v1

node test/llm-tiny/run.mjs \
  --adapter fara \
  --model microsoft/Fara1.5-9B \
  --base http://127.0.0.1:8003/v1

node test/llm-tiny/run.mjs \
  --adapter openai \
  --model anthropic/claude-sonnet-4-6 \
  --base https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY
```

All endpoints use OpenAI-compatible chat completions transport. The Fara
adapter provides Fara's `computer_use` XML contract and converts its 1000×1000
model-display coordinates back to the fixed 1440×900 fixture viewport.
Its identity, critical-point instructions, and tool schema are pinned from
Microsoft's reference implementation in `lib/fara-reference.json` (source and
MIT notice included). Fara and Browser Use retain the latest three screenshots.
Browser Use exposes native dropdown and keyboard actions and uses the model
card's temperature/top-p settings. Every case saves step/final screenshots and
records endpoint errors separately from browser-action failures.

The Compass adapter sends `chat_template_kwargs.enable_thinking=false`, matching
the model's native chat-template guidance. A participant can add provider-
specific non-secret request fields through an `extraBody` object in its config;
its `model`, messages, and adapter-owned tools remain controlled by the runner.

## Compare the full matrix

Copy `participants.example.json`, replace the local endpoint addresses and the
baseline model/endpoint, then run:

```sh
node test/llm-tiny/run.mjs --config /private/llm-tiny-participants.json --tag 2026-09-tiny-matrix
```

The runner writes per-case traces and a `comparison.json` / `comparison.md`
under `test/llm-tiny/results/<tag>/`. To compare previously completed runs:

```sh
node test/llm-tiny/compare.mjs \
  --runs path/to/one/summary.json,path/to/another/summary.json \
  --output comparison.md
```

## Validate the harness without a model endpoint

```sh
node --check test/llm-tiny/run.mjs
node --check test/llm-tiny/lib/adapters.mjs
node test/llm-tiny/run.mjs --help
```

## Recorded RunPod comparison

The temporary helpers under `runpod/` reproduce the September 13 matrix with
immutable model revisions, a pinned vLLM 0.19.1 image, BF16 weights, a 16K
context, and sequential model loading. `manage.mjs` reads `RUNPOD_BENCH_KEY`;
OpenRouter uses its own environment variable. No provider keys are written to
the repository. The random, temporary inference token is stored with mode 0600
inside the ignored results directory and should not be published.

This recorded run has a $30 ceiling, reserving $2 for API usage and cleanup.
Each Pod reserves its complete three-hour lifetime before creation and has
both a local deletion guard and an on-Pod expiration guard. Temporary storage
is deleted with the Pod. `report.mjs` requires all six complete result sets and
local cleanup records, includes earlier API reruns in its spend estimate, and
retrieves available RunPod billing records. Its estimate is not an invoice.
