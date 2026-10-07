import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startApprovalServer } from '../examples/cloud-bridge-approval-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'src/chrome/src/offscreen/cloud-bridge.js'), 'utf8');
const IDENTITY = { token: 'secret-token', browserId: 'browser-1', installationId: 'install-1', extensionVersion: '1.2.3' };
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function harness({ WebSocketImpl, sendMessage = async () => ({ runId: 'r1', status: 'running' }) } = {}) {
  const sockets = [];
  const timers = [];
  const runtimeCalls = [];
  let listener;
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(type, cb) { this.listeners.set(type, cb); }
    send(v) { this.sent.push(JSON.parse(v)); }
    close() { this.readyState = 2; this.emit('close'); }
    emit(type, value = {}) {
      if (type === 'open') this.readyState = 1;
      if (type === 'close') this.readyState = 3;
      this.listeners.get(type)?.(value);
    }
    receive(obj) { return this.emit('message', { data: JSON.stringify(obj) }); }
  }
  vm.runInNewContext(source, {
    URL,
    WebSocket: WebSocketImpl || FakeWebSocket,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/126.0.1 Safari/537.36', platform: 'Linux x86_64' },
    chrome: { runtime: {
      onMessage: { addListener: cb => { listener = cb; } },
      sendMessage: async m => { runtimeCalls.push(m); return sendMessage(m); },
    } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  const start = (extra = IDENTITY, url = 'ws://127.0.0.1:17374/extension') => {
    let out; listener({ type: 'cloud-bridge-start', url, ...extra }, null, v => { out = v; }); return out;
  };
  const status = () => { let out; listener({ type: 'cloud-bridge-status' }, null, v => { out = v; }); return out; };
  return { sockets, timers, runtimeCalls, start, status };
}

const cmd = { id: 'c1', action: 'cloud_status', payload: { runId: 'r1' } };

test('hello carries identity, token, browser, version and platform', () => {
  const h = harness();
  h.start();
  h.sockets[0].emit('open');
  const hello = h.sockets[0].sent[0];
  assert.equal(hello.type, 'hello');
  assert.deepEqual(hello.auth, { type: 'bearer', token: 'secret-token' });
  assert.equal(hello.browserId, 'browser-1');
  assert.equal(hello.installationId, 'install-1');
  assert.deepEqual({ ...hello.browser }, { name: 'Chrome', version: '126.0.1' });
  assert.equal(hello.extensionVersion, '1.2.3');
  assert.equal(hello.platform, 'Linux x86_64');
  assert.deepEqual([...hello.capabilities], ['saved_workflows_v1', 'run_modes_v1', 'scheduled_jobs_v1', 'private_results_v1']);
  assert.equal(JSON.stringify(hello.status).includes('secret-token'), false, 'status must not leak the token');
  assert.equal(JSON.stringify(h.status()).includes('secret-token'), false);
});

test('pending connection refuses cloud commands without calling the background', async () => {
  const h = harness();
  h.start();
  const s = h.sockets[0];
  s.emit('open');
  s.receive({ type: 'connection_pending', browserId: 'browser-1' });
  assert.equal(h.status().approval, 'pending');
  s.receive(cmd);
  await tick();
  const reply = s.sent.find(m => m.id === 'c1');
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'connection_not_approved');
  assert.equal(h.runtimeCalls.length, 0);
});

test('commands are refused before any approval message too', async () => {
  const h = harness();
  h.start();
  h.sockets[0].emit('open');
  h.sockets[0].receive(cmd);
  await tick();
  assert.equal(h.sockets[0].sent.find(m => m.id === 'c1').ok, false);
  assert.equal(h.runtimeCalls.length, 0);
});

test('approved connection runs commands with the unchanged payload format', async () => {
  const h = harness();
  h.start();
  const s = h.sockets[0];
  s.emit('open');
  s.receive({ type: 'connection_pending' });
  s.receive({ type: 'connection_approved', browserId: 'browser-1' });
  assert.equal(h.status().approval, 'approved');
  s.receive(cmd);
  await tick();
  assert.deepEqual({ ...h.runtimeCalls[0] }, { runId: 'r1', target: 'background', action: 'cloud_status' });
  const reply = s.sent.find(m => m.id === 'c1');
  assert.equal(reply.ok, true);
  assert.equal(reply.result.status, 'running');
});

test('approval for another browserId is ignored', async () => {
  const h = harness();
  h.start();
  h.sockets[0].emit('open');
  h.sockets[0].receive({ type: 'connection_approved', browserId: 'someone-else' });
  assert.equal(h.status().approval, 'pending');
});

test('rejected connection closes, blocks commands and does not reconnect', async () => {
  const h = harness();
  h.start();
  const s = h.sockets[0];
  s.emit('open');
  s.receive({ type: 'connection_rejected', reason: 'nope' });
  assert.equal(h.status().approval, 'rejected');
  assert.equal(h.status().lastError, 'nope');
  assert.equal(s.readyState, 3);
  assert.equal(h.timers.length, 0, 'no reconnect after rejection');
  s.receive(cmd);
  await tick();
  assert.equal(h.runtimeCalls.length, 0);
});

test('reconnect requires a fresh approval', async () => {
  const h = harness();
  h.start();
  const first = h.sockets[0];
  first.emit('open');
  first.receive({ type: 'connection_approved' });
  first.close();
  assert.equal(h.status().approval, 'pending');
  h.timers[0].callback();
  const second = h.sockets[1];
  second.emit('open');
  assert.equal(second.sent[0].type, 'hello');
  assert.equal(second.sent[0].auth.token, 'secret-token');
  second.receive(cmd);
  await tick();
  assert.equal(second.sent.find(m => m.id === 'c1').code, 'connection_not_approved');
  assert.equal(h.runtimeCalls.length, 0);
  second.receive({ type: 'connection_approved' });
  second.receive(cmd);
  await tick();
  assert.equal(h.runtimeCalls.length, 1);
});

test('rejection cancels a pending backoff timer so the browser cannot reconnect', async () => {
  const h = harness();
  h.start();
  h.sockets[0].emit('open');
  h.sockets[0].close(); // schedules a reconnect timer
  assert.equal(h.timers.length, 1);
  h.start(); // restart during backoff opens a new socket right away
  h.sockets[1].emit('open');
  h.sockets[1].receive({ type: 'connection_rejected', reason: 'nope' });
  assert.equal(h.timers[0].cleared, true, 'pending timer must be cancelled');
});

test('without a token the legacy behaviour is unchanged', async () => {
  const h = harness();
  h.start({});
  const s = h.sockets[0];
  s.emit('open');
  assert.equal(s.sent[0].auth, undefined);
  assert.equal(h.status().approval, 'not_required');
  s.receive(cmd);
  await tick();
  assert.equal(h.runtimeCalls.length, 1);
});

test('end to end against the example server', async () => {
  const received = [];
  const server = await startApprovalServer({ port: 0, token: 'secret-token', onMessage: m => received.push(m) });
  const h = harness({ WebSocketImpl: WebSocket });
  try {
    h.start(IDENTITY, `ws://127.0.0.1:${server.port}/extension`);
    for (let i = 0; i < 50 && ![...server.sessions].some(s => s.state === 'pending'); i++) await tick(20);
    const session = [...server.sessions][0];
    assert.equal(session.state, 'pending');
    assert.equal(session.hello.browserId, 'browser-1');
    session.send(cmd);
    for (let i = 0; i < 50 && !received.some(m => m.id === 'c1'); i++) await tick(20);
    assert.equal(received.find(m => m.id === 'c1').code, 'connection_not_approved');
    session.approve();
    session.send({ ...cmd, id: 'c2' });
    for (let i = 0; i < 50 && !received.some(m => m.id === 'c2'); i++) await tick(20);
    assert.equal(received.find(m => m.id === 'c2').ok, true);
  } finally {
    await server.close();
  }
});

// ---- Firefox: same protocol, socket lives in the background page ----
const { createCloudBridge } = await import('../src/firefox/src/cloud-bridge.js');
const { createCloudRunController: createFxController } = await import('../src/firefox/src/cloud-runs.js');

function fxHarness({ WebSocketImpl, dispatch } = {}) {
  const sockets = [];
  const calls = [];
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(type, cb) { this.listeners.set(type, cb); }
    send(v) { this.sent.push(JSON.parse(v)); }
    close() { this.readyState = 3; this.listeners.get('close')?.({}); }
    emit(type, value = {}) { if (type === 'open') this.readyState = 1; this.listeners.get(type)?.(value); }
    receive(obj) { return this.emit('message', { data: JSON.stringify(obj) }); }
  }
  const bridge = createCloudBridge({
    WebSocketImpl: WebSocketImpl || FakeWebSocket,
    nav: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', platform: 'Linux x86_64' },
    dispatch: dispatch || (async (m) => { calls.push(m); return { runId: 'r1', status: 'running' }; }),
  });
  return { bridge, sockets, calls };
}

