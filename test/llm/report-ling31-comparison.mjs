#!/usr/bin/env node
// Offline, auditable comparison against the pinned August full-tier cohort.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepEqual } from './lib/score.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '../..');
const out = join(here, 'analysis/2026-10-06-ling31-flash');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repoPath = path => relative(root, path).replaceAll('\\', '/');
const replayPath = join(here, 'freeze/full-replay-7182c21f.json');
const replay = read(replayPath), rubrics = read(join(out, 'rubrics.json'));
const historical = read(join(here, 'results/2026-08-02-full-suite-consensus.json'));
assert.equal(replay.meta.sourceCommit, rubrics.sourceCommit);
const resultDirs = readdirSync(join(here, 'results'));
const labels = {
  'deepseek/deepseek-v4-flash-0731': 'DeepSeek V4 Flash 0731',
  'tencent/hy3': 'Tencent HY3', 'z-ai/glm-5.2': 'GLM-5.2',
  'poolside/laguna-xs-2.1': 'Poolside Laguna XS 2.1',
  'inclusionai/ling-3.1-flash': 'Ling 3.1 Flash',
  'minimax/minimax-m3': 'MiniMax M3',
};
const selected = new Set(Object.keys(labels).filter(model => model !== 'minimax/minimax-m3'));
const ids = Object.keys(replay.firstTurn).sort();
assert.equal(ids.length, 100);
const stable = value => value === null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(stable)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
const signature = call => JSON.stringify(stable(call || null));

