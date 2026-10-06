// Provider settings are user-authored. Model tool arguments never select a host or key.
export const IMAGE_GEN_MODEL_KEY = 'imageGenModel';
export const GENERATIVE_MEDIA_SETUP_NOTE = 'Built-in media generation requires setup in Settings → Assistive Models → Generative Media.';
export const GENERATIVE_MEDIA_TIER_NOTE = 'Built-in media generation requires Full-tier Act mode.';
export const MEDIA_PROVIDERS = Object.freeze({
  fal: { label: 'fal.ai', model: 'fal-ai/flux/schnell', keyPlaceholder: 'FAL_KEY', docs: 'https://fal.ai/dashboard/keys' },
  openrouter: { label: 'OpenRouter', model: 'google/gemini-2.5-flash-image', keyPlaceholder: 'sk-or-…', docs: 'https://openrouter.ai/docs/guides/overview/multimodal/image-generation' },
  comfyrouter: { label: 'Comfy Router', model: 'bfl/flux-2-pro', keyPlaceholder: 'comfyui-…', docs: 'https://docs.comfy.org/development/comfy-router/quickstart' },
  comfyui: { label: 'ComfyUI (localhost)', baseUrl: 'http://127.0.0.1:8188', docs: 'https://docs.comfy.org/development/comfyui-server/comms_routes' },
});

export function mediaProvider(config) {
  // Previously saved { apiKey, model } settings remain fal.ai settings.
  return config?.provider == null ? 'fal' : String(config.provider);
}

export function normalizeMediaModel(value) {
  const model = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(model) && !model.includes('..') ? model : '';
}

export function comfyBaseUrl(value) {
  const url = new URL(String(value || MEDIA_PROVIDERS.comfyui.baseUrl).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('ComfyUI URL must use localhost, 127.0.0.1, or [::1], without credentials, query, or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function parseMediaJson(value, label) {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.length > 1024 * 1024) throw new Error(`${label} exceeds 1 MB.`);
    try { parsed = JSON.parse(value || '{}'); } catch { throw new Error(`${label} must be valid JSON.`); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
}

export function validateMediaConfig(config) {
  const provider = mediaProvider(config);
  if (!Object.hasOwn(MEDIA_PROVIDERS, provider)) throw new Error('Unknown generative media provider.');
  if (provider === 'comfyui') {
    comfyBaseUrl(config?.baseUrl);
    const workflow = parseMediaJson(config?.workflow, 'ComfyUI workflow');
    const nodes = Object.values(workflow);
    if (!nodes.length || nodes.some(node => !node || typeof node.class_type !== 'string'
      || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs))) {
      throw new Error('Export a ComfyUI workflow in API format (node IDs, class_type, and inputs).');
    }
    if (!nodes.some(node => Object.values(node.inputs).some(value => typeof value === 'string' && value.includes('{{prompt}}')))) {
      throw new Error('Replace the positive prompt text in the ComfyUI workflow with {{prompt}}.');
    }
  } else {
    if (!String(config?.apiKey || '').trim()) throw new Error('API Key is required.');
    const model = normalizeMediaModel(config?.model);
    if (!model) throw new Error('A valid model ID is required.');
    if (provider === 'comfyrouter' && model.split('/').length !== 2) throw new Error('Comfy Router model IDs use provider/model.');
    if (provider === 'comfyrouter') parseMediaJson(config?.parameters || '{}', 'Model input');
  }
  return provider;
}

export function isImageGenConfigured(config) {
  try { validateMediaConfig(config); return true; } catch { return false; }
}

export function mediaPermissionUrl(config) {
  switch (mediaProvider(config)) {
    case 'fal': return 'https://queue.fal.run';
    case 'openrouter': return 'https://openrouter.ai';
    case 'comfyrouter': return 'https://api.comfy.org';
    case 'comfyui': return comfyBaseUrl(config?.baseUrl);
    default: return '';
  }
}

export function bindMediaPrompt(value, prompt) {
  if (typeof value === 'string') return value.replaceAll('{{prompt}}', prompt);
  if (Array.isArray(value)) return value.map(item => bindMediaPrompt(item, prompt));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindMediaPrompt(item, prompt)]));
  return value;
}
