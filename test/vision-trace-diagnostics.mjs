import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium, firefox } from 'playwright';

const PRIVATE = 'PRIVATE-VISION-CONTENT';
const frameId = 'vf-mhf00-1-2';
const baseFrameId = 'vf-mhf00-1-1';
const frame = {
  protocol: 'vision-frame-v1', kind: 'delta', frameId, baseFrameId, previousFrameId: baseFrameId,
  canvas: { width: 1280, height: 720, private: PRIVATE },
  source: { width: 2560, height: 1440, dataUrl: `data:image/png;base64,${PRIVATE}` },
  viewport: { width: 1280, height: 720, devicePixelRatio: 2, zoom: 1.25, scale: 1,
    url: `https://${PRIVATE}.test/`, documentId: PRIVATE, scrollY: 250, offsetLeft: 10 },
  images: [{ id: `${frameId}-p1`, rect: { x: 50, y: 20, width: 64, height: 64 },
    dataUrl: `data:image/jpeg;base64,${PRIVATE}` }],
  bytes: 9800, estimatedTokens: 170, capturedAt: 1792893519286,
  captureMs: 43, encodingMs: 12, attempt: 2, reason: 'after-action', phase: 'vision_after_action_capture',
  url: `https://${PRIVATE}.test/`, text: PRIVATE,
};
const safeFrame = {
  protocol: 'vision-frame-v1', kind: 'delta', frameId, baseFrameId, previousFrameId: baseFrameId,
  canvas: { width: 1280, height: 720 }, source: { width: 2560, height: 1440 },
  viewport: { width: 1280, height: 720, devicePixelRatio: 2, zoom: 1.25, scale: 1 },
  bytes: 9800, estimatedTokens: 170, capturedAt: 1792893519286,
  captureMs: 43, encodingMs: 12, attempt: 2, imageCount: 1,
  reason: 'after-action', phase: 'vision_after_action_capture',
};
const failure = {
  phase: 'vision_after_action_capture', code: 'VISION_STALE_FRAME', reason: 'page_changed',
  attempt: 2, durationMs: 340, retryable: true,
  captureDiagnostics: { browser: 'chrome', stage: 'viewport_evaluate', reason: 'context_changed',
    message: PRIVATE, url: `https://${PRIVATE}.test/`, screenshot: PRIVATE },
  error: PRIVATE, message: PRIVATE, url: `https://${PRIVATE}.test/`, dataUrl: `data:image/png;base64,${PRIVATE}`,
};
const safeFailure = {
  phase: 'vision_after_action_capture', code: 'VISION_STALE_FRAME', reason: 'page_changed',
  attempt: 2, durationMs: 340, retryable: true,
  captureDiagnostics: { browser: 'chrome', stage: 'viewport_evaluate', reason: 'context_changed' },
};

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);
  const { buildPromptTraceProvenance } = await import(`../src/${build}/src/trace/prompt-provenance.js`);
  const { normalizeErrorCode, isErrorCode } = await import(`../src/${build}/src/trace/error-codes.js`);
  const { sanitizeTraceExport, tracesToMarkdown } = await import(`../src/${build}/src/agent/trace-export.js`);
  const { diagnosticFeedbackPayload, prepareFeedbackTrace } = await import(`../src/${build}/src/trace/feedback-export.js`);

  test(`${build}: visual frame metadata survives repeated diagnostic projection without images or URLs`, () => {
    for (const includeContent of [false, true]) {
      const projected = projectTraceEventData('note', { step: 3, note: 'vision_frame', extra: frame }, { includeContent });
      assert.deepEqual(projected, { step: 3, note: 'vision_frame', extra: safeFrame });
      assert.deepEqual(projectTraceEventData('note', projected), projected, 'feedback fallback projects durable events again');
      assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|data:image|https:|documentId|scrollY|offsetLeft/);
    }
    for (const [kind, imageCount, bytes] of [['full', 1, 120000], ['delta', 2, 9800], ['unchanged', 0, 0]]) {
      const projected = projectTraceEventData('note', { note: 'vision_frame', extra: {
        ...frame, kind, imageCount, bytes, images: [], previousFrameId: kind === 'full' ? null : baseFrameId,
      } });
      assert.equal(projected.extra.kind, kind);
      assert.equal(projected.extra.imageCount, imageCount);
      assert.equal(projected.extra.bytes, bytes);
      assert.equal(projected.extra.previousFrameId, kind === 'full' ? null : baseFrameId);
    }
    assert.equal(frame.images[0].dataUrl, `data:image/jpeg;base64,${PRIVATE}`, 'projection must not modify the provider packet');
  });

  test(`${build}: visual metadata rejects malformed strings and bounds numbers instead of copying nested data`, () => {
    const projected = projectTraceEventData('note', { step: NaN, note: 'vision_frame', extra: {
      protocol: PRIVATE, kind: PRIVATE, frameId: PRIVATE, baseFrameId: `vf-${PRIVATE}-1-1`, previousFrameId: { value: PRIVATE },
      canvas: { width: '1280', height: -1 }, source: { width: Infinity, height: 0 },
      viewport: { width: 1e9, height: 500, devicePixelRatio: '2', zoom: -1, scale: 1e3, url: PRIVATE },
      imageCount: 1000, bytes: -1, estimatedTokens: '700', capturedAt: Infinity,
      captureMs: 1e8, encodingMs: NaN, attempt: 2.5, reason: PRIVATE, phase: PRIVATE,
    } });
    assert.deepEqual(projected, { step: 0, note: 'vision_frame', extra: {
      viewport: { width: 65536, height: 500, scale: 64 }, captureMs: 600000, imageCount: 64,
    } });
    const other = projectTraceEventData('note', { step: 1, note: 'ordinary_note', extra: { frameId, images: frame.images, viewport: frame.viewport } });
    assert.deepEqual(other, { step: 1, note: 'ordinary_note' }, 'visual fields must not become generic note privileges');
  });

  test(`${build}: capture failures and lifecycle phases use finite codes without recording error contents`, () => {
    for (const code of ['VISION_CAPTURE_FAILED', 'VISION_FRAME_FAILED', 'VISION_PRIVACY_FAILED', 'VISION_STALE_FRAME', 'VISION_INPUT_FAILED', 'VISION_UNSUPPORTED']) {
      assert.equal(isErrorCode(code), true);
      assert.equal(normalizeErrorCode(code), code);
    }
    assert.equal(normalizeErrorCode(PRIVATE), 'UNKNOWN');
    for (const includeContent of [false, true]) {
      assert.deepEqual(projectTraceEventData('note', { step: 3, note: 'vision_capture_failure', extra: failure }, { includeContent }),
        { step: 3, note: 'vision_capture_failure', extra: safeFailure });
      assert.deepEqual(projectTraceEventData('note', { note: 'vision_capture_failure', extra: {
        phase: PRIVATE, code: PRIVATE, reason: PRIVATE, attempt: '3', durationMs: -1, retryable: PRIVATE,
      } }, { includeContent }), { step: 0, note: 'vision_capture_failure', extra: {} });
    }
    const end = { step: 3, status: 'error', ok: false, code: 'VISION_CAPTURE_FAILED', phase: 'vision_after_action_capture', durationMs: 500 };
    assert.deepEqual(projectTraceEventData('turn_end', { ...end, message: PRIVATE }), end);
    assert.deepEqual(projectTraceEventData('turn_end', { step: 3, phase: PRIVATE }), { step: 3 });
    assert.deepEqual(projectTraceEventData('error', { step: 3, phase: end.phase, code: end.code, message: PRIVATE }),
      { step: 3, phase: end.phase, code: end.code });
  });

  test(`${build}: native capture diagnostics admit only closed labels through repeated feedback projection`, () => {
    for (const includeContent of [false, true]) {
      const projected = projectTraceEventData('note', { note: 'vision_capture_failure', extra: {
        captureDiagnostics: { browser: build, stage: 'debugger_attach', reason: 'restricted_target',
          url: PRIVATE, message: PRIVATE, pageClass: PRIVATE, nativeCode: PRIVATE },
      } }, { includeContent });
      assert.deepEqual(projected.extra.captureDiagnostics, { browser: build, stage: 'debugger_attach', reason: 'restricted_target' });
      assert.deepEqual(projectTraceEventData('note', projected, { includeContent }), projected);
      assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|url|message|pageClass|nativeCode/);
      for (const diagnostics of [PRIVATE, [PRIVATE], { browser: PRIVATE, stage: PRIVATE, reason: PRIVATE },
        { browser: { toString: () => 'chrome' }, stage: 12, reason: ['unknown'] }]) {
        assert.deepEqual(projectTraceEventData('note', { note: 'vision_capture_failure', extra: { captureDiagnostics: diagnostics } }, { includeContent }),
          { step: 0, note: 'vision_capture_failure', extra: {} });
      }
      assert.deepEqual(projectTraceEventData('note', { note: 'ordinary_note', extra: {
        captureDiagnostics: { browser: build, stage: 'screenshot', reason: 'timeout' },
      } }, { includeContent: false }), { note: 'ordinary_note' });
    }
  });

  test(`${build}: visual Act and Dev prompt provenance recognizes the trusted image observation envelope`, () => {
    for (const mode of ['act', 'dev']) {
      const messages = [
        { role: 'system', content: `You are WebBrain in visual ${mode === 'act' ? 'Act' : 'Dev'} mode.\n${PRIVATE}` },
        { role: 'user', content: `Authoritative execution state: runtime_mode=ask; mutation_tools_enabled=false. ${PRIVATE}` },
        { role: 'user', content: [{ type: 'text', text: `Authoritative execution state: runtime_mode=${mode}; mutation_tools_enabled=true. Current browser observation.` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PRIVATE}` } }] },
      ];
      const provenance = buildPromptTraceProvenance(messages, [{ function: { name: 'vision_click' } }], mode);
      assert.equal(provenance.systemPromptVariant, `${mode}_vision`);
      assert.equal(provenance.systemPromptMode, mode);
      assert.equal(provenance.runtimeEnvelopeMode, mode);
      assert.equal(provenance.runtimeEnvelopeMatches, true);
      assert.equal(provenance.systemPromptMatchesRuntime, true);
      assert.equal(provenance.runtimeEnvelopeMutationToolsEnabled, true);
      assert.equal(provenance.runtimeEnvelopeRequired, true);
      assert.doesNotMatch(JSON.stringify(provenance), /PRIVATE|vision_click|data:image/);
      const request = projectTraceEventData('llm_request', { step: 3, promptProvenance: provenance, messages });
      assert.equal(request.promptProvenance.systemPromptVariant, `${mode}_vision`);
      assert.equal(request.messages, undefined);
      const mismatch = buildPromptTraceProvenance(messages, [], mode === 'act' ? 'dev' : 'act');
      assert.equal(mismatch.runtimeEnvelopeMatches, false);
      assert.equal(mismatch.systemPromptMatchesRuntime, false);
    }
  });

  test(`${build}: feedback JSON and Markdown preserve visual diagnostics without restoring private code fields`, async () => {
    const events = [
      { kind: 'note', data: { step: 3, note: 'vision_frame', extra: frame } },
      { kind: 'note', data: { step: 3, note: 'vision_capture_failure', extra: failure } },
      { kind: 'error', data: { step: 3, phase: 'vision_after_action_capture', code: 'VISION_CAPTURE_FAILED', message: PRIVATE } },
      { kind: 'turn_end', data: { step: 3, phase: 'vision_after_action_capture', code: 'VISION_CAPTURE_FAILED', status: 'error', durationMs: 500 } },
      { kind: 'tool', data: { step: 3, name: 'vision_type', args: { code: 'VISION_CAPTURE_FAILED', password: PRIVATE }, result: { success: true, code: 'VISION_INPUT_FAILED', content: PRIVATE } } },
    ].map((event, index) => ({ ...event, seq: index + 1, ts: 100 + index, runId: 'visual-test' }));
    const payload = { runs: [{ run: { runId: 'visual-test', conversationId: 'visual-session', startedAt: 1,
      endedAt: 200, status: 'error', mode: 'act', feedbackOnly: true, userMessage: PRIVATE, tabUrl: `https://${PRIVATE}.test/` }, events }] };
    const diagnostic = diagnosticFeedbackPayload(payload);
    const sanitized = sanitizeTraceExport(diagnostic, { allRuns: true });
    const json = JSON.stringify(sanitized);
    assert.doesNotMatch(json, /PRIVATE|data:image|https:/);
    assert.deepEqual(sanitized.runs[0].events[0].data.extra, safeFrame);
    assert.deepEqual(sanitized.runs[0].events[1].data.extra, safeFailure);
    for (const index of [2, 3]) assert.equal(sanitized.runs[0].events[index].data.code, 'VISION_CAPTURE_FAILED');
    const credentialExport = sanitizeTraceExport(payload, { allRuns: true }).runs[0].events[4].data;
    assert.equal(credentialExport.args.code, '[redacted]');
    assert.equal(credentialExport.result.code, '[redacted]');
    const { markdown } = tracesToMarkdown(sanitized.runs);
    assert.match(markdown, /Vision frame: delta.*1280×720.*9800 bytes.*170 image tokens.*DPR 2/);
    assert.match(markdown, /Vision capture failed: vision_after_action_capture.*VISION_STALE_FRAME.*page_changed.*attempt 2/);
    assert.match(markdown, /Vision capture failed:.*chrome.*viewport_evaluate.*context_changed/);
    assert.match(markdown, /error \(vision_after_action_capture\): VISION_CAPTURE_FAILED/);
    assert.doesNotMatch(markdown, /PRIVATE|data:image|https:/);
    const trace = await prepareFeedbackTrace({ listRuns: async () => diagnostic.runs.map(entry => entry.run),
      getRunEvents: async () => diagnostic.runs[0].events,
      getScreenshot: async () => { throw new Error('Vision metadata must never read stored screenshot bytes'); },
    }, 'visual-session', 'test');
    assert.equal(trace.traceType, 'diagnostic');
    assert.equal(trace.screenshotCount, 0);
    assert.deepEqual(JSON.parse(await trace.blob.text()).runs[0].events[0].data.extra, safeFrame);
  });

  test(`${build}: real IndexedDB feedback recording retains visual failure evidence and metrics without private data`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const prefix = `https://vision-trace-fixture.test/${build}/`;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'vision-trace-fixture.test' || !url.pathname.startsWith(`/${build}/`)) return route.abort();
        const relative = url.pathname.slice(build.length + 2);
        if (!relative) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Trace fixture</title>' });
        const file = resolve(`src/${build}`, relative);
        if (!file.startsWith(resolve(`src/${build}`) + sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      await page.goto(prefix);
      const outcome = await page.evaluate(async ({ frame, failure, PRIVATE, prefix }) => {
        const settings = { tracingEnabled: false, losslessTrace: true, feedbackDiagnosticsEnabled: true };
        globalThis.chrome = globalThis.browser = {
          storage: { local: { get: async () => settings, set: async value => Object.assign(settings, value) } },
          runtime: { id: 'vision-trace-fixture', getURL: file => prefix + file, getManifest: () => ({ version: 'test' }) },
        };
        const trace = await import('./src/trace/recorder.js');
        const { prepareFeedbackTrace } = await import('./src/trace/feedback-export.js');
        const runId = await trace.startRun({ runId: 'visual-run', conversationId: 'visual-session', mode: 'dev', model: 'owned-model',
          userMessage: PRIVATE, tabUrl: `https://${PRIVATE}.test/`, tabTitle: PRIVATE });
        if (!runId) throw new Error('Feedback recording did not start');
        await trace.recordTurnStart(runId, 0, { status: 'running' });
        await trace.recordNote(runId, 0, 'vision_frame', frame);
        await trace.recordLLMRequest(runId, 1, { model: 'owned-model', runtimeMode: 'dev', imageBlockCount: 1, toolsCount: 11,
          messageCount: 2, phase: 'vision_model' }, { runtimeMode: 'dev', tools: [], messages: [
          { role: 'system', content: `You are WebBrain in visual Dev mode.\n${PRIVATE}` },
          { role: 'user', content: [{ type: 'text', text: 'Authoritative execution state: runtime_mode=dev; mutation_tools_enabled=true.' },
            { type: 'image_url', image_url: { url: frame.images[0].dataUrl } }] },
        ] });
        await trace.recordLLMResponse(runId, 1, { model: 'owned-model', latencyMs: 421, content: PRIVATE,
          phase: 'vision_model', toolCallCount: 1, usage: { prompt_tokens: 300, completion_tokens: 20 } });
        await trace.recordNote(runId, 1, 'vision_capture_failure', failure);
        await trace.recordError(runId, 1, failure.phase, PRIVATE, 'VISION_CAPTURE_FAILED');
        await trace.recordTurnEnd(runId, 1, { phase: failure.phase, status: 'error', ok: false, code: 'VISION_CAPTURE_FAILED', durationMs: 700 });
        await trace.endRun(runId, { status: 'error', finalContent: PRIVATE });
        const run = await trace.getRun(runId), events = await trace.getRunEvents(runId);
        const attachment = await prepareFeedbackTrace(trace, 'visual-session', 'test');
        return { run, events, json: await attachment.blob.text(), traceType: attachment.traceType, screenshotCount: attachment.screenshotCount };
      }, { frame, failure, PRIVATE, prefix });
      assert.equal(outcome.run.feedbackOnly, true);
      assert.notEqual(outcome.run.lossless, true, 'stale lossless setting must not expose automated feedback');
      assert.equal(outcome.run.status, 'error');
      assert.equal(outcome.run.errorCount, 1);
      assert.equal(outcome.run.llmRequestCount, 1);
      assert.equal(outcome.run.llmResponseCount, 1);
      assert.equal(outcome.run.totalLlmLatencyMs, 421);
      assert.equal(outcome.run.totalInputTokens, 300);
      assert.equal(outcome.run.totalOutputTokens, 20);
      assert.equal(outcome.traceType, 'diagnostic');
      assert.equal(outcome.screenshotCount, 0);
      assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE|data:image|https:/);
      assert.deepEqual(outcome.events.find(event => event.data?.note === 'vision_frame').data.extra, safeFrame);
      const exported = JSON.parse(outcome.json).runs[0].events;
      assert.deepEqual(exported.find(event => event.data?.note === 'vision_frame').data.extra, safeFrame);
      assert.deepEqual(exported.find(event => event.data?.note === 'vision_capture_failure').data.extra, safeFailure);
      assert.equal(exported.find(event => event.kind === 'error').data.code, 'VISION_CAPTURE_FAILED');
      assert.equal(exported.find(event => event.kind === 'turn_end').data.phase, failure.phase);
      const provenance = exported.find(event => event.kind === 'llm_request').data.promptProvenance;
      assert.equal(provenance.systemPromptVariant, 'dev_vision');
      assert.equal(provenance.runtimeEnvelopeMatches, true);
      assert.equal(provenance.systemPromptMatchesRuntime, true);
    } finally { await browser.close(); }
  });

  test(`${build}: visual runner records terminal capture failures before and after navigation in real feedback traces`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const prefix = `https://vision-runner-trace.test/${build}/`;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'vision-runner-trace.test' || !url.pathname.startsWith(`/${build}/`)) return route.abort();
        const relative = url.pathname.slice(build.length + 2);
        if (!relative) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Runner trace fixture</title>' });
        const file = resolve(`src/${build}`, relative);
        if (!file.startsWith(resolve(`src/${build}`) + sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      await page.goto(prefix);
      const outcomes = await page.evaluate(async ({ prefix, PRIVATE, build }) => {
        const settings = { tracingEnabled: false, feedbackDiagnosticsEnabled: true };
        let navigations = 0;
        globalThis.chrome = globalThis.browser = {
          storage: { local: { get: async () => settings, set: async value => Object.assign(settings, value) },
            session: { get: async () => ({}), set: async () => {} } },
          runtime: { id: 'vision-runner-trace', getURL: file => prefix + file, getManifest: () => ({ version: 'test' }) },
          tabs: { update: async () => { navigations++; } },
        };
        const trace = await import('./src/trace/recorder.js');
        const { prepareFeedbackTrace } = await import('./src/trace/feedback-export.js');
        const { runVisionAct } = await import('./src/agent/vision-act.js');
        const screenshot = document.createElement('canvas'); screenshot.width = 640; screenshot.height = 400;
        const ctx = screenshot.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 400);
        const viewport = { width: 320, height: 200, devicePixelRatio: 2, scale: 1, zoom: 1,
          url: `https://${PRIVATE}.test/`, documentId: PRIVATE };
        const outcomes = [];
        for (const scenario of ['initial', 'after-navigation']) {
          navigations = 0;
          let captures = 0, modelCalls = 0, runId;
          const history = [{ role: 'system', content: 'Old prompt' }], controller = new AbortController();
          const provider = { name: 'owned model', model: 'owned-vision', supportsVision: true, supportsTools: true };
          const sessionId = `visual-runner-${scenario}`;
          const agent = {
            maxSteps: 5, currentCostState: new Map(), providerManager: { prepareActiveProviderCapabilities: async () => {} },
            permissions: { beginTurn() {} }, _skipPermissionGate: true,
            _runAbortSignal: () => controller.signal, _throwIfAborted: signal => signal?.throwIfAborted(),
            _checkAbort: () => controller.signal.aborted, _activeProvider: () => provider,
            getConversation: () => history, _newCostRunState: () => ({}),
            _persistSubmittedTurn: async () => {}, _persistNow: async () => ({ ok: true }),
            _startTraceRun: async (_tabId, userMessage, mode) => {
              runId = await trace.startRun({ runId: sessionId, conversationId: sessionId, mode, model: provider.model, userMessage, force: true });
              await trace.recordTurnStart(runId, 0, { status: 'running' });
              return runId;
            },
            _endTraceRun: async (_tabId, id, status, finalContent) => trace.endRun(id, { status, finalContent }),
            _ensureGateSetting: async () => {}, _hasPendingSteering: () => false, _applyPendingSteering: () => false,
            _withResponseItems: message => message,
            _createVisionBrowser: () => ({
              capture: async () => {
                captures++;
                if (scenario === 'initial' || navigations) throw Object.assign(new Error(PRIVATE), {
                  code: 'vision_capture_failed', captureDiagnostics: { browser: build,
                    stage: scenario === 'initial' ? build === 'chrome' ? 'debugger_attach' : 'companion_bind' : 'screenshot',
                    reason: 'permission_denied', url: `https://${PRIVATE}.test/`, message: PRIVATE },
                });
                return { dataUrl: screenshot.toDataURL('image/png'), viewport };
              },
              perform: () => { throw new Error('Navigation must not dispatch a pointer action'); },
            }),
            _chatWithCostAllowance: async () => {
              modelCalls++;
              await new Promise(resolve => setTimeout(resolve, 2));
              return { content: PRIVATE, usage: { prompt_tokens: 300, completion_tokens: 20 }, toolCalls: [{
                id: 'navigate-once', type: 'function', function: { name: 'vision_navigate', arguments: JSON.stringify({ url: `https://${PRIVATE}.test/next` }) },
              }] };
            },
          };
          await runVisionAct(agent, { tabId: 71, userMessage: PRIVATE });
          const attachment = await prepareFeedbackTrace(trace, sessionId, 'test');
          outcomes.push({ scenario, captures, modelCalls, navigations, run: await trace.getRun(runId),
            events: await trace.getRunEvents(runId), json: await attachment.blob.text() });
        }
        return outcomes;
      }, { prefix, PRIVATE, build });
      for (const outcome of outcomes) {
        const initial = outcome.scenario === 'initial', phase = initial ? 'vision_initial_capture' : 'vision_after_action_capture';
        assert.equal(outcome.captures, initial ? 1 : 2, 'Permanent capture failure cannot trigger a capture retry');
        assert.equal(outcome.modelCalls, initial ? 0 : 1);
        assert.equal(outcome.navigations, initial ? 0 : 1, 'A capture failure must never replay navigation');
        assert.equal(outcome.run.status, 'error');
        assert.equal(outcome.run.errorCount, 1);
        assert.equal(outcome.run.toolCallCount, initial ? 0 : 1);
        assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE|data:image|https:/);
        const exported = JSON.parse(outcome.json).runs[0].events;
        const failure = exported.find(event => event.data?.note === 'vision_capture_failure');
        assert.equal(failure.data.extra.phase, phase);
        assert.equal(failure.data.extra.code, 'VISION_CAPTURE_FAILED');
        assert.equal(failure.data.extra.attempt, 1);
        assert.deepEqual(failure.data.extra.captureDiagnostics, { browser: build,
          stage: initial ? build === 'chrome' ? 'debugger_attach' : 'companion_bind' : 'screenshot', reason: 'permission_denied' });
        const errors = exported.filter(event => event.kind === 'error');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].data.phase, phase);
        assert.equal(errors[0].data.code, 'VISION_CAPTURE_FAILED');
        const ends = exported.filter(event => event.kind === 'turn_end');
        assert.equal(ends.length, 1);
        assert.equal(ends[0].data.phase, phase);
        assert.equal(ends[0].data.code, 'VISION_CAPTURE_FAILED');
        assert.equal(ends[0].data.status, 'error');
        assert.ok(ends[0].seq > errors[0].seq);
        if (!initial) {
          const request = exported.find(event => event.kind === 'llm_request').data;
          assert.equal(request.promptProvenance.systemPromptVariant, 'act_vision');
          assert.equal(request.promptProvenance.runtimeEnvelopeMatches, true);
          const response = exported.find(event => event.kind === 'llm_response').data;
          assert.equal(response.model, 'owned-vision'); assert.equal(response.toolCallCount, 1);
          assert.ok(response.latencyMs > 0);
          const captured = exported.find(event => event.data?.note === 'vision_frame').data.extra;
          assert.equal(captured.kind, 'full'); assert.equal(captured.viewport.devicePixelRatio, 2);
          assert.equal(captured.source.width, 640); assert.equal(captured.source.height, 400);
          assert.ok(captured.bytes > 0); assert.ok(captured.estimatedTokens > 0);
          const tool = exported.find(event => event.kind === 'tool');
          assert.equal(tool.data.name, 'vision_navigate'); assert.equal(tool.data.resultStatus, 'success');
          assert.ok(tool.seq < errors[0].seq);
          assert.equal(exported.filter(event => event.kind === 'step_end').length, 1);
        }
      }
    } finally { await browser.close(); }
  });

  test(`${build}: actual visual browser gates privacy work dynamically and sends only protected frames after enabling`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const prefix = `https://vision-privacy-runner.test/${build}/`;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'vision-privacy-runner.test' || !url.pathname.startsWith(`/${build}/`)) return route.abort();
        const relative = url.pathname.slice(build.length + 2);
        if (!relative) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Privacy runner fixture</title>' });
        const file = resolve(`src/${build}`, relative);
        if (!file.startsWith(resolve(`src/${build}`) + sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      await page.goto(prefix);
      const outcomes = await page.evaluate(async ({ prefix, PRIVATE }) => {
        const settings = { tracingEnabled: false, feedbackDiagnosticsEnabled: true };
        globalThis.chrome = globalThis.browser = {
          storage: { local: { get: async () => settings, set: async value => Object.assign(settings, value) },
            session: { get: async () => ({}), set: async () => {} } },
          runtime: { id: 'vision-privacy-fixture', getURL: file => prefix + file, getManifest: () => ({ version: 'test' }) },
          tabs: { update: async () => {} },
        };
        const trace = await import('./src/trace/recorder.js');
        const { prepareFeedbackTrace } = await import('./src/trace/feedback-export.js');
        const { runVisionAct } = await import('./src/agent/vision-act.js');
        const { VisionBrowser } = await import('./src/agent/vision-browser.js');
        const screenshot = document.createElement('canvas'); screenshot.width = 640; screenshot.height = 400;
        const context = screenshot.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 640, 400);
        context.fillStyle = 'rgb(230,35,35)'; context.fillRect(40, 40, 40, 40); context.fillRect(140, 40, 40, 40);
        const raw = screenshot.toDataURL('image/png');
        const regions = [{ rect: { x: 20, y: 20, w: 20, h: 20 } }, { rect: { x: 70, y: 20, w: 20, h: 20 } }];
        const viewport = { width: 320, height: 200, devicePixelRatio: 2, scale: 1, zoom: 1,
          scrollX: 0, scrollY: 0, url: `https://${PRIVATE}.test/`, documentId: PRIVATE };
        const outcomes = [];
        for (const scenario of ['disabled', 'enabled-stale', 'enabled-navigation', 'enable-during-native', 'disable-during-native', 'disable-during-prescan', 'enable-after-observation', 'enable-before-model']) {
          let runId, captures = 0, modelCalls = 0, activeCapture = null, firstSamples, modelsAfterAttempts, enabledAfterObservation = false;
          const captureAttempts = [], frames = [], history = [{ role: 'system', content: 'Previous prompt' }];
          const controller = new AbortController(), provider = { name: 'owned model', model: 'owned-vision', supportsVision: true, supportsTools: true };
          const sessionId = `privacy-${scenario}`;
          const transport = {
            readViewport: async () => {
              if (activeCapture) {
                activeCapture.reads++;
                if (agent.screenshotRedaction && !activeCapture.nativeStarted && activeCapture.scans === 0)
                  activeCapture.preflights++;
                if (activeCapture.nativeStarted && activeCapture.scans === 2) {
                  activeCapture.postPrivacyChecks++;
                  // Fail the final native fence after BOTH local privacy scans,
                  // independent of the extra startup geometry preflight.
                  if (scenario === 'enabled-stale' && captureAttempts.length === 0)
                    return { ...viewport, scrollY: 1 };
                }
              }
              return { ...viewport };
            },
            capture: async () => {
              captures++;
              activeCapture.nativeStarted = true;
              if (captures === 1 && scenario === 'enable-during-native') agent.screenshotRedaction = true;
              if (captures === 1 && scenario === 'disable-during-native') agent.screenshotRedaction = false;
              return raw;
            },
            sendInput: () => { throw new Error('Visual completion must not dispatch input'); },
          };
          const agent = {
            screenshotRedaction: ['enabled-stale', 'enabled-navigation', 'disable-during-native', 'disable-during-prescan'].includes(scenario),
            maxSteps: 5, currentCostState: new Map(), providerManager: { prepareActiveProviderCapabilities: async () => {} },
            permissions: { beginTurn() {} }, _skipPermissionGate: true,
            _runAbortSignal: () => controller.signal, _throwIfAborted: signal => signal?.throwIfAborted(),
            _checkAbort: () => controller.signal.aborted, _activeProvider: () => provider,
            getConversation: () => history, _newCostRunState: () => ({}),
            _persistSubmittedTurn: async () => {}, _persistNow: async () => ({ ok: true }),
            _startTraceRun: async (_tabId, userMessage, mode) => {
              runId = await trace.startRun({ runId: sessionId, conversationId: sessionId, mode, model: provider.model, userMessage, force: true });
              await trace.recordTurnStart(runId, 0, { status: 'running' }); return runId;
            },
            _endTraceRun: async (_tabId, id, status, finalContent) => trace.endRun(id, { status, finalContent }),
            _ensureGateSetting: async () => {}, _hasPendingSteering: () => false, _applyPendingSteering: () => false,
            _withResponseItems: message => message,
            _createVisionBrowser: options => new VisionBrowser({ ...options, transport }),
            _withIndicatorsHidden: async (_tabId, action) => {
              const attempt = { reads: 0, scans: 0, preflights: 0, postPrivacyChecks: 0, nativeStarted: false, error: null }; activeCapture = attempt;
              try { return await action(); }
              catch (error) { attempt.error = error.code || error.name; throw error; }
              finally { captureAttempts.push(attempt); activeCapture = null; }
            },
            captureScreenshotRedactionSnapshotForUser: async () => {
              activeCapture.scans++;
              if (scenario === 'disable-during-prescan' && captureAttempts.length === 0 && activeCapture.scans === 1)
                agent.screenshotRedaction = false;
              // During the first protected capture the field moves: both the
              // old pixels and its new position must be masked, even if the
              // user disables protection while native capture is pending.
              const sensitive = captureAttempts.length === 0
                ? [regions[activeCapture.scans === 1 ? 0 : 1]] : regions;
              return { ok: true, snapshot: { coordinateSpace: 'page', regions: sensitive } };
            },
            _chatWithCostAllowance: async (_provider, messages) => {
              modelCalls++;
              const observation = messages.at(-1).content;
              if (modelCalls === 1) {
                modelsAfterAttempts = captureAttempts.length;
                const image = observation.find(block => block.type === 'image_url').image_url.url;
                const bitmap = await createImageBitmap(await (await fetch(image)).blob());
                const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
                const pixel = (x, y) => [...ctx.getImageData(Math.floor(x * canvas.width / viewport.width), Math.floor(y * canvas.height / viewport.height), 1, 1).data].slice(0, 3);
                firstSamples = { old: pixel(30, 30), moved: pixel(80, 30), background: pixel(200, 100),
                  imageCount: observation.filter(block => block.type === 'image_url').length };
              }
              if (scenario === 'enabled-navigation' && modelCalls === 1) return { toolCalls: [{ id: 'navigate-once', type: 'function',
                function: { name: 'vision_navigate', arguments: JSON.stringify({ url: viewport.url }) } }] };
              const latest = observation.filter(block => block.type === 'text').flatMap(block => {
                try { const packet = JSON.parse(block.text); return packet.frameId ? [packet] : []; } catch { return []; }
              }).at(-1);
              return { toolCalls: [{ id: `done-${modelCalls}`, type: 'function', function: { name: 'done', arguments: JSON.stringify({
                frameId: latest.frameId, summary: 'Protected observation verified.', outcome: 'success',
              }) } }] };
            },
          };
          await runVisionAct(agent, { tabId: 71, userMessage: PRIVATE, onUpdate: (type, data) => {
            if (type === 'thinking' && scenario === 'enable-before-model' && !enabledAfterObservation) {
              agent.screenshotRedaction = true; enabledAfterObservation = true;
            }
            if (type !== 'vision_frame') return;
            frames.push({ kind: data.kind, reason: data.reason });
            if (scenario === 'enable-after-observation' && !enabledAfterObservation) {
              agent.screenshotRedaction = true; enabledAfterObservation = true;
            }
          } });
          const attachment = await prepareFeedbackTrace(trace, sessionId, 'test');
          outcomes.push({ scenario, captureAttempts, captures, modelCalls, modelsAfterAttempts, firstSamples, frames,
            run: await trace.getRun(runId), json: await attachment.blob.text() });
        }
        return outcomes;
      }, { prefix, PRIVATE });
      const expected = {
        disabled: { reads: [2, 2], scans: [0, 0], preflights: [0, 0], postPrivacyChecks: [0, 0], models: 1, beforeModel: 1, masked: false },
        'enabled-stale': { reads: [4, 4, 3], scans: [2, 2, 2], preflights: [1, 1, 0], postPrivacyChecks: [1, 1, 1], models: 1, beforeModel: 2, masked: true, retry: true },
        'enabled-navigation': { reads: [4, 3, 3], scans: [2, 2, 2], preflights: [1, 0, 0], postPrivacyChecks: [1, 1, 1], models: 2, beforeModel: 1, masked: true },
        'enable-during-native': { reads: [2, 4, 3], scans: [0, 2, 2], preflights: [0, 1, 0], postPrivacyChecks: [0, 1, 1], models: 1, beforeModel: 2, masked: true, retry: true },
        'disable-during-native': { reads: [4, 2, 2], scans: [2, 0, 0], preflights: [1, 0, 0], postPrivacyChecks: [1, 0, 0], models: 2, beforeModel: 1, masked: true },
        'disable-during-prescan': { reads: [4, 2, 2], scans: [2, 0, 0], preflights: [1, 0, 0], postPrivacyChecks: [1, 0, 0], models: 2, beforeModel: 1, masked: true },
        'enable-after-observation': { reads: [2, 3, 3], scans: [0, 2, 2], preflights: [0, 0, 0], postPrivacyChecks: [0, 1, 1], models: 1, beforeModel: 2, masked: true },
        'enable-before-model': { reads: [2, 3, 3], scans: [0, 2, 2], preflights: [0, 0, 0], postPrivacyChecks: [0, 1, 1], models: 1, beforeModel: 2, masked: true },
      };
      const near = (actual, desired) => actual.every((value, index) => Math.abs(value - desired[index]) < 15);
      for (const outcome of outcomes) {
        const rules = expected[outcome.scenario];
        assert.equal(outcome.run.status, 'done', outcome.scenario);
        assert.equal(outcome.run.errorCount, 0, outcome.scenario);
        assert.equal(outcome.modelCalls, rules.models, outcome.scenario);
        assert.equal(outcome.modelsAfterAttempts, rules.beforeModel, `${outcome.scenario}: model waits for safe capture`);
        assert.deepEqual(outcome.captureAttempts.map(attempt => attempt.reads), rules.reads, outcome.scenario);
        assert.deepEqual(outcome.captureAttempts.map(attempt => attempt.scans), rules.scans, outcome.scenario);
        assert.deepEqual(outcome.captureAttempts.map(attempt => attempt.preflights), rules.preflights, `${outcome.scenario}: extra geometry is startup-only`);
        assert.deepEqual(outcome.captureAttempts.map(attempt => attempt.postPrivacyChecks), rules.postPrivacyChecks, `${outcome.scenario}: final privacy fence remains enforced`);
        assert.equal(outcome.firstSamples.imageCount, 1, `${outcome.scenario}: protected full frame replaces earlier unprotected context`);
        const expectedColor = rules.masked ? [32, 33, 36] : [230, 35, 35];
        assert.ok(near(outcome.firstSamples.old, expectedColor), `${outcome.scenario}: old sensitive region ${outcome.firstSamples.old}`);
        assert.ok(near(outcome.firstSamples.moved, expectedColor), `${outcome.scenario}: moved sensitive region ${outcome.firstSamples.moved}`);
        assert.ok(near(outcome.firstSamples.background, [255, 255, 255]), `${outcome.scenario}: unrelated pixels unchanged`);
        assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE|data:image|https:/);
        const events = JSON.parse(outcome.json).runs[0].events;
        const failures = events.filter(event => event.data?.note === 'vision_capture_failure');
        assert.equal(failures.length, rules.retry ? 1 : 0, outcome.scenario);
        if (rules.retry) {
          assert.equal(failures[0].data.extra.code, 'VISION_STALE_FRAME');
          assert.equal(failures[0].data.extra.phase, 'vision_initial_capture');
          assert.equal(outcome.captureAttempts[0].error, 'vision_stale_frame');
        }
        if (['enable-after-observation', 'enable-before-model'].includes(outcome.scenario)) {
          const recapture = events.find(event => event.data?.note === 'vision_frame' && event.data.extra.reason === 'privacy-setting-change');
          assert.equal(recapture?.data.extra.kind, 'full', 'Privacy enabling replaces the entire retained context');
          const request = events.find(event => event.kind === 'llm_request');
          if (outcome.scenario === 'enable-after-observation')
            assert.ok(recapture.seq < request.seq, 'Unsafe observation is replaced before model invocation');
        }
      }
    } finally { await browser.close(); }
  });
}
