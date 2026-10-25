import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';
import { fixedChoiceQuestion, fixturePageTextReply } from '../semantic-decision-stub.mjs';

// Mastodon's single-column layout (narrow windows) routes a toot's Reply
// button to /publish with history.pushState, and after a successful submit
// the composer calls history.back(). Both route changes are the clicks' own
// effects. They used to be reported as "Observation interrupted ... outcome
// unknown", so a model re-posted the same reply and never reached the next
// toot. The extension, browser dispatch, page monitor, webNavigation events
// and completion gates are real; provider and site requests stay local.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-16/mastodon-reply-route-mv3');
await fs.mkdir(out, { recursive: true });
const origin = 'https://mastoturk.org';
const account = 'webbrain_qa_owned';
const statuses = [
  { id: '117439857549626876', author: 'shifthaber', name: 'Shift Haber', text: 'Owned QA review of a hybrid tank SUV.' },
  { id: '117439857549626999', author: 'qa_quotes', name: 'QA Quotes', text: 'Owned QA quote about economic victories.' },
];
const replyText = '@shifthaber Owned QA reply: what a ride.';
const task = `Reply to the Shift Haber toot in my favourites with exactly this text: "${replyText}". Post only that one reply and verify it under the toot.`;
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['One exact reply under the Shift Haber toot, verified.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Reply once to the Shift Haber toot and verify the reply.',
  steps: [{ id: '1', action: 'Open the reply composer, enter the exact reply, post it once and verify it in the thread.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
const posts = [], providerRequests = [], toolResults = [];
let actionCalls = 0, judgeCalls = 0, authorizationCalls = 0, blockedRemote = 0;
const completionRecovery = { reads: 0 };
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
const toolData = message => {
  const content = textOf(message.content);
  try { return JSON.parse(content); } catch {}
  try { return JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { return null; }
};
const refFor = (input, pattern) => {
  for (const message of [...input.messages].reverse()) {
    if (message.role !== 'tool') continue;
    const line = String(toolData(message)?.pageContent || '').split('\n').find(line => pattern.test(line));
    const ref = line?.match(/\[(ref_\d+)\]/)?.[1];
    if (ref) return ref;
  }
  throw new Error(`The owned fixture did not observe ${pattern}`);
};
const server = http.createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = ''; for await (const part of request) raw += part;
  const input = JSON.parse(raw); providerRequests.push(input);
  await new Promise(resolve => setTimeout(resolve, 60));
  const system = textOf(input.messages?.[0]?.content);
  let completion;
  if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
    judgeCalls++;
    completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded',
      reason: 'The fresh thread shows exactly one owned reply with the requested text under the Shift Haber toot.' }) };
  } else if (system.startsWith('Identify only the exact plain public Mastodon post authorized by the genuine user task.')) {
    completion = { role: 'assistant', content: JSON.stringify({ kind: 'unsupported', body: null, account: null }) };
  } else if (system.startsWith('Check one separately proposed consequential action')) {
    authorizationCalls++;
    const latest = JSON.parse(textOf(input.messages[1].content)).latestAcceptedRequest;
    const untrusted = textOf(input.messages.at(-1).content);
    const { key } = JSON.parse(untrusted.slice(untrusted.indexOf('{'), untrusted.lastIndexOf('}') + 1));
    completion = { role: 'assistant', content: JSON.stringify({ key, authorized: true, latestRequestEvidence: latest }) };
  } else if (fixturePageTextReply(input.messages)) {
    completion = { role: 'assistant', content: fixturePageTextReply(input.messages) };
  } else if (fixedChoiceQuestion(input.messages)) {
    completion = { role: 'assistant', content: JSON.stringify({ choice: '', evidence: '' }) };
  } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
  else {
    for (const message of input.messages) {
      if (message.role === 'tool' && !toolResults.some(entry => entry.id === message.tool_call_id)) {
        toolResults.push({ id: message.tool_call_id, result: toolData(message) });
      }
    }
    const step = actionCalls++;
    const read = { name: 'get_accessibility_tree', args: { filter: 'all' } };
    const call = step === 1 ? { name: 'click_ax', args: { ref_id: refFor(input, /button "Reply to Shift Haber"/) } }
      : step === 3 ? { name: 'set_field', args: { ref_id: refFor(input, /textbox "Reply text"/), text: replyText, clear: true } }
      : step === 4 ? { name: 'click_ax', args: { ref_id: refFor(input, /button "Post reply"/) } }
      : step === 6 ? { name: 'navigate', args: { url: `${origin}/@shifthaber/${statuses[0].id}` } }
      : step >= 8 ? { name: 'done', args: { outcome: 'success', summary: `Posted one reply "${replyText}" under the Shift Haber toot and verified it in the thread.` } }
      : read;
    const emitted = conformFixtureCompletionCall(input, call, completionRecovery);
    completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-reply-${step}`, type: 'function',
      function: { name: emitted.name, arguments: JSON.stringify(emitted.args) } }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// One document serves every route. Like Mastodon's single-column UI, the app
// renders by location.pathname and moves between columns with the History API.
const pageBody = () => `<!doctype html><meta charset="utf-8"><title>MastoTurk</title>
<style>body{font:18px sans-serif;margin:20px;width:700px}.status{margin:16px 0;padding:10px;border:1px solid #999}textarea{display:block;width:640px;height:100px}button{padding:10px;margin:4px}</style>
<div class="navigation-panel"><a class="account__display-name" href="/@${account}">@${account}</a> <a href="/favourites">Favourites</a></div>
<main id="app"></main>
<script>
const statuses = ${JSON.stringify(statuses)};
const replies = ${JSON.stringify(posts.map(post => ({ inReplyTo: post.in_reply_to_id, text: post.status })))};
const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let replyTo = null;
const card = status => '<article class="status"><a class="status__relative-time" href="/@' + status.author + '/' + status.id + '">1d</a> '
  + '<a class="status__display-name" href="/@' + status.author + '">' + esc(status.name) + '</a>'
  + '<div class="status__content__text status__content__text--visible"><p>' + esc(status.text) + '</p></div>'
  + '<div class="status__action-bar"><button type="button" class="icon-button" data-reply="' + status.id + '" aria-label="Reply to ' + esc(status.name) + '">Reply</button>'
  + '<button type="button" class="icon-button" aria-label="Unfavourite ' + esc(status.name) + '">Unfavourite</button></div></article>';
function render() {
  const app = document.getElementById('app');
  const permalink = location.pathname.match(/^\\/@([a-z0-9_]+)\\/(\\d+)$/);
  if (location.pathname === '/publish' && replyTo) {
    app.innerHTML = '<h1>New post</h1><div class="compose-form__reply-indicator">Replying to ' + esc(replyTo.name) + ': ' + esc(replyTo.text) + '</div>'
      + '<form class="compose-form"><textarea class="autosuggest-textarea__textarea" aria-label="Reply text"></textarea>'
      + '<div class="compose-form__submit"><button type="submit">Post reply</button></div></form>';
    const composer = app.querySelector('textarea');
    composer.value = '@' + replyTo.author + ' ';
    app.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const response = await fetch('/api/v1/statuses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: composer.value, in_reply_to_id: replyTo.id, visibility: 'public' }) });
      if (!response.ok) return;
      replyTo = null;
      // Mastodon returns to the previous column after a reply from /publish.
      history.back();
    };
  } else if (permalink) {
    const status = statuses.find(item => item.id === permalink[2]);
    app.innerHTML = '<h1>Thread</h1>' + (status ? card(status) : '<p>Not found</p>') + replies.filter(reply => reply.inReplyTo === permalink[2])
      .map(reply => '<article class="status reply"><a class="status__display-name" href="/@${account}">@${account}</a><p>' + esc(reply.text) + '</p></article>').join('');
  } else {
    app.innerHTML = '<h1>Favourites</h1>' + statuses.map(card).join('');
  }
}
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-reply]');
  if (!button) return;
  replyTo = statuses.find(status => status.id === button.dataset.reply);
  history.pushState({ compose: true }, '', '/publish');
  render();
});
// Like many SPAs, restore column state right after a traversal.
window.addEventListener('popstate', () => { render(); history.replaceState({ restored: true }, '', location.href); });
render();
</script>`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-mastodon-reply-mv3-'));
let context;
try {
  const extension = path.join(profile, 'extension');
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    viewport: { width: 1017, height: 745 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const request = route.request(), requested = new URL(request.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (requested.origin === origin) {
      if (requested.pathname === '/api/v1/statuses' && request.method() === 'POST') {
        posts.push(request.postDataJSON());
        // A real network round trip: the composer leaves /publish only after it.
        await new Promise(resolve => setTimeout(resolve, 150));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: String(200 + posts.length) }) });
      }
      if (request.isNavigationRequest() && request.method() === 'GET') return route.fulfill({ contentType: 'text/html', body: pageBody() });
      return route.fulfill({ status: 404, body: '' });
    }
    if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
  await worker.evaluate(() => {
    const send = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const requested = new URL(typeof input === 'string' ? input : input.url);
      if (requested.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(requested.protocol)) return send(input, options);
      return Promise.reject(new Error('The owned reply fixture blocks external network requests.'));
    };
  });
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
    autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', maxAgentSteps: 14, systemOneEnabled: false, agentAllowLocalNetwork: true,
    askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage();
  await page.goto(`${origin}/favourites`);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, `${origin}/favourites`);
  let watchdog;
  const result = await Promise.race([
    message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-mastodon-reply', locale: 'en' }),
    new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`The reply run did not finish; provider requests: ${providerRequests.length}, actions: ${actionCalls}`)), 150_000); }),
  ]).finally(() => clearTimeout(watchdog));
  const results = result.updates.filter(event => event.type === 'tool_result');
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, posts, judgeCalls, authorizationCalls,
    toolResults, providerRequests, blockedRemote }, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
  const clicks = results.filter(event => event.data?.name === 'click_ax').map(event => event.data.result);
  assert.equal(clicks.length, 2, JSON.stringify(results.map(event => event.data?.name)));
  const [openReply, postReply] = clicks;
  // The Reply button's pushState to /publish is that click's observed effect.
  assert.equal(openReply.success, true, JSON.stringify(openReply));
  assert.notEqual(openReply.outcomeUnknown, true, JSON.stringify(openReply));
  assert.equal(openReply.verified, true, JSON.stringify(openReply));
  if (openReply.method === 'cdp-native-button') assert.ok(openReply.observedEffects?.includes('url'), JSON.stringify(openReply));
  // The composer's own history.back() after its POST is not a user Back
  // press. The trusted submit accepts that route as its effect, but a route
  // reached by Back is never its proof (any frame's script can go back), so
  // the press is delivered and awaits a fresh observation: never interrupted
  // or unknown.
  assert.equal(postReply.method, 'cdp-native-button', JSON.stringify(postReply));
  assert.equal(postReply.success, true, JSON.stringify(postReply));
  assert.notEqual(postReply.outcomeUnknown, true, JSON.stringify(postReply));
  assert.notEqual(postReply.observationInterrupted, true, JSON.stringify(postReply));
  assert.notEqual(postReply.observedEffects?.includes('url'), true, JSON.stringify(postReply));
  assert.ok(postReply.verified === true || postReply.effectVerificationPending === true, JSON.stringify(postReply));
  assert.equal(result.updates.some(event => event.type === 'page_feedback' && event.data?.navigation && event.data.source === 'user'), false,
    'No route change of this run is reported as the user\'s navigation');
  assert.deepEqual(posts, [{ status: replyText, in_reply_to_id: statuses[0].id, visibility: 'public' }], 'Exactly one reply is posted.');
  const done = results.findLast(event => event.data?.name === 'done')?.data?.result;
  assert.equal(done?.done, true, JSON.stringify(done));
  assert.equal(done?.outcome, 'success', JSON.stringify(done));
  console.log(JSON.stringify({ passed: true, installedMV3: true, openReplyMethod: openReply.method, posts: posts.length, openReplyEffects: openReply.observedEffects,
    postReplyMethod: postReply.method, postReplyEffects: postReply.observedEffects || null, postReplyVerified: postReply.verified === true,
    judgeCalls, authorizationCalls, blockedRemote }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-mastodon-reply-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
