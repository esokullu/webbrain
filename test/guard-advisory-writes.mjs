// Text-write verification chain under the guard policy (guard-policy.js):
// by default a write whose text went out but could not be read back exactly
// is an unverified success with a note, locks nothing and is not a loop
// failure; Settings → "Strict checks" (agent.strictGuards) keeps today's
// debt, lock and failure accounting. GitHub's CodeMirror editor is the real
// case: its innerText readback doubles blank lines, so every correct write
// used to "fail", repeats were refused and the loop detector stopped the run.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const storage = new Map();
const area = {
  async get(key) { return typeof key === 'string' ? { [key]: storage.get(key) } : Object.fromEntries(storage); },
  async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value)); },
  async remove(key) { storage.delete(key); },
};
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: scopeUrl(), title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  batch: await import(`../src/${build}/src/agent/browser-batch.js`),
})));
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
const { FirefoxBidiClient } = await import('../src/firefox/src/bidi/client.js');

const tabId = 51;
const scope = { documentToken: 'document-1', pageUrl: 'https://github.com/example/repo/edit/main/README.md' };
function scopeUrl() { return scope.pageUrl; }
const editorKey = `ax:${scope.documentToken}:ref_editor`;
const sha = text => createHash('sha256').update(text).digest('hex');
const editorMeta = { tag: 'div', contentEditable: true, codeMirror: true, ariaLabel: 'Editing README.md file contents' };
const fileText = 'line one\n\nline three\n';
// CodeMirror's innerText: every blank line reads back twice.
const renderedText = 'line one\n\n\nline three\n';
const args = { ref_id: 'ref_editor', text: fileText };
// What the content script reports when its innerText fallback cannot
// confirm a contenteditable write (content.js _insertContentEditableText).
const renderedMismatch = (extra = {}) => ({
  success: false, verified: false, dispatched: true, mutationMayHaveOccurred: true, outcomeUnknown: true,
  retryable: false, error: 'The complete settled rich-text value could not be verified exactly.',
  unverified: { reason: 'readback_mismatch', reader: 'rendered' }, readbackExact: false,
  ref_id: 'ref_editor', fieldMeta: editorMeta, ...extra,
});
const scopeReply = () => ({ documentToken: scope.documentToken, refScopeUrl: scope.pageUrl });
const advisoryOf = (result, guard) => (result.guardAdvisories || []).find(item => item.guard === guard);

function setup(Agent, { write = () => renderedMismatch(), content = null } = {}) {
  const provider = { name: 'local test', model: 'test', promptTier: 'full', contextWindow: 128000, supportsTools: true };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._currentUrl = async () => scope.pageUrl;
  agent._isPdfTab = async () => false;
  agent._lastAxScopes.set(tabId, { ...scope });
  agent._chromeProtectedPageFailure = async () => null;
  agent._richTextToolbarToolBlock = async () => null;
  agent._injectCoreContentScripts = async () => {};
  agent.testWrites = [];
  agent.testMessages = [];
  api.tabs.sendMessage = async (_id, message) => {
    agent.testMessages.push(message.action);
    const answer = content?.(message);
    if (answer !== undefined) return answer;
    if (message.action === 'set_field' || message.action === 'type_ax') {
      agent.testWrites.push(message.params);
      return write(message.params, agent.testWrites.length);
    }
    if (message.action === 'field_value_digest') {
      return { success: true, valueLength: renderedText.length, valueSha256: sha(renderedText), reader: 'rendered',
        readbackExact: false, fieldMeta: editorMeta, ...scopeReply() };
    }
    return { success: false, ...scopeReply() };
  };
  return agent;
}

async function withCdp(overrides, run) {
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, cdpClient[key]]));
  Object.assign(cdpClient, overrides);
  try { return await run(); } finally { Object.assign(cdpClient, originals); }
}

