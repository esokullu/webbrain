/**
 * WebBrain Content Script
 * Injected into every page — handles page reading and DOM actions.
 */

(() => {
  // Prevent double-injection
  if (window.__webbrain_injected) return;
  window.__webbrain_injected = true;

  /**
   * Extract readable text content from the page.
   */
  function getPageText() {
    // Try to get article/main content first
    const selectors = ['article', 'main', '[role="main"]', '.content', '#content'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 200) {
        return el.innerText.trim();
      }
    }
    return document.body.innerText.trim();
  }

  /**
   * Get page metadata.
   */
  function getPageInfo() {
    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      text: getPageText(),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: a.innerText.trim().slice(0, 100),
        href: a.href,
      })),
      forms: Array.from(document.querySelectorAll('form')).map((form, i) => ({
        id: form.id || `form-${i}`,
        action: form.action,
        inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(el => ({
          type: el.type || el.tagName.toLowerCase(),
          name: el.name,
          id: el.id,
          placeholder: el.placeholder || '',
          value: el.value || '',
        })),
      })),
    };
  }

  function getPageInfoFull() {
    const getShadowContent = (root = document) => {
      const shadowContent = [];
      const hosts = root.querySelectorAll('*');
      hosts.forEach(el => {
        if (el.shadowRoot) {
          shadowContent.push({
            host: el.tagName.toLowerCase(),
            id: el.id || '',
            className: el.className || '',
            mode: el.shadowRoot.mode,
            text: el.shadowRoot.innerText?.trim().slice(0, 500) || '',
          });
          shadowContent.push(...getShadowContent(el.shadowRoot));
        }
      });
      return shadowContent;
    };

    return {
      url: window.location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      text: getPageText(),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(a => ({
        text: a.innerText.trim().slice(0, 100),
        href: a.href,
      })),
      forms: Array.from(document.querySelectorAll('form')).map((form, i) => ({
        id: form.id || `form-${i}`,
        action: form.action,
        inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(el => ({
          type: el.type || el.tagName.toLowerCase(),
          name: el.name,
          id: el.id,
          placeholder: el.placeholder || '',
          value: el.value || '',
        })),
      })),
      shadowDOM: getShadowContent(),
      iframes: Array.from(document.querySelectorAll('iframe')).map((iframe, i) => ({
        index: i,
        src: iframe.src,
        id: iframe.id || '',
        name: iframe.name || '',
        visible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0,
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Interactive-element discovery — single source of truth for
  // getInteractiveElements / click({index}) / type_text({index}). Kept
  // in lockstep with src/chrome/src/content/content.js (and the CDP
  // mirror in src/chrome/src/cdp/cdp-client.js). See that file for
  // rationale.
  // ---------------------------------------------------------------------
  const INTERACTIVE_SELECTORS = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[onclick]',
    '[data-action]',
    'summary',
    'label',
  ];

  function isVisiblyInteractive(el) {
    if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') return false;
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity === '0' && el.tagName !== 'SELECT') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    // Styled-wrapper pattern: real input is 0x0 but a visible label or
    // wrapper makes it reachable.
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (el.id) {
        try {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) {
            const lrect = label.getBoundingClientRect();
            if (lrect.width > 0 && lrect.height > 0) return true;
          }
        } catch {}
      }
      let p = el.parentElement;
      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
        const pr = p.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) return true;
      }
    }
    return false;
  }

  /**
   * Detect the topmost modal/overlay/dialog on the page. Returns the modal
   * container element, or null if no overlay is detected.
   */
  function _findTopmostModal() {
    const dialogs = document.querySelectorAll('dialog[open]');
    if (dialogs.length > 0) return dialogs[dialogs.length - 1];

    const ariaModals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    for (let i = ariaModals.length - 1; i >= 0; i--) {
      const r = ariaModals[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return ariaModals[i];
    }

    const roleDialogs = document.querySelectorAll('[role="dialog"]');
    for (let i = roleDialogs.length - 1; i >= 0; i--) {
      const r = roleDialogs[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return roleDialogs[i];
    }

    const candidates = document.querySelectorAll(
      '[data-overlay], [data-state="open"][role="dialog"], ' +
      '.modal.show, .modal-overlay, .overlay, [class*="modal"][class*="open"], ' +
      '[class*="overlay"][class*="active"], [class*="DialogOverlay"], ' +
      '[class*="ModalOverlay"]'
    );
    for (let i = candidates.length - 1; i >= 0; i--) {
      const r = candidates[i].getBoundingClientRect();
      if (r.width > 100 && r.height > 100) return candidates[i];
    }

    return null;
  }

  function queryInteractive() {
    const all = document.querySelectorAll(INTERACTIVE_SELECTORS.join(', '));
    const modal = _findTopmostModal();
    const out = [];
    for (const el of all) {
      if (!isVisiblyInteractive(el)) continue;
      if (modal && !modal.contains(el)) continue;
      out.push(el);
    }
    return out;
  }

  /** Find the visible label associated with a form element. */
  function _getFieldLabel(el) {
    if (el.id) {
      try {
        const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl) return lbl.innerText.trim().slice(0, 50);
      } catch {}
    }
    const parent = el.closest('label');
    if (parent) {
      const t = parent.innerText.trim().slice(0, 50);
      if (t && t !== (el.value || '').trim()) return t;
    }
    if (el.ariaLabel) return el.ariaLabel.trim().slice(0, 50);
    if (el.getAttribute('aria-labelledby')) {
      const lbl = document.getElementById(el.getAttribute('aria-labelledby'));
      if (lbl) return lbl.innerText.trim().slice(0, 50);
    }
    const prev = el.previousElementSibling;
    if (prev && /^(LABEL|SPAN|DIV)$/i.test(prev.tagName)) {
      const t = prev.innerText.trim().slice(0, 50);
      if (t && t.length < 50) return t;
    }
    return '';
  }

  /**
   * Get a simplified DOM snapshot for the agent.
   */
  function getInteractiveElements() {
    return queryInteractive().map((el, index) => {
      let rect = el.getBoundingClientRect();
      // If element has zero dimensions (hidden input in styled wrapper),
      // use the visible label or wrapper rect instead.
      if (rect.width === 0 || rect.height === 0) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          let fallbackRect = null;
          if (el.id) {
            try {
              const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (lbl) { const lr = lbl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fallbackRect = lr; }
            } catch {}
          }
          if (!fallbackRect) {
            const wl = el.closest('label');
            if (wl) { const lr = wl.getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) fallbackRect = lr; }
          }
          if (!fallbackRect) {
            let p = el.parentElement;
            for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
              const pr = p.getBoundingClientRect();
              if (pr.width > 0 && pr.height > 0) { fallbackRect = pr; break; }
            }
          }
          if (fallbackRect) rect = fallbackRect;
        }
      }
      const entry = {
        index,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        role: el.getAttribute('role') || '',
        text: (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim().slice(0, 100),
        id: el.id || '',
        name: el.name || '',
        href: el.href || '',
        editable: el.isContentEditable || false,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
        const label = _getFieldLabel(el);
        if (label) entry.label = label;
      }
      if (el.tagName === 'SELECT') {
        entry.hint = 'Use type_text({index: ' + index + ', text: "option"}) to change this dropdown';
        entry.options = Array.from(el.options).map(o => o.text.trim()).slice(0, 10);
      }
      return entry;
    });
  }

  function getInteractiveElementsFull() {
    const collected = [];
    const seen = new Set();

    const isUsable = (el, rect) => {
      if (rect.width < 2 || rect.height < 2) return false;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      if (rect.right < 0 || rect.left > window.innerWidth) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (cs.pointerEvents === 'none') return false;
      let parent = el.parentElement;
      while (parent) {
        if (seen.has(parent)) {
          const pRect = parent.getBoundingClientRect();
          if (Math.abs(pRect.left - rect.left) < 4 && Math.abs(pRect.top - rect.top) < 4) {
            return false;
          }
        }
        parent = parent.parentElement;
      }
      return true;
    };

    const pierceShadow = (root) => {
      const selectors = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
        '[onclick]', '[data-action]', 'summary',
      ];
      selectors.forEach(sel => {
        try {
          root.querySelectorAll(sel).forEach(el => {
            if (seen.has(el)) return;
            const rect = el.getBoundingClientRect();
            if (!isUsable(el, rect)) return;
            seen.add(el);
            collected.push({ el, rect, inShadow: root !== document });
          });
        } catch (e) {}
      });
      try {
        root.querySelectorAll('*').forEach(host => {
          if (host.shadowRoot) pierceShadow(host.shadowRoot);
        });
      } catch (e) {}
    };

    pierceShadow(document);

    collected.sort((a, b) => {
      const dy = a.rect.top - b.rect.top;
      if (Math.abs(dy) > 6) return dy;
      return a.rect.left - b.rect.left;
    });

    return collected.map((c, i) => {
      const el = c.el;
      return {
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        role: el.getAttribute('role') || '',
        text: (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim().slice(0, 100),
        id: el.id || '',
        name: el.name || '',
        href: el.href || '',
        rect: { x: Math.round(c.rect.x), y: Math.round(c.rect.y), w: Math.round(c.rect.width), h: Math.round(c.rect.height) },
        inShadowDOM: c.inShadow,
      };
    });
  }

  // -- Click helpers: interactive-element detection & parent traversal --------
  const _INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
  const _INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option']);
  const _PASSIVE_TAGS = new Set(['LABEL', 'SPAN', 'DIV', 'P', 'STRONG', 'EM', 'I', 'B', 'SMALL', 'SVG', 'IMG']);

  function _isInteractive(node) {
    if (_INTERACTIVE_TAGS.has(node.tagName)) return true;
    const role = (node.getAttribute && node.getAttribute('role')) || '';
    if (_INTERACTIVE_ROLES.has(role)) return true;
    if (node.hasAttribute && (node.hasAttribute('onclick') || node.hasAttribute('data-action'))) return true;
    return false;
  }

  /** Walk up from a passive child to find its interactive ancestor (up to 5 levels). */
  function _resolveInteractiveAncestor(el) {
    if (!_PASSIVE_TAGS.has(el.tagName) || _isInteractive(el)) return el;
    let ancestor = el.parentElement;
    for (let i = 0; i < 5 && ancestor; i++, ancestor = ancestor.parentElement) {
      if (_isInteractive(ancestor)) return ancestor;
    }
    return el; // no interactive ancestor found — use original
  }

  let _lastClickIdent = null;

  /**
   * Click an element by selector or coordinates.
   */
  function clickElement(params) {
    let el;
    // Reject jQuery/Playwright selectors with a clear error.
    if (params.selector && /:contains\(|:has-text\(/.test(params.selector)) {
      return {
        success: false,
        error: 'Invalid selector: ":contains()" and ":has-text()" are jQuery/Playwright extensions, not valid CSS. Use click({text: "..."}) to click by visible text instead.',
      };
    }
    // Text-based: find the first interactive element whose text contains the
    // given string, case-insensitive. Prefer exact match, then prefix, then
    // substring.
    if (params.text) {
      const needle = params.text.toLowerCase();
      const explicit = params.textMatch || '';
      // Include inputs/select/textarea so we can match by placeholder, value, or aria-label
      const sels = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), textarea, select, input[type="button"], input[type="submit"], summary, label, [onclick], [data-action]';
      const all = Array.from(document.querySelectorAll(sels));
      const normalized = all.map(e => ({
        e,
        txt: (e.innerText || e.value || e.placeholder || e.ariaLabel || '').trim().toLowerCase(),
      })).filter(x => !!x.txt);

      // Build label→input map so we can match label text and resolve to associated input
      const labelMap = new Map();
      document.querySelectorAll('label').forEach(lbl => {
        const txt = (lbl.innerText || '').trim().toLowerCase();
        if (!txt) return;
        let target = null;
        if (lbl.htmlFor) target = document.getElementById(lbl.htmlFor);
        if (!target) target = lbl.querySelector('input,textarea,select');
        if (target) labelMap.set(txt, target);
      });

      function tryMode(mode) {
        if (mode === 'exact') return normalized.filter(x => x.txt === needle);
        if (mode === 'prefix') return normalized.filter(x => x.txt.startsWith(needle));
        if (mode === 'contains') return normalized.filter(x => x.txt.includes(needle));
        return [];
      }

      const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
      if (explicit && !['exact', 'prefix', 'contains'].includes(explicit)) {
        return { success: false, error: `Invalid textMatch "${explicit}". Use exact, prefix, or contains.` };
      }

      let matches = [];
      let usedMode = modes[0];
      for (const m of modes) {
        matches = tryMode(m);
        usedMode = m;
        if (matches.length === 1) break;
        if (matches.length > 1) break;
      }

      // If no direct match, try label→input map
      if (matches.length === 0) {
        for (const [ltxt, inp] of labelMap) {
          const ok = (needle === ltxt) || ltxt.startsWith(needle) || ltxt.includes(needle);
          if (ok) {
            inp.scrollIntoView({ block: 'center', inline: 'center' });
            inp.focus();
            el = inp;
            break;
          }
        }
      }

      if (!el && matches.length === 0) {
        // Auto-scroll retry: scroll down up to 3 times to find elements below the fold
        for (let scrollAttempt = 0; scrollAttempt < 3 && matches.length === 0; scrollAttempt++) {
          window.scrollBy(0, Math.round(window.innerHeight * 0.7));
          // Re-query after scroll
          const allRetry = Array.from(document.querySelectorAll(sels));
          const normRetry = allRetry.map(e => ({
            e,
            txt: (e.innerText || e.value || e.placeholder || e.ariaLabel || '').trim().toLowerCase(),
          })).filter(x => !!x.txt);
          for (const m of modes) {
            if (m === 'exact') matches = normRetry.filter(x => x.txt === needle);
            else if (m === 'prefix') matches = normRetry.filter(x => x.txt.startsWith(needle));
            else if (m === 'contains') matches = normRetry.filter(x => x.txt.includes(needle));
            usedMode = m;
            if (matches.length >= 1) break;
          }
          // Also retry label→input map after scroll
          if (matches.length === 0) {
            const labelMap2 = new Map();
            document.querySelectorAll('label').forEach(lbl => {
              const txt = (lbl.innerText || '').trim().toLowerCase();
              if (!txt) return;
              let target = null;
              if (lbl.htmlFor) target = document.getElementById(lbl.htmlFor);
              if (!target) target = lbl.querySelector('input,textarea,select');
              if (target) labelMap2.set(txt, target);
            });
            for (const [ltxt, inp] of labelMap2) {
              const ok = (needle === ltxt) || ltxt.startsWith(needle) || ltxt.includes(needle);
              if (ok) {
                inp.scrollIntoView({ block: 'center', inline: 'center' });
                inp.focus();
                el = inp;
                break;
              }
            }
            if (el) break;
          }
        }
        if (!el && matches.length === 0) {
          return { success: false, error: `No clickable element found for text "${params.text}" (also tried scrolling down)` };
        }
      }
      if (!el && matches.length > 1) {
        // Prefer interactive elements over passive children (label, span, etc.)
        const interactiveMatches = matches.filter(m => _isInteractive(m.e));
        if (interactiveMatches.length === 1) {
          matches = interactiveMatches;
        } else {
          return {
            success: false,
            error: `Ambiguous text match for "${params.text}" (mode=${usedMode}, matches=${matches.length}).`,
            candidates: matches.slice(0, 5).map(m => m.txt.slice(0, 80)),
          };
        }
      }
      if (!el) {
        let resolved = matches[0].e;
        // LABEL → associated input resolution
        if (resolved.tagName === 'LABEL') {
          let target = null;
          if (resolved.htmlFor) target = document.getElementById(resolved.htmlFor);
          if (!target) target = resolved.querySelector('input,textarea,select');
          if (!target && resolved.nextElementSibling) {
            const ns = resolved.nextElementSibling;
            if (/^(INPUT|TEXTAREA|SELECT)$/i.test(ns.tagName)) target = ns;
            else target = ns.querySelector('input,textarea,select');
          }
          if (target) { target.focus(); resolved = target; }
        }
        el = _resolveInteractiveAncestor(resolved);
      }
    } else if (params.selector) {
      el = document.querySelector(params.selector);
    } else if (params.index != null) {
      // Same traversal as getInteractiveElements — index stability.
      el = queryInteractive()[params.index];
    } else if (params.x != null && params.y != null) {
      el = document.elementFromPoint(params.x, params.y);
    }

    if (!el) return { success: false, error: 'Element not found' };

    // ── Auto-select: if click text matches a <select> option, select it ──
    if (params.text) {
      const needle = params.text.trim();
      const lc = needle.toLowerCase();
      const allSels = document.querySelectorAll('select');
      for (const sel of allSels) {
        const opts = Array.from(sel.options);
        const match = opts.find(o => o.text.trim() === needle)
          || opts.find(o => o.text.trim().toLowerCase() === lc)
          || opts.find(o => o.value === needle)
          || opts.find(o => o.value.toLowerCase() === lc);
        if (match && sel.selectedIndex !== match.index) {
          sel.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(sel, match.value);
          else sel.value = match.value;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, method: 'auto-select', selectedText: match.text.trim(), selectedValue: match.value };
        }
      }
    }

    // <select> intercept: clicking opens a native OS dropdown that cannot be
    // controlled programmatically. Return error so the model uses type_text.
    // Do NOT scrollIntoView (hidden selects inside modals scroll to wrong position).
    if (el instanceof HTMLSelectElement) {
      el.focus();
      const options = Array.from(el.options).map(o => o.text.trim());
      return {
        success: false,
        tag: 'SELECT',
        text: el.options[el.selectedIndex]?.text?.trim() || '',
        error: `CANNOT CLICK a <select> dropdown — clicking opens a native OS popup that cannot be controlled. The dropdown is now focused (current: "${el.options[el.selectedIndex]?.text?.trim() || ''}"). Use type_text({text: "option name"}) to change the value. Available options: ${options.join(', ')}`,
      };
    }

    // Also check if the target element is near a SELECT (sibling pattern)
    if (!(el instanceof HTMLSelectElement)) {
      const p = el.parentElement;
      let nearbySel = null;
      if (p) { for (const sib of p.children) { if (sib.tagName === 'SELECT') { nearbySel = sib; break; } } }
      if (!nearbySel) {
        const anc = el.closest ? el.closest('[class]') : null;
        if (anc) nearbySel = anc.querySelector('select');
      }
      if (nearbySel) {
        nearbySel.focus();
        const options = Array.from(nearbySel.options).map(o => o.text.trim());
        return {
          success: false,
          tag: 'SELECT',
          text: nearbySel.options[nearbySel.selectedIndex]?.text?.trim() || '',
          error: `CANNOT CLICK — a <select> dropdown is near this element (current: "${nearbySel.options[nearbySel.selectedIndex]?.text?.trim() || ''}"). The dropdown is now focused. Use type_text({text: "option name"}) to change the value. Available options: ${options.join(', ')}`,
        };
      }
    }

    // Do NOT scrollIntoView on SELECT elements (hidden selects in modals cause scroll jumps)
    if (el.tagName !== 'SELECT') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    el.click();

    // Post-click SELECT detection: the click may have activated a <select>
    // via a label, wrapper, or overlapping element. Return error, not success.
    const postActive = document.activeElement;
    if (postActive && postActive !== el && postActive instanceof HTMLSelectElement) {
      postActive.blur();
      postActive.focus(); // close native popup, keep focus
      const postOpts = Array.from(postActive.options).map(o => o.text.trim());
      return {
        success: false,
        tag: 'SELECT',
        text: postActive.options[postActive.selectedIndex]?.text?.trim() || '',
        error: `CANNOT CLICK — a <select> dropdown was activated by this click (current: "${postActive.options[postActive.selectedIndex]?.text?.trim() || ''}"). The dropdown is now focused. Use type_text({text: "option name"}) to change the value. Available options: ${postOpts.join(', ')}`,
      };
    }

    // Stale click detection: warn if the same element is clicked again
    const ident = `${el.tagName}|${(el.innerText || '').slice(0, 50)}|${location.href}`;
    let warning;
    if (_lastClickIdent === ident) {
      warning = 'Same element clicked again with no page change. Try click({x, y}) with coordinates from a screenshot, or click({index: N}) from get_interactive_elements.';
    }
    _lastClickIdent = ident;
    return { success: true, tag: el.tagName, text: el.innerText?.slice(0, 50), ...(warning ? { warning } : {}) };
  }

  let _lastTypeFieldIdent = null;

  /**
   * Type text into an input/textarea.
   */
  function typeText(params) {
    let el;
    if (params.selector) {
      el = document.querySelector(params.selector);
    } else if (params.index != null) {
      el = queryInteractive()[params.index];
    } else {
      // No selector and no index → type into the currently focused element.
      // Most reliable for click-then-type flows on forms with weird selectors.
      el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return { success: false, error: 'No editable element is currently focused. Click the target input/textarea first, then call type_text again with no selector.' };
      }
      // Verify it's actually editable
      const editable = el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
      if (!editable) {
        return {
          success: false,
          error: `Focused element <${el.tagName.toLowerCase()}> is not an editable field. Click the target input/textarea first, then call type_text again.`,
        };
      }
    }

    if (!el) return { success: false, error: 'Element not found' };

    // Guard: only INPUT, TEXTAREA, SELECT, and contenteditable are typeable.
    // Calling HTMLInputElement's native value setter on anything else throws
    // "Illegal invocation" because the setter requires `this` to be an input.
    const isTypeable = el.isContentEditable
      || el instanceof HTMLInputElement
      || el instanceof HTMLTextAreaElement
      || el instanceof HTMLSelectElement;
    if (!isTypeable) {
      const tag = (el.tagName || '').toLowerCase();
      return {
        success: false,
        error: `Cannot type into <${tag}> — it is not an editable field. If you wanted to activate it, use click instead. If the real target is a nearby input, click the input first, then call type_text({text: "..."}) with no selector.`,
      };
    }

    el.focus();

    // contenteditable path (Notion, Google Docs comments, Lexical,
    // ProseMirror, Slate, Draft — all need the beforeinput → input →
    // change sequence with a real inputType, or their internal state
    // won't update).
    if (el.isContentEditable) {
      if (params.clear) el.textContent = '';
      el.textContent += params.text;
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: params.text }));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: params.text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'contenteditable', value: el.textContent.slice(0, 100) };
    }

    // <select>: match by value or option text.
    // Use native setter to bypass React's value property wrapper.
    if (el instanceof HTMLSelectElement) {
      const needle = (params.text || '').trim();
      const byValue = Array.from(el.options).find(o => o.value === needle);
      const byText = Array.from(el.options).find(o => o.text.trim() === needle)
        || Array.from(el.options).find(o => o.text.trim().toLowerCase().includes(needle.toLowerCase()));
      const match = byValue || byText;
      if (!match) {
        return { success: false, error: `No <option> matching "${params.text}" in select.` };
      }
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, match.value);
      else el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, method: 'select', value: el.value };
    }

    if (params.clear) {
      el.value = '';
    }

    // Use input events for React/Vue compatibility
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, (params.clear ? '' : (el.value || '')) + params.text);
    } else {
      el.value = (params.clear ? '' : (el.value || '')) + params.text;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Duplicate-field detection
    const fieldIdent = `${el.tagName}|${el.name || el.id || ''}|${params.selector || 'focused'}`;
    let typeWarning;
    if (_lastTypeFieldIdent === fieldIdent) {
      typeWarning = 'You typed into the same field twice in a row. If you intended to fill a DIFFERENT field, click it first before calling type_text.';
    }
    _lastTypeFieldIdent = fieldIdent;

    return { success: true, value: (el.value || '').slice(0, 100), ...(typeWarning ? { warning: typeWarning } : {}) };
  }

  /**
   * Press supported keyboard keys.
   */
  function pressKeys(params) {
    const key = params?.key;
    const repeatRaw = Number(params?.repeat ?? 1);
    const repeat = Math.max(1, Math.min(3, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 1));
    if (!['Escape', 'Tab', 'Enter'].includes(key)) {
      return { success: false, error: `Unsupported key "${key}". V1 supports Escape, Tab, and Enter.` };
    }

    const keyMeta = {
      Escape: { code: 'Escape', keyCode: 27 },
      Tab: { code: 'Tab', keyCode: 9 },
      Enter: { code: 'Enter', keyCode: 13 },
    }[key];
    const target = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement
      : document;

    const moveTabFocus = () => {
      const focusables = Array.from(document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (focusables.length === 0) return;
      const active = document.activeElement;
      const currentIndex = focusables.indexOf(active);
      const nextIndex = (currentIndex + 1 + focusables.length) % focusables.length;
      try { focusables[nextIndex].focus(); } catch (e) {}
    };

    for (let i = 0; i < repeat; i++) {
      const down = new KeyboardEvent('keydown', {
        key,
        code: keyMeta.code,
        keyCode: keyMeta.keyCode,
        which: keyMeta.keyCode,
        bubbles: true,
        cancelable: true,
      });
      const up = new KeyboardEvent('keyup', {
        key,
        code: keyMeta.code,
        keyCode: keyMeta.keyCode,
        which: keyMeta.keyCode,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(down);
      document.dispatchEvent(down);
      target.dispatchEvent(up);
      document.dispatchEvent(up);
      if (key === 'Tab') moveTabFocus();
    }

    return { success: true, key, repeat, method: 'keyboardevent', focusedTag: document.activeElement?.tagName || null };
  }

  /**
   * Scroll the page.
   */
  function scrollPage(params) {
    const amount = params.amount || 500;
    const direction = params.direction || 'down';

    // Find the best scrollable container. On many sites (Stripe, Jira, etc.)
    // the window itself isn't scrollable — the content lives inside a
    // scrollable div/section. Walk ancestors of the focused or last-clicked
    // element, or fall back to the most scrollable element on the page.
    let target = null;

    // Strategy 1: find a scrollable ancestor of the active/focused element.
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      let el = active.parentElement;
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = window.getComputedStyle(el);
          const ov = style.overflowY;
          if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') {
            target = el;
            break;
          }
        }
        el = el.parentElement;
      }
    }

    // Strategy 2: find the largest scrollable container on the page.
    if (!target) {
      let best = null;
      let bestArea = 0;
      const candidates = document.querySelectorAll('div, section, main, article, [role="main"], [role="dialog"]');
      for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = window.getComputedStyle(el);
          const ov = style.overflowY;
          if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') {
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
              bestArea = area;
              best = el;
            }
          }
        }
      }
      if (best && bestArea > window.innerWidth * window.innerHeight * 0.15) {
        target = best;
      }
    }

    if (target) {
      if (direction === 'down') target.scrollBy(0, amount);
      else if (direction === 'up') target.scrollBy(0, -amount);
      else if (direction === 'top') target.scrollTo(0, 0);
      else if (direction === 'bottom') target.scrollTo(0, target.scrollHeight);
    }

    // Always also scroll the window in case both are needed.
    if (direction === 'down') window.scrollBy(0, amount);
    else if (direction === 'up') window.scrollBy(0, -amount);
    else if (direction === 'top') window.scrollTo(0, 0);
    else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);

    return {
      success: true,
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
      ...(target ? { scrolledContainer: true, containerScrollY: target.scrollTop, containerScrollHeight: target.scrollHeight } : {}),
    };
  }

  /**
   * Extract structured data (tables, lists) from the page.
   */
  function extractData(params) {
    const type = params.type || 'tables';

    if (type === 'tables') {
      return Array.from(document.querySelectorAll('table')).slice(0, 10).map((table, i) => {
        const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
          Array.from(tr.querySelectorAll('th, td')).map(cell => cell.innerText.trim())
        );
        return { index: i, rows };
      });
    }

    if (type === 'headings') {
      return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
        level: parseInt(h.tagName[1]),
        text: h.innerText.trim(),
      }));
    }

    if (type === 'images') {
      return Array.from(document.querySelectorAll('img[src]')).slice(0, 50).map(img => ({
        src: img.src,
        alt: img.alt || '',
        width: img.naturalWidth,
        height: img.naturalHeight,
      }));
    }

    return { error: `Unknown data type: ${type}` };
  }

  /**
   * Wait for a selector to appear on the page.
   */
  function waitForElement(params) {
    return new Promise((resolve) => {
      const timeout = params.timeout || 5000;
      const existing = document.querySelector(params.selector);
      if (existing) {
        resolve({ success: true, found: true });
        return;
      }

      const observer = new MutationObserver(() => {
        if (document.querySelector(params.selector)) {
          observer.disconnect();
          resolve({ success: true, found: true });
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve({ success: true, found: false, timedOut: true });
      }, timeout);
    });
  }

  function getShadowDOM() {
    const collect = (root = document) => {
      const hosts = root.querySelectorAll('*');
      const result = [];
      hosts.forEach(el => {
        if (el.shadowRoot) {
          result.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            className: el.className || '',
            mode: el.shadowRoot.mode,
            text: el.shadowRoot.innerText?.trim().slice(0, 200) || '',
          });
          result.push(...collect(el.shadowRoot));
        }
      });
      return result;
    };
    return { success: true, shadowHosts: collect() };
  }

  function getFrames() {
    return {
      success: true,
      frames: Array.from(document.querySelectorAll('iframe')).map((iframe, i) => ({
        index: i,
        src: iframe.src,
        id: iframe.id || '',
        name: iframe.name || '',
        visible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0,
      })),
    };
  }

  // --- Message handler ---
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content') return;

    const handlers = {
      'get_page_info': () => getPageInfo(),
      'get_page_info_cdp': () => getPageInfoFull(),
      'get_interactive_elements': () => getInteractiveElements(),
      'get_interactive_elements_cdp': () => getInteractiveElementsFull(),
      'click': () => clickElement(msg.params || {}),
      'type': () => typeText(msg.params || {}),
      'press_keys': () => pressKeys(msg.params || {}),
      'scroll': () => scrollPage(msg.params || {}),
      'extract_data': () => extractData(msg.params || {}),
      'wait_for_element': () => waitForElement(msg.params || {}),
      'get_selection': () => ({ text: window.getSelection()?.toString() || '' }),
      'execute_js': () => {
        try {
          const fn = new Function(msg.params.code);
          return { success: true, result: fn() };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      'get_shadow_dom': () => getShadowDOM(),
      'get_frames': () => getFrames(),
    };

    const handler = handlers[msg.action];
    if (!handler) {
      sendResponse({ error: `Unknown action: ${msg.action}` });
      return;
    }

    const result = handler();
    if (result instanceof Promise) {
      result.then(sendResponse);
      return true; // async
    }
    sendResponse(result);
  });
})();
