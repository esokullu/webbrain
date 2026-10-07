import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const initialApi = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, documentId: `synthetic-${tabId}`, url: 'https://x.com/account/status/123/photo/1' }] },
  tabs: { get: async id => ({ id, url: 'https://x.com/account/status/123/photo/1' }), sendMessage: async () => ({}) } };
globalThis.chrome = initialApi;
globalThis.browser = initialApi;
const variants = await Promise.all(['chrome', 'firefox'].map(async build => [build,
  (await import(`../src/${build}/src/agent/agent.js`)).Agent, build === 'chrome' ? chromium : firefox]));
const html = `<!doctype html><style>body{margin:0}img{width:500px;height:400px}
[aria-modal=true]{position:fixed;inset:0;background:black}</style>
<main><article data-testid="tweet"><div data-testid="tweetPhoto"><img id="background" src="https://pbs.twimg.com/media/background.jpg"></div></article></main>
<div aria-modal="true" role="dialog"><button id="likes">1575 Likes</button>
<div data-testid="tweetPhoto"><img id="photo" src="https://pbs.twimg.com/media/intended.jpg"></div></div>`;

async function fixture(build, engine, { conflictingScripting = false } = {}) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="red"/></svg>' }));
  const page = await context.newPage();
  await page.goto('https://x.com/account/status/123/photo/1');
  await page.waitForFunction(() => document.getElementById('photo').naturalWidth > 0);
  await page.evaluate(() => {
    window.savedUrls = []; window.anchorClicks = 0;
    window.fetch = async url => { savedUrls.push(url); return { ok: true, blob: async () => new Blob(['photo']) }; };
    HTMLAnchorElement.prototype.click = () => anchorClicks++;
  });
  const calls = [];
  const source = fs.readFileSync(new URL(`../src/${build}/src/agent/social-media-downloader.js`, import.meta.url), 'utf8');
  const api = { storage: { local: area, session: area }, runtime: initialApi.runtime, webNavigation: initialApi.webNavigation,
    tabs: { get: async id => ({ id, url: page.url() }), sendMessage: async () => ({}) } };
  if (build === 'chrome') api.scripting = { async executeScript(request) {
    calls.push({ transport: 'scripting', world: request.world, file: request.files?.[0], func: !!request.func });
    assert.equal(request.world, 'MAIN');
    if (request.files) { await page.addScriptTag({ content: source }); return []; }
    return [{ result: await page.evaluate(request.func, request.args?.[0]) }];
  } };
  else {
    api.tabs.executeScript = async (_tab, request) => {
      calls.push({ transport: 'legacy', file: request.file, code: !!request.code });
      if (request.file) { await page.addScriptTag({ content: source }); return []; }
      return [await page.evaluate(code => (0, eval)(code), request.code)];
    };
    if (conflictingScripting) api.scripting = { async executeScript() { assert.fail('Firefox capture used the wrong execution world'); } };
  }
  globalThis.chrome = api; globalThis.browser = api;
  return { browser, page, calls };
}

function agentWithRun(Agent, tab, url) {
  const provider = { name: 'media capture test', model: 'test', supportsVision: false };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._uncertainTextMutationBlock = async () => null;
  agent._richTextToolbarToolBlock = async () => null;
  agent._finalizeToolResultOnce = async (_tab, _name, _args, result) => result;
  agent._resolveVisionRoute = async () => assert.fail('Bound media cannot use vision fallback');
  const run = { token: `run-${tab}`, url, documents: new Map(), frames: new Map(), events: new Map(), revision: 0,
    gestures: new Set(), gestureLeases: new Map() };
  agent._pageFeedbackRuns = new Map([[tab, run]]);
  return { agent, run };
}