for (const { build, Agent, batch } of builds) {
  test(`${build}: an unverified write succeeds with a note and arms no debt, lock or loop count`, async () => {
    const agent = setup(Agent);
    const result = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(result.success, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.verified, false);
    assert.equal(result.unverifiedWrite, true);
    assert.equal(result.readbackExact, false, 'the innerText fallback is not an exact reader');
    assert.deepEqual(result.unverified, { reason: 'readback_mismatch', reader: 'rendered' });
    for (const field of ['error', 'repeatBlocked', 'recoveryRequired', 'failureScope', 'outcomeUnknown', 'mutationMayHaveOccurred', 'retryable']) {
      assert.equal(Object.hasOwn(result, field), false, `${field} belongs to the lock that default mode no longer arms`);
    }
    const note = advisoryOf(result, 'text-write-readback-unverified');
    assert.match(note?.note || '', /rendered layout[\s\S]*Do not rewrite it to match/);
    assert.ok(note.note.length <= 300, 'notes stay short');
    assert.equal(Object.keys(result)[0], 'guardAdvisories', 'notes come first so truncation keeps them');
    assert.equal(agent._uncertainTextMutations.has(tabId), false, 'no text-write debt');
    // Even a stale content failureScope does not make it a failed target.
    const scoped = { ...result, failureScope: 'field-value:ref_editor' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.notEqual(agent._checkLoop(tabId, 'set_field', args, scoped).kind, 'stop', `advisory write ${attempt} stopped the run`);
    }
    assert.equal(agent.failedActionLoops.get(tabId)?.get('field-value:ref_editor'), undefined);
    // A real failure on the same target still counts and stops on the third.
    const failed = { success: false, error: 'ref_id ref_editor not found.', failureScope: 'field-value:ref_editor' };
    agent._clearLoopState(tabId);
    assert.notEqual(agent._checkLoop(tabId, 'set_field', args, failed).kind, 'stop');
    assert.notEqual(agent._checkLoop(tabId, 'set_field', args, failed).kind, 'stop');
    assert.equal(agent._checkLoop(tabId, 'set_field', args, failed).kind, 'stop');
  });

  test(`${build}: a second write to the same editor is allowed, and an append is warned about duplicates`, async () => {
    const agent = setup(Agent);
    await agent.executeTool(tabId, 'set_field', args);
    const second = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(agent.testWrites.length, 2, 'the repeat reached the page');
    assert.equal(second.success, true);
    assert.equal(second.unverifiedWrite, true);
    assert.equal(Object.hasOwn(second, 'repeatBlocked'), false);
    const append = await agent.executeTool(tabId, 'set_field', { ref_id: 'ref_editor', text: 'tail\n', clear: false });
    assert.equal(agent.testWrites.length, 3, 'an append to the same editor is allowed too');
    assert.match(advisoryOf(append, 'text-write-debt-block')?.note || '', /duplicate/);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
  });

  test(`${build}: Strict checks keep the old text-write debt, lock and loop count`, async () => {
    const agent = setup(Agent);
    agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    const first = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(first.success, false);
    assert.equal(first.outcomeUnknown, true);
    assert.equal(first.repeatBlocked, true);
    assert.equal(first.recoveryRequired, 'verify_or_restore_field');
    assert.equal(first.guardAdvisories, undefined);
    assert.equal(first.unverifiedWrite, undefined);
    assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
    assert.equal(agent._unverifiedTextWriteRecord(tabId, { key: editorKey }), null);
    const second = await agent.executeTool(tabId, 'set_field', { ...args, text: 'changed\n' });
    assert.equal(second.noDispatch, true);
    assert.equal(second.repeatBlocked, true);
    assert.match(second.error, /Text entry is blocked/);
    assert.equal(agent.testWrites.length, 1, 'the locked editor received no second write');
    assert.equal(agent._browserActionFreshTurnReason('full', 'set_field', first), 'action_failed');
    const failed = { ...first, failureScope: 'field-value:ref_editor' };
    agent._checkLoop(tabId, 'set_field', args, failed);
    assert.equal(agent.failedActionLoops.get(tabId)?.get('field-value:ref_editor'), 1);
  });

  test(`${build}: the unverified-write record is exposed next to the proofs`, async () => {
    const agent = setup(Agent);
    await agent.executeTool(tabId, 'set_field', args);
    const record = agent._unverifiedTextWriteRecord(tabId, { key: editorKey });
    assert.equal(record.key, editorKey);
    assert.equal(record.locatorType, 'ax');
    assert.equal(record.refId, 'ref_editor');
    assert.equal(record.documentToken, scope.documentToken);
    assert.equal(record.pageUrl, scope.pageUrl);
    assert.equal(record.tool, 'set_field');
    assert.equal(record.replacesValue, true);
    assert.equal(record.expectedLength, fileText.length);
    assert.equal(record.expectedSha256, sha(fileText));
    assert.equal(record.observedLength, renderedText.length);
    assert.equal(record.observedSha256, sha(renderedText));
    assert.equal(record.readbackExact, false);
    assert.equal(record.reason, 'readback_mismatch');
    assert.equal(record.textSent, true);
    assert.equal(record.fieldMeta.codeMirror, true);
    assert.equal(typeof record.recordedAt, 'number');
    assert.equal(JSON.stringify(record).includes('line three'), false, 'the record keeps no raw text');
    const byPage = agent._unverifiedTextWriteRecord(tabId, {
      pageUrl: scope.pageUrl, match: candidate => agent._isGithubFileEditorRecord(candidate),
    });
    assert.equal(byPage?.key, editorKey, 'a commit gate can find the GitHub editor write by page');
    record.fieldMeta.codeMirror = false;
    assert.equal(agent._unverifiedTextWriteRecord(tabId, { key: editorKey }).fieldMeta.codeMirror, true, 'callers get a copy');
    // A later verified write to the same editor supersedes the record.
    const verifiedAgentWrite = { success: true, verified: true, dispatched: true, method: 'set_field', ref_id: 'ref_editor', fieldMeta: editorMeta };
    await agent._finalizeTextMutationResult(tabId, 'set_field', args, verifiedAgentWrite);
    assert.equal(agent._unverifiedTextWriteRecord(tabId, { key: editorKey }), null);
  });

  test(`${build}: proofs are invalidated by an unverified write in both modes`, async () => {
    for (const strict of [false, true]) {
      const agent = setup(Agent);
      // Strict checks: the guard's refusal itself is under test (strict pass only).
      agent.strictGuards = strict;
      agent._verifiedTextReplacements.set(tabId, new Map([[editorKey, {
        key: editorKey, fieldMeta: editorMeta, expectedSha256: sha('old'), readbackSha256: sha('old'), readbackLength: 3,
      }]]));
      await agent.executeTool(tabId, 'set_field', args);
      assert.equal(agent._verifiedTextReplacements.get(tabId)?.size ?? 0, 0,
        `${strict ? 'strict' : 'default'}: an unverified write left an editor proof that could authorize a commit`);
    }
  });

  test(`${build}: set_field submit stays withheld for an unverified value and says so`, async () => {
    const agent = setup(Agent);
    const result = await agent.executeTool(tabId, 'set_field', { ...args, submit: true });
    assert.equal(result.success, true);
    assert.equal(result.verified, false);
    assert.equal(result.submitted, false);
    assert.equal(result.submitSkipped, 'value_unverified');
    assert.match(advisoryOf(result, 'text-write-readback-unverified')?.note || '', /written but its submit was NOT sent/);
  });

  test(`${build}: a lost response after dispatch reports an unknown outcome without a lock`, async () => {
    const lost = () => { throw new Error('The message port closed before a response was received.'); };
    const agent = setup(Agent, { write: lost });
    const result = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(result.success, false);
    assert.equal(result.dispatched, true);
    assert.equal(result.outcomeUnknown, true, 'the unknown outcome is still reported');
    assert.equal(Object.hasOwn(result, 'repeatBlocked'), false);
    assert.match(advisoryOf(result, 'content-action-outcome-unknown')?.note || '', /may or may not have reached the page/);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    assert.equal(agent._unverifiedTextWriteRecord(tabId, { key: editorKey })?.reason, 'outcome_unknown');
    await agent.executeTool(tabId, 'set_field', args);
    assert.equal(agent.testWrites.length, 2, 'the next write is allowed');

    const strict = setup(Agent, { write: lost });
    strict.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    const locked = await strict.executeTool(tabId, 'set_field', args);
    assert.equal(locked.repeatBlocked, true);
    const blocked = await strict.executeTool(tabId, 'set_field', args);
    assert.equal(blocked.noDispatch, true);
    assert.equal(strict.testWrites.length, 1);
  });

  test(`${build}: Stop after a real content send leaves the next run free to write`, async () => {
    let release;
    // The first write never answers before Stop; later writes answer.
    const write = (_params, count) => count === 1 ? new Promise(resolve => { release = resolve; }) : renderedMismatch();
    const agent = setup(Agent, { write });
    await agent._claimRunEntry(tabId, 'interactive');
    const pending = agent.executeTool(tabId, 'set_field', args, null, { _contentActionDispatchState: { started: false } });
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    agent.abort(tabId);
    const stopped = await pending;
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.outcomeUnknown, true, 'Stop after dispatch still reports an unknown outcome');
    assert.equal(Object.hasOwn(stopped, 'repeatBlocked'), false);
    assert.ok(advisoryOf(stopped, 'content-action-outcome-unknown'));
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    agent._releaseRunEntry(tabId);
    await agent._claimRunEntry(tabId, 'interactive');
    const next = await agent.executeTool(tabId, 'set_field', { ...args, text: 'appended\n', clear: false });
    assert.equal(agent.testWrites.length, 2, 'the next run reached the editor');
    assert.match(advisoryOf(next, 'text-write-debt-block')?.note || '', /duplicate/);
    agent._releaseRunEntry(tabId);
    release(renderedMismatch());
  });

  test(`${build}: an unproven write stays unproven, not refuted`, async () => {
    const agent = setup(Agent);
    const unproven = { success: true, method: 'cdp-insert-focused', text: 'hello' };
    const result = await agent._finalizeTextMutationResult(tabId, 'type_text', { text: 'hello' }, unproven);
    assert.equal(result.success, true);
    assert.equal(result.unverifiedWrite, true);
    assert.equal(Object.hasOwn(result, 'verified'), false, 'an unproven value is not reported as a wrong one');
    assert.match(advisoryOf(result, 'text-write-readback-unverified')?.note || '', /could not be read back exactly/);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    const locked = await agent._finalizeTextMutationResult(tabId, 'type_text', { text: 'hello' }, unproven);
    assert.equal(locked.success, false);
    assert.equal(locked.repeatBlocked, true);
  });

  test(`${build}: a replacement that was not inserted is reported without a lock`, async () => {
    const notInserted = () => ({ success: false, verified: false, dispatched: true, mutationMayHaveOccurred: true,
      outcomeUnknown: true, retryable: false, ref_id: 'ref_editor', fieldMeta: editorMeta,
      error: 'The editor could not be proven empty. No replacement text was inserted.' });
    const agent = setup(Agent, { write: notInserted });
    const result = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(result.success, false, 'no text went in, so this stays an honest failure');
    assert.equal(Object.hasOwn(result, 'repeatBlocked'), false);
    assert.match(advisoryOf(result, 'text-write-preinsert-unproven')?.note || '', /not inserted[\s\S]*Nothing is locked/);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    await agent.executeTool(tabId, 'set_field', args);
    assert.equal(agent.testWrites.length, 2);

    const strict = setup(Agent, { write: notInserted });
    strict.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    assert.equal((await strict.executeTool(tabId, 'set_field', args)).repeatBlocked, true);
    assert.equal((await strict.executeTool(tabId, 'set_field', args)).noDispatch, true);
    assert.equal(strict.testWrites.length, 1);
  });

  test(`${build}: debt left by Strict checks does not block a later write in default mode`, async () => {
    const agent = setup(Agent);
    agent.strictGuards = true; // Strict checks: arm the old debt first.
    await agent.executeTool(tabId, 'set_field', args);
    assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
    agent.strictGuards = false;
    const result = await agent.executeTool(tabId, 'set_field', { ...args, text: 'corrected\n' });
    assert.equal(agent.testWrites.length, 2, 'the write went ahead');
    assert.equal(result.success, true);
    assert.match(advisoryOf(result, 'text-write-debt-block')?.note || '', /not verified; this replacement went ahead/);
  });

  test(`${build}: an advisory write does not stop the rest of the batch; Strict checks still do`, async () => {
    const agent = setup(Agent);
    const advisory = await agent.executeTool(tabId, 'set_field', args);
    const batchContext = { navigationChanged: false, sameNext: true, remainingObservations: false,
      hadMutation: true, hasRemaining: true, submit: false };
    assert.equal(agent._browserActionFreshTurnReason('full', 'set_field', advisory, batchContext), '');
    assert.equal(agent._browserActionFreshTurnReason('full', 'set_field', advisory), '');
    const message = { role: 'tool', content: JSON.stringify(advisory) };
    assert.equal(batch.browserBatchResultStatus(message).failed, false);
    // Real failures and unknown outcomes still interrupt.
    const unknown = { success: false, dispatched: true, outcomeUnknown: true, error: 'timed out' };
    assert.equal(agent._browserActionFreshTurnReason('full', 'set_field', unknown, batchContext), 'action_failed');
    assert.equal(batch.browserBatchResultStatus({ role: 'tool', content: JSON.stringify(unknown) }).failed, true);
    agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    assert.equal(agent._browserActionFreshTurnReason('full', 'set_field', advisory, batchContext), 'action_unverified');
    const strictStatus = batch.browserBatchResultStatus(message, { advisoryWritesContinue: false });
    assert.equal(strictStatus.failed, true);
    assert.equal(strictStatus.reason, 'action_unverified');
  });

  test(`${build}: a write an exact reader reads back as a different value stops the rest of the batch`, async () => {
    // A semantic (exact) reader read another value: WebBrain knows the field
    // is wrong, so a batched submit must not run on it. The write itself is
    // still an advised success that locks nothing.
    const agent = setup(Agent, { write: () => renderedMismatch({
      unverified: { reason: 'readback_mismatch', reader: 'semantic' }, readbackExact: true }) });
    const refuted = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(refuted.success, true);
    assert.equal(refuted.unverifiedWrite, true);
    assert.equal(refuted.verified, false);
    assert.equal(refuted.readbackExact, true);
    assert.match(advisoryOf(refuted, 'text-write-readback-unverified')?.note || '', /reads back a different value/);
    assert.equal(agent._uncertainTextMutations.has(tabId), false, 'no text-write debt');
    const batchContext = { navigationChanged: false, sameNext: true, remainingObservations: false,
      hadMutation: true, hasRemaining: true, submit: false };
    assert.equal(agent._browserActionFreshTurnReason('full', 'set_field', refuted, batchContext), 'action_unverified');
    assert.equal(batch.textWriteRefuted(refuted), true);
    const status = batch.browserBatchResultStatus({ role: 'tool', content: JSON.stringify(refuted) });
    assert.equal(status.failed, true, 'the next batched action must not run on a refuted value');
    assert.equal(status.reason, 'action_unverified');
    // Rendered-layout and unreadable readbacks only leave the write unconfirmed.
    for (const uncertain of [{ ...refuted, readbackExact: false }, { ...refuted, readbackExact: undefined, verified: undefined }]) {
      assert.equal(batch.textWriteRefuted(uncertain), false);
      assert.equal(agent._browserActionFreshTurnReason('full', 'set_field', uncertain, batchContext), '');
      assert.equal(batch.browserBatchResultStatus({ role: 'tool', content: JSON.stringify(uncertain) }).failed, false);
    }
  });

  test(`${build}: content readback reports which reader produced the value`, async () => {
    const h = contentHarness(build);
    // A generic block editor reads back through innerText, the browser's
    // layout: a mismatch there cannot tell a wrong write from the reader.
    const editor = h.editor({ className: 'notes-editor', innerText: renderedText });
    const verified = await h.call('ax_verify_field_value', editor, { ref_id: 'ref_editor', expected: fileText });
    assert.equal(verified.success, true);
    assert.equal(verified.verified, false);
    assert.equal(verified.reader, 'rendered');
    assert.equal(verified.readbackExact, false);
    const digest = await h.call('field_value_digest', editor, { ref_id: 'ref_editor' });
    assert.equal(digest.valueSha256, sha(renderedText));
    assert.equal(digest.reader, 'rendered');
    assert.equal(digest.readbackExact, false);
    // GitHub's CodeMirror reads its document lines exactly.
    const codeMirror = h.codeMirror({ text: fileText, innerText: renderedText });
    const exactCm = await h.call('ax_verify_field_value', codeMirror, { ref_id: 'ref_editor', expected: fileText });
    assert.equal(exactCm.success, true);
    assert.equal(exactCm.verified, true);
    assert.equal(exactCm.reader, 'semantic');
    assert.equal(exactCm.readbackExact, true);
    const cmDigest = await h.call('field_value_digest', codeMirror, { ref_id: 'ref_editor' });
    assert.equal(cmDigest.valueSha256, sha(fileText));
    assert.equal(cmDigest.reader, 'semantic');
    // A CodeMirror view with a viewport gap cannot establish the document.
    const partial = h.codeMirror({ text: fileText, innerText: renderedText, gap: true });
    const gapResult = await h.call('ax_verify_field_value', partial, { ref_id: 'ref_editor', expected: fileText });
    assert.equal(gapResult.success, false);
    assert.match(gapResult.error, /only part of its document/);
    const input = h.input('plain value');
    const exact = await h.call('ax_verify_field_value', input, { ref_id: 'ref_input', expected: 'plain value' });
    assert.equal(exact.verified, true);
    assert.equal(exact.reader, 'exact');
    assert.equal(exact.readbackExact, true);
  });
}