test('firefox: hello, pending refusal, approval, rejection', async () => {
  const h = fxHarness();
  h.bridge.start({ url: 'ws://127.0.0.1:17374/extension', ...IDENTITY });
  const s = h.sockets[0];
  s.emit('open');
  const hello = s.sent[0];
  assert.deepEqual({ ...hello.browser }, { name: 'Firefox', version: '140.0' });
  assert.equal(hello.auth.token, 'secret-token');
  assert.equal(hello.browserId, 'browser-1');
  assert.equal(hello.platform, 'Linux x86_64');
  assert.equal(JSON.stringify(h.bridge.status()).includes('secret-token'), false);

  s.receive({ type: 'connection_pending' });
  s.receive(cmd);
  await tick();
  assert.equal(s.sent.find(m => m.id === 'c1').code, 'connection_not_approved');
  assert.equal(h.calls.length, 0);

  s.receive({ type: 'connection_approved', browserId: 'browser-1' });
  s.receive({ ...cmd, id: 'c2' });
  await tick();
  assert.equal(s.sent.find(m => m.id === 'c2').ok, true);
  assert.deepEqual({ ...h.calls[0] }, { runId: 'r1', target: 'background', action: 'cloud_status' });

  s.receive({ id: 'bad', action: 'get_providers', payload: {} });
  await tick();
  assert.match(s.sent.find(m => m.id === 'bad').error, /unsupported/i);

  s.receive({ type: 'connection_rejected', reason: 'no' });
  assert.equal(h.bridge.status().approval, 'rejected');
  assert.equal(s.readyState, 3);
  h.bridge.stop();
});

