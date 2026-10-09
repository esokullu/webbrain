/**
 * Outbound WebSocket bridge for MCP and other controllers (Firefox).
 *
 * Mirror of src/chrome/src/offscreen/cloud-bridge.js. Firefox MV2 has a
 * persistent background page and no offscreen documents, so the socket lives
 * in the background page and commands are handed to `dispatch` directly
 * instead of through runtime.sendMessage (a page does not receive its own
 * runtime messages). Keep the protocol identical to the Chrome file.
 */

export const BRIDGE_PROTOCOL_VERSION = 2;
const BRIDGE_CAPABILITIES = ['saved_workflows_v1', 'run_modes_v1', 'scheduled_jobs_v1', 'run_provider_v1', 'private_results_v1'];
const ALLOWED_BRIDGE_ACTIONS = new Set([
  'cloud_run',
  'cloud_workflow_compile',
  'cloud_workflow_run',
  'cloud_status',
  'cloud_scheduled_jobs',
  'cloud_respond',
  'cloud_abort',
]);

export function createCloudBridge({ dispatch, WebSocketImpl = globalThis.WebSocket, nav = globalThis.navigator } = {}) {
  let socket = null;
  let bridgeUrl = null;
  let enabled = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lastError = '';
  // With a token configured the backend must approve each new socket before
  // any cloud_* command runs; without one the legacy local behaviour is kept.
  let identity = { token: '', browserId: '', installationId: '', extensionVersion: '' };
  let approval = 'not_required'; // not_required | pending | approved | rejected

  function browserInfo() {
    const match = /(Edg|Firefox|Chrome)\/([\d.]+)/.exec(nav?.userAgent || '');
    const names = { Edg: 'Edge', Firefox: 'Firefox', Chrome: 'Chrome' };
    return { name: match ? names[match[1]] : 'unknown', version: match ? match[2] : '' };
  }

  function normalizeBridgeUrl(value) {
    const url = new URL(String(value || 'ws://127.0.0.1:17374/extension'));
    const host = url.hostname.toLowerCase();
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
      connected: socket?.readyState === WebSocketImpl.OPEN,
      readyState: socket ? socket.readyState : null,
      reconnectAttempt,
      lastError,
    };
  }

  function sendJson(obj, target = socket) {
    if (!target || target.readyState !== WebSocketImpl.OPEN) return;
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
    if (socket && (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING)) return;
    try {
      const nextSocket = new WebSocketImpl(bridgeUrl);
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
          platform: nav?.platform || '',
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
          const response = await dispatch({ ...payload, target: 'background', action });
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

  function start(msg = {}) {
    let nextUrl;
    try {
      nextUrl = normalizeBridgeUrl(msg.url || bridgeUrl);
    } catch (error) {
      lastError = error.message || String(error);
      return { ...status(), error: lastError };
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
    return status();
  }

  function stop() {
    enabled = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    if (socket) {
      const previousSocket = socket;
      socket = null;
      try { previousSocket.close(); } catch {}
    }
    return status();
  }

  return { start, stop, status };
}
