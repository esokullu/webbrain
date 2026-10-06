/** Captures trusted, value-free user actions while /teach is active. */
(() => {
  if (window.top !== window || window.__webbrainTeacherCaptureInstalled) return;
  window.__webbrainTeacherCaptureInstalled = true;

  const INDICATOR_ID = 'webbrain-teacher-indicator';
  const recordedFields = new WeakMap();
  const dirtyFields = new WeakSet();
  let active = false;
  let sessionName = '';
  let pendingEnter = null;

  function clean(value, max = 240) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function safeHref(element) {
    const raw = element?.getAttribute?.('href');
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }

  function inferredRole(element) {
    const exported = window.__wb_ax_role?.(element);
    if (exported) return clean(exported, 40);
    const explicit = clean(element?.getAttribute?.('role'), 40);
    if (explicit) return explicit;
    const tag = element?.tagName?.toLowerCase?.() || '';
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = clean(element.getAttribute('type'), 40).toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit'].includes(type)) return 'button';
      return 'textbox';
    }
    return 'generic';
  }

  function labelFor(element) {
    const labels = Array.from(element?.labels || [])
      .map((label) => clean(label.innerText || label.textContent, 120))
      .filter(Boolean);
    if (labels.length) return labels.join(' ').slice(0, 120);
    return clean(element?.closest?.('label')?.innerText, 120);
  }

  function semanticTarget(element, { field = false } = {}) {
    if (!(element instanceof Element)) return null;
    const target = {
      role: inferredRole(element),
      name: field ? '' : clean(window.__wb_ax_name?.(element), 120),
      label: field && element.matches('[contenteditable]') ? '' : labelFor(element),
      id: clean(element.getAttribute('id'), 100),
      fieldName: clean(element.getAttribute('name'), 100),
      type: clean(element.getAttribute('type'), 40),
      ariaLabel: clean(element.getAttribute('aria-label'), 120),
      placeholder: clean(element.getAttribute('placeholder'), 120),
      href: safeHref(element),
    };
    return Object.fromEntries(Object.entries(target).filter(([, item]) => item));
  }

  function isTeacherUiEvent(event) {
    return event.composedPath?.().some((node) => node?.id === INDICATOR_ID) === true;
  }

  function actionableFromEvent(event) {
    const source = event.composedPath?.().find((node) => node instanceof Element);
    if (!source) return null;
    const direct = source.closest?.([
      'input', 'textarea', 'select', 'button', 'a[href]', 'label', 'summary',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[contenteditable]:not([contenteditable="false"])', '[onclick]',
    ].join(','));
    if (direct?.tagName === 'LABEL' && direct.control) return direct.control;
    return direct;
  }

  function isCheckable(element) {
    const type = clean(element?.getAttribute?.('type'), 40).toLowerCase();
    const role = clean(element?.getAttribute?.('role'), 40).toLowerCase();
    return ['checkbox', 'radio'].includes(type) || ['checkbox', 'radio'].includes(role);
  }

  function isField(element) {
    if (!(element instanceof Element)) return false;
    if (element.matches('textarea,select,[contenteditable]:not([contenteditable="false"])')) return true;
    if (!element.matches('input')) return false;
    const type = clean(element.getAttribute('type') || 'text', 40).toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(type);
  }

  function isSubmitControl(element) {
    if (!element?.matches?.('button,input')) return false;
    const type = clean(element.getAttribute('type'), 40).toLowerCase();
    return element.matches('button') ? (!type || type === 'submit') : ['submit', 'image'].includes(type);
  }

  function formFor(element) {
    return element?.form || element?.closest?.('form') || null;
  }

  function sendAction(action) {
    if (!active || !action) return;
    try {
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'record_teacher_action',
        teacherAction: { ...action, pageUrl: location.href },
      }).catch?.(() => {});
    } catch { /* extension context may be invalidated during navigation */ }
  }

  function activeFieldAction() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    if (!dirtyFields.has(element) || !isField(element)) return null;
    dirtyFields.delete(element);
    return { kind: 'field', target: semanticTarget(element, { field: true }), pageUrl: location.href };
  }

  function updateIndicator() {
    document.getElementById(INDICATOR_ID)?.remove();
    if (!active || !document.documentElement) return;
    const indicator = document.createElement('div');
    indicator.id = INDICATOR_ID;
    (window.__wbPageMonitorDecorations ??= new WeakSet()).add(indicator);
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    indicator.textContent = `● WebBrain Teach${sessionName ? ` · ${sessionName}` : ''}`;
    Object.assign(indicator.style, {
      position: 'fixed', left: '12px', bottom: '12px', zIndex: '2147483647',
      padding: '7px 10px', borderRadius: '999px', background: '#241b3d',
      color: '#f7f3ff', border: '1px solid #8b5cf6', font: '600 12px system-ui',
      boxShadow: '0 4px 18px rgba(0,0,0,.3)', pointerEvents: 'none',
    });
    document.documentElement.appendChild(indicator);
  }

  function setState(state) {
    active = state?.active === true;
    sessionName = active ? clean(state?.name, 80) : '';
    updateIndicator();
  }

  document.addEventListener('click', (event) => {
    if (!active || !event.isTrusted || isTeacherUiEvent(event)) return;
    const element = actionableFromEvent(event);
    if (!element) return;
    const keyboardSubmitClick = (
      isSubmitControl(element)
      && event.detail === 0
      && pendingEnter?.form
      && formFor(element) === pendingEnter.form
      && Date.now() - pendingEnter.at < 500
    );
    if (pendingEnter && !keyboardSubmitClick) pendingEnter = null;
    if (isField(element) || keyboardSubmitClick) return;
    if (isCheckable(element)) {
      queueMicrotask(() => {
        if (!active) return;
        const checked = element.matches('input')
          ? element.checked === true
          : element.getAttribute('aria-checked') === 'true';
        sendAction({ kind: 'checked', checked, target: semanticTarget(element) });
      });
      return;
    }
    sendAction({ kind: 'click', target: semanticTarget(element) });
  }, true);

  document.addEventListener('input', (event) => {
    if (!active || !event.isTrusted) return;
    const element = actionableFromEvent(event);
    if (isField(element)) dirtyFields.add(element);
  }, true);

  document.addEventListener('change', (event) => {
    if (!active || !event.isTrusted) return;
    const element = actionableFromEvent(event);
    if (!isField(element)) return;
    if (Date.now() - (recordedFields.get(element) || 0) < 1000) return;
    dirtyFields.delete(element);
    sendAction({ kind: 'field', target: semanticTarget(element, { field: true }) });
  }, true);

  document.addEventListener('focusout', (event) => {
    if (!active || !event.isTrusted) return;
    const element = actionableFromEvent(event);
    if (!element?.matches?.('[contenteditable]:not([contenteditable="false"])')) return;
    if (!dirtyFields.has(element)) return;
    dirtyFields.delete(element);
    sendAction({ kind: 'field', target: semanticTarget(element, { field: true }) });
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!active || !event.isTrusted) return;
    if (event.key !== 'Enter' || event.repeat) {
      pendingEnter = null;
      return;
    }
    const element = actionableFromEvent(event);
    if (!isField(element) || element.matches('textarea,[contenteditable]')) return;
    const action = { kind: 'field', target: semanticTarget(element, { field: true }) };
    const at = Date.now();
    dirtyFields.delete(element);
    recordedFields.set(element, at);
    pendingEnter = { element, form: formFor(element), action, at };
    sendAction(action);
  }, true);

  document.addEventListener('submit', (event) => {
    if (!active || !event.isTrusted) return;
    const pending = pendingEnter;
    if (!pending?.form || event.target !== pending.form || Date.now() - pending.at >= 1000) return;
    // Wait until submit propagation finishes so page handlers have a chance to
    // cancel autocomplete/custom Enter behavior before we mark it replayable.
    queueMicrotask(() => {
      if (!active || event.defaultPrevented || pendingEnter !== pending) return;
      pendingEnter = null;
      recordedFields.set(pending.element, Date.now());
      sendAction({ ...pending.action, submit: true });
    });
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'content') return;
    if (message.action === 'teacher_state') {
      setState(message.state);
      sendResponse({ teacherCaptureReady: true });
    }
    if (message.action === 'flush_teacher_capture') {
      sendResponse({ teacherAction: active ? activeFieldAction() : null });
    }
  });
  try {
    chrome.runtime.sendMessage({ target: 'background', action: 'get_teacher_mode' }, (response) => {
      if (!chrome.runtime.lastError) setState(response?.session);
    });
  } catch { /* ignore unsupported pages */ }
})();
