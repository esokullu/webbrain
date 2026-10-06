import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';
import { CDPClient, cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/new', title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] } };
globalThis.chrome = api;
globalThis.browser = api;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sender = (tabId, frameId = 0, documentId = 'document-1') => ({ tab: { id: tabId }, frameId, documentId, url: 'https://example.com/new' });
let nextTab = 600;

test('CDP evaluateFunction sends page data as arguments and releases the global target', async () => {
  const client = new CDPClient(), tab = 599, calls = [];
  client.sessions.set(tab, {});
  client.sendCommand = async (_tab, method, params) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') return { result: { objectId: 'page-global' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: 'done' } };
    return {};
  };
  const guard = { documentToken: 'doc', revision: 3, operationId: 'op' };
  const declaration = 'function (guard, token) { return [guard, token]; }';
  const response = await client.evaluateFunction(tab, declaration, [guard, 'abort'], { timeoutMs: 15000 });
  assert.deepEqual(response, { result: { value: 'done' } });
  assert.deepEqual(calls.map(call => call.method), ['Runtime.enable', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.releaseObject']);
  assert.equal(calls[1].params.expression, 'globalThis');
  assert.equal(calls[2].params.objectId, 'page-global');
  assert.equal(calls[2].params.functionDeclaration, declaration);
  assert.deepEqual(calls[2].params.arguments, [{ value: guard }, { value: 'abort' }]);
  assert.equal(calls[2].params.awaitPromise, true);
  assert.equal(calls[2].params.timeout, 15000);
  assert.deepEqual(calls[3].params, { objectId: 'page-global' });
});

function setup(Agent, implementation = {}) {
  const provider = { name: 'feedback test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: false, supportsVision: false, ...implementation };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._startTraceRun = async () => null;
  agent._endTraceRun = async () => {};
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  agent._beginReadCompleteness = async () => null;
  agent._maybeRunPlannerGate = async () => ({ proceed: true });
  agent._manageContext = async () => {};
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => 'https://example.com/new';
  agent._maybeEmitAskModeHandoff = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._pageFeedbackIdleMs = 0;
  agent.executeTool = async (_tab, name) => {
    assert.equal(name, 'get_accessibility_tree', 'Superseded action must never be dispatched');
    return { success: true, pageContent: 'The current view' };
  };
  return agent;
}

function bind(agent, tabId, frameId = 0, documentId = 'document-1', docToken = 'content-1') {
  const from = sender(tabId, frameId, documentId);
  const state = agent.pageMonitorState(from, docToken);
  assert.equal(state.active, true);
  let seq = 0;
  return { state, from, send: value => agent.observePageFeedback(from, {
    ...state, seq: ++seq, kind: 'input', source: 'user', revision: seq, target: 'input#filter', ...value,
  }) };
}

function allowBatchPreparation(agent) {
  agent._skipPermissionGate = true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._ensureGateSetting = async () => true;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._isFormValidationCandidate = () => false;
  agent._preflightRichTextToolbarTarget = async () => ({ block: null });
  agent._auditRichTextToolbarTarget = async () => {};
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { beforePageAgentDispatch } = await import(`../src/${build}/src/agent/page-feedback.js`);

  if (build === 'chrome') {
    test('Chrome execute_js returns without dispatch when the page-side revision gate rejects it', async () => {
      const tab = nextTab++, agent = setup(Agent);
      const previousSendMessage = api.tabs.sendMessage;
      const previousEnable = cdpClient.enableDevDiagnostics, previousEvaluate = cdpClient.evaluate;
      const previousEvaluateFunction = cdpClient.evaluateFunction;
      let declaration = '', passedArgs = [];
      try {
        await agent._claimRunEntry(tab, 'interactive');
        await agent._beginPageFeedbackRun(tab, 'interactive');
        const run = agent._pageFeedbackRuns.get(tab);
        run.frames.set(0, { token: 'execute-js-document', id: 'document-1' });
        api.tabs.sendMessage = async (_tab, message) => message.action === 'page_monitor_dispatch'
          ? { ready: true, guard: { runToken: run.token, documentToken: 'execute-js-document',
            revision: 7, operationId: message.params.operationId } }
          : { ready: true };
        cdpClient.enableDevDiagnostics = async () => {};
        cdpClient.evaluateFunction = async (_tab, value, args) => {
          declaration = value; passedArgs = args;
          assert.equal(typeof args[0], 'object');
          assert.equal(typeof args[1], 'string');
          return { result: { value: { __webbrainPageFeedbackAborted: args[1] } } };
        };
        const result = await agent._executeDevJavaScript(tab, { code: 'window.__shouldNotRun = true;' });
        assert.equal(result.dispatched, false);
        assert.equal(result.noDispatch, true);
        assert.match(result.error, /page changed during JavaScript preparation/i);
        assert.match(declaration, /cancelable: true/);
        assert.match(declaration, /if \(!window\.dispatchEvent\(gate\)\) return/);
        assert.ok(declaration.indexOf('return (async () =>') > declaration.indexOf('dispatchEvent(gate)'));
        assert.match(declaration, /window\.__shouldNotRun = true/);
        assert.doesNotMatch(declaration, /execute-js-document|operationId/,
          'The page guard must travel as a protocol argument instead of source text');
        assert.equal(passedArgs[0].documentToken, 'execute-js-document');
        assert.ok(passedArgs[1]);
        assert.equal(cdpClient.evaluate, previousEvaluate, 'Guarded execution must not use Runtime.evaluate source construction');
      } finally {
        cdpClient.enableDevDiagnostics = previousEnable;
        cdpClient.evaluate = previousEvaluate;
        cdpClient.evaluateFunction = previousEvaluateFunction;
        api.tabs.sendMessage = previousSendMessage;
        if (agent._pageFeedbackRuns.has(tab)) agent._finishPageFeedbackRun(tab);
        agent._releaseRunEntry(tab);
      }
    });

    test('Chrome CDP click fallbacks pass the monitor guard and skip stale DOM clicks', async () => {
      const tab = nextTab++;
      const previousSendMessage = api.tabs.sendMessage;
      const responses = [];
      const { pageFeedbackMethods } = await import('../src/chrome/src/agent/page-feedback.js');
      class ClickAgent {
        static STATE_CHANGE_TOOLS = new Set(['click']);
        isRunning() { return true; }
        _checkAbort() { return false; }
        _persist() {}
      }
      Object.assign(ClickAgent.prototype, pageFeedbackMethods);
      const agent = new ClickAgent();
      api.tabs.sendMessage = async (_tab, message) => {
        if (message.action === 'page_monitor_dispatch') {
          const guard = { runToken: message.params.runToken, documentToken: 'click-document',
            revision: 9, operationId: message.params.operationId };
          responses.push(guard);
          return { ready: true, guard };
        }
        return { ready: true };
      };
      await agent._beginPageFeedbackRun(tab, 'interactive');
      try {
        for (const fallback of ['closed-shadow-node', 'open-shadow-selector']) {
          const client = new CDPClient(), declarationCalls = [];
          client.resolveSelector = async () => ({ inViewport: false, hitOk: false, nodeId: fallback === 'closed-shadow-node' ? 42 : null,
            tag: 'BUTTON', x: 20, y: 30, width: 40, height: 20, text: 'Save' });
          client.armFileInputClickGuard = async () => {};
          client.consumeFileInputClickGuard = async () => ({ blocked: false });
          client.sendCommand = async (_tab, method, params) => {
            if (method === 'DOM.resolveNode') return { object: { objectId: 'click-target' } };
            if (method === 'Runtime.callFunctionOn') {
              declarationCalls.push({ method, params });
              return { result: { value: { pageFeedbackPending: true, noDispatch: true, dispatched: false } } };
            }
            return {};
          };
          client.evaluateFunction = async (_tab, functionDeclaration, args) => {
            declarationCalls.push({ method: 'Runtime.callFunctionOn-global', functionDeclaration, args });
            return { result: { value: { pageFeedbackPending: true, noDispatch: true, dispatched: false } } };
          };
          client.evaluate = async () => { throw new Error('Fallback must pass guarded arguments, not build Runtime.evaluate source'); };
          const result = await client.clickElement(tab, '#target', { beforeDispatch: async () => ({ success: true }) });
          assert.equal(result.pageFeedbackPending, true);
          assert.equal(result.noDispatch, true);
          assert.equal(result.dispatched, false);
          const call = declarationCalls[0];
          const functionDeclaration = call.functionDeclaration || call.params.functionDeclaration;
          assert.match(functionDeclaration, /beforePageAgentDomAction\(pageGuard, 'focus'\)/);
          assert.match(functionDeclaration, /beforePageAgentDomAction\(pageGuard, 'click'\)/);
          const focusCall = functionDeclaration.includes('this.focus()') ? 'this.focus()' : 'el.focus()';
          const clickCall = functionDeclaration.includes('this.click()') ? 'this.click()' : 'el.click()';
          assert.ok(functionDeclaration.lastIndexOf("beforePageAgentDomAction(pageGuard, 'focus')") < functionDeclaration.indexOf(focusCall));
          assert.ok(functionDeclaration.lastIndexOf("beforePageAgentDomAction(pageGuard, 'click')") < functionDeclaration.indexOf(clickCall));
          const passedGuard = call.args
            ? call.args.at(-1)
            : call.params.arguments.at(-1).value;
          assert.deepEqual(passedGuard, responses.at(-1));
        }
      } finally {
        agent._finishPageFeedbackRun(tab);
        api.tabs.sendMessage = previousSendMessage;
      }
    });
  }

  test(`${build}: observations are isolated by run, frame, document and sequence`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    assert.equal(agent.pageMonitorState(sender(tab), 'a').active, false);
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const main = bind(agent, tab), child = bind(agent, tab, 2, 'child-doc', 'child-token');
      assert.equal(main.send({}).accepted, true);
      assert.equal(child.send({ kind: 'selection' }).accepted, true);
      assert.equal(agent.observePageFeedback(main.from, { ...main.state, seq: 1, kind: 'input', source: 'user' }).accepted, false);
      assert.equal(agent.observePageFeedback(sender(tab + 1), { ...main.state, seq: 2 }).accepted, false);
      assert.equal(agent.observePageFeedback(main.from, { ...main.state, seq: 2, runToken: 'old-run' }).accepted, false);
      agent.observePageNavigation({ tabId: tab, frameId: 0, documentId: 'document-2', url: 'https://example.com/new', transitionType: 'typed' }, 'committed');
      assert.equal(main.send({}).accepted, false);
      assert.equal(child.send({}).accepted, false);
      assert.equal(agent.pageMonitorState(main.from, 'old-document').active, false);
      const replacement = bind(agent, tab, 0, 'document-2', 'replacement');
      assert.equal(replacement.send({}).accepted, true);
    } finally { agent._releaseRunEntry(tab); }
    assert.equal(agent._pageFeedbackRuns.size, 0);
  });

  test(`${build}: run startup awaits every accessible frame and cleanup stops all of them`, async () => {
    const agent = setup(Agent), tab = nextTab++, entered = deferred(), release = deferred();
    const states = new Map([[0, false], [2, false]]);
    const previousNavigation = api.webNavigation, previousMessage = api.tabs.sendMessage;
    api.webNavigation = { getAllFrames: async () => [{ frameId: 0 }, { frameId: 2 }, { frameId: 9 }] };
    const sendFrame = async (frameId, message) => {
      if (frameId === 9) throw new Error('Restricted frame');
      if (message.action !== 'page_monitor_state') return {};
      if (frameId === 2 && message.active) { entered.resolve(); await release.promise; }
      states.set(frameId, message.active); return { ready: true };
    };
    // Model real broadcast semantics: all frames receive the message, but the
    // caller only waits for the first responding frame unless it targets each.
    api.tabs.sendMessage = async (_tab, message, options) => options?.frameId === undefined
      ? Promise.any([0, 2, 9].map(frameId => sendFrame(frameId, message))) : sendFrame(options.frameId, message);
    let complete = false;
    const starting = agent._claimRunEntry(tab, 'interactive').then(() => { complete = true; });
    try {
      await entered.promise;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(complete, false, 'A top-frame response must not bypass a delayed child acknowledgement');
      release.resolve(); await starting;
      assert.deepEqual([...states.values()], [true, true]);
      agent._releaseRunEntry(tab);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual([...states.values()], [false, false]);
    } finally {
      release.resolve(); await starting; agent._releaseRunEntry(tab);
      api.webNavigation = previousNavigation; api.tabs.sendMessage = previousMessage;
    }
  });

  test(`${build}: navigation bursts and DOM storms remain bounded and retain navigation intent`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const binding = bind(agent, tab);
      for (let i = 0; i < 100; i++) binding.send({ kind: 'dom', source: 'page', target: `button#${i}` });
      assert.equal(agent._pageFeedbackRuns.get(tab).events.size, 32);
      for (const [type, qualifiers] of [['history', []], ['fragment', []], ['committed', ['forward_back']]]) {
        agent.observePageNavigation({ tabId: tab, frameId: 0, url: `https://example.com/${type}`,
          transitionQualifiers: qualifiers, transitionType: type === 'history' ? 'typed' : 'link' }, type);
      }
      const navigation = [...agent._pageFeedbackRuns.get(tab).events.values()].find(event => event.kind === 'navigation');
      assert.equal(navigation.before, 'https://example.com/new');
      assert.equal(navigation.after, 'https://example.com/committed');
      assert.equal(navigation.source, 'user');
      for (let i = 0; i < 100; i++) agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 0, target: `div#storm${i}` });
      assert.equal(agent._pageFeedbackRuns.get(tab).events.size, 32);
      assert.ok([...agent._pageFeedbackRuns.get(tab).events.values()].some(event => event.kind === 'navigation'),
        'Animation/DOM storms must not evict the persistent main-frame navigation notice');
      const messages = [], updates = [];
      await agent._applyPendingPageFeedback(tab, messages, (type, data) => updates.push({ type, data }));
      assert.equal(updates.filter(update => update.data.navigation).length, 1);
      assert.match(messages[0].content, /navigationType/);
      assert.equal(agent._pageFeedbackRuns.get(tab).events.size, 0);
    } finally { agent._releaseRunEntry(tab); }
  });

  for (const streaming of [false, true]) {
    test(`${build}/${streaming ? 'stream' : 'chat'}: final-step page feedback suppresses a superseded completion`, async () => {
      const tab = nextTab++, entered = deferred(), release = deferred(), staleCompletion = 'The task is complete on the old page.';
      let providerCalls = 0, recoveryPrompt = '';
      const provider = { name: 'feedback final-step test', model: 'test', promptTier: 'full', contextWindow: 128000,
        supportsTools: true, supportsVision: false };
      provider.chat = async function (messages) {
        providerCalls++;
        if (providerCalls === 1 && !streaming) {
          entered.resolve(); await release.promise;
          return { content: staleCompletion, toolCalls: null };
        }
        recoveryPrompt = JSON.stringify(messages);
        return { content: null, toolCalls: [{ id: 'feedback_recovery_done',
          function: { name: 'done', arguments: JSON.stringify({ summary: 'The page changed before the task was verified.', outcome: 'partial' }) } }] };
      };
      if (streaming) {
        provider.chatStream = async function* () {
          providerCalls++;
          entered.resolve(); await release.promise;
          yield { type: 'text', content: staleCompletion };
          yield { type: 'done' };
        };
      }
      const agent = setup(Agent, provider), updates = [];
      agent.planBeforeAct = false;
      agent.maxSteps = 1;
      agent.autoScreenshot = 'off';
      agent._skipPermissionGate = true;
      agent._maybeRunPlannerGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: true });
      agent._maybeReinjectAdapter = async () => {};
      agent._ensureProgressSessionForCurrentTask = async () => ({ mode: 'inactive' });
      agent._currentTaskLedgerRows = () => [];
      agent._persist = () => {};
      const run = streaming ? agent.processMessageStream.bind(agent) : agent.processMessage.bind(agent);
      const running = run(tab, 'finish the existing task', (type, data) => updates.push({ type, data }), 'act');
      try {
        await entered.promise;
        const binding = bind(agent, tab);
        assert.equal(binding.send({ kind: 'input', source: 'user', target: 'input#filter' }).accepted, true);
        release.resolve();
        const final = await running;
        assert.equal(providerCalls, 2, 'Only the bounded step-limit handoff may follow the one allowed agent step');
        assert.equal(String(final).includes(staleCompletion), false, 'A completion formed against the previous page must be discarded');
        assert.ok(updates.some(update => update.type === 'page_feedback'), 'The current page observation should be delivered');
        assert.match(final, /page changed before the task was verified/i, 'The handoff must be based on the refreshed page context');
        assert.ok(recoveryPrompt.includes('BROWSER STATE UPDATE'), 'The bounded recovery receives the page feedback in its model context');
        assert.ok((agent.conversations.get(tab) || []).some(message => String(message.content || '').includes('BROWSER STATE UPDATE')),
          'The changed page state should be appended to the active model context');
      } finally {
        release.resolve();
        if (agent._pageFeedbackRuns.has(tab)) agent._finishPageFeedbackRun(tab);
        agent._releaseRunEntry(tab);
      }
    });
  }

  test(`${build}: viewport resize invalidates coordinates and waits for geometry to settle`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const binding = bind(agent, tab);
      agent.screenshotCaptures.set(tab, { captureId: 'stale-coordinates' });
      agent._jevSessions = new Map([[tab, { disabled: false, queue: ['prepared'], snapshot: {} }]]);
      assert.equal(binding.send({ kind: 'resize', source: 'unknown', target: 'viewport', viewport: { width: 900, height: 600, scale: 1 } }).accepted, true);
      assert.equal(agent.screenshotCaptures.has(tab), false);
      assert.equal(agent._jevSessions.get(tab).disabled, true);
      assert.deepEqual(agent._jevSessions.get(tab).queue, []);
      assert.equal(agent._pageFeedbackRuns.get(tab).lastUserAt, 0, 'Resize alone does not prove physical user input');
      assert.ok(agent._pageFeedbackRuns.get(tab).lastActivityAt > 0, 'Unknown geometry activity must settle before replanning');
      agent._pageFeedbackRuns.get(tab).lastActivityAt = 0;
      binding.send({ kind: 'resize', source: 'page', target: 'viewport', viewport: { width: 500, height: 200 } });
      assert.equal(agent._pageFeedbackRuns.get(tab).lastActivityAt, 0, 'Page layout changes to embedded frame dimensions must not extend the user idle gate');
    } finally { agent._releaseRunEntry(tab); }
  });

  test(`${build}: navigation arriving during a page read gets its own feedback ID`, async () => {
    const agent = setup(Agent), tab = nextTab++, entered = deferred(), release = deferred();
    const updates = [], messages = [];
    await agent._claimRunEntry(tab, 'interactive');
    try {
      agent.observePageNavigation({ tabId: tab, frameId: 0, url: 'https://example.com/first', transitionType: 'typed' }, 'history');
      agent.executeTool = async () => { entered.resolve(); await release.promise; return { success: true }; };
      const first = agent._applyPendingPageFeedback(tab, messages, (_type, data) => updates.push(data));
      await entered.promise;
      agent.observePageNavigation({ tabId: tab, frameId: 0, url: 'https://example.com/second', transitionType: 'typed' }, 'history');
      release.resolve();
      await first;
      await agent._applyPendingPageFeedback(tab, messages, (_type, data) => updates.push(data));
      assert.equal(updates.length, 2);
      assert.notEqual(updates[0].id, updates[1].id, 'Both navigation notices must survive UI deduplication');
      assert.equal(updates[0].after, 'https://example.com/first');
      assert.equal(updates[1].after, 'https://example.com/second');
    } finally { agent._releaseRunEntry(tab); }
  });

  for (const tool of ['navigate', 'go_back', 'go_forward']) {
    test(`${build}: ${tool} does not hide navigation during the unsaved-changes probe`, async () => {
      const agent = setup(Agent), tab = nextTab++, entered = deferred(), release = deferred();
      delete agent.executeTool;
      allowBatchPreparation(agent);
      const destination = 'https://example.com/destination';
      agent._probeUnsavedChanges = async () => {
        entered.resolve(); await release.promise;
        return { success: false, dispatched: false, noDispatch: true, error: 'Unsaved fields block navigation' };
      };
      await agent._claimRunEntry(tab, 'interactive');
      try {
        const action = agent.executeTool(tab, tool, { url: destination });
        await entered.promise;
        agent.observePageNavigation({ tabId: tab, frameId: 0, url: destination, transitionType: 'reload' }, 'history');
        const queuedDuringPreparation = agent._hasPendingPageFeedback(tab);
        release.resolve();
        assert.equal((await action).noDispatch, true);
        assert.equal(queuedDuringPreparation, true, 'Only a dispatched navigation may hide its own browser event');
      } finally { release.resolve(); agent._releaseRunEntry(tab); }
    });
  }

  test(`${build}: a child-frame click only correlates compatible frame navigation`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const child = bind(agent, tab, 2, 'child', 'child-token');
      child.send({ kind: 'activity', source: 'agent', operation: 'click' });
      for (const frameId of [0, 3, 2]) agent.observePageNavigation({ tabId: tab, frameId,
        url: `https://example.com/frame-${frameId}`, transitionType: 'link' }, 'history');
      const events = [...agent._pageFeedbackRuns.get(tab).events.values()];
      assert.deepEqual(events.map(event => event.frameId), [0, 3], 'Main and sibling changes must survive child-click correlation');
      agent._pageFeedbackRuns.get(tab).events.clear();
      child.send({ kind: 'activity', source: 'agent', operation: 'click', navigationTarget: '_top' });
      agent.observePageNavigation({ tabId: tab, frameId: 0, url: 'https://example.com/top', transitionType: 'link' }, 'history');
      assert.equal(agent._hasPendingPageFeedback(tab), false, 'An explicit _top click can correlate top-frame navigation');
      agent.observePageNavigation({ tabId: tab, frameId: 3, url: 'https://example.com/sibling', transitionType: 'link' }, 'history');
      assert.equal(agent._hasPendingPageFeedback(tab), true, 'A declared top target must still preserve sibling changes');
    } finally { agent._releaseRunEntry(tab); }
  });

  if (build === 'firefox') for (const transport of ['content', 'bidi']) {
    test(`firefox: ${transport} navigation skips dispatch after feedback during an allowed probe`, async () => {
      const { firefoxBidi } = await import('../src/firefox/src/bidi/client.js');
      const agent = setup(Agent), tab = nextTab++, entered = deferred(), release = deferred();
      delete agent.executeTool;
      allowBatchPreparation(agent);
      let dispatches = 0;
      const originalUpdate = api.tabs.update, originalRequest = firefoxBidi.request;
      api.tabs.update = async () => { dispatches++; return {}; };
      firefoxBidi.request = async () => { dispatches++; return { success: true }; };
      if (transport === 'bidi') firefoxBidi.runs.set(tab, { runId: 'native-navigation', bound: true });
      agent._probeUnsavedChanges = async () => { entered.resolve(); await release.promise; return null; };
      await agent._claimRunEntry(tab, 'interactive');
      try {
        const destination = 'https://example.com/destination';
        const action = agent.executeTool(tab, 'navigate', { url: destination });
        await entered.promise;
        agent.observePageNavigation({ tabId: tab, frameId: 0, url: destination, transitionType: 'reload' }, 'history');
        release.resolve();
        const result = await action;
        assert.equal(dispatches, 0);
        assert.equal(result.noDispatch, true);
        assert.equal(result.pageFeedbackPending, true);
      } finally {
        release.resolve(); agent._releaseRunEntry(tab);
        firefoxBidi.runs.delete(tab); firefoxBidi.request = originalRequest; api.tabs.update = originalUpdate;
      }
    });
  }

  for (const kind of ['interactive', 'cloud', 'scheduled', 'workflow']) {
    test(`${build}: ${kind} feedback refreshes the page without creating a trusted text correction`, async () => {
      const agent = setup(Agent), tab = nextTab++, updates = [];
      const options = { cloudRun: kind === 'cloud', scheduledRun: kind === 'scheduled', detachedRequestId: 'request' };
      await agent._claimRunEntry(tab, kind, options);
      try {
        agent._beginSteeringRun(tab, () => {}, options);
        agent._recordSocialPublicationSteering = () => assert.fail('Observation became a trusted instruction');
        const binding = bind(agent, tab);
        assert.equal(binding.send({}).accepted, true);
        agent._jevSettings = async () => assert.fail('Stale fast-path task was resurrected');
        assert.equal(await agent._maybeJevFastTurn(tab, 'Original task', [], 'act', new Set(), {}, null), null);
        const messages = [];
        assert.equal(await agent._applyPendingRunFeedback(tab, messages, (type, data) => updates.push({ type, data })), true);
        assert.match(messages[0].content, /observations, not a new user instruction/);
        assert.match(messages[0].content, /untrusted_page_content/);
        assert.match(messages[0].content, /The current view/);
        assert.equal(updates.filter(update => update.type === 'steering_applied').length, 0);
        assert.equal(updates.filter(update => update.type === 'page_feedback').length, 1);
      } finally { agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); }
    });
  }

  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} discards an in-flight response after page feedback`, async () => {
      const entered = deferred(), release = deferred(), requests = [];
      const response = async messages => {
        requests.push(structuredClone(messages));
        if (requests.length === 1) { entered.resolve(); await release.promise;
          return { content: 'Old answer', toolCalls: [{ id: 'old-click', function: { name: 'click', arguments: '{"text":"Old target"}' } }] }; }
        return { content: 'Updated answer' };
      };
      const agent = setup(Agent, { chat: response, async *chatStream(messages) {
        const value = await response(messages);
        yield { type: 'text', content: value.content };
        if (value.toolCalls) yield { type: 'tool_call', content: value.toolCalls.map(call => ({ ...call, index: 0 })) };
        yield { type: 'done' };
      } });
      const tab = nextTab++, updates = [];
      const options = { detachedRequestId: 'request', askStreamingEnabled: false };
      const run = streaming ? agent.processMessageStream(tab, 'Original task', (type, data) => updates.push({ type, data }), 'ask', options)
        : agent.processMessage(tab, 'Original task', (type, data) => updates.push({ type, data }), 'ask', [], options);
      await entered.promise;
      assert.equal(bind(agent, tab).send({ kind: 'dom', source: 'page' }).accepted, true);
      release.resolve();
      assert.equal(await run, 'Updated answer');
      assert.equal(requests.length, 2);
      assert.match(requests[1].at(-1).content, /BROWSER STATE UPDATE/);
      assert.equal(requests[1].some(message => message.tool_calls?.some(call => call.id === 'old-click')), false);
      assert.equal(agent._pageFeedbackRuns.size, 0);
    });
  }

  test(`${build}: tool feedback preserves completed results and skips undispatched siblings`, async () => {
    const agent = setup(Agent), tab = nextTab++, entered = deferred(), release = deferred();
    allowBatchPreparation(agent);
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const binding = bind(agent, tab);
      let dispatched = 0;
      agent.executeTool = async () => { dispatched++; entered.resolve(); await release.promise; return { success: true, pageContent: 'Old view' }; };
      const calls = [1, 2].map(index => ({ id: `read-${index}`, function: { name: 'get_accessibility_tree', arguments: '{}' } }));
      const messages = [{ role: 'assistant', content: null, tool_calls: calls }];
      const result = agent._executeToolBatch(tab, calls, messages, () => {}, {}, null, new Set(['get_accessibility_tree']), 1);
      await entered.promise;
      binding.send({ kind: 'scroll' }); release.resolve();
      assert.equal((await result).action, 'continue');
      assert.equal(dispatched, 1);
      assert.equal(messages.filter(message => message.role === 'tool').length, 2);
      assert.equal(JSON.parse(messages.at(-1).content).pageFeedbackPending, true);
      assert.equal(JSON.parse(messages.at(-1).content).noDispatch, true);
    } finally { agent._releaseRunEntry(tab); }
  });

  test(`${build}: the idle gate restarts for physical activity, not automatic DOM updates, and Stop wakes it`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    agent._pageFeedbackIdleMs = 40;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const binding = bind(agent, tab);
      binding.send({});
      const at = agent._pageFeedbackRuns.get(tab).lastUserAt;
      binding.send({ kind: 'dom', source: 'user' });
      assert.equal(agent._pageFeedbackRuns.get(tab).lastUserAt, at);
      const started = Date.now();
      await agent._waitForPageFeedbackIdle(tab);
      assert.ok(Date.now() - started >= 30);
      binding.send({ kind: 'scroll', source: 'user' });
      const externalScrollAt = Date.now();
      await agent._waitForPageFeedbackIdle(tab);
      assert.ok(Date.now() - externalScrollAt >= 30, 'A physical scroll receives the idle gate');
      binding.send({ kind: 'click', source: 'user' });
      const automaticScrollAt = Date.now();
      const ticker = setInterval(() => binding.send({ kind: 'scroll', source: 'unknown' }), 5);
      try { await agent._waitForPageFeedbackIdle(tab); }
      finally { clearInterval(ticker); }
      assert.ok(Date.now() - automaticScrollAt >= 30 && Date.now() - automaticScrollAt < 100,
        'Repeated unattributed scroll events must not restart the physical-input idle deadline');
      binding.send({ kind: 'activity', interacting: true });
      const waiting = agent._waitForPageFeedbackIdle(tab);
      agent.abort(tab);
      await assert.rejects(waiting, { name: 'AbortError' });
    } finally { agent._releaseRunEntry(tab); }
  });

  test(`${build}: native dispatch checks feedback after preparation and correlates agent navigation`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const binding = bind(agent, tab);
      await beforePageAgentDispatch(api, tab, { kind: 'navigate', url: 'https://example.com/destination' });
      agent.observePageNavigation({ tabId: tab, frameId: 0, url: 'https://example.com/destination', transitionType: 'link' }, 'history');
      assert.equal(agent._hasPendingPageFeedback(tab), false);
      await beforePageAgentDispatch(api, tab, { kind: 'navigate', history: true });
      agent.observePageNavigation({ tabId: tab, frameId: 0, url: 'https://example.com/agent-back', transitionQualifiers: ['forward_back'] }, 'history');
      assert.equal(agent._hasPendingPageFeedback(tab), false);
      await beforePageAgentDispatch(api, tab, { kind: 'click', selector: '#old' });
      agent.observePageNavigation({ tabId: tab, frameId: 0, url: 'https://example.com/manual-back', transitionQualifiers: ['forward_back'] }, 'history');
      assert.equal(agent._hasPendingPageFeedback(tab), true, 'A browser Back action is not the preceding agent click');
      binding.send({});
      await assert.rejects(beforePageAgentDispatch(api, tab, { kind: 'input' }), { code: 'page_feedback_pending' });
      await beforePageAgentDispatch(api, tab, { kind: 'input', release: true });
      await beforePageAgentDispatch(api, tab, { kind: 'input', release: true, documentToken: 'navigated-away-document' });
      agent.observePageNavigation({ tabId: tab, frameId: 0, url: 'https://example.com/manual', transitionType: 'typed' }, 'history');
      const messages = [], updates = [];
      await agent._applyPendingPageFeedback(tab, messages, (type, data) => updates.push({ type, data }));
      assert.equal(updates.at(-1).data.navigation, true);
      assert.equal(updates.at(-1).data.after, 'https://example.com/manual');
    } finally { agent._releaseRunEntry(tab); }
  });

  test(`${build}: frame click preparation installs a fence without claiming the click`, async () => {
    const agent = setup(Agent), tab = nextTab++, previousMessage = api.tabs.sendMessage;
    const messages = [];
    api.tabs.sendMessage = async (_tab, message, options) => {
      messages.push({ message, frameId: options?.frameId });
      if (message.action === 'page_monitor_dispatch') return { ready: true, guard: {
        documentToken: 'child-token', revision: 0, operationId: message.params.operationId,
        navigationCandidate: true,
      } };
      return { ready: true };
    };
    await agent._claimRunEntry(tab, 'interactive');
    try {
      bind(agent, tab, 2, 'child-doc', 'child-token');
      const run = agent._pageFeedbackRuns.get(tab);
      run.navigation = { at: Date.now(), url: '', kind: 'click', frameId: 2 };
      const guard = await beforePageAgentDispatch(api, tab, {
        kind: 'click', selector: '#inside', frameId: 2, fenceOnly: true, prepareMonitor: true,
      });
      assert.equal(guard.operationId, messages.find(entry => entry.message.action === 'page_monitor_dispatch').message.params.operationId);
      assert.deepEqual(messages.filter(entry => ['page_monitor_prepare', 'page_monitor_dispatch'].includes(entry.message.action))
        .map(entry => entry.message.action), ['page_monitor_prepare', 'page_monitor_dispatch']);
      assert.equal(messages.at(-1).frameId, 2);
      assert.equal(messages.at(-1).message.params.fenceOnly, true);
      assert.equal(run.navigation.kind, 'click', 'A preparation fence cannot consume an earlier navigation correlation');
    } finally {
      agent._releaseRunEntry(tab);
      api.tabs.sendMessage = previousMessage;
    }
  });

  test(`${build}: intervention during the dispatch handshake blocks the prepared action`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const binding = bind(agent, tab);
      await assert.rejects(beforePageAgentDispatch({ tabs: { sendMessage: async (_tab, _msg, options) => {
        assert.equal(options.frameId, 0);
        binding.send({ kind: 'click', target: 'button#new' });
      } } }, tab, { kind: 'click', selector: '#old' }), { code: 'page_feedback_pending' });
      assert.equal(agent._hasPendingPageFeedback(tab), true);
    } finally { agent._releaseRunEntry(tab); }
  });

  test(`${build}: click preparation and proven no-dispatch navigation do not hide external navigation`, async () => {
    const { installPageFeedback } = await import(`../src/${build}/src/agent/page-feedback.js`);
    class FixtureAgent {
      static STATE_CHANGE_TOOLS = new Set(['click', 'navigate']);
      isRunning() { return true; }
      _checkAbort() { return false; }
      async executeTool(tabId, name) {
        await beforePageAgentDispatch(api, tabId, { kind: name });
        if (name === 'click') {
          this.observePageNavigation({ tabId, frameId: 0, url: 'https://example.com/reloaded', transitionType: 'reload' }, 'committed');
          assert.equal(this._hasPendingPageFeedback(tabId), true, 'Preparation must not arm click navigation correlation');
        }
        return { success: false, dispatched: false, noDispatch: true };
      }
    }
    installPageFeedback(FixtureAgent);
    const agent = new FixtureAgent(), tab = nextTab++;
    await agent._beginPageFeedbackRun(tab, 'interactive');
    try {
      const click = await agent.executeTool(tab, 'click', {});
      assert.equal(click.pageFeedbackPending, true);
      agent._pageFeedbackRuns.get(tab).events.clear();
      await agent.executeTool(tab, 'navigate', {});
      assert.equal(agent._pageFeedbackRuns.get(tab).navigation, null, 'Failed navigation must release its correlation');
      agent.observePageNavigation({ tabId: tab, frameId: 0, url: 'https://example.com/automatic', transitionType: 'reload' }, 'committed');
      assert.equal(agent._hasPendingPageFeedback(tab), true);
    } finally { agent._finishPageFeedbackRun(tab); }
  });

  test(`${build}: finishing an action releases attribution in all dispatched frames`, async () => {
    const { installPageFeedback } = await import(`../src/${build}/src/agent/page-feedback.js`);
    class FixtureAgent {
      static STATE_CHANGE_TOOLS = new Set(['click']);
      isRunning() { return true; }
      _checkAbort() { return false; }
      async executeTool(tabId) {
        await beforePageAgentDispatch(api, tabId, { kind: 'click', frameId: 2 });
        return { success: true };
      }
    }
    installPageFeedback(FixtureAgent);
    const agent = new FixtureAgent(), tab = nextTab++, finished = [];
    const originalMessage = api.tabs.sendMessage;
    api.tabs.sendMessage = async (_tab, message, options) => {
      if (message.action === 'page_monitor_finish') finished.push(options.frameId);
      return {};
    };
    try {
      await agent._beginPageFeedbackRun(tab, 'interactive');
      assert.equal((await agent.executeTool(tab, 'click', {})).success, true);
      assert.deepEqual(finished.sort(), [0, 2]);
    } finally { agent._finishPageFeedbackRun(tab); api.tabs.sendMessage = originalMessage; }
  });

  test(`${build}: feedback interruption after dispatch retains uncertain action evidence`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    agent.executeTool = Agent.prototype.executeTool;
    agent._uncertainTextMutationBlock = async () => null;
    agent._executeToolImpl = async (_tab, _name, _args, _update, context) => {
      context._contentActionDispatchState.started = true;
      const error = new Error('External interaction after pointer down');
      error.code = 'page_feedback_pending'; throw error;
    };
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const result = await agent.executeTool(tab, 'click', { text: 'Continue' });
      assert.equal(result.dispatched, true);
      assert.equal(result.outcomeUnknown, true);
      assert.notEqual(result.noDispatch, true);
      assert.equal(result.retryable, false);
    } finally { agent._releaseRunEntry(tab); }
  });

  test(`${build}: click navigation markers expire after one event and redirects stay document-scoped`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      let binding = bind(agent, tab);
      binding.send({ kind: 'activity', source: 'agent', operation: 'click' });
      agent.observePageNavigation({ tabId: tab, frameId: 0, documentId: 'agent-document',
        url: 'https://example.com/destination', transitionType: 'link' }, 'committed');
      assert.equal(agent._hasPendingPageFeedback(tab), false, 'The click-caused commit is correlated');
      assert.equal(agent._pageFeedbackRuns.get(tab).navigation, null, 'The click marker is consumed after commit');
      agent.observePageNavigation({ tabId: tab, frameId: 0, documentId: 'timer-reload',
        url: 'https://example.com/destination', transitionType: 'reload' }, 'committed');
      assert.equal(agent._hasPendingPageFeedback(tab), true, 'A later reload to the same URL is still visible');
      assert.equal([...agent._pageFeedbackRuns.get(tab).events.values()].at(-1).source, 'unknown');

      agent._pageFeedbackRuns.get(tab).events.clear();
      binding = bind(agent, tab, 0, 'timer-reload', 'content-timer-reload');
      binding.send({ kind: 'activity', source: 'agent', operation: 'click' });
      agent.observePageNavigation({ tabId: tab, frameId: 0, documentId: 'redirected-document',
        url: 'https://example.com/final', transitionType: 'link', transitionQualifiers: ['server_redirect'] }, 'committed');
      assert.equal(agent._hasPendingPageFeedback(tab), false, 'An identified redirect is part of the click navigation');
      assert.equal(agent._pageFeedbackRuns.get(tab).navigation.documentId, 'redirected-document');
      agent.observePageNavigation({ tabId: tab, frameId: 0, documentId: 'redirected-document',
        url: 'https://example.com/final-two', transitionType: 'link', transitionQualifiers: ['client_redirect'] }, 'committed');
      assert.equal(agent._hasPendingPageFeedback(tab), false, 'Redirect continuation stays on its exact document');
      agent.observePageNavigation({ tabId: tab, frameId: 0, documentId: 'later-navigation',
        url: 'https://example.com/automatic', transitionType: 'reload' }, 'committed');
      assert.equal(agent._hasPendingPageFeedback(tab), true, 'A later navigation outside the redirect chain is visible');
      assert.equal(agent._pageFeedbackRuns.get(tab).navigation, null);
    } finally { agent._releaseRunEntry(tab); }
  });

  test(`${build}: content feedback uses authenticated sender identity; composer delivery never gates monitoring`, async () => {
    const agent = setup(Agent), tab = nextTab++;
    await agent._claimRunEntry(tab, 'cloud', { cloudRun: true });
    try {
      const source = fs.readFileSync(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8');
      const start = source.indexOf('async function handleMessage(msg, sender) {');
      const end = source.indexOf("  if (msg.action === 'chat_steer')", start);
      const context = vm.createContext({ agent });
      vm.runInContext(`${source.slice(start, end)} }`, context);
      const state = await context.handleMessage({ action: 'get_page_monitor_state', documentToken: 'doc' }, sender(tab));
      assert.equal(state.active, true);
      assert.equal((await context.handleMessage({ action: 'page_feedback', tabId: tab, feedback: {
        ...state, seq: 1, kind: 'click', source: 'user' } }, {})).accepted, false);
      assert.equal((await context.handleMessage({ action: 'page_feedback', feedback: {
        ...state, seq: 1, kind: 'click', source: 'user' } }, sender(tab))).accepted, true);
      assert.equal(source.slice(start, end).includes('composerDeliveryMode'), false);
    } finally { agent._releaseRunEntry(tab); }
  });

  for (const change of ['valid', 'scope', 'target']) {
    test(`${build}: workflow revalidates an undispatched step after ${change} feedback`, async () => {
      const agent = setup(Agent), tab = nextTab++, updates = [], dispatched = [];
      agent.ensureConversationId = async () => 'workflow-conversation';
      agent._startSavedWorkflowTraceRun = async () => null;
      agent._endSavedWorkflowTraceRun = async () => {};
      agent._promptWorkflowTargetHealing = async () => null;
      let changed = false, attempt = 0;
      agent._currentUrl = async () => changed && change === 'scope' ? 'https://other.example/new' : 'https://example.com/new';
      agent.executeTool = async (_tab, name) => {
        assert.equal(name, 'get_accessibility_tree');
        return { success: true, pageContent: changed && change === 'target' ? 'main "Missing target" [ref_main]'
          : `button "Continue" [ref_${changed ? 'fresh' : 'old'}] id="continue"` };
      };
      agent._executeToolBatch = async (_tab, calls, _messages, update) => {
        const call = calls[0];
        if (call.function.name === 'scroll') {
          dispatched.push('scroll');
          update('tool_result', { name: 'scroll', result: { success: true } });
        } else if (attempt++ === 0) {
          const binding = bind(agent, tab);
          changed = true;
          binding.send({ kind: 'dom', source: 'page', target: 'button#continue' });
          if (change === 'scope') agent.observePageNavigation({ tabId: tab, frameId: 0,
            url: 'https://other.example/new', transitionType: 'typed' }, 'history');
          update('tool_result', { name: 'click_ax', result: { success: false, noDispatch: true, pageFeedbackPending: true } });
        } else {
          dispatched.push(JSON.parse(call.function.arguments).ref_id);
          update('tool_result', { name: 'click_ax', result: { success: true, dispatched: true, verified: true } });
        }
        return { action: 'continue' };
      };
      const scope = { origin: 'https://example.com', pathFamily: '/new' };
      const workflow = { id: 'monitor-workflow', name: 'Continue workflow', start: scope,
        steps: [{ id: 'scroll', tool: 'scroll', args: { direction: 'down' }, expected: { kind: 'tool_success' } },
          { id: 'click', tool: 'click_ax', scope, args: {}, target: { role: 'button', name: 'Continue', id: 'continue' },
            expected: { kind: 'tool_verified' } }] };
      const result = await agent.replaySavedWorkflow(tab, workflow, {}, (type, data) => updates.push({ type, data }));
      if (change === 'valid') {
        assert.equal(result.status, 'completed');
        assert.equal(result.matchedSteps, 2);
        assert.deepEqual(dispatched, ['scroll', 'ref_fresh']);
      } else {
        assert.equal(result.status, 'fallback');
        assert.equal(result.matchedSteps, 1);
        assert.deepEqual(dispatched, ['scroll']);
        assert.match(result.prompt, /from step 2/);
        assert.match(result.prompt, /BROWSER STATE UPDATE/);
        assert.match(result.prompt, /untrusted_page_content/);
      }
      assert.ok(updates.some(update => update.type === 'page_feedback'));
      assert.equal(agent._pageFeedbackRuns.size, 0);
    });
  }

  test(`${build}: cloud feedback redacts navigation details in both secret modes`, async () => {
    const { createCloudRunController } = await import(`../src/${build}/src/cloud-runs.js`);
    for (const strictSecretMode of [false, true]) {
      const agent = { isRunning: () => false, strictSecretMode, abort() {},
        async processMessage(_tab, _task, update, _mode, _attachments, options) {
          update('page_feedback', { id: 'navigation-id', source: 'user', kinds: ['navigation'], navigation: true,
            before: 'https://user:password@example.com/?private=value', after: 'https://example.com/?secret=token',
            page: 'Sensitive contents' });
          options.onRunFinished('done'); return 'Finished';
        } };
      const controller = createCloudRunController({ chromeApi: { ...api,
        tabs: { ...api.tabs, update: async () => {}, query: async () => [{ id: tab, url: 'https://example.com' }] } }, agent,
        makeRunId: () => `cloud-feedback-${strictSecretMode}`, ensureOffscreen: async () => {} });
      const tab = nextTab++;
      const run = await controller.startRun({ task: 'Read this page', tabId: tab });
      for (let i = 0; i < 100 && controller.runs.get(run.runId).status === 'running'; i++) await new Promise(r => setTimeout(r, 5));
      const done = await controller.status({ runId: run.runId });
      const note = done.updates.find(update => update.type === 'page_feedback');
      assert.equal(note.data.navigation, true);
      assert.equal(note.data.id, 'navigation-id');
      assert.equal(/password|private=value|secret=token|Sensitive contents/.test(JSON.stringify(note)), false);
    }
  });

  test(`${build}: scheduled feedback carries the owning job identity`, async () => {
    const module = await import(`../src/${build}/src/agent/scheduler.js`);
    const now = Date.UTC(2026, 0, 1, 12), iso = new Date(now).toISOString();
    const harness = makeSchedulerHarness(module, { now, jobs: [{ id: 'monitor-job', kind: 'task', status: 'pending',
      tabId: 77, mode: 'act', prompt: 'Read the page', title: 'Read', target: { type: 'current_tab', tabId: 77,
        originalUrl: 'https://example.com/' }, schedule: { type: 'once' }, nextRunAt: iso, scheduledAt: iso, runCount: 0 }],
      processMessage: async (_tab, _message, update, _mode, _attachments, options) => {
        update('page_feedback', { id: 'scheduled-notice', navigation: true, source: 'user', kinds: ['navigation'] });
        update('tool_result', { name: 'done', result: { done: true, success: true, outcome: 'success' } });
        options.onRunFinished?.('done'); return 'Finished';
      } });
    await harness.manager.handleAlarm(harness.alarmName('monitor-job'));
    for (let i = 0; i < 100 && !harness.updates.some(update => update.type === 'page_feedback'); i++) await new Promise(r => setTimeout(r, 5));
    const note = harness.updates.find(update => update.type === 'page_feedback');
    assert.equal(note.tabId, 77);
    assert.equal(note.data.scheduledJobId, 'monitor-job');
    assert.equal(note.data.id, 'scheduled-notice');
  });
}

test('shared page monitoring modules stay identical between browser builds', () => {
  for (const file of ['agent/page-feedback.js', 'content/page-monitor.js', 'content/page-monitor-shadow.js', 'ui/page-feedback-ui.js']) {
    const read = build => fs.readFileSync(new URL(`../src/${build}/src/${file}`, import.meta.url), 'utf8');
    assert.equal(read('chrome'), read('firefox'));
  }
});

test('Firefox supplements empty-frame monitoring after document start', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../src/firefox/manifest.json', import.meta.url), 'utf8'));
  const monitor = manifest.content_scripts.find(entry => entry.run_at === 'document_end' && entry.js.includes('src/content/page-monitor.js'));
  assert.ok(monitor); assert.equal(monitor.all_frames, true); assert.equal(monitor.match_about_blank, true);
  assert.deepEqual(monitor.js, ['src/content/page-monitor-recovery.js', 'src/content/page-monitor.js']);
  const shadow = manifest.content_scripts.find(entry => entry.run_at === 'document_end' && entry.world === 'MAIN'
    && entry.js.includes('src/content/page-monitor-shadow.js'));
  assert.ok(shadow); assert.equal(shadow.all_frames, true); assert.equal(shadow.match_about_blank, true);
});

test('both manifests signal shadow attachment from MAIN in all monitored frames', () => {
  for (const build of ['chrome', 'firefox']) {
    const manifest = JSON.parse(fs.readFileSync(new URL(`../src/${build}/manifest.json`, import.meta.url), 'utf8'));
    const entry = manifest.content_scripts.find(item => item.js.includes('src/content/page-monitor-shadow.js'));
    assert.equal(entry.world, 'MAIN');
    assert.equal(entry.run_at, 'document_start');
    assert.equal(entry.all_frames, true);
    assert.equal(entry.match_about_blank, true);
  }
});

test('monitor registrations include related-origin frames in both execution worlds', () => {
  for (const build of ['chrome', 'firefox']) {
    const manifest = JSON.parse(fs.readFileSync(new URL(`../src/${build}/manifest.json`, import.meta.url), 'utf8'));
    const entries = manifest.content_scripts.filter(entry => entry.js.some(file => /\/page-monitor(?:-shadow)?\.js$/.test(file)));
    assert.equal(entries.length, build === 'firefox' ? 4 : 2);
    for (const entry of entries) assert.ok(entry.all_frames && entry.match_about_blank && entry.match_origin_as_fallback);
  }
});

for (const path of ['local', 'memory']) {
  for (const intervention of ['preparation', 'handshake', 'none']) {
    test(`Chrome ${path} upload honors feedback arriving during ${intervention}`, async () => {
      const { Agent } = await import('../src/chrome/src/agent/agent.js');
      const { CDPClient } = await import('../src/chrome/src/cdp/cdp-client.js');
      const agent = setup(Agent), tab = nextTab++, mutations = [], notices = [];
      await agent._claimRunEntry(tab, 'interactive');
      const originalMessage = api.tabs.sendMessage;
      try {
        const binding = bind(agent, tab), child = bind(agent, tab, 2, 'upload-doc', 'upload-token');
        const client = new CDPClient();
        client._pageAgentObjectTarget = async () => {
          if (intervention === 'preparation') binding.send({ kind: 'click' });
          return { documentToken: child.state.documentToken, documentRevision: 0, nativeTarget: 'upload-target' };
        };
        api.tabs.sendMessage = async (_tab, message, options) => {
          if (message.action === 'page_monitor_dispatch') {
            assert.equal(options.frameId, 2);
            notices.push(message);
            if (intervention === 'handshake') binding.send({ kind: 'click' });
          }
          return {};
        };
        client.sendCommand = async (_tab, method, params) => {
          if (method === 'DOM.setFileInputFiles' || method === 'Runtime.callFunctionOn') mutations.push(method);
          return { result: { value: { success: true, dispatched: true } } };
        };
        let started = false;
        const options = { beforeDispatch: () => { started = true; } };
        const upload = path === 'local' ? client.setFileInputFiles(tab, 'file-input', ['fixture.txt'], options)
          : client.setFileInputData(tab, 'file-input', { base64: 'eA==', filename: 'fixture.txt' }, options);
        if (intervention === 'none') {
          assert.equal((await upload).success, true);
          assert.equal(started, true);
          assert.equal(mutations.length, 1);
          assert.equal(notices.length, 1);
        } else {
          await assert.rejects(upload, { code: 'page_feedback_pending' });
          assert.equal(started, false);
          assert.equal(mutations.length, 0);
        }
      } finally { api.tabs.sendMessage = originalMessage; agent._releaseRunEntry(tab); }
    });
  }
}
