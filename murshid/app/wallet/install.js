'use strict';

// Plugs the wallet into Murshid: the wallet page in the side panel talks to
// it over 'murshid-wallet'; websites talk to it through window.ethereum over
// 'murshid-ethereum'. The two never share a channel, and each checks who is
// asking: the wallet channel answers only Murshid's own wallet panel, the
// ethereum channel only top-level http(s) pages in the browsing session,
// under the origin Chromium reports for them.

const { app, ipcMain, webContents: allWebContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../paths');
const { Wallet } = require('./store');
const { Provider } = require('./provider');
const { createFetch } = require('./http');

const PRELOAD_ID = 'murshid-ethereum';
const PAGE_CHANNEL = 'murshid-wallet';
const PAGE_EVENTS = 'murshid-wallet-event';
const SITE_CHANNEL = 'murshid-ethereum';
const SITE_INIT = 'murshid-ethereum-init';
const SITE_EVENTS = 'murshid-ethereum-event';

const PASSIVE = new Set(['state', 'balance', 'receive']);

const str = (value) => (typeof value === 'string' ? value : '');

function installWallet(ctx) {
  const wallet = new Wallet({ dir: ctx.userData, fetchFn: createFetch() });
  const provider = new Provider(wallet, { version: app.getVersion() });
  let icon = null;
  try {
    icon = `data:image/svg+xml;base64,${fs.readFileSync(paths.asset('icons', 'murshid.svg')).toString('base64')}`;
  } catch {}

  // window.ethereum exists only while there is a wallet behind it, so sites
  // cannot tell a browser without one from any other.
  const syncPreload = () => {
    const registered = ctx.ses.getPreloadScripts().some((p) => p.id === PRELOAD_ID);
    if (wallet.exists && !registered) {
      ctx.ses.registerPreloadScript({ id: PRELOAD_ID, type: 'frame', filePath: path.join(__dirname, 'provider-preload.js') });
    } else if (!wallet.exists && registered) {
      ctx.ses.unregisterPreloadScript(PRELOAD_ID);
    }
  };
  syncPreload();

  // ---------------------------------------------------------- the wallet page

  const panelContents = () => ctx.windows
    .map((w) => w.panelViews.get('wallet')?.view.webContents)
    .filter((wc) => wc && !wc.isDestroyed());

  const isWalletPanel = (event) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent) return false;
    let url = '';
    try { url = frame.url; } catch {}
    return url.startsWith('murshid://wallet/') && panelContents().includes(event.sender);
  };

  const commands = {
    state: () => wallet.state(),
    createPhrase: () => wallet.createPhrase(),
    cancelCreate: () => wallet.cancelCreate(),
    finishCreate: (password) => wallet.finishCreate(str(password)),
    importPhrase: (phrase, password) => wallet.importPhrase(str(phrase), str(password)),
    unlock: (password) => wallet.unlock(str(password)),
    lock: () => wallet.lock(),
    setNetwork: (id) => wallet.setNetwork(str(id)),
    balance: (id) => wallet.balance(str(id)),
    receive: (id) => wallet.receive(str(id)),
    review: (p) => wallet.review({ network: str(p?.network), to: str(p?.to), amount: str(p?.amount), max: p?.max === true, speed: str(p?.speed) || 'normal' }),
    cancelReview: (id) => wallet.cancelReview(str(id)),
    confirm: (id) => wallet.confirm(str(id)),
    approve: (id) => wallet.approve(str(id)),
    reject: (id) => wallet.reject(str(id)),
    disconnect: (origin) => wallet.disconnect(str(origin)),
    revealPhrase: (password) => wallet.revealPhrase(str(password)),
    reset: () => wallet.reset(),
  };

  ipcMain.handle(PAGE_CHANNEL, async (event, command, ...args) => {
    if (!isWalletPanel(event)) return { error: { code: 'panelOnly' } };
    if (!Object.hasOwn(commands, command)) return { error: { code: 'failed', detail: `unknown command ${command}` } };
    // What the user does keeps the wallet unlocked; what the page reads on its
    // own (state, the balance it refreshes every minute) does not.
    if (!PASSIVE.has(command)) wallet.touch();
    try {
      const value = await commands[command](...args);
      return { value: value === undefined ? null : value };
    } catch (error) {
      if (!error?.code) console.error('[murshid] wallet:', error);
      return { error: { code: typeof error?.code === 'string' ? error.code : 'failed', detail: error?.detail || (error?.code ? undefined : String(error?.message || error)) } };
    }
  });

  const toPanels = (message) => panelContents().forEach((wc) => wc.send(PAGE_EVENTS, message));

  // ------------------------------------------------------------- websites

  const siteOf = (event) => {
    const wc = event.sender;
    const frame = event.senderFrame;
    if (!wc || wc.isDestroyed() || wc.session !== ctx.ses || !frame || frame.parent) return null;
    // Murshid's own views (browser chrome, side panels) are never websites.
    if (ctx.windows.some((w) => w.ui === wc || [...w.panelViews.values()].some((p) => p.view.webContents === wc))) return null;
    let origin = '';
    try { origin = frame.origin; } catch {}
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) return null;
    return { origin, contentsId: wc.id };
  };

  ipcMain.on(SITE_INIT, (event) => {
    const site = wallet.exists ? siteOf(event) : null;
    event.returnValue = site ? { ...wallet.siteState(site.origin), icon } : null;
  });

  ipcMain.handle(SITE_CHANNEL, async (event, method, params) => {
    const site = siteOf(event);
    if (!site) return { error: { code: 4100, message: 'This page cannot use the wallet.' } };
    try {
      const result = await provider.handle(site, method, params);
      return { result: result === undefined ? null : result };
    } catch (error) {
      return { error: { code: error.code ?? -32603, message: String(error.message || 'Request failed'), ...(error.data !== undefined ? { data: error.data } : {}) } };
    }
  });

  const toSites = () => {
    for (const wc of allWebContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.session !== ctx.ses) continue;
      let frame;
      let origin = '';
      try { frame = wc.mainFrame; origin = frame.origin; } catch { continue; }
      if (!/^https?:\/\//.test(origin)) continue;
      try { frame.send(SITE_EVENTS, wallet.siteState(origin)); } catch {}
    }
  };

  // A request goes with the page that made it, when that page closes or leaves.
  const watched = new Set();
  const watch = (contentsId) => {
    if (contentsId === null || watched.has(contentsId)) return;
    const wc = allWebContents.fromId(contentsId);
    if (!wc || wc.isDestroyed()) {
      wallet.dropRequestsFrom(contentsId);
      return;
    }
    watched.add(contentsId);
    const drop = () => wallet.dropRequestsFrom(contentsId);
    const onNavigate = (details) => { if (details?.isMainFrame && !details.isSameDocument) drop(); };
    wc.on('did-start-navigation', onNavigate);
    wc.once('destroyed', () => { watched.delete(contentsId); drop(); });
  };

  // ---------------------------------------------------------------- events

  wallet.on('changed', () => {
    toPanels({ type: 'state' });
    ctx.refreshAllWindows();
  });
  wallet.on('sites', toSites);
  wallet.on('notice', (notice) => toPanels({ type: 'notice', notice }));
  wallet.on('created', syncPreload);
  wallet.on('reset', syncPreload);
  wallet.on('request', (request) => {
    watch(request.contentsId);
    const wc = request.contentsId !== null ? allWebContents.fromId(request.contentsId) : null;
    const w = ctx.windowForContents(wc) || ctx.lastFocusedWindow();
    w?.openWallet();
  });

  app.on('before-quit', () => wallet.lock());

  return wallet;
}

module.exports = { installWallet };
