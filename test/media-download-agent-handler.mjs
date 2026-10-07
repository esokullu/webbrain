import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

// Execute the real browser-specific handler and its injected page wrapper.
// This isolates transport differences without mocking the code under test.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function handler(build) {
  const source = fs.readFileSync(new URL(`../src/${build}/src/agent/agent.js`, import.meta.url), 'utf8');
  const start = source.lastIndexOf("    if (name === 'download_social_media') {");
  const end = source.indexOf(build === 'chrome' ? '    // download_file is now handled' : '    // ─── PDF reader', start);
  assert.ok(start >= 0 && end > start);
  return new AsyncFunction('tabId', 'name', 'args', 'onUpdate', 'executionContext', 'chrome', 'browser', source.slice(start, end));
}

function setup(build, runResult, { binding = null, mseBytes = 100 } = {}) {
  const effects = { run: 0, mseSave: 0, visionRoute: 0, visionSave: 0, opts: null };
  const downloader = {
    async run(opts) { effects.run++; effects.opts = opts; return runResult; },
    _activeProfile: () => ({ name: 'twitter' }),
    getMseRecording: () => ({ orphanBuffers: [{ bytes: mseBytes }] }),
    async saveMse() { effects.mseSave++; return [{ mime: 'video/mp4' }]; },
    _buildRecommendation: () => null,
  };
  const page = { window: { SocialMediaDownloader: downloader, location: { hostname: 'x.com' } },
    location: { href: 'https://x.com/account/status/123/photo/1' } };
  const api = {
    scripting: { async executeScript({ files, func, args }) {
      if (files) return [];
      const result = await vm.runInNewContext(`(${func.toString()})(...injectedArgs)`, { ...page, injectedArgs: args });
      return [{ result }];
    } },
    tabs: { async executeScript(_id, { file, code }) {
      if (file) return [];
      return [await vm.runInNewContext(code, page)];
    } },
  };
  const agent = {
    _activeProvider: () => ({}), providerManager: { getActive: () => ({}) },
    async _resolveVisionRoute() { effects.visionRoute++; return { provider: {} }; },
    async _saveVisibleMediaCrop() { effects.visionSave++; return { success: true, completedCount: 1 }; },
  };
  return { effects, execute: args => handler(build).call(agent, 1, 'download_social_media', args, () => {},
    binding ? { _expectedMediaBinding: binding } : {}, api, api) };
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: media handler forwards trusted binding and propagates noDispatch without fallbacks`, async () => {
    const binding = { schema: 1, documentToken: 'document', candidates: [{ url: 'https://pbs.twimg.com/intended.jpg' }] };
    const failure = { success: false, noDispatch: true, dispatched: false, pageFeedbackPending: true,
      errorCode: 'media_binding_changed', error: 'changed target', urls: [], stats: { triggered: 0, completed: 0 } };
    const { execute, effects } = setup(build, failure, { binding });
    const result = await execute({ mode: 'main', target: 'video', strategy: 'vision' });
    assert.equal(JSON.stringify(effects.opts.expectedMediaBinding), JSON.stringify(binding));
    assert.equal(result.noDispatch, true);
    assert.equal(result.errorCode, 'media_binding_changed');
    assert.equal(result.success, false);
    assert.equal(effects.mseSave, 0);
    assert.equal(effects.visionRoute, 0);
    assert.equal(effects.visionSave, 0);
  });

  test(`${build}: failed bound media does not substitute MSE or vision media`, async () => {
    const binding = { schema: 1, documentToken: 'document' };
    const runResult = { urls: ['https://pbs.twimg.com/intended.jpg'],
      stats: { triggered: 1, completed: 0, completedVideo: 0, openedInTab: 0, failed: 1, failures: [] } };
    const { execute, effects } = setup(build, runResult, { binding });
    const result = await execute({ mode: 'main', target: 'video' });
    assert.equal(result.completedCount, 0);
    assert.equal(result.requestedMediaMissing, true);
    assert.equal(effects.mseSave, 0);
    assert.equal(effects.visionRoute, 0);
    assert.equal(effects.visionSave, 0);
  });

  test(`${build}: unbound legacy video still uses existing MSE fallback`, async () => {
    const runResult = { urls: [], stats: { triggered: 0, completed: 0, completedVideo: 0, openedInTab: 0, failed: 0 } };
    const { execute, effects } = setup(build, runResult);
    const result = await execute({ mode: 'main', target: 'video' });
    assert.equal(result.completedVideoCount, 1);
    assert.equal(effects.mseSave, 1);
    assert.equal(effects.visionSave, 0);
  });

  test(`${build}: model arguments cannot invent a trusted media binding`, async () => {
    const runResult = { urls: [], stats: { triggered: 0, completed: 0, completedVideo: 0, openedInTab: 0, failed: 0 } };
    const { execute, effects } = setup(build, runResult);
    await execute({ mode: 'main', target: 'video', expectedMediaBinding: { documentToken: 'invented' } });
    assert.equal(effects.opts.expectedMediaBinding, undefined);
    assert.equal(effects.mseSave, 1);
  });
}
