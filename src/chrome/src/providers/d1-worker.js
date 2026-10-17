import { D1_MODEL_ID, D1_CONSENT_VERSION, D1_RELEASE, assertD1Adapter } from './d1-config.js';
import { openD1Cache, readD1Manifest, validateD1Manifest, d1CachedFile, setD1Ready, removeStaleD1Caches } from './d1-cache.js';
import { createD1Runtime } from './d1-runtime.js';

let runtime = null, device = null, state = { status: 'idle', progress: 0, loaded: false }, transfer = null;
let queue = Promise.resolve();
const publish = update => { state = { ...state, ...update }; self.postMessage({ state }); };
const errors = [];

async function probe() {
  if (!navigator.gpu) throw new Error('Hardware WebGPU is unavailable in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  return { adapter, info: assertD1Adapter(adapter) };
}

async function prepare(signal) {
  if (runtime) return { ready: true, ...state };
  const { adapter, info } = await probe();
  const directory = await openD1Cache(), manifest = await readD1Manifest(directory), specs = validateD1Manifest(manifest);
  const { PreTrainedTokenizer } = await import('../../vendor/d1/transformers.web.js');
  const ort = await import('../../vendor/d1/ort.webgpu.bundle.min.mjs');
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.logLevel = 'warning';
  ort.env.wasm.wasmPaths = { mjs: new URL('../../vendor/d1/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href, wasm: new URL('../../vendor/d1/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href };
  const loadingDevice = await adapter.requestDevice({ requiredFeatures: ['shader-f16'].filter(feature => adapter.features.has(feature)), requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension } });
  device = loadingDevice; ort.env.webgpu.device = loadingDevice;
  loadingDevice.addEventListener('uncapturederror', event => { errors.push(String(event.error.message)); publish({ error: String(event.error.message) }); });
  loadingDevice.lost.then(info => { if (info.reason !== 'destroyed' && device === loadingDevice) { runtime = null; publish({ status: 'error', loaded: false, error: 'WebGPU device lost: ' + info.message }); } });
  const json = async path => JSON.parse(await (await d1CachedFile(directory, specs[path], { signal })).text());
  const sessions = {};
  try {
    const config = await json('config.json'), ratios = await json('tiling-ratios.json');
    const tokenizer = new PreTrainedTokenizer(await json('tokenizer.json'), await json('tokenizer_config.json'));
    for (const role of ['decision', 'vision', 'projector']) {
      publish({ status: 'loading', component: role, adapter: info });
      const graph = new Uint8Array(await (await d1CachedFile(directory, specs[`onnx/${role}.onnx`], { signal })).arrayBuffer());
      const data = new Uint8Array(await (await d1CachedFile(directory, specs[`onnx/${role}.data`], { signal })).arrayBuffer());
      // Vision and projector outputs feed the next graph on the GPU (d1-runtime.js).
      const preferredOutputLocation = { vision: { hidden: 'gpu-buffer' }, projector: { prefix: 'gpu-buffer' } }[role];
      sessions[role] = await ort.InferenceSession.create(graph, { executionProviders: [{ name: 'webgpu', device: loadingDevice }], graphOptimizationLevel: 'basic', logSeverityLevel: 2, ...(preferredOutputLocation ? { preferredOutputLocation } : {}), extra: { session: { disable_cpu_ep_fallback: '0' } }, externalData: [{ path: `${role}.data`, data }] });
      if (signal?.aborted) throw signal.reason;
    }
    runtime = createD1Runtime({ ort, tokenizer, config, ratios, sessions, device: loadingDevice, model: D1_MODEL_ID, dtype: manifest.dtype });
    publish({ status: 'ready', loaded: true, progress: 100, adapter: info, runtime: ort.env.versions, error: '', cpu_fallback_policy: 'CPU/WASM control/shape fallback allowed; not a pure GPU claim.' });
    return { ready: true, ...state };
  } catch (error) { for (const session of Object.values(sessions)) await session.release().catch(() => {}); loadingDevice.destroy(); if (device === loadingDevice) device = null; publish({ status: signal?.aborted ? 'stopped' : 'error', loaded: false, error: String(error.message || error) }); throw error; }
}

async function status() {
  if (transfer || runtime || ['error', 'stopped'].includes(state.status)) return { ...state, ready: !!runtime };
  try {
    const directory = await openD1Cache();
    const marker = JSON.parse(await (await (await directory.getFileHandle('ready.json')).getFile()).text());
    return { ...state, status: marker.revision === D1_RELEASE.revision && marker.manifestSha256 === D1_RELEASE.manifestSha256 ? 'cached' : 'idle', ready: false, loaded: false };
  } catch { return { ...state, ready: false }; }
}

function startDownload(payload) {
  if (payload?.consentVersion !== D1_CONSENT_VERSION) throw new Error('Explicit experimental D1 download consent is required.');
  if (transfer) return { started: true, ...state };
  if (runtime) return { started: false, ready: true, ...state };
  const controller = new AbortController(); transfer = controller;
  let stall;
  const resetStall = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(new Error('D1 download made no byte progress for two minutes.')), 120_000); };
  const deadline = setTimeout(() => controller.abort(new Error('D1 download/load exceeded thirty minutes.')), 30 * 60_000);
  resetStall();
  publish({ status: 'checking', error: '', progress: 0 });
  (async () => {
    await probe();
    // Packages for other revisions are never loaded again; free their storage.
    await removeStaleD1Caches().catch(() => {});
    const directory = await openD1Cache(), manifest = await readD1Manifest(directory, { download: true, signal: controller.signal }), specs = validateD1Manifest(manifest);
    await setD1Ready(directory, false);
    const total = Object.values(specs).reduce((n, spec) => n + spec.bytes, 0); let completed = 0;
    for (const spec of Object.values(specs)) {
      await d1CachedFile(directory, spec, { download: true, signal: controller.signal, onProgress: loaded => { resetStall(); publish({ status: 'downloading', file: spec.path, progress: (completed + loaded) / total * 100, bytes: completed + loaded, total }); } });
      completed += spec.bytes; publish({ status: 'downloading', progress: completed / total * 100, bytes: completed, total });
      resetStall();
    }
    await setD1Ready(directory, true); await prepare(controller.signal);
  })().catch(error => publish({ status: controller.signal.aborted ? 'stopped' : 'error', loaded: false, error: String(error.message || error) })).finally(() => { clearTimeout(stall); clearTimeout(deadline); if (transfer === controller) transfer = null; });
  return { started: true, ...state };
}

