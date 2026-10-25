import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const storage = { async get() { return {}; }, async set() {} };
const api = {
  runtime: { getURL: path => `chrome-extension://vision-capability-test/${path}` },
  storage: { local: storage, session: storage, onChanged: { addListener() {} } },
  tabs: { async get(id) { return { id, windowId: 9, url: 'https://example.com/', title: 'Fixture' }; } },
  windows: { async get(id) { return { id, width: 1280, height: 900, state: 'normal' }; } },
  scripting: { async executeScript() { assert.fail('Independent capability entered the page'); } },
  webNavigation: { async getAllFrames() { return []; } },
};
globalThis.chrome = api; globalThis.browser = api;

for (const build of ['chrome', 'firefox']) {
  const mod = await import(`../src/${build}/src/agent/vision-capabilities.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const scheduler = await import(`../src/${build}/src/agent/scheduler.js`);
  const network = await import(`../src/${build}/src/network/network-tools.js`);
  function fixture() {
    const agent = new Agent({ getActive: () => ({ name: 'fixture', supportsVision: true }) });
    const controller = new AbortController();
    agent._persist = () => {}; agent._persistNow = async () => true;
    agent._ensureGateSetting = async () => {}; agent._skipPermissionGate = true;
    agent.conversations.set(77, [{ role: 'system', content: 'Fixture.' }, { role: 'user', content: 'Process the two listed items.' }]);
    agent.conversationIds.set(77, 'conv-1');
    agent._readWorkflowRequestedFieldMatches = () => assert.fail('No workflow/AX read');
    agent._socialDraftClarificationArgs = () => assert.fail('No implicit page draft read');
    const ctx = { tabId: 77, mode: 'dev', signal: controller.signal, onUpdate() {},
      browser: { async readViewport() { return { width: 1200, height: 800, devicePixelRatio: 2 }; } } };
    return { agent, controller, ctx, run: (name, args = {}, extra = {}) => mod.executeVisionCapability(agent, { ...ctx, name, args, ...extra }) };
  }

  test(`${build}: independent catalog contains capabilities without page readers or selectors`, () => {
    const names = mod.VISION_CAPABILITY_TOOLS.map(t => t.function.name);
    assert.equal(names.length, 18);
    for (const name of ['read_page', 'get_accessibility_tree', 'browser_batch', 'click', 'execute_js']) assert.ok(!names.includes(name));
    assert.equal(mod.VISION_CAPABILITY_TOOLS.find(t => t.function.name === 'fetch_url').function.parameters.properties.replayRequestId, undefined);
  });

  test(`${build}: calculator and task notes use real Agent lifecycle without screenshots or page reads`, async () => {
    const f = fixture();
    const calculated = await f.run('calculate', { expression: '12.5*4' });
    assert.equal(calculated.result.result, '50');
    assert.equal(calculated.effects.observe, false);
    const written = await f.run('scratchpad_write', { text: 'First item finished; saved download ID 19.' });
    assert.equal(written.result.success, true);
    assert.equal(written.effects.observe, false);
    assert.match(mod.visionTaskMemory(f.agent, 77).scratchpad, /download ID 19/);
    const updated = await f.run('progress_update', { items: [{ id: 'item-one', action: 'process_item', status: 'processed' }, { id: 'item-two', action: 'process_item', status: 'pending' }] });
    assert.equal(updated.result.success, true, JSON.stringify(updated.result));
    const progress = await f.run('progress_read');
    assert.equal(progress.result.rows.length, 2);
    assert.equal(progress.effects.observe, false);
    assert.equal(mod.visionTaskMemory(f.agent, 77).progress.rows.length, 2);
  });

  test(`${build}: actual clarification waits, accepts a genuine user reply and records authority`, async () => {
    const f = fixture(); f.agent.clarifyTimeoutSec = -1;
    let emitted;
    const result = await f.run('clarify', { question: 'Which account?', options: ['Personal', 'Work'], require_explicit_answer: true }, {
      onUpdate(type, data) {
        if (type === 'clarify') {
          emitted = data;
          queueMicrotask(() => f.agent.submitClarifyResponse(77, data.clarifyId, 'Work', 'user'));
        }
      },
    });
    assert.ok(emitted?.clarifyId);
    assert.equal(result.result.answer, 'Work'); assert.equal(result.result.source, 'user');
    assert.equal(result.effects.userReply.authorized, true);
    assert.equal(result.effects.observe, false);
    assert.equal(f.agent._pendingClarifications.size, 0);
  });

  test(`${build}: Stop cancels a pending question and releases the caller`, async () => {
    const f = fixture(); f.agent.clarifyTimeoutSec = -1;
    await assert.rejects(f.run('clarify', { question: 'Choose an account.', require_explicit_answer: true }, {
      onUpdate(type) { if (type === 'clarify') { f.controller.abort(new DOMException('Stopped', 'AbortError')); } },
    }), /Stopped/);
    assert.equal(f.agent._pendingClarifications.size, 0);
  });

  test(`${build}: denied capability never dispatches or fetches, including after a permission prompt`, async () => {
    const f = fixture(); let fetched = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { fetched++; return new Response('{}'); };
    f.agent._skipPermissionGate = false;
    f.agent.permissions = { hydrate: async () => {}, check: () => ({ allowed: false, needsPrompt: true }), record: async () => {} };
    f.agent._promptPermission = async () => 'deny';
    try { await assert.rejects(f.run('fetch_url', { url: 'https://api.example.com/data' }), /Permission denied/); }
    finally { globalThis.fetch = original; }
    assert.equal(fetched, 0);
  });

  test(`${build}: window and native history mutations invalidate visual coordinates`, async () => {
    const f = fixture(), mutations = [];
    const oldUpdate = api.windows.update, oldBack = api.tabs.goBack;
    api.windows.update = async (id, args) => mutations.push({ id, args });
    api.tabs.goBack = async id => mutations.push({ back: id });
    try {
      const info = await f.run('get_window_info'); assert.equal(info.result.viewport.devicePixelRatio, 2); assert.equal(info.effects.observe, false);
      for (const [name, args] of [['resize_window', { width: 1400, height: 900 }], ['go_back', { steps: 1 }]]) {
        const result = await f.run(name, args); assert.equal(result.result.success, true);
        assert.equal(result.effects.resetFrames, true); assert.equal(result.effects.observe, true);
      }
      assert.equal(mutations.length, 2);
      const multiple = await f.run('go_back', { steps: 2 });
      assert.equal(multiple.result.noDispatch, true); assert.equal(mutations.length, 2);
      await assert.rejects(f.run('resize_window', { width: 1400, height: 900 }, { beforeDispatch: async () => false }), /stopped/);
      assert.equal(mutations.length, 2);
    } finally { api.windows.update = oldUpdate; api.tabs.goBack = oldBack; }
  });

  test(`${build}: explicit selection reads only highlighted content and remains bounded`, async () => {
    const f = fixture(); const original = api.scripting.executeScript;
    api.scripting.executeScript = async spec => {
      const source = spec.func.toString();
      assert.doesNotMatch(source, /innerText|textContent|querySelector|accessibility/);
      return [{ frameId: 0, result: { text: 'Selected words' } }, { frameId: 2, result: { text: '' } }];
    };
    try { const result = await f.run('get_selection'); assert.equal(result.result.text, 'Selected words'); assert.equal(result.effects.observe, false); }
    finally { api.scripting.executeScript = original; }
  });

  test(`${build}: recalled legacy actions remain data and Stop discards a late recall`, async () => {
    const f = fixture(); let resolve;
    f.agent.memcodeRecall = { recall: async () => ({ success: true, results: [{ content: 'click #submit / axref-old' }] }) };
    const result = await f.run('recall_memcode', { query: 'Previous task notes' });
    assert.equal(result.result.executable, false); assert.equal(result.effects.observe, false);
    f.agent.memcodeRecall = { recall: () => new Promise(done => { resolve = done; }) };
    const pending = f.run('recall_memcode', { query: 'Notes' });
    await new Promise(done => setImmediate(done)); f.controller.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(pending, /Stopped/); resolve({ success: true, results: [{ content: 'late' }] });
  });

  test(`${build}: direct API reads are bounded and preserve same-site cookie policy`, async () => {
    const f = fixture(); const original = globalThis.fetch; let request;
    globalThis.fetch = async (url, options) => { request = options; return new Response(JSON.stringify({ rows: 'x'.repeat(20000) }), { headers: { 'content-type': 'application/json' } }); };
    try {
      const result = await f.run('fetch_url', { url: 'https://api.example.com/data', maxChars: 1000 });
      assert.equal(result.result.success, true); assert.ok(result.result.json.length <= 1000); assert.equal(result.result.hasMore, true);
      assert.equal(request.credentials, 'include'); assert.equal(request.redirect, 'manual');
      assert.equal(result.effects.observe, false);
    } finally { globalThis.fetch = original; }
  });

  test(`${build}: HTML/XHTML/SVG and MIME-spoofed pages never become a visual text fallback`, async () => {
    const original = globalThis.fetch;
    try {
      for (const mime of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/plain']) {
        globalThis.fetch = async () => new Response('<html><body>Private page text</body></html>', { headers: { 'content-type': mime } });
        const result = await network.fetchUrl('https://example.com/page', {}, { tabId: 77, visionOnly: true });
        assert.equal(result.code, 'vision_page_text_unavailable', mime);
        assert.doesNotMatch(JSON.stringify(result), /Private page text/);
      }
      let fetched = 0;
      globalThis.fetch = async () => { fetched++; throw new Error('must not fetch'); };
      for (const body of ['<!-- build stamp --><html><body>Hidden page</body></html>', '<div>Rendered fragment</div>', '<?xml version="1.0"?><svg>Hidden labels</svg>']) {
        globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/plain' } });
        const denied = await network.fetchUrl('https://example.com/page', {}, { tabId: 77, visionOnly: true });
        assert.equal(denied.success, false); assert.equal(denied.code, 'vision_page_text_unavailable');
      }
      const result = await network.fetchUrl('https://example.com/page', { replayRequestId: 'old-capture' }, { tabId: 77, visionOnly: true });
      assert.equal(result.code, 'vision_fetch_replay_unavailable'); assert.equal(fetched, 0);
    } finally { globalThis.fetch = original; }
  });

  test(`${build}: actual scheduler alarm retains visual Dev mode even after the global preference changes`, async () => {
    let call;
    const h = makeSchedulerHarness(scheduler, { processMessage: async (...args) => { call = args; return 'Resumed using a new screenshot.'; } });
    const result = await h.manager.createResumeJob({ tabId: 77, conversationId: 'conv-1', resumeTaskId: 'owned-task', mode: 'dev', actObservation: 'vision',
      currentUrl: 'https://example.com/', args: { after_seconds: 60, reason: 'Wait for report', resume_instruction: 'Read durable notes and verify current progress.' } });
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(h.jobs()[0].actObservation, 'vision');
    await h.manager.handleAlarm(h.alarmName(result.jobId));
    assert.ok(call, JSON.stringify(h.jobs())); assert.equal(call[3], 'dev'); assert.equal(call[5].actObservation, 'vision');
    assert.equal(call[5].scheduledResume, true); assert.match(call[1], /durable notes/);
  });

  test(`${build}: scheduling persists memory first and refuses a failed save`, async () => {
    const f = fixture(), order = []; let passed;
    f.agent._scheduleCreationContext = () => ({ check: () => null, markDispatched() {} });
    f.agent._persistNow = async () => { order.push('save'); return true; };
    f.agent.scheduler = { async createResumeJob(spec) { order.push('schedule'); passed = spec; return { success: true, scheduled: true, summary: 'Later', done: true }; } };
    const result = await f.run('schedule_resume', { after_seconds: 60, reason: 'Wait', resume_instruction: 'Continue item two' });
    assert.deepEqual(order, ['save', 'schedule']); assert.equal(passed.actObservation, 'vision'); assert.equal(passed.mode, 'dev');
    assert.equal(result.effects.terminal.status, 'scheduled'); assert.equal(result.effects.observe, false);
    f.agent._persistNow = async () => false;
    const failed = await f.run('schedule_resume', { after_seconds: 60, reason: 'Wait', resume_instruction: 'Continue' });
    assert.equal(failed.result.code, 'vision_schedule_not_durable'); assert.equal(order.length, 2);
  });
  test(`${build}: service-worker restart restores scheduled conversation identity, task notes and progress`, async () => {
    const original = api.storage.session;
    const saved = {};
    api.storage.session = { get: async key => ({ [key]: structuredClone(saved[key]) }), set: async values => Object.assign(saved, structuredClone(values)) };
    try {
      const f = fixture();
      await f.run('scratchpad_write', { text: 'Resume from download ID 19, item two.' });
      await f.run('progress_update', { items: [{ id: 'one', action: 'process_item', status: 'processed' }, { id: 'two', action: 'process_item', status: 'pending' }] });
      assert.equal((await Agent.prototype._persistNow.call(f.agent, 77)).ok, true);
      const restored = new Agent({ getActive: () => ({ name: 'fixture', supportsVision: true }) });
      restored._persist = () => {};
      assert.equal(await restored.getConversationId(77), 'conv-1');
      const memory = mod.visionTaskMemory(restored, 77);
      assert.match(memory.scratchpad, /download ID 19/);
      assert.equal(memory.progress.rows.find(row => row.id === 'one').status, 'processed');
      assert.equal(memory.progress.rows.find(row => row.id === 'two').status, 'pending');
      const h = makeSchedulerHarness(scheduler, { getConversationId: tabId => restored.getConversationId(tabId) });
      await h.manager._validateConversation({ kind: 'resume', conversationId: 'conv-1' }, 77);
      await assert.rejects(h.manager._validateConversation({ kind: 'resume', conversationId: 'different-task' }, 77), /Conversation changed/);
    } finally { api.storage.session = original; }
  });
}
