import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { FirefoxBidiClient } from '../src/firefox/src/bidi/client.js';
import { BidiSession } from '../firefox-companion/session.mjs';

const uuid = () => crypto.randomUUID();
const startupUrl = () => 'about:blank#wb-vision-' + uuid();
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const drain = async predicate => {
  for (let index = 0; index < 100 && !predicate(); index++) await Promise.resolve();
  assert.ok(predicate(), 'The expected asynchronous boundary must be reached');
};

function sessionFixture() {
  const session = new BidiSession(), calls = [], runId = uuid(), url = startupUrl();
  const context = { context: 'owned-top-level-context', url, parent: null };
  session.send = async (method, params) => { calls.push({ method, params }); return { contexts: [{ ...context }] }; };
  return { session, calls, runId, url, context };
}

test('startup companion binding uses two native top-level reads and no DOM, script or input', async () => {
  const f = sessionFixture();
  assert.deepEqual(await f.session.openVisionStartupRun(f.runId, f.url), { connected: true });
  assert.deepEqual(f.calls, [
    { method: 'browsingContext.getTree', params: { maxDepth: 0 } },
    { method: 'browsingContext.getTree', params: { root: f.context.context, maxDepth: 0 } },
  ]);
  assert.deepEqual(f.session.runs.get(f.runId), { context: f.context.context, navigation: false });
});

test('startup companion rejects malformed IDs, generic blanks and arbitrary URLs before browser access', async () => {
  const f = sessionFixture();
  for (const runId of [undefined, null, '', 'not-a-run', '-'.repeat(36), 123456, {}, []])
    await assert.rejects(f.session.openVisionStartupRun(runId, f.url), /Invalid visual startup binding/);
  for (const url of [undefined, null, {}, ['about:blank'], 'about:blank', 'about:blank#unowned', 'about:newtab',
    'https://example.test/', 'file:///tmp/document', 'about:blank#wb-vision-' + '-'.repeat(36),
    f.url + '?next=https://example.test/', f.url + '#extra', f.url.toUpperCase()])
    await assert.rejects(f.session.openVisionStartupRun(f.runId, url), /Invalid visual startup binding/);
  assert.deepEqual(f.calls, []); assert.equal(f.session.runs.size, 0);
});

test('startup companion never overwrites an existing or explicitly closed run', async () => {
  const f = sessionFixture(), original = { context: 'previous-context', navigation: true };
  f.session.runs.set(f.runId, original);
  await assert.rejects(f.session.openVisionStartupRun(f.runId, f.url), /Invalid/);
  assert.equal(f.session.runs.get(f.runId), original);
  f.session.runs.delete(f.runId); await f.session.closeRun(f.runId);
  await assert.rejects(f.session.openVisionStartupRun(f.runId, f.url), /Invalid/);
  assert.deepEqual(f.calls, []);
});

for (const scenario of ['missing', 'duplicate', 'child', 'different-url', 'missing-context', 'empty-context', 'non-string-context', 'too-many']) {
  test('startup companion rejects ' + scenario + ' top-level discovery without ownership', async () => {
    const f = sessionFixture();
    const entries = {
      missing: [], duplicate: [f.context, { ...f.context, context: 'another-tab' }],
      child: [{ ...f.context, parent: 'parent-context' }],
      'different-url': [{ ...f.context, url: 'about:blank' }],
      'missing-context': [{ url: f.url, parent: null }],
      'empty-context': [{ ...f.context, context: '' }],
      'non-string-context': [{ ...f.context, context: 1 }],
      'too-many': [f.context, ...Array.from({ length: 128 }, (_, index) => ({ context: 'other-' + index, url: 'about:blank' }))],
    }[scenario];
    let reads = 0;
    f.session.send = async method => { assert.equal(method, 'browsingContext.getTree'); reads++; return { contexts: entries }; };
    await assert.rejects(f.session.openVisionStartupRun(f.runId, f.url));
    assert.equal(f.session.runs.size, 0); assert.equal(reads, 1);
  });
}

test('exactly 128 native contexts remain supported and a child nonce cannot defeat its unique parent match', async () => {
  const f = sessionFixture();
  const entries = [f.context, { context: 'child-context', url: f.url, parent: 'foreign-parent' },
    ...Array.from({ length: 126 }, (_, index) => ({ context: 'other-' + index, url: 'about:blank' }))];
  f.session.send = async (_method, params) => ({ contexts: params.root ? [f.context] : entries });
  assert.equal((await f.session.openVisionStartupRun(f.runId, f.url)).connected, true);
  assert.equal(f.session.runs.get(f.runId).context, f.context.context);
});

