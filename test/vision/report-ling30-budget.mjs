#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { scoreVisionResponse } from './lib/score.mjs';
import { VISION_SYSTEM_PROMPT, PRODUCTION_USER_TEXT, REQUEST_DEFAULTS } from './prompt.mjs';

const OUT = 'test/vision/analysis/2026-10-07-ling30-budget';
const REV = 'd25be94f4981c2fe5ff1d220f8b698ee72e88296';
const ROOT = 'test/vision';
const historicalOnly = process.argv.includes('--historical-only');
const labels = {
  'inclusionai/ling-3.0-flash-vl': 'Ling 3.0 Flash VL',
  'qwen/qwen3-vl-32b-instruct': 'Qwen3-VL-32B Instruct',
  'qwen/qwen3-vl-30b-a3b-instruct': 'Qwen3-VL-30B-A3B Instruct',
  'qwen/qwen3.5-35b-a3b': 'Qwen3.5-35B-A3B',
  'qwen/qwen3-vl-30b-a3b-thinking': 'Qwen3-VL-30B-A3B Thinking',
  'qwen/qwen3-vl-8b-thinking': 'Qwen3-VL-8B Thinking',
  'qwen/qwen3-vl-8b-instruct': 'Qwen3-VL-8B Instruct',
};
const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const ids = Array.from({ length: 100 }, (_, i) => String(i + 1).padStart(3, '0'));
const files = ['prompt.mjs', 'lib/score.mjs', ...ids.flatMap(id => [`questions/${id}.json`, `expected/${id}.json`])];
const sourceHashes = {};
for (const file of files) {
  const bytes = await readFile(`${ROOT}/${file}`);
  const old = execFileSync('git', ['show', `${REV}:${ROOT}/${file}`]);
  assert.equal(sha(bytes), sha(old), `August source changed: ${file}`);
  sourceHashes[file] = sha(bytes);
}
const rubrics = Object.fromEntries(await Promise.all(ids.map(async id => [id, await json(`${ROOT}/expected/${id}.json`)])));
const manifest = { sourceRevision: REV, sourceHashes, images: {} };
for (const id of ids) manifest.images[id] = sha(await readFile(`${ROOT}/images/${id}.png`));
const dirs = (await readdir(`${ROOT}/results`)).filter(name => name.startsWith('2026-08-22-openrouter-full_qwen_')).sort();
assert.equal(dirs.length, 6);
if (!historicalOnly) dirs.push('2026-10-07-openrouter-ling30-budget_inclusionai_ling-3.0-flash-vl_production');
const rows = [];
const casesByModel = {};
for (const dir of dirs) {
  const source = `${ROOT}/results/${dir}`;
  const cases = await Promise.all(ids.map(id => json(`${source}/${id}.json`)));
  assert.equal(cases.filter(c => c.error).length, 0, `${dir} has failed requests; archive and recover them before reporting a complete run`);
  for (const c of cases) {
    assert.equal(c.response.status, 200);
    if (c.response.raw) {
      const events = c.response.raw.split(/\r?\n/).filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
      assert(events.every(event => !event.error), `Embedded API error: ${dir}/${c.id}`);
      assert.equal(events.map(event => event.choices?.[0]?.delta?.content || '').join(''), c.response.content);
      assert.deepEqual(events.findLast(event => event.usage)?.usage, c.response.usage);
      assert.equal(events.findLast(event => event.provider)?.provider, c.response.provider);
      assert.equal(events.findLast(event => event.choices?.[0]?.finish_reason)?.choices[0].finish_reason, c.response.finishReason);
      assert(c.response.raw.includes('data: [DONE]'), `Incomplete stream: ${dir}/${c.id}`);
    }
    assert.equal(c.promptMode, 'production');
    assert.equal(c.image.sha256, manifest.images[c.id], `Image mismatch: ${dir}/${c.id}`);
    assert.equal(c.request.systemPrompt, VISION_SYSTEM_PROMPT);
    assert.equal(c.request.userText, PRODUCTION_USER_TEXT);
    assert.equal(c.request.foldSystem, false);
    assert.equal(c.request.temperature, REQUEST_DEFAULTS.temperature);
    assert.equal(c.request.maxTokens, REQUEST_DEFAULTS.maxTokens);
    assert.deepEqual(c.request.chatTemplateKwargs, REQUEST_DEFAULTS.chatTemplateKwargs);
    assert.deepEqual(c.question, await json(`${ROOT}/questions/${c.id}.json`));
    const score = scoreVisionResponse({ content: c.response.content, expected: rubrics[c.id] });
    assert(isDeepStrictEqual(score, c.score), `Saved grade changed: ${dir}/${c.id}`);
  }
  const sum = key => cases.reduce((n, c) => n + (c.response.usage?.[key] || 0), 0);
  const group = key => Object.fromEntries([...new Set(cases.map(c => key(c)))].map(value => {
    const group = cases.filter(c => key(c) === value);
    return [value, { cases: group.length, passes: group.filter(c => c.score.success).length, meanScore: group.reduce((n, c) => n + c.score.ratio, 0) / group.length }];
  }));
  const latency = cases.map(c => c.latencyMs.total).sort((a, b) => a - b);
  const row = {
    label: labels[cases[0].model], model: cases[0].model, source, date: cases[0].createdAt.slice(0, 10), cases: cases.length, errors: 0,
    passes: cases.filter(c => c.score.success).length,
    meanScore: cases.reduce((n, c) => n + c.score.ratio, 0) / cases.length,
    meanLatencyMs: latency.reduce((a, b) => a + b, 0) / latency.length,
    medianLatencyMs: (latency[49] + latency[50]) / 2, p95LatencyMs: latency[94],
    costRecords: cases.filter(c => typeof c.response.usage?.cost === 'number').length,
    costUsd: sum('cost'), promptTokens: sum('prompt_tokens'), completionTokens: sum('completion_tokens'),
    cachedTokens: cases.reduce((n, c) => n + (c.response.usage?.prompt_tokens_details?.cached_tokens || 0), 0),
    reasoningTokens: cases.reduce((n, c) => n + (c.response.usage?.completion_tokens_details?.reasoning_tokens || 0), 0),
    casesReportingReasoning: cases.filter(c => (c.response.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0).length,
    sixSections: cases.filter(c => c.score.sectionCount === 6).length,
    emptyOutputs: cases.filter(c => !c.response.content.trim()).length,
    lengthLimited: cases.some(c => c.response.finishReason != null) ? cases.filter(c => c.response.finishReason === 'length').length : null,
    providers: group(c => c.response.provider || 'not recorded'),
    byDifficulty: group(c => c.question.difficulty.slug), byCategory: group(c => c.question.category),
  };
  assert.equal(row.costRecords, 100, `${dir} is missing cost evidence`);
  if (dir.startsWith('2026-08-22')) {
    const summary = await json(`${source}/summary.json`);
    assert.equal(row.passes, summary.overall.successes);
    assert(Math.abs(row.meanScore - summary.overall.meanScore) < 1e-12);
    assert.equal(row.meanLatencyMs, summary.overall.meanLatencyMs);
  }
  rows.push(row);
  casesByModel[row.model] = cases.map(c => ({ id: c.id, category: c.question.category, difficulty: c.question.difficulty.slug, pass: c.score.success, ratio: c.score.ratio, criticalFailures: c.score.criticalFailures }));
}
const regression = { verifiedHistoricalModels: 6, verifiedHistoricalResponses: 600, sourceRevision: REV, promptImageAndQuestionMatches: true, savedScoresExactlyReproduced: true };
const lingCases = casesByModel['inclusionai/ling-3.0-flash-vl'];
const pairwise = lingCases ? Object.fromEntries(rows.filter(r => r.model !== 'inclusionai/ling-3.0-flash-vl').map(r => {
  const peer = casesByModel[r.model];
  return [r.model, {
    bothPass: lingCases.filter((c, i) => c.pass && peer[i].pass).length,
    lingOnlyPass: lingCases.filter((c, i) => c.pass && !peer[i].pass).length,
    peerOnlyPass: lingCases.filter((c, i) => !c.pass && peer[i].pass).length,
    neitherPass: lingCases.filter((c, i) => !c.pass && !peer[i].pass).length,
  }];
})) : null;
const allQwenFailIds = ids.filter((id, i) => rows.filter(r => r.model.startsWith('qwen/')).every(r => !casesByModel[r.model][i].pass));
const report = { date: '2026-10-07', protocol: 'production screenshot description, temperature 0, max_tokens 800, unchanged August scorer', regression, rows, casesByModel, pairwise, allQwenFailIds,
  lingPassesOnSharedQwenFailures: lingCases ? lingCases.filter(c => c.pass && allQwenFailIds.includes(c.id)).map(c => c.id) : null };
await mkdir(OUT, { recursive: true });
if (!historicalOnly) {
  const preflightSource = `${ROOT}/results/2026-10-07-openrouter-ling30-budget-preflight_inclusionai_ling-3.0-flash-vl_production`;
  const preflight = await json(`${preflightSource}/001.json`);
  assert.equal(preflight.error, null);
  assert.equal(preflight.image.sha256, manifest.images['001']);
  assert.equal(preflight.request.systemPrompt, VISION_SYSTEM_PROMPT);
  const ling = rows.find(r => r.model === 'inclusionai/ling-3.0-flash-vl');
  const campaign = { date: report.date, fullRun: ling.source, preflight: preflightSource,
    fullRunRequests: 100, preflightRequests: 1, inferenceResponses: 101, apiErrors: 0, retries: 0,
    fullRunCostUsd: ling.costUsd, preflightCostUsd: preflight.response.usage.cost,
    totalCostUsd: ling.costUsd + preflight.response.usage.cost,
    concurrency: 2, providerRouting: 'automatic; all 101 responses from Novita',
    credentialsExcluded: true, rawStreamsChecked: 100 };
  await writeFile(`${OUT}/campaign.json`, JSON.stringify(campaign, null, 2) + '\n');
}
for (const [name, value] of Object.entries({ 'comparison.json': report, 'regression.json': regression, 'manifest.json': manifest, 'rubrics.json': rubrics })) {
  await writeFile(`${OUT}/${name}`, JSON.stringify(value, null, 2) + '\n');
}
const ranked = [...rows].sort((a, b) => b.passes - a.passes);
const md = '# Ling 3.0 Flash VL versus budget vision models\n\n' +
  (historicalOnly ? 'Historical-only audit; no Ling result included.\n\n' : '100 matched screenshots per model. Only Ling is a new October 7 run; Qwen rows retain August 22 responses.\n\n') +
  '| Model | Date | Passes / 100 | Mean rubric | Mean latency | Completion tokens | Reported cost |\n' +
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |\n' +
  ranked.map(r => `| ${r.label} | ${r.date} | ${r.passes} | ${(r.meanScore * 100).toFixed(1)}% | ${(r.meanLatencyMs / 1000).toFixed(2)}s | ${r.completionTokens} | $${r.costUsd.toFixed(7)} |`).join('\n') +
  '\n\nAll 600 historical case scores exactly reproduced. Screenshot hashes, prompts, defaults, questions, and August rubric/scorer bytes match.\n\n' +
  'Costs use all 100 API usage.cost records per row. Missing historical finish reasons are null, not a claim of zero truncations. Six-section coverage is separate from the historical binary pass gate.\n';
await writeFile(`${OUT}/report.md`, md);
console.log(JSON.stringify(rows.map(({ model, passes, meanScore, meanLatencyMs, costUsd, sixSections }) => ({ model, passes, meanScore, meanLatencyMs, costUsd, sixSections })), null, 2));
