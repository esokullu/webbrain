// Lean mode: Settings → General → "Lean mode" ('auto' | 'on' | 'off').
//
// A strong model does not need WebBrain's verification scaffolding: the
// extra tools, readbacks, completion judges and forced re-check turns that
// help small local models slow it down and can strand a run that was going
// fine. Lean mode gives an Act run a thin tool list and a short prompt and
// skips every guard of class `quality` (guard-policy.js). The hard classes,
// permission gates, host checks, budgets and user control stay.
//
// This module decides when Auto turns lean mode on. It is shared verbatim by
// the Chrome and Firefox builds (test/lean-mode.mjs checks that).

import { guardEntry } from './guard-policy.js';

export const LEAN_MODE_SETTINGS = Object.freeze(['auto', 'on', 'off']);
export const DEFAULT_LEAN_MODE = 'auto';

export function normalizeLeanModeSetting(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return LEAN_MODE_SETTINGS.includes(text) ? text : DEFAULT_LEAN_MODE;
}

// Strong models, by model id. A model id is matched in lower case anywhere in
// the string, so router ids ("anthropic/claude-sonnet-4.5"), Bedrock ids
// ("us.anthropic.claude-opus-4-1-...") and dated snapshots all match. `min` is
// the lowest generation that counts; `exclude` drops small variants. Keep
// this list short and add families as they prove themselves.
export const LEAN_STRONG_MODEL_RULES = Object.freeze([
  // Claude Opus and Sonnet, generation 4 and later, and the Mythos-tier
  // Fable and Mythos models.
  Object.freeze({ family: 'claude', pattern: /claude-(?:opus|sonnet|fable|mythos)-(\d+)/, min: 4 }),
  Object.freeze({ family: 'claude', pattern: /claude-(\d+)(?:[.-]\d+)?-(?:opus|sonnet|fable|mythos)/, min: 4 }),
  // GPT-5 and later, gpt-6 variants included. Nano models are small.
  Object.freeze({ family: 'gpt', pattern: /(?:^|[^a-z])gpt-(\d+)/, min: 5, exclude: /nano/ }),
  // OpenAI o3/o4 reasoning models and later o-series.
  Object.freeze({ family: 'openai-reasoning', pattern: /(?:^|[/.:])o(\d+)(?:-|$)/, min: 3 }),
  // Gemini 2.5 Pro and newer Pro or Ultra models.
  Object.freeze({ family: 'gemini', pattern: /gemini-(\d+(?:\.\d+)?)-(?:pro|ultra)/, min: 2.5 }),
  // Grok 4 and later.
  Object.freeze({ family: 'grok', pattern: /grok-(\d+)/, min: 4 }),
]);

/** The strong-model family a model id belongs to, or '' when it is not listed. */
export function strongModelFamily(modelId) {
  const id = String(modelId ?? '').trim().toLowerCase();
  if (!id) return '';
  for (const rule of LEAN_STRONG_MODEL_RULES) {
    const match = rule.pattern.exec(id);
    if (!match || Number(match[1]) < rule.min) continue;
    if (rule.exclude && rule.exclude.test(id)) continue;
    return rule.family;
  }
  return '';
}

// Providers that run on the user's machine or in the browser. Auto never
// turns lean mode on for them, whatever model they serve.
const LOCAL_PROVIDER_TYPES = Object.freeze(['llamacpp', 'webgpu']);
const LOCAL_PROVIDER_ID = /^(?:llamacpp|ollama|lmstudio|webgpu)(?:$|[_-])/;

/**
 * What Auto needs to know about a provider. Accepts a provider instance (its
 * `config` and `promptTier`) or a plain description for tests and tools.
 */