let nextTab = 5800;
for (const [build, Agent, engine] of variants) {
  for (const change of ['counter', 'asset', 'reload']) {
    test(`${build}: actual model capture and handler bind the intended photo across ${change}`, async () => {
      const { browser, page, calls } = await fixture(build, engine);
      const tab = nextTab++, { agent, run } = agentWithRun(Agent, tab, page.url());
      try {
        await agent._capturePageFeedbackModelState(tab);
        const expected = run.modelState.mediaBindings.image;
        assert.ok(expected?.documentToken, 'Before-model capture must yield a private media binding');
        assert.equal(expected.focused, true);
        assert.match(expected.candidates[0].url, /intended/);
        assert.equal(expected.focusScope, 'dialog');
        assert.ok(!JSON.stringify(run.modelState).includes('background.jpg'));
        if (change === 'reload') {
          await page.reload();
          await page.waitForFunction(() => document.getElementById('photo').naturalWidth > 0);
          await page.evaluate(() => {
            window.savedUrls = []; window.anchorClicks = 0;
            window.fetch = async url => { savedUrls.push(url); return { ok: true, blob: async () => new Blob(['photo']) }; };
            HTMLAnchorElement.prototype.click = () => anchorClicks++;
          });
        } else await page.evaluate(kind => {
          document.getElementById('likes').textContent = '1591 Likes';
          if (kind === 'asset') document.getElementById('photo').src = 'https://pbs.twimg.com/media/replacement.jpg';
        }, change);
        agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 0, target: 'button#likes' });
        const result = await agent.executeTool(tab, 'download_social_media', {
          mode: 'auto', target: 'image', expectedMediaBinding: { documentToken: 'invented by model' },
        });
        const effects = await page.evaluate(() => ({ urls: savedUrls, clicks: anchorClicks }));
        if (change === 'counter') {
          assert.equal(result.completedCount, 1);
          assert.deepEqual(effects, { urls: [expected.candidates[0].url], clicks: 1 });
        } else {
          assert.equal(result.noDispatch, true);
          assert.equal(result.errorCode, 'media_binding_changed');
          assert.deepEqual(effects, { urls: [], clicks: 0 });
        }
        assert.equal(calls.filter(call => call.file).length, 2, 'Capture and dispatch must use matching reinjections');
        assert.ok(calls.every(call => build === 'chrome' ? call.transport === 'scripting' && call.world === 'MAIN' : call.transport === 'legacy'));
      } finally { await browser.close(); }
    });
  }

  if (build === 'firefox') test('firefox: model capture prefers legacy isolated transport when scripting is also exposed', async () => {
    const { browser, page, calls } = await fixture(build, engine, { conflictingScripting: true });
    const { agent, run } = agentWithRun(Agent, nextTab++, page.url());
    try {
      await agent._capturePageFeedbackModelState(nextTab - 1);
      assert.ok(run.modelState.mediaBindings.image?.documentToken);
      assert.ok(calls.every(call => call.transport === 'legacy'));
    } finally { await browser.close(); }
  });
}

