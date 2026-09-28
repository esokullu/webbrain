// CapSolver REST client + page-side detect/inject helpers (Firefox MV2).
//
// Mirror of the Chrome MV3 version, with two differences:
//   1. `browser.*` namespace.
//   2. Page-side helpers use `browser.tabs.executeScript(tabId, {code})`
//      instead of `chrome.scripting.executeScript({func, args})`.
//
// We do not bundle the CapSolver extension. All work goes through:
//   POST /createTask     → { taskId } | { errorId, errorCode, errorDescription }
//   POST /getTaskResult  → { status: "ready"|"processing", solution? }
//   POST /getBalance     → { balance, packages }

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
const DEFAULT_APP_ID = 'B7E57F27-0AD3-434D-A5B7-CF9EE7D093EE';
const CLOUD_BROKER_URL = 'http://127.0.0.1:17373/capsolver/solve';

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

// Wrap a CapSolver error response in a friendlier message. See the chrome
// build's captcha-solver.js for the full rationale — short version: CapSolver
// reuses the same error codes for "I refuse this public TEST/DEMO sitekey"
// and "your task configuration is wrong", so we key off the description and
// give each its own remedy. Matching the demo phrasing loosely is a bug: a
// bare /test/ matches the "test" inside "latest".
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

// We default to the "proxyless" task types so the user doesn't need to BYO
// proxy. `enterprisePayload` is deliberately absent from the solve_captcha
// schema: the frame detector extracts the site-specific Enterprise `s` token
// from the widget host or anchor URL and passes it through internally.

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
      body: rest.body,
      ...(rest.module ? { module: rest.module } : {}),
      ...(rest.case != null ? { case: !!rest.case } : {}),
    };
  }
  throw new Error(`solve_captcha: unsupported type "${type}".`);
}

function solutionFor(type, solution) {
  const t = String(type || '').toLowerCase();
  // Covers every reCAPTCHA spelling — v2/v3, snake or camel, Enterprise or
  // not. They all return the token under the same solution key.
  if (t.startsWith('recaptcha')) {
    return { token: solution.gRecaptchaResponse, fieldName: 'g-recaptcha-response' };
  }
  if (t === 'hcaptcha') {
    return { token: solution.gRecaptchaResponse, fieldName: 'h-captcha-response', alsoSet: 'g-recaptcha-response' };
  }
  if (t === 'turnstile' || t === 'cloudflare' || t === 'cf_turnstile') {
    return { token: solution.token, fieldName: 'cf-turnstile-response' };
  }
  if (t === 'image_to_text' || t === 'image') {
    return { token: solution.text, fieldName: null };
  }
  return { token: null, fieldName: null };
}

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

// ─── Page-side helpers (Firefox MV2 executeScript with code string) ──

