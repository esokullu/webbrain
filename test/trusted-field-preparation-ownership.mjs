import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fixturePageTextReading } from './semantic-decision-stub.mjs';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area }, runtime: { getURL: value => value }, tabs: {} };
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');
const tabId = 717;
const args = { ref_id: 'ref_7', text: 'New authored value', clear: true };
const scope = { documentToken: 'owned-document', refScopeUrl: 'https://owned-field.invalid/editor' };
const sha = text => createHash('sha256').update(text).digest('hex');

// Stub only browser transport. The fallback, SHA/document comparison, private
// attestation, finalization and uncertain-write ledger are production methods.
async function runScenario(options = {}, inspect) {
  const savedSend = api.tabs.sendMessage, savedAttach = cdpClient.attach, savedCommand = cdpClient.sendCommand;
  const agent = new Agent({});
  if (options.strict) agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
  const commands = [], messages = [];
  const abort = new AbortController();
  let preparations = 0, digests = 0;
  agent._lastAxScopes.set(tabId, { documentToken: scope.documentToken, pageUrl: scope.refScopeUrl });
  api.tabs.sendMessage = async (_tab, message) => {
    messages.push(message);
    if (message.action === 'field_value_digest') {
      digests++;
      if (options.missingBefore && digests === 1) return { success: false, ...scope };
      const later = digests > 1;
      return { success: true, ...scope, valueLength: 8, valueSha256: sha('Original'),
        ...(later ? options.after : {}) };
    }
    if (message.action === 'ax_prepare_field_for_trusted_type') {
      preparations++;
      if (options.preparationFails || (preparations === 2 && options.reselectionFails !== false)) {
        if (options.abortAfterFocus && preparations === 2) abort.abort();
        return { success: false, pageFeedbackPending: true, error: 'Browser changed during action preparation' };
      }
      return { success: true, contentEditable: true, rect: { x: 10, y: 20, w: 200, h: 70 } };
    }
    if (message.action === 'ax_verify_field_value') return { success: true, verified: true };
    throw new Error(`Unexpected owned content request ${message.action}`);
  };
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async (_tab, method, params) => {
    commands.push({ method, params });
    if (method === 'Input.insertText' && options.loseTextResponse) throw new Error('Owned text response lost');
    return {};
  };
  try {
    const result = await agent._maybeFallbackFieldWithCdpImpl(tabId, 'set_field', args,
      { success: false, verified: false, noDispatch: true, dispatched: false,
        _expectedValue: args.text, error: 'Trusted editor typing required' }, {}, abort.signal);
    return await inspect({ agent, result, commands, messages, preparations, digests });
  } finally {
    api.tabs.sendMessage = savedSend;
    cdpClient.attach = savedAttach;
    cdpClient.sendCommand = savedCommand;
  }
}

test('Chrome trusted focus-only failure is retryable only after exact same-document unchanged readback', async () => {
  await runScenario({}, async ({ agent, result, commands, preparations, digests }) => {
    assert.equal(preparations, 2); assert.equal(digests, 2);
    assert.equal(commands.filter(command => command.method === 'Input.dispatchMouseEvent').length, 3);
    assert.equal(commands.some(command => command.method === 'Input.insertText'), false);
    assert.equal(result.success, false); assert.equal(result.dispatched, true);
    assert.equal(result.textUnchanged, true); assert.equal(result.retryable, true);
    assert.equal(result.mutationMayHaveOccurred, false); assert.equal(result.repeatBlocked, false);
    assert.equal(result.pageFeedbackPending, true); assert.equal(result.recoveryRequired, 'fresh_tree');
    const finalized = await agent._finalizeTextMutationResult(tabId, 'set_field', args, result);
    assert.equal(finalized.textUnchanged, true);
    assert.equal(Object.getOwnPropertySymbols(finalized).length, 0, 'Private attestation must not cross the tool output boundary.');
    assert.equal(agent._uncertainTextMutations.get(tabId)?.size || 0, 0);
  });
});

for (const [name, options] of [
  ['changed full value', { after: { valueSha256: sha('Different') } }],
  ['changed value length', { after: { valueLength: 9 } }],
  ['replacement document', { after: { documentToken: 'replacement-document' } }],
  ['changed route', { after: { refScopeUrl: 'https://owned-field.invalid/another' } }],
  ['missing initial digest', { missingBefore: true }],
  ['Stop after focus', { abortAfterFocus: true }],
]) test(`Chrome ${name} retains uncertain text debt after trusted focus`, async () => {
  await runScenario({ ...options, strict: true }, async ({ agent, result, commands }) => {
    assert.notEqual(result.textUnchanged, true);
    assert.equal(commands.some(command => command.method === 'Input.insertText'), false);
    const finalized = await agent._finalizeTextMutationResult(tabId, 'set_field', args, result);
    assert.equal(finalized.repeatBlocked, true); assert.equal(finalized.mutationMayHaveOccurred, true);
    assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
  });
});

test('Chrome a lost text-command response cannot mint unchanged preparation proof even if readback still looks unchanged', async () => {
  await runScenario({ reselectionFails: false, loseTextResponse: true, strict: true }, async ({ agent, result, commands, digests }) => {
    assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 1);
    assert.equal(digests, 1, 'An attempted text command must not use a sample that can precede a delayed applied write.');
    assert.notEqual(result.textUnchanged, true);
    const finalized = await agent._finalizeTextMutationResult(tabId, 'set_field', args, result);
    assert.equal(finalized.repeatBlocked, true); assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
  });
});

test('Chrome preparation failure before native focus preserves no-dispatch and fresh-tree feedback', async () => {
  await runScenario({ preparationFails: true }, async ({ agent, result, commands }) => {
    assert.equal(commands.length, 0); assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false);
    assert.equal(result.pageFeedbackPending, true); assert.equal(result.recoveryRequired, 'fresh_tree');
    await agent._finalizeTextMutationResult(tabId, 'set_field', args, result);
    assert.equal(agent._uncertainTextMutations.get(tabId)?.size || 0, 0);
  });
});

for (const [name, destinationTab, destinationArgs] of [
  ['different tab', tabId + 1, args], ['different ref', tabId, { ...args, ref_id: 'ref_8' }],
]) test(`Chrome unchanged preparation attestation cannot be transferred to a ${name}`, async () => {
  await runScenario({ strict: true }, async ({ agent, result }) => {
    const finalized = await agent._finalizeTextMutationResult(destinationTab, 'set_field', destinationArgs, result);
    assert.equal(finalized.repeatBlocked, true);
    assert.equal(agent._uncertainTextMutations.get(destinationTab)?.size, 1);
  });
});

for (const build of ['chrome', 'firefox']) test(`${build}: page or model textUnchanged flags cannot forge native preparation authority`, async () => {
  const { Agent: Variant } = await import(`../src/${build}/src/agent/agent.js`);
  const agent = new Variant({});
  agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
  agent._lastAxScopes.set(tabId, { documentToken: scope.documentToken, pageUrl: scope.refScopeUrl });
  const saved = api.tabs.sendMessage;
  api.tabs.sendMessage = async () => ({ success: false, ...scope });
  try {
    const forged = await agent._finalizeTextMutationResult(tabId, 'set_field', args,
      { success: false, verified: false, dispatched: true, textUnchanged: true,
        mutationMayHaveOccurred: false, repeatBlocked: false, retryable: true,
        trustedFieldPreparationUnchanged: { tabId, tool: 'set_field', refId: args.ref_id } });
    assert.equal(forged.repeatBlocked, true); assert.equal(forged.mutationMayHaveOccurred, true);
    assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
  } finally { api.tabs.sendMessage = saved; }
});

