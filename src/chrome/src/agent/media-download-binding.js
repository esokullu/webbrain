/** Browser-executable media observations. Keep the Firefox copy identical. */
export function captureMediaDownloadBindingInPage(options = null) {
  const downloader = globalThis.window?.SocialMediaDownloader;
  if (typeof downloader?.getMediaBinding !== 'function') return options ? null : {};
  if (options) return downloader.getMediaBinding(options);
  const bindings = {};
  for (const target of ['auto', 'image', 'video']) {
    bindings[target] = downloader.getMediaBinding({ mode: 'main', target, limit: 1 });
  }
  return bindings;
}

/** Read-only capture; failures are observations, never evidence of user activity. */
export function captureMediaDownloadStateInPage() {
  const downloader = globalThis.window?.SocialMediaDownloader;
  const bindings = {}, diagnostics = {};
  if (typeof downloader?.getMediaBinding !== 'function') {
    return { bindings, diagnostics, status: 'library_unavailable' };
  }
  for (const target of ['auto', 'image', 'video']) {
    const options = { mode: 'main', target, limit: 1 };
    try {
      bindings[target] = downloader.getMediaBinding(options);
      diagnostics[target] = bindings[target] ? { status: 'bound', reason: 'verified_resource',
        candidateCount: bindings[target].candidates.length, sourceCount: bindings[target].sources.length,
        paintCarrierCount: bindings[target].sources.filter(source => source.paintCarrier).length }
        : typeof downloader.getMediaBindingDiagnostics === 'function' ? downloader.getMediaBindingDiagnostics(options)
          : { status: 'unavailable', reason: 'no_verified_media' };
    } catch {
      bindings[target] = null;
      diagnostics[target] = { status: 'unavailable', reason: 'capture_failed' };
    }
  }
  return { bindings, diagnostics, status: Object.values(bindings).some(Boolean) ? 'ready' : 'unavailable' };
}
