import test from 'node:test';
import assert from 'node:assert/strict';

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const { normalizeDolphinPromptedResult, normalizeDolphinPromptedStream } = await import(`../src/${browser}/src/providers/dolphin-prompted-tools.js`);
  const config = { providerName: 'webbrain_me', baseUrl: 'https://openrouter.ai/api/v1', model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition' };
  const tools = ['read_page', 'done'].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false } } }));
  const messages = [{ role: 'system', content: 'Verify the actual result.' }, { role: 'user', content: 'Read the page.' }];
  const content = '<tool_call>{"name":"read_page","arguments":{}}</tool_call>';

  test(`${browser}: imported Dolphin provider uses text tools only for its exact OpenRouter route`, () => {
    const provider = new OpenAICompatibleProvider(config);
    assert.equal(provider.supportsTools, false);
    assert.equal(provider.requiresPromptedTools, true);
    assert.equal(new OpenAICompatibleProvider({ ...config, model: config.model + ':nitro' }).requiresPromptedTools, true);
    for (const other of [{ ...config, model: 'other-model' }, { ...config, baseUrl: 'https://example.com/v1' }, { ...config, baseUrl: 'https://openrouter.ai.example.com/v1' }]) {
      const otherProvider = new OpenAICompatibleProvider(other);
      assert.equal(otherProvider.requiresPromptedTools, false);
      assert.deepEqual(otherProvider._buildChatCompletionsBody(messages, { tools, toolChoice: 'required' }).tools, tools);
    }
    assert.equal(new OpenAICompatibleProvider({ ...config, toolsMode: 'on' }).requiresPromptedTools, false);
  });

  test(`${browser}: text tool request carries current schemas, respects choice and never mutates history`, () => {
    const provider = new OpenAICompatibleProvider(config);
    for (const stream of [false, true]) {
      for (const toolChoice of [undefined, 'auto', 'required', { function: { name: 'done' } }, 'none']) {
        const body = provider._buildChatCompletionsBody(messages, { tools, toolChoice }, stream);
        assert.equal(Object.hasOwn(body, 'tools'), false);
        assert.equal(Object.hasOwn(body, 'tool_choice'), false);
        if (toolChoice === 'none') assert.deepEqual(body.messages, messages);
        else {
          const prompt = body.messages[0].content;
          assert.match(prompt, /TEXT TOOL PROTOCOL/);
          assert.match(prompt, /<tool_call>/);
          assert.match(prompt, /Verify the actual result/);
          const offered = JSON.parse(prompt.split('Currently offered tool schemas:\n')[1]);
          assert.deepEqual(offered, (typeof toolChoice === 'object' ? [tools[1]] : tools).map(tool => tool.function));
          if (toolChoice === 'required') assert.match(prompt, /must emit at least one/);
          if (typeof toolChoice === 'object') assert.match(prompt, /must call only done/);
        }
      }
    }
    assert.equal(messages[0].content, 'Verify the actual result.');
    assert.throws(() => provider._buildChatCompletionsBody(messages, { tools, toolChoice: { function: { name: 'missing' } } }), /not available/);
    assert.equal(provider._buildChatCompletionsBody(messages, { maxTokens: 100 }).messages[0].content, messages[0].content);
  });

  test(`${browser}: complete text calls parse with only offered names; denied/mixed/incomplete batches cannot escape`, () => {
    const options = { tools };
    const parsed = normalizeDolphinPromptedResult(options, { content: '```json\n' + content + '\n```', finishReason: 'stop' });
    assert.equal(parsed.toolCalls[0].function.name, 'read_page');
    assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), {});
    assert.equal(parsed.content, '');
    for (const bad of [
      { options: { tools, toolChoice: 'none' }, content },
      { options: { tools, toolChoice: 'none' }, content: '{"name":"read_page","arguments":{}}' },
      { options: { tools, toolChoice: { function: { name: 'done' } } }, content },
      { options, content: content + '<tool_call>{"name":"navigate","arguments":{"url":"https://example.com"}}</tool_call>' },
      { options, content: 'For example: ' + content },
      { options, content, finishReason: 'length' },
    ]) {
      const rejected = normalizeDolphinPromptedResult(bad.options, { content: bad.content, finishReason: bad.finishReason || 'stop' });
      assert.deepEqual(rejected.toolCalls, []);
      assert.doesNotMatch(rejected.content, /<tool_call>|"name"/);
      assert.ok(rejected.rejectedToolResponse);
    }
    const prose = { content: 'I will read the page.', finishReason: 'stop', toolCalls: [] };
    assert.equal(normalizeDolphinPromptedResult(options, prose), prose, 'Existing Agent bounded prose recovery handles this');
  });

  test(`${browser}: streamed text calls normalize after terminal event and rejected named choice stays non-executable`, async () => {
    async function* stream() { yield { type: 'text', content: content.slice(0, 20) }; yield { type: 'text', content: content.slice(20) }; yield { type: 'done', finishReason: 'stop' }; }
    const collect = async options => { const rows = []; for await (const chunk of normalizeDolphinPromptedStream(options, stream())) rows.push(chunk); return rows; };
    const parsed = await collect({ tools });
    assert.deepEqual(parsed.map(chunk => chunk.type), ['tool_call', 'done']);
    assert.equal(parsed[0].content[0].function.name, 'read_page');
    assert.equal(parsed[1].finishReason, 'tool_calls');
    const denied = await collect({ tools, toolChoice: 'none' });
    assert.deepEqual(denied.map(chunk => chunk.type), ['text', 'done']);
    assert.doesNotMatch(denied[0].content, /tool_call/);
    async function* incomplete() { yield { type: 'text', content }; }
    await assert.rejects(async () => { for await (const chunk of normalizeDolphinPromptedStream({ tools }, incomplete())) assert.fail('No incomplete call may be released'); }, /completion event/);
  });
}
