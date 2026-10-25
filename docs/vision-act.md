# Visual Act / Dev experiment

This branch makes the extension's **Act and Dev** modes use screenshots and native coordinate input. Ask keeps its existing pipeline. Automatic routing also hands off to the visual runtime when it selects Act or Dev; its earlier read-only routing phase is unchanged. Normal page observation does not send an accessibility tree, DOM text, selectors, or element references to the acting model. Explicit Dev diagnostics and direct documents/API responses remain separate capabilities. The active model must support both image input and tool calling; a text-only model receives a clear configuration error instead of a hidden accessibility fallback.

Every new Act or Dev request, including a follow-up and scheduled continuation, begins with a fresh full screenshot. The model receives one current visual context and issues one tool call at a time. A screen-changing action is followed by another capture; calculation, memory and other pure utility reads reuse the current frame. Completion takes a final screenshot and asks the model to reassess if the screen changed before it could finish. Pending message transactions and unresolved progress cannot be reported as successful completion.

Browser-owned new-tab pages can refuse native capture before the first screenshot. On that specific failure only, an initial run may normalize an exactly recognized new-tab URL to a local blank document in the same tab, once. It checks cancellation, durable task ownership and pending navigation before changing the tab; settings pages, other internal pages and ordinary websites are never cleared. A capturable WebBrain new-tab page is preserved; it explicitly loads the existing local privacy scanner because manifest content scripts do not run on extension pages. The first model request still receives an actual screenshot, and navigation to a remote destination uses the normal permission gate. With privacy enabled, this run's owned blank screenshot is fully masked; other documents retain the normal privacy scans.

Firefox startup requires a current companion advertising `visionStartupBinding`. The extension registers a unique blank-document URL on the live task owner; the companion binds only one matching top-level context and rechecks it before recording ownership. It never chooses a generic blank tab, uses no selector to bind this startup document, and refuses an older companion before changing the tab.

Chrome can omit the extension's own newtab root from its navigation-frame list. Only that exact packaged page may use the local frame-zero privacy scanner instead, with live tab checks and a private per-document token. It masks sensitive fields normally and covers whole embedded-document rectangles, including their borders; malformed or incomplete scans stop capture. This does not relax frame inspection for websites or other extension pages.

Model requests explicitly disable parallel tool calls on providers that support this option. If a provider still returns several calls, only the first action is eligible to run. Remaining calls receive a deferred receipt and require a new model decision after a fresh screenshot; `done` must be issued alone. A document replacement, redirect or viewport change during capture retries only the observation, up to eight attempts with backoff capped at one second and no further retry after eight elapsed seconds; it never replays the preceding input or navigation. Missing privacy scans retry only while the browser confirms the tab is loading, allowing privacy content scripts to initialize at document idle. Permanent privacy failures, closed tabs and clipped captures stop without uploading an unsafe image.

With screenshot redaction disabled, capture skips the privacy scan and its extra viewport check. With redaction enabled, both pre-capture and post-capture regions are masked. Enabling privacy during capture or model preparation forces a fresh protected full frame, discarding any raw base-and-patch context. A final synchronous check after cost approval prevents a previously prepared raw image from reaching the provider. Disabling privacy during a capture preserves its existing masks. Cancellation and user corrections also interrupt capture/model retry waits without replaying browser input.

Each native viewport or screenshot read has a 15-second deadline, including debugger/companion binding. Stop immediately abandons an outstanding read, and late pixels are discarded before privacy processing, model upload or native input. A read deadline is a permanent `vision_capture_timeout` failure, so observation recovery does not retry a hung compositor or replay an action.

Trace exports retain safe frame dimensions, byte/token counts, capture timings, retry attempts and terminal failure phases/codes. Capture failures also carry closed browser/stage/reason labels, distinguishing restricted pages, debugger conflicts, missing bindings and timeouts. These visual diagnostic records omit screenshot bytes, page URLs and private text, including in lossless exports.

Independent review diagnostic notes retain only closed review kinds/categories, evidence flags, missing-evidence labels, frame IDs and durations. These notes exclude reviewer explanations, claimed recipients/authors/audiences and page content even when lossless recording is enabled. Recoverable evidence refusals produce a fresh full screenshot and actionable missing-evidence categories. The runtime never replays the refused tool. Three identical refusals (ignoring refreshed frame IDs), or six refusals without dispatched-input/delivery progress, end the run as blocked with pending transactions preserved. A real user correction resets this recovery budget; utility reads and repeated observations do not.

