---
title: >
  WebBrain Compass Tiny v2: small model, sharper tool routing
slug: webbrain-compass-v2
sortOrder: -283
date: 2026-09-10
readTime: 2 min read
description: >
  Meet WebBrain Compass Tiny v2, our MiniCPM5-2B-based tool-routing model. Compare its merged BF16 results with 11 other models, including larger reference models.
excerpt: >
  Built on MiniCPM5-2B, Compass Tiny v2 reaches 16 exact actions and 41 tool-family matches out of 89 scenarios. A promising step toward WebBrain integration.
titleTag: >
  WebBrain Compass Tiny v2: MiniCPM5-Based Tool Routing - WebBrain Blog
ogTitle: >
  Meet WebBrain Compass Tiny v2
ogDescription: >
  A small, specialized tool-routing model: 16/89 exact actions and 41/89 tool-family matches in our Compact routing benchmark.
author: Emre Sokullu
authorUrl: https://emresokullu.com
keywords:
  - WebBrain Compass Tiny v2
  - MiniCPM5-2B
  - tool calling
  - browser agent benchmark
  - local AI
html: true
lede: >
  **Meet WebBrain Compass Tiny v2**, our new small model for choosing WebBrain browser tools and their arguments. Built on MiniCPM5-2B, it shows a substantial routing improvement over its base. We expect to incorporate it into WebBrain soon, subject to runtime validation and release checks.
---

## A focused upgrade

