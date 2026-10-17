import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// The X/Bluesky publication contract and draft audit start in the background
// after the draft is written, so the click on Post does not wait for them.
// These tests drive the real Agent with a fake checker model that records
// every call with its start and end, and can hold a call open until released.

const ref = (text, source = 'request') => ({ source, start: text, end: text });
const count = (type = 'any', min = 0, max = 0, format = null) => ({ kind: 'count', type, format, min, max });
const rawAction = (id, platform, text = 'Hello', kind = 'exact') => ({ id, platform, account: null,
  posts: [{ body: { kind, source: ref(text) }, media: count(), context: { kind: 'post', target: null } }] });
const rawContract = (actions = [rawAction('p1', 'twitter')], requirements = 'p1') => ({
  version: 1, status: 'ready', actions, requirements, prohibited: [], reason: 'User requested publication.',
});
const snapshot = (bodyText = 'Hello', account = 'twitter:alice') => ({ complete: true, account,
  posts: [{ complete: true, bodyText, attachments: [], context: { kind: 'post', target: null } }] });
const deferred = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const settle = async (turns = 20) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };
const until = async (predicate, message) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
};

for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { projectTraceEventData } = await import(`../src/${browser}/src/trace/privacy.js`);
  const { resolveAdapterWorkflowJob } = await import(`../src/${browser}/src/agent/adapters.js`);

  function setup({ request = 'Post Hello on X', contract = rawContract(), authorize = () => true } = {}) {
    const provider = { model: 'fake-checker', chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    const tabId = 811;
    const f = { agent, tabId, provider, contract, authorize, calls: [], probes: [], readings: [], holds: {},
      pageUrl: 'https://x.com/compose/post' };
    agent.useSiteAdapters = true;
    agent._persist = () => {};
    agent._currentUrl = async () => f.pageUrl;
    agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
    f.guard = agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
    agent._chatWithCostAllowance = async (usedProvider, messages, _options, _cost, meta) => {
      assert.equal(usedProvider, provider);
      const call = { name: meta.generationName, startedAt: Date.now(), endedAt: null, done: false };
      f.calls.push(call);
      const hold = f.holds[meta.generationName];
      if (hold) {
        delete f.holds[meta.generationName];
        hold.started = true;
        await hold.promise;
      }
      call.endedAt = Date.now();
      call.done = true;
      const input = JSON.parse(messages[1].content);
      if (meta.generationName === 'social_publication_authorization') {
        call.key = input.key;
        const authorized = f.authorize(input);
        return { content: JSON.stringify({ key: input.key, actionId: input.action.id, authorized,
          reason: authorized ? 'The draft matches the request.' : 'The draft does not match the request.' }) };
      }
      return { content: JSON.stringify(f.contract) };
    };
    f.detected = { isSubmit: true, publicationControl: true, publicationResourceUrls: [], publicationResourceUrlsComplete: true,
      frameDocumentIdentity: 'https://x.com/compose/post|fixture-document-1',
      publicationAccountIdentity: 'twitter:alice', publicationAccountIdentityComplete: true, publicationSnapshot: snapshot() };
    // The same probe answers the prefetch (its publish-control hint) and the click.
    agent._detectLikelySubmitAction = async (_tabId, name, args, options = {}) => {
      f.probes.push({ name, args: structuredClone(args), captionPass: options.captionPass || 'collect' });
      return structuredClone(f.detected);
    };
    agent._readPageTexts = async (_tabId, kind, texts) => { f.readings.push({ kind, texts: [...texts] }); };
    f.hold = name => { const gate = deferred(); f.holds[name] = gate; return gate; };
    f.named = name => f.calls.filter(call => call.name === name);
    f.write = (args = { ref_id: 'ref_7', text: 'Hello', clear: true }) => agent._socialPublicationPrefetch(
      tabId, 'type_ax', args, { success: true, verified: true }, provider);
    f.click = () => agent._workflowPreSubmitDispatchBlock(tabId, 'click_ax', { ref_id: 'ref_9' }, f.detected, provider);
    f.pending = () => agent._socialPublicationContractPrefetches?.get(f.guard) || null;
    f.applySteering = text => {
      agent._runningTabs.add(tabId);
      agent._beginSteeringRun(tabId, () => {}, { detachedRequestId: 'prefetch-steering' });
      assert.equal(agent.steerMessage(tabId, text, { requestId: 'prefetch-steering', messageId: 'revision' }).accepted, true);
      assert.equal(agent._applyPendingSteering(tabId, agent.conversations.get(tabId), () => {}), true);
      agent._finishSteeringRun(tabId);
      agent._runningTabs.delete(tabId);
    };
    return f;
  }

  test(`${browser}: the contract is compiled after the write, before the click, which then runs no checker`, async () => {
    const f = setup();
    const status = await f.write();
    assert.equal(status, 'authorized');
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
    // The compiled contract waits beside the run; the run itself is unchanged.
    const compiled = f.pending().compiled;
    assert.equal(compiled.contract.status, 'ready');
    assert.equal(f.guard.socialPublication, null);
    // The probe asked for the composer's own publish control, beside the
    // editor that was written, and went straight to the final pass.
    assert.deepEqual(f.probes[0], { name: 'click_ax', args: { __wbPublicationPrefetch: { editorRef: 'ref_7' } }, captionPass: 'final' });
    const clickAt = Date.now();
    assert(f.calls.every(call => call.done && call.endedAt <= clickAt));
    assert.equal(await f.click(), null);
    assert.equal(f.calls.length, 2, 'the click compiled nothing and audited nothing');
    assert.equal(f.guard.socialPublication, compiled, 'the click installed the contract it would have compiled');
    assert.equal(f.pending(), null);
    assert.equal(f.guard.socialPublication.dispatch.key, f.named('social_publication_authorization')[0].key);
    assert.equal(f.guard.socialPublication.prefetchedAudit, undefined, 'a verdict decides one click only');
  });

  test(`${browser}: the prefetched contract stays out of the run until the click installs it`, async () => {
    const f = setup();
    assert.equal(await f.write(), 'authorized');
    // Ordinary tool calls before the click neither bind the publish workflow
    // nor see a publication target, exactly as when nothing was prefetched.
    assert.equal(await f.agent._adoptLiveSocialPublishWorkflow(f.tabId, f.provider), false);
    assert.equal(f.guard.siteWorkflow, null);
    assert.equal(f.guard.socialPublication, null);
    assert.deepEqual(f.agent._missingSocialPublishTargets(f.guard), []);
    assert.equal(await f.click(), null);
    assert.equal(f.guard.siteWorkflow.adapterName, 'twitter');
    assert.equal(f.guard.siteWorkflow.job.id, 'publish-post');
    assert.equal(f.calls.length, 2);
  });

  test(`${browser}: the compile starts when a composer write begins, and the draft audit joins it`, async () => {
    const f = setup();
    const contract = f.hold('social_publication_contract');
    // The write is still being prepared: only the contract can start.
    const early = f.agent._socialPublicationContractPrefetch(f.tabId, 'type_ax', { ref_id: 'ref_7', text: 'Hello' }, f.provider);
    await until(() => contract.started, 'the compile started before the write finished');
    assert.equal(f.named('social_publication_authorization').length, 0);
    assert.equal(f.agent._socialPublicationContractPrefetch(f.tabId, 'type_ax', { ref_id: 'ref_7', text: 'Hello' }, f.provider), null,
      'a compile in flight is not started twice');
    // The write finished: the draft audit waits for the same compile.
    const afterWrite = f.write();
    await settle();
    assert.equal(f.named('social_publication_authorization').length, 0, 'the audit needs the contract first');
    contract.release();
    assert.equal(await early, 'contract_ready');
    assert.equal(await afterWrite, 'authorized');
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
    assert.equal(await f.click(), null);
    assert.equal(f.calls.length, 2);
  });

  test(`${browser}: a click during the background compile waits for it instead of compiling again`, async () => {
    const f = setup();
    const contract = f.hold('social_publication_contract');
    const prefetch = f.write();
    await until(() => contract.started, 'the background compile started');
    let clicked = false;
    const click = f.click().then(result => { clicked = true; return result; });
    await settle();
    assert.equal(clicked, false, 'the click waits for the compile in flight');
    assert.equal(f.guard.socialPublication, null, 'nothing is installed while the background compile runs');
    contract.release();
    assert.equal(await click, null);
    assert.equal(await prefetch, 'authorized');
    assert.equal(f.named('social_publication_contract').length, 1, 'one compile for prefetch and click');
    assert.equal(f.named('social_publication_authorization').length, 1, 'the click awaited the prefetched audit');
    assert.equal(f.guard.socialPublication.dispatch.key, f.named('social_publication_authorization')[0].key);
  });

  test(`${browser}: a click during the background audit of the same draft awaits it`, async () => {
    const f = setup();
    const audit = f.hold('social_publication_authorization');
    const prefetch = f.write();
    await until(() => audit.started, 'the background audit started');
    let clicked = false;
    const click = f.click().then(result => { clicked = true; return result; });
    await settle();
    assert.equal(clicked, false, 'the click waits for the audit in flight');
    audit.release();
    assert.equal(await click, null);
    await prefetch;
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
  });

  test(`${browser}: a changed draft, account, page or document after the prefetch is audited again at the click`, async () => {
    for (const change of ['draft', 'account', 'page', 'document']) {
      // A composed body lets the changed draft pass the click's preflight, so
      // only the binding key tells it apart from the audited one.
      const f = setup({ request: 'Tweet about my blog post',
        contract: rawContract([rawAction('p1', 'twitter', 'about my blog post', 'compose')]) });
      assert.equal(await f.write(), 'authorized', change);
      const prefetchedKey = f.named('social_publication_authorization')[0].key;
      if (change === 'draft') f.detected.publicationSnapshot.posts[0].bodyText = 'A different post about the blog';
      if (change === 'account') f.detected.publicationSnapshot.account = 'twitter:bob';
      if (change === 'page') f.pageUrl = 'https://x.com/home';
      if (change === 'document') f.detected.frameDocumentIdentity = 'https://x.com/compose/post|fixture-document-2';
      assert.equal(await f.click(), null, change);
      const audits = f.named('social_publication_authorization');
      assert.equal(audits.length, 2, `${change}: the click ran its own audit`);
      assert.notEqual(audits[1].key, prefetchedKey, change);
      assert.equal(f.guard.socialPublication.dispatch.key, audits[1].key, change);
      assert.equal(f.named('social_publication_contract').length, 1, change);
    }
  });

  test(`${browser}: a denied prefetched verdict blocks exactly like a denial at the click`, async () => {
    const deny = () => false;
    const prefetched = setup({ authorize: deny });
    assert.equal(await prefetched.write(), 'denied');
    const denied = await prefetched.click();
    assert.equal(prefetched.named('social_publication_authorization').length, 1, 'the stored verdict decided');
    const live = setup({ authorize: deny });
    const expected = await live.click();
    assert.deepEqual(denied, expected);
    assert.equal(denied.noDispatch, true);
    assert.equal(denied.failureRecovery.code, 'publication_audit_denied');
    assert.equal(denied.failureRecovery.retryMode, 'publication_audit_bypass');
    for (const key of ['deniedAuditKey', 'deniedAudit', 'dispatch']) {
      assert.deepEqual(prefetched.guard.socialPublication[key], live.guard.socialPublication[key], key);
    }
    // The cached denial holds for another attempt, and the user's Retry
    // grant applies to it exactly as to a live denial.
    assert.deepEqual(await prefetched.click(), denied);
    assert.equal(prefetched.calls.length, 2);
    assert.equal(prefetched.agent._grantSocialPublicationAuditRetry(prefetched.tabId, denied.failureRecovery), true);
    assert.equal(await prefetched.click(), null);
    assert.equal(prefetched.guard.socialPublication.dispatch.auditBypassed, true);
    assert.equal(prefetched.calls.length, 2);
  });

  test(`${browser}: steering or Stop during the background audit leaves no usable verdict`, async () => {
    for (const interruption of ['steering', 'stop']) {
      const f = setup();
      const audit = f.hold('social_publication_authorization');
      const prefetch = f.write();
      await until(() => audit.started, 'the background audit started');
      const audited = f.pending().compiled;
      if (interruption === 'steering') f.applySteering('Actually post Goodbye instead');
      else f.agent.abort(f.tabId);
      audit.release();
      assert.equal(await prefetch, 'changed', interruption);
      assert.equal(audited.prefetchedAudit, undefined, interruption);
      if (interruption === 'steering') {
        assert.equal(f.pending(), null, 'the correction dropped the background contract');
        assert.equal(f.guard.socialPublication, null);
        // The corrected task is compiled and audited again at the click.
        f.contract = rawContract([rawAction('p2', 'twitter', 'Goodbye', 'exact')], 'p2');
        f.contract.actions[0].posts[0].body.source = ref('Goodbye', 'steering_message0');
        f.detected.publicationSnapshot.posts[0].bodyText = 'Goodbye';
        assert.equal(await f.click(), null);
        assert.equal(f.named('social_publication_contract').length, 2);
        assert.equal(f.named('social_publication_authorization').length, 2);
      }
    }
  });

  test(`${browser}: steering or Stop during the background compile leaves no contract behind`, async () => {
    for (const interruption of ['steering', 'stop']) {
      const f = setup();
      const contract = f.hold('social_publication_contract');
      const prefetch = f.write();
      await until(() => contract.started, 'the background compile started');
      if (interruption === 'steering') f.applySteering('Actually post Goodbye instead');
      else f.agent.abort(f.tabId);
      contract.release();
      assert.equal(await prefetch, 'skipped', interruption);
      assert.equal(f.guard.socialPublication, null, `${interruption}: the guard is left as the prefetch found it`);
      assert.equal(f.pending(), null, interruption);
      assert.equal(f.named('social_publication_authorization').length, 0, interruption);
    }
  });

  test(`${browser}: a failed background compile leaves the click its own two attempts`, async () => {
    const f = setup();
    let failures = 2;
    const chat = f.agent._chatWithCostAllowance;
    f.agent._chatWithCostAllowance = async (...args) => {
      if (args[4].generationName === 'social_publication_contract' && failures-- > 0) {
        f.calls.push({ name: 'social_publication_contract', failed: true });
        throw new Error('HTTP 503: temporarily unavailable');
      }
      return chat(...args);
    };
    assert.equal(await f.write(), 'skipped');
    assert.equal(f.guard.socialPublication, null);
    assert.equal(f.pending(), null);
    assert.equal(await f.click(), null);
    assert.equal(f.named('social_publication_contract').length, 3);
  });

  test(`${browser}: a contract whose sources changed after the prefetch is compiled again at the click`, async () => {
    const f = setup();
    assert.equal(await f.write(), 'authorized');
    const prefetchedState = f.pending().compiled;
    // A plain assistant message later in the run is a draft source the click
    // would have compiled from.
    f.agent.conversations.get(f.tabId).push({ role: 'assistant', content: 'Draft: Hello' });
    assert.equal(await f.click(), null);
    assert.notEqual(f.guard.socialPublication, prefetchedState);
    assert.equal(f.guard.socialPublication.sources.draft0, 'Draft: Hello');
    assert.equal(f.named('social_publication_contract').length, 2);
    assert.equal(f.named('social_publication_authorization').length, 2, 'the new contract is audited again');
  });

  test(`${browser}: drafts, ordinary pages and failed writes start no prefetch`, async () => {
    const cases = [
      ['no submission planned', f => { f.guard.requiresSubmission = false; }],
      ['not a social composer page', f => { f.pageUrl = 'https://example.com/editor'; }],
      ['no publish control beside the editor', f => { f.detected = { isSubmit: false, resolvedEditableTarget: true }; }],
      ['failed write', f => { f.result = { success: false, noDispatch: true }; f.atStart = false; }],
      ['a submitting field write', f => { f.name = 'set_field'; f.args = { ref_id: 'ref_7', text: 'Hello', submit: true }; }],
      // The planner bound the run to another job on the site: not a post.
      ['a run bound to another site job', f => { f.guard.siteWorkflow = { adapterName: 'twitter', job: { id: 'send-message' } }; }],
    ];
    for (const [label, prepare] of cases) {
      const f = setup();
      f.name = 'type_ax'; f.args = { ref_id: 'ref_7', text: 'Hello' }; f.result = { success: true };
      prepare(f);
      // The contract compile can start with the write; the audit needs its result.
      if (f.atStart !== false) await f.agent._socialPublicationContractPrefetch(f.tabId, f.name, f.args, f.provider);
      await f.agent._socialPublicationPrefetch(f.tabId, f.name, f.args, f.result, f.provider);
      assert.equal(f.calls.length, 0, label);
      assert.equal(f.guard.socialPublication, null, label);
      assert.equal(f.pending(), null, label);
    }
  });

  test(`${browser}: a run bound to the publish job audits the draft against the contract compiled at its start`, async () => {
    const f = setup();
    f.guard.siteWorkflow = resolveAdapterWorkflowJob('https://x.com/compose/post', 'publish-post');
    f.guard.siteWorkflowUrl = 'https://x.com/compose/post';
    const installed = await f.agent._ensureSocialPublicationContract(f.tabId, f.provider);
    assert.equal(installed.contract.status, 'ready');
    assert.equal(await f.write(), 'authorized');
    assert.equal(f.pending(), null, 'nothing to compile in the background');
    assert.equal(await f.click(), null);
    assert.equal(f.guard.socialPublication, installed);
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
    // A clarification asks for a new contract: it is compiled in the
    // background from the clarified sources and installed by the next click.
    f.agent._recordSocialPublicationClarification(f.tabId, f.guard, 'Which account?', 'alice', 'user');
    assert.equal(installed.needsRecompile, true);
    f.detected.frameDocumentIdentity = 'https://x.com/compose/post|fixture-document-2';
    assert.equal(await f.write(), 'authorized');
    assert.equal(f.guard.socialPublication, installed, 'the run keeps its state until a caller installs the new one');
    const recompiled = f.pending().compiled;
    assert.equal(recompiled.sources.clarification_answer0, 'alice');
    assert.equal(await f.click(), null);
    assert.equal(f.guard.socialPublication, recompiled);
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization',
      'social_publication_contract', 'social_publication_authorization']);
  });

  test(`${browser}: the prefetch reads the composer's captions the click and recipient guard would read`, async () => {
    const f = setup();
    f.detected.publicationPrefetchCaptions = ['Post', 'Close', 'Choose audience'];
    assert.equal(await f.agent._socialPublicationPrefetch(f.tabId, 'type_text',
      { selector: '[data-testid="tweetTextarea_0"]', text: 'Hello', clear: true }, { success: true }, f.provider), 'authorized');
    assert.deepEqual(f.probes[0].args, { __wbPublicationPrefetch: { editorSelector: '[data-testid="tweetTextarea_0"]' } });
    // x.com/compose/post is a page whose sends the recipient guard checks.
    assert.deepEqual(f.readings.map(reading => reading.kind).sort(), ['control_effect', 'message_control']);
    for (const reading of f.readings) assert.deepEqual(reading.texts, ['Post', 'Close', 'Choose audience']);
  });

  test(`${browser}: an upload into the composer last written audits the draft again`, async () => {
    const f = setup({ request: 'Tweet about my blog post',
      contract: rawContract([rawAction('p1', 'twitter', 'about my blog post', 'compose')]) });
    assert.equal(await f.write(), 'authorized');
    f.detected.frameDocumentIdentity = 'https://x.com/compose/post|fixture-document-after-upload';
    assert.equal(await f.agent._socialPublicationPrefetch(f.tabId, 'upload_file', { selector: 'input[type=file]' },
      { success: true, attachmentState: 'page_consumed' }, f.provider), 'authorized');
    assert.deepEqual(f.probes.at(-1).args, { __wbPublicationPrefetch: { editorRef: 'ref_7' } });
    assert.equal(await f.click(), null);
    assert.equal(f.named('social_publication_authorization').length, 2);
  });

  test(`${browser}: a consequential click records predispatch_timing with stage durations only`, async () => {
    const f = setup();
    const { agent, tabId, provider } = f;
    assert.equal(await f.write(), 'authorized');
    agent.currentRunId.set(tabId, 'prefetch-run');
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    agent._recordProgressObservation = async () => null;
    agent._autoRecordProgressAction = () => null;
    agent._progressWarningForAction = () => '';
    agent._captureFormValidationState = async () => [];
    agent._waitForFormValidationFailure = async () => null;
    agent._readCompletionResult = async () => null;
    agent._messageRecipientGuardBlock = async () => null;
    agent._captchaMutationPreflight = async () => null;
    const dispatched = [];
    agent.executeTool = async (_tabId, name) => { dispatched.push(name); return { success: true, dispatched: true }; };
    const notes = [];
    agent._recordPredispatchTiming = (_tabId, step, timing) => notes.push({ step, timing });
    const messages = [];
    await agent._executeToolBatch(tabId, [{ id: 'post', function: { name: 'click_ax', arguments: JSON.stringify({ ref_id: 'ref_9' }) } }],
      messages, () => {}, provider, '', new Set(['click_ax']), 4);
    assert.deepEqual(dispatched, ['click_ax']);
    assert.equal(f.calls.length, 2, 'the click reused the prefetched contract and verdict');
    assert.equal(notes.length, 1);
    const [{ step, timing }] = notes;
    assert.equal(step, 4);
    assert.equal(timing.tool, 'click_ax');
    assert.equal(timing.outcome, 'dispatched');
    for (const stage of ['captchaGateMs', 'submitPreflightMs', 'submitProbeMs', 'workflowPreSubmitMs', 'workflowDispatchMs',
      'publicationContractMs', 'publicationAuditReusedMs', 'publicationRereadMs', 'recipientGuardMs', 'checkpointMs',
      'pipelinePublicationMs', 'attemptCheckpointMs', 'preDispatchMs', 'executeToolMs', 'totalMs']) {
      assert.equal(typeof timing[stage], 'number', stage);
      assert(timing[stage] >= 0, stage);
    }
    assert.equal(timing.publicationAuditMs, undefined, 'no audit ran at the click');
    const projected = projectTraceEventData('note', { step, note: 'predispatch_timing',
      extra: { ...timing, tool: 'click_ax', outcome: 'dispatched', pageUrl: 'https://PRIVATE.invalid', draft: 'PRIVATE' } });
    assert.equal(projected.note, 'predispatch_timing');
    assert.equal(projected.extra.tool, 'click_ax');
    assert.equal(projected.extra.publicationAuditReusedMs, timing.publicationAuditReusedMs);
    assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
    assert(Object.values(projected.extra).every(value => typeof value === 'number' || ['click_ax', 'dispatched'].includes(value)));
  });
}

