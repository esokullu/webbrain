import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// The installed extension, real provider transport, frame encoder and native
// input are exercised together. The only model is an owned deterministic HTTP
// fixture: this proves the visual transport contract, not model intelligence.
const extension = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION_SOURCE || 'src/chrome');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-act-mv3');
await fs.mkdir(out, { recursive: true });
const tempRoot = await fs.realpath(os.tmpdir());
const profileRoot = await fs.mkdtemp(path.join(tempRoot, 'webbrain-vision-act-'));
const sourceFiles = ['agent.js', 'vision-act.js', 'vision-browser.js', 'vision-frames.js', 'vision-transport.js', 'vision-redaction.js', 'vision-dev.js',
  'vision-review.js', 'vision-capabilities.js', 'vision-files.js', 'vision-evidence.js', 'vision-captcha.js', 'vision-dev-capabilities.js', 'vision-runtime-state.js'];
const hashSources = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name =>
  [name, createHash('sha256').update(await fs.readFile(path.join(extension, 'src/agent', name))).digest('hex')])));
const sourceBefore = await hashSources();
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
const framesIn = messages => {
  const found = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.frameId === 'string' && value.canvas?.width && value.canvas?.height) found.push(value);
    else for (const child of Object.values(value)) visit(child);
  };
  for (const message of messages || []) {
    const blocks = Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text)
      : [message.content];
    for (const block of blocks) {
      if (typeof block !== 'string' || !block.includes('frameId')) continue;
      // Metadata remains ordinary provider-visible text. Accept a leading
      // untrusted-content label, without depending on the prompt's wording.
      for (let index = block.indexOf('{'); index >= 0; index = block.indexOf('{', index + 1)) {
        let depth = 0, quoted = false, escape = false;
        for (let end = index; end < block.length; end++) {
          const char = block[end];
          if (quoted) { if (escape) escape = false; else if (char === '\\') escape = true; else if (char === '"') quoted = false; }
          else if (char === '"') quoted = true;
          else if (char === '{') depth++;
          else if (char === '}' && --depth === 0) {
            try { visit(JSON.parse(block.slice(index, end + 1))); } catch {}
            index = end; break;
          }
        }
      }
    }
  }
  return found;
};
const screenshotsIn = messages => (messages || []).flatMap(message => Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'image_url').map(block => block.image_url?.url) : []);
async function bounded(promise, label, milliseconds = 90000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const cases = [
  { id: 'desktop', viewport: { width: 1280, height: 900 }, dpr: 1, action: 'chat' },
  { id: 'retina', viewport: { width: 1440, height: 960 }, dpr: 2, action: 'chat_stream' },
  { id: 'zoom125', viewport: { width: 1600, height: 1000 }, dpr: 1, zoom: 1.25, action: 'chat' },
  { id: 'dev', viewport: { width: 1280, height: 900 }, dpr: 1, mode: 'dev', action: 'chat' },
];
let activeCase, activePage, beforeNavigation;
const requests = [], reviews = [], failures = [], submissions = [];
const pageHtml = `<!doctype html><meta charset="utf-8"><title>Owned visual form</title>
<style>*{box-sizing:border-box}body{font:20px Arial;margin:0;background:#fff;min-height:1800px}h1{position:absolute;left:80px;top:35px}label{position:absolute;left:80px;top:120px}input{position:absolute;left:80px;top:160px;width:360px;height:50px;font:22px Arial}button{position:absolute;left:80px;top:260px;width:220px;height:60px;font:22px Arial}#result{position:absolute;left:520px;top:165px;width:300px;height:100px;padding:16px;background:#ddd}#lower{position:absolute;left:80px;top:1200px;font-size:28px}</style>
<h1>Visual browser test</h1><label>Name</label><input id="name" aria-label="DOM_ONLY_SENTINEL_NEVER_SEND"><button id="save">Save visually</button><div id="result">Not saved</div><p id="lower">Lower viewport marker</p><div hidden>AX_HIDDEN_SENTINEL_NEVER_SEND</div>
<script>window.inputEvents=[];for(const type of ['mousedown','mouseup','click','keydown','input'])document.addEventListener(type,event=>inputEvents.push({type,trusted:event.isTrusted,target:event.target.id}));document.querySelector('#save').onclick=async()=>{const value=document.querySelector('#name').value;await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value})});const badge=document.querySelector('#result');badge.textContent='Saved: '+value;badge.style.background='#8ce19c';};</script>`;
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://owned.local');
    if (url.pathname === '/form') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(pageHtml); return; }
    if (url.pathname === '/finished') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>Vision finished</title><h1 style="font:36px Arial;color:green">Visual task completed</h1>'); return; }
    if (url.pathname === '/diagnostic-probe') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"private":"OWNED_BODY_NOT_RETURNED"}'); return; }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (url.pathname === '/submit') { submissions.push({ case: activeCase.id, ...JSON.parse(raw) }); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return; }
    assert.equal(url.pathname, '/v1/chat/completions', 'Only owned pages and provider requests are allowed');
    const input = JSON.parse(raw);
    console.log(`Owned provider request: ${activeCase?.id || 'startup'} tools=${input.tools?.length || 0}`);
    if (!input.tools?.length && input.messages?.length === 1 && input.messages[0].content === 'Hi') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }] })); return;
    }
    assert.ok(activeCase, 'Task inference requires an active owned case');
    assert.equal(input.parallel_tool_calls, false, 'Real provider requests must ask for one visual tool call');
    if (input.tools?.length === 1 && input.tools[0].function.name === 'vision_review') {
      assert.ok(screenshotsIn(input.messages).length, 'Independent reviews use current screenshots');
      reviews.push({ case: activeCase.id, images: screenshotsIn(input.messages).length });
      const call = { id: `review-${reviews.length}`, type: 'function', function: { name: 'vision_review',
        arguments: JSON.stringify({ verified: true, allowed: true, reason: 'The owned non-message form action or explicit diagnostic request is authorized.' }) } };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      return;
    }
    assert.ok(input.tools?.some(tool => tool.function.name === 'vision_click'), `${activeCase.mode || 'act'} must advertise vision tools`);
    assert.ok(!input.tools.some(tool => /^(get_accessibility_tree|click_ax|type_ax|read_page|execute_js|browser_batch)$/.test(tool.function.name)));
    const images = screenshotsIn(input.messages), frames = framesIn(input.messages), frame = frames.at(-1);
    assert.ok(images.length >= 1, 'The first and every subsequent model call retain visual evidence');
    assert.ok(frame?.frameId, 'Provider must see coordinate metadata for the latest observation');
    assert.ok(images.every(url => /^data:image\/(jpeg|webp|png);base64,/.test(url)));
    const plain = input.messages.map(message => textContent(message.content)).join('\n');
    assert.doesNotMatch(plain, /AX_HIDDEN_SENTINEL_NEVER_SEND|DOM_ONLY_SENTINEL_NEVER_SEND/);
    const count = requests.filter(item => item.case === activeCase.id).length;
    assert.ok(count < 12, 'The fixture cannot silently retry forever');
    const navigationRequest = requests.find(item => item.case === activeCase.id && item.next.name === 'vision_navigate');
    if (navigationRequest) {
      const receipts = input.messages.filter(message => message.role === 'tool');
      const navigation = receipts.find(message => message.tool_call_id === `vision-${activeCase.id}-${navigationRequest.index}`);
      const deferred = receipts.find(message => message.tool_call_id === `vision-${activeCase.id}-${navigationRequest.index}-wait`);
      assert.equal(JSON.parse(navigation.content).navigated, true, 'The next request must retain the one navigation receipt');
      const deferredResult = JSON.parse(deferred.content);
      assert.equal(deferredResult.code, 'vision_batch_deferred');
      assert.equal(deferredResult.noDispatch, true); assert.equal(deferredResult.dispatched, false);
      assert.equal(deferredResult.outcomeUnknown, false);
      assert.notEqual(frame.frameId, navigationRequest.frames.at(-1).frameId, 'The next request must use a new navigation frame');
      assert.equal(frame.viewport.url, origin + '/finished');
      assert.ok(frames.some(packet => packet.kind === 'full' && packet.viewport.url === origin + '/finished'));
    }
    if (activeCase.mode === 'dev' && count === 0) {
      // Owned fixture activity after the real Dev collectors start. The agent
      // receives only its bounded diagnostic tools, never this test script.
      await activePage.evaluate(async url => {
        console.info('OWNED_VISUAL_DEV_DIAGNOSTIC');
        await fetch(url, { headers: { 'x-owned-private': 'OWNED_HEADER_NOT_RETURNED' } });
      }, origin + '/diagnostic-probe');
    }
    const css = frame.viewport;
    const cssWidth = css.cssWidth || css.width || activeCase.viewport.width;
    const cssHeight = css.cssHeight || css.height || activeCase.viewport.height;
    const point = (x, y) => ({ frameId: frame.frameId, x: x * frame.canvas.width / cssWidth, y: y * frame.canvas.height / cssHeight });
    const steps = [
      { name: 'vision_click', args: point(220, 185) },
      { name: 'vision_type', args: { frameId: frame.frameId, text: 'Vision only 42' } },
      { name: 'vision_key', args: { frameId: frame.frameId, key: 'Tab' } },
      { name: 'vision_click', args: point(190, 290) },
      { name: 'vision_observe', args: {} },
      { name: 'vision_scroll', args: { ...point(900, 600), deltaY: 650 } },
      { name: 'vision_navigate', args: { url: origin + '/finished' } },
      { name: 'done', args: { frameId: frame.frameId, summary: 'Owned visual task complete.', outcome: 'success' } },
    ];
    if (activeCase.mode === 'dev') steps.unshift(
      { name: 'vision_enable_tools', args: { group: 'dev' } },
      { name: 'read_console', args: { levels: ['info'], limit: 10 } },
      { name: 'inspect_network_requests', args: { urlPattern: '/diagnostic-probe', limit: 10 } },
    );
    const step = steps[count] || { name: 'done', args: {
      frameId: frame.frameId, summary: 'Owned visual task complete.', outcome: 'success',
    } };
    if (step.name === 'vision_navigate') beforeNavigation.push(await activePage.evaluate(() => ({
      value: document.querySelector('#name')?.value, result: document.querySelector('#result')?.textContent,
      scrollY, dpr: devicePixelRatio, inputEvents,
    })));
    const tool = input.tools.find(tool => tool.function.name === step.name);
    assert.ok(tool, `${step.name} must be advertised`);
    const record = { case: activeCase.id, index: count, model: input.model, stream: input.stream === true,
      frames, imageCount: images.length, imageBytes: images.reduce((sum, url) => sum + Buffer.from(url.split(',')[1], 'base64').length, 0),
      tools: input.tools.map(tool => tool.function.name), next: step, input };
    requests.push(record);
    const call = { id: `vision-${activeCase.id}-${count}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } };
    // Reproduce a provider ignoring parallel_tool_calls:false. Only navigation
    // may execute; the wait is explicitly deferred until a new screenshot.
    const calls = step.name === 'vision_navigate' ? [call, { id: `${call.id}-wait`, type: 'function',
      function: { name: 'vision_wait', arguments: JSON.stringify({ milliseconds: 3000 }) } }] : [call];
    record.returnedTools = calls.map(item => item.function.name);
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((item, index) => ({ index, ...item })) }, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: calls }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    }
  } catch (error) {
    failures.push(error.stack); if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
const results = [];
try {
  for (const entry of cases) {
    activeCase = entry;
    console.log(`Running installed visual ${entry.mode || 'act'} ${entry.id}: ${entry.viewport.width}x${entry.viewport.height} @ ${entry.dpr}x`);
    context = await chromium.launchPersistentContext(path.join(profileRoot, entry.id), {
      headless: true, channel: 'chromium', viewport: entry.viewport, deviceScaleFactor: entry.dpr,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking', '--disable-sync',
        ...(process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [])],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    console.log('Extension service worker loaded');
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
    console.log('Extension settings page loaded');
    const message = (action, data = {}) => bounded(panel.evaluate(({ action, data }) =>
      chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data }), `Extension ${action}`);
    await panel.evaluate(async () => {
      await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false,
        planReviewMode: 'never', systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true,
        askBeforeConsequentialActions: false, maxAgentSteps: 12, openaiAskStreamingEnabled: false });
      window.visionEvents = []; chrome.runtime.onMessage.addListener(event => {
        if (event.action === 'agent_update') visionEvents.push({ type: event.type, data: event.data });
      });
    });
    assert.equal((await message('update_provider', { providerId: 'openrouter', config: {
      apiKey: 'owned-test-key', baseUrl: origin + '/v1', model: 'openai/gpt-4.1', enabled: true,
      visionMode: 'on', supportsVision: true, contextWindow: 128000,
    } })).ok, true);
    assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
    console.log('Owned provider configured');
    assert.equal(await panel.locator('#select-act-observation').inputValue(), 'vision', 'Installed settings default Act and Dev to visual interaction');
    assert.equal(await panel.locator('label[for="select-act-observation"]').textContent(), 'Act / Dev interaction mode');
    if (entry.id === 'desktop') {
      await panel.locator('#select-act-observation').selectOption('accessibility');
      await panel.waitForFunction(async () => (await chrome.storage.local.get('actObservation')).actObservation === 'accessibility');
      await panel.locator('#select-act-observation').selectOption('vision');
      await panel.waitForFunction(async () => (await chrome.storage.local.get('actObservation')).actObservation === 'vision');
    }
    const page = await context.newPage(); await page.goto(origin + '/form'); activePage = page;
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    assert.ok(tabId);
    if (entry.zoom) await panel.evaluate(({ tabId, zoom }) => chrome.tabs.setZoom(tabId, zoom), { tabId, zoom: entry.zoom });
    // Chrome associates emulation with the debugger owner. A screenshot from a
    // second CDP session can restore that session's viewport. Set test geometry
    // through the extension's own session, exactly the one that will capture.
    await worker.evaluate(async ({ tabId, viewport, dpr }) => {
      await chrome.debugger.attach({ tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: dpr, mobile: false,
      });
    }, { tabId, viewport: entry.viewport, dpr: entry.dpr });
    await worker.evaluate(({ finishedUrl }) => {
      globalThis.visionProbe = { cdp: [], messages: [], navigationCount: 0, captureFailuresInjected: 0, recoveredCaptures: 0 };
      let failNextNavigationCapture = false;
      const updateTab = chrome.tabs.update.bind(chrome.tabs);
      chrome.tabs.update = async (tabId, properties, ...extra) => {
        if (properties?.url === finishedUrl) {
          visionProbe.navigationCount++; failNextNavigationCapture = true;
        }
        return updateTab(tabId, properties, ...extra);
      };
      const sendCommand = chrome.debugger.sendCommand.bind(chrome.debugger);
      chrome.debugger.sendCommand = async (target, method, params, ...extra) => {
        visionProbe.cdp.push({ tabId: target.tabId, method, expression: params?.expression });
        // The native bridge simulates one destroyed document context after
        // navigation. Product capture recovery must take a new screenshot,
        // without replaying navigation or making another model request first.
        if (method === 'Page.captureScreenshot' && failNextNavigationCapture) {
          failNextNavigationCapture = false; visionProbe.captureFailuresInjected++;
          // Use a genuinely missing native execution context so Chrome's
          // callback API supplies runtime.lastError exactly as it does during
          // document replacement. Rejecting this async wrapper alone would
          // leave callback consumers waiting forever.
          return sendCommand(target, 'Runtime.evaluate', {
            expression: 'void 0', contextId: 2147483647, returnByValue: true,
          }, ...extra);
        }
        if (method === 'Page.captureScreenshot' && typeof extra[0] === 'function') {
          const callback = extra[0];
          return sendCommand(target, method, params, result => {
            if (!chrome.runtime.lastError && visionProbe.captureFailuresInjected) visionProbe.recoveredCaptures++;
            callback(result);
          });
        }
        const result = await sendCommand(target, method, params, ...extra);
        if (method === 'Page.captureScreenshot' && visionProbe.captureFailuresInjected) visionProbe.recoveredCaptures++;
        return result;
      };
      const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (tabId, message, ...extra) => {
        visionProbe.messages.push({ tabId, action: message.action }); return sendMessage(tabId, message, ...extra);
      };
    }, { finishedUrl: origin + '/finished' });
    beforeNavigation = [];
    const startedAt = Date.now();
    const started = performance.now();
    console.log(`Starting owned visual ${entry.mode || 'act'} on tab ${tabId}`);
    const result = await message(entry.action, { tabId, requestId: `vision-owned-${entry.id}`, mode: entry.mode || 'act', locale: 'en',
      text: (entry.mode === 'dev' ? 'Debug the owned fixture: inspect console and network diagnostics. Then ' : '')
        + 'Fill Name with Vision only 42, save once, inspect the result, scroll down, then navigate to ' + origin + '/finished and confirm the visual task completed.' });
    const elapsedMs = Math.round(performance.now() - started);
    const events = await panel.evaluate(() => visionEvents);
    const probe = await worker.evaluate(() => visionProbe);
    const recorded = await panel.evaluate(async startedAt => {
      const trace = await import(chrome.runtime.getURL('src/trace/recorder.js'));
      const runs = (await trace.listRuns({ limit: 20 })).filter(run => run.startedAt >= startedAt);
      return Promise.all(runs.map(async run => ({ run, events: await trace.getRunEvents(run.runId) })));
    }, startedAt);
    const caseRequests = requests.filter(item => item.case === entry.id);
    const evidence = { case: entry, result, elapsedMs, events, probe, recorded, beforeNavigation, requests: caseRequests };
    results.push(evidence);
    await fs.writeFile(path.join(out, `${entry.id}.json`), JSON.stringify(evidence,
      (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
    assert.deepEqual(failures, [], failures.join('\n'));
    assert.equal(result.content, 'Owned visual task complete.', JSON.stringify(result));
    assert.equal(probe.navigationCount, 1, 'A batched provider reply and screenshot retry must navigate exactly once');
    assert.equal(probe.captureFailuresInjected, 1, 'Every installed case exercises the post-navigation capture race');
    assert.ok(probe.recoveredCaptures >= 1, 'A native screenshot must succeed after the injected failure');
    const visualRun = recorded.find(entry => entry.events.some(event => event.data?.note === 'vision_capture_failure'));
    assert.ok(visualRun, 'Automatic feedback trace must retain capture retry diagnostics');
    const captureFailure = visualRun.events.find(event => event.data?.note === 'vision_capture_failure');
    assert.equal(captureFailure.data.extra.phase, 'vision_after_action_capture');
    assert.equal(captureFailure.data.extra.reason, 'page_changed');
    assert.equal(captureFailure.data.extra.retryable, true);
    assert.equal(visualRun.run.status, 'done'); assert.equal(visualRun.run.errorCount, 0);
    assert.equal(visualRun.events.filter(event => event.kind === 'tool' && event.data.name === 'vision_navigate').length, 1);
    assert.equal(visualRun.events.find(event => event.kind === 'tool' && event.data.name === 'vision_wait')?.data.resultErrorCode,
      'vision_batch_deferred');
    const runtimeUpdates = result.updates || events;
    // Streaming UI deliberately keeps only success/error; the complete safe
    // delivery receipt must still be sent to the model and retained in trace.
    const deferredWait = JSON.parse(caseRequests.at(-1).input.messages.find(message =>
      message.role === 'tool' && message.tool_call_id.endsWith('-wait')).content);
    assert.equal(deferredWait.code, 'vision_batch_deferred');
    assert.equal(deferredWait.noDispatch, true); assert.equal(deferredWait.outcomeUnknown, false);
    assert.ok(!runtimeUpdates.some(event => event.type === 'tool_call' && event.data.name === 'vision_wait'));
    assert.ok(caseRequests.length >= (entry.mode === 'dev' ? 10 : 8) && caseRequests.length <= 11,
      'Completion may reobserve loading, but must stay bounded');
    if (entry.mode === 'dev') {
      const toolResults = result.updates.filter(event => event.type === 'tool_result');
      const consoleResult = toolResults.find(event => event.data.name === 'read_console')?.data.result;
      const networkResult = toolResults.find(event => event.data.name === 'inspect_network_requests')?.data.result;
      assert.equal(consoleResult?.success, true, JSON.stringify(consoleResult));
      assert.ok(consoleResult.entries.some(entry => entry.text.includes('OWNED_VISUAL_DEV_DIAGNOSTIC')));
      assert.equal(networkResult?.success, true, JSON.stringify(networkResult));
      assert.ok(networkResult.requests.some(entry => entry.url.endsWith('/diagnostic-probe') && entry.status === 200));
      assert.equal(networkResult.includesHeaders, false); assert.equal(networkResult.includesBodies, false);
      assert.doesNotMatch(JSON.stringify(networkResult), /OWNED_HEADER_NOT_RETURNED|OWNED_BODY_NOT_RETURNED/);
    }
    assert.equal(submissions.filter(item => item.case === entry.id).length, 1);
    assert.equal(beforeNavigation[0]?.value, 'Vision only 42');
    assert.match(beforeNavigation[0]?.result || '', /Saved: Vision only 42/);
    assert.ok(beforeNavigation[0]?.scrollY > 0, 'Native coordinate scrolling must move the page');
    assert.equal(beforeNavigation[0]?.dpr, entry.dpr * (entry.zoom || 1));
    assert.ok(beforeNavigation[0]?.inputEvents.some(event => event.type === 'input'));
    assert.ok(beforeNavigation[0]?.inputEvents.every(event => event.trusted), 'Browser actions must use native trusted input');
    assert.ok(caseRequests.some(item => item.frames.some(frame => frame.kind === 'delta')), 'Small changes must produce crop deltas');
    assert.ok(caseRequests.at(-1).frames.some(frame => frame.kind === 'full'), 'Navigation must retain a fresh full frame');
    assert.ok(caseRequests.every(item => item.imageCount <= 5), 'Model image context must remain bounded');
    assert.ok(caseRequests.every(item => item.frames.every(frame => !frame.source
      || Math.abs(frame.source.width / frame.source.height - frame.viewport.width / frame.viewport.height) < 0.01)),
    'Captured pixels must cover exactly the declared viewport; native surface clipping would misplace clicks');
    assert.ok(probe.cdp.some(item => item.method === 'Input.dispatchMouseEvent'));
    assert.ok(probe.cdp.every(item => !item.method.startsWith('Accessibility.')));
    assert.ok(probe.messages.every(item => !/get_accessibility_tree|read_page|get_interactive_elements|click_ax|type_ax/.test(item.action || '')));
    assert.ok(probe.cdp.every(item => !/querySelector|innerText|outerHTML/.test(item.expression || '')), 'Native input must not read DOM content');
    await context.close(); context = null;
  }
  assert.deepEqual(await hashSources(), sourceBefore, 'The browser harness must not patch product source');
  const summary = { passed: true, cases: results.map(({ case: entry, elapsedMs, requests, probe }) => ({
    id: entry.id, mode: entry.mode || 'act', viewport: entry.viewport, dpr: entry.dpr, zoom: entry.zoom || 1, elapsedMs, modelCalls: requests.length,
    maxImageBytes: Math.max(...requests.map(item => item.imageBytes)), maxImageCount: Math.max(...requests.map(item => item.imageCount)),
    navigationCount: probe.navigationCount, captureFailuresInjected: probe.captureFailuresInjected,
    recoveredCaptures: probe.recoveredCaptures,
  })), submissions, sourceHashes: sourceBefore };
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profileRoot);
  assert.ok(resolved.startsWith(tempRoot + path.sep + 'webbrain-vision-act-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
