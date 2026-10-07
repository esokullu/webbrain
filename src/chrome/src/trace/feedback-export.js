import { exportRecordedSession } from './session-export.js';
import { sanitizeTraceExport } from '../agent/trace-export.js';
import { projectTraceEventData } from './privacy.js';
import { normalizeRuntimeTraceConfig } from './runtime-config.js';

export const FEEDBACK_ATTACHMENT_LIMIT = 20 * 1024 * 1024;

const DIAGNOSTIC_RUN_FIELDS = [
  'runId', 'conversationId', 'parentRunId', 'parentSessionId', 'delegationDepth',
  'startedAt', 'endedAt', 'durationMs', 'status', 'model', 'providerId', 'providerClass',
  'webbrainVersion', 'traceFormatVersion', 'mode', 'stepCount', 'totalInputTokens',
  'totalOutputTokens', 'totalCost', 'llmRequestCount', 'llmResponseCount', 'toolCallCount',
  'visionSubCallCount', 'errorCount', 'retryCount', 'totalLlmLatencyMs', 'totalToolLatencyMs',
  'feedbackOnly', 'feedbackHistoryOmitted', 'feedbackEventsOmitted',
  'feedbackSnapshotIncomplete',
];

export function diagnosticFeedbackPayload(payload) {
  return {
    ...payload,
    runs: payload.runs.map(({ run, events }) => ({
      // Legacy rows can have unknown content fields. A diagnostic fallback
      // must not copy those fields, including unknown event-envelope fields.
      run: { ...Object.fromEntries(DIAGNOSTIC_RUN_FIELDS.filter(key => run[key] !== undefined).map(key => [key, run[key]])),
        runtimeConfig: normalizeRuntimeTraceConfig(run.runtimeConfig), lossless: false },
      events: events.map(event => ({ runId: event.runId, seq: event.seq, ts: event.ts, kind: event.kind, data: {
        ...projectTraceEventData(event.kind, event.data),
        ...(event.kind === 'tool' && !event.data?.result ? {
          resultStatus: event.data?.resultStatus || 'unknown',
          ...(event.data?.resultErrorCode || event.data?.errorCode ? { resultErrorCode: event.data.resultErrorCode || event.data.errorCode } : {}),
        } : {}),
      } })),
    })),
    feedbackOmissions: [...(payload.feedbackOmissions || []), 'Full trace exceeds the attachment size limit; diagnostic metadata only.'],
  };
}

export async function prepareFeedbackTrace(store, sessionId, version = '', {
  limit = FEEDBACK_ATTACHMENT_LIMIT,
  snapshotAt,
  compress = async blob => typeof CompressionStream === 'function'
    ? new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob() : null,
} = {}) {
  if (!sessionId) return null;
  const exported = await exportRecordedSession(store, sessionId, version, { snapshotAt });
  if (!exported.turnCount) return null;
  let payload = sanitizeTraceExport(JSON.parse(exported.json), { allRuns: true });
  const omissions = [...exported.snapshotOmissions];
  if (exported.recordingTruncated) omissions.push('Some content was omitted at recording time.');
  if (payload.runs.some(entry => entry.run.feedbackHistoryOmitted || entry.run.feedbackEventsOmitted)) {
    omissions.push('Automatic diagnostic history is bounded; older runs or events may be absent.');
  }
  payload.feedbackOmissions = omissions;
  const originalBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  let blob = originalBlob;
  let filename = `webbrain-feedback-${Date.now()}.json`;
  if (blob.size >= limit) {
    let compressed;
    try { compressed = await compress(blob); } catch { /* diagnostic fallback below */ }
    if (compressed && compressed.size < limit) {
      blob = new Blob([compressed], { type: 'application/gzip' });
      filename += '.gz';
    } else {
      payload = diagnosticFeedbackPayload(payload);
      // Bound the fallback as well; retain a visible omission marker.
      const budget = Math.min(limit / 2, 256 * 1024);
      let used = 0;
      payload.runs = payload.runs.slice().reverse().map(entry => {
        const events = [];
        for (const event of entry.events.slice().reverse()) {
          const size = new TextEncoder().encode(JSON.stringify(event)).length;
          if (used + size > budget) { entry.run.feedbackEventsOmitted = true; continue; }
          used += size;
          events.unshift(event);
        }
        return { run: entry.run, events };
      }).reverse();
      blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      // Whitespace and run headers also count toward GitHub's file limit.
      while (blob.size >= limit) {
        const entry = payload.runs.find(item => item.events.length);
        if (entry) { entry.events.shift(); entry.run.feedbackEventsOmitted = true; }
        else if (payload.runs.length > 1) {
          payload.runs.shift();
          if (!payload.feedbackOmissions.includes('Older runs omitted to fit the attachment.')) payload.feedbackOmissions.push('Older runs omitted to fit the attachment.');
        } else break;
        blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      }
      filename = filename.replace(/\.json$/, '-diagnostics.json');
      if (blob.size >= limit) throw new Error('Diagnostic attachment exceeds the size limit.');
    }
  }
  const screenshotCount = payload.runs.reduce((sum, entry) => sum + entry.events.filter(event =>
    event.kind === 'screenshot' && (event.data?.screenshot_base64 || event.data?.screenshot_dataUrl)).length, 0);
  const traceType = screenshotCount > 0 || payload.runs.some(entry => entry.run.lossless === true
    || ['userMessage', 'finalContent', 'tabUrl', 'tabTitle'].some(key => entry.run[key])
    || entry.run.attachments?.length
    || entry.events.some(event => ['messages', 'result', 'args', 'content', 'text', 'message', 'reasoning', 'tools'].some(key => event.data?.[key])))
    ? 'full' : 'diagnostic';
  return {
    blob, originalBlob, filename, sessionId, traceType,
    runCount: payload.runs.length, screenshotCount,
    omissions: payload.feedbackOmissions,
  };
}
