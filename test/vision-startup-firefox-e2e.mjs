import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { firefox } from 'playwright';
import { BidiSession } from '../firefox-companion/session.mjs';
import { nativeReplyMessages } from '../firefox-companion/native-messages.mjs';
import { readVisionViewport, captureVision, performVisionInput } from '../firefox-companion/vision.mjs';
import { firefoxBidi } from '../src/firefox/src/bidi/client.js';
import { VisionBrowser } from '../src/firefox/src/agent/vision-browser.js';
import { VisionFrameSession } from '../src/firefox/src/agent/vision-frames.js';
import { bootstrapVisionNewTab } from '../src/firefox/src/agent/vision-bootstrap.js';

// Real Firefox + production extension client + production companion handlers.
// Only native messaging delivery and tabs APIs are bridged to this owned test
// process. No owner is inserted into either client's or companion's run maps.
test('real Firefox: owned new-tab startup binding, first pixels, HTTP native click, and ambiguous/sibling/cancel rejection', { timeout: 120000 }, async () => {
  const server = createServer(async (request, response) => {
    const module = /^\/(vision-frames|image-budget)\.js$/.exec(request.url)?.[1];
    if (module) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(resolve(`src/firefox/src/agent/${module}.js`))); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><style>body{margin:0;background:white}button{position:absolute;left:100px;top:100px;width:200px;height:60px}</style><button id="button">Owned destination</button><script>window.clicks=[];button.onclick=e=>clicks.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY});</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const temporary = await realpath(tmpdir()), profile = await mkdtemp(join(temporary, 'webbrain-vision-startup-firefox-'));
  await writeFile(join(profile, 'user.js'), 'user_pref("layout.css.devPixelsPerPx", "1");\n');
  const child = spawn(process.env.FIREFOX_BINARY || firefox.executablePath(), [
    '--headless', '--remote-allow-system-access', '--no-remote', '--profile', profile, '--remote-debugging-port', '0',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const session = new BidiSession(), originalApi = firefoxBidi.apiOverride;
  const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
  const commands = [], nativeMethods = [], navigations = [], tabs = new Map();
  let nextTab = 100, receive, onDisconnect, portNumber;
  const nativePort = {
    onMessage: { addListener(listener) { receive = listener; } },
    onDisconnect: { addListener(listener) { onDisconnect = listener; } },
    disconnect() { onDisconnect?.(); },
    postMessage(message) {
      commands.push({ command: message.command, runId: message.runId, url: message.url });
      Promise.resolve().then(async () => {
        switch (message.command) {
          case 'connect': return await session.connect(message.port);
          case 'openVisionStartupRun': return await session.openVisionStartupRun(message.runId, message.url);
          case 'closeRun': return await session.closeRun(message.runId);
          case 'visionViewport': return await readVisionViewport(session, message.runId);
          case 'visionCapture': return await captureVision(session, message.runId);
          case 'visionInput': return await performVisionInput(session, message.runId, message.method, message.params, message.viewport, message.release === true);
          default: throw new Error(`Unexpected native startup command: ${message.command}`);
        }
      }).then(result => { for (const reply of nativeReplyMessages({ id: message.id, result })) receive(reply); },
        error => receive({ id: message.id, error: error.message }));
    },
  };
  const api = {
    runtime: { connectNative: () => nativePort, getURL: file => `moz-extension://owned-startup/${file}` },
    storage: { local: { get: async () => ({ firefoxBidiEnabled: true, firefoxBidiPort: portNumber }) } },
    tabs: {
      async get(id) {
        const context = tabs.get(id);
        if (!context) throw new Error('No owned fixture tab');
        const tree = await session.send('browsingContext.getTree', { root: context, maxDepth: 0 });
        assert.equal(tree.contexts?.length, 1);
        return { id, url: tree.contexts[0].url, status: 'complete' };
      },
      async update(id, options) {
        assert.ok(tabs.has(id)); navigations.push({ id, url: options.url });
        await session.send('browsingContext.navigate', { context: tabs.get(id), url: options.url, wait: 'complete' });
        return await api.tabs.get(id);
      },
      executeScript() { throw new Error('Startup must not use a DOM/content-script binding fallback'); },
    },
  };
  const createTab = async initialUrl => {
    console.log(`Firefox startup fixture: opening owned tab ${nextTab + 1}`);
    const existing = tabs.size === 0 ? (await session.send('browsingContext.getTree', { maxDepth: 0 })).contexts?.[0] : null;
    const { context } = existing || await session.send('browsingContext.create', { type: 'tab', referenceContext: tabs.values().next().value, background: true });
    const id = ++nextTab; tabs.set(id, context);
    await session.send('browsingContext.setViewport', { context, viewport: { width: 800, height: 600 } });
    await api.tabs.update(id, { url: initialUrl });
    return id;
  };
  const evaluate = async (id, expression) => {
    const result = await session.send('script.evaluate', { target: { context: tabs.get(id) }, expression, awaitPromise: true });
    if (result.type === 'exception') throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const call = async (id, fn, value) => {
    const result = await session.send('script.callFunction', { target: { context: tabs.get(id) },
      functionDeclaration: fn.toString(), arguments: [{ type: 'string', value: JSON.stringify(value) }], awaitPromise: true });
    if (result.type === 'exception') throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const restrictedCapture = async (browser, tabId) => {
    let failure;
    await assert.rejects(browser.capture(tabId), error => { failure = error; return error.code === 'vision_capture_restricted_target'; });
    return failure;
  };
  try {
    portNumber = await new Promise((resolvePort, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Firefox did not start BiDi: ${output.slice(-1000)}`)), 20000);
      const read = data => {
        output += data;
        const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
      };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Firefox exited ${code}: ${output.slice(-1000)}`)); });
    });
    assert.equal((await session.connect(portNumber)).visionStartupBinding, true);
    const originalSend = session.send.bind(session);
    session.send = (method, params) => { nativeMethods.push(method); return originalSend(method, params); };
    firefoxBidi.apiOverride = api; globalThis.chrome = globalThis.browser = api;
    const controller = new AbortController(), browser = new VisionBrowser({ signal: controller.signal });
    const tabId = await createTab('about:newtab');
    const failure = await restrictedCapture(browser, tabId);
    console.log('Firefox startup fixture: initial restriction confirmed');
    assert.equal(firefoxBidi.runs.get(tabId)?.bound, undefined);
    assert.equal(session.runs.size, 0);
    assert.equal(commands.filter(command => command.command === 'visionCapture').length, 0);
    const before = navigations.length; let checkpoints = 0, receipts = 0;
    const recovery = await bootstrapVisionNewTab(tabId, failure, { api, signal: controller.signal,
      beforeDispatch: async () => { checkpoints++; return true; }, afterDispatch: async () => { receipts++; return true; },
      prepareDestination: id => browser.prepareStartupBootstrap(id) });
    assert.equal(recovery.retry, true); assert.equal(recovery.dispatched, true);
    assert.equal(navigations.length, before + 1); assert.equal(checkpoints, 1); assert.equal(receipts, 1);
    const blankUrl = (await api.tabs.get(tabId)).url;
    assert.match(blankUrl, /^about:blank#wb-vision-[a-f0-9-]{36}$/);
    const blank = await browser.capture(tabId);
    console.log('Firefox startup fixture: native nonce bound and blank captured');
    assert.equal(blank.viewport.url, blankUrl);
    assert.ok(blank.dataUrl.startsWith('data:image/png;base64,'));
    const png = Buffer.from(blank.dataUrl.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 800); assert.equal(png.readUInt32BE(20), 600);
    assert.equal(commands.filter(command => command.command === 'openVisionStartupRun').length, 1);
    const owner = firefoxBidi.runs.get(tabId);
    assert.equal(owner.bound, true); assert.equal(session.runs.get(owner.runId).context, tabs.get(tabId));
    await api.tabs.update(tabId, { url });
    const captured = await browser.capture(tabId);
    assert.equal(captured.viewport.url, url);
    // Run the real frame encoder and target-pixel guard in Firefox, where the
    // canvas APIs are available. The Node adapter still runs its real geometry
    // fence and coordinate mapping against exactly that generated frame.
    const packet = JSON.parse(await call(tabId, async payload => {
      const { captured, blank } = JSON.parse(payload);
      const { VisionFrameSession } = await import('/vision-frames.js');
      globalThis.startupFrames = new VisionFrameSession();
      const image = await createImageBitmap(await (await fetch(blank.dataUrl)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0); image.close();
      const center = [...ctx.getImageData(400, 300, 1, 1).data];
      const packet = await startupFrames.capture(captured.dataUrl, captured.viewport);
      return JSON.stringify({ packet, center });
    }, { captured, blank }));
    assert.deepEqual(packet.center, [255, 255, 255, 255], 'First pixels came from the actual blank compositor capture');
    const frame = new VisionFrameSession(); frame.latest = packet.packet;
    frame.assertCurrentPixels = (dataUrl, viewport, args) => call(tabId, async payload => {
      const { dataUrl, viewport, args } = JSON.parse(payload);
      return await startupFrames.assertCurrentPixels(dataUrl, viewport, args);
    }, { dataUrl, viewport, args });
    const click = await browser.perform(tabId, 'click', { frameId: frame.latest.frameId,
      x: 150 / frame.latest.viewport.width * frame.latest.canvas.width,
      y: 125 / frame.latest.viewport.height * frame.latest.canvas.height }, frame);
    assert.equal(click.success, true, JSON.stringify(click));
    console.log('Firefox startup fixture: HTTP coordinate click delivered');
    assert.deepEqual(JSON.parse(await evaluate(tabId, 'JSON.stringify(clicks)')), [{ trusted: true, x: 150, y: 125 }]);
    assert.equal(commands.filter(command => command.command === 'openVisionStartupRun').length, 1, 'HTTP navigation retains the established native context');
    assert.ok(!commands.some(command => command.command === 'openRun'));
    assert.ok(!nativeMethods.includes('browsingContext.locateNodes'));

    // A sibling's nonce is never accepted by an unrelated extension owner.
    const sibling = await createTab('about:newtab'), siblingBrowser = new VisionBrowser();
    await restrictedCapture(siblingBrowser, sibling);
    const prepared = await siblingBrowser.prepareStartupBootstrap(sibling);
    const wrongTab = await createTab('about:newtab'), wrongBrowser = new VisionBrowser();
    await restrictedCapture(wrongBrowser, wrongTab);
    const wrongPrepared = await wrongBrowser.prepareStartupBootstrap(wrongTab);
    assert.notEqual(prepared.url, wrongPrepared.url);
    await api.tabs.update(wrongTab, { url: prepared.url });
    const opens = commands.filter(command => command.command === 'openVisionStartupRun').length;
    await restrictedCapture(wrongBrowser, wrongTab);
    assert.equal(commands.filter(command => command.command === 'openVisionStartupRun').length, opens);

    // Even a registered nonce cannot select among two matching top-level tabs.
    await api.tabs.update(sibling, { url: prepared.url });
    const inputs = commands.filter(command => command.command === 'visionInput').length;
    await assert.rejects(siblingBrowser.capture(sibling), /stale or ambiguous/);
    assert.equal(firefoxBidi.runs.get(sibling).bound, undefined);
    assert.equal(session.runs.has(firefoxBidi.runs.get(sibling).runId), false);
    assert.equal(commands.filter(command => command.command === 'visionInput').length, inputs);

    // Stop during the durable checkpoint wins before any startup navigation.
    const stoppedTab = await createTab('about:newtab'), stoppedController = new AbortController();
    const stoppedBrowser = new VisionBrowser({ signal: stoppedController.signal });
    const stoppedFailure = await restrictedCapture(stoppedBrowser, stoppedTab), navigationCount = navigations.length;
    await assert.rejects(bootstrapVisionNewTab(stoppedTab, stoppedFailure, { api, signal: stoppedController.signal,
      beforeDispatch: async () => { stoppedController.abort(); return true; },
      prepareDestination: id => stoppedBrowser.prepareStartupBootstrap(id) }), { name: 'AbortError' });
    assert.equal(navigations.length, navigationCount);
    assert.equal((await api.tabs.get(stoppedTab)).url, 'about:newtab');
    assert.equal(firefoxBidi.runs.has(stoppedTab), false);
  } finally {
    for (const tab of [...firefoxBidi.runs.keys()]) firefoxBidi.stopRun(tab);
    await Promise.allSettled([...firefoxBidi.pending.values()].map(() => new Promise(resolve => setTimeout(resolve, 20))));
    firefoxBidi.disconnect(); firefoxBidi.apiOverride = originalApi;
    globalThis.chrome = originalChrome; globalThis.browser = originalBrowser;
    await session.close().catch(() => {});
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    await new Promise(resolve => server.close(resolve));
    const actual = await realpath(profile);
    assert.equal(dirname(actual).toLowerCase(), temporary.toLowerCase()); assert.match(basename(actual), /^webbrain-vision-startup-firefox-/);
    await rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
