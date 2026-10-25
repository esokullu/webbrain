import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';

// The confirmation markup is Mastodon's native v4.4.25 structure. The
// extension, provider pipeline, browser dispatch and completion gates are real;
// provider and site requests stay in this disposable, owned fixture.
const interruption = process.env.WEBBRAIN_QUALITY_MENU_INTERRUPT || '';
assert.ok(['', 'dom', 'route', 'document'].includes(interruption));
const anchored = process.env.WEBBRAIN_QUALITY_MENU_ANCHORED === '1';
assert.ok(!anchored || !interruption, 'Anchored and stale-menu scenarios are separate owned cases.');
const judgeOutcome = 'succeeded';
assert.ok(['succeeded', 'uncertain', 'pending', 'failed'].includes(judgeOutcome));
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || `ci/artifacts/quality-audit-2026-10-07/dropdown-menu-mv3/${anchored ? 'anchored' : interruption || "success"}`);
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
let deleted = false, actionCalls = 0, judgeCalls = 0, blockedRemote = 0, page, interrupted = false;
const completionRecovery = { reads: 0 };
let articleRef = '';
const menuSnapshots=[];
const deletes = [], providerRequests = [], judgeEvidence = [];
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
const treeOf = input => {
  for(const message of [...input.messages].reverse()) {
    const value=textOf(message.content); if(!value.includes('[BROWSER STATE: current page observed immediately before this decision.')) continue;
    let state;try{state=JSON.parse(value.slice(value.indexOf('{'),value.lastIndexOf('}')+1));}catch{continue;}
    const tree=typeof state.page==='string'?JSON.parse(state.page):state.page;
    return tree?.pageContent||'';
  }
  return '';
};
const refFor = (input,name,domId='') => {
  const tree=treeOf(input),line=tree.split('\n').find(line=>line.includes('button "'+name+'"')&&(!domId||line.includes('dom_id="'+domId+'"')));
  const ref=line?.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(ref,'The real automatic snapshot must expose '+name+' '+domId);return ref;
};
const ownedArticleRef = input => {
  const trees = [treeOf(input)];
  for (const message of input.messages || []) {
    if (message.role !== 'tool') continue;
    const value = textOf(message.content);
    try { trees.push(JSON.parse(value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1)).pageContent || ''); } catch {}
  }
  return trees.flatMap(tree => tree.split('\n')).find(line => line.includes('dom_id="owned-status"'))?.match(/\[(ref_\d+)\]/)?.[1] || '';
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
  } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
  else {
    const step=actionCalls++;
    const nativeStep = anchored ? step === 0 || step === 2 ? null : step === 1 ? 0 : step - 2 : step;
    if (anchored && step === 2) articleRef = ownedArticleRef(input);
    let missingMenu = false;
    if(nativeStep===1){
      const tree=treeOf(input),line=tree.split('\n').find(line=>/button "Sil"/.test(line));
      menuSnapshots.push({hasDelete:!!line,offscreen:line?.includes('offscreen=true'),hasRoot:tree.includes('[open overlays')});
      missingMenu = !line || !line.includes('offscreen=true');
      if(interruption && !missingMenu){
        interrupted=true;
        if(interruption==='dom')await page.locator('#delete').evaluate(node=>{node.textContent='Unrelated action';});
        if(interruption==='route')await page.evaluate(()=>history.pushState({},'', '/unrelated'));
        if(interruption==='document')await page.reload();
      }
    }
    const call=anchored && step===0 ? {name:'get_accessibility_tree',args:{filter:'all',maxChars:6000}}
      :anchored && step===2 && articleRef ? {name:'get_accessibility_tree',args:{ref_id:articleRef,filter:'visible',maxChars:6000}}
      :anchored && step===2 ? {name:'done',args:{outcome:'partial',summary:'The actual owned status scope was not read. No deletion was attempted.'}}
      :missingMenu?{name:'done',args:{outcome:'partial',summary:'The native popup was not exposed by the owned observation. No deletion was attempted.'}}
      :nativeStep===0?{name:'click_ax',args:{ref_id:refFor(input,'Daha fazla','owned-more')}}
      :nativeStep===1?{name:'click_ax',args:{ref_id:refFor(input,'Sil','delete')}}
      :interrupted?{name:'done',args:{outcome:'partial',summary:'The owned native menu changed before deletion. No mutation should be repeated.'}}
      :nativeStep===2?{name:'click_ax',args:{ref_id:refFor(input,'Sil')}}
      :nativeStep===3?{name:'fetch_url',args:{url:resource}}
      :nativeStep===4?{name:'read_page',args:{limit:2000}}
      :{name:'done',args:{outcome:'success',summary:'The exact owned QA post was deleted once and verified absent; the unrelated composer and navigation menu were untouched.'}};
    const emitted = conformFixtureCompletionCall(input, call, completionRecovery);
    completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-delete-${step}`, type: 'function',
      function: { name: emitted.name, arguments: JSON.stringify(emitted.args) } }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const labels=['Gönderi bağlantısını kopyala','Gömme kodunu al','Yer imlerine ekle','Profile sabitle','Sohbeti sessize al','Düzenle','Sil','Sil,Düzenle ve yeniden-paylaş'];
const menuHtml='<div class="dropdown-animation dropdown-menu bottom"><ul class="dropdown-menu__content">'+labels.map(label=>'<li class="dropdown-menu__item"><button'+(label==='Sil'?' id="delete"':'')+'>'+label+'</button></li>').join('')+'</ul></div>';
const modalHtml='<div role="dialog" aria-modal="true"><div class="modal-root__modal safety-action-modal"><div class="safety-action-modal__top"><div class="safety-action-modal__confirmation"><h1>Gönderiyi sil?</h1><p>Bu tootu silmek istediğinden emin misin?</p></div></div><div class="safety-action-modal__bottom"><div class="safety-action-modal__actions"><button class="link-button" type="button">İptal</button><button class="button" type="button">Sil</button></div></div></div></div>';
const pageBody=`<!doctype html><meta charset="utf-8"><meta name="description" content="1 post (stale static metadata)"><title>Owned small native dropdown fixture</title>
<style>body{font:16px sans-serif;margin:0;height:570px;overflow:hidden}form{padding:10px}textarea{display:block;width:500px;height:60px}.status{margin:15px}.dropdown-menu{position:fixed;top:326px;left:769px;width:210px;background:white}ul{list-style:none;padding:5px;margin:0}li{margin:0;padding:0}.dropdown-menu button{display:block;width:200px;height:44px;border:0;padding:0}.safety-action-modal{position:fixed;inset:100px 250px;background:white;border:2px solid black;padding:25px}#owned-more{position:fixed;left:856px;top:297px;width:24px;height:24px}#other{position:fixed;left:945px;top:512px}</style>
<form><input placeholder="Search Mastodon"></form><form class="compose-form"><div class="navigation-bar"><a class="account__display-name" href="/@${account}">@${account}</a></div><textarea class="autosuggest-textarea__textarea" aria-label="Post text"></textarea><div class="compose-form__submit"><button type="submit">Publish</button></div></form>
<main id="statuses"><article id="owned-status" class="status"><a class="status__relative-time" href="/@${account}/200">Now</a><a class="status__display-name" href="/@${account}">@${account}</a><div class="status__content__text--visible"><p>Owned deletion QA post</p></div><button id="owned-more" aria-label="Daha fazla">More</button></article></main><aside><button id="other" aria-label="Daha fazla">Other navigation</button></aside><div id="portal"></div>
<script>window.ownedMoreClicks=0;window.otherMoreClicks=0;window.deleteOptionClicks=0;document.querySelector('#other').onclick=()=>otherMoreClicks++;document.querySelector('#owned-more').onclick=()=>{ownedMoreClicks++;document.querySelector('#portal').innerHTML=${JSON.stringify(menuHtml)};document.querySelector('#delete').onclick=()=>{deleteOptionClicks++;document.querySelector('#portal').innerHTML=${JSON.stringify(modalHtml)};document.querySelector('.link-button').onclick=()=>document.querySelector('#portal').replaceChildren();document.querySelector('.button').onclick=async()=>{const r=await fetch('/api/v1/statuses/200',{method:'DELETE'});if(r.ok){document.querySelector('#statuses').textContent='0 posts. No posts here.';document.querySelector('#portal').replaceChildren();}};};};document.querySelector('form.compose-form').onsubmit=e=>{e.preventDefault();throw new Error('Unrelated composer must not be submitted');};</script>`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-dropdown-menu-mv3-'));
let context;
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.deletionFixtureAgent = agent;\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: {width:1258,height:570},
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
  page = await context.newPage(); await page.goto(pageUrl);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, pageUrl);
  const result = await message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-native-deletion', locale: 'en' });
  const diagnostic = await worker.evaluate(tabId => ({ submit: deletionFixtureAgent._completionSubmitStates.get(tabId),
    verdict: deletionFixtureAgent._completionVerdicts?.get(tabId), guard: deletionFixtureAgent._planExecutionGuards.get(tabId) }), tabId);
  const counts=await page.evaluate(()=>({ownedMore:ownedMoreClicks,otherMore:otherMoreClicks,deleteOptions:deleteOptionClicks}));
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, diagnostic, deletes, judgeCalls, judgeEvidence,
    providerRequests, blockedRemote, counts, menuSnapshots }, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
  const explicitAX=result.updates.filter(e=>e.type==='tool_call'&&e.data?.name==='get_accessibility_tree');
  assert.equal(explicitAX.length,anchored?2:0,'Exercise both automatic observations and an exact rooted article reread after opening the popup.');
  if (anchored) {
    assert.equal(explicitAX[0].data.args.ref_id, undefined);
    assert.equal(explicitAX[1].data.args.ref_id, articleRef);
  }
  assert.equal(counts.otherMore,0);
  const done=result.updates.findLast(event=>event.type==='tool_result'&&event.data?.name==='done')?.data?.result;
  assert.equal(done?.done,true,JSON.stringify(done));
  if(interruption){
    assert.equal(deletes.length,0);assert.equal(counts.deleteOptions,0,'Changed document, route or menu target must not dispatch the stale Delete.');
    assert.equal(done.outcome,'partial');
  } else {
    assert.deepEqual(deletes,[{method:'DELETE',path:'/api/v1/statuses/200'}]);
    assert.deepEqual(counts,{ownedMore:1,otherMore:0,deleteOptions:1});
    assert.equal(done.outcome,'success',JSON.stringify(done));assert.ok(judgeCalls>0);
    assert.ok(judgeEvidence.some(text=>/404/.test(text)));
  }
  assert.deepEqual(menuSnapshots,[{hasDelete:true,offscreen:true,hasRoot:true}]);
  console.log(JSON.stringify({passed:true,installedMV3:true,viewport:{width:1258,height:570},deletes:deletes.length,judgeCalls,interruption,anchored,explicitAX:explicitAX.length,counts}));

} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-dropdown-menu-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