test('chrome: trusted typing into GitHub CodeMirror is an unverified success, not a lock', async () => {
  const { Agent } = builds.find(item => item.build === 'chrome');
  const commands = [];
  const trustedRequired = () => ({ success: false, error: 'Contenteditable fields require trusted browser typing. Attempting one ref-bound Chrome typing pass.',
    dispatched: false, noDispatch: true, method: 'set_field_contenteditable_trusted', ref_id: 'ref_editor', verified: false,
    fieldMeta: editorMeta, fallbackAttempted: false, trustedTypeRequired: true, _expectedValue: fileText });
  const content = message => {
    if (message.action === 'ax_prepare_field_for_trusted_type') {
      return { success: true, contentEditable: true, fieldMeta: editorMeta, rect: { x: 10, y: 20, w: 600, h: 400 } };
    }
    if (message.action === 'ax_verify_field_value') {
      return { success: true, verified: false, actual: renderedText, reader: 'rendered', readbackExact: false, fieldMeta: editorMeta };
    }
    return undefined;
  };
  await withCdp({
    attach: async () => ({ attached: true }),
    sendCommand: async (_tabId, method, params) => { commands.push({ method, params }); return {}; },
  }, async () => {
    const agent = setup(Agent, { write: trustedRequired, content });
    const result = await agent.executeTool(tabId, 'set_field', { ...args, submit: true });
    assert.equal(result.success, true);
    assert.equal(result.verified, false);
    assert.equal(result.unverifiedWrite, true);
    assert.equal(result.readbackExact, false);
    assert.equal(result.trustedTypeRequired, undefined);
    assert.equal(result.submitted, false);
    assert.equal(result.submitSkipped, 'value_unverified');
    assert.ok(advisoryOf(result, 'text-write-readback-unverified'));
    assert.deepEqual(commands.filter(command => command.method === 'Input.insertText').map(command => command.params.text), [fileText]);
    assert.equal(commands.some(command => command.params?.key === 'Enter'), false, 'an unverified value is never submitted');
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    assert.equal(agent._unverifiedTextWriteRecord(tabId, { key: editorKey })?.observedSha256, sha(renderedText));
    // The repeat is allowed and goes out once more.
    await agent.executeTool(tabId, 'set_field', args);
    assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 2);

    commands.length = 0;
    const strict = setup(Agent, { write: trustedRequired, content });
    strict.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    const locked = await strict.executeTool(tabId, 'set_field', args);
    assert.equal(locked.success, false);
    assert.equal(locked.repeatBlocked, true);
    assert.match(locked.error, /still did not exactly match after trusted typing/);
    const blocked = await strict.executeTool(tabId, 'set_field', { ...args, text: 'changed\n' });
    assert.equal(blocked.noDispatch, true);
    assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 1);
  });
});