## Enabling and comparing

The extension background defaults `actObservation` to `vision` on this branch. Existing embedding code that constructs `Agent` directly keeps the accessibility default, unless it selects visual mode explicitly:

```js
await agent.processMessage(tabId, request, onUpdate, 'act', [], {
  actObservation: 'vision',
});
```

Use `'dev'` instead of `'act'` for visual Dev; the stored option controls both modes. The streaming entry point accepts the same option in its final `runOptions` argument. Screenshot actions use the normal model tool-call transport; the visual runner currently obtains complete model replies before acting.

For an extension-level comparison, open Settings and change **Act / Dev interaction mode** between visual and accessibility modes. The same setting can be changed through local extension storage:

```js
await chrome.storage.local.set({ actObservation: 'accessibility' });
```

Set it back to `vision` to use the experiment.

Chrome can load the prepared `build/chrome` directory as an unpacked extension. Firefox can load `build/firefox/manifest.json`; native visual input also requires the configured [Firefox trusted automation companion](../firefox-companion/README.md) from this checkout. The Firefox browser tests exercise BiDi directly, not installation of the native messaging host into your normal profile.

## Coordinates and native input

The model uses pixels of the **transmitted full canvas**, accompanied by the latest `frameId`. Those coordinates are independent of physical screen resolution and device pixel ratio. The frame records both its encoded dimensions and the CSS visual viewport. The input layer maps between them, including visual viewport offsets, and checks the document, URL, viewport size, scale, zoom and scroll position again immediately before native input.

For example, a 1000 × 625 transmitted canvas describing a 1600 × 1000 CSS viewport maps `(500, 250)` to CSS `(800, 400)`. Retina screenshots are resized before model upload; DPR is not applied twice. An action based on an older frame, a resized viewport, a navigated document or changed scrolling is rejected before dispatch and receives a new screenshot.

The tools are:

| Tool | Input |
| --- | --- |
| `vision_observe` | Optional `full:true` to replace the patch chain with a fresh full frame |
| `vision_click`, `vision_hover` | `frameId`, `x`, `y`; click optionally takes `button`, `clickCount` |
| `vision_drag` | `frameId`, `x`, `y`, `toX`, `toY` |
| `vision_type` | `frameId`, literal `text`, optional `clear:true`; acts on the focused field |
| `vision_key` | `frameId`, a key or chord such as `Tab`, `Enter`, `Control+A` |
| `vision_scroll` | `frameId`, `x`, `y`, `deltaY`, optional `deltaX`; deltas are CSS pixels |
| `vision_navigate` | Absolute HTTP(S) `url` |
| `vision_wait` | Optional `milliseconds`, bounded to 3000 |
| `done` | Latest `frameId`, `summary`, `outcome`: `success`, `partial` or `blocked` |

Pointer tools optionally accept `imageId`. When supplied, `x` and `y` refer to that image's local pixels; its crop rectangle maps them back onto the full canvas. Keyboard input requires the latest frame and unchanged viewport/document geometry. A page can still move keyboard focus within the same document without visibly changing the screenshot: the visual pipeline deliberately does not inspect `document.activeElement`. Browser input is native, rather than synthetic DOM events. Chrome uses CDP input; Firefox uses the companion's dedicated visual commands. Message composition/submission is routed through the guarded chat transaction, with independent screenshot reviews, rather than generic typing or Enter.

## Task capabilities

`calculate`, `clarify`, `scratchpad_write`, `progress_update`, and `progress_read` are always available. `vision_enable_tools({group})` loads additional schemas only when needed; enabling a group does not grant permission to execute its tools.

| Group | Capabilities |
| --- | --- |
| `files` | `read_pdf`, `download_files`, `list_downloads`, `read_downloaded_file`, `upload_file`, `download_resource_from_page`, `download_social_media` |
| `tasks` | `schedule_resume`, `schedule_task`, `recall_memcode` |
| `browser` | `get_window_info`, `resize_window`, `go_back`, `go_forward`, `get_selection` |
| `research` | `fetch_url`, `research_url`, `extract_data`, `find_text` |
| `chat` | `chat_observe`, `chat_send`, `verify_form` |
| `captcha` | `get_captcha_capabilities`, `solve_captcha`, `apply_captcha_solution` |
| `dev` | bounded source, styles, listeners, console/network; target-scoped patch/CSS and reversal |

