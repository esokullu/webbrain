import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { CDPClient } from '../src/chrome/src/cdp/cdp-client.js';
import { pageFeedbackMethods } from '../src/chrome/src/agent/page-feedback.js';
import { BidiSession } from '../firefox-companion/session.mjs';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/src/${file}`, import.meta.url), 'utf8');
const html = `<!doctype html><style>
body { margin: 0; } button,input { margin: 12px; }
#container { overflow: auto; height: 100px; width: 300px; }
#moving { animation: slide 100ms linear infinite alternate; } @keyframes slide { to { transform: translateX(8px); } }
</style><button id="agent">Agent button</button><button id="human">Human button</button>
<input id="field"><input id="secret" type="password"><select id="select"><option>A</option><option>B</option></select>
<p id="status">Ready</p><div id="container"><div style="height:1000px">Scrollable</div></div>
<div id="moving">Animated</div><div style="height:3000px"></div>
<script>document.getElementById('agent').addEventListener('click', () => { document.getElementById('status').textContent = 'Agent changed this'; });</script>`;

async function fixture(engine, build, { runToken = 'test-run', siteIsolation = false, omitEmptyFrameMonitor = false } = {}) {
  const browser = await engine.launch({ headless: true, ...(siteIsolation ? { args: ['--site-per-process'] } : {}) });
  const context = await browser.newContext();
  await context.route('https://monitor.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(token => { window.monitorRunToken = token; }, runToken);
  await context.addInitScript(() => {
    window.monitorEnabled = true;
    window.feedback = [];
    window.messageListeners = [];
    const runtime = { onMessage: {
      addListener: fn => messageListeners.push(fn),
      removeListener: fn => { messageListeners = messageListeners.filter(item => item !== fn); },
    }, async sendMessage(msg) {
      if (msg.action === 'get_page_monitor_state') return { active: monitorEnabled, runToken: monitorRunToken, documentToken: msg.documentToken };
      if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return { accepted: true }; }
      return {};
    } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => messageListeners.forEach(fn => fn({ target: 'content', action,
      params: { runToken: monitorRunToken, ...params }, active: action === 'page_monitor_state' ? monitorEnabled : undefined,
      runToken: monitorRunToken }, {}, value => { window.lastMonitorResponse = value; }));
  });
  const initialScript = file => omitEmptyFrameMonitor
    ? `if (window === window.top) { ${read(build, file)} }` : read(build, file);
  await context.addInitScript({ content: initialScript('content/page-monitor-shadow.js') });
  await context.addInitScript({ content: initialScript('content/page-monitor.js') });
  const page = await context.newPage();
  await page.goto('https://monitor.test/start');
  await page.waitForTimeout(200);
  await page.evaluate(() => { feedback = []; });
  return { browser, context, page };
}

async function installScrollHelper(page, build) {
  const source = read(build, 'content/content.js');
  const helper = source.match(/^  function _scrollElementIntoClearView\([\s\S]*?^  }/m)?.[0];
  assert.ok(helper);
  await page.addScriptTag({ content: `window._scrollElementIntoClearView = ${helper};` });
  await page.evaluate(() => Object.assign(window, {
    _isAlreadyVisibleInFixedSurface: () => false, _getViewportDockedInsets: () => ({ top: 0, bottom: 0 }),
    _isFullyVisibleForInteraction: () => false, _isCoveredByFixedNonModalSurface: () => false,
    showAgentWorkingTarget: () => {}, _fieldMeta: () => ({}),
    _axFallbackStaticAssessment: () => ({ tag: 'button', role: 'button', name: 'Target' }),
  }));
}

test('Chrome AX preparation attributes actual scrolling without claiming field input', async () => {
  const { browser, page } = await fixture(chromium, 'chrome');
  try {
    await installScrollHelper(page, 'chrome');
    const source = read('chrome', 'content/content.js');
    const entries = ['ax_resolve_rect', 'ax_resolve_two_rects', 'ax_prepare_field_for_trusted_type'].map(action => {
      const start = source.indexOf(`'${action}': () => {`), end = source.indexOf('\n      },', start);
      assert.ok(start > 0 && end > start); return source.slice(start, end + 8);
    });
    await page.addScriptTag({ content: `window.axHelpers = { ${entries.join(',\n')} };` });
    await page.evaluate(() => {
      for (let i = 1; i <= 3; i++) {
        const box = document.createElement('div'); box.id = `scroll-box-${i}`;
        box.style.cssText = 'overflow:auto;height:100px;width:300px';
        box.innerHTML = `<${i === 3 ? 'input' : 'button'} id="ref_${i}" style="margin-top:900px">Target</${i === 3 ? 'input' : 'button'}>`;
        document.body.append(box);
      }
      window.__wb_ax_lookup = ref => document.getElementById(ref);
    });
    await page.waitForTimeout(200);
    for (const [action, params] of [
      ['ax_resolve_rect', { ref_id: 'ref_1' }],
      ['ax_resolve_two_rects', { fromRefId: 'ref_1', toRefId: 'ref_2' }],
      ['ax_prepare_field_for_trusted_type', { ref_id: 'ref_3' }],
    ]) {
      await page.evaluate(() => {
        monitorEnabled = false; deliver('page_monitor_state'); window.scrollTo(0, 0);
        for (const el of document.querySelectorAll('[id^="scroll-box-"]')) el.scrollTop = 0;
      });
      await page.waitForTimeout(50);
      await page.evaluate(() => { monitorEnabled = true; deliver('page_monitor_state'); });
      await page.waitForTimeout(20);
      const result = await page.evaluate(({ action, params }) => {
        feedback = []; window.msg = { params };
        const finish = __wbPageMonitor.beginContentAction(action, params);
        try { return axHelpers[action](); } finally { finish(); }
      }, { action, params });
      assert.equal(result.success, true, JSON.stringify(result));
      await page.waitForTimeout(80);
      assert.deepEqual(await page.evaluate(() => feedback), [], `${action} must not block the native action after scroll settling`);
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('[id^="scroll-box-"]')].some(el => el.scrollTop > 0)));
      if (action === 'ax_resolve_two_rects') assert.ok(await page.evaluate(() => [1, 2].every(i => document.getElementById(`scroll-box-${i}`).scrollTop > 0)));
      if (action === 'ax_prepare_field_for_trusted_type') {
        await page.keyboard.press('x');
        await page.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'), null, { timeout: 1000 });
      }
    }
  } finally { await browser.close(); }
});

async function installContentEditableFallback(page, build) {
  const insertion = read(build, 'content/content.js').match(/^  async function _insertContentEditableText\([\s\S]*?^  }/m)?.[0];
  assert.ok(insertion, 'Exercise the real contenteditable fallback with the real monitor');
  await page.addScriptTag({ content: `window._fieldMeta = () => ({ contentEditable: true }); window.richTextInsertion = ${insertion};` });
  await page.evaluate(() => {
    const editor = document.createElement('div'); editor.id = 'rich-editor'; editor.contentEditable = 'true';
    document.body.prepend(editor);
    window.typeRichText = async ({ text, clear }) => {
      editor.focus();
      const finish = __wbPageMonitor.beginContentAction('type', { selector: '#rich-editor' });
      try { return await richTextInsertion(editor, text, clear); }
      catch (error) { return { success: false, code: error.code, dispatched: error.dispatched }; }
      finally { finish(); }
    };
  });
}

test('Firefox late registration covers blank/srcdoc frames and preserves an existing monitor', async () => {
  const { browser, page } = await fixture(firefox, 'firefox', { omitEmptyFrameMonitor: true });
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../src/firefox/manifest.json', import.meta.url), 'utf8'));
    const late = manifest.content_scripts.find(entry => entry.run_at !== 'document_start'
      && entry.js.includes('src/content/page-monitor.js') && entry.all_frames && entry.match_about_blank);
    const lateShadow = manifest.content_scripts.find(entry => entry.run_at !== 'document_start' && entry.world === 'MAIN'
      && entry.js.includes('src/content/page-monitor-shadow.js') && entry.all_frames && entry.match_about_blank);
    assert.ok(late && lateShadow, 'Empty Firefox frames need a later monitor and shadow-hook registration');
    const recovery = late.js.map(file => read('firefox', file.replace(/^src\//, ''))).join('\n');
    await page.evaluate(() => { window.earlyMonitor = __wbPageMonitor; window.earlyFence = document.documentElement.getAttribute('data-webbrain-page-revision'); });
    await page.addScriptTag({ content: recovery });
    assert.equal(await page.evaluate(() => __wbPageMonitor === earlyMonitor && document.documentElement.getAttribute('data-webbrain-page-revision') === earlyFence), true,
      'The supplemental pass must not replace a live monitor or its dispatch expectations');
    await page.evaluate(() => {
      const blank = document.createElement('iframe'); blank.id = 'blank-frame'; document.body.prepend(blank);
      const srcdoc = document.createElement('iframe'); srcdoc.id = 'srcdoc-frame';
      srcdoc.srcdoc = '<input id="inside"><p id="inside-status">Ready</p>'; document.body.prepend(srcdoc);
    });
    for (const [id, url] of [['blank-frame', 'about:blank'], ['srcdoc-frame', 'about:srcdoc']]) {
      const handle = await page.locator(`#${id}`).elementHandle(), frame = await handle.contentFrame();
      await frame.waitForFunction(url => location.href === url && window.chrome?.runtime && document.body, url);
      assert.equal(await frame.evaluate(() => !!window.__wbPageMonitor), false, 'Model the Firefox document_start omission');
      if (url === 'about:blank') await frame.evaluate(() => { document.body.innerHTML = '<input id="inside"><p id="inside-status">Ready</p>'; });
      await frame.addScriptTag({ content: read('firefox', 'content/page-monitor-shadow.js') });
      await frame.addScriptTag({ content: recovery });
      await frame.waitForFunction(() => __wbPageMonitor && document.documentElement.hasAttribute('data-webbrain-page-revision'));
      await frame.locator('#inside').fill('Private input');
      await frame.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'));
      assert.ok(!(JSON.stringify(await frame.evaluate(() => feedback))).includes('Private input'));
      await frame.evaluate(() => { document.getElementById('inside-status').textContent = 'Page changed'; });
      await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await frame.evaluate(() => {
        const host = document.createElement('div'); host.id = 'late-frame-host'; document.body.append(host);
      });
      await frame.waitForTimeout(200);
      await frame.evaluate(() => {
        feedback = []; document.getElementById('late-frame-host').attachShadow({ mode: 'open' }).innerHTML = '<button id="late-frame-target">New target</button>';
      });
      await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'div#late-frame-host'), null, { timeout: 1000 });
      await frame.evaluate(() => { feedback = []; document.getElementById('late-frame-host').shadowRoot.querySelector('button').textContent = 'Updated target'; });
      await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#late-frame-target'), null, { timeout: 1000 });
    }
  } finally { await browser.close(); }
});

