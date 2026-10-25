import { firefoxBidi } from '../bidi/client.js';

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
      return firefoxBidi.request('visionViewport', { runId: owner.runId });
    },
    async capture(tabId) {
      const owner = await ownerFor(tabId);
      const result = await firefoxBidi.request('visionCapture', { runId: owner.runId });
      if (!result?.data) throw new Error('Browser returned an empty screenshot');
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
