import { ProviderManager } from './providers/manager.js';
import { Agent } from './agent/agent.js';

/**
 * WebBrain Background Script (Firefox)
 * Routes messages between sidebar, content scripts, and the agent.
 */

const providerManager = new ProviderManager();
const agent = new Agent(providerManager);

// Load maxSteps setting
async function loadMaxSteps() {
  const stored = await browser.storage.local.get('maxAgentSteps');
  if (stored.maxAgentSteps) agent.maxSteps = stored.maxAgentSteps;
}

async function loadAutoScreenshot() {
  const stored = await browser.storage.local.get('autoScreenshot');
  if (stored.autoScreenshot != null) agent.autoScreenshot = stored.autoScreenshot;
}
loadAutoScreenshot();

async function loadSiteAdapters() {
  const stored = await browser.storage.local.get('useSiteAdapters');
  if (stored.useSiteAdapters != null) agent.useSiteAdapters = stored.useSiteAdapters;
}
loadSiteAdapters();

async function loadProfile() {
  const stored = await browser.storage.local.get(['profileEnabled', 'profileText']);
  if (stored.profileEnabled != null) agent.profileEnabled = !!stored.profileEnabled;
  if (typeof stored.profileText === 'string') agent.profileText = stored.profileText;
}
loadProfile();

// Initialize on install
browser.runtime.onInstalled.addListener(async () => {
  await providerManager.load();
  await loadMaxSteps();
  await loadAutoScreenshot();
  console.log('[WebBrain] Extension installed, providers loaded.');
});

// Listen for setting changes
browser.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) {
    agent.maxSteps = changes.maxAgentSteps.newValue;
  }
  if (changes.autoScreenshot) {
    agent.autoScreenshot = changes.autoScreenshot.newValue;
  }
  let refreshPrompts = false;
  if (changes.useSiteAdapters) {
    agent.useSiteAdapters = changes.useSiteAdapters.newValue;
    refreshPrompts = true;
  }
  if (changes.profileEnabled) {
    agent.profileEnabled = !!changes.profileEnabled.newValue;
    refreshPrompts = true;
  }
  if (changes.profileText) {
    agent.profileText = changes.profileText.newValue || '';
    refreshPrompts = true;
  }
  if (refreshPrompts) agent._refreshSystemPrompts();
});

// Open sidebar when browser action is clicked
browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

/**
 * Central message handler.
 */
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.target !== 'background') return;

  return handleMessage(msg, sender).catch(e => ({ error: e.message }));
});

async function handleMessage(msg, sender) {
  if (providerManager.providers.size === 0) {
    await providerManager.load();
  }

  switch (msg.action) {
    case 'chat': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      const updates = [];
      const result = await agent.processMessage(tabId, msg.text, (type, data) => {
        updates.push({ type, data });
        browser.runtime.sendMessage({
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
        browser.runtime.sendMessage({
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
        browser.runtime.sendMessage({
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

    case 'list_ollama_models': {
      return await providerManager.listOllamaModels(msg.providerId);
    }

    case 'get_page_info': {
      const tabId = msg.tabId || sender.tab?.id;
      try {
        return await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
      } catch {
        await browser.tabs.executeScript(tabId, {
          file: 'src/content/content.js',
        });
        return await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
      }
    }

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}
