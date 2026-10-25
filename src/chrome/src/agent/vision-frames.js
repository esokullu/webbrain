// Vision transport owns a bounded, reconstructible keyframe + patch chain.
// Keep this file byte-identical in the Firefox tree.
import { IMAGE_BUDGET, fitImageDimensions, estimateImageTokens } from './image-budget.js';

export const VISION_FRAME_BUDGET = Object.freeze({
  ...IMAGE_BUDGET,
  maxTargetPx: 1280,
  maxTargetTokens: 1000,
  maxBytes: 256 * 1024,
  initialJpegQuality: 0.76,
  minJpegQuality: 0.36,
  jpegQualityStep: 0.10,
  mimeType: 'image/jpeg',
});

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
let sessionCounter = 0;

export function normalizeVisionViewport(viewport = {}) {
  const visual = viewport.visualViewport || viewport;
  const width = positive(visual.width, viewport.width);
  const height = positive(visual.height, viewport.height);
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new Error('Vision capture requires positive CSS viewport dimensions');
  }
  return {
    width, height,
    offsetLeft: finite(visual.offsetLeft), offsetTop: finite(visual.offsetTop),
    scale: positive(visual.scale, 1),
    devicePixelRatio: positive(viewport.devicePixelRatio, 1),
    zoom: positive(viewport.zoom, 1),
    scrollX: finite(viewport.scrollX), scrollY: finite(viewport.scrollY),
    // Nested DOM metadata uses layout scrollX/Y; flat transport metadata uses
    // the captured visual viewport's pageX/Y already, including its offset.
    pageLeft: finite(visual.pageLeft, finite(viewport.scrollX) + (viewport.visualViewport ? finite(visual.offsetLeft) : 0)),
    pageTop: finite(visual.pageTop, finite(viewport.scrollY) + (viewport.visualViewport ? finite(visual.offsetTop) : 0)),
    url: String(viewport.url || ''), documentId: String(viewport.documentId || ''),
  };
}

function sameViewport(left, right) {
  return Object.keys(left).every(key => left[key] === right[key]);
}

/** Raw, uncompressed RGBA comparison. Threshold is per channel, not averaged:
 * small controls must remain visible even when most of their tile is static. */
export function changedVisionRegions(previous, current, width, height, {
  tileSize = 32, threshold = 12, padding = 8,
} = {}) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)
      || current?.length !== width * height * 4 || previous?.length !== current.length) {
    throw new Error('Vision diff requires matching RGBA buffers');
  }
  if (!(Number.isInteger(tileSize) && tileSize > 0 && Number.isFinite(threshold) && threshold >= 0
      && Number.isInteger(padding) && padding >= 0)) {
    throw new Error('Invalid vision diff options');
  }
  const cols = Math.ceil(width / tileSize), rows = Math.ceil(height / tileSize);
  const changed = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = Math.floor(y / tileSize) * cols + Math.floor(x / tileSize);
      if (changed[tile]) continue;
      const p = (y * width + x) * 4;
      if (Math.abs(previous[p] - current[p]) > threshold
          || Math.abs(previous[p + 1] - current[p + 1]) > threshold
          || Math.abs(previous[p + 2] - current[p + 2]) > threshold
          || Math.abs(previous[p + 3] - current[p + 3]) > threshold) changed[tile] = 1;
    }
  }
  const regions = [];
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start]) continue;
    changed[start] = 0;
    const queue = [start];
    let minX = cols, minY = rows, maxX = 0, maxY = 0;
    for (let index = 0; index < queue.length; index++) {
      const cell = queue[index], x = cell % cols, y = Math.floor(cell / cols);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + 1); maxY = Math.max(maxY, y + 1);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const neighbor = ny * cols + nx;
        if (changed[neighbor]) { changed[neighbor] = 0; queue.push(neighbor); }
      }
    }
    const x = Math.max(0, minX * tileSize - padding), y = Math.max(0, minY * tileSize - padding);
    regions.push({ x, y, width: Math.min(width, maxX * tileSize + padding) - x,
      height: Math.min(height, maxY * tileSize + padding) - y });
  }
  // Merge padding overlap so a pixel is never redundantly sent in two crops.
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i], b = regions[j];
      if (a.x > b.x + b.width || b.x > a.x + a.width || a.y > b.y + b.height || b.y > a.y + a.height) continue;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      regions[i] = { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y };
      regions.splice(j, 1); i = -1; break;
    }
  }
  return regions;
}

