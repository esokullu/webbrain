// What WebBrain does when nobody answers a clarify question in time.
//
// The user chooses this in Settings → General ("When a question times out"):
// - 'finish' (default) keeps the task moving. The option the model named as
//   finish_option applies as the answer; without one, the model continues
//   with the choice that best completes the task. Runs no longer stall
//   because the user stepped away.
// - 'safe' picks options[0] as a safe default. It authorizes nothing
//   consequential unless the model marked options[0] safe_first.
//
// A question whose answer would authorize one of the short list of
// consequential actions (deleting data, spending money, credentials, who
// receives a message, publishing something the user did not ask for) always
// uses 'safe', whatever the setting, and its timeout authorizes nothing, even
// with safe_first, so walking away never approves one. The model classifies
// every question with `consequence`; only 'none' lets a timeout finish the
// task, so a question it did not classify fails closed.
// WebBrain's own confirmation cards (permissions, form submits, recipients,
// deletions) are separate prompts and never time out.
//
// Shared verbatim by the Chrome and Firefox builds.

export const CLARIFY_TIMEOUT_POLICIES = Object.freeze(['finish', 'safe']);
export const DEFAULT_CLARIFY_TIMEOUT_POLICY = 'finish';
export const CLARIFY_CONSEQUENCES = Object.freeze(['deletion', 'money', 'credentials', 'recipient', 'publication']);
// The model's statement that answering approves nothing on that list.
export const CLARIFY_NO_CONSEQUENCE = 'none';

export const CLARIFY_TIMEOUT_ANSWER = '(no response — timed out)';
export const CLARIFY_INSTANT_NO_OPTIONS_ANSWER = '(no options — auto-selected)';
export const CLARIFY_CONTINUE_ANSWER = '(no reply — continuing the task)';

export function normalizeClarifyTimeoutPolicy(value) {
  return value === 'safe' ? 'safe' : DEFAULT_CLARIFY_TIMEOUT_POLICY;
}

/** 'none', one of CLARIFY_CONSEQUENCES, or null when the question was not classified. */
export function normalizeClarifyConsequence(value) {
  if (value === CLARIFY_NO_CONSEQUENCE) return CLARIFY_NO_CONSEQUENCE;
  return CLARIFY_CONSEQUENCES.includes(value) ? value : null;
}

/**
 * Whether a timeout answers this question with the safe option whatever the
 * setting. Only a question classified 'none' may finish the task on its own;
 * a missing or unknown classification counts as consequential.
 */
export function clarifyQuestionIsHard(consequence) {
  return consequence !== CLARIFY_NO_CONSEQUENCE;
}

/**
 * Decide, when the question is asked, what a timeout will answer.
 * `options` are the displayed options after validation; `finishOption` must
 * already match one of them exactly. A hard question answers options[0] and
 * is never authorized: safe_first is the model's own hint, and the model may
 * have put the consequential option first. Returns
 * { policy, answer, authorized, chosen } where `chosen` is one of
 * 'finish_option' | 'safe_first' | 'continue' | 'first_option' | 'none'.
 */
export function clarifyTimeoutChoice({
  policy,
  options = [],
  safeFirst = false,
  finishOption = '',
  hardQuestion = false,
} = {}) {
  const list = Array.isArray(options) ? options : [];
  const effective = hardQuestion ? 'safe' : normalizeClarifyTimeoutPolicy(policy);
  if (effective === 'finish') {
    if (finishOption && list.includes(finishOption)) {
      return { policy: effective, answer: finishOption, authorized: true, chosen: 'finish_option' };
    }
    if (safeFirst === true && list.length > 0) {
      return { policy: effective, answer: list[0], authorized: true, chosen: 'safe_first' };
    }
    return { policy: effective, answer: CLARIFY_CONTINUE_ANSWER, authorized: true, chosen: 'continue' };
  }
  return {
    policy: effective,
    answer: list.length > 0 ? list[0] : CLARIFY_TIMEOUT_ANSWER,
    authorized: !hardQuestion && safeFirst === true && list.length > 0,
    chosen: list.length > 0 ? 'first_option' : 'none',
  };
}

/** The answer a timer applies: Instant (source=auto) keeps its own marker. */
export function clarifyTimedAnswer(choice, source) {
  if (source === 'auto' && choice?.answer === CLARIFY_TIMEOUT_ANSWER) return CLARIFY_INSTANT_NO_OPTIONS_ANSWER;
  return choice?.answer ?? CLARIFY_TIMEOUT_ANSWER;
}
