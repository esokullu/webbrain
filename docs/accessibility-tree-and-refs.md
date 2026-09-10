# Accessibility Tree & ref_id System

The accessibility-tree (AX) subsystem is the primary page-interaction path for the agent. It replaces the older index-based `get_interactive_elements` for almost all flows.

---

## Architecture

Two content scripts loaded in order:

1. **`accessibility-tree.js`** — the tree builder and `ref_id` registry
2. **`content.js`** — the tool handlers that use the tree

Both are injected into `<all_urls>` pages at `document_idle`.

---

## The Tree (`accessibility-tree.js`)

Builds the tree with an internal `generateAccessibilityTree(...)` (invoked by
the agent via `executeScript`) and installs a ref-resolution API on `window`
(`__wbElementMap`, `__wb_ax_lookup`, `__wb_ax_release`):

### `generateAccessibilityTree(filter, maxDepth, maxChars, ref_id, page)`

Walks the DOM and emits a flat, indented text tree:

```
dialog "Add a product" [ref_166]
 heading "Add a product" [ref_167]
 button "Close" [ref_169]
 textbox "Name" [ref_170] type="text" placeholder="Product name" value="namaz"
 combobox "Billing period" [ref_180] type="button"
```

**Parameters:**
| Parameter | Default | Description |
|---|---|---|
| `filter` | `'all'` | `'all'` (whole rendered document scope), `'visible'` (in-viewport, visible nodes), `'interactive'` (clickable/typeable only) |
| `maxDepth` | `15` | Max tree depth to descend |
| `maxChars` | Filter-dependent | Structured page size. Defaults to 6,000 for `all`, 3,000 for `visible`, and 3,500 for `interactive`; larger trees return continuation metadata. See [adaptive read windows](#adaptive-read-windows). |
| `ref_id` | — | Anchor at a specific element's subtree instead of `document.body` |
| `page` | — | 1-based chunk number for paginated results when tree is truncated |

**Output format:**
```
role "accessible name" [ref_id] href="..." type="..." placeholder="..." value="..."
```

Indentation is 1 space per tree-depth level (skipped generic containers don't bump depth).

### `__wb_ax_lookup(ref_id)`

Resolves a `ref_N` string back to the live DOM `Element`. Returns `null` if the element was removed from the DOM.

### `__wb_ax_suggest(ref_id, n)`

When a lookup misses, returns up to `n` nearby still-valid `ref_ids` so the error message can guide the model back on track.

---

## ref_id Registry (`window.__wbElementMap`)

### How it works

- A plain object (`Object.create(null)`) keyed by `ref_N` strings
- Each value is a `WeakRef` to the DOM element
- A monotonic counter (`window.__wbRefCounter`) assigns the next `ref_N`
- The map is **partially cleared** at the start of every tree build: entries whose `deref()` returns `null` are swept. Live entries survive across calls.

### Stability properties

- **Within a turn**: a `ref_id` fetched from `get_accessibility_tree` is guaranteed to resolve in the same turn.
- **Across turns**: a `ref_id` resolves as long as the element survives in the DOM. Elements removed by navigation or DOM manipulation become unresolvable (the tool returns a clear "not found" error and suggests re-reading the tree).
- **After SPA navigation**: the map survives, but most elements from the old route are gone → their refs will miss. The agent is expected to re-call `get_accessibility_tree` after navigation.

### Why WeakRefs

Without `WeakRef`, the map would pin every element it ever indexed, preventing garbage collection and leaking memory on long-lived pages (SPAs, chat apps). With `WeakRef`, the browser can GC removed elements naturally. The cost is that `deref()` can return `null` even for elements that exist if the GC ran — but in practice this is rare within a single agent turn (sub-second) and the agent re-reads the tree on navigation anyway.

---

## AX Tools

### `get_accessibility_tree`

The primary page-reading tool. Returns the rendered tree string plus metadata (`truncated`, `hasMore`, `autoDegraded`, `notice`).

The agent uses this as its first action on almost every turn — it's faster and cheaper than a screenshot, and works on text-only models.

### Adaptive read windows

Accessibility-tree paging uses two coordinated limits: the `pageContent`
window returned by the content script and the outer serialized tool result sent
to the model. The standard pair is 6,000 / 8,000 characters. WebBrain exposes
an expanded 12,000 / 16,000 pair only when the active provider:

- is Mid or Full rather than Compact; and
- reports a context window of at least 65,536 tokens (64k).

The 12,000-character value is a maximum, not the ordinary default. Visible and
interactive UI reads retain their 3,000 / 3,500 defaults, and ordinary
accessibility results retain the 8,000-character serializer cap. The expanded
serializer applies only to an accessibility-tree call that actually requests
more than 6,000 characters. Other tools keep their existing result budgets.

For a required complete-thread read, the runtime automatically adds
`maxChars:12000` to the first discovery call when the provider is eligible. A
model may also request the expanded page for a whole-document read. Every
truncated result remains deterministic: callers must reuse the exact
`continuationArgs`, including `maxChars`, until `hasMore:false`. Increasing the
window reduces model round trips; it does not turn a multi-page tree into proof
of complete coverage. `tree_revision` binds page 2 and later to the snapshot
created by page 1. Page 1 always starts or restarts a fresh snapshot, so the
runtime ignores a stale revision if a model carries one into a page-1 call.

Pagination also cannot prove that an application rendered hidden conversation
content. On a Gmail thread route, a discovery read returns a trusted
`conversationRootRefId` selected from visible Gmail-owned conversation
structure. Complete-thread coverage then requires exact page 1-to-terminal
pagination of that anchored subtree with `filter:"all"` and `maxDepth:15`.
Document-root continuation pages traverse unrelated inbox UI and never count;
arbitrary message-body or generic refs cannot substitute for the trusted root.

Gmail expansion remains separate evidence. The page must expose **Collapse all**;
a terminal anchored tree observed while **Expand all** is active remains
incomplete. Ask mode is read-only, so if messages are still collapsed it reports
that limitation and asks the user to expand them or switch to Act mode. Act/Dev
can activate Expand all and then restart the trusted anchored read at page 1.
Each newly accepted exact page counts as bounded completeness progress, so a
long thread can exceed the ordinary eight-observation delivery checkpoint;
repeated, skipped, stale, changed-tree, and wrong-scope reads still do not.
When the latest user explicitly narrows a follow-up to a best-effort answer
from evidence already seen or provided in the conversation, the semantic scope
classifier uses `none`; an earlier complete-thread request must not force a new
Gmail read after the user has accepted that narrower evidence boundary.

Trace storage has a separate diagnostic truncation policy. A trace showing only
the head of a large result does not mean the model received the same truncated
payload; inspect the recorded total length and the model-facing paging metadata
when diagnosing incomplete reads.

### `click_ax({ref_id})`

1. Resolves `ref_id` via `__wb_ax_lookup()`
2. Scrolls into view (`scrollIntoView({block: 'center'})`)
3. Focuses the element
4. Dispatches `el.click()`

Returns `{success, method, tag, rect, name, href?, navigates?, hint?}`.

Both builds first preserve the compatible synthetic `el.click()` path. On Chrome only, a safe generic target may receive one guarded CDP `Input.dispatchMouseEvent` fallback after the page and target remain stable through two observation intervals. A URL change, handler-driven focus change, synchronous target-local mutation, or delayed semantic target state such as `aria-current` proves progress. Whole-page churn and delayed target name/class/style/child changes are retained only as diagnostic hints, because unrelated chat previews, unread badges, and timestamps are common. A nearby mutating XHR or non-telemetry beacon, new tab, or download makes the result inconclusive and vetoes the retry; background reads and obvious telemetry/heartbeat traffic are ignored. CSS-hidden, pointer-disabled, native, stateful/toggle, form, download, and potentially mutating targets are never auto-retried. Firefox remains synthetic-only.

No finite observation window can prove application-internal state that produces no URL, focus, semantic target, network, tab, download, or other visible signal. The generic-target gates, delayed settle, and one-shot rule minimize—but cannot completely eliminate—the possibility that a silent successful synthetic handler receives one trusted second activation.

### `type_ax({ref_id, text, clear})`

1. Resolves `ref_id`
2. Uses `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` to bypass React/Vue controlled-component wrappers
3. Dispatches `input` + `change` events
4. For contenteditable: sets `textContent` + dispatches `beforeinput` + `input`

Rejects non-typeable input types (checkbox, radio, submit, file) with a clear error.

### `set_field({ref_id, text, clear, submit})`

Atomically focuses + (optionally clears) + types + (optionally submits). The one-shot equivalent of `click_ax` + `type_ax`.

**Combobox-aware submit**: when `submit:true`, the tool detects if the field is a combobox/autocomplete (role=combobox, aria-autocomplete, aria-controls pointing at a listbox, or a visible listbox on the page). If so, dispatches `ArrowDown` → `Enter` with small delays to commit the highlighted option. Otherwise falls back to `form.requestSubmit()` or a plain `Enter` key press.

---

## Overlay Hoisting

When building the tree, open dialogs, listboxes, menus, and `[aria-expanded=true]` comboboxes are emitted under an `[open overlays]` banner at the top of the tree — before the rest of the page content. This ensures portal-rendered popups (React, Radix, Stripe) survive the 3,000-char soft cap seen by the model.

---

## Accessible Name Resolution Priority

`getAccessibleName(el)` follows this order:

1. `<select>` selected option's text
2. `aria-label`
3. `aria-labelledby` — concatenates all referenced ids' text
4. `placeholder`
5. `title`
6. `alt`
7. `<label for>` lookup
8. Input `value` (submit/button/reset only — never for text inputs)
9. Direct text content
10. `innerText` fallback for buttons, links, summary
11. Preceding sibling text (unlabeled form fields pattern: "Every 1 month(s)" → the preceding text is the label)
12. Direct text fallback

---

## Shadow DOM Piercing

### Chrome

The CDP client (`cdp-client.js`) can pierce **closed** shadow roots via `Runtime.evaluate`:

```js
await cdpClient.evaluate(tabId, `
  (() => {
    const host = document.querySelector('my-component');
    return host.shadowRoot ? 'open' : 'closed';
  })()
`);
```

For deeper queries, `shadow_dom_query` uses CDP's `DOM.getDocument` + `DOM.querySelector` to reach into closed roots.

Tool exposure is tiered: `get_shadow_dom`, `shadow_dom_query`, and `get_frames`
are Full Act fallbacks, and Dev mode also adds them for Mid-tier providers so
page-debugging runs can inspect Web Component and iframe structure without
giving Mid normal Act the whole Full UI fallback surface.

### Firefox

Only **open** shadow roots (`element.shadowRoot`) are accessible. Closed roots cannot be read through the content script. `execute_js` is exposed in Dev mode on both builds, but ordinary page JavaScript still cannot obtain a closed root, and the tree builder cannot reach it.

---

## iframe Targeting

`get_frames`, `iframe_read`, `iframe_click`, and `iframe_type` work with cross-origin iframes because the extension injects content scripts directly into each frame, bypassing the same-origin policy.

The tree builder does **not** recurse into iframes by default. The agent must explicitly call `iframe_read` or `get_frames` to discover and read iframe content.

When an embedded app or form remains difficult to inspect or target reliably,
`promote_iframe` navigates the **current run tab** to that child frame's own
standalone URL. Subsequent tools operate on the standalone page, and normal
browser Back history is preserved so `go_back` or the browser Back button can
return to the embedding page. This is a same-tab handoff, not background-tab
creation.

Use this workflow **before editing** the iframe:

1. Discover and read the embedded page with `iframe_read` or `get_frames`.
2. If direct iframe targeting is still unreliable, call `promote_iframe` with
   a required `urlFilter` that identifies the intended frame host and URL
   substring, for example `airtable.com/embed/`.
3. If several child frames match, no navigation occurs. Inspect the returned
   frame URLs, then retry with the zero-based `matchIndex` for the intended one.
4. Re-read the resulting standalone page, then use the normal page tools and
   refs to continue.

Promotion fails closed if the selected iframe has an unverified edit, attached
files, changed fields, or state that cannot be inspected safely. Finish or
verify the embedded form first. `force: true` discards that state and should be
used only when the user explicitly intends to discard it.

Unlike generic `navigate`, `promote_iframe` first discovers the authoritative
child-frame URL from the browser's frame inventory and applies the ambiguity
and iframe-draft checks atomically. Only after those checks pass does it
delegate the same-tab navigation to the normal `navigate` path. It is available
in Mid and Full Act, and is inherited by Mid/Full Dev; it is not available in
Ask or Compact.

---

## Common Failure Modes

| Failure | Symptom | Fix |
|---|---|---|
| Element removed from DOM | `click_ax` returns "not found" | Re-read the tree; the page may have re-rendered |
| Stale ref after SPA nav | All refs miss | Agent should read the tree again after `/navigate` or `wait_for_stable` |
| Shadow DOM closed root | Tree shows `<my-component>` but not its children | Use `get_shadow_dom` + `shadow_dom_query` on Chrome; Firefox cannot pierce a closed root |
| iframe not in tree | Agent can't find iframe content | Call `get_frames`, then use `iframe_read` / `iframe_click`; before editing, use `promote_iframe` if direct targeting stays unreliable |
| Truncated tree | `truncated: true` + `hasMore: true` | Reuse the exact returned `continuationArgs`; use `ref_id` only to zoom into one already-identified subtree |
| Portaled overlay not visible | Tree shows the combobox but not the dropdown | The overlay is hoisted to the `[open overlays]` section — re-read with `filter: 'all'` |

---

## Debugging

- The tree output is visible in verbose mode (side panel toggle)
- `window.__wbElementMap` in the page console lists all live refs
- `window.__wb_ax_lookup('ref_42')` tests a specific ref
- The deep-verbose debug log (`Shift+click` verbose button) dumps the last 200 LLM request/response pairs including AX tool results
