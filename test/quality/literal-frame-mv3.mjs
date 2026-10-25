import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';

// Real installed background/planner/Agent/content/completion flows. Only the
// provider and owned web application endpoints are deterministic fixtures.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/literal-frame-mv3');
await fs.mkdir(out, { recursive: true });
const digest = text => createHash('sha256').update(text).digest('hex');
const richBody = '\n\n' + Array.from({ length: 85 }, (_, index) =>
  `${String(index + 1).padStart(3, '0')}. Türkçe: ı İ ş ğ ü ö ç; 中文：准确保存；العربية: اختبار； Emoji: 🧠 ✅ e\u0301\nconst literal = "<b>not markup</b>"; // $price & backticks: \`code\``).join('\n\n\n') + '\n\n';
const frameBody = 'Nested cross-origin QA document\nTürkçe: değiştirilmeden kaydet.\n中文：保留全部文本。\nالعربية: احفظ النص.\nEmoji: 🧠 ✅\nLiteral: <script>text only</script> & "quotes".';
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
function toolObject(content) {
  const text = textContent(content);
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
function toolsFrom(messages) {
  const names = new Map();
  for (const message of messages || []) for (const call of message.tool_calls || []) names.set(call.id, call.function?.name);
  return (messages || []).filter(message => message.role === 'tool').map(message => ({
    name: names.get(message.tool_call_id) || message.name, result: toolObject(message.content), content: textContent(message.content),
  }));
}
// An acknowledged native input with interrupted observation permits only a fresh
// receipt read. It never supplies a success verdict or permission to repeat input.
function acknowledgedNativeReceiptDecision(entry, last) {
  const fail = reason => ({ handled: true, failure: reason, step: { name: 'done', args: {
    outcome: 'failed', summary: reason + ' No duplicate save was attempted.' } } });
  const recovery = entry.receiptReconciliation;
  if (recovery) {
    if (recovery.complete || last?.name !== 'read_page') return fail('The bounded save receipt reconciliation cannot be repeated.');
    const result = last.result;
    if (!result || result.success === false || result.error) return fail('The independent save receipt read failed.');
    if (['url', 'pageUrl', 'currentUrl'].some(key => typeof result[key] === 'string' && result[key] !== entry.url))
      return fail('The independent receipt belongs to another document.');
    if (!recovery.receiptVerified) {
      const visible = [result.text, result.pageContent, result.content].filter(value => typeof value === 'string').join('\n');
      const receipts = [...visible.matchAll(/Owned QA receipt: saved exactly once\. SHA256 ([a-f0-9]{64}); characters ([0-9]+)/g)];
      if (receipts.length !== 1 || receipts[0][1] !== digest(entry.body) || Number(receipts[0][2]) !== entry.body.length)
        return fail('No exact current saved-document receipt was independently observed.');
      recovery.receiptVerified = true;
      recovery.receiptSha256 = receipts[0][1];
      recovery.receiptCharacters = Number(receipts[0][2]);
    }
    if (result.hasMore === true) {
      if (!result.continuationArgs || typeof result.continuationArgs !== 'object' || Array.isArray(result.continuationArgs))
        return fail('The independent saved-document continuation is unavailable.');
      recovery.readCount++;
      return { handled: true, step: { name: 'read_page', args: result.continuationArgs } };
    }
    recovery.complete = true;
    return { handled: true, step: { name: 'done', args: { outcome: 'success',
      summary: 'The large literal document was saved once and independently verified.' } } };
  }
  const result = last?.result, issued = entry.calls.at(-1);
  const exactAcknowledgedUncertainty = last?.name === 'click_ax' && issued?.name === 'click_ax'
    && entry.calls.filter(call => call.name === 'click_ax').length === 1
    && typeof issued.args?.ref_id === 'string' && result?.ref_id === issued.args.ref_id
    && result.success === false && result.method === 'cdp-native-button' && result.initialTrustedNativeButton === true
    && result.nativeInputAcknowledged === true && result.observationInterrupted === true
    && result.dispatched === true && result.noDispatch !== true && result.outcomeUnknown === true
    && result.retryable === false && result.trusted === false && result.verified === false;
  if (!exactAcknowledgedUncertainty) return null;
  entry.receiptReconciliation = { ref_id: result.ref_id, readCount: 1, receiptVerified: false, complete: false,
    inputReplayAllowed: false, receiptSource: 'subsequent-current-read_page-tool-result' };
  return { handled: true, step: { name: 'read_page', args: { limit: 6000 } } };
}
const providerRecoveryChecks = [];
function checkReceiptRecoveryPolicy() {
  const body = 'Neutral exact document 🧠', ref = 'ref_123';
  const uncertain = { success: false, method: 'cdp-native-button', initialTrustedNativeButton: true, ref_id: ref,
    nativeInputAcknowledged: true, observationInterrupted: true, dispatched: true, outcomeUnknown: true,
    retryable: false, trusted: false, verified: false };
  const make = () => ({ body, url: 'https://literal.fixture.invalid/rich', calls: [{ name: 'click_ax', args: { ref_id: ref } }] });
  const call = result => ({ name: 'click_ax', result });
  const observed = text => ({ name: 'read_page', result: { text, hasMore: false } });
  const receipt = 'Owned QA receipt: saved exactly once. SHA256 ' + digest(body) + '; characters ' + body.length;
  const record = (name, check) => { check(); providerRecoveryChecks.push({ name, passed: true }); };
  record('full native ACK alone chooses read-only and never success', () => {
    const entry = make(), decision = acknowledgedNativeReceiptDecision(entry, call(uncertain));
    assert.deepEqual(decision.step, { name: 'read_page', args: { limit: 6000 } });
    assert.equal(entry.receiptReconciliation.receiptVerified, false); assert.equal(entry.receiptReconciliation.inputReplayAllowed, false);
  });
  record('only exact independently read receipt permits normal completion', () => {
    const entry = make(); acknowledgedNativeReceiptDecision(entry, call(uncertain));
    assert.equal(acknowledgedNativeReceiptDecision(entry, observed(receipt)).step.args.outcome, 'success');
    assert.equal(entry.receiptReconciliation.receiptVerified, true);
  });
  for (const [name, text] of [['missing receipt', 'No receipt yet.'], ['wrong receipt digest', receipt.replace(digest(body), '0'.repeat(64))],
    ['wrong receipt character count', receipt.replace('characters ' + body.length, 'characters 1')], ['duplicate receipt', receipt + '\n' + receipt]]) {
    record(name + ' remains failed without replay', () => {
      const entry = make(); acknowledgedNativeReceiptDecision(entry, call(uncertain));
      const decision = acknowledgedNativeReceiptDecision(entry, observed(text));
      assert.equal(decision.step.name, 'done'); assert.equal(decision.step.args.outcome, 'failed'); assert.ok(decision.failure);
      assert.equal(entry.calls.filter(item => item.name === 'click_ax').length, 1);
    });
  }
  for (const [name, delta] of [['lost release ACK', { nativeInputAcknowledged: false }], ['explicit no dispatch', { noDispatch: true }],
    ['undispatched input', { dispatched: false }], ['wrong original control', { ref_id: 'ref_other' }]]) {
    record(name + ' is an unhandled failure', () => {
      assert.equal(acknowledgedNativeReceiptDecision(make(), call({ ...uncertain, ...delta })), null);
    });
  }
  record('a repeated click is never reconciled or replayed', () => {
    const entry = make(); entry.calls.push({ name: 'click_ax', args: { ref_id: ref } });
    assert.equal(acknowledgedNativeReceiptDecision(entry, call(uncertain)), null);
  });
  record('failed or foreign document read cannot prove a save', () => {
    for (const result of [{ success: false, error: 'Read refused.' }, { text: receipt, url: 'https://other.fixture.invalid/' }]) {
      const entry = make(); acknowledgedNativeReceiptDecision(entry, call(uncertain));
      assert.equal(acknowledgedNativeReceiptDecision(entry, { name: 'read_page', result }).step.args.outcome, 'failed');
    }
  });
  record('completed receipt reconciliation cannot restart input or another read', () => {
    const entry = make(); acknowledgedNativeReceiptDecision(entry, call(uncertain));
    acknowledgedNativeReceiptDecision(entry, observed(receipt));
    const repeat = acknowledgedNativeReceiptDecision(entry, call(uncertain));
    assert.equal(repeat.step.name, 'done'); assert.equal(repeat.step.args.outcome, 'failed');
    assert.equal(entry.calls.length, 1);
  });
}
checkReceiptRecoveryPolicy();

const css = '<style>body{font:18px sans-serif;margin:24px}label{display:block;margin:12px 0}input,textarea,button{font:inherit;padding:8px}textarea{width:90%;height:150px}iframe{border:2px solid #777;width:95%;height:780px}[contenteditable]{white-space:pre-wrap;min-height:180px;max-height:360px;overflow:auto;border:1px solid #888;padding:12px}pre{white-space:pre-wrap}</style>';
const saveScript = rich => `<script>
window.qaInputEvents=0;window.qaState='';
const editor=document.querySelector(${rich ? "'#editor'" : "'[name=body]'"});
editor.addEventListener('input',()=>{qaInputEvents++;qaState=${rich ? "editor.innerText" : "editor.value"};${rich ? "queueMicrotask(()=>{editor.dataset.stateCharacters=String(qaState.length);});" : ''}});
document.querySelector('form').onsubmit=async event=>{event.preventDefault();
const body=${rich ? "qaState" : "editor.value"};const title=${rich ? "'Large literal QA document'" : "document.querySelector('[name=subject]').value"};
const response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,body,inputEvents:qaInputEvents})});
const receipt=await response.json();document.querySelector('#receipt').textContent='Owned QA receipt: saved exactly once. SHA256 '+receipt.sha256+'; characters '+body.length;
document.querySelector('#preview').textContent=body;document.querySelector('form').hidden=true;
};</script>`;
const pages = new Map([
  ['https://literal.fixture.invalid/rich', `<!doctype html>${css}<title>Owned literal editor</title><h1>Large literal QA document</h1><p id="receipt" role="status"></p><form><div id="editor" role="textbox" aria-label="Document body" contenteditable="true"></div><button type="submit">Save document</button></form><pre id="preview"></pre>${saveScript(true)}`],
  ['https://frame-top.fixture.invalid/document', `<!doctype html>${css}<title>Owned nested document</title><h1>Nested cross-origin document</h1><iframe title="Document wrapper" src="https://frame-middle.fixture.invalid/wrapper"></iframe>`],
  ['https://frame-middle.fixture.invalid/wrapper', `<!doctype html>${css}<title>Owned wrapper</title><h2>Second origin wrapper</h2><iframe title="Nested editor" src="https://frame-editor.fixture.invalid/editor"></iframe>`],
  ['https://frame-editor.fixture.invalid/editor', `<!doctype html>${css}<title>Owned nested editor</title><h2>Nested QA editor</h2><p id="receipt" role="status"></p><form id="document-form"><label>Subject <input name="subject" required></label><label>Body <textarea name="body" required></textarea></label><button id="save" type="submit">Save nested document</button></form><pre id="preview"></pre>${saveScript(false)}`],
]);
const cases = new Map([
  ['rich', { marker: 'Owned practical case rich.', url: 'https://literal.fixture.invalid/rich', body: richBody, calls: [], saves: [], requests: [], judges: 0 }],
  ['rich-trusted-types', { marker: 'Owned practical case rich-trusted-types.', url: 'https://literal.fixture.invalid/rich-trusted-types', body: richBody,
    trustedTypes: true, calls: [], saves: [], requests: [], judges: 0 }],
  ['frame', { marker: 'Owned practical case frame.', url: 'https://frame-top.fixture.invalid/document', body: frameBody, calls: [], saves: [], requests: [], judges: 0 }],
]);
pages.set('https://literal.fixture.invalid/rich-trusted-types', pages.get('https://literal.fixture.invalid/rich'));
const iframeSteps = [
  { name: 'get_frames', args: {} },
  { name: 'iframe_read', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: 'input,textarea,button', limit: 50 } },
  { name: 'iframe_read', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '[name="subject"]' } },
  { name: 'iframe_type', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '[name="subject"]', matchIndex: 0, text: 'Nested QA document', clear: true } },
  { name: 'iframe_read', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '[name="body"]' } },
  { name: 'iframe_type', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '[name="body"]', matchIndex: 0, text: frameBody, clear: true } },
  { name: 'verify_form', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '#document-form' } },
  { name: 'iframe_read', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '#save' } },
  { name: 'iframe_click', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '#save', matchIndex: 0 } },
  { name: 'iframe_read', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '#receipt' } },
  { name: 'verify_form', args: { urlFilter: 'frame-editor.fixture.invalid/editor', selector: '#document-form' } },
];
const pageTextQuestions = [];
const server = http.createServer(async (request, response) => {
  let current;
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body), authority = JSON.stringify(input.messages || []);
    // A status the page showed is read with a question that carries only that
    // text, not a tab's task; read it the way a model would.
    const pageTextReply = fixturePageTextReply(input.messages);
    if (pageTextReply) {
      pageTextQuestions.push(input);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: `owned-page-text-${pageTextQuestions.length}`,
        choices: [{ message: { role: 'assistant', content: pageTextReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      return;
    }
    const matches = [...cases.entries()].filter(([, value]) => authority.includes(value.marker));
    assert.equal(matches.length, 1, 'A provider request retains exactly one owned tab task.');
    const [kind, entry] = matches[0]; current = entry; current.requests.push(input);
    await new Promise(resolve => setTimeout(resolve, 120));
    const isJudge = textContent(input.messages?.[0]?.content).startsWith('Evaluate only the observable requirements of the genuine user task');
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    let completion;
    if (isJudge) {
      current.judges++;
      const observedReceipt = authority.includes('Owned QA receipt: saved exactly once') && authority.includes(digest(current.body));
      const outcome = observedReceipt ? 'succeeded' : 'uncertain';
      (current.judgeOutcomes ||= []).push({ outcome, observedReceipt });
      completion = { role: 'assistant', content: JSON.stringify({ outcome,
        reason: observedReceipt ? 'Fresh app-owned save receipt contains the expected literal body digest.' : 'No exact current save receipt in supplied evidence.' }) };
    } else if (!isAction) completion = { role: 'assistant', content: JSON.stringify({
      request_kind: 'execute', scope_relation: 'new', requires_state_change: true, requires_submission: true, messaging: null,
      deliverables: ['The exact literal document saved once and verified in the owned application.'],
      completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
      read_scope: 'visible_page', summary: 'Write the exact authorized body, save once, and independently verify the document receipt.',
      steps: [{ id: '1', action: 'Write, save and verify the exact document.' }], memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [],
    }) };
    else {
      const tools = toolsFrom(input.messages), last = tools.at(-1);
      let step;
      const receiptDecision = acknowledgedNativeReceiptDecision(current, last);
      if (receiptDecision?.handled) {
        if (receiptDecision.failure) current.failedTool = { name: last?.name, result: last?.result, recoveryFailure: receiptDecision.failure };
        step = receiptDecision.step;
      } else if (last?.result?.success === false || last?.result?.error) {
        current.failedTool = { name: last.name, result: last.result };
        step = { name: 'done', args: { outcome: 'failed', summary: 'The owned practical regression encountered a concrete tool failure. No duplicate save was attempted.' } };
      } else if (kind === 'frame') step = iframeSteps[current.calls.length] || { name: 'done', args: { outcome: 'success', summary: 'The exact nested document was saved once and independently verified.' } };
      else {
        const fieldDone = tools.some(tool => tool.name === 'set_field' && tool.result?.success === true);
        const saved = tools.some(tool => tool.name === 'click_ax' && tool.result?.success === true);
        if (!last || last.name === 'set_field') step = { name: 'get_accessibility_tree', args: { filter: 'visible' } };
        else if (last.name === 'get_accessibility_tree' && !fieldDone) {
          const ref = last.result.pageContent.split('\n').find(line => /textbox "Document body"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          assert.ok(ref, 'Only the observed actual editor ref can receive the literal body.');
          step = { name: 'set_field', args: { ref_id: ref, text: current.body } };
        } else if (last.name === 'get_accessibility_tree' && !saved) {
          const ref = last.result.pageContent.split('\n').find(line => /button "Save document"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          assert.ok(ref, 'Only the observed actual save ref can commit the document.');
          step = { name: 'click_ax', args: { ref_id: ref } };
        } else if (last.name === 'click_ax') step = { name: 'read_page', args: { limit: 6000 } };
        else if (last.name === 'read_page' && last.result.hasMore) step = { name: 'read_page', args: last.result.continuationArgs };
        else step = { name: 'done', args: { outcome: 'success', summary: 'The large literal document was saved once and independently verified.' } };
      }
      assert.ok(current.calls.length < 20, 'No practical fixture may hide an unbounded terminal retry loop.');
      current.calls.push(step);
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-${kind}-${current.calls.length}`, type: 'function',
        function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-document-${current.requests.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  } catch (error) {
    if (current) current.providerError = error.message;
    response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-literal-frame-mv3-'));
let context;
const results = [];
try {
  const extension = path.resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const html = pages.get(url.origin + url.pathname);
    if (html) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html,
      ...(url.pathname === '/rich-trusted-types' ? { headers: { 'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types 'none'" } } : {}) });
    if (url.pathname === '/save' && ['literal.fixture.invalid', 'frame-editor.fixture.invalid'].includes(url.hostname)) {
      assert.equal(request.method(), 'POST');
      const current = cases.get(url.hostname === 'literal.fixture.invalid'
        ? request.frame().url().endsWith('/rich-trusted-types') ? 'rich-trusted-types' : 'rich' : 'frame');
      const submitted = request.postDataJSON(); current.saves.push(submitted);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, sha256: digest(submitted.body) }) });
    }
    if (url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:') return route.continue();
    return route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  // The worker can be reported before its extension APIs have finished
  // loading; wait for them before wrapping them.
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await worker.evaluate(() => !!(globalThis.chrome?.tabs && globalThis.chrome?.runtime?.id)).catch(() => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await worker.evaluate(() => {
    globalThis.ownedMonitorCalls = [];
    const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      const result = await sendMessage(tabId, message, options);
      if (/^page_monitor_(prepare|dispatch)$/.test(message?.action || '')) ownedMonitorCalls.push({
        tabId, action: message.action, params: message.params, options, result,
      });
      return result;
    };
    const send = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      return url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)
        ? send(input, options) : Promise.reject(new Error('Owned practical regression blocks external requests.'));
    };
  });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.ownedRuns = {};
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update' && ownedRuns[event.requestId]) ownedRuns[event.requestId].events.push({ type: event.type, data: event.data });
    });
    await chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never',
      screenshotFallback: false, autoScreenshot: false, maxAgentSteps: 22, systemOneEnabled: false, tracingEnabled: false,
      agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'minimax/minimax-m3', contextWindow: 1000000, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  for (const [kind, current] of cases) {
    if (process.env.WEBBRAIN_QUALITY_CASE_FILTER && !new RegExp(process.env.WEBBRAIN_QUALITY_CASE_FILTER).test(kind)) continue;
    const started = Date.now(), page = await context.newPage();
    await page.goto(current.url, { waitUntil: 'networkidle' });
    if (current.trustedTypes) assert.equal(await page.evaluate(() => {
      try { document.createElement('div').innerHTML = '<b>blocked main-world sink</b>'; return false; }
      catch (error) { return error.name === 'TypeError'; }
    }), true, 'The real main-world Trusted Types restriction remains enforced.');
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, current.url);
    assert.ok(tabId, 'Resolve exactly the owned fixture tab.');
    const requestId = `owned-literal-${kind}`;
    const task = `${current.marker}\nSave exactly one owned QA document on this page${kind === 'frame' ? ' in its nested cross-origin editor at frame-editor.fixture.invalid/editor, with Subject="Nested QA document"' : ' using its Document body rich editor'}. Preserve all characters, literal markup, whitespace and newlines below. Independently read the saved document receipt before finishing.\nExact body:\n${current.body}`;
    await harness.evaluate(({ tabId, text, requestId }) => {
      const run = ownedRuns[requestId] = { events: [], finished: false };
      chrome.runtime.sendMessage({ target: 'background', action: 'chat', tabId, text, mode: 'act', requestId, locale: 'en' })
        .then(result => { run.result = result; run.finished = true; }, error => { run.result = { error: error.message }; run.finished = true; });
    }, { tabId, text: task, requestId });
    try { await harness.waitForFunction(id => ownedRuns[id]?.finished, requestId, { timeout: 90000 }); }
    catch (error) { await message('abort', { tabId }); throw error; }
    const run = await harness.evaluate(id => ownedRuns[id], requestId);
    const document = kind !== 'frame' ? page : page.frames().find(frame => frame.url() === 'https://frame-editor.fixture.invalid/editor');
    assert.ok(document, 'The nested editor must remain on its separate third origin.');
    const receipt = await document.locator('#receipt').textContent(), preview = await document.locator('#preview').textContent();
    const done = run.result?.updates?.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
    const terminal = run.events.findLast(event => event.type === 'run_complete')?.data;
    await fs.writeFile(path.join(out, `${kind}-evidence.json`), JSON.stringify({ kind, elapsedMs: Date.now() - started, receipt, preview,
      frames: page.frames().map(frame => frame.url()), run, provider: current,
      monitorCalls: await worker.evaluate(tabId => ownedMonitorCalls.filter(call => call.tabId === tabId), tabId),
      accountsCreated: [], externalMessages: 0, providerRecoveryChecks },
      (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
    assert.equal(current.providerError, undefined, current.providerError);
    assert.equal(current.failedTool, undefined, JSON.stringify(current.failedTool));
    if (current.receiptReconciliation) {
      assert.equal(current.receiptReconciliation.receiptVerified, true, 'Acknowledged input alone never proves a saved document.');
      assert.equal(current.receiptReconciliation.complete, true, 'The bounded independent receipt read must complete normally.');
      assert.equal(current.calls.filter(call => call.name === 'click_ax').length, 1, 'Read-only reconciliation never repeats Save.');
      assert.equal(current.receiptReconciliation.inputReplayAllowed, false);
    }
    assert.equal(current.saves.length, 1, 'Save exactly once through a real application POST.');
    assert.equal(digest(current.saves[0].body), digest(current.body), 'The actual persisted body must preserve every authorized character.');
    assert.ok(current.saves[0].inputEvents > 0, 'Native input events must update application state.');
    assert.equal(digest(preview), digest(current.body), 'The independent rendered saved body must equal the literal.');
    assert.ok(receipt.includes(digest(current.body)), 'The rendered application receipt binds to the actual saved body.');
    assert.equal(done?.done, true, JSON.stringify(done)); assert.equal(done?.outcome, 'success', JSON.stringify(done));
    assert.equal(terminal?.status, 'completed', JSON.stringify(terminal));
    results.push({ kind, passed: true, elapsedMs: Date.now() - started, characters: current.body.length,
      sha256: digest(current.body), saves: current.saves.length, toolCalls: current.calls.length, judges: current.judges,
      origins: new Set(page.frames().map(frame => new URL(frame.url()).origin)).size, externalMessages: 0 });
    console.log(JSON.stringify(results.at(-1))); await page.close();
  }
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true,
    filtered: !!process.env.WEBBRAIN_QUALITY_CASE_FILTER, accountsCreated: [], results }, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-literal-frame-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
