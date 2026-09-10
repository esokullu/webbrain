import assert from 'node:assert/strict';
import { test } from 'node:test';

const storage = new Map();
const area = {
  async get(key) { return typeof key === 'string' ? { [key]: storage.get(key) } : Object.fromEntries(storage); },
  async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value)); },
  async remove(key) { storage.delete(key); },
};
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const variants = await Promise.all(['chrome', 'firefox'].map(async browser => [browser, (await import(`../src/${browser}/src/agent/agent.js`)).Agent]));
const tabId = 41;
const scope = { documentToken: 'document-1', pageUrl: 'https://example.com/' };
const args = { ref_id: 'ref_1', text: 'new value', clear: true };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const abortError = () => Object.assign(new Error('Stopped by user'), { name: 'AbortError' });
const noReceiverError = () => new Error('Could not establish connection. Receiving end does not exist.');

function setup(Agent) {
  const provider = { name: 'local test', model: 'test', promptTier: 'full', contextWindow: 128000, supportsTools: true };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._currentUrl = async () => scope.pageUrl;
  agent._isPdfTab = async () => false;
  agent._liveTextMutationScope = async () => scope;
  agent._lastAxScopes.set(tabId, scope);
  agent._chromeProtectedPageFailure = async () => null;
  agent._richTextToolbarToolBlock = async () => null;
  agent._textMutationValueDigest = async () => null;
  agent._injectCoreContentScripts = async () => { agent.injections++; };
  agent.injections = 0;
  agent.writes = 0;
  agent.sendWrite = async () => ({ success: true, verified: true, dispatched: true });
  api.tabs.sendMessage = async (_id, message) => {
    if (message.action === 'set_field') { agent.writes++; return agent.sendWrite(); }
    return { success: false, documentToken: scope.documentToken, refScopeUrl: scope.pageUrl };
  };
  return agent;
}

function assertUncertain(agent, result, dispatchState) {
  assert.equal(result.success, false);
  assert.equal(result.dispatched, true);
  assert.notEqual(result.noDispatch, true);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.mutationMayHaveOccurred, true);
  assert.equal(result.verified, false);
  assert.equal(result.retryable, false);
  assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
  if (dispatchState) assert.equal(dispatchState.started, true);
}

async function assertNextRunBlocked(agent) {
  agent._releaseRunEntry(tabId);
  await agent._claimRunEntry(tabId, 'interactive');
  const before = agent.writes;
  const retry = await agent.executeTool(tabId, 'set_field', { ...args, text: 'an append', clear: false });
  assert.equal(retry.repeatBlocked, true);
  assert.equal(retry.recoveryRequired, 'verify_or_restore_field');
  assert.equal(retry.noDispatch, true);
  assert.equal(agent.writes, before);
  agent._releaseRunEntry(tabId);
}

