import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';

// The actual installed MV3 background, monitor, Agent and CDP input operate on
// React/DraftJS document nodes. Only inference and owned HTTP responses are
// deterministic. No real X page, account, API or posting service is contacted.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-11/inline-social-composer-mv3');
await fs.mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const library = (name, file) => fs.readFile(path.join(path.dirname(require.resolve(`${name}/package.json`)), file), 'utf8');
const libraryFiles = [
  ['react.js', 'react', 'umd/react.development.js'],
  ['react-dom.js', 'react-dom', 'umd/react-dom.development.js'],
  ['immutable.js', 'immutable', 'dist/immutable.js'],
  ['draft.js', 'draft-js', 'dist/Draft.js'],
];
const assets = new Map(await Promise.all(libraryFiles.map(async ([name, module, file]) => [name, await library(module, file)])));
const draftCss = await library('draft-js', 'dist/Draft.css');
const fixtureUrl = 'https://x.com/home';
const account = 'ownedqa';
const body = 'One owned inline draft: exact spaces  and Turkish ıİşŞğĞüÜöÖçÇ 🧠.';
const cases = [
  { name: 'set_field', tool: 'set_field' },
  { name: 'type_ax', tool: 'type_ax' },
  { name: 'prefilled_set_field', tool: 'set_field', prefilled: true },
  { name: 'prefilled_type_ax', tool: 'type_ax', prefilled: true },
  { name: 'prefilled_type_text', tool: 'type_text', prefilled: true },
  { name: 'modal_prefilled_type_ax', tool: 'type_ax', prefilled: true, modal: true },
  { name: 'prefilled_selection_interrupted', tool: 'type_text', prefilled: true, partialSelection: true },
  { name: 'focus_expansion', tool: 'set_field', focusExpansion: true },
  { name: 'native_preparation_retry', tool: 'set_field', nativePreparationVeto: true },
  { name: 'owner_changed', tool: 'set_field', change: 'owner' },
  { name: 'account_changed', tool: 'type_ax', change: 'account' },
  { name: 'audience_changed', tool: 'set_field', change: 'audience' },
  { name: 'composer_navigation_changed', tool: 'type_ax', change: 'navigation' },
].filter(item => !process.env.WEBBRAIN_QUALITY_INLINE_CASE || item.name === process.env.WEBBRAIN_QUALITY_INLINE_CASE);
assert.ok(cases.length, 'Select an existing owned inline regression case.');
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
function toolObject(content) {
  const text = textOf(content);
  // Production results remain inside the nonce-bound untrusted-page envelope.
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
  return { editor: ref(/textbox "Post text"/), post: ref(/button "Post"/), tree: tree?.pageContent };
}
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['One exact owned local QA post, freshly verified.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Publish exactly one owned local QA post from the current ownedqa account and verify its confirmation.',
  steps: [{ id: '1', action: 'Read the home composer, write the exact draft once, re-observe Post, publish once and verify the owned confirmation.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
let current, context, worker;
const blockedRemote = [], submissions = [], summaries = [], auxiliaryRequests = [];
const server = http.createServer(async (request, response) => {
  try {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw);
    const system = textOf(input.messages?.[0]?.content);
    if (system.startsWith('Extract stable user preferences for WebBrain memory.')) {
      auxiliaryRequests.push(input);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'owned-inline-memory',
        choices: [{ message: { role: 'assistant', content: '{"memories":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } }));
      return;
    }
    // What a status on the page says, read the way a model would read it.
    // These questions carry page text only, never the task.
    const pageTextReply = fixturePageTextReply(input.messages);
    if (pageTextReply) {
      auxiliaryRequests.push(input);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'owned-inline-page-text',
        choices: [{ message: { role: 'assistant', content: pageTextReply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } }));
      return;
    }
    current.requests.push(input);
    assert.ok(current && JSON.stringify(input.messages).includes(current.marker), `Inference must retain this owned task authority: ${system.slice(0, 160)}`);
    let completion;
    if (system.startsWith("Compile the user's social-publication intent across languages.")) {
      current.compilers = (current.compilers || 0) + 1;
      completion = { role: 'assistant', content: JSON.stringify({ version: 1, status: 'ready',
        actions: [{ id: 'p1', platform: 'twitter', account: { source: 'task', start: account, end: account },
          posts: [{ body: { kind: 'exact', source: { source: 'task', start: body, end: body } },
            media: { kind: 'count', type: 'any', format: null, min: 0, max: 0 }, context: { kind: 'post', target: null } }] }],
        requirements: 'p1', prohibited: [], reason: 'The authentic task authorizes one exact local QA post.' }) };
    } else if (system.startsWith('Independently check whether the authentic user request authorizes this concrete public dispatch.')) {
      current.audits = (current.audits || 0) + 1;
      const audit = JSON.parse(textOf(input.messages.find(message => message.role === 'user')?.content));
      completion = { role: 'assistant', content: JSON.stringify({ key: audit.key, actionId: audit.action.id,
        authorized: true, reason: 'The exact owned body, account and plain-post scope match the authentic task.' }) };
    } else if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
      current.judges++;
      completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'Fresh owned page confirmation records the exact authorized local post.' }) };
    } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      const step = current.steps++;
      const tools = latestTools(input.messages);
      const last = tools.at(-1);
      const observed = tools.findLast(tool => tool.name === 'get_accessibility_tree' && tool.result?.pageContent);
      let call;
      if (step === 0) call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      else if (step === 1) {
        current.beforeWrite = references(observed?.result);
        assert.ok(current.beforeWrite.editor && current.beforeWrite.post, JSON.stringify(observed));
        // This external page activity occurs after the real pre-inference
        // model capture and before the provider's response. It is never an
        // agent-owned mutation or a mock monitor/dispatch acknowledgement.
        await current.page.evaluate(change => {
          qaChurnFeed();
          if (change) qaChangeContext(change);
        }, current.change || null);
        current.inferenceChanges++;
        await new Promise(resolve => setTimeout(resolve, 240));
        call = { name: current.tool, args: { ...(current.tool === 'type_text'
          ? { selector: '[data-testid="tweetTextarea_0"]' } : { ref_id: current.beforeWrite.editor }), text: body, clear: true } };
      } else if (step === 2) {
        current.writeResult = tools.findLast(tool => tool.name === current.tool)?.result;
        current.afterWrite = await current.page.evaluate(() => qaSnapshot());
        call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      } else if (step === 3 && current.focusExpansion) {
        current.expansionResult = current.writeResult;
        current.expansionState = current.afterWrite;
        const fresh = references(observed?.result);
        assert.ok(fresh.editor && last?.name === 'get_accessibility_tree', 'The focus expansion requires a new observed typing decision.');
        call = { name: current.tool, args: { ref_id: fresh.editor, text: body, clear: true } };
      } else if (step === 4 && current.focusExpansion) {
        current.writeResult = tools.findLast(tool => tool.name === current.tool)?.result;
        current.afterWrite = await current.page.evaluate(() => qaSnapshot());
        call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      } else if (step === (current.focusExpansion ? 5 : 3) && !current.change && current.writeResult?.success === true) {
        current.beforePost = references(observed?.result);
        assert.ok(current.beforePost.post, JSON.stringify(observed));
        current.postReobserved = last?.name === 'get_accessibility_tree';
        await current.page.evaluate(() => qaChurnFeed());
        if (current.nativePreparationVeto) await current.page.evaluate(() => qaArmPreparationOverlay());
        current.inferenceChanges++;
        await new Promise(resolve => setTimeout(resolve, 240));
        call = { name: 'click_ax', args: { ref_id: current.beforePost.post } };
      } else if (step === 4 && current.nativePreparationVeto) {
        current.preparationVeto = tools.findLast(tool => tool.name === 'click_ax')?.result;
        current.afterVeto = await current.page.evaluate(() => ({ state: qaSnapshot(), overlay: !!document.getElementById('qa-native-preparation-overlay') }));
        current.vetoLedger = await worker.evaluate(tabId => {
          const guard = inlineFixtureAgent._planExecutionGuards.get(tabId);
          return { outcomes: guard?.socialPublication?.outcomes, dispatch: guard?.socialPublication?.dispatch,
            submitted: inlineFixtureAgent._completionSubmitStates.get(tabId)?.dispatched === true };
        }, current.tabId);
        assert.equal(current.preparationVeto?.noDispatch, true, JSON.stringify(current.preparationVeto));
        assert.equal(current.preparationVeto?.dispatched, false);
        assert.equal(current.afterVeto.overlay, true, 'A real hover-triggered occluder must reach native preparation.');
        assert.deepEqual(current.afterVeto.state.saved, []);
        assert.deepEqual(current.vetoLedger.outcomes, {}); assert.equal(current.vetoLedger.dispatch, null);
        await current.page.evaluate(() => qaClearPreparationOverlay());
        call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      } else if (step === 5 && current.nativePreparationVeto) {
        const fresh = references(observed?.result);
        assert.equal(last?.name, 'get_accessibility_tree'); assert.ok(fresh.post);
        current.postRetryReobserved = true;
        call = { name: 'click_ax', args: { ref_id: fresh.post } };
      } else if (step === 6 && current.nativePreparationVeto)
        call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      else if (!current.change && !current.nativePreparationVeto && current.writeResult?.success === true
          && step > (current.focusExpansion ? 5 : 3) && !tools.some(tool => tool.name === 'click_ax')
          && last?.name === 'get_accessibility_tree' && step % 2 === 1) {
        // A superseded decision sent no input. Observe again before emitting
        // another Post decision; never replay an actually dispatched click.
        const fresh = references(observed?.result);
        assert.ok(fresh.post); current.postRetryReobserved = true;
        call = { name: 'click_ax', args: { ref_id: fresh.post } };
      } else if (last?.name === 'click_ax' && !current.change)
        call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      else if (step === (current.focusExpansion ? 6 : 4) && !current.change && current.writeResult?.success === true)
        call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      else call = { name: 'done', args: { outcome: current.change || current.writeResult?.success !== true ? 'partial' : 'success',
        summary: current.change ? 'The changed composer was left intact and unsubmitted.' : 'The owned local inline composer regression is finished.' } };
      current.calls.push(call);
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-inline-${current.name}-${step}`,
        type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-inline-${current.name}-${current.requests.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  } catch (error) {
    if (current) current.providerError = error.stack;
    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Owned home timeline</title>
<style>${draftCss}
body{margin:0;background:#fff;color:#111;font:17px system-ui}#app{display:flex;gap:24px;margin:20px}
#account-nav{width:170px}a{color:inherit}main{width:660px}.tabs{height:55px;display:flex;gap:20px}
#inline-owner{padding:16px;border:1px solid #bbb;display:flex;gap:15px;min-height:230px;box-sizing:border-box}
.avatar{width:45px;height:45px;display:block;border-radius:50%;background:#456;color:white;text-align:center;line-height:45px}
.compose-inner{width:560px}.public-DraftEditor-content{height:100px;overflow:auto}.DraftEditor-root{height:100px}
button{font:inherit;padding:8px;margin:3px}.compose-actions{display:flex;align-items:center;justify-content:space-between}
article{padding:16px;border:1px solid #ddd;height:120px}#confirmation{padding:12px}
[data-testid="tweetText"]{white-space:pre-wrap}</style>
${libraryFiles.map(([name]) => `<script src="/owned-fixture/${name}"></script>`).join('')}
</head><body><div id="app"></div><script>
window.qaEvents=[];window.qaCommands=[];window.qaFeedChanges=0;window.qaSaved=[];
window.qaExpandOnFocus=!!window.qaExpandOnFocus;
const root=ReactDOM.createRoot(document.querySelector('#app'));
function App(){
  const [editorState,setEditorState]=React.useState(()=>window.qaInitialDraft
    ?Draft.EditorState.createWithContent(Draft.ContentState.createFromText(window.qaInitialDraft))
    :Draft.EditorState.createEmpty());
  const [identity,setIdentity]=React.useState('${account}');
  const [audience,setAudience]=React.useState(window.qaExpandOnFocus?null:'Everyone can reply');
  const [ownerVersion,setOwnerVersion]=React.useState(0);
  const [mediaLabel,setMediaLabel]=React.useState('Add photos or video');
  const [feedRevision,setFeedRevision]=React.useState(0);
  const [saved,setSaved]=React.useState(null);
  window.qaEditorState=editorState;
  window.qaChangeContext=kind=>ReactDOM.flushSync(()=>{
    if(kind==='owner')setOwnerVersion(value=>value+1);
    if(kind==='account')setIdentity('otherqa');
    if(kind==='audience')setAudience('Only people you mention can reply');
    if(kind==='navigation')setMediaLabel('Add private attachment');
  });
  window.qaChurnFeed=()=>ReactDOM.flushSync(()=>{window.qaFeedChanges++;setFeedRevision(value=>value+1);});
  const onChange=next=>{window.qaEditorState=next;setEditorState(next);};
  const value=editorState.getCurrentContent().getPlainText('\\n');
  const post=async()=>{
    const payload={account:identity,body:editorState.getCurrentContent().getPlainText('\\n'),audience};
    const response=await fetch('/owned-fixture/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(response.ok){window.qaSaved.push(payload);setSaved(payload);setEditorState(Draft.EditorState.createEmpty());}
  };
  return React.createElement(React.Fragment,null,
    React.createElement('nav',{id:'account-nav','aria-label':'Account navigation'},
      React.createElement('a',{'data-testid':'AppTabBar_Profile_Link',href:'/'+identity},'Owned QA profile')),
    React.createElement('main',{'aria-label':'Home timeline'},
      React.createElement('nav',{className:'tabs','aria-label':'Home timeline tabs'},
        React.createElement('button',{type:'button',role:'tab','aria-selected':'true'},'For you'),
        React.createElement('button',{type:'button',role:'tab','aria-selected':'false'},'Following')),
      React.createElement('div',{id:'inline-owner',key:ownerVersion,role:window.qaModal&&!saved?'dialog':undefined},
        React.createElement('a',{className:'avatar',href:'/'+identity,'aria-label':'Owned QA account avatar'},'QA'),
        React.createElement('div',{className:'compose-inner',onFocus:()=>{if(window.qaExpandOnFocus&&!audience)ReactDOM.flushSync(()=>setAudience('Everyone can reply'));}},
          React.createElement(Draft.Editor,{editorState,onChange,ariaLabel:'Post text',webDriverTestID:'tweetTextarea_0',placeholder:'What is happening?!'}),
          audience?React.createElement('button',{id:'audience',type:'button'},audience):null,
          React.createElement('div',{className:'compose-actions'},
            React.createElement('nav',{'aria-label':'Composer tools'},
              React.createElement('button',{type:'button','aria-label':mediaLabel},'Media'),
              React.createElement('button',{type:'button','aria-label':'Add emoji'},'Emoji')),
            React.createElement('button',{id:'post',type:'button','data-testid':'tweetButtonInline',disabled:!value,onClick:post},'Post')))),
      React.createElement('div',{id:'confirmation',role:'status'},saved?'Owned local QA post recorded: '+saved.body:''),
      saved?React.createElement('article',{'data-testid':'tweet'},
        React.createElement('div',{'data-testid':'User-Name'},
          React.createElement('a',{href:'/'+saved.account},'Owned QA account'),
          React.createElement('a',{href:'/'+saved.account+'/status/900'},React.createElement('time',{dateTime:new Date().toISOString()},'Now'))),
        React.createElement('div',{'data-testid':'tweetText'},saved.body)):null,
      React.createElement('div',{id:'feed'},[0,1,2].map(index=>React.createElement('article',{key:feedRevision+'-'+index},
        React.createElement('a',{href:'/feedqa/status/'+(feedRevision*10+index)},'Unrelated feed account'),
        React.createElement('p',null,'Live feed record '+feedRevision+'-'+index),
        React.createElement('button',{type:'button','aria-label':'Like feed item '+feedRevision+'-'+index},'Like'))))));
}
ReactDOM.flushSync(()=>root.render(React.createElement(App)));
window.qaPreparationOverlays=0;
window.qaArmPreparationOverlay=()=>document.querySelector('#post').addEventListener('pointerenter',event=>{
  if(!event.isTrusted)return;
  const rect=event.currentTarget.getBoundingClientRect(),overlay=document.createElement('button');
  overlay.id='qa-native-preparation-overlay';overlay.type='button';overlay.textContent='Owned temporary preparation overlay';
  overlay.style='position:fixed;z-index:100000;left:'+(rect.left-1)+'px;top:'+(rect.top-1)+'px;width:'+(rect.width+2)+'px;height:'+(rect.height+2)+'px';
  document.body.append(overlay);window.qaPreparationOverlays++;
},{once:true});
window.qaClearPreparationOverlay=()=>document.getElementById('qa-native-preparation-overlay')?.remove();
if(window.qaPartialSelection)document.querySelector('[data-testid="tweetTextarea_0"]').addEventListener('keydown',event=>{
  if(event.isTrusted&&event.code==='KeyA'&&(event.ctrlKey||event.metaKey))event.preventDefault();
},true);
for(const type of ['beforeinput','input','paste'])document.querySelector('#app').addEventListener(type,event=>{
  if(event.target.closest('[data-testid="tweetTextarea_0"]'))qaEvents.push({type,trusted:event.isTrusted,inputType:event.inputType,
    data:type==='paste'?event.clipboardData?.getData('text/plain'):event.data});
},true);
const execCommand=document.execCommand.bind(document);
document.execCommand=(command,showUI,value)=>{qaCommands.push({command,value});return execCommand(command,showUI,value);};
window.qaSnapshot=()=>{
  const editor=document.querySelector('[data-testid="tweetTextarea_0"]');
  return {model:qaEditorState.getCurrentContent().getPlainText('\\n'),modelBlocks:qaEditorState.getCurrentContent().getBlocksAsArray().map(block=>block.getText()),
    text:editor.textContent,blocks:[...editor.querySelectorAll('[data-block="true"]')].map(block=>block.textContent),
    postEnabled:!document.querySelector('#post').disabled,audience:document.querySelector('#audience')?.textContent||null,
    events:qaEvents,commands:qaCommands,feedChanges:qaFeedChanges,saved:qaSaved};
};
</script></body></html>`;

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-inline-social-mv3-'));
try {
  const extension = path.join(profile, 'extension');
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  // Read-only diagnostics in the disposable clone leave every production
  // permission, input, publication and completion decision intact.
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.inlineFixtureAgent = agent;\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const request = route.request(), requested = new URL(request.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (requested.origin === 'https://x.com') {
      if (request.isNavigationRequest() && requested.href === fixtureUrl && request.method() === 'GET')
        return route.fulfill({ contentType: 'text/html', body: html });
      if (requested.pathname.startsWith('/owned-fixture/') && assets.has(requested.pathname.split('/').at(-1)) && request.method() === 'GET')
        return route.fulfill({ contentType: 'text/javascript', body: assets.get(requested.pathname.split('/').at(-1)) });
      if (requested.pathname === '/owned-fixture/post' && request.method() === 'POST') {
        const payload = request.postDataJSON(); submissions.push({ case: current.name, payload });
        return route.fulfill({ status: 201, contentType: 'application/json', body: '{"owned":true}' });
      }
      return route.fulfill({ status: 404, body: '' });
    }
    if (/^https?:$/.test(requested.protocol)) {
      blockedRemote.push({ method: request.method(), origin: requested.origin }); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  // The worker can be reported before its extension APIs and module have
  // finished loading; wait for both before wrapping them.
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await worker.evaluate(() => !!(globalThis.chrome?.tabs && globalThis.chrome?.debugger && globalThis.inlineFixtureAgent))
      .catch(() => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await worker.evaluate(() => {
    const fetchOriginal = fetch.bind(globalThis);
    globalThis.inlineFixtureProbe = { commands: [], transports: [], feedback: [], blocked: [] };
    globalThis.fetch = (input, options) => {
      const requested = new URL(typeof input === 'string' ? input : input.url);
      if (requested.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(requested.protocol))
        return fetchOriginal(input, options);
      inlineFixtureProbe.blocked.push({ origin: requested.origin, method: options?.method || 'GET' });
      return Promise.reject(new Error('The owned inline composer fixture blocks external service requests.'));
    };
    const sendCommand = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (...args) => {
      inlineFixtureProbe.commands.push({ method: args[1], params: args[2] }); return sendCommand(...args);
    };
    const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      const result = await sendMessage(...args), message = args[1];
      if (/page_monitor|set_field|type_ax|click_ax/.test(message.action)) inlineFixtureProbe.transports.push({ tabId: args[0],
        action: message.action, params: { tool: message.params?.tool, ref_id: message.params?.ref_id,
          expectedModelSnapshot: !!message.params?.expectedModelSnapshot, fenceOnly: message.params?.fenceOnly }, result });
      return result;
    };
    chrome.runtime.onMessage.addListener(message => {
      if (message.action === 'page_feedback') inlineFixtureProbe.feedback.push(message.feedback);
    });
  });
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) =>
    chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => {
    window.inlineRunEvents = {};
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update' && inlineRunEvents[event.requestId])
        inlineRunEvents[event.requestId].push({ type: event.type, data: event.data });
    });
    return chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
      autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
      planReviewMode: 'never', maxAgentSteps: 10, systemOneEnabled: false, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);

  for (const specification of cases) {
    const page = await context.newPage(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    if (specification.focusExpansion) await page.addInitScript(() => { window.qaExpandOnFocus = true; });
    if (specification.prefilled) await page.addInitScript(() => { window.qaInitialDraft = 'Old owned draft "Local book" by @ownedqa.'; });
    if (specification.modal) await page.addInitScript(() => { window.qaModal = true; });
    if (specification.partialSelection) await page.addInitScript(() => { window.qaPartialSelection = true; });
    await page.goto(fixtureUrl);
    await page.waitForSelector('[data-testid="tweetTextarea_0"]');
    const initial = await page.evaluate(() => ({ state: qaSnapshot(), headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').length,
      formsOrDialogs: document.querySelectorAll('form,dialog,[role="form"],[role="dialog"]').length }));
    assert.equal(initial.state.model, specification.prefilled ? 'Old owned draft "Local book" by @ownedqa.' : '');
    assert.equal(initial.state.postEnabled, !!specification.prefilled);
    if (specification.focusExpansion) assert.equal(initial.state.audience, null);
    assert.equal(initial.headings, 0); assert.equal(initial.formsOrDialogs, specification.modal ? 1 : 0);
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).findLast(tab => tab.url === url)?.id, fixtureUrl);
    assert.ok(tabId);
    current = { ...specification, page, tabId, marker: `Owned inline regression case ${specification.name}.`, requests: [], calls: [],
      steps: 0, judges: 0, inferenceChanges: 0 };
    const probeStart = await worker.evaluate(() => ({ commands: inlineFixtureProbe.commands.length,
      transports: inlineFixtureProbe.transports.length, feedback: inlineFixtureProbe.feedback.length }));
    const task = `In this intercepted owned local QA fixture, publish exactly one post from the active ${account} account with exact text ${JSON.stringify(body)}.
Re-observe the Post button after writing, click it once, then verify the owned local confirmation. Do not post if the composer owner, account, audience or local controls change. ${current.marker}`;
    const requestId = `owned-inline-${specification.name}`;
    await harness.evaluate(id => { inlineRunEvents[id] = []; }, requestId);
    const result = await message('chat', { tabId, text: task, mode: 'act', requestId, locale: 'en' });
    const runEvents = await harness.evaluate(id => inlineRunEvents[id], requestId);
    const completionEvidence = await worker.evaluate(tabId => {
      const guard = inlineFixtureAgent._continuationExecutionEvidence.get(tabId);
      return { verifiedSubmission: guard?.verifiedSubmissionEvidence, terminal: guard?.workflowTerminalEvidence,
        publicationOutcomes: guard?.socialPublication?.outcomes,
        submit: inlineFixtureAgent._completionSubmitStates.get(tabId) };
    }, tabId);
    const state = await page.evaluate(() => qaSnapshot());
    const probe = await worker.evaluate(start => ({ commands: inlineFixtureProbe.commands.slice(start.commands),
      transports: inlineFixtureProbe.transports.slice(start.transports), feedback: inlineFixtureProbe.feedback.slice(start.feedback),
      blocked: inlineFixtureProbe.blocked }), probeStart);
    const tools = result.updates?.filter(event => event.type === 'tool_result').map(event => event.data) || [];
    const writes = tools.filter(tool => tool.name === specification.tool), clicks = tools.filter(tool => tool.name === 'click_ax');
    const localPosts = submissions.filter(post => post.case === specification.name);
    const evidence = { specification, initial, result, runEvents, completionEvidence, tools, state, probe, pageErrors, localPosts,
      provider: { ...current, page: undefined }, blockedRemote };
    await fs.writeFile(path.join(out, `${specification.name}-evidence.json`), JSON.stringify(evidence,
      (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
    assert.equal(current.providerError, undefined, current.providerError);
    assert.deepEqual(pageErrors, [], 'Real React/DraftJS reconciliation must remain valid.');
    if (specification.change) {
      assert.equal(current.calls.filter(call => call.name === specification.tool).length, 1, 'The provider must actually attempt the stale write once.');
      assert.ok(writes.length <= 1, 'Never retry a vetoed context change.');
      if (writes.length) {
        assert.equal(writes[0].result.success, false, JSON.stringify(writes));
        assert.equal(writes[0].result.noDispatch, true, JSON.stringify(writes));
        assert.equal(writes[0].result.dispatched, false, JSON.stringify(writes));
      } else {
        // A stale decision can be discarded by the pre-dispatch batch fence,
        // before Agent emits a tool_result. The real failed model validation
        // and absence of native input prove the veto independently.
        assert.ok(probe.transports.some(item => item.action === 'page_monitor_validate_model'
          && item.params.tool === specification.tool && item.params.ref_id === current.beforeWrite.editor && item.result?.ready === false),
        'The production model certificate must reject the stale local owner.');
      }
      assert.equal(state.model, ''); assert.deepEqual(state.saved, []);
      assert.deepEqual(localPosts, []); assert.equal(clicks.length, 0);
      assert.equal(probe.commands.filter(command => command.method === 'Input.insertText').length, 0);
      assert.deepEqual(state.events, [], 'A stale owner must be rejected before page input.');
    } else if (specification.partialSelection) {
      assert.equal(writes.length, 1);
      assert.equal(writes[0].result.success, false); assert.equal(writes[0].result.mutationMayHaveOccurred, false);
      assert.equal(writes[0].result.outcomeUnknown, false); assert.equal(writes[0].result.retryable, true);
      assert.equal(state.model, initial.state.model, 'Failed selection preserves the complete original application draft.');
      assert.deepEqual(state.saved, []); assert.deepEqual(localPosts, []); assert.equal(clicks.length, 0);
      assert.equal(probe.commands.filter(command => command.method === 'Input.insertText').length, 0);
      assert.equal(probe.commands.some(command => command.params?.code === 'Delete'), false);
      assert.deepEqual(state.events, [], 'An unproved replacement selection never dispatches text input.');
    } else {
      assert.equal(writes.length, specification.focusExpansion ? 2 : 1, 'Only an explicit fresh decision may retry a positively undispatched write.');
      if (specification.focusExpansion) {
        assert.equal(current.expansionResult.success, false, JSON.stringify(writes));
        assert.equal(current.expansionResult.noDispatch, true, JSON.stringify(writes));
        assert.equal(current.expansionResult.dispatched, false, JSON.stringify(writes));
        assert.equal(current.expansionState.model, '', 'Focus may reveal local controls, but must not insert stale-decision text.');
        assert.equal(current.expansionState.audience, 'Everyone can reply', 'Trusted preparation must exercise a real focus-triggered expansion.');
        assert.deepEqual(current.expansionState.events, []);
      }
      assert.equal(writes.at(-1).result.success, true, JSON.stringify(writes));
      assert.equal(writes.at(-1).result.verified, true, JSON.stringify(writes));
      assert.equal(current.afterWrite.model, body, 'Compare the real application EditorState before submitting.');
      assert.deepEqual(current.afterWrite.modelBlocks, [body]);
      assert.deepEqual(current.afterWrite.blocks, [body], 'React-rendered blocks must match the application document exactly.');
      assert.equal(current.afterWrite.text, body, 'No unmanaged duplicate text may exist outside DraftJS blocks.');
      assert.equal(current.afterWrite.postEnabled, true, 'The application must enable Post from its own editor state.');
      assert.deepEqual(current.afterWrite.commands, [], 'No execCommand wrapper or HTML mutation may enter framework-owned DOM.');
      const insertions = probe.commands.filter(command => command.method === 'Input.insertText');
      assert.equal(insertions.length, 1, 'Dispatch the exact text through CDP once.');
      assert.equal(insertions[0].params.text, body);
      assert.ok(current.afterWrite.events.some(event => ['beforeinput', 'input'].includes(event.type) && event.trusted));
      assert.ok(current.afterWrite.events.every(event => event.trusted), 'This single-line draft uses browser-trusted input.');
      assert.equal(current.postReobserved, true, 'Post must receive an independent current AX read after typing.');
      assert.equal(clicks.length, specification.nativePreparationVeto ? 2 : 1);
      if (specification.nativePreparationVeto) {
        assert.equal(current.postRetryReobserved, true);
        assert.equal(current.preparationVeto.initialTrustedNativeButton, true, JSON.stringify(current.preparationVeto));
        assert.equal(current.preparationVeto.method, 'cdp-native-button');
        assert.equal(current.vetoLedger.submitted, false); assert.equal(current.afterVeto.state.model, body);
        assert.equal(current.audits, 2, 'The native veto must clear provisional authorization and force a fresh audit.');
      }
      assert.equal(clicks.at(-1).result.dispatched, true, JSON.stringify(clicks));
      if (clicks.at(-1).result.success !== true) {
        assert.equal(clicks.at(-1).result.outcomeUnknown, true, JSON.stringify(clicks));
        assert.equal(clicks.at(-1).result.retryable, false, 'An acknowledged Post must never be retried after observation is interrupted.');
      }
      const confirmation = tools.findLast(tool => tool.name === 'get_accessibility_tree')?.result?.pageContent || '';
      assert.match(confirmation, /Owned local QA post recorded:/, 'A fresh installed-extension read must observe the owned save confirmation.');
      assert.match(confirmation, /\/ownedqa\/status\/900/, 'A fresh native record must independently expose the saved owned post.');
      assert.deepEqual(localPosts, [{ case: specification.name, payload: { account, body, audience: 'Everyone can reply' } }],
        'The owned local POST must contain exactly the application draft, once.');
      assert.deepEqual(state.saved, [{ account, body, audience: 'Everyone can reply' }]);
      assert.equal(state.model, ''); assert.equal(state.postEnabled, false);
      assert.equal(current.inferenceChanges, 2, 'Live feed must churn independently during both write and Post inference.');
      assert.equal(state.feedChanges, 2);
      assert.ok(probe.transports.some(item => item.action === 'page_monitor_validate_model' && item.result?.ready === true),
        'The production model monitor must validate a real document certificate.');
      const done = tools.findLast(tool => tool.name === 'done')?.result;
      assert.equal(done?.done, true, JSON.stringify(done));
      assert.equal(done?.outcome, 'success', JSON.stringify(done));
      assert.notEqual(done?.success, false, JSON.stringify(done));
      assert.equal(runEvents.findLast(event => event.type === 'run_complete')?.data?.status, 'completed');
      assert.equal(completionEvidence.verifiedSubmission, true, 'A model verdict alone cannot verify the social submission.');
      assert.deepEqual(completionEvidence.publicationOutcomes?.p1, { status: 'verified' });
      assert.equal(completionEvidence.terminal?.source, 'dispatch_bound_published_resource');
      assert.equal(completionEvidence.submit?.workflowBinding?.publishedResourceIdentity, 'twitter:status:900');
    }
    summaries.push({ case: specification.name, inputCommands: probe.commands.filter(command => command.method === 'Input.insertText').length,
      posts: localPosts.length, noDispatch: specification.change ? true : writes[0].result.noDispatch === true, feedChanges: state.feedChanges,
      postOutcomeUnknown: clicks[0]?.result?.outcomeUnknown === true,
      terminalOutcome: tools.findLast(tool => tool.name === 'done')?.result?.outcome,
      nativePublicationVerified: completionEvidence.publicationOutcomes?.p1?.status === 'verified' });
    await page.close();
  }
  assert.ok(blockedRemote.every(request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method)), 'No external mutation may be attempted.');
  const network = await worker.evaluate(() => inlineFixtureProbe.blocked);
  assert.ok(network.every(request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method)), 'No background external mutation may be attempted.');
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, installedMV3: true,
    framework: { react: require('react/package.json').version, draftJS: require('draft-js/package.json').version },
    summaries, externalPosts: 0, blockedRemote, blockedBackground: network, auxiliaryRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, installedMV3: true, actualReactDraftJS: true, cases: summaries, externalPosts: 0 }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-inline-social-mv3-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
