// Your trace: on MastoTurk WebBrain posted something, then "now delete it"
// came in as a correction. Every click on the post's "Sil" was refused as
// prior_effect_unreconciled ("the earlier submission ... has not been observed
// yet"), with the post right there on the timeline: Mastodon shows it on the
// home timeline, not at an address of its own, so WebBrain never matched it to
// the form it was sent from, and no card was offered that could have let the
// person's yes count. Here the deletion goes to WebBrain's own card once, and
// that answer also covers Mastodon's confirmation: exactly the new post is
// deleted, once. The extension, provider pipeline, dispatch and gates are
// real; the pages, posts and model are owned local fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';
import { defaultDecide, fixedChoiceQuestion, fixtureFixedChoiceReply, fixturePageTextReply } from '../semantic-decision-stub.mjs';

const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-18/mastodon-delete-after-correction-mv3');
await fs.mkdir(out, { recursive: true });
const request = 'go to mastoturk.org and try to post something';
const correction = 'now delete it';
// A refused click is tried again, as the model in the trace did.
const retries = 2;
const account = 'webbrain_qa_owned';
const body = 'WebBrain test gönderisi';

const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
function objectFrom(content) {
  const text = textOf(content);
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
      }
    }
  }
  return null;
}
const toolMessages = messages => {
  const names = new Map((messages || []).flatMap(message => (message.tool_calls || []).map(call => [call.id, call.function?.name])));
  return (messages || []).filter(message => message.role === 'tool')
    .map(message => ({ id: message.tool_call_id, name: names.get(message.tool_call_id), result: objectFrom(message.content) }));
};
const refFrom = (tree, pattern) => String(tree?.result?.pageContent || '').split('\n').find(line => pattern.test(line))?.match(/\[(ref_\d+)\]/)?.[1];

// Mastodon 4.4 markup (from the delete-confirmation fixture), newest first.
// On the timeline now, and every post the fixture accepted.
const posts = [], created = [];
const statusId = index => String(117450000000000000n + BigInt(index));
const post = (id, text, author = account) => `<article data-id="${id}"><div class="status__wrapper status__wrapper-public focusable" tabindex="0" aria-label="QA, ${text}, 18 Eki 07:30, ${author}">
<div class="status status-public"><div class="status__info"><a href="/@${author}/${id}" class="status__relative-time"><time>1m</time></a>
<a href="/@${author}" title="${author}" class="status__display-name"><span class="display-name"><bdi><strong class="display-name__html">QA</strong></bdi> <span class="display-name__account">@${author}</span></span></a></div>
<div class="status__content"><div class="status__content__text status__content__text--visible translate" lang="tr"><p>${text}</p></div></div>
<div class="status__action-bar"><div class="status__action-bar__button-wrapper"><button type="button" aria-label="Yanıtla" title="Yanıtla" class="status__action-bar__button icon-button"><svg class="icon icon-reply" aria-hidden="true"></svg></button></div>
<div class="status__action-bar__button-wrapper"><button type="button" aria-label="Daha fazla" aria-expanded="false" title="Daha fazla" class="status__action-bar__button icon-button"><svg class="icon icon-ellipsis-h" aria-hidden="true"></svg></button></div></div></div></div></article>`;
const menu = '<div class="dropdown-animation dropdown-menu bottom"><div class="dropdown-menu__arrow bottom"></div><div class="dropdown-menu__container"><ul class="dropdown-menu__container__list">'
  + '<li class="dropdown-menu__item"><button data-index="0">Bu gönderiyi genişlet</button></li><li class="dropdown-menu__item"><button data-index="1">Gönderi bağlantısını kopyala</button></li>'
  + '<li class="dropdown-menu__separator"></li><li class="dropdown-menu__item"><button data-index="3">Düzenle</button></li>'
  + '<li class="dropdown-menu__item dropdown-menu__item--dangerous"><button data-index="4">Sil</button></li>'
  + '<li class="dropdown-menu__item dropdown-menu__item--dangerous"><button data-index="5">Sil, Düzenle ve yeniden-paylaş</button></li></ul></div></div>';
