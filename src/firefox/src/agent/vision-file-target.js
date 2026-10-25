// Local plumbing for a single model-selected screenshot point. These functions
// never enumerate a page, return text/trees, or accept a model selector.
export function visionFileTargetAtPoint(x, y, kind) {
  let hit = document.elementFromPoint(x, y);
  for (let depth = 0; depth < 16 && hit?.shadowRoot; depth++) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (kind === 'control') return hit;
  if (kind === 'upload') {
    if (hit?.tagName === 'INPUT' && hit.type === 'file') return hit;
    for (let node = hit, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
      if (node.tagName === 'LABEL' && node.control?.type === 'file') return node.control;
      if (node.tagName === 'BODY' || node.tagName === 'HTML') break;
    }
    return null;
  }
  for (let node = hit, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
    if (['IMG', 'VIDEO', 'AUDIO', 'A', 'SOURCE'].includes(node.tagName)) return node;
    if (node.tagName === 'BODY' || node.tagName === 'HTML') break;
  }
  return null;
}

// Firefox has no action-scoped protocol switch for suppressing native file
// dialogs. This short-lived trap only captures the concrete file input chosen
// by the page during one native click; it never discovers an input by selector.
export function createVisionFileChooserTrap(x, y, ttl = 2000) {
  const trigger = document.elementFromPoint(x, y), captured = [];
  if (!trigger) throw new Error('The upload control is no longer visible');
  const prototype = HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'showPicker');
  let closed = false, activated = false, timer;
  const capture = input => {
    if (closed || !activated || !input?.isConnected || input.ownerDocument !== document || input.type !== 'file') return false;
    captured.push(input); return true;
  };
  const listener = event => {
    if (event.isTrusted && event.composedPath().includes(trigger)) activated = true;
    const input = event.composedPath().find(node => node?.tagName === 'INPUT' && node.type === 'file');
    if (capture(input)) event.preventDefault();
  };
  const replacement = function(...args) {
    if (capture(this)) return;
    return descriptor.value.apply(this, args);
  };
  const close = () => {
    if (closed) return; closed = true; clearTimeout(timer);
    document.removeEventListener('click', listener, true);
    if (descriptor && Object.getOwnPropertyDescriptor(prototype, 'showPicker')?.value === replacement)
      Object.defineProperty(prototype, 'showPicker', descriptor);
  };
  if (descriptor?.value && descriptor.configurable) Object.defineProperty(prototype, 'showPicker', { ...descriptor, value: replacement });
  document.addEventListener('click', listener, true);
  timer = setTimeout(close, Math.min(3000, Math.max(250, ttl)));
  return {
    count: () => captured.length,
    take: () => !closed && captured.length === 1 ? captured[0] : null,
    trigger: () => trigger,
    close,
  };
}

export function visionChooserInputMatches(input, trigger, x, y) {
  return !!input?.isConnected && input.ownerDocument === document && input.tagName === 'INPUT' && input.type === 'file'
    && !!trigger?.isConnected && trigger.ownerDocument === document && document.elementFromPoint(x, y) === trigger;
}

export function visionResourceMetadata(node) {
  if (!node?.isConnected) return null;
  const tag = node.tagName;
  const url = tag === 'A' ? node.href : node.currentSrc || node.src;
  if (!url || url.length > 8192) return null;
  return { url, kind: tag === 'IMG' ? 'image' : tag === 'VIDEO' ? 'video' : tag === 'AUDIO' ? 'audio' : 'file',
    downloadName: String(node.download || '').slice(0, 240) };
}

export function visionInputMetadata(node) {
  if (!node?.isConnected || node.tagName !== 'INPUT' || node.type !== 'file') return null;
  return { accept: String(node.accept || '').slice(0, 4097), disabled: node.disabled,
    multiple: node.multiple, directory: node.hasAttribute('webkitdirectory') };
}

export async function visionReadOriginalBlob(node, expected, maximum) {
  const url = node.currentSrc || node.src || node.href;
  if (!node.isConnected || url !== expected || !url.startsWith('blob:')) throw new Error('Blob target changed');
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error('The original blob bytes are unavailable');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Selected blob exceeds the bounded file limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const mime = response.headers.get('content-type') || 'application/octet-stream';
  const blob = new Blob(chunks, { type: mime });
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
  });
  return { dataUrl, size, mime };
}
