import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// Use real, locally installed React and DraftJS, with no network/CDN fixture.
// An editor-shaped DOM that replaces its children on input cannot reproduce
// React's reconciliation against DraftJS's original text/caret nodes.
const require = createRequire(import.meta.url);
const library = (name, file) => readFile(path.join(path.dirname(require.resolve(`${name}/package.json`)), file), 'utf8');
const scripts = await Promise.all([
  library('react', 'umd/react.development.js'),
  library('react-dom', 'umd/react-dom.development.js'),
  library('immutable', 'dist/immutable.js'),
  library('draft-js', 'dist/Draft.js'),
]);
const css = await library('draft-js', 'dist/Draft.css');
const selector = '#fixture [contenteditable="true"]';
const cases = [
  { name: 'empty replacement', previous: '', text: 'One owned draft.', clear: true },
  { name: 'nonempty replacement', previous: 'Existing draft', text: 'New draft', clear: true },
  { name: 'append', previous: 'Existing draft', text: ' appended once', clear: false },
  { name: 'multiline replacement', previous: 'Old\n\nparagraph', text: 'First\n\nSecond\nThird', clear: true },
  { name: 'multiline append', previous: 'Existing draft', text: '\n\nSecond paragraph', clear: false },
  { name: 'leading and trailing line breaks', previous: '', text: '\nFirst\n\n', clear: true },
  { name: 'only blank lines', previous: '', text: '\n\n', clear: true },
  { name: 'CRLF canonical document breaks', previous: 'Original', text: 'First\r\n\r\nSecond\r\n', clear: true },
  { name: 'empty clear', previous: 'Old\n\nparagraph', text: '', clear: true },
  { name: 'already empty clear', previous: '', text: '', clear: true },
  { name: 'literal markup and unicode', previous: '', text: '<script>window.literalExecuted=true</script> & <b>literal</b> Türkçe ıİşŞğĞüÜöÖçÇ 中文 العربية 🧠 🧑🏽‍💻 e\u0301', clear: true },
  { name: 'exact whitespace', previous: 'Replace these words', text: '  spaces   and\ttab\u00a0nonbreaking  ', clear: true },
];

