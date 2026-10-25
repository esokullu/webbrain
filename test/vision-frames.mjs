import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import {
  VISION_FRAME_BUDGET, VisionFrameSession, changedVisionRegions,
  normalizeVisionViewport, visionPointToCss,
} from '../src/chrome/src/agent/vision-frames.js';

const modulePath = '/vision-frames.js';
let browser, server, page;
before(async () => {
  const files = new Map(await Promise.all(['vision-frames.js', 'image-budget.js'].map(async name =>
    [`/${name}`, await readFile(new URL(`../src/chrome/src/agent/${name}`, import.meta.url), 'utf8')])));
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'text/javascript');
    response.end(request.url === '/' ? '<!doctype html><title>Vision frame canvas test</title>' : files.get(request.url) || '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true,
    args: process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [] });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async path => {
    window.vision = await import(path);
    window.makeImage = (width, height, edits = []) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      for (const edit of edits) { ctx.fillStyle = edit.color; ctx.fillRect(edit.x, edit.y, edit.width, edit.height); }
      return canvas.toDataURL('image/png');
    };
  }, modulePath);
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

test('browser trees share the identical frame implementation', async () => {
  assert.equal(await readFile(new URL('../src/firefox/src/agent/vision-frames.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/chrome/src/agent/vision-frames.js', import.meta.url), 'utf8'));
});

test('retina, browser zoom and visual viewport offset use measured image scaling', () => {
  const viewport = normalizeVisionViewport({ width: 1440, height: 900, devicePixelRatio: 2, zoom: 1.25,
    visualViewport: { width: 720, height: 450, offsetLeft: 120, offsetTop: 35, scale: 2 } });
  const frame = { frameId: 'f-2', canvas: { width: 1280, height: 800 }, viewport, images: [] };
  assert.deepEqual(visionPointToCss(frame, { frameId: 'f-2', x: 640, y: 400 }), { x: 480, y: 260 });
  assert.equal(viewport.devicePixelRatio, 2); assert.equal(viewport.zoom, 1.25); assert.equal(viewport.scale, 2);
  assert.equal(viewport.pageLeft, 120); assert.equal(viewport.pageTop, 35);
  const flat = normalizeVisionViewport({ width: 720, height: 450, offsetLeft: 120, offsetTop: 35, scrollX: 520, scrollY: 835 });
  assert.equal(flat.pageLeft, 520); assert.equal(flat.pageTop, 835);
  assert.throws(() => visionPointToCss(frame, { frameId: 'f-1', x: 10, y: 10 }), /Stale vision frame/);
  for (const [x, y] of [[-1, 0], [1280, 0], [0, 800], [NaN, 1], [1, Infinity]]) {
    assert.throws(() => visionPointToCss(frame, { frameId: 'f-2', x, y }), /outside|finite/);
  }
});

test('crop-local coordinates include origin and encoded crop scale', () => {
  const frame = { frameId: 'delta', canvas: { width: 1000, height: 500 },
    viewport: normalizeVisionViewport({ width: 2000, height: 1000 }),
    images: [{ id: 'crop', width: 50, height: 25, rect: { x: 200, y: 100, width: 100, height: 50 } }] };
  assert.deepEqual(visionPointToCss(frame, { frameId: 'delta', imageId: 'crop', x: 25, y: 10 }), { x: 500, y: 240 });
  assert.throws(() => visionPointToCss(frame, { frameId: 'delta', imageId: 'missing', x: 1, y: 1 }), /Unknown/);
  assert.throws(() => visionPointToCss(frame, { frameId: 'delta', imageId: 'crop', x: 50, y: 1 }), /outside the crop/);
});

test('raw pixel comparison catches isolated small changes and bounds padded tile crops', () => {
  const a = new Uint8ClampedArray(100 * 70 * 4), b = a.slice();
  b[(69 * 100 + 99) * 4] = 255;
  assert.deepEqual(changedVisionRegions(a, b, 100, 70), [{ x: 88, y: 56, width: 12, height: 14 }]);
  b[(69 * 100 + 99) * 4] = 12;
  assert.deepEqual(changedVisionRegions(a, b, 100, 70), []);
  assert.throws(() => changedVisionRegions(a, b.subarray(4), 100, 70), /matching RGBA/);
});

