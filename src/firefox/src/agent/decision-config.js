import { D1_MODEL_ID, D1_CONSENT_KEY, D1_CONSENT_VERSION } from '../providers/d1-config.js';
export const DEFAULT_DECISION_MODEL = 'perplexity/pplx-decider-v1.1-27b';
export const DECISION_SETTINGS_KEYS = [
  'systemOneEnabled', 'typesafeApiKey', 'decisionProvider', 'decisionModel',
  'decisionApiKey', 'decisionLocalApiKey', 'decisionBaseUrl', 'decisionVisionMode', 'decisionVisionSupported',
  'decisionInputRate', 'decisionOutputRate', 'systemOneDoneEnabled', 'systemOneDoneThreshold',
  D1_CONSENT_KEY,
];

// The in-browser chat model answers decisions through its trained probe
// (Chrome; src/chrome/src/offscreen/bonsai-decision-probe.js). Kept in sync
// with WEBGPU_DECISION_MODEL_ID in providers/webgpu.js.
export const WEBGPU_CHAT_DECISION_MODEL = 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision';

// Resolve legacy settings without rewriting credentials or opted-in features.
export function resolveDecisionConfig(stored = {}, compass = null) {
  const explicitD1 = stored.decisionProvider === 'webgpu_d1' && stored.systemOneEnabled === true && stored[D1_CONSENT_KEY] === D1_CONSENT_VERSION;
  const explicitChat = stored.decisionProvider === 'webgpu_chat' && stored.systemOneEnabled === true;
  const provider = explicitD1 ? 'webgpu_d1' : explicitChat ? 'webgpu_chat' : compass ? 'compass' : (stored.decisionProvider || (stored.typesafeApiKey ? 'typesafe' : 'openrouter'));
  if (provider === 'webgpu_d1') return {
    provider, model: D1_MODEL_ID, apiKey: '', baseUrl: '', url: '', local: true,
    enabled: stored.systemOneEnabled === true && stored[D1_CONSENT_KEY] === D1_CONSENT_VERSION,
    doneEnabled: stored.systemOneDoneEnabled === true,
    threshold: Number.isFinite(stored.systemOneDoneThreshold) && stored.systemOneDoneThreshold >= .5 && stored.systemOneDoneThreshold <= .99 ? stored.systemOneDoneThreshold : .9,
    supportsVision: stored.decisionVisionMode !== 'off', experimental: true,
    requiresIndependentSuccessConfirmation: true,
    config: { category: 'local', providerName: provider, inputCostPerMillionUsd: 0, outputCostPerMillionUsd: 0 },
  };
  // Explicitly selected, like D1: an on-device decision provider that never
  // leaves the browser. A positive completion still needs independent proof.
  if (provider === 'webgpu_chat') return {
    provider, model: WEBGPU_CHAT_DECISION_MODEL, apiKey: '', baseUrl: '', url: '', local: true,
    enabled: stored.systemOneEnabled === true,
    doneEnabled: stored.systemOneDoneEnabled === true,
    threshold: Number.isFinite(stored.systemOneDoneThreshold) && stored.systemOneDoneThreshold >= .5 && stored.systemOneDoneThreshold <= .99 ? stored.systemOneDoneThreshold : .9,
    supportsVision: stored.decisionVisionMode !== 'off', experimental: true,
    requiresIndependentSuccessConfirmation: true,
    config: { category: 'local', providerName: provider, inputCostPerMillionUsd: 0, outputCostPerMillionUsd: 0 },
  };
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
  const apiKey = String((provider === 'compass' ? compass?.apiKey : provider === 'typesafe' ? stored.typesafeApiKey : provider === 'local' ? stored.decisionLocalApiKey : stored.decisionApiKey) || '').trim();
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
      inputCostPerMillionUsd: rate(stored.decisionInputRate, provider === 'typesafe' ? .042 : provider === 'local' ? 0 : .02),
      outputCostPerMillionUsd: rate(stored.decisionOutputRate, 0) },
  };
}

export async function listDecisionModels(config, fetchImpl = globalThis.fetch, signal) {
  if (config.provider === 'webgpu_chat') return [{ id: WEBGPU_CHAT_DECISION_MODEL, name: 'Ternary Bonsai 2 2B Vision (in-browser, experimental)', supportsVision: true, inputRate: 0, outputRate: 0 }];
  if (config.provider === 'webgpu_d1') return [{ id: D1_MODEL_ID, name: 'D1 FP16 (experimental, on-device)', supportsVision: true, inputRate: 0, outputRate: 0 }];
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
