import assert from 'node:assert/strict';
import { test } from 'node:test';

const api = {
  runtime: { getURL: value => `chrome-extension://owned/${value}` },
  storage: { local: { async get() { return {}; }, async set() {} }, session: { async get() { return {}; }, async set() {} } },
  tabs: { async update() {}, async get(id) { return { id, url: 'https://owned.example/' }; } },
  webNavigation: { async getAllFrames() { return [{ url: 'https://owned.example/' }]; } },
};
globalThis.chrome = api; globalThis.browser = api;
const variants = await Promise.all(['chrome', 'firefox'].map(async browser => [browser,
  await import(`../src/${browser}/src/agent/vision-act.js`)]));
const IMAGE = 'data:image/jpeg;base64,b3duZWQtdmlzdWFsLXRlc3Q=';
const viewport = { width: 1200, height: 800, devicePixelRatio: 2, url: 'https://owned.example/', documentId: 'document-1' };
const call = (name, args, id = 'owned-call') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function latestFrame(request) {
  return request.at(-1).content.filter(block => block.type === 'text').flatMap(block => {
    try { const value = JSON.parse(block.text); return value.frameId ? [value] : []; } catch { return []; }
  }).at(-1);
}

function setup(module, script, overrides = {}) {
  const controller = new AbortController(), events = [], order = [], requests = [], actions = [], history = [{ role: 'system', content: 'old legacy prompt' }];
  const provider = { name: 'owned model', model: 'owned-vision', supportsVision: true, supportsTools: true, ...overrides.provider };
  let count = 0, changed = false, pendingCorrection = '', activeFrames;
  const agent = {
    actObservation: 'vision', maxSteps: 5, currentCostState: new Map(),
    providerManager: { async prepareActiveProviderCapabilities() { order.push('capabilities'); } },
    permissions: { beginTurn() {}, async hydrate() {}, check() { return { allowed: true, needsPrompt: false }; }, async record() {} },
    _skipPermissionGate: true,
    _isStandaloneChatRun: options => options?.standaloneChat === true,
    _runAbortSignal: () => controller.signal,
    _throwIfAborted: signal => signal?.throwIfAborted(),
    _checkAbort: () => controller.signal.aborted,
    _activeProvider: () => provider,
    getConversation: () => history,
    _newCostRunState: () => ({}),
    async _persistSubmittedTurn() {}, async _persistNow() { return { ok: true }; },
    async _startTraceRun() { return null; }, async _endTraceRun() {},
    async _ensureGateSetting() {},
    _hasPendingSteering: () => !!pendingCorrection,
    _applyPendingSteering(_tabId, messages) {
      if (!pendingCorrection) return false;
      messages.push({ role: 'user', content: pendingCorrection }); pendingCorrection = ''; return true;
    },
    _withResponseItems: message => message,
    _createVisionFrameSession() {
      let latest = null, sequence = 0, retained = [];
      activeFrames = {
        get latest() { return latest; },
        async capture(_dataUrl, captureViewport, options = {}) {
          order.push('encode');
          const kind = !latest || options.forceFull ? 'full' : changed ? 'delta' : 'unchanged';
          changed = false;
          const id = `frame-${++sequence}`;
          latest = { protocol: 'vision-frame-v1', frameId: id, baseFrameId: kind === 'full' ? id : retained[0].frameId,
            kind, viewport: { ...captureViewport }, canvas: { width: 1000, height: 667 },
            images: kind === 'unchanged' ? [] : [{ id: id + '-image', dataUrl: IMAGE, mimeType: 'image/jpeg',
              width: kind === 'full' ? 1000 : 80, height: kind === 'full' ? 667 : 40,
              rect: kind === 'full' ? { x: 0, y: 0, width: 1000, height: 667 } : { x: 80, y: 100, width: 80, height: 40 } }], bytes: 40, estimatedTokens: 100 };
          if (kind === 'full') retained = [latest]; else if (kind === 'delta') retained.push(latest);
          return latest;
        },
        contextFrames() { return latest?.kind === 'unchanged' ? [...retained, latest] : [...retained]; },
        assertViewport(current) { assert.equal(current.documentId, viewport.documentId); },
        reset() { latest = null; retained = []; },
      };
      return activeFrames;
    },
    _createVisionBrowser(options) {
      return {
        async capture() { order.push('capture'); return { dataUrl: IMAGE, viewport }; },
        async readViewport() { return viewport; },
        async perform(tabId, name, args) {
          await options.beforeDispatch?.(tabId, name, args);
          order.push('dispatch'); actions.push({ name, args }); changed = true;
          return { success: true, dispatched: true };
        },
      };
    },
    async _chatWithCostAllowance(_provider, messages, options) {
      order.push('model'); requests.push(structuredClone(messages));
      return script({ index: count++, messages, frame: latestFrame(messages), agent, controller,
        steer: text => { pendingCorrection = text; }, change: () => { changed = true; }, options });
    },
  };
  const run = (options = {}) => module.runVisionAct(agent, { tabId: 71, userMessage: 'Fill the owned visual field.',
    onUpdate: (type, data) => events.push({ type, data }), runOptions: {}, ...options });
  return { agent, provider, controller, events, order, requests, actions, history, run, get frames() { return activeFrames; } };
}

