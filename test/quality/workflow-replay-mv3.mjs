import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Installed extension, genuine trusted user demonstration, normal background
// compile/export/import and replay. No Agent or content handler is mocked.
// All forms, runtime values and the provider belong to this isolated fixture.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/workflow-replay-mv3');
await fs.mkdir(out, { recursive: true });
const started = Date.now(), posts = [], providerRequests = [], cases = [];
const demoValue = 'DEMONSTRATION_ONLY_ıİ_😀_<literal>';
const demoSecret = 'DEMONSTRATION_PASSWORD_ONLY_123';
const runtimeValue = 'PARAMETER_QA_2026_ıİşŞğĞüÜöÖçÇ_中文_😀_<literal>&';
const runtimeSecret = 'RUNTIME_PRIVATE_PARAMETER_ONLY_456';
const fixtureKey = 'owned-fixture-provider-key-never-export';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixtureGeneration(value) {
  switch (value) {
    case null: case '': case 'demonstration': return 'demonstration';
    case 'fresh-replay': return 'fresh-replay';
    case 'stop-before-submit': return 'stop-before-submit';
    case 'explicit-new-replay': return 'explicit-new-replay';
    case 'uncertain-value': return 'uncertain-value';
    default: return null;
  }
}
function fixtureMode(value) {
  switch (value) {
    case null: case '': case 'normal': return 'normal';
    case 'uncertain': return 'uncertain';
    default: return null;
  }
}
function html(generation, mode) {
  return `<!doctype html><meta charset="utf-8"><title>Owned workflow QA</title>
  <style>body{font:16px system-ui;margin:24px}input,button{font:inherit;margin:8px;padding:8px}label{display:block}</style>
  <h1>Owned workflow QA</h1><p>Document generation ${generation}</p>
  ${generation === 'demonstration' ? '' : '<button type="button" id="decoy">Do not submit</button><p>Fresh layout and fresh element identities</p>'}
  ${generation === 'fresh-replay' ? '<label for="qa-value-demonstration">Unrelated QA field</label><input id="qa-value-demonstration" name="different_field" type="text" value="PRESERVE_OWNED_DECOY">' : ''}
  <form id="qa-form-${generation}">
    <label for="qa-value-${generation}">QA parameter value</label><input id="qa-value-${generation}" name="qa_value" type="text" required>
    <label for="qa-secret-${generation}">QA password</label><input id="qa-secret-${generation}" name="qa_secret" type="password" required>
    <button id="qa-submit-${generation}" type="submit">Save owned QA form</button>
  </form><p id="receipt" role="status"></p>
  <script>
    window.qaInputEvents = 0; window.qaWrongClicks = 0;
    document.querySelector('#decoy')?.addEventListener('click', () => qaWrongClicks++);
    const value = document.querySelector('[name="qa_value"]');
    value.addEventListener('input', () => { qaInputEvents++; if (${JSON.stringify(mode)} === 'uncertain') value.value = 'APPLICATION_CHANGED_VALUE'; });
    document.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.target, body = Object.fromEntries(new FormData(form));
      const response = await fetch('/save', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ generation:${JSON.stringify(generation)}, mode:${JSON.stringify(mode)}, ...body }) });
      const result = await response.json();
      if (response.ok) { form.reset(); form.querySelector('button').disabled = true; document.querySelector('#receipt').textContent = 'Owned QA form saved receipt ' + result.receipt; }
    };
  </script>`;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/save') {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); posts.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ receipt: `owned-${posts.length}` })); return;
  }
  if (url.pathname === '/v1/chat/completions') {
    let text = ''; for await (const chunk of req) text += chunk;
    providerRequests.push(JSON.parse(text));
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Deterministic workflow fixture must not need model fallback.', code: 'owned_fixture_unavailable' } })); return;
  }
  const generation = fixtureGeneration(url.searchParams.get('generation'));
  const mode = fixtureMode(url.searchParams.get('mode'));
  if (generation === null || mode === null) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"error":"Unsupported workflow fixture preset."}'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html(generation, mode));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-workflow-replay-'));