async function fixture(browser, build, { mode = 'concurrent', childFrame = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const saves = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://owned-editor.invalid/**', async route => {
    if (route.request().method() === 'POST') {
      saves.push(route.request().postDataJSON());
      await route.fulfill({ contentType: 'application/json', body: '{"saved":true}' });
    } else {
      const outer = childFrame && new URL(route.request().url()).pathname === '/editor';
      await route.fulfill({ contentType: 'text/html', body: outer
        ? '<!doctype html><h1>Owned application</h1><iframe title="Owned draft frame" src="/child" style="width:800px;height:400px;border:0"></iframe>'
        : '<!doctype html><h1>Owned DraftJS application</h1><main id="fixture"></main>' });
    }
  });
  await page.goto('https://owned-editor.invalid/editor');
  const document = childFrame ? await page.locator('iframe').elementHandle().then(handle => handle.contentFrame()) : page;
  await document.waitForSelector('#fixture', { state: 'attached' });
  await document.addStyleTag({ content: `${css}\n#fixture { width: 650px; } .DraftEditor-root { border: 1px solid; min-height: 120px; } .public-DraftEditor-content { min-height: 120px; }` });
  for (const content of scripts) await document.addScriptTag({ content });
  await document.evaluate(({ build, mode }) => {
    const api = { runtime: { getURL: value => value, onMessage: { addListener: handler => { window.qaHandler = handler; } } } };
    window[build === 'firefox' ? 'browser' : 'chrome'] = api;
    window.qaCall = (action, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Content handler did not answer ${action}`)), 5000);
      qaHandler({ target: 'content', action, params }, {}, result => { clearTimeout(timer); resolve(result); });
    });
    window.qaEvents = []; window.qaCommands = []; window.qaCorruptPaste = false;
    const host = document.querySelector('#fixture');
    const root = mode === 'concurrent' ? ReactDOM.createRoot(host) : null;
    let revision = 0;
    const App = ({ value }) => {
      const [editorState, setEditorState] = React.useState(() => Draft.EditorState.createWithContent(Draft.ContentState.createFromText(value)));
      window.qaEditorState = editorState;
      window.qaReplaceEditorText = text => setEditorState(Draft.EditorState.createWithContent(Draft.ContentState.createFromText(text)));
      const onChange = next => {
        if (qaCorruptPaste && next.getCurrentContent().getPlainText('\n').includes('\n')) {
          qaCorruptPaste = false;
          next = Draft.EditorState.createWithContent(Draft.ContentState.createFromText(next.getCurrentContent().getPlainText('\n') + '!'));
        }
        window.qaEditorState = next; setEditorState(next);
      };
      return React.createElement(React.Fragment, null,
        React.createElement(Draft.Editor, { editorState, onChange, ariaLabel: 'Owned editor', placeholder: 'Enter owned draft' }),
        React.createElement('button', { id: 'save', onClick: async () => {
          const value = editorState.getCurrentContent().getPlainText('\n');
          await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
          window.qaSavedValue = value;
        } }, 'Save owned draft'));
    };
    window.qaMount = value => {
      const app = React.createElement(App, { key: ++revision, value });
      if (root) ReactDOM.flushSync(() => root.render(app));
      else ReactDOM.render(app, host);
      qaEvents = []; qaCommands = []; qaCorruptPaste = false; window.qaSavedValue = undefined;
    };
    window.qaSnapshot = () => {
      const editor = document.querySelector('#fixture [contenteditable="true"]');
      return { model: qaEditorState.getCurrentContent().getPlainText('\n'), text: editor?.textContent,
        html: editor?.innerHTML, blocks: editor ? [...editor.querySelectorAll('[data-block="true"]')].map(block => block.textContent) : [],
        modelBlocks: qaEditorState.getCurrentContent().getBlocksAsArray().map(block => block.getText()),
        events: qaEvents, commands: qaCommands,
        interpretedMarkup: !!editor?.querySelector('script,b'), executed: !!window.literalExecuted };
    };
    for (const type of ['beforeinput', 'input', 'paste']) host.addEventListener(type, event => {
      qaEvents.push({ type, trusted: event.isTrusted, inputType: event.inputType,
        data: type === 'paste' ? event.clipboardData?.getData('text/plain') : event.data });
    }, true);
    const execCommand = document.execCommand.bind(document);
    document.execCommand = (command, showUI, value) => { qaCommands.push({ command, value }); return execCommand(command, showUI, value); };
    qaMount('');
  }, { build, mode });
  for (const file of ['accessibility-tree.js', 'rich-text-toolbar-heuristic.js', 'content.js']) {
    await document.addScriptTag({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
  }
  return { page, document, saves, errors, frameId: childFrame ? 7 : 0 };
}

async function reference(document) {
  const tree = await document.evaluate(() => qaCall('get_accessibility_tree', { filter: 'all', maxDepth: 15, maxChars: 20000 }));
  const ref = String(tree.pageContent).match(/textbox "Owned editor" \[(ref_\d+)\]/)?.[1];
  assert.ok(ref, JSON.stringify(tree));
  return ref;
}

async function contentWrite(document, action, args) {
  return document.evaluate(({ action, args, selector }) => qaCall(action,
    action === 'type' ? { selector, text: args.text, clear: args.clear } : args), { action, args, selector });
}

async function assertApplication(f, expected) {
  const state = await f.document.evaluate(() => qaSnapshot());
  assert.equal(state.model, expected, 'Compare DraftJS EditorState, independent of the extension readback.');
  assert.deepEqual(state.blocks, state.modelBlocks, 'React-rendered document blocks must match the actual model.');
  assert.equal(state.blocks.join('\n'), expected);
  assert.equal(state.text, state.modelBlocks.join(''), 'The DOM must contain no additional unmarked text outside the model blocks.');
  assert.equal(state.interpretedMarkup, false); assert.equal(state.executed, false);
  assert.deepEqual(f.errors, [], 'Native editing must not corrupt React reconciliation or DraftJS offset keys.');
  const count = f.saves.length;
  await f.document.locator('#save').click();
  await f.document.waitForFunction(expected => qaSavedValue === expected, expected);
  assert.equal(f.saves.length, count + 1);
  assert.equal(f.saves.at(-1).value, expected, 'Compare the application save POST, independent of DOM normalization.');
  return state;
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: actual React/DraftJS uses page-owned multiline edits and rejects unsafe DOM commands`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const f = await fixture(browser, build);
      for (const action of ['type', 'type_ax', 'set_field']) for (const item of cases) await t.test(`${action}: ${item.name}`, async () => {
        await f.document.evaluate(previous => qaMount(previous), item.previous);
        const before = await f.document.evaluate(() => qaSnapshot());
        const ref_id = await reference(f.document);
        const result = await contentWrite(f.document, action, { ref_id, text: item.text, clear: item.clear });
        const multiline = /[\r\n]/.test(item.text);
        if (multiline) {
          assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.verified, true);
          assert.equal(result.pageHandledPaste, true);
        } else {
          assert.equal(result.success, false, JSON.stringify(result));
          assert.equal(result.dispatched, false); assert.equal(result.noDispatch, true);
          assert.notEqual(result.outcomeUnknown, true);
        }
        const expected = multiline ? (item.clear ? '' : item.previous) + item.text.replace(/\r\n?/g, '\n') : item.previous;
        const state = await assertApplication(f, expected);
        if (multiline) {
          assert.equal(state.events.length, 1); assert.equal(state.events[0].type, 'paste');
          assert.equal(state.events[0].data, item.text.replace(/\r\n?/g, '\n'));
        } else {
          assert.equal(state.html, before.html, 'The original DraftJS document nodes survive the failed content write.');
          assert.deepEqual(state.events, [], 'No synthetic beforeinput or native input is sent ahead of trusted typing.');
        }
        assert.deepEqual(state.commands, [], 'No HTML wrapper or plain execCommand mutation enters framework-owned DOM.');
      });
      await t.test('a page-modified paste is uncertain and sends no second mutation', async () => {
        await f.document.evaluate(() => { qaMount(''); qaCorruptPaste = true; });
        const args = { ref_id: await reference(f.document), text: 'First\nSecond', clear: true };
        const result = await contentWrite(f.document, 'type_ax', args);
        assert.equal(result.success, false); assert.equal(result.dispatched, true);
        assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false);
        assert.equal(result.recoveryRequired, 'verify_or_restore_field');
        const state = await assertApplication(f, args.text + '!');
        assert.equal(state.events.filter(event => event.type === 'paste').length, 1);
        assert.deepEqual(state.commands, []);
      });
      await t.test('an ignored paste stays uncertain and never falls through to DOM commands', async () => {
        await f.document.evaluate(() => {
          qaMount('Unchanged draft');
          document.querySelector('#fixture').addEventListener('paste', event => event.stopImmediatePropagation(), { capture: true, once: true });
        });
        const args = { ref_id: await reference(f.document), text: 'First\nSecond', clear: true };
        const result = await contentWrite(f.document, 'set_field', args);
        assert.equal(result.success, false); assert.equal(result.dispatched, true);
        assert.notEqual(result.noDispatch, true); assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false);
        const state = await assertApplication(f, 'Unchanged draft');
        assert.equal(state.events.filter(event => event.type === 'paste').length, 1);
        assert.deepEqual(state.commands, []);
      });
    } finally { await browser.close(); }
  });
}

