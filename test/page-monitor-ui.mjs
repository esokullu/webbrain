import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { CDPClient } from '../src/chrome/src/cdp/cdp-client.js';
import { pageFeedbackMethods } from '../src/chrome/src/agent/page-feedback.js';

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

async function fixture(engine, build, { runToken = 'test-run', siteIsolation = false } = {}) {
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
  await context.addInitScript({ content: read(build, 'content/page-monitor-shadow.js') });
  await context.addInitScript({ content: read(build, 'content/page-monitor.js') });
  const page = await context.newPage();
  await page.goto('https://monitor.test/start');
  await page.waitForTimeout(200);
  await page.evaluate(() => { feedback = []; });
  return { browser, context, page };
}

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

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
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

  test(`${build}: animation and extension decoration do not produce page feedback`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        feedback = [];
        const decoration = document.createElement('div'); decoration.dataset.webbrainUi = 'indicator';
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

  test(`${build}: companion native markers renew per key without hiding a later human edit`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'native-typing', tool: 'type_text', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'native-typing', kind: 'input', selector: '#field', navigationCandidate: false });
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
        deliver('page_monitor_dispatch', { operationId: 'clear-chord', kind: 'input', selector: '#field' });
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