export function leanProviderInfo(provider) {
  const config = provider?.config && typeof provider.config === 'object' ? provider.config : provider || {};
  const category = String(config.category ?? provider?.category ?? '').toLowerCase();
  const type = String(config.type ?? provider?.type ?? '').toLowerCase();
  const providerId = String(config._providerId ?? provider?.providerId ?? '').toLowerCase();
  const model = String(config.model ?? provider?.model ?? '');
  let promptTier = '';
  try { promptTier = String(provider?.promptTier ?? config.promptTier ?? '').toLowerCase(); } catch {}
  const local = category === 'local' || LOCAL_PROVIDER_TYPES.includes(type) || LOCAL_PROVIDER_ID.test(providerId);
  const cloud = !local && (category === 'cloud' || category === 'router');
  return { category, type, providerId, model, promptTier, local, cloud };
}

/**
 * Whether lean mode applies to a run. Lean mode is an Act-mode setting; Ask
 * and Dev keep their own behavior. 'on' and 'off' are the user's choice.
 * 'auto' needs a cloud provider (not llama.cpp, Ollama, LM Studio, WebGPU or
 * any other local provider) serving a listed strong model, and the
 * provider's prompt tier vetoes it: a provider the user set to the Compact or
 * Mid tier is never lean under Auto.
 * Returns { active, setting, reason, family? }.
 */
export function resolveLeanMode(setting, { mode = 'act', provider = null } = {}) {
  const value = normalizeLeanModeSetting(setting);
  if (mode !== 'act') return { active: false, setting: value, reason: 'not_act_mode' };
  if (value === 'on') return { active: true, setting: value, reason: 'setting_on' };
  if (value === 'off') return { active: false, setting: value, reason: 'setting_off' };
  const info = leanProviderInfo(provider);
  if (info.local) return { active: false, setting: value, reason: 'local_provider' };
  if (!info.cloud) return { active: false, setting: value, reason: 'unknown_provider' };
  if (info.promptTier === 'compact' || info.promptTier === 'mid') {
    return { active: false, setting: value, reason: 'prompt_tier' };
  }
  const family = strongModelFamily(info.model);
  if (!family) return { active: false, setting: value, reason: 'model_not_listed' };
  return { active: true, setting: value, reason: 'strong_cloud_model', family };
}

// Quality guards that keep running in lean mode, with the reason. Each one
// produces evidence a hard check consumes, or protects a step a hard check
// relies on; skipping it would weaken that hard check. Ids the agent never
// consults through the guard helpers keep their behavior anyway; they are
// listed so the docs and tests name every exception.
export const LEAN_KEPT_QUALITY_GUARDS = Object.freeze({
  'owned-native-chat-read-repair': 'The recipient guard needs WebBrain\'s own exact read of the latest messages before a reply is sent.',
  'chat-send-evidence-unavailable': 'A send whose conversation or message baseline cannot be observed cannot be checked for the right recipient or a duplicate.',
  'recipient-draft-evidence-unavailable': 'The recipient guard reads the draft body and the message baseline to verify a send.',
  'recipient-guard-target-preparation': 'It runs inside the recipient guard\'s own target resolution.',
  'preparation-timeout-action-pipeline': 'The same deadline covers the publication audit, chat-send preparation and the task-attempt checkpoint.',
  'social-publication-draft-quality': 'The publication audit judges the observed composer draft; a draft it cannot observe cannot be audited.',
  'steer-prior-submission-target-unresolved': 'After a correction, an unidentified submit control may repeat an earlier submission.',
  'captcha-solve-detection-binding': 'It keeps a paid CAPTCHA solve from going to the wrong widget.',
  'set-field-bundled-submit-outcome': 'set_field never sends its bundled Enter for a value it could not verify (content script).',
  'clickax-native-button-preparation': 'Its vetoes include a person acting in the tab and a change of task owner (host checks).',
  'clickax-trusted-retry-vetoes': 'It stops WebBrain\'s own automatic re-click from acting twice.',
  'action-no-progress-classification': 'It feeds the loop detector, a budget.',
  'terminal-recovery-no-success': 'It is the ending of the step-limit and observation budgets.',
});

/** True when lean mode skips guard `id`: a registered quality guard that is not kept. */
export function leanSkipsGuard(id) {
  const entry = guardEntry(id);
  return entry?.class === 'quality' && !Object.hasOwn(LEAN_KEPT_QUALITY_GUARDS, String(id));
}
