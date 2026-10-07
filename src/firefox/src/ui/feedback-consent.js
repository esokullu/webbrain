import { formatFeedbackDetails } from './feedback-copy.js';

export function requestFeedbackConsent(trace, copy, viewTrace) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'feedback-trace-dialog';
    dialog.setAttribute('aria-labelledby', 'feedback-trace-title');
    dialog.setAttribute('aria-describedby', 'feedback-trace-public');
    const previousFocus = document.activeElement;
    const text = (tag, value, id = '') => {
      const element = document.createElement(tag); element.textContent = value;
      if (id) element.id = id;
      dialog.append(element); return element;
    };
    text('h2', copy.title, 'feedback-trace-title');
    text('p', copy.publicWarning, 'feedback-trace-public');
    text('p', copy[trace.traceType]);
    text('p', formatFeedbackDetails(trace, copy)).className = 'feedback-trace-details';
    if (trace.omissions.length) text('p', trace.blob !== trace.originalBlob && trace.filename.endsWith('-diagnostics.json') ? copy.oversized : copy.omitted);
    const actions = text('div', ''); actions.className = 'feedback-trace-actions';
    const finish = choice => { dialog.close(); dialog.remove(); previousFocus?.focus(); resolve(choice); };
    for (const [choice, label] of [['view', copy.view], ['upload', copy.upload], ['without', copy.without], ['cancel', copy.cancel]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.dataset.feedbackChoice = choice;
      button.className = choice === 'upload' ? 'store-review-primary' : 'feedback-trace-secondary';
      button.addEventListener('click', () => choice === 'view' ? void viewTrace().catch(error => {
        text('p', error.message).setAttribute('role', 'alert');
      }) : finish(choice));
      actions.append(button);
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel'); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    document.body.append(dialog); dialog.showModal();
    actions.querySelector('[data-feedback-choice="cancel"]').focus();
  });
}

// The only call capable of opening the upload destination is after consent.
export async function submitFeedbackWithTrace({ prepare, stage, consent, discard, open, rating, comment, copy }) {
  let prepared, staged, traceNote = '', handedOff = false;
  try { prepared = await prepare(); } catch { traceNote = copy.exportFailed; }
  if (!prepared) {
    await open({ rating, comment, includeTrace: false, traceNote: traceNote || copy.unavailable, copy });
    return true;
  }
  staged = await stage(prepared);
  try {
    const choice = await consent(prepared, staged);
    if (choice === 'cancel') return false;
    const includeTrace = choice === 'upload';
    if (!includeTrace) await discard(staged.id);
    await open({ id: staged.id, rating, comment, includeTrace, copy,
      traceNote: includeTrace ? `${copy[`${prepared.traceType}Label`]} (${prepared.runCount} runs, ${prepared.screenshotCount} screenshots).`
        + (prepared.omissions.length ? ` ${copy.omitted}` : '') : '' });
    handedOff = includeTrace;
    return true;
  } catch (error) {
    await discard(staged.id); throw error;
  } finally {
    // The background owns an accepted handoff; keep its immutable bytes for retries.
    if (!handedOff) await discard(staged.id);
  }
}
