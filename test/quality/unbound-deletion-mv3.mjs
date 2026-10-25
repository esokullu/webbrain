import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';

// A requested Remove on an ordinary cart row (no permalink) runs through the
// installed MV3 extension: real probe, guards, dispatch and completion gates,
// once directly, once through a confirmation dialog, and once for a Turkish
// request that names the row in its inflected form ("tişörtü" for "Tişört").
// Whether the request names the row is a fixed-choice question the model
// answers from the request as written and the row as the page shows it; no
// word list is involved. A request that does not say which row ("the first
// item") is put to the user on WebBrain's own card: Delete removes that row
// once, including through the site's own confirmation dialog, and Don't
// delete removes nothing.
// The provider and the site are owned local fixtures; nothing leaves the host.
const pageUrl = 'https://shop.example/cart';
const english = { task: 'Remove the Wool socks from my cart. Keep everything else.', evidence: 'Remove the Wool socks from my cart.',
  target: 'Wool socks', kept: 'Hat', rows: ['Wool socks, size L, $12', 'Hat, size M, $20'] };
const turkish = { task: 'Sepetten mavi tişörtü kaldır, diğerlerine dokunma.', evidence: 'mavi tişörtü kaldır',
  target: 'Mavi Tişört', kept: 'Mavi Kot Pantolon', rows: ['Mavi Tişört, beden L, 129 TL', 'Mavi Kot Pantolon, beden M, 349 TL'] };
const unnamed = { ...english, task: 'Remove the first item from my cart. Keep everything else.', evidence: 'Remove the first item' };
for (const [name, confirmation, language, cardAnswer] of [['direct', false, english], ['confirmation', true, english],
  ['turkish', false, turkish], ['card-delete', true, unnamed, 'once'], ['card-dont-delete', false, unnamed, 'deny']]) {
  if (process.env.WEBBRAIN_QUALITY_CASE_FILTER && !new RegExp(process.env.WEBBRAIN_QUALITY_CASE_FILTER).test(name)) continue;
  await runVariant(name, confirmation, language, cardAnswer);
}