test('chrome: a lost trusted insertText acknowledgement is reported without a lock', async () => {
  const { Agent } = builds.find(item => item.build === 'chrome');
  const commands = [];
  const trustedRequired = () => ({ success: false, error: 'Contenteditable fields require trusted browser typing.',
    dispatched: false, noDispatch: true, ref_id: 'ref_editor', verified: false, fieldMeta: editorMeta,
    trustedTypeRequired: true, _expectedValue: fileText });
  const content = message => message.action === 'ax_prepare_field_for_trusted_type'
    ? { success: true, contentEditable: true, fieldMeta: editorMeta, rect: { x: 10, y: 20, w: 600, h: 400 } }
    : undefined;
  await withCdp({
    attach: async () => ({ attached: true }),
    sendCommand: async (_tabId, method, params) => {
      commands.push({ method, params });
      if (method === 'Input.insertText') throw new Error('Owned text response lost');
      return {};
    },
  }, async () => {
    const agent = setup(Agent, { write: trustedRequired, content });
    const result = await agent.executeTool(tabId, 'set_field', args);
    assert.equal(result.success, false, 'the outcome is unknown, so it is not reported as written');
    assert.equal(result.outcomeUnknown, true);
    assert.equal(Object.hasOwn(result, 'repeatBlocked'), false);
    assert.match(advisoryOf(result, 'trusted-field-retry-guards')?.note || '', /Nothing is locked/);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);
    await agent.executeTool(tabId, 'set_field', args);
    assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 2, 'the model may write again');

    commands.length = 0;
    const strict = setup(Agent, { write: trustedRequired, content });
    strict.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    assert.equal((await strict.executeTool(tabId, 'set_field', args)).repeatBlocked, true);
    assert.equal((await strict.executeTool(tabId, 'set_field', args)).noDispatch, true);
    assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 1);
  });
});

