import { LlamaCppProvider } from './llamacpp.js';
import { OpenAICompatibleProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

/**
 * Manages LLM provider instances and persists configuration.
 */
export class ProviderManager {
  constructor() {
    this.providers = new Map();
    this.activeProviderId = null;
  }

  /**
   * Load saved configuration from browser.storage.
   */
  async load() {
    const data = await browser.storage.local.get(['providers', 'activeProvider']);
    const configs = data.providers || this._defaultConfigs();
    this.activeProviderId = data.activeProvider || 'llamacpp';

    this.providers.clear();
    for (const [id, config] of Object.entries(configs)) {
      this.providers.set(id, this._createProvider(id, config));
    }
  }

  /**
   * Save current configuration to browser.storage.
   */
  async save() {
    const configs = {};
    for (const [id, provider] of this.providers) {
      configs[id] = provider.config;
    }
    await browser.storage.local.set({
      providers: configs,
      activeProvider: this.activeProviderId,
    });
  }

  _defaultConfigs() {
    return {
      llamacpp: {
        type: 'llamacpp',
        label: 'llama.cpp (Local)',
        baseUrl: 'http://localhost:8080',
        model: '',
        enabled: true,
      },
      lmstudio: {
        type: 'openai',
        label: 'LM Studio (Local)',
        providerName: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        model: '',
        apiKey: 'lm-studio',
        enabled: true,
      },
      openai: {
        type: 'openai',
        label: 'OpenAI',
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: '',
        enabled: false,
      },
      openrouter: {
        type: 'openai',
        label: 'OpenRouter',
        providerName: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4',
        apiKey: '',
        enabled: false,
      },
      anthropic: {
        type: 'anthropic',
        label: 'Anthropic Claude',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-20250514',
        apiKey: '',
        enabled: false,
      },
    };
  }

  _createProvider(id, config) {
    switch (config.type) {
      case 'llamacpp':
        return new LlamaCppProvider(config);
      case 'openai':
        return new OpenAICompatibleProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
  }

  /**
   * Get the currently active provider.
   */
  getActive() {
    const provider = this.providers.get(this.activeProviderId);
    if (!provider) {
      throw new Error(`No active provider: ${this.activeProviderId}`);
    }
    return provider;
  }

  /**
   * Switch the active provider.
   */
  async setActive(id) {
    if (!this.providers.has(id)) {
      throw new Error(`Provider not found: ${id}`);
    }
    this.activeProviderId = id;
    await this.save();
  }

  /**
   * Update a provider's configuration.
   */
  async updateProvider(id, config) {
    const merged = { ...this.providers.get(id)?.config, ...config };
    this.providers.set(id, this._createProvider(id, merged));
    await this.save();
  }

  /**
   * Get all provider configs for the settings UI.
   */
  getAll() {
    const result = {};
    for (const [id, provider] of this.providers) {
      result[id] = { id, ...provider.config };
    }
    return result;
  }

  /**
   * Test a specific provider's connection.
   */
  async testProvider(id) {
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    return provider.testConnection();
  }
}