function makeCanvas(width, height) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height) : globalThis.document?.createElement('canvas');
  if (!canvas) throw new Error('Vision capture requires browser canvas support');
  canvas.width = width; canvas.height = height;
  return canvas;
}

function draw(source, width, height, rect) {
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Vision capture could not create a 2D canvas');
  context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  if (rect) context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  else context.drawImage(source, 0, 0, width, height);
  return canvas;
}

async function decode(dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)) {
    throw new Error('Vision capture requires a local PNG, JPEG or WebP data URL');
  }
  const blob = await (await fetch(dataUrl)).blob();
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  if (typeof Image === 'undefined') throw new Error('Vision capture requires image decoding support');
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Vision screenshot could not be decoded')); image.src = dataUrl;
  });
}

async function canvasBlob(canvas, mimeType, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: mimeType, quality });
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
    : reject(new Error('Vision screenshot encoding failed')), mimeType, quality));
}

async function blobDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function encodeBounded(source, rect, budget, maxBytes, initialSize = rect) {
  let width = initialSize.width, height = initialSize.height;
  let canvas = draw(source, width, height, rect);
  let quality = budget.initialJpegQuality;
  for (let attempt = 0; attempt < 12; attempt++) {
    const blob = await canvasBlob(canvas, budget.mimeType, quality);
    if (blob.size <= maxBytes) return {
      canvas, width, height, bytes: blob.size, mimeType: blob.type,
      dataUrl: await blobDataUrl(blob),
    };
    // One quality fallback before resizing. Repeated small quality decrements
    // are expensive in extension workers and barely help high-entropy frames.
    if (quality > budget.minJpegQuality) { quality = budget.minJpegQuality; continue; }
    if (width === 1 && height === 1) break;
    const ratio = Math.min(0.78, Math.sqrt(maxBytes / blob.size) * 0.9);
    width = Math.max(1, Math.floor(width * ratio)); height = Math.max(1, Math.floor(height * ratio));
    canvas = draw(source, width, height, rect);
  }
  throw new Error('Vision screenshot cannot fit the configured byte budget');
}

function pixels(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
}

function visionPointToCanvas(frame, { frameId, x, y, imageId } = {}) {
  if (!frame || frameId !== frame.frameId) throw new Error('Stale vision frame; capture a fresh screenshot before acting');
  if (!(Number.isFinite(x) && Number.isFinite(y))) throw new Error('Vision coordinates must be finite numbers');
  let pointX = x, pointY = y;
  if (imageId != null) {
    const image = frame.images.find(entry => entry.id === imageId);
    if (!image) throw new Error('Unknown vision crop image ID');
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) throw new Error('Vision coordinate is outside the crop');
    pointX = image.rect.x + x * image.rect.width / image.width;
    pointY = image.rect.y + y * image.rect.height / image.height;
  }
  if (pointX < 0 || pointY < 0 || pointX >= frame.canvas.width || pointY >= frame.canvas.height) {
    throw new Error('Vision coordinate is outside the captured viewport');
  }
  return { x: pointX, y: pointY };
}

/** Coordinates always name the newest observation, including unchanged frames.
 * Image dimensions, rather than DPR guesses, determine CSS scaling. */
export function visionPointToCss(frame, point = {}) {
  const { x, y } = visionPointToCanvas(frame, point);
  return {
    x: frame.viewport.offsetLeft + x * frame.viewport.width / frame.canvas.width,
    y: frame.viewport.offsetTop + y * frame.viewport.height / frame.canvas.height,
  };
}

