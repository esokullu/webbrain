import assert from 'node:assert/strict';
import { test } from 'node:test';

const tools = ['vision_navigate', 'vision_wait'].map(name => ({
  type: 'function',
  function: { name, parameters: { type: 'object', properties: {} } },
}));
const messages = [{ role: 'user', content: [
  { type: 'text', text: 'Inspect this screenshot before the next action.' },
  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } },
] }];
const namedChoice = { type: 'function', function: { name: 'vision_navigate' } };

function anthropicResponse(stream) {
  if (!stream) return Response.json({ content: [{ type: 'text', text: 'Ready.' }], usage: { input_tokens: 1, output_tokens: 1 } });
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const { AzureOpenAIProvider } = await import(`../src/${browser}/src/providers/azure-openai.js`);
  const { LlamaCppProvider } = await import(`../src/${browser}/src/providers/llamacpp.js`);
  const { DeepSeekProvider } = await import(`../src/${browser}/src/providers/deepseek.js`);
  const { AnthropicProvider, AnthropicOAuthProvider } = await import(`../src/${browser}/src/providers/anthropic.js`);
  const { VertexAnthropicProvider } = await import(`../src/${browser}/src/providers/vertex-anthropic.js`);

  const compatibleProviders = [
    ['OpenAI Chat', OpenAICompatibleProvider, '_buildChatCompletionsBody', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }],
    ['OpenAI Responses', OpenAICompatibleProvider, '_buildResponsesBody', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }],
    ['Azure', AzureOpenAIProvider, '_buildRequestBody', { baseUrl: 'https://example.openai.azure.com', model: 'vision-deployment' }],
    ['llama.cpp', LlamaCppProvider, '_buildRequestBody', { baseUrl: 'http://localhost:8080', model: 'local-vision-model' }],
    ['DeepSeek', DeepSeekProvider, '_buildChatCompletionsBody', { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4.1-flash' }],
  ];

  for (const [label, Provider, builder, config] of compatibleProviders) {
    test(`${browser}: ${label} opts out only when explicitly false in both request modes`, () => {
      const provider = new Provider(config);
      for (const stream of [false, true]) {
        for (const parallelToolCalls of [undefined, true, null, 0, 'false']) {
          const body = provider[builder](messages, { tools, parallelToolCalls }, stream);
          assert.equal(Object.hasOwn(body, 'parallel_tool_calls'), false);
        }
        for (const toolChoice of [undefined, 'required', namedChoice]) {
          const baseline = provider[builder](messages, { tools, toolChoice }, stream);
          const body = provider[builder](messages, { tools, toolChoice, parallelToolCalls: false }, stream);
          assert.deepEqual(body, { ...baseline, parallel_tool_calls: false });
          assert.equal(body.tools.length, 2);
        }
        for (const absentTools of [undefined, []]) {
          const body = provider[builder](messages, { tools: absentTools, parallelToolCalls: false }, stream);
          assert.equal(Object.hasOwn(body, 'parallel_tool_calls'), false);
        }
      }
    });

    test(`${browser}: ${label} explicit per-call limit overrides configured/request extras`, () => {
      const provider = new Provider({ ...config, extraBody: { parallel_tool_calls: true } });
      for (const stream of [false, true]) {
        const options = { tools, extraBody: { parallel_tool_calls: true } };
        assert.equal(provider[builder](messages, options, stream).parallel_tool_calls, true);
        assert.equal(provider[builder](messages, { ...options, parallelToolCalls: false }, stream).parallel_tool_calls, false);
        assert.equal(provider.config.extraBody.parallel_tool_calls, true);
        assert.equal(options.extraBody.parallel_tool_calls, true);
      }
    });
  }

  test(`${browser}: image compatibility and Muse tool filtering do not receive orphaned limits`, () => {
    for (const Provider of [OpenAICompatibleProvider, AzureOpenAIProvider]) {
      const provider = new Provider({ model: 'vision-model', omitToolsWhenImagesPresent: true });
      const builder = provider._buildChatCompletionsBody || provider._buildRequestBody;
      for (const stream of [false, true]) {
        const body = builder.call(provider, messages, { tools, parallelToolCalls: false }, stream);
        assert.equal(Object.hasOwn(body, 'tools'), false);
        assert.equal(Object.hasOwn(body, 'parallel_tool_calls'), false);
      }
    }
    const muse = new OpenAICompatibleProvider({ baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/muse-wonder' });
    for (const builder of ['_buildChatCompletionsBody', '_buildResponsesBody']) {
      const body = muse[builder](messages, { tools, toolChoice: namedChoice, parallelToolCalls: false });
      assert.equal(body.tool_choice, 'auto');
      assert.equal(body.tools.length, 1);
      assert.equal(body.parallel_tool_calls, false);
      const none = muse[builder](messages, { tools, toolChoice: 'none', parallelToolCalls: false });
      assert.equal(Object.hasOwn(none, 'tools'), false);
      assert.equal(Object.hasOwn(none, 'parallel_tool_calls'), false);
    }
  });

  test(`${browser}: direct Google compatibility endpoints do not receive unsupported parallel flags`, () => {
    for (const baseUrl of [
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'https://aiplatform.googleapis.com/v1/projects/project/locations/global/endpoints/openapi',
      'https://us-central1-aiplatform.googleapis.com/v1/projects/project/locations/us-central1/endpoints/openapi',
      'https://aiplatform.eu.rep.googleapis.com/v1/projects/project/locations/eu/endpoints/openapi',
    ]) {
      const provider = new OpenAICompatibleProvider({ baseUrl, model: 'gemini-3.7-flash' });
      for (const stream of [false, true]) {
        const baseline = provider._buildChatCompletionsBody(messages, { tools }, stream);
        const body = provider._buildChatCompletionsBody(messages, { tools, parallelToolCalls: false }, stream);
        assert.deepEqual(body, baseline);
      }
    }
    for (const baseUrl of ['https://openrouter.ai/api/v1', 'https://generativelanguage.googleapis.com.example.com/v1']) {
      const provider = new OpenAICompatibleProvider({ baseUrl, model: 'google/gemini-3.7-flash' });
      assert.equal(provider._buildChatCompletionsBody(messages, { tools, parallelToolCalls: false }).parallel_tool_calls, false);
    }
  });

  test(`${browser}: Anthropic preserves single-call preference across thinking normalization`, () => {
    for (const model of ['claude-sonnet-4-5', 'claude-sonnet-5-5']) {
      const provider = new AnthropicProvider({ model });
      for (const stream of [false, true]) {
        for (const tool_choice of [undefined, { type: 'any' }, { type: 'tool', name: 'vision_wait' }]) {
          const body = { model, tools: provider._convertTools(tools), ...(tool_choice ? { tool_choice } : {}) };
          const options = { extraBody: { thinking: { type: 'enabled', budget_tokens: 1024 } } };
          const baseline = provider._prepareRequestBody(body, options, stream);
          const limited = provider._prepareRequestBody(body, { ...options, parallelToolCalls: false }, stream);
          assert.deepEqual(limited, { ...baseline, tool_choice: { ...(baseline.tool_choice || { type: 'auto' }), disable_parallel_tool_use: true } });
          for (const parallelToolCalls of [undefined, true, null, 0, 'false']) {
            assert.deepEqual(provider._prepareRequestBody(body, { ...options, parallelToolCalls }, stream), baseline);
          }
        }
        const noTools = provider._prepareRequestBody({ model, messages: [] }, { parallelToolCalls: false }, stream);
        assert.equal(Object.hasOwn(noTools, 'tool_choice'), false);
      }
    }
  });

  for (const [label, Provider, config] of [
    ['Anthropic', AnthropicProvider, {}],
    ['Anthropic OAuth', AnthropicOAuthProvider, {}],
    ['Vertex Anthropic', VertexAnthropicProvider, { project: 'project-test', location: 'us-east5', apiKey: 'test-key' }],
  ]) {
    test(`${browser}: ${label} sends the opt-out through actual chat and streaming entry points`, async (t) => {
      const requests = [];
      t.mock.method(globalThis, 'fetch', async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return anthropicResponse(body.stream === true);
      });
      const provider = new Provider({ ...config, model: 'claude-sonnet-4-5' });
      if (label === 'Anthropic OAuth') provider._ensureFreshToken = async () => { provider._accessToken = 'test-token'; };
      for (const stream of [false, true]) {
        for (const parallelToolCalls of [undefined, false]) {
          for (const toolChoice of [undefined, 'required', namedChoice]) {
            const options = { tools, toolChoice, parallelToolCalls };
            if (stream) {
              const chunks = [];
              for await (const chunk of provider.chatStream(messages, options)) chunks.push(chunk);
              assert.ok(chunks.some(chunk => chunk.type === 'text' && chunk.content === 'Ready.'));
            } else {
              assert.equal((await provider.chat(messages, options)).content, 'Ready.');
            }
            const body = requests.at(-1);
            assert.equal(body.tools.length, 2);
            assert.equal(body.messages[0].content[1].type, 'image');
            const choice = provider._convertToolChoice(toolChoice);
            assert.deepEqual(body.tool_choice, parallelToolCalls === false
              ? { ...(choice || { type: 'auto' }), disable_parallel_tool_use: true }
              : choice);
            assert.equal(Object.hasOwn(body, 'parallel_tool_calls'), false);
          }
        }
      }
      assert.equal(requests.length, 12);
    });
  }
}