Compass Tiny v2 is a LoRA fine-tune of [OpenBMB's MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B), approximately 2.6B parameters. We trained it for one epoch on 7,311 reviewed examples, with 213 held out for validation. Its job is specialized tool routing—not replacing a general-purpose planner.

Against the separately tested base, the merged BF16 model moves from **9 to 16 exact actions** and **21 to 41 tool-family matches**. Structured-call coverage slips from 96 to 94 out of 100.

## One comparison, all models

Sorted by strict exact action, then loose match. Larger Qwen models are included as reference points. Both bar columns use the same 0–89 scale.

<figure class="compass-comparison" aria-labelledby="compass-chart-caption">
<style>
.compass-comparison { margin: 24px 0; }
.compass-comparison .chart-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
.compass-comparison .chart-scroll:focus-visible { outline: 2px solid var(--accent2); outline-offset: 4px; }
.compass-comparison table { min-width: 900px; margin: 0; font-variant-numeric: tabular-nums; }
.compass-comparison th, .compass-comparison td { vertical-align: middle; padding: 12px 10px; }
.compass-comparison thead th { text-transform: none; line-height: 1.4; font-size: 12px; }
.compass-comparison tbody th { color: var(--text); font-size: 13px; font-weight: 500; text-transform: none; background: transparent; min-width: 208px; }
.compass-comparison tbody tr:last-child > * { border-bottom: 0; }
.compass-comparison td { font-size: 13px; white-space: nowrap; }
.compass-comparison .compass > * { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.compass-comparison .compass th { font-weight: 750; border-left: 3px solid var(--accent2); }
.compass-comparison .base th { border-left: 3px solid var(--text-dim); }
.compass-comparison small { display: block; font-size: 11px; font-weight: 400; color: var(--text-dim); margin-top: 3px; }
.compass-comparison .denom { color: var(--text-dim); font-weight: 400; }
.compass-comparison .score { position: relative; display: block; width: 150px; height: 28px; background: var(--tint-soft-2); }
.compass-comparison .score i { display: block; position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--accent2) 30%, transparent); border-right: 2px solid var(--accent2); }
.compass-comparison .score.loose i { background: color-mix(in srgb, #249ca3 24%, transparent); border-color: #249ca3; }
.compass-comparison .score b { position: relative; display: block; padding: 3px 8px; color: var(--text); font-weight: 600; }
.compass-comparison figcaption { color: var(--text-dim); font-size: 12px; line-height: 1.6; margin-top: 12px; }
@media (min-width: 1140px) { .compass-comparison { width: 1060px; margin-left: calc((100% - 1060px) / 2); } }
</style>
<div class="chart-scroll" role="region" tabindex="0" aria-label="Model comparison chart; scroll horizontally to see all columns">
<table>
<thead><tr><th scope="col">Model</th><th scope="col">Parameters</th><th scope="col">Structured calls</th><th scope="col">Strict exact action</th><th scope="col">Loose tool-family match</th><th scope="col">Loose rate</th></tr></thead>
<tbody>
<tr><th scope="row">Qwen3.8-27B</th><td>27B</td><td>99<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:19.1011%"></i><b>17<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:43.8202%"></i><b>39<span class="denom"> / 89</span></b></span></td><td>43.8%</td></tr>
<tr class="compass"><th scope="row">WebBrain Compass Tiny v2<small>Merged BF16 · new</small></th><td>~2.6B</td><td>94<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:17.9775%"></i><b>16<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:46.0674%"></i><b>41<span class="denom"> / 89</span></b></span></td><td>46.1%</td></tr>
<tr><th scope="row">Qwen3.5-4B</th><td>4B</td><td>89<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:17.9775%"></i><b>16<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:40.4494%"></i><b>36<span class="denom"> / 89</span></b></span></td><td>40.4%</td></tr>
<tr><th scope="row">Gemma 4 E4B</th><td>7.5B</td><td>90<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:16.8539%"></i><b>15<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:48.3146%"></i><b>43<span class="denom"> / 89</span></b></span></td><td>48.3%</td></tr>
<tr><th scope="row">Qwen3.6-35B-A3B</th><td>35B A3B</td><td>89<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:16.8539%"></i><b>15<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:47.1910%"></i><b>42<span class="denom"> / 89</span></b></span></td><td>47.2%</td></tr>
<tr><th scope="row">Nanbeige4.2-3B</th><td>4.2B reported</td><td>89<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:14.6067%"></i><b>13<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:41.5730%"></i><b>37<span class="denom"> / 89</span></b></span></td><td>41.6%</td></tr>
<tr><th scope="row">Gemma 4 12B QAT</th><td>12B</td><td>90<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:13.4831%"></i><b>12<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:38.2022%"></i><b>34<span class="denom"> / 89</span></b></span></td><td>38.2%</td></tr>
<tr><th scope="row">Qwen3.5-2B</th><td>2B</td><td>92<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:12.3596%"></i><b>11<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:31.4607%"></i><b>28<span class="denom"> / 89</span></b></span></td><td>31.5%</td></tr>
<tr class="base"><th scope="row">MiniCPM5-2B base<small>Compass Tiny v2's base</small></th><td>~2.6B</td><td>96<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:10.1124%"></i><b>9<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:23.5955%"></i><b>21<span class="denom"> / 89</span></b></span></td><td>23.6%</td></tr>
<tr><th scope="row">Gemma 4 E2B</th><td>4.6B</td><td>74<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:8.9888%"></i><b>8<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:50.5618%"></i><b>45<span class="denom"> / 89</span></b></span></td><td>50.6%</td></tr>
<tr><th scope="row">WebBrain Compass Tiny v1</th><td>2.6B</td><td>81<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:4.4944%"></i><b>4<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:47.1910%"></i><b>42<span class="denom"> / 89</span></b></span></td><td>47.2%</td></tr>
<tr><th scope="row">LFM2.5-2.6B base</th><td>2.6B</td><td>80<span class="denom"> / 100</span></td><td><span class="score strict"><i aria-hidden="true" style="width:4.4944%"></i><b>4<span class="denom"> / 89</span></b></span></td><td><span class="score loose"><i aria-hidden="true" style="width:38.2022%"></i><b>34<span class="denom"> / 89</span></b></span></td><td>38.2%</td></tr>
</tbody>
</table>
</div>
<figcaption id="compass-chart-caption">100 first-turn prompts; 89 scored next-action scenarios. Strict requires the reference tool and arguments. Loose also credits name-only matches and equivalent terminal prose. Structured calls measure format, not correctness. Bars show counts, not executed browser-task success. On narrow screens, scroll the chart sideways.</figcaption>
</figure>

Compass Tiny v2 is one exact match behind Qwen3.8-27B and two tool-family matches ahead in these runs—a promising result at roughly one-tenth the parameter count, not a claim of general 27B-level capability.

## What's next

The [BF16 research preview](https://huggingface.co/webbrain-one/webbrain-compass-tiny-v2) is private on Hugging Face. ONNX compatibility work is underway; integration is planned, not shipped. Runtime checks and training-data licensing clearance remain prerequisites.

Results combine our [earlier comparison](/blog/compact-tool-routing-models-compared), the author's separate MiniCPM5 base run, and Compass Tiny v2's [merged BF16 run and saved results](https://github.com/esokullu/webbrain/blob/main/test/llm/analysis/webbrain-compass-v2-bf16-20260910.md). Backends and precision differ; this is not a controlled speed comparison. Browser actions were not executed. Compass Tiny v2 retained one malformed-XML response and missed our earlier adapter-relative loose-match target (41 versus 43), so it remains experimental.

Tags: #WebBrain #CompassTinyV2 #MiniCPM5 #ToolCalling #LocalAI