test('Chrome: real trusted input updates DraftJS once through production selector, AX and frame routes', async t => {
  const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const api = { storage: { local: area, session: area }, runtime: { getURL: value => value }, tabs: {} };
  globalThis.chrome = globalThis.browser = api;
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
  const originalAttach = cdpClient.attach, originalCommand = cdpClient.sendCommand;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const options of [{ mode: 'concurrent' }, { mode: 'legacy' }, { mode: 'concurrent', childFrame: true }]) {
      const f = await fixture(browser, 'chrome', options);
      const session = await f.page.context().newCDPSession(f.page);
      const agent = new Agent({});
      const commands = [], messages = [];
      let loseResponse = false;
      api.tabs.get = async id => ({ id, url: f.page.url() });
      api.tabs.sendMessage = (_tab, message, target = {}) => {
        messages.push({ action: message.action, frameId: target.frameId || 0 });
        assert.equal(target.frameId || 0, f.frameId, 'Content preparation/readback remains bound to the original document frame.');
        return f.document.evaluate(message => qaCall(message.action, message.params), message);
      };
      cdpClient.attach = async () => {};
      cdpClient.sendCommand = async (_tab, method, params) => {
        commands.push({ method, params });
        const result = await session.send(method, params);
        if (loseResponse && method === 'Input.insertText') { loseResponse = false; throw new Error('Owned input response lost after dispatch'); }
        return result;
      };
      const actions = f.frameId ? ['type_ax', 'set_field'] : ['type_text', 'type_ax', 'set_field'];
      for (const action of actions) for (const item of cases) await t.test(`${options.mode}/${f.frameId ? 'iframe' : 'main'}/${action}: ${item.name}`, async () => {
        await f.document.evaluate(previous => qaMount(previous), item.previous);
        commands.length = 0; messages.length = 0;
        const ref_id = await reference(f.document);
        const args = { ref_id, text: item.text, clear: item.clear };
        let result;
        if (action === 'type_text') result = await cdpClient.typeText(41, selector, item.text, item.clear);
        else {
          const initial = await contentWrite(f.document, action, args);
          if (!/[\r\n]/.test(item.text)) {
            assert.equal(initial.noDispatch, true, JSON.stringify(initial));
            assert.equal(await f.document.evaluate(() => qaEditorState.getCurrentContent().getPlainText('\n')), item.previous);
          }
          result = await agent._maybeFallbackFieldWithCdpImpl(41, action, args, initial, {}, null, f.frameId);
        }
        assert.equal(result.success, true, JSON.stringify({ result, state: await f.document.evaluate(() => qaSnapshot()) })); assert.equal(result.verified, true);
        const expected = (item.clear ? '' : item.previous) + item.text.replace(/\r\n?/g, '\n');
        const state = await assertApplication(f, expected);
        assert.deepEqual(state.commands, []);
        assert.ok(state.events.every(event => event.trusted || event.type === 'paste'), 'Only the explicit page-owned paste event may be synthetic.');
        assert.ok(commands.filter(command => command.method === 'Input.insertText').length <= 1, 'Insert the requested text only once.');
        if (/[\r\n]/.test(item.text)) {
          assert.equal(result.pageHandledPaste, true);
          assert.equal(state.events.filter(event => event.type === 'paste').length, 1);
          assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 0, 'Never follow page-handled paste with native multiline insertion.');
        } else if (item.text) {
          const insertions = commands.filter(command => command.method === 'Input.insertText');
          assert.equal(insertions.length, 1); assert.equal(insertions[0].params.text, item.text);
        }
        if (f.frameId) assert.equal(commands.some(command => command.method === 'Input.dispatchMouseEvent'), false,
          'Frame-local rectangles must not become a top-document coordinate click.');
      });
      await t.test(`${options.mode}/${f.frameId ? 'iframe' : 'main'}: unknown dispatch never inserts a second copy`, async () => {
        await f.document.evaluate(() => qaMount(''));
        commands.length = 0;
        const args = { ref_id: await reference(f.document), text: 'Exactly one owned draft.', clear: true };
        const initial = await contentWrite(f.document, 'set_field', args);
        loseResponse = true;
        const unknown = await agent._maybeFallbackFieldWithCdpImpl(41, 'set_field', args, initial, {}, null, f.frameId);
        assert.equal(unknown.success, false); assert.equal(unknown.dispatched, true); assert.equal(unknown.noDispatch, false);
        assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 1);
        await assertApplication(f, args.text);
        const retry = await agent._maybeFallbackFieldWithCdpImpl(41, 'set_field', args,
          { ...unknown, _expectedValue: args.text }, {}, null, f.frameId);
        // By default trusted-field-retry-guards advises: no repeat lock label,
        // but WebBrain still never retypes on its own (one insertion below).
        assert.equal(retry.success, false); assert.equal(retry.outcomeUnknown, true); assert.equal(retry.repeatBlocked, undefined);
        assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 1);
        await assertApplication(f, args.text);
      });
      await t.test(`${options.mode}/${f.frameId ? 'iframe' : 'main'}: a trusted multiline request uses one page-owned paste`, async () => {
        await f.document.evaluate(() => qaMount('Existing draft'));
        commands.length = 0;
        const args = { ref_id: await reference(f.document), text: '\n\nAppend once\n', clear: false };
        // Older content generations can still ask the background for trusted
        // typing. Exercise that production fallback with the actual current
        // preparation and paste handlers, not a synthetic document renderer.
        const initial = { success: false, verified: false, noDispatch: true, dispatched: false,
          _expectedValue: 'Existing draft' + args.text, trustedTypeRequired: true, error: 'Trusted editor input required' };
        const result = await agent._maybeFallbackFieldWithCdpImpl(41, 'type_ax', args, initial, {}, null, f.frameId);
        assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.verified, true);
        assert.equal(result.pageHandledPaste, true);
        const state = await assertApplication(f, 'Existing draft' + args.text);
        assert.equal(state.events.filter(event => event.type === 'paste').length, 1);
        assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 0);
      });
      if (!f.frameId) await t.test(`${options.mode}: a focus handler cannot become a new multiline append baseline`, async () => {
        await f.document.evaluate(() => {
          qaMount('Original baseline');
          document.querySelector('#fixture [contenteditable="true"]').addEventListener('focus', () => {
            ReactDOM.flushSync(() => qaReplaceEditorText('Changed by application focus'));
          }, { once: true });
        });
        commands.length = 0;
        const result = await cdpClient.typeText(41, selector, '\nNever append', false);
        assert.equal(result.success, false, JSON.stringify(result)); assert.equal(result.dispatched, true);
        assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false);
        const state = await assertApplication(f, 'Changed by application focus');
        assert.equal(state.events.filter(event => event.type === 'paste').length, 0);
        assert.equal(commands.some(command => command.method === 'Input.insertText'), false);
      });
      await session.detach(); await f.page.close();
    }
  } finally {
    cdpClient.attach = originalAttach; cdpClient.sendCommand = originalCommand;
    globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
    await browser.close();
  }
});

