import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { firefox } from 'playwright';
import { BidiSession } from '../firefox-companion/session.mjs';
import { readVisionViewport, captureVision, performVisionInput } from '../firefox-companion/vision.mjs';
import * as native from '../firefox-companion/vision-files.mjs';
import { firefoxBidi } from '../src/firefox/src/bidi/client.js';
import { VisionBrowser } from '../src/firefox/src/agent/vision-browser.js';
import { VisionFrameSession, normalizeVisionViewport } from '../src/firefox/src/agent/vision-frames.js';

for (const chooser of [false, true]) test(`real Firefox: native download → saved-byte read → one native ${chooser ? 'custom-chooser' : 'input'} upload without refetch`, { timeout: 90000 }, async () => {
  const original = Buffer.from('%PDF-1.7\nOwned Firefox saved bytes.\n');
  let assetReads = 0; const uploads = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/asset') {
      const bytes = ++assetReads === 1 ? original : Buffer.from('changed server bytes');
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="exact.pdf"' });
      response.end(bytes); return;
    }
    if (request.url === '/upload') {
      const parts = []; for await (const part of request) parts.push(part);
      uploads.push(Buffer.concat(parts)); response.end('saved'); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><style>body{margin:0}a{position:absolute;left:80px;top:80px;width:200px;height:50px}input,button{position:absolute;left:80px;top:200px;width:300px;height:50px}</style>
      <a href="/asset">Original file</a>${chooser ? '<button id="choose">Choose exact file</button>' : '<input type="file" accept="application/pdf" id="file">'}
      <script>window.attachments=0;window.chooserClicks=0;
      const receive=input=>input.onchange=async()=>{attachments++;await fetch('/upload',{method:'POST',body:input.files[0]});input.value='';};
      ${chooser ? "choose.onclick=()=>{chooserClicks++;const input=document.createElement('input');input.type='file';input.accept='application/pdf';input.style.display='none';document.body.append(input);receive(input);input.showPicker();}" : 'receive(file);'}</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const temporary = await realpath(tmpdir()), profile = await mkdtemp(join(temporary, 'webbrain-vision-files-firefox-'));
  const downloads = join(profile, 'downloads'); await mkdir(downloads);
  await writeFile(join(profile, 'user.js'), [
    ['browser.download.folderList', 2], ['browser.download.dir', downloads], ['browser.download.useDownloadDir', true],
    ['browser.helperApps.neverAsk.saveToDisk', 'application/pdf'], ['pdfjs.disabled', true],
    ['browser.download.alwaysOpenPanel', false], ['browser.download.viewableInternally.enabledTypes', ''],
  ].map(([key, value]) => `user_pref(${JSON.stringify(key)},${JSON.stringify(value)});`).join('\n'));
  const child = spawn(process.env.FIREFOX_BINARY || firefox.executablePath(), [
    '--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const session = new BidiSession(), originalRequest = firefoxBidi.request;
  const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Firefox did not open BiDi: ${output.slice(-1000)}`)), 20000);
      const read = chunk => { output += chunk; const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); } };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.on('error', error => { clearTimeout(timer); reject(error); });
    });
    await session.connect(port);
    const tree = await session.send('browsingContext.getTree', {});
    const context = tree.contexts[0].context;
    await session.send('browsingContext.setViewport', { context, viewport: { width: 800, height: 600 } });
    await session.send('browsingContext.navigate', { context, url, wait: 'complete' });
    const runId = crypto.randomUUID(); session.runs.set(runId, { context, navigation: false });
    const owner = { runId, bound: true }; firefoxBidi.runs.set(71, owner);
    const commands = [], send = session.send.bind(session);
    session.send = (method, params) => { commands.push(method); return send(method, params); };
    firefoxBidi.request = async (command, args) => {
      switch (command) {
        case 'visionViewport': return readVisionViewport(session, args.runId);
        case 'visionCapture': return captureVision(session, args.runId);
        case 'visionInput': return performVisionInput(session, args.runId, args.method, args.params, args.viewport, args.release);
        case 'visionReadSavedDownload': return native.readVisionSavedDownload(session, args.runId, args.download, args.options);
        case 'visionFileBind': return native.bindVisionFileTarget(session, args.runId, args.point, args.kind);
        case 'visionFileChooserArm': return native.armVisionFileChooser(session, args.runId, args.point);
        case 'visionFileChooserTake': return native.takeVisionFileChooser(session, args.runId, args.token);
        case 'visionFileChooserClose': return native.closeVisionFileChooser(session, args.runId, args.token, args.release);
        case 'visionFileAssert': return native.assertVisionFileTarget(session, args.runId, args.token);
        case 'visionFileUpload': return native.uploadVisionFile(session, args.runId, args.token, args.source, args.viewport);
        case 'visionFileReadback': return native.readVisionFileTarget(session, args.runId, args.token);
        case 'visionFileRelease': return native.releaseVisionFileTarget(session, args.runId, args.token);
        default: throw new Error(`Unexpected native command: ${command}`);
      }
    };
    const browser = new VisionBrowser();
    const frame = async () => {
      const captured = await browser.capture(71), bytes = Buffer.from(captured.dataUrl.split(',')[1], 'base64');
      const frames = new VisionFrameSession(); frames.assertCurrentPixels = async () => true;
      frames.latest = { frameId: crypto.randomUUID(), viewport: normalizeVisionViewport(captured.viewport),
        canvas: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }, images: [] };
      // Node has no browser canvas. Pixel/resize encoding is covered by the
      // frame suites; retain actual screenshot geometry for native file tests.
      frames.capture = async (dataUrl, viewport) => {
        const png = Buffer.from(dataUrl.split(',')[1], 'base64');
        return frames.latest = { frameId: crypto.randomUUID(), viewport: normalizeVisionViewport(viewport),
          canvas: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, images: [] };
      };
      return frames;
    };
    const coordinate = (frames, x, y) => ({ frameId: frames.latest.frameId,
      x: x / frames.latest.viewport.width * frames.latest.canvas.width,
      y: y / frames.latest.viewport.height * frames.latest.canvas.height });
    let frames = await frame();
    assert.equal((await browser.perform(71, 'click', coordinate(frames, 130, 100), frames)).success, true);
    const path = join(downloads, 'exact.pdf');
    for (let attempt = 0;; attempt++) {
      if (await stat(path).then(value => value.size === original.length, () => false)) break;
      if (attempt >= 100) throw new Error('The actual Firefox browser download did not finish');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // The native browser performs the download above. This API fixture supplies
    // its known completed record to the unchanged extension adapter.
    const item = { id: 8, filename: path, state: 'complete', exists: true, fileSize: original.length, mime: 'application/pdf', url: `${url}asset` };
    const api = { runtime: { getURL: value => value }, storage: { local: { get: async () => ({}) } }, downloads: { search: async () => [item] } };
    globalThis.chrome = globalThis.browser = api;
    const { runVisionFileTool } = await import('../src/firefox/src/agent/vision-files.js');
    const { readVisionDownloadedFile } = await import('../src/firefox/src/agent/vision-capabilities.js');
    const agent = { _hasPendingSteering: () => false }, state = {};
    const common = { tabId: 71, browser, state, authorize: async () => true,
      observe: async () => { const captured = await browser.capture(71); return frames.capture(captured.dataUrl, captured.viewport); },
      verify: async () => ({ verified: true, allowed: true, provenance: 'independent_visual_review' }), checkpoint: async () => true };
    const read = await readVisionDownloadedFile(agent, 8, common);
    assert.equal(read.success, true, JSON.stringify(read));
    assert.equal(read.savedFileVerified, true); assert.equal(read.base64, original.toString('base64'));
    frames = await frame();
    const first = await runVisionFileTool(agent, { ...common, frames, name: 'upload_file', args: { ...coordinate(frames, 130, 220), downloadId: 8 } });
    assert.equal(first.result.success, true, JSON.stringify(first));
    assert.equal(first.result.chooserInitialized, chooser);
    await new Promise(resolve => setTimeout(resolve, 150));
    frames = await frame();
    const repeated = await runVisionFileTool(agent, { ...common, frames, name: 'upload_file', args: { ...coordinate(frames, 130, 220), downloadId: 8 } });
    assert.equal(repeated.result.deduplicated, true, JSON.stringify(repeated));
    assert.equal(uploads.length, 1); assert.deepEqual(uploads[0], original); assert.equal(assetReads, 1);
    assert.equal(commands.filter(method => method === 'input.setFiles').length, 1);
    assert.ok(!commands.includes('browsingContext.locateNodes'));
  } finally {
    firefoxBidi.request = originalRequest; firefoxBidi.runs.delete(71);
    globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
    await session.close().catch(() => {}); child.kill();
    await new Promise(resolve => child.exitCode != null ? resolve() : child.once('exit', resolve));
    await new Promise(resolve => server.close(resolve));
    const actual = await realpath(profile);
    assert.equal(dirname(actual), temporary); assert.ok(basename(actual).startsWith('webbrain-vision-files-firefox-'));
    await rm(actual, { recursive: true, force: true });
  }
});
