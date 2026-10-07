import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/compose', title: 'Compose' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
const tabId = 41;
const scope = { documentToken: 'document-1', pageUrl: 'https://example.com/compose' };
const args = { ref_id: 'ref_original_editor', text: 'Requested replacement', clear: true, submit: false };
const digest = value => ({
  success: true,
  valueLength: value.length,
  valueSha256: createHash('sha256').update(value).digest('hex'),
  documentToken: scope.documentToken,
  refScopeUrl: scope.pageUrl,
  fieldMeta: { tag: 'div', contentEditable: true, role: 'textbox', ariaLabel: 'Post text' },
});
const unchanged = digest('Existing draft');

async function scenario({ before = unchanged, after = unchanged, failure = 'reselect', tool = 'set_field', inputArgs = args, actualRoute = false } = {}, check) {
  const originalAttach = cdpClient.attach;
  const originalCommand = cdpClient.sendCommand;
  const originalMessage = api.tabs.sendMessage;
  const agent = new Agent({});
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._currentUrl = async () => scope.pageUrl;
  agent._isPdfTab = async () => false;
  agent._chromeProtectedPageFailure = async () => null;
  agent._richTextToolbarToolBlock = async () => null;
  agent._lastAxScopes.set(tabId, scope);
  agent._liveTextMutationScope = async () => scope;
  const calls = [];
  let preparations = 0;
  let digests = 0;
  const contentResponse = () => ({
    success: false, verified: false, dispatched: false, noDispatch: true,
    trustedTypeRequired: true, fieldMeta: unchanged.fieldMeta,
    _expectedValue: tool === 'type_ax' && inputArgs.clear !== true ? `Existing draft${inputArgs.text}` : inputArgs.text,
    error: 'Contenteditable fields require trusted browser typing.',
  });
  api.tabs.sendMessage = async (_id, message) => {
    calls.push({ action: message.action, params: message.params });
    if (message.action === tool) return contentResponse();
    if (message.action === 'field_value_digest') {
      digests++;
      const result = digests === 1 ? before : after;
      if (result instanceof Error) throw result;
      return result && { ...result };
    }
    if (message.action === 'ax_prepare_field_for_trusted_type') {
      preparations++;
      if (failure === 'first-prepare' || (failure === 'reselect' && preparations === 2)) {
        return { success: false, dispatched: false, noDispatch: true, pageFeedbackPending: true,
          error: 'Browser changed during action preparation. Re-observe before acting.' };
      }
      if (failure === 'thrown-reselect' && preparations === 2) {
        throw Object.assign(new Error('Browser changed during action preparation'), { code: 'page_feedback_pending' });
      }
      return { success: true, contentEditable: true, rect: { x: 10, y: 20, w: 300, h: 80 } };
    }
    if (message.action === 'ax_verify_field_value') {
      return { success: true, verified: failure !== 'verification', fieldMeta: unchanged.fieldMeta };
    }
    throw new Error(`Unexpected message ${message.action}`);
  };
  cdpClient.attach = async () => ({});
  cdpClient.sendCommand = async (_id, method, params) => {
    calls.push({ method, params });
    if ((failure === 'insert' && method === 'Input.insertText')
        || (failure === 'delete' && method === 'Input.dispatchKeyEvent' && params.key === 'Delete')) {
      throw new Error('Input command response lost');
    }
    return {};
  };
  try {
    const raw = actualRoute ? null : await agent._maybeFallbackFieldWithCdp(tabId, tool, inputArgs, contentResponse());
    // Result enrichment/normalization may spread the result before finalizing.
    // The internal attestation must survive that without becoming serializable.
    if (!actualRoute) agent._executeToolImpl = async () => agent._withCoordinateReconciliation(raw, { clickPath: 'semantic' });
    const dispatchState = { started: false };
    const result = await agent.executeTool(tabId, tool, inputArgs, null, { _contentActionDispatchState: dispatchState });
    await check({ agent, raw: raw || dispatchState.rawToolResult, result, calls, preparations, digests, dispatchState });
  } finally {
    cdpClient.attach = originalAttach;
    cdpClient.sendCommand = originalCommand;
    api.tabs.sendMessage = originalMessage;
  }
}

