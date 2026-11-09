'use strict';

// The wallet page (murshid://wallet in the side panel). It holds no secrets:
// the main process (app/wallet) keeps the keys, signs, and decides. This page
// shows what it is told and passes on what the user chooses.

(() => {
  const api = window.murshidWallet;
  const strings = window.murshid?.i18n?.strings || {};
  const locale = window.murshid?.i18n?.locale || 'en';
  const $ = (id) => document.getElementById(id);
  const t = (key, vars) => {
    const text = strings[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text;
  };

  // Approving right as a card appears is never what was meant: a site could
  // time a request to land under a click aimed at something else.
  const APPROVE_DELAY_MS = 900;

  let state = null;
  let mode = null; // 'create' | 'import' | 'more' while one of those is open
  let createId = null; // the new phrase this panel shows
  let active = 'balance'; // the open column when they are stacked
  // What the receive and balance columns show is for one network of one
  // wallet: "network|address". Another wallet (restored in another window)
  // never inherits the old one's address or QR code.
  let balanceFor = null;
  let receiveFor = null;
  let walletKey = null; // the wallet this panel last drew (its addresses)
  let revealSeq = 0; // bumped whenever shown recovery words are cleared
  let review = null;
  let sendSeq = 0; // bumped whenever the send form starts over
  let shownRequest = null;
  let approveTimer = null;
  let toastTimer = null;
  let refreshTimer = null;

  const VIEWS = ['v-elsewhere', 'v-welcome', 'v-create', 'v-import', 'v-locked', 'v-main', 'v-more', 'v-request'];
  function show(id) {
    for (const view of VIEWS) $(view).hidden = view !== id;
  }

  async function call(command, ...args) {
    const answer = await api.invoke(command, ...args);
    if (answer?.error) {
      const error = new Error(answer.error.code);
      error.code = answer.error.code;
      error.detail = answer.error.detail;
      throw error;
    }
    return answer?.value;
  }

  function networkOf(id) {
    return state?.networks.find((n) => n.id === id) || null;
  }

  function networkName(net) {
    return net.testnet ? t('wallet.testnetName', { name: net.name }) : net.name;
  }

  function errorText(error, vars = {}) {
    const code = error?.code || 'failed';
    const key = `wallet.error.${code}`;
    if (strings[key]) return t(key, { message: error?.detail || code, ...vars });
    return t('wallet.error.failed', { message: error?.detail || code });
  }

  function setError(id, error, vars) {
    $(id).textContent = error ? errorText(error, vars) : '';
  }

  function busy(button, on) {
    button.disabled = on;
    button.setAttribute('aria-busy', String(on));
  }

  // ------------------------------------------------------------------ render

  function render() {
    if (!state) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
    // Reset, or replaced from another window: nothing of the old wallet stays
    // on screen, its recovery words least of all.
    const key = state.exists ? `${state.addresses.bitcoin}|${state.addresses.evm}` : null;
    if (key !== walletKey) {
      walletKey = key;
      clearRevealed();
      forgetShown();
    }
    if (!state.exists) {
      forgetShown();
      if (state.unreadable) $('unreadable').hidden = false;
      // Another panel may have gone back, or started over with other words.
      if (mode === 'create' && state.creating && state.creating === createId) show('v-create');
      else if (mode === 'import') show('v-import');
      else { mode = null; show('v-welcome'); }
      return;
    }
    if (mode === 'create' || mode === 'import') mode = null;
    if (!state.unlocked) {
      clearRevealed(); // locking puts the recovery words away too
      const waiting = state.requests[0];
      $('locked-waiting').hidden = !waiting;
      if (waiting) $('locked-waiting').textContent = t('wallet.waitingUnlock', { host: waiting.host });
      show('v-locked');
      if (document.activeElement?.tagName !== 'INPUT') $('unlock-password').focus();
      return;
    }
    if (state.requests.length) {
      renderRequest();
      show('v-request');
      return;
    }
    shownRequest = null;
    if (mode === 'more') {
      renderMore();
      show('v-more');
      return;
    }
    renderMain();
    show('v-main');
    refreshTimer = setInterval(() => loadBalance(true), 60000);
  }

  async function refreshState() {
    try {
      state = await call('state');
    } catch (error) {
      if (error.code === 'panelOnly') {
        show('v-elsewhere');
        return;
      }
      throw error;
    }
    render();
  }

  // ------------------------------------------------------------------ setup

  $('start-create').addEventListener('click', async () => {
    try {
      const created = await call('createPhrase');
      createId = created.id;
      const list = $('words');
      list.textContent = '';
      for (const word of created.words) {
        const li = document.createElement('li');
        li.textContent = word;
        list.append(li);
      }
      $('written').checked = false;
      $('create-password').value = '';
      $('create-repeat').value = '';
      setError('create-error', null);
      mode = 'create';
      await refreshState();
    } catch (error) {
      showToast(errorText(error), { error: true });
    }
  });

  $('start-import').addEventListener('click', () => {
    mode = 'import';
    $('import-phrase').value = '';
    $('import-password').value = '';
    $('import-repeat').value = '';
    setError('import-error', null);
    render();
    $('import-phrase').focus();
  });

  for (const button of document.querySelectorAll('[data-back]')) {
    button.addEventListener('click', () => {
      if (mode === 'create') call('cancelCreate', createId).catch(() => {});
      createId = null;
      $('words').textContent = '';
      mode = null;
      render();
    });
  }

  function checkPasswords(password, repeat) {
    if ([...password].length < 8) return { code: 'passwordShort' };
    if (password !== repeat) return { code: 'passwordMismatch' };
    return null;
  }

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!$('written').checked) {
      setError('create-error', { code: 'notWritten' });
      return;
    }
    const problem = checkPasswords($('create-password').value, $('create-repeat').value);
    if (problem) { setError('create-error', problem); return; }
    busy($('create-submit'), true);
    try {
      await call('finishCreate', createId, $('create-password').value);
      createId = null;
      $('words').textContent = '';
      mode = null;
      await refreshState();
    } catch (error) {
      setError('create-error', error);
    } finally {
      busy($('create-submit'), false);
      $('create-password').value = '';
      $('create-repeat').value = '';
    }
  });

  $('import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const problem = checkPasswords($('import-password').value, $('import-repeat').value);
    if (problem) { setError('import-error', problem); return; }
    busy($('import-submit'), true);
    try {
      await call('importPhrase', $('import-phrase').value, $('import-password').value);
      $('import-phrase').value = '';
      mode = null;
      await refreshState();
    } catch (error) {
      setError('import-error', error);
    } finally {
      busy($('import-submit'), false);
      $('import-password').value = '';
      $('import-repeat').value = '';
    }
  });

  $('unlock-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    busy($('unlock-submit'), true);
    setError('unlock-error', null);
    try {
      await call('unlock', $('unlock-password').value);
      $('unlock-password').value = '';
      await refreshState();
    } catch (error) {
      setError('unlock-error', error);
      $('unlock-password').select();
    } finally {
      busy($('unlock-submit'), false);
    }
  });

  async function resetWallet() {
    if (!window.confirm(t('wallet.resetConfirm'))) return;
    await call('reset');
    mode = null;
    balanceFor = null;
    receiveFor = null;
    await refreshState();
  }
  $('forgot').addEventListener('click', () => resetWallet().catch((error) => showToast(errorText(error), { error: true })));
  $('reset').addEventListener('click', () => resetWallet().catch((error) => showToast(errorText(error), { error: true })));

  // ------------------------------------------------------------------- main

  function fillNetworks() {
    const select = $('network');
    if (select.options.length === state.networks.length) {
      select.value = state.network;
      return;
    }
    select.textContent = '';
    for (const net of state.networks) {
      const option = document.createElement('option');
      option.value = net.id;
      option.textContent = networkName(net);
      select.append(option);
    }
    select.value = state.network;
  }

  function setActive(name) {
    active = name;
    for (const col of document.querySelectorAll('.col')) {
      const on = col.dataset.col === name;
      col.classList.toggle('active', on);
      col.querySelector('.col-head').setAttribute('aria-expanded', String(on));
    }
  }

  /** The wallet and network the columns should be showing now. */
  function shownKey() {
    const net = networkOf(state.network);
    const address = net.kind === 'bitcoin' ? state.addresses.bitcoin : state.addresses.evm;
    return `${net.id}|${address}`;
  }

  /** Clears the receive and balance columns, so nothing stale can be copied or scanned. */
  function forgetShown() {
    receiveFor = null;
    balanceFor = null;
    $('qr').removeAttribute('src');
    $('qr').alt = '';
    $('address').textContent = '';
    $('explorer').removeAttribute('href');
    $('balance-value').textContent = '…';
    $('sum-balance').textContent = '';
  }

  function renderMain() {
    fillNetworks();
    if (review && review.network !== state.network) resetSend(); // a site switched networks
    setActive(active);
    const net = networkOf(state.network);
    const isBitcoin = net.kind === 'bitcoin';
    $('send-symbol').textContent = net.symbol;
    $('balance-symbol').textContent = net.symbol;
    $('speeds').hidden = !isBitcoin;
    $('send-to').placeholder = isBitcoin ? t('wallet.toPlaceholderBtc') : t('wallet.toPlaceholderEvm');
    $('testnet-note').hidden = !net.testnet;
    $('receive-note').textContent = isBitcoin ? t('wallet.receiveNoteBtc') : t('wallet.receiveNoteEvm', { network: networkName(net) });
    const address = isBitcoin ? state.addresses.bitcoin : state.addresses.evm;
    $('sum-receive').textContent = `${address.slice(0, 6)}…${address.slice(-4)}`;
    const key = shownKey();
    if (receiveFor !== key) loadReceive();
    if (balanceFor !== key) loadBalance();
  }

  async function loadReceive() {
    const id = state.network;
    const key = shownKey();
    if (receiveFor !== key) {
      $('qr').removeAttribute('src');
      $('address').textContent = '';
      $('explorer').removeAttribute('href');
    }
    receiveFor = key;
    try {
      const info = await call('receive', id);
      if (!state?.exists || shownKey() !== key || info.address !== key.split('|')[1]) return;
      $('qr').src = info.qr;
      $('qr').alt = info.address;
      $('address').textContent = info.address;
      $('explorer').href = info.explorer;
    } catch (error) {
      receiveFor = null;
      showToast(errorText(error), { error: true });
    }
  }

  async function loadBalance(quiet = false) {
    const id = state?.network;
    if (!id || !state.unlocked || !state.exists) return;
    const key = shownKey();
    balanceFor = key;
    if (!quiet) {
      $('balance-value').textContent = '…';
      $('sum-balance').textContent = '';
    }
    setError('balance-error', null);
    try {
      const info = await call('balance', id);
      if (!state?.exists || shownKey() !== key) return;
      const net = networkOf(id);
      $('balance-value').textContent = info.value;
      $('balance-value').title = `${info.exact} ${info.symbol}`;
      $('sum-balance').textContent = `${info.value} ${info.symbol}`;
      $('balance-pending').hidden = !info.pending;
      if (info.pending) $('balance-pending').textContent = t('wallet.pending', { amount: `${info.pending} ${net.symbol}` });
    } catch (error) {
      if (!state?.exists || shownKey() !== key) return;
      if (!quiet) $('balance-value').textContent = '—';
      setError('balance-error', error);
    }
  }

  $('network').addEventListener('change', async () => {
    const id = $('network').value;
    resetSend();
    try {
      await call('setNetwork', id);
    } catch (error) {
      showToast(errorText(error), { error: true });
    }
  });

  for (const head of document.querySelectorAll('.col-head')) {
    head.addEventListener('click', () => setActive(head.closest('.col').dataset.col));
  }

  $('lock').addEventListener('click', () => call('lock').catch(() => {}));
  $('more').addEventListener('click', () => { mode = 'more'; render(); });
  $('refresh').addEventListener('click', () => loadBalance());

  $('copy').addEventListener('click', async () => {
    const address = $('address').textContent;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      $('copy-label').textContent = t('wallet.copied');
      setTimeout(() => { $('copy-label').textContent = t('wallet.copy'); }, 1400);
    } catch {}
  });

  // ------------------------------------------------------------------- send

  function resetSend() {
    sendSeq += 1; // a review still being prepared is no longer wanted
    if (review) call('cancelReview', review.id).catch(() => {});
    review = null;
    $('send-form').hidden = false;
    $('send-confirm').hidden = true;
    $('send-done').hidden = true;
    setError('send-error', null);
    setError('confirm-error', null);
  }

  async function startReview(max) {
    const net = networkOf(state.network);
    setError('send-error', null);
    const to = $('send-to').value.trim();
    const amount = $('send-amount').value.trim();
    const speed = document.querySelector('input[name="speed"]:checked')?.value || 'normal';
    const button = max ? $('send-max') : $('send-review');
    const seq = ++sendSeq;
    busy(button, true);
    try {
      const prepared = await call('review', { network: net.id, to, amount, max, speed });
      // The network changed (here or from a site) while it was being prepared:
      // this review is for the old one, so it is dropped, never shown.
      if (seq !== sendSeq || state.network !== net.id) {
        call('cancelReview', prepared.id).catch(() => {});
        return;
      }
      review = prepared;
      $('review-network').textContent = networkName(net);
      $('review-to').textContent = review.to;
      $('review-amount').textContent = `${review.amount} ${review.symbol}`;
      $('review-fee').textContent = `${review.fee} ${review.symbol}`;
      $('review-total').textContent = `${review.total} ${review.symbol}`;
      $('review-fee-note').textContent = review.feeRate
        ? t('wallet.feeRate', { rate: review.feeRate })
        : review.feeIsMaximum ? t('wallet.feeMaximum') : '';
      $('send-form').hidden = true;
      $('send-confirm').hidden = false;
      setError('confirm-error', null);
      $('send-now').focus();
    } catch (error) {
      if (seq === sendSeq && state.network === net.id) setError('send-error', error, { network: networkName(net) });
    } finally {
      busy(button, false);
    }
  }

  $('send-form').addEventListener('submit', (event) => {
    event.preventDefault();
    startReview(false);
  });
  $('send-max').addEventListener('click', () => startReview(true));
  $('send-cancel').addEventListener('click', resetSend);
  $('send-now').addEventListener('click', async () => {
    if (!review) return;
    if (review.network !== state.network) {
      resetSend();
      return;
    }
    const id = review.id;
    busy($('send-now'), true);
    busy($('send-cancel'), true);
    try {
      const result = await call('confirm', id);
      review = null;
      $('send-confirm').hidden = true;
      $('send-done').hidden = false;
      $('send-tx').href = result.url;
      $('send-to').value = '';
      $('send-amount').value = '';
      setTimeout(() => loadBalance(true), 4000);
    } catch (error) {
      review = null;
      setError('confirm-error', error);
      setTimeout(resetSend, 2600);
    } finally {
      busy($('send-now'), false);
      busy($('send-cancel'), false);
    }
  });
  $('send-again').addEventListener('click', resetSend);

  // ------------------------------------------------------------------- more

  function renderMore() {
    const list = $('sites');
    list.textContent = '';
    for (const origin of state.sites) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = origin.replace(/^https:\/\//, '');
      name.title = origin;
      name.dir = 'ltr';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button small quiet';
      button.textContent = t('wallet.disconnect');
      button.addEventListener('click', () => call('disconnect', origin).catch(() => {}));
      li.append(name, button);
      list.append(li);
    }
    $('sites-none').hidden = state.sites.length > 0;
  }

  /** Hides shown recovery words, and drops an answer still on its way. */
  function clearRevealed() {
    revealSeq += 1;
    $('reveal-words').hidden = true;
    $('reveal-words').textContent = '';
    $('reveal-password').value = '';
    setError('reveal-error', null);
  }

  $('more-back').addEventListener('click', () => {
    mode = null;
    clearRevealed();
    render();
  });

  $('reveal-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('reveal-error', null);
    const seq = revealSeq;
    try {
      const words = await call('revealPhrase', $('reveal-password').value);
      if (seq !== revealSeq) return; // the wallet changed while the password was checked
      const list = $('reveal-words');
      list.textContent = '';
      for (const word of words) {
        const li = document.createElement('li');
        li.textContent = word;
        list.append(li);
      }
      list.hidden = false;
    } catch (error) {
      setError('reveal-error', error);
    } finally {
      $('reveal-password').value = '';
    }
  });

  // --------------------------------------------------------------- requests

  function row(dl, label, value, { mono = true } = {}) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (mono) dd.dir = 'ltr';
    else dd.style.fontFamily = 'inherit';
    dl.append(dt, dd);
  }

  function para(text, className) {
    const p = document.createElement('p');
    if (className) p.className = className;
    p.textContent = text;
    return p;
  }

  function warning(text) {
    const p = document.createElement('p');
    p.className = 'note warn';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#w-warn');
    svg.append(use);
    const span = document.createElement('span');
    span.textContent = text;
    p.append(svg, span);
    return p;
  }

  function messageBox(label, text, ltr = true) {
    const wrap = document.createElement('div');
    wrap.append(para(label, 'message-label'));
    const pre = document.createElement('pre');
    pre.className = 'message';
    pre.textContent = text;
    if (ltr) pre.dir = 'ltr';
    else pre.dir = 'auto';
    wrap.append(pre);
    return wrap;
  }

  function renderRequest() {
    const request = state.requests[0];
    const body = $('request-body');
    const approve = $('request-approve');
    const d = request.details || {};
    $('request-count').textContent = state.requests.length > 1
      ? t('wallet.req.count', { current: 1, total: state.requests.length }) : '';
    $('request-host').textContent = request.host;
    $('request-site').classList.toggle('insecure', !request.secure);
    $('request-site').querySelector('use').setAttribute('href', request.secure ? '#w-lock' : '#w-warn');
    $('request-insecure').hidden = request.secure;
    $('request-reject').disabled = request.busy;
    if (shownRequest === request.id && !request.busy) return; // already drawn; keep the timer
    setError('request-error', null);

    body.textContent = '';
    let blocked = false;
    switch (request.kind) {
      case 'connect':
        $('request-title').textContent = t('wallet.req.connect');
        body.append(para(t('wallet.req.connectLede'), 'hint'));
        if (d.address) {
          const dl = document.createElement('dl');
          row(dl, t('wallet.account'), d.address);
          body.append(dl);
        }
        approve.textContent = t('wallet.connectButton');
        break;
      case 'sign':
        $('request-title').textContent = d.siwe ? t('wallet.req.signIn') : t('wallet.req.sign');
        if (d.siwe?.mismatch) body.append(warning(t('wallet.req.signInMismatch', { domain: d.siwe.domain })));
        if (d.text !== null && d.text !== undefined) body.append(messageBox(t('wallet.message'), d.text, false));
        else body.append(messageBox(t('wallet.messageHex'), d.hex || ''));
        approve.textContent = t('wallet.signButton');
        break;
      case 'typed': {
        $('request-title').textContent = t('wallet.req.typed');
        if (d.permit) body.append(warning(t('wallet.req.permit')));
        if (d.chainMismatch) body.append(warning(t('wallet.req.chainMismatch', { network: d.chainMismatch })));
        const dl = document.createElement('dl');
        if (d.domainName) row(dl, t('wallet.req.app'), d.domainName, { mono: false });
        if (d.contract) row(dl, t('wallet.req.contract'), d.contract);
        row(dl, t('wallet.req.type'), d.primaryType);
        body.append(dl, messageBox(t('wallet.message'), d.json || ''));
        approve.textContent = t('wallet.signButton');
        break;
      }
      case 'transaction': {
        $('request-title').textContent = t('wallet.req.tx');
        if (d.failure) body.append(warning(t('wallet.req.willFail', { reason: d.failure })));
        const call = d.call || {};
        if ((call.name === 'approve' || call.name === 'increaseAllowance') && call.spender) {
          body.append(warning(t(call.unlimited ? 'wallet.req.approveUnlimited' : 'wallet.req.approve', { spender: call.spender })));
        }
        if (call.name === 'setApprovalForAll' && call.approved && call.spender) body.append(warning(t('wallet.req.approveAll', { spender: call.spender })));
        const dl = document.createElement('dl');
        row(dl, t('wallet.network'), d.network, { mono: false });
        if (d.from) row(dl, t('wallet.account'), d.from);
        row(dl, t('wallet.to'), d.to || t('wallet.req.newContract'));
        row(dl, t('wallet.amount'), `${d.value} ${d.symbol}`);
        row(dl, t('wallet.fee'), d.fee ? t('wallet.upTo', { amount: `${d.fee} ${d.symbol}` }) : '—');
        body.append(dl);
        if (d.data) body.append(messageBox(t('wallet.req.data', { bytes: d.dataBytes }), d.data));
        approve.textContent = t('wallet.confirm');
        blocked = Boolean(d.blocked);
        break;
      }
      case 'switch':
        $('request-title').textContent = t('wallet.req.switch');
        body.append(para(t('wallet.req.switchLede', { from: d.from, network: d.network })));
        approve.textContent = t('wallet.switchButton');
        break;
      default:
        $('request-title').textContent = request.kind;
        approve.textContent = t('wallet.confirm');
    }

    clearTimeout(approveTimer);
    approve.disabled = true;
    if (!blocked && !request.busy) {
      approveTimer = setTimeout(() => { approve.disabled = false; }, shownRequest === request.id ? 0 : APPROVE_DELAY_MS);
    }
    shownRequest = request.id;
  }

  $('request-approve').addEventListener('click', async () => {
    const request = state?.requests[0];
    if (!request) return;
    $('request-approve').disabled = true;
    $('request-reject').disabled = true;
    try {
      await call('approve', request.id);
    } catch (error) {
      setError('request-error', error);
    }
  });

  $('request-reject').addEventListener('click', async () => {
    const request = state?.requests[0];
    if (!request) return;
    $('request-reject').disabled = true;
    try {
      await call('reject', request.id);
    } catch (error) {
      setError('request-error', error);
    }
  });

  // ------------------------------------------------------------------ toast

  function showToast(text, { error = false, url = null } = {}) {
    clearTimeout(toastTimer);
    $('toast').classList.toggle('error', error);
    $('toast-text').textContent = text;
    $('toast-link').hidden = !url;
    if (url) $('toast-link').href = url;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 7000);
  }

  // ---------------------------------------------------------------- startup

  document.documentElement.lang = locale;
  if (!api) {
    show('v-elsewhere');
    return;
  }
  api.on((message) => {
    if (message?.type === 'state') {
      refreshState().catch(() => {});
    } else if (message?.type === 'notice') {
      const notice = message.notice || {};
      if (notice.kind === 'sent') {
        showToast(t('wallet.sent'), { url: notice.url });
        setTimeout(() => loadBalance(true), 4000);
      } else if (notice.kind === 'error') {
        showToast(errorText(notice), { error: true });
      }
    }
  });
  refreshState().catch(() => show('v-elsewhere'));
})();
