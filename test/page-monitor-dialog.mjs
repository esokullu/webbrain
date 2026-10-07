import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createNativeActionMarker } from '../firefox-companion/session.mjs';

const html = `<!doctype html><style>
body { margin:0;width:1000px;height:700px; }
#composer { position:absolute;left:30px;top:30px;width:450px;height:300px; }
#editor { width:300px;height:90px; }
#timeline { position:absolute;left:600px;top:30px;width:300px; }
#anonymous { position:absolute;left:600px;top:350px;width:300px; }
#anonymous-editor { width:280px;height:60px; }
</style><main id="timeline"><h2 id="timeline-heading">Following</h2><span id="counter">14</span></main>
<div id="composer" role="dialog"><button aria-label="Close">X</button><button>Drafts</button>
<button id="audience">Everyone</button>
<div id="editor" role="textbox" aria-label="Post text" contenteditable="true" data-testid="tweetTextarea_0"></div>
<button>Everyone can reply</button><nav><button>Add photos or video</button><button>Add a GIF</button></nav>
<button id="post" type="button">Post</button></div>
<div id="anonymous" role="toolbar"><div id="anonymous-editor" role="textbox" aria-label="Message" contenteditable="true"></div>
<button id="anonymous-send">Send</button></div>`;

async function fixture(browser, build, role = 'dialog') {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://monitor.test/**', route => route.fulfill({
    contentType: 'text/html', body: html.replace('role="dialog"', `role="${role}"`),
  }));
  await context.addInitScript(() => {
    window.messageListeners = [];
    const runtime = {
      onMessage: { addListener: listener => messageListeners.push(listener), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return {
          active: true, runToken: 'dialog-test', documentToken: message.documentToken,
        };
        if (message.action === 'page_feedback') return { accepted: true };
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action,
          params: { runToken: 'dialog-test', ...params } }, {}, value => { answered = true; resolve(value); });
        if (answered || asynchronous === true) break;
      }
    });
  });
  for (const file of ['accessibility-tree.js', 'page-monitor.js']) {
    await context.addInitScript({
      content: fs.readFileSync(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8'),
    });
  }
  const page = await context.newPage();
  await page.goto('https://monitor.test/compose');
  await page.waitForFunction(() => window.__wbPageMonitor?.active && window.__wb_ax_installed);
  await page.waitForTimeout(180);
  return { context, page };
}

async function capture(page) {
  return page.evaluate(async () => {
    const snapshot = await deliver('page_monitor_capture_model', { includeTree: true });
    return { ...snapshot, editorRef: __wb_ax_ref(document.getElementById('editor')),
      postRef: __wb_ax_ref(document.getElementById('post')),
      anonymousRef: __wb_ax_ref(document.getElementById('anonymous-send')) };
  });
}

