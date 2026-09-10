#!/usr/bin/env node
// Fixtures runner for v4.0.1 overlay defenses.
//
// Loads fixture HTML in Chromium, plus targeted Firefox-engine regressions,
// injects the matching build's content.js with a stubbed extension runtime,
// and drives tools through the message handler. Asserts on response shape +
// which DOM element actually received the interaction.
//
// No LLM, no API keys, no real sites — just deterministic regression checks
// for _findTopmostModal scoping, the occlusion hit-test, and the rich
// ambiguity payload.
//
// Run: npm run test:fixtures

import { chromium, firefox as playwrightFirefox } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../../src/firefox/src/agent/agent.js';
import { CDPClient, cdpClient } from '../../src/chrome/src/cdp/cdp-client.js';
import {
  SELECTION_SHORTCUT_LOCALES,
  getSelectionShortcutLocalization,
} from '../../src/chrome/src/selection-shortcut-i18n.js';
import { registerRichTextToolbarFixtures } from './rich-text-toolbar.mjs';
import { registerMessageRecipientNavigationFixtures } from './message-recipient-navigation.mjs';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const accessibilityTreeJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'accessibility-tree.js');
const firefoxAccessibilityTreeJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'accessibility-tree.js');
const contentJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'content.js');
const firefoxContentJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'content.js');
// content.js delegates the toolbar heuristic to this module, which the
// manifests load immediately before it. Fixtures must mirror that order or
// every candidate scores null.
const toolbarHeuristicJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'rich-text-toolbar-heuristic.js');
const firefoxToolbarHeuristicJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'rich-text-toolbar-heuristic.js');

// cdp-client normally reads this file through chrome.runtime.getURL, which
// does not exist here. Feed it the same source the content scripts get so the
// main-world probe scores identically under test.
CDPClient._heuristicSourceOverride = await readFile(toolbarHeuristicJsPath, 'utf-8');
const redactionRegionsJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'redaction-regions.js');
const firefoxRedactionRegionsJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'redaction-regions.js');
const filePickerGuardPageJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'file-picker-guard-page.js');
const firefoxFilePickerGuardPageJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'file-picker-guard-page.js');
const selectionShortcutJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'selection-shortcut.js');
const firefoxSelectionShortcutJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'selection-shortcut.js');
const smdJsPath = path.join(root, 'src', 'chrome', 'src', 'agent', 'social-media-downloader.js');
const selectionShortcutLocalizations = Object.fromEntries(
  SELECTION_SHORTCUT_LOCALES.map((locale) => [locale, getSelectionShortcutLocalization(locale)]),
);

function fixtureUrl(name) {
  return 'file://' + path.join(__dirname, name);
}

// Stub enough of `chrome.runtime` for content.js to register its handler
// without throwing. We capture the handler on window.__wb_handler.
const stubChrome = `
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.runtime.onMessage = {
    addListener: (fn) => { window.__wb_handler = fn; }
  };
`;

const stubFirefoxBrowser = `
  window.browser = window.browser || {};
  window.browser.runtime = window.browser.runtime || {};
  window.browser.runtime.getURL = (path) => path;
  window.browser.runtime.onMessage = {
    addListener: (fn) => { window.__wb_handler = fn; }
  };
`;

