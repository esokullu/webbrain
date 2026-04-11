# WebBrain Firefox Extension — Architecture

> Version 2.1.0 · Manifest V2 · Background Page

## How Firefox Differs from Chrome

Firefox uses Manifest V2 (background page, not service worker) and has **no access to the Chrome DevTools Protocol (CDP)**. This means:

- **No trusted events** — clicks and key presses are synthetic (`el.click()`, `new KeyboardEvent()`), and some sites reject `event.isTrusted === false`
- **No pixel-perfect screenshots** — uses `browser.tabs.captureVisibleTab()` instead of CDP `Page.captureScreenshot`
- **No conversation persistence** — conversations are lost when the sidebar closes (no session storage equivalent)
- **No shadow DOM piercing** — content script can read shadow DOM via `element.shadowRoot`, but can't pierce closed shadow roots
- **Fewer tools** — 27 vs Chrome's 30 (missing full-page screenshot, shadow DOM query, file upload)

Everything else — the agent loop, LLM providers, site adapters, loop detection — is architecturally identical.

---

## High-Level Overview

```
┌────────────┐     messages      ┌─────────────┐    HTTP/JSON     ┌──────────────┐
│  Sidebar    │ ◄──────────────► │  Background  │ ◄──────────────► │  LLM Provider│
│  (UI)       │  browser.runtime │  Page        │   fetch()        │  (OpenAI /   │
│  sidepanel  │  .sendMessage    │  agent.js    │                  │   Anthropic /│
│  .js        │                  │  background  │                  │   llama.cpp) │
└──────┬──────┘                  │  .js         │                  └──────────────┘
       │                         └──────┬───────┘
       │                                │
       │              browser.tabs.executeScript
       │                                │
       │                                ▼
       │                         ┌──────────────┐
       │                         │ Content      │
       │                         │ Script       │
       │                         │ content.js   │
       │                         │ (injected)   │
       │                         └──────────────┘
       │                                │
       └────────────────────────────────┘
                    DOM / Page
```

**Key difference from Chrome:** No CDP client box. All DOM interaction goes through content script injection only.

## Directory Structure

```
src/firefox/
├── manifest.json            # Manifest V2 config
├── src/
│   ├── background.html      # Background page (MV2 requirement)
│   ├── background.js        # Message router
│   ├── agent/
│   │   ├── agent.js          # Core agent loop (~1300 lines)
│   │   ├── tools.js          # Tool schemas + system prompts
│   │   └── adapters.js       # Per-site guidance (identical to Chrome)
│   ├── content/
│   │   └── content.js        # Injected DOM reader / clicker
│   ├── network/
│   │   └── network-tools.js  # fetch_url, research_url
│   ├── providers/
│   │   ├── base.js           # Provider interface (identical to Chrome)
│   │   ├── manager.js        # Provider lifecycle
│   │   ├── openai.js         # OpenAI-compatible
│   │   ├── anthropic.js      # Anthropic Claude
│   │   └── llamacpp.js       # Local llama.cpp server
│   └── ui/
│       ├── sidepanel.html
│       ├── sidepanel.js      # Chat UI, verbose mode, deep verbose
│       ├── settings.html
│       └── settings.js
└── icons/
```

## Permissions

```json
{
  "permissions": [
    "activeTab",
    "storage",
    "tabs",
    "<all_urls>"
  ]
}
```

Notably **missing** vs Chrome: `debugger`, `downloads`, `sidePanel`, `scripting`, `webNavigation`.

- No `debugger` → no CDP, no trusted events
- No `downloads` → limited file download support
- Uses `sidebar_action` (MV2) instead of `side_panel` (MV3)
- Uses `browser.tabs.executeScript()` instead of `chrome.scripting.executeScript()`

---

## Agent Loop

The agent loop is structurally identical to Chrome. The same `processMessage()` / `processMessageStream()` flow runs:

