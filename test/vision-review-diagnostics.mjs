import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium, firefox } from 'playwright';

const PRIVATE = 'PRIVATE-REVIEW-CONTENT';
const frameId = 'vf-mvnacgje-2-2';
const flags = ['verified', 'allowed', 'recipientMatches', 'composerMatches', 'atLatest',
  'delivered', 'newOutgoing', 'composerEmpty', 'completionVerified', 'requiresChatProtocol',
  'draftProtected', 'navigationOnly', 'authorMatches', 'audienceMatches'];
const kinds = ['native_action', 'chat_authorization', 'chat_observe', 'chat_focus', 'chat_draft',
  'chat_delivery', 'upload_target', 'verify_form', 'extract_data', 'find_text',
  'dev_authorization', 'dev_patch', 'captcha_target', 'captcha_application'];
const categories = ['accepted', 'authorization_denied', 'evidence_unverified', 'chat_protocol_required',
  'draft_protected', 'invalid_verdict', 'context_changed'];
const safeReview = { kind: 'chat_observe', category: 'evidence_unverified', frameId, durationMs: 421,
  ...Object.fromEntries(flags.map(flag => [flag, ['composerMatches', 'atLatest'].includes(flag)])),
  missingEvidence: ['recipient', 'latest_context'] };
const review = { ...safeReview, reason: PRIVATE, task: PRIVATE, target: PRIVATE, text: PRIVATE,
  recipient: PRIVATE, author: PRIVATE, audience: PRIVATE, url: `https://${PRIVATE}.test/`, provenance: PRIVATE,
  image: { dataUrl: `data:image/png;base64,${PRIVATE}` },
  claims: { recipientMatches: PRIVATE }, extraFlag: true };
