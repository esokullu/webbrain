import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVisionSavedDownload } from '../firefox-companion/vision-files.mjs';

const api = { runtime: { getURL: path => path }, storage: { local: { get: async () => ({}) } } };
globalThis.chrome = globalThis.browser = api;
const pdf = Buffer.from('%PDF-1.7\nAn exact owned file.\n');
const image = 'data:image/png;base64,dGVzdA==';
const viewport = { width: 800, height: 600, url: 'https://owned.test/', documentId: 'doc' };
for (const build of ['chrome', 'firefox']) {
  const { runVisionFileTool, VISION_FILE_TOOLS } = await import(`../src/${build}/src/agent/vision-files.js`);
  function fixture() {
    let dispatches = 0, releases = 0, checkpoints = 0;
    const source = { ok: true, base64: pdf.toString('base64'), filename: 'exact.pdf', mimeType: 'application/pdf' };
    const agent = { _resolveUserAttachment: () => source, _hasPendingSteering: () => false };
    const target = { key: 'file-input-1', metadata: { accept: 'application/pdf' } };
    const backend = {
      bind: async () => target, assertTarget: async () => true,
      upload: async (_tab, _target, _source, { beforeDispatch }) => { beforeDispatch(); dispatches++; return { success: true }; },
      uploadedFiles: async () => [{ name: 'exact.pdf', size: pdf.length }],
      release: async () => { releases++; },
    };
    const frames = { latest: { frameId: 'frame', viewport }, toCssPoint: args => {
      assert.equal(args.frameId, 'frame'); return { x: args.x, y: args.y };
    }, assertViewport: value => assert.deepEqual(value, viewport), assertCurrentPixels: async () => true };
    const context = { tabId: 4, name: 'upload_file', args: { frameId: 'frame', x: 100, y: 100, attachmentId: 'current-attachment' },
      browser: { capture: async () => ({ dataUrl: image, viewport }) }, frames, backend, state: {},
      verify: async () => ({ verified: true, allowed: true, provenance: 'independent_visual_review' }),
      authorize: async () => true, checkpoint: async () => { checkpoints++; return true; } };
    return { agent, context, backend, source, target, counts: () => ({ dispatches, releases, checkpoints }) };
  }
  test(`${build}: visual file schemas expose coordinates and exact handles, never selectors or local paths`, () => {
    assert.deepEqual(VISION_FILE_TOOLS.map(tool => tool.function.name), ['upload_file', 'download_resource_from_page', 'download_social_media']);
    for (const tool of VISION_FILE_TOOLS) {
      assert.equal(tool.function.parameters.additionalProperties, false);
      assert.equal(tool.function.parameters.properties.selector, undefined);
      assert.equal(tool.function.parameters.properties.filePath, undefined);
    }
  });
  test(`${build}: exact attachment is delivered once and its durable receipt prevents duplicate upload`, async () => {
    const f = fixture();
    const first = await runVisionFileTool(f.agent, f.context);
    assert.equal(first.result.success, true);
    assert.equal(first.result.attachmentState, 'input_attached');
    assert.equal(first.result.remoteStateVerified, false);
    const repeated = await runVisionFileTool(f.agent, { ...f.context, state: JSON.parse(JSON.stringify(f.context.state)) });
    assert.equal(repeated.result.success, true);
    assert.equal(repeated.result.deduplicated, true);
    assert.equal(f.counts().dispatches, 1);
  });
  test(`${build}: consumed input remains a delivered local attachment, never a reason to resend`, async () => {
    const f = fixture(); f.backend.uploadedFiles = async () => [];
    assert.equal((await runVisionFileTool(f.agent, f.context)).result.attachmentState, 'page_consumed');
    assert.equal((await runVisionFileTool(f.agent, f.context)).result.deduplicated, true);
    assert.equal(f.counts().dispatches, 1);
  });
  test(`${build}: unverified review, failed checkpoint, stale pixels, incompatible bytes and cancellation stop before attachment`, async () => {
    for (const setup of [
      f => { f.context.verify = async () => ({ allowed: true }); },
      f => { f.context.checkpoint = async () => false; },
      f => { f.context.beforeDispatch = async () => false; },
      f => { f.context.frames.assertCurrentPixels = async () => { throw new Error('Target moved'); }; },
      f => { f.source.base64 = Buffer.from('<!doctype html><title>Viewer</title>').toString('base64'); },
      f => { const controller = new AbortController(); controller.abort(); f.context.signal = controller.signal; },
    ]) {
      const f = fixture(); setup(f);
      const { result } = await runVisionFileTool(f.agent, f.context);
      assert.equal(result.success, false); assert.equal(result.dispatched, false);
      assert.equal(f.counts().dispatches, 0);
    }
  });
  test(`${build}: lost upload acknowledgement persists an uncertain receipt and is never replayed`, async () => {
    const f = fixture();
    f.backend.upload = async (_tab, _target, _source, { beforeDispatch }) => { beforeDispatch(); throw new Error('Lost reply'); };
    const first = await runVisionFileTool(f.agent, f.context);
    assert.equal(first.result.outcomeUnknown, true);
    f.backend.upload = async () => assert.fail('Uncertain attachment must not be replayed');
    assert.equal((await runVisionFileTool(f.agent, f.context)).result.deduplicated, true);
  });
  test(`${build}: changed download metadata fails before upload without fetching its source`, async () => {
    const f = fixture(); let reads = 0;
    f.context.args = { frameId: 'frame', x: 100, y: 100, downloadId: 8 };
    api.downloads = { search: async () => [{ id: 8, state: 'complete', exists: true, filename: '/downloads/exact.pdf',
      fileSize: pdf.length, url: ++reads === 1 ? 'https://owned.test/asset' : 'https://owned.test/changed' }] };
    f.backend.readSavedDownload = async () => ({ exists: true, readable: true, size: pdf.length, base64: pdf.toString('base64') });
    const { result } = await runVisionFileTool(f.agent, f.context);
    assert.equal(result.code, 'saved_download_changed'); assert.equal(result.noDispatch, true);
    assert.equal(f.counts().dispatches, 0);
  });
  test(`${build}: guarded chooser receives a fresh independent review, attaches once and never reopens on replay`, async () => {
    const f = fixture(); let clicks = 0, reviews = 0, released = 0;
    f.backend.bind = async () => null;
    f.backend.armChooser = async () => ({ token: 'chooser' });
    f.backend.takeChooser = async () => f.target;
    f.backend.closeChooser = async () => true;
    f.backend.releaseChooser = async () => { released++; };
    f.context.browser.perform = async () => { clicks++; return { success: true }; };
    f.context.observe = async () => (f.context.frames.latest = { frameId: 'new', viewport, canvas: { width: 800, height: 600 } });
    f.context.verify = async proposal => {
      reviews++; assert.equal(proposal.frame.frameId, reviews === 1 ? 'frame' : 'new');
      return { verified: true, allowed: true };
    };
    assert.equal((await runVisionFileTool(f.agent, f.context)).result.success, true);
    assert.equal(clicks, 1); assert.equal(reviews, 2); assert.equal(released, 1); assert.equal(f.counts().dispatches, 1);
    assert.equal((await runVisionFileTool(f.agent, f.context)).result.deduplicated, true);
    assert.equal(clicks, 1); assert.equal(f.counts().dispatches, 1);
  });
  test(`${build}: selected public permalink reuses an enabled original-media provider once, with bounded output and no DOM fallback`, async () => {
    const f = fixture(); let jobs = 0, reviews = 0;
    const tool = { name: 'download_public_media', kind: 'httpDownloadJob', requiresDownloadPermission: true, endpoint: 'https://owned-provider.test/jobs' };
    f.agent._activeSkillToolForName = () => tool;
    f.context.name = 'download_social_media'; f.context.args = { frameId: 'frame', x: 100, y: 100 };
    f.target.metadata = { kind: 'file', url: 'https://x.com/owned/status/123456' };
    f.context.verify = async proposal => { reviews++; if (reviews === 2) assert.equal(proposal.expected.publicMediaUrl, f.target.metadata.url); return { verified: true, allowed: true }; };
    f.context.executeMediaSkill = async (selected, args, context) => {
      jobs++; assert.equal(selected, tool); assert.equal(args.url, f.target.metadata.url); assert.equal(context.tabId, 4);
      return { success: true, downloadId: 81, state: 'complete', metadata: { huge: 'x'.repeat(50000) }, jobId: 'one' };
    };
    const first = await runVisionFileTool(f.agent, f.context);
    assert.equal(first.result.success, true); assert.equal(first.result.completedCount, 1); assert.equal(first.result.browserCookiesSent, false);
    assert.equal(first.result.metadata, undefined); assert.equal(jobs, 1); assert.equal(reviews, 2);
    assert.equal((await runVisionFileTool(f.agent, f.context)).result.deduplicated, true); assert.equal(jobs, 1);
  });
  test(`${build}: missing media provider, feed URL, denied review and ambiguous provider completion never dispatch a replacement download`, async () => {
    for (const scenario of ['disabled', 'feed', 'denied', 'lost']) {
      const f = fixture(); let jobs = 0;
      f.context.name = 'download_social_media'; f.context.args = { frameId: 'frame', x: 100, y: 100 };
      f.target.metadata = { kind: 'file', url: scenario === 'feed' ? 'https://x.com/owned' : 'https://x.com/owned/status/123456' };
      f.agent._activeSkillToolForName = () => scenario === 'disabled' ? null : { kind: 'httpDownloadJob', requiresDownloadPermission: true, endpoint: 'https://owned-provider.test/jobs' };
      f.context.verify = async proposal => ({ verified: true, allowed: !(scenario === 'denied' && proposal.expected.publicMediaUrl) });
      f.context.executeMediaSkill = async () => { jobs++; throw new Error('Lost job creation reply'); };
      assert.equal((await runVisionFileTool(f.agent, f.context)).result.success, false);
      if (scenario === 'lost') assert.equal((await runVisionFileTool(f.agent, f.context)).result.deduplicated, true);
      assert.equal(jobs, scenario === 'lost' ? 1 : 0);
    }
  });
  test(`${build}: ambiguous, missing, aborted or unapproved chooser attaches nothing, cleans up and cannot replay its click`, async () => {
    for (const reason of ['Multiple choosers', 'No chooser', 'abort', 'review']) {
      const f = fixture(), controller = new AbortController(); let clicks = 0, released = 0, reviews = 0;
      f.context.signal = controller.signal;
      f.backend.bind = async () => null;
      f.backend.armChooser = async () => ({ token: 'chooser' });
      f.backend.takeChooser = async () => { if (!['abort', 'review'].includes(reason)) throw new Error(reason); return f.target; };
      f.backend.closeChooser = async () => true;
      f.backend.releaseChooser = async () => { released++; };
      f.context.browser.perform = async () => { clicks++; if (reason === 'abort') controller.abort(); return { success: true }; };
      f.context.observe = async () => (f.context.frames.latest = { frameId: 'new', viewport, canvas: { width: 800, height: 600 } });
      f.context.verify = async () => ({ verified: true, allowed: ++reviews === 1 || reason !== 'review' });
      const first = await runVisionFileTool(f.agent, f.context);
      assert.equal(first.result.success, false, reason); assert.equal(first.result.noDispatch, true);
      assert.equal(first.result.chooserInitialized, true); assert.equal(f.counts().dispatches, 0); assert.equal(released, 1);
      delete f.context.signal;
      assert.equal((await runVisionFileTool(f.agent, f.context)).result.deduplicated, true);
      assert.equal(clicks, 1);
    }
  });
}