test('firefox: reconnect requires a fresh approval', async () => {
  const h = fxHarness();
  h.bridge.start({ url: 'ws://127.0.0.1:17374/extension', ...IDENTITY });
  const first = h.sockets[0];
  first.emit('open');
  first.receive({ type: 'connection_approved' });
  first.close();
  assert.equal(h.bridge.status().approval, 'pending');
  await tick(700); // first backoff is 500 ms
  const second = h.sockets[1];
  assert.ok(second, 'reconnected');
  second.emit('open');
  second.receive(cmd);
  await tick();
  assert.equal(second.sent.find(m => m.id === 'c1').code, 'connection_not_approved');
  assert.equal(h.calls.length, 0);
  h.bridge.stop();
});

test('firefox: rejection cancels a pending backoff timer', async () => {
  const h = fxHarness();
  h.bridge.start({ url: 'ws://127.0.0.1:17374/extension', ...IDENTITY });
  h.sockets[0].emit('open');
  h.sockets[0].close(); // schedules a 500 ms reconnect
  h.bridge.start({ url: 'ws://127.0.0.1:17374/extension', ...IDENTITY });
  h.sockets[1].emit('open');
  h.sockets[1].receive({ type: 'connection_rejected' });
  await tick(700);
  assert.equal(h.sockets.length, 2, 'no third socket after rejection');
  h.bridge.stop();
});

