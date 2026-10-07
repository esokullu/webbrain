import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE_URL = 'https://example.com/photo/1';
const documents = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Photo' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1, documentId: documents.get(tabId) || 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 2600;

function makeAgent(Agent, next) {
  const provider = {
    name: 'feedback progress test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: next,
    async *chatStream(messages) {
      const response = await next(messages);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._persistSubmittedTurn = async () => {};
  agent._startTraceRun = async () => null;
  agent._endTraceRun = async () => {};
  agent._beginReadCompleteness = async () => null;
  agent._manageContext = async () => {};
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => PAGE_URL;
  agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Photo' });
  agent._maybeEmitAskModeHandoff = async () => {};
  agent._maybeReinjectAdapter = async () => {};
  agent._ensureProgressSessionForCurrentTask = async () => {};
  agent._plannerMode = () => 'off';
  agent._runPlannerIntentGate = async () => ({
    proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
  });
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._isFormValidationCandidate = () => false;
  agent._preflightRichTextToolbarTarget = async () => ({ block: null });
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._pageFeedbackIdleMs = 0;
  agent._completionDoneBlock = () => null;
  agent.maxSteps = 5;
  return agent;
}

function bind(agent, tab) {
  const from = { tab: { id: tab }, frameId: 0, documentId: 'document-1', url: PAGE_URL };
  const state = agent.pageMonitorState(from, 'content-1');
  assert.equal(state.active, true);
  let seq = 0;
  return value => {
    const current = ++seq;
    assert.equal(agent.observePageFeedback(from, {
      ...state, seq: current, revision: current, kind: 'dom', source: 'page', target: 'span#views', ...value,
    }).accepted, true);
  };
}

const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const ANSWER = 'The photo is https://images.example/current-photo.jpg';
const done = () => call('finished', 'done', { summary: ANSWER, outcome: 'success' });
const finish = (agent, tab, streaming, updates, options) => streaming
  ? agent.processMessageStream(tab, 'Extract the current photo', (type, data) => updates.push({ type, data }), 'act', options)
  : agent.processMessage(tab, 'Extract the current photo', (type, data) => updates.push({ type, data }), 'act', [], options);

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} same-URL document replacement supersedes a read before the monitor registers`, async () => {
      const tab = nextTab++, updates = [], dispatched = [];
      let agent, requests = 0;
      const next = async () => {
        switch (++requests) {
          case 1:
            documents.set(tab, 'replacement-document');
            // The navigation observer and content registration may lag the
            // browser document. Fresh webNavigation identity must still fence it.
            agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 0, target: 'span#views' });
            return call('stale-read', 'extract_data', { type: 'headings' });
          case 2: return call('fresh-read', 'extract_data', { type: 'images' });
          case 3: return done();
          default: assert.fail('A refreshed document read should finish');
        }
      };
      agent = makeAgent(Agent, next);
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'article "Replacement document photo" [ref_1]' };
        if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        assert.equal(name, 'extract_data');
        dispatched.push(args);
        return { success: true, images: [{ src: 'https://images.example/current-photo.jpg' }] };
      };
      try {
        assert.equal(await finish(agent, tab, streaming, updates, { detachedRequestId: 'progress-run', askStreamingEnabled: false }), ANSWER);
        assert.deepEqual(dispatched, [{ type: 'images' }]);
        assert.equal(requests, 3);
      } finally { documents.delete(tab); }
    });

    for (const phase of ['model', 'preflight']) for (const target of ['coordinates', 'label']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} repeated ${target} rejected by ${phase} churn stops without dispatch`, async () => {
        const tab = nextTab++, updates = [], snapshots = [];
        let agent, send, requests = 0, dispatched = 0;
        const args = target === 'coordinates' ? { x: 100, y: 100, coordinate_space: 'css' } : { text: 'Continue' };
        const next = async messages => {
          snapshots.push(structuredClone(messages));
          assert.ok(++requests <= 6, 'Unlimited-step runs must have a bounded feedback recovery');
          if (phase === 'model') send({});
          return call(`unsafe-click-${requests}`, 'click', args);
        };
        agent = makeAgent(Agent, next);
        agent.maxSteps = Infinity;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab);
          return { role: 'user', content };
        };
        agent._preflightRichTextToolbarTarget = async (_tab, name) => {
          if (phase === 'preflight' && name === 'click') send({});
          return { block: null };
        };
        agent.executeTool = async (_tab, name) => {
          if (name === 'get_accessibility_tree') return { success: true, pageContent: `button "Continue" [ref_1]\n text "${requests} views"` };
          dispatched++;
          assert.fail(`Unsafe ${name} must not reach dispatch`);
        };
        const result = await finish(agent, tab, streaming, updates, { detachedRequestId: 'progress-run', askStreamingEnabled: false });
        assert.match(result, /Stopped because the page kept changing/);
        assert.match(result, /task is incomplete/i);
        assert.equal(requests, 5);
        assert.equal(dispatched, 0);
        assert.ok(snapshots.some(messages => /PAGE KEEPS CHANGING/.test(JSON.stringify(messages))), 'The model must receive the safer-action nudge');
        for (const messages of snapshots) {
          assert.ok(messages.filter(message => message.webbrainAppOwnedKind === 'page_feedback').length <= 1,
            'Counter churn must replace old observations instead of growing model context');
        }
        assert.ok(updates.some(update => update.type === 'warning' && /Stopped because the page kept changing/.test(update.data.message)));
      });
    }

    for (const phase of ['model', 'feedback_read', 'preflight', 'text_fallback']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} fresh extraction progresses through passive ${phase} churn`, async () => {
        const tab = nextTab++, updates = [], dispatched = [];
        let agent, send, requests = 0, reads = 0;
        const next = async () => {
          requests++;
          assert.ok(requests <= 2, 'Passive counters must not cause another model decision');
          // Keep changing the page on every inference, including completion.
          for (let index = 0; index < 3; index++) send({});
          if (requests === 2) return done();
          return phase === 'text_fallback'
            ? { content: JSON.stringify({ name: 'extract_data', arguments: { type: 'images' } }) }
            : call('extract-current', 'extract_data', { type: 'images' });
        };
        agent = makeAgent(Agent, next);
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab);
          return { role: 'user', content };
        };
        agent._preflightRichTextToolbarTarget = async (_tab, name) => {
          if (phase === 'preflight' && name === 'extract_data') send({});
          return { block: null };
        };
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') {
            reads++;
            if (phase === 'feedback_read') send({});
            return { success: true, pageContent: `article "Current photo" [ref_1]\n image "Photo" [ref_2]\n text "${reads} views"` };
          }
          if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
          assert.equal(name, 'extract_data');
          dispatched.push({ name, args });
          return { success: true, images: [{ src: 'https://images.example/current-photo.jpg' }] };
        };
        const result = await finish(agent, tab, streaming, updates, { detachedRequestId: 'progress-run', askStreamingEnabled: false });
        assert.equal(result, ANSWER, JSON.stringify(updates.filter(update => ['tool_result', 'warning'].includes(update.type))));
        assert.deepEqual(dispatched, [{ name: 'extract_data', args: { type: 'images' } }]);
        assert.equal(requests, 2);
        assert.ok(reads > 0, 'Feedback must still refresh the observation');
        assert.equal(agent._pageFeedbackRuns.size, 0);
      });
    }

    for (const phase of ['model', 'preflight']) for (const change of ['human_input', 'unknown', 'navigation', 'task_steering']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} fresh reads still supersede after ${change} during ${phase}`, async () => {
        const tab = nextTab++, updates = [], dispatched = [];
        let agent, send, requests = 0;
        const intervene = () => {
          if (change === 'task_steering') {
            assert.equal(agent.steerMessage(tab, 'Extract the updated photo instead', {
              requestId: 'progress-run', messageId: 'correction-1',
            }).accepted, true);
          } else if (change === 'navigation') {
            agent._queuePageFeedback(tab, { kind: 'navigation', source: 'user', frameId: 0, before: PAGE_URL, after: PAGE_URL });
          } else send({ kind: change === 'human_input' ? 'input' : 'dom', source: change === 'human_input' ? 'user' : 'unknown' });
        };
        const next = async () => {
          switch (++requests) {
            case 1:
              if (phase === 'model') intervene();
              return call('stale-read', 'extract_data', { type: 'headings' });
            case 2: return call('fresh-read', 'extract_data', { type: 'images' });
            case 3: return done();
            default: assert.fail('The updated read should finish without more model requests');
          }
        };
        agent = makeAgent(Agent, next);
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab);
          return { role: 'user', content };
        };
        agent._preflightRichTextToolbarTarget = async (_tab, name, args) => {
          if (phase === 'preflight' && name === 'extract_data' && args.type === 'headings') intervene();
          return { block: null };
        };
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') return { success: true, pageContent: 'article "Updated photo" [ref_1]' };
          if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
          assert.equal(name, 'extract_data');
          dispatched.push(args);
          return { success: true, images: [{ src: 'https://images.example/current-photo.jpg' }] };
        };
        const result = await finish(agent, tab, streaming, updates, { detachedRequestId: 'progress-run', askStreamingEnabled: false });
        assert.equal(result, ANSWER, JSON.stringify(updates.filter(update => ['tool_result', 'warning'].includes(update.type))));
        assert.deepEqual(dispatched, [{ type: 'images' }]);
        assert.equal(requests, 3);
        assert.equal(agent._pageFeedbackRuns.size, 0);
      });
    }
  }

  test(`${build}: repeated browser refreshes replace obsolete trees and captures while preserving trusted history`, async () => {
    const tab = nextTab++, agent = makeAgent(Agent, async () => assert.fail('Observation compaction does not need inference'));
    await agent._claimRunEntry(tab, 'interactive');
    const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Extract the current photo' },
      { role: 'assistant', content: 'I found the photo.' }];
    agent.conversations.set(tab, messages);
    agent._beginSteeringRun(tab, () => {}, { detachedRequestId: 'progress-run' });
    let revision = 0;
    agent.executeTool = async (_tab, name) => {
      assert.equal(name, 'get_accessibility_tree');
      return { success: true, pageContent: `article "Photo" [ref_1]\n text "${revision} views"` };
    };
    agent._shouldAutoScreenshot = () => true;
    agent._resolveVisionRoute = async () => ({ provider: { supportsVision: true }, rawImage: true });
    agent._captureBudgetedAutoScreenshot = async () => ({
      captureId: `capture-${revision}`, width: 1, height: 1, cssWidth: 1, cssHeight: 1,
      dataUrl: `data:image/png;base64,revision${revision}`,
    });
    try {
      const send = bind(agent, tab);
      await agent._capturePageFeedbackModelState(tab);
      for (revision = 1; revision <= 8; revision++) {
        send({});
        await agent._applyPendingPageFeedback(tab, messages);
        assert.equal(messages.filter(message => message.webbrainAppOwnedKind === 'page_feedback').length, 1);
        assert.equal(messages.filter(message => message.webbrainAppOwnedKind === 'page_feedback_capture').length, 1);
        assert.equal(messages[1].content, 'Extract the current photo');
        assert.equal(messages[2].content, 'I found the photo.');
      }
      assert.match(JSON.stringify(messages), /capture-8/);
      assert.doesNotMatch(JSON.stringify(messages), /capture-[1-7]/);
      assert.equal(agent._activeTaskBinding(messages).text, 'Extract the current photo');
    } finally { agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); }
  });
}

