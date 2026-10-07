/** MAIN-world attachment signal; contains no page content or input values. */
(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
  const original = descriptor?.value;
  if (typeof original !== 'function' || original.__webbrainShadowMonitor) return;
  function attachShadow(options) {
    const root = Reflect.apply(original, this, arguments);
    // Observe before the caller fills the new root. Dormant monitors emit
    // nothing, and detached hosts are discovered when inserted in the DOM.
    if (root.mode === 'open' && this.isConnected && document.documentElement?.hasAttribute('data-webbrain-page-revision')) {
      try { this.dispatchEvent(new Event('webbrain-shadow-root-attached', { bubbles: true, composed: true })); } catch {}
    }
    return root;
  }
  Object.defineProperty(attachShadow, '__webbrainShadowMonitor', { value: true });
  try { Object.defineProperty(Element.prototype, 'attachShadow', { ...descriptor, value: attachShadow }); } catch {}
})();
