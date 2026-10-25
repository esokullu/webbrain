// Visual target selection with the existing paid-provider and document locks.
// Browser frame IDs, response selectors and callbacks stay inside this adapter.
import { authorizeVisionCapability } from './vision-capabilities.js';
import { detectCaptcha } from './captcha-solver.js';
import { CAPTCHA_SETTINGS_KEYS, getCaptchaProviders } from './captcha-provider-config.js';
import { getCaptchaCapabilities, AWS_WAF_COOKIE_PATHS, buildAwsWafProviderTasks } from './captcha-native-providers.js';
import { observeAwsWafChallengeInPage } from './captcha-frame-runtime.js';
import { applyNativeCaptchaSolution } from './captcha-solution-application.js';

const api = () => globalThis.browser || globalThis.chrome;
const str = maxLength => ({ type: 'string', maxLength });
const number = { type: 'number', minimum: 0 };
const point = { frameId: str(160), x: number, y: number, imageId: str(160) };
const crop = { type: 'object', additionalProperties: false, properties: { x: number, y: number,
  width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, required: ['x', 'y', 'width', 'height'] };
const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', additionalProperties: false, properties, required } } });
export const VISION_CAPTCHA_TOOLS = [
  tool('get_captcha_capabilities', 'List enabled CAPTCHA providers and their supported native methods without keys. Filter by family, then provider/method for the schema.',
    { provider: str(80), family: str(80), method: str(160) }),
  tool('solve_captcha', 'Solve one visually selected CAPTCHA using configured providers. Each call can charge; one attempt per unresolved challenge. automatic uses locally bound widget metadata; image uses only the specified current screenshot crop; native accepts documented provider tasks for this same selected challenge. Answers are retained for application; a provider answer does not prove clearance.',
    { ...point, strategy: { type: 'string', enum: ['automatic', 'image', 'native'] }, crop,
      providerTasks: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'object', additionalProperties: false,
        properties: { provider: str(80), method: str(160), parameters: { type: 'object' } }, required: ['provider', 'method', 'parameters'] } } }, ['frameId', 'x', 'y']),
  tool('apply_captcha_solution', 'Apply the retained answer only to the visually selected challenge through locally verified response fields/callback/cookie bindings. Recognition coordinates remain data: use individual vision_click calls with fresh screenshots, never a batch. Never buy another answer because application failed.',
    { ...point, solutionId: str(160) }, ['frameId', 'x', 'y', 'solutionId']),
];
export const VISION_CAPTCHA_TOOL_NAMES = new Set(VISION_CAPTCHA_TOOLS.map(t => t.function.name));
const fail = (message, code = 'vision_captcha_unavailable') => Object.assign(new Error(message), { code });
async function untilStopped(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return await operation;
  let stop;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    stop = () => reject(signal.reason || new DOMException('Stopped', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  })]); } finally { signal.removeEventListener('abort', stop); }
}
const active = (agent, context) => {
  context.signal?.throwIfAborted();
  if (agent._hasPendingSteering?.(context.tabId)) throw fail('The task changed; no CAPTCHA action dispatched.', 'vision_captcha_task_changed');
};

