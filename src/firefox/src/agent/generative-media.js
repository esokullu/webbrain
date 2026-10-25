import { runFalGeneration, FAL_AUTH_PROBE_URL } from './fal-media.js';
import { MAX_JOINED_VIDEO_BYTES, storeGeneratedMedia, storeGeneratedMediaBlob } from '../generated-media-store.js';
import { IMAGE_GEN_MODEL_KEY, MEDIA_PROVIDERS, mediaProvider, mediaSlot, normalizeMediaModel, comfyBaseUrl, parseMediaJson, validateMediaConfig, bindMediaPrompt } from './media-config.js';
import { VideoJoinError, joinMp4Clips, mp4DurationSeconds } from './video-join.js';

const GENERATION_TIMEOUT_MS = 600000;
const MAX_INLINE_BYTES = 20 * 1024 * 1024;
// A video made of scenes: at most two minutes, one clip per scene or several
// when a scene is longer than the model's longest clip.
export const MAX_VIDEO_SECONDS = 120;
export const MAX_VIDEO_CLIPS = 24;
const VIDEO_CLIP_CONCURRENCY = 3;
const VIDEO_ARGUMENTS = ['duration', 'aspect_ratio', 'resolution', 'scenes', 'estimated_duration'];
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

// An HTTP failure keeps its status, so a caller can tell whether trying again
// could help. 402 means the account (OpenRouter's, or the model provider's
// behind it) has run out of credit.
async function jsonResponse(response, label) {
  if (!response.ok) {
    let message = '';
    try { message = (await response.text()).slice(0, 300); } catch { /* no body */ }
    const detail = [response.status === 402 ? 'the account is out of credit; add credit and try again' : '', message].filter(Boolean).join(': ');
    throw Object.assign(new Error(`${label} failed (HTTP ${response.status})${detail ? ': ' + detail : '.'}`), { status: response.status });
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

// OpenRouter's image and video catalogs ('images', 'videos'), each read at
// most once per request. A video model's entry lists what it accepts
// (supported_durations, supported_resolutions, supported_aspect_ratios).
function openRouterCatalogs(headers, request) {
  const lists = {};
  return async kind => {
    if (!lists[kind]) {
      const catalog = await jsonResponse(await request(`https://openrouter.ai/api/v1/${kind}/models`, { headers }), `OpenRouter ${kind} models`);
      lists[kind] = Array.isArray(catalog.data) ? catalog.data : [];
    }
    return lists[kind];
  };
}

const listed = (list, model) => list.find(item => item?.id === model) || null;

/**
 * The OpenRouter model a request uses, with its catalog entry. `media` is
 * 'image', 'video', or null when the call does not say. An empty model setting
 * uses OpenRouter's default. The saved image model can be a video model, saved
 * when there was one model for everything: it then makes the videos, and a
 * call that does not say gets a video from it, as it did then.
 */
async function openRouterTarget(config, media, catalog) {
  const saved = normalizeMediaModel(config.model);
  const savedVideo = normalizeMediaModel(config.videoModel);
  // Whether the saved image model is a video model; null when neither catalog lists it.
  let savedKind;
  const savedIsVideo = async () => {
    if (savedKind === undefined) {
      savedKind = !saved || listed(await catalog('images'), saved) ? false
        : listed(await catalog('videos'), saved) ? true : null;
    }
    return savedKind;
  };
  const kind = media || (!savedVideo && await savedIsVideo() ? 'video' : 'image');
  if (kind === 'image') {
    const savedIsVideoModel = await savedIsVideo();
    if (savedIsVideoModel === null) throw new Error('The selected OpenRouter model is not in the image or video generation catalog.');
    const model = saved && !savedIsVideoModel ? saved : MEDIA_PROVIDERS.openrouter.model;
    const entry = listed(await catalog('images'), model);
    if (!entry) throw new Error(`OpenRouter's image generation catalog does not list ${model}.`);
    return { kind: 'images', model, entry };
  }
  const model = savedVideo || (await savedIsVideo() ? saved : MEDIA_PROVIDERS.openrouter.videoModel);
  const entry = listed(await catalog('videos'), model);
  if (!entry) {
    throw new Error(listed(await catalog('images'), model)
      ? `${model} makes images. Choose a video model in Providers → Generative.`
      : `OpenRouter's video generation catalog does not list ${model}.`);
  }
  return { kind: 'videos', model, entry };
}

function formatSeconds(seconds) {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function videoArguments(args) {
  const video = {};
  for (const key of VIDEO_ARGUMENTS) if (args?.[key] !== undefined) video[key] = args[key];
  return Object.keys(video).length ? video : null;
}

function supportedValues(entry, key) {
  const values = entry?.[key];
  return Array.isArray(values) && values.length ? values : null;
}

function clipDurations(entry) {
  const values = supportedValues(entry, 'supported_durations');
  if (!values) return null;
  const durations = [...new Set(values.map(Number).filter(value => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  return durations.length ? durations : null;
}

// aspect_ratio and resolution, checked against what the model accepts so an
// unsupported value fails before a paid submission. A value matches without
// regard to case and is sent as the model lists it ("768p" as "768P").
function videoShape(entry, video) {
  const shape = {};
  for (const [name, key] of [['aspect_ratio', 'supported_aspect_ratios'], ['resolution', 'supported_resolutions']]) {
    if (video?.[name] === undefined) continue;
    if (entry?.inputs && !entry.inputs.includes(name)) throw new Error(`This video model does not take ${name}.`);
    const supported = supportedValues(entry, key);
    const wanted = String(video[name]);
    const match = supported ? supported.find(value => String(value).toLowerCase() === wanted.toLowerCase()) : wanted;
    if (match === undefined) throw new Error(`This video model does not support ${name} "${wanted}". Supported: ${supported.join(', ')}.`);
    shape[name] = match;
  }
  return shape;
}

// The JSON Schema types a value has.
const jsonTypes = value => (typeof value === 'number' ? (Number.isInteger(value) ? ['integer', 'number'] : ['number']) : [typeof value]);

// Whether a value meets every schema of a form: their types, listed values,
// bounds (exclusive or not) and multipleOf. Other keywords are not checked.
function formAllows(form, value) {
  return form.every(schema => {
    const types = [].concat(schema.type ?? []);
    if (types.length && !jsonTypes(value).some(type => types.includes(type))) return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
    if (schema.const !== undefined && schema.const !== value) return false;
    if (typeof value !== 'number') return true;
    if (Number.isFinite(schema.maximum) && (schema.exclusiveMaximum === true ? value >= schema.maximum : value > schema.maximum)) return false;
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) return false;
    if (Number.isFinite(schema.minimum) && (schema.exclusiveMinimum === true ? value <= schema.minimum : value < schema.minimum)) return false;
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) return false;
    const step = schema.multipleOf;
    return !(step > 0) || Math.abs(value / step - Math.round(value / step)) < 1e-9;
  });
}

// The values a form lists (enum or const) that all of its schemas allow; null
// when it lists none.
function formValues(form) {
  const lists = form.filter(schema => Array.isArray(schema.enum) || schema.const !== undefined)
    .map(schema => (schema.const !== undefined ? [schema.const] : schema.enum));
  if (!lists.length) return null;
  return lists[0].filter(value => (typeof value === 'string' || typeof value === 'number') && formAllows(form, value));
}

// The whole seconds a form without listed values allows, up to an hour; none
// without an upper bound.
function formSeconds(form) {
  if (!form.some(schema => Number.isFinite(schema.maximum) || Number.isFinite(schema.exclusiveMaximum))) return [];
  const seconds = [];
  for (let value = 1; value <= 3600; value++) if (formAllows(form, value)) seconds.push(value);
  return seconds;
}

/**
 * What a video model accepts, read from the OpenAPI document fal.ai and Comfy
 * Router publish for each model, in the form of OpenRouter's catalog entries
 * (supported_durations, supported_aspect_ratios, supported_resolutions), with
 * `inputs`, the names its request body takes, and `encodeDuration`, which
 * writes a clip length the way the model takes it. A model's own values are
 * sent as it lists them (6, "6", "8s"); a length within a range, as a number.
 * Null when the document describes no request body.
 */
export function videoInputCapabilities(openapi) {
  const schemas = openapi?.components?.schemas || {};
  const resolve = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    return typeof node.$ref === 'string' ? resolve(schemas[node.$ref.split('/').pop()], depth + 1) : node;
  };
  // A body's properties by name, with those of its parts. A property in the
  // body and its allOf parts must meet all their schemas; one in anyOf or
  // oneOf variants, any of them.
  const properties = (node, depth = 0) => {
    const body = resolve(node);
    const merged = new Map();
    if (!body || depth > 8) return merged;
    const add = (into, name, schema, key) => into.set(name, into.has(name) ? { [key]: [into.get(name), schema] } : schema);
    if (body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties)) {
      for (const [name, schema] of Object.entries(body.properties)) merged.set(name, schema);
    }
    for (const part of Array.isArray(body.allOf) ? body.allOf : []) {
      for (const [name, schema] of properties(part, depth + 1)) add(merged, name, schema, 'allOf');
    }
    for (const key of ['anyOf', 'oneOf']) {
      const variants = new Map();
      for (const part of Array.isArray(body[key]) ? body[key] : []) {
        for (const [name, schema] of properties(part, depth + 1)) add(variants, name, schema, 'anyOf');
      }
      for (const [name, schema] of variants) add(merged, name, schema, 'allOf');
    }
    return merged;
  };
  // The generation request's body: the one that takes a prompt, or else the
  // first (some models take the prompt inside another field).
  const bodies = Object.values(openapi?.paths || {})
    .map(operations => properties(operations?.post?.requestBody?.content?.['application/json']?.schema))
    .filter(body => body.size);
  const input = bodies.find(body => body.has('prompt')) || bodies[0];
  if (!input) return null;
  // The forms a property can take, each a list of schemas that must all hold:
  // the property's own keywords, every allOf part, and one anyOf or oneOf part.
  const forms = (node, depth = 0) => {
    const schema = resolve(node);
    if (!schema) return [[]];
    let result = [[schema]];
    if (depth >= 8) return result;
    const all = options => { result = result.flatMap(form => options.map(option => [...form, ...option])).slice(0, 64); };
    for (const part of Array.isArray(schema.allOf) ? schema.allOf : []) all(forms(part, depth + 1));
    for (const key of ['anyOf', 'oneOf']) {
      if (Array.isArray(schema[key]) && schema[key].length) all(schema[key].flatMap(part => forms(part, depth + 1)));
    }
    return result;
  };
  const listed = name => {
    const values = new Map();
    for (const form of forms(input.get(name))) for (const value of formValues(form) ?? []) if (!values.has(String(value))) values.set(String(value), value);
    return values.size ? [...values.values()] : null;
  };
  const entry = { inputs: [...input.keys()] };
  // Clip lengths in whole seconds, each with the value the model takes for it:
  // a listed value (6, "6", "6.0" or "8s"; "auto" is not a length), or a
  // second within a range.
  const lengths = new Map();
  for (const value of forms(input.get('duration')).flatMap(form => formValues(form) ?? formSeconds(form))) {
    const match = /^(\d+)(?:\.0+)?\s*s?$/i.exec(String(value).trim());
    const seconds = match ? Number(match[1]) : 0;
    if (seconds > 0 && !lengths.has(seconds)) lengths.set(seconds, value);
  }
  if (lengths.size) {
    entry.supported_durations = [...lengths.keys()].sort((a, b) => a - b);
    entry.encodeDuration = seconds => lengths.get(seconds);
  }
  const aspectRatios = listed('aspect_ratio');
  if (aspectRatios) entry.supported_aspect_ratios = aspectRatios;
  const resolutions = listed('resolution');
  if (resolutions) entry.supported_resolutions = resolutions;
  return entry;
}

// A clip's length as the model takes it, ready to merge into its request.
function clipLength(entry, clip) {
  if (clip.duration === undefined) return {};
  return { duration: entry?.encodeDuration ? entry.encodeDuration(clip.duration) : clip.duration };
}

/**
 * The clips for a video described as scenes, one per scene, each length
 * rounded up to one the model offers. A scene longer than the model's longest
 * clip is refused rather than split: its parts would get the same prompt, and
 * the model would make the same clip twice. Refuses more than `maxSeconds` in
 * total or `maxClips`.
 */
export function planVideoClips(scenes, durations, { maxSeconds = MAX_VIDEO_SECONDS, maxClips = MAX_VIDEO_CLIPS } = {}) {
  if (!durations?.length) {
    throw new Error('This video model does not list the clip lengths it supports, so WebBrain cannot make a video from scenes with it. Generate one clip instead.');
  }
  const longest = durations[durations.length - 1];
  const clips = scenes.map((scene, index) => {
    const prompt = String(scene?.prompt || '').trim();
    if (!prompt) throw new Error(`Scene ${index + 1} needs a prompt.`);
    if (scene.duration > longest) {
      throw new Error(`Scene ${index + 1} is ${scene.duration} s, and this model makes clips of up to ${longest} s. Split it into scenes of up to ${longest} s, each with its own prompt for its part, so no clip repeats another.`);
    }
    return { prompt, duration: durations.find(value => value >= scene.duration) ?? longest };
  });
  const total = clips.reduce((sum, clip) => sum + clip.duration, 0);
  if (clips.length > maxClips) {
    throw new Error(`These scenes need ${clips.length} clips and WebBrain makes at most ${maxClips}. Use fewer, longer scenes.`);
  }
  if (total > maxSeconds) {
    throw new Error(`These scenes come to ${total} s with this model's clip lengths (${durations.join(', ')} s), and WebBrain makes videos up to ${maxSeconds} s. Shorten or merge scenes.`);
  }
  return { clips, total };
}

// What one generate_image call asks a video model for: one clip, or the
// clips of its scenes.
function planVideo(prompt, video, entry) {
  const durations = clipDurations(entry);
  const shape = videoShape(entry, video);
  const scenes = Array.isArray(video?.scenes) ? video.scenes : null;
  if (scenes?.length) {
    if (video.duration !== undefined) throw new Error('With scenes, give each scene its duration instead of duration.');
    if (video.estimated_duration === undefined) {
      throw new Error('With scenes, give estimated_duration: how many seconds the requested video needs before fitting it to the 120 s maximum.');
    }
    const { clips, total } = planVideoClips(scenes, durations);
    return {
      scenes: true,
      total,
      estimated: video.estimated_duration,
      shape,
      // Every clip carries the shared look so the scenes match. No scene
      // numbers: video models draw them on screen as titles.
      clips: clips.map(clip => ({ ...clip, prompt: `${prompt}\n\n${clip.prompt}` })),
    };
  }
  const longest = durations?.[durations.length - 1];
  const wanted = video?.duration ?? video?.estimated_duration;
  if (wanted !== undefined && longest && wanted > longest) {
    throw new Error(`A ${formatSeconds(wanted)} video needs more than one clip: this model makes clips of up to ${longest} s. Describe it as scenes of up to ${longest} s each, ${MAX_VIDEO_SECONDS} s in total, with estimated_duration.`);
  }
  let duration;
  if (video?.duration !== undefined) {
    if (entry?.inputs && !entry.inputs.includes('duration')) throw new Error('This video model does not take duration.');
    if (durations && !durations.includes(video.duration)) {
      throw new Error(`This video model does not make ${video.duration} s clips. Supported: ${durations.join(', ')} s.`);
    }
    duration = video.duration;
  } else if (wanted !== undefined && durations) {
    duration = durations.find(value => value >= wanted) ?? longest;
  }
  return { scenes: false, shape, clips: [{ prompt, ...(duration !== undefined ? { duration } : {}) }] };
}

function videoRequestBody(model, clip, shape) {
  return { model, prompt: clip.prompt, ...(clip.duration !== undefined ? { duration: clip.duration } : {}), ...shape };
}

// Submits one OpenRouter video job, polls it and returns the content response.
async function openRouterVideoJob({ base, headers, request, signal, pollMs, body }) {
  const res = await request(base, { method: 'POST', headers, body: JSON.stringify(body) });
  const queued = await jsonResponse(res, 'OpenRouter video submit');
  if (!/^[A-Za-z0-9_-]+$/.test(queued.id || '')) throw new Error('OpenRouter returned an invalid video job ID.');
  // Construct authenticated paths ourselves; returned URLs cannot select a key recipient.
  const jobUrl = `${base}/${queued.id}`;
  let waitMs = pollDelay(res, pollMs);
  while (true) {
    await delay(waitMs, signal);
    const statusRes = await request(jobUrl, { headers });
    const status = await jsonResponse(statusRes, 'OpenRouter video status');
    waitMs = pollDelay(statusRes, pollMs);
    if (status.status === 'completed') return request(`${jobUrl}/content?index=0`, { headers });
    if (!['pending', 'in_progress'].includes(status.status)) throw new Error(`OpenRouter video generation ${status.status || 'returned an unknown status'}.`);
  }
}

function dataUrlBytes(url) {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url || '');
  if (!match) return null;
  const binary = atob(match[2].replace(/\s+/g, ''));
  return { bytes: Uint8Array.from(binary, char => char.charCodeAt(0)), mime: match[1] };
}

// A failure that trying the clip again would repeat, such as a model that
// makes another format.
const lasting = message => Object.assign(new Error(message), { retry: false });

// A clip that will be joined is kept as bytes, not as a data URL.
async function videoBytes(response, label) {
  const mime = (response.headers?.get?.('Content-Type') || '').split(';')[0].trim();
  if (response.ok && mime === 'video/mp4') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_INLINE_BYTES) throw lasting('A generated clip exceeds the 20 MB inline limit.');
    return bytes;
  }
  const decoded = dataUrlBytes(await mediaResponse(response, label));
  if (decoded?.mime !== 'video/mp4') throw lasting(`${label} did not return an MP4 video.`);
  return decoded.bytes;
}

