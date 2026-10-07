/** Value-free, run-scoped page monitoring. Keep the Firefox copy byte-identical. */
(() => {
  const previousMonitor = window.__wbPageMonitor;
  const recoveryOnly = window.__wbPageMonitorRecoveryOnly === true;
  delete window.__wbPageMonitorRecoveryOnly;
  if (previousMonitor && !previousMonitor.disposed
      && (recoveryOnly || previousMonitor.active === true)) return;
  previousMonitor?.dispose?.();
  const api = globalThis.browser || globalThis.chrome;
  // randomUUID is secure-context-only; related data frames and HTTP pages
  // still provide getRandomValues for unpredictable document/action tokens.
  const randomToken = () => crypto.randomUUID?.()
    || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const documentToken = randomToken();
  const listeners = [];
  const operations = new Map();
  const modelSnapshots = new Map();
  const MODEL_SNAPSHOT_MS = 120000;
  const MODEL_TARGET_LIMIT = 512;
  const MODEL_SCAN_LIMIT = 2048;
  const MODEL_PUBLIC_MAX = 12000;
  const MODEL_EVIDENCE_MAX = 2000;
  const agentLayoutHistory = [];
  const nativeTargets = new Set();
  // Weak references keep disconnected fields from outliving the DOM until their batch is sampled.
  const controlReferences = new Set();
  let signatures = new WeakMap();
  let controlSignatures = new WeakMap();
  let textSignatures = new WeakMap();
  let popoverTurns = new WeakMap();
  let roots = new WeakSet();
  let animationAttribution = new WeakMap();
  let active = false, disposed = false, runToken = '', seq = 0, revision = 0, interventionRevision = 0;
  let observer = null, layoutObserver = null, domTimer = null, scrollTimer = null, controlTimer = null, lastUserAt = 0;
  let pointerHeld = false, composing = false, localOperation = null, controlIterator = null;
  let preparedOperationCursor = 0;
  let requestGeneration = 0, unreported = 0, interventionUnreported = 0, pendingDOM = null;
  let lastViewport = '';
  let agentResize = null;
  let lastFeedbackDelivery = Promise.resolve();
  let agentTurn = null, userTurn = null, lastUserTarget = null;
  let matchedEvents = new WeakMap();
  const activePointers = new Set();
  const fenceAttribute = 'data-webbrain-page-revision';
  const nativeMarkerAttribute = 'data-webbrain-native-action';
  const nativeMarkerMask = (1n << 64n) - 1n;
  const nativeMarkerRotate = (value, bits) => ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & nativeMarkerMask;
  function nativeMarkerSignature(secret, data) {
    if (!/^[a-f\d]{32}$/i.test(secret || '')) return '';
    const key = Uint8Array.from(secret.match(/.{2}/g), byte => parseInt(byte, 16));
    const read64 = offset => {
      let value = 0n;
      for (let index = 0; index < 8; index++) value |= BigInt(key[offset + index]) << BigInt(index * 8);
      return value;
    };
    const k0 = read64(0), k1 = read64(8);
    const rotate = nativeMarkerRotate;
    let v0 = 0x736f6d6570736575n ^ k0, v1 = 0x646f72616e646f6dn ^ k1;
    let v2 = 0x6c7967656e657261n ^ k0, v3 = 0x7465646279746573n ^ k1;
    const round = () => {
      v0 = (v0 + v1) & nativeMarkerMask; v1 = rotate(v1, 13); v1 ^= v0; v0 = rotate(v0, 32);
      v2 = (v2 + v3) & nativeMarkerMask; v3 = rotate(v3, 16); v3 ^= v2;
      v0 = (v0 + v3) & nativeMarkerMask; v3 = rotate(v3, 21); v3 ^= v0;
      v2 = (v2 + v1) & nativeMarkerMask; v1 = rotate(v1, 17); v1 ^= v2; v2 = rotate(v2, 32);
    };
    const bytes = new TextEncoder().encode(JSON.stringify([data.documentToken, data.runToken, data.operationId, data.revision,
      data.kind, data.sequence, data.navigationCandidate === true]));
    let offset = 0;
    while (offset + 8 <= bytes.length) {
      let block = 0n;
      for (let index = 0; index < 8; index++) block |= BigInt(bytes[offset + index]) << BigInt(index * 8);
      v3 ^= block; round(); round(); v0 ^= block; offset += 8;
    }
    let tail = BigInt(bytes.length) << 56n;
    for (let index = 0; offset + index < bytes.length; index++) tail |= BigInt(bytes[offset + index]) << BigInt(index * 8);
    v3 ^= tail; round(); round(); v0 ^= tail; v2 ^= 0xffn;
    round(); round(); round(); round();
    return (v0 ^ v1 ^ v2 ^ v3).toString(16).padStart(16, '0');
  }
  const publishRevision = () => {
    const value = `${documentToken}:${revision}`;
    if (active && document.documentElement?.getAttribute(fenceAttribute) !== value) document.documentElement?.setAttribute(fenceAttribute, value);
  };
  const compact = (value, max = 120) => String(value || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
  const editable = el => !!el?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"])');
  // Owned references survive reinjection in the isolated content-script world.
  // Page-controlled IDs and attributes cannot establish extension ownership.
  const decorations = window.__wbPageMonitorDecorations ??= new WeakSet();
  const registerDecoration = el => {
    if (el?.nodeType === 1 && el.ownerDocument === document && el !== document.body && el !== document.documentElement) decorations.add(el);
    return el;
  };
  const ignored = el => {
    if (!el || el.nodeType !== 1 || /^(SCRIPT|STYLE|LINK|META|HEAD)$/.test(el.tagName)) return true;
    for (let node = el; node; node = node.parentElement || node.getRootNode?.().host) {
      // Reparenting the page under a real indicator cannot silence the page.
      if (node === document.body || node === document.documentElement) return false;
      if (decorations.has(node)) return true;
    }
    return false;
  };
  const visible = el => {
    if (ignored(el)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || el.getClientRects().length === 0) return false;
    for (let ancestor = el.parentElement || el.getRootNode?.().host; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode?.().host) {
      if (getComputedStyle(ancestor).opacity === '0') return false;
    }
    return true;
  };
  const elementFor = event => event.composedPath?.().find(node => node instanceof Element) || event.target;
  const targetName = el => {
    if (ignored(el)) return '';
    // Never include editable contents, input values, key names or selections.
    return compact(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`
      + (el.getAttribute('role') ? ` [${el.getAttribute('role')}]` : ''));
  };
  const send = event => {
    if (!active || disposed) return;
    publishRevision();
    const feedback = { ...event, runToken, documentToken, seq: ++seq, revision };
    const pending = event.source !== 'agent';
    const intervention = pending && (event.kind !== 'dom' || event.source !== 'page');
    const owner = runToken;
    if (pending) unreported++;
    if (intervention) { interventionRevision++; interventionUnreported++; }
    try {
      const delivery = Promise.resolve(api.runtime.sendMessage({ target: 'background', action: 'page_feedback', feedback }))
        .then(() => { if (owner === runToken) {
          if (pending) unreported = Math.max(0, unreported - 1);
          if (intervention) interventionUnreported = Math.max(0, interventionUnreported - 1);
        } })
        .catch(() => stop());
      if (pending) lastFeedbackDelivery = delivery;
      return delivery;
    } catch { stop(); }
  };
  const currentViewport = () => ({ width: window.innerWidth, height: window.innerHeight,
    visualWidth: window.visualViewport?.width ?? window.innerWidth, visualHeight: window.visualViewport?.height ?? window.innerHeight,
    scale: window.visualViewport?.scale ?? 1, offsetX: window.visualViewport?.offsetLeft ?? 0, offsetY: window.visualViewport?.offsetTop ?? 0 });
  function flushAgentResize(source, expected = agentResize) {
    if (!expected || agentResize !== expected) return Promise.resolve();
    clearTimeout(expected.timer); agentResize = null;
    return Promise.allSettled(expected.events.map(viewport => send({ kind: 'resize', source, target: 'viewport', viewport })));
  }
  function beginAgentResize(params) {
    if (!active || params.runToken !== runToken || typeof params.operationId !== 'string' || !params.operationId) return false;
    if (agentResize) void flushAgentResize('unknown');
    const marker = { runToken, operationId: params.operationId, userAt: lastUserAt, events: [], timer: null };
    marker.timer = setTimeout(() => { void flushAgentResize('unknown', marker); }, 5000);
    agentResize = marker;
    return true;
  }
  async function finishAgentResize(params) {
    const marker = agentResize;
    if (!marker || marker.runToken !== runToken || params.runToken !== runToken || marker.operationId !== params.operationId) {
      return { ready: false };
    }
    const finalViewport = marker.events.at(-1);
    const expected = params.expectedViewport;
    const attributed = marker.userAt === lastUserAt && finalViewport
      && Number.isFinite(expected?.width) && Number.isFinite(expected?.height)
      && finalViewport.width === expected.width && finalViewport.height === expected.height;
    await flushAgentResize(attributed ? 'agent' : 'unknown', marker);
    return { ready: true, attributed: !!attributed };
  }
  const interact = (kind, el, { completeGesture = false, ...extra } = {}) => {
    const isIgnored = ignored(el);
    if (!active || (isIgnored && !completeGesture)) return;
    lastUserAt = Date.now(); lastUserTarget = isIgnored ? null : el; revision++;
    const marker = {}; userTurn = marker;
    setTimeout(() => { if (userTurn === marker) userTurn = null; }, 0);
    send({ kind, source: 'user', target: targetName(el), interacting: pointerHeld || composing, ...extra });
  };
  const resolveTarget = params => {
    let el = params.element instanceof Element ? params.element : params.ref_id ? window.__wb_ax_lookup?.(params.ref_id) : null;
    if (params.nativeTarget) {
      const find = root => {
        const marked = root.querySelector(`[data-webbrain-native-target="${CSS.escape(params.nativeTarget)}"]`);
        if (marked) return marked;
        for (const candidate of root.querySelectorAll('*')) {
          if (candidate.shadowRoot) { const found = find(candidate.shadowRoot); if (found) return found; }
        }
      };
      el = find(document) || el;
      if (el) nativeTargets.add(el);
    }
    try { if (!el && params.selector) el = queryOpenTargets(params.selector).elements[0] || null; } catch {}
    if (!el && Number.isFinite(params.x) && Number.isFinite(params.y)) el = document.elementFromPoint(params.x, params.y);
    if (!el && params.textMatch) {
      const matches = [...document.querySelectorAll('button,a,input,select,[role="button"],[role="link"]')]
        .filter(node => (node.getAttribute('aria-label') || node.textContent || '').trim() === params.textMatch);
      if (matches.length === 1) el = matches[0];
    }
    return el;
  };
  function queryOpenTargets(selector) {
    const elements = [], roots = [document];
    let scanned = 0, rootCount = 0;
    try {
      while (roots.length) {
        const root = roots.pop();
        if (++rootCount > 64) return { elements, complete: false };
        for (const element of root.querySelectorAll(selector)) {
          elements.push(element);
          if (elements.length > 1) return { elements, complete: true };
        }
        const nodes = root.querySelectorAll('*');
        scanned += nodes.length;
        if (scanned > 65536) return { elements, complete: false };
        for (let index = nodes.length - 1; index >= 0; index--) {
          const shadow = nodes[index].shadowRoot;
          if (shadow?.mode === 'open') roots.push(shadow);
        }
      }
      return { elements, complete: true };
    } catch { return { elements: [], complete: false }; }
  }
  function deepElementFromPoint(x, y) {
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; depth < 24 && hit?.shadowRoot?.mode === 'open'; depth++) {
      const next = hit.shadowRoot.elementFromPoint?.(x, y) || hit.shadowRoot.elementsFromPoint?.(x, y)?.[0];
      if (!next || next === hit) break;
      hit = next;
    }
    return hit;
  }
  const kindFor = tool => {
    if (/type|field|key/.test(tool)) return 'input';
    if (/scroll/.test(tool)) return 'scroll';
    if (/click|checked|hover|drag|upload/.test(tool)) return 'click';
    return 'dom';
  };
  const prune = () => {
    for (const [id, op] of operations) if (op.until < Date.now()) operations.delete(id);
  };
  const related = (a, b) => !!a && !!b && (a === b
    || (a !== document.body && a !== document.documentElement && a.contains?.(b)));
  function layoutAgentOperation(op, el, shift) {
    if (!op?.dispatched || Date.now() > Math.max(op.until, op.layoutUntil || 0)
        || !Number.isFinite(op.userAt) || lastUserAt > op.userAt) return false;
    const target = op.target || (op.focused ? op.focusTarget : null);
    if (!target) return false;
    // A layout shift is attributable only when its source is the operation's
    // target, part of that target, or an ancestor that moves the target.
    if (related(target, el) || related(el, target)) return true;
    // Editing a target can move a following sibling. Associate only the
    // matching displacement from a recent, expected input on that target.
    if ((op.layoutCauses || []).some(cause => layoutCauseMatches(cause, el, shift))) return true;
    // Scroll operations may change layout inside their actual scroll box.
    // Ignore document-wide ancestors so an unrelated page shift is not claimed.
    for (const region of op.scrollAncestors || []) {
      if (!region?.isConnected || region === document.body || region === document.documentElement) continue;
      const style = getComputedStyle(region);
      const scrollableX = /^(auto|scroll|overlay)$/.test(style.overflowX) && region.scrollWidth > region.clientWidth + 1;
      const scrollableY = /^(auto|scroll|overlay)$/.test(style.overflowY) && region.scrollHeight > region.clientHeight + 1;
      if ((scrollableX || scrollableY) && related(region, el)) return true;
    }
    return false;
  }
  function layoutAgentUserAt(el, shift) {
    if (!(el instanceof Element)) return undefined;
    if (agentTurn && lastUserAt <= agentTurn.userAt && localOperation?.operationId) {
      const op = operations.get(localOperation.operationId);
      if (layoutAgentOperation(op, el, shift)) return op.userAt;
    }
    for (const op of operations.values()) if (layoutAgentOperation(op, el, shift)) return op.userAt;
    pruneAgentLayoutHistory();
    const cause = agentLayoutHistory.find(entry => lastUserAt <= entry.userAt && layoutCauseMatches(entry, el, shift));
    if (cause) return cause.userAt;
    return undefined;
  }
  function pruneAgentLayoutHistory() {
    const now = Date.now();
    for (let i = agentLayoutHistory.length - 1; i >= 0; i--) if (agentLayoutHistory[i].until < now) agentLayoutHistory.splice(i, 1);
  }
  function layoutCauseMatches(cause, el, shift) {
    if (Date.now() > cause.until || cause.parent !== el.parentElement || !shift?.previousRect || !shift?.currentRect) return false;
    const sourceTopDelta = shift.currentRect.y - shift.previousRect.y;
    return Math.abs(sourceTopDelta) > 2 && Math.sign(sourceTopDelta) === Math.sign(cause.heightDelta)
      && Math.abs(sourceTopDelta) <= Math.abs(cause.heightDelta) + 8;
  }
  function rememberAgentLayout(op) {
    if (!op?.target) return;
    pruneAgentLayoutHistory();
    const before = op.layoutRect || op.targetRectAtDispatch, after = rectFor(op.target);
    if (before && after && Math.abs(after.height - before.height) > 2) {
      const causes = op.layoutCauses ||= [];
      const cause = { parent: op.target.parentElement, heightDelta: after.height - before.height,
        userAt: op.userAt, until: Date.now() + 3000 };
      causes.push(cause);
      agentLayoutHistory.push(cause);
      if (agentLayoutHistory.length > 256) agentLayoutHistory.splice(0, agentLayoutHistory.length - 256);
      if (causes.length > 8) causes.splice(0, causes.length - 8);
    }
    if (after) op.layoutRect = after;
    op.layoutUntil = Date.now() + 3000;
  }
  const rectFor = el => {
    if (!(el instanceof Element) || !el.isConnected) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };
  function coordinatePreparationShifted(op) {
    if (!op?.coordinateSensitive || op.layoutInvalidated || op.dispatched || op.preparedRevision !== revision) return false;
    const target = op.coordinateTarget;
    const currentHit = document.elementFromPoint(op.coordinatePoint.x, op.coordinatePoint.y);
    const previousRect = op.coordinateRect, currentRect = rectFor(target);
    const initialHit = op.coordinateHit;
    const sameHit = initialHit && currentHit && (initialHit === currentHit
      || (initialHit !== document.body && initialHit !== document.documentElement && initialHit.contains?.(currentHit)));
    const hitChanged = !initialHit || !sameHit;
    const rectChanged = op.coordinateTargetAtPoint && (!target?.isConnected || !previousRect || !currentRect
      || ['x', 'y', 'width', 'height'].some(key => Math.abs(previousRect[key] - currentRect[key]) > 2));
    if (!hitChanged && !rectChanged) return false;
    op.layoutInvalidated = true;
    revision++; publishRevision();
    const source = layoutAgentUserAt(target || currentHit) !== undefined ? 'agent' : 'page';
    send({ kind: 'dom', source, target: targetName(target || currentHit) });
    return true;
  }
  function expected(kind, el, event, nativeMarkerOnly = false) {
    let activatedNativeMarker = false;
    const markerNode = event?.composedPath?.().find(node => node instanceof Element && node.hasAttribute(nativeMarkerAttribute))
      || (el?.hasAttribute?.(nativeMarkerAttribute) ? el : null);
    const marker = markerNode?.getAttribute(nativeMarkerAttribute);
    if (marker && event?.isTrusted === true) {
      try {
        const data = JSON.parse(marker);
        const op = operations.get(data.operationId);
        const markerTarget = op && (markerNode === op.target || markerNode === op.focusTarget);
        const nextSequence = Number.isSafeInteger(data.sequence) && data.sequence === (op?.nativeSequence || 0) + 1;
        const allowedEvent = data.kind === 'input'
          ? ['keydown', 'beforeinput', 'input', 'change', 'compositionstart', 'compositionend'].includes(event.type)
          : data.kind === 'click' ? ['pointerover', 'mouseover', 'pointermove', 'pointerdown', 'mousedown', 'click'].includes(event.type) : false;
        const fresh = op && data.revision === op.preparedRevision && op.preparedRevision === revision
          && !domTimer && !unreported && lastUserAt <= op.userAt;
        const signed = op && nativeMarkerSignature(op.nativeSecret, data) === data.signature;
        if (data.documentToken === documentToken && data.runToken === runToken && op && markerTarget && nextSequence
            && fresh && signed && allowedEvent && ['input', 'click'].includes(data.kind)) {
          // The capability is bound to the isolated-world prepared node and consumed once.
          op.nativeSequence = data.sequence;
          markerNode.removeAttribute(nativeMarkerAttribute);
          dispatch({ operationId: data.operationId, kind: data.kind, runToken, navigationCandidate: data.navigationCandidate === true });
          activatedNativeMarker = true;
          const markerTurn = { userAt: op.userAt };
          agentTurn = markerTurn;
          setTimeout(() => { if (agentTurn === markerTurn) agentTurn = null; }, 0);
        }
      } catch { /* Page markers are hints; malformed ones grant no expectation. */ }
    }
    if (nativeMarkerOnly && !activatedNativeMarker) return null;
    if (event && matchedEvents.has(event)) return matchedEvents.get(event);
    prune();
    const match = op => {
      if (event && !event.isTrusted && !op.synchronous) return null;
      if (event) {
        const keyboardClick = kind === 'click' && event.type === 'click' && event.isTrusted === true && op.keyboardClickTarget
          && related(op.keyboardClickTarget, el);
        const submitClick = kind === 'click' && event.detail === 0 && op.submitTarget && related(op.submitTarget, el);
        if (op.eventTypes && !op.eventTypes.has(event.type) && !keyboardClick && !submitClick) return null;
        // One native dispatch owns one occurrence of each input phase. A later
        // human action on the same target must not fit that expectation again.
        if (!op.synchronous && event.type !== 'pointermove' && op.seenEvents?.has(event.type)) return null;
        op.seenEvents?.add(event.type); matchedEvents.set(event, op);
      }
      return op;
    };
    for (const op of operations.values()) {
      // Preparation can focus only the field that was already identified for
      // this input action. A page script moving focus elsewhere stays visible.
      if (kind === 'focus' && op.focusEligible && op.focusTarget === el && lastUserAt <= op.userAt) {
        const found = match(op); if (found) return found;
      }
      if (!op.dispatched) continue;
      if (lastUserAt > op.userAt) continue;
      // Keyboard-activated clicks can report detail=1 in Firefox. Do not let
      // the temporary click expectation absorb a physical pointer sequence.
      if (kind === 'click' && op.keyboardClickTarget && event && event.type !== 'click') continue;
      // Moving agent focus commits the previous field's native change event.
      if (kind === 'input' && event?.type === 'change' && op.blurTarget === el) { const found = match(op); if (found) return found; }
      if (kind === 'scroll' && op.blurTarget === el && editable(el)) { const found = match(op); if (found) return found; }
      if (!op.kinds.has(kind)) continue;
      if (['wheel', 'touchmove'].includes(event?.type) && !op.nativeWheel) continue;
      const target = op.target || (op.focused ? document.activeElement : null);
      if (kind === 'click' && event?.type === 'click' && event?.isTrusted === true
          && ((event.detail === 0 && op.submitTarget && related(op.submitTarget, el))
            || (op.keyboardClickTarget && related(op.keyboardClickTarget, el)))) {
        const found = match(op); if (found) return found;
      }
      if (kind === 'scroll' && op.scrollAncestors?.has(el)) { const found = match(op); if (found) return found; }
      if (kind === 'scroll' && op.windowScroll && (el === document.documentElement || el === document.body)) { const found = match(op); if (found) return found; }
      if (related(target, el)) { const found = match(op); if (found) return found; }
      if (event && Number.isFinite(op.x) && Number.isFinite(op.y)
          && Math.abs(event.clientX - op.x) <= 2 && Math.abs(event.clientY - op.y) <= 2) { const found = match(op); if (found) return found; }
    }
    return null;
  }
  function textSignature(node) {
    const text = node.textContent || '', cached = textSignatures.get(node);
    if (cached?.text === text) return cached.signature;
    // Keep the fingerprint fixed-size while covering the entire text, including
    // equal-length middle/suffix edits. Unchanged nodes avoid rehashing on layout reads.
    let hash = 0, power = 1;
    for (let i = 0; i < text.length; i++) {
      hash = (Math.imul(hash, 16777619) + text.charCodeAt(i)) >>> 0;
      power = Math.imul(power, 16777619) >>> 0;
    }
    const value = [text.length, hash, power];
    textSignatures.set(node, { text, signature: value });
    return value;
  }
  function deepActiveElement() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  function controlValueFingerprint(el) {
    let controlValue = null;
    if ((el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT'
        && !['password', 'file', 'hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(el.type)))) {
      const value = el.value || '', samples = Math.min(value.length, 8192);
      let first = 0x811c9dc5, second = 0x9e3779b9;
      // Hash locally only; feedback contains a generic target and never the value or typed keys.
      for (let index = 0; index < samples; index++) {
        const code = value.charCodeAt(samples === value.length ? index : Math.floor(index * value.length / samples));
        first = Math.imul(first ^ code, 16777619) >>> 0;
        second = Math.imul(second ^ (code + index), 2246822519) >>> 0;
      }
      controlValue = [value.length, first, second];
    }
    return controlValue;
  }
  function controlState(el) {
    return JSON.stringify([el.getAttribute('value'), el.selected === true, el.defaultSelected === true,
      Number.isInteger(el.selectedIndex) ? el.selectedIndex : null, el.checked === true,
      el.disabled === true, el.readOnly === true, el.required === true, el.validity?.valid !== false,
      controlValueFingerprint(el)]);
  }
  function trackControl(el) {
    if (!/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) || controlSignatures.has(el)) return;
    controlReferences.add(new WeakRef(el));
    controlSignatures.set(el, controlState(el));
  }
  function refreshControl(el) {
    if (/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)) {
      trackControl(el);
      controlSignatures.set(el, controlState(el));
    }
    if (el.tagName === 'SELECT') {
      for (const option of el.options || []) {
        trackControl(option);
        controlSignatures.set(option, controlState(option));
        signatures.set(option, signature(option));
      }
    }
    signatures.set(el, signature(el));
  }
  function signature(el) {
    if (ignored(el)) return '';
    trackControl(el);
    const shown = visible(el);
    const rect = shown ? el.getBoundingClientRect() : {};
    const content = editable(el) ? '' : [...el.childNodes, ...(el.shadowRoot?.childNodes || [])].filter(node => node.nodeType === 3)
      .map(textSignature).reduce(([size, hash], [length, part, power]) =>
        [size + length, (Math.imul(hash, power) + part) >>> 0], [0, 0]);
    const controlValue = controlValueFingerprint(el);
    return JSON.stringify([shown, content, el.children.length + (el.shadowRoot?.children.length || 0), el.getAttribute('role'), el.getAttribute('aria-modal'), el.getAttribute('aria-label'),
      el.getAttribute('id'), el.getAttribute('for'), el.getAttribute('form'), el.getAttribute('name'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'),
      el.getAttribute('aria-labelledby'), el.getAttribute('aria-required'), el.getAttribute('aria-readonly'),
      el.getAttribute('contenteditable'), el.getAttribute('tabindex'), el.getAttribute('onclick'), el.getAttribute('required'),
      el.getAttribute('aria-expanded'), el.getAttribute('aria-selected'), el.getAttribute('aria-checked'), el.getAttribute('data-selected'),
      el.getAttribute('aria-valuenow'), el.getAttribute('aria-valuetext'),
      el.getAttribute('aria-pressed'),
      el.getAttribute('type'),
      el.getAttribute('href'), el.getAttribute('target'), el.getAttribute('download'), el.getAttribute('action'), el.getAttribute('method'),
      el.getAttribute('formaction'), el.getAttribute('formmethod'), el.getAttribute('formtarget'),
      el.hasAttribute('novalidate'), el.hasAttribute('formnovalidate'),
      el.getAttribute('popover'), popoverOpen(el),
      el.selected === true, el.defaultSelected === true,
      Number.isInteger(el.selectedIndex) ? el.selectedIndex : null,
      el.getAttribute('aria-hidden'), el.hasAttribute('open'), el.inert === true,
      el.getAttribute('aria-disabled'), el.getAttribute('value'), controlValue, el.disabled === true, el.readOnly === true, el.checked === true, el.validity?.valid !== false, Math.round((rect.width || 0) / 8), Math.round((rect.height || 0) / 8),
      Math.round(((rect.x || 0) + window.scrollX) / 8), Math.round(((rect.y || 0) + window.scrollY) / 8)]);
  }
  const passiveRebaseTools = new Set(['click', 'click_ax', 'type', 'type_ax', 'type_text', 'set_field', 'set_checked',
    'press_keys', 'hover', 'upload_file', 'iframe_click', 'iframe_type', 'input', 'focus']);
  const bindingParent = node => node?.parentElement || node?.getRootNode?.().host || null;
  function labelBinding(el) {
    const labels = new Set(el.labels || []);
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      for (const id of (el.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
        const node = el.getRootNode?.().getElementById?.(id) || document.getElementById(id);
        if (!node) return null;
        labels.add(node);
      }
    }
    return [...labels].map(node => ({ node, value: JSON.stringify([signature(node), node.textContent]) }));
  }
  function preparedBinding(target) {
    if (!(target instanceof Element) || !target.isConnected || target.ownerDocument !== document) return null;
    const nodes = [], ancestors = [];
    let scope = target.form || target.closest('form,dialog,[role="dialog"],[role="alertdialog"],[role="region"],[role="group"],article,[role="article"],[role="listitem"]');
    if (!scope) {
      // Include the composer containing both field and action when no semantic
      // form/dialog exists. A page-wide ancestor would also bind unrelated feeds.
      let parent = bindingParent(target);
      scope = parent && parent !== document.body && parent !== document.documentElement ? parent : target;
      for (let depth = 0; parent && depth < 4 && parent !== document.body && parent !== document.documentElement; depth++, parent = bindingParent(parent)) {
        if (parent.querySelector('input,textarea,[contenteditable]:not([contenteditable="false"])')) { scope = parent; break; }
      }
    }
    for (let ancestor = bindingParent(target); ancestor; ancestor = bindingParent(ancestor)) {
      if (ancestors.length >= 24) return null;
      const labels = labelBinding(ancestor);
      if (!labels) return null;
      ancestors.push({ node: ancestor, value: JSON.stringify([signature(ancestor), labels.map(label => label.value)]) });
      nodes.push(...labels);
    }
    // Recipient/conversation headings can sit outside a composer form. Bind
    // their identity and text without binding every counter in a live feed.
    const headings = document.querySelectorAll('h1,h2,h3,[role="heading"],[aria-current]');
    if (headings.length > 64) return null;
    for (const node of headings) nodes.push({ node, value: JSON.stringify([signature(node), node.textContent]) });
    if (target.form) for (const node of target.form.elements) {
      if (nodes.length >= 256) return null;
      if (node.tagName === 'INPUT' && node.type === 'file' && node.files?.length > 32) return null;
      nodes.push({ node, value: JSON.stringify([signature(node), controlState(node), node.value]),
        ...(node.tagName === 'INPUT' && node.type === 'file' ? { files: [...node.files || []] } : {}) });
    }
    const stack = [scope];
    while (stack.length) {
      const node = stack.pop();
      if (nodes.length >= 256) return null;
      if (node.nodeType === 1) {
        if (ignored(node)) continue;
        const labels = labelBinding(node);
        if (!labels) return null;
        if (node.tagName === 'INPUT' && node.type === 'file' && node.files?.length > 32) return null;
        // Exact values remain private in the isolated monitor and never enter
        // feedback/guards. Sampling could miss a middle edit in a long value.
        nodes.push({ node, value: JSON.stringify([signature(node), controlState(node),
          /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(node.tagName) ? node.value : null,
          node.getAttribute('aria-describedby'), labels.map(label => label.value)]),
          ...(node.tagName === 'INPUT' && node.type === 'file' ? { files: [...node.files || []] } : {}) }, ...labels);
        const children = node.childNodes, shadowChildren = node.shadowRoot?.childNodes || [];
        if (children.length + shadowChildren.length + stack.length + nodes.length > 256) return null;
        for (let index = shadowChildren.length - 1; index >= 0; index--) stack.push(shadowChildren[index]);
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      } else if (node.nodeType === 3) nodes.push({ node, value: node.data });
    }
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { target, scope, ancestors, nodes, hit, context: JSON.stringify([location.href, document.baseURI,
      currentViewport(), window.scrollX, window.scrollY]) };
  }
  function samePreparedBinding(before, after) {
    if (!before || !after || before.target !== after.target || before.scope !== after.scope || before.hit !== after.hit || before.context !== after.context) return false;
    return ['ancestors', 'nodes'].every(key => before[key].length === after[key].length
      && before[key].every((item, index) => item.node === after[key][index].node && item.value === after[key][index].value
        && (!item.files || (item.files.length === after[key][index].files?.length
          && item.files.every((file, fileIndex) => file === after[key][index].files[fileIndex])))));
  }
  // Model snapshots bind an action's meaning, not unrelated text/counts in
  // its surrounding page. These exact values stay private in this realm.
  const modelControlSelector = 'button,a[href],input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),'
    + '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],'
    + '[role="combobox"],[role="listbox"],[role="option"],[role="slider"],[role="spinbutton"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';
  const entityOwnerSelector = 'dialog,[role="dialog"],[role="alertdialog"],[role="region"],article,[role="article"],[role="listitem"]';
  const modelEntityIdentityAttributes = ['data-recipient', 'data-conversation', 'data-thread', 'data-chat', 'data-channel',
    'data-resource', 'data-entity', 'data-record', 'data-post', 'data-item', 'data-message', 'data-user', 'data-account'];
  const modelEntityIdentitySelector = modelEntityIdentityAttributes.flatMap(attribute => [attribute,
    `${attribute}-id`, `${attribute}-key`, `${attribute}-name`]).map(attribute => `[${attribute}]`).join(',');
  const modelActionTools = new Set([...passiveRebaseTools].filter(tool => !tool.startsWith('iframe_')));
  const modelFocusTools = new Set(['type_text', 'press_keys', 'input', 'focus']);
  const semanticAttributes = ['id', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-modal', 'aria-current',
    'aria-required', 'aria-readonly', 'aria-disabled', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed',
    'aria-valuenow', 'aria-valuetext', 'aria-hidden', 'contenteditable', 'tabindex', 'name', 'placeholder', 'title', 'alt',
    'for', 'form', 'type', 'href', 'target', 'download', 'action', 'method', 'enctype', 'accept', 'multiple',
    'formaction', 'formmethod', 'formenctype', 'formtarget', 'novalidate', 'formnovalidate', 'required', 'readonly',
    'disabled', 'open', 'inert', 'popover', 'onclick', 'data-selected'];
  function modelSemantic(el, { text = false, directText = false, control = false, observedName = false, structuralFile = false } = {}) {
    const style = getComputedStyle(el);
    let accessibleName = null;
    if (text) {
      // The selected target retains the name the model actually observed.
      // Other form controls use authored labels below: the AX formatter's
      // inferred preceding-sibling label may be an unrelated live counter.
      if (observedName && typeof window.__wb_ax_name === 'function') accessibleName = window.__wb_ax_name(el);
      else accessibleName = [el.getAttribute('aria-label'), el.getAttribute('alt'), el.getAttribute('title'),
        [...el.querySelectorAll('img,svg title,[aria-label]')].map(node => [node.getAttribute('alt'), node.getAttribute('aria-label'), node.textContent])];
    }
    return JSON.stringify([el.tagName, semanticAttributes.map(name => el.getAttribute(name)),
      [...el.attributes].filter(attribute => /^data-(?:(?:recipient|conversation|thread|chat|channel|resource|entity|record|post|item|message|user|account)(?:-(?:id|key|name|type))?|id|key|uuid|target|action|command|operation|selected|active|current|state|status|testid)$/.test(attribute.name))
        .map(attribute => [attribute.name, attribute.value]).sort(([left], [right]) => left.localeCompare(right)),
      structuralFile ? null : style.display, structuralFile ? null : style.visibility,
      structuralFile ? null : style.opacity, structuralFile ? null : style.contentVisibility, el.inert === true, popoverOpen(el),
      text ? el.textContent : directText ? [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.data) : null,
      accessibleName, control ? controlState(el) : null,
      control && /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) ? el.value : null,
      control && el.isContentEditable ? el.innerHTML : null]);
  }
  function modelLabels(el) {
    const labels = new Set(el.labels || []);
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      for (const id of (el.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
        const root = el.getRootNode();
        const matches = root.querySelectorAll?.(`[id="${CSS.escape(id)}"]`);
        if (matches?.length !== 1) return null;
        labels.add(matches[0]);
      }
    }
    return [...labels].map(node => ({ node, value: modelSemantic(node, { text: true }) }));
  }
  function actionFootprint(target) {
    const structuralFile = target instanceof Element && target.tagName === 'INPUT' && target.type === 'file';
    if (!(target instanceof Element) || target.ownerDocument !== document || !target.isConnected
        || (!structuralFile && !visible(target)) || ignored(target)) return null;
    for (let node = target; node; node = bindingParent(node)) {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot && root.mode !== 'open') return null;
    }
    const action = target.matches(modelControlSelector) ? target : target.closest(modelControlSelector);
    if (!action || (!structuralFile && !visible(action))) return null;
    const form = action.form || target.closest('form,[role="form"]');
    const ownerBase = form || action;
    let owner = ownerBase.matches(entityOwnerSelector) ? ownerBase : ownerBase.closest(entityOwnerSelector);
    let unstructuredOwner = false;
    let meaningfulOwner = false;
    if (!owner && form && [...form.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],'+modelEntityIdentitySelector)]
      .some(node => node.closest('form,[role="form"]') === form && !node.closest(entityOwnerSelector)
        && !node.closest('aside,nav,[role="navigation"],[role="complementary"]'))) owner = form;
    if (!owner) {
      // A tiny toolbar is not a composer owner. Find the bounded container
      // that includes its editor and action, with a heading outside the form
      // when one is present. Otherwise retain the conservative heading fence.
      let parent = bindingParent(ownerBase), fallback = null;
      for (let depth = 0; parent && depth < 6 && parent !== document.body && parent !== document.documentElement;
        depth++, parent = bindingParent(parent)) {
        if (parent.querySelectorAll('*').length > 256 || parent.querySelectorAll(modelControlSelector).length > 64) break;
        const editor = parent.querySelector('input:not([type="file"]):not([type="hidden"]),textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
        if (!form && !editor) continue;
        if (form && parent.querySelectorAll('form,[role="form"]').length > 1) break;
        fallback ||= parent;
        const outsideHeading = [...parent.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
          .some(node => !node.closest('form,[role="form"]') && !node.closest('aside,nav,[role="navigation"],[role="complementary"]'));
        if (outsideHeading) { owner = parent; unstructuredOwner = true; meaningfulOwner = true; break; }
      }
      if (!owner) { owner = fallback; unstructuredOwner = true; }
    }
    const nodes = [], ancestors = [];
    const addNode = (node, options = {}) => {
      if (nodes.some(item => item.node === node)) return true;
      if (nodes.length >= 256 || (node.tagName === 'INPUT' && node.type === 'file' && node.files?.length > 32)) return false;
      const labels = modelLabels(node);
      if (!labels) return false;
      nodes.push({ node, value: modelSemantic(node, options),
        ...(node.tagName === 'INPUT' && node.type === 'file' ? { files: [...node.files || []] } : {}) });
      for (const label of labels) {
        if (nodes.length >= 256) return false;
        if (!nodes.some(item => item.node === label.node)) nodes.push(label);
      }
      return true;
    };
    if (!addNode(target, { text: true, control: true, observedName: !structuralFile, structuralFile })
        || !addNode(action, { text: true, control: true, observedName: !structuralFile, structuralFile })) return null;
    for (let ancestor = bindingParent(target); ancestor; ancestor = bindingParent(ancestor)) {
      if (ancestors.length >= 24) return null;
      const labels = modelLabels(ancestor);
      if (!labels) return null;
      const style = getComputedStyle(ancestor);
      if (ancestor.inert || ancestor.getAttribute('aria-hidden') === 'true' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return null;
      ancestors.push({ node: ancestor, value: modelSemantic(ancestor) });
      for (const label of labels) if (!addNode(label.node, { text: true })) return null;
    }
    if (form) {
      if (!addNode(form)) return null;
      const controls = form.elements ? [...form.elements] : [...form.querySelectorAll(modelControlSelector)];
      for (const control of controls) if (!addNode(control, { text: true, control: true })) return null;
    }
    if (owner) {
      if (!addNode(owner, { directText: true })) return null;
      const belongs = node => {
        const closest = node.closest(entityOwnerSelector);
        const relatedForm = node.closest('form,[role="form"]');
        return (!closest || closest === owner || closest.contains(owner))
          && (!relatedForm || relatedForm === form)
          && !node.closest('aside,nav,[role="navigation"],[role="complementary"]');
      };
      const headings = [...owner.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],[aria-current]')]
        .filter(belongs);
      if (headings.length > 32) return null;
      for (const heading of headings) if (!addNode(heading, { text: true })) return null;
      const identities = [...owner.querySelectorAll(modelEntityIdentitySelector)].filter(belongs);
      if (identities.length > 64) return null;
      for (const identity of identities) if (!addNode(identity, { text: true, control: true })) return null;
      meaningfulOwner ||= headings.length > 0 || identities.length > 0 || owner.matches(modelEntityIdentitySelector);
      // Recipients and attachment/caption editors may live next to the form.
      // Bind every local control, excluding a separate entity, form or sidebar.
      for (const control of owner.querySelectorAll(modelControlSelector)) {
        if (belongs(control) && !addNode(control, { text: true, control: true })) return null;
      }
    }
    // An arbitrary container/toolbar with no entity anchor cannot establish
    // the recipient or item. Such targets retain strict legacy dispatch only.
    if (!owner || !meaningfulOwner) return null;
    if (!owner || unstructuredOwner) {
      // Without an explicit entity boundary, an outside conversation heading
      // may identify the recipient. Never infer that a small form/toolbar owns
      // it; broad heading binding is a conservative fallback for these pages.
      const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],[aria-current]');
      if (headings.length > 64) return null;
      for (const heading of headings) if (!addNode(heading, { text: true })) return null;
    }
    const rect = structuralFile ? null : target.getBoundingClientRect();
    const hit = structuralFile ? null : deepElementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!structuralFile && (!hit || !(target === hit || target.contains(hit) || (action.contains(target) && action.contains(hit))))) return null;
    return { model: true, structuralFile, target, scope: owner || form || action, ancestors, nodes, hit,
      context: JSON.stringify([location.href, document.baseURI, currentViewport(), window.scrollX, window.scrollY,
        rect ? [rect.left, rect.top, rect.width, rect.height] : null]) };
  }
  function operationBinding(op, target = op?.preparedBinding?.target) {
    return op?.preparedBinding?.model === true ? actionFootprint(target) : preparedBinding(target);
  }
  function inputContinuationValue(item, target) {
    if (item.node !== target) return item.value;
    const value = JSON.parse(item.value);
    if (value[11]) {
      const state = JSON.parse(value[11]);
      // Native input can change the selected value and validity of its own
      // field. Names, default values, disabled/read-only state and recipients
      // remain part of the immutable context.
      for (const index of [1, 3, 4, 8, 9]) state[index] = null;
      value[11] = JSON.stringify(state);
    }
    value[12] = null;
    if (target.isContentEditable) { value[9] = null; value[13] = null; }
    return JSON.stringify(value);
  }
  function inputContinuationBindingMatches(op, after) {
    const before = op?.preparedBinding;
    if (!op?.dispatched || op.kind !== 'input' || before?.model !== true || !after
        || before.target !== after.target || before.scope !== after.scope || before.hit !== after.hit || before.context !== after.context) return false;
    return ['ancestors', 'nodes'].every(key => before[key].length === after[key].length
      && before[key].every((item, index) => {
        const current = after[key][index];
        return item.node === current.node
          && (key === 'nodes' ? inputContinuationValue(item, before.target) === inputContinuationValue(current, before.target) : item.value === current.value)
          && (!item.files || (item.files.length === current.files?.length && item.files.every((file, fileIndex) => file === current.files[fileIndex])));
      }));
  }
  function operationBindingMatches(op, target = op?.preparedBinding?.target) {
    const current = operationBinding(op, target);
    return samePreparedBinding(op?.preparedBinding, current) || inputContinuationBindingMatches(op, current);
  }
  function modelTarget(params = {}) {
    if (!modelActionTools.has(params.tool) || Number.isFinite(params.x) || Number.isFinite(params.y)
        || (params.frameId != null && Number(params.frameId) !== 0)) return null;
    const focused = !params.ref_id && !params.selector && !params.nativeTarget && !params.textMatch
      && modelFocusTools.has(params.tool);
    const resolved = focused ? deepActiveElement()
      : resolveTarget({ ...params, textMatch: params.textMatch || (params.tool === 'click' ? params.text : undefined) });
    if (!(resolved instanceof Element)) return null;
    if (params.selector) {
      try { const query = queryOpenTargets(params.selector); if (!query.complete || query.elements.length !== 1 || query.elements[0] !== resolved) return null; }
      catch { return null; }
    }
    if (!focused && !params.ref_id && !params.selector && !params.nativeTarget && !params.textMatch
        && !(params.tool === 'click' && params.text)) return null;
    return resolved;
  }
  function modelCandidateIdentity(target) {
    // The uncertified fallback preserves original node identity without
    // retaining arbitrarily large page subtrees during the bounded scan.
    const value = /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(target.tagName) ? target.value : null;
    if (target.attributes.length > 64 || sampleDescendants(target, 64).exceeded
        || target.textContent.length > 8192 || String(value || '').length > 8192
        || [...target.attributes].some(attribute => attribute.value.length > 8192)) return null;
    const identity = JSON.stringify([target.tagName, [...target.attributes].map(attribute => [attribute.name, attribute.value])
      .sort(([left], [right]) => left.localeCompare(right)), target.textContent,
      value]);
    return { value: identity, parent: bindingParent(target), form: target.form || target.closest('form,[role="form"]') };
  }
  function modelBindingResult(params = {}) {
    const snapshot = modelSnapshots.get(params.snapshotToken || params.expectedModelSnapshot);
    if (!active || !snapshot || snapshot.until < Date.now() || snapshot.runToken !== runToken
        || params.runToken !== runToken || snapshot.interventionRevision !== interventionRevision
        || snapshot.userAt !== lastUserAt || interventionUnreported || (pendingDOM && pendingDOM.source !== 'page')) return {};
    const target = modelTarget(params);
    if (!target) return params.ref_id && snapshot.refs.has(params.ref_id) ? {} : { reason: 'target_unresolved' };
    const before = snapshot.targets.get(target), previous = snapshot.uncertified.get(target);
    if (!before && !previous) return { reason: 'target_uncovered' };
    if (params.ref_id && snapshot.hasRefs && snapshot.refs.get(params.ref_id) !== target) return {};
    if (!params.ref_id && !params.selector && !params.nativeTarget && !params.textMatch && modelFocusTools.has(params.tool)
        && snapshot.focusTarget !== target) return {};
    if (before) return samePreparedBinding(before, actionFootprint(target)) ? { binding: before } : {};
    const current = modelCandidateIdentity(target);
    return current && previous.value === current.value && previous.parent === current.parent && previous.form === current.form
      ? { uncertified: true } : {};
  }
  function modelBinding(params = {}) {
    return modelBindingResult(params).binding || null;
  }
  function captureModel(params = {}) {
    if (!active || params.runToken !== runToken) return { ready: false, runToken, documentToken };
    flushPendingMutations(); sampleFormControls();
    const priorityTarget = params.actionTarget && typeof params.actionTarget === 'object'
      ? modelTarget(params.actionTarget) : null;
    let page;
    if (params.includeTree === true) {
      try {
        if (typeof window.__generateAccessibilityTree !== 'function') throw new Error('unavailable');
        const boundedTreeText = (content, limit) => {
          if (content.length <= limit) return content;
          // Preserve complete AX lines so an omitted long attribute cannot
          // make an unseen node appear covered by a partly printed ref.
          const suffix = '\n[observation truncated]';
          const end = content.lastIndexOf('\n', limit - suffix.length);
          return (end >= 0 ? content.slice(0, end) : '') + suffix;
        };
        // Reserve space for the requested owner's current identity evidence.
        // AX omits some visible generic wrappers (for example recipient chips).
        const tree = window.__generateAccessibilityTree('visible', 15, priorityTarget ? 5000 : 6000);
        if (!tree || tree.error || typeof tree.pageContent !== 'string') throw new Error('unavailable');
        page = { success: true, ...tree, pageContent: boundedTreeText(tree.pageContent, priorityTarget ? 5000 : 6000), url: location.href };
        if (priorityTarget) {
          const scope = actionFootprint(priorityTarget)?.scope || priorityTarget.closest(entityOwnerSelector) || priorityTarget;
          const scopeRef = window.__wb_ax_ref?.(scope);
          if (!scopeRef) throw new Error('unavailable');
          const scoped = window.__generateAccessibilityTree('visible', 15, scope === priorityTarget ? 4000 : 3000, scopeRef);
          if (!scoped || scoped.error || typeof scoped.pageContent !== 'string') throw new Error('unavailable');
          page.pageContent += '\n\n[CURRENT REQUESTED ACTION CONTEXT]\n' + boundedTreeText(scoped.pageContent, scope === priorityTarget ? 4000 : 3000);
          if (scope !== priorityTarget) {
            const targetRef = window.__wb_ax_ref?.(priorityTarget);
            if (!targetRef) throw new Error('unavailable');
            const targetTree = window.__generateAccessibilityTree('visible', 15, 1000, targetRef);
            // Hidden file controls can have a structural certificate while
            // their visible owner is the only AX observation available.
            if (!targetTree?.error && typeof targetTree?.pageContent === 'string')
              page.pageContent += '\n[CURRENT EXACT ACTION TARGET]\n' + boundedTreeText(targetTree.pageContent, 1000);
          }
        }
        // The Agent sends this complete object through its 16k serializer.
        // Fit it before interpreting printed refs, never after certification.
        while (JSON.stringify(page).length > 16000 && page.pageContent.includes('\n')) {
          page.pageContent = page.pageContent.slice(0, page.pageContent.lastIndexOf('\n'));
        }
        if (JSON.stringify(page).length > 16000) throw new Error('observation too large');
      } catch { return { ready: false, runToken, documentToken, reason: 'observation_unavailable' }; }
    }
    const targets = new Map(), uncertified = new WeakMap(), refs = new Map(), seen = new Set(), publicNodes = new Set();
    if (page) for (const match of page.pageContent.matchAll(/\[(ref_[A-Za-z0-9_-]+)\]/g)) {
      const ref = match[1], node = window.__wb_ax_lookup?.(ref);
      if (node instanceof Element) { refs.set(ref, node); publicNodes.add(node); }
    }
    let evidenceLength = 0;
    const exposeIdentity = node => {
      if (publicNodes.has(node)) return true;
      // Emit only current rendered page labels. Editable contents, input
      // values, data identities and private control/file state stay private.
      if (!visible(node) || node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
          || node.closest('[aria-hidden="true"]')) return false;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const parts = [];
      let visited = 0, textNode;
      while ((textNode = walker.nextNode())) {
        if (visited++ >= 128) return false;
        const parent = textNode.parentElement;
        if (parent && visible(parent) && !ignored(parent) && !parent.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[aria-hidden="true"]')) {
          const part = textNode.data.replace(/\s+/g, ' ').trim();
          if (part) parts.push(part);
          if (parts.join(' ').length > 512) return false;
        }
      }
      const rendered = parts.join(' ');
      const authored = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('alt') || '')
        .replace(/\s+/g, ' ').trim();
      const name = authored || rendered;
      if (!name || authored.length > 512) return false;
      const ref = window.__wb_ax_ref?.(node);
      if (!ref || window.__wb_ax_lookup?.(ref) !== node) return false;
      const header = evidenceLength ? '' : '\n\n[CURRENT VISIBLE ACTION IDENTITY]\n';
      const line = header + `visible identity ${JSON.stringify(name)} [${ref}]`
        + (authored && rendered && authored !== rendered ? ` text=${JSON.stringify(rendered)}` : '') + '\n';
      if (evidenceLength + line.length > MODEL_EVIDENCE_MAX || page.pageContent.length + line.length > MODEL_PUBLIC_MAX
          || JSON.stringify({ ...page, pageContent: page.pageContent + line }).length > 16000) return false;
      page.pageContent += line;
      evidenceLength += line.length;
      refs.set(ref, node); publicNodes.add(node);
      return true;
    };
    const observedFootprint = footprint => {
      if (!page) return true;
      if (!footprint.structuralFile && !publicNodes.has(footprint.target)) return false;
      const evidence = footprint.nodes.filter(item => item.node !== footprint.target
        && item.node.matches('h1,h2,h3,h4,h5,h6,[role="heading"],[aria-current],'+modelEntityIdentitySelector)
        && visible(item.node));
      return evidence.every(item => exposeIdentity(item.node))
        && (publicNodes.has(footprint.scope) || evidence.some(item => publicNodes.has(item.node)));
    };
    const captureTarget = node => {
      if (!(node instanceof Element) || ignored(node) || seen.has(node) || seen.size >= MODEL_SCAN_LIMIT) return;
      seen.add(node);
      const footprint = targets.size < MODEL_TARGET_LIMIT ? actionFootprint(node) : null;
      if (footprint && !observedFootprint(footprint)) return;
      if (!footprint && page && !publicNodes.has(node)) return;
      if (footprint) targets.set(node, footprint);
      else {
        const identity = modelCandidateIdentity(node);
        if (identity) uncertified.set(node, identity);
      }
    };
    // Recovery observes this target's current semantic owner in the same task
    // and seeds its original identity before a large page consumes the budget.
    // The rejected previous model call never receives this fresh certificate.
    if (priorityTarget) captureTarget(priorityTarget);
    // The model-visible AX targets are captured before the general DOM scan,
    // so a deep page's earlier decorative nodes do not consume their budget.
    if (page) for (const node of publicNodes) captureTarget(node);
    else if (window.__wbElementMap) for (const ref of Object.keys(window.__wbElementMap).slice(0, MODEL_SCAN_LIMIT)) {
      const node = window.__wb_ax_lookup?.(ref);
      if (node instanceof Element) { refs.set(ref, node); captureTarget(node); }
    }
    const stack = [document.documentElement];
    let scanned = 0;
    while (stack.length && scanned++ < MODEL_SCAN_LIMIT && seen.size < MODEL_SCAN_LIMIT) {
      const node = stack.pop();
      if (!(node instanceof Element) || ignored(node)) continue;
      captureTarget(node);
      const children = [...node.children, ...(node.shadowRoot?.children || [])];
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
    const snapshotToken = randomToken();
    const focusTarget = deepActiveElement();
    const focusedTargetAvailable = targets.has(focusTarget);
    // Metadata-only tests/integration use an existing AX lookup without a new
    // tree. Record those refs lazily only when they resolve to an original node.
    modelSnapshots.set(snapshotToken, { runToken, until: Date.now() + MODEL_SNAPSHOT_MS, targets, uncertified, refs,
      hasRefs: !!page || !!window.__wbElementMap, focusTarget, userAt: lastUserAt, interventionRevision });
    for (const [key, snapshot] of modelSnapshots) if (snapshot.until < Date.now()) modelSnapshots.delete(key);
    while (modelSnapshots.size > 2) modelSnapshots.delete(modelSnapshots.keys().next().value);
    return { ready: true, runToken, documentToken, snapshotToken, targetCount: targets.size, focusedTargetAvailable,
      ...(page ? { page } : {}) };
  }
  function preparedBindingChanged(op, { allowFocusRebind = false } = {}) {
    if (op?.allowPassiveRebase === true && op.preparedBinding?.model === true && op.focusBound
        && !allowFocusRebind && deepActiveElement() !== op.focusTarget) return true;
    return op?.allowPassiveRebase === true && !!op.preparedBinding
      && (!op.dispatched || (op.preparedBinding.model === true && op.kind === 'input'))
      && !operationBindingMatches(op);
  }
  function rebasePassivePreparation(op, params = {}) {
    const continuingInput = op?.dispatched && op.kind === 'input' && op.preparedBinding?.model === true;
    if (!active || !op || op.allowPassiveRebase !== true || (op.dispatched && !continuingInput) || op.coordinateSensitive || op.layoutInvalidated
        || op.until < Date.now() || lastUserAt > op.userAt || interventionUnreported
        || op.preparedInterventionRevision !== interventionRevision
        || (pendingDOM && pendingDOM.source !== 'page')
        || (params.documentToken && params.documentToken !== documentToken)) return false;
    const independentNavigation = op.tool === 'navigate';
    if (independentNavigation) {
      if (op.preparedPageContext !== JSON.stringify([location.href, document.baseURI, currentViewport(), window.scrollX, window.scrollY])) return false;
    } else {
      if (op.selector) {
        try { const query = queryOpenTargets(op.selector); if (!query.complete || query.elements.length !== 1) return false; } catch { return false; }
      }
      if (!passiveRebaseTools.has(op.modelBindingTool || op.tool) || !op.preparedBinding
          || (params.element && params.element !== op.preparedBinding.target)
          || (!op.tabFocusRebound && !(params.rebindFocus === true && op.tabFocusRebindAllowed)
            && (resolveTarget(op) || (op.focusEligible ? deepActiveElement() : null)) !== op.preparedBinding.target)
          || (continuingInput && !(params.rebindFocus === true && op.tabFocusRebindAllowed) && deepActiveElement() !== op.focusTarget)
          || !operationBindingMatches(op)) return false;
    }
    // Do not suppress feedback. Flush it for the agent while rebasing only this
    // exact, freshly revalidated operation over unrelated passive mutations.
    if (domTimer) {
      clearTimeout(domTimer); domTimer = null;
      const observation = pendingDOM; pendingDOM = null;
      if (observation) send(observation);
    }
    op.preparedRevision = revision;
    return true;
  }
  function seed(root, budget = { remaining: 600 }) {
    const nodes = root.querySelectorAll?.('*') || [];
    for (const el of nodes) {
      // Keep a baseline for every control; periodic reads rotate through them in bounded batches.
      trackControl(el);
      if (budget.remaining > 0) { budget.remaining--; signatures.set(el, signature(el)); }
      // Root discovery is cheap and must not share the layout-measurement cap.
      if (el.shadowRoot && !ignored(el)) observeRoot(el.shadowRoot, budget);
    }
  }
  function sampleFormControls(...targets) {
    const extraTargets = targets.flat().filter(el => el instanceof Element);
    if (!active || (!controlReferences.size && !extraTargets.length)) return;
    const sampled = new Set();
    const records = [];
    let inspected = 0;
    while (inspected < 200) {
      controlIterator ||= controlReferences.values();
      const next = controlIterator.next();
      if (next.done) { controlIterator = null; break; }
      inspected++;
      const reference = next.value;
      const el = reference.deref();
      if (!el || !el.isConnected) { controlReferences.delete(reference); continue; }
      sampled.add(el);
      if (!ignored(el)) records.push({ type: 'control', target: el });
    }
    for (const el of extraTargets) {
      if (sampled.has(el) || !el.isConnected || !/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName) || ignored(el)) continue;
      sampled.add(el);
      const previous = controlSignatures.get(el)
        ?? [...operations.values()].find(op => op.target === el && op.controlStateAtPrepare !== undefined)?.controlStateAtPrepare;
      if (previous !== undefined && controlState(el) !== previous) records.push({ type: 'control', target: el });
    }
    if (records.length) onMutations(records);
  }
  function samplePreparedTargets(onlyOperation) {
    if (!active) return;
    const now = Date.now();
    const candidates = onlyOperation ? [onlyOperation] : [...operations.values()]
      .filter(op => !op.dispatched && op.target && op.preparedTargetSignature !== undefined && op.until >= now);
    if (!onlyOperation && candidates.length > 128) {
      const start = preparedOperationCursor % candidates.length;
      const batch = Array.from({ length: 128 }, (_, index) => candidates[(start + index) % candidates.length]);
      preparedOperationCursor = (start + batch.length) % candidates.length;
      candidates.splice(0, candidates.length, ...batch);
    }
    const changedTargets = new Set();
    for (const op of candidates) {
      if (!op || op.dispatched || !op.target || op.preparedTargetSignature === undefined) continue;
      const current = signature(op.target);
      if (current === op.preparedTargetSignature) continue;
      op.preparedTargetSignature = current;
      changedTargets.add(op.target);
    }
    if (changedTargets.size) onMutations([...changedTargets].map(target => ({ type: 'prepared-style', target })));
  }
  function flushPendingMutations(onlyOperation) {
    if (!active || !observer) return;
    const records = observer.takeRecords();
    if (records.length) onMutations(records);
    samplePreparedTargets(onlyOperation);
  }
  function sampleDescendants(root, limit = 100) {
    const nodes = [];
    const stack = [];
    const pushChildren = parent => {
      const length = parent?.children?.length || 0;
      if (length) stack.push({ parent, index: 0, length });
    };
    pushChildren(root);
    pushChildren(root?.shadowRoot);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.length) { stack.pop(); continue; }
      const node = frame.parent.children[frame.index++];
      if (nodes.length === limit) return { nodes, exceeded: true };
      nodes.push(node);
      pushChildren(node);
      // Inherited host styles and CSS variables can alter visible descendants
      // inside an open shadow root without changing the host's own signature.
      pushChildren(node.shadowRoot);
    }
    return { nodes, exceeded: false };
  }
  function observeRoot(root, budget) {
    if (!root || roots.has(root) || !observer) return;
    roots.add(root);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['role', 'aria-modal', 'aria-label', 'id', 'for', 'form', 'name', 'placeholder', 'title', 'alt', 'aria-labelledby', 'rel', 'media', 'data-selected',
        'aria-required', 'aria-readonly', 'contenteditable', 'tabindex', 'onclick', 'required',
        'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-disabled',
        'type', 'href', 'target', 'download', 'action', 'method', 'formaction', 'formmethod', 'formtarget', 'novalidate', 'formnovalidate',
        'aria-valuenow', 'aria-valuetext', 'aria-hidden', 'hidden', 'disabled', 'readonly', 'checked', 'selected', 'open', 'popover', 'inert', 'class', 'style'] });
    for (const name of ['animationend', 'animationcancel', 'transitionend', 'transitioncancel'])
      listen(root, name, checkSettledAnimation);
    listen(root, 'beforetoggle', event => {
      const el = elementFor(event);
      if (ignored(el) || !el.hasAttribute('popover') || !('popover' in el)) return;
      const mark = { observer, oldState: event.oldState, newState: event.newState, notified: false,
        agentUserAt: agentTurn && lastUserAt <= agentTurn.userAt ? agentTurn.userAt : undefined };
      popoverTurns.set(el, mark);
      // Check after page handlers can cancel opening, but before an action can
      // dispatch in the next task. Retain exact attribution for the later toggle.
      queueMicrotask(() => {
        if (!active || observer !== mark.observer || popoverTurns.get(el) !== mark || event.defaultPrevented
            || popoverOpen(el) !== (mark.newState === 'open')) return;
        mark.notified = true;
        onMutations([{ type: 'popover', target: el, stateChanged: mark.oldState !== mark.newState, agentUserAt: mark.agentUserAt }]);
      });
    });
    listen(root, 'toggle', event => {
      const el = elementFor(event);
      if (ignored(el) || !el.hasAttribute('popover') || !('popover' in el)
          || popoverOpen(el) !== (event.newState === 'open')) return;
      const mark = popoverTurns.get(el);
      if (mark?.observer === observer && mark.newState === event.newState && mark.notified) return;
      onMutations([{ type: 'popover', target: el, stateChanged: event.oldState !== event.newState }]);
    });
    seed(root, budget);
  }
  function popoverOpen(el) {
    return el.hasAttribute('popover') && 'popover' in el && el.matches(':popover-open');
  }
  function subtreeChanged(record, el) {
    const changedNodes = [...record.addedNodes, ...record.removedNodes];
    const meaningful = node => {
      // Text identity is not an interactive target; its content is compared by
      // the parent's signature, including direct text in a shadow root.
      if (node.nodeType === 3) return false;
      if (node.nodeType !== 1 || ignored(node)) return false;
      if (visible(node) || signatures.get(node)?.startsWith('[true')) return true;
      return [...node.querySelectorAll('*')].slice(0, 200).some(child => !ignored(child)
        && (visible(child) || signatures.get(child)?.startsWith('[true')));
    };
    if (changedNodes.some(meaningful)) return true;
    // Removed prepared targets also matter when their old geometry was outside
    // the bounded signature seed, including targets inside an open shadow root.
    return [...record.removedNodes].some(node => !ignored(node.nodeType === 1 ? node : el)
      && [...operations.values()].some(op => {
        for (let target = op.target; target; target = target.getRootNode?.().host) {
          if (node === target || node.contains?.(target)) return true;
        }
        return false;
      }));
  }
  function hasVisibleAriaLabelledbyConsumer(el, previousId = '') {
    const ids = new Set();
    if (previousId) ids.add(previousId);
    for (let node = el; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node.id) ids.add(node.id);
    }
    if (!ids.size) return false;
    let consumers;
    try { consumers = document.querySelectorAll('[aria-labelledby]'); } catch { return false; }
    for (const consumer of consumers) {
      if (ignored(consumer) || !visible(consumer)) continue;
      const references = (consumer.getAttribute('aria-labelledby') || '').trim().split(/\s+/);
      if (references.some(id => ids.has(id))) return true;
    }
    return false;
  }
  function hasVisibleNativeLabelConsumer(el, previousFor = '') {
    let label = null;
    for (let node = el; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node.tagName === 'LABEL') { label = node; break; }
    }
    if (!label) return false;
    const visibleControl = control => control instanceof Element && !ignored(control) && visible(control);
    if (visibleControl(label.control)) return true;
    if (label !== el || !previousFor) return false;
    const root = label.getRootNode?.();
    const priorControl = root?.getElementById?.(previousFor)
      || (root === document ? document.getElementById(previousFor) : null);
    return visibleControl(priorControl);
  }
  const descendantTextNameRoles = new Set([
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'row', 'gridcell', 'cell', 'listitem',
  ]);
  const nonImplicitSubmitInputTypes = new Set([
    'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden', 'color', 'range',
  ]);
  function hasVisibleTextNameConsumer(el) {
    for (let node = el.parentElement || el.getRootNode?.().host; node; node = node.parentElement || node.getRootNode?.().host) {
      if (!visible(node)) continue;
      const tag = node.tagName, role = (node.getAttribute('role') || '').toLowerCase();
      if (['BUTTON', 'A', 'SUMMARY', 'LI'].includes(tag) || /^H[1-6]$/.test(tag) || descendantTextNameRoles.has(role)) return true;
    }
    return false;
  }
  function stylesheetNode(node) {
    if (!(node instanceof Element)) return false;
    return node.tagName === 'STYLE' || (node.tagName === 'LINK'
      && (node.getAttribute('rel') || '').split(/\s+/).some(token => token.toLowerCase() === 'stylesheet'));
  }
  function stylesheetMutation(record) {
    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (record.type === 'attributes') {
      return stylesheetNode(target) || (target?.tagName === 'LINK' && record.attributeName === 'rel'
        && (record.oldValue || '').split(/\s+/).some(token => token.toLowerCase() === 'stylesheet')) ? [target] : [];
    }
    if (record.type === 'characterData') {
      const style = stylesheetNode(target) ? target : stylesheetNode(target?.parentElement) ? target.parentElement : null;
      return style ? [style] : [];
    }
    if (record.type !== 'childList') return [];
    const stylesheets = stylesheetNode(target) ? [target] : [];
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      const style = stylesheetNode(node) ? node : node.nodeType === 3 && stylesheetNode(node.parentElement) ? node.parentElement : null;
      if (style && !stylesheets.includes(style)) stylesheets.push(style);
    }
    return stylesheets;
  }
  function baseNavigationMutation(record, el) {
    if (record.type === 'attributes' && el?.tagName === 'BASE' && ['href', 'target'].includes(record.attributeName))
      return record.oldValue !== el.getAttribute(record.attributeName);
    return record.type === 'childList' && [...record.addedNodes, ...record.removedNodes]
      .some(node => node.nodeType === 1 && node.tagName === 'BASE');
  }
  function runningAnimations(el) {
    try {
      const animations = el?.getAnimations?.();
      return (Array.isArray(animations) ? animations : []).filter(animation => animation.playState === 'running');
    } catch { return []; }
  }
  function deferAnimationCheck(record, el) {
    const animations = runningAnimations(el);
    if (!animations.length) return false;
    const agentUserAt = Number.isFinite(record.agentUserAt) ? record.agentUserAt
      : agentTurn && lastUserAt <= agentTurn.userAt ? agentTurn.userAt : undefined;
    if (Number.isFinite(agentUserAt)) for (const animation of animations) {
      const target = animation.effect?.target;
      animationAttribution.set(target instanceof Element ? target : el, agentUserAt);
    }
    return true;
  }
  function checkSettledAnimation(event) {
    const el = event.target;
    if (!active || !(el instanceof Element) || ignored(el)) return;
    const finiteAnimationRunning = runningAnimations(el).some(animation =>
      animation.effect?.getComputedTiming?.().iterations !== Infinity);
    if (finiteAnimationRunning) return;
    const agentUserAt = animationAttribution.get(el);
    animationAttribution.delete(el);
    onMutations([{ type: 'animation-settled', target: el, ...(Number.isFinite(agentUserAt) ? { agentUserAt } : {}) }]);
  }
  function onMutations(records) {
    if (!active) return;
    let changed = false, source = 'page', target = '';
    const noteChange = (el, agentUserAt) => {
      // Attribute the marked input/write's synchronous handlers to that dispatch.
      // Later DOM writes stay observable, including writes on the same target.
      if ((Number.isFinite(agentUserAt) && lastUserAt <= agentUserAt) || (agentTurn && lastUserAt <= agentTurn.userAt)) {
        const expectedAt = Number.isFinite(agentUserAt) ? agentUserAt : agentTurn?.userAt;
        for (const op of operations.values()) if (op.userAt === expectedAt && related(op.target, el)) rememberAgentLayout(op);
        return;
      }
      changed = true;
      target ||= targetName(el);
      if (userTurn || (Date.now() - lastUserAt < 1500 && related(lastUserTarget, el))) source = 'user';
      else if (source !== 'user' && [...operations.values()].some(op => op.dispatched && op.until >= Date.now())) source = 'unknown';
    };
    const changes = [...records];
    for (const record of records) {
      if (record.type !== 'popover' && record.type !== 'prepared-style'
          && (record.type !== 'attributes' || !['class', 'style', 'hidden', 'aria-hidden', 'open', 'inert', 'selected'].includes(record.attributeName))) continue;
      if (ignored(record.target)) continue;
      if (deferAnimationCheck(record, record.target)) continue;
      if (record.type === 'attributes' && record.attributeName === 'selected'
          && record.oldValue !== record.target.getAttribute('selected')) {
        const select = record.target.closest?.('select');
        if (select && !ignored(select)) noteChange(select, record.agentUserAt);
      }
      const sample = sampleDescendants(record.target);
      // A bounded layout sample cannot prove that inherited visibility left a
      // large subtree unchanged. Invalidate conservatively on an actual state
      // change, before the measurement cap can omit a late affected descendant.
      // Stop walking at the cap instead of materializing the whole subtree.
      if (sample.exceeded) {
        if (record.type === 'popover' || record.oldValue !== record.target.getAttribute(record.attributeName))
          noteChange(record.target, record.agentUserAt);
        continue;
      }
      for (const el of sample.nodes)
        changes.push({ type: 'layout', target: el, agentUserAt: record.agentUserAt });
    }
    let measured = 0;
    const seedBudget = { remaining: 600 };
    for (const record of changes) {
      const el = record.target.nodeType === 1 ? record.target
        : record.target.host || record.target.parentElement || record.target.getRootNode?.().host;
      if (baseNavigationMutation(record, el)) { noteChange(document.documentElement, record.agentUserAt); continue; }
      const changedStylesheets = stylesheetMutation(record);
      if (changedStylesheets.length) {
        if (changedStylesheets.some(style => !decorations.has(style))) noteChange(document.documentElement, record.agentUserAt);
        continue;
      }
      const editableTextMutation = editable(el) && (record.type === 'characterData'
        || (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 3)));
      const accessibleNameContentMutation = ['characterData', 'childList'].includes(record.type);
      if (ignored(el)) continue;
      if (record.type === 'attributes' && record.attributeName === 'data-selected'
          && record.oldValue !== el.getAttribute('data-selected')) {
        const listbox = el.closest?.('[role="listbox"]');
        if (listbox && !ignored(listbox)) noteChange(listbox, record.agentUserAt);
      }
      // Native input already reports user edits, and agent input's synchronous
      // DOM writes are attributed to its dispatch. Keep those paths deduplicated
      // while observing independent page-script changes to editable text.
      if (editableTextMutation && (userTurn || (agentTurn && lastUserAt <= agentTurn.userAt))) continue;
      if (accessibleNameContentMutation && el.tagName === 'OPTION' && el.selected) {
        const select = el.closest('select');
        if (select && !ignored(select)) noteChange(select, record.agentUserAt);
      }
      if (record.type === 'attributes' && ['class', 'style'].includes(record.attributeName)
          && deferAnimationCheck(record, el)) continue;
      if (record.type === 'layout' && deferAnimationCheck(record, el)) continue;
      if (++measured > 300) {
        // The remaining records are intentionally uninspected. Invalidate the
        // prepared page conservatively so a later visible target cannot vanish
        // silently at the end of a large, same-task update.
        changed = true;
        if (source !== 'user') source = agentTurn && lastUserAt <= agentTurn.userAt ? 'agent' : 'unknown';
        target ||= targetName(el);
        break;
      }
      if (record.type === 'control') {
        const nextControl = controlState(el), previousControl = controlSignatures.get(el);
        controlSignatures.set(el, nextControl);
        signatures.set(el, signature(el));
        if (nextControl !== previousControl) noteChange(el, record.agentUserAt);
        continue;
      }
      const nativeLabelAssociationMutation = record.type === 'attributes'
        && record.attributeName === 'for' && el.tagName === 'LABEL';
      const hiddenAriaLabelIdMutation = record.type === 'attributes' && record.attributeName === 'id';
      const hiddenAccessibleNameChanged = !visible(el)
        && ((accessibleNameContentMutation && hasVisibleAriaLabelledbyConsumer(el))
          || (hiddenAriaLabelIdMutation && hasVisibleAriaLabelledbyConsumer(el, record.oldValue))
          || (accessibleNameContentMutation && hasVisibleTextNameConsumer(el))
          || ((accessibleNameContentMutation || nativeLabelAssociationMutation)
            && hasVisibleNativeLabelConsumer(el, nativeLabelAssociationMutation ? record.oldValue : '')));
      let identityChanged = (record.type === 'popover' && record.stateChanged)
        || record.type === 'prepared-style'
        || (record.type === 'layout' && record.layoutChanged)
        || editableTextMutation || hiddenAccessibleNameChanged
        || (record.type === 'shadow' && (visible(el) || signatures.get(el)?.startsWith('[true')));
      if (record.type === 'childList') {
        identityChanged ||= subtreeChanged(record, el);
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || ignored(node)) continue;
          if (seedBudget.remaining > 0) { seedBudget.remaining--; signatures.set(node, signature(node)); }
          seed(node, seedBudget);
          if (node.shadowRoot) observeRoot(node.shadowRoot, seedBudget);
        }
        if ([...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === 1 && ignored(node))) {
          signatures.set(el, signature(el)); continue;
        }
      }
      const next = signature(el), previous = signatures.get(el);
      signatures.set(el, next);
      if (/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(el.tagName)) controlSignatures.set(el, controlState(el));
      if (!identityChanged && (next === previous || (!visible(el) && !previous?.startsWith('[true')))) continue;
      noteChange(el, record.agentUserAt);
    }
    if (!changed) return;
    // Keep prepared-target baselines aligned with changes already reported by
    // the DOM observer; the CSSOM sampler should only report unseen changes.
    for (const op of operations.values())
      if (!op.dispatched && op.target && op.until >= Date.now()) op.preparedTargetSignature = signature(op.target);
    if (source !== 'page' && source !== 'agent') interventionRevision++;
    revision++; publishRevision();
    clearTimeout(domTimer);
    pendingDOM = { kind: 'dom', source, target };
    domTimer = setTimeout(() => { domTimer = null; const observation = pendingDOM; pendingDOM = null; send(observation); }, 150);
  }
  function observeLayoutShifts() {
    if (typeof PerformanceObserver !== 'function'
        || !PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) return;
    try {
      layoutObserver = new PerformanceObserver(list => {
        if (!active) return;
        const records = [];
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput || !Array.isArray(entry.sources)) continue;
          for (const source of entry.sources) {
            const el = source.node instanceof Element ? source.node : source.node?.parentElement;
            if (!el || ignored(el) || !visible(el) || el.getAnimations?.().some(animation => animation.playState === 'running')) continue;
            const oldRect = source.previousRect, newRect = source.currentRect;
            if (!oldRect || !newRect || !['x', 'y', 'width', 'height'].some(key => Math.abs(oldRect[key] - newRect[key]) > 2)) continue;
            const agentUserAt = layoutAgentUserAt(el, { previousRect: source.previousRect, currentRect: source.currentRect, entry });
            records.push({ type: 'layout', target: el, layoutChanged: true, agentUserAt });
            if (records.length >= 32) break;
          }
          if (records.length >= 32) break;
        }
        if (records.length) onMutations(records);
      });
      layoutObserver.observe({ type: 'layout-shift', buffered: false });
    } catch { layoutObserver?.disconnect(); layoutObserver = null; }
  }
  function listen(target, name, handler, passive = true) {
    target.addEventListener(name, handler, { capture: true, passive });
    listeners.push(() => target.removeEventListener(name, handler, true));
  }
  function start(state) {
    if (disposed || !state?.active || state.documentToken !== documentToken) return;
    if (active && runToken === state.runToken) return;
    stop();
    active = true; runToken = state.runToken; seq = 0; revision = 0; interventionRevision = 0; publishRevision();
    observer = new MutationObserver(onMutations);
    observeRoot(document);
    controlTimer = setInterval(() => { sampleFormControls(); samplePreparedTargets(); }, 250);
    observeLayoutShifts();
    listen(document, 'webbrain-shadow-root-attached', event => {
      const path = event.composedPath();
      if (path.some(node => node instanceof Element && ignored(node))) return;
      const host = elementFor(event), root = host?.shadowRoot;
      if (!host?.isConnected || !root || roots.has(root)) return;
      observeRoot(root);
      onMutations([{ type: 'shadow', target: host }]);
    });
    listen(window, 'webbrain-agent-dom-dispatch', event => {
      try {
        const guard = JSON.parse(String(event.detail));
        const op = operations.get(guard.operationId);
        const phase = ['focus', 'click', 'input'].includes(guard.dispatchPhase) ? guard.dispatchPhase : 'dom';
        const phaseKind = phase === 'input' ? 'input' : phase === 'dom' ? 'dom' : 'click';
        const actionPhase = phase !== 'dom';
        const phaseAlreadyConsumed = phase === 'dom'
          ? op?.domDispatchConsumed === true
          : op?.domDispatchConsumed === true || op?.domDispatchPhases?.has(phase) === true;
        event.stopImmediatePropagation();
        flushPendingMutations(op);
        sampleFormControls(op?.target);
        if (!active || guard.runToken !== runToken || guard.documentToken !== documentToken || guard.revision !== revision
            || !op || phaseAlreadyConsumed || op.kind !== phaseKind
            || (phase === 'input' && elementFor(event) !== op.target && elementFor(event) !== op.focusTarget)
            || op.preparedRevision !== revision || domTimer || unreported || lastUserAt > op.userAt) {
          event.preventDefault(); return;
        }
        if (actionPhase) {
          op.domDispatchPhases ||= new Set();
          op.domDispatchPhases.add(phase);
          if (!op.dispatched) dispatch({ operationId: op.operationId, kind: phaseKind, runToken });
          if (phase === 'input') op.synchronous = true;
        } else op.domDispatchConsumed = true;
        const marker = { userAt: lastUserAt }; agentTurn = marker;
        setTimeout(() => { if (phase === 'input') op.synchronous = false; if (agentTurn === marker) agentTurn = null; }, 0);
      } catch { event.stopImmediatePropagation(); event.preventDefault(); /* Only a current prepared operation can mark a DOM write. */ }
    }, false);
    listen(document, 'webbrain-agent-scroll-dispatch', event => {
      try {
        const guard = JSON.parse(String(event.detail));
        if (guard.documentToken !== documentToken || guard.revision !== revision || !operations.has(guard.operationId)
            || domTimer || unreported) { event.preventDefault(); return; }
        const el = elementFor(event);
        dispatch({ operationId: guard.operationId, kind: 'scroll', scrollIntoView: true, runToken });
        const op = operations.get(guard.operationId);
        op.target = el; op.scrollAncestors.clear();
        for (let node = el?.parentElement || el?.getRootNode?.().host; node; node = node.parentElement || node.getRootNode?.().host) op.scrollAncestors.add(node);
      } catch { event.preventDefault(); }
    }, false);
    const noteAgentTurn = event => {
      const el = elementFor(event);
      const op = expected(['input', 'beforeinput', 'change', 'keydown'].includes(event.type) ? 'input' : 'click', el, event);
      if (!op) return;
      if (event.type === 'keydown') op.tabFocusRebindAllowed = event.key === 'Tab';
      if (['input', 'beforeinput', 'change'].includes(event.type)) rememberAgentLayout(op);
      const marker = { userAt: op.userAt };
      agentTurn = marker;
      const enterFormSubmit = event.type === 'keydown' && event.key === 'Enter' && op.kind === 'input'
        && !el?.isContentEditable && !!el?.form
        && ((el.tagName === 'INPUT' && !nonImplicitSubmitInputTypes.has(el.type))
          || el.matches?.('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]'));
      if (event.type === 'keydown' && !enterFormSubmit) {
        const key = event.key === 'Spacebar' ? ' ' : event.key;
        const keyboardClickTarget = event.composedPath().find(node => node instanceof Element && (
          (key === 'Enter' && node.matches('a[href],area[href]'))
          || (['Enter', ' '].includes(key) && node.matches('button,summary,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]'))
          || (key === ' ' && node.matches('input[type="checkbox"],input[type="radio"]'))
        ));
        if (keyboardClickTarget) { op.keyboardClickTarget = keyboardClickTarget; op.kinds.add('click'); }
      }
      const keyboardClick = event.type === 'click' && event.isTrusted === true && op.keyboardClickTarget
        && related(op.keyboardClickTarget, el);
      if ((op.navigationCandidate && ['click', 'pointerdown'].includes(event.type)) || enterFormSubmit || keyboardClick) {
        const path = event.composedPath();
        const link = enterFormSubmit ? null : path.find(node => node instanceof Element && node.matches('a[href],area[href]'));
        let submitter = path.find(node => node instanceof Element
          && node.matches('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]') && node.form);
        const form = submitter?.form || (enterFormSubmit ? el.form : null);
        if (enterFormSubmit && form && !submitter) {
          submitter = [...form.elements].find(node => !node.disabled && node.matches?.(
            'button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]')) || null;
        }
        if (enterFormSubmit && submitter) { op.submitTarget = submitter; op.kinds.add('click'); }
        const formMethod = submitter?.hasAttribute('formmethod') ? submitter.formMethod : form?.method;
        const navigationFormGet = !link && !!form && String(formMethod || 'get').toLowerCase() === 'get';
        const formTarget = submitter?.getAttribute('formtarget') || form?.getAttribute('target');
        const baseTarget = document.querySelector('base[target]')?.getAttribute('target') || '';
        const navigationTarget = String((link ? link.getAttribute('target') : formTarget) || baseTarget || '');
        const normalizedTarget = navigationTarget.toLowerCase();
        let navigationUrl = '';
        try {
          const rawUrl = link?.href || (form ? (submitter?.hasAttribute('formaction') ? submitter.formAction : form.action) : '');
          const destination = new URL(rawUrl, document.baseURI);
          if (navigationFormGet) { destination.search = ''; destination.hash = ''; }
          if (['http:', 'https:'].includes(destination.protocol) && !destination.username && !destination.password
              && destination.href.length <= 2000) navigationUrl = destination.href;
        } catch { /* Non-web and malformed targets are not navigation correlations. */ }
        send({ kind: 'activity', source: 'agent', operation: enterFormSubmit ? 'submit' : 'click',
          ...(navigationUrl ? { navigationUrl } : {}),
          ...(navigationUrl && navigationFormGet ? { navigationFormGet: true } : {}),
          ...(['_top', '_parent', '_self', '_blank'].includes(normalizedTarget)
            ? { navigationTarget: normalizedTarget }
            : navigationTarget ? { navigationTargetName: compact(navigationTarget, 256) } : {}) });
      }
      // Native listeners have microtask checkpoints between callbacks. Keep this
      // exact input's attribution through its page handlers, until the next task.
      setTimeout(() => { if (agentTurn === marker) agentTurn = null; }, 0);
    };
    for (const name of ['pointerover', 'mouseover']) listen(document, name, event => {
      if (event.isTrusted) expected('click', elementFor(event), event, true);
    });
    for (const name of ['click', 'input', 'beforeinput', 'change', 'keydown', 'pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup'])
      listen(document, name, noteAgentTurn);
    listen(document, 'pointerdown', event => {
      const el = elementFor(event);
      if (!event.isTrusted || ignored(el) || expected('click', el, event)) return;
      activePointers.add(event.pointerId);
      pointerHeld = true; interact('activity', el);
    });
    listen(document, 'pointermove', event => {
      if (activePointers.has(event.pointerId) && event.isTrusted) {
        if (!event.buttons) activePointers.delete(event.pointerId);
        pointerHeld = activePointers.size > 0;
        interact('activity', elementFor(event));
      }
    });
    for (const name of ['pointerup', 'pointercancel']) listen(document, name, event => {
      if (!activePointers.has(event.pointerId) || !event.isTrusted) return;
      activePointers.delete(event.pointerId);
      pointerHeld = activePointers.size > 0;
      interact('activity', elementFor(event), { completeGesture: activePointers.size === 0 });
    });
    listen(document, 'click', event => {
      const el = elementFor(event);
      if (!event.isTrusted || expected('click', el, event)) return;
      interact('click', el);
    });
    listen(document, 'focusin', event => {
      const el = elementFor(event);
      if (!event.isTrusted || ignored(el) || deepActiveElement() !== el || expected('focus', el, event)) return;
      if (agentTurn && lastUserAt <= agentTurn.userAt) return;
      // The pointer/key that led to a same-turn focus is already reported.
      if (userTurn) return;
      revision++; publishRevision();
      send({ kind: 'activity', source: 'page', target: targetName(el) });
    });
    for (const name of ['beforeinput', 'input', 'change']) listen(document, name, event => {
      const el = elementFor(event);
      const expectedInput = expected('input', el, event);
      const expectedClick = !expectedInput && el.matches?.('input[type="checkbox"],input[type="radio"],select,option')
        ? expected('click', el, event) : null;
      if (ignored(el)) return;
      if (expectedInput || expectedClick) { refreshControl(el); return; }
      if (event.isTrusted) interact('input', el);
      else { revision++; send({ kind: 'input', source: 'page', target: targetName(el) }); }
      refreshControl(el);
    });
    listen(document, 'compositionstart', event => {
      const el = elementFor(event);
      if (event.isTrusted && !expected('input', el, event)) { composing = true; interact('activity', el); }
    });
    listen(document, 'compositionend', event => {
      const el = elementFor(event);
      if (event.isTrusted && !expected('input', el, event)) { composing = false; interact('input', el); }
    });
    listen(document, 'keydown', event => {
      const el = elementFor(event);
      if (!event.isTrusted || expected('input', el, event)) return;
      // Modifier-only presses do not activate page shortcuts. Other trusted
      // keydowns can change page state even when no DOM mutation follows; key
      // values are used only for this local filter and never enter feedback.
      if (!['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super']
        .includes(event.key)) interact('activity', el);
    });
    for (const name of ['wheel', 'touchmove']) listen(document, name, event => {
      const el = elementFor(event);
      if (event.isTrusted && !expected('scroll', el, event)) interact('activity', el);
    });
    lastViewport = JSON.stringify(currentViewport());
    const onResize = () => {
      const current = currentViewport(), key = JSON.stringify(current);
      if (!active || key === lastViewport) return;
      lastViewport = key; revision++; publishRevision();
      if (agentResize?.runToken === runToken && agentResize.events.length < 16) {
        agentResize.events.push(current);
        return;
      }
      if (agentResize) void flushAgentResize('unknown');
      send({ kind: 'resize', source: window === window.top ? 'unknown' : 'page', target: 'viewport', viewport: current });
    };
    listen(window, 'resize', onResize);
    if (window.visualViewport) {
      listen(window.visualViewport, 'resize', onResize);
      listen(window.visualViewport, 'scroll', onResize);
    }
    listen(document, 'scroll', event => {
      const el = event.target === document ? document.documentElement : event.target;
      if (ignored(el)) return;
      const agentScroll = expected('scroll', el);
      if (agentScroll) {
        // Page scroll handlers can synchronously append lazy content. Carry the
        // exact scroll's attribution through the MutationObserver checkpoint.
        const marker = { userAt: agentScroll.userAt };
        agentTurn = marker;
        setTimeout(() => { if (agentTurn === marker) agentTurn = null; }, 0);
        return;
      }
      const source = Date.now() - lastUserAt < 1000 ? 'user' : 'unknown';
      const viewport = { x: el === document.documentElement ? scrollX : el.scrollLeft,
        y: el === document.documentElement ? scrollY : el.scrollTop };
      // Invalidate coordinates immediately, then coalesce the final position.
      revision++;
      send({ kind: 'scroll', source, target: targetName(el), viewport });
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (expected('scroll', el)) return;
        send({ kind: 'scroll', source, target: targetName(el), viewport: {
          x: el === document.documentElement ? scrollX : el.scrollLeft,
          y: el === document.documentElement ? scrollY : el.scrollTop } });
      }, 100);
    });
    listen(document, 'selectionchange', () => {
      if (Date.now() - lastUserAt < 1000 && !editable(document.activeElement)) interact('selection', document.activeElement || document.body);
    });
    listen(window, 'blur', () => {
      if (pointerHeld || composing) { activePointers.clear(); pointerHeld = false; composing = false; interact('activity', document.body, { interacting: false }); }
    });
    listen(window, 'pagehide', () => stop());
  }
  function stop() {
    active = false; runToken = ''; activePointers.clear(); pointerHeld = false; composing = false;
    clearTimeout(agentResize?.timer); agentResize = null;
    lastUserAt = 0; lastViewport = ''; userTurn = null; lastUserTarget = null; matchedEvents = new WeakMap(); controlIterator = null; preparedOperationCursor = 0;
    document.documentElement?.removeAttribute(fenceAttribute);
    for (const el of nativeTargets) {
      el.removeAttribute?.('data-webbrain-native-action');
      el.removeAttribute?.('data-webbrain-native-target');
    }
    nativeTargets.clear();
    observer?.disconnect(); observer = null;
    layoutObserver?.disconnect(); layoutObserver = null;
    clearTimeout(domTimer); clearTimeout(scrollTimer); clearInterval(controlTimer); domTimer = null; scrollTimer = null; controlTimer = null; unreported = 0; interventionUnreported = 0; interventionRevision = 0; pendingDOM = null; lastFeedbackDelivery = Promise.resolve();
    listeners.splice(0).forEach(remove => remove());
    operations.clear(); modelSnapshots.clear(); localOperation = null; agentTurn = null;
    animationAttribution = new WeakMap();
    agentLayoutHistory.length = 0;
    roots = new WeakSet(); signatures = new WeakMap(); controlSignatures = new WeakMap(); textSignatures = new WeakMap(); popoverTurns = new WeakMap(); controlReferences.clear(); controlIterator = null;
  }
  async function requestState() {
    const generation = ++requestGeneration;
    try {
      const state = await api.runtime.sendMessage({ target: 'background', action: 'get_page_monitor_state', documentToken,
        frameName: compact(window.name.slice(0, 256), 256) });
      if (generation === requestGeneration && !disposed) {
        if (state?.active) start(state);
        else stop();
      }
    } catch { stop(); }
  }
  function prepare(params) {
    const expected = params.expectedModelSnapshot !== undefined;
    if (!active || params.runToken !== runToken) return expected ? { modelBindingValid: false } : {};
    flushPendingMutations();
    prune();
    const previous = operations.get(params.operationId);
    // A content preflight can start the transport without sending input.
    // Its later native prepare must retain the first inference's proof until
    // an actual action was dispatched, even if the owner omits the snapshot.
    const inherited = !expected && previous?.preparedBinding?.model === true && !previous.dispatched;
    const target = resolveTarget(params);
    const focusEligible = kindFor(params.tool) === 'input' || modelFocusTools.has(params.tool);
    const focusTarget = target || (focusEligible ? deepActiveElement() : null);
    const coordinateSensitive = Number.isFinite(params.x) && Number.isFinite(params.y);
    const coordinateHit = coordinateSensitive ? document.elementFromPoint(params.x, params.y) : null;
    const coordinateTarget = coordinateSensitive ? target || coordinateHit : null;
    const coordinateTargetAtPoint = !target || !coordinateHit || target === coordinateHit || target.contains?.(coordinateHit);
    const operationTarget = target || focusTarget;
    const certified = expected ? modelBinding(params) : inherited
      && previous.runToken === runToken && previous.until >= Date.now()
      && previous.preparedInterventionRevision === interventionRevision && lastUserAt === previous.userAt
      && !interventionUnreported && (!pendingDOM || pendingDOM.source === 'page')
      && !previous.modelBindingInvalid && !previous.layoutInvalidated
      && operationTarget === previous.preparedBinding.target
      && samePreparedBinding(previous.preparedBinding, actionFootprint(operationTarget)) ? previous.preparedBinding : null;
    const proofRequired = expected || inherited;
    const allowPassiveRebase = inherited ? previous.allowPassiveRebase === true : params.allowPassiveRebase === true;
    const controlStateAtPrepare = operationTarget && /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(operationTarget.tagName)
      ? controlState(operationTarget) : undefined;
    operations.set(params.operationId, { ...params, target: operationTarget, focusTarget, focusEligible, controlStateAtPrepare,
      focusBound: inherited ? previous.focusBound : !!certified && modelFocusTools.has(params.tool)
        && !params.ref_id && !params.selector && !params.nativeTarget && !params.textMatch,
      ...(inherited ? { expectedModelSnapshot: previous.expectedModelSnapshot,
        modelBindingTool: previous.modelBindingTool || previous.tool } : {}),
      allowPassiveRebase: allowPassiveRebase && (!proofRequired || !!certified),
      modelBindingInvalid: proofRequired && !certified,
      preparedTargetSignature: operationTarget ? signature(operationTarget) : undefined, kinds: new Set(),
      preparedBinding: proofRequired ? certified : allowPassiveRebase && operationTarget ? preparedBinding(operationTarget) : null,
      preparedInterventionRevision: interventionRevision,
      preparedPageContext: JSON.stringify([location.href, document.baseURI, currentViewport(), window.scrollX, window.scrollY]),
      coordinateSensitive, coordinateTarget, coordinateHit, coordinateTargetAtPoint,
      coordinatePoint: coordinateSensitive ? { x: params.x, y: params.y } : null,
      coordinateRect: rectFor(coordinateTarget),
      until: Date.now() + 30000, dispatched: false, userAt: lastUserAt, preparedRevision: revision });
    return proofRequired ? { modelBindingValid: !!certified } : {};
  }
  function dispatch(params) {
    if (!active || (params.runToken && params.runToken !== runToken)) return;
    const op = operations.get(params.operationId) || { operationId: params.operationId, userAt: lastUserAt };
    if (params.fenceOnly && !op.nativeSecret) op.nativeSecret = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    op.blurTarget ??= document.activeElement;
    op.target = resolveTarget(params) || (params.kind === 'input' ? op.focusTarget || deepActiveElement() : op.target);
    if (params.kind === 'input' && !op.focusTarget) op.focusTarget = op.target;
    if (params.kind === 'focus') { op.focusTarget = op.target; op.focusEligible = !!op.target; }
    op.x = params.x; op.y = params.y;
    if (!params.release || !op.seenEvents) op.seenEvents = new Set();
    if (!params.release) op.eventTypes = Array.isArray(params.eventTypes) ? new Set(params.eventTypes) : null;
    op.focused = params.kind === 'input'; op.kind = params.kind;
    op.nativeWheel = params.nativeWheel === true;
    if (!params.release) op.navigationCandidate = params.kind === 'click' && params.navigationCandidate !== false;
    op.scrollAncestors = params.addScrollTarget ? op.scrollAncestors || new Set() : new Set();
    if (params.scrollIntoView || params.nativeWheel || ['input', 'click'].includes(params.kind)) {
      if (params.addScrollTarget && op.target) op.scrollAncestors.add(op.target);
      for (let node = op.target?.parentElement || op.target?.getRootNode?.().host; node; node = node.parentElement || node.getRootNode?.().host) op.scrollAncestors.add(node);
    }
    op.windowScroll = params.scrollIntoView || (params.kind === 'scroll' && !op.target) || ['input', 'click'].includes(params.kind);
    op.kinds = new Set([params.kind, 'dom', ...(params.kind === 'input' ? ['selection'] : []), 'scroll']);
    op.until = Date.now() + (params.fenceOnly ? 30000 : 1500); op.dispatched = !params.fenceOnly;
    if (op.dispatched && op.target) {
      op.targetRectAtDispatch = rectFor(op.target);
      op.targetParentAtDispatch = op.target.parentElement;
      op.layoutRect ||= op.targetRectAtDispatch;
    }
    operations.set(op.operationId, op);
  }
  function activatePreparedDispatch(params = {}) {
    const op = operations.get(params.operationId);
    flushPendingMutations(op);
    sampleFormControls(op?.target);
    const layoutChanged = coordinatePreparationShifted(op);
    const bindingChanged = preparedBindingChanged(op);
    const rebased = !layoutChanged && rebasePassivePreparation(op, params);
    if (!active || !op || op.modelBindingInvalid || layoutChanged || bindingChanged || (!rebased && (domTimer || unreported))
        || (params.element && op.target !== params.element)
        || lastUserAt > op.userAt
        || (Number.isFinite(op.preparedRevision) && op.preparedRevision !== revision)) {
      const error = new Error('Browser changed during action preparation. Re-observe before acting.');
      error.code = 'page_feedback_pending';
      error.dispatched = false;
      throw error;
    }
    dispatch({ ...params, runToken });
    publishRevision();
    return { ready: true, operationId: op.operationId, revision };
  }
  function validateNativeDispatch(params = {}) {
    const op = operations.get(params.operationId);
    flushPendingMutations(op);
    sampleFormControls(op?.target);
    const currentFocus = deepActiveElement();
    const rebindingFocus = params.rebindFocus === true;
    const fileAssignment = op?.target?.tagName === 'INPUT' && op.target.type === 'file';
    // A companion validates once before writing its marker and again before
    // the native key. Revalidating the same consumed Tab rebind is safe only
    // while its native sequence and exact deeply focused node remain current.
    const focusRebindAvailable = rebindingFocus && (op?.tabFocusRebindAllowed === true
      || (op?.tabFocusRebound === true && op.tabFocusRebindSequence === op.nativeSequence && currentFocus === op.focusTarget));
    if (op?.kind === 'input' && !fileAssignment && (rebindingFocus
      ? !(op.nativeSequence > 0) || !focusRebindAvailable || !currentFocus || currentFocus === document.body || currentFocus === document.documentElement
      : currentFocus !== op.focusTarget)) return false;
    const shifted = coordinatePreparationShifted(op);
    const bindingChanged = preparedBindingChanged(op, { allowFocusRebind: focusRebindAvailable });
    const preparedRevision = op?.preparedRevision;
    const suppliedRevisionMatches = Number(params.revision) === preparedRevision;
    const rebased = suppliedRevisionMatches && !shifted && rebasePassivePreparation(op, params);
    if (!active || params.runToken !== runToken || params.documentToken !== documentToken || !op || op.modelBindingInvalid || shifted || bindingChanged
        || !suppliedRevisionMatches || op.preparedRevision !== revision
        || (!rebased && (domTimer || unreported)) || lastUserAt > op.userAt) return false;
    if (params.rebindFocus === true) {
      op.target = currentFocus;
      op.focusTarget = currentFocus;
      op.tabFocusRebindAllowed = false;
      op.tabFocusRebound = true;
      op.tabFocusRebindSequence = op.nativeSequence;
    }
    return true;
  }
  function withPreparedDispatch(operationId, callback) {
    const op = operations.get(operationId);
    if (!op?.dispatched || typeof callback !== 'function') return callback?.();
    const previous = op.synchronous;
    op.synchronous = true;
    try { return callback(); }
    finally {
      op.synchronous = previous;
      // Native editing can move following siblings; record the causal size
      // change now, before the browser reports its layout shift asynchronously.
      rememberAgentLayout(op);
    }
  }
  const localMutations = new Set(['click', 'click_ax', 'type', 'type_ax', 'set_field', 'set_checked', 'press_keys', 'scroll',
    'hover', 'drag_drop', 'patch_element', 'revert_patch', 'highlight_element', 'execute_js',
    'ax_prepare_field_for_trusted_type', 'ax_resolve_two_rects', 'ax_resolve_rect']);
  function beginContentAction(action, params = {}) {
    if (!active || !localMutations.has(action)) return () => {};
    const operationId = `local-${randomToken()}`;
    const previous = localOperation;
    const target = resolveTarget({ ...params, textMatch: action === 'click' ? params.text : undefined })
      || (kindFor(action) === 'input' ? deepActiveElement() : null);
    const approved = [...operations.values()].reverse().find(op => op.allowPassiveRebase === true && !op.dispatched
      && op.preparedBinding?.target === target && op.until >= Date.now()
      && op.preparedInterventionRevision === interventionRevision && lastUserAt <= op.userAt && !interventionUnreported
      && (!pendingDOM || pendingDOM.source === 'page')
      && samePreparedBinding(op.preparedBinding, operationBinding(op, target)));
    prepare({ selector: params.selector, ref_id: params.ref_id, x: params.x, y: params.y,
      textMatch: action === 'click' ? params.text : undefined, tool: action, operationId, runToken,
      ...(params.expectedModelSnapshot !== undefined || approved?.expectedModelSnapshot !== undefined
        ? { expectedModelSnapshot: params.expectedModelSnapshot ?? approved.expectedModelSnapshot } : {}),
      allowPassiveRebase: params.allowPassiveRebase === true || !!approved });
    if (approved?.preparedBinding?.model === true) {
      const local = operations.get(operationId);
      if (local) {
        local.preparedBinding = approved.preparedBinding;
        local.modelBindingTool = approved.modelBindingTool || approved.tool;
        local.expectedModelSnapshot = approved.expectedModelSnapshot;
        local.focusBound = approved.focusBound;
        local.modelBindingInvalid = false;
        local.allowPassiveRebase = true;
      }
    }
    localOperation = { operationId, kind: kindFor(action), userAt: lastUserAt, revision,
      navigationCandidate: ['click', 'click_ax', 'set_checked'].includes(action),
      scrollIntoView: /^ax_resolve|ax_prepare_field/.test(action) };
    // Do not mark a BiDi preparation probe as actual input.
    if (!params._bidiPrepare) beforeLocalDispatch({ preparation: true });
    return () => {
      const op = operations.get(operationId);
      if (op) op.until = Date.now() + 200;
      localOperation = previous;
    };
  }
  function beforeLocalDispatch({ preparation = false, kind, target } = {}) {
    if (!active || !localOperation) return;
    const operation = operations.get(localOperation.operationId);
    flushPendingMutations(operation);
    sampleFormControls(operation?.target);
    const layoutChanged = coordinatePreparationShifted(operation);
    const bindingChanged = preparedBindingChanged(operation);
    const rebased = !layoutChanged && rebasePassivePreparation(operation, { element: target });
    if (rebased) localOperation.revision = operation.preparedRevision;
    if (operation?.modelBindingInvalid || layoutChanged || bindingChanged || (!rebased && (domTimer || unreported)) || lastUserAt > localOperation.userAt || revision !== localOperation.revision) {
      const error = new Error('Browser changed during action preparation. Re-observe before acting.');
      error.code = 'page_feedback_pending'; error.dispatched = localOperation.started === true; throw error;
    }
    if (!preparation) {
      localOperation.started = true;
      const marker = { userAt: lastUserAt }; agentTurn = marker;
      setTimeout(() => { if (agentTurn === marker) agentTurn = null; }, 0);
    }
    dispatch({ ...localOperation, kind: kind || localOperation.kind, element: target,
      scrollIntoView: localOperation.scrollIntoView || (kind === 'scroll' && !!target),
      addScrollTarget: kind === 'scroll' && !!target,
      navigationCandidate: !preparation && localOperation.navigationCandidate,
      fenceOnly: preparation, runToken });
  }
  function withLocalDispatch(callback) {
    beforeLocalDispatch();
    const op = operations.get(localOperation?.operationId);
    if (!op) return callback();
    // One synchronous native edit can emit repeated input phases (multiline
    // execCommand). Attribute only its target until the command returns, never
    // across an asynchronous preparation or settling wait.
    const previous = op.synchronous;
    op.synchronous = true;
    try { return callback(); }
    finally { op.synchronous = previous; }
  }
  const onMessage = (msg, _sender, respond) => {
    if (disposed || msg?.target !== 'content') return;
    if (msg.action === 'page_monitor_state') {
      if (msg.active) {
        void requestState().then(() => respond({ ready: true, active, documentToken, runToken: active ? runToken : '' }));
        return true;
      }
      else if (!msg.runToken || msg.runToken === runToken) { requestGeneration++; stop(); respond({ ready: true }); }
    } else if (msg.action === 'page_monitor_capture_model') { respond(captureModel(msg.params || {})); }
    else if (msg.action === 'page_monitor_validate_model') {
      const params = msg.params || {};
      flushPendingMutations(); sampleFormControls();
      const result = modelBindingResult(params);
      respond({ ready: !!result.binding, ...(result.uncertified ? { uncertified: true } : {}),
        ...(result.reason ? { reason: result.reason } : {}), runToken, documentToken, snapshotToken: params.snapshotToken });
    }
    else if (msg.action === 'page_monitor_prepare') { respond({ ready: true, ...prepare(msg.params || {}) }); }
    else if (msg.action === 'page_monitor_resize_begin') { respond({ ready: beginAgentResize(msg.params || {}) }); }
    else if (msg.action === 'page_monitor_resize_finish') {
      void finishAgentResize(msg.params || {}).then(respond, () => respond({ ready: false })); return true;
    }
    else if (msg.action === 'page_monitor_validate') {
      const ready = validateNativeDispatch(msg.params || {});
      respond({ ready, ...(ready ? { revision } : {}) });
    }
    else if (msg.action === 'page_monitor_dispatch') {
      const params = msg.params || {};
      const prepared = operations.get(params.operationId);
      if (!params.release) { flushPendingMutations(prepared); sampleFormControls(prepared?.target); }
      const layoutChanged = !params.release && active && coordinatePreparationShifted(prepared);
      const bindingChanged = !params.release && preparedBindingChanged(prepared);
      const rebased = !params.release && !layoutChanged && rebasePassivePreparation(prepared, params);
      if (!params.release && active && (prepared?.modelBindingInvalid || layoutChanged || bindingChanged || (!rebased && (domTimer || unreported)) || (prepared && prepared.preparedRevision !== revision)
          || (params.documentToken && (params.documentToken !== documentToken || (!rebased && params.documentRevision !== revision))))) {
        if (domTimer) {
          clearTimeout(domTimer); domTimer = null; const observation = pendingDOM; pendingDOM = null;
          if (observation) send(observation);
        }
        void lastFeedbackDelivery.then(() => respond({ ready: false, pageFeedbackPending: true }));
        return true;
      }
      dispatch(params); publishRevision();
      respond({ ready: true, ...(active && params.runToken === runToken ? { guard: {
        documentToken, revision, operationId: params.operationId, runToken,
        navigationCandidate: params.navigationCandidate !== false,
        ...(operations.get(params.operationId)?.nativeSecret ? { nativeSecret: operations.get(params.operationId).nativeSecret } : {}),
      } } : {}) });
    }
    else if (msg.action === 'page_monitor_finish') {
      const op = operations.get(msg.params?.operationId);
      if (op) op.until = Date.now() + 200;
      respond({ ready: true });
    }
  };
  api.runtime.onMessage.addListener(onMessage);
  window.__wbPageMonitor = { beginContentAction, beforeLocalDispatch, withLocalDispatch, dispatch, activatePreparedDispatch, withPreparedDispatch, registerDecoration,
    get active() { return active; },
    get disposed() { return disposed; },
    dispose() { disposed = true; requestGeneration++; stop(); api.runtime.onMessage.removeListener?.(onMessage); } };
  void requestState();
  // A document restored from BFCache needs a fresh run/document handshake.
  window.addEventListener('pageshow', () => { if (!disposed && !active) void requestState(); });
})();
