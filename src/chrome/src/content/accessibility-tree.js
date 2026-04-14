/**
 * WebBrain — in-page accessibility tree builder.
 *
 * This is a port of the approach used by Claude for Chrome
 * (claudeplugin/assets/accessibility-tree.js). The original ships minified;
 * this is a clean re-implementation of the same algorithm.
 *
 * Key properties (match Claude's behaviour):
 *
 * 1. OUTPUT IS A FLAT INDENTED TEXT STRING, not a JSON tree. Each kept node
 *    becomes one line:
 *
 *        button "Sign in" [ref_42] type="submit"
 *          option "United States" [ref_43] (selected)
 *        link "Pricing" [ref_44] href="/pricing"
 *
 *    Indentation is 1 space per tree-depth level (depth increases for kept
 *    ancestors; skipped ancestors don't bump depth, so the tree visually
 *    flattens generic containers).
 *
 * 2. ref_id IS STABLE ACROSS CALLS. ref_ids live in window.__wbElementMap as
 *    WeakRefs, so an element keeps its `ref_N` identifier for as long as it
 *    remains in the DOM. Between calls we sweep entries whose deref() is
 *    gone, so the map doesn't grow unbounded.
 *
 * 3. Parameters:
 *      filter:  'all' | 'visible' | 'interactive' (default 'all')
 *      maxDepth: number of tree levels to descend (default 15)
 *      maxChars: hard cap on total output length
 *      refId:   if set, build the subtree rooted at that previously-seen
 *               element instead of document.body. Enables follow-up reads
 *               like "read the subtree under the nav I already identified".
 *
 * 4. Node keep-criteria (in 'visible' or 'interactive' filter):
 *      a) element passes the filter's visibility / interactivity check, AND
 *      b) EITHER is interactive, OR is a landmark/heading, OR has a computed
 *         accessible name, OR has a non-generic, non-image role.
 *
 *    Skipped nodes still contribute their children to the output (children
 *    are emitted at the parent's depth, so generic wrappers collapse).
 *
 * 5. Additional exports used by click_ax / type_ax:
 *      window.__wb_ax_lookup(refId) → Element | null
 *      window.__wb_ax_release(refId) → void (optional cleanup)
 */
