import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createNativeActionMarker } from '../firefox-companion/session.mjs';

const html = `<!doctype html><style>
body { margin:0; width:900px; height:600px; }
#composer { position:absolute;left:20px;top:20px;width:300px;height:180px; }
h2 { width:250px;height:28px;margin:0; } form { width:280px;height:100px; }
#counter { position:absolute;left:500px;top:30px;width:100px;height:30px; }
#human { position:absolute;left:500px;top:100px; }
</style><section id="composer" role="region"><h2 id="recipient">Alice</h2>
<form id="form" action="/send" method="post"><label for="field">Message</label>
<input id="field" value="Prepared text"><button id="send" type="submit" aria-labelledby="send-label">Send</button></form></section>
<span id="send-label" hidden>Send</span>
<aside id="counter">100</aside><button id="human">Human control</button>`;

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://monitor.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(() => {
    window.feedback = [];
    window.messageListeners = [];
    const runtime = { onMessage: { addListener: fn => messageListeners.push(fn), removeListener: () => {} },
      async sendMessage(msg) {
        if (msg.action === 'get_page_monitor_state') return { active: true, runToken: 'passive-test', documentToken: msg.documentToken };
        if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return { accepted: true }; }
        return {};
      } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.__wb_ax_lookup = ref => document.getElementById(ref.replace(/^ref_/, ''));
    window.deliver = (action, params = {}) => new Promise(resolve => {
      for (const listener of messageListeners) listener({ target: 'content', action,
        params: { runToken: 'passive-test', ...params } }, {}, resolve);
    });
  });
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const page = await context.newPage();
  await page.goto('https://monitor.test/start');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(180);
  await page.evaluate(() => { feedback = []; });
  return { context, page };
}

async function registrationFixture(browser, build, mode = 'active') {
  const context = await browser.newContext();
  await context.route('https://registration.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Registration fixture</p>' }));
  await context.addInitScript(mode => {
    window.registrationRequests = [];
    window.registrationMode = mode;
    window.registrationListeners = [];
    const runtime = { onMessage: { addListener: listener => registrationListeners.push(listener), removeListener: () => {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') {
          registrationRequests.push(message);
          if (registrationMode === 'throw') throw new Error('Background registration failed');
          if (registrationMode === 'inactive') return { active: false };
          return { active: true, runToken: 'registration-run', documentToken: message.documentToken };
        }
        return { accepted: true };
      } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.activateMonitor = () => new Promise(resolve => {
      for (const listener of registrationListeners) listener({ target: 'content', action: 'page_monitor_state', active: true }, {}, resolve);
    });
  }, mode);
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const page = await context.newPage();
  await page.goto('https://registration.test/same-url');
  await page.waitForFunction(() => window.__wbPageMonitor && registrationRequests.length > 0);
  return { context, page };
}

async function prepare(page, boundary, extra = {}) {
  return page.evaluate(async ({ boundary, extra }) => {
    const params = { operationId: 'prepared', tool: 'click_ax', selector: '#send', allowPassiveRebase: true, ...extra };
    if (boundary === 'local') {
      window.finishOperation = __wbPageMonitor.beginContentAction('click_ax', {
        ref_id: 'ref_send', allowPassiveRebase: params.allowPassiveRebase, _bidiPrepare: true,
      });
      return null;
    }
    await deliver('page_monitor_prepare', params);
    if (boundary === 'native') {
      const response = await deliver('page_monitor_dispatch', { operationId: 'prepared', kind: 'click', fenceOnly: true });
      window.preparedGuard = response.guard;
      return response.guard;
    }
    return null;
  }, { boundary, extra });
}

