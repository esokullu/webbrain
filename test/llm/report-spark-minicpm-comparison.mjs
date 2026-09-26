#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepEqual, scoreVerdict } from './lib/score.mjs';
import { loadReplay, replayCase } from './lib/replay-payload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(here, 'analysis/2026-09-26-spark-minicpm-compact');
const replay = loadReplay(join(here, 'freeze/compact-replay-2026-09-07.json'), { browser: 'chrome', tier: 'compact' });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const repoPath = path => relative(root, path).replaceAll('\\', '/');
const newRows = [];
const audit = { schema: 'webbrain.compact-comparison-audit.v1', replay: replay.meta, models: [] };

for (const id of ['spark-x2.5-4b', 'minicpm5-2b', 'spark-x2.5-1.7b']) {
  const metaPath = join(out, `${id}-run.json`);
  const metadata = read(metaPath);
  if (!metadata.completedAt || metadata.error) throw new Error(`Incomplete run: ${id}`);
  if (metadata.replaySha256 !== replay.meta.sha256) throw new Error('Replay digest mismatch.');
  if (metadata.serverModels.data[0].id !== metadata.model.name) throw new Error('Served model mismatch.');
  const row = { model: metadata.model.name, parameters: id === 'minicpm5-2b' ? '2.52B' : id === 'spark-x2.5-4b' ? '4B' : '1.7B',
    new: true, quantization: metadata.quantization, parametersTotal: metadata.serverModels.data[0].meta.n_params,
    modelArtifact: metadata.model, runtimeBuild: metadata.serverProperties.build_info,
    runtimeChatTemplateSha256: digest(metadata.serverProperties.chat_template),
    calls: 0, strict: 0, loose: 0, firstTurnExact: 0, firstTurnNameOnly: 0, treeCalls: 0,
    firstTurnErrors: 0, scenarioErrors: 0, anti: 0, empty: 0, lengthLimited: 0, proseCredits: 0,
    byCategory: {}, sources: {} };
  const evidence = { model: row.model, metadata: repoPath(metaPath), metadataSha256: digest(readFileSync(metaPath)), records: [] };
  for (const track of ['first-turn', 'scenarios']) {
    const stage = metadata.stages.find(s => s.stage === 'full' && s.track === track);
    if (!stage) throw new Error(`Missing ${track} run: ${id}`);
    const files = readdirSync(stage.resultDir).filter(f => /^\d{3}\.json$/.test(f)).sort();
    if (files.length !== 100) throw new Error(`Expected 100 records: ${id}/${track}`);
    row.sources[track] = repoPath(stage.resultDir);
    let skipped = 0;
    for (const name of files) {
      const path = join(stage.resultDir, name);
      const bytes = readFileSync(path);
      const result = JSON.parse(bytes);
      const saved = replayCase(replay, track === 'first-turn' ? 'firstTurn' : 'scenarios', result.id, row.model);
      if (saved.skipped) {
        if (result.skipped !== saved.skipped || result.response || result.request) throw new Error('Skipped case was sent.');
        skipped++;
      } else {
        if (!deepEqual(result.request, saved.body)) throw new Error(`Request differs from replay: ${id}/${track}/${name}`);
        if (!result.response && !result.error) throw new Error(`Missing API response: ${id}/${name}`);
        if (result.response?.model !== row.model) throw new Error(`Response model differs: ${id}/${name}`);
        if (result.firstToolCall && !result.request.tools.some(t => t.function.name === result.firstToolCall.name)) {
          throw new Error(`Unknown tool emitted: ${id}/${track}/${name}`);
        }
      }
      if (result.finishReason === 'length') row.lengthLimited++;
      if (track === 'first-turn') {
        if (result.error) row.firstTurnErrors++;
        if (result.firstToolCall) {
          if (result.toolCallSource !== 'tool_calls') throw new Error('First-turn coverage includes content fallback.');
          row.calls++;
          if (result.firstToolCall.name === 'get_accessibility_tree') row.treeCalls++;
          const expected = read(join(here, 'expected', name)).idealFirstToolCall;
          if (result.firstToolCall.name === expected.name) {
            if (deepEqual(result.firstToolCall.args, expected.args)) row.firstTurnExact++;
            else row.firstTurnNameOnly++;
          }
        }
      } else {
        if (!deepEqual(result.expected, saved.expected)) throw new Error('Scenario reference changed.');
        const scored = scoreVerdict(result);
        if (scored.verdict !== result.verdict) throw new Error(`Grader disagreement: ${id}/${name}`);
        if (scored.verdict === 'ideal') row.strict++;
        if (['ideal', 'ideal_name'].includes(scored.verdict)) row.loose++;
        if (scored.verdict === 'anti') row.anti++;
        if (scored.verdict === 'error') row.scenarioErrors++;
        if (scored.verdict === 'empty') row.empty++;
        if (result.scoreNote) row.proseCredits++;
        row.byCategory[result.category] ||= { scored: 0, strict: 0, loose: 0, anti: 0 };
        const category = row.byCategory[result.category];
        if (!result.skipped) category.scored++;
        if (scored.verdict === 'ideal') category.strict++;
        if (['ideal', 'ideal_name'].includes(scored.verdict)) category.loose++;
        if (scored.verdict === 'anti') category.anti++;
      }
      evidence.records.push({ track, id: result.id, path: repoPath(path), sha256: digest(bytes),
        requestSha256: result.request ? digest(JSON.stringify(result.request)) : null });
    }
    if (track === 'scenarios' && skipped !== 11) throw new Error('Scenario denominator changed.');
    if (track === 'first-turn' && (row.calls !== stage.summary.withToolCall || row.firstTurnErrors !== stage.summary.errors)) throw new Error('First-turn summary mismatch.');
    if (track === 'scenarios' && (row.strict !== (stage.summary.byVerdict.ideal || 0)
      || row.loose !== (stage.summary.byVerdict.ideal || 0) + (stage.summary.byVerdict.ideal_name || 0))) throw new Error('Scenario summary mismatch.');
  }
  newRows.push(row); audit.models.push(evidence);
}

