import { ProviderManager } from './providers/manager.js';
import { Agent } from './agent/agent.js';

/**
 * WebBrain Service Worker (Background Script)
 * Routes messages between side panel, content scripts, and the agent.
 */

const providerManager = new ProviderManager();
const agent = new Agent(providerManager);

// Load maxSteps setting
async function loadMaxSteps() {
  const stored = await chrome.storage.local.get('maxAgentSteps');
  if (stored.maxAgentSteps) agent.maxSteps = stored.maxAgentSteps;
}

async function loadAutoScreenshot() {
  const stored = await chrome.storage.local.get('autoScreenshot');
  if (stored.autoScreenshot != null) agent.autoScreenshot = stored.autoScreenshot;
}
loadAutoScreenshot();

async function loadSiteAdapters() {
  const stored = await chrome.storage.local.get('useSiteAdapters');
  if (stored.useSiteAdapters != null) agent.useSiteAdapters = stored.useSiteAdapters;
}
loadSiteAdapters();

// Initialize on install
chrome.runtime.onInstalled.addListener(async () => {
  await providerManager.load();
  await loadMaxSteps();
  console.log('[WebBrain] Extension installed, providers loaded.');
});

// Also load on startup
chrome.runtime.onStartup?.addListener(async () => {
  await providerManager.load();
  await loadMaxSteps();
});

// Listen for setting changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) {
    agent.maxSteps = changes.maxAgentSteps.newValue;
  }
  if (changes.autoScreenshot) {
    agent.autoScreenshot = changes.autoScreenshot.newValue;
  }
  if (changes.useSiteAdapters) {
    agent.useSiteAdapters = changes.useSiteAdapters.newValue;
  }
});

// Track which tabs have the panel enabled (per-tab, not global).
// Persisted to chrome.storage.session so a service worker restart doesn't
// forget which tabs the user had opened the panel on.
const panelTabs = new Set();
const PANEL_TABS_KEY = 'panelTabs';

async function loadPanelTabs() {
  try {
    const stored = await chrome.storage.session.get(PANEL_TABS_KEY);
    if (Array.isArray(stored[PANEL_TABS_KEY])) {
      stored[PANEL_TABS_KEY].forEach(id => panelTabs.add(id));
    }
  } catch (e) { /* session storage not available */ }
}
function savePanelTabs() {
  chrome.storage.session?.set({ [PANEL_TABS_KEY]: Array.from(panelTabs) }).catch(() => {});
}
loadPanelTabs();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// Because manifest.side_panel.default_path is required by Chrome, the panel
// is implicitly available on every tab. Disable it pre-emptively on all
// existing tabs (and any newly created tab) so it only opens where the user
// has explicitly clicked the action.
async function disablePanelOnAllTabsExceptOptedIn() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null && !panelTabs.has(t.id)) {
        chrome.sidePanel.setOptions({ tabId: t.id, enabled: false }).catch(() => {});
      }
    }
  } catch (e) { /* ignore */ }
}
disablePanelOnAllTabsExceptOptedIn();

chrome.tabs.onCreated.addListener((tab) => {
  if (tab?.id != null && !panelTabs.has(tab.id)) {
    chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false }).catch(() => {});
  }
});

// IMPORTANT: must be a sync handler with no awaits before sidePanel.open(),
// otherwise the user-gesture token expires across the await and Chrome
// silently refuses to open the panel.
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  panelTabs.add(tab.id);
  savePanelTabs();
  // Fire-and-forget; do NOT await — preserves user gesture for open() below
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'src/ui/sidepanel.html',
    enabled: true
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

