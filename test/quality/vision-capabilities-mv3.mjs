import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Public extension entry -> real provider HTTP -> production visual runtime ->
// native input -> owned page -> real clarification/scheduler -> continuation.
// The deterministic provider is a fixture, not a live-model quality benchmark.
const extension = path.resolve('src/chrome');
const out = path.resolve('ci/artifacts/vision-capabilities-mv3');
await fs.mkdir(out, { recursive: true });
const temp = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(path.join(temp, 'webbrain-vision-capabilities-'));
const requests = [], reviews = [], errors = [], sends = [], memoryExtractions = [];
let page, panel, base, stage = 0, resumed = false, priorFrame, context;
const textOf = value => typeof value === 'string' ? value : (value || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const receipt = (input, name) => {
  const calls = new Map(input.messages.filter(message => message.tool_calls).flatMap(message => message.tool_calls.map(call => [call.id, call.function.name])));
  const message = input.messages.findLast(message => message.role === 'tool' && calls.get(message.tool_call_id) === name);
  return message ? JSON.parse(textOf(message.content)) : null;
};
const frameIn = input => input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  .filter(block => block.type === 'text').flatMap(block => { try { const value = JSON.parse(block.text); return value.frameId && value.canvas ? [value] : []; } catch { return []; } }).at(-1);
const html = `<!doctype html><meta charset="utf-8"><title>Owned visual conversation</title>
<style>*{box-sizing:border-box}body{margin:0;font:22px Arial;background:white}#recipient{position:absolute;left:60px;top:40px;width:360px;height:45px}#incoming{position:absolute;left:60px;top:110px;width:450px;height:50px}#outgoing{position:absolute;left:60px;top:180px;width:450px;height:50px;background:#def}#body{position:absolute;left:60px;top:300px;width:400px;height:70px;font:22px Arial;caret-color:transparent}#send{position:absolute;left:480px;top:300px;width:140px;height:70px;font:22px Arial}#marker{position:absolute;left:60px;top:430px;width:350px;height:50px;background:#eee}</style>
<div id="recipient">Owned Recipient</div><div id="incoming">Please send the fixture reply.</div><div id="outgoing"></div>
<textarea id="body" aria-label="AX_ONLY_DO_NOT_SEND"></textarea><button id="send">Send</button><div id="marker">Diagnostic marker</div><div hidden>HIDDEN_PAGE_DO_NOT_SEND</div>
<script>window.nativeEvents=[];for(const type of ['click','input','keydown'])document.addEventListener(type,e=>nativeEvents.push({type,trusted:e.isTrusted}));document.querySelector('#send').onclick=async()=>{const field=document.querySelector('#body');const text=field.value;await fetch('/send',{method:'POST',body:text});document.querySelector('#outgoing').textContent=text;field.value='';};</script>`;
const reply = (response, name, args, id) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({
  choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 200, completion_tokens: 40 },
})); };
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/chat') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return; }
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (request.url === '/send') { sends.push(raw); response.writeHead(200).end('ok'); return; }
    assert.equal(request.url, '/v1/chat/completions');
    const input = JSON.parse(raw);
    console.log(`Fixture provider: stage=${stage} tools=${input.tools?.length || 0}`);
    if (!input.tools?.length && input.messages?.[0]?.content === 'Hi') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'Hi' } }] })); return; }
    // The normal background memory extractor can run after a completed turn.
    // It receives bounded conversation text, never page observation or tools.
    if (!input.tools?.length && textOf(input.messages?.[0]?.content).startsWith('Extract stable user preferences for WebBrain memory.')) {
      assert.doesNotMatch(raw, /HIDDEN_PAGE_DO_NOT_SEND|AX_ONLY_DO_NOT_SEND|data:image/);
      assert.ok(raw.length < 12000);
      memoryExtractions.push({ bounded: true, tools: 0 });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"memories":[]}' } }] })); return;
    }
    assert.equal(input.parallel_tool_calls, false);
    const frame = frameIn(input);
    assert.ok(frame, 'Every acting and independent-review request has visual frame metadata');
    const images = input.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'image_url') : []);
    assert.ok(images.length >= 1 && images.length <= 5);
    assert.doesNotMatch(JSON.stringify(input), /HIDDEN_PAGE_DO_NOT_SEND|AX_ONLY_DO_NOT_SEND/);
    if (input.tools.length === 1 && input.tools[0].function.name === 'vision_review') {
      const proposalText = textOf(input.messages[1].content);
      const proposal = JSON.parse(proposalText.split('UNTRUSTED_PROPOSAL:\n')[1]);
      reviews.push({ kind: proposal.kind, frameId: frame.frameId });
      const actual = await page.evaluate(() => ({ recipient: document.querySelector('#recipient').textContent,
        draft: document.querySelector('#body').value, outgoing: document.querySelector('#outgoing').textContent }));
      // Owned provider oracle checks the actual fixture state; the product
      // request supplies screenshots/claims only, never this DOM information.
      const expectedDraft = proposal.kind === 'chat_delivery' ? '' : proposal.kind === 'chat_authorization' ? null : proposal.expected?.text;
      const draftMatches = expectedDraft == null || actual.draft === expectedDraft;
      const chat = proposal.kind.startsWith('chat_');
      const valid = !chat || actual.recipient === 'Owned Recipient' && draftMatches;
      reply(response, 'vision_review', { verified: valid, allowed: valid,
        recipientMatches: actual.recipient === 'Owned Recipient', composerMatches: draftMatches, atLatest: true,
        delivered: sends.length === 1 && actual.outgoing === 'Fixture reply 42', newOutgoing: sends.length === 1,
        composerEmpty: actual.draft === '', completionVerified: true, reason: 'Owned fixture independent state verification.' }, `review-${reviews.length}`);
      return;
    }
    assert.ok(input.tools.some(tool => tool.function.name === 'vision_click'));
    assert.ok(!input.tools.some(tool => /^(get_accessibility_tree|click_ax|type_ax|execute_js|browser_batch)$/.test(tool.function.name)));
    const point = (x, y) => ({ frameId: frame.frameId, x: x * frame.canvas.width / frame.viewport.width, y: y * frame.canvas.height / frame.viewport.height });
    const rect = (x, y, width, height) => ({ x: x * frame.canvas.width / frame.viewport.width, y: y * frame.canvas.height / frame.viewport.height,
      width: width * frame.canvas.width / frame.viewport.width, height: height * frame.canvas.height / frame.viewport.height });
    const observed = draft => ({ frameId: frame.frameId, recipient: { text: 'Owned Recipient', rect: rect(60, 40, 360, 45) },
      composer: { text: draft, rect: rect(60, 300, 400, 70) }, sendControl: { rect: rect(480, 300, 140, 70) },
      messages: [{ direction: 'incoming', text: 'Please send the fixture reply.', rect: rect(60, 110, 450, 50) },
        ...(sends.length ? [{ direction: 'outgoing', text: 'Fixture reply 42', rect: rect(60, 180, 450, 50) }] : [])], atLatest: true, userInputRequired: false });
    const chatReceipt = receipt(input, 'chat_observe');
    const sendReceipt = receipt(input, 'chat_send');
    const steps = [
      ['calculate', { expression: '6*7' }],
      ['scratchpad_write', { text: 'VISION_RESUME_FACT_42; preserve across scheduled continuation.' }],
      ['clarify', { question: 'Which fixture reply number should I use?', options: ['42', 'Cancel'] }],
      ['vision_enable_tools', { group: 'chat' }],
      ['chat_observe', observed('')],
      ['chat_send', { frameId: frame.frameId, stage: 'prepare', observationId: chatReceipt?.observationId, recipient: 'Owned Recipient', text: 'Fixture reply 42' }],
      ['chat_observe', observed('Fixture reply 42')],
      ['chat_send', { frameId: frame.frameId, stage: 'submit', observationId: chatReceipt?.observationId, operationId: sendReceipt?.operationId, recipient: 'Owned Recipient', text: 'Fixture reply 42' }],
      ['chat_observe', observed('')],
      ['chat_send', { frameId: frame.frameId, stage: 'prepare', observationId: chatReceipt?.observationId, recipient: 'Owned Recipient', text: 'Fixture reply 42' }],
      ['vision_enable_tools', { group: 'browser' }],
      ['resize_window', { width: 1000, height: 720, left: 0, top: 0 }],
      ['vision_enable_tools', { group: 'dev' }],
      ['inspect_element_styles', point(200, 450)],
      ['patch_element', { ...point(200, 450), styles: { 'background-color': 'rgb(80, 180, 100)' } }],
      ['revert_patch', { frameId: frame.frameId, patchId: receipt(input, 'patch_element')?.patchId }],
      ['vision_enable_tools', { group: 'tasks' }],
      ['schedule_resume', { after_seconds: 300, reason: 'Wait for the owned external fixture event.', resume_instruction: 'Use the saved VISION_RESUME_FACT_42 and a fresh screenshot to verify the one sent message; then finish.' }],
      ['progress_read', { currentTaskOnly: true, limit: 10 }],
      ['done', { frameId: frame.frameId, outcome: 'success', summary: 'Visual capabilities verified once.' }],
    ];
    assert.ok(stage < steps.length + 2, 'No indefinite recovery loop');
    if (stage >= 1 && stage <= 2) assert.equal(frame.frameId, priorFrame, 'Pure utility steps do not produce screenshots');
    if (stage === 4) assert.match(JSON.stringify(input.messages), /Answer to the clarification: 42/);
    if (stage === 6) assert.equal(receipt(input, 'chat_send')?.draftPrepared, true, JSON.stringify(receipt(input, 'chat_send')));
    if (stage === 9) assert.equal(chatReceipt.deliveryVerified, true, JSON.stringify(chatReceipt));
    if (stage === 10) assert.equal(sendReceipt.code, 'vision_chat_already_sent');
    if (stage === 12) { assert.notEqual(frame.frameId, priorFrame); assert.equal(frame.kind, 'full'); assert.equal(receipt(input, 'resize_window')?.success, true); }
    if (stage === 14) assert.equal(receipt(input, 'inspect_element_styles')?.success, true, JSON.stringify(receipt(input, 'inspect_element_styles')));
    if (stage === 15) { assert.equal(receipt(input, 'patch_element')?.success, true, JSON.stringify(receipt(input, 'patch_element'))); assert.notEqual(frame.frameId, priorFrame); }
    if (stage === 16) assert.equal(receipt(input, 'revert_patch')?.success, true, JSON.stringify(receipt(input, 'revert_patch')));
    if (stage === 18) { assert.equal(resumed, true); assert.equal(frame.kind, 'full'); assert.notEqual(frame.frameId, priorFrame);
      assert.match(JSON.stringify(input.messages), /VISION_RESUME_FACT_42/); }
    const [name, args] = steps[stage] || steps.at(-1);
    assert.ok(input.tools.some(tool => tool.function.name === name), `${name} advertised`);
    requests.push({ stage, name, frameId: frame.frameId, kind: frame.kind, toolNames: input.tools.map(tool => tool.function.name) });
    priorFrame = frame.frameId;
    reply(response, name, args, `action-${stage++}`);
  } catch (error) { errors.push(error.stack); response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
try {
  console.log('Launching installed capability fixture');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900', '--disable-background-networking',
      ...(process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [])] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  console.log('Extension service worker ready');
  panel = await context.newPage(); await panel.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = async (action, data = {}) => {
    let timer;
    try { return await Promise.race([panel.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Extension ${action} timed out at stage ${stage}`)), 90000); })]); }
    finally { clearTimeout(timer); }
  };
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ helpImproveWebBrain: false, actObservation: 'vision', planBeforeActMode: 'off', planBeforeAct: false,
      planReviewMode: 'never', systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: false, maxAgentSteps: 40, openaiAskStreamingEnabled: false });
    window.events = []; window.replies = [];
    chrome.runtime.onMessage.addListener(event => {
      if (event.action !== 'agent_update') return;
      events.push({ type: event.type, data: event.data });
      if (event.type === 'clarify') replies.push(chrome.runtime.sendMessage({ target: 'background', action: 'clarify_response',
        tabId: event.tabId, clarifyId: event.data.clarifyId, answer: '42', source: 'user' }));
    });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture', baseUrl: base + '/v1',
    model: 'openai/gpt-4.1', enabled: true, visionMode: 'on', supportsVision: true, contextWindow: 128000 } })).ok, true);
  await message('set_active_provider', { providerId: 'openrouter' });
  page = await context.newPage(); await page.goto(base + '/chat');
  const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  console.log('Starting public visual Dev task');
  const result = await message('chat', { tabId, mode: 'dev', requestId: 'visual-capabilities-owned', locale: 'en',
    text: 'Calculate 6*7 and remember VISION_RESUME_FACT_42. Ask me the reply number, then send Fixture reply 42 to Owned Recipient exactly once. Resize the window, inspect the Diagnostic marker CSS, temporarily change its background then undo the patch. This is an explicit development test. Schedule a resume to wait for the fixture event and later verify the result using task memory.' });
  console.log(`Initial run finished: stage=${stage}`);
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(stage, 18, JSON.stringify(result));
  const jobs = (await message('list_scheduled_jobs', { tabId })).jobs;
  const job = jobs.find(item => item.kind === 'resume');
  assert.equal(job.actObservation, 'vision'); assert.equal(job.mode, 'dev');
  const beforeResume = await panel.evaluate(() => events.filter(event => event.type === 'vision_frame').length);
  // Changing the global setting while paused must not change the saved job.
  await panel.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility' }));
  resumed = true;
  const startedResume = await message('run_scheduled_job_now', { jobId: job.id });
  console.log(`Resume queued: ${JSON.stringify(startedResume)}`);
  assert.equal(startedResume.ok, true, JSON.stringify(startedResume));
  await panel.waitForFunction(() => events.some(event => event.type === 'run_status' && event.data.status === 'done'), null, { timeout: 90000 });
  const events = await panel.evaluate(() => window.events);
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(stage, 20, JSON.stringify(events.filter(event => event.type === 'run_status')));
  assert.deepEqual(sends, ['Fixture reply 42']);
  assert.ok(events.filter(event => event.type === 'vision_frame').length > beforeResume);
  assert.equal(events.filter(event => event.type === 'clarify').length, 1);
  assert.ok((await panel.evaluate(() => Promise.all(replies))).every(result => result.ok));
  assert.ok((await page.evaluate(() => nativeEvents)).every(event => event.trusted));
  const finalJobs = (await message('list_scheduled_jobs', { tabId })).jobs;
  assert.equal(finalJobs.find(item => item.id === job.id).status, 'completed');
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, installedMV3: true, stage, requests, reviews,
    sends: sends.length, clarificationReplies: 1, schedule: { id: job.id, actObservation: job.actObservation, mode: job.mode },
    toolResults: events.filter(event => event.type === 'tool_result'), memoryExtractions, errors }, null, 2));
  await fs.rm(path.join(out, 'failure.json'), { force: true });
  console.log(JSON.stringify({ passed: true, installedMV3: true, stages: stage, reviews: reviews.length, sends: sends.length,
    flows: ['clarify-user-reply', 'single-message-with-draft-and-delivery', 'duplicate-send-block', 'resize-new-frame', 'Dev-styles-patch-revert', 'scheduled-vision-memory-resume'] }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, errors, stage, requests, reviews,
    events: await panel?.evaluate(() => window.events).catch(() => []) }, null, 2));
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(temp + path.sep + 'webbrain-vision-capabilities-')) throw new Error('Unexpected fixture profile path.');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
