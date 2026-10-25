import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';
import { fixedChoiceQuestion, fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';
// The questions a messaging page's own checks read its texts with.
const MESSAGING_TEXT_KINDS = ['message_control', 'message_field', 'message_author', 'message_status'];

// A request that points at the open chat instead of naming the person, as in
// the WhatsApp trace where "send some test messages to this one" was answered
// with "which contact?" six times. Through the installed MV3 extension:
//   open-chat-only: the plan's target is the open conversation; WebBrain pins
//     it to the header it reads, and the photo is sent there with no card.
//   open-chat-and-named: "here, then to Rustem Bey". The open chat needs no
//     card, before or after the named person's chat. Rustem Bey's chat, whose
//     header reads "Rüstem Bey", is confirmed once on WebBrain's card, which
//     shows who was asked for. A chat nobody asked for still goes to the card,
//     and Don't send there sends nothing.
// The threads, photo and model are owned local fixtures; nothing leaves the
// host.
const threads = {
  open: { id: '17848282661759097', name: 'Gamze Çömlekçi' },
  named: { id: '27848282661759098', name: 'Rüstem Bey' },
  other: { id: '37848282661759099', name: 'Ayşe Kaya' },
};
const threadUrl = key => `https://www.instagram.com/direct/t/${threads[key].id}/`;
const selector = 'input[type="file"][accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg"][multiple]';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=', 'base64');

// [variant, request, people named besides the open chat, model steps, card answers, chats sent to]
const variants = [
  ['open-chat-only', 'send this photo to this one on instagram', [],
    ['download', 'list', 'upload', 'tree', 'done'], [], ['open']],
  ['open-chat-and-named', 'send this photo to this one, then to Rustem Bey', ['Rustem Bey'],
    ['download', 'list', 'upload', 'nav:named', 'upload', 'nav:open', 'upload', 'nav:other', 'upload', 'tree', 'done'],
    ['once', 'deny'], ['open', 'named', 'open']],
];
for (const variant of variants) await runVariant(...variant);

async function runVariant(variant, request, alsoNamed, steps, cardAnswers, expectedSends) {
  const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
    ? path.join(process.env.WEBBRAIN_QUALITY_ARTIFACTS, variant)
    : `ci/artifacts/quality-audit-2026-10-15/open-chat-recipients-mv3/${variant}`);
  await fs.mkdir(out, { recursive: true });
  const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true, requires_submission: true,
    messaging: { target_kind: 'active_conversation', recipients: alsoNamed.map(identity => ({ identity, role: 'to' })) },
    deliverables: ['Send the photo in the open conversation' + (alsoNamed.length ? ` and to ${alsoNamed.join(', ')}` : '')],
    completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
    read_scope: 'visible_page', summary: 'Attach the downloaded photo in the requested conversations.',
    steps: [{ id: '1', action: 'Attach the photo and verify it was sent.' }],
    memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
  const sends = [], providerRequests = [], cards = [];
  let actionCalls = 0, judgeCalls = 0, blockedRemote = 0, base = '';
  const completionRecovery = { reads: 0 };
  const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
  const downloadIdIn = input => {
    for (const message of input.messages || []) {
      if (message.role !== 'tool') continue;
      const content = textOf(message.content);
      try {
        const data = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
        const id = data.downloads?.find(item => String(item.url || '').endsWith('/photo.png'))?.downloadId;
        if (id != null) return id;
      } catch {}
    }
    return undefined;
  };
  const server = http.createServer(async (incoming, response) => {
    if (incoming.url === '/photo.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length,
        'Content-Disposition': 'attachment; filename="photo.png"' });
      response.end(png); return;
    }
    if (incoming.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of incoming) raw += part;
    const input = JSON.parse(raw); providerRequests.push(input);
    const system = textOf(input.messages?.[0]?.content);
    let completion;
    if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
      judgeCalls++;
      completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded',
        reason: 'Each requested conversation shows the new outgoing attachment.' }) };
    } else if (MESSAGING_TEXT_KINDS.includes(fixedChoiceQuestion(input.messages)?.kind)) {
      completion = { role: 'assistant', content: fixtureFixedChoiceReply(input.messages) };
    } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      const step = actionCalls++;
      const kind = steps[Math.min(step, steps.length - 1)];
      const call = kind === 'download' ? { name: 'download_files', args: { urls: [`${base}/photo.png`] } }
        : kind === 'list' ? { name: 'list_downloads', args: { limit: 5 } }
        : kind === 'upload' ? { name: 'upload_file', args: { selector, downloadId: downloadIdIn(input) } }
          : kind.startsWith('nav:') ? { name: 'navigate', args: { url: threadUrl(kind.slice(4)) } }
            : kind === 'tree' ? { name: 'get_accessibility_tree', args: { filter: 'all' } }
              : { name: 'done', args: { outcome: 'success', summary: 'Sent the photo to each requested conversation.' } };
      let emitted;
      try { emitted = conformFixtureCompletionCall(input, call, completionRecovery); } catch (error) {
        const tools = (input.tools || []).map(tool => tool.function || tool);
        await fs.writeFile(path.join(out, 'provider-diagnostic.json'), JSON.stringify({ step, kind,
          tools: tools.map(tool => tool.name), done: tools.find(tool => tool.name === 'done')?.parameters,
          last: input.messages.slice(-4), toolMessages: input.messages.filter(item => item.role === 'tool')
            .map(item => textOf(item.content).slice(0, 1500)) }, null, 2));
        throw error;
      }
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-open-chat-${step}`, type: 'function',
        function: { name: emitted.name, arguments: JSON.stringify(emitted.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const pageBody = key => `<!doctype html><meta charset="utf-8"><title>Owned direct thread</title>
  <style>body{margin:0;font:16px sans-serif} nav{position:fixed;left:0;top:0;width:330px;height:700px}
  header{position:fixed;left:350px;top:10px;width:600px;height:70px} #thread{position:fixed;left:350px;top:90px;width:600px;height:420px}
  footer{position:fixed;left:350px;top:600px;width:600px;height:60px} [contenteditable]{display:inline-block;width:420px;height:40px;border:1px solid #888}
  [role=button]{display:inline-block;width:32px;height:32px} svg{width:24px;height:24px}</style>
  <nav aria-label="Thread list">${Object.values(threads).map(thread => `<div role="button">${thread.name}</div>`).join('')}</nav>
  <main><header><a href="/profile-${key}/" aria-label="Open the profile page of ${threads[key].name}"><h2>${threads[key].name}</h2></a></header>
  <div id="thread" role="log"><div data-message-direction="incoming">Merhaba!</div></div>
  <footer><form id="composer" onsubmit="return false"><div role="textbox" contenteditable="true" aria-label="Message" id="body"></div>
  <div role="button" id="attach"><svg role="img" aria-label="Add Photo or Video"><title>Add Photo or Video</title><path d="M0 0h24v24H0z"/></svg></div>
  <input type="file" accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg" multiple hidden></form></footer></main>
  <script>
  document.querySelector('input[type=file]').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    const body = new FormData(); body.append('photo', file);
    const result = await fetch('/api/v1/direct_v2/threads/${threads[key].id}/items/configure_photo/', { method: 'POST', body });
    if (result.ok) {
      const item = document.createElement('div'); item.dataset.messageDirection = 'outgoing'; item.textContent = 'You sent an attachment.';
      document.querySelector('#thread').append(item);
      // A sent attachment leaves the composer, as in a real chat.
      event.target.value = '';
    }
  });
  </script>`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-open-chat-mv3-'));
  let context;
  try {
    const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
    await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.openChatFixtureAgent = agent;\n');
    context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', acceptDownloads: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    await context.route('**/*', async route => {
      const routed = route.request(), requested = new URL(routed.url());
      if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
      if (requested.origin === 'https://www.instagram.com') {
        const thread = Object.entries(threads)
          .find(([, value]) => requested.pathname === `/api/v1/direct_v2/threads/${value.id}/items/configure_photo/`)?.[0];
        if (thread && routed.method() === 'POST') {
          const body = routed.postDataBuffer() || Buffer.alloc(0);
          sends.push({ thread, containsPhoto: body.includes(png) });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' });
        }
        const page = Object.keys(threads).find(key => requested.href === threadUrl(key));
        if (routed.isNavigationRequest() && page) return route.fulfill({ contentType: 'text/html', body: pageBody(page) });
        return route.fulfill({ status: 404, body: '' });
      }
      if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const downloads = path.join(profile, 'downloads'); await fs.mkdir(downloads, { recursive: true });
    const cdp = await context.newCDPSession(context.pages()[0] || await context.newPage());
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
    const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
    await harness.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
      autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
      planReviewMode: 'never', maxAgentSteps: 20, systemOneEnabled: false, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
    assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
      baseUrl: `${base}/v1`, model: 'minimax/minimax-m3', enabled: true,
      contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
    assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
    await worker.evaluate(() => { openChatFixtureAgent.clarifyTimeoutSec = -1; });
    const page = await context.newPage(); await page.goto(threadUrl('open'));
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, threadUrl('open'));
    // Answer WebBrain's cards in order; any other question is unexpected.
    let answering = true;
    const answered = new Set();
    const answerer = (async () => {
      while (answering) {
        const pending = await worker.evaluate(tabId => [...(openChatFixtureAgent._pendingClarifications.get(tabId)?.keys() || [])], tabId);
        for (const clarifyId of pending) {
          if (answered.has(clarifyId)) continue;
          answered.add(clarifyId);
          assert.ok(clarifyId.startsWith('recipient_'), `Unexpected question in ${variant}: ${clarifyId}`);
          // An unexpected card is refused, and fails the variant below.
          const answer = cardAnswers[cards.length] || 'deny';
          cards.push(clarifyId);
          assert.equal((await message('clarify_response', { tabId, clarifyId, answer, source: 'option' })).ok, true);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const result = await message('chat', { tabId, text: request, mode: 'act', requestId: `owned-open-chat-${variant}`, locale: 'en' });
    answering = false; await answerer;
    const toolResults = result.updates.filter(event => event.type === 'tool_result').map(event => ({ name: event.data?.name,
      success: event.data?.result?.success, reasonCode: event.data?.result?.reasonCode || null,
      error: event.data?.result?.error || null }));
    const prompts = result.updates.filter(event => event.type === 'clarify').map(event => ({ kind: event.data?.promptKind,
      question: event.data?.question, recipientConfirmation: event.data?.recipientConfirmation || null }));
    await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ toolResults, prompts, cards, sends,
      judgeCalls, blockedRemote }, null, 2));
    const uploads = toolResults.filter(item => item.name === 'upload_file');
    assert.deepEqual(sends.map(item => item.thread), expectedSends, `Sends: ${JSON.stringify(toolResults)}`);
    assert.ok(sends.every(item => item.containsPhoto), JSON.stringify(sends));
    assert.equal(cards.length, cardAnswers.length, `WebBrain's cards: ${JSON.stringify(prompts)}`);
    const cardPrompts = prompts.filter(item => item.kind === 'recipientConfirmation');
    assert.equal(cardPrompts.length, cardAnswers.length, JSON.stringify(prompts));
    assert.equal(prompts.length, cardPrompts.length, `Only WebBrain's cards ask: ${JSON.stringify(prompts)}`);
    if (alsoNamed.length) {
      assert.deepEqual(cardPrompts[0].recipientConfirmation, { recipients: [{ identity: threads.named.name, role: 'to' }],
        requested: alsoNamed, host: 'www.instagram.com', offerAll: false }, 'The card for the named chat shows who was asked for');
      assert.deepEqual(cardPrompts[1].recipientConfirmation.recipients, [{ identity: threads.other.name, role: 'to' }]);
      assert.deepEqual(uploads.map(item => item.success === true ? 'sent' : item.reasonCode),
        ['sent', 'sent', 'sent', 'recipient_declined'], JSON.stringify(uploads));
      assert.equal(await page.locator('[data-message-direction="outgoing"]').count(), 0,
        'The chat nobody asked for shows no outgoing message');
    } else {
      assert.deepEqual(uploads.map(item => item.success === true ? 'sent' : item.reasonCode), ['sent'], JSON.stringify(uploads));
      assert.equal(await page.locator('[data-message-direction="outgoing"]').count(), 1);
    }
    console.log(JSON.stringify({ passed: true, installedMV3: true, variant, cards: cards.length,
      sends: sends.map(item => item.thread), uploads: uploads.map(item => item.success === true ? 'sent' : item.reasonCode),
      judgeCalls, blockedRemote }));
  } finally {
    await context?.close(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-open-chat-mv3-')) throw new Error('Unexpected temporary profile path.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
