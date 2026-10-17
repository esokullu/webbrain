/** Optional native-messaging transport. No raw BiDi commands are exposed to pages. */
import { beforePageAgentDispatch, validateNativePageDispatch } from '../agent/page-feedback.js';
// Failures raised before a native request could reach the companion (run
// binding, the page-feedback fence, the caller's last check, an unavailable
// port). Nothing was sent; any later failure may follow delivered input.
const REQUEST_NOT_SENT = new WeakSet();
const notSent = error => { if (error && typeof error === 'object') REQUEST_NOT_SENT.add(error); return error; };
export const isBidiRequestNotSentError = error => !!error && typeof error === 'object' && REQUEST_NOT_SENT.has(error);
export class FirefoxBidiClient {
  constructor(api) { this.apiOverride = api; this.pending = new Map(); this.runs = new Map(); this.captures = new Map(); this.sequence = 0; this.connectionEpoch = 0; }
  get api() { return this.apiOverride || globalThis.browser; }
  request(command, args = {}) {
    if (!this.port) {
      try { this.port = this.api.runtime.connectNative('one.webbrain.bidi'); }
      catch (error) { return Promise.reject(notSent(error)); }
      const port = this.port;
      port.onMessage.addListener(message => {
        if (message?.command === 'validatePageDispatch' && typeof message.id === 'string') {
          void (async () => {
            const entry = [...this.runs.entries()].find(([, run]) => run.runId === message.runId);
            const result = entry ? await validateNativePageDispatch(this.api, entry[0], message.guard, {
              kind: message.kind, rebindFocus: message.rebindFocus === true,
            }) : false;
            try { port.postMessage({ replyTo: message.id, result }); } catch { /* The native host may have disconnected. */ }
          })().catch(() => {
            try { port.postMessage({ replyTo: message.id, result: false }); } catch {}
          });
          return;
        }
        const entry = this.pending.get(message.id); if (!entry) return;
        if (typeof message.chunk === 'string') {
          entry.chunks ||= [];
          entry.chunkLength = (entry.chunkLength || 0) + message.chunk.length;
          if (message.index !== entry.chunks.length || entry.chunkLength > 32 * 1024 * 1024) {
            this.pending.delete(message.id);
            entry.reject(new Error('Invalid screenshot transfer; capture again'));
            return;
          }
          entry.chunks.push(message.chunk);
          if (!message.last) return;
          try {
            const parsed = JSON.parse(entry.chunks.join(''));
            if (parsed?.id !== message.id) throw new Error('Invalid screenshot reply');
            message = parsed;
          } catch (error) {
            this.pending.delete(message.id);
            entry.reject(error);
            return;
          }
        }
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error);
          if (message.dispatchState?.dispatched === false && message.dispatchState?.noDispatch === true) {
            error.dispatchState = { dispatched: false, noDispatch: true, outcomeUnknown: false, retryable: true };
            if (message.dispatchState.pageFeedbackPending === true) error.code = 'page_feedback_pending';
          }
          entry.reject(error);
        } else entry.resolve(message.result);
      });
      this.port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = null; this.connection = null;
        this.connectionEpoch++;
        for (const entry of this.pending.values()) entry.reject(new Error('Firefox companion disconnected; do not retry an uncertain action'));
        this.pending.clear();
        for (const owner of this.runs.values()) owner.disconnected = true;
      });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Firefox companion timed out; action outcome may be unknown')); }, 15000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { this.port.postMessage({ id, command, ...args }); }
      catch (error) { this.pending.get(id).reject(notSent(error)); this.pending.delete(id); }
    });
  }
  async connect() {
    const settings = await this.api.storage.local.get('firefoxBidiPort');
    if (!this.connection) this.connection = this.request('connect', { port: Number(settings.firefoxBidiPort) || 9222 }).catch(error => { this.connection = null; throw error; });
    return this.connection;
  }
  async startRun(tabId, signal) {
    if (!this.api?.storage?.local) return;
    const settings = await this.api.storage.local.get('firefoxBidiEnabled');
    if (!settings?.firefoxBidiEnabled || signal?.aborted) return;
    this.stopRun(tabId);
    const runId = crypto.randomUUID();
    const owner = { runId, signal, abort: () => this.stopRun(tabId) };
    this.runs.set(tabId, owner);
    signal?.addEventListener('abort', owner.abort, { once: true });
    try {
      await this.connect();
      if (this.runs.get(tabId) !== owner) throw new Error('Run stopped');
      await this.bindRun(tabId, owner);
    } catch (error) { if (this.runs.get(tabId) === owner) this.stopRun(tabId); throw error; }
  }
  async bindRun(tabId, owner) {
    if (owner.bound) return;
    if (this.runs.get(tabId) !== owner || owner.disconnected || owner.signal?.aborted) throw new Error('Run stopped');
    const tab = await this.api.tabs.get(tabId);
    // Internal/new tabs cannot accept content scripts. Keep ownership but defer
    // document binding so the normal authorized navigation can leave that page.
    if (!/^https?:\/\//.test(tab.url || '')) return;
    const [binding] = await this.api.tabs.executeScript(tabId, { frameId: 0, file: '/src/bidi/bind.js' });
    const {token, url} = binding || {};
    if (this.runs.get(tabId) !== owner || owner.disconnected || owner.signal?.aborted) throw new Error('Run stopped');
    await this.request('openRun', { runId: owner.runId, token, url });
    if (this.runs.get(tabId) !== owner || owner.disconnected || owner.signal?.aborted) {
      if (this.port) void this.request('closeRun', { runId: owner.runId }).catch(() => {});
      throw new Error('Run stopped');
    }
    owner.bound = true;
  }
  stopRun(tabId) {
    const owner = this.runs.get(tabId); if (!owner) return;
    this.runs.delete(tabId); owner.signal?.removeEventListener('abort', owner.abort);
    if (this.port) void this.request('closeRun', { runId: owner.runId }).catch(() => {});
  }
  disconnect() {
    this.connectionEpoch++;
    // Retain failed owners until their task ends; never switch a live task to synthetic input.
    for (const owner of this.runs.values()) owner.disconnected = true;
    const port = this.port; this.port = null; this.connection = null;
    for (const entry of this.pending.values()) entry.reject(new Error('Firefox companion disconnected'));
    this.pending.clear(); port?.disconnect();
  }
  async captureFullPage(tabId, beforeCapture = async () => {}) {
    const epoch = this.connectionEpoch;
    const settings = await this.api.storage.local.get('firefoxBidiEnabled');
    if (!settings.firefoxBidiEnabled) throw new Error('Full-page screenshots require Firefox trusted automation. Install the local companion and enable it in Settings → General → Advanced.');
    if (this.captures.has(tabId)) throw new Error('A full-page screenshot is already in progress for this tab');
    const owner = {};
    this.captures.set(tabId, owner);
    const assertCurrent = () => {
      if (this.connectionEpoch !== epoch || this.captures.get(tabId) !== owner) throw new Error('Firefox connection changed during screenshot capture; capture again');
    };
    try {
      assertCurrent();
      await this.connect();
      assertCurrent();
      const tab = await this.api.tabs.get(tabId);
      if (!/^https?:\/\//.test(tab.url || '')) throw new Error('Full-page screenshots require a regular web page');
      const [binding] = await this.api.tabs.executeScript(tabId, { frameId: 0, file: '/src/bidi/bind.js' });
      assertCurrent();
      if (binding?.url !== tab.url) throw new Error('Page changed before screenshot capture; capture again');
      await beforeCapture();
      assertCurrent();
      const result = await this.request('captureFullPage', binding);
      assertCurrent();
      if ((await this.api.tabs.get(tabId)).url !== binding.url) throw new Error('Page changed during screenshot capture; capture again');
      assertCurrent();
      return result;
    } finally {
      if (this.captures.get(tabId) === owner) this.captures.delete(tabId);
    }
  }
  // `onDispatch` runs once every pre-send check passed, immediately before the
  // native request (or deferred navigation) can deliver input. It may throw
  // as the caller's last check; that, like any earlier failure, sent nothing.
  async perform(tabId, action, payload, { onDispatch = null } = {}) {
    let owner, pageFeedbackGuard;
    try {
      owner = this.runs.get(tabId);
      if (!owner || owner.signal?.aborted || owner.disconnected) throw new Error('No connected Firefox BiDi run; restart the task after reconnecting');
      await this.bindRun(tabId, owner);
      if (this.runs.get(tabId) !== owner || owner.disconnected || owner.signal?.aborted) throw new Error('Run stopped');
      pageFeedbackGuard = await beforePageAgentDispatch(this.api, tabId, {
        kind: action === 'navigate' ? 'navigate' : action === 'scroll' ? 'scroll'
          : ['type', 'field', 'key', 'upload'].includes(action) ? 'input' : 'click',
        ...(payload.point ? { x: payload.point.x, y: payload.point.y } : {}),
        selector: payload.selector, ref_id: payload.ref_id, frameId: payload.frameId || 0,
        tool: action, prepareMonitor: true,
        navigationCandidate: ['click', 'checked'].includes(action),
        fenceOnly: true,
        url: action === 'navigate' ? payload.url : undefined,
      });
      if (!owner.bound && (action !== 'navigate' || !/^https?:\/\//.test(payload.url || ''))) throw new Error('Navigate to a web page before trusted input');
      onDispatch?.();
    } catch (error) { throw notSent(error); }
    if (!owner.bound) {
      await this.api.tabs.update(tabId, { url: payload.url });
      return { success: true, dispatched: true, bindingDeferred: true };
    }
    return this.request('perform', { runId: owner.runId, action, payload: { ...payload, pageFeedbackGuard } });
  }
  // `onDispatch` marks the transport boundary of whichever route is taken: the
  // content message, or the native request after its preparation and fence.
  async sendContent(tabId, message, options, { onDispatch = null } = {}) {
    const actions = { click: 'click', click_ax: 'click', type: 'type', type_ax: 'type', set_field: 'field', press_keys: 'key', hover: 'hover', bidi_prepare_upload: 'upload' };
    const action = actions[message.action];
    const owner = this.runs.get(tabId);
    if (owner?.disconnected || owner?.signal?.aborted) return { success: false, dispatched: false, noDispatch: true, retryable: false, error: 'Firefox connection stopped; restart the task.' };
    if (!owner || !action) { onDispatch?.(); return this.api.tabs.sendMessage(tabId, message, options); }
    await this.bindRun(tabId, owner);
    if (!owner.bound) return { success: false, dispatched: false, noDispatch: true, error: 'Navigate to a web page before trusted input.' };
    const token = crypto.randomUUID();
    const prepared = await this.api.tabs.sendMessage(tabId, { ...message, params: { ...message.params, _bidiPrepare: token } }, options);
    if (!prepared?.bidiPrepared) return prepared;
    if (this.runs.get(tabId) !== owner || owner.disconnected || owner.signal?.aborted) return { success: false, dispatched: false, noDispatch: true, retryable: false, error: 'Run stopped before trusted input.' };
    if (message.actionDeadlineAt && Date.now() >= message.actionDeadlineAt) return { success: false, dispatched: false, noDispatch: true, deadlineExpired: true };
    const metadata = { fieldMeta: prepared.fieldMeta, ...(message.params?.ref_id ? { ref_id: message.params.ref_id } : {}) };
    try {
      const performed = await this.perform(tabId, action, {
        ...message.params,
        token, frameId: options?.frameId || 0,
        url: prepared.url,
        point: prepared.point || null,
        checkable: prepared.checkable || null,
        deadlineAt: message.actionDeadlineAt || 0,
      }, { onDispatch });
      // The companion answers verified:false only from its settled readback
      // after trusted typing went out. Its rich-text reader falls back to
      // innerText, so the agent's policy decides whether that is a failure
      // (Strict checks) or a noted, unverified success.
      const unverified = (action === 'type' || action === 'field') && performed?.success === false
        && performed.dispatched === true && performed.verified === false && !performed.unverified
        ? { unverified: { reason: 'readback_mismatch', reader: 'unknown' } } : {};
      return { ...metadata, ...performed, ...unverified, ...(prepared.rect ? { rect: prepared.rect } : {}), ...(prepared._filePickerGuardId ? { _filePickerGuardId: prepared._filePickerGuardId } : {}) };
    } catch (error) {
      if (error?.name === 'AbortError' && isBidiRequestNotSentError(error)) throw error;
      // A refusal before the native request was posted sent nothing. A
      // transport failure after it can follow delivered trusted input.
      if (error?.code === 'page_feedback_pending') return { ...metadata, success: false, dispatched: false,
        noDispatch: true, pageFeedbackPending: true, error: error.message };
      if (isBidiRequestNotSentError(error)) return { ...metadata, success: false, dispatched: false, noDispatch: true,
        outcomeUnknown: false, retryable: false, error: error.message };
      return { ...metadata, success: false, dispatched: true, outcomeUnknown: true, retryable: false, ...(error.dispatchState || {}), error: error.message };
    }
  }
}
export const firefoxBidi = new FirefoxBidiClient();
