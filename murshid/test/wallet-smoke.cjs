'use strict';

// Runs under Electron with an isolated profile (see run-wallet-smoke.cjs):
// creates a wallet in the side panel, then signs in to a local page through
// window.ethereum, approving each request in the panel the way a user would.
// MURSHID_TEST_SHOTS=<folder> also saves screenshots of the panel.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, nativeTheme } = require('electron');
const { verifyMessage } = require('viem');
const { ctx } = require('../app/main');

const SHOTS = process.env.MURSHID_TEST_SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const DAPP = `<!doctype html><meta charset="utf-8"><title>dApp</title><body>dApp
<script>
  window.announced = [];
  window.events = [];
  window.addEventListener('eip6963:announceProvider', (e) => window.announced.push(e.detail.info));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  if (window.ethereum) {
    window.ethereum.on('accountsChanged', (a) => window.events.push(['accountsChanged', a]));
    window.ethereum.on('chainChanged', (c) => window.events.push(['chainChanged', c]));
  }
  window.ask = (method, params) => {
    const slot = { done: false };
    window.ethereum.request({ method, params }).then(
      (result) => Object.assign(slot, { done: true, result }),
      (error) => Object.assign(slot, { done: true, error: { code: error.code, message: error.message } }));
    return slot;
  };
</script>`;

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DAPP);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const shot = async (wc, name) => {
    if (!SHOTS) return;
    await sleep(350);
    const image = await wc.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG());
  };

  try {
    await until('a window', () => ctx.windows.length);
    await sleep(2500); // WebBrain's own startup
    const w = ctx.windows[0];
    if (process.env.MURSHID_TEST_THEME) nativeTheme.themeSource = process.env.MURSHID_TEST_THEME;

    // No wallet yet: websites see no window.ethereum.
    const tab = w.addTab({ url: `${origin}/` });
    await until('the page', () => !tab.wc.isLoading());
    assert.equal(await tab.wc.executeJavaScript('typeof window.ethereum'), 'undefined');

    // The wallet page outside the panel has no access.
    const outside = w.addTab({ url: 'murshid://wallet/' });
    await until('wallet in a tab', async () => !outside.wc.isLoading() && outside.wc.executeJavaScript("!document.getElementById('v-elsewhere').hidden"));
    await w.closeTab(outside);
    w.selectTab(tab);

    // Create a wallet in the side panel.
    w.openWallet();
    const panel = await until('the wallet panel', () => w.panelViews.get('wallet')?.view.webContents);
    await until('the welcome screen', async () => !panel.isLoading() && panel.executeJavaScript("!document.getElementById('v-welcome').hidden"));
    await shot(panel, '1-welcome');
    await panel.executeJavaScript("document.getElementById('start-create').click()");
    await until('the recovery phrase', () => panel.executeJavaScript("document.querySelectorAll('#words li').length === 12"));
    await shot(panel, '2-phrase');
    await panel.executeJavaScript(`
      document.getElementById('written').checked = true;
      document.getElementById('create-password').value = 'correct horse';
      document.getElementById('create-repeat').value = 'correct horse';
      document.getElementById('create-submit').click();`);
    await until('the unlocked wallet', () => ctx.wallet.unlocked, 20000);
    await until('the main view', () => panel.executeJavaScript("!document.getElementById('v-main').hidden"));
    const address = ctx.wallet.data.addresses.evm;
    assert.match(ctx.wallet.data.addresses.bitcoin, /^bc1q/);
    await until('the QR code', () => panel.executeJavaScript("document.getElementById('qr').src.startsWith('data:image/svg+xml')"));
    await sleep(2500); // let the balance arrive, if the network is there
    await shot(panel, '3-bitcoin');

    // A website can now find the wallet, but sees no account until it connects.
    await tab.wc.reload();
    await until('the page', () => !tab.wc.isLoading());
    const found = await tab.wc.executeJavaScript('({ type: typeof window.ethereum, murshid: window.ethereum?.isMurshid, chainId: window.ethereum?.chainId, announced: window.announced.map((i) => i.rdns) })');
    assert.deepEqual(found, { type: 'object', murshid: true, chainId: '0x1', announced: ['one.webbrain.murshid'] });
    assert.deepEqual(await tab.wc.executeJavaScript("window.ethereum.request({ method: 'eth_accounts' })"), []);

    const answer = async (slot) => until('the answer', () => tab.wc.executeJavaScript(`window.${slot}.done && window.${slot}`));

    // Connect.
    w.closeWallet();
    await tab.wc.executeJavaScript("window.c = window.ask('eth_requestAccounts')");
    await until('the panel to open for the request', () => w.walletOpen);
    const panel2 = await until('the wallet panel', () => w.panelViews.get('wallet')?.view.webContents);
    const p = panel2; // closing the wallet destroyed the first view
    await until('the request', () => !p.isLoading() && p.executeJavaScript("!document.getElementById('v-request').hidden"));
    await shot(p, '4-connect');
    await shot(w.win, '4-window');
    await until('approve enabled', () => p.executeJavaScript("!document.getElementById('request-approve').disabled"));
    await p.executeJavaScript("document.getElementById('request-approve').click()");
    const connected = await answer('c');
    assert.deepEqual(connected.result, [address]);

    // Sign in with Ethereum.
    const host = new URL(origin).host;
    const siwe = `${host} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to the test page.\n\nURI: ${origin}\nVersion: 1\nChain ID: 1\nNonce: 8f3k2m1q\nIssued At: 2026-11-08T12:00:00.000Z`;
    const hex = `0x${Buffer.from(siwe).toString('hex')}`;
    await tab.wc.executeJavaScript(`window.s = window.ask('personal_sign', [${JSON.stringify(hex)}, ${JSON.stringify(address)}])`);
    await until('the request', () => p.executeJavaScript("!document.getElementById('v-request').hidden"));
    assert.equal(await p.executeJavaScript("document.getElementById('request-body').textContent.includes('phishing')"), false);
    await shot(p, '5-sign-in');
    await until('approve enabled', () => p.executeJavaScript("!document.getElementById('request-approve').disabled"));
    await p.executeJavaScript("document.getElementById('request-approve').click()");
    const signed = await answer('s');
    assert.ok(await verifyMessage({ address, message: siwe, signature: signed.result }), 'the signature is the wallet\'s');

    // Rejecting gives the site 4001.
    await tab.wc.executeJavaScript("window.r = window.ask('personal_sign', ['0x68656c6c6f', window.ethereum.selectedAddress])");
    await until('the request', () => p.executeJavaScript("!document.getElementById('v-request').hidden"));
    await p.executeJavaScript("document.getElementById('request-reject').click()");
    assert.equal((await answer('r')).error.code, 4001);

    // Switch to Arbitrum; the page hears about it.
    await tab.wc.executeJavaScript("window.n = window.ask('wallet_switchEthereumChain', [{ chainId: '0xa4b1' }])");
    await until('the request', () => p.executeJavaScript("!document.getElementById('v-request').hidden"));
    await shot(p, '6-switch');
    await until('approve enabled', () => p.executeJavaScript("!document.getElementById('request-approve').disabled"));
    await p.executeJavaScript("document.getElementById('request-approve').click()");
    await answer('n');
    await until('chainChanged', () => tab.wc.executeJavaScript("window.events.some((e) => e[0] === 'chainChanged' && e[1] === '0xa4b1')"));
    assert.equal(await tab.wc.executeJavaScript('window.ethereum.chainId'), '0xa4b1');

    // The EVM view, in a wide panel: three columns.
    await p.executeJavaScript("document.getElementById('network').value = 'arbitrum'; document.getElementById('network').dispatchEvent(new Event('change'))");
    await until('the main view', () => p.executeJavaScript("!document.getElementById('v-main').hidden"));
    ctx.settings.set('sidePanelWidth', 780);
    w.layout();
    await sleep(2500);
    await shot(p, '7-arbitrum-wide');
    ctx.settings.set('sidePanelWidth', 420);
    w.layout();

    // Send: review only (no funds), to see the checks.
    await p.executeJavaScript(`document.querySelector('[data-col="send"] .col-head').click();
      document.getElementById('send-to').value = 'not an address';
      document.getElementById('send-amount').value = '0.01';
      document.getElementById('send-review').click();`);
    await until('the address error', () => p.executeJavaScript("document.getElementById('send-error').textContent.length > 0"));
    await shot(p, '8-send-error');

    // Locking hides the account from the site.
    await p.executeJavaScript("document.getElementById('lock').click()");
    await until('accountsChanged []', () => tab.wc.executeJavaScript("window.events.some((e) => e[0] === 'accountsChanged' && e[1].length === 0)"));
    await until('the lock screen', () => p.executeJavaScript("!document.getElementById('v-locked').hidden"));
    await shot(p, '9-locked');
    assert.deepEqual(await tab.wc.executeJavaScript("window.ethereum.request({ method: 'eth_accounts' })"), []);

    console.log('Wallet smoke passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
    app.exit(process.exitCode || 0);
  }
})();
