import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const restricted = () => Object.assign(new Error('Browser protects this target'), { code: 'vision_capture_restricted_target' });
const variants = await Promise.all(['chrome', 'firefox'].map(async browser => [browser,
  await import(`../src/${browser}/src/agent/vision-bootstrap.js`)]));

for (const [browser, bootstrap] of variants) {
  const { captureVisionStartup } = await import(`../src/${browser}/src/agent/vision-act.js`);
  function startupFixture() {
    const controller = new AbortController(), updates = [], waits = [];
    let tab = { id: 71, url: 'chrome://newtab/', pendingUrl: 'chrome://new-tab-page/' };
    let captures = 0, recoveries = 0, elapsed = 0, steered = false;
    const api = { runtime: { getURL: path => `chrome-extension://owned/${path}` }, tabs: {
      get: async () => ({ ...tab }), update: async (id, args) => { updates.push({ id, ...args }); tab = { id, url: args.url }; },
    } };
    const check = () => { controller.signal.throwIfAborted(); if (steered) throw Object.assign(new Error('Steered'), { code: 'vision_request_steered' }); };
    const observe = async () => {
      captures++;
      if (tab.url.startsWith('chrome://')) throw restricted();
      return { pixels: 'actual screenshot', url: tab.url };
    };
    const recover = async error => {
      recoveries++;
      return bootstrap.bootstrapVisionNewTab(71, error, { api, signal: controller.signal,
        assertCurrent: check, beforeDispatch: async () => true, afterDispatch: async () => true });
    };
    const options = { signal: controller.signal, assertCurrent: check, now: () => elapsed,
      wait: async delay => { waits.push(delay); elapsed += delay; } };
    return { api, controller, updates, waits, observe, recover, options,
      run: () => captureVisionStartup(observe, recover, options), setTab: value => { tab = { ...tab, ...value }; },
      steer: () => { steered = true; }, counts: () => ({ captures, recoveries }) };
  }

  test(`${browser}: pending browser-newtab redirect settles before one startup mutation and real screenshot`, async () => {
    const f = startupFixture(), wait = f.options.wait;
    f.options.wait = async delay => { await wait(delay); f.setTab({ url: 'chrome://new-tab-page/', pendingUrl: undefined }); };
    assert.deepEqual(await f.run(), { pixels: 'actual screenshot', url: 'about:blank' });
    assert.deepEqual(f.updates, [{ id: 71, url: 'about:blank' }]);
    assert.deepEqual(f.counts(), { captures: 3, recoveries: 2 });
    assert.deepEqual(f.waits, [150]);
  });

  test(`${browser}: pending user website or capturable own-newtab navigation is observed without replacement`, async () => {
    for (const url of ['https://user-selected.example/', 'chrome-extension://owned/newtab/index.html']) {
      const f = startupFixture(), wait = f.options.wait;
      f.options.wait = async delay => { await wait(delay); f.setTab({ url, pendingUrl: undefined }); };
      assert.deepEqual(await f.run(), { pixels: 'actual screenshot', url });
      assert.deepEqual(f.updates, []);
      assert.deepEqual(f.counts(), { captures: 2, recoveries: 1 });
    }
  });

  test(`${browser}: perpetual pending startup is bounded by recovery count and total elapsed time`, async () => {
    const f = startupFixture();
    await assert.rejects(f.run(), { code: 'vision_capture_restricted_target' });
    assert.deepEqual(f.counts(), { captures: 9, recoveries: 8 });
    assert.equal(f.waits.length, 8); assert.equal(f.updates.length, 0);
    const timed = startupFixture(); let elapsed = 0;
    timed.options.now = () => elapsed;
    timed.options.wait = async () => { elapsed += 8000; };
    await assert.rejects(timed.run(), { code: 'vision_capture_restricted_target' });
    assert.deepEqual(timed.counts(), { captures: 1, recoveries: 1 });
    assert.equal(timed.updates.length, 0);
  });

  test(`${browser}: Stop or steering during the startup wait prevents another capture or mutation`, async () => {
    for (const kind of ['stop', 'steering']) {
      const f = startupFixture();
      f.options.wait = async () => { if (kind === 'stop') f.controller.abort(); else f.steer(); };
      await assert.rejects(f.run(), error => kind === 'stop' ? error.name === 'AbortError' : error.code === 'vision_request_steered');
      assert.deepEqual(f.counts(), { captures: 1, recoveries: 1 });
      assert.equal(f.updates.length, 0);
    }
  });

  test(`${browser}: unknown update outcome or failed receipt is never replayed by startup recovery`, async () => {
    for (const failure of ['update', 'receipt']) {
      const f = startupFixture(); f.setTab({ pendingUrl: undefined });
      let mutations = 0;
      f.api.tabs.update = async () => {
        mutations++;
        if (failure === 'update') throw new Error('Native update outcome unknown');
      };
      const recover = error => bootstrap.bootstrapVisionNewTab(71, error, {
        api: f.api, beforeDispatch: async () => true,
        afterDispatch: async () => { throw new Error('Receipt failed'); },
      });
      await assert.rejects(captureVisionStartup(f.observe, recover, f.options),
        failure === 'update' ? /outcome unknown/ : /Receipt failed/);
      assert.equal(mutations, 1); assert.equal(f.counts().captures, 1); assert.equal(f.waits.length, 0);
    }
  });

  test(`${browser}: another restricted capture after an acknowledged startup update cannot dispatch twice`, async () => {
    const f = startupFixture(); f.setTab({ pendingUrl: undefined });
    let updates = 0;
    f.api.tabs.update = async () => { updates++; };
    await assert.rejects(f.run(), { code: 'vision_capture_restricted_target' });
    assert.equal(updates, 1); assert.deepEqual(f.counts(), { captures: 2, recoveries: 1 });
    assert.equal(f.waits.length, 0);
  });
}

