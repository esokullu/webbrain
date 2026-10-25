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
