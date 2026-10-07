# Ling 3.0 Flash VL versus budget vision models

100 matched screenshots per model. Only Ling is a new October 7 run; Qwen rows retain August 22 responses.

| Model | Date | Passes / 100 | Mean rubric | Mean latency | Completion tokens | Reported cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3-VL-32B Instruct | 2026-08-22 | 69 | 91.9% | 4.61s | 22197 | $0.0215684 |
| Qwen3-VL-30B-A3B Instruct | 2026-08-22 | 68 | 91.3% | 2.23s | 17108 | $0.0243142 |
| Qwen3.5-35B-A3B | 2026-08-22 | 67 | 90.8% | 5.21s | 55382 | $0.0721400 |
| Ling 3.0 Flash VL | 2026-10-07 | 65 | 88.1% | 3.57s | 51778 | $0.0053823 |
| Qwen3-VL-30B-A3B Thinking | 2026-08-22 | 62 | 88.9% | 6.33s | 68504 | $0.1881696 |
| Qwen3-VL-8B Thinking | 2026-08-22 | 61 | 86.7% | 6.37s | 75504 | $0.1799424 |
| Qwen3-VL-8B Instruct | 2026-08-22 | 48 | 84.0% | 2.12s | 14880 | $0.0206466 |

All 600 historical case scores exactly reproduced. Screenshot hashes, prompts, defaults, questions, and August rubric/scorer bytes match.

Costs use all 100 API usage.cost records per row. Missing historical finish reasons are null, not a claim of zero truncations. Six-section coverage is separate from the historical binary pass gate.