// A finished clip as MP4 bytes to join: inline media is decoded, a hosted file
// downloaded within the deadline. No key is sent with the download, so
// redirects are allowed.
async function downloadClip(url, { fetchImpl, signal, timeoutMs, label }) {
  let bytes = dataUrlBytes(url)?.bytes;
  if (!bytes) {
    if (!safeMediaUrl(url)) throw lasting(`${label} returned an unsupported media URL.`);
    const operation = operationSignal(signal, timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: operation.signal, credentials: 'omit' });
      if (!res.ok) throw Object.assign(new Error(`${label} clip download failed (HTTP ${res.status}).`), { status: res.status });
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (error) { throw operation.signal.aborted ? operation.signal.reason : error; }
    finally { operation.dispose(); }
  }
  if (bytes.length > MAX_JOINED_VIDEO_BYTES) throw lasting('A generated clip is larger than WebBrain can keep in the chat.');
  if (mp4DurationSeconds(bytes) === null) throw lasting(`${label} did not return an MP4 video.`);
  return bytes;
}

// Runs `task` for each item, `limit` at a time. The first failure stops the
// others; Stop aborts them all with its own reason.
async function mapWithConcurrency(items, limit, signal, task) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !controller.signal.aborted) {
      const index = next++;
      try { results[index] = await task(items[index], index, controller.signal); }
      catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
        throw signal?.aborted ? signal.reason : error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    controller.signal.throwIfAborted();
    return results;
  } finally { signal?.removeEventListener('abort', onAbort); }
}