// When switching tabs, explicitly disable the panel on tabs the user didn't
// open it on. With manifest.default_path removed, the panel is OFF by default
// — but we still call setOptions({enabled:false}) defensively to make sure
// Chrome closes the side panel for any window whose new active tab isn't in
// our opt-in set.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!panelTabs.has(tabId)) {
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
  } else {
    // Re-affirm enabled state in case service worker restarted between activations.
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'src/ui/sidepanel.html',
      enabled: true,
    }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelTabs.delete(tabId);
  savePanelTabs();
  // Also clear any persisted chat state for that tab.
  chrome.storage.session?.remove(`tabChat:${tabId}`).catch(() => {});
  // Drop per-tab agent state (last interaction rect, etc.) so stale data
  // can't resurface if Chrome recycles the tab id for a new tab.
  try { agent._lastInteractionRect?.delete(tabId); } catch { /* ignore */ }
});

// SPA navigation tracking. Many sites change route via History API without
// a full page load — content scripts and any cached element snapshots become
// stale. We record per-tab timestamps for both full and history-only
// navigations and expose them on globalThis so cdpClient.resolveSelector can
// extend its retry budget when a click/type fires soon after a nav (the new
// route may still be hydrating).
const lastNavByTab = new Map(); // tabId -> { ts, type, url }
globalThis.__webbrainLastNav = lastNavByTab;

function recordNav(tabId, type, url) {
  if (tabId == null) return;
  lastNavByTab.set(tabId, { ts: Date.now(), type, url: url || '' });
}

chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'history', details.url);
});
chrome.webNavigation?.onReferenceFragmentUpdated?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'fragment', details.url);
});
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'committed', details.url);
});
chrome.webNavigation?.onCompleted?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'completed', details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => lastNavByTab.delete(tabId));

/**
 * Central message handler.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;

  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(e => sendResponse({ error: e.message }));

  return true; // async response
});

async function handleMessage(msg, sender) {
  // Ensure providers are loaded
  if (providerManager.providers.size === 0) {
    await providerManager.load();
  }

  switch (msg.action) {
    // --- Chat / Agent ---
    case 'chat': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      // /allow-api flag is per-conversation. The sidebar tracks it locally
      // but sends it on every chat call so the agent stays in sync after a
      // service worker restart.
      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      const updates = [];
      const result = await agent.processMessage(tabId, msg.text, (type, data) => {
        updates.push({ type, data });
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'agent_update',
          type,
          data,
        }).catch(() => {});
      }, mode);

      return { content: result, updates };
    }

    case 'chat_stream': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      const result = await agent.processMessageStream(tabId, msg.text, (type, data) => {
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'agent_update',
          type,
          data,
        }).catch(() => {});
      }, mode);

      return { content: result };
    }

    case 'continue': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      const result = await agent.continueProcessing(tabId, (type, data) => {
        chrome.runtime.sendMessage({
          target: 'sidepanel',
          action: 'agent_update',
          type,
          data,
        }).catch(() => {});
      }, mode);

      return { content: result };
    }

    case 'clear_conversation': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) agent.clearConversation(tabId);
      return { ok: true };
    }

    case 'abort': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) agent.abort(tabId);
      return { ok: true };
    }

    case 'get_debug_log': {
      return { log: agent.getDebugLog() };
    }

    case 'clear_debug_log': {
      agent.clearDebugLog();
      return { ok: true };
    }

    // --- Provider Management ---
    case 'get_providers': {
      return { providers: providerManager.getAll(), active: providerManager.activeProviderId };
    }

    case 'set_active_provider': {
      await providerManager.setActive(msg.providerId);
      return { ok: true };
    }

    case 'update_provider': {
      await providerManager.updateProvider(msg.providerId, msg.config);
      return { ok: true };
    }

    case 'test_provider': {
      return await providerManager.testProvider(msg.providerId);
    }

    case 'test_vision_provider': {
      return await providerManager.testVisionProvider();
    }

    // --- Page Info (quick, no agent loop) ---
    case 'get_page_info': {
      const tabId = msg.tabId || sender.tab?.id;
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
        return response;
      } catch {
        // Try injecting content script. accessibility-tree.js must load
        // first so content.js's a11y-tree handlers can reach the builder.
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content/accessibility-tree.js', 'src/content/content.js'],
        });
        return await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
      }
    }

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}