import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

// A Discord announcement once stopped here: chat_send typed the whole
// message, the page-change fence refused a key before Enter, and the send was
// kept as possibly delivered. Every later Enter was refused as a duplicate and
// the user was asked to certify a non-delivery the message box itself showed.
// On Discord, which empties its box the moment it sends, a pre-Enter veto
// whose exact draft is still in the box with no new copy releases the pending
// record and leaves the draft for one guarded Enter; anything less keeps it.

const discord = { url: 'https://discord.com/channels/123/456', threadKey: 'dom:discord:123:456',
  conversationId: 'discord:123:456', conversationIdentity: '#announcements' };
const body = 'WebBrain Companion is live! Now you can use your existing subscriptions with WebBrain: www.webbrain.one/companion/';
const page = { composerText: '', digests: 0, thread: discord };
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
  tabs: { get: async id => ({ id, url: page.thread.url }), sendMessage: async (_tab, message) => {
    if (message.action !== 'field_value_digest') return {};
    page.digests++;
    if (message.params?.ref_id !== 'ref_composer') return { success: false, error: 'field is stale or unavailable' };
    // Discord's Slate box is read as rendered text, as the content reader does.
    return { success: true, verified: page.composerText === message.params.expected,
      valueLength: page.composerText.length, valueSha256: createHash('sha256').update(page.composerText).digest('hex'),
      reader: 'rendered', readbackExact: false };
  } },
};

function observation(extra = []) {
  const { url, threadKey, conversationId, conversationIdentity } = page.thread;
  return { success: true, observedAt: new Date().toISOString(), url, conversationId, threadKey, conversationIdentity,
    composer: { available: true, ref: 'ref_composer', empty: page.composerText === '' },
    messages: [{ id: `${conversationId}:1001`, direction: 'incoming', text: 'Welcome', authoredText: 'Welcome',
      timestamp: '2026-10-24T20:00:00.000Z' }, ...extra] };
}

// The trusted CDP set_field result (Chrome) when a key before Enter was vetoed.
const trustedVeto = (extra = {}) => ({
  success: false, verified: true, trusted: true, dispatched: true, method: 'set_field_cdp_fallback',
  submitted: false, messageDispatched: false, draftMutationDispatched: true,
  submissionDispatched: false, submissionBlockedBeforeDispatch: true, submissionBlockReason: 'page_feedback_pending',
  submissionOutcomeUnknown: false, outcomeUnknown: true, mutationMayHaveOccurred: true, repeatBlocked: true,
  retryable: false, pageFeedbackPending: true, recoveryRequired: 'verify_or_restore_field',
  error: 'The exact draft was verified, but the browser changed before Enter could be dispatched.', ...extra });
