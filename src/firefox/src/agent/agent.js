import { AGENT_TOOLS, AGENT_TOOL_NAMES, getToolsForMode, SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT } from './tools.js';
import { getActiveAdapter } from './adapters.js';
import {
  fetchUrl,
  researchUrl,
  listDownloads,
  readDownloadedFile,
  downloadResourceFromPage,
  downloadFiles,
} from '../network/network-tools.js';

/**
 * The WebBrain Agent — orchestrates multi-step LLM + tool-use loops.
 */
export class Agent {
  constructor(providerManager) {
    this.providerManager = providerManager;
    this.conversations = new Map(); // tabId -> messages[]
    this.abortFlags = new Map(); // tabId -> boolean
    this.maxSteps = 120; // safety limit for autonomous loops (configurable via settings)
    this.maxContextMessages = 50; // trim beyond this
    this._debugLog = []; // ring buffer for deep verbose (LLM requests/responses)
    this._debugLogMax = 200; // max entries before oldest are dropped
    this.maxContextChars = 80000; // rough char budget (~20k tokens)
    this.autoScreenshot = 'state_change';
    this.useSiteAdapters = true;
    this.recentCalls = new Map();
    this.loopNudges = new Map();
    this.healthyCallsSinceLoop = new Map();
    this.lastAutoScreenshotTs = new Map();
    this.lastSeenAdapter = new Map();
    this.recentCoordClicks = new Map();
    this.apiAllowedTabs = new Set();
    this.apiAllowedInjected = new Set();
  }

  setApiMutationsAllowed(tabId, allowed) {
    if (allowed) {
      this.apiAllowedTabs.add(tabId);
    } else {
      this.apiAllowedTabs.delete(tabId);
      this.apiAllowedInjected.delete(tabId);
    }
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
    this.recentCoordClicks.delete(tabId);
  }

  _checkCoordClickLoop(tabId, x, y) {
    const bx = Math.round(x / 5) * 5;
    const by = Math.round(y / 5) * 5;
    const key = `${bx},${by}`;
    const buf = this.recentCoordClicks.get(tabId) || [];
    buf.push({ key, ts: Date.now() });
    if (buf.length > 12) buf.shift();
    this.recentCoordClicks.set(tabId, buf);
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    const n = counts.get(key) || 0;
    if (n >= 8) return { kind: 'stop', x: bx, y: by };
    if (n >= 5) return { kind: 'nudge', x: bx, y: by };
    return { kind: 'none' };
  }

  _checkLoop(tabId, toolName, toolArgs, toolResult) {
    const buf = this._recordCall(tabId, toolName, toolArgs, toolResult);
    const loop = this._detectLoop(buf);
    if (!loop) {
      // Healthy run — reset nudges only after a sustained streak.
      const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
      this.healthyCallsSinceLoop.set(tabId, healthy);
      if (healthy >= 2) {
        this.loopNudges.delete(tabId);
        this.healthyCallsSinceLoop.delete(tabId);
      }
      return { kind: 'none' };
    }
    this.healthyCallsSinceLoop.delete(tabId);
    const nudges = (this.loopNudges.get(tabId) || 0) + 1;
    this.loopNudges.set(tabId, nudges);
    if (nudges >= 8) {
      this._clearLoopState(tabId);
      const desc = loop.type === 'repeat'
        ? `the same call to ${loop.name}`
        : `between ${loop.a} and ${loop.b}`;
      return {
        kind: 'stop',
        message: `Stopped: I detected I was looping on ${desc} without making progress after multiple warnings. Please tell me what's blocking, give me a different instruction, or take a look at the page yourself.`,
      };
    }
    const warning = loop.type === 'repeat'
      ? `[LOOP DETECTED: You've just called ${loop.name} ${loop.count} times with the same arguments and the same outcome. The current approach is NOT working. Try something fundamentally different: a different selector, a different tool, scroll to find a different element, or take a screenshot to see what's actually on screen. DO NOT repeat this exact call again — try a creative alternative.]`
      : `[LOOP DETECTED: You're oscillating between ${loop.a} and ${loop.b} without making progress. Stop. Take a screenshot to see what's actually happening, then try a completely different approach.]`;
    return { kind: 'nudge', warning };
  }

  static NAV_TOOLS = new Set(['navigate', 'new_tab']);
  static STATE_CHANGE_TOOLS = new Set(['navigate', 'new_tab', 'click', 'type_text', 'press_keys', 'scroll']);

