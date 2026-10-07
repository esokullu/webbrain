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
