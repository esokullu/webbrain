import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { VisionBrowser, sameVisionViewport, visionKeyChord, isTransientVisionCaptureError } from '../src/chrome/src/agent/vision-browser.js';
import { VisionBrowser as FirefoxVisionBrowser } from '../src/firefox/src/agent/vision-browser.js';
import { VisionFrameSession, normalizeVisionViewport } from '../src/chrome/src/agent/vision-frames.js';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { createVisionTransport, visionPngDimensions, classifyVisionCaptureError } from '../src/chrome/src/agent/vision-transport.js';
import { classifyVisionCaptureError as classifyFirefoxCaptureError } from '../src/firefox/src/agent/vision-transport.js';
import { readVisionViewport, performVisionInput, captureVision } from '../firefox-companion/vision.mjs';

const viewport = { width: 800, height: 600, devicePixelRatio: 2, scale: 1, zoom: 1,
  offsetLeft: 0, offsetTop: 0, scrollX: 0, scrollY: 0, documentId: 'document-1', url: 'https://vision.test/', platform: 'Win32' };
function frame(view = viewport, width = 800, height = 600) {
  const session = new VisionFrameSession();
  // Pixel freshness has separate real-canvas coverage in vision-frames.mjs;
  // these retained-frame fixtures isolate coordinate/native input behavior.
  session.assertCurrentPixels = async () => true;
  session.latest = { frameId: 'frame-1', viewport: normalizeVisionViewport(view), canvas: { width, height }, images: [] };
  return session;
}
function fake(Browser = VisionBrowser, options = {}) {
  const calls = [];
  const transport = { readViewport: async () => ({ ...viewport }), capture: async () => 'data:image/png;base64,aGVsbG8=',
    sendInput: async (_tab, method, params) => { calls.push({ method, ...params }); } };
  return { calls, transport, browser: new Browser({ transport, ...options }) };
}
for (const Browser of [VisionBrowser, FirefoxVisionBrowser]) {
  test(`${Browser === VisionBrowser ? 'Chrome' : 'Firefox'} adapter maps retained crop pixels and dispatches trusted coordinates only`, async () => {
    const { browser, calls } = fake(Browser);
    const frames = frame(viewport, 400, 300);
    frames.latest.images.push({ id: 'crop', width: 50, height: 25, rect: { x: 100, y: 50, width: 100, height: 50 } });
    const result = await browser.perform(1, 'click', { frameId: 'frame-1', imageId: 'crop', x: 25, y: 10 }, frames);
    assert.equal(result.success, true);
    assert.deepEqual(result.point, { x: 300, y: 140 });
    assert.deepEqual(calls.map(call => call.type), ['mousePressed', 'mouseReleased']);
    assert.equal(calls[0].x, 300);
  });
}
test('capture rejects a resize/navigation during image transfer and redacts before return', async () => {
  const { browser, transport } = fake();
  let reads = 0;
  transport.readViewport = async () => ({ ...viewport, width: ++reads === 1 ? 800 : 900 });
  await assert.rejects(browser.capture(1), /changed during screenshot/);
  transport.readViewport = async () => ({ ...viewport });
  browser.redact = async (_tab, image, metadata) => { assert.equal(metadata.devicePixelRatio, 2); return image.replace('aGVsbG8=', 'cmVkYWN0ZWQ='); };
  assert.match((await browser.capture(1)).dataUrl, /cmVkYWN0ZWQ=/);
});
test('only recognized read-only capture transitions are retryable across both browser transports', () => {
  for (const classify of [classifyVisionCaptureError, classifyFirefoxCaptureError]) {
    for (const [message, code] of [
      ['Execution context was destroyed.', 'vision_capture_context_changed'],
      ['Cannot find context with specified id', 'vision_capture_context_changed'],
      ['no such realm', 'vision_capture_context_changed'],
      ['Page changed during screenshot capture', 'vision_stale_frame'],
      ['Unable to capture screenshot', 'vision_capture_not_ready'],
      ['Cannot read Firefox viewport geometry', 'vision_capture_not_ready'],
    ]) {
      const error = classify(new Error(message));
      assert.equal(error.code, code); assert.equal(isTransientVisionCaptureError(error), true);
    }
    for (const message of ['No tab with id: 15', 'Target closed', 'Debugger not attached', 'Permission denied',
      'Cannot access a restricted page', 'Firefox companion disconnected', 'Screenshot privacy scan failed',
      'Screenshot privacy encoding failed', 'Unexpected protocol error', 'Inspected target navigated or closed']) {
      assert.equal(isTransientVisionCaptureError(classify(new Error(message))), false, message);
    }
    assert.equal(isTransientVisionCaptureError(classify(Object.assign(new Error('Unable to capture screenshot'), { name: 'AbortError' }))), false);
    assert.equal(isTransientVisionCaptureError(classify(Object.assign(new Error('Unable to capture screenshot'), { code: 'vision_capture_clipped' }))), false);
  }
});
test('capture leaves privacy failures permanent and rejects incomplete geometry with a typed transient code', async () => {
  const { browser, transport } = fake();
  transport.readViewport = async () => ({ ...viewport, width: 0 });
  await assert.rejects(browser.capture(1), error => error.code === 'vision_capture_not_ready');
  transport.readViewport = async () => ({ ...viewport });
  const privacyError = new Error('Unable to capture screenshot privacy scan');
  browser.redact = async () => { throw privacyError; };
  await assert.rejects(browser.capture(1), error => error === privacyError && !isTransientVisionCaptureError(error));
});
test('ambiguous CDP navigation-or-closure errors retry only with a live tab', async () => {
  const previousChrome = globalThis.chrome;
  let live = true;
  globalThis.chrome = { runtime: { lastError: null }, tabs: { get: async id => {
    if (!live) throw new Error('No tab with that id'); return { id };
  } }, debugger: { sendCommand(_target, _method, _params, callback) {
    globalThis.chrome.runtime.lastError = { message: 'Inspected target navigated or closed' };
    callback(); globalThis.chrome.runtime.lastError = null;
  } } };
  cdpClient.sessions.set(103, { attached: true });
  try {
    const transport = createVisionTransport({});
    await assert.rejects(transport.capture(103, viewport), error => error.code === 'vision_capture_context_changed');
    live = false;
    await assert.rejects(transport.capture(103, viewport), error => !isTransientVisionCaptureError(error));
  } finally { globalThis.chrome = previousChrome; cdpClient.sessions.delete(103); }
});
test('capture fences navigation during privacy work and hides indicators for both ordinary and action preflight screenshots', async () => {
  let hidden = false, wraps = 0, redacted = false;
  const { browser, transport } = fake(VisionBrowser, {
    withCapture: async (_tab, capture) => { hidden = true; wraps++; try { return await capture(); } finally { hidden = false; } },
    redact: async (_tab, data) => { redacted = true; return data; },
  });
  transport.capture = async () => { assert.equal(hidden, true); return 'data:image/png;base64,aGVsbG8='; };
  transport.readViewport = async () => ({ ...viewport, documentId: redacted ? 'navigated' : viewport.documentId });
  await assert.rejects(browser.capture(1), /finalizing screenshot/);
  assert.equal(hidden, false);
  browser.redact = undefined;
  transport.readViewport = async () => ({ ...viewport });
  const frames = frame();
  let freshnessChecks = 0;
  frames.assertCurrentPixels = async () => { freshnessChecks++; };
  assert.equal((await browser.perform(1, 'click', { frameId: 'frame-1', x: 10, y: 10 }, frames)).success, true);
  assert.equal(freshnessChecks, 1);
  assert.equal(wraps, 2);
});
for (const Browser of [VisionBrowser, FirefoxVisionBrowser]) {
  test(`${Browser === VisionBrowser ? 'Chrome' : 'Firefox'} screenshot privacy predicate skips inactive processing and can require a fresh capture`, async () => {
    let reads = 0, redactions = 0, enabled = false, policyChanged = false;
    const { browser, transport, calls } = fake(Browser, {
      shouldRedact: tabId => {
        assert.equal(tabId, 1);
        assert.equal(reads, enabled ? 4 : 2, 'Policy is evaluated immediately after screenshot geometry is checked');
        if (policyChanged) throw Object.assign(new Error('Privacy setting changed'), { code: 'vision_stale_frame' });
        return enabled;
      },
      redact: async (_tabId, dataUrl) => { redactions++; return dataUrl; },
    });
    transport.readViewport = async () => { reads++; return { ...viewport }; };
    await browser.capture(1);
    assert.equal(reads, 2);
    assert.equal(redactions, 0);
    enabled = true;
    await browser.capture(1);
    assert.equal(reads, 5);
    assert.equal(redactions, 1);
    reads = 0;
    enabled = false;
    policyChanged = true;
    await assert.rejects(browser.capture(1), error => isTransientVisionCaptureError(error));
    assert.equal(reads, 2);
    assert.equal(redactions, 1, 'Changed policy rejects before processing pixels from the old policy');
    assert.deepEqual(calls, []);
  });
  test(`${Browser === VisionBrowser ? 'Chrome' : 'Firefox'} final screenshot geometry fence retries without input for masked and identity redaction`, async () => {
    for (const masking of [true, false]) {
      let reads = 0, redactions = 0, captures = 0;
      const { browser, transport, calls } = fake(Browser, {
        redact: async (_tabId, dataUrl) => {
          redactions++;
          assert.equal(reads, redactions === 1 ? 2 : 5, 'Final geometry is read after the redaction callback');
          return masking ? dataUrl.replace('aGVsbG8=', 'cmVkYWN0ZWQ=') : dataUrl;
        },
      });
      transport.readViewport = async () => ({ ...viewport, scrollY: ++reads >= 3 ? 24 : 0 });
      transport.capture = async () => {
        captures++;
        return 'data:image/png;base64,aGVsbG8=';
      };
      await assert.rejects(browser.capture(1), error => {
        assert.equal(error.code, 'vision_stale_frame');
        assert.equal(error.message, 'Page changed while finalizing screenshot; capture again');
        return isTransientVisionCaptureError(error);
      });
      assert.equal(reads, 3, 'Only the final geometry read detects this transition');
      const observation = await browser.capture(1);
      assert.equal(observation.viewport.scrollY, 24);
      assert.equal(observation.dataUrl, `data:image/png;base64,${masking ? 'cmVkYWN0ZWQ=' : 'aGVsbG8='}`);
      assert.equal(reads, 6);
      assert.equal(redactions, 2);
      assert.equal(captures, 2);
      assert.deepEqual(calls, [], 'Retrying screenshot observation never dispatches native input');
    }
  });
}
test('stale ids, retina changes, zoom, navigation, and offscreen points never dispatch', async () => {
  for (const change of [{ width: 801 }, { devicePixelRatio: 1 }, { zoom: 1.25 }, { scale: 2 },
    { offsetLeft: 25 }, { scrollY: 10 }, { url: 'https://elsewhere.test/' }, { documentId: 'document-2' }]) {
    const { browser, calls, transport } = fake();
    transport.readViewport = async () => ({ ...viewport, ...change });
    const result = await browser.perform(1, 'click', { frameId: 'frame-1', x: 20, y: 20 }, frame());
    assert.equal(result.noDispatch, true, JSON.stringify(change));
    assert.equal(calls.length, 0);
  }
  for (const args of [{ frameId: 'old', x: 1, y: 1 }, { frameId: 'frame-1', x: 800, y: 0 },
    { frameId: 'frame-1', x: NaN, y: 0 }, { frameId: 'frame-1', selector: 'button', x: 1, y: 1 }]) {
    const { browser, calls } = fake();
    assert.equal((await browser.perform(1, 'click', args, frame())).noDispatch, true);
    assert.equal(calls.length, 0);
  }
});
test('invalid typing and drag arguments cannot focus or press anything', async () => {
  const { browser, calls } = fake();
  for (const [action, extra] of [['type', { text: null }], ['drag', { toX: 900, toY: 10 }], ['key', { key: 'NotAKey' }]]) {
    const result = await browser.perform(1, action, { frameId: 'frame-1', x: 1, y: 1, ...extra }, frame());
    assert.equal(result.noDispatch, true);
  }
  assert.equal(calls.length, 0);
});
test('cancellation during a drag releases the native held mouse without replay', async () => {
  const controller = new AbortController();
  const { browser, calls, transport } = fake(VisionBrowser, { signal: controller.signal });
  const original = transport.sendInput;
  transport.sendInput = async (...args) => { await original(...args); if (calls.at(-1).type === 'mouseMoved') controller.abort(); };
  const result = await browser.perform(1, 'drag', { frameId: 'frame-1', x: 10, y: 10, toX: 200, toY: 200 }, frame());
  assert.equal(result.success, false);
  assert.equal(result.outcomeUnknown, true);
  assert.deepEqual(calls.map(call => call.type), ['mousePressed', 'mouseMoved', 'mouseReleased']);
});
test('last-moment dispatch veto sends neither a press nor an unowned release', async () => {
  for (const [action, args] of [['click', { x: 10, y: 10 }], ['drag', { x: 10, y: 10, toX: 100, toY: 100 }], ['key', { key: 'Ctrl+A' }]]) {
    const { browser, calls } = fake(VisionBrowser, { beforeDispatch: () => { throw new Error('Stopped before native dispatch'); } });
    const result = await browser.perform(1, action, { frameId: 'frame-1', ...args }, frame());
    assert.equal(result.noDispatch, true);
    assert.deepEqual(calls, []);
  }
  const { browser, calls, transport } = fake();
  browser.beforeDispatch = () => { transport.readViewport = async () => ({ ...viewport, documentId: 'next-document' }); };
  assert.equal((await browser.perform(1, 'click', { frameId: 'frame-1', x: 10, y: 10 }, frame())).noDispatch, true);
  assert.deepEqual(calls, []);
});
test('lost input acknowledgement stays uncertain and releases modifiers', async () => {
  const { browser, calls, transport } = fake();
  const original = transport.sendInput;
  transport.sendInput = async (...args) => { await original(...args); if (calls.at(-1).key === 'a' && calls.at(-1).type !== 'keyUp') throw new Error('Lost response'); };
  const result = await browser.perform(1, 'key', { frameId: 'frame-1', key: 'Ctrl+a' }, frame());
  assert.equal(result.retryable, false);
  assert.equal(result.outcomeUnknown, true);
  assert.deepEqual(calls.map(call => [call.type, call.key]), [['rawKeyDown', 'Control'], ['rawKeyDown', 'a'], ['keyUp', 'a'], ['keyUp', 'Control']]);
});
test('key aliases and platform modifier remain deterministic', () => {
  assert.equal(visionKeyChord('ControlOrMeta+A', 'MacIntel').modifiers[0].key, 'Meta');
  assert.equal(visionKeyChord('controlormeta+A', 'Win32').modifiers[0].key, 'Control');
  assert.equal(visionKeyChord('esc').key.key, 'Escape');
  assert.equal(visionKeyChord('+').key.text, '+');
  assert.throws(() => visionKeyChord('Ctrl+Alt+unknown'), /Unsupported/);
  assert.equal(sameVisionViewport(viewport, { ...viewport, scrollY: 1 }), false);
});
test('pinched viewport capture rejects clipped PNG dimensions before image decode, including same-aspect truncation', async () => {
  const pngHeader = (width, height) => {
    const data = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
    data.write('IHDR', 12); data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
    return data.toString('base64');
  };
  assert.deepEqual(visionPngDimensions(pngHeader(1600, 1200)), { width: 1600, height: 1200 });
  assert.throws(() => visionPngDimensions('not a png'), /PNG header/);
  const previousChrome = globalThis.chrome;
  let image = pngHeader(1600, 1200), request;
  globalThis.chrome = { runtime: { lastError: null }, debugger: { sendCommand(_target, _method, params, callback) {
    request = params; callback({ data: image });
  } } };
  cdpClient.sessions.set(101, { attached: true });
  try {
    const transport = createVisionTransport({});
    const pinched = { ...viewport, width: 400, height: 300, scale: 2, devicePixelRatio: 2 };
    assert.equal(await transport.capture(101, pinched), `data:image/png;base64,${image}`);
    assert.equal(request.clip, undefined, 'Pinch must remain on the compositor path');
    for (const [width, height] of [[1258, 750], [800, 600]]) {
      image = pngHeader(width, height);
      await assert.rejects(transport.capture(101, pinched), error => error.code === 'vision_capture_clipped');
    }
    image = pngHeader(1599, 1199);
    assert.equal(await transport.capture(101, pinched), `data:image/png;base64,${image}`);
  } finally { globalThis.chrome = previousChrome; cdpClient.sessions.delete(101); }
});
test('native Firefox command validates its own viewport and uses no element lookup', async () => {
  const calls = [], runs = new Map([['run', { context: 'context' }]]);
  const session = { runs, send: async (method, params) => {
    calls.push({ method, params });
    if (method === 'script.evaluate') return { result: { value: JSON.stringify(viewport) } };
    if (method === 'browsingContext.captureScreenshot') return { data: 'png' };
    return {};
  } };
  assert.deepEqual(await readVisionViewport(session, 'run'), viewport);
  assert.equal((await captureVision(session, 'run')).data, 'png');
  await performVisionInput(session, 'run', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 25, y: 35, button: 'left' }, viewport);
  const pointer = calls.find(call => call.method === 'input.performActions');
  assert.deepEqual(pointer.params.actions[0].actions, [{ type: 'pointerMove', x: 25, y: 35, origin: 'viewport', duration: 0 }, { type: 'pointerDown', button: 0 }]);
  await assert.rejects(performVisionInput(session, 'run', 'Input.insertText', { text: 'bad' }, { ...viewport, documentId: 'stale' }), /stale/);
  await assert.rejects(performVisionInput(session, 'run', 'Input.insertText', { text: 'bad' }, viewport, true), /Only held/);
  await assert.rejects(performVisionInput(session, 'run', 'Input.insertText', { text: '\uE007' }, viewport), /control characters/);
  assert.equal(calls.filter(call => call.method === 'input.performActions').length, 1);
  assert.equal(calls.some(call => /locateNodes|accessibility/i.test(call.method)), false);
});

