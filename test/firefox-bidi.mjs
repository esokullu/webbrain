import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FirefoxBidiClient } from '../src/firefox/src/bidi/client.js';
import { BidiSession } from '../firefox-companion/session.mjs';
import { pageFeedbackMethods } from '../src/firefox/src/agent/page-feedback.js';

const id = () => crypto.randomUUID();

test('uploads register input dispatches with the extension monitor', async () => {
  const tab = 955, owner = { ...pageFeedbackMethods, isRunning: () => true, _checkAbort: () => false };
  const guard = { documentToken: 'file-document', revision: 0, operationId: 'upload' };
  const registrations = [];
  const client = new FirefoxBidiClient({ tabs: { sendMessage: async (_tab, message) => {
    registrations.push(message.params); return { guard };
  } } });
  client.runs.set(tab, { runId: id(), bound: true });
  client.request = async (_command, args) => { assert.deepEqual(args.payload.pageFeedbackGuard, guard); return { success: true }; };
  await owner._beginPageFeedbackRun(tab, 'interactive');
  try {
    await client.perform(tab, 'upload', { selector: '#file' });
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].kind, 'input');
    assert.equal(registrations[0].navigationCandidate, false);
    assert.equal(registrations[0].fenceOnly, true);
  } finally { owner._finishPageFeedbackRun(tab); }
});

