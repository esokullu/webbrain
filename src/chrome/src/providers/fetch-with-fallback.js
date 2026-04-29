/**
 * fetch() wrapper that falls back to an offscreen document proxy
 * when the service worker can't reach the server directly.
 *
 * This solves Chrome MV3's Private Network Access restrictions that
 * block service worker fetch() to local network IPs (192.168.*, 10.*, etc.)
 * even with host_permissions and privateNetworkAccess.
 */

let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    // Check if offscreen document already exists
    const existing = await chrome.offscreen.hasDocument();
    if (existing) {
      offscreenReady = true;
      return;
    }
  } catch {
    // hasDocument not available in older Chrome — try creating anyway
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['LOCAL_STORAGE'], // closest available reason for networking
      justification: 'Proxy fetch requests to local network LLM servers',
    });
    offscreenReady = true;
  } catch (e) {
    // Already exists or not supported — either way, try sending messages
    if (e.message?.includes('already exists')) {
      offscreenReady = true;
    } else {
      throw e;
    }
  }
}

/**
 * Try direct fetch first. If it fails with a network error, retry
 * through the offscreen document proxy.
 *
 * The timeout aborts only the *connection / time-to-headers* phase. Once
 * fetch() resolves, the timer is cleared so streaming bodies can run as
 * long as needed. Without this, a stalled endpoint hangs the UI forever.
 *
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} options
 * @returns {Promise<Response>}
 */
export async function fetchWithFallback(url, options = {}) {
  const { timeoutMs = 60000, ...fetchOptions } = options;

  // Fast path: try direct fetch first, with a connection-phase timeout.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (directError) {
    clearTimeout(timeoutId);

    // If we aborted on timeout, surface that directly — don't fall through to
    // the offscreen proxy, since the same endpoint is likely unresponsive.
    if (directError.name === 'AbortError') {
      throw new Error(
        `Request to ${url} timed out after ${timeoutMs}ms. ` +
        `The endpoint may be unreachable, blocked by CORS, or stalled. ` +
        `Check the URL/credentials and that the server is responding.`
      );
    }

    // Network error (Failed to fetch) — try offscreen proxy
    console.warn(
      `[WebBrain] Direct fetch to ${url} failed (${directError.message}), trying offscreen proxy...`
    );

    try {
      await ensureOffscreen();

      // Race the proxy round-trip against the same timeout, since
      // chrome.runtime.sendMessage has no native cancellation.
      const proxyResult = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'offscreen-fetch',
          url,
          method: fetchOptions.method || 'POST',
          headers: fetchOptions.headers || {},
          body: fetchOptions.body || undefined,
          stream: false,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`offscreen proxy timed out after ${timeoutMs}ms`)),
            timeoutMs
          )
        ),
      ]);

      if (proxyResult.error) {
        throw new Error(
          `Both direct fetch and offscreen proxy failed for ${url}. ` +
          `Direct: ${directError.message}. Proxy: ${proxyResult.error}`
        );
      }

      // Wrap the proxy response to look like a fetch Response
      return new Response(proxyResult.body, {
        status: proxyResult.status,
        statusText: proxyResult.ok ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (proxyError) {
      // Offscreen proxy also failed — throw the most useful error
      if (proxyError.message?.includes('Both direct')) {
        throw proxyError;
      }
      throw new Error(
        `Could not reach ${url}. Direct: ${directError.message}. ` +
        `Offscreen proxy: ${proxyError.message}. ` +
        `If the server is on your local network, make sure it has CORS enabled ` +
        `(vLLM: --allowed-origins \'["*"]\', Ollama: OLLAMA_ORIGINS=*).`
      );
    }
  }
}