const history = read(join(out, 'historical-comparison.json'));
const historicalRows = history.rows.filter(row => !row.model.startsWith('MiniCPM5-2B'));
// Verify each carried-forward score exists in its published Markdown source.
for (const row of historicalRows) {
  const slug = row.source.split('/').at(-1);
  const text = readFileSync(join(root, 'web/blog/posts', `${slug}.md`), 'utf8');
  if (!text.includes(row.model.replace(' (earlier run)', '')) || !text.includes(String(row.loose))) throw new Error(`Historical source missing: ${row.model}`);
}
const allRows = [...newRows, ...historicalRows].sort((a, b) => b.strict - a.strict || b.loose - a.loose || a.model.localeCompare(b.model));
const slug = 'spark-minicpm-compact-tool-routing';
const publicDir = join(root, 'web/blog', slug);
mkdirSync(publicDir, { recursive: true });
const comparison = { schema: 'webbrain.compact-comparison.v1', date: '2026-09-26',
  contract: { browser: 'chrome', tier: 'compact', firstTurnCases: 100, scenarios: 100, scoredScenarios: 89, skippedScenarios: 11,
    thinking: false, seed: 3407, actionTemperature: 0.15, askTemperature: 0.3, maxTokens: 4096,
    contextTokens: 32768, concurrency: 1, quantization: 'Q4_K_M', topK: 0, topP: 1, minP: 0, repeatPenalty: 1,
    replaySha256: replay.meta.sha256, notes: 'Historical comparison rows retain their published scores. Backends, precision, revisions, retries, and concurrency differ.' },
  comparison1: newRows, completeTable: allRows };
