import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Installed MV3 extension, loopback fake model and an actual service-worker stop
// (DevTools ServiceWorker.stopWorker, as in cdp-worker-restart-mv3). The old
// task acts once; a first correction interrupts its next model request and is
// applied; a second correction arrives while the planner revalidates the first
// (planner requests are not interrupted), so it is accepted but not yet applied
// when the worker dies. The panel resumes the same request with continue_start:
// the second correction must reach the resumed run's first action request
// exactly once with its original message ID, and the first must not repeat.
const output = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/steering-worker-restart-mv3');
await fs.mkdir(output, { recursive: true });
const extension = path.resolve('src/chrome');
const original = 'Read the owned pricing page and report its heading. Keep this task read-only.';
const first = 'Correction one: read the owned docs page instead.';
const second = 'Correction two: report only the docs heading text.';
const marker = 'STEERING-RESTART-QA-20261013';
const requestId = 'owned-steering-restart-request';
const firstId = 'owned-steering-restart-correction-1', secondId = 'owned-steering-restart-correction-2';
const text = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
const toolCall = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [
  { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
] });
const plan = () => ({ request_kind: 'execute', scope_relation: 'new', deliverables: ['Report the heading'],
  requires_state_change: false, requires_submission: false, messaging: null, completion_requirements: { download: false },
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false, read_scope: 'visible_page',
  expected_items: null, site_job: null, summary: 'Read the visible page and report the heading.',
  steps: [{ id: '1', action: 'Read the visible page, then report the heading.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

const calls = [], runtimeErrors = [], blockedNetwork = [];
const oldActionInFlight = deferred(), revalidationInFlight = deferred(), released = deferred();
let worker = 'before-restart';
const html = '<!doctype html><meta charset="utf-8"><title>Owned docs</title><main><h1>Owned docs heading</h1><p>Owned steering fixture.</p></main>';
const server = http.createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
  }
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    // The latest user turn may carry the app-projected task authority after its
    // authored text; a correction is counted by the words the user wrote.
    const users = input.messages.filter(message => message.role === 'user')
      .map(message => text(message.content).split('\n\n[APP-OWNED CURRENT USER TASK')[0]);
    const evaluator = text(input.messages[0]?.content).startsWith('Evaluate only the observable requirements of the genuine user task');
    const action = Array.isArray(input.tools) && input.tools.length > 0;
    const record = { worker, stage: evaluator ? 'completion' : action ? 'action' : 'planner',
      firstCopies: users.filter(value => value === first).length, secondCopies: users.filter(value => value === second).length,
      mentionsFirst: users.some(value => value.includes(first)), mentionsSecond: users.some(value => value.includes(second)) };
    calls.push(record);
    const stageCount = calls.filter(item => item.worker === worker && item.stage === record.stage).length;
    let completion;
    if (evaluator) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Owned fixture.' }) };
    else if (!action) {
      if (worker === 'before-restart' && record.mentionsFirst) {
        // Revalidating the first correction. The worker dies before this returns.
        revalidationInFlight.resolve(record); await released.promise;
      }
      completion = { role: 'assistant', content: JSON.stringify(plan()) };
    } else if (worker === 'before-restart') {
      if (stageCount === 1) completion = toolCall('owned-old-read', 'get_accessibility_tree', { filter: 'visible' });
      else {
        // The first correction interrupts this request; it never needs an answer.
        oldActionInFlight.resolve(record); await released.promise;
        completion = toolCall('owned-stale-old-read', 'get_accessibility_tree', { filter: 'visible' });
      }
    } else {
      completion = stageCount === 1
        ? toolCall('owned-corrected-read', 'get_accessibility_tree', { filter: 'visible' })
        : toolCall('owned-corrected-done', 'done', { summary: `Owned docs heading\n${marker}`, outcome: 'success' });
    }
    record.responseTools = (completion.tool_calls || []).map(call => call.function.name);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-${calls.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  } catch (error) {
    runtimeErrors.push(error.message);
    try { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); } catch {}
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const fixtureUrl = `${origin}/owned-docs`;
const within = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 45000); })])
    .finally(() => clearTimeout(timer));
};
const tempRoot = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(path.join(tempRoot, 'webbrain-steering-restart-mv3-'));
const started = Date.now();
let context, evidence = { passed: false, installedMV3: true };
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking', '--disable-sync'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' || url.origin === origin) return route.continue();
    blockedNetwork.push(url.hostname); return route.abort();
  });
  const firstWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(firstWorker.url()).host;
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const send = (page, action, data = {}) => page.evaluate(({ action, data }) =>
    chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await settings.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, planBeforeActMode: 'off',
    planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: false, maxAgentSteps: 10,
    systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false,
    openaiAskStreamingEnabled: false, contextWindowMode: 'full' }));
  assert.equal((await send(settings, 'update_provider', { providerId: 'openrouter', config: {
    apiKey: 'owned-loopback-fake-key', baseUrl: `${origin}/v1`, model: 'openai/gpt-5.4-mini',
    contextWindow: 128000, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await send(settings, 'set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(fixtureUrl);
  const tabId = await settings.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, fixtureUrl);
  assert.ok(tabId);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/src/ui/sidepanel.html`);
  const journalKey = `agentSteer:${tabId}`, conversationKey = `agentConv:${tabId}`, runUiKey = `runUi:${tabId}`;
  const stored = keys => panel.evaluate(keys => chrome.storage.session.get(keys), keys);

  // The panel's detached start, as the composer sends it.
  const start = await send(panel, 'chat_start', { tabId, text: original, mode: 'act', requestId, locale: 'en' });
  assert.equal(start.accepted, true, JSON.stringify(start));
  await within(oldActionInFlight.promise, 'the old task to act and request its next step');
  assert.deepEqual(await send(panel, 'chat_steer', { tabId, requestId, messageId: firstId, text: first }), { accepted: true, messageId: firstId });
  await within(revalidationInFlight.promise, 'the first correction to be revalidated');
  assert.deepEqual(await send(panel, 'chat_steer', { tabId, requestId, messageId: secondId, text: second }), { accepted: true, messageId: secondId });
  const beforeRestart = await stored([journalKey, conversationKey]);
  evidence.beforeRestart = {
    journal: (beforeRestart[journalKey]?.entries || []).map(entry => ({ requestId: entry.requestId, id: entry.id })),
    savedSteering: (beforeRestart[conversationKey]?.messages || []).filter(message => message.webbrainSteering)
      .map(message => message.webbrainSteering.messageId),
  };
  assert.deepEqual(evidence.beforeRestart.savedSteering, [firstId], 'fixture: only the first correction was applied');

  // Stop the actual MV3 worker while the revalidation request is in flight.
  const devtools = await context.newCDPSession(settings), versions = new Map();
  devtools.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => updates.forEach(version => versions.set(version.versionId, version)));
  await devtools.send('ServiceWorker.enable');
  let version; const deadline = Date.now() + 5000;
  while (!version && Date.now() < deadline) {
    version = [...versions.values()].find(item => item.runningStatus === 'running' && item.scriptURL.startsWith(`chrome-extension://${id}/`));
    if (!version) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(version, 'The extension worker is running');
  const bootBefore = await firstWorker.evaluate(() => globalThis.__ownedSteeringRestartBoot ??= crypto.randomUUID());
  await devtools.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  worker = 'after-restart';
  released.resolve();

  // A fresh worker answers the panel's probe: the run is interrupted, not live.
  const interrupted = await send(panel, 'agent_run_state', { tabId, requestId });
  const freshWorker = context.serviceWorkers().find(item => item.url().startsWith(`chrome-extension://${id}/`));
  evidence.actualWorkerRestart = await freshWorker.evaluate(() => globalThis.__ownedSteeringRestartBoot ?? null) !== bootBefore;
  assert.equal(evidence.actualWorkerRestart, true);
  evidence.interrupted = { running: interrupted.running, starting: interrupted.starting, status: interrupted.runUi?.status,
    pendingToolCall: interrupted.runUi?.pendingToolCall || null, submittedTurnDurable: interrupted.submittedTurnDurable,
    runUiDurable: interrupted.runUiDurable, unappliedSteeringCount: interrupted.unappliedSteeringCount };
  const { unappliedSteeringCount: _count, ...resumable } = evidence.interrupted;
  assert.deepEqual(resumable, { running: false, starting: false, status: 'running', pendingToolCall: null,
    submittedTurnDurable: true, runUiDurable: true }, 'fixture: the panel would resume this interrupted run');

  // The panel resumes the same request, exactly as runDetachedWithReconnect does.
  const resumed = await send(panel, 'continue_start', { tabId, requestId, mode: 'act' });
  assert.equal(resumed.accepted, true, JSON.stringify(resumed));
  let final;
  for (let attempt = 0; attempt < 300; attempt++) {
    final = await send(panel, 'agent_run_state', { tabId, requestId });
    if (['completed', 'failed', 'stopped', 'cancelled', 'clarification_required'].includes(final.runUi?.status) && !final.running) break;
    await panel.waitForTimeout(100);
  }
  const after = await stored([journalKey, conversationKey, runUiKey]);
  const snapshot = after[runUiKey] || final.runUi;
  const resumedActions = calls.filter(call => call.worker === 'after-restart' && call.stage === 'action');
  evidence = { ...evidence, durationMs: Date.now() - started, calls, runtimeErrors, blockedNetwork,
    finalStatus: final.runUi?.status, finalContent: final.runUi?.finalContent,
    appliedEvents: (snapshot?.events || []).filter(event => event.type === 'steering_applied').map(event => event.data?.id),
    queuedEvents: (snapshot?.events || []).filter(event => event.type === 'steering_queued').length,
    savedSteering: (after[conversationKey]?.messages || []).filter(message => message.webbrainSteering).map(message => ({
      content: message.content, requestId: message.webbrainSteering.requestId, messageId: message.webbrainSteering.messageId })),
    journalAfter: after[journalKey] || null, unappliedAfter: final.unappliedSteeringCount };
  await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  assert.deepEqual(runtimeErrors, []);
  assert.equal(final.runUi?.status, 'completed', JSON.stringify(final.runUi));
  assert.equal(final.runUi.finalContent, `Owned docs heading\n${marker}`);
  assert.ok(resumedActions.length >= 1);
  assert.ok(resumedActions.every(call => call.firstCopies === 1 && call.secondCopies === 1),
    'From the resumed run\'s first action request on, each correction is present exactly once');
  assert.deepEqual(evidence.savedSteering, [
    { content: first, requestId, messageId: firstId }, { content: second, requestId, messageId: secondId },
  ]);
  assert.equal(evidence.appliedEvents.filter(value => value === secondId).length, 1);
  assert.equal(evidence.queuedEvents, 0, 'The correction was applied, not handed back');
  // How: acknowledged only once journaled, reported while no run owned it, cleared once applied.
  assert.deepEqual(evidence.beforeRestart.journal, [{ requestId, id: secondId }]);
  assert.equal(evidence.interrupted.unappliedSteeringCount, 1);
  assert.equal(evidence.journalAfter, null, 'Nothing is left to recover');
  assert.equal(evidence.unappliedAfter, 0);
  evidence.passed = true;
  await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ ...evidence, error: error.message, calls, runtimeErrors }, null, 2));
  throw error;
} finally {
  released.resolve(); await context?.close();
  await new Promise(resolve => server.close(resolve));
  const resolved = await fs.realpath(profile);
  assert.ok(path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith('webbrain-steering-restart-mv3-'), 'Unexpected profile.');
  await fs.rm(resolved, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: true, installedMV3: true, actualWorkerRestart: true, unappliedSurvivedRestart: true,
  appliedOnceBeforeFirstResumedAction: true, journalCleared: true, durationMs: evidence.durationMs }));
