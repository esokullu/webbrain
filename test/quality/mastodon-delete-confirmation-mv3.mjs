import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';
import { fixedChoiceQuestion, fixtureControlEffectReading, fixtureFixedChoiceReply, fixturePageTextReply } from '../semantic-decision-stub.mjs';

// A trace: on Mastodon's home timeline, in a 1126 px wide tab beside
// WebBrain's panel, WebBrain opened its own post's "Daha fazla" menu and chose
// "Sil"; the confirmation that click opened was refused as "not inside one
// identifiable record". No model had read "Sil" when the menu entry was
// clicked, and Mastodon marks the page behind its confirmation inert. The page
// follows Mastodon 4.4/4.5 markup at that width: no composer beside the
// timeline, the signed-in account in the navigation panel, the menu mounted at
// the end of the body, the confirmation loaded a moment after the click, and
// ModalRoot marking every sibling of .modal-root inert while it is open. The
// extension, provider pipeline, dispatch and gates are real; the page and the
// model are owned local fixtures.
// By default the menu caption has no reading when its entry is clicked, as in
// the trace; --menu-read has every caption read, which leaves only the inert
// page behind the confirmation. --vague asks only "delete it", as the trace
// did: WebBrain asks once on its own card whether to delete this post, and
// that answer also covers Mastodon's confirmation.
const menuReading = process.argv.includes('--menu-read') ? 'read' : process.env.WEBBRAIN_QUALITY_MASTODON_MENU_READING || 'unread';
assert.ok(['unread', 'read'].includes(menuReading));
const vague = process.argv.includes('--vague');
const variant = `${menuReading}${vague ? '-vague' : ''}`;
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || `ci/artifacts/quality-audit-2026-10-15/mastodon-delete-confirmation-mv3/${variant}`);
await fs.mkdir(out, { recursive: true });
const account = 'webbrain_qa_owned', postId = '117446231630065843', otherId = '117442625347497184';
const resource = `https://mastoturk.org/@${account}/${postId}`, pageUrl = 'https://mastoturk.org/home';
const named = `Delete only our owned QA test post at "${resource}" with body "Owned QA test post". Deleting this one disposable post is explicitly authorized. Do not delete or publish anything else. Verify it is removed.`;
const task = vague ? 'delete it' : named;
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['The owned QA test post is deleted and verified.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Delete and verify only the owned QA test post.',
  steps: [{ id: '1', action: 'Open the post menu, choose Sil, confirm, and verify the post is gone.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
let deleted = false, actionCalls = 0, judgeCalls = 0, blockedRemote = 0, menuCaptionAsked = 0;
const completionRecovery = { reads: 0 };
const deletes = [], providerRequests = [], judgeEvidence = [];
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
const refFor = (input, name) => {
  for (const message of [...input.messages].reverse()) {
    if (message.role !== 'tool') continue;
    let data; try { data = JSON.parse(textOf(message.content)); } catch {
      const content = textOf(message.content), start = content.indexOf('{');
      try { data = JSON.parse(content.slice(start, content.lastIndexOf('}') + 1)); } catch { continue; }
    }
    const line = String(data.pageContent || '').split('\n').find(line => line.includes(`button "${name}"`));
    const ref = line?.match(/\[(ref_\d+)\]/)?.[1];
    if (ref) return ref;
  }
  const last = [...input.messages].reverse().find(message => message.role === "tool");
  throw new Error(`Owned fixture did not observe ${name}`);
};
const server = http.createServer(async (request, response) => {
  if (request.url === '/resource') {
    response.writeHead(deleted ? 404 : 200, { 'Content-Type': 'text/html' });
    response.end(deleted ? 'The owned QA post is absent.' : 'Owned QA test post'); return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = ''; for await (const part of request) raw += part;
  const input = JSON.parse(raw); providerRequests.push(input);
  await new Promise(resolve => setTimeout(resolve, 60));
  const system = textOf(input.messages?.[0]?.content);
  let completion;
  // What the buttons say, read by the model. In the trace "Sil" had no
  // reading yet when its menu entry was clicked: the first time it is asked,
  // this model gives no answer for it.
  const controlEffect = fixedChoiceQuestion(input.messages)?.kind === 'control_effect'
    ? fixtureFixedChoiceReply(input.messages, { control_effect: ({ item }) => {
      if (item?.text === 'Sil' && ++menuCaptionAsked === 1 && menuReading === 'unread') return null;
      return fixtureControlEffectReading(item?.text);
    } }) : null;
  if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
    judgeCalls++; judgeEvidence.push(textOf(input.messages[1]?.content));
    completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded',
      reason: 'The exact resource returns HTTP404 after the owned confirmation and the timeline no longer shows it.' }) };
  } else if (system.startsWith('Identify only the exact plain public Mastodon post authorized by the genuine user task.')) {
    completion = { role: 'assistant', content: JSON.stringify({ kind: 'unsupported', body: null, account: null }) };
  } else if (controlEffect) {
    completion = { role: 'assistant', content: controlEffect };
  } else if (fixturePageTextReply(input.messages)) {
    completion = { role: 'assistant', content: fixturePageTextReply(input.messages) };
  } else if (system.startsWith("Answer one fixed-choice question for a browser agent's safety check.")) {
    // The request names exactly this post by its link.
    const request = JSON.parse(textOf(input.messages[1].content)).request;
    const untrusted = textOf(input.messages.at(-1).content);
    const { page } = JSON.parse(untrusted.slice(untrusted.indexOf('{'), untrusted.lastIndexOf('}') + 1));
    const exact = system.includes('"delete_this"') && request === named && page?.link === resource;
    completion = { role: 'assistant', content: JSON.stringify(exact
      ? { choice: 'delete_this', evidence: `Delete only our owned QA test post at "${resource}"` } : { choice: 'unclear', evidence: '' }) };
  } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
  else {
    const step = actionCalls++;
    const call = step === 1 ? { name: 'click_ax', args: { ref_id: refFor(input, 'Daha fazla') } }
      : step === 3 ? { name: 'click_ax', args: { ref_id: refFor(input, 'Sil') } }
      : step === 5 ? { name: 'click_ax', args: { ref_id: refFor(input, 'Sil') } }
      : step === 6 ? { name: 'fetch_url', args: { url: resource } }
      : step === 7 ? { name: 'read_page', args: { limit: 2000 } }
      : step > 7 ? { name: 'done', args: { outcome: 'success', summary: 'The owned QA test post was deleted once and verified absent.' } }
      : { name: 'get_accessibility_tree', args: { filter: 'all' } };
    const emitted = conformFixtureCompletionCall(input, call, completionRecovery);
    completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-confirmation-${step}`, type: 'function',
      function: { name: emitted.name, arguments: JSON.stringify(emitted.args) } }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const post = (id, text, author = account) => `<article data-id="${id}"><div class="status__wrapper status__wrapper-public focusable" tabindex="0" aria-label="QA, ${text}, 15 Eki 21:01, ${author}">
<div class="status status-public"><div class="status__info"><a href="/@${author}/${id}" class="status__relative-time"><time>9m</time></a>
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
const pageBody = `<!doctype html><meta charset="utf-8"><title>Anasayfa - MastoTurk</title>
<script id="initial-state" type="application/json">${JSON.stringify({ meta: { me: '1', delete_modal: true },
  accounts: { 1: { id: '1', username: account, acct: account, url: `https://mastoturk.org/@${account}` } } })}</script>
<style>body{margin:0;font:15px sans-serif}button{padding:8px}.columns-area__panels{display:flex}.columns-area__panels__main{width:600px}.navigation-panel{width:300px;padding:8px}
.modal-root__overlay{position:fixed;inset:0;background:rgba(0,0,0,.4)}.modal-root__container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
.safety-action-modal{position:relative;background:#fff;padding:20px}.dropdown-menu{background:#fff;border:1px solid #888}svg{width:12px;height:12px;display:inline-block}</style>
<div class="app-holder" id="mastodon"><div class="ui"><div class="columns-area__panels"><div class="columns-area__panels__main"><div class="column" role="region" aria-label="Anasayfa"><div role="feed" class="item-list" id="feed">
${post(postId, 'Owned QA test post')}${post(otherId, 'Another owned QA post')}${post('117439945096942320', 'Someone else', 'otherqa')}
</div></div></div><div class="columns-area__panels__pane columns-area__panels__pane--start columns-area__panels__pane--navigational"><div class="columns-area__panels__pane__inner"><div class="navigation-panel">
<form class="search"><input type="text" class="search__input" placeholder="Ara veya bağlantıyı yapıştır"></form>
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
  more.querySelector('svg').setAttribute('class', 'icon icon-close');
  document.body.append(holder);
  const closeMenu = () => { holder.remove(); more.setAttribute('aria-expanded', 'false'); more.querySelector('svg').setAttribute('class', 'icon icon-ellipsis-h'); };
  for (const item of holder.querySelectorAll('button[data-index]')) item.onclick = () => {
    closeMenu();
    if (item.dataset.index !== '4') return;
    // The confirmation's code loads a moment after the click.
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

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-mastodon-confirm-mv3-'));
let context;
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  await fs.appendFile(path.join(extension, 'src/background.js'), `
globalThis.confirmationFixtureAgent = agent;
globalThis.confirmationFixtureReceipts = [];
const recordOwnedConfirmationReceipt = agent._recordCompletionSubmitAttempt;
agent._recordCompletionSubmitAttempt = function (...args) {
  const receipt = recordOwnedConfirmationReceipt.apply(this, args);
  if (receipt) confirmationFixtureReceipts.push({ taskKey: receipt.taskKey, runToken: receipt.runToken,
    mutationKind: receipt.mutationKind, resourceUrl: receipt.actionResource?.url });
  return receipt;
};
`);
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    viewport: { width: 1126, height: 745 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const request = route.request(), requested = new URL(request.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (requested.origin === 'https://mastoturk.org') {
      const status = requested.pathname.match(/^\/api\/v1\/statuses\/(\d+)$/)?.[1];
      if (status && request.method() === 'DELETE') {
        deletes.push(status); if (status === postId) deleted = true;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (request.isNavigationRequest() && requested.href === pageUrl) return route.fulfill({ contentType: 'text/html', body: pageBody });
      return route.fulfill({ status: 404, body: '' });
    }
    if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
  await worker.evaluate(({ resource, bridge }) => {
    const send = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const requested = new URL(typeof input === 'string' ? input : input.url);
      if (requested.href === resource && (!options?.method || options.method === 'GET')) {
        // A local mapping of the owned origin, not a redirect.
        return send(bridge, options).then(response => Object.defineProperty(response, 'url', { value: requested.href }));
      }
      if (requested.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(requested.protocol)) return send(input, options);
      return Promise.reject(new Error('Owned confirmation fixture blocks external network requests.'));
    };
  }, { resource, bridge: `http://127.0.0.1:${server.address().port}/resource` });
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
    autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', maxAgentSteps: 14, systemOneEnabled: false, agentAllowLocalNetwork: true,
    askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(pageUrl);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, pageUrl);
  // WebBrain's deletion card is answered "Delete"; any other question would be
  // unexpected here.
  const cards = [], unexpected = [];
  let answering = true;
  const answerer = (async () => {
    const answered = new Set();
    while (answering) {
      const pending = await worker.evaluate(tabId => [...(confirmationFixtureAgent._pendingClarifications.get(tabId)?.keys() || [])], tabId);
      for (const clarifyId of pending) {
        if (answered.has(clarifyId)) continue;
        answered.add(clarifyId);
        if (!clarifyId.startsWith('deletion_')) { unexpected.push(clarifyId); continue; }
        cards.push(clarifyId);
        assert.equal((await message('clarify_response', { tabId, clarifyId, answer: 'once', source: 'option' })).ok, true);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  const result = await message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-mastodon-confirmation', locale: 'en' });
  answering = false; await answerer;
  const prompts = result.updates.filter(event => event.type === 'clarify' && event.data?.promptKind === 'mutationConfirmation')
    .map(event => event.data.mutationConfirmation);
  const diagnostic = await worker.evaluate(tabId => ({ submit: confirmationFixtureAgent._completionSubmitStates.get(tabId),
    receipts: confirmationFixtureReceipts, currentTaskKey: confirmationFixtureAgent._progressTaskKeyHash(tabId) }), tabId);
  const blocked = result.updates.filter(event => event.type === 'tool_result' && event.data?.result?.actionGuard)
    .map(event => ({ tool: event.data.name, reason: event.data.result.actionGuard.reason }));
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, diagnostic, deletes, blocked, cards, prompts, unexpected, judgeCalls,
    judgeEvidence, menuCaptionAsked, blockedRemote }, (_key, value) => typeof value === 'string' && value.startsWith('data:image/')
    ? '[owned fixture screenshot omitted]' : value, 2));
  assert.deepEqual(unexpected, [], 'No other question was asked');
  assert.deepEqual(blocked, [], `No step of the deletion was refused: ${JSON.stringify(blocked)}`);
  // A vague request is put to the user once, about this post; the answer
  // holds for Mastodon's own confirmation too. A request naming the post asks
  // nothing.
  assert.equal(cards.length, vague ? 1 : 0, JSON.stringify(prompts));
  if (vague) assert.equal(prompts[0]?.url, resource, JSON.stringify(prompts));
  assert.deepEqual(deletes, [postId], 'The confirmation deleted exactly the post whose menu opened it, once.');
  if (menuReading === 'unread') assert.ok(menuCaptionAsked >= 2, 'The menu caption had no reading when its entry was clicked.');
  assert.deepEqual(diagnostic.receipts, [{ taskKey: diagnostic.currentTaskKey, runToken: diagnostic.submit.runToken,
    mutationKind: 'delete', resourceUrl: resource }], 'One deletion receipt, bound to the post; the menu entry made none.');
  const done = result.updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
  assert.equal(done?.done, true, JSON.stringify(done)); assert.equal(done?.outcome, 'success', JSON.stringify(done));
  assert.ok(judgeEvidence.some(text => /404/.test(text)), 'The post being gone reaches the completion check.');
  console.log(JSON.stringify({ passed: true, installedMV3: true, menuReading, vague, deletes, receipts: diagnostic.receipts.length,
    blocked: blocked.length, cards: cards.length, judgeCalls, blockedRemote }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-mastodon-confirm-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
