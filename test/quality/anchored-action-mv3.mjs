import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// A real installed MV3 run must retain the scope of a successful rooted AX
// read. The native-style detail card has a menu below the viewport, and another
// identically named menu belongs to an unrelated card. All traffic is local.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/anchored-action-mv3');
await fs.mkdir(out, { recursive: true });
const url = 'https://owned-anchored.invalid/detail';
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true, requires_submission: false,
  messaging: null, deliverables: ['The menu for the exact owned QA detail card is open.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false, completion_requirements: { download: false },
  read_scope: 'visible_page', summary: 'Open only the exact owned QA detail card menu.',
  steps: [{ id: '1', action: 'Read the owned detail card and open its More menu.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
let rootRef = '', moreRef = '', steps = 0, remoteRequests = 0;
const blockedRemote = [];
const requests = [];
const server = http.createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = ''; for await (const part of request) raw += part;
  const input = JSON.parse(raw); requests.push(input);
  await new Promise(resolve => setTimeout(resolve, 70));
  const system = textOf(input.messages?.[0]?.content);
  let completion;
  if (system.startsWith('Evaluate only the observable requirements of the genuine user task'))
    completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'The fresh native page shows the exact owned card menu open.' }) };
  else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
  else {
    const step = steps++;
    const firstClick = textOf(input.messages.find(message => message.role === 'tool' && message.tool_call_id === 'owned-anchor-2')?.content);
    let firstClickResult;
    try { firstClickResult = JSON.parse(firstClick.slice(firstClick.indexOf('{'), firstClick.lastIndexOf('}') + 1)); } catch {}
    // An extra explicit read mirrors the failed live cleanup sequence. A
    // previously rejected action's one-turn priority capture is insufficient.
    const call = step === 0 || step === 1 || step === 3
      ? { name: 'get_accessibility_tree', args: { ref_id: rootRef } }
      : step === 2 || (step === 4 && firstClickResult?.success !== true) ? { name: 'click_ax', args: { ref_id: moreRef } }
      : { name: 'done', args: { outcome: 'partial', summary: 'The bounded owned menu inspection is finished. No post was published or deleted.' } };
    completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-anchor-${step}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `response-${requests.length}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const html = `<!doctype html><meta charset="utf-8"><title>Owned anchored menu fixture</title>
<style>body{margin:20px;font:18px sans-serif}article{border:1px solid #555;width:550px;padding:15px}.detailed-status{height:900px}button{padding:12px}</style>
<h1>Owned detail</h1><button id="other" aria-label="Daha fazla">Other More</button>
<article id="owned" role="article" class="focusable detailed-status__wrapper detailed-status__wrapper-public">
<div class="detailed-status"><a href="/@owned/200">Owned status permalink</a><a href="/@owned">Owned QA account</a><p>Owned synthetic QA post.</p><time>2m</time></div>
<div class="detailed-status__action-bar"><button id="more" aria-label="Daha fazla">More</button></div></article><div id="menu"></div>
<script>window.ownedMenuClicks=0;window.otherMenuClicks=0;document.querySelector('#more').onclick=()=>{ownedMenuClicks++;document.querySelector('#menu').innerHTML='<div role="menu">Owned QA record menu</div>';};document.querySelector('#other').onclick=()=>otherMenuClicks++;</script>`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-anchored-mv3-'));
let context;
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => {
    const requested = new URL(route.request().url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (route.request().isNavigationRequest() && requested.href === url) return route.fulfill({ contentType: 'text/html', body: html });
    if (requested.hostname === 'owned-anchored.invalid') return route.fulfill({ status: 404, body: '' });
    if (/^https?:$/.test(requested.protocol)) {
      remoteRequests++; blockedRemote.push({ method: route.request().method(), origin: requested.origin });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  await worker.evaluate(() => {
    const fetchOriginal = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const target = new URL(typeof input === 'string' ? input : input.url);
      if (target.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(target.protocol)) return fetchOriginal(input, options);
      return Promise.reject(new Error('The owned anchored-action fixture blocks external requests.'));
    };
  });
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
    autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planReviewMode: 'never',
    maxAgentSteps: 8, systemOneEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false,
    openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  const initial = await harness.evaluate(tabId => chrome.tabs.sendMessage(tabId, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'all' } }), tabId);
  rootRef = initial.pageContent.split('\n').find(line => /article/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
  const rooted = await harness.evaluate(({ tabId, ref }) => chrome.tabs.sendMessage(tabId, { target: 'content', action: 'get_accessibility_tree', params: { ref_id: ref } }), { tabId, ref: rootRef });
  moreRef = rooted.pageContent.split('\n').find(line => /button "Daha fazla"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(rootRef && moreRef, 'Use only references returned by the actual native AX reader.');
  const result = await message('chat', { tabId, text: 'Read only the owned QA detail card and open its More menu. Do not publish, delete or message anyone.', mode: 'act', requestId: 'owned-anchored-menu', locale: 'en' });
  const calls = result.updates.filter(event => event.type === 'tool_result' && event.data?.name === 'click_ax').map(event => event.data.result);
  const counts = await page.evaluate(() => ({ owned: ownedMenuClicks, other: otherMenuClicks }));
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, calls, counts, requests, remoteRequests, blockedRemote }, null, 2));
  assert.equal(calls[0]?.success, true, JSON.stringify(calls));
  assert.equal(calls[0]?.method, 'click_ax', JSON.stringify(calls));
  assert.equal(counts.owned, 1, 'Open only the exact owned card once. A second attempted click must be independently reconsidered.');
  assert.equal(counts.other, 0, 'Never click the identically named unrelated menu.');
  assert.ok(blockedRemote.every(request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method)), 'No external mutation is attempted; optional extension startup reads are blocked.');
  console.log(JSON.stringify({ passed: true, installedMV3: true, rootedReads: 3, ownedMenuClicks: counts.owned, otherMenuClicks: counts.other }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-anchored-mv3-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
