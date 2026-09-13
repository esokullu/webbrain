/**
 * Dedicated bitgpu worker for the optional Bonsai 27B WebGPU text model.
 *
 * LFM2.5 stays on inference-worker.js (Transformers.js / ONNX). Bonsai 27B is a
 * 1-bit GGUF hybrid and cannot share that runtime. This worker speaks the same
 * text-download / text-chat message types so the offscreen host can route by
 * model id.
 */

import { createEngine } from '../../vendor/bitgpu/index.js';
import { createChat } from '../../vendor/bitgpu/chat.js';

const WEBGPU_BONSAI27_MODEL_ID = 'prism-ml/Bonsai-27B-gguf';
const WEBGPU_BONSAI27_DTYPE = 'q1';
const CACHE_NAME = 'bitgpu-models-v1';
const TEXT_DOWNLOAD_EVENT = 'text-download-state';
const WEBGPU_BONSAI27_MAX_NEW_TOKENS = 2048;
const WEBGPU_BONSAI27_THINK_BUDGET = 128;
const WEBGPU_BONSAI27_MAX_SEQ_LEN = 4096;
const OOM_HINT = 'This machine cannot hold Bonsai 27B in GPU memory. Use LFM2.5 2.6B instead.';

let workerConfig = null;
let textRuntime = null;
let textRuntimeLoadPromise = null;
let modelOperationQueue = Promise.resolve();
const readyTextModelKeys = new Set();
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
let queuedTextDownload = null;
let textDownloadAbortController = null;
let textDownloadCancelMode = '';
let lastTextProgressPostAt = 0;
let textToolCallSequence = 0;
let textDownloadState = {
  status: 'not-downloaded',
  ready: false,
  modelId: '',
  dtype: WEBGPU_BONSAI27_DTYPE,
  file: '',
  loaded: 0,
  total: 0,
  progress: 0,
  error: '',
};

function textModelKey(modelId, dtype) {
  return `${String(modelId || '').trim()}|${String(dtype || WEBGPU_BONSAI27_DTYPE).trim()}`;
}

function sameTextModel(leftModelId, leftDtype, rightModelId, rightDtype) {
  return textModelKey(leftModelId, leftDtype) === textModelKey(rightModelId, rightDtype);
}

function assertBonsaiModel(modelId) {
  const normalized = String(modelId || '').trim();
  if (normalized && normalized !== WEBGPU_BONSAI27_MODEL_ID) {
    throw new Error(`${normalized} is not the bundled Bonsai 27B WebGPU model.`);
  }
  return WEBGPU_BONSAI27_MODEL_ID;
}

function assertTextDownloadCanStart(payload) {
  const modelId = assertBonsaiModel(payload?.modelId);
  const dtype = payload?.dtype || WEBGPU_BONSAI27_DTYPE;
  const conflictsWithTransfer = textDownloadState.modelId
    && !sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype)
    && ['downloading', 'paused', 'stopping'].includes(textDownloadState.status);
  const conflictsWithQueued = queuedTextDownload
    && !sameTextModel(queuedTextDownload.modelId, queuedTextDownload.dtype, modelId, dtype);
  if (conflictsWithTransfer || conflictsWithQueued) {
    const blockingModel = conflictsWithTransfer ? textDownloadState.modelId : queuedTextDownload.modelId;
    throw new Error(`Finish or stop the ${blockingModel} download before downloading ${modelId}.`);
  }
  return { modelId, dtype, key: textModelKey(modelId, dtype) };
}

function textDownloadSnapshot() {
  return { ...textDownloadState };
}

function postTextDownloadState({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastTextProgressPostAt < 160) return;
  lastTextProgressPostAt = now;
  self.postMessage({ type: TEXT_DOWNLOAD_EVENT, state: textDownloadSnapshot() });
}