async function runVariant(variant, confirmation, { task, evidence, target, kept, rows }, cardAnswer = null) {
  const declined = cardAnswer === 'deny';
  const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
    requires_submission: true, messaging: null, deliverables: [`The ${target} row is removed from the cart.`],
    allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
    completion_requirements: { download: false }, read_scope: 'visible_page',
    summary: `Remove only the ${target} cart row.`, steps: [{ id: '1', action: `Remove the ${target} row and verify it is gone.` }],
    memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
  const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
    ? path.join(process.env.WEBBRAIN_QUALITY_ARTIFACTS, variant)
    : `ci/artifacts/quality-audit-2026-10-07/unbound-deletion-mv3/${variant}`);
  await fs.mkdir(out, { recursive: true });
  let actionCalls = 0, judgeCalls = 0, blockedRemote = 0;
  const completionRecovery = { reads: 0 };
  const deletes = [], providerRequests = [], authorizations = [], decisions = [], summaryReadings = [], continuationReadings = [];
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
    throw new Error(`Owned fixture did not observe ${name}`);
  };
  const steps = declined ? [['tree'], ['click', `Remove ${target}`], ['partial']]
    : confirmation
    ? [['tree'], ['click', `Remove ${target}`], ['tree'], ['click', 'Confirm removal'], ['tree'], ['done']]
    : [['tree'], ['click', `Remove ${target}`], ['tree'], ['done']];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw); providerRequests.push(input);
    const system = textOf(input.messages?.[0]?.content);
    let completion;
    if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
      judgeCalls++;
      completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded',
        reason: `The ${target} row is no longer in the fresh cart observation and the ${kept} row remains.` }) };
    } else if (fixturePageTextReply(input.messages)) {
    // A status the page showed, read the way a model would read it.
    completion = { role: 'assistant', content: fixturePageTextReply(input.messages) };
  } else if (system.startsWith("Answer one fixed-choice question for a browser agent's safety check.")) {
      // The model's reading of the request, in whatever language it is in:
      // the row the request names, or unclear when it names none.
      const request = JSON.parse(textOf(input.messages[1].content)).request;
      const untrusted = textOf(input.messages.at(-1).content);
      const { page } = JSON.parse(untrusted.slice(untrusted.indexOf('{'), untrusted.lastIndexOf('}') + 1));
      const choices = [...system.matchAll(/^- "([a-z_]+)":/gm)].map(match => match[1]);
      // A failed or partial Act result is read once before it is shown; it
      // gives the outcome here.
      // A partial end is checked once for remaining work; a refused deletion
      // must reach that judge as the user's structured refusal.
      const continuation = choices.includes('continue_now');
      if (choices.includes('mode_claim')) summaryReadings.push({ request, summary: page.summary });
      else if (continuation) continuationReadings.push({ request, declined: (page.recorded_current_results || []).filter(entry => entry.userDeclined === true).length });
      else decisions.push({ choices, request, page });
      const answer = choices.includes('mode_claim') ? { choice: 'result', evidence: '' }
        : continuation ? { choice: 'stop_required', evidence: '' }
        : !choices.includes('delete_this') ? { choice: '', evidence: '' }
        : cardAnswer ? { choice: 'unclear', evidence: '' }
        : page.item === rows[0] ? { choice: 'delete_this', evidence } : { choice: 'other_item', evidence: '' };
      completion = { role: 'assistant', content: JSON.stringify(answer) };
    } else if (system.startsWith('Check one separately proposed consequential action')) {
      const untrusted = textOf(input.messages.at(-1).content);
      const proposed = JSON.parse(untrusted.slice(untrusted.indexOf('{'), untrusted.lastIndexOf('}') + 1));
      const authority = JSON.parse(textOf(input.messages[1].content));
      authorizations.push({ resource: proposed.resource, latest: authority.latestAcceptedRequest });
      completion = { role: 'assistant', content: JSON.stringify({ key: proposed.key,
        authorized: proposed.action === 'delete' && proposed.resource?.kind === 'record'
          && proposed.resource.text.startsWith(target) && authority.latestAcceptedRequest === task,
        latestRequestEvidence: evidence }) };
    } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      const step = actionCalls++;
      const [kind, name] = steps[Math.min(step, steps.length - 1)];
      const call = kind === 'click' ? { name: 'click_ax', args: { ref_id: refFor(input, name) } }
        : kind === 'done' ? { name: 'done', args: { outcome: 'success', summary: `Removed the ${target} from the cart once; the ${kept} remains.` } }
        : kind === 'partial' ? { name: 'done', args: { outcome: 'partial', summary: `The user chose not to remove the ${target}; nothing was removed.` } }
        : { name: 'get_accessibility_tree', args: { filter: 'all' } };
      const emitted = conformFixtureCompletionCall(input, call, completionRecovery);
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-unbound-${step}`, type: 'function',
        function: { name: emitted.name, arguments: JSON.stringify(emitted.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pageBody = `<!doctype html><meta charset="utf-8"><title>Owned cart fixture</title>
  <style>body{font:18px sans-serif;margin:25px}li{margin:12px}button{padding:8px}[role=dialog]{position:fixed;inset:120px 250px;background:white;border:2px solid black;padding:30px}</style>
  <main><h1>Your cart</h1><ul id="cart"><li data-id="1">${rows[0]} <button type="button" aria-label="Remove ${target}">Remove</button></li>
  <li data-id="2">${rows[1]} <button type="button" aria-label="Remove ${kept}">Remove</button></li></ul></main><div id="modal"></div>
  <script>
  const remove = async row => { const r = await fetch('/api/cart/items/' + row.dataset.id, { method: 'DELETE' }); if (r.ok) row.remove(); };
  for (const button of document.querySelectorAll('#cart button')) button.onclick = () => {
    const row = button.closest('li');
    if (!${confirmation}) return remove(row);
    document.querySelector('#modal').innerHTML = '<div role="dialog" aria-modal="true" aria-label="Remove item"><p>Remove this item from your cart?</p><button type="button" id="cancel">Cancel</button><button type="button" id="confirm" aria-label="Confirm removal">Remove</button></div>';
    document.querySelector('#cancel').onclick = () => document.querySelector('#modal').replaceChildren();
    document.querySelector('#confirm').onclick = async () => { await remove(row); document.querySelector('#modal').replaceChildren(); };
  };
  </script>`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-unbound-delete-mv3-'));
  let context;
  try {
    const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
    await fs.appendFile(path.join(extension, 'src/background.js'), `
  globalThis.unboundFixtureAgent = agent;
  globalThis.unboundFixtureReceipts = [];
  const recordOwnedUnboundReceipt = agent._recordCompletionSubmitAttempt;
  agent._recordCompletionSubmitAttempt = function (...args) {
    const receipt = recordOwnedUnboundReceipt.apply(this, args);
    if (receipt) unboundFixtureReceipts.push({ mutationKind: receipt.mutationKind, stage: receipt.actionRecord?.stage || null,
      footprint: receipt.actionRecord?.footprint || null, text: receipt.actionRecord?.text ?? null, resourceUrl: receipt.actionResource?.url || null });
    return receipt;
  };
  `);
    context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    await context.route('**/*', async route => {
      const request = route.request(), requested = new URL(request.url());
      if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
      if (requested.origin === 'https://shop.example') {
        if (/^\/api\/cart\/items\/\d+$/.test(requested.pathname) && request.method() === 'DELETE') {
          deletes.push({ method: request.method(), path: requested.pathname });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        if (request.isNavigationRequest() && requested.href === pageUrl) return route.fulfill({ contentType: 'text/html', body: pageBody });
        return route.fulfill({ status: 404, body: '' });
      }
      if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
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
    // WebBrain's deletion card is answered with the variant's fixed choice;
    // any other question would be unexpected here.
    const cards = [], unexpected = [];
    let answering = true;
    const answerer = (async () => {
      const answered = new Set();
      while (answering) {
        const pending = await worker.evaluate(tabId => [...(unboundFixtureAgent._pendingClarifications.get(tabId)?.keys() || [])], tabId);
        for (const clarifyId of pending) {
          if (answered.has(clarifyId)) continue;
          answered.add(clarifyId);
          if (!clarifyId.startsWith('deletion_') || !cardAnswer) { unexpected.push(clarifyId); continue; }
          cards.push(clarifyId);
          assert.equal((await message('clarify_response', { tabId, clarifyId, answer: cardAnswer, source: 'option' })).ok, true);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const result = await message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-unbound-deletion', locale: 'en' });
    answering = false; await answerer;
    const prompts = result.updates.filter(event => event.type === 'clarify').map(event => ({ kind: event.data?.promptKind,
      question: event.data?.question, mutationConfirmation: event.data?.mutationConfirmation || null }));
    const diagnostic = await worker.evaluate(tabId => ({ submit: unboundFixtureAgent._completionSubmitStates.get(tabId),
      dispatches: unboundFixtureAgent._planExecutionGuards.get(tabId)?.resourceMutationDispatches || [],
      receipts: unboundFixtureReceipts }), tabId);
    const toolResults = result.updates.filter(event => event.type === 'tool_result').map(event => ({ name: event.data?.name,
      blocked: event.data?.result?.blocked === true, reason: event.data?.result?.actionGuard?.reason || null, error: event.data?.result?.error || null }));
    await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, diagnostic, deletes, judgeCalls, authorizations,
      decisions, summaryReadings, continuationReadings, toolResults, prompts, cards, unexpected, blockedRemote }, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
    assert.deepEqual(unexpected, [], 'No other question was asked');
    assert.equal(authorizations.length, 0, 'A deletion is decided by the deletion question, not the publication check');
    // The request reaches the model as written, with the row and the row beside it.
    assert.ok(decisions.length > 0 && decisions.every(item => item.choices.includes('delete_this') && item.request === task),
      JSON.stringify(decisions));
    assert.equal(decisions[0].page.item, rows[0]);
    assert.equal(decisions[0].page.stage, 'record');
    assert.ok(String(decisions[0].page.siblings?.[0] || '').startsWith(rows[1]), JSON.stringify(decisions[0].page));
    assert.equal(cards.length, cardAnswer ? 1 : 0, `WebBrain asks once, only when the request does not say which row: ${JSON.stringify(prompts)}`);
    if (cardAnswer) {
      assert.deepEqual(prompts.find(item => item.kind === 'mutationConfirmation')?.mutationConfirmation,
        { kind: 'delete', reason: 'not_named', host: 'shop.example', item: rows[0], url: '', dialog: '' });
      assert.equal(decisions.length, 1, 'The user decided on the card; the model was not asked again');
    }
    if (declined) {
      assert.deepEqual(deletes, [], `Don't delete removes nothing: ${JSON.stringify(toolResults)}`);
      assert.equal(toolResults.find(item => item.name === 'click_ax')?.reason, 'deletion_declined', JSON.stringify(toolResults));
      assert.deepEqual(diagnostic.receipts, []);
      assert.equal(await page.locator('#cart li').count(), 2);
      const partial = result.updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
      assert.notEqual(partial?.outcome, 'success', JSON.stringify(partial));
      assert.deepEqual(summaryReadings, [{ request: task, summary: `The user chose not to remove the ${target}; nothing was removed.` }],
        'The partial result was read once, as written');
      assert.ok(continuationReadings.length <= 1 && continuationReadings.every(reading => reading.request === task && reading.declined === 1),
        `A remaining-work check sees the refusal as the user's structured decision: ${JSON.stringify(continuationReadings)}`);
      console.log(JSON.stringify({ passed: true, installedMV3: true, variant, cards: cards.length, deletes: deletes.length,
        continuationReadings: continuationReadings.length, blockedRemote }));
      return;
    }
    assert.deepEqual(deletes, [{ method: 'DELETE', path: '/api/cart/items/1' }], `Only the named row is removed, once: ${JSON.stringify(toolResults)}`);
    assert.deepEqual(diagnostic.receipts.map(receipt => receipt.stage), confirmation ? ['record', 'confirmation'] : ['record']);
    // Receipts keep the record's identity, never its row text.
    assert.ok(diagnostic.receipts.every(receipt => receipt.mutationKind === 'delete' && receipt.resourceUrl === null
      && /^[0-9a-f]{64}$/.test(receipt.footprint) && receipt.text === null));
    assert.equal(new Set(diagnostic.receipts.map(receipt => receipt.footprint)).size, 1, 'The confirmation belongs to the same record');
    assert.deepEqual(summaryReadings, [], 'A judged completion is not read again');
    if (!cardAnswer) {
      assert.equal(decisions.length, confirmation ? 2 : 1);
      if (confirmation) {
        assert.equal(decisions[1].page.stage, 'confirmation');
        assert.match(decisions[1].page.dialog, /Remove this item from your cart\?/, 'The model sees what the site\'s dialog asks');
      }
    }
    assert.equal(await page.locator('#cart li').count(), 1);
    assert.ok((await page.locator('#cart').innerText()).includes(kept));
    const done = result.updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
    assert.equal(done?.done, true, JSON.stringify(done));
    assert.equal(done?.outcome, 'success', JSON.stringify(done));
    assert.ok(judgeCalls > 0);
    console.log(JSON.stringify({ passed: true, installedMV3: true, variant, confirmation, cards: cards.length, deletes: deletes.length,
      receipts: diagnostic.receipts.length, decisions: decisions.length, judgeCalls, blockedRemote }));
  } finally {
    await context?.close(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-unbound-delete-mv3-')) throw new Error('Unexpected temporary profile path.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