test('nearby changed tiles merge and separated regions remain independent', () => {
  const a = new Uint8ClampedArray(320 * 320 * 4), b = a.slice();
  for (const [x, y] of [[31, 10], [32, 10], [290, 290]]) b[(y * 320 + x) * 4] = 255;
  const regions = changedVisionRegions(a, b, 320, 320);
  assert.equal(regions.length, 2);
  assert.deepEqual(regions[0], { x: 0, y: 0, width: 72, height: 40 });
});

test('invalid budgets cannot create infinite encoder loops or unbounded buffers', () => {
  for (const options of [{ budget: { maxBytes: 0 } }, { budget: { jpegQualityStep: 0 } },
    { budget: { mimeType: 'image/png' } }, { keyframeInterval: 0 }, { tileSize: 0 },
    { budget: { initialJpegQuality: NaN } }, { fullAreaRatio: NaN }, { maxContextImages: 0 }]) {
    assert.throws(() => new VisionFrameSession(options), /Invalid vision/);
  }
  assert.equal(VISION_FRAME_BUDGET.maxBytes, 256 * 1024);
  for (const width of [Infinity, NaN, '100', -5, 0]) {
    assert.throws(() => normalizeVisionViewport({ width, height: 100 }), /positive CSS/);
  }
});

test('real browser canvas sends a bounded first frame and no image when unchanged', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession();
    const image = makeImage(3840, 2160);
    const first = await session.capture(image, { width: 1920, height: 1080, devicePixelRatio: 2 });
    const next = await session.capture(image, { width: 1920, height: 1080, devicePixelRatio: 2 });
    let stale;
    try { session.toCssPoint({ frameId: first.frameId, x: 5, y: 5 }); } catch (e) { stale = e.message; }
    return { first, next, stale, history: session.contextFrames().map(f => f.kind) };
  });
  assert.equal(result.first.kind, 'full'); assert.ok(result.first.canvas.width <= 1280);
  assert.ok(result.first.estimatedTokens <= 1000); assert.ok(result.first.bytes <= VISION_FRAME_BUDGET.maxBytes);
  assert.equal(result.first.images[0].mimeType, 'image/jpeg');
  assert.equal(result.next.kind, 'unchanged'); assert.equal(result.next.bytes, 0); assert.deepEqual(result.next.images, []);
  assert.equal(result.next.baseFrameId, result.first.frameId); assert.match(result.stale, /Stale/);
  assert.deepEqual(result.history, ['full', 'unchanged']);
});

test('small visual mutations become crops with reconstructible provenance and fewer tokens', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession();
    const viewport = { width: 800, height: 600, devicePixelRatio: 2 };
    const first = await session.capture(makeImage(800, 600), viewport);
    const delta = await session.capture(makeImage(800, 600, [{ x: 195, y: 150, width: 30, height: 20, color: '#ff0000' }]), viewport);
    const crop = delta.images[0];
    const point = session.toCssPoint({ frameId: delta.frameId, imageId: crop.id,
      x: (210 - crop.rect.x) * crop.width / crop.rect.width,
      y: (160 - crop.rect.y) * crop.height / crop.rect.height });
    // Replay the retained image protocol exactly as a consumer would.
    const canvas = document.createElement('canvas'); canvas.width = delta.canvas.width; canvas.height = delta.canvas.height;
    const ctx = canvas.getContext('2d');
    for (const frame of session.contextFrames()) for (const image of frame.images) {
      const bitmap = await createImageBitmap(await (await fetch(image.dataUrl)).blob());
      ctx.drawImage(bitmap, image.rect.x, image.rect.y, image.rect.width, image.rect.height); bitmap.close();
    }
    return { first, delta, point, changedPixel: [...ctx.getImageData(210, 160, 1, 1).data],
      unchangedPixel: [...ctx.getImageData(20, 20, 1, 1).data], history: session.contextFrames().map(f => f.kind) };
  });
  assert.equal(result.delta.kind, 'delta'); assert.equal(result.delta.baseFrameId, result.first.frameId);
  assert.equal(result.delta.previousFrameId, result.first.frameId);
  assert.ok(result.delta.bytes < result.first.bytes); assert.ok(result.delta.estimatedTokens < result.first.estimatedTokens / 5);
  assert.deepEqual(result.point, { x: 210, y: 160 }); assert.deepEqual(result.history, ['full', 'delta']);
  assert.ok(result.changedPixel[0] > 220 && result.changedPixel[1] < 30);
  assert.ok(result.unchangedPixel.slice(0, 3).every(channel => channel > 240));
});

