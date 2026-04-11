# WebBrain Chrome Extension — Architecture

> Version 2.1.0 · Manifest V3 · Service Worker background

## High-Level Overview

WebBrain is a browser extension that gives an LLM full control over the browser tab the user is looking at. The user types a natural-language instruction in a side panel, and an autonomous agent loop calls the LLM, executes tool calls (click, type, navigate, screenshot, etc.), feeds results back to the LLM, and repeats until the task is done.

```
┌────────────┐     messages      ┌─────────────┐    HTTP/JSON     ┌──────────────┐
│  Side Panel │ ◄──────────────► │  Background  │ ◄──────────────► │  LLM Provider│
│  (UI)       │   chrome.runtime │  (Agent)     │   fetch()        │  (OpenAI /   │
│  sidepanel  │   .sendMessage   │  agent.js    │                  │   Anthropic /│
│  .js        │                  │  background  │                  │   llama.cpp) │
└──────┬──────┘                  │  .js         │                  └──────────────┘
       │                         └──────┬───────┘
       │                                │
       │     ┌──────────────────────────┤
       │     │ chrome.debugger (CDP)    │ chrome.tabs.executeScript
       │     ▼                         ▼
       │  ┌──────────┐          ┌──────────────┐
       │  │ CDP      │          │ Content      │
       │  │ Client   │          │ Script       │
       │  │ cdp-     │          │ content.js   │
       │  │ client.js│          │ (injected)   │
       │  └──────────┘          └──────────────┘
       │        │                      │
       └────────┴──────────────────────┘
                    DOM / Page
```

## Directory Structure

```
src/chrome/
├── manifest.json            # Manifest V3 config
├── src/
│   ├── background.js        # Service worker — message router
│   ├── agent/
│   │   ├── agent.js          # Core agent loop (1820+ lines)
│   │   ├── tools.js          # Tool schemas + system prompts
│   │   └── adapters.js       # Per-site guidance (GitHub, Stripe, etc.)
│   ├── cdp/
│   │   └── cdp-client.js     # Chrome DevTools Protocol wrapper
│   ├── content/
│   │   └── content.js        # Injected DOM reader / clicker
│   ├── network/
│   │   └── network-tools.js  # fetch_url, research_url, downloads
│   ├── providers/
│   │   ├── base.js           # Provider interface
│   │   ├── manager.js        # Provider lifecycle
│   │   ├── openai.js         # OpenAI-compatible (GPT, LM Studio, OpenRouter)
│   │   ├── anthropic.js      # Anthropic Claude
│   │   └── llamacpp.js       # Local llama.cpp server
│   └── ui/
│       ├── sidepanel.html
│       ├── sidepanel.js      # Chat UI, verbose mode, deep verbose
│       ├── settings.html
│       └── settings.js       # Provider config UI
└── icons/
```

## Permissions

```json
{
  "permissions": [
    "sidePanel",     // Side panel API
    "activeTab",     // Access active tab
    "scripting",     // Inject content scripts
    "storage",       // Persist settings + conversations
    "webNavigation", // Track navigation events
    "debugger",      // Chrome DevTools Protocol (CDP) — key differentiator
    "downloads"      // File download management
  ],
  "host_permissions": ["<all_urls>"]
}
```

The `debugger` permission is the most important — it allows CDP access for trusted mouse/keyboard events, pixel-perfect screenshots, and shadow DOM piercing.

---

## Agent Loop

The agent lives in `agent.js` and runs inside the background service worker. It implements a multi-step tool-use loop:

```
User message
    │
    ▼
┌─ _enrichFirstUserMessage() ──────────────────────────────┐
│  • Attach page URL + title                                │
│  • Inject site adapter notes (if URL matches)             │
│  • Inject /allow-api override (if set)                    │
│  • Capture viewport screenshot (if provider has vision)   │
│  • Build multimodal content array [text, image_url]       │
└───────────────────────────────────────────────────────────┘
    │
    ▼
┌─ Main Loop (max 120 steps) ──────────────────────────────┐
│  1. Call provider.chat(messages, {tools, temp, maxTokens})│
│  2. If response has tool_calls:                           │
│     a. Execute each tool via _executeToolBatch()          │
│     b. Push tool results into messages[]                  │
│     c. Auto-screenshot if state changed + vision          │
│     d. Detect loops (nudge → stop)                        │
│     e. Detect unintended navigation → warn model          │
│     f. Continue loop                                      │
│  3. If response has only text: return as final answer     │
│  4. If done() tool called: return summary immediately     │
└───────────────────────────────────────────────────────────┘
```