```
User message
    │
    ▼
_enrichFirstUserMessage()     ← same as Chrome (URL/title + screenshot + adapter)
    │
    ▼
Main Loop (max 120 steps)
    │
    ├─ provider.chat(messages, {tools, temp:0.3, maxTokens:4096})
    ├─ If tool_calls → _executeToolBatch() → push results → continue
    ├─ If text only → return as final answer
    └─ If done() → return summary
```

### Key difference: no conversation persistence

Chrome persists conversations to `chrome.storage.session` and hydrates on service worker restart. Firefox does **not** — conversations live only in memory and are lost when the sidebar closes.

```javascript
// Chrome has:
this.conversations = new Map();  // + _persist() + _hydrate()

// Firefox has:
this.conversations = new Map();  // memory only, no persistence
```

---

## Example LLM Request & Response

The LLM request format is identical to Chrome — the same OpenAI-compatible message array with system prompt, tools, and multimodal content. See Chrome's ARCHITECTURE.md for the full example.

### First turn (vision-capable provider)

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are WebBrain, an AI browser agent running in Act mode..." },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "[Page context — URL: https://example.com — Title: Example]\n\n[Initial viewport screenshot follows...]\n\nclick the login button" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
      ]
    }
  ],
  "tools": [ /* 27 tools in OpenAI function-calling format */ ],
  "tool_choice": "auto",
  "temperature": 0.3,
  "max_tokens": 4096
}
```

### LLM responds with tool call

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_xyz",
        "type": "function",
        "function": {
          "name": "click",
          "arguments": "{\"text\":\"Log in\"}"
        }
      }]
    }
  }]
}
```

### What happens next (different from Chrome)

1. Agent parses `click({text: "Log in"})`
2. Calls `executeTool()` → sends message to content script via `browser.tabs.sendMessage()`
3. Content script finds element matching "Log in" (exact → prefix → contains)
4. Content script calls `el.click()` — **synthetic, not trusted**
5. Returns `{success: true, tag: 'BUTTON', text: 'Log in'}`
6. Agent pushes tool result into messages
7. If vision supported: captures screenshot via `browser.tabs.captureVisibleTab()`
8. Calls `provider.chat()` again
9. Loop continues

### The critical difference: el.click() vs CDP

```
Chrome:  CDP Input.dispatchMouseEvent  →  event.isTrusted = true   ✓
Firefox: el.click() in content script  →  event.isTrusted = false  ⚠️
```

Most sites work fine with synthetic clicks. But some (banking, captchas, certain SPAs) check `event.isTrusted` and reject synthetic events. There's no workaround in Firefox — this is a platform limitation.

---

## Tools

### Tool list (27 tools — 3 fewer than Chrome)

| Tool | Description | Ask | Act | Chrome-only? |
|------|-------------|-----|-----|-------------|
| `read_page` | Page content | ✓ | ✓ | |
| `screenshot` | Viewport capture | ✓ | ✓ | |
| `get_interactive_elements` | Indexed clickable elements | ✓ | ✓ | |
| `click` | Click by text/selector/index/coords | | ✓ | |
| `type_text` | Type into field | | ✓ | |
| `press_keys` | Press Escape/Tab/Enter | | ✓ | |
| `scroll` | Scroll page | ✓ | ✓ | |
| `navigate` | Go to URL | | ✓ | |
| `new_tab` | Open URL in new tab | | ✓ | |
| `wait_for_element` | Wait for selector | | ✓ | |
| `extract_data` | Extract tables/headings | ✓ | ✓ | |
| `get_selection` | Get highlighted text | ✓ | ✓ | |
| `execute_js` | Run JavaScript in page | | ✓ | |
| `get_shadow_dom` | Read shadow DOM | | ✓ | |
| `get_frames` | List iframes | | ✓ | |
| `iframe_read` | Read inside iframe | | ✓ | |
| `iframe_click` | Click inside iframe | | ✓ | |
| `iframe_type` | Type inside iframe | | ✓ | |
| `fetch_url` | HTTP request | ✓ | ✓ | |
| `research_url` | Open + read URL | ✓ | ✓ | |
| `list_downloads` | List downloads | ✓ | ✓ | |
| `read_downloaded_file` | Read downloaded file | | ✓ | |
| `download_resource_from_page` | Download from page | | ✓ | |
| `download_files` | Download by URL | | ✓ | |
| `verify_form` | Read form field values + screenshot before submit | | ✓ | |
| `done` | Signal completion | ✓ | ✓ | |
| `full_page_screenshot` | Full-page capture | | | ✓ (Chrome only) |
| `shadow_dom_query` | CDP shadow pierce | | | ✓ (Chrome only) |
| `upload_file` | Form file upload | | | ✓ (Chrome only) |

