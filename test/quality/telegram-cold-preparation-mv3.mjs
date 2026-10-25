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
// Whole installed MV3 cold start with actual passive page feedback and the
// public background Act request. Only the provider and owned native page are
// fixtures; no runtime gate, private binding or content result is fabricated.
const scenario = 'cold';
const extension = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION_SOURCE || path.join(workspace, 'src/chrome'));
const repositorySource = extension === path.join(workspace, 'src/chrome');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/telegram-cold-preparation-mv3');
await fs.mkdir(out, { recursive: true });
const original = 'Inspect the current Telegram Saved Messages thread using the native observation tools and report whether its identity is verified. Keep this task entirely read-only. Do not draft, send, or open another conversation.';
assert.equal(original.length, 215);
const fixtureUrl = 'https://web.telegram.org/k/#@owned_qa';
const requestId = 'owned-public-cold-read-preparation';
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
const calls = [], blockedNetwork = [], runtimeErrors = [];
let fixturePage;
let initialActionRequests = 0;
const toolCall = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [
  { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
] });
function plan() {
  return { request_kind: 'execute', scope_relation: 'new',
    deliverables: ['Report whether the native Saved Messages identity is verified'],
    requires_state_change: false, requires_submission: false, messaging: null,
    completion_requirements: { download: false }, allows_planner_shaped_result: false,
    allows_app_state_tool_evidence: false, read_scope: 'visible_page',
    expected_items: null, site_job: null,
    summary: 'Read the native Saved Messages identity without changing the conversation.',
    steps: [{ id: '1', action: 'Use chat_observe and the native read-only identity preparation to inspect the current identity.' }],
    memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
}
const html = `<!doctype html><meta charset="utf-8"><title>Owned cold native preparation lab</title><style>body{margin:0;font:18px sans-serif}.chat{margin-left:320px;width:800px}.topbar{height:70px}.user-title{display:inline-block;min-width:100px;height:40px}.bubbles-scrollable{height:450px;overflow-y:auto}.bubbles-inner{min-height:40px}.input-message-input{display:inline-block;width:650px;min-height:32px}button{width:50px;height:36px}#column-left{position:absolute;left:0;top:0;width:280px}.sidebar-header{height:64px}.btn-menu{position:absolute;top:70px;left:30px;width:220px;background:white}.btn-menu-item{height:36px}.tgico{display:inline-block;width:18px;height:18px}aside{position:absolute;left:20px;top:600px}</style><div id="column-left"><div class="sidebar-header"><div class="sidebar-header__btn-container"><button id="preparation" class="btn-icon rp btn-menu-toggle sidebar-tools-button is-visible"></button></div></div></div><div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456" data-me-as-notes="1">Saved Messages</span></div></div></div><div class="bubbles scrolled-down"><div class="bubbles-scrollable"><div class="bubbles-inner"><div class="bubble is-in" data-mid="1" data-peer-id="123456"><div class="message">Owned harmless native row</div></div></div></div></div><div class="input-message-input" contenteditable="true" data-peer-id="123456"></div><button id="mutation" aria-label="Send">Send</button></div><aside>Passive counter <span id="counter">0</span></aside><script>window.mutations=0;window.ticks=0;window.preparationClicks=0;document.querySelector('#preparation').onclick=()=>{preparationClicks++;preparation.classList.add('menu-open');const menu=document.createElement('div');menu.className='btn-menu bottom-right active was-open';menu.innerHTML='<div class="btn-menu-item rp-overflow" role="button"><span class="tgico btn-menu-item-icon">\uea22</span><span class="i18n btn-menu-item-text">Owned settings</span></div>';document.body.append(menu);};document.querySelector('#mutation').onclick=()=>mutations++;document.querySelector('.input-message-input').addEventListener('input',()=>mutations++);document.querySelector('.input-message-input').addEventListener('keydown',e=>{if(e.key==='Enter')mutations++;});setInterval(()=>counter.textContent=String(++ticks),5000);</script>`;
const server = http.createServer(async (request,response)=>{
try {
 if(request.url!=='/v1/chat/completions'){response.writeHead(404);response.end('Owned provider only');return;}
 let raw='';for await(const chunk of request)raw+=chunk;const input=JSON.parse(raw);
 const system=contentText(input.messages[0]?.content);const action=Array.isArray(input.tools)&&input.tools.length>0;const evaluator=system.startsWith('Evaluate only the observable requirements of the genuine user task');
 const priorResults=input.messages.filter(m=>m.role==='tool').map(m=>({id:m.tool_call_id,result:toolObject(m.content)}));
 const record={at:Date.now(),stage:evaluator?'completion':action?'action':'planner',toolNames:(input.tools||[]).map(t=>t.function?.name),priorResultIds:priorResults.map(r=>r.id),aliasFailures:priorResults.filter(r=>r.result?.reason==='native_telegram_alias_binding_required').length};calls.push(record);
 if(action&&initialActionRequests===0){await fixturePage.evaluate(()=>counter.textContent=String(++ticks));}
 await new Promise(r=>setTimeout(r,400));
 let completion;
 if(evaluator)completion={role:'assistant',content:JSON.stringify({outcome:'uncertain',reason:'This fixture claims no successful identity verification.'})};
 // The chat's controls, fields, message labels and statuses, read as a model would.
 else if(MESSAGING_TEXT_KINDS.includes(fixedChoiceQuestion(input.messages)?.kind))completion={role:'assistant',content:fixtureFixedChoiceReply(input.messages)};
 else if(!action)completion={role:'assistant',content:JSON.stringify(plan())};
 else{
 initialActionRequests++;assert.ok(initialActionRequests<=4,'Bounded cold probe');
 const chunks=input.messages.flatMap(m=>{const text=contentText(m.content),parsed=toolObject(m.content);return [text.replace(/\\n/g,'\n'),parsed?.pageContent,parsed?.page?.pageContent].filter(v=>typeof v==='string');});let ref=null;for(let i=chunks.length-1;i>=0&&!ref;i--){const matches=[...chunks[i].matchAll(/(?:^|\n)\s*button \[(ref_[0-9]+)\](?=\s|$)/g)];const refs=[...new Set(matches.map(match=>match[1]))];if(refs.length===1)ref=refs[0];}record.observedButtonLines=chunks.flatMap(text=>text.split('\n').filter(line=>/^\s*button\b/.test(line)).map(line=>line.slice(0,200))).slice(-12);record.observedUnnamedRefFound=!!ref;record.observedButtonRefCount=chunks.reduce((n,text)=>n+[...text.matchAll(/\bbutton(?:[^\n]{0,160})\[(ref_[0-9]+)\]/g)].length,0);
 if(initialActionRequests===1)record.proposedRef=ref;
 if(initialActionRequests===1){assert.ok(ref,'Use sole current unnamed button ref actually exposed to model');completion={role:'assistant',content:'',tool_calls:[...toolCall('cold-joint-native-observe','chat_observe',{}).tool_calls,...toolCall('cold-joint-readonly-control','click_ax',{ref_id:ref}).tool_calls]};}
 else completion=toolCall('owned-probe-terminal','done',{outcome:'partial',summary:'The isolated read-only probe ended without claiming that the alias identity was verified.'});
 }
 record.proposedTools=(completion.tool_calls||[]).map(t=>t.function.name);response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({id:'owned-cold-'+calls.length,choices:[{message:completion,finish_reason:completion.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:30}}));
}catch(error){runtimeErrors.push(error.message);response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const intendedTempRoot = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(path.join(intendedTempRoot, 'webbrain-owned-cold-preparation-'));
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
  // The worker can be reported before its extension APIs exist; wait for them
  // before wrapping chrome.tabs (as the relaxed monitoring harness does).
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await worker.evaluate(() => !!(globalThis.chrome?.tabs?.sendMessage && globalThis.chrome?.runtime?.id)).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await worker.evaluate(() => {
    globalThis.coldPreparation = { captures: [], reads: [], clicks: [], feedback: [], scopedTrees: [] };
    let initialOwner = '', initialDocument = '', initialAxDocument = '';
    const usedBindings = new Set();
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      const result = await send(tabId, message, options);
      const params = message.params || {};
      const scope = { tabId, frameId: options?.frameId ?? null,
        ownerMatchesInitial: !!initialOwner && params._nativeChatOwner === initialOwner };
      if (message.action === 'page_monitor_capture_model') {
        if (!initialOwner && params.nativeChatOwner) initialOwner = params.nativeChatOwner;
        if (!initialDocument && result?.documentToken) initialDocument = result.documentToken;
        if (!initialAxDocument && result?.page?.documentToken) initialAxDocument = result.page.documentToken;
        coldPreparation.captures.push({ ready: result?.ready, targetCount: result?.targetCount,
          hasOwner: !!params.nativeChatOwner, ownerMatchesInitial: params.nativeChatOwner === initialOwner,
          axDocumentToken: result?.page?.documentToken,
          documentToken: result?.documentToken, documentMatchesInitial: !!initialDocument && result?.documentToken === initialDocument,
          tabId, frameId: options?.frameId ?? null });
      }
      if (message.action === 'observe_chat') coldPreparation.reads.push({ success: result?.success,
        reason: result?.reason, nativeTelegramRepair: result?.nativeTelegramRepair, ...scope });
      if (message.action === 'get_accessibility_tree') {
        if (!initialAxDocument && result?.documentToken) initialAxDocument = result.documentToken;
        coldPreparation.scopedTrees.push({ ref_id: params.ref_id, expectedDocumentToken: params.expectedDocumentToken,
          documentToken: result?.documentToken, axDocumentMatchesInitial: !!initialAxDocument && result?.documentToken === initialAxDocument, ...scope });
      }
      if (message.action === 'probe_message_recipient_guard') {
        coldPreparation.probes = (coldPreparation.probes || []).concat({ tool: params.tool,
          adapter: params.adapterName, ref_id: params.ref_id, nativeRepair: result?.nativeTelegramRepair,
          conclusive: result?.conclusive, messageSend: result?.messageSend,
          hasNativeToken: !!result?.nativeTelegramReadRepairBinding?.token, ...scope });
      }
      if (message.action === 'click_ax') {
        const token = params.nativeTelegramReadRepairBinding?.token;
        coldPreparation.clicks.push({ success: result?.success, noDispatch: result?.noDispatch,
          readonly: result?._nativeTelegramReadRepair, required: params._nativeTelegramReadRepairRequired,
          hasNativeToken: !!token, nativeBindingFirstUse: !!token && !usedBindings.has(token),
          ref_id: params.ref_id, hasExpectedDocument: !!params.expectedDocumentToken,
          expectedDocumentToken: params.expectedDocumentToken,
          axDocumentMatchesInitial: !!initialAxDocument && params.expectedDocumentToken === initialAxDocument,
          expectedPageUrl: params.expectedPageUrl, ...scope });
        if (token) usedBindings.add(token);
      }
      return result;
    };
    chrome.runtime.onMessage.addListener(message => {
      if (message.action === 'page_feedback') coldPreparation.feedback.push({
        kind: message.feedback?.kind, source: message.feedback?.source });
    });
  });
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const messageFrom = (page, action, data = {}) => page.evaluate(({ action, data }) =>
    chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await settings.evaluate(async () => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, planBeforeActMode: 'off',
    planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: false,
    maxAgentSteps: 10, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true,
    askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false, contextWindowMode: 'full' }));
  assert.equal((await messageFrom(settings, 'update_provider', { providerId: 'openrouter', config: {
    apiKey: 'owned-loopback-fake-key', baseUrl: `${origin}/v1`, model: 'openai/gpt-5.4-mini',
    contextWindow: 128000, enabled: true, supportsAskStreaming: false,
  } })).ok, true);
  assert.equal((await messageFrom(settings, 'set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(fixtureUrl);fixturePage=page;
  tabId = await settings.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  assert.ok(tabId);
  panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/src/ui/sidepanel.html`);
  await panel.evaluate(() => {
    window.ownedEvents = []; window.ownedChat = { finished: false };
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update' || event.action === 'run_complete') ownedEvents.push(event);
    });
  });
  const nativeDocumentBefore = await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin,
    peer: document.querySelector('.peer-title')?.getAttribute('data-peer-id'),
    composerEmpty: document.querySelector('.input-message-input')?.textContent === '' }));
  await panel.evaluate(({ tabId, text, requestId }) => {
    chrome.runtime.sendMessage({ target: 'background', action: 'chat', tabId, text, mode: 'act', requestId, locale: 'en' })
      .then(result => { ownedChat.result = result; ownedChat.finished = true; })
      .catch(error => { ownedChat.error = error.message; ownedChat.finished = true; });
  }, { tabId, text: original, requestId });
  await panel.waitForFunction(()=>ownedChat.finished,null,{timeout:45000});
  const run=await panel.evaluate(()=>({chat:ownedChat,events:ownedEvents}));
  const diagnostic=await worker.evaluate(()=>coldPreparation);
  const rawUi=await panel.evaluate(async tabId=>(await chrome.storage.session.get('runUi:'+tabId))['runUi:'+tabId],tabId);
  const updates=run.chat.result?.updates||[];
  const nativeDocumentAfter = await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin,
    peer: document.querySelector('.peer-title')?.getAttribute('data-peer-id'),
    composerEmpty: document.querySelector('.input-message-input')?.textContent === '' }));
  const toolEvidence = updates.filter(event => ['tool_call', 'tool_result'].includes(event.type)).map(event => ({
    type: event.type, name: event.data?.name, args: event.data?.args,
    result: event.type === 'tool_result' ? { success: event.data?.result?.success,
      noDispatch: event.data?.result?.noDispatch, dispatched: event.data?.result?.dispatched,
      skipped: event.data?.result?.skipped, reason: event.data?.result?.reason,
      error: event.data?.result?.error, readonly: event.data?.result?._nativeTelegramReadRepair,
      nativeTelegramRepair: event.data?.result?.nativeTelegramRepair } : undefined,
  }));
  evidence={passed:false,scenario,durationMs:Date.now()-startedAt,calls,diagnostic,toolEvidence,nativeDocumentBefore,nativeDocumentAfter,toolResults:updates.filter(e=>e.type==='tool_result').map(e=>({name:e.data?.name,success:e.data?.result?.success,noDispatch:e.data?.result?.noDispatch,reason:e.data?.result?.reason,readonly:e.data?.result?._nativeTelegramReadRepair})),ui:{status:rawUi?.status,successfulDone:rawUi?.successfulDone,runSucceeded:rawUi?.runSucceeded},preparationClicks:await page.evaluate(()=>preparationClicks),mutations:await page.evaluate(()=>mutations),runtimeErrors,blockedNetwork,sourceCount:Object.keys(sourceBefore).length,actualLoadedRepositorySource:repositorySource};
  assert.equal(run.chat.error,undefined);assert.deepEqual(runtimeErrors,[]);assert.equal(evidence.mutations,0);assert.ok(diagnostic.captures.some(c=>c.hasOwner&&c.ready));
  assert.ok(diagnostic.captures[0].targetCount > 0, 'The first pre-inference capture binds the private native readonly control before any observation/probe.');
  assert.equal(diagnostic.reads.length, 3, 'Retain the original native read and exactly one fresh read after each distinct issued identity preparation.');
  assert.equal(diagnostic.reads[0].reason, 'native_telegram_alias_binding_required');
  assert.equal(evidence.preparationClicks, 1); assert.equal(diagnostic.clicks.length, 2);
  assert.equal(diagnostic.probes[0].nativeRepair, true); assert.equal(diagnostic.probes[0].hasNativeToken, true);
  assert.equal(diagnostic.clicks[0].success, true); assert.equal(diagnostic.clicks[0].required, true);
  assert.equal(diagnostic.clicks[0].hasNativeToken, true); assert.equal(diagnostic.clicks[0].readonly, true);
  assert.deepEqual(diagnostic.reads.map(read => read.nativeTelegramRepair?.phase),
    ['open_menu', 'open_self_settings', 'open_self_settings']);
  assert.ok(diagnostic.reads.every(read => read.reason === 'native_telegram_alias_binding_required' && read.ownerMatchesInitial));
  const repairRefs = diagnostic.reads.slice(0, 2).map(read => read.nativeTelegramRepair.ref_id);
  assert.equal(new Set(repairRefs).size, 2, 'Each newly issued repair selects a distinct current native control.');
  assert.equal(diagnostic.reads[2].nativeTelegramRepair.ref_id, repairRefs[1], 'The still-unbound Settings control stays consumed.');
  assert.deepEqual(diagnostic.clicks.map(click => click.ref_id), repairRefs);
  assert.deepEqual(diagnostic.scopedTrees.filter(tree => tree.ref_id).map(tree => tree.ref_id), repairRefs);
  assert.equal(calls.find(call => call.stage === 'action').proposedRef, repairRefs[0]);
  assert.ok(diagnostic.clicks.every(click => click.success === true && click.required === true && click.readonly === true
    && click.hasNativeToken && click.nativeBindingFirstUse && click.ownerMatchesInitial && click.hasExpectedDocument
    && click.axDocumentMatchesInitial && click.expectedPageUrl === fixtureUrl));
  assert.equal(diagnostic.probes.length, 2);
  assert.ok(diagnostic.probes.every(probe => probe.nativeRepair === true && probe.hasNativeToken
    && probe.conclusive === true && probe.messageSend === false && probe.ownerMatchesInitial));
  const monitorDocuments = diagnostic.captures.map(capture => capture.documentToken);
  assert.ok(monitorDocuments[0]); assert.equal(new Set(monitorDocuments).size, 1);
  assert.ok(diagnostic.captures.every(capture => capture.hasOwner && capture.ownerMatchesInitial && capture.documentMatchesInitial));
  const axDocuments = [...diagnostic.scopedTrees.map(tree => tree.documentToken),
    ...diagnostic.captures.map(capture => capture.axDocumentToken).filter(Boolean),
    ...diagnostic.clicks.map(click => click.expectedDocumentToken)];
  assert.ok(axDocuments[0]); assert.equal(new Set(axDocuments).size, 1, 'AX document tokens have their own stable namespace.');
  assert.ok(diagnostic.scopedTrees.every(tree => tree.axDocumentMatchesInitial));
  assert.deepEqual(nativeDocumentAfter, nativeDocumentBefore);
  assert.equal(nativeDocumentAfter.composerEmpty, true);
  assert.deepEqual(toolEvidence.filter(event => event.type === 'tool_call').map(event => event.name),
    ['chat_observe', 'get_accessibility_tree', 'click_ax', 'chat_observe', 'get_accessibility_tree', 'click_ax', 'chat_observe', 'done']);
  assert.deepEqual(toolEvidence[0], { type: 'tool_call', name: 'chat_observe', args: {}, result: undefined });
  assert.equal(toolEvidence[1].name, 'chat_observe');
  assert.deepEqual(toolEvidence[1].result.nativeTelegramRepair, { phase: 'open_menu', ref_id: repairRefs[0] });
  assert.equal(toolEvidence[2].type, 'tool_result'); assert.equal(toolEvidence[2].name, 'click_ax');
  assert.equal(toolEvidence[2].result.skipped, true); assert.equal(toolEvidence[2].result.noDispatch, true);
  assert.equal(toolEvidence[2].result.dispatched, false, 'The stale same-response model click never dispatches.');
  assert.ok(toolEvidence.filter(event => event.type === 'tool_call' && event.name === 'chat_observe').slice(1)
    .every(event => event.args.reconcile_pending_outbound === false));
  assert.equal(evidence.ui.successfulDone, false); assert.equal(evidence.ui.runSucceeded, false,
    'Opening a readonly native menu cannot claim the still-unbound alias or delivery goal was completed.');
  evidence.passed=true;
} catch (error) {
  if (panel && !evidence) evidence = { passed: false, durationMs: Date.now() - startedAt, error: error.message,
    calls, runtimeErrors, sourceCount: Object.keys(sourceBefore).length,
    run: await panel.evaluate(() => ({ chat: window.ownedChat, events: window.ownedEvents })).catch(() => null) };
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, evidence }, null, 2));
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  const sourceAfter = await sourceHashes();
  await fs.writeFile(path.join(out, 'source-after.json'), JSON.stringify(sourceAfter, null, 2));
  const stable = JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore);
  await fs.writeFile(path.join(out, 'source-verification.json'), JSON.stringify({ sourceStable: stable,
    sourceCount: Object.keys(sourceBefore).length, root: path.relative(workspace, extension), actualLoadedRepositorySource: repositorySource, changed: Object.keys(sourceBefore)
      .filter(name => sourceBefore[name] !== sourceAfter[name]) }, null, 2));
  const resolved = await fs.realpath(profile);
  assert.equal(path.dirname(resolved).toLowerCase(), intendedTempRoot.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('webbrain-owned-cold-preparation-'));
  await fs.rm(resolved, { recursive: true, force: true });
  if (evidence) await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  assert.equal(stable, true, 'Installed product source must remain unchanged.');
}
console.log(JSON.stringify({passed:evidence.passed,scenario,durationMs:evidence.durationMs,captures:evidence.diagnostic.captures,actualReads:evidence.diagnostic.reads.length,preparationClicks:evidence.preparationClicks,mutations:evidence.mutations,sourceCount:evidence.sourceCount,sourceStable:true}));
