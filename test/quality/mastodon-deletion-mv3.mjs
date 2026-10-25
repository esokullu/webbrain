import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';

// The confirmation markup is Mastodon's native v4.4.25 structure. The
// extension, provider pipeline, browser dispatch and completion gates are real;
// provider and site requests stay in this disposable, owned fixture.
const judgeOutcome = process.env.WEBBRAIN_QUALITY_DELETE_VERDICT || 'succeeded';
assert.ok(['succeeded', 'uncertain', 'pending', 'failed'].includes(judgeOutcome));
const nativeDeleteMode = process.env.WEBBRAIN_QUALITY_DELETE_NATIVE_MODE || 'confirmation';
assert.ok(['confirmation', 'direct'].includes(nativeDeleteMode));
const direct = nativeDeleteMode === 'direct';
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || `ci/artifacts/quality-audit-2026-10-07/mastodon-deletion-mv3/${judgeOutcome}${direct ? '-direct' : ''}`);
await fs.mkdir(out, { recursive: true });
const account = 'webbrain_qa_owned', resource = `https://mastoturk.org/@${account}/200`;
const pageUrl = `https://mastoturk.org/@${account}`;
const task = `Delete only our owned QA post at "${resource}" with exact body "Owned deletion QA post". Deletion of this one disposable QA post is explicitly authorized. Do not publish, delete other content or send messages. Verify it is removed.`;
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['The exact owned QA post is deleted and verified.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Delete and verify only the authorized owned QA post.',
  steps: [{ id: '1', action: 'Delete the exact owned post and verify its absence.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
let deleted = false, actionCalls = 0, judgeCalls = 0, blockedRemote = 0;
const completionRecovery = { reads: 0 };
const deletes = [], providerRequests = [], judgeEvidence = [];
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
const refFor = (input, name) => {
  for (const message of [...input.messages].reverse()) {
    if (message.role !== 'tool') continue;
    let data; try { data = JSON.parse(textOf(message.content)); } catch {
      const content = textOf(message.content), start = content.indexOf('{');
      try { data = JSON.parse(content.slice(start, content.lastIndexOf('}') + 1)); } catch { continue; }
    }
    const tree = data.pageContent || '';
    const line = tree.split('\n').find(line => line.includes(`button "${name}"`));
    const ref = line?.match(/\[(ref_\d+)\]/)?.[1];
    if (ref) return ref;
  }
  throw new Error(`Owned fixture did not observe ${name}`);
};
const server = http.createServer(async (request, response) => {
  if (request.url === '/resource') {
    response.writeHead(deleted ? 404 : 200, { 'Content-Type': 'text/html' });
    response.end(deleted ? 'The owned QA post is absent.' : 'Owned deletion QA post'); return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = ''; for await (const part of request) raw += part;
  const input = JSON.parse(raw); providerRequests.push(input);
  await new Promise(resolve => setTimeout(resolve, 80));
  const system = textOf(input.messages?.[0]?.content);
  let completion;
  if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
    judgeCalls++; judgeEvidence.push(textOf(input.messages[1]?.content));
    completion = { role: 'assistant', content: JSON.stringify({ outcome: judgeOutcome,
      reason: judgeOutcome === 'succeeded'
        ? 'The exact resource returns HTTP404 after the owned confirmation dispatch and the fresh native profile contains no status.'
        : 'The owned independent judge deliberately withholds a positive completion verdict.' }) };
  } else if (system.startsWith('Identify only the exact plain public Mastodon post authorized by the genuine user task.')) {
    completion = { role: 'assistant', content: JSON.stringify({ kind: 'unsupported', body: null, account: null }) };
  } else if (fixturePageTextReply(input.messages)) {
    // A status the page showed, read the way a model would read it.
    completion = { role: 'assistant', content: fixturePageTextReply(input.messages) };
  } else if (system.startsWith("Answer one fixed-choice question for a browser agent's safety check.")) {
    // The model's reading of the request: it names exactly this post by its link.
    const request = JSON.parse(textOf(input.messages[1].content)).request;
    const untrusted = textOf(input.messages.at(-1).content);
    const { page } = JSON.parse(untrusted.slice(untrusted.indexOf('{'), untrusted.lastIndexOf('}') + 1));
    const named = system.includes('"delete_this"') && request === task && page?.link === resource;
    completion = { role: 'assistant', content: JSON.stringify(named
      ? { choice: 'delete_this', evidence: `Delete only our owned QA post at "${resource}"` } : { choice: 'unclear', evidence: '' }) };
  } else if (system.startsWith('Check one separately proposed consequential action')) {
    throw new Error('A deletion is decided by the deletion question, not the publication check.');
  } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
  else {
    const step = actionCalls++;
    const call = step === 1 ? { name: 'click_ax', args: { ref_id: refFor(input, 'More owned post') } }
      : step === 3 ? { name: 'click_ax', args: { ref_id: refFor(input, 'Delete owned post') } }
      : !direct && step === 5 ? { name: 'click_ax', args: { ref_id: refFor(input, 'Sil') } }
      : step === (direct ? 5 : 6) ? { name: 'fetch_url', args: { url: resource } }
      : step === (direct ? 6 : 7) ? { name: 'read_page', args: { limit: 2000 } }
      : step > (direct ? 7 : 8) && judgeOutcome !== 'succeeded'
        ? { name: 'done', args: { outcome: 'partial', summary: 'The owned native deletion ran once, but the independent judge has not verified completion. Do not repeat deletion.' } }
      : step > (direct ? 6 : 7) ? { name: 'done', args: { outcome: 'success', summary: 'The exact owned QA post was deleted once and verified absent; the persistent empty composer is unrelated.' } }
      : { name: 'get_accessibility_tree', args: { filter: 'all' } };
    const emitted = conformFixtureCompletionCall(input, call, completionRecovery);
    completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-delete-${step}`, type: 'function',
      function: { name: emitted.name, arguments: JSON.stringify(emitted.args) } }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageBody = `<!doctype html><meta charset="utf-8"><meta name="description" content="1 post (stale static metadata)"><title>Owned native deletion fixture</title>
<script id="initial-state" type="application/json">{"meta":{"delete_modal":${!direct}}}</script>
<style>body{font:18px sans-serif;margin:25px}form{padding:12px}textarea{display:block;width:650px;height:110px}.status{margin:20px}.safety-action-modal{position:fixed;inset:120px 250px;background:white;border:2px solid black;padding:30px}button{padding:12px}</style>
<form><input placeholder="Search Mastodon"></form><form class="compose-form"><div class="navigation-bar"><a class="account__display-name" href="/@${account}">@${account}</a></div><textarea class="autosuggest-textarea__textarea" aria-label="Post text"></textarea><div class="compose-form__submit"><button type="submit">Publish</button></div></form>
<main id="statuses"><div class="status"><a class="status__relative-time" href="/@${account}/200">Now</a><a class="status__display-name" href="/@${account}">@${account}</a><div class="status__content__text--visible"><p>Owned deletion QA post</p></div><div class="status__action-bar"><button id="more" type="button" class="icon-button" aria-label="More owned post"><svg class="icon icon-ellipsis-h" aria-hidden="true"></svg></button></div></div></main><div id="modal"></div>
<script>document.querySelector('#more').onclick=()=>{const menu=document.createElement('div');menu.className='dropdown-menu';menu.innerHTML='<div class="dropdown-menu__container"><ul class="dropdown-menu__container__list"><li class="dropdown-menu__item dropdown-menu__item--dangerous"><button data-index="0" aria-label="Delete owned post">Delete</button></li></ul></div>';const b=menu.querySelector('button');b.onclick=()=>{document.querySelector('#modal').innerHTML='<div role="dialog" aria-modal="true"><div class="modal-root__modal safety-action-modal"><div class="safety-action-modal__top"><div class="safety-action-modal__confirmation"><h1>Gönderiyi sil?</h1><p>Bu tootu silmek istediğinden emin misin?</p></div></div><div class="safety-action-modal__bottom"><div class="safety-action-modal__actions"><button class="link-button" type="button">İptal</button><button class="button" type="button">Sil</button></div></div></div></div>';document.querySelector('.link-button').onclick=()=>document.querySelector('#modal').replaceChildren();document.querySelector('.button').onclick=async()=>{const r=await fetch('/api/v1/statuses/200',{method:'DELETE'});if(r.ok){document.querySelector('#statuses').textContent='0 posts. No posts here.';document.querySelector('#modal').replaceChildren();}};};document.querySelector('#modal').append(menu);};document.querySelector('form.compose-form').onsubmit=e=>{e.preventDefault();throw new Error('Unrelated composer must not be submitted');};</script>` + (direct ? `<script>const openOwnedMenu=document.querySelector('#more').onclick;document.querySelector('#more').onclick=()=>{openOwnedMenu();document.querySelector('.dropdown-menu button').onclick=async()=>{const result=await fetch('/api/v1/statuses/200',{method:'DELETE'});if(result.ok){document.querySelector('#statuses').textContent='0 posts. No posts here.';document.querySelector('#modal').replaceChildren();}};};</script>` : '');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-mastodon-delete-mv3-'));
let context;
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  await fs.appendFile(path.join(extension, 'src/background.js'), `
globalThis.deletionFixtureAgent = agent;
globalThis.deletionFixtureReceipts = [];
const recordOwnedDeletionReceipt = agent._recordCompletionSubmitAttempt;
agent._recordCompletionSubmitAttempt = function (...args) {
  const receipt = recordOwnedDeletionReceipt.apply(this, args);
  if (receipt) deletionFixtureReceipts.push({ taskKey: receipt.taskKey, runToken: receipt.runToken,
    mutationKind: receipt.mutationKind, resourceUrl: receipt.actionResource?.url });
  return receipt;
};
`);
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const request = route.request(), requested = new URL(request.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (requested.origin === 'https://mastoturk.org') {
      if (requested.pathname === '/api/v1/statuses/200' && request.method() === 'DELETE') {
        deletes.push({ method: request.method(), path: requested.pathname }); deleted = true;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (request.isNavigationRequest() && requested.href === pageUrl) return route.fulfill({ contentType: 'text/html', body: pageBody });
      return route.fulfill({ status: 404, body: '' });
    }
    if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
  await worker.evaluate(({ resource, bridge }) => {
    const send = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const requested = new URL(typeof input === 'string' ? input : input.url);
      if (requested.href === resource && (!options?.method || options.method === 'GET')) {
        // This is a local network mapping of the owned origin, not a redirect.
        return send(bridge, options).then(response => Object.defineProperty(response, 'url', { value: requested.href }));
      }
      if (requested.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(requested.protocol)) return send(input, options);
      return Promise.reject(new Error('Owned deletion fixture blocks external network requests.'));
    };
  }, { resource, bridge: `http://127.0.0.1:${server.address().port}/resource` });
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
    autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', maxAgentSteps: 14, systemOneEnabled: false, agentAllowLocalNetwork: true,
    askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(pageUrl);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, pageUrl);
  const result = await message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-native-deletion', locale: 'en' });
  const diagnostic = await worker.evaluate(tabId => ({ submit: deletionFixtureAgent._completionSubmitStates.get(tabId),
    verdict: deletionFixtureAgent._completionVerdicts.get(tabId), guard: deletionFixtureAgent._planExecutionGuards.get(tabId),
    receipts: deletionFixtureReceipts, currentTaskKey: deletionFixtureAgent._progressTaskKeyHash(tabId) }), tabId);
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, diagnostic, deletes, judgeCalls, judgeEvidence,
    providerRequests, blockedRemote }, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
  assert.deepEqual(deletes, [{ method: 'DELETE', path: '/api/v1/statuses/200' }], 'Only one actual native deletion occurs.');
  assert.ok(diagnostic.submit.runToken);
  assert.deepEqual(diagnostic.receipts, [{ taskKey: diagnostic.currentTaskKey, runToken: diagnostic.submit.runToken,
    mutationKind: 'delete', resourceUrl: resource }], 'Exactly one current-task deletion receipt exists; menu preparation cannot create one.');
  assert.equal(diagnostic.submit.actionResource.taskKey, diagnostic.currentTaskKey);
  assert.equal(diagnostic.submit.actionResource.runToken, diagnostic.submit.runToken);
  assert.equal(await page.locator('textarea').inputValue(), '', 'The persistent composer remains empty.');
  const done = result.updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
  assert.equal(done?.done, true, JSON.stringify(done));
  if (judgeOutcome === 'succeeded') assert.equal(done?.outcome, 'success', JSON.stringify(done));
  else {
    assert.equal(done?.outcome, 'partial', JSON.stringify(done));
    assert.ok(result.updates.some(event => event.type === 'tool_result' && event.data?.name === 'done'
      && event.data.result.blockedDone === true), 'A nonpositive verdict must block the initial success attempt.');
  }
  assert.ok(judgeCalls > 0); assert.ok(judgeEvidence.some(text => /404/.test(text)), 'Actual resource absence reaches the independent judge.');
  console.log(JSON.stringify({ passed: true, installedMV3: true, nativeDeleteMode, deletes: deletes.length,
    receipts: diagnostic.receipts.length, judgeCalls, judgeOutcome, persistentForms: 2, blockedRemote }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-mastodon-delete-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
