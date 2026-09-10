# Agent Tools

WebBrain separates **model tier** from **conversation mode**.

- **Tier** (`compact`, `mid`, `full`) is a per-provider setting. It controls how
  many normal browser-agent tools a model sees.
- **Mode** (`ask`, `act`, `dev`) is chosen per conversation. It controls what
  kind of task the user is allowing.

| Mode | What it allows |
|---|---|
| **Ask** | Read-only. No clicking, typing, navigating, or downloading. |
| **Act** | The selected tier's normal browser tools. |
| **Dev** | Requires a Mid or Full provider. Adds a source/style/debug appendix, including deeper DOM/frame inspection for Mid-tier Dev runs. Compact Dev is blocked before an LLM request is sent. |

| Tier | Intended model class | Normal tool surface |
|---|---|---|
| `compact` | very small local models | Shortest prompt and a small normal Act tool set. No scheduling, iframe, download-resource, or advanced DOM/UI fallbacks. |
| `mid` | capable local models | Common task tools: downloads, scheduling, iframe tools, form verification. No Full-only advanced fallbacks. |
| `full` | frontier/cloud or large local models | Everything, including hover, drag-drop, frames, and shadow DOM. |

Tier defaults and resolution rules are documented in
[providers and models](providers-and-models.md#prompttool-tiers-and-modes).

## Accessibility read budgets

`get_accessibility_tree` normally uses a 6,000-character structured page inside
an 8,000-character serialized result. Mid/Full providers with a detected
context window of at least 65,536 tokens advertise the expanded 12,000 / 16,000
pair. When that larger page is requested, its accessibility result alone may
use the 16,000-character serializer window. Compact providers and providers below the
64k boundary remain at 6,000 / 8,000.

The larger window is reserved for complete-thread and whole-document reads.
Ordinary visible/interactive UI reads retain their smaller defaults, other tool
results remain capped at 8,000 characters, and every truncated tree must be
continued with its exact returned `continuationArgs` until the required
coverage is complete. See
[adaptive read windows](accessibility-tree-and-refs.md#adaptive-read-windows).

For Gmail, the first accessibility result identifies the trusted active
conversation with `conversationRootRefId`. Complete coverage pages only that
anchored subtree with `filter:"all"` and `maxDepth:15`; document-root page 2+
contains unrelated inbox rows and does not count. Expansion is independent:
**Collapse all** must be visible as evidence. Ask cannot expand collapsed
messages and returns a clear limitation; Act/Dev can use **Expand all** and then
re-read the trusted conversation subtree from page 1.

## Tool matrix

Legend: **Yes** = available · **-** = not available · **C** = Chrome only ·
**Dev** = Dev-mode add-on (Mid/Full providers; not Compact).

| Tool | Ask | Compact | Mid | Full | Dev |
|------|:---:|:-------:|:---:|:----:|:---:|
| `get_accessibility_tree` | Yes | Yes | Yes | Yes | - |
| `read_page` | Yes | Yes | Yes | Yes | - |
| `read_pdf` | Yes | No | Yes | Yes | - |
| `list_webmcp_tools` | C | No | C | C | - |
| `execute_webmcp_tool` | No | No | C | C | - |
| `read_page_source` | No | No | No | No | Yes |
| `get_window_info` | Yes | Yes | Yes | Yes | - |
| `get_interactive_elements` | Yes | No | Yes | Yes | - |
| `scroll` | Yes | Yes | Yes | Yes | - |
| `extract_data` | Yes | Yes | Yes | Yes | - |
| `inspect_element_styles` | No | No | No | No | Yes |
| `wait_for_stable` | Yes | No | Yes | Yes | - |
| `get_selection` | Yes | Yes | Yes | Yes | - |
| `done` | Yes | Yes | Yes | Yes | - |
| `clarify` | No | Yes | Yes | Yes | - |
| `fetch_url` | Yes | Yes | Yes | Yes | - |
| `research_url` | Yes | No | Yes | Yes | - |
| `list_downloads` | Yes | No | Yes | Yes | - |
| `click_ax` | No | Yes | Yes | Yes | - |
| `type_ax` | No | Yes | Yes | Yes | - |
| `set_field` | No | Yes | Yes | Yes | - |
| `resize_window` | No | No | No | Yes | - |
| `click` | No | Yes | Yes | Yes | - |
| `type_text` | No | Yes | Yes | Yes | - |
| `press_keys` | No | Yes | Yes | Yes | - |
| `navigate` | No | Yes | Yes | Yes | - |
| `wait_for_element` | No | Yes | Yes | Yes | - |
| `promote_iframe` | No | No | Yes | Yes | - |
| `scratchpad_write` | No | Yes | Yes | Yes | - |
| `progress_update` | No | Yes | Yes | Yes | - |
| `progress_read` | No | Yes | Yes | Yes | - |
| `download_social_media` | No | No | Yes | Yes | - |
| `solve_captcha` | No | No | Yes | Yes | - |
| `go_back` | No | No | Yes | Yes | - |
| `go_forward` | No | No | Yes | Yes | - |
| `schedule_resume` | No | No | Yes | Yes | - |
| `schedule_task` | No | No | Yes | Yes | - |
| `iframe_read` | No | No | Yes | Yes | - |
| `iframe_click` | No | No | Yes | Yes | - |
| `iframe_type` | No | No | Yes | Yes | - |
| `read_downloaded_file` | No | No | Yes | Yes | - |
| `download_files` | No | No | Yes | Yes | - |
| `download_resource_from_page` | No | No | Yes | Yes | - |
| `upload_file` | No | No | Yes | Yes | - |
| `verify_form` | No | No | Yes | Yes | - |
| `hover` | No | No | No | Yes | - |
| `drag_drop` | No | No | No | Yes | - |
| `get_shadow_dom` | No | No | No | Yes | Yes |
| `shadow_dom_query` | No | No | No | C | C |
| `get_frames` | No | No | No | Yes | Yes |
| `inject_css` | No | No | No | No | C |
| `remove_injected_css` | No | No | No | No | C |
| `patch_element` | No | No | No | No | C |
| `revert_patch` | No | No | No | No | C |
| `execute_js` | No | No | No | No | Yes |
| `read_console` | No | No | No | No | C |
| `inspect_network_requests` | No | No | No | No | C |
| `inspect_event_listeners` | No | No | No | No | C |
| `highlight_element` | No | No | No | No | C |

`promote_iframe` is a normal Mid/Full Act tool, not a Dev-only add-on. Dev
sessions using a Mid or Full provider inherit it from the selected Act tier.
See [iframe targeting](accessibility-tree-and-refs.md#iframe-targeting) for the
standalone-frame workflow and safety checks.

> **Shadow DOM note:** The accessibility tree only traverses light DOM. On Web
> Component-heavy pages (Stripe, Salesforce, Shopify), use
> `get_interactive_elements` first; in Full Act or Dev mode, use
> `get_shadow_dom` / `shadow_dom_query` for targeted reads.

## Tools that are not in the table

**Skill tools.** Loaded skills can append tool schemas for the current run. The
bundled FreeSkillz.xyz skill, for example, can expose `read_youtube_transcript`
plus `resolve_public_media` / `download_public_media`. These are not hard-coded:
before the skill is loaded (or if it is removed), the tools are absent. Ask mode
still filters out mutating and download tools even when their owning skill is
loaded. See [skills](skills.md).

**WebMCP (experimental, opt-in).** The `list_webmcp_tools` /
`execute_webmcp_tool` rows apply only when **Experimental WebMCP** is enabled
under Settings → General → Advanced. The setting is off by default; while off,
the tools and their prompt guidance are omitted from model requests. WebMCP
annotations such as `readOnly` are page-authored hints, not a security boundary.
Every invocation requires Act or Dev, fresh per-call confirmation, and the
normal capability × registration-frame-origin permission. WebMCP currently
requires a supporting Chrome build/page configuration; Firefox does not expose
these tools.

## Dev-mode page editing and diagnostics

Dev tools are only exposed in Dev mode, and Dev mode is blocked for
Compact-tier providers. Chrome's reversible editing tools return patch IDs:
`inject_css` pairs with `remove_injected_css`, and `patch_element` pairs with
`revert_patch`.

- **`inject_css` / `remove_injected_css`** apply and undo temporary CSS by
  `patchId`. Each patch is unique and bound to the exact page document, and its
  metadata is kept in session storage so a service-worker restart does not lose
  the undo handle. Navigating invalidates the old handle instead of letting it
  affect a replacement page.
- **`patch_element` / `revert_patch`** make structured inline-style, class, and
  attribute changes with exact before/after values. Browser-equivalent style and
  HTML attribute names are canonicalized before the undo record is created,
  contradictory set/remove operations are rejected, and executable URL
  attributes reject `javascript:` values (including form `action`).
  `highlight_element` provides a temporary pointer-transparent target overlay;
  because it inserts live DOM, it uses the temporary Dev-patch permission.
- **`execute_js`** runs an async JavaScript function body in the page main
  world. Chrome uses CDP `Runtime.evaluate` with a 15-second execution limit;
  Firefox uses its MV2 content-script evaluator. The tool is host-permission
  gated and receives a fresh submit confirmation.
- **`read_console`, `inspect_network_requests`, `inspect_event_listeners`**
  provide bounded diagnostics on Chrome. Capture starts before either streaming
  or non-streaming Dev runs and stops when the tab leaves Dev mode or its
  conversation is cleared; leaving Dev drains every tab with active capture even
  if the panel switched tabs, removes handlers and buffers, and disables the
  matching CDP domains. Listener inspection briefly adds and restores an
  internal target attribute, follows open-shadow hosts when collecting
  ancestors, and therefore uses the same host permission as temporary Dev
  patches. Network headers and bodies are omitted by default, sensitive header
  names (including common API/subscription-key variants) are redacted before
  buffering, and page-derived diagnostic output is treated as untrusted content.

## See also

- [Adding a tool](adding-a-tool.md) — the checklist for new or changed tools
- [Accessibility tree and refs](accessibility-tree-and-refs.md)
- [Security model](security-model.md) and
  [prompt-injection defense](prompt-injection-defense.md)