test('resize, navigation, scroll, DPR and zoom require new keyframes and invalidate actions', async () => {
  const results = await page.evaluate(async () => {
    const results = [];
    for (const change of [{ width: 799 }, { url: 'https://example.test/next' }, { scrollY: 200 },
      { devicePixelRatio: 2 }, { zoom: 1.5 }, { documentId: 'document-2' }, { offsetTop: 8 }]) {
      const session = new vision.VisionFrameSession();
      const viewport = { width: 800, height: 600, url: 'https://example.test/', documentId: 'document-1' };
      const image = makeImage(800, 600);
      await session.capture(image, viewport);
      let rejected = false;
      try { session.assertViewport({ ...viewport, ...change }); } catch { rejected = true; }
      const frame = await session.capture(image, { ...viewport, ...change });
      results.push({ rejected, kind: frame.kind, history: session.contextFrames().length });
    }
    return results;
  });
  for (const result of results) assert.deepEqual(result, { rejected: true, kind: 'full', history: 1 });
});

test('keyframe refresh bounds the retained history and reset invalidates all coordinates', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession({ keyframeInterval: 2 });
    const image = makeImage(800, 600), viewport = { width: 800, height: 600 };
    const kinds = [];
    for (let i = 0; i < 4; i++) kinds.push((await session.capture(image, viewport)).kind);
    const history = session.contextFrames().length, old = session.latest.frameId;
    session.reset();
    let rejected = false;
    try { session.toCssPoint({ frameId: old, x: 10, y: 10 }); } catch { rejected = true; }
    return { kinds, history, rejected, empty: session.contextFrames().length };
  });
  assert.deepEqual(result, { kinds: ['full', 'unchanged', 'unchanged', 'full'], history: 1, rejected: true, empty: 0 });
});

test('context rebuilds never reference omitted intermediate unchanged observations', async () => {
  const chains = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession(), viewport = { width: 800, height: 600 }, chains = [];
    for (const color of ['#fff', '#fff', '#fff', '#f00', '#f00', '#0f0']) {
      await session.capture(makeImage(800, 600, [{ x: 200, y: 160, width: 24, height: 24, color }]), viewport);
      chains.push(session.contextFrames().map(({ frameId, baseFrameId, previousFrameId, kind }) =>
        ({ frameId, baseFrameId, previousFrameId, kind })));
    }
    return chains;
  });
  for (const chain of chains) {
    const retained = new Set();
    for (const frame of chain) {
      if (frame.kind === 'full') {
        assert.equal(frame.previousFrameId, null); assert.equal(frame.baseFrameId, frame.frameId);
      } else {
        assert.ok(retained.has(frame.baseFrameId), 'base frame must be present earlier in the chain');
        assert.ok(retained.has(frame.previousFrameId), 'previous frame must be present earlier in the chain');
      }
      retained.add(frame.frameId);
    }
  }
  assert.deepEqual(chains.at(-1).map(frame => frame.kind), ['full', 'delta', 'delta']);
});

test('below-threshold changes accumulate against last transmitted pixels', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession({ diffThreshold: 12 });
    const viewport = { width: 800, height: 600 };
    const kinds = [];
    for (const gray of [255, 248, 240]) {
      const image = makeImage(800, 600, [{ x: 200, y: 160, width: 30, height: 20, color: `rgb(${gray},${gray},${gray})` }]);
      kinds.push((await session.capture(image, viewport)).kind);
    }
    return kinds;
  });
  assert.deepEqual(result, ['full', 'unchanged', 'delta']);
});

