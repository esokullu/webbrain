import assert from 'node:assert/strict';
import { test } from 'node:test';

const api = { runtime: { getURL: value => `chrome-extension://fixture/${value}` },
  storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
  tabs: { get: async id => ({ id, url: 'https://messages.test/chat' }) } };
globalThis.chrome = api; globalThis.browser = api;
const variants = await Promise.all(['chrome', 'firefox'].map(async name => [name, await import(`../src/${name}/src/agent/vision-act.js`)]));
const viewport = { width: 800, height: 600, devicePixelRatio: 1, url: 'https://messages.test/chat', documentId: 'doc-1' };
const image = { id: 'image-1', dataUrl: 'data:image/jpeg;base64,Zml4dHVyZQ==', mimeType: 'image/jpeg', width: 800, height: 600, rect: { x: 0, y: 0, width: 800, height: 600 } };
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function fixture(module, tool, proposed, review, pending = true) {
  let latest, sequence = 0, count = 0, changed = false, historyFrames = [];
  const actions = [], events = [], reviews = [], requests = [], conversation = [], controller = new AbortController();
  const evidence = { schema: 'vision-evidence-v1', chatLedger: pending ? [{ peer: JSON.stringify(['https://messages.test', 'alice']), sent: [],
    pending: { id: 'uncertain-send', text: 'Approved reply', recipient: 'Alice', stage: 'uncertain', scopeId: 'old-task', replyAnchor: 'Hello',
      baseline: { frameId: 'old-frame', url: viewport.url, documentId: viewport.documentId,
        claims: { messages: [{ direction: 'incoming', text: 'Hello' }] } } } }] : [] };
  let stored = { schema: 'vision-runtime-v1', files: { operations: {} }, captcha: { attempts: {} }, groups: ['chat', 'files'], evidence };
  api.storage.local.get = async key => ({ [key]: structuredClone(stored) });
  api.storage.local.set = async value => { stored = structuredClone(Object.values(value)[0]); };
  const provider = { name: 'fixture', model: 'vision', supportsVision: true, supportsTools: true };
  const frames = {
    get latest() { return latest; }, reset() { latest = null; historyFrames = []; },
    assertViewport(current) { assert.equal(current.documentId, viewport.documentId); },
    contextFrames() { return historyFrames; },
    async capture(_data, geometry, options = {}) {
      const kind = !latest || options.forceFull ? 'full' : changed ? 'delta' : 'unchanged'; changed = false;
      const frameId = `frame-${++sequence}`;
      latest = { protocol: 'vision-frame-v1', frameId, baseFrameId: kind === 'full' ? frameId : historyFrames[0].frameId,
        kind, viewport: geometry, canvas: { width: 800, height: 600 }, images: kind === 'unchanged' ? [] : [{ ...image, id: `${frameId}-image` }], bytes: 20, estimatedTokens: 50 };
      historyFrames = kind === 'full' ? [latest] : [...historyFrames, latest]; return latest;
    },
  };
  const agent = { actObservation: 'vision', maxSteps: 4, currentCostState: new Map(),
    providerManager: { prepareActiveProviderCapabilities: async () => {} }, _activeProvider: () => provider,
    permissions: { beginTurn() {} }, _skipPermissionGate: true, _ensureGateSetting: async () => {},
    _runAbortSignal: () => controller.signal, _throwIfAborted: signal => signal?.throwIfAborted(), _checkAbort: () => controller.signal.aborted,
    _hasPendingSteering: () => false, _applyPendingSteering: () => false, _newCostRunState: () => ({}),
    _persistSubmittedTurn: async () => {}, _persistNow: async () => ({ ok: true }),
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _withResponseItems: message => message,
    getConversation: () => conversation, _createVisionFrameSession: () => frames,
    _resolveUserAttachment: () => assert.fail('Pending chat must block uploads before reading attachment bytes'),
    _reviewVisionEvidence: async proposal => { reviews.push(proposal); return typeof review === 'function' ? review(proposal, frames) : review; },
    _createVisionBrowser: options => ({ readViewport: async () => viewport, capture: async () => ({ dataUrl: image.dataUrl, viewport }),
      perform: async (_tab, name, args) => { await options.beforeDispatch?.(); actions.push({ name, args }); changed = true; return { success: true, dispatched: true }; } }),
    _chatWithCostAllowance: async (_provider, messages) => {
      requests.push(structuredClone(messages));
      if (count++ === 0) return { toolCalls: [call(tool, { frameId: latest.frameId, ...proposed })] };
      return { toolCalls: [call('done', { frameId: latest.frameId, outcome: 'partial', summary: 'Pending send preserved.' })] };
    },
  };
  return { agent, actions, events, reviews, requests, getStored: () => stored, run: () => module.runVisionAct(agent, { tabId: 1, userMessage: 'Find Alice and verify the pending message without sending again.',
    onUpdate: (type, value) => events.push({ type, ...value }) }) };
}
const good = { verified: true, allowed: true, navigationOnly: true, provenance: 'independent_visual_review' };