test('chrome: an uncertain original write is never retyped, and only Strict checks lock it', async () => {
  const { Agent } = builds.find(item => item.build === 'chrome');
  const commands = [];
  const dispatchedMismatch = () => ({ success: false, verified: false, dispatched: true, method: 'type_ax_input', ref_id: 'ref_input',
    actual: 'reset', fieldMeta: { tag: 'input', contentEditable: false }, _expectedValue: 'gary flake',
    recoveryRequired: 'verify_or_restore_field', failureScope: 'field-value:ref_input', retryable: false,
    unverified: { reason: 'readback_mismatch', reader: 'exact' }, readbackExact: true,
    error: 'The field value did not exactly match the requested text after the page settled. Repeat the original replacement text and target for readback-only recovery, or restore the editor before another write.' });
  const inputArgs = { ref_id: 'ref_input', text: 'gary flake' };
  await withCdp({
    attach: async () => { commands.push({ method: 'attach' }); return { attached: true }; },
    sendCommand: async (_tabId, method, params) => { commands.push({ method, params }); return {}; },
  }, async () => {
    const agent = setup(Agent, { write: dispatchedMismatch });
    const branch = await agent._maybeFallbackFieldWithCdp(tabId, 'set_field', inputArgs, dispatchedMismatch());
    assert.equal(branch.repeatBlocked, undefined);
    assert.equal(branch.recoveryRequired, undefined);
    assert.equal(branch.mutationMayHaveOccurred, true, 'the possible landed write is still reported');
    assert.equal(branch.fallbackAttempted, false);
    assert.equal(commands.length, 0, 'no trusted retry is prepared or sent');
    const result = await agent.executeTool(tabId, 'set_field', inputArgs, null);
    assert.equal(result.success, true, 'by default the write is reported as an unverified success');
    assert.equal(result.readbackExact, true);
    assert.match(advisoryOf(result, 'text-write-readback-unverified')?.note || '', /reads back a different value/);
    assert.equal(agent._uncertainTextMutations.has(tabId), false);

    agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    const strictBranch = await agent._maybeFallbackFieldWithCdp(tabId, 'set_field', inputArgs, dispatchedMismatch());
    assert.equal(strictBranch.repeatBlocked, true);
    assert.equal(strictBranch.recoveryRequired, 'verify_or_restore_field');
    assert.match(strictBranch.error, /No trusted retry was sent/);
    assert.equal(commands.length, 0);
  });
});

