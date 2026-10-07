# Ling 3.0 Flash VL versus budget vision models

Completed October 7, 2026: **100/100 Ling screenshot responses, zero API errors or retries, 65 strict passes, 88.1% mean score, and $0.0053822608 summed API cost.** Mean latency is 3572.28 ms, median 3458.5 ms, and p95 4878 ms. A separate one-image preflight passed and cost $0.0000477904; it is excluded from the 100-case metrics. The full campaign is 101 image requests for $0.0054300512. The previous credential expired before inference; a replacement authenticated successfully. No credential is stored.

`report-ling30-budget.mjs --historical-only` reproduces all 600 August 22 responses using the unchanged production prompt and grader. It verifies the byte hashes of the prompt, scorer, 100 questions, and 100 rubrics against revision `d25be94f4981c2fe5ff1d220f8b698ee72e88296`, compares all screenshot hashes against all six historical runs, and exactly reproduces every saved case score. `manifest.json`, `rubrics.json`, and `regression.json` archive that audit.

All seven production-mode runs use identical 1280×720 image fixtures, separate system/user messages, temperature 0, max_tokens 800, streaming usage, and the original thinking-disabling chat-template kwargs. No focus question, reasoning override, tools, or provider pin is added. Ling uses concurrency two and all 100 responses identify Novita. Scoring uses final text only: weighted substring checks plus a proportional six-section structure component, subject to critical-check failures and each case's threshold. Six complete sections are recorded separately and are not an independent hard pass gate in the original grader.

All 100 Ling responses report reasoning tokens despite the request's disabling kwargs: 33,885 reasoning tokens within 51,778 completion tokens. Twenty-two responses end with `length`; 98 have six numbered sections and none are empty. The unchanged literal scorer can penalize recognized synonyms (case 021's "Sign-in"), and numbered drafting prose can resemble sections (case 046). These limits are disclosed in the blog. Historical finish reasons were not captured and are null in the report, not zero truncations.

Costs are summed from all 100 numeric `response.usage.cost` records for each model, not estimated from advertised prices. In particular the saved Qwen3.5-35B-A3B bill is $0.07214; the older article's $0.099 is not reproduced by these raw records. The six saved runs total $0.506781112. Historical cost and latency reflect August serving conditions and must be dated separately from a new Ling run.

`openrouter-endpoints.json` captures the public October 7 endpoint metadata. Ling accepts images. The Novita rates are promotional and may change. Credentials and authorization headers are never saved.

Recorded live commands, after supplying `VISION_PROBE_KEY` in the process environment (use a fresh tag for future inference):

```powershell
node test/vision/run.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.0-flash-vl --only 1 --tag 2026-10-07-openrouter-ling30-budget-preflight
node test/vision/run.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.0-flash-vl --concurrency 2 --tag 2026-10-07-openrouter-ling30-budget
node test/vision/report-ling30-budget.mjs
```

Keep the preflight and any failed full passes as separate archived results. Do not overwrite failures during recovery. The runner now preserves raw SSE and records provider/finish reason for new successful requests, and treats an error embedded in an HTTP 200 stream as an API failure. Historical runner fields remain unchanged. Original `reasoningChars` do not measure OpenRouter's `reasoning` stream field; token usage and new raw SSE retain the relevant evidence.

`comparison.json` and `report.md` now contain all seven rows, pairwise pass differences, bands/categories, cost evidence, and the eighteen shared Qwen failures (Ling passes none of those). The reporter verifies new raw SSE against saved final content, usage, provider, and finish reason, as well as reproducing all 700 case scores. Shared input PNGs are committed under `test/vision/images`; raw responses do not repeat the base64 image bytes or authorization headers.

The new blog is “Ling 3.0 Flash VL compared with budget vision models.” This is a visual screenshot-description benchmark, distinct from the previously published text-only tool-selection tests. Browser checks and screenshots are archived alongside the analysis after rebuilding.