test('firefox: without a token behaviour is legacy', async () => {
  const h = fxHarness();
  h.bridge.start({ url: 'ws://127.0.0.1:17374/extension' });
  h.sockets[0].emit('open');
  assert.equal(h.sockets[0].sent[0].auth, undefined);
  h.sockets[0].receive(cmd);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.throws(() => { throw new Error(h.bridge.start({ url: 'wss://evil.example/x' }).error); }, /localhost/);
  h.bridge.stop();
});

test('firefox: controller persists identity and feeds it to the bridge', async () => {
  const store = {};
  const started = [];
  const api = {
    storage: { local: {
      get: async (keys) => Object.fromEntries([].concat(keys).map(k => [k, store[k]]).filter(([, v]) => v !== undefined)),
      set: async (obj) => { Object.assign(store, obj); },
    } },
    runtime: { getManifest: () => ({ version: '9.9.9' }) },
  };
  const controller = createFxController({
    chromeApi: api,
    agent: {},
    bridge: { start: (m) => { started.push(m); return { enabled: true }; }, stop: () => ({ enabled: false }), status: () => ({}) },
  });
  store.webbrainCloudBridgeEnabled = true;
  store.webbrainCloudBridgeToken = 'tok';
  await controller.syncBridge();
  assert.equal(started[0].token, 'tok');
  assert.equal(started[0].extensionVersion, '9.9.9');
  assert.ok(store.webbrainCloudBridgeInstallationId, 'installation id generated once');
  assert.equal(started[0].browserId, store.webbrainCloudBridgeInstallationId, 'browserId defaults to the installation id');
  await controller.syncBridge();
  assert.equal(started[1].installationId, started[0].installationId, 'installation id is stable');
});

test('firefox: end to end against the example server', async () => {
  const received = [];
  const server = await startApprovalServer({ port: 0, token: 'secret-token', onMessage: m => received.push(m) });
  const h = fxHarness({ WebSocketImpl: WebSocket });
  try {
    h.bridge.start({ url: `ws://127.0.0.1:${server.port}/extension`, ...IDENTITY });
    for (let i = 0; i < 50 && ![...server.sessions].some(s => s.state === 'pending'); i++) await tick(20);
    const session = [...server.sessions][0];
    assert.equal(session.state, 'pending');
    session.send(cmd);
    for (let i = 0; i < 50 && !received.some(m => m.id === 'c1'); i++) await tick(20);
    assert.equal(received.find(m => m.id === 'c1').code, 'connection_not_approved');
    session.approve();
    session.send({ ...cmd, id: 'c2' });
    for (let i = 0; i < 50 && !received.some(m => m.id === 'c2'); i++) await tick(20);
    assert.equal(received.find(m => m.id === 'c2').ok, true);
  } finally {
    h.bridge.stop();
    await server.close();
  }
});

for (const [label, createController] of [['chrome', null], ['firefox', createFxController]]) {
  test(`${label}: concurrent bridge starts share one installation id`, async () => {
    const { createCloudRunController: make } = label === 'chrome'
      ? await import('../src/chrome/src/cloud-runs.js')
      : { createCloudRunController: createController };
    const store = {};
    const started = [];
    const api = {
      storage: { local: {
        // yield so two callers can interleave between read and write
        get: async (keys) => { await tick(5); return Object.fromEntries([].concat(keys).map(k => [k, store[k]]).filter(([, v]) => v !== undefined)); },
        set: async (obj) => { await tick(5); Object.assign(store, obj); },
      } },
      runtime: { getManifest: () => ({ version: '1.0.0' }) },
    };
    const bridge = { start: (m) => { started.push(m); return {}; }, stop: () => ({}), status: () => ({}) };
    const controller = make({ chromeApi: api, agent: {}, ensureOffscreen: async () => {}, bridge });
    store.webbrainCloudBridgeEnabled = true;
    if (label === 'chrome') api.runtime.sendMessage = async (m) => { started.push(m); return {}; };
    await Promise.all([controller.syncBridge(), controller.startBridge(), controller.syncBridge()]);
    const ids = new Set(started.map(m => m.installationId));
    assert.equal(ids.size, 1, 'all concurrent starts must use the same installation id');
    assert.equal([...ids][0], store.webbrainCloudBridgeInstallationId, 'and it matches the persisted one');
  });
}