const fixture = `<!doctype html><style>body{margin:0;height:2500px}button{position:absolute;left:100px;top:100px;width:100px;height:50px}textarea{position:absolute;left:100px;top:200px;width:220px;height:60px}#drag{position:absolute;left:450px;top:100px;width:80px;height:80px;background:teal}</style>
<button id="button">Click</button><textarea id="text"></textarea><div id="drag"></div>
<script>window.events=[];for(const name of ['click','input','keydown','pointermove','pointerdown','pointerup','wheel']) document.addEventListener(name,e=>events.push({type:name,trusted:e.isTrusted,target:e.target.id,x:e.clientX,y:e.clientY,key:e.key}));window.count=0;button.onclick=()=>count++;</script>`;
test('real Chromium: DPR 1/2 and pinch zoom capture, click, Unicode typing, keys, drag, wheel, resize and reload', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    args: process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [] });
  const previousChrome = globalThis.chrome;
  try {
    for (const dpr of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: dpr });
      await context.route('https://vision.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
      const page = await context.newPage(); await page.goto('https://vision.test/');
      const protocol = await context.newCDPSession(page);
      // Device emulation is owned by the same CDP session as capture. A second
      // client's emulation is intentionally not restored by Chromium captures.
      await protocol.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false });
      const sent = [];
      globalThis.chrome = { runtime: { lastError: null }, debugger: { sendCommand(_target, method, params, callback) {
        sent.push({ method, params });
        protocol.send(method, params).then(callback, error => {
          globalThis.chrome.runtime.lastError = { message: error.message }; callback(); globalThis.chrome.runtime.lastError = null;
        });
      } } };
      cdpClient.sessions.set(99, { attached: true });
      const adapter = new VisionBrowser();
      let capture = await adapter.capture(99);
      assert.equal(capture.viewport.devicePixelRatio, dpr);
      const png = Buffer.from(capture.dataUrl.split(',')[1], 'base64');
      let frames = frame(capture.viewport, png.readUInt32BE(16), png.readUInt32BE(20));
      const point = (x, y) => ({ frameId: 'frame-1', x: x / frames.latest.viewport.width * frames.latest.canvas.width,
        y: y / frames.latest.viewport.height * frames.latest.canvas.height });
      assert.equal((await adapter.perform(99, 'click', point(150, 125), frames)).success, true);
      assert.equal(await page.evaluate(() => count), 1);
      assert.equal((await adapter.perform(99, 'type', { ...point(150, 225), text: 'İstanbul 🙂\nliteral text', clear: true }, frames)).success, true);
      assert.equal(await page.locator('#text').inputValue(), 'İstanbul 🙂\nliteral text');
      assert.equal((await adapter.perform(99, 'key', { frameId: 'frame-1', key: 'ControlOrMeta+A' }, frames)).success, true);
      assert.equal((await adapter.perform(99, 'drag', { ...point(480, 130), toX: point(650, 300).x, toY: point(650, 300).y }, frames)).success, true);
      assert.equal((await adapter.perform(99, 'scroll', { ...point(700, 500), deltaY: 300 }, frames)).success, true);
      await page.waitForFunction(() => scrollY > 0);
      assert.equal((await adapter.perform(99, 'click', point(150, 125), frames)).noDispatch, true);
      await page.evaluate(() => scrollTo(0, 0)); await page.waitForFunction(() => scrollY === 0);
      await protocol.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      capture = await adapter.capture(99);
      assert.equal(capture.viewport.width, 400);
      const zoomedPng = Buffer.from(capture.dataUrl.split(',')[1], 'base64');
      frames = frame(capture.viewport, zoomedPng.readUInt32BE(16), zoomedPng.readUInt32BE(20));
      assert.equal((await adapter.perform(99, 'click', point(150, 125), frames)).success, true);
      assert.equal(await page.evaluate(() => count), 2);
      await page.setViewportSize({ width: 900, height: 650 });
      assert.equal((await adapter.perform(99, 'click', point(150, 125), frames)).noDispatch, true);
      const oldFrame = frame(await adapter.readViewport(99));
      await page.reload();
      assert.equal((await adapter.perform(99, 'key', { frameId: 'frame-1', key: 'Enter' }, oldFrame)).noDispatch, true);
      assert.equal(sent.some(call => /^(Accessibility\.|DOM\.)/.test(call.method)), false);
      assert.equal(sent.filter(call => call.method === 'Runtime.evaluate').every(call => !/querySelector|elementFromPoint|activeElement|innerText/.test(call.params.expression)), true);
      await context.close(); cdpClient.sessions.delete(99);
    }
  } finally { globalThis.chrome = previousChrome; cdpClient.sessions.delete(99); await browser.close(); }
});

