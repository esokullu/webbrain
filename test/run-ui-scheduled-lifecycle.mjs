import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Journal: (await import(`../src/${build}/src/run-ui-journal.js`)).RunUiJournal,
  compactRunUiSnapshotForPersist: (await import(`../src/${build}/src/run-ui-journal.js`)).compactRunUiSnapshotForPersist,
  persistRetryBudget: (await import(`../src/${build}/src/run-ui-journal.js`)).RUN_UI_PERSIST_RETRY_BUDGET,
  runUiUpdatesForCurrentTask: (await import(`../src/${build}/src/run-ui-journal.js`)).runUiUpdatesForCurrentTask,
  runDetachedWithReconnect: (await import(`../src/${build}/src/run-reconnect.js`)).runDetachedWithReconnect,
  scheduler: await import(`../src/${build}/src/agent/scheduler.js`),
  source: fs.readFileSync(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8'),
  panelSource: fs.readFileSync(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8'),
})));

function section(source, from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `Missing production function ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `Missing function boundary ${to}`);
  return source.slice(start, end);
}

function backgroundHarness({ Journal, source, runUiUpdatesForCurrentTask }, options = {}) {
  const stored = new Map(), messages = [], attention = [];
  const journal = new Journal({ onChange: (tabId, snapshot) => stored.set(tabId, structuredClone(snapshot)) });
  const agent = {
    currentRunId: new Map([[77, 'current-runtime-run']]),
    hasDurableSubmittedTurn: options.hasDurableSubmittedTurn || (async () => true),
  };
  const context = vm.createContext({
    runUiJournal: journal, agent, runUiPersistenceFailures: new Map(),
    runUiUpdatesForCurrentTask,
    runUiSnapshotReads: new Map(), runUiPersistenceQueues: new Map(), RUN_UI_PREFIX: 'runUi:',
    runUiSnapshotPersistence: { cancel() {} },
    chrome: {
      runtime: { sendMessage: async message => { messages.push(structuredClone(message)); } },
      storage: { session: {
        get: async key => ({ [key]: structuredClone(stored.get(Number(key.split(':')[1]))) }),
        remove: async key => { stored.delete(Number(key.split(':')[1])); },
      } },
    },
    flashTabAttention: async value => { attention.push(value); },
    flushRunUiSnapshot: options.flushRunUiSnapshot || (async () => true),
    console, Date, Promise,
  });
  context.browser = context.chrome;
  const functions = [
    section(source, 'function beginRunUiSnapshot(', 'function recordRunUiEvent('),
    section(source, 'function recordRunUiEvent(', 'function isClarificationRequiredRunUpdate('),
    section(source, 'function isClarificationRequiredRunUpdate(', 'function finishRunUiSnapshot('),
    section(source, 'function finishRunUiSnapshot(', '// Mirror the sidepanel'),
    section(source, 'const BADGE_SUBSCRIBE_ERROR_RE', 'async function getRunUiSnapshot('),
    section(source, 'async function getRunUiSnapshot(', 'function sendAgentUpdate('),
    section(source, 'function sendAgentUpdate(', 'function assertNoActiveTabRun('),
    section(source, 'async function sendAgentRunComplete(', '// Stop button on the page'),
  ];
  vm.runInContext(functions.join('\n'), context);
  return { journal, stored, messages, attention, context, agent };
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing production function ${name}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Missing production function end ${name}`);
}

function panelCompletionHarness({ panelSource, runUiUpdatesForCurrentTask }) {
  const context = vm.createContext({ runUiUpdatesForCurrentTask,
    parseSubscribeError: () => null, parseCostAllowanceError: () => null });
  const names = ['isSuccessfulDoneUpdate', 'updatesContainSuccessfulDone', 'updatesContainStoreReviewFailure', 'isSuccessfulAskCompletion'];
  if (panelSource.includes('function updatesContainActFailure(')) names.push('updatesContainActFailure');
  if (panelSource.includes('function isSuccessfulActCompletion(')) names.push('isSuccessfulActCompletion');
  vm.runInContext(names.map(name => functionSource(panelSource, name)).join('\n'), context);
  const assignment = panelSource.match(/^\s+completedSuccessfully = [^\n]+;$/m)?.[0];
  assert.ok(assignment, 'Missing actual returned-response completion classification');
  return { context, classifyAct(response) {
    context.res = response;
    vm.runInContext(assignment, context);
    return context.completedSuccessfully;
  } };
}

const done = { name: 'done', result: { done: true, success: true, outcome: 'success', summary: 'Owned task completed.' } };
const scope = (executionId = 'execution-1', jobId = 'job-1', mode = 'act') => ({ jobId, executionId, mode, kind: 'resume' });
const jobEvent = (event, owner, extra = {}) => ({ event, job: { id: owner.jobId, kind: owner.kind, status: event === 'running' ? 'running' : 'completed', lastOutcome: 'success', lastResult: 'Owned task completed.', ...extra } });
const flushMicrotasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function scheduledUiHarness(item, processMessage, options = {}) {
  const ui = backgroundHarness(item);
  const scheduler = makeSchedulerHarness(item.scheduler, {
    ...options,
    jobs: options.jobs || [{ id: 'owned-resume', kind: 'resume', status: 'pending', tabId: 77,
      conversationId: 'conv-1', resumeTaskId: 'original-task-id', mode: options.mode || 'act',
      reason: 'Owned fixture', resumeInstruction: 'Observe the owned fixture.',
      scheduledAt: '2026-01-01T12:00:00.000Z' }],
    processMessage,
  });
  scheduler.manager.agent.systemOneContext = options.systemOneContext || (() => ({ isCurrent: () => true }));
  scheduler.manager.sendUpdate = (tabId, type, data, owner) => ui.context.sendScheduledAgentUpdate(tabId, type, data, owner);
  return { ui, scheduler, async run() {
    await scheduler.manager.handleAlarm(scheduler.alarmName(scheduler.jobs()[0].id));
    await flushMicrotasks();
    return scheduler.jobs()[0];
  } };
}