// Installed MV3 runtime: real chrome.scripting MAIN-world capture and dispatch,
// independent of the API mocks above. All page/media traffic is synthetic.
for (const change of ['counter', 'asset']) {
  test(`installed Chrome MV3: painted X photo ${change === 'counter' ? 'downloads across counter churn' : 'replacement fails before fetch'}`, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webbrain-photo-mv3-'));
    const extension = path.resolve('src/chrome');
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body:
        `<!doctype html><style>body{margin:0}.paint{width:500px;height:400px;
        background-image:url("https://pbs.twimg.com/media/intended.jpg");background-size:cover}
        img{opacity:0;width:100%;height:100%}</style><div role="dialog" aria-modal="true">
        <button id="likes">1575 Likes</button><div data-testid="tweetPhoto" class="paint">
        <img id="photo" src="https://pbs.twimg.com/media/intended.jpg"></div></div>` }));
      await context.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="red"/></svg>' }));
      const photo = await context.newPage();
      await photo.goto('https://x.com/account/status/123/photo/1');
      await photo.waitForFunction(() => document.getElementById('photo').naturalWidth > 0);
      await photo.evaluate(() => {
        window.savedUrls = []; window.anchorClicks = 0;
        window.fetch = async url => { savedUrls.push(url); return { ok: true, blob: async () => new Blob(['photo']) }; };
        HTMLAnchorElement.prototype.click = () => anchorClicks++;
      });
      const ui = await context.newPage();
      await ui.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
      const captured = await ui.evaluate(async () => {
        const { Agent } = await import(chrome.runtime.getURL('src/agent/agent.js'));
        const provider = { name: 'synthetic capture test', model: 'test', supportsVision: false };
        const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
        agent._uncertainTextMutationBlock = async () => null;
        agent._richTextToolbarToolBlock = async () => null;
        agent._finalizeToolResultOnce = async (_tab, _name, _args, result) => result;
        agent._resolveVisionRoute = async () => { throw new Error('Bound media cannot use vision fallback'); };
        const tab = (await chrome.tabs.query({ url: 'https://x.com/account/status/123/photo/1' }))[0];
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        const run = { token: 'synthetic-run', url: tab.url, documents: new Map(frames.map(frame => [frame.frameId, frame.documentId])),
          frames: new Map(), events: new Map(), revision: 0, gestures: new Set(), gestureLeases: new Map() };
        agent._pageFeedbackRuns = new Map([[tab.id, run]]);
        window.captureAgent = agent; window.captureTab = tab.id;
        await agent._capturePageFeedbackModelState(tab.id);
        return { binding: run.modelState.mediaBindings.image, diagnostic: run.modelState.mediaCapture,
          legacyAvailable: typeof chrome.tabs.executeScript, manifest: chrome.runtime.getManifest().manifest_version };
      });
      assert.equal(captured.manifest, 3);
      assert.equal(captured.legacyAvailable, 'undefined');
      assert.equal(captured.diagnostic.targets.image.status, 'bound');
      assert.equal(captured.diagnostic.targets.image.paintCarrierCount, 1);
      assert.equal(captured.binding.focused, true);
      assert.match(captured.binding.candidates[0].url, /intended/);
      assert.ok(captured.binding.sources[0].paintCarrier?.node, 'Bind the actually painted carrier');
      await photo.evaluate(kind => {
        document.getElementById('likes').textContent = '1591 Likes';
        if (kind === 'asset') document.querySelector('.paint').style.backgroundImage = 'url("https://pbs.twimg.com/media/replacement.jpg")';
      }, change);
      const result = await ui.evaluate(async () => {
        captureAgent._queuePageFeedback(captureTab, { kind: 'dom', source: 'page', frameId: 0, target: 'button#likes' });
        return captureAgent.executeTool(captureTab, 'download_social_media', { target: 'image' });
      });
      const effects = await photo.evaluate(() => ({ urls: savedUrls, clicks: anchorClicks }));
      if (change === 'counter') {
        assert.equal(result.completedCount, 1, JSON.stringify(result));
        assert.deepEqual(effects, { urls: [captured.binding.candidates[0].url], clicks: 1 });
      } else {
        assert.equal(result.noDispatch, true);
        assert.equal(result.errorCode, 'media_binding_changed');
        assert.deepEqual(effects, { urls: [], clicks: 0 });
      }
    } finally {
      await context?.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}