test('large changes force a fresh full image and discard old image context', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession();
    const viewport = { width: 800, height: 600 };
    const first = await session.capture(makeImage(800, 600), viewport);
    const next = await session.capture(makeImage(800, 600, [{ x: 0, y: 0, width: 800, height: 600, color: '#111' }]), viewport);
    return { firstId: first.frameId, next, history: session.contextFrames().length };
  });
  assert.equal(result.next.kind, 'full'); assert.equal(result.next.baseFrameId, result.next.frameId);
  assert.notEqual(result.next.baseFrameId, result.firstId); assert.equal(result.history, 1);
});

test('high-entropy screenshots shrink to the strict byte cap without geometry churn', async () => {
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 768;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(canvas.width, canvas.height);
    let seed = 7;
    for (let i = 0; i < image.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) { seed = (seed * 1664525 + 1013904223) >>> 0; image.data[i + channel] = seed >>> 24; }
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const session = new vision.VisionFrameSession({ budget: { maxBytes: 4096 } });
    const viewport = { width: 1024, height: 768 };
    const first = await session.capture(dataUrl, viewport), next = await session.capture(dataUrl, viewport);
    return { first, next };
  });
  assert.ok(result.first.bytes <= 4096); assert.ok(result.first.canvas.width < 1024);
  assert.deepEqual(result.first.canvas, result.next.canvas);
  // Both frames are decoded directly to the retained canonical size; there is
  // no keyframe loop caused by returning to the larger initial target size.
  assert.notEqual(result.next.kind, 'full');
});

test('WebP transport is supported and invalid remote screenshot inputs fail closed', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession({ budget: { mimeType: 'image/webp' } });
    const frame = await session.capture(makeImage(320, 240), { width: 320, height: 240 });
    let rejected;
    try { await session.capture('https://example.test/screenshot.png', { width: 320, height: 240 }); }
    catch (error) { rejected = error.message; }
    return { mimeType: frame.images[0].mimeType, rejected };
  });
  assert.equal(result.mimeType, 'image/webp'); assert.match(result.rejected, /local PNG/);
});

test('retained image count and token budgets roll over to a fresh keyframe', async () => {
  const result = await page.evaluate(async () => {
    const viewport = { width: 800, height: 600 };
    const counts = new vision.VisionFrameSession({ maxContextImages: 2 });
    const tokens = new vision.VisionFrameSession({ budget: { maxTargetTokens: 613 }, maxContextTokens: 613 });
    const results = [];
    for (const session of [counts, tokens]) {
      const kinds = [];
      for (const color of ['#fff', '#f00', '#0f0']) {
        kinds.push((await session.capture(makeImage(800, 600, [{ x: 200, y: 160, width: 24, height: 24, color }]), viewport)).kind);
      }
      results.push({ kinds, images: session.contextFrames().reduce((sum, frame) => sum + frame.images.length, 0) });
    }
    return results;
  });
  assert.deepEqual(result[0], { kinds: ['full', 'delta', 'full'], images: 1 });
  assert.deepEqual(result[1], { kinds: ['full', 'full', 'full'], images: 1 });
});

test('a reset during asynchronous encoding cannot restore an obsolete frame', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession();
    const pending = session.capture(makeImage(800, 600), { width: 800, height: 600 });
    let concurrent, resetError;
    try { await session.capture(makeImage(800, 600), { width: 800, height: 600 }); }
    catch (error) { concurrent = error.message; }
    session.reset();
    try { await pending; } catch (error) { resetError = error.message; }
    return { concurrent, resetError, latest: session.latest, history: session.contextFrames().length };
  });
  assert.match(result.concurrent, /already in progress/); assert.match(result.resetError, /reset during capture/);
  assert.equal(result.latest, null); assert.equal(result.history, 0);
});

