import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { chromium, firefox } from 'playwright';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { prepareFeedbackTrace } = await import(`../src/${build}/src/trace/feedback-export.js`);
  const { submitFeedbackWithTrace } = await import(`../src/${build}/src/ui/feedback-consent.js`);
  const { getFeedbackCopy } = await import(`../src/${build}/src/ui/feedback-copy.js`);
  const { feedbackRecordingPolicy, feedbackRunsToEvict } = await import(`../src/${build}/src/trace/feedback-policy.js`);
  const { createConfigExport, parseConfigImport } = await import(`../src/${build}/src/config-transfer.js`);
  const { mayReadFeedbackDraft, isFeedbackDestination } = await import(`../src/${build}/src/feedback-handoff.js`);
  const { sanitizeTraceExport } = await import(`../src/${build}/src/agent/trace-export.js`);
  const { exportRecordedSession } = await import(`../src/${build}/src/trace/session-export.js`);
  const fixtureStore = (events = []) => ({
    listRuns: async () => [{ runId: 'r', conversationId: 'chosen', startedAt: 1, endedAt: 2, status: 'done', userMessage: 'password=top-secret', lossless: true },
      { runId: 'other', conversationId: 'unrelated', userMessage: 'DO NOT SHARE' }],
    getRunEvents: async () => structuredClone(events.map(event => ({ ts: 1, ...event }))),
    getScreenshot: async () => ({ blob: new Blob(['image bytes'], { type: 'image/png' }) }),
  });

  test(`${build}: preparation freezes the session across tab switches, scrubs credentials and preserves screenshots`, async () => {
    const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
    const start = source.indexOf('async function openStoreReviewPrompt()');
    const end = source.indexOf('async function maybePromptStoreReviewAfterSuccess()', start);
    assert.ok(start >= 0 && end > start);
    let capturedTab, resolveSession, now = 100;
    const panel = vm.createContext({ currentTabId: 71, storeReviewEl: {}, isProcessing: false,
      Date: { now: () => now },
      storeReviewFeedbackEl: { value: 'Previous feedback' }, storeReviewState: {}, storeReviewTraceSource: null,
      sendToBackground: (_action, params) => { capturedTab = params.tabId; return new Promise(resolve => { resolveSession = resolve; }); },
      setStoreReviewStarPreview: () => {}, showStoreReviewStep: () => {}, applyDOMTranslations: () => {},
      markPromptShown: state => state, saveStoreReviewState: async () => {},
    });
    vm.runInContext(source.slice(start, end), panel);
    await vm.runInContext('openStoreReviewPrompt()', panel);
    panel.currentTabId = 99;
    now = 300;
    resolveSession({ sessionId: 'chosen' });
    const captured = await panel.storeReviewTraceSource;
    assert.equal(capturedTab, 71);
    assert.equal(captured.snapshotAt, 100, 'capture must precede the asynchronous session lookup');
    const store = fixtureStore([{ seq: 1, kind: 'tool', data: { name: 'click_ax', args: { api_key: 'private-key' },
      result: { success: false, errorCode: 'TARGET_NOT_FOUND', authorization: 'Bearer hidden' } } },
    { seq: 2, kind: 'screenshot', data: {} }]);
    // Old traces may contain content without a lossless marker.
    const list = store.listRuns; store.listRuns = async () => (await list()).map(run => ({ ...run, lossless: undefined }));
    const trace = await prepareFeedbackTrace(store, captured.sessionId, 'test', { snapshotAt: captured.snapshotAt });
    assert.equal(trace.traceType, 'full'); assert.equal(trace.runCount, 1); assert.equal(trace.screenshotCount, 1);
    assert.equal(trace.blob, trace.originalBlob);
    const json = await trace.blob.text();
    assert.doesNotMatch(json, /top-secret|private-key|Bearer hidden|DO NOT SHARE/);
    assert.match(json, /TARGET_NOT_FOUND/); assert.match(json, /screenshot_base64/);
    assert.equal(await prepareFeedbackTrace({ ...store, listRuns: async () => [] }, 'chosen'), null);
  });

  test(`${build}: feedback excludes later turns, events, screenshots and completion fields`, async () => {
    const runs = [
      { runId: 'completed', conversationId: 'chosen', startedAt: 1, endedAt: 50, status: 'done', finalContent: 'Earlier answer', lossless: true },
      { runId: 'active', conversationId: 'chosen', startedAt: 60, endedAt: 200, status: 'done', finalContent: 'LATER COMPLETION', lossless: true,
        toolCallCount: 99, totalCost: 99 },
      { runId: 'same-tick', conversationId: 'chosen', startedAt: 100, userMessage: 'LATER SAME TICK' },
      { runId: 'later', conversationId: 'chosen', startedAt: 150, userMessage: 'LATER TURN' },
      { runId: 'undated', conversationId: 'chosen', userMessage: 'UNDATED RUN' },
      { runId: 'other', conversationId: 'unrelated', startedAt: 1, userMessage: 'OTHER CONVERSATION' },
    ];
    const events = {
      completed: [{ seq: 1, ts: 20, kind: 'tool', data: { name: 'click_ax', result: { success: true } } }],
      active: [
        { seq: 1, ts: 70, kind: 'tool', data: { name: 'click_ax', result: { success: true } } },
        { seq: 2, ts: 80, kind: 'llm_response', data: { content: 'Earlier response', usage: { cost: 1 } } },
        { seq: 3, ts: 90, kind: 'screenshot', data: { caption: 'Earlier screenshot' } },
        { seq: 4, ts: 100, kind: 'tool', data: { result: { content: 'LATER SAME TICK' } } },
        { seq: 5, ts: 101, kind: 'screenshot', data: { caption: 'LATER SCREENSHOT' } },
        { seq: 6, ts: 120, kind: 'llm_response', data: { content: 'LATER RESPONSE', usage: { cost: 98 } } },
        { seq: 7, kind: 'note', data: { content: 'UNDATED EVENT' } },
      ],
    };
    const readRuns = [], readShots = [];
    const store = {
      listRuns: async () => structuredClone(runs),
      getRunEvents: async runId => { readRuns.push(runId); return structuredClone(events[runId] || []); },
      getScreenshot: async (runId, seq) => {
        readShots.push([runId, seq]);
        return { blob: new Blob([seq === 3 ? 'Earlier pixels' : 'LATER PIXELS'], { type: 'image/png' }) };
      },
    };
    const trace = await prepareFeedbackTrace(store, 'chosen', 'test', { snapshotAt: 100 });
    const text = await trace.blob.text();
    const payload = JSON.parse(text);
    assert.equal(payload.session.capturedBefore, 100);
    assert.deepEqual(payload.runs.map(entry => entry.run.runId), ['completed', 'active']);
    assert.deepEqual(readRuns, ['completed', 'active']);
    assert.deepEqual(readShots, [['active', 3]], 'later screenshot bytes must never be read');
    assert.equal(trace.runCount, 2); assert.equal(trace.screenshotCount, 1);
    assert.equal(payload.runs[0].run.finalContent, 'Earlier answer');
    const active = payload.runs[1];
    assert.deepEqual(active.events.map(event => event.seq), [1, 2, 3]);
    assert.equal(active.run.status, 'running'); assert.equal(active.run.endedAt, null);
    assert.equal(active.run.durationMs, null); assert.equal(active.run.finalContent, null);
    assert.equal(active.run.toolCallCount, 1); assert.equal(active.run.totalCost, 1);
    assert.equal(active.run.feedbackSnapshotIncomplete, true);
    assert.ok(trace.omissions.some(note => note.includes('unfinished')));
    assert.ok(trace.omissions.some(note => note.includes('timestamps')));
    assert.doesNotMatch(text, /LATER|UNDATED|OTHER CONVERSATION/);
    assert.equal(await trace.originalBlob.text(), text);

    const largeStore = { ...store, getRunEvents: async runId => (await store.getRunEvents(runId)).map(event =>
      event.kind === 'tool' && event.ts < 100 ? { ...event, data: { ...event.data, result: { content: 'Earlier content '.repeat(2000) } } } : event) };
    for (const options of [{}, { compress: async () => null }]) {
      const oversized = await prepareFeedbackTrace(largeStore, 'chosen', 'test', { snapshotAt: 100, limit: 6000, ...options });
      const bytes = Buffer.from(await oversized.blob.arrayBuffer());
      const attached = JSON.parse(oversized.filename.endsWith('.gz') ? gunzipSync(bytes).toString() : bytes.toString());
      assert.equal(attached.session.capturedBefore, 100);
      assert.equal(attached.runs[1].run.feedbackSnapshotIncomplete, true);
      assert.doesNotMatch(JSON.stringify(attached), /LATER|UNDATED|OTHER CONVERSATION/);
      assert.doesNotMatch(await oversized.originalBlob.text(), /LATER|UNDATED|OTHER CONVERSATION/);
      assert.equal(oversized.traceType, options.compress ? 'diagnostic' : 'full');
    }

    // The ordinary full export remains complete, including later turns.
    const full = JSON.parse((await exportRecordedSession(store, 'chosen', 'test')).json);
    assert.equal(full.runs.length, 5);
    assert.equal(full.runs.find(entry => entry.run.runId === 'active').run.finalContent, 'LATER COMPLETION');
    assert.equal(full.runs.find(entry => entry.run.runId === 'active').events.length, 7);
    assert.equal(full.session.capturedBefore, undefined);
    for (const snapshotAt of [null, NaN, '100', -1]) {
      await assert.rejects(prepareFeedbackTrace(store, 'chosen', 'test', { snapshotAt }), /snapshot timestamp/);
    }
    assert.equal(await prepareFeedbackTrace(store, 'chosen', 'test', { snapshotAt: 0 }), null);
  });

  test(`${build}: gzip preserves full exports and oversize fallback is explicitly diagnostic`, async () => {
    const events = Array.from({ length: 80 }, (_, index) => ({ seq: index, kind: 'tool', data: {
      name: 'click_ax', result: { content: 'large trace content '.repeat(100), success: false, errorCode: 'CLICK_FAILED' },
    } }));
    const compressed = await prepareFeedbackTrace(fixtureStore(events), 'chosen', 'test', { limit: 6000 });
    assert.match(compressed.filename, /\.json\.gz$/); assert.equal(compressed.traceType, 'full');
    const expanded = JSON.parse(gunzipSync(Buffer.from(await compressed.blob.arrayBuffer())));
    assert.equal(expanded.runs[0].events.length, 80);
    const legacy = fixtureStore(events.map(event => ({ ...event, privateLegacyField: 'PRIVATE LEGACY EVENT' })));
    const listLegacy = legacy.listRuns;
    legacy.listRuns = async () => (await listLegacy()).map(run => ({ ...run, privateLegacyField: 'PRIVATE LEGACY RUN' }));
    const fallback = await prepareFeedbackTrace(legacy, 'chosen', 'test', { limit: 6000, compress: async () => null });
    assert.equal(fallback.traceType, 'diagnostic'); assert.match(fallback.filename, /-diagnostics\.json$/);
    assert.ok(fallback.blob.size < 6000); assert.ok(fallback.originalBlob.size > 6000);
    assert.ok(fallback.omissions.some(note => note.includes('size limit')));
    assert.doesNotMatch(await fallback.blob.text(), /large trace content|top-secret|PRIVATE LEGACY/);
    assert.match(await fallback.blob.text(), /CLICK_FAILED/);
  });

  test(`${build}: snapshot headers are unchanged by later accounting, omission flags or repairs`, async () => {
    const run = { runId: 'r', conversationId: 'chosen', startedAt: 1, endedAt: null, status: 'running',
      lossless: true, losslessBytes: 100, losslessBytesEncoding: 'utf8', feedbackOnly: true,
      feedbackBytes: 200, feedbackHistoryOmitted: true };
    const events = [{ seq: 1, ts: 20, kind: 'tool', data: { name: 'click_ax', result: { success: true } } }];
    const store = { listRuns: async () => [structuredClone(run)],
      getRunEvents: async () => structuredClone(events), getScreenshot: async () => null };
    const first = JSON.parse(await (await prepareFeedbackTrace(store, 'chosen', 'test', { snapshotAt: 100 })).blob.text());
    Object.assign(run, { losslessBytes: 987654, feedbackBytes: 123456, feedbackEventsOmitted: true,
      endedAt: 250, status: 'error', repairedBy: 'LATER REPAIR', repairedAt: 250, repairReason: 'LATER REASON' });
    events.push({ seq: 2, ts: 250, kind: 'tool', data: { losslessBudgetOmitted: true } });
    const second = await prepareFeedbackTrace(store, 'chosen', 'test', { snapshotAt: 100 });
    const payload = JSON.parse(await second.blob.text());
    assert.deepEqual(payload.runs, first.runs);
    assert.deepEqual(payload.feedbackOmissions, first.feedbackOmissions);
    for (const field of ['losslessBytes', 'losslessBytesEncoding', 'feedbackBytes', 'feedbackEventsOmitted', 'repairedBy', 'repairedAt', 'repairReason']) {
      assert.equal(payload.runs[0].run[field], undefined);
    }
    assert.equal(payload.runs[0].run.feedbackHistoryOmitted, true, 'start-time diagnostic policy is immutable');
    assert.doesNotMatch(await second.originalBlob.text(), /987654|123456|LATER/);
    const full = JSON.parse((await exportRecordedSession(store, 'chosen', 'test')).json);
    assert.equal(full.runs[0].run.losslessBytes, 987654);
    assert.equal(full.runs[0].run.feedbackEventsOmitted, true);
    assert.equal(full.runs[0].run.repairedAt, 250);
    assert.equal(run.losslessBytes, 987654, 'snapshot projection must not mutate stored headers');
  });

  test(`${build}: exports preserve diagnostic codes without exposing credential code fields`, async () => {
    const events = [
      { seq: 1, kind: 'tool', data: { name: 'fill_ax', args: { code: 'QUOTA', password: 'private-password' },
        result: { code: 'RATE_LIMIT', content: 'large result '.repeat(2000) } } },
      { seq: 2, kind: 'error', data: { code: 'QUOTA', credentials: { code: 'RATE_LIMIT' } } },
      { seq: 3, kind: 'note', data: { note: 'llm_retry', extra: { code: 'RATE_LIMIT', authCode: '654321' } } },
      { seq: 4, kind: 'turn_end', data: { code: 'COST_LIMIT' } },
      { seq: 5, kind: 'error', data: { code: '654321' } },
      { seq: 6, kind: 'note', data: { note: 'llm_retry', extra: { code: '654321' } } },
    ];
    const original = structuredClone(events);
    const check = entry => {
      assert.equal(entry.events[1].data.code, 'QUOTA');
      assert.equal(entry.events[2].data.extra.code, 'RATE_LIMIT');
      assert.equal(entry.events[3].data.code, 'COST_LIMIT');
      assert.equal(entry.events[4].data.code, '[redacted]');
      assert.equal(entry.events[5].data.extra.code, '[redacted]');
    };
    const standalone = sanitizeTraceExport({ run: { lossless: true, code: 'QUOTA' }, events });
    check(standalone);
    assert.equal(standalone.run.code, '[redacted]');
    assert.equal(standalone.events[0].data.args.code, '[redacted]');
    assert.equal(standalone.events[0].data.result.code, '[redacted]');
    assert.equal(standalone.events[1].data.credentials.code, '[redacted]');
    assert.equal(standalone.events[2].data.extra.authCode, '[redacted]');
    for (const lossless of [undefined, false, true]) {
      const store = { listRuns: async () => [{ runId: 'codes', conversationId: 'codes', lossless }],
        getRunEvents: async () => structuredClone(events), getScreenshot: async () => null };
      for (const options of [{}, { limit: 4000, compress: async () => null }]) {
        const trace = await prepareFeedbackTrace(store, 'codes', 'test', options);
        const payload = JSON.parse(await trace.blob.text());
        check(payload.runs[0]);
        assert.doesNotMatch(await trace.originalBlob.text(), /private-password|654321/);
      }
    }
    assert.deepEqual(events, original, 'sanitizing must not mutate the recorded events');
  });

  test(`${build}: cancelling and declining trace consent never opens an upload handoff`, async () => {
    for (const choice of ['cancel', 'without', 'upload']) {
      const calls = [];
      const result = await submitFeedbackWithTrace({
        rating: 2, comment: 'Clicking failed', copy: getFeedbackCopy('en'),
        prepare: async () => { calls.push('prepare'); return { traceType: 'full', runCount: 1, screenshotCount: 1, omissions: [] }; },
        stage: async () => { calls.push('stage'); return { id: 'staged' }; },
        consent: async () => { calls.push('consent'); return choice; },
        discard: async () => calls.push('discard'),
        open: async args => calls.push(args.includeTrace ? 'upload' : 'text-only'),
      });
      assert.equal(result, choice !== 'cancel');
      assert.equal(calls.includes('upload'), choice === 'upload');
      if (choice === 'cancel') assert.deepEqual(calls, ['prepare', 'stage', 'consent', 'discard']);
      if (choice === 'upload') assert.deepEqual(calls, ['prepare', 'stage', 'consent', 'upload']);
    }
  });

  test(`${build}: disabled tracing uses only bounded metadata and preserves explicit recordings`, () => {
    assert.deepEqual(feedbackRecordingPolicy({ losslessTrace: true }), { enabled: true, feedbackOnly: true, lossless: false });
    assert.equal(feedbackRecordingPolicy({ feedbackDiagnosticsEnabled: false }).enabled, false);
    assert.equal(feedbackRecordingPolicy({ tracingEnabled: true, losslessTrace: true }).lossless, true);
    assert.equal(parseConfigImport(JSON.stringify(createConfigExport({ feedbackDiagnosticsEnabled: false }))).settings.feedbackDiagnosticsEnabled, false);
    const now = Date.now();
    const runs = Array.from({ length: 12 }, (_, i) => ({ runId: String(i), startedAt: now - i, status: 'done', feedbackOnly: true, feedbackBytes: 10 }));
    runs.push({ runId: 'explicit', startedAt: 1, status: 'done' }, { runId: 'active', startedAt: now, status: 'running', feedbackOnly: true });
    assert.deepEqual(feedbackRunsToEvict(runs, now), ['10', '11']);
    assert.equal(feedbackRunsToEvict(runs, now + 8 * 86400000).includes('explicit'), false);
    assert.ok(feedbackRunsToEvict(runs.map(run => ({ ...run, feedbackBytes: 1024 * 1024 })), now).length >= 11);
  });

  test(`${build}: handoff rejects wrong origin, repository, tab, subframe, expiry and missing consent`, () => {
    const url = 'https://github.com/webbrain-one/webbrain/issues/new';
    const sender = { frameId: 0, tab: { id: 4 }, url };
    const draft = { authorized: true, destinationTabId: 4, expiresAt: Date.now() + 10000 };
    assert.equal(mayReadFeedbackDraft(draft, sender, url), true);
    for (const bad of ['https://github.com.evil.test/webbrain-one/webbrain/issues/new', 'https://github.com/other/repo/issues/new', 'http://github.com/webbrain-one/webbrain/issues/new']) {
      assert.equal(isFeedbackDestination(bad), false); assert.equal(mayReadFeedbackDraft(draft, sender, bad), false);
    }
    assert.equal(mayReadFeedbackDraft(draft, { ...sender, frameId: 1 }, url), false);
    assert.equal(mayReadFeedbackDraft(draft, { ...sender, tab: { id: 5 } }, url), false);
    assert.equal(mayReadFeedbackDraft({ ...draft, authorized: false }, sender, url), false);
    assert.equal(mayReadFeedbackDraft({ ...draft, expiresAt: 0 }, sender, url), false);
  });

  async function browserFixture(run) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      const prefix = `https://feedback-fixture.test/${build}/`;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'feedback-fixture.test' || !url.pathname.startsWith(`/${build}/`)) return route.abort();
        const relative = url.pathname.slice(build.length + 2);
        if (!relative) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><button id="send">Send feedback</button>' });
        const file = resolve(`src/${build}`, relative);
        if (!file.startsWith(resolve(`src/${build}`) + sep)) return route.abort();
        await route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(file) });
      });
      const panel = await context.newPage(); await panel.goto(prefix);
      await panel.addStyleTag({ path: `src/${build}/styles/sidepanel.css` });
      await panel.addStyleTag({ path: `src/${build}/src/ui/feedback-consent.css` });
      await panel.evaluate(prefix => {
        const listeners = () => ({ addListener: () => {} });
        globalThis.settings = {};
        globalThis.tabs = new Map(); globalThis.createdTabs = 0; globalThis.injectedTabs = [];
        const api = {
          runtime: { id: 'fixture-extension', getURL: file => prefix + file, getManifest: () => ({ version: 'test' }) },
          storage: { local: { get: async () => settings, set: async value => Object.assign(settings, value) } },
          tabs: {
            onUpdated: listeners(), onRemoved: listeners(),
            create: async ({ url }) => { const tab = { id: ++createdTabs, url }; tabs.set(tab.id, tab); return tab; },
            get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id); },
            update: async (id, options) => { Object.assign(tabs.get(id), options); return tabs.get(id); },
            remove: async id => tabs.delete(id),
            executeScript: async id => injectedTabs.push(id),
          },
          alarms: { onAlarm: listeners(), create: () => {} },
        };
        if (prefix.includes('/chrome/')) api.scripting = { executeScript: async ({ target }) => injectedTabs.push(target.tabId) };
        globalThis.chrome = globalThis.browser = api;
      }, prefix);
      await run({ context, panel, prefix });
    } finally { await browser.close(); }
  }

  test(`${build}: real IndexedDB recorder retains bounded diagnostics without raw text or screenshot bytes`, async () => browserFixture(async ({ panel }) => {
    const outcome = await panel.evaluate(async () => {
      const trace = await import('./src/trace/recorder.js');
      settings.tracingEnabled = true; settings.losslessTrace = true;
      await trace.startRun({ runId: 'explicit', conversationId: 'explicit-session', userMessage: 'Keep my opted-in trace' });
      await trace.endRun('explicit');
      settings.tracingEnabled = false; // A stale lossless=true must not affect diagnostics.
      for (let i = 0; i < 12; i++) {
        const runId = await trace.startRun({ runId: `auto-${i}`, conversationId: 'diagnostic-session', userMessage: 'PRIVATE USER TEXT' });
        await trace.recordToolCall(runId, 1, { name: 'click_ax', args: { text: 'PRIVATE ARG' }, result: { success: false, error: 'PRIVATE ERROR', errorCode: 'CLICK_FAILED' } });
        await trace.recordScreenshot(runId, 1, 'data:image/png;base64,aW1hZ2U=', 'screenshot marker');
        await trace.endRun(runId, { status: 'failed', finalContent: 'PRIVATE ANSWER' });
      }
      const runs = await trace.listRuns({ limit: 100 });
      const automatic = runs.filter(run => run.feedbackOnly);
      const events = await trace.getRunEvents(automatic[0].runId);
      const shot = await trace.getScreenshot(automatic[0].runId, events.find(event => event.kind === 'screenshot').seq);
      const before = JSON.stringify({ automatic, events });
      for (let i = 0; i < 200; i++) await trace.recordNote(automatic[0].runId, i, 'timing', { context: 'x'.repeat(3000) });
      await trace.flushPendingWrites();
      const capped = await trace.getRun(automatic[0].runId);
      // Screenshot markers must use the same byte budget, despite having no pixels.
      for (let i = 0; i < 200; i++) await trace.recordScreenshot(automatic[0].runId, i, 'data:image/png;base64,aW1hZ2U=', 'marker'.repeat(1000));
      const screenshotCapped = await trace.getRun(automatic[0].runId);
      // Parallel conversations share a single 2 MiB budget, including headers.
      const active = await Promise.all(Array.from({ length: 20 }, (_, i) => trace.startRun({ runId: `parallel-${i}`, conversationId: `parallel-session-${i}` })));
      await Promise.all(active.filter(Boolean).map(runId => trace.recordNote(runId, 1, 'timing', { context: 'x'.repeat(120000) })));
      const boundedRuns = await trace.listRuns({ limit: 100 });
      const totalBytes = boundedRuns.filter(run => run.feedbackOnly).reduce((sum, run) => sum + run.feedbackBytes, 0);
      await trace.pruneFeedbackDiagnostics({ now: Date.now() + 8 * 86400000 });
      const after = await trace.listRuns({ limit: 100 });
      settings.feedbackDiagnosticsEnabled = false;
      return { count: automatic.length, before, shot, capped, screenshotCapped, totalBytes, after, disabled: await trace.startRun({ runId: 'disabled' }) };
    });
    assert.equal(outcome.count, 10); assert.equal(outcome.shot, undefined);
    assert.doesNotMatch(outcome.before, /PRIVATE/); assert.match(outcome.before, /CLICK_FAILED/);
    assert.equal(outcome.capped.feedbackEventsOmitted, true); assert.ok(outcome.capped.feedbackBytes <= 128 * 1024);
    assert.ok(outcome.screenshotCapped.feedbackBytes <= 128 * 1024);
    assert.ok(outcome.totalBytes <= 2 * 1024 * 1024);
    assert.deepEqual(outcome.after.map(run => run.runId), ['explicit']); assert.equal(outcome.disabled, null);
  }));

  test(`${build}: an evicted completed run still returns its workflow capture`, async () => browserFixture(async ({ panel }) => {
    const outcome = await panel.evaluate(async () => {
      const trace = await import('./src/trace/recorder.js');
      const originalNow = Date.now;
      let clock = originalNow() - 60000;
      Date.now = () => clock;
      try {
        await trace.startRun({ runId: 'slow', conversationId: 'slow-session' });
        await trace.recordToolCall('slow', 1, { name: 'click_ax', args: { id: 'slow-target' }, result: { success: true } });
        for (let i = 0; i < 10; i++) {
          clock += 1000;
          await trace.startRun({ runId: `fast-${i}`, conversationId: `fast-session-${i}` });
          await trace.endRun(`fast-${i}`);
        }
        const workflow = await trace.endRun('slow');
        return { workflow, evicted: await trace.getRun('slow') === undefined,
          retained: (await trace.listRuns()).length, released: await trace.endRun('slow') === null };
      } finally { Date.now = originalNow; }
    });
    assert.equal(outcome.evicted, true); assert.equal(outcome.retained, 10);
    assert.equal(outcome.workflow?.run.runId, 'slow'); assert.equal(outcome.workflow?.run.status, 'done');
    assert.equal(outcome.workflow?.events[0].data.args.id, 'slow-target');
    assert.equal(outcome.released, true);
  }));

  test(`${build}: consent dialog, staged handoff, native attachment, restart recovery and cleanup`, async () => browserFixture(async ({ context, panel, prefix }) => {
    await panel.evaluate(async () => {
      const { createFeedbackHandoff } = await import('./src/feedback-handoff.js');
      const { prepareFeedbackTrace } = await import('./src/trace/feedback-export.js');
      const { stageFeedbackTrace, deleteFeedbackDraft, listFeedbackDrafts, putFeedbackDraft, sweepFeedbackDrafts } = await import('./src/feedback-store.js');
      const { getFeedbackCopy } = await import('./src/ui/feedback-copy.js');
      const { requestFeedbackConsent, submitFeedbackWithTrace } = await import('./src/ui/feedback-consent.js');
      const trace = await import('./src/trace/recorder.js');
      const copy = getFeedbackCopy('en');
      globalThis.controller = createFeedbackHandoff(chrome);
      globalThis.localViews = 0;
      settings.tracingEnabled = true; settings.losslessTrace = true;
      const originalNow = Date.now;
      let clock = originalNow() - 10000;
      const snapshotAt = clock + 1000;
      Date.now = () => clock;
      try {
        const runId = await trace.startRun({ runId: 'r', conversationId: 'frozen-session' });
        await trace.recordToolCall(runId, 1, { name: 'click_ax', result: { errorCode: 'CLICK_FAILED', password: 'hidden-secret' } });
        await trace.recordScreenshot(runId, 1, 'data:image/png;base64,aW1hZ2U=', 'Earlier screenshot');
        clock += 2000;
        await trace.recordToolCall(runId, 2, { name: 'click_ax', result: { content: 'LATER TOOL RESULT' } });
        await trace.recordScreenshot(runId, 2, 'data:image/png;base64,TEFURVI=', 'LATER SCREENSHOT');
        await trace.endRun(runId, { finalContent: 'LATER COMPLETION' });
        const laterRunId = await trace.startRun({ runId: 'later', conversationId: 'frozen-session', userMessage: 'LATER TURN' });
        await trace.endRun(laterRunId);
        await trace.flushPendingWrites();
      } finally { Date.now = originalNow; }
      globalThis.prepared = await prepareFeedbackTrace(trace, 'frozen-session', 'test', { snapshotAt });
      globalThis.start = () => submitFeedbackWithTrace({
        rating: 2, comment: 'Clicking failed', copy,
        prepare: async () => prepared,
        stage: stageFeedbackTrace, discard: deleteFeedbackDraft,
        consent: (trace, record) => requestFeedbackConsent(trace, copy, async () => {
          localViews += 1;
          const rows = await listFeedbackDrafts();
          if (!rows.find(row => row.id === record.id && !row.authorized)) throw new Error('View must be local before consent');
        }),
        open: params => controller.handle({ action: 'feedback_open', ...params }, { id: chrome.runtime.id, url: chrome.runtime.getURL('src/ui/sidepanel.html') }),
      }).then(result => globalThis.flowResult = result);
      globalThis.store = { listFeedbackDrafts, putFeedbackDraft, sweepFeedbackDrafts };
    });
    await panel.evaluate(() => { void start(); });
    await panel.locator('dialog').waitFor({ state: 'visible' });
    assert.equal(await panel.evaluate(() => createdTabs), 0);
    await panel.getByRole('button', { name: 'View trace', exact: true }).click();
    assert.equal(await panel.evaluate(() => localViews), 1); assert.equal(await panel.evaluate(() => createdTabs), 0);
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await panel.waitForFunction(() => globalThis.flowResult === false);
    assert.equal(await panel.evaluate(async () => (await store.listFeedbackDrafts()).length), 0);
    await panel.evaluate(() => { flowResult = undefined; void start(); });
    await panel.locator('dialog').waitFor({ state: 'visible' });
    await mkdir('build/feedback-tests', { recursive: true });
    await panel.screenshot({ path: `build/feedback-tests/${build}-consent.png` });
    await panel.getByRole('button', { name: 'Upload trace and open GitHub', exact: true }).click();
    await panel.waitForFunction(() => globalThis.flowResult === true);
    const tab = await panel.evaluate(() => [...tabs.values()][0]);
    const reauthorized = await panel.evaluate(async () => {
      const record = (await store.listFeedbackDrafts())[0];
      try { await controller.handle({ action: 'feedback_open', id: record.id, includeTrace: true, rating: 2 }, { id: chrome.runtime.id, url: chrome.runtime.getURL('src/ui/sidepanel.html') }); return true; }
      catch { return false; }
    });
    assert.equal(reauthorized, false, 'an already authorized draft must be prepared and confirmed again');
    assert.match(tab.url, /github\.com\/webbrain-one\/webbrain\/issues\/new/);
    const initialBody = new URL(tab.url).searchParams.get('body');
    const github = await context.newPage();
    await github.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><main><form><textarea id="issue_body"></textarea><input type="file"><button type="button" id="submit">Submit new issue</button></form></main>` }));
    await github.goto(tab.url);
    await github.exposeFunction('handoff', msg => panel.evaluate(({ msg, tab }) => controller.handle(msg, { id: chrome.runtime.id, url: tab.url, frameId: 0, tab }), { msg, tab }));
    await github.evaluate(initialBody => {
      document.querySelector('textarea').value = initialBody;
      globalThis.uploads = 0; globalThis.submissions = 0;
      document.querySelector('#submit').addEventListener('click', () => submissions++);
      document.querySelector('input').addEventListener('change', async event => {
        uploads += 1;
        const file = event.target.files[0]; globalThis.uploadedText = await file.text();
        document.querySelector('textarea').value += `\n[${file.name}](https://github.com/user-attachments/files/123/${file.name})`;
      });
      globalThis.chrome = { runtime: { sendMessage: handoff } };
    }, initialBody);
    const content = await readFile(`src/${build}/src/content/feedback-attachment.js`, 'utf8');
    await github.addScriptTag({ content });
    await github.waitForFunction(() => document.body.textContent.includes('Trace attached.'));
    assert.equal(await github.evaluate(() => uploads), 1);
    assert.equal(await github.evaluate(() => submissions), 0);
    const attachment = await github.evaluate(() => uploadedText);
    assert.doesNotMatch(attachment, /hidden-secret|LATER/);
    const snapshot = JSON.parse(attachment);
    assert.deepEqual(snapshot.runs.map(entry => entry.run.runId), ['r']);
    assert.equal(snapshot.runs[0].run.finalContent, null);
    assert.equal(snapshot.runs[0].run.losslessBytes, undefined);
    assert.equal(snapshot.runs[0].run.losslessBytesEncoding, undefined);
    assert.equal(snapshot.runs[0].events.filter(event => event.kind === 'screenshot').length, 1);
    assert.match(await github.locator('textarea').inputValue(), /Clicking failed/);
    await github.addScriptTag({ content }); assert.equal(await github.evaluate(() => uploads), 1);
    assert.equal(await panel.evaluate(async () => (await store.listFeedbackDrafts()).length), 0);

    // Recreate a staged, authorized draft in an interrupted upload state.
    const retry = await panel.evaluate(async tab => {
      const { stageFeedbackTrace } = await import('./src/feedback-store.js');
      const record = await stageFeedbackTrace(prepared);
      record.authorized = true; record.includeTrace = true; record.destinationTabId = tab.id;
      record.body = 'Original feedback'; record.initialBody = ''; record.status = 'pending';
      await store.putFeedbackDraft(record); return { id: record.id, token: record.token };
    }, tab);
    const wrongToken = await panel.evaluate(async ({ tab, retry }) => {
      try { await controller.handle({ action: 'feedback_chunk', id: retry.id, token: 'wrong', offset: 0 }, { id: chrome.runtime.id, url: tab.url, frameId: 0, tab }); return false; } catch { return true; }
    }, { tab, retry }); assert.equal(wrongToken, true);
    const dispatches = await panel.evaluate(async ({ tab, retry }) => {
      const msg = { action: 'feedback_upload_started', ...retry };
      const sender = { id: chrome.runtime.id, url: tab.url, frameId: 0, tab };
      return (await Promise.allSettled([controller.handle(msg, sender), controller.handle(msg, sender)])).map(result => result.status);
    }, { tab, retry });
    assert.deepEqual(dispatches.sort(), ['fulfilled', 'rejected']);
    await github.reload();
    await github.evaluate(() => {
      document.querySelector('textarea').value = 'User edits must survive'; globalThis.uploads = 0;
      document.querySelector('input').addEventListener('change', event => {
        uploads++; const file = event.target.files[0];
        document.querySelector('textarea').value += `\n[${file.name}](https://github.com/user-attachments/files/123/${file.name})`;
      });
      globalThis.chrome = { runtime: { sendMessage: handoff } };
    });
    await github.addScriptTag({ content });
    await github.getByRole('button', { name: 'Retry attachment', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await github.evaluate(() => uploads), 0);
    await github.getByRole('button', { name: 'Retry attachment', exact: true }).click();
    await github.waitForFunction(() => document.body.textContent.includes('Trace attached.'));
    assert.equal(await github.evaluate(() => uploads), 1);
    assert.match(await github.locator('textarea').inputValue(), /^User edits must survive/);
    await panel.evaluate(async () => {
      const { stageFeedbackTrace } = await import('./src/feedback-store.js');
      const record = await stageFeedbackTrace(prepared);
      record.expiresAt = 0; await store.putFeedbackDraft(record); await store.sweepFeedbackDrafts();
    });
    assert.equal(await panel.evaluate(async () => (await store.listFeedbackDrafts()).length), 0);
  }));
}