export async function detectCaptcha(tabId, constraints = {}) {
  let frames;
  try {
    frames = await browser.webNavigation.getAllFrames({ tabId });
  } catch (_) {
    frames = [{ frameId: 0, url: '' }];
  }
  if (!Array.isArray(frames) || !frames.length) frames = [{ frameId: 0, parentFrameId: -1, url: '' }];
  const matcherOptions = JSON.stringify(captchaChallengeMatcherOptions());
  const code = `(() => {
    const detect = ${detectCaptchaCandidatesInPage.toString()};
    const matcherOptions = ${matcherOptions};
    const direct = detect(null, matcherOptions);
    const inheritedCandidates = [];
    const seenDocuments = new Set();
    const rootDocument = typeof document !== 'undefined' ? document : null;
    const rootWindow = typeof window !== 'undefined' ? window : globalThis;
    const isInheritedOriginFrame = (element, childUrl) => {
      try {
        return element.hasAttribute?.('srcdoc')
          || /^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(childUrl)
          || (!String(element.src || '') && childUrl === 'about:blank');
      } catch (_) {
        return false;
      }
    };
    const visit = (
      currentDocument,
      currentWindow,
      currentResult,
      path,
      ancestorsVisible,
      ancestorsDialogAssociated,
      depth,
    ) => {
      if (!currentDocument || depth > 12 || seenDocuments.has(currentDocument)) return;
      seenDocuments.add(currentDocument);
      const elements = Array.from(currentDocument.querySelectorAll('iframe'));
      const childFrames = Array.isArray(currentResult?.frameContext?.childFrames)
        ? currentResult.frameContext.childFrames
        : [];
      elements.forEach((element, index) => {
        let childDocument;
        let childWindow;
        let childUrl = '';
        try {
          childDocument = element.contentDocument;
          childWindow = element.contentWindow;
          childUrl = String(childWindow?.location?.href || '');
        } catch (_) {
          return;
        }
        if (!childDocument || !childWindow || !isInheritedOriginFrame(element, childUrl)) return;
        const childResult = detect(
          { document: childDocument, window: childWindow },
          matcherOptions,
        );
        const childContext = childResult?.frameContext || {};
        const childVisible = ancestorsVisible && childFrames[index]?.visible === true;
        const childDialogAssociated = ancestorsDialogAssociated
          || childFrames[index]?.dialogAssociated === true;
        const nextPath = [...path, {
          index,
          frameUrl: childContext.frameUrl || childUrl,
          frameName: childContext.frameName || '',
        }];
        for (const candidate of childResult?.candidates || []) {
          inheritedCandidates.push({
            ...candidate,
            framePath: nextPath,
            frameVisibleWithinAnchor: childVisible,
            dialogAssociated: candidate.dialogAssociated === true || childDialogAssociated,
          });
        }
        visit(
          childDocument,
          childWindow,
          childResult,
          nextPath,
          childVisible,
          childDialogAssociated,
          depth + 1,
        );
      });
    };
    visit(rootDocument, rootWindow, direct, [], true, false, 0);
    return { direct, inheritedCandidates };
  })()`;
  const batches = await Promise.all(frames.map(async frame => {
    try {
      const results = await browser.tabs.executeScript(tabId, {
        code,
        frameId: frame.frameId,
        matchAboutBlank: true,
      });
      const response = results?.[0];
      const payload = response?.direct || response;
      const pageCandidates = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.candidates) ? payload.candidates : []);
      const inheritedCandidates = Array.isArray(response?.inheritedCandidates)
        ? response.inheritedCandidates
        : [];
      return {
        directCandidates: pageCandidates.map(candidate => ({
          ...candidate,
          frameId: Number.isInteger(frame.frameId) ? frame.frameId : null,
          frameUrl: candidate.frameUrl || frame.url || '',
        })),
        inheritedCandidates: inheritedCandidates.map(candidate => ({
          ...candidate,
          frameId: Number.isInteger(frame.frameId) ? frame.frameId : null,
          frameUrl: candidate.frameUrl || '',
        })),
        frameContext: !Array.isArray(payload) && payload?.frameContext ? {
          ...payload.frameContext,
          frameId: Number.isInteger(frame.frameId) ? frame.frameId : null,
        } : null,
      };
    } catch (_) {
      return { directCandidates: [], inheritedCandidates: [], frameContext: null };
    }
  }));
  const directCandidates = batches.flatMap(batch => batch.directCandidates);
  const directSignatures = new Set(directCandidates.map(candidate =>
    `${candidate.type || ''}\n${candidate.websiteKey || ''}\n${candidate.frameUrl || ''}`
  ));
  const inheritedCandidates = batches
    .flatMap(batch => batch.inheritedCandidates)
    .filter(candidate => !directSignatures.has(
      `${candidate.type || ''}\n${candidate.websiteKey || ''}\n${candidate.frameUrl || ''}`
    ));
  const candidates = [...directCandidates, ...inheritedCandidates];
  const frameContexts = batches.map(batch => batch.frameContext).filter(Boolean);
  const visibleCandidates = applyCaptchaFrameVisibility(candidates, frameContexts, frames);
  return {
    ...selectCaptchaCandidate(visibleCandidates, constraints),
    diagnostics: buildCaptchaDiagnostics({
      candidates: visibleCandidates,
      frameContexts,
      navigationFrames: frames,
    }),
  };
}

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
  const code = `(() => {
    const inject = ${injectCaptchaTokenInPage.toString()};
    const payload = ${JSON.stringify(pagePayload)};
    let frameDocument = typeof document !== 'undefined' ? document : null;
    let frameWindow = typeof window !== 'undefined' ? window : globalThis;
    for (const segment of Array.isArray(payload?.target?.framePath) ? payload.target.framePath : []) {
      const elements = frameDocument ? Array.from(frameDocument.querySelectorAll('iframe')) : [];
      const element = elements[segment.index];
      if (!element) {
        return {
          success: false,
          fieldUpdated: false,
          staleTarget: true,
          error: 'The selected inherited-origin CAPTCHA frame path is no longer present.',
        };
      }
      try {
        const nextDocument = element.contentDocument;
        const nextWindow = element.contentWindow;
        const nextUrl = String(nextWindow?.location?.href || '');
        const nextName = String(nextWindow?.name || element.name || '');
        if (!nextDocument || !nextWindow
            || (segment.frameUrl && nextUrl !== segment.frameUrl)
            || (segment.frameName && nextName !== segment.frameName)) {
          return {
            success: false,
            fieldUpdated: false,
            staleTarget: true,
            error: 'The selected inherited-origin CAPTCHA frame changed before token injection.',
            frameUrl: nextUrl,
          };
        }
        frameDocument = nextDocument;
        frameWindow = nextWindow;
      } catch (_) {
        return {
          success: false,
          fieldUpdated: false,
          staleTarget: true,
          error: 'The selected inherited-origin CAPTCHA frame is no longer accessible.',
        };
      }
    }
    return inject(payload, { document: frameDocument, window: frameWindow });
  })()`;
  const details = Number.isInteger(target?.frameId)
    ? { code, frameId: target.frameId, matchAboutBlank: true }
    : { code, ...(target?.frameUrl ? { allFrames: true } : {}) };
  const results = await browser.tabs.executeScript(tabId, details);
  const outputs = (results || []).filter(Boolean);
  const successes = outputs.filter(output => output.success === true);
  if (successes.length === 1) {
    return {
      ...successes[0],
      frameId: Number.isInteger(target?.frameId) ? target.frameId : null,
    };
  }
  if (successes.length > 1) {
    return {
      success: false,
      ambiguousTarget: true,
      error: 'Token injection matched more than one frame; pass an exact frameUrl.',
      matchedFrames: successes.map(output => ({ frameUrl: output.frameUrl })),
    };
  }
  return outputs.find(output => !output.skipped)
    || { success: false, error: 'injection script returned no matching frame result' };
}
