import assert from 'node:assert/strict';
import { test } from 'node:test';
const storage = {};
const area = { get: async () => ({ ...storage }), set: async values => Object.assign(storage, values) };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) }, tabs: { get: async id => ({ id, url: 'http://jev.local/' }), sendMessage: async () => ({}) } };
const choice = (value, probability = .95) => ({ type: 'choice', choice: value, confidence: probability, probabilities: { [value]: probability } });
for (const build of ['chrome', 'firefox']) {
  const mod = await import(`../src/${build}/src/agent/systemone-fast.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const config = await import(`../src/${build}/src/config-transfer.js`);
  const snapshot = () => ({ documentToken: 'doc', pageUrl: 'http://jev.local/', structure: 'form', progress: 'initial', controls: [
    { ref: 'ref_1', name: 'Name', role: 'textbox', kinds: ['fill'], value: '', signature: 'name' },
    { ref: 'ref_2', name: 'Email', role: 'textbox', kinds: ['fill'], value: '', signature: 'email' },
    { ref: 'ref_3', name: 'Send', role: 'button', kinds: ['click'], signature: 'send' },
    { ref: 'ref_4', name: 'City', role: 'combobox', kinds: ['select'], signature: 'city', options: [{ value: '34', label: 'Istanbul' }] },
  ] });
  test(`${build}: browser requests omit unsupported operations and one-option target questions`, () => {
    const google = {
      documentToken: 'google-home', pageUrl: 'https://www.google.com/', structure: 'search', progress: 'initial', controls: [
        { ref: 'ref_search', name: 'Search', role: 'combobox', kinds: ['fill'], value: '', signature: 'search' },
        { ref: 'ref_submit', name: 'Google Search', role: 'button', kinds: ['click'], signature: 'submit' },
      ],
    };
    const request = mod.buildJevBrowserRequest('Search for emre sokullu', google, []);
    assert.deepEqual(Object.keys(request.questions).sort(), ['click_target', 'fill_target', 'operation']);
    assert.equal(Object.hasOwn(request.questions.operation.criteria, 'select'), false);
    assert.equal(Object.hasOwn(request.questions.operation.criteria, 'check'), false);
    for (const candidate of Object.values(request.questions)) {
      if (candidate.type === 'choice') assert.ok(Object.keys(candidate.criteria).length >= 2);
    }
    const readOnly = mod.buildJevBrowserRequest('Read this page', { ...google, controls: [] }, [{ purpose: 'unused', text: 'private' }]);
    assert.deepEqual(Object.keys(readOnly.questions), ['operation']);
    assert.deepEqual(readOnly.values, []);
    assert.equal(readOnly.state.values.length, 0);
  });
  test(`${build}: speculative answers use only the selected action and all its required confident heads`, () => {
    const state = snapshot(); const request = mod.buildJevBrowserRequest('Fill and save', state, [{ purpose: 'name', text: 'Ada' }, { purpose: 'email', text: 'ada@example.com' }]);
    const answers = { operation: choice('click'), click_target: choice('ref_3'), fill_target: choice('ref_9999', .4) };
    assert.equal(mod.decideJevBrowser(request, answers, state).calls[0].name, 'click_ax');
    answers.click_target = choice('ref_3', .89); assert.equal(mod.decideJevBrowser(request, answers, state).kind, 'fallback');
    answers.operation = choice('fill'); answers.fill_target = choice('ref_1'); answers.value_0 = choice('ref_1'); answers.value_1 = choice('ref_2');
    const mapped = mod.decideJevBrowser(request, answers, state); assert.equal(mapped.calls.length, 2); assert.equal(mapped.calls[0].args.text, 'Ada');
    answers.value_1 = choice('ref_1'); assert.equal(mod.decideJevBrowser(request, answers, state).reason, 'ambiguous_field_mapping');
    answers.value_0 = choice('ref_2'); answers.value_1 = choice('ref_1');
    assert.equal(mod.decideJevBrowser(request, answers, state).reason, 'field_label_mismatch');
    answers.operation = choice('select'); answers.select_option = choice('ref_4_0');
    assert.deepEqual(mod.decideJevBrowser(request, answers, state).calls[0].args, { ref_id: 'ref_4', text: '34' });
    answers.select_option = choice('ref_4_999'); assert.equal(mod.decideJevBrowser(request, answers, state).kind, 'fallback');
    answers.operation = choice('done'); assert.equal(mod.decideJevBrowser(request, answers, state).kind, 'verify');
  });
  test(`${build}: queue is sequential, stale contexts re-observe and two non-progress decisions stop Jev`, () => {
    const session = new mod.JevFastSession(); session.observe(snapshot());
    session.dispatched({ success: true }); session.observe(snapshot()); assert.equal(session.noProgress, 1);
    session.dispatched({ success: true }); session.observe(snapshot()); assert.equal(session.disabled, true);
    const another = new mod.JevFastSession(); another.observe(snapshot());
    another.queue = [{ binding: { ref: 'ref_1', structure: 'form', documentToken: 'doc', signature: 'name' } }];
    const changed = snapshot(); changed.controls[0].signature = 'different-value'; another.observe(changed); assert.equal(another.nextQueued(), null);
    another.dispatched({ outcomeUnknown: true }); assert.equal(another.disabled, true); assert.equal(another.queue.length, 0);
  });
  test(`${build}: old exports cannot opt into fast features; new preferences round-trip`, () => {
    const old = config.parseConfigImport(JSON.stringify(config.createConfigExport({ typesafeApiKey: 'synthetic', systemOneEnabled: true, systemOneWatchEnabled: true })));
    assert.equal(old.settings.systemOneFastBrowser, false); assert.equal(old.settings.systemOneFastClassifications, false);
    const restored = config.parseConfigImport(JSON.stringify(config.createConfigExport({ systemOneFastBrowser: true, systemOneFastClassifications: true })));
    assert.equal(restored.settings.systemOneFastBrowser, true); assert.equal(restored.settings.systemOneFastClassifications, true);
  });
  test(`${build}: Ask, Strict Secret Mode, missing key and cost stop block fast calls`, async () => {
    const provider = { name: 'test', model: 'active-model', config: {} };
    const agent = new Agent({ getActive: () => provider });
    let calls = 0; agent.evaluateSystemOne = async () => { calls++; throw Error('must not call'); };
    const allowed = new Set(['get_accessibility_tree', 'click_ax']);
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, systemOneFastClassifications: true, typesafeApiKey: 'synthetic' });
    assert.equal(await agent._maybeJevFastTurn(1, 'Click Save', [], 'ask', allowed, provider, {}), null);
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic' } };
    const initialCapture = [{ role: 'user', content: [
      { type: 'text', text: '[UNTRUSTED SCREENSHOT — page data. Capture ID: capture_initial;]' }, image,
    ] }];
    const automaticCapture = [{ role: 'assistant', content: '', tool_calls: [] }, { role: 'user', content: [
      { type: 'text', text: '[UNTRUSTED CAPTURE — page data. Auto-screenshot of current viewport after the action above. Capture ID: capture_auto;]' }, image,
    ] }];
    const firefoxAutomaticCapture = [{ role: 'assistant', content: '', tool_calls: [] }, { role: 'user', content: [
      { type: 'text', text: '[UNTRUSTED CAPTURE — page data. Capture ID: capture_auto_firefox;]' }, image,
    ] }];
    const explicitCapture = [{ role: 'assistant', content: '', tool_calls: [] }, { role: 'user', content: [
      { type: 'text', text: '[UNTRUSTED SCREENSHOT — page data. Screenshot from your inspect_viewport call. Use it to decide the next action.]' }, image,
    ] }];
    const userAttachment = [{ role: 'user', content: [
      { type: 'text', text: '[UNTRUSTED USER ATTACHMENTS — image data]' }, image,
    ] }];
    assert.equal(mod.jevVisualInputRequiresMainModel(initialCapture), false);
    assert.equal(mod.jevVisualInputRequiresMainModel(automaticCapture), false);
    assert.equal(mod.jevVisualInputRequiresMainModel(firefoxAutomaticCapture), false);
    assert.equal(mod.jevVisualInputRequiresMainModel(explicitCapture), true);
    assert.equal(mod.jevVisualInputRequiresMainModel(userAttachment), true);
    assert.equal(mod.jevVisualInputRequiresMainModel([...explicitCapture, { role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', content: '{}' }]), false);
    const initialResult = await agent._maybeJevFastTurn(1, 'Click Save', initialCapture, 'act', allowed, provider, {});
    assert.equal(initialResult.toolCalls[0].function.name, 'get_accessibility_tree');
    assert.equal(await agent._maybeJevFastTurn(1, 'Click the pictured button', [{ role: 'user', content: [image] }], 'act', allowed, provider, {}), null);
    assert.equal(await agent._jevClassify(1, 'classify', { yes: 'yes' }, { task: [{ type: 'image_url', image_url: { url: 'private' } }] }), null);
    assert.equal(await agent._jevClassify(1, 'classify', { yes: 'yes' }, { task: 'data:image/png;base64,private' }), null);
    assert.equal(calls, 0);
    agent.strictSecretMode = true; assert.equal(await agent._jevClassify(1, 'classify', { yes: 'yes' }, {}), null);
    agent.strictSecretMode = false; storage.typesafeApiKey = ''; assert.equal(await agent._jevClassify(1, 'classify', { yes: 'yes' }, {}), null); assert.equal(calls, 0);
    storage.typesafeApiKey = 'synthetic';
    const normal = Agent.prototype.evaluateSystemOne.bind(agent);
    agent._checkCostAllowance = async () => 'Budget exhausted';
    let dispatched = false;
    await assert.rejects(normal(1, { evaluate: async args => { await args.beforeRequest(); dispatched = true; } }, {})); assert.equal(dispatched, false);
  });

  test(`${build}: sensitive controls keep the whole browser decision on the main model`, async () => {
    const sensitive = { ...snapshot(), hasSensitiveControls: true };
    assert.equal(mod.buildJevBrowserRequest('Create account', sensitive, []), null);
    const provider = { name: 'test', model: 'active-model' };
    const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
    const session = new mod.JevFastSession(); session.observe(sensitive); agent._jevSessions = new Map([[1, session]]);
    let calls = 0;
    agent.evaluateSystemOne = async () => { calls++; throw Error('must not call'); };
    assert.equal(await agent._maybeJevFastTurn(1, 'Create account', [], 'act', new Set(['get_accessibility_tree', 'click_ax']), provider, {}), null);
    assert.equal(calls, 0);
    assert.equal(session.fallbackCount, 1);
  });
  test(`${build}: multilingual fast classifications reach the service within its byte budget`, async () => {
    const provider = { name: 'test', model: 'active-model', config: {} };
    const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastClassifications: true, typesafeApiKey: 'synthetic' });
    agent._checkCostAllowance = async () => null;
    agent._recordCostUsage = async () => null;
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      const request = JSON.parse(options.body);
      assert.ok(Buffer.byteLength(JSON.stringify(request.state)) <= 16000);
      assert.match(request.state.context, /<untrusted_page_content.*[\s\S]*<\/untrusted_page_content/);
      return { ok: true, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
        classification: { type: 'choice', choice: 'yes', confidence: .95, probabilities: { yes: .95, no: .05 } },
      } }) };
    };
    try {
      for (const sample of ['作業は完了しました。', '😀確認\n"\\\u0000']) {
        assert.equal(await agent._jevClassify(1, 'Classify the request', { yes: 'yes', no: 'no' }, { task: sample.repeat(2000) }), 'yes');
      }
      assert.equal(calls, 2);
    } finally { globalThis.fetch = original; }
  });
  test(`${build}: completion candidate returns to active LLM, never dispatches done`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
    const session = new mod.JevFastSession(); session.observe(snapshot()); agent._jevSessions = new Map([[1, session]]);
    agent._jevPrepareValues = async () => [];
    agent.evaluateSystemOne = async () => ({ model: 'jev-1.13.0', answers: { operation: choice('done') } });
    const messages = [{ role: 'system', content: 'Original policy' }, { role: 'user', content: 'Save record' }];
    const original = structuredClone(messages);
    const result = await agent._maybeJevFastTurn(1, 'Save record', messages, 'act', new Set(['get_accessibility_tree', 'done']), provider, {});
    assert.equal(result, null); assert.equal(session.disabled, true);
    assert.deepEqual(messages, original);
    const modelMessages = agent._jevModelMessages(1, messages);
    assert.match(modelMessages[0].content, /not proof of success/);
    assert.equal(modelMessages[0].role, 'system');
    assert.equal(modelMessages.length, original.length);
    assert.deepEqual(messages, original);
    assert.deepEqual(modelMessages.filter(m => m.role === 'user'), original.filter(m => m.role === 'user'));
    session.observe({ ...snapshot(), progress: 'new-observation' });
    assert.equal(agent._jevModelMessages(1, messages), messages);
    assert.equal(agent._jevPendingCalls?.size || 0, 0);
  });
  test(`${build}: generated calls denied by available tool policy cannot be retried by Jev`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    const session = new mod.JevFastSession();
    const result = agent._jevResultForCall(1, session, { name: 'click_ax', args: { ref_id: 'ref_3' } });
    agent._runModeOverrides.set(1, 'ask');
    let dispatched = false; agent.executeTool = async () => { dispatched = true; return { success: true }; };
    await agent._executeToolBatch(1, result.toolCalls, [], () => {}, provider, null, new Set());
    assert.equal(dispatched, false); assert.equal(session.disabled, true); assert.equal(agent._jevPendingCalls.size, 0);
  });
  test(`${build}: Stop while Jev is pending produces no executable call`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
    await agent._claimRunEntry(1, 'interactive');
    const session = new mod.JevFastSession(); session.observe(snapshot()); agent._jevSessions = new Map([[1, session]]);
    agent._jevPrepareValues = async () => []; agent._checkCostAllowance = async () => null;
    let entered; const ready = new Promise(r => { entered = r; }); const original = globalThis.fetch;
    globalThis.fetch = async () => { entered(); return new Promise(() => {}); };
    try {
      const running = agent._maybeJevFastTurn(1, 'Click Send', [], 'act', new Set(['get_accessibility_tree', 'click_ax']), provider, {});
      await ready; agent.abort(1); assert.equal(await running, null); assert.equal(agent._jevPendingCalls?.size || 0, 0);
    } finally { globalThis.fetch = original; agent._releaseRunEntry(1); }
  });

  test(`${build}: a replaced run cannot consume an earlier Jev decision`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
    agent._systemOneGenerations = new Map([[1, 1]]);
    const session = new mod.JevFastSession(); session.observe(snapshot()); agent._jevSessions = new Map([[1, session]]);
    agent._jevPrepareValues = async () => [];
    let entered, respond;
    const ready = new Promise(resolve => { entered = resolve; });
    agent.evaluateSystemOne = async () => { entered(); return new Promise(resolve => { respond = resolve; }); };
    const pending = agent._maybeJevFastTurn(1, 'Click Send', [], 'act', new Set(['get_accessibility_tree', 'click_ax']), provider, {});
    await ready;
    agent._systemOneGenerations.set(1, 2);
    respond({ answers: { operation: choice('click'), click_target: choice('ref_3') } });
    assert.equal(await pending, null);
    assert.equal(agent._jevPendingCalls?.size || 0, 0);
  });

  test(`${build}: repeated fallbacks stop paid decisions until a changed snapshot, without rearming hard stops`, async () => {
    for (const failure of ['fallback', 'low_confidence', 'service_error']) {
      const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
      Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
      const session = new mod.JevFastSession(); session.observe(snapshot()); agent._jevSessions = new Map([[1, session]]);
      let calls = 0, preparations = 0;
      agent._jevPrepareValues = async () => { preparations++; return []; };
      agent.evaluateSystemOne = async () => {
        calls++;
        if (failure === 'service_error') throw Error('Unavailable');
        return { answers: { operation: choice(failure === 'fallback' ? 'fallback' : 'click', failure === 'low_confidence' ? .5 : .95) } };
      };
      const decide = () => agent._maybeJevFastTurn(1, 'Click Save', [], 'act', new Set(['get_accessibility_tree', 'click_ax']), provider, {});
      for (let i = 0; i < 5; i++) { session.observe(snapshot()); assert.equal(await decide(), null); }
      assert.equal(calls, 2, failure); assert.equal(preparations, 0); assert.equal(session.fallbackBlocked, true);
      session.snapshot = null; // A main-model mutation requests a fresh observation.
      session.observe(snapshot()); await decide(); assert.equal(calls, 2);
      session.observe({ ...snapshot(), progress: 'changed' }); await decide(); assert.equal(calls, 3);
      session.dispatched({ outcomeUnknown: true });
      session.observe({ ...snapshot(), progress: 'changed-again' }); await decide(); assert.equal(calls, 3);
    }
  });

  test(`${build}: one response-contract failure hard-stops paid Jev decisions for the run`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
    const session = new mod.JevFastSession(); session.observe(snapshot()); agent._jevSessions = new Map([[1, session]]);
    let calls = 0; const notes = [];
    agent.recordSystemOneVerdict = (_tab, note) => notes.push(note);
    agent.evaluateSystemOne = async () => {
      calls++;
      const error = new Error('Invalid Jev distribution.');
      error.code = 'JEV_INVALID_DISTRIBUTION';
      throw error;
    };
    const decide = () => agent._maybeJevFastTurn(1, 'Click Save', [], 'act', new Set(['get_accessibility_tree', 'click_ax']), provider, {});
    assert.equal(await decide(), null);
    assert.equal(session.disabled, true);
    assert.equal(notes.at(-1)?.reason, 'invalid_distribution');
    session.observe({ ...snapshot(), documentToken: 'changed-doc', structure: 'changed', progress: 'changed' });
    assert.equal(await decide(), null);
    assert.equal(calls, 1);
  });

  test(`${build}: malformed classifier response hard-stops all Jev requests for the run`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, systemOneFastClassifications: true, typesafeApiKey: 'synthetic' });
    let calls = 0;
    agent.evaluateSystemOne = async () => {
      calls++;
      const error = new Error('Invalid Jev distribution.');
      error.code = 'JEV_INVALID_DISTRIBUTION';
      throw error;
    };
    const classify = () => agent._jevClassify(1, 'classify', { yes: 'yes', no: 'no' }, { task: 'Classify this request.' });
    assert.equal(await classify(), null);
    assert.equal(agent._jevSessions.get(1).hardStopped, true);
    assert.equal(await classify(), null);
    assert.equal(await agent._maybeJevFastTurn(1, 'Click Save', [], 'act', new Set(['get_accessibility_tree', 'click_ax']), provider, {}), null);
    assert.equal(calls, 1);
  });

  test(`${build}: click-only decisions and uncertain fill targets never invoke value preparation`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
    const session = new mod.JevFastSession(); session.observe(snapshot()); agent._jevSessions = new Map([[1, session]]);
    let preparations = 0;
    agent._jevPrepareValues = async () => { preparations++; return []; };
    agent.evaluateSystemOne = async () => ({ answers: { operation: choice('click'), click_target: choice('ref_3') } });
    const allowed = new Set(['get_accessibility_tree', 'click_ax', 'set_field']);
    const result = await agent._maybeJevFastTurn(1, 'Click Send', [], 'act', allowed, provider, {});
    assert.equal(result.toolCalls[0].function.name, 'click_ax');
    agent.evaluateSystemOne = async () => ({ answers: { operation: choice('fill'), fill_target: choice('ref_1', .89) } });
    assert.equal(await agent._maybeJevFastTurn(1, 'Fill Name Ada', [], 'act', allowed, provider, {}), null);
    assert.equal(preparations, 0);
  });

  test(`${build}: the first confident fill prepares once then maps values; cached fields avoid another LLM call`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
    const session = new mod.JevFastSession(); session.observe(snapshot()); agent._jevSessions = new Map([[1, session]]);
    const sequence = []; let prepared = 0;
    agent._chatWithCostAllowance = async () => {
      sequence.push('llm'); prepared++;
      return { content: JSON.stringify({ values: [{ purpose: 'Name', text: 'Ada' }, { purpose: 'Email', text: 'ada@example.com' }] }) };
    };
    agent.evaluateSystemOne = async (_tab, _client, args) => {
      sequence.push('jev');
      return { answers: { operation: choice('fill'), fill_target: choice('ref_1'), ...(args.questions.value_0 ? { value_0: choice('ref_1'), value_1: choice('ref_2') } : {}) } };
    };
    const decide = () => agent._maybeJevFastTurn(1, 'Fill Name Ada and Email ada@example.com', [], 'act', new Set(['get_accessibility_tree', 'set_field']), provider, {});
    const result = await decide();
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).text, 'Ada');
    assert.deepEqual(sequence, ['jev', 'llm', 'jev']);
    const queued = await decide(); assert.equal(JSON.parse(queued.toolCalls[0].function.arguments).text, 'ada@example.com');
    await decide(); assert.equal(prepared, 1); assert.deepEqual(sequence, ['jev', 'llm', 'jev', 'jev']);
  });

  test(`${build}: run replacement during lazy preparation cannot send a mapping request or tool call`, async () => {
    const provider = { name: 'test', model: 'active-model' }; const agent = new Agent({ getActive: () => provider });
    Object.assign(storage, { systemOneEnabled: true, systemOneFastBrowser: true, typesafeApiKey: 'synthetic' });
    agent._systemOneGenerations = new Map([[1, 1]]);
    const session = new mod.JevFastSession(); session.observe(snapshot()); agent._jevSessions = new Map([[1, session]]);
    let entered, resolveValues, calls = 0;
    const ready = new Promise(resolve => { entered = resolve; });
    agent._jevPrepareValues = async () => { entered(); return new Promise(resolve => { resolveValues = resolve; }); };
    agent.evaluateSystemOne = async () => { calls++; return { answers: { operation: choice('fill'), fill_target: choice('ref_1') } }; };
    const pending = agent._maybeJevFastTurn(1, 'Fill Name Ada', [], 'act', new Set(['get_accessibility_tree', 'set_field']), provider, {});
    await ready; agent._systemOneGenerations.set(1, 2);
    resolveValues([{ purpose: 'Name', text: 'Ada' }]);
    assert.equal(await pending, null); assert.equal(calls, 1); assert.equal(agent._jevPendingCalls?.size || 0, 0);
  });

}
