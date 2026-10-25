import assert from 'node:assert/strict';
import { test } from 'node:test';

let lookup = async id => ({ id, status: 'complete' });
const api = {
  runtime: { getURL: path => `chrome-extension://privacy-test/${path}` },
  storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
  tabs: { get: id => lookup(id) },
};
globalThis.browser = globalThis.chrome = api;
const IMAGE = 'data:image/png;base64,c2FmZQ==';
const viewport = { width: 800, height: 600, documentId: 'private-document', url: 'https://owned.test/' };
const snapshot = { coordinateSpace: 'page', regions: [] };

for (const build of ['chrome', 'firefox']) {
  const { captureVisionPrivacySnapshot, redactVisionCapture } = await import(`../src/${build}/src/agent/vision-redaction.js`);
  const { VisionBrowser, isTransientVisionCaptureError } = await import(`../src/${build}/src/agent/vision-browser.js`);
  const { captureVisionObservation } = await import(`../src/${build}/src/agent/vision-act.js`);

  function fixture(scan) {
    const counts = { scans: 0, captures: 0, masks: 0, inputs: 0 };
    const agent = { screenshotRedaction: true, captureScreenshotRedactionSnapshotForUser: async (id, options) => {
      counts.scans++;
      assert.equal(id, 15);
      assert.deepEqual(options, { coordinateSpace: 'page' });
      return scan(counts.scans);
    } };
    let beforeSnapshot;
    const browser = new VisionBrowser({
      transport: {
        readViewport: async () => ({ ...viewport }),
        capture: async () => { counts.captures++; return IMAGE; },
        sendInput: async () => { counts.inputs++; },
      },
      withCapture: async (id, capture) => {
        beforeSnapshot = await captureVisionPrivacySnapshot(agent, id);
        try { return await capture(); } finally { beforeSnapshot = null; }
      },
      redact: async (_id, dataUrl) => {
        assert.equal(beforeSnapshot, snapshot, 'A successful privacy scan is required before pixels can return');
        counts.masks++;
        return dataUrl;
      },
    });
    return { agent, browser, counts };
  }

  test(`${build}: missing privacy snapshot on a loading tab retries observation and returns only after a successful scan`, async () => {
    let lookups = 0;
    lookup = async id => { lookups++; return { id, status: 'loading' }; };
    const { browser, counts } = fixture(attempt => attempt === 1 ? { ok: false } : { ok: true, snapshot });
    const waits = [], failures = [];
    const result = await captureVisionObservation(browser, 15, {
      wait: async delay => waits.push(delay),
      onFailure: (error, detail) => failures.push({ code: error.code, ...detail }),
    });
    assert.equal(result.dataUrl, IMAGE);
    assert.equal(result.attempts, 2);
    assert.deepEqual(waits, [150]);
    assert.equal(failures[0].code, 'vision_capture_not_ready');
    assert.equal(failures[0].retry, true);
    assert.equal(lookups, 1);
    assert.deepEqual(counts, { scans: 2, captures: 1, masks: 1, inputs: 0 });
  });

  test(`${build}: missing privacy snapshots exhaust the bounded observation retry without capturing or replaying input`, async () => {
    lookup = async id => ({ id, status: 'loading' });
    const { browser, counts } = fixture(() => ({ ok: false }));
    const waits = [], failures = [];
    await assert.rejects(captureVisionObservation(browser, 15, {
      wait: async delay => waits.push(delay),
      onFailure: (_error, detail) => failures.push(detail),
    }), error => error.code === 'vision_capture_not_ready');
    assert.deepEqual(waits, [150, 300, 600, 1000, 1000, 1000, 1000]);
    assert.deepEqual(failures.map(item => item.retry), [true, true, true, true, true, true, true, false]);
    assert.deepEqual(counts, { scans: 8, captures: 0, masks: 0, inputs: 0 });
  });

  test(`${build}: privacy content scripts becoming ready after two seconds survive the former four-attempt window`, async context => {
    let elapsed = 0;
    context.mock.method(Date, 'now', () => 1792893500000 + elapsed);
    try {
      lookup = async id => ({ id, status: elapsed < 2000 ? 'loading' : 'complete' });
      const { browser, counts } = fixture(() => elapsed < 2000 ? { ok: false } : { ok: true, snapshot });
      const waits = [];
      const result = await captureVisionObservation(browser, 15, {
        wait: async milliseconds => { waits.push(milliseconds); elapsed += milliseconds; },
      });
      assert.equal(result.dataUrl, IMAGE);
      assert.equal(result.attempts, 5);
      assert.equal(result.captureMs, 2050);
      assert.deepEqual(waits, [150, 300, 600, 1000]);
      assert.deepEqual(counts, { scans: 5, captures: 1, masks: 1, inputs: 0 });
    } finally { context.mock.restoreAll(); }
  });

  test(`${build}: an eight-second failed privacy scan exhausts the elapsed recovery budget without another wait or action`, async context => {
    let elapsed = 0;
    context.mock.method(Date, 'now', () => 1792893500000 + elapsed);
    try {
      lookup = async id => ({ id, status: 'loading' });
      const { browser, counts } = fixture(() => { elapsed = 8000; return { ok: false }; });
      const failures = [];
      await assert.rejects(captureVisionObservation(browser, 15, {
        wait: async () => assert.fail('The elapsed recovery budget must stop before another wait'),
        onFailure: (_error, detail) => failures.push(detail),
      }), error => error.code === 'vision_capture_not_ready');
      assert.deepEqual(failures, [{ attempt: 1, retry: false, durationMs: 8000 }]);
      assert.deepEqual(counts, { scans: 1, captures: 0, masks: 0, inputs: 0 });
    } finally { context.mock.restoreAll(); }
  });

  test(`${build}: closed, completed, discarded, mismatched and inaccessible tabs keep missing privacy scans permanent`, async () => {
    for (const tab of [
      { id: 15, status: 'complete' }, { id: 16, status: 'loading' }, { id: 15, status: 'loading', discarded: true },
      { id: 15 }, null, new Error('No tab with id: 15'), new Error('Permission denied'),
    ]) {
      lookup = async () => { if (tab instanceof Error) throw tab; return tab; };
      const { browser, counts } = fixture(() => ({ ok: false }));
      await assert.rejects(captureVisionObservation(browser, 15, {
        wait: async () => assert.fail('Permanent privacy failure must not retry'),
      }), error => error.code === 'vision_privacy_scan_failed' && !isTransientVisionCaptureError(error));
      assert.deepEqual(counts, { scans: 1, captures: 0, masks: 0, inputs: 0 });
    }
  });

  test(`${build}: explicit scan errors and malformed snapshots stay permanent even while the tab is loading`, async () => {
    let lookups = 0;
    lookup = async id => { lookups++; return { id, status: 'loading' }; };
    const denied = new Error('Permission denied');
    for (const scan of [
      { ok: false, error: 'Permission denied' }, { ok: false, code: 'tab_closed' },
      { ok: true, snapshot: { coordinateSpace: 'viewport', regions: [] } },
      { ok: false, snapshot }, denied,
    ]) {
      const { browser, counts } = fixture(() => { if (scan instanceof Error) throw scan; return scan; });
      await assert.rejects(captureVisionObservation(browser, 15, {
        wait: async () => assert.fail('Explicit privacy failure must not retry'),
      }), error => !isTransientVisionCaptureError(error)
        && (scan instanceof Error ? error === denied : error.code === 'vision_privacy_scan_failed'));
      assert.deepEqual(counts, { scans: 1, captures: 0, masks: 0, inputs: 0 });
    }
    assert.equal(lookups, 0, 'Explicit scan failures must not be reclassified by tab state');
  });

  test(`${build}: post-capture missing privacy scan rejects pixels and is retryable only with loading evidence`, async () => {
    const { agent } = fixture(() => ({ ok: false }));
    lookup = async id => ({ id, status: 'loading' });
    await assert.rejects(redactVisionCapture(agent, 15, IMAGE, viewport, snapshot),
      error => error.code === 'vision_capture_not_ready');
    lookup = async id => ({ id, status: 'complete' });
    await assert.rejects(redactVisionCapture(agent, 15, IMAGE, viewport, snapshot),
      error => error.code === 'vision_privacy_scan_failed');
  });

  test(`${build}: disabled privacy does not scan and pixel processing failures never become navigation retries`, async () => {
    let lookups = 0;
    lookup = async id => { lookups++; return { id, status: 'loading' }; };
    const { agent, counts } = fixture(() => ({ ok: true, snapshot }));
    agent.screenshotRedaction = false;
    assert.equal(await captureVisionPrivacySnapshot(agent, 15), null);
    assert.equal(counts.scans, 0);
    agent.screenshotRedaction = true;
    const previousBitmap = globalThis.createImageBitmap;
    const encodingFailure = new Error('Screenshot privacy encoding failed');
    globalThis.createImageBitmap = async () => { throw encodingFailure; };
    try {
      await assert.rejects(redactVisionCapture(agent, 15, IMAGE, viewport, snapshot),
        error => error === encodingFailure && !isTransientVisionCaptureError(error));
    } finally {
      if (previousBitmap === undefined) delete globalThis.createImageBitmap;
      else globalThis.createImageBitmap = previousBitmap;
    }
    assert.equal(lookups, 0, 'Privacy disabled and masking failures must not query tab readiness');
  });
}
