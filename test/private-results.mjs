import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';

const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = pair.publicKey.export({ format: 'jwk' });
const secret = 'synthetic-owner-password-73!';
function decrypt(result, runId) {
  const e = result.private_result;
  const key = privateDecrypt({key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'}, Buffer.from(e.encryptedKey, 'base64'));
  const bytes = Buffer.from(e.ciphertext, 'base64');
  const aes = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  aes.setAAD(Buffer.from('webbrain.private-result.v1:' + runId));
  aes.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([aes.update(bytes.subarray(0, -16)), aes.final()]).toString());
}
for (const browser of ['chrome', 'firefox']) {
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  const { importPrivateResultRecipient, encryptPrivateResult } = await import(`../src/${browser}/src/private-results.js`);
  function harness(structured = false, output = secret) {
    const stored = {};
    let calls = 0, lastOptions;
    const agent = { strictSecretMode: true, isRunning: () => false, abort() {},
      async processMessage(_tab, _task, update, _mode, _attachments, options) {
        calls++;
        lastOptions = options;
        update('tool_call', {name: 'set_field', args: {text: secret}});
        if (structured) update('tool_result', { name: 'done_json', result: {
          cloudResult: { password: secret, success: true }, summary: 'Finished', cloudDone: true,
        }});
        options.onRunFinished('done');
        return output;
      } };
    const api = {storage: {session: {get: async key => ({[key]: stored[key]}),
      set: async data => Object.assign(stored, data)}}, tabs: {
      get: async () => ({id: 7, url: 'https://example.com'}),
      query: async () => [{id: 7, url: 'https://example.com'}], update: async () => {},
    }};
    const extra = {chromeApi: api, agent, makeRunId: () => 'run_private', ensureOffscreen: async () => {}};
    return {c: createCloudRunController(extra), stored, extra, calls: () => calls, options: () => lastOptions};
  }
  async function finish(c, started) {
    for (let i = 0; i < 300; i++) {
      const r = await c.status({runId: started.runId});
      if (!['running', 'aborting'].includes(r.status)) return r;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error('Private result did not complete');
  }
  test(`${browser}: default strict result stays redacted; opt-in final output is encrypted without trace leakage`, async () => {
    for (const optIn of [false, true]) {
      const h = harness();
      const start = await h.c.startRun({task: 'Owner fixture', ...(optIn ? {private_result_public_key: publicKey} : {})});
      const done = await finish(h.c, start);
      assert.equal(done.status, 'completed');
      assert.equal(h.options().privateFinalResult, optIn);
      assert.equal(h.extra.agent.strictSecretMode, true);
      assert.ok(!JSON.stringify(done).includes(secret));
      assert.ok(!JSON.stringify(h.stored).includes(secret));
      if (optIn) {
        assert.ok(decrypt(done.result, done.runId) === secret);
        assert.ok(!JSON.stringify(done.result.public_result).includes(secret));
        assert.throws(() => decrypt(done.result, 'wrong_run'));
        const restarted = createCloudRunController(h.extra);
        const restored = await restarted.status({runId: done.runId});
        assert.ok(decrypt(restored.result, restored.runId) === secret);
        assert.equal(h.calls(), 1);
      } else assert.match(done.result, /redacted strict value/);
    }
  });
  test(`${browser}: structured final credentials are encrypted; typed values and tool payloads stay redacted`, async () => {
    const h = harness(true);
    const start = await h.c.startRun({ task: 'Owner fixture', private_result_public_key: publicKey,
      output_schema: {type: 'object', properties: {password: {type: 'string'}, success: {type: 'boolean'}}} });
    const done = await finish(h.c, start);
    assert.equal(done.status, 'completed');
    assert.ok(decrypt(done.result, done.runId).password === secret);
    assert.ok(!JSON.stringify(done).includes(secret));
  });
  test(`${browser}: invalid recipient fails before browser actions and oversized output fails without replay`, async () => {
    const h = harness();
    await assert.rejects(h.c.startRun({task: 'Owner fixture', private_result_public_key: {...publicKey, d: 'private'}}));
    assert.equal(h.calls(), 0);
    const large = harness(false, 'x'.repeat(65000));
    const done = await finish(large.c, await large.c.startRun({task: 'Owner fixture', private_result_public_key: publicKey}));
    assert.equal(done.status, 'completed');
    assert.ok(decrypt(done.result, done.runId).length === 65000, 'ciphertext must survive persistence string limits');
    const again = createCloudRunController(large.extra);
    const restored = await again.status({runId: done.runId});
    assert.ok(decrypt(restored.result, restored.runId).length === 65000);
    const oversized = harness(false, 'x'.repeat(66000));
    const failed = await finish(oversized.c, await oversized.c.startRun({task: 'Owner fixture', private_result_public_key: publicKey}));
    assert.equal(failed.status, 'failed');
    assert.equal(oversized.calls(), 1);
  });
  test(`${browser}: authenticated encryption binds result to run and detects ciphertext tampering`, async () => {
    const key = await importPrivateResultRecipient(publicKey);
    const envelope = await encryptPrivateResult(key, 'run_bound', secret);
    const result = {private_result: envelope};
    assert.ok(decrypt(result, 'run_bound') === secret);
    const damaged = Buffer.from(envelope.ciphertext, 'base64'); damaged[0] ^= 1;
    assert.throws(() => decrypt({private_result: {...envelope, ciphertext: damaged.toString('base64')}}, 'run_bound'));
  });
  for (const cancel of [false, true]) test(`${browser}: encryption retains browser lock and honors cancellation (${cancel})`, async t => {
    let release, entered;
    const gate = new Promise(resolve => {release = resolve;});
    const arrived = new Promise(resolve => {entered = resolve;});
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    t.mock.method(crypto.subtle, 'encrypt', async (algorithm, ...args) => {
      if (algorithm.name === 'AES-GCM') {entered(); await gate;}
      return original(algorithm, ...args);
    });
    const h = harness();
    const started = await h.c.startRun({task: 'Owner fixture', private_result_public_key: publicKey});
    await arrived;
    assert.equal((await h.c.status({runId: started.runId})).status, 'running');
    await assert.rejects(h.c.startRun({task: 'Another task'}), e => e.status === 409);
    if (cancel) await h.c.abort({runId: started.runId});
    release();
    const done = await finish(h.c, started);
    assert.equal(done.status, cancel ? 'aborted' : 'completed');
    assert.ok(!JSON.stringify(done).includes(secret));
    if (!cancel) assert.ok(decrypt(done.result, done.runId) === secret);
  });
}
