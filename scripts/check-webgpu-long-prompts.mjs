// Long-prompt check for in-browser WebGPU models through the production worker.
//
// The short prompts in check-bonsai-webgpu.mjs cannot reveal prefill problems
// (a CPU-fallback recurrence or full-sequence logits only show up with
// thousands of prompt tokens). This runs real text of several lengths (and,
// with --vision, a long prompt that includes an image) through
// src/chrome/src/offscreen/inference-worker.js, reports wall time per prompt
// and seconds per 1k prompt tokens, and checks that greedy answers are the same
// for every requested prefill slice size. See docs/webgpu-models.md.
//
//   node scripts/check-webgpu-long-prompts.mjs --model webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision \
//     --vision --profile .build/bonsai/chunked-2b-profile --offline --lengths 1000,4000,8000 --slices 0,512
//
// Options mirror check-bonsai-webgpu.mjs: --local-repo owner/repo=dir serves
// unpublished files, --offline requires a cached model and blocks Hugging Face,
// --adapter-luid high,low (decimal) selects a Windows GPU.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const model = option('--model', 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision');
const vision = args.includes('--vision');
const offline = args.includes('--offline');
const dtype = option('--dtype', null)
  ? JSON.parse(option('--dtype'))
  : vision ? { embed_tokens: 'q2f16', vision_encoder: 'fp16', decoder_model_merged: 'q2f16' } : 'q2f16';