test('an unfocused upload marks the file input instead of the active control', async () => {
  const session = new BidiSession(), runId = id(), attributes = new Map(), focusedAttributes = new Map();
  const guard = { documentToken: 'file-document', revision: 0, operationId: 'upload' };
  const token = id(), focused = { setAttribute: (name, value) => focusedAttributes.set(name, value) };
  const el = { isConnected: true, tagName: 'INPUT', type: 'file', files: [],
    getRootNode: () => ({ activeElement: focused }),
    getAttribute: name => name === 'data-webbrain-bidi' ? token : attributes.get(name),
    removeAttribute: name => attributes.delete(name), setAttribute: (name, value) => attributes.set(name, value) };
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'file' } });
  session.call = async (_match, declaration, args = []) => ({ result: { value: vm.runInNewContext(`(${declaration})`, {
    document: { documentElement: { getAttribute: () => 'file-document:0' } },
  })(el, ...args.map(arg => arg.value)) } });
  session.send = async method => {
    if (method === 'input.setFiles') {
      assert.equal(JSON.parse(attributes.get('data-webbrain-native-action')).kind, 'input');
      assert.equal(focusedAttributes.has('data-webbrain-native-action'), false);
      el.files = [{ name: 'test.txt', size: 1 }];
    }
    return {};
  };
  try {
    assert.equal((await session.perform(runId, 'upload', { token, base64: 'eA==', filename: 'test.txt', pageFeedbackGuard: guard })).success, true);
  } finally { await session.close(); }
});
test('connection loss cannot fall through to synthetic input', async () => {
  let messages = 0;
  const client = new FirefoxBidiClient({ tabs: { sendMessage() { messages++; } } });
  client.runs.set(1, { runId: id(), bound: true });
  client.disconnect();
  const result = await client.sendContent(1, { action: 'click' });
  assert.equal(result.noDispatch, true);
  assert.equal(messages, 0);
});
test('a replacement run cannot inherit prepared input from its predecessor', async () => {
  let finish;
  const client = new FirefoxBidiClient({ tabs: { sendMessage: () => new Promise(resolve => { finish = resolve; }) } });
  client.runs.set(1, { runId: id(), bound: true });
  let dispatches = 0; client.request = async () => { dispatches++; };
  const pending = client.sendContent(1, { action: 'click' });
  await Promise.resolve();
  client.runs.set(1, { runId: id(), bound: true });
  finish({ bidiPrepared: true, url: 'https://example.com/' });
  assert.equal((await pending).noDispatch, true);
  assert.equal(dispatches, 0);
});
test('stopping during native tab binding prevents late ownership', async () => {
  const session = new BidiSession(); const runId = id();
  let finish;
  session.locate = () => new Promise(resolve => { finish = resolve; });
  session.call = async () => ({});
  const opening = session.openRun(runId, id(), 'https://example.com/');
  await session.closeRun(runId);
  finish({ context: 'tab' });
  await assert.rejects(opening, /stopped/);
  assert.equal(session.runs.size, 0);
});
test('dialogs are scoped to a live run and navigation permission is single use', () => {
  const session = new BidiSession(); const replies = [];
  session.send = async (method, params) => { replies.push({ method, ...params }); };
  const event = (context, type) => session.receive({ method: 'browsingContext.userPromptOpened', params: { context, type } });
  event('idle', 'alert'); assert.equal(replies.length, 0);
  const run = { context: 'owned', navigation: false }; session.runs.set(id(), run);
  for (const type of ['confirm', 'prompt', 'beforeunload', 'alert']) event('owned', type);
  assert.deepEqual(replies.map(item => item.accept), [false, false, false, true]);
  run.navigation = true;
  event('owned', 'beforeunload'); event('owned', 'beforeunload');
  assert.deepEqual(replies.slice(-2).map(item => item.accept), [true, false]);
});
test('target lookup rejects ambiguity even when URLs match', async () => {
  const session = new BidiSession();
  session.send = async method => method === 'browsingContext.getTree'
    ? { contexts: [{ context: 'a', url: 'https://example.com/' }, { context: 'b', url: 'https://example.com/' }] }
    : { nodes: [{ sharedId: 'node' }] };
  await assert.rejects(session.locate(id(), 'https://example.com/'), /ambiguous/);
});
test('stop during target preparation prevents input dispatch', async () => {
  const session = new BidiSession(); const runId = id(); const sent = [];
  session.runs.set(runId, { context: 'a' });
  session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
  session.call = async () => { await session.closeRun(runId); return { result: { value: true } }; };
  session.send = async method => { sent.push(method); return {}; };
  await assert.rejects(session.perform(runId, 'click', {}), /stopped/);
  assert.equal(sent.includes('input.performActions'), false);
});
for (const failAt of [1, 2]) {
  test(`page revision change before native input ${failAt} preserves dispatch evidence`, async () => {
    const session = new BidiSession(), runId = id();
    session.runs.set(runId, { context: 'a' });
    session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
    let marks = 0, inputs = 0;
    session.call = async (_match, declaration) => ({ result: { value:
      declaration.includes('data-webbrain-page-revision') ? ++marks < failAt
        : declaration.includes('el.innerText : el.value') ? '' : true } });
    session.send = async method => { if (method === 'input.performActions') inputs++; return {}; };
    await assert.rejects(session.perform(runId, 'type', { text: 'ab', clear: false,
      pageFeedbackGuard: { documentToken: 'doc', revision: 7, operationId: 'op' } }), error => {
      assert.equal(error.code, 'page_feedback_pending');
      assert.equal(error.dispatchState.noDispatch, failAt === 1);
      assert.equal(error.dispatchState.dispatched, failAt === 2);
      assert.equal(error.dispatchState.outcomeUnknown, failAt === 2);
      return true;
    });
    assert.equal(inputs, failAt - 1, 'No subsequent character may be sent after the intervention');
  });
}
for (const platform of ['Win32', 'MacIntel']) {
  test(`field clearing renews native attribution between modifier and A on ${platform}`, async () => {
    const session = new BidiSession(), runId = id(), sent = [];
    session.runs.set(runId, { context: 'a' });
    session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
    let marks = 0;
    session.call = async (_match, declaration) => ({ result: { value:
      declaration.includes('data-webbrain-page-revision') ? (++marks, true)
        : declaration.includes('navigator.platform') ? platform
          : declaration.includes('el.innerText : el.value') ? '' : true } });
    session.send = async (method, params) => { if (method === 'input.performActions') sent.push({ marks, actions: params.actions[0].actions }); return {}; };
    await session.perform(runId, 'field', { text: 'x', pageFeedbackGuard: { documentToken: 'doc', revision: 0, operationId: 'op' } });
    assert.deepEqual(sent.map(item => item.marks), [1, 2, 3, 4]);
    assert.deepEqual(sent[0].actions, [{ type: 'keyDown', value: platform === 'MacIntel' ? '\uE03D' : '\uE009' }]);
    assert.equal(sent[1].actions[0].value, 'a');
    assert.equal(sent[2].actions[0].value, '\uE003');
  });
}
test('human intervention after the clear modifier blocks A and releases held keys', async () => {
  const session = new BidiSession(), runId = id(), sent = [];
  session.runs.set(runId, { context: 'a' });
  session.locate = async () => ({ context: 'a', node: { sharedId: 'el' } });
  let marks = 0;
  session.call = async (_match, declaration) => ({ result: { value:
    declaration.includes('data-webbrain-page-revision') ? ++marks < 2
      : declaration.includes('navigator.platform') ? 'Win32'
        : declaration.includes('el.innerText : el.value') ? '' : true } });
  session.send = async method => { sent.push(method); return {}; };
  await assert.rejects(session.perform(runId, 'field', { text: 'x',
    pageFeedbackGuard: { documentToken: 'doc', revision: 0, operationId: 'op' } }), error => {
    assert.equal(error.code, 'page_feedback_pending');
    assert.equal(error.dispatchState.dispatched, true);
    assert.equal(error.dispatchState.outcomeUnknown, true);
    return true;
  });
  assert.equal(sent.filter(method => method === 'input.performActions').length, 1);
  assert.equal(sent.at(-1), 'input.releaseActions');
});
test('unsupported commands and modifiers fail before touching the page', async () => {
  const session = new BidiSession(); const runId = id();
  session.runs.set(runId, { context: 'a' });
  await assert.rejects(session.perform(runId, 'rawScript', {}), /Unsupported/);
  await assert.rejects(session.perform(runId, 'key', { modifiers: ['Control'] }), /modifiers/);
});