export class VisionFrameSession {
  constructor({ budget = {}, keyframeInterval = 8, maxPatches = 4, tileSize = 32,
    diffThreshold = 12, cropPadding = 8, fullAreaRatio = 0.55, maxContextBytes = 512 * 1024,
    maxContextImages = 5, maxContextTokens = 2000 } = {}) {
    this.budget = { ...VISION_FRAME_BUDGET, ...budget };
    const b = this.budget;
    if (![b.maxTargetPx, b.maxTargetTokens, b.pxPerToken, b.maxBytes, maxContextBytes,
      b.minJpegQuality, b.initialJpegQuality, b.jpegQualityStep, fullAreaRatio, maxContextTokens].every(value => Number.isFinite(value) && value > 0)
        || b.maxBytes < 1024 || b.minJpegQuality <= 0 || b.initialJpegQuality > 1
        || b.initialJpegQuality < b.minJpegQuality || !(b.jpegQualityStep > 0)
        || !['image/jpeg', 'image/webp'].includes(b.mimeType)
        || !Number.isInteger(keyframeInterval) || keyframeInterval < 1
        || !Number.isInteger(maxPatches) || maxPatches < 1
        || !Number.isInteger(maxContextImages) || maxContextImages < 1
        || !Number.isInteger(tileSize) || tileSize < 1 || !Number.isFinite(diffThreshold) || diffThreshold < 0
        || !Number.isInteger(cropPadding) || cropPadding < 0 || fullAreaRatio <= 0 || fullAreaRatio > 1) {
      throw new Error('Invalid vision frame budget or diff options');
    }
    this.keyframeInterval = keyframeInterval; this.maxPatches = maxPatches;
    this.diffOptions = { tileSize, threshold: diffThreshold, padding: cropPadding };
    this.fullAreaRatio = fullAreaRatio; this.maxContextBytes = Math.max(maxContextBytes, b.maxBytes);
    this.maxContextImages = maxContextImages;
    this.maxContextTokens = Math.max(maxContextTokens, b.maxTargetTokens);
    this._prefix = `vf-${Date.now().toString(36)}-${++sessionCounter}`;
    this._sequence = 0; this._busy = false; this._generation = 0;
    this.reset();
  }

  reset() {
    this._generation++;
    this.latest = null; this._history = []; this._pixels = null;
    this._source = null; this._sinceFull = 0; this._contextBytes = 0;
  }

  contextFrames() {
    return this.latest?.kind === 'unchanged' ? [...this._history, this.latest] : [...this._history];
  }

  toCssPoint(point) { return visionPointToCss(this.latest, point); }

  assertViewport(viewport) {
    if (!this.latest || !sameViewport(this.latest.viewport, normalizeVisionViewport(viewport))) {
      throw new Error('Vision viewport changed; capture a fresh screenshot before acting');
    }
    return true;
  }