/** A narrow hit test. It returns widget identifiers, never page prose. */
export function visionCaptchaTargetAtPoint(x, y) {
  let root = document, win = window, element = null;
  const framePath = [];
  for (let depth = 0; depth < 12; depth++) {
    element = root.elementFromPoint(x, y);
    if (!element) return null;
    for (let shadow = 0; element.shadowRoot && shadow < 12; shadow++) {
      const inner = element.shadowRoot.elementFromPoint?.(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    if (!/^(IFRAME|FRAME)$/.test(element.tagName)) break;
    const rect = element.getBoundingClientRect();
    let child;
    try { child = element.contentDocument; } catch {}
    if (!child) break;
    framePath.push(Array.from(win.frames).indexOf(element.contentWindow));
    x -= rect.left + element.clientLeft; y -= rect.top + element.clientTop;
    root = child; win = element.contentWindow;
  }
  const frameUrl = String(win.location.href);
  const elementUrl = /^(IFRAME|FRAME)$/.test(element.tagName) ? String(element.src || '') : '';
  let widget = element;
  for (let depth = 0; widget && depth < 8; depth++, widget = widget.parentElement || widget.getRootNode?.().host) {
    if (widget.hasAttribute?.('data-sitekey')) break;
  }
  let websiteKey = widget?.getAttribute?.('data-sitekey') || '';
  if (!websiteKey && elementUrl) {
    try { const url = new URL(elementUrl); websiteKey = url.searchParams.get('k') || new URLSearchParams(url.hash.slice(1)).get('sitekey') || ''; } catch {}
  }
  const target = widget || element;
  const rect = target.getBoundingClientRect();
  return { frameUrl, elementUrl, framePath, websiteKey: websiteKey.slice(0, 1000),
    timeOrigin: Number(win.performance.timeOrigin), rootTimeOrigin: Number(performance.timeOrigin),
    tag: target.tagName, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
}
async function targetAt(tabId, point) {
  const results = await api().scripting.executeScript({ target: { tabId, frameIds: [0] },
    func: visionCaptchaTargetAtPoint, args: [point.x, point.y], injectImmediately: true });
  const target = results.find(result => result.frameId === 0)?.result;
  if (!target?.frameUrl || !Number.isFinite(target.rootTimeOrigin)) throw fail('No current document is bound to the screenshot point.');
  return target;
}
const targetKey = target => JSON.stringify([target.rootTimeOrigin, target.frameUrl, target.elementUrl, target.framePath, target.websiteKey]);

/** Fixed CAPTCHA field names only. No model selector or callback enters here. */
export function visionCaptchaApplicationBindings(candidate, solutionPaths) {
  if (location.href !== candidate.frameUrl || Number(performance.timeOrigin) !== candidate.documentTimeOrigin) return null;
  const fieldNames = /recaptcha/.test(candidate.type || '') ? ['g-recaptcha-response']
    : candidate.type === 'hcaptcha' ? ['h-captcha-response', 'g-recaptcha-response']
    : candidate.type === 'turnstile' ? ['cf-turnstile-response']
    : /geetest/.test(candidate.type || '') ? ['geetest_challenge', 'geetest_validate', 'geetest_seccode'] : [];
  const fields = [];
  for (const name of fieldNames) {
    const selector = `textarea[name="${name}"],input[name="${name}"]`;
    const found = document.querySelectorAll(selector);
    const path = solutionPaths[name] || solutionPaths.token;
    if (found.length === 1 && path) fields.push({ selector, path });
    else if (found.length > 1) return null;
  }
  let callback;
  const name = candidate.callbackName;
  if (name && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)
      && !name.split('.').some(key => ['__proto__', 'prototype', 'constructor', 'eval', 'Function', 'location'].includes(key))) {
    let owner = window.wrappedJSObject || window;
    for (const key of name.split('.')) owner = owner?.[key];
    if (typeof owner === 'function' && !/\[native code\]/.test(Function.prototype.toString.call(owner))) callback = { name, path: solutionPaths.token || '' };
  }
  return fields.length || callback ? { fields, ...(callback ? { callback } : {}) } : null;
}
function solutionPaths(solution) {
  const paths = {};
  for (const key of ['token', 'gRecaptchaResponse', 'captchaKey', 'response']) if (typeof solution?.[key] === 'string' && solution[key]) { paths.token = key; break; }
  for (const [field, key] of [['geetest_challenge', 'challenge'], ['geetest_validate', 'validate'], ['geetest_seccode', 'seccode']]) {
    if (typeof solution?.[key] === 'string') paths[field] = key;
  }
  return paths;
}
async function applicationFor(tabId, attempt, record) {
  if (record.family === 'aws_waf' && AWS_WAF_COOKIE_PATHS[record.provider]) {
    return { frameId: 0, frameUrl: record.pageUrl, cookies: [{ name: 'aws-waf-token', path: AWS_WAF_COOKIE_PATHS[record.provider] }] };
  }
  const candidate = attempt.candidate;
  if (!candidate || !Number.isInteger(candidate.frameId)) throw fail('This structured answer has no locally verified field binding. Use its recognition data with individual visual actions, or complete it manually. The paid answer remains saved.');
  const results = await api().scripting.executeScript({ target: { tabId, frameIds: [candidate.frameId] }, world: 'MAIN',
    func: visionCaptchaApplicationBindings, args: [candidate, solutionPaths(record.solution)] });
  const bindings = results.find(value => value.frameId === candidate.frameId)?.result;
  if (!bindings) throw fail('No unique current CAPTCHA response field or observed callback is available. The paid answer remains saved; do not solve again.');
  return { frameId: candidate.frameId, frameUrl: candidate.frameUrl, ...bindings };
}

export async function cropVisionCaptcha(dataUrl, rect, frame) {
  if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
      || rect.x + rect.width > frame.canvas.width || rect.y + rect.height > frame.canvas.height) throw fail('CAPTCHA crop must fit inside the current full screenshot canvas.');
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const scaleX = bitmap.width / frame.canvas.width, scaleY = bitmap.height / frame.canvas.height;
    const scale = Math.min(1, 1024 / Math.max(rect.width, rect.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(rect.width * scale)), Math.max(1, Math.round(rect.height * scale)));
    canvas.getContext('2d').drawImage(bitmap, rect.x * scaleX, rect.y * scaleY, rect.width * scaleX, rect.height * scaleY, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (blob.size > 2 * 1024 * 1024) throw fail('CAPTCHA screenshot crop exceeds 2 MiB; select a smaller challenge region.');
    let binary = '';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return { imageBase64: btoa(binary), width: canvas.width, height: canvas.height };
  } finally { bitmap.close(); }
}

export async function runVisionCaptchaTool(agent, context) {
  const { tabId, name, args = {}, browser, frames, state, signal } = context;
  active(agent, context);
  if (name === 'get_captcha_capabilities') {
    const stored = await api().storage.local.get(CAPTCHA_SETTINGS_KEYS);
    active(agent, context);
    return { result: getCaptchaCapabilities(getCaptchaProviders(stored), args), effects: { observe: false, consequential: false } };
  }
  if (!['solve_captcha', 'apply_captcha_solution'].includes(name)) throw fail('Unknown visual CAPTCHA tool.');
  if (!state || !context.checkpoint) throw fail('A durable CAPTCHA attempt journal is required.');
  for (const key of ['selector', 'callback', 'fields', 'cookies', 'clicks', 'frameUrl', 'websiteKey', 'imageBase64']) {
    if (args[key] !== undefined) throw fail('Visual CAPTCHA actions accept screenshot points and documented provider tasks, never browser bindings or arbitrary images.');
  }
  state.attempts ||= {};
  const css = frames.toCssPoint(args);
  const fresh = async () => {
    active(agent, context);
    const capture = await browser.capture(tabId);
    frames.assertViewport(capture.viewport);
    await frames.assertCurrentPixels(capture.dataUrl, capture.viewport, args);
    if (args.crop) await frames.assertCurrentRegions(capture.dataUrl, capture.viewport, { frameId: args.frameId, rects: [args.crop] });
    active(agent, context);
    return capture;
  };
  const captureTarget = () => (context.targetAt || targetAt)(tabId, css);
  const firstCapture = await fresh();
  const target = await captureTarget();
  const key = targetKey(target);
  const save = async () => {
    const saved = await context.checkpoint();
    if (saved === false || saved?.ok === false) throw Object.assign(fail('CAPTCHA state could not be saved; no further action will be dispatched.', 'vision_checkpoint_failed'), { noDispatch: true });
    active(agent, context);
  };
  const assertCurrent = async () => {
    await fresh();
    if (targetKey(await captureTarget()) !== key) throw fail('The selected CAPTCHA changed; observe again.', 'vision_stale_frame');
    active(agent, context);
  };
  const before = async () => {
    // A durable checkpoint can wait while the challenge rotates or navigates.
    // Revalidate pixels and the target after that final awaited reservation.
    if (context.beforeDispatch && await context.beforeDispatch() === false) throw fail('CAPTCHA dispatch was stopped.');
    await assertCurrent();
  };
  const review = await context.verify?.({ kind: name === 'solve_captcha' ? 'captcha_target' : 'captcha_application',
    expected: { point: { x: args.x, y: args.y }, strategy: args.strategy || 'automatic', ...(args.crop ? { crop: args.crop } : {}) }, frame: frames.latest });
  if (review?.verified !== true || review.allowed !== true) throw fail('Independent visual review did not authorize this CAPTCHA target.');

  if (name === 'apply_captcha_solution') {
    const attempt = Object.values(state.attempts).find(value => value.id === args.solutionId);
    if (!attempt || attempt.key !== key || attempt.status !== 'answered') throw fail('No unapplied answer belongs to this current visual challenge. Do not solve again.');
    const record = agent._nativeCaptchaSolutions?.get(tabId);
    if (!record || record.taskId !== attempt.taskId || record.createdAt !== attempt.answerCreatedAt) throw fail('The retained CAPTCHA answer is unavailable or changed.');
    const application = await applicationFor(tabId, attempt, record);
    await authorizeVisionCapability(agent, 'apply_captcha_solution', application, context);
    await before();
    attempt.status = 'applying'; await save();
    // Native application validates document timeOrigin and field/callback binding
    // again before mutation. Guard every asynchronous dispatch boundary as well.
    const native = api();
    const guarded = { ...native,
      scripting: native.scripting && { ...native.scripting, executeScript: async spec => { active(agent, context); return native.scripting.executeScript(spec); } },
      tabs: { ...native.tabs, get: (...args) => native.tabs.get(...args),
        ...(native.tabs.executeScript ? { executeScript: async (...args) => { active(agent, context); return native.tabs.executeScript(...args); } } : {}) },
      cookies: native.cookies && { ...native.cookies, set: async args => { active(agent, context); return native.cookies.set(args); } },
    };
    let result;
    try {
      // Saving the applying receipt is another asynchronous boundary; never
      // apply an answer to pixels or a target checked before that save.
      await assertCurrent();
      result = await applyNativeCaptchaSolution(tabId, record, application, guarded);
      attempt.status = record.applied ? 'applied' : 'answered';
      await save();
    } catch (error) { attempt.status = record.applied ? 'uncertain' : 'answered'; await context.checkpoint(); throw error; }
    return { result: { ...result, dispatched: record.applied === true, solutionId: attempt.id,
      clearance: 'unverified', note: 'Application is not site acceptance. Inspect the next screenshot; never request another paid answer for this unresolved challenge.' }, effects: { observe: true, consequential: true } };
  }

  const prior = state.attempts[key];
  if (prior && prior.status !== 'not_dispatched') throw fail('A solve was already reserved for this challenge. Use the retained answer or ask for manual completion; do not spend again.');
  const strategy = args.strategy || 'automatic';
  let candidate = null, solveArgs;
  if (strategy === 'image') {
    const image = await (context.crop || cropVisionCaptcha)(firstCapture.dataUrl, args.crop, frames.latest);
    solveArgs = { type: 'image_to_text', imageBase64: image.imageBase64, inject: false };
  } else {
    const constraints = target.websiteKey ? { websiteKey: target.websiteKey }
      : target.elementUrl ? { frameUrl: target.elementUrl } : { frameUrl: target.frameUrl };
    const detection = await (context.detectCaptcha || detectCaptcha)(tabId, constraints);
    candidate = detection?.selected || null;
    if (strategy === 'automatic') {
      if (candidate && (target.websiteKey || target.elementUrl)) {
        solveArgs = { type: candidate.type, websiteKey: candidate.websiteKey, frameId: candidate.frameId,
          frameUrl: candidate.frameUrl, framePath: candidate.framePath, inject: false };
      } else {
        // Full-page AWS challenges expose typed challenge inputs in fixed page
        // globals. These remain local; no page prose or generic DOM scan is sent.
        const observed = await api().scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
          injectImmediately: true, func: observeAwsWafChallengeInPage });
        const aws = observed.find(item => item.frameId === 0)?.result;
        const providers = getCaptchaProviders(await api().storage.local.get(CAPTCHA_SETTINGS_KEYS));
        const tasks = aws?.active && aws.pageUrl === firstCapture.viewport.url ? buildAwsWafProviderTasks(providers, aws) : [];
        if (!tasks.length) throw fail('No unique CAPTCHA widget is bound to this point. Select its visible widget or use documented native inputs.');
        solveArgs = { providerTasks: tasks, inject: false }; candidate = null;
      }
    } else if (strategy === 'native') {
      if (!Array.isArray(args.providerTasks) || !args.providerTasks.length) throw fail('Native CAPTCHA solving needs documented providerTasks for this selected challenge.');
      const tasks = structuredClone(args.providerTasks);
      let image;
      for (const task of tasks) {
        for (const field of ['body', 'image', 'images', 'imagesBase64', 'image_data']) {
          if (task.parameters?.[field] === undefined) continue;
          if (!args.crop) throw fail('Native recognition images must come from an explicit current screenshot crop.');
          image ||= await (context.crop || cropVisionCaptcha)(firstCapture.dataUrl, args.crop, frames.latest);
          task.parameters[field] = ['images', 'imagesBase64', 'image_data'].includes(field) ? [image.imageBase64] : image.imageBase64;
        }
        for (const field of ['websiteURL', 'pageurl', 'url']) {
          if (task.parameters?.[field] && ![target.frameUrl, target.elementUrl, firstCapture.viewport.url].includes(task.parameters[field])) throw fail('Native task URL does not match the visually selected challenge.');
        }
        for (const field of ['websiteKey', 'websitekey', 'sitekey']) {
          if (task.parameters?.[field] && target.websiteKey && task.parameters[field] !== target.websiteKey) throw fail('Native task site key conflicts with the selected widget.');
        }
      }
      solveArgs = { providerTasks: tasks, inject: false };
    } else throw fail('Unknown CAPTCHA strategy.');
  }
  await authorizeVisionCapability(agent, 'solve_captcha', solveArgs, context);
  await before();
  const attempt = { id: globalThis.crypto.randomUUID(), key, status: 'reserved', strategy, candidate, createdAt: Date.now() };
  state.attempts[key] = attempt; await save();
  let result;
  try {
    result = await untilStopped(agent.executeTool(tabId, 'solve_captcha', solveArgs, context.onUpdate,
      { visionOnly: true, _contentActionAbortSignal: signal, visionBeforePaidDispatch: before }), signal);
    attempt.status = result?.noDispatch || result?.dispatched === false ? 'not_dispatched' : result?.success ? 'answered' : 'uncertain';
    const record = agent._nativeCaptchaSolutions?.get(tabId);
    if (record?.solution !== undefined) { attempt.taskId = record.taskId; attempt.answerCreatedAt = record.createdAt; }
    await save();
  } catch (error) { attempt.status = 'uncertain'; await context.checkpoint(); throw error; }
  const { token, tokenPreview, selectedFrameId, selectedFramePath, selectedFrameUrl, ...publicResult } = result || {};
  return { result: { ...publicResult, solutionId: attempt.id, clearance: 'unverified',
    ...(strategy === 'image' && token ? { text: token } : {}),
    note: strategy === 'image' ? 'Recognized text is data. Choose its input on a fresh screenshot and use visual typing. Do not solve the same challenge again.'
      : 'The answer is retained. Apply it to the visually selected challenge or use recognition coordinates one visual action at a time. Never execute provider scripts; verify visible clearance afterward.' },
    effects: { observe: true, consequential: true } };
}
