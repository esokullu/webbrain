#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const reference = '2026-09-07-qwen3.5-4b-compact-full-v2_chrome_qwen3.5-4b_compact';
const ask = JSON.parse(readFileSync(join(root, 'freeze/compact-ask-tools-2026-09-07.json'), 'utf8'));
const load = folder => readdirSync(join(root, folder, reference)).filter(f => /^\d{3}\.json$/.test(f))
  .sort().map(f => JSON.parse(readFileSync(join(root, folder, reference, f), 'utf8')));
const first = load('results');
const scenarios = load('results-scenarios');
const tools = { act: first[0].request.tools, ask: ask.tools };
for (const row of first) {
  if (JSON.stringify(row.request.tools) !== JSON.stringify(tools[row.mode])) throw new Error(`Tool-set mismatch: ${row.id}`);
}
const snapshot = {
  schema: 'webbrain.compact-replay.v1', browser: 'chrome', tier: 'compact',
  meta: { sourceRun: reference, askToolsSourceCommit: ask.sourceCommit,
    note: 'Messages and Act tools replay the saved September 7 run. Ask tools come from the September 7 source (15 tools). The saved rubric and skipped set are retained.' },
  tools,
  firstTurn: Object.fromEntries(first.map(row => [row.id, { mode: row.mode, temperature: row.request.temperature,
    max_tokens: row.request.max_tokens, messages: row.request.messages }])),
  scenarios: Object.fromEntries(scenarios.map(row => [row.id, row.skipped
    ? { mode: row.mode, skipped: row.skipped, expected: row.expected }
    : { mode: row.mode, temperature: row.mode === 'ask' ? 0.3 : 0.15,
      max_tokens: 4096, messages: row.request.messages, expected: row.expected }])),
};
for (const row of scenarios.filter(r => !r.skipped)) {
  if (row.request.tools_summary.count !== tools[row.mode].length) throw new Error(`Scenario tool-count mismatch: ${row.id}`);
}
const path = join(root, 'freeze/compact-replay-2026-09-07.json');
const bytes = JSON.stringify(snapshot, null, 2) + '\n';
writeFileSync(path, bytes);
console.log(JSON.stringify({ path, sha256: createHash('sha256').update(bytes).digest('hex'),
  firstTurn: first.length, scenarios: scenarios.length, skipped: scenarios.filter(r => r.skipped).length }));
