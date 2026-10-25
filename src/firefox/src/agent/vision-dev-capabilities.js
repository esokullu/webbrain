const diagnosticBackend = null;
import { authorizeVisionCapability } from './vision-capabilities.js';
import { validateToolArguments } from './tool-arguments.js';
import { readPageSource } from '../network/network-tools.js';

const text = maxLength => ({ type: 'string', maxLength });
const point = { frameId: { type: 'string', minLength: 1 }, imageId: text(160),
  x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } };
const define = (name, description, properties, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
} });
export const VISION_DEV_CAPABILITY_TOOLS = [
  define('read_page_source', 'Explicit Dev diagnosis only: read bounded server HTML source, not rendered page observation. Browser interaction still uses screenshots. Paginate source with offset.', {
    url: text(4096), offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1000, maximum: 7000 },
  }),
  define('inspect_element_styles', 'Explicit Dev diagnosis: inspect computed CSS and box metrics only for a point in the latest screenshot. No tree, selectors or page text.', point, ['frameId', 'x', 'y']),
  define('inspect_event_listeners', 'Explicit Dev diagnosis: inspect bounded event-listener metadata for the current screenshot point. Firefox reports native-listener inspection unavailable; no source/tree fallback.', {
    ...point, eventTypes: { type: 'array', maxItems: 12, items: text(80) },
  }, ['frameId', 'x', 'y']),
  define('patch_element', 'Explicit Dev edit: reversibly patch the visually selected element. Supports CSS declarations, text, className and limited accessibility attributes. Takes a new screenshot afterward. No HTML, scripts or event handlers.', {
    ...point, styles: { type: 'object', additionalProperties: text(1000) }, text: text(12000), className: text(2000),
    attributes: { type: 'object', additionalProperties: { anyOf: [text(2000), { type: 'null' }] } },
  }, ['frameId', 'x', 'y']),
  define('inject_css', 'Explicit Dev edit: apply CSS declarations only to a visually selected target, with a reversible patchId. Arbitrary stylesheet selectors, imports and URL loads are not accepted.', {
    ...point, css: { type: 'string', minLength: 1, maxLength: 12000 },
  }, ['frameId', 'x', 'y', 'css']),
  define('revert_patch', 'Revert a visual element patch in the same live document. Requires the current screenshot; does not replay or recreate an old target.', {
    frameId: { type: 'string', minLength: 1 }, patchId: { type: 'string', minLength: 1, maxLength: 160 },
  }, ['frameId', 'patchId']),
  define('remove_injected_css', 'Undo a target-scoped CSS patch in the same live document, using its returned patchId and the latest screenshot.', {
    frameId: { type: 'string', minLength: 1 }, patchId: { type: 'string', minLength: 1, maxLength: 160 },
  }, ['frameId', 'patchId']),
];
const schemas = new Map(VISION_DEV_CAPABILITY_TOOLS.map(item => [item.function.name, item.function.parameters]));
const api = () => globalThis.browser || globalThis.chrome;
const blocked = error => ({ success: false, noDispatch: true, dispatched: false, error });
const editNames = new Set(['patch_element', 'inject_css', 'revert_patch', 'remove_injected_css']);
export const isVisionDevCapability = name => schemas.has(name);

