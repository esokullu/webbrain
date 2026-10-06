import { runFalGeneration, FAL_AUTH_PROBE_URL } from './fal-media.js';
import { storeGeneratedMedia } from '../generated-media-store.js';
import { IMAGE_GEN_MODEL_KEY, MEDIA_PROVIDERS, mediaProvider, normalizeMediaModel, comfyBaseUrl, parseMediaJson, validateMediaConfig, bindMediaPrompt } from './media-config.js';

const GENERATION_TIMEOUT_MS = 600000;
const MAX_INLINE_BYTES = 20 * 1024 * 1024;
const INLINE_MEDIA = /^data:(image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg)|video\/mp4);base64,[A-Za-z0-9+/=\s]+$/;

export function safeMediaUrl(value) {
  if (typeof value !== 'string') return '';
  if (value.length <= MAX_INLINE_BYTES * 1.4 && INLINE_MEDIA.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

function base64Media(bytes, mime) {
  if (!bytes || bytes.length > MAX_INLINE_BYTES * 1.4 || !/^[A-Za-z0-9+/=\s]+$/.test(bytes)) return '';
  return safeMediaUrl(`data:${mime || 'image/png'};base64,${bytes}`);
}

// Known media fields only: never mistake an API/status URL for the generated asset.
export function extractMediaUrl(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 8) return '';
  if (Array.isArray(payload)) {
    for (const item of payload) { const url = safeMediaUrl(item) || extractMediaUrl(item, depth + 1); if (url) return url; }
    return '';
  }
  if (payload.b64_json) { const url = base64Media(payload.b64_json, payload.media_type); if (url) return url; }
  if (payload.inlineData || payload.inline_data) {
    const data = payload.inlineData || payload.inline_data;
    const url = base64Media(data.data, data.mimeType || data.mime_type); if (url) return url;
  }
  // Native Comfy Router outputs (e.g. Luma) include preview assets too.
  // Prefer the final video/audio over its image; progress_video is not a result.
  for (const key of ['video', 'audio', 'image']) {
    const asset = payload.assets?.[key];
    const url = safeMediaUrl(asset) || extractMediaUrl(asset, depth + 1); if (url) return url;
  }
  for (const key of ['url', 'sample', 'image_url', 'video_url', 'audio_url']) {
    const url = safeMediaUrl(payload[key]) || extractMediaUrl(payload[key], depth + 1); if (url) return url;
  }
  for (const key of ['data', 'result', 'output', 'images', 'image', 'videos', 'video', 'audio', 'candidates', 'content', 'parts']) {
    const url = safeMediaUrl(payload[key]) || extractMediaUrl(payload[key], depth + 1); if (url) return url;
  }
  return '';
}

function operationSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason || new DOMException('Generation cancelled.', 'AbortError'));
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Generative media timed out.', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

