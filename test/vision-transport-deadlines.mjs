import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { firefoxBidi } from '../src/firefox/src/bidi/client.js';
import { createVisionTransport as chromeTransport, isTransientVisionCaptureError } from '../src/chrome/src/agent/vision-transport.js';
import { createVisionTransport as firefoxTransport } from '../src/firefox/src/agent/vision-transport.js';
import { VisionBrowser as ChromeBrowser } from '../src/chrome/src/agent/vision-browser.js';
import { VisionBrowser as FirefoxBrowser } from '../src/firefox/src/agent/vision-browser.js';

const view = { width: 800, height: 600, devicePixelRatio: 1, scale: 1, zoom: 1,
  offsetLeft: 0, offsetTop: 0, scrollX: 0, scrollY: 0, documentId: 'owned-document', url: 'https://owned.example/' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const drain = async predicate => {
  for (let index = 0; index < 100 && !predicate(); index++) await Promise.resolve();
  assert.ok(predicate(), 'The expected read stage was reached without advancing time');
};
const aborted = error => error.name === 'AbortError' && error.code === 'vision_aborted' && !isTransientVisionCaptureError(error);
const timedOut = error => error.code === 'vision_capture_timeout' && !isTransientVisionCaptureError(error);

function fixture(t, engine, { pendingBinding = false, pendingGeometry = false, pendingSendFence = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const controller = new AbortController(), screenshot = deferred(), binding = deferred(), geometry = deferred(), fence = deferred();
  const counts = { bindings: 0, reads: 0, screenshots: 0, native: 0, pixels: 0, redactions: 0, model: 0, sendFence: 0 };
  const tabId = 76543;
  if (engine === 'chrome') {
    t.mock.method(cdpClient, 'attach', async () => { counts.bindings++; if (pendingBinding) await binding.promise; });
    t.mock.method(cdpClient, 'sendCommand', async (_tab, method, _params, _session, options) => {
      if (pendingSendFence) { counts.sendFence++; await fence.promise; }
      options?.beforeSend?.();
      counts.reads++;
      if (method === 'Page.captureScreenshot') { counts.screenshots++; return screenshot.promise; }
      if (pendingGeometry) return geometry.promise;
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600,
        offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1, zoom: 1 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId: view.documentId, url: view.url } } };
      if (method === 'Runtime.evaluate') return { result: { value: view } };
      throw new Error('Unexpected read: ' + method);
    });
  } else {
    const owner = { runId: 'owned-run', bound: true, signal: controller.signal };
    firefoxBidi.runs.set(tabId, owner);
    t.after(() => firefoxBidi.runs.delete(tabId));
    t.mock.method(firefoxBidi, 'bindRun', async () => { counts.bindings++; if (pendingBinding) await binding.promise; });
    t.mock.method(firefoxBidi, 'request', async command => {
      counts.reads++;
      if (command === 'visionCapture') { counts.screenshots++; return screenshot.promise; }
      if (command === 'visionViewport') return pendingGeometry ? geometry.promise : view;
      throw new Error('Unexpected request: ' + command);
    });
  }
  const transport = (engine === 'chrome' ? chromeTransport : firefoxTransport)({ signal: controller.signal, viewportExpression: 'owned geometry' });
  t.mock.method(transport, 'sendInput', async () => { counts.native++; });
  const Browser = engine === 'chrome' ? ChromeBrowser : FirefoxBrowser;
  const browser = new Browser({ transport, signal: controller.signal, redact: async (_tab, data) => { counts.redactions++; return data; } });
  const frames = { assertViewport() {}, toCssPoint: () => ({ x: 30, y: 40 }), assertCurrentPixels: async () => { counts.pixels++; } };
  const captureForModel = () => browser.capture(tabId).then(value => { counts.model++; return value; });
  return { browser, transport, controller, counts, screenshot, binding, geometry, fence, frames, tabId, captureForModel };
}