test('chrome: type_text by selector proceeds unpinned by default; Strict checks refuse', async () => {
  const { Agent } = builds.find(item => item.build === 'chrome');
  const pins = [];
  await withCdp({
    attach: async () => ({ attached: true }),
    probeRichTextToolbarSelector: async () => null,
    typeText: async (_tabId, _selector, _text, _clear, expectedNode) => {
      pins.push(expectedNode);
      return { success: true, verified: true, method: 'cdp-insert-text', tag: 'INPUT', rect: { x: 1, y: 2, w: 3, h: 4 } };
    },
  }, async () => {
    const agent = setup(Agent);
    const result = await agent.executeTool(tabId, 'type_text', { selector: '#title', text: 'Release notes' });
    assert.equal(result.success, true);
    assert.deepEqual(pins, [null], 'typed by selector without a pinned node');
    assert.match(advisoryOf(result, 'typing-target-identity')?.note || '', /could not be pinned/);

    agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    const refused = await agent.executeTool(tabId, 'type_text', { selector: '#title', text: 'Release notes' });
    assert.equal(refused.success, false);
    assert.equal(refused.noDispatch, true);
    assert.match(refused.error, /Could not preserve the selector target/);
    assert.deepEqual(pins, [null]);
  });
});

test('chrome: focused type_text whose bound field lost focus types into the field focused now', async () => {
  const { Agent } = builds.find(item => item.build === 'chrome');
  const commands = [];
  const content = message => {
    if (message.action === 'prepare_focused_type_dispatch') {
      return { success: false, dispatched: false, noDispatch: true, retryable: true, reasonCode: 'focused_target_changed',
        error: 'The focused target changed after the rich-text toolbar safety preflight. Focus the intended field again and retry.' };
    }
    if (message.action === 'release_dispatch_binding') return { success: true };
    return undefined;
  };
  await withCdp({
    attach: async () => ({ attached: true }),
    evaluate: async () => ({ result: { value: { focused: true, editable: true, contentEditable: false, tag: 'INPUT',
      type: 'text', name: 'q', value: '', rect: { x: 1, y: 2, w: 3, h: 4 } } } }),
    textEntrySignature: async () => 'signature',
    verifyTextEntry: async () => true,
    sendCommand: async (_tabId, method, params) => { commands.push({ method, params }); return {}; },
  }, async () => {
    const binding = { dispatchBinding: { token: 'binding-1', frameId: 0 } };
    const agent = setup(Agent, { content });
    const result = await agent.executeTool(tabId, 'type_text', { text: 'hello' }, null, binding);
    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.deepEqual(commands.filter(command => command.method === 'Input.insertText').map(command => command.params.text), ['hello']);
    assert.match(advisoryOf(result, 'typing-target-identity')?.note || '', /lost focus/);

    commands.length = 0;
    const strict = setup(Agent, { content });
    strict.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
    const refused = await strict.executeTool(tabId, 'type_text', { text: 'hello' }, null, { dispatchBinding: { token: 'binding-2', frameId: 0 } });
    assert.equal(refused.success, false);
    assert.equal(refused.reasonCode, 'focused_target_changed');
    assert.equal(commands.length, 0);
  });
});

