---
title: Ling 3.0 Flash VL compared with budget vision models
slug: ling30-flash-vl-compared-with-budget-vision-models
sortOrder: -340
date: 2026-10-07
readTime: 7 min read
description: Ling 3.0 Flash VL scores 65 of 100 browser screenshots for $0.0054 on OpenRouter, compared with six budget Qwen vision models using the same images, prompt, and archived rubric.
excerpt: Ling costs less than every budget Qwen reference in our saved runs, with 65 strict passes and 3.57-second mean latency. Reasoning still appears despite the disabling kwargs, and 22 responses hit the output limit.
titleTag: Ling 3.0 Flash VL compared with budget vision models - WebBrain Blog
ogTitle: Ling 3.0 Flash VL compared with budget vision models
ogDescription: A real 100-screenshot test against six budget Qwen references. Same production inputs and grader, dated serving results, and raw OpenRouter evidence.
twitterTitle: Ling 3.0 Flash VL versus budget Qwen vision models
twitterDescription: 65 strict passes, 3.57-second mean latency, and a $0.0054 bill for 100 screenshots. Strong pricing, with reasoning and output-format caveats.
keywords:
  - Ling 3.0 Flash VL
  - inclusionAI
  - budget vision models
  - Qwen3-VL
  - Qwen3.5-35B-A3B
  - OpenRouter
  - screenshot benchmark
  - browser agent
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

**Ling 3.0 Flash VL completes our 100-screenshot browser-vision test with 65 strict passes, an 88.1% mean rubric score, and a reported bill of just $0.0054.** Its 3.57-second mean latency falls between the two strongest budget Qwen vision references: 30B-A3B Instruct at 2.23 seconds and 32B Instruct at 4.61 seconds. Ling is the cheapest measured run in this comparison, but its output budget and response format need attention.

## This time, actual screenshots

Our earlier [Ling 3.0, Nex, and MiniMax comparison](/blog/ling30-flash-vl-vs-nex-n25-minimax-m3) tested text-only planner calls. Here Ling receives **100 actual 1280×720 screenshots** through `image_url`, without accessibility trees or extracted page text. The task is to describe the current viewport for WebBrain's planning agent. We do not ask it to choose tools or execute browser actions.