const confirmation = '<div style="pointer-events:auto"><div role="presentation" class="modal-root__overlay"></div><div role="dialog" class="modal-root__container">'
  + '<div class="modal-root__modal safety-action-modal"><div class="safety-action-modal__top"><div class="safety-action-modal__confirmation"><h1>Gönderiyi sil?</h1><p>Bu gönderiyi silmek istediğinden emin misin?</p></div></div>'
  + '<div class="safety-action-modal__bottom"><div class="safety-action-modal__actions"><button class="link-button">İptal</button><button type="button" class="button">Sil</button></div></div></div></div></div>';
const homeBody = () => `<!doctype html><meta charset="utf-8"><title>Anasayfa - MastoTurk</title>
<script id="initial-state" type="application/json">${JSON.stringify({ meta: { me: '1', delete_modal: true },
  accounts: { 1: { id: '1', username: account, acct: account, url: `https://mastoturk.org/@${account}` } } })}</script>
<style>body{margin:0;font:15px sans-serif}button{padding:8px}.columns-area__panels{display:flex}.columns-area__panels__main{width:600px}.navigation-panel{width:300px;padding:8px}
.modal-root__overlay{position:fixed;inset:0;background:rgba(0,0,0,.4)}.modal-root__container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
.safety-action-modal{position:relative;background:#fff;padding:20px}.dropdown-menu{background:#fff;border:1px solid #888}svg{width:12px;height:12px;display:inline-block}</style>
<div class="app-holder" id="mastodon"><div class="ui"><div class="columns-area__panels"><div class="columns-area__panels__main"><div class="column" role="region" aria-label="Anasayfa"><div role="feed" class="item-list" id="feed">
${[...posts].reverse().map(item => post(item.id, item.text)).join('')}${post('117442625347497184', 'Another owned QA post')}${post('117439945096942320', 'Someone else', 'otherqa')}
</div></div></div><div class="columns-area__panels__pane columns-area__panels__pane--start columns-area__panels__pane--navigational"><div class="columns-area__panels__pane__inner"><div class="navigation-panel">
<div class="navigation-bar"><div class="account account--minimal"><div class="account__wrapper"><div class="account__info-wrapper"><a class="account__display-name" title="${account}" href="/@${account}"><span class="display-name__account">@${account}</span></a></div></div></div></div>
<div class="navigation-panel__menu"><a class="button navigation-panel__compose-button column-link" href="/publish">Yeni Gönderi</a><a class="column-link" href="/home">Anasayfa</a></div></div></div></div>
</div><div class="modal-root"></div></div></div>
<script>
const ui = document.querySelector('.ui'), modalRoot = document.querySelector('.modal-root');
const background = inert => { for (const sibling of ui.children) if (sibling !== modalRoot) inert ? sibling.setAttribute('inert', '') : sibling.removeAttribute('inert'); };
const closeModal = () => { modalRoot.replaceChildren(); background(false); };
for (const more of document.querySelectorAll('.status__action-bar button[aria-label="Daha fazla"]')) more.onclick = () => {
  if (document.querySelector('#post-menu')) return;
  const id = more.closest('article').dataset.id, holder = document.createElement('div');
  holder.id = 'post-menu'; holder.style.cssText = 'position:absolute;left:560px;top:' + (more.getBoundingClientRect().bottom + 4) + 'px;z-index:5';
  holder.innerHTML = ${JSON.stringify(menu)};
  more.setAttribute('aria-expanded', 'true'); more.setAttribute('aria-controls', 'post-menu');
  document.body.append(holder);
  const closeMenu = () => { holder.remove(); more.setAttribute('aria-expanded', 'false'); };
  for (const item of holder.querySelectorAll('button[data-index]')) item.onclick = () => {
    closeMenu();
    if (item.dataset.index !== '4') return;
    setTimeout(() => {
      modalRoot.innerHTML = ${JSON.stringify(confirmation)}; background(true);
      modalRoot.querySelector('.link-button').onclick = closeModal;
      modalRoot.querySelector('.button').onclick = async () => {
        const result = await fetch('/api/v1/statuses/' + id, { method: 'DELETE' });
        if (result.ok) { document.querySelector('article[data-id="' + id + '"]').remove(); closeModal(); }
      };
    }, 60);
  };
};
</script>`;
const composeBody = `<!doctype html><meta charset="utf-8"><title>Yeni gönderi - MastoTurk</title>
<style>body{font:16px sans-serif;margin:24px} textarea{width:500px;height:120px} button{padding:10px 18px}</style>
<form class="compose-form"><div class="navigation-bar"><a class="account__display-name" href="/@${account}">@${account}</a></div>
<textarea class="autosuggest-textarea__textarea" aria-label="Aklında ne var?" placeholder="Aklında ne var?"></textarea>
<div class="compose-form__submit"><button type="submit">Gönder</button></div></form>
<script>
document.querySelector('form.compose-form').addEventListener('submit', async event => {
  event.preventDefault();
  const response = await fetch('/api/v1/statuses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: document.querySelector('textarea').value, visibility: 'public' }) });
  if (response.ok) location.href = '/home';
});
</script>`;

// The model.
let steered = false, judgeCalls = 0, blockedRemote = 0;
const deletes = [], unknownPrompts = [], cards = [], decisions = [];
const phase = { name: 'before', index: 0, lastId: null, emitted: 0, attempts: 0 };
const completionRecovery = { reads: 0 };
const blockedResult = result => result && (result.blocked === true || result.denied === true || result.success === false);
const before = [
  () => ({ name: 'navigate', args: { url: 'https://mastoturk.org/publish' } }),
  () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
  tree => ({ name: 'set_field', args: { ref_id: refFrom(tree, /textbox "Aklında ne var\?"/), text: body } }),
  tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Gönder"/) } }),
  async (_tree, run) => { await run.steer(); return { name: 'get_accessibility_tree', args: { filter: 'all' } }; },
  () => ({ name: 'done', args: { outcome: 'success', summary: 'Posted a test message on mastoturk.org.' } }),
];
const after = [
  () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
  tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Daha fazla"/) }, consequential: true }),
  () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
  tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Sil"$/) || refFrom(tree, /button "Sil"/) }, consequential: true }),
  () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
  tree => ({ name: 'click_ax', args: { ref_id: refFrom(tree, /button "Sil"/) }, consequential: true }),
  () => ({ name: 'get_accessibility_tree', args: { filter: 'all' } }),
  () => ({ name: 'done', args: { outcome: 'success', summary: 'Deleted the test post.' } }),
];
const intent = () => ({ request_kind: 'execute', scope_relation: steered ? 'revision' : 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: [steered ? 'The test post is deleted' : 'A post on mastoturk.org'],
  completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  read_scope: 'visible_page', summary: steered ? 'Delete the post just published.' : 'Post something on mastoturk.org.',
  steps: [{ id: '1', action: steered ? 'Delete the post that was just published and verify it is gone.' : 'Compose and publish a post, then verify it.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] });

let context, page, panel, tabId = null, worker;
const run = {
  async steer() {
    for (let wait = 0; !posts.length && wait < 50; wait++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(posts.length, 1, 'The Mastodon post was sent before the correction');
    const accepted = await panel.evaluate(({ tabId, text }) => chrome.runtime.sendMessage({ target: 'background', action: 'chat_steer',
      tabId, requestId: 'owned-delete-after-correction', messageId: 'owned-now-delete-it', text }), { tabId, text: correction });
    assert.equal(accepted?.accepted, true, JSON.stringify(accepted));
    steered = true;
  },
};
const server = http.createServer(async (incoming, response) => {
  if (incoming.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = ''; for await (const part of incoming) raw += part;
  const input = JSON.parse(raw), system = textOf(input.messages?.[0]?.content);
  let completion;
  try {
    if (system.startsWith('Extract stable user preferences')) completion = { role: 'assistant', content: '{"memories":[]}' };
    else if (system === 'Hi' || textOf(input.messages?.at(-1)?.content) === 'Hi') completion = { role: 'assistant', content: 'Hello' };
    else if (system.startsWith('Identify only the exact plain public Mastodon post')) completion = { role: 'assistant',
      content: JSON.stringify({ kind: 'unsupported', body: null, account: null }) };
    else if (system.startsWith("Compile the user's social-publication intent")) completion = { role: 'assistant',
      content: JSON.stringify({ version: 1, status: 'none', actions: [], requirements: null, prohibited: [], reason: 'No X or Bluesky publication is requested.' }) };
    else if (fixturePageTextReply(input.messages)) completion = { role: 'assistant', content: fixturePageTextReply(input.messages) };
    else if (fixedChoiceQuestion(input.messages)) {
      const question = fixedChoiceQuestion(input.messages);
      if (['deletion_request', 'deletion_prerequisite'].includes(question.kind)) decisions.push({ kind: question.kind, request: question.request, page: question.page });
      completion = { role: 'assistant', content: /^- "mode_claim":/m.test(system) ? JSON.stringify({ choice: 'result', evidence: '' })
        : fixtureFixedChoiceReply(input.messages, {
          deletion_request: ({ request, page }) => defaultDecide('deletion_request', { request, page }),
          deletion_prerequisite: ({ request, page }) => defaultDecide('deletion_prerequisite', { request, page }),
          user_turn_kind: 'continue' }) };
    } else if (system.startsWith('Check one separately proposed consequential action')) {
      const trusted = JSON.parse(textOf(input.messages[1].content)), proposed = objectFrom(input.messages[2].content);
      completion = { role: 'assistant', content: JSON.stringify({ key: proposed.key, authorized: true, latestRequestEvidence: trusted.latestAcceptedRequest }) };
    } else if (system.startsWith('Independently check whether the authentic user request authorizes')) {
      const audit = JSON.parse(textOf(input.messages.find(message => message.role === 'user')?.content));
      completion = { role: 'assistant', content: JSON.stringify({ key: audit.key, actionId: audit.action.id, authorized: true, reason: 'Requested.' }) };
    } else if (system.startsWith('Evaluate only the observable requirements')) {
      judgeCalls++;
      completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'The page shows the expected result.' }) };
    } else if (!input.tools?.length) {
      if (!system.startsWith('You are the intent and compact planning subsystem') && !system.startsWith('You are the planning subsystem')) unknownPrompts.push(system.slice(0, 160));
      completion = { role: 'assistant', content: JSON.stringify(intent()) };
    } else {
      const tools = toolMessages(input.messages);
      if (steered && phase.name === 'before' && JSON.stringify(input.messages).includes(correction)) Object.assign(phase, { name: 'after', index: 0, lastId: null, attempts: 0 });
      else if (phase.lastId && tools.some(tool => tool.id === phase.lastId)) {
        const last = tools.find(tool => tool.id === phase.lastId);
        const steps = phase.name === 'before' ? before : after;
        const wasConsequential = phase.name === 'after' && [1, 3, 5].includes(phase.index);
        // A refused consequential click is tried again, as a model would.
        if (wasConsequential && blockedResult(last?.result) && phase.attempts < retries) phase.attempts++;
        else { phase.index = Math.min(phase.index + 1, steps.length - 1); phase.attempts = 0; }
      }
      const steps = phase.name === 'before' ? before : after;
      const tree = tools.findLast(tool => tool.name === 'get_accessibility_tree' && tool.result?.pageContent);
      const step = await steps[phase.index](tree, run);
      const call = conformFixtureCompletionCall(input, { name: step.name, args: step.args }, completionRecovery);
      phase.lastId = `owned-${phase.name}-${phase.index}-${++phase.emitted}`;
      completion = { role: 'assistant', content: '', tool_calls: [{ id: phase.lastId, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
  } catch (error) {
    unknownPrompts.push(`provider error: ${error.stack || error.message}`);
    response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `response-${phase.emitted}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-delete-after-correction-mv3-'));
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.afterCorrectionAgent = agent;\n');
  context = await chromium.launchPersistentContext(path.join(profile, 'user'), { headless: true, channel: 'chromium',
    viewport: { width: 1126, height: 745 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const routed = route.request(), requested = new URL(routed.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (requested.origin === 'https://mastoturk.org') {
      if (requested.pathname === '/api/v1/statuses' && routed.method() === 'POST') {
        const id = statusId(posts.length + 1);
        posts.push({ id, text: JSON.parse(routed.postData() || '{}').status }); created.push(posts.at(-1).text);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, url: `https://mastoturk.org/@${account}/${id}` }) });
      }
      const status = requested.pathname.match(/^\/api\/v1\/statuses\/(\d+)$/)?.[1];
      if (status && routed.method() === 'DELETE') {
        deletes.push(status); const index = posts.findIndex(item => item.id === status); if (index >= 0) posts.splice(index, 1);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (requested.pathname === '/publish') return route.fulfill({ contentType: 'text/html', body: composeBody });
      if (routed.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: homeBody() });
      return route.fulfill({ status: 404, body: '' });
    }
    if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  const settings = await context.newPage(); await settings.goto(`${extensionOrigin}/src/ui/settings.html`);
  panel = await context.newPage(); await panel.goto(`${extensionOrigin}/src/ui/sidepanel.html`);
  const message = (action, data = {}) => settings.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await settings.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, userMemoryEnabled: false, tracingEnabled: false,
    autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never',
    maxAgentSteps: 40, systemOneEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false,
    openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `${base}/v1`, model: 'minimax/minimax-m3', enabled: true, contextWindow: 1000000, supportsAskStreaming: false, supportsVision: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  await worker.evaluate(() => { afterCorrectionAgent.clarifyTimeoutSec = -1; });
  page = await context.newPage(); await page.goto('https://mastoturk.org/home');
  tabId = await settings.evaluate(async () => (await chrome.tabs.query({}))
    .find(tab => { try { return new URL(tab.url).origin === 'https://mastoturk.org'; } catch { return false; } })?.id);
  // WebBrain's own cards are answered "Go ahead" ('once'); every card is recorded.
  let answering = true;
  const answerer = (async () => {
    const answered = new Set();
    while (answering) {
      const pending = await worker.evaluate(tabId => [...(afterCorrectionAgent._pendingClarifications.get(tabId)?.entries() || [])]
        .map(([id, entry]) => ({ id, question: String(entry?.question || entry?.data?.question || '').slice(0, 300) })), tabId).catch(() => []);
      for (const { id, question } of pending) {
        if (answered.has(id)) continue;
        answered.add(id); cards.push({ id: id.replace(/_[a-z0-9]{8,}$/i, '_*'), question });
        await message('clarify_response', { tabId, clarifyId: id, answer: 'once', source: 'option' }).catch(() => {});
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  // The poller stops however the run ends, so a failed run fails the test
  // instead of leaving it waiting.
  let result;
  try {
    result = await message('chat', { tabId, text: request, mode: 'act', requestId: 'owned-delete-after-correction', locale: 'en' });
  } finally {
    answering = false; await answerer;
  }
  const toolResults = (result.updates || []).filter(event => event.type === 'tool_result').map(event => ({ name: event.data?.name,
    success: event.data?.result?.success, guard: event.data?.result?.actionGuard || null,
    error: event.data?.result?.error ? String(event.data.result.error).slice(0, 400) : null }));
  const clarifies = (result.updates || []).filter(event => event.type === 'clarify')
    .map(event => ({ kind: event.data?.promptKind || null, question: String(event.data?.question || '').slice(0, 300) }));
  const done = result.updates?.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result || null;
  const evidence = { request, correction, created, posts, deletes, steered, toolResults, clarifies, cards, decisions, unknownPrompts, judgeCalls, blockedRemote,
    done: done && { outcome: done.outcome, summary: String(done.summary || '').slice(0, 300), error: done.error || null }, finalContent: String(result.content || '').slice(0, 600) };
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  assert.deepEqual(unknownPrompts, [], 'Every model question was one the fixture answers');
  assert.equal(steered, true, 'The correction arrived after the post was sent');
  const refused = toolResults.filter(item => item.guard);
  assert.deepEqual(refused, [], `No step of the deletion was refused: ${JSON.stringify(refused)}`);
  assert.deepEqual(cards.map(card => card.id), ['deletion_*'], `One question, WebBrain's deletion card: ${JSON.stringify(cards)}`);
  assert.deepEqual(deletes, [statusId(1)], 'Exactly the new post is deleted, once, through Mastodon\'s confirmation');
  assert.deepEqual(created, [body], 'One post, before the correction');
  assert.deepEqual(posts, [], 'and it is gone from the timeline');
  assert.equal(evidence.done?.outcome, 'success', JSON.stringify(evidence.done));
  console.log(JSON.stringify({ passed: true, installedMV3: true, deletes: deletes.length, cards: cards.length, refused: refused.length, judgeCalls, blockedRemote }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-delete-after-correction-mv3-')) await fs.rm(resolved, { recursive: true, force: true });
}