Utility adapters reuse the existing permissions, genuine clarification reply handling, download records, PDF reader, MemCode connection, progress ledger and scheduler. Human clarification answers continue the same task; automatic timeout choices never grant permission. A scheduled continuation stores `actObservation: 'vision'` and its Act/Dev mode independently of later changes to the global setting, preserves the task lineage and scratchpad/progress, and starts with a new full screenshot. Existing exact-tab/conversation scheduling constraints remain: a missing tab or changed conversation fails explicitly. Full browser restart recovery is not claimed; browser session conversation storage is not durable across closing the entire browser.

`fetch_url` accepts explicit API/data-file requests under the existing permission and output limits. HTML, XHTML and SVG document extraction is refused, preventing hidden page observation. `get_selection` reads only explicit highlighted text. Recalled memory is bounded, untrusted and non-executable: old selectors, AX references or recorded actions never become native targets.

Uploads take a current frame point and exactly one `attachmentId` or `downloadId`. A local hit-test binds the visible input, associated label or custom chooser trigger; selectors and local paths are never model arguments. Custom chooser initialization uses one trusted click, a bounded local picker interception, a fresh screenshot and another independent target review before native file attachment. Saved downloads are read from the actual completed download, not fetched again from their source URL. Existing file-size, accept/type and source-identity checks remain. Durable pending/delivered/uncertain receipts prevent duplicate delivery after a consumed input or lost acknowledgement. Local attachment does not claim remote submission. Cross-origin frame upload targets require a supported binding and are refused rather than guessed.

Visual resource downloads retain original resource bytes; they never replace a file with screenshot pixels. The selected resource must identify a supported original file. A selected public permalink can also use the existing enabled `download_public_media` HTTP download skill, including its server-side stream merge/download and cleanup. This requires another independent review, normal download permission and an allowlisted permalink; browser cookies are not forwarded. Provider-job receipts prevent duplicate purchases/downloads after uncertain creation. Generic hidden DOM/MSE collection, offscreen carousel discovery and unsupported private/DRM streams are not restored; limitations are reported explicitly.

`research_url` navigates the current tab and takes a screenshot. `extract_data` and `find_text` validate model transcriptions against independent visual review and current pixel regions. Extraction records visible coverage and overlapping viewport provenance; unreadable, hidden, virtualized or unvisited content cannot be called complete. Collected rows remain bounded and can be paged with `extract_data({operation:'read', sourceId, offset, limit})`. `verify_form` separates visible field values from a new, independently verified completion marker.

Messaging uses a durable transaction: observe recipient/composer/latest messages; authorize the recipient and body against the genuine current user task; protect existing drafts; prepare and independently review the exact draft; re-observe it; click Send once; then verify a new matching outgoing message and empty composer. Empty composer alone is insufficient. Uncertain sends remain pending across worker restart or scheduled continuation and cannot be automatically retried. Reviewed nonmutating navigation can return to the recipient to recover a visible receipt. A changed user task is re-authorized; scheduler hints, page instructions and old completed tasks confer no authority.

`chat_observe` may omit `sendControl` when the editor has not revealed it yet. Preparation requires the verified recipient and empty composer, not invented Send coordinates. Intermediate draft checks discard obsolete Send geometry. Submission requires a new observation of the exact prepared draft and the currently visible Send control. New empty conversations do not require fictitious message history.

Public posts and comments use the same transaction with `surface: 'publication'`. The observation supplies the visible destination/thread as `recipient` and separate `publication.author` and `publication.audience` text/rectangle evidence. Both are independently reviewed, included in authorization and pinned to the durable transaction. Changing the account, visibility or destination cannot redirect a prepared draft. Delivery requires a new own published entry against the saved baseline; previews, optimistic entries and other authors' posts are not receipts. An unresolved transaction blocks starting a different target, including a switch between public and private surfaces.