for (const scenario of ['changed-url', 'changed-context', 'became-child', 'missing', 'duplicate', 'non-array']) {
  test('startup companion rejects ' + scenario + ' in its final context confirmation', async () => {
    const f = sessionFixture();
    const confirmation = {
      'changed-url': [{ ...f.context, url: 'https://new-document.test/' }],
      'changed-context': [{ ...f.context, context: 'replaced-context' }],
      'became-child': [{ ...f.context, parent: 'foreign-parent' }], missing: [],
      duplicate: [f.context, f.context], 'non-array': { 0: f.context, length: 1 },
    }[scenario];
    let reads = 0;
    f.session.send = async () => ({ contexts: ++reads === 1 ? [f.context] : confirmation });
    await assert.rejects(f.session.openVisionStartupRun(f.runId, f.url), /changed|binding/);
    assert.equal(f.session.runs.size, 0); assert.equal(reads, 2);
  });
}

for (const pauseAt of [1, 2]) {
  test('closeRun during startup tree read ' + pauseAt + ' prevents late ownership', async () => {
    const f = sessionFixture(), pending = deferred(); let reads = 0;
    f.session.send = async method => {
      assert.equal(method, 'browsingContext.getTree');
      return ++reads === pauseAt ? pending.promise : { contexts: [f.context] };
    };
    const opening = f.session.openVisionStartupRun(f.runId, f.url);
    await drain(() => reads === pauseAt);
    await f.session.closeRun(f.runId); pending.resolve({ contexts: [f.context] });
    await assert.rejects(opening, /stopped|bound/);
    assert.equal(f.session.runs.size, 0); assert.equal(f.session.closedRuns.has(f.runId), true);
  });
}

test('two concurrent startup bindings preserve the first completed owner', async () => {
  const f = sessionFixture(), pending = [];
  f.session.send = async () => { const next = deferred(); pending.push(next); return next.promise; };
  const first = f.session.openVisionStartupRun(f.runId, f.url);
  const second = f.session.openVisionStartupRun(f.runId, f.url);
  await drain(() => pending.length === 2);
  pending[0].resolve({ contexts: [f.context] }); await drain(() => pending.length === 3);
  pending[1].resolve({ contexts: [f.context] }); await drain(() => pending.length === 4);
  pending[2].resolve({ contexts: [f.context] }); await first;
  const original = f.session.runs.get(f.runId);
  pending[3].resolve({ contexts: [f.context] });
  await assert.rejects(second, /stopped|bound/); assert.equal(f.session.runs.get(f.runId), original);
});

test('an older ordinary openRun cannot overwrite a completed startup binding', async () => {
  const f = sessionFixture(), located = deferred();
  f.session.locate = () => located.promise;
  f.session.call = () => assert.fail('A losing ordinary binder cannot touch the new owner');
  const ordinary = f.session.openRun(f.runId, uuid(), 'https://ordinary.test/');
  await f.session.openVisionStartupRun(f.runId, f.url);
  const original = f.session.runs.get(f.runId);
  located.resolve({ context: 'ordinary-context', node: {} });
  await assert.rejects(ordinary, /stopped|bound/); assert.equal(f.session.runs.get(f.runId), original);
});

test('an older startup binding cannot overwrite a completed ordinary openRun', async () => {
  const f = sessionFixture(), discovery = deferred();
  f.session.send = () => discovery.promise;
  f.session.locate = async () => ({ context: 'ordinary-context', node: {} });
  f.session.call = async () => ({ result: { value: true } });
  const startup = f.session.openVisionStartupRun(f.runId, f.url);
  await f.session.openRun(f.runId, uuid(), 'https://ordinary.test/');
  const original = f.session.runs.get(f.runId);
  discovery.resolve({ contexts: [f.context] });
  await assert.rejects(startup, /stopped|bound/); assert.equal(f.session.runs.get(f.runId), original);
});