for (const engine of ['chrome', 'firefox']) {
  test(`${engine}: Stop immediately abandons a hung screenshot and discards late pixels`, async t => {
    const run = fixture(t, engine);
    const pending = run.captureForModel();
    await drain(() => run.counts.screenshots === 1);
    const rejection = assert.rejects(pending, aborted);
    run.controller.abort();
    await rejection;
    assert.equal(run.browser.capturing.size, 0);
    run.screenshot.resolve({ data: 'bGF0ZSBwaXhlbHM=' });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(run.counts.redactions, 0); assert.equal(run.counts.model, 0); assert.equal(run.counts.native, 0);
  });

  test(`${engine}: a hung screenshot has a permanent 15-second deadline and never retries`, async t => {
    const run = fixture(t, engine);
    const pending = run.captureForModel();
    await drain(() => run.counts.screenshots === 1);
    const rejection = assert.rejects(pending, timedOut);
    t.mock.timers.tick(15000);
    await rejection;
    assert.equal(run.browser.capturing.size, 0);
    // A late transport failure is consumed, not an unhandled rejection or a
    // retry that could turn the previously failed observation into success.
    run.screenshot.reject(new Error('Late compositor response'));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(run.counts.screenshots, 1); assert.equal(run.counts.redactions, 0);
    assert.equal(run.counts.model, 0); assert.equal(run.counts.native, 0);
  });

  for (const reason of ['abort', 'deadline']) {
    test(`${engine}: ${reason} during attach/bind prevents a late screenshot request`, async t => {
      const run = fixture(t, engine, { pendingBinding: true });
      const pending = run.transport.capture(run.tabId, view);
      await drain(() => run.counts.bindings > 0);
      const rejection = assert.rejects(pending, reason === 'abort' ? aborted : timedOut);
      if (reason === 'abort') run.controller.abort(); else t.mock.timers.tick(15000);
      await rejection;
      run.binding.resolve();
      for (let index = 0; index < 10; index++) await Promise.resolve();
      assert.equal(run.counts.reads, 0); assert.equal(run.counts.screenshots, 0); assert.equal(run.counts.native, 0);
    });
  }

  test(`${engine}: binding and response share one total read deadline`, async t => {
    const run = fixture(t, engine, { pendingBinding: true });
    const pending = run.transport.capture(run.tabId, view);
    await drain(() => run.counts.bindings > 0);
    t.mock.timers.tick(14999);
    run.binding.resolve();
    await drain(() => run.counts.screenshots === 1);
    const rejection = assert.rejects(pending, timedOut);
    t.mock.timers.tick(1); await rejection;
    assert.equal(run.counts.screenshots, 1); assert.equal(run.counts.native, 0);
  });

  test(`${engine}: hung geometry is abortable before any screenshot or model request`, async t => {
    const run = fixture(t, engine, { pendingGeometry: true });
    const pending = run.captureForModel();
    await drain(() => run.counts.reads > 0);
    const rejection = assert.rejects(pending, aborted);
    run.controller.abort(); await rejection;
    run.geometry.resolve({ result: { value: view } });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(run.counts.screenshots, 0); assert.equal(run.counts.model, 0); assert.equal(run.counts.native, 0);
  });

  test(`${engine}: Stop during a click's screenshot preflight sends no native input`, async t => {
    const run = fixture(t, engine);
    const pending = run.browser.perform(run.tabId, 'click', { frameId: 'owned-frame', x: 30, y: 40 }, run.frames);
    await drain(() => run.counts.screenshots === 1);
    run.controller.abort();
    const result = await pending;
    assert.equal(result.success, false); assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false);
    assert.equal(result.code, 'vision_aborted');
    run.screenshot.resolve({ data: 'bGF0ZSBwaXhlbHM=' });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    assert.equal(run.counts.native, 0); assert.equal(run.counts.pixels, 0);
    assert.equal(run.browser.acting.size, 0); assert.equal(run.browser.capturing.size, 0);
  });

  test(`${engine}: an already stopped run never starts an observation`, async t => {
    const run = fixture(t, engine);
    run.controller.abort();
    await assert.rejects(run.transport.capture(run.tabId, view), aborted);
    assert.equal(run.counts.bindings, 0); assert.equal(run.counts.reads, 0);
  });
}

test('Chrome: a late CDP preparation fence cannot send a read after its deadline', async t => {
  const run = fixture(t, 'chrome', { pendingSendFence: true });
  const pending = run.transport.capture(run.tabId, view);
  await drain(() => run.counts.sendFence === 1);
  const rejection = assert.rejects(pending, timedOut);
  t.mock.timers.tick(15000); await rejection;
  run.fence.resolve();
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(run.counts.reads, 0); assert.equal(run.counts.screenshots, 0); assert.equal(run.counts.native, 0);
});

