We ran **Spark-X2.5-4B, MiniCPM5-2B, and Spark-X2.5-1.7B** locally on an RTX 5090 using official Q4_K_M GGUF files. Spark-X2.5-4B leads the three on strict next-action matching with **11/89**. Spark-X2.5-1.7B leads the looser tool-family measure at **37/89 (41.6%)**.

## Comparison 1: the three new runs

The suite has 100 first-turn prompts and 100 seeded scenarios. Eleven Dev scenarios are outside Compact mode, leaving **89 scored scenarios**. Strict means the reference tool name **and arguments** match. Loose adds name-only matches and terminal prose credited as the expected tool family. Structured-call coverage measures output format; none of these columns measures completed browser tasks.

| Model | Parameters | First-turn structured calls (/100) | Strict exact action (/89) | Loose tool-family match (/89) | Loose rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Spark-X2.5-4B (new Q4)** | 4B | 96 | 11 | 30 | 33.7% |
| **MiniCPM5-2B (new Q4)** | 2.52B | 96 | 9 | 31 | 34.8% |
| **Spark-X2.5-1.7B (new Q4)** | 1.7B | 99 | 9 | 37 | 41.6% |

All three used the same saved inputs, backend, quantization, context size, sampling settings, and one request at a time. The three GGUF files total **4.91 GiB**, and their SHA-256 hashes matched the publishers' LFS hashes. Smoke runs were used to check serving and parsing; the table uses only the full suites.

## What the responses show

High tool-call coverage hides a strong preference for inspecting the page. Spark 4B called `get_accessibility_tree` on 78/100 first-turn prompts, MiniCPM on 84/100, and Spark 1.7B on 88/100. Their first-turn exact-reference scores were 5, 2, and 1 out of 100, respectively. Inspecting can be reasonable, but it often differs from the reference's requested next action.

| Model | First-turn exact reference (/100) | First-turn tree calls (/100) | Scenario anti-patterns (/89) | Transport errors | Output-length limits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Spark-X2.5-4B | 5 | 78 | 2 | 0 | 0 |
| MiniCPM5-2B | 2 | 84 | 3 | 0 | 1 |
| Spark-X2.5-1.7B | 1 | 88 | 1 | 0 | 1 |

Anti-patterns flag specific bad next actions in the full suite, including retry loops, pagination, and confirmation mistakes. They are not exclusively prompt-injection failures. The loose score includes 9, 18, and 24 prose-only credits for Spark 4B, MiniCPM, and Spark 1.7B. Those credits do not prove that the model would complete the task or resist an attack in a live browser.

Two responses reached the 4,096-token cap: MiniCPM's German weather scenario (072) was graded `no_tool`, while Spark 1.7B's repetitive Turkish summary (073) still received `ideal_name` because the expected action was terminal. Both outputs are retained. Spark 1.7B's loose lead therefore needs particular care: 24 of its 37 credits are prose-only, and the grader does not judge the factual quality of that prose.

## Complete comparison, including previous runs

The table below compares **15 models**, sorted by strict score, then loose score. It includes the models from the earlier Compact comparison and Compass Tiny v1 and v2 reports. Qwen3.5-9B, omitted from the ten-model update, is included again.

| Model | Parameters | First-turn structured calls (/100) | Strict exact action (/89) | Loose tool-family match (/89) | Loose rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3.8-27B | 27B | 99 | 17 | 39 | 43.8% |
| WebBrain Compass Tiny v2 | ~2.6B | 94 | 16 | 41 | 46.1% |
| Qwen3.5-4B | 4B | 89 | 16 | 36 | 40.4% |
| Gemma 4 E4B | 7.5B | 90 | 15 | 43 | 48.3% |
| Qwen3.6-35B-A3B | 35B A3B | 89 | 15 | 42 | 47.2% |
| Nanbeige4.2-3B | 4.2B reported | 89 | 13 | 37 | 41.6% |
| Gemma 4 12B QAT | 12B | 90 | 12 | 34 | 38.2% |
| **Spark-X2.5-4B (new Q4)** | 4B | 96 | 11 | 30 | 33.7% |
| Qwen3.5-2B | 2B | 92 | 11 | 28 | 31.5% |
| **Spark-X2.5-1.7B (new Q4)** | 1.7B | 99 | 9 | 37 | 41.6% |
| **MiniCPM5-2B (new Q4)** | 2.52B | 96 | 9 | 31 | 34.8% |
| Gemma 4 E2B | 4.6B | 74 | 8 | 45 | 50.6% |
| WebBrain Compass Tiny v1 | 2.6B | 81 | 4 | 42 | 47.2% |
| LFM2.5-2.6B base | 2.6B | 80 | 4 | 34 | 38.2% |
| Qwen3.5-9B | 9B | 84 | 2 | 12 | 13.5% |