test('Chrome: complete executeTool route preserves focus dispatch and requires a fresh completion observation without false text debt', async () => {
  await scenario({ actualRoute: true }, async ({ agent, raw, result, calls, dispatchState }) => {
    assert.equal(calls.filter(call => call.action === 'set_field').length, 1, 'Use the actual content-script route');
    assert.equal(result.textUnchanged, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.noDispatch, false);
    assert.equal(result.verified, false);
    assert.equal(result.pageFeedbackPending, true);
    assert.equal(result.recoveryRequired, 'fresh_tree');
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    assert.equal(dispatchState.started, true, 'Keep generic browser-dispatch accounting');
    assert.equal(Object.getOwnPropertySymbols(raw).length, 1);
    assert.equal(Object.getOwnPropertySymbols(result).length, 0);
    agent._beginCompletionInvariant(tabId);
    const normalized = agent._normalizeToolResult('set_field', result);
    const completion = agent._recordCompletionToolResult(tabId, 'set_field', args, normalized);
    assert.equal(completion.hadAction, true);
    assert.equal(completion.verificationDebt, true, 'A failed typing action cannot claim completion');
    assert.equal(completion.lastAction.uncertain, true);
    const observed = agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, { success: true, pageContent: 'Current editor is empty' });
    assert.equal(observed.verificationDebt, false, 'A fresh observation handles the focus action normally');
    assert.equal(await agent._uncertainTextMutationBlock(tabId, 'set_field', args), null);
  });
});

for (const [tool, inputArgs] of [
  ['set_field', args],
  ['type_ax', { ...args, clear: false, text: ' appended text' }],
]) {
  test(`Chrome: ${tool} interrupted focus with exact unchanged readback creates no text debt`, async () => {
    await scenario({ tool, inputArgs }, async ({ agent, raw, result, calls, digests }) => {
      assert.equal(result.success, false);
      assert.equal(result.verified, false, 'The requested text has not landed');
      assert.equal(result.dispatched, true, 'The focus click was dispatched');
      assert.equal(result.noDispatch, false);
      assert.equal(result.textUnchanged, true);
      assert.equal(result.outcomeUnknown, false);
      assert.equal(result.mutationMayHaveOccurred, false);
      assert.equal(result.pageFeedbackPending, true);
      assert.equal(result.recoveryRequired, 'fresh_tree');
      assert.equal(result.retryable, true);
      assert.equal(agent._uncertainTextMutations.has(tabId), false);
      assert.equal(digests, 2);
      assert.ok(calls.filter(call => call.action === 'field_value_digest').every(call => call.params.ref_id === args.ref_id));
      assert.equal(calls.some(call => call.method === 'Input.insertText' || call.method === 'Input.dispatchKeyEvent'), false);
      assert.equal(Object.getOwnPropertySymbols(raw).length, 1);
      assert.equal(Object.getOwnPropertySymbols(result).length, 0, 'Finalization consumes the private attestation');
      assert.match(result.error, /Re-observe the page/);
      let nextWrites = 0;
      agent._executeToolImpl = async () => { nextWrites++; return { success: true, dispatched: true, verified: true }; };
      const next = await agent.executeTool(tabId, 'set_field', { ...args, text: 'Fresh decision replacement' });
      assert.equal(next.success, true, 'A normal later decision must not hit false text debt');
      assert.equal(nextWrites, 1);
    });
  });
}

