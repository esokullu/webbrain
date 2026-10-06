/** Persisted, plain-text navigation notices; never render page URLs as markup. */
export function renderPageFeedbackNote(assistantEl, data, translate) {
  if (!assistantEl || !data?.navigation || !data.id) return false;
  if ([...assistantEl.querySelectorAll('[data-page-feedback-id]')].some(el => el.dataset.pageFeedbackId === data.id)) return false;
  const displayUrl = value => {
    try {
      const url = new URL(value);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return url.toString().slice(0, 300);
    } catch { return ''; }
  };
  const note = document.createElement('div');
  note.className = 'page-feedback-note';
  note.dataset.pageFeedbackId = String(data.id);
  note.setAttribute('role', 'status');
  note.textContent = translate('sp.monitor.navigation', {
    before: displayUrl(data.before) || '…', after: displayUrl(data.after) || '…',
  });
  assistantEl.appendChild(note);
  return true;
}
