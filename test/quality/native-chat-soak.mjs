import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { telegramLab } from './native-chat-fixture.mjs';

// Optional real wall-clock soak. Never included in the default test command.
// Normal installed MV3 Agent, chrome.alarms and storage execute unchanged;
// only the provider and owned native Telegram-shaped application are fixtures.
const minutes = Number(process.env.WEBBRAIN_SOAK_MINUTES || 60);
assert.ok(Number.isFinite(minutes) && minutes >= 3 && minutes <= 180, 'Use 3..180 real minutes to exercise both restarts and Stop.');
const contextWindow = Number(process.env.WEBBRAIN_SOAK_CONTEXT_WINDOW || 1000000);
assert.ok(Number.isFinite(contextWindow) && contextWindow >= 16384 && contextWindow <= 1000000);
const finiteContext = !!process.env.WEBBRAIN_SOAK_CONTEXT_WINDOW;
const promptTier = process.env.WEBBRAIN_SOAK_PROMPT_TIER || 'full';
assert.ok(['compact', 'mid', 'full'].includes(promptTier));
const maxOutputTokens = Number(process.env.WEBBRAIN_SOAK_MAX_OUTPUT_TOKENS || 4096);
assert.ok(Number.isFinite(maxOutputTokens) && maxOutputTokens >= 64 && maxOutputTokens <= 4096);
const seedPriorHistory = process.env.WEBBRAIN_SOAK_SEED_PRIOR_HISTORY === '1';
assert.ok(!seedPriorHistory || finiteContext, 'Historical fixture seeding is restricted to the separate finite-context case.');
const durationMs = minutes * 60_000, intervalMs = 60_000;
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/native-chat-soak');
await fs.mkdir(out, { recursive: true });
const fixtureUrl = 'https://web.telegram.org/k/?fixture=wall-clock-soak#123456';
const marker = 'OWNED_NATIVE_WALL_CLOCK_SOAK';
const task = `${marker}. This is an isolated QA dialogue with WebBrain QA Bot, the only intended recipient in the currently open conversation. You are authorized to generate and send brief useful replies about browser-agent quality within this conversation for at least ${minutes} minutes. Answer each freshly observed numbered Soak question exactly once with your own brief wording; never answer historical messages again. Use chat_observe before replying and independently verify delivery after every chat_send. When waiting without fresh incoming messages, durably schedule_resume after 60 seconds and start each resume by observing. Stop only after the app says QA one-hour soak complete and all its numbered questions have been answered. Keep this conversation on this page. You may send at most ${Math.ceil(minutes) + 10} replies.`;
const script = `<script>
window.qaReplies=[];window.qaQuestions=[];window.qaStartedAt=Date.now();window.qaComplete=false;let mid=0;
function row(text,own=false){const node=document.createElement('div');node.className='bubble '+(own?'is-out is-read':'is-in');node.dataset.mid=String(++mid);node.dataset.peerId='123456';node.dataset.timestamp=String(Math.floor(Date.now()/1000));const body=document.createElement('div');body.className='message';body.append(document.createTextNode(text));const time=document.createElement('span');time.className='time';time.textContent=' QA';body.append(time);node.append(body);document.querySelector('.bubbles-inner').append(node);const scroll=document.querySelector('.bubbles-scrollable');scroll.scrollTop=scroll.scrollHeight;document.querySelector('.bubbles').classList.add('scrolled-down');}
function question(){if(qaComplete)return;const number=qaQuestions.length+1;const text='Soak question '+number+': Give one brief browser-agent quality check.';qaQuestions.push({number,at:Date.now()});row(text);}
function send(){const input=document.querySelector('.input-message-input');const text=input.textContent.trim();if(!text)return;qaReplies.push({text,at:Date.now()});input.textContent='';row(text,true);if(!qaComplete)setTimeout(question,${intervalMs});}
document.querySelector('button').onclick=send;document.querySelector('.input-message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}});
question();setTimeout(()=>{qaComplete=true;row('QA one-hour soak complete: answer any remaining numbered question, then stop.');},${durationMs});
</script>`;
const fixture = telegramLab.replace(/<script>[\s\S]*?<\/script>/, script);
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
function toolObject(content) {
  const text = textContent(content);
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, index + 1)); } catch { break; } }
    }
  }
  return null;
}
function toolsFrom(messages) {
  const names = new Map();
  for (const message of messages || []) for (const call of message.tool_calls || []) names.set(call.id, call.function?.name);
  return (messages || []).filter(message => message.role === 'tool').map(message => ({ name: names.get(message.tool_call_id) || message.name,
    result: toolObject(message.content) }));
}
const metrics = { startedAt: null, minutes, elapsedMs: 0, providerRequests: 0, actionCalls: 0, intentRequests: 0,
  scheduleCalls: 0, maxRequestBytes: 0, maxStoredBytes: 0, maxMessages: 0, maxSeenMessageIds: 0,
  maxSentMessageKeys: 0, workerRestarts: [], stopBoundary: null, samples: [], calls: [], auxiliaryRequests: [], externalMessages: 0, accountsCreated: [],
  contextWindow, promptTier, maxOutputTokens, measuredPromptUsage: finiteContext, maxMeasuredPromptTokens: 0, compactionRequests: 0, contextCompactions: [] };
