import { selectRedactionRegions } from './screenshot-redaction.js';

// Chrome may omit its own extension documents from webNavigation.getAllFrames.
// Only this packaged page can use its explicitly installed frame-zero scanner.
export async function captureOwnedNewtabRedaction(api, tabId, coordinateSpace, maxRegions = 400) {
  try {
    const packaged = new URL(api.runtime.getURL('newtab/index.html'));
    const ownPage = value => {
      const url = new URL(value);
      return ['chrome-extension:', 'moz-extension:'].includes(packaged.protocol)
        && url.protocol === packaged.protocol && url.host === packaged.host
        && url.pathname === packaged.pathname && !url.username && !url.password;
    };
    const currentTab = async expected => {
      const tab = await api.tabs.get(tabId);
      return tab?.id === tabId && ownPage(tab.url) && !tab.pendingUrl
        && (!expected || tab.url === expected) ? tab : null;
    };
    const before = await currentTab();
    if (!before) return null;
    const params = { coordinateSpace, ownedNewtabOnly: true, expectedUrl: before.url };
    const snapshot = await api.tabs.sendMessage(tabId, {
      target: 'redaction-content', action: 'get_redaction_regions', params,
    }, { frameId: 0 });
    if (snapshot?.ownedNewtabCoverage !== true || snapshot.documentUrl !== before.url
        || typeof snapshot.documentToken !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshot.documentToken)
        || snapshot.complete !== true || snapshot.overflowed !== false
        || !Array.isArray(snapshot.elements) || !Array.isArray(snapshot.childFrames)
        || snapshot.elements.length > maxRegions || snapshot.childFrames.length > maxRegions
        || !Number.isFinite(snapshot.viewport?.width) || snapshot.viewport.width <= 0
        || !Number.isFinite(snapshot.viewport?.height) || snapshot.viewport.height <= 0) return null;
    const validRect = (rect, rendered = true) => rect
      && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect[key]))
      && (rendered ? rect.w > 0 && rect.h > 0 : rect.w >= 0 && rect.h >= 0);
    if (snapshot.elements.some(element => !validRect(element?.rect)
        || !['input', 'textarea', 'select', 'text'].includes(element.kind)
        || (element.kind === 'text' && typeof element.text !== 'string'))
        || snapshot.childFrames.some(child => typeof child?.rendered !== 'boolean'
          || !validRect(child.rect, child.rendered))) return null;
    const regions = selectRedactionRegions(snapshot.elements, { maxRegions: maxRegions + 1 });
    // Child documents are not enumerated here; cover their entire border box
    // instead of asserting that inspecting only the parent covers their pixels.
    for (const child of snapshot.childFrames) {
      if (child.rendered) regions.push({ kind: 'frame', rect: child.rect });
    }
    if (regions.length > maxRegions || !await currentTab(before.url)) return null;
    const confirmation = await api.tabs.sendMessage(tabId, {
      target: 'redaction-content', action: 'confirm_redaction_document',
      params: { ...params, documentToken: snapshot.documentToken },
    }, { frameId: 0 });
    if (confirmation?.current !== true || confirmation.documentUrl !== before.url
        || confirmation.documentToken !== snapshot.documentToken
        || !await currentTab(before.url)) return null;
    return { coordinateSpace, viewport: snapshot.viewport, regions };
  } catch {
    return null;
  }
}
