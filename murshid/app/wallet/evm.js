'use strict';

// Ethereum and the EVM networks: balances, transfers, signatures, and the
// read-only RPC calls websites make through window.ethereum. All of it goes
// through viem, with the wallet's own public RPC endpoints.

const viem = require('viem');
const actions = require('viem/actions');
const { estimateL1Fee } = require('viem/op-stack');
const { OP_STACK_GAS_ORACLE } = require('./networks');
const { WalletError } = require('./vault');

// What websites may ask the node through the wallet: reading only. Anything
// that signs, sends or changes the wallet goes through an approval instead.
const READ_ONLY_METHODS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice',
  'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getBlockReceipts',
  'eth_getBlockTransactionCountByHash', 'eth_getBlockTransactionCountByNumber', 'eth_getCode',
  'eth_getFilterChanges', 'eth_getFilterLogs', 'eth_getLogs', 'eth_getProof', 'eth_getStorageAt',
  'eth_getTransactionByBlockHashAndIndex', 'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
  'eth_getUncleByBlockHashAndIndex', 'eth_getUncleByBlockNumberAndIndex',
  'eth_getUncleCountByBlockHash', 'eth_getUncleCountByBlockNumber', 'eth_maxPriorityFeePerGas',
  'eth_newBlockFilter', 'eth_newFilter', 'eth_newPendingTransactionFilter', 'eth_syncing',
  'eth_uninstallFilter', 'eth_blobBaseFee', 'eth_simulateV1', 'net_listening', 'web3_sha3',
]);

// Function selectors worth a warning: these let someone else move your tokens.
const SELECTORS = {
  '0x095ea7b3': 'approve', // approve(address,uint256)
  '0xa22cb465': 'setApprovalForAll', // setApprovalForAll(address,bool)
  '0x39509351': 'increaseAllowance', // increaseAllowance(address,uint256)
  '0xa9059cbb': 'transfer', // transfer(address,uint256)
  '0x23b872dd': 'transferFrom', // transferFrom(address,address,uint256)
};

function validAddress(address) {
  return typeof address === 'string' && viem.isAddress(address.trim(), { strict: false });
}

/** A quantity from a website: 0x-hex, a decimal string or a number. */
function quantity(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(value.trim())) return BigInt(value.trim());
  } catch {}
  throw new WalletError('failed', `invalid ${name}`);
}

function hexData(value) {
  if (value === undefined || value === null || value === '' || value === '0x') return undefined;
  if (typeof value === 'string' && /^0x([0-9a-f]{2})*$/i.test(value)) return value;
  throw new WalletError('failed', 'invalid data');
}

/** Plain words from a node's error, without viem's long "Request Arguments" tail. */
function reason(error) {
  const text = String(error?.shortMessage || error?.details || error?.message || error);
  return text.split('\n')[0].slice(0, 300);
}

class EvmClient {
  /** @param {typeof fetch} fetchFn */
  constructor(fetchFn) {
    this.fetchFn = fetchFn;
    this.clients = new Map();
  }

  client(net) {
    let client = this.clients.get(net.id);
    if (!client) {
      const chain = viem.defineChain({
        id: net.chainId,
        name: net.name,
        nativeCurrency: { name: net.symbol, symbol: net.symbol, decimals: 18 },
        rpcUrls: { default: { http: [...net.rpc] } },
        blockExplorers: { default: { name: net.name, url: net.explorer } },
        testnet: net.testnet,
      });
      const transport = viem.fallback(net.rpc.map((url) => viem.http(url, { fetchFn: this.fetchFn, timeout: 15000, retryCount: 1 })));
      client = viem.createPublicClient({ chain, transport });
      this.clients.set(net.id, client);
    }
    return client;
  }

  async balance(net, address) {
    try {
      return await actions.getBalance(this.client(net), { address });
    } catch (error) {
      throw new WalletError('network', reason(error));
    }
  }

  /** A read-only call a website made. */
  async rpc(net, method, params) {
    if (!READ_ONLY_METHODS.has(method)) throw Object.assign(new Error(`${method} is not supported`), { rpcCode: 4200 });
    return this.client(net).request({ method, params: Array.isArray(params) ? params : [] });
  }