  /** Recheck only the intended targets immediately before native input. A
   * moving counter elsewhere must not make an otherwise valid click stale.
   * This validation never becomes a new model observation or a diff baseline. */
  async assertCurrentPixels(dataUrl, viewport, args, { radius = 32 } = {}) {
    if (!Number.isInteger(radius) || radius < 1 || radius > 128) throw new Error('Invalid vision target comparison radius');
    this.assertViewport(viewport);
    const frame = this.latest, generation = this._generation, reference = this._pixels;
    const points = [visionPointToCanvas(frame, args)];
    if (args.toX != null || args.toY != null) {
      points.push(visionPointToCanvas(frame, { ...args, x: args.toX, y: args.toY }));
    }
    let bitmap;
    try {
      bitmap = await decode(dataUrl);
      if (generation !== this._generation || this.latest !== frame) throw new Error('Stale vision frame during input validation');
      if (bitmap.width !== this._source.width || bitmap.height !== this._source.height) {
        throw new Error('Vision screenshot size changed; capture a fresh screenshot before acting');
      }
      const { width, height } = frame.canvas;
      const current = pixels(draw(bitmap, width, height));
      for (const point of points) {
        const left = Math.max(0, Math.floor(point.x) - radius), top = Math.max(0, Math.floor(point.y) - radius);
        const right = Math.min(width, Math.floor(point.x) + radius), bottom = Math.min(height, Math.floor(point.y) + radius);
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
          const pixel = (y * width + x) * 4;
          for (let channel = 0; channel < 4; channel++) {
            if (Math.abs(reference[pixel + channel] - current[pixel + channel]) > this.diffOptions.threshold) {
              throw new Error('Stale vision target: pixels changed near the requested point; capture a fresh screenshot before acting');
            }
          }
        }
      }
      return true;
    } finally { bitmap?.close?.(); }
  }

  async capture(dataUrl, viewport, { forceFull = false, reason = '' } = {}) {
    if (this._busy) throw new Error('A vision screenshot capture is already in progress');
    this._busy = true;
    const generation = this._generation;
    let bitmap;
    try {
      const normalized = normalizeVisionViewport(viewport);
      bitmap = await decode(dataUrl);
      const source = { width: bitmap.width, height: bitmap.height };
      if (!(source.width > 0 && source.height > 0)) throw new Error('Vision screenshot is empty');
      const sameGeometry = this.latest && sameViewport(this.latest.viewport, normalized)
        && source.width === this._source.width && source.height === this._source.height;
      // Retain the previous keyframe's dimensions after byte-driven downscaling.
      let [width, height] = sameGeometry ? [this.latest.canvas.width, this.latest.canvas.height]
        : fitImageDimensions(source.width, source.height, this.budget);
      let canvas = draw(bitmap, width, height), current = pixels(canvas);
      let full = forceFull || !sameGeometry || this._sinceFull >= this.keyframeInterval;
      let regions = full ? [] : changedVisionRegions(this._pixels, current, width, height, this.diffOptions);
      if (regions.length > this.maxPatches || regions.reduce((sum, r) => sum + r.width * r.height, 0) >= width * height * this.fullAreaRatio) full = true;
      const frameId = `${this._prefix}-${++this._sequence}`;
      let encoded = [];
      if (!full && regions.length) {
        const share = Math.floor(this.budget.maxBytes / regions.length);
        for (const rect of regions) encoded.push({ ...(await encodeBounded(canvas, rect, this.budget, share)), rect });
        if (this._contextBytes + encoded.reduce((sum, image) => sum + image.bytes, 0) > this.maxContextBytes
            || this._history.reduce((sum, frame) => sum + frame.images.length, 0) + encoded.length > this.maxContextImages
            || this._history.reduce((sum, frame) => sum + frame.estimatedTokens, 0)
              + encoded.reduce((sum, image) => sum + estimateImageTokens(image.width, image.height, this.budget.pxPerToken), 0) > this.maxContextTokens
            || encoded.reduce((sum, image) => sum + image.bytes, 0) >= this._history[0].bytes * 0.85) full = true;
      }
      if (full) {
        // Resize from the original bitmap, exactly as subsequent captures do.
        // Repeated resizing introduces differences even for identical pixels.
        const image = await encodeBounded(bitmap, { x: 0, y: 0, width: source.width, height: source.height },
          this.budget, this.budget.maxBytes, { width, height });
        canvas = image.canvas; width = image.width; height = image.height; current = pixels(canvas);
        encoded = [{ ...image, rect: { x: 0, y: 0, width, height } }];
      }
      if (generation !== this._generation) throw new Error('Vision session was reset during capture');
      const kind = full ? 'full' : encoded.length ? 'delta' : 'unchanged';
      const frame = {
        protocol: 'vision-frame-v1', frameId,
        baseFrameId: full ? frameId : this._history[0].frameId,
        // Unchanged observations are replaceable metadata, not image-chain
        // dependencies. Reference the preceding retained pixel packet so a
        // context rebuild never points at an omitted unchanged observation.
        previousFrameId: full ? null : this._history.at(-1).frameId,
        kind, reason: reason || (full ? !sameGeometry ? 'initial-or-viewport-change' : 'keyframe' : kind),
        capturedAt: Date.now(), viewport: normalized, source, canvas: { width, height },
        images: encoded.map((image, index) => ({
          id: `${frameId}:image-${index}`, dataUrl: image.dataUrl, mimeType: image.mimeType,
          width: image.width, height: image.height, rect: image.rect, bytes: image.bytes,
        })),
        bytes: encoded.reduce((sum, image) => sum + image.bytes, 0),
        estimatedTokens: encoded.reduce((sum, image) => sum + estimateImageTokens(image.width, image.height, this.budget.pxPerToken), 0),
      };
      if (full) {
        this._history = [frame]; this._contextBytes = frame.bytes; this._sinceFull = 0;
        this._pixels = current;
      } else {
        this._sinceFull++;
        if (kind === 'delta') {
          this._history.push(frame); this._contextBytes += frame.bytes;
          // Compare against the last sent pixels, retaining unsent sub-threshold
          // changes until they accumulate enough to become visible.
          for (const { rect } of encoded) {
            for (let y = rect.y; y < rect.y + rect.height; y++) {
              const start = (y * width + rect.x) * 4;
              this._pixels.set(current.subarray(start, start + rect.width * 4), start);
            }
          }
        }
      }
      this.latest = frame; this._source = source;
      return frame;
    } finally { bitmap?.close?.(); this._busy = false; }
  }
}
