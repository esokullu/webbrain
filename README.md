# WebBrain

Open-source AI browser agent for Chrome. Chat with any web page, automate browser tasks, and run multi-step agent workflows — powered by your choice of LLM.

## Features

- **Page Reading** — Extracts text, links, forms, tables, and interactive elements from any page
- **Browser Actions** — Click, type, scroll, navigate, and interact with page elements
- **Multi-Step Agent** — Autonomous task execution with tool-use loops (up to 20 steps)
- **Multi-Provider LLM** — Supports local and cloud models:
  - **llama.cpp** (local, default) — No API key needed
  - **OpenAI** (GPT-4o, etc.)
  - **OpenRouter** (access 100+ models)
  - **Anthropic Claude** (native API)
- **Side Panel UI** — Clean chat interface that lives alongside your browsing
- **Streaming** — Real-time token streaming from all providers

## Quick Start

### 1. Install the extension

```bash
git clone https://github.com/esokullu/webbrain.git
```

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `webbrain` folder

### 2. Start a local LLM (default)

```bash
# Using llama.cpp
llama-server -m your-model.gguf --port 8080

# Or using Ollama (OpenAI-compatible)
ollama serve
# Then set base URL to http://localhost:11434/v1 in settings
```

### 3. Use it

Click the WebBrain icon → the side panel opens. Type a message like:

- "Summarize this page"
- "Find all links about pricing"
- "Fill in the search box with 'AI agents' and click Search"
- "Navigate to github.com and find trending repositories"

## Configuration

Click the gear icon or go to the extension's Options page to configure providers:

| Provider | Base URL | API Key |
|----------|----------|---------|
| llama.cpp | `http://localhost:8080` | Not needed |
| OpenAI | `https://api.openai.com/v1` | Required |
| OpenRouter | `https://openrouter.ai/api/v1` | Required |
| Anthropic | `https://api.anthropic.com` | Required |

## Architecture

```
webbrain/
├── manifest.json              # Chrome MV3 manifest
├── src/
│   ├── background.js          # Service worker — message router
│   ├── agent/
│   │   ├── agent.js           # Multi-step agent with tool-use loop
│   │   └── tools.js           # Tool definitions (OpenAI function format)
│   ├── content/
│   │   └── content.js         # Content script — DOM reading & actions
│   ├── providers/
│   │   ├── base.js            # Base provider interface
│   │   ├── llamacpp.js        # llama.cpp local server
│   │   ├── openai.js          # OpenAI-compatible (GPT, OpenRouter)
│   │   ├── anthropic.js       # Anthropic Claude (native API)
│   │   └── manager.js         # Provider management & persistence
│   └── ui/
│       ├── sidepanel.html     # Side panel chat UI
│       ├── sidepanel.js       # Chat logic & event handling
│       ├── settings.html      # Options/settings page
│       └── settings.js        # Settings logic
├── styles/
│   └── sidepanel.css          # Side panel styles
└── icons/                     # Extension icons
```

## Agent Tools

The agent has access to these browser tools:

| Tool | Description |
|------|-------------|
| `read_page` | Extract page text, links, forms |
| `get_interactive_elements` | List all clickable/interactive elements |
| `click` | Click elements by selector, index, or coordinates |
| `type_text` | Type into input fields |
| `scroll` | Scroll the page |
| `navigate` | Go to a URL |
| `extract_data` | Extract tables, headings, images |
| `wait_for_element` | Wait for a selector to appear |
| `get_selection` | Get highlighted text |
| `execute_js` | Run custom JavaScript |
| `new_tab` | Open a new tab |
| `done` | Signal task completion |

## Adding a New Provider

1. Create a new class extending `BaseLLMProvider` in `src/providers/`
2. Implement `chat()` and optionally `chatStream()`
3. Register it in `src/providers/manager.js`

All providers normalize to a common response format:
```js
{ content: string, toolCalls: Array|null, usage: Object|null }
```

## Contributing

PRs welcome! Some ideas:

- [ ] Screenshot/vision tool (capture and send to multimodal models)
- [ ] Conversation export/import
- [ ] Custom tool definitions via settings
- [ ] Firefox support (Manifest V2 compat)
- [ ] Keyboard shortcuts
- [ ] Context menu integration (right-click → "Ask WebBrain")

## License

MIT