async function execute(type, payload = {}) {
  if (type === 'probe') { const { adapter, info } = await probe(); return { success: true, adapter: info, features: [...adapter.features] }; }
  if (type === 'status') return status();
  if (type === 'download') return startDownload(payload);
  if (type === 'stop') { transfer?.abort(new Error('D1 download stopped by user.')); return { stopped: true }; }
  if (type === 'dispose') { transfer?.abort(new Error('D1 disabled.')); await runtime?.dispose(); runtime = null; device = null; publish({ status: 'idle', loaded: false }); return { disposed: true }; }
  if (type === 'load') { if (payload.consentVersion !== D1_CONSENT_VERSION) throw new Error('D1 consent is required.'); if (transfer) throw new Error('D1 download/load is already in progress.'); return prepare(); }
  if (type === 'clear') { if (runtime || transfer) throw new Error('Disable D1 before removing its cache.'); const directory = await openD1Cache(); for await (const [name] of directory.entries()) await directory.removeEntry(name); publish({ status: 'idle', loaded: false }); return { removed: true }; }
  if (type === 'evaluate') { if (!runtime) throw new Error('D1 is not loaded. Download or load it explicitly in Decision models settings.'); const result = await runtime.evaluate(payload); return { ...result, diagnostics: { ...result.diagnostics, adapter: state.adapter, runtime: state.runtime, model_revision: D1_RELEASE.revision, package_manifest_sha256: D1_RELEASE.manifestSha256, gpu_errors: [...errors] } }; }
  throw new Error('Unknown D1 worker command.');
}

self.onmessage = event => {
  const { id, type, payload } = event.data || {};
  const run = () => execute(type, payload);
  const immediate = ['status', 'stop', 'download', 'probe'].includes(type);
  const promise = immediate ? Promise.resolve().then(run) : (queue = queue.then(run, run));
  promise.then(result => self.postMessage({ id, ok: true, result }), error => self.postMessage({ id, ok: false, error: String(error.message || error) }));
};