for (const [browser, Agent] of variants) {
  for (const stage of ['before entry', 'preparation']) {
    test(`${browser}: text cancellation ${stage} proves no dispatch and creates no debt`, async () => {
      const agent = setup(Agent);
      await agent._claimRunEntry(tabId, 'interactive');
      const entered = deferred(); const release = deferred();
      if (stage === 'before entry') agent.abort(tabId);
      else agent._richTextToolbarToolBlock = async () => { entered.resolve(); await release.promise; return null; };
      const dispatchState = { started: false };
      const pending = agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: dispatchState });
      if (stage === 'preparation') { await entered.promise; agent.abort(tabId); release.resolve(); }
      const result = await pending;
      assert.equal(result.cancelled, true);
      assert.equal(result.dispatched, false);
      assert.equal(result.noDispatch, true);
      assert.equal(result.outcomeUnknown, false);
      assert.equal(dispatchState.started, false);
      assert.equal(agent.writes, 0);
      assert.equal(agent.injections, 0);
      assert.equal(agent._uncertainTextMutations.has(tabId), false);
      agent._releaseRunEntry(tabId);
    });
  }

  test(`${browser}: Stop after a real content send records debt and blocks the next run`, async () => {
    const agent = setup(Agent); const entered = deferred(); const release = deferred();
    await agent._claimRunEntry(tabId, 'interactive');
    agent.sendWrite = () => { entered.resolve(); return release.promise; };
    const dispatchState = { started: false };
    const pending = agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: dispatchState });
    await entered.promise; agent.abort(tabId);
    const result = await pending;
    assert.equal(result.cancelled, true);
    assertUncertain(agent, result, dispatchState);
    assert.equal(agent.injections, 0);
    await assertNextRunBlocked(agent);
    release.resolve({ success: true, dispatched: true, verified: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1, 'a late unobserved reply must not erase the debt');
    assert.equal(agent.writes, 1);
  });

  for (const failure of ['AbortError', 'closed channel']) {
    test(`${browser}: a dispatched ${failure} never reinjects or retries the text write`, async () => {
      const agent = setup(Agent);
      await agent._claimRunEntry(tabId, 'interactive');
      agent.sendWrite = async () => { throw failure === 'AbortError' ? abortError() : new Error('The message port closed before a response was received.'); };
      const result = await agent.executeTool(tabId, 'set_field', args);
      assertUncertain(agent, result);
      assert.equal(result.cancelled === true, failure === 'AbortError');
      assert.equal(agent.writes, 1);
      assert.equal(agent.injections, 0);
      await assertNextRunBlocked(agent);
    });
  }

  test(`${browser}: explicit missing receiver permits one preparation/retry and verified success`, async () => {
    const agent = setup(Agent);
    agent.sendWrite = async () => {
      if (agent.writes === 1) throw noReceiverError();
      return { success: true, dispatched: true, verified: true };
    };
    const result = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(agent.writes, 2);
    assert.equal(agent.injections, 1);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
  });

  for (const stage of ['injection', 'retry send']) {
    test(`${browser}: Stop during ${stage} after missing receiver preserves dispatch evidence`, async () => {
      const agent = setup(Agent); const entered = deferred(); const release = deferred();
      await agent._claimRunEntry(tabId, 'interactive');
      agent.sendWrite = () => {
        if (agent.writes === 1) return Promise.reject(noReceiverError());
        entered.resolve(); return release.promise;
      };
      if (stage === 'injection') agent._injectCoreContentScripts = async () => { agent.injections++; entered.resolve(); await release.promise; };
      const dispatchState = { started: false };
      const pending = agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: dispatchState });
      await entered.promise; agent.abort(tabId);
      const result = await pending;
      assert.equal(result.cancelled, true);
      if (stage === 'retry send') {
        assertUncertain(agent, result, dispatchState);
        await assertNextRunBlocked(agent);
      } else {
        assert.equal(result.noDispatch, true);
        assert.equal(result.outcomeUnknown, false);
        assert.equal(dispatchState.started, false);
        assert.equal(agent._uncertainTextMutations.has(tabId), false);
        agent._releaseRunEntry(tabId);
      }
      release.resolve({ success: true, dispatched: true, verified: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(agent.writes, stage === 'injection' ? 1 : 2);
      assert.equal(agent.injections, 1);
    });
  }

  test(`${browser}: content deadline rejected before mutation clears dispatch evidence`, async () => {
    const agent = setup(Agent); const dispatchState = { started: false };
    agent.sendWrite = async () => ({ success: false, deadlineExpired: true, dispatched: false });
    const result = await agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: dispatchState });
    assert.equal(result.noDispatch, true);
    assert.equal(result.outcomeUnknown, false);
    assert.equal(dispatchState.started, false);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
  });

  for (const stopAt of ['dispatch', 'content preparation']) {
    test(`${browser}: saved workflow Stop during ${stopAt} retains correct text mutation evidence`, async () => {
      const agent = setup(Agent); const entered = deferred(); const release = deferred();
      agent.ensureConversationId = async () => 'workflow-conversation';
      agent._startSavedWorkflowTraceRun = async () => null;
      agent._endSavedWorkflowTraceRun = async () => {};
      agent._skipPermissionGate = true;
      agent._ensureGateSetting = async () => true;
      agent._captchaMutationPreflight = async () => null;
      agent._adoptLiveSocialPublishWorkflow = async () => false;
      agent._workflowPreSubmitDispatchBlock = async () => null;
      agent._messageRecipientGuardBlock = async () => null;
      agent._detectLikelySubmitAction = async () => null;
      agent._preflightRichTextToolbarTarget = async () => ({ block: null });
      if (stopAt === 'dispatch') agent.sendWrite = () => { entered.resolve(); return release.promise; };
      else agent._richTextToolbarToolBlock = async () => { entered.resolve(); await release.promise; return null; };
      const workflow = {
        id: 'cancelled_write', name: 'Write field',
        start: { origin: 'https://example.com', pathFamily: '/' },
        steps: [{ id: 'write', tool: 'set_field', args, expected: { kind: 'tool_verified' } }],
      };
      const updates = [];
      const pending = agent.replaySavedWorkflow(tabId, workflow, {}, (type, data) => updates.push({ type, data }));
      await entered.promise; agent.abort(tabId);
      const result = await pending;
      assert.equal(result.status, 'stopped');
      assert.equal(result.matchedSteps, 0);
      assert.equal(agent.isRunning(tabId), false);
      assert.equal(agent._uncertainTextMutations.get(tabId)?.size || 0, stopAt === 'dispatch' ? 1 : 0);
      assert.equal(agent.writes, stopAt === 'dispatch' ? 1 : 0);
      assert.equal(agent.injections, 0);
      if (stopAt === 'dispatch') await assertNextRunBlocked(agent);
      release.resolve({ success: true, dispatched: true, verified: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(agent._uncertainTextMutations.get(tabId)?.size || 0, stopAt === 'dispatch' ? 1 : 0);
      assert.equal(agent.writes, stopAt === 'dispatch' ? 1 : 0);
      assert.equal(updates.some(event => event.type === 'tool_result' && event.data?.name === 'done' && event.data?.result?.success === true), false);
    });

  }

  test(`${browser}: cancellation shares pending finalization and preserves observed verified evidence`, async () => {
    const agent = setup(Agent); const entered = deferred(); const release = deferred();
    const dispatchState = { started: false }; let finalizations = 0;
    const finalize = agent._finalizeTextMutationResult.bind(agent);
    agent._finalizeTextMutationResult = (...values) => { finalizations++; return finalize(...values); };
    const hash = agent._sha256Text.bind(agent);
    agent._sha256Text = async text => { entered.resolve(); await release.promise; return hash(text); };
    const pending = agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: dispatchState });
    await entered.promise;
    assert.equal(dispatchState.rawToolResult.verified, true);
    const finalizing = dispatchState.toolResultFinalization;
    const cancelled = agent._finalizeToolResultOnce(tabId, 'set_field', args,
      agent._contentActionCommunicationFailure('set_field', abortError(), true, { cancelled: true }), dispatchState);
    assert.equal(cancelled, finalizing);
    release.resolve();
    const [normalResult, sharedResult] = await Promise.all([pending, cancelled]);
    assert.equal(normalResult, sharedResult);
    assert.equal(sharedResult.verified, true);
    assert.equal(sharedResult.success, true);
    assert.equal(finalizations, 1);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
  });

  test(`${browser}: late lower result cannot recreate canceled debt after exact readback recovery`, async () => {
    const agent = setup(Agent); const entered = deferred(); const release = deferred();
    const dispatchState = { started: false };
    agent.sendWrite = () => { entered.resolve(); return release.promise; };
    const pending = agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: dispatchState });
    await entered.promise;
    const cancelled = await agent._finalizeToolResultOnce(tabId, 'set_field', args,
      agent._contentActionCommunicationFailure('set_field', abortError(), true, { cancelled: true }), dispatchState);
    assertUncertain(agent, cancelled, dispatchState);
    const send = api.tabs.sendMessage;
    api.tabs.sendMessage = async (id, message) => message.action === 'ax_verify_field_value'
      ? { success: true, verified: true } : send(id, message);
    const recovery = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(recovery.recoveredUncertainMutation, true);
    assert.equal(recovery.noDispatch, true);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    release.resolve({ success: true, dispatched: true, verified: false });
    assert.equal(await pending, cancelled);
    assert.equal(agent._uncertainTextMutations.has(tabId), false, 'unobserved late reply must not finalize the old mutation again');
    assert.equal(agent.writes, 1);
  });

  for (const stage of ['cancelled result', 'pending ordinary finalization']) {
    test(`${browser}: Stop bounds stalled scope enrichment for ${stage}`, { timeout: 2000 }, async () => {
      const agent = setup(Agent); const entered = deferred(); const release = deferred();
      await agent._claimRunEntry(tabId, 'interactive');
      agent._liveTextMutationScope = () => { entered.resolve(); return release.promise; };
      agent.sendWrite = async () => { throw stage === 'cancelled result'
        ? abortError() : new Error('The message port closed before a response was received.'); };
      const dispatchState = { started: false };
      const pending = agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: dispatchState });
      await entered.promise;
      if (stage === 'pending ordinary finalization') agent.abort(tabId);
      const result = await pending;
      assertUncertain(agent, result, dispatchState);
      assert.equal(agent._lastAxScopes.get(tabId).documentToken, scope.documentToken);
      agent._liveTextMutationScope = async () => scope;
      await assertNextRunBlocked(agent);
      release.resolve({ documentToken: 'late-unobserved-document', pageUrl: 'https://example.com/elsewhere' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(agent._lastAxScopes.get(tabId).documentToken, scope.documentToken);
      assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
    });
  }

  test(`${browser}: Stop interrupts pending verified-proof enrichment without restoring an old proof`, { timeout: 2000 }, async () => {
    const agent = setup(Agent); const entered = deferred(); const release = deferred();
    await agent._claimRunEntry(tabId, 'interactive');
    agent._planExecutionGuards.set(tabId, { siteWorkflow: { adapterName: 'github', job: { id: 'edit-file-and-commit' } } });
    const key = agent._textMutationTarget(tabId, 'set_field', args).key;
    agent._verifiedTextReplacements.set(tabId, new Map([[key, { old: true }]]));
    agent._textMutationValueDigest = () => { entered.resolve(); return release.promise; };
    const dispatchState = { started: false };
    const pending = agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: dispatchState });
    await entered.promise;
    assert.equal(dispatchState.rawToolResult.verified, true);
    agent.abort(tabId);
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(agent._verifiedTextReplacements.get(tabId).has(key), false);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    agent._releaseRunEntry(tabId);
    release.resolve({ verified: true, valueLength: args.text.length, valueSha256: 'a'.repeat(64) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(agent._verifiedTextReplacements.get(tabId).has(key), false);
  });

  if (browser === 'chrome') {
    test('chrome: EARLY_CDP public wrapper shares its parent dispatch marker on cancellation', async () => {
      const agent = setup(Agent); const dispatchState = { started: false }; const controller = new AbortController();
      agent._executeToolImpl = async (_id, _name, _args, _update, context) => {
        assert.equal(context._contentActionDispatchState, dispatchState);
        context._contentActionDispatchState.started = true;
        controller.abort(abortError());
        throw controller.signal.reason;
      };
      const result = await agent.executeTool(tabId, 'type_text', { text: 'new value', clear: true }, null, {
        _contentActionAbortSignal: controller.signal,
        _contentActionDispatchState: dispatchState,
      });
      assert.equal(result.cancelled, true);
      assertUncertain(agent, result, dispatchState);
    });
  }
}
