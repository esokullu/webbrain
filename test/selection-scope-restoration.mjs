import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function moduleUrl(relativePath) {
  return pathToFileURL(path.join(ROOT, relativePath)).href;
}

function createBrowserApi(session) {
  return {
    alarms: {},
    runtime: { getURL: value => String(value || '') },
    storage: {
      local: {
        get: async defaults => defaults || {},
        set: async () => {},
      },
      session: {
        get: async key => {
          if (typeof key === 'string') return { [key]: session[key] };
          return { ...session };
        },
        set: async values => Object.assign(session, structuredClone(values)),
        remove: async key => {
          for (const value of Array.isArray(key) ? key : [key]) delete session[value];
        },
      },
    },
    tabs: {
      get: async tabId => ({
        id: tabId,
        url: 'https://mail.google.com/mail/u/0/#inbox/thread-id',
        title: 'Test mail thread',
      }),
    },
  };
}

const chromeSession = {};
const firefoxSession = {};
globalThis.chrome = createBrowserApi(chromeSession);
globalThis.browser = createBrowserApi(firefoxSession);

const [{ Agent: ChromeAgent }, { Agent: FirefoxAgent }] = await Promise.all([
  import(moduleUrl('src/chrome/src/agent/agent.js')),
  import(moduleUrl('src/firefox/src/agent/agent.js')),
]);

