import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { fixedChoiceQuestion, fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';
// The questions a messaging page's own checks read its texts with.
const MESSAGING_TEXT_KINDS = ['message_control', 'message_field', 'message_author', 'message_status'];

const workspace = path.resolve('.');
const extension = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION_SOURCE || path.join(workspace, 'src/chrome'));
const repositorySource = extension === path.join(workspace, 'src/chrome');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/literal-calculate-midrun-mv3');
await fs.mkdir(out, { recursive: true });
const correction = (await fs.readFile(path.join(workspace, 'test/fixtures/literal-calculation-correction.txt'), 'utf8')).trim();
assert.equal(correction.length, 367);
const expression = '12345678901234567890 * 7 + 0.125';
const exact = '86419752308641975230.125';
const marker = 'MIDRUN-CALCULATE-QA-20261008';
const original = 'Inspect the current Telegram Saved Messages thread using the native observation tools and report whether its identity is verified. Keep this task entirely read-only. Do not draft, send, or open another conversation.';
assert.equal(original.length, 215);
const fixtureUrl = 'https://web.telegram.org/k/#@owned_qa';
const requestId = 'owned-public-midrun-calculate';
const messageId = 'owned-current-correction-1';
const sha = value => createHash('sha256').update(value).digest('hex');
const contentText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
function toolObject(content) {
  const text = contentText(content);
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let cursor = start; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, cursor + 1)); } catch { break; } }
    }
  }
  return null;
}
async function sourceHashes(dir = extension, prefix = '') {
  const hashes = {};
  for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + item.name, absolute = path.join(dir, item.name);
    if (item.isDirectory()) Object.assign(hashes, await sourceHashes(absolute, name + '/'));
    else if (item.isFile()) hashes[name] = sha(await fs.readFile(absolute));
  }
  return hashes;
}
const sourceBefore = await sourceHashes();
await fs.writeFile(path.join(out, 'source-before.json'), JSON.stringify(sourceBefore, null, 2));
const calls = [], mutations = [], blockedNetwork = [], runtimeErrors = [];
let announcePaused, releaseOld;
const paused = new Promise(resolve => { announcePaused = resolve; });
const heldOld = new Promise(resolve => { releaseOld = resolve; });
let initialActionRequests = 0, revisedActionRequests = 0, requestedCalculations = 0;
const toolCall = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [
  { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
] });
function plan(revised) {
  return { request_kind: 'execute', scope_relation: 'new',
    deliverables: revised ? ['Exact arithmetic result', 'Response formatting marker'] : ['Report whether the native Saved Messages identity is verified'],
    requires_state_change: false, requires_submission: false, messaging: null,
    completion_requirements: { download: false }, allows_planner_shaped_result: false,
    allows_app_state_tool_evidence: false, read_scope: revised ? 'none' : 'visible_page',
    expected_items: null, site_job: null,
    summary: revised ? 'Calculate the exact literal expression and report its result with the requested marker.' : 'Read the native Saved Messages identity without changing the page.',
    steps: [{ id: '1', action: revised ? 'Use calculate for the exact literal expression, then report the verified arithmetic result.' : 'Use chat_observe to inspect the current native identity only.' }],
    memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
}
const html = `<!doctype html><meta charset="utf-8"><title>Owned native Saved Messages calculation fixture</title>
<style>body{font:18px sans-serif;margin:25px}.chat{width:850px}.topbar{padding:12px;background:#eee}.bubbles-scrollable{height:320px;overflow-y:auto}.bubble{padding:12px}.input-message-input{padding:14px;min-height:30px;border:1px solid #888}</style>
<div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456">Saved Messages</span></div></div></div>
<div class="bubbles-scrollable"><div class="bubbles-inner"><div class="bubble is-in" data-mid="1" data-peer-id="123456"><div class="message">Owned harmless native message</div></div></div></div>
<div class="input-message-input" role="textbox" aria-label="Message" data-peer-id="123456" contenteditable="true"></div><button id="mutation" aria-label="Send">Send</button></div>
<aside>Passive counter <span id="counter">0</span></aside>
<script>window.mutations=0;window.ticks=0;document.querySelector('#mutation').onclick=()=>{mutations++;fetch('/mutation',{method:'POST'});};
document.querySelector('.input-message-input').addEventListener('input',()=>mutations++);
document.querySelector('.input-message-input').addEventListener('keydown',e=>{if(e.key==='Enter')mutations++;});
setInterval(()=>document.querySelector('#counter').textContent=String(++ticks),80);</script>`;
const server = http.createServer(async (request, response) => {
  if (request.url === '/mutation') { mutations.push(Date.now()); response.writeHead(200); response.end('ok'); return; }
  if (request.url !== '/v1/chat/completions') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const revised = input.messages.some(message => message.role === 'user' && contentText(message.content).includes(correction));
    const evaluator = contentText(input.messages[0]?.content).startsWith('Evaluate only the observable requirements of the genuine user task');
    const action = Array.isArray(input.tools) && input.tools.length > 0;
    const priorResults = input.messages.filter(message => message.role === 'tool').map(message => toolObject(message.content)).filter(Boolean);
    const system = contentText(input.messages[0]?.content);
    // WebBrain reads what the corrected request asks for with a model: whether
    // it asks only for the arithmetic (a fixed-choice question) and the form
    // its answer must take (written down with texts copied from the request).
    // Answer both as a model that read the correction would; nothing else.
    const fixedChoice = system.startsWith("Answer one fixed-choice question for a browser agent's safety check.");
    const answerForm = system.startsWith("The user's request in `request` asks a browser agent only to calculate");
    if (fixedChoice || answerForm) {
      const request = JSON.parse(contentText(input.messages[1]?.content)).request;
      const readsCalculation = fixedChoice && system.includes('contains the arithmetic expression in `page.expression`');
      calls.push({ at: Date.now(), stage: fixedChoice ? 'reading' : 'answer_form', revised,
        kind: readsCalculation ? 'calculation_request' : fixedChoice ? 'other' : 'answer_form', correctionRead: request === correction });
      // The chat's controls, fields, message labels and statuses are read as a
      // model would.
      const controls = fixedChoice && MESSAGING_TEXT_KINDS.includes(fixedChoiceQuestion(input.messages)?.kind)
        ? fixtureFixedChoiceReply(input.messages) : null;
      const content = answerForm ? { only_result: false, result_last: false, ending: marker, include: [] }
        : readsCalculation && request === correction ? { choice: 'only_result_with_form', evidence: request } : { choice: '', evidence: '' };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: `owned-${calls.length}`, choices: [{ message: { role: 'assistant', content: controls || JSON.stringify(content) },
        finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 20 } }));
      return;
    }
    const plannerCalculateCapability = /(?:^|\n)[ \t]*(?:compute|utility|calculation):[^\n]*\bcalculate\b/i.test(system);
    const plannerUtilityExecuteRule = system.split('\n').some(line => /\bcalculate\b/.test(line) && /\bexecute\b/.test(line)
      && /page-independent|no (?:fresh )?(?:page|browser)|without (?:a |any )?(?:browser|page)|pure (?:utility )?tool|utility/i.test(line));
    const record = { at: Date.now(), stage: evaluator ? 'completion' : action ? 'action' : 'planner', revised,
      toolNames: (input.tools || []).map(tool => tool.function?.name),
      userTextHashes: input.messages.filter(message => message.role === 'user').map(message => sha(contentText(message.content))),
      calculatorResultPresent: priorResults.some(result => result.success === true && result.result === exact),
      nativeAliasBindingFailurePresent: priorResults.some(result => result.success === false && result.reason === 'native_telegram_alias_binding_required'),
      ...(evaluator || action ? {} : { plannerCalculateCapability, plannerUtilityExecuteRule }) };
    calls.push(record);
    let completion;
    if (evaluator) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'The owned fixture does not force an observable page-completion verdict.' }) };
    else if (!action) {
      // Follow the capabilities actually advertised to this planner. The
      // previous fixture blindly returned execute, concealing the real
      // unavailable-calculator clarification observed in authenticated Chrome.
      const requestedPlan = plan(revised);
      completion = { role: 'assistant', content: JSON.stringify(revised && (!plannerCalculateCapability || !plannerUtilityExecuteRule)
        ? { ...requestedPlan, request_kind: 'clarify', steps: [],
          summary: 'The planner has not been told that a page-independent calculate tool is available. Which calculation method should be used?' }
        : requestedPlan) };
    }
    else if (!revised) {
      assert.ok(++initialActionRequests <= 2, 'Exactly one native read precedes the superseded old read proposal.');
      if (initialActionRequests === 1) {
        assert.ok(record.toolNames.includes('chat_observe'));
        completion = toolCall('actual-original-native-read', 'chat_observe', {});
      } else {
        assert.equal(record.nativeAliasBindingFailurePresent, true,
          'A genuine native username-route observation must fail without its profile witness.');
        assert.ok(record.toolNames.includes('get_accessibility_tree'));
        announcePaused(record); await heldOld;
        completion = { role: 'assistant', content: '', tool_calls: [
          ...toolCall('stale-original-chat-read', 'chat_observe', {}).tool_calls,
          ...toolCall('stale-original-page-read', 'get_accessibility_tree', { filter: 'visible' }).tool_calls,
        ] };
      }
    } else {
      assert.ok(++revisedActionRequests <= 6, 'Corrected arithmetic must finish without a recovery loop.');
      const expectedTools = record.calculatorResultPresent ? ['done'] : ['calculate', 'done'];
      assert.deepEqual([...record.toolNames].sort(), expectedTools,
        'The revised tool projection must match the actual calculator receipt phase.');
      if (record.calculatorResultPresent) completion = toolCall('verified-current-done', 'done', { summary: `${exact}\n${marker}`, outcome: 'success' });
      else { requestedCalculations++; completion = toolCall('actual-current-calculation', 'calculate', { expression }); }
    }
    record.responseTools = (completion.tool_calls || []).map(call => call.function.name);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-${calls.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  } catch (error) {
    runtimeErrors.push(error.message); response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const intendedTempRoot = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(path.join(intendedTempRoot, 'webbrain-owned-midrun-calculate-'));
let context, panel, tabId, evidence;
const startedAt = Date.now();
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking', '--disable-sync'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' || url.origin === origin) return route.continue();
    if (url.origin === 'https://web.telegram.org' && url.pathname === '/k/') return route.fulfill({
      contentType: 'text/html; charset=utf-8', body: html });
    blockedNetwork.push({ host: url.hostname, method: route.request().method() }); return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const messageFrom = (page, action, data = {}) => page.evaluate(({ action, data }) =>
    chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await settings.evaluate(async () => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, planBeforeActMode: 'off',
    planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: false,
    maxAgentSteps: 10, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true,
    askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false, contextWindowMode: 'full',
    // gpt-5.4-mini on a router is a strong model, so Auto lean mode would skip the
    // calculation reading and the tool projection this case checks.
    leanMode: 'off' }));
  assert.equal((await messageFrom(settings, 'update_provider', { providerId: 'openrouter', config: {
    apiKey: 'owned-loopback-fake-key', baseUrl: `${origin}/v1`, model: 'openai/gpt-5.4-mini',
    contextWindow: 128000, enabled: true, supportsAskStreaming: false,
  } })).ok, true);
  assert.equal((await messageFrom(settings, 'set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(fixtureUrl);
  tabId = await settings.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  assert.ok(tabId);
  panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/src/ui/sidepanel.html`);
  await panel.evaluate(() => {
    window.ownedEvents = []; window.ownedChat = { finished: false };
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update' || event.action === 'run_complete') ownedEvents.push(event);
    });
  });
  await panel.evaluate(({ tabId, text, requestId }) => {
    chrome.runtime.sendMessage({ target: 'background', action: 'chat', tabId, text, mode: 'act', requestId, locale: 'en' })
      .then(result => { ownedChat.result = result; ownedChat.finished = true; })
      .catch(error => { ownedChat.error = error.message; ownedChat.finished = true; });
  }, { tabId, text: original, requestId });
  let pauseTimer;
  try {
    await Promise.race([paused, new Promise((_, reject) => {
      pauseTimer = setTimeout(() => reject(new Error('Initial actual action request did not pause.')), 45000);
    })]);
  } finally { clearTimeout(pauseTimer); }
  const before = await messageFrom(panel, 'agent_run_state', { tabId, requestId });
  assert.equal(before.running, true); assert.equal(before.runUi?.requestId, requestId);
  const steer = await messageFrom(panel, 'chat_steer', { tabId, requestId, messageId, text: correction });
  assert.equal(steer.accepted, true, JSON.stringify(steer));
  assert.equal(steer.messageId, messageId);
  releaseOld();
  await panel.waitForFunction(() => ownedChat.finished, null, { timeout: 90000 });
  const run = await panel.evaluate(() => ({ chat: ownedChat, events: ownedEvents }));
  const current = await messageFrom(panel, 'agent_run_state', { tabId, requestId });
  let stored;
  for (let attempt = 0; attempt < 50; attempt++) {
    stored = await panel.evaluate(async tabId => {
      const entries = await chrome.storage.session.get([`runUi:${tabId}`, `agentConv:${tabId}`]);
      return { runUi: entries[`runUi:${tabId}`], conversation: entries[`agentConv:${tabId}`] };
    }, tabId);
    if (stored.runUi?.status === 'completed' && stored.runUi?.runSucceeded === true) break;
    await panel.waitForTimeout(100);
  }
  const publicEvents = run.events.filter(event => event.requestId === requestId);
  const updates = run.chat.result?.updates || [];
  const steeringBoundary = updates.findIndex(event => event.type === 'steering_applied');
  const revisedUpdates = steeringBoundary >= 0 ? updates.slice(steeringBoundary + 1) : [];
  const originalNativeReads = updates.filter(event => event.type === 'tool_result' && event.data?.name === 'chat_observe');
  const discardedProposalIds = ['stale-original-chat-read', 'stale-original-page-read'];
  const retainedCallIds = (stored.conversation?.messages || []).flatMap(message => (message.tool_calls || []).map(call => call.id));
  const calculation = updates.filter(event => event.type === 'tool_result' && event.data?.name === 'calculate');
  const done = updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
  const steering = (stored.conversation?.messages || []).filter(message => message.webbrainSteering);
  evidence = { passed: false, durationMs: Date.now() - startedAt, correctionLength: correction.length,
    correctionSHA: sha(correction), expression, exact, requestId, messageId, before: { running: before.running, requestId: before.runUi?.requestId },
    steer, run: run.chat, publicEvents, calls, liveRunUi: current.runUi, storedRunUi: stored.runUi,
    steering: steering.map(message => ({ contentMatches: message.content === correction, ...message.webbrainSteering })),
    requestedCalculations, mutations: mutations.length, pageMutations: await page.evaluate(() => mutations),
    passiveTicks: await page.evaluate(() => ticks), runtimeErrors, blockedNetwork, sourceCount: Object.keys(sourceBefore).length,
    actualLoadedRepositorySource: repositorySource, originalLength: original.length, originalSHA: sha(original),
    initialActionRequests, originalNativeReads: originalNativeReads.map(event => ({ success: event.data.result.success, reason: event.data.result.reason })),
    discardedProposalIds, discardedProposalsRetained: discardedProposalIds.filter(id => retainedCallIds.includes(id)) };
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  assert.equal(run.chat.error, undefined); assert.equal(runtimeErrors.length, 0);
  assert.equal(calculation.length, 1); assert.equal(requestedCalculations, 1);
  assert.equal(calculation[0].data.result.success, true); assert.equal(calculation[0].data.result.exact, true);
  assert.equal(calculation[0].data.result.result, exact);
  assert.equal(initialActionRequests, 2);
  assert.equal(originalNativeReads.length, 1); assert.equal(originalNativeReads[0].data.result.success, false);
  assert.equal(originalNativeReads[0].data.result.reason, 'native_telegram_alias_binding_required');
  assert.deepEqual(evidence.discardedProposalsRetained, [], 'Both superseded old read proposals must be discarded before tools execute.');
  assert.ok(steeringBoundary >= 0);
  assert.deepEqual(revisedUpdates.filter(event => event.type === 'tool_result').map(event => event.data?.name), ['calculate', 'done']);
  assert.deepEqual(revisedUpdates.filter(event => event.type === 'tool_call').map(event => event.data?.name), ['calculate', 'done']);
  const revisedPlannerRequests = calls.filter(call => call.stage === 'planner' && call.revised);
  assert.ok(revisedPlannerRequests.length > 0);
  assert.ok(revisedPlannerRequests.every(call => call.plannerCalculateCapability && call.plannerUtilityExecuteRule),
    'The genuine revised planner must receive truthful calculate capability and page-independent execution requirements.');
  // The correction was read once for its arithmetic and once for its
  // answer form; the original read-only task was never read as arithmetic.
  assert.deepEqual(calls.filter(call => call.stage === 'reading' && call.kind === 'calculation_request').map(call => call.correctionRead), [true]);
  assert.deepEqual(calls.filter(call => call.stage === 'answer_form').map(call => call.revised), [true]);
  assert.equal(done?.done, true); assert.equal(done?.outcome, 'success'); assert.notEqual(done?.blockedDone, true);
  assert.equal(run.chat.result.content, `${exact}\n${marker}`);
  assert.equal(publicEvents.filter(event => event.type === 'steering_applied').length, 1);
  assert.equal(steering.length, 1); assert.equal(steering[0].content, correction);
  assert.equal(steering[0].webbrainSteering.requestId, requestId); assert.equal(steering[0].webbrainSteering.messageId, messageId);
  assert.equal(steering[0].webbrainSteering.revision, 1);
  for (const snapshot of [current.runUi, stored.runUi]) {
    assert.equal(snapshot?.requestId, requestId); assert.equal(snapshot?.status, 'completed');
    assert.equal(snapshot?.successfulDone, true); assert.equal(snapshot?.runSucceeded, true);
    assert.equal(snapshot?.finalContent, `${exact}\n${marker}`);
  }
  assert.equal(current.running, false); assert.equal(evidence.mutations, 0); assert.equal(evidence.pageMutations, 0);
  assert.equal(page.url(), fixtureUrl);
  assert.equal(await page.locator('.input-message-input').innerText(), '');
  assert.ok(evidence.passiveTicks > 0);
  evidence.passed = true;
} catch (error) {
  if (panel && !evidence) evidence = { passed: false, durationMs: Date.now() - startedAt, error: error.message,
    calls, requestedCalculations, mutations: mutations.length, runtimeErrors, sourceCount: Object.keys(sourceBefore).length,
    run: await panel.evaluate(() => ({ chat: window.ownedChat, events: window.ownedEvents })).catch(() => null) };
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, evidence }, null, 2));
  throw error;
} finally {
  releaseOld(); await context?.close();
  await new Promise(resolve => server.close(resolve));
  const sourceAfter = await sourceHashes();
  await fs.writeFile(path.join(out, 'source-after.json'), JSON.stringify(sourceAfter, null, 2));
  const stable = JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore);
  await fs.writeFile(path.join(out, 'source-verification.json'), JSON.stringify({ sourceStable: stable,
    sourceCount: Object.keys(sourceBefore).length, root: path.relative(workspace, extension), actualLoadedRepositorySource: repositorySource, changed: Object.keys(sourceBefore)
      .filter(name => sourceBefore[name] !== sourceAfter[name]) }, null, 2));
  const resolved = await fs.realpath(profile);
  assert.equal(path.dirname(resolved).toLowerCase(), intendedTempRoot.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('webbrain-owned-midrun-calculate-'));
  await fs.rm(resolved, { recursive: true, force: true });
  assert.equal(stable, true, 'Installed product source must remain unchanged.');
  if (evidence) await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ passed: true, durationMs: evidence.durationMs, exact, requestedCalculations,
  sourceCount: evidence.sourceCount, sourceStable: true, publicSteeringRevision: 1, successfulDone: true, runSucceeded: true, mutations: 0 }));
