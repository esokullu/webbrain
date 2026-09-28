// CapSolver REST client + page-side detect/inject helpers.
//
// We do not bundle the CapSolver browser extension. Instead we talk directly
// to https://api.capsolver.com:
//   POST /createTask     → { taskId } | { errorId, errorCode, errorDescription }
//   POST /getTaskResult  → { status: "ready"|"processing", solution? }
//   POST /getBalance     → { balance, packages }
//
// Coverage today: reCAPTCHA v2 (checkbox/invisible), reCAPTCHA v3, both of
// those in their Enterprise flavour, hCaptcha, Cloudflare Turnstile, plain
// image-to-text. Other types CapSolver supports (FunCaptcha, AWS WAF,
// GeeTest, datadome) are not auto-detected here yet — the agent can still
// drive them by passing an explicit `type` to solve_captcha and the right
// `taskTypeOverride`.

import {
  applyCaptchaFrameVisibility,
  captchaWebsiteUrl,
  captchaTypesMatch,
  detectCaptchaCandidatesInPage,
  injectCaptchaTokenInPage,
  normalizeCaptchaType,
  selectCaptchaCandidate,
} from './captcha-frame-runtime.js';
import { buildCaptchaDiagnostics, captchaChallengeMatcherOptions } from './captcha-gate.js';

export { captchaTypesMatch, captchaWebsiteUrl, normalizeCaptchaType, selectCaptchaCandidate };

const API_BASE = 'https://api.capsolver.com';
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 120_000;
const DEFAULT_APP_ID = 'B7E57F27-0AD3-434D-A5B7-CF9EE7D093EE'; // CapSolver public affiliate id; used only to identify the integration.
const CLOUD_BROKER_URL = 'http://127.0.0.1:17373/capsolver/solve';

// ─── REST ──────────────────────────────────────────────────────────────

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CapSolver ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try { return await res.json(); } catch {
    throw new Error(`CapSolver ${path} returned invalid JSON.`);
  }
}

