import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import vm from 'node:vm';

const nativeFetch = globalThis.fetch;
const encoder = new TextEncoder();
const api = {
  storage: { local: { get: async () => ({ requestTimeoutMs: 5000 }) }, onChanged: { addListener() {} } },
  runtime: {},
  tabs: { get: async () => ({ url: 'https://page.example/current' }) },
};
globalThis.chrome = api;
globalThis.browser = api;

function openResponse(text = '', contentType = 'text/event-stream', status = 200) {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) { if (text) controller.enqueue(encoder.encode(text)); },
    cancel() { cancelled++; },
  });
  return {
    response: new Response(body, { status, headers: { 'content-type': contentType } }),
    cancelled: () => cancelled,
  };
}

const suites = [];
for (const browser of ['chrome', 'firefox']) {
  const base = new URL(`../src/${browser}/src/`, import.meta.url);
  const network = await import(new URL('network/network-tools.js', base));
  const lifecycle = await import(new URL('network/response-body.js', base));
  const { OpenAICompatibleProvider } = await import(new URL('providers/openai.js', base));
  const { AnthropicProvider } = await import(new URL('providers/anthropic.js', base));
  const { AzureOpenAIProvider } = await import(new URL('providers/azure-openai.js', base));
  const { LlamaCppProvider } = await import(new URL('providers/llamacpp.js', base));
  const { AwsBedrockProvider } = await import(new URL('providers/aws-bedrock.js', base));
  suites.push({ browser, network, lifecycle, providers: [
    ['chat', new OpenAICompatibleProvider({ apiFormat: 'chat', model: 'gpt-4o', supportsAskStreaming: true }), 'data: [DONE]\n\n'],
    ['responses', new OpenAICompatibleProvider({ apiFormat: 'responses', model: 'gpt-5.6-terra', supportsAskStreaming: true }), 'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'],
    ['anthropic', new AnthropicProvider({ model: 'claude-sonnet-5', supportsAskStreaming: true }), 'data: {"type":"message_stop"}\n\n'],
    ['azure', new AzureOpenAIProvider({ baseUrl: 'https://test.openai.azure.com', model: 'deployment', supportsAskStreaming: true }), 'data: [DONE]\n\n'],
    ['llamacpp', new LlamaCppProvider({ supportsAskStreaming: true }), 'data: [DONE]\n\n'],
  ], bedrock: new AwsBedrockProvider({ model: 'test-model', accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' }) });
}

// These tests deliberately use headers followed by a body that never reaches EOF.
// Finite fixture responses would hide the ownership and cancellation bugs.
for (const { browser, network, lifecycle, providers, bedrock } of suites) {
  for (const [protocol, provider] of [...providers, ['bedrock', bedrock]]) {
    test(`${browser}/${protocol}: non-streaming requests preserve Stop while waiting for headers`, async () => {
      const controller = new AbortController();
      let started;
      const hasStarted = new Promise(resolve => { started = resolve; });
      globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => {
        started();
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      const pending = provider.chat([{ role: 'user', content: 'hello' }], { signal: controller.signal });
      await hasStarted;
      const reason = new DOMException('Stopped by user', 'AbortError');
      controller.abort(reason);
      await assert.rejects(pending, error => error === reason);
    });
  }
  for (const [protocol, provider, terminal] of providers) {
    test(`${browser}/${protocol}: terminal event closes an otherwise open response`, async () => {
      const source = openResponse(terminal);
      globalThis.fetch = async () => source.response;
      const events = [];
      for await (const event of provider.chatStream([{ role: 'user', content: 'hello' }])) {
        events.push(event);
        if (event.type === 'done') break;
      }
      assert.equal(events.at(-1).type, 'done');
      assert.equal(source.cancelled(), 1);
      assert.equal(source.response.body.locked, false);
    });

    test(`${browser}/${protocol}: Stop rejects pending read without fallback or leaked reader`, async () => {
      const source = openResponse();
      const controller = new AbortController();
      let requestSignal;
      globalThis.fetch = async (_url, init) => { requestSignal = init.signal; return source.response; };
      const iterator = provider.chatStream([{ role: 'user', content: 'hello' }], { signal: controller.signal });
      const pending = iterator.next();
      await new Promise(resolve => setImmediate(resolve));
      const reason = new DOMException('Stopped by user', 'AbortError');
      controller.abort(reason);
      await assert.rejects(pending, error => error === reason && !error.isAskStreamFallbackSafe);
      assert.equal(requestSignal.aborted, true);
      assert.equal(source.cancelled(), 1);
      assert.equal(source.response.body.locked, false);
    });

    test(`${browser}/${protocol}: body idle deadline is terminal and cancels the source`, async () => {
      const source = openResponse();
      globalThis.fetch = async () => source.response;
      const iterator = provider.chatStream([{ role: 'user', content: 'hello' }], { streamIdleTimeoutMs: 10 });
      await assert.rejects(iterator.next(), error => error.code === 'response_body_timeout'
        && error.isAskStreamTerminalError && !error.isAskStreamFallbackSafe);
      assert.equal(source.cancelled(), 1);
      assert.equal(source.response.body.locked, false);
    });

    test(`${browser}/${protocol}: stream HTTP error body also has a deadline`, async () => {
      const source = openResponse('', 'text/plain', 503);
      globalThis.fetch = async () => source.response;
      const iterator = provider.chatStream([{ role: 'user', content: 'hello' }], { streamIdleTimeoutMs: 10 });
      await assert.rejects(iterator.next(), error => error.code === 'response_body_timeout');
      assert.equal(source.cancelled(), 1);
    });
  }

  test(`${browser}: managed reader uses configured provider idle timeout`, async () => {
    const provider = providers[0][1];
    const source = openResponse();
    const realSetTimeout = globalThis.setTimeout;
    let armedTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => {
      armedTimeout = delay;
      return realSetTimeout(fn, delay, ...args);
    };
    const controller = new AbortController();
    try {
      const reader = await provider._openStreamReader(source.response, { signal: controller.signal });
      const pending = reader.read();
      assert.equal(armedTimeout, 5000);
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test(`${browser}: byte cap cancels chunked bodies without Content-Length`, async () => {
    const source = openResponse('abcdefghij', 'text/plain');
    const result = await lifecycle.readResponseText(source.response, { maxBytes: 4 });
    assert.deepEqual(result, { text: 'abcd', bytesRead: 4, exceeded: true });
    assert.equal(source.cancelled(), 1);
    assert.equal(source.response.body.locked, false);
  });

  test(`${browser}: fetch_url rejects an oversized body before formatting`, async () => {
    const source = openResponse('x'.repeat(8 * 1024 * 1024 + 1), 'application/json');
    globalThis.fetch = async () => source.response;
    const result = await network.fetchUrl('https://public.example/huge.json');
    assert.equal(result.success, false);
    assert.match(result.error, /exceeds 8388608 bytes/);
    assert.equal(source.cancelled(), 1);
  });

  for (const tool of ['fetchUrl', 'readPageSource']) {
    test(`${browser}/${tool}: deadline covers the body after headers`, async () => {
      const source = openResponse('', 'text/html');
      globalThis.fetch = async () => source.response;
      const result = await network[tool]('https://public.example/file', {}, { timeoutMs: 10 });
      assert.equal(result.success, false);
      assert.match(result.error, /timed out/);
      assert.equal(source.cancelled(), 1);
    });

    test(`${browser}/${tool}: extension signal stops body reads`, async () => {
      const source = openResponse('', 'text/html');
      globalThis.fetch = async () => source.response;
      const controller = new AbortController();
      const pending = network[tool]('https://public.example/file', {}, { signal: controller.signal });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort(new Error('Stopped by user'));
      const result = await pending;
      assert.equal(result.success, false);
      assert.match(result.error, /Stopped by user/);
      assert.equal(source.cancelled(), 1);
    });
  }

  test(`${browser}: fetch_url/readPageSource never dispatch a real redirect target`, async () => {
    const hits = [];
    const server = createServer((request, response) => {
      hits.push({ url: request.url, method: request.method });
      if (request.url === '/redirect') response.writeHead(307, { location: '/forbidden' }).end();
      else response.writeHead(200).end('should not be fetched');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const local = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (_url, init) => nativeFetch(`${local}/redirect`, init);
    try {
      const mutation = await network.fetchUrl('https://page.example/redirect', { method: 'POST', body: 'private payload' }, { tabId: 1 });
      const source = await network.readPageSource('https://public.example/redirect');
      assert.equal(mutation.success, false);
      assert.equal(source.success, false);
      assert.match(mutation.error, /Redirect was not followed/);
      assert.deepEqual(hits, [{ url: '/redirect', method: 'POST' }, { url: '/redirect', method: 'GET' }]);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test(`${browser}: isolated replay rejects redirects and supports Stop during response`, async () => {
    globalThis.location = new URL('https://page.example/current');
    globalThis.__webbrainApiRequestReplay = new Map([['request', {
      tabId: 1, url: 'https://page.example/api', method: 'POST', body: 'private payload',
    }]]);
    api.scripting = { executeScript: async ({ func, args, world }) => {
      assert.equal(world, 'ISOLATED');
      return [{ result: await func(...args) }];
    } };
    api.tabs.executeScript = async (_tabId, { code }) => [await vm.runInThisContext(code)];
    let sends = 0;
    globalThis.fetch = async (_url, init) => {
      sends++;
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 307, headers: { location: 'https://other.example/' } });
    };
    const redirected = await network.fetchUrl('https://page.example/api', { replayRequestId: 'request' }, { tabId: 1 });
    assert.equal(redirected.success, false);
    assert.match(redirected.error, /redirect was not followed/);
    assert.equal(sends, 1);

    let stopped = false;
    let started;
    const hasStarted = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async (_url, { signal }) => {
      started();
      return new Response(new ReadableStream({
        start(controller) { signal.addEventListener('abort', () => { stopped = true; controller.error(signal.reason); }); },
      }), { headers: { 'content-type': 'text/plain' } });
    };
    const controller = new AbortController();
    const pending = network.fetchUrl('https://page.example/api', { replayRequestId: 'request' }, { tabId: 1, signal: controller.signal });
    await hasStarted;
    controller.abort(new Error('Stopped by user'));
    const cancelled = await pending;
    assert.equal(cancelled.success, false);
    assert.equal(cancelled.cancelled, true);
    assert.equal(stopped, true);
    assert.equal(globalThis.__webbrainNetworkReplays.size, 0);
    delete api.scripting;
    delete api.tabs.executeScript;
    delete globalThis.__webbrainApiRequestReplay;
    delete globalThis.location;
  });
}

test('chrome: terminal SSE closes the offscreen proxy port before remote EOF', async () => {
  const provider = suites.find(suite => suite.browser === 'chrome').providers[0][1];
  const messages = [];
  const disconnectListeners = [];
  let disconnects = 0;
  api.offscreen = { hasDocument: async () => true };
  api.runtime.connect = () => ({
    onMessage: { addListener: listener => messages.push(listener) },
    onDisconnect: { addListener: listener => disconnectListeners.push(listener) },
    postMessage() {
      queueMicrotask(() => {
        for (const listener of messages) listener({ type: 'headers', status: 200, ok: true, contentType: 'text/event-stream', hasBody: true });
        for (const listener of messages) listener({ type: 'chunk', text: 'data: [DONE]\n\n' });
      });
    },
    disconnect() {
      if (disconnects++) return;
      for (const listener of disconnectListeners) listener();
    },
  });
  globalThis.fetch = async () => { throw new Error('POST must not dispatch a second transport'); };
  try {
    for await (const event of provider.chatStream([{ role: 'user', content: 'hello' }])) {
      if (event.type === 'done') break;
    }
    assert.equal(disconnects, 1);
  } finally {
    delete api.runtime.connect;
    delete api.offscreen;
  }
});

test.after(() => { globalThis.fetch = nativeFetch; });
