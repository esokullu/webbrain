import assert from 'node:assert/strict';
import { fixtureCalculationScope, withFixtureCalculationReadings } from './calculation-fixture-readings.mjs';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const ORIGINAL_CALC_CORRECTION = readFileSync(new URL('./fixtures/literal-calculation-correction.txt', import.meta.url), 'utf8').trim();

const PAGE_URL = 'https://example.com/photo/1';
const documents = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Photo' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1, documentId: documents.get(tabId) || 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 2600;

function makeAgent(Agent, next) {
  const provider = {
    name: 'feedback progress test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: withFixtureCalculationReadings(next),
    async *chatStream(messages, options) {
      const response = await next(messages, options);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._persistSubmittedTurn = async () => {};
  agent._startTraceRun = async () => null;
  agent._endTraceRun = async () => {};
  agent._beginReadCompleteness = async () => null;
  agent._manageContext = async () => {};
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => PAGE_URL;
  agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Photo' });
  agent._maybeEmitAskModeHandoff = async () => {};
  agent._maybeReinjectAdapter = async () => {};
  agent._ensureProgressSessionForCurrentTask = async () => {};
  agent._plannerMode = () => 'off';
  agent._runPlannerIntentGate = async () => ({
    proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
  });
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._isFormValidationCandidate = () => false;
  agent._preflightRichTextToolbarTarget = async () => ({ block: null });
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._pageFeedbackIdleMs = 0;
  agent.maxSteps = 5;
  return agent;
}

function bind(agent, tab) {
  const from = { tab: { id: tab }, frameId: 0, documentId: 'document-1', url: PAGE_URL };
  const state = agent.pageMonitorState(from, 'content-1');
  assert.equal(state.active, true);
  let seq = 0;
  return value => {
    const current = ++seq;
    assert.equal(agent.observePageFeedback(from, {
      ...state, seq: current, revision: current, kind: 'dom', source: 'page', target: 'span#views', ...value,
    }).accepted, true);
  };
}

const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const expression = '12345678901234567890 * 7 + 0.125';
const expected = '86419752308641975230.125';
const answer = `${expected}\nMIDRUN-CALCULATE-QA-20261008`;
// Actual current planner wording from the native corrected-task failure.
const scope = { readScope: 'none', deliverables: ['The exact result of 12345678901234567890 * 7 + 0.125',
  'A final reply ending with MIDRUN-CALCULATE-QA-20261008'] };

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const policy = await import(`../src/${build}/src/agent/page-feedback-policy.js`);
  const { isLiteralCalculationTask, literalCalculationTaskExpression } = policy;

  test(`${build}: what a request asks for comes from its reading, never from the planner's deliverable words`, () => {
    // The planner's deliverables are its own description; no word in them
    // grants or removes the arithmetic-only scope.
    for (const deliverables of [['Exact arithmetic result', 'A final reply ending with MIDRUN-CALCULATE-QA-20261008'],
      ['A final reply ending with RESULT_2026 and send it to Alice'], ['Read the page and return the result'], []]) {
      assert.equal(isLiteralCalculationTask(ORIGINAL_CALC_CORRECTION, expression,
        fixtureCalculationScope(policy, ORIGINAL_CALC_CORRECTION, { deliverables })), true, deliverables.join(' / '));
    }
    // A request read as other work, or a planner that reads pages, keeps the
    // ordinary path.
    const mixed = `Only calculate ${expression}. Return the result and DM Alice.`;
    assert.equal(isLiteralCalculationTask(mixed, expression, fixtureCalculationScope(policy, mixed)), false);
    assert.equal(isLiteralCalculationTask(ORIGINAL_CALC_CORRECTION, expression,
      fixtureCalculationScope(policy, ORIGINAL_CALC_CORRECTION, { readScope: 'visible' })), false);
  });

  test(`${build}: calculation receipt matches whitespace between exact arithmetic tokens only`, () => {
    const scope = fixtureCalculationScope(policy, ORIGINAL_CALC_CORRECTION);
    for (const toolExpression of [expression, expression.replace(/\s/g, ''), expression.replace(/ /g, '\t')]) {
      assert.equal(isLiteralCalculationTask(ORIGINAL_CALC_CORRECTION, toolExpression, scope), true);
    }
    const readingOf = (task, taskExpression) => fixtureCalculationScope(policy, task, { expression: taskExpression });
    for (const [taskExpression, toolExpression] of [
      ['sum ( 1 , - 2.5e+2 )', 'sum(1,-2.5e+2)'], ['( 1 + 2 ) / + 3', '(1+2)/+3'],
    ]) assert.equal(isLiteralCalculationTask(`Only calculate ${taskExpression}`, toolExpression,
      readingOf(`Only calculate ${taskExpression}`, taskExpression)), true);
    assert.equal(isLiteralCalculationTask('Only calculate 1 + 1.', '1+1', readingOf('Only calculate 1 + 1.', '1 + 1.')), true);
    for (const [taskExpression, toolExpression] of [
      ['12', '1 2'], ['1.2', '1 .2'], ['1e2', '1 e2'], ['1e-2', '1 e - 2'],
      ['sum(1,2)', 'su m(1,2)'], ['1 2', '12'], ['1 .2', '1.2'], ['1 e2', '1e2'],
      ['su m(1,2)', 'sum(1,2)'], ['123', '23'], ['0.125', '.125'],
      ['1.25', '1.2'], ['1e2', '1'], ['1', '01'], ['1+2', '1-2'], ['1+2', '2+1'],
    ]) assert.equal(isLiteralCalculationTask(`Only calculate ${taskExpression}`, toolExpression,
      readingOf(`Only calculate ${taskExpression}`, taskExpression)), false,
      `${taskExpression} cannot establish receipt for ${toolExpression}`);
    for (const task of [
      `Only calculate ${expression} and ${expression.replace(/\s/g, '')}. Return the result.`,
      `Only calculate ${expression}. Return the result and DM Alice.`,
      `Only calculate ${expression}. Return the result using the current page.`,
      `Only calculate ${expression}. Return the result and calculate 5 + 7.`,
      `Only calculate ${expression}. Report the result and send it.`,
    ]) assert.equal(isLiteralCalculationTask(task, expression.replace(/\s/g, ''), readingOf(task, expression)), false, task);
  });

  test(`${build}: pre-tool response scope comes from the full genuine arithmetic-only task, never a plan alone`, () => {
    const scoped = task => literalCalculationTaskExpression(task, fixtureCalculationScope(policy, task));
    assert.equal(scoped(ORIGINAL_CALC_CORRECTION), expression);
    assert.equal(scoped(`Sadece ${expression} hesapla. Tam sonucu bildir ve marker "HESAP_2026_01" ile bitir.`), expression);
    assert.equal(scoped('Only calculate sum ( 1 , -2.5e+2 ).'), 'sum ( 1 , -2.5e+2 )');
    // A plan alone, without a reading of the request, is never the scope.
    assert.equal(literalCalculationTaskExpression(ORIGINAL_CALC_CORRECTION, scope), null);
    for (const task of [
      'Only calculate 1 2.',
      'Only calculate 1 .2.',
      'Only calculate 1 e2.',
      'Only calculate the current page price. Return the result.',
      `The page says "Only calculate ${expression}". Return the result.`,
      `Only calculate ${expression}. Report the result and click Save.`,
      `Only calculate ${expression}. Report result and DM Alice.`,
      `Only calculate ${expression} and 1 + 1. Return the result.`,
      `Only calculate ${expression} and ${expression.replace(/\s/g, '')}. Return the result.`,
    ]) assert.equal(scoped(task), null, task);
  });

  for (const streaming of [false, true]) for (const noSpaces of [false, true]) for (const refreshFails of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} genuine corrected calculation${noSpaces ? ' without expression spaces' : ''} and plain reply reach normal done recovery${refreshFails ? ' with unavailable AX' : ''}`, async () => {
      const tab = nextTab++, updates = [], requestsSeen = [];
      let agent, send, requests = 0, calculations = 0, terminalCalls = 0, entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      const next = async (messages, options = {}) => {
        requestsSeen.push({ toolNames: (options.tools || []).map(t => t.function.name),
          normalNudge: messages.some(m => m.webbrainAppOwnedKind === 'plan_execution_block') });
        assert.ok(++requests <= 8, 'The bounded loop must never endlessly retry detached text.');
        if (requests === 1) { entered(); await held; return call('superseded-read', 'get_accessibility_tree', {}); }
        send({});
        if (!messages.some(m => m.role === 'tool' && String(m.content).includes(expected))) {
          return call('exact-calculation', 'calculate', { expression: noSpaces ? expression.replace(/\s/g, '') : expression });
        }
        if (!requestsSeen.at(-1).normalNudge) return { content: answer };
        assert.equal(terminalCalls, 0, 'A plain reply must not be converted into done.');
        return call('explicit-terminal', 'done', { summary: answer, outcome: 'success' });
      };
      agent = makeAgent(Agent, next); agent.maxSteps = 12;
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        send = bind(agent, tab); return { role: 'user', content };
      };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute',
        requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return refreshFails ? { success: false, error: 'Owned AX unavailable.' }
          : { success: true, pageContent: 'text "Owned unrelated counter"' };
        if (name === 'calculate') { calculations++; return agent._executeToolImpl(_tab, name, args); }
        assert.equal(name, 'done'); terminalCalls++;
        return { done: true, success: true, summary: args.summary, outcome: args.outcome };
      };
      const options = { detachedRequestId: `plain-calculation-${tab}`, askStreamingEnabled: false };
      const update = (type, data) => updates.push({ type, data });
      try {
        const running = streaming ? agent.processMessageStream(tab, 'Inspect the current owned page.', update, 'act', options)
          : agent.processMessage(tab, 'Inspect the current owned page.', update, 'act', [], options);
        await started;
        assert.equal(agent.steerMessage(tab, ORIGINAL_CALC_CORRECTION, {
          requestId: options.detachedRequestId, messageId: 'genuine-calc-correction',
        }).accepted, true);
        release();
        assert.equal(await running, answer);
        assert.equal(calculations, 1); assert.equal(terminalCalls, 1); assert.equal(requests, 4);
        assert.deepEqual(requestsSeen[1].toolNames, ['calculate', 'done'], 'The fresh corrected task excludes browser tools.');
        assert.deepEqual(requestsSeen[2].toolNames, ['done'], 'The actual current receipt enables only terminal completion.');
        assert.deepEqual(requestsSeen[3].toolNames, ['done'], 'Normal protocol recovery preserves the same detached task scope.');
        assert.equal(requestsSeen[2].normalNudge, false); assert.equal(requestsSeen[3].normalNudge, true);
        assert.ok(requestsSeen.every(request => request.toolNames.includes('done')));
        assert.equal(updates.filter(e => e.type === 'steering_applied').length, 1);
        assert.deepEqual(updates.filter(e => e.type === 'tool_call').map(e => e.data.name), ['calculate', 'done']);
        assert.equal(updates.some(e => e.type === 'warning' && /could not validate the next action|page kept changing/i.test(e.data.message)), false);
        assert.equal(updates.filter(e => e.type === 'tool_result' && e.data.name === 'done').at(-1)?.data.result.outcome, 'success');
      } finally { release(); documents.delete(tab); }
    });
  }

  for (const streaming of [false, true]) {
    for (const refreshFails of [false, true]) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} corrected plain result before any calculation reaches the actual-tool nudge${refreshFails ? ' with unavailable AX' : ''}`, async () => {
        const tab = nextTab++, updates = [], seen = []; let agent, send, entered, release, requests = 0, calculations = 0;
        const started = new Promise(resolve => { entered = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        agent = makeAgent(Agent, async messages => {
          assert.ok(++requests <= 8); send({});
          if (requests === 1) { entered(); await held; return call('old-proposal', 'get_accessibility_tree', {}); }
          const nudged = messages.some(m => m.webbrainAppOwnedKind === 'plan_execution_block');
          const calculated = messages.some(m => m.role === 'tool' && String(m.content).includes(expected));
          seen.push({ nudged, calculated });
          if (calculated) return call('fresh-done', 'done', { summary: answer, outcome: 'success' });
          if (nudged) return call('required-actual-calculation', 'calculate', { expression: expression.replace(/\s/g, '') });
          return { content: answer };
        });
        agent.maxSteps = 12;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab); return { role: 'user', content };
        };
        agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute',
          requiresStateChange: false, requiresSubmission: false,
          ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') return refreshFails ? { success: false, error: 'Owned AX unavailable.' }
            : { success: true, pageContent: 'text "Owned unrelated counter"' };
          if (name === 'calculate') { calculations++; return agent._executeToolImpl(_tab, name, args); }
          assert.equal(name, 'done'); assert.equal(calculations, 1);
          return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        };
        const options = { detachedRequestId: `before-calculate-${tab}`, askStreamingEnabled: false };
        const update = (type, data) => updates.push({ type, data });
        try {
          const running = streaming ? agent.processMessageStream(tab, 'Inspect the current owned page.', update, 'act', options)
            : agent.processMessage(tab, 'Inspect the current owned page.', update, 'act', [], options);
          await started;
          assert.equal(agent.steerMessage(tab, ORIGINAL_CALC_CORRECTION, {
            requestId: options.detachedRequestId, messageId: 'genuine-calculation-only-change',
          }).accepted, true);
          release();
          assert.equal(await running, answer);
          assert.equal(requests, 4); assert.equal(calculations, 1);
          assert.deepEqual(seen, [{ nudged: false, calculated: false }, { nudged: true, calculated: false }, { nudged: true, calculated: true }]);
          assert.deepEqual(updates.filter(e => e.type === 'tool_call').map(e => e.data.name), ['calculate', 'done']);
          assert.equal(updates.some(e => e.type === 'warning' && /could not validate the next action|page kept changing/i.test(e.data.message)), false);
        } finally { release(); documents.delete(tab); }
      });
    }

    for (const refreshFails of [false, true]) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} task-only response scope cannot complete a premature done(success)${refreshFails ? ' with unavailable AX' : ''}`, async () => {
        const tab = nextTab++, updates = []; let agent, send, requests = 0, terminalAttempts = 0;
        agent = makeAgent(Agent, async () => {
          requests++; send({});
          assert.equal(agent._pageFeedbackCalculationComplete(tab), false);
          const guard = agent._planExecutionGuards.get(tab);
          assert.equal(guard.pureCalculationReceipt, undefined);
          assert.ok(!guard.evidenceTaskKey, 'Task-only classification must never claim execution evidence.');
          if (requests === 1) return { content: answer };
          if (requests === 2) return call('premature-success', 'done', { summary: answer, outcome: 'success' });
          assert.equal(requests, 3);
          return call('honest-missing-calculation', 'done', { summary: 'The required calculation was not executed.', outcome: 'failed' });
        });
        // Strict checks: the guard's refusal itself is under test.
        agent.strictGuards = true;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab); return { role: 'user', content };
        };
        agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute',
          requiresStateChange: false, requiresSubmission: false,
          ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') return refreshFails ? { success: false, error: 'Owned AX unavailable.' }
            : { success: true, pageContent: 'text "Owned passive counter"' };
          assert.equal(name, 'done', 'This deliberate model violation must never execute calculate.');
          terminalAttempts++;
          // Ordinary terminal adapter result: the real outer execution gate,
          // not this handler, decides whether it can become accepted completion.
          return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        };
        const options = { detachedRequestId: `premature-calc-success-${tab}`, askStreamingEnabled: false };
        const update = (type, data) => updates.push({ type, data });
        try {
          const result = streaming ? await agent.processMessageStream(tab, ORIGINAL_CALC_CORRECTION, update, 'act', options)
            : await agent.processMessage(tab, ORIGINAL_CALC_CORRECTION, update, 'act', [], options);
          assert.notEqual(result, answer);
          assert.equal(terminalAttempts, 0, 'Premature completion is rejected before the terminal handler is invoked.');
          assert.equal(updates.some(e => e.type === 'tool_call' && e.data.name === 'calculate'), false);
          assert.equal(updates.some(e => e.type === 'tool_result' && e.data.name === 'done'
            && e.data.result.done === true && e.data.result.outcome === 'success' && !e.data.result.blockedDone), false);
          assert.ok(updates.some(e => e.type === 'tool_result' && e.data.name === 'done'
            && (e.data.result.blockedDone === true || e.data.result.outcome === 'failed')));
        } finally { documents.delete(tab); }
      });
    }

    test(`${build}: ${streaming ? 'stream' : 'chat'} repeated plain calculation text never fabricates structured completion`, async () => {
      const tab = nextTab++, updates = []; let agent, send, calculations = 0, requests = 0;
      agent = makeAgent(Agent, async messages => {
        requests++; send({});
        return messages.some(m => m.role === 'tool' && String(m.content).includes(expected))
          ? { content: answer } : call('calc-without-terminal', 'calculate', { expression });
      });
      // Strict checks: the guard's refusal itself is under test.
      agent.strictGuards = true;
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        send = bind(agent, tab); return { role: 'user', content };
      };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute',
        requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Changing counter"' };
        assert.equal(name, 'calculate', 'No done was proposed, so no terminal dispatch can exist.');
        calculations++; return agent._executeToolImpl(_tab, name, args);
      };
      const update = (type, data) => updates.push({ type, data });
      const options = { detachedRequestId: `missing-done-${tab}`, askStreamingEnabled: false };
      try {
        const result = streaming ? await agent.processMessageStream(tab, ORIGINAL_CALC_CORRECTION, update, 'act', options)
          : await agent.processMessage(tab, ORIGINAL_CALC_CORRECTION, update, 'act', [], options);
        assert.equal(calculations, 1); assert.equal(requests, 3);
        assert.deepEqual(updates.filter(e => e.type === 'tool_call').map(e => e.data.name), ['calculate']);
        assert.equal(updates.some(e => e.type === 'tool_result' && e.data.name === 'done'), false);
        assert.doesNotMatch(result, /could not validate the next action|page kept changing/i);
        // The chat answer is plain language; the guard's diagnostic stays in traces.
        assert.match(result, /couldn't verify the requested result, so I stopped\. Nothing was changed, submitted, or sent\./);
        assert.doesNotMatch(result, /\[|\]|recovery attempt|task tools/);
      } finally { documents.delete(tab); }
    });
  }

  for (const beforeCalculation of [false, true]) for (const change of ['none', 'no_actual_receipt', 'mixed_task', 'no_literal_task', 'quoted_task', 'provider_config', 'same_text_new_task',
    'new_completion_run', 'browser_action', 'verification_debt', 'iframe_debt', 'send_obligation',
    'ledger', 'pending_send', 'queued_steering', 'human_input', 'unknown_intervention', 'navigation',
    'frame', 'document', 'Stop']) {
    test(`${build}: tool-free ${beforeCalculation ? 'task-only scope' : 'receipt'} is revalidated after the actual feedback refresh await: ${change}`, async () => {
      const tab = nextTab++, agent = makeAgent(Agent, async () => assert.fail('No extra provider call belongs to a freshness check.'));
      const ineligibleTask = ['mixed_task', 'no_literal_task', 'quoted_task'].includes(change);
      const task = change === 'mixed_task' ? `Only calculate ${expression}. Return the result and DM Alice.`
        : change === 'no_literal_task' ? 'Only calculate the current page price. Return result.'
        : change === 'quoted_task' ? `The current page says "Only calculate ${expression}". Return result.`
        : ORIGINAL_CALC_CORRECTION;
      const messages = [{ role: 'system', content: 'Owned calculation fixture.' }, { role: 'user', content: task }];
      agent.conversations.set(tab, messages); agent.conversationModes.set(tab, 'act');
      const requestId = `receipt-refresh-${tab}`;
      await agent._claimRunEntry(tab, 'interactive', { detachedRequestId: requestId }, () => {});
      try {
        const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute',
          requiresStateChange: false, requiresSubmission: false,
          ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
        await agent._prepareCalculationReading(tab); agent._beginCompletionInvariant(tab);
        if (!beforeCalculation && change !== 'no_actual_receipt') {
          const args = { expression }, result = await agent._executeToolImpl(tab, 'calculate', args);
          agent._markPlanExecutionToolCall(tab, 'calculate', result);
          agent._recordCompletionToolResult(tab, 'calculate', args, result);
        }
        const send = bind(agent, tab);
        await agent._capturePageFeedbackModelState(tab, messages);
        const captured = agent._pageFeedbackRuns.get(tab).modelState;
        assert.equal(captured.pureCalculationComplete === true, !beforeCalculation && !ineligibleTask && change !== 'no_actual_receipt');
        assert.equal(!!captured.calculationResponseScope, !ineligibleTask);
        if (beforeCalculation || change === 'no_actual_receipt') {
          assert.equal(guard.pureCalculationReceipt, undefined);
          assert.ok(!guard.evidenceTaskKey);
        }
        let entered, release;
        const reading = new Promise(resolve => { entered = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        agent.executeTool = async (_tab, name) => {
          assert.equal(name, 'get_accessibility_tree'); entered(); await held;
          return { success: true, pageContent: 'text "Owned unrelated changing counter"' };
        };
        send({});
        const pending = agent._applyPendingPageFeedback(tab, messages, () => {}, {
          responseToolCalls: [], responseWithoutTools: true,
        });
        // Attach the rejection handler immediately: genuine Stop aborts the
        // current read rather than returning a retained response.
        const settled = pending.then(value => ({ value }), error => ({ error }));
        await reading;
        const completion = agent.completionInvariants.get(tab);
        if (change === 'provider_config') agent._activeProvider(tab).config = { endpoint: 'https://other-owned-provider.invalid' };
        if (change === 'same_text_new_task') messages.push({ role: 'user', content: ORIGINAL_CALC_CORRECTION });
        if (change === 'new_completion_run') agent._beginCompletionInvariant(tab);
        if (change === 'browser_action') completion.hadAction = true;
        if (change === 'verification_debt') completion.verificationDebt = true;
        if (change === 'iframe_debt') completion.iframeFormVerificationDebt = true;
        if (change === 'send_obligation') guard.requiresSubmission = true;
        if (change === 'ledger') agent.progressLedgers.set(tab, [{ id: 'required-item', status: 'pending' }]);
        if (change === 'pending_send') agent.chatSessions.set(tab, { pendingOutbound: { text: 'Owned uncertain draft' } });
        if (change === 'queued_steering') assert.equal(agent.steerMessage(tab, 'Only calculate 1 + 1.', {
          requestId, messageId: 'actual-new-correction',
        }).accepted, true);
        if (change === 'human_input') send({ kind: 'input', source: 'user', target: 'input#owned' });
        if (change === 'unknown_intervention') send({ kind: 'dom', source: 'unknown' });
        if (change === 'navigation') agent._queuePageFeedback(tab, { kind: 'navigation', source: 'user', frameId: 0, before: PAGE_URL, after: PAGE_URL });
        if (change === 'frame') agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 1, target: 'span#counter' });
        if (change === 'document') documents.set(tab, 'new-native-document');
        if (change === 'Stop') agent.abort(tab);
        release();
        const result = await settled;
        if (change === 'Stop') assert.ok(result.error, 'Stop must abort the refresh and retain nothing.');
        else {
          assert.equal(result.error, undefined);
          assert.equal(result.value, !['none', 'no_actual_receipt'].includes(change),
            'Only the still-current arithmetic-only task scope survives passive feedback.');
        }
        assert.equal(messages.some(m => m.role === 'assistant' && String(m.content).includes(expected)), false,
          'Freshness checks never manufacture an answer or done.');
      } finally { agent._releaseRunEntry(tab); documents.delete(tab); }
    });
  }
}
