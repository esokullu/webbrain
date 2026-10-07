(() => {
  if (window.__webbrain_ollama_launch_handoff) return;
  window.__webbrain_ollama_launch_handoff = true;

  function isLaunchPage() {
    return window.location.protocol === 'https:' &&
      (window.location.hostname === 'webbrain.one' || window.location.hostname === 'www.webbrain.one') &&
      window.location.pathname.replace(/\/+$/, '') === '/launch/ollama';
  }

  function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  function setStatus(text, kind = 'info') {
    const root = document.body || document.documentElement;
    if (!root) return;
    let el = document.getElementById('webbrain-ollama-launch-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'webbrain-ollama-launch-status';
      (window.__wbPageMonitorDecorations ??= new WeakSet()).add(el);
      el.style.cssText = [
        'position:fixed',
        'z-index:2147483647',
        'left:24px',
        'right:24px',
        'bottom:24px',
        'padding:14px 16px',
        'border-radius:8px',
        'font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        'box-shadow:0 12px 36px rgba(0,0,0,.22)',
        'color:#111',
      ].join(';');
      root.appendChild(el);
    }
    el.style.background = kind === 'error' ? '#ffe8e8' : kind === 'success' ? '#e8f8ef' : '#eef4ff';
    el.style.border = kind === 'error' ? '1px solid #d55' : kind === 'success' ? '1px solid #3b8f5f' : '1px solid #6d8fd6';
    el.textContent = text;
  }

  async function runHandoff() {
    if (!isLaunchPage()) return;
    const params = new URLSearchParams(window.location.search);
    const handoff = {
      model: params.get('model') || '',
      baseUrl: params.get('baseUrl') || '',
      contextWindow: params.get('contextWindow') || '',
    };
    const modelLabel = String(handoff.model || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
    if (!modelLabel) {
      setStatus('WebBrain could not configure Ollama because the launch URL is missing a model.', 'error');
      return;
    }

    const ok = window.confirm(
      `Configure WebBrain to use Ollama model "${modelLabel}"?\n\n` +
      `Provider: ${handoff.baseUrl || 'http://127.0.0.1:11434/v1'}\n` +
      `Context window: ${handoff.contextWindow || '65536'} tokens\n\n` +
      'This updates the Ollama provider and makes it active.'
    );
    if (!ok) {
      setStatus('WebBrain Ollama setup was cancelled.');
      return;
    }

    try {
      const response = await runtimeSendMessage({
        target: 'background',
        action: 'ollama_launch_handoff',
        handoff,
      });
      setStatus(
        `WebBrain is configured for Ollama model "${response.model}". Open the WebBrain panel to start.`,
        'success'
      );
    } catch (e) {
      setStatus(`WebBrain could not configure Ollama: ${e.message}`, 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runHandoff, { once: true });
  } else {
    runHandoff();
  }
})();