/**
 * Makes a video with a provider's video model, the same way for every
 * provider: one clip (`single` returns { url }), or the clips of its scenes
 * (`clip` returns each one's MP4 bytes, to be joined), three at a time with
 * one retry each. `entry` is what the model accepts. A video longer than
 * WebBrain makes is generated only if the user agrees on its card.
 */
async function runVideo({ model, entry, text, video, signal, onProgress, confirmVideoLength, single, clip }) {
  const plan = planVideo(text, video, entry);
  if (!plan.scenes) return { ...(await single(plan.clips[0], plan.shape)), model };

  // The user decides on the card whether a shorter version is worth
  // generating, before anything is submitted. The card is outside the
  // generation deadline.
  const lengthDetails = { estimatedSeconds: plan.estimated, totalSeconds: plan.total, clipCount: plan.clips.length, maxSeconds: MAX_VIDEO_SECONDS };
  if (plan.estimated > MAX_VIDEO_SECONDS) {
    const answer = typeof confirmVideoLength === 'function' ? await confirmVideoLength(lengthDetails) : 'unavailable';
    signal?.throwIfAborted?.();
    if (answer !== 'once') return { declined: true, answer: answer || 'cancelled', model, ...lengthDetails };
  }
  onProgress?.(`Generating ${plan.clips.length} video clips…`);
  let ready = 0;
  const clips = await mapWithConcurrency(plan.clips, VIDEO_CLIP_CONCURRENCY, signal, async (item, index, groupSignal) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const bytes = await clip(item, plan.shape, groupSignal);
        ready += 1;
        onProgress?.(`Video clips: ${ready} of ${plan.clips.length} ready`);
        return bytes;
      } catch (error) {
        // One retry per clip; a second failure, Stop or another clip's failure
        // ends the video. A request the provider refused (a 4xx other than a
        // timeout or rate limit, such as no credit left) would fail again, as
        // would a clip in another format.
        const refused = error?.retry === false || (error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
        if (groupSignal.aborted || attempt >= 2 || refused) {
          throw groupSignal.aborted ? (groupSignal.reason ?? error) : new Error(`Clip ${index + 1} of ${plan.clips.length} failed: ${error.message}`);
        }
      }
    }
  });
  return { clips, model, ...lengthDetails };
}

