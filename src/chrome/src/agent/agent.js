import { AGENT_TOOLS, AGENT_TOOL_NAMES, getToolsForMode, SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_ACT, SYSTEM_PROMPT_ACT_COMPACT } from './tools.js';
import { cdpClient } from '../cdp/cdp-client.js';
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
    this.conversationModes = new Map(); // tabId -> 'ask' | 'act'
    this.hydratedTabs = new Set(); // tabIds we've already pulled from storage
    this.persistTimers = new Map(); // tabId -> debounce handle
    this.abortFlags = new Map(); // tabId -> boolean
    this.maxSteps = 120; // safety limit for autonomous loops (configurable via settings)
    this.maxContextMessages = 50; // trim beyond this
    this._debugLog = []; // ring buffer for deep verbose (LLM requests/responses)
    this._debugLogMax = 200; // max entries before oldest are dropped
    this.maxContextChars = 80000; // rough char budget (~20k tokens)
    // Auto-screenshot mode. 'off' | 'navigation' | 'state_change' | 'every_step'.
    // Loaded from chrome.storage.local in background.js.
    this.autoScreenshot = 'state_change';
    // Whether to inject site adapter notes into the first user message of
    // each conversation. Loaded from chrome.storage.local. Default true.
    this.useSiteAdapters = true;
    // Stale click detection: per-tab last clicked element identity.
    this._lastCdpClickIdent = new Map(); // tabId -> string
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
    // Per-tab opt-in: when true, the agent is allowed to use API mutations
    // (POST/PUT/PATCH/DELETE via fetch_url, mutation fetch() via execute_js)
    // for steps where it judges API to be more reliable than UI. Set via
    // the /allow-api slash command in the sidebar; cleared on
    // clearConversation. Persisted with the conversation so a service
    // worker restart preserves it.
    this.apiAllowedTabs = new Set();
    // Track which tabs have already had the [API ALLOWED] preamble
    // injected for the current run, so we don't push it on every turn.
    this.apiAllowedInjected = new Set();
  }

  /**
   * Toggle the per-tab API-mutation allowlist. Called by background.js
   * when the sidebar reports the user typed /allow-api.
   */
  setApiMutationsAllowed(tabId, allowed) {
    if (allowed) {
      this.apiAllowedTabs.add(tabId);
    } else {
      this.apiAllowedTabs.delete(tabId);
      this.apiAllowedInjected.delete(tabId);
    }
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
   * Returns 'nudge' on the 3rd repeat and 'stop' on the 5th. Gives the
   * agent more room to retry on pages with loading states or animations.
   */
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
      if (healthy >= 2) {
        this.loopNudges.delete(tabId);
        this.healthyCallsSinceLoop.delete(tabId);
      }
      return { kind: 'none' };
    }

    // Any new loop detection resets the healthy-streak counter.
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

  // Tools whose successful completion should trigger an auto-screenshot when
  // the corresponding mode is active.
  static NAV_TOOLS = new Set(['navigate', 'new_tab']);
  static STATE_CHANGE_TOOLS = new Set(['navigate', 'new_tab', 'click', 'type_text', 'press_keys', 'scroll']);

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

    // API mutation override: prepend a strong note when the user has set
    // /allow-api for this tab. Inject only once per "allowed run" to avoid
    // bloating every subsequent turn.
    if (this.apiAllowedTabs.has(tabId) && !this.apiAllowedInjected.has(tabId)) {
      contextLine += `[USER OVERRIDE — /allow-api: For this conversation the user has explicitly authorized you to use API mutations (POST/PUT/PATCH/DELETE via fetch_url, or fetch() with mutation methods via execute_js) when you judge API to be more reliable than UI for a specific step. The default UI-first rule still applies — only reach for the API when UI has actually failed or is genuinely unworkable. Before any destructive API call (anything that creates, deletes, transfers, or charges), state the URL, method, and payload in plain text in your response so the user can see what you're about to do.]\n\n`;
      this.apiAllowedInjected.add(tabId);
    }

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
   * Cheap helper to read the current URL of a tab without throwing.
   */
  async _currentUrl(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab?.url || '';
    } catch (e) { return ''; }
  }

  /**
   * Strip query params + hash for "did the URL meaningfully change" comparison.
   * Lets things like ?utm_source=... or hash anchors slide without triggering
   * the navigation notice, while still catching real route changes.
   */
  _normalizeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) { return url; }
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
    // Set of tools whose side effect can navigate the page. We snapshot the
    // URL before these and re-check after, so we can warn the model when an
    // unintended navigation happens (the most common cause of "model keeps
    // executing the original plan on a totally different page").
    const NAV_PRONE_TOOLS = new Set(['click', 'navigate', 'execute_js', 'iframe_click']);
    const navNotices = []; // accumulated for injection after the loop

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

      // Snapshot URL before nav-prone tools.
      let beforeUrl = '';
      if (NAV_PRONE_TOOLS.has(fnName)) {
        beforeUrl = await this._currentUrl(tabId);
      }

      onUpdate('tool_call', { name: fnName, args: fnArgs });
      const toolResult = await this.executeTool(tabId, fnName, fnArgs);
      onUpdate('tool_result', { name: fnName, result: toolResult });

      // Detect unintended navigation. Give the page a beat to fire SPA
      // history events / commit a real nav before re-reading the URL.
      if (NAV_PRONE_TOOLS.has(fnName) && beforeUrl && !toolResult?.error) {
        await new Promise(r => setTimeout(r, 200));
        const afterUrl = await this._currentUrl(tabId);
        const beforeNorm = this._normalizeUrl(beforeUrl);
        const afterNorm = this._normalizeUrl(afterUrl);
        if (beforeNorm && afterNorm && beforeNorm !== afterNorm) {
          // The `navigate` tool intentionally goes somewhere — don't warn.
          // For everything else (click, execute_js, iframe_click) the nav
          // is a side effect the model may not have anticipated.
          if (fnName !== 'navigate') {
            navNotices.push({ before: beforeUrl, after: afterUrl, viaTool: fnName });
          }
        }
      }

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
          stopMessage = `Stopped: I clicked at (or near) coordinates (${coordCheck.x}, ${coordCheck.y}) multiple times and the page never responded. That position is hitting empty space, an overlay, or the wrong element. Please give a different instruction or check the page yourself.`;
        } else {
          stopMessage = loopCheck.message;
        }
      } else if (loopCheck.kind === 'nudge' || coordCheck.kind === 'nudge') {
        effectiveKind = 'nudge';
        if (coordCheck.kind === 'nudge') {
          nudgeWarning = `[COORDINATE CLICK WARNING: You've clicked at or near (${coordCheck.x}, ${coordCheck.y}) several times with no visible page change. The click may be missing its target. Try: (a) call get_interactive_elements to find a real selector, (b) click({text: "..."}) to target by visible text, or (c) take a fresh screenshot and look more carefully at element positions. Try a different approach before clicking these coordinates again.]`;
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

    // Inject any navigation notices BEFORE the auto-screenshot, so the
    // model sees the warning and the new viewport in the same turn.
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
        `and re-plan from scratch. If this navigation was unintended (you clicked the wrong thing), navigate back ` +
        `with \`navigate({url: "${last.before}"})\` and try a more specific click.]`;
      messages.push({ role: 'user', content: noticeText });
      onUpdate('warning', { message: 'Page navigated unexpectedly — agent notified.' });
    }

    // Auto-screenshot once per batch, debounced 500ms.
    if (didStateChange && provider.supportsVision) {
      const lastTs = this.lastAutoScreenshotTs.get(tabId) || 0;
      if (Date.now() - lastTs >= 500) {
        await new Promise(r => setTimeout(r, 250));
        const shot = await this._captureAutoScreenshot(tabId);
        if (shot) {
          this.lastAutoScreenshotTs.set(tabId, Date.now());
          // Pair the image with a textual list of visible clickables so
          // the model can ground "the Publish button" by name instead of
          // guessing pixels — fixes the "click landed on the wrong thing"
          // failure mode for local vision models.
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

    this._persist(tabId);
    return { action: 'continue' };
  }

  /**
   * Quick scan of visible interactive elements with their CSS-pixel
   * positions, used to annotate screenshots. The model gets BOTH the image
   * and a compact list of what's clickable where, so it can resolve "the
   * Publish button" without guessing pixels — just by name.
   */
  async _getVisibleInteractiveElements(tabId) {
    // For compact-prompt providers (small models), cap at 12 elements to
    // reduce noise. Full-size models get up to 25.
    let maxElements = 25;
    try {
      const provider = this.providerManager.getActive();
      if (provider.useCompactPrompt) maxElements = 12;
    } catch { /* default 25 */ }

    try {
      const result = await cdpClient.evaluate(tabId, `
        (() => {
          const maxEl = ${maxElements};
          const sels = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), textarea, select, summary, [onclick]';
          const all = Array.from(document.querySelectorAll(sels));
          const out = [];
          // Prioritize form inputs and buttons over links — they're more
          // likely to be the target of an action.
          const prioritized = all.sort((a, b) => {
            const aIsInput = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/i.test(a.tagName) || a.getAttribute('role') === 'button';
            const bIsInput = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/i.test(b.tagName) || b.getAttribute('role') === 'button';
            if (aIsInput && !bIsInput) return -1;
            if (!aIsInput && bIsInput) return 1;
            return 0;
          });
          // Helper: find the visible label associated with a form element.
          function getLabel(el) {
            // 1. Explicit <label for="...">
            if (el.id) {
              const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (lbl) return lbl.innerText.trim().slice(0, 40);
            }
            // 2. Wrapping <label>
            const parent = el.closest('label');
            if (parent) {
              const t = parent.innerText.trim().slice(0, 40);
              if (t && t !== (el.value || '').trim()) return t;
            }
            // 3. aria-label / aria-labelledby
            if (el.ariaLabel) return el.ariaLabel.trim().slice(0, 40);
            if (el.getAttribute('aria-labelledby')) {
              const lbl = document.getElementById(el.getAttribute('aria-labelledby'));
              if (lbl) return lbl.innerText.trim().slice(0, 40);
            }
            // 4. Preceding sibling or parent text that looks like a label
            const prev = el.previousElementSibling;
            if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
              const t = prev.innerText.trim().slice(0, 40);
              if (t && t.length < 40) return t;
            }
            // 5. name attribute as last resort
            if (el.name) return el.name;
            return '';
          }

          for (const el of prioritized) {
            const r = el.getBoundingClientRect();
            // Visible + in viewport
            if (r.width === 0 || r.height === 0) continue;
            if (r.bottom < 0 || r.top > window.innerHeight) continue;
            if (r.right < 0 || r.left > window.innerWidth) continue;
            const text = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().slice(0, 50);
            if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') continue;

            // For form fields, include the label so the model knows what the field is for.
            let label = '';
            if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
              label = getLabel(el);
            }

            const entry = {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              text: text || \`<\${el.tagName.toLowerCase()}>\`,
            };
            if (label) entry.label = label;
            out.push(entry);
            if (out.length >= maxEl) break;
          }
          return out;
        })()
      `);
      return result?.result?.value || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Format interactive elements as a compact text block for inclusion in
   * the screenshot's accompanying message.
   */
  _formatElementsList(elements) {
    if (!elements || elements.length === 0) return '';
    const lines = elements.map(e => {
      const tagInfo = e.type ? `${e.tag}[${e.type}]` : e.tag;
      let line = `  (${e.x},${e.y}) ${tagInfo} "${e.text}"`;
      if (e.label) line += ` [${e.label}]`;
      if (e.tag === 'select') line += ' ← use type_text to change';
      return line;
    });
    return `\nVisible interactive elements at these positions (use these names with click({text:"..."}) — much more reliable than guessing coordinates from the image):\n${lines.join('\n')}`;
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
  /**
   * Select the appropriate ACT system prompt based on the active provider.
   * Small/local models get a compact prompt to save context budget.
   */
  _getActPrompt() {
    try {
      const provider = this.providerManager.getActive();
      if (provider.useCompactPrompt) return SYSTEM_PROMPT_ACT_COMPACT;
    } catch { /* provider not ready yet — use full prompt */ }
    return SYSTEM_PROMPT_ACT;
  }

  getConversation(tabId, mode = 'ask') {
    if (!this.conversations.has(tabId)) {
      const systemPrompt = mode === 'act' ? this._getActPrompt() : SYSTEM_PROMPT_ASK;
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
      const systemPrompt = mode === 'act' ? this._getActPrompt() : SYSTEM_PROMPT_ASK;
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
    this.apiAllowedTabs.delete(tabId);
    this.apiAllowedInjected.delete(tabId);
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
      // In act mode, require a verification screenshot + page info before completing.
      const mode = this.conversationModes.get(tabId) || 'ask';
      if (mode === 'act') {
        try {
          await cdpClient.attach(tabId);
          // Capture page URL and title for verification context
          const pageInfo = await cdpClient.evaluate(tabId, `
            ({ url: location.href, title: document.title })
          `);
          const info = pageInfo?.result?.value || {};
          await cdpClient.sendCommand(tabId, 'Page.enable');
          const shot = await cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
            format: 'png', quality: 80, fromSurface: true,
          });
          return {
            done: true,
            summary: args.summary,
            verification: {
              pageUrl: info.url || '',
              pageTitle: info.title || '',
              screenshot: `data:image/png;base64,${shot.data}`,
              note: 'Review this screenshot carefully. Does it confirm the task was completed successfully? If the page shows an existing item from the past (check dates), you may NOT have actually created anything new.',
            },
          };
        } catch (_) {
          // Screenshot failed — still allow done but note it
          return { done: true, summary: args.summary, verification: null };
        }
      }
      return { done: true, summary: args.summary };
    }

    // ─── Network & download tools ─────────────────────────────────────
    // These run in the background script context with the user's cookies.
    // They don't touch the active tab so they're safe to call any time.

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

    if (name === 'verify_form') {
      try {
        await cdpClient.attach(tabId);

        // 1. Read form fields
        const formData = await cdpClient.evaluate(tabId, `
          (() => {
            const sel = ${JSON.stringify(args.selector || '')};
            let form;
            if (sel) {
              form = document.querySelector(sel);
            } else {
              const focused = document.activeElement;
              form = focused?.closest('form') || document.querySelector('form');
            }
            if (!form) return { found: false, error: 'No form found on page' };

            const fields = [];
            for (const el of form.querySelectorAll('input, select, textarea')) {
              const n = el.name || el.id || el.getAttribute('aria-label') || '';
              const t = el.type || el.tagName.toLowerCase();
              if (t === 'hidden' || t === 'submit') continue;
              let v;
              if (t === 'checkbox' || t === 'radio') {
                v = el.checked ? (el.value || 'on') : '(unchecked)';
              } else if (el.tagName === 'SELECT') {
                const o = el.options[el.selectedIndex];
                v = o ? o.text + ' [' + o.value + ']' : '';
              } else {
                v = el.value;
              }
              fields.push({ name: n, type: t, value: v, placeholder: el.placeholder || '' });
            }
            return { found: true, action: form.action || '', method: form.method || 'get', fieldCount: fields.length, fields };
          })()
        `);

        const result = formData?.result?.value || { found: false, error: 'Evaluation returned no data' };

        // 2. Capture screenshot
        try {
          await cdpClient.sendCommand(tabId, 'Page.enable');
          const shot = await cdpClient.sendCommand(tabId, 'Page.captureScreenshot', {
            format: 'png', quality: 100, fromSurface: true,
          });
          result.image = `data:image/png;base64,${shot.data}`;
        } catch {
          result.screenshotFailed = true;
        }

        result.success = !!result.found;
        return result;
      } catch (e) {
        return { success: false, error: `verify_form failed: ${e.message}` };
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
          // Text-based click with auto-fallback matching.
          // When textMatch is not specified (default), tries exact → prefix →
          // contains in order. At each level, if multiple elements match, an
          // ambiguity error is returned instead of clicking an arbitrary one.
          // When textMatch IS specified, only that mode is used.
          const result = await cdpClient.evaluate(tabId, `
            (() => {
              const needle = ${JSON.stringify(args.text.toLowerCase())};
              const explicit = ${JSON.stringify(args.textMatch || '')};
              const sels = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="button"], input[type="submit"], summary, label, [onclick], [data-action]';
              const all = Array.from(document.querySelectorAll(sels));
              const normalized = all.map(el => ({
                el,
                txt: (el.innerText || el.value || el.ariaLabel || '').trim().toLowerCase(),
              })).filter(x => !!x.txt);

              function tryMode(mode) {
                if (mode === 'exact') return normalized.filter(x => x.txt === needle);
                if (mode === 'prefix') return normalized.filter(x => x.txt.startsWith(needle));
                if (mode === 'contains') return normalized.filter(x => x.txt.includes(needle));
                return [];
              }

              // Determine which modes to try.
              const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
              if (explicit && !['exact', 'prefix', 'contains'].includes(explicit)) {
                return { found: false, error: 'Invalid textMatch. Use exact, prefix, or contains.' };
              }

              let matches = [];
              let usedMode = modes[0];
              for (const m of modes) {
                matches = tryMode(m);
                usedMode = m;
                if (matches.length === 1) break; // unique match — use it
                if (matches.length > 1) break;   // ambiguous — report it
                // 0 matches — try next mode
              }

              if (matches.length === 0) return { found: false, mode: usedMode };

              // --- Prioritize interactive elements over passive children ---
              const _INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
              const _INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option']);
              const _PASSIVE_TAGS = new Set(['LABEL', 'SPAN', 'DIV', 'P', 'STRONG', 'EM', 'I', 'B', 'SMALL', 'SVG', 'IMG']);

              function _isInteractive(node) {
                if (_INTERACTIVE_TAGS.has(node.tagName)) return true;
                const role = (node.getAttribute && node.getAttribute('role')) || '';
                if (_INTERACTIVE_ROLES.has(role)) return true;
                if (node.hasAttribute && (node.hasAttribute('onclick') || node.hasAttribute('data-action'))) return true;
                return false;
              }

              if (matches.length > 1) {
                const interactive = matches.filter(m => _isInteractive(m.el));
                if (interactive.length === 1) {
                  matches = interactive;
                } else {
                  return {
                    found: false,
                    ambiguous: true,
                    mode: usedMode,
                    count: matches.length,
                    candidates: matches.slice(0, 5).map(m => m.txt.slice(0, 80)),
                  };
                }
              }

              // --- Parent traversal: resolve passive child to interactive ancestor ---
              let el = matches[0].el;
              if (_PASSIVE_TAGS.has(el.tagName) && !_isInteractive(el)) {
                let ancestor = el.parentElement;
                for (let i = 0; i < 5 && ancestor; i++, ancestor = ancestor.parentElement) {
                  if (_isInteractive(ancestor)) {
                    el = ancestor;
                    break;
                  }
                }
              }

              try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
              const r = el.getBoundingClientRect();
              return {
                found: true,
                mode: usedMode,
                x: r.left + r.width / 2,
                y: r.top + r.height / 2,
                tag: el.tagName,
                text: (el.innerText || el.value || '').slice(0, 80),
              };
            })()
          `);
          let info = result?.result?.value;

          // Auto-scroll retry: if element not found, scroll down and try again
          // (up to 3 scrolls) to find elements below the fold.
          if (info && !info.found && !info.ambiguous && !info.error) {
            for (let scrollAttempt = 0; scrollAttempt < 3; scrollAttempt++) {
              await cdpClient.evaluate(tabId, `window.scrollBy(0, Math.round(window.innerHeight * 0.7))`);
              await new Promise(r => setTimeout(r, 300));
              const retry = await cdpClient.evaluate(tabId, result._evalScript || `
                (() => {
                  const needle = ${JSON.stringify(args.text.toLowerCase())};
                  const explicit = ${JSON.stringify(args.textMatch || '')};
                  const sels = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="button"], input[type="submit"], summary, label, [onclick], [data-action]';
                  const all = Array.from(document.querySelectorAll(sels));
                  const normalized = all.map(el => ({ el, txt: (el.innerText || el.value || el.ariaLabel || '').trim().toLowerCase() })).filter(x => !!x.txt);
                  function tryMode(mode) {
                    if (mode === 'exact') return normalized.filter(x => x.txt === needle);
                    if (mode === 'prefix') return normalized.filter(x => x.txt.startsWith(needle));
                    if (mode === 'contains') return normalized.filter(x => x.txt.includes(needle));
                    return [];
                  }
                  const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
                  let matches = []; let usedMode = modes[0];
                  for (const m of modes) { matches = tryMode(m); usedMode = m; if (matches.length >= 1) break; }
                  if (matches.length === 0) return { found: false };
                  const _INTERACTIVE_TAGS = new Set(['BUTTON','A','INPUT','SELECT','TEXTAREA']);
                  const _INTERACTIVE_ROLES = new Set(['button','link','tab','menuitem','option']);
                  const _PASSIVE_TAGS = new Set(['LABEL','SPAN','DIV','P','STRONG','EM','I','B','SMALL','SVG','IMG']);
                  function _isInteractive(n) { return _INTERACTIVE_TAGS.has(n.tagName) || _INTERACTIVE_ROLES.has((n.getAttribute&&n.getAttribute('role'))||'') || (n.hasAttribute&&(n.hasAttribute('onclick')||n.hasAttribute('data-action'))); }
                  if (matches.length > 1) { const inter = matches.filter(m => _isInteractive(m.el)); if (inter.length === 1) matches = inter; else return { found: false, ambiguous: true, mode: usedMode, count: matches.length, candidates: matches.slice(0,5).map(m=>m.txt.slice(0,80)) }; }
                  let el = matches[0].el;
                  if (_PASSIVE_TAGS.has(el.tagName) && !_isInteractive(el)) { let anc = el.parentElement; for (let i=0;i<5&&anc;i++,anc=anc.parentElement) { if (_isInteractive(anc)) { el=anc; break; } } }
                  try { el.scrollIntoView({block:'center',inline:'center'}); } catch(e){}
                  const r = el.getBoundingClientRect();
                  return { found: true, mode: usedMode, x: r.left+r.width/2, y: r.top+r.height/2, tag: el.tagName, text: (el.innerText||el.value||'').slice(0,80) };
                })()
              `);
              const retryInfo = retry?.result?.value;
              if (retryInfo?.found) {
                info = retryInfo;
                info._scrolledToFind = true;
                break;
              }
              if (retryInfo?.ambiguous) { info = retryInfo; break; }
            }
          }

          if (!info?.found) {
            if (info?.error) {
              return { success: false, error: info.error };
            }
            if (info?.ambiguous) {
              return {
                success: false,
                error: `Ambiguous text match for "${args.text}" (mode=${info.mode}, matches=${info.count}). Use a more specific text, click({index:N}) from get_interactive_elements, or selector/x,y.`,
                candidates: info.candidates || [],
              };
            }
            return {
              success: false,
              error: `No clickable element found for text "${args.text}" (also tried scrolling down). Try get_interactive_elements to see what's on the page, or use a selector.`,
            };
          }
          // <select> intercept: don't dispatch mouse events — the native
          // dropdown popup can't be controlled via CDP. Return guidance.
          if (info.tag === 'SELECT') {
            const optionsInfo = await cdpClient.evaluate(tabId, `
              (() => {
                const sels = 'select';
                const all = Array.from(document.querySelectorAll(sels));
                for (const sel of all) {
                  const t = (sel.innerText || sel.value || '').trim().toLowerCase();
                  if (t.includes(${JSON.stringify((args.text || '').toLowerCase())})) {
                    return {
                      current: sel.options[sel.selectedIndex]?.text?.trim() || '',
                      options: Array.from(sel.options).map(o => o.text.trim()),
                    };
                  }
                }
                return null;
              })()
            `);
            const opts = optionsInfo?.result?.value;
            return {
              success: true,
              tag: 'SELECT',
              text: opts?.current || info.text,
              hint: 'This is a <select> dropdown. Do NOT try to click individual options — the native dropdown cannot be controlled via click. Instead, use type_text({text: "option name"}) to select an option.' + (opts?.options ? ' Available options: ' + opts.options.join(', ') : ''),
            };
          }

          // Wait for scroll to settle, then dispatch a real click via CDP.
          await new Promise(r => setTimeout(r, 100));
          await cdpClient.dispatchMouseEvent(tabId, 'mouseMoved', info.x, info.y);
          await cdpClient.dispatchMouseEvent(tabId, 'mousePressed', info.x, info.y);
          await cdpClient.dispatchMouseEvent(tabId, 'mouseReleased', info.x, info.y);

          // Stale click detection
          const clickIdent = `${info.tag}|${(info.text || '').slice(0, 50)}`;
          const prevIdent = this._lastCdpClickIdent.get(tabId);
          this._lastCdpClickIdent.set(tabId, clickIdent);
          const warning = (prevIdent === clickIdent)
            ? 'Same element clicked again with no page change. Try click({x, y}) with coordinates from a screenshot, or click({index: N}) from get_interactive_elements.'
            : undefined;

          return {
            success: true,
            method: 'cdp-by-text',
            textMatch: info.mode || (args.textMatch || 'exact'),
            tag: info.tag,
            text: info.text,
            matched: args.text,
            ...(warning ? { warning } : {}),
          };
        }
        if (args.selector) {
          // Check if the selector targets a <select> element before clicking.
          const selTagCheck = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.querySelector(${JSON.stringify(args.selector)});
              if (!el) return null;
              if (el.tagName === 'SELECT') {
                const opts = Array.from(el.options).map(o => o.text.trim());
                return { isSelect: true, current: el.options[el.selectedIndex]?.text?.trim() || '', options: opts };
              }
              return { isSelect: false };
            })()
          `);
          const selTag = selTagCheck?.result?.value;
          if (selTag?.isSelect) {
            return {
              success: true,
              tag: 'SELECT',
              text: selTag.current,
              hint: `This is a <select> dropdown (current: "${selTag.current}"). Do NOT click it — use type_text({selector: ${JSON.stringify(args.selector)}, text: "option name"}) instead. Available options: ${selTag.options.join(', ')}`,
            };
          }
          return await cdpClient.clickElement(tabId, args.selector);
        }
        if (args.x != null && args.y != null) {
          // Check if the element at these coordinates is a <select> before clicking.
          const coordTagCheck = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.elementFromPoint(${args.x}, ${args.y});
              if (!el) return null;
              // Walk up a couple levels — sometimes the click lands on a child of the select
              let target = el;
              for (let i = 0; i < 3 && target; i++) {
                if (target.tagName === 'SELECT') {
                  const opts = Array.from(target.options).map(o => o.text.trim());
                  return { isSelect: true, current: target.options[target.selectedIndex]?.text?.trim() || '', options: opts };
                }
                target = target.parentElement;
              }
              return { isSelect: false };
            })()
          `);
          const coordTag = coordTagCheck?.result?.value;
          if (coordTag?.isSelect) {
            return {
              success: true,
              tag: 'SELECT',
              text: coordTag.current,
              hint: `The element at (${args.x}, ${args.y}) is a <select> dropdown (current: "${coordTag.current}"). Do NOT click it — use type_text({text: "option name"}) after clicking the select to focus it, or use type_text with a selector. Available options: ${coordTag.options.join(', ')}`,
            };
          }
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
          const result = await cdpClient.typeText(tabId, args.selector, args.text || '', !!args.clear);
          // Track field for duplicate-typing detection
          if (result.success) {
            const fieldIdent = `sel:${args.selector}`;
            const prev = this._lastTypeFieldIdent?.get(tabId);
            if (prev === fieldIdent) {
              result.warning = 'You typed into the same field twice in a row. If you intended to fill a DIFFERENT field, click it first before calling type_text.';
            }
            if (!this._lastTypeFieldIdent) this._lastTypeFieldIdent = new Map();
            this._lastTypeFieldIdent.set(tabId, fieldIdent);
          }
          return result;
        }
        // No selector and no index → type into the currently focused element
        // via CDP Input.insertText. The model is expected to have just
        // clicked the field in a prior tool call. This is the most reliable
        // path for forms with weird selectors (GitHub release[name],
        // Stripe-style nested inputs, etc.) — no resolution needed.
        if (args.index == null) {
          // Check what element is actually focused before typing
          const focusCheck = await cdpClient.evaluate(tabId, `
            (() => {
              const el = document.activeElement;
              if (!el || el === document.body || el === document.documentElement) {
                return { focused: false };
              }
              const tag = el.tagName;
              const editable = el.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(tag);
              return {
                focused: true,
                editable,
                tag,
                type: el.type || '',
                name: el.name || el.id || el.getAttribute('aria-label') || '',
                value: (el.value || '').slice(0, 50),
              };
            })()
          `);
          const focus = focusCheck?.result?.value;

          if (!focus?.focused || !focus?.editable) {
            return {
              success: false,
              error: 'No editable element is currently focused. Click the target input/textarea first, then call type_text with no selector.',
              focusedElement: focus || null,
            };
          }

          // <select> fast-path: Input.insertText doesn't work for <select>.
          // Use JS to match the option and set value + fire change events.
          if (focus.tag === 'SELECT') {
            const needle = JSON.stringify((args.text || '').trim());
            const selectResult = await cdpClient.evaluate(tabId, `
              (() => {
                const el = document.activeElement;
                if (!el || el.tagName !== 'SELECT') return { success: false, error: 'Focused element is not a select' };
                const needle = ${needle};
                const opts = Array.from(el.options);
                const match = opts.find(o => o.value === needle)
                  || opts.find(o => o.text.trim() === needle)
                  || opts.find(o => o.text.trim().toLowerCase().includes(needle.toLowerCase()));
                if (!match) {
                  const available = opts.map(o => o.text.trim()).join(', ');
                  return { success: false, error: 'No option matching "' + needle + '". Available: ' + available };
                }
                el.value = match.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, method: 'select-js-focused', selectedText: match.text.trim(), selectedValue: match.value };
              })()
            `);
            return selectResult?.result?.value || { success: false, error: 'Select interaction failed' };
          }

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

          // Track field for duplicate-typing detection
          const fieldIdent = `focused:${focus.tag}|${focus.name}`;
          const prev = this._lastTypeFieldIdent?.get(tabId);
          let warning;
          if (prev === fieldIdent) {
            warning = 'You typed into the same field twice in a row. If you intended to fill a DIFFERENT field, click it first before calling type_text.';
          }
          if (!this._lastTypeFieldIdent) this._lastTypeFieldIdent = new Map();
          this._lastTypeFieldIdent.set(tabId, fieldIdent);

          return {
            success: true,
            method: 'cdp-insert-focused',
            text: (args.text || '').slice(0, 100),
            focusedField: { tag: focus.tag, type: focus.type, name: focus.name },
            ...(warning ? { warning } : {}),
          };
        }
        // index-based: fall through to content-script path.
      } catch (e) {
        return { success: false, error: `Type failed: ${e.message}` };
      }
    }

    if (name === 'press_keys') {
      const key = args.key;
      const repeatRaw = Number(args.repeat ?? 1);
      const repeat = Math.max(1, Math.min(3, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 1));
      if (!['Escape', 'Tab', 'Enter'].includes(key)) {
        return { success: false, error: `Unsupported key "${key}". V1 supports Escape, Tab, and Enter.` };
      }

      try {
        await cdpClient.attach(tabId);
        const keyMeta = {
          Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
          Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
          Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
        }[key];

        for (let i = 0; i < repeat; i++) {
          await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key,
            code: keyMeta.code,
            windowsVirtualKeyCode: keyMeta.windowsVirtualKeyCode,
          });
          await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code: keyMeta.code,
            windowsVirtualKeyCode: keyMeta.windowsVirtualKeyCode,
          });
        }

        return { success: true, method: 'cdp-key', key, repeat };
      } catch (e) {
        // Fall through to content-script path if CDP is unavailable.
      }
    }

    // Map tool names to content script actions
    const actionMap = {
      'read_page': 'get_page_info_cdp',
      'get_interactive_elements': 'get_interactive_elements_cdp',
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
    // Collect candidate JSON strings from known wrapper patterns.
    const patterns = [
      // <tool_call>JSON</tool_call>
      /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
      // <|tool_call|>JSON<|/tool_call|>  or  <|tool_call>JSON<tool_call|>
      /<\|tool_call\|?>\s*([\s\S]*?)\s*<\|?\/?tool_call\|?>/gi,
      // <functioncall>JSON</functioncall>
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
        // Some local models use <|"|> as quote tokens and call:name as the
        // invocation syntax.  Normalize to JSON and parse.
        const callMatch = /^call:(\w+)\s*\{([\s\S]*)\}$/.exec(inner);
        if (callMatch && AGENT_TOOL_NAMES.has(callMatch[1])) {
          const toolName = callMatch[1];
          let argsBody = callMatch[2]
            .replace(/<\|"\|>/g, '"')  // replace quote tokens with real quotes
            .replace(/<\|'\\?\|>/g, "'");  // handle single-quote tokens if any
          // argsBody is now like: url:"https://example.com",text:"hello"
          // Wrap unquoted keys to make valid JSON: key:"val" → "key":"val"
          argsBody = argsBody.replace(/(?<=^|,)\s*(\w+)\s*:/g, '"$1":');
          try {
            const args = JSON.parse(`{${argsBody}}`);
            results.push({ name: toolName, arguments: args });
          } catch {
            // If JSON parse still fails, try treating entire body as single
            // string argument for zero-arg or simple calls.
            results.push({ name: toolName, arguments: {} });
          }
          continue;
        }
      }
    }

    // Fallback: scan for bare JSON objects containing a "name" key with a
    // known tool name. Only look for top-level objects (starts with {).
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

    // Convert to OpenAI tool_calls format.
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
        this._persist(tabId);
        return fullText;

      } catch (e) {
        this._logDebug({ type: 'llm_stream_error', step: steps, error: e.message });
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