test('Chrome unpacked extension: worker flush, consent, login return and isolated native upload', async () => {
  await mkdir('build/feedback-tests', { recursive: true });
  // A fresh profile avoids Chromium's persisted extension-module cache.
  const profile = await mkdtemp(resolve('build/feedback-tests/extension-'));
  const extension = resolve('src/chrome');
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    let loggedIn = false, uploads = 0, uploadedText = '';
    await context.exposeFunction('recordFeedbackUpload', text => { uploads++; uploadedText = text; });
    await context.route('https://github.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/login') return route.fulfill({ contentType: 'text/html', body:
        `<!doctype html><a href="${url.searchParams.get('return_to')}">Return to feedback</a>` });
      if (!loggedIn) {
        loggedIn = true;
        // Playwright routes only the first request in an HTTP redirect chain.
        // Navigate from the fixture so the login document is intercepted too.
        return route.fulfill({ contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(`https://github.com/login?return_to=${encodeURIComponent(url.href)}`)})</script>` });
      }
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><main><form>
        <textarea id="issue_body"></textarea><input type="file"><button type="button">Submit new issue</button></form></main>
        <script>
          document.querySelector('textarea').value = new URL(location.href).searchParams.get('body') || '';
          document.querySelector('input').addEventListener('change', async event => {
            const file = event.target.files[0]; await recordFeedbackUpload(await file.text());
            document.querySelector('textarea').value += '\\n[' + file.name + '](https://github.com/user-attachments/files/123/' + file.name + ')';
          });
        </script>` });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
    const panel = await context.newPage();
    await panel.goto(`${origin}/src/ui/sidepanel.html`);
    const flush = await panel.evaluate(() => chrome.runtime.sendMessage({ target: 'background', action: 'feedback_flush' }));
    assert.equal(flush.ok, true, flush.error);
    await panel.evaluate(async () => {
      const { prepareFeedbackTrace } = await import('../trace/feedback-export.js');
      const { stageFeedbackTrace, deleteFeedbackDraft } = await import('../feedback-store.js');
      const { submitFeedbackWithTrace, requestFeedbackConsent } = await import('./feedback-consent.js');
      const { getFeedbackCopy } = await import('./feedback-copy.js');
      const copy = getFeedbackCopy('en');
      const prepared = await prepareFeedbackTrace({
        listRuns: async () => [{ runId: 'native', conversationId: 'native-session', lossless: true }],
        getRunEvents: async () => [{ seq: 1, kind: 'tool', data: { name: 'click_ax', result: { password: 'NATIVE SECRET', success: false } } }],
        getScreenshot: async () => null,
      }, 'native-session');
      void submitFeedbackWithTrace({ rating: 2, comment: 'Native extension feedback', copy,
        prepare: async () => prepared, stage: stageFeedbackTrace, discard: deleteFeedbackDraft,
        consent: trace => requestFeedbackConsent(trace, copy, async () => {}),
        open: async params => {
          const result = await chrome.runtime.sendMessage({ target: 'background', action: 'feedback_open', ...params });
          if (!result.ok) throw new Error(result.error);
        },
      }).then(result => globalThis.feedbackResult = result).catch(error => globalThis.feedbackError = error.message);
    });
    await panel.locator('dialog.feedback-trace-dialog').waitFor({ state: 'visible' });
    assert.equal(uploads, 0);
    assert.equal(context.pages().some(page => page.url().startsWith('https://github.com/')), false);
    const githubOpened = context.waitForEvent('page');
    await panel.getByRole('button', { name: 'Upload trace and open GitHub', exact: true }).click();
    await panel.waitForFunction(() => feedbackResult === true || globalThis.feedbackError);
    assert.equal(await panel.evaluate(() => globalThis.feedbackError), undefined);
    const github = await githubOpened;
    await github.getByRole('link', { name: 'Return to feedback' }).waitFor({ state: 'visible' });
    assert.equal(uploads, 0, 'login must not receive trace bytes');
    const cdp = await context.browser().newBrowserCDPSession();
    const targets = await cdp.send('Target.getTargets');
    const workerTarget = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(origin));
    assert.ok(workerTarget);
    await cdp.send('Target.closeTarget', { targetId: workerTarget.targetId });
    await cdp.detach();
    await github.getByRole('link', { name: 'Return to feedback' }).click();
    await github.getByText('Trace attached. Review and submit your feedback on GitHub.', { exact: true }).waitFor();
    assert.equal(uploads, 1); assert.doesNotMatch(uploadedText, /NATIVE SECRET/);
    assert.match(await github.locator('textarea').inputValue(), /Native extension feedback/);
    assert.equal(await panel.evaluate(async () => (await (await import('../feedback-store.js')).listFeedbackDrafts()).length), 0);
    // Closing a destination also clears abandoned temporary exports.
    await panel.evaluate(async () => {
      const store = await import('../feedback-store.js');
      const [tab] = await chrome.tabs.query({ url: 'https://github.com/webbrain-one/webbrain/issues/new*' });
      await store.putFeedbackDraft({ id: 'closing-tab', destinationTabId: tab.id, authorized: false, expiresAt: Date.now() + 3600000 });
    });
    await github.close();
    await panel.waitForFunction(async () => (await (await import('../feedback-store.js')).listFeedbackDrafts()).length === 0);
    const settings = await context.newPage();
    await settings.goto(`${origin}/src/ui/settings.html`);
    const cleared = await settings.evaluate(() => chrome.runtime.sendMessage({ target: 'background', action: 'feedback_clear_diagnostics' }));
    assert.equal(cleared.ok, true, cleared.error);
  } finally { await context.close(); }
});
