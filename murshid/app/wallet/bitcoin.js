'use strict';

// Bitcoin: balance, fees, and building, signing and broadcasting a payment,
// through public Esplora servers (mempool.space, then Blockstream). The wallet
// has one native SegWit (bc1q…) address; change goes back to it.

const btc = require('@scure/btc-signer');
const { hex } = require('@scure/base');
const { BITCOIN } = require('./networks');
const { WalletError } = require('./errors');

const RBF_SEQUENCE = 0xfffffffd; // lets a stuck payment be replaced with a higher fee elsewhere
const MAX_FEE_RATE = 1000; // sat/vB; anything above is a broken or hostile fee source
const SPEEDS = ['slow', 'normal', 'fast'];
// Nodes refuse outputs too small to be worth spending ("dust"): 294 sat for
// bc1q, up to 546 for older address types. The larger limit covers them all.
const DUST = 546n;

function validAddress(address) {
  if (typeof address !== 'string' || address.length > 100) return false;
  try {
    btc.Address(btc.NETWORK).decode(address.trim());
    return true;
  } catch {
    return false;
  }
}

class BitcoinClient {
  /** @param {typeof fetch} fetchFn */
  constructor(fetchFn) {
    this.fetch = fetchFn;
  }

  /** One Esplora call, trying each server in turn. */
  async call(path, { method = 'GET', body } = {}) {
    let lastError = null;
    for (const base of BITCOIN.api) {
      let res;
      try {
        res = await this.fetch(base + path, { method, body, headers: body ? { 'content-type': 'text/plain' } : undefined });
      } catch (error) {
        lastError = error;
        continue;
      }
      const text = await res.text().catch(() => '');
      if (res.ok) return text;
      // A refused broadcast is an answer, not an outage: the next server would refuse it too.
      if (method === 'POST' && res.status === 400) throw new WalletError('failed', text.slice(0, 300) || 'rejected');
      lastError = new Error(`HTTP ${res.status}`);
    }
    throw new WalletError('network', String(lastError?.message || lastError || 'unreachable'));
  }

  async json(path) {
    try {
      return JSON.parse(await this.call(path));
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError('network', 'unreadable answer');
    }
  }

  /** Confirmed balance and what is still unconfirmed (either way), in satoshis. */
  async balance(address) {
    const info = await this.json(`/address/${encodeURIComponent(address)}`);
    const sum = (stats) => BigInt(stats?.funded_txo_sum || 0) - BigInt(stats?.spent_txo_sum || 0);
    return { confirmed: sum(info.chain_stats), pending: sum(info.mempool_stats) };
  }

  async utxos(address) {
    const list = await this.json(`/address/${encodeURIComponent(address)}/utxo`);
    if (!Array.isArray(list)) throw new WalletError('network', 'unreadable answer');
    return list;
  }

  /** Fee rates in sat/vB for the three speeds. */
  async fees() {
    let rates = null;
    try {
      const r = JSON.parse(await this.fetchText(`${BITCOIN.api[0]}/v1/fees/recommended`));
      rates = { slow: r.hourFee, normal: r.halfHourFee, fast: r.fastestFee };
    } catch {
      // Blockstream has no "recommended" endpoint; it estimates per confirmation target.
      try {
        const e = JSON.parse(await this.fetchText(`${BITCOIN.api[1]}/fee-estimates`));
        rates = { slow: e['12'] ?? e['6'], normal: e['3'], fast: e['1'] };
      } catch {
        throw new WalletError('network', 'no fee estimate');
      }
    }
    const clean = {};
    for (const speed of SPEEDS) {
      const value = Number(rates[speed]);
      if (!Number.isFinite(value) || value <= 0) throw new WalletError('network', 'no fee estimate');
      clean[speed] = Math.min(MAX_FEE_RATE, Math.max(1, Math.ceil(value)));
    }
    return clean;
  }

  async fetchText(url) {
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  /** Sends a signed transaction; the answer is its id. */
  async broadcast(txHex) {
    const txid = (await this.call('/tx', { method: 'POST', body: txHex })).trim();
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new WalletError('failed', txid.slice(0, 200));
    return txid;
  }
}

/**
 * An unsigned payment. `amount` is in satoshis; with `max`, everything
 * confirmed goes to `to` and the fee comes out of it.
 */
function buildPayment({ address, publicKey, utxos, to, amount, max = false, feeRate }) {
  if (!validAddress(to)) throw new WalletError('invalidAddress');
  const spend = btc.p2wpkh(publicKey, btc.NETWORK);
  if (spend.address !== address) throw new WalletError('failed', 'key does not match the address');
  // Only confirmed coins: an unconfirmed incoming payment can still disappear.
  const inputs = utxos
    .filter((u) => u?.status?.confirmed && /^[0-9a-f]{64}$/i.test(u.txid) && Number.isSafeInteger(u.vout) && Number.isSafeInteger(u.value))
    .map((u) => ({
      ...spend,
      txid: hex.decode(u.txid),
      index: u.vout,
      witnessUtxo: { script: spend.script, amount: BigInt(u.value) },
      sequence: RBF_SEQUENCE,
    }));
  if (!max && !(typeof amount === 'bigint' && amount > 0n)) throw new WalletError('invalidAmount');
  if (!max && amount < DUST) throw new WalletError('dust');
  if (!inputs.length) throw new WalletError('insufficient');
  const options = {
    changeAddress: max ? to.trim() : address,
    feePerByte: BigInt(feeRate),
    bip69: true,
    createTx: true,
    network: btc.NETWORK,
  };
  let selected;
  try {
    selected = max
      ? btc.selectUTXO(inputs, [], 'all', options)
      : btc.selectUTXO(inputs, [{ address: to.trim(), amount }], 'default', options);
  } catch (error) {
    if (/dust/i.test(String(error?.message))) throw new WalletError('dust');
    throw new WalletError('failed', String(error?.message || error));
  }
  if (!selected?.tx || selected.fee === undefined) throw new WalletError(max ? 'dust' : 'insufficient');
  const sent = max ? selected.outputs.reduce((sum, o) => sum + o.amount, 0n) : amount;
  if (sent < DUST) throw new WalletError('dust');
  return { tx: selected.tx, fee: selected.fee, amount: sent, to: to.trim(), feeRate };
}

/** Signs an unsigned payment from buildPayment; gives its hex and id. */
function signPayment(payment, privateKey) {
  const tx = payment.tx.clone();
  tx.sign(privateKey);
  tx.finalize();
  return { hex: tx.hex, txid: tx.id };
}

module.exports = { BitcoinClient, buildPayment, signPayment, validAddress, SPEEDS, RBF_SEQUENCE };
