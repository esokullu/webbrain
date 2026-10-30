import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, EXTENSION_PATHS } from './webbrain.js';

const WIDGET_RUNTIME_PATH = path.resolve(PROJECT_ROOT, 'src/widget-runtime.js');

/**
 * Strips top-level ES module `export ` keywords from pure upstream helper files
 * (`calculator.js`, `activity-brain.js`, `markdown-render.js`) so they can run inside
 * a classic `<script src="/embed.js">` tag without requiring bundler dependencies.
 */
function stripEsModuleExports(source) {
  return String(source)
    .replace(/^export\s+(function|const|let|var|class)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}

let cachedBundle = null;
let cachedAt = 0;

/**
 * Builds the self-contained `<script src="/embed.js">` bundle from the WebBrain
 * extension's own content scripts and helpers (src/chrome) plus
 * `embed/src/widget-runtime.js`.
 */
export function buildEmbedBundle({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedBundle && now - cachedAt < 3000) {
    return cachedBundle;
  }

  const accessibilityTreeJs = fs.readFileSync(EXTENSION_PATHS.accessibilityTree, 'utf8');
  const visualIndicatorJs = fs.readFileSync(EXTENSION_PATHS.visualIndicator, 'utf8');
  const contentScriptJs = fs.readFileSync(EXTENSION_PATHS.contentScript, 'utf8');
  const calculatorJs = stripEsModuleExports(fs.readFileSync(EXTENSION_PATHS.calculator, 'utf8'));
  const activityBrainJs = stripEsModuleExports(fs.readFileSync(EXTENSION_PATHS.activityBrain, 'utf8'));
  const markdownRenderJs = stripEsModuleExports(fs.readFileSync(EXTENSION_PATHS.markdownRender, 'utf8'));
  const widgetRuntimeJs = fs.readFileSync(WIDGET_RUNTIME_PATH, 'utf8');

  const bundle = `/**
 * WebBrain for Websites — Embeddable AI Agent Bundle
 * Source: https://github.com/webbrain-one/webbrain/tree/main/embed
 * License: GPL-3.0-or-later
 */
(function() {
  if (window.__wbEmbedRuntime) return;

  const messageListeners = [];
  const stopCallbacks = [];
  const storageListeners = [];
  const localStorageData = { agentIndicatorStyle: 'classic' };
  let widgetHostEl = null;

  const inPageChrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          if (typeof fn === 'function') messageListeners.push(fn);
        },
        removeListener(fn) {
          const idx = messageListeners.indexOf(fn);
          if (idx >= 0) messageListeners.splice(idx, 1);
        }
      },
      sendMessage(msg, callback) {
        if (msg && msg.type === 'WB_STOP_AGENT') {
          for (const cb of stopCallbacks) {
            try { cb(); } catch {}
          }
        }
        if (typeof callback === 'function') {
          try { callback({ ok: true, state: { active: false } }); } catch {}
        }
        return Promise.resolve({ ok: true });
      }
    },
    storage: {
      local: {
        get(keys, cb) {
          let res = {};
          if (typeof keys === 'string') {
            res[keys] = localStorageData[keys];
          } else if (Array.isArray(keys)) {
            for (const k of keys) res[k] = localStorageData[k];
          } else if (keys && typeof keys === 'object') {
            res = { ...keys, ...localStorageData };
          } else {
            res = { ...localStorageData };
          }
          if (typeof cb === 'function') cb(res);
          return Promise.resolve(res);
        },
        set(items, cb) {
          if (items && typeof items === 'object') {
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
              changes[k] = { oldValue: localStorageData[k], newValue: v };
              localStorageData[k] = v;
            }
            for (const fn of storageListeners) {
              try { fn(changes, 'local'); } catch {}
            }
          }
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener(fn) {
          if (typeof fn === 'function') storageListeners.push(fn);
        },
        removeListener(fn) {
          const idx = storageListeners.indexOf(fn);
          if (idx >= 0) storageListeners.splice(idx, 1);
        }
      }
    }
  };

  function dispatchMessageToListeners(msg) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };
      const timeoutId = setTimeout(() => done({ error: 'Content action timed out' }), 8000);
      const sendResponse = (res) => {
        clearTimeout(timeoutId);
        done(res);
      };

      for (const listener of messageListeners) {
        try {
          const asyncKeepAlive = listener(msg, { id: 'webbrain-for-websites' }, sendResponse);
          if (settled) return;
          if (asyncKeepAlive === true) {
            return;
          }
        } catch (err) {
          clearTimeout(timeoutId);
          done({ success: false, error: err && err.message || String(err) });
          return;
        }
      }
      clearTimeout(timeoutId);
      done({ ok: true });
    });
  }

  // Build upstream helper namespace directly from WebBrain extension modules (isolated per file)
  const upstreamHelpers = (function() {
    const calcMod = (function() {
      ${calculatorJs}
      return { calculateExpression };
    })();
    const brainMod = (function() {
      ${activityBrainJs}
      return { mountActivityBrain };
    })();
    const mdMod = (function() {
      ${markdownRenderJs}
      return {
        highlightCode,
        escapeCodeHtml,
        renderMarkdownBlockquotes,
        renderMarkdownHeadings,
        renderMarkdownTables,
        createMarkdownPlaceholders,
      };
    })();
    return {
      ...calcMod,
      ...brainMod,
      ...mdMod,
    };
  })();

  window.__wbEmbedRuntime = {
    chrome: inPageChrome,
    upstream: upstreamHelpers,
    setWidgetHost(el) {
      widgetHostEl = el;
    },
    onStopRequested(fn) {
      if (typeof fn === 'function') stopCallbacks.push(fn);
    },
    async dispatchContentAction(action, params = {}) {
      // Hide widget host from AX tree & DOM queries during read/action pass
      const prevAriaHidden = widgetHostEl ? widgetHostEl.getAttribute('aria-hidden') : null;
      const prevInert = widgetHostEl ? widgetHostEl.inert : false;
      if (widgetHostEl) {
        widgetHostEl.setAttribute('aria-hidden', 'true');
        widgetHostEl.inert = true;
      }
      try {
        return await dispatchMessageToListeners({
          target: 'content',
          action,
          params,
        });
      } finally {
        if (widgetHostEl) {
          if (prevAriaHidden === null) widgetHostEl.removeAttribute('aria-hidden');
          else widgetHostEl.setAttribute('aria-hidden', prevAriaHidden);
          widgetHostEl.inert = prevInert;
        }
      }
    },
    dispatchIndicator(type, extra = {}) {
      return dispatchMessageToListeners({ type, ...extra });
    }
  };

  // Inject unmodified WebBrain extension content scripts with isolated chrome shim
  (function(chrome, browser) {
    ${accessibilityTreeJs}
    ${visualIndicatorJs}
    ${contentScriptJs}
  })(window.__wbEmbedRuntime.chrome, window.__wbEmbedRuntime.chrome);

  // Inject WebBrain for Websites UI & Agent Runtime
  ${widgetRuntimeJs}
})();
`;

  cachedBundle = bundle;
  cachedAt = now;
  return bundle;
}
