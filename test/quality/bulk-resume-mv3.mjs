import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Installed MV3 background, real content dispatch and persisted progress. Only
// the model provider is scripted; no Agent lifecycle/completion helper is mocked.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/bulk-resume-mv3');
await fs.mkdir(out, { recursive: true });
const labels = Array.from({ length: 20 }, (_, index) => `Row ${String(index + 1).padStart(2, '0')}`);
const task = 'Save each of the 20 owned QA rows exactly once, in order. Track each row and its receipt in the progress ledger. Verify each saved receipt before marking a row processed. Preserve completed rows when interrupted; resume at the first unprocessed row and never repeat a completed save. If a row is blocked, continue the other rows and report the exact incomplete count. After I unblock that failed row and continue the task, reopening and retrying only that row is explicitly authorized. Full success requires all 20 rows independently saved and verified.';
const pageHtml = `<!doctype html><meta charset="utf-8"><title>Owned QA bulk rows</title>
<style>body{font:16px sans-serif;margin:20px}table{border-collapse:collapse}td{padding:4px 12px;border:1px solid #ddd}button{font:inherit;padding:4px 12px}</style>
<h1>Owned QA bulk save</h1><p>20 ordered rows; each Save changes only this isolated fixture.</p>
<table aria-label="20 QA rows"><tbody>${labels.map((label, index) => `<tr data-row="${index + 1}"><th scope="row">${label}</th><td><button type="button" data-row="${index + 1}">Save ${label}</button></td><td id="status-${index + 1}" role="status">Pending ${label}</td></tr>`).join('')}</tbody></table>
<script>document.querySelectorAll('button').forEach(button=>button.onclick=async()=>{
 const row=Number(button.dataset.row); button.disabled=true;
 const response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({row})});
 const result=await response.json();
 document.querySelector('#status-'+row).textContent=response.ok?'Saved Row '+String(row).padStart(2,'0')+' receipt '+result.receipt:'Blocked Row '+String(row).padStart(2,'0')+': '+result.error;
});window.unblockOwnedRow=async()=>{
 await fetch('/unblock',{method:'POST'}); const button=document.querySelector('button[data-row="13"]');
 button.disabled=false; document.querySelector('#status-13').textContent='Pending Row 13';
};</script>`;

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function contentText(content) { return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') : ''; }
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
function toolsFrom(messages) {
  const names = new Map();
  for (const message of messages || []) for (const call of message.tool_calls || []) names.set(call.id, call.function?.name);
  return (messages || []).filter(message => message.role === 'tool').map(message => ({
    name: names.get(message.tool_call_id) || message.name, result: toolObject(message.content), content: contentText(message.content),
  }));
}
function intent(phase) {
  return { request_kind: 'execute', scope_relation: phase === 'initial' ? 'new' : 'continue',
    requires_state_change: true, requires_submission: false, messaging: null,
    deliverables: ['20 individually saved rows, with verified receipts and accurate progress.'],
    allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
    completion_requirements: { download: false }, read_scope: 'visible_page',
    expected_items: { count: 20, item_type: 'row', ordered: true, required_fields: ['receipt'] },
    summary: 'Save and verify each owned QA row exactly once; preserve progress across interruption and report blocked work honestly.',
    steps: [{ id: '1', action: 'Use the current ledger and fresh page to save only unfinished rows, verify each receipt, and reconcile all 20 rows.' }],
    memory: { use_progress_ledger: true, progress_ledger_policy: 'enabled', progress_action: 'save' }, scheduling: null, risks: [] };
}
const checkpoint = deferred();
const state = { phase: 'initial', needLedger: true, ledger: [], tree: '', pendingRow: null, deferredRow: null,
  requests: [], calls: [], judgments: [], runs: {}, receipts: [], attempts: [], events: [],
  injected429: false, retryObserved: false, falseDoneAttempted: false, providerError: null, blocked: true };
let heldResponse, toolSequence = 0;
function emit(name, args, row = null) {
  const id = `owned-bulk-${++toolSequence}`;
  state.calls.push({ id, phase: state.phase, name, args, row });
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
function clickRow(row) {
  const label = labels[row - 1];
  const line = state.tree.split('\n').find(line => line.includes(`button "Save ${label}"`));
  const ref = line?.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref, `A fresh browser read must expose Save ${label}.`);
  assert.ok(!state.ledger.some(item => Number(item.fields?.expectedOrdinal) === row && item.status === 'processed'), 'Never click a ledger-completed row.');
  state.pendingRow = row; state.deferredRow = null;
  return emit('click_ax', { ref_id: ref }, row);
}
function actionResponse(input) {
  const tools = toolsFrom(input.messages), last = tools.at(-1);
  if (state.needLedger) { state.needLedger = false; return emit('progress_read', { currentTaskOnly: true, limit: 10 }); }
  if (last?.name === 'progress_read') {
    assert.equal(last.result?.success, true, last.content);
    if (last.result.offset === 0) state.ledger = [];
    state.ledger.push(...last.result.rows);
    const nextOffset = last.result.offset + last.result.rows.length;
    if (nextOffset < last.result.counts.total) return emit('progress_read', { currentTaskOnly: true, offset: nextOffset, limit: 10 });
    assert.equal(state.ledger.length, 20, 'The active ledger must retain the original 20 rows on every continuation.');
    if (state.phase === 'initial' && state.ledger.filter(row => row.status === 'processed').length === 5) return null;
    if (state.phase === 'recover' && !state.reopened) {
      const blocked = state.ledger.filter(row => row.status === 'failed');
      assert.equal(blocked.length, 1); assert.equal(Number(blocked[0].fields.expectedOrdinal), 13);
      assert.equal(state.ledger.filter(row => row.status === 'processed').length, 19);
      state.reopened = true;
      return emit('progress_update', { reopen: true, items: [{ id: blocked[0].id, status: 'pending', reason: 'User explicitly authorized retry after unblocking this row.' }] });
    }
    const unfinished = state.ledger.find(row => ['pending', 'acted'].includes(row.status));
    if (unfinished) {
      const row = Number(unfinished.fields?.expectedOrdinal);
      assert.ok(row >= 1 && row <= 20, 'Use the app-owned ordered row identity.');
      if (state.phase === 'resume' && !state.firstResumedRow) { assert.equal(row, 6); state.firstResumedRow = row; }
      state.deferredRow = row;
      return emit('get_accessibility_tree', { filter: 'all', maxChars: 6000 });
    }
    if (state.phase === 'resume') {
      assert.equal(state.ledger.filter(row => row.status === 'processed').length, 19);
      assert.equal(state.ledger.filter(row => row.status === 'failed').length, 1);
      state.falseDoneAttempted = true;
      return emit('done', { outcome: 'success', summary: 'All 20 rows were saved successfully.' });
    }
    assert.equal(state.ledger.filter(row => row.status === 'processed').length, 20);
    return emit('get_accessibility_tree', { filter: 'all', maxChars: 6000 });
  }
  if (last?.name === 'click_ax') return emit('get_accessibility_tree', { filter: 'all', maxChars: 6000 });
  if (last?.name === 'get_accessibility_tree') {
    assert.ok(last.result?.pageContent, last.content); state.tree = last.result.pageContent;
    if (state.pendingRow) {
      const row = state.pendingRow, label = labels[row - 1], receipt = `owned-row-${String(row).padStart(2, '0')}`;
      const saved = state.tree.includes(`Saved ${label} receipt ${receipt}`);
      const blocked = state.tree.includes(`Blocked ${label}:`);
      assert.ok(saved || blocked, `An actual page read must resolve the attempted ${label}.`);
      const ledgerRow = state.ledger.find(item => Number(item.fields?.expectedOrdinal) === row);
      state.pendingRow = null;
      return emit('progress_update', { items: [{ id: ledgerRow.id, status: saved ? 'processed' : 'failed',
        fields: { receipt: saved ? receipt : null }, ...(blocked ? { reason: 'Owned fixture blocked this row; it remains unsaved.' } : {}) }] }, row);
    }
    if (state.deferredRow) return clickRow(state.deferredRow);
    return emit('done', { outcome: 'success', summary: 'All 20 owned QA rows were individually saved and verified exactly once.' });
  }
  if (last?.name === 'progress_update') {
    assert.equal(last.result?.success, true, last.content);
    return emit('progress_read', { currentTaskOnly: true, limit: 10 });
  }
  if (last?.name === 'done' && state.phase === 'resume') {
    assert.equal(last.result?.blockedDone, true, 'A failed row must reject the false all-20 success.');
    assert.equal(last.result?.progressLedgerBlock, true);
    state.falseDoneBlocked = true;
    return emit('done', { outcome: 'partial', summary: '19 of 20 rows were saved and verified. Row 13 remains blocked; no completed row was repeated.' });
  }
  throw new Error(`Unexpected bulk action boundary ${last?.name}.`);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/save') {
      let body = ''; for await (const chunk of request) body += chunk;
      const { row } = JSON.parse(body); assert.ok(Number.isInteger(row) && row >= 1 && row <= 20);
      state.attempts.push({ row, phase: state.phase, at: Date.now() });
      const duplicate = state.receipts.some(item => item.row === row), blocked = row === 13 && state.blocked;
      response.writeHead(blocked || duplicate ? 409 : 200, { 'Content-Type': 'application/json' });
      if (blocked || duplicate) response.end(JSON.stringify({ error: blocked ? 'Resolve fixture blocker before retrying.' : 'Duplicate side effect is forbidden.' }));
      else { const receipt = { row, receipt: `owned-row-${String(row).padStart(2, '0')}`, phase: state.phase }; state.receipts.push(receipt); response.end(JSON.stringify(receipt)); }
      return;
    }
    if (request.url === '/unblock') { state.blocked = false; response.writeHead(200); response.end('ok'); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(pageHtml); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body), system = contentText(input.messages?.[0]?.content);
    const isJudge = system.startsWith('Evaluate only the observable requirements of the genuine user task');
    const isAction = !isJudge && Array.isArray(input.tools) && input.tools.length > 0;
    state.requests.push({ at: Date.now(), phase: state.phase, kind: isJudge ? 'judge' : isAction ? 'action' : 'intent' });
    if (isAction && state.receipts.length === 1 && !state.injected429) {
      const last = toolsFrom(input.messages).at(-1); assert.equal(last?.name, 'click_ax');
      state.injected429 = true; state.rateLimitedMessages = input.messages; state.rateLimitedAt = Date.now();
      response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' }); response.end(JSON.stringify({ error: { message: 'Owned fixture rate-limit test.' } })); return;
    }
    if (isAction && state.injected429 && !state.retryObserved) {
      assert.deepEqual(input.messages, state.rateLimitedMessages, 'HTTP429 must retry exactly the inference context after the completed browser action.');
      assert.equal(state.attempts.length, 1, 'No browser action may replay during the model cooldown.');
      state.retryObserved = true; state.retryAt = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    // WebBrain's fixed-choice questions, read the way a model would read this
    // fixture (its row receipts say each save was recorded).
    const fixedChoice = fixtureFixedChoiceReply(input.messages);
    let completion;
    if (fixedChoice) {
      completion = { role: 'assistant', content: fixedChoice };
    } else if (isJudge) {
      const outcome = state.receipts.length === 20 ? 'succeeded' : 'pending';
      state.judgments.push({ phase: state.phase, receipts: state.receipts.length, outcome });
      completion = { role: 'assistant', content: JSON.stringify({ outcome, reason: outcome === 'succeeded' ? 'All 20 independent saved receipts are visible and recorded.' : 'The complete 20-row result is not yet present.' }) };
    } else if (!isAction) {
      completion = { role: 'assistant', content: JSON.stringify(system.startsWith('Classify the user task for a browser automation progress ledger.')
        ? { mode: 'active', allowedActions: ['save'], forbiddenActions: [], targets: labels, workflowFields: [], confidence: 1, pageScopePolicy: 'page', reason: 'Explicit repeated owned save task.' }
        : intent(state.phase)) };
    } else {
      completion = actionResponse(input);
      if (!completion) {
        checkpoint.resolve(); heldResponse = response;
        await new Promise(resolve => response.once('close', resolve)); return;
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-bulk-${state.requests.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  } catch (error) {
    state.providerError = error.message;
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/rows`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-bulk-resume-mv3-'));
let context;
try {
  const extension = path.resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 1100 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => { const url = new URL(route.request().url()); return url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:' ? route.continue() : route.abort('blockedbyclient'); });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  await worker.evaluate(() => {
    const send = fetch.bind(globalThis); globalThis.bulkFixtureNetwork = { allowed: [], blocked: [] };
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)) { bulkFixtureNetwork.allowed.push(url.origin); return send(input, options); }
      bulkFixtureNetwork.blocked.push(url.origin); return Promise.reject(new Error('Owned bulk fixture blocks external network.'));
    };
  });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.bulkEvents = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') bulkEvents.push({ requestId: event.requestId, type: event.type, data: event.data }); });
    await chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never',
      screenshotFallback: false, autoScreenshot: false, maxAgentSteps: 150, systemOneEnabled: false, tracingEnabled: false,
      agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `${origin}/v1`, model: 'minimax/minimax-m3', contextWindow: 1000000, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  assert.ok(tabId);
  const initial = message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-bulk-initial', locale: 'en' });
  let checkpointTimer;
  try {
    await Promise.race([checkpoint.promise, initial.then(result => { throw new Error(`Initial run ended before its checkpoint: ${JSON.stringify(result).slice(0, 1500)}; provider=${state.providerError}`); }),
      new Promise((_, reject) => { checkpointTimer = setTimeout(() => reject(new Error(`Bulk checkpoint timed out; provider=${state.providerError}; calls=${JSON.stringify(state.calls.slice(-5))}`)), 45000); })]);
  } finally { clearTimeout(checkpointTimer); }
  assert.equal(state.receipts.length, 5); assert.equal(state.attempts.length, 5);
  const firstLedger = state.initialLedger = await message('get_progress', { tabId, args: { currentTaskOnly: true } });
  assert.equal(firstLedger.counts.processed, 5); assert.equal(firstLedger.counts.total, 20);
  assert.equal((await message('abort', { tabId })).ok, true);
  state.runs.initial = await initial;
  assert.match(state.runs.initial.content, /Stopped by user/);
  assert.equal(state.receipts.length, 5, 'Stop must not dispatch row6 from the held inference.');
  state.afterAbortLedger = await message('get_progress', { tabId, args: { currentTaskOnly: true } });
  assert.equal(state.afterAbortLedger.counts.processed, 5);
  state.phase = 'resume'; state.needLedger = true; state.tree = '';
  state.runs.resume = await message('continue', { tabId, mode: 'act', requestId: 'owned-bulk-resume' });
  assert.equal(state.providerError, null);
  assert.equal(state.firstResumedRow, 6); assert.equal(state.falseDoneBlocked, true);
  assert.equal(state.receipts.length, 19); assert.equal(state.attempts.length, 20);
  assert.match(state.runs.resume.content, /19 of 20/); assert.match(state.runs.resume.content, /Row 13 remains blocked/);
  state.partialLedger = await message('get_progress', { tabId, args: { currentTaskOnly: true } });
  assert.equal(state.partialLedger.counts.processed, 19); assert.equal(state.partialLedger.counts.failed, 1);
  await page.evaluate(() => window.unblockOwnedRow());
  state.phase = 'recover'; state.needLedger = true; state.tree = '';
  state.runs.recover = await message('continue', { tabId, mode: 'act', requestId: 'owned-bulk-recover' });
  assert.equal(state.providerError, null);
  state.finalLedger = await message('get_progress', { tabId, args: { currentTaskOnly: true } });
  assert.equal(state.finalLedger.counts.total, 20); assert.equal(state.finalLedger.counts.processed, 20);
  assert.equal(state.finalLedger.counts.failed, 0); assert.equal(state.receipts.length, 20);
  assert.equal(state.attempts.length, 21, 'Only the one blocked row may need a second attempt.');
  for (let row = 1; row <= 20; row++) {
    assert.equal(state.receipts.filter(receipt => receipt.row === row).length, 1, `Row ${row} must have one actual side effect.`);
    assert.equal(state.attempts.filter(attempt => attempt.row === row).length, row === 13 ? 2 : 1, `Row ${row} must never be replayed.`);
  }
  // Continue returns the final content; its tool updates arrive on the actual
  // background channel with the UI's compact result contract.
  state.events = await harness.evaluate(() => bulkEvents);
  const finalDone = state.events.findLast(event => event.requestId === 'owned-bulk-recover' && event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
  assert.equal(finalDone?.outcome, 'success'); assert.notEqual(finalDone?.success, false);
  assert.equal(state.injected429, true); assert.equal(state.retryObserved, true);
  assert.ok(state.retryAt - state.rateLimitedAt >= 4900, 'Exercise the real model cooldown instead of mocking its sleep.');
  assert.deepEqual(await page.locator('[role=status]').allTextContents(), labels.map((label, index) => `Saved ${label} receipt owned-row-${String(index + 1).padStart(2, '0')}`));
  state.network = await worker.evaluate(() => bulkFixtureNetwork);
  assert.equal(state.events.filter(event => event.type === 'run_complete' && event.requestId === 'owned-bulk-initial').at(-1)?.data?.status, 'stopped');
  assert.equal(state.events.filter(event => event.type === 'run_complete' && event.requestId === 'owned-bulk-recover').at(-1)?.data?.status, 'completed');
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(state, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
  console.log(JSON.stringify({ passed: true, rows: 20, attempts: state.attempts.length, receipts: state.receipts.length,
    firstResumedRow: state.firstResumedRow, falseSuccessBlocked: state.falseDoneBlocked, http429RetryMs: state.retryAt - state.rateLimitedAt, providerRequests: state.requests.length }));
} catch (error) {
  if (context) state.events = await context.pages().find(page => page.url().includes('/settings.html'))?.evaluate(() => window.bulkEvents || []).catch(() => []);
  await fs.writeFile(path.join(out, 'failure-evidence.json'), JSON.stringify(state, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
  throw error;
} finally {
  heldResponse?.destroy(); await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-bulk-resume-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
