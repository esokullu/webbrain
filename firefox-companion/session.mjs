import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

// A rendered prefix cannot certify an unsupported rich-text document, and paragraph spacing
// in innerText is not the document's authored line breaks.
function readProseMirrorText(el) {
  if (!el?.isContentEditable || !el.classList?.contains('ProseMirror')) return null;
  let visited = 0;
  const supported = node => {
    if (++visited > 4096 || node.shadowRoot || node.hidden
        || String(node.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true'
        || String(node.getAttribute('contenteditable') || '').trim().toLowerCase() === 'false') return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    return !!style && style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility)
      && style.opacity !== '0' && style.contentVisibility !== 'hidden';
  };
  if (!supported(el)) return null;
  const read = (node, depth = 0) => {
    if (depth > 32) return null;
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || !supported(node)) return null;
    if (node.tagName === 'BR') {
      if (node.childNodes.length) return null;
      if (!node.classList.contains('ProseMirror-trailingBreak')) return '\n';
      return node.parentNode?.tagName === 'P' && !node.nextSibling ? '' : null;
    }
    // Text marks may wrap authored text. Embedded/node-view content has no
    // complete plain-text receipt, so it must never collapse to a visible prefix.
    if (!['SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL', 'CODE', 'A'].includes(node.tagName)) return null;
    const values = Array.from(node.childNodes).map(child => read(child, depth + 1));
    return values.some(value => value === null) ? null : values.join('');
  };
  const children = Array.from(el.childNodes);
  if (!children.length || !children.every(node => node.nodeType === 1 && node.tagName === 'P' && supported(node))) return null;
  const paragraphs = children.map(node => {
    const values = Array.from(node.childNodes).map(child => read(child));
    return values.some(value => value === null) ? null : values.join('');
  });
  return paragraphs.some(value => value === null) ? null : paragraphs.join('\n');
}

function isDraftJsEditor(el) {
  return !!el?.isContentEditable && (el.classList?.contains('public-DraftEditor-content')
    || Array.from(el.children || []).some(child => child.getAttribute('data-contents') === 'true'));
}

function readDraftJsText(el) {
  if (!el?.isContentEditable || !el.childNodes) return null;
  const roots = Array.from(el.childNodes);
  if (roots.length !== 1 || roots[0].nodeType !== 1 || roots[0].tagName !== 'DIV'
      || roots[0].getAttribute('data-contents') !== 'true') return null;
  let visited = 0;
  const supported = node => {
    if (++visited > 4096 || node.shadowRoot || node.hidden || String(node.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true'
        || String(node.getAttribute('contenteditable') || '').trim().toLowerCase() === 'false') return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    return !!style && (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility)
      && style.opacity !== '0' && style.contentVisibility !== 'hidden');
  };
  if (!supported(el) || !supported(roots[0])) return null;
  const blocks = Array.from(roots[0].childNodes);
  if (!blocks.length) return null;
  const texts = [];
  for (const block of blocks) {
    if (block.nodeType !== 1 || block.tagName !== 'DIV' || block.getAttribute('data-block') !== 'true'
        || !block.getAttribute('data-offset-key') || !supported(block)) return null;
    const children = Array.from(block.childNodes);
    const body = children[0];
    if (children.length !== 1 || body?.nodeType !== 1 || body.tagName !== 'DIV'
        || !body.classList.contains('public-DraftStyleDefault-block')
        || !body.getAttribute('data-offset-key') || !supported(body)) return null;
    const leaves = [];
    const read = (node, depth = 0) => {
      if (depth > 32 || node.nodeType !== 1 || !supported(node)) return false;
      if (node.tagName === 'BR') {
        if (node.getAttribute('data-text') !== 'true' || node.childNodes.length) return false;
        leaves.push(null); return true;
      }
      if (node.tagName !== 'SPAN') return false;
      const descendants = Array.from(node.childNodes);
      if (node.getAttribute('data-text') === 'true') {
        if (!descendants.every(child => child.nodeType === 3)) return false;
        leaves.push(descendants.map(child => child.nodeValue || '').join('')); return true;
      }
      return descendants.length > 0 && descendants.every(child => read(child, depth + 1));
    };
    if (!body.childNodes.length || !Array.from(body.childNodes).every(node => read(node))) return null;
    const placeholders = leaves.filter(value => value === null).length;
    if (placeholders && (placeholders !== 1 || leaves.some(value => value !== null && value !== ''))) return null;
    texts.push(leaves.filter(value => value !== null).join(''));
  }
  return texts.join('\n');
}

// The field's text and the reader that produced it: the editor's own model
// (DraftJS, ProseMirror), a native <input> or <textarea>'s exact value, or
// an editor's rendered text (innerText), whose spacing is layout.
function readRichTextFieldReading(el, semanticKind = '') {
  if (!el?.isConnected) return null;
  const draftJs = semanticKind === 'draftjs' || isDraftJsEditor(el);
  const proseMirror = semanticKind === 'prosemirror' || el.classList?.contains('ProseMirror');
  const semantic = draftJs ? readDraftJsText(el) : readProseMirrorText(el);
  if ((draftJs || proseMirror) && semantic === null) return null;
  if (semantic !== null) return { value: semantic, reader: 'semantic' };
  if (el.isContentEditable) return { value: el.innerText, reader: 'rendered' };
  return { value: el.value, reader: ['INPUT', 'TEXTAREA'].includes(String(el.tagName || '').toUpperCase()) ? 'exact' : 'unknown' };
}

function readRichTextFieldValue(el, semanticKind = '') {
  const reading = readRichTextFieldReading(el, semanticKind);
  return reading ? reading.value : null;
}

