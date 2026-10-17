import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureFixedChoiceReply } from './semantic-decision-stub.mjs';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://fixture/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://owned.example.test/upload', title: 'Owned task' }),
    sendMessage: async () => ({ ready: true }), executeScript: async () => [null] },
  scripting: { executeScript: async () => [{ result: null }] },
  webNavigation: { getAllFrames: async () => [] } };
globalThis.chrome = globalThis.browser = api;
let nextTab = 8900;
const call = (id, name, args = {}) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { incompleteCompletionBlock } = await import(`../src/${build}/src/agent/incomplete-completion.js`);
  const cdp = build === 'chrome' ? (await import('../src/chrome/src/cdp/cdp-client.js')).cdpClient : null;

  function unitFixture(choice = 'wait_then_check') {
    const provider = { chat() {} }, agent = new Agent({ getActive: () => provider });
    const guard = { enabled: true, siteWorkflowUrl: 'https://owned.example.test/source', successfulTaskToolCalls: 1 };
    const run = { runToken: 'owned-run', historyToolCallIdsBeforeRun: new Set() };
    agent._planExecutionGuards.set(1, guard); agent.completionInvariants.set(1, run);
    agent._progressTaskKeyHash = () => 'owned-task'; agent._progressTaskAnchorText = () => 'Upload the owned package.';
    agent._completionDocumentStamp = async () => 'owned-document';
    let asked = 0;
    agent._semanticDecision = async () => { asked++; return { choice }; };
    const options = { outcome: 'partial', summary: 'Upload is at 30%, Continue is disabled.', pageUrl: 'https://owned.example.test/upload',
      pageState: { documentIdentity: 'owned-document', workflowPageText: 'Uploading 30%\nContinue',
        incompleteTaskControls: [{ label: 'Continue', disabled: true }] } };
    return { agent, guard, run, options, asked: () => asked,
      check: () => incompleteCompletionBlock(agent, 1, options) };
  }

  test(`${build}: repeated incomplete endings have a finite recovery budget, which reads do not reset`, async () => {
    const h = unitFixture();
    for (let n = 0; n < 2; n++) {
      assert.equal((await h.check()).recoverableIncomplete, true);
      h.run.sequence = n + 10; // even a fresh observation cannot reset the budget
    }
    assert.equal(await h.check(), null);
    assert.equal(h.asked(), 2);
    h.agent._planExecutionGuards.set(1, { ...h.guard, incompleteCompletionRedirects: 0 });
    assert.equal((await h.check()).recoverableIncomplete, true, 'A new task guard gets its own budget.');
  });

  for (const choice of ['stop_required', 'exhausted', 'uncertain', null, 'not-a-choice']) {
    test(`${build}: genuine blockers, exhausted alternatives and inconclusive judges can finish (${choice})`, async () => {
      const h = unitFixture(choice);
      assert.equal(await h.check(), null);
      assert.equal(h.guard.incompleteCompletionRedirects, undefined);
    });
  }

  test(`${build}: manual verification and read-only or completed tasks skip the continuation check`, async () => {
    for (const change of [h => { h.agent._captchaGateStates.set(1, { status: 'manual_required' }); },
      h => { h.guard.enabled = false; }, h => { h.guard.taskDrifted = true; }, h => { h.options.outcome = 'success'; }]) {
      const h = unitFixture(); change(h);
      assert.equal(await h.check(), null); assert.equal(h.asked(), 0);
    }
  });

  test(`${build}: task, run, provider, steering and document changes invalidate an asynchronous continuation reading`, async () => {
    for (const change of [h => { h.agent._planExecutionGuards.set(1, { ...h.guard }); },
      h => { h.agent.completionInvariants.set(1, { ...h.run, runToken: 'new-run' }); },
      h => { h.agent._progressTaskKeyHash = () => 'new-task'; },
      h => { h.agent._activeProvider = () => ({ chat() {} }); },
      h => { h.agent._hasPendingSteering = () => true; },
      h => { h.agent._completionDocumentStamp = async () => 'new-document'; }]) {
      const h = unitFixture();
      h.agent._semanticDecision = async () => { change(h); return { choice: 'continue_now' }; };
      assert.equal((await h.check()).recoverableIncomplete, true);
      assert.equal(h.guard.incompleteCompletionRedirects, undefined);
    }
  });

  test(`${build}: unavailable judges permit honest failure while cancellation and cost errors propagate`, async () => {
    const h = unitFixture();
    h.agent._semanticDecision = async () => { throw new Error('Owned unavailable judge'); };
    assert.equal(await h.check(), null);
    for (const code of ['WB_COST_ALLOWANCE', 'STALE_COMPLETION']) {
      h.agent._semanticDecision = async () => { throw Object.assign(new Error(code), { code }); };
      await assert.rejects(h.check(), { code });
    }
    const controller = new AbortController();
    h.agent._runAbortSignal = () => controller.signal;
    h.agent._semanticDecision = async () => { controller.abort(new Error('Owned cancellation')); return { choice: 'continue_now' }; };
    await assert.rejects(h.check(), /Owned cancellation/);
  });

  test(`${build}: an iframe-bound document identity can recover and stop without repeated false freshness failures`, async () => {
    const h = unitFixture();
    h.agent._completionDocumentStamp = async () => JSON.stringify(['owned-document', 7, 'owned-iframe']);
    assert.equal((await h.check()).recovery, 'wait_then_check');
    assert.equal(h.guard.incompleteCompletionRedirects, 1);
    h.agent._semanticDecision = async () => ({ choice: 'stop_required' });
    assert.equal(await h.check(), null);
    h.agent._semanticDecision = async () => ({ choice: 'wait_then_check' });
    assert.equal((await h.check()).recovery, 'wait_then_check');
    assert.equal(await h.check(), null, 'Recovery remains bounded with an active submitted iframe.');
  });

  test(`${build}: runtime terminal-only delivery does not reopen an exhausted run`, async () => {
    const h = unitFixture(); h.options.terminalOnly = true;
    assert.equal(await h.check(), null); assert.equal(h.asked(), 0);
  });

  test(`${build}: only paired current execution outcomes reach the continuation judge, with redaction`, async () => {
    const h = unitFixture(); h.run.historyToolCallIdsBeforeRun.add('prior');
    h.agent.conversations.set(1, [
      { role: 'assistant', tool_calls: [{ id: 'prior', function: { name: 'click_ax' } }] },
      { role: 'tool', tool_call_id: 'prior', content: '{"denied":true,"error":"Old history"}' },
      { role: 'assistant', tool_calls: [{ id: 'owned', function: { name: 'upload_file' } }] },
      { role: 'tool', tool_call_id: 'owned', content: JSON.stringify({ success: true, remoteStateVerified: false,
        attachmentState: 'input_attached', error: 'password=PRIVATE_SECRET', file: 'PRIVATE_FILE_PATH' }) },
      { role: 'tool', tool_call_id: 'unpaired', content: '{"success":true,"error":"Spoofed"}' },
    ]);
    h.options.pageState.workflowPageText += '\naccess_token=PRIVATE_TOKEN';
    h.options.pageState.incompleteTaskControls[0].label = 'password=PRIVATE_CONTROL_SECRET';
    h.agent._semanticDecision = async (_tab, kind, context) => {
      assert.equal(kind, 'incomplete_task');
      assert.equal(context.page.starting_source_url, h.guard.siteWorkflowUrl);
      assert.equal(context.page.recorded_current_results.length, 1);
      assert.equal(context.page.recorded_current_results[0].remoteStateVerified, false);
      assert.doesNotMatch(JSON.stringify(context), /PRIVATE_SECRET|PRIVATE_TOKEN|PRIVATE_FILE_PATH|PRIVATE_CONTROL_SECRET|Old history|Spoofed/);
      return { choice: 'wait_then_check' };
    };
    assert.equal((await h.check()).recovery, 'wait_then_check');
  });

  test(`${build}: a refusal on WebBrain's card settles that action only; other requested work can still resume`, async () => {
    for (const [declinedResult, otherWorkLeft] of [
      [{ success: false, noDispatch: true, deletionDeclined: true, error: 'The user chose not to delete this item.' }, true],
      [{ success: false, denied: true, submitConfirmationRequired: true, error: 'The user did not confirm submitting.' }, true],
      [{ success: false, denied: true, permissionRequired: true, error: 'The user did not allow it.' }, false],
    ]) {
      const h = unitFixture();
      h.agent.conversations.set(1, [
        { role: 'assistant', tool_calls: [{ id: 'refused', function: { name: 'click_ax' } }, { id: 'other', function: { name: 'set_field' } }] },
        { role: 'tool', tool_call_id: 'refused', content: JSON.stringify(declinedResult) },
        { role: 'tool', tool_call_id: 'other', content: JSON.stringify({ success: false, denied: true, error: 'Not a user refusal.' }) },
      ]);
      let seen;
      h.agent._semanticDecision = async (_tab, kind, context) => {
        assert.equal(kind, 'incomplete_task');
        seen = context.page.recorded_current_results;
        return { choice: otherWorkLeft ? 'continue_now' : 'stop_required' };
      };
      const block = await h.check();
      assert.deepEqual(seen.map(entry => entry.userDeclined === true), [true, false], 'Only the card refusal is marked as the user\'s');
      if (otherWorkLeft) {
        assert.equal(block.recovery, 'continue_now', 'Unfinished sibling work still resumes after one refusal');
        assert.match(block.error, /refusal is final\. Do not retry it, ask again or reach it another way/);
      } else {
        assert.equal(block, null, 'A refusal of the only outstanding work ends honestly');
      }
    }
  });

  test(`${build}: without a refusal the continuation text says nothing about one`, async () => {
    const h = unitFixture('continue_now');
    assert.doesNotMatch((await h.check()).error, /declined/);
  });

  for (const streaming of [false, true]) for (const scenario of ['upload', 'missing-source']) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} recovers ${scenario} through the real done and tool-batch paths`, async () => {
      const tab = nextTab++, updates = [], actions = [], offered = [];
      let url = scenario === 'upload' ? 'https://owned.example.test/upload' : 'https://social.example.test/profile';
      let pageText = scenario === 'upload' ? 'Uploading owned.zip 30%\nContinue' : 'Profile\nCreate post';
      let requests = 0, judgments = 0, agent;
      const state = () => ({ url, title: 'Owned task', documentIdentity: `${url}|1000`, openDialogCount: 0,
        relevantFormCount: 0, liveRegionMessages: [], workflowPageText: pageText,
        incompleteTaskControls: [{ label: scenario === 'upload' ? 'Continue' : 'Create post', disabled: pageText.includes('30%') }] });
      const next = async (messages, options) => {
        const fixed = fixtureFixedChoiceReply(messages, {
          incomplete_task: ({ page }) => {
            judgments++;
            assert.match(page.starting_source_url, /owned\.example\.test/);
            if (scenario === 'upload') assert.equal(page.recorded_current_results.at(-1)?.attachmentState, 'input_attached');
            else assert.equal(page.recorded_task_progress.consequentialTools, 0);
            return scenario === 'upload' ? 'wait_then_check' : 'continue_now';
          }, done_summary: 'result',
        });
        if (fixed !== null) return { content: fixed };
        if (String(messages[0]?.content).startsWith('Evaluate only the observable requirements')) {
          assert.match(JSON.stringify(messages), /Owned operation complete/);
          return { content: '{"outcome":"succeeded","reason":"Fresh owned confirmation observed."}' };
        }
        requests++; offered.push(options.tools?.map(tool => tool.function.name) || []);
        if (scenario === 'upload') {
          if (requests === 1) return call('upload', 'upload_file', { selector: '#file', downloadId: 1 });
          if (requests === 2) return call('early', 'done', { outcome: 'partial', summary: 'Upload is at 30%; Continue remains disabled.' });
          if (requests === 3) { assert.ok(offered.at(-1).includes('wait_for_stable')); assert.ok(offered.at(-1).includes('click_ax'));
            return call('wait', 'wait_for_stable', { timeout: 10000, quietMs: 500, checkNetwork: true }); }
          if (requests === 4) return call('continue', 'click_ax', { ref_id: 'ref_continue' });
          if (requests === 5) return call('read', 'get_accessibility_tree', {});
        } else {
          if (requests === 1) return call('early', 'done', { outcome: 'failed', summary: 'The source release text is not visible on this profile.' });
          if (requests === 2) { assert.ok(offered.at(-1).includes('navigate')); assert.ok(offered.at(-1).includes('click_ax'));
            return call('source', 'navigate', { url: 'https://owned.example.test/release' }); }
          if (requests === 3) return call('read', 'get_accessibility_tree', {});
          if (requests === 4) return call('apply', 'click_ax', { ref_id: 'ref_apply' });
          if (requests === 5) return call('result', 'get_accessibility_tree', {});
        }
        assert.equal(requests, 6, 'No extra completion-only or failure-only turn should replace recovery.');
        return call('complete', 'done', { outcome: 'success', summary: 'Owned operation complete.' });
      };
      const provider = { model: 'owned', name: 'Owned', promptTier: 'full', supportsTools: true, supportsVision: false,
        contextWindow: 128000, config: { category: 'local' }, chat: next,
        async *chatStream(messages, options) { const result = await next(messages, options);
          if (result.content) yield { type: 'text', content: result.content };
          if (result.toolCalls) yield { type: 'tool_call', content: result.toolCalls.map((entry, index) => ({ ...entry, index })) };
          yield { type: 'done' }; } };
      agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
      Object.assign(agent, {
        _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
        _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
        _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
        _currentUrl: async () => url, _getTabUrlTitle: async () => ({ tabUrl: url, tabTitle: 'Owned task' }),
        _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
        _enrichUserMessageWithCurrentPage: async (_tab, _messages, content) => ({ role: 'user', content }),
        _plannerMode: () => 'off',
        _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: true,
          requiresSubmission: false, siteWorkflowUrl: 'https://owned.example.test/release' }),
        _skipPermissionGate: true, _ensureGateSetting: async () => true, _adoptLiveSocialPublishWorkflow: async () => false,
        _isFormValidationCandidate: () => false, _preflightRichTextToolbarTarget: async () => ({ block: null }),
        _auditRichTextToolbarTarget: async () => {}, _shouldAutoScreenshot: () => false, _pageFeedbackIdleMs: 0,
        _completionDocumentStamp: async () => `${url}|1000`, _captureViewportProbe: async () => ({ url, title: 'Owned task' }),
      });
      for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
        '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
      agent.maxSteps = 10;
      agent._executeToolWithLifecycle = async (_tab, name, args) => {
        actions.push(name);
        if (name === 'done') return agent._executeToolImpl(tab, name, args);
        if (name === 'upload_file') return { success: true, verified: false, remoteStateVerified: false, attachmentState: 'input_attached' };
        if (name === 'wait_for_stable') { pageText = 'Upload complete\nContinue'; return { success: true, stable: true }; }
        if (name === 'navigate') { const previousUrl = url; url = args.url; pageText = 'Owned release notes\nApply';
          return { success: true, dispatched: true, verified: true, previousUrl, currentUrl: url, pageUrlChanged: true }; }
        if (name === 'click_ax') { url = 'https://owned.example.test/result'; pageText = 'Owned operation complete';
          return { success: true, dispatched: true, verified: true, currentUrl: url, pageUrlChanged: true }; }
        assert.equal(name, 'get_accessibility_tree'); return { success: true, pageContent: pageText, pageUrl: url };
      };
      const previousExecute = api.tabs.executeScript;
      const previousCdp = cdp && Object.fromEntries(['attach', 'sendCommand', 'evaluate'].map(name => [name, cdp[name]]));
      api.tabs.executeScript = async () => [state()];
      if (cdp) { cdp.attach = async () => {}; cdp.sendCommand = async () => ({});
        cdp.evaluate = async () => ({ result: { value: state() } }); }
      try {
        const task = scenario === 'upload' ? 'Upload the owned package and continue to details.' : 'Retrieve the owned release text and apply it to the current task.';
        const result = streaming ? await agent.processMessageStream(tab, task, (type, data) => updates.push({ type, data }), 'act')
          : await agent.processMessage(tab, task, (type, data) => updates.push({ type, data }), 'act');
        assert.equal(result, 'Owned operation complete.');
        assert.equal(judgments, 1);
        assert.equal(actions.filter(name => name === 'done').length, 2);
        assert.equal(actions.filter(name => name === 'upload_file').length, scenario === 'upload' ? 1 : 0);
        assert.equal(actions.filter(name => name === 'click_ax').length, 1);
        assert.equal(updates.some(update => update.type === 'tool_result' && update.data?.result?.recoverableIncomplete), true);
      } finally { api.tabs.executeScript = previousExecute; if (cdp) Object.assign(cdp, previousCdp); }
    });
  }

  // A full run of the real agent loop over an owned page. `script(names,
  // request)` plays the model; `execute(name, args)` stands in for the browser.
  async function runOwnedTask({ streaming, task, url, pageState, judge, script, execute, strict = false }) {
    const tab = nextTab++;
    const next = async (messages, options) => {
      const fixed = fixtureFixedChoiceReply(messages, { incomplete_task: judge, done_summary: 'result' });
      if (fixed !== null) return { content: fixed };
      if (String(messages[0]?.content).startsWith('Evaluate only the observable requirements')) {
        return { content: '{"outcome":"succeeded","reason":"Fresh owned confirmation observed."}' };
      }
      return script(options.tools?.map(tool => tool.function.name) || []);
    };
    const provider = { model: 'owned', name: 'Owned', promptTier: 'full', supportsTools: true, supportsVision: false,
      contextWindow: 128000, config: { category: 'local' }, chat: next,
      async *chatStream(messages, options) { const result = await next(messages, options);
        if (result.content) yield { type: 'text', content: result.content };
        if (result.toolCalls) yield { type: 'tool_call', content: result.toolCalls.map((entry, index) => ({ ...entry, index })) };
        yield { type: 'done' }; } };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent.strictGuards = strict;
    Object.assign(agent, {
      _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
      _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
      _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
      _currentUrl: async () => url, _getTabUrlTitle: async () => ({ tabUrl: url, tabTitle: 'Owned task' }),
      _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
      _enrichUserMessageWithCurrentPage: async (_tab, _messages, content) => ({ role: 'user', content }),
      _plannerMode: () => 'off',
      _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: true,
        requiresSubmission: false, siteWorkflowUrl: url }),
      _skipPermissionGate: true, _ensureGateSetting: async () => true, _adoptLiveSocialPublishWorkflow: async () => false,
      _isFormValidationCandidate: () => false, _preflightRichTextToolbarTarget: async () => ({ block: null }),
      _auditRichTextToolbarTarget: async () => {}, _shouldAutoScreenshot: () => false, _pageFeedbackIdleMs: 0,
      _completionDocumentStamp: async () => `${url}|1000`, _captureViewportProbe: async () => ({ url, title: 'Owned task' }),
    });
    for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
      '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
    agent.maxSteps = 12;
    agent._executeToolWithLifecycle = async (_tab, name, args) => (name === 'done'
      ? agent._executeToolImpl(tab, name, args) : execute(name, args));
    const state = () => ({ url, title: 'Owned task', documentIdentity: `${url}|1000`, openDialogCount: 0,
      relevantFormCount: 0, liveRegionMessages: [], ...pageState() });
    const previousExecute = api.tabs.executeScript;
    const previousCdp = cdp && Object.fromEntries(['attach', 'sendCommand', 'evaluate'].map(name => [name, cdp[name]]));
    api.tabs.executeScript = async () => [state()];
    if (cdp) { cdp.attach = async () => {}; cdp.sendCommand = async () => ({});
      cdp.evaluate = async () => ({ result: { value: state() } }); }
    try {
      return streaming ? await agent.processMessageStream(tab, task, () => {}, 'act')
        : await agent.processMessage(tab, task, () => {}, 'act');
    } finally { api.tabs.executeScript = previousExecute; if (cdp) Object.assign(cdp, previousCdp); }
  }

  for (const streaming of [false, true]) {
    // The failure-only turn of an unverifiable action must not become a way
    // back to mutation tools: a recoverable ending keeps the verification turn
    // until the dispatched action is observed.
    test(`${build}: ${streaming ? 'stream' : 'chat'} keeps an unverified action read-only after a recoverable incomplete ending`, async () => {
      const actions = [];
      let pageText = 'Saving...\nSubmit', requests = 0, judgments = 0, reads = 0;
      // Strict checks: the guard's refusal itself is under test.
      const result = await runOwnedTask({ streaming, strict: true, task: 'Submit the owned form.', url: 'https://owned.example.test/form',
        pageState: () => ({ workflowPageText: pageText, incompleteTaskControls: [{ label: 'Submit',
          disabled: pageText.startsWith('Saving'), busy: pageText.startsWith('Saving') }] }),
        judge: () => { judgments++; return 'wait_then_check'; },
        script: names => {
          requests++;
          if (requests === 1) return call('submit', 'click_ax', { ref_id: 'ref_submit' });
          if (requests === 2) return call('early', 'done', { outcome: 'success', summary: 'Submitted.' });
          if (requests === 3) { assert.equal(names.includes('click_ax'), false); return call('read-failed', 'get_accessibility_tree', {}); }
          if (requests === 4) { assert.ok(names.includes('done')); assert.equal(names.includes('click_ax'), false);
            return call('give-up', 'done', { outcome: 'partial', summary: 'Could not verify the submission.' }); }
          if (requests === 5) {
            assert.equal(names.includes('click_ax'), false, `The unverified action reopened mutation tools: ${names.join(', ')}`);
            assert.ok(names.includes('get_accessibility_tree'));
            return call('read', 'get_accessibility_tree', {});
          }
          assert.equal(requests, 6, 'Observation ends the verification turn.');
          assert.ok(names.includes('click_ax'), 'Observation clears the debt and restores the task tools.');
          return call('complete', 'done', { outcome: 'success', summary: 'Owned operation complete.' });
        },
        execute: name => {
          actions.push(name);
          if (name === 'click_ax') return { success: true, dispatched: true, verified: false };
          assert.equal(name, 'get_accessibility_tree');
          // The first observation fails, so the dispatched action stays unverified.
          if (++reads === 1) return { success: false, error: 'Owned read failure' };
          pageText = 'Owned operation complete';
          return { success: true, pageContent: pageText, pageUrl: 'https://owned.example.test/form' };
        },
      });
      assert.equal(result, 'Owned operation complete.');
      assert.equal(judgments, 1);
      assert.equal(actions.filter(name => name === 'click_ax').length, 1, 'The action is never repeated.');
      assert.equal(requests, 6);
    });

    // An observed mismatch is different: verify_form already read the iframe
    // field, and only iframe_type can correct it, so the redirect returns the
    // task tools.
    test(`${build}: ${streaming ? 'stream' : 'chat'} corrects an observed iframe value mismatch after a recoverable incomplete ending`, async () => {
      const actions = [], field = { selector: '#email', urlFilter: 'owned-frame.test', text: 'owner@example.test', clear: true };
      let requests = 0, judgments = 0, corrected = false, matched = false;
      // Strict checks: the guard's refusal itself is under test.
      const result = await runOwnedTask({ streaming, strict: true, task: 'Fill the owned email field.', url: 'https://owned.example.test/form',
        pageState: () => ({ workflowPageText: 'Email: wrong@example.test', incompleteTaskControls: [] }),
        judge: () => { judgments++; return 'continue_now'; },
        script: names => {
          requests++;
          if (requests === 1) return call('type', 'iframe_type', field);
          if (requests === 2) return call('early', 'done', { outcome: 'success', summary: 'Filled.' });
          const taskTools = names.includes('iframe_type');
          if (taskTools && judgments && !corrected) { corrected = true; return call('fix', 'iframe_type', field); }
          if (taskTools && matched) return call('complete', 'done', { outcome: 'success', summary: 'Email field verified.' });
          if (!taskTools && names.includes('done')) {
            return call('give-up', 'done', { outcome: 'partial', summary: 'The email field shows a different value.' });
          }
          return call(`verify-${requests}`, 'verify_form', { urlFilter: 'owned-frame.test' });
        },
        execute: name => {
          actions.push(name);
          if (name === 'iframe_type') return { success: true, value: 'owner@example.test', frameId: 3, matchIndex: 0 };
          if (name === 'verify_form') {
            matched = corrected;
            return { success: true, scope: 'iframe', urlFilter: 'owned-frame.test', targetChecks: [{ matched: true,
              valueMatchesExpected: corrected, selector: '#email', frameId: 3, matchIndex: 0, scope: 'owned-frame.test' }] };
          }
          return { success: true, pageContent: 'Email: owner@example.test', pageUrl: 'https://owned.example.test/form' };
        },
      });
      assert.equal(result, 'Email field verified.');
      assert.equal(judgments, 1);
      assert.equal(corrected, true, 'The redirect offered iframe_type to correct the observed mismatch.');
    });
  }
}
