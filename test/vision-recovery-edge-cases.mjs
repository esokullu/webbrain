import assert from 'node:assert/strict';
import { test } from 'node:test';

const api = {
  runtime: { getURL: path => `chrome-extension://vision-edge-test/${path}` },
  storage: { local: { async get() { return {}; }, async set() {} }, session: { async get() { return {}; }, async set() {} } },
  tabs: { async get(id) { return { id, url: 'https://owned.example/' }; } },
};
globalThis.chrome = api;
globalThis.browser = api;

// A real runner with deterministic image/frame/provider seams. A warning
// callback can interrupt a retry before any timer waits or browser input.
function fixture(onWarning) {
  const controller = new AbortController(), events = [], requests = [], captures = [];
  const history = [{ role: 'system', content: 'Prior conversation.' }];
  const viewport = { width: 800, height: 600, devicePixelRatio: 1, url: 'https://owned.example/', documentId: 'document-1' };
  let latest = null, sequence = 0, pending = '', status;
  const provider = { name: 'vision-test', model: 'owned-vision', supportsVision: true, supportsTools: true };
  const frames = {
    get latest() { return latest; },
    async capture(dataUrl, current, { forceFull = false } = {}) {
      captures.push({ forceFull });
      const frameId = `frame-${++sequence}`;
      latest = { protocol: 'vision-frame-v1', frameId, baseFrameId: frameId,
        kind: forceFull || !latest ? 'full' : 'unchanged', viewport: current, canvas: { width: 800, height: 600 },
        images: [{ id: `${frameId}:image-0`, dataUrl, mimeType: 'image/png',
          width: 800, height: 600, rect: { x: 0, y: 0, width: 800, height: 600 } }], bytes: 4, estimatedTokens: 1 };
      return latest;
    },
    contextFrames: () => latest ? [latest] : [],
    assertViewport(current) { assert.deepEqual(current, viewport); },
    reset() { latest = null; },
  };
  const agent = {
    maxSteps: 4, screenshotRedaction: false, currentCostState: new Map(),
    providerManager: { async prepareActiveProviderCapabilities() {} },
    permissions: { beginTurn() {} },
    getConversation: () => history,
    _activeProvider: () => provider,
    _newCostRunState: () => ({}),
    _runAbortSignal: () => controller.signal,
    _throwIfAborted: signal => signal?.throwIfAborted(),
    _checkAbort: () => controller.signal.aborted,
    _hasPendingSteering: () => Boolean(pending),
    _applyPendingSteering(_id, messages) {
      if (!pending) return false;
      messages.push({ role: 'user', content: pending }); pending = ''; return true;
    },
    async _persistSubmittedTurn() {}, async _persistNow() { return { ok: true }; },
    async _startTraceRun() { return null; }, async _endTraceRun() {},
    _withResponseItems: message => message,
    _createVisionFrameSession: () => frames,
    _createVisionBrowser: () => ({
      async capture() { return { dataUrl: agent.screenshotRedaction ? 'data:image/png;base64,cHJvdGVjdGVk' : 'data:image/png;base64,dGVzdA==',
        viewport, privacyProtected: agent.screenshotRedaction }; },
      async readViewport() { return viewport; },
      async perform() { assert.fail('No browser mutation may be dispatched by this fixture'); },
    }),
    async _chatWithCostAllowance(_provider, messages) {
      requests.push(structuredClone(messages));
      if (requests.length === 1) throw Object.assign(new Error('Provider temporarily rate limited'), { httpStatus: 429 });
      assert.ok(messages.some(message => message.role === 'user' && message.content === 'Report the blocker; do not click.'));
      return { toolCalls: [{ id: 'finish', type: 'function', function: { name: 'done', arguments: JSON.stringify({
        frameId: latest.frameId, summary: 'Correction handled after model cooldown.', outcome: 'blocked',
      }) } }] };
    },
  };
  return {
    agent, provider, frames, controller, events, requests, captures, history,
    run: module => module.runVisionAct(agent, { tabId: 71, userMessage: 'Click the visible button.',
      onUpdate(type, data) {
        events.push({ type, data });
        if (type === 'warning') onWarning({ controller, steer: () => { pending = 'Report the blocker; do not click.'; } });
      },
      runOptions: { onRunFinished: value => { status = value; } },
    }),
    get status() { return status; },
  };
}

