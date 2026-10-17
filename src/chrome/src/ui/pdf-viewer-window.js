/**
 * Keeps the window id the PDF viewer reports with a selection current.
 *
 * The background uses it to tell whether WebBrain's side panel is already showing in
 * the viewer's window (re-opening an open panel closes it). A viewer tab can be
 * dragged into another window after it started. When the browser says the tab was
 * attached to a window, that window is taken at once, with no lookup to wait for: the
 * page lives in the tab, so it is where the tab went. The window is also read again
 * when it gains focus and at the start of each pointer gesture, which settles any
 * case the attach event did not cover.
 */
export function trackViewerWindow({ api, target, fields, tabId = null }) {
  let latest = 0;

  async function refresh() {
    const request = ++latest;
    try {
      const id = (await api.windows?.getCurrent?.())?.id;
      // A lookup that began before a newer answer (a refresh, or a move) is stale.
      if (request === latest && Number.isInteger(id)) fields.windowId = id;
    } catch { /* keep the last id we confirmed */ }
  }

  function handleAttached(attachedTabId, attachInfo) {
    if (tabId == null) {
      void refresh(); // not told which tab is ours, so ask where the page is
      return;
    }
    if (String(attachedTabId) !== String(tabId) || !Number.isInteger(attachInfo?.newWindowId)) return;
    latest += 1; // a lookup already under way describes the window the tab left
    fields.windowId = attachInfo.newWindowId;
  }

  api.tabs?.onAttached?.addListener?.(handleAttached);
  target.addEventListener('focus', refresh);
  target.addEventListener('pointerdown', refresh, true);
  return { refresh };
}
