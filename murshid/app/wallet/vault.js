'use strict';

// The recovery phrase, and the keys made from it.
//
// The phrase is the wallet: BIP39 words, generated from the system's secure
// random source. On disk it is only ever kept encrypted: scrypt turns the
// password into a key, AES-256-GCM seals the phrase with it. Keys are derived
// from the phrase when the wallet is unlocked and live only in the main
// process; the wallet page and websites never see them.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');
const { HDKey } = require('@scure/bip32');
const btc = require('@scure/btc-signer');
const { bytesToHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { BITCOIN, EVM_PATH } = require('./networks');
const { WalletError } = require('./errors');

const scrypt = promisify(crypto.scrypt);

// 2^17 × 8 × 128 bytes = 128 MiB of memory and roughly half a second per try:
// slow enough to make guessing a stolen file's password expensive.
const KDF = Object.freeze({ name: 'scrypt', N: 2 ** 17, r: 8, p: 1 });
const MIN_PASSWORD = 8;


function normalizePhrase(text) {
  return String(text || '').normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function newPhrase() {
  return bip39.generateMnemonic(wordlist, 128); // 12 words
}

function validPhrase(text) {
  const phrase = normalizePhrase(text);
  const words = phrase.split(' ').length;
  return [12, 15, 18, 21, 24].includes(words) && bip39.validateMnemonic(phrase, wordlist);
}

function checkPassword(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw new WalletError('passwordShort');
}

async function deriveKey(password, salt, kdf) {
  const { N, r, p } = kdf;
  return scrypt(String(password).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
}

/** Seal text with a password. Everything needed to open it again, bar the password, is in the result. */
async function seal(text, password) {
  checkPassword(password);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(password, salt, KDF);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  key.fill(0);
  return {
    kdf: { ...KDF, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: data.toString('base64'),
  };
}

async function open(box, password) {
  if (!box || box.kdf?.name !== 'scrypt' || box.cipher?.name !== 'aes-256-gcm') throw new WalletError('failed', 'unreadable wallet file');
  const { N, r, p } = box.kdf;
  if (![N, r, p].every(Number.isSafeInteger) || N > 2 ** 20 || r > 16 || p > 4) throw new WalletError('failed', 'unreadable wallet file');
  const key = await deriveKey(password, Buffer.from(box.kdf.salt, 'base64'), { N, r, p });
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.cipher.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.cipher.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new WalletError('wrongPassword');
  } finally {
    key.fill(0);
  }
}

/** The Bitcoin and Ethereum keys of a phrase. */
function deriveKeys(phrase) {
  const seed = bip39.mnemonicToSeedSync(normalizePhrase(phrase));
  const root = HDKey.fromMasterSeed(seed);
  seed.fill(0);
  const bitcoinNode = root.derive(BITCOIN.path);
  const evmNode = root.derive(EVM_PATH);
  const bitcoinKey = Uint8Array.from(bitcoinNode.privateKey);
  const bitcoinPublic = Uint8Array.from(bitcoinNode.publicKey);
  const evmKey = bytesToHex(evmNode.privateKey);
  for (const node of [bitcoinNode, evmNode, root]) node.wipePrivateData();
  const account = privateKeyToAccount(evmKey);
  return {
    bitcoin: { privateKey: bitcoinKey, publicKey: bitcoinPublic, address: btc.p2wpkh(bitcoinPublic, btc.NETWORK).address },
    evm: { account, address: account.address },
  };
}

function wipeKeys(keys) {
  if (!keys) return;
  try { keys.bitcoin.privateKey.fill(0); } catch {}
  keys.bitcoin = null;
  keys.evm = null;
}

module.exports = { WalletError, KDF, MIN_PASSWORD, normalizePhrase, newPhrase, validPhrase, checkPassword, seal, open, deriveKeys, wipeKeys };