test('chrome: a clearing focused type_text never falls back to the field focused now', async () => {
  // The truncated-preview (deletion) check runs against the bound field.
  // Select-all + delete on whichever field has focus now could erase a value
  // that check never saw, so clear:true refuses in both modes.
  const { Agent } = builds.find(item => item.build === 'chrome');
  const commands = [];
  const truncationChecks = [];
  const content = message => {
    if (message.action === 'check_truncated_replacement') {
      truncationChecks.push(message.params?.dispatchBinding?.token || 'focused-now');
      return { success: true };
    }
    if (message.action === 'prepare_focused_type_dispatch') {
      return { success: false, dispatched: false, noDispatch: true, retryable: true, reasonCode: 'focused_target_changed',
        error: 'The focused target changed after the rich-text toolbar safety preflight. Focus the intended field again and retry.' };
    }
    if (message.action === 'release_dispatch_binding') return { success: true };
    return undefined;
  };
  await withCdp({
    attach: async () => ({ attached: true }),
    evaluate: async () => ({ result: { value: { focused: true, editable: true, contentEditable: false, tag: 'TEXTAREA',
      type: '', name: 'other', value: 'A long value the preview check never saw', rect: { x: 1, y: 2, w: 3, h: 4 } } } }),
    textEntrySignature: async () => 'signature',
    captureTextClearReceipt: async () => ({ current: async () => true, verify: async () => true, dispose: async () => {} }),
    selectAllModifier: async () => 2,
    verifyTextEntry: async () => true,
    sendCommand: async (_tabId, method, params) => { commands.push({ method, params }); return {}; },
  }, async () => {
    for (const strict of [false, true]) {
      commands.length = 0;
      truncationChecks.length = 0;
      const agent = setup(Agent, { content });
      agent.strictGuards = strict;
      const result = await agent.executeTool(tabId, 'type_text', { text: 'Replacement body', clear: true }, null,
        { dispatchBinding: { token: `binding-clear-${strict}`, frameId: 0 } });
      assert.equal(result.success, false, `strict=${strict}: a clearing write fell back to another field`);
      assert.equal(result.reasonCode, 'focused_target_changed');
      assert.equal(advisoryOf(result, 'typing-target-identity'), undefined);
      assert.deepEqual(commands, [], `strict=${strict}: input was dispatched after the bound field lost focus`);
      assert.deepEqual(truncationChecks, [`binding-clear-${strict}`]);
    }
  });
});

