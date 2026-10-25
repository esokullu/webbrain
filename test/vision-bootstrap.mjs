import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const restricted = () => Object.assign(new Error('Browser protects this target'), { code: 'vision_capture_restricted_target' });
const variants = await Promise.all(['chrome', 'firefox'].map(async browser => [browser,
  await import(`../src/${browser}/src/agent/vision-bootstrap.js`)]));

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