function delay(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function jsonResponse(response, label) {
  if (!response.ok) {
    let message = '';
    try { message = (await response.text()).slice(0, 300); } catch { /* no body */ }
    throw new Error(`${label} failed (HTTP ${response.status})${message ? ': ' + message : '.'}`);
  }
  const body = await response.json();
  if (body?.error || body?.error_type) throw new Error(`${label}: ${body.error?.message || body.error_type || body.error}`);
  return body;
}

function pollDelay(response, fallback) {
  const seconds = Number(response.headers?.get?.('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 60000) : fallback;
}

async function cancelRequest(url, init, fetchImpl) {
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try { await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit' }); } catch { /* best effort */ }
  finally { clearTimeout(timer); }
}

async function mediaResponse(response, label) {
  const mime = (response.headers?.get?.('Content-Type') || '').split(';')[0].trim();
  if (response.ok && /^(image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg)|video\/mp4)$/.test(mime)) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_INLINE_BYTES) throw new Error('Generated media exceeds the 20 MB inline limit. Choose a model that returns hosted media.');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return `data:${mime};base64,${btoa(binary)}`;
  }
  const payload = await jsonResponse(response, label);
  const url = extractMediaUrl(payload);
  if (!url) throw new Error(`${label} returned no supported media URL or inline media.`);
  return url;
}

export async function runMediaGeneration({ prompt, config, fetchImpl = fetch, signal, timeoutMs = GENERATION_TIMEOUT_MS, pollIntervalMs = 2000 }) {
  const provider = validateMediaConfig(config);
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is required.');
  if (provider === 'fal') return runFalGeneration({ prompt: text, config, fetchImpl, signal, timeoutMs });
  const operation = operationSignal(signal, timeoutMs);
  const model = provider === 'comfyui' ? 'ComfyUI workflow' : normalizeMediaModel(config.model);
  const request = (url, init = {}) => {
    operation.signal.throwIfAborted();
    return fetchImpl(url, { ...init, signal: operation.signal, redirect: 'error', credentials: 'omit' });
  };
  let cancelUrl = '', cancelInit;
  let completed = false;
  try {
    if (provider === 'openrouter') {
      const res = await request('https://openrouter.ai/api/v1/images', {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      });
      return { url: await mediaResponse(res, 'OpenRouter generation'), model };
    }
    if (provider === 'comfyrouter') {
      const base = `https://api.comfy.org/v2/models/${model}/requests`;
      const headers = { 'X-API-Key': config.apiKey, 'Content-Type': 'application/json' };
      const parameters = parseMediaJson(config.parameters || '{}', 'Model input');
      const usesTemplate = JSON.stringify(parameters).includes('{{prompt}}');
      const body = usesTemplate ? bindMediaPrompt(parameters, text) : { ...parameters, prompt: text };
      const queued = await jsonResponse(await request(base, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body),
      }), 'Comfy Router submit');
      if (!/^[A-Za-z0-9_-]+$/.test(queued.request_id || '')) throw new Error('Comfy Router returned an invalid request ID.');
      // Build authenticated URLs ourselves; never send the key to returned URLs.
      const resultUrl = `${base}/${queued.request_id}`;
      cancelUrl = `${resultUrl}/cancel`; cancelInit = { method: 'PUT', headers };
      let waitMs = pollIntervalMs;
      while (true) {
        await delay(waitMs, operation.signal);
        const res = await request(`${resultUrl}/status`, { headers });
        const status = await jsonResponse(res, 'Comfy Router status');
        waitMs = pollDelay(res, pollIntervalMs);
        if (status.status === 'COMPLETED') {
          const result = await request(resultUrl, { headers });
          if (result.status === 202) { waitMs = pollDelay(result, pollIntervalMs); continue; }
          const url = await mediaResponse(result, 'Comfy Router generation');
          completed = true;
          return { url, model };
        }
        if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new Error('Comfy Router returned an unknown queue status.');
      }
    }
    const base = comfyBaseUrl(config.baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    const workflow = bindMediaPrompt(parseMediaJson(config.workflow, 'ComfyUI workflow'), text);
    const queued = await jsonResponse(await request(`${base}/prompt`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
    }), 'ComfyUI submit');
    if (!/^[A-Za-z0-9_-]+$/.test(queued.prompt_id || '')) throw new Error('ComfyUI returned an invalid prompt ID.');
    // Delete this queued prompt only. /interrupt could stop someone else's running workflow.
    cancelUrl = `${base}/queue`; cancelInit = { method: 'POST', headers, body: JSON.stringify({ delete: [queued.prompt_id] }) };
    while (true) {
      await delay(pollIntervalMs, operation.signal);
      const history = await jsonResponse(await request(`${base}/history/${queued.prompt_id}`), 'ComfyUI history');
      const item = history[queued.prompt_id];
      if (!item) continue;
      if (item.status?.status_str === 'error') throw new Error('ComfyUI workflow failed. Check the workflow, installed nodes, and local models.');
      for (const output of Object.values(item.outputs || {})) {
        for (const key of ['images', 'gifs', 'videos', 'audio']) for (const file of output[key] || []) {
          if (typeof file.filename !== 'string' || !file.filename || file.type === 'temp') continue;
          const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
          completed = true;
          return { url: `${base}/view?${params}`, model };
        }
      }
      if (item.status?.completed || item.status?.status_str === 'success') throw new Error('ComfyUI workflow completed without saved media. Add a Save Image or media output node.');
    }
  } catch (error) {
    if (!completed && cancelUrl) await cancelRequest(cancelUrl, cancelInit, fetchImpl);
    throw operation.signal.aborted ? operation.signal.reason : error;
  } finally { operation.dispose(); }
}