async function setup(page, fixture) {
  await page.addInitScript(stubChrome);
  await page.goto(fixtureUrl(fixture));
  const axSrc = await readFile(accessibilityTreeJsPath, 'utf-8');
  await page.addScriptTag({ content: axSrc });
  await page.addScriptTag({ content: await readFile(toolbarHeuristicJsPath, 'utf-8') });
  const src = await readFile(contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  // Ensure handler is registered.
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupContentFixture(page, fixture, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.addInitScript(firefox ? stubFirefoxBrowser : stubChrome);
  await page.goto(fixtureUrl(fixture));
  const axSrc = await readFile(firefox ? firefoxAccessibilityTreeJsPath : accessibilityTreeJsPath, 'utf-8');
  await page.addScriptTag({ content: axSrc });
  await page.addScriptTag({ content: await readFile(firefox ? firefoxToolbarHeuristicJsPath : toolbarHeuristicJsPath, 'utf-8') });
  const contentSrc = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  await page.addScriptTag({ content: contentSrc });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupContentHtml(page, html, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const pageGuardSrc = await readFile(
    firefox ? firefoxFilePickerGuardPageJsPath : filePickerGuardPageJsPath,
    'utf-8',
  );
  await page.addScriptTag({ content: pageGuardSrc });
  // Simulate manifest injection followed by extension-reload recovery.
  await page.addScriptTag({ content: pageGuardSrc });
  await page.addScriptTag({ content: firefox ? stubFirefoxBrowser : stubChrome });
  await page.addScriptTag({
    content: await readFile(firefox ? firefoxAccessibilityTreeJsPath : accessibilityTreeJsPath, 'utf-8'),
  });
  await page.addScriptTag({ content: await readFile(firefox ? firefoxToolbarHeuristicJsPath : toolbarHeuristicJsPath, 'utf-8') });
  const src = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupIsolatedContentHtml(page, html, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const pageGuardSrc = await readFile(
    firefox ? firefoxFilePickerGuardPageJsPath : filePickerGuardPageJsPath,
    'utf-8',
  );
  await page.addScriptTag({ content: pageGuardSrc });
  // Simulate recovery reinjection while keeping the content world separate.
  await page.addScriptTag({ content: pageGuardSrc });

  const session = await page.context().newCDPSession(page);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  const frameTree = await session.send('Page.getFrameTree');
  const isolatedWorld = await session.send('Page.createIsolatedWorld', {
    frameId: frameTree.frameTree.frame.id,
    worldName: `webbrain-${browserKind}-fixture`,
  });
  const contextId = isolatedWorld.executionContextId;
  const contentSrc = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  const heuristicSrc = await readFile(firefox ? firefoxToolbarHeuristicJsPath : toolbarHeuristicJsPath, 'utf-8');
  const injected = await session.send('Runtime.evaluate', {
    contextId,
    expression: `${firefox ? stubFirefoxBrowser : stubChrome}\n${heuristicSrc}\n${contentSrc}`,
    awaitPromise: true,
  });
  if (injected.exceptionDetails) {
    throw new Error(`isolated content injection failed: ${injected.exceptionDetails.text}`);
  }

  const rawIsolatedCall = async (action, params) => {
    const message = JSON.stringify({ target: 'content', action, params });
    const evaluated = await session.send('Runtime.evaluate', {
      contextId,
      expression: `new Promise((resolve) => {
        const ret = window.__wb_handler(${message}, {}, (resp) => resolve(resp));
        if (ret !== true && ret !== undefined) resolve(ret);
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(`isolated content call failed: ${evaluated.exceptionDetails.text}`);
    }
    return evaluated.result.value;
  };

  return async (action, params) => {
    const response = await rawIsolatedCall(action, params);
    const guardId = response?._filePickerGuardId;
    if (!guardId) return response;

    const originalResponse = { ...response };
    delete originalResponse._filePickerGuardId;
    await page.waitForTimeout(525);
    let settled = await rawIsolatedCall('consume_file_picker_guard', { guardId });
    if (settled?.settled === false) {
      await page.waitForTimeout(50);
      settled = await rawIsolatedCall('consume_file_picker_guard', { guardId });
    }
    if (!settled?.filePickerBlocked) return originalResponse;

    const blockedResponse = { ...settled };
    delete blockedResponse.settled;
    return {
      ...blockedResponse,
      ...(originalResponse.rect ? { rect: originalResponse.rect } : {}),
      ...(originalResponse.ref_id ? { ref_id: originalResponse.ref_id } : {}),
    };
  };
}

async function setupFirefoxHtml(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: stubFirefoxBrowser });
  await page.addScriptTag({ content: await readFile(firefoxToolbarHeuristicJsPath, 'utf-8') });
  const src = await readFile(firefoxContentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupChromeHtml(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: stubChrome });
  await page.addScriptTag({ content: await readFile(toolbarHeuristicJsPath, 'utf-8') });
  const src = await readFile(contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupAccessibilityTreeHtml(page, html, sourcePath) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__generateAccessibilityTree === 'function');
}

async function setupAccessibilityTreeGmailHtml(page, html, sourcePath) {
  await page.route('https://mail.google.com/**', route => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ body: html, contentType: 'text/html' });
    }
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.goto('https://mail.google.com/mail/u/0/#inbox/FMfc123', { waitUntil: 'domcontentloaded' });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__generateAccessibilityTree === 'function');
}

async function setupContentGmailHtml(page, html, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.route('https://mail.google.com/**', route => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ body: html, contentType: 'text/html' });
    }
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.addInitScript(firefox ? stubFirefoxBrowser : stubChrome);
  await page.goto('https://mail.google.com/mail/u/0/#inbox/FMfc123', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({
    content: await readFile(firefox ? firefoxAccessibilityTreeJsPath : accessibilityTreeJsPath, 'utf-8'),
  });
  await page.addScriptTag({
    content: await readFile(firefox ? firefoxToolbarHeuristicJsPath : toolbarHeuristicJsPath, 'utf-8'),
  });
  await page.addScriptTag({
    content: await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8'),
  });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function rawContentCall(page, action, params) {
  return page.evaluate(({ action, params }) => new Promise((resolve) => {
    const ret = window.__wb_handler(
      { target: 'content', action, params },
      {},
      (resp) => resolve(resp),
    );
    if (ret !== true && ret !== undefined) resolve(ret);
  }), { action, params });
}

async function call(page, action, params) {
  const response = await rawContentCall(page, action, params);
  const guardId = response?._filePickerGuardId;
  if (!guardId) return response;

  const originalResponse = { ...response };
  delete originalResponse._filePickerGuardId;
  await page.waitForTimeout(525);
  let settled = await rawContentCall(page, 'consume_file_picker_guard', { guardId });
  if (settled?.settled === false) {
    await page.waitForTimeout(50);
    settled = await rawContentCall(page, 'consume_file_picker_guard', { guardId });
  }
  if (!settled?.filePickerBlocked) return originalResponse;

  const blockedResponse = { ...settled };
  delete blockedResponse.settled;
  return {
    ...blockedResponse,
    ...(originalResponse.rect ? { rect: originalResponse.rect } : {}),
    ...(originalResponse.ref_id ? { ref_id: originalResponse.ref_id } : {}),
  };
}

async function readThroughCdpMirror(page, opts = {}) {
  const client = new CDPClient();
  client.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });
  return client.readPage(1, opts);
}

async function clickedSentinel(page) {
  return page.evaluate(() => window.__clicked);
}

async function setupSmd(page, url, html) {
  const u = new URL(url);
  await page.route(`${u.origin}/**`, route => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ body: html, contentType: 'text/html' });
    }
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const src = await readFile(smdJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.SocialMediaDownloader === 'object');
}

async function collectSmd(page, mode = 'auto') {
  return page.evaluate((m) => {
    const r = window.SocialMediaDownloader._collect(m);
    return { urls: r.urls, mode: r.mode, profile: r.profile.name };
  }, mode);
}

async function setupSelectionShortcut(page, sourcePath, { enabled = true, requiresManualOpen = false, locale = 'en' } = {}) {
  await page.setViewportSize({ width: 360, height: 280 });
  await page.setContent(`<!doctype html>
    <style>body{margin:0;font:18px/1.5 sans-serif} #copy{position:absolute;right:2px;bottom:2px;width:210px}</style>
    <p id="copy">Selected words near the viewport edge for WebBrain.</p>
    <div id="editor" contenteditable="true">Editable selection text.</div>`);
  await page.addScriptTag({ content: `
    window.__selectionMessages = [];
    window.__selectionStorage = { selectionShortcutEnabled: ${enabled ? 'true' : 'false'}, wbLocale: '${locale}' };
    window.__selectionLocalizations = ${JSON.stringify(selectionShortcutLocalizations)};
    window.__selectionRuntimeListeners = [];
    window.__selectionStorageListeners = [];
    window.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === 'WB_SELECTION_SHORTCUT_LOCALIZATION') {
            const locale = String(message.locale || 'en').toLowerCase().split('-')[0];
            return { ok: true, ...(window.__selectionLocalizations[locale] || window.__selectionLocalizations.en) };
          }
          window.__selectionMessages.push(message);
          return { ok: true, queued: true, requiresManualOpen: ${requiresManualOpen ? 'true' : 'false'} };
        },
        onMessage: { addListener: (listener) => window.__selectionRuntimeListeners.push(listener) }
      },
      storage: {
        local: {
          get: async (defaults) => ({ ...defaults, ...window.__selectionStorage }),
          set: async (update) => {
            const changes = {};
            for (const [key, value] of Object.entries(update)) {
              changes[key] = { oldValue: window.__selectionStorage[key], newValue: value };
              window.__selectionStorage[key] = value;
            }
            window.__selectionStorageListeners.forEach((listener) => listener(changes, 'local'));
          }
        },
        onChanged: { addListener: (listener) => window.__selectionStorageListeners.push(listener) }
      }
    };
    window.__setSelectionShortcutEnabled = async (value) => {
      await window.chrome.storage.local.set({ selectionShortcutEnabled: value });
    };
    window.__setSelectionShortcutLocale = async (value) => {
      await window.chrome.storage.local.set({ wbLocale: value });
    };
    window.__sendSelectionRuntimeMessage = (message) => {
      window.__selectionRuntimeListeners.forEach((listener) => listener(message, {}, () => {}));
    };
  ` });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__webbrainSelectionShortcut?.getState === 'function');
}

async function selectFixtureText(page, selector = '#copy') {
  await page.evaluate(async (targetSelector) => {
    const target = document.querySelector(targetSelector);
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, selector);
  await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().shortcutVisible);
  await page.waitForTimeout(20);
  return page.evaluate(() => window.__webbrainSelectionShortcut.getState());
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('expired content messages are rejected before page mutation in both builds', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <button id="late-action" onclick="window.__lateActionClicks = (window.__lateActionClicks || 0) + 1">Late action</button>
    `, browserKind);
    const response = await page.evaluate(() => new Promise((resolve) => {
      window.__wb_handler({
        target: 'content',
        action: 'click',
        params: { selector: '#late-action' },
        actionDeadlineAt: Date.now() - 1,
      }, {}, resolve);
    }));
    const clicks = await page.evaluate(() => window.__lateActionClicks || 0);
    if (
      response?.success !== false
      || response.dispatched !== false
      || response.noDispatch !== true
      || response.deadlineExpired !== true
      || clicks !== 0
    ) {
      throw new Error(`${browserKind} expired content message mutated the page: ${JSON.stringify({ response, clicks })}`);
    }
  }
});

test('set_field cannot submit after its page-action deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <form id="deadline-form">
        <input id="deadline-field" aria-label="Deadline field">
      </form>
      <script>
        window.__deadlineSubmits = 0;
        document.getElementById('deadline-form').addEventListener('submit', event => {
          event.preventDefault();
          window.__deadlineSubmits += 1;
        });
      </script>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const refId = window.__wb_ax_ref(document.getElementById('deadline-field'));
      window.__wb_handler({
        target: 'content',
        action: 'set_field',
        params: { ref_id: refId, text: 'typed before expiry', submit: true },
        actionDeadlineAt: Date.now() + 20,
      }, {}, response => resolve({
        response,
        value: document.getElementById('deadline-field').value,
        submits: window.__deadlineSubmits,
      }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.submitted !== false
      || result.response.dispatched !== true
      || result.value !== 'typed before expiry'
      || result.submits !== 0
    ) {
      throw new Error(`${browserKind} set_field submitted after expiry: ${JSON.stringify(result)}`);
    }
  }
});

test('set_field stops before mutation when focus handlers cross the deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <input id="late-set-field" aria-label="Late set field">
      <script>
        document.getElementById('late-set-field').addEventListener('focus', () => {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
        });
      </script>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const field = document.getElementById('late-set-field');
      const refId = window.__wb_ax_ref(field);
      window.__wb_handler({
        target: 'content',
        action: 'set_field',
        params: { ref_id: refId, text: 'must not appear' },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({ response, value: field.value }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.value !== ''
    ) {
      throw new Error(`${browserKind} set_field crossed its mutation deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('set_field releases Enter when a keydown listener crosses the deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <input id="deadline-key-field" aria-label="Deadline key field">
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const field = document.getElementById('deadline-key-field');
      window.__deadlineKeydowns = 0;
      window.__deadlineKeyups = 0;
      window.__deadlineKeyTimes = {};
      field.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        window.__deadlineKeydowns += 1;
        window.__deadlineKeyTimes.keydownStart = Date.now();
        const stopAt = performance.now() + 650;
        while (performance.now() < stopAt) {}
        window.__deadlineKeyTimes.keydownEnd = Date.now();
      });
      field.addEventListener('keyup', event => {
        if (event.key === 'Enter') window.__deadlineKeyups += 1;
      });
      const refId = window.__wb_ax_ref(field);
      const startedAt = Date.now();
      const deadlineAt = startedAt + 500;
      window.__wb_handler({
        target: 'content',
        action: 'set_field',
        params: { ref_id: refId, text: 'typed before key dispatch', submit: true },
        actionDeadlineAt: deadlineAt,
      }, {}, response => {
        resolve({
          response,
          startedAt,
          deadlineAt,
          completedAt: Date.now(),
          keyTimes: window.__deadlineKeyTimes,
          keydowns: window.__deadlineKeydowns,
          keyups: window.__deadlineKeyups,
        });
      });
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== true
      || result.response.outcomeUnknown !== true
      || result.response.retryable !== false
      || result.keydowns !== 1
      || result.keyups !== 1
    ) {
      throw new Error(`${browserKind} set_field left Enter pressed after expiry: ${JSON.stringify(result)}`);
    }
  }
});

test('Firefox synthetic hover reports a deadline crossed by its last listener', async (page) => {
  await setupContentHtml(page, `
    <button id="deadline-hover">Hover target</button>
    <script>
      window.__deadlineMousemoves = 0;
      document.getElementById('deadline-hover').addEventListener('mousemove', () => {
        window.__deadlineMousemoves += 1;
        const stopAt = Date.now() + 150;
        while (Date.now() < stopAt) {}
      });
    </script>
  `, 'firefox');
  const result = await page.evaluate(() => new Promise((resolve) => {
    const target = document.getElementById('deadline-hover');
    window.__wb_handler({
      target: 'content',
      action: 'hover',
      params: { ref_id: window.__wb_ax_ref(target) },
      actionDeadlineAt: Date.now() + 100,
    }, {}, response => resolve({ response, moves: window.__deadlineMousemoves }));
  }));
  if (
    result.response?.success !== false
    || result.response.deadlineExpired !== true
    || result.response.dispatched !== true
    || result.response.outcomeUnknown !== true
    || result.moves !== 1
  ) {
    throw new Error(`firefox hover hid its last-listener deadline: ${JSON.stringify(result)}`);
  }
});

test('Firefox synthetic drag releases a held pointer after expiry', async (page) => {
  await setupContentHtml(page, `
    <button id="deadline-drag-from">Drag source</button>
    <button id="deadline-drag-to">Drag target</button>
    <script>
      window.__deadlinePointerdowns = 0;
      window.__deadlinePointerups = 0;
      document.getElementById('deadline-drag-from').addEventListener('pointerdown', () => {
        window.__deadlinePointerdowns += 1;
        const stopAt = Date.now() + 450;
        while (Date.now() < stopAt) {}
      });
      document.getElementById('deadline-drag-to').addEventListener('pointerup', () => {
        window.__deadlinePointerups += 1;
      });
    </script>
  `, 'firefox');
  const result = await page.evaluate(() => new Promise((resolve) => {
    const from = document.getElementById('deadline-drag-from');
    const to = document.getElementById('deadline-drag-to');
    window.__wb_handler({
      target: 'content',
      action: 'drag_drop',
      params: {
        fromRefId: window.__wb_ax_ref(from),
        toRefId: window.__wb_ax_ref(to),
        steps: 2,
      },
      actionDeadlineAt: Date.now() + 300,
    }, {}, response => resolve({
      response,
      pointerdowns: window.__deadlinePointerdowns,
      pointerups: window.__deadlinePointerups,
    }));
  }));
  if (
    result.response?.success !== false
    || result.response.deadlineExpired !== true
    || result.response.dispatched !== true
    || result.response.outcomeUnknown !== true
    || result.pointerdowns !== 1
    || result.pointerups !== 1
  ) {
    throw new Error(`firefox drag left the pointer held after expiry: ${JSON.stringify(result)}`);
  }
});

test('click_ax rechecks its page-action deadline at the click boundary', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <div id="slow-context"><button id="late-click">Late click</button></div>
      <script>
        window.__lateAxClicks = 0;
        document.getElementById('late-click').addEventListener('click', () => { window.__lateAxClicks += 1; });
        Object.defineProperty(document.getElementById('slow-context'), 'innerText', {
          configurable: true,
          get() {
            const stopAt = Date.now() + 30;
            while (Date.now() < stopAt) {}
            return 'Slow click context';
          },
        });
      </script>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const refId = window.__wb_ax_ref(document.getElementById('late-click'));
      window.__wb_handler({
        target: 'content',
        action: 'click_ax',
        params: { ref_id: refId },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({ response, clicks: window.__lateAxClicks }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.clicks !== 0
    ) {
      throw new Error(`${browserKind} click_ax crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('press_keys rechecks its deadline after recipient validation', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <style>
        #recipient { position: fixed; top: 20px; left: 320px; width: 240px; height: 32px; }
        #composer { position: fixed; bottom: 20px; left: 280px; width: 360px; height: 80px; }
      </style>
      <h1 id="recipient">Alice</h1>
      <textarea id="composer" aria-label="Message composer"></textarea>
    `, browserKind);
    const binding = await page.evaluate(() => new Promise((resolve) => {
      const composer = document.getElementById('composer');
      composer.focus();
      window.__wb_handler({
        target: 'content',
        action: 'probe_message_recipient_guard',
        params: {
          tool: 'press_keys',
          args: { key: 'Enter' },
          bindDispatch: true,
        },
      }, {}, response => resolve(response?.messageRecipientDispatchBinding || null));
    }));
    if (!binding?.token) {
      throw new Error(`${browserKind} could not prepare the recipient-bound key fixture`);
    }
    const result = await page.evaluate((messageRecipientDispatchBinding) => new Promise((resolve) => {
      const composer = document.getElementById('composer');
      const recipient = document.getElementById('recipient');
      window.__recipientBoundKeyEvents = 0;
      composer.addEventListener('keydown', () => { window.__recipientBoundKeyEvents += 1; });
      composer.addEventListener('keyup', () => { window.__recipientBoundKeyEvents += 1; });
      Object.defineProperty(recipient, 'innerText', {
        configurable: true,
        get() {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
          return 'Alice';
        },
      });
      window.__wb_handler({
        target: 'content',
        action: 'press_keys',
        params: {
          key: 'Enter',
          messageRecipientGuardRequired: true,
          messageRecipientDispatchBinding,
        },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({
        response,
        keyEvents: window.__recipientBoundKeyEvents,
      }));
    }), binding);
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.keyEvents !== 0
    ) {
      throw new Error(`${browserKind} recipient-bound key crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('click rechecks its deadline after recipient validation', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <style>
        #recipient { position: fixed; top: 20px; left: 320px; width: 240px; height: 32px; }
        #message-form { position: fixed; bottom: 20px; left: 280px; width: 460px; height: 90px; }
        #composer { width: 360px; height: 80px; }
        #send { width: 70px; height: 40px; }
      </style>
      <h1 id="recipient">Alice</h1>
      <form id="message-form">
        <textarea id="composer" aria-label="Message composer"></textarea>
        <button id="send" type="button">Send</button>
      </form>
      <script>
        window.__recipientBoundClicks = 0;
        document.getElementById('send').addEventListener('click', () => { window.__recipientBoundClicks += 1; });
      </script>
    `, browserKind);
    const binding = await page.evaluate(() => new Promise((resolve) => {
      document.getElementById('composer').focus();
      window.__wb_handler({
        target: 'content',
        action: 'probe_message_recipient_guard',
        params: {
          tool: 'click',
          args: { selector: '#send' },
          bindDispatch: true,
        },
      }, {}, response => resolve(response?.messageRecipientDispatchBinding || null));
    }));
    if (!binding?.token) {
      throw new Error(`${browserKind} could not prepare the recipient-bound click fixture`);
    }
    const result = await page.evaluate((messageRecipientDispatchBinding) => new Promise((resolve) => {
      const recipient = document.getElementById('recipient');
      Object.defineProperty(recipient, 'innerText', {
        configurable: true,
        get() {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
          return 'Alice';
        },
      });
      window.__wb_handler({
        target: 'content',
        action: 'click',
        params: {
          selector: '#send',
          messageRecipientGuardRequired: true,
          messageRecipientDispatchBinding,
        },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({
        response,
        clicks: window.__recipientBoundClicks,
      }));
    }), binding);
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.clicks !== 0
    ) {
      throw new Error(`${browserKind} recipient-bound click crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('fallback typing stops when focus handlers cross the deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <input id="late-type" aria-label="Late type field">
      <script>
        document.getElementById('late-type').addEventListener('focus', () => {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
        });
      </script>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      window.__wb_handler({
        target: 'content',
        action: 'type',
        params: { selector: '#late-type', text: 'must not appear' },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({
        response,
        value: document.getElementById('late-type').value,
      }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.value !== ''
    ) {
      throw new Error(`${browserKind} fallback typing crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});

test('fallback scrolling stops when target scans cross the deadline', async (page) => {
  for (const browserKind of ['chrome', 'firefox']) {
    await setupContentHtml(page, `
      <style>
        html, body { margin: 0; height: 100%; overflow: hidden; }
        #scroller { width: 300px; height: 120px; overflow-y: auto; }
        #scroll-content { height: 1000px; }
      </style>
      <div id="scroller"><div id="scroll-content">Scrollable content</div></div>
    `, browserKind);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const scroller = document.getElementById('scroller');
      const refId = window.__wb_ax_ref(document.getElementById('scroll-content'));
      const nativeGetComputedStyle = window.getComputedStyle.bind(window);
      window.getComputedStyle = (element, ...args) => {
        if (element === scroller) {
          const stopAt = Date.now() + 30;
          while (Date.now() < stopAt) {}
        }
        return nativeGetComputedStyle(element, ...args);
      };
      window.__wb_handler({
        target: 'content',
        action: 'scroll',
        params: { ref_id: refId, direction: 'down', amount: 100 },
        actionDeadlineAt: Date.now() + 5,
      }, {}, response => resolve({ response, scrollTop: scroller.scrollTop }));
    }));
    if (
      result.response?.success !== false
      || result.response.deadlineExpired !== true
      || result.response.dispatched !== false
      || result.response.noDispatch !== true
      || result.response.retryable !== true
      || result.scrollTop !== 0
    ) {
      throw new Error(`${browserKind} fallback scroll crossed its deadline: ${JSON.stringify(result)}`);
    }
  }
});
const firefoxTests = [];
function firefoxTest(name, fn) { firefoxTests.push({ name, fn }); }

test('exact iframe rect handshake distinguishes same-URL sibling frames', async (page) => {
  for (const [browserKind, sourcePath] of [
    ['chrome', redactionRegionsJsPath],
    ['firefox', firefoxRedactionRegionsJsPath],
  ]) {
    await page.setContent(`<!doctype html>
      <style>
        body { margin: 0; height: 1200px; }
        #first { position: absolute; top: 180px; left: 100px; width: 300px; height: 180px; border: 0; }
      </style>
      <iframe id="first" srcdoc="<input>"></iframe>
      <div id="shadow-host"></div>
      <script>
        (() => {
          const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
          root.innerHTML = '<iframe id="second" style="position:absolute;top:180px;left:600px;width:300px;height:180px;border:0" srcdoc="<input>"></iframe>';
        })();
      </script>`);
    await page.waitForFunction(() => {
      const first = document.getElementById('first');
      const second = document.getElementById('shadow-host')?.shadowRoot?.getElementById('second');
      return !!first?.contentWindow && !!second?.contentWindow;
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => window.scrollTo(0, 100));
    const runtimeStub = browserKind === 'firefox' ? `
      window.browser = window.browser || {};
      window.browser.runtime = {
        onMessage: { addListener: fn => { window.__redaction_handler = fn; } }
      };` : `
      window.chrome = window.chrome || {};
      window.chrome.runtime = {
        onMessage: { addListener: fn => { window.__redaction_handler = fn; } }
      };`;
    const source = await readFile(sourcePath, 'utf-8');
    for (const frame of page.frames()) {
      await frame.addScriptTag({ content: runtimeStub });
      await frame.addScriptTag({ content: source });
    }
    const childFrames = page.frames().filter(frame => frame !== page.mainFrame());
    if (childFrames.length !== 2) throw new Error(`${browserKind}: expected two child frames, got ${childFrames.length}`);
    const shadowChildFrame = (await Promise.all(childFrames.map(async frame => ({
      frame,
      id: await frame.evaluate(() => window.frameElement?.id || ''),
    })))).find(entry => entry.id === 'second')?.frame;
    if (!shadowChildFrame) throw new Error(`${browserKind}: shadow child frame was not reachable`);
    const token = `fixture-${browserKind}-${Date.now()}`;
    const parentWait = page.evaluate(probeToken => new Promise(resolve => {
      const keepAlive = window.__redaction_handler({
        target: 'redaction-content',
        action: 'wait_for_exact_child_frame_rect',
        params: { token: probeToken },
      }, {}, resolve);
      if (keepAlive !== true) resolve({ found: false, keepAlive });
    }), token);
    await new Promise(resolve => setTimeout(resolve, 10));
    const announced = await shadowChildFrame.evaluate(probeToken => new Promise(resolve => {
      window.__redaction_handler({
        target: 'redaction-content',
        action: 'announce_exact_child_frame',
        params: { token: probeToken },
      }, {}, resolve);
    }), token);
    const exact = await parentWait;
    if (
      announced?.announced !== true
      || exact?.found !== true
      || Math.round(exact.outerRect?.x) !== 600
      || Math.round(exact.outerRect?.y) !== 80
      || Math.round(exact.outerRect?.pageY) !== 180
    ) {
      throw new Error(`${browserKind}: expected exact shadow-frame geometry, got: ${JSON.stringify({ announced, exact })}`);
    }
  }
});

for (const [label, browserKind] of [['Chrome', 'chrome'], ['Firefox', 'firefox']]) {
  test(`${label}: type_text verifies after controlled field reconciliation`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <input id="controlled" value="requested content already">
      <textarea id="accepted"></textarea>
      <script>
        const controlled = document.getElementById('controlled');
        controlled.addEventListener('input', () => {
          setTimeout(() => { controlled.value = 'requested content alreadY'; }, 0);
        });
      </script>`, browserKind);
    const rejected = await call(page, 'type', {
      selector: '#controlled',
      text: 'requested content',
      clear: false,
    });
    // Controlled reformatting is exactly the case that must not be reported as
    // a failed action: the edit dispatched, the page rewrote the value, so the
    // exact-match proof cannot pass. Unproven is signalled by omitting
    // `verified`, never by setting it false.
    if (rejected?.success !== true || 'verified' in (rejected || {})) {
      throw new Error(`controlled normalization without the requested insertion must be unproven, not refuted: ${JSON.stringify(rejected)}`);
    }
    const accepted = await call(page, 'type', {
      selector: '#accepted',
      text: 'requested content',
      clear: true,
    });
    if (accepted?.success !== true || accepted?.verified !== true) {
      throw new Error(`persisted text must be verified: ${JSON.stringify(accepted)}`);
    }
  });
}

for (const [label, browserKind] of [['Chrome', 'chrome'], ['Firefox', 'firefox']]) {
  test(`${label}: blocking NYTimes registration dialog suppresses article DOM`, async (page) => {
    await setupContentFixture(page, 'nyt-registration-gate.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.blocking !== true || result.pageGate?.surface !== 'dialog' || result.pageGate?.type !== 'registration') {
      throw new Error(`registration pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    const serializedResult = JSON.stringify(result);
    if (result.textSource !== 'page-gate' || /SECRET_NYT_(?:ARTICLE|LINK|IMAGE|FORM|SHADOW)/.test(serializedResult)) {
      throw new Error(`blocked article data leaked: ${serializedResult}`);
    }
    if (result.links?.length || result.forms?.length || result.shadowDOM?.length || result.iframes?.length || result.media?.imageCount || result.media?.videoCount) {
      throw new Error(`blocking gate retained auxiliary page data: ${serializedResult}`);
    }
    if (JSON.stringify(result).indexOf('"pageGate"') > JSON.stringify(result).indexOf('"text"')) {
      throw new Error('pageGate must serialize before long article text for trace visibility');
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (tree.pageGate?.blocking !== true || !/Create a free account/i.test(tree.pageGate.label || '')) {
      throw new Error(`accessibility tree omitted structured pageGate: ${JSON.stringify(tree.pageGate)}`);
    }
    if (tree.textSource !== 'page-gate' || /SECRET_NYT_ARTICLE_BODY/.test(tree.pageContent || '')) {
      throw new Error(`accessibility tree leaked blocked article text: ${JSON.stringify(tree)}`);
    }
    const gateButtonRef = /button "Continue" \[(ref_\d+)\]/.exec(tree.pageContent || '')?.[1];
    const gateEmailRef = /textbox "Email" \[(ref_\d+)\]/.exec(tree.pageContent || '')?.[1];
    if (!gateButtonRef || !gateEmailRef) {
      throw new Error(`accessibility tree omitted visible gate controls: ${JSON.stringify(tree)}`);
    }
    const clickResult = await call(page, 'click_ax', { ref_id: gateButtonRef });
    const gateControlClicked = await page.evaluate(() => window.__gateControlClicked === true);
    if (clickResult?.success !== true || !gateControlClicked) {
      throw new Error(`gate control ref was not actionable: ${JSON.stringify(clickResult)}`);
    }
    const basicResult = await call(page, 'get_page_info', {});
    if (/SECRET_NYT_(?:ARTICLE|LINK|IMAGE|FORM|SHADOW)/.test(JSON.stringify(basicResult))) {
      throw new Error(`basic page info leaked blocked article data: ${JSON.stringify(basicResult)}`);
    }
  });

  test(`${label}: The Athletic covering subscription overlay suppresses server-rendered body`, async (page) => {
    await setupContentFixture(page, 'athletic-subscription-overlay.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog') {
      throw new Error(`Athletic pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (/SECRET_ATHLETIC_(?:ARTICLE|LINK|FORM)/.test(JSON.stringify(result)) || result.textSource !== 'page-gate') {
      throw new Error(`Athletic article data leaked: ${JSON.stringify(result)}`);
    }
  });

  test(`${label}: inline article gate returns only the visible preview`, async (page) => {
    await setupContentFixture(page, 'inline-article-paywall.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.blocking !== true || result.pageGate?.surface !== 'inline') {
      throw new Error(`inline pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (!/VISIBLE_PREVIEW_PARAGRAPH/.test(result.text || '') || /SECRET_POST_GATE_PARAGRAPH/.test(result.text || '')) {
      throw new Error(`inline preview boundary mismatch: ${JSON.stringify(result.text)}`);
    }
    if (!/\(pre-gate\)$/.test(result.textSource || '')) {
      throw new Error(`inline textSource missing pre-gate marker: ${result.textSource}`);
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (!/VISIBLE_PREVIEW_PARAGRAPH/.test(tree.pageContent || '') || /SECRET_POST_GATE_PARAGRAPH/.test(tree.pageContent || '')) {
      throw new Error(`inline accessibility boundary mismatch: ${JSON.stringify(tree)}`);
    }
  });

  test(`${label}: readable article ignores header controls, inline upsells, and hidden gate markup`, async (page) => {
    await setupContentFixture(page, 'readable-article-no-gate.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate) throw new Error(`false-positive pageGate: ${JSON.stringify(result.pageGate)}`);
    if (!/READABLE_ARTICLE_BODY/.test(result.text || '') || !/READABLE_ARTICLE_AFTER_UPSELL/.test(result.text || '') || result.textSource === 'page-gate') {
      throw new Error(`readable article body missing: ${JSON.stringify({ textSource: result.textSource, text: result.text })}`);
    }
  });

  test(`${label}: non-article signup dialog preserves form controls`, async (page) => {
    await setupContentFixture(page, 'non-article-signup-dialog.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate) throw new Error(`non-article dialog became a page gate: ${JSON.stringify(result.pageGate)}`);
    if (result.forms?.length !== 1 || result.forms[0]?.inputs?.[0]?.name !== 'email') {
      throw new Error(`signup form was stripped from page info: ${JSON.stringify(result.forms)}`);
    }
    const basicResult = await call(page, 'get_page_info', {});
    if (basicResult.pageGate || basicResult.forms?.length !== 1) {
      throw new Error(`basic page info stripped the signup form: ${JSON.stringify(basicResult)}`);
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 6 });
    if (tree.pageGate || !/Work email/.test(tree.pageContent || '')) {
      throw new Error(`signup accessibility tree was stripped: ${JSON.stringify(tree)}`);
    }
  });
}

test('Chrome CDP mirror suppresses a blocking Athletic article body', async (page) => {
  await page.goto(fixtureUrl('athletic-subscription-overlay.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog') {
    throw new Error(`CDP pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
  }
  if (result.textSource !== 'page-gate' || /SECRET_ATHLETIC_(?:ARTICLE|LINK|FORM)/.test(JSON.stringify(result))) {
    throw new Error(`CDP mirror leaked blocked article data: ${JSON.stringify(result)}`);
  }
  if (result.links?.length || result.forms?.length || result.shadowHosts?.length || result.iframes?.length) {
    throw new Error(`CDP blocking gate retained auxiliary page data: ${JSON.stringify(result)}`);
  }
});

test('Chrome CDP mirror preserves a readable article across an inline upsell', async (page) => {
  await page.goto(fixtureUrl('readable-article-no-gate.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate || !/READABLE_ARTICLE_BODY/.test(result.text || '') || !/READABLE_ARTICLE_AFTER_UPSELL/.test(result.text || '')) {
    throw new Error(`CDP readable article mismatch: ${JSON.stringify({ pageGate: result.pageGate, text: result.text })}`);
  }
});

test('Chrome CDP mirror preserves a non-article signup dialog', async (page) => {
  await page.goto(fixtureUrl('non-article-signup-dialog.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate || result.forms?.length !== 1 || result.forms[0]?.inputs?.[0]?.name !== 'email') {
    throw new Error(`CDP non-article signup mismatch: ${JSON.stringify(result)}`);
  }
});

for (const [label, sourcePath, manualOpen] of [
  ['Chrome', selectionShortcutJsPath, false],
  ['Firefox', firefoxSelectionShortcutJsPath, true],
]) {
  test(`${label}: selection shortcut localizes labels, direction, and fixed-action language`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, locale: 'zh' });
    const localized = await selectFixtureText(page);
    if (localized.summarizeLabel !== '总结'
        || localized.explainLabel !== '解释'
        || localized.quizLabel !== '测验我'
        || localized.actionIconCount !== 6
        || localized.direction !== 'ltr') {
      throw new Error(`Chinese shortcut localization mismatch: ${JSON.stringify(localized)}`);
    }

    await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('explain'));
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const submitted = await page.evaluate(() => window.__selectionMessages[0]);
    if (submitted.action !== 'explain'
        || submitted.language !== 'zh'
        || Object.prototype.hasOwnProperty.call(submitted, 'includePageContext')) {
      throw new Error(`fixed action did not carry the Chinese interface language: ${JSON.stringify(submitted)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('ar'));
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().direction === 'rtl');
    const rtl = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (rtl.summarizeLabel !== 'تلخيص' || rtl.actionIconCount !== 6) {
      throw new Error(`live Arabic localization mismatch: ${JSON.stringify(rtl)}`);
    }
  });

  test(`${label}: custom selection questions default to page context and retain a scoped choice`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen, locale: 'zh' });
    const initial = await selectFixtureText(page);
    if (!initial.includePageContextChecked
        || initial.includePageContextLabel !== '包含页面和对话上下文'
        || initial.hideLabel !== '隐藏此项') {
      throw new Error(`full-context choice should be localized and on by default: ${JSON.stringify(initial)}`);
    }
    await page.evaluate(() => {
      window.__webbrainSelectionShortcut.setIncludePageContext(false);
      return window.__webbrainSelectionShortcut.submitCustom('仅根据选中内容回答。');
    });
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const submitted = await page.evaluate(() => window.__selectionMessages[0]);
    if (submitted.action !== 'custom'
        || submitted.question !== '仅根据选中内容回答。'
        || submitted.includePageContext !== false) {
      throw new Error(`custom question lost its explicit scoped-context choice: ${JSON.stringify(submitted)}`);
    }

    await page.waitForFunction(() => !window.__webbrainSelectionShortcut.getState().submitting);
    const nextSelection = await selectFixtureText(page);
    if (!nextSelection.includePageContextChecked) {
      throw new Error(`a new selection should restore the default-on page-context choice: ${JSON.stringify(nextSelection)}`);
    }
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitCustom('现在有哪些跨平台框架？'));
    await page.waitForFunction(() => window.__selectionMessages.length === 2);
    const submittedAgain = await page.evaluate(() => window.__selectionMessages[1]);
    if (submittedAgain.action !== 'custom'
        || submittedAgain.question !== '现在有哪些跨平台框架？'
        || submittedAgain.includePageContext !== true) {
      throw new Error(`the default custom question did not request page and conversation context: ${JSON.stringify(submittedAgain)}`);
    }
  });

  test(`${label}: selection shortcut clamps to the viewport and supports keyboard dismissal`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const state = await selectFixtureText(page);
    const rect = state.shortcutRect;
    if (!rect || rect.left < 8 || rect.top < 8 || rect.right > 352 || rect.bottom > 272) {
      throw new Error(`shortcut was not clamped to the viewport: ${JSON.stringify(rect)}`);
    }
    if (!state.selectionRect || rect.bottom > state.selectionRect.top) {
      throw new Error(`shortcut should prefer the top of the selected text: ${JSON.stringify(state)}`);
    }
    if (state.shortcutLabel !== 'Ask WebBrain about this'
        || state.shortcutBackground !== 'rgb(255, 255, 255)'
        || state.shortcutColor !== 'rgb(108, 99, 255)'
        || state.shortcutBoxShadow === 'none') {
      throw new Error(`shortcut should retain its purple selected-text treatment: ${JSON.stringify(state)}`);
    }
    await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
    let popupState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!popupState.popupVisible) throw new Error('popup did not open for the selected text');
    await page.keyboard.press('Escape');
    popupState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (popupState.popupVisible || !popupState.shortcutVisible) {
      throw new Error(`Escape should close the popup and retain the shortcut: ${JSON.stringify(popupState)}`);
    }

    await page.evaluate(() => {
      const topCopy = document.createElement('p');
      topCopy.id = 'top-copy';
      topCopy.style.cssText = 'position:absolute;left:74px;top:2px;width:210px;margin:0';
      topCopy.textContent = 'A multiline selection near the top edge must keep the shortcut below every selected line.';
      document.body.appendChild(topCopy);
    });
    const topState = await selectFixtureText(page, '#top-copy');
    if (!topState.selectionRect
        || topState.selectionRect.top >= 52
        || !topState.selectionBottom
        || topState.shortcutRect.top < topState.selectionBottom + 7) {
      throw new Error(`top-edge fallback should clear the full visible selection: ${JSON.stringify(topState)}`);
    }
  });

  test(`${label}: selection dialog contains page shortcuts and keeps the selected text highlighted`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionPageKeys = [];
      window.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`window-capture:${event.key}`), true);
      document.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`document-capture:${event.key}`), true);
      document.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`down:${event.key}`));
      document.addEventListener('keypress', (event) => window.__selectionPageKeys.push(`press:${event.key}`));
      document.addEventListener('keyup', (event) => window.__selectionPageKeys.push(`up:${event.key}`));
    });
    const selectedState = await selectFixtureText(page);
    await page.mouse.click(
      selectedState.shortcutRect.left + selectedState.shortcutRect.width / 2,
      selectedState.shortcutRect.top + selectedState.shortcutRect.height / 2,
    );
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!openState.questionRect || openState.highlightRectCount < 1) {
      throw new Error(`popup should preserve a visual marker for the selected text: ${JSON.stringify(openState)}`);
    }
    if (!openState.hideRect
        || openState.hideLabel !== 'Hide this'
        || openState.hideRect.width >= openState.translateRect.width
        || Math.abs(openState.hideRect.right - openState.translateRect.right) > 0.5) {
      throw new Error(`Hide this should be a compact right-aligned footer action: ${JSON.stringify(openState)}`);
    }
    await page.mouse.click(
      openState.questionRect.left + openState.questionRect.width / 2,
      openState.questionRect.top + openState.questionRect.height / 2,
    );
    await page.keyboard.type('j');
    const typedState = await page.evaluate(() => ({
      surface: window.__webbrainSelectionShortcut.getState(),
      pageKeys: window.__selectionPageKeys,
    }));
    if (typedState.surface.questionValue !== 'j' || typedState.surface.highlightRectCount < 1) {
      throw new Error(`typing should keep the custom question and sticky highlight: ${JSON.stringify(typedState)}`);
    }
    if (typedState.pageKeys.length) {
      throw new Error(`dialog keystrokes leaked to the page: ${JSON.stringify(typedState.pageKeys)}`);
    }
    await page.keyboard.press('Escape');
    const closedState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (closedState.popupVisible || closedState.highlightRectCount !== 0) {
      throw new Error(`closing the popup should remove the sticky highlight: ${JSON.stringify(closedState)}`);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().popupVisible);
    const reopenedState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    await page.mouse.click(
      reopenedState.questionRect.left + reopenedState.questionRect.width / 2,
      reopenedState.questionRect.top + reopenedState.questionRect.height / 2,
    );
    await page.keyboard.type('What is the point?');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const submittedState = await page.evaluate(() => ({
      message: window.__selectionMessages[0],
      surface: window.__webbrainSelectionShortcut.getState(),
      pageKeys: window.__selectionPageKeys,
    }));
    if (submittedState.message.action !== 'custom' || submittedState.message.question !== 'What is the point?') {
      throw new Error(`capture-phase containment broke keyboard submission: ${JSON.stringify(submittedState)}`);
    }
    if (submittedState.surface.popupVisible || submittedState.surface.highlightRectCount !== 0) {
      throw new Error(`keyboard submission should dismiss the surface and highlight: ${JSON.stringify(submittedState)}`);
    }
    if (submittedState.pageKeys.length) {
      throw new Error(`capture-phase dialog keystrokes leaked to the page: ${JSON.stringify(submittedState.pageKeys)}`);
    }
  });

  test(`${label}: selection highlight stays bounded for long documents`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const rawRectCount = await page.evaluate(() => {
      const article = document.createElement('article');
      article.id = 'long-selection';
      for (let index = 0; index < 600; index += 1) {
        const line = document.createElement('div');
        line.textContent = `Selected article line ${index + 1}`;
        article.appendChild(line);
      }
      document.body.appendChild(article);
      const range = document.createRange();
      range.selectNodeContents(article);
      return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).length;
    });
    if (rawRectCount <= 200) throw new Error(`fixture should create more than 200 selection rectangles, got ${rawRectCount}`);

    const selectedState = await selectFixtureText(page, '#long-selection');
    await page.mouse.click(
      selectedState.shortcutRect.left + selectedState.shortcutRect.width / 2,
      selectedState.shortcutRect.top + selectedState.shortcutRect.height / 2,
    );
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (openState.highlightRectCount < 1 || openState.highlightRectCount > 200) {
      throw new Error(`long selections should render 1-200 highlight rectangles: ${JSON.stringify(openState)}`);
    }
    if (openState.highlightRectCount >= rawRectCount) {
      throw new Error(`offscreen selection rectangles should not all render: ${JSON.stringify({ rawRectCount, openState })}`);
    }
  });

  test(`${label}: selection shortcut submits once and dismisses before delivery`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const selectedState = await selectFixtureText(page, '#editor');
    const shortcutRect = selectedState.shortcutRect;
    await page.mouse.click(shortcutRect.left + shortcutRect.width / 2, shortcutRect.top + shortcutRect.height / 2);
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const summarizeRect = openState.summarizeRect;
    if (!summarizeRect) throw new Error('Summarize action was not visible after opening the popup');
    await page.mouse.click(summarizeRect.left + summarizeRect.width / 2, summarizeRect.top + summarizeRect.height / 2);
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
    const result = await page.evaluate(() => ({
      messages: window.__selectionMessages,
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (result.messages.length !== 1) throw new Error(`expected exactly one submission, got ${result.messages.length}`);
    if (result.messages[0].action !== 'summarize' || !/Editable selection text/.test(result.messages[0].selectionText)) {
      throw new Error(`unexpected selection request: ${JSON.stringify(result.messages[0])}`);
    }
    if (result.messages[0].language !== 'en') {
      throw new Error(`fixed action did not carry the interface language: ${JSON.stringify(result.messages[0])}`);
    }
    if (result.state.shortcutVisible || result.state.popupVisible) {
      throw new Error(`surface should dismiss before delivery: ${JSON.stringify(result.state)}`);
    }

    await selectFixtureText(page);
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitCustom('   '));
    let messages = await page.evaluate(() => window.__selectionMessages.length);
    if (messages !== 1) throw new Error('blank custom questions should not submit');
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitCustom('What is the point?'));
    messages = await page.evaluate(() => window.__selectionMessages);
    if (messages.length !== 2 || messages[1].action !== 'custom' || messages[1].question !== 'What is the point?') {
      throw new Error(`custom question was not submitted correctly: ${JSON.stringify(messages)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('tr'));
    const translationSelection = await selectFixtureText(page);
    const translationShortcutRect = translationSelection.shortcutRect;
    await page.mouse.click(
      translationShortcutRect.left + translationShortcutRect.width / 2,
      translationShortcutRect.top + translationShortcutRect.height / 2,
    );
    const translateState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const translateRect = translateState.translateRect;
    if (!translateRect) throw new Error('Translate action was not visible in the popup');
    await page.mouse.click(translateRect.left + translateRect.width / 2, translateRect.top + translateRect.height / 2);
    await page.waitForFunction(() => window.__selectionMessages.length === 3);
    const translated = await page.evaluate(() => ({
      message: window.__selectionMessages[2],
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (translated.message.action !== 'translate' || translated.message.language !== 'tr') {
      throw new Error(`translation request was not submitted correctly: ${JSON.stringify(translated.message)}`);
    }
    if (translated.state.popupVisible || translated.state.shortcutVisible) {
      throw new Error(`Translate should submit directly and dismiss the surface: ${JSON.stringify(translated.state)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('fr'));
    const updatedLocaleSelection = await selectFixtureText(page);
    const updatedLocaleShortcutRect = updatedLocaleSelection.shortcutRect;
    await page.mouse.click(
      updatedLocaleShortcutRect.left + updatedLocaleShortcutRect.width / 2,
      updatedLocaleShortcutRect.top + updatedLocaleShortcutRect.height / 2,
    );
    const updatedLocaleState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    await page.mouse.click(
      updatedLocaleState.translateRect.left + updatedLocaleState.translateRect.width / 2,
      updatedLocaleState.translateRect.top + updatedLocaleState.translateRect.height / 2,
    );
    await page.waitForFunction(() => window.__selectionMessages.length === 4);
    const updatedLocaleMessage = await page.evaluate(() => window.__selectionMessages[3]);
    if (updatedLocaleMessage.action !== 'translate' || updatedLocaleMessage.language !== 'fr') {
      throw new Error(`Translate did not follow the updated plugin locale: ${JSON.stringify(updatedLocaleMessage)}`);
    }
  });

  test(`${label}: selection shortcut persists hiding and suppresses screenshot-time UI`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await selectFixtureText(page);
    if (manualOpen) {
      await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
      const toastState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
      if (!toastState.toastVisible) throw new Error(`manual-open guidance toast was not visible: ${JSON.stringify(toastState)}`);
    }
    await page.evaluate(() => window.__sendSelectionRuntimeMessage({ type: 'WB_HIDE_FOR_TOOL_USE' }));
    let state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!state.suppressed || state.shortcutVisible || state.toastVisible) {
      throw new Error(`tool-use hide should suppress the complete surface: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => window.__sendSelectionRuntimeMessage({ type: 'WB_SHOW_AFTER_TOOL_USE' }));
    await selectFixtureText(page);
    await page.evaluate(() => window.__webbrainSelectionShortcut.hideShortcut());
    let stored = await page.evaluate(() => window.__selectionStorage.selectionShortcutEnabled);
    if (stored !== false) throw new Error('Hide selection shortcut did not persist false');

    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.waitForTimeout(20);
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (state.shortcutVisible) throw new Error('disabled shortcut reappeared after selection');

    await page.evaluate(() => window.__setSelectionShortcutEnabled(true));
    state = await selectFixtureText(page);
    stored = await page.evaluate(() => window.__selectionStorage.selectionShortcutEnabled);
    if (stored !== true || !state.shortcutVisible) throw new Error('settings re-enable did not restore future shortcut detection');
  });
}

const gmailComposeRecipientFixture = `<!doctype html>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    [role="dialog"] { width: 620px; min-height: 360px; padding: 16px; }
    .recipient { width: 500px; height: 40px; }
    .field { display: block; width: 500px; height: 32px; margin-top: 8px; }
    .body { width: 500px; height: 160px; margin-top: 8px; }
    .hidden-to { position: absolute; width: 0; height: 0; opacity: 0; }
    .hidden-wrapper { display: none; }
  </style>
  <div role="dialog" aria-label="Compose: New Message">
    <div role="region" aria-label="New Message">
      <input class="hidden-to" role="combobox" aria-label="To recipients">
      <div class="recipient" tabindex="1">
        <span>Alex Russell (gmail.com)</span>
        <span style="display:none">Hidden stale recipient</span>
        <span style="opacity:0">Opacity hidden override</span>
        <span style="position:absolute;left:-10000px;width:200px">Offscreen hidden override</span>
        <span aria-hidden="true">ARIA hidden override</span>
      </div>
      <input class="field" aria-label="Subject" placeholder="Subject">
      <div class="body" role="textbox" contenteditable="true" aria-label="Message Body"></div>
      <div class="composite" tabindex="0"><span>Composite controls</span><button>Remove</button></div>
      <div class="hidden-wrapper" tabindex="0"><span>Hidden wrapper text</span></div>
      <div class="empty" tabindex="0"><span></span></div>
      <div class="overlong" tabindex="0"><span>${'x'.repeat(101)}</span></div>
    </div>
  </div>`;

let chromeGmailComposeTree = '';

function normalizeTreeRefs(content) {
  const refs = new Map();
  return String(content || '').replace(/ref_\d+/g, ref => {
    if (!refs.has(ref)) refs.set(ref, `ref_${refs.size + 1}`);
    return refs.get(ref);
  });
}

function normalizeTreeRevision(content) {
  return String(content || '').replace(/fnv1a64:[0-9a-f]{16}/g, 'tree_revision');
}

function assertGmailComposeRecipientTree(tree, label) {
  const content = String(tree?.pageContent || '');
  if (!/generic "Alex Russell \(gmail\.com\)" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: selected recipient label missing from visible tree: ${content}`);
  }
  if (!/textbox "Subject" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: Subject missing from visible tree: ${content}`);
  }
  if (!/textbox "Message Body" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: Message Body missing from visible tree: ${content}`);
  }
  for (const forbidden of ['To recipients', 'Hidden stale recipient', 'Opacity hidden override', 'Offscreen hidden override', 'ARIA hidden override', 'Hidden wrapper text', 'generic "Composite controls', 'x'.repeat(101)]) {
    if (content.includes(forbidden)) throw new Error(`${label}: tree promoted forbidden generic text: ${forbidden}`);
  }
  return normalizeTreeRefs(content);
}

test('accessibility tree (Chrome): existing Gmail compose exposes the selected recipient chip', async (page) => {
  await setupAccessibilityTreeHtml(page, gmailComposeRecipientFixture, accessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('visible', 10, null, null, 1));
  chromeGmailComposeTree = assertGmailComposeRecipientTree(tree, 'chrome');
});

test('accessibility tree (Firefox): existing Gmail compose exposes the selected recipient chip with parity', async (page) => {
  await setupAccessibilityTreeHtml(page, gmailComposeRecipientFixture, firefoxAccessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('visible', 10, null, null, 1));
  const firefoxTree = assertGmailComposeRecipientTree(tree, 'firefox');
  if (firefoxTree !== chromeGmailComposeTree) throw new Error('Chrome/Firefox Gmail compose trees differ');
});

const longConversationFixture = `<!doctype html>
  <main aria-label="Project conversation">
    ${Array.from({ length: 90 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      return `<article aria-label="Message ${number} from Sender ${number}: project status, decisions, owners, dates, risks, dependencies, and requested follow-up"></article>`;
    }).join('')}
  </main>`;

let chromeLongConversationPages = [];

async function readAllConversationTreePages(page, sourcePath, label) {
  await setupAccessibilityTreeHtml(page, longConversationFixture, sourcePath);
  const pages = [];
  let args = { filter: 'all' };
  for (let guard = 0; guard < 20; guard += 1) {
    const result = await page.evaluate(current => window.__generateAccessibilityTree(
      current.filter,
      current.maxDepth,
      current.maxChars,
      null,
      current.page,
      current.tree_revision,
    ), args);
    if (JSON.stringify(result).length > 8000) {
      throw new Error(`${label}: structured accessibility page exceeded the model-facing tool cap`);
    }
    pages.push(result);
    if (!result.hasMore) break;
    const expected = {
      filter: 'all',
      maxDepth: 15,
      maxChars: 6000,
      page: pages.length + 1,
    };
    if (JSON.stringify(result.continuationArgs) !== JSON.stringify(expected)) {
      throw new Error(`${label}: continuation args drifted: ${JSON.stringify(result.continuationArgs)}`);
    }
    args = result.continuationArgs;
  }

  if (pages.length < 2) throw new Error(`${label}: long conversation was not paged`);
  if (pages.at(-1)?.hasMore !== false || pages.at(-1)?.continuationArgs !== null) {
    throw new Error(`${label}: final conversation page retained a stale continuation`);
  }
  const combined = pages.map(result => result.pageContent).join('\n');
  if (!combined.includes('Message 001 from Sender 001')) throw new Error(`${label}: first message missing after paging`);
  if (!combined.includes('Message 090 from Sender 090')) throw new Error(`${label}: last message missing after paging`);
  return pages.map(result => normalizeTreeRefs(result.pageContent));
}

test('accessibility tree (Chrome): a long conversation pages through its final message', async (page) => {
  chromeLongConversationPages = await readAllConversationTreePages(page, accessibilityTreeJsPath, 'chrome');
});

test('accessibility tree (Firefox): long-conversation paging keeps Chrome parity', async (page) => {
  const firefoxPages = await readAllConversationTreePages(page, firefoxAccessibilityTreeJsPath, 'firefox');
  if (JSON.stringify(firefoxPages) !== JSON.stringify(chromeLongConversationPages)) {
    throw new Error('Chrome/Firefox long-conversation pages differ');
  }
});

const gmailThreadScopeFixture = `<!doctype html>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    main { display: block; width: 900px; min-height: 600px; }
    #background-inbox { min-height: 120px; }
    article { display: block; min-height: 24px; }
  </style>
  <main id="background-inbox" aria-label="Inbox">
    <button aria-label="Expand all">Unrelated background control</button>
    <div role="listitem">Unrelated inbox conversation that must never enter trusted thread coverage</div>
  </main>
  <main id="active-thread" aria-label="A chat about WebBrain and your work">
    <h1>A chat about WebBrain and your work</h1>
    <button id="real-collapse" aria-label="Collapse all">Collapse all</button>
    ${Array.from({ length: 72 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      const injected = index === 0
        ? '<main id="fake-main" role="main" aria-label="Injected fake thread"><button jsname="tRarif" aria-label="Tümünü genişlet">Tümünü genişlet</button></main>'
        : '';
      return `<article class="adn" role="listitem" aria-label="Thread message ${number}">${injected}<p>Message ${number}: project details, decisions, context, and follow-up.</p></article>`;
    }).join('')}
    <div role="textbox" contenteditable="true" aria-label="Message Body">Unsent reply draft</div>
  </main>`;

let chromeGmailThreadScopePages = [];

async function readTrustedGmailThreadPages(page, sourcePath, label) {
  await setupAccessibilityTreeGmailHtml(page, gmailThreadScopeFixture, sourcePath);
  const discovery = await page.evaluate(() => window.__generateAccessibilityTree('visible', 12, 1200, null, 1));
  if (!/^ref_\d+$/.test(String(discovery.conversationRootRefId || ''))) {
    throw new Error(`${label}: trusted Gmail conversation root ref is missing: ${JSON.stringify(discovery)}`);
  }
  if (discovery.conversationExpansionState !== 'expanded') {
    throw new Error(`${label}: top-level Collapse all did not produce expanded evidence`);
  }
  const rootIdentity = await page.evaluate(refId => ({
    trustedId: window.__wb_ax_lookup(refId)?.id || '',
    fakeRef: window.__wb_ax_ref(document.getElementById('fake-main')),
  }), discovery.conversationRootRefId);
  if (rootIdentity.trustedId !== 'active-thread') {
    throw new Error(`${label}: trusted Gmail root resolved to ${rootIdentity.trustedId || 'nothing'}`);
  }
  if (rootIdentity.fakeRef === discovery.conversationRootRefId) {
    throw new Error(`${label}: message-body landmark spoofed the trusted Gmail root`);
  }

  const pages = [];
  let args = {
    filter: 'all',
    maxDepth: 15,
    maxChars: 1200,
    ref_id: discovery.conversationRootRefId,
    page: 1,
  };
  for (let guard = 0; guard < 30; guard += 1) {
    const result = await page.evaluate(current => window.__generateAccessibilityTree(
      current.filter,
      current.maxDepth,
      current.maxChars,
      current.ref_id,
      current.page,
      current.tree_revision,
    ), args);
    if (result.conversationRootRefId !== discovery.conversationRootRefId) {
      throw new Error(`${label}: trusted Gmail root drifted during pagination`);
    }
    pages.push(result);
    if (!result.hasMore) break;
    const expected = {
      filter: args.filter,
      maxDepth: args.maxDepth,
      maxChars: args.maxChars,
      ref_id: args.ref_id,
      tree_revision: result.treeRevision,
      page: args.page + 1,
    };
    if (JSON.stringify(result.continuationArgs) !== JSON.stringify(expected)) {
      throw new Error(`${label}: Gmail thread continuation lost its trusted anchor: ${JSON.stringify(result.continuationArgs)}`);
    }
    args = result.continuationArgs;
  }
  if (pages.length < 2 || pages.at(-1)?.hasMore !== false) {
    throw new Error(`${label}: trusted Gmail thread did not reach a terminal page`);
  }
  const combined = pages.map(result => result.pageContent).join('\n');
  if (!combined.includes('Message 001') || !combined.includes('Message 072')) {
    throw new Error(`${label}: trusted Gmail pagination lost thread messages`);
  }
  if (combined.includes('Unrelated inbox conversation')) {
    throw new Error(`${label}: trusted Gmail pagination leaked the background inbox`);
  }

  const snapshotContinuation = await page.evaluate(continuation => {
    const message = document.querySelector('#active-thread article p');
    const previous = message.textContent;
    message.textContent = previous.replace('project', 'product');
    const result = window.__generateAccessibilityTree(
      continuation.filter,
      continuation.maxDepth,
      continuation.maxChars,
      continuation.ref_id,
      continuation.page,
      continuation.tree_revision,
    );
    message.textContent = previous;
    return result;
  }, pages[0].continuationArgs);
  if (snapshotContinuation.treeRevisionMismatch || snapshotContinuation.error
      || snapshotContinuation.treeRevision !== pages[0].treeRevision) {
    throw new Error(`${label}: live Gmail mutations invalidated the bounded page-one snapshot`);
  }

  const actionableDrift = await page.evaluate(continuation => {
    const control = document.getElementById('real-collapse');
    const previous = control.getAttribute('aria-label');
    control.setAttribute('aria-label', 'Delete permanently');
    const result = window.__generateAccessibilityTree(
      continuation.filter,
      continuation.maxDepth,
      continuation.maxChars,
      continuation.ref_id,
      continuation.page,
      continuation.tree_revision,
    );
    control.setAttribute('aria-label', previous);
    return result;
  }, pages[0].continuationArgs);
  if (actionableDrift.treeRevisionMismatch !== true || !actionableDrift.error
      || actionableDrift.pageContent) {
    throw new Error(`${label}: a changed Gmail action reused a stale cached ref`);
  }

  const revisionMismatch = await page.evaluate(continuation => {
    window.__wbAxTreeSnapshots.clear();
    const message = document.querySelector('#active-thread article p');
    const previous = message.textContent;
    message.textContent = previous.replace('project', 'product');
    const result = window.__generateAccessibilityTree(
      continuation.filter,
      continuation.maxDepth,
      continuation.maxChars,
      continuation.ref_id,
      continuation.page,
      continuation.tree_revision,
    );
    message.textContent = previous;
    return result;
  }, pages[0].continuationArgs);
  if (revisionMismatch.treeRevisionMismatch !== true || !revisionMismatch.error || revisionMismatch.pageContent) {
    throw new Error(`${label}: an expired Gmail snapshot did not reject a changed live continuation`);
  }
  const expectedRestartArgs = {
    filter: 'all',
    maxDepth: 15,
    maxChars: 1200,
    ref_id: discovery.conversationRootRefId,
    page: 1,
  };
  if (JSON.stringify(revisionMismatch.continuationArgs) !== JSON.stringify(expectedRestartArgs)
      || revisionMismatch.nextPage !== 1) {
    throw new Error(`${label}: revision recovery did not return exact page-one restart arguments`);
  }

  const restartedPageOne = await page.evaluate(args => window.__generateAccessibilityTree(
    args.filter,
    args.maxDepth,
    args.maxChars,
    args.ref_id,
    1,
    'fnv1a64:0000000000000000',
  ), expectedRestartArgs);
  if (restartedPageOne.error || restartedPageOne.treeRevisionMismatch || !restartedPageOne.pageContent
      || restartedPageOne.page !== 1) {
    throw new Error(`${label}: stale revision was not ignored while establishing a fresh page-one snapshot`);
  }

  const subtreeRecovery = await page.evaluate(() => {
    const subtree = document.createElement('section');
    subtree.setAttribute('aria-label', 'Paginated message subtree');
    for (let index = 1; index <= 30; index += 1) {
      const paragraph = document.createElement('p');
      paragraph.textContent = `Subtree message ${index}: original details and follow-up context.`;
      subtree.append(paragraph);
    }
    document.getElementById('active-thread').append(subtree);
    const refId = window.__wb_ax_ref(subtree);
    const first = window.__generateAccessibilityTree('all', 15, 220, refId, 1);
    subtree.querySelector('p').textContent = 'Subtree message 1: changed details and follow-up context.';
    const continuation = first.continuationArgs || {};
    const second = window.__generateAccessibilityTree(
      continuation.filter,
      continuation.maxDepth,
      continuation.maxChars,
      continuation.ref_id,
      continuation.page,
      continuation.tree_revision,
    );
    subtree.remove();
    return {
      refId,
      firstHasMore: first.hasMore,
      mismatch: second.treeRevisionMismatch,
      error: second.error || '',
      pageContent: second.pageContent,
      nextPage: second.nextPage,
      continuationArgs: second.continuationArgs,
    };
  });
  if (subtreeRecovery.firstHasMore !== true || subtreeRecovery.mismatch !== true
      || !subtreeRecovery.error || subtreeRecovery.pageContent) {
    throw new Error(`${label}: a changed non-root subtree reused a stale cached page`);
  }
  const expectedSubtreeRestart = {
    filter: 'all',
    maxDepth: 15,
    maxChars: 220,
    ref_id: subtreeRecovery.refId,
    page: 1,
  };
  if (JSON.stringify(subtreeRecovery.continuationArgs) !== JSON.stringify(expectedSubtreeRestart)
      || subtreeRecovery.nextPage !== 1) {
    throw new Error(`${label}: non-root recovery widened to the Gmail conversation root`);
  }

  const routeClassification = await page.evaluate(() => {
    const classify = hash => {
      window.history.replaceState(null, '', hash);
      const result = window.__generateAccessibilityTree('visible', 12, 1200, null, 1);
      return {
        hasRoot: !!result.conversationRootRefId,
        expansionState: result.conversationExpansionState || null,
      };
    };
    const results = {
      searchList: classify('#search/project'),
      labelList: classify('#label/Work'),
      categoryList: classify('#category/promotions'),
      searchHexList: classify('#search/deadbeefcafe'),
      labelHexList: classify('#label/deadbeefcafe'),
      categoryHexList: classify('#category/deadbeefcafe'),
      nestedLabelHexList: classify('#label/Projects/deadbeefcafe'),
      searchThread: classify('#search/project/FMfc123'),
      labelThread: classify('#label/Work/FMfc123'),
      categoryThread: classify('#category/promotions/FMfc123'),
      inboxLegacyThread: classify('#inbox/deadbeefcafe'),
      searchLegacyThread: classify('#search/project/deadbeefcafe'),
      nestedLabelThread: classify('#label/Projects/Subproject/FMfc123'),
    };
    window.history.replaceState(null, '', '#inbox/FMfc123');
    return results;
  });
  for (const routeName of ['searchList', 'labelList', 'categoryList', 'searchHexList', 'labelHexList', 'categoryHexList', 'nestedLabelHexList']) {
    if (routeClassification[routeName].hasRoot || routeClassification[routeName].expansionState != null) {
      throw new Error(`${label}: Gmail ${routeName} exposed trusted conversation metadata`);
    }
  }
  for (const routeName of ['searchThread', 'labelThread', 'categoryThread', 'inboxLegacyThread', 'searchLegacyThread', 'nestedLabelThread']) {
    if (!routeClassification[routeName].hasRoot || routeClassification[routeName].expansionState !== 'expanded') {
      throw new Error(`${label}: Gmail ${routeName} lost trusted conversation metadata`);
    }
  }

  const spoofOnlyExpansion = await page.evaluate(() => {
    document.getElementById('real-collapse').remove();
    return window.__generateAccessibilityTree('visible', 12, 1200, null, 1);
  });
  if (spoofOnlyExpansion.conversationExpansionState != null) {
    throw new Error(`${label}: message-body Expand all spoofed expansion evidence`);
  }
  const detachedRootRead = await page.evaluate(() => {
    const current = window.__generateAccessibilityTree('visible', 12, 1200, null, 1);
    document.getElementById('active-thread').remove();
    return window.__generateAccessibilityTree('all', 15, 1200, current.conversationRootRefId, 1);
  });
  if (!/no longer connected/i.test(String(detachedRootRead.error || '')) || detachedRootRead.pageContent) {
    throw new Error(`${label}: a detached Gmail conversation ref remained readable`);
  }
  return pages.map(result => ({
    page: result.page,
    totalChars: result.totalChars,
    hasMore: result.hasMore,
    truncated: result.truncated,
    pageContent: normalizeTreeRevision(normalizeTreeRefs(result.pageContent)),
    treeRevision: 'tree_revision',
    conversationRootRefId: 'ref_trusted_root',
    conversationExpansionState: result.conversationExpansionState,
    continuationArgs: result.continuationArgs
      ? { ...result.continuationArgs, ref_id: 'ref_trusted_root', tree_revision: 'tree_revision' }
      : null,
  }));
}

test('accessibility tree (Chrome): Gmail whole-thread reads use one trusted active-thread anchor', async (page) => {
  chromeGmailThreadScopePages = await readTrustedGmailThreadPages(page, accessibilityTreeJsPath, 'chrome');
});

test('accessibility tree (Firefox): Gmail trusted thread metadata and pagination keep Chrome parity', async (page) => {
  const firefoxPages = await readTrustedGmailThreadPages(page, firefoxAccessibilityTreeJsPath, 'firefox');
  if (JSON.stringify(firefoxPages) !== JSON.stringify(chromeGmailThreadScopePages)) {
    throw new Error('Chrome/Firefox trusted Gmail thread pages differ');
  }
});

const collapsedGmailThreadFixture = `<!doctype html>
  <meta charset="utf-8">
  <style>
    body { margin: 0; font: 16px sans-serif; }
    main { display: block; width: 900px; min-height: 600px; }
    article { display: block; min-height: 30px; }
    #older-message[hidden] { display: none; }
  </style>
  <main id="active-thread" aria-label="Collapsed project thread">
    <h1>Collapsed project thread</h1>
    <button id="expand-all" jsname="tRarif" aria-label="Tümünü genişlet">Tümünü genişlet</button>
    <article class="adn" role="listitem" aria-label="Latest message">
      <p>Latest visible project message.</p>
      <button jsname="tRarif" aria-label="Tümünü genişlet">Untrusted message button</button>
    </article>
    <article id="older-message" class="adn" role="listitem" aria-label="Older message" hidden>
      <p>Older collapsed decision that must be included.</p>
    </article>
  </main>
  <script>
    document.getElementById('expand-all').addEventListener('click', () => {
      document.getElementById('older-message').hidden = false;
      const control = document.getElementById('expand-all');
      control.setAttribute('jsname', 'xvWlrc');
      control.setAttribute('aria-label', 'Tümünü daralt');
      control.textContent = 'Tümünü daralt';
    });
  </script>`;

let chromeCollapsedGmailRead = null;

async function readCollapsedGmailThread(page, browserKind) {
  await setupContentGmailHtml(page, collapsedGmailThreadFixture, browserKind);
  const discovery = await rawContentCall(page, 'get_accessibility_tree', {
    filter: 'visible',
    maxDepth: 12,
    maxChars: 1200,
    page: 1,
  });
  if (!discovery.conversationRootRefId || discovery.conversationExpansionState !== 'collapsed') {
    throw new Error(`${browserKind}: collapsed Gmail thread was not discovered safely`);
  }
  const result = await rawContentCall(page, 'get_accessibility_tree', {
    filter: 'all',
    maxDepth: 15,
    maxChars: 6000,
    ref_id: discovery.conversationRootRefId,
    page: 1,
  });
  if (result.error || result.conversationAutoExpanded !== true
      || result.conversationExpansionState !== 'expanded') {
    throw new Error(`${browserKind}: anchored whole-thread read did not expand Gmail: ${JSON.stringify(result)}`);
  }
  if (!result.pageContent.includes('Older collapsed decision that must be included.')) {
    throw new Error(`${browserKind}: anchored whole-thread read omitted the revealed older message`);
  }
  const state = await page.evaluate(() => ({
    topLevelLabel: document.getElementById('expand-all').getAttribute('aria-label'),
    topLevelJsname: document.getElementById('expand-all').getAttribute('jsname'),
    olderHidden: document.getElementById('older-message').hidden,
  }));
  if (state.topLevelLabel !== 'Tümünü daralt' || state.topLevelJsname !== 'xvWlrc' || state.olderHidden) {
    throw new Error(`${browserKind}: whole-thread preparation did not reveal the trusted conversation: ${JSON.stringify(state)}`);
  }
  return {
    pageContent: normalizeTreeRefs(result.pageContent),
    conversationExpansionState: result.conversationExpansionState,
    conversationAutoExpanded: result.conversationAutoExpanded,
  };
}

test('content tree (Chrome): anchored Gmail reads reveal collapsed messages in either agent mode', async (page) => {
  chromeCollapsedGmailRead = await readCollapsedGmailThread(page, 'chrome');
});

test('content tree (Firefox): collapsed Gmail whole-thread preparation keeps Chrome parity', async (page) => {
  const firefoxResult = await readCollapsedGmailThread(page, 'firefox');
  if (JSON.stringify(firefoxResult) !== JSON.stringify(chromeCollapsedGmailRead)) {
    throw new Error('Chrome/Firefox collapsed Gmail whole-thread reads differ');
  }
});

const richEditorVariantsFixture = `<!doctype html>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    .editor { display: block; width: 520px; min-height: 72px; margin: 12px; border: 1px solid #888; }
  </style>
  <div class="editor" contenteditable="" aria-label="Email body">Draft body text</div>
  <div class="editor" contenteditable="plaintext-only" aria-label="Plain message">Plain draft text</div>
  <div class="editor" contenteditable="false" aria-label="Read-only copy">Do not edit</div>`;

let chromeRichEditorTree = '';

function assertRichEditorVariants(tree, label) {
  const content = String(tree?.pageContent || '');
  if (!/textbox "Email body" \[ref_\d+\] value="Draft body text"/.test(content)) {
    throw new Error(`${label}: contenteditable="" editor missing as a valued textbox: ${content}`);
  }
  if (!/textbox "Plain message" \[ref_\d+\] value="Plain draft text"/.test(content)) {
    throw new Error(`${label}: plaintext-only editor missing as a valued textbox: ${content}`);
  }
  if (/Read-only copy|Do not edit/.test(content)) {
    throw new Error(`${label}: contenteditable=false leaked into the interactive tree: ${content}`);
  }
  const textboxes = content.match(/^\s*textbox\b/gm) || [];
  if (textboxes.length !== 2) throw new Error(`${label}: expected exactly two editable roots, got ${textboxes.length}: ${content}`);
  return normalizeTreeRefs(content);
}

test('accessibility tree (Chrome): contenteditable variants are actionable valued textboxes', async (page) => {
  await setupAccessibilityTreeHtml(page, richEditorVariantsFixture, accessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('interactive', 10, null, null, 1));
  chromeRichEditorTree = assertRichEditorVariants(tree, 'chrome');
});

test('accessibility tree (Firefox): contenteditable variants keep Chrome parity', async (page) => {
  await setupAccessibilityTreeHtml(page, richEditorVariantsFixture, firefoxAccessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('interactive', 10, null, null, 1));
  const firefoxTree = assertRichEditorVariants(tree, 'firefox');
  if (firefoxTree !== chromeRichEditorTree) throw new Error('Chrome/Firefox rich editor trees differ');
});

// ─── modal-scoping ────────────────────────────────────────────────────────
test('modal scoping: click({text:"Create"}) resolves to dialog Create', async (page) => {
  await setup(page, 'modal-scoping.html');
  const resp = await call(page, 'click', { text: 'Create' });
  if (!resp?.success) throw new Error(`expected success, got: ${JSON.stringify(resp)}`);
  const clicked = await clickedSentinel(page);
  if (clicked !== 'dlg-create') {
    throw new Error(`expected dlg-create, actually clicked: ${clicked}`);
  }
});

test('modal scoping: click({text:"Publish"}) returns no-match (scoped out)', async (page) => {
  await setup(page, 'modal-scoping.html');
  const resp = await call(page, 'click', { text: 'Publish release' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (resp?.dispatched !== false) throw new Error(`no-match must report dispatched:false, got: ${JSON.stringify(resp)}`);
  if (!/scoped to the open modal/i.test(resp?.error || '')) {
    throw new Error(`expected modal-scope note in error, got: ${resp?.error}`);
  }
});

async function assertModalAutoSelectTargetsResolvedSelect(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
    <style>
      select { width: 180px; height: 40px; }
      #dialog { position: fixed; left: 40px; top: 100px; padding: 20px; background: white; }
    </style>
    <select id="background-select">
      <option value="monthly">Monthly</option>
      <option value="yearly">Yearly</option>
    </select>
    <div id="dialog" role="dialog" aria-modal="true">
      <select id="dialog-select">
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>
    </div>`);

  const response = await call(page, 'click', { text: 'Yearly' });
  if (!response?.success || response?.method !== 'auto-select') {
    throw new Error(`${label}: expected modal select auto-selection, got: ${JSON.stringify(response)}`);
  }
  const values = await page.evaluate(() => ({
    background: document.getElementById('background-select').value,
    dialog: document.getElementById('dialog-select').value,
  }));
  if (values.background !== 'monthly' || values.dialog !== 'yearly') {
    throw new Error(`${label}: auto-select mutated the wrong dropdown: ${JSON.stringify(values)}`);
  }
}

test('Chrome: modal auto-select changes the resolved select, not a background select', async (page) => {
  await assertModalAutoSelectTargetsResolvedSelect(page, 'chrome');
});

test('Firefox: modal auto-select changes the resolved select, not a background select', async (page) => {
  await assertModalAutoSelectTargetsResolvedSelect(page, 'firefox');
});

async function assertAmbiguousNativeSelectOptionsAreRejected(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
    <style>select, button { width: 180px; height: 40px; display: block; margin: 8px; }</style>
    <button id="contact" onclick="window.__contactClicked = true">Contact us</button>
    <label>Billing country
      <select id="billing">
        <option value="CA">Canada</option>
        <option value="US">United States</option>
      </select>
    </label>
    <label>Shipping country
      <select id="shipping">
        <option value="CA">Canada</option>
        <option value="US">United States</option>
      </select>
    </label>`);

  const response = await call(page, 'click', { text: 'US' });
  const state = await page.evaluate(() => ({
    billing: document.getElementById('billing').value,
    shipping: document.getElementById('shipping').value,
    contactClicked: window.__contactClicked === true,
  }));
  if (
    response?.success !== false
    || response?.dispatched !== false
    || response?.failureScope !== 'ambiguous-select-option:us'
    || !/Ambiguous select option match/.test(response?.error || '')
  ) {
    throw new Error(`${label}: expected explicit select-option ambiguity, got: ${JSON.stringify(response)}`);
  }
  if (state.billing !== 'CA' || state.shipping !== 'CA' || state.contactClicked) {
    throw new Error(`${label}: ambiguous select rescue mutated page state: ${JSON.stringify(state)}`);
  }
}

test('Chrome: ambiguous native select options do not mutate the first dropdown', async (page) => {
  await assertAmbiguousNativeSelectOptionsAreRejected(page, 'chrome');
});

test('Firefox: ambiguous native select options do not mutate the first dropdown', async (page) => {
  await assertAmbiguousNativeSelectOptionsAreRejected(page, 'firefox');
});

test('Chrome Agent: modal auto-select ignores background/hidden clickables and keeps the exact target', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      select { width: 180px; height: 40px; }
      #dialog { position: fixed; left: 40px; top: 100px; padding: 20px; background: white; }
    </style>
    <button id="background-yearly" onclick="window.__backgroundYearlyClicked = true">Yearly</button>
    <select id="background-select">
      <option value="monthly">Monthly</option>
      <option value="yearly">Yearly</option>
    </select>
    <div id="dialog" role="dialog" aria-modal="true">
      <button style="display: none">Yearly</button>
      <select id="dialog-select">
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>
    </div>
    <script>
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') window.__escapeActiveId = document.activeElement?.id || '';
        if (event.key === 'Escape' && document.activeElement?.id === 'dialog-select') {
          document.activeElement.blur();
        }
      }, true);
    </script>`);

  const session = await page.context().newCDPSession(page);
  const client = {
    async evaluate(_tabId, expression) {
      return { result: { value: await page.evaluate(expression) } };
    },
    async sendCommand(_tabId, method, params) {
      // Headless Chromium does not apply the native <select> default action
      // for this raw CDP key sequence consistently. Model that one browser
      // action on whichever exact control the production code focused; the
      // Escape event itself still goes through CDP and triggers the blur above.
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && /^(ArrowDown|ArrowUp)$/.test(params.key || '')) {
        await page.evaluate((key) => {
          const target = document.activeElement;
          if (!(target instanceof HTMLSelectElement)) return;
          const delta = key === 'ArrowDown' ? 1 : -1;
          target.selectedIndex = Math.max(0, Math.min(target.options.length - 1, target.selectedIndex + delta));
        }, params.key);
        return {};
      }
      return session.send(method, params);
    },
  };
  const agent = new Agent({});
  const result = await agent._autoSelectOption(42, client, 'Yearly');
  const values = await page.evaluate(() => ({
    background: document.getElementById('background-select').value,
    dialog: document.getElementById('dialog-select').value,
    backgroundButtonClicked: window.__backgroundYearlyClicked === true,
    escapeActiveId: window.__escapeActiveId || '',
    leakedTargetSlots: Object.keys(globalThis).filter((key) => key.startsWith('__webbrainAutoSelectTarget_')),
  }));

  if (!result?.success || result.method !== 'auto-select-keyboard') {
    throw new Error(`expected exact-target auto-selection, got: ${JSON.stringify(result)}`);
  }
  if (values.background !== 'monthly' || values.dialog !== 'yearly' || values.backgroundButtonClicked) {
    throw new Error(`auto-select changed the wrong dropdown after refocus: ${JSON.stringify(values)}`);
  }
  if (values.escapeActiveId !== 'dialog-select') {
    throw new Error(`auto-select sent Escape to the wrong control: ${JSON.stringify(values)}`);
  }
  if (values.leakedTargetSlots.length) {
    throw new Error(`auto-select target reference was not cleaned up: ${JSON.stringify(values.leakedTargetSlots)}`);
  }
});

// ─── occlusion ────────────────────────────────────────────────────────────
test('occlusion: click({text:"Submit"}) refuses when covered', async (page) => {
  await setup(page, 'occlusion.html');
  const resp = await call(page, 'click', { text: 'Submit' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (resp?.dispatched !== false) throw new Error(`occluded preflight must report dispatched:false, got: ${JSON.stringify(resp)}`);
  if (!resp?.occluded) throw new Error(`expected occluded:true, got: ${JSON.stringify(resp)}`);
  if (!resp?.occludedBy) throw new Error(`expected occludedBy payload`);
  const clicked = await clickedSentinel(page);
  if (clicked !== null) throw new Error(`target should not have been clicked, got: ${clicked}`);
});

test('occlusion: click({x,y}) force-clicks (skips occlusion check)', async (page) => {
  await setup(page, 'occlusion.html');
  // Force via coords — the check is supposed to skip for x,y, so click
  // hits whatever elementFromPoint returns (the cover). Target stays unclicked.
  const resp = await call(page, 'click', { x: 180, y: 120 });
  if (!resp?.success) throw new Error(`expected success for coord click, got: ${JSON.stringify(resp)}`);
  // Either the cover or the button — we just verify no occlusion error thrown.
  if (resp?.occluded) throw new Error(`coord click should bypass occlusion check`);
});

// ─── ambiguity candidates ─────────────────────────────────────────────────
test('ambiguity: two Cancels return rich candidates with ancestor', async (page) => {
  await setup(page, 'ambiguity-candidates.html');
  const resp = await call(page, 'click', { text: 'Cancel' });
  if (resp?.success) throw new Error(`expected ambiguity, got success`);
  if (resp?.dispatched !== false) throw new Error(`ambiguity must report dispatched:false, got: ${JSON.stringify(resp)}`);
  if (!Array.isArray(resp?.candidates)) throw new Error(`expected candidates array`);
  if (resp.candidates.length < 2) throw new Error(`expected ≥2 candidates, got ${resp.candidates.length}`);
  const ancestors = resp.candidates.map(c => c.ancestor || '');
  const hasForm = ancestors.some(a => /form/i.test(a) && /payment/i.test(a));
  const hasSection = ancestors.some(a => /section/i.test(a) && /shipping/i.test(a));
  if (!hasForm || !hasSection) {
    throw new Error(`expected form:Payment + section:Shipping ancestors, got: ${JSON.stringify(ancestors)}`);
  }
  for (const c of resp.candidates) {
    if (typeof c.cx !== 'number' || typeof c.cy !== 'number') {
      throw new Error(`candidate missing cx/cy: ${JSON.stringify(c)}`);
    }
  }
});

// ─── CDP upload selector bridge ─────────────────────────────────────────────
test('CDP upload selector bridge resolves hidden and open-shadow file inputs', async (page) => {
  await page.setContent(`<!doctype html>
    <input id="upload-addon" type="file" hidden>
    <div id="shadow-host"></div>
    <script>
      document.querySelector('#shadow-host')
        .attachShadow({ mode: 'open' })
        .innerHTML = '<input id="shadow-upload" type="file">';
    </script>`);

  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);

  const fixtureFile = path.join(root, 'package.json');
  const attachThroughSelector = async (selector) => {
    const query = await client.querySelectorPierce(42, selector);
    if (query.objectIds.length !== 1 || !query.objectIds[0]) {
      throw new Error(`file input did not resolve to one CDP object handle: ${JSON.stringify(query)}`);
    }
    try {
      // Refreshing Chrome's DOM mirror invalidates frontend nodeIds. Runtime
      // object handles must remain valid across an unrelated DOM traversal.
      await session.send('DOM.getDocument', { depth: -1, pierce: true });
      await client.setFileInputFiles(42, query.objectIds[0], [fixtureFile]);
      const files = await client.getFileInputFiles(42, query.objectIds[0]);
      if (files?.[0]?.name !== 'package.json') {
        throw new Error(`attached FileList was not readable through the Runtime handle: ${JSON.stringify(files)}`);
      }
    } finally {
      await client.releaseObjectGroup(42, query.objectGroup);
    }
  };

  await attachThroughSelector('#upload-addon');
  await attachThroughSelector('#shadow-upload');
  const attached = await page.evaluate(() => ({
    hidden: document.querySelector('#upload-addon').files[0]?.name || '',
    shadow: document.querySelector('#shadow-host').shadowRoot
      .querySelector('#shadow-upload').files[0]?.name || '',
  }));
  if (attached.hidden !== 'package.json' || attached.shadow !== 'package.json') {
    throw new Error(`DOM.setFileInputFiles did not attach through resolved nodes: ${JSON.stringify(attached)}`);
  }
});

test('CDP toolbar selector probe traverses shadow hosts for dense clusters', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      #formatting-row { display:flex; align-items:center; gap:6px; width:420px; height:44px; }
      #editor-body { width:420px; height:160px; }
    </style>
    <div id="formatting-row">
      <button type="button">Bold</button>
      <span id="family-host"></span>
    </div>
    <div id="editor-body" role="textbox" contenteditable="true">Enter text</div>
    <script>
      document.querySelector('#family-host').attachShadow({ mode: 'open' }).innerHTML =
        '<input id="shadow-family" aria-label="Font family" value="Default" style="width:118px;height:22px">';
    </script>`);

  // The selector probe runs in the page's main world. A hostile page must not
  // be able to replace the packaged classifier with a permissive global.
  await page.evaluate(() => {
    Object.defineProperty(window, '__wbRichTextToolbarHeuristic', {
      configurable: false,
      writable: false,
      value: Object.freeze({ candidate: () => null }),
    });
  });

  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);
  client.resolveSelector = async () => ({ found: true, nodeId: null, inViewport: true });

  const probe = await client.probeRichTextToolbarSelector(42, '#shadow-family');
  const candidate = probe?.fieldMeta?.toolbarCandidate;
  if (
    !probe?.resolved
    || Number(candidate?.score) < 4
    || !candidate?.reasons?.includes('dense_control_cluster')
    || candidate?.associatedEditorIdentity?.id !== 'editor-body'
  ) {
    throw new Error(`shadow-host dense toolbar cluster was not audited by the CDP selector probe: ${JSON.stringify(probe)}`);
  }

  await page.setContent(`<!doctype html>
    <style>
      #color-row { display:flex; align-items:center; gap:6px; width:420px; height:44px; }
      #editor-body { width:420px; height:160px; }
    </style>
    <div id="color-row">
      <button type="button">Bold</button>
      <input id="text-color" aria-label="Text color" value="#111111" style="width:118px;height:22px">
    </div>
    <div id="editor-body" role="textbox" contenteditable="true">Enter text</div>`);
  const colorProbe = await client.probeRichTextToolbarSelector(42, '#text-color');
  if (
    !colorProbe?.resolved
    || !colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
    || !colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('dense_control_cluster')
    || colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || colorProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
    || !colorProbe.toolbarContext
    || colorProbe.toolbarRegionKey !== colorProbe.fieldMeta.toolbarCandidate.regionKey
  ) {
    throw new Error(`conventional text-color control was not audited by the CDP selector probe: ${JSON.stringify(colorProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <style>
      #slotted-toolbar-editor { width:420px; margin-top:1400px; }
      #slot-editor-component { display:block; width:420px; height:160px; }
    </style>
    <div id="slotted-toolbar-editor">
      <span id="slot-toolbar-host">
        <input id="slotted-family" type="text" aria-label="Font family" value="Default" style="width:118px;height:22px">
        <input id="slotted-search" type="search" aria-label="Search links" value="" style="width:118px;height:22px">
        <input id="slotted-unlabelled-search" type="search" value="" style="width:118px;height:22px">
        <input id="slotted-filter" type="text" aria-label="Filter" value="" style="width:118px;height:22px">
        <input id="slotted-link" type="url" aria-label="Link URL" value="https://example.test" style="width:118px;height:22px">
        <select id="slotted-style" aria-label="Paragraph style" style="width:118px;height:24px">
          <option>Body</option><option>Heading 1</option><option>Heading 2</option>
        </select>
        <div id="slotted-editable-family" contenteditable="true" role="combobox" aria-label="Font family"
          style="width:118px;height:22px">Default</div>
      </span>
      <div id="slot-editor-component"></div>
    </div>
    <script>
      document.querySelector('#slot-toolbar-host').attachShadow({ mode: 'open' }).innerHTML =
        '<div role="toolbar" style="height:44px;display:flex;align-items:center"><slot></slot></div>';
      document.querySelector('#slot-editor-component').attachShadow({ mode: 'open' }).innerHTML =
        '<div id="slot-editor-body" role="textbox" contenteditable="true" style="width:420px;height:160px">Enter text</div>';
    </script>`);
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.documentElement.style.scrollBehavior = 'smooth';
  });
  const slottedProbe = await client.probeRichTextToolbarSelector(42, '#slotted-family');
  const settledSlottedRect = await page.evaluate(() => {
    const rect = document.querySelector('#slotted-family').getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    document.documentElement.style.scrollBehavior = 'auto';
    return { y: rect.y, h: rect.height, viewportHeight };
  });
  if (
    !slottedProbe?.resolved
    || !slottedProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || !slottedProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
    || slottedProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'slot-editor-body'
    || !slottedProbe.toolbarRegionKey
    || slottedProbe.toolbarRegionKey !== slottedProbe.fieldMeta.toolbarCandidate.regionKey
    || Math.abs(slottedProbe.rect.y - settledSlottedRect.y) > 2
    || slottedProbe.rect.y < 0
    || slottedProbe.rect.y + slottedProbe.rect.h > settledSlottedRect.viewportHeight
  ) {
    throw new Error(`labelled assigned-slot toolbar must settle before CDP audit: ${JSON.stringify({ slottedProbe, settledSlottedRect })}`);
  }
  const ordinarySearchProbe = await client.probeRichTextToolbarSelector(42, '#slotted-search');
  if (!ordinarySearchProbe?.resolved || ordinarySearchProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`ordinary labelled toolbar search was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinarySearchProbe)}`);
  }
  const unlabelledSearchProbe = await client.probeRichTextToolbarSelector(42, '#slotted-unlabelled-search');
  if (
    !unlabelledSearchProbe?.resolved
    || unlabelledSearchProbe.fieldMeta?.type !== 'search'
    || unlabelledSearchProbe.fieldMeta?.toolbarCandidate
    || unlabelledSearchProbe.toolbarRegionKey !== slottedProbe.toolbarRegionKey
  ) {
    throw new Error(`unlabelled native search must remain ordinary while preserving its toolbar region: ${JSON.stringify(unlabelledSearchProbe)}`);
  }
  const ordinaryFilterProbe = await client.probeRichTextToolbarSelector(42, '#slotted-filter');
  if (!ordinaryFilterProbe?.resolved || ordinaryFilterProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`ordinary labelled toolbar text filter was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinaryFilterProbe)}`);
  }
  const linkProbe = await client.probeRichTextToolbarSelector(42, '#slotted-link');
  if (
    !linkProbe?.resolved
    || linkProbe.fieldMeta?.type !== 'url'
    || !linkProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
  ) {
    throw new Error(`URL-typed rich-text link control was not audited by the CDP selector probe: ${JSON.stringify(linkProbe)}`);
  }
  const editableProbe = await client.probeRichTextToolbarSelector(42, '#slotted-editable-family');
  if (
    !editableProbe?.resolved
    || editableProbe.fieldMeta?.contentEditable !== true
    || !editableProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
  ) {
    throw new Error(`contenteditable rich-text formatting control was not audited by the CDP selector probe: ${JSON.stringify(editableProbe)}`);
  }
  const nativeStyleProbe = await client.probeRichTextToolbarSelector(42, '#slotted-style');
  if (
    !nativeStyleProbe?.resolved
    || nativeStyleProbe.fieldMeta?.type !== 'select'
    || !nativeStyleProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || !nativeStyleProbe.fieldMeta.toolbarCandidate.availablePresetValues?.includes('Heading 1')
  ) {
    throw new Error(`native rich-text style select was not audited by the CDP selector probe: ${JSON.stringify(nativeStyleProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <label for="ordinary-status">Status</label>
    <select id="ordinary-status"><option>Draft</option><option>Published</option></select>`);
  const ordinarySelectProbe = await client.probeRichTextToolbarSelector(42, '#ordinary-status');
  if (!ordinarySelectProbe?.resolved || ordinarySelectProbe.fieldMeta?.type !== 'select' || ordinarySelectProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`labelled ordinary select was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinarySelectProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <div style="display:flex;align-items:center;gap:6px;width:320px;height:44px">
      <div id="compact-composer" role="textbox" contenteditable="true"
        style="width:190px;height:28px">Draft reply</div>
      <button type="button">Emoji</button>
      <button type="button">Send</button>
    </div>`);
  const compactComposerProbe = await client.probeRichTextToolbarSelector(42, '#compact-composer');
  if (!compactComposerProbe?.resolved || compactComposerProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`compact contenteditable composer was audited as formatting by the CDP selector probe: ${JSON.stringify(compactComposerProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <div style="width:420px">
      <div style="height:42px;display:flex;align-items:center;gap:6px">
        <input id="ordinary-document-title" type="text" style="width:180px;height:28px">
        <button type="button">Save</button>
      </div>
      <textarea style="width:400px;height:180px"></textarea>
    </div>`);
  const ordinaryTitleProbe = await client.probeRichTextToolbarSelector(42, '#ordinary-document-title');
  if (!ordinaryTitleProbe?.resolved || ordinaryTitleProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`ordinary compact title near an editor was audited by the CDP selector probe: ${JSON.stringify(ordinaryTitleProbe)}`);
  }
});

test('CDP type_text binds dispatch to the selector node approved by toolbar preflight', async (page) => {
  await page.setContent(`<!doctype html>
    <input class="shared-target" value="ordinary" style="width:180px;height:32px">`);
  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);

  const staleProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  if (!staleProbe?.resolved || !staleProbe.selectorBackendNodeId) {
    throw new Error(`CDP selector preflight did not expose an exact node identity: ${JSON.stringify(staleProbe)}`);
  }
  await page.evaluate(() => {
    const previous = document.querySelector('.shared-target');
    const replacement = previous.cloneNode();
    replacement.value = '11';
    previous.replaceWith(replacement);
  });
  const rejected = await client.typeText(
    42,
    '.shared-target',
    'Document prose',
    true,
    staleProbe.selectorBackendNodeId,
  );
  const rejectedValue = await page.locator('.shared-target').inputValue();
  if (rejected?.success !== false || rejected?.dispatched !== false || !rejected?.retryable || rejectedValue !== '11') {
    throw new Error(`rerendered CDP selector target did not fail closed: ${JSON.stringify({ rejected, rejectedValue })}`);
  }

  const cloneProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  await page.evaluate(() => {
    const observer = new MutationObserver(records => {
      if (!records.some(record => record.attributeName === 'data-webbrain-dispatch-binding')) return;
      observer.disconnect();
      const previous = document.querySelector('.shared-target');
      const replacement = previous.cloneNode();
      replacement.value = '12';
      previous.replaceWith(replacement);
    });
    observer.observe(document.querySelector('.shared-target'), {
      attributes: true,
      attributeFilter: ['data-webbrain-dispatch-binding'],
    });
  });
  const cloneRejected = await client.typeText(
    42,
    '.shared-target',
    'Document prose',
    true,
    cloneProbe.selectorBackendNodeId,
  );
  const cloneRejectedValue = await page.locator('.shared-target').inputValue();
  if (cloneRejected?.success !== false || cloneRejected?.dispatched !== false || !cloneRejected?.retryable || cloneRejectedValue !== '12') {
    throw new Error(`a replacement that copied the preflight attribute bypassed node identity: ${JSON.stringify({ cloneRejected, cloneRejectedValue })}`);
  }

  const stableProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  const accepted = await client.typeText(
    42,
    '.shared-target',
    '14',
    false,
    stableProbe.selectorBackendNodeId,
  );
  const acceptedValue = await page.locator('.shared-target').inputValue();
  const leakedMarkers = await page.locator('[data-webbrain-dispatch-binding]').count();
  if (!accepted?.success || accepted?.verified !== true || acceptedValue !== '1214' || leakedMarkers !== 0) {
    throw new Error(`stable CDP selector target did not type and clean up exactly: ${JSON.stringify({ accepted, acceptedValue, leakedMarkers })}`);
  }
});

for (const browserKind of ['chrome', 'firefox']) {
  test(`get_interactive_elements (${browserKind}): identifies the Hugging Face repository file input`, async (page) => {
    const setupHtml = browserKind === 'firefox' ? setupFirefoxHtml : setupChromeHtml;
    await setupHtml(page, `<!doctype html>
      <style>
        [data-repository-drop-zone] { display: none; }
      </style>
      <label>Repository files
        <input data-repository-drop-zone type="file" multiple>
      </label>
      <section aria-label="Extended description editor">
        <input type="file" accept="image/png,image/jpeg" multiple hidden>
      </section>`);

    const elements = await call(page, 'get_interactive_elements_cdp', {});
    const fileInputs = elements.filter((element) => element.type === 'file');
    if (fileInputs.length !== 2) {
      throw new Error(`expected both Hugging Face-shaped file inputs, got ${JSON.stringify(fileInputs)}`);
    }

    const repositoryInput = fileInputs.find((element) => element.accept === null);
    const editorMediaInput = fileInputs.find((element) => element.accept === 'image/png,image/jpeg');
    if (!repositoryInput || repositoryInput.multiple !== true) {
      throw new Error(`file metadata mismatch: ${JSON.stringify(repositoryInput)}`);
    }
    if (!editorMediaInput || editorMediaInput.multiple !== true) {
      throw new Error(`raw editor-media accept metadata mismatch: ${JSON.stringify(editorMediaInput)}`);
    }
    if (!repositoryInput.selector || !repositoryInput.selector.includes(':not([accept])')) {
      throw new Error(`expected a no-accept repository selector, got ${JSON.stringify(repositoryInput)}`);
    }

    const selectorCheck = await page.evaluate((selector) => {
      const matches = document.querySelectorAll(selector);
      return {
        count: matches.length,
        repository: matches[0] === document.querySelector('[data-repository-drop-zone]'),
      };
    }, repositoryInput.selector);
    if (selectorCheck.count !== 1 || !selectorCheck.repository) {
      throw new Error(`selector did not uniquely target the repository drop zone: ${JSON.stringify(selectorCheck)}`);
    }
  });

  test(`file picker guard (${browserKind}): blocks the native chooser and returns the exact input`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <button id="choose">Select a file...</button>
      <input type="file" hidden>
      <input type="file" hidden>
      <script>
        document.querySelector('#choose').addEventListener('click', () => {
          document.querySelectorAll('input[type=file]')[1].click();
        });
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await call(page, 'click', { text: 'Select a file...' });
    await page.waitForTimeout(20);
    if (chooserOpened) throw new Error('native file chooser was not suppressed');
    if (!result?.filePickerBlocked || result.success !== false || !result.selector) {
      throw new Error(`expected blocked picker with exact selector, got ${JSON.stringify(result)}`);
    }
    const selectorCheck = await page.evaluate((selector) => {
      const inputs = document.querySelectorAll('input[type=file]');
      const matches = document.querySelectorAll(selector);
      return { count: matches.length, correct: matches[0] === inputs[1] };
    }, result.selector);
    if (selectorCheck.count !== 1 || !selectorCheck.correct) {
      throw new Error(`selector did not uniquely resolve the clicked input: ${JSON.stringify({ result, selectorCheck })}`);
    }
  });

  test(`file picker guard (${browserKind}): withholds selectors that collide across shadow roots`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <button id="choose">Select a shadow file...</button>
      <div id="host-a"></div>
      <div id="host-b"></div>
      <script>
        for (const id of ['host-a', 'host-b']) {
          document.querySelector('#' + id).attachShadow({ mode: 'open' }).innerHTML = '<input type="file">';
        }
        document.querySelector('#choose').addEventListener('click', () => {
          document.querySelector('#host-b').shadowRoot.querySelector('input').click();
        });
      </script>`, browserKind);

    const result = await call(page, 'click', { text: 'Select a shadow file...' });
    if (!result?.filePickerBlocked || result.success !== false) {
      throw new Error(`expected blocked picker, got ${JSON.stringify(result)}`);
    }
    if (Object.hasOwn(result, 'selector')) {
      throw new Error(`ambiguous shadow-root input must not return selector ${result.selector}`);
    }
    if (!/exact, unique/.test(result.error || '') || !/generic input\[type="file"\]/.test(result.error || '')) {
      throw new Error(`missing unique-selector recovery guidance: ${JSON.stringify(result)}`);
    }
  });
}

const deferredFilePickerOpeners = [
  ['promise', 'Promise.resolve().then(openPicker)'],
  ['timer', 'setTimeout(openPicker, 0)'],
  ['debounce-150ms', 'setTimeout(openPicker, 150)'],
  ['debounce-300ms', 'setTimeout(openPicker, 300)'],
  ['animation-frame', 'requestAnimationFrame(openPicker)'],
];
const showPickerOpeners = [
  ['immediate', 'openPicker()'],
  ...deferredFilePickerOpeners,
];

for (const browserKind of ['chrome', 'firefox']) {
  for (const [deferral, scheduleOpen] of deferredFilePickerOpeners) {
    test(`file picker guard (${browserKind}): blocks lazy ${deferral} chooser activation`, async (page) => {
      const inputId = `lazy-${browserKind}-${deferral}`;
      await setupContentHtml(page, `<!doctype html>
        <button id="choose">Add a deferred file...</button>
        <script>
          document.querySelector('#choose').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.id = ${JSON.stringify(inputId)};
            input.hidden = true;
            document.body.appendChild(input);
            const openPicker = () => input.click();
            ${scheduleOpen};
          });
        </script>`, browserKind);

      let chooserOpened = false;
      page.once('filechooser', () => { chooserOpened = true; });
      const result = await call(page, 'click', { text: 'Add a deferred file...' });
      await page.waitForTimeout(20);
      if (chooserOpened) throw new Error(`${deferral} native file chooser was not suppressed`);
      if (!result?.filePickerBlocked || result.success !== false || result.selector !== `#${inputId}`) {
        throw new Error(`expected blocked lazy picker with #${inputId}, got ${JSON.stringify(result)}`);
      }
      const selectorCheck = await page.evaluate((selector) => {
        const matches = document.querySelectorAll(selector);
        return { count: matches.length, id: matches[0]?.id || '' };
      }, result.selector);
      if (selectorCheck.count !== 1 || selectorCheck.id !== inputId) {
        throw new Error(`lazy selector did not resolve uniquely: ${JSON.stringify({ result, selectorCheck })}`);
      }
    });
  }

  for (const [deferral, scheduleOpen] of showPickerOpeners) {
    test(`file picker guard (${browserKind}): blocks ${deferral} showPicker activation`, async (page) => {
      const inputId = `show-picker-${browserKind}-${deferral}`;
      const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
        <button id="choose">Show a file picker...</button>
        <input id=${JSON.stringify(inputId)} type="file" hidden>
        <script>
          document.querySelector('#choose').addEventListener('click', () => {
            const input = document.querySelector('#' + ${JSON.stringify(inputId)});
            const openPicker = () => input.showPicker();
            ${scheduleOpen};
          });
        </script>`, browserKind);

      let chooserOpened = false;
      page.once('filechooser', () => { chooserOpened = true; });
      const result = await isolatedCall('click', { text: 'Show a file picker...' });
      await page.waitForTimeout(20);
      if (chooserOpened) throw new Error(`${deferral} showPicker native chooser was not suppressed`);
      if (!result?.filePickerBlocked || result.success !== false || result.selector !== `#${inputId}`) {
        throw new Error(`expected blocked showPicker with #${inputId}, got ${JSON.stringify(result)}`);
      }
      const footprint = await page.evaluate(() => ({
        stableGlobal: Object.hasOwn(window, '__webbrainFilePickerGuardBridge'),
        attributes: Array.from(document.documentElement.attributes)
          .map(attribute => attribute.name)
          .filter(name => name.startsWith('data-webbrain-file-picker-')),
      }));
      if (footprint.stableGlobal || footprint.attributes.length) {
        throw new Error(`page-world guard left a detectable marker: ${JSON.stringify(footprint)}`);
      }
    });
  }

  test(`file picker guard (${browserKind}): blocks programmatic clicks inside closed shadow roots`, async (page) => {
    const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
      <button id="choose">Open a closed-shadow picker...</button>
      <div id="host"></div>
      <script>
        const input = document.querySelector('#host')
          .attachShadow({ mode: 'closed' })
          .appendChild(document.createElement('input'));
        input.type = 'file';
        document.querySelector('#choose').addEventListener('click', () => input.click());
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await isolatedCall('click', { text: 'Open a closed-shadow picker...' });
    await page.waitForTimeout(20);
    if (chooserOpened) throw new Error('closed-shadow native chooser was not suppressed');
    if (!result?.filePickerBlocked || result.success !== false) {
      throw new Error(`expected blocked closed-shadow picker, got ${JSON.stringify(result)}`);
    }
    if (Object.hasOwn(result, 'selector')) {
      throw new Error(`closed-shadow picker must not expose an unusable selector: ${result.selector}`);
    }
  });

  test(`file picker guard (${browserKind}): suppresses long programmatic debounce after result settlement`, async (page) => {
    const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
      <button id="choose">Schedule a late picker...</button>
      <input id="late-picker" type="file" hidden>
      <script>
        document.querySelector('#choose').addEventListener('click', () => {
          setTimeout(() => {
            window.__latePickerAttempted = true;
            document.querySelector('#late-picker').click();
          }, 800);
        });
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await isolatedCall('click', { text: 'Schedule a late picker...' });
    if (!result?.success || result.filePickerBlocked) {
      throw new Error(`late picker should settle before its callback, got ${JSON.stringify(result)}`);
    }
    await page.waitForTimeout(350);
    const attempted = await page.evaluate(() => window.__latePickerAttempted === true);
    if (!attempted) throw new Error('late picker callback did not execute');
    if (chooserOpened) throw new Error('post-settlement native chooser was not suppressed');
  });
}

test('Chrome CDP file picker guard blocks trusted showPicker activation and restores the prototype', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      #closed-host { display: block; width: 220px; height: 40px; }
    </style>
    <button id="choose">Open trusted picker</button>
    <button id="choose-closed">Open trusted closed picker</button>
    <input id="trusted-show-picker" type="file" hidden>
    <div id="closed-host"></div>
    <script>
      window.__originalShowPicker = HTMLInputElement.prototype.showPicker;
      window.__originalInputClick = HTMLInputElement.prototype.click;
      const closedInput = document.querySelector('#closed-host')
        .attachShadow({ mode: 'closed' })
        .appendChild(document.createElement('input'));
      closedInput.type = 'file';
      closedInput.style.cssText = 'display:block;width:220px;height:40px';
      document.querySelector('#choose').addEventListener('click', () => {
        document.querySelector('#trusted-show-picker').showPicker();
      });
      document.querySelector('#choose-closed').addEventListener('click', () => closedInput.click());
    </script>`);
  const pageGuardSrc = await readFile(filePickerGuardPageJsPath, 'utf-8');
  await page.addScriptTag({ content: pageGuardSrc });

  const client = new CDPClient();
  const protocolSession = await page.context().newCDPSession(page);
  client.sendCommand = async (_tabId, method, params = {}) => protocolSession.send(method, params);
  protocolSession.on('Page.fileChooserOpened', (params) => {
    const handlers = client.eventHandlers.get(77)?.['Page.fileChooserOpened'] || [];
    for (const handler of handlers) handler(params);
  });
  client.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });

  let chooserOpened = false;
  page.once('filechooser', () => { chooserOpened = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#choose');
  const blocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);

  if (chooserOpened) throw new Error('trusted showPicker native chooser was not suppressed');
  if (!blocked?.blocked || blocked.selector !== '#trusted-show-picker') {
    throw new Error(`expected trusted showPicker block, got ${JSON.stringify(blocked)}`);
  }
  const restored = await page.evaluate(
    () => ({
      showPicker: HTMLInputElement.prototype.showPicker === window.__originalShowPicker,
      click: HTMLInputElement.prototype.click === window.__originalInputClick,
    }),
  );
  if (!restored.showPicker || !restored.click) {
    throw new Error(`input prototypes were not restored after guard consumption: ${JSON.stringify(restored)}`);
  }

  let closedChooserOpened = false;
  page.once('filechooser', () => { closedChooserOpened = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#choose-closed');
  const closedBlocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);
  if (closedChooserOpened) throw new Error('trusted closed-shadow native chooser was not suppressed');
  if (!closedBlocked?.blocked || closedBlocked.selector !== null) {
    throw new Error(`expected trusted closed-shadow block without selector, got ${JSON.stringify(closedBlocked)}`);
  }

  let directChooserEventObserved = false;
  page.once('filechooser', () => { directChooserEventObserved = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#closed-host');
  const directBlocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);
  if (!directChooserEventObserved) {
    throw new Error('direct trusted closed-shadow chooser did not emit the intercepted protocol event');
  }
  if (!directBlocked?.blocked || directBlocked.selector !== null) {
    throw new Error(`expected protocol-level closed-shadow block, got ${JSON.stringify(directBlocked)}`);
  }

  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute('data-webbrain-file-picker-guard', 'residual-content-guard');
    document.dispatchEvent(new Event('webbrain:file-picker-guard-arm'));
    root.removeAttribute('data-webbrain-file-picker-guard');
  });
  const residualInstalled = await page.evaluate(
    () => HTMLInputElement.prototype.click !== window.__originalInputClick,
  );
  if (!residualInstalled) throw new Error('residual page-world guard was not installed');

  await client.armFileInputClickGuard(77, 250);
  const noPickerBlocked = await client.consumeFileInputClickGuard(77, 0);
  if (noPickerBlocked) throw new Error(`unexpected picker during restore-stack test: ${JSON.stringify(noPickerBlocked)}`);
  await page.waitForTimeout(350);
  const stackRestored = await page.evaluate(() => ({
    showPicker: HTMLInputElement.prototype.showPicker === window.__originalShowPicker,
    click: HTMLInputElement.prototype.click === window.__originalInputClick,
  }));
  if (!stackRestored.showPicker || !stackRestored.click) {
    throw new Error(`stacked page/CDP guards did not restore native prototypes: ${JSON.stringify(stackRestored)}`);
  }
});

test('Firefox upload_file resolves one open-shadow input and rejects ambiguous pierced selectors', async (page) => {
  await page.setContent(`<!doctype html>
    <div id="host-a"></div>
    <div id="host-b"></div>
    <script>
      const inputA = document.createElement('input');
      inputA.type = 'file';
      inputA.id = 'shadow-upload';
      window.__uploadEvents = { input: 0, change: 0 };
      inputA.addEventListener('input', () => window.__uploadEvents.input++);
      inputA.addEventListener('change', () => window.__uploadEvents.change++);
      document.querySelector('#host-a').attachShadow({ mode: 'open' }).appendChild(inputA);
      const inputB = document.createElement('input');
      inputB.type = 'file';
      document.querySelector('#host-b').attachShadow({ mode: 'open' }).appendChild(inputB);
    </script>`);

  const originalBrowser = globalThis.browser;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.browser = {
      downloads: {
        async search(query) {
          if (query?.id !== 9001) throw new Error(`unexpected download query ${JSON.stringify(query)}`);
          return [{
            id: 9001,
            state: 'complete',
            url: 'https://example.com/shadow-upload.txt',
            filename: '/home/user/Downloads/shadow-upload.txt',
            mime: 'text/plain',
          }];
        },
      },
      tabs: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com/form' };
        },
        async executeScript(_tabId, details) {
          return [await page.evaluate((source) => window.eval(source), details.code)];
        },
      },
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const key = String(name).toLowerCase();
          if (key === 'content-length') return '2';
          if (key === 'content-type') return 'text/plain';
          return null;
        },
      },
      async arrayBuffer() {
        return new Uint8Array([111, 107]).buffer;
      },
    });

    const agent = new FirefoxAgent({});
    const uploaded = await agent.executeTool(77, 'upload_file', {
      selector: '#shadow-upload',
      downloadId: 9001,
    });
    if (
      !uploaded?.success
      || uploaded.attached?.name !== 'shadow-upload.txt'
      || uploaded.attached?.size !== 2
      || uploaded.attachmentState !== 'input_attached'
      || uploaded.verified !== false
      || uploaded.remoteStateVerified !== false
    ) {
      throw new Error(`open-shadow upload failed: ${JSON.stringify(uploaded)}`);
    }
    const state = await page.evaluate(() => {
      const input = document.querySelector('#host-a').shadowRoot.querySelector('#shadow-upload');
      return {
        count: input.files.length,
        name: input.files[0]?.name || '',
        size: input.files[0]?.size ?? -1,
        events: window.__uploadEvents,
      };
    });
    if (
      state.count !== 1
      || state.name !== 'shadow-upload.txt'
      || state.size !== 2
      || state.events.input !== 1
      || state.events.change !== 1
    ) {
      throw new Error(`open-shadow upload state mismatch: ${JSON.stringify(state)}`);
    }

    await page.evaluate(() => {
      const input = document.querySelector('#host-a').shadowRoot.querySelector('#shadow-upload');
      input.addEventListener('change', () => {
        queueMicrotask(() => { input.value = ''; });
      }, { once: true });
    });
    const consumed = await agent.executeTool(77, 'upload_file', {
      selector: '#shadow-upload',
      downloadId: 9001,
    });
    const consumedCount = await page.evaluate(() => (
      document.querySelector('#host-a').shadowRoot.querySelector('#shadow-upload').files.length
    ));
    if (
      consumed?.success !== true
      || consumed.attachmentState !== 'page_consumed'
      || consumed.verified !== false
      || consumed.remoteStateVerified !== false
      || consumedCount !== 0
    ) {
      throw new Error(`queued file consumption was misclassified: ${JSON.stringify({ consumed, consumedCount })}`);
    }

    const ambiguous = await agent.executeTool(77, 'upload_file', {
      selector: 'input[type="file"]',
      downloadId: 9001,
    });
    if (
      ambiguous?.success !== false
      || ambiguous.dispatched !== false
      || ambiguous.ambiguous !== true
      || ambiguous.matchCount !== 2
      || ambiguous.recoveryRequired !== 'get_interactive_elements'
      || !/exact, unique selector/.test(ambiguous.error || '')
    ) {
      throw new Error(`ambiguous pierced selector did not fail closed: ${JSON.stringify(ambiguous)}`);
    }

    const blockedRetry = await agent.executeTool(77, 'upload_file', {
      selector: '#shadow-upload',
      downloadId: 9001,
    });
    if (
      blockedRetry?.success !== false
      || blockedRetry.noDispatch !== true
      || blockedRetry.matchCount !== 2
      || blockedRetry.recoveryRequired !== 'get_interactive_elements'
    ) {
      throw new Error(`upload retry was not blocked pending inspection: ${JSON.stringify(blockedRetry)}`);
    }
    if (agent._clearUploadSelectorRecoveryAfterInspection(
      77,
      'get_interactive_elements',
      [],
    )) {
      throw new Error('empty inspection cleared upload recovery');
    }
    if (!agent._uploadSelectorRecoveryRequired.has(77)) {
      throw new Error('empty inspection removed upload recovery state');
    }
    if (agent._clearUploadSelectorRecoveryAfterInspection(
      77,
      'get_interactive_elements',
      [{ tag: 'input', type: 'file' }],
    )) {
      throw new Error('selector-less file-input inspection cleared upload recovery');
    }
    if (!agent._clearUploadSelectorRecoveryAfterInspection(
      77,
      'get_interactive_elements',
      [{ tag: 'input', type: 'file', selector: '#shadow-upload' }],
    )) {
      throw new Error('fresh interactive-element inspection did not clear upload recovery');
    }
    agent._uploadSelectorRecoveryRequired.set(77, 2);
    agent._clearRunLoopState(77);
    if (agent._uploadSelectorRecoveryRequired.has(77)) {
      throw new Error('Firefox run cleanup did not clear upload recovery');
    }
  } finally {
    if (originalBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = originalBrowser;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

for (const browserKind of ['chrome', 'firefox']) {
  test(`click_ax (${browserKind}): stale refs are explicit pre-dispatch failures`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const result = await call(page, 'click_ax', { ref_id: 'ref_999999' });
    if (
      result?.success !== false
      || result?.dispatched !== false
      || result?.noDispatch !== true
      || result?.fallbackAttempted !== false
    ) {
      throw new Error(`expected explicit pre-dispatch markers, got: ${JSON.stringify(result)}`);
    }
    if (!/not found/i.test(result.error || '')) {
      throw new Error(`expected stale-ref error, got: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): refs are rejected after a same-document route change`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!match || !tree?.documentToken || !tree?.refScopeUrl) {
      throw new Error(`expected scoped AX ref, got: ${JSON.stringify(tree)}`);
    }
    await page.evaluate(() => history.pushState({}, '', '#different-route'));
    const result = await call(page, 'click_ax', {
      ref_id: match[1],
      expectedDocumentToken: tree.documentToken,
      expectedPageUrl: tree.refScopeUrl,
    });
    if (
      result?.success !== false
      || result?.staleRef !== true
      || result?.routeChanged !== true
      || result?.dispatched !== false
    ) {
      throw new Error(`expected route-scoped stale-ref failure, got: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): an old ref cannot alias after the new route tree is read`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const firstTree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const firstMatch = String(firstTree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!firstMatch) throw new Error(`expected first-route ref, got: ${JSON.stringify(firstTree)}`);

    await page.evaluate(() => history.pushState({}, '', '#new-tree-route'));
    const secondTree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const secondMatch = String(secondTree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!secondMatch || !secondTree?.documentToken || !secondTree?.refScopeUrl) {
      throw new Error(`expected second-route scoped AX ref, got: ${JSON.stringify(secondTree)}`);
    }
    if (firstMatch[1] === secondMatch[1]) {
      throw new Error(`route-scoped refs must not reuse the same identifier: ${firstMatch[1]}`);
    }

    // Simulate the reviewed failure exactly: the agent has already cached the
    // latest route scope but the model reuses a ref string from the old tree.
    const stale = await call(page, 'click_ax', {
      ref_id: firstMatch[1],
      expectedDocumentToken: secondTree.documentToken,
      expectedPageUrl: secondTree.refScopeUrl,
    });
    if (
      stale?.success !== false
      || stale?.dispatched !== false
      || stale?.noDispatch !== true
      || stale?.fallbackAttempted !== false
      || !/not found/i.test(stale?.error || '')
    ) {
      throw new Error(`expected old ref to fail before dispatch, got: ${JSON.stringify(stale)}`);
    }

    const fresh = await call(page, 'click_ax', {
      ref_id: secondMatch[1],
      expectedDocumentToken: secondTree.documentToken,
      expectedPageUrl: secondTree.refScopeUrl,
    });
    if (!fresh?.success) {
      throw new Error(`expected current-route ref to remain usable, got: ${JSON.stringify(fresh)}`);
    }
  });

  test(`click_ax (${browserKind}): unnamed broad generic targets are rejected`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/group \[(ref_\d+)\]/);
    if (!match) throw new Error(`could not find unnamed broad group in AX tree: ${tree?.pageContent}`);
    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result?.ambiguousTarget !== true
      || result?.dispatched !== false
      || result?.targetContext?.truncated !== true
    ) {
      throw new Error(`expected ambiguous generic target failure, got: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): disabled controls are visible and rejected before dispatch`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    for (const label of ['Disabled native action', 'Disabled ARIA action']) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = content.match(new RegExp(`button "${escaped}" \\[(ref_\\d+)\\][^\\n]*disabled=true`));
      if (!match) throw new Error(`expected disabled state for ${label} in AX tree: ${content}`);
      const result = await call(page, 'click_ax', { ref_id: match[1] });
      if (
        result?.success !== false
        || result.disabled !== true
        || result.dispatched !== false
        || result.noDispatch !== true
        || result.fallbackAttempted !== false
      ) {
        throw new Error(`disabled ${label} should fail before dispatch: ${JSON.stringify(result)}`);
      }
    }
  });

  test(`input tools (${browserKind}): invalid targets and keys are explicit pre-dispatch failures`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const calls = [
      ['type', { text: 'should not be typed' }],
      ['type_ax', { ref_id: 'ref_999999', text: 'should not be typed' }],
      ['set_field', { ref_id: 'ref_999999', text: 'should not be typed' }],
      ['press_keys', { key: 'F5' }],
    ];
    for (const [action, params] of calls) {
      const result = await call(page, action, params);
      if (
        result?.success !== false
        || result?.dispatched !== false
        || result?.noDispatch !== true
      ) {
        throw new Error(`${action} should be an explicit pre-dispatch failure, got: ${JSON.stringify(result)}`);
      }
    }
  });

  test(`checkbox tools (${browserKind}): AX state and set_checked are explicit and idempotent`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    const match = content.match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*type="checkbox"[^\n]*checked=false/);
    if (!match) throw new Error(`expected native unchecked state in AX tree: ${content}`);

    const checked = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      checked?.success !== true
      || checked.checkedBefore !== false
      || checked.checkedAfter !== true
      || checked.checkedChanged !== true
      || checked.verified !== true
    ) {
      throw new Error(`click_ax did not report native checkbox transition: ${JSON.stringify(checked)}`);
    }

    const unchecked = await call(page, 'set_checked', { ref_id: match[1], checked: false });
    if (
      unchecked?.success !== true
      || unchecked.checkedBefore !== true
      || unchecked.checkedAfter !== false
      || unchecked.changed !== true
      || unchecked.verified !== true
    ) {
      throw new Error(`set_checked did not reach desired false state: ${JSON.stringify(unchecked)}`);
    }

    const idempotent = await call(page, 'set_checked', { ref_id: match[1], checked: false });
    if (
      idempotent?.success !== true
      || idempotent.idempotent !== true
      || idempotent.dispatched !== false
      || idempotent.checkedBefore !== false
      || idempotent.checkedAfter !== false
    ) {
      throw new Error(`set_checked repeated action was not idempotent: ${JSON.stringify(idempotent)}`);
    }
  });

  test(`set_checked (${browserKind}): wrapped labels and confirmation-gated state are explicit`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    const match = content.match(/checkbox "Firefox for Android compatibility" \[(ref_\d+)\][^\n]*type="checkbox"[^\n]*checked=false/);
    if (!match) throw new Error(`expected wrapped Android checkbox label in AX tree: ${content}`);

    const result = await call(page, 'set_checked', { ref_id: match[1], checked: true });
    if (
      result?.success !== false
      || result.dispatched !== true
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.verified !== false
      || result.confirmationRequired !== true
      || result.recoveryRequired !== 'confirmation_dialog'
      || result.noProgress === true
      || result.error
      || result.confirmation?.title !== 'Firefox for Android compatibility'
      || !result.confirmation?.actions?.includes('Yes, I’ve tested my extension with Firefox for Android')
      || !result.confirmation?.actions?.includes('No, I have not tested')
    ) {
      throw new Error(`confirmation-gated checkbox was reported as ordinary no-progress: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): waits for controlled checkbox reconciliation`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
    if (!match) throw new Error(`expected controlled checkbox ref in AX tree: ${tree?.pageContent}`);

    await page.evaluate(() => {
      const checkbox = document.getElementById('firefox-checkbox');
      checkbox.addEventListener('click', () => {
        setTimeout(() => {
          checkbox.checked = false;
        }, 0);
      });
    });
    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result.noProgress !== true
      || result.verified !== false
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.desiredChecked !== true
      || result.checkboxState?.actualChecked !== false
    ) {
      throw new Error(`controlled checkbox rollback was accepted too early: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): an already-selected radio keeps desired checked state`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/radio "Selected channel" \[(ref_\d+)\][^\n]*checked=true/);
    if (!match) throw new Error(`expected selected radio state in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== true
      || result.checkedBefore !== true
      || result.checkedAfter !== true
      || result.checkedChanged !== false
      || result.desiredChecked !== true
      || result.checkboxState?.desiredChecked !== true
      || result.checkboxState?.actualChecked !== true
    ) {
      throw new Error(`selected radio was represented as needing an uncheck: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): a prevented radio selection is an explicit failure`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/radio "Blocked channel" \[(ref_\d+)\][^\n]*checked=false/);
    if (!match) throw new Error(`expected blocked radio state in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result.noProgress !== true
      || result.verified !== false
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.desiredChecked !== true
      || result.checkboxState?.actualChecked !== false
      || !/Radio remained unselected/.test(String(result.error || ''))
    ) {
      throw new Error(`prevented radio selection was not reported as a failure: ${JSON.stringify(result)}`);
    }
  });

  test(`verify_form refs (${browserKind}): form controls receive actionable AX refs`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const result = await call(page, 'resolve_form_field_refs', { selector: 'form' });
    if (
      result?.success !== true
      || !Array.isArray(result.refs)
      || result.refs.length < 4
      || result.refs.some(ref => !/^ref_\d+$/.test(String(ref || '')))
      || typeof result.documentToken !== 'string'
      || !result.documentToken
      || result.refScopeUrl !== page.url()
    ) {
      throw new Error(`form controls did not receive actionable refs: ${JSON.stringify(result)}`);
    }
  });
}

async function assertSemicolonShortcutEvent(page, browserKind, expectedKeyCode) {
  await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
  await page.evaluate(() => {
    window.__semicolonShortcutEvents = [];
    document.addEventListener('keydown', (event) => {
      if (event.key !== ';') return;
      window.__semicolonShortcutEvents.push({
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        which: event.which,
      });
    });
  });

  const result = await call(page, 'press_keys', { key: ';' });
  if (result?.success !== true || result?.dispatched !== true || result?.key !== ';') {
    throw new Error(`semicolon should dispatch successfully, got: ${JSON.stringify(result)}`);
  }
  const events = await page.evaluate(() => window.__semicolonShortcutEvents);
  if (
    events?.length !== 1
    || events[0]?.key !== ';'
    || events[0]?.code !== 'Semicolon'
    || events[0]?.keyCode !== expectedKeyCode
    || events[0]?.which !== expectedKeyCode
  ) {
    throw new Error(`semicolon shortcut metadata mismatch: ${JSON.stringify(events)}`);
  }
}

test('press_keys (chrome): semicolon dispatches Chromium-compatible metadata', async (page) => {
  await assertSemicolonShortcutEvent(page, 'chrome', 186);
});

firefoxTest('press_keys (firefox engine): semicolon dispatches Gecko-compatible metadata', async (page) => {
  await assertSemicolonShortcutEvent(page, 'firefox', 59);
});

test('set_checked (chrome): post-click verification survives same-document route changes', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'chrome');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Chrome checkbox ref in AX tree: ${tree?.pageContent}`);

  const preflight = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  if (preflight?.needsTrustedClick !== true || !preflight.marker) {
    throw new Error(`expected trusted checkbox preflight marker: ${JSON.stringify(preflight)}`);
  }

  await page.locator('#firefox-checkbox').click();
  await page.evaluate(() => history.pushState({}, '', '#checked-filter'));
  const verified = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    probeOnly: true,
    markForTrustedClick: false,
    cleanupMarker: preflight.marker,
  });
  if (
    verified?.success !== true
    || verified.checkedAfter !== true
    || verified.verified !== true
    || verified.staleRef === true
  ) {
    throw new Error(`same-document route change invalidated marker verification: ${JSON.stringify(verified)}`);
  }
});

test('set_checked (chrome): markers are one-shot, unique, and self-cleaning', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'chrome');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Chrome checkbox ref in AX tree: ${tree?.pageContent}`);

  await page.evaluate(() => {
    window.__wbOriginalSetTimeout = window.setTimeout;
    window.__wbMarkerCleanup = null;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 15000 && !window.__wbMarkerCleanup) {
        window.__wbMarkerCleanup = callback;
        return 1;
      }
      return window.__wbOriginalSetTimeout(callback, delay, ...args);
    };
  });
  const expiring = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  const expiredCount = await page.evaluate((marker) => {
    window.__wbMarkerCleanup?.();
    window.setTimeout = window.__wbOriginalSetTimeout;
    delete window.__wbOriginalSetTimeout;
    delete window.__wbMarkerCleanup;
    return document.querySelectorAll(`[data-webbrain-set-checked-target="${marker}"]`).length;
  }, expiring.marker);
  if (expiredCount !== 0) throw new Error(`trusted marker did not self-clean: ${expiring.marker}`);

  const ambiguous = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  await page.evaluate((marker) => {
    document.getElementById('trusted-firefox-checkbox')
      .setAttribute('data-webbrain-set-checked-target', marker);
  }, ambiguous.marker);
  const uniqueClient = new CDPClient();
  uniqueClient.sendCommand = async (_tabId, method) => {
    if (method === 'Runtime.enable') return {};
    throw new Error(`unexpected CDP command while resolving marker: ${method}`);
  };
  uniqueClient.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });
  const duplicateResolution = await uniqueClient.resolveSelector(
    42,
    `[data-webbrain-set-checked-target="${ambiguous.marker}"]`,
    { requireUnique: true, retries: 0 },
  );
  if (!duplicateResolution?.error || duplicateResolution?.matchCount !== 2) {
    throw new Error(`CDP trusted selector did not reject duplicate markers: ${JSON.stringify(duplicateResolution)}`);
  }
  const verified = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    probeOnly: true,
    markForTrustedClick: false,
    cleanupMarker: ambiguous.marker,
  });
  const remaining = await page.locator(`[data-webbrain-set-checked-target="${ambiguous.marker}"]`).count();
  if (
    verified?.success !== false
    || verified.markerConflict !== true
    || verified.markerMatchCount !== 2
    || remaining !== 0
  ) {
    throw new Error(`ambiguous trusted marker did not fail closed and clean up: ${JSON.stringify({ verified, remaining })}`);
  }
});

test('set_checked (firefox): waits for controlled checkbox reconciliation before verifying', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'firefox');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Firefox checkbox ref in AX tree: ${tree?.pageContent}`);

  await page.evaluate(() => {
    const checkbox = document.getElementById('firefox-checkbox');
    checkbox.addEventListener('click', () => {
      setTimeout(() => {
        checkbox.checked = false;
      }, 0);
    }, { once: true });
  });

  const result = await call(page, 'set_checked', { ref_id: match[1], checked: true });
  if (
    result?.success !== false
    || result.dispatched !== true
    || result.checkedBefore !== false
    || result.checkedAfter !== false
    || result.verified !== false
    || result.noProgress !== true
  ) {
    throw new Error(`Firefox set_checked verified before controlled rollback settled: ${JSON.stringify(result)}`);
  }
});

for (const browserKind of ['chrome', 'firefox']) {
  test(`click_ax (${browserKind}): aria-labelledby action returns bounded nearest card context`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/button "Add to cart" \[(ref_\d+)\]/);
    if (!match) throw new Error(`could not find product action in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (!result?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(result)}`);
    if (
      result.name !== 'Add to cart'
      || result.targetContext?.heading !== 'Cola Zero 6-pack'
      || !String(result.targetContext?.text || '').includes('Cola Zero 6-pack')
      || !String(result.targetContext?.href || '').endsWith('/products/cola-zero-six-pack')
    ) {
      throw new Error(`nearest product context missing or wrong: ${JSON.stringify(result)}`);
    }
    if (
      String(result.targetContext.text).length > 240
      || String(result.targetContext.heading).length > 160
      || String(result.targetContext.href).length > 500
    ) {
      throw new Error(`product context bounds regressed: ${JSON.stringify(result.targetContext)}`);
    }
  });

  test(`resolve_visual_target (${browserKind}): nested SVG resolves semantic button`, async (page) => {
    await setupContentHtml(page, `
      <style>button { position: fixed; left: 40px; top: 30px; width: 120px; height: 60px; }</style>
      <button id="target" aria-label="Add to cart" onclick="window.__nestedSvgClicked = true">
        <svg id="icon" width="100%" height="100%"><circle cx="60" cy="30" r="20"></circle></svg>
      </button>
    `, browserKind);
    const point = await page.locator('#icon circle').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const result = await call(page, 'resolve_visual_target', point);
    if (
      !result?.success
      || result.semanticTarget?.role !== 'button'
      || result.semanticTarget?.name !== 'Add to cart'
      || !/^ref_\d+$/.test(result.semanticTarget?.ref_id || '')
      || result.semanticTarget?.eligibility !== 'semantic-button'
      || Object.hasOwn(result.semanticTarget, 'rect')
    ) {
      throw new Error(`nested SVG did not resolve to button: ${JSON.stringify(result)}`);
    }
    const clickResult = await call(page, 'click_ax', {
      ref_id: result.semanticTarget.ref_id,
      expectedDocumentToken: result.documentToken,
      expectedPageUrl: result.refScopeUrl,
    });
    if (!clickResult?.success || await page.evaluate(() => window.__nestedSvgClicked) !== true) {
      throw new Error(`nested SVG semantic dispatch did not activate its button: ${JSON.stringify(clickResult)}`);
    }
  });

  test(`resolve_visual_target (${browserKind}): plain canvas stays coordinate-only`, async (page) => {
    await setupContentHtml(page, '<canvas id="canvas" width="200" height="100" style="position:fixed;left:20px;top:20px"></canvas>', browserKind);
    const point = { x: 70, y: 55 };
    const result = await call(page, 'resolve_visual_target', point);
    if (
      !result?.success
      || result.semanticTarget?.eligibility !== 'coordinate-only'
      || !/^ref_\d+$/.test(result.semanticTarget?.ref_id || '')
      || Object.hasOwn(result.semanticTarget, 'rect')
    ) {
      throw new Error(`canvas should stay coordinate-only: ${JSON.stringify(result)}`);
    }
  });

  test(`resolve_visual_target (${browserKind}): form controls and iframe boundaries stay coordinate-only`, async (page) => {
    await setupContentHtml(page, `
      <style>
        #frame { position:fixed;left:20px;top:20px;width:120px;height:50px; }
        #label { position:fixed;left:20px;top:90px;width:160px;height:30px; }
        #text { position:fixed;left:20px;top:140px;width:160px;height:30px; }
        #notes { position:fixed;left:20px;top:190px;width:160px;height:30px; }
        #select { position:fixed;left:20px;top:240px;width:160px;height:30px; }
        #file { position:fixed;left:20px;top:290px;width:160px;height:30px; }
      </style>
      <iframe id="frame" title="Embedded boundary"></iframe>
      <label id="label" for="text">Account name</label>
      <input id="text" aria-label="Account name">
      <textarea id="notes" aria-label="Notes"></textarea>
      <select id="select" aria-label="Plan"><option>Basic</option></select>
      <input id="file" type="file" aria-label="Upload receipt">
    `, browserKind);

    for (const selector of ['#frame', '#label', '#text', '#notes', '#select', '#file']) {
      const point = await page.locator(selector).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const result = await call(page, 'resolve_visual_target', point);
      if (
        !result?.success
        || result.semanticTarget?.eligibility !== 'coordinate-only'
        || !/^ref_\d+$/.test(result.semanticTarget?.ref_id || '')
        || Object.hasOwn(result.semanticTarget, 'rect')
      ) {
        throw new Error(`${selector} should stay coordinate-only: ${JSON.stringify(result)}`);
      }
    }
  });

  test(`resolve_visual_target (${browserKind}): open shadow button resolves`, async (page) => {
    await setupContentHtml(page, '<div id="host" style="position:fixed;left:25px;top:25px"></div>', browserKind);
    await page.evaluate(() => {
      const root = document.querySelector('#host').attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="shadow-target" aria-label="Shadow action" style="width:140px;height:50px">Action</button>';
      root.querySelector('button').addEventListener('click', () => { window.__shadowClicked = true; });
    });
    const point = await page.locator('#host').evaluate((host) => {
      const r = host.shadowRoot.querySelector('button').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const result = await call(page, 'resolve_visual_target', point);
    if (
      !result?.success
      || result.semanticTarget?.role !== 'button'
      || result.semanticTarget?.name !== 'Shadow action'
      || !/^ref_\d+$/.test(result.semanticTarget?.ref_id || '')
      || result.semanticTarget?.eligibility !== 'semantic-button'
    ) {
      throw new Error(`open shadow target was not resolved: ${JSON.stringify(result)}`);
    }
    const clickResult = await call(page, 'click_ax', {
      ref_id: result.semanticTarget.ref_id,
      expectedDocumentToken: result.documentToken,
      expectedPageUrl: result.refScopeUrl,
    });
    if (!clickResult?.success || await page.evaluate(() => window.__shadowClicked) !== true) {
      throw new Error(`open shadow semantic dispatch did not activate its button: ${JSON.stringify(clickResult)}`);
    }
  });
}

test('set_field (chrome): trusted contenteditable input updates framework state and enables submit', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const content = String(tree?.pageContent || '');
  const editorMatch = content.match(/textbox "Framework post text" \[(ref_\d+)\]/);
  if (!editorMatch || !/button "Framework Post" \[(ref_\d+)\][^\n]*disabled=true/.test(content)) {
    throw new Error(`expected empty framework editor and disabled submit: ${content}`);
  }

  const preflight = await call(page, 'set_field', {
    ref_id: editorMatch[1],
    text: 'Trusted framework post',
    clear: true,
  });
  if (
    preflight?.success !== false
    || preflight.trustedTypeRequired !== true
    || preflight.dispatched !== false
    || preflight.noDispatch !== true
  ) {
    throw new Error(`contenteditable set_field should route to trusted typing before DOM mutation: ${JSON.stringify(preflight)}`);
  }

  const before = await page.evaluate(() => ({
    text: document.getElementById('framework-editor').innerText,
    disabled: document.getElementById('framework-post').getAttribute('aria-disabled'),
    events: window.__frameworkInputEvents,
  }));
  if (before.text || before.disabled !== 'true' || before.events.length !== 0) {
    throw new Error(`contenteditable preflight mutated framework state: ${JSON.stringify(before)}`);
  }

  const originalChrome = globalThis.chrome;
  const originals = {
    attach: cdpClient.attach,
    sendCommand: cdpClient.sendCommand,
  };
  const session = await page.context().newCDPSession(page);
  globalThis.chrome = {
    tabs: {
      async sendMessage(_tabId, message) {
        return call(page, message.action, message.params || {});
      },
    },
  };
  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.sendCommand = async (_tabId, method, params) => session.send(method, params);
    const agent = new Agent({});
    const result = await agent._maybeFallbackFieldWithCdp(
      42,
      'set_field',
      { ref_id: editorMatch[1], text: 'Trusted framework post', clear: true },
      preflight,
    );
    const after = await page.evaluate(() => ({
      text: document.getElementById('framework-editor').innerText,
      disabled: document.getElementById('framework-post').getAttribute('aria-disabled'),
      events: window.__frameworkInputEvents,
    }));
    if (
      result?.success !== true
      || result.trusted !== true
      || result.verified !== true
      || result.dispatched !== true
      || after.text !== 'Trusted framework post'
      || after.disabled !== 'false'
      || after.events.length !== 1
      || after.events[0].trusted !== true
    ) {
      throw new Error(`trusted contenteditable path did not update framework state: ${JSON.stringify({ result, after })}`);
    }
  } finally {
    cdpClient.attach = originals.attach;
    cdpClient.sendCommand = originals.sendCommand;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('type_ax (chrome): Gmail-style empty blocks verify without masking text corruption', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  await page.evaluate(() => {
    const editor = document.getElementById('editable-row');
    editor.setAttribute('aria-label', 'Message Body');
    editor.innerHTML = 'Hey Andrew,<div><br></div><div>Thank you!</div>';
  });
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const editorMatch = String(tree?.pageContent || '').match(/textbox "Message Body" \[(ref_\d+)\]/);
  if (!editorMatch) throw new Error(`expected Gmail-style message body: ${tree?.pageContent}`);

  const originalChrome = globalThis.chrome;
  const originals = {
    attach: cdpClient.attach,
    sendCommand: cdpClient.sendCommand,
  };
  const session = await page.context().newCDPSession(page);
  globalThis.chrome = {
    tabs: {
      async sendMessage(_tabId, message) {
        return call(page, message.action, message.params || {});
      },
    },
  };
  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.sendCommand = async (_tabId, method, params) => session.send(method, params);
    const agent = new Agent({});
    const appendText = '\n\nAre these good enough?';
    const preflight = await call(page, 'type_ax', {
      ref_id: editorMatch[1],
      text: appendText,
      clear: false,
    });
    const result = await agent._maybeFallbackFieldWithCdp(
      42,
      'type_ax',
      { ref_id: editorMatch[1], text: appendText, clear: false },
      preflight,
    );
    const after = await page.evaluate(() => {
      const editor = document.getElementById('editable-row');
      return {
        innerText: editor.innerText,
        preservedPrefix: editor.innerHTML.startsWith('Hey Andrew,<div><br></div><div>Thank you!</div>'),
        directBlankBlocks: Array.from(editor.children)
          .filter(child => child.tagName === 'DIV' && child.innerHTML.toLowerCase() === '<br>').length,
      };
    });
    if (
      result?.success !== true
      || result.verified !== true
      || result.trusted !== true
      || after.innerText !== 'Hey Andrew,\n\n\nThank you!\n\n\nAre these good enough?'
      || after.preservedPrefix !== true
      || after.directBlankBlocks !== 2
    ) {
      throw new Error(`Gmail-style block expansion should verify: ${JSON.stringify({ result, after })}`);
    }

    await page.evaluate(() => {
      document.getElementById('editable-row').addEventListener('input', (event) => {
        event.currentTarget.append(document.createTextNode('!'));
      }, { once: true });
    });
    const corruptAppend = '\n\nOne more line.';
    const corruptPreflight = await call(page, 'type_ax', {
      ref_id: editorMatch[1],
      text: corruptAppend,
      clear: false,
    });
    const corruptResult = await agent._maybeFallbackFieldWithCdp(
      42,
      'type_ax',
      { ref_id: editorMatch[1], text: corruptAppend, clear: false },
      corruptPreflight,
    );
    if (
      corruptResult?.success !== false
      || corruptResult.verified !== false
      || corruptResult.dispatched !== true
    ) {
      throw new Error(`real rich-editor corruption must remain rejected: ${JSON.stringify(corruptResult)}`);
    }
  } finally {
    cdpClient.attach = originals.attach;
    cdpClient.sendCommand = originals.sendCommand;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

firefoxTest('type_ax (firefox engine): rich-editor verification rejects an added blank line', async (page) => {
  await setupFirefoxHtml(page, `
    <div id="editor" role="textbox" aria-label="Message Body" contenteditable="true"
      style="width:400px;height:160px">Original</div>
  `);
  await page.evaluate(() => {
    const editor = document.getElementById('editor');
    window.__wb_ax_lookup = refId => refId === 'ref_editor' ? editor : null;
    editor.addEventListener('input', () => {
      editor.innerHTML = 'First<br><br><br>Second';
    });
  });
  const result = await rawContentCall(page, 'type_ax', {
    ref_id: 'ref_editor',
    text: 'First\n\nSecond',
    clear: true,
  });
  const actual = await page.locator('#editor').evaluate(editor => editor.innerText);
  if (
    result?.success !== false
    || result.verified !== false
    || result.dispatched !== true
    || actual !== 'First\n\n\nSecond'
  ) {
    throw new Error(`Firefox must reject a page-added blank line: ${JSON.stringify({ result, actual })}`);
  }
});

test('click_ax: Agent.executeTool keeps synthetic-first behavior and uses trusted CDP only for an ignored generic row', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const trustedMatch = String(tree?.pageContent || '').match(/listitem "Defne Sokullu Yesterday Photo" \[(ref_\d+)\]/);
  const syntheticMatch = String(tree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
  const disclosureMatch = String(tree?.pageContent || '').match(/"Native disclosure" \[(ref_\d+)\]/);
  if (!trustedMatch || !syntheticMatch || !disclosureMatch) {
    throw new Error(`expected trusted, synthetic, and disclosure fixture rows in AX tree: ${tree?.pageContent}`);
  }

  const originalChrome = globalThis.chrome;
  const originals = {
    attach: cdpClient.attach,
    evaluate: cdpClient.evaluate,
    dispatch: cdpClient.dispatchMouseEvent,
  };
  const session = await page.context().newCDPSession(page);
  const dispatched = [];
  const listener = { addListener() {}, removeListener() {} };
  globalThis.chrome = {
    runtime: {},
    tabs: {
      async get(tabId) {
        return { id: tabId, url: page.url(), title: 'Trusted click fixture' };
      },
      async query() {
        return [{ id: 42, url: page.url() }];
      },
      async sendMessage(_tabId, message) {
        return call(page, message.action, message.params || {});
      },
    },
    downloads: { onCreated: listener },
    webRequest: { onBeforeRequest: listener },
    scripting: { async executeScript() {} },
  };

  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.evaluate = async (_tabId, expression) => ({
      result: { value: await page.evaluate(expression) },
    });
    cdpClient.dispatchMouseEvent = async (_tabId, type, x, y) => {
      dispatched.push({ type, x, y });
      return session.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    };

    const agent = new Agent({});
    agent._isPdfTab = async () => false;
    agent._currentUrl = async () => page.url();
    agent._clickAxFinalSettleMs = () => 60;

    const trustedResult = await agent.executeTool(42, 'click_ax', { ref_id: trustedMatch[1] });
    const afterTrusted = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      ambientStatus: document.getElementById('ambient-status').textContent,
      events: window.__trustedClickEvents,
      selected: document.getElementById('trusted-row').classList.contains('trusted-opened'),
      semanticSelected: document.getElementById('trusted-row').getAttribute('aria-current'),
    }));
    if (
      trustedResult?.success !== true
      || trustedResult.fallback !== 'cdp_after_synthetic_no_progress'
      || trustedResult.trusted !== true
      || trustedResult.verified !== true
    ) {
      throw new Error(`actual Agent/content/CDP chain did not complete trusted fallback: ${JSON.stringify(trustedResult)}`);
    }
    if (
      !trustedResult.observedHints?.includes('page_text')
      || !trustedResult.observedHints?.includes('target_state_weak')
    ) {
      throw new Error(`unrelated page/target churn should be retained only as diagnostic hints: ${JSON.stringify(trustedResult)}`);
    }
    if (
      afterTrusted.status !== 'trusted-opened'
      || afterTrusted.ambientStatus !== 'unrelated-chat-churn'
      || !afterTrusted.selected
      || afterTrusted.semanticSelected !== 'true'
    ) {
      throw new Error(`trusted CDP fallback did not activate the row: ${JSON.stringify(afterTrusted)}`);
    }
    if (
      afterTrusted.events.length !== 2
      || afterTrusted.events[0].trusted !== false
      || afterTrusted.events[1].trusted !== true
    ) {
      throw new Error(`expected one synthetic then one trusted event: ${JSON.stringify(afterTrusted.events)}`);
    }
    if (dispatched.map(event => event.type).join(',') !== 'mouseMoved,mousePressed,mouseReleased') {
      throw new Error(`unexpected trusted input sequence: ${JSON.stringify(dispatched)}`);
    }
    if (Object.keys(trustedResult).some(key => key.startsWith('_fallback') || key === '_syntheticClickStartedAt')) {
      throw new Error(`internal click state leaked into the agent result: ${JSON.stringify(trustedResult)}`);
    }

    await page.evaluate(() => { document.getElementById('status').textContent = 'idle'; });
    const dispatchCountBeforeNormal = dispatched.length;
    const normalResult = await agent.executeTool(42, 'click_ax', { ref_id: syntheticMatch[1] });
    const normalState = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      events: window.__syntheticClickEvents,
      selected: document.getElementById('synthetic-row').classList.contains('synthetic-opened'),
    }));
    if (
      normalResult?.success !== true
      || normalResult.trusted !== false
      || normalResult.verified !== true
      || normalResult.observedEffects?.[0] !== 'target_state'
    ) {
      throw new Error(`working synthetic target was not accepted from its local state change: ${JSON.stringify(normalResult)}`);
    }
    if (
      normalState.status !== 'synthetic-opened'
      || !normalState.selected
      || normalState.events.length !== 1
      || normalState.events[0].trusted !== false
    ) {
      throw new Error(`working synthetic click path regressed or double-activated: ${JSON.stringify(normalState)}`);
    }
    if (dispatched.length !== dispatchCountBeforeNormal) {
      throw new Error('working synthetic target unexpectedly received a trusted second click');
    }

    const dispatchCountBeforeDisclosure = dispatched.length;
    const disclosureResult = await agent.executeTool(42, 'click_ax', { ref_id: disclosureMatch[1] });
    const disclosureOpen = await page.evaluate(() => document.getElementById('native-details').open);
    if (
      disclosureResult?.success !== true
      || disclosureResult.trusted !== false
      || !/native\/button-like/.test(disclosureResult.fallbackSkipped || '')
    ) {
      throw new Error(`native disclosure did not stay on its synthetic-only path: ${JSON.stringify(disclosureResult)}`);
    }
    if (!disclosureOpen) {
      throw new Error('synthetic summary click should open the native disclosure exactly once');
    }
    if (dispatched.length !== dispatchCountBeforeDisclosure) {
      throw new Error('native disclosure unexpectedly received a trusted second click');
    }
  } finally {
    cdpClient.attach = originals.attach;
    cdpClient.evaluate = originals.evaluate;
    cdpClient.dispatchMouseEvent = originals.dispatch;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    await session.detach();
  }
});

test('set_checked: Agent.executeTool uses one trusted selector click and then becomes idempotent', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Trusted Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected trusted checkbox ref in AX tree: ${tree?.pageContent}`);

  const originalChrome = globalThis.chrome;
  const originalAttach = cdpClient.attach;
  const originalClickElement = cdpClient.clickElement;
  try {
    globalThis.chrome = {
      runtime: {},
      tabs: {
        async get(tabId) {
          return { id: tabId, url: page.url(), title: 'Trusted checkbox fixture' };
        },
        async query() {
          return [{ id: 42, url: page.url() }];
        },
        async sendMessage(_tabId, message) {
          return call(page, message.action, message.params || {});
        },
      },
    };
    let trustedClicks = 0;
    cdpClient.attach = async () => ({ attached: true });
    cdpClient.clickElement = async (_tabId, selector, options) => {
      if (options?.trustedOnly !== true || options?.requireUnique !== true) {
        throw new Error(`expected trusted-only checkbox click, got: ${JSON.stringify(options)}`);
      }
      trustedClicks += 1;
      const locator = page.locator(selector);
      const box = await locator.boundingBox();
      await locator.click();
      return {
        success: true,
        method: 'cdp-mouse',
        rect: box ? {
          x: Math.round(box.x),
          y: Math.round(box.y),
          w: Math.round(box.width),
          h: Math.round(box.height),
        } : undefined,
      };
    };

    const agent = new Agent({});
    agent._isPdfTab = async () => false;
    agent._currentUrl = async () => page.url();
    const first = await agent.executeTool(42, 'set_checked', { ref_id: match[1], checked: true });
    const eventsAfterFirst = await page.evaluate(() => window.__trustedCheckboxEvents);
    if (
      first?.success !== true
      || first.trusted !== true
      || first.verified !== true
      || first.checkedBefore !== false
      || first.checkedAfter !== true
      || first.changed !== true
      || first.idempotent !== false
      || trustedClicks !== 1
      || eventsAfterFirst.length !== 1
      || eventsAfterFirst[0].trusted !== true
    ) {
      throw new Error(`trusted set_checked transition failed: ${JSON.stringify({ first, trustedClicks, eventsAfterFirst })}`);
    }

    const second = await agent.executeTool(42, 'set_checked', { ref_id: match[1], checked: true });
    if (
      second?.success !== true
      || second.idempotent !== true
      || second.dispatched !== false
      || second.checkedAfter !== true
      || trustedClicks !== 1
    ) {
      throw new Error(`idempotent set_checked repeated a click: ${JSON.stringify({ second, trustedClicks })}`);
    }
  } finally {
    cdpClient.attach = originalAttach;
    cdpClient.clickElement = originalClickElement;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('ax_resolve_rect: trusted fallback eligibility rejects interactive descendants, hidden, mutating, stateful, native, form, and download targets', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const content = String(tree?.pageContent || '');
  const refs = {
    nestedButton: content.match(/listitem "Nested button row" \[(ref_\d+)\]/)?.[1],
    nestedLink: content.match(/listitem "Nested link row" \[(ref_\d+)\]/)?.[1],
    nestedInput: content.match(/listitem "Nested input row" \[(ref_\d+)\]/)?.[1],
    native: content.match(/button "Native button" \[(ref_\d+)\]/)?.[1],
    disclosure: content.match(/"Native disclosure" \[(ref_\d+)\]/)?.[1],
    destructive: content.match(/listitem "Delete account" \[(ref_\d+)\]/)?.[1],
    sendMessage: content.match(/listitem "Send message" \[(ref_\d+)\]/)?.[1],
    orderLunch: content.match(/listitem "Order lunch" \[(ref_\d+)\]/)?.[1],
    bookNow: content.match(/listitem "Book now" \[(ref_\d+)\]/)?.[1],
    indirectDestructive: content.match(/listitem "Delete account indirectly" \[(ref_\d+)\]/)?.[1],
    localizedDestructive: content.match(/listitem "Hesabı sil" \[(ref_\d+)\]/)?.[1],
    statefulRole: content.match(/treeitem "Expandable row" \[(ref_\d+)\]/)?.[1],
    statefulAttribute: content.match(/listitem "Stateful list row" \[(ref_\d+)\]/)?.[1],
    input: content.match(/textbox "Native input" \[(ref_\d+)\]/)?.[1],
    select: content.match(/combobox "Native select" \[(ref_\d+)\]/)?.[1],
    editable: content.match(/textbox "Editable row" \[(ref_\d+)\]/)?.[1],
    download: content.match(/listitem "Export report" \[(ref_\d+)\]/)?.[1],
    form: content.match(/listitem "Form row" \[(ref_\d+)\]/)?.[1],
    covered: content.match(/listitem "Covered row" \[(ref_\d+)\]/)?.[1],
    opacity: content.match(/listitem "Opacity row" \[(ref_\d+)\]/)?.[1],
    pointer: content.match(/listitem "Pointer disabled row" \[(ref_\d+)\]/)?.[1],
    zero: content.match(/listitem "Zero row" \[(ref_\d+)\]/)?.[1],
  };
  const safeRefs = {
    tabindexNegative: content.match(/listitem "Generic row with tabindex minus one wrapper" \[(ref_\d+)\]/)?.[1],
    tabindexZero: content.match(/listitem "Generic row with tabindex zero wrapper" \[(ref_\d+)\]/)?.[1],
    dataAction: content.match(/listitem "Generic data action row" \[(ref_\d+)\]/)?.[1],
    properName: content.match(/listitem "Post Malone" \[(ref_\d+)\]/)?.[1],
  };
  await page.evaluate(() => {
    document.getElementById('opacity-row').style.opacity = '0';
  });
  for (const [label, ref] of Object.entries(refs)) {
    if (!ref) throw new Error(`missing ${label} ref in AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (!result?.success) throw new Error(`${label} ref did not resolve: ${JSON.stringify(result)}`);
    if (result.fallbackEligible !== false || !result.fallbackBlockedReason) {
      throw new Error(`${label} target should be blocked from trusted fallback: ${JSON.stringify(result)}`);
    }
  }
  for (const [label, ref] of Object.entries(safeRefs)) {
    if (!ref) throw new Error(`missing ${label} ref in AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (!result?.success || result.fallbackEligible !== true || result.fallbackBlockedReason) {
      throw new Error(`${label} generic row should remain eligible for trusted fallback: ${JSON.stringify(result)}`);
    }
  }
  for (const label of ['nestedButton', 'nestedLink', 'nestedInput']) {
    const result = await call(page, 'ax_resolve_rect', { ref_id: refs[label], forClickFallback: true });
    if (!/interactive descendant/.test(result.fallbackBlockedReason || '')) {
      throw new Error(`${label} should be blocked specifically by its interactive center descendant: ${JSON.stringify(result)}`);
    }
    if (!result.interactiveDescendantTag) {
      throw new Error(`${label} should report the interactive descendant tag: ${JSON.stringify(result)}`);
    }
  }

  const ordinaryResolve = await call(page, 'ax_resolve_rect', { ref_id: refs.destructive });
  if (
    ordinaryResolve.fallbackEligible !== undefined
    || ordinaryResolve.fallbackState !== undefined
    || ordinaryResolve.fallbackStrongState !== undefined
    || ordinaryResolve.fallbackWeakState !== undefined
    || ordinaryResolve.documentToken !== undefined
  ) {
    throw new Error(`fallback-only metadata leaked into ordinary ref resolution: ${JSON.stringify(ordinaryResolve)}`);
  }
});

test('ax_resolve_rect: English action labels stay blocked under Turkish locale casing', async (page) => {
  await page.addInitScript(() => {
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function (...locales) {
      return original.apply(this, locales.length ? locales : ['tr-TR']);
    };
  });
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const content = String(tree?.pageContent || '');
  const refs = {
    install: content.match(/listitem "Install app" \[(ref_\d+)\]/)?.[1],
    invite: content.match(/listitem "Invite teammate" \[(ref_\d+)\]/)?.[1],
  };
  for (const [label, ref] of Object.entries(refs)) {
    if (!ref) throw new Error(`missing ${label} ref in Turkish-locale AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (
      result?.fallbackEligible !== false
      || !/potentially mutating/.test(result.fallbackBlockedReason || '')
    ) {
      throw new Error(`${label} must remain blocked regardless of default locale casing: ${JSON.stringify(result)}`);
    }
  }
});

// ─── click_ax same-page anchors ─────────────────────────────────────────────
test('click_ax: same-page anchor reports hash and scroll completion', async (page) => {
  await setup(page, 'anchor-click.html');
  const before = await page.evaluate(() => ({ hash: location.hash, scrollY: window.scrollY }));
  if (before.hash !== '') throw new Error(`expected no initial hash, got ${before.hash}`);

  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "References" \[(ref_\d+)\] href="#References"/);
  if (!match) throw new Error(`could not find References link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#References') throw new Error(`expected href #References, got ${resp.href}`);
  if (resp.sameDocumentAnchor !== true) throw new Error(`expected sameDocumentAnchor:true, got ${JSON.stringify(resp)}`);
  if (resp.anchorTarget !== '#References') throw new Error(`expected anchorTarget #References, got ${resp.anchorTarget}`);
  if (!resp.afterUrl || !resp.afterUrl.endsWith('#References')) throw new Error(`expected afterUrl to end with #References, got ${resp.afterUrl}`);
  if (resp.scrollChanged !== true) throw new Error(`expected scrollChanged:true, got ${JSON.stringify(resp)}`);
  if (!(resp.afterScrollY > resp.beforeScrollY)) throw new Error(`expected afterScrollY > beforeScrollY, got ${JSON.stringify(resp)}`);
  if (!/Same-page anchor click completed/i.test(resp.hint || '')) throw new Error(`missing completion hint: ${resp.hint}`);

  const after = await page.evaluate(() => ({ hash: location.hash, scrollY: window.scrollY }));
  if (after.hash !== '#References') throw new Error(`expected page hash #References, got ${after.hash}`);
  if (!(after.scrollY > before.scrollY)) throw new Error(`expected page to scroll, before=${before.scrollY} after=${after.scrollY}`);
});

test('click_ax: base href fragment uses resolved anchor destination', async (page) => {
  await setup(page, 'anchor-base-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "References" \[(ref_\d+)\] href="#References"/);
  if (!match) throw new Error(`could not find References link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#References') throw new Error(`expected raw href #References, got ${resp.href}`);
  if (resp.resolvedHref !== 'https://example.com/docs/#References') throw new Error(`expected resolvedHref to honor <base>, got ${resp.resolvedHref}`);
  if (resp.targetUrl !== 'https://example.com/docs/#References') throw new Error(`expected targetUrl to honor <base>, got ${resp.targetUrl}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`base-resolved off-document href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.navigates !== true) throw new Error(`expected navigates:true, got ${JSON.stringify(resp)}`);
});

test('click_ax: placeholder popup anchor keeps popup guidance', async (page) => {
  await setup(page, 'anchor-popup-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "Options" \[(ref_\d+)\] href="#"/);
  if (!match) throw new Error(`could not find Options link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#') throw new Error(`expected href #, got ${resp.href}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`placeholder href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.opened_popup_likely !== true) throw new Error(`expected opened_popup_likely:true, got ${JSON.stringify(resp)}`);
  if (!/popup-opener/i.test(resp.hint || '')) throw new Error(`expected popup guidance, got: ${resp.hint}`);
  if (/Same-page anchor click completed/i.test(resp.hint || '')) throw new Error(`placeholder popup used same-page anchor hint: ${resp.hint}`);

  const opened = await page.evaluate(() => window.__menuOpened);
  if (opened !== true) throw new Error('expected click handler to run');
});

test('click_ax: hash popup anchor keeps popup guidance', async (page) => {
  await setup(page, 'anchor-popup-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "More" \[(ref_\d+)\] href="#menu"/);
  if (!match) throw new Error(`could not find More link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#menu') throw new Error(`expected href #menu, got ${resp.href}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`popup href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.opened_popup_likely !== true) throw new Error(`expected opened_popup_likely:true, got ${JSON.stringify(resp)}`);
  if (!/popup-opener/i.test(resp.hint || '')) throw new Error(`expected popup guidance, got: ${resp.hint}`);
  if (/Same-page anchor/i.test(resp.hint || '')) throw new Error(`hash popup used same-page anchor hint: ${resp.hint}`);

  const opened = await page.evaluate(() => window.__hashMenuOpened);
  if (opened !== true) throw new Error('expected hash popup click handler to run');
});

// ─── Firefox index/focus parity ───────────────────────────────────────────
test('Firefox: click({index}) matches full interactive ordering and preserves type focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #late { position: absolute; left: 20px; top: 180px; width: 120px; height: 40px; }
      #search { position: absolute; left: 20px; top: 20px; width: 240px; height: 40px; }
    </style>
    <button id="late" onclick="window.__clicked='late'">Later button</button>
    <input id="search" role="combobox" placeholder="Search">`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements?.[0]?.id !== 'search') {
    throw new Error(`expected visually first element to be search input, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected click success, got: ${JSON.stringify(click)}`);
  if (click.tag !== 'INPUT') throw new Error(`expected click index 0 to hit INPUT, got: ${JSON.stringify(click)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'search') throw new Error(`expected search input focus after click, got: ${activeId}`);

  const typed = await call(page, 'type', { text: 'mchiang0610' });
  if (!typed?.success) throw new Error(`expected type success, got: ${JSON.stringify(typed)}`);

  const value = await page.evaluate(() => document.getElementById('search').value);
  if (value !== 'mchiang0610') throw new Error(`expected typed value, got: ${value}`);
});

test('Firefox: indexed shadow-DOM click passes occlusion hit test', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #host { position: absolute; left: 20px; top: 20px; width: 180px; height: 44px; }
      #late { position: absolute; left: 20px; top: 160px; width: 120px; height: 40px; }
    </style>
    <div id="host"></div>
    <button id="late">Later button</button>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<style>button { width: 180px; height: 44px; }</style><button id="shadow-button">Shadow Action</button>';
      root.getElementById('shadow-button').addEventListener('click', () => { window.__shadowClicked = true; });
    </script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const shadowIndex = elements.findIndex(e => e.text === 'Shadow Action');
  if (shadowIndex < 0) throw new Error(`expected shadow button in elements, got: ${JSON.stringify(elements)}`);
  if (elements[shadowIndex].inShadowDOM !== true) {
    throw new Error(`expected inShadowDOM:true, got: ${JSON.stringify(elements[shadowIndex])}`);
  }

  const click = await call(page, 'click', { index: shadowIndex });
  if (!click?.success) throw new Error(`expected shadow click success, got: ${JSON.stringify(click)}`);
  if (click.occluded) throw new Error(`shadow click should not be reported occluded: ${JSON.stringify(click)}`);

  const clicked = await page.evaluate(() => window.__shadowClicked === true);
  if (!clicked) throw new Error('expected shadow button click handler to run');
});

test('Firefox: click-then-type preserves shadow-root input focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #host { position: absolute; left: 20px; top: 20px; width: 220px; height: 44px; }
    </style>
    <div id="host"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<style>input { width: 220px; height: 44px; box-sizing: border-box; }</style><input id="shadow-input" placeholder="Shadow Name">';
    </script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const shadowIndex = elements.findIndex(e => e.id === 'shadow-input');
  if (shadowIndex < 0) throw new Error(`expected shadow input in elements, got: ${JSON.stringify(elements)}`);
  if (elements[shadowIndex].inShadowDOM !== true) {
    throw new Error(`expected inShadowDOM:true, got: ${JSON.stringify(elements[shadowIndex])}`);
  }

  const click = await call(page, 'click', { index: shadowIndex });
  if (!click?.success) throw new Error(`expected shadow input click success, got: ${JSON.stringify(click)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'host') throw new Error(`expected document focus on shadow host, got: ${activeId}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected shadow input type success, got: ${JSON.stringify(typed)}`);

  const value = await page.evaluate(() => document.getElementById('host').shadowRoot.getElementById('shadow-input').value);
  if (value !== 'Ada') throw new Error(`expected typed shadow value, got: ${value}`);
});

test('Firefox: type_text returns an error after focus moves to a noneditable element', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
      #opener { position: absolute; left: 20px; top: 90px; width: 140px; height: 40px; }
    </style>
    <input id="field" placeholder="Name">
    <button id="opener">Open menu</button>`);

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected input click success, got: ${JSON.stringify(click)}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected first type success, got: ${JSON.stringify(typed)}`);

  await page.evaluate(() => document.getElementById('opener').focus());
  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'opener') throw new Error(`expected opener focus, got: ${activeId}`);

  const staleType = await call(page, 'type', { text: ' Lovelace' });
  if (staleType?.success) throw new Error(`expected type failure after button focus, got: ${JSON.stringify(staleType)}`);
  if (!/Focused element <button> is not an editable field/.test(staleType?.error || '')) {
    throw new Error(`expected focused button error, got: ${JSON.stringify(staleType)}`);
  }

  const value = await page.evaluate(() => document.getElementById('field').value);
  if (value !== 'Ada') throw new Error(`expected stale fallback not to mutate input, got: ${value}`);
});

async function assertFullIndexedElementsExcludeModalBackground(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #background { position: absolute; left: 20px; top: 20px; }
      #dialog { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      button { width: 160px; height: 40px; }
    </style>
    <main id="background" aria-hidden="true">
      <button id="background-action" onclick="window.__backgroundClicked = true">Publish</button>
    </main>
    <section id="disabled-zone" inert>
      <button id="inert-action" onclick="window.__inertClicked = true">Archive</button>
    </section>
    <div id="dialog" role="dialog" aria-modal="true">
      <button id="dialog-action" onclick="window.__dialogClicked = true">Create</button>
    </div>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'background-action' || e.id === 'inert-action')) {
    throw new Error(`${label}: expected hidden/inert background controls to be filtered, got: ${JSON.stringify(elements)}`);
  }
  if (elements?.[0]?.id !== 'dialog-action') {
    throw new Error(`${label}: expected dialog action to be first actionable index, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`${label}: expected dialog click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    dialog: window.__dialogClicked === true,
    background: window.__backgroundClicked === true,
    inert: window.__inertClicked === true,
  }));
  if (!state.dialog || state.background || state.inert) {
    throw new Error(`${label}: expected only dialog action to run, got: ${JSON.stringify(state)}`);
  }
}

test('Chrome: full indexed elements exclude inert background controls', async (page) => {
  await assertFullIndexedElementsExcludeModalBackground(page, 'chrome');
});

test('Firefox: full indexed elements exclude inert background controls', async (page) => {
  await assertFullIndexedElementsExcludeModalBackground(page, 'firefox');
});

test('Firefox: blocking overlay resolves sibling dialog content for indexed controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
      #dialog-panel { position: fixed; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #dialog-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <div id="backdrop" data-overlay></div>
    <section id="dialog-panel" role="dialog">
      <button id="dialog-action" onclick="window.__dialogClicked = true">Confirm</button>
    </section>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'page-action')) {
    throw new Error(`expected page action to be filtered behind overlay, got: ${JSON.stringify(elements)}`);
  }
  const dialogIndex = elements.findIndex(e => e.id === 'dialog-action');
  if (dialogIndex < 0) throw new Error(`expected sibling dialog action in elements, got: ${JSON.stringify(elements)}`);

  const click = await call(page, 'click', { index: dialogIndex });
  if (!click?.success) throw new Error(`expected dialog action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    dialog: window.__dialogClicked === true,
  }));
  if (state.page || !state.dialog) {
    throw new Error(`expected only dialog action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: non-modal dialogs do not hide full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #help-widget { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #help-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <aside id="help-widget" role="dialog" aria-label="Help">
      <button id="help-action" onclick="window.__helpClicked = true">Open help</button>
    </aside>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const pageIndex = elements.findIndex(e => e.id === 'page-action');
  const helpIndex = elements.findIndex(e => e.id === 'help-action');
  if (pageIndex < 0 || helpIndex < 0) {
    throw new Error(`expected page and non-modal dialog controls in elements, got: ${JSON.stringify(elements)}`);
  }

  const click = await call(page, 'click', { index: pageIndex });
  if (!click?.success) throw new Error(`expected page action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    help: window.__helpClicked === true,
  }));
  if (!state.page || state.help) {
    throw new Error(`expected only page action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: native non-modal dialog does not hide full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #native-help { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #help-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <dialog id="native-help" open>
      <button id="help-action" onclick="window.__helpClicked = true">Open help</button>
    </dialog>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const pageIndex = elements.findIndex(e => e.id === 'page-action');
  const helpIndex = elements.findIndex(e => e.id === 'help-action');
  if (pageIndex < 0 || helpIndex < 0) {
    throw new Error(`expected page and native non-modal dialog controls in elements, got: ${JSON.stringify(elements)}`);
  }

  const click = await call(page, 'click', { index: pageIndex });
  if (!click?.success) throw new Error(`expected page action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    help: window.__helpClicked === true,
  }));
  if (!state.page || state.help) {
    throw new Error(`expected only page action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: native modal dialog scopes full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #native-modal { width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #modal-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <dialog id="native-modal">
      <button id="modal-action" onclick="window.__modalClicked = true">Confirm</button>
    </dialog>
    <script>document.getElementById('native-modal').showModal();</script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'page-action')) {
    throw new Error(`expected page action to be filtered behind native modal, got: ${JSON.stringify(elements)}`);
  }
  if (elements?.[0]?.id !== 'modal-action') {
    throw new Error(`expected modal action to be first actionable index, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected modal action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    modal: window.__modalClicked === true,
  }));
  if (state.page || !state.modal) {
    throw new Error(`expected only modal action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: type_text rejects non-text input after it receives focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
      #button-input { position: absolute; left: 20px; top: 90px; width: 140px; height: 40px; }
    </style>
    <input id="field" placeholder="Name">
    <input id="button-input" type="button" value="Open" onclick="window.__buttonInputClicked = true">`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const fieldIndex = elements.findIndex(e => e.id === 'field');
  const buttonIndex = elements.findIndex(e => e.id === 'button-input');
  if (fieldIndex < 0 || buttonIndex < 0) throw new Error(`expected both controls in elements, got: ${JSON.stringify(elements)}`);

  const fieldClick = await call(page, 'click', { index: fieldIndex });
  if (!fieldClick?.success) throw new Error(`expected field click success, got: ${JSON.stringify(fieldClick)}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected field type success, got: ${JSON.stringify(typed)}`);

  const buttonClick = await call(page, 'click', { index: buttonIndex });
  if (!buttonClick?.success) throw new Error(`expected button input click success, got: ${JSON.stringify(buttonClick)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'button-input') throw new Error(`expected button input focus, got: ${activeId}`);

  const rejected = await call(page, 'type', { text: ' Lovelace' });
  if (rejected?.success) throw new Error(`expected non-text input type failure, got: ${JSON.stringify(rejected)}`);
  if (!/Focused element <input> is not an editable field/.test(rejected?.error || '')) {
    throw new Error(`expected focused input error, got: ${JSON.stringify(rejected)}`);
  }

  const values = await page.evaluate(() => ({
    field: document.getElementById('field').value,
    button: document.getElementById('button-input').value,
    clicked: window.__buttonInputClicked === true,
  }));
  if (values.field !== 'Ada' || values.button !== 'Open' || !values.clicked) {
    throw new Error(`expected no stale/non-text value mutation, got: ${JSON.stringify(values)}`);
  }
});

test('Firefox: type_text rejects disabled indexed text input fallback', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #disabled-field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
    </style>
    <input id="disabled-field" value="Locked" disabled>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const disabledIndex = elements.findIndex(e => e.id === 'disabled-field');
  if (disabledIndex < 0) throw new Error(`expected disabled field in elements, got: ${JSON.stringify(elements)}`);

  const click = await call(page, 'click', { index: disabledIndex });
  if (!click?.success) throw new Error(`expected disabled field click path to complete, got: ${JSON.stringify(click)}`);

  const activeTag = await page.evaluate(() => document.activeElement?.tagName || '');
  if (activeTag === 'INPUT') throw new Error('disabled input should not receive focus');

  const rejected = await call(page, 'type', { text: ' hacked' });
  if (rejected?.success) throw new Error(`expected disabled input type failure, got: ${JSON.stringify(rejected)}`);

  const value = await page.evaluate(() => document.getElementById('disabled-field').value);
  if (value !== 'Locked') throw new Error(`expected disabled value to remain unchanged, got: ${value}`);
});


registerMessageRecipientNavigationFixtures({ test, firefoxTest, setupContentHtml, call, Agent, FirefoxAgent });

registerRichTextToolbarFixtures({
  test,
  setupContentHtml,
  setupContentFixture,
  call,
  Agent,
  FirefoxAgent,
  cdpClient,
  root,
});

test('SMD: Instagram auto mode downloads the open dialog image, not the feed', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/natgeo/', `<!doctype html>
    <style>
      body { margin: 0; }
      main { display: grid; grid-template-columns: repeat(3, 220px); gap: 12px; }
      main img { width: 220px; height: 220px; object-fit: cover; }
      [role="dialog"] { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.8); }
      [role="dialog"] img { width: 640px; height: 640px; object-fit: contain; }
    </style>
    <main>
      <article>
        ${Array.from({ length: 9 }, (_, i) =>
          `<img width="220" height="220" src="https://cdninstagram.com/feed-${i}.jpg">`
        ).join('')}
      </article>
    </main>
    <div role="dialog" aria-modal="true">
      <img width="640" height="640" src="https://cdninstagram.com/open-dialog-current.jpg">
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'instagram') throw new Error(`expected instagram profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/open-dialog-current\.jpg/.test(auto.urls[0])) {
    throw new Error(`expected dialog image, got ${auto.urls[0]}`);
  }

  const all = await collectSmd(page, 'all');
  if (all.urls.length <= 1) throw new Error(`explicit all mode should still expose bulk media, got ${all.urls.length}`);
});

test('SMD: Instagram focused video keeps blob URL ahead of poster image', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/reel/abc123/', `<!doctype html>
    <style>
      body { margin: 0; }
      main img { width: 220px; height: 220px; display: block; }
      [role="dialog"] { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.85); }
      video { width: 540px; height: 720px; background: #000; }
    </style>
    <main>
      <img width="220" height="220" src="https://cdninstagram.com/feed-still.jpg">
    </main>
    <div role="dialog" aria-modal="true">
      <video width="540" height="720"
        src="blob:https://www.instagram.com/focused-reel-video"
        poster="https://cdninstagram.com/focused-reel-poster.jpg"></video>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'instagram') throw new Error(`expected instagram profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!auto.urls[0].startsWith('blob:https://www.instagram.com/focused-reel-video')) {
    throw new Error(`expected focused blob video before poster, got ${auto.urls[0]}`);
  }
});

test('SMD: main mode orders focused video before poster when caller limits to one', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/p/video123/', `<!doctype html>
    <style>
      body { margin: 0; }
      main article video { width: 640px; height: 640px; background: #000; }
    </style>
    <main>
      <article>
        <video width="640" height="640"
          src="blob:https://www.instagram.com/main-post-video"
          poster="https://cdninstagram.com/main-post-poster.jpg"></video>
      </article>
    </main>`);

  const main = await collectSmd(page, 'main');
  if (main.profile !== 'instagram') throw new Error(`expected instagram profile, got ${main.profile}`);
  if (main.mode !== 'main') throw new Error(`expected main mode, got ${main.mode}`);
  if (!main.urls.length) throw new Error('expected main-mode URLs');
  if (!main.urls[0].startsWith('blob:https://www.instagram.com/main-post-video')) {
    throw new Error(`expected main-mode video before poster, got ${main.urls[0]}`);
  }
});

test('SMD: YouTube focused video prefers signed HTTP video over blob and poster', async (page) => {
  await setupSmd(page, 'https://www.youtube.com/watch?v=abc123', `<!doctype html>
    <script>
      window.ytInitialPlayerResponse = {
        streamingData: {
          formats: [
            { url: 'https://rr1---sn.googlevideo.com/videoplayback?expire=999&mime=video%2Fmp4&itag=18' }
          ]
        }
      };
    </script>
    <style>
      body { margin: 0; }
      #movie_player { width: 960px; height: 540px; }
      #movie_player video { width: 960px; height: 540px; background: #000; }
    </style>
    <div id="movie_player">
      <video width="960" height="540"
        src="blob:https://www.youtube.com/focused-player-video"
        poster="https://i.ytimg.com/vi/abc123/hqdefault.jpg"></video>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'youtube') throw new Error(`expected youtube profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/googlevideo\.com\/videoplayback/.test(auto.urls[0])) {
    throw new Error(`expected signed HTTP video before blob/poster, got ${auto.urls[0]}`);
  }
});

test('SMD: X photo modal wins over background timeline media', async (page) => {
  await setupSmd(page, 'https://x.com/NASA/status/123/photo/1', `<!doctype html>
    <style>
      body { margin: 0; }
      main article img { width: 300px; height: 300px; display: block; margin: 16px; }
      [aria-modal="true"] { position: fixed; inset: 0; display: grid; place-items: center; background: #000; }
      [aria-modal="true"] img { width: 720px; height: 480px; object-fit: contain; }
    </style>
    <main>
      <article data-testid="tweet">
        <div data-testid="tweetPhoto"><img width="300" height="300" src="https://pbs.twimg.com/media/background-one.jpg?name=small"></div>
        <div data-testid="tweetPhoto"><img width="300" height="300" src="https://pbs.twimg.com/media/background-two.jpg?name=small"></div>
      </article>
    </main>
    <div aria-modal="true" role="dialog">
      <div data-testid="tweetPhoto">
        <img width="720" height="480" src="https://pbs.twimg.com/media/current-photo.jpg?name=small">
      </div>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'twitter') throw new Error(`expected twitter profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/current-photo\.jpg\?name=orig/.test(auto.urls[0])) {
    throw new Error(`expected upgraded modal photo URL, got ${auto.urls[0]}`);
  }
});

(async () => {
  let passed = 0, failed = 0;
  const runTests = async (browserType, entries) => {
    const browser = await browserType.launch();
    const context = await browser.newContext();
    for (const t of entries) {
      const page = await context.newPage();
      try {
        await t.fn(page);
        console.log(`  ✓ ${t.name}`);
        passed++;
      } catch (e) {
        console.log(`  ✗ ${t.name}\n    ${e.message}`);
        failed++;
      } finally {
        await page.close();
      }
    }
    await browser.close();
  };

  await runTests(chromium, tests);
  await runTests(playwrightFirefox, firefoxTests);
  console.log(`\n  ${passed} passed, ${failed} failed (${tests.length + firefoxTests.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
})();
