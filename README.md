# WebBrain

Open-source AI browser agent for Chrome and Firefox. Chat with any web page, automate browser tasks, and run multi-step agent workflows — powered by your choice of LLM.

**Current version:** `4.2.0`

## What's New in 4.2.0 (from 1.x)

- **Safety-first API behavior** via `/allow-api` per-conversation override (UI-first for mutations by default)
- **Cross-origin iframe interaction tools** (`iframe_read`, `iframe_click`, `iframe_type`) for embedded forms and widgets
- **Network research tools** (`fetch_url`, `research_url`) for fast read-only data retrieval
- **Download workflow tools** (`download_file`, `download_files`, `list_downloads`, `read_downloaded_file`)
- **Trace viewer and quality-of-life upgrades** including step-limit continuation and stronger context controls

## Features

- **Page Reading** — Extracts text, links, forms, tables, and interactive elements from any page
- **Browser Actions** — Click, type, scroll, navigate, and interact with page elements
- **Ask / Act Modes** — Read-only mode by default, full agent mode with confirmation
- **Multi-Step Agent** — Autonomous task execution with tool-use loops (configurable, default 25 steps)
- **Continue from Limit** — When the agent hits the step limit, click Continue to keep going
- **Multi-Provider LLM** — Supports local and cloud models:
  - **llama.cpp** (local, default) — No API key needed
  - **OpenAI** (GPT-4o, etc.)
  - **OpenRouter** (access 100+ models)
  - **Anthropic Claude** (native API)
- **Side Panel UI** — Clean chat interface that lives alongside your browsing
- **Per-Tab Conversations** — Each tab has its own chat history
- **Streaming** — Real-time token streaming from all providers
- **Smart Context** — Automatic context trimming, tool result limits, and emergency overflow recovery
- **Copy Support** — Copy buttons on code blocks and full messages
- **Page Inspection Banner** — Visual indicator when the agent is interacting with the page
- **Stop Button** — Abort the agent mid-execution at any time

## Quick Start

### Chrome

```bash
git clone https://github.com/esokullu/webbrain.git
```

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `webbrain` folder

### Firefox

```bash
git clone https://github.com/esokullu/webbrain.git
```

1. Open Firefox → `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Navigate to `src/firefox/` and select `manifest.json`

> **Note:** Temporary add-ons are removed when Firefox restarts. For permanent installation, the extension needs to be signed via [addons.mozilla.org](https://addons.mozilla.org).

### Start a local LLM (default)

```bash
# Using llama.cpp
llama-server -m your-model.gguf --port 8080

# Or using Ollama (OpenAI-compatible)
ollama serve
# Then set base URL to http://localhost:11434/v1 in settings
```

### Use it

Click the WebBrain icon → the side panel opens. Type a message like:

- "Summarize this page"
- "Find all links about pricing"
- "Fill in the search box with 'AI agents' and click Search"
- "Navigate to github.com and find trending repositories"

## Configuration

Click the gear icon or go to the extension's Options page to configure:

**Display Settings:**
- Verbose Mode — Show full tool call JSON (off by default)
- Screenshot Fallback — Use screenshots when DOM reading fails
- Max Agent Steps — Configurable step limit (5-50, default 25)

**Providers:**

| Provider | Base URL | API Key |
|----------|----------|---------|
| llama.cpp | `http://localhost:8080` | Not needed |
| OpenAI | `https://api.openai.com/v1` | Required |
| OpenRouter | `https://openrouter.ai/api/v1` | Required |
| Anthropic | `https://api.anthropic.com` | Required |

## Architecture

```
src/chrome/                        src/firefox/
├── manifest.json (MV3)            ├── manifest.json (MV2)
├── src/                           ├── src/
│   ├── background.js              │   ├── background.js (+ background.html)
│   ├── agent/                     │   ├── agent/
│   ├── content/                   │   ├── content/
│   ├── providers/                 │   ├── providers/
│   ├── network/                   │   ├── network/
│   ├── trace/                     │   ├── trace/
│   ├── ui/                        │   └── ui/
│   └── offscreen/                 ├── styles/
├── styles/                        ├── icons/
└── icons/                         └── LICENSE

web/
├── index.html
├── privacy.html
└── vercel.json
```

Key difference: Chrome uses Manifest V3 (service worker, `chrome.scripting`, `sidePanel` API), Firefox uses Manifest V2 (background page, `browser.tabs.executeScript`, `sidebar_action`).

## Agent Tools