The prior Qwen3.8-27B run remains ahead on strict matching at 17/89; none of these three new runs exceeds it. The earlier Gemma 4 E2B run still has the highest loose score at 45/89. These are historical comparison points: model revisions, runtimes, precision, concurrency, and some transport-recovery procedures differ. The old scores are retained as published, without rerunning or regrading them.

## Method and reproducibility

The shipped prompt changed after September 7. To keep this round aligned with the earlier comparison, we replayed the saved September 7 per-case messages and 24 Act tool schemas. The 15 Ask schemas were recovered from the September 7 source at commit `5e12c0003`. The snapshot preserves the seeded histories, scenario reference actions, and all 11 skipped cases. The audit verifies all 600 full-suite case records, the 567 requests actually sent, their payloads, response model identities, and scenario grades.

Serving used LM Studio's llama.cpp CUDA runtime **2.46.0**, with the embedded native chat templates and its OpenAI-compatible tool parser. Settings: **thinking disabled**, seed **3407**, Act temperature **0.15**, Ask temperature **0.3**, top-p **1**, top-k **0**, min-p **0**, repetition penalty **1**, context **32,768**, and at most **4,096 generated tokens**. We retained complete request bodies and API responses. Browser actions were not executed. This tests a fixed browser-routing configuration; it is not a reproduction of the model cards' thinking-mode or recommended-sampling benchmarks.

The Sonnet-authored reference action is a regression target, not an oracle for every reasonable browser strategy. This is a single run per new model, and historical rows are not a controlled speed comparison.

| Model | Official GGUF repository | Pinned revision | GGUF SHA-256 |
| --- | --- | --- | --- |
| Spark-X2.5-4B | [XHToken/Spark-X2.5-4B-GGUF](https://huggingface.co/XHToken/Spark-X2.5-4B-GGUF) | `9826e0be84e6e6e8b9668abc91421109a1df1e2d` | `adfcfa19a4ed6a5985da8bf565fe15f8e1a7e131d79bae2d19d48d1c40109428` |
| MiniCPM5-2B | [openbmb/MiniCPM5-2B-GGUF](https://huggingface.co/openbmb/MiniCPM5-2B-GGUF) | `2079a22f3beaa4e306449978533478fe0522f4b3` | `ec2d5801640099e97d8d7e8003ad4d81f336e757811f03a26173dddf386602fd` |
| Spark-X2.5-1.7B | [XHToken/Spark-X2.5-1.7B-GGUF](https://huggingface.co/XHToken/Spark-X2.5-1.7B-GGUF) | `1f7fa33b1245c14730da39e125714ad3a327901b` | `902bde2522394954ac17821b3e5fd0df02defbc6944f122253f2580acf0503f4` |

MiniCPM's current model card reports 2,516,756,480 total parameters; the new table rounds this to 2.52B. Historical parameter labels are retained as published. See the original model cards for [Spark 4B](https://huggingface.co/XHToken/Spark-X2.5-4B), [MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B), and [Spark 1.7B](https://huggingface.co/XHToken/Spark-X2.5-1.7B).

Download the [comparison data](/blog/spark-minicpm-compact-tool-routing/comparison.json). Saved requests, responses, per-case hashes, run settings, and the report generator live under `test/llm`. Reproduce the prepared comparison with:

```powershell
node test/llm/run-spark-minicpm-comparison.mjs
node test/llm/report-spark-minicpm-comparison.mjs
node scripts/build-blog.mjs
```

The runner expects the pinned GGUF files in the LM Studio model directory; `GGUF_MODEL_ROOT` and `LLAMA_SERVER` override the model directory and runtime. It refuses to overwrite completed runs; reproduce in a separate working copy with this round's dated result directories and run-metadata files moved aside. Prior results come from the [ten-model comparison](/blog/compact-tool-routing-models-compared), [Compass Tiny v1](/blog/webbrain-compass-tiny-v1), and [Compass Tiny v2](/blog/webbrain-compass-v2).