async function runOpenRouter({ text, media, config, video, fetchImpl, signal, timeoutMs, pollMs, onProgress, confirmVideoLength }) {
  const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  // One bounded operation: its own deadline, aborted by Stop as well.
  const bounded = async (parent, task) => {
    const operation = operationSignal(parent, timeoutMs);
    const request = (url, init = {}) => {
      operation.signal.throwIfAborted();
      return fetchImpl(url, { ...init, signal: operation.signal, redirect: 'error', credentials: 'omit' });
    };
    try { return await task(request, operation.signal); }
    catch (error) { throw operation.signal.aborted ? operation.signal.reason : error; }
    finally { operation.dispose(); }
  };
  const base = 'https://openrouter.ai/api/v1/videos';
  const target = await bounded(signal, request => openRouterTarget(config, media, openRouterCatalogs(headers, request)));
  const { model } = target;
  if (target.kind === 'images') {
    return bounded(signal, async request => {
      const res = await request('https://openrouter.ai/api/v1/images', { method: 'POST', headers, body: JSON.stringify({ model, prompt: text }) });
      return { url: await mediaResponse(res, 'OpenRouter generation'), model };
    });
  }
  const job = (request, jobSignal, clip, shape) => openRouterVideoJob({ base, headers, request, signal: jobSignal, pollMs, body: videoRequestBody(model, clip, shape) });
  return runVideo({
    model, entry: target.entry, text, video, signal, onProgress, confirmVideoLength,
    single: (clip, shape) => bounded(signal, async (request, jobSignal) => ({ url: await mediaResponse(await job(request, jobSignal, clip, shape), 'OpenRouter video download') })),
    clip: (clip, shape, groupSignal) => bounded(groupSignal, async (request, jobSignal) => videoBytes(await job(request, jobSignal, clip, shape), 'OpenRouter video download')),
  });
}

