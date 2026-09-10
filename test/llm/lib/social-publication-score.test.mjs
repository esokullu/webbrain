import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { curated } from '../social-publication-cases.mjs';
import { normalizePublicationContract, publicationMediaMatches } from '../../../src/chrome/src/agent/social-publish-contract.js';
import { scoreContract, snapshotFor, distribution } from './social-publication-score.mjs';

const normalized = id => {
  const fixture = curated.find(c => c.id === id);
  return normalizePublicationContract(fixture.expected, fixture.sources);
};
test('reviewed gold contracts are valid and positive snapshots satisfy their constraints', () => {
  assert.equal(new Set(curated.map(c => c.id)).size, curated.length);
  for (const fixture of curated) {
    const golden = normalized(fixture.id);
    assert(scoreContract(golden, golden).pass, fixture.id);
    for (const action of golden.actions) {
      const snapshot = snapshotFor(action, fixture);
      action.posts.forEach((post, i) => assert(publicationMediaMatches(post.media, snapshot.posts[i]), fixture.id));
    }
  }
});
test('scorer distinguishes unsafe publication, missing obligations and media loss', () => {
  assert(scoreContract(normalized('exact-en'), normalized('inspect')).unsafeProposal);
  assert(!scoreContract(normalized('exact-en'), normalized('both')).pass);
  assert(!scoreContract(normalized('exact-en'), normalized('one-image')).pass);
  assert(!scoreContract(normalized('either'), normalized('both')).pass);
  assert(!scoreContract(normalized('fallback-either'), normalized('fallback-unavailable')).pass);
  const changed = structuredClone(normalized('compatibility'));
  changed.actions[0].posts[0].body.value = '1 A 👨👩👧';
  assert(!scoreContract(changed, normalized('compatibility')).pass);
});
test('action IDs, unordered all branches and redundant media clauses do not change scores', () => {
  const expected = normalized('both'), actual = structuredClone(expected);
  actual.actions[0].id = 'first'; actual.actions[1].id = 'second';
  actual.requirements.items = ['second', 'first'];
  assert(scoreContract(actual, expected).pass);
  const image = normalized('one-image'), redundant = structuredClone(image);
  redundant.actions[0].posts[0].media.items.reverse();
  redundant.actions[0].posts[0].media.items.push({ kind: 'count', type: 'video', format: null, min: 0, max: 0 });
  assert(scoreContract(redundant, image).pass);
});
test('latency quantiles use nearest rank and preserve the first-call distinction', () => {
  assert.deepEqual(distribution([30, 10, 20]), { n: 3, p50Ms: 20, p95Ms: 30, maxMs: 30, meanMs: 20 });
});
test('runner exercises actual provider transport, repair loop and audits against an isolated fixture server', async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-social-bench-test-'));
  const requests = [], attempts = new Map();
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    const input = JSON.parse(body.messages[1].content);
    let content;
    if (body.messages[0].content.startsWith('Compile')) {
      const fixture = curated.find(c => c.sources.request === input.sources.request);
      const attempt = (attempts.get(fixture.id) || 0) + 1; attempts.set(fixture.id, attempt);
      content = fixture.id === 'exact-en' && attempt === 1 ? '{}' : JSON.stringify(fixture.expected);
    } else content = JSON.stringify({ key: input.key, actionId: input.action.id, authorized: !input.sources.request.startsWith('Do not'), reason: 'Synthetic server response.' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let logs = '';
    const child = spawn(process.execPath, ['test/llm/run-social-publication.mjs', '--base', `http://127.0.0.1:${server.address().port}/v1`, '--model', 'fixture-model', '--only', 'inspect,exact-en,named-alt,deny-inspect', '--output', output], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, logs);
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
    assert.equal(summary.completed, true); assert.equal(summary.compiler.cases, 3); assert.equal(summary.compiler.passed, 3);
    assert.equal(summary.compiler.firstValid, 2); assert.equal(summary.compiler.repairs, 1);
    assert.equal(summary.audit.positive, 2); assert.equal(summary.audit.negative, 1); assert.equal(summary.audit.falseAllows, 0);
    assert.equal(requests.length, 7); assert(requests.every(r => r.model === 'fixture-model' && !r.tools));
    assert(requests.every(r => [4096, 800].includes(r.max_tokens)));
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(output, { recursive: true, force: true }); }
});