test('Chrome selector scrolling claims input only at the actual page mutation', { timeout: 30000 }, async () => {
  const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser, tab = 912;
  const host = Object.assign({ isRunning: () => true, _checkAbort: () => false }, pageFeedbackMethods);
  let browser, page, session, pauseMethod = '', entered, resume;
  const registrations = [];
  const api = { runtime: {}, tabs: {
    get: async () => ({ url: 'https://monitor.test/start' }),
    sendMessage: async (_tab, msg) => {
      if (!page) return {};
      if (msg.action === 'page_monitor_dispatch') registrations.push(msg.params);
      return page.evaluate(msg => new Promise(resolve => messageListeners.forEach(fn => fn(msg, {}, resolve))), msg);
    },
  }, debugger: { sendCommand(_source, method, params, callback) {
    void (async () => {
      if (method === pauseMethod) {
        pauseMethod = ''; entered(); await new Promise(resolve => { resume = resolve; });
      }
      return await session.send(method, params);
    })().then(callback, error => { api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError; });
  } } };
  globalThis.chrome = api; delete globalThis.browser;
  try {
    await host._beginPageFeedbackRun(tab, 'interactive');
    ({ browser, page } = await fixture(chromium, 'chrome', { runToken: host._pageFeedbackRuns.get(tab).token }));
    const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
    host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, documentToken);
    await page.exposeFunction('feedbackToHost', feedback => host.observePageFeedback({ tab: { id: tab }, frameId: 0 }, feedback));
    await page.exposeFunction('monitorStateFromHost', token => host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, token));
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async message => {
        if (message.action === 'get_page_monitor_state') return await monitorStateFromHost(message.documentToken);
        const response = await original(message);
        return message.action === 'page_feedback' ? await feedbackToHost(message.feedback) : response;
      };
    });
    session = await page.context().newCDPSession(page);
    const client = new CDPClient(); client.sessions.set(tab, { attached: true });
    const reset = async () => {
      host._finishPageFeedbackRun(tab);
      await page.waitForTimeout(20);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(100);
      await host._beginPageFeedbackRun(tab, 'interactive');
      registrations.length = 0;
      await page.evaluate(() => { feedback = []; });
    };
    for (const scenario of [
      { method: 'Runtime.enable', selector: '#agent', options: { scroll: false, retries: 0 }, readOnly: true },
      { method: 'DOM.getDocument', selector: '#missing', options: { retries: 1, delayMs: 0 } },
      { method: 'Runtime.evaluate', selector: '#agent', options: { retries: 0 } },
    ]) {
      await reset(); pauseMethod = scenario.method;
      const paused = new Promise(resolve => { entered = resolve; });
      const resolving = client.resolveSelector(tab, scenario.selector, scenario.options)
        .then(value => ({ value }), error => ({ code: error.code }));
      await paused;
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForFunction(() => feedback.some(event => event.kind === 'scroll'), null, { timeout: 1000 });
      assert.ok(registrations.every(mark => mark.fenceOnly === true), 'A resolver cannot claim scroll while a DOM search is pending');
      resume(); resume = null;
      const result = await resolving;
      if (scenario.readOnly) {
        assert.equal(result.value.found, true); assert.equal(registrations.length, 0);
      } else assert.equal(result.code, 'page_feedback_pending', `${scenario.method} must preserve the external intervention`);
      assert.equal(await page.evaluate(() => scrollY), 600, 'A stale resolver must not scroll back to its target');
    }
    await reset();
    await page.evaluate(() => {
      for (const mode of ['open', 'closed']) {
        const el = document.createElement('div');
        el.attachShadow({ mode }).innerHTML = `<button id="deep-${mode}">Deep target</button>`;
        document.body.append(el);
      }
    });
    await page.waitForTimeout(200);
    for (const mode of ['open', 'closed']) {
      await reset();
      const result = await client.resolveSelector(tab, `#deep-${mode}`, { retries: 0 });
      assert.equal(result.found, true); assert.equal(result.inViewport, true);
      await page.waitForTimeout(200);
      assert.ok(await page.evaluate(() => scrollY > 1000), `${mode} target must actually scroll into view`);
      assert.deepEqual(await page.evaluate(() => feedback), [], `${mode} agent scroll must not trigger a feedback loop`);
    }
  } finally {
    resume?.(); host._finishPageFeedbackRun(tab);
    await browser?.close(); globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
  }
});

