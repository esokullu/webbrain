import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const api = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: { getURL: path => `chrome-extension://test/${path}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example' }) },
};
globalThis.chrome = globalThis.browser = api;

const fal = { apiKey: 'synthetic-key', model: 'fal-ai/flux/schnell' };
const workflow = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } };
const configurations = [
  undefined, {}, { ...fal, apiKey: '' }, { ...fal, provider: 'unknown' },
  { provider: 'comfyui', workflow: {} },
  fal, { ...fal, provider: 'openrouter' },
  { ...fal, provider: 'comfyrouter', model: 'bfl/flux-2-pro' },
  { provider: 'comfyui', workflow },
];

function makeAgent(Agent, overrides = {}) {
  const provider = { promptTier: 'full', supportsTools: true, supportsVision: false, contextWindow: 128000, ...overrides };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._startTraceRun = async () => null;
  agent._endTraceRun = async () => {};
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  agent._manageContext = async () => {};
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => 'https://example.com/';
  agent._beginReadCompleteness = async () => null;
  return agent;
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const tools = await import(`../src/${build}/src/agent/tools.js`);
  const planner = await import(`../src/${build}/src/agent/planner.js`);
  const { GENERATIVE_MEDIA_SETUP_NOTE, GENERATIVE_MEDIA_TIER_NOTE } = await import(`../src/${build}/src/agent/media-config.js`);

  test(`${build}: media tools and planner routing require valid settings and the Full tier`, () => {
    const agent = makeAgent(Agent);
    assert.equal(agent.imageGenConfigured, false);
    assert.equal(tools.getToolsForMode('act').some(tool => tool.function.name === 'generate_image'), false);
    for (const [index, config] of configurations.entries()) {
      agent.setImageGenConfig(config);
      const configured = index >= 5;
      assert.equal(agent.imageGenConfigured, configured);
      for (const mode of ['ask', 'act', 'dev']) for (const tier of ['compact', 'mid', 'full']) {
        const opts = { tier, imageGenConfigured: agent.imageGenConfigured };
        assert.equal(tools.getToolsForMode(mode, opts).some(tool => tool.function.name === 'generate_image'),
          configured && mode !== 'ask' && tier === 'full', `${index}: ${mode}/${tier}`);
      }
      for (const tier of ['compact', 'mid', 'full']) {
        const opts = { tier, imageGenConfigured: agent.imageGenConfigured };
        const prompt = planner.buildPlannerMessages('Generate an image', 'https://example.com/', '', '', opts)[0].content;
        assert.equal(prompt.includes('generate_image'), configured && tier === 'full');
        if (!configured) assert.ok(prompt.includes(GENERATIVE_MEDIA_SETUP_NOTE));
        else if (tier !== 'full') assert.ok(prompt.includes(GENERATIVE_MEDIA_TIER_NOTE));
        const intent = planner.buildPlannerIntentMessages('Generate an image', '', '', '', opts)[0].content;
        assert.equal(intent.includes(GENERATIVE_MEDIA_SETUP_NOTE), !configured);
      }
    }
  });

  test(`${build}: saving, invalidating, and clearing media settings refresh existing prompts without losing history`, () => {
    const agent = makeAgent(Agent);
    const messages = agent.getConversation(11, 'act');
    const history = { role: 'user', content: 'Earlier task' };
    messages.push(history);
    const ask = agent.getConversation(12, 'ask');
    for (const [config, available] of [[fal, true], [{ ...fal, model: '' }, false], [fal, true], [undefined, false]]) {
      agent.setImageGenConfig(config);
      assert.equal(messages[0].content.includes('generate_image'), available);
      assert.equal(messages[0].content.includes(GENERATIVE_MEDIA_SETUP_NOTE), !available);
      assert.equal(messages[1], history);
      assert.equal(ask[0].content.includes('generate_image'), false);
    }
  });

  test(`${build}: background hydration hides media until storage resolves and fails closed on read errors`, async () => {
    const agent = makeAgent(Agent);
    const source = await readFile(`src/${build}/src/background.js`, 'utf8');
    const start = source.indexOf('async function loadImageGenConfig()');
    const end = source.indexOf('\nconst imageGenConfigReady', start);
    assert.ok(start >= 0 && end > start);
    let resolveRead;
    const storageApi = { storage: { local: { get: () => new Promise(resolve => { resolveRead = resolve; }) } } };
    const load = new Function('chrome', 'browser', 'agent', 'IMAGE_GEN_MODEL_KEY', `return (${source.slice(start, end)});`)(
      storageApi, storageApi, agent, 'imageGenModel',
    );
    const loading = load();
    assert.equal(agent.imageGenConfigured, false);
    resolveRead({ imageGenModel: fal });
    await loading;
    assert.equal(agent.imageGenConfigured, true);
    storageApi.storage.local.get = async () => { throw new Error('Unavailable'); };
    await load();
    assert.equal(agent.imageGenConfigured, false);
  });

  test(`${build}: the background settings listener applies local saves and clears to live conversations`, async () => {
    const agent = makeAgent(Agent);
    const messages = agent.getConversation(13, 'act');
    const source = await readFile(`src/${build}/src/background.js`, 'utf8');
    const start = source.indexOf(`${build === 'chrome' ? 'chrome' : 'browser'}.storage.onChanged.addListener((changes, areaName)`);
    const end = source.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start);
    let listener;
    const storageApi = { storage: { onChanged: { addListener: callback => { listener = callback; } } } };
    runInNewContext(source.slice(start, end + 4), {
      chrome: storageApi, browser: storageApi, agent, IMAGE_GEN_MODEL_KEY: 'imageGenModel',
      PDF_VIEWER_ENABLED_KEY: 'pdfViewerEnabled', PROFILE_SYNC_DATA_KEYS: [], CAPTCHA_SETTINGS_KEYS: [],
      ALWAYS_ALLOW_API_MUTATIONS_KEY: 'alwaysAllowApiMutations', API_MUTATION_OBSERVER_KEY: 'apiMutationObserver',
      USER_MEMORY_ENABLED_KEY: 'userMemoryEnabled', USER_MEMORY_MAX_PROMPT_CHARS_KEY: 'userMemoryMaxPromptChars',
      USER_MEMORY_STORAGE_KEY: 'userMemory', CUSTOM_SKILLS_STORAGE_KEY: 'customSkills',
      shouldClearUserMemoryExtractionQueueForChanges: () => false,
    });
    listener({ imageGenModel: { newValue: fal } }, 'sync');
    assert.equal(agent.imageGenConfigured, false, 'Ignore other storage areas');
    listener({ imageGenModel: { newValue: fal } }, 'local');
    assert.equal(agent.imageGenConfigured, true);
    assert.ok(messages[0].content.includes('generate_image'));
    listener({ imageGenModel: { oldValue: fal } }, 'local');
    assert.equal(agent.imageGenConfigured, false);
    assert.ok(messages[0].content.includes(GENERATIVE_MEDIA_SETUP_NOTE));
  });

  test(`${build}: actual planner and intent requests receive current media availability`, async () => {
    const provider = { promptTier: 'full' };
    const agent = makeAgent(Agent, provider);
    agent._checkAbort = () => true;
    let captured;
    agent._chatWithCostAllowance = async (_provider, messages) => {
      captured = messages[0].content;
      throw new Error('Cancel after observing the request');
    };
    for (const method of ['_runPlannerGate', '_runPlannerIntentGate']) {
      for (const [config, available] of [[undefined, false], [fal, true], [undefined, false]]) {
        agent.setImageGenConfig(config);
        captured = null;
        await agent[method](15, { role: 'user', content: 'Generate an image' }, () => {}, null);
        assert.ok(captured, 'A planner request must be observed');
        assert.equal(captured.includes(GENERATIVE_MEDIA_SETUP_NOTE), !available);
        if (method === '_runPlannerGate') assert.equal(captured.includes('generate_image'), available);
      }
    }
  });

  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'streaming' : 'ordinary'} Act requests track configured and cleared media settings`, async () => {
      let captured;
      let agent;
      const capture = (messages, options) => {
        captured = { prompt: messages[0].content, tools: options.tools };
        agent.abort(14);
      };
      agent = makeAgent(Agent, {
        chat: async (messages, options) => { capture(messages, options); return { content: 'Cancelled' }; },
        async *chatStream(messages, options) { capture(messages, options); yield { type: 'done' }; },
      });
      agent._maybeRunPlannerGate = async () => ({ proceed: true });
      for (const [config, available] of [[undefined, false], [fal, true], [undefined, false]]) {
        agent.setImageGenConfig(config);
        captured = null;
        if (streaming) await agent.processMessageStream(14, 'Generate an image', () => {}, 'act', { askStreamingEnabled: false });
        else await agent.processMessage(14, 'Generate an image', () => {}, 'act', [], { askStreamingEnabled: false });
        assert.ok(captured, 'A model request must be observed');
        assert.equal(captured.prompt.includes('generate_image'), available);
        assert.equal(captured.tools.some(tool => tool.function.name === 'generate_image'), available);
      }
    });
  }
}
