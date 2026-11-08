'use strict';

// Network access for the wallet: block explorers and RPC nodes. Requests go
// through Chromium's network stack (so system proxies apply) in a session of
// their own, with no cookies or cache shared with browsing.

const PARTITION = 'murshid-wallet-network';
const TIMEOUT_MS = 20000;

let walletSession = null;

function defaultFetch() {
  const { session } = require('electron');
  if (!walletSession) walletSession = session.fromPartition(PARTITION, { cache: false });
  return (url, init) => walletSession.fetch(url, init);
}

/** fetch() with a timeout, for one of the wallet's own endpoints. */
function createFetch(base = null) {
  const inner = base || defaultFetch();
  return async function walletFetch(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await inner(url, { ...init, signal: controller.signal, credentials: 'omit' });
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createFetch };
