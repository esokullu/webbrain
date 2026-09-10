# WebBrain Compass v2: merged BF16 routing results

Completed 2026-09-10. This is the full merged BF16 candidate, not the earlier
unmerged adapter and not ONNX. Base: OpenBMB MiniCPM5-2B (~2.6B), revision
`3497c460c89e00520c3cfa2e73f49ab7647f1177`. One epoch: 7,311 training examples,
213 validation examples, 457 optimizer steps.

| Measure | Result |
|---|---:|
| First-turn structured tool calls | 94 / 100 |
| Strict exact next action | 16 / 89 |
| Loose match (strict + name-only / equivalent terminal prose) | 41 / 89 (46.1%) |
| Scenario anti-patterns | 1 |
| Transport errors | 0 |
| Malformed native XML responses | 1 |
| Output-length-limited responses | 0 |

The 100-scenario suite has 11 skipped cases and 89 scored cases. Verdicts:
16 `ideal`, 25 `ideal_name`, 45 `other`, 2 `no_tool`, 1 `anti`, 11 `skipped`.
Structured output is format coverage, not action correctness. These tests
measure the next response to fixed histories; no browser actions were executed.

## Complete saved results

- [100 first-turn cases](../results/compact-benchmark-v2-merged-bf16-v4-20260910-first-turn-100_chrome_webbrain-compass-v2-merged-bf16-v4_compact/summary.json)
- [100 scenarios, 89 scored](../results-scenarios/compact-benchmark-v2-merged-bf16-v4-20260910-scenarios-compact_chrome_webbrain-compass-v2-merged-bf16-v4_compact/summary.json)
- [Five-case transport smoke](../results/compact-benchmark-v2-merged-bf16-v4-20260910-smoke_chrome_webbrain-compass-v2-merged-bf16-v4_compact/summary.json)

Every per-case JSON in those directories is included unchanged. No regrading,
cherry-picking, or rewriting of failed cases. The smoke duplicates five prompts;
it is not an additional accuracy sample.

## Reproducibility and limitations

Native MiniCPM template, thinking disabled, special-token XML retained, complete
native parsing with no output repair. Chrome Compact tools; one request at a
time; seed 3407; action temperature 0.15, ask temperature 0.3; top-p 1; top-k 0;
maximum 4,096 generated tokens. Serving used Torch BF16 on RTX 5090 through a
local OpenAI-compatible adapter. 193 input/code hashes and 194 raw responses
(5 smoke + 100 first-turn + 89 scenarios) were audited independently.

Frozen candidate verification SHA256:
`a797ba7921c263142d3c0a43204f188e1424b9c51a95639e2682809415564fce`.
Benchmark completion SHA256:
`10039496a9539a2b5aea8a176ce5e87761352da806af2192e702d9420f3b1130`.
Evidence audit SHA256:
`7231b69d180c74bc3f48875c9beb2fc5707628c322d8a79061f8369c0f59de96`.

The earlier loose-match gate of at least43 failed: this run scored41. That
failure remains disclosed. The user authorized a private experimental BF16
release, not a production-readiness claim. Weights remain private; publishing
benchmark artifacts does not publish the model or grant commercial rights.

Historical model comparisons used different runtimes/precisions. The separately
tested MiniCPM5 base scored 96 structured,9 strict,21 loose. These results support
a promising specialized improvement, not a controlled latency claim or general
equivalence to a 27B model. ONNX results are excluded pending separate validation.