| Tool | Ask Mode | Act Mode | Description |
|------|----------|----------|-------------|
| `read_page` | Yes | Yes | Extract page text, links, forms |
| `screenshot` | Yes | Yes | Capture visible tab |
| `get_interactive_elements` | Yes | Yes | List all clickable/interactive elements |
| `scroll` | Yes | Yes | Scroll the page |
| `extract_data` | Yes | Yes | Extract tables, headings, images |
| `get_selection` | Yes | Yes | Get highlighted text |
| `click` | No | Yes | Click elements by selector, index, or coordinates |
| `type_text` | No | Yes | Type into input fields |
| `navigate` | No | Yes | Go to a URL |
| `wait_for_element` | No | Yes | Wait for a selector to appear |
| `execute_js` | No | Yes | Run custom JavaScript |
| `new_tab` | No | Yes | Open a new tab |
| `fetch_url` | Yes | Yes | Fetch a URL from the background with the user's cookies. Best for JSON APIs, READMEs, plain HTML. |
| `research_url` | Yes | Yes | Open a URL in a hidden tab, wait for JS rendering, return main content. Best for SPAs. |
| `list_downloads` | Yes | Yes | List recent downloads with status and source URLs. |
| `read_downloaded_file` | No | Yes | Re-fetch a downloaded file's content (text or base64). |
| `download_file` | No | Yes | Download a single file from a URL. |
| `download_files` | No | Yes | Download multiple files in parallel (max 3 concurrent). |
| `download_resource_from_page` | No | Yes | Download an `<img>`/`<video>`/blob URL from the current page. |
| `iframe_read` / `iframe_click` / `iframe_type` | No | Yes | Read/click/type inside cross-origin iframes (Stripe, embedded forms). |
| `done` | Yes | Yes | Signal task completion |

## Slash Commands

WebBrain accepts a small set of slash commands as the first thing on a line in the input box:

| Command | What it does |
|---------|--------------|
| `/allow-api` | **Per-conversation API mutation override.** By default WebBrain refuses to use API endpoints (POST/PUT/PATCH/DELETE via `fetch_url` or `execute_js`) for any action that creates, modifies, deletes, or sends — it always goes through the visible UI of the current page so you can see what's happening. Type `/allow-api` (optionally followed by a task description) to lift that restriction *for the current conversation only*. The agent will still prefer UI when UI works, but may fall back to API mutations when UI is genuinely failing or unworkable. A sticky badge appears above the input area while the override is active. The flag clears when you reset the conversation. |

The default UI-first rule exists because API actions are invisible (you don't see what's being sent), often require separate auth tokens you may not have configured, and can have a much larger blast radius than a visible mis-click. Only use `/allow-api` when you've decided you want that tradeoff for a specific job.

## Known Issues

- **Firefox is meaningfully weaker than Chrome.** Firefox has no equivalent to Chrome DevTools Protocol via `chrome.debugger`, so several Chrome-only features are missing in the Firefox build:
  - Click/type goes through the content-script path (`document.querySelector` + `el.click()`) instead of CDP `Input.dispatchMouseEvent`. This means **no shadow-DOM piercing**, **no real trusted mouse events** (some React/Vue handlers won't fire), **no closed-shadow-root traversal**, and **no `resolveSelector` retry budget**.
  - **No SPA-navigation-aware retry extension.**
  - **No conversation persistence** across background restarts.
  - **No CDP screenshots.** Auto-screenshot uses `tabs.captureVisibleTab` instead, which works for active tabs only and at slightly lower quality.
  - **No closed shadow root support** for read/extract tools.
  - Site adapters, vision detection, loop detection, and the auto-screenshot loop *are* mirrored to Firefox.
- **SPA navigation detection in Firefox.** Some single-page applications may not trigger content-script re-injection after client-side navigation.
- **Firefox temporary add-on** — Firefox requires the extension to be loaded as a temporary add-on during development, which is removed on restart.

## Roadmap

- [ ] **Conversation export/import** — Save and load chat histories
- [ ] **Custom tool definitions** — User-defined tools via settings
- [ ] **Keyboard shortcuts** — Hotkeys for opening panel, sending messages, switching modes
- [ ] **Context menu integration** — Right-click → "Ask WebBrain about this"
- [ ] **Screenshot/vision tool** — Send screenshots to multimodal models for visual understanding
- [ ] **Chrome Web Store / Firefox AMO** — Official store listings

## Adding a New Provider

1. Create a new class extending `BaseLLMProvider` in `src/providers/`
2. Implement `chat()` and optionally `chatStream()`
3. Register it in `src/providers/manager.js`

All providers normalize to a common response format:
```js
{ content: string, toolCalls: Array|null, usage: Object|null }
```


## License

MIT — built by [Emre Sokullu](https://emresokullu.com)