for (const [build, Agent] of variants) {
  for (const failure of ['injection_failed', 'capture_failed', 'library_unavailable', 'source_unbound', 'untrusted_diagnostic']) {
    test(`${build}: missing capture reports sanitized ${failure} without a download or page-change retry`, async () => {
      const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
      let injected = false;
      const capture = { bindings: {}, diagnostics: { image: { status: 'unavailable',
        reason: failure === 'untrusted_diagnostic' ? 'https://private.example/secret?token=hidden' : 'source_unbound',
        candidateCount: 200, sourceCount: -1, paintCarrierCount: 'private label', url: 'https://private.example/secret' } },
        status: failure === 'library_unavailable' ? failure : 'unavailable' };
      const inject = () => {
        if (failure === 'injection_failed') throw new Error('private provider error');
        injected = true; return [];
      };
      const read = () => {
        if (failure === 'capture_failed') throw new Error('private page content');
        return capture;
      };
      const testApi = { ...initialApi, tabs: { ...initialApi.tabs } };
      if (build === 'chrome') testApi.scripting = { executeScript: async request =>
        request.files ? inject() : [{ result: read() }] };
      else testApi.tabs.executeScript = async (_tab, request) => request.file ? inject() : [read()];
      globalThis.chrome = testApi; globalThis.browser = testApi;
      const tab = nextTab++, { agent, run } = agentWithRun(Agent, tab, 'https://x.com/account/status/123/photo/1');
      try {
        await agent._capturePageFeedbackModelState(tab);
        assert.deepEqual(run.modelState.mediaBindings, {});
        const metadata = run.modelState.mediaCapture;
        assert.equal(metadata.status, ['injection_failed', 'capture_failed', 'library_unavailable'].includes(failure) ? failure : 'unavailable');
        if (failure === 'source_unbound' || failure === 'untrusted_diagnostic') {
          assert.equal(metadata.targets.image.reason, failure === 'source_unbound' ? 'source_unbound' : 'no_verified_media');
          assert.equal(metadata.targets.image.candidateCount, 128);
          assert.equal(metadata.targets.image.sourceCount, 0);
          assert.ok(!('paintCarrierCount' in metadata.targets.image));
        }
        assert.ok(!JSON.stringify(metadata).includes('private'));
        const result = await agent.executeTool(tab, 'download_social_media', { target: 'image' });
        assert.equal(result.errorCode, 'media_binding_unavailable');
        assert.equal(result.noDispatch, true);
        assert.ok(!result.pageFeedbackPending, 'Unavailable capture is not browser intervention');
        assert.equal(run.passiveSupersessionStreak || 0, 0);
        assert.equal(injected, failure !== 'injection_failed');
        assert.ok(!JSON.stringify(result).includes('private'));
      } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
    });
  }
}

for (const [build, Agent] of variants) {
  for (const change of ['url', 'document', 'steering', 'binding_url', 'identity_failure', 'document_unavailable']) {
    test(`${build}: ${change} drift during capture cannot attach fresh media to an older model snapshot`, async () => {
      const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
      const tab = nextTab++, url = 'https://x.com/account/status/123/photo/1';
      let pageUrl = url, documentId = 'original-document', tabReads = 0;
      const { agent, run } = agentWithRun(Agent, tab, url);
      const api = { ...initialApi, tabs: { ...initialApi.tabs, get: async () => {
        if (++tabReads > 1 && change === 'identity_failure') throw new Error('identity unavailable');
        return { id: tab, url: pageUrl };
      } },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId, url: pageUrl }] } };
      const capture = () => {
        if (change === 'url') pageUrl = 'https://x.com/account/status/456/photo/1';
        if (change === 'document') documentId = 'replacement-document';
        if (change === 'document_unavailable') documentId = undefined;
        if (change === 'steering') agent._steeringRuns = new Map([[tab, { acceptedIds: new Set(['steered']) }]]);
        return { bindings: { image: { schema: 1, pageUrl: change === 'binding_url' ? 'https://x.com/account/status/456/photo/1' : pageUrl,
          focused: true, candidates: [{ url: 'https://pbs.twimg.com/media/intended.jpg', type: 'image' }] } },
          diagnostics: {}, status: 'ready' };
      };
      if (build === 'chrome') api.scripting = { executeScript: async request => request.files ? [] : [{ result: capture() }] };
      else api.tabs.executeScript = async (_tab, request) => request.file ? [] : [capture()];
      globalThis.chrome = api; globalThis.browser = api;
      try {
        await agent._capturePageFeedbackModelState(tab);
        assert.deepEqual(run.modelState.mediaBindings, {});
        assert.equal(run.modelState.mediaCapture.status, change === 'identity_failure' ? 'context_unverified' : 'context_changed');
      } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
    });
  }
}

