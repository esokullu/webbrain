/**
 * Floating WebBrain shortcut for selected page text.
 *
 * A small bar (Translate | Explain | Proofread | More…) appears next to the
 * selection. Translate, Explain and Proofread answer in a card on the page;
 * More… opens the full popup, whose actions and question box continue in the
 * side panel, and so does a follow-up typed in a card.
 *
 * Runs only in the top frame. The UI is isolated in a closed Shadow DOM;
 * the background owns prompt construction and untrusted-content wrapping.
 */
(function () {
  const shortcutConfig = globalThis.__webbrainSelectionShortcutConfig;
  if ((window.top !== window && shortcutConfig?.allowNestedFrame !== true)
      || window.__webbrainSelectionShortcutInjected) return;
  window.__webbrainSelectionShortcutInjected = true;

  const api = globalThis.browser || globalThis.chrome;
  if (!api?.runtime || !api?.storage?.local) return;

  const STORAGE_KEY = 'selectionShortcutEnabled';
  const LOCALE_STORAGE_KEY = 'wbLocale';
  const SUBMIT_MESSAGE = typeof shortcutConfig?.submitMessage === 'string'
    && shortcutConfig.submitMessage.trim()
    ? shortcutConfig.submitMessage.trim()
    : 'WB_SELECTION_SHORTCUT_SUBMIT';
  // Read when a request is sent, not once at load: the PDF viewer keeps its window id
  // current while its tab moves between windows.
  const currentSubmitFields = () => shortcutConfig?.submitFields
    && typeof shortcutConfig.submitFields === 'object'
    && !Array.isArray(shortcutConfig.submitFields)
    ? { ...shortcutConfig.submitFields }
    : {};
  const LOCALIZATION_MESSAGE = 'WB_SELECTION_SHORTCUT_LOCALIZATION';
  const INLINE_MESSAGE = 'WB_SELECTION_SHORTCUT_INLINE';
  const INLINE_CANCEL_MESSAGE = 'WB_SELECTION_SHORTCUT_INLINE_CANCEL';
  const GAP = 8;
  const TOOLBAR_HEIGHT = 38;
  const POPUP_WIDTH = 316;
  const CARD_WIDTH = 420;
  // The room a card should have on one side of the selection before it is
  // placed there; with less on both sides it takes the larger side and scrolls.
  const CARD_PREFERRED_HEIGHT = 300;
  // Keep in step with INLINE_SELECTION_MAX_CHARS in context-menu-storage.js.
  // Longer selections are read better in the side panel than in a small card.
  const INLINE_MAX_CHARS = 4000;
  // Keep in step with INLINE_ANSWER_MAX_CHARS in context-menu-storage.js. An answer is never
  // held beyond it, so a follow-up or a continuation carries the card's text whole.
  const INLINE_ANSWER_MAX_CHARS = 64000;
  const INLINE_ACTIONS = Object.freeze(['translate', 'explain', 'proofread']);
  const MAX_SELECTION_HIGHLIGHT_RECTS = 200;
  const TRANSLATION_LANGUAGES = Object.freeze([
    'en', 'es', 'fr', 'tr', 'zh', 'ru', 'uk', 'ar',
    'ja', 'ko', 'id', 'th', 'ms', 'tl', 'pl', 'he',
    'hi', 'pt', 'vi', 'bn', 'fa', 'nl', 'de',
  ]);
  const LOCALIZATION_KEYS = Object.freeze([
    'askSelection', 'askHighlightedText', 'openChat', 'summarize', 'explain', 'quiz',
    'proofread', 'humanize', 'translate', 'translateTo', 'askAbout',
    'askQuestion', 'sendQuestion', 'includePageContext', 'hideShortcut', 'sentManual', 'sendFailed',
    'more', 'askFollowUp', 'sendFollowUp', 'working', 'autoDetect', 'inlineFailed', 'retry',
    'cutOff', 'continueInPanel',
  ]);
  // English copy for strings the card shows before the localization bundle
  // arrives (or when the background cannot be reached).
  const DEFAULT_STRINGS = Object.freeze({
    translateTo: 'Translate to',
    autoDetect: 'Auto-detect',
    inlineFailed: 'Could not get an answer.',
    cutOff: 'This answer was cut off.',
    continueInPanel: 'Continue in side panel',
  });
  // Language codes the browser's detector reports that differ from ours.
  const DETECTED_LANGUAGE_ALIASES = Object.freeze({ iw: 'he', fil: 'tl', in: 'id' });

  let enabled = true;
  let suppressed = false;
  let submitting = false;
  let interacting = false;
  let snapshot = null;
  let host = null;
  let shadow = null;
  let highlightLayer = null;
  let shortcut = null;
  let moreButton = null;
  let popup = null;
  let question = null;
  let includePageContext = null;
  let sendButton = null;
  let card = null;
  let cardParts = null;
  let cardState = null;
  let cardSide = 'above';
  let cardOpener = null;
  let cardRequestId = 0;
  // Id of the model call the card is waiting on, so closing or redoing the card can cancel it.
  let cardJobId = '';
  let toolbarLeft = 0;
  let interfaceLanguage = resolveInterfaceLanguage('');
  let localization = null;
  let localizationRequestId = 0;
  let toast = null;
  let toastTimer = null;
  let selectionTimer = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function isTextField(element) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  }

  function isSupportedTranslationLanguage(value) {
    return TRANSLATION_LANGUAGES.includes(value);
  }

  function serializeRect(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  function collectVisibleHighlightRects(rects) {
    const visibleRects = [];
    for (const rect of rects) {
      const isVisible = rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth;
      if (!isVisible) continue;
      visibleRects.push(rect);
      if (visibleRects.length >= MAX_SELECTION_HIGHLIGHT_RECTS) break;
    }
    return visibleRects;
  }

  function resolveInterfaceLanguage(value) {
    const preferred = String(value || '').trim().toLowerCase();
    if (isSupportedTranslationLanguage(preferred)) return preferred;
    const browserLanguage = String(navigator.language || 'en').slice(0, 2).toLowerCase();
    return isSupportedTranslationLanguage(browserLanguage) ? browserLanguage : 'en';
  }

  function str(key) {
    return localization?.strings?.[key] || DEFAULT_STRINGS[key] || '';
  }

  function languageName(code) {
    try {
      return new Intl.DisplayNames([interfaceLanguage], { type: 'language' }).of(code) || '';
    } catch {
      return '';
    }
  }

  function baseLanguage(code) {
    const base = String(code || '').trim().toLowerCase().split('-')[0];
    return DETECTED_LANGUAGE_ALIASES[base] || base;
  }

  // The browser's own detector (no network, no model call). Resolves '' when
  // it is missing, unsure, or slow, so Translate still works without it.
  function detectSourceLanguage(text) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), 600);
      const finish = (result) => {
        clearTimeout(timer);
        const top = result?.isReliable ? String(result.languages?.[0]?.language || '') : '';
        resolve(top.toLowerCase() === 'und' ? '' : top);
      };
      try {
        const detect = api.i18n?.detectLanguage;
        if (typeof detect !== 'function') {
          finish(null);
        } else if (globalThis.browser?.i18n === api.i18n) {
          // Firefox: promise API.
          Promise.resolve(detect.call(api.i18n, text)).then(finish, () => finish(null));
        } else {
          detect.call(api.i18n, text, finish);
        }
      } catch {
        finish(null);
      }
    });
  }

  function normalizeLocalization(response) {
    if (!response?.ok || !response.strings || typeof response.strings !== 'object') return null;
    const strings = {};
    for (const key of LOCALIZATION_KEYS) {
      const value = response.strings[key];
      if (typeof value !== 'string' || !value.trim()) return null;
      strings[key] = value;
    }
    return {
      locale: resolveInterfaceLanguage(response.locale),
      dir: response.dir === 'rtl' ? 'rtl' : 'ltr',
      strings,
    };
  }

  function applyLocalization() {
    if (!shadow) return;
    if (!localization) {
      // The language bundle did not load. The card still runs on the built-in English
      // text, and its target list has to exist too: Translate asks for a target when the
      // text is already in the interface language.
      populateTargetLanguages();
      return;
    }
    const strings = localization.strings;
    host.lang = localization.locale;
    host.dir = localization.dir;
    shortcut.setAttribute('aria-label', strings.askHighlightedText);
    popup.setAttribute('aria-label', strings.askHighlightedText);
    for (const action of ['summarize', 'quiz', 'humanize']) {
      const label = shadow.querySelector(`[data-action="${action}"] .action-label`);
      if (label) label.textContent = strings[action];
    }
    for (const action of INLINE_ACTIONS) {
      const label = shadow.querySelector(`[data-inline="${action}"] .bar-label`);
      if (label) label.textContent = strings[action];
    }
    shadow.querySelector('[data-more] .bar-label').textContent = strings.more;
    question.setAttribute('aria-label', strings.askQuestion);
    question.placeholder = strings.askQuestion;
    sendButton.setAttribute('aria-label', strings.sendQuestion);
    const contextOptionLabel = shadow.querySelector('.context-option span');
    if (contextOptionLabel) contextOptionLabel.textContent = strings.includePageContext;
    const hideButton = shadow.querySelector('.hide');
    if (hideButton) hideButton.textContent = strings.hideShortcut;
    cardParts.followUp.placeholder = strings.askFollowUp;
    cardParts.followUp.setAttribute('aria-label', strings.askFollowUp);
    cardParts.send.setAttribute('aria-label', strings.sendFollowUp);
    cardParts.target.setAttribute('aria-label', strings.translateTo);
    cardParts.skeleton.setAttribute('aria-label', strings.working);
    cardParts.retry.textContent = strings.retry;
    cardParts.cutText.textContent = strings.cutOff;
    cardParts.continueButton.textContent = strings.continueInPanel;
    populateTargetLanguages();
    renderCard();
    // Label widths change with the language, and the bar is centered on the selection.
    if (snapshot && !shortcut.hidden) positionShortcut();
  }

  async function refreshLocalization(value) {
    interfaceLanguage = resolveInterfaceLanguage(value);
    const requestId = ++localizationRequestId;
    try {
      const response = await api.runtime.sendMessage({
        type: LOCALIZATION_MESSAGE,
        locale: interfaceLanguage,
      });
      if (requestId !== localizationRequestId) return;
      const next = normalizeLocalization(response);
      if (!next) return;
      interfaceLanguage = next.locale;
      localization = next;
      applyLocalization();
    } catch { /* English markup remains the offline fallback. */ }
  }

  function readSelection() {
    if (!enabled || suppressed || submitting || isTextField(document.activeElement)) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (!text) return null;

    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (ancestor?.closest?.('input, textarea')) return null;

    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    const visibleRects = collectVisibleHighlightRects(rects);
    const rect = visibleRects[0] || rects[0] || range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return {
      text,
      rect: serializeRect(rect),
      rects: (visibleRects.length ? visibleRects : [rect]).map(serializeRect),
    };
  }

  function ensureSurface() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = 'webbrain-selection-shortcut-host';
    (window.__wbPageMonitorDecorations ??= new WeakSet()).add(host);
    host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;pointer-events:none;z-index:2147483647';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host {
          --accent:#6c63ff; --accent-strong:#554cf2; --bg:#fff;
          --hover:#f4f3ff; --text:#171722; --muted:#666679; --border:#dedee9;
          --field:#f5f5f7; --field-strong:#e8e8ee;
          --shadow:0 18px 50px rgba(24,20,70,.22),0 3px 12px rgba(24,20,70,.12);
          color-scheme:light dark;
        }
        * { box-sizing:border-box; }
        button,textarea,input,select { font:inherit; }
        [hidden] { display:none !important; }
        .selection-highlight {
          position:fixed; border-radius:3px; pointer-events:none;
          background:rgba(108,99,255,.3); box-shadow:inset 0 0 0 1px rgba(85,76,242,.18);
        }
        .shortcut {
          position:fixed; display:flex; align-items:center; max-width:calc(100vw - 16px);
          overflow:hidden; padding:4px; border:1px solid var(--border); border-radius:12px;
          background:var(--bg); color:var(--text);
          box-shadow:0 10px 26px rgba(35,30,95,.2),0 2px 7px rgba(35,30,95,.12);
          pointer-events:auto; white-space:nowrap;
          font:14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        .bar-item {
          flex:0 1 auto; min-width:0; padding:8px 12px; border:0; border-radius:8px; background:transparent;
          color:inherit; font-weight:550; cursor:pointer;
        }
        .bar-item:hover { background:var(--hover); }
        .bar-item[data-more] { flex:none; }
        .bar-label { display:block; overflow:hidden; text-overflow:ellipsis; }
        /* On a narrow viewport the bar tightens, then shortens the other labels, so More stays on screen. */
        @media (max-width:420px) { .bar-item { padding:8px 8px; } }
        .bar-sep { flex:0 0 1px; width:1px; height:16px; background:var(--border); }
        .popup {
          position:fixed; width:min(${POPUP_WIDTH}px,calc(100vw - 16px));
          max-height:calc(100vh - 16px); overflow-y:auto; overscroll-behavior:contain;
          padding:12px;
          border:1px solid var(--border); border-radius:16px; background:var(--bg);
          color:var(--text); box-shadow:var(--shadow); pointer-events:auto;
          font:15px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        .actions { display:grid; grid-template-columns:minmax(0,1fr); gap:2px; }
        .action,.hide {
          border:0; border-radius:10px; background:transparent;
          color:var(--text); text-align:start; cursor:pointer;
        }
        .action {
          width:100%; min-width:0; display:flex; align-items:center; gap:9px;
          padding:10px 12px; font-size:15px; font-weight:550;
        }
        .action-icon {
          width:17px; height:17px; flex:0 0 17px; color:var(--accent);
          fill:none; stroke:currentColor; stroke-width:1.7;
          stroke-linecap:round; stroke-linejoin:round;
        }
        .action-label { min-width:0; }
        .action:hover .action-icon { color:var(--accent-strong); }
        .action:hover,.hide:hover { background:var(--hover); }
        .question-wrap { position:relative; margin-top:8px; }
        textarea {
          display:block; width:100%; min-height:76px; max-height:150px; resize:vertical;
          padding:10px 42px 10px 11px; border:1px solid var(--border); border-radius:12px;
          background:var(--bg); color:var(--text); font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        textarea::placeholder { color:var(--muted); }
        textarea:focus { border-color:var(--accent); outline:none; }
        .send {
          position:absolute; right:8px; bottom:8px; width:28px; height:28px;
          display:grid; place-items:center; padding:0; border:0; border-radius:9px;
          background:var(--accent); color:#fff; cursor:pointer;
        }
        .send:hover:not(:disabled) { background:var(--accent-strong); }
        .send:disabled { opacity:.38; cursor:default; }
        .send svg { width:15px; height:15px; }
        .context-option {
          display:flex; align-items:flex-start; gap:8px; margin:8px 2px 2px;
          color:var(--muted); font-size:13px; line-height:1.35; cursor:pointer;
        }
        .context-option input { margin:2px 0 0; accent-color:var(--accent); }
        .divider { height:1px; margin:10px 0 4px; background:var(--border); }
        .hide-row { display:flex; }
        .hide {
          width:auto; margin-left:auto; padding:5px 8px;
          color:var(--muted); font-size:12px; line-height:1.25;
        }
        .card {
          position:fixed; width:min(${CARD_WIDTH}px,calc(100vw - 16px)); display:flex; flex-direction:column;
          padding:14px; overflow:hidden; border:1px solid var(--border); border-radius:18px;
          background:var(--bg); color:var(--text); box-shadow:var(--shadow); pointer-events:auto;
          font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        .card:focus { outline:none; }
        .card-lang { display:flex; flex:none; align-items:center; gap:10px; margin-bottom:12px; }
        .lang-source,.lang-target {
          min-width:0; padding:9px 14px; border:0; border-radius:12px; background:var(--field);
          color:var(--muted); font-size:15px; line-height:1.3;
        }
        .lang-source { flex:1 1 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .lang-arrow { flex:none; width:18px; height:18px; color:var(--muted); }
        .lang-select-wrap { position:relative; flex:1 1 0; min-width:0; }
        .lang-target {
          display:block; width:100%; appearance:none; -webkit-appearance:none; -moz-appearance:none;
          padding-inline-end:36px; color:var(--text); cursor:pointer; text-overflow:ellipsis;
        }
        .lang-chevron {
          position:absolute; inset-inline-end:12px; top:50%; width:16px; height:16px;
          transform:translateY(-50%); color:var(--muted); pointer-events:none;
        }
        .card-quote {
          flex:none; max-height:6em; margin:0 0 12px; padding:2px 0; padding-inline-start:12px;
          overflow-y:auto; border-inline-start:3px solid var(--border); color:var(--muted);
          font-size:14px; line-height:1.45; overflow-wrap:anywhere; white-space:pre-wrap;
        }
        .card-result { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; overflow-wrap:anywhere; }
        .card-result.fade {
          -webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 32px),transparent);
          mask-image:linear-gradient(to bottom,#000 calc(100% - 32px),transparent);
        }
        .card-text.plain { white-space:pre-wrap; }
        .card-text p { margin:0 0 .6em; }
        .card-text ul,.card-text ol { margin:0 0 .6em; padding-inline-start:1.3em; }
        .card-text li { margin:.15em 0; }
        .card-text > :last-child { margin-bottom:0; }
        .card-text code {
          padding:1px 6px; border-radius:6px; background:var(--field);
          font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        }
        .card-skeleton i {
          display:block; height:12px; margin:9px 0; border-radius:6px; background:var(--field-strong);
          animation:wb-pulse 1.2s ease-in-out infinite;
        }
        .card-skeleton i:nth-child(1) { width:92%; }
        .card-skeleton i:nth-child(2) { width:78%; animation-delay:.12s; }
        .card-skeleton i:nth-child(3) { width:54%; animation-delay:.24s; }
        @keyframes wb-pulse { 50% { opacity:.45; } }
        .card-error { display:flex; flex-direction:column; align-items:flex-start; gap:6px; }
        .card-error-detail { color:var(--muted); font-size:13px; line-height:1.4; }
        .card-retry {
          padding:6px 12px; border:1px solid var(--border); border-radius:10px; background:transparent;
          color:var(--text); font-size:14px; font-weight:550; cursor:pointer;
        }
        .card-retry:hover { background:var(--hover); }
        .card-cut {
          display:flex; flex:none; flex-wrap:wrap; align-items:center; gap:6px 10px; margin-top:10px;
          color:var(--muted); font-size:13px; line-height:1.4;
        }
        .card-notice { flex:none; margin-top:10px; color:var(--muted); font-size:13px; line-height:1.4; }
        .card-continue {
          padding:5px 11px; border:1px solid var(--border); border-radius:10px; background:transparent;
          color:var(--text); font-size:13px; font-weight:550; cursor:pointer;
        }
        .card-continue:hover { background:var(--hover); }
        .followup {
          display:flex; flex:none; align-items:center; gap:8px; margin-top:12px;
          padding:5px 5px 5px 14px; border-radius:16px; background:var(--field);
        }
        .followup:focus-within { box-shadow:0 0 0 2px rgba(108,99,255,.34); }
        .followup-input {
          flex:1 1 auto; min-width:0; padding:6px 0; border:0; outline:none; background:transparent;
          color:var(--text); font-size:15px; line-height:1.4;
        }
        .followup-input::placeholder { color:var(--muted); }
        .followup-send {
          display:grid; flex:none; place-items:center; width:34px; height:34px; padding:0;
          border:0; border-radius:50%; background:var(--field-strong); color:var(--muted); cursor:default;
        }
        .followup-send:not(:disabled) { background:var(--accent); color:#fff; cursor:pointer; }
        .followup-send:not(:disabled):hover { background:var(--accent-strong); }
        .followup-send svg { width:16px; height:16px; }
        :host([dir="rtl"]) .lang-arrow,:host([dir="rtl"]) .followup-send svg { transform:scaleX(-1); }
        .bar-item:focus-visible,.action:focus-visible,.hide:focus-visible,.send:focus-visible,textarea:focus-visible,.context-option input:focus-visible,
        .lang-target:focus-visible,.card-retry:focus-visible,.followup-send:focus-visible {
          outline:3px solid rgba(108,99,255,.34); outline-offset:2px;
        }
        .bar-item:focus-visible { outline-offset:-2px; }
        .toast {
          position:fixed; left:50%; bottom:22px; max-width:min(440px,calc(100vw - 24px));
          transform:translateX(-50%); padding:10px 14px; border:1px solid var(--border);
          border-radius:12px; background:var(--bg); color:var(--text); box-shadow:var(--shadow);
          font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          pointer-events:none;
        }
        @media (prefers-color-scheme:dark) {
          :host {
            --bg:#20202a; --hover:#2d2c42; --text:#f5f4ff; --muted:#b5b3c7;
            --border:#444355; --field:#2a2a36; --field-strong:#383748;
            --shadow:0 18px 54px rgba(0,0,0,.46),0 3px 12px rgba(0,0,0,.28);
          }
        }
        @media (prefers-reduced-motion:reduce) { .card-skeleton i { animation:none; } }
      </style>
      <div class="selection-highlights" aria-hidden="true"></div>
      <div class="shortcut" role="toolbar" aria-label="Ask WebBrain about this" hidden>
        <button class="bar-item" type="button" data-inline="translate"><span class="bar-label">Translate</span></button>
        <span class="bar-sep" aria-hidden="true"></span>
        <button class="bar-item" type="button" data-inline="explain"><span class="bar-label">Explain</span></button>
        <span class="bar-sep" aria-hidden="true"></span>
        <button class="bar-item" type="button" data-inline="proofread"><span class="bar-label">Proofread</span></button>
        <span class="bar-sep" aria-hidden="true"></span>
        <button class="bar-item" type="button" data-more aria-haspopup="dialog" aria-expanded="false"><span class="bar-label">More…</span></button>
      </div>
      <div class="popup" role="dialog" aria-label="Ask WebBrain about this" hidden>
        <div class="main-view">
          <div class="actions">
            <button class="action" type="button" data-action="summarize">
              <svg class="action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                <path d="M4 5h12M4 9h9M4 13h12M4 17h7"/>
              </svg>
              <span class="action-label">Summarize</span>
            </button>
            <button class="action" type="button" data-action="quiz">
              <svg class="action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                <circle cx="10" cy="10" r="7"/>
                <path d="M7.8 7.8a2.5 2.5 0 0 1 4.8 1c0 1.8-2.6 2.1-2.6 3.7M10 15.5h.01"/>
              </svg>
              <span class="action-label">Quiz me</span>
            </button>
            <button class="action" type="button" data-action="humanize">
              <svg class="action-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                <circle cx="10" cy="7" r="2.5"/>
                <path d="M4.8 16.5C5.6 13.5 7.4 12 10 12s4.4 1.5 5.2 4.5"/>
              </svg>
              <span class="action-label">Humanize</span>
            </button>
          </div>
          <div class="question-wrap">
            <textarea maxlength="2000" rows="3" aria-label="Ask WebBrain a question" placeholder="Ask WebBrain…"></textarea>
            <button class="send" type="button" aria-label="Send question" disabled>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <label class="context-option">
            <input type="checkbox" checked>
            <span>Include page &amp; conversation context</span>
          </label>
          <div class="divider"></div>
          <div class="hide-row">
            <button class="hide" type="button">Hide this</button>
          </div>
        </div>
      </div>
      <div class="card" role="dialog" tabindex="-1" hidden>
        <div class="card-lang" hidden>
          <span class="lang-source">Auto-detect</span>
          <svg class="lang-arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 10h13M12 6l4 4-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="lang-select-wrap">
            <select class="lang-target" aria-label="Translate to"></select>
            <svg class="lang-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </div>
        <blockquote class="card-quote" hidden></blockquote>
        <div class="card-result" aria-live="polite">
          <div class="card-skeleton" role="status" aria-label="Working…"><i></i><i></i><i></i></div>
          <div class="card-text" hidden></div>
          <div class="card-error" hidden>
            <span class="card-error-text">Could not get an answer.</span>
            <span class="card-error-detail" hidden></span>
            <button class="card-retry" type="button">Try again</button>
          </div>
        </div>
        <div class="card-cut" hidden>
          <span class="card-cut-text">This answer was cut off.</span>
          <button class="card-continue" type="button">Continue in side panel</button>
        </div>
        <div class="card-notice" role="status" hidden></div>
        <div class="followup">
          <input class="followup-input" type="text" maxlength="2000" aria-label="Ask a follow-up" placeholder="Ask a follow-up">
          <button class="followup-send" type="button" aria-label="Send follow-up" disabled>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="toast" role="status" aria-live="polite" hidden></div>
    `;

    highlightLayer = shadow.querySelector('.selection-highlights');
    shortcut = shadow.querySelector('.shortcut');
    moreButton = shadow.querySelector('[data-more]');
    popup = shadow.querySelector('.popup');
    question = shadow.querySelector('textarea');
    includePageContext = shadow.querySelector('.context-option input');
    sendButton = shadow.querySelector('.send');
    card = shadow.querySelector('.card');
    cardParts = {
      lang: shadow.querySelector('.card-lang'),
      source: shadow.querySelector('.lang-source'),
      target: shadow.querySelector('.lang-target'),
      quote: shadow.querySelector('.card-quote'),
      result: shadow.querySelector('.card-result'),
      skeleton: shadow.querySelector('.card-skeleton'),
      text: shadow.querySelector('.card-text'),
      error: shadow.querySelector('.card-error'),
      errorText: shadow.querySelector('.card-error-text'),
      errorDetail: shadow.querySelector('.card-error-detail'),
      retry: shadow.querySelector('.card-retry'),
      cut: shadow.querySelector('.card-cut'),
      cutText: shadow.querySelector('.card-cut-text'),
      continueButton: shadow.querySelector('.card-continue'),
      notice: shadow.querySelector('.card-notice'),
      followUp: shadow.querySelector('.followup-input'),
      send: shadow.querySelector('.followup-send'),
    };
    toast = shadow.querySelector('.toast');
    applyLocalization();

    shadow.querySelectorAll('[data-inline]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (event.isTrusted) openCard(button.dataset.inline, button);
      });
    });
    moreButton.addEventListener('click', (event) => {
      if (event.isTrusted && snapshot && !submitting) openPopup();
    });
    shadow.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        submitSelection(button.dataset.action, '', interfaceLanguage);
      });
    });
    question.addEventListener('input', () => {
      sendButton.disabled = !question.value.trim();
    });
    sendButton.addEventListener('click', (event) => {
      if (event.isTrusted) submitSelection('custom', question.value);
    });
    shadow.querySelector('.hide').addEventListener('click', (event) => {
      if (event.isTrusted) disableShortcut();
    });
    cardParts.target.addEventListener('change', () => {
      if (!cardState || !isSupportedTranslationLanguage(cardParts.target.value)) return;
      cardState.target = cardParts.target.value;
      if (snapshot?.text.length > INLINE_MAX_CHARS) {
        submitSelection('translate', '', cardState.target);
        return;
      }
      runInline();
    });
    cardParts.retry.addEventListener('click', (event) => {
      if (event.isTrusted) runInline();
    });
    cardParts.continueButton.addEventListener('click', (event) => {
      if (event.isTrusted) continueInPanel();
    });
    cardParts.followUp.addEventListener('input', syncFollowUpSend);
    cardParts.send.addEventListener('click', (event) => {
      if (event.isTrusted) submitFollowUp();
    });
    cardParts.result.addEventListener('scroll', updateResultFade);
    host.addEventListener('pointerdown', () => { interacting = true; }, true);
    host.addEventListener('pointerup', () => {
      setTimeout(() => { interacting = false; }, 0);
    }, true);
    (document.documentElement || document.body).appendChild(host);
  }

  function getVisibleSelectionBottom() {
    if (!snapshot) return 0;
    return (snapshot.rects || []).reduce(
      (bottom, selectionRect) => Math.max(bottom, selectionRect.bottom),
      snapshot.rect.bottom,
    );
  }

  function positionShortcut() {
    if (!snapshot || !shortcut) return;
    const rect = snapshot.rect;
    // Fractional size: offsetWidth rounds, which can overshoot the margin by a sub-pixel.
    const box = shortcut.getBoundingClientRect();
    const width = box.width;
    const height = box.height || TOOLBAR_HEIGHT;
    let left = rect.left + rect.width / 2 - width / 2;
    let top = rect.top - height - GAP;
    if (top < GAP) top = getVisibleSelectionBottom() + GAP;
    left = clamp(left, GAP, Math.max(GAP, window.innerWidth - width - GAP));
    top = clamp(top, GAP, Math.max(GAP, window.innerHeight - height - GAP));
    // Round down so the measured fractional width cannot cross the viewport margin.
    toolbarLeft = Math.floor(left);
    shortcut.style.left = `${toolbarLeft}px`;
    shortcut.style.top = `${Math.floor(top)}px`;
  }

  function positionPopup() {
    if (!popup || popup.hidden || !shortcut) return;
    const buttonRect = shortcut.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    let left = buttonRect.left;
    let top = buttonRect.bottom + 8;
    if (top + popupRect.height > window.innerHeight - GAP) top = buttonRect.top - popupRect.height - 8;
    left = clamp(left, GAP, Math.max(GAP, window.innerWidth - popupRect.width - GAP));
    top = clamp(top, GAP, Math.max(GAP, window.innerHeight - popupRect.height - GAP));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  // A card replaces the bar where it stood and grows away from the selection,
  // on the side with more room, so the selected text stays visible. The side is
  // chosen once per card; later content only changes its height.
  function chooseCardSide() {
    const roomAbove = snapshot.rect.top - GAP * 2;
    const roomBelow = window.innerHeight - getVisibleSelectionBottom() - GAP * 2;
    cardSide = roomAbove >= CARD_PREFERRED_HEIGHT || roomAbove >= roomBelow ? 'above' : 'below';
  }

  function positionCard() {
    if (!card || card.hidden || !snapshot) return;
    const room = cardSide === 'above'
      ? snapshot.rect.top - GAP * 2
      : window.innerHeight - getVisibleSelectionBottom() - GAP * 2;
    card.style.maxHeight = `${Math.round(clamp(room, 160, window.innerHeight - GAP * 2))}px`;
    const box = card.getBoundingClientRect();
    const width = box.width;
    const height = box.height;
    const left = clamp(toolbarLeft, GAP, Math.max(GAP, window.innerWidth - width - GAP));
    card.style.left = `${Math.floor(left)}px`;
    if (cardSide === 'above') {
      const bottom = clamp(window.innerHeight - (snapshot.rect.top - GAP), GAP, Math.max(GAP, window.innerHeight - height - GAP));
      card.style.top = 'auto';
      card.style.bottom = `${Math.floor(bottom)}px`;
    } else {
      const top = clamp(getVisibleSelectionBottom() + GAP, GAP, Math.max(GAP, window.innerHeight - height - GAP));
      card.style.bottom = 'auto';
      card.style.top = `${Math.floor(top)}px`;
    }
  }

  function clearSelectionHighlight() {
    highlightLayer?.replaceChildren();
  }

  function showSelectionHighlight() {
    clearSelectionHighlight();
    if (!highlightLayer || !snapshot) return;
    const rects = snapshot.rects?.length ? snapshot.rects : [snapshot.rect];
    for (const rect of rects) {
      const highlight = document.createElement('span');
      highlight.className = 'selection-highlight';
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
      highlightLayer.appendChild(highlight);
    }
  }

  const surfacePressedKeys = new Set();

  function containSurfaceKeyboardEvent(event) {
    const key = event.code || event.key;
    const onSurface = !!host && event.composedPath?.().includes(host);
    // Submitting/dismissing the dialog can move focus before the chord's
    // keyup. Its release still belongs to the dialog, not the underlying page.
    if (!onSurface && event.type === 'keydown') surfacePressedKeys.delete(key);
    const ownedRelease = event.type === 'keyup' && surfacePressedKeys.has(key);
    if (!onSurface && !ownedRelease) return;
    if (event.type === 'keydown' && event.isTrusted) surfacePressedKeys.add(key);
    if (event.type === 'keyup') surfacePressedKeys.delete(key);
    event.stopImmediatePropagation();
    if (event.type !== 'keydown') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!popup.hidden) closePopup(true);
      else if (!card.hidden) closeCard(true);
      else dismissSurface();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && shadow?.activeElement === question) {
      event.preventDefault();
      submitSelection('custom', question.value);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
        && !event.isComposing && event.keyCode !== 229 && shadow?.activeElement === cardParts.followUp) {
      // Enter confirms an IME composition; only a plain Enter sends the follow-up.
      event.preventDefault();
      submitFollowUp();
    }
  }

  function showShortcut(nextSnapshot) {
    ensureSurface();
    clearSelectionHighlight();
    resetCard();
    snapshot = nextSnapshot;
    popup.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
    question.value = '';
    includePageContext.checked = true;
    sendButton.disabled = true;
    shortcut.hidden = false;
    positionShortcut();
  }

  async function openPopup() {
    if (!snapshot || submitting) return;
    if (!localization) {
      // A card asked for while the language bundle loads is replaced by this popup, so
      // take a newer request id now: its continuation then stops, instead of starting a
      // paid model call that closeCard would only cancel a moment later.
      cardRequestId += 1;
      await refreshLocalization(interfaceLanguage);
    }
    if (!snapshot || submitting) return;
    ensureSurface();
    applyLocalization();
    if (!card.hidden) closeCard(false);
    popup.hidden = false;
    moreButton.setAttribute('aria-expanded', 'true');
    popup.style.visibility = 'hidden';
    positionPopup();
    popup.style.visibility = '';
    showSelectionHighlight();
    shadow.querySelector('[data-action="summarize"]')?.focus();
  }

  function closePopup(restoreFocus) {
    if (!popup) return;
    popup.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
    question.value = '';
    includePageContext.checked = true;
    sendButton.disabled = true;
    clearSelectionHighlight();
    if (restoreFocus && shortcut && !shortcut.hidden) moreButton.focus();
  }

  // ---- Inline cards (Translate, Explain, Proofread) ----

  function populateTargetLanguages() {
    if (!cardParts) return;
    const select = cardParts.target;
    const options = TRANSLATION_LANGUAGES
      .map((code) => ({ code, label: languageName(code) || code }))
      .sort((a, b) => a.label.localeCompare(b.label, interfaceLanguage));
    // The placeholder is only chosen when the text is already in the interface
    // language and the person has not picked a target yet.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.hidden = true;
    placeholder.textContent = str('translateTo');
    select.replaceChildren(placeholder, ...options.map(({ code, label }) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = label;
      return option;
    }));
  }

  // Small, safe renderer for the model's answer: paragraphs, "- " and "1." lists,
  // **bold**, *italic* and `code`. Everything else stays plain text, and nothing is parsed as HTML.
  function appendInlineMarkup(parent, text) {
    const pattern = /`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) parent.append(text.slice(last, match.index));
      const token = match[0];
      const code = token[0] === '`';
      const bold = token.startsWith('**');
      const element = document.createElement(code ? 'code' : bold ? 'strong' : 'em');
      element.textContent = token.slice(bold ? 2 : 1, bold ? -2 : -1);
      parent.append(element);
      last = match.index + token.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function renderAnswer(container, text, markdown) {
    container.replaceChildren();
    container.classList.toggle('plain', !markdown);
    if (!markdown) {
      container.textContent = text;
      return;
    }
    let list = null;
    let paragraph = null;
    for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        list = paragraph = null;
        continue;
      }
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      const numbered = line.match(/^\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.localName !== tag) {
          list = document.createElement(tag);
          container.append(list);
        }
        paragraph = null;
        const item = document.createElement('li');
        appendInlineMarkup(item, (bullet || numbered)[1]);
        list.append(item);
        continue;
      }
      list = null;
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (!paragraph) {
        paragraph = document.createElement('p');
        container.append(paragraph);
      } else {
        paragraph.append(document.createElement('br'));
      }
      if (heading) {
        const strong = document.createElement('strong');
        appendInlineMarkup(strong, heading[1]);
        paragraph.append(strong);
      } else {
        appendInlineMarkup(paragraph, line);
      }
    }
  }

  function updateResultFade() {
    if (!cardParts) return;
    const { result } = cardParts;
    result.classList.toggle('fade', result.scrollHeight - result.scrollTop - result.clientHeight > 4);
  }

  // Draws the card from cardState alone, so every change goes through here.
  function renderCard() {
    if (!card || !cardState) return;
    const { kind, status } = cardState;
    const parts = cardParts;
    card.setAttribute('aria-label', localization?.strings?.[kind] || kind);
    parts.lang.hidden = kind !== 'translate';
    parts.quote.hidden = kind !== 'translate';
    if (kind === 'translate') {
      parts.quote.textContent = cardState.quote;
      parts.source.textContent = cardState.sourceLabel || str('autoDetect');
      parts.target.value = cardState.target;
    }
    // A cut-off with no text has nothing to show or retry, so only the notice remains.
    const cutOffOnly = status === 'error' && cardState.truncated;
    parts.result.hidden = status === 'idle' || cutOffOnly;
    parts.result.setAttribute('aria-busy', status === 'loading' ? 'true' : 'false');
    parts.skeleton.hidden = status !== 'loading';
    parts.text.hidden = status !== 'ready';
    parts.error.hidden = status !== 'error' || cutOffOnly;
    parts.cut.hidden = !((status === 'ready' || cutOffOnly) && cardState.truncated);
    parts.notice.hidden = !(status !== 'loading' && cardState.notice);
    parts.notice.textContent = status !== 'loading' ? cardState.notice : '';
    if (status === 'ready') renderAnswer(parts.text, cardState.text, kind === 'explain');
    if (status === 'error') {
      parts.errorText.textContent = str('inlineFailed');
      parts.errorDetail.textContent = cardState.error;
      parts.errorDetail.hidden = !cardState.error;
    }
    syncFollowUpSend();
    positionCard();
    updateResultFade();
  }

  // A follow-up continues from the card's answer, so it can only be sent once there is one.
  // The field stays typeable meanwhile; sending while the answer is still loading would
  // cancel that request and ask a question with no answer behind it.
  function syncFollowUpSend() {
    if (!cardParts) return;
    cardParts.send.disabled = !(cardParts.followUp.value.trim() && cardState?.status === 'ready');
  }

  async function openCard(kind, opener) {
    if (!snapshot || submitting || !INLINE_ACTIONS.includes(kind)) return;
    if (kind !== 'translate' && snapshot.text.length > INLINE_MAX_CHARS) {
      // Too long for a card: the side panel is the better place to read it. This is
      // decided before anything is awaited, because the panel can only be opened
      // inside the click's user gesture, which the localization wait would outlive.
      submitSelection(kind, '', interfaceLanguage);
      return;
    }
    // Claim the card before anything is awaited: a second click while the
    // localization loads takes a newer id, so this call stops instead of opening
    // a second card and starting a second paid request.
    const requestId = ++cardRequestId;
    if (!localization) await refreshLocalization(interfaceLanguage);
    if (requestId !== cardRequestId || !snapshot || submitting) return;
    ensureSurface();
    applyLocalization();
    closePopup(false);
    cardOpener = opener || null;
    cardState = {
      kind,
      status: 'loading',
      target: kind === 'translate' ? interfaceLanguage : '',
      sourceLabel: '',
      quote: kind === 'translate' ? snapshot.text : '',
      text: '',
      truncated: false,
      notice: '',
      error: '',
    };
    cardParts.followUp.value = '';
    cardParts.send.disabled = true;
    shortcut.hidden = true;
    card.hidden = false;
    chooseCardSide();
    showSelectionHighlight();
    renderCard();
    // Focus stays inside the card so a selection change caused by the click
    // does not dismiss it, and Escape and Enter reach the card's handlers.
    card.focus({ preventScroll: true });
    if (kind === 'translate') {
      // Long selections go straight to the side panel, where an automatic target
      // could be a no-op. Require an explicit target rather than guessing.
      if (snapshot?.text.length > INLINE_MAX_CHARS) {
        cardState.status = 'idle';
        cardState.target = '';
        renderCard();
        cardParts.target.focus({ preventScroll: true });
        return;
      }
      const detected = await detectSourceLanguage(cardState?.quote || '');
      if (requestId !== cardRequestId || !cardState) return;
      cardState.sourceLabel = detected ? languageName(detected) : '';
      // Translating into the language the text is already in would only echo it,
      // so wait for the person to choose a target instead.
      if (detected && baseLanguage(detected) === cardState.target) {
        cardState.status = 'idle';
        cardState.target = '';
        renderCard();
        cardParts.target.focus({ preventScroll: true });
        return;
      }
    }
    runInline();
  }

  function newInlineJobId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
  }

  // Tell the background to stop the model call the card no longer needs.
  function cancelInline() {
    const jobId = cardJobId;
    cardJobId = '';
    if (!jobId) return;
    try {
      Promise.resolve(api.runtime.sendMessage({ type: INLINE_CANCEL_MESSAGE, jobId })).catch(() => {});
    } catch { /* The call ends on its own timeout if the background is unreachable. */ }
  }

  async function runInline() {
    if (!cardState || !snapshot) return;
    // Retrying or retargeting replaces the call that is still running.
    cancelInline();
    const requestId = ++cardRequestId;
    const jobId = newInlineJobId();
    cardJobId = jobId;
    const { kind, target } = cardState;
    const selectionText = snapshot.text;
    cardState.status = 'loading';
    cardState.text = '';
    cardState.truncated = false;
    cardState.notice = '';
    cardState.error = '';
    renderCard();
    try {
      const response = await api.runtime.sendMessage({
        type: INLINE_MESSAGE,
        jobId,
        action: kind,
        selectionText,
        language: kind === 'translate' ? target : interfaceLanguage,
      });
      if (requestId !== cardRequestId || !cardState) return;
      cardJobId = '';
      let answer = typeof response?.text === 'string' ? response.text : '';
      cardState.truncated = response?.truncated === true;
      // This also applies to a textless cut-off, where it warns that continuing
      // in the panel would be blocked by the exhausted allowance.
      cardState.notice = typeof response?.notice === 'string' ? response.notice.slice(0, 300) : '';
      if (!response?.ok || !answer.trim()) {
        throw new Error(typeof response?.error === 'string' && !cardState.truncated ? response.error : '');
      }
      if (answer.length > INLINE_ANSWER_MAX_CHARS) {
        let end = INLINE_ANSWER_MAX_CHARS;
        const last = answer.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end -= 1;
        answer = answer.slice(0, end);
        cardState.truncated = true;
      }
      cardState.status = 'ready';
      cardState.text = answer;
    } catch (error) {
      if (requestId !== cardRequestId || !cardState) return;
      cardJobId = '';
      cardState.status = 'error';
      cardState.error = String(error?.message || '').slice(0, 300);
    }
    renderCard();
  }

  function submitFollowUp() {
    const value = cardParts?.followUp.value.trim();
    if (!value || cardState?.status !== 'ready') return;
    // A follow-up continues in the side panel with the card's answer as context.
    // It takes the question box's default for page context, which is on whenever
    // that box is closed.
    submitSelection('custom', value, '', {
      priorAction: cardState.kind,
      priorAnswer: cardState.text,
    });
  }

  // A cut-off answer is finished in the side panel, where the reply is not capped. The
  // panel picks up from the unfinished text; running the action again would reach the
  // same limit. With no text to resume from, it starts the action over.
  function continueInPanel() {
    if (!cardState?.truncated) return;
    const { kind, target } = cardState;
    submitSelection(kind, '', kind === 'translate' ? target : interfaceLanguage, {
      continueFrom: cardState.text || '',
    });
  }

  // Forget the card without touching the bar; a request still in flight is cancelled and ignored.
  function resetCard() {
    cancelInline();
    cardRequestId += 1;
    cardState = null;
    cardOpener = null;
    if (!card) return;
    card.hidden = true;
    cardParts.followUp.value = '';
    cardParts.send.disabled = true;
  }

  function closeCard(restoreFocus) {
    if (!card || card.hidden) return;
    const opener = cardOpener;
    resetCard();
    clearSelectionHighlight();
    if (snapshot && shortcut) {
      shortcut.hidden = false;
      positionShortcut();
      if (restoreFocus) (opener?.isConnected ? opener : moreButton).focus();
    }
  }

  function dismissSurface() {
    clearSelectionHighlight();
    snapshot = null;
    resetCard();
    if (shortcut) shortcut.hidden = true;
    if (popup) popup.hidden = true;
    if (moreButton) moreButton.setAttribute('aria-expanded', 'false');
    if (question) question.value = '';
    if (includePageContext) includePageContext.checked = true;
    if (sendButton) sendButton.disabled = true;
  }

  function destroySurface() {
    hideToast();
    cancelInline();
    cardRequestId += 1;
    host?.remove();
    host = shadow = highlightLayer = shortcut = moreButton = popup = question = includePageContext = sendButton = toast = null;
    card = cardParts = cardState = cardOpener = null;
    snapshot = null;
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    if (toast) toast.hidden = true;
  }

  function showToast(message) {
    if (suppressed) return;
    ensureSurface();
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast) toast.hidden = true;
      toastTimer = null;
    }, 3800);
  }

  async function submitSelection(action, customQuestion = '', language = '', extra = {}) {
    if (submitting || !snapshot?.text) return;
    if (action === 'custom' && !String(customQuestion || '').trim()) return;
    if (action === 'translate' && !isSupportedTranslationLanguage(language)) return;
    const request = {
      ...currentSubmitFields(),
      type: SUBMIT_MESSAGE,
      action,
      selectionText: snapshot.text,
      question: action === 'custom' ? String(customQuestion).trim() : undefined,
      ...(action === 'custom' ? { includePageContext: includePageContext?.checked === true } : {}),
      // The earlier card answer a follow-up continues from; the background validates it.
      ...(action === 'custom' && extra.priorAnswer
        ? { priorAction: extra.priorAction, priorAnswer: extra.priorAnswer }
        : {}),
      // The unfinished text of a cut-off card answer, so the side panel resumes it.
      ...(action !== 'custom' && extra.continueFrom ? { continueFrom: extra.continueFrom } : {}),
      language: action === 'custom' ? undefined : (language || interfaceLanguage),
    };
    submitting = true;
    dismissSurface();
    try {
      const response = await api.runtime.sendMessage(request);
      if (!response?.ok) throw new Error(response?.error || 'Selection request was not accepted.');
      if (response.requiresManualOpen) showToast(localization?.strings.sentManual || 'Sent to WebBrain. Open the sidebar if it does not start.');
    } catch {
      showToast(localization?.strings.sendFailed || 'Could not send to WebBrain. Try the right-click menu instead.');
    } finally {
      submitting = false;
    }
  }

  function disableShortcut() {
    enabled = false;
    destroySurface();
    Promise.resolve(api.storage.local.set({ [STORAGE_KEY]: false })).catch(() => {});
  }

  function refreshFromSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const next = readSelection();
      if (next) showShortcut(next);
      else if (!shadow?.activeElement && !interacting) dismissSurface();
    }, 0);
  }

  document.addEventListener('pointerup', (event) => {
    if (!event.composedPath?.().includes(host)) refreshFromSelection();
  }, true);
  document.addEventListener('keyup', (event) => {
    if (!event.composedPath?.().includes(host)) refreshFromSelection();
  }, true);
  document.addEventListener('pointerdown', (event) => {
    if (host && !event.composedPath?.().includes(host)) dismissSurface();
  }, true);
  document.addEventListener('selectionchange', () => {
    if (!interacting && !shadow?.activeElement) refreshFromSelection();
  });
  window.addEventListener('scroll', (event) => {
    if (!event.composedPath?.().includes(host)) dismissSurface();
  }, true);
  window.addEventListener('resize', dismissSurface);
  window.addEventListener('keydown', containSurfaceKeyboardEvent, true);
  window.addEventListener('keypress', containSurfaceKeyboardEvent, true);
  window.addEventListener('keyup', containSurfaceKeyboardEvent, true);
  window.addEventListener('blur', () => surfacePressedKeys.clear());
  // A reload, navigation or closed tab ends this page without closing the card, so the
  // model call it is waiting on would run to its timeout for an answer nobody can see.
  window.addEventListener('pagehide', () => {
    if (cardJobId) dismissSurface();
  });

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === 'WB_HIDE_FOR_TOOL_USE') {
      suppressed = true;
      hideToast();
      dismissSurface();
    } else if (message?.type === 'WB_SHOW_AFTER_TOOL_USE') {
      suppressed = false;
    }
  });
  api.storage.onChanged?.addListener?.((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      enabled = changes[STORAGE_KEY].newValue !== false;
      if (!enabled) destroySurface();
    }
    if (changes[LOCALE_STORAGE_KEY]) void refreshLocalization(changes[LOCALE_STORAGE_KEY].newValue);
  });
  Promise.resolve(api.storage.local.get({ [STORAGE_KEY]: true, [LOCALE_STORAGE_KEY]: '' }))
    .then((stored) => {
      enabled = stored?.[STORAGE_KEY] !== false;
      void refreshLocalization(stored?.[LOCALE_STORAGE_KEY]);
      if (!enabled) destroySurface();
    })
    .catch(() => { enabled = true; });

  function rectOf(selector) {
    return shadow?.querySelector(selector)?.getBoundingClientRect().toJSON() || null;
  }

  // Isolated-world diagnostic hook used by deterministic browser fixtures.
  window.__webbrainSelectionShortcut = {
    refreshFromSelection,
    openPopup,
    openInline: (kind) => openCard(kind, null),
    submitPreset: (action) => submitSelection(action, '', interfaceLanguage),
    submitCustom: (value) => submitSelection('custom', value),
    submitFollowUp: (value) => {
      if (cardParts) cardParts.followUp.value = value;
      submitFollowUp();
    },
    chooseTarget: (code) => {
      if (!cardParts) return;
      cardParts.target.value = code;
      cardParts.target.dispatchEvent(new Event('change'));
    },
    setIncludePageContext: (value) => {
      if (includePageContext) includePageContext.checked = value === true;
    },
    hideShortcut: disableShortcut,
    getState: () => ({
      enabled,
      suppressed,
      submitting,
      interfaceLanguage,
      hasSelection: !!snapshot?.text,
      shortcutVisible: !!shortcut && !shortcut.hidden,
      popupVisible: !!popup && !popup.hidden,
      highlightRectCount: highlightLayer?.childElementCount || 0,
      toastVisible: !!toast && !toast.hidden,
      shortcutRect: shortcut && !shortcut.hidden ? shortcut.getBoundingClientRect().toJSON() : null,
      selectionRect: snapshot?.rect || null,
      selectionBottom: snapshot ? getVisibleSelectionBottom() : null,
      shortcutLabel: shortcut?.getAttribute('aria-label') || '',
      shortcutBackground: shortcut ? getComputedStyle(shortcut).backgroundColor : '',
      shortcutColor: shortcut ? getComputedStyle(shortcut).color : '',
      shortcutBoxShadow: shortcut ? getComputedStyle(shortcut).boxShadow : '',
      barLabels: shortcut
        ? Array.from(shortcut.querySelectorAll('.bar-label'), (label) => label.textContent)
        : [],
      moreExpanded: moreButton?.getAttribute('aria-expanded') === 'true',
      moreRect: shortcut && !shortcut.hidden ? rectOf('[data-more]') : null,
      inlineRects: shortcut && !shortcut.hidden
        ? Object.fromEntries(INLINE_ACTIONS.map((kind) => [kind, rectOf(`[data-inline="${kind}"]`)]))
        : null,
      summarizeRect: popup && !popup.hidden ? rectOf('[data-action="summarize"]') : null,
      popupActions: popup
        ? Array.from(popup.querySelectorAll('[data-action]'), (button) => button.dataset.action)
        : [],
      hideRect: popup && !popup.hidden ? rectOf('.hide') : null,
      questionRect: popup && !popup.hidden ? question?.getBoundingClientRect().toJSON() || null : null,
      questionValue: question?.value || '',
      includePageContextChecked: includePageContext?.checked === true,
      includePageContextLabel: shadow?.querySelector('.context-option span')?.textContent || '',
      hideLabel: shadow?.querySelector('.hide')?.textContent || '',
      actionIconCount: shadow?.querySelectorAll('.action > .action-icon').length || 0,
      direction: host?.dir || 'ltr',
      summarizeLabel: shadow?.querySelector('[data-action="summarize"] .action-label')?.textContent || '',
      quizLabel: shadow?.querySelector('[data-action="quiz"] .action-label')?.textContent || '',
      cardVisible: !!card && !card.hidden,
      cardKind: cardState?.kind || '',
      cardStatus: cardState?.status || '',
      cardText: cardState?.text || '',
      cardError: cardState?.error || '',
      cardTargetOptions: cardParts ? cardParts.target.options.length : 0,
      cardSide,
      cardRect: card && !card.hidden ? card.getBoundingClientRect().toJSON() : null,
      cardSourceLabel: cardParts && !cardParts.lang.hidden ? cardParts.source.textContent : '',
      cardTarget: cardParts && !cardParts.lang.hidden ? cardParts.target.value : '',
      cardTargetLabel: cardParts && !cardParts.lang.hidden
        ? cardParts.target.selectedOptions[0]?.textContent || ''
        : '',
      cardTargetOptionCount: cardParts ? cardParts.target.options.length : 0,
      cardQuote: cardParts && !cardParts.quote.hidden ? cardParts.quote.textContent : '',
      cardHtml: cardParts && !cardParts.text.hidden ? cardParts.text.innerHTML : '',
      followUpRect: card && !card.hidden ? rectOf('.followup') : null,
      followUpSendRect: card && !card.hidden ? rectOf('.followup-send') : null,
      retryRect: cardParts && !cardParts.error.hidden ? rectOf('.card-retry') : null,
      cardTruncated: cardState?.truncated === true,
      cutNoticeText: cardParts && !cardParts.cut.hidden ? cardParts.cutText.textContent : '',
      cardNotice: cardParts && !cardParts.notice.hidden ? cardParts.notice.textContent : '',
      continueRect: cardParts && !cardParts.cut.hidden ? rectOf('.card-continue') : null,
      continueLabel: cardParts && !cardParts.cut.hidden ? cardParts.continueButton.textContent : '',
      followUpPlaceholder: cardParts?.followUp.placeholder || '',
      followUpValue: cardParts?.followUp.value || '',
      followUpSendDisabled: cardParts ? cardParts.send.disabled : true,
    }),
  };
})();