for (const relativePath of [
  'src/chrome/src/agent/agent.js',
  'src/firefox/src/agent/agent.js',
]) {
  const source = await readFile(path.join(ROOT, relativePath), 'utf8');
  assert.equal(
    (source.match(/const restorationFirstRead = await this\._maybeExecuteSelectionRestorationFirstRead\(/g) || []).length,
    2,
    `${relativePath}: deterministic restoration read is not wired into both execution loops`,
  );
}

for (const [label, AgentClass, session] of [
  ['chrome', ChromeAgent, chromeSession],
  ['firefox', FirefoxAgent, firefoxSession],
]) {
  const tabId = label === 'chrome' ? 29610 : 29611;
  const storageKey = `agentConv:${tabId}`;
  const conversationId = `selection-restoration-${label}`;
  const selectedTurn = {
    role: 'user',
    content: 'Use only the text inside the selection block. SELECTED_TEXT',
  };
  const messages = [
    { role: 'system', content: 'system rules' },
    selectedTurn,
    { role: 'assistant', content: 'I can only proofread the selected text.' },
  ];

  const first = new AgentClass({ getActive: () => ({ supportsVision: false }) });
  first.conversations.set(tabId, messages);
  first.conversationIds.set(tabId, conversationId);
  first.conversationModes.set(tabId, 'ask');
  first.selectionGroundingScopes.set(tabId, {
    conversationId,
    anchorIndex: 1,
    anchorFingerprint: first._selectionGroundingMessageFingerprint(selectedTurn),
    excludedFingerprints: [],
    action: 'proofread',
    sourceGrounding: 'selection_only',
  });
  assert.equal((await first._persistNow(tabId)).ok, true, `${label}: initial scope did not persist`);

  const restored = new AgentClass({ getActive: () => ({ supportsVision: false }) });
  assert.equal(await restored.restoreSelectionGroundingScope(tabId), true, `${label}: restore was rejected`);
  assert.equal(restored.selectionGroundingScopes.has(tabId), false, `${label}: restore kept the selection boundary`);
  assert.equal(restored.selectionGroundingRestorationPendingTabs.has(tabId), true, `${label}: restore did not arm the next-turn correction`);
  assert.equal((await restored._persistNow(tabId)).ok, true, `${label}: restored state did not persist`);
  assert.equal(session[storageKey].selectionGroundingScope, null, `${label}: persisted scope survived restore`);
  assert.equal(session[storageKey].selectionGroundingRestorationPending, true, `${label}: pending correction was not persisted`);

  const restarted = new AgentClass({ getActive: () => ({ supportsVision: false }) });
  await restarted._hydrate(tabId);
  assert.equal(restarted.selectionGroundingRestorationPendingTabs.has(tabId), true, `${label}: restart lost the pending correction`);
  restarted._readCompletenessNeedsScopeClassification = () => false;

  const question = 'in broader context same too?';
  const enriched = await restarted._enrichUserMessageWithCurrentPage(
    tabId,
    restarted.conversations.get(tabId),
    question,
  );
  assert.equal(enriched.webbrainSelectionScopeRestored, true, `${label}: corrected turn was not marked for one-shot consumption`);
  assert.match(enriched.content, /user explicitly removed the selected-text boundary/i, `${label}: correction did not override historical selection-only wording`);
  assert.match(enriched.content, /Normal access to the current page, browser tools, files, attachments, and the complete conversation is restored/i, `${label}: correction did not describe restored context`);
  assert.match(enriched.content, /attach a fresh read of the current page before the model answers/i, `${label}: correction did not announce the deterministic page read`);
  assert.match(enriched.content, /Interpret the latest request using the restored page and conversation context/i, `${label}: correction did not bind the turn to restored context`);
  assert.equal(restarted._stripInjectedTaskContext(enriched.content), question, `${label}: trusted correction leaked into user-authored task text`);

  assert.deepEqual(
    restarted._selectionRestorationFirstRead(enriched, new Set(['get_accessibility_tree', 'read_page'])),
    { tool: 'read_page', args: {} },
    `${label}: restored turn did not prefer a fresh readable-page snapshot`,
  );
  assert.deepEqual(
    restarted._selectionRestorationFirstRead(enriched, new Set(['get_accessibility_tree'])),
    { tool: 'get_accessibility_tree', args: { filter: 'all', maxDepth: 15, maxChars: 6000 } },
    `${label}: restored turn did not fall back to the accessibility tree`,
  );
  assert.equal(
    restarted._selectionRestorationFirstRead({ role: 'user', content: question }, new Set(['read_page'])),
    null,
    `${label}: an unmarked turn incorrectly triggered the restoration read`,
  );

  let executedFirstRead = null;
  restarted._executeToolBatch = async (...args) => {
    executedFirstRead = args;
    return { action: 'continue' };
  };
  const firstReadMessages = [];
  const firstReadResult = await restarted._maybeExecuteSelectionRestorationFirstRead(
    tabId,
    enriched,
    firstReadMessages,
    () => {},
    {},
    new Set(['read_page']),
    new Map(),
  );
  assert.equal(firstReadResult.action, 'continue', `${label}: deterministic first read did not continue the run`);
  assert.equal(firstReadMessages[0]?.tool_calls?.[0]?.function?.name, 'read_page', `${label}: deterministic first read did not enqueue read_page`);
  assert.equal(executedFirstRead?.[1]?.[0]?.function?.name, 'read_page', `${label}: deterministic first read was not executed`);

  const gate = await restarted._maybeRunPlannerGate(
    tabId,
    restarted.conversations.get(tabId),
    enriched,
    () => {},
    'ask',
    null,
    null,
    null,
    { detachedRequestId: `restore-${label}` },
  );
  assert.equal(gate.proceed, true, `${label}: corrected ordinary turn did not enter Ask`);
  assert.equal(restarted.selectionGroundingRestorationPendingTabs.has(tabId), true, `${label}: planner gate consumed correction before execution`);
  assert.equal(session[storageKey].selectionGroundingRestorationPending, true, `${label}: planner gate persisted correction as consumed before execution`);
  assert.match(JSON.stringify(session[storageKey].messages), /user explicitly removed the selected-text boundary/i, `${label}: accepted correction was not persisted with the user turn`);

  assert.equal(restarted._consumeSelectionGroundingRestoration(tabId, enriched), true, `${label}: execution did not consume the accepted correction`);
  restarted._persist(tabId);
  assert.equal((await restarted._persistNow(tabId)).ok, true, `${label}: consumed correction did not persist`);
  assert.equal(session[storageKey].selectionGroundingRestorationPending, false, `${label}: consumed correction remained pending in storage`);

  const afterConsumption = new AgentClass({ getActive: () => ({ supportsVision: false }) });
  await afterConsumption._hydrate(tabId);
  assert.equal(afterConsumption.selectionGroundingRestorationPendingTabs.has(tabId), false, `${label}: consumed correction reappeared after restart`);
  const nextTurn = await afterConsumption._enrichUserMessageWithCurrentPage(
    tabId,
    afterConsumption.conversations.get(tabId),
    'What else is on the page?',
  );
  assert.equal(nextTurn.webbrainSelectionScopeRestored, undefined, `${label}: later turn reused the one-shot marker`);
  assert.doesNotMatch(nextTurn.content, /user explicitly removed the selected-text boundary/i, `${label}: later turn repeated the one-shot correction`);

  afterConsumption.selectionGroundingRestorationPendingTabs.add(tabId);
  afterConsumption._selectionGroundedRunOptions(tabId, afterConsumption.conversations.get(tabId), {
    sourceGrounding: 'selection_only',
    selectionAction: 'proofread',
  });
  assert.equal(afterConsumption.selectionGroundingRestorationPendingTabs.has(tabId), false, `${label}: a new selection did not supersede the pending correction`);
}

for (const [label, AgentClass, session] of [
  ['chrome', ChromeAgent, chromeSession],
  ['firefox', FirefoxAgent, firefoxSession],
]) {
  for (const [pathIndex, streaming] of [false, true].entries()) {
    for (const [caseIndex, testCase] of [
      {
        name: 'blocked',
        mode: 'ask',
        promptTier: 'full',
        outcome: { proceed: false, message: 'Clarification required.', reason: 'clarification' },
      },
      {
        name: 'response-only',
        mode: 'act',
        promptTier: 'full',
        outcome: { proceed: true, responseOnly: true, requestKind: 'conversation', requiresStateChange: false },
      },
      {
        name: 'dev-blocked',
        mode: 'dev',
        promptTier: 'compact',
        outcome: null,
      },
    ].entries()) {
      const tabId = (label === 'chrome' ? 29620 : 29640) + (pathIndex * 10) + caseIndex;
      const storageKey = `agentConv:${tabId}`;
      const provider = { supportsVision: false, promptTier: testCase.promptTier };
      const agent = new AgentClass({
        getActive: () => provider,
        prepareActiveProviderCapabilities: async () => {},
      });
      agent.conversations.set(tabId, [{ role: 'system', content: 'system rules' }]);
      agent.conversationIds.set(tabId, `selection-restoration-${label}-${testCase.name}-${streaming}`);
      agent.conversationModes.set(tabId, testCase.mode);
      agent.selectionGroundingRestorationPendingTabs.add(tabId);
      agent._hydrate = async () => {};
      agent._manageContext = async () => {};
      agent._applyStandaloneWikipediaRag = async () => null;
      agent._getTabUrlTitle = async () => ({ tabUrl: 'https://example.com/', tabTitle: 'Example' });
      agent._startTraceRun = async () => null;
      agent._endTraceRun = async () => {};
      agent._readCompletenessNeedsScopeClassification = () => testCase.name === 'blocked';
      agent._runReadScopeClassifier = async () => testCase.outcome;
      agent._plannerMode = () => 'off';
      agent._runPlannerIntentGate = async () => testCase.outcome;
      agent._completeResponseOnlyTurn = async () => ({ content: 'Context-only response.', status: 'done' });
      agent._enrichUserMessageWithCurrentPage = async () => ({
        role: 'user',
        content: 'Use the restored page context.',
        webbrainSelectionScopeRestored: true,
      });

      const final = streaming
        ? await agent._processMessageStreamInner(
          tabId, 'Use the restored page context.', () => {}, testCase.mode,
          { detachedRequestId: `restore-${label}-${testCase.name}-${streaming}` },
        )
        : await agent._processMessageInner(
          tabId, 'Use the restored page context.', () => {}, testCase.mode, [],
          { detachedRequestId: `restore-${label}-${testCase.name}-${streaming}` },
        );
      assert.ok(final, `${label} ${testCase.name} ${streaming ? 'streaming' : 'non-streaming'}: missing early response`);
      assert.equal((await agent._persistNow(tabId)).ok, true, `${label} ${testCase.name}: pending state did not persist`);
      assert.equal(
        agent.selectionGroundingRestorationPendingTabs.has(tabId),
        true,
        `${label} ${testCase.name} ${streaming ? 'streaming' : 'non-streaming'}: early return consumed the correction`,
      );
      assert.equal(
        session[storageKey].selectionGroundingRestorationPending,
        true,
        `${label} ${testCase.name} ${streaming ? 'streaming' : 'non-streaming'}: early return persisted the correction as consumed`,
      );
    }
  }
}

console.log('ok - selection scope restoration is persisted and consumed once (Chrome + Firefox)');
