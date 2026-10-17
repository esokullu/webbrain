// Completion guards under the default policy (Settings → General → "Strict
// checks" off, see src/*/src/agent/guard-policy.js). A completion guard
// refuses a done or a plain final at most once per run: that refusal is the
// model's note. The next completion the same guard would refuse is accepted,
// and the final answer ends with one line naming what was not verified. With
// agent.strictGuards = true every old refusal, budget and forced turn stays.
// Real Agent batches and run loops (chat and stream) with mocked browser
// APIs, both builds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutFixedChoiceAnswers } from './semantic-decision-stub.mjs';

const PAGE = 'https://owned.example.test/profile';
const TREE = 'main [ref_main]\n heading "Profile" [ref_h]\n button "Save" [ref_save]';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: PAGE, title: 'Profile', status: 'complete' }),
    sendMessage: async () => ({ ready: true }),
    executeScript: async () => [null],
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const CAVEAT = 'WebBrain could not verify everything: ';
const STRICT_NOTE = 'Strict checks keep the old refusal';
let nextTab = 9300;
let nextCall = 1;

const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

// A tool batch the way the run loop executes one, for a minimal Act or Ask
// agent whose done handler is stubbed unless `realDone` is set.
function batchAgent(Agent, { mode = 'act', strict = false, task = 'Update the owned profile.', realDone = false, schemas = null } = {}) {
  const tab = nextTab++;
  const agent = new Agent({ getActive: () => ({ model: 'test', supportsTools: true, supportsVision: false }), getVisionProvider: async () => null });
  agent.strictGuards = strict;
  agent.conversationIds.set(tab, `conv-${tab}`);
  agent.conversationModes.set(tab, mode);
  agent.conversations.set(tab, [{ role: 'system', content: 'sys' }, { role: 'user', content: task }]);
  agent._ensureGateSetting = async () => {};
  agent._skipPermissionGate = true;
  agent._currentUrl = async () => PAGE;
  agent._persist = () => {};
  agent._persistNow = async () => true;
  const executed = [];
  if (!realDone) {
    agent.executeTool = async (_tab, name, args) => {
      executed.push({ name, args });
      if (name === 'done') return { done: true, summary: args.summary, outcome: args.outcome };
      if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE };
      return { success: true, dispatched: true };
    };
  }
  const batch = async (calls, updates = []) => {
    const toolCalls = calls.map(([name, args]) => ({ id: `${name}_${nextCall++}`, function: { name, arguments: JSON.stringify(args) } }));
    const messages = agent.conversations.get(tab);
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
    return agent._executeToolBatch(tab, toolCalls, messages, (type, data) => updates.push({ type, data }),
      { supportsVision: false }, null, new Set(['done', 'click_ax', 'get_accessibility_tree']), 1, {}, schemas);
  };
  return { agent, tab, batch, executed };
}

// The same done twice: by default the second is accepted with its caveat;
// under Strict checks it is refused again.
async function refusedOnceThenAccepted(Agent, setup, doneArgs, caveat, label) {
  for (const strict of [false, true]) {
    const h = batchAgent(Agent, { ...(setup.options || {}), strict });
    await setup.prepare?.(h);
    const first = await h.batch([['done', doneArgs]]);
    assert.equal(first.action, 'continue', `${label}: the first completion is refused with its note`);
    const second = await h.batch([['done', doneArgs]]);
    if (strict) {
      assert.notEqual(second.action === 'return' && !second.status, true, `${label}: ${STRICT_NOTE}`);
      if (second.action === 'return') assert.doesNotMatch(String(second.value), new RegExp(CAVEAT), `${label}: strict caveat`);
    } else {
      assert.equal(second.action, 'return', `${label}: the second completion is accepted`);
      assert.equal(second.status, undefined, `${label}: an accepted completion does not end as a guard failure`);
      assert.ok(String(second.value).startsWith(String(doneArgs.summary)), `${label}: the model's answer is kept`);
      assert.ok(String(second.value).includes(CAVEAT + caveat), `${label}: caveat missing from ${JSON.stringify(second.value)}`);
    }
  }
}

// A real run loop with a mocked model; done and page tools are stubbed at
// the lifecycle boundary, so every batch, plain-final and forced-turn path
// runs for real.
function loopAgent(Agent, next, { strict = false, realTraceStart = false } = {}) {
  const provider = {
    name: 'guard advisory test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    chat: withoutFixedChoiceAnswers((messages, options) => next(messages, options)),
    async *chatStream(messages, options) {
      const response = await next(messages, options);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent.strictGuards = strict;
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => PAGE, _getTabUrlTitle: async () => ({ tabUrl: PAGE, tabTitle: 'Profile' }),
    _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
    _enrichUserMessageWithCurrentPage: async (_tab, _messages, content) => ({ role: 'user', content }),
    _plannerMode: () => 'off',
    _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
    _skipPermissionGate: true, _ensureGateSetting: async () => true, _adoptLiveSocialPublishWorkflow: async () => false,
    _isFormValidationCandidate: () => false, _preflightRichTextToolbarTarget: async () => ({ block: null }),
    _auditRichTextToolbarTarget: async () => {}, _shouldAutoScreenshot: () => false, _pageFeedbackIdleMs: 0,
  });
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  // The real run start mints the task token that bounds an untraced run.
  if (realTraceStart) delete agent._startTraceRun;
  agent.maxSteps = 8;
  agent._executeToolWithLifecycle = async (_tab, name, args) => {
    if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
    if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE };
    return { success: true, dispatched: true };
  };
  return agent;
}
const call = (id, name, args) => ({ toolCalls: [{ id: `${id}_${nextCall++}`, function: { name, arguments: JSON.stringify(args) } }] });
const runLoop = (agent, tab, streaming, text) => streaming
  ? agent.processMessageStream(tab, text, () => {}, 'act', { detachedRequestId: `guard-${tab}` })
  : agent.processMessage(tab, text, () => {}, 'act', [], { detachedRequestId: `guard-${tab}` });

