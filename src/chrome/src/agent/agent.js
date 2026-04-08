import { AGENT_TOOLS, getToolsForMode, SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT } from './tools.js';
import { cdpClient } from '../cdp/cdp-client.js';
import { getActiveAdapter } from './adapters.js';

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
    // Whether to inject site adapter notes into the first user message of
    // each conversation. Loaded from chrome.storage.local. Default true.
    this.useSiteAdapters = true;
    // Loop detection: per-tab ring buffer of recent tool calls + nudge count.
    this.recentCalls = new Map(); // tabId -> [{ key, name, ts }]
    this.loopNudges = new Map();  // tabId -> consecutive-nudge counter
    this.healthyCallsSinceLoop = new Map(); // tabId -> count of clean calls since last nudge
    this.lastAutoScreenshotTs = new Map(); // tabId -> ms — defensive debounce
    this.lastSeenAdapter = new Map(); // tabId -> adapter name from last enrichment
    // Separate buffer for coordinate-based click attempts. The general loop
    // detector keys on JSON.stringify(args), so when the model interleaves
    // execute_js with different code strings between clicks, the same
    // (x,y) click never accumulates to the threshold inside its window.
    // This buffer tracks ONLY coord clicks and survives any amount of
    // unrelated noise between them, catching the "click missing its target,
    // model retries forever" failure mode in 2-3 attempts instead of never.
    this.recentCoordClicks = new Map(); // tabId -> [{ key, ts }]
  }

  // ---- Loop detection ----
  // Catches the agent stuck repeating an ineffective action or oscillating
  // between two calls. Cheap, runs after every tool execution. On first
  // detection we soft-nudge by injecting a [LOOP DETECTED] note into the
  // tool result the model sees. On second detection within the same loop,
  // we hard-stop the run with a clear final message.

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
    // 1. Same key 3+ times in the window.
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3) {
        return { type: 'repeat', key, name: key.split('|')[0], count: n };
      }
    }
    // 2. ABAB oscillation in the last 4.
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
    this.recentCoordClicks.delete(tabId);
  }

  /**
   * Coordinate-click loop detector. Buckets to nearest 5px so a click that
   * drifts by a pixel or two between attempts still hashes the same. Window
   * of 8 — generous, since the goal is to survive interleaved noise like
   * execute_js / type_text / read_page calls between coord retries.
   *
   * Returns 'nudge' on the 2nd repeat (much earlier than the general
   * detector's 3-of-same), and 'stop' on the 3rd. The reasoning: a coord
   * click that "succeeds" but doesn't change anything is the highest-cost
   * failure mode and should be caught fastest.
   */
  _checkCoordClickLoop(tabId, x, y) {
    const bx = Math.round(x / 5) * 5;
    const by = Math.round(y / 5) * 5;
    const key = `${bx},${by}`;
    const buf = this.recentCoordClicks.get(tabId) || [];
    buf.push({ key, ts: Date.now() });
    if (buf.length > 8) buf.shift();
    this.recentCoordClicks.set(tabId, buf);

    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    const n = counts.get(key) || 0;
    if (n >= 3) return { kind: 'stop', x: bx, y: by };
    if (n >= 2) return { kind: 'nudge', x: bx, y: by };
    return { kind: 'none' };
  }

  /**
   * Run loop detection on a freshly recorded call. Returns one of:
   *   { kind: 'none' }
   *   { kind: 'nudge', warning: string }   // soft warning to inject into tool result
   *   { kind: 'stop',  message: string }   // hard stop, abort the run
   */
  _checkLoop(tabId, toolName, toolArgs, toolResult) {
    const buf = this._recordCall(tabId, toolName, toolArgs, toolResult);
    const loop = this._detectLoop(buf);
    if (!loop) {
      // Healthy, non-looping call. We don't reset the nudge counter
      // immediately — that would let the agent escape detection by
      // doing one read_page between two stuck clicks. Only reset after
      // a sustained run of healthy calls (a full window's worth).
      const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
      this.healthyCallsSinceLoop.set(tabId, healthy);
      if (healthy >= 6) {
        this.loopNudges.delete(tabId);
        this.healthyCallsSinceLoop.delete(tabId);
      }
      return { kind: 'none' };
    }

    // Any new loop detection resets the healthy-streak counter.
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

    let contextLine = url
      ? `[Page context — URL: ${url}${title ? ` — Title: ${title}` : ''}]\n\n`
      : '';

    // Site adapter notes: if the URL matches a known site, inject the
    // non-obvious quirks the model would otherwise have to discover by trial.
    if (this.useSiteAdapters && url) {
      const adapter = getActiveAdapter(url);
      // Always remember the current adapter (or null) so mid-conversation
      // re-injection can detect a real change.
      this.lastSeenAdapter.set(tabId, adapter ? adapter.name : null);
      if (adapter) {
        const heading = adapter.category === 'finance'
          ? `[Site guidance for ${adapter.name} — FINANCE / HIGH-STAKES]`
          : `[Site guidance for ${adapter.name}]`;
        contextLine += `${heading}\n${adapter.notes.trim()}\n\n`;
      }
    }

    // Without vision, fall back to plain text context.
    const provider = this.providerManager.getActive();
    if (!provider.supportsVision) {
      return { role: 'user', content: contextLine + userMessage };
    }

    // With vision, attach a viewport screenshot.
    const shot = await this._captureAutoScreenshot(tabId);
    if (!shot) {
      return { role: 'user', content: contextLine + userMessage };
    }

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
   * After the first turn, the user may navigate or open a new site that has
   * a different adapter than the one used at conversation start. Detect that
   * and inject a fresh "Site context changed" message so the new adapter's
   * notes show up in the model's context for the next LLM call.
   *
   * Returns true if a re-injection happened (so callers can persist).
   */
  async _maybeReinjectAdapter(tabId, messages) {
    if (!this.useSiteAdapters) return false;
    let url = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab?.url || '';
    } catch (e) { return false; }
    if (!url) return false;

    const adapter = getActiveAdapter(url);
    const lastName = this.lastSeenAdapter.get(tabId) || null;
    const currentName = adapter ? adapter.name : null;

    if (currentName === lastName) return false;
    this.lastSeenAdapter.set(tabId, currentName);

    if (!adapter) return false; // moved off an adapted site → no inject needed

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
   * Execute one assistant turn's worth of tool calls. Both the non-streaming
   * and streaming paths call this so they share identical loop-detection,
   * persistence, and auto-screenshot behavior.
   *
   * Returns one of:
   *   { action: 'continue' }                  → caller should `continue` the LLM loop
   *   { action: 'return',   value: string }   → caller should return immediately
   *   { action: 'abort' }                     → user requested abort mid-batch
   */
  async _executeToolBatch(tabId, toolCalls, messages, onUpdate, provider, partialAssistantText = null) {
    let didStateChange = false;

    for (const tc of toolCalls) {
      // Abort check before each tool call.
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

      // done() short-circuit — push result, persist, and bail out.
      if (toolResult && toolResult.done) {
        const finalResponse = toolResult.summary || partialAssistantText || 'Task completed.';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: this._limitToolResult(toolResult),
        });
        this._persist(tabId);
        return { action: 'return', value: finalResponse };
      }

      // Loop detection — two parallel checks, strongest action wins.
      const loopCheck = this._checkLoop(tabId, fnName, fnArgs, toolResult);
      let coordCheck = { kind: 'none' };
      if (fnName === 'click' && fnArgs?.x != null && fnArgs?.y != null) {
        coordCheck = this._checkCoordClickLoop(tabId, fnArgs.x, fnArgs.y);
      }

      // Combine: stop > nudge > none.
      let effectiveKind = 'none';
      let nudgeWarning = '';
      let stopMessage = '';
      if (loopCheck.kind === 'stop' || coordCheck.kind === 'stop') {
        effectiveKind = 'stop';
        if (coordCheck.kind === 'stop') {
          stopMessage = `Stopped: I clicked at (or near) coordinates (${coordCheck.x}, ${coordCheck.y}) three times and the page never responded. That position is hitting empty space, an overlay, or the wrong element. Either there's no clickable target there, or you need a selector-based click instead. Please give a different instruction or check the page yourself.`;
        } else {
          stopMessage = loopCheck.message;
        }
      } else if (loopCheck.kind === 'nudge' || coordCheck.kind === 'nudge') {
        effectiveKind = 'nudge';
        if (coordCheck.kind === 'nudge') {
          nudgeWarning = `[COORDINATE LOOP DETECTED: You've clicked at or near (${coordCheck.x}, ${coordCheck.y}) twice with no visible page change. The click is missing its target — that position is empty space, an overlay, or the wrong element. STOP using these coordinates. Either: (a) call get_interactive_elements to find a real selector for the element you actually want, (b) call click({selector: "..."}) using a selector you've already discovered earlier in this conversation (look back at your prior tool calls), or (c) take a fresh screenshot and look more carefully at where the actual button is. DO NOT click these coordinates again — the next attempt will be hard-stopped.]`;
        } else {
          nudgeWarning = loopCheck.warning;
        }
      }

      let resultContent = this._limitToolResult(toolResult);
      if (effectiveKind === 'nudge') {
        resultContent = resultContent + '\n' + nudgeWarning;
        onUpdate('warning', { message: 'Loop detected — nudging the agent.' });
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultContent,
      });

      if (effectiveKind === 'stop') {
        messages.push({ role: 'assistant', content: stopMessage });
        onUpdate('text', { content: stopMessage });
        onUpdate('error', { message: 'Stuck in a loop. Stopped.' });
        this._clearLoopState(tabId);
        this._persist(tabId);
        return { action: 'return', value: stopMessage };
      }

      if (this._shouldAutoScreenshot(fnName) && !toolResult?.error) {
        didStateChange = true;
      }
    }

    // Auto-screenshot once per batch, debounced 500ms.
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

    this._persist(tabId);
    return { action: 'continue' };
  }

  /**
   * Capture a viewport JPEG via CDP, pinned to a 1:1 CSS-pixel coordinate
   * system. Returns { dataUrl, width, height } in CSS pixels, or null on
   * failure.
   *
   * Why the clip+scale dance: by default `Page.captureScreenshot` with
   * `fromSurface: true` captures at the native surface resolution, which on
   * any HiDPI display is `viewport CSS pixels × devicePixelRatio`. The
   * model then reads pixel coordinates from the image and emits them as
   * click coords — but `Input.dispatchMouseEvent` interprets coordinates as
   * CSS pixels, not surface pixels. On a DPR=2 display the click lands at
   * half the intended X/Y. Result: the agent appears to click but nothing
   * happens, then loops trying again. Forcing `clip.scale=1` with the
   * actual CSS viewport dimensions gives an image where pixel-(X,Y) maps
   * exactly to CSS-(X,Y), eliminating the offset.
   */
  async _captureAutoScreenshot(tabId) {
    try {
      await cdpClient.attach(tabId);
      await cdpClient.sendCommand(tabId, 'Page.enable');
      const vp = await cdpClient.evaluate(tabId, '({w: window.innerWidth, h: window.innerHeight})');
      const w = Math.max(1, Math.round(vp?.result?.value?.w || 1024));
      const h = Math.max(1, Math.round(vp?.result?.value?.h || 768));
      const shot = await cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 60,
        clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
      });
      if (!shot?.data) return null;
      return {
        dataUrl: `data:image/jpeg;base64,${shot.data}`,
        width: w,
        height: h,
      };
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
    this._clearLoopState(tabId);
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
          // Fallback to tabs API. captureVisibleTab takes a windowId and
          // captures whatever's visible in that window — NOT the tab we
          // ask for. If the agent's tab isn't currently the active tab,
          // we'd silently capture an unrelated page. Refuse and tell the
          // model so it can plan without misleading visual context.
          const tab = await chrome.tabs.get(tabId);
          if (!tab?.active) {
            return {
              success: false,
              error: 'Cannot capture screenshot: this tab is not the active tab in its window. Switch to the tab to take a screenshot, or use a different tool.',
            };
          }
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
        // chrome.scripting.executeScript with allFrames:true injects into
        // every frame in the tab, INCLUDING cross-origin iframes. This
        // bypasses the same-origin policy that page JS is subject to —
        // extensions with <all_urls> host_permission have this superpower
        // by design. Each result entry includes the frame's URL so we can
        // filter post-hoc.
        const urlFilter = args.urlFilter || '';
        const selector = args.selector || 'body';
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (sel) => {
            try {
              const el = document.querySelector(sel);
              return {
                ok: !!el,
                url: location.href,
                title: document.title || '',
                text: el ? (el.innerText || '').slice(0, 4000) : '',
                html: el ? (el.innerHTML || '').slice(0, 4000) : '',
                tag: el ? el.tagName : null,
              };
            } catch (e) {
              return { ok: false, url: location.href, error: e.message };
            }
          },
          args: [selector],
        });
        // results is an array of {frameId, result} entries — one per frame.
        const frames = results
          .map(r => r.result)
          .filter(r => r && (!urlFilter || (r.url && r.url.includes(urlFilter))));
        return { success: true, frameCount: frames.length, frames };
      } catch (e) {
        return { success: false, error: `Iframe read failed: ${e.message}` };
      }
    }

    if (name === 'iframe_click') {
      try {
        // Inject into all frames; in each frame, see if the selector resolves
        // and if the URL matches the optional filter, then click. Returns the
        // first successful frame.
        const urlFilter = args.urlFilter || '';
        const selector = args.selector;
        if (!selector) return { success: false, error: 'selector is required' };
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (sel, filter) => {
            if (filter && !location.href.includes(filter)) {
              return { ok: false, skipped: 'url-filter', url: location.href };
            }
            try {
              const el = document.querySelector(sel);
              if (!el) return { ok: false, url: location.href, reason: 'not-found' };
              el.scrollIntoView({ block: 'center', inline: 'center' });
              // Trigger a real-ish click sequence (frameworks often need
              // pointer events, not just click).
              const rect = el.getBoundingClientRect();
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
              try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.click();
              return {
                ok: true,
                url: location.href,
                tag: el.tagName,
                text: (el.innerText || el.value || '').slice(0, 80),
              };
            } catch (e) {
              return { ok: false, url: location.href, error: e.message };
            }
          },
          args: [selector, urlFilter],
        });
        const successes = results.map(r => r.result).filter(r => r && r.ok);
        if (successes.length > 0) {
          return { success: true, method: 'iframe-click', frame: successes[0] };
        }
        const candidates = results.map(r => r.result).filter(r => r && !r.skipped);
        return {
          success: false,
          error: 'Element not found in any matching iframe',
          searchedFrames: candidates.length,
          frameUrls: candidates.map(c => c.url).slice(0, 5),
        };
      } catch (e) {
        return { success: false, error: `Iframe click failed: ${e.message}` };
      }
    }

    if (name === 'iframe_type') {
      try {
        const urlFilter = args.urlFilter || '';
        const selector = args.selector;
        const text = args.text || '';
        const clear = !!args.clear;
        if (!selector) return { success: false, error: 'selector is required' };
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (sel, txt, clr, filter) => {
            if (filter && !location.href.includes(filter)) {
              return { ok: false, skipped: 'url-filter', url: location.href };
            }
            try {
              const el = document.querySelector(sel);
              if (!el) return { ok: false, url: location.href, reason: 'not-found' };
              el.focus();
              if (el.isContentEditable) {
                if (clr) el.textContent = '';
                el.textContent += txt;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: txt }));
                return { ok: true, url: location.href, method: 'contenteditable', value: el.textContent.slice(0, 100) };
              }
              const proto = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              const newVal = (clr ? '' : (el.value || '')) + txt;
              if (setter) setter.call(el, newVal); else el.value = newVal;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, url: location.href, method: 'native-setter', value: (el.value || '').slice(0, 100) };
            } catch (e) {
              return { ok: false, url: location.href, error: e.message };
            }
          },
          args: [selector, text, clear, urlFilter],
        });
        const successes = results.map(r => r.result).filter(r => r && r.ok);
        if (successes.length > 0) {
          return { success: true, frame: successes[0] };
        }
        const candidates = results.map(r => r.result).filter(r => r && !r.skipped);
        return {
          success: false,
          error: 'Input not found in any matching iframe',
          searchedFrames: candidates.length,
          frameUrls: candidates.map(c => c.url).slice(0, 5),
        };
      } catch (e) {
        return { success: false, error: `Iframe type failed: ${e.message}` };
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
        // Detect common LLM mistakes: jQuery / Playwright pseudo-classes
        // that look like CSS but aren't.
        if (args.selector && /:contains\(|:has-text\(/.test(args.selector)) {
          return {
            success: false,
            error: `Invalid selector: ":contains()" and ":has-text()" are not valid CSS — they are jQuery/Playwright extensions and browsers do not understand them. Use click({text: "..."}) to click by visible text instead, or click({index: N}) using an index from get_interactive_elements.`,
          };
        }
        if (args.text) {
          // Text-based click: find the first interactive element whose text
          // contains the given string (case-insensitive). Resolves in JS via
          // a simple walker over common interactive selectors. Then clicks
          // via the same robust CDP path.
          const result = await cdpClient.evaluate(tabId, `
            (() => {
              const needle = ${JSON.stringify(args.text.toLowerCase())};
              const sels = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="button"], input[type="submit"], summary, [onclick], [data-action]';
              const all = Array.from(document.querySelectorAll(sels));
              // Prefer exact text match, then prefix, then substring.
              const exact = all.find(el => (el.innerText || el.value || el.ariaLabel || '').trim().toLowerCase() === needle);
              const prefix = all.find(el => (el.innerText || el.value || el.ariaLabel || '').trim().toLowerCase().startsWith(needle));
              const sub = all.find(el => (el.innerText || el.value || el.ariaLabel || '').toLowerCase().includes(needle));
              const el = exact || prefix || sub;
              if (!el) return { found: false };
              try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
              const r = el.getBoundingClientRect();
              return {
                found: true,
                x: r.left + r.width / 2,
                y: r.top + r.height / 2,
                tag: el.tagName,
                text: (el.innerText || el.value || '').slice(0, 80),
              };
            })()
          `);
          const info = result?.result?.value;
          if (!info?.found) {
            return {
              success: false,
              error: `No clickable element found containing text "${args.text}". Try get_interactive_elements to see what's actually on the page, or take a screenshot.`,
            };
          }
          // Wait for scroll to settle, then dispatch a real click via CDP.
          await new Promise(r => setTimeout(r, 100));
          await cdpClient.dispatchMouseEvent(tabId, 'mouseMoved', info.x, info.y);
          await cdpClient.dispatchMouseEvent(tabId, 'mousePressed', info.x, info.y);
          await cdpClient.dispatchMouseEvent(tabId, 'mouseReleased', info.x, info.y);
          return {
            success: true,
            method: 'cdp-by-text',
            tag: info.tag,
            text: info.text,
            matched: args.text,
          };
        }
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
        // No selector and no index → type into the currently focused element
        // via CDP Input.insertText. The model is expected to have just
        // clicked the field in a prior tool call. This is the most reliable
        // path for forms with weird selectors (GitHub release[name],
        // Stripe-style nested inputs, etc.) — no resolution needed.
        if (args.index == null) {
          if (args.clear) {
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
            });
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65,
            });
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
            });
            await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
            });
          }
          await cdpClient.sendCommand(tabId, 'Input.insertText', { text: args.text || '' });
          return {
            success: true,
            method: 'cdp-insert-focused',
            text: (args.text || '').slice(0, 100),
            note: 'Typed into the currently focused element. If the page did not visibly update, no element was actually focused — click the target field first, then call type_text again with no selector.',
          };
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

      // Re-inject adapter notes if the user navigated to a different
      // high-traffic site mid-conversation (no-op on the first iteration
      // because _enrichFirstUserMessage already seeded lastSeenAdapter).
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
        // 'continue' → fall through to next loop iteration
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
