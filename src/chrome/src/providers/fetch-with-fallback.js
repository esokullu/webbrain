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
 * @param {string} url
 * @param {RequestInit} options
 * @returns {Promise<Response>}
 */
export async function fetchWithFallback(url, options = {}) {
  // Fast path: try direct fetch first
  try {
    const res = await fetch(url, options);
    return res;
  } catch (directError) {
    // Network error (Failed to fetch) — try offscreen proxy
    console.warn(
      `[WebBrain] Direct fetch to ${url} failed (${directError.message}), trying offscreen proxy...`
    );

    try {
      await ensureOffscreen();

      const proxyResult = await chrome.runtime.sendMessage({
        type: 'offscreen-fetch',
        url,
        method: options.method || 'POST',
        headers: options.headers || {},
        body: options.body || undefined,
        stream: false,
      });

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