// Runs only in the extension's isolated world. No model code or selector is
// executed. Target/node ownership and exact old values stay local to this page.
export function visualDevTargetOperation({ operation, point: at, args, patchId, bindingId, expectedUrl, expectedTimeOrigin, expectedViewport }) {
  if (location.href !== expectedUrl || expectedTimeOrigin && String(performance.timeOrigin) !== expectedTimeOrigin)
    return { success: false, noDispatch: true, error: 'The diagnostic document changed.' };
  const v = globalThis.visualViewport;
  const viewport = { width: v?.width || innerWidth, height: v?.height || innerHeight,
    offsetLeft: v?.offsetLeft || 0, offsetTop: v?.offsetTop || 0, scrollX: v?.pageLeft ?? scrollX,
    scrollY: v?.pageTop ?? scrollY, scale: v?.scale || 1, devicePixelRatio };
  if (expectedViewport && Object.keys(viewport).some(key => Math.abs(viewport[key] - Number(expectedViewport[key] ?? (key === 'scale' || key === 'devicePixelRatio' ? 1 : 0))) > .01))
    return { success: false, noDispatch: true, error: 'The diagnostic viewport changed.' };
  const storeKey = '__webbrainVisualDevPatches_v1';
  const patches = globalThis[storeKey] ||= new Map();
  const bindings = globalThis.__webbrainVisualDevBindings_v1 ||= new Map();
  if (operation === '_document_epoch') return { success: true, timeOrigin: String(performance.timeOrigin) };
  if (operation === 'revert_patch' || operation === 'remove_injected_css') {
    const old = patches.get(args.patchId);
    if (!old?.element?.isConnected || old.element.ownerDocument !== document)
      return { success: false, noDispatch: true, error: 'The patch target is no longer in this document.' };
    const el = old.element;
    if (Object.entries(old.afterAttributes).some(([key, value]) => el.getAttribute(key) !== value)
      || old.afterChildren && (el.textContent !== old.afterChildText || el.childNodes.length !== old.afterChildren.length || old.afterChildren.some((node, index) => el.childNodes[index] !== node)))
      return { success: false, noDispatch: true, error: 'The target changed after this patch. Reverting would overwrite newer page or user edits.' };
    for (const [key, value] of Object.entries(old.attributes)) value === null ? el.removeAttribute(key) : el.setAttribute(key, value);
    if (old.children) el.replaceChildren(...old.children);
    patches.delete(args.patchId);
    return { success: true, dispatched: true, removed: true, patchId: args.patchId };
  }
  let el = document.elementFromPoint(at.x, at.y);
  while (el?.shadowRoot?.elementFromPoint) {
    const child = el.shadowRoot.elementFromPoint(at.x, at.y);
    if (!child || child === el) break;
    el = child;
  }
  if (!el || ['IFRAME', 'FRAME'].includes(el.tagName))
    return { success: false, noDispatch: true, error: 'No directly inspectable element at this point. Frame contents require their own supported diagnostic target.' };
  const fingerprint = () => ({ element: el, rect: JSON.stringify(el.getBoundingClientRect().toJSON()),
    attributes: JSON.stringify([...el.attributes].map(attribute => [attribute.name, attribute.value])), text: el.textContent });
  if (operation === '_bind_target') {
    if (bindings.size >= 50) bindings.delete(bindings.keys().next().value);
    bindings.set(bindingId, fingerprint());
    return { success: true, timeOrigin: String(performance.timeOrigin) };
  }
  if (bindingId) {
    const bound = bindings.get(bindingId), now = fingerprint(); bindings.delete(bindingId);
    if (!bound || bound.element !== el || ['rect', 'attributes', 'text'].some(key => now[key] !== bound[key]))
      return { success: false, noDispatch: true, error: 'The visually bound target changed before the diagnostic operation.' };
  }
  if (operation === '_check_target') return { success: true };
  if (operation === 'inspect_element_styles') {
    const style = getComputedStyle(el), box = el.getBoundingClientRect();
    const properties = ['display', 'position', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'box-sizing', 'overflow-x', 'overflow-y', 'font-family', 'font-size', 'font-weight', 'line-height', 'color',
      'background-color', 'opacity', 'z-index', 'align-items', 'justify-content', 'gap', 'grid-template-columns'];
    return { success: true, tag: el.tagName.toLowerCase(), rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      computed: Object.fromEntries(properties.map(key => [key, style.getPropertyValue(key).slice(0, 800)])),
      inlineStyle: (el.getAttribute('style') || '').slice(0, 2000), source: 'visual_target_css' };
  }
  if (patches.size >= 50) return { success: false, noDispatch: true, error: 'Revert an existing patch before creating another.' };
  if (['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'OBJECT', 'EMBED', 'HEAD'].includes(el.tagName))
    return { success: false, noDispatch: true, error: 'Executable, resource-loading and document metadata elements cannot be patched.' };
  if (operation === 'patch_element' && args.styles) {
    const probe = document.createElement('span');
    for (const [name, value] of Object.entries(args.styles)) {
      probe.style.setProperty(name, value);
      if (value && !probe.style.getPropertyValue(name))
        return { success: false, noDispatch: true, error: 'A CSS property or value is invalid in this browser.' };
    }
  }
  const old = { element: el, attributes: {}, children: null };
  const remember = name => { if (!(name in old.attributes)) old.attributes[name] = el.getAttribute(name); };
  try {
  if (operation === 'inject_css' || args.styles) {
    remember('style');
    if (operation === 'inject_css') {
      const probe = document.createElement('span'); probe.style.cssText = args.css;
      if (!probe.style.length) return { success: false, noDispatch: true, error: 'Provide CSS declarations such as color: red; margin: 8px.' };
      for (const name of probe.style) el.style.setProperty(name, probe.style.getPropertyValue(name), probe.style.getPropertyPriority(name));
    } else for (const [name, value] of Object.entries(args.styles)) el.style.setProperty(name, value);
  }
  if (typeof args.className === 'string') { remember('class'); el.setAttribute('class', args.className); }
  for (const [name, value] of Object.entries(args.attributes || {})) {
    remember(name); value === null ? el.removeAttribute(name) : el.setAttribute(name, value);
  }
  if (typeof args.text === 'string') { old.children = [...el.childNodes]; el.textContent = args.text; }
  old.afterAttributes = Object.fromEntries(Object.keys(old.attributes).map(key => [key, el.getAttribute(key)]));
  old.afterChildren = old.children ? [...el.childNodes] : null;
  old.afterChildText = old.children ? el.textContent : null;
  patches.set(patchId, old);
  return { success: true, dispatched: true, patchId, reversible: true, source: 'visual_target_patch' };
  } catch (error) {
    try {
      for (const [key, value] of Object.entries(old.attributes)) value === null ? el.removeAttribute(key) : el.setAttribute(key, value);
      if (old.children) el.replaceChildren(...old.children);
      return { success: false, dispatched: true, reverted: true, error: String(error.message || error).slice(0, 500) };
    } catch { return { success: false, dispatched: true, outcomeUnknown: true, error: 'The visual edit failed and its rollback could not be established.' }; }
  }
}

function validateEdit(name, args) {
  if (name === 'inject_css' && /[{}@\\]|\/\*|(?:url|image-set|-webkit-image-set|image|src|expression)\s*\(|-moz-binding|behavior\s*:/i.test(args.css))
    return 'Only target-scoped CSS declarations without URLs, imports or executable bindings are allowed.';
  if (name === 'patch_element') {
    if (!args.styles && args.text == null && args.className == null && !args.attributes) return 'Provide a bounded element edit.';
    if (Object.keys(args.styles || {}).length > 40 || Object.keys(args.attributes || {}).length > 20) return 'Too many patch properties.';
    for (const [key, value] of Object.entries(args.styles || {})) if (!/^(?:--)?[a-z][a-z0-9-]*$/i.test(key)
      || typeof value !== 'string' || value.length > 1000 || /(?:url|image-set|-webkit-image-set|image|src|expression)\s*\(|-moz-binding|[{}@\\]|\/\*/i.test(key + ':' + value))
      return 'Invalid or unsafe CSS declaration.';
    for (const [key, value] of Object.entries(args.attributes || {})) if (!/^(?:title|role|aria-[a-z-]+)$/.test(key)
      || value !== null && (typeof value !== 'string' || value.length > 2000)) return 'Only bounded title, role and aria-* attributes are supported.';
  }
  return null;
}

export async function runVisionDevCapability(agent, ctx) {
  const { name, args = {}, tabId, frames, browser, signal } = ctx;
  const editing = editNames.has(name);
  const effects = { observe: false, resetFrames: false, consequential: editing };
  if (ctx.mode !== 'dev' || ctx.devAuthorized !== true)
    return { result: blocked('This capability requires an explicit development/debugging task in Dev mode.'), effects };
  const checked = validateToolArguments(name, args, schemas.get(name));
  if (!schemas.has(name) || !checked.ok) return { result: checked.result || blocked('Unknown Dev capability.'), effects };
  const invalid = validateEdit(name, args);
  if (invalid) return { result: blocked(invalid), effects };
  const active = () => {
    signal?.throwIfAborted();
    if (agent._hasPendingSteering?.(tabId)) throw new DOMException('The user changed the task.', 'AbortError');
  };
  const ready = async () => {
    active();
    if (ctx.beforeDispatch && await ctx.beforeDispatch() === false) throw new Error('Dev operation stopped before dispatch.');
    active();
  };
  active();
  if (name === 'read_page_source') {
    const url = args.url || (await browser.readViewport(tabId)).url;
    const requested = { ...args, url, maxChars: Math.min(7000, args.maxChars || 6000) };
    await authorizeVisionCapability(agent, name, requested, ctx); await ready();
    const result = await readPageSource(url, requested, { tabId, signal });
    active();
    return { result, effects };
  }
  // Native listener support is a backend capability, not an invitation to read
  // source, instrument the page or silently substitute a DOM event registry.
  if (name === 'inspect_event_listeners' && !diagnosticBackend)
    return { result: { ...blocked('Native event-listener introspection is unavailable in Firefox; no DOM/source fallback was used.'), available: false }, effects };
  const sourceFrame = frames.latest;
  if (!sourceFrame || sourceFrame.frameId !== args.frameId) return { result: blocked('Use the newest screenshot frameId.'), effects };
  const point = args.x != null ? frames.toCssPoint(args) : null;
  const fresh = async () => {
    active();
    if (frames.latest !== sourceFrame) throw new Error('The reviewed screenshot changed before the Dev operation.');
    frames.assertViewport(await browser.readViewport(tabId)); active();
    if (point) {
      const image = await browser.capture(tabId); active();
      await frames.assertCurrentPixels(image.dataUrl, image.viewport, args);
    }
    if (frames.latest !== sourceFrame) throw new Error('The reviewed screenshot changed before the Dev operation.');
    active();
  };
  const bindingId = `visual-target-${crypto.randomUUID()}`;
  let expectedTimeOrigin;
  const operation = async (operationName, extra = {}) => {
    const entry = await api().scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
      func: visualDevTargetOperation, args: [{ operation: operationName, point, args, bindingId,
        expectedUrl: sourceFrame.viewport.url, expectedTimeOrigin, expectedViewport: sourceFrame.viewport, ...extra }] });
    return entry?.[0]?.result || blocked('The visual diagnostic target did not respond.');
  };
  await authorizeVisionCapability(agent, name, args, ctx);
  await fresh();
  const binding = await operation(point ? '_bind_target' : '_document_epoch');
  if (binding.success !== true) return { result: binding, effects };
  expectedTimeOrigin = binding.timeOrigin;
  if (!expectedTimeOrigin) return { result: blocked('The diagnostic document identity is unavailable.'), effects };
  await fresh();
  if (editing) {
    const verdict = await ctx.verify?.({ kind: 'dev_patch', frame: sourceFrame, expected: { name, args } });
    if (verdict?.verified !== true || verdict.allowed !== true) return { result: blocked('The visual edit is not verified against the user’s development request.'), effects };
  }
  await ready();
  // A model review or permission prompt may take seconds. Recheck pixels and
  // the original frame after those awaits, then compare the bound local target
  // and document epoch inside the same synchronous operation as the mutation.
  await fresh();
  let result;
  if (name === 'inspect_event_listeners') {
    await diagnosticBackend.attach(tabId); await fresh();
    const bound = await operation('_check_target');
    if (bound.success !== true) return { result: bound, effects };
    let documentObjectId, objectId;
    try {
      // Keep executable code fixed. Screenshot metadata and coordinates are
      // protocol values, never interpolated JavaScript, even for hostile URLs.
      const root = await diagnosticBackend.sendCommand(tabId, 'Runtime.evaluate', {
        expression: 'document', objectGroup: 'webbrain-visual-dev', returnByValue: false });
      documentObjectId = root?.result?.objectId;
      if (root.exceptionDetails || !documentObjectId) return { result: blocked('The native diagnostic document is unavailable.'), effects };
      const resolved = await diagnosticBackend.sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId: documentObjectId,
        functionDeclaration: 'function(expectedUrl, expectedTimeOrigin, x, y) { const view = this.defaultView; if (!view || view.location.href !== expectedUrl || String(view.performance.timeOrigin) !== expectedTimeOrigin || !Number.isFinite(x) || !Number.isFinite(y)) return null; let el = this.elementFromPoint(x, y); while (el?.shadowRoot?.elementFromPoint) { const next = el.shadowRoot.elementFromPoint(x, y); if (!next || next === el) break; el = next; } return el; }',
        arguments: [sourceFrame.viewport.url, expectedTimeOrigin, point.x, point.y].map(value => ({ value })),
        objectGroup: 'webbrain-visual-dev', returnByValue: false,
      });
      objectId = resolved?.result?.objectId;
      if (resolved.exceptionDetails) return { result: blocked('The native diagnostic target could not be resolved.'), effects };
      if (!objectId) return { result: blocked('No native diagnostic target at the screenshot point.'), effects };
      const raw = await diagnosticBackend.sendCommand(tabId, 'DOMDebugger.getEventListeners', { objectId, depth: 0, pierce: false });
      await fresh();
      const selected = (raw.listeners || []).filter(item => !args.eventTypes?.length || args.eventTypes.includes(item.type));
      result = { success: true, count: Math.min(selected.length, 30), truncated: selected.length > 30,
        listeners: selected.slice(0, 30).map(item => ({ type: String(item.type).slice(0, 80), useCapture: item.useCapture === true,
          passive: item.passive === true, once: item.once === true, lineNumber: item.lineNumber, columnNumber: item.columnNumber })),
        source: 'visual_target_native_listener_metadata' };
    } finally {
      for (const handle of new Set([objectId, documentObjectId].filter(Boolean)))
        await diagnosticBackend.sendCommand(tabId, 'Runtime.releaseObject', { objectId: handle }).catch(() => {});
    }
  } else {
    const patchId = `visual-patch-${crypto.randomUUID()}`;
    try { result = await operation(name, { patchId }); }
    catch (error) {
      if (!editing) throw error;
      result = { success: false, dispatched: true, outcomeUnknown: true, patchId,
        error: `The native edit reply was lost: ${String(error.message || error).slice(0, 500)}` };
    }
  }
  if (editing && result.noDispatch !== true) {
    effects.observe = true; effects.resetFrames = true;
    // Preserve a completed native receipt even if Stop arrived in flight.
    if (signal?.aborted || agent._hasPendingSteering?.(tabId)) result = { ...result, cancelledAfterDispatch: true };
  } else active();
  return { result, effects };
}