for (const [label, options] of [
  ['same-length field change', { after: digest('Different text') }],
  ['length change', { after: digest('Changed') }],
  ['missing before readback', { before: null }],
  ['missing after readback', { after: null }],
  ['unavailable after readback', { after: new Error('Page did not answer') }],
  ['stale AX ref', { after: { success: false, error: 'field is stale or unavailable', documentToken: scope.documentToken } }],
  ['changed document', { after: { ...unchanged, documentToken: 'document-2' } }],
  ['missing before document identity', { before: { ...unchanged, documentToken: '' } }],
  ['missing after document identity', { after: { ...unchanged, documentToken: '' } }],
  ['changed route', { after: { ...unchanged, refScopeUrl: 'https://example.com/other' } }],
  ['invalid digest', { after: { ...unchanged, valueSha256: 'not-a-sha256' } }],
]) {
  test(`Chrome: interrupted focus preserves text debt for ${label}`, async () => {
    await scenario(options, async ({ agent, result, calls }) => {
      assert.equal(result.success, false);
      assert.equal(result.dispatched, true);
      assert.equal(result.verified, false);
      assert.equal(result.outcomeUnknown, true);
      assert.equal(result.mutationMayHaveOccurred, true);
      assert.equal(result.repeatBlocked, true);
      assert.equal(result.recoveryRequired, 'verify_or_restore_field');
      assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
      assert.equal(calls.some(call => call.method === 'Input.insertText'), false);
    });
  });
}

test('Chrome: thrown monitor interruption can prove unchanged focus preparation', async () => {
  await scenario({ failure: 'thrown-reselect' }, async ({ agent, result }) => {
    assert.equal(result.textUnchanged, true);
    assert.equal(result.pageFeedbackPending, true);
    assert.equal(result.recoveryRequired, 'fresh_tree');
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
  });
});

test('Chrome: interruption before the focus click keeps the existing no-dispatch proof', async () => {
  await scenario({ failure: 'first-prepare' }, async ({ agent, result, calls }) => {
    assert.equal(result.dispatched, false);
    assert.equal(result.noDispatch, true);
    assert.equal(result.pageFeedbackPending, true);
    assert.equal(result.recoveryRequired, 'fresh_tree');
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    assert.equal(calls.some(call => call.method), false);
  });
});

for (const [label, options] of [
  ['insertText response lost', { failure: 'insert' }],
  ['Delete response lost', { failure: 'delete', inputArgs: { ...args, text: '' } }],
  ['post-input verification mismatch', { failure: 'verification' }],
]) {
  test(`Chrome: ${label} stays uncertain even when the editor digest is unchanged`, async () => {
    await scenario(options, async ({ agent, result, calls, digests }) => {
      assert.equal(result.outcomeUnknown, true);
      assert.equal(result.mutationMayHaveOccurred, true);
      assert.equal(result.repeatBlocked, true);
      assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
      assert.equal(digests, 1, 'After any text command attempt, no unchanged-readback escape is evaluated');
      assert.equal(calls.filter(call => call.method === 'Input.insertText'
        || (call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Delete')).length, 1);
      assert.equal(calls.some(call => call.params?.key === 'Enter'), false);
    });
  });
}

test('Chrome: page-supplied unchanged-text fields cannot forge the private debt exemption', async () => {
  const agent = new Agent({});
  agent._lastAxScopes.set(tabId, scope);
  agent._liveTextMutationScope = async () => scope;
  const result = await agent._finalizeTextMutationResult(tabId, 'set_field', args, {
    success: false, verified: false, dispatched: true, noDispatch: false,
    textUnchanged: true, trustedFieldPreparationUnchanged: true,
    [Symbol('trustedFieldPreparationUnchanged')]: { tabId, tool: 'set_field', refId: args.ref_id },
  });
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.repeatBlocked, true);
  assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
});

test('Chrome: successful trusted typing retains exact verification and types once', async () => {
  await scenario({ failure: 'none' }, async ({ agent, result, calls }) => {
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.equal(result.trustedFallback, true);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    assert.equal(calls.filter(call => call.method === 'Input.insertText').length, 1);
  });
});
