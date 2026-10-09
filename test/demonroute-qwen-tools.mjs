import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const { getToolsForMode } = await import(`../src/${browser}/src/agent/tools.js`);
  const config = {
    providerName: 'webbrain_me',
    baseUrl: 'https://api.demonroute.com/v1/',
    model: 'huihui-ai/Huihui-Qwen3.5-27B-abliterated',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  };
  const tools = getToolsForMode('act', { tier: 'full', cloudRun: true });

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
