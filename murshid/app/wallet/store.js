'use strict';

// The wallet itself: the encrypted file in the profile folder, locking and
// unlocking, the networks, connected sites, transfers, and the queue of
// requests from websites waiting for the user's approval.
//
// Nothing here knows about windows or IPC (app/wallet/install.js does that),
// so it can be tested with plain Node.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { formatUnits, parseUnits } = require('viem');
const encodeQR = require('@paulmillr/qr').default;
const vault = require('./vault');
const { WalletError } = vault;
const networks = require('./networks');
const { BitcoinClient, buildPayment, signPayment, validAddress: validBitcoinAddress, SPEEDS } = require('./bitcoin');
const { EvmClient, validAddress: validEvmAddress } = require('./evm');

const FILE = 'murshid-wallet.json';
const AUTO_LOCK_MS = 30 * 60 * 1000;
const REVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_REQUESTS_PER_SITE = 5;

/** "0.00012300" → "0.000123"; at most `fraction` decimals, rounded down. */
function displayAmount(value, decimals, fraction = decimals) {
  const text = formatUnits(value, decimals);
  const [whole, part = ''] = text.split('.');
  const cut = part.slice(0, fraction).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

/** A fee: eight decimals, or three significant digits when it is smaller than that (L2 fees are). */
function displayFee(value, decimals) {
  const short = displayAmount(value, decimals, 8);
  if (value === 0n || short !== '0') return short;
  const part = formatUnits(value, decimals).split('.')[1] || '';
  const first = part.search(/[1-9]/);
  return displayAmount(value, decimals, first + 3);
}

/** What someone typed as an amount, in base units; "0,5" is read as 0.5. */
function parseAmount(text, decimals) {
  let s = String(text ?? '').trim().replace(/\s/g, '');
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) throw new WalletError('invalidAmount');
  const fraction = s.split('.')[1] || '';
  if (fraction.length > decimals) throw new WalletError('invalidAmount');
  const value = parseUnits(s.startsWith('.') ? `0${s}` : s, decimals);
  if (value <= 0n) throw new WalletError('invalidAmount');
  return value;
}

