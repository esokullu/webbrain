import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: x => `chrome-extension://test/${x}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};

function streamingFixture(Agent, implementation) {
  const provider = { name: 'local test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: false, supportsVision: false, ...implementation };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._startTraceRun = async () => null;
  agent._endTraceRun = async (_tab, _run, status) => { agent.testStatus = status; };
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  agent._manageContext = async () => {};
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => 'https://example.com/';
  return agent;
}

function allowStreamingBatch(agent) {
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  agent._chromeProtectedPageFailure = async () => null;
  agent._captchaMutationPreflight = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._workflowPreSubmitDispatchBlock = async () => null;
  agent._messageRecipientGuardBlock = async () => null;
  agent._detectLikelySubmitAction = async () => null;
  agent._isFormValidationCandidate = () => false;
  agent._preflightRichTextToolbarTarget = async () => ({ block: null });
  agent._socialPublicationPreSubmitBlock = async () => null;
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._resolveVisionRoute = async () => ({ provider: null });
  agent._beginReadCompleteness = async () => null;
  agent._maybeRunPlannerGate = async () => ({ proceed: true, requiresStateChange: false });
  agent._observeCaptchaChallenge = async () => ({ gate: null, loopCheck: { kind: 'none' } });
}

for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const scheduler = await import(`../src/${browser}/src/agent/scheduler.js`);
  const { verifyBrowserCompletion } = await import(`../src/${browser}/src/agent/completion-runtime.js`);
  function fixture({ verdict = 'succeeded', mutate = () => {}, iframe = false } = {}) {
    const agent = new Agent({}), tab = 790, operations = [], messages = [], updates = [];
    agent.conversationModes.set(tab, 'act');
    agent._completionVerdicts = new Map();
    agent.conversations.set(tab, messages);
    agent.conversationIds.set(tab, 'owned-conversation');
    agent._progressTaskKeyHash = () => 'owned-task';
    agent._progressTaskAnchorText = () => 'Submit this AMO version for review.';
    agent._currentUrl = async () => 'https://addons.mozilla.org/developers/addon/owned/finish';
    agent._completionIframeBinding = () => iframe ? { currentUrl: 'https://owned.example/frame' } : null;
    agent._completionDoneBlock = () => agent.completionInvariants.get(tab)?.verificationDebt ? { reason: 'verification_required' } : null;
    agent.completionInvariants.set(tab, { runToken: 'owned-run', sequence: 3, verificationDebt: true,
      lastAction: { name: 'click_ax', sequence: 3, uncertain: true } });
    agent._completionSubmitStates.set(tab, { dispatched: true });
    agent._executeToolBatch = async (_tab, calls, transcript) => {
      const call = calls[0], name = call.function.name, args = JSON.parse(call.function.arguments);
      operations.push({ name, args });
      if (name !== 'done') {
        const previous = agent.completionInvariants.get(tab);
        // Real observation recording replaces the invariant object.
        agent.completionInvariants.set(tab, { ...previous, sequence: previous.sequence + 1, verificationDebt: false });
        transcript.push({ role: 'tool', tool_call_id: call.id, content: '{"success":true}' });
        mutate(agent);
        return { action: 'continue' };
      }
      agent._completionVerdicts.set(tab, { outcome: verdict });
      transcript.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ done: verdict === 'succeeded' }) });
      return { action: 'return', value: args.summary };
    };
    return { agent, tab, messages, operations, updates, update: (type, data) => updates.push({ type, data }) };
  }

  test(`${browser}: post-submit cloud failure observes and verifies without repeating Submit`, async () => {
    const f = fixture();
    const result = await f.agent._recoverPostActionModelFailure(f.tab, f.messages, f.update, {}, 4);
    assert.equal(result.status, 'done');
    assert.match(result.content, /submitted for review/);
    assert.deepEqual(f.operations.map(x => x.name), ['get_accessibility_tree', 'done']);
    assert.equal(f.messages.filter(x => x.role === 'assistant').length, 2);
  });
  test(`${browser}: uncertain verdict leaves a partial result and a user recovery choice`, async () => {
    const f = fixture({ verdict: 'uncertain' });
    const error = Object.assign(new Error('raw private provider error'), { code: 'webbrain_cloud_upstream_error' });
    const result = await f.agent._finalModelFailure(f.tab, f.messages, f.update, {}, error, 4);
    assert.equal(result.status, 'partial');
    assert.match(result.content, /final verification/);
    assert.doesNotMatch(result.content, /raw private/);
    assert.deepEqual(f.operations.map(x => x.name), ['get_accessibility_tree', 'done']);
    assert.equal(f.updates.find(x => x.type === 'failure_recovery').data.retryMode, 'resume');
    assert.equal(f.updates.at(-1).type, 'error');
  });
  test(`${browser}: recovery uses the submitted frame when present`, async () => {
    const f = fixture({ iframe: true });
    await f.agent._recoverPostActionModelFailure(f.tab, f.messages, f.update, {}, 4);
    assert.deepEqual(f.operations[0], { name: 'verify_form', args: { urlFilter: 'https://owned.example/frame' } });
  });
  test(`${browser}: changed run or task after observation cannot be certified`, async () => {
    for (const mutate of [a => { a.completionInvariants.get(790).runToken = 'changed'; },
      a => { a._progressTaskKeyHash = () => 'changed'; }]) {
      const f = fixture({ mutate });
      assert.equal(await f.agent._recoverPostActionModelFailure(f.tab, f.messages, f.update, {}, 4), null);
      assert.deepEqual(f.operations.map(x => x.name), ['get_accessibility_tree']);
    }
  });
  test(`${browser}: errors before submission do not invent action evidence`, async () => {
    const f = fixture(); f.agent._completionSubmitStates.delete(f.tab);
    assert.equal(await f.agent._recoverPostActionModelFailure(f.tab, f.messages, f.update, {}, 4), null);
    assert.deepEqual(f.operations, []);
  });

  test(`${browser}: response generation failures and empty output offer a bound generic Retry`, async () => {
    for (const result of ['failure', 'empty']) {
      const f = fixture(); f.agent.conversationModes.set(f.tab, 'ask');
      f.agent._persist = () => {};
      f.agent._generateContextOnlyResponse = async () => {
        if (result === 'failure') throw new Error('private provider diagnostics');
        return '';
      };
      const answer = await f.agent._completeResponseOnlyTurn(f.tab, f.messages, f.update, {}, {}, null);
      assert.equal(answer.status, result === 'failure' ? 'error' : 'empty_output');
      assert.doesNotMatch(answer.content, /private provider/);
      const offer = f.updates.find(x => x.type === 'failure_recovery').data;
      assert.equal(offer.stage, 'response_generation');
      assert.equal(offer.retryMode, 'resume');
      assert.equal(f.agent.requestFailureRecovery(f.tab, offer.recoveryId, 'retry').continue, true);
      assert.deepEqual(f.operations, []);
    }
  });

  test(`${browser}: quota or superseded response failures do not offer generic recovery`, async () => {
    for (const reason of ['quota', 'steering']) {
      const f = fixture(); f.agent._persist = () => {};
      f.agent._generateContextOnlyResponse = async () => {
        throw Object.assign(new Error('provider failure'), reason === 'quota' ? { quota: { remaining: 0 } } : {});
      };
      f.agent._hasPendingSteering = () => reason === 'steering';
      const answer = await f.agent._completeResponseOnlyTurn(f.tab, f.messages, f.update, {}, {}, null);
      assert.equal(answer.status, reason === 'steering' ? 'steering_superseded' : 'error');
      assert.equal(f.updates.some(x => x.type === 'failure_recovery'), false);
      assert.equal(f.agent._pendingFailureRecoveryForUi(f.tab), null);
    }
  });

  test(`${browser}: textless response-only cutoffs retain their allowance notice`, async () => {
    const f = fixture(); f.agent._persist = () => {};
    const notice = 'Cloud cost allowance reached: total cloud/router usage is $5.00 against the $5.00 limit.';
    f.agent._completionEvidenceMessages = (_tab, messages) => messages;
    f.agent._pruneOldImages = messages => messages;
    f.agent._providerMaxOutputTokens = () => 100;
    f.agent._chatWithCostAllowance = async () => {
      throw Object.assign(new Error('Output limit reached'), {
        incompleteReason: 'max_output_tokens',
        partialContent: '',
        costAllowanceMessage: notice,
      });
    };
    const provider = { contextWindow: 128000 };
    const answer = await f.agent._generateContextOnlyResponse(f.tab, f.messages, provider, {}, null, {
      phase: 'response_only', step: 1,
    });
    assert.match(answer, /output limit and was cut off/i);
    assert.match(answer, /cost allowance reached/i);
  });

  test(`${browser}: a stopped interaction offers Retry without replaying tools or overriding publication audit`, async () => {
    const f = fixture(); f.agent._persist = () => {};
    f.agent._generateContextOnlyResponse = async () => '';
    const answer = await f.agent._recoverLoopStoppedTurn(f.tab, f.messages, f.update, {}, {}, null, 4,
      'The interaction could not complete.');
    assert.equal(answer.status, 'loop_stopped');
    const offer = f.updates.find(x => x.type === 'failure_recovery').data;
    assert.equal(offer.stage, 'browser_interaction');
    assert.equal(offer.retryMode, 'resume');
    assert.deepEqual(f.operations, []);
  });

  test(`${browser}: real streaming loop retries startup cloud400 without replaying completed browser tools`, async () => {
    let starts = 0;
    const summary = 'Verified Example Domain.';
    const read = { id: 'startup-read', type: 'function', function: { name: 'read_page', arguments: '{}' } };
    const done = { id: 'startup-done', type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary, outcome: 'success' }) } };
    const agent = streamingFixture(Agent, { supportsTools: true, async *chatStream() {
      starts++;
      if (starts === 2) throw Object.assign(new Error('upstream'), { httpStatus: 400, code: 'webbrain_cloud_upstream_error' });
      assert.ok(starts <= 3, 'The stream retry must remain bounded');
      yield { type: 'tool_call', content: [{ ...(starts === 1 ? read : done), index: 0 }] };
      yield { type: 'done', finishReason: 'tool_calls' };
    } });
    allowStreamingBatch(agent); agent.maxSteps = 4;
    const dispatched = [], updates = [];
    agent.executeTool = async (_tab, name, args) => {
      dispatched.push(name);
      return name === 'done' ? { done: true, summary: args.summary, outcome: args.outcome } : { success: true, text: 'Example Domain' };
    };
    const answer = await agent.processMessageStream(791, 'Read the current page title. Read only.',
      (type, data) => updates.push({ type, data }), 'act', { askStreamingEnabled: false });
    assert.equal(answer, summary);
    assert.equal(agent.testStatus, 'done');
    assert.equal(starts, 3);
    assert.deepEqual(dispatched, ['read_page', 'done']);
    assert.equal(updates.filter(x => x.type === 'thinking' && /could not start.*Retrying/.test(x.data.note || '')).length, 1);
    const history = agent.getConversation(791, 'act');
    assert.equal(history.flatMap(x => x.tool_calls || []).filter(x => x.id === done.id).length, 1);
    assert.equal(history.filter(x => x.role === 'tool' && x.tool_call_id === done.id).length, 1);
    const pending = new Set();
    for (const message of history) {
      if (message.role === 'tool') assert.equal(pending.delete(message.tool_call_id), true, 'Each tool result pairs once');
      else {
        assert.equal(pending.size, 0, 'Each tool batch completes before another message');
        for (const call of message.tool_calls || []) pending.add(call.id);
      }
    }
    assert.equal(pending.size, 0);
  });

  test(`${browser}: real streaming loop does not automatically retry permanent startup errors`, async () => {
    let starts = 0, toolDispatches = 0;
    const agent = streamingFixture(Agent, { async *chatStream() {
      starts++;
      throw Object.assign(new Error('private authentication diagnostics'), { httpStatus: 401 });
    } });
    agent.maxSteps = 1;
    agent.executeTool = async () => { toolDispatches++; throw new Error('Unexpected browser tool'); };
    const updates = [];
    const answer = await agent.processMessageStream(792, 'Hello', (type, data) => updates.push({ type, data }),
      'ask', { standaloneChat: true });
    assert.equal(starts, 1);
    assert.equal(toolDispatches, 0);
    assert.equal(agent.testStatus, 'error');
    assert.equal(updates.some(x => x.type === 'thinking' && /Retrying/.test(x.data.note || '')), false);
    assert.equal(updates.filter(x => x.type === 'failure_recovery').length, 1);
    assert.doesNotMatch(answer, /private authentication/);
  });

  for (const scenario of ['current', 'exact-task', 'conversation', 'run', 'action', 'stop']) {
    test(`${browser}: post-submit recovery settles the actual scheduled checkpoint only while ${scenario} authority remains current`, async () => {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const resumed = new Promise(resolve => { release = resolve; });
      const state = { task: 'Acknowledge the new release once.', tree: 'status "Acknowledgement recorded for release-11"',
        sourceId: '', tabId: null, callbacks: 0, judgments: 0, operations: [], recovered: null, recoveryError: null };
      const controller = new AbortController();
      const provider = { name: 'owned test', model: 'owned-model', supportsVision: false, config: { category: 'local' }, chat() {} };
      const agent = new Agent({ getActive: () => provider });
      const harness = makeSchedulerHarness(scheduler, { requireConfirmation: false });
      harness.manager.agent = agent;
      agent._checkAbort = () => controller.signal.aborted;
      agent._runAbortSignal = () => controller.signal;
      agent.abort = () => controller.abort();
      agent._hasPendingSteering = agent._hasUnvalidatedSteering = () => false;
      agent._progressTaskKeyHash = () => 'owned-scheduled-task';
      agent._progressTaskAnchorText = () => state.task;
      agent._currentUrl = async () => 'https://example.com/';
      agent._completionDocumentStamp = async () => 'owned-scheduled-document';
      agent._completionLiveStatusMessages = async () => [state.tree];
      agent.executeTool = async () => ({ success: true, pageContent: state.tree });
      agent.recordSystemOneVerdict = () => {};
      agent._persistNow = async () => ({ ok: true });
      agent._chatWithCostAllowance = async () => {
        state.judgments++;
        return { content: '{"outcome":"succeeded","reason":"Fresh owned release acknowledgement."}' };
      };
      agent._executeToolBatch = async (tabId, calls, messages) => {
        const call = calls[0], name = call.function.name, args = JSON.parse(call.function.arguments);
        state.operations.push(name);
        if (name === 'get_accessibility_tree') {
          const result = { success: true, pageContent: state.tree };
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          agent._recordCompletionToolResult(tabId, name, args, result);
          return { action: 'continue' };
        }
        assert.equal(name, 'done', 'Recovery can only inspect and complete the submission');
        const pageUrl = 'https://example.com/';
        const verdict = await verifyBrowserCompletion(agent, tabId, { pageUrl, pageState: {}, summary: args.summary });
        assert.equal(verdict.outcome, 'succeeded');
        const result = { done: true, outcome: 'success', summary: args.summary,
          verification: { pageUrl, pageState: {}, completionWarning: null,
            decision: { outcome: verdict.outcome, engine: verdict.engine } } };
        messages.push({ role: 'tool', tool_call_id: call.id, content: agent._wrapUntrusted('done', JSON.stringify(result)) });
        agent._recordCompletionToolResult(tabId, name, args, result);
        return { action: 'return', value: args.summary, rawSummary: args.summary };
      };
      agent.processMessage = async (tabId, text, onUpdate, _mode, _attachments, runOptions) => {
        state.tabId = tabId;
        const messages = [{ role: 'system', content: 'Owned scheduled recovery.' }, { role: 'user', content: text }];
        agent.conversations.set(tabId, messages);
        agent.conversationModes.set(tabId, 'act');
        agent.conversationIds.set(tabId, 'owned-scheduled-conversation');
        agent._beginCompletionInvariant(tabId);
        assert.equal(await runOptions.beforeConsequentialTool({ name: 'click_ax' }), true);
        state.pending = structuredClone(harness.jobs().find(job => job.id === state.sourceId).pendingToolCall);
        const click = { success: true, dispatched: true, verified: false, inconclusive: true, observedEffects: ['network_request'] };
        agent._recordCompletionToolResult(tabId, 'click_ax', {}, click);
        agent._completionSubmitStates.set(tabId, { dispatched: true });
        assert.equal(await runOptions.afterConsequentialTool({ name: 'click_ax', result: click, outcomeUnknown: true }), false);
        try {
          state.recovered = await agent._recoverPostActionModelFailure(tabId, messages, onUpdate, provider, 3, {
            ...runOptions,
            afterVerifiedCompletion: async proof => {
              state.callbacks++;
              enter();
              await resumed;
              state.settled = await runOptions.afterVerifiedCompletion(proof);
              return state.settled;
            },
          });
        } catch (error) { state.recoveryError = error; }
        return state.recovered?.content || 'The scheduled submission requires final verification.';
      };
      const created = await harness.manager.createWatchJob({ args: { prompt: 'When a new release appears, acknowledge it once.',
        keep: true, interval_seconds: 30, beep: false }, currentUrl: 'https://example.com/' });
      state.sourceId = created.jobId;
      const pendingRun = harness.manager.handleAlarm(harness.alarmName(created.jobId));
      await Promise.race([entered, pendingRun.then(() => assert.fail('Recovery skipped the scheduled completion callback'))]);
      assert.ok(harness.jobs().find(job => job.id === created.jobId).pendingToolCall, 'Unknown input remains pending until settlement');
      if (scenario === 'exact-task') state.task = state.task.toUpperCase();
      if (scenario === 'conversation') agent.conversationIds.set(state.tabId, 'superseding-conversation');
      if (scenario === 'run') agent.completionInvariants.get(state.tabId).runToken = 'superseding-run';
      if (scenario === 'action') agent._recordCompletionToolResult(state.tabId, 'click_ax', {}, { success: true, dispatched: true });
      if (scenario === 'stop') await harness.manager.cancelJob(created.jobId, 'Owned Stop');
      release();
      await pendingRun;
      const finished = harness.jobs().find(job => job.id === created.jobId);
      assert.equal(state.callbacks, 1);
      assert.equal(state.judgments, 1, 'Settlement refreshes the accepted verdict without another model judgment');
      assert.deepEqual(state.operations, ['get_accessibility_tree', 'done']);
      if (scenario === 'current') {
        assert.equal(state.settled, true);
        assert.equal(state.recovered.status, 'done');
        assert.equal(finished.pendingToolCall, null);
        assert.equal(finished.completedConsequentialAction.verification, 'independent_completion');
        assert.equal(finished.runCount, 1);
      } else {
        assert.equal(state.settled, false);
        assert.equal(state.recovered, null, 'Stale callback authority cannot produce recovery success');
        if (scenario === 'stop') {
          assert.equal(state.recoveryError?.name, 'AbortError');
          assert.equal(finished.status, 'cancelled');
        } else {
          assert.equal(state.recoveryError, null);
          assert.equal(finished.status, 'needs_user_input');
          assert.deepEqual(finished.pendingToolCall, state.pending, 'Preserve the original uncertain checkpoint');
          assert.equal(finished.runCount, 0);
        }
      }
    });
  }
}