(() => {
  if (window.__wb_ax_installed) return;
  window.__wb_ax_installed = true;

  // ── Persistent ref_id registry ──────────────────────────────────────────
  if (!window.__wbElementMap) window.__wbElementMap = Object.create(null);
  if (typeof window.__wbRefCounter !== 'number') window.__wbRefCounter = 0;

  const MAX_NAME_LEN = 100;

  // ── Role inference (matches Claude's mapping) ───────────────────────────
  const TAG_ROLES = {
    a: 'link',
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'image',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    section: 'region',
    article: 'article',
    aside: 'complementary',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    label: 'label',
  };

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = el.getAttribute('type');
      if (t === 'submit' || t === 'button' || t === 'file') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return TAG_ROLES[tag] || 'generic';
  }

  // ── Accessible name (matches Claude's priority order) ───────────────────
  function getAccessibleName(el) {
    const tag = el.tagName.toLowerCase();

    // <select> — prefer the currently selected option's label.
    if (tag === 'select') {
      const opt = el.querySelector('option[selected]') || (el.options && el.options[el.selectedIndex]);
      if (opt && opt.textContent && opt.textContent.trim()) {
        return opt.textContent.trim();
      }
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();

    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();

    if (el.id) {
      try {
        const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (byFor && byFor.textContent && byFor.textContent.trim()) {
          return byFor.textContent.trim();
        }
      } catch {}
    }

    if (tag === 'input') {
      const t = el.getAttribute('type') || '';
      const valAttr = el.getAttribute('value');
      if (t === 'submit' && valAttr && valAttr.trim()) return valAttr.trim();
      // Use the current live value when it's short — useful for buttons/search.
      if (el.value && el.value.length < 50 && el.value.trim()) return el.value.trim();
    }

    // Button/link/summary: only direct text children (avoids absorbing
    // nested button labels twice).
    if (tag === 'button' || tag === 'a' || tag === 'summary') {
      let text = '';
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
      }
      if (text.trim()) return text.trim();
    }

    if (/^h[1-6]$/.test(tag)) {
      const s = el.textContent;
      if (s && s.trim()) return s.trim().substring(0, MAX_NAME_LEN);
    }

    // Images without alt get no name (alt was already handled above).
    if (tag === 'img') return '';

    // Fallback: direct text children only, at least 3 chars.
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    if (text.trim() && text.trim().length >= 3) {
      const v = text.trim();
      return v.length > MAX_NAME_LEN ? v.substring(0, MAX_NAME_LEN) + '...' : v;
    }
    return '';
  }

  // ── Visibility ──────────────────────────────────────────────────────────
  function isVisible(el) {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden') return false;
    if (cs.opacity === '0') return false;
    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
    return true;
  }

  function isInViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
  }

  // ── Interactivity / landmark checks ─────────────────────────────────────
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']);
  const LANDMARK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside']);

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (el.getAttribute('onclick') !== null) return true;
    if (el.getAttribute('tabindex') !== null) return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function isLandmark(el) {
    if (LANDMARK_TAGS.has(el.tagName.toLowerCase())) return true;
    return el.getAttribute('role') !== null;
  }

  // ── Skip tags ──────────────────────────────────────────────────────────
  const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript']);

  /**
   * Should this element be INCLUDED in the output? (Its children are still
   * walked regardless — they bubble up to the parent's depth if this node
   * is skipped.)
   */
  function shouldInclude(el, opts) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return false;

    if (opts.filter !== 'all' && el.getAttribute('aria-hidden') === 'true') return false;
    if (opts.filter !== 'all' && !isVisible(el)) return false;

    // The 'visible' default restricts to in-viewport elements, UNLESS we're
    // anchored at a specific refId (then we want the whole subtree).
    if (opts.filter !== 'all' && !opts.refId) {
      if (!isInViewport(el)) return false;
    }

    if (opts.filter === 'interactive') return isInteractive(el);

    if (isInteractive(el)) return true;
    if (isLandmark(el)) return true;
    if (getAccessibleName(el).length > 0) return true;

    const role = getRole(el);
    return role !== null && role !== 'generic' && role !== 'image';
  }

  // ── Ref_id management ───────────────────────────────────────────────────
  //
  // Elements keep the same ref_id across calls: if we already have a WeakRef
  // pointing at `el`, reuse its key; otherwise mint a new ref_N.
  function getOrMintRef(el) {
    for (const key in window.__wbElementMap) {
      if (window.__wbElementMap[key].deref() === el) return key;
    }
    const key = 'ref_' + (++window.__wbRefCounter);
    window.__wbElementMap[key] = new WeakRef(el);
    return key;
  }

  function sweepDeadRefs() {
    for (const key in window.__wbElementMap) {
      if (!window.__wbElementMap[key].deref()) {
        delete window.__wbElementMap[key];
      }
    }
  }

  // ── Line formatting ────────────────────────────────────────────────────
  function formatLine(el, depth) {
    const role = getRole(el);
    let name = getAccessibleName(el);
    const ref = getOrMintRef(el);

    let line = ' '.repeat(depth) + role;
    if (name) {
      name = name.replace(/\s+/g, ' ').substring(0, MAX_NAME_LEN).replace(/"/g, '\\"');
      line += ' "' + name + '"';
    }
    line += ' [' + ref + ']';

    const href = el.getAttribute('href');
    if (href) line += ' href="' + href + '"';
    const type = el.getAttribute('type');
    if (type) line += ' type="' + type + '"';
    const ph = el.getAttribute('placeholder');
    if (ph) line += ' placeholder="' + ph + '"';

    return line;
  }

  function formatOption(opt, depth) {
    const ref = getOrMintRef(opt);
    const rawName = opt.textContent ? opt.textContent.trim() : '';
    const name = rawName.replace(/\s+/g, ' ').substring(0, MAX_NAME_LEN).replace(/"/g, '\\"');
    let line = ' '.repeat(depth) + 'option';
    if (name) line += ' "' + name + '"';
    line += ' [' + ref + ']';
    if (opt.selected) line += ' (selected)';
    if (opt.value && opt.value !== rawName) {
      line += ' value="' + opt.value.replace(/"/g, '\\"') + '"';
    }
    return line;
  }

  // ── Walker ─────────────────────────────────────────────────────────────
  function walk(el, depth, opts, lines) {
    if (depth > opts.maxDepth) return;
    if (!el || !el.tagName) return;

    // An element anchored via refId is always included at depth 0, even if
    // it wouldn't normally pass the include filter.
    const included = shouldInclude(el, opts) || (opts.refId != null && depth === 0);

    if (included) {
      lines.push(formatLine(el, depth));

      if (el.tagName.toLowerCase() === 'select' && el.options) {
        for (const opt of el.options) {
          lines.push(formatOption(opt, depth + 1));
        }
      }
    }

    if (el.children && depth < opts.maxDepth) {
      const nextDepth = included ? depth + 1 : depth;
      for (const child of el.children) {
        walk(child, nextDepth, opts, lines);
      }
    }
  }

  // ── Public: build the tree ──────────────────────────────────────────────
  function generateAccessibilityTree(filter, maxDepth, maxChars, refId) {
    try {
      const opts = {
        filter: filter || 'all',
        maxDepth: maxDepth != null ? maxDepth : 15,
        refId: refId || null,
      };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const lines = [];

      if (refId) {
        const weak = window.__wbElementMap[refId];
        if (!weak) {
          return {
            error: `Element with ref_id '${refId}' not found. It may have been removed from the page. Call get_accessibility_tree without ref_id to get the current page state.`,
            pageContent: '',
            viewport,
          };
        }
        const el = weak.deref();
        if (!el) {
          delete window.__wbElementMap[refId];
          return {
            error: `Element with ref_id '${refId}' no longer exists. It may have been removed from the page. Call get_accessibility_tree without ref_id to get the current page state.`,
            pageContent: '',
            viewport,
          };
        }
        walk(el, 0, opts, lines);
      } else if (document.body) {
        walk(document.body, 0, opts, lines);
      }

      sweepDeadRefs();

      const output = lines.join('\n');
      if (maxChars != null && output.length > maxChars) {
        let hint = `Output exceeds ${maxChars} character limit (${output.length} characters). `;
        if (refId) {
          hint += 'The specified element has too much content. Try a smaller maxDepth or a more specific child element.';
        } else if (maxDepth !== undefined) {
          hint += 'Try a smaller maxDepth or use refId to focus on a specific element.';
        } else {
          hint += 'Try a maxDepth (e.g., maxDepth: 5) or use refId to focus on a specific element.';
        }
        return { error: hint, pageContent: '', viewport };
      }

      return { pageContent: output, viewport };
    } catch (e) {
      return {
        error: 'Error generating accessibility tree: ' + (e && e.message || 'Unknown error'),
        pageContent: '',
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    }
  }

  // ── Public: lookup by ref_id (used by click_ax / type_ax) ──────────────
  function lookup(refId) {
    const weak = window.__wbElementMap[refId];
    if (!weak) return null;
    const el = weak.deref();
    if (!el) {
      delete window.__wbElementMap[refId];
      return null;
    }
    return el;
  }

  window.__generateAccessibilityTree = generateAccessibilityTree;
  window.__wb_ax_lookup = lookup;
})();
