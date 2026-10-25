import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { VisionEvidenceSession, VISION_EVIDENCE_TOOLS } from '../src/chrome/src/agent/vision-evidence.js';
import { VisionEvidenceSession as FirefoxEvidence } from '../src/firefox/src/agent/vision-evidence.js';
import { reviewVisionEvidence } from '../src/chrome/src/agent/vision-review.js';

const box = (y = 20) => ({ x: 10, y, width: 200, height: 30 });
const verified = { verified: true, allowed: true, provenance: 'independent_visual_review', reason: 'Fixture reviewed',
  recipientMatches: true, composerMatches: true, atLatest: true, delivered: true, newOutgoing: true,
  composerEmpty: true, completionVerified: true };
function fixture(Session = VisionEvidenceSession, options = {}) {
  let sequence = 1;
  const state = { current: { frameId: 'frame-1', canvas: { width: 800, height: 600 },
    viewport: { width: 800, height: 600, url: 'https://messages.test/chat', documentId: 'doc-1', scrollX: 0, scrollY: 0 } },
  recipient: 'Alice', draft: '', messages: [{ direction: 'incoming', text: 'Hello', rect: box(100) }],
  actions: [], reviews: [], guards: [], saves: [], failSave: false, failGuard: false, loseSendReply: false,
  delivery: true, verdict: verified, persist: true };
  const next = (changes = {}) => state.current = { ...state.current, frameId: `frame-${++sequence}`,
    viewport: { ...state.current.viewport, ...changes } };
  const claims = () => ({ frameId: state.current.frameId, recipient: { text: state.recipient, rect: box(10) },
    composer: { text: state.draft, rect: box(400) }, sendControl: { rect: { x: 700, y: 400, width: 60, height: 30 } },
    messages: structuredClone(state.messages), atLatest: true, userInputRequired: false });
  const session = new Session({ getFrame: () => state.current, observe: async () => next(),
    assertCurrent: async args => { state.guards.push(args); if (state.failGuard) throw Object.assign(new Error('Changed pixels'), { code: 'vision_stale_frame' }); },
    verify: async args => { state.reviews.push(args);
      if (args.kind === 'chat_draft') {
        assert.equal(args.claims.frameId, args.frame.frameId);
        assert.equal(args.claims.composer.text, args.expected.text, 'New draft claims must describe the new screenshot');
        if (args.expected.text !== state.draft) return { ...verified, verified: false };
      }
      return state.verdict;
    },
    authorizeChat: async ({ recipient, text }) => ({ allowed: recipient === 'Alice' && text === 'Approved reply', recipient, text, scopeId: 'trusted-user-request' }),
    persist: async saved => { if (state.failSave) throw new Error('Disk unavailable'); state.saves.push(structuredClone(saved)); return state.persist; },
    perform: async (action, args) => { state.actions.push({ action, ...args });
      if (action === 'type') state.draft = args.text;
      if (action === 'click' && args.x > 650) {
        if (state.delivery) { state.messages.push({ direction: 'outgoing', text: state.draft, rect: box(160) }); state.draft = ''; }
        if (state.loseSendReply) throw new Error('Native reply lost');
      }
      return { success: true, dispatched: true };
    },
    research: async ({ url }) => next({ url, documentId: 'research-doc', scrollY: 0 }), ...options });
  return { state, session, next, claims,
    observe: () => session.execute('chat_observe', claims()),
    send: (observation, stage = 'prepare', extra = {}) => session.execute('chat_send', {
      frameId: state.current.frameId, stage, observationId: observation.observationId, recipient: 'Alice', text: 'Approved reply', ...extra }),
  };
}

test('visual evidence mirrors are identical and schemas offer no DOM refs or selectors', async () => {
  assert.equal(await readFile(new URL('../src/chrome/src/agent/vision-evidence.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/firefox/src/agent/vision-evidence.js', import.meta.url), 'utf8'));
  assert.deepEqual(VISION_EVIDENCE_TOOLS.map(t => t.function.name), ['research_url', 'extract_data', 'find_text', 'verify_form', 'chat_observe', 'chat_send']);
  for (const item of VISION_EVIDENCE_TOOLS) assert.equal(item.function.parameters.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(VISION_EVIDENCE_TOOLS), /ref_id|selector|evaluate_js/);
});