let heldDecision = null, stopRequested = false, providerError = null;
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const chunk of request) body += chunk;
    metrics.providerRequests++; metrics.maxRequestBytes = Math.max(metrics.maxRequestBytes, Buffer.byteLength(body));
    assert.ok(Buffer.byteLength(body) <= 6_000_000, 'A one-hour request must remain bounded.');
    const input = JSON.parse(body), authority = JSON.stringify(input.messages || []);
    const measuredPromptTokens = Math.ceil((JSON.stringify(input.messages || []).length + JSON.stringify(input.tools || []).length) / 4);
    metrics.maxMeasuredPromptTokens = Math.max(metrics.maxMeasuredPromptTokens, measuredPromptTokens);
    const isJudge = textContent(input.messages?.[0]?.content).startsWith('Evaluate only the observable requirements of the genuine user task');
    const isCompaction = textContent(input.messages?.[0]?.content).startsWith('Summarize this conversation history in 3-5 bullet points.');
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    if (isAction || isJudge) assert.ok(authority.includes(marker), 'Every action/evaluation retains the genuine authorized conversation goal.');
    if (finiteContext && isAction) {
      assert.ok(input.messages.some(message => message.role === 'user' && textContent(message.content).includes(task)),
        'Compaction must retain the exact original authorized task through alarm and Continue.');
      const outputReserve = Number(input.max_tokens ?? input.max_completion_tokens ?? 0);
      assert.ok(measuredPromptTokens + outputReserve <= contextWindow,
        `The actual request including tool schemas and requested output exceeds the finite ${contextWindow}-token fixture budget (${measuredPromptTokens} chars/4 prompt tokens + ${outputReserve} reserved output).`);
    }
    else if (!authority.includes(marker)) metrics.auxiliaryRequests.push({ at: Date.now(),
      systemPrefix: textContent(input.messages?.[0]?.content).slice(0, 240), tools: input.tools?.length || 0 });
    await new Promise(resolve => setTimeout(resolve, 200));
    let completion;
    if (isCompaction) {
      metrics.compactionRequests++;
      completion = { role: 'assistant', content: 'Earlier owned QA replies were independently delivered. Preserve the pinned genuine task and current native workflow; observe fresh numbered questions, reply once, and durably wait until the app confirms completion.' };
    } else if (isJudge) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Require independent current native delivery evidence.' }) };
    else if (!isAction) {
      metrics.intentRequests++;
      completion = { role: 'assistant', content: JSON.stringify({ request_kind: 'execute', scope_relation: metrics.intentRequests === 1 ? 'new' : 'continue',
        requires_state_change: true, requires_submission: true, messaging: { target_kind: 'named', recipients: ['WebBrain QA Bot'] },
        deliverables: ['Every fresh owned numbered question answered once until the app confirms the real wall-clock soak ended.'],
        allows_planner_shaped_result: false, allows_app_state_tool_evidence: false, completion_requirements: { download: false },
        read_scope: 'visible_page', summary: 'Continue the authorized owned QA chat, verify each reply, and durably wait for fresh questions.',
        steps: [{ id: '1', action: 'Observe, answer each fresh numbered question once, verify delivery, and schedule a durable wait until the terminal confirmation.' }],
        memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] }) };
    } else {
      const tools = toolsFrom(input.messages), last = tools.at(-1);
      let name = 'chat_observe', args = {};
      if (last?.name === 'chat_observe') {
        assert.equal(last.result?.success, true, last.result?.error || 'Native observation failed.');
        const observation = last.result;
        const incoming = observation.chatWorkflow?.newMessages?.filter(row => row.direction === 'incoming') || [];
        const numbered = incoming.find(row => /^Soak question \d+:/.test(row.text));
        const complete = tools.some(tool => tool.name === 'chat_observe'
          && tool.result?.chatWorkflow?.newMessages?.some(row => row.direction === 'incoming' && row.text.startsWith('QA one-hour soak complete')));
        if (numbered) {
          const number = Number(numbered.text.match(/^Soak question (\d+):/)[1]);
          name = 'chat_send'; args = { thread_key: observation.threadKey, composer_ref: observation.composer.ref,
            text: `QA reply ${number}: Verify durable native delivery before repeating a browser action.` };
          if (!stopRequested && metrics.startedAt && Date.now() - metrics.startedAt >= durationMs / 4) {
            stopRequested = true;
            await new Promise(resolve => { heldDecision = { number, release: resolve, startedAt: Date.now() }; });
          }
        } else if (complete) {
          name = 'done'; args = { outcome: 'success', summary: `The owned ${minutes}-minute wall-clock dialogue ended, all freshly observed numbered questions were answered once, and every reply was independently delivered.` };
        } else {
          assert.equal(observation.chatWorkflow?.nextAction, 'schedule_resume', 'A verified idle chat must request durable waiting.');
          assert.notEqual(observation.chatWorkflow?.pendingOutbound, true, 'Never schedule over an uncertain send.');
          name = 'schedule_resume'; args = { after_seconds: 60, reason: 'The authorized owned dialogue is waiting for its next fresh numbered question.',
            resume_instruction: `Continue ${marker} within the existing explicitly authorized QA conversation. Start with chat_observe; only answer fresh incoming numbered questions, verify delivery, and wait durably again if there is no new question.` };
          metrics.scheduleCalls++;
        }
      } else if (last?.name === 'chat_send') {
        assert.equal(last.result?.success, true, last.result?.error || 'Native send failed.');
        assert.equal(last.result.deliveryVerified, true, 'A send needs current app-owned delivery evidence.');
      }
      metrics.actionCalls++; metrics.calls.push({ number: metrics.actionCalls, name, at: Date.now(), question: name === 'chat_send' ? heldDecision?.number || Number(args.text.match(/QA reply (\d+):/)[1]) : undefined });
      metrics.calls = metrics.calls.slice(-300);
      assert.ok(metrics.actionCalls <= Math.ceil(minutes) * 12 + 50, 'No tight paid model loop is allowed.');
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `soak-${metrics.actionCalls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-soak-${metrics.providerRequests}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: finiteContext ? measuredPromptTokens : 100, completion_tokens: 20 } }));
  } catch (error) {
    providerError ||= error.message;
    response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-native-chat-soak-'));
let context, harness, page, tabId, worker, session;
const workerVersions = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const extension = path.resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://web.telegram.org') return route.fulfill({ contentType: 'text/html', body: fixture });
    if (url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:') return route.continue();
    return route.abort('blockedbyclient');
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const guardWorkerNetwork = async current => current.evaluate(() => {
    globalThis.__ownedSoakWorkerBoot = crypto.randomUUID();
    const send = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      return url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)
        ? send(input, options) : Promise.reject(new Error('Owned wall-clock soak blocks external network requests.'));
    };
  });
  await guardWorkerNetwork(worker);
  const extensionId = new URL(worker.url()).host;
  harness = await context.newPage(); await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.soakEvents = []; window.soakRuns = {};
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update') {
        soakEvents.push({ type: event.type, at: Date.now(), tabId: event.tabId, data: event.data });
        if (soakEvents.length > 1500) soakEvents.splice(0, soakEvents.length - 1500);
      }
    });
    await chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never',
      screenshotFallback: false, autoScreenshot: false, maxAgentSteps: 30, systemOneEnabled: false, tracingEnabled: false,
      agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false,
      scheduledTasksEnabled: true, scheduledRequireConsequentialConfirmation: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', contextWindow, promptTier, maxOutputTokens, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  page = await context.newPage(); await page.goto(fixtureUrl);
  metrics.startedAt = await page.evaluate(() => qaStartedAt);
  tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, fixtureUrl);
  assert.ok(tabId);
  const launch = async (action, text = null) => {
    const requestId = `${action}-soak-${Date.now()}`;
    await harness.evaluate(({ action, text, tabId, requestId }) => {
      const run = soakRuns[requestId] = { finished: false };
      chrome.runtime.sendMessage({ target: 'background', action, tabId, requestId, mode: 'act', locale: 'en', ...(text ? { text } : {}) })
        .then(result => { run.result = result; run.finished = true; }, error => { run.error = error.message; run.finished = true; });
    }, { action, text, tabId, requestId });
    return requestId;
  };
  const state = () => harness.evaluate(async tabId => {
    const entry = (await chrome.storage.session.get(`agentConv:${tabId}`))[`agentConv:${tabId}`];
    const jobs = (await chrome.storage.local.get('wb_scheduled_jobs')).wb_scheduled_jobs || [];
    return { entryBytes: entry ? new TextEncoder().encode(JSON.stringify(entry)).length : 0, messages: entry?.messages?.length || 0,
      chat: entry?.chatWorkflow || null, jobs: jobs.filter(job => job.tabId === tabId).map(job => ({ id: job.id, status: job.status, nextRunAt: job.nextRunAt, lastError: job.lastError,
        resumeTaskId: job.resumeTaskId, predecessorJobId: job.predecessorJobId, clarificationRequired: job.clarificationRequired,
        reconciliationRequired: job.reconciliationRequired, lastOutcome: job.lastOutcome })),
      compactions: soakEvents.filter(event => event.tabId === tabId && event.type === 'context_compacted')
        .map(event => ({ at: event.at, ...event.data })),
      events: soakEvents.filter(event => event.tabId === tabId).slice(-20) };
  }, tabId);
  await launch('chat', task);
  let lastMinute = -1, stopped = false, complete = false;
  const restartThresholds = [durationMs / 6, durationMs * 2 / 3];
  console.log(JSON.stringify({ phase: 'started', minutes, startedAt: new Date(metrics.startedAt).toISOString(), externalMessages: 0 }));
  while (Date.now() - metrics.startedAt < durationMs + 180_000) {
    assert.equal(providerError, null, providerError || 'Provider fixture error.');
    metrics.elapsedMs = Date.now() - metrics.startedAt;
    const current = await state();
    metrics.contextCompactions = current.compactions;
    const native = await page.evaluate(() => ({ replies: qaReplies.length, questions: qaQuestions.length, complete: qaComplete }));
    metrics.maxStoredBytes = Math.max(metrics.maxStoredBytes, current.entryBytes); metrics.maxMessages = Math.max(metrics.maxMessages, current.messages);
    metrics.maxSeenMessageIds = Math.max(metrics.maxSeenMessageIds, current.chat?.seenMessageIds?.length || 0);
    metrics.maxSentMessageKeys = Math.max(metrics.maxSentMessageKeys, current.chat?.sentMessageKeys?.length || 0);
    assert.ok(current.entryBytes <= 1_500_000 + 100_000, 'Session history and kernel remain within their persisted budget.');
    assert.ok((current.chat?.seenMessageIds?.length || 0) <= 200 && (current.chat?.sentMessageKeys?.length || 0) <= 200);
    assert.ok(native.replies <= native.questions, 'Never reply more than once per fresh owned question.');
    const minute = Math.floor(metrics.elapsedMs / 60_000);
    if (minute !== lastMinute) {
      lastMinute = minute;
      const sample = { minute, elapsedMs: metrics.elapsedMs, ...native, storedBytes: current.entryBytes, messages: current.messages,
        seenMessageIds: current.chat?.seenMessageIds?.length || 0, pendingJobs: current.jobs.filter(job => ['pending', 'queued'].includes(job.status)).length,
        completedJobs: current.jobs.filter(job => job.status === 'completed').length, providerRequests: metrics.providerRequests };
      metrics.samples.push(sample); console.log(JSON.stringify({ phase: 'minute', ...sample }));
      await fs.writeFile(path.join(out, 'progress.json'), JSON.stringify(metrics, null, 2));
      await fs.writeFile(path.join(out, 'state.json'), JSON.stringify({ elapsedMs: metrics.elapsedMs, ...current, native },
        (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
    }
    if (heldDecision && !stopped) {
      const before = native.replies, held = heldDecision; stopped = true;
      const stopAt = Date.now(); await message('abort', { tabId });
      const deadline = Date.now() + 15_000;
      while ((await message('agent_run_state', { tabId })).running && Date.now() < deadline) await sleep(100);
      assert.equal((await message('agent_run_state', { tabId })).running, false, 'Stop settles the actual running scheduled turn promptly.');
      held.release(); await sleep(1000);
      assert.equal(await page.evaluate(() => qaReplies.length), before, 'Late inference after Stop must not dispatch its prepared reply.');
      for (const job of (await state()).jobs.filter(job => ['pending', 'queued', 'running', 'needs_user_input'].includes(job.status))) await message('cancel_scheduled_job', { jobId: job.id });
      metrics.stopBoundary = { passed: true, question: held.number, elapsedMs: stopAt - metrics.startedAt, stopLatencyMs: Date.now() - stopAt,
        repliesBefore: before, repliesAfterLateModelResult: before };
      heldDecision = null; await launch('continue');
      console.log(JSON.stringify({ phase: 'stop-and-continue', ...metrics.stopBoundary }));
    }
    const nextRestart = restartThresholds[metrics.workerRestarts.length];
    if (Number.isFinite(nextRestart) && metrics.elapsedMs >= nextRestart && !current.chat?.pendingOutbound
        && current.jobs.some(job => job.status === 'pending') && !(await message('agent_run_state', { tabId })).running) {
      const before = current.chat?.seenMessageIds?.length || 0;
      if (!session) {
        session = await context.newCDPSession(harness);
        session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
          for (const version of versions) workerVersions.set(version.versionId, version);
        });
        await session.send('ServiceWorker.enable');
      }
      const deadline = Date.now() + 5000;
      let version;
      do {
        version = [...workerVersions.values()].find(entry => entry.runningStatus === 'running'
          && entry.scriptURL.startsWith(`chrome-extension://${extensionId}/`));
        if (!version) await sleep(100);
      } while (!version && Date.now() < deadline);
      assert.ok(version, 'Locate only this isolated extension service-worker version.');
      const oldBoot = await worker.evaluate(() => globalThis.__ownedSoakWorkerBoot);
      if (seedPriorHistory && !metrics.priorHistorySeed) {
        const seed = await harness.evaluate(async ({ tabId, marker }) => {
          const key = `agentConv:${tabId}`;
          const entry = (await chrome.storage.session.get(key))[key];
          const anchorIndex = entry?.messages?.findIndex(message => message.role === 'user'
            && message.webbrainResumeTaskId && JSON.stringify(message.content).includes(marker)) ?? -1;
          if (anchorIndex < 0 || entry.chatWorkflow?.pendingOutbound) throw new Error('Seed only a genuine persisted idle task after verified delivery.');
          const anchor = JSON.stringify(entry.messages[anchorIndex]);
          const kernel = JSON.stringify(entry.chatWorkflow);
          const beforeMessages = entry.messages.length;
          const groups = Array.from({ length: 64 }, (_, index) => {
            const id = `owned-finite-prior-read-${index}`;
            return [{ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'read_page', arguments: '{}' } }] },
              { role: 'tool', tool_call_id: id, content: JSON.stringify({ success: true,
                text: `Owned synthetic prior readonly check ${index}: ${'Prior harmless browser state; no action requested. '.repeat(80)}` }) }];
          }).flat();
          entry.messages.splice(anchorIndex + 1, 0, ...groups);
          if (JSON.stringify(entry.messages[anchorIndex]) !== anchor || JSON.stringify(entry.chatWorkflow) !== kernel)
            throw new Error('The history seed must preserve exact genuine task authority and durable native kernel.');
          await chrome.storage.session.set({ [key]: entry });
          return { groups: 64, beforeMessages, afterMessages: entry.messages.length,
            storedBytes: new TextEncoder().encode(JSON.stringify(entry)).length,
            genuineTaskAndIdPreserved: true, pendingAndReceiptPreserved: true };
        }, { tabId, marker });
        metrics.priorHistorySeed = seed;
        metrics.maxStoredBytes = Math.max(metrics.maxStoredBytes, seed.storedBytes);
        metrics.maxMessages = Math.max(metrics.maxMessages, seed.afterMessages);
        console.log(JSON.stringify({ phase: 'owned-prior-history-seed', ...seed }));
      }
      await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      const stopDeadline = Date.now() + 5000;
      while (workerVersions.get(version.versionId)?.runningStatus !== 'stopped' && Date.now() < stopDeadline) await sleep(100);
      assert.equal(workerVersions.get(version.versionId)?.runningStatus, 'stopped', 'The actual worker must stop before the restart.');
      await message('get_providers');
      const restartDeadline = Date.now() + 20_000;
      let running;
      do {
        running = [...workerVersions.values()].find(entry => entry.runningStatus === 'running'
          && entry.scriptURL.startsWith(`chrome-extension://${extensionId}/`));
        if (!running) await sleep(100);
      } while (!running && Date.now() < restartDeadline);
      assert.ok(running, 'A real runtime message restarts the stopped extension worker.');
      // Chromium can reuse a DevTools worker target/version, so Playwright need
      // not emit a new serviceworker object. Verify the native running state
      // and the fresh global instead of counting an optional observer event.
      worker = context.serviceWorkers().find(current => current.url().startsWith(`chrome-extension://${extensionId}/`)) || worker;
      assert.notEqual(await worker.evaluate(() => globalThis.__ownedSoakWorkerBoot), oldBoot,
        'Stopping the worker discards its in-memory global before resuming.');
      await guardWorkerNetwork(worker);
      const after = await state();
      assert.ok((after.chat?.seenMessageIds?.length || 0) >= before, 'The worker restart retains consumed native identities.');
      assert.ok(after.jobs.some(job => job.status === 'pending'), 'A persisted real alarm survives worker restart.');
      const record = { passed: true, elapsedMs: Date.now() - metrics.startedAt, seenBefore: before,
        seenAfter: after.chat?.seenMessageIds?.length || 0, actualStopped: true, freshWorkerGlobal: true };
      metrics.workerRestarts.push(record); console.log(JSON.stringify({ phase: 'worker-restart', ...record }));
    }
    if (native.complete && native.replies === native.questions && current.events.some(event => event.type === 'tool_result'
      && event.data?.name === 'done' && event.data.result?.outcome === 'success') && !current.jobs.some(job => ['pending', 'queued', 'running'].includes(job.status))) {
      complete = true; break;
    }
    const failedJob = current.jobs.find(job => job.status === 'failed' && job.lastError);
    assert.equal(failedJob, undefined, failedJob?.lastError);
    const failedDone = current.events.find(event => event.type === 'tool_result' && event.data?.name === 'done'
      && event.data.result?.outcome === 'failed');
    assert.equal(failedDone, undefined, failedDone?.data?.result?.error || 'The verified owned chat ended with a failed terminal result.');
    const pausedJob = current.jobs.find(job => job.status === 'needs_user_input');
    assert.equal(pausedJob, undefined, pausedJob?.lastError || 'The explicitly authorized owned chat must not silently require human input.');
    await sleep(1000);
  }
  assert.equal(complete, true, 'The scheduled native chat must reach independently verified successful completion.');
  // Alarm/Continue updates legitimately project compact tool results. Require
  // the actual app-owned terminal UI state after the scheduler settles rather
  // than treating a projected outcome string as successful completion.
  const terminalDeadline = Date.now() + 15000;
  let terminalState, terminalChat, terminalStored;
  do {
    terminalState = await message('agent_run_state', { tabId });
    terminalChat = await state();
    terminalStored = await harness.evaluate(async tabId => {
      const key = `runUi:${tabId}`, stored = (await chrome.storage.session.get(key))[key];
      return { requestId: stored?.requestId || null, status: stored?.status || null,
        successfulDone: stored?.successfulDone === true, runSucceeded: stored?.runSucceeded === true };
    }, tabId);
    if (terminalState.runUi?.status === 'completed' && terminalState.runUi?.successfulDone === true
        && terminalState.runUi?.runSucceeded === true && terminalState.running === false
        && !terminalChat.chat?.pendingOutbound
        && !terminalChat.jobs.some(job => ['pending', 'queued', 'running'].includes(job.status))
        && terminalStored.status === 'completed' && terminalStored.successfulDone === true
        && terminalStored.runSucceeded === true && !!terminalState.runUi?.requestId
        && terminalStored.requestId === terminalState.runUi.requestId) break;
    await sleep(100);
  } while (Date.now() < terminalDeadline);
  metrics.finalRunUi = { status: terminalState.runUi?.status || null,
    successfulDone: terminalState.runUi?.successfulDone === true, runSucceeded: terminalState.runUi?.runSucceeded === true,
    running: terminalState.running === true, pendingOutbound: !!terminalChat.chat?.pendingOutbound,
    activeJobs: terminalChat.jobs.filter(job => ['pending', 'queued', 'running'].includes(job.status)).length,
    storedStatus: terminalStored.status, storedSuccessfulDone: terminalStored.successfulDone,
    storedRunSucceeded: terminalStored.runSucceeded,
    storedRequestMatches: !!terminalState.runUi?.requestId && terminalStored.requestId === terminalState.runUi.requestId };
  assert.equal(metrics.finalRunUi.status, 'completed');
  assert.equal(metrics.finalRunUi.successfulDone, true, 'The actual terminal run UI must record accepted successful done.');
  assert.equal(metrics.finalRunUi.runSucceeded, true, 'A partial finished run is not successful completion.');
  assert.equal(metrics.finalRunUi.running, false); assert.equal(metrics.finalRunUi.pendingOutbound, false);
  assert.equal(metrics.finalRunUi.activeJobs, 0);
  assert.equal(metrics.finalRunUi.storedStatus, 'completed');
  assert.equal(metrics.finalRunUi.storedSuccessfulDone, true); assert.equal(metrics.finalRunUi.storedRunSucceeded, true);
  assert.equal(metrics.finalRunUi.storedRequestMatches, true, 'The saved successful terminal state must belong to the actual latest run.');
  const native = await page.evaluate(() => ({ questions: qaQuestions, replies: qaReplies, startedAt: qaStartedAt }));
  const numbers = native.replies.map(reply => Number(reply.text.match(/^QA reply (\d+):/)?.[1]));
  assert.deepEqual(numbers, native.questions.map(question => question.number), 'Every fresh owned question receives exactly one reply in order.');
  assert.equal(new Set(numbers).size, native.questions.length);
  assert.ok(Date.now() - native.startedAt >= durationMs, 'The elapsed time is genuine wall-clock time.');
  assert.ok(metrics.scheduleCalls >= Math.max(1, Math.floor(minutes / 2)), 'Exercise real durable scheduled waits repeatedly.');
  assert.equal(metrics.workerRestarts.length, 2); assert.equal(metrics.stopBoundary?.passed, true);
  if (finiteContext) assert.ok(metrics.contextCompactions.some(event => Number(event.summarized) > 0),
    'The finite-context case must actually summarize older history, beyond only checking a configured limit.');
  if (seedPriorHistory) assert.equal(metrics.priorHistorySeed?.genuineTaskAndIdPreserved, true);
  metrics.elapsedMs = Date.now() - native.startedAt;
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, ...metrics, questions: native.questions.length,
    repliesExactlyOnce: native.replies.length, authenticatedServiceTested: false, provider: 'deterministic loopback provider', clock: 'real wall clock' }, null, 2));
  console.log(JSON.stringify({ phase: 'passed', minutes, elapsedMs: metrics.elapsedMs, repliesExactlyOnce: native.replies.length,
    scheduleCalls: metrics.scheduleCalls, workerRestarts: metrics.workerRestarts.length, stopBoundary: true, externalMessages: 0 }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ passed: false, error: error.message, ...metrics, providerError,
    workerLifecycle: [...workerVersions.values()].map(({ versionId, runningStatus, status }) => ({ versionId, runningStatus, status })),
    events: harness ? await harness.evaluate(() => soakEvents?.slice(-80) || []).catch(() => []) : [] },
    (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
  throw error;
} finally {
  heldDecision?.release();
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-native-chat-soak-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
