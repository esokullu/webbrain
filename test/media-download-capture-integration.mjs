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
