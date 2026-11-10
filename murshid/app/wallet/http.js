'use strict';

// Network access for the wallet: block explorers and RPC nodes. Requests go
// through Chromium's network stack (so system proxies apply) in a session of
// their own, with no cookies or cache shared with browsing.

const PARTITION = 'murshid-wallet-network';
const TIMEOUT_MS = 20000;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

let walletSession = null;

function defaultFetch() {
  const { session } = require('electron');
  if (!walletSession) walletSession = session.fromPartition(PARTITION, { cache: false });
  return (url, init) => walletSession.fetch(url, init);
}

/**
 * fetch() for the wallet's own endpoints, with one timeout covering the whole
 * answer: a server that sends its headers and then stalls on the body is
 * given up on too, so the next endpoint gets its turn. The body is read here
 * and handed on in full.
 */
function createFetch(base = null, { timeoutMs = TIMEOUT_MS } = {}) {
  // The wallet's session is made on its first request, not while Murshid
  // starts: a session created before WebBrain loads stops WebBrain's
  // service worker from registering.
  const inner = base || ((url, init) => defaultFetch()(url, init));
  return async function walletFetch(url, init = {}) {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`no complete answer within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    // A caller's own signal (viem has its timeout) still works alongside ours.
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      const res = await Promise.race([inner(url, { ...init, signal, credentials: 'omit' }), timedOut]);
      const body = await Promise.race([res.arrayBuffer(), timedOut]);
      return new Response(NULL_BODY.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createFetch };