// Validate precisely the JSON Schema keywords present in this archived tool set.
// Unknown validation keywords fail closed so future schema changes cannot slip by.
const keywords = new Set(['type', 'properties', 'required', 'items', 'enum', 'minimum', 'maxLength', 'description']);
function checkSchema(schema) {
  for (const key of Object.keys(schema)) assert(keywords.has(key), `Unsupported schema keyword: ${key}`);
  Object.values(schema.properties || {}).forEach(checkSchema);
  if (schema.items) checkSchema(schema.items);
}
for (const tools of Object.values(replay.tools)) tools.forEach(tool => checkSchema(tool.function.parameters));
function validate(value, schema, path = '$') {
  const errors = [];
  const types = { object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray, string: v => typeof v === 'string', boolean: v => typeof v === 'boolean',
    number: v => typeof v === 'number' && Number.isFinite(v), integer: Number.isInteger };
  if (schema.type && !types[schema.type]?.(value)) return [`${path}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.some(option => deepEqual(option, value))) errors.push(`${path}: invalid enum`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
  if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${path}: maxLength exceeded`);
  for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing`);
  for (const [key, child] of Object.entries(schema.properties || {})) {
    if (Object.hasOwn(value, key)) errors.push(...validate(value[key], child, `${path}.${key}`));
  }
  if (schema.items) value.forEach((item, index) => errors.push(...validate(item, schema.items, `${path}[${index}]`)));
  return errors;
}

const sources = historical.results.map(row => {
  const resultDir = row.resultDir || resultDirs.find(dir => dir.startsWith('2026-08-02-')
    && !dir.includes('-7182') && dir.endsWith(`_chrome_${row.model.replace(/[^\w.-]+/g, '_')}`));
  assert(resultDir, `Missing historical results: ${row.model}`);
  return { model: row.model, resultDir, historical: row, date: '2026-08-02' };
});
const fresh = { model: 'inclusionai/ling-3.1-flash', date: '2026-10-06', fresh: true,
  resultDir: '2026-10-06-openrouter-ling31-flash-full-7182_chrome_inclusionai_ling-3.1-flash' };
const audit = [];
function load(source, { caseIds = ids, recordAudit = true } = {}) {
  const dir = join(here, 'results', source.resultDir), summary = read(join(dir, 'summary.json'));
  assert.equal(readdirSync(dir).filter(file => /^\d{3}\.json$/.test(file)).length, 100);
  assert.equal(summary.model, source.model);
  assert.equal(summary.cases, 100);
  assert.equal(summary.tier, 'full');
  assert.equal(summary.freeze, null);
  assert.equal(summary.modeOverride, null);
  assert.equal(summary.reasoningEffort, null);
  assert.equal(summary.chatTemplateCompat, 'off');
  assert.equal(summary.structuredToolsSent, true);
  if (source.fresh) {
    assert.equal(summary.replay.sha256, hash(readFileSync(replayPath)));
    assert.equal(summary.replay.sourceCommit, replay.meta.sourceCommit);
    assert.equal(summary.saveRequest, true);
  }
  const row = { model: source.model, label: labels[source.model] || source.model, date: source.date,
    source: repoPath(dir), fresh: !!source.fresh, cases: caseIds.length, errors: 0, responses: 0,
    emittedToolCalls: 0, nativeToolCalls: 0, schemaValidToolCalls: 0, idealToolMatches: 0, exactIdealMatches: 0,
    promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, reasoningTokens: 0,
    costRecords: 0, usageCost: 0, lengthLimited: 0, contentFallbackCalls: 0,
    accessibilityTreeFirstCalls: 0, attempts: 0, providers: {}, byTool: {}, schemaErrors: [] };
  const records = [], latencies = [];
  for (const id of caseIds) {
    const path = join(dir, `${id}.json`), bytes = readFileSync(path), record = JSON.parse(bytes);
    const archived = rubrics.cases[id].question, saved = replay.firstTurn[id];
    assert.equal(record.id, id);
    assert.equal(record.user, archived.user);
    assert.equal(record.mode, archived.mode);
    assert.deepEqual(record.tab, archived.tab);
    if (source.fresh) {
      assert.deepEqual(record.request, { model: source.model, temperature: saved.temperature,
        max_tokens: saved.max_tokens, messages: saved.messages, tools: replay.tools[saved.mode] }, `Request drift ${id}`);
      assert(!/^HTTP 40[13]:/.test(record.error || ''), 'Authentication failures cannot be scored.');
      assert(record.error || record.response?.choices?.length, `Missing raw API response ${id}`);
      if (record.response) {
        assert.equal(record.response.model, source.model, `Unexpected response model ${id}`);
        assert.deepEqual(record.usage, record.response.usage);
      }
    }
    row.attempts += record.attempts || 1;
    if (record.error) row.errors++;
    else { row.responses++; latencies.push(record.latencyMs); }
    const call = record.firstToolCall || null, ideal = rubrics.cases[id].expected.idealFirstToolCall;
    let schemaErrors = [];
    if (call) {
      row.emittedToolCalls++;
      if (record.toolCallSource === 'tool_calls') row.nativeToolCalls++;
      if (source.fresh) {
        const native = record.response?.choices?.[0]?.message?.tool_calls?.[0];
        if (record.toolCallSource === 'tool_calls') {
          assert(native, `Missing native call ${id}`);
          try {
            const args = typeof native.function.arguments === 'string' ? JSON.parse(native.function.arguments) : native.function.arguments;
            assert.deepEqual(call, { name: native.function.name, args });
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            schemaErrors.push('Malformed native arguments JSON');
          }
        }
      }
      const tool = replay.tools[saved.mode].find(tool => tool.function.name === call.name);
      schemaErrors.push(...(tool ? validate(call.args, tool.function.parameters) : ['Unknown tool name']));
      if (!schemaErrors.length) row.schemaValidToolCalls++;
      else row.schemaErrors.push({ id, call, errors: schemaErrors });
      if (!record.error && call.name === ideal.name) {
        row.idealToolMatches++;
        if (deepEqual(call.args, ideal.args)) row.exactIdealMatches++;
      }
      if (call.name === 'get_accessibility_tree') row.accessibilityTreeFirstCalls++;
    }
    const toolName = call?.name || (record.error ? '(error)' : '(no-tool)');
    row.byTool[toolName] = (row.byTool[toolName] || 0) + 1;
    if (record.finishReason === 'length') row.lengthLimited++;
    if (record.toolCallSource === 'content_fallback') row.contentFallbackCalls++;
    if (typeof record.usage?.cost === 'number') { row.costRecords++; row.usageCost += record.usage.cost; }
    row.promptTokens += record.usage?.prompt_tokens || 0;
    row.cachedPromptTokens += record.usage?.prompt_tokens_details?.cached_tokens || 0;
    row.completionTokens += record.usage?.completion_tokens || 0;
    row.reasoningTokens += record.usage?.completion_tokens_details?.reasoning_tokens || 0;
    if (record.response?.provider) row.providers[record.response.provider] = (row.providers[record.response.provider] || 0) + 1;
    records.push({ id, call, name: toolName, signature: record.error ? `error:${source.model}:${id}` : signature(call) });
    if (recordAudit) audit.push({ model: source.model, id, path: repoPath(path), sha256: hash(bytes),
      requestSha256: record.request ? hash(JSON.stringify(record.request)) : null,
      rubricSha256: replay.meta.sourceHashes[`test/llm/expected/${id}.json`] });
  }
  if (caseIds.length === 100) {
    assert.equal(row.errors, summary.errors);
    assert.equal(row.emittedToolCalls, summary.withToolCall);
  }
  latencies.sort((a, b) => a - b);
  row.medianLatencyMs = latencies.length ? (latencies[Math.floor((latencies.length - 1) / 2)] + latencies[Math.floor(latencies.length / 2)]) / 2 : null;
  row.p95LatencyMs = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null;
  row.cachedPromptSharePct = row.promptTokens ? row.cachedPromptTokens / row.promptTokens * 100 : null;
  if (source.historical && caseIds.length === 100) for (const metric of ['emittedToolCalls', 'schemaValidToolCalls', 'idealToolMatches', 'exactIdealMatches']) {
    assert.equal(row[metric], source.historical[metric], `Historical ${metric} regression: ${source.model}`);
  }
  return { source, row, records };
}
function consensus(cohort) {
  const caseCount = cohort[0].records.length;
  assert(caseCount > 0);
  cohort.forEach(entry => assert.equal(entry.records.length, caseCount));
  return cohort.map(entry => {
    let exact = 0, names = 0;
    for (const peer of cohort.filter(peer => peer !== entry)) {
      for (let i = 0; i < caseCount; i++) {
        if (entry.records[i].signature === peer.records[i].signature) exact++;
        if (entry.records[i].name === peer.records[i].name) names++;
      }
    }
    return { ...entry.row, exactActionMatches: exact, toolNameMatches: names,
      comparisons: caseCount * (cohort.length - 1),
      exactActionConsensusPct: +(exact * 100 / (caseCount * (cohort.length - 1))).toFixed(1),
      toolNameConsensusPct: +(names * 100 / (caseCount * (cohort.length - 1))).toFixed(1) };
  }).sort((a, b) => b.exactActionMatches - a.exactActionMatches || b.toolNameMatches - a.toolNameMatches)
    .map((row, index) => ({ rank: index + 1, ...row }));
}
const oldCohort = sources.map(source => load(source)), reproduced = consensus(oldCohort);
for (const row of reproduced) {
  const old = historical.results.find(old => old.model === row.model);
  assert.equal(row.exactActionConsensusPct, old.exactActionConsensusPct, `Historical exact consensus: ${row.model}`);
  assert.equal(row.toolNameConsensusPct, old.toolNameConsensusPct, `Historical tool consensus: ${row.model}`);
}
writeFileSync(join(out, 'historical-regression.json'), JSON.stringify({ sourceCommit: replay.meta.sourceCommit,
  validatedModels: 13, cases: 1300, note: 'All saved exact/tool consensus and emitted/valid/ideal counts reproduced from raw case files.',
  results: reproduced }, null, 2) + '\n');
if (process.argv.includes('--historical-only')) {
  console.log('Historical 13-model consensus, schema validity, and ideal counts reproduced.');
} else {
  const cohort = [...oldCohort, load(fresh)];
  const ling = cohort.at(-1);
  const campaign = read(join(out, 'campaign.json'));
  const finalDir = join(here, 'results', fresh.resultDir);
  const recoveries = [campaign.recovery, ...(campaign.additionalRecoveries || [])];
  const recoveryRecords = recoveries.flatMap(pass => pass.selectedIds.map(id =>
    read(join(pass.archiveDir ? join(out, pass.archiveDir) : finalDir, `${id}.json`))));
  const firstPassRecords = ids.map(id => read(join(out, 'first-pass', `${id}.json`)));
  for (const record of firstPassRecords) {
    const saved = replay.firstTurn[record.id];
    assert.deepEqual(record.request, { model: fresh.model, temperature: saved.temperature,
      max_tokens: saved.max_tokens, messages: saved.messages, tools: replay.tools[saved.mode] });
  }
  const initial = read(join(out, 'preflight/001-initial-429.json'));
  const retried = read(join(out, 'preflight/001-retried-429.json'));
  const diagnostics = readdirSync(join(out, 'preflight')).filter(file => file.endsWith('.json'))
    .map(file => read(join(out, 'preflight', file))).filter(record => record.diagnosticOnly);
  const count429 = record => (record.retryErrors || []).filter(error => error.error.startsWith('HTTP 429:')).length
    + (record.error?.startsWith('HTTP 429:') ? 1 : 0);
  const diagnosticRequests = initial.attempts + retried.attempts + diagnostics.length;
  const benchmarkRequests = firstPassRecords.reduce((sum, record) => sum + record.attempts, 0)
    + recoveryRecords.reduce((sum, record) => sum + record.attempts, 0);
  const campaignMetrics = { firstPassResponses: firstPassRecords.filter(record => !record.error).length,
    firstPassErrors: firstPassRecords.filter(record => record.error).length,
    recoveryCaseSelections: recoveryRecords.length,
    uniqueRecoveryCases: new Set(recoveries.flatMap(pass => pass.selectedIds)).size,
    benchmarkRequests, diagnosticRequests,
    totalApiRequests: benchmarkRequests + diagnosticRequests,
    http429Responses: [...firstPassRecords, ...recoveryRecords, initial, retried].reduce((sum, record) => sum + count429(record), 0)
      + diagnostics.filter(record => record.status === 429).length,
    recoveryWallTimeMs: recoveries.reduce((sum, pass) => sum + read(join(pass.archiveDir ? join(out, pass.archiveDir) : finalDir, 'summary.json')).totalLatencyMs, 0),
    firstPassWallTimeMs: read(join(out, 'first-pass/summary.json')).totalLatencyMs,
    recoveryPasses: recoveries.length,
    concurrency: campaign.recovery.concurrency, retryDelayMs: campaign.recovery.retryDelayMs,
    retryMax: campaign.recovery.retryMax,
    latencyNote: 'Inference latency uses each successful final HTTP attempt, including network time but excluding failed attempts and backoff. Wall time is reported separately.',
  };
  for (const folder of ['first-pass', 'preflight', ...recoveries.map(pass => pass.archiveDir).filter(Boolean)]) {
    for (const file of readdirSync(join(out, folder)).filter(file => file.endsWith('.json'))) {
      const path = join(out, folder, file), bytes = readFileSync(path);
      audit.push({ track: folder, path: repoPath(path), sha256: hash(bytes) });
    }
  }
  const complete = ling.row.responses === 100 && ling.row.errors === 0;
  // A rejected request is availability evidence, not a model action to rank.
  // Retain the unchanged historical pool when the new run lacks full coverage.
  const unavailable = { rank: null, ...ling.row, exactActionMatches: null, toolNameMatches: null,
    comparisons: null, exactActionConsensusPct: null, toolNameConsensusPct: null,
    idealToolMatches: null, exactIdealMatches: null, medianLatencyMs: null, p95LatencyMs: null,
    usageCost: null, cachedPromptSharePct: null };
  const results = complete ? consensus(cohort) : [...reproduced, unavailable];
  const availableIds = ids.filter(id => !read(join(finalDir, `${id}.json`)).error);
  const matchedSubset = !complete && availableIds.length ? {
    cases: availableIds.length, caseIds: availableIds,
    comparisonsPerModel: availableIds.length * 13,
    note: 'Availability-selected, non-random subset. Every model is rescored on exactly these same cases with all 14 peers in the pool. These figures cannot be compared numerically with the original full-suite percentages. Cost and latency also use only the matched cases.',
    results: consensus([...sources, fresh].map(source => load(source, { caseIds: availableIds, recordAudit: false }))),
  } : null;
  const pairs = oldCohort.map(peer => {
    let exact = 0, names = 0;
    for (let i = 0; i < 100; i++) {
      if (ling.records[i].signature === peer.records[i].signature) exact++;
      if (ling.records[i].name === peer.records[i].name) names++;
    }
    return { model: peer.row.model, exactActionMatches: complete ? exact : null,
      toolNameMatches: complete ? names : null, cases: complete ? 100 : null };
  });
  const report = { date: fresh.date, sourceCommit: replay.meta.sourceCommit, browser: 'chrome', tier: 'full',
    casesPerModel: 100, models: 14, historicalModels: 13, freshModels: 1,
    freshRequests: benchmarkRequests, campaign: campaignMetrics,
    status: complete ? 'complete' : 'inference-incomplete', consensusModels: complete ? 14 : 13,
    freshResponses: ling.row.responses, freshErrors: ling.row.errors,
    replayPath: repoPath(replayPath), replaySha256: hash(readFileSync(replayPath)), toolCounts: { act: 48 },
    method: complete
      ? 'Leave-one-out exact action (recursive sorted keys only; all values preserved) and tool-name agreement. No-tool matches no-tool; errors never match. Each model has 13 peers and 1300 comparisons. Original 13-model scores reproduced before adding Ling.'
      : 'Ling lacks 100 inference responses and is excluded from consensus. Its quality, inference latency, and cost metrics are N/A. The original 13-model pool and 1200 comparisons per historical model are retained unchanged; all historical scores reproduced from raw cases.',
    caveat: 'Historical bodies were omitted; Ling inputs are reconstructed from the pinned source. Provider conditions and test dates differ. Consensus is not ground truth and this is first-action-only text input.',
    results, textOnlyComparison: results.filter(row => selected.has(row.model)),
    additionalReference: results.find(row => row.model === 'minimax/minimax-m3'),
    matchedSubset, lingPairwise: pairs };
  writeFileSync(join(out, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, 'audit.json'), JSON.stringify({ replaySha256: report.replaySha256, cases: audit }, null, 2) + '\n');
  const pct = value => value == null ? 'N/A' : value.toFixed(1) + '%';
  const seconds = value => value == null ? 'N/A' : (value / 1000).toFixed(2) + 's';
  const cost = value => value == null ? 'N/A' : '$' + value.toFixed(3);
  const table = rows => '| Model | Exact consensus | Tool consensus | Valid / emitted | Ideal tool | Exact ideal | Median | p95 | Cost |\n'
    + '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n'
    + rows.map(row => `| ${row.label} | ${pct(row.exactActionConsensusPct)} | ${pct(row.toolNameConsensusPct)} | ${row.schemaValidToolCalls} / ${row.emittedToolCalls} | ${row.idealToolMatches ?? 'N/A'} | ${row.exactIdealMatches ?? 'N/A'} | ${seconds(row.medianLatencyMs)} | ${seconds(row.p95LatencyMs)} | ${cost(row.usageCost)} |`).join('\n');
  writeFileSync(join(out, 'report.md'), `# Ling 3.1 Flash: pinned full-tier comparison\n\n${report.method}\n\n${report.caveat}\n\n${table(report.textOnlyComparison)}\n\nFull cohort (${report.consensusModels} scored models):\n\n${table(results)}\n`
    + (matchedSubset ? `\n## Matched available cases (${matchedSubset.cases})\n\n${matchedSubset.note}\n\n${table(matchedSubset.results.filter(row => selected.has(row.model) || row.model === 'minimax/minimax-m3'))}\n` : ''));
  console.log(JSON.stringify(report.textOnlyComparison, null, 2));
}
