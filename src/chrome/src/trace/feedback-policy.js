export const FEEDBACK_DIAGNOSTICS_KEY = 'feedbackDiagnosticsEnabled';
export const FEEDBACK_HISTORY_RUNS = 10;
export const FEEDBACK_HISTORY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const FEEDBACK_HISTORY_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_RUN_BYTES = 128 * 1024;

// Automatic diagnostics must never inherit a stale lossless preference.
export function feedbackRecordingPolicy(settings, forced = false) {
  const feedbackOnly = !forced && settings.tracingEnabled !== true
    && settings[FEEDBACK_DIAGNOSTICS_KEY] !== false;
  return {
    enabled: forced || settings.tracingEnabled === true || feedbackOnly,
    feedbackOnly,
    lossless: !feedbackOnly && settings.losslessTrace === true,
  };
}

export function feedbackRunsToEvict(runs, now = Date.now()) {
  const automatic = runs.filter(run => run.feedbackOnly === true);
  const completed = automatic.filter(run => run.status !== 'running')
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  let bytes = automatic.filter(run => run.status === 'running')
    .reduce((sum, run) => sum + (Number(run.feedbackBytes) || 0), 0);
  let kept = 0;
  return completed.filter(run => {
    const size = Number(run.feedbackBytes) || 0;
    if (now - (run.startedAt || 0) > FEEDBACK_HISTORY_AGE_MS
      || kept >= FEEDBACK_HISTORY_RUNS || bytes + size > FEEDBACK_HISTORY_BYTES) return true;
    kept += 1;
    bytes += size;
    return false;
  }).map(run => run.runId);
}
