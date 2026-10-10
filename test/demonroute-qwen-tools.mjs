import { test } from 'node:test';
import assert from 'node:assert/strict';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome ||= { storage: { local: area, session: area }, runtime: { getURL: value => value } };
globalThis.browser ||= globalThis.chrome;

// Exact tool-only recovery response captured from the managed YouTube QA run.
const legacyNavigate = '<tool_call><tool_call><tool_name>navigate</tool_name><tool_args>{"url":"https://www.youtube.com/results?search_query=browser+automation"}</tool_args></tool_call></tool_call>';
const jsonNavigate = '<tool_call>{"name":"navigate","arguments":{"url":"https://example.com/"}}</tool_call>';
const jsonDone = '<tool_call>{"name":"done","arguments":{"summary":"Verified the page.","outcome":"success"}}</tool_call>';
// Complete canonical envelope from the owned cold-wake inference replay. Its
// prose prefix is deliberately excluded: only a tool-only recovery may run.
const canonicalTree = '<tool_call>\n<function=get_accessibility_tree>\n<parameter=filter>\nvisible</parameter>\n<parameter=maxDepth>\n12</parameter>\n<parameter=maxChars>\n8000\n</parameter>\n</function>\n</tool_call>';
const canonicalDone = '<tool_call>\n<function=done>\n<parameter=summary>\nVerified the page.\n</parameter>\n<parameter=outcome>\nsuccess\n</parameter>\n</function>\n</tool_call>';
const capturedPrefixes = [
  'The page is still loading. Let me read the accessibility tree to see the video results.\n\n',
  'The page has loaded but is still active with DOM mutations. Let me now read the accessibility tree to see the video results.\n\n',
];
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
  const { modelOutputDiagnostics } = await import(`../src/${browser}/src/agent/model-output-diagnostics.js`);
  const { projectTraceEventData } = await import(`../src/${browser}/src/trace/privacy.js`);
  const { parseDemonRouteQwenToolCalls: parse, normalizeDemonRouteQwenResult: normalize, normalizeDemonRouteQwenStream: normalizeStream, MAX_QWEN_TOOL_TEXT, INVALID_QWEN_TOOL_RESPONSE } = await import(`../src/${browser}/src/providers/qwen-tool-calls.js`);
  const config = {
    providerName: 'webbrain_me',
    baseUrl: 'https://api.demonroute.com/v1/',
    model: 'huihui-ai/Huihui-Qwen3.5-27B-abliterated',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  };
  const tools = getToolsForMode('act', { tier: 'full', cloudRun: true });
  const options = { tools };

  test(`${browser}: captured canonical parameters decode using their offered schema in chat and stream`, async () => {
    const parsed = parse(config, options, canonicalTree);
    assert.equal(parsed[0].function.name, 'get_accessibility_tree');
    assert.deepEqual(JSON.parse(parsed[0].function.arguments), { filter: 'visible', maxDepth: 12, maxChars: 8000 });
    const batch = parse(config, options, canonicalTree + canonicalDone);
    assert.deepEqual(batch.map(call => call.function.name), ['get_accessibility_tree', 'done']);
    assert.deepEqual(JSON.parse(batch[1].function.arguments), { summary: 'Verified the page.', outcome: 'success' });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_url, request) => JSON.parse(request.body).stream ? sseResponse(canonicalTree) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: canonicalTree } }] });
    try {
      const provider = new OpenAICompatibleProvider(config);
      const result = await provider.chat([], options);
      assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { filter: 'visible', maxDepth: 12, maxChars: 8000 });
      assert.equal(result.content, '');
      const streamed = await collect(provider.chatStream([], options));
      assert.equal(streamed.at(-1).finishReason, 'tool_calls');
      assert.deepEqual(JSON.parse(streamed.find(chunk => chunk.type === 'tool_call').content[0].function.arguments), { filter: 'visible', maxDepth: 12, maxChars: 8000 });
    } finally { globalThis.fetch = previousFetch; }
  });

  test(`${browser}: canonical strings, arrays, objects, numbers and exact Python booleans preserve schema types`, () => {
    const typedTools = [{ type: 'function', function: { name: 'typed_probe', parameters: {
      type: 'object', properties: { text: { type: 'string' }, enabled: { type: 'boolean' }, count: { type: 'integer' }, ratio: { type: 'number' }, object: { type: 'object' }, items: { type: 'array' } },
    } } }];
    const content = '<tool_call><function=typed_probe><parameter=text>\ntrue\nsecond line\n</parameter><parameter=enabled>True</parameter><parameter=count>12</parameter><parameter=ratio>0.5</parameter><parameter=object>{"text":"literal </parameter> text","nested":{"value":1}}</parameter><parameter=items>[false,{"value":2}]</parameter></function></tool_call>';
    const args = JSON.parse(parse(config, { tools: typedTools }, content)[0].function.arguments);
    assert.deepEqual(args, { text: 'true\nsecond line', enabled: true, count: 12, ratio: 0.5, object: { text: 'literal </parameter> text', nested: { value: 1 } }, items: [false, { value: 2 }] });
    for (const value of ['false', 'False']) {
      const calls = parse(config, { tools: typedTools }, `<tool_call><function=typed_probe><parameter=enabled>${value}</parameter></function></tool_call>`);
      assert.equal(JSON.parse(calls[0].function.arguments).enabled, false);
    }
  });

  test(`${browser}: documented canonical prose prefixes preserve content after complete chat and stream parsing`, async () => {
    assert.deepEqual(capturedPrefixes.map(prefix => prefix.length), [89, 126]);
    const previousFetch = globalThis.fetch;
    try {
      for (const prefix of [...capturedPrefixes, 'I will inspect Example Domain and format the results as requested.\n\n']) {
        const content = prefix + canonicalTree;
        globalThis.fetch = async (_url, request) => JSON.parse(request.body).stream ? sseResponse(content) : Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
        const provider = new OpenAICompatibleProvider(config);
        const result = await provider.chat([], options);
        assert.equal(result.content, prefix.trimEnd());
        assert.equal(result.toolCalls[0].function.name, 'get_accessibility_tree');
        const streamed = await collect(provider.chatStream([], options));
        assert.equal(streamed.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join(''), prefix.trimEnd());
        assert.equal(streamed.find(chunk => chunk.type === 'tool_call').content[0].function.name, 'get_accessibility_tree');
        assert.equal(streamed.at(-1).finishReason, 'tool_calls');
      }
    } finally { globalThis.fetch = previousFetch; }
    const emitted = [];
    async function* pending() {
      yield { type: 'text', content: capturedPrefixes[0] };
      yield { type: 'text', content: canonicalTree };
      assert.deepEqual(emitted, [], 'Prefix and calls cannot escape before a real terminal stop');
      yield { type: 'done', finishReason: 'stop' };
    }
    for await (const chunk of normalizeStream(config, options, pending())) emitted.push(chunk);
    assert.equal(emitted[0].content, capturedPrefixes[0].trimEnd());
    assert.equal(emitted[1].type, 'tool_call');
  });

  test(`${browser}: prefixed canonical calls reject code, examples, suffixes and malformed or legacy siblings`, async () => {
    const rejected = [
      'x'.repeat(1025) + canonicalTree,
      'Example call: ' + canonicalTree,
      'For example, ' + canonicalTree,
      'Here is a sample response: ' + canonicalTree,
      '```xml\n' + capturedPrefixes[0] + canonicalTree + '\n```',
      '~~~xml\n' + canonicalTree + '\n~~~',
      '<think>Reasoning</think>' + canonicalTree,
      '`get_accessibility_tree` is the tool. ' + canonicalTree,
      '{"tool_calls":[]} ' + canonicalTree,
      capturedPrefixes[0] + canonicalTree + ' suffix',
      capturedPrefixes[0] + canonicalTree + jsonDone,
      capturedPrefixes[0] + canonicalTree + legacyNavigate,
      capturedPrefixes[0] + canonicalTree + '<tool_call><function=done>',
    ];
    for (const content of rejected) {
      assert.equal(parse(config, options, content), null);
      const result = normalize(config, options, { content, finishReason: 'stop' });
      assert.equal(result.content, INVALID_QWEN_TOOL_RESPONSE);
      assert.deepEqual(Agent.prototype._tryParseToolCallsFromText.call({}, result.content), []);
      const streamed = await collect(normalizeStream(config, options, chunks([{ type: 'text', content }, { type: 'done', finishReason: 'stop' }])));
      assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
      assert.equal(streamed.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join(''), INVALID_QWEN_TOOL_RESPONSE);
    }
    for (const finishReason of ['', 'length', 'content_filter', 'error']) {
      const streamed = await collect(normalizeStream(config, options, chunks([{ type: 'text', content: capturedPrefixes[0] + canonicalTree }, { type: 'done', finishReason }])));
      assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
    }
    for (const failure of [null, new Error('Transport failed'), new DOMException('Cancelled', 'AbortError')]) {
      const emitted = [];
      async function* incomplete() { yield { type: 'text', content: capturedPrefixes[0] + canonicalTree }; if (failure) throw failure; }
      if (failure) await assert.rejects(async () => { for await (const chunk of normalizeStream(config, options, incomplete())) emitted.push(chunk); }, error => error === failure);
      else for await (const chunk of normalizeStream(config, options, incomplete())) emitted.push(chunk);
      assert.deepEqual(emitted, [{ type: 'text', content: INVALID_QWEN_TOOL_RESPONSE }]);
    }
  });

  test(`${browser}: canonical malformed batches, duplicates, unknown parameters and unsafe values dispatch no subset`, async () => {
    const rejected = [
      canonicalTree.replace('<parameter=maxDepth>', '<parameter=not_declared>'),
      canonicalTree.replace('</function>', '<parameter=filter>all</parameter></function>'),
      canonicalTree.replace('<function=get_accessibility_tree>', '<function=not_offered>'),
      canonicalTree.replace('12</parameter>', '"12"</parameter>'),
      canonicalTree.replace('12</parameter>', 'NaN</parameter>'),
      canonicalTree.replace('12</parameter>', '1e999</parameter>'),
      canonicalTree.replace('</function>', '<parameter=__proto__>{}</parameter></function>'),
      canonicalTree.replace('</function>', '<parameter=continuationArgs>{"page":2,"constructor":{}}</parameter></function>'),
      canonicalTree.replace('</function>', '<parameter=continuationArgs>[1,2]</parameter></function>'),
      canonicalTree.replace('</tool_call>', ''),
      canonicalTree.replace('</function>', ''),
      canonicalTree + '<tool_call><function=done><parameter=summary>Incomplete',
      'Example call: ' + canonicalTree,
      canonicalTree + ' prose after',
      '```xml\n' + canonicalTree + '\n```',
      canonicalTree.repeat(17),
    ];
    for (const content of rejected) {
      assert.equal(parse(config, options, content), null, content.slice(0, 160));
      const result = normalize(config, options, { content, finishReason: 'stop' });
      assert.equal(result.content, INVALID_QWEN_TOOL_RESPONSE);
      assert.deepEqual(Agent.prototype._tryParseToolCallsFromText.call({}, result.content), []);
      const streamed = await collect(normalizeStream(config, options, chunks([{ type: 'text', content }, { type: 'done', finishReason: 'stop' }])));
      assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
    }
    assert.equal(parse(config, { tools, toolChoice: 'none' }, canonicalTree), null);
    assert.equal(parse(config, { tools: [] }, canonicalTree), null);
    assert.equal(parse(config, { tools, toolChoice: { type: 'function', function: { name: 'done' } } }, canonicalTree), null);
    assert.equal(parse(config, { tools, toolChoice: { type: 'function', function: { name: 'done' } } }, canonicalDone)[0].function.name, 'done');
    for (const finishReason of ['length', 'error', 'content_filter', '']) {
      assert.equal(normalize(config, options, { content: canonicalTree, finishReason }).content, INVALID_QWEN_TOOL_RESPONSE);
      const streamed = await collect(normalizeStream(config, options, chunks([{ type: 'text', content: canonicalTree }, { type: 'done', finishReason }])));
      assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
    }
    const eof = await collect(normalizeStream(config, options, chunks([{ type: 'text', content: canonicalTree }])));
    assert.equal(eof.some(chunk => chunk.type === 'tool_call'), false);
  });

  test(`${browser}: rejected XML exports only structural diagnostics and never raw sentinel secrets`, () => {
    const secret = 'private-sentinel-secret-do-not-export';
    const content = `<tool_call><tool_name>not_offered</tool_name><tool_args>{"privateValue":"${secret}"}</tool_args></tool_call>`;
    const raw = { choices: [{ message: { content } }] };
    const result = normalize(config, { ...options, toolChoice: { type: 'function', function: { name: 'done' } } }, { content, finishReason: 'stop', raw });
    assert.equal(result.raw, raw, 'Private evidence remains available on the provider result');
    assert.deepEqual(result.rejectedToolResponse, { provider: 'demonroute_qwen', format: 'xml_name_args', reason: 'invalid_envelope', choice: 'named', contentChars: content.length, offeredTools: tools.length });
    const metadata = modelOutputDiagnostics(result);
    for (const includeContent of [false, true]) {
      const exported = projectTraceEventData('llm_response', {
        content: result.content,
        ...metadata,
        rejectedToolResponse: { ...metadata.rejectedToolResponse, originalContent: secret, toolName: secret, unexpected: { secret } },
      }, { includeContent });
      assert.deepEqual(exported.rejectedToolResponse, result.rejectedToolResponse);
      assert.equal(JSON.stringify(exported).includes(secret), false);
    }
    assert.equal(projectTraceEventData('llm_response', { rejectedToolResponse: { ...result.rejectedToolResponse, reason: secret } }).rejectedToolResponse, undefined);
  });

  test(`${browser}: real streamed rejection keeps completion diagnostics with safe export metadata`, async () => {
    const previousFetch = globalThis.fetch;
    const secret = 'stream-private-sentinel-do-not-export';
    const content = `<tool_call>{"name":"not_offered","arguments":{"value":"${secret}"}}</tool_call>`;
    globalThis.fetch = async () => sseResponse(content);
    try {
      const streamed = await collect(new OpenAICompatibleProvider(config).chatStream([], options));
      const done = streamed.at(-1);
      assert.equal(done.type, 'done');
      assert.equal(done.rejectedToolResponse.format, 'json_envelope');
      assert.equal(done.rejectedToolResponse.reason, 'invalid_envelope');
      assert.equal(done.rejectedToolResponse.choice, 'required');
      assert.equal(done.rejectedToolResponse.contentChars, content.length);
      assert.equal(done.raw.qwenToolNormalization.originalContent, content);
      assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
      const metadata = modelOutputDiagnostics({ ...done, content: streamed.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('') });
      assert.deepEqual(projectTraceEventData('llm_response', metadata).rejectedToolResponse, done.rejectedToolResponse);
      assert.equal(JSON.stringify(projectTraceEventData('llm_response', metadata)).includes(secret), false);
    } finally { globalThis.fetch = previousFetch; }
  });

  test(`${browser}: rejection reasons distinguish bounds, incomplete responses and mixed text safely`, async () => {
    for (const [content, finishReason, reason] of [
      [jsonNavigate + ' '.repeat(MAX_QWEN_TOOL_TEXT), 'stop', 'oversized'],
      [jsonNavigate, 'length', 'incomplete_response'],
      ['Explanation. ' + jsonNavigate, 'stop', 'mixed_content'],
    ]) {
      const result = normalize(config, options, { content, finishReason });
      assert.equal(result.rejectedToolResponse.reason, reason);
      const streamed = await collect(normalizeStream(config, options, chunks([{ type: 'text', content }, { type: 'done', finishReason }])));
      assert.equal(streamed.at(-1).rejectedToolResponse.reason, reason);
      assert.equal(streamed.at(-1).rejectedToolResponse.contentChars, content.length);
      assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
    }
  });

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

  test(`${browser}: native calls, ordinary text, no tools and unrelated models are unchanged`, async () => {
    const native = { content: jsonNavigate, toolCalls: [{ id: 'native', function: { name: 'navigate', arguments: '{}' } }], finishReason: 'tool_calls' };
    assert.equal(normalize(config, options, native), native);
    for (const [route, request, content] of [
      [config, options, 'Ordinary answer.'],
      [config, { tools, toolChoice: 'none' }, 'Ordinary answer.'],
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

  test(`${browser}: denied choices sanitize exact-route candidates before the Agent fallback`, async () => {
    const canonicalNavigate = '<tool_call><function=navigate><parameter=url>https://example.com/</parameter></function></tool_call>';
    assert.equal(Agent.prototype._tryParseToolCallsFromText.call({}, canonicalNavigate).length, 1, 'Fixture must exercise the generic text-parser escape path');
    for (const toolChoice of ['none', { type: 'function', function: { name: 'not_offered' } }]) {
      const request = { tools, toolChoice };
      const result = normalize(config, request, { content: canonicalNavigate, finishReason: 'stop' });
      assert.equal(result.content, INVALID_QWEN_TOOL_RESPONSE);
      assert.deepEqual(Agent.prototype._tryParseToolCallsFromText.call({}, result.content), []);
      const streamed = await collect(normalizeStream(config, request, chunks([{ type: 'text', content: canonicalNavigate }, { type: 'done', finishReason: 'stop' }])));
      assert.equal(streamed.some(chunk => chunk.type === 'tool_call'), false);
      assert.equal(streamed[0].content, INVALID_QWEN_TOOL_RESPONSE);
      assert.deepEqual(Agent.prototype._tryParseToolCallsFromText.call({}, streamed[0].content), []);
      assert.equal(streamed.at(-1).rejectedToolResponse.choice, toolChoice === 'none' ? 'none' : 'named');
    }
    const technical = { content: canonicalNavigate, finishReason: 'stop' };
    assert.equal(normalize(config, {}, technical), technical);
    assert.equal(normalize(config, { tools: [], toolChoice: 'none' }, technical), technical);
    const ordinary = { content: 'Read about tool calling.', finishReason: 'stop' };
    assert.equal(normalize(config, { tools, toolChoice: 'none' }, ordinary), ordinary);
    const native = { ...technical, toolCalls: [{ id: 'native', function: { name: 'navigate', arguments: '{}' } }] };
    assert.equal(normalize(config, { tools, toolChoice: 'none' }, native), native);
    assert.equal(normalize({ ...config, model: 'other/model' }, { tools, toolChoice: 'none' }, technical), technical);
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

  test(`${browser}: an empty native delta cannot disable complete XML normalization or rejection`, async () => {
    for (const [content, expectedCalls] of [[legacyNavigate, 1], [jsonNavigate + '<tool_call>{"name":"unknown","arguments":{}}</tool_call>', 0]]) {
      const streamed = await collect(normalizeStream(config, options, chunks([
        { type: 'tool_call', content: [] },
        { type: 'text', content },
        { type: 'done', finishReason: 'stop' },
      ])));
      assert.deepEqual(streamed[0], { type: 'tool_call', content: [] });
      assert.equal(streamed.filter(chunk => chunk.type === 'tool_call').flatMap(chunk => chunk.content).length, expectedCalls);
      if (!expectedCalls) assert.equal(streamed.find(chunk => chunk.type === 'text').content, INVALID_QWEN_TOOL_RESPONSE);
    }
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
        assert.equal(text, override.tool_choice === 'none' || typeof override.tool_choice === 'object' ? INVALID_QWEN_TOOL_RESPONSE : jsonNavigate);
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