test('Firefox companion reads actual saved bytes, bounds prefixes and rejects stale records without a network request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webbrain-vision-saved-'));
  const path = join(directory, 'exact.pdf');
  const run = {}, session = { runs: new Map([['test-run', run]]) };
  try {
    await writeFile(path, pdf);
    const download = { id: 8, filename: path, state: 'complete', fileSize: pdf.length, mime: 'application/pdf' };
    const result = await readVisionSavedDownload(session, 'test-run', download, { readPrefixBytes: 8, maxBytes: 8 });
    assert.equal(result.base64, pdf.subarray(0, 8).toString('base64'));
    assert.equal(result.size, pdf.length); assert.equal(result.dataTruncated, true);
    await assert.rejects(readVisionSavedDownload(session, 'test-run', { ...download, fileSize: pdf.length + 1 }), /no longer matches/);
    await writeFile(path, 'changed');
    await assert.rejects(readVisionSavedDownload(session, 'test-run', download), /no longer matches/);
    session.runs.delete('test-run');
    await assert.rejects(readVisionSavedDownload(session, 'test-run', download), /stopped/);
  } finally { await rm(path, { force: true }); await rmdir(directory); }
});

test('Firefox chooser cleanup remains available after input ownership is aborted', async () => {
  const { firefoxBidi } = await import('../src/firefox/src/bidi/client.js');
  const { createVisionFileBackend } = await import('../src/firefox/src/agent/vision-file-backend.js');
  const original = firefoxBidi.request, controller = new AbortController(), calls = [];
  firefoxBidi.runs.set(92, { runId: 'owned-run', bound: true, signal: controller.signal });
  firefoxBidi.request = async (command, args) => { calls.push({ command, args }); return { token: 'holder' }; };
  try {
    const backend = createVisionFileBackend(), chooser = await backend.armChooser(92, { x: 20, y: 20 });
    controller.abort();
    await backend.releaseChooser(92, chooser);
    assert.equal(calls.at(-1).command, 'visionFileChooserClose');
    assert.deepEqual(calls.at(-1).args, { runId: 'owned-run', token: 'holder', release: true });
  } finally { firefoxBidi.request = original; firefoxBidi.runs.delete(92); }
});