for (const item of builds) {
  test(`${item.build}: a scheduled visual pause stays pending through public delivery and cold reconnect`, async () => {
    const h = backgroundHarness(item);
    const requestId = 'visual-scheduled-pause';
    const updates = [{ type: 'run_status', data: { status: 'scheduled', message: 'Scheduled a resume in 60 seconds.' } }];
    h.context.beginRunUiSnapshot(77, requestId, { mode: 'dev', kind: 'chat' });
    for (const event of updates) h.context.recordRunUiEvent(77, requestId, event.type, event.data);
    const status = h.context.terminalRunUiStatus(updates[0].data.message, updates);
    assert.equal(status, 'scheduled');
    assert.equal(h.context.runUpdatesSucceeded(updates), false, 'A scheduled pause is not completed task memory');
    assert.equal(h.context.terminalRunUiStatus('Stopped by user', updates), 'stopped');
    assert.equal(h.context.terminalRunUiStatus('Failed', [...updates, { type: 'error', data: { message: 'Failed' } }]), 'failed');
    const terminal = h.context.finishRunUiSnapshot(77, requestId, status, updates[0].data.message);
    await h.context.sendAgentRunComplete(77, terminal);
    assert.equal(terminal.runSucceeded, false);
    assert.equal(h.messages.at(-1).type, 'run_complete');
    assert.equal(h.messages.at(-1).data.status, 'scheduled');
    const cold = backgroundHarness(item);
    const restored = cold.journal.restore(77, JSON.parse(JSON.stringify(item.compactRunUiSnapshotForPersist(h.stored.get(77)))));
    const replay = await item.runDetachedWithReconnect({
      initialAction: 'chat_start', payload: { requestId },
      start: async () => ({ accepted: true, requestId }),
      probe: async () => ({ submittedTurnDurable: true, runUi: restored }),
      wait: async () => {}, pollIntervalMs: 0,
    });
    assert.equal(replay.runStatus, 'scheduled'); assert.equal(replay.success, false);
    assert.equal(replay.hadError, false); assert.equal(replay.content, updates[0].data.message);
    const panel = vm.createContext({});
    vm.runInContext(['isTerminalRunUiStatus', 'isFinishedRunUiStatus'].map(name => functionSource(item.panelSource, name)).join('\n'), panel);
    assert.equal(panel.isTerminalRunUiStatus('scheduled'), true);
    assert.equal(panel.isFinishedRunUiStatus('scheduled'), false, 'The panel must not claim the final result is complete');
    const owner = scope('next-resume', 'child-job', 'dev');
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', owner), owner);
    assert.equal(h.journal.get(77).scheduledExecutionId, 'next-resume', 'The alarm must be able to claim the paused foreground tab');
  });

  test(`${item.build}: exact typed table JSON survives terminal delivery, both persistence modes and cold replay`, async () => {
    const rows = Array.from({ length: 85 }, (_, index) => ({ id: index, amount: index % 2 ? -2.5 : 0,
      label: 'Original café ı漢字 "quoted" C:\\owned\\table ' + 'literal '.repeat(12),
      active: index % 2 === 0, optional: null }));
    const expected = { rowCount: rows.length, rows };
    const content = JSON.stringify(expected);
    assert.ok(content.length > 8000 && content.length <= 30000, `Fixture length ${content.length}`);
    const h = backgroundHarness(item);
    h.journal.begin(77, 'exact-table-request', { mode: 'act' });
    h.journal.record(77, 'exact-table-request', 'tool_result', done);
    const terminal = h.context.finishRunUiSnapshot(77, 'exact-table-request', 'completed', content);
    await h.context.sendAgentRunComplete(77, terminal);
    assert.ok(terminal.finalContent === content, 'The ordinary terminal must be complete.');
    assert.ok(terminal.events.at(-1).data.finalContent === content, 'The journal terminal event must be complete.');
    assert.ok(h.messages.at(-1).data.finalContent === content, 'The ordinary public terminal must be complete.');
    const normal = item.compactRunUiSnapshotForPersist(h.stored.get(77));
    const tight = item.compactRunUiSnapshotForPersist(normal, { tight: true });
    for (const persisted of [normal, tight]) {
      assert.ok(persisted.finalContent === content, 'Both persistence modes must preserve the complete final.');
      assert.ok(persisted.events.at(-1).data.finalContent === content, 'The persisted event must remain complete.');
      const cold = backgroundHarness(item);
      const restored = cold.journal.restore(77, JSON.parse(JSON.stringify(persisted)));
      await cold.context.sendAgentRunComplete(77, restored);
      const replay = cold.messages.at(-1).data.finalContent;
      assert.ok(replay === content, 'Cold replay must preserve the exact JSON string.');
      assert.equal(Buffer.compare(Buffer.from(replay, 'utf8'), Buffer.from(content, 'utf8')), 0, 'Replay must match the original UTF-8 bytes.');
      assert.deepEqual(JSON.parse(replay), expected, 'Numbers, nulls, booleans and literal strings stay typed.');
      assert.equal(restored.runSucceeded, true);
      cold.journal.acknowledge(77, restored.requestId, restored.seq);
      const acknowledged = item.compactRunUiSnapshotForPersist(cold.journal.get(77), { tight: true });
      assert.deepEqual(acknowledged.events, [], 'Replay must also work after the terminal event was acknowledged.');
      const nextCold = backgroundHarness(item);
      const restoredWithoutEvents = nextCold.journal.restore(77, JSON.parse(JSON.stringify(acknowledged)));
      await nextCold.context.sendAgentRunComplete(77, restoredWithoutEvents);
      assert.ok(nextCold.messages.at(-1).data.finalContent === content, 'Acknowledged replay must retain the full final.');
    }
    assert.ok(h.stored.get(77).finalContent === content, 'Compaction must not mutate the live terminal.');
  });

  test(`${item.build}: table retention honors the existing 30000 character boundary and cannot grant success`, () => {
    const empty = JSON.stringify({ rowCount: 1, rows: [{ literal: '' }] });
    const content = JSON.stringify({ rowCount: 1, rows: [{ literal: 'x'.repeat(30000 - empty.length) }] });
    assert.equal(content.length, 30000);
    const h = backgroundHarness(item);
    for (const status of ['completed', 'failed', 'stopped']) {
      h.journal.begin(77, 'unverified-table-request', { mode: 'act' });
      const terminal = h.context.finishRunUiSnapshot(77, 'unverified-table-request', status, content);
      const persisted = item.compactRunUiSnapshotForPersist(terminal, { tight: true });
      assert.ok(persisted.finalContent === content, 'The existing 30000 character capacity must be retained.');
      assert.equal(persisted.status, status);
      assert.equal(persisted.successfulDone, false);
      assert.equal(persisted.runSucceeded, false, 'Table formatting cannot serve as execution evidence.');
      assert.ok(JSON.stringify(persisted).length <= item.persistRetryBudget);
    }
  });

  test(`${item.build}: malformed, mismatched, oversized and generic finals keep ordinary tight bounds`, () => {
    const literal = 'x'.repeat(10000);
    const contents = [
      '{"rowCount":1,"rows":[' + literal,
      JSON.stringify({ rowCount: 2, rows: [{ literal }] }),
      JSON.stringify({ rowCount: '1', rows: [{ literal }] }),
      JSON.stringify({ rowCount: 1.5, rows: [{ literal }] }),
      JSON.stringify({ rowCount: 1, rows: [literal] }),
      JSON.stringify({ rowCount: 1, rows: [{ nested: { literal } }] }),
      JSON.stringify({ rowCount: 1, rows: [{ literal }], message: 'Other response shape' }),
      JSON.stringify([{ rowCount: 1, rows: [{ literal }] }]),
      JSON.stringify({ rowCount: 1, rows: [{ literal: 'x'.repeat(30001) }] }),
      '{"rowCount":1,"rows":[{"number":1e309,"literal":"' + literal + '"}]}',
      JSON.stringify({ message: literal }),
      'Ordinary prose. '.repeat(2000),
    ];
    for (const content of contents) {
      const snapshot = { finalContent: content, streamedText: 'stream'.repeat(20000),
        events: Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, type: 'text', data: { content: literal } })) };
      const normal = item.compactRunUiSnapshotForPersist(snapshot);
      const tight = item.compactRunUiSnapshotForPersist(normal, { tight: true });
      assert.equal(normal.finalContent, content.slice(0, 30000));
      assert.equal(tight.finalContent, content.slice(0, 8000));
      assert.ok(tight.streamedText.length <= 30000);
      assert.ok(tight.events.length <= 64);
      assert.ok(tight.events.every(event => event.data.content.length <= 4000));
      assert.ok(JSON.stringify(tight).length <= item.persistRetryBudget);
      assert.equal(snapshot.finalContent, content);
    }
  });

  test(`${item.build}: terminal success is persisted before the finish callback and survives restore`, () => {
    const h = backgroundHarness(item);
    h.journal.begin(77, 'direct-request', { mode: 'act' });
    h.journal.record(77, 'direct-request', 'tool_result', done);
    const live = h.context.finishRunUiSnapshot(77, 'direct-request', 'completed', 'Owned task completed.');
    assert.equal(live.successfulDone, true);
    assert.equal(live.runSucceeded, true);
    assert.equal(h.stored.get(77).runSucceeded, true, 'onChange must clone the classified terminal result');
    const restored = new item.Journal().restore(77, structuredClone(h.stored.get(77)));
    assert.equal(restored.successfulDone, true);
    assert.equal(restored.runSucceeded, true);
  });

  test(`${item.build}: Ask classification is atomic and stopped or partial runs cannot inherit success`, () => {
    const h = backgroundHarness(item);
    h.journal.begin(77, 'ask-request', { mode: 'ask' });
    h.context.finishRunUiSnapshot(77, 'ask-request', 'completed', 'Owned answer.', true);
    assert.equal(h.stored.get(77).runSucceeded, true);
    h.journal.begin(77, 'stopped-request', { mode: 'act' });
    h.journal.record(77, 'stopped-request', 'tool_result', done);
    h.context.finishRunUiSnapshot(77, 'stopped-request', 'stopped', 'Stopped by user.');
    assert.equal(h.stored.get(77).runSucceeded, false);
    h.journal.begin(77, 'partial-request', { mode: 'act' });
    h.journal.record(77, 'partial-request', 'tool_result', { ...done, result: { done: true, outcome: 'partial' } });
    h.context.finishRunUiSnapshot(77, 'partial-request', 'completed', 'Incomplete.');
    assert.equal(h.stored.get(77).successfulDone, false);
    assert.equal(h.stored.get(77).runSucceeded, false);
  });

  test(`${item.build}: resuming a matching journal removes previous success before persistence`, () => {
    const h = backgroundHarness(item);
    h.journal.begin(77, 'resume-request', { mode: 'act' });
    h.journal.record(77, 'resume-request', 'tool_result', done);
    h.context.finishRunUiSnapshot(77, 'resume-request', 'completed', 'Owned task completed.');
    h.journal.resume(77, 'resume-request');
    assert.equal(h.stored.get(77).successfulDone, false);
    assert.equal(h.stored.get(77).runSucceeded, false);
    assert.equal(h.stored.get(77).status, 'running');
  });

  test(`${item.build}: actual Scheduler captures execution ownership for every update and drops cancelled callbacks`, async () => {
    let publish, resolveRun, started;
    const start = new Promise(resolve => { started = resolve; });
    const result = new Promise(resolve => { resolveRun = resolve; });
    const harness = makeSchedulerHarness(item.scheduler, {
      jobs: [{ id: 'scheduled-resume', kind: 'resume', status: 'pending', tabId: 77, conversationId: 'conv-1', resumeTaskId: 'original-task-id', mode: 'act', reason: 'Owned fixture', scheduledAt: '2026-01-01T12:00:00.000Z', resumeInstruction: 'Observe the owned fixture.' }],
      processMessage: async (_tabId, _message, onUpdate) => { publish = onUpdate; started(); return result; },
    });
    const updates = [];
    harness.manager.sendUpdate = (...args) => updates.push(args);
    const run = harness.manager.handleAlarm(harness.alarmName('scheduled-resume'));
    await start;
    const running = updates.find(([, type, data]) => type === 'scheduled_job' && data.event === 'running');
    assert.ok(running?.[3]?.executionId, 'actual running emission needs an internal execution owner');
    const initial = structuredClone(running[3]);
    publish('tool_result', done);
    assert.deepEqual(updates.at(-1)[3], initial);
    publish('text_delta', { content: 'Owned text.' });
    assert.deepEqual(updates.at(-1)[3], initial);
    await harness.manager.cancelJob('scheduled-resume');
    const count = updates.length;
    publish('tool_result', done);
    publish('text', { content: 'Late old task.' });
    assert.equal(updates.length, count, 'cancelled callbacks must not reach the background or panel');
    resolveRun('Stopped by user.');
    await run;
  });

  test(`${item.build}: hidden scheduled completion journals exact done and survives a fresh worker`, async () => {
    const h = backgroundHarness(item), owner = scope();
    h.journal.begin(77, 'previous-continue', { kind: 'continue' });
    h.context.finishRunUiSnapshot(77, 'previous-continue', 'completed', 'Scheduled a wait.');
    assert.equal(typeof h.context.sendScheduledAgentUpdate, 'function', 'scheduler must share the journal emitter lifecycle');
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', owner), owner);
    const request = h.journal.get(77).requestId;
    assert.notEqual(request, 'previous-continue');
    h.context.sendScheduledAgentUpdate(77, 'tool_result', done, owner);
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('completed', owner), owner);
    await flushMicrotasks();
    const stored = h.stored.get(77);
    assert.equal(stored.requestId, request);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.successfulDone, true);
    assert.equal(stored.runSucceeded, true);
    const restored = new item.Journal().restore(77, structuredClone(stored));
    assert.equal(restored.runSucceeded, true);
    assert.ok(restored.events.some(event => event.type === 'tool_result' && event.data.name === 'done'));
    assert.equal(h.messages.filter(message => message.type === 'run_complete').length, 1);
  });

  test(`${item.build}: actual Scheduler updates use the shared background journal through final persisted success`, async () => {
    const h = backgroundHarness(item);
    const scheduler = makeSchedulerHarness(item.scheduler, {
      jobs: [{ id: 'scheduled-resume', kind: 'resume', status: 'pending', tabId: 77, conversationId: 'conv-1', resumeTaskId: 'original-task-id', mode: 'act', reason: 'Owned fixture', scheduledAt: '2026-01-01T12:00:00.000Z', resumeInstruction: 'Observe the owned fixture.' }],
      processMessage: async (_tabId, _message, onUpdate) => {
        onUpdate('thinking', { content: 'Observe original task.' });
        onUpdate('tool_result', done);
        return 'Owned task completed.';
      },
    });
    scheduler.manager.sendUpdate = (tabId, type, data, owner) => h.context.sendScheduledAgentUpdate(tabId, type, data, owner);
    await scheduler.manager.handleAlarm(scheduler.alarmName('scheduled-resume'));
    await flushMicrotasks();
    const stored = h.stored.get(77);
    assert.ok(stored.requestId.startsWith('scheduled:scheduled-resume:'));
    assert.equal(stored.status, 'completed');
    assert.equal(stored.successfulDone, true);
    assert.equal(stored.runSucceeded, true);
    assert.equal(scheduler.jobs()[0].lastOutcome, 'success');
    assert.equal(h.messages.filter(message => message.type === 'run_complete').length, 1);
  });

  test(`${item.build}: late old events and terminal job notices cannot overwrite a newer genuine foreground request`, async () => {
    const h = backgroundHarness(item), owner = scope();
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', owner), owner);
    h.journal.begin(77, 'new-genuine-task-id', { mode: 'act' });
    const newer = structuredClone(h.journal.get(77)), count = h.messages.length;
    for (const event of ['completed', 'failed', 'clarification_required', 'running']) {
      h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent(event, owner), owner);
    }
    h.context.sendScheduledAgentUpdate(77, 'tool_result', done, owner);
    h.context.sendScheduledAgentUpdate(77, 'text_delta', { content: 'Late old task.' }, owner);
    await flushMicrotasks();
    assert.deepEqual(h.stored.get(77), newer);
    assert.equal(h.messages.length, count);
    assert.equal(h.attention.length, 0);
  });

  test(`${item.build}: same-job newer execution replaces old scheduled ownership and cannot inherit success`, async () => {
    const h = backgroundHarness(item), old = scope('old-execution'), next = scope('new-execution');
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', old), old);
    h.context.sendScheduledAgentUpdate(77, 'tool_result', done, old);
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', next), next);
    const fresh = structuredClone(h.journal.get(77)), count = h.messages.length;
    assert.equal(fresh.successfulDone, false);
    assert.equal(fresh.runSucceeded, false);
    assert.equal(fresh.scheduledExecutionId, 'new-execution');
    h.context.sendScheduledAgentUpdate(77, 'tool_result', done, old);
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('completed', old), old);
    await flushMicrotasks();
    assert.deepEqual(h.stored.get(77), fresh);
    assert.equal(h.messages.length, count);
  });

  test(`${item.build}: cancelled, paused and directly stopped scheduled attempts retain incomplete terminal state`, async () => {
    for (const event of ['cancelled', 'paused', 'completed']) {
      const h = backgroundHarness(item), owner = scope(event);
      h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', owner), owner);
      h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent(event, owner, { lastResult: 'Stopped by user.', lastOutcome: null }), owner);
      await flushMicrotasks();
      const stored = structuredClone(h.stored.get(77));
      assert.equal(stored.status, 'stopped');
      assert.equal(stored.successfulDone, false);
      assert.equal(stored.runSucceeded, false);
      const count = h.messages.length;
      h.context.sendScheduledAgentUpdate(77, 'tool_result', done, owner);
      h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', owner), owner);
      h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('completed', owner), owner);
      await flushMicrotasks();
      assert.deepEqual(h.stored.get(77), stored);
      assert.equal(h.messages.length, count);
      assert.equal(h.attention.length, 0);
    }
  });

  test(`${item.build}: recurring partial verdict does not become success on restore and future creation does not begin a run`, async () => {
    const h = backgroundHarness(item), owner = scope('watch-poll');
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', owner), owner);
    h.context.sendScheduledAgentUpdate(77, 'tool_result', done, owner);
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('polled', owner, { status: 'pending', lastOutcome: 'partial' }), owner);
    await flushMicrotasks();
    const restored = new item.Journal().restore(77, structuredClone(h.stored.get(77)));
    assert.equal(restored.successfulDone, true, 'retain the exact accepted done event');
    assert.equal(restored.runSucceeded, false, 'a later independent downgrade still prevents full success');
    const original = structuredClone(h.journal.get(77));
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('created', scope('')), scope(''));
    assert.deepEqual(h.journal.get(77), original);
  });

  test(`${item.build}: delayed final persistence cannot broadcast or flash after a newer foreground begin`, async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = backgroundHarness(item, { flushRunUiSnapshot: async () => gate }), owner = scope();
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', owner), owner);
    h.context.sendScheduledAgentUpdate(77, 'tool_result', done, owner);
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('completed', owner), owner);
    h.journal.begin(77, 'new-request-during-persist', { mode: 'act' });
    const count = h.messages.length;
    release(true);
    await flushMicrotasks();
    assert.equal(h.messages.length, count);
    assert.equal(h.attention.length, 0);
    assert.equal(h.stored.get(77).requestId, 'new-request-during-persist');
  });

  test(`${item.build}: a newer request during awaited durable lookup suppresses stale completion and attention`, async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = backgroundHarness(item, { hasDurableSubmittedTurn: async () => gate });
    h.journal.begin(77, 'old-direct-request', { mode: 'act' });
    h.journal.record(77, 'old-direct-request', 'tool_result', done);
    const old = h.context.finishRunUiSnapshot(77, 'old-direct-request', 'completed', 'Owned task completed.');
    const complete = h.context.sendAgentRunComplete(77, old);
    await flushMicrotasks();
    h.journal.begin(77, 'new-direct-request', { mode: 'act' });
    release(true);
    await complete;
    assert.equal(h.messages.length, 0);
    assert.equal(h.attention.length, 0);
    assert.equal(h.stored.get(77).requestId, 'new-direct-request');
  });

  test(`${item.build}: accepted same-run steering and later partial completion cannot retain old task success`, () => {
    const h = backgroundHarness(item);
    h.journal.begin(77, 'same-running-request', { mode: 'act' });
    h.journal.record(77, 'same-running-request', 'tool_result', done);
    h.journal.record(77, 'same-running-request', 'steering_applied', { id: 'new-genuine-user-turn', text: 'Same wording with new authority.' });
    assert.equal(h.stored.get(77).successfulDone, false);
    h.journal.record(77, 'same-running-request', 'tool_result', { name: 'done', result: { done: true, outcome: 'partial' } });
    h.context.finishRunUiSnapshot(77, 'same-running-request', 'completed', 'Incomplete corrected task.');
    assert.equal(h.stored.get(77).successfulDone, false);
    assert.equal(h.stored.get(77).runSucceeded, false);
    h.journal.resume(77, 'same-running-request');
    h.journal.record(77, 'same-running-request', 'tool_result', done);
    h.context.finishRunUiSnapshot(77, 'same-running-request', 'completed', 'Corrected task completed.');
    assert.equal(h.stored.get(77).runSucceeded, true);
  });

  test(`${item.build}: actual Scheduler cannot retain a prior done or run status after accepted correction fails`, async () => {
    for (const failure of ['error', 'max_steps']) {
      const h = scheduledUiHarness(item, async (_tabId, _message, onUpdate) => {
        onUpdate('tool_result', { ...done, result: { ...done.result, verification: { decision: { outcome: 'succeeded' } } } });
        onUpdate('run_status', { status: 'success' });
        onUpdate('steering_applied', { id: 'new-genuine-user-turn', text: 'Perform the changed owned task.' });
        if (failure === 'error') onUpdate('error', { message: 'Changed task failed.' });
        else onUpdate('max_steps_reached', { steps: 3 });
        return failure === 'error' ? 'Error: changed task failed.' : 'Changed task remains incomplete.';
      });
      const job = await h.run(), stored = h.ui.stored.get(77);
      assert.notEqual(job.lastOutcome, 'success', 'the earlier authority cannot complete the corrected task');
      assert.notEqual(job.systemOneVerdict?.reason, 'done_verified', 'discard the earlier independent verdict');
      assert.equal(stored.successfulDone, false);
      assert.equal(stored.runSucceeded, false);
      assert.equal(h.ui.attention.some(value => value.success === true), false);
    }
  });

  test(`${item.build}: actual Scheduler accepts only a fresh success or partial done after correction`, async () => {
    for (const outcome of ['success', 'partial']) {
      const h = scheduledUiHarness(item, async (_tabId, _message, onUpdate) => {
        onUpdate('tool_result', { ...done, result: { ...done.result, verification: { decision: { outcome: 'succeeded' } } } });
        onUpdate('run_status', { status: 'success' });
        onUpdate('steering_applied', { id: 'new-genuine-user-turn', text: 'Perform the changed owned task.' });
        onUpdate('tool_result', { name: 'done', result: { done: true, success: true, outcome } });
        return outcome === 'success' ? 'Changed task complete.' : 'Changed task incomplete.';
      });
      const job = await h.run(), stored = h.ui.stored.get(77);
      assert.equal(job.lastOutcome, outcome);
      assert.equal(stored.runSucceeded, outcome === 'success');
      assert.equal(stored.successfulDone, outcome === 'success');
    }
  });

  test(`${item.build}: missing corrected judge context never falls back to the old authority context`, async () => {
    let corrected = false;
    const h = scheduledUiHarness(item, async (_tabId, _message, onUpdate) => {
      onUpdate('tool_result', done);
      corrected = true;
      onUpdate('steering_applied', { id: 'new-genuine-user-turn', text: 'Perform the changed owned task.' });
      onUpdate('tool_result', { name: 'done', result: { done: true, success: true, outcome: 'partial' } });
      return 'Changed task remains incomplete.';
    }, { systemOneContext: () => corrected ? null : { isCurrent: () => !corrected } });
    const job = await h.run();
    assert.equal(job.status, 'completed');
    assert.equal(job.lastOutcome, 'partial');
    assert.equal(job.reconciliationRequired, false);
    assert.equal(h.ui.stored.get(77).runSucceeded, false);
  });

  test(`${item.build}: enabled SystemOne cannot reuse observations made before accepted correction`, async () => {
    for (const freshRead of [false, true]) {
      const calls = [];
      const h = scheduledUiHarness(item, async (_tabId, _message, onUpdate) => {
        onUpdate('tool_result', { name: 'read_page', result: { success: true, text: 'OLD_AUTHORITY_ONLY' } });
        onUpdate('tool_result', { ...done, result: { ...done.result, verification: { decision: { outcome: 'succeeded' } } } });
        onUpdate('steering_applied', { id: 'new-genuine-user-turn', text: 'Perform the changed owned task.' });
        if (freshRead) onUpdate('tool_result', { name: 'read_page', result: { success: true, text: 'CURRENT_AUTHORITY_ONLY' } });
        onUpdate('tool_result', { name: 'done', result: { done: true, success: true, outcome: 'success' } });
        return 'Changed task complete.';
      }, { systemOneEnabled: true, systemOneCompletionEnabled: true, systemOneApiKey: 'owned-test-only',
        systemOneJudge: { async evaluate(args) { calls.push(args); return { answers: [], model: 'owned-judge' }; } } });
      await h.run();
      assert.equal(calls.length, freshRead ? 1 : 0, 'only a current-authority read may feed the optional sidecar');
      if (freshRead) {
        const state = JSON.stringify(calls[0].state);
        assert.ok(state.includes('CURRENT_AUTHORITY_ONLY'));
        assert.equal(state.includes('OLD_AUTHORITY_ONLY'), false);
      }
    }
  });

  test(`${item.build}: corrected Ask classification does not inherit an earlier failed status or error`, async () => {
    const h = scheduledUiHarness(item, async (_tabId, _message, onUpdate) => {
      onUpdate('error', { message: 'Earlier authority failed.' });
      onUpdate('run_status', { status: 'failed' });
      onUpdate('steering_applied', { id: 'new-genuine-user-turn', text: 'Answer the changed owned question.' });
      onUpdate('text', { content: 'A current answer to the changed question.' });
      return 'A current answer to the changed question.';
    }, { mode: 'ask' });
    const job = await h.run();
    assert.equal(job.lastOutcome, 'success');
    assert.equal(h.ui.journal.get(77).status, 'completed');
    assert.equal(h.ui.stored.get(77).status, 'completed');
    assert.equal(h.ui.stored.get(77).runSucceeded, true);
    assert.equal(h.ui.stored.get(77).hadError, false);
    assert.equal(h.ui.stored.get(77).lastError, '');
    assert.ok(h.ui.stored.get(77).events.some(event => event.type === 'error'), 'retain historical error events');
  });

  test(`${item.build}: direct terminal and Ask classification use only the applied task revision`, () => {
    const h = backgroundHarness(item), answer = 'Current answer.';
    const old = [{ type: 'error', data: { message: 'Previous task failed.' } },
      { type: 'max_steps_reached', data: { steps: 3 } }];
    const corrected = [...old, { type: 'steering_applied', data: { id: 'new-genuine-user-turn' } },
      { type: 'text', data: { content: answer } }];
    assert.equal(h.context.terminalRunUiStatus(answer, corrected), 'completed');
    assert.equal(h.context.askCompletionSucceededForBadge(answer, corrected), true);
    const queued = [...old, { type: 'steering_queued', data: { messages: [{ id: 'not-applied' }] } }];
    assert.equal(h.context.terminalRunUiStatus(answer, queued), 'failed');
    assert.equal(h.context.askCompletionSucceededForBadge(answer, queued), false);
    for (const update of [{ type: 'error', data: { message: 'Current failure.' } },
      { type: 'max_steps_reached', data: { steps: 3 } }]) {
      const current = [...corrected, update];
      assert.equal(h.context.askCompletionSucceededForBadge(answer, current), false);
      if (update.type === 'error') assert.equal(h.context.terminalRunUiStatus(answer, current), 'failed');
    }
    assert.equal(h.context.terminalRunUiStatus('Stopped by user.', corrected), 'stopped');
    assert.equal(h.context.terminalRunUiStatus(answer, corrected, new Error('Current terminal failure.')), 'failed');
    for (const update of [{ type: 'quota', data: { blocked: true } },
      { type: 'run_status', data: { status: 'persistence_degraded' } }]) {
      assert.equal(h.context.terminalRunUiStatus(answer, [update, ...corrected]), 'failed',
        'applied steering cannot waive a run-wide persistence or quota boundary');
    }
  });

  test(`${item.build}: actual sidebar cannot promote historical success over an explicit current failure`, () => {
    const panel = panelCompletionHarness(item);
    const old = { type: 'tool_result', data: done };
    const corrected = { type: 'steering_applied', data: { id: 'new-genuine-user-turn' } };
    const failure = { type: 'error', data: { message: 'Changed task failed.' } };
    const updates = [old, corrected, failure];
    assert.equal(panel.context.updatesContainSuccessfulDone(updates), false);
    assert.equal(panel.classifyAct({ successfulDone: false, updates, content: 'Changed task failed.' }), false);
    assert.equal(panel.classifyAct({ successfulDone: false, updates: [old] }), false,
      'an explicit current server false overrides the legacy fallback');
  });

  test(`${item.build}: publication denials and checker exhaustion stay failed through memory classification and reconnect`, async () => {
    for (const code of ['publication_audit_denied', 'publication_audit_unavailable']) {
      const events = [
        { type: 'failure_recovery', data: { stage: 'publication_audit', code,
          recoveryId: 'owned-recovery', message: 'Failed during the publication check. The draft was not published.' } },
        { type: 'run_status', data: { status: 'publication_audit_failed' } },
      ];
      for (const updates of [events, [events[0]], [events[1]]]) {
        const h = backgroundHarness(item);
        h.context.beginRunUiSnapshot(77, 'audit-failed', { mode: 'act', kind: 'continue' });
        for (const event of updates) h.context.recordRunUiEvent(77, 'audit-failed', event.type, event.data);
        const message = events[0].data.message;
        const status = h.context.terminalRunUiStatus(message, updates);
        assert.equal(status, 'failed', code);
        assert.equal(h.context.runUpdatesSucceeded(updates), false, 'all three user-memory extraction call sites use this classifier');
        assert.equal(h.context.askCompletionSucceededForBadge(message, updates), false);
        const terminal = h.context.finishRunUiSnapshot(77, 'audit-failed', status, message);
        assert.equal(terminal.runSucceeded, false);
        await h.context.sendAgentRunComplete(77, terminal);
        assert.equal(h.messages.at(-1).data.status, 'failed');
        assert.equal(h.attention.at(-1).success, false);
        const cold = backgroundHarness(item);
        const restored = cold.journal.restore(77, JSON.parse(JSON.stringify(item.compactRunUiSnapshotForPersist(h.stored.get(77)))));
        const replay = await item.runDetachedWithReconnect({
          initialAction: 'continue_start', payload: { requestId: 'audit-failed' },
          start: async () => ({ accepted: true, requestId: 'audit-failed' }),
          probe: async () => ({ submittedTurnDurable: true, runUi: restored }),
          wait: async () => {}, pollIntervalMs: 0,
        });
        assert.equal(replay.success, false);
        assert.equal(replay.successfulDone, false);
        assert.equal(restored.status, 'failed');
        assert.equal(restored.runSucceeded, false);
      }
    }
  });

  test(`${item.build}: publication failure classification preserves fresh successful recovery and explicit Stop`, () => {
    const h = backgroundHarness(item);
    const failed = { type: 'failure_recovery', data: { stage: 'publication_audit', code: 'publication_audit_denied' } };
    const successfulRetry = [{ type: 'tool_result', data: done }];
    assert.equal(h.context.terminalRunUiStatus('Owned task completed.', successfulRetry), 'completed');
    assert.equal(h.context.runUpdatesSucceeded(successfulRetry), true);
    assert.equal(h.context.terminalRunUiStatus('Stopped by user.', [failed]), 'stopped');
    assert.equal(h.context.terminalRunUiStatus('Stopped before executing requested tool calls.', [failed]), 'cancelled');
    assert.equal(h.context.terminalRunUiStatus('Details unresolved.', [{ type: 'run_status', data: { status: 'clarification_required' } }]), 'clarification_required');
    const revised = [failed, { type: 'steering_applied', data: { id: 'corrected-task' } }, ...successfulRetry];
    assert.equal(h.context.terminalRunUiStatus('Owned task completed.', revised), 'completed');
  });

  test(`${item.build}: context and page-instability recovery are failed terminal runs rather than completed tasks`, () => {
    const h = backgroundHarness(item);
    for (const code of ['action_context_unverified', 'page_unstable']) {
      const failure = { type: 'failure_recovery', data: { stage: 'action_preparation', code,
        retryMode: code === 'action_context_unverified' ? 'action_monitoring_relaxed' : 'resume' } };
      assert.equal(h.context.terminalRunUiStatus('The task is incomplete. Choose Retry.', [failure]), 'failed');
      assert.equal(h.context.runUpdatesSucceeded([failure]), false);
      assert.equal(h.context.askCompletionSucceededForBadge('The task is incomplete.', [failure]), false);
      const revised = [failure, { type: 'steering_applied', data: { id: 'new-task' } }, { type: 'tool_result', data: done }];
      assert.equal(h.context.terminalRunUiStatus('Completed the corrected task.', revised), 'completed');
    }
  });

  test(`${item.build}: actual sidebar corrected Ask succeeds only without a current error, limit or Stop`, () => {
    const panel = panelCompletionHarness(item);
    const error = { type: 'error', data: { message: 'Previous task failed.' } };
    const corrected = { type: 'steering_applied', data: { id: 'new-genuine-user-turn' } };
    const updates = [error, { type: 'max_steps_reached', data: { steps: 3 } }, corrected];
    assert.equal(panel.context.isSuccessfulAskCompletion('ask', { content: 'Current answer.', updates }), true);
    for (const current of [error, { type: 'max_steps_reached', data: { steps: 3 } },
      { type: 'run_status', data: { status: 'cancelled' } }]) {
      assert.equal(panel.context.isSuccessfulAskCompletion('ask', { content: 'Current answer.', updates: [...updates, current] }), false);
    }
    assert.equal(panel.context.isSuccessfulAskCompletion('ask', { content: 'Current answer.',
      updates: [error, { type: 'steering_queued', data: { messages: [] } }] }), false);
  });

  test(`${item.build}: actual sidebar terminal controls preserve fresh done and reject current or infrastructure failures`, () => {
    const panel = panelCompletionHarness(item), success = { type: 'tool_result', data: done };
    assert.equal(panel.classifyAct({ successfulDone: true, updates: [success] }), true);
    assert.equal(panel.classifyAct({ updates: [success] }), true, 'legacy responses retain the fresh done fallback');
    assert.equal(panel.classifyAct({ updates: [success, { type: 'max_steps_reached', data: { steps: 3 } }] }), true,
      'the actual delivery-recovery producer emits its step-limit trace after accepted done');
    assert.equal(panel.classifyAct({ updates: [success,
      { type: 'steering_applied', data: { id: 'new-genuine-user-turn' } },
      { type: 'max_steps_reached', data: { steps: 3 } }] }), false,
      'a new revision without its own done still cannot complete at the step limit');
    assert.equal(panel.classifyAct({ runSucceeded: false, updates: [success] }), false);
    assert.equal(panel.classifyAct({ updates: [success,
      { type: 'tool_result', data: { name: 'done', result: { done: true, outcome: 'partial' } } }] }), false);
    for (const current of [{ type: 'error', data: { message: 'Current failure.' } },
      { type: 'run_status', data: { status: 'stopped' } }]) {
      assert.equal(panel.classifyAct({ updates: [success, current] }), false);
    }
    for (const blocker of [{ type: 'quota', data: { blocked: true } },
      { type: 'run_status', data: { status: 'persistence_degraded' } }]) {
      const updates = [blocker, { type: 'steering_applied', data: { id: 'new-genuine-user-turn' } }, success];
      assert.equal(panel.classifyAct({ updates }), false);
      assert.equal(panel.context.isSuccessfulAskCompletion('ask', { content: 'Current answer.', updates }), false);
    }
  });

  test(`${item.build}: fresh corrected failures and unapplied queued commands cannot produce successful scheduled UI`, async () => {
    for (const failure of ['error', 'max_steps', 'stop', 'queued_only']) {
      const h = scheduledUiHarness(item, async (_tabId, _message, onUpdate) => {
        onUpdate('error', { message: 'Previous task failed.' });
        onUpdate(failure === 'queued_only' ? 'steering_queued' : 'steering_applied',
          { id: 'new-genuine-user-turn', text: 'Answer the changed question.' });
        if (failure === 'error') onUpdate('error', { message: 'Current task failed.' });
        if (failure === 'max_steps') onUpdate('max_steps_reached', { steps: 3 });
        if (failure === 'stop') onUpdate('run_status', { status: 'cancelled' });
        return failure === 'stop' ? 'Stopped by user.' : 'Current task remains incomplete.';
      }, { mode: 'ask' });
      const job = await h.run(), stored = h.ui.stored.get(77);
      assert.notEqual(job.lastOutcome, 'success', `current ${failure} cannot succeed`);
      assert.equal(stored.runSucceeded, false);
      assert.equal(h.ui.attention.some(value => value.success === true), false);
      if (failure === 'stop') assert.equal(stored.status, 'stopped');
      if (failure === 'error' || failure === 'queued_only') assert.equal(stored.status, 'failed');
    }
  });

  test(`${item.build}: applied steering clears current journal error flags without settling an uncertain action`, () => {
    const h = backgroundHarness(item);
    h.journal.begin(77, 'owned-request', { attachmentCount: 1 });
    h.journal.record(77, 'owned-request', 'tool_call', { name: 'click_ax', outcomeUnknown: true });
    h.journal.record(77, 'owned-request', 'error', { message: 'Previous task error.' });
    h.journal.record(77, 'owned-request', 'quota', { quota: { current: 1, limit: 1 } });
    const pending = structuredClone(h.journal.get(77).pendingToolCall);
    h.journal.record(77, 'owned-request', 'steering_queued', { id: 'not-applied' });
    assert.equal(h.journal.get(77).hadError, true);
    h.journal.record(77, 'owned-request', 'steering_applied', { id: 'new-genuine-user-turn' });
    const current = h.journal.get(77);
    assert.equal(current.hadError, false);
    assert.equal(current.lastError, '');
    assert.deepEqual(current.pendingToolCall, pending);
    assert.equal(current.quota.limit, 1);
    assert.equal(current.attachmentDeliveryState, 'sending');
    assert.ok(current.events.some(event => event.type === 'error'));
    h.journal.record(77, 'owned-request', 'error', { message: 'Current task error.' });
    assert.equal(h.journal.get(77).hadError, true);
    assert.equal(h.journal.get(77).lastError, 'Current task error.');
  });

  test(`${item.build}: an old armed watch alert cannot attach to a corrected successful completion`, async () => {
    const alerts = [];
    const h = scheduledUiHarness(item, async (_tabId, _message, onUpdate) => {
      onUpdate('tool_result', { name: 'beep', result: { success: true, armed: true, eventKey: 'old-authority-event' } });
      onUpdate('tool_result', done);
      onUpdate('steering_applied', { id: 'new-genuine-user-turn', text: 'Perform the changed owned task.' });
      onUpdate('tool_result', done);
      return 'Changed task complete without an old alert.';
    }, { jobs: [{ id: 'owned-watch', kind: 'task', source: 'watch', status: 'pending', mode: 'act',
      tabId: 77, target: { type: 'current_tab', tabId: 77 }, title: 'Owned watch', prompt: 'Watch the owned fixture.',
      schedule: { type: 'recurring', everyMinutes: 1 }, watch: { beep: true, keep: false },
      scheduledAt: '2026-01-01T12:00:00.000Z' }], playWatchAlert: value => { alerts.push(value); } });
    const job = await h.run();
    assert.equal(job.lastOutcome, 'success');
    assert.equal(alerts.length, 0);
    assert.equal(job.watch.lastTriggeredEventKey || null, null);
  });

  test(`${item.build}: a later accepted failed completion clears prior success even with success:false`, () => {
    const h = backgroundHarness(item);
    h.journal.begin(77, 'same-running-request', { mode: 'act' });
    h.journal.record(77, 'same-running-request', 'tool_result', done);
    h.journal.record(77, 'same-running-request', 'tool_result', { name: 'done', result: { done: true, outcome: 'failed', success: false } });
    h.context.finishRunUiSnapshot(77, 'same-running-request', 'completed', 'Failed owned task.');
    assert.equal(h.stored.get(77).successfulDone, false);
    assert.equal(h.stored.get(77).runSucceeded, false);
  });

  test(`${item.build}: a delayed stored snapshot cannot replace a newer genuine direct or scheduled request`, async () => {
    for (const scheduled of [false, true]) {
      const h = backgroundHarness(item);
      let release;
      h.context.chrome.storage.session.get = async () => new Promise(resolve => { release = resolve; });
      const read = h.context.getRunUiSnapshot(77);
      await flushMicrotasks();
      if (scheduled) {
        const owner = scope('new-worker-execution');
        h.context.sendScheduledAgentUpdate(77, 'scheduled_job', jobEvent('running', owner), owner);
      } else h.context.beginRunUiSnapshot(77, 'new-genuine-task', { mode: 'act' });
      const current = h.journal.get(77);
      release({ 'runUi:77': { requestId: 'old-completed-request', status: 'completed', successfulDone: true, runSucceeded: true, events: [] } });
      assert.equal(await read, current);
      assert.equal(h.journal.get(77), current);
    }
  });

  for (const reverse of [false, true]) {
    test(`${item.build}: concurrent cold snapshot readers preserve the same stored journal (${reverse ? 'last' : 'first'} read resolves first)`, async () => {
      const h = backgroundHarness(item);
      h.journal.begin(77, 'cold-owned-request', { mode: 'act' });
      h.journal.record(77, 'cold-owned-request', 'run_status', { status: 'thinking' });
      h.journal.record(77, 'cold-owned-request', 'text_delta', { text: 'Preserved owned output.' });
      const saved = structuredClone(h.stored.get(77));
      h.journal.clear(77);
      const reads = [];
      h.context.chrome.storage.session.get = () => new Promise(resolve => { reads.push(resolve); });
      const first = h.context.getRunUiSnapshot(77);
      const second = h.context.getRunUiSnapshot(77);
      await flushMicrotasks();
      const storageReadCount = reads.length;
      for (const release of reverse ? [...reads].reverse() : reads) {
        release({ 'runUi:77': structuredClone(saved) });
        await flushMicrotasks();
      }
      const results = await Promise.all([first, second]);
      assert.ok(results.every(result => result?.requestId === 'cold-owned-request'));
      assert.equal(results[0], results[1]);
      assert.equal(h.journal.get(77), results[0]);
      assert.equal(results[0].seq, saved.seq);
      assert.deepEqual(results[0].events, saved.events);
      assert.equal(storageReadCount, 1, 'readers of the same cold journal share its storage read');
      assert.equal(h.context.runUiSnapshotReads.size, 0);
    });
  }

  test(`${item.build}: a remount read cannot discard persisted events during a cold same-request continuation`, async () => {
    const h = backgroundHarness(item);
    h.journal.begin(77, 'cold-continuation-request', { mode: 'act', foreground: true });
    h.journal.record(77, 'cold-continuation-request', 'run_status', { status: 'thinking' });
    h.journal.record(77, 'cold-continuation-request', 'plan_review', { planId: 'retained-owned-plan' });
    h.journal.acknowledge(77, 'cold-continuation-request', 1);
    const saved = structuredClone(h.stored.get(77));
    h.journal.clear(77);
    const reads = [];
    h.context.chrome.storage.session.get = () => new Promise(resolve => { reads.push(resolve); });
    const continuation = h.context.beginContinuationRunUiSnapshot(77, 'cold-continuation-request', { kind: 'continue' });
    await flushMicrotasks();
    const remount = h.context.getRunUiSnapshot(77);
    await flushMicrotasks();
    for (const release of reads) {
      release({ 'runUi:77': structuredClone(saved) });
      await flushMicrotasks();
    }
    const [resumed, observed] = await Promise.all([continuation, remount]);
    assert.equal(resumed.seq, 2, 'continuation preserves the persisted sequence instead of beginning a new journal');
    assert.equal(resumed.ackedSeq, 1);
    assert.equal(resumed.foreground, true);
    assert.deepEqual(resumed.events, saved.events);
    assert.equal(observed, resumed);
    const next = h.context.recordRunUiEvent(77, 'cold-continuation-request', 'text_delta', { text: 'Continued owned output.' });
    assert.equal(next.seq, 3);
    assert.deepEqual(resumed.events.map(event => event.seq), [2, 3]);
    assert.equal(reads.length, 1);
  });

  test(`${item.build}: a failed shared cold read permits a later storage retry`, async () => {
    const h = backgroundHarness(item);
    const rejects = [];
    h.context.chrome.storage.session.get = () => new Promise((_resolve, reject) => { rejects.push(reject); });
    const first = h.context.getRunUiSnapshot(77);
    const second = h.context.getRunUiSnapshot(77);
    await flushMicrotasks();
    for (const reject of rejects) reject(new Error('Owned storage read failed.'));
    assert.deepEqual(await Promise.all([first, second]), [null, null]);
    assert.equal(h.context.runUiSnapshotReads.size, 0);
    let retries = 0;
    h.context.chrome.storage.session.get = async key => {
      retries++;
      return { [key]: { requestId: 'retry-owned-request', status: 'running', events: [], seq: 4 } };
    };
    const recovered = await h.context.getRunUiSnapshot(77);
    assert.equal(recovered.requestId, 'retry-owned-request');
    assert.equal(recovered.seq, 4);
    assert.equal(retries, 1);
    assert.equal(rejects.length, 1);
  });

  test(`${item.build}: clearing a conversation during stored UI read cannot resurrect its previous success`, async () => {
    const h = backgroundHarness(item);
    let release;
    h.context.chrome.storage.session.get = async () => new Promise(resolve => { release = resolve; });
    const read = h.context.getRunUiSnapshot(77);
    await flushMicrotasks();
    h.context.clearRunUiSnapshot(77);
    await flushMicrotasks();
    release({ 'runUi:77': { requestId: 'cleared-old-request', status: 'completed', successfulDone: true, runSucceeded: true, events: [] } });
    assert.equal(await read, null);
    assert.equal(h.journal.get(77), null);
    assert.equal(h.context.runUiSnapshotReads.size, 0);
  });

  test(`${item.build}: same-request continuation during terminal persistence cannot receive an old completion or attention`, async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = backgroundHarness(item, { flushRunUiSnapshot: async () => gate });
    h.journal.begin(77, 'same-continuation-request', { mode: 'act', kind: 'continue' });
    h.journal.record(77, 'same-continuation-request', 'tool_result', done);
    const old = h.context.finishRunUiSnapshot(77, 'same-continuation-request', 'completed', 'Owned task completed.');
    const complete = h.context.sendAgentRunComplete(77, old);
    h.journal.resume(77, 'same-continuation-request');
    assert.equal(h.journal.get(77), old, 'production continuation deliberately keeps the snapshot object');
    release(true);
    await complete;
    assert.equal(h.messages.length, 0);
    assert.equal(h.attention.length, 0);
    assert.equal(h.stored.get(77).status, 'running');
    assert.equal(h.stored.get(77).runSucceeded, false);
  });
}
