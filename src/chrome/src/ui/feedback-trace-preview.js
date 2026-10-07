import { getFeedbackDraft } from '../feedback-store.js';
import { getFeedbackCopy, formatFeedbackDetails } from './feedback-copy.js';
import { getLocale } from './i18n.js';

let copy = getFeedbackCopy(getLocale());
document.getElementById('title').textContent = copy.view;
document.getElementById('notice').textContent = copy.local;
function download(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
try {
  const draft = await getFeedbackDraft(new URL(location.href).searchParams.get('id'));
  if (!draft?.blob || draft.expiresAt <= Date.now()) throw new Error(copy.unavailable);
  copy = draft.copy || copy;
  document.getElementById('title').textContent = copy.view;
  document.getElementById('notice').textContent = copy.local;
  document.getElementById('details').textContent = formatFeedbackDetails(draft, copy);
  // The original uncompressed JSON is retained only locally, including when
  // the consent dialog proposes a smaller diagnostic fallback.
  const previewBlob = draft.filename.endsWith('-diagnostics.json') ? draft.blob : draft.originalBlob;
  document.getElementById('preview').textContent = await previewBlob.slice(0, 500_000).text();
  if (previewBlob.size > 500_000) document.getElementById('limit').textContent = copy.previewLimited;
  const button = document.getElementById('download'); button.textContent = copy.download;
  button.addEventListener('click', () => download(draft.blob, draft.filename));
  if (draft.blob.size !== draft.originalBlob.size) {
    const original = document.getElementById('download-original'); original.hidden = false; original.textContent = copy.original;
    original.addEventListener('click', () => download(draft.originalBlob, 'webbrain-feedback-full.json'));
  }
} catch (error) {
  document.getElementById('preview').textContent = error.message;
  document.getElementById('download').hidden = true;
}
