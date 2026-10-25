// Only a protected, disposable new-tab surface can be normalized before the
// first visual observation. Never use this to escape an arbitrary page.
const NEW_TAB_URLS = new Set([
  'chrome://newtab/', 'chrome://new-tab-page/', 'edge://newtab/',
  'chrome-search://local-ntp/local-ntp.html', 'about:newtab', 'about:home',
]);

export function isVisionBootstrapNewTab(value, runtime = globalThis.chrome?.runtime) {
  if (typeof value !== 'string') return false;
  if (NEW_TAB_URLS.has(value)) return true;
  try {
    const own = new URL(runtime.getURL('newtab/index.html'));
    const candidate = new URL(value);
    return ['chrome-extension:', 'moz-extension:'].includes(own.protocol)
      && candidate.protocol === own.protocol && candidate.host === own.host
      && candidate.pathname === own.pathname && !candidate.username && !candidate.password;
  } catch { return false; }
}

const pendingNavigation = tab => typeof tab?.pendingUrl === 'string' && tab.pendingUrl !== ''
  && tab.pendingUrl !== tab.url;
const checkpointError = () => Object.assign(new Error('The startup navigation checkpoint could not be saved. No further browser action is permitted.'),
  { code: 'vision_checkpoint_failed', noDispatch: true });

// The caller grants this one recovery attempt only for its initial capture.
// beforeDispatch includes durable ownership/checkpoint hooks; the final tab
// check follows every awaited authorization so a user navigation wins.
export async function bootstrapVisionNewTab(tabId, error, {
  api = globalThis.browser || globalThis.chrome, signal, assertCurrent = () => {},
  beforeDispatch, afterDispatch = async () => {}, prepareDestination,
} = {}) {
  if (error?.code !== 'vision_capture_restricted_target') return { retry: false, dispatched: false };
  const current = () => { signal?.throwIfAborted(); assertCurrent(); };
  current();
  const original = await api.tabs.get(tabId);
  current();
  if (original?.id !== tabId || !isVisionBootstrapNewTab(original.url, api.runtime))
    return { retry: false, dispatched: false };
  if (pendingNavigation(original)) return { retry: true, dispatched: false };
  let firefox = false;
  try { firefox = new URL(api.runtime.getURL('')).protocol === 'moz-extension:'; } catch {}
  // Firefox's native owner must register a unique blank-context binding.
  // Plain about:blank cannot identify the extension tab among other tabs.
  if ((firefox || ['about:newtab', 'about:home'].includes(original.url)) && typeof prepareDestination !== 'function')
    return { retry: false, dispatched: false };
  if (typeof beforeDispatch !== 'function') throw checkpointError();
  const saved = await beforeDispatch();
  if (saved === false || saved?.ok === false) throw checkpointError();
  current();
  const destination = typeof prepareDestination === 'function' ? await prepareDestination(tabId) : { url: 'about:blank' };
  current();
  const url = destination?.url;
  if (firefox ? !/^about:blank#wb-vision-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url || '')
    : url !== 'about:blank') throw Object.assign(new Error('The browser could not prepare an owned blank startup context.'),
      { code: 'vision_bootstrap_unavailable', noDispatch: true });
  const latest = await api.tabs.get(tabId);
  current();
  if (latest?.id !== tabId || latest.url !== original.url || pendingNavigation(latest)) {
    const settled = await afterDispatch({ success: false, noDispatch: true, dispatched: false, outcomeUnknown: false });
    if (settled === false || settled?.ok === false) throw checkpointError();
    current();
    return { retry: true, dispatched: false };
  }
  // No website is visited and no model action is synthesized. The next model
  // request still requires a real screenshot of this same browser tab.
  await api.tabs.update(tabId, { url });
  current();
  const result = { success: true, dispatched: true, navigated: true, outcomeUnknown: false, bootstrap: true };
  const settled = await afterDispatch(result);
  if (settled === false || settled?.ok === false) throw Object.assign(checkpointError(), { noDispatch: false, dispatched: true });
  current();
  return { retry: true, dispatched: true, url };
}
