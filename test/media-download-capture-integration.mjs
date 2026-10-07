import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const initialApi = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
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
  const api = { storage: { local: area, session: area }, runtime: initialApi.runtime,
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
