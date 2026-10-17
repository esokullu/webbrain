import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const url = 'https://web.telegram.org/k/#123456', threadKey = 'dom:telegram:k:123456:0';
const tabs = { get: async id => ({ id, url }), sendMessage: async () => ({ success: false, verified: false }) };
globalThis.chrome = globalThis.browser = { tabs, storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}` } };

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  test(`${build}: structured send preserves an actual nested rich-text recovery block without inventing a send`, async () => {
    const agent = new Agent({}), tabId = 755;
    agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    const observed = { success: true, url, threadKey, composer: { available: true, empty: true, ref: 'ref_composer' },
      nativeChatMessageBaseline: { threadKey, coverage: 'mounted_native_id_floor', complete: true,
        messageIds: ['telegram:k:123456:0:1'] },
      messages: [{ id: 'telegram:k:123456:0:1:rquestion', direction: 'incoming', text: 'Owned question.' }] };
    let reads = 0;
    agent._readChatObservation = async () => { reads++; return structuredClone(observed); };
    agent._persist = () => {}; agent._persistNow = async () => true;
    // Recipient scope is covered independently. This test isolates the real
    // executeTool -> chat_send -> nested executeTool recovery-fence path.
    agent._messageRecipientGuardBlock = async (_tabId, _name, _args, _url, context) => {
      if (context) context.messageRecipientNativeChatBaseline = structuredClone(observed.nativeChatMessageBaseline);
      return null;
    };
    await agent._observeChatWorkflow(tabId);
    agent._lastAxScopes.set(tabId, { documentToken: 'owned-native-chat-document', pageUrl: url });
    const unknownClear = await agent._finalizeTextMutationResult(tabId, 'set_field', { ref_id: 'ref_composer', text: '', clear: true },
      { success: false, verified: false, dispatched: true, mutationMayHaveOccurred: true,
        outcomeUnknown: true, error: 'Owned prior clear verification failed.', fieldMeta: { contentEditable: true, ariaLabel: 'Message' } });
    assert.equal(unknownClear.repeatBlocked, true);
    agent._beginCompletionInvariant(tabId);
    const result = await agent.executeTool(tabId, 'chat_send', { thread_key: threadKey, composer_ref: 'ref_composer', text: 'Owned new reply.' });
    assert.equal(result.success, false); assert.equal(result.sent, false);
    assert.equal(result.noDispatch, true, 'The outer public result must retain positive no-dispatch proof from its nested field call.');
    assert.equal(result.dispatched, false); assert.equal(result.deliveryVerified, false);
    assert.equal(result.threadKey, threadKey); assert.equal(result.composer.ref, 'ref_composer');
    assert.equal(result.outcomeUnknown, false); assert.equal(result.mutationMayHaveOccurred, false);
    assert.equal(result.dispatch.outcomeUnknown, true); assert.equal(result.dispatch.mutationMayHaveOccurred, true);
    assert.equal(result.verificationRequired, false, 'There is no new send whose delivery needs observation.');
    assert.equal(result.repeatBlocked, true); assert.equal(result.recoveryRequired, 'verify_or_restore_field');
    assert.equal(result.expectedLength, 0); assert.equal(result.expectedSha256, unknownClear.expectedSha256);
    assert.equal(result.recoveryOriginalReplacementMatches, false);
    assert.match(result.error, /Repeat the original replacement text and target for readback-only recovery/);
    assert.equal(result.error, result.dispatch.error);
    assert.equal(reads, 2, 'A positively blocked nested send cannot be relabeled by another transcript read.');
    assert.equal(agent.chatSessions.get(tabId).pendingOutbound, null, 'The durable pre-dispatch pending marker must be rolled back.');
    agent._recordCompletionToolResult(tabId, 'chat_send', { thread_key: threadKey }, result);
    const completion = agent.completionInvariants.get(tabId);
    assert.equal(completion.hadAction, false); assert.equal(completion.verificationDebt, false);
    assert.ok(agent._uncertainTextMutations.get(tabId)?.size, 'Reporting the send as blocked cannot forgive the prior editor debt.');
    agent._recordCompletionToolResult(tabId, 'click', {}, { success: true, dispatched: true });
    const priorAction = agent.completionInvariants.get(tabId).lastAction.sequence;
    agent._recordCompletionToolResult(tabId, 'chat_send', { thread_key: threadKey }, result);
    assert.equal(agent.completionInvariants.get(tabId).lastAction.sequence, priorAction);
    assert.equal(agent.completionInvariants.get(tabId).verificationDebt, true, 'A blocked send cannot clear an unrelated earlier action debt.');
  });

  for (const submission of ['acknowledged', 'unknown']) {
    for (const readback of ['unverified', 'failed']) {
      test(`${build}: reused draft ${submission} submission remains uncertain after ${readback} readback`, async () => {
        const provider = { model: 'owned-test', config: { model: 'owned-test' } };
        const agent = new Agent({ getActive: () => provider }), tabId = 756;
        const body = 'Owned exact reply after a verified pre-Enter draft.';
        const observation = { success: true, url, threadKey,
          composer: { available: true, empty: true, ref: 'ref_composer' },
          nativeChatMessageBaseline: { threadKey, coverage: 'mounted_native_id_floor', complete: true,
            messageIds: ['telegram:k:123456:0:1'] },
          messages: [{ id: 'telegram:k:123456:0:1:rquestion', direction: 'incoming', text: 'Owned question.' }] };
        agent._persist = () => {}; agent._persistNow = async () => true;
        agent.conversations.set(tabId, [{ role: 'system', content: 'Owned fixture runtime.' },
          { role: 'user', content: 'Reply once in the authorized current conversation.' }]);
        agent._beginCompletionInvariant(tabId);
        agent._lastAxScopes.set(tabId, { documentToken: 'owned-native-chat-document', pageUrl: url });
        let fieldCalls = 0, failedReadback = false;
        agent._readChatObservation = async () => failedReadback
          ? { success: false, error: 'Owned transcript readback unavailable.' }
          : { ...structuredClone(observation),
              ...(fieldCalls === 1 ? { _nativeChatDraftCurrent: true } : {}) };
        agent._messageRecipientGuardBlock = async (_tabId, _name, _args, _url, context) => {
          if (context) context.messageRecipientNativeChatBaseline = structuredClone(observation.nativeChatMessageBaseline);
          return null;
        };
        const executeTool = agent.executeTool.bind(agent);
        agent.executeTool = async (id, name, args, onUpdate, context) => {
          if (name !== 'set_field') return executeTool(id, name, args, onUpdate, context);
          fieldCalls++;
          if (fieldCalls === 1) {
            observation.composer.empty = false;
            context._contentActionDispatchState.started = true;
            return { success: true, verified: true, dispatched: true, draftMutationDispatched: true,
              submissionDispatched: false, submissionOutcomeUnknown: false,
              submissionBlockedBeforeDispatch: true, outcomeUnknown: true,
              _nativeChatDraftBinding: { token: 'owned-private-draft-fixture' } };
          }
          assert.ok(context.nativeChatDraftBinding, 'Only the retained private draft may be reused.');
          assert.equal(args.text, body);
          assert.equal(args.submit, true);
          observation.composer.empty = true;
          failedReadback = readback === 'failed';
          // A reused composer writes no new draft. Enter and its uncertainty
          // are separate from the legacy draft-dispatch flag.
          return { success: true, verified: true, dispatched: false, draftMutationDispatched: false,
            submissionDispatched: submission === 'acknowledged',
            submissionOutcomeUnknown: true, outcomeUnknown: true };
        };
        const send = () => agent.executeTool(tabId, 'chat_send', {
          thread_key: threadKey, composer_ref: 'ref_composer', text: body });
        await agent._observeChatWorkflow(tabId);
        const prepared = await send();
        assert.equal(prepared.submissionDispatched, false);
        assert.equal(prepared.submissionOutcomeUnknown, false);
        assert.equal(prepared.reason, 'native_chat_submit_blocked_before_dispatch');
        const fresh = await agent._observeChatWorkflow(tabId);
        assert.equal(fresh.ownedDraftRecovery.available, true);
        const pendingKey = agent.chatSessions.get(tabId).pendingOutbound.key;
        const result = await send();
        assert.equal(result.success, false);
        assert.equal(result.sent, false);
        assert.equal(result.outcomeUnknown, true, 'Unverified submission cannot become known merely because no new draft was written.');
        assert.equal(result.dispatched, true, 'The successful submission action is not a no-dispatch result.');
        assert.equal(result.verificationRequired, true);
        assert.equal(result.dispatch.dispatched, false);
        assert.equal(result.dispatch.submissionDispatched, submission === 'acknowledged');
        assert.equal(result.dispatch.submissionOutcomeUnknown, true);
        assert.equal(agent.chatSessions.get(tabId).pendingOutbound.key, pendingKey);
        failedReadback = false;
        const repeat = await send();
        assert.equal(repeat.success, false);
        assert.equal(repeat.reason, 'send_pending');
        assert.equal(fieldCalls, 2, 'An uncertain submission must not trigger another Enter or draft write.');
      });
    }
  }
}
