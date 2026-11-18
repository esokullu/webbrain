'use strict';

// What window.ethereum does with a website's requests (EIP-1193). Reading
// the chain is passed to the node; connecting, signing, sending and switching
// networks wait in the wallet's queue until the user approves them in the
// wallet panel. The origin comes from the main process, never from the page.

const networks = require('./networks');
const { WalletError } = require('./errors');
// viem and the EVM helpers load on first use, not while Murshid starts.
const evm = () => require('./evm');
const viem = () => require('viem');
const { displayAmount, displayFee } = require('./store');

class ProviderError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const rejected = () => new ProviderError(4001, 'The user rejected the request.');
const unauthorized = () => new ProviderError(4100, 'Connect to the wallet first (eth_requestAccounts).');
const unsupported = (method) => new ProviderError(4200, `Murshid's wallet does not support ${method}.`);
const invalid = (message) => new ProviderError(-32602, message);

/** A wallet error, as the EIP-1193 error a website expects. */
function toProviderError(error) {
  if (error instanceof ProviderError) return error;
  if (error?.rpcCode) return new ProviderError(error.rpcCode, String(error.message));
  if (error instanceof WalletError) {
    switch (error.code) {
      case 'rejected': return rejected();
      case 'disconnected': return new ProviderError(4900, 'The wallet is not set up.');
      case 'locked': return unauthorized();
      case 'busy': return new ProviderError(-32002, 'Requests from this site are already waiting in the wallet.');
      case 'insufficient': return new ProviderError(-32603, 'Insufficient funds for the amount and the network fee.');
      default: return new ProviderError(-32603, error.detail || error.code);
    }
  }
  // Errors a node returned for a read-only call keep their code.
  const cause = error?.cause?.code !== undefined ? error.cause : error;
  if (Number.isInteger(cause?.code)) return new ProviderError(cause.code, String(cause.shortMessage || cause.message), cause.data);
  return new ProviderError(-32603, String(error?.shortMessage || error?.message || error));
}

// The approval card shows what is signed in full, never a cut-down copy: a
// request too large to show that way is refused instead. Transaction data
// gets more room, since contract deployments and batched calls are long.
const MAX_SHOWN = 100000; // characters of a message or typed data
const MAX_DATA = 262144; // hex characters of transaction data

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A personal_sign message as text, when it is text. */
function messageText(message) {
  if (typeof message !== 'string') return null;
  if (!/^0x([0-9a-f]{2})*$/i.test(message)) return CONTROL.test(message) ? null : message;
  const bytes = Buffer.from(message.slice(2), 'hex');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || CONTROL.test(text)) return null;
  return text;
}

/** Sign-In with Ethereum (EIP-4361): the domain the message is for. */
function siweDomain(text) {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^\s/]+) wants you to sign in with your Ethereum account:\n/i.exec(text || '');
  return m ? m[1].toLowerCase() : null;
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

class Provider {
  /**
   * @param {import('./store').Wallet} wallet
   * @param {{version?: string}} [options]
   */
  constructor(wallet, { version = '0' } = {}) {
    this.wallet = wallet;
    this.version = version;
  }

