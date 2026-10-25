import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';

// Trace 61282dbf (WebBrain 40.7.1) on x.com/compose/post, through the actual
// installed MV3 background, page monitor, Agent and CDP input on React/DraftJS
// document nodes. Only inference and owned HTTP responses are deterministic;
// no real X page, account or posting service is contacted.
//   type_ax_after_bubble: WebBrain's own focus click makes the page draw its
//     bold/italic bubble in a body-level layer while the timeline behind the
//     dialog keeps updating. The write must still go through, once.
//   ambiguous_selector: [data-testid="tweetTextarea_0"] names the dialog's
//     composer and the hidden timeline composer. The model must be told so,
//     instead of every decision being discarded until "the page kept changing".
//   bubble_on_mousedown: the page draws the bubble already on mousedown, so
//     WebBrain's own release lands on it. That release is the action's input
//     to the page, not its preparation: the typing may be refused once, and
//     the next attempt types into the focused editor without pressing it.
//   iframe_focus_steal: the page moves focus from the editor into an iframe's
//     input each time the editor gets it. WebBrain's text must never be typed
//     into that iframe; nothing is posted.
//   iframe_focus_steal_quiet: the same on a page without the bubble and
//     without timeline updates, where the code before this fix typed the
//     post into the iframe.
// As in the trace's screenshot, the bubble is drawn over the point that was
// clicked, which for WebBrain's focus click is the middle of the editor.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-16/x-compose-dialog-mv3');
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
const fixtureUrl = 'https://x.com/compose/post';
const account = 'ownedqa';
const SELECTOR = '[data-testid="tweetTextarea_0"]';
// The account name appears once in the task, so it anchors the account.
const singleLine = 'Owned QA support is coming soon https://example.com/qa/pull/3195';
const cases = [
  { name: 'type_ax_after_bubble', first: 'type_ax', body: singleLine },
  { name: 'ambiguous_selector', first: 'type_text', body: singleLine },
  // The trace's screenshot: the bubble of an earlier click still covers the
  // middle of the focused editor when the model decides.
  { name: 'retry_under_bubble', first: 'type_ax', body: singleLine, bubbleFirst: true },
  { name: 'bubble_on_mousedown', first: 'type_ax', body: singleLine, bubbleOnMouseDown: true, retryWrite: true },
  { name: 'iframe_focus_steal', first: 'type_ax', body: singleLine, stealFocus: true },
  { name: 'iframe_focus_steal_quiet', first: 'type_ax', body: singleLine, stealFocus: true, quiet: true },
].filter(item => !process.env.WEBBRAIN_QUALITY_X_CASE || item.name === process.env.WEBBRAIN_QUALITY_X_CASE);
assert.ok(cases.length, 'Select an existing owned X compose case.');
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
  return { editor: ref(/textbox "Post text"(?!.*hidden=true)/), post: ref(/button "Post"(?!.*hidden=true)/) };
}
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['One exact owned local QA post, freshly verified.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Publish exactly one owned local QA post from the current ownedqa account and verify its confirmation.',
  steps: [{ id: '1', action: 'Read the compose dialog, write the exact draft once, re-observe Post, publish once and verify the owned confirmation.' }],
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
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'owned-x-memory',
        choices: [{ message: { role: 'assistant', content: '{"memories":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } }));
      return;
    }
    const pageTextReply = fixturePageTextReply(input.messages);
    if (pageTextReply) {
      auxiliaryRequests.push(input);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'owned-x-page-text',
        choices: [{ message: { role: 'assistant', content: pageTextReply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } }));
      return;
    }
    current.requests.push(input);
    assert.ok(current && JSON.stringify(input.messages).includes(current.marker), `Inference must retain this owned task authority: ${system.slice(0, 160)}`);
    let completion;
    if (system.startsWith("Compile the user's social-publication intent across languages.")) {
      completion = { role: 'assistant', content: JSON.stringify({ version: 1, status: 'ready',
        actions: [{ id: 'p1', platform: 'twitter', account: { source: 'task', start: account, end: account },
          posts: [{ body: { kind: 'exact', source: { source: 'task', start: current.body, end: current.body } },
            media: { kind: 'count', type: 'any', format: null, min: 0, max: 0 }, context: { kind: 'post', target: null } }] }],
        requirements: 'p1', prohibited: [], reason: 'The authentic task authorizes one exact local QA post.' }) };
    } else if (system.startsWith('Independently check whether the authentic user request authorizes this concrete public dispatch.')) {
      current.audits = (current.audits || 0) + 1;
      const audit = JSON.parse(textOf(input.messages.find(message => message.role === 'user')?.content));
      completion = { role: 'assistant', content: JSON.stringify({ key: audit.key, actionId: audit.action.id,
        authorized: true, reason: 'The exact owned body, account and plain-post scope match the authentic task.' }) };
    } else if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
      completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'Fresh owned page confirmation records the exact authorized local post.' }) };
    } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      const step = current.steps++;
      assert.ok(step < 24, 'The owned compose run must finish without looping.');
      const tools = latestTools(input.messages);
      const last = tools.at(-1);
      const observed = tools.findLast(tool => tool.name === 'get_accessibility_tree' && tool.result?.pageContent);
      const typed = tools.find(tool => tool.name === 'type_ax' && tool.result?.success === true);
      const refused = tools.find(tool => tool.name === 'type_text' && tool.result?.errorCode === 'action_binding_unavailable');
      const clicked = tools.find(tool => tool.name === 'click_ax');
      if (typed && !current.afterWriteState) {
        // The page as the write left it, before anything else happens.
        current.afterWriteState = await current.page.evaluate(() => qaSnapshot());
        current.bubbleCoveredWrite = await current.page.evaluate(() => qaBubbleCoversEditor());
      }
      let call;
      if (!observed) call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      else if (!typed && !tools.some(tool => tool.name === 'type_ax')) {
        current.beforeWrite ||= references(observed.result);
        assert.ok(current.beforeWrite.editor && current.beforeWrite.post, JSON.stringify(observed.result).slice(0, 4000));
        // As in the trace: the selector first, then the observed ref once
        // the selector's answer says why it cannot be used.
        call = current.first === 'type_text' && !refused
          ? { name: 'type_text', args: { selector: SELECTOR, text: current.body, clear: true } }
          : { name: 'type_ax', args: { ref_id: current.beforeWrite.editor, text: current.body, clear: true } };
      } else if (!typed && current.retryWrite && tools.filter(tool => tool.name === 'type_ax').length < 2) {
        call = { name: 'type_ax', args: { ref_id: current.beforeWrite.editor, text: current.body, clear: true } };
      } else if (!typed) call = { name: 'done', args: { outcome: 'failed', summary: 'The owned compose write failed.' } };
      else if (!clicked && last?.name !== 'get_accessibility_tree') call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      else if (!clicked) {
        const fresh = references(observed.result);
        assert.ok(fresh.post, 'The enabled Post control must be observed after writing.');
        current.postReobserved = true;
        call = { name: 'click_ax', args: { ref_id: fresh.post } };
      } else if (last?.name === 'click_ax') call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
      else call = { name: 'done', args: { outcome: 'success', summary: 'The owned local compose dialog post was published and verified.' } };
      current.calls.push(call);
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-x-${current.name}-${step}`,
        type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-x-${current.name}-${current.requests.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  } catch (error) {
    if (current) current.providerError = error.stack;
    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Compose post</title>
<style>${draftCss}
body{margin:0;background:#fff;color:#111;font:17px system-ui}#app{display:flex;gap:24px;margin:20px}
#account-nav{width:170px}a{color:inherit}main{width:660px}
#timeline-composer{padding:16px;border:1px solid #bbb;min-height:120px}
#layers{position:fixed;inset:0;display:flex;justify-content:center;align-items:flex-start;z-index:10}
#backdrop{position:absolute;inset:0;background:rgba(0,0,0,.4)}
#compose{position:relative;margin-top:40px;width:600px;background:#fff;border-radius:16px;padding:12px}
#compose .public-DraftEditor-content{min-height:96px}
button{font:inherit;padding:8px;margin:3px}article{padding:16px;border:1px solid #ddd;min-height:60px}
#format-bubble{position:fixed;z-index:20;box-sizing:border-box;width:72px;height:34px;display:flex;gap:4px;background:#111;border-radius:8px;padding:2px}
[data-testid="tweetText"]{white-space:pre-wrap}</style>
${libraryFiles.map(([name]) => `<script src="/owned-fixture/${name}"></script>`).join('')}
</head><body><div id="app"></div><script>
window.qaEvents=[];window.qaSaved=[];window.qaFeedChanges=0;window.qaBubbles=0;window.qaBubblePresses=0;
const root=ReactDOM.createRoot(document.querySelector('#app'));
function App(){
  const [editorState,setEditorState]=React.useState(()=>Draft.EditorState.createEmpty());
  const [inlineState,setInlineState]=React.useState(()=>Draft.EditorState.createEmpty());
  const [open,setOpen]=React.useState(true);
  const [feedRevision,setFeedRevision]=React.useState(0);
  const [bubble,setBubble]=React.useState(null);
  const [saved,setSaved]=React.useState(null);
  window.qaEditorState=editorState;
  window.qaChurnFeed=()=>ReactDOM.flushSync(()=>{window.qaFeedChanges++;setFeedRevision(value=>value+1);});
  window.qaShowBubble=point=>ReactDOM.flushSync(()=>{window.qaBubbles++;setBubble({left:point.x-36,top:point.y-17});});
  const onChange=next=>{window.qaEditorState=next;setEditorState(next);};
  const value=editorState.getCurrentContent().getPlainText('\\n');
  const post=async()=>{
    const payload={account:'${account}',body:editorState.getCurrentContent().getPlainText('\\n'),audience:'Everyone can reply'};
    const response=await fetch('/owned-fixture/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(response.ok){window.qaSaved.push(payload);setSaved(payload);setOpen(false);setBubble(null);setEditorState(Draft.EditorState.createEmpty());}
  };
  return React.createElement(React.Fragment,null,
    React.createElement('nav',{id:'account-nav','aria-label':'Account navigation'},
      React.createElement('a',{'data-testid':'AppTabBar_Profile_Link',href:'/${account}'},'Owned QA profile')),
    React.createElement('main',{'aria-label':'Home timeline','aria-hidden':open?'true':undefined},
      React.createElement('button',{id:'new-posts',type:'button'},'New posts are available ('+feedRevision+')'),
      React.createElement('div',{id:'timeline-composer'},
        React.createElement(Draft.Editor,{editorState:inlineState,onChange:setInlineState,ariaLabel:'Post text',webDriverTestID:'tweetTextarea_0',placeholder:'What is happening?!'}),
        React.createElement('button',{type:'button','data-testid':'tweetButtonInline',disabled:true},'Post')),
      React.createElement('div',{id:'confirmation',role:'status'},saved?'Your post was sent: '+saved.body:''),
      saved?React.createElement('article',{'data-testid':'tweet'},
        React.createElement('div',{'data-testid':'User-Name'},
          React.createElement('a',{href:'/'+saved.account},'Owned QA account'),
          React.createElement('a',{href:'/'+saved.account+'/status/900'},React.createElement('time',{dateTime:new Date().toISOString()},'Now'))),
        React.createElement('div',{'data-testid':'tweetText'},saved.body)):null,
      React.createElement('div',{id:'feed'},[0,1,2].map(index=>React.createElement('article',{key:feedRevision+'-'+index},
        React.createElement('a',{href:'/feedqa/status/'+(feedRevision*10+index)},'Unrelated feed account'),
        React.createElement('p',null,'Live feed record '+feedRevision+'-'+index))))),
    open?React.createElement('div',{id:'layers'},
      React.createElement('div',{id:'backdrop'}),
      React.createElement('div',{id:'compose',role:'dialog','aria-modal':'true'},
        React.createElement('div',{role:'progressbar','aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':0}),
        React.createElement('button',{type:'button','aria-label':'Close'},'x'),
        React.createElement('button',{type:'button'},'Drafts'),
        React.createElement('button',{type:'button','aria-label':'Choose audience'},'Everyone'),
        React.createElement('div',{id:'compose-editor'},
          React.createElement(Draft.Editor,{editorState,onChange,ariaLabel:'Post text',webDriverTestID:'tweetTextarea_0',placeholder:'What is happening?!'})),
        React.createElement('button',{type:'button',id:'reply-scope'},'Everyone can reply'),
        React.createElement('nav',{'aria-label':'Composer tools'},
          React.createElement('button',{type:'button','aria-label':'Add photos or video'},'Media'),
          React.createElement('button',{type:'button','aria-label':'Add emoji'},'Emoji')),
        React.createElement('button',{id:'post',type:'button','data-testid':'tweetButton',disabled:!value,onClick:post},'Post'))):null,
    bubble?ReactDOM.createPortal(React.createElement('div',{id:'format-bubble',onPointerDown:()=>{window.qaBubblePresses++;},style:{left:bubble.left+'px',top:bubble.top+'px'}},
      React.createElement('button',{type:'button','aria-label':'Bold'},'B'),
      React.createElement('button',{type:'button','aria-label':'Italic'},'I')),document.body):null);
}
ReactDOM.flushSync(()=>root.render(React.createElement(App)));
// The live timeline behind the dialog keeps updating while it is open.
window.qaFeed=setInterval(()=>{if(document.getElementById('compose')&&!window.qaQuiet)qaChurnFeed();},80);
// A real click in the dialog's editor makes the page draw its bold/italic
// bubble in a body-level layer over the clicked point as the button is
// released (in the trace, before WebBrain reselected the editor).
document.addEventListener('mouseup',event=>{
  const editor=event.target.closest?.('#compose [data-testid="tweetTextarea_0"]');
  if(!event.isTrusted||!editor||window.qaBubbleOnMouseDown||window.qaQuiet)return;
  qaShowBubble({x:event.clientX,y:event.clientY});
});
// A page that draws it already as the button goes down.
document.addEventListener('mousedown',event=>{
  const editor=event.target.closest?.('#compose [data-testid="tweetTextarea_0"]');
  if(!event.isTrusted||!editor||!window.qaBubbleOnMouseDown)return;
  qaShowBubble({x:event.clientX,y:event.clientY});
});
// A page that moves focus from the dialog's editor into an iframe's input
// each time the editor receives it (after the current script has finished).
window.qaEnableFocusSteal=()=>{
  const frame=document.createElement('iframe');frame.id='qa-frame';frame.title='GIF search';
  frame.srcdoc='<!doctype html><input id="inner" aria-label="Search GIFs">';
  frame.style.cssText='position:fixed;right:8px;bottom:8px;width:240px;height:60px;z-index:5;border:1px solid #ccc';
  document.body.append(frame);
  window.qaSteals=0;
  document.addEventListener('focusin',event=>{
    if(!event.target.closest?.('#compose [data-testid="tweetTextarea_0"]'))return;
    queueMicrotask(()=>{const inner=frame.contentDocument?.getElementById('inner');if(inner){window.qaSteals++;inner.focus();}});
  });
  return new Promise(resolve=>frame.addEventListener('load',()=>resolve(true),{once:true}));
};
window.qaFrameValue=()=>document.getElementById('qa-frame')?.contentDocument?.getElementById('inner')?.value??null;
window.qaBubbleCoversEditor=()=>{
  const editor=document.querySelector('#compose [data-testid="tweetTextarea_0"]');
  if(!editor)return false;
  const rect=editor.getBoundingClientRect();
  return !!document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.closest('#format-bubble');
};
for(const type of ['beforeinput','input'])document.addEventListener(type,event=>{
  if(event.target.closest?.('#compose'))qaEvents.push({type,trusted:event.isTrusted,inputType:event.inputType});
},true);
window.qaSnapshot=()=>{
  const editor=document.querySelector('#compose [data-testid="tweetTextarea_0"]');
  return {model:qaEditorState.getCurrentContent().getPlainText('\\n'),text:editor?.textContent??null,
    blocks:editor?[...editor.querySelectorAll('[data-block="true"]')].map(block=>block.textContent):null,
    open:!!document.getElementById('compose'),postEnabled:!!document.querySelector('#post')&&!document.querySelector('#post').disabled,
    bubbles:qaBubbles,bubblePresses:qaBubblePresses,feedChanges:qaFeedChanges,events:qaEvents,saved:qaSaved,
    editors:document.querySelectorAll('[data-testid="tweetTextarea_0"]').length};
};
</script></body></html>`;

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-x-compose-mv3-'));
try {
  const extension = path.join(profile, 'extension');
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  // Read-only diagnostics in the disposable clone leave every production
  // permission, input, publication and completion decision intact.
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.xComposeFixtureAgent = agent;\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1126, height: 745 },
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
        submissions.push({ case: current.name, payload: request.postDataJSON() });
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
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await worker.evaluate(() => !!(globalThis.chrome?.tabs && globalThis.chrome?.debugger && globalThis.xComposeFixtureAgent))
      .catch(() => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await worker.evaluate(() => {
    const fetchOriginal = fetch.bind(globalThis);
    globalThis.xComposeFixtureProbe = { commands: [], blocked: [] };
    globalThis.fetch = (input, options) => {
      const requested = new URL(typeof input === 'string' ? input : input.url);
      if (requested.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(requested.protocol))
        return fetchOriginal(input, options);
      xComposeFixtureProbe.blocked.push({ origin: requested.origin, method: options?.method || 'GET' });
      return Promise.reject(new Error('The owned X compose fixture blocks external service requests.'));
    };
    const sendCommand = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (...args) => {
      xComposeFixtureProbe.commands.push({ method: args[1], params: args[2] }); return sendCommand(...args);
    };
  });
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) =>
    chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => {
    window.xRunEvents = {};
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update' && xRunEvents[event.requestId]) xRunEvents[event.requestId].push({ type: event.type, data: event.data });
    });
    return chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
      autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
      planReviewMode: 'never', maxAgentSteps: 12, systemOneEnabled: false, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);

  for (const specification of cases) {
    const page = await context.newPage(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(fixtureUrl);
    await page.waitForSelector('#compose [data-testid="tweetTextarea_0"]');
    const initial = await page.evaluate(() => qaSnapshot());
    assert.equal(initial.editors, 2, 'X names the dialog composer and the hidden timeline composer alike.');
    assert.equal(initial.open, true); assert.equal(initial.postEnabled, false);
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).findLast(tab => tab.url === url)?.id, fixtureUrl);
    assert.ok(tabId);
    if (specification.bubbleFirst) {
      // A click of the person's own before the task, as left in the trace's screenshot.
      const centre = await page.evaluate(() => {
        const rect = document.querySelector('#compose [data-testid="tweetTextarea_0"]').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(centre.x, centre.y);
      await page.waitForFunction(() => qaBubbleCoversEditor());
      await page.waitForTimeout(300);
    }
    if (specification.stealFocus) {
      assert.equal(await page.evaluate(() => qaEnableFocusSteal()), true);
      await page.waitForTimeout(300);
    }
    if (specification.bubbleOnMouseDown) await page.evaluate(() => { window.qaBubbleOnMouseDown = true; });
    // No bubble and no timeline updates: a page where nothing covers the editor.
    if (specification.quiet) await page.evaluate(() => { window.qaQuiet = true; });
    const body = specification.body;
    const editorRect = await page.evaluate(() => {
      const rect = document.querySelector('#compose [data-testid="tweetTextarea_0"]').getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    current = { ...specification, page, tabId, marker: `Owned X compose regression case ${specification.name}.`, requests: [], calls: [], steps: 0 };
    const probeStart = await worker.evaluate(() => xComposeFixtureProbe.commands.length);
    const task = `In this intercepted owned local QA fixture, publish exactly one post from the active ${account} account with exact text ${JSON.stringify(body)}.
Re-observe the Post button after writing, click it once, then verify the owned local confirmation. ${current.marker}`;
    const requestId = `owned-x-${specification.name}`;
    await harness.evaluate(id => { xRunEvents[id] = []; }, requestId);
    const result = await message('chat', { tabId, text: task, mode: 'act', requestId, locale: 'en' });
    const runEvents = await harness.evaluate(id => xRunEvents[id], requestId);
    const state = await page.evaluate(() => qaSnapshot());
    const commands = await worker.evaluate(start => xComposeFixtureProbe.commands.slice(start), probeStart);
    const tools = result.updates?.filter(event => event.type === 'tool_result').map(event => event.data) || [];
    const localPosts = submissions.filter(post => post.case === specification.name);
    const evidence = { specification, initial, result, runEvents, tools, state, commands: commands.filter(command => command.method?.startsWith('Input.')),
      pageErrors, localPosts, provider: { ...current, page: undefined }, blockedRemote };
    await fs.writeFile(path.join(out, `${specification.name}-evidence.json`), JSON.stringify(evidence,
      (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
    assert.equal(current.providerError, undefined, current.providerError);
    assert.deepEqual(pageErrors, [], 'Real React/DraftJS reconciliation must remain valid.');
    const statuses = runEvents.filter(event => event.type === 'run_status').map(event => event.data?.status);
    assert.equal(statuses.includes('page_unstable'), false, JSON.stringify({ statuses, tools: tools.map(tool => [tool.name, tool.result?.success, tool.result?.error]) }));
    assert.equal(runEvents.some(event => event.type === 'failure_recovery'), false);
    if (specification.first === 'type_text') {
      const refused = tools.filter(tool => tool.name === 'type_text');
      assert.equal(refused.length, 1, JSON.stringify(tools.map(tool => [tool.name, tool.result?.errorCode])));
      assert.equal(refused[0].result.success, false);
      assert.equal(refused[0].result.errorCode, 'action_binding_unavailable');
      assert.equal(refused[0].result.bindingFailure, 'target_ambiguous');
      assert.equal(refused[0].result.noDispatch, true);
      assert.match(refused[0].result.error, /matches more than one element/);
    }
    const writes = tools.filter(tool => tool.name === 'type_ax');
    if (specification.retryWrite) {
      // Refused at most once, without any text; then written.
      assert.ok(writes.length >= 1 && writes.length <= 2, JSON.stringify(writes));
      if (writes.length === 2) assert.equal(writes[0].result.success, false, JSON.stringify(writes[0].result));
    } else assert.equal(writes.length, 1, JSON.stringify(writes));
    if (specification.stealFocus) {
      // The text command was refused before it was sent: nothing reached the
      // iframe the page moved focus into, the editor or the posting service.
      const frameValue = await page.evaluate(() => qaFrameValue());
      assert.equal(frameValue, '', 'No text may be typed into the iframe that took focus.');
      assert.ok(await page.evaluate(() => qaSteals) >= 1, 'The page moved focus into the iframe.');
      assert.equal(writes[0].result.success, false, JSON.stringify(writes[0].result));
      assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 0, 'No text command was sent.');
      assert.equal(state.model, '');
      assert.deepEqual(localPosts, []);
      assert.equal(tools.filter(tool => tool.name === 'click_ax').length, 0);
      summaries.push({ case: specification.name, inputCommands: 0, frameValue, refusal: writes[0].result.preparationVeto || writes[0].result.error,
        posts: 0, feedChanges: state.feedChanges, statuses: [...new Set(statuses)] });
      await page.close();
      continue;
    }
    assert.equal(writes.at(-1).result.success, true, JSON.stringify(writes.at(-1).result));
    assert.equal(writes.at(-1).result.verified, true);
    const insertions = commands.filter(command => command.method === 'Input.insertText');
    const presses = commands.filter(command => command.method === 'Input.dispatchMouseEvent' && command.params?.type === 'mousePressed'
      && command.params.x >= editorRect.left && command.params.x <= editorRect.right && command.params.y >= editorRect.top && command.params.y <= editorRect.bottom);
    assert.equal(insertions.length, 1, 'Dispatch the exact text through CDP once.');
    assert.equal(insertions[0].params.text, body);
    // One press focuses the editor, none when its centre was already covered.
    // Bold and Italic are never pressed.
    assert.equal(presses.length, specification.bubbleFirst ? 0 : 1, JSON.stringify(presses));
    assert.equal(state.bubblePresses, 0, 'Bold and Italic are never pressed.');
    assert.ok(state.bubbles >= 1, 'The page drew its bubble over the clicked point.');
    assert.equal(current.bubbleCoveredWrite, true, 'The bubble covered the middle of the editor while the text was written.');
    assert.ok(state.feedChanges >= 5, 'The timeline behind the dialog kept updating.');
    assert.ok(state.events.some(event => event.trusted && ['beforeinput', 'input'].includes(event.type)));
    assert.equal(current.postReobserved, true);
    assert.equal(tools.filter(tool => tool.name === 'click_ax').length, 1);
    assert.deepEqual(localPosts, [{ case: specification.name, payload: { account, body, audience: 'Everyone can reply' } }],
      'The owned local POST must contain exactly the application draft, once.');
    assert.equal(state.open, false);
    const done = tools.findLast(tool => tool.name === 'done')?.result;
    assert.equal(done?.outcome, 'success', JSON.stringify(done));
    assert.equal(runEvents.findLast(event => event.type === 'run_complete')?.data?.status, 'completed');
    assert.equal(current.afterWriteState.model, body, 'The application draft holds exactly the text.');
    summaries.push({ case: specification.name, writes: writes.length, inputCommands: insertions.length, presses: presses.length, posts: localPosts.length,
      bubbles: state.bubbles, bubbleCoveredWrite: current.bubbleCoveredWrite, feedChanges: state.feedChanges, statuses: [...new Set(statuses)] });
    await page.close();
  }
  assert.ok(blockedRemote.every(request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method)), 'No external mutation may be attempted.');
  const network = await worker.evaluate(() => xComposeFixtureProbe.blocked);
  assert.ok(network.every(request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method)), 'No background external mutation may be attempted.');
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, installedMV3: true,
    framework: { react: require('react/package.json').version, draftJS: require('draft-js/package.json').version },
    summaries, externalPosts: 0 }, null, 2));
  console.log(JSON.stringify({ passed: true, installedMV3: true, actualReactDraftJS: true, cases: summaries, externalPosts: 0 }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-x-compose-mv3-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