for (const [name, Session] of [['Chrome', VisionEvidenceSession], ['Firefox', FirefoxEvidence]]) {
  test(`${name}: prepare, observe, submit once, then separately verify a new outgoing bubble`, async () => {
    const f = fixture(Session), observation = await f.observe();
    const draft = await f.send(observation);
    assert.equal(draft.draftPrepared, true); assert.equal(draft.sent, false);
    assert.equal(f.state.actions.filter(a => a.x > 650).length, 0);
    assert.equal(f.state.draft, 'Approved reply'); assert.ok(f.session.completionBlock());
    const withoutObservation = await f.send(observation, 'submit', { operationId: draft.operationId });
    assert.equal(withoutObservation.success, false);
    const prepared = await f.observe();
    const sent = await f.send(prepared, 'submit', { operationId: draft.operationId });
    assert.equal(sent.sent, true); assert.equal(sent.deliveryVerified, false); assert.equal(sent.outcomeUnknown, true);
    assert.ok(f.session.blockNativeAction()); assert.ok(f.session.completionBlock());
    const delivery = await f.observe();
    assert.equal(delivery.deliveryVerified, true); assert.equal(delivery.pendingOutbound, false);
    assert.equal(f.session.completionBlock(), null);
    assert.equal((await f.send(delivery)).code, 'vision_chat_already_sent');
    assert.equal(f.state.actions.filter(a => a.x > 650).length, 1);
    assert.equal(f.state.saves.at(-1).chatLedger[0].sent.length, 1);
    assert.equal(f.state.saves.at(-1).chatLedger[0].pending, null);
  });

  test(`${name}: recipients, user drafts, unauthorized bodies and stale pixels cannot reach native input`, async () => {
    for (const mode of ['recipient', 'draft', 'authorization', 'stale']) {
      const f = fixture(Session);
      if (mode === 'recipient') f.state.recipient = 'Mallory';
      if (mode === 'draft') f.state.draft = 'My unsent personal draft';
      const observed = await f.observe();
      if (mode === 'stale') f.state.failGuard = true;
      const result = await f.send(observed, 'prepare', mode === 'authorization' ? { text: 'Unrequested message' } : {});
      assert.equal(result.success, false, mode); assert.equal(result.noDispatch, true, mode);
      assert.equal(f.state.actions.length, 0, mode);
      if (mode === 'draft') assert.equal(f.state.draft, 'My unsent personal draft');
    }
  });

  test(`${name}: missing or acting-model-only verification is never accepted as visual proof`, async () => {
    for (const verdict of [{ verified: true }, { ...verified, provenance: 'acting_model' }, { ...verified, verified: false }, { ...verified, allowed: false }, { ...verified, recipientMatches: false }]) {
      const f = fixture(Session); f.state.verdict = verdict;
      const result = await f.observe(); assert.equal(result.success, false); assert.equal(f.state.actions.length, 0);
    }
    const f = fixture(Session, { verify: undefined });
    assert.equal((await f.observe()).code, 'vision_evidence_unavailable');
  });

  test(`${name}: pending send survives lost native reply and restart without replay`, async () => {
    const f = fixture(Session); const draft = await f.send(await f.observe()); const observed = await f.observe();
    f.state.loseSendReply = true;
    const receipt = await f.send(observed, 'submit', { operationId: draft.operationId });
    assert.equal(receipt.dispatched, true); assert.equal(receipt.outcomeUnknown, true); assert.notEqual(receipt.noDispatch, true);
    const restarted = fixture(Session, { state: f.session.getState() });
    assert.ok(restarted.session.completionBlock());
    const next = await restarted.observe();
    assert.equal((await restarted.send(next)).code, 'vision_chat_send_pending');
    assert.equal(restarted.state.actions.length, 0);
    assert.equal((await f.observe()).deliveryVerified, true);
    assert.equal(f.state.actions.filter(a => a.x > 650).length, 1);
  });

  test(`${name}: a freshly authorized exact prepared draft can resume under a new task scope`, async () => {
    const f = fixture(Session), prepared = await f.send(await f.observe());
    const resumed = fixture(Session, { state: f.session.getState(), authorizeChat: async ({ recipient, text }) => ({
      allowed: true, recipient, text, scopeId: 'trusted-scheduled-continuation' }) });
    resumed.state.draft = 'Approved reply';
    const observed = await resumed.observe();
    const result = await resumed.send(observed, 'submit', { operationId: prepared.operationId });
    assert.equal(result.sent, true); assert.equal(resumed.state.actions.filter(a => a.x > 650).length, 1);
    assert.equal(resumed.state.saves.find(save => save.chatLedger[0].pending?.stage === 'submitting').chatLedger[0].pending.scopeId, 'trusted-scheduled-continuation');
    const unrelated = fixture(Session, { state: f.session.getState(), authorizeChat: async () => ({ allowed: false, scopeId: 'new-unrelated-task' }) });
    unrelated.state.draft = 'Approved reply';
    assert.equal((await unrelated.send(await unrelated.observe(), 'submit', { operationId: prepared.operationId })).code, 'vision_chat_unauthorized');
    assert.equal(unrelated.state.actions.length, 0); assert.ok(unrelated.session.completionBlock());
  });

  test(`${name}: empty composer, old bubble or unverifiable delivery cannot clear a send`, async () => {
    const f = fixture(Session); const draft = await f.send(await f.observe()); const observed = await f.observe();
    f.state.delivery = false;
    await f.send(observed, 'submit', { operationId: draft.operationId });
    f.state.draft = ''; f.next();
    const empty = await f.observe(); assert.equal(empty.deliveryVerified, false); assert.equal(empty.pendingOutbound, true);
    f.state.messages.push({ direction: 'outgoing', text: 'Approved reply', rect: box(160) }); f.next();
    f.state.verdict = { ...verified, newOutgoing: false };
    const ambiguous = await f.observe(); assert.equal(ambiguous.deliveryVerified, false); assert.ok(f.session.completionBlock());
  });

  test(`${name}: focus-only interruption can clear safely and exact typed drafts recover without retyping`, async () => {
    const f = fixture(Session); let captures = 0;
    f.session.observe = async () => { if (++captures === 1) throw new Error('Capture unavailable after focus'); return f.next(); };
    const failed = await f.send(await f.observe()); assert.equal(failed.success, false); assert.equal(f.state.draft, '');
    assert.equal(failed.dispatched, true); assert.equal(failed.noDispatch, false); assert.equal(failed.outcomeUnknown, false);
    f.next(); assert.equal((await f.observe()).pendingOutbound, false);
    const g = fixture(Session); captures = 0;
    g.session.observe = async () => { if (++captures === 2) throw new Error('Capture unavailable after typing'); return g.next(); };
    const typed = await g.send(await g.observe()); assert.equal(typed.outcomeUnknown, true); assert.equal(g.state.draft, 'Approved reply');
    g.next(); const recovered = await g.observe();
    assert.equal(recovered.pendingOutbound, true);
    const sent = await g.send(recovered, 'submit', { operationId: typed.operationId }); assert.equal(sent.sent, true);
    assert.equal(g.state.actions.filter(a => a.action === 'type').length, 1); assert.equal(g.state.actions.filter(a => a.x > 650).length, 1);
  });

  test(`${name}: persistence failure before Send prevents input; failure after Send preserves uncertain receipt`, async () => {
    const before = fixture(Session); before.state.persist = false;
    assert.equal((await before.send(await before.observe())).code, 'vision_chat_not_durable');
    assert.equal(before.state.actions.length, 0);
    const f = fixture(Session); const draft = await f.send(await f.observe()); const observed = await f.observe();
    const perform = f.session.perform;
    f.session.perform = async (...args) => { const result = await perform(...args); f.state.failSave = true; return result; };
    const receipt = await f.send(observed, 'submit', { operationId: draft.operationId });
    assert.equal(receipt.dispatched, true); assert.equal(receipt.outcomeUnknown, true); assert.notEqual(receipt.noDispatch, true);
    assert.match(receipt.persistenceError, /Disk unavailable/); assert.ok(f.session.completionBlock());
    const attemptedCommit = await f.observe(); assert.equal(attemptedCommit.success, false);
    assert.ok(f.session.completionBlock(), 'A failed delivery ledger write must restore the pending transaction');
    assert.equal(f.state.actions.filter(a => a.x > 650).length, 1);
  });

  test(`${name}: persisted invalid ledgers fail closed and pending entries are never silently truncated`, () => {
    for (const state of [{}, { schema: 'vision-evidence-v1', chatLedger: [{ peer: 'x', sent: [], pending: {} }] }])
      assert.throws(() => fixture(Session, { state }), /ledger is invalid/);
    const ledger = Array.from({ length: 101 }, (_, i) => ({ peer: String(i), sent: [], pending: null }));
    ledger[0].pending = { id: 'pending-1', text: 'Uncertain', recipient: 'Alice', stage: 'uncertain', baseline: { claims: { messages: [] } } };
    const f = fixture(Session, { state: { schema: 'vision-evidence-v1', chatLedger: ledger } });
    assert.ok(f.session.completionBlock()); assert.equal(f.session.getState().chatLedger.length, 101);
  });

  test(`${name}: research navigates visibly, deduplicates overlapping rows and never calls gaps complete`, async () => {
    const f = fixture(Session);
    const source = await f.session.execute('research_url', { url: 'https://catalog.test/items' });
    assert.equal(source.navigated, true); assert.equal(source.complete, false);
    const extract = (top, atStart, atEnd, rows = [{ values: ['same row'], rect: box(100) }]) => {
      f.next({ scrollY: top });
      return f.session.execute('extract_data', { frameId: f.state.current.frameId, sourceId: source.sourceId,
        type: 'table', columns: ['Name'], rows, atStart, atEnd });
    };
    const start = await extract(0, true, false); assert.equal(start.complete, false);
    const gap = await extract(900, false, true); assert.equal(gap.complete, false); assert.equal(gap.rows.length, 2);
    const middle = await extract(500, false, false, [{ values: ['same row'], rect: box(500) }]);
    assert.equal(middle.complete, true); assert.equal(middle.rows.length, 2, 'Same content at distinct positions remains; actual overlap deduplicates');
    assert.equal(middle.wholeDatasetVerified, false); assert.equal(middle.dataSource, 'visual_transcription');
    f.next({ documentId: 'new-document' });
    assert.equal((await f.session.execute('extract_data', { frameId: f.state.current.frameId, sourceId: source.sourceId,
      type: 'table', columns: ['Name'], rows: [], atStart: false, atEnd: true })).code, 'vision_source_changed');
  });

  test(`${name}: research rejects false start, horizontal gaps, malformed columns and unverified transcriptions`, async () => {
    const f = fixture(Session);
    const extract = extra => f.session.execute('extract_data', { frameId: f.state.current.frameId,
      type: 'table', columns: ['Name'], rows: [{ values: ['Alice'], rect: box(100) }], atStart: true, atEnd: false, ...extra });
    f.next({ scrollY: 40 }); assert.equal((await extract()).code, 'vision_research_incomplete');
    f.next({ scrollY: 0 }); assert.equal((await extract({ rows: [{ values: ['Alice', 'extra'], rect: box(100) }] })).code, 'vision_extraction_shape');
    f.state.verdict = { ...verified, verified: false }; assert.equal((await extract()).code, 'vision_evidence_unverified');
    f.state.verdict = verified; await extract(); f.next({ scrollX: 400 });
    assert.equal((await extract({ atStart: false })).code, 'vision_source_geometry_changed');
  });

  test(`${name}: literal find never implies hidden text or whole-page absence`, async () => {
    const f = fixture(Session);
    const result = await f.session.execute('find_text', { frameId: f.state.current.frameId, text: 'ALICE', matches: [{ text: 'Alice', rect: box() }] });
    assert.equal(result.success, true); assert.equal(result.wholePageSearched, false); assert.equal(result.selectionChanged, false);
    const mismatch = await f.session.execute('find_text', { frameId: f.state.current.frameId, text: 'ALICE', matchCase: true, matches: [{ text: 'Alice', rect: box() }] });
    assert.equal(mismatch.code, 'vision_text_mismatch');
    const invalid = await f.session.execute('find_text', { frameId: f.state.current.frameId, text: 'Alice', matches: [{ text: 'Alice', rect: box(900) }] });
    assert.equal(invalid.code, 'vision_invalid_evidence');
  });

  test(`${name}: form staged values do not prove submission; later same-site redirect requires explicit evidence`, async () => {
    const f = fixture(Session);
    const form = (phase, extra = {}) => f.session.execute('verify_form', { frameId: f.state.current.frameId, phase,
      fields: [{ label: 'Name', expected: 'Alice', observed: 'Alice', rect: box(200) }], errors: [], ...extra });
    const staged = await form('values'); assert.equal(staged.staged, true); assert.equal(staged.completionVerified, false);
    assert.equal((await form('submission', { completion: { text: 'Saved', rect: box(300) } })).code, 'vision_form_baseline_missing');
    f.next({ url: 'https://messages.test/success', documentId: 'redirected' });
    f.state.verdict = { ...verified, completionVerified: false };
    assert.equal((await form('submission', { completion: { text: 'Saved', rect: box(300) } })).success, false);
    f.state.verdict = verified;
    assert.equal((await form('submission', { completion: { text: 'Saved', rect: box(300) } })).completionVerified, true);
    await form('values', { fields: [{ label: 'Name', expected: 'Alice', observed: 'Bob', rect: box(200) }] }); f.next();
    assert.equal((await form('submission', { completion: { text: 'Saved', rect: box(300) } })).code, 'vision_form_baseline_missing');
  });

  test(`${name}: reviewed research stays bounded and every retained row is retrievable without re-review`, async () => {
    const f = fixture(Session);
    const saved = await f.session.execute('extract_data', { frameId: f.state.current.frameId, type: 'table',
      columns: ['Name'], rows: Array.from({ length: 45 }, (_, index) => ({ values: [`Item ${index}`], rect: box(index * 10) })), atStart: true, atEnd: true });
    assert.equal(saved.totalRows, 45); assert.equal(saved.rows.length, 40); assert.equal(saved.nextOffset, 40); assert.equal(saved.hasMore, true);
    const reviews = f.state.reviews.length;
    const remaining = await f.session.execute('extract_data', { frameId: f.state.current.frameId, operation: 'read', sourceId: saved.sourceId, offset: 40, limit: 80 });
    assert.equal(remaining.rows.length, 5); assert.equal(remaining.nextOffset, null); assert.equal(remaining.hasMore, false);
    assert.equal(remaining.rows[0].values[0], 'Item 40'); assert.equal(f.state.reviews.length, reviews);
    assert.ok(JSON.stringify(saved).length < 12000); assert.ok(JSON.stringify(remaining).length < 12000);
  });
}

test('independent reviewer accepts only one closed verdict and attaches provenance itself', async () => {
  const request = async factory => { const messages = factory(); assert.match(messages[1].content, /TRUSTED_USER_TASK/);
    return { toolCalls: [{ function: { name: 'vision_review', arguments: JSON.stringify({ verified: true, allowed: true, reason: 'Actual visible evidence', recipientMatches: true }) } }] }; };
  const args = { request, observation: () => ({ role: 'user', content: 'Current screenshot fixture' }), task: 'Reply to Alice', kind: 'chat_observe', frame: { frameId: '1' }, claims: {} };
  const good = await reviewVisionEvidence(args);
  assert.equal(good.provenance, 'independent_visual_review'); assert.equal(good.recipientMatches, true); assert.equal(good.composerMatches, false);
  for (const toolCalls of [[], [{ function: { name: 'vision_review', arguments: '{' } }], [{ function: { name: 'vision_review', arguments: JSON.stringify({ verified: true, allowed: true, reason: 'x', unsafe: true }) } }]])
    assert.equal((await reviewVisionEvidence({ ...args, request: async () => ({ toolCalls }) })).verified, false);
});