### Two execution modes

| | `processMessage()` | `processMessageStream()` |
|---|---|---|
| LLM call | `provider.chat()` — single response | `provider.chatStream()` — SSE chunks |
| UI updates | `onUpdate('text', ...)` at end | `onUpdate('text_delta', ...)` incrementally |
| Tool calls | Parsed from `result.toolCalls` | Accumulated from stream deltas |
| Use case | Simpler, works with all providers | Better UX for long responses |

---

## Example LLM Request & Response

### First turn — Act mode, vision-capable provider

**What the agent sends to `provider.chat()`:**

```json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "system",
      "content": "You are WebBrain, an AI browser agent running in Act mode. You can read web pages, interact with elements, navigate, and perform multi-step tasks autonomously.\n\nOPERATING ENVIRONMENT — read this carefully:\n- You are NOT a generic chatbot. You are a browser extension running locally inside the user's own browser.\n- You operate inside the user's authenticated browser session...\n\n[Full Act system prompt — ~120 lines of behavioral guidance]\n\nCLICKING — read this:\n- Default text matching is EXACT (case-insensitive). If exact fails, the system automatically tries prefix then substring...\n\nINDEX INSTABILITY — read this:\n- Indices from get_interactive_elements are NOT stable identifiers..."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "[Page context — URL: https://dashboard.stripe.com/test/products — Title: Products | Stripe Dashboard]\n\n[Site guidance for stripe — FINANCE / HIGH-STAKES]\n- Always confirm amounts before submitting...\n\n[Initial viewport screenshot follows. The image is 1440×900 pixels and represents the visible viewport at a 1:1 CSS-pixel coordinate system...]\n\ncreate a new subscription called Visne for $1000/year"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4AAQ..."
          }
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_page",
        "description": "Read the current page content including title, URL, text content, links, and forms.",
        "parameters": { "type": "object", "properties": {}, "required": [] }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "click",
        "description": "Click an element. FOUR ways to use it: (1) CSS selector, (2) visible text, (3) element index from get_interactive_elements, (4) x/y coordinates...",
        "parameters": {
          "type": "object",
          "properties": {
            "text": { "type": "string" },
            "textMatch": { "type": "string", "enum": ["exact", "prefix", "contains"] },
            "selector": { "type": "string" },
            "index": { "type": "number" },
            "x": { "type": "number" },
            "y": { "type": "number" }
          }
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "type_text",
        "description": "Type text into an input field...",
        "parameters": {
          "type": "object",
          "properties": {
            "selector": { "type": "string" },
            "index": { "type": "number" },
            "text": { "type": "string" },
            "clear": { "type": "boolean" }
          },
          "required": ["text"]
        }
      }
    }
    // ... 27 more tools (screenshot, scroll, navigate, verify_form, press_keys, etc.)
  ],
  "tool_choice": "auto",
  "temperature": 0.3,
  "max_tokens": 4096,
  "stream": false
}
```