CAPTCHA discovery and solving retain the configured providers, existing automatic/native provider contracts, quota/permission behavior and durable paid-attempt locks. Visual points bind the actual challenge; model-provided selectors, frame IDs and arbitrary callbacks are not exposed. Application uses only locally observed supported token fields/callbacks/cookies, and rechecks the document before applying. Image recognition answers remain data for sequential visual actions with fresh frames. Unsupported bindings retain the purchased answer and report the limitation instead of purchasing again. Cancellation is checked again immediately before each paid provider request and before fallback.

Independent reviews use the same provider, cost approval, privacy fencing, cancellation and bounded screenshot context as acting requests. They add model calls for consequential semantic verification; this is not a promise that every task uses fewer tokens than every legacy task.

## Screenshot transport

`vision-frames.js` owns image decoding, resizing, encoding and retained visual context. Its `vision-frame-v1` packets identify a full keyframe, changed-region patches, or an unchanged observation. Every observation receives a new ID, even when no new image bytes are needed. A patch records its position on the full canvas, its encoded dimensions and its image ID.

Defaults:

| Budget | Default |
| --- | --- |
| Longest encoded image edge | At most 1280 pixels |
| Target full-frame pixel token estimate | At most 1000 |
| Encoded bytes per observation | At most 256 KiB |
| Retained image bytes | At most 512 KiB |
| Retained images | At most 5 |
| Retained pixel token estimate | At most 2000 |
| Default format | JPEG, initial quality 0.76; reduce quality/dimensions to fit |
| Diff tiles | 32 × 32 pixels with 8 pixels of crop padding |
| Maximum individual delta regions | 4 |
| Periodic full refresh | After at most 8 observations since a keyframe |

Pixel token estimates are budgeting heuristics, not a guarantee of a provider's billed tokens. Different model families charge images differently. The encoder also supports WebP when configured through `VisionFrameSession`.

Diffing happens on resized, uncompressed pixels before JPEG encoding. Adjacent changed tiles merge into crop rectangles. Large changes, navigation, scrolling, changed geometry, exhausted context budgets and periodic refreshes replace the chain with a full frame. Small updates retain the full frame and add only their changed regions. Completely unchanged frames add metadata without another image.

Each model request carries a reconstructible base frame and its retained patches. Stateless chat APIs still receive that bounded context on each request; this experiment does not assume server-side image caching or transmit only a delta without its base. Old screenshots do not accumulate in the conversation, and the runtime discards the image session when the run ends. Conversation persistence retains user requests, corrections, action attempts and results, and final responses, without screenshot data URLs. A durable checkpoint is required before native input; an interrupted action remains an unknown attempt until observed again.

## Integration boundaries

- `vision-act.js`: isolated observation/action loop, small prompt and tool catalog, permissions, cancellation, corrections, cost accounting, trace hooks and completion.
- `vision-frames.js`: pure geometry and diff helpers plus the browser canvas encoder and bounded frame session.
- `vision-browser.js`: capture consistency checks, coordinate conversion, native keyboard/pointer input and dispatch fencing.
- `vision-transport.js`: browser-specific Chrome CDP or Firefox companion transport.
- `vision-redaction.js`: optional local privacy scans before and after capture, opaque masks with page/visual viewport coordinate mapping, and failure without uploading raw pixels.
- `vision-dev.js`: bounded, read-only console and network diagnostics for Dev, separate from browser observation and targeting.
- `vision-capabilities.js`: shared utilities, permissions, task memory and scheduled continuation.
- `vision-files.js` / `vision-file-backend.js`: visual file targets, saved bytes, native attachment and durable receipts.
- `vision-evidence.js` / `vision-review.js`: independent image verification, visual research and guarded messaging/forms.
- `vision-captcha.js`: visually bound configured solvers and retained paid attempts.
- `vision-dev-capabilities.js`: explicitly authorized bounded diagnostics and target-scoped reversible edits.
- `vision-runtime-state.js`: persisted semantic receipts and genuine task authority, without screenshots.
- `agent.js` and `background.js`: select the experiment while retaining the existing run ownership and lifecycle machinery.

