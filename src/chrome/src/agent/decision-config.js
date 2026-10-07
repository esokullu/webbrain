export const DEFAULT_DECISION_MODEL = 'perplexity/pplx-decider-v1-27b';
export const DECISION_SETTINGS_KEYS = [
  'systemOneEnabled', 'typesafeApiKey', 'decisionProvider', 'decisionModel',
  'decisionApiKey', 'decisionLocalApiKey', 'decisionBaseUrl', 'decisionVisionMode', 'decisionVisionSupported',
  'decisionInputRate', 'decisionOutputRate', 'systemOneDoneEnabled', 'systemOneDoneThreshold',
];

// Resolve legacy settings without rewriting credentials or opted-in features.
export function resolveDecisionConfig(stored = {}, compass = null) {
  const provider = compass ? 'compass' : (stored.decisionProvider || (stored.typesafeApiKey ? 'typesafe' : 'openrouter'));
  if (!['compass', 'openrouter', 'typesafe', 'local'].includes(provider)) throw new Error('Unknown decision provider.');
  const defaults = { compass: DEFAULT_DECISION_MODEL, openrouter: DEFAULT_DECISION_MODEL, typesafe: 'jev-1.13.0', local: 'kev-latest' };
  const model = compass ? DEFAULT_DECISION_MODEL : String(stored.decisionModel || defaults[provider]).trim();
  const baseUrl = provider === 'compass' ? String(compass.baseUrl || 'https://api.webbrain.one/v1')
    : provider === 'openrouter' ? 'https://openrouter.ai/api/alpha'
      : provider === 'typesafe' ? 'https://api.typesafe.ai/v1'
        : String(stored.decisionBaseUrl || 'http://127.0.0.1:8009').trim();
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid decision endpoint.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw new Error('Decision endpoints require HTTPS outside localhost.');
  const apiKey = String(compass?.apiKey || (provider === 'typesafe' ? stored.typesafeApiKey : provider === 'local' ? stored.decisionLocalApiKey : stored.decisionApiKey) || '').trim();
  const visionMode = compass ? 'auto' : (stored.decisionVisionMode || 'auto');
  const rate = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    provider, model, apiKey, baseUrl: baseUrl.replace(/\/$/, ''),
    url: baseUrl.replace(/\/$/, '') + (['compass', 'openrouter'].includes(provider) ? '/decisions' : provider === 'typesafe' || url.pathname.replace(/\/$/, '').endsWith('/v1') ? '/systemone' : '/v1/systemone'),
    local: provider === 'local' && loopback,
    enabled: !!compass || (stored.systemOneEnabled === true && (provider === 'local' || !!apiKey)),
    doneEnabled: !!compass || stored.systemOneDoneEnabled !== false,
    threshold: Number.isFinite(stored.systemOneDoneThreshold) && stored.systemOneDoneThreshold >= .5 && stored.systemOneDoneThreshold <= .99 ? stored.systemOneDoneThreshold : .9,
    supportsVision: visionMode === 'on' || (visionMode !== 'off' && (compass ? true : stored.decisionVisionSupported === true)),
    config: { category: provider === 'local' && loopback ? 'local' : 'cloud', providerName: provider === 'compass' ? 'webbrain-cloud' : provider,
      inputCostPerMillionUsd: rate(stored.decisionInputRate, provider === 'typesafe' ? .042 : provider === 'local' ? 0 : .04),
      outputCostPerMillionUsd: rate(stored.decisionOutputRate, 0) },
  };
}

export async function listDecisionModels(config, fetchImpl = globalThis.fetch, signal) {
  return withCompletionTimeout(requestSignal => discoverDecisionModels(config, fetchImpl, requestSignal), signal, 5000);
}

async function discoverDecisionModels(config, fetchImpl, signal) {
  const url = config.provider === 'openrouter' ? 'https://openrouter.ai/api/v1/models?output_modalities=decisions' : config.baseUrl + (config.baseUrl.endsWith('/v1') ? '/models' : '/v1/models');
  const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', signal, headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {} });
  if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}.`);
  const body = await response.json();
  const models = Array.isArray(body) ? body : body.data || body.models || [];
  if (!Array.isArray(models)) throw new Error('Invalid decision model catalog.');
  return models.filter(m => config.provider !== 'openrouter' || m.architecture?.output_modalities?.includes('decisions')).map(m => ({
    id: m.id || m.name, name: m.name || m.id,
    supportsVision: m.architecture?.input_modalities?.includes('image') === true,
    inputRate: Number(m.pricing?.prompt || 0) * 1e6, outputRate: Number(m.pricing?.completion || 0) * 1e6,
  })).filter(m => typeof m.id === 'string');
}
import { withCompletionTimeout } from './completion-verifier.js';