// Wrap a CapSolver error response in a friendlier message.
//
// Two failure classes look nearly identical on the wire but need opposite
// responses from the model, so we key off the *description* rather than the
// error code — CapSolver reuses ERROR_INVALID_TASK_DATA and
// ERROR_WRONG_CAPTCHA_TYPE for both:
//
//   1. Refused sitekey. CapSolver won't farm public TEST/DEMO keys (Google's
//      recaptcha demo, hcaptcha.com/demo) because no genuine token would come
//      back. Description reads like "We don't support this service." The fix
//      is to try the flow on a real production site.
//   2. Bad task configuration. Description reads like "Invalid input: check
//      captcha type or parameters" — you get this when the task type doesn't
//      match the widget, e.g. a plain ReCaptchaV2TaskProxyLess against an
//      Enterprise sitekey. The fix is to correct `type`/`isEnterprise`.
//
// Blaming (2) on a demo key is actively harmful: the model gives up and moves
// to another site instead of retrying with the right task type. Match the
// demo phrasing narrowly for the same reason — an earlier bare /test/ matched
// the "test" inside "latest" and mislabelled ordinary parameter errors.
const CAPSOLVER_TASK_CONFIG_RE = /invalid input|check captcha type|wrong captcha type/i;
const CAPSOLVER_DEMO_KEY_RE = /\btest\s*(?:site\s*)?key\b|\bdemo\b|unsupported|don['’]?t[\s_]support|not[\s_]support/i;

function capsolverError(prefix, body) {
  const desc = body.errorDescription || body.errorCode || 'unknown error';
  if (CAPSOLVER_TASK_CONFIG_RE.test(desc)) {
    return new Error(
      `${prefix}: ${desc}. CapSolver rejected the task configuration, not the sitekey — most often the task type doesn't match the widget (a plain reCAPTCHA task against an Enterprise sitekey, or a v2 task against a v3 key). Re-check the detected type and pass \`type\` / \`isEnterprise\` explicitly.`
    );
  }
  if (CAPSOLVER_DEMO_KEY_RE.test(desc)) {
    return new Error(
      `${prefix}: ${desc}. This usually means CapSolver refused the sitekey — most often because it is a public TEST/DEMO key (Google's recaptcha demo, hcaptcha.com/demo, etc.) that no captcha-solving service will farm. Try the same flow on a real production site.`
    );
  }
  return new Error(`${prefix}: ${desc}`);
}

export async function getBalance(apiKey) {
  if (!apiKey) throw new Error('No CapSolver API key configured.');
  const res = await postJson('/getBalance', { clientKey: apiKey });
  if (!res || typeof res !== 'object') throw new Error('CapSolver getBalance returned unexpected response.');
  if (res.errorId) throw capsolverError('CapSolver', res);
  return { balance: res.balance ?? 0, packages: res.packages || [] };
}

async function createTask(apiKey, task) {
  const res = await postJson('/createTask', {
    clientKey: apiKey,
    appId: DEFAULT_APP_ID,
    task,
  });
  if (!res || typeof res !== 'object') throw new Error('CapSolver createTask returned unexpected response.');
  if (res.errorId) throw capsolverError('CapSolver createTask', res);
  if (!res.taskId) throw new Error('CapSolver createTask returned no taskId.');
  return res.taskId;
}

async function pollTaskResult(apiKey, taskId, { timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const effectiveTimeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : POLL_TIMEOUT_MS;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    const res = await postJson('/getTaskResult', { clientKey: apiKey, taskId });
    if (!res || typeof res !== 'object') throw new Error('CapSolver getTaskResult returned unexpected response.');
    if (res.errorId) throw capsolverError('CapSolver getTaskResult', res);
    if (res.status === 'ready') return res.solution || {};
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`CapSolver: timed out after ${Math.round(timeoutMs / 1000)}s waiting for solution.`);
}

// ─── Task builders ─────────────────────────────────────────────────────
//
// Each builder takes the params the agent / detector gathered from the page
// and returns the task object CapSolver's createTask endpoint expects. We
// default to the "proxyless" task types so the user doesn't need to BYO
// proxy — that's the simplest path and what virtually every reCAPTCHA /
// hCaptcha / Turnstile setup actually needs.
//
// `enterprisePayload` is deliberately absent from the solve_captcha schema
// (same as on the hCaptcha branch): the frame detector extracts the
// site-specific Enterprise `s` token from the widget host or anchor URL and
// passes it through internally.

// Type aliases the model or the detector may hand us. Kept as sets rather
// than inline `||` chains so buildTask and captchaParamError below can't
// drift apart on which spellings count as v3.
const RECAPTCHA_V2_TYPES = new Set(['recaptcha_v2', 'recaptchav2', 'recaptcha_v2_enterprise', 'recaptcha_enterprise']);
const RECAPTCHA_V3_TYPES = new Set(['recaptcha_v3', 'recaptchav3', 'recaptcha_v3_enterprise']);

// Validate the params CapSolver would reject before we spend a request on
// them. Exported so agent.js can run it *before* it flags the tool call as
// dispatched — a missing pageAction is a local argument error, not an
// external side effect. Returns an error string, or null when the params
// are usable.
export function captchaParamError(params) {
  const t = String(params?.type || '').toLowerCase();
  if (!t) return 'solve_captcha: type is required.';
  if (RECAPTCHA_V3_TYPES.has(t) && !(params.pageAction || params.action)) {
    return `solve_captcha: ${params.type} requires a \`pageAction\` (e.g. "login", "submit"). reCAPTCHA v3 scores the action name, so CapSolver cannot mint a usable token without it — pass \`pageAction\` explicitly.`;
  }
  return null;
}

export function buildTask({ type, websiteURL, websiteKey, ...rest }) {
  const t = String(type || '').toLowerCase();
  const isEnterprise = !!rest.isEnterprise || t.includes('enterprise');
  if (RECAPTCHA_V2_TYPES.has(t)) {
    return {
      type: isEnterprise ? 'ReCaptchaV2EnterpriseTaskProxyLess' : 'ReCaptchaV2TaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.isInvisible != null ? { isInvisible: !!rest.isInvisible } : {}),
      ...(rest.pageAction ? { pageAction: rest.pageAction } : {}),
      ...(rest.recaptchaDataSValue ? { recaptchaDataSValue: rest.recaptchaDataSValue } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
      ...(rest.userAgent ? { userAgent: rest.userAgent } : {}),
    };
  }
  if (RECAPTCHA_V3_TYPES.has(t)) {
    const pageAction = rest.pageAction || rest.action;
    return {
      type: isEnterprise ? 'ReCaptchaV3EnterpriseTaskProxyLess' : 'ReCaptchaV3TaskProxyLess',
      websiteURL,
      websiteKey,
      pageAction,
      ...(rest.minScore ? { minScore: rest.minScore } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
    };
  }
  if (t === 'hcaptcha') {
    return {
      type: 'HCaptchaTaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.isInvisible != null ? { isInvisible: !!rest.isInvisible } : {}),
      ...(rest.enterprisePayload ? { enterprisePayload: rest.enterprisePayload } : {}),
      ...(rest.userAgent ? { userAgent: rest.userAgent } : {}),
    };
  }
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL,
      websiteKey,
      ...(rest.metadata ? { metadata: rest.metadata } : {}),
    };
  }
  if (t === 'image_to_text' || t === 'image') {
    return {
      type: 'ImageToTextTask',
      body: rest.body, // base64 png/jpg, no data: prefix
      ...(rest.module ? { module: rest.module } : {}),
      ...(rest.case != null ? { case: !!rest.case } : {}),
    };
  }
  throw new Error(`solve_captcha: unsupported type "${type}".`);
}

// Pick the right token-field name + injection strategy for each captcha
// type. The DOM convention is well-documented for the ones we auto-handle.
function solutionFor(type, solution) {
  const t = String(type || '').toLowerCase();
  // Covers every reCAPTCHA spelling — v2/v3, snake or camel, Enterprise or
  // not. They all return the token under the same solution key and inject
  // into the same field.
  if (t.startsWith('recaptcha')) {
    return { token: solution.gRecaptchaResponse, fieldName: 'g-recaptcha-response' };
  }
  if (t === 'hcaptcha') {
    // Both names exist in the wild — old hCaptcha forms use h-captcha-response,
    // some sites still listen on g-recaptcha-response for hCaptcha drop-ins.
    return { token: solution.gRecaptchaResponse, fieldName: 'h-captcha-response', alsoSet: 'g-recaptcha-response' };
  }
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return { token: solution.token, fieldName: 'cf-turnstile-response' };
  }
  if (t === 'image_to_text' || t === 'image') {
    return { token: solution.text, fieldName: null }; // caller types it in
  }
  return { token: null, fieldName: null };
}