const lengths = option('--lengths', '1000,4000,8000').split(',').map(Number);
const slices = option('--slices', '0,512').split(',').map(Number);
const maxTokens = Number(option('--max-tokens', 48));
const profile = path.resolve(option('--profile', '.build/webgpu-long-prompts/profile'));
const output = path.resolve(option('--output', '.build/webgpu-long-prompts/result.json'));
const localRepos = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--local-repo') continue;
  const entry = args[++i] || '';
  const split = entry.indexOf('=');
  assert(split > 0, '--local-repo requires owner/repo=directory');
  localRepos[entry.slice(0, split)] = path.resolve(entry.slice(split + 1));
}
const mime = file => ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }[path.extname(file)] || 'application/octet-stream');
const workerBootstrap = `
const nativeFetch = globalThis.fetch.bind(globalThis);
const mapped = ${JSON.stringify(Object.keys(localRepos))};
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input), self.location.href);
  if (url.hostname === 'huggingface.co') {
    if (${offline}) throw new Error('Offline check blocked a Hugging Face fetch: ' + url.pathname);
    const match = url.pathname.match(/^\\/([^/]+\\/[^/]+)\\/resolve\\/[^/]+\\/(.+)$/);
    if (match && mapped.includes(match[1])) return nativeFetch('/models/' + match[1] + '/' + match[2], init);
  }
  return nativeFetch(input, init);
};
await import('/extension/src/offscreen/inference-worker.js');
self.postMessage({ type: 'harness-ready' });`;
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>WebGPU long prompts</title>'); return; }
    if (pathname === '/worker.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(workerBootstrap); return; }
    let base, relative;
    if (pathname.startsWith('/extension/')) { base = path.join(root, 'src/chrome'); relative = pathname.slice('/extension/'.length); }
    else if (pathname.startsWith('/models/')) {
      const match = pathname.match(/^\/models\/([^/]+\/[^/]+)\/(.+)$/);
      base = match && localRepos[match[1]]; relative = match?.[2];
    }
    if (!base || !relative) { response.writeHead(404); response.end(); return; }
    const file = path.resolve(base, relative);
    if (!file.startsWith(path.resolve(base) + path.sep)) { response.writeHead(403); response.end(); return; }
    const stat = await fs.stat(file);
    response.setHeader('Content-Type', mime(file)); response.setHeader('Content-Length', stat.size);
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end();
  }
});
await fs.mkdir(path.dirname(output), { recursive: true });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(option('--port', 8769)), '127.0.0.1', resolve); });
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--force-high-performance-gpu',
    ...(option('--adapter-luid', '') ? [`--use-adapter-luid=${option('--adapter-luid')}`] : [])],
});
const result = { model, vision, dtype, startedAt: new Date().toISOString(), runs: [], mismatches: [] };
try {
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') console.log(`[browser:error] ${message.text().slice(0, 300)}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => new Promise((ready, failed) => {
    const pending = new Map(); let id = 0;
    const worker = new Worker('/worker.mjs', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'harness-ready') ready();
      else if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id); pending.delete(data.id);
        if (data.ok === false) reject(new Error(data.error)); else resolve(data);
      }
    };
    worker.onerror = event => failed(new Error(event.message));
    window.workerCall = (type, payload) => new Promise((resolve, reject) => {
      const requestId = ++id; pending.set(requestId, { resolve, reject }); worker.postMessage({ id: requestId, type, payload });
    });
  }));
  const origin = new URL(page.url()).origin;
  const call = (type, payload = {}) => page.evaluate(({ type, payload }) => window.workerCall(type, payload), { type, payload });
  await call('init', {
    transformersUrl: `${origin}/extension/vendor/transformers/transformers.web.js`,
    wasmMjsUrl: `${origin}/extension/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs`,
    wasmUrl: `${origin}/extension/vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm`,
  });
  result.adapter = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture };
  });
  const download = await call(offline ? 'text-download-status' : 'download-text', { modelId: model, dtype, device: 'webgpu' });
  assert(download.ready, `${model} is not ready: ${JSON.stringify(download)}`);
  const corpus = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  // About 3.3 characters per token for this English changelog.
  const textFor = tokens => corpus.slice(0, Math.round(tokens * 3.3));
  const prompts = lengths.map(tokens => ({
    name: `text-${tokens}`, tokens,
    messages: [{ role: 'user', content: `${textFor(tokens)}\n\nIn one sentence, what is the most recent change above?` }],
  }));
  if (vision) {
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 448; canvas.height = 448;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 448, 448);
      ctx.fillStyle = 'red'; ctx.fillRect(64, 40, 320, 180);
      return canvas.toDataURL('image/png');
    });
    prompts.push({ name: `image-text-${lengths[0]}`, tokens: lengths[0], messages: [{ role: 'user', content: [
      { type: 'text', text: textFor(lengths[0]) },
      { type: 'image_url', image_url: { url: image } },
      { type: 'text', text: 'Ignore the release notes. What color is the large shape in the image, and what is its shape?' },
    ] }] });
  }
  const type = vision ? 'multimodal-text-chat' : 'text-chat';
  await call(type, { modelId: model, dtype, device: 'webgpu', messages: [{ role: 'user', content: 'Hi' }], options: { maxTokens: 4 } });
  for (const prompt of prompts) {
    const answers = new Map();
    for (const slice of slices) {
      const started = Date.now();
      const reply = await call(type, { modelId: model, dtype, device: 'webgpu', messages: prompt.messages, options: { maxTokens, prefillSliceTokens: slice } });
      const seconds = (Date.now() - started) / 1000;
      const run = { prompt: prompt.name, slice, seconds, secondsPer1kPromptTokens: +(seconds / (prompt.tokens / 1000)).toFixed(3), content: reply.content };
      result.runs.push(run);
      answers.set(slice, reply.content);
      console.log(JSON.stringify(run).slice(0, 300));
    }
    const reference = answers.get(slices[0]);
    for (const [slice, content] of answers) {
      if (content !== reference) result.mismatches.push({ prompt: prompt.name, slice, reference: slices[0] });
    }
  }
  result.passed = result.mismatches.length === 0;
} finally {
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  await context.close();
  server.close();
}
console.log(`${result.passed ? 'PASSED' : 'FAILED'}: ${output}`);
if (!result.passed) process.exitCode = 1;
