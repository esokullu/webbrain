/** Passive browser churn must not cause unlimited model/preparation retries.
 * Keep the Firefox copy byte-identical. State belongs to the active feedback run.
 */
export const PAGE_FEEDBACK_NUDGE_AT = 2;
export const PAGE_FEEDBACK_STOP_AT = 5;
export const PAGE_FEEDBACK_STOP_CODE = 'page_unstable';

const STOP_MESSAGE = 'Stopped because the page kept changing before the next action could be safely dispatched. '
  + 'The task is incomplete; no stale action was dispatched.';
const NUDGE_MESSAGE = '[PAGE KEEPS CHANGING: Browser updates repeatedly prevented the next action from being dispatched. '
  + 'Use the fresh observation to choose an action whose intended target can be verified. '
  + 'Do not repeat stale targets or coordinates.]';

function boundedStreak(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, PAGE_FEEDBACK_STOP_AT) : 0;
}

/** Content-free diagnostics: never retain arguments, page content, URLs or timestamps. */
export function feedbackSupersessionMetadata({ stage, toolNames, streak } = {}) {
  const names = Array.isArray(toolNames) ? toolNames : [];
  return {
    stage: ['response', 'preparation'].includes(stage) ? stage : 'unknown',
    streak: boundedStreak(streak),
    toolNames: [...new Set(names.filter(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name)))].slice(0, 16),
  };
}

/** Call after accepted dispatch/progress, user steering, or a hard browser intervention. */
export function resetFeedbackSupersession(run) {
  if (run && typeof run === 'object') {
    run.passiveSupersessionStreak = 0;
    delete run.recoveryResult;
  }
}

/**
 * Count only consecutive no-dispatch retries caused by passive page changes.
 * Tool/stage changes do not reset the budget. Accepted observations and actions
 * reset it explicitly; elapsed time is irrelevant, so productive watch tasks
 * and intentionally long runs retain their normal lifetime.
 */
export function accountFeedbackSupersession(run, { passive, stage = 'response', toolNames = [] } = {}) {
  if (!run || typeof run !== 'object' || passive !== true) {
    resetFeedbackSupersession(run);
    return {
      streak: 0, nudge: false, stop: false, code: null, message: '',
      metadata: feedbackSupersessionMetadata({ stage, toolNames, streak: 0 }),
    };
  }
  const previous = boundedStreak(run.passiveSupersessionStreak);
  const streak = Math.min(previous + 1, PAGE_FEEDBACK_STOP_AT);
  run.passiveSupersessionStreak = streak;
  const nudge = previous < PAGE_FEEDBACK_NUDGE_AT && streak === PAGE_FEEDBACK_NUDGE_AT;
  const stop = streak >= PAGE_FEEDBACK_STOP_AT;
  return {
    streak, nudge, stop,
    code: stop ? PAGE_FEEDBACK_STOP_CODE : null,
    message: stop ? STOP_MESSAGE : nudge ? NUDGE_MESSAGE : '',
    metadata: feedbackSupersessionMetadata({ stage, toolNames, streak }),
  };
}