function fixture() {
  const controller = new AbortController(), calls = [];
  let tab = { id: 71, url: 'chrome://new-tab-page/' };
  const api = {
    runtime: { getURL: path => `chrome-extension://owned/${path}` },
    tabs: {
      async get(id) { assert.equal(id, 71); calls.push('get'); return { ...tab }; },
      async update(id, args) { assert.equal(id, 71); assert.deepEqual(args, { url: 'about:blank' }); calls.push('update'); tab.url = args.url; return { ...tab }; },
    },
  };
  const options = { api, signal: controller.signal,
    async beforeDispatch() { calls.push('checkpoint'); return { ok: true }; },
    async afterDispatch(result) { calls.push(result.dispatched ? 'settle-dispatched' : 'settle-not-dispatched'); return true; },
  };
  return { api, options, calls, controller, setTab(value) { tab = { ...tab, ...value }; } };
}

for (const [browser, module] of variants) {
  test(`${browser}: bootstrap allowlist contains only exact disposable new-tab surfaces`, () => {
    const runtime = fixture().api.runtime;
    for (const url of ['chrome://newtab/', 'chrome://new-tab-page/', 'edge://newtab/',
      'chrome-search://local-ntp/local-ntp.html', 'about:newtab', 'about:home',
      'chrome-extension://owned/newtab/index.html', 'chrome-extension://owned/newtab/index.html?mode=act#task'])
      assert.equal(module.isVisionBootstrapNewTab(url, runtime), true, url);
    for (const url of ['about:blank', 'about:config', 'chrome://settings/', 'chrome://extensions/',
      'chrome://new-tab-page/other', 'chrome://newtab/?url=https://owned.example/',
      'https://owned.example/', 'https://owned.example/newtab/index.html',
      'chrome-extension://other/newtab/index.html', 'chrome-extension://owned/src/ui/settings.html',
      'chrome-extension://owned/src/ui/pdf-handler.html', 'file:///C:/document.pdf', undefined])
      assert.equal(module.isVisionBootstrapNewTab(url, runtime), false, String(url));
  });

  test(`${browser}: only typed restricted initial capture permits startup recovery`, async () => {
    const f = fixture();
    for (const code of [undefined, 'vision_privacy_failed', 'vision_capture_timeout', 'vision_capture_not_ready', 'vision_capture_clipped', 'vision_capture_failed']) {
      const error = Object.assign(new Error('Cannot access a chrome:// URL'), { code });
      assert.deepEqual(await module.bootstrapVisionNewTab(71, error, f.options), { retry: false, dispatched: false });
    }
    assert.deepEqual(f.calls, [], 'No browser access or mutation for unrelated capture errors');
  });

  test(`${browser}: successful bootstrap checkpoints then rechecks and updates the same tab once`, async () => {
    const f = fixture();
    assert.deepEqual(await module.bootstrapVisionNewTab(71, restricted(), f.options), { retry: true, dispatched: true, url: 'about:blank' });
    assert.deepEqual(f.calls, ['get', 'checkpoint', 'get', 'update', 'settle-dispatched']);
  });

  test(`${browser}: restricted ordinary, settings, PDF and other-extension pages are never replaced`, async () => {
    for (const url of ['https://owned.example/', 'chrome://settings/', 'chrome-extension://other/newtab/index.html',
      'chrome-extension://owned/src/ui/pdf-handler.html']) {
      const f = fixture(); f.setTab({ url });
      assert.deepEqual(await module.bootstrapVisionNewTab(71, restricted(), f.options), { retry: false, dispatched: false });
      assert.deepEqual(f.calls, ['get']);
    }
  });

  test(`${browser}: an already pending user navigation is recaptured without any checkpoint or update`, async () => {
    const f = fixture(); f.setTab({ pendingUrl: 'https://user-selected.example/' });
    assert.deepEqual(await module.bootstrapVisionNewTab(71, restricted(), f.options), { retry: true, dispatched: false });
    assert.deepEqual(f.calls, ['get']);
  });

  test(`${browser}: navigation or target change during the durable checkpoint wins over bootstrap`, async () => {
    for (const mutation of [{ url: 'https://user-selected.example/' }, { pendingUrl: 'https://user-selected.example/' }, { id: 99 }]) {
      const f = fixture();
      f.options.beforeDispatch = async () => { f.calls.push('checkpoint'); f.setTab(mutation); return true; };
      assert.deepEqual(await module.bootstrapVisionNewTab(71, restricted(), f.options), { retry: true, dispatched: false });
      assert.deepEqual(f.calls, ['get', 'checkpoint', 'get', 'settle-not-dispatched']);
    }
  });

  test(`${browser}: Stop or steering during a checkpoint prevents startup navigation`, async () => {
    for (const kind of ['abort', 'steering']) {
      const f = fixture(); let steered = false;
      f.options.assertCurrent = () => { if (steered) throw Object.assign(new Error('Task changed'), { code: 'vision_request_steered' }); };
      f.options.beforeDispatch = async () => { f.calls.push('checkpoint'); if (kind === 'abort') f.controller.abort(); else steered = true; return true; };
      await assert.rejects(module.bootstrapVisionNewTab(71, restricted(), f.options), error => kind === 'abort'
        ? error.name === 'AbortError' : error.code === 'vision_request_steered');
      assert.deepEqual(f.calls, ['get', 'checkpoint']);
    }
  });

  test(`${browser}: missing or rejected checkpoint and a closed tab fail without navigation`, async () => {
    for (const kind of ['missing', 'rejected', 'closed']) {
      const f = fixture();
      if (kind === 'missing') delete f.options.beforeDispatch;
      if (kind === 'rejected') f.options.beforeDispatch = async () => false;
      if (kind === 'closed') f.api.tabs.get = async () => { throw new Error('No tab with id'); };
      await assert.rejects(module.bootstrapVisionNewTab(71, restricted(), f.options), error => kind === 'closed'
        ? /No tab/.test(error.message) : error.code === 'vision_checkpoint_failed');
      assert.ok(!f.calls.includes('update'));
    }
  });

  test(`${browser}: a rejected dispatched receipt remains a failure with the dispatch preserved`, async () => {
    const f = fixture(); f.options.afterDispatch = async () => false;
    await assert.rejects(module.bootstrapVisionNewTab(71, restricted(), f.options), error =>
      error.code === 'vision_checkpoint_failed' && error.dispatched === true && error.noDispatch === false);
    assert.equal(f.calls.filter(value => value === 'update').length, 1);
  });

  test(`${browser}: Firefox startup requires a registered unique blank context and validates its destination`, async () => {
    const destination = 'about:blank#wb-vision-12345678-1234-1234-1234-123456789abc';
    const f = fixture();
    f.api.runtime.getURL = path => `moz-extension://owned/${path}`;
    f.setTab({ url: 'about:newtab' });
    assert.deepEqual(await module.bootstrapVisionNewTab(71, restricted(), f.options), { retry: false, dispatched: false });
    assert.deepEqual(f.calls, ['get'], 'Missing companion bootstrap support must not replace the tab');
    f.calls.length = 0;
    f.options.prepareDestination = async id => { assert.equal(id, 71); f.calls.push('prepare-owned-context'); return { url: destination }; };
    f.api.tabs.update = async (id, args) => { assert.equal(id, 71); assert.equal(args.url, destination); f.calls.push('update'); };
    assert.deepEqual(await module.bootstrapVisionNewTab(71, restricted(), f.options), { retry: true, dispatched: true, url: destination });
    assert.deepEqual(f.calls, ['get', 'checkpoint', 'prepare-owned-context', 'get', 'update', 'settle-dispatched']);
    for (const url of ['about:blank', 'https://owned.example/', 'about:blank#wb-vision-not-a-uuid']) {
      f.calls.length = 0; f.options.prepareDestination = async () => ({ url });
      await assert.rejects(module.bootstrapVisionNewTab(71, restricted(), f.options), error => error.code === 'vision_bootstrap_unavailable');
      assert.ok(!f.calls.includes('update'));
    }
  });

  test(`${browser}: old companion, Stop or user navigation during Firefox context registration prevents blank overwrite`, async () => {
    for (const scenario of ['unsupported', 'abort', 'navigation']) {
      const f = fixture(); f.api.runtime.getURL = path => `moz-extension://owned/${path}`; f.setTab({ url: 'about:home' });
      f.options.prepareDestination = async () => {
        if (scenario === 'unsupported') throw new Error('Companion does not support vision startup binding');
        if (scenario === 'abort') f.controller.abort();
        if (scenario === 'navigation') f.setTab({ pendingUrl: 'https://user-selected.example/' });
        return { url: 'about:blank#wb-vision-12345678-1234-1234-1234-123456789abc' };
      };
      if (scenario === 'navigation') assert.deepEqual(await module.bootstrapVisionNewTab(71, restricted(), f.options), { retry: true, dispatched: false });
      else await assert.rejects(module.bootstrapVisionNewTab(71, restricted(), f.options), scenario === 'abort'
        ? { name: 'AbortError' } : /does not support/);
      assert.ok(!f.calls.includes('update'));
    }
  });
}

test('startup bootstrap policy is identical in both browser builds', async () => {
  assert.equal(await readFile(new URL('../src/chrome/src/agent/vision-bootstrap.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/firefox/src/agent/vision-bootstrap.js', import.meta.url), 'utf8'));
});