test('installer and native launcher preserve Firefox message framing and command whitelist', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'webbrain-native-test-'));
  try {
    const install = spawnSync(process.execPath, ['firefox-companion/install.mjs', directory], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const manifest = JSON.parse(await readFile(join(directory, 'one.webbrain.bidi.json'), 'utf8'));
    // On Windows the wrapper is a .cmd batch file, which Node cannot spawn
    // directly (CreateProcess EINVAL); route it through cmd.exe the same way
    // Firefox does. POSIX wrappers are executable scripts and spawn directly.
    const spawnHost = input => process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', manifest.path], { input, timeout: 5000 })
      : spawnSync(manifest.path, [], { input, timeout: 5000 });
    assert.deepEqual(manifest.allowed_extensions, ['webbrain@esokullu.com']);
    const message = Buffer.from(JSON.stringify({ id: 12, command: 'script.evaluate', expression: 'arbitrary code' }));
    const header = Buffer.alloc(4); header.writeUInt32LE(message.length);
    const result = spawnHost(Buffer.concat([header, message]));
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.equal(result.stdout.readUInt32LE(0), result.stdout.length - 4);
    assert.deepEqual(JSON.parse(result.stdout.subarray(4)), { id: 12, error: 'Unknown companion command' });
    const rejected = Buffer.from(JSON.stringify({id:13,command:'perform',runId:id(),action:'click',payload:{}}));
    const rejectedHeader = Buffer.alloc(4); rejectedHeader.writeUInt32LE(rejected.length);
    const rejectedResult = spawnHost(Buffer.concat([rejectedHeader, rejected]));
    assert.equal(rejectedResult.status,0,rejectedResult.stderr?.toString());
    const failure = JSON.parse(rejectedResult.stdout.subarray(4));
    assert.equal(failure.id,13);
    assert.deepEqual(failure.dispatchState,{dispatched:false,noDispatch:true,outcomeUnknown:false,retryable:true});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('expired action deadline fails before target lookup', async () => {
  const session = new BidiSession(); const runId = id();
  session.runs.set(runId, { context: 'a' });
  session.locate = () => assert.fail('expired actions must not locate a target');
  await assert.rejects(session.perform(runId, 'click', { deadlineAt: Date.now() - 1 }), /deadline/);
});

test('blank-tab runs defer binding and retain ownership through navigation', async () => {
  let url = 'about:blank', injections = 0; const calls = [];
  const client = new FirefoxBidiClient({
    storage: { local: { get: async () => ({firefoxBidiEnabled:true}) } },
    tabs: {
      get: async () => ({url}),
      update: async (_id, value) => { url = value.url; },
      executeScript: async (_tab, options) => { injections++; assert.equal(options.file, '/src/bidi/bind.js'); assert.equal(options.code, undefined); return [{token:id(), url}]; },
    },
  });
  client.connect = async () => ({});
  client.request = async command => { calls.push(command); return {}; };
  await client.startRun(1);
  assert.equal(injections, 0);
  assert.ok(client.runs.has(1));
  assert.equal((await client.perform(1, 'navigate', {url:'https://example.com/'})).bindingDeferred, true);
  await client.bindRun(1, client.runs.get(1));
  assert.equal(injections, 1);
  assert.deepEqual(calls, ['openRun']);
});
test('pending dialogs are handled only after binding their owner', async () => {
  const session = new BidiSession(); const calls = [];
  session.send = async (method, params) => { calls.push({method,params}); return {}; };
  session.locate = async () => ({context:'tab', node:{sharedId:'html'}});
  session.receive({method:'browsingContext.userPromptOpened',params:{context:'tab',type:'confirm'}});
  assert.equal(calls.length, 0);
  await session.openRun(id(), id(), 'https://example.com/');
  assert.equal(calls[0].method, 'browsingContext.handleUserPrompt');
  assert.equal(calls[0].params.accept, false);
  assert.equal(session.dialogs.size, 0);
});
test('closed idle dialogs are not replayed when a task binds', async () => {
  const session = new BidiSession(); const calls = [];
  session.send = async method => { calls.push(method); return {}; };
  session.locate = async () => ({context:'tab', node:{sharedId:'html'}});
  session.receive({method:'browsingContext.userPromptOpened',params:{context:'tab',type:'alert'}});
  session.receive({method:'browsingContext.userPromptClosed',params:{context:'tab'}});
  await session.openRun(id(), id(), 'https://example.com/');
  assert.deepEqual(calls, ['script.callFunction']);
});
test('a focus change blocks key dispatch before any text can leak', async () => {
  const session = new BidiSession(); const runId = id(); const sent = [];
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'input'}});
  session.call = async (_match, fn) => ({result:{value:fn.includes('activeElement === el') ? false : true}});
  session.send = async method => { sent.push(method); return {}; };
  await assert.rejects(session.perform(runId, 'type', {text:'secret'}), /Focus changed/);
  assert.equal(sent.includes('input.performActions'), false);
});
test('Stop after one character never queues the remaining text', async () => {
  const session = new BidiSession(); const runId = id(); const dispatched = [];
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'input'}});
  session.call = async () => ({result:{value:true}});
  session.send = async (method, params) => {
    if (method === 'input.performActions') { dispatched.push(params); await session.closeRun(runId); }
    return {};
  };
  await assert.rejects(session.perform(runId, 'type', {text:'hello'}), /stopped/);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].actions[0].actions.length, 2);
});
test('literal newline insertion never dispatches an Enter key', async () => {
  const session = new BidiSession(); const runId = id(); const dispatched = []; const scripts = [];
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'input'}});
  session.call = async (_match, fn) => { scripts.push(fn); return {result:{value:true}}; };
  session.send = async (method, params) => { if(method==='input.performActions') dispatched.push(params); return {}; };
  await session.perform(runId, 'type', {text:'a\nb'});
  assert.ok(scripts.some(fn=>fn.includes("execCommand('insertText'")));
  assert.deepEqual(dispatched.flatMap(p=>p.actions[0].actions.map(a=>a.value)), ['a','a','b','b']);
});

