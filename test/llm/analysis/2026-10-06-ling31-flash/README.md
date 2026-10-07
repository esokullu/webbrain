# Ling 3.1 Flash: pinned full-tier benchmark

The requested comparator is the August 2 full-tier cohort from
`web/blog/posts/american-chinese-open-model-frontier-gap-benchmark.md`.
Its pinned checkout is `7182c21f58a94689c2ac3b547a279b9c5e699283`.
This is a different protocol from the May frozen Nex/Ling 3.0 tests.

The replacement credential authenticated successfully on October 6. The first
100-case pass returned 15 inference responses and 85 upstream HTTP 429 errors.
Two recovery rounds using 30-second backoffs completed all 100 cases: the first
recovered 76 cases, and the second recovered the last nine. The final outcome is
recorded in `comparison.json`: 93 native calls, 92 schema-valid calls, 42 ideal
tool names, 15 exact ideals, 32.8% exact consensus, 80.7% tool-family consensus,
3,185ms median successful-request latency, 10,182ms p95, and $0 reported cost.
There were 390 benchmark requests plus eight diagnostic requests, including
298 HTTP 429 responses. Timed benchmark passes total 2,472,278ms (41.2 minutes).
Failed requests are availability evidence, not zero
quality scores. The earlier expired-key check sent no benchmark requests.

## Inputs and historical verification

`test/llm/prepare-frontier-replay.mjs` reconstructs every request from the
archived payload builder, Chrome/Firefox tool and adapter sources, and the
100 archived questions. It refuses question-label drift in the live runner.
The generated `test/llm/freeze/full-replay-7182c21f.json` retains all messages,
tool definitions, temperatures, output limits, expected actions, and source
SHA-256 hashes. Its shared loader schema has a historical `compact` name;
its actual tier is `full`.

The pinned source sends **48 Act tools**, and all 100 questions are Act mode.
The old article's claim of 41 tools is a documentation discrepancy. Do not
trim the reconstructed source to match that number. Historical request bodies
were not saved, so complete byte equality with those requests cannot be
proven. Their case labels and run configuration match the reconstruction.

`rubrics.json` preserves the pinned questions and ideal actions. The report
script has reproduced all 13 original exact-action/tool-name consensus
percentages and emitted/schema-valid/ideal-name/exact-ideal counts from the
1,300 historical files. Results are in `historical-regression.json`.

`openrouter-endpoints.json` is public route metadata retrieved October 6.
It reports a text-only route, Novita serving, native tools, 262,144 context,
and zero prompt/completion list rates at retrieval time. It is not an
inference response and establishes no measured benchmark quality or cost.

## Run and regenerate

Set `OPENROUTER_API_KEY` in the process environment; never save or commit it.
Use native structured tools, no reasoning override, concurrency 3, output
limit 4,096, temperature 0.15, and a 180-second request timeout.

```powershell
node test/llm/prepare-frontier-replay.mjs
node test/llm/report-ling31-comparison.mjs --historical-only
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.1-flash --tier full --replay test/llm/freeze/full-replay-7182c21f.json --tag 2026-10-06-openrouter-ling31-flash-full-7182 --concurrency 3 --timeout 180000 --delay-ms 10000
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.1-flash --tier full --replay test/llm/freeze/full-replay-7182c21f.json --tag 2026-10-06-openrouter-ling31-flash-full-7182 --concurrency 3 --timeout 180000 --resume --retry-statuses 429 --retry-max 10 --retry-delay-ms 30000
node test/llm/report-ling31-comparison.mjs
node scripts/build-blog.mjs
```

For a complete run, the report retains the original 13 peers and adds Ling, then scores every
model against its other 13 peers: 1,300 pairwise comparisons per model.
This updates the peer pool; historical article scores must not be silently
copied into the new consensus table. Sorting object keys is the only action
normalization. Argument values, defaults, and extra arguments are preserved.
No-tool/no-tool is agreement; API failures never agree. Consensus measures
agreement, not ground truth. Ideal matching and schema validation are separate.
If fewer than 100 Ling cases return inference, Ling remains unranked and the
13-model historical pool is preserved, with N/A for new full-suite quality
metrics. A throttled request does not count as a no-tool model response.

`first-pass/` archives all 100 initial raw requests and results plus summary.
`recovery-pass1/` archives the 85 selected recovery-case results and the
combined summary before the final nine-case recovery; its unchanged successful
cases remain in `first-pass/`. The final result directory retains all 100
completed responses. `campaign.json` identifies each pass's selected ids.
`preflight/` retains the initial failed case, the five-attempt backoff check,
their summaries, and a minimal availability probe with the full provider
error, plus a fresh-connection check. `campaign.json` lists the recovery
selection and configuration. The resume command was run twice;
each skips completed cases. Use a fresh run tag for a new live experiment.
Inference latency uses the successful final attempt's elapsed time, excluding
failed attempts and backoff; the report records campaign wall time separately.

The primary comparison is Ling plus DeepSeek V4 Flash 0731, Tencent HY3,
GLM-5.2, and Poolside Laguna XS 2.1. Other historical routes remain peers.
Raw Ling requests, responses, timings, token usage, errors, and summary must
be committed and pushed with the completed report and built blog.
