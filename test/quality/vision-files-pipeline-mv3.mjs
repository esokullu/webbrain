import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// No exported Agent, injected adapter or source patch: public runtime chat,
// installed MV3 background, HTTP provider, independent review and native file IO.
const extension = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION_SOURCE || 'src/chrome');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-files-pipeline-mv3');
await fs.mkdir(out, { recursive: true });
const temp = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(path.join(temp, 'webbrain-vision-file-pipeline-'));
const debug = process.env.WEBBRAIN_QUALITY_DEBUG === '1';
// Windows GPU drivers can hang headless screenshot compositing after large
// browser suites. This opt-in preserves native geometry with software pixels.
const softwareRendering = process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1';
const debugStage = async stage => {
  if (!debug) return;
  console.log(`Visual file pipeline: ${stage}`);
  await fs.writeFile(path.join(out, 'debug-stage.json'), JSON.stringify({ stage, profile, pid: process.pid, time: new Date().toISOString() }, null, 2));
};
const files = ['agent.js', 'vision-act.js', 'vision-files.js', 'vision-file-backend.js', 'vision-file-target.js',
  'vision-review.js', 'vision-runtime-state.js', 'vision-capabilities.js', 'vision-browser.js', 'vision-frames.js'];
const hashSources = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(extension, 'src/agent', file))).digest('hex')])));
const hashes = await hashSources();
const original = Buffer.from('%PDF-1.7\nExact owned pipeline bytes.\n');
const requests = [], reviews = [], failures = [], uploads = [];
const mediaRequests = [];
const mediaBytes = Buffer.from('00000020ftypmp42-owned-final-muxed-file');
let sourceReads = 0, downloadId;
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') : '';
const images = messages => messages.flatMap(message => Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'image_url') : []);
function frames(messages) {
  const found = [];
  const visit = object => {
    if (!object || typeof object !== 'object') return;
    if (object.frameId && object.canvas?.width && object.viewport?.width) found.push(object);
    else Object.values(object).forEach(visit);
  };
  for (const message of messages) for (const line of text(message.content).split('\n')) {
    const start = line.indexOf('{');
    if (start >= 0) try { visit(JSON.parse(line.slice(start))); } catch {}
  }
  return found;
}
const toolResults = input => input.messages.filter(message => message.role === 'tool').map(message => ({
  id: message.tool_call_id, result: JSON.parse(message.content),
}));
function reply(response, input, call) {
  const usage = { prompt_tokens: 100, completion_tokens: 20 };
  if (input.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
    response.end('data: [DONE]\n\n');
  } else {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }], usage }));
  }
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://owned.local');
    if (url.pathname === '/fixture') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html><title>Owned file pipeline</title><style>body{margin:0;font:22px Arial;background:white}h1{position:absolute;left:80px;top:40px}button{position:absolute;left:80px;top:160px;width:300px;height:60px}#status{position:absolute;left:80px;top:260px}</style>
        <h1>Upload one exact PDF to Owned archive</h1><button id="choose">Choose exact PDF</button><a style="position:absolute;left:440px;top:160px;width:350px;height:60px" href="https://www.youtube.com/watch?v=owned-fixture">Owned public media permalink</a><p id="status">Waiting for one file</p><div hidden>HIDDEN_FILE_DOM_SENTINEL</div>
        <script>window.attachments=0;window.chooserClicks=0;window.trustedClicks=[];
        choose.onclick=event=>{chooserClicks++;trustedClicks.push(event.isTrusted);const input=document.createElement('input');input.type='file';input.accept='application/pdf';input.style.display='none';document.body.append(input);
        input.onchange=async()=>{attachments++;const file=input.files[0];await fetch('/upload',{method:'POST',body:file});input.remove();document.querySelector('#status').textContent='Stored '+file.name+' exactly once';};input.click();};</script>`);
      return;
    }
    if (url.pathname === '/asset') {
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="exact.pdf"' });
      response.end(++sourceReads === 1 ? original : Buffer.from('%PDF-1.7\nChanged server response.\n')); return;
    }
    if (url.pathname === '/upload') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      uploads.push(Buffer.concat(chunks)); response.end('stored'); return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    assert.equal(url.pathname, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (!input.tools?.length && input.messages?.length === 1 && input.messages[0].content === 'Hi') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }] })); return;
    }
    assert.equal(input.parallel_tool_calls, false);
    assert.ok(images(input.messages).length, 'Every acting and independent review call retains current image evidence');
    const plain = input.messages.map(message => text(message.content)).join('\n');
    assert.doesNotMatch(plain, /HIDDEN_FILE_DOM_SENTINEL/);
    assert.doesNotMatch(plain, /UNTRUSTED_PROVIDER_METADATA_NOT_SENT/);
    if (input.tools.length === 1 && input.tools[0].function.name === 'vision_review') {
      const proposalText = plain.split('UNTRUSTED_PROPOSAL:\n')[1]?.split('\n')[0];
      const proposal = JSON.parse(proposalText);
      reviews.push({ proposal, frameIds: frames(input.messages).map(frame => frame.frameId) });
      assert.ok(['upload_target', 'download_target'].includes(proposal.kind));
      if (proposal.kind === 'upload_target') assert.equal(proposal.expected.source.downloadId, downloadId);
      if (proposal.expected.publicMediaUrl) assert.equal(proposal.expected.publicMediaUrl, 'https://www.youtube.com/watch?v=owned-fixture');
      assert.match(plain, /Owned archive/);
      reply(response, input, { id: `review-${reviews.length}`, type: 'function', function: { name: 'vision_review',
        arguments: JSON.stringify({ verified: true, allowed: true, reason: 'The owned fixture and exact saved file match the explicit task.' }) } });
      return;
    }
    const current = frames(input.messages).at(-1);
    assert.ok(current?.frameId, 'Provider receives the current canvas and viewport metadata');
    const names = input.tools.map(tool => tool.function.name), prior = toolResults(input);
    assert.ok(names.includes('vision_click'));
    assert.ok(!names.some(name => ['execute_js', 'get_accessibility_tree', 'click_ax', 'read_page'].includes(name)));
    const index = requests.length;
    assert.ok(index < 11, 'The deterministic pipeline must finish without repeated model retries');
    if (index === 0) assert.ok(!names.includes('upload_file'), 'File capabilities load only on request');
    if (index >= 2) {
      const saved = prior.find(item => item.id === 'file-1')?.result;
      assert.equal(saved?.success, true, JSON.stringify(saved));
      downloadId = saved.downloads[0].downloadId;
      assert.equal(saved.downloads[0].state, 'complete');
      assert.match(plain, new RegExp(`Saved download IDs: ${downloadId}`), 'The download handle survives in task scratch memory');
    }
    if (index >= 3) {
      const read = prior.find(item => item.id === 'file-2')?.result;
      assert.equal(read?.success, true, JSON.stringify(read));
      assert.equal(read.savedFileVerified, true); assert.equal(read.sourceRefetched, false);
      assert.equal(read.base64, original.toString('base64'), 'Provider sees actual saved bytes, not a later HTTP response');
    }
    if (index >= 5) {
      const upload = prior.find(item => item.id === 'file-4')?.result;
      assert.equal(upload?.success, true, JSON.stringify(upload));
      assert.equal(upload.chooserInitialized, true); assert.equal(upload.remoteStateVerified, false);
      assert.match(plain, /Exact owned download retained for one upload/);
    }
    if (index >= 6) assert.equal(prior.find(item => item.id === 'file-5')?.result?.deduplicated, true);
    if (index >= 7) {
      const media = prior.find(item => item.id === 'file-6')?.result;
      assert.equal(media?.success, true, JSON.stringify(media)); assert.equal(media.method, 'enabled_public_media_provider');
      assert.equal(media.completedCount, 1); assert.equal(media.metadata, undefined);
    }
    if (index >= 8) assert.equal(prior.find(item => item.id === 'file-7')?.result?.deduplicated, true);
    const point = { frameId: current.frameId, x: 180 / current.viewport.width * current.canvas.width,
      y: 190 / current.viewport.height * current.canvas.height };
    const steps = [
      ['vision_enable_tools', { group: 'files' }],
      ['download_files', { url: origin + '/asset', filename: 'exact.pdf' }],
      ['read_downloaded_file', { downloadId }],
      ['scratchpad_write', { text: 'Exact owned download retained for one upload; downloadId=' + downloadId }],
      ['upload_file', { ...point, downloadId }],
      ['upload_file', { ...point, downloadId }],
      ['download_social_media', { frameId: current.frameId, x: 550 / current.viewport.width * current.canvas.width, y: 185 / current.viewport.height * current.canvas.height }],
      ['download_social_media', { frameId: current.frameId, x: 550 / current.viewport.width * current.canvas.width, y: 185 / current.viewport.height * current.canvas.height }],
      ['done', { frameId: current.frameId, summary: 'Owned file pipeline complete; exact file stored once.', outcome: 'success' }],
    ];
    const [name, args] = steps[Math.min(index, steps.length - 1)];
    assert.ok(names.includes(name), `${name} is advertised after its capability group is enabled`);
    const schema = input.tools.find(tool => tool.function.name === 'upload_file');
    if (schema) {
      assert.equal(schema.function.parameters.properties.selector, undefined);
      assert.equal(schema.function.parameters.properties.filePath, undefined);
    }
    requests.push({ index, name, frameId: current.frameId, images: images(input.messages).length, input });
    reply(response, input, { id: `file-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  } catch (error) {
    console.error(error.message);
    failures.push(error.stack);
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  await debugStage('launching browser');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: null,
    acceptDownloads: true, downloadsPath: path.join(profile, 'downloads'),
    args: ['--window-size=1000,800', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      ...(softwareRendering ? ['--disable-gpu', '--disable-gpu-compositing'] : []),
      ...(debug ? ['--remote-debugging-port=0'] : [])] });
  await debugStage('browser ready');
  if (debug) context.on('console', message => { if (message.text().startsWith('FILE_PIPELINE_DEBUG')) console.log(message.text()); });
  await context.addCookies(['owned-provider.test', 'freeskillz.xyz'].map(domain => ({ name: 'private-provider-cookie', value: 'MUST_NOT_SEND', domain, path: '/', secure: true })));
  await context.route('https://**/*', async route => {
    const request = route.request(), endpoint = new URL(request.url());
    if (!['owned-provider.test', 'freeskillz.xyz'].includes(endpoint.hostname)) return route.abort();
    mediaRequests.push({ method: request.method(), path: endpoint.pathname, cookie: request.headers().cookie, body: request.postData() });
    assert.equal(request.headers().cookie, undefined, 'Public-media jobs must not forward browser cookies');
    if (endpoint.pathname.endsWith('/file')) return route.fulfill({ status: 200, contentType: 'video/mp4',
      headers: { 'Content-Disposition': 'attachment; filename="final-media.mp4"' }, body: mediaBytes });
    const body = request.method() === 'POST' ? { job_id: 'owned-one' }
      : { status: 'complete', metadata: { title: 'UNTRUSTED_PROVIDER_METADATA_NOT_SENT', formats: Array(80).fill('unused') } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await debugStage('waiting for service worker');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await debugStage('opening settings');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  await debugStage('configuring storage');
  const message = (action, data = {}) => panel.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await panel.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true,
    askBeforeConsequentialActions: false, maxAgentSteps: 12, screenshotRedaction: false, openaiAskStreamingEnabled: false }));
  const mediaSkill = await fs.readFile(path.join(extension, 'skills/freeskillz-xyz.md'), 'utf8');
  await panel.evaluate(content => chrome.storage.local.set({ customSkills: [{ id: 'freeskillz-xyz', name: 'FreeSkillz.xyz', enabled: true, content }] }), mediaSkill);
  await debugStage('configuring provider');
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-key',
    baseUrl: origin + '/v1', model: 'openai/gpt-4.1', enabled: true, visionMode: 'on', supportsVision: true, contextWindow: 128000 } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  await debugStage('opening fixture page');
  const page = await context.newPage(); await page.goto(origin + '/fixture');
  const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  await worker.evaluate(debug => {
    globalThis.filePipelineProbe = [];
    const send = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (target, method, params, ...extra) => {
      filePipelineProbe.push({ method, type: params?.type });
      if (debug) console.log('FILE_PIPELINE_DEBUG start ' + method);
      const pending = send(target, method, params, ...extra);
      if (debug) pending?.then?.(() => console.log('FILE_PIPELINE_DEBUG end ' + method), error => console.log('FILE_PIPELINE_DEBUG error ' + method + ': ' + error.message));
      return pending;
    };
  }, debug);
  await debugStage('running public chat');
  let timer;
  const started = Date.now();
  const result = await Promise.race([message('chat', { tabId, requestId: 'owned-file-pipeline', mode: 'act', locale: 'en',
    text: `Download the exact PDF from ${origin}/asset, read the saved file by download ID, remember its ID in task notes, and attach it exactly once to the visible Owned archive upload control. Confirm the saved status. Also download the linked public media once using the enabled media provider. Do not refetch the PDF source URL or repeat either download/upload.` }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Public visual file pipeline exceeded 90 seconds')), 90000); })]).finally(() => clearTimeout(timer));
  await debugStage('public chat completed');
  const probe = await worker.evaluate(() => filePipelineProbe);
  const pageState = await page.evaluate(() => ({ attachments, chooserClicks, trustedClicks, status: document.querySelector('#status').textContent }));
  const persisted = await panel.evaluate(async () => Object.entries(await chrome.storage.local.get(null))
    .filter(([key]) => key.startsWith('webbrain.vision.receipts.v1:')).map(([, value]) => value));
  const artifact = { result, elapsedMs: Date.now() - started, requests, reviews, failures, probe, pageState, persisted, mediaRequests,
    sourceReads, uploads: uploads.map(bytes => ({ length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })), sourceHashes: hashes };
  await fs.writeFile(path.join(out, 'pipeline.json'), JSON.stringify(artifact,
    (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.equal(result.content, 'Owned file pipeline complete; exact file stored once.', JSON.stringify(result));
  assert.equal(sourceReads, 1); assert.equal(uploads.length, 1); assert.deepEqual(uploads[0], original);
  assert.deepEqual(pageState.trustedClicks, [true]); assert.equal(pageState.chooserClicks, 1); assert.equal(pageState.attachments, 1);
  // Playwright's download directory may store browser-reported files under a
  // UUID. The adapter must use that exact saved file, not invent a path/name.
  const attached = toolResults(requests.at(-1).input).find(item => item.id === 'file-4').result.attached;
  assert.equal(pageState.status, `Stored ${attached.name} exactly once`);
  const uploadReviews = reviews.filter(item => item.proposal.kind === 'upload_target');
  assert.equal(uploadReviews.length, 2, 'One review precedes the native chooser click and a second reviews the fresh initialized target');
  assert.notEqual(uploadReviews[0].proposal.frameId, uploadReviews[1].proposal.frameId);
  assert.equal(uploadReviews[1].proposal.expected.chooserInitialized, true);
  assert.equal(mediaRequests.filter(item => item.method === 'POST').length, 1);
  assert.equal(mediaRequests.filter(item => item.path.endsWith('/file')).length, 1);
  assert.equal(mediaRequests.filter(item => item.method === 'DELETE').length, 1);
  assert.equal(JSON.parse(mediaRequests.find(item => item.method === 'POST').body).url, 'https://www.youtube.com/watch?v=owned-fixture');
  assert.ok(persisted.some(state => state.groups.includes('files') && Object.values(state.files.operations).some(entry => entry.status === 'delivered')));
  assert.ok(probe.every(entry => !entry.method.startsWith('Accessibility.') && !['DOM.getDocument', 'DOM.querySelector'].includes(entry.method)));
  assert.equal(probe.filter(entry => entry.method === 'Input.dispatchMouseEvent' && entry.type === 'mousePressed').length, 1);
  assert.deepEqual(await hashSources(), hashes, 'The public runtime test never changes product source');
  console.log(JSON.stringify({ passed: true, modelCalls: requests.length, independentReviews: reviews.length,
    sourceReads, uploads: uploads.length, chooserClicks: pageState.chooserClicks, elapsedMs: artifact.elapsedMs, artifacts: out }, null, 2));
} finally {
  await debugStage('closing browser');
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const actual = await fs.realpath(profile);
  assert.equal(path.dirname(actual), temp); assert.ok(path.basename(actual).startsWith('webbrain-vision-file-pipeline-'));
  await fs.rm(actual, { recursive: true, force: true });
}