const payloadFor = extra => ({ runs: [{ run: { runId: 'review-run', conversationId: 'review-session',
  mode: 'act', status: 'blocked', startedAt: 1, endedAt: 3, feedbackOnly: true }, events: [
  { runId: 'review-run', seq: 1, ts: 2, kind: 'note', data: { step: 4, note: 'vision_evidence_review', extra } },
] }] });

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);
  const { diagnosticFeedbackPayload, prepareFeedbackTrace } = await import(`../src/${build}/src/trace/feedback-export.js`);
  const { sanitizeTraceExport, tracesToMarkdown } = await import(`../src/${build}/src/agent/trace-export.js`);

  test(`${build}: independent review projection keeps only closed labels and exact boolean flags`, () => {
    for (const includeContent of [false, true]) {
      const result = projectTraceEventData('note', { step: 4, note: 'vision_evidence_review', extra: review }, { includeContent });
      assert.deepEqual(result, { step: 4, note: 'vision_evidence_review', extra: safeReview });
      assert.deepEqual(projectTraceEventData('note', result, { includeContent }), result);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|https:|data:image|reason|claims|provenance|extraFlag/);
      for (const kind of kinds) assert.equal(projectTraceEventData('note', {
        note: 'vision_evidence_review', extra: { kind },
      }, { includeContent }).extra.kind, kind);
      for (const category of categories) assert.equal(projectTraceEventData('note', {
        note: 'vision_evidence_review', extra: { category },
      }, { includeContent }).extra.category, category);
    }
    assert.equal(review.reason, PRIVATE, 'Projection must not mutate the runtime verdict');
    assert.deepEqual(projectTraceEventData('note', { note: 'vision_frame', extra: { frameId, reason: 'evidence-recovery' } }),
      { step: 0, note: 'vision_frame', extra: { frameId, reason: 'evidence-recovery' } });
    assert.deepEqual(projectTraceEventData('note', { note: 'ordinary_note', extra: safeReview }),
      { note: 'ordinary_note', extra: { durationMs: 421 } }, 'Only existing generic duration metadata survives on other notes');
  });

  test(`${build}: malformed review labels, IDs, nested flags and nonfinite duration cannot carry content`, () => {
    for (const includeContent of [false, true]) {
      for (const extra of [null, PRIVATE, [review], {
        kind: `${PRIVATE}:native_action`, category: `accepted ${PRIVATE}`, frameId: `vf-${PRIVATE}-1-1`,
        durationMs: Infinity, ...Object.fromEntries(flags.map(flag => [flag, { value: true, text: PRIVATE }])),
      }, { kind: ['chat_observe'], category: { toString: () => 'accepted' }, frameId: frameId + '\n' + PRIVATE,
        durationMs: '400', ...Object.fromEntries(flags.map(flag => [flag, 1])) },
      { durationMs: -1, ...Object.fromEntries(flags.map(flag => [flag, 'false'])) }]) {
        assert.deepEqual(projectTraceEventData('note', { step: NaN, note: 'vision_evidence_review', extra }, { includeContent }),
          { step: 0, note: 'vision_evidence_review', extra: {} });
      }
      assert.deepEqual(projectTraceEventData('note', { note: 'vision_evidence_review', extra: { durationMs: 1e9, allowed: false } },
        { includeContent }).extra, { durationMs: 600000, allowed: false });
    }
  });

  test(`${build}: missing-evidence metadata is bounded, deduplicated and rejects content-bearing lists`, () => {
    const labels = ['target', 'recipient', 'composer', 'send_control', 'latest_context', 'author',
      'audience', 'delivery', 'authorization', 'readable_pixels'];
    for (const includeContent of [false, true]) {
      const project = missingEvidence => projectTraceEventData('note', { note: 'vision_evidence_review',
        extra: { missingEvidence } }, { includeContent }).extra;
      assert.deepEqual(project(labels), { missingEvidence: labels });
      assert.deepEqual(project(['author', 'audience', 'author']), { missingEvidence: ['author', 'audience'] });
      assert.deepEqual(project([]), { missingEvidence: [] });
      for (const invalid of [PRIVATE, {}, ['author', PRIVATE], Array(1), Array(11).fill('recipient'),
        [['recipient']], [1], [null], [true], [{ toString: () => 'recipient' }]]) assert.deepEqual(project(invalid), {});
    }
  });

  test(`${build}: diagnostic feedback and Markdown retain review refusals without restoring private content`, async () => {
    const payload = diagnosticFeedbackPayload(payloadFor(review));
    const sanitized = sanitizeTraceExport(payload, { allRuns: true });
    assert.deepEqual(sanitized.runs[0].events[0].data.extra, safeReview);
    assert.doesNotMatch(JSON.stringify(sanitized), /PRIVATE|https:|data:image/);
    const { markdown } = tracesToMarkdown(payloadFor(review).runs);
    assert.match(markdown, /Vision review: chat_observe.*evidence_unverified.*vf-mvnacgje-2-2.*421 ms/);
    assert.match(markdown, /verified=false.*allowed=false.*recipientMatches=false.*composerMatches=true/);
    assert.match(markdown, /missing=recipient,latest_context/);
    assert.doesNotMatch(markdown, /PRIVATE|https:|data:image/);
    const attachment = await prepareFeedbackTrace({
      listRuns: async () => sanitized.runs.map(entry => entry.run),
      getRunEvents: async () => sanitized.runs[0].events,
      getScreenshot: async () => assert.fail('Review diagnostics must not load screenshot content'),
    }, 'review-session', 'test');
    assert.equal(attachment.screenshotCount, 0);
    assert.deepEqual(JSON.parse(await attachment.blob.text()).runs[0].events[0].data.extra, safeReview);
  });

  test(`${build}: real IndexedDB recorder preserves repeated same-frame review outcomes in feedback and content tracing`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const prefix = `https://review-trace-fixture.test/${build}/`;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'review-trace-fixture.test' || !url.pathname.startsWith(`/${build}/`)) return route.abort();
        const relative = url.pathname.slice(build.length + 2);
        if (!relative) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Review trace fixture</title>' });
        const file = resolve(`src/${build}`, relative);
        if (!file.startsWith(resolve(`src/${build}`) + sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      await page.goto(prefix);
      const outcomes = await page.evaluate(async ({ prefix, review }) => {
        const settings = { tracingEnabled: false, losslessTrace: true, feedbackDiagnosticsEnabled: true };
        globalThis.chrome = globalThis.browser = {
          storage: { local: { get: async () => settings, set: async value => Object.assign(settings, value) } },
          runtime: { id: 'review-trace-fixture', getURL: file => prefix + file, getManifest: () => ({ version: 'test' }) },
        };
        const trace = await import('./src/trace/recorder.js');
        const { prepareFeedbackTrace, diagnosticFeedbackPayload } = await import('./src/trace/feedback-export.js');
        const { tracesToMarkdown } = await import('./src/agent/trace-export.js');
        const outcomes = [];
        for (const lossless of [false, true]) {
          settings.tracingEnabled = lossless;
          const runId = await trace.startRun({ runId: `review-run-${lossless}`, conversationId: `review-session-${lossless}`,
            mode: 'act', model: 'fixture-model' });
          if (!runId) throw new Error('Trace recording did not start');
          await trace.recordNote(runId, 2, 'vision_evidence_review', review);
          await trace.recordNote(runId, 3, 'vision_evidence_review', { ...review, kind: 'native_action',
            category: 'chat_protocol_required', requiresChatProtocol: true });
          await trace.recordNote(runId, 4, 'vision_evidence_review', { ...review, kind: 'chat_draft',
            category: 'accepted', verified: true, allowed: true, recipientMatches: true });
          await trace.endRun(runId, { status: 'blocked' });
          const run = await trace.getRun(runId), events = await trace.getRunEvents(runId);
          const attachment = await prepareFeedbackTrace(trace, `review-session-${lossless}`, 'test');
          const exported = JSON.parse(await attachment.blob.text());
          outcomes.push({ lossless, run, events, exported, fallback: diagnosticFeedbackPayload(exported),
            markdown: tracesToMarkdown(exported.runs).markdown, screenshotCount: attachment.screenshotCount });
        }
        return outcomes;
      }, { prefix, review });
      for (const outcome of outcomes) {
        assert.equal(outcome.run.lossless === true, outcome.lossless);
        assert.equal(outcome.run.feedbackOnly === true, !outcome.lossless);
        assert.equal(outcome.screenshotCount, 0);
        const expected = [safeReview, { ...safeReview, kind: 'native_action', category: 'chat_protocol_required', requiresChatProtocol: true },
          { ...safeReview, kind: 'chat_draft', category: 'accepted', verified: true, allowed: true, recipientMatches: true }];
        for (const events of [outcome.events, outcome.exported.runs[0].events, outcome.fallback.runs[0].events]) {
          const notes = events.filter(event => event.kind === 'note' && event.data.note === 'vision_evidence_review');
          assert.deepEqual(notes.map(event => event.data.extra), expected);
          assert.deepEqual(notes.map(event => event.data.step), [2, 3, 4]);
        }
        assert.match(outcome.markdown, /Vision review: native_action.*chat_protocol_required/);
        assert.match(outcome.markdown, /Vision review: chat_draft.*accepted/);
        assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE|https:|data:image/);
      }
    } finally { await browser.close(); }
  });
}