function mapGpuError(error) {
  const message = error?.message || String(error);
  if (error?.name === 'GpuOutOfMemoryError' || /GPU allocation failed|maxStorageBufferBindingSize|maxBufferSize/i.test(message)) {
    return new Error(`${OOM_HINT} ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

async function loadLibraries() {
  if (!workerConfig) throw new Error('Bonsai WebGPU worker was not initialized.');
  if (typeof createEngine !== 'function' || typeof createChat !== 'function') {
    throw new Error('The packaged bitgpu runtime could not be loaded.');
  }
  return { createEngine, createChat };
}

function textReadyMarkerUrl(modelId, dtype) {
  const key = encodeURIComponent(textModelKey(modelId, dtype));
  return `https://webbrain.one/.well-known/webgpu-model-ready/${key}`;
}

function cacheStorageKey(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {
    // Packaged chrome-extension:// files cannot be Cache Storage keys.
  }
  return '';
}

function isGgufUrl(url) {
  return /\.gguf(?:$|[?#])/i.test(String(url || ''));
}

function opfsWeightName(url) {
  const file = decodeURIComponent(String(url || '').split('/').pop()?.split('?')[0] || '');
  return /^[\w.-]+\.gguf$/i.test(file) ? file : '';
}

function cacheableCopy(body, response) {
  const headers = new Headers();
  const type = response?.headers?.get?.('content-type');
  const length = response?.headers?.get?.('content-length');
  if (type) headers.set('content-type', type);
  if (length) headers.set('content-length', length);
  return new Response(body, { status: 200, statusText: 'OK', headers });
}

async function opfsModelsDirectory(create = false) {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return null;
  const root = await storage.getDirectory();
  return await root.getDirectoryHandle('webbrain-webgpu-models', { create });
}

async function opfsWeightHandle(url, create = false) {
  const name = opfsWeightName(url);
  if (!name) return null;
  try {
    const dir = await opfsModelsDirectory(create);
    if (!dir) return null;
    return { dir, name, handle: await dir.getFileHandle(name, { create }) };
  } catch {
    return null;
  }
}

function opfsCompleteName(name) {
  return `${name}.complete`;
}

function opfsPartialName(name) {
  return `${name}.partial`;
}

async function readOpfsCompleteSize(dir, name) {
  try {
    const handle = await dir.getFileHandle(opfsCompleteName(name));
    const meta = JSON.parse(await (await handle.getFile()).text());
    const size = Number(meta?.size);
    return Number.isFinite(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

async function writeOpfsComplete(dir, name, size) {
  const handle = await dir.getFileHandle(opfsCompleteName(name), { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify({ size }));
  await writable.close();
}

async function readOpfsPartial(url) {
  const file = await opfsWeightHandle(url, false);
  if (!file) return null;
  try {
    const handle = await file.dir.getFileHandle(opfsPartialName(file.name));
    const meta = JSON.parse(await (await handle.getFile()).text());
    const blob = await file.handle.getFile();
    const size = Number(meta?.size);
    const total = Number(meta?.total);
    if (!Number.isFinite(size) || size <= 0 || blob.size !== size) return null;
    if (Number.isFinite(total) && total > 0 && size > total) return null;
    if (meta?.url && meta.url !== String(url)) return null;
    return {
      size,
      total: Number.isFinite(total) && total > 0 ? total : 0,
      etag: String(meta?.etag || ''),
      lastModified: String(meta?.lastModified || ''),
      file,
    };
  } catch {
    return null;
  }
}

async function writeOpfsPartial(file, url, size, total, response, validators = {}) {
  const handle = await file.dir.getFileHandle(opfsPartialName(file.name), { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify({
    url: String(url),
    size,
    total: Number(total) || 0,
    etag: response?.headers?.get?.('etag') || validators.etag || '',
    lastModified: response?.headers?.get?.('last-modified') || validators.lastModified || '',
  }));
  await writable.close();
}

async function opfsWeightResponse(url) {
  const file = await opfsWeightHandle(url, false);
  if (!file) return null;
  const expected = await readOpfsCompleteSize(file.dir, file.name);
  const blob = await file.handle.getFile();
  if (!expected || blob.size !== expected) return null;
  return new Response(blob.stream(), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.size),
    },
  });
}

async function removeOpfsWeight(url) {
  const name = opfsWeightName(url);
  if (!name) return;
  try {
    const dir = await opfsModelsDirectory(false);
    if (!dir) return;
    await dir.removeEntry(name).catch(() => {});
    await dir.removeEntry(opfsCompleteName(name)).catch(() => {});
    await dir.removeEntry(opfsPartialName(name)).catch(() => {});
  } catch {
    // Missing or already-cleared weights are not an error.
  }
}

function noteWeightProgress(loaded, total) {
  textDownloadState = {
    ...textDownloadState,
    status: 'downloading',
    file: 'weights',
    loaded,
    total: total || textDownloadState.total,
    progress: total > 0 ? Math.min(100, (loaded / total) * 100) : textDownloadState.progress,
    error: '',
  };
  postTextDownloadState();
}

async function persistGgufToOpfs(url, response, signal, {
  offset = 0,
  expectedTotal = 0,
  etag = '',
  lastModified = '',
} = {}) {
  navigator.storage?.persist?.().catch(() => {});
  const file = await opfsWeightHandle(url, true);
  if (!file) throw new Error('Origin Private File System storage is unavailable for the Basic model.');
  await file.dir.removeEntry(opfsCompleteName(file.name)).catch(() => {});
  const start = Math.max(0, Number(offset) || 0);
  if (!start) await file.dir.removeEntry(opfsPartialName(file.name)).catch(() => {});
  const writable = await file.handle.createWritable({ keepExistingData: start > 0 });
  if (start > 0) await writable.seek(start);
  const encoding = String(response.headers.get('content-encoding') || '').toLowerCase();
  const responseLength = !encoding || encoding === 'identity'
    ? Number(response.headers.get('content-length')) || 0
    : 0;
  const total = Number(expectedTotal) || (responseLength ? start + responseLength : 0);
  let loaded = start;
  const reader = (response.body || cacheableCopy(await response.arrayBuffer(), response).body).getReader();
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('The download was aborted.', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value?.byteLength || value?.length || 0;
      await writable.write(value);
      noteWeightProgress(loaded, total);
    }
    await writable.close();
  } catch (error) {
    if (signal?.aborted && textDownloadCancelMode === 'pause' && loaded > 0) {
      try {
        await writable.close();
        const saved = await file.handle.getFile();
        await writeOpfsPartial(file, url, saved.size, total, response, { etag, lastModified });
        textDownloadState = {
          ...textDownloadState,
          file: 'weights',
          loaded: saved.size,
          total: total || textDownloadState.total,
          progress: total > 0 ? Math.min(100, (saved.size / total) * 100) : textDownloadState.progress,
        };
      } catch {
        await writable.abort(error).catch(() => {});
        await removeOpfsWeight(url);
      }
    } else {
      await writable.abort(error).catch(() => {});
      await removeOpfsWeight(url);
    }
    throw error;
  }
  if (total > 0 && loaded !== total) {
    await removeOpfsWeight(url);
    throw new Error(`Basic model length mismatch (${loaded}/${total}).`);
  }
  if (!loaded) {
    await removeOpfsWeight(url);
    throw new Error('The Basic model download was empty.');
  }
  await writeOpfsComplete(file.dir, file.name, loaded);
  await file.dir.removeEntry(opfsPartialName(file.name)).catch(() => {});
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

function partialResumeValidator(partial) {
  const etag = String(partial?.etag || '').trim();
  if (etag && !/^W\//i.test(etag)) {
    return { responseHeader: 'etag', value: etag };
  }
  const lastModified = String(partial?.lastModified || '').trim();
  if (lastModified) {
    return { responseHeader: 'last-modified', value: lastModified };
  }
  return null;
}

function partialMatchesResponse(partial, response, range, validator) {
  if (response.status !== 206 || !range || range.start !== partial.size) return false;
  if (partial.total > 0 && range.total !== partial.total) return false;
  if (!validator || response.headers.get(validator.responseHeader) !== validator.value) return false;
  const etag = response.headers.get('etag') || '';
  const lastModified = response.headers.get('last-modified') || '';
  if (partial.etag && etag && partial.etag !== etag) return false;
  if (partial.lastModified && lastModified && partial.lastModified !== lastModified) return false;
  const length = Number(response.headers.get('content-length')) || 0;
  return !length || length === range.end - range.start + 1;
}

async function fetchGgufForStorage(url, signal) {
  const partial = await readOpfsPartial(url);
  if (partial?.total > 0 && partial.size === partial.total) {
    await writeOpfsComplete(partial.file.dir, partial.file.name, partial.size);
    await partial.file.dir.removeEntry(opfsPartialName(partial.file.name)).catch(() => {});
    return { stored: await opfsWeightResponse(url) };
  }

  const fetchOptions = { signal, redirect: 'follow' };
  if (!partial) return { response: await nativeFetch(url, fetchOptions), offset: 0, expectedTotal: 0 };

  // A byte range is safe only when the server proves it still represents the
  // same object. Weak ETags cannot be used with If-Range, so fall back to a
  // persisted Last-Modified value or discard the partial download.
  const validator = partialResumeValidator(partial);
  if (!validator) {
    await removeOpfsWeight(url);
    return { response: await nativeFetch(url, fetchOptions), offset: 0, expectedTotal: 0 };
  }

  let response = await nativeFetch(url, {
    ...fetchOptions,
    headers: {
      Range: `bytes=${partial.size}-`,
      'If-Range': validator.value,
    },
  });
  const range = parseContentRange(response.headers.get('content-range'));
  if (partialMatchesResponse(partial, response, range, validator)) {
    return {
      response,
      offset: partial.size,
      expectedTotal: range.total,
      etag: partial.etag,
      lastModified: partial.lastModified,
    };
  }

  if (response.status === 200) {
    await removeOpfsWeight(url);
    return { response, offset: 0, expectedTotal: 0 };
  }

  await response.body?.cancel?.().catch(() => {});
  await removeOpfsWeight(url);
  response = await nativeFetch(url, fetchOptions);
  return { response, offset: 0, expectedTotal: 0 };
}

async function cachedResponse(url, { signal } = {}) {
  if (!nativeFetch) throw new Error('Fetch is unavailable in the Bonsai WebGPU worker.');
  const cacheKey = cacheStorageKey(url);
  const persistGguf = isGgufUrl(url);

  if (persistGguf) {
    const existing = await opfsWeightResponse(url);
    if (existing) return existing;
    if (cacheKey && typeof caches !== 'undefined') {
      try {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(cacheKey);
        if (cached) {
          await persistGgufToOpfs(url, cached, signal);
          await cache.delete(cacheKey).catch(() => {});
          const migrated = await opfsWeightResponse(url);
          if (migrated) return migrated;
        }
      } catch {
        // A previous Cache Storage copy is optional; fetch a fresh GGUF below.
      }
    }
  } else if (cacheKey && typeof caches !== 'undefined') {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const fetched = persistGguf
    ? await fetchGgufForStorage(url, signal)
    : { response: await nativeFetch(url, signal ? { signal, redirect: 'follow' } : { redirect: 'follow' }) };
  if (fetched.stored) return fetched.stored;
  const { response } = fetched;
  if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status}`);

  if (persistGguf) {
    await persistGgufToOpfs(url, response, signal, fetched);
    const stored = await opfsWeightResponse(url);
    if (!stored) throw new Error('The Basic model downloaded but could not be saved on this device.');
    return stored;
  }

  // Packaged chrome-extension:// manifest/aux files are already on disk.
  if (!cacheKey) return response;

  const cache = await caches.open(CACHE_NAME);
  await cache.put(cacheKey, cacheableCopy(response.body, response));
  const stored = await cache.match(cacheKey);
  if (!stored) throw new Error(`Could not save ${url} in the local model cache.`);
  return stored;
}

function createFetchHooks(signal) {
  const fetchJson = async (url) => {
    const response = await cachedResponse(url, { signal });
    return response.json();
  };
  const fetchStream = async (url) => {
    const response = await cachedResponse(url, { signal });
    if (!response.body) throw new Error(`fetch ${url} returned no body.`);
    return response.body;
  };
  return { fetchJson, fetchStream };
}

async function hasStoredGguf(dataUrl) {
  if (await opfsWeightResponse(dataUrl)) return true;
  const cacheKey = cacheStorageKey(dataUrl);
  if (!cacheKey || typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return Boolean(await cache.match(cacheKey));
  } catch {
    return false;
  }
}

async function isTextModelReady(modelId = WEBGPU_BONSAI27_MODEL_ID, dtype = WEBGPU_BONSAI27_DTYPE) {
  const key = textModelKey(modelId, dtype);
  if (readyTextModelKeys.has(key)) return true;
  if (!workerConfig?.dataUrl || typeof caches === 'undefined') return false;
  try {
    if (!await hasStoredGguf(workerConfig.dataUrl)) return false;
    const cache = await caches.open(CACHE_NAME);
    const marker = await cache.match(textReadyMarkerUrl(modelId, dtype));
    if (!marker) return false;
    readyTextModelKeys.add(key);
    return true;
  } catch {
    return false;
  }
}

async function markTextModelReady(modelId, dtype) {
  const key = textModelKey(modelId, dtype);
  if (!workerConfig?.dataUrl || !await hasStoredGguf(workerConfig.dataUrl)) {
    throw new Error('The Basic model downloaded but could not be saved on this device. Check that this browser has enough disk space.');
  }
  if (typeof caches === 'undefined') throw new Error('Cache Storage is unavailable for the Basic model ready marker.');
  const cache = await caches.open(CACHE_NAME);
  await cache.put(textReadyMarkerUrl(modelId, dtype), new Response(JSON.stringify({ modelId, dtype }), {
    headers: { 'content-type': 'application/json' },
  }));
  readyTextModelKeys.add(key);
}

async function getTextDownloadStatus(modelId, dtype) {
  const normalized = assertBonsaiModel(modelId);
  const normalizedDtype = dtype || WEBGPU_BONSAI27_DTYPE;
  const ready = await isTextModelReady(normalized, normalizedDtype);
  const sameModel = sameTextModel(textDownloadState.modelId, textDownloadState.dtype, normalized, normalizedDtype);
  if (sameModel && ['downloading', 'paused', 'stopping'].includes(textDownloadState.status)) {
    return textDownloadSnapshot();
  }
  if (ready) {
    return {
      status: 'ready',
      ready: true,
      modelId: normalized,
      dtype: normalizedDtype,
      file: sameModel ? textDownloadState.file : '',
      loaded: sameModel ? textDownloadState.loaded : 0,
      total: sameModel ? textDownloadState.total : 0,
      progress: 100,
      error: '',
    };
  }
  if (sameModel && textDownloadState.status === 'error') return textDownloadSnapshot();
  const partial = workerConfig?.dataUrl ? await readOpfsPartial(workerConfig.dataUrl) : null;
  if (partial) {
    textDownloadState = {
      status: 'paused',
      ready: false,
      modelId: normalized,
      dtype: normalizedDtype,
      file: 'weights',
      loaded: partial.size,
      total: partial.total,
      progress: partial.total > 0 ? Math.min(100, (partial.size / partial.total) * 100) : 0,
      error: '',
    };
    return textDownloadSnapshot();
  }
  return {
    status: 'not-downloaded',
    ready: false,
    modelId: normalized,
    dtype: normalizedDtype,
    file: '',
    loaded: 0,
    total: 0,
    progress: 0,
    error: '',
  };
}

async function disposeTextRuntime() {
  if (textRuntimeLoadPromise) {
    try { await textRuntimeLoadPromise; } catch { /* load failed or was aborted */ }
  }
  try { textRuntime?.engine?.dispose?.(); } catch { /* GPU may already be lost */ }
  textRuntime = null;
  textRuntimeLoadPromise = null;
}

async function getTextRuntime({ localFilesOnly = false } = {}) {
  if (textRuntime) return textRuntime;
  if (textRuntimeLoadPromise) return textRuntimeLoadPromise;
  if (localFilesOnly && !await isTextModelReady()) {
    throw new Error(`${WEBGPU_BONSAI27_MODEL_ID} is not downloaded. Open Settings > Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  textRuntimeLoadPromise = (async () => {
    const { createEngine: engineCreate, createChat: chatCreate } = await loadLibraries();
    navigator.storage?.persist?.().catch(() => {});
    const controller = textDownloadAbortController;
    const { fetchJson, fetchStream } = createFetchHooks(controller?.signal);
    const engine = await engineCreate({
      manifestUrl: workerConfig.manifestUrl,
      auxUrl: workerConfig.auxUrl,
      dataUrl: workerConfig.dataUrl,
      kvCache: 'q8',
      activation: 'f16',
      maxSeqLen: WEBGPU_BONSAI27_MAX_SEQ_LEN,
      fetchJson,
      fetchStream,
      onProgress(progress) {
        if (textDownloadCancelMode) return;
        const loaded = Math.max(0, Number(progress?.loaded) || 0);
        const total = Math.max(0, Number(progress?.total) || 0);
        const phase = String(progress?.phase || 'weights');
        textDownloadState = {
          ...textDownloadState,
          status: 'downloading',
          ready: false,
          modelId: WEBGPU_BONSAI27_MODEL_ID,
          dtype: WEBGPU_BONSAI27_DTYPE,
          file: phase,
          loaded,
          total,
          progress: total > 0 ? Math.min(100, (loaded / total) * 100) : textDownloadState.progress,
          error: '',
        };
        postTextDownloadState();
      },
    });
    let chat;
    try {
      chat = await chatCreate(engine, {
        tokenizerJsonUrl: workerConfig.tokenizerJsonUrl,
        tokenizerConfigUrl: workerConfig.tokenizerConfigUrl,
        fetchJson,
      });
    } catch (error) {
      try { await engine.dispose?.(); } catch { /* GPU cleanup is best-effort after tokenizer failure. */ }
      throw error;
    }
    textRuntime = { engine, chat };
    return textRuntime;
  })();
  try {
    return await textRuntimeLoadPromise;
  } catch (error) {
    await disposeTextRuntime();
    throw mapGpuError(error);
  } finally {
    textRuntimeLoadPromise = null;
  }
}

async function downloadTextModel(payload, { onStarted } = {}) {
  const modelId = assertBonsaiModel(payload?.modelId);
  const dtype = payload?.dtype || WEBGPU_BONSAI27_DTYPE;
  if (await isTextModelReady(modelId, dtype)) {
    textDownloadState = {
      ...textDownloadState,
      status: 'ready',
      ready: true,
      modelId,
      dtype,
      progress: 100,
      error: '',
    };
    postTextDownloadState({ force: true });
    return textDownloadSnapshot();
  }

  const resuming = textDownloadState.status === 'paused'
    && sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype);
  textDownloadCancelMode = '';
  const controller = new AbortController();
  textDownloadAbortController = controller;
  textDownloadState = {
    status: 'downloading',
    ready: false,
    modelId,
    dtype,
    file: resuming ? textDownloadState.file : 'weights',
    loaded: resuming ? textDownloadState.loaded : 0,
    total: resuming ? textDownloadState.total : 0,
    progress: resuming ? textDownloadState.progress : 0,
    error: '',
  };
  postTextDownloadState({ force: true });
  onStarted?.(textDownloadSnapshot());

  try {
    await getTextRuntime();
    if (textDownloadCancelMode) {
      await disposeTextRuntime();
      return textDownloadSnapshot();
    }
    try {
      await markTextModelReady(modelId, dtype);
    } catch (error) {
      await disposeTextRuntime();
      throw error;
    }
    textDownloadState = {
      ...textDownloadState,
      status: 'ready',
      ready: true,
      progress: 100,
      error: '',
    };
    postTextDownloadState({ force: true });
    return textDownloadSnapshot();
  } catch (error) {
    if (textDownloadCancelMode === 'pause' || textDownloadCancelMode === 'stop' || controller.signal.aborted) {
      textDownloadState = {
        ...textDownloadState,
        status: textDownloadCancelMode === 'stop' ? 'stopping' : 'paused',
        ready: false,
        error: '',
      };
      postTextDownloadState({ force: true });
      return textDownloadSnapshot();
    }
    const mapped = mapGpuError(error);
    textDownloadState = {
      ...textDownloadState,
      status: 'error',
      ready: false,
      error: mapped.message,
    };
    postTextDownloadState({ force: true });
    throw mapped;
  } finally {
    if (textDownloadAbortController === controller) textDownloadAbortController = null;
  }
}

function pauseTextDownload() {
  if (textDownloadState.status !== 'downloading') return textDownloadSnapshot();
  textDownloadCancelMode = 'pause';
  textDownloadState = { ...textDownloadState, status: 'paused', ready: false, error: '' };
  textDownloadAbortController?.abort();
  postTextDownloadState({ force: true });
  return textDownloadSnapshot();
}

async function clearTextModelCache(modelId, dtype) {
  await disposeTextRuntime();
  const normalized = assertBonsaiModel(modelId);
  const normalizedDtype = dtype || WEBGPU_BONSAI27_DTYPE;
  if (workerConfig?.dataUrl) await removeOpfsWeight(workerConfig.dataUrl);
  if (typeof caches !== 'undefined' && workerConfig) {
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const url of [
        cacheStorageKey(workerConfig.dataUrl),
        cacheStorageKey(workerConfig.tokenizerJsonUrl),
        cacheStorageKey(workerConfig.tokenizerConfigUrl),
        textReadyMarkerUrl(normalized, normalizedDtype),
      ].filter(Boolean)) {
        await cache.delete(url);
      }
    } catch { /* cache removal is best-effort */ }
  }
  readyTextModelKeys.delete(textModelKey(normalized, normalizedDtype));
  textDownloadCancelMode = '';
  const clearedState = {
    status: 'not-downloaded',
    ready: false,
    modelId: normalized,
    dtype: normalizedDtype,
    file: '',
    loaded: 0,
    total: 0,
    progress: 0,
    error: '',
  };
  textDownloadState = clearedState;
  postTextDownloadState({ force: true });
  return { ...clearedState };
}

function enqueueModelOperation(operation) {
  const result = modelOperationQueue.then(operation, operation);
  modelOperationQueue = result.catch(() => {});
  return result;
}

function toolArgumentsObject(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function prepareHistoricalToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => {
    const fn = toolCall?.function && typeof toolCall.function === 'object'
      ? toolCall.function
      : toolCall;
    const name = String(fn?.name || '').trim();
    if (!name) return null;
    return { name, arguments: toolArgumentsObject(fn?.arguments) };
  }).filter(Boolean);
}

function prepareTextMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!message || typeof message !== 'object') return { role: 'user', content: '' };
    const role = ['system', 'user', 'assistant', 'tool'].includes(message.role) ? message.role : 'user';
    const prepared = { role, content: '' };
    if (Array.isArray(message.content)) {
      prepared.content = message.content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
    } else {
      prepared.content = String(message.content || '');
    }
    if (role === 'assistant') {
      const toolCalls = prepareHistoricalToolCalls(message.tool_calls);
      if (toolCalls.length) prepared.tool_calls = toolCalls;
    }
    if (role === 'tool' && message.tool_call_id) prepared.tool_call_id = String(message.tool_call_id);
    return prepared;
  }).filter(message => message.content || message.role === 'system' || message.tool_calls?.length);
}

function normalizeBitgpuToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => {
    const name = String(toolCall?.name || '').trim();
    if (!name) return null;
    let args = '{}';
    try {
      args = typeof toolCall.arguments === 'string'
        ? toolCall.arguments
        : JSON.stringify(toolCall.arguments || {});
    } catch { /* Keep the safe empty object fallback. */ }
    textToolCallSequence += 1;
    return {
      id: `bitgpu_call_${Date.now().toString(36)}_${textToolCallSequence}`,
      type: 'function',
      function: { name, arguments: args },
    };
  }).filter(Boolean);
}

async function runText(payload) {
  const modelId = assertBonsaiModel(payload?.modelId);
  if (!await isTextModelReady(modelId, payload?.dtype || WEBGPU_BONSAI27_DTYPE)) {
    throw new Error(`${modelId} is not downloaded. Open Settings > Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  const runtime = await getTextRuntime({ localFilesOnly: true });
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(WEBGPU_BONSAI27_MAX_NEW_TOKENS, Math.round(requestedTokens)))
    : WEBGPU_BONSAI27_MAX_NEW_TOKENS;
  const tools = Array.isArray(payload?.options?.tools) ? payload.options.tools : [];
  let result;
  try {
    result = await runtime.chat.send(prepareTextMessages(payload?.messages), {
      think: true,
      thinkBudget: WEBGPU_BONSAI27_THINK_BUDGET,
      maxTokens,
      temperature: 0.5,
      topP: 0.85,
      topK: 20,
      tools: tools.length ? tools : undefined,
    });
  } catch (error) {
    throw mapGpuError(error);
  }
  const content = String(result?.text || '').trim();
  const reasoningContent = String(result?.thinkText || '').trim() || null;
  const toolCalls = normalizeBitgpuToolCalls(result?.toolCalls);
  if (!content && !toolCalls.length && reasoningContent) {
    throw new Error(`${modelId} used its generation budget before finishing reasoning. Retry with a shorter prompt.`);
  }
  if (!content && !toolCalls.length) throw new Error('The WebGPU model returned no generated text or tool calls.');
  return { content, reasoningContent, toolCalls };
}

async function probeRuntime() {
  const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  let adapter = null;
  if (hasWebGPU) {
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch {}
  }
  const isFallbackAdapter = !!(adapter?.isFallbackAdapter ?? adapter?.info?.isFallbackAdapter);
  return {
    libraryVersion: 'bitgpu-0.19.1',
    hasWebGPU: hasWebGPU && !!adapter,
    isFallbackAdapter,
    adapterFeatures: adapter ? [...adapter.features].slice(0, 12) : [],
  };
}

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === 'init') {
      workerConfig = payload;
      self.postMessage({ id, ok: true });
      return;
    }
    if (type === 'probe') {
      self.postMessage({ id, ok: true, ...(await probeRuntime()) });
      return;
    }
    if (type === 'text-download-status') {
      self.postMessage({ id, ok: true, ...(await getTextDownloadStatus(payload?.modelId, payload?.dtype)) });
      return;
    }
    if (type === 'start-download-text') {
      const request = assertTextDownloadCanStart(payload);
      queuedTextDownload = request;
      let acknowledged = false;
      const operation = enqueueModelOperation(() => {
        if (queuedTextDownload !== request) return getTextDownloadStatus(request.modelId, request.dtype);
        return downloadTextModel(payload, {
          onStarted(state) {
            acknowledged = true;
            self.postMessage({ id, ok: true, ...state });
          },
        });
      });
      void operation.then((state) => {
        if (!acknowledged) self.postMessage({ id, ok: true, ...state });
      }).catch((error) => {
        if (!acknowledged) self.postMessage({ id, ok: false, error: error?.message || String(error) });
      }).finally(() => {
        if (queuedTextDownload === request) queuedTextDownload = null;
      });
      return;
    }
    if (type === 'pause-text-download') {
      self.postMessage({ id, ok: true, ...pauseTextDownload() });
      return;
    }
    if (type === 'stop-text-download') {
      const modelId = assertBonsaiModel(payload?.modelId);
      const dtype = payload?.dtype || WEBGPU_BONSAI27_DTYPE;
      const targetsQueuedTransfer = queuedTextDownload
        && sameTextModel(queuedTextDownload.modelId, queuedTextDownload.dtype, modelId, dtype);
      if (targetsQueuedTransfer) queuedTextDownload = null;
      textDownloadCancelMode = 'stop';
      textDownloadState = { ...textDownloadState, status: 'stopping', ready: false, error: '' };
      textDownloadAbortController?.abort();
      postTextDownloadState({ force: true });
      const state = await enqueueModelOperation(() => clearTextModelCache(modelId, dtype));
      self.postMessage({ id, ok: true, ...state });
      return;
    }
    if (type === 'dispose-text' || type === 'dispose' || type === 'dispose-all') {
      await enqueueModelOperation(disposeTextRuntime);
      self.postMessage({ id, ok: true, disposed: true });
      return;
    }
    if (type === 'text-chat') {
      const result = await enqueueModelOperation(() => runText(payload));
      self.postMessage({
        id,
        ok: true,
        ...result,
        raw: { model: payload?.modelId || WEBGPU_BONSAI27_MODEL_ID },
      });
      return;
    }
    throw new Error(`Unknown Bonsai WebGPU worker message: ${type || 'missing type'}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
