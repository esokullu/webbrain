import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Installed production extension, public chat entry, local deterministic model
// and real native input. No message leaves the owned HTTP fixture. The model
// oracle reads fixture state only in this test; production receives pixels and
// visual claims, never a DOM/AX observation or a substituted evidence session.
const extension = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION_SOURCE || 'src/chrome');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-publication-mv3');
await fs.mkdir(out, { recursive: true });
const temp = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(path.join(temp, 'webbrain-vision-publication-'));
const sourceFiles = ['src/background.js', 'src/cdp/cdp-client.js', ...['agent', 'vision-act', 'vision-evidence',
  'vision-review', 'vision-runtime-state', 'vision-browser', 'vision-transport', 'vision-frames'].map(name => `src/agent/${name}.js`)];
const hashSources = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex')])));
const sourceHashes = await hashSources();
const definitions = [
  { name: 'private-hidden-send', surface: 'conversation', success: true },
  { name: 'publication-hidden-send', surface: 'publication', success: true },
  { name: 'publication-missing-send', surface: 'publication', missingSend: true },
  { name: 'publication-author-drift', surface: 'publication', drift: 'author' },
  { name: 'publication-audience-drift', surface: 'publication', drift: 'audience' },
  { name: 'publication-user-draft', surface: 'publication', userDraft: true },
  { name: 'private-wrong-recipient', surface: 'conversation', wrongRecipient: true },
  { name: 'publication-uncertain-replay', surface: 'publication', uncertain: true },
];
const summaries = [], errors = [];
let context, panel, worker, active, base;
const body = 'Owned fixture message 42';
const textOf = value => typeof value === 'string' ? value : (value || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const frameIn = input => input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  .filter(block => block.type === 'text').flatMap(block => { try { const value = JSON.parse(block.text); return value.frameId && value.canvas ? [value] : []; } catch { return []; } }).at(-1);
const receipt = (input, name) => {
  const calls = new Map(input.messages.filter(message => message.tool_calls).flatMap(message => message.tool_calls.map(call => [call.id, call.function.name])));
  const message = input.messages.findLast(message => message.role === 'tool' && calls.get(message.tool_call_id) === name);
  return message ? JSON.parse(textOf(message.content)) : null;
};
const html = scenario => `<!doctype html><meta charset="utf-8"><title>Owned ${scenario.name}</title>
<style>*{box-sizing:border-box}body{margin:0;font:22px Arial;background:white;color:#142536}#recipient{position:absolute;left:40px;top:30px;width:650px;height:40px}#author{position:absolute;left:40px;top:80px;width:300px;height:40px}#audience{position:absolute;left:400px;top:80px;width:220px;height:40px}#baseline{position:absolute;left:40px;top:170px;width:650px;height:45px}#body{position:absolute;left:40px;top:250px;width:480px;height:80px;font:22px Arial;caret-color:transparent}#send{position:absolute;left:550px;top:250px;width:160px;height:80px;font:22px Arial}#receiptAuthor{position:absolute;left:40px;top:380px;width:300px;height:30px}#receiptAudience{position:absolute;left:400px;top:380px;width:220px;height:30px}#outgoing{position:absolute;left:40px;top:420px;width:700px;height:50px;background:#def}</style>
<div id="recipient">${scenario.surface === 'publication' ? 'Public timeline' : scenario.wrongRecipient ? 'Mallory' : 'Alice'}</div>
${scenario.surface === 'publication' ? '<div id="author">@owned_fixture</div><div id="audience">Public</div>' : ''}
<div id="baseline">${scenario.surface === 'publication' ? 'Earlier public status' : 'Please send one fixture reply.'}</div>
<textarea id="body" aria-label="PUBLICATION_AX_SENTINEL">${scenario.userDraft ? 'Unsent human draft' : ''}</textarea>
<button id="send" hidden>${scenario.surface === 'publication' ? 'Publish' : 'Send'}</button>
<div id="receiptAuthor"></div><div id="receiptAudience"></div><div id="outgoing"></div><div hidden>PUBLICATION_HIDDEN_SENTINEL</div>
<script>const config=${JSON.stringify(scenario)};window.nativeEvents=[];window.submitCount=0;for(const type of ['click','input','keydown'])document.addEventListener(type,event=>nativeEvents.push({type,trusted:event.isTrusted,target:event.target.id}));const field=document.querySelector('#body'),button=document.querySelector('#send');const update=()=>{button.hidden=config.missingSend||(!field.value&&!(config.uncertain&&submitCount));};field.addEventListener('input',update);update();button.onclick=async()=>{submitCount++;const sent={text:field.value,recipient:document.querySelector('#recipient').textContent,author:document.querySelector('#author')?.textContent||'',audience:document.querySelector('#audience')?.textContent||''};await fetch('/submit/'+config.name,{method:'POST',body:JSON.stringify(sent)});field.value='';update();if(!config.uncertain){document.querySelector('#receiptAuthor').textContent=sent.author;document.querySelector('#receiptAudience').textContent=sent.audience;document.querySelector('#outgoing').textContent=sent.text;}};</script>`;
const snapshot = () => active.page.evaluate(() => ({ recipient: document.querySelector('#recipient').textContent,
  author: document.querySelector('#author')?.textContent || '', audience: document.querySelector('#audience')?.textContent || '',
  draft: document.querySelector('#body').value, sendVisible: !document.querySelector('#send').hidden,
  outgoing: document.querySelector('#outgoing').textContent, receiptAuthor: document.querySelector('#receiptAuthor').textContent,
  receiptAudience: document.querySelector('#receiptAudience').textContent, submitCount, nativeEvents }));
const reply = (response, name, args) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: name ? '' : args,
    ...(name ? { tool_calls: [{ id: `publication-${active.name}-${active.sequence++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) },
  finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 220, completion_tokens: 40 } }));
};
const server = http.createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/fixture/')) {
      const scenario = definitions.find(item => request.url === `/fixture/${item.name}`); assert.ok(scenario);
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(html(scenario)); return;
    }
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (request.url.startsWith('/submit/')) {
      assert.equal(request.url, `/submit/${active.name}`); active.sends.push(JSON.parse(raw));
      response.writeHead(200).end('owned-receipt'); return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    const input = JSON.parse(raw), system = textOf(input.messages?.[0]?.content);
    if (!input.tools?.length && system === 'Hi') return reply(response, null, 'Hi');
    if (!input.tools?.length && system.startsWith('Extract stable user preferences')) return reply(response, null, '{"memories":[]}');
    assert.equal(input.parallel_tool_calls, false);
    assert.doesNotMatch(raw, /PUBLICATION_AX_SENTINEL|PUBLICATION_HIDDEN_SENTINEL/);
    const frame = frameIn(input);
    assert.ok(frame, 'Every acting/review request includes real frame metadata');
    assert.ok(input.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url')));
    const actual = await snapshot();
    if (input.tools.length === 1 && input.tools[0].function.name === 'vision_review') {
      const proposal = JSON.parse(textOf(input.messages[1].content).split('UNTRUSTED_PROPOSAL:\n')[1]);
      assert.ok(proposal.kind.startsWith('chat_'), `Unexpected review ${proposal.kind}`);
      const claims = proposal.claims || {}, expected = proposal.expected || {};
      const recipient = typeof claims.recipient === 'string' ? claims.recipient : claims.recipient?.text;
      const recipientMatches = actual.recipient === (recipient || expected.recipient);
      const draft = proposal.kind === 'chat_delivery' ? '' : proposal.kind === 'chat_authorization' ? null : expected.text ?? claims.composer?.text;
      const composerMatches = draft == null || draft === actual.draft;
      const publication = claims.publication || expected.publication;
      const authorMatches = active.surface !== 'publication' || actual.author === publication?.author?.text;
      const audienceMatches = active.surface !== 'publication' || actual.audience === publication?.audience?.text;
      const authorized = active.surface === 'publication'
        ? actual.recipient === 'Public timeline' && actual.author === '@owned_fixture' && actual.audience === 'Public'
        : actual.recipient === 'Alice';
      const valid = recipientMatches && composerMatches && authorMatches && audienceMatches;
      const allowed = valid && (proposal.kind !== 'chat_authorization' || authorized && expected.text === body);
      const delivered = active.sends.length === 1 && actual.outgoing === body && actual.draft === ''
        && (active.surface !== 'publication' || actual.receiptAuthor === '@owned_fixture' && actual.receiptAudience === 'Public');
      if (proposal.kind === 'chat_draft' && proposal.expected?.stage !== 'before_submit')
        assert.equal(claims.sendControl, undefined, 'Internal draft review never invents a hidden Send');
      active.reviews.push({ kind: proposal.kind, stage: expected.stage, verified: valid, allowed, frameId: frame.frameId,
        authorMatches, audienceMatches, delivered });
      if (active.drift && expected.stage === 'before_submit' && !active.drifted) {
        assert.ok(valid && allowed, 'Review covered original correct identity before injected race');
        active.drifted = true;
        await active.page.evaluate(kind => { document.querySelector(`#${kind}`).textContent = kind === 'author' ? '@other_account' : 'Followers only'; }, active.drift);
      }
      return reply(response, 'vision_review', { verified: valid, allowed, recipientMatches, composerMatches,
        authorMatches, audienceMatches, atLatest: true, delivered, newOutgoing: delivered, composerEmpty: actual.draft === '',
        reason: 'Independent owned fixture screenshot-state oracle.' });
    }
    const names = input.tools.map(tool => tool.function.name);
    assert.ok(names.includes('vision_click'));
    assert.ok(!names.some(name => /^(get_accessibility_tree|click_ax|type_ax|execute_js|browser_batch)$/.test(name)));
    const rect = (x, y, width, height) => ({ x: x * frame.canvas.width / frame.viewport.width,
      y: y * frame.canvas.height / frame.viewport.height, width: width * frame.canvas.width / frame.viewport.width,
      height: height * frame.canvas.height / frame.viewport.height });
    const observed = { frameId: frame.frameId, ...(active.surface === 'publication' ? { surface: 'publication',
      publication: { author: { text: actual.author, rect: rect(40, 80, 300, 40) }, audience: { text: actual.audience, rect: rect(400, 80, 220, 40) } } } : {}),
    recipient: { text: actual.recipient, rect: rect(40, 30, 650, 40) }, composer: { text: actual.draft, rect: rect(40, 250, 480, 80) },
    ...(actual.sendVisible ? { sendControl: { rect: rect(550, 250, 160, 80) } } : {}),
    messages: [{ direction: active.surface === 'publication' ? 'outgoing' : 'incoming',
      text: active.surface === 'publication' ? 'Earlier public status' : 'Please send one fixture reply.', rect: rect(40, 170, 650, 45) },
    ...(actual.outgoing ? [{ direction: 'outgoing', text: actual.outgoing,
      rect: active.surface === 'publication' ? rect(40, 380, 700, 90) : rect(40, 420, 700, 50) }] : [])],
    atLatest: true, userInputRequired: false };
    const chat = receipt(input, 'chat_observe'), send = receipt(input, 'chat_send');
    if (send?.operationId) active.operationId ||= send.operationId;
    if (active.requests.length) {
      const previous = active.requests.at(-1); const result = receipt(input, previous.name);
      if (result) active.results.push({ stage: previous.stage, name: previous.name, result });
    }
    const sendArgs = stage => ({ frameId: frame.frameId, stage, observationId: chat?.observationId,
      ...(stage === 'submit' ? { operationId: active.operationId } : {}),
      recipient: active.surface === 'publication' ? 'Public timeline' : 'Alice', text: body });
    const done = ['done', { frameId: frame.frameId, outcome: active.success ? 'success' : 'partial', summary: `Owned ${active.name} verification finished.` }];
    let step;
    if (active.stage === 0) step = ['vision_enable_tools', { group: 'chat' }];
    else if (active.stage === 1) { if (!active.userDraft) assert.equal(actual.sendVisible, false); step = ['chat_observe', observed]; }
    else if (active.stage === 2) {
      assert.equal(chat.success, true, JSON.stringify(chat));
      if (!active.userDraft) assert.equal(chat.sendControlAvailable, false);
      step = ['chat_send', sendArgs('prepare')];
    } else if (active.userDraft) {
      assert.equal(send.code, 'vision_chat_user_draft'); step = done;
    } else if (active.wrongRecipient) {
      if (active.stage === 3) {
        assert.equal(send.code, 'vision_chat_recipient_mismatch');
        step = ['chat_observe', observed];
      } else if (active.stage === 4) {
        assert.equal(chat.success, true);
        step = ['chat_send', { ...sendArgs('prepare'), recipient: 'Mallory' }];
      } else { assert.equal(send.code, 'vision_chat_unauthorized'); step = done; }
    } else if (active.stage === 3) {
      assert.equal(send.draftPrepared, true, JSON.stringify(send));
      assert.equal(actual.draft, body); assert.equal(actual.sendVisible, !active.missingSend);
      step = ['chat_observe', observed];
    } else if (active.stage === 4) {
      assert.equal(chat.success, true, JSON.stringify(chat)); assert.equal(chat.sendControlAvailable, !active.missingSend);
      step = ['chat_send', sendArgs('submit')];
    } else if (active.missingSend) {
      assert.equal(send.code, 'vision_chat_send_control_required'); assert.equal(send.noDispatch, true); step = done;
    } else if (active.drift) {
      if (active.stage === 5) {
        assert.equal(send.success, false); assert.equal(send.noDispatch, true, JSON.stringify(send));
        assert.equal(actual.submitCount, 0); step = ['vision_observe', { full: true }];
      } else if (active.stage === 6) step = ['chat_observe', observed];
      else if (active.stage === 7) {
        assert.equal(chat.pendingTargetChanged, true); step = ['chat_send', sendArgs('prepare')];
      } else { assert.equal(send.code, 'vision_chat_target_pending'); step = done; }
    } else if (active.stage === 5) {
      assert.equal(send.sent, true, JSON.stringify(send)); step = ['vision_wait', { milliseconds: 100 }];
    } else if (active.stage === 6) step = ['chat_observe', observed];
    else if (active.stage === 7) {
      assert.equal(chat.deliveryVerified, !active.uncertain, JSON.stringify(chat));
      assert.equal(chat.pendingOutbound, !!active.uncertain);
      step = ['chat_send', sendArgs(active.uncertain ? 'submit' : 'prepare')];
    } else if (active.uncertain && active.stage === 8) {
      assert.equal(send.code, 'vision_chat_draft_unverified'); assert.equal(send.noDispatch, true);
      step = ['chat_observe', observed];
    } else if (active.uncertain && active.stage === 9) {
      assert.equal(chat.pendingOutbound, true); step = ['chat_send', sendArgs('prepare')];
    } else {
      assert.equal(send.code, active.uncertain ? 'vision_chat_send_pending' : 'vision_chat_already_sent');
      assert.equal(send.noDispatch, true); step = done;
    }
    assert.ok(active.stage < 12, 'Recovery remains bounded');
    const [name, args] = step; assert.ok(names.includes(name), `${name} advertised`);
    active.requests.push({ stage: active.stage++, name, frameId: frame.frameId, frameKind: frame.kind,
      ...(name === 'chat_observe' ? { surface: args.surface || 'conversation', sendControlAvailable: !!args.sendControl } : {}) });
    return reply(response, name, args);
  } catch (error) {
    errors.push(error.stack); response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900', '--disable-background-networking',
      ...(process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [])] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  panel = await context.newPage(); await panel.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = async (action, data = {}) => {
    let timer;
    try { return await Promise.race([panel.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${active?.name} ${action} timed out at stage ${active?.stage}`)), 90000); })]); }
    finally { clearTimeout(timer); }
  };
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ helpImproveWebBrain: false, actObservation: 'vision', planBeforeActMode: 'off', planBeforeAct: false,
      planReviewMode: 'never', systemOneEnabled: false, tracingEnabled: false, screenshotRedaction: false,
      agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, maxAgentSteps: 16, openaiAskStreamingEnabled: false });
    window.publicationEvents = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') publicationEvents.push({ type: event.type, data: event.data }); });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture', baseUrl: base + '/v1',
    model: 'openai/gpt-4.1', enabled: true, visionMode: 'on', supportsVision: true, contextWindow: 128000 } })).ok, true);
  await message('set_active_provider', { providerId: 'openrouter' });
  await worker.evaluate(() => {
    globalThis.publicationProbe = [];
    const original = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (...args) => { publicationProbe.push({ tabId: args[0]?.tabId, method: args[1] }); return original(...args); };
  });
  for (const definition of definitions) {
    active = { ...definition, stage: 0, sequence: 0, requests: [], reviews: [], results: [], sends: [] };
    active.page = await context.newPage(); await active.page.goto(`${base}/fixture/${active.name}`);
    active.tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, active.page.url());
    await panel.evaluate(() => { publicationEvents.length = 0; });
    await worker.evaluate(() => { publicationProbe.length = 0; });
    console.log(`Installed visual publication: ${active.name}`);
    const task = active.surface === 'publication'
      ? `Publish exactly "${body}" once on Public timeline using account @owned_fixture with visibility Public. Preserve any existing human draft. Verify a newly published own entry and do not resend an uncertain operation.`
      : `Send exactly "${body}" to Alice once. Preserve existing human drafts and never send to Mallory. Verify a newly sent outgoing message; do not resend an uncertain operation.`;
    const result = await message('chat', { tabId: active.tabId, mode: 'act', requestId: `visual-publication-${active.name}`, locale: 'en', text: task });
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.ok(active.requests.some(item => item.name === 'done'), JSON.stringify(result));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.content, `Owned ${active.name} verification finished.`, 'The runtime completes the requested terminal step');
    const terminal = result.updates?.filter(event => event.type === 'run_status').at(-1)?.data?.status;
    assert.equal(terminal, active.success ? 'done' : 'partial', 'Safety refusals finish explicitly partial; successful sends finish done');
    assert.ok(!result.updates.some(event => event.type === 'error'), 'No hidden runtime/provider failure is counted as a safety pass');
    const actual = await snapshot(), expectedSends = active.success || active.uncertain ? 1 : 0;
    assert.equal(active.sends.length, expectedSends); assert.equal(actual.submitCount, expectedSends);
    if (expectedSends) assert.deepEqual(active.sends, [{ text: body, recipient: active.surface === 'publication' ? 'Public timeline' : 'Alice',
      author: active.surface === 'publication' ? '@owned_fixture' : '', audience: active.surface === 'publication' ? 'Public' : '' }]);
    assert.ok(actual.nativeEvents.every(event => event.trusted), 'Every actual UI input is native/trusted');
    assert.equal(actual.nativeEvents.filter(event => event.type === 'click' && event.target === 'send').length, expectedSends);
    if (active.userDraft) { assert.equal(actual.draft, 'Unsent human draft'); assert.deepEqual(actual.nativeEvents, []); }
    if (active.wrongRecipient) { assert.equal(actual.draft, ''); assert.deepEqual(actual.nativeEvents, []); }
    if (active.drift || active.missingSend) assert.equal(actual.draft, body);
    if (active.success) { assert.equal(actual.outgoing, body); assert.equal(actual.draft, ''); }
    if (active.uncertain) { assert.equal(actual.outgoing, ''); assert.equal(actual.draft, ''); }
    const probe = await worker.evaluate(() => publicationProbe);
    assert.ok(probe.some(item => item.method === 'Page.captureScreenshot'));
    assert.ok(!probe.some(item => /Accessibility\.|DOM\.(getDocument|getFlattenedDocument|querySelector)/.test(item.method)), 'No AX/tree observation');
    const ledgerEntries = await panel.evaluate(async () => Object.entries(await chrome.storage.local.get(null))
      .filter(([key]) => key.startsWith('webbrain.vision.receipts.v1:')).flatMap(([key, value]) =>
        (value.evidence?.chatLedger || []).map(ledger => ({ key, ledger }))));
    const ledger = ledgerEntries.find(item => item.ledger.pending?.id === active.operationId || item.ledger.sent.some(sent => sent.operationId === active.operationId))?.ledger;
    if (active.success) { assert.ok(ledger); assert.equal(ledger.pending, null); assert.equal(ledger.sent.length, 1); }
    if (active.uncertain) { assert.equal(ledger?.pending?.stage, 'uncertain'); assert.equal(ledger.sent.length, 0); }
    if (active.drift || active.missingSend) assert.equal(ledger?.pending?.stage, 'prepared');
    summaries.push({ name: active.name, passed: true, terminal, surface: active.surface, actual, requests: active.requests, reviews: active.reviews,
      toolResults: active.results, sends: active.sends, ledger, nativeMethods: [...new Set(probe.map(item => item.method))] });
    await active.page.close();
  }
  assert.deepEqual(await hashSources(), sourceHashes, 'Fixture tested unchanged production sources');
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, installedMV3: true, scenarios: summaries, sourceHashes }, null, 2));
  await fs.rm(path.join(out, 'failure.json'), { force: true });
  console.log(JSON.stringify({ passed: true, installedMV3: true, flows: summaries.map(item => item.name), total: summaries.length }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, errors, scenarios: summaries,
    active: active && { name: active.name, stage: active.stage, requests: active.requests, reviews: active.reviews, results: active.results, sends: active.sends },
    events: await panel?.evaluate(() => publicationEvents).catch(() => []) }, null, 2));
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(temp + path.sep + 'webbrain-vision-publication-')) throw new Error('Unexpected fixture profile path');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
