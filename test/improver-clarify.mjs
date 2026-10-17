// Ordinary clarification and its timeout guard, in both builds:
// - recipient purposes stay valid when research escalation is off;
// - Ask's research note does not send the model to a clarify it cannot use;
// - a timed-out clarification's block counter restarts with each user turn
//   while the guard itself stays armed and is announced in the system prompt,
//   in words that are also true when the scheduler armed it;
// - every scheduled task run, recurring or one-shot, drops the planner's
//   schedule_task requirement and the state change that its scheduling tag
//   forced (a scheduled resume and interactive runs keep both); the planner
//   is told the run executes an existing task, and a plan whose steps only
//   observe loses a state-change mark that only its tag explains, so a
//   reminder run finishes with success without a mutating tool, while a
//   plan's own submission still has to happen; a one-shot run that sets up
//   a different schedule can still call schedule_task;
// - a run the user starts again after a stop gets a fresh blocked-attempt
//   count while the clarification guard stays armed;
// - a real planner question reports that the run ended waiting for the user,
//   and that report pauses a recurring scheduled task.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
};
globalThis.chrome = api;
globalThis.browser = api;

const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  tools: await import(`../src/${build}/src/agent/tools.js`),
  args: await import(`../src/${build}/src/agent/tool-arguments.js`),
  research: await import(`../src/${build}/src/agent/research-escalation.js`),
  Scheduler: await import(`../src/${build}/src/agent/scheduler.js`),
  planner: await import(`../src/${build}/src/agent/planner.js`),
})));

const STILL_REQUIRED = /CLARIFICATION STILL REQUIRED/;

function plannerResult(kind, summary, overrides = {}) {
  return {
    request_kind: kind,
    requires_state_change: kind === 'execute',
    requires_submission: false,
    read_scope: 'none',
    summary,
    steps: kind === 'plan_only' ? [{ id: '1', action: summary }] : [],
    memory: {},
    scheduling: null,
    risks: [],
    localized: { locale: 'en', summary, steps: kind === 'plan_only' ? [{ id: '1', action: summary }] : [], risks: [] },
    ...overrides,
  };
}