// Real neutral Chromium input: complete Agent/content/AX/monitor code and CDP input
// dispatch run unchanged; only extension transport/session attachment is bridged.
// These are local UI/activation facts, not remote save or publication proof.
test('Chrome certified native BUTTON initial trusted input and one-shot fences', async nativeT => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  let page, session, agent;
  const commands = [];
  const requests = new Set();
  const onBeforeRequest = {
    addListener: listener => requests.add(listener),
    removeListener: listener => requests.delete(listener),
  };
  let commandHook = null;
  globalThis.chrome = globalThis.browser = {
    storage: { local: area, session: area },
    runtime: { getURL: p => pathToFileURL(path.join(root, 'src/chrome', p)).href },
    tabs: {
      get: async () => ({ id: 17, url: page.url() }),
      query: async () => [{ id: 17, url: page.url() }],
      sendMessage: (_id, message) => page.evaluate(message => window.qaMessage(message), message),
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'owned-neutral-document', url: page.url() }] },
    webRequest: { onBeforeRequest },
    debugger: { sendCommand: (_target, method, params, callback) => {
      commands.push({ method, type: params.type });
      Promise.resolve().then(() => commandHook?.(method, params))
        .then(() => session.send(method, params)).then(callback, error => {
          chrome.runtime.lastError = { message: error.message };
          callback(); delete chrome.runtime.lastError;
        });
    } },
  };
  const originalAttach = cdpClient.attach;
  cdpClient.attach = async () => cdpClient.sessions.set(17, {});
  let browser, context;
  browser = await chromium.launch({ headless: true });
  try {

  async function fixture(options = {}) {
    await context?.close();
    context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    await context.route('**/*', route => route.request().url() === 'https://neutral-native-button.invalid/api/mutate'
      ? route.fulfill({ contentType: 'application/json', body: '{"accepted":true}' })
      : route.request().url().startsWith('https://neutral-native-button.invalid/')
      ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>body{margin:20px}button{width:200px;height:45px} ${options.preparationCss || ""}</style>
        <main><h1>Current record settings</h1><button id="commit" type="button">${options.nested ? "<span>Apply settings</span>" : (options.label || "Apply settings")}</button>
        <label>Record title<input value="Owned neutral draft"></label>${options.filePicker ? "<input id=ownedFile type=file hidden>" : ""}<output id="result">0</output></main>
        <script>window.qaClicks=[];window.qaCommits=0;${options.preparationScript || ""}commit.addEventListener('click',event=>{
        qaClicks.push({trusted:event.isTrusted,active:navigator.userActivation.isActive});
        if(event.isTrusted&&navigator.userActivation.isActive&&!${options.noCommit ? "true" : "false"}){result.textContent=String(++qaCommits);${options.weakEffect ? "const row=document.createElement('div');row.dataset.ownedNeutralRow='';row.textContent='Owned row '+qaCommits;commit.closest('main').append(row);" : "commit.setAttribute('aria-pressed',String(qaCommits%2===1));"}} ${options.filePicker ? "ownedFile.click();" : ""}});</script>` })
      : route.abort());
    page = await context.newPage();
    page.on('request', request => {
      if (!['xhr', 'fetch'].includes(request.resourceType())) return;
      for (const listener of [...requests]) listener({ tabId: 17, url: request.url(),
        method: request.method(), type: 'xmlhttprequest' });
    });
    agent = new Agent({ getActive: () => ({ model: 'neutral-model' }) });
    // What a model read the page's status texts as saying.
    agent._pageTextReading = fixturePageTextReading;
    agent._runningTabs.add(17);
    await page.exposeFunction('qaBackground', message => {
      const sender = { tab: { id: 17 }, frameId: 0, documentId: 'owned-neutral-document', url: page.url() };
      if (message.action === 'get_page_monitor_state') return agent.pageMonitorState(sender, message.documentToken);
      if (message.action === 'page_feedback') return agent.observePageFeedback(sender, message.feedback);
      return {};
    });
    await page.addInitScript(() => {
      window.qaListeners = [];
      window.chrome = window.browser = { runtime: {
        getURL: p => p,
        onMessage: { addListener: f => qaListeners.push(f), removeListener() {} },
        sendMessage: message => window.qaBackground(message),
      } };
      window.qaMessage = message => new Promise(resolve => {
        let answered = false;
        const respond = value => { answered = true; resolve(value); };
        for (const f of qaListeners) { const value = f(message, {}, respond); if (answered || value === true) return; }
        resolve(undefined);
      });
    });
    for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
      const p = path.join(root, 'src/chrome/src/content', name);
      await page.addInitScript({ content: await readFile(p, 'utf8') });
    }
    await page.goto('https://neutral-native-button.invalid/current');
    session = await context.newCDPSession(page);
    await agent._beginPageFeedbackRun(17, 'neutral');
    await page.waitForFunction(() => window.__wbPageMonitor?.active);
    await page.waitForTimeout(180);
    const run = agent._pageFeedbackRuns.get(17);
    run.events.clear();
    const axScope = await chrome.tabs.sendMessage(17, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'visible', maxChars: 12000 } });
    const capture = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_capture_model',
      params: { runToken: run.token, includeTree: true } });
    const ref = capture.page.pageContent.match(/button "(?:Apply settings|Add row|Change|Done|Publish|Cancel)" \[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
    assert.ok(ref, capture.page.pageContent);
    const state = { token: run.token, url: run.url, steeringRevision: 0, frames: new Map(run.frames),
      actionBinding: { snapshotToken: capture.snapshotToken, runToken: run.token, documentToken: capture.documentToken } };
    run.modelState = state;
    const dispatchState = { started: false };
    run.dispatchCall = { name: 'click_ax', args: { ref_id: ref }, expectedModelSnapshot: capture.snapshotToken,
      modelState: state, dispatchState, allowPassiveRebase: true };
    const prepared = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare',
      params: { runToken: run.token, tool: 'click_ax', ref_id: ref, operationId: 'neutral-owned-operation',
        expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true } });
    assert.equal(prepared.modelBindingValid, true);
    commands.length = 0; commandHook = null;
    agent._settleContentFilePickerGuard = async (_id, result) => result;
    agent._annotateClickProgress = async (_id, _name, _args, result) => result;
    agent._recordInteractionRect = () => {};
    agent._clearUploadSelectorRecoveryAfterInspection = () => {};
    return { agent, run, capture, ref, dispatchState, scope: { documentToken: axScope.documentToken, pageUrl: axScope.refScopeUrl }, ...options };
  }
  const dispatch = async (f, timing = null, abortSignal = null, recipientContext = null) => {
    // Exercise the ordinary owner wrapper: one operation spans all input phases.
    f.agent._lastAxScopes.set(17, f.scope);
    const record = f.agent._recordClickAxTiming;
    f.agent._recordClickAxTiming = function(tab, step, measured, result) {
      if (timing) Object.assign(timing, measured);
      return record.call(this, tab, step, measured, result);
    };
    try { return await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref }, null,
      abortSignal || recipientContext ? { ...recipientContext,
        ...(abortSignal ? { _contentActionAbortSignal: abortSignal } : {}) } : null); }
    finally { f.agent._recordClickAxTiming = record; }
  };
  const facts = () => page.evaluate(() => ({ commits: qaCommits, clicks: qaClicks }));

  // Exercise the real isolated-world finish handler, not a transport mock.
  // A rejected stale finish must leave the current dispatched operation open.
  for (const scenario of ['current', 'wrong run', 'wrong document', 'missing operation'])
    await nativeT.test(`real monitor finish preserves its current operation: ${scenario}`, async () => {
      const f = await fixture({ noCommit: true });
      const operationId = 'neutral-owned-operation';
      const started = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch',
        params: { runToken: f.run.token, operationId, kind: 'click', tool: 'click_ax', ref_id: f.ref,
          expectedModelSnapshot: f.capture.snapshotToken, allowPassiveRebase: true } });
      assert.equal(started.ready, true, 'The real monitor must own one dispatched operation.');
      const params = { runToken: f.run.token, documentToken: f.capture.documentToken, operationId,
        ...(scenario === 'wrong run' ? { runToken: 'foreign-finish-run' } : {}),
        ...(scenario === 'wrong document' ? { documentToken: 'foreign-finish-document' } : {}),
        ...(scenario === 'missing operation' ? { operationId: 'missing-finish-operation' } : {}) };
      const finished = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_finish', params });
      assert.equal(finished.ready, scenario === 'current');
      await page.evaluate(() => { const row = document.createElement('div');
        row.textContent = 'Separate material record mutation'; document.querySelector('main').append(row); });
      await page.waitForTimeout(180);
      const changes = [...f.run.events.values()].filter(event => event.kind === 'dom');
      assert.ok(changes.length > 0, 'The real monitor must deliver the material DOM mutation.');
      assert.equal(changes.some(event => event.source === 'unknown'), scenario !== 'current',
        'Rejected finish cannot close the current operation or convert its unknown mutation to passive.');
      if (scenario === 'current') assert.ok(changes.some(event => event.source === 'page'));
      const currentFinish = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_finish',
        params: { runToken: f.run.token, documentToken: f.capture.documentToken, operationId } });
      assert.equal(currentFinish.ready, true, 'A stale request must not remove the valid current operation.');
      assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
    });

  async function freshObservation(f) {
    await page.waitForTimeout(180);
    const capture = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_capture_model',
      params: { runToken: f.run.token, includeTree: true } });
    const ref = capture.page.pageContent.match(/button "(?:Apply settings|Add row|Change|Done|Publish|Cancel)" \[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
    assert.equal(ref, f.ref, 'The real AX registry keeps the native target ref stable.');
    assert.notEqual(capture.snapshotToken, f.run.modelState.actionBinding.snapshotToken);
    const state = { token: f.run.token, url: f.run.url, steeringRevision: 0, frames: new Map(f.run.frames),
      actionBinding: { snapshotToken: capture.snapshotToken, runToken: f.run.token, documentToken: capture.documentToken } };
    f.run.modelState = state; f.run.events.clear(); f.dispatchState = { started: false };
    f.run.dispatchCall = { name: 'click_ax', args: { ref_id: ref }, expectedModelSnapshot: capture.snapshotToken,
      modelState: state, dispatchState: f.dispatchState, allowPassiveRebase: true };
    const prepared = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare',
      params: { runToken: f.run.token, tool: 'click_ax', ref_id: ref, operationId: 'fresh-owned-action',
        expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true } });
    assert.equal(prepared.modelBindingValid, true);
  }


  await nativeT.test('production click_ax sends exactly one initially trusted native BUTTON click with genuine activation', async () => {
    const f = await fixture();
    const result = await dispatch(f);
    const observed = await facts();
    assert.equal(observed.commits, 1, JSON.stringify({ result, observed }));
    assert.deepEqual(observed.clicks, [{ trusted: true, active: true }]);
    assert.equal(result.initialTrustedNativeButton, true);
    assert.equal(result.trusted, true);
    assert.equal(result.fallbackAttempted, undefined);
  });

  // The existing completion recorder distinguishes acknowledged input from
  // independently observed submit evidence. No remote image identity is inferred.
  const rememberCommit = (f, result) => {
    f.agent._lastAxScopes.set(17, { documentToken: f.scope.documentToken, pageUrl: f.scope.pageUrl });
    f.agent._recordCompletionToolResult(17, 'click_ax', { ref_id: f.ref }, result);
    return f.agent._recordCompletionSubmitAttempt(17, null, 'click_ax', { ref_id: f.ref },
      f.scope.pageUrl, f.scope.pageUrl, result, f.scope.documentToken, f.scope.documentToken);
  };
  const readCommit = async f => {
    const read = await chrome.tabs.sendMessage(17, { target: 'content', action: 'get_accessibility_tree',
      params: { filter: 'visible', maxChars: 12000 } });
    f.agent._lastAxScopes.set(17, { documentToken: read.documentToken, pageUrl: read.refScopeUrl });
    f.agent._recordCompletionToolResult(17, 'get_accessibility_tree', {}, read);
    return read;
  };
  const commitEvidence = f => f.agent._completionSubmissionEvidence(17,
    { relevantFormCount: 0, successMessages: [] }, f.scope.pageUrl);

  await nativeT.test('native commit metadata: current Publish acknowledgement arms tracking and a later confirmation read proves it', async () => {
    const f = await fixture({ label: 'Publish', preparationScript: `
      commit.addEventListener('click', event => { if (event.isTrusted) {
        const status=document.createElement('div');status.setAttribute('role','status');
        status.textContent='Changes published';commit.closest('main').append(status);
      }});` });
    f.agent._beginCompletionInvariant(17);
    const result = await dispatch(f);
    assert.equal(result.success, true); assert.equal(result.nativeInputAcknowledged, true);
    assert.equal(result.name, 'Publish', 'Retain the current certified pre-input name.');
    assert.equal(result.isSubmitControl, undefined, 'Do not relabel a native type=button as an HTML submit.');
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
    rememberCommit(f, result);
    assert.equal(f.agent._completionSubmitStates.get(17)?.dispatched, true);
    assert.equal(commitEvidence(f).verifiedFinalSubmit, false, 'Acknowledged input is not remote completion.');
    const read = await readCommit(f);
    assert.match(read.pageContent, /status "Changes published"/);
    assert.equal(commitEvidence(f).verifiedFinalSubmit, true, 'The existing post-submit confirmation predicate verifies the result.');
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 1);
  });

  await nativeT.test('native commit metadata: locally disabled Publish without confirmation remains unverified', async () => {
    const f = await fixture({ label: 'Publish', preparationScript: "commit.addEventListener('click',event=>{if(event.isTrusted)commit.disabled=true;});" });
    f.agent._beginCompletionInvariant(17);
    const result = await dispatch(f);
    assert.equal(result.name, 'Publish'); assert.equal(result.nativeInputAcknowledged, true);
    assert.equal(result.verified, true, 'The local disabled-state effect is distinct from completion.');
    rememberCommit(f, result); await readCommit(f);
    assert.equal(f.agent._completionSubmitStates.get(17)?.dispatched, true);
    assert.equal(commitEvidence(f).verifiedFinalSubmit, false);
    assert.equal(commitEvidence(f).observedSuccessSignal, false);
  });

  await nativeT.test('native commit metadata: fully acknowledged Cancel is not a submit', async () => {
    const f = await fixture({ label: 'Cancel' }); f.agent._beginCompletionInvariant(17);
    const result = await dispatch(f);
    assert.equal(result.success, true); assert.equal(result.name, 'Cancel');
    assert.equal(result.nativeInputAcknowledged, true);
    rememberCommit(f, result); await readCommit(f);
    assert.equal(f.agent._completionSubmitStates.has(17), false);
    assert.equal(commitEvidence(f).verifiedFinalSubmit, false);
  });

  for (const [label, mutate] of [
    ['current target label changed', () => page.evaluate(() => commit.textContent = 'Cancel')],
    ['current ref replaced', () => page.evaluate(() => commit.replaceWith(commit.cloneNode(true)))],
    ['current document route changed', () => page.evaluate(() => history.pushState({}, '', '/foreign'))],
    ['current task steering', f => { f.agent._hasPendingSteering = () => true; }],
    ['trusted user input changed the private draft', () => page.locator('main input').fill('Human revised draft')],
  ]) await nativeT.test(`native commit metadata: ${label} cannot arm completion`, async () => {
    const f = await fixture({ label: 'Publish' }); f.agent._beginCompletionInvariant(17);
    await mutate(f); const result = await dispatch(f);
    assert.equal(result.success, false); assert.equal(result.noDispatch, true);
    assert.equal(result.name, undefined); assert.notEqual(result.nativeInputAcknowledged, true);
    rememberCommit(f, result);
    assert.equal(f.agent._completionSubmitStates.has(17), false);
    assert.equal(commitEvidence(f).verifiedFinalSubmit, false);
    assert.deepEqual((await facts()).clicks, []);
  });

  await nativeT.test('native commit metadata: lost release acknowledgement cannot arm completion', async () => {
    const f = await fixture({ label: 'Publish' }); f.agent._beginCompletionInvariant(17);
    commandHook = (method, params) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') throw new Error('neutral lost release acknowledgement'); };
    const result = await dispatch(f);
    assert.equal(result.success, false); assert.equal(result.outcomeUnknown, true);
    assert.equal(result.nativeInputAcknowledged, false); assert.equal(result.name, undefined);
    rememberCommit(f, result);
    assert.equal(f.agent._completionSubmitStates.has(17), false);
    assert.equal(commitEvidence(f).verifiedFinalSubmit, false);
  });

  await nativeT.test('native commit metadata: page-owned focus preserves delivery without certifying a remote commit', async () => {
    const f = await fixture({ label: 'Publish', noCommit: true, preparationScript: "commit.addEventListener('click',event=>{if(event.isTrusted)setTimeout(()=>document.querySelector('main input').focus(),50);});" });
    f.agent._beginCompletionInvariant(17);
    const result = await dispatch(f);
    assert.equal(result.success, true); assert.equal(result.nativeInputAcknowledged, true);
    assert.equal(result.observationInterrupted, false); assert.equal(result.trusted, true);
    assert.equal(result.name, 'Publish');
    rememberCommit(f, result);
    assert.equal(f.agent._completionSubmitStates.has(17), true, 'Delivery receipt is distinct from saved-state evidence.');
    assert.equal(commitEvidence(f).verifiedFinalSubmit, false);
    const beforeRepeat = commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length;
    await dispatch(f);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, beforeRepeat);
  });

  await nativeT.test('native commit metadata: new completion run cannot reuse an earlier submit and confirmation', async () => {
    const f = await fixture({ label: 'Publish', preparationScript: "commit.addEventListener('click',event=>{if(event.isTrusted){const e=document.createElement('div');e.setAttribute('role','status');e.textContent='Changes published';commit.closest('main').append(e);}});" });
    f.agent._beginCompletionInvariant(17); const result = await dispatch(f);
    assert.equal(result.name, 'Publish'); rememberCommit(f, result); await readCommit(f);
    assert.equal(commitEvidence(f).verifiedFinalSubmit, true);
    f.agent._beginCompletionInvariant(17); await readCommit(f);
    assert.equal(f.agent._completionSubmitStates.has(17), false);
    assert.equal(commitEvidence(f).verifiedFinalSubmit, false);
  });


  // Hover/focus decoration is not an action-context identity change. Hidden
  // targets and all semantic, owner and exact hit-test changes remain fenced.
  for (const [name, options] of [
    ['hover opacity remains visible', { preparationCss: 'button:hover{opacity:.95}' }],
    ['focus opacity remains visible', { preparationCss: 'button:focus{opacity:.95}' }],
    ['hover owner opacity remains visible', { preparationCss: 'main:has(button:hover){opacity:.95}' }],
    ['focus owner opacity remains visible', { preparationCss: 'main:has(button:focus){opacity:.95}' }],
    ['hover class changes only decoration', { preparationCss: '.hovered{background:rgb(100,200,100)}', preparationScript: "commit.addEventListener('pointerenter',()=>commit.classList.add('hovered'));" }],
  ]) await nativeT.test(`native preparation tolerates ${name}`, async () => {
    const f = await fixture(options);
    const result = await dispatch(f);
    assert.equal(result.initialTrustedNativeButton, true);
    assert.equal(result.trusted, true, JSON.stringify(result));
    assert.equal((await facts()).commits, 1);
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
    assert.equal(commands.filter(command => command.method === 'Input.dispatchMouseEvent' && command.type === 'mousePressed').length, 1);
    assert.equal(commands.filter(command => command.method === 'Input.dispatchMouseEvent' && command.type === 'mouseReleased').length, 1);
  });
  for (const [name, options] of [
    ['hover hides the target', { preparationCss: 'button:hover{opacity:0}' }],
    ['focus hides the owner', { preparationCss: 'main:has(button:focus){opacity:0}' }],
    ['hover moves the target', { preparationCss: 'button:hover{transform:translateX(80px)}' }],
    ['hover changes the target label', { preparationScript: "commit.addEventListener('pointerenter',()=>commit.textContent='Other action');" }],
    ['hover disables the target', { preparationScript: "commit.addEventListener('pointerenter',()=>commit.disabled=true);" }],
    ['hover changes the owner heading', { preparationScript: "commit.addEventListener('pointerenter',()=>commit.closest('main').querySelector('h1').textContent='Other record');" }],
    ['hover changes private draft state', { preparationScript: "commit.addEventListener('pointerenter',()=>commit.closest('main').querySelector('input').value='Replacement draft');" }],
  ]) await nativeT.test(`native preparation rejects ${name}`, async () => {
    const f = await fixture(options);
    const result = await dispatch(f);
    assert.equal(result.noDispatch, true, JSON.stringify(result));
    assert.notEqual(result.outcomeUnknown, true);
    assert.deepEqual((await facts()).clicks, []);
    assert.equal(commands.filter(command => command.method === 'Input.dispatchMouseEvent' && command.type === 'mousePressed').length, 0);
  });

  await nativeT.test('the same consumed model certificate cannot automatically click its native button again', async () => {
    const f = await fixture();
    await dispatch(f);
    const again = await dispatch(f);
    assert.equal(again.noDispatch, true);
    assert.equal((await facts()).commits, 1);
  });

  for (const [name, mutate] of [
    ['disabled native target', () => page.evaluate(() => commit.disabled = true)],
    ['material target label change', () => page.evaluate(() => commit.textContent = 'Other action')],
    ['document route change', () => page.evaluate(() => history.pushState({}, '', '/other'))],
    ['native target replacement', () => page.evaluate(() => commit.replaceWith(commit.cloneNode(true)))],
    ['intercepting DOM overlay', () => page.evaluate(() => { const r=commit.getBoundingClientRect();const e=document.createElement('div');e.style.cssText=`position:fixed;z-index:999;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`;document.body.append(e); })],
  ]) await nativeT.test(`trusted preparation refuses ${name} without any click`, async () => {
    const f = await fixture(); await mutate();
    const result = await dispatch(f);
    assert.equal(result.success, false);
    assert.equal(result.noDispatch, true);
    assert.deepEqual((await facts()).clicks, []);
  });

  await nativeT.test('Stop while attaching cannot fall through to a synthetic click', async () => {
    const f = await fixture();
    const attach = cdpClient.attach;
    cdpClient.attach = async () => { f.agent._runningTabs.delete(17); await f.agent._endPageFeedbackRun(17); };
    try {
      const result = await dispatch(f);
      assert.equal(result.noDispatch, true);
      assert.deepEqual((await facts()).clicks, []);
    } finally { cdpClient.attach = attach; }
  });

  await nativeT.test('a lost press acknowledgement cannot cause synthetic fallback or another native click', async () => {
    const f = await fixture();
    commandHook = (method, params) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') throw new Error('neutral lost acknowledgement'); };
    const result = await dispatch(f);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    commandHook = null;
    await freshObservation(f);
    const again = await dispatch(f);
    assert.equal(again.noDispatch, true);
    assert.deepEqual((await facts()).clicks, []);
  });

  await nativeT.test('a native button with a noninteractive descendant keeps exact-target trusted dispatch', async () => {
    const f = await fixture({ nested: true });
    const result = await dispatch(f);
    assert.equal((await facts()).commits, 1, JSON.stringify(result));
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
  });

  await nativeT.test('missing private recipient authorization is still known noDispatch', async () => {
    const f = await fixture();
    const result = await dispatch(f, null, null,
      { messageRecipientGuardRequired: true, messageRecipientDispatchBinding: null });
    assert.equal(result.success, false);
    assert.equal(result.noDispatch, true);
    assert.deepEqual((await facts()).clicks, []);
  });

  await nativeT.test('an uncertified legacy call does not acquire trusted authority from a native tag', async () => {
    const f = await fixture();
    delete f.run.dispatchCall.expectedModelSnapshot;
    // Test the deliberately uncertified legacy primitive. The ordinary wrapper
    // would correctly renew its still-current model observation certificate.
    const result = await f.agent._dispatchClickAxImpl(17, { ref_id: f.ref }, f.scope, null, {}, null, null, f.dispatchState);
    assert.notEqual(result.initialTrustedNativeButton, true);
    assert.equal((await facts()).commits, 0);
    assert.deepEqual((await facts()).clicks, [{ trusted: false, active: true }]);
  });

  await nativeT.test('trusted setup failure returns without a synthetic click', async () => {
    const f = await fixture();
    const original = cdpClient.armFileInputClickGuard;
    cdpClient.armFileInputClickGuard = async () => { throw new Error('neutral setup unavailable'); };
    try {
      const result = await dispatch(f);
      assert.equal(result.noDispatch, true);
      assert.equal(result.outcomeUnknown, false);
      assert.deepEqual((await facts()).clicks, []);
    } finally { cdpClient.armFileInputClickGuard = original; }
  });

  await nativeT.test('a changed accepted steering revision before the press cancels native input', async () => {
    const f = await fixture();
    commandHook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        f.agent._steeringRuns.set(17, { acceptedIds: new Set(['new-user-revision']), messages: [] });
      }
    };
    const result = await dispatch(f);
    assert.equal(result.noDispatch, true);
    assert.deepEqual((await facts()).clicks, []);
  });

  await nativeT.test('native user input during preparation keeps the current-owner dispatch fence', async () => {
    const f = await fixture();
    commandHook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        await page.locator('input').fill('User replacement');
      }
    };
    const result = await dispatch(f);
    assert.equal(result.noDispatch, true);
    assert.deepEqual((await facts()).clicks, []);
  });

  await nativeT.test('a lost release acknowledgement after one real click cannot replay it', async () => {
    const f = await fixture();
    commandHook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && params.clickCount === 1) {
        await session.send(method, params);
        throw new Error('neutral release acknowledgement lost');
      }
    };
    const result = await dispatch(f);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    assert.equal((await facts()).commits, 1);
    commandHook = null;
    await freshObservation(f);
    const again = await dispatch(f);
    assert.equal(again.noDispatch, true);
    assert.equal((await facts()).commits, 1);
  });


  await nativeT.test('a button that opens a file chooser keeps the existing blocking guard and is never replayed', async () => {
    const f = await fixture({ filePicker: true });
    let choosers = 0;
    page.on('filechooser', () => choosers++);
    const result = await dispatch(f);
    assert.equal(result.filePickerBlocked, true, JSON.stringify(result));
    assert.equal(result.initialTrustedNativeButton, true);
    assert.equal(choosers, 0);
    assert.equal((await facts()).clicks.length, 1);
    const again = await dispatch(f);
    assert.equal(again.noDispatch, true);
    assert.equal((await facts()).clicks.length, 1);
  });

  await nativeT.test('a deadline after an attempted real press remains uncertain and cannot replay', async () => {
    const f = await fixture();
    const abort = new AbortController();
    commandHook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        await session.send(method, params);
        abort.abort(new Error('neutral deadline after press'));
        throw new Error('neutral deadline after press');
      }
    };
    const result = await dispatch(f, null, abort.signal);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    commandHook = null;
    await freshObservation(f);
    const again = await dispatch(f);
    assert.equal(again.noDispatch, true);
    assert.equal((await facts()).commits, 0);
  });


    await nativeT.test('a verified action and fresh certificate authorize a second click on the same stable native button', async () => {
      const f = await fixture();
      const first = await dispatch(f);
      assert.equal(first.verified, true);
      assert.equal((await facts()).commits, 1);
      await freshObservation(f);
      const second = await dispatch(f);
      assert.equal(second.verified, true, JSON.stringify(second));
      assert.equal((await facts()).commits, 2);
      assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }, { trusted: true, active: true }]);
    });
    await nativeT.test('an acknowledged no-op stays unverified and requires a new certificate for a new explicit action', async () => {
      const f = await fixture({ noCommit: true });
      const first = await dispatch(f);
      assert.equal(first.verified, false);
      assert.equal(first.inconclusive, true);
      const duplicate = await dispatch(f);
      assert.equal(duplicate.noDispatch, true);
      await freshObservation(f);
      const second = await dispatch(f);
      assert.equal(second.initialTrustedNativeButton, true);
      assert.equal(second.verified, false);
      assert.equal(second.inconclusive, true);
      assert.equal((await facts()).clicks.length, 2);
      assert.equal((await facts()).commits, 0);
    });

    await nativeT.test('bounded per-run certificate bookkeeping refuses before any native click', async () => {
      const f = await fixture();
      f.agent._clickAxCdpFallbacks.set(17, new Set(Array.from({ length: 4096 }, (_, i) => `existing:${i}`)));
      const result = await dispatch(f);
      assert.equal(result.noDispatch, true);
      assert.equal((await facts()).clicks.length, 0);
      assert.equal(commands.some(c => c.method === 'Input.dispatchMouseEvent'), false);
    });

    await nativeT.test('Add two rows keeps one unchanged BUTTON and permits two fresh acknowledged actions without business-save proof', async () => {
      const f = await fixture({ label: 'Add row', weakEffect: true });
      const buttonBefore = await page.locator('#commit').evaluate(el => ({ label: el.textContent, attrs: ['id', 'type', 'role', 'aria-label', 'aria-pressed', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-current', 'disabled'].map(name => [name, el.getAttribute(name)]) }));
      const first = await dispatch(f);
      assert.equal(first.trusted, true);
      assert.equal(first.verified, false, 'Associated DOM changes remain weak local evidence.');
      assert.equal(await page.locator('[data-owned-neutral-row]').count(), 1);
      await freshObservation(f);
      const second = await dispatch(f);
      assert.equal(second.trusted, true, JSON.stringify(second));
      assert.equal(second.verified, false, 'A second acknowledged click is not business-save verification.');
      assert.equal(await page.locator('[data-owned-neutral-row]').count(), 2);
      assert.deepEqual(await page.locator('#commit').evaluate(el => ({ label: el.textContent, attrs: ['id', 'type', 'role', 'aria-label', 'aria-pressed', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-current', 'disabled'].map(name => [name, el.getAttribute(name)]) })), buttonBefore);
      assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }, { trusted: true, active: true }]);
    });


  for (const label of ['Change', 'Done']) for (const placement of ['outside', 'nested']) {
    await nativeT.test(`redundant plain descriptions retain the first trusted ${label} press (${placement})`, async () => {
      const script = `commit.setAttribute('aria-label', ${JSON.stringify(label)});commit.addEventListener('mouseover',()=>{
        if(document.getElementById('owned-transient-description'))return;
        const host=document.createElement('x-tooltip-placeholder');host.id='owned-transient-description';
        host.style.cssText='position:fixed;left:600px;top:30px;display:block;pointer-events:none';
        host.append(document.createTextNode(String.fromCharCode(32,10,32,32,32)));
        const inner=document.createElement('div');host.append(inner);
        ${placement === 'nested' ? 'commit.append(host);' : 'commit.closest("main").append(host);'}
        commit.setAttribute('aria-describedby',host.id);
        queueMicrotask(()=>{const span=document.createElement('span');span.textContent=commit.getAttribute('aria-label');inner.append(span);});
      });`;
      const f = await fixture({ label, preparationScript: script });
      const timing = { trustedInputEvents: 0 }, result = await dispatch(f, timing);
      assert.equal(result.initialTrustedNativeButton, true, JSON.stringify({ result, timing }));
      assert.equal(result.trusted, true); assert.equal(timing.trustedInputEvents, 3);
      assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
      assert.equal((await facts()).commits, 1);
      assert.deepEqual(commands.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.type),
        ['mouseMoved', 'mousePressed', 'mouseReleased']);
      assert.deepEqual(await page.evaluate(() => {
        const host = document.getElementById('owned-transient-description');
        return { shadow: !!host.shadowRoot, controls: host.querySelectorAll('button,input,a').length,
          trimmedMatches: host.textContent.trim() === commit.getAttribute('aria-label') };
      }), { shadow: false, controls: 0, trimmedMatches: true });
    });
  }

  for (const placement of ['outside', 'nested']) await nativeT.test(`typed plain descriptors retain one current native press (${placement})`, async () => {
    const label = placement === 'outside' ? 'Change' : 'Done';
    const script = `commit.setAttribute('aria-label', ${JSON.stringify(label)});commit.addEventListener('mouseover',()=>{
      if(document.getElementById('owned-typed-description'))return;
      const host=document.createElement('x-tooltip-placeholder');host.id='owned-typed-description';
      host.setAttribute('type',${JSON.stringify(placement === 'outside' ? 'truncation' : 'decoration-layout')});host.setAttribute('unified','');
      host.style.cssText='position:fixed;left:600px;top:30px;display:block;pointer-events:none';
      host.append(document.createTextNode(String.fromCharCode(32,10,32,32,32)));
      const inner=document.createElement('div');inner.hidden=true;host.append(inner);
      ${placement === 'nested' ? 'commit.append(host);' : 'document.body.append(host);'}
      commit.setAttribute('aria-describedby',host.id);
      queueMicrotask(()=>{const span=document.createElement('span');span.textContent=commit.getAttribute('aria-label');inner.append(span);});
    });`;
    const f = await fixture({ label, preparationScript: script });
    const timing = { trustedInputEvents: 0 }, result = await dispatch(f, timing);
    assert.equal(result.initialTrustedNativeButton, true, JSON.stringify({ result, timing }));
    assert.equal(result.trusted, true); assert.equal(timing.trustedInputEvents, 3);
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
    assert.equal((await facts()).commits, 1);
    assert.deepEqual(commands.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.deepEqual(await page.evaluate(() => {
      const host = document.getElementById('owned-typed-description');
      return { type: host.getAttribute('type'), shadow: !!host.shadowRoot,
        controls: host.querySelectorAll('button,input,a').length, trimmedMatches: host.textContent.trim() === commit.getAttribute('aria-label') };
    }), { type: placement === 'outside' ? 'truncation' : 'decoration-layout', shadow: false, controls: 0, trimmedMatches: true });
  });


  for (const label of ['Change', 'Done']) await nativeT.test(`a unique native-button wrapper keeps the first trusted ${label} press after duplicate hover description`, async () => {
    const script = `commit.setAttribute('aria-label',${JSON.stringify(label)});
      const wrapper=document.createElement('x-owned-button-wrapper');wrapper.id='owned-wrapper';
      wrapper.setAttribute('tabindex','-1');wrapper.setAttribute('type','neutral-action');wrapper.setAttribute('aria-disabled','false');
      wrapper.style.display='inline-block';commit.before(wrapper);
      const shape=document.createElement('x-owned-button-shape'),inner=document.createElement('div');wrapper.append(shape);shape.append(inner);inner.append(commit);
      commit.addEventListener('mouseover',()=>{
        if(document.getElementById('owned-wrapper-description'))return;
        const descriptor=document.createElement('x-owned-tooltip');descriptor.id='owned-wrapper-description';descriptor.setAttribute('type','truncation');
        descriptor.style.cssText='position:fixed;left:600px;top:30px;pointer-events:none';
        descriptor.append(document.createTextNode(String.fromCharCode(32,10,32,32,32)));
        const content=document.createElement('div');content.hidden=true;descriptor.append(content);document.body.append(descriptor);
        commit.setAttribute('aria-describedby',descriptor.id);wrapper.setAttribute('aria-describedby',descriptor.id);
        queueMicrotask(()=>{const span=document.createElement('span');span.textContent=commit.getAttribute('aria-label');content.append(span);});
      });`;
    const f = await fixture({ label, preparationScript: script });
    const timing = { trustedInputEvents: 0 }, result = await dispatch(f, timing);
    assert.equal(result.initialTrustedNativeButton, true, JSON.stringify({ result, timing }));
    assert.equal(result.trusted, true); assert.equal(timing.trustedInputEvents, 3);
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]); assert.equal((await facts()).commits, 1);
    assert.deepEqual(commands.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.deepEqual(await page.locator('#owned-wrapper').evaluate(el => ({ type: el.getAttribute('type'), tabIndex: el.tabIndex,
      disabled: el.getAttribute('aria-disabled'), sameRef: el.getAttribute('aria-describedby') === el.querySelector('button').getAttribute('aria-describedby') })),
      { type: 'neutral-action', tabIndex: -1, disabled: 'false', sameRef: true });
  });

  for (const cause of ['private_binding', 'owner_pending']) await nativeT.test(`prepress diagnostics distinguish ${cause} after one acknowledged pointer move`, async () => {
    const f = await fixture();
    const originalMessage = chrome.tabs.sendMessage;
    const originalPending = f.agent._pageFeedbackBlocksCall;
    let changed = false;
    chrome.tabs.sendMessage = async (...params) => {
      const result = await originalMessage(...params);
      const message = params[1];
      if (!changed && message.action === 'click_ax' && message.params?._requireTrustedNativeButton === true
          && result?.trustedButtonRequired === true) {
        changed = true;
        if (cause === 'private_binding') await page.evaluate(() => commit.closest('main').querySelector('input').value = 'PRIVATE_DIAGNOSTIC_DRAFT');
        else f.agent._pageFeedbackBlocksCall = () => true;
      }
      return result;
    };
    const timing = { trustedInputEvents: 0 };
    try {
      const result = await dispatch(f, timing);
      assert.equal(result.success, false); assert.equal(result.noDispatch, true); assert.equal(result.outcomeUnknown, false);
      assert.equal(timing.trustedInputEvents, 1, 'Only the preparatory pointer move was acknowledged.');
      assert.deepEqual(commands.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.type), ['mouseMoved']);
      assert.equal((await facts()).clicks.length, 0);
      assert.equal(timing.preparationVeto.stage, 'after_pointer_before_press');
      assert.equal(timing.preparationVeto.pageFeedbackPending, true);
      if (cause === 'private_binding') {
        assert.equal(timing.preparationVeto.monitorRejected, true);
        assert.ok(['monitor_rejected', 'owner_pending_after'].includes(timing.preparationVeto.cause));
        assert.equal(timing.preparationVeto.modelBindingInvalid, true);
        assert.equal(timing.preparationVeto.layoutChanged, false);
      } else assert.equal(timing.preparationVeto.cause, 'owner_pending_before');
      const { projectTraceEventData } = await import('../src/chrome/src/trace/privacy.js');
      const extra = { context: { nativeButtonPreparation: timing.preparationVeto } };
      assert.deepEqual(projectTraceEventData('note', { note: 'click_ax_preparation_veto', extra }).extra.context, extra.context);
      assert.doesNotMatch(JSON.stringify(extra), /PRIVATE|ref_|https?:|owned-neutral-document/);
    } finally { chrome.tabs.sendMessage = originalMessage; f.agent._pageFeedbackBlocksCall = originalPending; }
  });

  await nativeT.test('observeOnly flags cannot authorize click_ax after private context changes', async () => {
    const f = await fixture({ noCommit: true });
    await page.evaluate(() => { commit.closest('main').querySelector('input').value = 'Replacement draft'; });
    const result = await chrome.tabs.sendMessage(17, { target: 'content', action: 'click_ax',
      params: { ref_id: f.ref, forClickFallback: true, observeOnly: true } });
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.pageFeedbackPending, true, JSON.stringify(result));
    assert.deepEqual((await facts()).clicks, []);
    assert.equal((await facts()).commits, 0);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
  });

  await nativeT.test('observeOnly target resolution leaves viewport and working-indicator DOM untouched', async () => {
    const f = await fixture({ noCommit: true });
    f.agent._finishPageFeedbackRun(17);
    await page.waitForFunction(() => !window.__wbPageMonitor.active);
    await page.evaluate(() => {
      commit.closest('main').style.paddingTop = '1200px';
      window.scrollTo(0, 0); window.qaWorkingIndicatorCalls = 0;
      window.__webbrainAgentIndicator = { showTarget() {
        qaWorkingIndicatorCalls++;
        const marker = document.createElement('i'); marker.dataset.neutralWorkingMarker = '';
        document.body.append(marker);
      } };
    });
    const before = await page.evaluate(() => ({ scrollX, scrollY,
      indicators: document.querySelectorAll('[data-neutral-working-marker]').length, calls: qaWorkingIndicatorCalls }));
    const result = await chrome.tabs.sendMessage(17, { target: 'content', action: 'ax_resolve_rect',
      params: { ref_id: f.ref, forClickFallback: true, observeOnly: true } });
    const after = await page.evaluate(() => ({ scrollX, scrollY,
      indicators: document.querySelectorAll('[data-neutral-working-marker]').length, calls: qaWorkingIndicatorCalls }));
    assert.equal(result.success, true); assert.equal(result.ref_id, f.ref);
    assert.deepEqual(after, before, 'An observation must not scroll or add working-indicator DOM.');
    assert.equal(result.inViewport, false);
    assert.equal(result.documentToken, f.scope.documentToken); assert.equal(result.refScopeUrl, f.scope.pageUrl);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
  });

  for (const restoration of ['none', 'same-turn', 'next-turn']) await nativeT.test(
    `post-ACK modal restoration: closes the modal with ${restoration} focus restoration`, async () => {
      const restoreFocus = restoration !== 'none';
      const script = `
        window.qaModalClosed=false;window.qaRestoredFocus=false;
        const originalOwner=commit.closest('main'), restoreOwner=originalOwner.querySelector('input');
        const modal=document.createElement('div');window.qaClosedModal=modal;modal.setAttribute('role','dialog');
        modal.setAttribute('aria-label','Edit current record settings');
        modal.innerHTML='<h2>Current record settings</h2>';originalOwner.append(modal);
        modal.append(commit);commit.textContent='Done';commit.setAttribute('aria-label','Done');
        commit.addEventListener('click',event=>{
          if(!event.isTrusted)return;
          modal.remove();qaModalClosed=true;
          ${restoration === 'next-turn' ? 'setTimeout(()=>{restoreOwner.focus({preventScroll:true});qaRestoredFocus=document.activeElement===restoreOwner;},50);' : restoreFocus ? 'restoreOwner.focus({preventScroll:true});qaRestoredFocus=document.activeElement===restoreOwner;' : ''}
        });`;
      const f = await fixture({ noCommit: true, preparationScript: script });
      const timing = { trustedInputEvents: 0 };
      const result = await dispatch(f, timing);
      await page.waitForTimeout(180);
      const observed = await page.evaluate(() => ({ modalClosed: qaModalClosed,
        restoredFocus: qaRestoredFocus, dialogs: document.querySelectorAll('[role=dialog]').length,
        valuePreserved: document.querySelector('main input').value === 'Owned neutral draft' }));
      const feedback = [...f.run.events.values()].map(({kind,source,frameId}) => ({kind,source,frameId}));
      console.log('MODAL_RESTORATION_DIAGNOSTIC ' + JSON.stringify({restoration, observed,
        flags: Object.fromEntries(['success','dispatched','trusted','verified','outcomeUnknown','noDispatch','retryable','nativeInputAcknowledged','observationInterrupted']
          .filter(key=>key in result).map(key=>[key,result[key]])),
        error: result.error || '', timing, feedback}));
      assert.equal(observed.modalClosed, true);
      assert.equal(observed.dialogs, 0);
      assert.equal(observed.restoredFocus, restoreFocus);
      assert.equal(observed.valuePreserved, true);
      assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
      assert.equal((await facts()).commits, 0, 'Closing a local modal does not prove a remote save.');
      assert.equal(timing.trustedInputEvents, 3, 'The complete move/press/release acknowledgements must be recorded.');
      assert.deepEqual(commands.filter(call=>call.method==='Input.dispatchMouseEvent').map(call=>call.type),
        ['mouseMoved','mousePressed','mouseReleased']);
      assert.equal(result.dispatched, true);
      assert.equal(result.nativeInputAcknowledged, true, 'Completed protocol acknowledgements must survive effect-observation failure.');
      assert.equal(result.observationInterrupted, false, 'Read-only effect inspection permits page-owned focus restoration.');
      assert.equal(result.success, true); assert.equal(result.trusted, true); assert.equal(result.verified, false);
      assert.equal(result.effectVerificationPending, true); assert.equal(result.retryable, false);
      if (restoration === 'next-turn') {
        assert.equal(result.error, undefined, 'Completed input must not be presented as a failed click.');
        assert.match(result.warning, /click was delivered/i);
        assert.ok(feedback.some(event => event.kind === 'activity' && event.source === 'page'));
        assert.equal(feedback.some(event => event.source === 'user'), false);
        await page.evaluate(() => document.querySelector('main').append(qaClosedModal));
        const beforeRepeat = commands.filter(call=>call.method==='Input.dispatchMouseEvent' && call.type==='mousePressed').length;
        const repeat = await dispatch(f);
        assert.equal(repeat.noDispatch, true); assert.notEqual(repeat.nativeInputAcknowledged, true);
        assert.equal((await facts()).clicks.length, 1);
        assert.equal(commands.filter(call=>call.method==='Input.dispatchMouseEvent' && call.type==='mousePressed').length, beforeRepeat);
      } else {
        assert.equal(result.success, true); assert.equal(result.trusted, true);
        assert.notEqual(result.outcomeUnknown, true); assert.equal(result.verified, false);
      }
    });

  await nativeT.test('a failed post-click read preserves delivered input and its pending repeat lock', async () => {
    const f = await fixture({ noCommit: true });
    const resolve = f.agent._resolveClickAxFallbackTarget;
    f.agent._resolveClickAxFallbackTarget = function(tab, ref, signal, options) {
      if (options?.observeOnly) throw new Error('Fixture read response unavailable');
      return resolve.call(this, tab, ref, signal, options);
    };
    const result = await dispatch(f);
    assert.equal(result.success, true); assert.equal(result.trusted, true);
    assert.equal(result.dispatched, true); assert.equal(result.nativeInputAcknowledged, true);
    assert.equal(result.verified, false); assert.equal(result.effectVerificationPending, true);
    assert.equal(result.observationInterrupted, true); assert.equal(result.retryable, false);
    assert.equal(result.error, undefined); assert.match(result.warning, /click was delivered/i);
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
    f.agent._resolveClickAxFallbackTarget = resolve;
    await freshObservation(f);
    const commandsBefore = commands.filter(call => call.method === 'Input.dispatchMouseEvent').length;
    const repeat = await dispatch(f);
    assert.equal(repeat.noDispatch, true);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent').length, commandsBefore,
      'A new observation cannot replay unresolved delivered input.');
    assert.equal((await facts()).clicks.length, 1);
  });

  await nativeT.test('native ACK metadata stays false when the real release acknowledgement is lost', async () => {
    const f = await fixture({ noCommit: true });
    const timing = { trustedInputEvents: 0 };
    commandHook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && params.clickCount === 1) {
        await session.send(method, params);
        throw new Error('neutral real release acknowledgement lost');
      }
    };
    const result = await dispatch(f, timing);
    commandHook = null;
    assert.equal((await facts()).clicks.length, 1); assert.equal((await facts()).clicks[0].trusted, true);
    assert.equal(result.nativeInputAcknowledged, false); assert.equal(result.observationInterrupted, false);
    assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false); assert.equal(result.verified, false);
    assert.equal(timing.preparationVeto.stage, 'release');
    await freshObservation(f);
    const before = commands.filter(call=>call.method==='Input.dispatchMouseEvent' && call.type==='mousePressed').length;
    const repeat = await dispatch(f);
    assert.equal(repeat.noDispatch, true); assert.equal(repeat.nativeInputAcknowledged, false);
    assert.equal(commands.filter(call=>call.method==='Input.dispatchMouseEvent' && call.type==='mousePressed').length, before);
  });

  await nativeT.test('fully acknowledged input aborted before chooser inspection is not an observation interruption', async () => {
    const f = await fixture({ noCommit: true });
    const send = chrome.debugger.sendCommand, consume = cdpClient.consumeFileInputClickGuard;
    const abort = new AbortController();
    f.agent._runAbortStates.set(17, { controller: abort });
    let consumed = 0;
    chrome.debugger.sendCommand = (target, method, params, callback) => send(target, method, params, value => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') f.agent.abort(17);
      callback(value);
    });
    cdpClient.consumeFileInputClickGuard = async (...args) => { consumed++; return consume.apply(cdpClient, args); };
    try {
      const timing = { trustedInputEvents: 0 };
      const result = await dispatch(f, timing);
      assert.equal(timing.trustedInputEvents, 3); assert.equal((await facts()).clicks.length, 1);
      assert.equal(consumed, 0);
      assert.equal(result.nativeInputAcknowledged, true); assert.equal(result.observationInterrupted, false);
      assert.equal(result.success, false); assert.equal(result.verified, false);
      assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false);
      assert.equal(timing.preparationVeto.stage, 'release');
      assert.equal(commands.filter(call=>call.method==='Input.dispatchMouseEvent' && call.type==='mousePressed').length, 1);
    } finally { chrome.debugger.sendCommand = send; cdpClient.consumeFileInputClickGuard = consume; }
  });

  for (const interruption of ['user pointer', 'user input', 'navigation', 'steering', 'Stop'])
    await nativeT.test(`post-ACK ${interruption} retains failure, uncertain effect and the repeat lock`, async () => {
      const f = await fixture({ noCommit: true });
      const timing = { trustedInputEvents: 0 };
      let interrupted;
      commandHook = (method, params) => {
        if (method !== 'Input.dispatchMouseEvent' || params.type !== 'mouseReleased') return;
        interrupted = new Promise((resolve,reject) => setTimeout(async () => {
          try {
            const before = await facts();
            if (interruption === 'user pointer') await page.locator('input').click();
            else if (interruption === 'user input') await page.locator('input').fill('Actual user replacement');
            else if (interruption === 'navigation') await page.goto('https://neutral-native-button.invalid/replacement');
            else if (interruption === 'steering') f.agent._steeringRuns.set(17,
              { acceptedIds: new Set(['accepted-neutral-revision']), messages: [{ id: 'accepted-neutral-revision', text: 'New current task' }], revision: 1 });
            else f.agent.abort(17);
            resolve(before);
          } catch (error) { reject(error); }
        },50));
      };
      const result = await dispatch(f, timing);
      const beforeInterruption = await interrupted;
      commandHook = null;
      assert.deepEqual(beforeInterruption.clicks, [{ trusted: true, active: true }]);
      assert.equal(timing.trustedInputEvents, 3);
      assert.equal(result.nativeInputAcknowledged, true); assert.equal(result.observationInterrupted, true);
      assert.equal(result.success, false); assert.equal(result.trusted, false); assert.equal(result.verified, false);
      assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false);
      assert.equal(timing.preparationVeto.stage, 'observation');
      assert.match(result.error, /Observation interrupted after native input acknowledgements completed/);
      assert.equal(commands.filter(call=>call.method==='Input.dispatchMouseEvent' && call.type==='mousePressed').length, 1);
      if (interruption.startsWith('user')) assert.ok([...f.run.events.values()].some(event=>event.source==='user'));
      const before = commands.filter(call=>call.method==='Input.dispatchMouseEvent').length;
      const repeat = await dispatch(f);
      assert.equal(repeat.success, false); assert.equal(repeat.noDispatch, true);
      assert.equal(commands.filter(call=>call.method==='Input.dispatchMouseEvent').length, before);
    });

  for (const effect of ['aria-pressed', 'disabled', null]) await nativeT.test(
    `post-ACK network settling: ${effect ? `the exact native target changes ${effect} asynchronously` : 'network alone is not effect proof'}`, async () => {
      const delayedTargetState = effect !== null;
      const script = `window.qaMutationRequested=false;window.qaMutationResponse=false;window.qaDelayedTargetState=false;
        commit.addEventListener('click',event=>{
          if(!event.isTrusted)return;
          qaMutationRequested=true;
          fetch('/api/mutate',{method:'POST'}).then(()=>qaMutationResponse=true);
          ${effect ? `setTimeout(()=>{${effect === 'disabled' ? 'commit.disabled=true;' : 'commit.setAttribute("aria-pressed","true");'}qaDelayedTargetState=true;},1000);` : ""}
        });`;
      const f = await fixture({ noCommit: true, preparationScript: script });
      const timing = { trustedInputEvents: 0 };
      const send = chrome.tabs.sendMessage;
      // A bounded transport delay exposes queued monitor feedback after the real
      // target changes. It sends no input and changes no production timeout.
      chrome.tabs.sendMessage = async (...params) => {
        const result = await send(...params);
        if (effect === 'aria-pressed' && params[1]?.action === 'ax_resolve_rect'
            && params[1]?.params?.observeOnly === true) await new Promise(resolve => setTimeout(resolve, 225));
        return result;
      };
      let result;
      try { result = await dispatch(f, timing); }
      finally { chrome.tabs.sendMessage = send; }
      await page.waitForFunction(() => qaMutationRequested && qaMutationResponse);
      if (delayedTargetState) await page.waitForFunction(() => qaDelayedTargetState);
      assert.equal(result.success, true); assert.equal(result.trusted, true); assert.equal(result.dispatched, true);
      assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
      assert.equal((await facts()).commits, 0, 'A local disabled state is not remote business success.');
      assert.deepEqual(commands.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.type),
        ['mouseMoved', 'mousePressed', 'mouseReleased'], 'Read-only settling must never send another click.');
      assert.equal(await page.locator('#commit').isDisabled(), effect === 'disabled');
      assert.equal(await page.locator('#commit').getAttribute('aria-pressed'), effect === 'aria-pressed' ? 'true' : null);
      assert.equal(result.verified, delayedTargetState,
        'An early mutation request must neither hide a later exact-target strong state nor certify network activity alone.');
      if (delayedTargetState) assert.ok(result.observedEffects.includes('target_state'));
      else assert.equal(result.inconclusive, true);
      assert.equal(timing.nativeButtonObservation.baselineSnapshotAvailable, true);
      assert.equal(timing.nativeButtonObservation.afterSnapshotAvailable, true);
      assert.equal(timing.nativeButtonObservation.observable, true);
    });

  await nativeT.test('queued unknown DOM before post-ACK input completion retains uncertainty and forbids replay', async () => {
    const f = await fixture({ noCommit: true });
    const consume = cdpClient.consumeFileInputClickGuard;
    let unrelatedMutationDelivered = false;
    cdpClient.consumeFileInputClickGuard = async (...params) => {
      const result = await consume.apply(cdpClient, params);
      await page.evaluate(() => {
        const row = document.createElement('div'); row.textContent = 'Unrelated current record changed';
        document.querySelector('main').append(row);
      });
      await page.waitForTimeout(180);
      unrelatedMutationDelivered = [...f.run.events.values()].some(event => event.kind === 'dom' && event.source === 'unknown');
      return result;
    };
    const timing = { trustedInputEvents: 0 };
    let result;
    try { result = await dispatch(f, timing); }
    finally { cdpClient.consumeFileInputClickGuard = consume; }
    assert.equal(unrelatedMutationDelivered, true, 'The unknown mutation must already be queued before input completion.');
    assert.equal(result.success, true); assert.equal(result.verified, false);
    assert.equal(result.nativeInputAcknowledged, true); assert.equal(result.effectVerificationPending, true);
    assert.equal(result.inconclusive, true);
    assert.equal(result.retryable, false); assert.equal(timing.trustedInputEvents, 3);
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
    const before = commands.filter(call => call.method === 'Input.dispatchMouseEvent').length;
    const repeat = await dispatch(f);
    assert.equal(repeat.success, false); assert.equal(repeat.noDispatch, true);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent').length, before);
    assert.equal((await facts()).clicks.length, 1);
  });

  for (const scenario of [
    { label: 'delivered trusted input with observable local effect', noCommit: false, unavailable: false },
    { label: 'delivered trusted input with observable no effect', noCommit: true, unavailable: false },
    { label: 'delivered trusted input with unavailable observation', noCommit: true, unavailable: true },
  ]) await nativeT.test(`native click observation diagnostics: ${scenario.label}`, async () => {
    const f = await fixture({ noCommit: scenario.noCommit });
    if (scenario.unavailable) f.agent._clickProgressSnapshot = async () => '';
    const timing = { trustedInputEvents: 0 };
    const result = await dispatch(f, timing);
    assert.equal(result.trusted, true); assert.equal(result.dispatched, true);
    assert.equal(result.verified, !scenario.noCommit);
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
    assert.equal((await facts()).commits, scenario.noCommit ? 0 : 1);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 1);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mouseReleased').length, 1);
    assert.equal(timing.nativeButtonObservation.baselineSnapshotAvailable, !scenario.unavailable);
    assert.equal(timing.nativeButtonObservation.afterSnapshotAvailable, !scenario.unavailable);
    assert.equal(timing.nativeButtonObservation.observable, !scenario.unavailable);
    assert.equal(timing.nativeButtonObservation.safetyVeto, false);
    if (scenario.noCommit) assert.equal(timing.nativeButtonObservation.proved, false);
    const { projectTraceEventData } = await import('../src/chrome/src/trace/privacy.js');
    const extra = { context: { nativeButtonObservation: timing.nativeButtonObservation } };
    assert.deepEqual(projectTraceEventData('note', { note: 'click_ax_observation', extra }).extra.context, extra.context);
    assert.doesNotMatch(JSON.stringify(extra), /ref_|https?:|owned-neutral-document|Apply settings|Owned neutral draft/);
  });

  // Acknowledged pointer movement completes only its exact owned operation.
  // Expire the first local preparation lease, then use real asynchronous DOM
  // feedback to distinguish passive post-ACK changes from already queued unknown.
  const pointerFixture = () => fixture({ preparationScript:
    "const side=document.createElement('aside');side.innerHTML='<span id=passiveCounter>0</span>';document.body.append(side);" });
  await nativeT.test('owned pointer completion permits a later passive counter after the local preparation expires', async () => {
    const f = await pointerFixture(), send = chrome.tabs.sendMessage;
    let preparations = 0, strictFinishes = 0, passiveDelivered = false;
    chrome.tabs.sendMessage = async (id, message, ...rest) => {
      if (message.action === 'page_monitor_finish' && message.params?.documentToken) strictFinishes++;
      if (message.action === 'click_ax' && message.params?._prepareTrustedNativeButton) {
        if (++preparations === 1) { const result = await send(id, message, ...rest); await page.waitForTimeout(230); return result; }
        await page.evaluate(() => passiveCounter.textContent = '1');
        await page.waitForTimeout(180);
        passiveDelivered = [...f.run.events.values()].some(event => event.kind === 'dom' && event.source === 'page');
      }
      return send(id, message, ...rest);
    };
    let result;
    try { result = await dispatch(f); } finally { chrome.tabs.sendMessage = send; }
    assert.equal(passiveDelivered, true, 'The real monitor must deliver a passive post-ACK mutation.');
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.trusted, true); assert.equal(result.nativeInputAcknowledged, true);
    assert.equal(strictFinishes, 2, 'Pointer and full native input have distinct acknowledged completions.');
    assert.equal((await facts()).commits, 1);
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 1);
  });

  await nativeT.test('certified pointer preparation permits an unrelated counter while its acknowledgement is held', async () => {
    const f = await pointerFixture(), send = chrome.tabs.sendMessage;
    let passiveDelivered = false, strictFinishes = 0;
    const before = await page.locator('#commit').evaluate(el => ({ tag: el.tagName, name: el.textContent, id: el.id, type: el.type, disabled: el.disabled,
      rect: JSON.stringify(el.getBoundingClientRect()), draft: el.closest('main').querySelector('input').value }));
    chrome.tabs.sendMessage = (id, message, ...rest) => {
      if (message.action === 'page_monitor_finish' && message.params?.documentToken) strictFinishes++;
      return send(id, message, ...rest);
    };
    commandHook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        await page.evaluate(() => passiveCounter.textContent = '1');
        await page.waitForTimeout(180);
        passiveDelivered = [...f.run.events.values()].some(event => event.kind === 'dom' && event.source === 'page');
        assert.deepEqual(await page.locator('#commit').evaluate(el => ({ tag: el.tagName, name: el.textContent, id: el.id, type: el.type, disabled: el.disabled,
          rect: JSON.stringify(el.getBoundingClientRect()), draft: el.closest('main').querySelector('input').value })), before,
          'The held preparation leaves the same target, physical rectangle and private draft unchanged.');
      }
    };
    let result;
    try { result = await dispatch(f); } finally { chrome.tabs.sendMessage = send; }
    console.log('QA_POINTER_PREPARATION_PHASE', JSON.stringify({ success: result.success, noDispatch: result.noDispatch,
      acknowledged: result.nativeInputAcknowledged, error: result.error,
      feedback: [...f.run.events.values()].map(event => ({ kind: event.kind, source: event.source })),
      inputTypes: commands.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.type) }));
    assert.equal(passiveDelivered, true, 'An unrelated counter is passive even before the preparatory movement ACK.');
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.trusted, true);
    assert.equal(result.nativeInputAcknowledged, true); assert.equal(strictFinishes, 2);
    assert.equal([...f.run.events.values()].some(event => event.source === 'unknown'), false);
    assert.equal((await facts()).commits, 1);
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]);
    assert.deepEqual(commands.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  for (const [label, mutate] of [
    ['private field value', () => page.evaluate(() => document.querySelector('main input').value = 'Foreign draft')],
    ['target purpose', () => page.evaluate(() => commit.textContent = 'Other action')],
    ['target object', () => page.evaluate(() => commit.replaceWith(commit.cloneNode(true)))],
    ['physical point', () => page.evaluate(() => commit.style.transform = 'translateX(80px)')],
    ['trusted user input', () => page.locator('main input').fill('Human draft')],
  ]) await nativeT.test(`held pointer preparation still refuses changed ${label}`, async () => {
    const f = await pointerFixture(); let held = false;
    commandHook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        held = true; await mutate(); await page.waitForTimeout(180);
      }
    };
    const result = await dispatch(f);
    assert.equal(held, true); assert.equal(result.success, false);
    assert.equal(result.noDispatch, true, JSON.stringify(result)); assert.notEqual(result.nativeInputAcknowledged, true);
    assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 0);
  });


  for (const scenario of ['regular click', 'field focus', 'private field change'])
    await nativeT.test(`certified ordinary CDP preparation: ${scenario}`, async () => {
      const f = await pointerFixture();
      const field = scenario !== 'regular click';
      const args = { selector: field ? 'main input' : '#commit' };
      const tool = 'click';
      f.run.dispatchCall = { ...f.run.dispatchCall, name: tool, args };
      let held = false, passiveDelivered = false;
      const before = await page.locator('main input').inputValue();
      commandHook = async (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
          held = true;
          await page.evaluate(() => passiveCounter.textContent = 'Counter during ordinary preparation');
          if (scenario === 'private field change') await page.locator('main input').evaluate(el => el.value = 'Foreign current draft');
          await page.waitForTimeout(180);
          passiveDelivered = [...f.run.events.values()].some(event => event.kind === 'dom' && event.source === 'page');
        }
      };
      const result = await f.agent.executeTool(17, tool, args);
      assert.equal(held, true, 'The ordinary Agent path must reach actual CDP no-button movement. ' + JSON.stringify(result));
      if (scenario === 'regular click' || scenario === 'field focus') {
        assert.equal(passiveDelivered, true); assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 1);
        if (field) {
          assert.equal(await page.locator('main input').inputValue(), before);
          assert.equal(await page.locator('main input').evaluate(el => document.activeElement === el), true);
          assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
        } else {
          assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]); assert.equal((await facts()).commits, 1);
          assert.equal(await page.locator('main input').inputValue(), before);
        }
      } else {
        assert.equal(result.success, false); assert.match(result.error, /prepar|changed/i);
        assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 0);
        assert.equal(commands.filter(call => call.method === 'Input.insertText').length, 0);
        assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
      }
    });

  await nativeT.test('implicit focused input retains its actual focus-bound certificate before input', async () => {
    const f = await pointerFixture();
    await page.locator('main input').focus();
    await page.waitForTimeout(180);
    const capture = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_capture_model',
      params: { runToken: f.run.token, includeTree: true } });
    f.run.events.clear();
    const params = { runToken: f.run.token, operationId: 'focused-field-preparation', tool: 'type_text',
      expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true };
    const prepared = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare', params });
    assert.equal(prepared.modelBindingValid, true, 'Implicit typing must bind the actually focused field.');
    const movement = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
      ...params, kind: 'click', navigationCandidate: false, pointerPreparationOnly: true,
      eventTypes: ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'] } });
    assert.equal(movement.ready, true);
    const before = await page.locator('main input').inputValue();
    await page.locator('#commit').focus();
    const changed = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
      ...params, kind: 'input', pointerPreparationOnly: true, eventTypes: ['beforeinput', 'input', 'change'] } });
    assert.equal(changed.ready, false); assert.equal(changed.pageFeedbackPending, true);
    assert.equal(await page.locator('main input').inputValue(), before);
    assert.equal(commands.filter(call => call.method.startsWith('Input.')).length, 0);
    assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
  });

  await nativeT.test('real monitor keeps a set_field preparation bound across a counter and rejects immediate value drift', async () => {
    const f = await pointerFixture(), operationId = 'certified-field-preparation';
    const params = { runToken: f.run.token, operationId, tool: 'set_field', selector: 'main input',
      expectedModelSnapshot: f.capture.snapshotToken, allowPassiveRebase: true };
    const prepared = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare', params });
    assert.equal(prepared.modelBindingValid, true, 'The field must have its own current model certificate.');
    const movement = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
      ...params, kind: 'click', navigationCandidate: false, pointerPreparationOnly: true,
      eventTypes: ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'] } });
    assert.equal(movement.ready, true);
    const before = await page.locator('main input').inputValue();
    await page.evaluate(() => passiveCounter.textContent = 'Counter outside certified field');
    await page.waitForTimeout(180);
    assert.equal([...f.run.events.values()].some(event => event.kind === 'dom' && event.source === 'page'), true);
    const current = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_validate_model', params });
    assert.equal(current.ready, true, 'Unrelated passive text cannot replace the original field certificate.');
    assert.equal(await page.locator('main input').inputValue(), before);
    await page.locator('main input').evaluate(el => el.value = 'Immediate foreign field value');
    const changed = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
      ...params, kind: 'input', pointerPreparationOnly: true, eventTypes: ['beforeinput', 'input', 'change'] } });
    assert.equal(changed.ready, false); assert.equal(changed.pageFeedbackPending, true);
    assert.equal(commands.filter(call => call.method.startsWith('Input.')).length, 0);
    assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
    assert.equal(await page.locator('main input').inputValue(), 'Immediate foreign field value');
  });

  for (const scenario of ['current selector fence', 'missing private secret', 'stale run guard', 'different event target',
    'prior input before selector fence', 'finished prior input before selector fence', 'prior native wheel before selector fence', 'model selector flag', 'public second argument'])
    await nativeT.test(`selector preparation remains privately owned: ${scenario}`, async () => {
      const f = await pointerFixture(), operationId = 'selector-owned-operation';
      const base = { runToken: f.run.token, operationId, tool: 'click', selector: '#commit',
        expectedModelSnapshot: f.capture.snapshotToken, allowPassiveRebase: true };
      const prepared = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare', params: {
        ...base, selectorPreparationOnly: true } });
      assert.equal(prepared.modelBindingValid, true);
      if (scenario.includes('prior ')) {
        const input = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
          ...base, kind: scenario.includes('wheel') ? 'scroll' : 'input', nativeWheel: scenario.includes('wheel'),
          navigationCandidate: false, eventTypes: scenario.includes('wheel') ? ['wheel'] : ['beforeinput', 'input', 'change'] } });
        assert.equal(input.ready, true);
        if (scenario.startsWith('finished ')) {
          const finish = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_finish', params: {
            runToken: f.run.token, operationId, documentToken: f.capture.documentToken } });
          assert.equal(finish.ready, true);
        }
      }
      const fence = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
        ...base, kind: 'scroll', scrollIntoView: true, fenceOnly: true, selectorPreparationOnly: true } });
      assert.equal(fence.ready, true);
      const guard = { ...fence.guard,
        ...(scenario === 'missing private secret' ? { nativeSecret: undefined } : {}),
        ...(scenario === 'stale run guard' ? { runToken: 'another-run' } : {}) };
      if (scenario === 'public second argument') await page.evaluate(base => {
        window.__wbPageMonitor.dispatch({ ...base, kind: 'scroll', scrollIntoView: true, selectorPreparationOnly: true }, true);
      }, base);
      else if (scenario !== 'model selector flag') await page.evaluate(({ guard, foreign }) => {
        const target = foreign ? document.querySelector('main input') : commit;
        target.dispatchEvent(new CustomEvent('webbrain-agent-scroll-dispatch', {
          bubbles: true, composed: true, cancelable: true, detail: JSON.stringify(guard) }));
      }, { guard, foreign: scenario === 'different event target' });
      else {
        const unowned = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
          ...base, kind: 'scroll', scrollIntoView: true, selectorPreparationOnly: true } });
        assert.equal(unowned.ready, true);
      }
      const movement = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
        ...base, kind: 'click', navigationCandidate: false, pointerPreparationOnly: true,
        eventTypes: ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'] } });
      if (scenario !== 'different event target') assert.equal(movement.ready, true);
      await page.evaluate(() => passiveCounter.textContent = 'Counter following selector preparation');
      await page.waitForTimeout(180);
      const changes = [...f.run.events.values()].filter(event => event.kind === 'dom');
      assert.ok(changes.length > 0);
      assert.equal(changes.some(event => event.source === 'unknown'), scenario !== 'current selector fence');
      assert.equal(commands.filter(call => call.method.startsWith('Input.')).length, 0);
      assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
    });

  await nativeT.test('immediate private field drift after a real move ACK refuses the ordinary click before press', async () => {
    const f = await pointerFixture(), sendCommand = cdpClient.sendCommand;
    f.run.dispatchCall = { ...f.run.dispatchCall, name: 'click', args: { selector: '#commit' } };
    let acknowledgedMovement = false;
    cdpClient.sendCommand = async function(id, method, params, ...rest) {
      const result = await sendCommand.call(this, id, method, params, ...rest);
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        acknowledgedMovement = true;
        // No timer, input event or attribute write: the original footprint is
        // re-read before the next native press rather than waiting for feedback.
        await page.locator('main input').evaluate(el => el.value = 'Immediate foreign draft');
      }
      return result;
    };
    let result;
    try { result = await f.agent.executeTool(17, 'click', { selector: '#commit' }); }
    finally { cdpClient.sendCommand = sendCommand; }
    assert.equal(acknowledgedMovement, true); assert.equal(result.success, false);
    assert.match(result.error, /prepar|changed/i);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 0);
    assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
    assert.equal(await page.locator('main input').inputValue(), 'Immediate foreign draft');
  });

  // These use the actual monitor message handler. Metadata cannot turn an
  // uncertified or consequential operation into preparation, and a separate
  // unfinished action remains consequential while a certified move is pending.
  for (const scenario of ['uncertified', 'unbound', 'wrong event', 'missing events',
    'navigation', 'input', 'model preparation flag only', 'prior consequential input', 'concurrent consequential input'])
    await nativeT.test(`pointer phase retains unknown attribution for ${scenario}`, async () => {
      const f = await pointerFixture();
      const movementEvents = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'];
      const operationId = scenario === 'unbound' ? 'unbound-pointer-operation'
        : scenario === 'uncertified' ? 'uncertified-pointer-operation' : 'neutral-owned-operation';
      const base = { runToken: f.run.token, operationId, kind: 'click', tool: 'click_ax', ref_id: f.ref,
        navigationCandidate: false, pointerPreparationOnly: true, eventTypes: movementEvents };
      if (scenario === 'uncertified' || scenario === 'model preparation flag only') {
        const prepared = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare', params: {
          ...base, allowPassiveRebase: true,
          ...(scenario === 'model preparation flag only' ? { expectedModelSnapshot: f.capture.snapshotToken } : {}) } });
        assert.equal(prepared.ready, true);
        if (scenario === 'model preparation flag only') assert.equal(prepared.modelBindingValid, true);
        else assert.notEqual(prepared.modelBindingValid, true, 'An unproven operation cannot inherit the fixture certificate.');
      }
      if (scenario === 'prior consequential input' || scenario === 'concurrent consequential input') {
        const otherId = scenario === 'prior consequential input' ? operationId : 'other-consequential-operation';
        if (otherId !== operationId) {
          const prepared = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare', params: {
            ...base, operationId: otherId, expectedModelSnapshot: f.capture.snapshotToken, allowPassiveRebase: true } });
          assert.equal(prepared.modelBindingValid, true);
        }
        const press = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
          ...base, operationId: otherId, pointerPreparationOnly: false, navigationCandidate: true,
          eventTypes: ['pointerdown', 'mousedown', 'click', 'input', 'change'] } });
        assert.equal(press.ready, true);
      }
      const params = { ...base,
        ...(scenario === 'wrong event' ? { eventTypes: ['pointerdown', 'click'] } : {}),
        ...(scenario === 'missing events' ? { eventTypes: undefined } : {}),
        ...(scenario === 'navigation' ? { navigationCandidate: true } : {}),
        ...(scenario === 'input' ? { kind: 'input' } : {}),
        ...(scenario === 'model preparation flag only' ? { pointerPreparationOnly: undefined } : {}) };
      const started = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params });
      assert.equal(started.ready, true);
      await page.evaluate(() => passiveCounter.textContent = 'Unrelated counter mutation');
      await page.waitForTimeout(180);
      const changes = [...f.run.events.values()].filter(event => event.kind === 'dom');
      assert.ok(changes.length > 0, 'The real monitor must deliver the counter mutation.');
      assert.equal(changes.some(event => event.source === 'unknown'), true, scenario);
      assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
      assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
    });

  for (const scenario of ['held button', 'missing explicit no-button'])
    await nativeT.test(`actual CDP ${scenario} movement cannot claim preparation`, async () => {
      const f = await pointerFixture(), sendCommand = cdpClient.sendCommand;
      let unknownDelivered = false;
      cdpClient.sendCommand = function(id, method, params, ...rest) {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
          params = { ...params, pointerPreparationOnly: true };
          if (scenario === 'held button') { params.button = 'left'; params.buttons = 1; }
          else { delete params.button; delete params.buttons; }
        }
        return sendCommand.call(this, id, method, params, ...rest);
      };
      commandHook = async (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
          await page.evaluate(() => passiveCounter.textContent = 'Counter during consequential movement');
          await page.waitForTimeout(180);
          unknownDelivered = [...f.run.events.values()].some(event => event.kind === 'dom' && event.source === 'unknown');
        }
      };
      let result;
      try { result = await dispatch(f); } finally { cdpClient.sendCommand = sendCommand; }
      assert.equal(unknownDelivered, true); assert.equal(result.success, false);
      assert.equal(result.noDispatch, true); assert.notEqual(result.nativeInputAcknowledged, true);
      assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 0);
      assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
    });

  await nativeT.test('model pointer phase flags cannot mask unknown feedback after actual press and release', async () => {
    const f = await pointerFixture(), consume = cdpClient.consumeFileInputClickGuard;
    f.agent._lastAxScopes.set(17, f.scope);
    const args = { ref_id: f.ref, pointerPreparationOnly: true, navigationCandidate: false,
      eventTypes: ['pointermove', 'mousemove'] };
    f.run.dispatchCall.args = args;
    let unknownDelivered = false;
    cdpClient.consumeFileInputClickGuard = async (...params) => {
      const result = await consume.apply(cdpClient, params);
      await page.evaluate(() => passiveCounter.textContent = 'Counter after consequential input');
      await page.waitForTimeout(180);
      unknownDelivered = [...f.run.events.values()].some(event => event.kind === 'dom' && event.source === 'unknown');
      return result;
    };
    let result;
    try { result = await f.agent.executeTool(17, 'click_ax', args); }
    finally { cdpClient.consumeFileInputClickGuard = consume; }
    assert.equal(unknownDelivered, true); assert.equal(result.success, true);
    assert.equal(result.nativeInputAcknowledged, true);
    assert.ok([...f.run.events.values()].some(event => event.source === 'unknown'),
      'Read-only observation must preserve unknown feedback for the next decision.');
    assert.deepEqual((await facts()).clicks, [{ trusted: true, active: true }]); assert.equal((await facts()).commits, 1);
    assert.deepEqual(commands.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased']);
    const before = commands.length, repeat = await f.agent.executeTool(17, 'click_ax', args);
    assert.equal(repeat.success, false); assert.equal(repeat.noDispatch, true);
    assert.equal(commands.length, before); assert.equal((await facts()).commits, 1);
  });

  await nativeT.test('already queued unknown feedback cannot be rebased by pointer preparation', async () => {
    const f = await pointerFixture();
    const started = await chrome.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_dispatch', params: {
      runToken: f.run.token, operationId: 'neutral-owned-operation', kind: 'click', tool: 'click_ax', ref_id: f.ref,
      navigationCandidate: true, eventTypes: ['pointerdown', 'click'] } });
    assert.equal(started.ready, true);
    await page.evaluate(() => passiveCounter.textContent = 'Unknown before movement');
    await page.waitForTimeout(180);
    assert.equal([...f.run.events.values()].some(event => event.kind === 'dom' && event.source === 'unknown'), true);
    const result = await dispatch(f);
    assert.equal(result.success, false); assert.equal(result.noDispatch, true);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent').length, 0);
    assert.deepEqual((await facts()).clicks, []); assert.equal((await facts()).commits, 0);
  });

  await nativeT.test('lost pointer acknowledgement never completes its operation or presses the button', async () => {
    const f = await pointerFixture(), send = chrome.tabs.sendMessage;
    let strictFinishes = 0, deliveredMoves = 0;
    chrome.tabs.sendMessage = (id, message, ...rest) => {
      if (message.action === 'page_monitor_finish' && message.params?.documentToken) strictFinishes++;
      return send(id, message, ...rest);
    };
    commandHook = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        await session.send(method, params); deliveredMoves++;
        throw new Error('neutral lost pointer acknowledgement');
      }
    };
    let result;
    try { result = await dispatch(f); } finally { chrome.tabs.sendMessage = send; }
    assert.equal(deliveredMoves, 1); assert.equal(strictFinishes, 0);
    assert.equal(result.success, false); assert.equal(result.noDispatch, true);
    assert.notEqual(result.nativeInputAcknowledged, true);
    assert.match(result.error, /lost pointer acknowledgement/);
    assert.deepEqual((await facts()).clicks, []);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 0);
  });

  for (const [label, mutate] of [
    ['private field value', () => page.evaluate(() => document.querySelector('main input').value = 'Foreign draft')],
    ['target purpose', () => page.evaluate(() => commit.textContent = 'Other action')],
    ['target object', () => page.evaluate(() => commit.replaceWith(commit.cloneNode(true)))],
    ['physical point', () => page.evaluate(() => commit.style.transform = 'translateX(80px)')],
    ['trusted user input', () => page.locator('main input').fill('Human draft')],
  ]) await nativeT.test(`completed pointer still fences changed ${label}`, async () => {
    const f = await pointerFixture(), send = chrome.tabs.sendMessage;
    let preparations = 0;
    chrome.tabs.sendMessage = async (id, message, ...rest) => {
      if (message.action === 'click_ax' && message.params?._prepareTrustedNativeButton) {
        if (++preparations === 1) { const result = await send(id, message, ...rest); await page.waitForTimeout(230); return result; }
        await mutate(); await page.waitForTimeout(180);
      }
      return send(id, message, ...rest);
    };
    let result;
    try { result = await dispatch(f); } finally { chrome.tabs.sendMessage = send; }
    assert.equal(result.success, false); assert.equal(result.noDispatch, true, JSON.stringify(result));
    assert.notEqual(result.nativeInputAcknowledged, true);
    assert.deepEqual((await facts()).clicks, []);
    assert.equal((await facts()).commits, 0);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 0);
  });

  for (const scenario of ['replacement run', 'foreign document', 'Stop', 'steering'])
    await nativeT.test(`pointer completion cannot authorize ${scenario} during its awaited reply`, async () => {
      const f = await pointerFixture(), send = chrome.tabs.sendMessage;
      let intercepted = false;
      chrome.tabs.sendMessage = async (id, message, ...rest) => {
        if (!intercepted && message.action === 'page_monitor_finish' && message.params?.documentToken) {
          intercepted = true;
          if (scenario === 'replacement run') f.agent._pageFeedbackRuns.set(17, { ...f.run });
          if (scenario === 'foreign document') f.run.frames.set(0, { ...f.run.frames.get(0), token: 'foreign-document' });
          if (scenario === 'Stop') f.agent._checkAbort = () => true;
          if (scenario === 'steering') f.agent._hasPendingSteering = () => true;
        }
        return send(id, message, ...rest);
      };
      let result;
      try { result = await dispatch(f); } finally { chrome.tabs.sendMessage = send; }
      assert.equal(intercepted, true);
      assert.equal(result.success, false); assert.equal(result.noDispatch, true, JSON.stringify(result));
      assert.notEqual(result.nativeInputAcknowledged, true);
      assert.deepEqual((await facts()).clicks, []);
      assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 0);
    });

  await nativeT.test('a real content deadline refusal after pointer ACK preserves its normal error without a press', async () => {
    const f = await pointerFixture(), send = chrome.tabs.sendMessage;
    let preparations = 0, contentRefusal;
    chrome.tabs.sendMessage = async (id, message, ...rest) => {
      if (message.action === 'click_ax' && message.params?._prepareTrustedNativeButton && ++preparations === 2) {
        contentRefusal = await send(id, { ...message, actionDeadlineAt: Date.now() - 1 }, ...rest);
        return contentRefusal;
      }
      return send(id, message, ...rest);
    };
    let result;
    try { result = await dispatch(f); } finally { chrome.tabs.sendMessage = send; }
    assert.equal(contentRefusal.deadlineExpired, true);
    assert.equal(contentRefusal.success, false); assert.equal(contentRefusal.noDispatch, true);
    assert.equal(result.success, false); assert.equal(result.noDispatch, true);
    assert.equal(result.error, contentRefusal.error);
    assert.match(result.error, /deadline expired/); assert.doesNotMatch(result.error, /button changed/);
    assert.deepEqual((await facts()).clicks, []);
    assert.equal(commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed').length, 0);
  });

  } finally {
    cdpClient.attach = originalAttach; cdpClient.sessions.delete(17);
    await context?.close(); await browser?.close();
    globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
  }
});

test('native observation note is boolean-only and recorder failure preserves the existing timing note', async () => {
  const source = await readFile(new URL('../src/chrome/src/agent/agent.js', import.meta.url), 'utf8');
  const start = source.indexOf('  _recordClickAxTiming(tabId, step, timing, result) {');
  const end = source.indexOf('  async _dispatchInitialTrustedNativeButton(', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const receiver = Function('trace', `return ({${source.slice(start, end).trim()}});`)({
    recordNote(_runId, _step, note, extra) {
      calls.push({ note, extra });
      if (note === 'click_ax_observation') throw new Error('neutral synchronous recorder failure');
    },
  });
  receiver.currentRunId = new Map([[17, 'neutral-recorded-run']]);
  const expected = { baselineSnapshotAvailable: false, afterSnapshotAvailable: false,
    observable: false, proved: false, safetyVeto: false };
  receiver._recordClickAxTiming(17, 1, { trustedInputEvents: 3, nativeButtonObservation: {
    ...expected, pageUrl: 'https://PRIVATE.invalid', ref_id: 'ref_PRIVATE', value: 'PRIVATE-DRAFT',
  } }, { success: true, initialTrustedNativeButton: true, verified: false });
  assert.deepEqual(calls.map(call => call.note), ['click_ax_observation', 'click_ax_timing']);
  assert.deepEqual(calls[0].extra.context, { nativeButtonObservation: expected });
  assert.equal(calls[1].extra.outcome, 'inconclusive');
  const { projectTraceEventData } = await import('../src/chrome/src/trace/privacy.js');
  const projected = projectTraceEventData('note', { note: calls[0].note, extra: calls[0].extra });
  assert.deepEqual(projected.extra.context, calls[0].extra.context);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|ref_|https?:/);
});


for (const build of ['chrome', 'firefox']) test(`${build} transport prepress diagnostics remain bounded without changing the veto or release`, async () => {
  const { Agent: BuildAgent } = await import(`../src/${build}/src/agent/agent.js`);
  const { beforePageAgentDispatch, installPageFeedback } = await import(`../src/${build}/src/agent/page-feedback.js`);
  const originalMessage = api.tabs.sendMessage;
  const originalGet = api.tabs.get;
  const agent = new BuildAgent({});
  const tab = build === 'chrome' ? 719 : 720;
  agent._runningTabs.add(tab);
  api.tabs.get = async () => ({ id: tab, url: 'https://neutral-veto.invalid/current' });
  api.tabs.sendMessage = async () => ({ ready: true });
  await agent._beginPageFeedbackRun(tab, 'neutral');
  let stateChecks = 0;
  agent._pageFeedbackBlocksCall = () => { stateChecks++; return false; };
  const monitorVeto = { modelBindingInvalid: true, layoutChanged: false, preparedBindingChanged: false,
    passiveRebased: false, pendingFeedback: false, revisionChanged: false, documentChanged: false,
    documentRevisionChanged: false, selector: 'PRIVATE_SELECTOR', target: 'PRIVATE_TARGET',
    ref: 'ref_PRIVATE', privateValue: 'PRIVATE_DRAFT', malformed: new Array(500).fill('PRIVATE') };
  api.tabs.sendMessage = async () => ({ ready: false, pageFeedbackPending: true, preparationVeto: monitorVeto });
  try {
    let error;
    try { await beforePageAgentDispatch(api, tab, { kind: 'click' }); } catch (caught) { error = caught; }
    assert.equal(error?.code, 'page_feedback_pending');
    assert.equal(stateChecks, 2, 'The original before/after pending predicate is evaluated once at each boundary.');
    assert.deepEqual(error.pagePreparationVeto, { cause: 'monitor_rejected', ownerPendingAfter: false, monitorRejected: true, modelBindingInvalid: true,
      layoutChanged: false, preparedBindingChanged: false, passiveRebased: false, pendingFeedback: false,
      revisionChanged: false, documentChanged: false, documentRevisionChanged: false });
    assert.doesNotMatch(JSON.stringify(error.pagePreparationVeto), /PRIVATE|ref_|https?:/);
    monitorVeto.modelBindingInvalid = 'PRIVATE_STRING'; monitorVeto.layoutChanged = null;
    try { await beforePageAgentDispatch(api, tab, { kind: 'click' }); } catch (caught) { error = caught; }
    assert.equal('modelBindingInvalid' in error.pagePreparationVeto, false);
    assert.equal('layoutChanged' in error.pagePreparationVeto, false);
    assert.equal(Object.values(error.pagePreparationVeto).every(value => value === 'monitor_rejected' || typeof value === 'boolean'), true);
    monitorVeto.predicate = 'target_changed';
    for (const started of [false, true]) {
      class DiagnosticProbe extends BuildAgent {
        async executeTool(id, _name, _args, _update, context) {
          if (started) context._contentActionDispatchState.started = true;
          try { await beforePageAgentDispatch(api, id, { kind: 'click' }); }
          catch (caught) {
            caught.pagePreparationVeto.privateValue = 'PRIVATE_DRAFT';
            caught.pagePreparationVeto.selector = 'PRIVATE_SELECTOR';
            throw caught;
          }
        }
      }
      installPageFeedback(DiagnosticProbe);
      const probe = new DiagnosticProbe({});
      const receipt = await probe.executeTool(tab, 'click_ax', { ref_id: 'ref_PRIVATE' });
      assert.equal(receipt.success, false);
      assert.equal(receipt.dispatched, started);
      assert.equal(receipt.preparationVeto.predicate, 'target_changed');
      assert.equal(receipt.preparationVeto.cause, 'monitor_rejected');
      assert.doesNotMatch(JSON.stringify(receipt.preparationVeto), /PRIVATE|ref_|https?:/);
      if (started) { assert.equal(receipt.outcomeUnknown, true); assert.equal(receipt.retryable, false); }
      else assert.equal(receipt.noDispatch, true);
    }
    stateChecks = 0;
    agent._pageFeedbackBlocksCall = () => { stateChecks++; return true; };
    try { await beforePageAgentDispatch(api, tab, { kind: 'click' }); } catch (caught) { error = caught; }
    assert.equal(error.pagePreparationVeto.cause, 'owner_pending_before'); assert.equal(stateChecks, 1);
    stateChecks = 0;
    await beforePageAgentDispatch(api, tab, { kind: 'click', release: true });
    assert.equal(stateChecks, 0, 'Held input releases keep the existing unconditional cleanup path.');
  } finally {
    agent._finishPageFeedbackRun(tab);
    api.tabs.sendMessage = originalMessage; api.tabs.get = originalGet;
  }
});


test('default synthetic click observation still vetoes automatic trusted retries', async vetoT => {
  for (const reason of ['network_request', 'tab_set', 'download']) await vetoT.test(reason, async () => {
    const savedChrome = globalThis.chrome;
    const agent = new Agent({});
    let targetResolutions = 0;
    const before = JSON.stringify({ url: 'https://neutral-retry.invalid/current', text: 'same', media: '', controls: '', active: '' });
    const startedAt = Date.now();
    const watch = { created: reason === 'download' ? [{ id: 1, ts: startedAt }] : [],
      requests: reason === 'network_request' ? [{ ts: startedAt, method: 'POST', type: 'xmlhttprequest', url: 'https://neutral-retry.invalid/api/mutate' }] : [],
      listeningRequests: true, signalVersion: 1, waitForSignal: async () => 1 };
    globalThis.chrome = { ...api, tabs: { ...api.tabs, query: async () => [{ id: 17 }] } };
    agent._clickProgressSnapshot = async () => before;
    agent._clickAxTabSnapshot = async () => reason === 'tab_set' ? '17,18' : '17';
    agent._resolveClickAxFallbackTarget = async () => { targetResolutions++; throw new Error('A safety veto must not enter target retry preparation.'); };
    try {
      const result = await agent._maybeFallbackClickAxWithCdp(17, { ref_id: 'ref_neutral' },
        { success: true, method: 'click_ax', ref_id: 'ref_neutral', tag: 'div' },
        { startedAt, snapshot: before, tabIds: '17', sideEffectWatch: watch, signalVersion: 0 });
      assert.equal(result.success, true); assert.equal(result.verified, false); assert.equal(result.inconclusive, true);
      assert.equal(result.trusted, false); assert.equal(result.fallbackAttempted, undefined);
      assert.deepEqual(result.observedEffects, [reason]);
      assert.match(result.fallbackSkipped, /automatic trusted retry unsafe/);
      assert.equal(targetResolutions, 0, 'Default retry safety must retain its original early exit.');
    } finally { globalThis.chrome = savedChrome; }
  });
});


for (const build of ['chrome', 'firefox']) test(`${build}: acknowledged input completion remains owned across message delivery`, async ownerT => {
  const { installPageFeedback, beforePageAgentDispatch, capturePageAgentInputCompletion } =
    await import(`../src/${build}/src/agent/page-feedback.js`);
  for (const scenario of ['current frame only', 'missing or foreign guard', 'new run during delivery',
    'new operation during delivery', 'new document during delivery', 'rejected finish acknowledgement'])
    await ownerT.test(scenario, async () => {
      assert.equal(typeof capturePageAgentInputCompletion, 'function');
      const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
      const tab = build === 'chrome' ? 921 : 922, doc = 'owned-completion-document';
      const url = 'https://neutral-completion.invalid/current';
      const deliveries = [], legacyFinishes = [];
      let agent, outcome, captured, nested, nestedRelease, nestedEntered;
      const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
      nestedRelease = defer(); nestedEntered = defer();
      const transport = { tabs: {
        get: async () => ({ id: tab, url }),
        sendMessage: async (_tab, message, options) => {
          if (message.action === 'page_monitor_dispatch') return { ready: true,
            guard: { ...message.params, documentToken: message.params.documentToken || doc } };
          if (message.action !== 'page_monitor_finish') return { ready: true };
          if (!Object.hasOwn(message.params, 'documentToken')) { legacyFinishes.push(options.frameId); return { ready: true }; }
          deliveries.push({ ...message.params, frameId: options.frameId });
          if (scenario === 'new run during delivery') {
            agent._finishPageFeedbackRun(tab);
            await agent._beginPageFeedbackRun(tab, 'replacement');
          } else if (scenario === 'new document during delivery') {
            agent.pageMonitorState({ tab: { id: tab }, frameId: 0, documentId: 'replacement-id', url }, 'replacement-token');
          } else if (scenario === 'new operation during delivery') {
            nested = agent.executeTool(tab, 'click', { nested: true });
            await nestedEntered.promise;
          }
          return { ready: scenario !== 'rejected finish acknowledgement' };
        },
      } };
      globalThis.chrome = globalThis.browser = transport;
      class CompletionAgent {
        static STATE_CHANGE_TOOLS = new Set(['click']);
        isRunning() { return true; }
        _checkAbort() { return false; }
        async executeTool(id, _name, args) {
          if (args.nested) {
            const next = await beforePageAgentDispatch(transport, id, { kind: 'click', documentToken: doc });
            assert.notEqual(next.operationId, captured.operationId);
            nestedEntered.resolve(); await nestedRelease.promise; return { success: true };
          }
          await beforePageAgentDispatch(transport, id, { kind: 'click', documentToken: 'owned-child-document' });
          captured = await beforePageAgentDispatch(transport, id, { kind: 'click', documentToken: doc });
          if (scenario === 'missing or foreign guard') {
            assert.equal(capturePageAgentInputCompletion(transport, id, null), null);
            for (const change of [{ operationId: 'foreign-operation' }, { runToken: 'foreign-run' },
              { documentToken: 'foreign-document' }])
              assert.equal(capturePageAgentInputCompletion(transport, id, { ...captured, ...change }), null);
            outcome = false; return { success: true };
          }
          const finish = capturePageAgentInputCompletion(transport, id, captured);
          assert.equal(typeof finish, 'function');
          const run = this._pageFeedbackRuns.get(id);
          if (scenario === 'current frame only') {
            const sender = { tab: { id }, frameId: 0, documentId: 'owned-main-id', url };
            const state = this.pageMonitorState(sender, doc);
            this.observePageFeedback(sender, { ...state, seq: 1, revision: 1, kind: 'dom', source: 'unknown', target: 'button#pending' });
            assert.equal(run.events.size, 1);
          }
          outcome = await finish();
          assert.equal(await finish(), false, 'The captured completion capability is consumed once.');
          if (scenario === 'current frame only') assert.equal(run.events.size, 1, 'Completion must not erase queued unknown feedback.');
          if (nested) { nestedRelease.resolve(); await nested; }
          return { success: true };
        }
      }
      installPageFeedback(CompletionAgent); agent = new CompletionAgent();
      try {
        await agent._beginPageFeedbackRun(tab, 'interactive');
        agent.pageMonitorState({ tab: { id: tab }, frameId: 0, documentId: 'owned-main-id', url }, doc);
        agent.pageMonitorState({ tab: { id: tab }, frameId: 2, documentId: 'owned-child-id', url }, 'owned-child-document');
        await agent.executeTool(tab, 'click', {});
        assert.equal(outcome, scenario === 'current frame only');
        assert.equal(deliveries.length, scenario === 'missing or foreign guard' ? 0 : 1);
        if (deliveries.length) {
          assert.equal(deliveries[0].frameId, 0, 'Complete the captured frame only, not every frame of the action.');
          assert.equal(deliveries[0].operationId, captured.operationId);
          assert.equal(deliveries[0].runToken, captured.runToken);
          assert.equal(deliveries[0].documentToken, doc);
        }
        assert.ok(legacyFinishes.includes(2), 'The original finally still releases all remaining action frames.');
      } finally {
        nestedRelease.resolve(); await nested?.catch(() => {});
        agent._finishPageFeedbackRun(tab);
        globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
      }
    });
});
