import { firefoxBidi } from '../bidi/client.js';

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
  const ownerFor = async tabId => {
    check();
    if (!firefoxBidi.runs.has(tabId)) {
      if (!pending.has(tabId)) pending.set(tabId, firefoxBidi.startRun(tabId, signal).finally(() => pending.delete(tabId)));
      await pending.get(tabId);
    }
    const owner = firefoxBidi.runs.get(tabId);
    if (!owner || owner.disconnected || owner.signal?.aborted)
      throw new Error('Vision input requires the Firefox trusted automation companion; enable it in Settings → Advanced');
    await firefoxBidi.bindRun(tabId, owner);
    check();
    if (!owner.bound) throw new Error('Navigate to a regular web page before vision capture');
    return owner;
  };
  return {
    validateText(text) {
      if (/[\uE000-\uE05D]/u.test(text)) throw new Error('Firefox cannot type reserved WebDriver control characters as literal text');
    },
    async readViewport(tabId) {
      const owner = await ownerFor(tabId);
      try { return await firefoxBidi.request('visionViewport', { runId: owner.runId }); }
      catch (error) { throw classifyVisionCaptureError(error); }
    },
    async capture(tabId) {
      const owner = await ownerFor(tabId);
      let result;
      try { result = await firefoxBidi.request('visionCapture', { runId: owner.runId }); }
      catch (error) { throw classifyVisionCaptureError(error); }
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