  /** One request from a page. `site` is { origin, contentsId }, from the main process. */
  async handle(site, method, params) {
    // Tied to the wallet that exists now, so a request still being prepared
    // when the wallet is reset or replaced is never queued or signed by another.
    const bound = { ...site, identity: this.wallet.identity() };
    try {
      return await this.dispatch(bound, String(method), params === undefined ? [] : params);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  address() {
    return this.wallet.data?.addresses?.evm || null;
  }

  requireConnected(site) {
    if (!this.wallet.exists) throw new WalletError('disconnected');
    if (!this.wallet.isConnected(site.origin)) throw unauthorized();
  }

  permissions(site) {
    if (!this.wallet.isConnected(site.origin)) return [];
    return [{
      parentCapability: 'eth_accounts',
      invoker: site.origin,
      caveats: [{ type: 'restrictReturnedAccounts', value: [this.address()] }],
      date: Date.parse(this.wallet.data.sites[site.origin].since) || 0,
    }];
  }

  async connect(site) {
    if (!this.wallet.exists) throw new WalletError('disconnected');
    const accounts = this.wallet.accountsFor(site.origin);
    if (accounts.length) return accounts;
    // Locked but already connected: the panel asks only for the password.
    return this.wallet.request('connect', site, { connected: this.wallet.isConnected(site.origin), address: this.address() }, async () => {
      this.wallet.connect(site.origin);
      return this.wallet.accountsFor(site.origin);
    });
  }

  async dispatch(site, method, params) {
    const net = this.wallet.evmNetwork();
    const list = Array.isArray(params) ? params : [params];
    switch (method) {
      case 'eth_chainId':
        return net.hexChainId;
      case 'net_version':
        return String(net.chainId);
      case 'eth_accounts':
        return this.wallet.accountsFor(site.origin);
      case 'eth_coinbase':
        return this.wallet.accountsFor(site.origin)[0] || null;
      case 'eth_requestAccounts':
        return this.connect(site);
      case 'wallet_requestPermissions': {
        const asked = list[0];
        if (!asked || typeof asked !== 'object' || !Object.hasOwn(asked, 'eth_accounts')) throw invalid('Only eth_accounts can be requested.');
        await this.connect(site);
        return this.permissions(site);
      }
      case 'wallet_getPermissions':
        return this.permissions(site);
      case 'wallet_revokePermissions':
        this.wallet.disconnect(site.origin);
        return null;
      case 'web3_clientVersion':
        return `Murshid/${this.version}`;
      case 'personal_sign':
        return this.personalSign(site, list);
      case 'eth_signTypedData_v4':
      case 'eth_signTypedData_v3':
        return this.signTyped(site, list);
      case 'eth_sendTransaction':
        return this.sendTransaction(site, list[0]);
      case 'wallet_switchEthereumChain':
        return this.switchChain(site, list[0]);
      case 'wallet_addEthereumChain': {
        // Only networks the wallet already knows can be "added": then it is a switch.
        if (!networks.byChainId(list[0]?.chainId)) throw new ProviderError(4200, `Murshid's wallet works with ${networks.EVM_NETWORKS.map((n) => n.name).join(', ')}.`);
        return this.switchChain(site, list[0]);
      }
      case 'eth_sign':
        // It signs any hash, so a site can get a transaction signed without saying so.
        throw new ProviderError(4200, 'eth_sign is disabled. Use personal_sign or eth_signTypedData_v4.');
      default:
        if (evm().READ_ONLY_METHODS.has(method)) {
          if (!this.wallet.exists) throw new WalletError('disconnected');
          return this.wallet.evm.rpc(net, method, list);
        }
        throw unsupported(method);
    }
  }

  async personalSign(site, [first, second]) {
    this.requireConnected(site);
    let message = first;
    let address = second;
    // Some sites still send [address, message].
    if (evm().validAddress(first) && !evm().validAddress(second) && sameAddress(first, this.address())) [message, address] = [second, first];
    if (typeof message !== 'string') throw invalid('personal_sign needs a message.');
    if (message.length > MAX_SHOWN) throw invalid('The message is too long to show for approval.');
    if (!sameAddress(address, this.address())) throw unauthorized();
    const text = messageText(message);
    const domain = siweDomain(text);
    const host = new URL(site.origin).host.toLowerCase();
    const details = {
      text,
      hex: text === null ? message : null,
      siwe: domain ? { domain, mismatch: domain !== host } : null,
    };
    return this.wallet.request('sign', site, details, async () => {
      const { account } = this.wallet.requireKeys().evm;
      return account.signMessage({ message: /^0x([0-9a-f]{2})*$/i.test(message) ? { raw: message } : message });
    });
  }

  async signTyped(site, [address, data]) {
    this.requireConnected(site);
    if (!sameAddress(address, this.address())) throw unauthorized();
    let parsed = data;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { throw invalid('Typed data is not JSON.'); }
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.types || !parsed.primaryType || !parsed.message) throw invalid('Incomplete typed data.');
    const json = JSON.stringify(parsed.message, null, 2);
    if (json.length > MAX_SHOWN) throw invalid('The typed data is too large to show for approval.');
    const chain = evm().typedDataChain(parsed);
    const current = this.wallet.evmNetwork();
    const details = {
      primaryType: String(parsed.primaryType),
      domainName: parsed.domain?.name ? String(parsed.domain.name) : null,
      contract: evm().validAddress(parsed.domain?.verifyingContract) ? viem().getAddress(parsed.domain.verifyingContract) : null,
      chainMismatch: chain !== null && chain !== current.chainId ? (networks.byChainId(chain)?.name || String(chain)) : null,
      // Permit, Permit2 and the like move tokens later, with no transaction to approve.
      permit: /permit/i.test(String(parsed.primaryType)),
      json,
    };
    return this.wallet.request('typed', site, details, async () => evm().signTypedData(this.wallet.requireKeys().evm.account, parsed));
  }

  async sendTransaction(site, tx) {
    this.requireConnected(site);
    if (!tx || typeof tx !== 'object') throw invalid('eth_sendTransaction needs a transaction.');
    if (tx.from !== undefined && !sameAddress(tx.from, this.address())) throw unauthorized();
    const net = this.wallet.evmNetwork();
    if (tx.chainId !== undefined && Number(evm().quantity(tx.chainId, 'chainId')) !== net.chainId) throw invalid(`The wallet is on ${net.name} (chain ${net.chainId}).`);
    if (tx.to !== undefined && tx.to !== null && !evm().validAddress(tx.to)) throw invalid('Invalid "to" address.');
    // A nonce the site chose (to replace or cancel a pending transaction) is kept.
    const nonce = evm().quantity(tx.nonce, 'nonce');
    if (nonce !== undefined && nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('Invalid nonce.');
    const request = {
      to: tx.to ? viem().getAddress(tx.to) : undefined,
      value: evm().quantity(tx.value, 'value') ?? 0n,
      data: evm().hexData(tx.data ?? tx.input),
      gas: evm().quantity(tx.gas ?? tx.gasLimit, 'gas'),
      nonce: nonce === undefined ? undefined : Number(nonce),
      maxFeePerGas: evm().quantity(tx.maxFeePerGas, 'maxFeePerGas'),
      maxPriorityFeePerGas: evm().quantity(tx.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
      gasPrice: evm().quantity(tx.gasPrice, 'gasPrice'),
    };
    if (!request.to && !request.data) throw invalid('A transaction needs a recipient or data.');
    if (request.data && request.data.length > MAX_DATA) throw invalid('The transaction data is too large to show for approval.');
    // Estimate now, to show the fee and say if it would fail. The gas limit and
    // fee caps estimated here are the ones signed later, so the transaction
    // can never cost more than the "up to" the user approved.
    let fee = null;
    let failure = null;
    try {
      const prepared = await this.wallet.evm.prepare(net, this.address(), request);
      fee = prepared.fee;
      const p = prepared.request;
      request.gas = p.gas;
      if (p.maxFeePerGas !== undefined) {
        request.maxFeePerGas = p.maxFeePerGas;
        request.maxPriorityFeePerGas = p.maxPriorityFeePerGas;
        request.gasPrice = undefined;
      } else if (p.gasPrice !== undefined) {
        request.gasPrice = p.gasPrice;
        request.maxFeePerGas = undefined;
        request.maxPriorityFeePerGas = undefined;
      }
    } catch (error) {
      // The network could not be asked (or could not price it): nothing reliable to show.
      if (error?.code === 'network') throw error;
      failure = error?.detail || error?.code || String(error);
    }
    const details = {
      network: net.name,
      symbol: net.symbol,
      from: this.address(),
      to: request.to || null,
      value: displayAmount(request.value, 18),
      fee: fee === null ? null : displayFee(fee, 18),
      data: request.data || null,
      dataBytes: request.data ? (request.data.length - 2) / 2 : 0,
      call: evm().describeCall(request.data),
      failure,
      // Without a gas limit there is nothing to sign when the estimate failed.
      blocked: Boolean(failure) && request.gas === undefined,
    };
    return this.wallet.request('transaction', site, details, async () => {
      if (details.blocked) throw new WalletError('willFail', failure);
      if (this.wallet.evmNetwork().chainId !== net.chainId) throw new WalletError('failed', 'the network changed');
      const { account } = this.wallet.requireKeys().evm;
      // One send at a time on this network, so this one takes the next nonce;
      // transfers reviewed in the panel meanwhile are reviewed again.
      return this.wallet.sending(net.id, async () => {
        const prepared = await this.wallet.evm.prepare(net, account, request);
        const hash = await this.wallet.evm.send(net, account, prepared);
        this.wallet.emit('notice', { kind: 'sent', url: net.txUrl(hash) });
        return hash;
      });
    });
  }

  async switchChain(site, arg) {
    if (!this.wallet.exists) throw new WalletError('disconnected');
    const target = networks.byChainId(arg?.chainId);
    if (!target) throw new ProviderError(4902, `Unrecognized chain ${String(arg?.chainId)}.`);
    if (target.chainId === this.wallet.evmNetwork().chainId) return null;
    return this.wallet.request('switch', site, { network: target.name, chainId: target.chainId, from: this.wallet.evmNetwork().name }, async () => {
      this.wallet.setEvmChain(target.chainId);
      return null;
    });
  }
}

module.exports = { Provider, ProviderError, toProviderError, messageText, siweDomain };