for (const [browser, module] of variants) {
  test(`${browser}: independently reviewed conversation navigation can recover a pending send`, async () => {
    const f = fixture(module, 'vision_click', { x: 30, y: 40 }, good);
    assert.equal(await f.run(), 'Pending send preserved.'); assert.equal(f.actions.length, 1); assert.equal(f.actions[0].name, 'click');
    assert.equal(f.reviews[0].expected.pendingChat, true);
    assert.equal(f.events.find(event => event.type === 'tool_result' && event.name === 'vision_click').result.success, true);
    assert.equal(f.requests.length, 2);
  });

  test(`${browser}: pending chat rejects mutation, keys and contradictory recovery verdicts before native input`, async () => {
    for (const [tool, args, verdict] of [
      ['vision_click', { x: 30, y: 40 }, { ...good, navigationOnly: false }],
      ['vision_key', { key: 'Enter' }, good], ['vision_type', { text: 'Duplicate reply' }, good],
      ['vision_click', { x: 30, y: 40 }, { ...good, requiresChatProtocol: true }],
      ['vision_click', { x: 30, y: 40 }, { ...good, draftProtected: true }],
    ]) {
      const f = fixture(module, tool, args, verdict); await f.run();
      assert.equal(f.actions.length, 0, `${tool}: ${JSON.stringify(verdict)}`);
      const result = f.events.find(event => event.type === 'tool_result' && event.name === tool).result;
      assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false);
    }
  });

  test(`${browser}: pending chat prevents upload preparation and byte reads`, async () => {
    const f = fixture(module, 'upload_file', { x: 30, y: 40, attachmentId: 'owned-file' }, good); await f.run();
    const result = f.events.find(event => event.type === 'tool_result' && event.name === 'upload_file').result;
    assert.equal(result.noDispatch, true); assert.equal(f.actions.length, 0);
  });

  test(`${browser}: a contradictory requiresChatProtocol verdict cannot bypass the protocol without a pending receipt`, async () => {
    const f = fixture(module, 'vision_click', { x: 30, y: 40 }, { ...good, requiresChatProtocol: true }, false); await f.run();
    assert.equal(f.actions.length, 0);
    const result = f.events.find(event => event.type === 'tool_result' && event.name === 'vision_click').result;
    assert.equal(result.code, 'vision_chat_protocol_required'); assert.equal(result.noDispatch, true);
  });

  test(`${browser}: a frame replaced during independent review cannot dispatch old coordinates`, async () => {
    const f = fixture(module, 'vision_click', { x: 30, y: 40 }, async (_proposal, frames) => {
      await frames.capture(image.dataUrl, viewport, { forceFull: true }); return good;
    });
    await f.run(); assert.equal(f.actions.length, 0);
    const result = f.events.find(event => event.type === 'tool_result' && event.name === 'vision_click').result;
    assert.equal(result.code, 'vision_stale_frame'); assert.equal(result.noDispatch, true);
  });

  for (const stage of ['preparing', 'typing', 'submitting']) for (const wait of ['checkpoint', 'permission']) {
    test(`${browser}: chat ${stage} rechecks recipient and draft after the final ${wait} wait`, async () => {
      const f = fixture(module, '', {}, { ...good, recipientMatches: true, composerMatches: true, atLatest: true }, false);
      const frames = f.agent._createVisionFrameSession(), snapshots = new Map();
      const screen = { recipient: 'Alice', draft: '' };
      let observationId, operationId, count = 0, mutated = false, guardsAfterMutation = 0, stageCheckpoints = 0;
      const originalCapture = frames.capture.bind(frames);
      frames.capture = async (...args) => {
        const frame = await originalCapture(...args); snapshots.set(frame.frameId, { ...screen }); return frame;
      };
      frames.assertCurrentRegions = async (_data, _viewport, { frameId, rects }) => {
        assert.ok(rects.some(rect => rect.y === 10), 'The complete recipient must remain guarded');
        assert.ok(rects.some(rect => rect.y === 400), 'The composer must remain guarded');
        if (mutated) guardsAfterMutation++;
        if (JSON.stringify(snapshots.get(frameId)) !== JSON.stringify(screen))
          throw Object.assign(new Error('Recipient or draft changed while saving the dispatch checkpoint'), { code: 'vision_stale_frame' });
      };
      const box = y => ({ x: 10, y, width: 200, height: 30 });
      const claims = () => ({ frameId: frames.latest.frameId, recipient: { text: screen.recipient, rect: box(10) },
        composer: { text: screen.draft, rect: box(400) }, sendControl: { rect: { x: 700, y: 400, width: 60, height: 30 } },
        messages: [{ direction: 'incoming', text: 'Hello', rect: box(100) }], atLatest: true, userInputRequired: false });
      f.agent.maxSteps = 7;
      const mutate = () => {
        if (!mutated) {
          mutated = true;
          if (stage === 'typing') screen.draft = 'A user draft entered during the checkpoint';
          else screen.recipient = 'Mallory';
        }
      };
      f.agent._persistNow = async () => {
        if (wait === 'checkpoint' && f.getStored().evidence.chatLedger[0]?.pending?.stage === stage
          && ++stageCheckpoints === 2) mutate();
        return { ok: true };
      };
      f.agent._ensureGateSetting = async () => {
        if (wait === 'permission' && f.getStored().evidence.chatLedger[0]?.pending?.stage === stage) mutate();
      };
      f.agent._createVisionBrowser = options => ({ readViewport: async () => viewport,
        capture: async () => ({ dataUrl: image.dataUrl, viewport }),
        perform: async (_tab, name, args) => {
          await options.beforeDispatch?.(); f.actions.push({ name, args });
          if (name === 'type') screen.draft = args.text;
          return { success: true, dispatched: true };
        } });
      f.agent._chatWithCostAllowance = async () => {
        const previous = f.events.filter(event => event.type === 'tool_result').at(-1)?.result;
        if (previous?.observationId) observationId = previous.observationId;
        if (previous?.operationId) operationId = previous.operationId;
        if (mutated || count >= 4) return { toolCalls: [call('done', { frameId: frames.latest.frameId,
          outcome: 'partial', summary: 'Changed recipient or draft requires a new observation.' })] };
        const tool = count++ % 2 === 0 ? 'chat_observe' : 'chat_send';
        return { toolCalls: [call(tool, tool === 'chat_observe' ? claims() : { frameId: frames.latest.frameId,
          recipient: 'Alice', text: 'Approved reply', stage: count === 2 ? 'prepare' : 'submit', observationId,
          ...(operationId ? { operationId } : {}) })] };
      };
      await f.run();
      assert.equal(mutated, true, 'The checkpoint must exercise the targeted action stage');
      assert.ok(guardsAfterMutation > 0, 'Evidence must be rechecked after the final checkpoint');
      assert.equal(f.actions.length, stage === 'preparing' ? 0 : stage === 'typing' ? 1 : 2,
        'Changed semantic context must prevent the next native action');
      if (stage === 'typing') assert.equal(screen.draft, 'A user draft entered during the checkpoint');
      assert.equal(f.actions.filter(action => action.name === 'click' && action.args.x > 650).length, 0);
      const result = f.events.filter(event => event.type === 'tool_result' && event.name === 'chat_send').at(-1).result;
      assert.equal(result.code, 'vision_stale_frame');
      assert.equal(result.dispatched, false); assert.equal(result.noDispatch, true); assert.equal(result.outcomeUnknown, false);
      if (stage === 'submitting') assert.equal(f.getStored().evidence.chatLedger[0].pending.stage, 'prepared');
    });
  }
}
