import { AGENT_TOOLS, getToolsForMode, SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT } from './tools.js';
import { getActiveAdapter } from './adapters.js';

/**
 * The WebBrain Agent — orchestrates multi-step LLM + tool-use loops.
 */
export class Agent {
  constructor(providerManager) {
    this.providerManager = providerManager;
    this.conversations = new Map(); // tabId -> messages[]
    this.abortFlags = new Map(); // tabId -> boolean
    this.maxSteps = 60; // safety limit for autonomous loops (configurable via settings)
    this.maxContextMessages = 50; // trim beyond this
    this.maxContextChars = 80000; // rough char budget (~20k tokens)
    this.autoScreenshot = 'state_change';
    this.useSiteAdapters = true;
    this.recentCalls = new Map();
    this.loopNudges = new Map();
    this.healthyCallsSinceLoop = new Map();
    this.lastAutoScreenshotTs = new Map();
    this.lastSeenAdapter = new Map();
  }

  // ---- Loop detection ----
  _recordCall(tabId, name, args, result) {
    const argsHash = JSON.stringify(args || {});
    const errored = !!(result && (result.error || result.success === false));
    const key = `${name}|${argsHash}|${errored ? 'err' : 'ok'}`;
    const buf = this.recentCalls.get(tabId) || [];
    buf.push({ key, name, ts: Date.now() });
    if (buf.length > 6) buf.shift();
    this.recentCalls.set(tabId, buf);
    return buf;
  }

