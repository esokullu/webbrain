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

test('a new wallet is created with the words its panel showed, even with two panels open', async () => {
  const dir = tempDir();
  try {
    const wallet = new Wallet({ dir, fetchFn: noNetwork });
    const first = wallet.createPhrase();
    const second = wallet.createPhrase(); // another window's panel
    assert.equal(second.id, first.id);
    assert.deepEqual(second.words, first.words);
    assert.equal(wallet.state().creating, first.id);
    await assert.rejects(wallet.finishCreate('some other id', 'correct horse'), { code: 'failed' });
    wallet.cancelCreate('some other id'); // not this flow: nothing happens
    assert.equal(wallet.state().creating, first.id);
    await wallet.finishCreate(first.id, 'correct horse');
    assert.equal(wallet.data.addresses.evm, vault.deriveKeys(first.words.join(' ')).evm.address);
    assert.deepEqual(await wallet.revealPhrase('correct horse'), first.words);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two panels finishing setup at once cannot both create a wallet', async () => {
  const dir = tempDir();
  try {
    const wallet = new Wallet({ dir, fetchFn: noNetwork });
    const other = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    const results = await Promise.allSettled([
      wallet.importPhrase(PHRASE, 'correct horse'),
      wallet.importPhrase(other, 'another password'),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
    assert.equal(results[1].reason.code, 'failed');
    assert.equal(wallet.data.addresses.evm, EVM_ADDRESS, 'the first wallet stays');
    assert.equal(new Wallet({ dir, fetchFn: noNetwork }).data.addresses.evm, EVM_ADDRESS);
    // An unlock that was checking the password when the wallet was reset fails cleanly.
    wallet.lock();
    const unlocking = wallet.unlock('correct horse');
    wallet.reset();
    await assert.rejects(unlocking, { code: 'failed' });
    assert.equal(wallet.unlocked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('starting the wallet, and answering what a page asks first, loads no crypto library', async () => {
  // They take seconds to load; Murshid's startup must not wait for them.
  const { spawnSync } = require('node:child_process');
  const dir = tempDir();
  try {
    await readyWallet(dir); // a wallet file exists, as after a restart
    const script = `
      const { Wallet } = require(${JSON.stringify(path.join(__dirname, '..', 'app', 'wallet', 'store'))});
      const { Provider } = require(${JSON.stringify(path.join(__dirname, '..', 'app', 'wallet', 'provider'))});
      require(${JSON.stringify(path.join(__dirname, '..', 'app', 'wallet', 'http'))});
      (async () => {
        const wallet = new Wallet({ dir: ${JSON.stringify(dir)}, fetchFn: async () => { throw new Error('offline'); } });
        wallet.state();
        const site = { origin: 'https://app.example.com', contentsId: 1 };
        wallet.siteState(site.origin);
        const provider = new Provider(wallet);
        await provider.handle(site, 'eth_chainId');
        await provider.handle(site, 'eth_accounts');
        const heavy = Object.keys(require.cache).filter((f) => /[\\\\/](viem|ox|@scure|@noble|@paulmillr)[\\\\/]/.test(f));
        console.log(JSON.stringify({ exists: wallet.exists, heavy: heavy.length }));
      })();`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { exists: true, heavy: 0 });
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
  assert.equal(parseAmount('2.', 8), 200000000n);
  assert.throws(() => parseAmount('1.2.3', 8), { code: 'invalidAmount' });
  const started = Date.now();
  assert.throws(() => parseAmount(`${'0'.repeat(50000)}x`, 8), { code: 'invalidAmount' });
  assert.throws(() => parseAmount('1'.repeat(81), 8), { code: 'invalidAmount' });
  assert.ok(Date.now() - started < 50, 'a long input is refused at once');
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

test('a transaction is signed with the gas and fee caps the user approved, and the site\'s nonce', async () => {
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);
  const prepared = [];
  let price = 10n;
  wallet.evm.prepare = async (net, account, input) => {
    const tx = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)); // as EvmClient.prepare does
    prepared.push(tx);
    // Fees are only estimated when they are missing; they rise between the two calls.
    const fees = tx.maxFeePerGas === undefined ? { maxFeePerGas: price, maxPriorityFeePerGas: 1n } : {};
    price = 99n;
    return { request: { gas: 21000n, ...tx, ...fees }, fee: 21000n * 10n, l1Fee: 0n };
  };
  wallet.evm.send = async () => `0x${'cd'.repeat(32)}`;
  const queued = nextRequest(wallet);
  const answer = provider.handle(SITE, 'eth_sendTransaction', [{ to: '0x000000000000000000000000000000000000dEaD', value: '0x1', nonce: '0x7' }]);
  await wallet.approve((await queued).id);
  await answer;
  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].nonce, 7);
  const signed = prepared[1];
  assert.equal(signed.nonce, 7);
  assert.equal(signed.gas, 21000n);
  assert.equal(signed.maxFeePerGas, 10n, 'the approved cap, not the risen price');
  assert.equal(signed.maxPriorityFeePerGas, 1n);
  await assert.rejects(provider.handle(SITE, 'eth_sendTransaction', [{ to: EVM_ADDRESS, nonce: '0x20000000000000' }]), { code: -32602 });
});

test('the approval card gets everything that is signed, and requests too large to show are refused', async () => {
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);
  let queued = 0;
  wallet.on('request', () => { queued += 1; });

  const bigTyped = {
    types: { Batch: [{ name: 'items', type: 'string[]' }] },
    primaryType: 'Batch',
    domain: { name: 'Token', chainId: 1 },
    message: { items: Array.from({ length: 6000 }, (_, i) => `permit ${i} to 0xspender`) },
  };
  await assert.rejects(provider.handle(SITE, 'eth_signTypedData_v4', [EVM_ADDRESS, JSON.stringify(bigTyped)]), { code: -32602 });
  await assert.rejects(provider.handle(SITE, 'personal_sign', [`0x${'ff'.repeat(60000)}`, EVM_ADDRESS]), { code: -32602 });
  assert.equal(queued, 0);

  // Below the limit, the card is given all of it.
  const hex = `0x${'ff'.repeat(30000)}`;
  const shown = new Promise((resolve) => wallet.once('request', resolve));
  const answer = provider.handle(SITE, 'personal_sign', [hex, EVM_ADDRESS]);
  const request = await shown;
  assert.equal(request.details.hex, hex);
  wallet.reject(request.id);
  await assert.rejects(answer, { code: 4001 });

  wallet.evm.prepare = async (net, account, tx) => ({ request: { ...tx, gas: 90000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, fee: 90000n, l1Fee: 0n });
  const data = `0x${'ab'.repeat(20000)}`;
  const shownTx = new Promise((resolve) => wallet.once('request', resolve));
  const txAnswer = provider.handle(SITE, 'eth_sendTransaction', [{ to: EVM_ADDRESS, data }]);
  const txRequest = await shownTx;
  assert.equal(txRequest.details.data, data);
  wallet.reject(txRequest.id);
  await assert.rejects(txAnswer, { code: 4001 });
});

test('a request whose page navigated while it was being prepared is never queued', async () => {
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);
  let current = true;
  wallet.evm.prepare = async (net, account, tx) => {
    current = false; // the page navigates during the estimate
    return { request: { ...tx, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, fee: 21000n, l1Fee: 0n };
  };
  let queued = 0;
  wallet.on('request', () => { queued += 1; });
  const site = { ...SITE, isCurrent: () => current };
  await assert.rejects(provider.handle(site, 'eth_sendTransaction', [{ to: EVM_ADDRESS, value: '0x1' }]), { code: 4001 });
  assert.equal(queued, 0);
  assert.equal(wallet.pendingCount(), 0);
});

test('Send all estimates gas for the value it sends, and reserves the fee from that estimate', async () => {
  const { EvmClient } = require('../app/wallet/evm');
  const client = new EvmClient(noNetwork);
  const net = networks.byId('base');
  const calls = [];
  // A contract that needs more gas the more value it is sent, and refuses an empty call.
  client.prepare = async (n, account, tx) => {
    calls.push(tx);
    if (!tx.value) throw new Error('refuses zero value');
    const gas = tx.value > 6n * 10n ** 17n ? 60000n : 40000n; // the half-balance probe gets 40000, the real value 60000
    const maxFeePerGas = tx.maxFeePerGas ?? 10n ** 9n;
    return { request: { ...tx, gas, maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 1n, nonce: tx.nonce ?? 3 }, fee: gas * maxFeePerGas + 1000n, l1Fee: 1000n };
  };
  const balance = 10n ** 18n;
  const prepared = await client.prepareMax(net, EVM_ADDRESS, EVM_ADDRESS, balance);
  assert.ok(calls.every((tx) => tx.value > 0n), 'never estimated with zero value');
  assert.equal(prepared.request.gas, 60000n, 'the gas for the value actually sent');
  assert.ok(prepared.request.value + prepared.fee + prepared.l1Fee <= balance, 'value, fee and the L1 reserve fit the balance');
  assert.equal(prepared.request.value, balance - 60000n * 10n ** 9n - 2000n);
  await assert.rejects(client.prepareMax(net, EVM_ADDRESS, EVM_ADDRESS, 0n), { code: 'insufficient' });
});

test('sending one transfer makes other reviews on that network be prepared again', async () => {
  const wallet = await readyWallet();
  const nonces = new Map(); // each chain counts its own
  const sent = [];
  wallet.evm.balance = async () => 10n ** 18n;
  wallet.evm.prepare = async (net, account, tx) => ({ request: { ...tx, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: tx.nonce ?? (nonces.get(net.id) ?? 4) }, fee: 21000n, l1Fee: 0n });
  wallet.evm.send = async (net, account, prepared) => {
    sent.push(`${net.id}:${prepared.request.nonce}`);
    nonces.set(net.id, prepared.request.nonce + 1);
    return `0x${String(sent.length).padStart(64, '0')}`;
  };
  const transfer = { network: 'base', to: '0x000000000000000000000000000000000000dEaD', amount: '0.01' };

  // Two windows review a transfer each, with the same next nonce.
  const a = await wallet.review(transfer);
  const b = await wallet.review(transfer);
  const other = await wallet.review({ ...transfer, network: 'arbitrum' });
  await wallet.confirm(a.id);
  await assert.rejects(wallet.confirm(b.id), { code: 'expired' });
  await wallet.confirm(other.id); // another network is unaffected
  assert.deepEqual(sent, ['base:4', 'arbitrum:4']);

  // Confirming two at the same moment sends one.
  const c = await wallet.review(transfer);
  const d = await wallet.review(transfer);
  const results = await Promise.allSettled([wallet.confirm(c.id), wallet.confirm(d.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(sent.length, 3);

  // A site's transaction on the same network does the same.
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);
  wallet.setEvmChain(8453);
  const e = await wallet.review(transfer);
  const queued = nextRequest(wallet);
  const answer = provider.handle(SITE, 'eth_sendTransaction', [{ to: EVM_ADDRESS, value: '0x1' }]);
  await wallet.approve((await queued).id);
  await answer;
  await assert.rejects(wallet.confirm(e.id), { code: 'expired' });
});

test('a site request still being prepared when the wallet is replaced is never queued for the new one', async () => {
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);
  let queued = 0;
  wallet.on('request', () => { queued += 1; });
  wallet.evm.prepare = async (net, account, tx) => {
    // Reset and restored with another phrase from another window, mid-estimate.
    wallet.reset();
    await wallet.importPhrase(vault.newPhrase(), 'another password');
    wallet.connect(SITE.origin);
    return { request: { ...tx, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, fee: 21000n, l1Fee: 0n };
  };
  await assert.rejects(provider.handle(SITE, 'eth_sendTransaction', [{ from: EVM_ADDRESS, to: EVM_ADDRESS, value: '0x1' }]), { code: 4900 });
  assert.equal(queued, 0);
  assert.notEqual(wallet.data.addresses.evm, EVM_ADDRESS);
});

test('a transfer review prepared while the wallet is replaced is not kept for the new one', async () => {
  const wallet = await readyWallet();
  wallet.evm.balance = async () => 10n ** 18n;
  let replace = true;
  const sent = [];
  wallet.evm.prepare = async (net, account, tx) => {
    if (replace) {
      replace = false;
      wallet.reset();
      await wallet.importPhrase(vault.newPhrase(), 'another password');
    }
    return { request: { ...tx, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 9 }, fee: 21000n, l1Fee: 0n };
  };
  wallet.evm.send = async (net, account, prepared) => { sent.push(account.address); return `0x${'ef'.repeat(32)}`; };
  const transfer = { network: 'base', to: '0x000000000000000000000000000000000000dEaD', amount: '0.01' };
  await assert.rejects(wallet.review(transfer), { code: 'failed' });
  assert.equal(wallet.reviews.size, 0);
  // A review made by the new wallet still works.
  const fresh = await wallet.review(transfer);
  await wallet.confirm(fresh.id);
  assert.deepEqual(sent, [wallet.data.addresses.evm]);
});

test('on OP chains an L1 data fee that cannot be estimated stops the transfer instead of counting as zero', async () => {
  const { EvmClient } = require('../app/wallet/evm');
  const client = new EvmClient(noNetwork);
  client.fill = async (c, request) => ({ ...request, gas: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, nonce: 0, type: 'eip1559' });
  let l1Calls = 0;
  client.l1DataFee = async () => { l1Calls += 1; throw new Error('oracle unreachable'); };
  const to = '0x000000000000000000000000000000000000dEaD';
  await assert.rejects(client.prepare(networks.byId('base'), EVM_ADDRESS, { to, value: 1n }), { code: 'network' });
  await assert.rejects(client.prepareMax(networks.byId('optimism'), EVM_ADDRESS, to, 10n ** 18n), { code: 'network' });
  // Ethereum has no L1 data fee to ask about.
  const mainnet = await client.prepare(networks.byId('ethereum'), EVM_ADDRESS, { to, value: 1n });
  assert.equal(mainnet.fee, 210000n);
  assert.equal(l1Calls, 2);
  client.l1DataFee = async () => 5000n;
  const base = await client.prepare(networks.byId('base'), EVM_ADDRESS, { to, value: 1n });
  assert.equal(base.fee, 210000n + 5000n);
  const max = await client.prepareMax(networks.byId('base'), EVM_ADDRESS, to, 10n ** 18n);
  assert.equal(max.request.value, 10n ** 18n - 210000n - 10000n, 'the L1 fee is reserved, twice');

  // A site's transaction on Base gets an error, not a card with a fee that is too low.
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);
  wallet.setEvmChain(8453);
  wallet.evm.fill = client.fill;
  wallet.evm.l1DataFee = async () => { throw new Error('oracle unreachable'); };
  let queued = 0;
  wallet.on('request', () => { queued += 1; });
  await assert.rejects(provider.handle(SITE, 'eth_sendTransaction', [{ to, value: '0x1' }]), { code: -32603 });
  assert.equal(queued, 0);
});

test('Send all still works when the fee is more than half the balance', async () => {
  const { EvmClient } = require('../app/wallet/evm');
  const { WalletError } = require('../app/wallet/vault');
  const client = new EvmClient(noNetwork);
  const balance = 30000n;
  const probes = [];
  client.prepare = async (n, account, tx) => {
    probes.push(tx.value);
    const fee = 21000n;
    if (tx.value + fee > balance) throw new WalletError('insufficient');
    return { request: { ...tx, gas: 21000n, maxFeePerGas: tx.maxFeePerGas ?? 1n, maxPriorityFeePerGas: 1n, nonce: 0 }, fee, l1Fee: 0n };
  };
  const max = await client.prepareMax(networks.byId('ethereum'), EVM_ADDRESS, EVM_ADDRESS, balance);
  assert.equal(probes[0], 15000n);
  assert.equal(probes[1], 1n, 'asked again with the smallest amount');
  assert.equal(max.request.value, 9000n);
  await assert.rejects(client.prepareMax(networks.byId('ethereum'), EVM_ADDRESS, EVM_ADDRESS, 20000n), { code: 'insufficient' });
});

test('the wallet\'s network timeout covers the whole answer, body included', async () => {
  const { createFetch } = require('../app/wallet/http');
  const stalled = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"partial":')); } }), { status: 200 });
  const started = Date.now();
  await assert.rejects(createFetch(stalled, { timeoutMs: 150 })('https://example.test/'), /no complete answer/);
  assert.ok(Date.now() - started < 2000);
  const fine = await createFetch(async () => new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } }), { timeoutMs: 150 })('https://example.test/');
  assert.equal(fine.status, 201);
  assert.equal(fine.headers.get('content-type'), 'application/json');
  assert.deepEqual(await fine.json(), { ok: true });
  const empty = await createFetch(async () => new Response(null, { status: 204 }))('https://example.test/');
  assert.equal(empty.status, 204);
});

test('a priority fee the site sets on its own is kept, zero included', async () => {
  const { EvmClient } = require('../app/wallet/evm');
  const client = new EvmClient(noNetwork);
  const asked = [];
  // A node that fills in its own tip and caps whatever it is given.
  client.fill = async (c, request) => {
    asked.push(request);
    return { ...request, gas: 21000n, maxFeePerGas: 50n, maxPriorityFeePerGas: 7n, nonce: 1, type: 'eip1559' };
  };
  const to = '0x000000000000000000000000000000000000dEaD';
  const tipOnly = await client.prepare(networks.byId('ethereum'), EVM_ADDRESS, { to, value: 1n, maxPriorityFeePerGas: 0n });
  assert.equal(asked[0].maxPriorityFeePerGas, 0n, 'the tip reaches the preparer');
  assert.equal(asked[0].maxFeePerGas, undefined, 'only the missing cap is estimated');
  assert.equal(asked[0].gasPrice, undefined);
  assert.equal(tipOnly.request.maxPriorityFeePerGas, 0n, 'and is what gets signed');
  assert.equal(tipOnly.request.maxFeePerGas, 50n);
  const legacy = await client.prepare(networks.byId('ethereum'), EVM_ADDRESS, { to, value: 1n, gasPrice: 3n });
  assert.equal(asked[1].gasPrice, 3n);
  assert.equal(asked[1].maxPriorityFeePerGas, undefined);
  assert.equal(legacy.request.gasPrice, 3n);

  // Through window.ethereum: both the estimate and the signed transaction keep the zero tip.
  const wallet = await readyWallet();
  const provider = new Provider(wallet);
  wallet.connect(SITE.origin);
  wallet.evm.fill = client.fill;
  const signed = [];
  wallet.evm.send = async (net, account, prepared) => { signed.push(prepared.request); return `0x${'aa'.repeat(32)}`; };
  const queued = nextRequest(wallet);
  const answer = provider.handle(SITE, 'eth_sendTransaction', [{ to, value: '0x1', maxPriorityFeePerGas: '0x0' }]);
  await wallet.approve((await queued).id);
  await answer;
  assert.equal(signed[0].maxPriorityFeePerGas, 0n);
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
