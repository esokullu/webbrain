import assert from 'node:assert/strict';
import test from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: 'https://example.com/', title: 'Example' }),
    query: async () => [{ id: 7, url: 'https://example.com/', title: 'Example' }],
    update: async () => {},
    sendMessage: async () => ({}),
  },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const promiseOnly = "I'll navigate to YouTube and search for browser automation.\n```javascript\nnavigate({url: \"https://www.youtube.com/results?search_query=browser+automation\"})\n```";
const tool = (name, args) => ({
  content: null,
  toolCalls: [{ id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }],
});

for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  function harness(responses, validateRequest = () => {}) {
    const requests = [], dispatched = [];
    const provider = {
      name: 'test', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false,
      chat: async (messages, options) => {
        requests.push({ messages: structuredClone(messages), options });
        validateRequest(messages, options);
        assert.ok(responses.length, 'Unexpected extra model request');
        return responses.shift();
      },
    };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent.planBeforeAct = true;
    agent.planBeforeActMode = 'try';
    agent.maxSteps = 6;
    agent._skipPermissionGate = true;
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
    agent._maybeReinjectAdapter = async () => {};
    agent._ensureProgressSessionForCurrentTask = async () => ({ mode: 'inactive' });
    agent.executeTool = async (_tab, name, args) => {
      dispatched.push(name);
      return name === 'done'
        ? { done: true, summary: args.summary, outcome: args.outcome }
        : { success: true, text: 'Observed video titles and URLs on the page.', url: 'https://example.com/' };
    };
    const controller = createCloudRunController({ chromeApi: api, agent, ensureOffscreen: async () => {} });
    return { agent, provider, controller, requests, dispatched };
  }
  async function finish(controller, run) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await controller.status({ runId: run.runId });
      if (!['running', 'aborting'].includes(snapshot.status)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Cloud run did not finish');
  }

  test(`${browser}: Cloud Act rejects Qwen's prose tool promise and stops after bounded recovery`, async () => {
    const h = harness([{ content: promiseOnly, toolCalls: [] }, { content: promiseOnly, toolCalls: [] }]);
    const run = await h.controller.startRun({ task: 'Read the current page and return observed video URLs.', mode: 'act' });
    const snapshot = await finish(h.controller, run);
    assert.equal(snapshot.status, 'failed');
    assert.match(snapshot.error, /plan_only_output/);
    assert.doesNotMatch(snapshot.result, /I'll navigate|```javascript/);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.dispatched, []);
    assert.ok(h.requests[1].messages.some(message => String(message.content || '').startsWith('[PLAN EXECUTION BLOCK')));
    assert.ok(h.requests.every(request => request.options.tools.some(item => item.function.name === 'navigate')),
      'Cloud still bypasses the planner and exposes the Act tool surface');
  });

  test(`${browser}: Cloud Act recovers into real read evidence and explicit done`, async () => {
    const h = harness([
      { content: promiseOnly, toolCalls: [] },
      tool('read_page', {}),
      tool('done', { summary: 'Observed video: https://www.youtube.com/watch?v=verified123', outcome: 'success' }),
    ]);
    const run = await h.controller.startRun({ task: 'Read the current page and return observed video URLs.', mode: 'act' });
    const snapshot = await finish(h.controller, run);
    assert.equal(snapshot.status, 'completed');
    assert.match(snapshot.result, /watch\?v=verified123/);
    assert.deepEqual(h.dispatched, ['read_page', 'done']);
    assert.equal(h.requests.length, 3);
  });

  test(`${browser}: Cloud Act cannot complete with done success before any tool evidence`, async () => {
    const h = harness([
      tool('done', { summary: 'Videos found.', outcome: 'success' }),
      tool('done', { summary: 'Videos found.', outcome: 'success' }),
    ]);
    const run = await h.controller.startRun({ task: 'Read the current page and return observed video URLs.', mode: 'act' });
    const snapshot = await finish(h.controller, run);
    assert.equal(snapshot.status, 'failed');
    assert.equal(h.requests.length, 2);
    assert.ok(snapshot.updates.some(update => update.type === 'tool_result' && update.data?.result?.blockedDone));
  });

  test(`${browser}: Cloud Ask keeps valid plain read answers and bypasses the planner`, async () => {
    const h = harness([{ content: 'The page is an example domain.', toolCalls: [] }]);
    const run = await h.controller.startRun({ task: 'Summarize the supplied page.', mode: 'ask' });
    const snapshot = await finish(h.controller, run);
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.result, 'The page is an example domain.');
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.dispatched, []);
  });

  test(`${browser}: rejected raw navigate arguments cannot poison the serialized recovery request`, async () => {
    const malformed = { id: 'rejected-navigate', type: 'function', function: { name: 'navigate', arguments: 'https://example.com' } };
    const transport = new OpenAICompatibleProvider({ baseUrl: 'https://api.demonroute.com/v1', model: 'huihui-ai/Huihui-Qwen3.5-27B-abliterated' });
    const serialized = [];
    const h = harness([
      { content: null, toolCalls: [malformed] },
      tool('navigate', { url: 'https://example.com/' }),
      tool('read_page', {}),
      tool('done', { summary: 'Verified Example Domain at https://example.com/.', outcome: 'success' }),
    ], (messages, options) => {
      const body = JSON.parse(JSON.stringify(transport._buildChatCompletionsBody(messages, options)));
      for (const message of body.messages) for (const call of message.tool_calls || []) JSON.parse(call.function.arguments);
      serialized.push(body);
    });
    h.agent._gateSettingLoaded = true;
    h.agent._shouldAutoScreenshot = () => false;
    h.agent._observeCaptchaChallenge = async () => ({ gate: null, loopCheck: { kind: 'none' } });
    h.provider.model = transport.model;
    h.provider.baseUrl = transport.baseUrl;
    const run = await h.controller.startRun({ task: 'Open https://example.com and report the page title. Read only.', mode: 'act' });
    const snapshot = await finish(h.controller, run);
    assert.equal(snapshot.status, 'completed', snapshot.error || JSON.stringify(snapshot.pendingInput));
    assert.deepEqual(h.dispatched, ['navigate', 'read_page', 'done'], 'Rejected navigate must never be dispatched');
    assert.equal(h.requests.length, 4);
    assert.equal(malformed.function.arguments, 'https://example.com', 'Original provider call remains diagnostic evidence');
    const recovery = serialized[1].messages;
    assert.deepEqual(serialized[1].tool_choice, { type: 'function', function: { name: 'navigate' } });
    assert.ok(serialized.slice(2).every(body => body.tool_choice?.function?.name !== 'navigate'), 'Named repair is used for one model turn only');
    const rejected = recovery.find(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === malformed.id));
    assert.deepEqual(rejected.tool_calls[0], { ...malformed, function: { ...malformed.function, arguments: '{}' } });
    const feedback = JSON.parse(recovery.find(message => message.tool_call_id === malformed.id).content);
    assert.equal(feedback.invalidToolArguments, true);
    assert.equal(feedback.noDispatch, true);
    assert.equal(feedback.dispatched, false);
    assert.equal(feedback.rawPreview, 'https://example.com');
    assert.match(feedback.error, /Re-emit.*valid JSON object/);
    assert.match(snapshot.result, /Example Domain/);
  });
}
