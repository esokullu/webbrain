'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recoverMessageAddress, recoverTypedDataAddress, keccak256, toHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const vault = require('../app/wallet/vault');
const { buildPayment, signPayment, validAddress, RBF_SEQUENCE } = require('../app/wallet/bitcoin');
const { Wallet, displayAmount, parseAmount } = require('../app/wallet/store');
const { Provider, messageText, siweDomain } = require('../app/wallet/provider');
const { signTypedData, describeCall } = require('../app/wallet/evm');
const networks = require('../app/wallet/networks');

// BIP39's test phrase; its BIP84 and BIP44 (Ethereum) addresses are published.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BTC_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const EVM_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const SITE = { origin: 'https://app.example.com', contentsId: 7 };
const noNetwork = async () => { throw new Error('no network in tests'); };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-wallet-'));
}

async function readyWallet(dir = tempDir()) {
  const wallet = new Wallet({ dir, fetchFn: noNetwork });
  await wallet.importPhrase(PHRASE, 'correct horse');
  return wallet;
}

/** Waits for the wallet to queue a request, as the panel would see it. */
function nextRequest(wallet) {
  return new Promise((resolve) => wallet.once('request', resolve));
}

test('a recovery phrase gives the published BIP84 and Ethereum addresses', () => {
  const keys = vault.deriveKeys(PHRASE);
  assert.equal(keys.bitcoin.address, BTC_ADDRESS);
  assert.equal(keys.evm.address, EVM_ADDRESS);
  assert.ok(vault.validPhrase(`  ${PHRASE.toUpperCase()}  `));
  assert.ok(!vault.validPhrase(PHRASE.replace(/about$/, 'abandon')), 'bad checksum');
  assert.ok(!vault.validPhrase('abandon abandon'));
  assert.equal(vault.newPhrase().split(' ').length, 12);
  assert.ok(vault.validPhrase(vault.newPhrase()));
});

test('the phrase is sealed with the password and opens only with it', async () => {
  const box = await vault.seal(PHRASE, 'correct horse');
  assert.equal(box.kdf.name, 'scrypt');
  assert.equal(box.cipher.name, 'aes-256-gcm');
  assert.ok(!JSON.stringify(box).includes('abandon'));
  assert.equal(await vault.open(box, 'correct horse'), PHRASE);
  await assert.rejects(vault.open(box, 'wrong horse'), { code: 'wrongPassword' });
  await assert.rejects(vault.seal(PHRASE, 'short'), { code: 'passwordShort' });
  const tampered = { ...box, data: Buffer.from('x'.repeat(40)).toString('base64') };
  await assert.rejects(vault.open(tampered, 'correct horse'), { code: 'wrongPassword' });
});