[inclusionAI's model card](https://huggingface.co/inclusionAI/Ling-3.0-flash-VL) describes a native image/video model with **124B total parameters, 5.5B active per token**, and up to 256K context. [OpenRouter's route](https://openrouter.ai/inclusionai/ling-3.0-flash-vl) supports visual inputs. The small active count concerns per-token compute; it does not make this a 5.5B model to load locally.

We compare it with the six models in our [budget Qwen vision benchmark](/blog/qwen-budget-vision-openrouter). **Only Ling is newly tested on October 7; the Qwen responses remain their August 22 runs.** We reused the same images, production prompt, questions, and grader. The report checks every image hash, verifies the prompt/scorer/question/rubric bytes against the August Git revision, and reproduces all **600 historical case scores exactly**.

Each request uses separate system and user messages, **temperature 0**, **max_tokens 800**, streaming usage, and the original `enable_thinking: false`, `think: false`, and `thinking: false` chat-template kwargs. The user text is fixed; case-specific focus questions are not sent. We retain provider auto-routing and use concurrency two. All 100 Ling responses came from **Novita**, without API errors or retries. A separate one-image preflight is archived but excluded from the ranking and 100-case bill.

## Seven models, one screenshot contract

The production prompt asks for six sections: page purpose, exact visible strings, input states, state signals, blockers, and unknowns. The original deterministic grader combines weighted fact checks with a proportional section-structure score. A strict pass reaches the case threshold and passes every critical check. **Six complete sections are measured separately, rather than being an independent hard pass gate.** These are rubric passes, not completed browser tasks or a human judgment of general visual intelligence.

| Model | Run date | Strict passes / 100 | Mean rubric | Mean latency | Completion tokens | Reported cost / 100 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3-VL-32B Instruct | Aug 22 | **69** | **91.9%** | 4.61s | 22.2K | $0.0216 |
| Qwen3-VL-30B-A3B Instruct | Aug 22 | 68 | 91.3% | 2.23s | 17.1K | $0.0243 |
| Qwen3.5-35B-A3B | Aug 22 | 67 | 90.8% | 5.21s | 55.4K | $0.0721 |
| Ling 3.0 Flash VL | Oct 7 | 65 | 88.1% | 3.57s | 51.8K | **$0.0054** |
| Qwen3-VL-30B-A3B Thinking | Aug 22 | 62 | 88.9% | 6.33s | 68.5K | $0.1882 |
| Qwen3-VL-8B Thinking | Aug 22 | 61 | 86.7% | 6.37s | 75.5K | $0.1799 |
| Qwen3-VL-8B Instruct | Aug 22 | 48 | 84.0% | **2.12s** | 14.9K | $0.0206 |

Ling finishes four passes behind 32B Instruct and three behind 30B-A3B Instruct, while beating both Qwen thinking variants on strict-pass count and mean latency. Against 32B, both models pass 58 screens; Ling alone passes seven and Qwen alone passes eleven. Against 30B-A3B Instruct, the corresponding counts are 58, seven, and ten. These small gaps come from one run per model and different serving dates; they do not establish a stable statistical ranking.

The table uses **actual summed `usage.cost`**, with 100 numeric cost records per model. Rechecking the historical files yields **$0.07214 for Qwen3.5-35B-A3B**, rather than the older post's $0.099, and **$0.50678 for all six Qwen runs**. This comparison uses those reproducible raw bills. Every latency in this table is a mean, not a median.

## Reasoning survives the disabling kwargs

Ling's bill covers **120,800 prompt tokens** and **51,778 completion tokens**, including **33,885 reported reasoning tokens**. All 100 responses report reasoning usage despite the request's thinking-disabling kwargs. We therefore cannot call this an effective non-thinking run. The model card documents `enable_thinking: false` for direct serving, but sending it through this route did not eliminate reported reasoning.

The route returns **22 responses with `finish_reason: "length"`**. That matters under an 800-token budget: the measured configuration sometimes fails to deliver the terse final description the planner expects. We did not raise the cap or change reasoning controls for Ling, because that would change the protocol relative to the saved Qwen runs. A separate run with verified reasoning control or a larger budget could measure another configuration; these results do not predict its score.

Case **046** makes the distinction visible. The screenshot has an upload-failure toast reading “Upload failed” and “Network connection lost.” Ling identifies those strings inside a long analysis/drafting response, then hits the limit before producing the requested state-signals section. It scores **33.3%** and fails the critical toast checks. It saw the relevant evidence, but did not deliver it in the section checked by the grader.

There is also a grader limitation. In **case 021**, Ling describes the page as “Sign-in page” and correctly lists the Atlas heading and controls. The archived purpose check accepts “sign in” or “login,” but not the hyphenated spelling, so it marks a critical failure. We leave the August rubric unchanged for every model and show this example so the score's literal matching is clear. It is not a direct measure of how often the model understands a login screen.

The section parser finds all six numbered sections in **98 responses**; no output is empty. A numbered analysis can itself resemble that structure, so section coverage alone does not establish correct formatting. Scoring uses final `content`; the new raw streams preserve the separate reasoning evidence. Historical `reasoningChars: 0` fields reflect the old runner's stream-field convention, not proof that no reasoning occurred.

## Where the visual results differ

Strict-pass rates by difficulty, with 20 screenshots in each band:

| Band | 32B Inst | 30B-A3B Inst | 35B-A3B | Ling 3.0 VL | 30B-A3B Think | 8B Think | 8B Inst |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Easy | 70% | 70% | 80% | 70% | 65% | 65% | 60% |
| Basic | 75% | 80% | 70% | 70% | 80% | 70% | 65% |
| Intermediate | 80% | 70% | 60% | 65% | 65% | 65% | 50% |
| Advanced | 65% | 60% | 70% | 70% | 50% | 55% | 35% |
| Challenging | 55% | 60% | 55% | 50% | 50% | 50% | 30% |

Ling holds up on advanced screens, then drops to ten passes on the challenging band. Categories reveal more specific strengths and weaknesses; each has only five cases, so one result changes the rate by twenty points.

| Category | Ling passes / 5 | Best individual Qwen passes / 5 |
| --- | ---: | ---: |
| Multilingual OCR | **3** | 2 |
| Calendar | 5 | 5 |
| Chart reading | 5 | 5 |
| Form validation | 1 | 1 |
| Modal overlays | 0 | 1 |
| Consent banners | 2 | 5 |
| Occlusion and contrast | 2 | 5 |

Multilingual OCR is Ling's clearest category advantage in this small corpus. It matches the perfect calendar, chart, table, and kanban results, but does not resolve the budget tier's common overlay and validation failures. **All eighteen screenshots that failed for every Qwen model also fail for Ling.** Its seven unique passes against either leading Qwen reference occur elsewhere; adding Ling does not remove that shared failure set.

## Very cheap, with a configuration question

All Ling responses use Novita's captured October 7 promotional rates: **$0.021/M input, $0.0616/M output, and $0.0042/M cached input**, advertised as a 72% discount. Usage reports **20,480 cached prompt tokens**, or **17.0%** of the prompt total. The observed bill therefore reflects both the promotion and this cache state. It is not a future price guarantee or an uncached speed test.

At the measured bill, 1,000 equivalent screenshots would cost about **$0.054**, assuming the same token usage, rates, and cache conditions. That is roughly four times cheaper than the saved 32B Instruct run and 4.5 times cheaper than 30B-A3B Instruct. Ling's successful requests have a **3.46-second median** and **4.88-second p95**, while the full table retains means for comparability.

For this exact production contract, Qwen3-VL-30B-A3B Instruct retains the better measured combination of strict passes and latency. Ling offers a substantially lower bill with competitive passes, but needs explicit attention to reasoning control, clipping, and output validation. Its low price makes that follow-up worthwhile; the current run already establishes a useful budget vision result without claiming the serving configuration is optimal.

## Raw results and reproduction

The [100 raw Ling cases and summary](https://github.com/webbrain-one/webbrain/tree/main/test/vision/results/2026-10-07-openrouter-ling30-budget_inclusionai_ling-3.0-flash-vl_production) include final text, complete raw SSE streams, usage, provider, finish reason, latency, prompt metadata, and image hashes. The [separate preflight](https://github.com/webbrain-one/webbrain/tree/main/test/vision/results/2026-10-07-openrouter-ling30-budget-preflight_inclusionai_ling-3.0-flash-vl_production) is also committed. Screenshots remain in the shared corpus; credentials and authorization headers are absent.

The [comparison and audit artifacts](https://github.com/webbrain-one/webbrain/tree/main/test/vision/analysis/2026-10-07-ling30-budget) contain all seven rows, case-level pass differences, archived rubrics, fixture/source hashes, endpoint metadata, and the historical regression check. The unchanged grader is applied to all 700 scored screenshots.

```powershell
node test/vision/report-ling30-budget.mjs
npm run test:vision:validate
node scripts/build-blog.mjs
```

For a new live run, set `VISION_PROBE_KEY` in the process environment and choose a fresh tag so the committed responses remain intact:

```powershell
node test/vision/run.mjs --base https://openrouter.ai/api/v1 --model inclusionai/ling-3.0-flash-vl --concurrency 2 --tag your-new-run
```

Tags: #Ling30FlashVL #inclusionAI #Qwen3VL #BudgetVision #OpenRouter #BrowserAgent #WebBrain
