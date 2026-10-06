import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const workflow = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } };

for (const build of ['chrome', 'firefox']) {
  const media = await import(`../src/${build}/src/agent/generative-media.js`);
  const config = await import(`../src/${build}/src/agent/media-config.js`);
  const gate = await import(`../src/${build}/src/agent/permission-gate.js`);
  const journal = await import(`../src/${build}/src/run-ui-journal.js`);

  test(`${build}: generated assets survive the actual background broadcast and bounded replay`, async () => {
    const source = await readFile(`src/${build}/src/background.js`, 'utf8');
    const start = source.indexOf('function sendAgentUpdate(');
    const sendSource = source.slice(start, source.indexOf('\nfunction ', start + 1));
    const runJournal = new journal.RunUiJournal();
    runJournal.begin(11, 'media-run');
    const delivered = [];
    const api = { runtime: { sendMessage: async message => { delivered.push(message); } } };
    const send = new Function('recordRunUiEvent', 'agent', 'chrome', 'browser', `return (${sendSource});`)(
      (...args) => runJournal.record(...args), { currentRunId: new Map() }, api, api,
    );
    const results = [
      { success: true, provider: 'fal', model: 'fal-ai/flux/schnell', url: 'https://cdn.example/image.png' },
      { success: true, provider: 'comfyrouter', model: 'luma/ray-2', url: 'https://cdn.example/video.mp4' },
      { success: true, provider: 'comfyui', model: 'ComfyUI workflow', url: 'http://127.0.0.1:8188/view?filename=image.png&type=output' },
      { success: true, provider: 'openrouter', model: 'image-model', inlineMedia: true, mediaId: 'f0c21b19-32d0-44f4-93cd-1031c6bb9a4d', mimeType: 'image/png' },
    ];
    for (const result of results) send(11, 'media-run', 'tool_result', { name: 'generate_image', result });
    assert.deepEqual(delivered.map(message => message.data.result), results);
    const persisted = journal.compactRunUiSnapshotForPersist(runJournal.get(11), { tight: true });
    assert.ok(JSON.stringify(persisted).length < journal.RUN_UI_PERSIST_RETRY_BUDGET);
    assert.equal(persisted.discardedBeforeSeq, 0);
    const restored = new journal.RunUiJournal();
    restored.restore(11, structuredClone(persisted));
    assert.deepEqual(restored.get(11).events.map(event => event.data.result), results);
    assert.equal(journal.compactRunUiData('tool_result', { name: 'read_page', result: { success: true, url: 'https://secret.example', mediaId: 'private' } }).result.url, undefined);
  });

  test(`${build}: old fal settings and selected provider hosts remain correctly scoped`, () => {
    assert.equal(config.mediaProvider({ apiKey: 'k', model: 'fal-ai/flux/schnell' }), 'fal');
    assert.equal(config.isImageGenConfigured({ apiKey: 'k', model: 'fal-ai/flux/schnell' }), true);
    assert.equal(config.isImageGenConfigured({ provider: 'other', apiKey: 'k', model: 'x' }), false);
    for (const [provider, host] of [['fal', 'queue.fal.run'], ['openrouter', 'openrouter.ai'], ['comfyrouter', 'api.comfy.org'], ['comfyui', '127.0.0.1']]) {
      assert.equal(gate.hostForCapability(gate.Capability.NETWORK, { _generativeMediaUrl: config.mediaPermissionUrl({ provider }) }, 'evil.example', 'generate_image'), host);
    }
    assert.equal(gate.hostForCapability(gate.Capability.NETWORK, { url: 'https://evil.example', provider: 'fal' }, 'example.com', 'generate_image'), '');
    for (const baseUrl of ['https://evil.example', 'http://localhost.evil.test:8188', 'http://user:pass@localhost:8188', 'http://localhost:8188?x=1', 'file:///tmp/x']) assert.throws(() => config.comfyBaseUrl(baseUrl));
    assert.equal(config.comfyBaseUrl('http://[::1]:8188/'), 'http://[::1]:8188');
    assert.equal(config.isImageGenConfigured({ provider: 'comfyui', workflow }), true);
    assert.throws(() => config.validateMediaConfig({ provider: 'comfyui', workflow: { nodes: [] } }), /API format/);
    assert.throws(() => config.validateMediaConfig({ provider: 'comfyui', workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'fixed' } } } }), /positive prompt/);
  });

  test(`${build}: OpenRouter Image API returns inline media without a chat request`, async () => {
    const calls = [];
    const result = await media.runMediaGeneration({ prompt: 'red apple', config: { provider: 'openrouter', apiKey: 'or-key', model: 'google/gemini-2.5-flash-image' }, fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.headers.Authorization, 'Bearer or-key');
      assert.equal(init.redirect, 'error'); assert.deepEqual(JSON.parse(init.body), { model: 'google/gemini-2.5-flash-image', prompt: 'red apple' });
      return json({ data: [{ b64_json: 'YWJj', media_type: 'image/webp' }] });
    } });
    assert.deepEqual(calls, ['https://openrouter.ai/api/v1/images']);
    assert.equal(result.url, 'data:image/webp;base64,YWJj');
    assert.equal(media.extractMediaUrl({ data: [{ b64_json: 'YWJj', media_type: 'image/svg+xml' }] }), '');
    assert.equal(media.extractMediaUrl({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }] } }] }), 'data:image/png;base64,YWJj');
    assert.equal(media.extractMediaUrl({ status_url: 'https://api.example/status' }), '');
    assert.equal(media.safeMediaUrl('javascript:alert(1)'), '');
    assert.equal(media.safeMediaUrl('https://key@evil.example/x'), '');
  });

  test(`${build}: Comfy Router binds native inputs and polls trusted job paths`, async () => {
    const calls = [];
    const result = await media.runMediaGeneration({ prompt: 'an apple "quoted"', config: { provider: 'comfyrouter', apiKey: 'comfyui-key', model: 'bfl/flux-2-pro', parameters: JSON.stringify({ content: [{ text: '{{prompt}}', type: 'text' }], steps: 20 }) }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.headers['X-API-Key'], 'comfyui-key');
      if (calls.length === 1) {
        assert.match(init.headers['Idempotency-Key'], /^[\da-f-]{36}$/);
        assert.deepEqual(JSON.parse(init.body), { content: [{ text: 'an apple "quoted"', type: 'text' }], steps: 20 });
        return json({ request_id: 'job-1', status_url: 'https://evil.example/status', response_url: 'https://evil.example/result', cancel_url: 'https://evil.example/cancel' }, 201);
      }
      if (calls.length === 2) return json({ status: 'COMPLETED' });
      return json({ result: { sample: 'https://cdn.example/apple.png' } });
    } });
    assert.equal(result.url, 'https://cdn.example/apple.png');
    assert.deepEqual(calls, ['https://api.comfy.org/v2/models/bfl/flux-2-pro/requests', 'https://api.comfy.org/v2/models/bfl/flux-2-pro/requests/job-1/status', 'https://api.comfy.org/v2/models/bfl/flux-2-pro/requests/job-1']);
  });

  test(`${build}: Comfy Router native assets return the final video without cancelling a completed job`, async () => {
    const calls = [];
    const result = await media.runMediaGeneration({ prompt: 'red apple', config: { provider: 'comfyrouter', apiKey: 'k', model: 'luma/ray-2', parameters: { aspect_ratio: '16:9', duration: '5s', resolution: '720p' } }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (calls.length === 1) return json({ request_id: 'luma-1' }, 201);
      if (calls.length === 2) return json({ status: 'COMPLETED' });
      return json({ assets: { image: 'https://cdn.example/preview.jpg', progress_video: 'https://cdn.example/progress.mp4', video: 'https://cdn.example/final.mp4' }, status_url: 'https://api.example/status' });
    } });
    assert.equal(result.url, 'https://cdn.example/final.mp4');
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => !call.url.endsWith('/cancel')));
    assert.equal(media.extractMediaUrl({ assets: { image: 'https://cdn.example/final.png' } }), 'https://cdn.example/final.png');
    assert.equal(media.extractMediaUrl({ result: { video: 'https://cdn.example/final.mp4' } }), 'https://cdn.example/final.mp4');
    assert.equal(media.extractMediaUrl({ assets: { progress_video: 'https://cdn.example/progress.mp4' }, status_url: 'https://api.example/status' }), '');
    for (const value of ['javascript:alert(1)', 'file:///tmp/private', 'https://key@cdn.example/final.mp4']) {
      assert.equal(media.extractMediaUrl({ assets: { video: value } }), '');
    }
  });

  test(`${build}: failed Comfy Router completion cannot become a successful image`, async () => {
    const calls = [];
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', config: { provider: 'comfyrouter', apiKey: 'k', model: 'bfl/flux-2-pro' }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (calls.length === 1) return json({ request_id: 'j' }, 201);
      return json({ status: 'COMPLETED', error_type: 'content_policy_violation' });
    } }), /content_policy_violation/);
    assert.equal(calls.at(-1).method, 'PUT');
    assert.ok(calls.at(-1).url.endsWith('/j/cancel'));
  });

  test(`${build}: local workflow prompts and saved file query are transported correctly`, async () => {
    const original = JSON.stringify(workflow);
    const calls = [];
    const result = await media.runMediaGeneration({ prompt: 'red apple "with quotes"', config: { provider: 'comfyui', workflow, baseUrl: 'http://localhost:8188/' }, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.headers?.Authorization, undefined);
      if (calls.length === 1) {
        const body = JSON.parse(init.body); assert.equal(body.prompt['6'].inputs.text, 'red apple "with quotes"');
        assert.equal(body.prompt['9'].class_type, 'SaveImage'); return json({ prompt_id: 'local-1' });
      }
      if (calls.length === 2) return json({});
      return json({ 'local-1': { status: { completed: true }, outputs: { '9': { images: [{ filename: 'apple #1.png', subfolder: 'my folder', type: 'output' }] } } } });
    } });
    assert.equal(JSON.stringify(workflow), original);
    const url = new URL(result.url); assert.equal(url.origin, 'http://localhost:8188');
    assert.equal(url.pathname, '/view'); assert.equal(url.searchParams.get('filename'), 'apple #1.png');
    assert.equal(url.searchParams.get('subfolder'), 'my folder');
  });

  test(`${build}: cancellation deletes only the local queued job`, async () => {
    const controller = new AbortController(); const calls = [];
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', config: { provider: 'comfyui', workflow }, signal: controller.signal, pollIntervalMs: 1, fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/prompt')) { controller.abort(new Error('stopped')); return json({ prompt_id: 'mine' }); }
      return json({});
    } }), /stopped/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'http://127.0.0.1:8188/queue');
    assert.deepEqual(JSON.parse(calls[1].init.body), { delete: ['mine'] });
    assert.ok(!calls.some(call => call.url.includes('/interrupt')));
  });

  test(`${build}: timeouts abort in-flight generation`, async () => {
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', config: { provider: 'openrouter', apiKey: 'k', model: 'image-model' }, timeoutMs: 10,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
    }), /timed out/);
  });

  test(`${build}: actual tool batch uses the same provider snapshot for permission and dispatch`, async () => {
    const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
    let selected = { provider: 'openrouter', apiKey: 'saved-key', model: 'image-model' };
    const area = { get: async () => ({ imageGenModel: structuredClone(selected) }), set: async () => {}, remove: async () => {} };
    const api = {
      storage: { local: area, session: area }, runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
      tabs: { get: async id => ({ id, url: 'https://example.com', title: 'Example' }), sendMessage: async () => ({}) },
      scripting: { executeScript: async () => [{ result: null }] },
    };
    globalThis.chrome = globalThis.browser = api;
    try {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const provider = { supportsVision: false, promptTier: 'full' };
      const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
      agent._ensureGateSetting = async () => {};
      agent._persist = () => {};
      agent._skipPermissionGate = false;
      const hosts = []; let dispatched = false;
      agent.permissions.check = host => {
        hosts.push(host);
        // A settings change during approval must not move this request to another host.
        selected = { provider: 'comfyrouter', apiKey: 'other-key', model: 'bfl/flux-2-pro' };
        return { allowed: true };
      };
      agent.executeTool = async (_tab, name, args, _update, context) => {
        assert.equal(name, 'generate_image'); assert.equal(args.prompt, 'red apple');
        assert.deepEqual(context.imageGenConfig, { provider: 'openrouter', apiKey: 'saved-key', model: 'image-model' });
        dispatched = true;
        return { success: true, provider: 'openrouter', model: 'image-model', url: 'data:image/png;base64,' + 'YWJj'.repeat(4000) };
      };
      const messages = [];
      await agent._executeToolBatch(11, [{ id: 'spoof-call', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'red apple', _generativeMediaUrl: 'https://evil.example' }) } }], messages, () => {}, provider, '', new Set(['generate_image']), 1);
      assert.equal(dispatched, false); assert.match(messages[0].content, /invalid_tool_arguments/);
      messages.length = 0;
      await agent._executeToolBatch(11, [{ id: 'media-call', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'red apple' }) } }], messages, () => {}, provider, '', new Set(['generate_image']), 1);
      assert.equal(dispatched, true, JSON.stringify(messages)); assert.deepEqual(hosts, ['openrouter.ai']);
      assert.ok(messages[0].content.includes('inlineMedia'));
      assert.ok(!messages[0].content.includes('YWJj'));
      assert.ok(!messages[0].content.includes('saved-key'));
      const handleResult = agent._limitToolResult({ success: true, provider: 'openrouter', inlineMedia: true, mediaId: 'private-asset-id', mimeType: 'image/png' });
      assert.ok(handleResult.includes('do not invent a hosted URL'));
      assert.ok(!handleResult.includes('private-asset-id'));
    } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
  });

  test(`${build}: connection tests are authenticated read-only probes with provider validation`, async () => {
    const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
    let selected;
    const api = { storage: { local: { get: async () => ({ imageGenModel: selected }) } } };
    globalThis.chrome = globalThis.browser = api;
    try {
      for (const [provider, values, responses, urls] of [
        ['fal', { apiKey: 'k', model: 'fal-ai/flux/schnell' }, [json({})], ['https://api.fal.ai/v1/workflows?limit=1']],
        ['openrouter', { apiKey: 'k', model: 'image-model' }, [json({ data: {} }), json({ data: [{ id: 'image-model' }] })], ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/images/models']],
        ['comfyrouter', { apiKey: 'k', model: 'bfl/flux-2-pro' }, [json({ id: 'bfl/flux-2-pro' })], ['https://api.comfy.org/v2/models/bfl/flux-2-pro']],
        ['comfyui', { workflow }, [json({ system: {}, devices: [] })], ['http://127.0.0.1:8188/system_stats']],
      ]) {
        selected = { provider, ...values }; const calls = [];
        const result = await media.testImageGenProvider(async (url, init) => { assert.ok(!init.method || init.method === 'GET'); calls.push(url); return responses.shift(); });
        assert.equal(result.ok, true, result.error); assert.deepEqual(calls, urls);
        assert.equal((await media.testImageGenProvider(async () => json({}, 401))).ok, false);
      }
      selected = { provider: 'openrouter', apiKey: 'k', model: 'text-only' };
      const responses = [json({ data: {} }), json({ data: [{ id: 'image-model' }] })];
      assert.match((await media.testImageGenProvider(async () => responses.shift())).error, /image generation catalog/);
    } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
  });

  test(`${build}: locale keys preserve placeholders and neutral media titles`, async () => {
    const { LANGUAGES } = await import(`../src/${build}/src/ui/i18n.js`);
    const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    assert.equal(english['st.imagegen.heading'], 'Generative Media');
    for (const lang of LANGUAGES) {
      const dictionary = (await import(`../src/${build}/src/ui/locales/${lang.code}.js`)).default;
      for (const key of Object.keys(english).filter(key => key.startsWith('st.imagegen.'))) {
        assert.equal(typeof dictionary[key], 'string', `${lang.code}: ${key}`);
        assert.deepEqual([...dictionary[key].matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort(), [...english[key].matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort(), `${lang.code}: ${key}`);
      }
      assert.ok(!dictionary['st.imagegen.heading'].includes('fal.ai'));
    }

  });
}