// ─── solveCaptcha — the public entry point ────────────────────────────

async function solveWithCloudBroker(task) {
  const response = await fetch(CLOUD_BROKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebBrain-CapSolver-Broker': '1' },
    body: JSON.stringify({ task }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Cloud CapSolver broker failed.');
  if (!result.taskId || !result.solution || typeof result.solution !== 'object') {
    throw new Error('Cloud CapSolver broker returned an invalid result.');
  }
  return result;
}

export async function solveCaptcha(apiKey, params, { useCloudBroker = false } = {}) {
  if (!apiKey && !useCloudBroker) throw new Error('No CapSolver API key configured.');
  const paramError = captchaParamError(params);
  if (paramError) throw new Error(paramError);
  const task = buildTask(params);
  const { taskId, solution } = useCloudBroker
    ? await solveWithCloudBroker(task)
    : await (async () => {
      const taskId = await createTask(apiKey, task);
      return { taskId, solution: await pollTaskResult(apiKey, taskId) };
    })();
  const meta = solutionFor(params.type, solution);
  return { taskId, solution, ...meta };
}

// ─── Page-side detection ───────────────────────────────────────────────
//
// Runs the self-contained detector in every frame, then ranks the returned
// candidates centrally. Keeping each candidate bound to the frame that
// exposed it lets the caller use the correct websiteURL and injection target.

export async function detectCaptcha(tabId, constraints = {}) {
  const frameTreePromise = typeof chrome.webNavigation?.getAllFrames === 'function'
    ? chrome.webNavigation.getAllFrames({ tabId })
    : Promise.resolve([]);
  const [scriptAttempt, frameTreeAttempt] = await Promise.allSettled([
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: detectCaptchaCandidatesInPage,
      args: [null, captchaChallengeMatcherOptions()],
    }),
    frameTreePromise,
  ]);
  const navigationFrames = frameTreeAttempt.status === 'fulfilled'
    ? frameTreeAttempt.value
    : [];
  if (scriptAttempt.status === 'rejected') {
    const cause = scriptAttempt.reason;
    const error = new Error(
      cause instanceof Error
        ? cause.message
        : String(cause || 'CAPTCHA frame inspection failed.'),
    );
    if (cause instanceof Error) error.cause = cause;
    error.captchaDiagnostics = buildCaptchaDiagnostics({ navigationFrames });
    throw error;
  }
  const results = scriptAttempt.value;
  const candidates = [];
  const frameContexts = [];
  for (const entry of results || []) {
    const payload = entry?.result;
    const pageCandidates = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.candidates) ? payload.candidates : []);
    for (const candidate of pageCandidates) {
      candidates.push({
        ...candidate,
        frameId: Number.isInteger(entry.frameId) ? entry.frameId : null,
      });
    }
    if (!Array.isArray(payload) && payload?.frameContext) {
      frameContexts.push({
        ...payload.frameContext,
        frameId: Number.isInteger(entry.frameId) ? entry.frameId : null,
      });
    }
  }
  const visibleCandidates = applyCaptchaFrameVisibility(candidates, frameContexts, navigationFrames);
  return {
    ...selectCaptchaCandidate(visibleCandidates, constraints),
    diagnostics: buildCaptchaDiagnostics({
      candidates: visibleCandidates,
      frameContexts,
      navigationFrames,
    }),
  };
}

