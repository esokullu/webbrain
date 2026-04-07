/**
 * CDP Client for Chrome DevTools Protocol
 * Provides access to shadow DOM, cross-origin iframes, pixel-perfect screenshots,
 * downloads, and uploads via chrome.debugger API.
 */

export class CDPClient {
  constructor() {
    this.sessions = new Map(); // tabId -> debugger session
    this.eventHandlers = new Map(); // tabId -> { eventName -> [handlers] }
  }

  /**
   * Attach debugger to a tab.
   */
  async attach(tabId) {
    if (this.sessions.has(tabId)) {
      return this.sessions.get(tabId);
    }

    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', async () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const session = { tabId, attached: true };
        this.sessions.set(tabId, session);

        chrome.debugger.onEvent.addListener((source, method, params) => {
          if (source.tabId !== tabId) return;
          const handlers = this.eventHandlers.get(tabId)?.[method];
          if (handlers) {
            handlers.forEach(h => h(params));
          }
        });

        chrome.debugger.onDetach.addListener((source, reason) => {
          if (source.tabId === tabId) {
            this.sessions.delete(tabId);
            this.eventHandlers.delete(tabId);
          }
        });

        resolve(session);
      });
    });
  }

  /**
   * Detach debugger from a tab.
   */
  async detach(tabId) {
    if (!this.sessions.has(tabId)) return;

    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        this.sessions.delete(tabId);
        this.eventHandlers.delete(tabId);
        resolve();
      });
    });
  }

  /**
   * Send a CDP command and get the result.
   */
  async sendCommand(tabId, method, params = {}) {
    if (!this.sessions.has(tabId)) {
      throw new Error(`Not attached to tab ${tabId}`);
    }

    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result, error) => {
        if (error) {
          reject(new Error(error.message || error));
          return;
        }
        resolve(result);
      });
    });
  }

  /**
   * Register an event handler.
   */
  on(tabId, event, handler) {
    if (!this.eventHandlers.has(tabId)) {
      this.eventHandlers.set(tabId, {});
    }
    const handlers = this.eventHandlers.get(tabId);
    if (!handlers[event]) {
      handlers[event] = [];
    }
    handlers[event].push(handler);
  }

  /**
   * Get full DOM tree including shadow DOMs and iframes.
   */
  async getFullDOM(tabId) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    const result = await this.sendCommand(tabId, 'DOM.getFlattenedDocument', { depth: -1, pierce: true });
    return result;
  }

  /**
   * Query a selector in the main frame or any iframe/shadow DOM (pierce).
   */
  async querySelectorPierce(tabId, selector) {
    await this.sendCommand(tabId, 'DOM.enable');
    const doc = await this.sendCommand(tabId, 'DOM.getDocument', { depth: 0, pierce: false });
    const rootNodeId = doc.root?.nodeId;
    if (!rootNodeId) throw new Error('No document root');

    const result = await this.sendCommand(tabId, 'DOM.querySelectorAll', {
      nodeId: rootNodeId,
      selector,
      piercesShadowDom: true,
    });
    return result.nodeIds || [];
  }

  /**
   * Get node info including shadow root.
   */
  async describeNode(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    return await this.sendCommand(tabId, 'DOM.describeNode', { nodeId });
  }

  /**
   * Resolve a JS path to a node (for accessing shadow DOM elements).
   */
  async resolveNode(tabId, objectId) {
    await this.sendCommand(tabId, 'DOM.enable');
    return await this.sendCommand(tabId, 'DOM.resolveNode', { objectId });
  }

  /**
   * Call a JS function on the page.
   */
  async evaluate(tabId, expression, returnByValue = true) {
    await this.sendCommand(tabId, 'Runtime.enable');
    const result = await this.sendCommand(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    return result;
  }

  /**
   * Call function on an object.
   */
  async callFunctionOn(tabId, functionDeclaration, objectId, args = []) {
    await this.sendCommand(tabId, 'Runtime.enable');
    return await this.sendCommand(tabId, 'Runtime.callFunctionOn', {
      functionDeclaration,
      objectId,
      arguments: args,
      returnByValue: true,
      userGesture: true,
    });
  }

  /**
   * Get all frames including cross-origin iframes.
   */
  async getAllFrames(tabId) {
    await this.sendCommand(tabId, 'Page.enable');
    const result = await this.sendCommand(tabId, 'Page.getFrameTree');
    
    const frames = [];
    const collectFrames = (frameTree) => {
      if (frameTree.frame) {
        frames.push({
          id: frameTree.frame.id,
          url: frameTree.frame.url,
          name: frameTree.frame.name,
          parentId: frameTree.frame.parentId,
        });
      }
      if (frameTree.childFrames) {
        frameTree.childFrames.forEach(collectFrames);
      }
    };
    
    collectFrames(result.frameTree);
    return frames;
  }

  /**
   * Take a pixel-perfect screenshot of the full page.
   */
  async captureFullPageScreenshot(tabId) {
    await this.sendCommand(tabId, 'Page.enable');
    await this.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: 1920,
      screenHeight: 1080,
      viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    });

    const { visualViewport } = await this.evaluate(tabId, `
      (() => {
        const vp = window.visualViewport;
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          contentWidth: document.documentElement.scrollWidth,
          contentHeight: document.documentElement.scrollHeight,
          scale: vp ? vp.scale : 1
        };
      })()
    `);

    const scrollWidth = visualViewport?.contentWidth || 1920;
    const scrollHeight = visualViewport?.contentHeight || 1080;
    const scale = visualViewport?.scale || 1;

    const viewports = [];
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;

    for (let y = 0; y < scrollHeight; y += 1080) {
      for (let x = 0; x < scrollWidth; x += 1920) {
        viewports.push({ x, y, width: Math.min(1920, scrollWidth - x), height: Math.min(1080, scrollHeight - y) });
      }
    }

    const images = [];
    for (const vp of viewports) {
      await this.evaluate(tabId, `window.scrollTo(${vp.x}, ${vp.y})`);
      await new Promise(r => setTimeout(r, 100));

      await this.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
        deviceScaleFactor: 2,
        mobile: false,
        screenWidth: vp.width,
        screenHeight: vp.height,
        viewport: { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 },
      });

      const screenshot = await this.sendCommand(tabId, 'Page.captureScreenshot', {
        format: 'png',
        quality: 100,
        fromSurface: true,
      });
      images.push(screenshot.data);
    }

    await this.evaluate(tabId, `window.scrollTo(${scrollX}, ${scrollY})`);

    const { combineImages } = await import('./image-utils.js').catch(() => ({ combineImages: null }));
    if (combineImages) {
      return await combineImages(images, scrollWidth, scrollHeight, 2);
    }

    return images[0];
  }

  /**
   * Take a screenshot of a specific element.
   */
  async captureElementScreenshot(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    const boxModel = await this.sendCommand(tabId, 'DOM.getBoxModel', { nodeId });
    if (!boxModel || !boxModel.model) {
      throw new Error('Could not get box model for element');
    }

    const { contentOffset, border, padding, width, height } = boxModel.model;
    const x = contentOffset[0];
    const y = contentOffset[1];
    const w = width;
    const h = height;

    await this.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: Math.ceil(w),
      screenHeight: Math.ceil(h),
      viewport: { x: -x + border[0], y: -y + border[1], width: Math.ceil(w), height: Math.ceil(h), scale: 1 },
    });

    await this.evaluate(tabId, `window.scrollTo(${x - border[0]}, ${y - border[1]})`);
    await new Promise(r => setTimeout(r, 100));

    const screenshot = await this.sendCommand(tabId, 'Page.captureScreenshot', {
      format: 'png',
      quality: 100,
      fromSurface: true,
    });

    return screenshot.data;
  }

  /**
   * Scroll to and highlight an element.
   */
  async scrollToElement(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    const boxModel = await this.sendCommand(tabId, 'DOM.getBoxModel', { nodeId });
    if (boxModel?.model) {
      const x = boxModel.model.contentOffset[0];
      const y = boxModel.model.contentOffset[1];
      await this.evaluate(tabId, `window.scrollTo(${x - 100}, ${y - 100})`);
      return { success: true, x, y };
    }
    return { success: false };
  }

  /**
   * Set file input files (for upload).
   */
  async setFileInputFiles(tabId, nodeId, filePaths) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'DOM.setFileInputFiles', {
      nodeId,
      files: filePaths,
    });
    return { success: true };
  }

  /**
   * Dispatch mouse event.
   */
  async dispatchMouseEvent(tabId, type, x, y, button = 'left') {
    await this.sendCommand(tabId, 'Input.enable');
    const buttonMap = { left: 0, middle: 1, right: 2 };
    return await this.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: buttonMap[button] ?? 0,
      clickCount: type === 'mousePressed' ? 1 : 0,
    });
  }

  /**
   * Dispatch key event.
   */
  async dispatchKeyEvent(tabId, type, key, text = '') {
    await this.sendCommand(tabId, 'Input.enable');
    return await this.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type,
      key,
      text: text || key,
    });
  }

  /**
   * Get download directory.
   */
  async getDownloadPath(tabId) {
    const result = await this.evaluate(tabId, `
      (async () => {
        if (chrome.downloads) {
          const search = () => new Promise(r => chrome.downloads.search({ exists: true, limit: 1 }, r));
          const downloads = await search();
          return downloads[0]?.filename || 'downloads/';
        }
        return 'downloads/';
      })()
    `);
    return result?.result?.value || 'downloads/';
  }

  /**
   * Handle file download via CDP.
   */
  async downloadFile(tabId, url, filename) {
    return new Promise(async (resolve, reject) => {
      const downloadId = await new Promise((res) => {
        chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          res(id);
        });
      });

      chrome.downloads.onChanged.addListener(function onChanged(delta) {
        if (delta.id === downloadId) {
          if (delta.state?.current === 'complete') {
            chrome.downloads.search({ id: downloadId }, (items) => {
              chrome.downloads.onChanged.removeListener(onChanged);
              resolve({ success: true, filename: items[0]?.filename, id: downloadId });
            });
          } else if (delta.error) {
            chrome.downloads.onChanged.removeListener(onChanged);
            reject(new Error(delta.error));
          }
        }
      });
    });
  }

  /**
   * Get node attributes.
   */
  async getNodeAttributes(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    const result = await this.sendCommand(tabId, 'DOM.getAttributes', { nodeId });
    const attrs = {};
    for (let i = 0; i < result.attributes.length; i += 2) {
      attrs[result.attributes[i]] = result.attributes[i + 1];
    }
    return attrs;
  }

  /**
   * Traverse shadow DOM and collect elements.
   */
  async traverseShadowDOM(tabId, rootNodeId = null) {
    await this.sendCommand(tabId, 'DOM.enable');
    
    if (!rootNodeId) {
      const doc = await this.sendCommand(tabId, 'DOM.getDocument', { depth: 0 });
      rootNodeId = doc.root?.nodeId;
    }

    const result = await this.sendCommand(tabId, 'DOM.querySelectorAll', {
      nodeId: rootNodeId,
      selector: '*',
      piercesShadowDom: true,
    });

    const elements = [];
    for (const nodeId of result.nodeIds || []) {
      try {
        const desc = await this.sendCommand(tabId, 'DOM.describeNode', { nodeId });
        if (desc.node) {
          elements.push({
            nodeId,
            nodeName: desc.node.nodeName,
            backendNodeId: desc.node.backendNodeId,
            isShadowHost: desc.node.shadowRoots?.length > 0,
            shadowRootCount: desc.node.shadowRoots?.length || 0,
          });
        }
      } catch {
        // Skip inaccessible nodes
      }
    }

    return elements;
  }

  /**
   * Get inner text from a node.
   */
  async getNodeInnerText(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'DOM.requestChildNodes', { nodeId, depth: 1 });

    const result = await this.evaluate(tabId, `
      (() => {
        const node = window.webbrain_getNodeById(${nodeId});
        return node ? node.innerText : null;
      })()
    `).catch(() => null);

    return result?.result?.value || '';
  }

  /**
   * Highlight element with an overlay.
   */
  async highlightNode(tabId, nodeId) {
    await this.sendCommand(tabId, 'DOM.enable');
    const boxModel = await this.sendCommand(tabId, 'DOM.getBoxModel', { nodeId });
    if (!boxModel?.model) return null;

    const quad = boxModel.model.content;
    await this.sendCommand(tabId, 'Overlay.enable');
    await this.sendCommand(tabId, 'Overlay.highlightQuad', {
      quad,
      color: { r: 0, g: 200, b: 255, a: 0.3 },
      outlineColor: { r: 0, g: 100, b: 200, a: 1 },
    });

    return { success: true };
  }

  /**
   * Hide highlight overlay.
   */
  async hideHighlight(tabId) {
    try {
      await this.sendCommand(tabId, 'Overlay.hideHighlight');
    } catch {
      // Ignore if already hidden
    }
  }

  /**
   * Get all interactive elements with full DOM access.
   */
  async getInteractiveElements(tabId) {
    await this.sendCommand(tabId, 'DOM.enable');
    await this.sendCommand(tabId, 'DOM.getDocument', { depth: -1, pierce: true });

    const result = await this.evaluate(tabId, `
      (() => {
        const elements = [];
        const selectors = [
          'a[href]', 'button', 'input', 'textarea', 'select',
          '[role="button"]', '[role="link"]', '[role="tab"]',
          '[onclick]', '[data-action]', 'summary', 'label'
        ];

        const all = document.querySelectorAll(selectors.join(', '));
        all.forEach((el, index) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;

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
            isInShadowDOM: el.getRootNode() !== document,
          });
        });
        return elements;
      })()
    `);

    return result?.result?.value || [];
  }

  /**
   * Read page content with full DOM access.
   */
  async readPage(tabId) {
    const pageInfo = await this.evaluate(tabId, `
      (() => {
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
            id: form.id || 'form-' + i,
            action: form.action,
            inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(el => ({
              type: el.type || el.tagName.toLowerCase(),
              name: el.name,
              id: el.id,
              placeholder: el.placeholder || '',
              value: el.value || '',
            })),
          })),
          shadowHosts: Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot).map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            shadowRootMode: el.shadowRoot?.mode,
          })),
          iframes: Array.from(document.querySelectorAll('iframe')).map(iframe => ({
            src: iframe.src,
            id: iframe.id || '',
            name: iframe.name || '',
            visible: iframe.offsetWidth > 0 && iframe.offsetHeight > 0,
          })),
        };
      })()
    `);

    return pageInfo?.result?.value || pageInfo;
  }

  /**
   * Click element by selector using JS evaluation.
   */
  async clickElement(tabId, selector) {
    return await this.evaluate(tabId, `
      (() => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) return { success: false, error: 'Element not found' };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.click();
        return { success: true, tag: el.tagName, text: el.innerText?.slice(0, 50) };
      })()
    `);
  }

  /**
   * Type text into an element.
   */
  async typeText(tabId, selector, text, clear = false) {
    return await this.evaluate(tabId, `
      (() => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) return { success: false, error: 'Element not found' };

        el.focus();
        if (${clear}) {
          el.value = '';
        }

        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;

        if (setter) {
          setter.call(el, (${clear} ? '' : el.value) + '${text.replace(/'/g, "\\'")}');
        } else {
          el.value = (${clear} ? '' : el.value) + '${text.replace(/'/g, "\\'")}';
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        return { success: true, value: el.value.slice(0, 100) };
      })()
    `);
  }

  /**
   * Scroll page.
   */
  async scrollPage(tabId, direction, amount = 500) {
    const scrollCode = {
      down: `window.scrollBy(0, ${amount})`,
      up: `window.scrollBy(0, -${amount})`,
      top: 'window.scrollTo(0, 0)',
      bottom: 'window.scrollTo(0, document.body.scrollHeight)',
    };

    const result = await this.evaluate(tabId, `
      (() => {
        ${scrollCode[direction] || scrollCode.down};
        return {
          success: true,
          scrollY: window.scrollY,
          scrollHeight: document.body.scrollHeight,
          viewportHeight: window.innerHeight,
        };
      })()
    `);

    return result?.result?.value || result;
  }
}

export const cdpClient = new CDPClient();
