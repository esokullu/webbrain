#!/usr/bin/env node
// Reconstruct the August full-tier inputs from their pinned source checkout.
// Historical runs omitted request bodies; this snapshot makes future reruns auditable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const revision = '7182c21f';
const sourceCommit = execFileSync('git', ['rev-parse', revision], { cwd: root, encoding: 'utf8' }).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const source = path => execFileSync('git', ['show', `${sourceCommit}:${path}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const scratchRoot = join(root, '.build');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, 'frontier-replay-'));
writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n');
const sourceHashes = {};
for (const path of ['test/llm/lib/build-payload.mjs',
  'src/chrome/src/agent/tools.js', 'src/chrome/src/agent/adapters.js',
  'src/firefox/src/agent/tools.js', 'src/firefox/src/agent/adapters.js']) {
  const bytes = source(path);
  sourceHashes[path] = sha256(bytes);
  const target = join(scratch, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
assert(!process.env.WB_FREEZE_BASELINE, 'Clear WB_FREEZE_BASELINE before preparing the full-tier replay.');
const { buildPayload } = await import(pathToFileURL(join(scratch, 'test/llm/lib/build-payload.mjs')));
const firstTurn = {}, tools = {}, cases = {};
for (let n = 1; n <= 100; n++) {
  const id = String(n).padStart(3, '0');
  const questionPath = `test/llm/questions/${id}.json`;
  const expectedPath = `test/llm/expected/${id}.json`;
  const questionBytes = source(questionPath), expectedBytes = source(expectedPath);
  sourceHashes[questionPath] = sha256(questionBytes);
  sourceHashes[expectedPath] = sha256(expectedBytes);
  const question = JSON.parse(questionBytes), expected = JSON.parse(expectedBytes);
  // The runner selects ids and writes case labels from the live question directory.
  // Refuse a replay whose labels would disagree with the archived request.
  assert.deepEqual(JSON.parse(readFileSync(join(root, questionPath), 'utf8')), question, `Question drift: ${id}`);
  const payload = buildPayload(question, { browser: 'chrome', tier: 'full' });
  tools[question.mode] ||= payload.tools;
  assert.deepEqual(payload.tools, tools[question.mode]);
  firstTurn[id] = { mode: question.mode, temperature: question.mode === 'ask' ? 0.3 : 0.15,
    max_tokens: 4096, messages: payload.messages, expected };
  cases[id] = { question, expected };
}
assert.equal(tools.act.length, 48);
const snapshot = {
  // Shared loader retains this historical schema name for all tiers.
  schema: 'webbrain.compact-replay.v1', browser: 'chrome', tier: 'full',
  meta: { sourceCommit, sourceRun: '2026-08-02-full-suite-consensus', sourceHashes,
    note: 'Reconstructed from the pinned 7182c21f full-tier source, not saved historical requests. No May frozen baseline or prompt overrides.' },
  tools, firstTurn, scenarios: {},
};
const path = join(here, 'freeze/full-replay-7182c21f.json');
const bytes = JSON.stringify(snapshot, null, 2) + '\n';
writeFileSync(path, bytes);
const output = join(here, 'analysis/2026-10-06-ling31-flash');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'rubrics.json'), JSON.stringify({ sourceCommit, sourceHashes, cases }, null, 2) + '\n');
console.log(JSON.stringify({ path, sourceCommit, sha256: sha256(bytes), cases: 100,
  toolCounts: Object.fromEntries(Object.entries(tools).map(([mode, set]) => [mode, set.length])) }, null, 2));