let context, harness, page;
try {
  const extension = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION_PATH || 'src/chrome');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['chrome-extension:', 'data:'].includes(url.protocol)
      ? route.continue() : route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const rejectedPresets = [
    { name: 'generation-html-script', query: { generation: '<script>globalThis.qaInjected=true</script>' } },
    { name: 'generation-attribute', query: { generation: '\" autofocus onfocus=\"globalThis.qaInjected=true' } },
    { name: 'generation-script-boundary', query: { generation: '</ScRiPt><script>globalThis.qaInjected=true</script>' } },
    { name: 'mode-script-boundary', query: { mode: '</script><script>globalThis.qaInjected=true</script>' } },
    { name: 'unknown-generation', query: { generation: 'unknown-preset' } },
    { name: 'unknown-mode', query: { mode: 'unknown-mode' } },
  ];
  const rejectionPage = await context.newPage();
  try {
    for (const { name, query } of rejectedPresets) {
      const response = await rejectionPage.goto(`${base}/form?${new URLSearchParams(query)}`);
      assert.equal(response.status(), 400, name);
      assert.match(response.headers()['content-type'], /^application\/json\b/i, name);
      const body = await response.text();
      assert.equal(body, '{"error":"Unsupported workflow fixture preset."}', name);
      for (const value of Object.values(query)) assert.equal(body.includes(value), false, name);
      const rendered = await rejectionPage.evaluate(() => ({ injected: globalThis.qaInjected === true,
        forms: document.querySelectorAll('form').length }));
      assert.equal(rendered.injected, false, name);
      assert.equal(rendered.forms, 0, name);
    }
  } finally { await rejectionPage.close(); }
  assert.equal(posts.length, 0, 'Rejected presets cannot submit a form.');
  assert.equal(providerRequests.length, 0, 'Rejected presets cannot call the provider.');
  cases.push({ name: 'untrusted-fixture-presets-rejected', passed: true, negativeQueries: rejectedPresets.length,
    status: 400, reflectedQueryValues: false, executedInjectedScript: false });
  harness = await context.newPage(); await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  const message = async (action, data = {}) => {
    const pending = harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
    let timer;
    try {
      return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned background ${action} exceeded 35 seconds.`)), 35000); })]);
    } finally { clearTimeout(timer); }
  };
  harness.on('console', event => { if (event.text().startsWith('OWNED_WORKFLOW')) console.log(event.text()); });
  await harness.evaluate(async () => {
    window.qaEvents = []; window.qaPhase = 'ready'; window.qaHeldSubmit = null;
    chrome.runtime.onMessage.addListener(event => {
      if (event.action !== 'agent_update') return;
      qaEvents.push({ phase: qaPhase, type: event.type, data: event.data });
      console.log('OWNED_WORKFLOW ' + JSON.stringify({ phase: qaPhase, type: event.type, name: event.data?.name, promptKind: event.data?.promptKind }));
      if (event.type !== 'clarify') return;
      if (qaPhase === 'stop-before-submit' && event.data?.promptKind === 'submitConfirmation') {
        qaHeldSubmit = { tabId: event.tabId, clarifyId: event.data.clarifyId }; return;
      }
      if (['permission', 'submitConfirmation'].includes(event.data?.promptKind)) {
        chrome.runtime.sendMessage({ target: 'background', action: 'clarify_response', tabId: event.tabId,
          clarifyId: event.data.clarifyId, answer: 'once', source: 'user' }).catch(() => {});
      }
    });
    await chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, planBeforeActMode: 'off', planReviewMode: 'never',
      screenshotFallback: false, autoScreenshot: false, systemOneEnabled: false, tracingEnabled: true,
      feedbackDiagnosticsEnabled: false, losslessTrace: true, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: true, openaiAskStreamingEnabled: false, maxAgentSteps: 10 });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: {
    enabled: true, apiKey: fixtureKey, baseUrl: `${base}/v1`, model: 'owned-workflow-no-fallback', contextWindow: 128000,
  } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  page = await context.newPage(); await page.goto(`${base}/form?generation=demonstration&private_query=DO_NOT_EXPORT#private-fragment`);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  assert.ok(tabId);
  const teaching = await message('start_teacher_mode', { tabId, name: 'Owned parameterized native form QA' });
  assert.equal(teaching.ok, true, JSON.stringify(teaching));
  await page.locator('#webbrain-teacher-indicator').waitFor();
  const blockedRun = await message('chat', { tabId, text: 'Do not run while teaching is active.', mode: 'act', requestId: 'workflow-teacher-interlock' });
  assert.match(String(blockedRun.error || blockedRun.content || ''), /teach|teacher|demonstrat/i, JSON.stringify(blockedRun));
  assert.equal(providerRequests.length, 0);
  await page.locator('[name="qa_value"]').fill(demoValue);
  await page.locator('[name="qa_secret"]').fill(demoSecret);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#receipt').textContent.includes('Owned QA form saved receipt'));
  await harness.waitForFunction(async tabId => {
    const result = await chrome.runtime.sendMessage({ target: 'background', action: 'get_teacher_mode', tabId });
    return result.session.actionCount >= 3;
  }, tabId);
  const compiled = await message('end_teacher_mode', { tabId });
  assert.equal(compiled.ok, true, JSON.stringify(compiled)); assert.equal(compiled.stopped, true);
  assert.equal(compiled.workflow.steps.length, 3); assert.equal(compiled.workflow.parameters.length, 2);
  assert.equal(compiled.workflow.parameters.find(p => p.id === 'qa_secret')?.sensitive, true);
  assert.equal(posts.length, 1); assert.equal(posts[0].qa_value, demoValue); assert.equal(posts[0].qa_secret, demoSecret);
  const exported = await message('export_saved_workflow', { id: compiled.workflow.id });
  assert.equal(exported.ok, true);
  const portableText = JSON.stringify(exported.workflow);
  for (const forbidden of [demoValue, demoSecret, fixtureKey, 'private_query', 'private-fragment', 'ref_id', 'selector', 'workflowParameters']) {
    assert.equal(portableText.includes(forbidden), false, `Portable workflow must exclude ${forbidden}.`);
  }
  const imported = await message('import_saved_workflow', { definition: JSON.parse(portableText) });
  assert.equal(imported.ok, true, JSON.stringify(imported)); assert.notEqual(imported.workflow.id, compiled.workflow.id);
  assert.equal((await message('list_saved_workflows')).workflows.length, 2, 'Import must create a separate local resource.');
  await fs.writeFile(path.join(out, 'portable-workflow.json'), JSON.stringify(exported.workflow, null, 2));
  const workflowId = imported.workflow.id;
  const parameters = { qa_value: runtimeValue, qa_secret: runtimeSecret };
  const replay = async phase => {
    await harness.evaluate(phase => { qaPhase = phase; qaHeldSubmit = null; }, phase);
    return message('chat', { tabId, workflowId, workflowParameters: parameters, mode: 'act', requestId: `workflow-${phase}`, locale: 'en' });
  };
  const checkResult = (result, success) => {
    const done = result.updates?.findLast(update => update.type === 'tool_result' && update.data?.name === 'done')?.data?.result;
    assert.equal(done?.done, true, JSON.stringify(result)); assert.equal(done?.outcome, success ? 'success' : 'failed');
    const serialized = JSON.stringify(result);
    for (const value of [runtimeValue, runtimeSecret, fixtureKey]) assert.equal(serialized.includes(value), false, 'Replay UI/conversation must keep runtime values private.');
    return done;
  };

  await page.goto(`${base}/form?generation=fresh-replay&nonce=NEW_DOCUMENT`);
  const freshRun = replay('fresh-replay');
  await page.waitForFunction(() => document.querySelector('[name="qa_value"]').value !== ''
    || document.querySelector('[name="different_field"]').value !== 'PRESERVE_OWNED_DECOY');
  const decoyPreserved = await page.locator('[name="different_field"]').inputValue() === 'PRESERVE_OWNED_DECOY';
  if (!decoyPreserved) { await message('abort', { tabId }); await freshRun; }
  assert.equal(decoyPreserved, true, 'A recycled DOM id with a contradictory native field name must not receive the workflow parameter.');
  const completed = await freshRun; checkResult(completed, true);
  assert.equal(posts.length, 2); assert.equal(posts[1].qa_value, runtimeValue); assert.equal(posts[1].qa_secret, runtimeSecret);
  assert.equal(posts[1].generation, 'fresh-replay');
  assert.equal(await page.evaluate(() => qaWrongClicks), 0);
  assert.match(await page.locator('#receipt').textContent(), /Owned QA form saved receipt/);
  cases.push({ name: 'fresh-document-parameterized-replay', passed: true, postCount: 1, matchedSteps: 3,
    reusedIdWrongFieldPreserved: decoyPreserved,
    parameterBytes: Buffer.byteLength(runtimeValue), parameterSha256: hash(runtimeValue), secretSha256: hash(runtimeSecret), modelCalls: providerRequests.length });

  await page.goto(`${base}/form?generation=stop-before-submit`);
  const stoppingRun = replay('stop-before-submit');
  await harness.waitForFunction(() => qaHeldSubmit?.clarifyId, null, { timeout: 20000 });
  assert.equal(posts.length, 2, 'No POST while awaiting fresh submit consent.');
  const stopStarted = Date.now(); assert.equal((await message('abort', { tabId })).ok, true);
  const stopped = await stoppingRun; checkResult(stopped, false);
  const stopMs = Date.now() - stopStarted;
  assert.match(stopped.content, /stopped by the user/i);
  const held = await harness.evaluate(() => qaHeldSubmit);
  const staleApproval = await message('clarify_response', { ...held, answer: 'once', source: 'user' });
  assert.equal(staleApproval.ok, false, 'A late submit approval cannot revive a stopped replay.');
  await page.waitForTimeout(100); assert.equal(posts.length, 2);
  cases.push({ name: 'stop-before-submit-and-late-approval', passed: true, postCount: 0, stopMs, staleApprovalRejected: true });

  await page.goto(`${base}/form?generation=explicit-new-replay`);
  const resumed = await replay('explicit-new-replay'); checkResult(resumed, true);
  assert.equal(posts.length, 3); assert.equal(posts[2].qa_value, runtimeValue); assert.equal(posts[2].qa_secret, runtimeSecret);
  cases.push({ name: 'explicit-replay-after-stop', passed: true, postCount: 1, matchedSteps: 3 });

  await page.goto(`${base}/form?generation=uncertain-value&mode=uncertain`);
  const uncertain = await replay('uncertain-value'); checkResult(uncertain, false);
  assert.equal(posts.length, 3, 'An uncertain write must not proceed to submit.');
  assert.equal(uncertain.updates.filter(update => update.type === 'tool_call' && update.data?.name === 'type_ax').length, 1, 'Do not retry an already dispatched uncertain write.');
  assert.equal(uncertain.updates.some(update => update.type === 'workflow_fallback'), false, 'Unknown dispatch must not enter model fallback.');
  assert.equal(await page.locator('[name="qa_value"]').inputValue(), 'APPLICATION_CHANGED_VALUE');
  cases.push({ name: 'uncertain-native-write-stops-without-retry', passed: true, postCount: 0, fieldToolCalls: 1, modelFallback: false });

  const local = await harness.evaluate(() => chrome.storage.local.get(null));
  const session = await harness.evaluate(() => chrome.storage.session.get(null));
  const persistedDefinitions = JSON.stringify(local.wb_saved_workflows_v1);
  const conversationMessages = JSON.stringify(Object.fromEntries(Object.entries(session)
    .filter(([key]) => key.startsWith('session:')).map(([key, value]) => [key, value?.messages || []])));
  for (const value of [demoValue, demoSecret, runtimeValue, runtimeSecret]) {
    assert.equal(persistedDefinitions.includes(value), false); assert.equal(conversationMessages.includes(value), false);
  }
  const recorded = await harness.evaluate(async () => {
    const trace = await import(chrome.runtime.getURL('src/trace/recorder.js'));
    await trace.flushPendingWrites();
    const runs = await trace.listRuns({ limit: 25 });
    return Promise.all(runs.map(async run => ({ run, events: await trace.getRunEvents(run.runId) })));
  });
  for (const value of [runtimeValue, runtimeSecret, fixtureKey]) assert.equal(JSON.stringify(recorded).includes(value), false, 'Deterministic replay trace must exclude runtime values and provider keys.');
  assert.equal(providerRequests.length, 0, 'All supported replays remain deterministic, including safe stop.');
  const events = await harness.evaluate(() => qaEvents);
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ passed: true, durationMs: Date.now() - started,
    build: 'chrome-installed-mv3', productionCommands: ['start_teacher_mode', 'end_teacher_mode', 'export_saved_workflow', 'import_saved_workflow', 'chat.workflowId', 'abort', 'clarify_response'],
    teaching: { capturedActions: compiled.workflow.steps.length, parameters: compiled.workflow.parameters.length, valuesRetained: false },
    importedAsSeparateWorkflow: true, privateConfigExported: false, runtimeValuesPersisted: false,
    cases, postCount: posts.length, teachingPostCount: 1, replayPostCount: 2,
    traceRunCount: recorded.length, providerRequests: providerRequests.length, externalRequestsAllowed: false,
    terminalEvents: events.filter(event => ['run_complete', 'clarify'].includes(event.type)),
  }, null, 2));
  console.log(JSON.stringify({ passed: true, cases, durationMs: Date.now() - started, teachingPosts: 1, replayPosts: 2, externalPosts: 0 }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, cases,
    posts: posts.map(post => ({ generation: post.generation, mode: post.mode, valueSha256: hash(post.qa_value || ''), secretSha256: hash(post.qa_secret || '') })),
    providerRequests: providerRequests.length, events: harness ? await harness.evaluate(() => qaEvents).catch(() => []) : [],
    nativeFields: page ? await page.locator('input').evaluateAll(inputs => inputs.map(input => ({ id: input.id, name: input.name,
      untouchedDecoy: input.name === 'different_field' ? input.value === 'PRESERVE_OWNED_DECOY' : undefined }))).catch(() => []) : [],
  }, null, 2));
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-workflow-replay-')) throw new Error('Unexpected isolated profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
