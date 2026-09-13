// Voluntary per-provider "share queries for research" outbox. Mirrors the
// Compass cloud-runtime outbox: writes are durable and awaited, network
// delivery is detached and retried by the next run. Unlike runtime events,
// each entry is a complete generation (request + response + attribution) and
// ships to POST /improvement/generations through the WebBrain Compass
// provider instance (its base URL hosts the backend), independent of which
// provider produced the run.

const STORAGE_KEY = 'webbrainShareOutboxV1';
const MAX_OUTBOX_ITEMS = 100;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_REQUEST_BUDGET = 150_000;
const MAX_RESPONSE_CHARS = 40_000;
let storageQueue = Promise.resolve();
let fallbackRunCounter = 0;

function bounded(value, limit) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const text = typeof serialized === 'string' ? serialized : String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${text.length - limit} characters omitted]`;
}

function clampText(value, limit = MAX_MESSAGE_CHARS) {
  if (typeof value !== 'string') return value;
  return bounded(value, limit);
}

function scrubMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const copy = { ...message };
  delete copy.image_url;
  if (Array.isArray(message.content)) {
    const items = [];
    for (const item of message.content) {
      if (!item || typeof item !== 'object') {
        items.push(item);
        continue;
      }
      // Drop images entirely so raw screenshot/data-URI bytes never leave the
      // browser; text blocks are clamped individually.
      if (item.type === 'image_url' || item.type === 'image') continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        items.push({ ...item, text: clampText(item.text) });
        continue;
      }
      items.push(item);
    }
    if (!items.length) return { role: message.role, content: '[image content omitted]' };
    copy.content = items;
  } else if (typeof message.content === 'string') {
    if (!message.content.length) return null;
    copy.content = clampText(message.content);
  }
  return copy;
}

function scrubMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const scrubbed = [];
  let budget = MAX_REQUEST_BUDGET;
  for (const message of messages) {
    if (budget <= 0 || scrubbed.length >= 200) break;
    const copy = scrubMessage(message);
    if (copy == null) continue;
    let serialized;
    try { serialized = JSON.stringify(copy); } catch { continue; }
    if (serialized == null || serialized.length > budget) {
      scrubbed.push({ role: 'system', content: '[remaining shared message omitted]' });
      break;
    }
    scrubbed.push(copy);
    budget -= serialized.length;
  }
  return scrubbed;
}

export function buildShareGenerationItem({
  runId,
  finalContent,
  messages,
  model,
  mode,
  provider,
  provider_name,
}) {
  const request = scrubMessages(messages);
  if (!request?.length) return null;
  const responseContent = String(finalContent ?? '');
  if (!responseContent.trim()) return null;
  const generatedId = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${(++fallbackRunCounter).toString(36)}`;
  return {
    id: String(runId || `share_${generatedId}`),
    provider: String(provider || '').slice(0, 64),
    provider_name: String(provider_name || '').slice(0, 128),
    model: String(model || '').slice(0, 255),
    mode: String(mode || '').slice(0, 32),
    request,
    response: { role: 'assistant', content: clampText(responseContent, MAX_RESPONSE_CHARS) },
  };
}

function localStorageArea() {
  const api = (typeof browser !== 'undefined' && browser?.storage)
    ? browser
    : ((typeof chrome !== 'undefined' && chrome?.storage) ? chrome : null);
  if (!api?.storage?.local?.get || !api.storage.local.set) {
    throw new Error('Extension local storage is unavailable');
  }
  return api.storage.local;
}

async function readOutbox() {
  const stored = await localStorageArea().get([STORAGE_KEY]);
  return Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

function updateOutbox(update) {
  const next = storageQueue.catch(() => {}).then(async () => {
    const current = await readOutbox();
    const value = await update(current);
    await localStorageArea().set({ [STORAGE_KEY]: value.slice(-MAX_OUTBOX_ITEMS) });
    return value;
  });
  storageQueue = next;
  return next;
}

export async function enqueueShareGeneration(item) {
  if (!item?.id || item.request === undefined || item.response === undefined) return false;
  await updateOutbox(current => {
    if (current.some(entry => entry?.id === item.id)) return current;
    return [...current, { ...item, queued_at: Date.now() }];
  });
  return true;
}

export async function flushShareOutbox(transportProvider) {
  if (typeof transportProvider?.sendShareGeneration !== 'function') return 0;
  await storageQueue.catch(() => {});
  let snapshot;
  try { snapshot = await readOutbox(); } catch { return 0; }
  if (!snapshot.length) return 0;
  const removeIds = new Set();
  for (const entry of snapshot) {
    let result;
    try {
      result = await transportProvider.sendShareGeneration(entry.session_id, {
        provider: entry.provider,
        provider_name: entry.provider_name,
        model: entry.model,
        mode: entry.mode,
        request: entry.request,
        response: entry.response,
      });
    } catch {
      result = { ok: false, retryable: true };
    }
    if (result?.ok === true || result?.retryable === false) removeIds.add(entry.id);
  }
  if (removeIds.size) {
    await updateOutbox(current => current.filter(entry => !removeIds.has(entry?.id)));
  }
  return removeIds.size;
}

export const SHARE_OUTBOX_STORAGE_KEY = STORAGE_KEY;