for (const siteIsolation of [false, true]) {
  test(`Chrome CDP input reaches the receiving iframe monitor (site isolation: ${siteIsolation})`, { timeout: 30000 }, async () => {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    const frames = new Map(), sessions = new Map(), registrations = [];
    const tab = siteIsolation ? 910 : 909;
    let browser, context, rootSession;
    const host = Object.assign({ isRunning: () => true, _checkAbort: () => false }, pageFeedbackMethods);
    const api = { runtime: {}, tabs: {
      get: async () => ({ url: 'https://monitor.test/start' }),
      sendMessage: async (_tab, message, options = {}) => {
        const frame = frames.get(options.frameId || 0);
        if (!frame) return {};
        if (message.action === 'page_monitor_dispatch') registrations.push(options.frameId || 0);
        return frame.evaluate(msg => new Promise(resolve => {
          for (const listener of messageListeners) listener(msg, {}, resolve);
        }), message);
      },
    }, debugger: { sendCommand(source, method, params, callback) {
      void (async () => {
        if (method === 'Target.attachToTarget') {
          for (const frame of frames.values()) {
            if (!frame.parentFrame()) continue;
            const session = await context.newCDPSession(frame);
            const tree = await session.send('Page.getFrameTree');
            if (tree.frameTree.frame.id === params.targetId) {
              const sessionId = `test-child-${sessions.size}`;
              sessions.set(sessionId, session); return { sessionId };
            }
            await session.detach();
          }
          throw new Error('Missing child target');
        }
        if (method === 'Target.detachFromTarget') {
          await sessions.get(params.sessionId).detach(); sessions.delete(params.sessionId); return {};
        }
        return (sessions.get(source.sessionId) || rootSession).send(method, params);
      })().then(callback, error => {
        api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError;
      });
    } } };
    globalThis.chrome = api; delete globalThis.browser;
    try {
      await host._beginPageFeedbackRun(tab, 'interactive');
      const fixtureResult = await fixture(chromium, 'chrome', { siteIsolation, runToken: host._pageFeedbackRuns.get(tab).token });
      ({ browser, context } = fixtureResult);
      const page = fixtureResult.page;
      await context.route('https://child.monitor.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('child.monitor.test') });
      await page.evaluate(() => {
        const frame = document.createElement('iframe'); frame.src = 'https://child.monitor.test/frame';
        frame.style.cssText = 'position:absolute;left:400px;top:20px;width:450px;height:450px';
        document.body.appendChild(frame);
      });
      const child = await navigation;
      await child.waitForFunction(() => window.__wbPageMonitor && document.documentElement.hasAttribute('data-webbrain-page-revision'));
      await page.waitForTimeout(200);
      frames.set(0, page.mainFrame()); frames.set(2, child);
      for (const [frameId, frame] of frames) {
        const documentToken = await frame.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
        host.pageMonitorState({ tab: { id: tab }, frameId }, documentToken);
        await frame.evaluate(() => { feedback = []; });
      }
      rootSession = await context.newCDPSession(page);
      const client = new CDPClient(); client.sessions.set(tab, { attached: true });
      const rect = await child.locator('#field').boundingBox();
      await client.dispatchMouseEvent(tab, 'mousePressed', rect.x + 8, rect.y + 8);
      await client.dispatchMouseEvent(tab, 'mouseReleased', rect.x + 8, rect.y + 8);
      await client.sendCommand(tab, 'Input.insertText', { text: 'agent' });
      assert.equal(await child.locator('#field').inputValue(), 'agent');
      assert.deepEqual(registrations, [2, 2, 2]);
      const container = await child.locator('#container').boundingBox();
      await client.sendCommand(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: container.x + 20, y: container.y + 20,
        deltaX: 0, deltaY: 100 });
      await child.waitForFunction(() => document.getElementById('container').scrollTop > 0);
      assert.equal(registrations.at(-1), 2);
      for (const frame of frames.values()) assert.equal((await frame.evaluate(() => feedback)).some(event => event.source !== 'agent'), false);
      await page.keyboard.insertText('human');
      const userEvents = (await child.evaluate(() => feedback)).filter(event => event.source === 'user');
      assert.ok(userEvents.length);
      for (const event of userEvents) host.observePageFeedback({ tab: { id: tab }, frameId: 2 }, event);
      await assert.rejects(client.sendCommand(tab, 'Input.insertText', { text: 'stale' }), { code: 'page_feedback_pending' });
      assert.equal(await child.locator('#field').inputValue(), 'agenthuman');
    } finally {
      host._finishPageFeedbackRun(tab);
      if (browser) await browser.close();
      globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
    }
  });
}

