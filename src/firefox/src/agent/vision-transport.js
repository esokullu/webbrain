import { firefoxBidi } from '../bidi/client.js';

// A browser compositor can stop replying while its tab remains alive. Bound
// observation only: abandoning a read never retries or cancels native input.
function boundedVisionRead(signal, label, operation) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    let settled = false, timer, terminalError;
    const aborted = () => Object.assign(new Error('Vision run stopped'), { name: 'AbortError', code: 'vision_aborted' });
    const timedOut = () => Object.assign(new Error(`Vision observation timed out after 15 seconds (${label})`),
      { name: 'TimeoutError', code: 'vision_capture_timeout' });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => { terminalError = aborted(); finish(reject, terminalError); };
    const guard = () => {
      if (signal?.aborted) throw aborted();
      if (terminalError) throw terminalError;
      if (Date.now() >= deadline) throw timedOut();
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { terminalError = timedOut(); finish(reject, terminalError); }, 15000);
    Promise.resolve().then(() => { guard(); return operation(guard); }).then(value => {
      try { guard(); finish(resolve, value); } catch (error) { finish(reject, error); }
    }, error => finish(reject, error));
  });
}

const TRANSIENT_CAPTURE_CODES = new Set(['vision_stale_frame', 'vision_capture_context_changed', 'vision_capture_not_ready']);
export function isTransientVisionCaptureError(error) {
  return error?.name !== 'AbortError' && TRANSIENT_CAPTURE_CODES.has(error?.code);
}
// Only read-only companion viewport/screenshot errors are classified here.
// Native input, run binding, privacy failures and disconnects are never retried.
export function classifyVisionCaptureError(error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (failure.name === 'AbortError' || failure.code) return failure;
  const message = failure.message;
  if (/permission|denied|not allowed|restricted|not attached|disconnected|no tab|target closed|session closed|tab (?:was |is )?closed|browser.*closed/i.test(message)) return failure;
  if (/execution context (?:was )?destroyed|cannot find (?:default )?(?:execution )?context|cannot find context with specified id|no such (?:realm|frame)|context.*discarded/i.test(message)) {
    failure.code = 'vision_capture_context_changed';
  } else if (/page changed during screenshot capture/i.test(message)) {
    failure.code = 'vision_stale_frame';
  } else if (/unable to capture screenshot|cannot take screenshot with 0 (?:width|height)|cannot read (?:Firefox )?viewport geometry|empty screenshot/i.test(message)) {
    failure.code = 'vision_capture_not_ready';
  }
  return failure;
}

export function createVisionTransport({ signal }) {
  const pending = new Map();
  const check = () => { if (signal?.aborted) throw Object.assign(new Error('Vision run stopped'), { name: 'AbortError' }); };
  const ownerFor = async (tabId, guard = check) => {
    guard();
    if (!firefoxBidi.runs.has(tabId)) {
      if (!pending.has(tabId)) pending.set(tabId, firefoxBidi.startRun(tabId, signal).finally(() => pending.delete(tabId)));
      await pending.get(tabId);
    }
    guard();
    const owner = firefoxBidi.runs.get(tabId);
    if (!owner || owner.disconnected || owner.signal?.aborted)
      throw new Error('Vision input requires the Firefox trusted automation companion; enable it in Settings → Advanced');
    await firefoxBidi.bindRun(tabId, owner);
    guard();
    if (!owner.bound) throw new Error('Navigate to a regular web page before vision capture');
    return owner;
  };
  const read = (tabId, command) => boundedVisionRead(signal, command, async guard => {
    try {
      const owner = await ownerFor(tabId, guard);
      guard();
      return await firefoxBidi.request(command, { runId: owner.runId });
    } catch (error) { guard(); throw classifyVisionCaptureError(error); }
  });
  return {
    validateText(text) {
      if (/[\uE000-\uE05D]/u.test(text)) throw new Error('Firefox cannot type reserved WebDriver control characters as literal text');
    },
    async readViewport(tabId) {
      return read(tabId, 'visionViewport');
    },
    async capture(tabId) {
      const result = await read(tabId, 'visionCapture');
      if (!result?.data) throw Object.assign(new Error('Browser returned an empty screenshot'), { code: 'vision_capture_not_ready' });
      return `data:image/png;base64,${result.data}`;
    },
    async sendInput(tabId, method, params, { viewport, release = false } = {}) {
      // Cleanup must still release held native keys/buttons after cancellation.
      const owner = release ? firefoxBidi.runs.get(tabId) : await ownerFor(tabId);
      if (!owner || owner.disconnected) throw new Error('Firefox vision run disconnected');
      if (!release) check();
      return firefoxBidi.request('visionInput', { runId: owner.runId, method, params, viewport, release });
    },
  };
}