for (const dir of [out, publicDir]) writeFileSync(join(dir, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
writeFileSync(join(out, 'evidence-audit.json'), JSON.stringify(audit, null, 2) + '\n');
const rate = value => `${(100 * value / 89).toFixed(1)}%`;
const table = rows => '| Model | Parameters | First-turn structured calls (/100) | Strict exact action (/89) | Loose tool-family match (/89) | Loose rate |\n'
  + '| --- | ---: | ---: | ---: | ---: | ---: |\n'
  + rows.map(r => `| ${r.new ? `**${r.model} (new Q4)**` : r.model} | ${r.parameters} | ${r.calls} | ${r.strict} | ${r.loose} | ${rate(r.loose)} |`).join('\n');
const strictLeaders = newRows.filter(r => r.strict === Math.max(...newRows.map(r => r.strict)));
const looseLeaders = newRows.filter(r => r.loose === Math.max(...newRows.map(r => r.loose)));
const names = rows => rows.map(r => r.model).join(' and ');
const failures = newRows.map(r => `| ${r.model} | ${r.firstTurnExact} | ${r.treeCalls} | ${r.anti} | ${r.firstTurnErrors + r.scenarioErrors} | ${r.lengthLimited} |`).join('\n');
const tick = String.fromCharCode(96);
const body = `We ran **Spark-X2.5-4B, MiniCPM5-2B, and Spark-X2.5-1.7B** locally on an RTX 5090 using official Q4_K_M GGUF files. ${names(strictLeaders)} ${strictLeaders.length === 1 ? 'leads' : 'lead'} the three on strict next-action matching with **${strictLeaders[0].strict}/89**. ${names(looseLeaders)} ${looseLeaders.length === 1 ? 'leads' : 'lead'} the looser tool-family measure at **${looseLeaders[0].loose}/89 (${rate(looseLeaders[0].loose)})**.

## Comparison 1: the three new runs

The suite has 100 first-turn prompts and 100 seeded scenarios. Eleven Dev scenarios are outside Compact mode, leaving **89 scored scenarios**. Strict means the reference tool name **and arguments** match. Loose adds name-only matches and terminal prose credited as the expected tool family. Structured-call coverage measures output format; none of these columns measures completed browser tasks.

${table(newRows)}

All three used the same saved inputs, backend, quantization, context size, sampling settings, and one request at a time. The three GGUF files total **4.91 GiB**, and their SHA-256 hashes matched the publishers' LFS hashes. Smoke runs were used to check serving and parsing; the table uses only the full suites.

## What the responses show

High tool-call coverage hides a strong preference for inspecting the page. Spark 4B called ${tick}get_accessibility_tree${tick} on ${newRows[0].treeCalls}/100 first-turn prompts, MiniCPM on ${newRows[1].treeCalls}/100, and Spark 1.7B on ${newRows[2].treeCalls}/100. Their first-turn exact-reference scores were ${newRows[0].firstTurnExact}, ${newRows[1].firstTurnExact}, and ${newRows[2].firstTurnExact} out of 100, respectively. Inspecting can be reasonable, but it often differs from the reference's requested next action.

| Model | First-turn exact reference (/100) | First-turn tree calls (/100) | Scenario anti-patterns (/89) | Transport errors | Output-length limits |
| --- | ---: | ---: | ---: | ---: | ---: |
${failures}

Anti-patterns flag specific bad next actions in the full suite, including retry loops, pagination, and confirmation mistakes. They are not exclusively prompt-injection failures. The loose score includes ${newRows[0].proseCredits}, ${newRows[1].proseCredits}, and ${newRows[2].proseCredits} prose-only credits for Spark 4B, MiniCPM, and Spark 1.7B. Those credits do not prove that the model would complete the task or resist an attack in a live browser.

Two responses reached the 4,096-token cap: MiniCPM's German weather scenario (072) was graded ${tick}no_tool${tick}, while Spark 1.7B's repetitive Turkish summary (073) still received ${tick}ideal_name${tick} because the expected action was terminal. Both outputs are retained. Spark 1.7B's loose lead therefore needs particular care: 24 of its 37 credits are prose-only, and the grader does not judge the factual quality of that prose.

## Complete comparison, including previous runs

The table below compares **15 models**, sorted by strict score, then loose score. It includes the models from the earlier Compact comparison and Compass Tiny v1 and v2 reports. Qwen3.5-9B, omitted from the ten-model update, is included again.

${table(allRows)}

The prior Qwen3.8-27B run remains ahead on strict matching at 17/89; none of these three new runs exceeds it. The earlier Gemma 4 E2B run still has the highest loose score at 45/89. These are historical comparison points: model revisions, runtimes, precision, concurrency, and some transport-recovery procedures differ. The old scores are retained as published, without rerunning or regrading them.

## Method and reproducibility

The shipped prompt changed after September 7. To keep this round aligned with the earlier comparison, we replayed the saved September 7 per-case messages and 24 Act tool schemas. The 15 Ask schemas were recovered from the September 7 source at commit ${tick}5e12c0003${tick}. The snapshot preserves the seeded histories, scenario reference actions, and all 11 skipped cases. The audit verifies all 600 full-suite case records, the 567 requests actually sent, their payloads, response model identities, and scenario grades.

Serving used LM Studio's llama.cpp CUDA runtime **2.46.0**, with the embedded native chat templates and its OpenAI-compatible tool parser. Settings: **thinking disabled**, seed **3407**, Act temperature **0.15**, Ask temperature **0.3**, top-p **1**, top-k **0**, min-p **0**, repetition penalty **1**, context **32,768**, and at most **4,096 generated tokens**. We retained complete request bodies and API responses. Browser actions were not executed. This tests a fixed browser-routing configuration; it is not a reproduction of the model cards' thinking-mode or recommended-sampling benchmarks.

The Sonnet-authored reference action is a regression target, not an oracle for every reasonable browser strategy. This is a single run per new model, and historical rows are not a controlled speed comparison.

| Model | Official GGUF repository | Pinned revision | GGUF SHA-256 |
| --- | --- | --- | --- |
${newRows.map(r => `| ${r.model} | [${r.modelArtifact.repo}](https://huggingface.co/${r.modelArtifact.repo}) | ${tick}${r.modelArtifact.revision}${tick} | ${tick}${r.modelArtifact.sha256}${tick} |`).join('\n')}

MiniCPM's current model card reports 2,516,756,480 total parameters; the new table rounds this to 2.52B. Historical parameter labels are retained as published. See the original model cards for [Spark 4B](https://huggingface.co/XHToken/Spark-X2.5-4B), [MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B), and [Spark 1.7B](https://huggingface.co/XHToken/Spark-X2.5-1.7B).

Download the [comparison data](/blog/${slug}/comparison.json). Saved requests, responses, per-case hashes, run settings, and the report generator live under ${tick}test/llm${tick}. Reproduce the prepared comparison with:

${tick.repeat(3)}powershell
node test/llm/run-spark-minicpm-comparison.mjs
node test/llm/report-spark-minicpm-comparison.mjs
node scripts/build-blog.mjs
${tick.repeat(3)}

The runner expects the pinned GGUF files in the LM Studio model directory; ${tick}GGUF_MODEL_ROOT${tick} and ${tick}LLAMA_SERVER${tick} override the model directory and runtime. It refuses to overwrite completed runs; reproduce in a separate working copy with this round's dated result directories and run-metadata files moved aside. Prior results come from the [ten-model comparison](/blog/compact-tool-routing-models-compared), [Compass Tiny v1](/blog/webbrain-compass-tiny-v1), and [Compass Tiny v2](/blog/webbrain-compass-v2).
`;
const front = `---
title: Spark X2.5 vs MiniCPM5: three compact browser-tool models tested
slug: ${slug}
sortOrder: -301
date: 2026-09-26
readTime: 6 min read
description: RTX 5090 tests of Spark-X2.5-4B, MiniCPM5-2B, and Spark-X2.5-1.7B, followed by a complete 15-model Compact comparison.
excerpt: Three new official Q4 GGUF runs on the same saved Compact inputs, with strict action matching, loose tool-family scores, and the complete historical table.
keywords:
  - Spark-X2.5
  - MiniCPM5-2B
  - browser agent benchmark
  - tool calling
  - RTX 5090
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

`;
writeFileSync(join(root, 'web/blog/posts', `${slug}.md`), front + body);
writeFileSync(join(out, 'report.md'), body);
console.log(JSON.stringify({ comparison1: newRows.map(r => ({ model: r.model, calls: r.calls, strict: r.strict, loose: r.loose,
  errors: r.firstTurnErrors + r.scenarioErrors })), completeRows: allRows.length,
  auditedRecords: audit.models.reduce((n, m) => n + m.records.length, 0), blog: repoPath(join(root, 'web/blog/posts', `${slug}.md`)) }, null, 2));
