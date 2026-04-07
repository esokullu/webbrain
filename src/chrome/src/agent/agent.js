import { AGENT_TOOLS, getToolsForMode, SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT } from './tools.js';
import { cdpClient } from '../cdp/cdp-client.js';

/**
 * The WebBrain Agent — orchestrates multi-step LLM + tool-use loops.
 */
export class Agent {
  constructor(providerManager) {
    this.providerManager = providerManager;
    this.conversations = new Map(); // tabId -> messages[]
    this.conversationModes = new Map(); // tabId -> 'ask' | 'act'
    this.hydratedTabs = new Set(); // tabIds we've already pulled from storage
    this.persistTimers = new Map(); // tabId -> debounce handle
    this.abortFlags = new Map(); // tabId -> boolean
    this.maxSteps = 60; // safety limit for autonomous loops (configurable via settings)
    this.maxContextMessages = 50; // trim beyond this
    this.maxContextChars = 80000; // rough char budget (~20k tokens)
    // Auto-screenshot mode. 'off' | 'navigation' | 'state_change' | 'every_step'.
    // Loaded from chrome.storage.local in background.js.
    this.autoScreenshot = 'state_change';
  }

  // Tools whose successful completion should trigger an auto-screenshot when
  // the corresponding mode is active.
  static NAV_TOOLS = new Set(['navigate', 'new_tab']);
  static STATE_CHANGE_TOOLS = new Set(['navigate', 'new_tab', 'click', 'type_text', 'scroll']);

  /**
   * Decide whether to capture an auto-screenshot after a tool call, based on
   * the current setting and which tool ran.
   */
  _shouldAutoScreenshot(toolName) {
    const mode = this.autoScreenshot;
    if (mode === 'off' || !mode) return false;
    if (mode === 'every_step') return true;
    if (mode === 'state_change') return Agent.STATE_CHANGE_TOOLS.has(toolName);
    if (mode === 'navigation') return Agent.NAV_TOOLS.has(toolName);
    return false;
  }

  /**
   * Capture a viewport JPEG screenshot via CDP and return a data URL, or null
   * if capture fails. JPEG @ q60 keeps tokens reasonable (~1k–2k per image).
   */
  /**
   * For the FIRST user message in a conversation, attach the current page's
   * URL/title (always) and a viewport screenshot (if the active provider
   * supports vision). Subsequent turns return the user message unchanged.
   *
   * "First message" = no prior user/assistant turns in the message array
   * (system prompt may exist; summarized-trim acks may exist but those are
   * synthetic). We treat any conversation with no real user turn yet as
   * fresh context and seed it.
   */
  async _enrichFirstUserMessage(tabId, messages, userMessage) {
    const hasPriorUserTurn = messages.some(m => m.role === 'user');
    if (hasPriorUserTurn) {
      return { role: 'user', content: userMessage };
    }

    // Collect URL + title via chrome.tabs (cheap, no debugger needed).
    let url = '';
    let title = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab?.url || '';
      title = tab?.title || '';
    } catch (e) { /* ignore */ }

    const contextLine = url
      ? `[Page context — URL: ${url}${title ? ` — Title: ${title}` : ''}]\n\n`
      : '';

    // Without vision, fall back to plain text context.
    const provider = this.providerManager.getActive();
    if (!provider.supportsVision) {
      return { role: 'user', content: contextLine + userMessage };
    }

    // With vision, attach a viewport screenshot.
    const dataUrl = await this._captureAutoScreenshot(tabId);
    if (!dataUrl) {
      return { role: 'user', content: contextLine + userMessage };
    }

    return {
      role: 'user',
      content: [
        { type: 'text', text: contextLine + userMessage },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    };
  }