### LLM response — tool call

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "click",
          "arguments": "{\"text\":\"Create product\"}"
        }
      }]
    }
  }]
}
```

### What happens next

1. Agent parses `tool_calls`, extracts `click({text: "Create product"})`
2. Calls `executeTool(tabId, 'click', {text: 'Create product'})`
3. CDP evaluates JS in page to find element matching "Create product" (exact → prefix → contains)
4. Dispatches `Input.dispatchMouseEvent` (mouseMoved, mousePressed, mouseReleased) at element center
5. Returns `{success: true, method: 'cdp-by-text', tag: 'BUTTON', text: 'Create product'}`
6. Agent pushes tool result into messages as a `tool` role message
7. Detects state change → captures auto-screenshot → appends as user message with image
8. Calls provider.chat() again with updated messages
9. Loop continues until LLM responds with text only (no tool_calls) or calls `done()`

### Tool result → next LLM call

The messages array grows with each tool call/result cycle:

```json
[
  { "role": "system", "content": "..." },
  { "role": "user", "content": [{"type": "text", "text": "..."}, {"type": "image_url", ...}] },
  {
    "role": "assistant",
    "content": null,
    "tool_calls": [{"id": "call_abc123", "function": {"name": "click", "arguments": "{\"text\":\"Create product\"}"}}]
  },
  {
    "role": "tool",
    "tool_call_id": "call_abc123",
    "content": "{\"success\":true,\"method\":\"cdp-by-text\",\"tag\":\"BUTTON\",\"text\":\"Create product\"}"
  },
  {
    "role": "user",
    "content": [
      {"type": "text", "text": "[Auto-screenshot of current viewport after the action above. Image is 1440×900 pixels...]"},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
    ]
  }
]
```

---

## Tools

### Full tool list (30 tools)

| Tool | Description | Ask | Act |
|------|-------------|-----|-----|
| `read_page` | Page content (title, URL, text, links, forms) | ✓ | ✓ |
| `screenshot` | Viewport capture as base64 | ✓ | ✓ |
| `get_interactive_elements` | Indexed list of clickable/typable elements | ✓ | ✓ |
| `click` | Click by text/selector/index/coordinates | | ✓ |
| `type_text` | Type into focused or targeted field | | ✓ |
| `press_keys` | Press Escape, Tab, or Enter | | ✓ |
| `scroll` | Scroll page up/down/to element | ✓ | ✓ |
| `navigate` | Go to URL | | ✓ |
| `new_tab` | Open URL in new tab | | ✓ |
| `wait_for_element` | Wait for selector to appear | | ✓ |
| `extract_data` | Extract tables/headings/images | ✓ | ✓ |
| `get_selection` | Get highlighted text | ✓ | ✓ |
| `execute_js` | Run arbitrary JavaScript in page | | ✓ |
| `get_shadow_dom` | Read shadow DOM content | | ✓ |
| `get_frames` | List iframes on page | | ✓ |
| `iframe_read` | Read inside cross-origin iframe | | ✓ |
| `iframe_click` | Click inside cross-origin iframe | | ✓ |
| `iframe_type` | Type inside cross-origin iframe | | ✓ |
| `fetch_url` | HTTP request with user's cookies | ✓ | ✓ |
| `research_url` | Open URL in background tab, read content | ✓ | ✓ |
| `list_downloads` | List recent downloads | ✓ | ✓ |
| `read_downloaded_file` | Read a downloaded file's content | | ✓ |
| `download_resource_from_page` | Download a resource from current page | | ✓ |
| `download_files` | Download files by URL | | ✓ |
| `verify_form` | Read form field values + screenshot before submit | | ✓ |
| `done` | Signal task completion with summary | ✓ | ✓ |

### Click tool — text matching behavior

The `click({text: "..."})` tool uses a cascading match strategy:

```
1. EXACT match     → "Save" matches "Save" only
2. PREFIX match    → "Save" matches "Save changes"
3. CONTAINS match  → "Save" matches "Auto-Save settings"
```

- Default (no `textMatch` param): tries exact → prefix → contains automatically
- If `textMatch` is explicitly set: only that mode is used
- **Ambiguity detection**: if >1 element matches at any level, returns an error with candidate list instead of clicking arbitrarily

### Press keys (v1)

Limited to three safe keys: `Escape`, `Tab`, `Enter`. Uses CDP `Input.dispatchKeyEvent` for trusted events. Primary use case: dismissing modals, advancing focus, submitting forms.

### Verify form (v2.1)

Pre-submission safety check. Reads all `<input>`, `<select>`, and `<textarea>` values from a form and captures a viewport screenshot. The LLM compares returned values against what it intended to type, catching silent `type_text` failures (focus lost, field cleared by JS, wrong target).

```
verify_form({selector: "#checkout-form"})
→ {
    success: true,
    action: "https://example.com/checkout",
    method: "post",
    fieldCount: 4,
    fields: [
      { name: "email", type: "email", value: "user@example.com", placeholder: "Email" },
      { name: "card",  type: "text",  value: "4242...4242",      placeholder: "Card number" },
      { name: "plan",  type: "select", value: "Pro [$49/mo]",    placeholder: "" },
      { name: "terms", type: "checkbox", value: "on",            placeholder: "" }
    ],
    image: "data:image/png;base64,..."
  }
