// Hardware eval for on-device decisions through the real extension: the d1
// decision model (Settings fixture path, d1 worker) and the in-browser chat
// model's decision readout (Bonsai 2 Vision, offscreen WebGPU worker). Both
// answer the same labelled questions, so accuracy, calibration and latency
// are comparable. See docs/webgpu-models.md.
//
//   node scripts/check-webgpu-decisions.mjs --test <final_test.json> --images <dir> \
//     --engines d1,bonsai --profile .build/decisions/profile --download \
//     --adapter-luid 0,82094 --output .build/decisions/result.json
//
// --extension DIR   unpacked extension (default src/chrome). Use a fresh
//                   --profile per build: a persistent profile keeps the old
//                   service worker (docs/webgpu-models.md).
// --engines LIST    d1, bonsai or both (default both)
// --stress          also run long text states with many questions through d1,
//                   the case where dense attention memory used to grow
// --limit N         first N test requests only
// --temperature T   Bonsai readout temperature (default 1)
// --prompt NAME     Bonsai decision mode: probe (default, what Settings uses),
//                   readout, strict or verify
// --decoder-graph F install a replacement decoder graph in the cache first
// --refresh         download a cached model again first, the Settings path
//                   that replaces a stale decoder graph by hash
// --return-hidden   with --prompt verify, record each option's hidden state
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scoreAnswers, questionsOf } from './models/d1/decision-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const extension = path.resolve(option('--extension', path.join(root, 'src/chrome')));
const profile = path.resolve(option('--profile', '.build/decisions/profile'));
const output = path.resolve(option('--output', '.build/decisions/result.json'));
const engines = option('--engines', 'd1,bonsai').split(',');
const bonsaiModel = option('--model', 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision');
const test = JSON.parse(await fs.readFile(option('--test'), 'utf8'));
const requests = test.requests.slice(0, Number(option('--limit', test.requests.length)));
const imageDir = option('--images');

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
};
const timing = values => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) });
const dataUrl = async file => `data:image/png;base64,${(await fs.readFile(path.join(imageDir, path.basename(file)))).toString('base64')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await fs.mkdir(path.dirname(output), { recursive: true });
const result = { extension, startedAt: new Date().toISOString(), requests: requests.length, engines: {} };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--enable-unsafe-webgpu', '--force-high-performance-gpu',
      ...(option('--adapter-luid', '') ? [`--use-adapter-luid=${option('--adapter-luid')}`] : [])],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ onboardingComplete: true, wbLocale: 'en', helpImproveWebBrain: false }));
  result.extensionVersion = await harness.evaluate(() => chrome.runtime.getManifest().version);
  result.adapter = await harness.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : null;
  });
  console.log('adapter', JSON.stringify(result.adapter));

  const run = async (name, ask) => {
    const answers = {}, seconds = [], errors = [], diagnostics = [];
    for (const [index, request] of requests.entries()) {
      const images = await Promise.all(request.images.map(dataUrl));
      const started = Date.now();
      try {
        const reply = await ask({ state: request.state, images, questions: questionsOf(request) });
        if (!reply?.success) throw new Error(reply?.error || 'no reply');
        Object.assign(answers, reply.result.answers);
        if (reply.result.diagnostics) diagnostics.push({ id: request.id, ...reply.result.diagnostics });
        if (index > 0) seconds.push((Date.now() - started) / 1000);
        else result.engines[name] = { coldSeconds: (Date.now() - started) / 1000 };
      } catch (error) {
        errors.push({ id: request.id, error: String(error?.message || error) });
      }
      if (index % 12 === 0) console.log(name, index, request.id, `${(Date.now() - started) / 1000}s`, errors.at(-1)?.error || '');
    }
    const summary = { ...(result.engines[name] || {}), ...scoreAnswers(requests, answers), latencySecondsPerRequest: timing(seconds), errors, answers, diagnostics };
    result.engines[name] = summary;
    console.log(name, JSON.stringify({ categorical: summary.categorical, completion: summary.completion, unknown: summary.unknown, scoreMae: summary.scoreMae, meanTruthProbability: summary.meanTruthProbability, latency: summary.latencySecondsPerRequest, errors: errors.length }));
    return summary;
  };

  if (engines.includes('d1')) {
    await harness.evaluate(() => chrome.storage.local.set({ decisionProvider: 'webgpu_d1', systemOneEnabled: true, decisionVisionMode: 'on', systemOneDoneEnabled: false }));
    const control = (command) => message('d1_control', { command, consent: true, consentVersion: 1 });
    let status = (await control('status')).result;
    if (!status?.ready) {
      const started = Date.now();
      const first = await control(status?.status === 'cached' ? 'load' : 'download');
      if (!first.success) throw new Error(`d1 ${status?.status === 'cached' ? 'load' : 'download'} failed: ${first.error}`);
      while (!status?.ready) {
        await sleep(5000);
        status = (await control('status')).result;
        console.log('d1', JSON.stringify(status).slice(0, 200));
        if (status?.status === 'error') throw new Error(`d1 failed: ${status.error}`);
        if (status?.status === 'cached') { const loaded = await control('load'); if (!loaded.success) throw new Error(loaded.error); }
        if (Date.now() - started > 60 * 60_000) throw new Error('d1 did not become ready within an hour');
      }
      result.d1LoadSeconds = (Date.now() - started) / 1000;
    }
    result.d1Status = status;
    await run('d1', fixture => message('test_system_one', { localFixture: fixture }));
    if (args.includes('--stress')) {
      const stress = [];
      const sentence = index => `Row ${index}: order ${1000 + index} for customer C-${index % 97} is ${index % 5 ? 'shipped' : 'pending review'} with total ${index * 3}.17 EUR. `;
      for (const tokensWanted of [1000, 2000, 4000, 8000]) {
        const state = Array.from({ length: Math.ceil(tokensWanted / 30) }, (_, index) => sentence(index)).join('');
        const questions = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`q${index}`, { type: 'noul', instructions: `Is order ${1000 + index * 7} pending review?` }]));
        const started = Date.now();
        const reply = await message('test_system_one', { localFixture: { state, questions } });
        const entry = { approxTokens: tokensWanted, questions: 16, seconds: (Date.now() - started) / 1000, ok: !!reply?.success, error: reply?.success ? undefined : reply?.error };
        stress.push(entry);
        console.log('stress', JSON.stringify(entry));
      }
      result.engines.d1.stress = stress;
    }
    await control('reset');
  }

  if (engines.includes('bonsai')) {
    const preset = (await import('../src/chrome/src/providers/webgpu.js')).webgpuModelPreset(bonsaiModel);
    await message('update_provider', { providerId: 'webgpu', config: { model: bonsaiModel, dtype: preset.dtype } });
    let status = await message('get_webgpu_download_status', { model: bonsaiModel });
    if (!status?.ready) {
      if (!args.includes('--download')) throw new Error(`${bonsaiModel} is not cached in this profile; rerun with --download`);
      await message('start_webgpu_download', { model: bonsaiModel });
      const started = Date.now();
      while (!status?.ready) {
        await sleep(5000);
        status = await message('get_webgpu_download_status', { model: bonsaiModel });
        if (status?.error) throw new Error(`Download failed: ${status.error}`);
        if (Date.now() - started > 60 * 60_000) throw new Error('Download did not finish within an hour');
      }
    }
    if (status?.ready && args.includes('--refresh')) {
      const started = Date.now();
      const refreshed = await message('start_webgpu_download', { model: bonsaiModel });
      if (!refreshed || refreshed.error || refreshed.success === false) throw new Error(`Refresh failed: ${refreshed?.error}`);
      do {
        await sleep(2000);
        status = await message('get_webgpu_download_status', { model: bonsaiModel });
        if (status?.error) throw new Error(`Refresh failed: ${status.error}`);
        if (Date.now() - started > 10 * 60_000) throw new Error('Refresh did not finish within ten minutes');
      } while (!status?.ready || status?.status === 'downloading');
      result.refreshSeconds = (Date.now() - started) / 1000;
    }
    const graphFile = option('--decoder-graph', '');
    if (graphFile) {
      // Replace the cached decoder graph (same external weights) before the
      // worker first loads the model, e.g. one that exposes decision_hidden.
      const data = (await fs.readFile(graphFile)).toString('base64');
      await harness.evaluate(async ({ url, data }) => {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        const cache = await caches.open('transformers-cache');
        await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } }));
      }, { url: `https://huggingface.co/${bonsaiModel}/resolve/main/onnx/decoder_model_merged_q2f16.onnx`, data });
      result.decoderGraph = graphFile;
    }
    result.cachedDecoderGraphSha256 = await harness.evaluate(async url => {
      const cached = await (await caches.open('transformers-cache')).match(url);
      if (!cached) return null;
      const digest = await crypto.subtle.digest('SHA-256', await cached.arrayBuffer());
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }, `https://huggingface.co/${bonsaiModel}/resolve/main/onnx/decoder_model_merged_q2f16.onnx`);
    console.log('cached decoder graph', result.cachedDecoderGraphSha256);
    const temperature = Number(option('--temperature', 1));
    const promptVariant = option('--prompt', 'probe');
    const returnHidden = args.includes('--return-hidden');
    await run('bonsai', fixture => message('webgpu_decide_fixture', { fixture: { ...fixture, temperature, promptVariant, returnHidden } }));
    if (promptVariant === 'probe') {
      // The decision provider path Settings uses: judge -> provider -> worker.
      const started = Date.now();
      const tested = await message('test_system_one', { settings: { decisionProvider: 'webgpu_chat', systemOneEnabled: true, decisionVisionMode: 'on' } });
      result.engines.bonsai.settingsTest = { ...tested, seconds: (Date.now() - started) / 1000 };
      console.log('settings test', JSON.stringify(result.engines.bonsai.settingsTest));
    }
  }
} catch (error) {
  result.error = String(error?.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  await context?.close().catch(() => {});
}
console.log(`wrote ${output}`);
process.exit(process.exitCode ?? 0);