### Click — content script implementation

Firefox's click implementation lives entirely in the content script (no CDP fallback):

```javascript
// Text-based click: auto-fallback matching
const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
for (const m of modes) {
  matches = tryMode(m);
  if (matches.length === 1) break;  // unique match
  if (matches.length > 1) break;    // ambiguous — error
}

// If found: synthetic click
el.scrollIntoView({ behavior: 'smooth', block: 'center' });
el.click();  // ← NOT trusted
```

### Press keys — content script implementation

No CDP available, so Firefox dispatches synthetic `KeyboardEvent`:

```javascript
const ev = new KeyboardEvent('keydown', {
  key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
  bubbles: true, cancelable: true
});
target.dispatchEvent(ev);
document.dispatchEvent(ev);  // also dispatch to document for broader coverage
```

For Tab, the content script implements manual focus advancement since synthetic Tab doesn't trigger the browser's native focus behavior:

```javascript
// Build list of focusable elements, find current, advance to next
const focusable = [...document.querySelectorAll(
  'a[href], button, input, textarea, select, [tabindex]'
)].filter(el => !el.disabled && el.tabIndex >= 0);
const idx = focusable.indexOf(document.activeElement);
focusable[(idx + 1) % focusable.length].focus();
```

### Verify form (v2.1)

Pre-submission safety check. Reads all form field values via `browser.tabs.executeScript()` and captures a viewport screenshot via `browser.tabs.captureVisibleTab()`. Same behavior as Chrome but uses content script injection instead of CDP.

- If `selector` is omitted, uses the form containing the focused element, or the first form on the page
- Hidden and submit-type inputs are excluded
- Screenshot requires the tab to be active (Firefox limitation)
- System prompt guides the LLM to call this before submitting important multi-field forms

---

## Content Script

The content script (`content.js`) is the **only** way Firefox interacts with the page. It handles:

### Interactive element discovery

```javascript
const INTERACTIVE_SELECTORS = `
  a[href], button, input:not([type="hidden"]), textarea, select,
  [role="button"], [role="link"], [role="tab"], [role="menuitem"],
  [role="textbox"], [role="combobox"], [role="searchbox"],
  [contenteditable=""], [contenteditable="true"],
  [onclick], [data-action], summary, label
`;
```

Elements are filtered for visibility (computed style, dimensions, aria-hidden) and returned with index, tag, type, role, text, rect, and editability flag.

### Type text — three paths

1. **ContentEditable**: sets `textContent`, dispatches `beforeinput` + `input` + `change`
2. **Select elements**: matches option by value or visible text
3. **Input/Textarea**: uses native property setter via `Object.getOwnPropertyDescriptor` to bypass React/Vue controlled component wrappers, dispatches `input` + `change`

### Page reading

- `getPageInfo()`: URL, title, description, text, links, forms
- `getPageInfoFull()`: extends with shadow DOM traversal and iframe detection
- `getInteractiveElements()`: indexed list with rects for the agent

---

## Provider System

Identical to Chrome. Same five providers (OpenAI, Anthropic, llama.cpp, Ollama, and generic OpenAI-compatible) with the same message format and conversion logic. Ollama uses the OpenAI-compatible provider with `localhost:11434/v1`.