// ─── Token injection ───────────────────────────────────────────────────

export async function injectToken(tabId, {
  fieldName,
  alsoSet,
  token,
  callbackHint,
  target = null,
}) {
  if (!fieldName || !token) return { success: false, error: 'fieldName and token required' };
  if (!Number.isInteger(target?.frameId) || !target?.frameUrl || !target?.websiteKey) {
    return {
      success: false,
      fieldUpdated: false,
      targetRequired: true,
      error: 'Token was not injected because no detected CAPTCHA frame identity, URL, and site key were selected.',
    };
  }
  const pagePayload = {
    fieldName,
    alsoSet,
    token,
    callbackHint,
    target: target || {},
  };
  const targetSpec = Number.isInteger(target?.frameId)
    ? { tabId, frameIds: [target.frameId] }
    : (target?.frameUrl ? { tabId, allFrames: true } : { tabId });
  const results = await chrome.scripting.executeScript({
    target: targetSpec,
    world: 'MAIN',
    args: [pagePayload],
    func: injectCaptchaTokenInPage,
  });
  const outputs = (results || []).map(entry => ({
    ...(entry?.result || {}),
    frameId: Number.isInteger(entry?.frameId) ? entry.frameId : null,
  }));
  const successes = outputs.filter(output => output.success === true);
  if (successes.length === 1) return successes[0];
  if (successes.length > 1) {
    return {
      success: false,
      ambiguousTarget: true,
      error: 'Token injection matched more than one frame; pass an exact frameUrl.',
      matchedFrames: successes.map(output => ({ frameId: output.frameId, frameUrl: output.frameUrl })),
    };
  }
  return outputs.find(output => !output.skipped)
    || { success: false, error: 'injection script returned no matching frame result' };
}
