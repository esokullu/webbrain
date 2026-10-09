import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const browser of ['chrome', 'firefox']) {
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  const { rejectedCompletionRecovery } = await import(`../src/${browser}/src/agent/completion-recovery.js`);
  const { validateToolArguments } = await import(`../src/${browser}/src/agent/tool-arguments.js`);
  test(`${browser}: model pin survives global selection, continuation and restart; mismatches do not touch tabs`, async () => {
    const stored = {}, observed = []; let tabTouches = 0, seq = 0;
    const provider = {model: 'inclusionai/ling-3.1-flash'};
    const agent = {isRunning: () => false, strictSecretMode: true,
      providerManager: {getProvider: id => id === 'webbrain_me' ? provider : null,
        getActive: () => ({model: 'webbrain-cloud 1.0'})},
      processMessage: async (_tab, _task, update, _mode, _files, options) => {
        observed.push(options.providerId);
        update('tool_result', {name: 'read_page', result: {text: 'private page text'}});
        update('tool_result', {name: 'get_interactive_elements', result: [{text: 'private label'}]});
        update('tool_result', {name: 'click_ax', result: {success: false, error: 'private error'}});
        options.onRunFinished('done'); return 'Read successfully';
      }};
    const api = {storage: {session: {get: async key => ({[key]: stored[key]}), set: async row => Object.assign(stored, row)}},
      tabs: {get: async () => {tabTouches++; return {id: 7, url: 'https://example.com'};},
        query: async () => [{id: 7, url: 'https://example.com'}], update: async () => {tabTouches++;}}};
    const make = () => createCloudRunController({chromeApi: api, agent, ensureOffscreen: async () => {}, makeRunId: () => `run_${++seq}`});
    let c = make();
    await assert.rejects(c.startRun({task: 'Read', providerId: 'missing', expectedModel: provider.model}), e => e.status === 409);
    await assert.rejects(c.startRun({task: 'Read', providerId: 'webbrain_me', expectedModel: 'stale'}), e => e.status === 409);
    assert.equal(tabTouches, 0);
    async function finished(run) {
      for (let i = 0; i < 100 && c.runs.get(run.runId).status === 'running'; i++) await new Promise(r => setTimeout(r, 5));
      assert.equal(c.runs.get(run.runId).status, 'completed');
      return c.status({runId: run.runId});
    }
    const root = await c.startRun({task: 'Read', providerId: 'webbrain_me', expectedModel: provider.model});
    const done = await finished(root);
    const results = done.updates.filter(u => u.type === 'tool_result').map(u => u.data.result);
    assert.equal(results[0].success, undefined, 'an observation without an outcome is not a failure');
    assert.equal(results[1].success, undefined);
    assert.equal(results[2].success, false);
    assert.equal(JSON.stringify(done.updates).includes('private'), false);
    c = make();
    const child = await c.startRun({task: 'Continue', parentRunId: root.runId}); await finished(child);
    assert.deepEqual(observed, ['webbrain_me', 'webbrain_me']);
    provider.model = 'changed';
    await assert.rejects(c.startRun({task: 'Continue', parentRunId: child.runId}), e => e.status === 409);
  });
  test(`${browser}: rejected output is bounded and schema recovery gives valid values`, () => {
    const paragraph = 'A provider repeated this incomplete answer without verifying the actual browser action. '.repeat(3);
    const recovery = rejectedCompletionRecovery(Array(15).fill(paragraph).join('\n\n'), 'length');
    assert.equal(recovery.abbreviated, true);
    assert.ok(recovery.content.length < 2200);
    assert.match(recovery.nudge, /partial or failed/);
    assert.equal(rejectedCompletionRecovery('A normal complete answer.', 'stop').abbreviated, false);
    const invalid = validateToolArguments('extract_data', {type: 'links'}, {type: 'object', properties: {type: {type: 'string', enum: ['tables', 'headings', 'images']}}});
    assert.equal(invalid.ok, false); assert.match(invalid.result.detail, /tables.*headings.*images/);
    assert.equal(invalid.result.noDispatch, true);
    const source = fs.readFileSync(new URL(`../src/${browser}/src/content/accessibility-tree.js`, import.meta.url), 'utf8');
    const fn = source.slice(source.indexOf('  function formatTreeHref('), source.indexOf('  function mintRefScopeId('));
    const format = vm.runInNewContext(`(${fn.trim()})`);
    assert.equal(format('/watch?v=123'), ' href="/watch?v=123"');
    const long = '/ad?tracking=' + 'x'.repeat(20000);
    assert.ok(format(long).length < 100); assert.equal(format(long).includes('href="'), false);
    assert.match(format(long), /element ref/);
  });
}