Uses `browser.storage.local` instead of `chrome.storage.local` for config persistence.

---

## Loop Detection

Identical to Chrome. Same three detectors (general repeat, coordinate click, navigation) with the same thresholds and nudge/stop behavior.

---

## Context Management

Identical to Chrome:
- Auto-trim at >50 messages or >80,000 chars
- LLM-powered summarization of old messages
- Emergency trim on context overflow
- Image pruning (keep last 4 only)
- Tool result cap at 8,000 chars

---

## Side Panel UI

### Differences from Chrome

| Feature | Chrome | Firefox |
|---|---|---|
| Panel type | Side panel (MV3 API) | Sidebar action (MV2) |
| Chat persistence | Survives panel close | Lost on close |
| Tab tracking | `chrome.tabs.onActivated` + session storage | `browser.tabs.onActivated` + in-memory Map |
| Background comms | `chrome.runtime.sendMessage` | `browser.runtime.sendMessage` (async/await) |

### Verbose mode

Same three levels as Chrome:
- **Normal**: compact step labels
- **Verbose ON**: full JSON tool args + results
- **Deep verbose**: Shift+click verbose button → console dump of full LLM payloads

### Deep verbose

Works identically to Chrome. The agent stores a ring buffer of LLM requests/responses (max 200 entries). Shift+clicking the verbose button fetches and dumps to DevTools console with color-coded groups.

---

## Site Adapters

Identical to Chrome — same 17 adapters, same `getActiveAdapter(url)` matching, same mid-conversation re-injection on navigation.

---

## Message Flow — Complete Walkthrough

```
1. User types "click Submit" in sidebar

2. sidepanel.js sends {action:'chat', text:'click Submit', mode:'act', tabId:42}
   via browser.runtime.sendMessage()

3. background.js receives → agent.processMessage(42, text, onUpdate, 'act')

4. Agent builds messages:
   [system prompt, enriched user message (URL/title + screenshot)]

5. Agent calls provider.chat(messages, {tools, temp:0.3, maxTokens:4096})
   → Logged to _debugLog

6. LLM returns tool_calls: [{name:'click', args:{text:'Submit'}}]

7. Agent calls executeTool() → dispatches to content script:
   browser.tabs.sendMessage(42, {action:'click', params:{text:'Submit'}})

8. Content script:
   a. Finds <button>Submit</button> via text matching
   b. el.scrollIntoView()
   c. el.click()  ← synthetic, not trusted
   d. Returns {success: true, tag: 'BUTTON', text: 'Submit'}

9. Agent pushes tool result into messages
   Auto-screenshot via browser.tabs.captureVisibleTab()

10. Agent calls provider.chat() again with updated context

11. LLM responds with text: "Done — I clicked Submit."
    → sidepanel renders as assistant message
```

---

## Limitations vs Chrome

| Limitation | Impact | Workaround |
|---|---|---|
| No CDP (no `debugger` permission) | Clicks are synthetic (`isTrusted: false`) | Most sites work; some banking/captcha sites may reject |
| No conversation persistence | Chat lost when sidebar closes | None — MV2 limitation |
| No trusted keyboard events | `press_keys` may not work on all sites | Content script dispatches to both activeElement and document |
| No full-page screenshot | Can only capture visible viewport | Scroll + multiple screenshots |
| No shadow DOM piercing (closed) | Can't read closed shadow roots | `execute_js` with manual traversal |
| No file upload | Can't automate file input dialogs | User must upload manually |
| MV2 background page | Less efficient than MV3 service worker | `persistent: false` helps |

---

## Security Model

Same as Chrome, minus CDP:
- Extension runs with user's full browser permissions
- `<all_urls>` host permission allows content script injection anywhere
- Cross-origin iframes accessible via extension privilege
- `/allow-api` flag required for API mutations
- Finance adapters get extra safety warnings
- Tool results capped at 8KB