// The prefetch probe, in a real page: it must find the composer's own Post
// button from the editor just written, and report the same binding snapshot
// and document as the click on that button will, so their keys match.
test('the prefetch probe resolves the written composer\'s Post button and binds the same draft as the click', async () => {
  const { chromium } = await import('playwright');
  const fs = await import('node:fs');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    const page = await context.newPage();
    for (const build of ['chrome', 'firefox']) {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      await page.goto('https://x.com/compose/post');
      await page.setContent(`<nav><a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a></nav>
        <main><div id="inline"><div><div contenteditable="true" role="textbox" aria-label="Post text" data-testid="tweetTextarea_0">Inline draft</div></div>
          <div><button type="button" data-testid="tweetButtonInline">Post</button></div></div></main>
        <div role="dialog" aria-modal="true" id="dialog"><button type="button" aria-label="Close">x</button>
          <div><div><div><div contenteditable="true" role="textbox" aria-label="Post text" data-testid="tweetTextarea_0">Hello</div></div></div></div>
          <nav aria-label="Composer tools"><button type="button" aria-label="Add photos or video">Media</button></nav>
          <div><button type="button" data-testid="tweetButton">Post</button></div></div>`);
      await page.addScriptTag({ content: fs.readFileSync(`src/${build}/src/content/accessibility-tree.js`, 'utf8') });
      const refs = await page.evaluate(() => ({
        dialogEditor: window.__wb_ax_ref(document.querySelector('#dialog [role="textbox"]')),
        dialogPost: window.__wb_ax_ref(document.querySelector('#dialog [data-testid="tweetButton"]')),
        inlineEditor: window.__wb_ax_ref(document.querySelector('#inline [role="textbox"]')),
        inlinePost: window.__wb_ax_ref(document.querySelector('#inline [data-testid="tweetButtonInline"]')),
      }));
      const probe = args => page.evaluate(({ source, args }) => Function('return (' + source + ')')()('click_ax', args),
        { source: Agent._submitActionProbe.toString(), args: { __wbCaptionPass: 'final', ...args } });
      for (const [editor, post, body] of [[refs.dialogEditor, refs.dialogPost, 'Hello'], [refs.inlineEditor, refs.inlinePost, 'Inline draft']]) {
        const prefetch = await probe({ __wbPublicationPrefetch: { editorRef: editor } });
        const click = await probe({ ref_id: post });
        assert.equal(prefetch?.isSubmit, true, build);
        assert.equal(prefetch.publicationControl, true, build);
        assert.equal(click.publicationControl, true, build);
        assert.deepEqual(prefetch.publicationSnapshot, click.publicationSnapshot, build);
        assert.equal(prefetch.frameDocumentIdentity, click.frameDocumentIdentity, build);
        assert.deepEqual(prefetch.publicationSnapshot.posts.map(post => post.bodyText), [body], build);
        assert.equal(prefetch.publicationSnapshot.account, 'twitter:alice', build);
        assert(Array.isArray(prefetch.publicationPrefetchCaptions) && prefetch.publicationPrefetchCaptions.includes('Post'), build);
        assert.equal(click.publicationPrefetchCaptions, undefined, 'only the prefetch asks for captions');
      }
      // The dialog's other controls are among the captions the click reads.
      const dialogCaptions = (await probe({ __wbPublicationPrefetch: { editorRef: refs.dialogEditor } })).publicationPrefetchCaptions;
      for (const caption of ['Close', 'Add photos or video']) assert(dialogCaptions.includes(caption), `${build}: ${caption}`);
      // A selector naming both editors, or two publish controls beside the
      // editor, resolve to nothing rather than to a guess.
      assert.equal(await probe({ __wbPublicationPrefetch: { editorSelector: '[data-testid="tweetTextarea_0"]' } }), null, build);
      await page.evaluate(() => {
        const second = document.createElement('button');
        second.type = 'button'; second.dataset.testid = 'tweetButton'; second.textContent = 'Post all';
        document.querySelector('#dialog').append(second);
      });
      assert.equal(await probe({ __wbPublicationPrefetch: { editorRef: refs.dialogEditor } }), null, build);
      // Only X's own post editor prepares a post: a form's text area or an
      // unmarked editable beside a Post button does not.
      for (const field of ['<textarea id="field">Draft</textarea>', '<div id="field" contenteditable="true" role="textbox">Draft</div>']) {
        await page.setContent(`<nav><a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a></nav>
          <form>${field}<button type="button" data-testid="tweetButtonInline">Post</button></form>`);
        await page.addScriptTag({ content: fs.readFileSync(`src/${build}/src/content/accessibility-tree.js`, 'utf8') });
        const fieldRef = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('#field')));
        const postRef = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('button')));
        assert.equal((await probe({ ref_id: postRef })).publicationControl, true, `${build}: the click itself stays guarded`);
        assert.equal(await probe({ __wbPublicationPrefetch: { editorRef: fieldRef } }), null, `${build}: ${field}`);
      }
      // Bluesky's post editor is its ProseMirror editor.
      await page.goto('https://bsky.app/');
      await page.setContent(`<nav><a href="/profile/alice.bsky.social">Profile</a></nav>
        <div role="dialog" aria-modal="true"><div class="ProseMirror" contenteditable="true" role="textbox"><p>Hello</p></div>
          <button type="button" data-testid="composerPublishBtn">Post</button></div>`);
      await page.addScriptTag({ content: fs.readFileSync(`src/${build}/src/content/accessibility-tree.js`, 'utf8') });
      const bluesky = await page.evaluate(() => ({ editor: window.__wb_ax_ref(document.querySelector('.ProseMirror')),
        post: window.__wb_ax_ref(document.querySelector('[data-testid="composerPublishBtn"]')) }));
      const prefetch = await probe({ __wbPublicationPrefetch: { editorRef: bluesky.editor } });
      const click = await probe({ ref_id: bluesky.post });
      assert.equal(prefetch?.publicationControl, true, build);
      assert.deepEqual(prefetch.publicationSnapshot, click.publicationSnapshot, build);
      assert.equal(prefetch.publicationSnapshot.account, 'bluesky:alice.bsky.social', build);
      assert.deepEqual(prefetch.publicationSnapshot.posts.map(post => post.bodyText), ['Hello'], build);
      assert.equal(await probe({ __wbPublicationPrefetch: { editorSelector: '.ProseMirror' } }).then(result => result?.publicationControl), true, build);
    }
  } finally {
    await browser.close();
  }
});

test('Chrome and Firefox share the publication prefetch', async () => {
  const { Agent: Chrome } = await import('../src/chrome/src/agent/agent.js');
  const { Agent: Firefox } = await import('../src/firefox/src/agent/agent.js');
  for (const name of ['_socialPublicationPrefetch', '_socialPublicationContractPrefetch', '_socialPublicationPrefetchHint',
    '_socialPublicationPrefetchAllowed', '_socialPublicationStateCurrent', '_socialPublicationPrefetchRun', '_socialPublicationPrefetchAudit',
    '_socialPublicationPrefetchReadings', '_socialPublicationPrefetchedVerdict', '_socialPublicationAuditRun',
    '_socialPublicationCompile', '_ensureSocialPublicationContract', '_predispatchTimer', '_predispatchStage',
    '_recordPredispatchTiming']) {
    assert.equal(typeof Chrome.prototype[name], 'function', name);
    assert.equal(Chrome.prototype[name].toString(), Firefox.prototype[name].toString(), name);
  }
});