  _shouldAutoScreenshot(toolName) {
    const mode = this.autoScreenshot;
    if (mode === 'off' || !mode) return false;
    if (mode === 'every_step') return true;
    if (mode === 'state_change') return Agent.STATE_CHANGE_TOOLS.has(toolName);
    if (mode === 'navigation') return Agent.NAV_TOOLS.has(toolName);
    return false;
  }

  async _currentUrl(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      return tab?.url || '';
    } catch (e) { return ''; }
  }

  _normalizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) { return url; }
  }

  async _getVisibleInteractiveElements(tabId) {
    try {
      const code = `
        (() => {
          const sels = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), textarea, select, summary, [onclick]';
          const all = Array.from(document.querySelectorAll(sels));
          const out = [];
          for (const el of all) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.bottom < 0 || r.top > window.innerHeight) continue;
            if (r.right < 0 || r.left > window.innerWidth) continue;
            const text = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().slice(0, 50);
            if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') continue;
            out.push({
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              text: text || '<' + el.tagName.toLowerCase() + '>',
            });
            if (out.length >= 25) break;
          }
          return out;
        })()
      `;
      const result = await browser.tabs.executeScript(tabId, { code });
      return (result && result[0]) || [];
    } catch (e) {
      return [];
    }
  }

  _formatElementsList(elements) {
    if (!elements || elements.length === 0) return '';
    const lines = elements.map(e => {
      const tagInfo = e.type ? `${e.tag}[${e.type}]` : e.tag;
      return `  (${e.x},${e.y}) ${tagInfo} "${e.text}"`;
    });
    return `\nVisible interactive elements at these positions (use these names with click({text:"..."}) — much more reliable than guessing coordinates from the image):\n${lines.join('\n')}`;
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
    const NAV_PRONE_TOOLS = new Set(['click', 'navigate', 'execute_js', 'iframe_click']);
    const navNotices = [];

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

      let beforeUrl = '';
      if (NAV_PRONE_TOOLS.has(fnName)) {
        beforeUrl = await this._currentUrl(tabId);
      }

      onUpdate('tool_call', { name: fnName, args: fnArgs });
      const toolResult = await this.executeTool(tabId, fnName, fnArgs);
      onUpdate('tool_result', { name: fnName, result: toolResult });

      if (NAV_PRONE_TOOLS.has(fnName) && beforeUrl && !toolResult?.error) {
        await new Promise(r => setTimeout(r, 200));
        const afterUrl = await this._currentUrl(tabId);
        const beforeNorm = this._normalizeUrl(beforeUrl);
        const afterNorm = this._normalizeUrl(afterUrl);
        if (beforeNorm && afterNorm && beforeNorm !== afterNorm && fnName !== 'navigate') {
          navNotices.push({ before: beforeUrl, after: afterUrl, viaTool: fnName });
        }
      }

      if (toolResult && toolResult.done) {
        const finalResponse = toolResult.summary || partialAssistantText || 'Task completed.';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: this._limitToolResult(toolResult),
        });
        return { action: 'return', value: finalResponse };
      }

      // Loop detection — general + coordinate-specific. Strongest wins.
      const loopCheck = this._checkLoop(tabId, fnName, fnArgs, toolResult);
      let coordCheck = { kind: 'none' };
      if (fnName === 'click' && fnArgs?.x != null && fnArgs?.y != null) {
        coordCheck = this._checkCoordClickLoop(tabId, fnArgs.x, fnArgs.y);
      }

      let effectiveKind = 'none';
      let nudgeWarning = '';
      let stopMessage = '';
      if (loopCheck.kind === 'stop' || coordCheck.kind === 'stop') {
        effectiveKind = 'stop';
        stopMessage = coordCheck.kind === 'stop'
          ? `Stopped: I clicked at (or near) coordinates (${coordCheck.x}, ${coordCheck.y}) multiple times and the page never responded. That position is hitting empty space, an overlay, or the wrong element. Please give a different instruction or check the page yourself.`
          : loopCheck.message;
      } else if (loopCheck.kind === 'nudge' || coordCheck.kind === 'nudge') {
        effectiveKind = 'nudge';
        nudgeWarning = coordCheck.kind === 'nudge'
          ? `[COORDINATE CLICK WARNING: You've clicked at or near (${coordCheck.x}, ${coordCheck.y}) several times with no visible page change. The click may be missing its target. Try: (a) call get_interactive_elements to find a real selector, (b) click({text: "..."}) to target by visible text, or (c) take a fresh screenshot and look more carefully at element positions. Try a different approach before clicking these coordinates again.]`
          : loopCheck.warning;
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
        return { action: 'return', value: stopMessage };
      }
      if (this._shouldAutoScreenshot(fnName) && !toolResult?.error) {
        didStateChange = true;
      }
    }

    if (navNotices.length > 0) {
      const last = navNotices[navNotices.length - 1];
      const noticeText =
        `[NAVIGATION OCCURRED — the page changed as a side effect of your last action.\n` +
        `  Was on: ${last.before}\n` +
        `  Now on: ${last.after}\n` +
        `  Triggered by: ${last.viaTool}\n` +
        `\n` +
        `The previous page is GONE. Any plan you had for that page no longer applies. ` +
        `DO NOT continue executing steps from the previous page's plan — those elements no longer exist. ` +
        `STOP, take a fresh screenshot, call get_interactive_elements, decide whether this new page is what you wanted, ` +
        `and re-plan from scratch. If this navigation was unintended, navigate back with \`navigate({url: "${last.before}"})\` and try a more specific click.]`;
      messages.push({ role: 'user', content: noticeText });
      onUpdate('warning', { message: 'Page navigated unexpectedly — agent notified.' });
    }

    if (didStateChange && provider.supportsVision) {
      const lastTs = this.lastAutoScreenshotTs.get(tabId) || 0;
      if (Date.now() - lastTs >= 500) {
        await new Promise(r => setTimeout(r, 250));
        const shot = await this._captureAutoScreenshot(tabId);
        if (shot) {
          this.lastAutoScreenshotTs.set(tabId, Date.now());
          const visible = await this._getVisibleInteractiveElements(tabId);
          const elementsText = this._formatElementsList(visible);
          const textBlock = `[Auto-screenshot of current viewport after the action above. Image is ${shot.width}×${shot.height} pixels = the CSS viewport at 1:1. A click at image pixel (X, Y) maps directly to click(x:X, y:Y). Use this to confirm the result and plan the next step. Prefer click({text:"..."}) over coordinate clicks — coordinates are a last resort.]${elementsText}`;
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: textBlock },
              { type: 'image_url', image_url: { url: shot.dataUrl } },
            ],
          });
          onUpdate('tool_call', { name: 'auto_screenshot', args: {} });
          onUpdate('tool_result', { name: 'auto_screenshot', result: { success: true, bytes: shot.dataUrl.length, elements: visible.length } });
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

    if (this.apiAllowedTabs.has(tabId) && !this.apiAllowedInjected.has(tabId)) {
      contextLine += `[USER OVERRIDE — /allow-api: For this conversation the user has explicitly authorized you to use API mutations (POST/PUT/PATCH/DELETE via fetch_url, or fetch() with mutation methods via execute_js) when you judge API to be more reliable than UI for a specific step. The default UI-first rule still applies — only reach for the API when UI has actually failed or is genuinely unworkable. Before any destructive API call, state the URL, method, and payload in plain text in your response so the user can see what you're about to do.]\n\n`;
      this.apiAllowedInjected.add(tabId);
    }

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
   * Build a copy of `messages` for sending to the LLM that retains only the
   * `keep` most-recent screenshots. Older image_url blocks are replaced with
   * a small text placeholder, and base64 image data embedded in old tool
   * results is stripped. The persisted history is left untouched.
   */
  _pruneOldImages(messages, keep = 1) {
    let imgsKept = 0;
    const out = new Array(messages.length);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (Array.isArray(msg.content)) {
        const newContent = msg.content.map(block => {
          if (block && (block.type === 'image_url' || block.type === 'image')) {
            if (imgsKept < keep) {
              imgsKept++;
              return block;
            }
            return { type: 'text', text: '[older screenshot omitted to save tokens]' };
          }
          return block;
        });
        out[i] = { ...msg, content: newContent };
      } else if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.includes('data:image/')) {
        if (imgsKept < keep) {
          imgsKept++;
          out[i] = msg;
        } else {
          out[i] = { ...msg, content: msg.content.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\\]+/g, '[older screenshot omitted to save tokens]') };
        }
      } else {
        out[i] = msg;
      }
    }
    return out;
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

    // Network & download tools (background context, with user cookies).
    if (name === 'fetch_url') {
      return await fetchUrl(args.url, args);
    }
    if (name === 'research_url') {
      return await researchUrl(args.url, args);
    }
    if (name === 'list_downloads') {
      return await listDownloads(args);
    }
    if (name === 'read_downloaded_file') {
      return await readDownloadedFile(args.downloadId);
    }
    if (name === 'download_resource_from_page') {
      return await downloadResourceFromPage(tabId, args);
    }
    if (name === 'download_files') {
      return await downloadFiles(args);
    }

    // Iframe tools — use browser.tabs.executeScript with allFrames:true.
    // Extensions with <all_urls> permission can inject into any frame
    // regardless of origin, bypassing the same-origin policy.
    if (name === 'iframe_read') {
      try {
        const urlFilter = args.urlFilter || '';
        const selector = args.selector || 'body';
        const code = `
          (() => {
            try {
              const el = document.querySelector(${JSON.stringify(selector)});
              return {
                ok: !!el,
                url: location.href,
                title: document.title || '',
                text: el ? (el.innerText || '').slice(0, 4000) : '',
                html: el ? (el.innerHTML || '').slice(0, 4000) : '',
                tag: el ? el.tagName : null,
              };
            } catch (e) { return { ok: false, url: location.href, error: e.message }; }
          })()
        `;
        const results = await browser.tabs.executeScript(tabId, { code, allFrames: true });
        const frames = (results || []).filter(r => r && (!urlFilter || (r.url && r.url.includes(urlFilter))));
        return { success: true, frameCount: frames.length, frames };
      } catch (e) {
        return { success: false, error: `Iframe read failed: ${e.message}` };
      }
    }

    if (name === 'iframe_click') {
      try {
        const urlFilter = args.urlFilter || '';
        const selector = args.selector;
        if (!selector) return { success: false, error: 'selector is required' };
        const code = `
          (() => {
            const filter = ${JSON.stringify(urlFilter)};
            if (filter && !location.href.includes(filter)) return { ok: false, skipped: 'url-filter', url: location.href };
            try {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { ok: false, url: location.href, reason: 'not-found' };
              el.scrollIntoView({ block: 'center', inline: 'center' });
              const rect = el.getBoundingClientRect();
              const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, button: 0 };
              try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.click();
              return { ok: true, url: location.href, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80) };
            } catch (e) { return { ok: false, url: location.href, error: e.message }; }
          })()
        `;
        const results = await browser.tabs.executeScript(tabId, { code, allFrames: true });
        const successes = (results || []).filter(r => r && r.ok);
        if (successes.length > 0) return { success: true, method: 'iframe-click', frame: successes[0] };
        const candidates = (results || []).filter(r => r && !r.skipped);
        return { success: false, error: 'Element not found in any matching iframe', searchedFrames: candidates.length, frameUrls: candidates.map(c => c.url).slice(0, 5) };
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
        const code = `
          (() => {
            const filter = ${JSON.stringify(urlFilter)};
            if (filter && !location.href.includes(filter)) return { ok: false, skipped: 'url-filter', url: location.href };
            try {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { ok: false, url: location.href, reason: 'not-found' };
              el.focus();
              if (el.isContentEditable) {
                if (${clear}) el.textContent = '';
                el.textContent += ${JSON.stringify(text)};
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
                return { ok: true, url: location.href, method: 'contenteditable', value: el.textContent.slice(0, 100) };
              }
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              const newVal = (${clear} ? '' : (el.value || '')) + ${JSON.stringify(text)};
              if (setter) setter.call(el, newVal); else el.value = newVal;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, url: location.href, method: 'native-setter', value: (el.value || '').slice(0, 100) };
            } catch (e) { return { ok: false, url: location.href, error: e.message }; }
          })()
        `;
        const results = await browser.tabs.executeScript(tabId, { code, allFrames: true });
        const successes = (results || []).filter(r => r && r.ok);
        if (successes.length > 0) return { success: true, frame: successes[0] };
        const candidates = (results || []).filter(r => r && !r.skipped);
        return { success: false, error: 'Input not found in any matching iframe', searchedFrames: candidates.length, frameUrls: candidates.map(c => c.url).slice(0, 5) };
      } catch (e) {
        return { success: false, error: `Iframe type failed: ${e.message}` };
      }
    }

    // Map tool names to content script actions
    const actionMap = {
      'read_page': 'get_page_info_cdp',
      'get_interactive_elements': 'get_interactive_elements_cdp',
      'get_shadow_dom': 'get_shadow_dom',
      'get_frames': 'get_frames',
      'click': 'click',
      'type_text': 'type',
      'press_keys': 'press_keys',
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

  // ── Deep verbose / debug log ──────────────────────────────────────────
  _logDebug(entry) {
    entry.timestamp = new Date().toISOString();
    this._debugLog.push(entry);
    if (this._debugLog.length > this._debugLogMax) {
      this._debugLog.splice(0, this._debugLog.length - this._debugLogMax);
    }
  }

  getDebugLog() {
    return this._debugLog;
  }

  clearDebugLog() {
    this._debugLog = [];
  }

  /**
   * Attempt to parse tool calls from raw LLM text output.
   * Some local models emit tool calls as text markup instead of using the
   * structured tool_calls field. This catches the most common formats:
   *   - <tool_call>{"name":"...","arguments":{...}}</tool_call>
   *   - <|tool_call|>...<|/tool_call|>  or  <|tool_call>...<tool_call|>
   *   - <functioncall>{"name":"...","arguments":{...}}</functioncall>
   *   - call:toolName{key:<|"|>value<|"|>}  (custom quote-token format)
   *   - Bare JSON objects with a known tool name
   * Returns an array of tool call objects in OpenAI format, or [] if nothing
   * was found. Only tool names present in AGENT_TOOL_NAMES are accepted.
   */
  _tryParseToolCallsFromText(text) {
    if (!text || text.length > 10000) return [];

    const results = [];
    const patterns = [
      /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
      /<\|tool_call\|?>\s*([\s\S]*?)\s*<\|?\/?tool_call\|?>/gi,
      /<functioncall>\s*([\s\S]*?)\s*<\/functioncall>/gi,
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const inner = m[1].trim();
        // Try JSON first (most common).
        try {
          const obj = JSON.parse(inner);
          if (obj && obj.name && AGENT_TOOL_NAMES.has(obj.name)) {
            results.push(obj);
            continue;
          }
        } catch { /* not JSON — try call:name{} format below */ }

        // call:toolName{key:<|"|>value<|"|>, ...} format.
        const callMatch = /^call:(\w+)\s*\{([\s\S]*)\}$/.exec(inner);
        if (callMatch && AGENT_TOOL_NAMES.has(callMatch[1])) {
          const toolName = callMatch[1];
          let argsBody = callMatch[2]
            .replace(/<\|"\|>/g, '"')
            .replace(/<\|'\\?\|>/g, "'");
          argsBody = argsBody.replace(/(?<=^|,)\s*(\w+)\s*:/g, '"$1":');
          try {
            const args = JSON.parse(`{${argsBody}}`);
            results.push({ name: toolName, arguments: args });
          } catch {
            results.push({ name: toolName, arguments: {} });
          }
          continue;
        }
      }
    }

    // Fallback: scan for bare JSON objects containing a "name" key.
    if (results.length === 0) {
      const bareRe = /\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*\}/g;
      let m;
      while ((m = bareRe.exec(text)) !== null) {
        if (!AGENT_TOOL_NAMES.has(m[1])) continue;
        try {
          const obj = JSON.parse(m[0]);
          if (obj && obj.name && AGENT_TOOL_NAMES.has(obj.name)) {
            results.push(obj);
          }
        } catch { /* skip */ }
      }
    }

    // Last resort: call:toolName{...} outside of any wrapper tags.
    if (results.length === 0) {
      const callRe = /call:(\w+)\s*\{([\s\S]*?)\}/g;
      let m;
      while ((m = callRe.exec(text)) !== null) {
        if (!AGENT_TOOL_NAMES.has(m[1])) continue;
        const toolName = m[1];
        let argsBody = m[2]
          .replace(/<\|"\|>/g, '"')
          .replace(/<\|'\\?\|>/g, "'");
        argsBody = argsBody.replace(/(?<=^|,)\s*(\w+)\s*:/g, '"$1":');
        try {
          const args = JSON.parse(`{${argsBody}}`);
          results.push({ name: toolName, arguments: args });
        } catch {
          results.push({ name: toolName, arguments: {} });
        }
      }
    }

    return results.map((obj, i) => ({
      id: `fallback_call_${Date.now()}_${i}`,
      type: 'function',
      function: {
        name: obj.name,
        arguments: typeof obj.arguments === 'string'
          ? obj.arguments
          : JSON.stringify(obj.arguments || obj.parameters || {}),
      },
    }));
  }
  // ─────────────────────────────────────────────────────────────────────

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
        const chatOpts = { tools: useTools ? tools : undefined, temperature: 0.3, maxTokens: 4096 };
        const prunedMessages = this._pruneOldImages(messages);
        this._logDebug({ type: 'llm_request', step: steps, provider: provider.constructor.name, messages: prunedMessages, options: chatOpts });
        result = await provider.chat(prunedMessages, chatOpts);
        this._logDebug({ type: 'llm_response', step: steps, content: result.content, toolCalls: result.toolCalls });
      } catch (e) {
        this._logDebug({ type: 'llm_error', step: steps, error: e.message });
        // If context overflow, trim aggressively and retry once
        if (this._isContextOverflow(e.message)) {
          onUpdate('thinking', { step: steps, note: 'Context too large, trimming...' });
          this._emergencyTrim(messages);
          try {
            const useTools = provider.supportsTools;
            const chatOpts = { tools: useTools ? tools : undefined, temperature: 0.3, maxTokens: 4096 };
            const prunedMessages = this._pruneOldImages(messages);
            this._logDebug({ type: 'llm_request_retry', step: steps, provider: provider.constructor.name, messages: prunedMessages, options: chatOpts });
            result = await provider.chat(prunedMessages, chatOpts);
            this._logDebug({ type: 'llm_response_retry', step: steps, content: result.content, toolCalls: result.toolCalls });
          } catch (e2) {
            this._logDebug({ type: 'llm_error_retry', step: steps, error: e2.message });
            onUpdate('error', { message: `Context still too large after trimming: ${e2.message}` });
            finalResponse = 'The conversation got too long. Please start a new conversation (click the + button).';
            messages.push({ role: 'assistant', content: finalResponse });
            break;
          }
        } else {
          // Retry once after a short delay for transient errors (rate limits, network).
          this._logDebug({ type: 'llm_error_retrying', step: steps, error: e.message });
          await new Promise(r => setTimeout(r, 2000));
          try {
            const useTools2 = provider.supportsTools;
            const chatOpts2 = { tools: useTools2 ? tools : undefined, temperature: 0.3, maxTokens: 4096 };
            result = await provider.chat(this._pruneOldImages(messages), chatOpts2);
            this._logDebug({ type: 'llm_response_after_retry', step: steps, content: result.content, toolCalls: result.toolCalls });
          } catch (e2) {
            this._logDebug({ type: 'llm_error_final', step: steps, error: e2.message });
            onUpdate('error', { message: e2.message });
            finalResponse = `Error communicating with LLM: ${e2.message}`;
            messages.push({ role: 'assistant', content: finalResponse });
            break;
          }
        }
      }

      // Check for abort after LLM response
      if (this._checkAbort(tabId)) {
        finalResponse = result?.content || '[Stopped by user]';
        onUpdate('warning', { message: 'Stopped by user.' });
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

      // Fallback: if the LLM emitted tool calls as raw text instead of
      // using the structured tool_calls field, try to parse them out.
      if ((!result.toolCalls || result.toolCalls.length === 0) && result.content) {
        const fallback = this._tryParseToolCallsFromText(result.content);
        if (fallback.length > 0) {
          this._logDebug({ type: 'llm_text_fallback_parse', step: steps, parsed: fallback.map(tc => tc.function.name) });
          result.toolCalls = fallback;
          result.content = null;
        }
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

        const streamOpts = { tools: provider.supportsTools ? tools : undefined, temperature: 0.3, maxTokens: 4096 };
        const prunedMessages = this._pruneOldImages(messages);
        this._logDebug({ type: 'llm_stream_request', step: steps, provider: provider.constructor.name, messages: prunedMessages, options: streamOpts });

        for await (const chunk of provider.chatStream(prunedMessages, streamOpts)) {
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

        // Fallback: parse tool calls from streamed text if structured calls are missing.
        if (!hasToolCalls && fullText) {
          const fallback = this._tryParseToolCallsFromText(fullText);
          if (fallback.length > 0) {
            this._logDebug({ type: 'llm_text_fallback_parse', step: steps, parsed: fallback.map(tc => tc.function.name) });
            hasToolCalls = true;
            fallback.forEach((tc, i) => { toolCallsAccumulator[i] = tc; });
            fullText = '';
          }
        }

        if (hasToolCalls) {
          const toolCalls = Object.values(toolCallsAccumulator);
          this._logDebug({ type: 'llm_stream_response', step: steps, content: fullText, toolCalls });
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
        this._logDebug({ type: 'llm_stream_response', step: steps, content: fullText, toolCalls: null });
        messages.push({ role: 'assistant', content: fullText });
        return fullText;

      } catch (e) {
        this._logDebug({ type: 'llm_stream_error', step: steps, error: e.message });
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