  /**
   * Fills in a transaction (nonce, gas, fees) so it can be shown and then signed
   * as is. `fee` is the most it can cost, L1 data fee included on OP chains.
   */
  async prepare(net, account, tx) {
    const client = this.client(net);
    const request = {
      account,
      chain: client.chain,
      to: tx.to,
      value: tx.value ?? 0n,
      data: tx.data,
      gas: tx.gas,
      nonce: tx.nonce,
      ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
      ...(tx.maxFeePerGas === undefined && tx.gasPrice !== undefined ? { gasPrice: tx.gasPrice } : {}),
    };
    for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];
    let prepared;
    try {
      prepared = await actions.prepareTransactionRequest(client, request);
    } catch (error) {
      if (/insufficient funds/i.test(String(error?.message))) throw new WalletError('insufficient');
      throw new WalletError('willFail', reason(error));
    }
    const price = prepared.maxFeePerGas ?? prepared.gasPrice ?? 0n;
    let l1Fee = 0n;
    if (net.opStack) {
      try {
        l1Fee = await estimateL1Fee(client, { account, chain: client.chain, to: prepared.to, value: prepared.value, data: prepared.data, gasPriceOracleAddress: OP_STACK_GAS_ORACLE });
      } catch {}
    }
    return { request: prepared, fee: prepared.gas * price + l1Fee, l1Fee };
  }

  /**
   * Everything but the fee, for "Max". Gas is always estimated for a transfer
   * that carries value (a contract can need more gas for one, or refuse an
   * empty one), and the fee is reserved from the estimate for the value sent.
   */
  async prepareMax(net, account, to, balance) {
    if (balance <= 0n) throw new WalletError('insufficient');
    // First estimate: half the balance, a nonzero amount the account can afford.
    const probe = await this.prepare(net, account, { to, value: balance / 2n });
    const { nonce, maxFeePerGas, maxPriorityFeePerGas, gasPrice } = probe.request;
    const prices = maxFeePerGas !== undefined ? { maxFeePerGas, maxPriorityFeePerGas } : { gasPrice };
    const price = maxFeePerGas ?? gasPrice ?? 0n;
    let gas = probe.request.gas;
    for (let attempt = 0; attempt < 3; attempt++) {
      // The L1 data fee moves the most; reserve it twice.
      const value = balance - gas * price - probe.l1Fee * 2n;
      if (value <= 0n) throw new WalletError('insufficient');
      // Estimate again for exactly this value, at the same prices.
      const prepared = await this.prepare(net, account, { to, value, nonce, ...prices });
      if (prepared.request.gas <= gas) return prepared; // the reserve covers it
      gas = prepared.request.gas; // needs more gas than reserved: reserve that and retry
    }
    throw new WalletError('failed', 'the gas estimate kept rising');
  }

  async send(net, account, prepared) {
    const client = this.client(net);
    try {
      const serializedTransaction = await account.signTransaction(prepared.request);
      return await actions.sendRawTransaction(client, { serializedTransaction });
    } catch (error) {
      if (/insufficient funds/i.test(String(error?.message))) throw new WalletError('insufficient');
      throw new WalletError('failed', reason(error));
    }
  }
}

/** What a website's transaction does, as far as the wallet can tell without an ABI. */
function describeCall(data) {
  if (!data || data.length < 10) return null;
  const name = SELECTORS[data.slice(0, 10).toLowerCase()];
  if (!name) return { selector: data.slice(0, 10) };
  const word = (i) => `0x${data.slice(10 + i * 64, 10 + (i + 1) * 64)}`;
  const addressAt = (i) => {
    const w = word(i);
    return w.length === 66 ? viem.getAddress(`0x${w.slice(26)}`) : null;
  };
  try {
    if (name === 'approve' || name === 'increaseAllowance') {
      const amount = BigInt(word(1));
      return { name, spender: addressAt(0), unlimited: amount >= 2n ** 255n };
    }
    if (name === 'setApprovalForAll') return { name, spender: addressAt(0), approved: BigInt(word(1)) !== 0n };
    if (name === 'transfer') return { name, recipient: addressAt(0) };
    if (name === 'transferFrom') return { name, recipient: addressAt(1) };
  } catch {}
  return { name };
}

/** Signs EIP-712 typed data given as a website sends it (JSON text or an object). */
async function signTypedData(account, input) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new WalletError('failed', 'typed data is not JSON'); }
  }
  if (!data || typeof data !== 'object' || !data.types || !data.primaryType || !data.message) {
    throw new WalletError('failed', 'incomplete typed data');
  }
  const { EIP712Domain: _domainType, ...types } = data.types;
  const domain = { ...(data.domain || {}) };
  if (domain.chainId !== undefined) domain.chainId = quantity(domain.chainId, 'chainId');
  try {
    return await account.signTypedData({ domain, types, primaryType: data.primaryType, message: data.message });
  } catch (error) {
    throw new WalletError('failed', reason(error));
  }
}

/** The chain a typed data request names, if any (to warn when it is not the current one). */
function typedDataChain(input) {
  try {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    const id = data?.domain?.chainId;
    return id === undefined ? null : Number(BigInt(id));
  } catch {
    return null;
  }
}

module.exports = { EvmClient, READ_ONLY_METHODS, validAddress, quantity, hexData, describeCall, signTypedData, typedDataChain, reason };
