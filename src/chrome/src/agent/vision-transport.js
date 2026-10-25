import { cdpClient } from '../cdp/cdp-client.js';

const TRANSIENT_CAPTURE_CODES = new Set(['vision_stale_frame', 'vision_capture_context_changed', 'vision_capture_not_ready']);
export function isTransientVisionCaptureError(error) {
  return error?.name !== 'AbortError' && TRANSIENT_CAPTURE_CODES.has(error?.code);
}
// Classification is confined to read-only viewport/screenshot requests. In
// particular, never apply these patterns to native input or privacy failures.
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

// Inspect only the 24-byte PNG signature/IHDR prefix, without decoding or
// allocating a screenshot bitmap. CaptureScreenshot always returns PNG here.
export function visionPngDimensions(base64) {
  let header;
  try { header = atob(String(base64).slice(0, 32)); } catch { throw new Error('Invalid viewport PNG header'); }
  if (header.length !== 24 || header.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || header.slice(12, 16) !== 'IHDR')
    throw new Error('Invalid viewport PNG header');
  const integer = offset => header.charCodeAt(offset) * 16777216 + header.charCodeAt(offset + 1) * 65536
    + header.charCodeAt(offset + 2) * 256 + header.charCodeAt(offset + 3);
  const width = integer(16), height = integer(20);
  if (!(width > 0 && height > 0)) throw new Error('Empty viewport PNG');
  return { width, height };
}

export function createVisionTransport({ signal, viewportExpression }) {
  const check = () => { if (signal?.aborted) throw Object.assign(new Error('Vision run stopped'), { name: 'AbortError' }); };
  const read = async (tabId, method, params = {}) => {
    try {
      check(); await cdpClient.attach(tabId); check();
      return await cdpClient.sendCommand(tabId, method, params);
    } catch (error) {
      const classified = classifyVisionCaptureError(error);
      // CDP uses this one message for both navigation and a closed target.
      // Only retry its read when the extension still owns a live browser tab.
      if (!classified.code && /inspected target navigated or closed/i.test(classified.message)
        && typeof globalThis.chrome?.tabs?.get === 'function') {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        check();
        if (tab?.id === tabId && !tab.discarded) classified.code = 'vision_capture_context_changed';
      }
      throw classified;
    }
  };
  return {
    async readViewport(tabId) {
      const [metrics, frames, result] = await Promise.all([
        read(tabId, 'Page.getLayoutMetrics'), read(tabId, 'Page.getFrameTree'),
        read(tabId, 'Runtime.evaluate', { expression: viewportExpression, returnByValue: true, timeout: 2000 }),
      ]);
      if (result?.exceptionDetails || !result?.result?.value)
        throw Object.assign(new Error('Cannot read viewport geometry while the page is loading'), { code: 'vision_capture_not_ready' });
      const local = result.result.value;
      const viewport = metrics.cssVisualViewport;
      const root = frames.frameTree?.frame;
      if (!viewport || !root?.loaderId)
        throw Object.assign(new Error('Browser has not provided a committed document and CSS viewport yet'), { code: 'vision_capture_not_ready' });
      return { ...local, width: viewport.clientWidth, height: viewport.clientHeight,
        offsetLeft: viewport.offsetX, offsetTop: viewport.offsetY,
        scrollX: viewport.pageX, scrollY: viewport.pageY, scale: viewport.scale, zoom: viewport.zoom || 1,
        documentId: root.loaderId, url: root.url };
    },
    async capture(tabId, viewport) {
      // Explicit CSS clipping avoids compositor surface clipping when the
      // browser window, emulated viewport and screen resolution differ. This
      // is still precisely the visible viewport, never a full-page capture.
      // Chromium's explicit clip path resets pinch zoom, even when the clip
      // matches the visual viewport. Preserve pinch with its compositor path.
      const pinched = Math.abs(viewport.scale - 1) > 0.001;
      const result = await read(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: !pinched,
        ...(!pinched ? { clip: { x: viewport.scrollX, y: viewport.scrollY, width: viewport.width, height: viewport.height, scale: 1 } } : {}) });
      if (!result?.data) throw Object.assign(new Error('Browser returned an empty screenshot'), { code: 'vision_capture_not_ready' });
      if (pinched) {
        const size = visionPngDimensions(result.data);
        const pixelScale = viewport.scale * viewport.devicePixelRatio;
        if (Math.abs(size.width - viewport.width * pixelScale) > 2 || Math.abs(size.height - viewport.height * pixelScale) > 2) {
          throw Object.assign(new Error('The pinched viewport screenshot was clipped. Resize the browser window or reset pinch zoom before continuing.'),
            { code: 'vision_capture_clipped' });
        }
      }
      return `data:image/png;base64,${result.data}`;
    },
    async sendInput(tabId, method, params, { release = false } = {}) {
      if (!release) check();
      if (!['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText'].includes(method)) throw new Error('Unsupported vision input command');
      if (!cdpClient.sessions.has(tabId)) throw new Error('Debugger session ended before vision input');
      // The regular CDP input wrapper resolves DOM receivers for the legacy AX
      // pipeline. VisionBrowser owns a geometry/document fence instead.
      return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, method, params, result => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message || String(error))); else resolve(result);
        });
      });
    },
  };
}