test('real Chromium: redirect or resize across screenshot transfer rejects once, then observation-only retry succeeds', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    args: process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [] });
  const previousChrome = globalThis.chrome;
  const tabId = 102;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/final' }); response.end(); return; }
    response.setHeader('Content-Type', 'text/html'); response.end('<h1>Stable destination</h1><button>Ready</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage(); await page.goto(`${origin}/start`);
    const protocol = await context.newCDPSession(page);
    await protocol.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    const commands = [];
    let transition = null;
    globalThis.chrome = { runtime: { lastError: null }, debugger: { sendCommand(_target, method, params, callback) {
      commands.push(method);
      void (async () => {
        try {
          const result = await protocol.send(method, params);
          // A real capture's pixels have left the compositor, but its reply is
          // still in flight while a real page navigation/resize takes place.
          if (method === 'Page.captureScreenshot' && transition) {
            const change = transition; transition = null; await change();
          }
          callback(result);
        } catch (error) {
          globalThis.chrome.runtime.lastError = { message: error.message }; callback(); globalThis.chrome.runtime.lastError = null;
        }
      })();
    } } };
    cdpClient.sessions.set(tabId, { attached: true });
    const adapter = new VisionBrowser();
    let navigations = 0;
    const changes = [
      async () => { navigations++; await page.goto(`${origin}/redirect`); },
      async () => { await protocol.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 650, deviceScaleFactor: 1, mobile: false }); },
    ];
    for (const change of changes) {
      transition = change;
      let attempts = 0, caught;
      let observation;
      while (!observation && attempts < 3) {
        attempts++;
        try { observation = await adapter.capture(tabId); }
        catch (error) {
          caught = error;
          assert.equal(isTransientVisionCaptureError(error), true, `${error.code}: ${error.message}`);
        }
      }
      assert.equal(attempts, 2, 'Retry captures observation, never navigation or input');
      assert.equal(caught.code, 'vision_stale_frame');
      assert.equal(observation.viewport.url, `${origin}/final`);
    }
    assert.equal((await adapter.readViewport(tabId)).width, 900);
    assert.equal(navigations, 1);
    assert.equal(commands.filter(method => method === 'Page.captureScreenshot').length, 4);
    assert.equal(commands.some(method => method.startsWith('Input.')), false);
    assert.equal(commands.some(method => /^(Accessibility|DOM)\./.test(method)), false);
    await context.close();
  } finally {
    globalThis.chrome = previousChrome; cdpClient.sessions.delete(tabId); await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
