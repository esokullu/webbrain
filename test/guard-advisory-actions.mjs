import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

// Quality guards on actions advise instead of refusing (PR B, guard-policy.js):
// with Settings -> General -> "Strict checks" off (the default) the action is
// dispatched and the guard's note reaches the model on the real tool result;
// with strictGuards = true the old refusal happens exactly as before. Every
// test below runs both modes for both builds.

const PAGE_URL = 'https://example.com/form';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: PAGE_URL, title: 'Form' }),
    query: async () => [],
    sendMessage: async () => ({ ready: true }),
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

let nextTab = 9100;
const MODES = [['default', false], ['strict', true]];

// Tool results may carry appended notes or an untrusted-data envelope.
function parse(message) {
  const text = typeof message?.content === 'string' ? message.content : '';
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let cursor = start; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, cursor + 1)); } catch { break; }
      }
    }
  }
  return null;
}
const resultFor = (messages, id) => parse(messages.find(message => message.role === 'tool' && message.tool_call_id === id));
const guardsOf = value => (Array.isArray(value) ? value : value?.guardAdvisories || []).map(item => item.guard);
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { decideChatSend, WAIVABLE_CHAT_SEND_REASONS } = await import(`../src/${build}/src/agent/chat-workflow.js`);
  const { resolveAdapterWorkflowJob } = await import(`../src/${build}/src/agent/adapters.js`);

  // A batch harness that reaches the real dispatch: every pre-dispatch check
  // that is not under test is neutral, and the lifecycle wrapper that attaches
  // advisories to the result stays real (only its inner dispatch is recorded).
  function makeAgent(strict) {
    const provider = { name: 'guard advisory test', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false, chat: async () => ({ content: '' }) };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent.strictGuards = strict;
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_messageRecipientGuardBlock',
      '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._isFormValidationCandidate = () => false;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._currentUrl = async () => PAGE_URL;
    agent._refreshPageFeedbackForCall = async () => false;
    const dispatched = [];
    const realInner = Agent.prototype._executeToolWithLifecycleInner;
    agent._executeToolWithLifecycleInner = async function(tab, name, args, onUpdate, context) {
      dispatched.push({ name, args, context });
      // The calculator is local and side-effect free, so it really runs.
      if (name === 'calculate') return realInner.call(this, tab, name, args, onUpdate, context);
      return { success: true, dispatched: true, verified: true };
    };
    const run = async (tab, calls, allowed, runOptions = {}) => {
      const messages = [];
      const outcome = await agent._executeToolBatch(tab, calls, messages, () => {}, provider, null,
        new Set(allowed), 1, runOptions);
      return { messages, outcome };
    };
    return { agent, provider, dispatched, run };
  }

  // ── pure-calculation-tool-scope ─────────────────────────────────────────
  function arithmeticTask(agent, tab) {
    const task = 'Only calculate 12 * 7 and reply with the result.';
    const expression = '12 * 7';
    agent._planExecutionGuards.set(tab, { enabled: true, taskKey: 'arithmetic-task', readScope: 'none',
      calculationReading: { task, expression, choice: 'only_result' } });
    agent._pageFeedbackLiteralCalculationTask = () => task;
    agent._pageFeedbackCalculationResponseScope = () => ({ owner: 'owner', runToken: 'run', expression, outputRequirements: null });
    agent._pageFeedbackCalculationComplete = () => false;
  }

  for (const [mode, strict] of MODES) {
    test(`${build}: pure-calculation-tool-scope ${mode} mode ${strict ? 'refuses another expression' : 'runs another expression with a note'}`, async () => {
      const tab = nextTab++;
      const { agent, run } = makeAgent(strict);
      arithmeticTask(agent, tab);
      const { messages } = await run(tab, [call('other-expression', 'calculate', { expression: '1 + 1' })], ['calculate', 'done']);
      const result = resultFor(messages, 'other-expression');
      if (strict) {
        assert.equal(result.errorCode, 'pure_calculation_tool_denied');
        assert.equal(result.noDispatch, true);
        assert.equal(result.result, undefined);
        assert.deepEqual(guardsOf(result), []);
      } else {
        assert.equal(result.success, true);
        assert.equal(result.result, '2');
        assert.deepEqual(guardsOf(result), ['pure-calculation-tool-scope']);
        assert.match(result.guardAdvisories[0].note, /12 \* 7/);
        // A calculation does not take the task out of its arithmetic scope.
        assert.deepEqual(agent._pureCalculationToolPolicy(tab).names, ['calculate', 'done']);
      }
    });

    test(`${build}: pure-calculation-tool-scope ${mode} mode ${strict ? 'refuses a page action' : 'runs a page action and releases the arithmetic scope'}`, async () => {
      const tab = nextTab++;
      const { agent, run, dispatched } = makeAgent(strict);
      arithmeticTask(agent, tab);
      const { messages } = await run(tab, [call('page-action', 'click_ax', { ref_id: 'ref_1' })], ['click_ax', 'calculate', 'done']);
      const result = resultFor(messages, 'page-action');
      if (strict) {
        assert.equal(dispatched.length, 0);
        assert.equal(result.errorCode, 'pure_calculation_tool_denied');
        assert.ok(agent._pureCalculationToolPolicy(tab), 'Strict mode keeps the arithmetic scope');
      } else {
        assert.deepEqual(dispatched.map(item => item.name), ['click_ax']);
        assert.deepEqual(guardsOf(result), ['pure-calculation-tool-scope']);
        // Once the browser was used the captured scope could only go stale and
        // refuse every later call; the task is released instead.
        assert.equal(agent._planExecutionGuards.get(tab).pureCalculationScopeReleased, true);
        assert.equal(agent._pureCalculationToolPolicy(tab), null);
      }
    });
  }

  // ── preparation-timeout-generic (form-validation before-snapshot) ────────
  for (const [mode, strict] of MODES) {
    test(`${build}: preparation-timeout-generic ${mode} mode ${strict ? 'refuses after a snapshot timeout' : 'submits without the timed-out snapshot'}`, async () => {
      const tab = nextTab++;
      const { agent, run, dispatched } = makeAgent(strict);
      agent._isFormValidationCandidate = () => true;
      agent._detectLikelySubmitAction = async () => ({ isSubmit: true, host: 'example.com', tool: 'click', reason: 'submit control' });
      agent._waitForFormValidationFailure = async () => null;
      agent._readControlEffect = async () => null;
      let snapshots = 0;
      agent._captureFormValidationState = async () => {
        snapshots++;
        if (snapshots === 2) throw Object.assign(new Error('click did not return a page response within 1 seconds.'), { code: 'content_action_timeout' });
        return [];
      };
      const { messages } = await run(tab, [call('submit', 'click', { selector: '#submit' })], ['click']);
      const result = resultFor(messages, 'submit');
      assert.equal(snapshots >= 2, true);
      if (strict) {
        assert.equal(dispatched.length, 0);
        assert.match(result.error, /form-validation snapshot did not finish/);
      } else {
        assert.deepEqual(dispatched.map(item => item.name), ['click']);
        assert.deepEqual(guardsOf(result), ['preparation-timeout-generic']);
      }
    });
  }

  // ── media-download-target-binding ───────────────────────────────────────
  for (const [mode, strict] of MODES) {
    test(`${build}: media-download-target-binding ${mode} mode ${strict ? 'refuses a feed URL' : 'downloads a feed URL with a note'}`, async () => {
      const tab = nextTab++;
      const { agent, run, dispatched } = makeAgent(strict);
      const { messages } = await run(tab, [call('feed-download', 'download_public_media', { url: 'https://www.instagram.com/someuser/' })],
        ['download_public_media']);
      const result = resultFor(messages, 'feed-download');
      if (strict) {
        assert.equal(dispatched.length, 0);
        assert.equal(result.needsExplicitMediaUrl, true);
      } else {
        assert.deepEqual(dispatched.map(item => item.name), ['download_public_media']);
        assert.deepEqual(guardsOf(result), ['media-download-target-binding']);
      }
    });
  }

  // The real browser-specific download handler and its injected page wrapper,
  // as in media-download-agent-handler.mjs, on a real Agent prototype so the
  // guard policy is the production one.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const handlerSource = (() => {
    const source = fs.readFileSync(new URL(`../src/${build}/src/agent/agent.js`, import.meta.url), 'utf8');
    const start = source.lastIndexOf("    if (name === 'download_social_media') {");
    const end = source.indexOf(build === 'chrome' ? '    // download_file is now handled' : '    // ─── PDF reader', start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  })();
  for (const [mode, strict] of MODES) {
    test(`${build}: media-download-target-binding ${mode} mode ${strict ? 'keeps a changed media binding refused' : 'retries a changed media binding unbound, DOM only'}`, async () => {
      const handler = new AsyncFunction('tabId', 'name', 'args', 'onUpdate', 'executionContext', 'chrome', 'browser', handlerSource);
      const runs = [];
      const results = [
        { success: false, noDispatch: true, dispatched: false, pageFeedbackPending: true, errorCode: 'media_binding_changed',
          error: 'changed target', urls: [], stats: { triggered: 0, completed: 0 } },
        { urls: ['https://pbs.twimg.com/now.jpg'], stats: { triggered: 1, completed: 0, completedVideo: 0, openedInTab: 0, failed: 1, failures: [] } },
      ];
      let mseSaves = 0;
      const downloader = {
        async run(opts) { runs.push(opts); return results[runs.length - 1]; },
        _activeProfile: () => ({ name: 'twitter' }),
        getMseRecording: () => ({ orphanBuffers: [{ bytes: 100 }] }),
        async saveMse() { mseSaves++; return [{ mime: 'video/mp4' }]; },
        _buildRecommendation: () => null,
      };
      const page = { window: { SocialMediaDownloader: downloader, location: { hostname: 'x.com' } },
        location: { href: 'https://x.com/account/status/123/photo/1' } };
      const transport = {
        scripting: { async executeScript({ files, func, args }) {
          if (files) return [];
          return [{ result: await vm.runInNewContext(`(${func.toString()})(...injectedArgs)`, { ...page, injectedArgs: args }) }];
        } },
        tabs: { async executeScript(_id, { file, code }) {
          if (file) return [];
          return [await vm.runInNewContext(code, page)];
        } },
      };
      const agent = Object.create(Agent.prototype);
      Object.assign(agent, {
        strictGuards: strict,
        _activeProvider: () => ({}), providerManager: { getActive: () => ({}) },
        async _resolveVisionRoute() { assert.fail('A bound media call must not reach vision'); },
        async _saveVisibleMediaCrop() { assert.fail('A bound media call must not crop media'); },
      });
      const advisories = [];
      const binding = { schema: 1, documentToken: 'document', candidates: [{ url: 'https://pbs.twimg.com/intended.jpg' }] };
      const result = await handler.call(agent, 1, 'download_social_media', { mode: 'main', target: 'video', limit: 1 }, () => {},
        { _expectedMediaBinding: binding, guardAdvisories: advisories }, transport, transport);
      if (strict) {
        assert.equal(runs.length, 1);
        assert.equal(result.errorCode, 'media_binding_changed');
        assert.deepEqual(advisories, []);
      } else {
        assert.equal(runs.length, 2);
        assert.equal(JSON.stringify(runs[0].expectedMediaBinding), JSON.stringify(binding));
        assert.equal(runs[1].expectedMediaBinding, undefined);
        assert.equal(runs[1].domOnly, true);
        assert.equal(mseSaves, 0, 'The unbound retry stays on the DOM item path');
        assert.notEqual(result.errorCode, 'media_binding_changed');
        assert.deepEqual(guardsOf(advisories), ['media-download-target-binding']);
      }
    });
  }

  // ── form-validation-unchanged-repeat ────────────────────────────────────
  const invalidState = [{ frameId: 0, url: PAGE_URL, activeInvalid: true,
    invalidFields: [{ label: 'Email', type: 'email', message: 'Enter an email address.' }],
    ariaInvalidFields: [], alerts: [], controlFingerprint: 'empty' }];
  for (const [mode, strict] of MODES) {
    test(`${build}: form-validation-unchanged-repeat ${mode} mode ${strict ? 'refuses the unchanged repeat' : 'sends the unchanged repeat with a note'}`, async () => {
      const tab = nextTab++;
      const { agent, run, dispatched } = makeAgent(strict);
      agent._isFormValidationCandidate = () => true;
      agent._detectLikelySubmitAction = async () => ({ isSubmit: true, host: 'example.com', tool: 'click', reason: 'submit control' });
      agent._captureFormValidationState = async () => structuredClone(invalidState);
      agent._waitForFormValidationFailure = async () => null;
      agent._readControlEffect = async () => null;
      agent._formValidationBlocks.set(tab, {
        stateKey: agent._formValidationStateKey(invalidState),
        actionKey: agent._formValidationActionKey('click', { text: 'Continue' }),
        invalidFields: invalidState[0].invalidFields,
        validationMessages: ['Enter an email address.'],
        verifyFormCount: 0,
      });
      const { messages } = await run(tab, [call('repeat', 'click', { text: 'Continue' })], ['click']);
      const result = resultFor(messages, 'repeat');
      if (strict) {
        assert.equal(dispatched.length, 0);
        assert.equal(result.blockedValidationRetry, true);
      } else {
        assert.deepEqual(dispatched.map(item => item.name), ['click']);
        assert.deepEqual(guardsOf(result), ['form-validation-unchanged-repeat']);
        assert.doesNotMatch(result.guardAdvisories[0].note, /Enter an email address/, 'Page text stays out of the note');
      }
    });

    test(`${build}: form-validation-unchanged-repeat ${mode} mode ${strict ? 'fails a repeated verify_form' : 'keeps a repeated verify_form read'}`, () => {
      const agent = new Agent({ getVisionProvider: async () => null });
      agent.strictGuards = strict;
      const tab = nextTab++;
      const states = [{ ...invalidState[0], invalidFields: [{ label: 'Accept terms', id: 'terms', name: 'terms', type: 'checkbox', message: 'Required.' }] }];
      agent._formValidationBlocks.set(tab, { stateKey: agent._formValidationStateKey(states), actionKey: 'click|continue',
        invalidFields: states[0].invalidFields, validationMessages: ['Required.'], verifyFormCount: 0 });
      const read = () => ({ success: true, found: true, fields: [{ ref_id: 'ref_7', id: 'terms', name: 'terms', type: 'checkbox', checked: false, label: 'Accept terms' }] });
      const advisories = [];
      assert.equal(agent._applyVerifyFormRecovery(tab, read(), states, advisories).success, true);
      const repeated = agent._applyVerifyFormRecovery(tab, read(), states, advisories);
      if (strict) {
        assert.equal(repeated.success, false);
        assert.equal(repeated.blockedValidationVerifyRepeat, true);
        assert.deepEqual(advisories, []);
      } else {
        assert.equal(repeated.success, true);
        assert.equal(repeated.blockedValidationVerifyRepeat, undefined);
        assert.equal(repeated.formValidationRecovery.nextTool, 'set_checked');
        assert.deepEqual(guardsOf(advisories), ['form-validation-unchanged-repeat']);
      }
    });
  }

  // ── chat-send-preconditions ─────────────────────────────────────────────
  const threadKey = 'dom:telegram:k:123456:0', chatBody = 'A generated fixture reply.';
  function chatAgent(strict) {
    const harness = makeAgent(strict);
    const { agent } = harness;
    agent._currentUrl = async () => 'https://web.telegram.org/k/#123456';
    const observed = { success: true, url: 'https://web.telegram.org/k/#123456', threadKey,
      composer: { available: true, empty: false, ref: 'composer' },
      messages: [{ id: 'telegram:k:123456:0:1:rfixture', direction: 'incoming', text: 'Fixture question' }] };
    agent._readChatObservation = async () => structuredClone(observed);
    agent._messageRecipientGuardBlock = async (_tab, _name, _args, _url, value) => {
      Object.assign(value, { messageRecipientGuardRequired: true, messageRecipientBody: chatBody,
        messageRecipientDispatchBinding: { token: 'fixture-one-use-token' },
        messageRecipientNativeChatBaseline: { complete: true, threadKey, messageIds: ['telegram:k:123456:0:1'] } });
      return null;
    };
    return { ...harness, observed };
  }
  for (const [mode, strict] of MODES) {
    test(`${build}: chat-send-preconditions ${mode} mode ${strict ? 'refuses a reply after unseen incoming' : 'sends after unseen incoming with a note'}`, async () => {
      const tab = 745;
      const { agent, run, dispatched, observed } = chatAgent(strict);
      await agent._observeChatWorkflow(tab);
      observed.messages.push({ id: 'telegram:k:123456:0:2:rnext', direction: 'incoming', text: 'New fixture question' });
      const { messages } = await run(tab, [call('reply', 'click', { selector: '#send' })], ['click']);
      const result = resultFor(messages, 'reply');
      if (strict) {
        assert.equal(dispatched.length, 0);
        assert.equal(result.reason, 'chat_observe_required');
      } else {
        assert.deepEqual(dispatched.map(item => item.name), ['click']);
        assert.deepEqual(guardsOf(result), ['chat-send-preconditions']);
        assert.ok(agent.chatSessions.get(tab).pendingOutbound, 'The advised send is still tracked as pending');
      }
    });

    test(`${build}: chat-send-preconditions ${mode} mode: chat_send ${strict ? 'refuses a reply after unseen incoming' : 'sends after unseen incoming with a note'}`, async () => {
      // The dedicated chat_send tool follows the same policy as the generic
      // dispatch above.
      const tab = 746;
      const { agent, observed } = chatAgent(strict);
      const baseline = { coverage: 'mounted_native_id_floor', complete: true, threadKey,
        messageIds: ['telegram:k:123456:0:1', 'telegram:k:123456:0:2'] };
      observed.nativeChatMessageBaseline = structuredClone(baseline);
      observed.composer = { available: true, empty: true, ref: 'composer' };
      agent._messageRecipientGuardBlock = async (_tab, _name, _args, _url, value) => {
        Object.assign(value, { messageRecipientGuardRequired: true, messageRecipientBody: chatBody,
          messageRecipientDispatchBinding: { token: 'fixture-one-use-token' },
          messageRecipientNativeChatBaseline: structuredClone(baseline) });
        return null;
      };
      const sent = [];
      agent.executeTool = async (_tab, name, args) => {
        sent.push({ name, args });
        return { success: true, dispatched: true, verified: true, submitted: true };
      };
      await agent._observeChatWorkflow(tab);
      observed.messages.push({ id: 'telegram:k:123456:0:2:rnext', direction: 'incoming', text: 'New fixture question' });
      const guardAdvisories = [];
      const result = await agent._sendChatWorkflow(tab, { thread_key: threadKey, composer_ref: 'composer', text: chatBody },
        null, { guardAdvisories });
      if (strict) {
        assert.equal(result.reason, 'chat_observe_required');
        assert.deepEqual(sent, []);
        assert.deepEqual(guardsOf(guardAdvisories), []);
      } else {
        assert.notEqual(result.reason, 'chat_observe_required', JSON.stringify(result));
        assert.deepEqual(sent.map(item => item.name), ['set_field'], 'the reply was sent');
        assert.deepEqual(guardsOf(guardAdvisories), ['chat-send-preconditions']);
      }
      // A required user input (a one-time code here) still refuses.
      const otp = chatAgent(strict);
      otp.agent.executeTool = async () => assert.fail('nothing is sent while the page asks for user input');
      otp.observed.composer = { available: true, empty: true, ref: 'composer' };
      await otp.agent._observeChatWorkflow(tab);
      otp.observed.messages.push({ id: 'telegram:k:123456:0:2:rnext', direction: 'incoming', text: 'New fixture question' });
      otp.observed.userInput = { required: true, reason: 'otp' };
      const otpAdvisories = [];
      const refused = await otp.agent._sendChatWorkflow(tab, { thread_key: threadKey, composer_ref: 'composer', text: chatBody },
        null, { guardAdvisories: otpAdvisories });
      assert.equal(refused.noDispatch, true, JSON.stringify(refused));
      assert.deepEqual(guardsOf(otpAdvisories), []);
    });

    test(`${build}: chat-send-preconditions ${mode} mode keeps a one-time-code request blocking`, async () => {
      const tab = 745;
      const { agent, run, dispatched, observed } = chatAgent(strict);
      await agent._observeChatWorkflow(tab);
      observed.userInput = { required: true, reason: 'otp' };
      const { messages } = await run(tab, [call('reply', 'click', { selector: '#send' })], ['click']);
      assert.equal(dispatched.length, 0);
      assert.equal(resultFor(messages, 'reply').reason, 'user_input_required');
    });
  }

  test(`${build}: chat-send-preconditions waives only the quality preconditions`, () => {
    assert.deepEqual([...WAIVABLE_CHAT_SEND_REASONS], ['composer_unavailable']);
    const session = { threadKey, state: 'we_responded' };
    const snapshot = { threadKey, composer: { available: true, empty: true }, messages: [] };
    const noComposer = { ...snapshot, composer: { available: false, empty: true } };
    assert.equal(decideChatSend(session, noComposer, 'Hello').reason, 'composer_unavailable');
    assert.equal(decideChatSend(session, noComposer, 'Hello', Date.now(), { waive: new Set(['composer_unavailable']) }).ok, true);
    // A terminal session asked for no further message, and the native
    // baseline is what delivery matching and duplicate detection rely on.
    const ended = { ...session, state: 'issue_resolved' };
    assert.equal(decideChatSend(ended, snapshot, 'Hello', Date.now(), { waive: new Set(['terminal_session']) }).reason,
      'terminal_session');
    const unverifiedBaseline = { ...snapshot, nativeChatMessageBaseline: { threadKey, coverage: 'mounted_native_id_floor',
      complete: false, messageIds: ['telegram:k:123456:0:5000'] } };
    assert.equal(decideChatSend(session, unverifiedBaseline, 'Hello', Date.now(),
      { waive: new Set(['native_baseline_unverified']) }).reason, 'native_baseline_unverified');
    for (const [label, value] of [
      ['terminal', [ended, snapshot, 'Hello']],
      ['native baseline', [session, unverifiedBaseline, 'Hello']],
      ['thread', [session, { ...snapshot, threadKey: 'dom:telegram:k:999:0' }, 'Hello']],
      ['user input', [{ ...session, userInput: { required: true, reason: 'otp' } }, snapshot, 'Hello']],
      ['draft', [session, { ...snapshot, composer: { available: true, empty: false } }, 'Hello']],
      ['empty', [session, snapshot, '']],
      ['too long', [session, snapshot, 'x'.repeat(4001)]],
    ]) {
      const decision = decideChatSend(...value, Date.now(), { waive: new Set(['terminal_session', 'native_baseline_unverified',
        'composer_unavailable', 'composer_not_empty', 'thread_unverified', 'user_input_required', 'empty_message', 'message_too_long']) });
      assert.equal(decision.ok, false, label);
    }
  });

  // ── jev-target-changed ─────────────────────────────────────────────────
  for (const [mode, strict] of MODES) {
    test(`${build}: jev-target-changed ${mode} mode ${strict ? 'refuses a stale fast-path target' : 'sends a stale fast-path call unbound'}`, async () => {
      const tab = nextTab++;
      const agent = new Agent({ getVisionProvider: async () => null });
      agent.strictGuards = strict;
      agent._uncertainTextMutationBlock = async () => null;
      agent._finalizeToolResultOnce = async (_tab, _name, _args, result) => result;
      const impl = [];
      agent._executeToolImpl = async (_tab, name, _args, _onUpdate, context) => {
        impl.push({ name, jevBinding: context.jevBinding });
        return { success: true, dispatched: true };
      };
      const oldSend = api.tabs.sendMessage;
      api.tabs.sendMessage = async (_id, message) => message.action === 'jev_validate_target'
        ? { success: false, noDispatch: true, staleJevTarget: true } : { ready: true };
      try {
        const result = await agent._executeToolWithLifecycle(tab, 'click_ax', { ref_id: 'ref_3' }, null,
          { jevBinding: { ref: 'ref_3', documentToken: 'doc', structure: 's', signature: 'sig' } });
        if (strict) {
          assert.equal(impl.length, 0);
          assert.equal(result.staleJevTarget, true);
        } else {
          assert.deepEqual(impl, [{ name: 'click_ax', jevBinding: null }]);
          assert.equal(result.success, true);
          assert.deepEqual(guardsOf(result), ['jev-target-changed']);
        }
      } finally { api.tabs.sendMessage = oldSend; }
    });
  }

  test(`${build}: a note is dropped when a later check refuses the call`, async () => {
    // The jev note says the click went through unbound. When another check
    // then refuses, nothing went through and the note would mislead.
    const agent = new Agent({ getVisionProvider: async () => null });
    agent._uncertainTextMutationBlock = async () => null;
    agent._finalizeToolResultOnce = async (_tab, _name, _args, result) => result;
    const results = [{ success: false, noDispatch: true, error: 'Refused by a later check.' },
      { success: false, dispatched: false, error: 'Not dispatched.' },
      { success: false, dispatched: true, error: 'Dispatched, outcome unclear.' }];
    agent._executeToolImpl = async () => results.shift();
    const oldSend = api.tabs.sendMessage;
    api.tabs.sendMessage = async (_id, message) => message.action === 'jev_validate_target'
      ? { success: false, noDispatch: true, staleJevTarget: true } : { ready: true };
    try {
      const call = () => agent._executeToolWithLifecycle(nextTab++, 'click_ax', { ref_id: 'ref_3' }, null,
        { jevBinding: { ref: 'ref_3', documentToken: 'doc', structure: 's', signature: 'sig' } });
      assert.deepEqual(guardsOf(await call()), [], 'noDispatch: the note was kept');
      assert.deepEqual(guardsOf(await call()), [], 'dispatched:false: the note was kept');
      assert.deepEqual(guardsOf(await call()), ['jev-target-changed'], 'a dispatched call keeps its note');
    } finally { api.tabs.sendMessage = oldSend; }
  });

  // ── click-coordinate-intent ─────────────────────────────────────────────
  for (const [mode, strict] of MODES) {
    test(`${build}: click-coordinate-intent ${mode} mode ${strict ? 'refuses a mismatched point' : 'clicks the raw point with a note'}`, async () => {
      const agent = new Agent({ getVisionProvider: async () => null });
      agent.strictGuards = strict;
      agent._resolveCoordinateVisualTarget = async () => ({ success: true, documentToken: 'doc', refScopeUrl: PAGE_URL,
        semanticTarget: { name: 'Language', role: 'button', eligibility: 'semantic-button', ref_id: 'ref_9' } });
      agent._dispatchClickAx = async () => assert.fail('A mismatched semantic target is never clicked by ref');
      const advisories = [];
      const reconciled = await agent._reconcileCoordinateClick(nextTab++, { x: 40, y: 50 },
        { expectedName: 'Send', guardAdvisories: advisories });
      if (strict) {
        assert.equal(reconciled.result.targetMismatch, true);
        assert.equal(reconciled.result.noDispatch, true);
        assert.deepEqual(advisories, []);
      } else {
        // result:null makes the click handler dispatch the raw point.
        assert.equal(reconciled.result, null);
        assert.equal(reconciled.diagnostic.clickPath, 'coordinate-fallback');
        assert.equal(reconciled.diagnostic.fallbackReason, 'intent-mismatch');
        assert.deepEqual(guardsOf(advisories), ['click-coordinate-intent']);
      }
    });
  }

  // ── carousel-traversal-guards ───────────────────────────────────────────
  for (const [mode, strict] of MODES) {
    test(`${build}: carousel-traversal-guards ${mode} mode ${strict ? 'refuses a revisited slide' : 'opens a revisited slide without resetting its row'}`, async () => {
      const agent = new Agent({});
      agent.strictGuards = strict;
      const tab = nextTab++;
      let currentUrl = 'https://www.instagram.com/p/ABC123/';
      const rows = [], navigations = [];
      agent._currentUrl = async () => currentUrl;
      agent._carouselPageState = async () => ({ discoveredSlideCount: 6,
        visibleMediaFingerprint: `slide-${Number(new URL(currentUrl).searchParams.get('img_index')) || 1}` });
      agent._getVisibleInteractiveElements = async () => [];
      agent.progressExpectedItems.set(tab, { count: 6, item_type: 'photo', ordered: true, required_fields: ['carousel_position'] });
      agent._currentProgressSession = () => ({ sessionId: 'carousel-session', allowedActions: ['process_item'], pageScope: currentUrl });
      agent._progressUpdate = (_tab, payload) => { rows.push(...(payload.items || [])); return { success: true }; };
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'wait_for_stable') return { success: true, stable: true };
        assert.equal(name, 'navigate');
        navigations.push(args.url); currentUrl = args.url;
        return { success: true, dispatched: true, verified: true, url: currentUrl };
      };
      const navigate = index => Agent.prototype.executeTool.call(agent, tab, 'carousel_navigate', { index });
      assert.equal((await navigate(2)).success, true);
      assert.equal((await navigate(3)).success, true);
      const before = { rows: rows.length, navigations: navigations.length };
      const revisit = await navigate(2);
      if (strict) {
        assert.equal(revisit.nonMonotonic, true);
        assert.equal(navigations.length, before.navigations);
      } else {
        assert.equal(revisit.success, true);
        assert.equal(navigations.length, before.navigations + 1);
        assert.deepEqual(guardsOf(revisit), ['carousel-traversal-guards']);
        assert.equal(rows.length, before.rows, 'A revisit does not reset its processed row');
      }
    });
  }

  // ── recipient-clarify-cannot-repair-technical ───────────────────────────
  for (const [mode, strict] of MODES) {
    test(`${build}: recipient-clarify-cannot-repair-technical ${mode} mode ${strict ? 'refuses the recipient question' : 'asks the recipient question with a note'}`, async () => {
      const agent = new Agent({ getVisionProvider: async () => null });
      agent.strictGuards = strict;
      agent.clarifyTimeoutSec = 0;
      agent._persist = () => {};
      agent._persistNow = async () => ({ ok: true });
      const tab = nextTab++;
      agent._planExecutionGuards.set(tab, { enabled: true, messageRecipientTechnicalBlock: 'recipient_identity_unavailable' });
      const updates = [];
      const result = await Agent.prototype.executeTool.call(agent, tab, 'clarify', {
        question: 'Which conversation should receive this message?', options: ['Ada', 'Grace'], purpose: 'message_recipient',
      }, (type, data) => updates.push({ type, data }));
      if (strict) {
        assert.equal(result.success, false);
        assert.equal(result.reasonCode, 'recipient_identity_unavailable');
        assert.equal(updates.some(update => update.type === 'clarify'), false);
      } else {
        assert.equal(result.success, true);
        assert.ok(updates.some(update => update.type === 'clarify'), 'The question was shown');
        assert.deepEqual(guardsOf(result), ['recipient-clarify-cannot-repair-technical']);
        // The answer still does not approve a recipient; the send stays guarded.
        assert.match(result.note || '', /recipient|answer/i);
      }
    });
  }

  // ── github-commit-split-write-required ──────────────────────────────────
  function githubCommitAgent(strict, { bound = true } = {}) {
    const agent = new Agent({ getVisionProvider: async () => null });
    agent.strictGuards = strict;
    const tab = nextTab++;
    agent._planExecutionGuards.set(tab, { enabled: true, siteWorkflow: { adapterName: 'github', job: { id: 'edit-file-and-commit' } } });
    agent._socialPublicationPreSubmitBlock = async () => null;
    agent._captureMastodonPublicationAttempt = async () => {};
    agent._readControlEffect = async () => null;
    agent._currentUrl = async () => 'https://github.com/Example/Repo/edit/main/docs/plan.md';
    agent._refreshGithubTextReplacementProofs = async () => {};
    // The verified file and commit-message binding a commit click would use.
    agent._workflowSubmitBindingForAttempt = () => (bound
      ? { githubFileCommit: { repository: 'example/repo', branch: 'main', path: 'docs/plan.md' } }
      : { metadataRequirementsIncomplete: true });
    return { agent, tab };
  }
  for (const [mode, strict] of MODES) {
    test(`${build}: github-commit-split-write-required ${mode} mode ${strict ? 'refuses a submit that also writes' : 'lets a detected commit-with-write run with a note'}`, async () => {
      const { agent, tab } = githubCommitAgent(strict);
      const advisories = [];
      const block = await agent._workflowPreSubmitDispatchBlock(tab, 'set_field',
        { ref_id: 'ref_message', text: 'Fix typo', submit: true }, { isSubmit: true, host: 'github.com' }, null, advisories);
      if (strict) {
        assert.equal(block.splitWriteRequired, true);
        assert.deepEqual(advisories, []);
      } else {
        assert.equal(block, null);
        assert.deepEqual(guardsOf(advisories), ['github-commit-split-write-required']);
      }
    });

    test(`${build}: github-commit-split-write-required ${mode} mode keeps a commit-with-write refused without a verified binding`, async () => {
      // No verified file and message binding: github-commit-evidence-binding
      // keeps refusing, so there is nothing to advise.
      const { agent, tab } = githubCommitAgent(strict, { bound: false });
      const advisories = [];
      const block = await agent._workflowPreSubmitDispatchBlock(tab, 'set_field',
        { ref_id: 'ref_message', text: 'Fix typo', submit: true }, { isSubmit: true, host: 'github.com' }, null, advisories);
      assert.equal(block.splitWriteRequired, true);
      assert.deepEqual(advisories, []);
    });

    test(`${build}: github-commit-split-write-required ${mode} mode keeps an inconclusive script refused`, async () => {
      const { agent, tab } = githubCommitAgent(strict);
      assert.equal(agent._isFormValidationCandidate('execute_js', { code: 'void 0' }), true);
      const advisories = [];
      const block = await agent._workflowPreSubmitDispatchBlock(tab, 'execute_js', { code: 'void 0' }, null, null, advisories);
      assert.equal(block.splitWriteRequired, true);
      assert.deepEqual(advisories, []);
    });
  }

  // ── github-conditional-commit-rearm ─────────────────────────────────────
  for (const [mode, strict] of MODES) {
    test(`${build}: github-conditional-commit-rearm ${mode} mode ${strict ? 'defers the first editor action' : 'sends the first editor action under the armed contract'}`, async () => {
      const agent = new Agent({ getActive: () => ({ supportsVision: false }), getVisionProvider: async () => null });
      agent.strictGuards = strict;
      const tab = nextTab++;
      const runUrl = 'https://github.com/Example/Repo/actions/runs/123';
      agent.conversationModes.set(tab, 'act');
      agent.conversations.set(tab, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Check CI; if it failed, fix the workflow and commit.' }]);
      agent._persist = () => {};
      agent._currentUrl = async () => 'https://github.com/Example/Repo/edit/main/.github/workflows/main.yml';
      agent._ensureWorkflowMetadataRequirements = async () => {};
      const state = agent._startPlanExecutionGuard(tab, 'act', {
        requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
        siteWorkflowUrl: runUrl, conditionalSiteWorkflow: resolveAdapterWorkflowJob(runUrl, 'edit-file-and-commit'),
      }, { scheduledResume: true });
      const advisories = [];
      const block = await agent._conditionalGithubCommitTransition(tab, 'set_field',
        { ref_id: 'ref_editor', text: 'corrected workflow', submit: false }, { resolvedEditableTarget: true }, advisories);
      assert.equal(state.siteWorkflow?.job?.id, 'edit-file-and-commit', 'The contract is armed in both modes');
      assert.equal(state.requiresSubmission, true);
      if (strict) {
        assert.equal(block.workflowRearmed, true);
        assert.deepEqual(advisories, []);
      } else {
        assert.equal(block, null);
        assert.deepEqual(guardsOf(advisories), ['github-conditional-commit-rearm']);
      }
    });
  }

  // ── page-feedback-target-binding ────────────────────────────────────────
  function boundRun(agent, tab, events = []) {
    const state = { token: 'pf-run', url: PAGE_URL, frames: new Map(), steeringRevision: 0,
      actionBinding: { snapshotToken: 'snapshot-1', runToken: 'pf-run', documentToken: 'content-1' } };
    const run = { token: 'pf-run', url: PAGE_URL, documents: new Map(), frames: new Map(), revision: 0,
      events: new Map(events.map((event, index) => [index, event])), modelState: state, gestures: new Set(), gestureLeases: new Map() };
    agent._pageFeedbackRuns = new Map([[tab, run]]);
    return run;
  }
  async function bindingCall(strict, reason, events = []) {
    const agent = new Agent({ getVisionProvider: async () => null });
    agent.strictGuards = strict;
    const tab = nextTab++;
    boundRun(agent, tab, events);
    agent._uncertainTextMutationBlock = async () => null;
    agent._finalizeToolResultOnce = async (_tab, _name, _args, result) => result;
    const impl = [];
    agent._executeToolImpl = async (_tab, name) => { impl.push(name); return { success: true, dispatched: true }; };
    const oldSend = api.tabs.sendMessage;
    api.tabs.sendMessage = async (_id, message) => message.action === 'page_monitor_validate_model'
      ? { ready: false, reason, runToken: message.params.runToken, documentToken: 'content-1', snapshotToken: message.params.snapshotToken }
      : { ready: true };
    try {
      const result = await Agent.prototype.executeTool.call(agent, tab, 'click_ax', { ref_id: 'ref_uncovered' }, null, { guardAdvisories: [] });
      return { result, impl };
    } finally { api.tabs.sendMessage = oldSend; }
  }
  for (const [mode, strict] of MODES) {
    test(`${build}: page-feedback-target-binding ${mode} mode ${strict ? 'refuses an uncovered target' : 'sends an uncovered target with a note'}`, async () => {
      const { result, impl } = await bindingCall(strict, 'target_uncovered');
      if (strict) {
        assert.deepEqual(impl, []);
        assert.equal(result.errorCode, 'action_binding_unavailable');
      } else {
        assert.deepEqual(impl, ['click_ax']);
        assert.deepEqual(guardsOf(result), ['page-feedback-target-binding']);
      }
    });

    test(`${build}: page-feedback-target-binding ${mode} mode keeps ambiguous selectors and pending page activity refused`, async () => {
      for (const [reason, events] of [['target_ambiguous', []], ['target_unresolved', []],
        ['target_uncovered', [{ kind: 'dom', source: 'unknown', frameId: 0, target: 'div#feed' }]]]) {
        const { result, impl } = await bindingCall(strict, reason, events);
        assert.deepEqual(impl, [], reason);
        assert.equal(result.errorCode, 'action_binding_unavailable', reason);
        assert.deepEqual(guardsOf(result), [], reason);
      }
    });
  }

  // ── rich-text toolbar guards ────────────────────────────────────────────
  function toolbarAgent(strict) {
    const agent = new Agent({ getVisionProvider: async () => null });
    agent.strictGuards = strict;
    agent._resolveVisionRoute = async () => ({ provider: null });
    agent._shouldAutoScreenshot = () => false;
    agent._releaseRichTextToolbarProbeTarget = async () => {};
    return { agent, tab: nextTab++ };
  }
  const toolbarCandidate = { score: 6, reasons: ['semantic_toolbar', 'numeric_preset_value'], availablePresetValues: ['10', '12', '14'] };
  const toolbarProbe = { resolved: true, rect: { x: 10, y: 10, w: 40, h: 20 }, refId: 'ref_size', documentToken: 'doc-1',
    refScopeUrl: PAGE_URL, dispatchBinding: { token: 'binding-1' },
    fieldMeta: { tag: 'input', contentEditable: false, toolbarCandidate } };
  for (const [mode, strict] of MODES) {
    test(`${build}: rich-text-toolbar-target-unresolved ${mode} mode ${strict ? 'refuses an unresolved typing target' : 'lets the tool resolve its own target'}`, async () => {
      const { agent, tab } = toolbarAgent(strict);
      agent._probeRichTextToolbarRetryTarget = async () => ({ resolved: false });
      const advisories = [];
      const preflight = await agent._preflightRichTextToolbarTarget(tab, 'type_text', { selector: '#body', text: 'Hello there' },
        null, { guardAdvisories: advisories });
      if (strict) {
        assert.equal(preflight.block.noDispatch, true);
        assert.deepEqual(advisories, []);
      } else {
        assert.equal(preflight.block, null);
        assert.deepEqual(guardsOf(advisories), ['rich-text-toolbar-target-unresolved']);
      }
    });

    test(`${build}: rich-text-toolbar-wrong-target ${mode} mode ${strict ? 'refuses typing into a toolbar control' : 'types with a note and keeps the recovery obligation'}`, async () => {
      const { agent, tab } = toolbarAgent(strict);
      agent._probeRichTextToolbarRetryTarget = async () => structuredClone(toolbarProbe);
      const advisories = [];
      const preflight = await agent._preflightRichTextToolbarTarget(tab, 'type_ax',
        { ref_id: 'ref_size', text: 'Dear team, the release is ready for review.' }, null, { guardAdvisories: advisories });
      assert.equal(agent._richTextToolbarGuard.hasPending(tab), true, 'The obligation is recorded in both modes');
      if (strict) {
        assert.equal(preflight.block.wrongTarget, true);
        assert.deepEqual(advisories, []);
      } else {
        assert.equal(preflight.block, null);
        assert.equal(preflight.probe.dispatchBinding.token, 'binding-1', 'The advised edit stays bound to the probed target');
        assert.deepEqual(guardsOf(advisories), ['rich-text-toolbar-wrong-target']);
      }
    });

    test(`${build}: rich-text-toolbar-recovery-obligation ${mode} mode ${strict ? 'refuses the recorded toolbar ref' : 'uses the recorded toolbar ref with a note'}`, async () => {
      const { agent, tab } = toolbarAgent(strict);
      agent._richTextToolbarGuard.recordWrongTarget(tab, { toolName: 'type_ax', args: { ref_id: 'ref_size', text: 'Body text' },
        candidate: toolbarCandidate, decision: { source: 'structural_fallback', targetKind: 'font_size' },
        identity: { documentToken: 'doc-1', refScopeUrl: PAGE_URL } });
      agent._lastAxScopes.set(tab, { documentToken: 'doc-1', pageUrl: PAGE_URL });
      agent._probeRichTextToolbarRetryTarget = async () => ({ resolved: false });
      const advisories = [];
      const block = await agent._richTextToolbarToolBlock(tab, 'click_ax', { ref_id: 'ref_size' }, { guardAdvisories: advisories });
      if (strict) {
        assert.equal(block.blockedToolbarRef, true);
        assert.deepEqual(advisories, []);
      } else {
        assert.equal(block, null);
        assert.deepEqual(guardsOf(advisories), ['rich-text-toolbar-recovery-obligation']);
      }
      assert.equal(agent._richTextToolbarGuard.hasPending(tab), true, 'Only a verified editor-body edit releases it');
    });
  }
}
