import { createVisionTransport } from './vision-transport.js';
export { isTransientVisionCaptureError } from './vision-transport.js';

// This layer only observes viewport geometry and sends native input. Page
// semantics, selectors, accessibility nodes and synthetic DOM events are not
// part of its contract. All model coordinates belong to one retained frame.
export const VISION_VIEWPORT_EXPRESSION = `(() => {
  const v = globalThis.visualViewport;
  return { width: v?.width || innerWidth, height: v?.height || innerHeight,
    offsetLeft: v?.offsetLeft || 0, offsetTop: v?.offsetTop || 0,
    scrollX: v?.pageLeft ?? scrollX, scrollY: v?.pageTop ?? scrollY,
    scale: v?.scale || 1, devicePixelRatio: devicePixelRatio || 1,
    url: location.href, documentId: String(performance.timeOrigin),
    platform: navigator.platform || '' };
})()`;

const GEOMETRY_KEYS = ['width', 'height', 'offsetLeft', 'offsetTop', 'scrollX', 'scrollY', 'scale', 'zoom', 'devicePixelRatio'];
export function sameVisionViewport(before, after) {
  if (!before || !after) return false;
  if (before.url !== after.url || before.documentId !== after.documentId) return false;
  return GEOMETRY_KEYS.every(key => Math.abs(Number(before[key] ?? (['scale', 'zoom', 'devicePixelRatio'].includes(key) ? 1 : 0))
    - Number(after[key] ?? (['scale', 'zoom', 'devicePixelRatio'].includes(key) ? 1 : 0))) < 0.01);
}

function failure(message, code = 'vision_invalid_action') {
  return Object.assign(new Error(message), { code });
}
function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Vision action stopped'), { name: 'AbortError', code: 'vision_aborted' });
}