test('Chrome: ambiguous-navigation live-tab proof stays inside the observation deadline', async t => {
  const run = fixture(t, 'chrome'), tab = deferred(), previousChrome = globalThis.chrome;
  let proofs = 0;
  globalThis.chrome = { tabs: { get: () => { proofs++; return tab.promise; } } };
  t.after(() => { globalThis.chrome = previousChrome; });
  t.mock.method(cdpClient, 'sendCommand', async () => { throw new Error('Inspected target navigated or closed'); });
  const pending = run.transport.capture(run.tabId, view);
  await drain(() => proofs === 1);
  const rejection = assert.rejects(pending, timedOut);
  t.mock.timers.tick(15000); await rejection;
  tab.resolve({ id: run.tabId });
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(proofs, 1); assert.equal(run.counts.model, 0); assert.equal(run.counts.native, 0);
});

for (const [method, message, stage, reason, code] of [
  ['attach', 'Cannot access a chrome:// URL; private detail https://private.test/', 'debugger_attach', 'restricted_target', 'vision_capture_restricted_target'],
  ['attach', 'Another debugger is already attached to the tab', 'debugger_attach', 'debugger_conflict', undefined],
  ['attach', 'Permission denied for https://private.test/', 'debugger_attach', 'permission_denied', undefined],
  ['attach', 'Cannot access a restricted page', 'debugger_attach', 'restricted_target', undefined],
  ['Page.getLayoutMetrics', 'No tab with id: 999', 'viewport_metrics', 'tab_closed', undefined],
  ['Page.getFrameTree', 'Cannot find context with specified id', 'document_tree', 'context_changed', 'vision_capture_context_changed'],
  ['Runtime.evaluate', 'Execution context was destroyed.', 'viewport_evaluate', 'context_changed', 'vision_capture_context_changed'],
  ['Page.captureScreenshot', 'Unable to capture screenshot', 'screenshot', 'not_ready', 'vision_capture_not_ready'],
  ['Page.captureScreenshot', 'Unexpected protocol failure containing PRIVATE', 'screenshot', 'unknown', undefined],
]) test(`Chrome capture diagnostics identify ${stage}/${reason} without changing retry policy`, async t => {
  const run = fixture(t, 'chrome'), original = cdpClient.sendCommand;
  const native = Object.assign(new Error(message), { captureDiagnostics: { stage: 'PRIVATE', browser: 'PRIVATE', reason: 'PRIVATE', url: 'https://private.test/' } });
  if (method === 'attach') t.mock.method(cdpClient, 'attach', async () => { throw native; });
  else t.mock.method(cdpClient, 'sendCommand', async (...args) => {
    if (args[1] === method) throw native;
    return original(...args);
  });
  const operation = method === 'Page.captureScreenshot' ? run.transport.capture(run.tabId, view) : run.transport.readViewport(run.tabId);
  await assert.rejects(operation, error => {
    assert.equal(error, native); assert.equal(error.code, code);
    assert.deepEqual(error.captureDiagnostics, { browser: 'chrome', stage, reason });
    assert.doesNotMatch(JSON.stringify(error.captureDiagnostics), /PRIVATE|private|https:|url|message/);
    assert.equal(isTransientVisionCaptureError(error), ['vision_capture_context_changed', 'vision_capture_not_ready'].includes(code));
    return true;
  });
  assert.equal(run.counts.native, 0);
});

for (const [boundary, message, stage, reason, code] of [
  ['start', 'Permission denied by companion', 'companion_start', 'permission_denied', undefined],
  ['bind', 'No tab with id: 999', 'companion_bind', 'tab_closed', undefined],
  ['visionViewport', 'no such realm', 'viewport_native', 'context_changed', 'vision_capture_context_changed'],
  ['visionCapture', 'Unable to capture screenshot', 'screenshot', 'not_ready', 'vision_capture_not_ready'],
]) test(`Firefox capture diagnostics identify ${stage}/${reason} without changing retry policy`, async t => {
  const run = fixture(t, 'firefox'), native = new Error(message), request = firefoxBidi.request;
  if (boundary === 'start') {
    firefoxBidi.runs.delete(run.tabId);
    t.mock.method(firefoxBidi, 'startRun', async () => { throw native; });
  } else if (boundary === 'bind') t.mock.method(firefoxBidi, 'bindRun', async () => { throw native; });
  else t.mock.method(firefoxBidi, 'request', async (...args) => {
    if (args[0] === boundary) throw native;
    return request(...args);
  });
  const operation = boundary === 'visionCapture' ? run.transport.capture(run.tabId) : run.transport.readViewport(run.tabId);
  await assert.rejects(operation, error => {
    assert.equal(error, native); assert.equal(error.code, code);
    assert.deepEqual(error.captureDiagnostics, { browser: 'firefox', stage, reason });
    assert.equal(isTransientVisionCaptureError(error), ['vision_capture_context_changed', 'vision_capture_not_ready'].includes(code));
    return true;
  });
  assert.equal(run.counts.native, 0);
});