async function dispatch(page, boundary) {
  return page.evaluate(async boundary => {
    try {
      if (boundary === 'message') return await deliver('page_monitor_dispatch', { operationId: 'prepared', kind: 'click', fenceOnly: true });
      if (boundary === 'native') return await deliver('page_monitor_validate', { ...preparedGuard, kind: 'click' });
      if (boundary === 'activate') return __wbPageMonitor.activatePreparedDispatch({ operationId: 'prepared', kind: 'click', element: document.getElementById('send') });
      __wbPageMonitor.beforeLocalDispatch();
      finishOperation();
      return { ready: true };
    } catch (error) { return { ready: false, code: error.code }; }
  }, boundary);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: only explicitly validated stable targets survive unrelated passive page updates`, { timeout: 60000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const boundary of ['message', 'activate', 'native', 'local']) {
        await t.test(`${boundary}: unchanged target progresses while counter feedback remains observable`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            const guard = await prepare(page, boundary);
            await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
            const result = await dispatch(page, boundary);
            assert.equal(result.ready, true);
            assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom' && event.source === 'page'),
              'The validated operation may progress, but the agent must still receive the passive update');
            if (boundary === 'native') assert.ok(result.revision > guard.revision, 'The caller receives the fresh revision for its next signed marker');
          } finally { await context.close(); }
        });
        for (const [change, mutate] of [
          ['recipient', () => { document.getElementById('recipient').textContent = 'Bob'; }],
          ['control value', () => { document.getElementById('field').value = 'Different private message'; }],
          ['node replacement', () => { const el = document.getElementById('send'); el.replaceWith(el.cloneNode(true)); }],
          ['form action', () => { document.getElementById('form').action = '/other'; }],
          ['hidden accessible label', () => { document.getElementById('send-label').textContent = 'Delete'; }],
        ]) await t.test(`${boundary}: ${change} prevents dispatch despite a matching target label`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            await prepare(page, boundary);
            await page.evaluate(mutate);
            await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
            const result = await dispatch(page, boundary);
            assert.equal(result.ready, false);
            if (boundary !== 'native') assert.equal(result.code || (result.pageFeedbackPending ? 'page_feedback_pending' : ''), 'page_feedback_pending');
          } finally { await context.close(); }
        });
      }

      for (const [name, options] of [
        ['unapproved operation', { allowPassiveRebase: false }],
        ['coordinates', { x: 185, y: 70 }],
        ['arbitrary script', { tool: 'execute_js' }],
        ['ambiguous selector', { selector: 'button' }],
        ['unresolved target', { selector: '#missing' }],
      ]) await t.test(`${name} retains the strict global revision fence`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, 'message', options);
          await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
          const result = await dispatch(page, 'message');
          assert.equal(result.ready, false);
          assert.equal(result.pageFeedbackPending, true);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['page focus theft', async page => page.locator('#field').focus()],
        ['human interaction', async page => page.locator('#human').click()],
        ['viewport change', async page => page.setViewportSize({ width: 990, height: 700 })],
        ['same-document navigation', async page => page.evaluate(() => history.pushState({}, '', '/changed'))],
        ['unknown DOM attribution', async page => page.evaluate(() => {
          __wbPageMonitor.dispatch({ operationId: 'other-operation', kind: 'dom', runToken: 'passive-test' });
          document.getElementById('counter').textContent = '101';
        })],
      ]) await t.test(`${name} cannot be rebased as passive churn`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, 'message');
          await mutate(page);
          const result = await dispatch(page, 'message');
          assert.equal(result.ready, false);
          assert.equal(result.pageFeedbackPending, true);
        } finally { await context.close(); }
      });

      await t.test('native marker uses the refreshed revision and preserves later human detection', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const guard = await prepare(page, 'native');
          await page.evaluate(() => { document.getElementById('counter').textContent = '101'; });
          const validation = await dispatch(page, 'native');
          assert.equal(validation.ready, true);
          const marker = createNativeActionMarker({ ...guard, revision: validation.revision }, 'click', 1);
          await page.evaluate(marker => { feedback = []; document.getElementById('send').setAttribute('data-webbrain-native-action', marker);
            document.getElementById('form').addEventListener('submit', event => event.preventDefault()); }, marker);
          await page.locator('#send').click();
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
          await page.locator('#human').click();
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), true);
        } finally { await context.close(); }
      });

      await t.test('long property values are compared completely rather than sampled', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => { document.getElementById('field').value = 'a'.repeat(20000); });
          await page.waitForTimeout(180);
          await prepare(page, 'message');
          await page.evaluate(() => {
            const field = document.getElementById('field');
            field.value = `${field.value.slice(0, 19998)}ba`;
            document.getElementById('counter').textContent = '101';
          });
          assert.equal((await dispatch(page, 'message')).ready, false);
          assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('a'.repeat(100)), false);
        } finally { await context.close(); }
      });

      await t.test('direct navigation can rebase passive churn without a page target', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(async () => {
            await deliver('page_monitor_prepare', { operationId: 'navigate', tool: 'navigate', allowPassiveRebase: true });
            document.getElementById('counter').textContent = '101';
          });
          const result = await page.evaluate(() => deliver('page_monitor_dispatch', { operationId: 'navigate', kind: 'navigate' }));
          assert.equal(result.ready, true);
        } finally { await context.close(); }
      });

      await t.test('local dispatch inherits approval only from the same untouched prepared target', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, 'message');
          await page.evaluate(() => {
            window.finishOperation = __wbPageMonitor.beginContentAction('click_ax', { ref_id: 'ref_send', _bidiPrepare: true });
            document.getElementById('counter').textContent = '101';
          });
          assert.equal((await dispatch(page, 'local')).ready, true);
        } finally { await context.close(); }
      });

      await t.test('local approval cannot be inherited across a physical intervention', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await prepare(page, 'message');
          await page.locator('#human').click();
          await page.evaluate(() => {
            window.finishOperation = __wbPageMonitor.beginContentAction('click_ax', { ref_id: 'ref_send', _bidiPrepare: true });
            document.getElementById('counter').textContent = '101';
          });
          assert.equal((await dispatch(page, 'local')).ready, false);
        } finally { await context.close(); }
      });

      await t.test('changing a selected file cannot preserve approval through identical file metadata', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => {
            const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.id = 'attachment';
            document.getElementById('form').append(fileInput);
            const files = new DataTransfer(); files.items.add(new File(['AAAA'], 'photo.png', { type: 'image/png', lastModified: 1 }));
            fileInput.files = files.files;
          });
          await page.waitForTimeout(180);
          await prepare(page, 'message');
          await page.evaluate(() => {
            const files = new DataTransfer(); files.items.add(new File(['BBBB'], 'photo.png', { type: 'image/png', lastModified: 1 }));
            document.getElementById('attachment').files = files.files;
            document.getElementById('counter').textContent = '101';
          });
          assert.equal((await dispatch(page, 'message')).ready, false);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: monitor registration acknowledgment proves current document ownership`, { timeout: 30000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      await t.test('successful registration returns the active document and run tokens', async () => {
        const { context, page } = await registrationFixture(browser, build);
        try {
          const acknowledgment = await page.evaluate(() => activateMonitor());
          const requestedToken = await page.evaluate(() => registrationRequests.at(-1).documentToken);
          assert.equal(acknowledgment.ready, true);
          assert.equal(acknowledgment.active, true);
          assert.equal(acknowledgment.documentToken, requestedToken);
          assert.equal(acknowledgment.runToken, 'registration-run');
          assert.ok(acknowledgment.documentToken);
          assert.equal(await page.evaluate(() => __wbPageMonitor.active), true);
        } finally { await context.close(); }
      });

      for (const mode of ['inactive', 'throw']) for (const previouslyActive of [false, true]) await t.test(`${mode} background registration (${previouslyActive ? 'previously active' : 'new document'}) cannot acknowledge active ownership`, async () => {
        const { context, page } = await registrationFixture(browser, build, previouslyActive ? 'active' : mode);
        try {
          if (previouslyActive) {
            assert.equal((await page.evaluate(() => activateMonitor())).active, true);
            await page.evaluate(value => { registrationMode = value; }, mode);
          }
          const acknowledgment = await page.evaluate(() => activateMonitor());
          assert.equal(acknowledgment.ready, true);
          assert.equal(acknowledgment.active, false);
          assert.notEqual(acknowledgment.runToken, 'registration-run');
          assert.equal(await page.evaluate(() => __wbPageMonitor.active), false);
        } finally { await context.close(); }
      });

      await t.test('reloading the same URL returns a fresh document token', async () => {
        const { context, page } = await registrationFixture(browser, build);
        try {
          const previous = await page.evaluate(() => activateMonitor());
          await page.reload();
          await page.waitForFunction(() => window.__wbPageMonitor && registrationRequests.length > 0);
          const current = await page.evaluate(() => activateMonitor());
          assert.equal(current.active, true);
          assert.equal(current.runToken, previous.runToken);
          assert.notEqual(current.documentToken, previous.documentToken);
          assert.equal(current.documentToken, await page.evaluate(() => registrationRequests.at(-1).documentToken));
          assert.equal(page.url(), 'https://registration.test/same-url');
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

test('Chrome and Firefox passive preparation validation stay byte-identical', () => {
  assert.equal(
    fs.readFileSync(new URL('../src/chrome/src/content/page-monitor.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/firefox/src/content/page-monitor.js', import.meta.url), 'utf8'),
  );
});
