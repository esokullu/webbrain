# Ling 3.1 Flash: pinned full-tier comparison

Leave-one-out exact action (recursive sorted keys only; all values preserved) and tool-name agreement. No-tool matches no-tool; errors never match. Each model has 13 peers and 1300 comparisons. Original 13-model scores reproduced before adding Ling.

Historical bodies were omitted; Ling inputs are reconstructed from the pinned source. Provider conditions and test dates differ. Consensus is not ground truth and this is first-action-only text input.

| Model | Exact consensus | Tool consensus | Valid / emitted | Ideal tool | Exact ideal | Median | p95 | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek V4 Flash 0731 | 50.9% | 80.5% | 90 / 90 | 39 | 18 | 1.58s | 5.24s | $0.050 |
| Tencent HY3 | 47.2% | 78.7% | 90 / 90 | 41 | 18 | 5.12s | 8.98s | $0.246 |
| GLM-5.2 | 43.2% | 77.0% | 86 / 89 | 39 | 20 | 1.73s | 4.44s | $0.545 |
| Poolside Laguna XS 2.1 | 40.6% | 74.0% | 88 / 89 | 31 | 5 | 1.15s | 2.15s | $0.073 |
| Ling 3.1 Flash | 32.8% | 80.7% | 92 / 93 | 42 | 15 | 3.19s | 10.18s | $0.000 |

Full cohort (14 scored models):

| Model | Exact consensus | Tool consensus | Valid / emitted | Ideal tool | Exact ideal | Median | p95 | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek V4 Flash 0731 | 50.9% | 80.5% | 90 / 90 | 39 | 18 | 1.58s | 5.24s | $0.050 |
| Tencent HY3 | 47.2% | 78.7% | 90 / 90 | 41 | 18 | 5.12s | 8.98s | $0.246 |
| anthropic/claude-sonnet-5 | 43.2% | 75.1% | 98 / 98 | 47 | 17 | 4.06s | 8.28s | $7.222 |
| GLM-5.2 | 43.2% | 77.0% | 86 / 89 | 39 | 20 | 1.73s | 4.44s | $0.545 |
| google/gemini-3.6-flash | 42.7% | 75.1% | 100 / 100 | 36 | 14 | 1.98s | 3.71s | $1.209 |
| MiniMax M3 | 40.9% | 75.2% | 86 / 89 | 33 | 17 | 2.86s | 7.34s | $0.504 |
| moonshotai/kimi-k3 | 40.8% | 79.0% | 97 / 97 | 44 | 18 | 7.60s | 26.15s | $1.563 |
| Poolside Laguna XS 2.1 | 40.6% | 74.0% | 88 / 89 | 31 | 5 | 1.15s | 2.15s | $0.073 |
| qwen/qwen3.6-27b | 38.7% | 74.8% | 83 / 92 | 36 | 17 | 2.27s | 19.36s | $0.670 |
| x-ai/grok-4.5 | 35.3% | 80.2% | 94 / 94 | 36 | 17 | 2.62s | 4.85s | $2.274 |
| thinkingmachines/inkling-small | 34.6% | 74.5% | 84 / 84 | 32 | 15 | 1.05s | 2.06s | $0.243 |
| Ling 3.1 Flash | 32.8% | 80.7% | 92 / 93 | 42 | 15 | 3.19s | 10.18s | $0.000 |
| openai/gpt-5.6-luna-pro | 13.5% | 75.5% | 89 / 89 | 32 | 3 | 5.13s | 7.96s | $0.228 |
| openai/gpt-5.6-terra-pro | 8.5% | 58.8% | 94 / 94 | 12 | 2 | 4.92s | 7.69s | $2.238 |
