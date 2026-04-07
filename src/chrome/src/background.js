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
});

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
        // Try injecting content script
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content/content.js'],
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