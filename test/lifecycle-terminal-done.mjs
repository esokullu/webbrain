// Real Agent loops (chat + stream) with mocked browser/content APIs, both
// builds. An executed done (success, partial or failed) is terminal: page
// feedback arriving during or after its batch must not reopen it, while an
// accepted correction still can. Pending feedback after a non-terminal batch
// must not discard the completion-recovery turn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutFixedChoiceAnswers } from './semantic-decision-stub.mjs';

const PAGE_URL = 'https://example.com/settings';
const TREE = 'main [ref_main]\n heading "Settings" [ref_h]\n button "Save" [ref_save]';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Settings' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE_URL },
    { frameId: 1, parentFrameId: 0, documentId: 'ad-document', url: 'https://ads.example/slot' }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 8100;

function makeAgent(Agent, next) {
  const provider = {
    name: 'lifecycle test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    // A model reading a failed or partial summary is not a turn of the run.
    chat: withoutFixedChoiceAnswers((messages, options) => next(messages, options)),
    async *chatStream(messages, options) {
      const response = await next(messages, options);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => PAGE_URL, _getTabUrlTitle: async () => ({ tabUrl: PAGE_URL, tabTitle: 'Settings' }),
    _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
    _plannerMode: () => 'off',
    _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
    _skipPermissionGate: true, _ensureGateSetting: async () => true, _adoptLiveSocialPublishWorkflow: async () => false,
    _isFormValidationCandidate: () => false, _preflightRichTextToolbarTarget: async () => ({ block: null }),
    _auditRichTextToolbarTarget: async () => {}, _shouldAutoScreenshot: () => false, _pageFeedbackIdleMs: 0,
    _completionDoneBlock: () => null,
  });
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  return agent;
}

// The content monitors' document-start handshakes (main frame and an ad frame).
function bindMain(agent, tab) {
  const bind = (frameId, documentId, token, url) => {
    const from = { tab: { id: tab }, frameId, documentId, url };
    const state = agent.pageMonitorState(from, token);
    assert.equal(state.active, true, 'monitor registration');
    let seq = 0;
    return value => agent.observePageFeedback(from, { ...state, seq: ++seq, revision: seq,
      kind: 'dom', source: 'page', target: 'span#clock', ...value });
  };
  const main = bind(0, 'document-1', 'content-1', PAGE_URL);
  main.child = bind(1, 'ad-document', 'ad-1', 'https://ads.example/slot');
  return main;
}

const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const run = (agent, tab, streaming, text, updates, options) => streaming
  ? agent.processMessageStream(tab, text, (type, data) => updates.push({ type, data }), 'act', options)
  : agent.processMessage(tab, text, (type, data) => updates.push({ type, data }), 'act', [], options);
