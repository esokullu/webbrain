// Privacy scans are local geometry only, never model observations. Solid masks
// avoid a lossy/failed blur leaking pixels, and failure stops capture entirely.
async function privacyPng(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Screenshot privacy encoding failed');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return `data:image/png;base64,${btoa(binary)}`;
}

// A newly owned blank document has no content-script privacy scanner. Its
// real compositor capture can still be shared after every pixel is covered.
// The runner owns the exact URL/document fence; this never scans page data.
export async function redactVisionOpaqueCapture(dataUrl) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    if (!(bitmap.width > 0 && bitmap.height > 0)) throw new Error('Empty screenshot privacy bitmap');
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No screenshot privacy canvas');
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = '#202124';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    return await privacyPng(canvas);
  } finally { bitmap?.close?.(); }
}

export async function captureVisionPrivacySnapshot(agent, tabId) {
  if (!agent.screenshotRedaction) return null;
  const scan = await agent.captureScreenshotRedactionSnapshotForUser(tabId, { coordinateSpace: 'page' });
  if (!scan?.ok || !scan.snapshot || scan.snapshot.coordinateSpace !== 'page') {
    const error = Object.assign(new Error('Screenshot privacy scan failed. No screenshot was sent.'),
      { code: 'vision_privacy_scan_failed' });
    // Content scripts may not answer while a document is being replaced.
    // Retry only a missing scan with live-tab evidence of that transition;
    // malformed snapshots and explicit failures must still fail closed.
    if (!scan?.snapshot && !scan?.error && !scan?.code) {
      try {
        const tab = await (globalThis.browser || globalThis.chrome)?.tabs?.get(tabId);
        if (tab?.id === tabId && tab.status === 'loading' && !tab.discarded)
          error.code = 'vision_capture_not_ready';
      } catch { /* A closed or inaccessible tab is not a capture transition. */ }
    }
    throw error;
  }
  return scan.snapshot;
}

export async function redactVisionCapture(agent, tabId, dataUrl, viewport, beforeSnapshot = null) {
  if (!agent.screenshotRedaction && !beforeSnapshot) return dataUrl;
  const after = await captureVisionPrivacySnapshot({
    screenshotRedaction: true,
    captureScreenshotRedactionSnapshotForUser: (...args) => agent.captureScreenshotRedactionSnapshotForUser(...args),
  }, tabId);
  // A field moved/removed during capture must still mask its OLD pixels.
  const sensitiveRegions = [...(beforeSnapshot?.regions || []), ...after.regions];
  let bitmap;
  try {
    bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scaleX = bitmap.width / viewport.width, scaleY = bitmap.height / viewport.height;
    const regions = sensitiveRegions.map(({ rect }) => {
      const x = Math.max(0, Math.floor((rect.x - (viewport.scrollX || 0)) * scaleX));
      const y = Math.max(0, Math.floor((rect.y - (viewport.scrollY || 0)) * scaleY));
      const right = Math.min(bitmap.width, Math.ceil((rect.x + rect.w - (viewport.scrollX || 0)) * scaleX));
      const bottom = Math.min(bitmap.height, Math.ceil((rect.y + rect.h - (viewport.scrollY || 0)) * scaleY));
      return { x, y, width: right - x, height: bottom - y };
    }).filter(rect => rect.width > 0 && rect.height > 0);
    if (!regions.length) return dataUrl;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No screenshot privacy canvas');
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = '#202124';
    for (const rect of regions) {
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    return await privacyPng(canvas);
  } finally { bitmap?.close?.(); }
}
