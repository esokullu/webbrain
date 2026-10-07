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
    model: cases[0].model, source, date: cases[0].createdAt.slice(0, 10), cases: cases.length, errors: 0,
    passes: cases.filter(c => c.score.success).length,
    meanScore: cases.reduce((n, c) => n + c.score.ratio, 0) / cases.length,
    meanLatencyMs: latency.reduce((a, b) => a + b, 0) / latency.length,
    medianLatencyMs: (latency[49] + latency[50]) / 2, p95LatencyMs: latency[94],
    costRecords: cases.filter(c => typeof c.response.usage?.cost === 'number').length,
    costUsd: sum('cost'), promptTokens: sum('prompt_tokens'), completionTokens: sum('completion_tokens'),
    cachedTokens: cases.reduce((n, c) => n + (c.response.usage?.prompt_tokens_details?.cached_tokens || 0), 0),
    reasoningTokens: cases.reduce((n, c) => n + (c.response.usage?.completion_tokens_details?.reasoning_tokens || 0), 0),
    sixSections: cases.filter(c => c.score.sectionCount === 6).length,
    emptyOutputs: cases.filter(c => !c.response.content.trim()).length,
    lengthLimited: cases.filter(c => c.response.finishReason === 'length').length,
    providers: group(c => c.response.provider || 'not recorded'),
    byDifficulty: group(c => c.question.difficulty.slug), byCategory: group(c => c.question.category),
  };
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
const report = { date: '2026-10-07', protocol: 'production screenshot description, temperature 0, max_tokens 800, unchanged August scorer', regression, rows, casesByModel };
await mkdir(OUT, { recursive: true });
for (const [name, value] of Object.entries({ 'comparison.json': report, 'regression.json': regression, 'manifest.json': manifest, 'rubrics.json': rubrics })) {
  await writeFile(`${OUT}/${name}`, JSON.stringify(value, null, 2) + '\n');
}
console.log(JSON.stringify(rows.map(({ model, passes, meanScore, meanLatencyMs, costUsd, sixSections }) => ({ model, passes, meanScore, meanLatencyMs, costUsd, sixSections })), null, 2));
