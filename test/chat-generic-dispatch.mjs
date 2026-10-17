import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` },
  tabs: { get: async id => ({ id, url: 'https://web.telegram.org/k/#123456' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { serializeChatSession } = await import(`../src/${build}/src/agent/chat-workflow.js`);
  const tabId = 745, body = 'A generated fixture reply.', threadKey = 'dom:telegram:k:123456:0';
  function harness() {
    const provider = { promptTier: 'full', supportsVision: false };
    const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
    // Unrelated UI permission/toolbar probes are covered by separate browser
    // suites. Recipient proof is supplied here to isolate the actual batch's
    // storage, dispatch, steering and cancellation ordering.
    agent._skipPermissionGate = true; agent._ensureGateSetting = async () => true;
    agent._chromeProtectedPageFailure = async () => null;
    agent._captchaMutationPreflight = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._workflowPreSubmitDispatchBlock = async () => null;
    agent._detectLikelySubmitAction = async () => null;
    agent._isFormValidationCandidate = () => false;
    agent._preflightRichTextToolbarTarget = async () => ({ block: null });
    agent._socialPublicationPreSubmitBlock = async () => null;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._persist = () => {};
    agent._currentUrl = async () => 'https://web.telegram.org/k/#123456';
    agent._refreshPageFeedbackForCall = async () => false;
    const observed = { success: true, url: 'https://web.telegram.org/k/#123456', threadKey,
      composer: { available: true, empty: false, ref: 'composer' },
      messages: [{ id: 'telegram:k:123456:0:1:rfixture', direction: 'incoming', text: 'Fixture question' }] };
    agent._readChatObservation = async () => structuredClone(observed);
    let context, saved, sequence = 0, sends = 0;
    agent._messageRecipientGuardBlock = async (_tab, _name, _args, _url, value) => {
      context = value;
      Object.assign(value, { messageRecipientGuardRequired: true, messageRecipientBody: body,
        messageRecipientDispatchBinding: { token: 'fixture-one-use-token' },
        messageRecipientNativeChatBaseline: { complete: true, threadKey,
          messageIds: ['telegram:k:123456:0:1'] } });
      return null;
    };
    agent._persistNow = async () => { saved = structuredClone(serializeChatSession(agent.chatSessions.get(tabId))); return true; };
    agent.executeTool = async (_tab, _name, _args, _update, execution) => {
      assert.equal(saved.pendingOutbound?.text, body, 'Pending exact body must be durable before page dispatch');
      assert.ok(saved.pendingOutbound.dispatchId, 'A persisted dispatch owner prevents stale cleanup');
      execution._contentActionDispatchState.started = true;
      sends++;
      return { success: false, dispatched: true, outcomeUnknown: true, error: 'Fixture response lost after dispatch' };
    };
    const call = () => agent._executeToolBatch(tabId, [{ id: `send-${++sequence}`,
      function: { name: 'click', arguments: '{"selector":"#send"}' } }], [], () => {},
      provider, null, new Set(['click']), sequence, {});
    return { agent, observed, call, get saved() { return saved; }, get context() { return context; }, get sends() { return sends; },
      restore(value) { agent.chatSessions.set(tabId, structuredClone(value)); } };
  }

  test(`${build}: generic send persists before dispatch, survives restart and blocks duplicate uncertainty`, async () => {
    const first = harness(); await first.call();
    assert.equal(first.sends, 1); assert.ok(first.saved.pendingOutbound);
    const resumed = harness(); resumed.restore(first.saved);
    await resumed.call(); assert.equal(resumed.sends, 0, 'A worker restart must not repeat an uncertain generic send');
    assert.equal(resumed.agent.chatSessions.get(tabId).pendingOutbound.dispatchId, first.saved.pendingOutbound.dispatchId);
    resumed.observed.composer.empty = true;
    resumed.observed.messages.push({ id: 'telegram:k:123456:0:2', direction: 'outgoing', text: body, authoredText: body });
    const confirmed = await resumed.agent._observeChatWorkflow(tabId);
    assert.equal(confirmed.chatWorkflow.pendingOutbound, false);
    await resumed.call(); assert.equal(resumed.sends, 0, 'Already confirmed identical generic replies cannot be sent again');
  });

  test(`${build}: proven no-dispatch and failed pending persistence roll back the generic send`, async () => {
    const rejected = harness();
    rejected.agent.executeTool = async () => ({ success: false, dispatched: false, noDispatch: true, error: 'Target changed' });
    await rejected.call(); assert.equal(rejected.saved.pendingOutbound, null);
    const unavailable = harness(); let writes = 0;
    const save = unavailable.agent._persistNow;
    unavailable.agent._persistNow = async () => ++writes === 1 ? false : save();
    await unavailable.call(); assert.equal(unavailable.sends, 0);
    assert.equal(unavailable.agent.chatSessions.get(tabId).pendingOutbound, null);
    assert.equal(unavailable.saved.pendingOutbound, null);
  });

  test(`${build}: generic send observes new incoming and OTP gates without consuming the delta`, async () => {
    const gated = harness(); await gated.agent._observeChatWorkflow(tabId);
    // Strict checks: the guard's refusal itself is under test.
    gated.agent.strictGuards = true;
    gated.observed.messages.push({ id: 'telegram:k:123456:0:2:rnext', direction: 'incoming', text: 'New fixture question' });
    await gated.call(); assert.equal(gated.sends, 0);
    gated.observed.userInput = { required: true, reason: 'otp' };
    await gated.call(); assert.equal(gated.sends, 0);
    const paused = await gated.agent._observeChatWorkflow(tabId);
    assert.equal(paused.chatWorkflow.nextAction, 'pause_for_user');
    delete gated.observed.userInput;
    const resumed = await gated.agent._observeChatWorkflow(tabId);
    assert.ok(resumed.chatWorkflow.newMessages.some(message => message.text === 'New fixture question'));
    await gated.call(); assert.equal(gated.sends, 1);
    gated.observed.userInput = { required: true, reason: 'otp' };
    await gated.call(); assert.equal(gated.sends, 1); assert.ok(gated.saved.pendingOutbound);
  });

  for (const phase of ['before-dispatch', 'after-dispatch', 'steering']) {
    test(`${build}: ${phase} during generic pending save preserves correct dispatch ownership`, async () => {
      const raced = harness(); await raced.agent._claimRunEntry(tabId, 'interactive');
      try {
        if (phase === 'before-dispatch' || phase === 'steering') {
          const save = raced.agent._persistNow; let first = true;
          raced.agent._persistNow = async () => {
            const result = await save();
            if (first) { first = false;
              if (phase === 'before-dispatch') raced.agent.abort(tabId);
              else raced.agent._hasPendingSteering = () => true;
            }
            return result;
          };
        } else {
          raced.agent.executeTool = async (_tab, _name, _args, _update, execution) => {
            assert.ok(raced.saved.pendingOutbound);
            execution._contentActionDispatchState.started = true;
            raced.agent.abort(tabId); throw execution._contentActionAbortSignal.reason;
          };
        }
        if (phase === 'steering') await raced.call();
        else await assert.rejects(raced.call(), { name: 'AbortError' });
        assert.equal(!!raced.saved.pendingOutbound, phase === 'after-dispatch');
        assert.equal(raced.sends, 0);
      } finally { raced.agent._releaseRunEntry(tabId); }
    });
  }
  test(`${build}: stale generic dispatch cleanup cannot clear a later owned pending send`, async () => {
    const raced = harness(); await raced.call();
    const old = raced.context;
    const current = raced.agent.chatSessions.get(tabId);
    raced.agent.chatSessions.set(tabId, { ...current, pendingOutbound: { ...current.pendingOutbound, dispatchId: 'newer-owner' } });
    await raced.agent._settleGenericChatDispatch(tabId, old, { noDispatch: true, dispatched: false }, false, false);
    assert.equal(raced.agent.chatSessions.get(tabId).pendingOutbound.dispatchId, 'newer-owner');
  });
  test(`${build}: remounted old native outgoing body cannot reconcile an uncertain generic send`, async () => {
    const pending = harness(); await pending.call();
    const resumed = harness(); resumed.restore(pending.saved);
    resumed.observed.composer.empty = true;
    resumed.observed.messages.unshift({ id: 'telegram:k:123456:0:0', direction: 'outgoing', text: body, authoredText: body });
    const old = await resumed.agent._observeChatWorkflow(tabId);
    assert.equal(old.chatWorkflow.pendingOutbound, true,
      'An older virtual outgoing is not proof that the current pending body was delivered');
    resumed.observed.messages.push({ id: 'telegram:k:123456:0:2', direction: 'outgoing', text: body, authoredText: body });
    assert.equal((await resumed.agent._observeChatWorkflow(tabId)).chatWorkflow.pendingOutbound, false);
  });
}
