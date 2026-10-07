import { buildTraceExportPayload } from './export-contract.js';
import { sanitizeTraceExport } from '../agent/trace-export.js';
import { buildTraceStats } from './stats.js';

// These fields change independently of retained events; the current row cannot
// tell us their values when the rating prompt opened.
const MUTABLE_RUN_FIELDS = [
  'losslessBytes', 'losslessBytesEncoding', 'feedbackBytes', 'feedbackEventsOmitted',
  'repairedBy', 'repairedAt', 'repairReason',
];

// Run in the downloading extension page, never send this JSON through runtime
// messaging: screenshots can make it larger than the browser message limit.
// Export the stored session without the Markdown preview's text/run limits.
// This deliberately preserves recording-time omission markers: an export
// cannot recover content that was never retained by the recorder.
export async function exportRecordedSession(store, sessionId, version = '', { snapshotAt } = {}) {
  const bounded = snapshotAt !== undefined;
  if (bounded && (!Number.isSafeInteger(snapshotAt) || snapshotAt < 0)) throw new Error('Invalid trace snapshot timestamp.');
  // Use an exclusive cutoff: recordings with the same clock tick as opening
  // the prompt cannot be reliably identified as preceding it.
  const beforeSnapshot = timestamp => Number.isFinite(timestamp) && timestamp < snapshotAt;
  const snapshotOmissions = new Set();
  const sessionRuns = (await store.listRuns({ limit: Number.MAX_SAFE_INTEGER, conversationId: sessionId }))
    .filter(run => run.conversationId === sessionId);
  if (bounded && sessionRuns.some(run => !Number.isFinite(run.startedAt))) {
    snapshotOmissions.add('Runs without recording timestamps were excluded from the conversation snapshot.');
  }
  const runs = sessionRuns.filter(run => !bounded || beforeSnapshot(run.startedAt))
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || String(a.runId).localeCompare(String(b.runId)));
  const entries = [];
  let recordingTruncated = false;
  for (const run of runs) {
    const recordedEvents = await store.getRunEvents(run.runId);
    const events = bounded ? recordedEvents.filter(event => beforeSnapshot(event.ts)) : recordedEvents;
    let exportedRun = run;
    if (bounded) {
      if (recordedEvents.some(event => !Number.isFinite(event.ts))) snapshotOmissions.add('Events without recording timestamps were excluded from the conversation snapshot.');
      const stats = buildTraceStats(events);
      delete stats.hasLoopError;
      exportedRun = { ...run, ...stats };
      for (const field of MUTABLE_RUN_FIELDS) delete exportedRun[field];
      snapshotOmissions.add('Run-level byte counters, diagnostic omission flags, and repair metadata cannot be reconstructed at the recording cutoff and are excluded.');
      if (!beforeSnapshot(run.endedAt)) {
        // Completion fields may have been written after the prompt opened.
        exportedRun = { ...exportedRun, endedAt: null, durationMs: null, status: 'running', finalContent: null, feedbackSnapshotIncomplete: true };
        snapshotOmissions.add('A run was unfinished when the rating prompt opened; later events and completion details are excluded.');
      }
    }
    for (const event of events) {
      if (event.data?.losslessBudgetOmitted || event.data?.result?._truncated || event.data?.messages?._truncated) recordingTruncated = true;
      if (event.kind !== 'screenshot') continue;
      const shot = await store.getScreenshot(run.runId, event.seq);
      if (shot?.blob) {
        const bytes = new Uint8Array(await shot.blob.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        event.data = { ...event.data, screenshot_base64: `data:${shot.blob.type || 'image/png'};base64,${btoa(binary)}` };
      } else if (shot?.dataUrl) event.data = { ...event.data, screenshot_dataUrl: shot.dataUrl };
    }
    entries.push({ run: exportedRun, events });
  }
  const payload = buildTraceExportPayload(entries, {
    sessionId, exportedByWebBrainVersion: version,
  });
  if (bounded && payload.session) payload.session.capturedBefore = snapshotAt;
  return { json: JSON.stringify(sanitizeTraceExport(payload), null, 2),
    turnCount: entries.length, recordingTruncated, snapshotOmissions: [...snapshotOmissions] };
}
