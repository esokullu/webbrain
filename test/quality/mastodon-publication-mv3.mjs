import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// The markup matches the sanitized native Mastoturk structure captured from
// the authorized QA account. All service requests are fulfilled locally.
// Only the provider is deterministic; actual Agent and completion gates run.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/mastodon-publication-mv3');
await fs.mkdir(out, { recursive: true });
const body = 'Owned WebBrain publication: exact spaces  and Turkish ıİşŞğĞüÜöÖçÇ. This complete text exceeds the generic form summary limit of one hundred twenty characters.';
const account = 'webbrain_qa_owned';
const url = 'https://mastoturk.org/home';
const verificationRead = process.env.WEBBRAIN_QUALITY_PUBLICATION_READ || 'profile';
assert.ok(['profile', 'permalink'].includes(verificationRead), 'Choose a current profile AX read or native permalink prose read.');
const task = `Publish exactly one public plain-text post from our active Mastodon QA account "${account}" with this exact text: ${JSON.stringify(body)}. Verify the newly published post. Do not send messages, change settings or publish anything else.`;
const posts = [];
let actionCalls = 0, compilerCalls = 0, judgeCalls = 0, refs = {}, blockedRemote = 0;
let postCreatedAt = '';
const providerRequests = [];
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['One exact public plain-text QA post, freshly verified.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Publish exactly the requested plain public post from the authorized active QA account and verify it.',
  steps: [{ id: '1', action: 'Enter the complete exact requested text, publish once and verify the resulting native status.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
const server = http.createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = ''; for await (const part of request) raw += part;
  const input = JSON.parse(raw); providerRequests.push(input);
  await new Promise(resolve => setTimeout(resolve, 100));
  const system = textOf(input.messages?.[0]?.content);
  const isJudge = system.startsWith('Evaluate only the observable requirements of the genuine user task');
  const isCompiler = system.startsWith('Identify only the exact plain public Mastodon post authorized by the genuine user task.');
  const isAction = Array.isArray(input.tools) && input.tools.length > 0;
  let completion;
  if (isJudge) {
    judgeCalls++;
    completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Exercise native dispatch-bound exact publication proof.' }) };
  } else if (isCompiler) {
    compilerCalls++;
    completion = { role: 'assistant', content: JSON.stringify({ kind: 'exact_plain_public_post',
      body: { source: 'task', start: body.slice(0, 26), end: body.slice(-27) },
      account: { source: 'task', start: account, end: account } }) };
  } else if (!isAction) completion = { role: 'assistant', content: JSON.stringify(intent) };
  else {
    const verificationSteps = verificationRead === 'permalink'
      ? [{ name: 'navigate', args: { url } },
        { name: 'navigate', args: { url: `https://mastoturk.org/@${account}/200` } },
        { name: 'read_page', args: { limit: 2000 } }]
      : [{ name: 'navigate', args: { url: `https://mastoturk.org/@${account}` } },
        { name: 'get_accessibility_tree', args: { filter: 'all' } }];
    const step = [{ name: 'set_field', args: { ref_id: refs.body, text: body } },
      { name: 'click_ax', args: { ref_id: refs.publish } },
      ...verificationSteps][actionCalls++]
      || { name: 'done', args: { outcome: 'success', summary: 'The exact authorized QA post was published once and verified.' } };
    completion = { role: 'assistant', content: '', tool_calls: [{ id: `native-post-${actionCalls}`, type: 'function',
      function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const card = (id, author, text) => `<div class="status__wrapper status__wrapper-public"><div class="status status-public"><a class="status__relative-time" href="/@${author}/${id}"><time datetime="${id === '100' ? new Date(Date.now() - 86400000).toISOString() : postCreatedAt}">Now</time></a><a class="status__display-name" href="/@${author}">@${author}</a><svg class="icon icon-globe" aria-hidden="true" focusable="false"></svg><div class="status__content"><div class="status__content__text status__content__text--visible"><p>${escape(text)}</p></div></div></div></div>`;
const pageBody = `<!doctype html><meta charset="utf-8"><title>Owned Mastodon publication fixture</title><style>body{font:18px sans-serif;margin:25px}form{padding:12px}textarea{display:block;width:650px;height:110px}svg{width:14px;height:14px}.status{margin:20px}</style>
<form><input placeholder="Search Mastodon"></form><form class="compose-form"><div class="navigation-bar"><a class="account__display-name" href="/@${account}">@${account}</a></div><div class="compose-form__dropdowns"><button class="dropdown-button" type="button"><svg class="icon icon-globe" aria-hidden="true" focusable="false"></svg>Public</button></div><textarea class="autosuggest-textarea__textarea" aria-label="Post text"></textarea><div class="compose-form__submit"><button type="submit">Publish QA post</button></div></form><main id="statuses">NATIVE_STATUS_CARDS</main>
<script>document.querySelector('form.compose-form').onsubmit=async event=>{event.preventDefault();const input=document.querySelector('textarea');input.disabled=true;const result=await fetch('/api/v1/statuses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:input.value,visibility:'public'})});const data=await result.json();const node=document.createElement('div');node.innerHTML=data.html;document.querySelector('#statuses').prepend(node.firstElementChild);input.value='';input.disabled=false;};</script>`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-mastodon-mv3-'));
let context;
try {
  const extension = path.join(profile, 'extension');
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  // Expose the real instance only in this disposable clone for failure
  // diagnostics. No method, permission or completion gate is replaced.
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.mastodonFixtureAgent = agent;\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const request = route.request(), requested = new URL(request.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    if (requested.origin === 'https://mastoturk.org') {
      if (requested.pathname === '/api/v1/statuses' && request.method() === 'POST') {
        const post = request.postDataJSON(); posts.push(post); postCreatedAt = new Date().toISOString();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ html: card('200', account, post.status) }) });
      }
      if (request.isNavigationRequest() && request.method() === 'GET') return route.fulfill({ contentType: 'text/html',
        body: pageBody.replace('NATIVE_STATUS_CARDS', `${posts.length ? card('200', account, posts[0].status) : ''}${card('100', account, body)}`) });
      return route.fulfill({ status: 404, body: '' });
    }
    if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
  await worker.evaluate(() => {
    const send = fetch.bind(globalThis);
    globalThis.mastodonFixtureNetwork = { allowed: [], blocked: [] };
    globalThis.fetch = (input, options) => {
      const requested = new URL(typeof input === 'string' ? input : input.url);
      if (requested.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(requested.protocol)) {
        mastodonFixtureNetwork.allowed.push(requested.origin); return send(input, options);
      }
      mastodonFixtureNetwork.blocked.push(requested.origin);
      return Promise.reject(new Error('The isolated native publication fixture blocks external network requests.'));
    };
  });
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, tracingEnabled: false,
    autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', maxAgentSteps: 10, systemOneEnabled: false, agentAllowLocalNetwork: true,
    askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  let nativeVisibilityCases = 0;
  for (const build of ['chrome', 'firefox']) {
    const { captureNativeMastodonPublication } = await import(`../../src/${build}/src/agent/mastodon-publication.js`);
    const capture = () => page.evaluate(captureNativeMastodonPublication);
    const native = await capture();
    assert.equal(native.publicVisibility, true, `${build}: decorative aria-hidden SVG still displays public privacy.`);
    assert.equal(native.records[0].public, true, `${build}: rendered native globe establishes public status.`);
    nativeVisibilityCases += 2;
    for (const attribute of ['hidden', 'inert', 'aria-hidden']) {
      await page.locator('.compose-form__dropdowns').evaluate((element, attribute) => element.setAttribute(attribute, 'true'), attribute);
      assert.equal((await capture()).publicVisibility, false, `${build}: ${attribute} parent cannot supply native public visibility.`);
      await page.locator('.compose-form__dropdowns').evaluate((element, attribute) => element.removeAttribute(attribute), attribute);
      nativeVisibilityCases++;
    }
    for (const css of ['display:none', 'visibility:hidden', 'visibility:collapse', 'opacity:0']) {
      await page.locator('.compose-form__dropdowns svg').evaluate((element, css) => element.setAttribute('style', css), css);
      assert.equal((await capture()).publicVisibility, false, `${build}: invisible decorative icon cannot certify public privacy.`);
      await page.locator('.compose-form__dropdowns svg').evaluate(element => element.removeAttribute('style'));
      nativeVisibilityCases++;
    }
    for (const css of ['opacity:0', 'content-visibility:hidden']) {
      await page.locator('.compose-form__dropdowns').evaluate((element, css) => element.setAttribute('style', css), css);
      assert.equal((await capture()).publicVisibility, false, `${build}: concealed parent cannot certify public privacy.`);
      await page.locator('.compose-form__dropdowns').evaluate(element => element.removeAttribute('style'));
      nativeVisibilityCases++;
    }
    await page.locator('.status svg').evaluate(element => element.setAttribute('hidden', ''));
    assert.equal((await capture()).records[0].public, false, `${build}: hidden status globe is not visibility proof.`);
    await page.locator('.status svg').evaluate(element => element.removeAttribute('hidden'));
    nativeVisibilityCases++;
  }
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  const observation = await harness.evaluate(tabId => chrome.tabs.sendMessage(tabId, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'all' } }), tabId);
  refs.body = observation.pageContent.split('\n').find(line => /textbox "Post text"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
  refs.publish = observation.pageContent.split('\n').find(line => /button "Publish QA post"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
  assert.ok(refs.body && refs.publish);
  await harness.evaluate(() => {
    window.nativePublicationEvents = [];
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update' && event.requestId === 'owned-native-publication')
        nativePublicationEvents.push({ type: event.type, data: event.data });
    });
  });
  const result = await message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-native-publication', locale: 'en' });
  const events = await harness.evaluate(() => nativePublicationEvents);
  const diagnostic = await worker.evaluate(async tabId => {
    const agent = mastodonFixtureAgent;
    return { submit: agent._completionSubmitStates.get(tabId), completion: agent.completionInvariants.get(tabId),
      native: await agent._captureNativeMastodonPublication(tabId),
      receipt: await agent._freshMastodonPublicationEvidence(tabId, (await chrome.tabs.get(tabId)).url),
      network: mastodonFixtureNetwork };
  }, tabId);
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, events, diagnostic, posts, judgeCalls, compilerCalls,
    providerRequests, blockedRemote }, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
  assert.deepEqual(posts, [{ status: body, visibility: 'public' }], 'Publish exactly once with complete untruncated user text.');
  assert.equal(await page.locator('textarea').inputValue(), '');
  const done = result.updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
  assert.equal(done?.done, true, JSON.stringify(done));
  assert.equal(done?.outcome, 'success', JSON.stringify(done));
  assert.equal(events.findLast(event => event.type === 'run_complete')?.data?.status, 'completed');
  assert.ok(judgeCalls > 0, 'An uncertain model verdict must exercise independent native publication proof.');
  console.log(JSON.stringify({ passed: true, installedMV3: true, posts: posts.length, compilerCalls, judgeCalls, oldSameBodyRetained: true, nativeVisibilityCases, verificationRead }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-mastodon-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