function originHost(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

class Wallet extends EventEmitter {
  /**
   * @param {{dir: string, fetchFn: typeof fetch, now?: () => number}} options
   */
  constructor({ dir, fetchFn, now = Date.now }) {
    super();
    this.file = path.join(dir, FILE);
    this.now = now;
    this.data = null;
    this.unreadable = false;
    this.keys = null;
    this.pendingPhrase = null;
    this.requests = new Map(); // id -> request from a website
    this.reviews = new Map(); // id -> transfer shown for confirmation
    this.lockTimer = null;
    this.bitcoin = new BitcoinClient(fetchFn);
    this.evm = new EvmClient(fetchFn);
    this.load();
  }

  // ---------------------------------------------------------------- file

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // no wallet yet
    }
    try {
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !data.vault || !data.addresses?.bitcoin || !data.addresses?.evm) throw new Error('shape');
      this.data = {
        ...data,
        network: networks.byId(data.network)?.id || networks.BITCOIN.id,
        evmChainId: networks.byChainId(data.evmChainId)?.chainId || networks.DEFAULT_EVM.chainId,
        sites: data.sites && typeof data.sites === 'object' ? data.sites : {},
      };
    } catch {
      // Never overwrite a file we cannot read: it may be someone's only copy.
      this.unreadable = true;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get exists() {
    return Boolean(this.data);
  }

  get unlocked() {
    return Boolean(this.keys);
  }

  changed() {
    this.emit('changed');
  }

  // --------------------------------------------------------------- setup

  /** Twelve new words, held until the wallet is created with them. */
  createPhrase() {
    if (this.exists) throw new WalletError('failed', 'a wallet already exists');
    this.pendingPhrase = vault.newPhrase();
    this.changed();
    return this.pendingPhrase.split(' ');
  }

  cancelCreate() {
    this.pendingPhrase = null;
    this.changed();
  }

  async finishCreate(password) {
    if (!this.pendingPhrase) throw new WalletError('failed', 'no recovery phrase to save');
    await this.setup(this.pendingPhrase, password);
    this.pendingPhrase = null;
    this.changed();
  }

  async importPhrase(phrase, password) {
    if (!vault.validPhrase(phrase)) throw new WalletError('invalidPhrase');
    await this.setup(vault.normalizePhrase(phrase), password);
  }

  async setup(phrase, password) {
    if (this.exists) throw new WalletError('failed', 'a wallet already exists');
    vault.checkPassword(password);
    const box = await vault.seal(phrase, password);
    const keys = vault.deriveKeys(phrase);
    if (this.unreadable && fs.existsSync(this.file)) {
      fs.renameSync(this.file, `${this.file}.unreadable-${this.now()}`);
      this.unreadable = false;
    }
    this.data = {
      version: 1,
      vault: box,
      addresses: { bitcoin: keys.bitcoin.address, evm: keys.evm.address },
      network: networks.BITCOIN.id,
      evmChainId: networks.DEFAULT_EVM.chainId,
      sites: {},
      createdAt: new Date(this.now()).toISOString(),
    };
    this.save();
    this.setKeys(keys);
    this.emit('created');
  }

  // ------------------------------------------------------- lock / unlock

  async unlock(password) {
    if (!this.exists) throw new WalletError('failed', 'no wallet');
    const phrase = await vault.open(this.data.vault, password);
    const keys = vault.deriveKeys(phrase);
    if (keys.bitcoin.address !== this.data.addresses.bitcoin || keys.evm.address !== this.data.addresses.evm) {
      vault.wipeKeys(keys);
      throw new WalletError('failed', 'the wallet file does not match its keys');
    }
    this.setKeys(keys);
  }

  setKeys(keys) {
    if (this.keys && this.keys !== keys) vault.wipeKeys(this.keys);
    this.keys = keys;
    this.touch();
    // A site that was connected before the wallet locked needs nothing more.
    for (const request of [...this.requests.values()]) {
      if (request.kind === 'connect' && this.isConnected(request.origin)) this.settle(request, null, this.accountsFor(request.origin));
    }
    this.emit('sites');
    this.changed();
  }

  lock() {
    if (!this.keys) return;
    vault.wipeKeys(this.keys);
    this.keys = null;
    this.reviews.clear();
    clearTimeout(this.lockTimer);
    this.lockTimer = null;
    this.emit('sites');
    this.changed();
  }

  /** Keeps the wallet unlocked for a while longer. */
  touch() {
    if (!this.keys) return;
    clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), AUTO_LOCK_MS);
    this.lockTimer.unref?.();
  }

  requireKeys() {
    if (!this.keys) throw new WalletError('locked');
    this.touch();
    return this.keys;
  }

  async revealPhrase(password) {
    if (!this.exists) throw new WalletError('failed', 'no wallet');
    return (await vault.open(this.data.vault, password)).split(' ');
  }

  /** Erases the wallet from this computer. */
  reset() {
    this.lock();
    for (const request of [...this.requests.values()]) this.settle(request, new WalletError('disconnected'));
    try { fs.rmSync(this.file, { force: true }); } catch {}
    this.data = null;
    this.unreadable = false;
    this.pendingPhrase = null;
    this.emit('reset');
    this.emit('sites');
    this.changed();
  }

  // ------------------------------------------------------------ networks

  network() {
    return networks.byId(this.data?.network) || networks.BITCOIN;
  }

  /** The EVM network websites see (eth_chainId). */
  evmNetwork() {
    return networks.byChainId(this.data?.evmChainId) || networks.DEFAULT_EVM;
  }

  setNetwork(id) {
    const net = networks.byId(id);
    if (!net || !this.exists) throw new WalletError('failed', 'unknown network');
    this.data.network = net.id;
    if (net.kind === 'evm') this.data.evmChainId = net.chainId;
    this.save();
    this.emit('sites');
    this.changed();
  }

  setEvmChain(chainId) {
    const net = networks.byChainId(chainId);
    if (!net || !this.exists) throw new WalletError('failed', 'unknown network');
    this.data.evmChainId = net.chainId;
    // The wallet page follows when it is showing an EVM network.
    if (this.network().kind === 'evm') this.data.network = net.id;
    this.save();
    this.emit('sites');
    this.changed();
  }

  // --------------------------------------------------------------- sites

  isConnected(origin) {
    return Boolean(this.data?.sites && Object.hasOwn(this.data.sites, origin));
  }

  connect(origin) {
    if (!this.exists) throw new WalletError('failed', 'no wallet');
    this.data.sites[origin] = { since: new Date(this.now()).toISOString() };
    this.save();
    this.emit('sites');
    this.changed();
  }

  disconnect(origin) {
    if (!this.isConnected(origin)) return;
    delete this.data.sites[origin];
    this.save();
    this.emit('sites');
    this.changed();
  }

  /** The accounts a site may see: the Ethereum address once it is connected and the wallet is unlocked. */
  accountsFor(origin) {
    return this.keys && this.isConnected(origin) ? [this.keys.evm.address] : [];
  }

  /** What window.ethereum knows about itself on a page from this origin. */
  siteState(origin) {
    const net = this.evmNetwork();
    return { chainId: net.hexChainId, accounts: this.accountsFor(origin), unlocked: this.unlocked };
  }

  // ------------------------------------------------- balances and receive

  async balance(id) {
    const net = networks.byId(id);
    if (!net || !this.exists) throw new WalletError('failed', 'unknown network');
    const show = (v) => displayAmount(v, net.decimals, net.kind === 'bitcoin' ? 8 : 6);
    if (net.kind === 'bitcoin') {
      const { confirmed, pending } = await this.bitcoin.balance(this.data.addresses.bitcoin);
      return { network: net.id, symbol: net.symbol, value: show(confirmed), exact: displayAmount(confirmed, 8), pending: pending ? `${pending > 0n ? '+' : '-'}${show(pending < 0n ? -pending : pending)}` : null };
    }
    const value = await this.evm.balance(net, this.data.addresses.evm);
    return { network: net.id, symbol: net.symbol, value: show(value), exact: displayAmount(value, 18), pending: null };
  }

  receive(id) {
    const net = networks.byId(id);
    if (!net || !this.exists) throw new WalletError('failed', 'unknown network');
    const address = net.kind === 'bitcoin' ? this.data.addresses.bitcoin : this.data.addresses.evm;
    // BIP21 for Bitcoin; a bare address for Ethereum, which every wallet's scanner reads.
    const uri = net.kind === 'bitcoin' ? `bitcoin:${address}` : address;
    const svg = encodeQR(uri, 'svg', { ecc: 'medium', border: 1 });
    return { network: net.id, address, uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, explorer: net.addressUrl(address) };
  }

  bitcoinFees() {
    return this.bitcoin.fees();
  }

  // ------------------------------------------------------------- sending

  /** Builds a transfer and keeps it, unsigned, for the user to confirm. */
  async review({ network, to, amount, max = false, speed = 'normal' } = {}) {
    const keys = this.requireKeys();
    const net = networks.byId(network);
    if (!net) throw new WalletError('failed', 'unknown network');
    const target = String(to || '').trim();
    const valid = net.kind === 'bitcoin' ? validBitcoinAddress(target) : validEvmAddress(target);
    if (!valid) throw new WalletError('invalidAddress');
    const value = max ? null : parseAmount(amount, net.decimals);
    let review;
    if (net.kind === 'bitcoin') {
      if (!SPEEDS.includes(speed)) throw new WalletError('failed', 'unknown speed');
      const [utxos, fees] = await Promise.all([this.bitcoin.utxos(keys.bitcoin.address), this.bitcoin.fees()]);
      const payment = buildPayment({
        address: keys.bitcoin.address, publicKey: keys.bitcoin.publicKey, utxos, to: target, amount: value, max, feeRate: fees[speed],
      });
      review = { net, payment, amount: payment.amount, fee: payment.fee, feeRate: payment.feeRate };
    } else {
      const account = keys.evm.account;
      let prepared;
      if (max) {
        const balance = await this.evm.balance(net, account.address);
        prepared = await this.evm.prepareMax(net, account, target, balance);
      } else {
        prepared = await this.evm.prepare(net, account, { to: target, value });
        const balance = await this.evm.balance(net, account.address);
        if (balance < value + prepared.fee) throw new WalletError('insufficient');
      }
      review = { net, prepared, amount: prepared.request.value, fee: prepared.fee };
    }
    const id = randomUUID();
    this.reviews.set(id, { ...review, id, to: target, expires: this.now() + REVIEW_TTL_MS });
    for (const [other, r] of this.reviews) if (r.expires < this.now()) this.reviews.delete(other);
    return {
      id,
      network: net.id,
      symbol: net.symbol,
      to: target,
      amount: displayAmount(review.amount, net.decimals),
      fee: displayFee(review.fee, net.decimals),
      total: displayAmount(review.amount + review.fee, net.decimals),
      feeRate: review.feeRate ?? null,
      feeIsMaximum: net.kind === 'evm',
    };
  }

  cancelReview(id) {
    this.reviews.delete(id);
  }

  /** Signs and sends a transfer the user reviewed. */
  async confirm(id) {
    const keys = this.requireKeys();
    const review = this.reviews.get(id);
    this.reviews.delete(id);
    if (!review || review.expires < this.now()) throw new WalletError('expired');
    let hash;
    if (review.net.kind === 'bitcoin') {
      const signed = signPayment(review.payment, keys.bitcoin.privateKey);
      hash = await this.bitcoin.broadcast(signed.hex);
    } else {
      hash = await this.evm.send(review.net, keys.evm.account, review.prepared);
    }
    const url = review.net.txUrl(hash);
    this.emit('notice', { kind: 'sent', url });
    return { hash, url };
  }

  // ------------------------------------------- requests from websites

  /**
   * Queues a website's request for approval. `perform` runs once the user
   * approves (with the wallet unlocked); what it returns goes to the site.
   *
   * @param {string} kind connect | sign | typed | transaction | switch
   * @param {{origin: string, contentsId?: number}} site
   * @param {object} details what the approval card shows (plain data)
   * @param {() => Promise<any>} perform
   */
  request(kind, site, details, perform) {
    if (!this.exists) return Promise.reject(new WalletError('disconnected'));
    const fromSite = [...this.requests.values()].filter((r) => r.origin === site.origin);
    if (kind === 'connect') {
      // A second "connect" while one is waiting answers with the first.
      const waiting = fromSite.find((r) => r.kind === 'connect');
      if (waiting) return new Promise((resolve, reject) => waiting.followers.push({ resolve, reject }));
    }
    if (fromSite.length >= MAX_REQUESTS_PER_SITE) return Promise.reject(new WalletError('busy'));
    return new Promise((resolve, reject) => {
      const request = {
        id: randomUUID(),
        kind,
        origin: site.origin,
        host: originHost(site.origin),
        secure: /^https:/.test(site.origin) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(site.origin),
        contentsId: site.contentsId ?? null,
        details,
        perform,
        createdAt: this.now(),
        busy: false,
        resolve,
        reject,
        followers: [],
      };
      this.requests.set(request.id, request);
      this.emit('request', request);
      this.changed();
    });
  }

  settle(request, error, value) {
    if (!this.requests.has(request.id)) return;
    this.requests.delete(request.id);
    for (const p of [request, ...request.followers]) {
      if (error) p.reject(error);
      else p.resolve(value);
    }
    this.changed();
  }

  async approve(id) {
    const request = this.requests.get(id);
    if (!request || request.busy) return false;
    this.requireKeys();
    request.busy = true;
    this.changed();
    try {
      const value = await request.perform();
      this.settle(request, null, value);
      return true;
    } catch (error) {
      this.settle(request, error);
      this.emit('notice', { kind: 'error', code: error?.code || 'failed', detail: error?.detail || String(error?.message || error) });
      return false;
    }
  }

  reject(id) {
    const request = this.requests.get(id);
    if (!request || request.busy) return false;
    this.settle(request, new WalletError('rejected'));
    return true;
  }

  /** The page that asked closed or went elsewhere: its requests go with it. */
  dropRequestsFrom(contentsId) {
    for (const request of [...this.requests.values()]) {
      if (request.contentsId === contentsId && !request.busy) this.settle(request, new WalletError('rejected'));
    }
  }

  // --------------------------------------------------------------- state

  /** What the wallet page draws. Public data only: no keys, no phrase. */
  state() {
    return {
      exists: this.exists,
      unreadable: this.unreadable,
      unlocked: this.unlocked,
      creating: Boolean(this.pendingPhrase),
      network: this.exists ? this.network().id : networks.BITCOIN.id,
      evmChainId: this.evmNetwork().chainId,
      networks: networks.describe(),
      addresses: this.exists ? { ...this.data.addresses } : null,
      sites: this.exists ? Object.keys(this.data.sites).sort() : [],
      requests: [...this.requests.values()].map((r) => ({
        id: r.id, kind: r.kind, origin: r.origin, host: r.host, secure: r.secure, details: r.details, busy: r.busy,
      })),
    };
  }

  pendingCount() {
    return this.requests.size;
  }
}

module.exports = { Wallet, FILE, displayAmount, displayFee, parseAmount, AUTO_LOCK_MS };
