import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

let server, browser, page;
before(async () => {
  const modules = new Map(await Promise.all(['vision-redaction.js', 'screenshot-redaction.js'].map(async name =>
    [`/${name}`, await readFile(new URL(`../src/chrome/src/agent/${name}`, import.meta.url), 'utf8')])));
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'text/javascript');
    response.end(request.url === '/' ? '<!doctype html><title>Vision privacy canvas test</title>' : modules.get(request.url) || '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const privacy = await import('/vision-redaction.js');
    window.redact = privacy.redactVisionCapture;
    window.capturePrivacySnapshot = privacy.captureVisionPrivacySnapshot;
    window.sourceImage = (width = 400, height = 200) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffcc55'; ctx.fillRect(0, 0, width, height);
      return canvas.toDataURL('image/png');
    };
    window.pixelSamples = async (url, points) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
    };
    window.mockAgent = regions => ({ screenshotRedaction: true,
      captureScreenshotRedactionSnapshotForUser: async () => ({ ok: true,
        snapshot: { coordinateSpace: 'page', viewport: { width: 1200, height: 2000 }, regions } }) });
  });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

test('privacy implementation is identical in Chrome and Firefox', async () => {
  assert.equal(await readFile(new URL('../src/chrome/src/agent/vision-redaction.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/firefox/src/agent/vision-redaction.js', import.meta.url), 'utf8'));
});

test('disabled redaction returns pixels unchanged without scanning or decoding', async () => {
  const result = await page.evaluate(async () => {
    let scans = 0;
    const agent = { screenshotRedaction: false,
      captureScreenshotRedactionSnapshotForUser: async () => { scans++; throw new Error('Unexpected privacy scan'); } };
    const url = 'not-an-image-no-decode-expected';
    return { url: await redact(agent, 7, url, {}), snapshot: await capturePrivacySnapshot(agent, 7), scans };
  });
  assert.deepEqual(result, { url: 'not-an-image-no-decode-expected', snapshot: null, scans: 0 });
});

test('retina and pinch-pan captures mask page regions at their actual visual viewport offsets', async () => {
  const result = await page.evaluate(async () => {
    const input = sourceImage(), calls = [];
    const agent = mockAgent([{ kind: 'password', rect: { x: 170, y: 320, w: 40, h: 20 } }]);
    const scan = agent.captureScreenshotRedactionSnapshotForUser;
    agent.captureScreenshotRedactionSnapshotForUser = async (...args) => { calls.push(args); return scan(...args); };
    const output = await redact(agent, 42, input, { width: 200, height: 100, scrollX: 150, scrollY: 300,
      offsetLeft: 50, offsetTop: 40, scale: 2, devicePixelRatio: 2, zoom: 1.25 });
    return { changed: output !== input, prefix: output.slice(0, 22), calls,
      samples: await pixelSamples(output, [[40, 40], [80, 60], [119, 79], [20, 20], [180, 100], [39, 100]]) };
  });
  assert.equal(result.changed, true); assert.equal(result.prefix, 'data:image/png;base64,');
  assert.deepEqual(result.calls, [[42, { coordinateSpace: 'page' }]]);
  for (const pixel of result.samples.slice(0, 3)) assert.deepEqual(pixel, [32, 33, 36, 255]);
  for (const pixel of result.samples.slice(3)) assert.deepEqual(pixel, [255, 204, 85, 255]);
});

test('fractional region edges do not leave exposed source pixel rows or columns', async () => {
  const result = await page.evaluate(async () => {
    const output = await redact(mockAgent([{ kind: 'input', rect: { x: 10.6, y: 20.6, w: 2.2, h: 2.2 } }]),
      7, sourceImage(100, 100), { width: 100, height: 100, scrollX: 0, scrollY: 0 });
    return pixelSamples(output, [[10, 20], [10, 22], [12, 20], [12, 22], [5, 5], [20, 30]]);
  });
  for (const pixel of result.slice(0, 4)) assert.deepEqual(pixel, [32, 33, 36, 255]);
  for (const pixel of result.slice(4)) assert.deepEqual(pixel, [255, 204, 85, 255]);
});

test('partially visible fields clip masks to the captured image without shifting neighbors', async () => {
  const result = await page.evaluate(async () => {
    const output = await redact(mockAgent([{ kind: 'input', rect: { x: 145, y: 305, w: 15, h: 10 } }]),
      7, sourceImage(), { width: 200, height: 100, scrollX: 150, scrollY: 300 });
    return pixelSamples(output, [[0, 10], [19, 29], [30, 20], [0, 40]]);
  });
  assert.deepEqual(result[0], [32, 33, 36, 255]); assert.deepEqual(result[1], [32, 33, 36, 255]);
  assert.deepEqual(result[2], [255, 204, 85, 255]); assert.deepEqual(result[3], [255, 204, 85, 255]);
});

test('complete scans with no visible sensitive regions preserve the original PNG', async () => {
  const result = await page.evaluate(async () => {
    const input = sourceImage(), viewport = { width: 200, height: 100, scrollX: 150, scrollY: 300 };
    const empty = await redact(mockAgent([]), 7, input, viewport);
    const outside = await redact(mockAgent([{ kind: 'input', rect: { x: 800, y: 900, w: 30, h: 20 } }]), 7, input, viewport);
    return { empty: empty === input, outside: outside === input };
  });
  assert.deepEqual(result, { empty: true, outside: true });
});