// The OpenAPI document of a fal.ai or Comfy Router model, read within the
// generation's deadline (at most 30 s). Null when none is published for it.
async function modelSchema(url, headers, label, fetchImpl, signal, timeoutMs) {
  const operation = operationSignal(signal, Math.min(timeoutMs, 30000));
  try {
    const response = await fetchImpl(url, { headers, signal: operation.signal, redirect: 'error', credentials: 'omit' });
    return response.status === 404 ? null : await jsonResponse(response, label);
  } catch (error) { throw operation.signal.aborted ? operation.signal.reason : error; }
  finally { operation.dispose(); }
}

// What a fal.ai video model accepts ({} when fal.ai publishes no schema for it).
async function falVideoEntry(model, apiKey, fetchImpl, signal, timeoutMs) {
  const query = new URLSearchParams({ endpoint_id: model, expand: 'openapi-3.0' });
  const listing = await modelSchema(`https://api.fal.ai/v1/models?${query}`, { Authorization: `Key ${apiKey}` }, 'fal.ai model schema', fetchImpl, signal, timeoutMs);
  const openapi = (Array.isArray(listing?.models) ? listing.models : []).find(item => item?.endpoint_id === model)?.openapi;
  return videoInputCapabilities(openapi) || {};
}

// What a Comfy Router video model accepts ({} when Comfy Router publishes no schema for it).
async function comfyRouterVideoEntry(model, apiKey, fetchImpl, signal, timeoutMs) {
  const openapi = await modelSchema(`https://api.comfy.org/v2/models/${model}/openapi.json`, { 'X-API-Key': apiKey }, 'Comfy Router model schema', fetchImpl, signal, timeoutMs);
  return videoInputCapabilities(openapi) || {};
}