for (const [build, Agent] of variants) {
  for (const registered of [false, true, 'replacement', 'unavailable', 'inactive', 'token_mismatch', 'run_mismatch']) {
    test(`${build}: absent browser document identity (${registered}) requires a current main frame registration`, async () => {
      const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
      const tab = nextTab++, url = 'https://x.com/account/status/123/photo/1';
      const { agent, run } = agentWithRun(Agent, tab, url);
      if (registered) run.frames.set(0, { token: 'content-token', id: '' });
      const api = { ...initialApi, webNavigation: { getAllFrames: async () => [{ frameId: 0, url }] },
        tabs: { ...initialApi.tabs, get: async () => ({ id: tab, url }), sendMessage: async () => {
          if (registered === 'replacement') run.frames.set(0, { token: 'replacement-token', id: '' });
          return { ready: registered !== 'unavailable', active: registered !== 'inactive',
            documentToken: registered === 'token_mismatch' ? 'new-document' : run.frames.get(0)?.token,
            runToken: registered === 'run_mismatch' ? 'another-run' : run.token };
        } } };
      const read = () => ({ bindings: { image: { pageUrl: url, focused: true, candidates: [], sources: [] } }, diagnostics: {}, status: 'ready' });
      if (build === 'chrome') api.scripting = { executeScript: async request => request.files ? [] : [{ result: read() }] };
      else api.tabs.executeScript = async (_tab, request) => request.file ? [] : [read()];
      globalThis.chrome = api; globalThis.browser = api;
      try {
        await agent._capturePageFeedbackModelState(tab);
        assert.equal(!!run.modelState.mediaBindings.image, registered === true);
        assert.equal(run.modelState.mediaCapture.status, registered === true ? 'ready' : 'context_unverified');
      } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
    });
  }
}

