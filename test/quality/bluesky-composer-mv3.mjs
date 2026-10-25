import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';
import { build as bundle } from 'esbuild';

// Real installed MV3 background, Agent, monitor and CDP input. The editor is
// the actual ProseMirror model/view from the source-backed Bluesky fixture;
// deterministic inference and intercepted owned HTTP responses are the only
// substitutes. No Bluesky account, API or external posting service is opened.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-11/bluesky-composer-mv3');
await fs.mkdir(out, { recursive: true });
const editorBundle = (await bundle({ entryPoints: [path.resolve('test/fixtures/bluesky-composer-editor.mjs')],
  bundle: true, write: false, format: 'iife', globalName: 'qaEditorLibrary', platform: 'browser' })).outputFiles[0].text;
const fixtureUrl = 'https://bsky.app/';
const account = 'owned.bsky.social';
const singleLineBody = 'One owned Bluesky draft: exact spaces  and Turkish ıİşŞğĞüÜöÖçÇ 🧠.';
const multilineBody = 'First owned Bluesky paragraph: exact spaces  and Turkish ıİşŞğĞüÜöÖçÇ 🧠.\nSecond owned paragraph preserves its newline and spaces  exactly.';
const postUrl = `https://bsky.app/profile/${account}/post/3ownedqa`;
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
function toolObject(content) {
  const text = textOf(content);
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
function latestTools(messages) {
  const names = new Map();
  for (const message of messages || []) for (const call of message.tool_calls || []) names.set(call.id, call.function?.name);
  return (messages || []).filter(message => message.role === 'tool')
    .map(message => ({ name: names.get(message.tool_call_id) || message.name, result: toolObject(message.content) }));
}
function references(tree) {
  const lines = String(tree?.pageContent || '').split('\n');
  const ref = expression => lines.find(line => expression.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
  return { editor: ref(/textbox(?: "[^"]*")? \[ref_/), publish: ref(/button "Publish post"/), tree: tree?.pageContent };
}
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['One exact owned Bluesky QA post, freshly verified.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Publish one exact local QA post from the current owned Bluesky account and verify its native saved record.',
  steps: [{ id: '1', action: 'Read the composer, write once, re-observe Publish, submit once and verify the native owned post.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
let current, context;
const submissions = [], blockedRemote = [], summaries = [];
const server = http.createServer(async (request, response) => {
  try {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw), system = textOf(input.messages?.[0]?.content);
    let completion;
    if (system.startsWith('Extract stable user preferences for WebBrain memory.'))
      completion = { role: 'assistant', content: '{"memories":[]}' };
    // What a status on the page says, read the way a model would read it.
    // These questions carry page text only, never the task.
    else if (fixturePageTextReply(input.messages)) completion = { role: 'assistant', content: fixturePageTextReply(input.messages) };
    else {
      assert.ok(current && JSON.stringify(input.messages).includes(current.marker), 'Inference must retain the exact owned Bluesky task.');
      const body = current.body;
      current.requests.push(input);
      if (system.startsWith("Compile the user's social-publication intent across languages.")) {
        current.compilers++;
        completion = { role: 'assistant', content: JSON.stringify({ version: 1, status: 'ready',
          actions: [{ id: 'p1', platform: 'bluesky', account: { source: 'task', start: account, end: account },
            posts: [{ body: { kind: 'exact', source: { source: 'task', start: body, end: body } },
              media: { kind: 'count', type: 'any', format: null, min: 0, max: 0 }, context: { kind: 'post', target: null } }] }],
          requirements: 'p1', prohibited: [], reason: 'The authentic task authorizes one exact owned local Bluesky post.' }) };
      } else if (system.startsWith('Independently check whether the authentic user request authorizes this concrete public dispatch.')) {
        current.audits++;
        const audit = JSON.parse(textOf(input.messages.find(message => message.role === 'user')?.content));
        completion = { role: 'assistant', content: JSON.stringify({ key: audit.key, actionId: audit.action.id,
          authorized: true, reason: 'The account, complete exact body and plain-post scope match the authentic task.' }) };
      } else if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
        current.judges++;
        completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'The fresh native owned post has the authorized account, full body and stable permalink.' }) };
      } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
      else {
        const step = current.steps++, tools = latestTools(input.messages);
        const last = tools.at(-1), observed = tools.findLast(tool => tool.name === 'get_accessibility_tree' && tool.result?.pageContent);
        let call;
        if (step === 0) call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
        else if (step === 1) {
          current.beforeWrite = references(observed?.result);
          assert.ok(current.beforeWrite.editor && current.beforeWrite.publish, JSON.stringify(observed));
          await current.page.evaluate(() => qaChurnFeed());
          current.inferenceChanges++;
          await new Promise(resolve => setTimeout(resolve, 240));
          call = { name: current.tool, args: { ...(current.tool === 'type_text'
            ? { selector: '.ProseMirror' } : { ref_id: current.beforeWrite.editor }), text: body, clear: true } };
        } else if (step === 2) {
          current.writeResult = tools.findLast(tool => tool.name === current.tool)?.result;
          current.afterWrite = await current.page.evaluate(() => qaSnapshot());
          call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
        } else if (step === 3 && current.writeResult?.success === true) {
          const fresh = references(observed?.result);
          assert.ok(fresh.publish && last?.name === 'get_accessibility_tree', 'Use a separately re-observed native Publish control.');
          current.publishReobserved = true;
          await current.page.evaluate(() => qaChurnFeed());
          current.inferenceChanges++;
          await new Promise(resolve => setTimeout(resolve, 240));
          call = { name: 'click_ax', args: { ref_id: fresh.publish } };
        } else if (step === 4 && current.writeResult?.success === true)
          call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
        else if (step > 3 && step % 2 === 1 && current.writeResult?.success === true
            && !tools.some(tool => tool.name === 'click_ax') && last?.name === 'get_accessibility_tree') {
          const fresh = references(observed?.result); assert.ok(fresh.publish);
          current.publishRetryReobserved = true;
          call = { name: 'click_ax', args: { ref_id: fresh.publish } };
        } else if (last?.name === 'click_ax') call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
        else call = { name: 'done', args: { outcome: current.writeResult?.success === true ? 'success' : 'partial',
          summary: 'The exact owned local Bluesky post was published once and freshly verified.' } };
        current.calls.push(call);
        completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-bsky-${current.tool}-${step}`,
          type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'owned-bsky-response',
      choices: [{ message: completion, finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  } catch (error) {
    if (current) current.providerError = error.stack;
    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

// Native web topology from official social-app commit
// 46d98dd457a197cee8502863b420222508f29fa6, also documented and exercised in
// test/bluesky-composer-context.mjs. Do not supply the aria name dropped by the
// native web TextInput, or relabel its heading-free modal to certify it.
const html = `<!doctype html><meta charset="utf-8"><title>Owned Bluesky home</title><style>
body{margin:0;font:16px sans-serif;background:#eee}#composer{position:absolute;left:230px;top:30px;width:620px;height:550px;background:white;padding:12px}
#topbar{display:flex;justify-content:space-between;height:45px}#editor-row{display:flex;gap:12px}#editor-host{width:540px}
.ProseMirror{height:220px;min-height:220px;white-space:pre-wrap;outline:1px solid #aaa}.ProseMirror p{margin:0}
.ProseMirror p.is-empty:before{content:attr(data-placeholder);color:#888;pointer-events:none;float:left;height:0}
[role=button],button{padding:8px;min-height:28px;cursor:pointer}#feed{position:absolute;left:920px;top:0;width:260px}
#account-navigation{position:absolute;left:10px;top:10px;width:190px}#avatar{width:42px;height:42px}
#timeline{margin:80px 230px;width:620px}[data-word-wrap="1"]{white-space:pre-wrap}</style>
<script src="/owned-fixture/editor.js"></script>
<nav id="account-navigation"><a href="/profile/${account}">Profile</a></nav>
<aside id="feed"><span id="feed-counter">12 likes</span><div id="feed-items">An unrelated feed post.</div></aside>
<main id="timeline"></main><div role="dialog" aria-modal="true" id="composer"><div data-testid="composePostView">
<div id="topbar"><div role="button" tabindex="0" aria-label="Cancel">Cancel</div>
<div id="publish" role="button" tabindex="0" aria-label="Publish post" aria-disabled="true" data-testid="composerPublishBtn">Post</div></div>
<div id="editor-row"><div data-testid="userAvatarImage" data-expoimage="true"><img id="avatar" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='42'%3E%3Crect width='42' height='42' fill='%238ac'/%3E%3C/svg%3E"></div><div id="editor-host"></div></div>
<div id="footer"><div role="button" tabindex="0" aria-label="Anyone can interact" data-testid="openReplyGateButton">Anyone can interact</div>
<div role="button" tabindex="0" aria-label="Add image">Add image</div></div></div></div><script>
qaEditorLibrary.mountEditor(window.qaInitialDraft||'');window.qaEvents=[];window.qaCommands=[];window.qaFeedChanges=0;window.qaSaved=[];
for(const type of ['beforeinput','input','paste'])document.querySelector('#editor-host').addEventListener(type,event=>
  qaEvents.push({type,trusted:event.isTrusted,inputType:event.inputType,data:event.data}),true);
const execCommand=document.execCommand.bind(document);
document.execCommand=(command,ui,value)=>{qaCommands.push({command,value});return execCommand(command,ui,value);};
window.qaChurnFeed=()=>{qaFeedChanges++;document.querySelector('#feed-counter').textContent=(12+qaFeedChanges)+' likes';
  const record=document.createElement('article');record.textContent='Unrelated incoming feed record '+qaFeedChanges;document.querySelector('#feed-items').append(record);};
document.querySelector('#publish').addEventListener('click',async()=>{
  if(document.querySelector('#publish').getAttribute('aria-disabled')==='true')return;
  const payload={account:'${account}',body:qaSnapshotEditor().model};
  const response=await fetch('/owned-fixture/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!response.ok)return;qaSaved.push(payload);qaEditorView.destroy();document.querySelector('#composer').remove();
  const card=document.createElement('div');card.setAttribute('data-testid','feedItem-by-${account}');
  const profile=document.createElement('a');profile.href='/profile/${account}';profile.textContent='Owned QA @${account}';card.append(profile);
  const permalink=document.createElement('a');permalink.href='/profile/${account}/post/3ownedqa';permalink.textContent='Now';card.append(permalink);
  const authored=document.createElement('div');authored.setAttribute('data-word-wrap','1');authored.setAttribute('dir','auto');authored.textContent=payload.body;card.append(authored);
  document.querySelector('#timeline').append(card);
});
window.qaSnapshot=()=>({...qaSnapshotEditor(),publishEnabled:document.querySelector('#publish')?.getAttribute('aria-disabled')==='false',
  dialogOpen:!!document.querySelector('#composer'),events:qaEvents,commands:qaCommands,feedChanges:qaFeedChanges,saved:qaSaved});
</script>`;

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-bluesky-composer-mv3-'));
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.blueskyFixtureAgent = agent;\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const request = route.request(), requested = new URL(request.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (requested.origin === 'https://bsky.app') {
      if (request.isNavigationRequest() && requested.href === fixtureUrl && request.method() === 'GET')
        return route.fulfill({ contentType: 'text/html', body: html });
      if (requested.pathname === '/owned-fixture/editor.js' && request.method() === 'GET')
        return route.fulfill({ contentType: 'text/javascript', body: editorBundle });
      if (requested.pathname === '/owned-fixture/post' && request.method() === 'POST') {
        submissions.push({ scenario: current.scenario, tool: current.tool, payload: request.postDataJSON() });
        return route.fulfill({ status: 201, contentType: 'application/json', body: '{"saved":true}' });
      }
      return route.fulfill({ status: 404, body: '' });
    }
    if (/^https?:$/.test(requested.protocol)) {
      blockedRemote.push({ method: request.method(), origin: requested.origin }); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  // The worker can be reported before its extension APIs and module have
  // finished loading; wait for both before wrapping them.
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await worker.evaluate(() => !!(globalThis.chrome?.tabs && globalThis.chrome?.debugger && globalThis.blueskyFixtureAgent))
      .catch(() => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await worker.evaluate(() => {
    const fetchOriginal=fetch.bind(globalThis), sendCommand=chrome.debugger.sendCommand.bind(chrome.debugger), sendMessage=chrome.tabs.sendMessage.bind(chrome.tabs);
    globalThis.blueskyFixtureProbe={commands:[],transports:[],blocked:[]};
    globalThis.fetch=(input,options)=>{
      const target=new URL(typeof input==='string'?input:input.url);
      if(target.hostname==='127.0.0.1'||['chrome-extension:','data:','blob:'].includes(target.protocol))return fetchOriginal(input,options);
      blueskyFixtureProbe.blocked.push({method:options?.method||'GET',origin:target.origin});
      return Promise.reject(new Error('The owned Bluesky composer fixture blocks external service requests.'));
    };
    chrome.debugger.sendCommand=(...args)=>{blueskyFixtureProbe.commands.push({method:args[1],params:args[2]});return sendCommand(...args);};
    chrome.tabs.sendMessage=async(...args)=>{
      const result=await sendMessage(...args),message=args[1];
      if(/page_monitor|set_field|type_ax|click_ax/.test(message.action))blueskyFixtureProbe.transports.push({action:message.action,
        tool:message.params?.tool,ref:message.params?.ref_id,result});
      return result;
    };
  });
  const harness=await context.newPage();await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message=(action,data={})=>harness.evaluate(({action,data})=>chrome.runtime.sendMessage({target:'background',action,...data}),{action,data});
  await harness.evaluate(()=>{
    window.blueskyRuns={};chrome.runtime.onMessage.addListener(event=>{
      if(event.action==='agent_update'&&blueskyRuns[event.requestId])blueskyRuns[event.requestId].push({type:event.type,data:event.data});
    });
    return chrome.storage.local.set({ actObservation: 'accessibility',helpImproveWebBrain:false,tracingEnabled:false,autoScreenshot:false,screenshotFallback:false,
      planBeforeActMode:'off',planBeforeAct:false,planReviewMode:'never',maxAgentSteps:10,systemOneEnabled:false,agentAllowLocalNetwork:true,
      askBeforeConsequentialActions:false,openaiAskStreamingEnabled:false});
  });
  assert.equal((await message('update_provider',{providerId:'openrouter',config:{apiKey:'owned-fixture-fake-key',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'minimax/minimax-m3',enabled:true,contextWindow:1000000,supportsAskStreaming:false}})).ok,true);
  assert.equal((await message('set_active_provider',{providerId:'openrouter'})).ok,true);
  for(const {scenario,tool,body,prefilled} of [
    {scenario:'set_field',tool:'set_field',body:singleLineBody},
    {scenario:'type_ax',tool:'type_ax',body:singleLineBody},
    {scenario:'set_field_multiline',tool:'set_field',body:multilineBody},
    {scenario:'prefilled_type_ax',tool:'type_ax',body:singleLineBody,prefilled:true},
    {scenario:'prefilled_type_text',tool:'type_text',body:singleLineBody,prefilled:true},
  ].filter(item=>!process.env.WEBBRAIN_QUALITY_BLUESKY_CASE||item.scenario===process.env.WEBBRAIN_QUALITY_BLUESKY_CASE)){
    const page=await context.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
    if(prefilled)await page.addInitScript(()=>{window.qaInitialDraft='Old owned draft "Local book" by @owned.bsky.social.';});
    await page.goto(fixtureUrl);
    await page.waitForSelector('.ProseMirror');
    const initial=await page.evaluate(()=>qaSnapshot());
    assert.equal(initial.model,prefilled?'Old owned draft "Local book" by @owned.bsky.social.':'');assert.equal(initial.editorName,null);
    assert.equal(initial.placeholder,prefilled?null:"What's up?");assert.equal(initial.publishEnabled,!!prefilled);
    const tabId=await harness.evaluate(async url=>(await chrome.tabs.query({})).findLast(tab=>tab.url===url)?.id,fixtureUrl);assert.ok(tabId);
    current={scenario,tool,body,page,marker:`Owned Bluesky regression path ${scenario}.`,requests:[],calls:[],steps:0,compilers:0,audits:0,judges:0,inferenceChanges:0};
    const probeStart=await worker.evaluate(()=>({commands:blueskyFixtureProbe.commands.length,transports:blueskyFixtureProbe.transports.length}));
    const requestId=`owned-bsky-${scenario}`;await harness.evaluate(id=>{blueskyRuns[id]=[];},requestId);
    const task=`Publish exactly one plain-text post from the currently signed-in ${account} account in this intercepted owned local Bluesky QA fixture, with this exact body:\n${body}\n\nRe-observe Publish after writing, submit once, then verify the fresh authored native post and its stable permalink. ${current.marker}`;
    const result=await message('chat',{tabId,text:task,mode:'act',requestId,locale:'en'});
    const runEvents=await harness.evaluate(id=>blueskyRuns[id],requestId),state=await page.evaluate(()=>qaSnapshot());
    const probe=await worker.evaluate(start=>({commands:blueskyFixtureProbe.commands.slice(start.commands),
      transports:blueskyFixtureProbe.transports.slice(start.transports),blocked:blueskyFixtureProbe.blocked}),probeStart);
    const completionEvidence=await worker.evaluate(tabId=>{
      const guard=blueskyFixtureAgent._continuationExecutionEvidence.get(tabId);
      return {verifiedSubmission:guard?.verifiedSubmissionEvidence,terminal:guard?.workflowTerminalEvidence,
        outcomes:guard?.socialPublication?.outcomes,submit:blueskyFixtureAgent._completionSubmitStates.get(tabId)};
    },tabId);
    const tools=result.updates?.filter(event=>event.type==='tool_result').map(event=>event.data)||[],writes=tools.filter(item=>item.name===tool),clicks=tools.filter(item=>item.name==='click_ax');
    const posts=submissions.filter(post=>post.scenario===scenario);
    await fs.writeFile(path.join(out,`${scenario}-evidence.json`),JSON.stringify({initial,result,runEvents,state,probe,completionEvidence,pageErrors,posts,
      provider:{...current,page:undefined},blockedRemote},(_key,value)=>typeof value==='string'&&value.startsWith('data:image/')?'[owned screenshot omitted]':value,2));
    assert.equal(current.providerError,undefined,current.providerError);assert.deepEqual(pageErrors,[]);
    assert.equal(writes.length,1);assert.equal(writes[0].result.success,true,JSON.stringify(writes));assert.equal(writes[0].result.verified,true);
    assert.equal(current.afterWrite.model,body);assert.deepEqual(current.afterWrite.blocks,body.split('\n'));
    assert.deepEqual(current.afterWrite.doc,{type:'doc',content:body.split('\n').map(text=>({type:'paragraph',content:[{type:'text',text}]}))});
    assert.equal(current.afterWrite.publishEnabled,true);assert.deepEqual(current.afterWrite.commands,[]);
    const insertions=probe.commands.filter(command=>command.method==='Input.insertText');assert.equal(insertions.length,1);assert.equal(insertions[0].params.text,body);
    assert.ok(current.afterWrite.events.some(event=>['beforeinput','input'].includes(event.type)&&event.trusted));assert.ok(current.afterWrite.events.every(event=>event.trusted));
    assert.equal(current.publishReobserved,true);assert.equal(clicks.length,1);
    assert.ok(clicks[0].result.success===true||clicks[0].result.dispatched===true,JSON.stringify(clicks));
    assert.equal(completionEvidence.submit?.dispatched,true,'The actual publication binding must record the native control activation.');
    if(clicks[0].result.success!==true){assert.equal(clicks[0].result.outcomeUnknown,true);assert.equal(clicks[0].result.retryable,false);}
    assert.deepEqual(posts,[{scenario,tool,payload:{account,body}}]);assert.deepEqual(state.saved,[{account,body}]);assert.equal(state.dialogOpen,false);
    const fresh=tools.findLast(item=>item.name==='get_accessibility_tree')?.result?.pageContent||'';assert.ok(fresh.includes(`/profile/${account}/post/3ownedqa`));
    assert.equal(state.feedChanges,2);assert.equal(current.inferenceChanges,2);
    assert.ok(probe.transports.some(item=>item.action==='page_monitor_validate_model'&&item.result?.ready===true));
    const doneCalls=tools.filter(item=>item.name==='done');assert.equal(doneCalls.length,1,'The first fresh completion must verify the exact native published body.');
    const done=doneCalls[0]?.result;assert.equal(done?.done,true,JSON.stringify(done));assert.equal(done?.outcome,'success',JSON.stringify(done));assert.notEqual(done?.success,false);
    assert.equal(runEvents.findLast(event=>event.type==='run_complete')?.data?.status,'completed');
    assert.equal(completionEvidence.verifiedSubmission,true);assert.deepEqual(completionEvidence.outcomes?.p1,{status:'verified'});
    assert.equal(completionEvidence.terminal?.source,'dispatch_bound_published_resource');
    assert.equal(completionEvidence.submit?.workflowBinding?.publishedResourceIdentity,'bluesky:bsky.app/profile/owned.bsky.social/post/3ownedqa');
    summaries.push({scenario,tool,paragraphs:body.split('\n').length,inputCommands:insertions.length,posts:posts.length,feedChanges:state.feedChanges,terminalOutcome:done.outcome,nativePublicationVerified:true});
    await page.close();
  }
  assert.ok(blockedRemote.every(request=>['GET','HEAD','OPTIONS'].includes(request.method)));
  const blockedBackground=await worker.evaluate(()=>blueskyFixtureProbe.blocked);assert.ok(blockedBackground.every(request=>['GET','HEAD','OPTIONS'].includes(request.method)));
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({passed:true,installedMV3:true,actualProseMirror:true,summaries,postUrl,externalPosts:0,blockedRemote,blockedBackground},null,2));
  console.log(JSON.stringify({passed:true,installedMV3:true,actualProseMirror:true,cases:summaries,externalPosts:0}));
}finally{
  await context?.close();await new Promise(resolve=>server.close(resolve));
  const resolved=path.resolve(profile);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'webbrain-bluesky-composer-mv3-'));
  await fs.rm(resolved,{recursive:true,force:true});
}