test('predispatch pixel validation blocks moved or overlaid targets but ignores unrelated counters', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession();
    const viewport = { width: 800, height: 600 };
    const button = { x: 190, y: 145, width: 60, height: 30, color: '#2367aa' };
    const frame = await session.capture(makeImage(800, 600, [button]), viewport);
    const args = { frameId: frame.frameId, x: 220, y: 160 };
    const unrelated = await session.assertCurrentPixels(makeImage(800, 600, [button,
      { x: 730, y: 20, width: 20, height: 20, color: '#f00' }]), viewport, args);
    let moved, overlaid;
    try { await session.assertCurrentPixels(makeImage(800, 600, [{ ...button, x: 350 }]), viewport, args); }
    catch (error) { moved = error.message; }
    try { await session.assertCurrentPixels(makeImage(800, 600, [button,
      { x: 200, y: 150, width: 100, height: 100, color: '#fff' }]), viewport, args); }
    catch (error) { overlaid = error.message; }
    const after = await session.capture(makeImage(800, 600, [button]), viewport);
    return { unrelated, moved, overlaid, originalId: frame.frameId,
      previousId: after.previousFrameId, kind: after.kind, historyLength: session.contextFrames().length };
  });
  assert.equal(result.unrelated, true); assert.match(result.moved, /Stale vision target/);
  assert.match(result.overlaid, /Stale vision target/); assert.equal(result.previousId, result.originalId);
  assert.equal(result.kind, 'unchanged'); assert.equal(result.historyLength, 2);
});

test('predispatch crop-local and drag destination checks preserve coordinate provenance', async () => {
  const result = await page.evaluate(async () => {
    const viewport = { width: 800, height: 600 }, session = new vision.VisionFrameSession();
    await session.capture(makeImage(800, 600), viewport);
    const red = { x: 195, y: 150, width: 30, height: 20, color: '#f00' };
    const frame = await session.capture(makeImage(800, 600, [red]), viewport), crop = frame.images[0];
    const valid = await session.assertCurrentPixels(makeImage(800, 600, [red]), viewport,
      { frameId: frame.frameId, imageId: crop.id, x: 210 - crop.rect.x, y: 160 - crop.rect.y });
    let destination, badGeometry, oldFrame, wrongSource;
    try { await session.assertCurrentPixels(makeImage(800, 600, [red,
      { x: 600, y: 400, width: 30, height: 20, color: '#000' }]), viewport,
    { frameId: frame.frameId, x: 210, y: 160, toX: 615, toY: 410 }); }
    catch (error) { destination = error.message; }
    try { await session.assertCurrentPixels(makeImage(800, 600, [red]), { ...viewport, scrollY: 5 },
      { frameId: frame.frameId, x: 210, y: 160 }); } catch (error) { badGeometry = error.message; }
    try { await session.assertCurrentPixels(makeImage(800, 600, [red]), viewport,
      { frameId: 'old-frame', x: 210, y: 160 }); } catch (error) { oldFrame = error.message; }
    try { await session.assertCurrentPixels(makeImage(1600, 1200), viewport,
      { frameId: frame.frameId, x: 210, y: 160 }); } catch (error) { wrongSource = error.message; }
    return { valid, destination, badGeometry, oldFrame, wrongSource };
  });
  assert.equal(result.valid, true); assert.match(result.destination, /Stale vision target/);
  assert.match(result.badGeometry, /viewport changed/); assert.match(result.oldFrame, /Stale vision frame/);
  assert.match(result.wrongSource, /screenshot size changed/);
});

test('semantic evidence validates the entire header/draft rectangle, ignores unrelated pixels and preserves frame history', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession(), viewport = { width: 800, height: 600 };
    const header = { x: 10, y: 10, width: 600, height: 50, color: '#eee' };
    const draft = { x: 10, y: 400, width: 600, height: 50, color: '#aaa' };
    const raw = makeImage(800, 600, [header, draft]);
    const frame = await session.capture(raw, viewport);
    const before = JSON.stringify(session.contextFrames());
    const args = { frameId: frame.frameId, rects: [header, draft].map(({ color, ...rect }) => rect) };
    const unrelated = await session.assertCurrentRegions(makeImage(800, 600, [header, draft,
      { x: 750, y: 500, width: 20, height: 20, color: '#f00' }]), viewport, args);
    const failures = [];
    for (const change of [{ x: 10, y: 10 }, { x: 609, y: 59 }, { x: 10, y: 400 }, { x: 609, y: 449 }]) {
      try { await session.assertCurrentRegions(makeImage(800, 600, [header, draft, { ...change, width: 1, height: 1, color: '#000' }]), viewport, args); }
      catch (error) { failures.push({ code: error.code, message: error.message }); }
    }
    const historyUnchanged = before === JSON.stringify(session.contextFrames());
    const after = await session.capture(raw, viewport);
    return { unrelated, failures, historyUnchanged, kind: after.kind, previous: after.previousFrameId, original: frame.frameId };
  });
  assert.equal(result.unrelated, true); assert.equal(result.failures.length, 4);
  for (const error of result.failures) assert.equal(error.code, 'vision_stale_frame');
  assert.equal(result.historyUnchanged, true); assert.equal(result.kind, 'unchanged'); assert.equal(result.previous, result.original);
});

