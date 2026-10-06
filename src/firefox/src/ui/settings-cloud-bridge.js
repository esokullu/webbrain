// Settings → Bridge tab: URL, token, browser name, connection test.
// Sole owner of webbrainCloudBridge* keys; identity keys are
// read by cloud-runs.js when the bridge starts.
import { t } from './i18n.js';

const KEYS = {
  enabled: 'webbrainCloudBridgeEnabled',
  url: 'webbrainCloudBridgeUrl',
  token: 'webbrainCloudBridgeToken',
  browserId: 'webbrainCloudBridgeBrowserId',
  installationId: 'webbrainCloudBridgeInstallationId',
};
const DEFAULT_URL = 'ws://127.0.0.1:17374/extension';
const $ = (id) => document.getElementById(id);
const enabled = $('cb-enabled');
const urlInput = $('cb-url');
const tokenInput = $('cb-token');
const nameInput = $('cb-browser-id');
const installationEl = $('cb-installation-id');
const statusEl = $('cb-status');
const statusText = $('cb-status-text');
const testBtn = $('cb-test');
const presetButtons = Array.from(document.querySelectorAll('#cb-presets [data-cb-preset]'));
const customPill = $('cb-preset-custom');

async function send(action, data = {}) {
  const response = await browser.runtime.sendMessage({ target: 'background', action, ...data });
  if (response?.error) throw new Error(response.error);
  return response;
}

function setStatus(state, message) {
  statusEl.dataset.state = state;
  statusText.textContent = message;
}

function normalizeUrl(value) {
  const url = new URL(String(value || DEFAULT_URL));
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error(t('st.cb.invalid_url'));
  }
  return url.href;
}

function render(status = {}) {
  if (!enabled.checked || status.enabled === false) return setStatus('disabled', t('st.cb.status_disabled'));
  if (status.installationId) installationEl.textContent = status.installationId;
  if (status.approval === 'rejected') return setStatus('error', t('st.cb.rejected', { reason: status.lastError || '' }));
  if (status.connected) {
    if (status.approval === 'approved') return setStatus('connected', t('st.cb.approved'));
    if (status.approval === 'pending') return setStatus('waiting', t('st.cb.pending'));
    return setStatus('connected', t('st.cb.connected'));
  }
  if (status.lastError && status.lastError !== 'WebSocket error') return setStatus('error', t('st.cb.status_error', { error: status.lastError }));
  setStatus('waiting', t('st.cb.unreachable', { url: status.url || urlInput.value || DEFAULT_URL }));
}

function pillUrl(value) {
  try { return normalizeUrl(value); } catch { return ''; }
}

function markCustomPill() {
  for (const btn of presetButtons) {
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
  }
  if (customPill) {
    customPill.classList.add('active');
    customPill.setAttribute('aria-pressed', 'true');
  }
}

function markActivePill(url) {
  const current = pillUrl(url);
  let matched = false;
  for (const btn of presetButtons) {
    const on = !!current && pillUrl(btn.dataset.cbPreset) === current;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    if (on) matched = true;
  }
  if (!matched) markCustomPill();
}

async function load() {
  const stored = await browser.storage.local.get(Object.values(KEYS));
  enabled.checked = !!stored[KEYS.enabled];
  urlInput.value = stored[KEYS.url] || DEFAULT_URL;
  markActivePill(urlInput.value);
  tokenInput.value = stored[KEYS.token] || '';
  nameInput.value = stored[KEYS.browserId] || '';
  installationEl.textContent = stored[KEYS.installationId] || '—';
  const approvalDetails = $('cb-approval-details');
  if (approvalDetails && stored[KEYS.token]) approvalDetails.open = true;
  if (enabled.checked) refresh();
  else render({ enabled: false });
}

async function refresh() {
  if (!enabled.checked || document.hidden) return;
  try { render(await send('cloud_bridge_status')); } catch (e) { setStatus('error', e.message); }
}

async function save() {
  const url = normalizeUrl(urlInput.value);
  urlInput.value = url;
  const patch = { [KEYS.url]: url, [KEYS.enabled]: enabled.checked, [KEYS.token]: tokenInput.value.trim() };
  const name = nameInput.value.trim();
  await browser.storage.local.set(patch);
  if (name) await browser.storage.local.set({ [KEYS.browserId]: name });
  else await browser.storage.local.remove(KEYS.browserId);
  return url;
}

async function testConnection() {
  testBtn.disabled = true;
  setStatus('waiting', t('st.cb.testing'));
  try {
    enabled.checked = true; // testing implies connecting
    const url = await save();
    let status = await send('cloud_bridge_start', { url });
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      status = await send('cloud_bridge_status');
      if (status.approval === 'rejected' || status.approval === 'approved' || (status.connected && status.approval === 'not_required')) break;
    }
    render(status);
    const stored = await browser.storage.local.get(KEYS.installationId);
    installationEl.textContent = stored[KEYS.installationId] || '—';
  } catch (e) {
    setStatus('error', e.message);
  } finally {
    testBtn.disabled = false;
  }
}

enabled.addEventListener('change', async () => {
  try {
    await save();
    if (enabled.checked) render(await send('cloud_bridge_start', { url: urlInput.value }));
    else { await send('cloud_bridge_stop').catch(() => null); render({ enabled: false }); }
  } catch (e) { setStatus('error', e.message); }
});
testBtn.addEventListener('click', testConnection);
for (const btn of presetButtons) {
  btn.addEventListener('click', async () => {
    try {
      urlInput.value = btn.dataset.cbPreset;
      const url = await save();
      markActivePill(url);
      if (enabled.checked) render(await send('cloud_bridge_start', { url }));
    } catch (e) { setStatus('error', e.message); }
  });
}
if (customPill) {
  customPill.addEventListener('click', () => {
    markCustomPill();
    urlInput.focus();
  });
}
urlInput.addEventListener('input', () => markCustomPill());
setInterval(refresh, 2000);
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.values(KEYS).some((k) => changes[k]) && !document.activeElement?.closest('#cb-card')) load();
});
load();