Both browser source trees contain the shared modules. The visual runner bypasses the accessibility planner, DOM action executor and page-monitor observation loop. Capture reads geometry and document identity only; the page's visible content reaches the model as image blocks. Existing screenshot redaction and capability permission settings still apply. Coordinates can target child frames, so origin permission checks include frame origins without inspecting their DOM content.

Visual Dev uses the same screenshots and coordinate tools while preserving its conversation and trace mode. The `dev` group requires an independently verified explicit development/debugging request. `read_page_source` returns bounded server source; `inspect_element_styles` and `inspect_event_listeners` target the current screenshot point. Chrome offers native listener metadata plus buffered console/network diagnostics without headers or bodies. Firefox explicitly reports native listener/console/network collection as unavailable; source, styles and visual edits remain available. Patches and CSS declarations bind a locally retained element and document epoch, require fresh pixels after permission/review waits, and refuse reversal if newer user/site edits would be overwritten. There is no arbitrary `execute_js`, global selector-based stylesheet injection, legacy iframe/shadow interaction tool or `browser_batch` escape.

Managed Cloud task memory/structured Cloud output and legacy saved selector/AX workflow replay are not supported by this experiment. Those requests report their limitation rather than silently switching observation modes.

If an external debugger emulates a viewport larger than the physical browser window while pinch zoom is active, Chromium may clip the compositor screenshot. The transport validates its PNG dimensions and stops with resize/reset-zoom guidance rather than act on a partial image. Ordinary viewport changes, desktop browser zoom, DPR 1/2 and pinch zoom are covered by the browser tests.

## Verification

Run the focused suite from the repository root:

```sh
npm run test:vision-act
npm run build:all
```

On hosts where Chromium's GPU compositor stalls, set `WEBBRAIN_QUALITY_SOFTWARE_RENDERING=1` when running the visual suite. This test-only option disables GPU compositing while retaining native screenshot/input, the viewport and DPR/zoom checks. It does not change extension code or use mocked screenshots.

The unit tests cover both source trees: screenshot-first requests and follow-ups, unsupported providers, forbidden DOM/AX calls, argument rejection, stale frames, single-action sequencing, cancellation, user corrections, permissions, changing completion evidence and bounded tool-call history. Frame and input tests exercise real browser image encoding and native coordinate behavior where available.

Existing installed-extension fixtures that exercise accessibility tools explicitly select `actObservation: 'accessibility'` in their setup. Their original contracts remain covered alongside the separate visual suite.

The MV3 tests install the actual extension against owned local pages and deterministic loopback providers. The geometry suite runs Act at desktop DPR 1, Retina DPR 2, and native 125% browser zoom, plus Dev. The file pipeline exercises download → actual saved-byte read → custom chooser → native upload once, including a duplicate attempt. The capability pipeline exercises a real clarification answer, guarded message preparation/delivery and duplicate refusal, window resize, Dev styles/patch/reversal, and the actual scheduler's visual continuation with memory. The startup suite covers direct Act, public Ask → Act, Dev and privacy-enabled tasks from Chrome's default new tab, preservation of the enabled WebBrain new tab, and refusal to navigate away from settings. Separate real Chromium and Firefox BiDi tests exercise native coordinate input, direct/custom file inputs, visual evidence and Dev adapters. Firefox startup tests connect the production client and companion, bind the uniquely owned blank context, capture real pixels and perform a trusted click after navigation; sibling/ambiguous bindings and cancellation are also checked. Firefox tests use real Firefox/companion commands with an extension-API harness, not a signed Firefox extension installed in a user's normal profile.

The installed publication suite additionally exercises initially hidden Send/Publish controls, submission refusal without a visible control, account/audience changes after review, existing drafts, incorrect private recipients and uncertain delivery without replay. It checks trusted browser input, actual local server submissions and durable receipts. The Firefox evidence suite exercises hidden controls and public author/audience/delivery through the real BiDi companion and pixel checks on an owned fixture.

Artifacts are written under `ci/artifacts/vision-act-mv3/`, `vision-files-pipeline-mv3/`, `vision-capabilities-mv3/`, `vision-startup-mv3/` and `vision-publication-mv3/`. The tests validate production browser/transport/lifecycle contracts; deterministic providers do not establish live-model perception quality or paid-provider availability. CAPTCHA tests use owned provider fixtures and native local application, without spending real solver credits.