```

- If `selector` is omitted, uses the form containing the focused element, or the first form on the page
- Hidden and submit-type inputs are excluded
- Chrome uses CDP `Runtime.evaluate` + `Page.captureScreenshot`
- System prompt guides the LLM to call this before submitting important multi-field forms (not search boxes or logins)

---

## Chrome DevTools Protocol (CDP)

The `cdp-client.js` module wraps `chrome.debugger` to provide:

| Capability | CDP Domain | Use |
|---|---|---|
| Screenshot | `Page.captureScreenshot` | Viewport capture |
| Click | `Input.dispatchMouseEvent` | Trusted mouse events |
| Keyboard | `Input.dispatchKeyEvent` | press_keys, clear field |
| Evaluate JS | `Runtime.evaluate` | Run code in page context |
| DOM query | `DOM.querySelector` | Shadow DOM piercing |

CDP events are **trusted** — they behave exactly like real user input. This is critical for sites that reject synthetic `el.click()` or `new MouseEvent()`.

### CDP click vs content-script click

| | CDP path | Content-script fallback |
|---|---|---|
| How | `Input.dispatchMouseEvent` at (x,y) | `el.click()` in injected JS |
| Trusted | Yes — indistinguishable from real user | No — `event.isTrusted === false` |
| Cross-origin | Works (coordinates don't care about origin) | Blocked by same-origin |
| Used when | Default for Chrome | Fallback when CDP unavailable |

---

## Provider System

### Provider interface (`base.js`)

```javascript
class BaseProvider {
  async chat(messages, options)       // → { content, toolCalls, usage }
  async *chatStream(messages, options) // yields { type, content }
  get supportsTools()                  // boolean
  get supportsVision()                 // boolean
  async testConnection()              // throws on failure
}
```

### Provider implementations

| Provider | Endpoint | Vision detection | Notes |
|---|---|---|---|
| `OpenAIProvider` | `/v1/chat/completions` | Model name regex (`gpt-4o`, `gpt-5`, vision models) | Also handles LM Studio, OpenRouter |
| `AnthropicProvider` | `/v1/messages` | `claude-(3\|sonnet-4\|opus-4)` patterns | Converts OpenAI format → Anthropic blocks |
| `LlamaCppProvider` | `localhost:8080/v1/chat/completions` | Explicit opt-in via config | Local inference, OpenAI-compatible |
| Ollama (via `OpenAIProvider`) | `localhost:11434/v1/chat/completions` | Explicit opt-in via config | Uses OpenAI-compatible API, apiKey='ollama' |

### Anthropic message conversion

The agent uses OpenAI-format messages internally. The Anthropic provider converts:

```
OpenAI format                          Anthropic format
─────────────                          ─────────────────
system message                    →    separate `system` field
assistant + tool_calls            →    assistant + tool_use blocks
tool role + tool_call_id          →    user role + tool_result blocks
image_url (data:base64)           →    image source (base64 block)
```

---

## Loop Detection

Three independent detectors run in parallel, strongest action wins:

### 1. General repeat detector
- Records last 6 tool calls (name + args hash + success/error)
- **Nudge** (warning injected into context): 3 identical calls, or ABAB oscillation
- **Stop** (conversation halted): 8 nudges without 2 consecutive healthy calls between

### 2. Coordinate click detector
- Buckets clicks to 5px radius
- **Nudge** at 5 identical coordinate clicks
- **Stop** at 8 — with message explaining the coordinates hit empty space
- Separate window of 12 entries (independent of general detector)

### 3. Navigation detector
- Snapshots URL before `click`, `navigate`, `execute_js`, `iframe_click`
- Compares URL after (200ms delay for SPA routing)
- If URL changed unexpectedly (not via `navigate`), injects `[NAVIGATION OCCURRED]` warning

---

## Context Management

### Automatic trimming (`_manageContext`)
- Triggers when messages > 50 or total chars > 80,000
- Strategy: keep system prompt + summarize oldest messages via LLM + keep last 16 verbatim
- Compressed summary capped at 2,000 chars

### Emergency trimming (`_emergencyTrim`)
- Triggered by context overflow errors from the provider
- Aggressively removes oldest messages, retries once

### Image pruning (`_pruneOldImages`)
- Before each LLM call, strips base64 images from all but the last 4 messages
- Prevents vision-capable conversations from blowing up context

### Tool result limiting (`_limitToolResult`)
- Caps individual tool results at 8,000 chars
- Truncates with `[truncated]` marker

---

## Conversation Persistence

Conversations survive service worker restarts (important for MV3):

```
chrome.storage.session['agentConv:<tabId>'] = JSON.stringify(messages)
```

- **Persist**: debounced 300ms after any message change
- **Hydrate**: lazy-loaded on first message to a tab
- **Per-tab isolation**: each tab has its own conversation + mode

---

## Site Adapters

17 adapters inject site-specific guidance into the first user message:

| Category | Sites |
|---|---|
| Code & Dev | GitHub, GitLab, Stack Overflow, Hacker News |
| Productivity | Gmail, Google Docs, Slack, Notion, Jira |
| Social | Twitter/X, LinkedIn, Reddit, YouTube |
| Publishing | Medium, Substack |
| Commerce | Amazon |
| Cloud | AWS, GCP |
| Finance | Stripe, Coinbase, Chase, Robinhood (generic) |

Finance adapters get an extra `[FINANCE / HIGH-STAKES]` heading and conservative guidance.

Adapters are re-injected mid-conversation if the user navigates to a different matched site.

---

## Side Panel UI

### Modes
- **Ask mode**: read-only tools, analysis/Q&A
- **Act mode**: full tool set, autonomous actions

### Verbose mode
- **Normal**: shows compact step labels ("clicking 'Submit'", "typing 'hello'")
- **Verbose ON**: shows full JSON tool call args + truncated results
- **Deep verbose** (hidden): Shift+click the verbose button → dumps full LLM request/response log to DevTools console

### Deep verbose log

The agent maintains a ring buffer (`_debugLog`, max 200 entries) of every LLM call:

```javascript
// Logged for every provider.chat() / provider.chatStream() call:
{ type: 'llm_request',       step: 1, provider: 'OpenAIProvider', messages: [...], options: {...}, timestamp: '...' }
{ type: 'llm_response',      step: 1, content: '...', toolCalls: [...], timestamp: '...' }
{ type: 'llm_error',         step: 2, error: 'Rate limit exceeded', timestamp: '...' }
{ type: 'llm_stream_request', step: 3, provider: 'AnthropicProvider', messages: [...], ... }
```

Shift+clicking the verbose button sends `get_debug_log` to the background, which returns the full buffer. The sidepanel dumps it to `console.log` with color-coded, collapsible groups.

---

## Message Flow — Complete Walkthrough

```
1. User types "click the Submit button" in side panel
2. sidepanel.js sends {action:'chat', text:'...', mode:'act', tabId:42}
   via chrome.runtime.sendMessage

