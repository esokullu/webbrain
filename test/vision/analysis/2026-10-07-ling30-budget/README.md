# Ling 3.0 Flash VL versus budget vision models

Preparation date: October 7, 2026. **The live Ling vision run is pending a replacement API credential.** The previous credential returned HTTP 401, `API key expired`, from the key-validation endpoint before any vision inference. This directory currently contains six historical Qwen rows only; no Ling vision score is claimed.

`report-ling30-budget.mjs --historical-only` reproduces all 600 August 22 responses using the unchanged production prompt and grader. It verifies the byte hashes of the prompt, scorer, 100 questions, and 100 rubrics against revision `d25be94f4981c2fe5ff1d220f8b698ee72e88296`, compares all screenshot hashes against all six historical runs, and exactly reproduces every saved case score. `manifest.json`, `rubrics.json`, and `regression.json` archive that audit.

The six production-mode runs use identical 1280×720 image fixtures, separate system/user messages, temperature 0, max_tokens 800, streaming usage, and the original thinking-disabling chat-template kwargs. No focus question, reasoning override, tools, or provider pin is added. Scoring uses final text only: weighted literal/semantic checks plus a proportional six-section structure component, subject to critical-check failures and each case's threshold. Six complete sections are recorded separately and are not an independent hard pass gate in the original grader.

Costs are summed from all 100 numeric `response.usage.cost` records for each model, not estimated from advertised prices. In particular the saved Qwen3.5-35B-A3B bill is $0.07214; the older article's $0.099 is not reproduced by these raw records. The six saved runs total $0.506781112. Historical cost and latency reflect August serving conditions and must be dated separately from a new Ling run.

`openrouter-endpoints.json` captures the public October 7 endpoint metadata. Ling accepts images. The Novita rates are promotional and may change. Credentials and authorization headers are never saved.

After supplying `VISION_PROBE_KEY` in the process environment:

```powershell
node test/vision/run.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.0-flash-vl --only 1 --tag 2026-10-07-openrouter-ling30-budget-preflight
node test/vision/run.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.0-flash-vl --concurrency 2 --tag 2026-10-07-openrouter-ling30-budget
node test/vision/report-ling30-budget.mjs
```

Keep the preflight and any failed full passes as separate archived results. Do not overwrite failures during recovery. The runner now preserves raw SSE and records provider/finish reason for new successful requests, and treats an error embedded in an HTTP 200 stream as an API failure. Historical runner fields remain unchanged. Original `reasoningChars` do not measure OpenRouter's `reasoning` stream field; token usage and new raw SSE retain the relevant evidence.

The new blog is to be published only after the real screenshot run and comparison are complete. Its intended title is “Ling 3.0 Flash VL compared with budget vision models.” This is a visual screenshot-description benchmark, distinct from the previously published text-only tool-selection tests.
