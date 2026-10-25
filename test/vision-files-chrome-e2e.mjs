import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, cp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { chromium } from 'playwright';

for (const chooser of [false, true]) test(`installed Chrome: original download → saved-byte read → one native ${chooser ? 'custom-chooser' : 'input'} upload with no refetch`, { timeout: 120000 }, async () => {
  const original = Buffer.from('%PDF-1.7\nThe exact owned download.\n');
  const replacement = Buffer.from('%PDF-1.7\nA different server response.\n');
  let assetReads = 0;
  const received = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/asset') {
      const bytes = ++assetReads === 1 ? original : replacement;
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="exact.pdf"' });
      response.end(bytes); return;
    }
    if (request.url === '/upload') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      received.push(Buffer.concat(chunks)); response.end('saved'); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><style>body{margin:0;background:white}a{position:absolute;left:80px;top:80px;width:200px;height:50px;background:#eee}input,button{position:absolute;left:80px;top:200px;width:300px;height:50px}</style>
      <a href="/asset">Original PDF</a>${chooser ? '<button id="choose">Choose exact file</button>' : '<input type="file" accept="application/pdf" id="file">'}<p id="status" style="position:absolute;top:300px">Waiting</p>
      <script>window.attachments=0;window.chooserClicks=0;
      const receive=input=>input.onchange=async()=>{attachments++;await fetch('/upload',{method:'POST',body:input.files[0]});input.value='';};
      ${chooser ? "choose.onclick=()=>{chooserClicks++;const input=document.createElement('input');input.type='file';input.accept='application/pdf';input.style.display='none';document.body.append(input);receive(input);input.click();}" : 'receive(file);'}</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const temporary = await realpath(tmpdir()), profile = await mkdtemp(join(temporary, 'webbrain-vision-files-chrome-'));
  let context;
  try {
    const extension = join(profile, 'extension');
    await cp(resolve('src/chrome'), extension, { recursive: true });
    // MV3 disallows dynamic imports in a service worker. This fixture entry
    // exposes unchanged production modules in the actual background sender.
    await writeFile(join(extension, 'src', 'vision-file-test-entry.js'), `
      import {runVisionFileTool} from './agent/vision-files.js';
      import {VisionBrowser} from './agent/vision-browser.js';
      import {VisionFrameSession} from './agent/vision-frames.js';
      import {readVisionDownloadedFile} from './agent/vision-capabilities.js';
      import {cdpClient} from './cdp/cdp-client.js';
      globalThis.visionFileTest={runVisionFileTool,VisionBrowser,VisionFrameSession,readVisionDownloadedFile,cdpClient};
    `);
    await appendFile(join(extension, 'src', 'background.js'), "\nimport './vision-file-test-entry.js';\n");
    context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
      acceptDownloads: true, downloadsPath: join(profile, 'downloads'), viewport: null,
      args: ['--window-size=1000,800', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        ...(process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [])] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
    await harness.evaluate(() => chrome.storage.local.set({ agentAllowLocalNetwork: true, screenshotRedaction: false }));
    const page = await context.newPage(); await page.goto(base);
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    let operationTimer;
    const output = await Promise.race([worker.evaluate(async ({ tabId }) => {
      const { runVisionFileTool, VisionBrowser, VisionFrameSession, readVisionDownloadedFile, cdpClient } = globalThis.visionFileTest;
      const browser = new VisionBrowser(), frames = new VisionFrameSession(), state = {}, permissions = [];
      const commands = [], originalSend = cdpClient.sendCommand.bind(cdpClient);
      cdpClient.sendCommand = async (id, method, ...args) => { commands.push(method); return originalSend(id, method, ...args); };
      const agent = { _hasPendingSteering: () => false, _autoScratchpadNote() {}, _pinDownloadId() {} };
      const common = { tabId, browser, frames, state, authorize: async (name, args) => { permissions.push({ name, args }); return true; },
        verify: async () => ({ verified: true, allowed: true, provenance: 'independent_visual_review' }), checkpoint: async () => true };
      const observe = async () => { const capture = await browser.capture(tabId); return frames.capture(capture.dataUrl, capture.viewport, { forceFull: true }); };
      common.observe = observe;
      const coordinate = (x, y) => ({ frameId: frames.latest.frameId,
        x: x / frames.latest.viewport.width * frames.latest.canvas.width,
        y: y / frames.latest.viewport.height * frames.latest.canvas.height });
      await observe();
      const downloaded = await runVisionFileTool(agent, { ...common, name: 'download_resource_from_page', args: coordinate(130, 100) });
      if (!downloaded.result.success) return { downloaded, commands };
      const read = await readVisionDownloadedFile(agent, downloaded.result.downloadId, common);
      await observe();
      const args = { ...coordinate(130, 220), downloadId: downloaded.result.downloadId };
      const upload = await runVisionFileTool(agent, { ...common, name: 'upload_file', args });
      await new Promise(resolve => setTimeout(resolve, 250));
      await observe();
      const repeated = await runVisionFileTool(agent, { ...common, name: 'upload_file', args: { ...coordinate(130, 220), downloadId: args.downloadId } });
      return { downloaded, read, upload, repeated, permissions, commands };
    }, { tabId }), new Promise((_, reject) => { operationTimer = setTimeout(() => {
      reject(new Error('File adapter operation timed out'));
    }, 20000); })]).finally(() => clearTimeout(operationTimer));
    assert.equal(output.downloaded.result.success, true, JSON.stringify(output));
    assert.equal(output.read.success, true, JSON.stringify(output.read));
    assert.equal(output.read.savedFileVerified, true);
    assert.equal(output.read.sourceRefetched, false);
    assert.equal(output.read.base64, original.toString('base64'));
    assert.equal(output.upload.result.success, true, JSON.stringify(output.upload));
    assert.equal(output.repeated.result.deduplicated, true, JSON.stringify(output.repeated));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], original);
    assert.equal(assetReads, 1, 'Upload and saved-byte read must not fetch a changed source URL');
    assert.equal(await page.evaluate(() => attachments), 1);
    assert.equal(await page.evaluate(() => chooserClicks), chooser ? 1 : 0);
    assert.equal(output.upload.result.chooserInitialized, chooser);
    assert.ok(output.permissions.some(item => item.name === 'download_files' && item.args.urls[0] === `${base}/asset`));
    assert.ok(!output.commands.some(method => method.startsWith('Accessibility.') || method === 'DOM.getDocument' || method === 'DOM.querySelector'));
  } finally {
    await context?.close(); await new Promise(resolve => server.close(resolve));
    const actual = await realpath(profile);
    assert.equal(dirname(actual), temporary); assert.ok(basename(actual).startsWith('webbrain-vision-files-chrome-'));
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