// The saved model input with the prompt bound into it ({{prompt}}), or added as `prompt`.
function comfyRouterBody(parameters, prompt) {
  return JSON.stringify(parameters).includes('{{prompt}}') ? bindMediaPrompt(parameters, prompt) : { ...parameters, prompt };
}

// Submits one Comfy Router request, polls it and returns its media URL (hosted
// or inline). A failure or Stop before completion cancels the request.
async function comfyRouterJob({ model, apiKey, body, fetchImpl, signal, timeoutMs, pollMs }) {
  const operation = operationSignal(signal, timeoutMs);
  const request = (url, init = {}) => {
    operation.signal.throwIfAborted();
    return fetchImpl(url, { ...init, signal: operation.signal, redirect: 'error', credentials: 'omit' });
  };
  const base = `https://api.comfy.org/v2/models/${model}/requests`;
  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
  let cancelUrl = '';
  let completed = false;
  try {
    const queued = await jsonResponse(await request(base, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body),
    }), 'Comfy Router submit');
    if (!/^[A-Za-z0-9_-]+$/.test(queued.request_id || '')) throw new Error('Comfy Router returned an invalid request ID.');
    // Build authenticated URLs ourselves; never send the key to returned URLs.
    const resultUrl = `${base}/${queued.request_id}`;
    cancelUrl = `${resultUrl}/cancel`;
    let waitMs = pollMs;
    while (true) {
      await delay(waitMs, operation.signal);
      const res = await request(`${resultUrl}/status`, { headers });
      const status = await jsonResponse(res, 'Comfy Router status');
      waitMs = pollDelay(res, pollMs);
      if (status.status === 'COMPLETED') {
        const result = await request(resultUrl, { headers });
        if (result.status === 202) { waitMs = pollDelay(result, pollMs); continue; }
        const url = await mediaResponse(result, 'Comfy Router generation');
        completed = true;
        return url;
      }
      if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new Error('Comfy Router returned an unknown queue status.');
    }
  } catch (error) {
    if (!completed && cancelUrl) await cancelRequest(cancelUrl, { method: 'PUT', headers }, fetchImpl);
    throw operation.signal.aborted ? operation.signal.reason : error;
  } finally { operation.dispose(); }
}

/**
 * Generates one image or video. `media` is 'image' or 'video', choosing the
 * provider's image or video model; video options imply 'video'. Without
 * either, the image model is used (with OpenRouter, a saved image model that
 * is a video model makes a video).
 */