for (const browser of ['chrome', 'firefox']) {
  const module = await import(`../src/${browser}/src/agent/vision-act.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { captureVisionPrivacySnapshot } = await import(`../src/${browser}/src/agent/vision-redaction.js`);

  test(`${browser}: steering during model cooldown resumes with a full screenshot and the corrected task`, { timeout: 3000 }, async () => {
    const run = fixture(({ steer }) => steer());
    assert.equal(await run.run(module), 'Correction handled after model cooldown.');
    assert.equal(run.status, 'blocked');
    assert.equal(run.requests.length, 2);
    assert.equal(run.captures.filter(capture => capture.forceFull).length, 2);
    assert.ok(run.history.some(message => message.content === 'Report the blocker; do not click.'));
    assert.ok(!run.events.some(event => event.type === 'tool_call' && event.data.name !== 'done'));
  });

  test(`${browser}: Stop during model cooldown stays cancelled and never sends a second request`, { timeout: 3000 }, async () => {
    const run = fixture(({ controller }) => controller.abort(new DOMException('User stopped', 'AbortError')));
    assert.equal(await run.run(module), '[Stopped by user]');
    assert.equal(run.status, 'cancelled');
    assert.equal(run.requests.length, 1);
    assert.equal(run.captures.length, 1);
  });

  test(`${browser}: privacy enabled during the real cost allowance gate replaces raw screenshots before provider dispatch`, { timeout: 3000 }, async () => {
    const run = fixture(() => {});
    let providerCalls = 0, allowanceChecks = 0;
    const dispatchedImages = [];
    run.agent._chatWithCostAllowance = Agent.prototype._chatWithCostAllowance;
    run.agent._linkAbortSignals = signal => ({ signal, dispose() {} });
    run.agent._holdCostAllowance = () => ({ release() {} });
    run.agent._checkCostAllowance = async () => {
      allowanceChecks++;
      // Models can be held here while the user changes settings or approves
      // spending. This happens after the visual runner prepared its request.
      run.agent.screenshotRedaction = true;
      return null;
    };
    run.agent._recordCostUsage = async () => null;
    run.agent._cloudGenerationOptions = (_provider, options) => options;
    run.provider.chat = async messages => {
      providerCalls++;
      const images = messages.flatMap(message => Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'image_url').map(block => block.image_url.url) : []);
      dispatchedImages.push(images);
      return { toolCalls: [{ id: 'finish', type: 'function', function: { name: 'done', arguments: JSON.stringify({
        frameId: run.frames.latest.frameId, summary: 'Only protected screenshots were sent.', outcome: 'blocked',
      }) } }] };
    };
    assert.equal(await run.run(module), 'Only protected screenshots were sent.');
    assert.deepEqual(dispatchedImages, [['data:image/png;base64,cHJvdGVjdGVk']],
      'No raw screenshot may cross the provider boundary after privacy was enabled');
    assert.equal(providerCalls, 1);
    assert.ok(allowanceChecks >= 1);
    assert.equal(run.captures.filter(capture => capture.forceFull).length, 2);
  });

  test(`${browser}: request validation runs after the allowance and synchronously before the provider`, async () => {
    const run = fixture(() => {}), order = [];
    const agent = run.agent;
    agent._linkAbortSignals = signal => ({ signal, dispose() {} });
    agent._holdCostAllowance = () => ({ release() {} });
    agent._checkCostAllowance = async () => { await Promise.resolve(); order.push('allowance'); return null; };
    agent._recordCostUsage = async () => null;
    agent._cloudGenerationOptions = (_provider, options) => options;
    run.provider.chat = async () => { order.push('provider'); return { content: 'Ready.' }; };
    const result = await Agent.prototype._chatWithCostAllowance.call(agent, run.provider,
      [{ role: 'user', content: 'Ready?' }], { signal: run.controller.signal }, {}, {
        tabId: 71,
        validateBeforeProviderRequest() {
          order.push('validation');
          queueMicrotask(() => order.push('next-microtask'));
        },
      });
    assert.equal(result.content, 'Ready.');
    assert.deepEqual(order, ['allowance', 'validation', 'provider', 'next-microtask']);
  });

  test(`${browser}: invalidated request releases its allowance without dispatch or usage recording`, async () => {
    const run = fixture(() => {});
    const obsolete = Object.assign(new Error('Screenshot privacy changed'), { code: 'vision_request_obsolete' });
    let released = 0, disposed = 0;
    run.agent._linkAbortSignals = signal => ({ signal, dispose() { disposed++; } });
    run.agent._holdCostAllowance = () => ({ release() { released++; } });
    run.agent._checkCostAllowance = async () => null;
    run.agent._recordCostUsage = async () => assert.fail('A rejected request has no provider usage');
    run.agent._cloudGenerationOptions = (_provider, options) => options;
    run.provider.chat = async () => assert.fail('An obsolete screenshot must not be sent');
    await assert.rejects(Agent.prototype._chatWithCostAllowance.call(run.agent, run.provider,
      [{ role: 'user', content: 'Ready?' }], { signal: run.controller.signal }, {}, {
        tabId: 71, validateBeforeProviderRequest() { throw obsolete; },
      }), error => error === obsolete);
    assert.equal(released, 1);
    assert.equal(disposed, 1);
  });

  test(`${browser}: delayed privacy readiness retries fresh observations only while the live tab is loading`, async () => {
    const originalGet = api.tabs.get, waits = [];
    let scans = 0, images = 0;
    api.tabs.get = async id => ({ id, status: 'loading', discarded: false });
    const agent = { screenshotRedaction: true, async captureScreenshotRedactionSnapshotForUser() {
      scans++;
      return scans < 3 ? { ok: false } : { ok: true, snapshot: { coordinateSpace: 'page', regions: [] } };
    } };
    try {
      const observation = await module.captureVisionObservation({ async capture(tabId) {
        await captureVisionPrivacySnapshot(agent, tabId);
        images++;
        return { dataUrl: 'data:image/png;base64,cHJvdGVjdGVk', privacyProtected: true };
      } }, 71, { wait: async milliseconds => waits.push(milliseconds) });
      assert.equal(observation.privacyProtected, true);
      assert.equal(observation.attempts, 3);
      assert.equal(scans, 3); assert.equal(images, 1);
      assert.deepEqual(waits, [150, 300]);
    } finally { api.tabs.get = originalGet; }
  });

  test(`${browser}: privacy recovery stays bounded and never downgrades permanent or malformed failures`, async () => {
    const originalGet = api.tabs.get;
    try {
      const cases = [
        { tab: { id: 71, status: 'complete' }, scan: { ok: false }, attempts: 1, code: 'vision_privacy_scan_failed' },
        { tab: { id: 71, status: 'loading', discarded: true }, scan: { ok: false }, attempts: 1, code: 'vision_privacy_scan_failed' },
        { tab: null, scan: { ok: false }, attempts: 1, code: 'vision_privacy_scan_failed' },
        { tab: { id: 71, status: 'loading' }, scan: { ok: false, error: 'Permission denied' }, attempts: 1, code: 'vision_privacy_scan_failed' },
        { tab: { id: 71, status: 'loading' }, scan: { ok: true, snapshot: { coordinateSpace: 'viewport', regions: [] } }, attempts: 1, code: 'vision_privacy_scan_failed' },
        { tab: { id: 71, status: 'loading' }, scan: { ok: false }, attempts: 8, code: 'vision_capture_not_ready' },
      ];
      for (const scenario of cases) {
        let scans = 0, waits = 0;
        api.tabs.get = async () => scenario.tab;
        const agent = { screenshotRedaction: true, async captureScreenshotRedactionSnapshotForUser() { scans++; return scenario.scan; } };
        await assert.rejects(module.captureVisionObservation({ async capture(tabId) {
          await captureVisionPrivacySnapshot(agent, tabId);
          assert.fail('No image may be returned without a complete privacy snapshot');
        } }, 71, { wait: async () => { waits++; } }), error => error.code === scenario.code);
        assert.equal(scans, scenario.attempts);
        assert.equal(waits, scenario.attempts - 1);
      }
    } finally { api.tabs.get = originalGet; }
  });
}