test('validation failures preserve no-dispatch status across the native client', async () => {
  const session = new BidiSession(); const runId = id();
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => { throw new Error('stale target'); };
  let receive;
  const client = new FirefoxBidiClient({
    runtime: { connectNative: () => ({
      onMessage: {addListener: listener => {receive=listener;}}, onDisconnect: {addListener(){}},
      postMessage: message => {
        session.perform(message.runId, message.action, message.payload).then(
          result => receive({id:message.id,result}),
          error => receive({id:message.id,error:error.message,dispatchState:error.dispatchState}),
        );
      },
    }) },
    tabs: {sendMessage: async () => ({bidiPrepared:true,url:'https://example.com/'})},
  });
  client.runs.set(1,{runId,bound:true});
  const result = await client.sendContent(1,{action:'click',params:{}});
  assert.equal(result.dispatched,false);
  assert.equal(result.noDispatch,true);
  assert.equal(result.outcomeUnknown,false);
  assert.equal(result.retryable,true);
});
test('click_ax preparation carries checkable state into trusted input', async () => {
  const client = new FirefoxBidiClient({
    tabs: { sendMessage: async () => ({
      bidiPrepared: true,
      url: 'https://example.com/',
      checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'choice' },
    }) },
  });
  client.runs.set(1, { runId: id(), bound: true });
  let payload;
  client.perform = async (_tabId, _action, received) => { payload = received; return { success: true, verified: true }; };
  const result = await client.sendContent(1, { action: 'click_ax', params: { ref_id: 'ax-1' } });
  assert.equal(result.success, true);
  assert.deepEqual(payload.checkable, { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'choice' });
});
test('trusted checkable clicks report a prevented state transition', async () => {
  const session = new BidiSession(); const runId = id(); const sent = [];
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'check' } });
  session.call = async (_match, fn) => ({ result: { value: fn.includes('checkbox" || el.type')
    ? { checkedAfter: false, elapsedMs: 80 }
    : true } });
  session.send = async (method, params) => { sent.push({ method, params }); return {}; };
  const result = await session.perform(runId, 'click', {
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'check' },
  });
  assert.equal(sent.some(item => item.method === 'input.performActions'), true);
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(result.noProgress, true);
  assert.equal(result.checkedAfter, false);
  assert.equal(result.checkedChanged, false);
});
test('trusted checkable clicks wait on state events and report observation time', async () => {
  const session = new BidiSession(); const runId = id(); const scripts = [];
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'check' } });
  session.call = async (_match, fn) => {
    scripts.push(fn);
    return scripts.length === 1
      ? { result: { value: true } }
      : { result: { value: { checkedAfter: true, elapsedMs: 12 } } };
  };
  session.send = async () => ({});
  const result = await session.perform(runId, 'click', {
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'check' },
  });
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(result.checkedAfter, true);
  assert.equal(result._checkableObservationMs, 12);
  assert.match(scripts[1], /addEventListener\(['"]change['"], check\)/);
  assert.match(scripts[1], /setTimeout\(/, 'a bounded timeout must remain as the no-event fallback');
});
test('trusted target validation descends through open shadow roots', async () => {
  const session = new BidiSession(); const runId = id(); let validation;
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'shadow-button' } });
  session.call = async (_match, fn) => { validation = fn; return { result: { value: true } }; };
  session.send = async () => ({});
  await session.perform(runId, 'click', {});
  assert.match(validation, /shadowRoot\.elementFromPoint/);
  assert.match(validation, /node\.parentNode \|\| node\.host/);
});
test('keyboard validation does not require pointer geometry', async () => {
  const session = new BidiSession(); const runId = id(); const calls = [];
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'body' } });
  session.call = async (_match, fn) => { calls.push(fn); return { result: { value: true } }; };
  session.send = async () => ({});
  await session.perform(runId, 'key', { key: 'Escape' });
  assert.match(calls[0], /action === 'click' \|\| action === 'hover'/);
});
test('post-dispatch failure and transport uncertainty are never safe retries', async () => {
  const session = new BidiSession(); const runId = id();
  session.runs.set(runId, {context:'tab'});
  session.locate = async () => ({context:'tab',node:{sharedId:'el'}});
  session.call = async () => ({result:{value:true}});
  session.send = async method => { if(method==='input.performActions')throw new Error('connection lost'); return {}; };
  await assert.rejects(session.perform(runId,'click',{}), error => error.dispatchState.dispatched === true && error.dispatchState.retryable === false);
  const client = new FirefoxBidiClient({tabs:{sendMessage:async()=>({bidiPrepared:true,url:'https://example.com/'})}});
  client.runs.set(1,{runId,bound:true}); client.request=async()=>{throw new Error('timeout')};
  const result=await client.sendContent(1,{action:'click',params:{}});
  assert.equal(result.dispatched,true);
  assert.equal(result.outcomeUnknown,true);
  assert.equal(result.retryable,false);
});
test('coordinate clicks retain their validated viewport point', async () => {
  const session = new BidiSession(); const runId = id(); const sent=[];
  session.runs.set(runId,{context:'tab'});
  session.locate=async()=>({context:'tab',node:{sharedId:'canvas'}});
  session.call=async(_match,fn,args)=>{assert.equal(args[2].value,17);assert.equal(args[3].value,23);return {result:{value:true}}};
  session.send=async(method,params)=>{if(method==='input.performActions')sent.push(params);return {}};
  await session.perform(runId,'click',{point:{x:17,y:23}});
  assert.deepEqual(sent[0].actions[0].actions[0],{type:'pointerMove',origin:'viewport',x:17,y:23});
});
test('every release workflow running npm test uses the companion runtime', async () => {
  const {readFile}=await import('node:fs/promises');
  for(const workflow of ['main','minor-release']) {
    const source=await readFile(`.github/workflows/${workflow}.yml`,'utf8');
    assert.match(source,/node-version: 22/);
    assert.match(source,/run: npm test/);
  }
});