async function validate(page, snapshot, target = { tool: 'type_ax', ref_id: snapshot.editorRef }) {
  return page.evaluate(({ snapshotToken, target }) => deliver('page_monitor_validate_model', {
    snapshotToken, ...target,
  }), { snapshotToken: snapshot.snapshotToken, target });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: heading-free dialogs bind their exact action context`, { timeout: 60000 }, async t => {
    const browser = await (build === 'chrome' ? chromium : firefox).launch({ headless: true });
    try {
      for (const role of ['dialog', 'alertdialog']) await t.test(`${role}: visible owner and editor are certified without a heading`, async () => {
        const { context, page } = await fixture(browser, build, role);
        try {
          await page.locator('#editor').focus();
          const snapshot = await capture(page);
          assert.equal(snapshot.ready, true);
          assert.ok(snapshot.targetCount >= 6, JSON.stringify(snapshot));
          assert.equal(snapshot.focusedTargetAvailable, true);
          assert.match(snapshot.page.pageContent, new RegExp(`\\b${role} \\[ref_`));
          assert.match(snapshot.page.pageContent, /textbox "Post text"/);
          assert.match(snapshot.page.pageContent, /button "Post"/);
          assert.equal((await validate(page, snapshot)).ready, true);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, true);
          const anonymous = await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.anonymousRef });
          assert.equal(anonymous.ready, false);
          assert.equal(anonymous.uncertified, true, 'An anonymous toolbar still lacks an entity boundary');
        } finally { await context.close(); }
      });

      await t.test('unrelated timeline counts and headings do not invalidate the dialog', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          await page.evaluate(() => {
            document.getElementById('counter').textContent = '15';
            document.getElementById('timeline-heading').textContent = 'Latest activity';
          });
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, true);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, true);
        } finally { await context.close(); }
      });

      for (const variant of ['control-display', 'control-visibility', 'reference-display', 'reference-visibility',
        'readonly-inside-display', 'readonly-inside-visibility', 'readonly-reference-display', 'readonly-reference-visibility']) {
        await t.test(`${variant}: rendered audience changes invalidate an earlier Post certificate despite identical textContent`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            const original = await page.evaluate(variant => {
              const audience = document.getElementById('audience');
              const property = variant.endsWith('visibility') ? 'visibility' : 'display';
              const labels = `<span id="alice">Alice</span><span id="bob" style="${property}:${property === 'display' ? 'none' : 'hidden'}">Bob</span>`;
              let root = audience;
              if (variant.includes('reference') || variant.startsWith('readonly')) {
                root = document.createElement('div'); root.id = 'audience-label';
                if (variant.startsWith('readonly')) {
                  root.setAttribute('role', 'textbox'); root.setAttribute('aria-readonly', 'true');
                }
                if (variant.includes('reference')) {
                  root.style.cssText = 'position:absolute;left:600px;top:500px'; document.body.append(root);
                } else {
                  root.style.cssText = 'width:180px;height:22px'; audience.before(root);
                }
                audience.setAttribute('aria-labelledby', root.id);
              }
              root.innerHTML = labels;
              return { name: __wb_ax_name(audience), text: root.textContent, editable: root.isContentEditable,
                role: root.getAttribute('role'), readonly: root.getAttribute('aria-readonly') };
            }, variant);
            await page.waitForTimeout(180);
            const snapshot = await capture(page);
            assert.equal(original.name, 'Alice');
            if (variant.startsWith('readonly')) {
              assert.equal(original.editable, false); assert.equal(original.role, 'textbox'); assert.equal(original.readonly, 'true');
            }
            assert.match(snapshot.page.pageContent, /button "Alice"/);
            assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, true);
            const changed = await page.evaluate(variant => {
              const property = variant.endsWith('visibility') ? 'visibility' : 'display';
              const alice = document.getElementById('alice'), bob = document.getElementById('bob');
              alice.style[property] = property === 'display' ? 'none' : 'hidden';
              bob.style[property] = property === 'display' ? 'inline' : 'visible';
              return { name: __wb_ax_name(document.getElementById('audience')), text: alice.parentElement.textContent };
            }, variant);
            assert.equal(changed.name, 'Bob');
            assert.equal(changed.text, original.text, 'The raw label text stays constant; only its rendered identity changed');
            await page.waitForTimeout(180);
            assert.equal((await validate(page, snapshot)).ready, false);
            assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, false);
          } finally { await context.close(); }
        });
      }

      await t.test('native input continuation tolerates its own new editable text nodes', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.locator('#editor').focus();
          const snapshot = await capture(page);
          const operationId = 'dialog-native-input';
          const prepared = await page.evaluate(params => deliver('page_monitor_prepare', params), {
            operationId, expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true, tool: 'type_text', text: 'xy',
          });
          assert.equal(prepared.modelBindingValid, true);
          const dispatched = await page.evaluate(operationId => deliver('page_monitor_dispatch', {
            operationId, kind: 'input', fenceOnly: true,
          }), operationId);
          assert.equal(dispatched.ready, true);
          let guard = dispatched.guard;
          for (const [index, key] of [...'xy'].entries()) {
            const current = await page.evaluate(guard => deliver('page_monitor_validate', { ...guard, kind: 'input' }), guard);
            assert.equal(current.ready, true, JSON.stringify(current));
            guard = { ...guard, revision: current.revision };
            const marker = createNativeActionMarker(guard, 'input', index + 1);
            await page.evaluate(marker => document.getElementById('editor').setAttribute('data-webbrain-native-action', marker), marker);
            await page.keyboard.press(key);
          }
          assert.equal(await page.locator('#editor').innerText(), 'xy');
        } finally { await context.close(); }
      });

      for (const kind of ['nested-text', 'generic-label', 'display-contents', 'open-shadow', 'separate-form', 'sidebar-identity', 'nav-control-identity', 'nav-control-shadow']) await t.test(`${kind}: uncovered destination identity stays uncertified`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(kind => {
            const destination = document.createElement('p'); destination.id = 'destination';
            if (kind === 'nested-text' || kind === 'display-contents') {
              destination.innerHTML = '<span>Replying to Alice</span>';
              if (kind === 'display-contents') destination.style.display = 'contents';
            } else if (kind === 'open-shadow') {
              destination.style.display = 'contents';
              const host = document.createElement('div'); host.style.display = 'contents';
              host.attachShadow({ mode: 'open' }).innerHTML = '<span>Replying to Alice</span>';
              destination.append(host);
            } else if (kind === 'separate-form') {
              destination.innerHTML = '<form><button type="button">Replying to Alice</button></form>';
            } else if (kind === 'sidebar-identity') {
              destination.innerHTML = '<aside><span data-recipient="Alice"></span></aside>';
            } else if (kind === 'nav-control-identity') {
              destination.innerHTML = '<nav><button><span data-recipient="Alice">Send</span></button></nav>';
            } else if (kind === 'nav-control-shadow') {
              destination.innerHTML = '<nav><button>Send</button></nav>';
              const host = document.createElement('span');
              host.attachShadow({ mode: 'open' }).innerHTML = '<span>Replying to Alice</span>';
              destination.querySelector('button').append(host);
            }
            else { destination.setAttribute('aria-label', 'Replying to Alice'); destination.style.cssText = 'width:180px;height:20px'; }
            document.getElementById('composer').prepend(destination);
          }, kind);
          await page.waitForTimeout(180);
          const snapshot = await capture(page);
          const original = await validate(page, snapshot);
          assert.equal(original.ready, false);
          assert.equal(original.uncertified, true);
          await page.evaluate(kind => {
            const destination = document.getElementById('destination');
            if (kind === 'nested-text' || kind === 'display-contents') destination.firstChild.textContent = 'Replying to Bob';
            else if (kind === 'open-shadow') destination.firstChild.shadowRoot.firstChild.textContent = 'Replying to Bob';
            else if (kind === 'separate-form') destination.querySelector('button').textContent = 'Replying to Bob';
            else if (kind === 'sidebar-identity') destination.querySelector('[data-recipient]').setAttribute('data-recipient', 'Bob');
            else if (kind === 'nav-control-identity') destination.querySelector('[data-recipient]').setAttribute('data-recipient', 'Bob');
            else if (kind === 'nav-control-shadow') destination.querySelector('button > span').shadowRoot.firstChild.textContent = 'Replying to Bob';
            else destination.setAttribute('aria-label', 'Replying to Bob');
          }, kind);
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, false);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, false);
        } finally { await context.close(); }
      });

      await t.test('a weak referenced owner label cannot establish heading-free editor coverage', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => document.getElementById('post').setAttribute('aria-describedby', 'composer'));
          await page.waitForTimeout(180);
          const snapshot = await capture(page);
          const editor = await validate(page, snapshot);
          assert.equal(editor.ready, false);
          assert.equal(editor.uncertified, true, 'An owner recorded with direct text is not a full-text label root');
        } finally { await context.close(); }
      });

      await t.test('new uncovered destination text invalidates an earlier controls-only dialog certificate', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          assert.equal((await validate(page, snapshot)).ready, true);
          await page.evaluate(() => {
            const destination = document.createElement('p'); destination.textContent = 'Replying to Bob';
            document.getElementById('composer').prepend(destination);
          });
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, false);
        } finally { await context.close(); }
      });

      for (const change of ['audience', 'control', 'dialog-label', 'dialog-replacement', 'editor-replacement']) {
        await t.test(`${change} invalidates the observed action context`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            const snapshot = await capture(page);
            await page.evaluate(change => {
              if (change === 'audience') document.getElementById('audience').textContent = 'Private circle';
              if (change === 'control') document.getElementById('post').disabled = true;
              if (change === 'dialog-label') document.getElementById('composer').setAttribute('aria-label', 'Reply to another post');
              if (change === 'dialog-replacement' || change === 'editor-replacement') {
                const node = document.getElementById(change === 'dialog-replacement' ? 'composer' : 'editor');
                node.replaceWith(node.cloneNode(true));
              }
            }, change);
            await page.waitForTimeout(180);
            assert.equal((await validate(page, snapshot)).ready, false);
            assert.equal((await validate(page, snapshot, { tool: 'type_text', selector: '#editor' })).ready, false,
              'Resolving the same selector must not transfer the original certificate to a replacement');
          } finally { await context.close(); }
        });
      }
    } finally { await browser.close(); }
  });
}

test('Chrome and Firefox dialog ownership logic stays byte-identical', () => {
  const source = build => fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8');
  assert.equal(source('chrome'), source('firefox'));
});