// Real MV3 content messages and actual Agent handlers on an ordinary editor.
// Only monitor registration/feedback delivery are locally owned by this fixture;
// AX generation, private binding, preparation and click/text dispatch are real.
for (const [tool, change] of [['click_ax', 'counter'], ['click_ax', 'recipient'], ['set_field', 'counter'],
  ['type_text', 'counter'], ['press_keys', 'counter'], ['type_text', 'focus'], ['press_keys', 'focus'], ['click', 'stable']]) {
  test(`installed Chrome MV3: generic ${tool} ${change} uses the old private model footprint`, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webbrain-generic-mv3-'));
    const extension = path.resolve('src/chrome');
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await context.route('https://ordinary-editor.test/**', route => route.fulfill({ contentType: 'text/html', body:
        `<!doctype html><style>body{margin:0}section{position:absolute;left:20px;top:20px;width:400px;height:220px}
        #counter{position:absolute;left:260px;top:100px}aside{position:absolute;left:600px;top:100px}</style>
        <section role="region" aria-label="Editor"><h2 id="recipient">Alice</h2><form>
        <label for="caption">Caption</label><input id="caption" value="Original">
        <button id="preview" type="button">Preview</button><span id="counter">100 views</span></form></section>
        <aside><h2 id="sidebar">Trending 20</h2><button id="other-focus">Other control</button></aside>
        <div id="plain" tabindex="0" style="position:absolute;left:20px;top:300px">Plain listener</div>
        <script>window.previewCount=0;window.plainCount=0;window.keyCount=0;
        document.getElementById('preview').onclick=()=>previewCount++;
        document.getElementById('plain').onclick=()=>plainCount++;
        document.getElementById('caption').onkeydown=()=>keyCount++;</script>` }));
      const editor = await context.newPage();
      await editor.goto('https://ordinary-editor.test/editor');
      const ui = await context.newPage();
      await ui.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
      const capture = await ui.evaluate(async ({ tool }) => {
        const { Agent } = await import(chrome.runtime.getURL('src/agent/agent.js'));
        const provider = { name: 'generic MV3 capture', model: 'test', supportsVision: false };
        const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
        const tab = (await chrome.tabs.query({ url: 'https://ordinary-editor.test/editor' }))[0];
        agent.isRunning = () => true;
        agent._checkAbort = () => false;
        agent._uncertainTextMutationBlock = async () => null;
        agent._richTextToolbarToolBlock = async () => null;
        agent._finalizeToolResultOnce = async (_tab, _name, _args, result) => result;
        agent._isPdfTab = async () => false;
        await agent._beginPageFeedbackRun(tab.id, 'fixture');
        const run = agent._pageFeedbackRuns.get(tab.id);
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: runToken => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = message => {
            if (message.action === 'get_page_monitor_state') return Promise.resolve({ active: true, runToken, documentToken: message.documentToken });
            if (message.action === 'page_feedback') return Promise.resolve({ accepted: true });
            return send(message);
          };
        }, args: [run.token] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/page-monitor.js',
          'src/content/accessibility-tree.js', 'src/content/rich-text-toolbar-heuristic.js', 'src/content/content.js'] });
        const registration = await chrome.tabs.sendMessage(tab.id, { target: 'content', action: 'page_monitor_state', active: true }, { frameId: 0 });
        const document = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })).find(frame => frame.frameId === 0);
        agent.pageMonitorState({ tab: { id: tab.id }, frameId: 0, documentId: document.documentId, url: tab.url }, registration.documentToken);
        if (['type_text', 'press_keys'].includes(tool)) await chrome.scripting.executeScript({ target: { tabId: tab.id },
          func: () => document.getElementById('caption').focus() });
        const messages = [{ role: 'user', content: 'Preview the current caption for Alice.' }];
        await agent._capturePageFeedbackModelState(tab.id, messages);
        const content = run.modelState.page?.pageContent || '';
        const line = content.split('\n').find(line => tool === 'click_ax' ? /button.*Preview/.test(line) : /textbox.*Caption/.test(line));
        const refId = /\[(ref_[A-Za-z0-9_-]+)\]/.exec(line || '')?.[1];
        window.genericAgent = agent; window.genericTab = tab.id; window.genericRef = refId;
        return { captured: !!run.modelState.actionBinding, content, refId,
          observationCount: messages.filter(message => message.webbrainAppOwnedKind === 'page_action_observation').length,
          privateTokenInMessages: JSON.stringify(messages).includes(run.modelState.actionBinding?.snapshotToken || 'missing-token') };
      }, { tool });
      assert.equal(capture.captured, true, JSON.stringify(capture));
      if (tool !== 'click') assert.ok(capture.refId, capture.content);
      assert.equal(capture.observationCount, 1);
      assert.equal(capture.privateTokenInMessages, false);
      if (change !== 'stable') await editor.evaluate(change => {
        document.getElementById('counter').textContent = '101 views';
        document.getElementById('sidebar').textContent = 'Trending 21';
        if (change === 'recipient') document.getElementById('recipient').textContent = 'Bob';
        if (change === 'focus') document.getElementById('other-focus').focus();
      }, change);
      const result = await ui.evaluate(async ({ tool, change }) => {
        if (change !== 'stable') genericAgent._queuePageFeedback(genericTab, { kind: 'dom', source: 'page', frameId: 0, target: 'span#counter' });
        const args = tool === 'type_text' ? { text: 'Updated caption' } : tool === 'press_keys' ? { key: 'ArrowRight', repeat: 2 }
          : tool === 'click' ? { selector: '#plain' } : { ref_id: genericRef, ...(tool === 'set_field' ? { text: 'Updated caption' } : {}) };
        return genericAgent.executeTool(genericTab, tool, { ...args, expectedModelSnapshot: 'model cannot supply this' });
      }, { tool, change });
      const effects = await editor.evaluate(() => ({ previews: previewCount, plain: plainCount, keys: keyCount,
        value: document.getElementById('caption').value }));
      if (['recipient', 'focus'].includes(change)) {
        assert.equal(result.noDispatch, true, JSON.stringify(result));
        assert.deepEqual(effects, { previews: 0, plain: 0, keys: 0, value: 'Original' });
      } else {
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(effects.previews, tool === 'click_ax' ? 1 : 0);
        assert.equal(effects.plain, tool === 'click' ? 1 : 0);
        if (tool === 'press_keys') assert.equal(effects.keys, 2);
        if (tool === 'set_field') assert.equal(effects.value, 'Updated caption');
        else if (tool === 'type_text') assert.ok(effects.value.includes('Updated caption'));
        else assert.equal(effects.value, 'Original');
      }
      await ui.evaluate(() => genericAgent._finishPageFeedbackRun(genericTab));
    } finally {
      await context?.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