export async function readMediaConfig() {
  const api = typeof browser !== 'undefined' && browser?.storage ? browser : globalThis.chrome;
  const stored = await api.storage.local.get([IMAGE_GEN_MODEL_KEY]);
  return stored?.[IMAGE_GEN_MODEL_KEY];
}

export async function generateImage(args, options = {}) {
  const fetchImpl = typeof options === 'function' ? options : options.fetchImpl || fetch;
  try {
    const config = Object.hasOwn(options, 'config') ? options.config : await readMediaConfig();
    if (!config) throw new Error('Configure Generative Media in Settings → Assistive Models.');
    const result = await runMediaGeneration({ prompt: args?.prompt, config, fetchImpl, signal: options.signal });
    if (result.url.startsWith('data:')) {
      const asset = await storeGeneratedMedia(result.url);
      return { success: true, model: result.model, provider: mediaProvider(config), ...asset };
    }
    return { success: true, ...result, provider: mediaProvider(config) };
  } catch (error) { return { success: false, error: error.message }; }
}

// Free read-only probes. Model metadata confirms availability; no generation is submitted.
export async function testImageGenProvider(fetchImpl = fetch) {
  const operation = operationSignal(null, 15000);
  try {
    const config = await readMediaConfig();
    const provider = validateMediaConfig(config);
    const model = provider === 'comfyui' ? 'ComfyUI workflow' : normalizeMediaModel(config.model);
    let url, headers;
    if (provider === 'fal') { url = FAL_AUTH_PROBE_URL; headers = { Authorization: `Key ${config.apiKey}` }; }
    if (provider === 'openrouter') { url = 'https://openrouter.ai/api/v1/key'; headers = { Authorization: `Bearer ${config.apiKey}` }; }
    if (provider === 'comfyrouter') { url = `https://api.comfy.org/v2/models/${model}`; headers = { 'X-API-Key': config.apiKey }; }
    if (provider === 'comfyui') { url = `${comfyBaseUrl(config.baseUrl)}/system_stats`; headers = {}; }
    const res = await fetchImpl(url, { headers, signal: operation.signal, redirect: 'error', credentials: 'omit' });
    if (!res.ok) throw new Error(`${MEDIA_PROVIDERS[provider].label} connection failed (HTTP ${res.status}).`);
    if (provider === 'openrouter') {
      await jsonResponse(res, 'OpenRouter key');
      const catalog = await jsonResponse(await fetchImpl('https://openrouter.ai/api/v1/images/models', { headers, signal: operation.signal, redirect: 'error', credentials: 'omit' }), 'OpenRouter image models');
      if (!catalog.data?.some(item => item.id === model)) throw new Error('The selected OpenRouter model is not in the image generation catalog.');
    } else if (provider === 'comfyui') {
      const stats = await jsonResponse(res, 'ComfyUI');
      if (!stats.system || !Array.isArray(stats.devices)) throw new Error('The endpoint did not return ComfyUI system information.');
    } else if (provider === 'comfyrouter') {
      const detail = await jsonResponse(res, 'Comfy Router model');
      if (detail.id !== model) throw new Error('Comfy Router did not confirm the selected model.');
    }
    return { ok: true, model, provider };
  } catch (error) { return { ok: false, error: error.message }; }
  finally { operation.dispose(); }
}