test('native companion advertises startup binding on existing and newly established connections', async () => {
  const existing = new BidiSession();
  existing.socket = { readyState: 1 };
  assert.deepEqual(await existing.connect(9222), { connected: true, visionStartupBinding: true });
  const commands = [];
  class Socket {
    constructor() { this.readyState = 0; this.events = new Map(); queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); }); }
    addEventListener(name, listener) { const list = this.events.get(name) || []; list.push(listener); this.events.set(name, list); }
    emit(name, value) { for (const listener of this.events.get(name) || []) listener(value); }
    send(raw) { const message = JSON.parse(raw); commands.push(message.method);
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: message.id, type: 'success', result: {} }) })); }
    close() { this.readyState = 3; this.emit('close', {}); }
  }
  const fresh = new BidiSession(Socket);
  try {
    assert.deepEqual(await fresh.connect(9222), { connected: true, visionStartupBinding: true });
    assert.deepEqual(commands, ['session.new', 'session.subscribe']);
  } finally { await fresh.close(); }
});

function clientFixture() {
  const calls = [], controller = new AbortController(), tabId = 31;
  let tab = { id: tabId, url: 'about:newtab' };
  const client = new FirefoxBidiClient({ tabs: {
    get: async () => ({ ...tab }), executeScript: () => assert.fail('Startup must not inject a DOM marker'),
  } });
  const owner = { runId: uuid(), signal: controller.signal };
  client.runs.set(tabId, owner);
  client.connect = async () => ({ connected: true, visionStartupBinding: true });
  client.request = async (command, args) => { calls.push({ command, args }); return { connected: true }; };
  return { client, owner, controller, tabId, calls, setTab(value) { tab = { ...tab, ...value }; } };
}