export async function runMediaGeneration({ prompt, config, media = null, video = null, fetchImpl = fetch, signal, timeoutMs = GENERATION_TIMEOUT_MS, pollIntervalMs, onProgress, confirmVideoLength }) {
  const provider = validateMediaConfig(config);
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is required.');
  if (media != null && media !== 'image' && media !== 'video') throw new Error('media must be "image" or "video".');
  if (media === 'image' && video) {
    throw new Error('Video length, aspect ratio, resolution and scenes are for videos. Set media to "video" or leave these out.');
  }
  if (video && provider === 'comfyui') {
    throw new Error('Video length, aspect ratio, resolution and scenes do not work with a local ComfyUI workflow, which sets them itself. Omit them.');
  }
  const kind = media || (video ? 'video' : null);
  const pollMs = pollIntervalMs ?? (provider === 'openrouter' ? 30000 : 2000);
  if (provider === 'openrouter') {
    return runOpenRouter({ text, media: kind, config, video, fetchImpl, signal, timeoutMs, pollMs, onProgress, confirmVideoLength });
  }
  const slot = mediaSlot(config, kind || 'image');
  const { model } = slot;
  const videoRun = { model, text, video, signal, onProgress, confirmVideoLength };
  if (provider === 'fal') {
    const job = (prompt, input, jobSignal) => runFalGeneration({ prompt, config: { ...config, model }, input, fetchImpl, signal: jobSignal, timeoutMs, pollMs });
    if (kind !== 'video') return job(text, {}, signal);
    // The model's schema says what it accepts; a plain clip needs none of it.
    const entry = video ? await falVideoEntry(model, config.apiKey, fetchImpl, signal, timeoutMs) : {};
    return runVideo({
      ...videoRun, entry,
      single: async (clip, shape) => ({ url: (await job(clip.prompt, { ...clipLength(entry, clip), ...shape }, signal)).url }),
      clip: async (clip, shape, groupSignal) => downloadClip((await job(clip.prompt, { ...clipLength(entry, clip), ...shape }, groupSignal)).url,
        { fetchImpl, signal: groupSignal, timeoutMs, label: 'fal.ai' }),
    });
  }
  if (provider === 'comfyrouter') {
    const parameters = parseMediaJson(slot.parameters || '{}', kind === 'video' ? 'Video model input' : 'Image model input');
    // The clip's own length and shape replace those in the saved model input.
    const job = (prompt, input, jobSignal) => comfyRouterJob({ model, apiKey: config.apiKey, body: { ...comfyRouterBody(parameters, prompt), ...input }, fetchImpl, signal: jobSignal, timeoutMs, pollMs });
    if (kind !== 'video') return { url: await job(text, {}, signal), model };
    const entry = video ? await comfyRouterVideoEntry(model, config.apiKey, fetchImpl, signal, timeoutMs) : {};
    return runVideo({
      ...videoRun, entry,
      single: async (clip, shape) => ({ url: await job(clip.prompt, { ...clipLength(entry, clip), ...shape }, signal) }),
      clip: async (clip, shape, groupSignal) => downloadClip(await job(clip.prompt, { ...clipLength(entry, clip), ...shape }, groupSignal),
        { fetchImpl, signal: groupSignal, timeoutMs, label: 'Comfy Router' }),
    });
  }
  const operation = operationSignal(signal, timeoutMs);
  const request = (url, init = {}) => {
    operation.signal.throwIfAborted();
    return fetchImpl(url, { ...init, signal: operation.signal, redirect: 'error', credentials: 'omit' });
  };
  let cancelUrl = '', cancelInit;
  let completed = false;
  try {
    const base = comfyBaseUrl(config.baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    const workflow = bindMediaPrompt(parseMediaJson(slot.workflow, 'ComfyUI workflow'), text);
    const queued = await jsonResponse(await request(`${base}/prompt`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
    }), 'ComfyUI submit');
    if (!/^[A-Za-z0-9_-]+$/.test(queued.prompt_id || '')) throw new Error('ComfyUI returned an invalid prompt ID.');
    // Delete this queued prompt only. /interrupt could stop someone else's running workflow.
    cancelUrl = `${base}/queue`; cancelInit = { method: 'POST', headers, body: JSON.stringify({ delete: [queued.prompt_id] }) };
    while (true) {
      await delay(pollMs, operation.signal);
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

const roundSeconds = seconds => (Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : undefined);

function declinedVideoMessage({ answer, estimatedSeconds, totalSeconds }) {
  const length = `The video needs about ${formatSeconds(estimatedSeconds)}, and WebBrain makes videos up to ${formatSeconds(MAX_VIDEO_SECONDS)}`;
  if (answer === 'deny') return `${length}. The user chose not to generate the ${formatSeconds(totalSeconds)} version, so nothing was generated. Ask what they would like instead.`;
  if (answer === 'unavailable') return `${length}. This run could not ask the user whether a ${formatSeconds(totalSeconds)} version is wanted, so nothing was generated. Tell the user.`;
  return `${length}. The question about a ${formatSeconds(totalSeconds)} version was withdrawn before an answer, so nothing was generated.`;
}

// Joins a video's clips into one stored asset. Clips that cannot be joined
// losslessly are stored one by one and shown in order, and the result says why
// (joinError) so a trace shows it.
async function storeVideoClips(clips, onProgress) {
  let joinError;
  if (clips.length > 1) {
    try {
      onProgress?.(`Joining ${clips.length} clips…`);
      const joined = joinMp4Clips(clips, { maxBytes: MAX_JOINED_VIDEO_BYTES });
      const asset = await storeGeneratedMediaBlob(new Blob([joined.bytes], { type: 'video/mp4' }), { maxBytes: MAX_JOINED_VIDEO_BYTES });
      return { ...asset, durationSeconds: roundSeconds(joined.durationSeconds), clipCount: clips.length };
    } catch (error) {
      if (!(error instanceof VideoJoinError)) throw error;
      joinError = error.message;
    }
  }
  const stored = [];
  for (const bytes of clips) {
    // A clip may be as large as a joined video: hosted clips are downloaded up to that size.
    const asset = await storeGeneratedMediaBlob(new Blob([bytes], { type: 'video/mp4' }), { maxBytes: MAX_JOINED_VIDEO_BYTES });
    stored.push({ mediaId: asset.mediaId, mimeType: asset.mimeType, durationSeconds: roundSeconds(mp4DurationSeconds(bytes)) });
  }
  const durationSeconds = roundSeconds(stored.reduce((sum, clip) => sum + (clip.durationSeconds || 0), 0));
  if (stored.length === 1) return { ...stored[0], inlineMedia: true, durationSeconds, clipCount: 1 };
  return { inlineMedia: true, mimeType: 'video/mp4', clips: stored, clipCount: stored.length, durationSeconds, joined: false, joinError };
}

/**
 * The generate_image tool. `options.onProgress(message)` reports progress of
 * a video made of scenes, and `options.confirmVideoLength(details)` asks the
 * user when the requested video is longer than WebBrain makes ('once' to go
 * ahead; 'deny', 'unavailable' or null otherwise).
 */
export async function generateImage(args, options = {}) {
  const fetchImpl = typeof options === 'function' ? options : options.fetchImpl || fetch;
  try {
    const config = Object.hasOwn(options, 'config') ? options.config : await readMediaConfig();
    if (!config) throw new Error('Configure Generative Media in Providers → Generative.');
    const provider = mediaProvider(config);
    const result = await runMediaGeneration({
      prompt: args?.prompt, media: args?.media ?? null, video: videoArguments(args), config, fetchImpl, signal: options.signal,
      pollIntervalMs: options.pollIntervalMs, onProgress: options.onProgress, confirmVideoLength: options.confirmVideoLength,
    });
    if (result.declined) {
      return { success: false, declined: true, provider, model: result.model, error: declinedVideoMessage(result) };
    }
    if (Array.isArray(result.clips)) {
      return { success: true, model: result.model, provider, ...(await storeVideoClips(result.clips, options.onProgress)) };
    }
    if (result.url.startsWith('data:')) {
      const asset = await storeGeneratedMedia(result.url);
      // A clip's real length, so the agent can say how long the video is.
      const video = asset.mimeType === 'video/mp4' ? dataUrlBytes(result.url) : null;
      const durationSeconds = video ? roundSeconds(mp4DurationSeconds(video.bytes)) : undefined;
      return { success: true, model: result.model, provider, ...asset, ...(durationSeconds ? { durationSeconds } : {}) };
    }
    return { success: true, ...result, provider };
  } catch (error) { return { success: false, error: error.message }; }
}

// Free read-only probes. Model metadata confirms availability; no generation
// is submitted. The result names the image and video models requests will use.
export async function testImageGenProvider(fetchImpl = fetch) {
  const operation = operationSignal(null, 15000);
  const request = (url, init = {}) => fetchImpl(url, { ...init, signal: operation.signal, redirect: 'error', credentials: 'omit' });
  try {
    const config = await readMediaConfig();
    const provider = validateMediaConfig(config);
    const label = MEDIA_PROVIDERS[provider].label;
    const probe = async (url, headers) => {
      const res = await request(url, { headers });
      if (!res.ok) throw new Error(`${label} connection failed (HTTP ${res.status}).`);
      return res;
    };
    if (provider === 'comfyui') {
      const stats = await jsonResponse(await probe(`${comfyBaseUrl(config.baseUrl)}/system_stats`, {}), 'ComfyUI');
      if (!stats.system || !Array.isArray(stats.devices)) throw new Error('The endpoint did not return ComfyUI system information.');
      return { ok: true, model: 'ComfyUI workflow', provider };
    }
    let imageModel = mediaSlot(config, 'image').model;
    let videoModel = mediaSlot(config, 'video').model;
    if (provider === 'fal') {
      await probe(FAL_AUTH_PROBE_URL, { Authorization: `Key ${config.apiKey}` });
    } else if (provider === 'openrouter') {
      const headers = { Authorization: `Bearer ${config.apiKey}` };
      await jsonResponse(await probe('https://openrouter.ai/api/v1/key', headers), 'OpenRouter key');
      const catalog = openRouterCatalogs(headers, request);
      imageModel = (await openRouterTarget(config, 'image', catalog)).model;
      videoModel = (await openRouterTarget(config, 'video', catalog)).model;
    } else {
      for (const model of [imageModel, videoModel]) {
        const detail = await jsonResponse(await probe(`https://api.comfy.org/v2/models/${model}`, { 'X-API-Key': config.apiKey }), 'Comfy Router model');
        if (detail.id !== model) throw new Error(`Comfy Router did not confirm ${model}.`);
      }
    }
    return { ok: true, model: imageModel, imageModel, videoModel, provider };
  } catch (error) { return { ok: false, error: error.message }; }
  finally { operation.dispose(); }
}