function proseMirrorSelectionMatches(el, bound) {
  if (!bound || el !== bound.editor || !el.isConnected || el.disabled
      || el.ownerDocument !== bound.document || el.getRootNode() !== bound.root
      || bound.root.activeElement !== el || readProseMirrorText(el) !== bound.before
      || el.childNodes.length !== bound.paragraphs.length
      || bound.paragraphs.some((node, index) => el.childNodes[index] !== node)
      || !el.contains(bound.startNode) || !el.contains(bound.endNode)) return false;
  const selection = bound.document.defaultView.getSelection();
  if (!selection || selection.rangeCount !== 1) return false;
  const range = selection.getRangeAt(0);
  return range.startContainer === bound.startNode && range.startOffset === bound.startOffset
    && range.endContainer === bound.endNode && range.endOffset === bound.endOffset;
}

const FIELD_TEXT_READBACK_SOURCE = [readProseMirrorText, isDraftJsEditor, readDraftJsText, readRichTextFieldReading, readRichTextFieldValue]
  .map(fn => fn.toString()).join('\n');

const sipMask = (1n << 64n) - 1n;
const sipRotate = (value, bits) => ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & sipMask;
function pageActionSignature(secret, data) {
  if (!/^[a-f\d]{32}$/i.test(secret || '')) return '';
  const key = Buffer.from(secret, 'hex');
  const read64 = offset => {
    let value = 0n;
    for (let index = 0; index < 8; index++) value |= BigInt(key[offset + index]) << BigInt(index * 8);
    return value;
  };
  const k0 = read64(0), k1 = read64(8);
  let v0 = 0x736f6d6570736575n ^ k0, v1 = 0x646f72616e646f6dn ^ k1;
  let v2 = 0x6c7967656e657261n ^ k0, v3 = 0x7465646279746573n ^ k1;
  const round = () => {
    v0 = (v0 + v1) & sipMask; v1 = sipRotate(v1, 13); v1 ^= v0; v0 = sipRotate(v0, 32);
    v2 = (v2 + v3) & sipMask; v3 = sipRotate(v3, 16); v3 ^= v2;
    v0 = (v0 + v3) & sipMask; v3 = sipRotate(v3, 21); v3 ^= v0;
    v2 = (v2 + v1) & sipMask; v1 = sipRotate(v1, 17); v1 ^= v2; v2 = sipRotate(v2, 32);
  };
  const bytes = Buffer.from(JSON.stringify([data.documentToken, data.runToken, data.operationId, data.revision,
    data.kind, data.sequence, data.navigationCandidate === true]));
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let block = 0n;
    for (let index = 0; index < 8; index++) block |= BigInt(bytes[offset + index]) << BigInt(index * 8);
    v3 ^= block; round(); round(); v0 ^= block; offset += 8;
  }
  let tail = BigInt(bytes.length) << 56n;
  for (let index = 0; offset + index < bytes.length; index++) tail |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  v3 ^= tail; round(); round(); v0 ^= tail; v2 ^= 0xffn;
  round(); round(); round(); round();
  return (v0 ^ v1 ^ v2 ^ v3).toString(16).padStart(16, '0');
}

export function createNativeActionMarker(guard, kind, sequence) {
  const { nativeSecret, ...data } = guard || {};
  const marker = { ...data, kind, sequence };
  marker.signature = pageActionSignature(nativeSecret, marker);
  return JSON.stringify(marker);
}

function unpackRemoteObjectValue(value) {
  if (value?.type !== 'object' || !Array.isArray(value.value)) return value;
  return Object.fromEntries(value.value.flatMap(entry => {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== 'string') return [];
    const [key, property] = entry;
    return [[key, property && typeof property === 'object' && Object.hasOwn(property, 'value')
      ? property.value
      : undefined]];
  }));
}