for (const engine of ['chrome', 'firefox']) for (const pendingBinding of [false, true]) {
  test(`${engine}: deadline and Stop retain the active ${pendingBinding ? 'attachment' : 'screenshot'} boundary`, async t => {
    const run = fixture(t, engine, { pendingBinding });
    const pending = run.transport.capture(run.tabId, view);
    await drain(() => pendingBinding ? run.counts.bindings > 0 : run.counts.screenshots === 1);
    const stage = pendingBinding ? engine === 'chrome' ? 'debugger_attach' : 'companion_bind' : 'screenshot';
    const rejection = assert.rejects(pending, error => {
      assert.equal(timedOut(error), true);
      assert.deepEqual(error.captureDiagnostics, { browser: engine, stage, reason: 'timeout' }); return true;
    });
    t.mock.timers.tick(15000); await rejection;
    // Stop is still a distinct permanent outcome, even on the same transport.
    run.controller.abort();
    await assert.rejects(run.transport.capture(run.tabId, view), error => {
      assert.equal(aborted(error), true);
      assert.deepEqual(error.captureDiagnostics, { browser: engine,
        stage: engine === 'chrome' ? 'debugger_attach' : 'companion_bind', reason: 'cancelled' }); return true;
    });
  });
}

test('Firefox: an enabled unbound owner is restricted, while an unavailable companion keeps its ordinary failure', async t => {
  const run = fixture(t, 'firefox'), owner = firefoxBidi.runs.get(run.tabId);
  owner.bound = false;
  await assert.rejects(run.transport.readViewport(run.tabId), error => {
    assert.equal(error.code, 'vision_capture_restricted_target');
    assert.deepEqual(error.captureDiagnostics, { browser: 'firefox', stage: 'companion_bind', reason: 'restricted_target' });
    assert.equal(isTransientVisionCaptureError(error), false); return true;
  });
  owner.disconnected = true;
  await assert.rejects(run.transport.readViewport(run.tabId), error => {
    assert.equal(error.code, undefined); assert.match(error.message, /trusted automation companion/);
    assert.equal(error.captureDiagnostics.reason, 'unknown'); return true;
  });
  assert.equal(run.counts.reads, 0);
});

for (const terminal of ['success', 'abort', 'timeout']) {
  test(`Firefox: startup preparation is guarded through ${terminal} and never dispatches input`, async t => {
    const run = fixture(t, 'firefox'), prepared = deferred();
    let calls = 0;
    t.mock.method(firefoxBidi, 'prepareVisionStartup', async tabId => { assert.equal(tabId, run.tabId); calls++; return prepared.promise; });
    const pending = run.transport.prepareStartupBootstrap(run.tabId);
    await drain(() => calls === 1);
    if (terminal === 'success') {
      prepared.resolve({ url: 'about:blank#wb-vision-owned' });
      assert.deepEqual(await pending, { url: 'about:blank#wb-vision-owned' });
    } else {
      const rejected = assert.rejects(pending, error => {
        assert.equal((terminal === 'abort' ? aborted : timedOut)(error), true);
        assert.deepEqual(error.captureDiagnostics, { browser: 'firefox', stage: 'companion_bind',
          reason: terminal === 'abort' ? 'cancelled' : 'timeout' }); return true;
      });
      if (terminal === 'abort') run.controller.abort(); else t.mock.timers.tick(15000);
      await rejected;
      prepared.resolve({ url: 'about:blank#wb-vision-late' });
      await Promise.resolve(); await Promise.resolve();
    }
    assert.equal(calls, 1); assert.equal(run.counts.native, 0); assert.equal(run.counts.screenshots, 0);
  });
}