test('Chrome: certified production monitor owns actual DraftJS paste and rejects a stale page action', async t => {
  const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
  const { installPageFeedback, hasPageAgentDispatchOwner } = await import('../src/chrome/src/agent/page-feedback.js');
  const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const originalAttach = cdpClient.attach, originalCommand = cdpClient.sendCommand;
  const browser = await chromium.launch({ headless: true });
  const tabId = 73;
  let f, session, host, entryRoute;
  const priorSession = cdpClient.sessions.get(tabId);
  const compatibilityAgent = new Agent({});
  class Host {
    static STATE_CHANGE_TOOLS = new Set(['type_text', 'type_ax']);
    isRunning() { return true; }
    _checkAbort() { return false; }
    _throwIfAborted() {}
    _persist() {}
    _effectiveRunMode() { return 'act'; }
    _appOwnedUserMessage(content, webbrainAppOwnedKind) { return { role: 'user', content, webbrainAppOwnedKind }; }
    _wrapUntrusted(_kind, content) { return content; }
    _finalizeToolResultOnce(_tab, _name, _args, result) { return result; }
    async executeTool(_tab, name, args, _onUpdate, context) {
      if (name === 'type_text') {
        await cdpClient.attach(tabId);
        return cdpClient.typeText(tabId, args.selector, args.text, args.clear, null, {
          beforeDispatch: () => { context._contentActionDispatchState.started = true; },
        });
      }
      if (entryRoute === 'trusted AX request') return compatibilityAgent._maybeFallbackFieldWithCdpImpl(tabId, name, args,
        { success: false, verified: false, noDispatch: true, dispatched: false, trustedTypeRequired: true,
          _expectedValue: (args.clear ? '' : 'Existing\nlast') + args.text }, context);
      return contentWrite(f.document, name, args);
    }
  }
  installPageFeedback(Host);
  const commands = [], messages = [], feedback = [];
  const api = { runtime: {}, tabs: {
    get: async () => ({ id: tabId, url: f.page.url() }),
    sendMessage: (_tab, message, target = {}) => {
      assert.equal(target.frameId || 0, 0);
      messages.push(message);
      return f.document.evaluate(message => qaCall(message.action, message.params || {}, message), message);
    },
  }, webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'owned-certified-draft', url: f.page.url() }] },
  debugger: { sendCommand: (_target, method, params, callback) => {
    commands.push({ method, params });
    session.send(method, params).then(callback, error => {
      api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError;
    });
  } } };
  globalThis.chrome = globalThis.browser = api;
  try {
    for (const route of ['content', 'CDP selector', 'trusted AX request']) for (const clear of [true, false]) await t.test(`${route}: ${clear ? 'replace' : 'append'}`, async () => {
      f = await fixture(browser, 'chrome');
      entryRoute = route;
      session = await f.page.context().newCDPSession(f.page);
      host = new Host();
      commands.length = 0; messages.length = 0; feedback.length = 0;
      cdpClient.attach = async () => cdpClient.sessions.set(tabId, {});
      cdpClient.sendCommand = originalCommand;
      await f.document.evaluate(() => {
        qaMount('Existing\nlast');
        const editor = document.querySelector('#fixture [contenteditable="true"]');
        // Existing action bindings include geometry. Keep it fixed so this
        // regression exercises dispatch ownership independently of layout.
        editor.style.height = '180px';
        const listeners = [window.qaHandler];
        chrome.runtime.onMessage = { addListener: listener => listeners.push(listener), removeListener: listener => {
          const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1);
        } };
        chrome.runtime.sendMessage = message => window.qaOwnedBackground(message);
        window.qaCall = (action, params = {}, original = {}) => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Missing certified monitor response ${action}`)), 5000);
          let answered = false;
          const respond = result => { answered = true; clearTimeout(timeout); resolve(result); };
          for (const listener of listeners) {
            const asynchronous = listener({ ...original, target: 'content', action, params }, {}, respond);
            if (answered || asynchronous === true) return;
          }
          clearTimeout(timeout); resolve(undefined);
        });
      });
      await f.page.exposeFunction('qaOwnedBackground', message => {
        const sender = { tab: { id: tabId }, frameId: 0, documentId: 'owned-certified-draft', url: f.page.url() };
        if (message.action === 'get_page_monitor_state') return host.pageMonitorState(sender, message.documentToken);
        if (message.action === 'page_feedback') { feedback.push(message.feedback); return host.observePageFeedback(sender, message.feedback); }
        return {};
      });
      await f.document.addScriptTag({ content: await readFile(new URL('../src/chrome/src/content/page-monitor.js', import.meta.url), 'utf8') });
      await host._beginPageFeedbackRun(tabId, 'certified-draft');
      await f.document.waitForFunction(() => __wbPageMonitor.active);
      await f.page.waitForTimeout(180);
      const run = host._pageFeedbackRuns.get(tabId);
      run.events.clear();
      await host._capturePageFeedbackModelState(tabId, []);
      assert.ok(run.modelState.actionBinding?.snapshotToken, 'Capture the production pre-action document certificate.');
      assert.equal(hasPageAgentDispatchOwner(tabId), true);
      const ref_id = await reference(f.document);
      const name = route === 'CDP selector' ? 'type_text' : 'type_ax';
      const args = { ...(route === 'CDP selector' ? { selector } : { ref_id }), text: 'First\n\nLast\n', clear };
      feedback.length = 0; commands.length = 0; messages.length = 0;
      const result = await host.executeTool(tabId, name, args);
      const expected = (clear ? '' : 'Existing\nlast') + args.text;
      await f.page.waitForTimeout(180);
      const state = await f.document.evaluate(() => qaSnapshot());
      assert.equal(result.success, true, JSON.stringify({ result, state, feedback }));
      assert.equal(result.verified, true); assert.equal(result.pageHandledPaste, true);
      assert.equal(state.model, expected); assert.deepEqual(state.blocks, state.modelBlocks);
      assert.equal(state.text, state.modelBlocks.join('')); assert.deepEqual(state.commands, []);
      assert.equal(state.events.filter(event => event.type === 'paste').length, 1);
      assert.equal(feedback.some(item => item.source !== 'agent'), false, JSON.stringify(feedback));
      assert.equal(run.events.size, 0, 'Target-only paste leaves no intervention or unrelated page feedback pending.');
      assert.equal(commands.some(command => command.method === 'Input.insertText'), false);
      if (route === 'CDP selector') {
        assert.ok(commands.some(command => command.method === 'Runtime.callFunctionOn'
          && command.params.functionDeclaration.includes('beforePageAgentDomAction(pageGuard, phase, el)')),
        'Run the packaged DOM-action source against the real active owner, rather than a mocked guard.');
        assert.ok(messages.some(message => message.action === 'page_monitor_dispatch' && message.params?.fenceOnly === true));
      }
      if (route === 'trusted AX request') assert.equal(messages.filter(message => message.action === 'ax_paste_draft').length, 1,
        'Exercise the production internal compatibility handler with its actual monitor action classification.');
      // Certify the updated document before the independent external change.
      // The following rejection must be caused by stale page identity, rather
      // than by reusing the pre-paste editor value or a user save-button click.
      await host._capturePageFeedbackModelState(tabId, []);
      await f.document.evaluate(() => {
        document.querySelector('#fixture [contenteditable="true"]').setAttribute('aria-label', 'Unobserved editor identity');
      });
      await f.page.waitForTimeout(180);
      const blocked = await host.executeTool(tabId, name, { ...args, text: '\nBlocked copy', clear: false });
      assert.equal(blocked.success, false, JSON.stringify(blocked)); assert.equal(blocked.noDispatch, true);
      assert.equal(blocked.dispatched, false);
      assert.equal(await f.document.evaluate(() => qaEditorState.getCurrentContent().getPlainText('\n')), expected);
      assert.equal(await f.document.evaluate(() => qaEvents.filter(event => event.type === 'paste').length), 1);
      assert.ok(feedback.some(item => item.source !== 'agent'), 'An independent page identity change must remain externally attributed.');
      host._finishPageFeedbackRun(tabId);
      await f.document.evaluate(() => __wbPageMonitor.dispose());
      await assertApplication(f, expected);
      await session.detach(); await f.page.close();
    });
  } finally {
    host?._finishPageFeedbackRun(tabId);
    cdpClient.attach = originalAttach; cdpClient.sendCommand = originalCommand;
    if (priorSession) cdpClient.sessions.set(tabId, priorSession); else cdpClient.sessions.delete(tabId);
    globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
    await browser.close();
  }
});