test('the wallet file keeps no secrets, and locking forgets the keys', async () => {
  const dir = tempDir();
  try {
    const wallet = await readyWallet(dir);
    const file = fs.readFileSync(path.join(dir, 'murshid-wallet.json'), 'utf8');
    assert.ok(!file.includes('abandon'));
    assert.deepEqual(JSON.parse(file).addresses, { bitcoin: BTC_ADDRESS, evm: EVM_ADDRESS });
    assert.equal(wallet.unlocked, true);
    wallet.lock();
    assert.equal(wallet.unlocked, false);
    assert.equal(wallet.keys, null);
    await assert.rejects(wallet.unlock('nope nope nope'), { code: 'wrongPassword' });
    const again = new Wallet({ dir, fetchFn: noNetwork });
    assert.equal(again.exists, true);
    assert.equal(again.unlocked, false);
    await again.unlock('correct horse');
    assert.equal(again.keys.evm.address, EVM_ADDRESS);
    assert.deepEqual(await again.revealPhrase('correct horse'), PHRASE.split(' '));
    const state = again.state();
    assert.ok(!JSON.stringify(state).includes('abandon'));
    assert.equal(state.addresses.bitcoin, BTC_ADDRESS);
    again.reset();
    assert.equal(fs.existsSync(path.join(dir, 'murshid-wallet.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable wallet file is set aside, never overwritten', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'murshid-wallet.json'), '{broken');
    const wallet = new Wallet({ dir, fetchFn: noNetwork });
    assert.equal(wallet.exists, false);
    assert.equal(wallet.state().unreadable, true);
    await wallet.importPhrase(PHRASE, 'correct horse');
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith('murshid-wallet.json.unreadable-'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{broken');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('amounts are read and shown exactly', () => {
  assert.equal(parseAmount('0.0001', 8), 10000n);
  assert.equal(parseAmount('0,5', 8), 50000000n);
  assert.equal(parseAmount('.25', 18), 250000000000000000n);
  assert.throws(() => parseAmount('0.000000001', 8), { code: 'invalidAmount' });
  assert.throws(() => parseAmount('0', 8), { code: 'invalidAmount' });
  assert.throws(() => parseAmount('1e5', 8), { code: 'invalidAmount' });
  assert.throws(() => parseAmount('-1', 8), { code: 'invalidAmount' });
  assert.equal(displayAmount(123000n, 8), '0.00123');
  assert.equal(displayAmount(10n ** 18n, 18), '1');
  assert.equal(displayAmount(1234567891234567891n, 18, 6), '1.234567');
});

test('a Bitcoin payment spends confirmed coins only, allows fee bumps and keeps change', () => {
  const keys = vault.deriveKeys(PHRASE);
  const utxos = [
    { txid: 'a'.repeat(64), vout: 0, value: 50000, status: { confirmed: true } },
    { txid: 'b'.repeat(64), vout: 1, value: 20000, status: { confirmed: true } },
    { txid: 'c'.repeat(64), vout: 0, value: 900000, status: { confirmed: false } },
  ];
  const to = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const base = { address: keys.bitcoin.address, publicKey: keys.bitcoin.publicKey, utxos, to, feeRate: 5 };
  const payment = buildPayment({ ...base, amount: 30000n });
  assert.equal(payment.amount, 30000n);
  assert.ok(payment.fee > 0n && payment.fee < 2000n);
  for (let i = 0; i < payment.tx.inputsLength; i++) {
    assert.equal(payment.tx.getInput(i).sequence, RBF_SEQUENCE);
    assert.notEqual(Buffer.from(payment.tx.getInput(i).txid).toString('hex'), 'c'.repeat(64));
  }
  const signed = signPayment(payment, keys.bitcoin.privateKey);
  assert.match(signed.txid, /^[0-9a-f]{64}$/);
  const all = buildPayment({ ...base, max: true });
  assert.equal(all.amount + all.fee, 70000n);
  assert.throws(() => buildPayment({ ...base, amount: 100n }), { code: 'dust' });
  assert.throws(() => buildPayment({ ...base, amount: 80000n }), { code: 'insufficient' });
  assert.throws(() => buildPayment({ ...base, to: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', amount: 1000n }), { code: 'invalidAddress' });
  assert.ok(validAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'));
  assert.ok(validAddress('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'));
  assert.ok(!validAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), 'testnet address');
});

test('typed data signatures match the EIP-712 example', async () => {
  const account = privateKeyToAccount(keccak256(toHex('cow')));
  const typed = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
      Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }],
    },
    primaryType: 'Mail',
    domain: { name: 'Ether Mail', version: '1', chainId: '0x1', verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
    message: { from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' }, to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' }, contents: 'Hello, Bob!' },
  };
  assert.equal(await signTypedData(account, JSON.stringify(typed)),
    '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c');
  const approve = describeCall(`0x095ea7b3${'0'.repeat(24)}${'b'.repeat(40)}${'f'.repeat(64)}`);
  assert.equal(approve.name, 'approve');
  assert.equal(approve.unlimited, true);
});

test('personal_sign messages are shown as text, and sign-in requests are checked against the site', () => {
  assert.equal(messageText('0x68656c6c6f'), 'hello');
  assert.equal(messageText('0xff00'), null);
  assert.equal(messageText('plain text'), 'plain text');
  assert.equal(siweDomain('app.example.com wants you to sign in with your Ethereum account:\n0xabc'), 'app.example.com');
  assert.equal(siweDomain('https://app.example.com wants you to sign in with your Ethereum account:\n0xabc'), 'app.example.com');
  assert.equal(siweDomain('hello'), null);
});

test('websites connect only with approval, and see accounts only while unlocked', async () => {
  const wallet = await readyWallet();
  const provider = new Provider(wallet, { version: '1.2.3' });
  assert.equal(await provider.handle(SITE, 'eth_chainId'), '0x1');
  assert.equal(await provider.handle(SITE, 'net_version'), '1');
  assert.deepEqual(await provider.handle(SITE, 'eth_accounts'), []);
  assert.equal(await provider.handle(SITE, 'web3_clientVersion'), 'Murshid/1.2.3');
  await assert.rejects(provider.handle(SITE, 'personal_sign', ['0x68656c6c6f', EVM_ADDRESS]), { code: 4100 });

  // Rejected: the site gets 4001 and stays unconnected.
  let queued = nextRequest(wallet);
  let answer = provider.handle(SITE, 'eth_requestAccounts');
  let request = await queued;
  assert.equal(request.kind, 'connect');
  assert.equal(request.host, 'app.example.com');
  assert.equal(request.secure, true);
  // A second call while the first is waiting joins it.
  const second = provider.handle(SITE, 'eth_requestAccounts');
  assert.equal(wallet.state().requests.length, 1);
  wallet.reject(request.id);
  await assert.rejects(answer, { code: 4001 });
  await assert.rejects(second, { code: 4001 });
  assert.equal(wallet.isConnected(SITE.origin), false);

  queued = nextRequest(wallet);
  answer = provider.handle(SITE, 'eth_requestAccounts');
  request = await queued;
  assert.equal(await wallet.approve(request.id), true);
  assert.deepEqual(await answer, [EVM_ADDRESS]);
  assert.deepEqual(await provider.handle(SITE, 'eth_accounts'), [EVM_ADDRESS]);
  assert.equal((await provider.handle(SITE, 'wallet_getPermissions'))[0].parentCapability, 'eth_accounts');
  // Other sites see nothing.
  assert.deepEqual(await provider.handle({ origin: 'https://other.example', contentsId: 8 }, 'eth_accounts'), []);

  // Locked: no accounts; asking again needs only the password.
  wallet.lock();
  assert.deepEqual(await provider.handle(SITE, 'eth_accounts'), []);
  queued = nextRequest(wallet);
  answer = provider.handle(SITE, 'eth_requestAccounts');
  request = await queued;
  assert.equal(request.details.connected, true);
  await wallet.unlock('correct horse');
  assert.deepEqual(await answer, [EVM_ADDRESS]);
  assert.equal(wallet.state().requests.length, 0);

  await provider.handle(SITE, 'wallet_revokePermissions', [{ eth_accounts: {} }]);
  assert.deepEqual(await provider.handle(SITE, 'eth_accounts'), []);
});

test('signatures and network switches wait for approval; dangerous and unknown methods are refused', async () => {
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);

  let queued = nextRequest(wallet);
  let answer = provider.handle(SITE, 'personal_sign', ['0x68656c6c6f', EVM_ADDRESS]);
  let request = await queued;
  assert.equal(request.kind, 'sign');
  assert.equal(request.details.text, 'hello');
  await wallet.approve(request.id);
  assert.equal(await recoverMessageAddress({ message: 'hello', signature: await answer }), EVM_ADDRESS);

  // A sign-in message for another domain is flagged.
  const siwe = `evil.example wants you to sign in with your Ethereum account:\n${EVM_ADDRESS}\n\nURI: https://evil.example\nVersion: 1\nChain ID: 1\nNonce: 12345678\nIssued At: 2026-01-01T00:00:00Z`;
  queued = nextRequest(wallet);
  answer = provider.handle(SITE, 'personal_sign', [`0x${Buffer.from(siwe).toString('hex')}`, EVM_ADDRESS]);
  request = await queued;
  assert.deepEqual(request.details.siwe, { domain: 'evil.example', mismatch: true });
  wallet.reject(request.id);
  await assert.rejects(answer, { code: 4001 });

  // Typed data, with a Permit flagged.
  const typed = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Permit: [{ name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' }] },
    primaryType: 'Permit',
    domain: { name: 'Token', chainId: 1 },
    message: { owner: EVM_ADDRESS, value: '1000' },
  };
  queued = nextRequest(wallet);
  answer = provider.handle(SITE, 'eth_signTypedData_v4', [EVM_ADDRESS, JSON.stringify(typed)]);
  request = await queued;
  assert.equal(request.details.permit, true);
  assert.equal(request.details.chainMismatch, null);
  await wallet.approve(request.id);
  const { EIP712Domain: _d, ...types } = typed.types;
  assert.equal(await recoverTypedDataAddress({ ...typed, types, signature: await answer }), EVM_ADDRESS);

  // Switching networks.
  queued = nextRequest(wallet);
  answer = provider.handle(SITE, 'wallet_switchEthereumChain', [{ chainId: '0xa4b1' }]);
  request = await queued;
  assert.equal(request.details.network, 'Arbitrum One');
  const changes = [];
  wallet.on('sites', () => changes.push(wallet.siteState(SITE.origin).chainId));
  await wallet.approve(request.id);
  assert.equal(await answer, null);
  assert.equal(await provider.handle(SITE, 'eth_chainId'), '0xa4b1');
  assert.ok(changes.includes('0xa4b1'));
  await assert.rejects(provider.handle(SITE, 'wallet_switchEthereumChain', [{ chainId: '0x999999' }]), { code: 4902 });

  await assert.rejects(provider.handle(SITE, 'eth_sign', [EVM_ADDRESS, '0x00']), { code: 4200 });
  await assert.rejects(provider.handle(SITE, 'wallet_watchAsset', [{}]), { code: 4200 });
  await assert.rejects(provider.handle(SITE, 'personal_sign', ['0x00', '0x0000000000000000000000000000000000000001']), { code: 4100 });
});

test('transactions are estimated before approval and signed only after it', async () => {
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);
  const sent = [];
  wallet.evm.prepare = async (net, account, tx) => ({ request: { ...tx, gas: 50000n, maxFeePerGas: 10n }, fee: 500000n, l1Fee: 0n, account });
  wallet.evm.send = async (net, account, prepared) => { sent.push({ net: net.id, from: account.address, prepared }); return `0x${'ab'.repeat(32)}`; };
  const data = `0x095ea7b3${'0'.repeat(24)}${'c'.repeat(40)}${'f'.repeat(64)}`;
  const queued = nextRequest(wallet);
  const answer = provider.handle(SITE, 'eth_sendTransaction', [{ from: EVM_ADDRESS, to: '0x000000000000000000000000000000000000dEaD', value: '0x0', data }]);
  const request = await queued;
  assert.equal(request.kind, 'transaction');
  assert.equal(request.details.call.name, 'approve');
  assert.equal(request.details.call.unlimited, true);
  assert.equal(request.details.fee, '0.0000000000005');
  assert.equal(sent.length, 0, 'nothing is sent before approval');
  await wallet.approve(request.id);
  assert.equal(await answer, `0x${'ab'.repeat(32)}`);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, EVM_ADDRESS);
  assert.equal(sent[0].net, 'ethereum');
  await assert.rejects(provider.handle(SITE, 'eth_sendTransaction', [{ from: '0x0000000000000000000000000000000000000001', to: EVM_ADDRESS }]), { code: 4100 });
  await assert.rejects(provider.handle(SITE, 'eth_sendTransaction', [{ to: EVM_ADDRESS, chainId: '0x89' }]), { code: -32602 });
});

test('read-only calls go to the node; requests from a page that went away are dropped', async () => {
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  const calls = [];
  wallet.evm.rpc = async (net, method, params) => { calls.push([net.id, method, params]); return '0x10'; };
  assert.equal(await provider.handle(SITE, 'eth_blockNumber'), '0x10');
  assert.deepEqual(calls, [['ethereum', 'eth_blockNumber', []]]);
  await assert.rejects(provider.handle(SITE, 'eth_subscribe', ['newHeads']), { code: 4200 });

  const queued = nextRequest(wallet);
  const answer = provider.handle(SITE, 'eth_requestAccounts');
  await queued;
  wallet.dropRequestsFrom(SITE.contentsId);
  await assert.rejects(answer, { code: 4001 });
  assert.equal(wallet.pendingCount(), 0);
});

test('networks: one Bitcoin, the EVM chains by id', () => {
  assert.equal(networks.byId('bitcoin').kind, 'bitcoin');
  assert.equal(networks.byChainId('0xa4b1').id, 'arbitrum');
  assert.equal(networks.byChainId(8453).id, 'base');
  assert.equal(networks.byChainId('137').id, 'polygon');
  assert.equal(networks.byChainId('0x0'), null);
  for (const net of networks.EVM_NETWORKS) assert.ok(net.rpc.length >= 2 && net.rpc.every((u) => u.startsWith('https://')), net.id);
});