const BROWSER_UPDATE = /BROWSER STATE UPDATE/;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  for (const streaming of [false, true]) {
    const mode = streaming ? 'stream' : 'chat';
    const cases = [
      ['user click during verification', 'success', send => send({ kind: 'click', source: 'user', target: 'button#other' }), false],
      ['user typing during verification', 'partial', send => send({ kind: 'input', source: 'user', target: 'input#q' }), false],
      ['an unknown-source scroll during verification', 'failed', send => send({ kind: 'scroll', source: 'unknown', target: 'html', viewport: { x: 0, y: 400 } }), false],
      ['passive tick with a failed refresh read', 'success', send => send({}), true],
      // Automatic churn counts toward page_unstable; it used to be recorded at
      // the post-batch stage without being delivered, so the run kept looping.
      ['automatic ad-frame churn', 'success', send => send.child({ target: 'div#ad' }), false],
    ];
    for (const [label, outcome, feedback, refreshFails] of cases) {
      test(`${build}: ${mode} an executed ${outcome} done stays final after ${label}`, async () => {
        const tab = nextTab++, updates = [];
        let agent, send, requests = 0, doneCalls = 0;
        agent = makeAgent(Agent, async () => {
          requests++;
          if (requests === 1) return call('read', 'get_accessibility_tree', {});
          return call('done-' + requests, 'done', { summary: `Settings answer ${requests}.`, outcome });
        });
        agent.maxSteps = 8;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bindMain(agent, tab); return { role: 'user', content }; };
        agent._executeToolWithLifecycle = async (_tab, name, args, _update, context) => {
          if (name === 'get_accessibility_tree') {
            return refreshFails && context?.pageFeedbackRead ? { success: false, error: 'AX tree unavailable' } : { success: true, pageContent: TREE };
          }
          assert.equal(name, 'done');
          doneCalls++;
          feedback(send); // the page changes while the completion is verified
          return { done: true, success: outcome === 'success', summary: args.summary, outcome };
        };
        const result = await run(agent, tab, streaming, 'Check the settings page', updates, { detachedRequestId: 'terminal-' + tab });
        assert.match(result, /^Settings answer 2\./, 'The executed done is the final answer');
        assert.equal(requests, 2, 'Page feedback after a terminal done must not trigger another model call');
        assert.equal(doneCalls, 1);
        const doneIndex = updates.findIndex(update => update.type === 'tool_result' && update.data?.name === 'done');
        assert.ok(doneIndex > 0);
        assert.equal(updates.slice(doneIndex).some(update => update.type === 'page_feedback'), false, 'No post-done feedback supersession');
        assert.equal(updates.slice(doneIndex).some(update => update.type === 'text' && update.data?.replace && !update.data.content), false,
          'The shown answer is not cleared');
        const messages = agent.conversations.get(tab);
        const doneMessage = messages.findLastIndex(message => message.role === 'tool');
        assert.equal(messages.slice(doneMessage + 1).some(message => BROWSER_UPDATE.test(JSON.stringify(message.content))), false);
        assert.equal(agent._pageFeedbackRuns.size, 0);
      });
    }

    test(`${build}: ${mode} an accepted correction still reopens an executed done`, async () => {
      const tab = nextTab++, updates = [];
      let agent, requests = 0;
      agent = makeAgent(Agent, async messages => {
        requests++;
        if (requests === 1) return call('read', 'get_accessibility_tree', {});
        if (requests === 2) return call('done-1', 'done', { summary: 'Original settings answer.', outcome: 'success' });
        if (requests === 3) {
          const latest = messages.filter(message => message.role === 'user' && !message.webbrainAppOwned).at(-1);
          assert.equal(latest.webbrainUserAuthoredText ?? latest.content,
            'Also mention the theme setting', 'The correction is the latest user message');
          assert.ok(latest.content.includes('APP-OWNED CURRENT USER TASK'), 'The execution model also sees the shared task context');
          return call('reread', 'get_accessibility_tree', {});
        }
        return call('done-2', 'done', { summary: 'Corrected settings answer.', outcome: 'success' });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bindMain(agent, tab); return { role: 'user', content }; };
      agent._executeToolWithLifecycle = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        if (requests === 2) {
          assert.equal(agent.steerMessage(tab, 'Also mention the theme setting', { requestId: 'reopen-' + tab, messageId: 'c1' }).accepted, true);
        }
        return { done: true, success: true, summary: args.summary, outcome: args.outcome };
      };
      const result = await run(agent, tab, streaming, 'Check the settings page', updates, { detachedRequestId: 'reopen-' + tab });
      assert.equal(result, 'Corrected settings answer.');
      assert.equal(requests, 4);
      const applied = updates.findIndex(update => update.type === 'steering_applied');
      const firstDone = updates.findIndex(update => update.type === 'tool_result' && update.data?.name === 'done');
      assert.ok(applied > firstDone && firstDone > 0, 'The correction reopened the finished answer');
      assert.ok(updates.slice(firstDone, applied + 2).some(update => update.type === 'text' && update.data?.replace && !update.data.content),
        'The superseded answer is cleared');
    });

    test(`${build}: ${mode} user activity before dispatch still supersedes a stale done`, async () => {
      const tab = nextTab++, updates = [], summaries = [];
      let agent, send, requests = 0;
      agent = makeAgent(Agent, async () => {
        requests++;
        if (requests === 1) return call('read', 'get_accessibility_tree', {});
        if (requests === 2) {
          send({ kind: 'click', source: 'user', target: 'button#reset' }); // the user acts during inference
          return call('stale-done', 'done', { summary: 'Stale answer.', outcome: 'success' });
        }
        return call('fresh-done', 'done', { summary: 'Fresh answer.', outcome: 'success' });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bindMain(agent, tab); return { role: 'user', content }; };
      agent._executeToolWithLifecycle = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        summaries.push(args.summary);
        return { done: true, success: true, summary: args.summary, outcome: args.outcome };
      };
      assert.equal(await run(agent, tab, streaming, 'Check the settings page', updates, { detachedRequestId: 'stale-' + tab }), 'Fresh answer.');
      assert.deepEqual(summaries, ['Fresh answer.'], 'A done decided before the intervention is never dispatched');
      assert.equal(requests, 3);
    });

    test(`${build}: ${mode} feedback during a refused completion keeps its verification turn`, async () => {
      const tools = [];
      for (const feedbackDuringBatch of [false, true]) {
        const tab = nextTab++, updates = [];
        let agent, send, requests = 0, blocked = 0;
        const requestTools = [];
        agent = makeAgent(Agent, async (_messages, options) => {
          requests++;
          requestTools.push({ count: (options?.tools || []).length, choice: options?.toolChoice ?? null });
          if (requests === 2) return call('verify', 'get_accessibility_tree', { filter: 'visible' });
          return call('done-' + requests, 'done', { summary: 'Posted and verified.', outcome: 'success' });
        });
        agent.maxSteps = 8;
        // Strict checks: the guard's refusal itself is under test.
        agent.strictGuards = true;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bindMain(agent, tab); return { role: 'user', content }; };
        agent._completionDoneBlock = tabId => {
          if (blocked++) return null;
          const state = agent.completionInvariants.get(tabId);
          if (state) agent.completionInvariants.set(tabId, { ...state, hadAction: true, verificationDebt: true });
          if (feedbackDuringBatch) send({}); // an ordinary passive page update while the refusal is processed
          return { reason: 'verification_required', error: 'The latest consequential action has not been verified.' };
        };
        agent._executeToolWithLifecycle = async (_tab, name, args) => name === 'get_accessibility_tree'
          ? { success: true, pageContent: TREE } : { done: true, success: true, summary: args.summary, outcome: args.outcome };
        await run(agent, tab, streaming, 'Post it', updates, { detachedRequestId: 'refused-' + tab });
        tools.push(requestTools[1]);
      }
      assert.ok(tools[0].choice, 'The refused completion forces a verification turn');
      assert.deepEqual(tools[1], tools[0], 'Pending page feedback must not replace the verification turn with the full tool set');
    });
  }
}