const MODIFIERS = {
  Alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, bit: 1 },
  Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, bit: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, bit: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, bit: 8 },
};
const KEYS = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8],
  Delete: ['Delete', 46], Insert: ['Insert', 45], Home: ['Home', 36], End: ['End', 35],
  PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Space: ['Space', 32, ' '],
};
const ALIASES = { ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta',
  option: 'Alt', alt: 'Alt', shift: 'Shift', esc: 'Escape', return: 'Enter', spacebar: 'Space',
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', del: 'Delete' };
export function visionKeyChord(value, platform = '') {
  if (typeof value !== 'string' || !value || value.length > 100) throw failure('A key or key chord is required');
  const parts = value === '+' ? ['+'] : value.split('+').map(part => part.trim());
  const normalized = parts.map(part => {
    if (/^(controlormeta|mod)$/i.test(part)) return /mac/i.test(platform) ? 'Meta' : 'Control';
    return ALIASES[part.toLowerCase()] || Object.keys({ ...MODIFIERS, ...KEYS }).find(key => key.toLowerCase() === part.toLowerCase()) || part;
  });
  const modifierKeys = normalized.slice(0, -1);
  if (!modifierKeys.every(key => MODIFIERS[key]) || new Set(modifierKeys).size !== modifierKeys.length)
    throw failure('Invalid modifier chord');
  const name = normalized.at(-1);
  let key;
  if (MODIFIERS[name]) key = { ...MODIFIERS[name] };
  else if (KEYS[name]) {
    const [code, windowsVirtualKeyCode, text] = KEYS[name];
    key = { key: name === 'Space' ? ' ' : name, code, windowsVirtualKeyCode, ...(text ? { text } : {}) };
  } else if (/^F(?:[1-9]|1[0-2])$/i.test(name)) {
    key = { key: name.toUpperCase(), code: name.toUpperCase(), windowsVirtualKeyCode: 111 + Number(name.slice(1)) };
  } else if ([...name].length === 1) {
    const letter = /^[a-z]$/i.test(name);
    const digit = /^\d$/.test(name);
    key = { key: name, text: name, code: letter ? `Key${name.toUpperCase()}` : digit ? `Digit${name}` : '',
      windowsVirtualKeyCode: letter || digit ? name.toUpperCase().charCodeAt(0) : 0 };
  } else throw failure(`Unsupported key: ${name}`);
  return { modifiers: modifierKeys.map(name => ({ ...MODIFIERS[name] })), key };
}

export class VisionBrowser {
  constructor({ transport, redact, shouldRedact, signal, beforeDispatch, withCapture } = {}) {
    this.transport = transport || createVisionTransport({ signal, viewportExpression: VISION_VIEWPORT_EXPRESSION });
    this.redact = redact;
    this.shouldRedact = shouldRedact || (() => Boolean(this.redact));
    this.signal = signal;
    this.beforeDispatch = beforeDispatch;
    this.withCapture = withCapture || ((_tabId, capture) => capture());
    this.capturing = new Set();
    this.acting = new Set();
  }
  async readViewport(tabId) {
    checkAbort(this.signal);
    const viewport = await this.transport.readViewport(tabId);
    checkAbort(this.signal);
    if (!(Number.isFinite(viewport?.width) && viewport.width > 0 && Number.isFinite(viewport?.height) && viewport.height > 0)
      || !viewport.documentId || typeof viewport.url !== 'string') throw failure('Browser viewport metadata is not ready', 'vision_capture_not_ready');
    return viewport;
  }
  async capture(tabId) {
    if (this.capturing.has(tabId)) throw failure('A screenshot capture is already in progress', 'vision_capture_busy');
    this.capturing.add(tabId);
    try {
      return await this.withCapture(tabId, async () => {
        const before = await this.readViewport(tabId);
        let dataUrl = await this.transport.capture(tabId, before);
        const after = await this.readViewport(tabId);
        if (!sameVisionViewport(before, after)) throw failure('Page changed during screenshot capture; capture again', 'vision_stale_frame');
        if (this.redact && this.shouldRedact(tabId)) {
          dataUrl = await this.redact(tabId, dataUrl, before);
          if (!sameVisionViewport(before, await this.readViewport(tabId)))
            throw failure('Page changed while finalizing screenshot; capture again', 'vision_stale_frame');
        }
        checkAbort(this.signal);
        if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/.test(dataUrl))
          throw failure('Screenshot capture returned no supported image', 'vision_capture_failed');
        return { dataUrl, viewport: before };
      });
    } finally { this.capturing.delete(tabId); }
  }
  async perform(tabId, action, args = {}, frameSession) {
    let dispatched = false;
    if (this.acting.has(tabId)) return { success: false, dispatched: false, noDispatch: true, error: 'Vision input is already in progress', code: 'vision_action_busy' };
    this.acting.add(tabId);
    const heldKeys = [];
    let heldMouse = null;
    let viewport;
    const send = async (method, params, release = false, onSending) => {
      if (!release) {
        checkAbort(this.signal);
        await this.beforeDispatch?.(tabId, action, args);
        checkAbort(this.signal);
        const current = await this.readViewport(tabId);
        frameSession.assertViewport(current);
        if (!sameVisionViewport(viewport, current)) throw failure('Page changed before native input; capture again', 'vision_stale_frame');
        checkAbort(this.signal);
      }
      // Mark the transport boundary before awaiting a reply: a lost reply must
      // never make an already delivered click/text automatically retryable.
      const previousDispatch = dispatched;
      dispatched = true;
      onSending?.();
      try { return await this.transport.sendInput(tabId, method, params, { viewport, release }); }
      catch (error) {
        if (!previousDispatch && error?.dispatchState?.noDispatch === true) dispatched = false;
        throw error;
      }
    };
    const keyChord = async value => {
      const chord = visionKeyChord(value, viewport.platform);
      let bits = 0;
      try {
        for (const modifier of chord.modifiers) {
          bits |= modifier.bit;
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: modifier.key, code: modifier.code,
            windowsVirtualKeyCode: modifier.windowsVirtualKeyCode, modifiers: bits }, false,
          () => heldKeys.push({ ...modifier, modifiers: bits }));
        }
        const { bit, text, ...key } = chord.key;
        const printable = text && !(bits & (1 | 2 | 4));
        await send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...key, modifiers: bits,
          ...(printable ? { text, unmodifiedText: text } : {}) }, false,
        () => heldKeys.push({ ...key, modifiers: bits }));
      } finally {
        let releaseError;
        while (heldKeys.length) {
          const key = heldKeys.pop();
          const { bit, ...params } = key;
          if (bit) bits &= ~bit;
          try { await send('Input.dispatchKeyEvent', { ...params, type: 'keyUp', modifiers: bits }, true); }
          catch (error) { releaseError ||= error; }
        }
        if (releaseError) throw releaseError;
      }
    };
    try {
      checkAbort(this.signal);
      if (!['click', 'hover', 'drag', 'scroll', 'key', 'type'].includes(action)) throw failure(`Unsupported vision input: ${action}`);
      if (args.selector !== undefined || args.ref_id !== undefined) throw failure('Vision input accepts frame coordinates only');
      if (!frameSession?.assertViewport || !frameSession?.toCssPoint) throw failure('A current screenshot frame is required', 'vision_stale_frame');
      const frameId = args.frameId || args.frame_id || args.capture_id;
      if (typeof frameId !== 'string' || !frameId) throw failure('A current frameId is required', 'vision_stale_frame');
      viewport = await this.readViewport(tabId);
      frameSession.assertViewport(viewport);
      const pointArgs = { frameId, imageId: args.imageId || args.image_id };
      const hasPoint = args.x !== undefined || args.y !== undefined;
      let point;
      if (hasPoint || ['click', 'hover', 'drag', 'scroll'].includes(action))
        point = frameSession.toCssPoint({ ...pointArgs, x: args.x, y: args.y });
      else {
        // Validate the frame id even for focused keyboard input.
        frameSession.toCssPoint({ frameId, x: 0, y: 0 });
      }
      const button = args.button || 'left';
      if (!['left', 'right', 'middle'].includes(button)) throw failure('Unsupported pointer button');
      const buttons = { left: 1, right: 2, middle: 4 }[button];
      const clickCount = args.clickCount ?? 1;
      if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) throw failure('clickCount must be 1, 2 or 3');
      // Parse the complete request before a focus click or modifier can be sent.
      if (action === 'key') visionKeyChord(args.key || args.keys, viewport.platform);
      if (action === 'type' && (typeof args.text !== 'string' || args.text.length > 16000)) throw failure('Text must be a string of at most 16000 characters');
      if (action === 'type') this.transport.validateText?.(args.text);
      let destination;
      if (action === 'drag') destination = frameSession.toCssPoint({ ...pointArgs, x: args.toX, y: args.toY });
      let deltaX, deltaY;
      if (action === 'scroll') {
        deltaX = args.deltaX ?? 0; deltaY = args.deltaY ?? 0;
        if (![deltaX, deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 10000) || (!deltaX && !deltaY))
          throw failure('Scroll requires finite CSS pixel deltas, at most 10000 each');
      }
      if (['click', 'hover', 'drag', 'scroll'].includes(action) && typeof frameSession.assertCurrentPixels === 'function') {
        // Compare only the intended target neighborhood with the frame the
        // model saw. Unrelated video/animation must not block a stable target.
        const fresh = await this.capture(tabId);
        await frameSession.assertCurrentPixels(fresh.dataUrl, fresh.viewport, { ...args, ...pointArgs });
      }
      const click = async count => {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, buttons, clickCount: count }, false,
          () => { heldMouse = { ...point, button, buttons: 0, clickCount: count }; });
        const release = heldMouse; heldMouse = null;
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...release }, true);
      };
      if (action === 'click') {
        for (let count = 1; count <= clickCount; count++) await click(count);
      } else if (action === 'hover') {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 });
      } else if (action === 'drag') {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, buttons, clickCount: 1 }, false,
          () => { heldMouse = { ...point, button, buttons: 0, clickCount: 1 }; });
        const steps = 12;
        for (let index = 1; index <= steps; index++) {
          const next = { x: point.x + (destination.x - point.x) * index / steps, y: point.y + (destination.y - point.y) * index / steps };
          heldMouse = { ...heldMouse, ...next };
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...next, button, buttons });
        }
        const release = heldMouse; heldMouse = null;
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...release }, true);
      } else if (action === 'scroll') {
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY });
      } else if (action === 'key') await keyChord(args.key || args.keys);
      else if (action === 'type') {
        if (point) await click(1);
        if (args.clear === true) { await keyChord('ControlOrMeta+A'); await keyChord('Backspace'); }
        if (args.text) await send('Input.insertText', { text: args.text });
      }
      return { success: true, dispatched, coordinateSpace: 'viewport-css', ...(point ? { point } : {}) };
    } catch (error) {
      return { success: false, dispatched, noDispatch: !dispatched, outcomeUnknown: dispatched, retryable: !dispatched,
        code: error.code || (error.name === 'AbortError' ? 'vision_aborted'
          : /stale|viewport changed/i.test(error.message) ? 'vision_stale_frame' : 'vision_input_failed'), error: error.message };
    } finally {
      if (heldMouse) await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...heldMouse }, true).catch(() => {});
      this.acting.delete(tabId);
    }
  }
}