test('firefox: type_text by selector proceeds without a binding by default; Strict checks refuse', async () => {
  const { Agent } = builds.find(item => item.build === 'firefox');
  const typed = [];
  const content = message => {
    if (message.action !== 'type') return undefined;
    typed.push(message.params);
    return { success: true, verified: true, value: message.params.text, fieldMeta: { tag: 'input' } };
  };
  const agent = setup(Agent, { content });
  agent._probeRichTextToolbarRetryTarget = async () => null;
  const result = await agent.executeTool(tabId, 'type_text', { selector: '#title', text: 'Release notes' });
  assert.equal(result.success, true);
  assert.equal(typed.length, 1);
  assert.equal(typed[0].dispatchBinding, undefined);
  assert.match(advisoryOf(result, 'typing-target-identity')?.note || '', /could not be pinned/);

  agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
  const refused = await agent.executeTool(tabId, 'type_text', { selector: '#title', text: 'Release notes' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /Could not preserve the selector target/);
  assert.equal(typed.length, 1);
});

test('firefox: a trusted BiDi readback mismatch is an unverified write, not debt', async () => {
  const { Agent } = builds.find(item => item.build === 'firefox');
  const tab = 77;
  const client = new FirefoxBidiClient({ tabs: { sendMessage: async () => ({ bidiPrepared: true, fieldMeta: editorMeta, url: scope.pageUrl }) } });
  client.runs.set(tab, { runId: 'run-1', bound: true });
  client.bindRun = async () => {};
  client.perform = async () => ({ success: false, dispatched: true, verified: false, submitted: false, outcomeUnknown: true,
    retryable: false, error: 'Trusted typing did not match the requested value; inspect before another write.' });
  const mismatch = await client.sendContent(tab, { target: 'content', action: 'set_field', params: { ...args } });
  assert.deepEqual(mismatch.unverified, { reason: 'readback_mismatch', reader: 'unknown' });
  client.perform = async () => { throw Object.assign(new Error('companion disconnected'), {}); };
  const lost = await client.sendContent(tab, { target: 'content', action: 'set_field', params: { ...args } });
  assert.equal(lost.unverified, undefined, 'a transport failure is an unknown outcome, not an unverified write');

  const agent = setup(Agent);
  const advisory = await agent._finalizeTextMutationResult(tabId, 'set_field', args, mismatch);
  assert.equal(advisory.success, true);
  assert.equal(advisory.unverifiedWrite, true);
  assert.equal(agent._uncertainTextMutations.has(tabId), false);
  agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
  const locked = await agent._finalizeTextMutationResult(tabId, 'set_field', args, mismatch);
  assert.equal(locked.repeatBlocked, true);
  assert.equal(agent._uncertainTextMutations.get(tabId)?.size, 1);
});

// The real content-script readback handlers, run against a minimal DOM.
function functionSource(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
  const end = source.indexOf(`\n${indent}}`, start) + indent.length + 2;
  assert(end > start, name);
  return source.slice(start, end);
}
function handlerSource(source, action) {
  const start = source.indexOf(`'${action}':`);
  const end = source.indexOf('\n      },', start);
  assert(start >= 0 && end > start, action);
  return source.slice(source.indexOf(':', start) + 1, end + 8).trim();
}
function contentHarness(build) {
  const source = fs.readFileSync(new URL(`../src/${build}/src/content/content.js`, import.meta.url), 'utf8');
  const names = ['_setFieldValueMatches', 'readProseMirrorText', 'readCodeMirrorText', 'readEmptyCaretText', 'isDraftJsEditor',
    'readDraftJsText', '_nativeChatCaretContext', '_sameNativeChatCaretContext', '_singleEditableCaretBreak',
    '_nativeChatCaretValueIsEmpty', '_editableTextValue'];
  if (build === 'chrome') names.unshift('_contentEditableValueMatches');
  let target = null;
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, Uint8Array, _nativeChatEmptyCaretReceipts: new WeakMap(),
    window: { __wb_ax_lookup: () => target }, msg: { params: {} }, document: {},
    _fieldMeta: () => ({ ...editorMeta }), _stableFieldSelector: () => '#editor' });
  vm.runInContext(names.map(name => functionSource(source, name)).join('\n'), context);
  const handlers = Object.fromEntries(['ax_verify_field_value', 'field_value_digest']
    .map(action => [action, vm.runInContext(`(${handlerSource(source, action)})`, context)]));
  const node = (fields) => ({ nodeType: 1, isConnected: true, childNodes: [], getAttribute: () => null,
    classList: { contains: () => false }, ...fields });
  const classes = (...names) => ({ contains: name => names.includes(name) });
  return {
    // A generic contenteditable: only innerText can be read.
    editor: ({ className, innerText }) => {
      const lines = innerText.split('\n').map(text => node({ tagName: 'DIV', textContent: text }));
      return node({ tagName: 'DIV', isContentEditable: true, innerText, textContent: innerText.replace(/\n/g, ''),
        childNodes: lines, children: lines, classList: classes(className) });
    },
    // CodeMirror 6 as GitHub renders it: one .cm-line per document line, a
    // placeholder BR in each empty line, and innerText doubling blank lines.
    codeMirror: ({ text, innerText, gap = false }) => {
      const lines = text.split('\n').map(line => node({ tagName: 'DIV', classList: classes('cm-line'),
        childNodes: line ? [{ nodeType: 3, nodeValue: line }] : [node({ tagName: 'BR' })] }));
      if (gap) lines.splice(1, 0, node({ tagName: 'DIV', classList: classes('cm-gap') }));
      return node({ tagName: 'DIV', isContentEditable: true, innerText, textContent: text.replace(/\n/g, ''),
        childNodes: lines, children: lines, classList: classes('cm-content') });
    },
    input: value => node({ tagName: 'INPUT', isContentEditable: false, value }),
    async call(action, element, params) {
      target = element;
      context.msg = { params };
      return handlers[action]();
    },
  };
}