// The Act done handler with its page probe, completion judge and page checks
// running for real against a fixed page state.
function handlerAgent(Agent, build, { strict = false, page = {}, verdict = null } = {}) {
  const tab = nextTab++;
  const pageState = { url: PAGE, title: 'Profile', openDialogCount: 0, dialogTitles: [], visibleFormCount: 0,
    relevantFormCount: 0, formDescriptors: [], liveRegionMessages: [], successMessages: [], documentIdentity: 'owned-document',
    incompleteTaskControls: [], workflowStatusTexts: [], workflowResourceUrls: [], workflowResourceRecords: [], workflowPageText: 'Profile',
    ...page };
  const settings = verdict ? { decisionProvider: 'local', systemOneEnabled: true, decisionVisionMode: 'off' } : {};
  const storage = { ...area, get: async () => settings };
  globalThis.chrome = globalThis.browser = { ...api, storage: { ...api.storage, local: storage },
    tabs: { ...api.tabs, get: async id => ({ id, url: PAGE, title: 'Profile', status: 'complete' }), executeScript: async () => [pageState] } };
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async () => ({});
  cdpClient.evaluate = async () => ({ result: { value: pageState } });
  const provider = { model: 'test-model', supportsVision: false, config: { category: 'local' } };
  const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
  agent.strictGuards = strict;
  agent.conversationModes.set(tab, 'act');
  agent.conversations.set(tab, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Save the owned profile.' }]);
  agent.autoScreenshot = 'off';
  agent._persist = () => {};
  agent._persistNow = async () => true;
  agent.systemOneContext = () => ({ isCurrent: () => true });
  agent._latestTaskText = () => 'Save the owned profile.';
  agent._completionDocumentStamp = async () => 'owned-document';
  agent._captureViewportProbe = async () => ({ url: PAGE, title: 'Profile' });
  // The judge's own fresh page read.
  const execute = agent.executeTool.bind(agent);
  agent.executeTool = (tabId, name, args, ...rest) => name === 'get_accessibility_tree'
    ? Promise.resolve({ success: true, pageContent: 'heading "Profile"\nstatus "Saving failed"' })
    : execute(tabId, name, args, ...rest);
  if (verdict) {
    agent.evaluateSystemOne = async () => ({ model: 'judge', answers: {
      task_outcome: { type: 'choice', choice: verdict, confidence: 0.99,
        probabilities: Object.fromEntries(['succeeded', 'pending', 'failed', 'uncertain'].map(key => [key, key === verdict ? 0.97 : 0.01])) },
      later_outcome: { type: 'choice', choice: 'not_asked', confidence: 0.95, probabilities: { asked: 0.05, not_asked: 0.95 } },
      summary_kind: { type: 'choice', choice: 'result', confidence: 0.95, probabilities: { result: 0.9, meta_only: 0.05, plan_only: 0.05 } },
    } });
  }
  return { agent, tab, pageState, build };
}

const restoreGlobals = () => {
  globalThis.chrome = api;
  globalThis.browser = api;
};

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const invariant = await import(`../src/${build}/src/agent/completion-invariant.js`);
  const { getToolsForMode } = await import(`../src/${build}/src/agent/tools.js`);

  // ── Forced turns, verification debt and the failure-only done ──────────
  for (const streaming of [false, true]) {
    const label = `${build} ${streaming ? 'stream' : 'chat'}`;

    test(`${label}: an unobserved action is advised once, then done is accepted with a caveat and no forced turns`, async () => {
      for (const strict of [false, true]) {
        const tab = nextTab++, requests = [];
        const agent = loopAgent(Agent, async (_messages, options) => {
          requests.push({ names: (options?.tools || []).map(tool => tool.function.name), choice: options?.toolChoice ?? null });
          const n = requests.length;
          if (n === 1) return call('save', 'click_ax', { ref_id: 'ref_save' });
          if (n === 2) return call('early-done', 'done', { summary: 'Saved the profile.', outcome: 'success' });
          if (strict && n === 3) return call('verify', 'get_accessibility_tree', { filter: 'visible' });
          return call('done', 'done', { summary: 'Saved the profile.', outcome: 'success' });
        }, { strict });
        const result = await runLoop(agent, tab, streaming, 'Save the owned profile.');
        if (!strict) {
          assert.equal(requests.length, 3, `${label}: one refusal, then the done is accepted`);
          assert.ok(requests[2].names.includes('click_ax'), `${label}: the default note leaves every tool available`);
          assert.equal(requests[2].choice, null, `${label}: no forced verification or done-only turn by default`);
          assert.equal(result, `Saved the profile.\n\n${CAVEAT}The page was not checked again after the last action.`);
        } else {
          assert.equal(requests[2].choice, 'required', `${label}: ${STRICT_NOTE} (forced read-only turn)`);
          assert.equal(requests[2].names.includes('click_ax'), false, `${label}: strict verification turn is read-only`);
          assert.deepEqual(requests[3].names, ['done'], `${label}: strict forces the done-only turn after verification`);
          assert.equal(result, 'Saved the profile.', `${label}: a verified strict completion carries no caveat`);
        }
      }
    });

    test(`${label}: a plain final after an observed action is advised once, then shown with a caveat`, async () => {
      for (const strict of [false, true]) {
        const tab = nextTab++;
        let n = 0;
        const agent = loopAgent(Agent, async () => {
          n++;
          if (n === 1) return call('save', 'click_ax', { ref_id: 'ref_save' });
          if (n === 2) return call('observe', 'get_accessibility_tree', { filter: 'visible' });
          return { content: 'Saved the profile.' };
        }, { strict });
        const result = await runLoop(agent, tab, streaming, 'Save the owned profile.');
        if (!strict) {
          assert.equal(n, 4, `${label}: one done-protocol note, then the plain final is accepted`);
          assert.equal(result, `Saved the profile.\n\n${CAVEAT}The task ended with a plain answer instead of a checked completion.`);
        } else {
          assert.equal(n, 5, `${label}: ${STRICT_NOTE} (two recovery turns)`);
          assert.match(result, /plain text repeatedly/, `${label}: strict keeps the two-strike partial`);
        }
      }
    });

    test(`${label}: a plain final accepted over a check that knows the task is not done ends the run as partial`, async () => {
      // decided: the last text went into a formatting toolbar (the check
      // knows). Undecided: the page was not read after the last action.
      for (const decided of [true, false]) {
        const tab = nextTab++;
        let n = 0;
        const agent = loopAgent(Agent, async () => {
          n++;
          if (!decided && n === 1) return call('save', 'click_ax', { ref_id: 'ref_save' });
          return { content: 'Wrote the post.' };
        });
        if (decided) {
          agent._richTextToolbarGuard.hasPending = () => true;
          agent._richTextToolbarGuard.completionAction = () => ({ name: 'type_ax', ref_id: 'ref_bold' });
        }
        const runStatuses = [];
        let finished = null;
        const onUpdate = (type, data) => { if (type === 'run_status') runStatuses.push(data?.status); };
        const options = { detachedRequestId: `guard-${tab}`, onRunFinished: status => { finished = status; } };
        const result = streaming
          ? await agent.processMessageStream(tab, 'Write the post.', onUpdate, 'act', options)
          : await agent.processMessage(tab, 'Write the post.', onUpdate, 'act', [], options);
        assert.ok(String(result).startsWith(`Wrote the post.\n\n${CAVEAT}`), `${label}: the plain final is accepted with its caveat`);
        if (decided) {
          assert.match(result, /formatting toolbar instead of the editor\./);
          assert.equal(finished, 'partial', `${label}: the run finished as a success over a check that knows it is not done`);
          assert.deepEqual(runStatuses, ['partial'], `${label}: the scheduler did not hear the partial ending`);
        } else {
          assert.match(result, /The page was not checked again after the last action\./);
          assert.equal(finished, 'done', `${label}: missing evidence alone must not downgrade the run`);
          assert.deepEqual(runStatuses, []);
        }
      }
    });

    test(`${label}: a done accepted over a check that knows the task is not done ends the run as partial`, async () => {
      // As for a plain final: the done's own outcome is downgraded, and the
      // run reports partial too (trace status, run_status, onRunFinished).
      for (const decided of [true, false]) {
        const tab = nextTab++;
        let n = 0;
        const agent = loopAgent(Agent, async () => {
          n++;
          if (!decided && n === 1) return call('save', 'click_ax', { ref_id: 'ref_save' });
          return call('done', 'done', { summary: 'Wrote the post.', outcome: 'success' });
        });
        if (decided) {
          agent._richTextToolbarGuard.hasPending = () => true;
          agent._richTextToolbarGuard.completionAction = () => ({ name: 'type_ax', ref_id: 'ref_bold' });
        }
        const runStatuses = [];
        const doneOutcomes = [];
        let finished = null;
        const onUpdate = (type, data) => {
          if (type === 'run_status') runStatuses.push(data?.status);
          if (type === 'tool_result' && data?.name === 'done' && data.result?.done) doneOutcomes.push(data.result.outcome);
        };
        const options = { detachedRequestId: `guard-${tab}`, onRunFinished: status => { finished = status; } };
        const result = streaming
          ? await agent.processMessageStream(tab, 'Write the post.', onUpdate, 'act', options)
          : await agent.processMessage(tab, 'Write the post.', onUpdate, 'act', [], options);
        assert.ok(String(result).startsWith(`Wrote the post.\n\n${CAVEAT}`), `${label}: the done is accepted with its caveat`);
        if (decided) {
          assert.deepEqual(doneOutcomes, ['partial'], `${label}: the done's own outcome was not downgraded`);
          assert.equal(finished, 'partial', `${label}: the run finished as a success over a check that knows it is not done`);
          assert.deepEqual(runStatuses, ['partial'], `${label}: the scheduler did not hear the partial ending`);
        } else {
          assert.deepEqual(doneOutcomes, ['success']);
          assert.equal(finished, 'done', `${label}: missing evidence alone must not downgrade the run`);
          assert.deepEqual(runStatuses, []);
        }
      }
    });

    test(`${label}: a plain final accepted over unfinished progress rows ends the run as partial`, async () => {
      for (const status of ['pending', 'acted']) {
        const tab = nextTab++;
        let n = 0;
        const agent = loopAgent(Agent, async () => {
          n++;
          return { content: 'Processed both items.' };
        });
        agent._currentTaskLedgerRows = () => [{ id: 'item-1', label: 'First', status: 'processed' },
          { id: 'item-2', label: 'Second', status }];
        const runStatuses = [];
        let finished = null;
        const onUpdate = (type, data) => { if (type === 'run_status') runStatuses.push(data?.status); };
        const options = { detachedRequestId: `guard-${tab}`, onRunFinished: value => { finished = value; } };
        const result = streaming
          ? await agent.processMessageStream(tab, 'Process both items.', onUpdate, 'act', options)
          : await agent.processMessage(tab, 'Process both items.', onUpdate, 'act', [], options);
        assert.ok(n > 1, `${label} ${status}: the first plain final gets its progress note`);
        assert.ok(String(result).startsWith(`Processed both items.\n\n${CAVEAT}`), `${label} ${status}: caveat missing from ${JSON.stringify(result)}`);
        assert.match(result, /1 of 2 items in the task's progress list were not finished\./);
        assert.equal(finished, 'partial', `${label} ${status}: the run finished as a success with an item unfinished`);
        assert.deepEqual(runStatuses, ['partial'], `${label} ${status}: the scheduler did not hear the partial ending`);
      }
    });

    test(`${label}: a plain final after a chat send saves the delivery receipt first`, async () => {
      // A plain final ends a run where done would have saved the receipt
      // (native-chat-receipt-not-durable), so it runs the same check.
      for (const save of ['saved', 'fails', 'no send']) {
        const tab = nextTab++;
        let n = 0;
        let receiptSave = false;
        const evidenceReads = [];
        const agent = loopAgent(Agent, async () => {
          n++;
          if (n === 1) return call('send', 'click_ax', { ref_id: 'ref_save' });
          // The click was a native chat send bound to its delivery.
          const state = agent.completionInvariants.get(tab);
          if (save !== 'no send' && state && !state.lastAction?.chatDeliveryBinding) {
            agent.completionInvariants.set(tab, { ...state, lastAction: { ...(state.lastAction || {}), chatDeliveryBinding: { token: 'chat-1' } } });
          }
          return { content: 'Sent the reply.' };
        });
        agent._freshNativeChatTerminalEvidence = async () => {
          evidenceReads.push(n);
          receiptSave = true;
          return { threadKey: 'dom:telegram:k:123456:0', messageId: 'telegram:k:123456:0:5' };
        };
        agent._persistNow = async () => {
          const failing = receiptSave && save === 'fails';
          receiptSave = false;
          return failing ? { ok: false } : { ok: true };
        };
        const runStatuses = [];
        let finished = null;
        const onUpdate = (type, data) => { if (type === 'run_status') runStatuses.push(data?.status); };
        const options = { detachedRequestId: `guard-${tab}`, onRunFinished: status => { finished = status; } };
        const result = streaming
          ? await agent.processMessageStream(tab, 'Reply to the owned chat.', onUpdate, 'act', options)
          : await agent.processMessage(tab, 'Reply to the owned chat.', onUpdate, 'act', [], options);
        if (save === 'saved') {
          assert.ok(evidenceReads.length >= 1, `${label}: the delivery was not read back before the run ended`);
          assert.equal(finished, 'done', `${label}: a saved receipt keeps the plain final`);
          assert.ok(String(result).startsWith('Sent the reply.'));
        } else if (save === 'fails') {
          assert.equal(evidenceReads.length, 3, `${label}: two refusals, then the run ends`);
          assert.equal(finished, 'partial', `${label}: a run without a saved receipt ended as a success`);
          assert.deepEqual(runStatuses, ['partial']);
          assert.match(String(result), /could not save the record that the message was delivered/);
        } else {
          assert.deepEqual(evidenceReads, [], `${label}: a run without a chat send read the conversation`);
          assert.equal(finished, 'done');
        }
      }
    });
  }

  test(`${build}: each untraced run gets its own one refusal per guard`, async () => {
    const tab = nextTab++;
    let requests = 0;
    const agent = loopAgent(Agent, async () => {
      requests++;
      if (requests === 1 || requests === 4) return call('save', 'click_ax', { ref_id: 'ref_save' });
      return call('done', 'done', { summary: 'Saved the profile.', outcome: 'success' });
    }, { realTraceStart: true });
    const first = await runLoop(agent, tab, false, 'Save the owned profile.');
    assert.equal(requests, 3, `${build}: run 1 refuses the unobserved done once`);
    assert.match(first, /The page was not checked again after the last action\./);
    const second = await runLoop(agent, tab, false, 'Save the owned profile again.');
    assert.equal(requests, 6, `${build}: run 2 refuses it once again instead of inheriting run 1's advice`);
    assert.match(second, /The page was not checked again after the last action\./);
  });

  test(`${build}: a new completion attempt drops stale completion caveats and keeps other guards' caveats`, async () => {
    const h = batchAgent(Agent);
    const { caveats } = h.agent._guardRunState(h.tab);
    caveats.set('done-verification-debt', 'The page was not checked again after the last action.');
    caveats.set('chat-send-preconditions', 'A caveat from another guard family.');
    await h.batch([['get_accessibility_tree', { filter: 'visible' }]]);
    assert.equal(caveats.size, 2, `${build}: a batch without done is not a completion attempt`);
    const result = await h.batch([['done', { summary: 'Saved the profile.', outcome: 'success' }]]);
    assert.equal(result.value, `Saved the profile.\n\n${CAVEAT}A caveat from another guard family.`);
  });

  test(`${build}: clearing the conversation drops its guard notes and caveats`, () => {
    const h = batchAgent(Agent);
    assert.equal(h.agent._guardRefusesOnce(h.tab, 'done-verification-debt', { decided: false, caveat: 'Not checked.' }), true);
    assert.equal(h.agent._guardRunStates.has(h.tab), true);
    h.agent.clearConversation(h.tab, { preserveStorage: true });
    assert.equal(h.agent._guardRunStates.has(h.tab), false);
    assert.equal(h.agent._guardRefusesOnce(h.tab, 'done-verification-debt', { decided: false, caveat: 'Not checked.' }), true,
      `${build}: a cleared conversation starts with a fresh note`);
  });

  test(`${build}: a scheduled resume is a pause, so its summary gets no caveat`, async () => {
    const h = batchAgent(Agent);
    h.agent._guardRunState(h.tab).caveats.set('chat-send-preconditions', 'A caveat from another guard family.');
    h.agent._isSuccessfulSchedulingEvidence = () => true;
    h.agent.executeTool = async () => ({ done: true, success: true, scheduled: true, summary: 'I will continue at 09:00.' });
    const toolCalls = [{ id: `schedule_resume_${nextCall++}`, function: { name: 'schedule_resume', arguments: JSON.stringify({
      after_seconds: 3600, reason: 'Waiting for CI.', resume_instruction: 'Check the CI result first.' }) } }];
    const messages = h.agent.conversations.get(h.tab);
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
    const result = await h.agent._executeToolBatch(h.tab, toolCalls, messages, () => {}, { supportsVision: false }, null,
      new Set(['done', 'schedule_resume']), 1, {}, null);
    assert.equal(result.status, 'scheduled_resume');
    assert.equal(result.value, 'I will continue at 09:00.');
  });

  test(`${build}: the forced recovery policy and failure-only done exist only under Strict checks`, () => {
    for (const strict of [false, true]) {
      const agent = new Agent({});
      agent.strictGuards = strict;
      const tab = nextTab++;
      agent.conversationModes.set(tab, 'act');
      agent.completionInvariants.set(tab, invariant.recordCompletionToolResult(
        invariant.createCompletionInvariantState(`${build}-policy`), 'download_public_media',
        { __completionDownloadAction: true }, { success: true, completedCount: 1 }));
      const policy = agent._completionRecoveryPolicy(tab, getToolsForMode('act', { compact: true }), { verification: true });
      if (strict) {
        assert.equal(policy?.kind, 'verification_unavailable', `${build}: ${STRICT_NOTE}`);
        assert.deepEqual(policy.tools[0].function.parameters.properties.outcome.enum, ['partial', 'failed']);
      } else {
        assert.equal(policy, null, `${build}: no forced turn and no failure-only done by default`);
      }
    }
  });

  // ── Completion invariant (pre-dispatch) ────────────────────────────────
  test(`${build}: unverified iframe fields, a toolbar target and a same-batch success are each advised once`, async () => {
    await refusedOnceThenAccepted(Agent, {
      prepare: h => h.agent.completionInvariants.set(h.tab, { ...invariant.createCompletionInvariantState('iframe'),
        hadAction: true, iframeFormVerificationDebt: true, iframeFormScope: 'forms.owned.example',
        iframeFormVerificationObligations: [{ scope: 'forms.owned.example', selector: '#email' }] }),
    }, { summary: 'Filled the form.', outcome: 'success' },
    'The form fields edited inside an embedded frame were not read back.', `${build} iframe`);

    await refusedOnceThenAccepted(Agent, {
      prepare: h => { h.agent._richTextToolbarGuard.completionAction = () => ({ name: 'type_ax', ref_id: 'ref_bold' }); },
    }, { summary: 'Wrote the post.', outcome: 'success' },
    'The last text may have gone into a formatting toolbar instead of the editor.', `${build} toolbar`);

    for (const strict of [false, true]) {
      const h = batchAgent(Agent, { strict });
      h.agent.completionInvariants.set(h.tab, invariant.createCompletionInvariantState('same-batch'));
      const sameBatch = [['click_ax', { ref_id: 'ref_save' }], ['get_accessibility_tree', { filter: 'visible' }],
        ['done', { summary: 'Saved.', outcome: 'success' }]];
      assert.equal((await h.batch(sameBatch)).action, 'continue', `${build}: same-batch success is refused first`);
      const second = await h.batch(sameBatch);
      if (strict) assert.equal(second.action, 'continue', `${build}: ${STRICT_NOTE} (same batch)`);
      else assert.equal(second.value, `Saved.\n\n${CAVEAT}Success was reported in the same step as the last action, before its result was seen.`);
    }
  });

  test(`${build}: two completion invariants each get one note, and both caveats reach the answer`, async () => {
    for (const strict of [false, true]) {
      const h = batchAgent(Agent, { strict });
      // A toolbar obligation (decided: the text went to the wrong place) and
      // verification debt (undecided: the page was not read again).
      h.agent._richTextToolbarGuard.completionAction = () => ({ name: 'type_ax', ref_id: 'ref_bold' });
      h.agent.completionInvariants.set(h.tab, { ...invariant.createCompletionInvariantState('two'), hadAction: true,
        verificationDebt: true, sequence: 1, lastAction: { name: 'click_ax', sequence: 1 } });
      const done = ['done', { summary: 'Wrote the post.', outcome: 'success' }];
      const reasons = () => h.agent.conversations.get(h.tab).filter(message => message.role === 'tool')
        .map(message => { try { return JSON.parse(message.content).reason; } catch { return null; } }).filter(Boolean);
      assert.equal((await h.batch([done])).action, 'continue');
      assert.equal((await h.batch([done])).action, 'continue');
      if (strict) {
        assert.deepEqual(reasons(), ['rich_text_toolbar_target_unresolved', 'rich_text_toolbar_target_unresolved'],
          `${build}: ${STRICT_NOTE}`);
        assert.equal((await h.batch([done])).action, 'continue', `${build}: ${STRICT_NOTE}`);
        continue;
      }
      assert.deepEqual(reasons(), ['rich_text_toolbar_target_unresolved', 'verification_required'],
        `${build}: the second invariant was masked by the first`);
      const updates = [];
      const third = await h.batch([done], updates);
      assert.equal(third.action, 'return');
      assert.equal(third.value, `Wrote the post.\n\n${CAVEAT}The last text may have gone into a formatting toolbar instead of the editor. The page was not checked again after the last action.`);
      // Accepted over a guard that knows the claim is wrong: the run ends,
      // but not as a success.
      const doneResult = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1)?.data.result;
      assert.equal(doneResult?.outcome, 'partial', `${build}: a success over a decided guard was not downgraded`);
    }
  });

  test(`${build}: a success accepted over undecided advice keeps its outcome`, async () => {
    const h = batchAgent(Agent);
    // The debt was carried in from an earlier batch: accepting it is not a
    // second "same-batch" concern.
    h.agent.completionInvariants.set(h.tab, { ...invariant.createCompletionInvariantState('undecided'), hadAction: true,
      verificationDebt: true, sequence: 1, lastAction: { name: 'click_ax', sequence: 1 } });
    const done = ['done', { summary: 'Saved.', outcome: 'success' }];
    assert.equal((await h.batch([done])).action, 'continue');
    const updates = [];
    const second = await h.batch([done], updates);
    assert.equal(second.action, 'return');
    const doneResult = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1)?.data.result;
    assert.equal(doneResult?.outcome, 'success', `${build}: missing evidence alone must not downgrade the outcome`);
    assert.equal(second.endStatus, undefined, `${build}: missing evidence alone must not end the run as partial`);
  });

  test(`${build}: a chat run's success accepted over a decided check ends with the chat partial contract`, async () => {
    const { chatRunEndedNotice, createChatSession } = await import(`../src/${build}/src/agent/chat-workflow.js`);
    for (const decided of [true, false]) {
      const h = batchAgent(Agent);
      h.agent.chatSessions.set(h.tab, createChatSession({ threadKey: 'dom:telegram:k:123456:0' }));
      if (decided) {
        // Text went into a formatting toolbar: the check knows the claim is wrong.
        h.agent._richTextToolbarGuard.completionAction = () => ({ name: 'type_ax', ref_id: 'ref_bold' });
      } else {
        // Only missing evidence: the page was not read again.
        h.agent.completionInvariants.set(h.tab, { ...invariant.createCompletionInvariantState('chat'), hadAction: true,
          verificationDebt: true, sequence: 1, lastAction: { name: 'click_ax', sequence: 1 } });
      }
      const done = ['done', { summary: 'Replied in the chat.', outcome: 'success' }];
      assert.equal((await h.batch([done])).action, 'continue', `${build}: the first completion gets its note`);
      const updates = [];
      const accepted = await h.batch([done], updates);
      assert.equal(accepted.action, 'return');
      const doneResult = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1)?.data.result;
      if (decided) {
        assert.equal(doneResult?.outcome, 'partial', `${build}: a success over a decided check was not downgraded`);
        assert.equal(doneResult?.runEnded, true, `${build}: a downgraded chat completion must end the chat run`);
        assert.equal(doneResult?.autoResumeScheduled, false, `${build}: a downgraded chat completion must not auto-resume`);
        assert.ok(String(doneResult?.summary).includes(chatRunEndedNotice()), `${build}: the chat run-ended notice is missing`);
      } else {
        assert.equal(doneResult?.outcome, 'success', `${build}: missing evidence alone must not downgrade a chat success`);
        assert.equal(doneResult?.runEnded, undefined);
        assert.equal(doneResult?.autoResumeScheduled, undefined);
        assert.ok(!String(doneResult?.summary).includes(chatRunEndedNotice()));
      }
    }
  });

  test(`${build}: a done with no outcome is advised once, then accepted as partial`, async () => {
    for (const strict of [false, true]) {
      const h = batchAgent(Agent, { strict });
      assert.equal((await h.batch([['done', { summary: 'Checked it.' }]])).action, 'continue');
      const second = await h.batch([['done', { summary: 'Checked it.' }]]);
      if (strict) {
        assert.equal(second.action, 'continue', `${build}: ${STRICT_NOTE}`);
        assert.equal(h.executed.length, 0);
      } else {
        assert.equal(second.action, 'return');
        assert.equal(h.executed.at(-1).args.outcome, 'partial', `${build}: an unnamed outcome claims no success`);
        assert.match(second.value, /counts as partial\.$/);
      }
    }
  });

  // ── Progress ledger ────────────────────────────────────────────────────
  test(`${build}: an honest partial over unresolved progress rows is refused once, then accepted`, async () => {
    const rows = [{ id: 'item-1', label: 'First', status: 'processed' }, { id: 'item-2', label: 'Second', status: 'pending' }];
    await refusedOnceThenAccepted(Agent, {
      prepare: h => { h.agent._currentTaskLedgerRows = () => rows; },
    }, { summary: 'One of two items is done.', outcome: 'partial' },
    '1 of 2 items in the task\'s progress list were not finished.', `${build} unresolved rows`);
  });

  test(`${build}: a success accepted over unfinished progress rows ends as partial`, async () => {
    for (const status of ['pending', 'acted']) {
      const h = batchAgent(Agent);
      h.agent._currentTaskLedgerRows = () => [{ id: 'item-1', label: 'First', status: 'processed' },
        { id: 'item-2', label: 'Second', status }];
      const done = ['done', { summary: 'Both items are done.', outcome: 'success' }];
      assert.equal((await h.batch([done])).action, 'continue', `${build} ${status}: the first success claim gets its note`);
      const updates = [];
      const accepted = await h.batch([done], updates);
      assert.equal(accepted.action, 'return', `${build} ${status}: the second success claim is accepted`);
      assert.ok(String(accepted.value).includes(`${CAVEAT}1 of 2 items in the task's progress list were not finished.`));
      const doneResult = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1)?.data.result;
      assert.equal(doneResult?.outcome, 'partial', `${build} ${status}: a success with an item unfinished was not downgraded`);
      assert.equal(accepted.status, undefined, `${build} ${status}: a correction can still reopen the done`);
      assert.equal(accepted.endStatus, 'partial', `${build} ${status}: the run must end as partial too`);
    }
  });

  test(`${build}: a done_json accepted over unfinished progress rows ends as partial`, async () => {
    // done_json is always a success claim; its result carries no outcome.
    const outputSchema = { type: 'object', properties: { items: { type: 'integer' } }, required: ['items'], additionalProperties: false };
    const schemas = new Map(getToolsForMode('act', { tier: 'full', cloudRun: true, outputSchema })
      .map(tool => [tool.function.name, tool.function.parameters]));
    assert.ok(schemas.has('done_json'), `${build}: the structured run offers done_json`);
    const h = batchAgent(Agent, { schemas });
    h.agent.cloudRunContexts.set(h.tab, { outputSchema });
    h.agent._currentTaskLedgerRows = () => [{ id: 'item-1', label: 'First', status: 'processed' },
      { id: 'item-2', label: 'Second', status: 'pending' }];
    const stub = h.agent.executeTool;
    h.agent.executeTool = async (tab, name, args, ...rest) => (name === 'done_json'
      ? { done: true, doneJson: true, summary: args.summary, result: args.result, cloudResult: args.result }
      : stub(tab, name, args, ...rest));
    const batch = async (updates = []) => {
      const toolCalls = [{ id: `done_json_${nextCall++}`, function: { name: 'done_json',
        arguments: JSON.stringify({ summary: 'Both items are done.', result: { items: 2 } }) } }];
      const messages = h.agent.conversations.get(h.tab);
      messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
      return h.agent._executeToolBatch(h.tab, toolCalls, messages, (type, data) => updates.push({ type, data }),
        { supportsVision: false }, null, new Set(['done_json', 'click_ax', 'get_accessibility_tree']), 1, {}, schemas);
    };
    assert.equal((await batch()).action, 'continue', `${build}: the first done_json gets its note`);
    const updates = [];
    const accepted = await batch(updates);
    assert.equal(accepted.action, 'return', `${build}: the second done_json is accepted`);
    const doneResult = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done_json').at(-1)?.data.result;
    assert.equal(doneResult?.outcome, 'partial', `${build}: an accepted done_json over an unfinished item was not downgraded`);
    assert.deepEqual(doneResult?.cloudResult, { items: 2 }, `${build}: the structured result is still delivered`);
  });

  test(`${build}: a success claim over skipped or failed progress rows is advised once`, async () => {
    const rows = [{ id: 'item-1', label: 'First', status: 'processed' }, { id: 'item-2', label: 'Second', status: 'skipped' }];
    await refusedOnceThenAccepted(Agent, {
      prepare: h => { h.agent._currentTaskLedgerRows = () => rows; },
    }, { summary: 'Both items are handled.', outcome: 'success' },
    'Some items in the task\'s progress list are missing, incomplete, skipped or failed.', `${build} skipped rows`);
  });

  // ── Read coverage ──────────────────────────────────────────────────────
  test(`${build}: Ask keeps the answer and adds the Gmail expansion limitation after one note`, async () => {
    for (const strict of [false, true]) {
      const h = batchAgent(Agent, { mode: 'ask', strict });
      h.agent._runModeOverrides.set(h.tab, 'ask');
      h.agent._currentUrl = async () => 'https://mail.google.com/mail/u/0/#inbox/FMfc123';
      await h.agent._beginReadCompleteness(h.tab, 'What is going on in this conversation?', {});
      h.agent._armReadCompletenessFromPlan(h.tab, { request_kind: 'execute', read_scope: 'complete_thread' });
      const root = `ref_${build}_root`;
      h.agent._recordReadCompleteness(h.tab, 'get_accessibility_tree', { filter: 'visible', maxDepth: 12 }, {
        pageContent: 'main\n button "Expand all"', page: 1, hasMore: false, truncated: false,
        conversationRootRefId: root, conversationExpansionState: 'collapsed' });
      h.agent._recordReadCompleteness(h.tab, 'get_accessibility_tree', { filter: 'all', maxDepth: 15, ref_id: root }, {
        pageContent: 'main\n button "Expand all"\n listitem "Latest visible message"', page: 1, totalChars: 1200,
        hasMore: false, truncated: false, continuationArgs: null, conversationRootRefId: root,
        conversationExpansionState: 'collapsed', treeRevision: 'fnv1a64:4444444444444444' });
      const done = ['done', { summary: 'The visible messages discuss the launch date.' }];
      const first = await h.batch([done]);
      if (strict) {
        assert.equal(first.status, 'read_scope_limited', `${build}: ${STRICT_NOTE} (fixed limitation)`);
        assert.match(first.value, /Ask mode cannot expand/);
        continue;
      }
      assert.equal(first.action, 'continue', `${build}: the answer gets one coverage note`);
      const second = await h.batch([done]);
      assert.equal(second.action, 'return');
      assert.equal(second.value, `The visible messages discuss the launch date.\n\n${CAVEAT}Ask mode cannot expand collapsed Gmail messages, so some messages in the conversation may be missing.`);
    }
  });

  test(`${build}: a success accepted over unread pages of a requested whole read ends as partial`, async () => {
    // decided: page 2 of the thread was never read (the check knows).
    // Undecided: Act mode could not confirm Gmail's expansion.
    for (const decided of [true, false]) {
      const h = batchAgent(Agent, { task: 'Summarize this whole conversation.' });
      h.agent._currentUrl = async () => decided ? 'https://outlook.live.com/mail/0/inbox/id/AQMkADAwATM0MDAAMS1i'
        : 'https://mail.google.com/mail/u/0/#inbox/FMfc123';
      await h.agent._beginReadCompleteness(h.tab, 'Summarize this whole conversation.', {});
      h.agent._armReadCompletenessFromPlan(h.tab, { request_kind: 'execute', read_scope: 'complete_thread' });
      if (decided) {
        h.agent._recordReadCompleteness(h.tab, 'get_accessibility_tree', { filter: 'all', maxDepth: 15 }, {
          pageContent: 'main\n listitem "First message"', page: 1, totalChars: 9000, hasMore: true, truncated: false, nextPage: 2 });
      } else {
        const root = `ref_${build}_root`;
        h.agent._recordReadCompleteness(h.tab, 'get_accessibility_tree', { filter: 'visible', maxDepth: 12 }, {
          pageContent: 'main\n button "Expand all"', page: 1, hasMore: false, truncated: false,
          conversationRootRefId: root, conversationExpansionState: 'collapsed' });
        h.agent._recordReadCompleteness(h.tab, 'get_accessibility_tree', { filter: 'all', maxDepth: 15, ref_id: root }, {
          pageContent: 'main\n button "Expand all"\n listitem "Latest visible message"', page: 1, totalChars: 1200,
          hasMore: false, truncated: false, continuationArgs: null, conversationRootRefId: root,
          conversationExpansionState: 'collapsed', treeRevision: 'fnv1a64:4444444444444444' });
      }
      const state = h.agent.readCompletenessStates.get(h.tab);
      assert.equal(state?.required === true && state.complete === false, true, `${build}: the whole read must be required and incomplete`);
      const done = ['done', { summary: 'The thread settles the launch date.', outcome: 'success' }];
      assert.equal((await h.batch([done])).action, 'continue', `${build}: the first completion gets its coverage note`);
      const updates = [];
      const accepted = await h.batch([done], updates);
      assert.equal(accepted.action, 'return', `${build}: the second completion is accepted`);
      assert.match(String(accepted.value), decided ? /Not every part of the conversation was confirmed as read\./
        : /Some Gmail messages may have stayed collapsed/);
      const doneResult = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1)?.data.result;
      assert.equal(doneResult?.outcome, decided ? 'partial' : 'success', decided
        ? `${build}: a success over unread pages was not downgraded`
        : `${build}: an unconfirmed Gmail expansion alone must not downgrade the outcome`);
    }
  });

  // ── Exact table export ─────────────────────────────────────────────────
  test(`${build}: table JSON without an exact extract, and an expired table reference, are advised once`, async () => {
    const json = JSON.stringify({ rowCount: 2, rows: [{ id: 'A' }, { id: 'B' }] });
    await refusedOnceThenAccepted(Agent, {
      options: { mode: 'ask', realDone: true },
      prepare: h => h.agent.readCompletenessStates.set(h.tab, { runToken: 'owned-run', tablePageObserved: true }),
    }, { summary: json, outcome: 'success' }, 'The table was not checked against the exact rows on the page.', `${build} table json`);
    const askSchemas = new Map(getToolsForMode('ask', { tier: 'full' }).map(tool => [tool.function.name, tool.function.parameters]));
    await refusedOnceThenAccepted(Agent, {
      options: { mode: 'ask', realDone: true, schemas: askSchemas },
      prepare: h => h.agent.readCompletenessStates.set(h.tab, { runToken: 'owned-run', tablePageObserved: true }),
    }, { summary: 'Full inventory.', data_ref: 'table_expired' },
    'The table reference had expired, so the exact table could not be delivered.', `${build} table ref`);
  });

  test(`${build}: an unverifiable table snapshot is delivered over advice, but not under Strict secret mode`, async () => {
    for (const strictSecretMode of [false, true]) {
      const h = batchAgent(Agent, { mode: 'ask' });
      h.agent.strictSecretMode = strictSecretMode;
      const owner = { runToken: 'owned-run', current: () => true };
      const record = { dataRef: 'table_owned', runToken: 'owned-run', owner, args: { columns: ['id'] },
        summary: '[{"id":"A"},{"id":"B"}]' };
      h.agent.readCompletenessStates.set(h.tab, { runToken: 'owned-run', exactTableExports: new Map([['table_owned', record]]) });
      h.agent._exactTableOwner = () => owner;
      h.agent.executeTool = async () => ({ success: false, error: 'The source table changed.' });
      const args = () => ({ summary: 'Full inventory.', data_ref: 'table_owned' });
      const first = await h.agent._resolveExactTableDone(h.tab, args());
      assert.equal(first?.blockedDone, true, `${build}: the stale snapshot is refused once`);
      const accepted = args();
      assert.equal(await h.agent._resolveExactTableDone(h.tab, accepted), null);
      assert.equal(accepted.summary, strictSecretMode ? 'Full inventory.' : record.summary,
        `${build}: strictSecretMode=${strictSecretMode}`);
      assert.match(h.agent._guardCaveatLine(h.tab), /may have changed after it was extracted/);
    }
  });

  test(`${build}: an exact table delivered over advice stays valid JSON; its caveat travels beside it`, async () => {
    const askSchemas = new Map(getToolsForMode('ask', { tier: 'full' }).map(tool => [tool.function.name, tool.function.parameters]));
    const h = batchAgent(Agent, { mode: 'ask', realDone: true, schemas: askSchemas });
    const owner = { runToken: 'owned-run', current: () => true };
    const table = { rowCount: 2, rows: [{ id: 'A' }, { id: 'B' }] };
    const record = { dataRef: 'table_owned', runToken: 'owned-run', owner, args: { columns: ['id'] }, summary: JSON.stringify(table) };
    h.agent.readCompletenessStates.set(h.tab, { runToken: 'owned-run', exactTableExports: new Map([['table_owned', record]]) });
    h.agent._exactTableOwner = () => owner;
    const realExecute = h.agent.executeTool.bind(h.agent);
    h.agent.executeTool = async (tab, name, args, ...rest) => (name === 'extract_data'
      ? { success: false, error: 'The source table changed.' } : realExecute(tab, name, args, ...rest));
    const done = ['done', { summary: 'Full inventory.', data_ref: 'table_owned' }];
    assert.equal((await h.batch([done])).action, 'continue', `${build}: the stale snapshot is refused once`);
    const updates = [];
    const accepted = await h.batch([done], updates);
    assert.equal(accepted.action, 'return', `${build}: the second completion is accepted`);
    assert.deepEqual(JSON.parse(accepted.value), table, `${build}: the answer is the exact table, nothing appended`);
    const line = `${CAVEAT}The table on the page may have changed after it was extracted.`;
    const doneResult = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1)?.data.result;
    assert.equal(doneResult?.completionCaveat, line, `${build}: the done result carries the caveat`);
    assert.ok(updates.some(update => update.type === 'warning' && update.data.message === line), `${build}: the user sees it as a warning`);
    assert.ok(!updates.some(update => update.type === 'text' && String(update.data.content).includes(CAVEAT)),
      `${build}: no caveat in the answer text`);
  });

  // ── Arithmetic tasks ───────────────────────────────────────────────────
  test(`${build}: an honest failure before any calculator attempt is refused once, then accepted`, async () => {
    for (const strict of [false, true]) {
      const h = batchAgent(Agent, { strict });
      h.agent._pureCalculationToolPolicy = () => ({ scope: { owner: 'owned', runToken: 'run', expression: '2+2' },
        stale: false, attempted: false, names: ['calculate', 'done'] });
      const done = ['done', { summary: 'The calculator was not used.', outcome: 'failed' }];
      assert.equal((await h.batch([done])).action, 'continue', `${build}: premature done gets one note`);
      const second = await h.batch([done]);
      if (strict) {
        assert.equal(second.action, 'continue', `${build}: ${STRICT_NOTE}`);
        assert.equal(h.executed.length, 0);
      } else {
        assert.equal(second.value, `The calculator was not used.\n\n${CAVEAT}The result was not computed with the calculator.`);
      }
    }
  });

  // ── Meta-only done summary (Ask) ───────────────────────────────────────
  test(`${build}: a summary that only says an answer was given is advised once`, async () => {
    await refusedOnceThenAccepted(Agent, {
      options: { mode: 'ask' },
      prepare: h => { h.agent._semanticDecision = async (_tab, kind) => ({ choice: kind === 'done_summary' ? 'meta_only' : null }); },
    }, { summary: 'Explained how it works.', outcome: 'success' },
    'The final answer may only say that an answer was given, without the answer itself.', `${build} meta-only`);
  });

  // ── Plan-execution guard ───────────────────────────────────────────────
  const planCase = (gate, after = () => {}) => ({ prepare: h => {
    const guard = h.agent._startPlanExecutionGuard(h.tab, 'act', { requestKind: 'execute', ...gate });
    after(guard, h);
  } });

  test(`${build}: missing execution evidence is advised once, never ending the run`, async () => {
    await refusedOnceThenAccepted(Agent, planCase({ requiresStateChange: true }),
      { summary: 'Updated the profile.', outcome: 'success' }, 'I couldn\'t confirm that the requested change was made.', `${build} execution`);
    for (const strict of [false, true]) {
      const h = batchAgent(Agent, { strict });
      h.agent._startPlanExecutionGuard(h.tab, 'act', { requestKind: 'execute', requiresStateChange: true });
      await h.batch([['done', { summary: 'Updated.', outcome: 'success' }]]);
      const second = await h.batch([['done', { summary: 'Updated.', outcome: 'success' }]]);
      assert.equal(second.status, strict ? 'plan_only_output' : undefined, `${build}: strict alone ends the run`);
    }
  });

  test(`${build}: missing required, submission, publication and committed-file evidence are each advised once`, async () => {
    await refusedOnceThenAccepted(Agent, planCase({ requiresStateChange: false }, guard => {
      guard.requiredSchedulingTool = 'schedule_task';
      guard.successfulTaskToolCalls = 1; guard.evidenceTaskKey = guard.taskKey;
    }), { summary: 'Scheduled the reminder.', outcome: 'success' }, 'I couldn\'t confirm that the scheduled task was created.', `${build} scheduling`);

    await refusedOnceThenAccepted(Agent, planCase({ requiresStateChange: true, requiresSubmission: true }, guard => {
      guard.successfulConsequentialToolCalls = 1; guard.successfulTaskToolCalls = 1; guard.evidenceTaskKey = guard.taskKey;
    }), { summary: 'Sent the form.', outcome: 'success' }, 'I couldn\'t confirm that the submission went through.', `${build} submission`);

    await refusedOnceThenAccepted(Agent, planCase({ requiresStateChange: true, requiresSubmission: true }, guard => {
      guard.siteWorkflow = { adapterName: 'github', job: { id: 'edit-file-and-commit', template: 'publish', requiresSubmission: true } };
      guard.successfulConsequentialToolCalls = 1; guard.successfulTaskToolCalls = 1; guard.evidenceTaskKey = guard.taskKey;
    }), { summary: 'Committed README.md.', outcome: 'success' },
    'I couldn\'t confirm that the committed file matches the requested text.', `${build} github commit`);

    await refusedOnceThenAccepted(Agent, planCase({ requiresStateChange: true, requiresSubmission: true }, guard => {
      guard.workflowForbiddenSubmission = true;
      guard.siteWorkflow = { adapterName: 'owned', job: { id: 'prepare-form', template: 'form', requiresSubmission: false } };
      guard.successfulConsequentialToolCalls = 1; guard.successfulTaskToolCalls = 1; guard.evidenceTaskKey = guard.taskKey;
    }), { summary: 'Prepared the form.', outcome: 'success' },
    'The form was submitted even though the task was to leave it unsubmitted.', `${build} forbidden submission`);
  });

  test(`${build}: a social destination without evidence is advised once with "do not republish" intact`, async () => {
    const { normalizePublicationContract } = await import(`../src/${build}/src/agent/social-publish-contract.js`);
    for (const strict of [false, true]) {
      const h = batchAgent(Agent, { strict, task: 'Post "Hello" on X.' });
      const guard = h.agent._startPlanExecutionGuard(h.tab, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
      const contract = normalizePublicationContract({ version: 1, status: 'ready', actions: [{ id: 'p1', platform: 'twitter',
        account: null, posts: [{ body: { kind: 'exact', source: { source: 'request', start: 'Hello', end: 'Hello' } },
          media: { kind: 'count', type: 'any', format: null, min: 0, max: 0 }, context: { kind: 'post', target: null } }] }],
      requirements: 'p1', prohibited: [], reason: 'post' }, { request: 'Post "Hello" on X.' });
      guard.socialPublication = { key: 'contract-key', actionId: 'p1', contract, outcomes: { p1: { status: 'pending' } } };
      guard.successfulConsequentialToolCalls = 1; guard.successfulTaskToolCalls = 1; guard.evidenceTaskKey = guard.taskKey;
      const messages = h.agent.conversations.get(h.tab);
      assert.equal((await h.batch([['done', { summary: 'Posted.', outcome: 'success' }]])).action, 'continue');
      assert.match(String(messages.at(-1)?.content || ''), /Do not republish/, `${build}: the note keeps the republish warning`);
      const second = await h.batch([['done', { summary: 'Posted.', outcome: 'success' }]]);
      if (strict) assert.equal(second.status, 'required_evidence_missing', `${build}: ${STRICT_NOTE}`);
      else assert.equal(second.value, `Posted.\n\n${CAVEAT}I couldn't confirm the post on X.`);
    }
  });

  test(`${build}: a plain final in an execute task is advised once, then accepted instead of ending the run`, () => {
    for (const strict of [false, true]) {
      const agent = new Agent({});
      agent.strictGuards = strict;
      const tab = nextTab++;
      agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false });
      const first = agent._planOnlyTerminalDecision(tab, 'The page lists three plans.');
      assert.equal(first?.retry, true, `${build}: one done-protocol note`);
      assert.match(first.nudge, /plain text cannot end it/);
      const second = agent._planOnlyTerminalDecision(tab, 'The page lists three plans.');
      if (strict) assert.equal(second?.status, 'plan_only_output', `${build}: ${STRICT_NOTE}`);
      else {
        assert.equal(second, null, `${build}: the plain final is accepted`);
        assert.equal(agent._withCompletionCaveat(tab, 'The page lists three plans.'),
          `The page lists three plans.\n\n${CAVEAT}The task ended with a plain answer instead of a checked completion. `
          + 'No successful page read or tool result backs this answer.');
      }
    }
  });

  test(`${build}: a false Ask-mode claim gets its correction once, then is shown with a caveat`, async () => {
    await refusedOnceThenAccepted(Agent, {
      prepare: h => {
        const guard = h.agent._startPlanExecutionGuard(h.tab, 'act', { requestKind: 'execute', requiresStateChange: true });
        guard.successfulTaskToolCalls = 1; guard.evidenceTaskKey = guard.taskKey;
        h.agent._semanticDecision = async (_tab, kind) => ({ choice: kind === 'done_summary' ? 'mode_claim' : null });
      },
    }, { summary: 'I cannot change pages in Ask mode.', outcome: 'failed' },
    'The final answer blamed a read-only mode that was not in use.', `${build} mode claim`);
  });

  test(`${build}: planner JSON and a drifted task keep their strict ending by default`, () => {
    const agent = new Agent({});
    const tab = nextTab++;
    const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false });
    agent._markPlanExecutionToolCall(tab, 'read_page', { success: true });
    const plan = JSON.stringify({ summary: 'Plan.', steps: [{ id: '1', action: 'Read.' }], confidence: 0.9 });
    assert.equal(agent._planOnlyTerminalDecision(tab, plan)?.retry, true, `${build}: planner JSON gets one nudge`);
    assert.match(agent._planOnlyTerminalDecision(tab, plan)?.failure || '', /./, `${build}: a planner object holds no answer to accept`);
    const drifted = new Agent({});
    const driftTab = nextTab++;
    const driftGuard = drifted._startPlanExecutionGuard(driftTab, 'act', { requestKind: 'execute', requiresStateChange: true });
    driftGuard.taskDrifted = true;
    assert.equal(drifted._planOnlyTerminalDecision(driftTab, 'Done.', { viaDone: true, outcome: 'success' })?.retry, true);
    assert.equal(drifted._planOnlyTerminalDecision(driftTab, 'Done.', { viaDone: true, outcome: 'success' })?.status,
      'task_binding_changed', `${build}: a drifted task is a host check and still ends the run`);
    assert.ok(guard);
  });

  // ── Bot memory (managed Cloud bot runs) ────────────────────────────────
  test(`${build}: done over an uncertain bot-memory action is advised once`, async () => {
    for (const strict of [false, true]) {
      const agent = new Agent({ getActive: () => ({ model: 'test' }) });
      agent.strictGuards = strict;
      const tab = nextTab++;
      const memory = {
        prepare: async (_tab, name, args) => (name === 'done' && args.outcome === 'success'
          ? { allowed: false, reason: 'A dispatched action still has an uncertain outcome.' } : { allowed: true, readOnly: true }),
        afterTool: async () => {},
        tool: async () => ({ success: true }),
      };
      agent._botMemorySessions.set(tab, memory);
      agent._executeToolWithLifecycle = async (_tab, name, args) => ({ done: true, summary: args.summary, outcome: args.outcome });
      const first = await agent.executeTool(tab, 'done', { summary: 'Sent the reminder.', outcome: 'success' });
      assert.equal(first.blockedDone, true, `${build}: the first success claim is refused`);
      const second = await agent.executeTool(tab, 'done', { summary: 'Sent the reminder.', outcome: 'success' });
      if (strict) assert.equal(second.blockedDone, true, `${build}: ${STRICT_NOTE}`);
      else {
        assert.equal(second.done, true, `${build}: the second success claim goes through`);
        assert.match(agent._withCompletionCaveat(tab, 'x'), /An earlier action's result was still uncertain/);
      }
    }
  });

  // ── Done handler: judge, freshness, page warnings, incomplete task ─────
  test(`${build}: a failed completion verdict is advised once, then accepted with a caveat`, async () => {
    try {
      for (const strict of [false, true]) {
        const h = handlerAgent(Agent, build, { strict, verdict: 'failed' });
        const first = await h.agent.executeTool(h.tab, 'done', { summary: 'Saved.', outcome: 'success' });
        assert.equal(first.blockedDone, true, `${build}: ${JSON.stringify(first)}`);
        assert.equal(first.completionDecision?.outcome, 'failed');
        const second = await h.agent.executeTool(h.tab, 'done', { summary: 'Saved.', outcome: 'success' });
        if (strict) assert.equal(second.blockedDone, true, `${build}: ${STRICT_NOTE}`);
        else {
          assert.equal(second.done, true, `${build}: ${JSON.stringify(second)}`);
          assert.equal(second.verification?.decision?.outcome, 'failed', `${build}: the verdict stays on the result`);
          assert.match(h.agent._withCompletionCaveat(h.tab, 'x'), /suggested that the task did not succeed/);
        }
      }
    } finally { restoreGlobals(); }
  });

  test(`${build}: a submitted iframe that cannot be read again is advised once`, async () => {
    try {
      for (const strict of [false, true]) {
        const h = handlerAgent(Agent, build, { strict });
        h.agent._completionSubmitStates.set(h.tab, { dispatched: true, iframeSubmission: { frameId: 3 } });
        h.agent._completionIframeEvidence = async () => null;
        const first = await h.agent.executeTool(h.tab, 'done', { summary: 'Submitted.', outcome: 'success' });
        assert.equal(first.blockedDone, true, `${build}: ${JSON.stringify(first)}`);
        assert.equal(first.completionDecision?.engine, 'freshness');
        const second = await h.agent.executeTool(h.tab, 'done', { summary: 'Submitted.', outcome: 'success' });
        if (strict) assert.equal(second.blockedDone, true, `${build}: ${STRICT_NOTE}`);
        else {
          assert.equal(second.done, true, `${build}: ${JSON.stringify(second)}`);
          assert.match(h.agent._withCompletionCaveat(h.tab, 'x'), /embedded frame could not be read again/);
        }
      }
    } finally { restoreGlobals(); }
  });

  test(`${build}: an open dialog at done is warned about once by default, twice under Strict checks`, async () => {
    try {
      for (const strict of [false, true]) {
        const h = handlerAgent(Agent, build, { strict, page: { openDialogCount: 1, dialogTitles: ['Unsaved changes'] } });
        const first = await h.agent.executeTool(h.tab, 'done', { summary: 'Saved.', outcome: 'success' });
        assert.equal(first.completionPageBlock, true, `${build}: ${JSON.stringify(first)}`);
        assert.doesNotMatch(first.error, strict ? /^$/ : /block attempt/, `${build}: the default note names no second block`);
        const second = await h.agent.executeTool(h.tab, 'done', { summary: 'Saved.', outcome: 'success' });
        if (strict) {
          assert.equal(second.completionPageBlock, true, `${build}: ${STRICT_NOTE} (second block)`);
          const third = await h.agent.executeTool(h.tab, 'done', { summary: 'Saved.', outcome: 'success' });
          assert.equal(third.done, true, `${build}: strict lets the third done through`);
        } else {
          assert.equal(second.done, true, `${build}: ${JSON.stringify(second)}`);
          assert.match(second.verification.completionWarning, /dialog is still open/, `${build}: the warning stays on the result`);
          assert.match(h.agent._withCompletionCaveat(h.tab, 'x'), /A dialog was still open on the page at the end\./);
        }
      }
    } finally { restoreGlobals(); }
  });

  test(`${build}: the incomplete-task judge redirects an honest partial once, then is not asked again`, async () => {
    try {
      for (const strict of [false, true]) {
        const h = handlerAgent(Agent, build, { strict });
        h.agent._beginCompletionInvariant(h.tab);
        h.agent._startPlanExecutionGuard(h.tab, 'act', { requestKind: 'execute', requiresStateChange: true });
        let judged = 0;
        h.agent._semanticDecision = async (_tab, kind) => {
          if (kind === 'incomplete_task') { judged++; return { choice: 'continue_now' }; }
          return { choice: null };
        };
        const done = { summary: 'The profile still needs a photo.', outcome: 'partial' };
        const first = await h.agent.executeTool(h.tab, 'done', done);
        assert.equal(first.recoverableIncomplete, true, `${build}: ${JSON.stringify(first)}`);
        assert.match(first.error, /reasonable next step/);
        const second = await h.agent.executeTool(h.tab, 'done', done);
        if (strict) {
          assert.equal(second.recoverableIncomplete, true, `${build}: ${STRICT_NOTE} (second redirect)`);
          assert.equal(judged, 2);
        } else {
          assert.equal(second.done, true, `${build}: the honest partial ends the run`);
          assert.equal(second.outcome, 'partial');
          assert.equal(judged, 1, `${build}: the judge is not asked again`);
        }
      }
    } finally { restoreGlobals(); }
  });
}

test('chrome: an on-device answer cut off mid-sentence twice is shown with a caveat by default', async () => {
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  for (const strict of [false, true]) {
    const agent = new Agent({});
    agent.strictGuards = strict;
    const tab = nextTab++;
    assert.equal(agent._standaloneTruncationRefuses(tab), true, 'the first cut-off answer is retried');
    assert.equal(agent._standaloneTruncationRefuses(tab), strict, strict ? STRICT_NOTE : 'the second is shown');
    if (!strict) assert.match(agent._withCompletionCaveat(tab, 'Partial.'), /The on-device answer may be cut off\.$/);
  }
});
