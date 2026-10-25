import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';
import { fixedChoiceQuestion, fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';
import { instagramDirectThreadHtml } from '../lib/upload-release-fixture.mjs';
// The questions a messaging page's own checks read its texts with.
const MESSAGING_TEXT_KINDS = ['message_control', 'message_field', 'message_author', 'message_status'];

// The reported trace through the installed MV3 extension: the user asks to
// send a photo to "gamze", and the open direct thread is "Gamze Çömlekçi".
// WebBrain asks once on its own card and the photo is sent once when the user
// picks Send; Don't send sends nothing. A question the model asks itself
// approves nothing, whatever is picked or typed on it: the card still decides.
// The thread, photo and model are owned local fixtures; nothing leaves the
// host.
const threadUrl = 'https://www.instagram.com/direct/t/17848282661759097/';
const recipient = 'Gamze Çömlekçi';
const question = `Send the photo to ${recipient} on Instagram?`;
const selector = 'input[type="file"][accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg"][multiple]';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=', 'base64');

// [variant, model steps, model-question answer, its source, card answer, sends expected, thread page]
const variants = [
  ['card-send', ['download', 'list', 'upload', 'tree', 'done'], null, null, 'once', 1],
  ['card-dont-send', ['download', 'list', 'upload', 'done'], null, null, 'deny', 0],
  ['model-asks-first', ['download', 'list', 'clarify', 'upload', 'tree', 'done'], recipient, 'option', 'once', 1],
  ['typed-refusal', ['download', 'list', 'clarify', 'upload', 'done'], `No, not ${recipient}`, 'user', 'deny', 0],
  // Trace b71fd1dc: on Instagram's own composer every upload_file was refused
  // (action_binding_unavailable) after the user had confirmed the recipient.
  ['instagram-composer', ['download', 'list', 'inventory', 'upload', 'tree', 'done'], null, null, 'once', 1, 'instagram'],
  // The page re-renders that input after the inventory. The new node was never
  // listed, so its upload is refused; the next inventory's upload goes out.
  ['instagram-composer-rerendered', ['download', 'list', 'inventory', 'upload', 'inventory', 'upload', 'tree', 'done'],
    null, null, 'once', 1, 'instagram-rerendered'],
];
for (const variant of variants) await runVariant(...variant);

async function runVariant(variant, steps, answer, source, cardAnswer, expectedSends, threadPage = 'owned') {
  const approved = expectedSends > 0;
  const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
    ? path.join(process.env.WEBBRAIN_QUALITY_ARTIFACTS, variant)
    : `ci/artifacts/quality-audit-2026-10-07/recipient-clarify-mv3/${variant}`);
  await fs.mkdir(out, { recursive: true });
  const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true, requires_submission: true,
    messaging: { target_kind: 'named', recipients: [{ identity: 'gamze', role: 'to' }] },
    deliverables: ['Send the photo to Gamze via Instagram direct message'], completion_requirements: { download: false },
    allows_planner_shaped_result: false, allows_app_state_tool_evidence: false, read_scope: 'visible_page',
    summary: 'Attach the downloaded photo in the Gamze conversation.', steps: [{ id: '1', action: 'Attach the photo and verify it was sent.' }],
    memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
  const sends = [], providerRequests = [], clarifications = [], cards = [];
  let threadTab = null, rerendered = false;
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
  const server = http.createServer(async (request, response) => {
    if (request.url === '/photo.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length,
        'Content-Disposition': 'attachment; filename="photo.png"' });
      response.end(png); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw); providerRequests.push(input);
    const system = textOf(input.messages?.[0]?.content);
    let completion;
    if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
      judgeCalls++;
      completion = { role: 'assistant', content: JSON.stringify(approved
        ? { outcome: 'succeeded', reason: 'The thread shows the new outgoing attachment.' }
        : { outcome: 'failed', reason: 'The user declined the recipient; nothing was sent.' }) };
    } else if (MESSAGING_TEXT_KINDS.includes(fixedChoiceQuestion(input.messages)?.kind)) {
      // The chat's controls, fields, message labels and statuses, read as a
      // model would.
      completion = { role: 'assistant', content: fixtureFixedChoiceReply(input.messages) };
    } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      const step = actionCalls++;
      const kind = steps[Math.min(step, steps.length - 1)];
      // After the model listed the file inputs, the page re-mounts its own.
      if (kind === 'upload' && threadPage === 'instagram-rerendered' && !rerendered) {
        rerendered = true;
        await threadTab.evaluate(() => window.rerenderComposerInput());
      }
      const call = kind === 'download' ? { name: 'download_files', args: { urls: [`${base}/photo.png`] } }
        : kind === 'list' ? { name: 'list_downloads', args: { limit: 5 } }
        : kind === 'inventory' ? { name: 'get_interactive_elements', args: {} }
        : kind === 'upload' ? { name: 'upload_file', args: { selector, downloadId: downloadIdIn(input) } }
          : kind === 'clarify' ? { name: 'clarify', args: { options: [recipient, 'Cancel'], question } }
            : kind === 'tree' ? { name: 'get_accessibility_tree', args: { filter: 'all' } }
              : { name: 'done', args: approved
                ? { outcome: 'success', summary: `Sent the photo to ${recipient}.` }
                : { outcome: 'partial', summary: 'The photo was not sent because you declined the recipient.' } };
      let emitted;
      try { emitted = conformFixtureCompletionCall(input, call, completionRecovery); } catch (error) {
        const tools = (input.tools || []).map(tool => tool.function || tool);
        await fs.writeFile(path.join(out, 'provider-diagnostic.json'), JSON.stringify({ step, kind,
          tools: tools.map(tool => tool.name), done: tools.find(tool => tool.name === 'done')?.parameters,
          last: input.messages.slice(-4), toolMessages: input.messages.filter(item => item.role === 'tool')
            .map(item => textOf(item.content).slice(0, 1500)) }, null, 2));
        throw error;
      }
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-recipient-${step}`, type: 'function',
        function: { name: emitted.name, arguments: JSON.stringify(emitted.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // The page sends a photo once its message box's file input changes.
  const sendPhoto = `async input => {
    const file = input.files[0]; if (!file) return;
    const body = new FormData(); body.append('photo', file);
    const result = await fetch('/api/v1/direct_v2/threads/17848282661759097/items/configure_photo/', { method: 'POST', body });
    if (result.ok) {
      const item = document.createElement('div'); item.dataset.messageDirection = 'outgoing'; item.textContent = 'You sent an attachment.';
      document.querySelector('#thread').append(item);
    }
  }`;
  const pageBody = threadPage.startsWith('instagram')
    ? instagramDirectThreadHtml(recipient, 'dr.gamzec_')
      + `<script>window.addEventListener('composer-input-change', event => (${sendPhoto})(event.detail));</script>`
    : `<!doctype html><meta charset="utf-8"><title>Owned direct thread</title>
  <style>body{margin:0;font:16px sans-serif} nav{position:fixed;left:0;top:0;width:330px;height:700px}
  header{position:fixed;left:350px;top:10px;width:600px;height:70px} #thread{position:fixed;left:350px;top:90px;width:600px;height:420px}
  footer{position:fixed;left:350px;top:600px;width:600px;height:60px} [contenteditable]{display:inline-block;width:420px;height:40px;border:1px solid #888}
  [role=button]{display:inline-block;width:32px;height:32px} svg{width:24px;height:24px}</style>
  <nav aria-label="Thread list"><div role="button">Ungvb</div><div role="button">${recipient}</div></nav>
  <main><header><a href="/dr.gamzec_/" aria-label="Open the profile page of dr.gamzec_"><h2>${recipient}</h2></a></header>
  <div id="thread" role="log"><div data-message-direction="incoming">Merhaba!</div></div>
  <footer><form id="composer" onsubmit="return false"><div role="textbox" contenteditable="true" aria-label="Message" id="body"></div>
  <div role="button" id="attach"><svg role="img" aria-label="Add Photo or Video"><title>Add Photo or Video</title><path d="M0 0h24v24H0z"/></svg></div>
  <input type="file" accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg" multiple hidden></form></footer></main>
  <script>document.querySelector('input[type=file]').addEventListener('change', event => (${sendPhoto})(event.target));</script>`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-recipient-clarify-mv3-'));
  let context;
  try {
    const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
    await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.recipientFixtureAgent = agent;\n');
    context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', acceptDownloads: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    await context.route('**/*', async route => {
      const request = route.request(), requested = new URL(request.url());
      if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
      if (requested.origin === 'https://www.instagram.com') {
        if (requested.pathname === '/api/v1/direct_v2/threads/17848282661759097/items/configure_photo/' && request.method() === 'POST') {
          const body = request.postDataBuffer() || Buffer.alloc(0);
          sends.push({ method: request.method(), path: requested.pathname, containsPhoto: body.includes(png) });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' });
        }
        if (request.isNavigationRequest() && requested.href === threadUrl) return route.fulfill({ contentType: 'text/html', body: pageBody });
        return route.fulfill({ status: 404, body: '' });
      }
      if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
    // Keep the browser's own download name ("photo.png"), as a real profile
    // does, instead of the test runner's extension-less artifact name.
    const downloads = path.join(profile, 'downloads'); await fs.mkdir(downloads, { recursive: true });
    const cdp = await context.newCDPSession(context.pages()[0] || await context.newPage());
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
    const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
    await harness.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
      autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
      planReviewMode: 'never', maxAgentSteps: 14, systemOneEnabled: false, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
    assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
      baseUrl: `${base}/v1`, model: 'minimax/minimax-m3', enabled: true,
      contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
    assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
    await worker.evaluate(() => { recipientFixtureAgent.clarifyTimeoutSec = -1; });
    const page = await context.newPage(); await page.goto(threadUrl); threadTab = page;
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, threadUrl);
    // Answer the model's question the way the user did, and WebBrain's card
    // with the variant's choice.
    let answering = true;
    const answered = new Set();
    const answerer = (async () => {
      while (answering) {
        const pending = await worker.evaluate(tabId => [...(recipientFixtureAgent._pendingClarifications.get(tabId)?.keys() || [])], tabId);
        for (const clarifyId of pending) {
          if (answered.has(clarifyId)) continue;
          answered.add(clarifyId);
          const card = clarifyId.startsWith('recipient_');
          (card ? cards : clarifications).push(clarifyId);
          const reply = card ? { answer: cardAnswer, source: 'option' } : { answer, source };
          assert.ok(reply.answer, `Unexpected ${card ? 'card' : 'question'} in ${variant}`);
          assert.equal((await message('clarify_response', { tabId, clarifyId, ...reply })).ok, true);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const result = await message('chat', { tabId, text: 'send this photo to gamze on instagram', mode: 'act',
      requestId: `owned-recipient-${variant}`, locale: 'en' });
    answering = false; await answerer;
    const toolResults = result.updates.filter(event => event.type === 'tool_result').map(event => ({ name: event.data?.name,
      success: event.data?.result?.success, reasonCode: event.data?.result?.reasonCode || null,
      recipientBinding: event.data?.result?.recipientBinding || null, note: event.data?.result?.note || null,
      error: event.data?.result?.error || null }));
    const prompts = result.updates.filter(event => event.type === 'clarify').map(event => ({ kind: event.data?.promptKind,
      question: event.data?.question, recipientConfirmation: event.data?.recipientConfirmation || null }));
    await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ toolResults, prompts, clarifications, cards, sends,
      judgeCalls, blockedRemote }, null, 2));
    const uploads = toolResults.filter(item => item.name === 'upload_file');
    assert.equal(sends.length, expectedSends, `Sends: ${JSON.stringify(toolResults)}`);
    assert.equal(await page.locator('[data-message-direction="outgoing"]').count(), expectedSends);
    assert.equal(cards.length, 1, `WebBrain's card is shown once: ${JSON.stringify(prompts)}`);
    assert.equal(clarifications.length, steps.includes('clarify') ? 1 : 0, JSON.stringify(prompts));
    if (cards.length) {
      const card = prompts.find(item => item.kind === 'recipientConfirmation');
      assert.deepEqual(card.recipientConfirmation, { recipients: [{ identity: recipient, role: 'to' }],
        requested: ['gamze'], host: 'www.instagram.com', offerAll: false });
      assert.equal(card.question, `Send to ${recipient}?`);
    }
    if (approved) {
      assert.equal(uploads.length, steps.filter(kind => kind === 'upload').length, JSON.stringify(uploads));
      assert.equal(uploads.at(-1).success, true, JSON.stringify(uploads.at(-1)));
      if (threadPage === 'instagram-rerendered') {
        assert.equal(uploads[0].success, false, JSON.stringify(uploads[0]));
        assert.match(uploads[0].error || '', /not covered by the observed action context/, JSON.stringify(uploads[0]));
      }
      assert.deepEqual(sends, [{ method: 'POST', path: '/api/v1/direct_v2/threads/17848282661759097/items/configure_photo/', containsPhoto: true }]);
      if (clarifications.length) {
        const clarify = toolResults.find(item => item.name === 'clarify');
        assert.equal(clarify?.recipientBinding, null, `The model's own question approved nothing: ${JSON.stringify(clarify)}`);
      }
    } else {
      assert.equal(uploads.at(-1)?.reasonCode, 'recipient_declined', JSON.stringify(uploads));
      if (clarifications.length) {
        const clarify = toolResults.find(item => item.name === 'clarify');
        assert.equal(clarify?.recipientBinding, null, JSON.stringify(clarify));
      }
    }
    console.log(JSON.stringify({ passed: true, installedMV3: true, variant, questions: clarifications.length,
      cards: cards.length, sends: sends.length, uploads: uploads.map(item => item.success === true ? 'sent' : item.reasonCode),
      judgeCalls, blockedRemote }));
  } finally {
    await context?.close(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-recipient-clarify-mv3-')) throw new Error('Unexpected temporary profile path.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
