/** Firefox MV2 reinjection fallback; normal document startup uses MAIN world. */
(() => {
  try {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('src/content/page-monitor-shadow.js');
    script.async = false;
    script.onload = script.onerror = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch {}
})();
