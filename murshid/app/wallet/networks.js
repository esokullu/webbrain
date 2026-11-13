'use strict';

// The networks Murshid's wallet knows. One Bitcoin address (BIP84, native
// SegWit) and one Ethereum address (BIP44, the MetaMask path) used on every
// EVM network. Native coins only: no tokens, swaps or bridges.
//
// Every endpoint is public and needs no account. Each network lists more than
// one, tried in order, so one being down does not take the wallet with it.

const BITCOIN = Object.freeze({
  id: 'bitcoin',
  kind: 'bitcoin',
  name: 'Bitcoin',
  symbol: 'BTC',
  decimals: 8,
  path: "m/84'/0'/0'/0/0",
  // Esplora APIs (mempool.space and Blockstream speak the same one).
  api: ['https://mempool.space/api', 'https://blockstream.info/api'],
  explorer: 'https://mempool.space',
  addressUrl: (address) => `https://mempool.space/address/${address}`,
  txUrl: (txid) => `https://mempool.space/tx/${txid}`,
});

const EVM_PATH = "m/44'/60'/0'/0/0";
const OP_STACK_GAS_ORACLE = '0x420000000000000000000000000000000000000F';

function evm({ id, chainId, name, symbol = 'ETH', rpc, explorer, testnet = false, opStack = false }) {
  return Object.freeze({
    id,
    kind: 'evm',
    chainId,
    hexChainId: `0x${chainId.toString(16)}`,
    name,
    symbol,
    decimals: 18,
    path: EVM_PATH,
    rpc,
    explorer,
    testnet,
    opStack,
    addressUrl: (address) => `${explorer}/address/${address}`,
    txUrl: (hash) => `${explorer}/tx/${hash}`,
  });
}

const EVM_NETWORKS = Object.freeze([
  evm({
    id: 'ethereum', chainId: 1, name: 'Ethereum',
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'],
    explorer: 'https://etherscan.io',
  }),
  evm({
    id: 'arbitrum', chainId: 42161, name: 'Arbitrum One',
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io',
  }),
  evm({
    id: 'optimism', chainId: 10, name: 'OP Mainnet', opStack: true,
    rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    explorer: 'https://optimistic.etherscan.io',
  }),
  evm({
    id: 'base', chainId: 8453, name: 'Base', opStack: true,
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org',
  }),
  evm({
    id: 'polygon', chainId: 137, name: 'Polygon', symbol: 'POL',
    rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    explorer: 'https://polygonscan.com',
  }),
  evm({
    id: 'sepolia', chainId: 11155111, name: 'Sepolia', testnet: true,
    rpc: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'],
    explorer: 'https://sepolia.etherscan.io',
  }),
]);

const NETWORKS = Object.freeze([BITCOIN, ...EVM_NETWORKS]);
const DEFAULT_EVM = EVM_NETWORKS[0];

function byId(id) {
  return NETWORKS.find((n) => n.id === id) || null;
}

/** An EVM network from a chain id given as a number, a decimal string or 0x-hex. */
function byChainId(value) {
  let id = null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) id = value;
  else if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) id = Number.parseInt(value, 16);
  else if (typeof value === 'string' && /^\d+$/.test(value)) id = Number(value);
  return EVM_NETWORKS.find((n) => n.chainId === id) || null;
}

/** What the wallet page needs to draw the network menu. */
function describe() {
  return NETWORKS.map((n) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    symbol: n.symbol,
    testnet: Boolean(n.testnet),
    chainId: n.chainId ?? null,
  }));
}

module.exports = { BITCOIN, EVM_NETWORKS, NETWORKS, DEFAULT_EVM, EVM_PATH, OP_STACK_GAS_ORACLE, byId, byChainId, describe };
