'use strict';

// window.ethereum for websites (EIP-1193), announced the modern way too
// (EIP-6963). Registered on the browsing session only while a wallet exists
// (app/wallet/install.js), and active only in top-level http(s) pages.
//
// The page-side half is serialized and run with contextBridge.executeInMainWorld,
// so it must not close over anything in this file.

const { contextBridge, ipcRenderer } = require('electron');

function installEthereum(initial) {
  const bridge = globalThis.__murshidEthereum;
  try { delete globalThis.__murshidEthereum; } catch {}
  if (!bridge || !initial) return;

  let state = { chainId: initial.chainId, accounts: initial.accounts || [], unlocked: Boolean(initial.unlocked) };
  const listeners = new Map();

  class ProviderRpcError extends Error {
    constructor(code, message, data) {
      super(message);
      this.code = code;
      if (data !== undefined) this.data = data;
    }
  }

  function emit(event, ...args) {
    const set = listeners.get(event);
    if (!set) return false;
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry);
      try { entry.fn.apply(provider, args); } catch (error) { console.error(error); }
    }
    return true;
  }

  function addListener(event, fn, once = false) {
    if (typeof fn !== 'function') throw new TypeError('The listener must be a function.');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add({ fn, once });
    return provider;
  }

  function removeListener(event, fn) {
    const set = listeners.get(event);
    if (set) for (const entry of set) if (entry.fn === fn) set.delete(entry);
    return provider;
  }

  async function request(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ProviderRpcError(-32600, 'Expected a single, non-array, object argument.');
    const { method, params } = args;
    if (typeof method !== 'string' || !method) throw new ProviderRpcError(-32600, "'args.method' must be a non-empty string.");
    if (params !== undefined && (params === null || typeof params !== 'object')) throw new ProviderRpcError(-32600, "'args.params' must be an object or array if provided.");
    let payload;
    try {
      // Through the context bridge only plain data survives.
      payload = params === undefined ? undefined : JSON.parse(JSON.stringify(params));
    } catch {
      throw new ProviderRpcError(-32602, 'The parameters could not be read.');
    }
    const answer = await bridge.request(method, payload);
    if (answer && answer.error) throw new ProviderRpcError(answer.error.code, answer.error.message, answer.error.data);
    return answer ? answer.result : undefined;
  }

  // The old ways of asking, which some sites still use.
  function sendAsync(payload, callback) {
    if (Array.isArray(payload)) {
      Promise.all(payload.map((p) => new Promise((resolve) => sendAsync(p, (_e, r) => resolve(r))))).then((r) => callback(null, r));
      return;
    }
    request({ method: payload && payload.method, params: payload && payload.params }).then(
      (result) => callback(null, { id: payload.id, jsonrpc: '2.0', result }),
      (error) => callback(error, { id: payload && payload.id, jsonrpc: '2.0', error: { code: error.code, message: error.message, data: error.data } }),
    );
  }

  function send(methodOrPayload, paramsOrCallback) {
    if (typeof methodOrPayload === 'string') return request({ method: methodOrPayload, params: paramsOrCallback });
    if (typeof paramsOrCallback === 'function') return sendAsync(methodOrPayload, paramsOrCallback);
    const method = methodOrPayload && methodOrPayload.method;
    if (method === 'eth_accounts') return { id: methodOrPayload.id, jsonrpc: '2.0', result: state.accounts.slice() };
    if (method === 'eth_chainId') return { id: methodOrPayload.id, jsonrpc: '2.0', result: state.chainId };
    if (method === 'net_version') return { id: methodOrPayload.id, jsonrpc: '2.0', result: String(parseInt(state.chainId, 16)) };
    throw new ProviderRpcError(4200, `Use ethereum.request() for ${method}.`);
  }

  const provider = {
    isMurshid: true,
    // Many sites only offer "MetaMask" for a browser wallet; Brave and Rabby answer to it too.
    isMetaMask: true,
    get chainId() { return state.chainId; },
    get networkVersion() { return String(parseInt(state.chainId, 16)); },
    get selectedAddress() { return state.accounts[0] || null; },
    isConnected: () => true,
    request,
    send,
    sendAsync,
    enable: () => request({ method: 'eth_requestAccounts' }),
    on: (event, fn) => addListener(event, fn),
    addListener: (event, fn) => addListener(event, fn),
    once: (event, fn) => addListener(event, fn, true),
    prependListener: (event, fn) => addListener(event, fn),
    removeListener,
    off: removeListener,
    removeAllListeners: (event) => { if (event === undefined) listeners.clear(); else listeners.delete(event); return provider; },
    listenerCount: (event) => (listeners.get(event) ? listeners.get(event).size : 0),
    listeners: (event) => [...(listeners.get(event) || [])].map((entry) => entry.fn),
    emit,
    _metamask: { isUnlocked: () => Promise.resolve(state.unlocked) },
  };

  bridge.onEvent((next) => {
    if (!next || typeof next.chainId !== 'string') return;
    const before = state;
    state = { chainId: next.chainId, accounts: Array.isArray(next.accounts) ? next.accounts.slice() : [], unlocked: Boolean(next.unlocked) };
    if (state.chainId !== before.chainId) {
      emit('chainChanged', state.chainId);
      emit('networkChanged', String(parseInt(state.chainId, 16)));
    }
    if (state.accounts.join() !== before.accounts.join()) emit('accountsChanged', state.accounts.slice());
  });

  try {
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true, enumerable: true });
  } catch {}

  const info = Object.freeze({ uuid: crypto.randomUUID(), name: 'Murshid Wallet', icon: initial.icon, rdns: 'one.webbrain.murshid' });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  setTimeout(() => emit('connect', { chainId: state.chainId }), 0);
  window.dispatchEvent(new Event('ethereum#initialized'));
}

if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && window.top === window) {
  let initial = null;
  try { initial = ipcRenderer.sendSync('murshid-ethereum-init'); } catch {}
  if (initial) {
    try {
      contextBridge.exposeInMainWorld('__murshidEthereum', {
        request: (method, params) => ipcRenderer.invoke('murshid-ethereum', method, params),
        onEvent: (callback) => ipcRenderer.on('murshid-ethereum-event', (_event, state) => callback(state)),
      });
      contextBridge.executeInMainWorld({ func: installEthereum, args: [initial] });
    } catch (error) {
      console.error('[murshid] wallet provider failed:', error);
    }
  }
}