test('missing or incomplete privacy scans reject capture instead of returning raw pixels', async () => {
  const results = await page.evaluate(async () => {
    const outcomes = [];
    for (const scan of [null, { ok: false }, { ok: true }, { ok: true, snapshot: { coordinateSpace: 'viewport', regions: [] } }]) {
      try {
        await redact({ screenshotRedaction: true, captureScreenshotRedactionSnapshotForUser: async () => scan },
          7, sourceImage(), { width: 200, height: 100 });
        outcomes.push({ leaked: true });
      } catch (error) { outcomes.push({ error: error.message }); }
    }
    return outcomes;
  });
  for (const result of results) assert.match(result.error, /privacy scan failed/i);
});

test('image decode, missing canvas and PNG encoder failures never return an unredacted fallback', async () => {
  const result = await page.evaluate(async () => {
    const viewport = { width: 200, height: 100 }, agent = mockAgent([{ kind: 'input', rect: { x: 10, y: 10, w: 50, h: 20 } }]);
    const outcomes = [];
    try { await redact(agent, 7, 'data:image/png;base64,broken', viewport); outcomes.push('RAW'); }
    catch { outcomes.push('decode-rejected'); }
    const input = sourceImage(), getContext = OffscreenCanvas.prototype.getContext;
    try {
      OffscreenCanvas.prototype.getContext = () => null;
      try { await redact(agent, 7, input, viewport); outcomes.push('RAW'); }
      catch (error) { outcomes.push(error.message); }
    } finally { OffscreenCanvas.prototype.getContext = getContext; }
    const encode = OffscreenCanvas.prototype.convertToBlob;
    try {
      OffscreenCanvas.prototype.convertToBlob = async () => null;
      try { await redact(agent, 7, input, viewport); outcomes.push('RAW'); }
      catch (error) { outcomes.push(error.message); }
    } finally { OffscreenCanvas.prototype.convertToBlob = encode; }
    return outcomes;
  });
  assert.deepEqual(result, ['decode-rejected', 'No screenshot privacy canvas', 'Screenshot privacy encoding failed']);
});

test('fields removed or moved during capture retain masks at their old screenshot positions', async () => {
  const result = await page.evaluate(async () => {
    const old = { kind: 'input', rect: { x: 20, y: 10, w: 30, h: 20 } };
    const moved = { kind: 'input', rect: { x: 100, y: 50, w: 30, h: 20 } };
    const viewport = { width: 200, height: 100 }, input = sourceImage();
    const outcomes = [];
    for (const afterRegions of [[], [moved]]) {
      const agent = mockAgent([old]);
      const before = await capturePrivacySnapshot(agent, 7);
      agent.captureScreenshotRedactionSnapshotForUser = mockAgent(afterRegions).captureScreenshotRedactionSnapshotForUser;
      const output = await redact(agent, 7, input, viewport, before);
      outcomes.push(await pixelSamples(output, [[45, 25], [205, 105], [350, 150]]));
    }
    return outcomes;
  });
  const mask = [32, 33, 36, 255], original = [255, 204, 85, 255];
  assert.deepEqual(result[0], [mask, original, original]);
  assert.deepEqual(result[1], [mask, mask, original]);
});

test('privacy remains enabled for an in-flight screenshot when the setting is toggled off', async () => {
  const result = await page.evaluate(async () => {
    const agent = mockAgent([{ kind: 'password', rect: { x: 20, y: 10, w: 30, h: 20 } }]);
    const before = await capturePrivacySnapshot(agent, 7);
    let afterScans = 0;
    agent.screenshotRedaction = false;
    agent.captureScreenshotRedactionSnapshotForUser = async () => {
      afterScans++;
      return { ok: true, snapshot: { coordinateSpace: 'page', regions: [] } };
    };
    const output = await redact(agent, 7, sourceImage(), { width: 200, height: 100 }, before);
    return { afterScans, pixels: await pixelSamples(output, [[45, 25], [350, 150]]) };
  });
  assert.equal(result.afterScans, 1);
  assert.deepEqual(result.pixels, [[32, 33, 36, 255], [255, 204, 85, 255]]);
});

test('missing pre-capture or post-capture privacy scans abort without returning raw image data', async () => {
  const result = await page.evaluate(async () => {
    let beforeError, afterError;
    const missing = { screenshotRedaction: true, captureScreenshotRedactionSnapshotForUser: async () => ({ ok: false }) };
    try { await capturePrivacySnapshot(missing, 7); } catch (error) { beforeError = error.message; }
    const before = { coordinateSpace: 'page', regions: [{ kind: 'password', rect: { x: 20, y: 10, w: 30, h: 20 } }] };
    try { await redact(missing, 7, sourceImage(), { width: 200, height: 100 }, before); }
    catch (error) { afterError = error.message; }
    return { beforeError, afterError };
  });
  assert.match(result.beforeError, /privacy scan failed/i); assert.match(result.afterError, /privacy scan failed/i);
});
