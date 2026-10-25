import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Public runtime messages, the installed production extension and a local
// deterministic provider. Native capture, routing, permissions and navigation
// are not replaced. API wrappers below only record calls before forwarding them.
const extension = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION_SOURCE || 'src/chrome');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-startup-mv3');
await fs.mkdir(out, { recursive: true });
const temp = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(path.join(temp, 'webbrain-vision-startup-'));
const sourceFiles = ['src/background.js', 'src/cdp/cdp-client.js', ...['agent', 'vision-act', 'vision-bootstrap',
  'vision-browser', 'vision-transport', 'vision-frames', 'vision-redaction', 'vision-capture-diagnostics'].map(name => `src/agent/${name}.js`)];
const hashSources = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex')])));
const sourceHashes = await hashSources();
const scenarios = [], failures = [], fixtureRequests = [];
let active, context, panel, worker, origin;
const text = content => typeof content === 'string' ? content : (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const frames = input => input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  .filter(block => block.type === 'text').flatMap(block => {
    try { const value = JSON.parse(block.text); return value.frameId && value.canvas ? [value] : []; } catch { return []; }
  });
const images = input => input.messages.flatMap(message => Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'image_url') : []);
const send = (response, content, call) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content,
    ...(call ? { tool_calls: [{ id: `startup-${active.name}-${active.sequence++}`, type: 'function', function: {
      name: call.name, arguments: JSON.stringify(call.args),
    } }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 30 } }));
};
const server = http.createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/result/')) {
      fixtureRequests.push(request.url);
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><meta charset="utf-8"><title>Owned startup destination</title><style>body{background:white;color:#123;font:32px Arial;margin:60px}</style><h1>Startup navigation verified</h1><p>Real destination screenshot</p><div hidden>STARTUP_HIDDEN_SENTINEL</div>');
      return;
    }
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw), system = text(input.messages?.[0]?.content);
    if (!input.tools?.length && system === 'Hi') return send(response, 'Hi');
    if (!input.tools?.length && system.startsWith('Extract stable user preferences')) return send(response, '{"memories":[]}');
    assert.ok(active, 'A request belongs to the currently running owned scenario');
    if (!input.tools?.length && system.startsWith('Answer one fixed-choice question')) {
      assert.match(system, /Decide what fulfilling the latest message needs/);
      const trusted = JSON.parse(text(input.messages[1].content)).request;
      assert.equal(trusted, active.request);
      active.semanticChecks++;
      return send(response, JSON.stringify({ choice: 'act', evidence: active.evidence }));
    }
    const names = (input.tools || []).map(tool => tool.function.name);
    if (names.includes('request_action_mode')) {
      assert.equal(active.mode, 'auto');
      active.askCalls++;
      assert.equal(active.askCalls, 1, 'Only one Ask handoff, without page actions');
      return send(response, '', { name: 'request_action_mode', args: { mode: 'act', evidence: active.evidence } });
    }
    assert.ok(names.includes('vision_click') || names.length === 1 && names[0] === 'vision_review');
    assert.doesNotMatch(raw, /STARTUP_HIDDEN_SENTINEL/);
    const frame = frames(input).at(-1), suppliedImages = images(input);
    assert.ok(frame && suppliedImages.length, 'Every visual model call receives a real screenshot');
    const tab = await panel.evaluate(id => chrome.tabs.get(id), active.tabId);
    await worker.evaluate(({ scenario, phase }) => startupProbe.push({ kind: 'provider', scenario, phase }),
      { scenario: active.name, phase: names[0] === 'vision_review' ? 'review' : 'acting' });
    if (names.length === 1 && names[0] === 'vision_review') {
      assert.equal(tab.url, active.destination);
      active.reviews++;
      return send(response, '', { name: 'vision_review', args: { verified: true, allowed: true,
        completionVerified: true, reason: 'The owned destination is visible in the actual screenshot.' } });
    }
    assert.ok(!names.some(name => /^(click_ax|type_ax|execute_js|get_accessibility_tree)$/.test(name)));
    if (active.actingCalls++ === 0) {
      assert.equal(frame.kind, 'full');
      assert.equal(tab.url, active.preserveOwnNewtab ? active.initialUrl : 'about:blank');
      assert.equal(frame.viewport.url, tab.url);
      const image = suppliedImages[0].image_url.url;
      const pixels = await panel.evaluate(async dataUrl => {
        const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0); bitmap.close();
        let nonWhite = 0, samples = 0;
        for (let y = 20; y < canvas.height - 20; y += 29) for (let x = 20; x < canvas.width - 20; x += 31) {
          const p = ctx.getImageData(x, y, 1, 1).data; samples++;
          if (p[0] < 245 || p[1] < 245 || p[2] < 245) nonWhite++;
        }
        return { width: canvas.width, height: canvas.height, nonWhite, samples,
          center: [...ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data] };
      }, image);
      assert.ok(pixels.width > 100 && pixels.height > 100 && pixels.samples > 20);
      if (!active.preserveOwnNewtab && !active.privacy) assert.equal(pixels.nonWhite, 0, 'The first image contains actual blank-page pixels');
      if (active.privacy) {
        assert.equal(pixels.nonWhite, pixels.samples, 'The actual owned blank capture is completely privacy masked');
        assert.ok(pixels.center.every((value, index) => Math.abs(value - [32, 33, 36, 255][index]) <= 3));
      }
      active.initialFrame = { frameId: frame.frameId, url: frame.viewport.url, pixels };
      return send(response, '', { name: 'vision_navigate', args: { url: active.destination } });
    }
    assert.equal(tab.url, active.destination);
    assert.equal(frame.viewport.url, active.destination);
    assert.ok(active.actingCalls <= 3, 'Completion does not cause an indefinite loop');
    return send(response, '', { name: 'done', args: { frameId: frame.frameId, outcome: 'success', summary: `Startup verified: ${active.name}.` } });
  } catch (error) {
    failures.push(error.stack);
    if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
let timer;
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1000,800', '--disable-background-networking',
      ...(process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [])] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  panel = await context.newPage(); await panel.goto(`${extensionOrigin}/src/ui/settings.html`);
  const message = (action, data = {}) => panel.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ helpImproveWebBrain: false, feedbackDiagnosticsEnabled: true, actObservation: 'vision',
      planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', systemOneEnabled: false, tracingEnabled: false,
      screenshotRedaction: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, maxAgentSteps: 8,
      openaiAskStreamingEnabled: false, newTabEnabled: false });
    window.startupEvents = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') startupEvents.push(event); });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-startup-fixture',
    baseUrl: `${origin}/v1`, model: 'openai/gpt-4.1', enabled: true, visionMode: 'on', supportsVision: true, contextWindow: 128000 } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  await worker.evaluate(() => {
    globalThis.startupProbe = [];
    for (const [object, name, kind] of [[chrome.debugger, 'attach', 'attach'], [chrome.debugger, 'sendCommand', 'command'], [chrome.tabs, 'update', 'update']]) {
      const original = object[name].bind(object);
      object[name] = (...args) => {
        startupProbe.push(kind === 'command' ? { kind, tabId: args[0]?.tabId, method: args[1] }
          : kind === 'attach' ? { kind, tabId: args[0]?.tabId } : { kind, tabId: args[0], url: args[1]?.url });
        return original(...args);
      };
    }
  });
  for (const scenario of [
    { name: 'direct-act-default-newtab', mode: 'act' },
    { name: 'direct-act-default-newtab-privacy-enabled', mode: 'act', privacy: true },
    { name: 'auto-ask-to-act-default-newtab', mode: 'auto' },
    { name: 'direct-dev-default-newtab', mode: 'dev' },
    { name: 'own-enabled-newtab-preserved', mode: 'act', preserveOwnNewtab: true },
    { name: 'settings-refused-without-mutation', mode: 'act', restricted: true },
  ]) {
    console.log(`Visual startup fixture: ${scenario.name}`);
    await panel.evaluate(({ enabled, privacy }) => chrome.storage.local.set({ newTabEnabled: enabled, screenshotRedaction: privacy }),
      { enabled: !!scenario.preserveOwnNewtab, privacy: !!scenario.privacy });
    const initialUrl = scenario.restricted ? 'chrome://settings/' : scenario.preserveOwnNewtab ? `${extensionOrigin}/newtab/index.html` : 'chrome://newtab/';
    const created = await panel.evaluate(url => chrome.tabs.create({ url, active: true }), initialUrl);
    const expected = scenario.restricted ? 'chrome://settings/' : scenario.preserveOwnNewtab ? initialUrl : 'chrome://new-tab-page/';
    await panel.waitForFunction(({ id, expected }) => chrome.tabs.get(id).then(tab => tab.url === expected && (!tab.pendingUrl || tab.pendingUrl === expected)),
      { id: created.id, expected }, { timeout: 15000 });
    active = { ...scenario, tabId: created.id, initialUrl: expected, destination: `${origin}/result/${scenario.name}`,
      sequence: 0, askCalls: 0, semanticChecks: 0, actingCalls: 0, reviews: 0 };
    active.evidence = `open ${active.destination}`;
    active.request = `Please ${active.evidence} and confirm the visible page. STARTUP_PRIVATE_SENTINEL`;
    await worker.evaluate(() => { startupProbe.length = 0; });
    await panel.evaluate(() => { startupEvents.length = 0; });
    const started = Date.now();
    const result = await Promise.race([message('chat', { tabId: active.tabId, requestId: `owned-${scenario.name}`, mode: scenario.mode,
      locale: 'en', text: active.request }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Startup ${scenario.name} exceeded 60 seconds`)), 60000);
    })]).finally(() => clearTimeout(timer));
    const probe = await worker.evaluate(() => startupProbe);
    const events = await panel.evaluate(() => startupEvents);
    const finalTab = await panel.evaluate(id => chrome.tabs.get(id), active.tabId);
    const descriptor = await message('export_traces', { tabId: active.tabId, full: true });
    const trace = await panel.evaluate(async sessionId => {
      const store = await import('/src/trace/recorder.js');
      const { prepareFeedbackTrace } = await import('/src/trace/feedback-export.js');
      const exported = await prepareFeedbackTrace(store, sessionId, chrome.runtime.getManifest().version);
      return exported ? { type: exported.traceType, screenshots: exported.screenshotCount, data: JSON.parse(await exported.blob.text()) } : null;
    }, descriptor.sessionId);
    scenarios.push({ ...active, request: undefined, evidence: undefined, elapsedMs: Date.now() - started, result, probe, events, trace });
    assert.deepEqual(failures, [], failures.join('\n'));
    const updates = probe.filter(entry => entry.kind === 'update' && entry.tabId === active.tabId && entry.url);
    const captureFailures = trace?.data.runs.flatMap(run => run.events).filter(event => event.data?.note === 'vision_capture_failure') || [];
    assert.ok(trace, 'The production diagnostic trace is exportable');
    assert.equal(trace.type, 'diagnostic'); assert.equal(trace.screenshots, 0);
    assert.doesNotMatch(JSON.stringify(trace), /STARTUP_PRIVATE_SENTINEL|127\.0\.0\.1|chrome:\/\/|data:image|Cannot access a chrome/);
    if (scenario.restricted) {
      assert.equal(active.actingCalls, 0); assert.equal(finalTab.url, expected); assert.deepEqual(updates, []);
      assert.match(result.content, /Visual Act failed/);
      assert.ok(captureFailures.some(event => event.data.extra.code === 'VISION_CAPTURE_RESTRICTED_TARGET'));
      assert.ok(captureFailures.some(event => event.data.extra.captureDiagnostics?.stage === 'debugger_attach'
        && event.data.extra.captureDiagnostics.reason === 'restricted_target' && event.data.extra.captureDiagnostics.browser === 'chrome'));
    } else {
      assert.equal(result.content, `Startup verified: ${active.name}.`, JSON.stringify(result));
      assert.equal(finalTab.url, active.destination);
      assert.deepEqual(updates.map(entry => entry.url), scenario.preserveOwnNewtab ? [active.destination] : ['about:blank', active.destination]);
      assert.equal(fixtureRequests.filter(url => url === `/result/${scenario.name}`).length, 1, 'Navigate dispatches exactly once');
      const providerIndex = probe.findIndex(entry => entry.kind === 'provider' && entry.phase === 'acting');
      assert.ok(probe.slice(0, providerIndex).some(entry => entry.kind === 'command' && entry.method === 'Page.captureScreenshot'));
      assert.ok(!probe.some(entry => entry.kind === 'command' && entry.method.startsWith('Input.')), 'Bootstrap never dispatches input');
      if (scenario.mode === 'auto') {
        assert.equal(active.askCalls, 1); assert.equal(active.semanticChecks, 1);
        assert.deepEqual(events.filter(event => event.type === 'run_mode').map(event => event.data.mode), ['ask', 'act']);
      } else assert.equal(active.askCalls, 0);
      if (!scenario.preserveOwnNewtab) {
        assert.ok(captureFailures.some(event => event.data.extra.code === 'VISION_CAPTURE_RESTRICTED_TARGET'));
        assert.ok(captureFailures.some(event => event.data.extra.captureDiagnostics?.stage === 'debugger_attach'
          && event.data.extra.captureDiagnostics.reason === 'restricted_target' && event.data.extra.captureDiagnostics.browser === 'chrome'));
      }
    }
    await panel.evaluate(id => chrome.tabs.remove(id), active.tabId);
    active = null;
  }
  assert.deepEqual(await hashSources(), sourceHashes, 'No production source is changed by the fixture');
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, installedMV3: true, scenarios, sourceHashes }, null, 2));
  await fs.rm(path.join(out, 'failure.json'), { force: true });
  console.log(JSON.stringify({ passed: true, installedMV3: true, scenarios: scenarios.map(scenario => scenario.name) }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, failures, active, scenarios,
    probe: await worker?.evaluate(() => startupProbe).catch(() => []), events: await panel?.evaluate(() => startupEvents).catch(() => []) }, null, 2));
  throw error;
} finally {
  clearTimeout(timer);
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const actual = await fs.realpath(profile);
  assert.equal(path.dirname(actual), temp); assert.ok(path.basename(actual).startsWith('webbrain-vision-startup-'));
  await fs.rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