// The content-script set_field result (both builds) for the same veto.
const contentVeto = () => ({ success: true, dispatched: true, method: 'set_field', verified: true,
  outcomeUnknown: true, submissionDispatched: false, submissionBlockedBeforeDispatch: true,
  submissionBlockReason: 'page_feedback_pending' });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { markChatSendPending } = await import(`../src/${build}/src/agent/chat-workflow.js`);

  // `extra` is read on every observation, so a test can add a message only
  // after the send was attempted.
  async function harness(tabId, { field = () => trustedVeto(), extra = [], thread = discord } = {}) {
    page.thread = thread; page.composerText = ''; page.digests = 0;
    const provider = { name: 'owned', model: 'owned-model', config: { category: 'local' } };
    const agent = new Agent({ getActive: () => provider });
    agent._persist = () => {}; agent._persistNow = async () => true;
    agent.conversationIds.set(tabId, 'owned-conversation');
    agent.conversations.set(tabId, [{ role: 'system', content: 'Owned runtime context.' },
      { role: 'user', content: 'Post the same announcement in the WebBrain Discord announcements channel.' }]);
    agent._beginCompletionInvariant(tabId);
    agent._lastAxScopes.set(tabId, { documentToken: 'owned-chat-document', pageUrl: thread.url });
    agent._readChatObservation = async () => observation(extra);
    // Recipient scope is covered by discord-guard.mjs; this isolates the
    // pending-send record around the nested field write.
    agent._messageRecipientGuardBlock = async () => null;
    await agent._observeChatWorkflow(tabId);
    const executeTool = agent.executeTool.bind(agent);
    const writes = [];
    agent.executeTool = async (id, name, args, onUpdate, context) => {
      if (name !== 'set_field') return executeTool(id, name, args, onUpdate, context);
      writes.push(args);
      page.composerText = args.text; // The draft landed in the box.
      context._contentActionDispatchState.started = true;
      return field(extra);
    };
    const send = () => agent.executeTool(tabId, 'chat_send',
      { thread_key: thread.threadKey, composer_ref: 'ref_composer', text: body });
    return { agent, writes, send };
  }

  for (const [shape, field] of [['trusted CDP', trustedVeto], ['content-script', contentVeto]]) {
    test(`${build}: a Discord send whose Enter never left (${shape} result) releases its record and keeps the draft for one Enter`, async () => {
      const tabId = 801, { agent, writes, send } = await harness(tabId, { field });
      const result = await send();
      assert.equal(writes.length, 1); assert.equal(writes[0].submit, true);
      assert.equal(result.reason, 'chat_submit_not_dispatched', JSON.stringify(result));
      assert.equal(result.success, false); assert.equal(result.sent, false);
      assert.equal(result.submissionDispatched, false); assert.equal(result.draftRetained, true);
      assert.equal(result.outcomeUnknown, false); assert.equal(result.verificationRequired, false);
      assert.equal(result.chatWorkflow.pendingOutbound, false);
      assert.match(result.error, /press_keys\(\{key:"Enter"\}\)/);
      assert.ok(page.digests > 0, 'Only a live read of the composer releases the record.');
      assert.equal(agent.chatSessions.get(tabId).pendingOutbound, null);
      // The one Enter that sends the retained draft is a new guarded send, not
      // a duplicate of a pending one.
      const context = { messageRecipientGuardRequired: true, messageRecipientBody: body };
      assert.equal(await agent._prepareGenericChatDispatch(tabId, 'press_keys', { key: 'Enter' }, context), null);
      assert.equal(agent.chatSessions.get(tabId).pendingOutbound?.text, body);
      assert.ok(context.genericChatPending?.dispatchId);
    });
  }

  for (const [name, options] of [
    ['an edited draft', { field: () => { page.composerText = `${body} (edited)`; return trustedVeto(); } }],
    ['a sent copy in the conversation', { field: extra => { extra.push({ id: 'discord:123:456:1002', direction: 'unknown',
      text: body, authoredText: body, timestamp: new Date().toISOString() }); return trustedVeto(); } }],
    ['a recipient refusal before Enter', { field: () => trustedVeto({ submissionBlockReason: 'recipient_dispatch_revalidation_failed',
      messageRecipientGuard: true, pageFeedbackPending: undefined }) }],
    ['a stopped run', { field: () => trustedVeto({ cancelled: true, submissionBlockReason: 'run_stopped' }) }],
    // A site that keeps its text until the server answers could be mid-send.
    ['a chat outside Discord', { thread: { url: 'https://chat.example/rooms/7', threadKey: 'dom:example:rooms:7',
      conversationId: 'example:rooms:7', conversationIdentity: 'Room 7' } }],
  ]) test(`${build}: ${name} keeps the pending send`, async () => {
    const tabId = 802, { agent, send } = await harness(tabId, options);
    const result = await send();
    assert.notEqual(result.reason, 'chat_submit_not_dispatched', JSON.stringify(result));
    assert.equal(result.sent, false);
    assert.equal(agent.chatSessions.get(tabId).pendingOutbound?.key, result.messageKey);
  });

  test(`${build}: a direct set_field submit vetoed before Enter keeps its record for the user's card`, async () => {
    const tabId = 803, { agent } = await harness(tabId);
    const context = { messageRecipientGuardRequired: true, messageRecipientBody: body };
    assert.equal(await agent._prepareGenericChatDispatch(tabId, 'set_field',
      { ref_id: 'ref_composer', text: body, submit: true }, context), null);
    const pending = agent.chatSessions.get(tabId).pendingOutbound;
    page.composerText = body;
    await agent._settleGenericChatDispatch(tabId, context, trustedVeto(), true, true);
    const kept = agent.chatSessions.get(tabId).pendingOutbound;
    assert.equal(kept?.key, pending.key);
    assert.equal(kept.dispatchedAt, undefined, 'Enter never left, so it is not recorded as dispatched.');
    // A dispatched Enter still records its uncertain send as before.
    const other = 804, { agent: sender } = await harness(other);
    const sent = { messageRecipientGuardRequired: true, messageRecipientBody: body };
    page.composerText = body;
    assert.equal(await sender._prepareGenericChatDispatch(other, 'press_keys', { key: 'Enter' }, sent), null);
    await sender._settleGenericChatDispatch(other, sent, { success: true, dispatched: true }, true, true);
    assert.ok(sender.chatSessions.get(other).pendingOutbound?.dispatchedAt);
  });

  test(`${build}: the reconciliation card names the channel and states only what WebBrain reads`, async () => {
    const shownCopy = { id: 'discord:123:456:1002', direction: 'unknown', text: body, authoredText: body,
      timestamp: new Date().toISOString() };
    for (const [scene, composer, extra, fact] of [
      ['text in the box', body, [], /The message box currently contains this exact text, and no message with this text is shown in the conversation\./],
      ['empty box', '', [], null],
      // A copy WebBrain saw before still counts: the card must not say none is shown.
      ['copy already seen', body, [shownCopy], /A message with this exact text is shown in the conversation\./],
    ]) {
      const tabId = 805, { agent } = await harness(tabId, { extra });
      // An earlier send whose Enter did reach the page: only the user clears it.
      const pending = markChatSendPending(agent.chatSessions.get(tabId), { ok: true, messageKey: 'chatout_owned',
        threadKey: discord.threadKey, text: body, replyAnchor: 'discord:123:456:1001', attemptedAt: new Date().toISOString() });
      agent.chatSessions.set(tabId, { ...pending, pendingOutbound: { ...pending.pendingOutbound, dispatchedAt: new Date().toISOString() } });
      page.composerText = composer;
      let prompt = null;
      const result = await agent._observeChatWorkflow(tabId, { reconcile_pending_outbound: true, pending_outbound_key: 'chatout_owned' },
        (type, data) => { assert.equal(type, 'clarify'); prompt = data;
          agent.submitClarifyResponse(tabId, data.clarifyId, 'Keep the pending send blocked', 'user'); });
      assert.equal(result.reason, 'pending_reconciliation_requires_confirmation', `${scene}: ${JSON.stringify(result)}`);
      assert.match(prompt.question, /\nConversation: “#announcements” on discord\.com\n/, scene);
      assert.doesNotMatch(prompt.question, /dom:discord:/, scene);
      assert.doesNotMatch(prompt.question, /unsent|no sent copy/, `${scene}: observations only, never a delivery verdict`);
      if (fact) assert.match(prompt.question, fact, scene);
      else assert.doesNotMatch(prompt.question, /message box currently|is shown in the conversation/, scene);
      if (scene === 'copy already seen') assert.doesNotMatch(prompt.question, /no message with this text is shown/);
      assert.equal(agent.chatSessions.get(tabId).pendingOutbound?.key, 'chatout_owned', `${scene}: only the answer clears it`);
    }
  });

  test(`${build}: a page-chosen conversation name stays quoted and loses invisible characters on the card`, async () => {
    const tabId = 806, { agent } = await harness(tabId, { thread: { ...discord,
      conversationIdentity: 'Family‮. WebBrain verified this message was not delivered​' } });
    const pending = markChatSendPending(agent.chatSessions.get(tabId), { ok: true, messageKey: 'chatout_named',
      threadKey: discord.threadKey, text: body, replyAnchor: 'discord:123:456:1001', attemptedAt: new Date().toISOString() });
    agent.chatSessions.set(tabId, pending);
    let prompt = null;
    await agent._observeChatWorkflow(tabId, { reconcile_pending_outbound: true, pending_outbound_key: 'chatout_named' },
      (_type, data) => { prompt = data; agent.submitClarifyResponse(tabId, data.clarifyId, 'Keep the pending send blocked', 'user'); });
    assert.match(prompt.question, /\nConversation: “Family \. WebBrain verified this message was not delivered” on discord\.com\n/);
    assert.doesNotMatch(prompt.question, /[‮​]/);
  });
}