test('Firefox client mints one nonce per live owner and binds only its exact new blank tab', async () => {
  const f = clientFixture(), first = await f.client.prepareVisionStartup(f.tabId);
  assert.match(first.url, /^about:blank#wb-vision-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.deepEqual(await f.client.prepareVisionStartup(f.tabId), first);
  assert.equal(f.calls.length, 0);
  f.setTab({ url: first.url });
  await f.client.bindRun(f.tabId, f.owner);
  assert.deepEqual(f.calls, [{ command: 'openVisionStartupRun', args: { runId: f.owner.runId, url: first.url } }]);
  assert.equal(f.owner.bound, true);
  await assert.rejects(f.client.prepareVisionStartup(f.tabId), /unbound/);
  const next = { runId: uuid(), signal: f.controller.signal }; f.client.runs.set(f.tabId, next);
  assert.notEqual((await f.client.prepareVisionStartup(f.tabId)).url, first.url);
});

test('Firefox client rejects missing, disconnected, bound and aborted owners before capability access', async () => {
  for (const condition of ['missing', 'disconnected', 'bound', 'aborted']) {
    const f = clientFixture();
    f.client.connect = () => assert.fail('An invalid owner cannot connect');
    if (condition === 'missing') f.client.runs.delete(f.tabId);
    if (condition === 'disconnected') f.owner.disconnected = true;
    if (condition === 'bound') f.owner.bound = true;
    if (condition === 'aborted') f.controller.abort();
    await assert.rejects(f.client.prepareVisionStartup(f.tabId), /unbound/);
    assert.equal(f.owner.visionStartupUrl, undefined); assert.equal(f.calls.length, 0);
  }
});

test('Firefox client refuses old or malformed companion capability without minting a blank URL', async () => {
  for (const capabilities of [null, {}, { connected: true }, { visionStartupBinding: false }, { visionStartupBinding: 'true' }]) {
    const f = clientFixture(); f.client.connect = async () => capabilities;
    await assert.rejects(f.client.prepareVisionStartup(f.tabId), /Update the Firefox/);
    assert.equal(f.owner.visionStartupUrl, undefined); assert.deepEqual(f.calls, []);
  }
});

for (const change of ['replacement', 'stop', 'abort', 'bound']) {
  test('Firefox client rejects ' + change + ' while negotiating startup capability', async () => {
    const f = clientFixture(), connecting = deferred(); f.client.connect = () => connecting.promise;
    const preparing = f.client.prepareVisionStartup(f.tabId);
    if (change === 'replacement') f.client.runs.set(f.tabId, { runId: uuid() });
    if (change === 'stop') f.client.stopRun(f.tabId);
    if (change === 'abort') f.controller.abort();
    if (change === 'bound') f.owner.bound = true;
    connecting.resolve({ visionStartupBinding: true });
    await assert.rejects(preparing, /unbound/);
    assert.equal(f.owner.visionStartupUrl, undefined); assert.deepEqual(f.calls, []);
  });
}

test('Firefox startup binding ignores generic, foreign and pending-navigation targets', async () => {
  for (const url of ['about:blank', startupUrl(), 'about:config', 'moz-extension://foreign/newtab/index.html']) {
    const f = clientFixture(); await f.client.prepareVisionStartup(f.tabId); f.setTab({ url });
    await f.client.bindRun(f.tabId, f.owner);
    assert.deepEqual(f.calls, []); assert.notEqual(f.owner.bound, true);
  }
  const f = clientFixture(), prepared = await f.client.prepareVisionStartup(f.tabId);
  f.setTab({ url: prepared.url, pendingUrl: 'https://user-navigation.test/' });
  await f.client.bindRun(f.tabId, f.owner);
  assert.deepEqual(f.calls, []); assert.notEqual(f.owner.bound, true);
});

for (const change of ['replacement', 'stop', 'abort']) {
  test('Firefox client rejects ' + change + ' during the live-tab read before requesting a binding', async () => {
    const f = clientFixture(), prepared = await f.client.prepareVisionStartup(f.tabId), tab = deferred();
    f.client.api.tabs.get = () => tab.promise;
    const binding = f.client.bindRun(f.tabId, f.owner);
    if (change === 'replacement') f.client.runs.set(f.tabId, { runId: uuid() });
    if (change === 'stop') f.client.stopRun(f.tabId);
    if (change === 'abort') f.controller.abort();
    tab.resolve({ id: f.tabId, url: prepared.url });
    await assert.rejects(binding, /stopped/i);
    assert.deepEqual(f.calls, []); assert.notEqual(f.owner.bound, true);
  });
}

for (const change of ['replacement', 'abort']) {
  test('Firefox client closes only the stale native owner after ' + change + ' during a dispatched bind', async () => {
    const f = clientFixture(), prepared = await f.client.prepareVisionStartup(f.tabId), opening = deferred();
    f.setTab({ url: prepared.url }); f.client.port = {};
    f.client.request = async (command, args) => { f.calls.push({ command, args }); return command === 'openVisionStartupRun' ? opening.promise : {}; };
    const binding = f.client.bindRun(f.tabId, f.owner);
    await drain(() => f.calls.length === 1);
    const replacement = { runId: uuid() };
    if (change === 'replacement') f.client.runs.set(f.tabId, replacement); else f.controller.abort();
    opening.resolve({ connected: true }); await assert.rejects(binding, /stopped/i);
    assert.deepEqual(f.calls.map(call => call.command), ['openVisionStartupRun', 'closeRun']);
    assert.equal(f.calls[1].args.runId, f.owner.runId); assert.notEqual(f.owner.bound, true);
    if (change === 'replacement') { assert.equal(f.client.runs.get(f.tabId), replacement); assert.notEqual(replacement.bound, true); }
  });
}

test('actual native-message host routes startup binding but rejects generic and hostile URLs before connecting', { timeout: 5000 }, async t => {
  const host = spawn(process.execPath, ['firefox-companion/host.mjs'], { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (host.exitCode === null) host.kill(); });
  const closed = once(host, 'close'), replies = [], done = deferred();
  let buffer = Buffer.alloc(0), stderr = '';
  host.stderr.on('data', chunk => { stderr += chunk.toString(); });
  host.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0); replies.push(JSON.parse(buffer.subarray(4, 4 + size)));
      buffer = buffer.subarray(4 + size);
    }
    if (replies.length === 3) done.resolve();
  });
  const urls = ['about:blank', 'https://hostile.example/', 'about:blank#wb-vision-not-a-nonce'];
  for (const [index, url] of urls.entries()) {
    const data = Buffer.from(JSON.stringify({ id: index + 1, command: 'openVisionStartupRun', runId: uuid(), url }));
    const header = Buffer.alloc(4); header.writeUInt32LE(data.length); host.stdin.write(Buffer.concat([header, data]));
  }
  await done.promise;
  assert.deepEqual(replies.map(reply => reply.id).sort(), [1, 2, 3]);
  for (const reply of replies) assert.equal(reply.error, 'Invalid visual startup binding');
  host.stdin.end(); const [code] = await closed;
  assert.equal(code, 0, stderr); assert.equal(stderr, '');
});
