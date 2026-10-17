import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// Unit and Agent-batch checks with mocked browser APIs. The final chat answer
// for a guard-ended run is plain language; the mechanical diagnostic remains
// on the done tool result (verbose rows) and in traces.
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://x.com/home', title: 'Home / X' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};

const jargon = /\[|\]|job-bound|terminal evidence|recovery nudge|PLAN EXECUTION|dispatch|workflow|consequential|tool call/i;

for (const build of ['chrome', 'firefox']) {
  test(`${build}: guard terminal messages are plain language`, async () => {
    const { terminalGuardUserMessage, stepLimitUserMessage, socialPlatformLabel } = await import(`../src/${build}/src/agent/terminal-messages.js`);
    const kinds = ['task_changed', 'schedule_missing', 'download_missing', 'social_missing', 'submission_missing',
      'forbidden_submission', 'job_evidence_missing', 'draft_missing', 'ledger_incomplete', 'stale_cancellation',
      'clarification_required', 'placeholder_output', 'empty_output', 'mode_contradiction', 'default'];
    for (const kind of kinds) for (const facts of [{}, { consequential: true }, { readOnly: true },
      { unconfirmed: ['twitter'] }, { notStarted: ['bluesky'], verified: ['twitter'] }, { reason: 'content_filter' }]) {
      const message = terminalGuardUserMessage(kind, facts);
      assert.ok(message.length > 20 && message.length < 600, `${kind}: unexpected length`);
      assert.doesNotMatch(message, jargon, `${kind}: mechanical wording leaked into the chat answer`);
    }
    const social = terminalGuardUserMessage('social_missing', { unconfirmed: ['twitter'], notStarted: ['bluesky'] });
    assert.match(social, /clicked Post on X/);
    assert.match(social, /didn't post again/);
    assert.match(social, /nothing was published there/);
    assert.match(social, /Bluesky/);
    assert.equal(socialPlatformLabel('twitter'), 'X');
    // "I submitted" only when a submit dispatch was recorded for this task.
    assert.match(terminalGuardUserMessage('submission_missing', { submitted: true, consequential: true }), /^I submitted it/);
    assert.doesNotMatch(terminalGuardUserMessage('submission_missing', { consequential: true }), /submitted it/);
    assert.match(terminalGuardUserMessage('submission_missing', { consequential: true }), /final submission didn't go through/);
    const limit = stepLimitUserMessage(130, 'I opened the composer.');
    assert.match(limit, /step limit \(130 steps\)/);
    assert.match(limit, /Where I stopped: "I opened the composer\."/);
    assert.doesNotMatch(limit, /\[|\]|×|ref_/);
  });
}

test('terminal message module stays byte-identical across builds', () => {
  assert.equal(fs.readFileSync(new URL('../src/chrome/src/agent/terminal-messages.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/firefox/src/agent/terminal-messages.js', import.meta.url), 'utf8'));
});

function batchAgent(Agent, tabId) {
  const agent = new Agent({ getActive: () => ({ model: 'test', supportsTools: true }), getVisionProvider: async () => null });
  // Strict checks: the guard's refusal itself is under test.
  agent.strictGuards = true;
  agent.conversationIds.set(tabId, 'conv-terminal');
  agent.conversationModes.set(tabId, 'act');
  agent.conversations.set(tabId, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'Post "Hello" on X.' },
  ]);
  agent._ensureGateSetting = async () => {};
  agent._skipPermissionGate = true;
  agent._currentUrl = async () => 'https://x.com/home';
  agent._persist = () => {};
  agent._persistNow = async () => true;
  agent.executeTool = async (_tab, name, args) => {
    if (name === 'done') return { done: true, summary: args.summary, outcome: args.outcome };
    throw new Error(`unexpected ${name}`);
  };
  return agent;
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: an unconfirmed dispatched generic submission ends partial without claiming action failure`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const tabId = 4402, agent = batchAgent(Agent, tabId);
    const guard = agent._startPlanExecutionGuard(tabId, 'act', {
      requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
    });
    guard.successfulConsequentialToolCalls = 1; guard.successfulTaskToolCalls = 1; guard.evidenceTaskKey = guard.taskKey;
    agent._completionSubmitStates.set(tabId, { dispatched: true, taskKey: guard.taskKey });
    agent._completionVerdicts = new Map([[tabId, { outcome: 'uncertain', engine: 'legacy' }]]);
    const updates = [], messages = [];
    const batch = id => agent._executeToolBatch(tabId, [{ id, function: { name: 'done',
      arguments: JSON.stringify({ summary: 'Sent.', outcome: 'success' }) } }], messages,
    (type, data) => updates.push({ type, data }), { supportsVision: false }, null, new Set(['done']), 1, {});
    assert.equal((await batch('done_1')).action, 'continue');
    const result = await batch('done_2');
    assert.equal(result.action, 'return'); assert.equal(result.status, 'partial');
    assert.match(result.value, /I submitted it, but I couldn't confirm/);
    const done = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1).data.result;
    assert.equal(done.outcome, 'partial'); assert.equal(done.success, true); assert.equal(done.error, undefined);
    assert.match(done.verificationWarning, /generic submission evidence was still missing/);
    assert.notEqual(guard.verifiedSubmissionEvidence, true);
    agent._completionSubmitStates.get(tabId).formValidationFailed = true;
    assert.equal(agent._planOnlyTerminalDecision(tabId, 'Sent.', { viaDone: true, outcome: 'success' }).status,
      'required_evidence_missing', 'A real validation failure must retain failure semantics');
  });

  test(`${build}: a publication that could not be confirmed ends with a plain answer and keeps the diagnostic`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const { normalizePublicationContract } = await import(`../src/${build}/src/agent/social-publish-contract.js`);
    const tabId = 4401;
    const agent = batchAgent(Agent, tabId);
    const guard = agent._startPlanExecutionGuard(tabId, 'act', {
      requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
    });
    const contract = normalizePublicationContract({ version: 1, status: 'ready', actions: [{ id: 'p1', platform: 'twitter',
      account: null, posts: [{ body: { kind: 'exact', source: { source: 'request', start: 'Hello', end: 'Hello' } },
        media: { kind: 'count', type: 'any', format: null, min: 0, max: 0 }, context: { kind: 'post', target: null } }] }],
    requirements: 'p1', prohibited: [], reason: 'post' }, { request: 'Post "Hello" on X.' });
    // The Post click was delivered (pending), then the page changed before
    // job-bound evidence could be captured.
    guard.socialPublication = { key: 'contract-key', actionId: 'p1', contract, outcomes: { p1: { status: 'pending' } } };
    guard.successfulConsequentialToolCalls = 1;
    guard.successfulTaskToolCalls = 2;
    guard.evidenceTaskKey = guard.taskKey;
    const updates = [], messages = [];
    const batch = id => agent._executeToolBatch(tabId, [{ id, function: { name: 'done',
      arguments: JSON.stringify({ summary: 'Posted.', outcome: 'success' }) } }], messages,
    (type, data) => updates.push({ type, data }), { supportsVision: false }, null, new Set(['done']), 1, {});
    const first = await batch('done_1');
    assert.equal(first.action, 'continue', 'the first missing-evidence done gets one recovery turn');
    const second = await batch('done_2');
    assert.equal(second.action, 'return');
    assert.equal(second.status, 'required_evidence_missing', 'the guard status is preserved for traces');
    assert.doesNotMatch(second.value, jargon, 'the chat answer must not show guard mechanics');
    assert.match(second.value, /clicked Post on X/);
    assert.match(second.value, /didn't post again/);
    const result = updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1).data.result;
    assert.match(result.error, /^\[Agent stopped because job-bound terminal evidence was still missing/,
      'verbose rows and traces keep the exact diagnostic');
    assert.equal(result.outcome, 'failed');
    assert.match(String(messages.at(-1)?.content || ''), /job-bound terminal evidence/, 'later model turns keep the diagnostic');
  });
}