test('Firefox native preparation keeps same-target user edits and sends no stale keys', async () => {
  const { FirefoxBidiClient } = await import('../src/firefox/src/bidi/client.js');
  const { pageFeedbackMethods: methods } = await import('../src/firefox/src/agent/page-feedback.js');
  const { browser, page } = await fixture(firefox, 'firefox');
  const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
  const tab = 960, runId = crypto.randomUUID(), token = crypto.randomUUID(), session = new BidiSession();
  const host = { ...methods, isRunning: () => true, _checkAbort: () => false };
  let releasePreparation, startPreparation, inputs = 0;
  const entered = new Promise(resolve => { startPreparation = resolve; });
  const release = new Promise(resolve => { releasePreparation = resolve; });
  const api = { tabs: { get: async () => ({ url: page.url() }), sendMessage: async (_tab, message) => page.evaluate(message => {
    deliver(message.action, message.params || {}); return lastMonitorResponse;
  }, message) } };
  globalThis.chrome = api; globalThis.browser = api;
  const client = new FirefoxBidiClient(api);
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => { startPreparation(); await release; return { context: 'tab', node: { sharedId: 'field' } }; };
  session.call = async (_match, declaration, args = []) => ({ result: { value: await page.evaluate(({ declaration, args }) =>
    (0, eval)(`(${declaration})`)(document.getElementById('field'), ...args.map(arg => arg.value)), { declaration, args }) } });
  session.send = async method => { if (method === 'input.performActions') inputs++; return {}; };
  client.runs.set(tab, { runId, bound: true });
  client.request = async (_command, args) => session.perform(args.runId, args.action, args.payload);
  try {
    await host._beginPageFeedbackRun(tab, 'interactive');
    const runToken = host._pageFeedbackRuns.get(tab).token;
    await page.evaluate(runToken => { monitorRunToken = runToken; monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state'); }, runToken);
    await page.waitForTimeout(200);
    const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
    const from = { tab: { id: tab }, frameId: 0 };
    host.pageMonitorState(from, documentToken);
    await page.evaluate(token => document.getElementById('field').setAttribute('data-webbrain-bidi', token), token);
    await page.locator('#field').focus();
    const action = client.perform(tab, 'type', { token, selector: '#field', text: 'agent', clear: false });
    await entered;
    await page.keyboard.insertText('human');
    for (const event of await page.evaluate(() => feedback)) host.observePageFeedback(from, event);
    releasePreparation();
    await assert.rejects(action, error => error.code === 'page_feedback_pending' && error.dispatchState.noDispatch === true);
    assert.equal(inputs, 0);
    assert.equal(host._hasPendingPageFeedback(tab), true);
    assert.equal(await page.locator('#field').inputValue(), 'human');
  } finally {
    releasePreparation(); await session.close(); host._finishPageFeedbackRun(tab); await browser.close();
    globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
  }
});

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: a pointer gesture ending on owned UI releases the background idle gate`, async () => {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser, tab = 945;
    const host = Object.assign({ isRunning: () => true, _checkAbort: () => false, _runAbortSignal: () => null,
      _throwIfAborted: () => {}, _pageFeedbackIdleMs: 20 }, pageFeedbackMethods);
    globalThis.chrome = { runtime: {}, tabs: { get: async () => ({ url: 'https://monitor.test/start' }), sendMessage: async () => ({ ready: true }) } };
    delete globalThis.browser;
    let browser;
    try {
      await host._beginPageFeedbackRun(tab, 'interactive');
      const state = await fixture(engine, build, { runToken: host._pageFeedbackRuns.get(tab).token });
      browser = state.browser; const { page } = state;
      const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
      const sender = { tab: { id: tab }, frameId: 0 }; host.pageMonitorState(sender, documentToken);
      await page.exposeFunction('feedbackToHost', feedback => host.observePageFeedback(sender, feedback));
      await page.evaluate(() => {
        const original = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = async message => {
          const response = await original(message);
          return message.action === 'page_feedback' ? await feedbackToHost(message.feedback) : response;
        };
        const ui = document.createElement('div'); ui.id = 'owned-capture';
        ui.style.cssText = 'position:fixed;top:440px;left:20px;width:200px;height:80px;background:red';
        __wbPageMonitor.registerDecoration(ui); document.body.append(ui);
        document.getElementById('human').addEventListener('pointerdown', event => ui.setPointerCapture(event.pointerId));
        feedback = [];
      });
      const button = await page.locator('#human').boundingBox();
      await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2); await page.mouse.down();
      await page.waitForFunction(() => feedback.some(event => event.interacting === true));
      assert.ok(host._pageFeedbackRuns.get(tab).gestures.has(0));
      await page.mouse.move(100, 480); await page.mouse.up();
      await page.waitForFunction(() => feedback.some(event => event.kind === 'activity' && event.interacting === false), null, { timeout: 1000 });
      assert.equal(host._pageFeedbackRuns.get(tab).gestures.size, 0);
      assert.ok(!JSON.stringify(await page.evaluate(() => feedback)).includes('owned-capture'), 'Owned UI must remain absent from event targets');
      await host._waitForPageFeedbackIdle(tab);
    } finally { host._finishPageFeedbackRun(tab); await browser?.close(); globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; }
  });

  test(`${build}: popover transitions fence actions in light/shadow DOM without agent feedback loops`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const popup = document.createElement('div'); popup.id = 'light-popup'; popup.popover = 'auto'; popup.innerHTML = '<button>Popup target</button>';
        document.body.prepend(popup);
        const host = document.createElement('div'); host.id = 'popup-host'; document.body.prepend(host);
        host.attachShadow({ mode: 'open' }).innerHTML = '<div id="shadow-popup" popover><button>Shadow target</button></div>';
        window.popups = [popup, host.shadowRoot.querySelector('[popover]')];
        const filler = document.createElement('div'); filler.style.display = 'none'; filler.innerHTML = '<span>Outside signature budget</span>'.repeat(650);
        document.body.prepend(filler);
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      for (const index of [0, 1]) {
        await page.evaluate(index => {
          monitorEnabled = false; deliver('page_monitor_state'); popups[index].showPopover();
          monitorEnabled = true; deliver('page_monitor_state');
        }, index);
        await page.waitForTimeout(200);
        const initialClose = await page.evaluate(async index => {
          feedback = []; const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
          popups[index].hidePopover(); await Promise.resolve();
          try { __wbPageMonitor.beforeLocalDispatch(); return null; } catch (error) { return error.code; } finally { finish(); }
        }, index);
        assert.equal(initialClose, 'page_feedback_pending', 'Closing an initially open unseeded popover must invalidate actions');
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: 1000 });
        for (const open of [true, false]) {
          const code = await page.evaluate(async ({ index, open }) => {
            feedback = []; const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
            popups[index][open ? 'showPopover' : 'hidePopover'](); await Promise.resolve();
            try { __wbPageMonitor.beforeLocalDispatch(); return null; } catch (error) { return error.code; } finally { finish(); }
          }, { index, open });
          assert.equal(code, 'page_feedback_pending');
          await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: 1000 });
        }
        await page.evaluate(index => {
          feedback = []; const finish = __wbPageMonitor.beginContentAction('execute_js');
          try { __wbPageMonitor.beforeLocalDispatch(); popups[index].showPopover(); } finally { finish(); }
        }, index);
        await page.waitForTimeout(220);
        assert.deepEqual(await page.evaluate(() => feedback), [], 'An agent-opened popover must not feed back during the later toggle task');
        await page.evaluate(index => { popups[index].querySelector('button').focus(); feedback = []; }, index);
        await page.keyboard.press('Escape');
        await page.waitForFunction(index => !popups[index].matches(':popover-open') && feedback.some(event => event.kind === 'dom'), index, { timeout: 1000 });
        assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user' && event.kind === 'activity'));
        await page.waitForTimeout(200);
        const cancelled = await page.evaluate(async index => {
          feedback = []; popups[index].addEventListener('beforetoggle', event => event.preventDefault(), { once: true });
          const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
          popups[index].showPopover(); await Promise.resolve();
          try { __wbPageMonitor.beforeLocalDispatch({ preparation: true }); return true; } catch { return false; } finally { finish(); }
        }, index);
        assert.equal(cancelled, true, 'A canceled opening must not invalidate the unchanged page');
        await page.waitForTimeout(220); assert.deepEqual(await page.evaluate(() => feedback), []);
      }
      await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); feedback = []; popups[0].showPopover(); });
      await page.waitForTimeout(200); assert.deepEqual(await page.evaluate(() => feedback), []);
    } finally { await browser.close(); }
  });

  test(`${build}: related data/blob frames receive monitor and MAIN shadow hook`, async () => {
    const { browser, page } = await fixture(engine, build, { omitEmptyFrameMonitor: true });
    try {
      const manifest = JSON.parse(fs.readFileSync(new URL(`../src/${build}/manifest.json`, import.meta.url), 'utf8'));
      const entries = manifest.content_scripts.filter(entry => entry.run_at === 'document_start'
        && entry.js.some(file => /\/page-monitor(?:-shadow)?\.js$/.test(file)));
      assert.equal(entries.length, 2);
      for (const entry of entries) assert.ok(entry.all_frames && entry.match_origin_as_fallback,
        'Related opaque-origin documents need origin fallback for both execution worlds');
      await page.evaluate(() => {
        const markup = '<input id="inside"><p id="inside-status">Ready</p><div id="late-host"></div>';
        for (const [id, src] of [['data-frame', `data:text/html,${encodeURIComponent(markup)}`],
          ['blob-frame', URL.createObjectURL(new Blob([markup], { type: 'text/html' }))]]) {
          const frame = document.createElement('iframe'); frame.id = id; frame.src = src; document.body.prepend(frame);
        }
      });
      for (const [id, scheme] of [['data-frame', 'data:'], ['blob-frame', 'blob:']]) {
        const frame = await (await page.locator(`#${id}`).elementHandle()).contentFrame();
        await frame.waitForFunction(scheme => location.href.startsWith(scheme) && window.chrome?.runtime && document.getElementById('inside'), scheme);
        assert.equal(await frame.evaluate(() => !!window.__wbPageMonitor), false);
        // Model the manifest's related-origin registration, not Playwright's unconditional init-script injection.
        for (const entry of entries) for (const file of entry.js.filter(file => /\/page-monitor(?:-shadow)?\.js$/.test(file)))
          await frame.addScriptTag({ content: read(build, file.replace(/^src\//, '')) });
        await frame.waitForFunction(() => document.documentElement.hasAttribute('data-webbrain-page-revision'));
        const preparation = await frame.evaluate(() => {
          const finish = __wbPageMonitor.beginContentAction('type', { selector: '#inside', _bidiPrepare: true });
          try { __wbPageMonitor.beforeLocalDispatch(); return true; } finally { finish(); }
        });
        assert.equal(preparation, true, 'Document and local action tokens must work in related origins');
        await frame.waitForTimeout(220);
        await frame.locator('#inside').fill('Private frame input');
        await frame.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'));
        assert.ok(!JSON.stringify(await frame.evaluate(() => feedback)).includes('Private frame input'));
        await frame.evaluate(() => { feedback = []; document.getElementById('inside-status').textContent = 'Updated'; });
        await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
        await frame.evaluate(() => { feedback = []; document.getElementById('late-host').attachShadow({ mode: 'open' }).innerHTML = '<button>Target</button>'; });
        await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'div#late-host'));
        await frame.evaluate(() => { feedback = []; document.getElementById('late-host').shadowRoot.querySelector('button').textContent = 'Changed'; });
        await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button'));
      }
    } finally { await browser.close(); }
  });

  test(`${build}: Tab focus movement invalidates preparation without recording keys`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      for (const key of ['Tab', 'Shift+Tab']) {
        await page.locator('#human').focus();
        const before = await page.evaluate(() => {
          monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
          return document.activeElement.id;
        });
        await page.waitForTimeout(40);
        await page.evaluate(() => {
          feedback = []; window.finishPreparation = __wbPageMonitor.beginContentAction('type', { _bidiPrepare: true });
        });
        await page.keyboard.press(key);
        assert.notEqual(await page.evaluate(() => document.activeElement.id), before);
        const code = await page.evaluate(() => {
          try { __wbPageMonitor.beforeLocalDispatch(); return null; }
          catch (error) { return error.code; }
          finally { finishPreparation(); }
        });
        assert.equal(code, 'page_feedback_pending');
        const events = await page.evaluate(() => feedback);
        assert.ok(events.some(event => event.kind === 'activity' && event.source === 'user'));
        assert.ok(!JSON.stringify(events).includes('Tab'));
      }
      await page.locator('#human').focus();
      await page.evaluate(() => {
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(40);
      await page.evaluate(() => {
        feedback = []; deliver('page_monitor_prepare', { operationId: 'agent-tab', tool: 'press_keys', selector: '#human' });
        deliver('page_monitor_dispatch', { operationId: 'agent-tab', kind: 'input', selector: '#human', fenceOnly: true });
        document.getElementById('human').setAttribute('data-webbrain-native-action', JSON.stringify({ ...lastMonitorResponse.guard, kind: 'input', sequence: 1 }));
      });
      await page.keyboard.press('Tab');
      await page.waitForTimeout(80);
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false,
        'An attributed native Tab must not steer its own run');
    } finally { await browser.close(); }
  });

  test(`${build}: monitor captures user input without values, suppresses agent input and keeps concurrent user input`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.locator('#field').fill('private-field-value');
      await page.locator('#secret').fill('password-never-recorded');
      await page.locator('#select').selectOption('B');
      const input = await page.evaluate(() => feedback);
      assert.ok(input.some(event => event.kind === 'input' && event.source === 'user'));
      assert.equal(JSON.stringify(input).includes('private-field-value'), false);
      assert.equal(JSON.stringify(input).includes('password-never-recorded'), false);

      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'agent-click', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'agent-click', kind: 'click', selector: '#agent' });
      });
      assert.equal((await page.evaluate(() => feedback)).some(event => event.operation === 'click'), false,
        'A prepared click must not claim navigation before any page input occurs');
      await page.locator('#agent').click();
      await page.waitForTimeout(200);
      const own = await page.evaluate(() => feedback);
      assert.ok(own.some(event => event.source === 'agent' && event.operation === 'click'),
        'The actual matching click must supply navigation correlation');
      assert.equal(own.some(event => event.source !== 'agent'), false, JSON.stringify(own));
      await page.locator('#agent').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'click' && event.source === 'user'
        && event.target === 'button#agent'), 'A later human click on the same target must survive attribution');
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user' && event.target === 'button#human'));

      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'agent-type', tool: 'type_text', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'agent-type', kind: 'input', selector: '#field' });
      });
      await page.locator('#field').focus();
      await page.keyboard.insertText('agent-text');
      const ownTyping = await page.evaluate(() => feedback);
      assert.equal(ownTyping.some(event => event.source !== 'agent'), false, JSON.stringify(ownTyping));
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'));
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'click-with-external-dom', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'click-with-external-dom', kind: 'click', selector: '#agent' });
        document.getElementById('agent').textContent = 'External DOM change on the same target';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom' && event.source !== 'agent'),
        'A dispatched click must not silence unrelated DOM writes on its target');
    } finally { await browser.close(); }
  });

  test(`${build}: DOM, window/container scrolling, cleanup and restored monitoring work`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => { document.getElementById('status').textContent = 'Asynchronous page update'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'));
      await page.evaluate(() => {
        feedback = []; const field = document.getElementById('field');
        field.value = 'page-written-private-value'; field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const automaticInput = await page.evaluate(() => feedback);
      assert.ok(automaticInput.some(event => event.kind === 'input' && event.source === 'page'));
      assert.equal(JSON.stringify(automaticInput).includes('page-written-private-value'), false);
      await page.evaluate(() => { feedback = []; window.scrollTo(0, 400); });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'scroll' && event.viewport.y === 400));
      await page.evaluate(() => { feedback = []; document.getElementById('container').scrollTop = 120; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'scroll' && event.target === 'div#container'));
      await page.waitForTimeout(120); // Finish the preceding container scroll's coalesced position.
      await page.evaluate(() => {
        feedback = []; deliver('page_monitor_prepare', { operationId: 'agent-scroll', tool: 'scroll' });
        deliver('page_monitor_dispatch', { operationId: 'agent-scroll', kind: 'scroll' });
        window.scrollTo(0, 600);
      });
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).length, 0, 'Programmatic agent scroll must not steer itself');

      await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); feedback = [];
        document.getElementById('status').textContent = 'Stopped'; window.scrollTo(0, 0); });
      await page.waitForTimeout(200);
      await page.locator('#human').click();
      assert.equal((await page.evaluate(() => feedback)).length, 0);
      await page.evaluate(() => { monitorEnabled = true; deliver('page_monitor_state'); });
      await page.waitForTimeout(20);
      await page.evaluate(() => { document.getElementById('status').textContent = 'Restarted observer'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.goto('https://monitor.test/replacement');
      await page.waitForTimeout(200);
      await page.evaluate(() => { feedback = []; });
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'click'));
    } finally { await browser.close(); }
  });

  test(`${build}: frames, open shadow DOM and dispatch preparation retain external changes`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const host = document.createElement('div'); host.id = 'shadow-host';
        host.attachShadow({ mode: 'open' }).innerHTML = '<button id="shadow-button">Before</button>';
        document.body.prepend(host);
        const frame = document.createElement('iframe'); frame.src = 'https://monitor.test/frame';
        document.body.prepend(frame);
      });
      await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.feedback);
      const child = page.frames().find(frame => frame.url() === 'https://monitor.test/frame');
      await page.locator('#human').click();
      await child.locator('#human').click();
      const tokens = await Promise.all([page.evaluate(() => feedback[0]?.documentToken), child.evaluate(() => feedback[0]?.documentToken)]);
      assert.ok(tokens[0] && tokens[1] && tokens[0] !== tokens[1]);
      await child.evaluate(() => {
        const link = document.createElement('a'); link.id = 'top-link'; link.href = 'https://monitor.test/destination';
        link.textContent = 'Top link'; link.addEventListener('click', event => event.preventDefault()); document.body.append(link);
      });
      await page.waitForTimeout(200);
      for (const target of ['_top', '_parent']) {
        await child.evaluate(target => {
          document.getElementById('top-link').target = target;
          deliver('page_monitor_prepare', { operationId: `link-${target}`, tool: 'click', selector: '#top-link' });
          deliver('page_monitor_dispatch', { operationId: `link-${target}`, kind: 'click', selector: '#top-link' });
          feedback = [];
        }, target);
        await child.locator('#top-link').click();
        assert.ok((await child.evaluate(() => feedback)).some(event => event.source === 'agent' && event.navigationTarget === '_top'),
          `${target} navigation must carry the compatible top-frame target`);
      }
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = [];
        document.getElementById('shadow-host').shadowRoot.querySelector('button').textContent = 'After';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#shadow-button'));

      await page.evaluate(() => { feedback = []; });
      await page.locator('#human').click();
      await page.waitForTimeout(20); // Separate timer work from the click's synchronous handlers.
      await page.evaluate(() => { document.getElementById('status').textContent = 'Unrelated timer update'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'p#status'));
      const unrelated = await page.evaluate(() => feedback.find(event => event.kind === 'dom' && event.target === 'p#status'));
      assert.equal(unrelated.source, 'page');

      await page.evaluate(() => {
        feedback = []; monitorEnabled = false; deliver('page_monitor_state');
        monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(20);
      await page.evaluate(() => { feedback = []; document.getElementById('shadow-host').shadowRoot.querySelector('button').textContent = 'Existing shadow'; });
      await page.waitForFunction(() => feedback.some(event => event.target === 'button#shadow-button'));
      await page.waitForTimeout(160);
      const result = await page.evaluate(async () => {
        const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
        document.getElementById('status').textContent = 'Changed during preparation';
        await Promise.resolve(); // Deliver MutationObserver before the final dispatch gate.
        try { __wbPageMonitor.beforeLocalDispatch(); return 'unexpected-dispatch'; }
        catch (error) { return { code: error.code, dispatched: error.dispatched }; }
        finally { finish(); }
      });
      assert.deepEqual(result, { code: 'page_feedback_pending', dispatched: false });
      const earlyDispatch = await page.evaluate(async () => {
        // A DOM callback has detected a change, but its 150ms coalesced feedback
        // has not reached background yet. The native dispatch gate must catch it.
        document.getElementById('status').textContent = 'Before coalesced feedback';
        await Promise.resolve();
        deliver('page_monitor_prepare', { operationId: 'coalesced-race', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'coalesced-race', kind: 'click', selector: '#agent' });
        await new Promise(resolve => setTimeout(resolve, 0));
        return lastMonitorResponse;
      });
      assert.equal(earlyDispatch.pageFeedbackPending, true);
    } finally { await browser.close(); }
  });

  test(`${build}: preparation scrolling preserves same-target input and rejects intervening DOM changes`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await installScrollHelper(page, build);
      await page.evaluate(() => {
        const box = document.createElement('div'); box.id = 'prep-scroll-box'; box.style.cssText = 'overflow:auto;height:100px;width:300px';
        box.innerHTML = '<input id="prepared-field" style="margin-top:900px">'; document.body.append(box);
        window.__wb_ax_lookup = ref => document.getElementById(ref);
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = [];
        const finish = __wbPageMonitor.beginContentAction('type_ax', { ref_id: 'prepared-field', _bidiPrepare: { action: 'type' } });
        try { _scrollElementIntoClearView(document.getElementById('prepared-field')); } finally { finish(); }
      });
      await page.waitForTimeout(80);
      assert.ok(await page.evaluate(() => document.getElementById('prep-scroll-box').scrollTop > 0));
      assert.deepEqual(await page.evaluate(() => feedback), []);
      await page.evaluate(() => document.getElementById('prepared-field').focus({ preventScroll: true }));
      await page.keyboard.press('x');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'), null, { timeout: 1000 });
      await page.evaluate(() => {
        monitorEnabled = false; deliver('page_monitor_state'); document.activeElement?.blur();
        document.getElementById('prep-scroll-box').scrollTop = 0; window.scrollTo(0, 0);
      });
      await page.waitForTimeout(50);
      await page.evaluate(() => { monitorEnabled = true; deliver('page_monitor_state'); });
      await page.waitForTimeout(20);
      assert.equal(await page.evaluate(() => document.getElementById('prep-scroll-box').scrollTop), 0,
        'Keep the target offscreen before testing a rejected preparation, without browser caret scrolling');
      const result = await page.evaluate(async () => {
        const finish = __wbPageMonitor.beginContentAction('type_ax', { ref_id: 'prepared-field', _bidiPrepare: { action: 'type' } });
        document.getElementById('status').textContent = 'Intervening page change'; await Promise.resolve();
        try { _scrollElementIntoClearView(document.getElementById('prepared-field')); return { dispatched: true }; }
        catch (error) { return { code: error.code, dispatched: error.dispatched }; }
        finally { finish(); }
      });
      assert.deepEqual(result, { code: 'page_feedback_pending', dispatched: false });
      assert.equal(await page.evaluate(() => document.getElementById('prep-scroll-box').scrollTop), 0, 'A rejected helper must not scroll through its fallback');
    } finally { await browser.close(); }
  });

  test(`${build}: existing dialogs, details and inert surfaces invalidate prepared actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const surfaces = document.createElement('div');
        surfaces.innerHTML = '<dialog id="modal"><button>Modal target</button></dialog><details id="details" style="height:100px"><summary>Summary</summary><button>Existing details target</button></details><div id="inert-surface"><button>Existing inert target</button></div>';
        document.body.prepend(surfaces);
      });
      await page.waitForTimeout(200);
      for (const state of ['modal-open', 'modal-close', 'details-open', 'details-close', 'inert-on', 'inert-off']) {
        const response = await page.evaluate(async state => {
          feedback = []; deliver('page_monitor_prepare', { operationId: state, tool: 'click', selector: '#agent' });
          if (state === 'modal-open') document.getElementById('modal').showModal();
          if (state === 'modal-close') document.getElementById('modal').close();
          if (state.startsWith('details')) document.getElementById('details').open = state.endsWith('open');
          if (state.startsWith('inert')) document.getElementById('inert-surface').inert = state.endsWith('on');
          await Promise.resolve();
          deliver('page_monitor_dispatch', { operationId: state, kind: 'click', selector: '#agent' });
          await new Promise(resolve => setTimeout(resolve, 0));
          return lastMonitorResponse;
        }, state);
        assert.equal(response.pageFeedbackPending, true, `${state} must invalidate the prepared click`);
        assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom'), `${state} must refresh page context`);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: viewport resize fences prepared coordinates and stops with the run`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => { document.getElementById('agent').style.cssText = 'position:absolute;left:50vw;top:0'; });
      await page.waitForTimeout(200);
      const before = await page.locator('#agent').boundingBox();
      await page.evaluate(() => { feedback = []; deliver('page_monitor_prepare', { operationId: 'resize-click', tool: 'click', selector: '#agent' }); });
      await page.setViewportSize({ width: 900, height: 600 });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'resize'), null, { timeout: 1000 });
      const after = await page.locator('#agent').boundingBox();
      assert.notEqual(before.x, after.x);
      const response = await page.evaluate(async () => {
        deliver('page_monitor_dispatch', { operationId: 'resize-click', kind: 'click', x: 650, y: 20 });
        await new Promise(resolve => setTimeout(resolve, 0)); return lastMonitorResponse;
      });
      assert.equal(response.pageFeedbackPending, true);
      const observation = await page.evaluate(() => feedback.find(event => event.kind === 'resize'));
      assert.equal(observation.source, 'unknown'); assert.equal(observation.viewport.width, 900);
      const frameNavigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url() === 'https://monitor.test/frame' });
      await page.evaluate(() => {
        const frame = document.createElement('iframe'); frame.src = 'https://monitor.test/frame';
        frame.style.cssText = 'width:400px;height:250px'; document.body.prepend(frame);
      });
      const child = await frameNavigation;
      await child.waitForFunction(() => window.__wbPageMonitor && document.documentElement.hasAttribute('data-webbrain-page-revision'));
      await child.evaluate(() => { feedback = []; });
      await page.evaluate(() => { document.querySelector('iframe').style.width = '450px'; });
      await child.waitForFunction(() => feedback.some(event => event.kind === 'resize'), null, { timeout: 1000 });
      assert.equal(await child.evaluate(() => feedback.find(event => event.kind === 'resize').source), 'page', 'Embedded frame dimensions are page layout changes');
      await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); feedback = []; });
      await page.setViewportSize({ width: 1000, height: 700 });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Stop removes viewport listeners');
    } finally { await browser.close(); }
  });

  test(`${build}: contenteditable fallback attributes its cancellable gate and native edits`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await installContentEditableFallback(page, build);
      for (const behavior of ['append', 'replace', 'cancel', 'editor-handles']) {
        await page.evaluate(behavior => {
          const editor = document.getElementById('rich-editor');
          editor.innerHTML = '<p>Original <strong>format</strong></p>';
          window.originalStrong = editor.querySelector('strong'); window.gates = [];
          editor.onbeforeinput = event => {
            gates.push(event.inputType);
            if (behavior === 'cancel') event.preventDefault();
            if (behavior === 'editor-handles') { event.preventDefault(); editor.append(' handled'); }
          };
        }, behavior);
        await page.waitForTimeout(200);
        await page.evaluate(() => { feedback = []; });
        const result = await page.evaluate(params => typeRichText(params), {
          text: behavior === 'replace' ? 'New\ntext' : ' added', clear: behavior === 'replace',
        });
        if (behavior === 'cancel') {
          assert.equal(result.cancelled, true, JSON.stringify(result)); assert.equal(result.noDispatch, true);
          assert.equal(await page.locator('#rich-editor').innerHTML(), '<p>Original <strong>format</strong></p>');
        } else if (behavior === 'editor-handles') {
          assert.equal(result.success, false); assert.equal(result.mutationMayHaveOccurred, true, JSON.stringify(result));
          assert.equal(await page.locator('#rich-editor').textContent(), 'Original format handled');
        } else {
          assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.verified, true);
          if (behavior === 'append') assert.equal(await page.evaluate(() => document.getElementById('rich-editor').contains(originalStrong)), true);
          else assert.equal(result.value, 'New\ntext');
        }
        await page.waitForTimeout(200);
        assert.deepEqual(await page.evaluate(() => feedback), [], 'Own beforeinput, input and DOM effects must not trigger replanning');
      }
      await page.evaluate(() => {
        const editor = document.getElementById('rich-editor'); editor.onbeforeinput = null; editor.textContent = 'Ready';
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => { feedback = []; });
      assert.equal((await page.evaluate(() => typeRichText({ text: ' agent' }))).success, true);
      await page.keyboard.press('x');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'), null, { timeout: 1000 });
      assert.equal(await page.locator('#rich-editor').textContent(), 'Ready agentx', 'A later same-target human edit remains observable');
    } finally { await browser.close(); }
  });

  test(`${build}: contenteditable fallback skips remaining insertion after user intervention`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await installContentEditableFallback(page, build);
      await page.evaluate(() => { document.getElementById('rich-editor').textContent = 'Original'; });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = []; const schedule = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === 30) {
            window.editPaused = true;
            window.resumeEdit = () => { window.setTimeout = schedule; schedule(callback, 0, ...args); };
            return 0;
          }
          return schedule(callback, delay, ...args);
        };
        window.editResult = typeRichText({ text: 'Never inserted', clear: true });
      });
      await page.waitForFunction(() => window.editPaused, null, { timeout: 1000 });
      await page.locator('#field').fill('Human intervention');
      await page.waitForFunction(() => feedback.some(event => event.source === 'user'));
      const result = await page.evaluate(async () => { resumeEdit(); return await editResult; });
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.dispatched, true, 'The completed deletion retains its dispatched outcome');
      assert.equal(await page.locator('#rich-editor').textContent(), '');
      assert.equal(await page.locator('#field').inputValue(), 'Human intervention');
    } finally { await browser.close(); }
  });

  test(`${build}: animation and extension decoration do not produce page feedback`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        feedback = [];
        const decoration = document.createElement('div'); decoration.dataset.webbrainUi = 'indicator';
        __wbPageMonitor.registerDecoration(decoration);
        decoration.textContent = 'Agent decoration'; document.body.appendChild(decoration);
        const root = decoration.attachShadow({ mode: 'open' }); root.innerHTML = '<span>Shadow decoration</span>';
        window.animationUpdates = setInterval(() => {
          document.getElementById('moving').style.transform = `translateX(${Math.random() * 10}px)`;
          decoration.textContent = String(Math.random());
          root.querySelector('span').textContent = String(Math.random());
        }, 10);
      });
      await page.waitForTimeout(400);
      const observed = await page.evaluate(() => { clearInterval(animationUpdates); return feedback; });
      assert.equal(observed.length, 0, JSON.stringify(observed));
    } finally { await browser.close(); }
  });

  test(`${build}: page-owned marker attributes and ID prefixes cannot silence monitoring`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      for (const [name, value] of [['id', 'webbrain-layout'], ['id', 'wb-agent-layout'], ['data-webbrain-ui', 'page'],
        ['data-webbrain-dev-highlight', 'page'], ['data-webbrain-attention', 'page']]) {
        await page.evaluate(({ name, value }) => {
          document.body.setAttribute(name, value); feedback = [];
        }, { name, value });
        await page.locator('#human').click();
        assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'click' && event.source === 'user'),
          `${name} is page data, not proof of extension ownership`);
        await page.evaluate(() => { feedback = []; document.getElementById('status').textContent += ' changed'; });
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: 1000 });
        await page.evaluate(name => document.body.removeAttribute(name), name);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: actual extension indicator nodes remain excluded after monitor replacement`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: read(build, 'content/agent-visual-indicator.js') });
      await page.evaluate(() => {
        feedback = [];
        messageListeners.forEach(listener => listener({ type: 'WB_SHOW_AGENT_INDICATORS' }, {}, () => {}));
      });
      await page.waitForTimeout(400);
      assert.equal((await page.evaluate(() => feedback)).length, 0);
      await page.addScriptTag({ content: read(build, 'content/page-monitor.js') });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = [];
        document.getElementById('webbrain-agent-stop-container').style.left = '40%';
      });
      await page.locator('#webbrain-agent-stop-button').click();
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).length, 0);
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'));
    } finally { await browser.close(); }
  });

  test(`${build}: companion native markers renew per key without hiding a later human edit`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'native-typing', tool: 'type_text', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'native-typing', kind: 'input', selector: '#field', navigationCandidate: false, fenceOnly: true });
        feedback = []; return lastMonitorResponse.guard;
      });
      await page.locator('#field').focus();
      for (let i = 0; i < 3; i++) {
        await page.evaluate(({ guard, i }) => document.getElementById('field').setAttribute('data-webbrain-native-action',
          JSON.stringify({ ...guard, kind: 'input', sequence: i })), { guard, i });
        await page.keyboard.insertText('a');
      }
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false);
      await page.keyboard.insertText('human-private');
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'));
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('human-private'), false);
      assert.notEqual(await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision')),
        `${guard.documentToken}:${guard.revision}`);
    } finally { await browser.close(); }
  });

  for (const action of ['click', 'type']) {
    test(`${build}: ${action} preparation preserves same-target human input`, async () => {
      const { browser, page } = await fixture(engine, build);
      try {
        const selector = action === 'click' ? '#agent' : '#field';
        await page.evaluate(({ action, selector }) => {
          feedback = [];
          deliver('page_monitor_prepare', { operationId: 'preparing', tool: action, selector });
          deliver('page_monitor_dispatch', { operationId: 'preparing', kind: action === 'click' ? 'click' : 'input', selector, fenceOnly: true });
          window.finishPreparation = __wbPageMonitor.beginContentAction(action, { selector, _bidiPrepare: action === 'type' });
        }, { action, selector });
        if (action === 'click') await page.locator(selector).click();
        else { await page.locator(selector).focus(); await page.keyboard.insertText('human'); }
        assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'),
          'Preparation must not consume physical input as an agent action');
        const code = await page.evaluate(() => {
          try { __wbPageMonitor.beforeLocalDispatch(); return null; }
          catch (error) { return error.code; }
          finally { finishPreparation(); }
        });
        assert.equal(code, 'page_feedback_pending');
      } finally { await browser.close(); }
    });
  }

  test(`${build}: ancestor class and style changes track plain content visibility`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const style = document.createElement('style'); style.textContent = '#plain-result {display:var(--result-display,block)} .closed #plain-result {display:none}'; document.head.append(style);
        const container = document.createElement('div'); container.id = 'style-container'; container.className = 'closed';
        container.style.cssText = 'width:200px;height:80px'; container.innerHTML = '<div id="plain-result">Visible result content</div>';
        document.body.prepend(container);
      });
      for (const attribute of ['class', 'style']) {
        await page.evaluate(attribute => {
          const container = document.getElementById('style-container');
          container.className = 'closed'; container.style.setProperty('--result-display', attribute === 'style' ? 'none' : 'block');
          if (attribute === 'style') container.className = '';
          monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
        }, attribute);
        await page.waitForTimeout(200);
        for (const show of [true, false]) {
          const unchangedGeometry = await page.evaluate(({ attribute, show }) => {
            feedback = [];
            const container = document.getElementById('style-container'), before = container.getBoundingClientRect();
            if (attribute === 'class') container.className = show ? '' : 'closed';
            else container.style.setProperty('--result-display', show ? 'block' : 'none');
            const after = container.getBoundingClientRect();
            return before.width === after.width && before.height === after.height;
          }, { attribute, show });
          assert.equal(unchangedGeometry, true);
          await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: 1000 });
          assert.equal(await page.locator('#plain-result').isVisible(), show);
          assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom'));
        }
      }
    } finally { await browser.close(); }
  });

  test(`${build}: large ancestor visibility changes invalidate actions beyond the sampling budget`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = '#late-result {display:var(--late-display,block)} .closed #late-result {display:none}'; document.head.append(style);
        const region = document.createElement('div'); region.id = 'large-region'; region.className = 'closed';
        region.style.cssText = 'width:200px;height:80px';
        region.innerHTML = '<span style="display:none">Earlier unchanged node</span>'.repeat(650) + '<div id="late-result">Late visible result</div>';
        document.body.prepend(region);
      });
      for (const attribute of ['class', 'style']) {
        await page.evaluate(attribute => {
          const region = document.getElementById('large-region'); region.className = attribute === 'class' ? 'closed' : '';
          region.style.setProperty('--late-display', attribute === 'style' ? 'none' : 'block');
          monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
        }, attribute);
        await page.waitForTimeout(200);
        for (const shown of [true, false]) {
          const result = await page.evaluate(async ({ attribute, shown }) => {
            const region = document.getElementById('large-region'), before = region.getBoundingClientRect();
            feedback = []; const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
            if (attribute === 'class') region.className = shown ? '' : 'closed';
            else region.style.setProperty('--late-display', shown ? 'block' : 'none');
            await Promise.resolve();
            let code; try { __wbPageMonitor.beforeLocalDispatch(); } catch (error) { code = error.code; } finally { finish(); }
            const after = region.getBoundingClientRect();
            return { code, sameGeometry: before.width === after.width && before.height === after.height };
          }, { attribute, shown });
          assert.deepEqual(result, { code: 'page_feedback_pending', sameGeometry: true });
          await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: 1000 });
          assert.equal(await page.locator('#late-result').isVisible(), shown);
          await page.evaluate(attribute => {
            feedback = []; const region = document.getElementById('large-region');
            region.setAttribute(attribute, region.getAttribute(attribute));
          }, attribute);
          await page.waitForTimeout(200);
          assert.deepEqual(await page.evaluate(() => feedback), [], 'Repeated identical attributes must not trigger the conservative fallback');
        }
      }
      await page.evaluate(() => {
        feedback = []; const finish = __wbPageMonitor.beginContentAction('execute_js');
        try { __wbPageMonitor.beforeLocalDispatch(); document.getElementById('large-region').className = 'agent-theme'; }
        finally { finish(); }
      });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'A synchronous attributed ancestor write must not steer itself');
    } finally { await browser.close(); }
  });

  test(`${build}: same-shape subtree replacements invalidate prepared actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const region = document.createElement('div'); region.id = 'rerender';
        region.style.cssText = 'width:200px;height:50px';
        region.innerHTML = '<div><button id="replace-target" style="width:100px;height:30px">Old</button></div>';
        document.body.prepend(region);
      });
      for (const label of ['New', 'New']) {
        await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state'); });
        await page.waitForTimeout(200);
        const result = await page.evaluate(async label => {
          feedback = [];
          const region = document.getElementById('rerender'), oldTarget = document.getElementById('replace-target');
          const before = region.getBoundingClientRect();
          const fence = document.documentElement.getAttribute('data-webbrain-page-revision');
          const finish = __wbPageMonitor.beginContentAction('click', { selector: '#replace-target', _bidiPrepare: true });
          region.innerHTML = `<div><button id="replace-target" style="width:100px;height:30px">${label}</button></div>`;
          await Promise.resolve();
          let code;
          try { __wbPageMonitor.beforeLocalDispatch(); } catch (error) { code = error.code; }
          finally { finish(); }
          const after = region.getBoundingClientRect();
          return { code, disconnected: !oldTarget.isConnected, sameSize: before.width === after.width && before.height === after.height,
            revised: fence !== document.documentElement.getAttribute('data-webbrain-page-revision') };
        }, label);
        assert.deepEqual(result, { code: 'page_feedback_pending', disconnected: true, sameSize: true, revised: true });
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      }
    } finally { await browser.close(); }
  });

  test(`${build}: long text edits beyond the initial prefix invalidate prepared actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const output = document.createElement('p'); output.id = 'long-output';
        output.style.cssText = 'width:800px;height:160px;font:12px/14px monospace;word-break:break-all';
        output.textContent = 'A'.repeat(260) + ' middle OLD ' + 'B'.repeat(260) + ' suffix OLD';
        document.body.prepend(output);
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      for (const edit of ['middle', 'suffix', 'append']) {
        const result = await page.evaluate(async edit => {
          feedback = []; const output = document.getElementById('long-output'), before = output.getBoundingClientRect();
          const prefix = output.textContent.slice(0, 200);
          const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
          if (edit === 'middle') output.firstChild.data = output.firstChild.data.replace('middle OLD', 'middle NEW');
          else if (edit === 'suffix') output.textContent = output.textContent.replace('suffix OLD', 'suffix NEW');
          else output.firstChild.appendData(' additional output');
          await Promise.resolve();
          let code; try { __wbPageMonitor.beforeLocalDispatch(); } catch (error) { code = error.code; } finally { finish(); }
          const after = output.getBoundingClientRect();
          return { code, sameGeometry: before.width === after.width && before.height === after.height,
            samePrefix: prefix === output.textContent.slice(0, 200) };
        }, edit);
        assert.deepEqual(result, { code: 'page_feedback_pending', sameGeometry: true, samePrefix: true });
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: 1000 });
      }
      await page.evaluate(() => { feedback = []; const output = document.getElementById('long-output'); output.textContent = output.textContent; });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Replacing an identical text node must remain coalesced');
      await page.evaluate(() => {
        feedback = []; document.getElementById('long-output').firstChild.splitText(270);
      });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Splitting unchanged text must retain the same content signature');
      await page.evaluate(() => {
        feedback = []; const output = document.getElementById('long-output'); output.normalize(); output.append(document.createTextNode(''));
      });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Normalizing or adding empty text must not produce feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: aria-pressed-only toggle changes invalidate preparation and preserve agent attribution`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const toggle = document.getElementById('human'); toggle.setAttribute('aria-pressed', 'false');
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      for (const state of ['true', 'mixed', 'false']) {
        const code = await page.evaluate(async state => {
          feedback = []; const finish = __wbPageMonitor.beginContentAction('click', { selector: '#human', _bidiPrepare: true });
          document.getElementById('human').setAttribute('aria-pressed', state);
          await Promise.resolve();
          try { __wbPageMonitor.beforeLocalDispatch(); return null; }
          catch (error) { return error.code; }
          finally { finish(); }
        }, state);
        assert.equal(code, 'page_feedback_pending');
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#human'), null, { timeout: 1000 });
      }
      await page.evaluate(() => {
        feedback = []; const finish = __wbPageMonitor.beginContentAction('execute_js');
        try { __wbPageMonitor.beforeLocalDispatch(); document.getElementById('human').setAttribute('aria-pressed', 'true'); }
        finally { finish(); }
      });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'A marked synchronous toggle must not feed back into its own run');
    } finally { await browser.close(); }
  });

  test(`${build}: upgrading an existing host observes its newly attached shadow root`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const host = document.createElement('wb-late-shadow'); host.id = 'late-shadow';
        host.style.cssText = 'display:block;width:200px;height:50px'; document.body.prepend(host);
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      const result = await page.evaluate(async () => {
        feedback = [];
        const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
        customElements.define('wb-late-shadow', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button id="late-target">Before</button>'; }
        });
        await Promise.resolve();
        try { __wbPageMonitor.beforeLocalDispatch(); return null; }
        catch (error) { return error.code; }
        finally { finish(); }
      });
      assert.equal(result, 'page_feedback_pending');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.evaluate(() => { feedback = []; document.getElementById('late-shadow').shadowRoot.querySelector('button').textContent = 'After'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#late-target'));
      await page.evaluate(() => { feedback = []; document.getElementById('late-shadow').shadowRoot.innerHTML = '<button id="late-target">After</button>'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); feedback = []; document.getElementById('late-shadow').shadowRoot.querySelector('button').textContent = 'Stopped'; });
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).length, 0);
    } finally { await browser.close(); }
  });

  test(`${build}: marked synchronous DOM writes suppress their own effects and retain later edits`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'dom-write', tool: 'execute_js' });
        deliver('page_monitor_dispatch', { operationId: 'dom-write', kind: 'dom' });
        document.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', { detail: JSON.stringify(lastMonitorResponse.guard) }));
        document.getElementById('status').textContent = 'Own DOM write';
      });
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).length, 0);
      await page.evaluate(() => { document.getElementById('status').textContent = 'External DOM edit'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
    } finally { await browser.close(); }
  });

  test(`${build}: native clear chords renew per phase and still detect later human keys`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.locator('#field').fill('old');
      await page.waitForTimeout(200);
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'clear-chord', tool: 'set_field', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'clear-chord', kind: 'input', selector: '#field', fenceOnly: true });
        feedback = []; return lastMonitorResponse.guard;
      });
      const mark = sequence => page.evaluate(({ guard, sequence }) => document.getElementById('field')
        .setAttribute('data-webbrain-native-action', JSON.stringify({ ...guard, kind: 'input', sequence })), { guard, sequence });
      await mark(1); await page.keyboard.down('Control');
      await mark(2); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await mark(3); await page.keyboard.press('Delete');
      await mark(4); await page.keyboard.insertText('new');
      assert.equal(await page.locator('#field').inputValue(), 'new');
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false);
      await page.keyboard.type('human');
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'));
      assert.notEqual(await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision')),
        `${guard.documentToken}:${guard.revision}`);
    } finally { await browser.close(); }
  });

  test(`${build}: native uploads target an unfocused file input without hiding user input`, async () => {
    const { browser, page } = await fixture(engine, build);
    const session = new BidiSession(), runId = crypto.randomUUID(), token = crypto.randomUUID();
    session.runs.set(runId, { context: 'tab' });
    session.locate = async () => ({ context: 'tab', node: { sharedId: 'upload' } });
    session.call = async (_match, declaration, args = []) => ({ result: { value: await page.evaluate(({ declaration, args }) =>
      (0, eval)(`(${declaration})`)(document.getElementById('upload'), ...args.map(arg => arg.value)), { declaration, args }) } });
    session.send = async (method, params) => {
      if (method === 'input.setFiles') await page.locator('#upload').setInputFiles(params.files);
      return {};
    };
    try {
      await page.evaluate(token => {
        const input = document.createElement('input'); input.id = 'upload'; input.type = 'file';
        input.setAttribute('data-webbrain-bidi', token); document.body.append(input);
      }, token);
      await page.waitForTimeout(200);
      await page.locator('#field').focus();
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'upload', tool: 'upload_file', selector: '#upload' });
        deliver('page_monitor_dispatch', { operationId: 'upload', kind: 'input', selector: '#upload', navigationCandidate: false, fenceOnly: true });
        feedback = []; return lastMonitorResponse.guard;
      });
      assert.equal((await session.perform(runId, 'upload', { token, base64: 'eA==', filename: 'test.txt', pageFeedbackGuard: guard })).success, true);
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'field');
      await page.keyboard.insertText('human');
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'input' && event.source === 'user'));
    } finally { await session.close(); await browser.close(); }
  });

  test(`${build}: navigation notes are plain text, deduplicated and survive history restoration`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="assistant"></div>');
      await page.addScriptTag({ content: read(build, 'ui/page-feedback-ui.js').replace('export function', 'function') });
      await page.evaluate(() => {
        const translate = (_key, args) => `Page changed (${args.before} → ${args.after}). Continuing.`;
        const data = { id: 'notice-1', navigation: true, before: 'https://u:password@example.com/a?secret=yes',
          after: 'https://example.com/<img>?private=value#token' };
        renderPageFeedbackNote(document.getElementById('assistant'), data, translate);
        renderPageFeedbackNote(document.getElementById('assistant'), data, translate);
        document.body.innerHTML = document.body.innerHTML;
        renderPageFeedbackNote(document.getElementById('assistant'), data, translate);
      });
      assert.equal(await page.locator('.page-feedback-note').count(), 1);
      assert.equal(await page.locator('img').count(), 0);
      const text = await page.locator('.page-feedback-note').textContent();
      assert.equal(/password|private=value|secret=yes|#token/.test(text), false);
      assert.match(text, /Continuing/);
    } finally { await browser.close(); }
  });
}
