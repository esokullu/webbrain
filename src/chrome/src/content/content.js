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

  /**
   * Get a simplified DOM snapshot for the agent.
   */
  function getInteractiveElements() {
    const elements = [];
    const selectors = [
      'a[href]', 'button', 'input', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="tab"]',
      '[onclick]', '[data-action]',
    ];

    const all = document.querySelectorAll(selectors.join(', '));
    all.forEach((el, index) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return; // hidden
      if (el.offsetParent === null && el.tagName !== 'BODY') return; // not visible

      elements.push({
        index,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        role: el.getAttribute('role') || '',
        text: (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim().slice(0, 100),
        id: el.id || '',
        name: el.name || '',
        href: el.href || '',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    });

    return elements;
  }

  /**
   * Click an element by selector or coordinates.
   */
  function clickElement(params) {
    let el;
    if (params.selector) {
      el = document.querySelector(params.selector);
    } else if (params.index != null) {
      const interactive = document.querySelectorAll(
        'a[href], button, input, textarea, select, [role="button"], [role="link"], [onclick]'
      );
      el = interactive[params.index];
    } else if (params.x != null && params.y != null) {
      el = document.elementFromPoint(params.x, params.y);
    }

    if (!el) return { success: false, error: 'Element not found' };

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.click();
    return { success: true, tag: el.tagName, text: el.innerText?.slice(0, 50) };
  }

  /**
   * Type text into an input/textarea.
   */
  function typeText(params) {
    let el;
    if (params.selector) {
      el = document.querySelector(params.selector);
    } else if (params.index != null) {
      const inputs = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
      el = inputs[params.index];
    }

    if (!el) return { success: false, error: 'Element not found' };

    el.focus();
    if (params.clear) {
      el.value = '';
    }

    // Use input events for React/Vue compatibility
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, (params.clear ? '' : el.value) + params.text);
    } else {
      el.value = (params.clear ? '' : el.value) + params.text;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return { success: true, value: el.value.slice(0, 100) };
  }

  /**
   * Scroll the page.
   */
  function scrollPage(params) {
    const amount = params.amount || 500;
    const direction = params.direction || 'down';

    if (direction === 'down') window.scrollBy(0, amount);
    else if (direction === 'up') window.scrollBy(0, -amount);
    else if (direction === 'top') window.scrollTo(0, 0);
    else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);

    return {
      success: true,
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
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

  function getPageInfoFull() {
    const getText = () => {
      const selectors = ['article', 'main', '[role="main"]', '.content', '#content'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 200) {
          return el.innerText.trim();
        }
      }
      return document.body.innerText.trim();
    };

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
      text: getText(),
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

  function getInteractiveElementsFull() {
    const pierceShadow = (root, results, idx) => {
      const selectors = [
        'a[href]', 'button', 'input', 'textarea', 'select',
        '[role="button"]', '[role="link"]', '[role="tab"]',
        '[onclick]', '[data-action]', 'summary', 'label'
      ];

      selectors.forEach(sel => {
        try {
          const all = root.querySelectorAll(sel);
          all.forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;

            results.push({
              index: idx.current++,
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              role: el.getAttribute('role') || '',
              text: (el.innerText || el.value || el.placeholder || el.title || el.ariaLabel || '').trim().slice(0, 100),
              id: el.id || '',
              name: el.name || '',
              href: el.href || '',
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              inShadowDOM: root !== document,
            });
          });
        } catch (e) {}
      });

      const hosts = root.querySelectorAll('*');
      hosts.forEach(host => {
        if (host.shadowRoot) {
          pierceShadow(host.shadowRoot, results, idx);
        }
      });
    };

    const results = [];
    const idx = { current: 0 };
    pierceShadow(document, results, idx);
    return results;
  }

  window.__webbrain_getNodeById = (nodeId) => {
    return null;
  };

  // Expose node retrieval for CDP
  window.__webbrain_getNodeById = (nodeId) => {
    return null;
  };

  // --- Message handler ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'content') return;

    const handlers = {
      'get_page_info': () => getPageInfo(),
      'get_page_info_cdp': () => getPageInfoFull(),
      'get_interactive_elements': () => getInteractiveElements(),
      'get_interactive_elements_cdp': () => getInteractiveElementsFull(),
      'click': () => clickElement(msg.params || {}),
      'type': () => typeText(msg.params || {}),
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