{
  // Download stage from webbrain-traces-1791372051482.json: X photo overlay,
  // unrelated live counters, and an optional pre-inference image binding missing.
  const PAGE_URL = 'https://x.com/mahallejargonu/status/2107603050810712208/photo/1';
  const IMAGE_URL = 'https://pbs.twimg.com/media/example-photo.jpg';
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  let blindDownloadAttempts = 0;
  const api = {
    storage: { local: area, session: area },
    runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
    tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Home / X' }), sendMessage: async () => ({ ready: true }) },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'photo-document', url: PAGE_URL }] },
    scripting: { executeScript: async options => {
      if (options.files) return [];
      if (/SocialMediaDownloader\.run\(/.test(String(options.func))) blindDownloadAttempts++;
      // Both optional prebinding and readonly candidate resolution fail here.
      // Extraction remains available, as in CSS/media carriers not represented
      // by the downloader's initial candidate selector.
      return [{ result: { bindings: { auto: null, image: null, video: null },
        diagnostics: { image: { status: 'unavailable', reason: 'no_matching_media' } }, status: 'unavailable' } }];
    } },
  };
  let nextTab = 4100;
  const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

  function setup(Agent, next) {
    const provider = {
      name: 'missing media regression', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false, chat: next,
      async *chatStream(messages) {
        const response = await next(messages);
        if (response.content) yield { type: 'text', content: response.content };
        if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((tool, index) => ({ ...tool, index })) };
        yield { type: 'done' };
      },
    };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    for (const method of ['_hydrate', '_persistSubmittedTurn', '_endTraceRun', '_manageContext', '_maybeReinjectAdapter',
      '_maybeEmitAskModeHandoff', '_ensureProgressSessionForCurrentTask']) agent[method] = async () => {};
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._startTraceRun = async () => null;
    agent._beginReadCompleteness = async () => null;
    agent._checkCostAllowance = async () => null;
    agent._recordCostUsage = async () => null;
    agent._currentUrl = async () => PAGE_URL;
    agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Home / X' });
    agent._plannerMode = () => 'off';
    agent._runPlannerIntentGate = async () => ({
      proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
      completionRequirements: { download: true },
    });
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
      '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
    agent._downloadSocialMediaFallbackDecision = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._isFormValidationCandidate = () => false;
    agent._preflightRichTextToolbarTarget = async () => ({ block: null });
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._pageFeedbackIdleMs = 0;
    agent._completionDoneBlock = () => null;
    agent.maxSteps = Infinity;
    return agent;
  }

  for (const build of ['chrome', 'firefox']) {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    for (const streaming of [false, true]) for (const mode of [undefined, 'main']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} missing ${mode || 'auto'} photo prebinding gives one readonly diagnostic and permits fresh extraction`, async () => {
        const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
        globalThis.chrome = api; globalThis.browser = api;
        try {
          const tab = nextTab++, updates = [], dispatched = [];
          let agent, requests = 0, sequence = 0, photoReads = 0;
          const final = 'Downloaded the photo as photo.jpg (download ID: saved-photo).';
          const counterUpdate = () => {
            const from = { tab: { id: tab }, frameId: 0, documentId: 'photo-document', url: PAGE_URL };
            const state = agent.pageMonitorState(from, 'photo-content');
            assert.equal(state.active, true);
            assert.equal(agent.observePageFeedback(from, { ...state, seq: ++sequence, revision: sequence,
              kind: 'dom', source: 'page', target: 'button [button]' }).accepted, true);
          };
          const next = async messages => {
            assert.ok(++requests <= 4, 'The missing optional binding must produce actionable tool feedback, not repeated model retries');
            counterUpdate();
            switch (requests) {
              case 1: return call('resolve-photo', 'download_social_media', { target: 'image', ...(mode ? { mode } : {}) });
              case 2: {
                const results = messages.filter(message => message.role === 'tool');
                assert.equal(results.length, 1);
                assert.match(results[0].content, /media_binding_unavailable/);
                assert.match(results[0].content, /"noDispatch":true/);
                assert.doesNotMatch(results[0].content, /"pageFeedbackPending":true/);
                return call('extract-photo', 'extract_data', { type: 'images' });
              }
              case 3:
                assert.ok(messages.some(message => message.role === 'tool' && message.content.includes(IMAGE_URL)));
                return call('download-exact-photo', 'download_files', { urls: [IMAGE_URL] });
              case 4: return call('finished', 'done', { summary: final, outcome: 'success' });
            }
          };
          agent = setup(Agent, next);
          agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
            // Bind the content document before the production inference snapshot.
            agent.pageMonitorState({ tab: { id: tab }, frameId: 0, documentId: 'photo-document', url: PAGE_URL }, 'photo-content');
            return { role: 'user', content };
          };
          const executeProductionTool = Agent.prototype.executeTool.bind(agent);
          agent.executeTool = async (_tab, name, args, onUpdate, context) => {
            if (name === 'get_accessibility_tree') {
              photoReads++;
              return { success: true, pageContent: `dialog [ref_1]\n button "${2556 + photoReads} Likes. Like" [ref_2] type="button"\n image "Photo" [ref_3]` };
            }
            if (name === 'download_social_media') {
              dispatched.push({ name, args });
              return executeProductionTool(_tab, name, args, onUpdate, context);
            }
            if (name === 'extract_data') {
              dispatched.push({ name, args });
              return { success: true, images: [{ src: IMAGE_URL }] };
            }
            if (name === 'download_files') {
              dispatched.push({ name, args });
              return { success: true, count: 1, completedCount: 1, downloads: [{ id: 'saved-photo', filename: 'photo.jpg', state: 'complete' }] };
            }
            assert.equal(name, 'done');
            return { done: true, success: true, summary: args.summary, outcome: args.outcome };
          };
          const blindBefore = blindDownloadAttempts;
          const options = { detachedRequestId: 'missing-media-run', askStreamingEnabled: false };
          const update = (type, data) => updates.push({ type, data });
          const result = streaming
            ? await agent.processMessageStream(tab, 'Download the currently open X photo', update, 'act', options)
            : await agent.processMessage(tab, 'Download the currently open X photo', update, 'act', [], options);
          assert.equal(result, final, JSON.stringify(updates.filter(entry => entry.type === 'tool_result')));
          assert.equal(requests, 4);
          assert.deepEqual(dispatched.map(entry => entry.name), ['download_social_media', 'extract_data', 'download_files']);
          assert.equal(blindDownloadAttempts, blindBefore, 'Missing binding resolution must never invoke the downloader');
          assert.ok(photoReads > 0);
          assert.equal(agent._pageFeedbackRuns.size, 0);
          assert.equal(updates.some(entry => entry.type === 'run_status' && entry.data.status === 'page_unstable'), false);
        } finally {
          globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
        }
      });
    }
  }
}
