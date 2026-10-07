/**
 * Offscreen document — outbound WebSocket bridge for MCP and other local
 * controllers.
 *
 * The selected local controller listens on localhost. The extension connects
 * outbound from this offscreen page, receives command messages, forwards them
 * to the background service worker, then returns the response over the socket.
 */

(() => {
  // Provisioning seeds Settings from a privileged extension page before this
  // bridge starts. Keep configuration mutations out of the WebSocket command
  // surface; the bridge is intentionally limited to managed run operations.
  const BRIDGE_PROTOCOL_VERSION = 2;
  const BRIDGE_CAPABILITIES = ['saved_workflows_v1', 'run_modes_v1', 'scheduled_jobs_v1', 'private_results_v1'];
  const ALLOWED_BRIDGE_ACTIONS = new Set([
    'cloud_run',
    'cloud_workflow_compile',
    'cloud_workflow_run',
    'cloud_status',
    'cloud_scheduled_jobs',
    'cloud_respond',
    'cloud_abort',
  ]);
  let socket = null;
  let bridgeUrl = null;
  let enabled = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lastError = '';
  // Browser registration/approval. Identity is pushed by the background worker
  // with `cloud-bridge-start` (the offscreen page has no storage access). When
  // a token is configured the backend must approve each new socket before any
  // cloud_* command runs; without a token the legacy local behaviour is kept.
  let identity = { token: '', browserId: '', installationId: '', extensionVersion: '' };
  let approval = 'not_required'; // not_required | pending | approved | rejected

  function browserInfo() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const match = /(Edg|Firefox|Chrome)\/([\d.]+)/.exec(ua);
    const names = { Edg: 'Edge', Firefox: 'Firefox', Chrome: 'Chrome' };
    return { name: match ? names[match[1]] : 'unknown', version: match ? match[2] : '' };
  }

  function platformName() {
    if (typeof navigator === 'undefined') return '';
    return navigator.userAgentData?.platform || navigator.platform || '';
  }

  function normalizeBridgeUrl(value) {
    const url = new URL(String(value || 'ws://127.0.0.1:17374/extension'));
    const host = url.hostname.toLowerCase();
    // WHATWG URL keeps the brackets on IPv6 literals: ws://[::1]/… parses to
    // hostname "[::1]", so both spellings must be allowlisted.
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      throw new Error('MCP URL must use ws:// on localhost.');
    }
    return url.href;
  }

  function status() {
    return {
      enabled,
      url: bridgeUrl,
      browserId: identity.browserId || null,
      installationId: identity.installationId || null,
      approval,
      connected: socket?.readyState === WebSocket.OPEN,
      readyState: socket ? socket.readyState : null,
      reconnectAttempt,
      lastError,
    };
  }

  function sendJson(obj, target = socket) {
    if (!target || target.readyState !== WebSocket.OPEN) return;
    try {
      target.send(JSON.stringify(obj));
    } catch (e) {
      lastError = e.message || String(e);
    }
  }

  function scheduleReconnect() {
    if (!enabled || !bridgeUrl || reconnectTimer) return;
    const delay = Math.min(30000, 500 * Math.pow(2, reconnectAttempt++));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!enabled || !bridgeUrl) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    try {
      const nextSocket = new WebSocket(bridgeUrl);
      socket = nextSocket;
      nextSocket.addEventListener('open', () => {
        if (socket !== nextSocket) return;
        reconnectAttempt = 0;
        lastError = '';
        // Every new socket starts unapproved; approval never carries over.
        approval = identity.token ? 'pending' : 'not_required';
        const hello = {
          type: 'hello',
          client: 'webbrain-extension',
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          capabilities: BRIDGE_CAPABILITIES,
          browser: browserInfo(),
          extensionVersion: identity.extensionVersion,
          platform: platformName(),
          status: status(),
        };
        if (identity.token) {
          hello.auth = { type: 'bearer', token: identity.token };
          hello.browserId = identity.browserId;
          hello.installationId = identity.installationId;
        }
        sendJson(hello, nextSocket);
      });
      nextSocket.addEventListener('message', async (event) => {
        if (socket !== nextSocket) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          sendJson({ ok: false, error: `Invalid JSON message: ${e.message}` }, nextSocket);
          return;
        }

        if (msg.type === 'connection_pending' || msg.type === 'connection_approved' || msg.type === 'connection_rejected') {
          if (!identity.token) return;
          if (msg.browserId && msg.browserId !== identity.browserId) return;
          if (msg.type === 'connection_pending') {
            if (approval !== 'approved') approval = 'pending';
          } else if (msg.type === 'connection_approved') {
            approval = 'approved';
            lastError = '';
          } else {
            approval = 'rejected';
            lastError = String(msg.reason || 'Connection rejected by backend');
            // A backoff timer from an earlier socket must not reconnect a rejected browser.
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            try { nextSocket.close(); } catch {}
          }
          return;
        }

        const id = msg.id || null;
        const action = msg.action || msg.command;
        const payload = msg.payload || msg;
        if (!action) {
          sendJson({ id, ok: false, error: 'Missing action' }, nextSocket);
          return;
        }
        if (!ALLOWED_BRIDGE_ACTIONS.has(action)) {
          sendJson({ id, ok: false, error: `Unsupported cloud bridge action: ${action}` }, nextSocket);
          return;
        }

        if (identity.token && approval !== 'approved') {
          sendJson({ id, ok: false, error: 'Connection not approved', code: 'connection_not_approved', status: 403 }, nextSocket);
          return;
        }

        try {
          const response = await chrome.runtime.sendMessage({
            ...payload,
            target: 'background',
            action,
          });
          const isRunSnapshot = !!response
            && (response.runId != null || response.run_id != null)
            && typeof response.status === 'string';
          if (response?.error && !isRunSnapshot) {
            sendJson({ id, ok: false, error: response.error, status: response.status || 500 }, nextSocket);
          } else {
            sendJson({ id, ok: true, result: response }, nextSocket);
          }
        } catch (e) {
          sendJson({ id, ok: false, error: e.message || String(e) }, nextSocket);
        }
      });
      nextSocket.addEventListener('close', () => {
        if (socket !== nextSocket) return;
        socket = null;
        // A rejected browser stays rejected until the settings change.
        if (approval === 'rejected') return;
        approval = identity.token ? 'pending' : 'not_required';
        scheduleReconnect();
      });
      nextSocket.addEventListener('error', () => {
        if (socket !== nextSocket) return;
        lastError = 'WebSocket error';
      });
    } catch (e) {
      lastError = e.message || String(e);
      socket = null;
      scheduleReconnect();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'cloud-bridge-start') {
      let nextUrl;
      try {
        nextUrl = normalizeBridgeUrl(msg.url || bridgeUrl);
      } catch (error) {
        lastError = error.message || String(error);
        sendResponse({ ...status(), error: lastError });
        return false;
      }
      const nextIdentity = {
        token: String(msg.token || ''),
        browserId: String(msg.browserId || ''),
        installationId: String(msg.installationId || ''),
        extensionVersion: String(msg.extensionVersion || ''),
      };
      const identityChanged = JSON.stringify(nextIdentity) !== JSON.stringify(identity);
      const changed = (bridgeUrl && bridgeUrl !== nextUrl) || identityChanged;
      enabled = true;
      bridgeUrl = nextUrl;
      identity = nextIdentity;
      if (identityChanged) {
        approval = identity.token ? 'pending' : 'not_required';
        reconnectAttempt = 0;
      }
      if (changed && socket) {
        const previousSocket = socket;
        socket = null;
        try { previousSocket.close(); } catch {}
      }
      connect();
      sendResponse(status());
      return false;
    }
    if (msg.type === 'cloud-bridge-stop') {
      enabled = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectAttempt = 0;
      if (socket) {
        const previousSocket = socket;
        socket = null;
        try { previousSocket.close(); } catch {}
      }
      sendResponse(status());
      return false;
    }
    if (msg.type === 'cloud-bridge-status') {
      sendResponse(status());
      return false;
    }
    return false;
  });
})();
