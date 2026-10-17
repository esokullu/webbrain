import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/decision-config.js`);
  const pin = await import(`../src/${build}/src/providers/d1-config.js`);
  const runtime = await import(`../src/${build}/src/providers/d1-runtime.js`);
  const preprocess = await import(`../src/${build}/src/providers/d1-preprocess.js`);
  const cache = await import(`../src/${build}/src/providers/d1-cache.js`);
  const completion = await import(`../src/${build}/src/agent/completion-verifier.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  const diagnostic = await import(`../src/${build}/src/providers/d1-diagnostic.js`);
  const judge = await import(`../src/${build}/src/agent/systemone-judge.js`);
  test(`${build}: isolated ORT loader uses its native asyncify ABI with checksum-exact assets`, async () => {
    const worker = await readFile(new URL(`../src/${build}/src/providers/d1-worker.js`, import.meta.url), 'utf8');
    const bundle = await readFile(new URL(`../src/${build}/vendor/d1/ort.webgpu.bundle.min.mjs`, import.meta.url), 'utf8');
    const factory = await readFile(new URL(`../src/${build}/vendor/d1/ort-wasm-simd-threaded.asyncify.mjs`, import.meta.url), 'utf8');
    const oldFactory = await readFile(new URL(`../src/${build}/vendor/d1/ort-wasm-simd-threaded.jsep.mjs`, import.meta.url), 'utf8');
    const manifest = JSON.parse(await readFile(new URL(`../src/${build}/vendor/d1/vendor-manifest.json`, import.meta.url), 'utf8'));
    assert.match(bundle, /webgpuInit/); assert.match(bundle, /ort-wasm-simd-threaded\.asyncify\.mjs/);
    assert.match(factory, /webgpuInit/); assert.doesNotMatch(factory, /jsepInit/);
    assert.match(oldFactory, /jsepInit/); assert.doesNotMatch(oldFactory, /webgpuInit/);
    assert.match(worker, /mjs: new URL\('\.\.\/\.\.\/vendor\/d1\/ort-wasm-simd-threaded\.asyncify\.mjs'/);
    assert.match(worker, /wasm: new URL\('\.\.\/\.\.\/vendor\/d1\/ort-wasm-simd-threaded\.asyncify\.wasm'/);
    assert.doesNotMatch(worker, /ort-wasm-simd-threaded\.jsep/);
    assert.equal(manifest.loader_abi.required_factory_api, 'webgpuInit');
    for (const entry of manifest.files) {
      const bytes = await readFile(new URL(`../src/${build}/vendor/d1/${entry.file}`, import.meta.url));
      assert.equal(bytes.length, entry.copied_bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.copied_sha256);
      if (entry.byte_exact) assert.equal(entry.source.sha256, entry.copied_sha256);
    }
  });
  test(`${build}: worker preserves a load error rather than claiming a cached model is ready`, async () => {
    const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const oldSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
    const messages = [];
    let cacheReads = 0;
    const directory = { getFileHandle: async () => ({ getFile: async () => ({ text: async () => JSON.stringify({ revision: pin.D1_RELEASE.revision, manifestSha256: pin.D1_RELEASE.manifestSha256 }) }) }) };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => { cacheReads++; return { getDirectoryHandle: async () => directory }; } } } });
    Object.defineProperty(globalThis, 'self', { configurable: true, value: { postMessage: message => messages.push(message) } });
    try {
      await import(`../src/${build}/src/providers/d1-worker.js?cpu-error-status`);
      self.onmessage({ data: { id: 1, type: 'download', payload: { consentVersion: pin.D1_CONSENT_VERSION } } });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(messages.some(message => message.state?.status === 'error'));
      self.onmessage({ data: { id: 2, type: 'status' } });
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = messages.find(message => message.id === 2).result;
      assert.equal(result.status, 'error'); assert.equal(result.ready, false); assert.equal(result.loaded, false);
      assert.match(result.error, /Hardware WebGPU/); assert.equal(cacheReads, 0);
    } finally {
      if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
      if (oldSelf) Object.defineProperty(globalThis, 'self', oldSelf); else delete globalThis.self;
    }
  });
  test(`${build}: fixture diagnostics require Settings, stored selected consent and normal typed evaluation`, async () => {
    const settings = { decisionProvider: 'webgpu_d1', systemOneEnabled: true, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION };
    const api = { runtime: { id: 'extension-id', getURL: path => 'chrome-extension://extension-id/' + path }, storage: { local: { get: async () => settings } } };
    const sender = { id: api.runtime.id, url: api.runtime.getURL('src/ui/settings.html') + '#decision' };
    const fixture = { state: 'Exact original state', images: ['data:image/png;base64,YQ=='], questions: { q: { type: 'noul', instructions: 'Is blue visible?' } } };
    const client = {};
    const response = { model: pin.D1_MODEL_ID, provider: 'webgpu_d1', answers: { q: { type: 'noul', noul: .75 } }, usage: { input_tokens: 12, output_tokens: 0 } };
    let calls = 0;
    const agent = { evaluateSystemOne: async (tabId, actualClient, args) => { calls++; assert.equal(tabId, null); assert.equal(actualClient, client); assert.equal(args.state, fixture.state); assert.equal(args.images, fixture.images); assert.equal(args.questions, fixture.questions); assert.equal(args.config.provider, 'webgpu_d1'); return response; } };
    const args = { fixture, sender, api, strictSecretMode: false, agent, client };
    assert.equal(await diagnostic.evaluateD1LocalFixture(args), response);
    assert.equal(calls, 1);
    for (const badSender of [{ ...sender, id: 'other-id' }, { ...sender, url: 'https://example.com/' }, { ...sender, url: api.runtime.getURL('src/ui/popup.html') }]) await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, sender: badSender }), /only from extension Settings/);
    await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, strictSecretMode: true }), /Strict Secret/);
    for (const stored of [{ ...settings, decisionProvider: 'compass' }, { ...settings, systemOneEnabled: false }, { ...settings, [pin.D1_CONSENT_KEY]: 0 }]) await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, api: { ...api, storage: { local: { get: async () => stored } } } }), /Select, enable/);
    assert.equal(calls, 1);
    await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, api: { ...api, storage: { local: { get: async () => ({ ...settings, decisionVisionMode: 'off' }) } } } }), /Enable local D1 vision/);
    await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, agent: { evaluateSystemOne: async () => ({ ...response, usage: { input_tokens: 12, output_tokens: 1 } }) } }), /Invalid local D1 fixture response/);
    await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, agent: { evaluateSystemOne: async () => ({ ...response, answers: { q: { type: 'noul', noul: 1.5 } } }) } }), /probability/);
  });
  test(`${build}: SW-reachable D1 modules use static imports and diagnostic branch leaves normal connection test intact`, async () => {
    for (const path of ['providers/d1.js', 'providers/d1-diagnostic.js', 'providers/d1-host.js', 'agent/systemone-judge.js']) {
      const source = await readFile(new URL(`../src/${build}/src/${path}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /\bimport\s*\(/, path);
    }
    const background = await readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8');
    const branch = background.slice(background.indexOf("case 'test_system_one':"), background.indexOf("case 'test_captcha_provider_balance':"));
    assert.match(branch, /await strictSecretModeReady/);
    assert.match(branch, /Object\.hasOwn\(msg, 'localFixture'\)/);
    assert.match(branch, /return \{ success: true, result \}/);
    assert.ok(branch.indexOf('evaluateD1LocalFixture') < branch.indexOf('let config = msg.settings'));
    assert.match(branch, /Decision connection test was inconclusive/);
  });
  test(`${build}: actual typed Judge dispatches a local text/image fixture without HTTP or dynamic imports`, async () => {
    const saved = { chrome: globalThis.chrome, browser: globalThis.browser, Worker: globalThis.Worker };
    const questions = { q: { type: 'noul', instructions: 'Is blue visible?' } };
    const state = 'Original source state', images = ['data:image/png;base64,YQ=='];
    const result = { model: pin.D1_MODEL_ID, provider: 'webgpu_d1', answers: { q: { type: 'noul', noul: .75 } }, usage: { input_tokens: 12, output_tokens: 0 } };
    let sends = 0, usages = 0;
    const receive = message => { sends++; assert.equal(message.command || message.type, 'evaluate'); assert.equal(message.payload.state, state); assert.deepEqual(message.payload.images, images); assert.deepEqual(message.payload.questions, questions); return result; };
    const api = { storage: { local: { get: async () => ({ [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION }) } }, runtime: { getURL: path => 'chrome-extension://test/' + path, sendMessage: async message => ({ ok: true, result: receive(message) }) } };
    if (build === 'chrome') api.offscreen = { createDocument: async () => { throw new Error('Existing host must be reused'); }, hasDocument: async () => true };
    globalThis.chrome = api; globalThis.browser = build === 'firefox' ? api : undefined;
    globalThis.Worker = class { postMessage(message) { const response = receive(message); queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true, result: response } })); } terminate() {} };
    try {
      const selected = config.resolveDecisionConfig({ decisionProvider: 'webgpu_d1', systemOneEnabled: true, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION });
      const response = await judge.createSystemOneJudge({ fetchImpl: () => { throw new Error('No cloud request'); }, maxRetries: 0 }).evaluate({ state, images, questions, config: selected, onUsage: metadata => { usages++; assert.equal(Object.hasOwn(metadata, 'answers'), false); } });
      assert.deepEqual(response.answers, result.answers); assert.equal(response.usage.output_tokens, 0); assert.equal(sends, 1); assert.equal(usages, 1);
    } finally {
      const host = await import(`../src/${build}/src/providers/d1-host.js`); host.resetD1Worker();
      globalThis.chrome = saved.chrome; globalThis.browser = saved.browser; globalThis.Worker = saved.Worker;
    }
  });
  test(`${build}: D1 is opt-in, endpoint/key-free, zero-cost and overrides Compass only with explicit local consent`, async () => {
    const stored = { decisionProvider: 'webgpu_d1', systemOneEnabled: true };
    assert.equal(config.resolveDecisionConfig(stored).enabled, false);
    const selected = config.resolveDecisionConfig({ ...stored, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION });
    assert.equal(selected.enabled, true); assert.equal(selected.local, true); assert.equal(selected.apiKey, ''); assert.equal(selected.url, ''); assert.equal(selected.doneEnabled, false);
    assert.equal(selected.config.inputCostPerMillionUsd, 0); assert.equal(selected.requiresIndependentSuccessConfirmation, true);
    assert.equal(config.resolveDecisionConfig(stored, { baseUrl: 'https://api.webbrain.one/v1' }).provider, 'compass');
    assert.equal(config.resolveDecisionConfig({ ...stored, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION }, { baseUrl: 'https://api.webbrain.one/v1' }).provider, 'webgpu_d1');
    let fetched = false;
    assert.equal((await config.listDecisionModels(selected, () => { fetched = true; })).length, 1); assert.equal(fetched, false);
    const imported = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: stored })).settings;
    assert.equal(imported.decisionProvider, 'webgpu_d1'); assert.equal(config.resolveDecisionConfig(imported).enabled, false);
  });
  test(`${build}: hardware guards reject software and inadequate buffers, not other capable GPUs`, () => {
    // The WebGPU default limits (128 MiB) now hold the FP16 embedding.
    const adapter = { info: { description: 'Some capable GPU', isFallbackAdapter: false }, limits: { maxBufferSize: 134217728, maxStorageBufferBindingSize: 134217728 } };
    assert.doesNotThrow(() => pin.assertD1Adapter(adapter));
    assert.throws(() => pin.assertD1Adapter({ ...adapter, info: { description: 'SwiftShader' } }), /software/);
    assert.throws(() => pin.assertD1Adapter({ ...adapter, limits: { maxBufferSize: 64 } }), /buffer/);
    assert.throws(() => pin.assertD1Adapter({ ...adapter, limits: { ...adapter.limits, maxStorageBufferBindingSize: 67108864 } }), /storage-binding/);
    assert.equal(pin.D1_MODEL_ID, 'webbrain-one/d1-browser-decision-fp16');
  });
  test(`${build}: media remains inline data and separate from state, remote network media is rejected`, () => {
    const url = 'data:image/png;base64,YQ==';
    assert.deepEqual(runtime.splitD1State([{ task: 'Observe' }, { type: 'image_url', image_url: { url } }]), { state: [{ task: 'Observe' }], images: [url] });
    assert.throws(() => runtime.splitD1State('', ['https://example.com/private.png']), /remote/);
    assert.throws(() => runtime.splitD1State('', Array(5).fill(url)), /four/);
    assert.equal(runtime.splitD1State(null).state, '');
    assert.equal(preprocess.pyJSON({ small: 1e-7, decimal: 1e-5, regular: .0001, negative: -.0000012, count: 2 }), '{"small": 1e-07, "decimal": 1e-05, "regular": 0.0001, "negative": -1.2e-06, "count": 2}');
    assert.throws(() => preprocess.pyJSON({ invalid: Infinity }), /finite/);
  });
  test(`${build}: public noul yes/no, choice names and score expectation preserve source ordering`, () => {
    const questions = { n: { type: 'noul' }, c: { type: 'choice', criteria: { second: 'B', first: 'A' } }, s: { type: 'score', criteria: ['Zero', 'One'] } };
    const answers = runtime.d1Answers(questions, new Float32Array([.25, .75, .8, .2, .6, .4]), 2);
    assert.equal(answers.n.noul, .75); assert.equal(answers.c.choice, 'second'); assert.ok(Math.abs(answers.s.score - .4) < 1e-6); assert.equal(answers.s.legend['0'], 'Zero');
    assert.throws(() => runtime.d1Answers({ n: { type: 'noul' } }, [NaN, 1], 2), /probability/);
    assert.equal(runtime.d1Answers({ s: { type: 'score', criteria: [{ n: 0 }, ['high']] } }, [.25, .75], 2).s.legend['0'], '{"n": 0}');
    assert.deepEqual(preprocess.renderOptions({ type: 'noul', criteria: { false: null, no: 'Do not use', true: null, yes: 'Do not use' } }), ['false: no, the statement does not hold', 'true: yes, the statement holds']);
    const numericNames = runtime.d1Answers([['1', { type: 'noul' }], ['0', { type: 'noul' }]], [.2, .8, .6, .4], 2);
    assert.equal(numericNames['1'].noul, .8); assert.equal(numericNames['0'].noul, .4);
  });
  test(`${build}: positive D1 alone cannot authorize completion, negative and independent policies remain`, async () => {
    const base = { capture: async () => ({ identity: 'fresh', key: 'pixel' }), isCurrent: () => true };
    const decision = { name: 'webgpu_d1', supportsVision: true, requiresIndependentSuccessConfirmation: true, evaluate: async () => ({ outcome: 'succeeded', probability: .999 }) };
    let verdict = await completion.verifyCompletion({ ...base, decision });
    assert.equal(verdict.outcome, 'uncertain'); assert.equal(verdict.engine, 'legacy');
    verdict = await completion.verifyCompletion({ ...base, decision, llm: { name: 'llm', evaluate: async () => ({ outcome: 'failed' }) } });
    assert.equal(verdict.outcome, 'failed'); assert.equal(verdict.engine, 'llm');
    verdict = await completion.verifyCompletion({ ...base, decision: { ...decision, evaluate: async () => ({ outcome: 'pending' }) } });
    assert.equal(verdict.outcome, 'pending');
  });
  test(`${build}: bounded checksum chunks cover each large file without gaps`, () => {
    const files = pin.D1_REQUIRED_FILES.map(path => ({ path, bytes: 2, sha256: 'a'.repeat(64) }));
    assert.doesNotThrow(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }));
    files.at(-1).bytes = 10 * 1024 * 1024;
    assert.throws(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }), /chunks/);
    assert.throws(() => cache.validateD1Manifest({ dtype: 'bfloat16', audio_included: false, files }), /FP32 or FP16/);
    files.at(-1).bytes = 2;
    assert.doesNotThrow(() => cache.validateD1Manifest({ dtype: 'float16', audio_included: false, files }), 'the FP16-weight package is valid');
    files.at(-1).chunks = [];
    assert.throws(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }), /coverage/);
  });
  test(`${build}: batches are bounded by dense attention memory and keep original question indices`, () => {
    const rows = lengths => lengths.map(length => ({ input_ids: Array(length) }));
    // A 2048-token row's 16 × 2048² FP32 score tensor alone fills the 256 MiB budget.
    assert.equal(runtime.d1AttentionBytes(1, runtime.D1_WEBGPU_MAX_TEXT_TOKENS), runtime.D1_ATTENTION_BUDGET_BYTES);
    assert.deepEqual(runtime.d1RowBatches(rows([80, 2048, 2048, 2048]), 0), [[1], [2], [3], [0]]);
    // Short rows still share one batch, longest first.
    assert.deepEqual(runtime.d1RowBatches(rows([100, 512, 300, 512]), 0), [[1, 3, 2, 0]]);
    // The media prefix counts toward every row's length.
    assert.deepEqual(runtime.d1RowBatches(rows([400, 400, 400]), 1700), [[0], [1], [2]]);
    assert.deepEqual(runtime.d1RowBatches(rows([400, 400, 400]), 1700, { budgetBytes: 2 ** 31 }), [[0, 1, 2]]);
  });
  test(`${build}: WebGPU rows are capped and rows too large for the adapter fail before inference`, async () => {
    class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } dispose() {} }
    const tokenizer = { bos_token_id: 1, pad_token_id: 0, convert_tokens_to_ids: () => 5, encode: text => Array.from(text, c => c.charCodeAt(0) % 200) };
    const seen = [];
    const sessions = { vision: {}, projector: {}, decision: { async run(feeds) { seen.push(feeds); const batch = feeds.input_ids.dims[0]; return { probabilities: { getData: async () => Float32Array.from({ length: batch * 2 }, (_, i) => i % 2 ? .75 : .25), dispose() {} } }; } } };
    const config = { max_length: 16384, image_text_length: 896, temperatures: {} };
    const questions = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `Question ${i}?` }]));
    const model = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config, ratios: [], sessions, model: pin.D1_MODEL_ID });
    const longState = 'x'.repeat(9000);
    const result = await model.evaluate({ state: longState, questions });
    assert.ok(seen.every(feeds => feeds.input_ids.dims[1] <= runtime.D1_WEBGPU_MAX_TEXT_TOKENS), 'text rows must be capped on WebGPU');
    assert.equal(seen.length, 3, 'three capped rows cannot share one 256 MiB score tensor');
    assert.equal(result.diagnostics.attention_budget_bytes, runtime.D1_ATTENTION_BUDGET_BYTES);
    // A 128 MiB binding limit shortens rows instead of failing on the GPU.
    seen.length = 0;
    const small = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config, ratios: [], sessions, model: pin.D1_MODEL_ID, device: { limits: { maxStorageBufferBindingSize: 134217728 }, queue: { onSubmittedWorkDone: async () => {} } } });
    await small.evaluate({ state: longState, questions });
    assert.ok(seen.every(feeds => runtime.d1AttentionBytes(1, feeds.input_ids.dims[1]) <= 134217728));
    const tiny = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config, ratios: [], sessions, model: pin.D1_MODEL_ID, device: { limits: { maxStorageBufferBindingSize: 65536 }, queue: { onSubmittedWorkDone: async () => {} } } });
    await assert.rejects(tiny.evaluate({ state: longState, questions }), /too large for this GPU/);
  });
  test(`${build}: screenshot features stay on the GPU between the vision, projector and decision graphs`, async () => {
    const saved = { createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas, GPUBufferUsage: globalThis.GPUBufferUsage };
    globalThis.createImageBitmap = async () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(128), close() {} });
    globalThis.OffscreenCanvas = class { getContext() { let bitmap; return { drawImage: image => { bitmap = image; }, getImageData: () => ({ data: bitmap.data }) }; } };
    globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 };
    try {
      const copies = [], created = [], writes = [];
      class Tensor {
        constructor(type, data, dims) { Object.assign(this, { type, data, dims, location: 'cpu' }); }
        static fromGpuBuffer(buffer, { dims, dispose }) { const tensor = new Tensor('float32', null, dims); Object.assign(tensor, { location: 'gpu-buffer', gpuBuffer: buffer, disposer: dispose }); return tensor; }
        async getData() { if (this.location === 'gpu-buffer') throw new Error('GPU features must not be read back'); return this.data; }
        dispose() { this.disposer?.(); }
      }
      const gpuOut = (name, dims) => { const tensor = Tensor.fromGpuBuffer({ name }, { dims }); return tensor; };
      let decisionFeeds;
      const sessions = {
        vision: { async run(feeds) { return { hidden: gpuOut('hidden', [feeds.pixel_values.dims[0], 1024, 768]) }; } },
        projector: { async run({ hidden }) { assert.equal(hidden.location, 'gpu-buffer'); const [, h, w] = hidden.dims; return { prefix: gpuOut('prefix', [1, (h / 2) * (w / 2), 1024]) }; } },
        decision: { async run(feeds) { decisionFeeds = feeds; return { probabilities: { getData: async () => new Float32Array([.4, .6, .3, .7]), dispose() {} } }; } },
      };
      const device = {
        limits: { maxStorageBufferBindingSize: 2 ** 31 },
        createBuffer: ({ size, usage }) => { const buffer = { size, usage, destroyed: false, destroy() { this.destroyed = true; } }; created.push(buffer); return buffer; },
        createCommandEncoder: () => ({ copyBufferToBuffer: (...args) => copies.push(args), finish: () => ({}) }),
        queue: { submit() {}, writeBuffer: (...args) => writes.push(args), onSubmittedWorkDone: async () => {} },
      };
      const tokenizer = { bos_token_id: 1, pad_token_id: 0, convert_tokens_to_ids: () => 5, encode: text => Array.from(text, c => c.charCodeAt(0) % 200) };
      const model = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config: { max_length: 16384, image_text_length: 896, temperatures: {} }, ratios: [], sessions, device, model: pin.D1_MODEL_ID });
      const questions = { a: { type: 'noul', instructions: 'Is it grey?' }, b: { type: 'noul', instructions: 'Is it white?' } };
      const result = await model.evaluate({ state: 'Grey page', images: ['data:image/png;base64,YQ=='], questions });
      assert.equal(result.diagnostics.media_on_gpu, true);
      const media = decisionFeeds.media_prefix;
      assert.equal(media.location, 'gpu-buffer');
      const rows = media.dims[1], rowBytes = rows * 1024 * 4;
      assert.deepEqual(media.dims, [2, rows, 1024]);
      const toMedia = copies.filter(([, , target]) => target === media.gpuBuffer);
      assert.deepEqual(toMedia.map(([, , , offset, bytes]) => [offset, bytes]), [[0, rowBytes], [rowBytes, rowBytes]], 'each row receives the projected prefix by a GPU copy');
      assert.equal(writes.length, 0, 'no screenshot features were uploaded from the CPU');
      assert.ok(created.every(buffer => buffer.usage & 128), 'feature buffers must be storage buffers');
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    }
  });
  test(`${build}: encoder/head feeds are FP32, bidirectional and generate no tokens`, async () => {
    const seen = [];
    class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } dispose() {} }
    const tokenizer = { bos_token_id: 1, pad_token_id: 0, convert_tokens_to_ids: token => ({ '<|mask|>': 99 }[token] || 5), encode: text => text.split('').map(c => c.charCodeAt(0)) };
    const sessions = { vision: {}, projector: {}, decision: { async run(feeds) { seen.push(feeds); return { probabilities: { getData: async () => new Float32Array([.25, .75, .8, .2]), dispose() {} } }; } } };
    const model = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config: { dtype: 'float16', max_length: 16384, image_text_length: 896, temperatures: { 'noul:2': 1.666, 'choice:2': 1.746 } }, ratios: [], sessions, model: pin.D1_MODEL_ID });
    const result = await model.evaluate({ state: { color: 'blue' }, questions: { n: { type: 'noul', instructions: 'Is it blue?' }, c: { type: 'choice', instructions: 'Pick a color', criteria: { blue: 'Blue', red: 'Red' } } } });
    assert.equal(result.usage.output_tokens, 0); assert.equal(result.answers.n.noul, .75);
    assert.deepEqual(seen[0].media_prefix.dims, [2, 0, 1024]); assert.equal(seen[0].media_prefix.type, 'float32'); assert.equal(seen[0].temperature.type, 'float32'); assert.equal(seen[0].qtype.type, 'int64');
    assert.equal(Object.hasOwn(seen[0], 'past_key_values'), false); assert.equal(Object.hasOwn(seen[0], 'causal_mask'), false);
  });
}

test('new shared decision runtime modules are byte-identical across Chrome and Firefox', async () => {
  for (const name of ['d1-config.js', 'd1-runtime.js', 'd1-preprocess.js', 'd1-cache.js', 'd1-worker.js', 'd1-host.js', 'd1-diagnostic.js']) assert.deepEqual(await readFile(new URL(`../src/chrome/src/providers/${name}`, import.meta.url)), await readFile(new URL(`../src/firefox/src/providers/${name}`, import.meta.url)), name);
});
