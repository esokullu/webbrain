/**
 * Lightweight, all-frame DOM region collector for local screenshot redaction.
 * Runs in the extension's isolated world. Form field *values* never leave
 * their frame — only rects and kinds are reported. Matched email/phone
 * *text* is the exception: it rides along in the `text` field so the agent
 * can re-classify it, but it never leaves the local background/service
 * worker (no network transmission).
 *
 * The email/phone regex heuristics below (`looksLikePiiText`) are a twin of
 * `EMAIL_RE`/`PHONE_RE` in agent/screenshot-redaction.js. Keep both in sync —
 * this file's pre-filter and the agent's re-classification must agree, or
 * regions selected here can be silently dropped downstream.
 */
(function () {
  'use strict';
  if (globalThis.__webbrain_redaction_regions_injected) return;
  globalThis.__webbrain_redaction_regions_injected = true;

  const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
  if (!runtime?.onMessage) return;
  const ownedDocumentToken = globalThis.crypto?.randomUUID?.() || null;

  function ownedNewtabDocument(params) {
    try {
      const expected = new URL(runtime.getURL('newtab/index.html'));
      const current = new URL(window.location.href);
      const documentToken = ownedDocumentToken;
      if (params?.ownedNewtabOnly !== true || window.top !== window
          || !['chrome-extension:', 'moz-extension:'].includes(expected.protocol)
          || current.protocol !== expected.protocol || current.host !== expected.host
          || current.pathname !== expected.pathname || current.username || current.password
          || current.href !== params.expectedUrl
          || typeof documentToken !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentToken)) return null;
      return { documentUrl: current.href, documentToken };
    } catch { return null; }
  }

  function collectRedactionRegions(params) {
    const ownedDocument = params?.ownedNewtabOnly === true ? ownedNewtabDocument(params) : null;
    if (params?.ownedNewtabOnly === true && !ownedDocument) return { complete: false };
    const space = params?.coordinateSpace === 'page' ? 'page' : 'viewport';
    const sx = space === 'page' ? (window.scrollX || window.pageXOffset || 0) : 0;
    const sy = space === 'page' ? (window.scrollY || window.pageYOffset || 0) : 0;
    const toRect = (r) => ({
      x: Math.round(r.left + sx),
      y: Math.round(r.top + sy),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
    const visible = (r) => r.width > 0 && r.height > 0 && (
      space === 'page' || (
        r.right > 0 && r.bottom > 0 &&
        r.left < window.innerWidth && r.top < window.innerHeight
      )
    );
    const contributesPixels = (element, r) => {
      if (!visible(r)) return false;
      try {
        for (let current = element; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
              || Number.parseFloat(style.opacity) === 0) return false;
        }
      } catch { /* geometry remains the conservative fallback */ }
      return true;
    };
    const looksLikePiiText = (text) => {
      const trimmed = String(text || '').trim();
      const looksLikeEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(trimmed) &&
        trimmed.split(/\s+/).length <= 3;
      const digitCount = (trimmed.match(/\d/g) || []).length;
      const looksLikePhone = digitCount >= 7 && digitCount <= 15 &&
        /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/.test(trimmed) &&
        !/^\d{4}$/.test(trimmed) && trimmed.split(/\s+/).length <= 6;
      return looksLikeEmail || looksLikePhone;
    };

    let viewport = {
      width: Math.max(1, Math.round(window.innerWidth || 1)),
      height: Math.max(1, Math.round(window.innerHeight || 1)),
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
    };
    if (space === 'page') {
      viewport = {
        width: Math.round(Math.max(document.documentElement.scrollWidth || viewport.width, viewport.width)),
        height: Math.round(Math.max(document.documentElement.scrollHeight || viewport.height, viewport.height)),
      };
    }

    const selected = [];
    const MAX_REGIONS = 400;
    const MAX_SCANNED_TEXT_NODES = 6000;
    let overflowed = false;
    let collectionComplete = true;
    const addRegion = (region) => {
      if (selected.length >= MAX_REGIONS) {
        overflowed = true;
        return false;
      }
      selected.push(region);
      return true;
    };
    try {
      const fields = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]), textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
      );
      for (const el of fields) {
        const r = el.getBoundingClientRect();
        if (!visible(r)) continue;
        const tag = (el.tagName || '').toLowerCase();
        const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
        const kind = tag === 'select' ? 'select' : (tag === 'textarea' || el.isContentEditable ? 'textarea' : 'input');
        if (!addRegion({ kind, type, rect: toRect(r) })) break;
      }

      if (!overflowed) {
        const nodes = document.querySelectorAll('p, span, div, a, td, th, li, h1, h2, h3, h4, h5, h6, label, small, b, strong, i');
        let scanned = 0;
        for (const el of nodes) {
          if (scanned >= MAX_SCANNED_TEXT_NODES) {
            collectionComplete = false;
            break;
          }
          scanned += 1;
          if (el.children.length > 0) continue;
          const text = (el.textContent || '').trim();
          if (text.length < 5 || text.length > 60 || !looksLikePiiText(text)) continue;
          const r = el.getBoundingClientRect();
          if (!visible(r)) continue;
          if (!addRegion({ kind: 'text', type: '', rect: toRect(r), text })) break;
        }
      }
    } catch {
      collectionComplete = false;
    }

    const childFrames = [];
    try {
      // This opt-in is confined to the extension's own newtab. Its child
      // documents may be absent from webNavigation, so mask their whole boxes.
      if (ownedDocument) {
        let inspected = 0;
        for (const element of document.querySelectorAll('*')) {
          if (++inspected > MAX_SCANNED_TEXT_NODES || element.shadowRoot
              || String(element.tagName || '').includes('-')) {
            // Do not claim full coverage of an uninspected shadow document.
            collectionComplete = false;
            break;
          }
        }
      }
      const childSelector = ownedDocument ? 'iframe, frame, object, embed' : 'iframe, frame';
      for (const frame of document.querySelectorAll(childSelector)) {
        if (ownedDocument && childFrames.length >= MAX_REGIONS) {
          overflowed = true;
          break;
        }
        const r = frame.getBoundingClientRect();
        const transformX = r.width / (frame.offsetWidth || r.width || 1);
        const transformY = r.height / (frame.offsetHeight || r.height || 1);
        childFrames.push({
          url: frame.src || frame.getAttribute('src') || 'about:blank',
          // Keep non-rendered descriptors so navigation-frame order remains
          // unambiguous, but do not require privacy inspection for frames that
          // contribute no pixels to this capture.
          // The owned fallback masks conservatively from geometry: a child
          // can override an ancestor's visibility:hidden and remain visible.
          rendered: ownedDocument ? visible(r) : contributesPixels(frame, r),
          rect: ownedDocument ? {
            x: r.left + sx, y: r.top + sy, w: r.width, h: r.height,
          } : {
            x: r.left + sx + (frame.clientLeft || 0) * transformX,
            y: r.top + sy + (frame.clientTop || 0) * transformY,
            w: (frame.clientWidth || r.width) * transformX,
            h: (frame.clientHeight || r.height) * transformY,
          },
        });
      }
    } catch {
      collectionComplete = false;
    }

    return {
      ...(ownedDocument ? { ...ownedDocument, ownedNewtabCoverage: true } : {}),
      elements: selected,
      viewport,
      childFrames,
      overflowed,
      complete: collectionComplete && !overflowed,
    };
  }

  function waitForExactChildFrameRect(params) {
    const token = String(params?.token || '');
    const expectedChildOrigin = String(params?.expectedChildOrigin || '');
    if (!token) return Promise.resolve({ found: false });
    return new Promise(resolve => {
      // A single claim is answered after this quiet window so a second frame
      // racing the same token is seen before the geometry is trusted.
      const CLAIM_CONTENTION_MS = 30;
      let settled = false;
      let timer = null;
      let contentionTimer = null;
      let claimant = null;
      let claimedFrame = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(contentionTimer);
        window.removeEventListener('message', onMessage);
        resolve(value);
      };
      const toRect = rect => ({
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
      });
      const reachableFrames = () => {
        const frames = [];
        const roots = [document];
        const seenRoots = new Set();
        while (roots.length) {
          const root = roots.shift();
          if (!root || seenRoots.has(root)) continue;
          seenRoots.add(root);
          for (const frame of root.querySelectorAll?.('iframe, frame') || []) frames.push(frame);
          for (const element of root.querySelectorAll?.('*') || []) {
            try {
              if (element.shadowRoot && !seenRoots.has(element.shadowRoot)) roots.push(element.shadowRoot);
            } catch {}
          }
        }
        return frames;
      };
      const hasOpaqueSandboxOrigin = frame => {
        const sandboxValue = frame?.getAttribute?.('sandbox');
        return sandboxValue != null
          && !String(sandboxValue).toLowerCase().split(/\s+/).includes('allow-same-origin');
      };
      const onMessage = event => {
        if (event?.data?.__webbrainExactFrameRectToken !== token) return;
        const frame = reachableFrames()
          .find(candidate => candidate.contentWindow === event.source);
        if (!frame) return;
        // The token is necessarily transported across the page/content-script
        // boundary. Bind it to the exact child window and its origin. Sandboxed
        // frames without allow-same-origin (and their descendants) have an
        // opaque "null" origin, so accept that value only from the matching
        // frame after the background has verified the sandbox chain.
        const opaqueSandboxClaim = event.origin === 'null'
          && (params?.allowOpaqueChildOrigin === true || hasOpaqueSandboxOrigin(frame));
        if (expectedChildOrigin && event.origin !== expectedChildOrigin && !opaqueSandboxClaim) return;
        // The agent announces this token to exactly one child frame, so a
        // second distinct claimant is a frame answering for a token that was
        // never sent to it. Resolving the first arrival would let it decide
        // which iframe the geometry describes, so contention fails closed.
        if (claimant && claimant !== event.source) {
          finish({ found: false, contended: true });
          return;
        }
        if (!claimant) {
          claimant = event.source;
          claimedFrame = frame;
          contentionTimer = setTimeout(() => resolveClaim(), CLAIM_CONTENTION_MS);
          return;
        }
        // Duplicate delivery from the same frame is not independent evidence.
        // Keep the full contention window open so a different claimant still
        // has a chance to make this lookup fail closed.
      };
      const resolveClaim = () => {
        const frame = claimedFrame;
        if (!frame || !frame.isConnected) {
          finish({ found: false });
          return;
        }
        let outer = frame.getBoundingClientRect();
        const offscreen = outer.right <= 0 || outer.bottom <= 0
          || outer.left >= window.innerWidth || outer.top >= window.innerHeight;
        const scrolled = params?.scrollIntoView === true && offscreen;
        if (scrolled) {
          try { frame.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch {}
          outer = frame.getBoundingClientRect();
        }
        const transformX = outer.width / (frame.offsetWidth || outer.width || 1);
        const transformY = outer.height / (frame.offsetHeight || outer.height || 1);
        finish({
          found: true,
          scrolled,
          outerRect: {
            ...toRect(outer),
            pageX: outer.left + (window.scrollX || window.pageXOffset || 0),
            pageY: outer.top + (window.scrollY || window.pageYOffset || 0),
          },
          contentRect: {
            x: outer.left + (frame.clientLeft || 0) * transformX,
            y: outer.top + (frame.clientTop || 0) * transformY,
            w: (frame.clientWidth || outer.width) * transformX,
            h: (frame.clientHeight || outer.height) * transformY,
          },
          ownerMeta: {
            tag: String(frame.tagName || '').toLowerCase(),
            id: frame.id || null,
            name: frame.getAttribute?.('name') || null,
            role: frame.getAttribute?.('role') || null,
          },
          childOriginOpaque: params?.allowOpaqueChildOrigin === true || hasOpaqueSandboxOrigin(frame),
        });
      };
      window.addEventListener('message', onMessage);
      timer = setTimeout(() => finish({ found: false }), 750);
    });
  }

  function announceExactChildFrame(params) {
    const token = String(params?.token || '');
    const parentOrigin = String(params?.parentOrigin || '');
    if (!token || window.parent === window) return { announced: false };
    try {
      window.parent.postMessage(
        { __webbrainExactFrameRectToken: token },
        parentOrigin || '*',
      );
      return { announced: true };
    } catch { return { announced: false }; }
  }

  runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'redaction-content') return;
    if (msg.action === 'get_redaction_regions') {
      sendResponse(collectRedactionRegions(msg.params || {}));
    } else if (msg.action === 'confirm_redaction_document') {
      const identity = ownedNewtabDocument(msg.params);
      sendResponse(identity && identity.documentToken === msg.params?.documentToken
        ? { current: true, ...identity } : { current: false });
    } else if (msg.action === 'wait_for_exact_child_frame_rect') {
      waitForExactChildFrameRect(msg.params || {}).then(sendResponse);
      return true;
    } else if (msg.action === 'announce_exact_child_frame') {
      sendResponse(announceExactChildFrame(msg.params || {}));
    }
  });
})();