export class BidiSession {
  constructor(WebSocketImpl = WebSocket) {
    this.WebSocketImpl = WebSocketImpl;
    this.pending = new Map(); this.runs = new Map(); this.sequence = 0; this.files = []; this.closedRuns = new Set(); this.dialogs = new Map();
  }
  connect(port = 9222) {
    if (!this.connection) this.connection = this.connectSession(port).catch(error => {
      this.socket?.close(); this.connection = null; throw error;
    });
    return this.connection;
  }
  async connectSession(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local Firefox port');
    if (this.socket?.readyState === 1) return { connected: true, visionStartupBinding: true };
    const socket = this.socket = new this.WebSocketImpl(`ws://127.0.0.1:${port}/session`);
    socket.addEventListener('message', event => this.receive(JSON.parse(event.data)));
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('Firefox disconnected; action outcome may be unknown'));
      this.pending.clear(); this.runs.clear(); this.dialogs.clear(); this.connection = null;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Start Firefox with --remote-debugging-port')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to Firefox BiDi')); }, { once: true });
    });
    await this.send('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } });
    await this.send('session.subscribe', { events: ['browsingContext.userPromptOpened', 'browsingContext.userPromptClosed', 'browsingContext.contextDestroyed'] });
    return { connected: true, visionStartupBinding: true };
  }
  send(method, params) {
    if (this.socket?.readyState !== 1) return Promise.reject(new Error('Firefox BiDi is disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; do not repeat an uncertain action`)); }, 10000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.get(id).reject(error); this.pending.delete(id); }
    });
  }
  receive(message) {
    if (message.id != null) {
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id);
      if (message.type === 'error') entry.reject(new Error(message.error || 'BiDi command failed'));
      else entry.resolve(message.result);
      return;
    }
    const params = message.params || {};
    if (message.method === 'browsingContext.contextDestroyed') {
      for (const [id, run] of this.runs) if (run.context === params.context) this.runs.delete(id);
    }
    if (message.method === 'browsingContext.userPromptClosed' || message.method === 'browsingContext.contextDestroyed') this.dialogs.delete(params.context);
    if (message.method === 'browsingContext.userPromptOpened') {
      this.dialogs.set(params.context, { type: params.type });
      const run = [...this.runs.values()].find(item => item.context === params.context);
      if (run) void this.handleDialog(run).catch(() => {});
    }
  }
  async handleDialog(run) {
    const dialog = this.dialogs.get(run.context);
    if (!dialog) return;
    if (dialog.handling) return dialog.handling;
    const accept = dialog.type === 'alert' || (dialog.type === 'beforeunload' && run.navigation === true);
    if (dialog.type === 'beforeunload') run.navigation = false;
    dialog.handling = this.send('browsingContext.handleUserPrompt', { context: run.context, accept });
    try { await dialog.handling; }
    finally { if (this.dialogs.get(run.context) === dialog) this.dialogs.delete(run.context); }
  }
  async locate(token, url, context = null) {
    if (!/^[a-f0-9-]{36}$/.test(token) || !/^https?:\/\//.test(url)) throw new Error('Invalid tab binding');
    const tree = await this.send('browsingContext.getTree', context ? { root: context } : {});
    const contexts = [];
    const visit = nodes => { for (const node of nodes || []) { contexts.push(node); visit(node.children); } };
    visit(tree.contexts);
    if (contexts.length > 128) throw new Error('Too many Firefox contexts to bind safely');
    const matches = [];
    for (const frame of contexts) {
      if (frame.url !== url) continue;
      const found = await this.send('browsingContext.locateNodes', {
        context: frame.context, locator: { type: 'css', value: `[data-webbrain-bidi="${token}"]` },
      });
      for (const node of found.nodes || []) matches.push({ context: frame.context, node });
    }
    if (matches.length !== 1) throw new Error('Tab or element binding is stale or ambiguous; re-read the page');
    return matches[0];
  }
  async openRun(id, token, url) {
    if (!/^[a-f0-9-]{36}$/.test(id) || this.runs.has(id) || this.closedRuns.has(id)) throw new Error('Invalid run');
    const match = await this.locate(token, url);
    if (this.closedRuns.has(id) || this.runs.has(id)) throw new Error('Run stopped or already bound');
    this.runs.set(id, { context: match.context, navigation: false });
    await this.handleDialog(this.runs.get(id));
    if (this.closedRuns.has(id)) throw new Error('Run stopped during binding');
    await this.call(match, '(el) => { el.removeAttribute("data-webbrain-bidi"); return true; }');
    return { connected: true };
  }
  async openVisionStartupRun(id, url) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
      || this.runs.has(id) || this.closedRuns.has(id)
      || typeof url !== 'string' || !/^about:blank#wb-vision-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(url))
      throw new Error('Invalid visual startup binding');
    // The extension just navigated its already-owned new tab to a fresh nonce.
    // Match one top-level context, never a generic blank page or a child frame.
    const tree = await this.send('browsingContext.getTree', { maxDepth: 0 });
    if (this.closedRuns.has(id) || this.runs.has(id)) throw new Error('Run stopped or already bound');
    if (!Array.isArray(tree.contexts) || tree.contexts.length > 128) throw new Error('Too many Firefox contexts to bind safely');
    const matches = tree.contexts.filter(context => context.url === url && !context.parent);
    if (matches.length !== 1) throw new Error('Visual startup tab is stale or ambiguous');
    const context = matches[0].context;
    if (typeof context !== 'string' || !context || context.length > 512) throw new Error('Invalid visual startup context');
    // Confirm the matched context still contains the nonce immediately before
    // recording ownership. No page text or DOM binding is involved.
    const verified = await this.send('browsingContext.getTree', { root: context, maxDepth: 0 });
    if (this.closedRuns.has(id) || this.runs.has(id)) throw new Error('Run stopped or already bound');
    if (!Array.isArray(verified.contexts) || verified.contexts.length !== 1 || verified.contexts[0].context !== context
      || verified.contexts[0].url !== url || verified.contexts[0].parent)
      throw new Error('Visual startup tab changed before binding');
    this.runs.set(id, { context, navigation: false });
    return { connected: true };
  }
  async captureFullPage(token, url) {
    // A user capture has its own document binding. It never takes over an
    // automation run, dismisses its dialogs, or releases its pressed keys.
    const match = await this.locate(token, url);
    const readDocument = async () => {
      const result = await this.call(match, `(el) => {
        if (!el.isConnected || el !== document.documentElement || window !== window.top) return null;
        return JSON.stringify({ url: location.href, timeOrigin: performance.timeOrigin,
          width: Math.max(el.scrollWidth, innerWidth), height: Math.max(el.scrollHeight, innerHeight),
          dpr: devicePixelRatio, scrollX, scrollY });
      }`);
      if (result.type === 'exception' || typeof result.result?.value !== 'string') throw new Error('Screenshot document changed; capture again');
      return JSON.parse(result.result.value);
    };
    try {
      const before = await readDocument();
      if (before.url !== url) throw new Error('Screenshot document changed; capture again');
      const { width, height, dpr } = before;
      if (![width, height, dpr].every(value => Number.isFinite(value) && value > 0)
          || width * dpr > 32767 || height * dpr > 32767 || width * height * dpr * dpr > 50_000_000) {
        throw new Error('This page is too large for a full-page screenshot; use /screenshot for the visible area');
      }
      const result = await this.send('browsingContext.captureScreenshot', {
        context: match.context, origin: 'document', format: { type: 'image/png' },
      });
      if (JSON.stringify(before) !== JSON.stringify(await readDocument())) throw new Error('Page changed during screenshot capture; capture again');
      if (typeof result.data !== 'string' || result.data.length > 30 * 1024 * 1024) throw new Error('Screenshot is empty or exceeds the transfer limit');
      const png = Buffer.from(result.data, 'base64');
      if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Firefox returned an invalid screenshot');
      const imageWidth = png.readUInt32BE(16), imageHeight = png.readUInt32BE(20);
      if (Math.abs(imageWidth - width * dpr) > 1 || Math.abs(imageHeight - height * dpr) > 1) {
        throw new Error('Firefox could not capture the whole document; use /screenshot for the visible area');
      }
      return { dataUrl: `data:image/png;base64,${result.data}`, captureBounds: { x: 0, y: 0, width, height } };
    } finally {
      await this.call(match, '(el, token) => { if (el.getAttribute("data-webbrain-bidi") === token) el.removeAttribute("data-webbrain-bidi"); }', [{ type: 'string', value: token }]).catch(() => {});
    }
  }
  call(match, functionDeclaration, args = [], resultOwnership = null) {
    return this.send('script.callFunction', { target: { context: match.context }, functionDeclaration,
      arguments: [{ sharedId: match.node.sharedId }, ...args], awaitPromise: true,
      ...(resultOwnership ? { resultOwnership } : {}) });
  }
  async _waitForCheckableState(match, desiredChecked, timeoutMs = 80) {
    const result = await this.call(match, `async (el, desired, timeout) => {
      const read = () => el.isConnected && (el.type === "checkbox" || el.type === "radio")
        ? !!el.checked
        : null;
      const initial = read();
      if (initial === desired || initial === null) return { checkedAfter: initial, elapsedMs: 0 };
      const startedAt = performance.now();
      return await new Promise(resolve => {
        let timer = null;
        let settled = false;
        const cleanup = () => {
          el.removeEventListener('input', check);
          el.removeEventListener('change', check);
          clearTimeout(timer);
        };
        const finish = checkedAfter => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ checkedAfter, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)) });
        };
        const check = () => {
          const checkedAfter = read();
          if (checkedAfter === desired || checkedAfter === null) finish(checkedAfter);
        };
        el.addEventListener('input', check);
        el.addEventListener('change', check);
        timer = setTimeout(() => finish(read()), Math.max(0, timeout));
        check();
      });
    }`, [
      { type: 'boolean', value: desiredChecked },
      { type: 'number', value: timeoutMs },
    ]);
    const observation = unpackRemoteObjectValue(result.result?.type ? result.result : result.result?.value);
    if (observation && typeof observation === 'object') {
      return {
        checkedAfter: typeof observation.checkedAfter === 'boolean' ? observation.checkedAfter : null,
        elapsedMs: Number.isFinite(Number(observation.elapsedMs)) ? Math.max(0, Number(observation.elapsedMs)) : timeoutMs,
      };
    }
    // A malformed page response stays inconclusive and keeps the bounded
    // observation budget visible to the caller.
    return { checkedAfter: null, elapsedMs: timeoutMs };
  }
  async closeRun(id) {
    this.closedRuns.add(id);
    if (this.closedRuns.size > 4096) this.closedRuns.delete(this.closedRuns.values().next().value);
    const run = this.runs.get(id); this.runs.delete(id);
    if (run) await this.send('input.releaseActions', { context: run.context }).catch(() => {});
    return {};
  }
  async perform(id, action, payload, validatePageDispatch = null) {
    const dispatch = { started: false, ownedHandles: [] };
    try { return await this.performAction(id, action, payload, dispatch, validatePageDispatch); }
    catch (error) {
      error.dispatchState = { dispatched: dispatch.started, noDispatch: !dispatch.started,
        outcomeUnknown: dispatch.started, retryable: !dispatch.started,
        ...(error.code === 'page_feedback_pending' ? { pageFeedbackPending: true } : {}) };
      throw error;
    }
    finally {
      for (const { context, handle } of dispatch.ownedHandles)
        await this.send('script.disown', { target: { context }, handles: [handle] }).catch(() => {});
    }
  }
  async performAction(id, action, payload, dispatch, validatePageDispatch = null) {
    if (!['navigate', 'click', 'hover', 'type', 'field', 'key', 'upload'].includes(action)) throw new Error('Unsupported BiDi action');
    if (payload.modifiers) throw new Error('Key modifiers are not supported by this tool');
    const run = this.runs.get(id); if (!run) throw new Error('Run stopped or disconnected');
    const assertLive = () => {
      if (this.runs.get(id) !== run) throw new Error('Run stopped');
      if (payload.deadlineAt && Date.now() >= payload.deadlineAt) throw new Error('Action deadline expired');
    };
    assertLive();
    if (action === 'navigate') {
      if (!/^https?:\/\//.test(payload.url)) throw new Error('Invalid navigation URL');
      const guard = payload.pageFeedbackGuard;
      if (guard && (typeof validatePageDispatch !== 'function'
          || !await validatePageDispatch(id, guard, 'navigate', false))) {
        const error = new Error('Page changed during native preparation; navigation was not sent');
        error.code = 'page_feedback_pending'; throw error;
      }
      assertLive();
      run.navigation = true;
      try { dispatch.started = true; await this.send('browsingContext.navigate', { context: run.context, url: payload.url, wait: 'interactive' }); }
      finally { run.navigation = false; }
      return { success: true, dispatched: true };
    }
    const match = await this.locate(payload.token, payload.url, run.context);
    assertLive();
    let nativeSequence = 0;
    const markNativeDispatch = async (kind, { rebindFocus = false, domDispatch = false } = {}) => {
      assertLive();
      const guard = payload.pageFeedbackGuard;
      if (!guard) return; // Compatibility with clients without page monitoring.
      if (typeof validatePageDispatch !== 'function'
          || !await validatePageDispatch(id, guard, kind, rebindFocus === true)) {
        const error = new Error('Page changed during native preparation; no further input sent');
        error.code = 'page_feedback_pending'; throw error;
      }
      // A public framework event uses the existing prepared DOM phase gate.
      // It cannot consume a trusted-event marker or advance its native sequence.
      if (domDispatch) return;
      const marker = createNativeActionMarker(guard, kind, ++nativeSequence);
      const checked = await this.call(match, `(el, marker, kind, action) => {
        if (!el.isConnected) return false;
        const deepActiveElement = () => {
          let active = document.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          return active;
        };
        const target = kind === 'input' && action !== 'upload' ? deepActiveElement() || el : el;
        if (!target?.isConnected) return false;
        target.setAttribute('data-webbrain-native-action', marker);
        return true;
      }`, [{ type: 'string', value: marker }, { type: 'string', value: kind }, { type: 'string', value: action }]);
      if (checked.result?.value !== true) {
        const error = new Error('Page changed during native preparation; no further input sent');
        error.code = 'page_feedback_pending'; throw error;
      }
      try {
        assertLive();
        if (!await validatePageDispatch(id, guard, kind, rebindFocus === true)) {
          const error = new Error('Page changed during native preparation; no further input sent');
          error.code = 'page_feedback_pending'; throw error;
        }
        assertLive();
      } catch (error) {
        await clearNativeDispatch(marker);
        throw error;
      }
      return marker;
    };
    const clearNativeDispatch = async marker => {
      if (!marker || !payload.pageFeedbackGuard) return;
      try {
        await this.call(match, `(el, marker, action) => {
          const kind = JSON.parse(marker).kind;
          const deepActiveElement = () => {
            let active = document.activeElement;
            while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
            return active;
          };
          const targets = kind === 'input' && action !== 'upload' ? [el, deepActiveElement()] : [el];
          for (const target of new Set(targets))
            if (target?.getAttribute('data-webbrain-native-action') === marker) target.removeAttribute('data-webbrain-native-action');
        }`, [{ type: 'string', value: marker }, { type: 'string', value: action }]);
      } catch { /* The document may have navigated or the monitor already consumed the marker. */ }
    };
    const point = action === 'click' && payload.point != null ? payload.point : null;
    if (point && (!Number.isInteger(point.x) || !Number.isInteger(point.y))) throw new Error('Invalid click coordinates');
    const focusGuard = payload.pageFeedbackGuard;
    if (['type', 'field', 'key'].includes(action) && focusGuard
        && (typeof validatePageDispatch !== 'function'
          || !await validatePageDispatch(id, focusGuard, 'input', false))) {
      const error = new Error('Page changed during native preparation; no focus or input sent');
      error.code = 'page_feedback_pending'; throw error;
    }
    assertLive();
    const check = await this.call(match, `(el, token, action, x, y) => {
      if (!el.isConnected || el.getAttribute('data-webbrain-bidi') !== token || el.disabled) return false;
      el.removeAttribute('data-webbrain-bidi');
      if (action === 'upload') return el.tagName === 'INPUT' && el.type === 'file';
      if (action === 'click' || action === 'hover') {
        const r = el.getBoundingClientRect();
        const px = x === null ? r.x+r.width/2 : x;
        const py = y === null ? r.y+r.height/2 : y;
        if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) return false;
        let hit = document.elementFromPoint(px, py);
        // elementFromPoint stops at each open shadow host. Descend through those
        // roots so trusted input accepts the same visible target as content.js.
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(px, py);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        const reaches = (node, target) => {
          while (node) {
            if (node === target) return true;
            node = node.parentNode || node.host;
          }
          return false;
        };
        if (!r.width || !r.height || !reaches(hit, el)) return false;
      }
      if (action === 'type' || action === 'field' || action === 'key') {
        el.focus({preventScroll:true});
        if (el.getRootNode().activeElement !== el) return false;
      }
      return true;
    }`, [{ type: 'string', value: payload.token }, { type: 'string', value: action }, point ? {type:'number',value:point.x} : {type:'null'}, point ? {type:'number',value:point.y} : {type:'null'}]);
    if (check.result?.value !== true) throw new Error('Target changed or is covered; no input sent');
    assertLive();
    if (action === 'upload') {
      if (typeof payload.base64 !== 'string' || payload.base64.length > 36 * 1024 * 1024) throw new Error('Upload exceeds 25MB');
      const bytes = Buffer.from(payload.base64, 'base64');
      if (bytes.length > 25 * 1024 * 1024) throw new Error('Upload exceeds 25MB');
      const dir = await mkdtemp(join(tmpdir(), 'webbrain-bidi-')); this.files.push(dir);
      const name = basename(String(payload.filename || 'attachment')).replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = join(dir, name === '.' || name === '..' ? 'attachment' : name);
      await writeFile(path, bytes, { mode: 0o600 });
      assertLive();
      const marker = await markNativeDispatch('input');
      try {
        dispatch.started = true;
        await this.send('input.setFiles', { context: match.context, element: { sharedId: match.node.sharedId }, files: [path] });
      } finally { await clearNativeDispatch(marker); }
      const attached = await this.call(match, '(el, name, size) => el.isConnected && el.files?.length === 1 && el.files[0].name === name && el.files[0].size === size', [{ type: 'string', value: name }, { type: 'number', value: bytes.length }]);
      if (attached.result?.value !== true) return { success: false, dispatched: true, outcomeUnknown: true, retryable: false, error: 'File input changed after attachment; inspect the page before retrying.' };
      return { success: true, dispatched: true, attachmentState: 'input_attached', file: name, size: bytes.length };
    }
    const typing = action === 'type' || action === 'field';
    const clear = action === 'field' ? payload.clear !== false : payload.clear === true;
    const checkable = action === 'click' && payload.checkable;
    if (checkable && (!['checkbox', 'radio'].includes(checkable.inputType) || typeof checkable.desiredChecked !== 'boolean')) {
      throw new Error('Invalid checkable target metadata');
    }
    const before = typing ? await this.call(match, `(el) => {
      ${FIELD_TEXT_READBACK_SOURCE}
      const value = readRichTextFieldValue(el);
      if (value === null) return null;
      const semanticKind = isDraftJsEditor(el) ? 'draftjs'
        : readProseMirrorText(el) !== null ? 'prosemirror' : '';
      return { value, semanticKind };
    }`) : null;
    if (typing && (before.result?.type === 'null' || before.result?.value === null)) {
      throw new Error('The rich-text editor structure cannot establish its exact document text; no text sent');
    }
    const beforeReadback = typing ? unpackRemoteObjectValue(before.result?.type ? before.result : before.result?.value) : null;
    const beforeSnapshot = beforeReadback && typeof beforeReadback === 'object' && Object.hasOwn(beforeReadback, 'value')
      ? beforeReadback : { value: before?.result?.value, semanticKind: '' };
    let proseMirrorBinding = null;
    const assertFocus = async () => {
      assertLive();
      const focused = await this.call(match, '(el) => el.isConnected && !el.disabled && el.getRootNode().activeElement === el');
      if (focused.result?.value !== true) throw new Error('Focus changed; no further keys sent');
      assertLive();
    };
    const press = async (value, modifier = null, followTabFocus = false) => {
      if (followTabFocus) assertLive();
      else await assertFocus();
      const actions = [
        { type: 'keyDown', value }, { type: 'keyUp', value },
        ...(modifier ? [{ type: 'keyUp', value: modifier }] : []),
      ];
      try {
        // Each keydown needs its own expectation. Keep the modifier held while
        // renewing the fence, so Ctrl/Meta+A cannot look like a human edit.
        if (modifier) {
          const marker = await markNativeDispatch('input');
          try {
            dispatch.started = true;
            await this.send('input.performActions', { context: match.context, actions: [{ type: 'key', id: 'webbrain-keyboard',
              actions: [{ type: 'keyDown', value: modifier }] }] });
          } finally { await clearNativeDispatch(marker); }
          await assertFocus();
        }
        const marker = await markNativeDispatch('input', { rebindFocus: followTabFocus });
        try {
          dispatch.started = true;
          await this.send('input.performActions', { context: match.context, actions: [{ type: 'key', id: 'webbrain-keyboard', actions }] });
        } finally { await clearNativeDispatch(marker); }
      }
      finally { await this.send('input.releaseActions', { context: match.context }).catch(() => {}); }
      assertLive();
    };
    if (action === 'click' || action === 'hover') {
      const source = { type: 'pointer', id: 'webbrain-pointer', parameters: { pointerType: 'mouse' }, actions: [
        point ? { type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport' }
          : { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: match.node.sharedId } } },
        ...(action === 'click' ? [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] : []),
      ] };
      assertLive();
      const marker = await markNativeDispatch('click');
      try { dispatch.started = true; await this.send('input.performActions', { context: match.context, actions: [source] }); }
      finally {
        await clearNativeDispatch(marker);
        await this.send('input.releaseActions', { context: match.context }).catch(() => {});
      }
      assertLive();
      if (checkable) {
        const observation = await this._waitForCheckableState(match, checkable.desiredChecked, 80);
        assertLive();
        const checkedAfter = observation.checkedAfter;
        if (typeof checkedAfter !== 'boolean') {
          return { success: false, dispatched: true, outcomeUnknown: true, retryable: false,
            _checkableObservationMs: observation.elapsedMs,
            error: 'Checkable target changed after trusted click; inspect the page before retrying.' };
        }
        const stateMatchesDesired = checkedAfter === checkable.desiredChecked;
        return {
          success: stateMatchesDesired,
          dispatched: true,
          verified: stateMatchesDesired,
          checkedBefore: !!checkable.checkedBefore,
          checkedAfter,
          checkedChanged: !!checkable.checkedBefore !== checkedAfter,
          desiredChecked: checkable.desiredChecked,
          checkboxIdentity: checkable.checkboxIdentity,
          checkboxState: { identity: checkable.checkboxIdentity, desiredChecked: checkable.desiredChecked, actualChecked: checkedAfter },
          _checkableObservationMs: observation.elapsedMs,
          ...(stateMatchesDesired ? { observedEffects: ['checked_state'] } : {
            noProgress: true,
            error: checkable.inputType === 'checkbox'
              ? `Checkbox remained ${checkedAfter ? 'checked' : 'unchecked'} after trusted click.`
              : 'Radio remained unselected after trusted click.',
          }),
          method: 'firefox-bidi',
        };
      }
    } else if (typing) {
      if (typeof payload.text !== 'string' || payload.text.length > 10000) throw new Error('Trusted text input is limited to 10000 characters per action');
      if (/[\r\n]/.test(payload.text)) {
        const multiline = await this.call(match, '(el) => el.tagName === "TEXTAREA" || el.isContentEditable');
        if (multiline.result?.value !== true) throw new Error('Newlines require a multiline editor; no text sent');
      }
      if (beforeSnapshot.semanticKind === 'prosemirror') {
        // A whole public paste avoids intermediate deletion/character updates to
        // composer peers, and preserves literal LFs through the editor's parser.
        // Remote ownership keeps these DOM identities private to this operation.
        const positioned = await this.call(match, `(el, clear, before) => {
          ${FIELD_TEXT_READBACK_SOURCE}
          if (!el.isConnected || el.getRootNode().activeElement !== el
              || readProseMirrorText(el) !== before) return null;
          const document = el.ownerDocument;
          const paragraphs = Array.from(el.childNodes);
          const edge = (paragraph, end) => {
            let node = end ? paragraph.lastChild : paragraph.firstChild;
            if (end && node?.nodeName === 'BR' && node.classList.contains('ProseMirror-trailingBreak')) node = node.previousSibling;
            if (!node) return [paragraph, 0];
            while (node.nodeType === 1 && node.nodeName !== 'BR' && node.childNodes.length)
              node = end ? node.lastChild : node.firstChild;
            if (node.nodeType === 3) return [node, end ? node.nodeValue.length : 0];
            if (node.nodeName === 'BR') return [node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node) + (end ? 1 : 0)];
            return [node, 0];
          };
          const [endNode, endOffset] = edge(paragraphs[paragraphs.length - 1], true);
          const [startNode, startOffset] = clear ? edge(paragraphs[0], false) : [endNode, endOffset];
          const range = document.createRange();
          range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
          const selection = document.defaultView.getSelection();
          selection.removeAllRanges(); selection.addRange(range);
          return { editor: el, document, root: el.getRootNode(), paragraphs, before,
            startNode, startOffset, endNode, endOffset };
        }`, [{ type: 'boolean', value: clear }, { type: 'string', value: String(beforeSnapshot.value || '') }], 'root');
        const binding = positioned.result?.handle;
        if (!binding) throw new Error('Could not position the ProseMirror selection; no text sent');
        proseMirrorBinding = binding;
        (dispatch.ownedHandles ||= []).push({ context: match.context, handle: binding });
        // Public selectionchange must reach the framework before it reads paste.
        await new Promise(resolve => setTimeout(resolve, 30));
        await assertFocus();
        const selected = await this.call(match, `(el, bound) => {
          ${FIELD_TEXT_READBACK_SOURCE}
          ${proseMirrorSelectionMatches.toString()}
          return proseMirrorSelectionMatches(el, bound);
        }`, [{ handle: binding }]);
        if (selected.result?.value !== true) throw new Error('The ProseMirror document or selection changed; no text sent');
        if (payload.text === '') {
          // ProseMirror does not consume an empty clipboard. A single native
          // deletion of the pinned whole-document selection needs no follow-up edit.
          if (clear && beforeSnapshot.value !== '') await press('\uE003');
        } else {
          const marker = await markNativeDispatch('input', { domDispatch: true });
          try {
            dispatch.started = true;
            const pasted = await this.call(match, `(el, bound, text, guardJson) => {
              ${FIELD_TEXT_READBACK_SOURCE}
              ${proseMirrorSelectionMatches.toString()}
              if (!proseMirrorSelectionMatches(el, bound)) return false;
              const view = bound.document.defaultView;
              const data = new view.DataTransfer(); data.setData('text/plain', text);
              const event = new view.ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: data });
              if (event.clipboardData?.getData('text/plain') !== text)
                Object.defineProperty(event, 'clipboardData', { value: data });
              const guard = JSON.parse(guardJson);
              if (guard && !el.dispatchEvent(new view.CustomEvent('webbrain-agent-dom-dispatch', {
                detail: JSON.stringify({ ...guard, dispatchPhase: 'input' }), bubbles: true, composed: true, cancelable: true,
              }))) return false;
              // The phase event can run page listeners; recheck the exact
              // editor and range before sending any clipboard content.
              if (!proseMirrorSelectionMatches(el, bound)) return false;
              el.dispatchEvent(event);
              return true;
            }`, [{ handle: binding }, { type: 'string', value: payload.text.replace(/\r\n?/g, '\n') },
              { type: 'string', value: JSON.stringify(payload.pageFeedbackGuard || null) }]);
            if (pasted.result?.value !== true) throw new Error('ProseMirror paste dispatch could not be established; inspect before another write');
          } finally { await clearNativeDispatch(marker); }
          assertLive();
        }
      } else {
        if (clear) {
          const platform = await this.call(match, '() => navigator.platform');
          await press('a', /Mac/.test(platform.result?.value || '') ? '\uE03D' : '\uE009');
          await press('\uE003');
          if (beforeSnapshot.semanticKind === 'draftjs') {
            const cleared = await this.call(match, `(el) => {
              ${FIELD_TEXT_READBACK_SOURCE}
              return readRichTextFieldValue(el, 'draftjs') === '';
            }`);
            if (cleared.result?.value !== true) throw new Error('DraftJS clearing did not establish an empty document; no further text sent');
          }
        } else {
          const positioned = await this.call(match, `(el) => {
            if (!el.isConnected || el.getRootNode().activeElement !== el) return false;
            if (el.isContentEditable) {
              const selection = getSelection(); const range = document.createRange();
              let container = el;
              while (container.lastChild?.nodeType === 1 && container.lastChild.isContentEditable
                  && container.lastChild.nodeName !== 'BR') container = container.lastChild;
              range.selectNodeContents(container); range.collapse(false);
              selection.removeAllRanges(); selection.addRange(range);
            } else if (typeof el.setSelectionRange === 'function') {
              const end = el.value.length; el.setSelectionRange(end, end);
            } else return false;
            return true;
          }`);
          if (positioned.result?.value !== true) throw new Error('Could not position caret for append; no text sent');
        }
        if (beforeSnapshot.semanticKind === 'draftjs' && /[\r\n]/.test(payload.text)) {
          // DraftJS treats literal LF editing commands inconsistently. Its public paste
          // handler accepts a whole plain-text document without using a submit shortcut.
          const positioned = await this.call(match, `(el, clear) => {
            if (!el.isConnected || el.getRootNode().activeElement !== el) return false;
            const leaves = el.querySelectorAll('[data-text="true"]');
            const leaf = leaves[clear ? 0 : leaves.length - 1];
            if (!leaf) return false;
            const range = el.ownerDocument.createRange();
            if (leaf.nodeName === 'BR') range.setStartBefore(leaf);
            else {
              const text = clear ? leaf.firstChild : leaf.lastChild;
              if (text?.nodeType !== 3) return false;
              range.setStart(text, clear ? 0 : text.nodeValue.length);
            }
            range.collapse(true);
            const selection = el.ownerDocument.defaultView.getSelection();
            selection.removeAllRanges(); selection.addRange(range);
            return true;
          }`, [{ type: 'boolean', value: clear }]);
          if (positioned.result?.value !== true) throw new Error('Could not position the DraftJS caret; no further text sent');
          // Let the browser's selectionchange reach the framework before the paste.
          await new Promise(resolve => setTimeout(resolve, 30));
          await assertFocus();
          const marker = await markNativeDispatch('input', { domDispatch: true });
          try {
            dispatch.started = true;
            const pasted = await this.call(match, `(el, text, guardJson) => {
              ${FIELD_TEXT_READBACK_SOURCE}
              if (!el.isConnected || el.getRootNode().activeElement !== el || readDraftJsText(el) === null) return false;
              const view = el.ownerDocument.defaultView;
              const data = new view.DataTransfer(); data.setData('text/plain', text);
              const event = new view.ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: data });
              // Firefox drops the constructor's clipboardData. Preserve the public
              // plain-text payload without reading or writing the OS clipboard.
              if (event.clipboardData?.getData('text/plain') !== text)
                Object.defineProperty(event, 'clipboardData', { value: data });
              const guard = JSON.parse(guardJson);
              if (guard && !el.dispatchEvent(new view.CustomEvent('webbrain-agent-dom-dispatch', {
                detail: JSON.stringify({ ...guard, dispatchPhase: 'input' }), bubbles: true, composed: true, cancelable: true,
              }))) return false;
              el.dispatchEvent(event);
              // Cancellation can mean the framework consumed the paste. Only the
              // settled exact document readback below establishes its outcome.
              return true;
            }`, [{ type: 'string', value: payload.text.replace(/\r\n?/g, '\n') },
              { type: 'string', value: JSON.stringify(payload.pageFeedbackGuard || null) }]);
            if (pasted.result?.value !== true) throw new Error('DraftJS paste dispatch could not be established; inspect before another write');
          } finally { await clearNativeDispatch(marker); }
          assertLive();
        } else {
          // One character per dispatch bounds work after Stop and catches focus changes between keys.
          for (const char of payload.text.replace(/\r\n?/g, '\n')) {
            if (char === '\n' || char === '\r') {
              await assertFocus();
              // Enter is a submit shortcut on many editors, even with Shift. Insert a literal
              // newline through the editing command instead; never synthesize a submit key.
              const marker = await markNativeDispatch('input');
              let inserted;
              try {
                dispatch.started = true;
                inserted = await this.call(match, `(el, text) => {
                  if (!el.isConnected || el.getRootNode().activeElement !== el) return false;
                  return document.execCommand('insertText', false, text);
                }`, [{ type: 'string', value: char }]);
              } finally { await clearNativeDispatch(marker); }
              if (inserted.result?.value !== true) throw new Error('Editor rejected literal newline insertion');
              assertLive();
            } else await press(char);
          }
        }
      }
    } else if (action === 'key') {
      const keys = { Enter: '\uE007', Tab: '\uE004', Escape: '\uE00C', Backspace: '\uE003', Delete: '\uE017', ArrowLeft: '\uE012', ArrowRight: '\uE014', ArrowUp: '\uE013', ArrowDown: '\uE015', Home: '\uE011', End: '\uE010' };
      const value = keys[payload.key] || (String(payload.key).length === 1 ? payload.key : null);
      if (!value) throw new Error('Unsupported trusted key');
      const repeat = Math.max(1, Math.min(3, Math.floor(Number(payload.repeat) || 1)));
      // Repeated Tab intentionally follows the focus moved by the previous Tab.
      for (let i = 0; i < repeat; i++) await press(value, null, payload.key === 'Tab' && i > 0);
    }
    if (typing) {
      await new Promise(resolve => setTimeout(resolve, 100));
      assertLive();
      const expected = clear ? payload.text : String(beforeSnapshot.value || '') + payload.text;
      // The settled readback names the reader that compared the value, so
      // the extension can tell a field known to hold another value (an exact
      // or semantic reading) from one whose rendered text only differs, or
      // one that could not be read.
      const settled = await this.call(match, `(el, expected, semanticKind, bound) => {
        ${FIELD_TEXT_READBACK_SOURCE}
        if (bound && (el !== bound.editor || el.ownerDocument !== bound.document || el.getRootNode() !== bound.root))
          return { verified: false, compared: false, reason: 'element_replaced' };
        const settledReading = readRichTextFieldReading(el, semanticKind);
        if (settledReading === null) return { verified: false, compared: false, reason: 'readback_unavailable' };
        const actual = settledReading.value;
        if (!el.isContentEditable) return { verified: actual === expected, compared: true, reader: settledReading.reader };
        const normalize = value => String(value).replace(/\\r\\n?/g, '\\n');
        return { verified: normalize(actual) === normalize(expected), compared: true, reader: settledReading.reader };
      }`, [{ type: 'string', value: expected }, { type: 'string', value: beforeSnapshot.semanticKind || '' },
        proseMirrorBinding ? { handle: proseMirrorBinding } : { type: 'null' }]);
      const readback = unpackRemoteObjectValue(settled.result?.type ? settled.result : settled.result?.value);
      if (readback !== true && readback?.verified !== true) {
        const reading = readback && typeof readback === 'object' ? { readback: {
          compared: readback.compared === true,
          ...(['exact', 'semantic', 'rendered'].includes(readback.reader) ? { reader: readback.reader } : {}),
          ...(['element_replaced', 'readback_unavailable'].includes(readback.reason) ? { reason: readback.reason } : {}),
        } } : {};
        return { success: false, dispatched: true, verified: false, submitted: false, outcomeUnknown: true, retryable: false, ...reading,
          error: 'Trusted typing did not match the requested value; inspect before another write.' };
      }
      if (action === 'field' && payload.submit === true) {
        assertLive();
        await press('\uE007');
      }
      return { success: true, dispatched: true, verified: true, submitted: action === 'field' && payload.submit === true, method: 'firefox-bidi' };
    }
    return { success: true, dispatched: true, verified: false, method: 'firefox-bidi' };
  }
  async close() {
    for (const id of this.runs.keys()) await this.closeRun(id);
    this.socket?.close();
    for (const dir of this.files) await rm(dir, { recursive: true, force: true });
    this.files = [];
  }
}