3. background.js receives, calls agent.processMessage(42, text, onUpdate, 'act')

4. Agent builds messages array:
   [system prompt, enriched user message with screenshot]

5. Agent calls provider.chat(messages, {tools, temp:0.3, maxTokens:4096})
   → Logged to _debugLog as 'llm_request'

6. Provider POSTs to LLM API, gets response
   → Logged to _debugLog as 'llm_response'

7. LLM returns tool_calls: [{name:'click', args:{text:'Submit'}}]

8. Agent calls _executeToolBatch():
   a. onUpdate('tool_call', ...) → sidepanel shows "clicking 'Submit'"
   b. executeTool() → CDP evaluates JS to find "Submit" element
   c. CDP dispatches mouse events at element center
   d. onUpdate('tool_result', ...) → sidepanel shows result
   e. State change detected → auto-screenshot captured
   f. Screenshot appended to messages as user content

9. Agent calls provider.chat() again with updated messages
   → LLM sees tool result + new screenshot

10. LLM responds with text only (no tool_calls):
    "Done — I clicked the Submit button."

11. Agent returns final text
    → sidepanel renders as assistant message
```

---

## Security Model

- Extension runs with user's full browser permissions — no additional auth needed
- `host_permissions: <all_urls>` allows content script injection anywhere
- CDP debugger access allows trusted events on any tab
- Cross-origin iframes accessible via content script injection (extension privilege)
- `/allow-api` flag required for API mutations (POST/PUT/DELETE via fetch_url)
- Finance sites get extra safety warnings via adapters
- Tool results are capped at 8KB to prevent context injection attacks