  async _captureAutoScreenshot(tabId) {
    try {
      await cdpClient.attach(tabId);
      await cdpClient.sendCommand(tabId, 'Page.enable');
      const shot = await cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 60,
        fromSurface: true,
      });
      if (!shot?.data) return null;
      return `data:image/jpeg;base64,${shot.data}`;
    } catch (e) {
      return null;
    }
  }

  // ---- Persistence: keep per-tab conversation state alive across service
  // worker restarts by mirroring it to chrome.storage.session. Without this,
  // killing the worker between turns means the model loses all prior context
  // even though the sidebar UI still shows the messages.

  _convKey(tabId) { return `agentConv:${tabId}`; }

  /**
   * Pull a tab's conversation from storage.session into memory if we haven't
   * already this worker lifetime. Safe to call repeatedly.
   */
  async _hydrate(tabId) {
    if (this.hydratedTabs.has(tabId)) return;
    this.hydratedTabs.add(tabId);
    if (this.conversations.has(tabId)) return;
    try {
      const key = this._convKey(tabId);
      const stored = await chrome.storage.session.get(key);
      const entry = stored?.[key];
      if (entry && Array.isArray(entry.messages) && entry.messages.length > 0) {
        this.conversations.set(tabId, entry.messages);
        if (entry.mode) {
          this.conversationModes.set(tabId, entry.mode);
          this._conversationMode = entry.mode;
        }
      }
    } catch (e) { /* session storage may be unavailable */ }
  }

  /**
   * Debounced write of a tab's conversation to storage.session. Multiple
   * rapid mutations within 300ms collapse into one write.
   */
  _persist(tabId) {
    if (tabId == null) return;
    const existing = this.persistTimers.get(tabId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.persistTimers.delete(tabId);
      const messages = this.conversations.get(tabId);
      if (!messages) return;
      const mode = this.conversationModes.get(tabId) || 'ask';
      try {
        chrome.storage.session.set({
          [this._convKey(tabId)]: { mode, messages },
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    }, 300);
    this.persistTimers.set(tabId, handle);
  }

  /**
   * Request abort for a specific tab's running agent.
   */
  abort(tabId) {
    this.abortFlags.set(tabId, true);
  }

  /**
   * Check and clear abort flag.
   */
  _checkAbort(tabId) {
    if (this.abortFlags.get(tabId)) {
      this.abortFlags.delete(tabId);
      return true;
    }
    return false;
  }

  /**
   * Get or create a conversation for a tab.
   */
  getConversation(tabId, mode = 'ask') {
    if (!this.conversations.has(tabId)) {
      const systemPrompt = mode === 'act' ? SYSTEM_PROMPT_ACT : SYSTEM_PROMPT_ASK;
      this.conversations.set(tabId, [
        { role: 'system', content: systemPrompt },
      ]);
      this.conversationModes.set(tabId, mode);
      this._conversationMode = mode;
    }
    // If mode changed, update the system prompt
    const lastMode = this.conversationModes.get(tabId);
    if (lastMode !== mode) {
      const messages = this.conversations.get(tabId);
      const systemPrompt = mode === 'act' ? SYSTEM_PROMPT_ACT : SYSTEM_PROMPT_ASK;
      if (messages[0]?.role === 'system') {
        messages[0].content = systemPrompt;
      }
      this.conversationModes.set(tabId, mode);
      this._conversationMode = mode;
    }
    return this.conversations.get(tabId);
  }

  /**
   * Clear conversation for a tab.
   */
  clearConversation(tabId) {
    this.conversations.delete(tabId);
    this.conversationModes.delete(tabId);
    this.hydratedTabs.delete(tabId);
    const t = this.persistTimers.get(tabId);
    if (t) { clearTimeout(t); this.persistTimers.delete(tabId); }
    try {
      chrome.storage.session.remove(this._convKey(tabId)).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  /**
   * Manage context window — trim and summarize when conversation gets too long.
   * Keeps: system prompt, summary of old messages, recent messages.
   */
  async _manageContext(tabId, messages) {
    // Calculate total char length
    let totalChars = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      totalChars += content.length;
      if (msg.tool_calls) totalChars += JSON.stringify(msg.tool_calls).length;
    }

    const tooManyMessages = messages.length > this.maxContextMessages;
    const tooManyChars = totalChars > this.maxContextChars;

    if (!tooManyMessages && !tooManyChars) return; // context is fine

    // Strategy: keep system prompt + summarize old messages + keep recent messages
    const systemMsg = messages[0]; // always the system prompt
    const keepRecent = 16; // keep last N messages verbatim
    const oldMessages = messages.slice(1, -keepRecent);
    const recentMessages = messages.slice(-keepRecent);

    if (oldMessages.length < 4) return; // not enough to summarize

    // Build a summary of old messages
    let summaryText = 'Previous conversation summary:\n';
    for (const msg of oldMessages) {
      if (msg.role === 'user') {
        summaryText += `- User asked: ${this._truncate(msg.content, 120)}\n`;
      } else if (msg.role === 'assistant' && msg.content && !msg.tool_calls) {
        summaryText += `- Assistant answered: ${this._truncate(msg.content, 150)}\n`;
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        const toolNames = msg.tool_calls.map(tc => tc.function?.name).join(', ');
        summaryText += `- Assistant used tools: ${toolNames}\n`;
      }
      // Skip tool result messages in summary (too verbose)
    }

    // Try to compress the summary using the LLM if it's still huge
    if (summaryText.length > 2000) {
      try {
        const provider = this.providerManager.getActive();
        const res = await provider.chat([
          { role: 'system', content: 'Summarize this conversation history in 3-5 bullet points. Be very concise.' },
          { role: 'user', content: summaryText },
        ], { maxTokens: 300, temperature: 0.2 });
        if (res.content) {
          summaryText = 'Summary of earlier conversation:\n' + res.content;
        }
      } catch {
        // If summarization fails, use the manual summary but truncate it
        summaryText = summaryText.slice(0, 2000) + '\n[...truncated]';
      }
    }

    // Rebuild: system + summary + recent
    const summaryMsg = { role: 'user', content: `[Context window was trimmed. ${summaryText}]` };
    const summaryAck = { role: 'assistant', content: 'Understood, I have the conversation context. Continuing.' };

    messages.length = 0;
    messages.push(systemMsg, summaryMsg, summaryAck, ...recentMessages);

    console.log(`[WebBrain] Context trimmed for tab ${tabId}: ${oldMessages.length} old messages → summary. ${messages.length} messages remain.`);
  }

  _truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  /**
   * Limit tool result size to avoid blowing up the context.
   * Page text in particular can be huge.
   */
  _limitToolResult(result) {
    const maxResultChars = 8000; // ~2k tokens
    let json = JSON.stringify(result);
    if (json.length <= maxResultChars) return json;

    // Try to trim the 'text' field specifically (page content)
    if (result && typeof result.text === 'string' && result.text.length > 4000) {
      const trimmed = { ...result, text: result.text.slice(0, 4000) + '\n[...page text truncated]' };
      json = JSON.stringify(trimmed);
      if (json.length <= maxResultChars) return json;
    }

    // If still too big, just chop the JSON
    return json.slice(0, maxResultChars) + '\n[...result truncated]';
  }

  /**
   * Detect if an error is a context overflow from any provider.
   */
  _isContextOverflow(error) {
    const msg = (error?.message || error || '').toLowerCase();
    return msg.includes('context') ||
           msg.includes('token') ||
           msg.includes('exceed') ||
           msg.includes('too long') ||
           msg.includes('maximum context') ||
           msg.includes('context_length_exceeded') ||
           msg.includes('exceed_context_size');
  }

  /**
   * Emergency context trim — aggressively cut to fit.
   * Called when LLM returns a context overflow error.
   * Keeps system prompt + only the last few messages.
   */
  _emergencyTrim(messages) {
    const systemMsg = messages[0];
    const keepLast = 6; // keep only 6 most recent messages
    const recent = messages.slice(-keepLast);

    // Also truncate any huge tool results in remaining messages
    for (const msg of recent) {
      if (msg.role === 'tool' && msg.content && msg.content.length > 2000) {
        msg.content = msg.content.slice(0, 2000) + '\n[...truncated due to context limit]';
      }
      if (typeof msg.content === 'string' && msg.content.length > 5000) {
        msg.content = msg.content.slice(0, 5000) + '\n[...truncated due to context limit]';
      }
    }

    const notice = {
      role: 'user',
      content: '[Context was too large for the model. Older messages were removed. Please continue based on what you can see.]',
    };
    const ack = {
      role: 'assistant',
      content: 'Understood, some earlier context was trimmed. I\'ll continue with what I have.',
    };

    messages.length = 0;
    messages.push(systemMsg, notice, ack, ...recent);

    console.log(`[WebBrain] Emergency context trim: kept ${messages.length} messages.`);
  }

  /**
   * Execute a tool call by dispatching to the content script or chrome APIs.
   */
  async executeTool(tabId, name, args) {
    // Tools handled by the background/service worker
    if (name === 'navigate') {
      await chrome.tabs.update(tabId, { url: args.url });
      // Wait a moment for navigation
      await new Promise(r => setTimeout(r, 2000));
      return { success: true, url: args.url };
    }

    if (name === 'new_tab') {
      const tab = await chrome.tabs.create({ url: args.url });
      return { success: true, tabId: tab.id, url: args.url };
    }

    if (name === 'screenshot') {
      try {
        // Try CDP first for better quality, fallback to tabs API
        try {
          await cdpClient.attach(tabId);
          await cdpClient.sendCommand(tabId, 'Page.enable');
          const screenshot = await cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
            format: 'png',
            quality: 100,
            fromSurface: true,
          });
          return {
            success: true,
            image: `data:image/png;base64,${screenshot.data}`,
            description: `Screenshot captured via CDP (${screenshot.data.length} bytes)`,
          };
        } catch {
          // Fallback to tabs API
          const tab = await chrome.tabs.get(tabId);
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: 'png',
            quality: 80,
          });
          return {
            success: true,
            image: dataUrl,
            description: `Screenshot captured (${dataUrl.length} bytes base64 PNG)`,
          };
        }
      } catch (e) {
        return { success: false, error: `Screenshot failed: ${e.message}` };
      }
    }

    if (name === 'done') {
      return { done: true, summary: args.summary };
    }

    if (name === 'full_page_screenshot') {
      try {
        await cdpClient.attach(tabId);
        const imageData = await cdpClient.captureFullPageScreenshot(tabId);
        return {
          success: true,
          image: `data:image/png;base64,${imageData}`,
          description: `Full page screenshot captured (${imageData.length} bytes)`,
        };
      } catch (e) {
        return { success: false, error: `Full page screenshot failed: ${e.message}` };
      }
    }

    if (name === 'get_shadow_dom') {
      try {
        await cdpClient.attach(tabId);
        const pageInfo = await cdpClient.readPage(tabId);
        return {
          success: true,
          shadowHosts: pageInfo.shadowHosts || [],
        };
      } catch (e) {
        return { success: false, error: `Failed to get shadow DOM info: ${e.message}` };
      }
    }

    if (name === 'shadow_dom_query') {
      try {
        await cdpClient.attach(tabId);
        await cdpClient.sendCommand(tabId, 'DOM.enable');
        await cdpClient.sendCommand(tabId, 'DOM.getDocument', { depth: 0 });

        const result = await cdpClient.evaluate(tabId, `
          (() => {
            const results = [];
            const pierce = (root, sel) => {
              try {
                const els = root.querySelectorAll(sel);
                els.forEach(el => {
                  results.push({
                    tag: el.tagName.toLowerCase(),
                    text: (el.innerText || '').trim().slice(0, 100),
                    id: el.id || '',
                    hasShadowRoot: !!el.shadowRoot,
                    shadowMode: el.shadowRoot?.mode || null,
                  });
                });
              } catch (e) {}
              root.querySelectorAll('*').forEach(host => {
                if (host.shadowRoot) pierce(host.shadowRoot, sel);
              });
            };
            pierce(document, '${args.selector.replace(/'/g, "\\'")}');
            return results;
          })()
        `);
        return { success: true, elements: result?.result?.value || [] };
      } catch (e) {
        return { success: false, error: `Shadow DOM query failed: ${e.message}` };
      }
    }

    if (name === 'get_frames') {
      try {
        await cdpClient.attach(tabId);
        const frames = await cdpClient.getAllFrames(tabId);
        return { success: true, frames };
      } catch (e) {
        return { success: false, error: `Failed to get frames: ${e.message}` };
      }
    }

    if (name === 'iframe_read') {
      try {
        await cdpClient.attach(tabId);
        const result = await cdpClient.evaluate(tabId, `
          (() => {
            const frames = window.frames;
            for (let i = 0; i < frames.length; i++) {
              try {
                const frame = frames[i];
                const sel = '${(args.selector || 'body').replace(/'/g, "\\'")}';
                const el = frame.document?.querySelector ? frame.document.querySelector(sel) : null;
                if (el) {
                  return {
                    frameIndex: i,
                    frameName: frame.name || '',
                    content: el.innerText || '',
                    html: el.innerHTML?.slice(0, 5000) || '',
                  };
                }
              } catch (e) {}
            }
            return { error: 'Could not access iframe content (cross-origin)' };
          })()
        `);
        return { success: true, ...result?.result?.value };
      } catch (e) {
        return { success: false, error: `Iframe read failed: ${e.message}` };
      }
    }

    if (name === 'download_file') {
      try {
        const result = await cdpClient.downloadFile(tabId, args.url, args.filename);
        return result;
      } catch (e) {
        return { success: false, error: `Download failed: ${e.message}` };
      }
    }

    if (name === 'upload_file') {
      try {
        await cdpClient.attach(tabId);
        const nodeIds = await cdpClient.querySelectorPierce(tabId, args.selector);
        if (!nodeIds || nodeIds.length === 0) {
          return { success: false, error: 'File input not found' };
        }
        await cdpClient.setFileInputFiles(tabId, nodeIds[0], [args.filePath]);
        return { success: true, file: args.filePath };
      } catch (e) {
        return { success: false, error: `Upload failed: ${e.message}` };
      }
    }

    // Click/type are routed through CDP for robust shadow-DOM piercing,
    // real Input.dispatchMouseEvent / Input.insertText events, and
    // selector-resolution retry. The content-script versions only see flat
    // document.querySelector and el.click(), which fails on Web Components,
    // closed shadow roots, and many React/Vue handlers.
    if (name === 'click') {
      try {
        await cdpClient.attach(tabId);
        if (args.selector) {
          return await cdpClient.clickElement(tabId, args.selector);
        }
        if (args.x != null && args.y != null) {
          await cdpClient.dispatchMouseEvent(tabId, 'mouseMoved', args.x, args.y);
          await cdpClient.dispatchMouseEvent(tabId, 'mousePressed', args.x, args.y);
          await cdpClient.dispatchMouseEvent(tabId, 'mouseReleased', args.x, args.y);
          return { success: true, method: 'cdp-coords', x: args.x, y: args.y };
        }
        // index-based: fall through to content-script path which knows the
        // interactive-elements ordering.
      } catch (e) {
        return { success: false, error: `Click failed: ${e.message}` };
      }
    }

    if (name === 'type_text') {
      try {
        await cdpClient.attach(tabId);
        if (args.selector) {
          return await cdpClient.typeText(tabId, args.selector, args.text || '', !!args.clear);
        }
        // index-based: fall through to content-script path.
      } catch (e) {
        return { success: false, error: `Type failed: ${e.message}` };
      }
    }

    // Map tool names to content script actions
    const actionMap = {
      'read_page': 'get_page_info_cdp',
      'get_interactive_elements': 'get_interactive_elements_cdp',
      'click': 'click',
      'type_text': 'type',
      'scroll': 'scroll',
      'extract_data': 'extract_data',
      'wait_for_element': 'wait_for_element',
      'get_selection': 'get_selection',
      'execute_js': 'execute_js',
    };

    const action = actionMap[name];
    if (!action) {
      return { error: `Unknown tool: ${name}` };
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        target: 'content',
        action,
        params: args,
      });
      return response;
    } catch (e) {
      // Content script might not be injected — try injecting it
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content/content.js'],
        });
        const response = await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action,
          params: args,
        });
        return response;
      } catch (e2) {
        return { error: `Failed to communicate with page: ${e2.message}` };
      }
    }
  }

  /**
   * Continue processing from where we left off (after max steps).
   * Adds a "please continue" user message and resumes the agent loop.
   */
  async continueProcessing(tabId, onUpdate = () => {}, mode = 'ask') {
    return this.processMessage(tabId, 'Please continue from where you left off.', onUpdate, mode);
  }

  /**
   * Process a single user message — may trigger a multi-step tool-use loop.
   * @param {number} tabId
   * @param {string} userMessage
   * @param {function} onUpdate - callback(type, data) for streaming updates
   * @returns {Promise<string>} final text response
   */
  async processMessage(tabId, userMessage, onUpdate = () => {}, mode = 'ask') {
    await this._hydrate(tabId);
    const messages = this.getConversation(tabId, mode);

    // Trim context if it's getting too long
    await this._manageContext(tabId, messages);

    const enriched = await this._enrichFirstUserMessage(tabId, messages, userMessage);
    messages.push(enriched);
    this._persist(tabId);

    const provider = this.providerManager.getActive();
    const tools = getToolsForMode(mode);
    let steps = 0;
    let finalResponse = '';

    this.abortFlags.delete(tabId); // clear any stale abort

    while (steps < this.maxSteps) {
      // Check for abort before each step
      if (this._checkAbort(tabId)) {
        finalResponse = finalResponse || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

      steps++;
      onUpdate('thinking', { step: steps });

      let result;
      try {
        const useTools = provider.supportsTools;
        result = await provider.chat(messages, {
          tools: useTools ? tools : undefined,
          temperature: 0.3,
          maxTokens: 4096,
        });
      } catch (e) {
        // If context overflow, trim aggressively and retry once
        if (this._isContextOverflow(e.message)) {
          onUpdate('thinking', { step: steps, note: 'Context too large, trimming...' });
          this._emergencyTrim(messages);
          try {
            const useTools = provider.supportsTools;
            result = await provider.chat(messages, {
              tools: useTools ? tools : undefined,
              temperature: 0.3,
              maxTokens: 4096,
            });
          } catch (e2) {
            onUpdate('error', { message: `Context still too large after trimming: ${e2.message}` });
            finalResponse = 'The conversation got too long. Please start a new conversation (click the + button).';
            messages.push({ role: 'assistant', content: finalResponse });
            break;
          }
        } else {
          onUpdate('error', { message: e.message });
          finalResponse = `Error communicating with LLM: ${e.message}`;
          messages.push({ role: 'assistant', content: finalResponse });
          break;
        }
      }

      // Check for abort after LLM response
      if (this._checkAbort(tabId)) {
        finalResponse = result?.content || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

      if (result.toolCalls && result.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls,
        });

        if (result.content) {
          onUpdate('text', { content: result.content });
        }

        let didStateChange = false;

        for (const tc of result.toolCalls) {
          // Check abort before each tool execution
          if (this._checkAbort(tabId)) {
            finalResponse = result.content || '[Stopped by user]';
            onUpdate('warning', { message: 'Stopped by user.' });
            return finalResponse;
          }

          const fnName = tc.function.name;
          let fnArgs;
          try {
            fnArgs = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments;
          } catch {
            fnArgs = {};
          }

          onUpdate('tool_call', { name: fnName, args: fnArgs });

          const toolResult = await this.executeTool(tabId, fnName, fnArgs);

          onUpdate('tool_result', { name: fnName, result: toolResult });

          // Check if the agent signaled completion
          if (toolResult.done) {
            finalResponse = toolResult.summary || result.content || 'Task completed.';
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: this._limitToolResult(toolResult),
            });
            this._persist(tabId);
            // Don't continue the loop
            return finalResponse;
          }

          // Add tool result to conversation
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: this._limitToolResult(toolResult),
          });

          if (this._shouldAutoScreenshot(fnName) && !toolResult?.error) {
            didStateChange = true;
          }
        }

        // Auto-screenshot: if any state-changing tool ran in this batch and
        // the active provider supports vision, capture the viewport once and
        // inject it as a synthetic user message before the next LLM turn.
        if (didStateChange && provider.supportsVision) {
          // Give the page a beat to settle (animations, hydration).
          await new Promise(r => setTimeout(r, 250));
          const dataUrl = await this._captureAutoScreenshot(tabId);
          if (dataUrl) {
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: '[Auto-screenshot of current viewport after the action above. Use this to confirm the result and plan the next step.]' },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            });
            onUpdate('tool_call', { name: 'auto_screenshot', args: {} });
            onUpdate('tool_result', { name: 'auto_screenshot', result: { success: true, bytes: dataUrl.length } });
          }
        }

        this._persist(tabId);
        // Continue the loop — the LLM will see the tool results
        continue;
      }

      // No tool calls — this is the final text response
      finalResponse = result.content || '';
      messages.push({ role: 'assistant', content: finalResponse });
      onUpdate('text', { content: finalResponse });
      break;
    }

    if (steps >= this.maxSteps) {
      onUpdate('max_steps_reached', { steps: this.maxSteps });
    }

    this._persist(tabId);
    return finalResponse;
  }

  /**
   * Process a message with streaming output.
   */
  async processMessageStream(tabId, userMessage, onUpdate = () => {}, mode = 'ask') {
    await this._hydrate(tabId);
    const messages = this.getConversation(tabId, mode);

    // Trim context if it's getting too long
    await this._manageContext(tabId, messages);

    const enriched = await this._enrichFirstUserMessage(tabId, messages, userMessage);
    messages.push(enriched);
    this._persist(tabId);

    const provider = this.providerManager.getActive();
    const tools = getToolsForMode(mode);
    let steps = 0;

    this.abortFlags.delete(tabId);

    while (steps < this.maxSteps) {
      if (this._checkAbort(tabId)) {
        onUpdate('warning', { message: 'Stopped by user.' });
        return '[Stopped by user]';
      }

      steps++;
      onUpdate('thinking', { step: steps });

      try {
        let fullText = '';
        let toolCallsAccumulator = {};
        let hasToolCalls = false;

        for await (const chunk of provider.chatStream(messages, {
          tools: provider.supportsTools ? tools : undefined,
          temperature: 0.3,
          maxTokens: 4096,
        })) {
          if (chunk.type === 'text') {
            fullText += chunk.content;
            onUpdate('text_delta', { content: chunk.content });
          } else if (chunk.type === 'tool_call') {
            hasToolCalls = true;
            // Accumulate streaming tool call deltas (OpenAI format)
            for (const tc of chunk.content) {
              const idx = tc.index ?? 0;
              if (!toolCallsAccumulator[idx]) {
                toolCallsAccumulator[idx] = { id: '', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCallsAccumulator[idx].id = tc.id;
              if (tc.function?.name) toolCallsAccumulator[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCallsAccumulator[idx].function.arguments += tc.function.arguments;
            }
          } else if (chunk.type === 'tool_call_start') {
            hasToolCalls = true;
            const idx = Object.keys(toolCallsAccumulator).length;
            toolCallsAccumulator[idx] = {
              id: chunk.content.id,
              function: { name: chunk.content.name, arguments: '' },
            };
          } else if (chunk.type === 'tool_call_delta') {
            const idx = Object.keys(toolCallsAccumulator).length - 1;
            if (toolCallsAccumulator[idx]) {
              toolCallsAccumulator[idx].function.arguments += chunk.content;
            }
          } else if (chunk.type === 'done') {
            break;
          }
        }

        if (hasToolCalls) {
          const toolCalls = Object.values(toolCallsAccumulator);
          messages.push({
            role: 'assistant',
            content: fullText || null,
            tool_calls: toolCalls,
          });

          let didStateChange = false;

          for (const tc of toolCalls) {
            const fnName = tc.function.name;
            let fnArgs;
            try {
              fnArgs = JSON.parse(tc.function.arguments);
            } catch {
              fnArgs = {};
            }

            onUpdate('tool_call', { name: fnName, args: fnArgs });
            const toolResult = await this.executeTool(tabId, fnName, fnArgs);
            onUpdate('tool_result', { name: fnName, result: toolResult });

            if (toolResult.done) {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: this._limitToolResult(toolResult),
              });
              this._persist(tabId);
              return toolResult.summary || fullText || 'Task completed.';
            }

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: this._limitToolResult(toolResult),
            });

            if (this._shouldAutoScreenshot(fnName) && !toolResult?.error) {
              didStateChange = true;
            }
          }

          if (didStateChange && provider.supportsVision) {
            await new Promise(r => setTimeout(r, 250));
            const dataUrl = await this._captureAutoScreenshot(tabId);
            if (dataUrl) {
              messages.push({
                role: 'user',
                content: [
                  { type: 'text', text: '[Auto-screenshot of current viewport after the action above. Use this to confirm the result and plan the next step.]' },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              });
              onUpdate('tool_call', { name: 'auto_screenshot', args: {} });
              onUpdate('tool_result', { name: 'auto_screenshot', result: { success: true, bytes: dataUrl.length } });
            }
          }

          this._persist(tabId);
          continue;
        }

        // No tool calls — final response
        messages.push({ role: 'assistant', content: fullText });
        this._persist(tabId);
        return fullText;

      } catch (e) {
        // If context overflow, trim and retry
        if (this._isContextOverflow(e.message)) {
          onUpdate('thinking', { step: steps, note: 'Context too large, trimming...' });
          this._emergencyTrim(messages);
          this._persist(tabId);
          continue; // retry the loop with trimmed context
        }
        onUpdate('error', { message: e.message });
        const errMsg = `Error: ${e.message}`;
        messages.push({ role: 'assistant', content: errMsg });
        this._persist(tabId);
        return errMsg;
      }
    }

    onUpdate('max_steps_reached', { steps: this.maxSteps });
    this._persist(tabId);
    return '[Reached maximum steps limit. You can continue from where I left off.]';
  }
}
