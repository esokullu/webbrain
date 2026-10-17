import assert from 'node:assert/strict';
import { withFixtureCalculationReadings } from './calculation-fixture-readings.mjs';
import fs from 'node:fs';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const PAGE = 'https://example.com/owned';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area }, runtime: { getURL: p => `extension://test/${p}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE, title: 'Owned page' }), sendMessage: async (_id, m) => {
    if (m.action === 'page_monitor_capture_model') return { ready: true, runToken: m.params.runToken, documentToken: 'doc', snapshotToken: 'snapshot', targetCount: 1,
      page: { success: true, url: PAGE, pageContent: 'button "Owned" [ref_1]' } };
    if (m.action === 'page_monitor_validate_model') return { ready: true, runToken: m.params.runToken, documentToken: 'doc', snapshotToken: m.params.snapshotToken };
    return { ready: true };
  } }, scripting: { executeScript: async () => [{ result: null }] },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'doc', url: PAGE }] } };
globalThis.chrome = api; globalThis.browser = api;
const ORIGINAL = 'Inspect the current owned page entirely read-only.';
const CORRECTION = fs.readFileSync(new URL('./fixtures/literal-calculation-correction.txt', import.meta.url), 'utf8').trim();
const expression = '12345678901234567890 * 7 + 0.125';
const answer = '86419752308641975230.125\nMIDRUN-CALCULATE-QA-20261008';
const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
let nextTab = 8700;
function setup(Agent, next) {
  const provider = { name: 'revision test', model: 'fixture', contextWindow: 128000, promptTier: 'full', supportsTools: true, supportsVision: false,
    chat: withFixtureCalculationReadings(next), async *chatStream(messages, options) { const r = await next(messages, options); if (r.content) yield { type: 'text', content: r.content };
      if (r.toolCalls) yield { type: 'tool_call', content: r.toolCalls.map((c, index) => ({ ...c, index })) }; yield { type: 'done' }; } };
  const a = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  for (const name of ['_hydrate', '_manageContext', '_recordCostUsage', '_maybeEmitAskModeHandoff', '_maybeReinjectAdapter', '_ensureProgressSessionForCurrentTask']) a[name] = async () => {};
  a._persist = () => {}; a._persistNow = async () => ({ ok: true }); a._persistSubmittedTurn = async () => {};
  a._startTraceRun = async () => null; a._endTraceRun = async () => {}; a._beginReadCompleteness = async () => null;
  a._checkCostAllowance = async () => null; a._currentUrl = async () => PAGE; a._getTabUrlTitle = async () => ({ tabUrl: PAGE, tabTitle: 'Owned page' });
  a._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  a._plannerMode = () => 'off'; a._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false,
    requiresSubmission: false, ...a._plannerCompletionGateFields({ read_scope: 'none', deliverables: ['Requested exact arithmetic result and literal ending'] }) });
  a._skipPermissionGate = true; a._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock', '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) a[name] = async () => null;
  a._adoptLiveSocialPublishWorkflow = async () => false; a._isFormValidationCandidate = () => false;
  a._preflightRichTextToolbarTarget = async () => ({ block: null }); a._auditRichTextToolbarTarget = async () => {};
  a._shouldAutoScreenshot = () => false; a._pageFeedbackIdleMs = 0; a.maxSteps = 12;
  return a;
}
function bind(a, tab) {
  const from = { tab: { id: tab }, frameId: 0, documentId: 'doc', url: PAGE };
  const state = a.pageMonitorState(from, 'content-doc'); assert.equal(state.active, true);
  return () => assert.equal(a.observePageFeedback(from, { ...state, seq: 1, revision: 1, kind: 'dom', source: 'page', target: 'span#counter' }).accepted, true);
}
async function begin(a, tab, text = CORRECTION) {
  const options = { detachedRequestId: `owned-${tab}`, askStreamingEnabled: false };
  a.conversations.set(tab, [{ role: 'system', content: 'system' }, { role: 'user', content: text }]);
  await a._claimRunEntry(tab, 'interactive', options); a._beginSteeringRun(tab, () => {}, options); a._beginCompletionInvariant(tab);
  a._startPlanExecutionGuard(tab, 'act', { proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
    ...a._plannerCompletionGateFields({ read_scope: 'none', deliverables: ['Exact arithmetic result and literal ending'] }) });
  await a._prepareCalculationReading(tab); bind(a, tab); return options;
}
function finish(a, tab) { a._finishSteeringRun(tab); a._releaseRunEntry(tab); }

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(new URL(`src/${build}/src/agent/agent.js`, ROOT));
  test(`${build}: missing current calculation attempts exclude premature completion`, async () => {
    const tab = nextTab++, a = setup(Agent, async () => ({ content: '' }));
    // Strict checks: the guard's refusal itself is under test.
    a.strictGuards = true;
    await begin(a, tab);
    try { const policy = a._pureCalculationToolPolicy(tab); assert.deepEqual(policy.names, ['calculate', 'done']);
      assert.deepEqual(policy.toolChoice, { type: 'function', function: { name: 'calculate' } });
      for (const outcome of ['success', 'partial', 'failed']) { const blocked = a._pureCalculationToolBlock(tab, 'done', { outcome, summary: answer });
        assert.equal(blocked?.noDispatch, true); assert.doesNotMatch(blocked.error, /already verified|verified arithmetic result/); }
      assert.equal(a._pureCalculationToolBlock(tab, 'calculate', { expression: '1+1' })?.noDispatch, true);
      assert.equal(a._pureCalculationToolPolicy(tab).attempted, false);
    } finally { finish(a, tab); }
  });
  test(`${build}: invoked literal calculation failure permits honest failure, not success`, async () => {
    const tab = nextTab++, a = setup(Agent, async () => ({ content: '' }));
    await begin(a, tab);
    try { assert.equal(a._pureCalculationToolPolicy(tab).attempted, false);
      let invoked = 0; const result = { success: false, noDispatch: true, dispatched: false, error: 'Owned calculator transport unavailable' };
      a.executeTool = async (_tab, name, args) => { assert.equal(name, 'calculate'); assert.equal(args.expression, expression); invoked++; return result; };
      const messages = a.conversations.get(tab), calls = call('failed-current-calculation', 'calculate', { expression }).toolCalls;
      messages.push({ role: 'assistant', content: null, tool_calls: calls });
      await a._executeToolBatch(tab, calls, messages, () => {}, a._activeProvider(tab), null, new Set(['calculate']), 1);
      assert.equal(invoked, 1);
      assert.deepEqual(a._pureCalculationToolPolicy(tab).names, ['calculate', 'done']);
      assert.equal(a._pureCalculationToolBlock(tab, 'done', { outcome: 'failed', summary: result.error }), null);
      assert.equal(a._pureCalculationToolBlock(tab, 'done', { outcome: 'partial', summary: result.error }), null);
      assert.notEqual(a._planOnlyTerminalDecision(tab, 'It worked.', { viaDone: true, outcome: 'success' }), null);
    } finally { finish(a, tab); }
  });
  test(`${build}: accepted revision retires completed action and warning counts while preserving scope`, async () => {
    const tab = nextTab++, a = setup(Agent, async () => ({ content: '' })), options = await begin(a, tab, ORIGINAL);
    try { const before = a.completionInvariants.get(tab); a._recordCompletionToolResult(tab, 'click', {}, { success: true, dispatched: true });
      a._recordCompletionToolResult(tab, 'get_accessibility_tree', {}, { success: true, pageContent: 'Confirmed original action.' });
      const sequence = a.completionInvariants.get(tab).sequence; a._doneBlockCount.set(tab, { key: 'old-warning', count: 2 });
      assert.equal(a.steerMessage(tab, CORRECTION, { requestId: options.detachedRequestId, messageId: 'new-objective' }).accepted, true);
      await a._revalidatePendingSteering(tab, a.conversations.get(tab), () => {}, 'act', null, null, options);
      const after = a.completionInvariants.get(tab); assert.equal(after.runToken, before.runToken); assert.equal(after.sequence, sequence);
      assert.equal(after.hadAction, false); assert.equal(after.lastAction, null); assert.equal(after.verificationDebt, false);
      // The loop reads the revised request before its next model request.
      await a._prepareCalculationReading(tab);
      assert.equal(a._doneBlockCount.has(tab), false); assert.equal(a._pureCalculationToolPolicy(tab).attempted, false);
    } finally { finish(a, tab); }
  });
  test(`${build}: revision never erases unresolved physical submission or iframe debt`, async () => {
    const tab = nextTab++, a = setup(Agent, async () => ({ content: '' })), options = await begin(a, tab, 'Publish the existing draft.');
    try { a._recordCompletionToolResult(tab, 'upload_file', {}, { success: false, dispatched: true, outcomeUnknown: true });
      const debt = a.completionInvariants.get(tab); debt.iframeFormVerificationDebt = true; debt.iframeFormVerificationObligations = [{ scope: 'owned-frame' }];
      const submission = { dispatched: true, observedAfterSubmit: false, outcomeUnknown: true }; a._completionSubmitStates.set(tab, submission);
      assert.equal(a.steerMessage(tab, CORRECTION, { requestId: options.detachedRequestId, messageId: 'new-objective' }).accepted, true);
      await a._revalidatePendingSteering(tab, a.conversations.get(tab), () => {}, 'act', null, null, options);
      const after = a.completionInvariants.get(tab); assert.equal(after.verificationDebt, true); assert.equal(after.lastAction, debt.lastAction);
      assert.equal(after.iframeFormVerificationDebt, true); assert.deepEqual(after.iframeFormVerificationObligations, debt.iframeFormVerificationObligations);
      assert.equal(a._steeringPriorSubmissionBlock(tab, 'click', {}, { isSubmit: true })?.noDispatch, true);
      assert.equal(a._pureCalculationToolPolicy(tab), null);
    } finally { finish(a, tab); }
  });
  test(`${build}: an observed but uncertain physical action survives revision`, async () => {
    const tab = nextTab++, a = setup(Agent, async () => ({ content: '' })), options = await begin(a, tab, 'Attach the existing draft document.');
    try { a._recordCompletionToolResult(tab, 'upload_file', {}, { success: false, dispatched: true, outcomeUnknown: true });
      a._recordCompletionToolResult(tab, 'get_accessibility_tree', {}, { success: true, pageContent: 'The page was read; upload effect remains unknown.' });
      const before = a.completionInvariants.get(tab); assert.equal(before.verificationDebt, false); assert.equal(before.lastAction.uncertain, true);
      assert.equal(a.steerMessage(tab, CORRECTION, { requestId: options.detachedRequestId, messageId: 'new-objective' }).accepted, true);
      await a._revalidatePendingSteering(tab, a.conversations.get(tab), () => {}, 'act', null, null, options);
      assert.equal(a.completionInvariants.get(tab).lastAction, before.lastAction); assert.equal(a._pureCalculationToolPolicy(tab), null);
    } finally { finish(a, tab); }
  });
  for (const streaming of [false, true]) {
    test(`${build} ${streaming ? 'stream' : 'chat'}: late revised objective gets a fresh plain-response recovery budget`, async () => {
      const tab = nextTab++, requestId = `loop-${tab}`; let a, calls = 0, calculations = 0;
      a = setup(Agent, async (_messages, opts) => {
        const n = ++calls; assert.ok(n <= 9, 'One accepted revision must finish under the unchanged step cap.');
        if (n === 1) return call('old-action', 'click_ax', { ref_id: 'ref_1' });
        if (n === 2) return call('old-observation', 'get_accessibility_tree', {});
        if (n === 3 || n === 4) { assert.equal(a.completionInvariants.get(tab).hadAction, true); assert.equal(a.completionInvariants.get(tab).verificationDebt, false); return { content: 'Original action is complete.' }; }
        if (n === 5) { assert.equal(a.steerMessage(tab, CORRECTION, { requestId, messageId: 'new-objective' }).accepted, true); return { content: 'Superseded response.' }; }
        if (n === 6) return { content: answer }; // A provider may ignore tool_choice once; it must never inherit the old response budget.
        if (n === 7) { assert.deepEqual(opts.toolChoice, { type: 'function', function: { name: 'calculate' } }); return call('new-calculation', 'calculate', { expression }); }
        return call('new-done', 'done', { summary: answer, outcome: 'success' });
      });
      // Strict checks: the guard's refusal itself is under test.
      a.strictGuards = true;
      a._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(a, tab); return { role: 'user', content }; };
      a.executeTool = async (_tab, name, args) => {
        if (name === 'calculate') { calculations++; return a._executeToolImpl(_tab, name, args); }
        if (name === 'done') return { done: true, summary: args.summary, outcome: args.outcome };
        return { success: true, dispatched: true, pageContent: name === 'get_accessibility_tree' ? 'Original result observed.' : undefined };
      };
      const options = { detachedRequestId: requestId, askStreamingEnabled: false };
      const result = streaming ? await a.processMessageStream(tab, ORIGINAL, () => {}, 'act', options) : await a.processMessage(tab, ORIGINAL, () => {}, 'act', [], options);
      assert.equal(result, answer); assert.equal(calculations, 1); assert.equal(calls, 8);
    });
    test(`${build} ${streaming ? 'stream' : 'chat'}: compliant providers must use the fresh literal tool before done`, async () => {
      const tab = nextTab++, requestId = `fresh-${tab}`; let a, calls = 0, calculations = 0;
      a = setup(Agent, async (_messages, opts) => {
        if (++calls === 1) { assert.equal(a.steerMessage(tab, CORRECTION, { requestId, messageId: 'correction' }).accepted, true); return { content: 'Obsolete task response.' }; }
        if (calls === 2) { assert.deepEqual(opts.tools.map(t => t.function.name), ['calculate', 'done']); assert.deepEqual(opts.toolChoice, { type: 'function', function: { name: 'calculate' } }); return call('required-calculation', 'calculate', { expression }); }
        assert.equal(calls, 3); assert.deepEqual(opts.tools.map(t => t.function.name), ['done']); return call('actual-done', 'done', { summary: answer, outcome: 'success' });
      });
      a._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(a, tab); return { role: 'user', content }; };
      a.executeTool = async (_tab, name, args) => { if (name === 'calculate') { calculations++; return a._executeToolImpl(_tab, name, args); } assert.equal(name, 'done'); return { done: true, summary: args.summary, outcome: args.outcome }; };
      const options = { detachedRequestId: requestId, askStreamingEnabled: false };
      assert.equal(streaming ? await a.processMessageStream(tab, ORIGINAL, () => {}, 'act', options) : await a.processMessage(tab, ORIGINAL, () => {}, 'act', [], options), answer);
      assert.equal(calculations, 1);
    });
    test(`${build} ${streaming ? 'stream' : 'chat'}: providers without native tools receive no forced-tool option`, async () => {
      const tab = nextTab++, requestId = `text-provider-${tab}`; let a, requests = 0, calculations = 0;
      a = setup(Agent, async (_messages, opts) => {
        assert.equal(opts.tools, undefined); assert.equal(opts.toolChoice, undefined);
        if (++requests === 1) return call('text-calculation', 'calculate', { expression });
        assert.equal(requests, 2); return call('text-done', 'done', { summary: answer, outcome: 'success' });
      });
      a._activeProvider(tab).supportsTools = false;
      a._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(a, tab); return { role: 'user', content }; };
      a.executeTool = async (_tab, name, args) => { if (name === 'calculate') { calculations++; return a._executeToolImpl(_tab, name, args); }
        assert.equal(name, 'done'); return { done: true, summary: args.summary, outcome: args.outcome }; };
      const options = { detachedRequestId: requestId, askStreamingEnabled: false };
      assert.equal(streaming ? await a.processMessageStream(tab, CORRECTION, () => {}, 'act', options) : await a.processMessage(tab, CORRECTION, () => {}, 'act', [], options), answer);
      assert.equal(calculations, 1);
    });
  }
}