test('full-evidence validation uses measured retina scaling and empty rectangles mean the whole screenshot', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession(), viewport = { width: 800, height: 600, devicePixelRatio: 2, zoom: 1.25,
      offsetLeft: 20, offsetTop: 30, scrollX: 120, scrollY: 330, documentId: 'retina-doc' };
    const raw = makeImage(1600, 1200);
    const frame = await session.capture(raw, viewport);
    const rect = { x: 100, y: 100, width: 200, height: 50 };
    const valid = await session.assertCurrentRegions(raw, viewport, { frameId: frame.frameId, rects: [rect] });
    const scale = 1600 / frame.canvas.width;
    let inside, whole;
    try { await session.assertCurrentRegions(makeImage(1600, 1200, [{ x: 110 * scale, y: 110 * scale, width: 20, height: 20, color: '#000' }]), viewport,
      { frameId: frame.frameId, rects: [rect] }); } catch (error) { inside = error.code; }
    try { await session.assertCurrentRegions(makeImage(1600, 1200, [{ x: 1500, y: 1100, width: 20, height: 20, color: '#000' }]), viewport,
      { frameId: frame.frameId, rects: [] }); } catch (error) { whole = error.code; }
    return { valid, inside, whole, canvas: frame.canvas, source: frame.source };
  });
  assert.equal(result.valid, true); assert.equal(result.inside, 'vision_stale_frame'); assert.equal(result.whole, 'vision_stale_frame');
  assert.ok(result.canvas.width < result.source.width);
});

test('evidence validation rejects stale identity, geometry, out-of-bounds boxes and reset during decode', async () => {
  const result = await page.evaluate(async () => {
    const session = new vision.VisionFrameSession(), viewport = { width: 800, height: 600, documentId: 'document-one' };
    const raw = makeImage(800, 600), frame = await session.capture(raw, viewport);
    const errors = [];
    for (const [image, geometry, args] of [
      [raw, viewport, { frameId: 'old', rects: [] }],
      [raw, { ...viewport, documentId: 'document-two' }, { frameId: frame.frameId, rects: [] }],
      [raw, { ...viewport, scrollY: 1 }, { frameId: frame.frameId, rects: [] }],
      [raw, viewport, { frameId: frame.frameId, rects: [{ x: 799, y: 0, width: 2, height: 2 }] }],
      [raw, viewport, { frameId: frame.frameId, rects: [{ x: NaN, y: 0, width: 2, height: 2 }] }],
      [makeImage(1600, 1200), viewport, { frameId: frame.frameId, rects: [] }],
      [raw, viewport, { frameId: frame.frameId, rects: Array(251).fill({ x: 0, y: 0, width: 1, height: 1 }) }],
    ]) {
      try { await session.assertCurrentRegions(image, geometry, args); errors.push(null); } catch (error) { errors.push(error.message); }
    }
    const pending = session.assertCurrentRegions(raw, viewport, { frameId: frame.frameId, rects: [] }); session.reset();
    let reset;
    try { await pending; } catch (error) { reset = error.message; }
    return { errors, reset, latest: session.latest };
  });
  assert.equal(result.errors.length, 7); assert.ok(result.errors.every(Boolean));
  assert.match(result.reset, /Stale screenshot/); assert.equal(result.latest, null);
});