// The real planner gate and run loop; only the model, storage, trace and tab
// transports are replaced, and no tool may run.
function plannerAgent(Agent, plan, plannerMode) {
  const provider = {
    name: 'owned', model: 'owned', promptTier: 'full', contextWindow: 128000,
    supportsTools: false, supportsVision: false,
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  const plannerCalls = [];
  Object.assign(agent, {
    _hydrate: async () => {},
    _persist: () => {},
    _persistNow: async () => ({ ok: true }),
    _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null,
    _endTraceRun: async () => {},
    _enrichUserMessageWithCurrentPage: async (_tab, _messages, content) => ({ role: 'user', content }),
    _beginReadCompleteness: async () => null,
    _manageContext: async () => {},
    _checkCostAllowance: async () => null,
    _recordCostUsage: async () => null,
    _currentUrl: async () => 'https://example.com/',
    _getTabUrlTitle: async () => ({ tabUrl: 'https://example.com/', tabTitle: 'Example' }),
    _plannerMode: () => plannerMode,
    _waitForPlanReview: async () => assert.fail('a planner question needs no plan review'),
    _chatWithCostAllowance: async (_provider, messages, _options, _cost, meta) => {
      plannerCalls.push(meta?.generationName || 'chat');
      if (!/^planner/.test(meta?.generationName || '')) assert.fail(`unexpected model call ${meta?.generationName}`);
      return { content: JSON.stringify(plan) };
    },
    executeTool: async name => assert.fail(`no tool may run after a planner question (${name})`),
  });
  agent.plannerCalls = plannerCalls;
  return agent;
}

function guardedAgent(Agent, tabId) {
  const agent = new Agent({ getVisionProvider: async () => null });
  agent.conversations.set(tabId, [{ role: 'system', content: 'system' }]);
  agent.conversationIds.set(tabId, `conv_${tabId}`);
  agent.conversationModes.set(tabId, 'act');
  agent._persist = () => {};
  agent._persistNow = async () => true;
  agent._ensureGateSetting = async () => {};
  agent.executeTool = async () => ({ done: true, summary: 'should not run', outcome: 'success' });
  return agent;
}

function doneSuccessBatch(agent, tabId) {
  return agent._executeToolBatch(
    tabId,
    [{ id: `done_${Math.random().toString(36).slice(2)}`, function: { name: 'done', arguments: JSON.stringify({ summary: 'Finished.', outcome: 'success' }) } }],
    [],
    () => {},
    { supportsVision: false },
    '',
    new Set(['done']),
    1,
  );
}

for (const { build, Agent, tools, args, research, Scheduler, planner } of builds) {
  test(`${build}: ordinary clarify keeps the recipient purposes when research escalation is off`, () => {
    for (const [mode, tier] of [['act', 'compact'], ['act', 'mid'], ['act', 'full'], ['dev', 'mid'], ['dev', 'full']]) {
      const clarify = tools.getToolsForMode(mode, { tier, researchEscalationEnabled: false })
        .find(tool => tool.function.name === 'clarify');
      const parameters = clarify.function.parameters;
      assert.deepEqual(parameters.properties.purpose.enum, ['message_recipient', 'recipient_change'], `${mode}/${tier}`);
      assert.doesNotMatch(parameters.properties.purpose.description, /research/i, `${mode}/${tier}`);
      assert.equal('research_request' in parameters.properties, false, `${mode}/${tier}`);
      assert.equal('approve_option' in parameters.properties, false, `${mode}/${tier}`);
      for (const purpose of ['message_recipient', 'recipient_change']) {
        const result = args.validateToolArguments('clarify', { question: 'Who should receive the message?', purpose }, parameters);
        assert.equal(result.ok, true, `${mode}/${tier}: ${purpose} was rejected`);
      }
      const delegated = args.validateToolArguments('clarify', {
        question: 'Send this to ChatGPT?', options: ['Continue here', 'Use ChatGPT'],
        purpose: 'research_escalation', research_request: 'Compare fares.', approve_option: 'Use ChatGPT',
      }, parameters);
      assert.equal(delegated.ok, false, `${mode}/${tier}: research purpose must stay opt-in`);
      assert.ok(delegated.result.invalidArgumentNames.includes('$.purpose'));
    }
    const enabled = tools.getToolsForMode('act', { researchEscalationEnabled: true })
      .find(tool => tool.function.name === 'clarify');
    assert.deepEqual(enabled.function.parameters.properties.purpose.enum, ['research_escalation', 'message_recipient', 'recipient_change']);
  });

  test(`${build}: the clarify handler accepts a recipient purpose with research escalation off`, async () => {
    const agent = new Agent({});
    const tabId = 6101;
    agent.researchEscalationEnabled = false;
    agent._persist = () => {};
    agent._persistNow = async () => true;
    let card = null;
    const result = await agent.executeTool(tabId, 'clarify', {
      question: 'Who should receive the message?', options: ['Ayşe', 'Mehmet'], purpose: 'message_recipient',
    }, (type, data) => {
      if (type !== 'clarify') return;
      card = data;
      agent.submitClarifyResponse(tabId, data.clarifyId, 'Ayşe', 'user');
    });
    assert.equal(card?.question, 'Who should receive the message?');
    assert.equal(result.success, true);
    assert.equal(result.answer, 'Ayşe');
    assert.equal(result.authorized, true);
    assert.equal('researchEscalationApproved' in result, false);
    const refused = await agent.executeTool(tabId, 'clarify', {
      question: 'Send this to ChatGPT?', options: ['Continue here', 'Use ChatGPT'],
      purpose: 'research_escalation', research_request: 'Compare fares.', approve_option: 'Use ChatGPT',
    }, () => assert.fail('a disabled research escalation must not show a card'));
    assert.equal(refused.success, false);
    assert.match(refused.error, /Research escalation is disabled/);
  });

  test(`${build}: Ask's research note asks for missing constraints in the answer, not with clarify`, () => {
    const ask = research.researchEscalationSystemNote('ask');
    assert.match(ask, /ask the user for it in your final answer/);
    assert.match(ask, /in Ask mode, clarify is only this ChatGPT consent card/);
    assert.doesNotMatch(ask, /Clarify any material missing constraint/);
    assert.doesNotMatch(ask, /require_explicit_answer/);
    assert.match(ask, /call clarify with purpose="research_escalation"/);
    for (const mode of ['act', 'dev']) {
      assert.equal(research.researchEscalationSystemNote(mode), research.RESEARCH_ESCALATION_SYSTEM_NOTE, mode);
    }
    assert.match(research.RESEARCH_ESCALATION_SYSTEM_NOTE, /Clarify any material missing constraint with the user instead of guessing it\./);

    const agent = new Agent({});
    agent.researchEscalationEnabled = true;
    const askPrompt = agent._buildSystemPrompt('ask', null);
    assert.ok(askPrompt.includes(ask), 'Ask prompt should carry the Ask note');
    assert.doesNotMatch(askPrompt, /Clarify any material missing constraint/);
    for (const mode of ['act', 'dev']) {
      assert.ok(agent._buildSystemPrompt(mode, null).includes(research.RESEARCH_ESCALATION_SYSTEM_NOTE), mode);
    }
    agent.researchEscalationEnabled = false;
    assert.doesNotMatch(agent._buildSystemPrompt('ask', null), /RESEARCH ESCALATION/);
  });

  test(`${build}: a new user turn restarts the timeout block count but keeps the guard armed`, async () => {
    const tabId = 6201;
    const agent = guardedAgent(Agent, tabId);
    await agent._recordClarificationAuthorization(tabId, 'timeout');
    assert.equal(agent._clarificationAuthorizationBlock(tabId, 'done', { outcome: 'success' }, []).stop, false);
    assert.equal(agent._clarificationAuthorizationGuards.get(tabId).blockedAttempts, 1);

    // Not the user's new turn: Continue, scheduled and cloud runs, and the
    // workflow-replay entry that passes no run options.
    for (const runOptions of [
      undefined,
      null,
      { trustedContinuation: true },
      { scheduledRun: true, independentRun: true },
      { scheduledRun: true, independentRun: true, scheduledResume: true },
      { cloudRun: true, independentRun: true },
      { cloudRun: true, trustedContinuation: true, scheduledResume: true },
      { interactiveChat: true, steeringRevision: 2 },
    ]) {
      agent._prepareClarificationAuthorizationForRun(tabId, runOptions);
      assert.equal(agent._clarificationAuthorizationGuards.get(tabId).blockedAttempts, 1, JSON.stringify(runOptions));
    }

    for (const runOptions of [{ interactiveChat: true, detachedRequestId: 'req-2' }, {}]) {
      agent._clarificationAuthorizationGuards.get(tabId).blockedAttempts = 1;
      agent._prepareClarificationAuthorizationForRun(tabId, runOptions);
      const guard = agent._clarificationAuthorizationGuards.get(tabId);
      assert.equal(guard.blockedAttempts, 0, JSON.stringify(runOptions));
      assert.equal(guard.source, 'timeout');
      assert.equal(guard.authorized, false, 'the guard itself must stay armed');
      assert.equal(agent._conversationStorageEntry(tabId).clarificationAuthorizationGuard.blockedAttempts, 0);
    }

    const first = agent._clarificationAuthorizationBlock(tabId, 'solve_captcha', {}, []);
    assert.equal(first.stop, false, 'the first block of the new turn must let the model ask again');
    assert.match(first.result.error, /Call clarify again/);
    assert.equal(agent._clarificationAuthorizationBlock(tabId, 'solve_captcha', {}, []).stop, true,
      'a repeated block in the same turn still stops');
  });

  test(`${build}: after an earlier blocked turn, the next turn's first blocked success asks again instead of stopping`, async () => {
    const tabId = 6301;
    const agent = guardedAgent(Agent, tabId);
    await agent._recordClarificationAuthorization(tabId, 'timeout');
    assert.deepEqual(await doneSuccessBatch(agent, tabId), { action: 'continue' });

    agent._prepareClarificationAuthorizationForRun(tabId, { interactiveChat: true });
    assert.deepEqual(await doneSuccessBatch(agent, tabId), { action: 'continue' });
    const repeated = await doneSuccessBatch(agent, tabId);
    assert.equal(repeated.action, 'return');
    assert.equal(repeated.status, 'clarification_required');

    // Continue resumes the same turn, so its count carries over unchanged.
    agent._prepareClarificationAuthorizationForRun(tabId, { trustedContinuation: true });
    assert.equal((await doneSuccessBatch(agent, tabId)).status, 'clarification_required');
  });

  test(`${build}: both run entry points hand their run options to the guard`, async () => {
    const agent = new Agent({});
    const tabId = 6401;
    agent._hydrate = async () => {};
    const seen = [];
    const sentinel = new Error('stop after guard preparation');
    agent._prepareClarificationAuthorizationForRun = (_tabId, runOptions) => {
      seen.push(runOptions);
      throw sentinel;
    };
    await assert.rejects(agent._processMessageInner(tabId, 'Check it.', () => {}, 'act', [], { scheduledRun: true, marker: 'inner' }), sentinel);
    await assert.rejects(agent._processMessageStreamInner(tabId, 'Check it.', () => {}, 'act', { interactiveChat: true, marker: 'stream' }), sentinel);
    assert.deepEqual(seen.map(options => options?.marker), ['inner', 'stream']);
    assert.equal(seen[0].scheduledRun, true);
  });

  test(`${build}: the system prompt announces an armed timeout guard only in Act and Dev`, async () => {
    const tabId = 6501;
    const agent = guardedAgent(Agent, tabId);
    assert.doesNotMatch(agent._buildSystemPrompt('act', tabId), STILL_REQUIRED);

    await agent._recordClarificationAuthorization(tabId, 'timeout');
    assert.match(agent.conversations.get(tabId)[0].content, STILL_REQUIRED, 'arming the guard refreshes the live system prompt');
    const actPrompt = agent._buildSystemPrompt('act', tabId);
    assert.match(actPrompt, STILL_REQUIRED);
    assert.match(actPrompt, /stay blocked until the user answers a clarify question directly; an automatic or timed-out choice is not the user's decision/);
    assert.match(actPrompt, /Before any consequential action, call clarify and wait for the answer/);
    assert.match(actPrompt, /if the user's latest message already gives that answer, offer it as the first option/);
    assert.match(agent._buildSystemPrompt('dev', tabId), STILL_REQUIRED);
    assert.doesNotMatch(agent._buildSystemPrompt('ask', tabId), STILL_REQUIRED, 'Ask has no ordinary clarify');

    agent.conversationIds.set(tabId, 'another_conversation');
    assert.doesNotMatch(agent._buildSystemPrompt('act', tabId), STILL_REQUIRED, 'a guard from another conversation is stale');
    agent.conversationIds.set(tabId, `conv_${tabId}`);

    // Only a direct answer on a clarify card clears the guard.
    await agent._recordClarificationAuthorization(tabId, 'user');
    assert.equal(agent._clarificationAuthorizationGuards.has(tabId), false);
    assert.doesNotMatch(agent.conversations.get(tabId)[0].content, STILL_REQUIRED, 'answering refreshes the live system prompt');
    assert.doesNotMatch(agent._buildSystemPrompt('act', tabId), STILL_REQUIRED);
  });

  test(`${build}: the guard line stays true when the scheduler armed it and nothing timed out`, async () => {
    const tabId = 6511;
    const agent = guardedAgent(Agent, tabId);
    agent._hydrate = async () => {};
    // The scheduler arms the guard before a run whose earlier action must be
    // reconciled; no clarify question was ever asked.
    await agent.requireExplicitClarificationAuthorization(tabId);
    const prompt = agent._buildSystemPrompt('act', tabId);
    const line = prompt.slice(prompt.indexOf('[CLARIFICATION STILL REQUIRED'));
    assert.match(line, STILL_REQUIRED);
    assert.doesNotMatch(line.slice(0, line.indexOf(']') + 1), /timed out without|earlier clarify question|call clarify again|answers that question/,
      'the line must not claim that an earlier question timed out');
  });

  test(`${build}: only a scheduled resume or an interactive run keeps the schedule_task requirement`, () => {
    const agent = new Agent({});
    const tabId = 6601;
    agent._persist = () => {};
    agent.conversationIds.set(tabId, `conv_${tabId}`);
    agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: 'In 30 minutes, remind me to take the pizza out.' }]);
    const gate = { proceed: true, requestKind: 'execute', requiresStateChange: true, requiredSchedulingTool: 'schedule_task' };
    for (const [runOptions, expected] of [
      // The stored prompt keeps the user's timing; requiring a schedule made
      // the run schedule its own task again, recurring or one-shot.
      [{ scheduledRun: true, independentRun: true, scheduledResume: false }, null],
      [{ scheduledRun: true, independentRun: true }, null],
      // A resume continues an interactive task that asked for a schedule.
      [{ scheduledRun: true, independentRun: true, scheduledResume: true }, 'schedule_task'],
      [{ interactiveChat: true }, 'schedule_task'],
    ]) {
      const guard = agent._startPlanExecutionGuard(tabId, 'act', gate, runOptions);
      assert.equal(guard.requiredSchedulingTool, expected, JSON.stringify(runOptions));
    }
  });

  test(`${build}: a scheduling tag forces a state change except in a scheduled task run`, () => {
    const parse = (overrides, options) => planner.parsePlanFromContent(JSON.stringify(plannerResult('execute', 'Remind the user to take the pizza out.', {
      requires_state_change: false,
      steps: [{ id: '1', action: 'Tell the user it is time to take the pizza out' }],
      scheduling: { tool: 'schedule_task', hint: 'In 30 minutes.' },
      ...overrides,
    })), { requireIntent: true, locale: 'en', ...options });
    const scheduledTask = { scheduledTask: true };
    // Interactive runs and scheduled resumes keep today's behaviour.
    assert.equal(parse({}, {}).requires_state_change, true);
    assert.equal(parse({}, { scheduledResume: true }).requires_state_change, true);
    // A scheduled task run executes the task that is already scheduled.
    const reminder = parse({}, scheduledTask);
    assert.equal(reminder.requires_state_change, false);
    assert.equal(reminder.scheduling?.tool, 'schedule_task', 'the tag itself is kept; the run just is not required to act on it');
    // The plan's own requirements still count.
    assert.equal(parse({ requires_submission: true }, scheduledTask).requires_state_change, true);
    assert.equal(parse({ completion_requirements: { download: true } }, scheduledTask).requires_state_change, true);
    assert.equal(parse({ scheduling: { tool: 'schedule_resume', hint: 'Wait.' } }, scheduledTask).requires_state_change, false);

    // The planner may also mark the reminder state-changing itself. When
    // every step declares only observing tools, the tag is all that is
    // behind that mark, and it is dropped.
    const observing = [
      { id: '1', action: 'Read the page', tools: ['read_page'] },
      { id: '2', action: 'Tell the user it is time to take the pizza out', tools: ['done'] },
    ];
    assert.equal(parse({ requires_state_change: true, steps: observing }, scheduledTask).requires_state_change, false);
    assert.equal(parse({ requires_state_change: true, steps: observing }, {}).requires_state_change, true, 'interactive runs are unchanged');
    assert.equal(parse({ requires_state_change: true, steps: observing }, { scheduledResume: true }).requires_state_change, true);
    // Anything else keeps it: steps without declared tools prove nothing,
    // and a mutating, network or schedule_task step is a state change of its own.
    assert.equal(parse({ requires_state_change: true }, scheduledTask).requires_state_change, true, 'no declared tools');
    for (const tool of ['click_ax', 'set_field', 'fetch_url', 'schedule_task', 'scratchpad_write']) {
      const steps = [observing[0], { id: '2', action: 'Do the task', tools: [tool] }];
      assert.equal(parse({ requires_state_change: true, steps }, scheduledTask).requires_state_change, true, tool);
    }
    assert.equal(parse({ requires_state_change: true, requires_submission: true, steps: observing }, scheduledTask).requires_state_change, true);
    assert.equal(parse({ requires_state_change: true, steps: observing, completion_requirements: { download: true } }, scheduledTask).requires_state_change, true);
    assert.equal(parse({ requires_state_change: true, steps: observing, scheduling: null }, scheduledTask).requires_state_change, true,
      'without a scheduling tag the mark is the planner\'s own');

    // An unattended job must not lose the requirement to anything the
    // normalized plan hides: the raw plan is read, and doubt keeps the mark.
    const marked = steps => parse({ requires_state_change: true, steps }, scheduledTask).requires_state_change;
    const reads = count => Array.from({ length: count }, (_, i) => ({ id: String(i + 1), action: `Read part ${i + 1}`, tools: ['read_page'] }));
    assert.equal(marked(reads(12)), false, 'twelve observing steps are all visible');
    assert.equal(marked([...reads(12), { id: '13', action: 'Archive the newsletter', tools: ['click_ax'] }]), true,
      'a mutating 13th step is cut from the normalized plan');
    assert.equal(marked([...reads(12), { id: '13', action: 'Read once more', tools: ['read_page'] }]), true, 'anything cut keeps the mark');
    const eightReads = Array.from({ length: 8 }, () => 'read_page');
    assert.equal(marked([{ id: '1', action: 'Read the page', tools: eightReads }]), false);
    assert.equal(marked([{ id: '1', action: 'Read, then archive', tools: [...eightReads, 'click_ax'] }]), true,
      'a mutating 9th tool is cut from the normalized step');
    assert.equal(marked([observing[0], { id: '2', action: '', tools: ['click_ax'] }]), true, 'a step without an action is dropped');
    assert.equal(marked([observing[0], { id: '2', action: '   ', tools: ['read_page'] }]), true);
    assert.equal(marked([observing[0], { id: '2', tools: ['read_page'] }]), true, 'missing action');
    assert.equal(marked([observing[0], { id: '2', action: 'Report', tools: [' read_page'] }]), true, 'unknown tool name');
    const keep = overrides => parse({ requires_state_change: true, steps: observing, ...overrides }, scheduledTask).requires_state_change;
    assert.equal(keep({ requires_submission: undefined }), true, 'submission must be explicitly false');
    assert.equal(keep({ requires_submission: null }), true);
    assert.equal(keep({ messaging: { target_kind: 'named', recipients: [{ identity: 'Ayşe', role: 'to' }] } }), true, 'a message target');
    assert.equal(keep({ memory: { progress_action: 'unfollow' } }), true, 'a progress action');
    assert.equal(keep({ skill_ids: ['gmail'] }), true, 'an activated skill');
    assert.equal(keep({ site_job: 'Not A Valid Job' }), true, 'any site job, even one normalization drops');
    assert.equal(keep({}), false, 'the simple read-only reminder still loses the mark');
  });

  test(`${build}: the planner is told a scheduled task run executes an existing task, on every planner call`, async () => {
    const RULE = /This run is the app-owned scheduled execution of an existing task\. Its schedule already exists/;
    for (const plannerMode of ['off', 'try']) {
      for (const [runOptions, expectsRule, expectsResumeRule] of [
        [{ scheduledRun: true, independentRun: true, scheduledResume: false }, true, false],
        [{ scheduledRun: true, independentRun: true, scheduledResume: true }, false, true],
        [{}, false, false],
      ]) {
        const agent = plannerAgent(Agent, plannerResult('clarify', 'Which account should I check?'), plannerMode);
        const systems = [];
        // The first reply is unparseable, so the planner's repair call runs too.
        agent._chatWithCostAllowance = async (_provider, messages, _options, _cost, meta) => {
          assert.match(meta?.generationName || '', /^planner/);
          systems.push(messages.find(message => message.role === 'system')?.content || '');
          return { content: systems.length === 1 ? 'not json' : JSON.stringify(plannerResult('clarify', 'Which account should I check?')) };
        };
        await agent.processMessage(6901, 'In 30 minutes, remind me to check my account balance.', () => {}, 'act', [], runOptions);
        const label = `${plannerMode} ${JSON.stringify(runOptions)}`;
        assert.equal(systems.length, 2, label);
        for (const system of systems) {
          assert.equal(RULE.test(system), expectsRule, label);
          assert.equal(/This run is an app-owned scheduled continuation/.test(system), expectsResumeRule, label);
        }
      }
    }
  });

  // One scheduled one-shot run through the real scheduler, planner gate (Try
  // planning), plan guard, run loop and done/schedule_task tools. Only the
  // model's replies, page reads and storage are scripted.
  async function scheduledRunEndToEnd({ prompt, plan, script }) {
    const NOW = Date.UTC(2026, 9, 15, 9, 0, 0);
    const provider = { name: 'owned', model: 'owned', promptTier: 'full', contextWindow: 128000, supportsTools: true, supportsVision: false };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    const replies = [...script];
    const toolResults = [];
    Object.assign(agent, {
      _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
      _startTraceRun: async () => null, _endTraceRun: async () => {},
      _enrichUserMessageWithCurrentPage: async (_tab, _messages, content) => ({ role: 'user', content }),
      _beginReadCompleteness: async () => null, _manageContext: async () => {},
      _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
      _currentUrl: async () => 'https://example.com/', _getTabUrlTitle: async () => ({ tabUrl: 'https://example.com/', tabTitle: 'Example' }),
      _plannerMode: () => 'try', _ensureGateSetting: async () => true, _skipPermissionGate: true,
      _semanticDecision: async () => ({ choice: 'answer' }),
      _chatWithCostAllowance: async (_provider, _messages, _options, _cost, meta) => {
        const name = meta?.generationName || 'chat';
        if (/^planner/.test(name)) return { content: JSON.stringify(plan) };
        assert.equal(name, 'main', `unexpected model call ${name}`);
        const [tool, toolArgs] = replies.shift() || assert.fail('the run asked the model for another step');
        return { content: '', toolCalls: [{ id: `call_${script.length - replies.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify(toolArgs) } }] };
      },
    });
    // The run removes its plan guard when it ends; keep the one it started.
    const startGuard = agent._startPlanExecutionGuard.bind(agent);
    let guard = null;
    agent._startPlanExecutionGuard = (...guardArgs) => (guard = startGuard(...guardArgs));
    const realExecute = agent.executeTool.bind(agent);
    agent.executeTool = (tab, name, toolArgs, ...rest) => (name === 'read_page'
      ? Promise.resolve({ success: true, content: 'Example page.' })
      : realExecute(tab, name, toolArgs, ...rest));
    const h = makeSchedulerHarness(Scheduler, {
      now: NOW,
      processMessage: (...runArgs) => agent.processMessage(...runArgs),
      setScheduledRunPolicy: (tabId, policy) => agent.setScheduledRunPolicy(tabId, policy),
      clearScheduledRunPolicy: tabId => agent.clearScheduledRunPolicy(tabId),
    });
    h.manager.sendUpdate = (_tabId, type, data) => { if (type === 'tool_result') toolResults.push({ name: data?.name, result: data?.result }); };
    agent.scheduler = h.manager;
    const once = await h.manager.createTaskJob({
      tabId: 77, conversationId: 'conv-1',
      args: { title: 'One-shot', prompt, schedule: { type: 'once', after_seconds: 60 }, target: { type: 'current_tab' } },
    });
    h.setNow(NOW + 60 * 1000);
    await h.manager.handleAlarm(h.alarmName(once.jobId));
    assert.equal(replies.length, 0, 'the scripted run used every reply');
    return { h, once, agent, guard, toolResults, job: h.jobs().find(job => job.id === once.jobId) };
  }

  const pizzaPlan = plannerResult('execute', 'Remind the user to take the pizza out.', {
    requires_state_change: false,
    steps: [{ id: '1', action: 'Tell the user it is time to take the pizza out' }],
    scheduling: { tool: 'schedule_task', hint: 'The user asked for a reminder in 30 minutes.' },
  });
  const NEUTRAL = /This run is the scheduled execution of an existing task; do not schedule this task again\. Create a different schedule only if the task explicitly asks to set one up\./;

  test(`${build}: a scheduled reminder finishes with success without a mutating tool`, async () => {
    const reminder = 'In 30 minutes, remind me to take the pizza out.';
    const { h, once, agent, guard, toolResults, job } = await scheduledRunEndToEnd({
      prompt: reminder, plan: pizzaPlan,
      script: [['read_page', {}], ['done', { summary: 'Time to take the pizza out!', outcome: 'success' }]],
    });
    assert.equal(guard?.requiredSchedulingTool, null);
    assert.equal(guard?.requiresStateChange, false, 'the scheduling tag no longer forces a state change');
    const dones = toolResults.filter(entry => entry.name === 'done');
    assert.equal(dones.length, 1, 'the first done(success) is accepted');
    assert.equal(dones[0].result?.done, true, JSON.stringify(dones[0].result));
    assert.equal(dones[0].result?.outcome, 'success');
    assert.equal(guard.successfulConsequentialToolCalls, 0, 'no mutating tool ran');
    assert.equal(job.status, 'completed');
    assert.equal(job.lastOutcome, 'success');
    assert.deepEqual(h.jobs().map(candidate => candidate.id), [once.jobId], 'no new schedule');
    assert.match(agent.conversations.get(77).find(message => message.role === 'user')?.content || '', NEUTRAL);
  });

  test(`${build}: a scheduled reminder the planner marked state-changing still finishes with success after a read`, async () => {
    const { h, once, guard, toolResults, job } = await scheduledRunEndToEnd({
      prompt: 'In 30 minutes, remind me to take the pizza out.',
      plan: { ...pizzaPlan, requires_state_change: true, steps: [
        { id: '1', action: 'Read the page', tools: ['read_page'] },
        { id: '2', action: 'Tell the user it is time to take the pizza out', tools: ['done'] },
      ] },
      script: [['read_page', {}], ['done', { summary: 'Time to take the pizza out!', outcome: 'success' }]],
    });
    assert.equal(guard?.requiresStateChange, false);
    const dones = toolResults.filter(entry => entry.name === 'done');
    assert.equal(dones.length, 1, 'the first done(success) is accepted');
    assert.equal(dones[0].result?.outcome, 'success');
    assert.equal(guard.successfulConsequentialToolCalls, 0);
    assert.equal(job.lastOutcome, 'success');
    assert.deepEqual(h.jobs().map(candidate => candidate.id), [once.jobId]);
  });

  test(`${build}: a scheduled reminder that skips its read is asked for a read, not a mutation`, async () => {
    const { toolResults, job } = await scheduledRunEndToEnd({
      prompt: 'In 30 minutes, remind me to take the pizza out.', plan: pizzaPlan,
      script: [
        ['done', { summary: 'Time to take the pizza out!', outcome: 'success' }],
        ['read_page', {}],
        ['done', { summary: 'Time to take the pizza out!', outcome: 'success' }],
      ],
    });
    const dones = toolResults.filter(entry => entry.name === 'done');
    assert.equal(dones[0].result?.blockedDone, true);
    // The nudge's first line is the block; the task anchor after it quotes
    // the approved plan, scheduling tag included.
    const block = String(dones[0].result?.error || '').split('\n')[0];
    assert.match(block, /no successful task tool was verified\. Use a permitted task tool first/);
    assert.doesNotMatch(block, /state-changing|mutating tool|schedule_task/);
    assert.equal(dones[1].result?.outcome, 'success');
    assert.equal(job.lastOutcome, 'success');
  });

  test(`${build}: a scheduled task whose plan requires a submission still needs it`, async () => {
    const { h, once, guard, toolResults, job } = await scheduledRunEndToEnd({
      prompt: 'In 30 minutes, send the weekly report to the team channel.',
      plan: plannerResult('execute', 'Send the weekly report to the team channel.', {
        requires_state_change: false,
        requires_submission: true,
        read_scope: 'visible_page',
        steps: [{ id: '1', action: 'Post the weekly report in the team channel and send it', tools: ['type_text', 'click'] }],
        scheduling: { tool: 'schedule_task', hint: 'The user asked for this in 30 minutes.' },
      }),
      script: [
        ['read_page', {}],
        ['done', { summary: 'Sent the weekly report.', outcome: 'success' }],
        ['done', { summary: 'The report was not sent yet.', outcome: 'partial' }],
      ],
    });
    assert.equal(guard?.requiresStateChange, true, 'the plan\'s own submission still requires a state change');
    assert.equal(guard?.requiresSubmission, true);
    const dones = toolResults.filter(entry => entry.name === 'done');
    assert.equal(dones[0].result?.blockedDone, true, 'success without the submission is refused');
    assert.match(String(dones[0].result?.error || ''), /submit\/send\/publish\/commit/);
    assert.equal(dones[1].result?.outcome, 'partial');
    assert.equal(job.lastOutcome, 'partial');
    assert.deepEqual(h.jobs().map(candidate => candidate.id), [once.jobId]);
  });

  test(`${build}: a one-shot run that sets up a different schedule can still call schedule_task`, async () => {
    const { h, once, guard, toolResults, job } = await scheduledRunEndToEnd({
      prompt: 'On Monday at 9, start an hourly check of the releases page.',
      plan: plannerResult('execute', 'Start an hourly check of the releases page.', {
        requires_state_change: true,
        steps: [{ id: '1', action: 'Create the hourly check', tools: ['schedule_task'] }],
        scheduling: { tool: 'schedule_task', hint: 'Every 60 minutes.' },
      }),
      script: [
        ['schedule_task', {
          title: 'Hourly releases check', prompt: 'Check the releases page for a new release.',
          schedule: { type: 'recurring', after_seconds: 60, interval_minutes: 60 },
          target: { type: 'url', url: 'https://example.com/releases' },
        }],
        ['done', { summary: 'Started the hourly check.', outcome: 'success' }],
      ],
    });
    assert.equal(guard?.requiredSchedulingTool, null);
    const scheduled = toolResults.find(entry => entry.name === 'schedule_task')?.result;
    assert.equal(scheduled?.success, true, JSON.stringify(scheduled));
    assert.equal(scheduled?.scheduled, true);
    const hourly = h.jobs().find(candidate => candidate.id !== once.jobId);
    assert.ok(hourly, 'the run created the hourly schedule');
    assert.equal(hourly.schedule.type, 'recurring');
    assert.equal(hourly.schedule.interval_minutes, 60);
    assert.equal(hourly.status, 'pending');
    assert.ok(h.alarms.has(h.alarmName(hourly.id)));
    const dones = toolResults.filter(entry => entry.name === 'done');
    assert.equal(dones.length, 1, 'done(success) is accepted once the schedule exists');
    assert.equal(dones[0].result?.outcome, 'success');
    assert.equal(job.lastOutcome, 'success');
  });

  test(`${build}: a run the user starts again after a stop gets a fresh blocked-attempt count`, async () => {
    const tabId = 6801;
    const agent = guardedAgent(Agent, tabId);
    agent._hydrate = async () => {};
    const scheduled = { scheduledRun: true, independentRun: true, scheduledResume: false };
    // The stopped run: a timed-out question, a blocked action, another
    // timeout, and a second blocked action that stops the run.
    await agent._recordClarificationAuthorization(tabId, 'timeout');
    assert.equal(agent._clarificationAuthorizationBlock(tabId, 'solve_captcha', {}, []).stop, false);
    await agent._recordClarificationAuthorization(tabId, 'timeout');
    assert.equal(agent._clarificationAuthorizationBlock(tabId, 'solve_captcha', {}, []).stop, true);

    // Re-arming without the option keeps the count (a model must not loop by
    // re-asking within one run).
    await agent.requireExplicitClarificationAuthorization(tabId);
    assert.equal(agent._clarificationAuthorizationGuards.get(tabId).blockedAttempts, 2);

    // The user's Run now: the scheduler re-arms with a fresh count.
    await agent.requireExplicitClarificationAuthorization(tabId, { freshAttempt: true });
    agent._prepareClarificationAuthorizationForRun(tabId, scheduled);
    const guard = agent._clarificationAuthorizationGuards.get(tabId);
    assert.equal(guard.source, 'timeout');
    assert.equal(guard.authorized, false, 'the guard stays armed');
    assert.equal(guard.blockedAttempts, 0);
    const first = agent._clarificationAuthorizationBlock(tabId, 'solve_captcha', {}, []);
    assert.equal(first.stop, false, 'the first blocked action lets the model ask again');
    assert.match(first.result.error, /Call clarify again/);
    assert.equal(agent._clarificationAuthorizationBlock(tabId, 'solve_captcha', {}, []).stop, true);
  });

  const scheduledRunOptions = finishes => ({
    scheduledRun: true, independentRun: true, scheduledResume: false,
    onRunFinished: (...args) => finishes.push(args),
  });
  const scheduledMessage = '[Scheduled task task_1: Check account]\nTask: Every 5 minutes, check my account balance.';

  for (const plannerMode of ['off', 'try']) {
    test(`${build}: a real planner question (${plannerMode}) reports that the run ended waiting for the user`, async () => {
      const tabId = 6701;
      const agent = plannerAgent(Agent, plannerResult('clarify', 'Which account should I check?'), plannerMode);
      const finishes = [];
      const answer = await agent.processMessage(tabId, scheduledMessage, () => {}, 'act', [], scheduledRunOptions(finishes));
      assert.match(answer, /Which account should I check\?/);
      assert.deepEqual(agent.plannerCalls, [plannerMode === 'off' ? 'planner_intent' : 'planner'], 'the real planner gate ran');
      // The end details also say whether the run was lean (lean-mode.js);
      // this owned provider is not a strong cloud model, so it was not.
      assert.deepEqual(finishes, [['clarify', { needsUserInput: true, leanMode: false }]]);

      // The streaming entry point reports the same way.
      const streamAgent = plannerAgent(Agent, plannerResult('clarify', 'Which account should I check?'), plannerMode);
      const streamFinishes = [];
      await streamAgent.processMessageStream(tabId, scheduledMessage, () => {}, 'act', { onRunFinished: (...args) => streamFinishes.push(args) });
      assert.deepEqual(streamFinishes, [['clarify', { needsUserInput: true, leanMode: false }]]);
    });
  }

  test(`${build}: an unverified recipient question also reports that the run is waiting for the user`, async () => {
    const tabId = 6702;
    // "Send it in the open conversation" when the open conversation has no
    // single verified recipient: the real planner gate ends the run with a
    // question to the user under another status. Only the page probe is
    // replaced.
    const agent = plannerAgent(Agent, plannerResult('execute', 'Send the balance to the open conversation.', {
      requires_submission: true,
      read_scope: 'visible_page',
      steps: [{ id: '1', action: 'Type the balance into the open conversation and send it', tools: ['type_text', 'click'] }],
      messaging: { target_kind: 'active_conversation', recipients: [] },
    }), 'off');
    const messagingUrl = 'https://www.linkedin.com/messaging/thread/example/';
    agent._getTabUrlTitle = async () => ({ tabUrl: messagingUrl, tabTitle: 'Messaging' });
    agent._currentUrl = async () => messagingUrl;
    agent._messageRecipientGuardProbe = async () => ({ success: true, conclusive: false, composerAvailable: true, recipients: [] });
    const finishes = [];
    const answer = await agent.processMessage(tabId, scheduledMessage, () => {}, 'act', [], scheduledRunOptions(finishes));
    assert.match(answer, /could not pin the currently open conversation to one verified recipient/);
    assert.deepEqual(finishes, [['active_recipient_unverified', { needsUserInput: true, leanMode: false }]]);
  });

  test(`${build}: other planner endings do not claim the user is needed`, async () => {
    for (const [plannerMode, plan, status] of [
      ['off', plannerResult('plan_only', 'Outline the account check.'), 'plan_only_output'],
      // Strict planning's failure carries requestKind "clarify", but it is a
      // planner error, not a question for the user.
      ['strict', 'not a plan', 'planner_error'],
    ]) {
      const agent = plannerAgent(Agent, plan, plannerMode);
      const finishes = [];
      await agent.processMessage(6703, scheduledMessage, () => {}, 'act', [], scheduledRunOptions(finishes));
      assert.deepEqual(finishes, [[status, { needsUserInput: false, leanMode: false }]], plannerMode);
    }
  });

  test(`${build}: a real planner question pauses a recurring scheduled task, not a one-shot one`, async () => {
    const NOW = Date.UTC(2026, 9, 15, 9, 0, 0);
    const agent = plannerAgent(Agent, plannerResult('clarify', 'Which account should I check?'), 'off');
    const h = makeSchedulerHarness(Scheduler, { now: NOW, processMessage: (...args) => agent.processMessage(...args) });
    const recurring = await h.manager.createTaskJob({
      tabId: 77, conversationId: 'conv-1',
      args: { title: 'Check account', prompt: 'Check my account balance.', schedule: { type: 'recurring', after_seconds: 60, interval_minutes: 5 }, target: { type: 'current_tab' } },
    });
    h.setNow(NOW + 60 * 1000);
    await h.manager.handleAlarm(h.alarmName(recurring.jobId));
    const job = h.jobs().find(candidate => candidate.id === recurring.jobId);
    assert.equal(job.status, 'paused');
    assert.equal(job.pausedBy, 'scheduler');
    assert.match(job.lastResult, /Which account should I check\?/);
    assert.match(job.lastError, /needs information only you can give/);
    assert.equal(h.alarms.has(h.alarmName(recurring.jobId)), false);

    const once = await h.manager.createTaskJob({
      tabId: 77, conversationId: 'conv-1',
      args: { title: 'Check once', prompt: 'Check my account balance once.', schedule: { type: 'once', after_seconds: 60 }, target: { type: 'current_tab' } },
    });
    h.setNow(NOW + 120 * 1000);
    await h.manager.handleAlarm(h.alarmName(once.jobId));
    assert.equal(h.jobs().find(candidate => candidate.id === once.jobId).status, 'completed');
  });
}
