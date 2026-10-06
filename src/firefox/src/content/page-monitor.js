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
  const nativeTargets = new Set();
  let signatures = new WeakMap();
  let textSignatures = new WeakMap();
  let popoverTurns = new WeakMap();
  let roots = new WeakSet();
  let active = false, disposed = false, runToken = '', seq = 0, revision = 0;
  let observer = null, layoutObserver = null, domTimer = null, scrollTimer = null, lastUserAt = 0;
  let pointerHeld = false, composing = false, localOperation = null;
  let requestGeneration = 0, unreported = 0, pendingDOM = null;
  let lastViewport = '';
  let lastFeedbackDelivery = Promise.resolve();
  let agentTurn = null, userTurn = null, lastUserTarget = null;
  let matchedEvents = new WeakMap(), nativeMarks = new WeakMap();
  const fenceAttribute = 'data-webbrain-page-revision';
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
    const owner = runToken;
    if (pending) unreported++;
    try {
      const delivery = Promise.resolve(api.runtime.sendMessage({ target: 'background', action: 'page_feedback', feedback }))
        .then(() => { if (pending && owner === runToken) unreported = Math.max(0, unreported - 1); })
        .catch(() => stop());
      if (pending) lastFeedbackDelivery = delivery;
      return delivery;
    } catch { stop(); }
  };
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
    try { if (!el && params.selector) el = document.querySelector(params.selector); } catch {}
    if (!el && Number.isFinite(params.x) && Number.isFinite(params.y)) el = document.elementFromPoint(params.x, params.y);
    if (!el && params.textMatch) {
      const matches = [...document.querySelectorAll('button,a,input,select,[role="button"],[role="link"]')]
        .filter(node => (node.getAttribute('aria-label') || node.textContent || '').trim() === params.textMatch);
      if (matches.length === 1) el = matches[0];
    }
    return el;
  };
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
  function layoutAgentUserAt() {
    if (agentTurn && lastUserAt <= agentTurn.userAt) return agentTurn.userAt;
    for (const op of operations.values()) {
      if (op.dispatched && Date.now() <= op.until && Number.isFinite(op.userAt) && lastUserAt <= op.userAt) return op.userAt;
    }
    return undefined;
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
    const source = layoutAgentUserAt() !== undefined ? 'agent' : 'page';
    send({ kind: 'dom', source, target: targetName(target || currentHit) });
    return true;
  }
  function expected(kind, el, event) {
    const marker = el?.getAttribute?.('data-webbrain-native-action');
    if (marker && nativeMarks.get(el) !== marker) {
      nativeMarks.set(el, marker); nativeTargets.add(el);
      try {
        const data = JSON.parse(marker);
        if (data.documentToken === documentToken && operations.has(data.operationId) && ['input', 'click', 'scroll'].includes(data.kind)) {
          dispatch({ operationId: data.operationId, kind: data.kind, runToken, navigationCandidate: data.navigationCandidate === true });
          operations.get(data.operationId).target = el;
        }
      } catch { /* Page markers are hints; malformed ones grant no expectation. */ }
    }
    if (event && matchedEvents.has(event)) return matchedEvents.get(event);
    prune();
    const match = op => {
      if (event) {
        if (op.eventTypes && !op.eventTypes.has(event.type)) return null;
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
      // Moving agent focus commits the previous field's native change event.
      if (kind === 'input' && event?.type === 'change' && op.blurTarget === el) { const found = match(op); if (found) return found; }
      if (kind === 'scroll' && op.blurTarget === el && editable(el)) { const found = match(op); if (found) return found; }
      if (!op.kinds.has(kind)) continue;
      if (['wheel', 'touchmove'].includes(event?.type) && !op.nativeWheel) continue;
      const target = op.target || (op.focused ? document.activeElement : null);
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
  function signature(el) {
    if (ignored(el)) return '';
    const shown = visible(el);
    const rect = shown ? el.getBoundingClientRect() : {};
    const content = editable(el) ? '' : [...el.childNodes, ...(el.shadowRoot?.childNodes || [])].filter(node => node.nodeType === 3)
      .map(textSignature).reduce(([size, hash], [length, part, power]) =>
        [size + length, (Math.imul(hash, power) + part) >>> 0], [0, 0]);
    return JSON.stringify([shown, content, el.children.length + (el.shadowRoot?.children.length || 0), el.getAttribute('role'), el.getAttribute('aria-label'),
      el.getAttribute('aria-expanded'), el.getAttribute('aria-selected'), el.getAttribute('aria-checked'),
      el.getAttribute('aria-pressed'),
      el.getAttribute('popover'), popoverOpen(el),
      el.selected === true, el.defaultSelected === true,
      Number.isInteger(el.selectedIndex) ? el.selectedIndex : null,
      el.getAttribute('aria-hidden'), el.hasAttribute('open'), el.inert === true,
      el.getAttribute('aria-disabled'), el.disabled === true, el.readOnly === true, el.checked === true, el.validity?.valid !== false, Math.round((rect.width || 0) / 8), Math.round((rect.height || 0) / 8),
      Math.round(((rect.x || 0) + window.scrollX) / 8), Math.round(((rect.y || 0) + window.scrollY) / 8)]);
  }
  function seed(root, budget = { remaining: 600 }) {
    const nodes = root.querySelectorAll?.('*') || [];
    for (const el of nodes) {
      if (budget.remaining > 0) { budget.remaining--; signatures.set(el, signature(el)); }
      // Root discovery is cheap and must not share the layout-measurement cap.
      if (el.shadowRoot && !ignored(el)) observeRoot(el.shadowRoot, budget);
    }
  }
  function sampleDescendants(root, limit = 100) {
    const nodes = [];
    let node = root?.firstElementChild || null;
    while (node) {
      if (nodes.length === limit) return { nodes, exceeded: true };
      nodes.push(node);
      if (node.firstElementChild) {
        node = node.firstElementChild;
        continue;
      }
      while (node && node !== root && !node.nextElementSibling) node = node.parentElement;
      node = node && node !== root ? node.nextElementSibling : null;
    }
    return { nodes, exceeded: false };
  }
  function observeRoot(root, budget) {
    if (!root || roots.has(root) || !observer) return;
    roots.add(root);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['role', 'aria-label', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-disabled',
        'aria-hidden', 'hidden', 'disabled', 'readonly', 'checked', 'selected', 'open', 'popover', 'inert', 'class', 'style'] });
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
  function onMutations(records) {
    if (!active) return;
    let changed = false, source = 'page', target = '';
    const noteChange = (el, agentUserAt) => {
      // Attribute the marked input/write's synchronous handlers to that dispatch.
      // Later DOM writes stay observable, including writes on the same target.
      if ((Number.isFinite(agentUserAt) && lastUserAt <= agentUserAt) || (agentTurn && lastUserAt <= agentTurn.userAt)) return;
      changed = true;
      target ||= targetName(el);
      if (userTurn || (Date.now() - lastUserAt < 1500 && related(lastUserTarget, el))) source = 'user';
      else if (source !== 'user' && [...operations.values()].some(op => op.dispatched)) source = 'unknown';
    };
    const changes = [...records];
    for (const record of records) {
      if (record.type !== 'popover' && (record.type !== 'attributes' || !['class', 'style', 'hidden', 'aria-hidden', 'open', 'inert', 'selected'].includes(record.attributeName))) continue;
      if (ignored(record.target)) continue;
      if (record.target.getAnimations?.().some(animation => animation.playState === 'running')) continue;
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
      if (ignored(el) || (record.type === 'characterData' && editable(el))) continue;
      if (record.type === 'attributes' && ['class', 'style'].includes(record.attributeName)
          && el.getAnimations?.().some(animation => animation.playState === 'running')) continue;
      if (++measured > 300) {
        // The remaining records are intentionally uninspected. Invalidate the
        // prepared page conservatively so a later visible target cannot vanish
        // silently at the end of a large, same-task update.
        changed = true;
        if (source !== 'user') source = agentTurn && lastUserAt <= agentTurn.userAt ? 'agent' : 'unknown';
        target ||= targetName(el);
        break;
      }
      let identityChanged = (record.type === 'popover' && record.stateChanged)
        || (record.type === 'layout' && record.layoutChanged)
        || (record.type === 'shadow' && (visible(el) || signatures.get(el)?.startsWith('[true')));
      if (record.type === 'childList') {
        identityChanged = subtreeChanged(record, el);
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
      if (!identityChanged && (next === previous || (!visible(el) && !previous?.startsWith('[true')))) continue;
      noteChange(el, record.agentUserAt);
    }
    if (!changed) return;
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
            records.push({ type: 'layout', target: el, layoutChanged: true,
              agentUserAt: layoutAgentUserAt() });
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
    active = true; runToken = state.runToken; seq = 0; revision = 0; publishRevision();
    observer = new MutationObserver(onMutations);
    observeRoot(document);
    observeLayoutShifts();
    listen(document, 'webbrain-shadow-root-attached', event => {
      const path = event.composedPath();
      if (path.some(node => node instanceof Element && ignored(node))) return;
      const host = elementFor(event), root = host?.shadowRoot;
      if (!host?.isConnected || !root || roots.has(root)) return;
      observeRoot(root);
      onMutations([{ type: 'shadow', target: host }]);
    });
    listen(document, 'webbrain-agent-dom-dispatch', event => {
      try {
        const guard = JSON.parse(String(event.detail));
        if (guard.documentToken !== documentToken || guard.revision !== revision || !operations.has(guard.operationId)) return;
        const marker = { userAt: lastUserAt }; agentTurn = marker;
        setTimeout(() => { if (agentTurn === marker) agentTurn = null; }, 0);
      } catch { /* Only a current prepared operation can mark a DOM write. */ }
    });
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
      const marker = { userAt: op.userAt };
      agentTurn = marker;
      if (op.navigationCandidate && ['click', 'pointerdown'].includes(event.type)) {
        const link = event.composedPath().find(node => node instanceof Element && node.matches('a[href],area[href]'));
        const navigationTarget = (link?.getAttribute('target') || el?.form?.getAttribute('target')
          || (link && document.querySelector('base[target]')?.getAttribute('target')) || '').toLowerCase();
        send({ kind: 'activity', source: 'agent', operation: 'click',
          ...(navigationTarget === '_top' || (navigationTarget === '_parent' && window.parent === window.top)
            ? { navigationTarget: '_top' } : {}) });
      }
      // Native listeners have microtask checkpoints between callbacks. Keep this
      // exact input's attribution through its page handlers, until the next task.
      setTimeout(() => { if (agentTurn === marker) agentTurn = null; }, 0);
    };
    for (const name of ['click', 'input', 'beforeinput', 'change', 'keydown', 'pointerdown', 'pointermove']) listen(document, name, noteAgentTurn);
    listen(document, 'pointerdown', event => {
      const el = elementFor(event);
      if (!event.isTrusted || ignored(el) || expected('click', el, event)) return;
      pointerHeld = true; interact('activity', el);
    });
    listen(document, 'pointermove', event => {
      if (pointerHeld && event.isTrusted) {
        if (!event.buttons) pointerHeld = false;
        interact('activity', elementFor(event));
      }
    });
    for (const name of ['pointerup', 'pointercancel']) listen(document, name, event => {
      if (!pointerHeld || !event.isTrusted) return;
      pointerHeld = false; interact('activity', elementFor(event), { interacting: composing, completeGesture: true });
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
      if (ignored(el) || expected('input', el, event)
          || (el.matches?.('input[type="checkbox"],input[type="radio"],select,option') && expected('click', el, event))) return;
      if (event.isTrusted) interact('input', el);
      else { revision++; send({ kind: 'input', source: 'page', target: targetName(el) }); }
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
      // Key names identify scrolling and focus movement locally, never transmitted.
      if (editable(el)) interact('activity', el);
      else if (['Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interact('activity', el);
    });
    for (const name of ['wheel', 'touchmove']) listen(document, name, event => {
      const el = elementFor(event);
      if (event.isTrusted && !expected('scroll', el, event)) interact('activity', el);
    });
    const viewport = () => ({ width: innerWidth, height: innerHeight,
      visualWidth: window.visualViewport?.width ?? innerWidth, visualHeight: window.visualViewport?.height ?? innerHeight,
      scale: window.visualViewport?.scale ?? 1, offsetX: window.visualViewport?.offsetLeft ?? 0, offsetY: window.visualViewport?.offsetTop ?? 0 });
    lastViewport = JSON.stringify(viewport());
    const onResize = () => {
      const current = viewport(), key = JSON.stringify(current);
      if (!active || key === lastViewport) return;
      lastViewport = key; revision++;
      send({ kind: 'resize', source: window === window.top ? 'unknown' : 'page', target: 'viewport', viewport: current });
    };
    listen(window, 'resize', onResize);
    if (window.visualViewport) {
      listen(window.visualViewport, 'resize', onResize);
      listen(window.visualViewport, 'scroll', onResize);
    }
    listen(document, 'scroll', event => {
      const el = event.target === document ? document.documentElement : event.target;
      if (ignored(el) || expected('scroll', el)) return;
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
      if (pointerHeld || composing) { pointerHeld = false; composing = false; interact('activity', document.body, { interacting: false }); }
    });
    listen(window, 'pagehide', () => stop());
  }
  function stop() {
    active = false; runToken = ''; pointerHeld = false; composing = false;
    lastUserAt = 0; lastViewport = ''; userTurn = null; lastUserTarget = null; matchedEvents = new WeakMap(); nativeMarks = new WeakMap();
    document.documentElement?.removeAttribute(fenceAttribute);
    for (const el of nativeTargets) {
      el.removeAttribute?.('data-webbrain-native-action');
      el.removeAttribute?.('data-webbrain-native-target');
    }
    nativeTargets.clear();
    observer?.disconnect(); observer = null;
    layoutObserver?.disconnect(); layoutObserver = null;
    clearTimeout(domTimer); clearTimeout(scrollTimer); domTimer = null; scrollTimer = null; unreported = 0; pendingDOM = null; lastFeedbackDelivery = Promise.resolve();
    listeners.splice(0).forEach(remove => remove());
    operations.clear(); localOperation = null; agentTurn = null;
    roots = new WeakSet(); signatures = new WeakMap(); textSignatures = new WeakMap(); popoverTurns = new WeakMap();
  }
  async function requestState() {
    const generation = ++requestGeneration;
    try {
      const state = await api.runtime.sendMessage({ target: 'background', action: 'get_page_monitor_state', documentToken });
      if (generation === requestGeneration && !disposed) start(state);
    } catch { stop(); }
  }
  function prepare(params) {
    if (!active || params.runToken !== runToken) return;
    prune();
    const target = resolveTarget(params);
    const focusEligible = kindFor(params.tool) === 'input';
    const focusTarget = target || (focusEligible ? deepActiveElement() : null);
    const coordinateSensitive = Number.isFinite(params.x) && Number.isFinite(params.y);
    const coordinateHit = coordinateSensitive ? document.elementFromPoint(params.x, params.y) : null;
    const coordinateTarget = coordinateSensitive ? target || coordinateHit : null;
    const coordinateTargetAtPoint = !target || !coordinateHit || target === coordinateHit || target.contains?.(coordinateHit);
    operations.set(params.operationId, { ...params, target: target || focusTarget, focusTarget, focusEligible, kinds: new Set(),
      coordinateSensitive, coordinateTarget, coordinateHit, coordinateTargetAtPoint,
      coordinatePoint: coordinateSensitive ? { x: params.x, y: params.y } : null,
      coordinateRect: rectFor(coordinateTarget),
      until: Date.now() + 30000, dispatched: false, userAt: lastUserAt, preparedRevision: revision });
  }
  function dispatch(params) {
    if (!active || (params.runToken && params.runToken !== runToken)) return;
    const op = operations.get(params.operationId) || { operationId: params.operationId, userAt: lastUserAt };
    op.blurTarget ??= document.activeElement;
    op.target = resolveTarget(params) || (params.kind === 'input' ? op.focusTarget || deepActiveElement() : op.target);
    if (params.kind === 'input' && !op.focusTarget) op.focusTarget = op.target;
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
    operations.set(op.operationId, op);
  }
  function activatePreparedDispatch(params = {}) {
    const op = operations.get(params.operationId);
    const layoutChanged = coordinatePreparationShifted(op);
    if (!active || !op || layoutChanged || domTimer || unreported
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
  const localMutations = new Set(['click', 'click_ax', 'type', 'type_ax', 'set_field', 'set_checked', 'press_keys', 'scroll',
    'hover', 'drag_drop', 'patch_element', 'revert_patch', 'highlight_element', 'execute_js',
    'ax_prepare_field_for_trusted_type', 'ax_resolve_two_rects', 'ax_resolve_rect']);
  function beginContentAction(action, params = {}) {
    if (!active || !localMutations.has(action)) return () => {};
    const operationId = `local-${randomToken()}`;
    const previous = localOperation;
    prepare({ selector: params.selector, ref_id: params.ref_id, x: params.x, y: params.y,
      textMatch: action === 'click' ? params.text : undefined, tool: action, operationId, runToken });
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
    const layoutChanged = coordinatePreparationShifted(operations.get(localOperation.operationId));
    if (layoutChanged || domTimer || unreported || lastUserAt > localOperation.userAt || revision !== localOperation.revision) {
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
      if (msg.active) { void requestState().then(() => respond({ ready: true })); return true; }
      else if (!msg.runToken || msg.runToken === runToken) { requestGeneration++; stop(); respond({ ready: true }); }
    } else if (msg.action === 'page_monitor_prepare') { prepare(msg.params || {}); respond({ ready: true }); }
    else if (msg.action === 'page_monitor_dispatch') {
      const params = msg.params || {};
      const prepared = operations.get(params.operationId);
      const layoutChanged = !params.release && active && coordinatePreparationShifted(prepared);
      if (!params.release && active && (layoutChanged || domTimer || unreported || (prepared && prepared.preparedRevision !== revision)
          || (params.documentToken && (params.documentToken !== documentToken || params.documentRevision !== revision)))) {
        if (domTimer) {
          clearTimeout(domTimer); domTimer = null; const observation = pendingDOM; pendingDOM = null;
          if (observation) send(observation);
        }
        void lastFeedbackDelivery.then(() => respond({ ready: false, pageFeedbackPending: true }));
        return true;
      }
      dispatch(params); publishRevision();
      respond({ ready: true, ...(active && params.runToken === runToken ? { guard: {
        documentToken, revision, operationId: params.operationId, navigationCandidate: params.navigationCandidate !== false,
      } } : {}) });
    }
    else if (msg.action === 'page_monitor_finish') {
      const op = operations.get(msg.params?.operationId);
      if (op) op.until = Date.now() + 200;
      respond({ ready: true });
    }
  };
  api.runtime.onMessage.addListener(onMessage);
  window.__wbPageMonitor = { beginContentAction, beforeLocalDispatch, withLocalDispatch, dispatch, activatePreparedDispatch, registerDecoration,
    get active() { return active; },
    get disposed() { return disposed; },
    dispose() { disposed = true; requestGeneration++; stop(); api.runtime.onMessage.removeListener?.(onMessage); } };
  void requestState();
  // A document restored from BFCache needs a fresh run/document handshake.
  window.addEventListener('pageshow', () => { if (!disposed && !active) void requestState(); });
})();