for (const [browser, module] of variants) {
  test(`${browser}: capture recovery retries only transient observations and respects cancellation`, async () => {
    const waits = [], failures = [];
    let count = 0;
    const captured = await module.captureVisionObservation({ async capture() {
      if (++count < 3) throw Object.assign(new Error('Document replaced'), { code: 'vision_capture_context_changed' });
      return { dataUrl: IMAGE, viewport };
    } }, 71, { wait: async delay => { waits.push(delay); }, onFailure: (error, detail) => failures.push(detail) });
    assert.equal(count, 3); assert.equal(captured.attempts, 3);
    assert.deepEqual(waits, [150, 300]); assert.ok(failures.every(item => item.retry));
    for (const code of ['vision_privacy_failed', 'vision_capture_clipped', 'vision_capture_failed']) {
      count = 0;
      await assert.rejects(module.captureVisionObservation({ async capture() {
        count++; throw Object.assign(new Error('Permanent capture failure'), { code });
      } }, 71, { wait: async () => assert.fail('Permanent errors cannot retry') }), error => error.code === code);
      assert.equal(count, 1);
    }
    count = 0;
    await assert.rejects(module.captureVisionObservation({ async capture() {
      count++; throw Object.assign(new Error('Still loading'), { code: 'vision_capture_not_ready' });
    } }, 71, { wait: async () => {} }), /Still loading/);
    assert.equal(count, 8, 'Transient observation recovery is finite');
    const controller = new AbortController(); count = 0;
    await assert.rejects(module.captureVisionObservation({ async capture() {
      count++; throw Object.assign(new Error('Page changed'), { code: 'vision_stale_frame' });
    } }, 71, { signal: controller.signal, wait: async () => controller.abort() }), error => error.name === 'AbortError');
    assert.equal(count, 1, 'Stop interrupts recovery before another capture');
  });

  test(`${browser}: batched navigation and wait recover capture races without replay and use a fresh frame for the next action`, async () => {
    let navigations = 0, failedCaptures = 0;
    const originalUpdate = api.tabs.update;
    api.tabs.update = async () => { navigations++; };
    const fixture = setup(module, ({ index, frame, options, messages }) => {
      assert.equal(options.parallelToolCalls, false, 'The model request must explicitly disable parallel tool calls');
      if (index === 0) return { toolCalls: [call('vision_navigate', { url: 'https://owned.example/next' }, 'navigate-once'),
        call('vision_wait', { milliseconds: 3000 }, 'deferred-wait')] };
      if (index === 1) {
        const receipts = messages.filter(message => message.role === 'tool');
        assert.deepEqual(receipts.map(message => message.tool_call_id), ['navigate-once', 'deferred-wait']);
        assert.equal(JSON.parse(receipts[0].content).navigated, true);
        assert.deepEqual(Object.fromEntries(Object.entries(JSON.parse(receipts[1].content))
          .filter(([key]) => ['success', 'code', 'noDispatch', 'dispatched', 'outcomeUnknown'].includes(key))),
        { success: false, code: 'vision_batch_deferred', noDispatch: true, dispatched: false, outcomeUnknown: false });
        return { toolCalls: [call('vision_click', { frameId: frame.frameId, x: 30, y: 40 }, 'fresh-click')] };
      }
      return { toolCalls: [call('done', { frameId: frame.frameId, summary: 'Navigation recovered once.', outcome: 'success' })] };
    });
    const create = fixture.agent._createVisionBrowser;
    fixture.agent._createVisionBrowser = options => {
      const instance = create(options), capture = instance.capture;
      instance.capture = async () => {
        if (navigations && failedCaptures++ < 2)
          throw Object.assign(new Error('Page changed during screenshot capture; capture again'), { code: 'vision_stale_frame' });
        return capture();
      };
      return instance;
    };
    try {
      assert.equal(await fixture.run(), 'Navigation recovered once.');
      assert.equal(navigations, 1); assert.equal(fixture.requests.length, 3);
      assert.equal(fixture.actions.length, 1);
      assert.equal(fixture.actions[0].name, 'click');
      assert.equal(fixture.actions[0].args.frameId, latestFrame(fixture.requests[1]).frameId);
      assert.notEqual(fixture.actions[0].args.frameId, latestFrame(fixture.requests[0]).frameId);
      assert.equal(fixture.events.filter(event => event.type === 'tool_result' && event.data.name === 'vision_navigate').length, 1);
      assert.equal(fixture.events.filter(event => event.type === 'tool_call' && event.data.name === 'vision_wait').length, 0);
      assert.equal(latestFrame(fixture.requests[1]).kind, 'full');
    } finally { api.tabs.update = originalUpdate; }
  });

  test(`${browser}: a permanent capture failure after navigation retains the receipt and stops without replay`, async () => {
    let navigations = 0, failedCaptures = 0, status;
    const originalUpdate = api.tabs.update;
    api.tabs.update = async () => { navigations++; };
    const fixture = setup(module, () => ({ toolCalls: [call('vision_navigate', { url: 'https://owned.example/next' })] }));
    const create = fixture.agent._createVisionBrowser;
    fixture.agent._createVisionBrowser = options => {
      const instance = create(options), capture = instance.capture;
      instance.capture = async () => {
        if (navigations) { failedCaptures++; throw Object.assign(new Error('Privacy scan failed'), { code: 'vision_privacy_failed' }); }
        return capture();
      };
      return instance;
    };
    try {
      assert.match(await fixture.run({ runOptions: { onRunFinished: value => { status = value; } } }), /Privacy scan failed/);
      assert.equal(status, 'error'); assert.equal(navigations, 1); assert.equal(failedCaptures, 1);
      assert.equal(fixture.requests.length, 1);
      assert.ok(fixture.history.some(message => message.role === 'tool' && JSON.parse(message.content).navigated === true));
    } finally { api.tabs.update = originalUpdate; }
  });

  test(`${browser}: Act and Dev share visual routing and honor the compatibility override`, () => {
    const agent = { actObservation: 'vision', _isStandaloneChatRun: options => options?.standaloneChat === true };
    assert.equal(module.useVisionAct(agent, 'act'), true);
    assert.equal(module.useVisionAct(agent, 'dev'), true);
    for (const mode of ['ask', 'auto']) assert.equal(module.useVisionAct(agent, mode), false);
    for (const mode of ['act', 'dev']) {
      assert.equal(module.useVisionAct(agent, mode, { actObservation: 'accessibility' }), false);
      assert.equal(module.useVisionAct(agent, mode, { standaloneChat: true }), false);
    }
  });

  for (const mode of ['act', 'dev']) test(`${browser}: ${mode} diagnostic tools stay bounded, direct, and separate from pointer or legacy execution`, async () => {
    const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
    const methodNames = ['enableDevDiagnostics', 'readConsole', 'inspectNetworkRequests'];
    const originals = Object.fromEntries(methodNames.map(name => [name, cdpClient[name]]));
    const backendCalls = [];
    cdpClient.enableDevDiagnostics = async tabId => { backendCalls.push({ name: 'enable', tabId }); };
    cdpClient.readConsole = async (tabId, options) => {
      backendCalls.push({ name: 'console', tabId, options });
      return { success: true, entries: Array.from({ length: 60 }, (_, index) => ({
        level: 'error', text: `Console ${index}: ${'x'.repeat(4000)}`, timestamp: index,
        privateObject: { body: 'SHOULD_NOT_ESCAPE' },
      })) };
    };
    cdpClient.inspectNetworkRequests = async (tabId, options) => {
      backendCalls.push({ name: 'network', tabId, options });
      return { success: true, requests: Array.from({ length: 60 }, (_, index) => ({
        requestId: String(index), url: `https://owned.example/api/${index}`, method: 'GET', status: 500,
        requestHeaders: { Authorization: 'SHOULD_NOT_ESCAPE' }, responseBody: 'SHOULD_NOT_ESCAPE',
      })) };
    };
    const diagnosticNames = ['inspect_network_requests', 'read_console'];
    const baseNames = module.VISION_ACT_TOOLS.map(tool => tool.function.name);
    const fixture = setup(module, ({ index, frame, options }) => {
      const names = options.tools.map(tool => tool.function.name);
      assert.deepEqual(names.filter(name => !baseNames.includes(name)).sort(), mode === 'dev' ? diagnosticNames : []);
      if (index === 0) return { toolCalls: [call('read_console', { levels: ['error'], limit: 2 }, 'console-read')] };
      if (index === 1) return { toolCalls: [call('inspect_network_requests', { methods: ['GET'], statusMin: 400, limit: 2 }, 'network-read')] };
      return { toolCalls: [call('done', { frameId: frame.frameId, summary: 'Diagnostics checked without page input.', outcome: 'success' })] };
    });
    fixture.agent.executeTool = () => assert.fail('Visual diagnostics cannot enter the legacy tool executor');
    try {
      assert.equal(await fixture.run({ mode, userMessage: 'Debug console errors and failed network requests.', runOptions: {
        beforeConsequentialTool: () => assert.fail('Diagnostic reads cannot enter the mutation checkpoint'),
      } }), 'Diagnostics checked without page input.');
      assert.equal(fixture.actions.length, 0);
      assert.equal(fixture.requests.length, 3);
      assert.equal(new Set(fixture.requests.map(request => latestFrame(request).frameId)).size, 3,
        'Every diagnostic request is followed by a fresh screenshot observation');
      const results = fixture.events.filter(event => event.type === 'tool_result' && diagnosticNames.includes(event.data.name))
        .map(event => event.data.result);
      assert.equal(results.length, 2);
      if (mode === 'act') {
        assert.deepEqual(backendCalls, []);
        for (const result of results) { assert.equal(result.success, false); assert.match(result.error, /unavailable tool/i); }
      } else if (browser === 'firefox') {
        assert.deepEqual(backendCalls, [], 'Firefox must not call a Chrome or DOM fallback');
        for (const result of results) {
          assert.equal(result.success, false); assert.equal(result.available, false); assert.equal(result.noDispatch, true);
          assert.match(result.error, /unavailable in this Firefox build/);
        }
      } else {
        assert.deepEqual(backendCalls.map(call => call.name), ['enable', 'console', 'network']);
        assert.ok(backendCalls.every(call => call.tabId === 71));
        assert.deepEqual(backendCalls[1].options, { levels: ['error'], limit: 2 });
        assert.deepEqual(backendCalls[2].options, { methods: ['GET'], statusMin: 400, limit: 2,
          includeHeaders: false, includeBodies: false });
        for (const result of results) {
          assert.equal(result.success, true); assert.equal(result.truncated, true); assert.ok(result.count <= 40);
          assert.ok(JSON.stringify(result).length <= 12000); assert.match(result.note, /untrusted/i);
          assert.ok(!JSON.stringify(result).includes('SHOULD_NOT_ESCAPE'));
        }
        assert.ok(results[0].entries.every(entry => entry.text.length <= 2000));
        assert.equal(results[1].includesHeaders, false); assert.equal(results[1].includesBodies, false);
      }
    } finally { for (const [name, original] of Object.entries(originals)) cdpClient[name] = original; }
  });

  test(`${browser}: first and follow-up requests capture before inference, act using newest frames and persist no screenshots`, async () => {
    const fixture = setup(module, ({ index, frame }) => ({ toolCalls: [index % 2 === 0
      ? call('vision_click', { frameId: frame.frameId, x: 140, y: 180 })
      : call('done', { frameId: frame.frameId, summary: 'Visually verified.', outcome: 'success' })] }));
    assert.equal(await fixture.run(), 'Visually verified.');
    assert.equal(fixture.actions.length, 1);
    assert.ok(fixture.order.indexOf('capture') < fixture.order.indexOf('model'));
    assert.ok(fixture.requests.every(request => request.at(-1).content.some(block => block.type === 'image_url')));
    assert.equal(latestFrame(fixture.requests[1]).kind, 'delta');
    assert.ok(!JSON.stringify(fixture.history).includes('data:image/'));
    assert.equal(fixture.frames.latest, null, 'Images are discarded at the run boundary');
    const before = fixture.order.length;
    assert.equal(await fixture.run({ userMessage: 'Continue the visual task.' }), 'Visually verified.');
    assert.ok(fixture.order.slice(before).indexOf('capture') < fixture.order.slice(before).indexOf('model'));
    assert.ok(fixture.requests[2].some(message => message.content === 'Visually verified.'));
    assert.equal(latestFrame(fixture.requests[2]).kind, 'full', 'Follow-up runs start from a fresh full frame');
  });

  test(`${browser}: text-only providers fail clearly before browser capture or inference`, async () => {
    const fixture = setup(module, () => assert.fail('Unsupported providers must not be called'), { provider: { supportsVision: false } });
    let status;
    assert.match(await fixture.run({ runOptions: { onRunFinished: value => { status = value; } } }), /requires.*image input/i);
    assert.equal(status, 'error'); assert.ok(!fixture.order.includes('capture'));
    assert.equal(fixture.actions.length, 0);
  });

  test(`${browser}: failure to save the action checkpoint prevents native dispatch`, async () => {
    const fixture = setup(module, ({ frame }) => ({ toolCalls: [call('vision_click', {
      frameId: frame.frameId, x: 30, y: 40,
    })] }));
    fixture.agent._persistNow = async () => ({ ok: false });
    await assert.rejects(fixture.run(), /checkpoint/);
    assert.equal(fixture.actions.length, 0);
    assert.ok(fixture.history.some(message => message.role === 'tool'
      && JSON.parse(message.content).success === false), 'Failed action intent must retain a failure receipt');
  });

  test(`${browser}: a rejected consequential checkpoint stops the run before native input`, async () => {
    const fixture = setup(module, ({ frame }) => ({ toolCalls: [call('vision_click', {
      frameId: frame.frameId, x: 30, y: 40,
    })] }));
    let before = 0, after = 0, status;
    const result = await fixture.run({ runOptions: {
      beforeConsequentialTool: async () => { before++; return false; },
      afterConsequentialTool: async () => { after++; },
      onRunFinished: value => { status = value; },
    } });
    assert.match(result, /checkpoint.*could not be saved/i);
    assert.equal(before, 1); assert.equal(after, 0); assert.equal(status, 'persistence_degraded');
    assert.equal(fixture.actions.length, 0); assert.equal(fixture.requests.length, 1);
    const receipt = fixture.events.find(event => event.type === 'tool_result').data.result;
    assert.equal(receipt.noDispatch, true); assert.equal(receipt.outcomeUnknown, false);
  });

  test(`${browser}: consequential hooks bracket native dispatch and settle a known result`, async () => {
    const fixture = setup(module, ({ index, frame }) => ({ toolCalls: [index
      ? call('done', { frameId: frame.frameId, summary: 'Durable action.', outcome: 'success' })
      : call('vision_click', { frameId: frame.frameId, x: 30, y: 40 })] }));
    assert.equal(await fixture.run({ runOptions: {
      beforeConsequentialTool: async ({ name }) => { assert.equal(name, 'vision_click'); fixture.order.push('before'); return { ok: true }; },
      afterConsequentialTool: async ({ name, outcomeUnknown }) => {
        assert.equal(name, 'vision_click'); assert.equal(outcomeUnknown, false); fixture.order.push('after');
      },
    } }), 'Durable action.');
    assert.ok(fixture.order.indexOf('before') < fixture.order.indexOf('dispatch'));
    assert.ok(fixture.order.indexOf('dispatch') < fixture.order.indexOf('after'));
  });

  test(`${browser}: uncertain native delivery cannot settle a consequential receipt`, async () => {
    const fixture = setup(module, ({ index, frame }) => ({ toolCalls: [index
      ? call('done', { frameId: frame.frameId, summary: 'Delivery uncertain; not repeated.', outcome: 'blocked' })
      : call('vision_click', { frameId: frame.frameId, x: 30, y: 40 })] }));
    const originalFactory = fixture.agent._createVisionBrowser;
    fixture.agent._createVisionBrowser = options => {
      const browser = originalFactory(options), perform = browser.perform;
      browser.perform = async (...args) => {
        await perform(...args);
        return { success: false, dispatched: true, outcomeUnknown: true, error: 'Native input reply was lost' };
      };
      return browser;
    };
    let after = 0;
    assert.equal(await fixture.run({ runOptions: {
      beforeConsequentialTool: async () => true,
      afterConsequentialTool: async () => { after++; },
    } }), 'Delivery uncertain; not repeated.');
    assert.equal(fixture.actions.length, 1); assert.equal(after, 0);
    assert.ok(fixture.history.some(message => message.role === 'tool'
      && JSON.parse(message.content).outcomeUnknown === true));
  });

  for (const mode of ['act', 'dev']) for (const streaming of [false, true]) test(`${browser}: public ${streaming ? 'streaming' : 'nonstreaming'} ${mode} entry skips the AX page monitor`, async () => {
    const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
    const transport = await import(`../src/${browser}/src/${browser === 'chrome' ? 'cdp/cdp-client' : 'bidi/client'}.js`);
    const cdpClient = transport.cdpClient || transport.firefoxBidi;
    const names = browser === 'chrome' ? ['startDialogHandling', 'stopDialogHandling', 'cleanupRun'] : ['startRun', 'endRun'];
    const originals = Object.fromEntries(names.map(name => [name, cdpClient[name]]));
    for (const name of Object.keys(originals)) cdpClient[name] = async () => {};
    const fixture = setup(module, ({ frame }) => ({ toolCalls: [call('done', {
      frameId: frame.frameId, summary: 'Public visual route verified.', outcome: 'success',
    })] }));
    const providerManager = { getActive: () => fixture.provider, getProvider: () => fixture.provider,
      prepareActiveProviderCapabilities: async () => {} };
    const agent = new Agent(providerManager);
    agent.actObservation = 'vision';
    for (const name of ['getConversation', '_newCostRunState', '_persistSubmittedTurn', '_persistNow', '_startTraceRun',
      '_endTraceRun', '_createVisionFrameSession', '_createVisionBrowser', '_chatWithCostAllowance']) agent[name] = fixture.agent[name];
    const conversationModes = [];
    agent.getConversation = (tabId, requestedMode) => {
      conversationModes.push(requestedMode);
      return fixture.agent.getConversation(tabId, requestedMode);
    };
    agent._startTraceRun = async (_tabId, _message, traceMode) => {
      assert.equal(traceMode, mode, 'Visual execution preserves the selected mode in tracing');
      return null;
    };
    agent._hydrate = async () => {};
    agent._persist = () => {};
    agent._currentUrl = async () => viewport.url;
    agent._restoreJournaledSteering = async () => {};
    agent._beginPageFeedbackRun = async () => assert.fail('Visual Act cannot start the AX page monitor');
    agent._enrichUserMessageWithCurrentPage = async () => assert.fail('Visual Act cannot enter legacy enrichment');
    agent._beginReadCompleteness = async () => null;
    agent._restoreCapturePolicyAfterRun = async () => {};
    agent._skipPermissionGate = true;
    let status;
    const options = { detachedRequestId: 'owned-public-route', onRunFinished: value => { status = value; } };
    try {
      const result = streaming
        ? await agent.processMessageStream(71, 'Inspect the visual page.', () => {}, mode, options)
        : await agent.processMessage(71, 'Inspect the visual page.', () => {}, mode, [], options);
      assert.equal(result, 'Public visual route verified.');
      assert.equal(status, 'done'); assert.equal(agent.isRunning(71), false);
      assert.equal(fixture.requests.length, 1);
      assert.equal(latestFrame(fixture.requests[0]).kind, 'full');
      assert.equal(conversationModes.at(-1), mode, 'Visual execution preserves the selected conversation mode');
    } finally { for (const [name, original] of Object.entries(originals)) cdpClient[name] = original; }
  });

  for (const mode of ['act', 'dev']) for (const route of ['decision', 'continuation']) test(`${browser}: automatic ${route} ${mode} route stops AX monitoring before visual inference and retains routing cost`, async () => {
    const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
    const transport = await import(`../src/${browser}/src/${browser === 'chrome' ? 'cdp/cdp-client' : 'bidi/client'}.js`);
    const client = transport.cdpClient || transport.firefoxBidi;
    const names = browser === 'chrome' ? ['startDialogHandling', 'stopDialogHandling', 'cleanupRun'] : ['startRun', 'endRun'];
    const originals = Object.fromEntries(names.map(name => [name, client[name]]));
    for (const name of names) client[name] = async () => {};
    const fixture = setup(module, ({ frame }) => ({ toolCalls: [call('done', {
      frameId: frame.frameId, summary: 'Automatic visual route verified.', outcome: 'success',
    })] }), { provider: { promptTier: 'full', contextWindow: 128000 } });
    const providerManager = { getActive: () => fixture.provider, getProvider: () => fixture.provider,
      prepareActiveProviderCapabilities: async () => {} };
    const agent = new Agent(providerManager);
    agent.actObservation = 'vision';
    for (const name of ['getConversation', '_persistSubmittedTurn', '_persistNow', '_startTraceRun',
      '_endTraceRun', '_createVisionFrameSession', '_createVisionBrowser']) agent[name] = fixture.agent[name];
    for (const name of ['_hydrate', '_restoreJournaledSteering', '_beginReadCompleteness', '_restoreCapturePolicyAfterRun']) {
      agent[name] = async () => null;
    }
    agent._persist = () => {};
    agent._currentUrl = async () => viewport.url;
    agent._getTabUrlTitle = async () => ({ tabUrl: viewport.url, tabTitle: 'Automatic visual fixture' });
    agent._skipPermissionGate = true;
    let monitorActive = false, monitorStarts = 0, monitorStops = 0, newCostStates = 0, routeDecisions = 0;
    const costState = { routingCost: 0.025, usedTokens: 17 };
    agent._newCostRunState = () => { newCostStates++; return costState; };
    agent._beginPageFeedbackRun = async () => { monitorActive = true; monitorStarts++; fixture.order.push('monitor-start'); };
    agent._finishPageFeedbackRun = () => {
      if (monitorActive) { monitorStops++; fixture.order.push('monitor-stop'); }
      monitorActive = false;
    };
    agent._manageContext = async (_tabId, _messages, _onUpdate, actualCost) => assert.equal(actualCost, costState);
    agent._userTurnKind = async () => null;
    agent._enrichUserMessageWithCurrentPage = async () => ({ role: 'user', content: 'LEGACY_AX_CONTEXT_MUST_NOT_REACH_VISUAL_MODEL' });
    agent._semanticDecision = async (_tabId, kind) => {
      if (kind === 'run_mode') { routeDecisions++; return { choice: mode, source: 'owned-decision', evidence: '' }; }
      return { choice: null, source: 'unavailable' };
    };
    agent._chatWithCostAllowance = async (...args) => {
      assert.equal(monitorActive, false, 'No AX page observer may remain active when the visual model starts');
      assert.equal(agent.currentCostState.get(71), costState, 'Visual runtime must reuse the routing cost state');
      assert.equal(args[3], costState, 'Provider allowance must receive the original routing cost state');
      assert.ok(!JSON.stringify(args[1]).includes('LEGACY_AX_CONTEXT_MUST_NOT_REACH_VISUAL_MODEL'));
      const names = args[2].tools.map(tool => tool.function.name);
      assert.ok(names.includes('vision_click') && names.includes('vision_observe'));
      assert.ok(names.every(name => !/accessibility|read_page|execute_js|click_ax/.test(name)));
      return fixture.agent._chatWithCostAllowance(...args);
    };
    const events = [];
    if (route === 'continuation') agent.conversationModes.set(71, mode);
    try {
      const result = await agent.processMessage(71, 'Complete the visual task.',
        (type, data) => events.push({ type, data }), 'auto', [], {
          detachedRequestId: `owned-auto-${route}-${mode}`, ...(route === 'continuation' ? { trustedContinuation: true } : {}),
        });
      assert.equal(result, 'Automatic visual route verified.');
      assert.equal(monitorStarts, 1); assert.equal(monitorStops, 1);
      assert.ok(fixture.order.indexOf('monitor-stop') < fixture.order.indexOf('model'));
      assert.equal(newCostStates, 1, 'Routing and visual execution must share one cost state');
      assert.equal(routeDecisions, route === 'decision' ? 1 : 0);
      assert.equal(fixture.requests.length, 1); assert.equal(latestFrame(fixture.requests[0]).kind, 'full');
      assert.ok(events.some(event => event.type === 'run_mode' && event.data.mode === mode));
      assert.equal(agent.isRunning(71), false); assert.equal(agent.currentCostState.has(71), false);
    } finally { for (const [name, original] of Object.entries(originals)) client[name] = original; }
  });

  test(`${browser}: hallucinated AX tools and selector arguments never reach native input`, async () => {
    const fixture = setup(module, ({ index, frame }) => ({ toolCalls: [index === 0
      ? call('get_accessibility_tree', {}) : index === 1
        ? call('vision_click', { frameId: frame.frameId, x: 10, y: 10, selector: '#submit' })
        : call('done', { frameId: frame.frameId, summary: 'Stopped without dispatch.', outcome: 'blocked' })] }));
    assert.equal(await fixture.run(), 'Stopped without dispatch.'); assert.equal(fixture.actions.length, 0);
    assert.equal(fixture.events.filter(event => event.type === 'tool_result' && event.data.name !== 'done' && event.data.result.success === false).length, 2);
    assert.ok(module.VISION_ACT_TOOLS.every(tool => !/accessibility|read_page|execute_js|click_ax/.test(tool.function.name)));
  });

  test(`${browser}: a multi-tool response executes only its first action and pairs deferred calls before a fresh request`, async () => {
    const fixture = setup(module, ({ index, frame, messages }) => {
      if (!index) return { toolCalls: [call('vision_click', { frameId: frame.frameId, x: 10, y: 10 }, 'first'),
        call('vision_type', { frameId: frame.frameId, text: 'must not type' }, 'second')] };
      if (index === 1) {
        const tools = messages.filter(message => message.role === 'tool');
        assert.deepEqual(tools.map(message => message.tool_call_id), ['first', 'second']);
        assert.equal(JSON.parse(tools[0].content).success, true);
        const deferred = JSON.parse(tools[1].content);
        assert.equal(deferred.code, 'vision_batch_deferred'); assert.equal(deferred.noDispatch, true);
        assert.equal(deferred.dispatched, false); assert.equal(deferred.outcomeUnknown, false);
        return { toolCalls: [call('vision_type', { frameId: frame.frameId, text: 'new frame approved typing' }, 'fresh-type')] };
      }
      return { toolCalls: [call('done', { frameId: frame.frameId, summary: 'Fresh frame used after batch.', outcome: 'success' })] };
    });
    assert.equal(await fixture.run(), 'Fresh frame used after batch.');
    assert.deepEqual(fixture.actions.map(action => action.name), ['click', 'type']);
    assert.equal(fixture.actions[1].args.text, 'new frame approved typing');
    assert.notEqual(fixture.actions[0].args.frameId, fixture.actions[1].args.frameId);
    assert.equal(fixture.actions[1].args.frameId, latestFrame(fixture.requests[1]).frameId);
  });

  for (const doneFirst of [true, false]) test(`${browser}: a batch with done ${doneFirst ? 'first' : 'last'} cannot claim completion`, async () => {
    const fixture = setup(module, ({ index, frame, messages }) => {
      if (!index) {
        const premature = call('done', { frameId: frame.frameId, summary: 'Premature batch completion.', outcome: 'success' }, 'premature-done');
        const action = call('vision_click', { frameId: frame.frameId, x: 10, y: 10 }, 'batch-click');
        return { toolCalls: doneFirst ? [premature, action] : [action, premature] };
      }
      const receipts = messages.filter(message => message.role === 'tool');
      assert.deepEqual(receipts.map(message => message.tool_call_id), doneFirst ? ['premature-done', 'batch-click'] : ['batch-click', 'premature-done']);
      const doneReceipt = JSON.parse(receipts.find(message => message.tool_call_id === 'premature-done').content);
      assert.equal(doneReceipt.code, 'vision_batch_deferred'); assert.equal(doneReceipt.noDispatch, true);
      assert.equal(doneReceipt.outcomeUnknown, false); assert.notEqual(doneReceipt.done, true);
      if (doneFirst) assert.equal(JSON.parse(receipts[1].content).code, 'vision_batch_deferred');
      else assert.equal(JSON.parse(receipts[0].content).success, true);
      return { toolCalls: [call('done', { frameId: frame.frameId, summary: 'Individually verified completion.', outcome: 'success' })] };
    });
    assert.equal(await fixture.run(), 'Individually verified completion.');
    assert.equal(fixture.actions.length, doneFirst ? 0 : 1);
    assert.equal(fixture.requests.length, 2);
    assert.ok(!fixture.events.some(event => event.type === 'text' && event.data.content === 'Premature batch completion.'));
  });

  test(`${browser}: an invalid first batch call cannot authorize a later action from the same frame`, async () => {
    const fixture = setup(module, ({ index, frame, messages }) => {
      if (!index) return { toolCalls: [call('vision_click', { frameId: frame.frameId, x: -10, y: 10 }, 'invalid-first'),
        call('vision_click', { frameId: frame.frameId, x: 10, y: 10 }, 'deferred-second')] };
      const receipts = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      assert.equal(receipts[0].success, false); assert.equal(receipts[1].code, 'vision_batch_deferred');
      assert.equal(receipts[1].noDispatch, true);
      return { toolCalls: [call('done', { frameId: frame.frameId, summary: 'No action dispatched.', outcome: 'blocked' })] };
    });
    assert.equal(await fixture.run(), 'No action dispatched.'); assert.equal(fixture.actions.length, 0);
  });

  test(`${browser}: stale model coordinates refresh observation before allowing a corrected action`, async () => {
    const fixture = setup(module, ({ index, frame }) => ({ toolCalls: [index < 2
      ? call('vision_click', { frameId: index ? frame.frameId : 'expired-frame', x: 30, y: 40 })
      : call('done', { frameId: frame.frameId, summary: 'Fresh frame used.', outcome: 'success' })] }));
    assert.equal(await fixture.run(), 'Fresh frame used.'); assert.equal(fixture.actions.length, 1);
    assert.notEqual(latestFrame(fixture.requests[0]).frameId, latestFrame(fixture.requests[1]).frameId);
  });

  test(`${browser}: cancellation during inference prevents dispatch and preserves a cancelled terminal result`, async () => {
    const fixture = setup(module, ({ frame, controller }) => {
      controller.abort(new DOMException('User stopped', 'AbortError'));
      return { toolCalls: [call('vision_click', { frameId: frame.frameId, x: 30, y: 40 })] };
    });
    let status;
    assert.equal(await fixture.run({ runOptions: { onRunFinished: value => { status = value; } } }), '[Stopped by user]');
    assert.equal(status, 'cancelled'); assert.equal(fixture.actions.length, 0);
  });

  test(`${browser}: user steering invalidates an in-flight model action and forces a full observation`, async () => {
    const fixture = setup(module, ({ index, frame, steer, messages }) => {
      if (!index) {
        steer('Do not click. Report blocked instead.');
        return { toolCalls: [call('vision_click', { frameId: frame.frameId, x: 30, y: 40 })] };
      }
      assert.ok(messages.some(message => message.content === 'Do not click. Report blocked instead.'));
      assert.equal(frame.kind, 'full');
      return { toolCalls: [call('done', { frameId: frame.frameId, summary: 'Correction respected.', outcome: 'blocked' })] };
    });
    assert.equal(await fixture.run(), 'Correction respected.'); assert.equal(fixture.actions.length, 0);
    assert.ok(fixture.history.some(message => message.content === 'Do not click. Report blocked instead.'));
  });

  test(`${browser}: denied capability permissions never dispatch`, async () => {
    const fixture = setup(module, ({ index, frame }) => ({ toolCalls: [index
      ? call('done', { frameId: frame.frameId, summary: 'Permission denied.', outcome: 'blocked' })
      : call('vision_type', { frameId: frame.frameId, text: 'must not type' })] }));
    fixture.agent._skipPermissionGate = false;
    fixture.agent.permissions.check = () => ({ allowed: false, needsPrompt: true });
    fixture.agent._promptPermission = async () => 'deny';
    assert.equal(await fixture.run(), 'Permission denied.'); assert.equal(fixture.actions.length, 0);
  });

  test(`${browser}: a changing completion screenshot cannot be reported as verified success`, async () => {
    const fixture = setup(module, ({ index, frame, change }) => {
      if (!index) change();
      return { toolCalls: [call('done', { frameId: frame.frameId, summary: index ? 'Now stable and verified.' : 'Premature success.', outcome: 'success' })] };
    });
    assert.equal(await fixture.run(), 'Now stable and verified.');
    assert.equal(fixture.requests.length, 2);
    assert.ok(!fixture.history.some(message => message.content === 'Premature success.'));
  });

  test(`${browser}: plain prose cannot bypass visual completion, and the step limit reports incomplete work`, async () => {
    const fixture = setup(module, () => ({ content: 'I am done.' })); fixture.agent.maxSteps = 2;
    assert.match(await fixture.run(), /not verified complete/);
    assert.equal(fixture.requests.length, 2); assert.equal(fixture.actions.length, 0);
    assert.ok(fixture.events.some(event => event.type === 'max_steps_reached'));
  });

  test(`${browser}: bounded request assembly retains whole tool groups and a reconstructible full-plus-patch observation`, () => {
    const packets = [
      { frameId: 'full', kind: 'full', canvas: { width: 100, height: 100 }, images: [{ id: 'full-image', dataUrl: IMAGE, rect: { x: 0, y: 0, width: 100, height: 100 } }] },
      { frameId: 'patch', kind: 'delta', baseFrameId: 'full', canvas: { width: 100, height: 100 }, images: [{ id: 'patch-image', dataUrl: IMAGE, rect: { x: 20, y: 30, width: 10, height: 10 } }] },
    ];
    const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'original request' }];
    for (let index = 0; index < 50; index++) messages.push(
      { role: 'assistant', content: '', tool_calls: [call('vision_observe', {}, `tool-${index}`)] },
      { role: 'tool', tool_call_id: `tool-${index}`, content: 'observed' },
    );
    const request = module.visionRequestMessages(messages, { contextFrames: () => packets }, 2);
    assert.deepEqual(request.slice(0, 2), messages.slice(0, 2));
    const ids = request.flatMap(message => message.tool_calls || []).map(tool => tool.id);
    assert.deepEqual(request.filter(message => message.role === 'tool').map(message => message.tool_call_id), ids);
    assert.ok(ids.length < 50);
    const observation = request.at(-1).content;
    assert.equal(observation.filter(block => block.type === 'image_url').length, 2);
    assert.ok(!observation.filter(block => block.type === 'text').some(block => block.text.includes('data:image/')));
    assert.equal(latestFrame(request).frameId, 'patch');
  });
}
