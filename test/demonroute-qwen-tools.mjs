import { test } from 'node:test';
import assert from 'node:assert/strict';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome ||= { storage: { local: area, session: area }, runtime: { getURL: value => value } };
globalThis.browser ||= globalThis.chrome;

// Exact tool-only recovery response captured from the managed YouTube QA run.
const legacyNavigate = '<tool_call><tool_call><tool_name>navigate</tool_name><tool_args>{"url":"https://www.youtube.com/results?search_query=browser+automation"}</tool_args></tool_call></tool_call>';
const jsonNavigate = '<tool_call>{"name":"navigate","arguments":{"url":"https://example.com/"}}</tool_call>';
const jsonDone = '<tool_call>{"name":"done","arguments":{"summary":"Verified the page.","outcome":"success"}}</tool_call>';
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
async function* chunks(values) { yield* values; }
function sseResponse(content, finishReason = 'stop', nativeCalls = null) {
  const payloads = [
    { choices: [{ delta: { content: content.slice(0, 17) } }] },
    { choices: [{ delta: { content: content.slice(17), ...(nativeCalls ? { tool_calls: nativeCalls } : {}) }, finish_reason: finishReason }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } },
  ];
  return new Response(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const { getToolsForMode } = await import(`../src/${browser}/src/agent/tools.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { parseDemonRouteQwenToolCalls: parse, normalizeDemonRouteQwenResult: normalize, normalizeDemonRouteQwenStream: normalizeStream, MAX_QWEN_TOOL_TEXT, INVALID_QWEN_TOOL_RESPONSE } = await import(`../src/${browser}/src/providers/qwen-tool-calls.js`);
  const config = {
    providerName: 'webbrain_me',
    baseUrl: 'https://api.demonroute.com/v1/',
    model: 'huihui-ai/Huihui-Qwen3.5-27B-abliterated',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  };
  const tools = getToolsForMode('act', { tier: 'full', cloudRun: true });
  const options = { tools };

  test(`${browser}: exact captured nested XML and complete JSON batches become supplied native calls`, () => {
    const parsed = parse(config, options, legacyNavigate);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].function.name, 'navigate');
    assert.deepEqual(JSON.parse(parsed[0].function.arguments), { url: 'https://www.youtube.com/results?search_query=browser+automation' });
    assert.match(parsed[0].id, /^call_[a-f0-9]+$/);
    const batch = parse(config, options, `\n${jsonNavigate}\n${jsonDone}\n`);
    assert.deepEqual(batch.map(call => call.function.name), ['navigate', 'done']);
    assert.equal(new Set(batch.map(call => call.id)).size, 2);
    const quoted = '<tool_call><tool_name>done</tool_name><tool_args>{"summary":"quotes \\\" and braces } and </tool_args> remain text","outcome":"success"}</tool_args></tool_call>';
    assert.equal(JSON.parse(parse(config, options, quoted)[0].function.arguments).outcome, 'success');
  });

  test(`${browser}: malformed, unknown, unsafe, oversized or mixed envelopes reject the whole batch`, () => {
    const deep = { leaf: 'value' }; let nested = deep;
    for (let index = 0; index < 34; index++) nested = { child: nested };
    const rejected = [
      `${jsonNavigate}<tool_call>{"name":"unknown","arguments":{}}</tool_call>`,
      `${jsonNavigate}<tool_call>{"name":"done","arguments":`,
      `${jsonNavigate} trailing explanation`,
      `I will navigate. ${legacyNavigate}`,
      '```javascript\n' + jsonNavigate + '\n```',
      '<tool_call>{"name":"navigate","arguments":"{url:123}"}</tool_call>',
      '<tool_call>{"name":"navigate","arguments":[]}</tool_call>',
      '<tool_call>{"name":"navigate","arguments":{},"extra":true}</tool_call>',
      '<tool_call><tool_name>navigate</tool_name><tool_args>{url:"https://example.com/"}</tool_args></tool_call>',
      '<tool_call>{"name":"navigate","arguments":{"__proto__":{}}}</tool_call>',
      '<tool_call>{"name":"navigate","arguments":{"children":[{"constructor":{}}]}}</tool_call>',
      '<tool_call>{"name":"navigate","arguments":{"nested":{"prototype":{}}}}</tool_call>',
      `<tool_call>{"name":"navigate","arguments":${JSON.stringify(nested)}}</tool_call>`,
      '<tool_call>'.repeat(34) + jsonNavigate + '</tool_call>'.repeat(34),
      jsonNavigate.repeat(17),
      `<tool_call>{"name":"done","arguments":{"summary":"${'x'.repeat(MAX_QWEN_TOOL_TEXT)}"}}</tool_call>`,
      jsonNavigate.toUpperCase(),
    ];
    for (const content of rejected) {
      assert.equal(parse(config, options, content), null, content.slice(0, 120));
      const raw = { choices: [{ message: { content } }] };
      const result = normalize(config, options, { content, toolCalls: null, finishReason: 'stop', raw });
      assert.equal(result.content, INVALID_QWEN_TOOL_RESPONSE);
      assert.equal(result.toolCalls, null);
      assert.equal(result.raw, raw);
      assert.deepEqual(Agent.prototype._tryParseToolCallsFromText.call({}, result.content), []);
    }
  });

  test(`${browser}: rejected mixed batch cannot dispatch a valid subset through Agent fallback`, () => {
    const content = jsonNavigate + '<tool_call>{"name":"not_offered","arguments":{}}</tool_call>';
    assert.equal(Agent.prototype._tryParseToolCallsFromText.call({}, content).length, 1, 'Fixture must exercise permissive generic salvage');
    const result = normalize(config, options, { content, finishReason: 'stop', toolCalls: null });
    assert.equal(result.raw.qwenToolNormalization.originalContent, content);
    assert.deepEqual(Agent.prototype._tryParseToolCallsFromText.call({}, result.content), []);
  });

  test(`${browser}: native calls, ordinary text, none, no tools and unrelated models are unchanged`, async () => {
    const native = { content: jsonNavigate, toolCalls: [{ id: 'native', function: { name: 'navigate', arguments: '{}' } }], finishReason: 'tool_calls' };
    assert.equal(normalize(config, options, native), native);
    for (const [route, request, content] of [
      [config, options, 'Ordinary answer.'],
      [config, { tools, toolChoice: 'none' }, jsonNavigate],
      [config, { tools: [] }, jsonNavigate],
      [config, {}, jsonNavigate],
      [{ ...config, model: 'other/model' }, options, jsonNavigate],
      [{ ...config, baseUrl: 'https://another.example/v1' }, options, jsonNavigate],
    ]) {
      const result = { content, finishReason: 'stop' };
      assert.equal(normalize(route, request, result), result);
      const original = [{ type: 'text', content }, { type: 'done', finishReason: 'stop' }];
      assert.deepEqual(await collect(normalizeStream(route, request, chunks(original))), original);
    }
    assert.equal(parse(config, { tools, toolChoice: { type: 'function', function: { name: 'done' } } }, jsonNavigate), null);
    assert.equal(parse(config, { tools, toolChoice: { type: 'function', function: { name: 'done' } } }, jsonDone)[0].function.name, 'done');
    const original = [{ type: 'text', content: jsonNavigate }, { type: 'tool_call', content: native.toolCalls }, { type: 'text', content: 'Native suffix.' }, { type: 'done', finishReason: 'tool_calls' }];
    assert.deepEqual(await collect(normalizeStream(config, options, chunks(original))), original);
  });

  test(`${browser}: normalization requires a real stop and never executes EOF, error, cancellation or truncation`, async () => {
    for (const finishReason of ['', undefined, 'length', 'content_filter', 'error']) {
      const result = normalize(config, options, { content: jsonNavigate, finishReason });
      assert.equal(result.content, INVALID_QWEN_TOOL_RESPONSE);
      assert.equal(result.toolCalls, undefined);
      const streamed = await collect(normalizeStream(config, options, chunks([{ type: 'text', content: jsonNavigate }, { type: 'done', finishReason }])));
      assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
      assert.equal(streamed[0].content, INVALID_QWEN_TOOL_RESPONSE);
      assert.equal(streamed.at(-1).raw.qwenToolNormalization.originalContent, jsonNavigate);
    }
    const eof = await collect(normalizeStream(config, options, chunks([{ type: 'text', content: jsonNavigate }])));
    assert.deepEqual(eof, [{ type: 'text', content: INVALID_QWEN_TOOL_RESPONSE }]);
    for (const error of [new Error('Transport failed'), new DOMException('Cancelled', 'AbortError')]) {
      const emitted = [];
      async function* failed() { yield { type: 'text', content: jsonNavigate }; throw error; }
      await assert.rejects(async () => { for await (const chunk of normalizeStream(config, options, failed())) emitted.push(chunk); }, caught => caught === error);
      assert.equal(emitted.some(chunk => chunk.type === 'tool_call'), false);
      assert.deepEqual(emitted, [{ type: 'text', content: INVALID_QWEN_TOOL_RESPONSE }]);
      assert.equal(error.raw.qwenToolNormalization.originalContent, jsonNavigate);
    }
  });

  test(`${browser}: oversized XML streams reject without releasing a prefix and keep bounded diagnostics`, async () => {
    const content = jsonNavigate + ' '.repeat(MAX_QWEN_TOOL_TEXT * 3);
    const original = [];
    for (let index = 0; index < content.length; index += 1000) original.push({ type: 'text', content: content.slice(index, index + 1000) });
    original.push({ type: 'done', finishReason: 'stop' });
    const streamed = await collect(normalizeStream(config, options, chunks(original)));
    assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
    assert.equal(streamed.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join(''), INVALID_QWEN_TOOL_RESPONSE);
    assert.equal(streamed.at(-1).raw.qwenToolNormalization.truncated, true);
    assert.equal(streamed.at(-1).raw.qwenToolNormalization.originalContent.length, MAX_QWEN_TOOL_TEXT);
    assert.deepEqual(Agent.prototype._tryParseToolCallsFromText.call({}, streamed[0].content), []);
    const prose = original.map(chunk => chunk.type === 'text' ? { ...chunk, content: chunk.content.replaceAll('<', '[') } : chunk);
    assert.deepEqual(await collect(normalizeStream(config, options, chunks(prose))), prose);
  });

  test(`${browser}: actual provider responses normalize XML in chat and streamed terminal responses`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.tool_choice, 'required');
      return body.stream ? sseResponse(legacyNavigate) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: legacyNavigate } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
    };
    try {
      for (const providerName of ['webbrain_me', 'custom-demonroute']) {
        const provider = new OpenAICompatibleProvider({ ...config, providerName });
        const result = await provider.chat([], options);
        assert.equal(result.toolCalls[0].function.name, 'navigate');
        assert.equal(result.content, '');
        assert.equal(result.raw.choices[0].message.content, legacyNavigate);
        const streamed = await collect(provider.chatStream([], options));
        assert.equal(streamed.filter(chunk => chunk.type === 'text').length, 0);
        assert.equal(streamed.find(chunk => chunk.type === 'tool_call').content[0].function.name, 'navigate');
        assert.equal(streamed.at(-1).finishReason, 'tool_calls');
        assert.equal(streamed.at(-1).raw.qwenToolNormalization.originalContent, legacyNavigate);
        assert.deepEqual(streamed.find(chunk => chunk.type === 'usage').usage, result.usage);
      }
    } finally { globalThis.fetch = previousFetch; }
  });

  test(`${browser}: streamed normalization follows final serialized tools and named or none choice`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse(jsonNavigate);
    try {
      for (const override of [{ tool_choice: 'none' }, { tool_choice: { type: 'function', function: { name: 'done' } } }, { tools: undefined, tool_choice: undefined }]) {
        const provider = new OpenAICompatibleProvider(config);
        const build = provider._buildChatCompletionsBody.bind(provider);
        provider._buildChatCompletionsBody = (...args) => ({ ...build(...args), ...override });
        const streamed = await collect(provider.chatStream([], options));
        assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
        const text = streamed.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('');
        assert.equal(text, override.tool_choice && typeof override.tool_choice === 'object' ? INVALID_QWEN_TOOL_RESPONSE : jsonNavigate);
      }
    } finally { globalThis.fetch = previousFetch; }
  });

  test(`${browser}: imported DemonRoute Qwen defaults browser tool calls to required`, () => {
    for (const providerName of ['webbrain_me', 'openai', 'custom-demonroute']) {
      const provider = new OpenAICompatibleProvider({ ...config, providerName });
      for (const stream of [false, true]) {
        const body = provider._buildChatCompletionsBody([], { tools, maxTokens: 8192 }, stream);
        assert.equal(body.tool_choice, 'required');
        assert.deepEqual(body.tools, tools);
        assert.equal(body.stream, stream);
        assert.equal(body.max_tokens, 8192);
        assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
      }
    }
  });

  test(`${browser}: explicit choices and calls without tools retain their contract`, () => {
    const provider = new OpenAICompatibleProvider(config);
    const named = { type: 'function', function: { name: 'done' } };
    for (const stream of [false, true]) {
      for (const toolChoice of ['none', 'auto', 'required', named]) {
        const body = provider._buildChatCompletionsBody([], { tools, toolChoice }, stream);
        assert.deepEqual(body.tool_choice, toolChoice);
        assert.deepEqual(body.tools, tools);
      }
      for (const empty of [undefined, []]) {
        const body = provider._buildChatCompletionsBody([], { tools: empty, maxTokens: 1000 }, stream);
        assert.equal(Object.hasOwn(body, 'tools'), false);
        assert.equal(Object.hasOwn(body, 'tool_choice'), false);
        assert.equal(body.max_tokens, 1000);
      }
    }
  });

  test(`${browser}: other routes and models retain automatic selection`, () => {
    for (const other of [
      { ...config, baseUrl: 'https://api.demonroute.com/other' },
      { ...config, baseUrl: 'https://api.demonroute.com.example/v1' },
      { ...config, baseUrl: 'https://other.example/v1' },
      { ...config, model: 'other/model' },
    ]) {
      for (const stream of [false, true]) {
        const body = new OpenAICompatibleProvider(other)._buildChatCompletionsBody([], { tools }, stream);
        assert.equal(body.tool_choice, 'auto');
      }
    }
  });

  test(`${browser}: required browser calls still permit terminal done and clarify`, async () => {
    const previousFetch = globalThis.fetch;
    const provider = new OpenAICompatibleProvider(config);
    let terminalName;
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(String(request.body));
      assert.equal(body.tool_choice, 'required');
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].function.name, terminalName);
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
        content: '',
        tool_calls: [{ id: 'test-call', type: 'function', function: {
          name: terminalName,
          arguments: JSON.stringify(terminalName === 'done' ? { summary: 'Verified Example Domain.', outcome: 'success' } : { question: 'Please sign in to continue.' }),
        } }],
      } }] });
    };
    try {
      for (terminalName of ['done', 'clarify']) {
        const tool = tools.find(tool => tool.function.name === terminalName);
        assert.ok(tool);
        const result = await provider.chat([{ role: 'user', content: 'Finish or ask for help using the supplied tool.' }], { tools: [tool] });
        assert.equal(result.finishReason, 'tool_calls');
        assert.equal(result.toolCalls[0].function.name, terminalName);
      }
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}
