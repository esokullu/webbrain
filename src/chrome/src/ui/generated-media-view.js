import { loadGeneratedMedia } from '../generated-media-store.js';

const objectUrls = new WeakMap();

function renderPreview(wrapper, url, t, storedMime = '') {
  let allowed = /^data:(image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg)|video\/mp4);base64,[A-Za-z0-9+/=\s]+$/.test(url);
  let parsed;
  try {
    parsed = new URL(url);
    allowed ||= !parsed.username && !parsed.password && (parsed.protocol === 'https:'
      || (['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)));
  } catch { /* only supported media URLs */ }
  // Blob URLs are accepted only when created here from a validated stored asset.
  if (!allowed && objectUrls.get(wrapper) !== url) return;
  const mime = storedMime || url.match(/^data:([^;]+);/)?.[1] || '';
  const filename = parsed?.searchParams.get('filename') || parsed?.pathname || '';
  const video = mime.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(filename);
  const audio = mime.startsWith('audio/') || /\.(mp3|wav|ogg)$/i.test(filename);
  const media = document.createElement(video ? 'video' : audio ? 'audio' : 'img');
  if (media.tagName === 'IMG') media.alt = t('st.imagegen.output');
  else { media.controls = true; media.preload = 'metadata'; }
  media.style.cssText = 'max-width:100%;max-height:480px;border-radius:8px;object-fit:contain;';
  media.referrerPolicy = 'no-referrer';
  media.src = url;
  const link = document.createElement('a');
  link.href = url; link.textContent = t('st.imagegen.save_output');
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  if (url.startsWith('data:') || storedMime) link.download = `webbrain-media.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'video/mp4': 'mp4' })[mime] || 'png'}`;
  wrapper.replaceChildren(media, link);
}

async function hydrateStoredMedia(wrapper, t) {
  try {
    const blob = await loadGeneratedMedia(wrapper.dataset.mediaId);
    if (!blob) throw new Error('Missing generated media');
    const previous = objectUrls.get(wrapper);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob);
    objectUrls.set(wrapper, url);
    renderPreview(wrapper, url, t, blob.type);
  } catch {
    wrapper.textContent = t('st.imagegen.unavailable_output');
  }
}

// A synchronous placeholder keeps the asset handle in chat snapshots even if
// the panel closes before the IndexedDB read finishes.
export function appendGeneratedMedia(container, result, t) {
  if (!container || !result?.success || (!result.mediaId && typeof result.url !== 'string')) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'generated-media';
  wrapper.style.cssText = 'margin:12px 0;display:grid;gap:8px;max-width:100%;';
  if (result.mediaId) {
    wrapper.dataset.mediaId = result.mediaId;
    container.appendChild(wrapper);
    return hydrateStoredMedia(wrapper, t);
  }
  renderPreview(wrapper, result.url, t);
  if (wrapper.childElementCount) container.appendChild(wrapper);
}

export function restoreGeneratedMedia(root, t) {
  return Promise.all([...root.querySelectorAll('.generated-media[data-media-id]')]
    .map(wrapper => hydrateStoredMedia(wrapper, t)));
}