  _detectLoop(buf) {
    if (!buf || buf.length < 3) return null;
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3) return { type: 'repeat', key, name: key.split('|')[0], count: n };
    }
    if (buf.length >= 4) {
      const last4 = buf.slice(-4);
      if (
        last4[0].key === last4[2].key &&
        last4[1].key === last4[3].key &&
        last4[0].key !== last4[1].key
      ) {
        return { type: 'oscillation', a: last4[0].name, b: last4[1].name };
      }
    }
    return null;
  }

  _clearLoopState(tabId) {
    this.recentCalls.delete(tabId);
    this.loopNudges.delete(tabId);
    this.healthyCallsSinceLoop.delete(tabId);
  }

  _checkLoop(tabId, toolName, toolArgs, toolResult) {
    const buf = this._recordCall(tabId, toolName, toolArgs, toolResult);
    const loop = this._detectLoop(buf);
    if (!loop) {
      // Healthy run — reset nudges only after a sustained streak.
      const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
      this.healthyCallsSinceLoop.set(tabId, healthy);
      if (healthy >= 6) {
        this.loopNudges.delete(tabId);
        this.healthyCallsSinceLoop.delete(tabId);
      }
      return { kind: 'none' };
    }
    this.healthyCallsSinceLoop.delete(tabId);
    const nudges = (this.loopNudges.get(tabId) || 0) + 1;
    this.loopNudges.set(tabId, nudges);
    if (nudges >= 2) {
      this._clearLoopState(tabId);
      const desc = loop.type === 'repeat'
        ? `the same call to ${loop.name}`
        : `between ${loop.a} and ${loop.b}`;
      return {
        kind: 'stop',
        message: `Stopped: I detected I was looping on ${desc} without making progress, even after a warning to try something different. Please tell me what's blocking, give me a different instruction, or take a look at the page yourself.`,
      };
    }
    const warning = loop.type === 'repeat'
      ? `[LOOP DETECTED: You've just called ${loop.name} ${loop.count} times with the same arguments and the same outcome. The current approach is NOT working. Do something fundamentally different on your next step: a different selector, a different tool, scroll to find a different element, take a screenshot to see what's actually on screen, or call done() if the task is impossible. DO NOT repeat this exact call again.]`
      : `[LOOP DETECTED: You're oscillating between ${loop.a} and ${loop.b} without making progress. Stop. Take a screenshot to see what's actually happening, then try a completely different approach.]`;
    return { kind: 'nudge', warning };
  }

  static NAV_TOOLS = new Set(['navigate', 'new_tab']);
  static STATE_CHANGE_TOOLS = new Set(['navigate', 'new_tab', 'click', 'type_text', 'scroll']);

  _shouldAutoScreenshot(toolName) {
    const mode = this.autoScreenshot;
    if (mode === 'off' || !mode) return false;
    if (mode === 'every_step') return true;
    if (mode === 'state_change') return Agent.STATE_CHANGE_TOOLS.has(toolName);
    if (mode === 'navigation') return Agent.NAV_TOOLS.has(toolName);
    return false;
  }

  /**
   * Re-inject site adapter notes if the user navigated to a different
   * adapted site mid-conversation.
   */
  async _maybeReinjectAdapter(tabId, messages) {
    if (!this.useSiteAdapters) return false;
    let url = '';
    try {
      const tab = await browser.tabs.get(tabId);
      url = tab?.url || '';
    } catch (e) { return false; }
    if (!url) return false;
    const adapter = getActiveAdapter(url);
    const lastName = this.lastSeenAdapter.get(tabId) || null;
    const currentName = adapter ? adapter.name : null;
    if (currentName === lastName) return false;
    this.lastSeenAdapter.set(tabId, currentName);
    if (!adapter) return false;
    const heading = adapter.category === 'finance'
      ? `[Site context changed → now on ${adapter.name} — FINANCE / HIGH-STAKES. Apply these rules from now on:]`
      : `[Site context changed → now on ${adapter.name}. Apply these notes from now on:]`;
    messages.push({
      role: 'user',
      content: `${heading}\n${adapter.notes.trim()}`,
    });
    return true;
  }

  /**
   * Shared tool-batch executor used by both processMessage and
   * processMessageStream so they can't drift.
   */
  async _executeToolBatch(tabId, toolCalls, messages, onUpdate, provider, partialAssistantText = null) {
    let didStateChange = false;
    for (const tc of toolCalls) {
      if (this._checkAbort(tabId)) {
        const value = partialAssistantText || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        return { action: 'return', value };
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

      if (toolResult && toolResult.done) {
        const finalResponse = toolResult.summary || partialAssistantText || 'Task completed.';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: this._limitToolResult(toolResult),
        });
        return { action: 'return', value: finalResponse };
      }

      const loopCheck = this._checkLoop(tabId, fnName, fnArgs, toolResult);
      let resultContent = this._limitToolResult(toolResult);
      if (loopCheck.kind === 'nudge') {
        resultContent = resultContent + '\n' + loopCheck.warning;
        onUpdate('warning', { message: 'Loop detected — nudging the agent.' });
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultContent,
      });
      if (loopCheck.kind === 'stop') {
        messages.push({ role: 'assistant', content: loopCheck.message });
        onUpdate('text', { content: loopCheck.message });
        onUpdate('error', { message: 'Stuck in a loop. Stopped.' });
        return { action: 'return', value: loopCheck.message };
      }
      if (this._shouldAutoScreenshot(fnName) && !toolResult?.error) {
        didStateChange = true;
      }
    }

    if (didStateChange && provider.supportsVision) {
      const lastTs = this.lastAutoScreenshotTs.get(tabId) || 0;
      if (Date.now() - lastTs >= 500) {
        await new Promise(r => setTimeout(r, 250));
        const shot = await this._captureAutoScreenshot(tabId);
        if (shot) {
          this.lastAutoScreenshotTs.set(tabId, Date.now());
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[Auto-screenshot of current viewport after the action above. Image is ${shot.width}×${shot.height} pixels = the CSS viewport at 1:1. A click at image pixel (X, Y) maps directly to click(x:X, y:Y). Use this to confirm the result and plan the next step. Prefer selector-based clicks when an element is identifiable; coordinate clicks are a last resort.]` },
              { type: 'image_url', image_url: { url: shot.dataUrl } },
            ],
          });
          onUpdate('tool_call', { name: 'auto_screenshot', args: {} });
          onUpdate('tool_result', { name: 'auto_screenshot', result: { success: true, bytes: shot.dataUrl.length } });
        }
      }
    }

    return { action: 'continue' };
  }

  /**
   * Capture a viewport screenshot via the WebExtension tabs API. Firefox
   * supports `scale: 1` on captureVisibleTab to force a CSS-pixel-aligned
   * image (otherwise it captures at devicePixelRatio, causing the same
   * coordinate-mismatch loop chrome had pre-1.5.1). Returns
   * { dataUrl, width, height } in CSS pixels, or null on failure.
   */
  async _captureAutoScreenshot(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (!tab) return null;
      // captureVisibleTab takes a windowId and snapshots whatever is currently
      // visible in that window — it does NOT take a tabId. If the agent's
      // tab isn't the active tab, we'd silently capture an unrelated page
      // and feed misleading visual context to the model. Skip in that case;
      // the model will plan from text only this turn.
      if (!tab.active) return null;
      // Get the actual viewport dimensions from the page so we can include
      // them in the prompt accompanying the screenshot.
      let w = 1024, h = 768;
      try {
        const dims = await browser.tabs.executeScript(tabId, {
          code: 'JSON.stringify({w: window.innerWidth, h: window.innerHeight})',
        });
        if (dims && dims[0]) {
          const parsed = JSON.parse(dims[0]);
          w = Math.max(1, Math.round(parsed.w));
          h = Math.max(1, Math.round(parsed.h));
        }
      } catch (e) { /* fall back to defaults */ }
      // scale: 1 forces 1 image pixel per CSS pixel (Firefox-specific option,
      // ignored by Chrome but Chrome path uses CDP anyway).
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 60,
        scale: 1,
      });
      if (!dataUrl) return null;
      return { dataUrl, width: w, height: h };
    } catch (e) {
      return null;
    }
  }

  /**
   * For the FIRST user message, attach page URL/title (always) and a
   * viewport screenshot (only when the active provider supports vision).
   */
  async _enrichFirstUserMessage(tabId, messages, userMessage) {
    const hasPriorUserTurn = messages.some(m => m.role === 'user');
    if (hasPriorUserTurn) return { role: 'user', content: userMessage };

    let url = '', title = '';
    try {
      const tab = await browser.tabs.get(tabId);
      url = tab?.url || '';
      title = tab?.title || '';
    } catch (e) { /* ignore */ }

    let contextLine = url
      ? `[Page context — URL: ${url}${title ? ` — Title: ${title}` : ''}]\n\n`
      : '';

    if (this.useSiteAdapters && url) {
      const adapter = getActiveAdapter(url);
      this.lastSeenAdapter.set(tabId, adapter ? adapter.name : null);
      if (adapter) {
        const heading = adapter.category === 'finance'
          ? `[Site guidance for ${adapter.name} — FINANCE / HIGH-STAKES]`
          : `[Site guidance for ${adapter.name}]`;
        contextLine += `${heading}\n${adapter.notes.trim()}\n\n`;
      }
    }

    const provider = this.providerManager.getActive();
    if (!provider.supportsVision) {
      return { role: 'user', content: contextLine + userMessage };
    }

    const shot = await this._captureAutoScreenshot(tabId);
    if (!shot) return { role: 'user', content: contextLine + userMessage };

    const screenshotNote = `[Initial viewport screenshot follows. The image is ${shot.width}×${shot.height} pixels and represents the visible viewport at a 1:1 CSS-pixel coordinate system — a click at image pixel (X, Y) corresponds exactly to a click tool call with x=X, y=Y. Prefer selector-based clicks (call get_interactive_elements first) when possible; only use coordinates as a last resort.]\n\n`;

    return {
      role: 'user',
      content: [
        { type: 'text', text: contextLine + screenshotNote + userMessage },
        { type: 'image_url', image_url: { url: shot.dataUrl } },
      ],
    };
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
      this._conversationMode = mode;
    }
    // If mode changed, update the system prompt
    if (this._conversationMode !== mode) {
      const messages = this.conversations.get(tabId);
      const systemPrompt = mode === 'act' ? SYSTEM_PROMPT_ACT : SYSTEM_PROMPT_ASK;
      if (messages[0]?.role === 'system') {
        messages[0].content = systemPrompt;
      }
      this._conversationMode = mode;
    }
    return this.conversations.get(tabId);
  }

  /**
   * Clear conversation for a tab.
   */
  clearConversation(tabId) {
    this.conversations.delete(tabId);
    this._clearLoopState(tabId);
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
      await browser.tabs.update(tabId, { url: args.url });
      // Wait a moment for navigation
      await new Promise(r => setTimeout(r, 2000));
      return { success: true, url: args.url };
    }

    if (name === 'new_tab') {
      const tab = await browser.tabs.create({ url: args.url });
      return { success: true, tabId: tab.id, url: args.url };
    }

    if (name === 'screenshot') {
      try {
        // Get the tab's window to capture. Firefox captureVisibleTab takes
        // a windowId and snapshots whatever's currently visible in that
        // window — not the tab we ask for. If the agent's tab isn't the
        // active tab, refuse rather than capture an unrelated page.
        const tab = await browser.tabs.get(tabId);
        if (!tab?.active) {
          return {
            success: false,
            error: 'Cannot capture screenshot: this tab is not the active tab in its window. Switch to the tab to take a screenshot, or use a different tool.',
          };
        }
        const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
          format: 'png',
          quality: 80,
        });
        // Return as base64 for vision-capable models
        return {
          success: true,
          image: dataUrl,
          description: `Screenshot captured (${dataUrl.length} bytes base64 PNG)`,
        };
      } catch (e) {
        return { success: false, error: `Screenshot failed: ${e.message}` };
      }
    }

    if (name === 'done') {
      return { done: true, summary: args.summary };
    }

    // Map tool names to content script actions
    const actionMap = {
      'read_page': 'get_page_info_cdp',
      'get_interactive_elements': 'get_interactive_elements_cdp',
      'get_shadow_dom': 'get_shadow_dom',
      'get_frames': 'get_frames',
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
      const response = await browser.tabs.sendMessage(tabId, {
        target: 'content',
        action,
        params: args,
      });
      return response;
    } catch (e) {
      // Content script might not be injected — try injecting it
      try {
        await browser.tabs.executeScript(tabId, {
          file: 'src/content/content.js',
        });
        const response = await browser.tabs.sendMessage(tabId, {
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
    const messages = this.getConversation(tabId, mode);

    // Trim context if it's getting too long
    await this._manageContext(tabId, messages);

    const enriched = await this._enrichFirstUserMessage(tabId, messages, userMessage);
    messages.push(enriched);

    const provider = this.providerManager.getActive();
    const tools = getToolsForMode(mode);
    let steps = 0;
    let finalResponse = '';

    this.abortFlags.delete(tabId); // clear any stale abort

    while (steps < this.maxSteps) {
      if (this._checkAbort(tabId)) {
        finalResponse = finalResponse || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

      if (steps > 0) {
        await this._maybeReinjectAdapter(tabId, messages);
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

        const batchResult = await this._executeToolBatch(
          tabId, result.toolCalls, messages, onUpdate, provider, result.content
        );
        if (batchResult.action === 'return') {
          finalResponse = batchResult.value;
          return finalResponse;
        }
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

    return finalResponse;
  }

  /**
   * Process a message with streaming output.
   */
  async processMessageStream(tabId, userMessage, onUpdate = () => {}, mode = 'ask') {
    const messages = this.getConversation(tabId, mode);

    // Trim context if it's getting too long
    await this._manageContext(tabId, messages);

    const enriched = await this._enrichFirstUserMessage(tabId, messages, userMessage);
    messages.push(enriched);

    const provider = this.providerManager.getActive();
    const tools = getToolsForMode(mode);
    let steps = 0;

    this.abortFlags.delete(tabId);

    while (steps < this.maxSteps) {
      if (this._checkAbort(tabId)) {
        onUpdate('warning', { message: 'Stopped by user.' });
        return '[Stopped by user]';
      }

      if (steps > 0) {
        await this._maybeReinjectAdapter(tabId, messages);
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
          const batchResult = await this._executeToolBatch(
            tabId, toolCalls, messages, onUpdate, provider, fullText
          );
          if (batchResult.action === 'return') {
            return batchResult.value;
          }
          continue;
        }

        // No tool calls — final response
        messages.push({ role: 'assistant', content: fullText });
        return fullText;

      } catch (e) {
        // If context overflow, trim and retry
        if (this._isContextOverflow(e.message)) {
          onUpdate('thinking', { step: steps, note: 'Context too large, trimming...' });
          this._emergencyTrim(messages);
          continue; // retry the loop with trimmed context
        }
        onUpdate('error', { message: e.message });
        const errMsg = `Error: ${e.message}`;
        messages.push({ role: 'assistant', content: errMsg });
        return errMsg;
      }
    }

    onUpdate('max_steps_reached', { steps: this.maxSteps });
    return '[Reached maximum steps limit. You can continue from where I left off.]';
  }
}
