# Visual Act / Dev experiment

This branch makes the extension's **Act and Dev** modes use screenshots and native coordinate input. Ask keeps its existing pipeline. Automatic routing also hands off to the visual runtime when it selects Act or Dev; its earlier read-only routing phase is unchanged. It does not send an accessibility tree, DOM text, selectors, or element references to the acting model. The active model must support both image input and tool calling; a text-only model receives a clear configuration error instead of a hidden accessibility fallback.

Every new Act or Dev request, including a follow-up, begins with a fresh full screenshot. The model receives one current visual context and issues one tool call at a time. A native action is followed by another capture. Completion takes a final screenshot and asks the model to reassess if the screen changed before it could finish.

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

Pointer tools optionally accept `imageId`. When supplied, `x` and `y` refer to that image's local pixels; its crop rectangle maps them back onto the full canvas. Keyboard input requires the latest frame and unchanged viewport/document geometry. A page can still move keyboard focus within the same document without visibly changing the screenshot: the visual pipeline deliberately does not inspect `document.activeElement`. Browser input is native, rather than synthetic DOM events. Chrome uses CDP input; Firefox uses the companion's dedicated visual commands.

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
- `agent.js` and `background.js`: select the experiment while retaining the existing run ownership and lifecycle machinery.

Both browser source trees contain the shared modules. The visual runner bypasses the accessibility planner, DOM action executor and page-monitor observation loop. Capture reads geometry and document identity only; the page's visible content reaches the model as image blocks. Existing screenshot redaction and capability permission settings still apply. Coordinates can target child frames, so origin permission checks include frame origins without inspecting their DOM content.

Visual Dev uses the same screenshots and coordinate tools while preserving its conversation and trace mode. Chrome additionally offers bounded `read_console` and `inspect_network_requests` for explicit debugging requests; network headers and bodies are excluded. Firefox reports those diagnostics as unavailable without falling back to DOM inspection. Page-source tools, selectors, arbitrary JavaScript and DOM patches are not part of visual Dev; the compatibility setting retains the previous Dev implementation when those tools are needed.

The experiment intentionally has a small action vocabulary. Existing tools such as file upload, structured page extraction, saved workflow execution and website-specific helpers are not advertised by visual Act or Dev. Managed Cloud task memory and structured Cloud output currently require accessibility mode. Complex tasks depending on those tools should use the compatibility setting while the visual pipeline is evaluated.

If an external debugger emulates a viewport larger than the physical browser window while pinch zoom is active, Chromium may clip the compositor screenshot. The transport validates its PNG dimensions and stops with resize/reset-zoom guidance rather than act on a partial image. Ordinary viewport changes, desktop browser zoom, DPR 1/2 and pinch zoom are covered by the browser tests.

## Verification

Run the focused suite from the repository root:

```sh
npm run test:vision-act
npm run build:all
```

The unit tests cover both source trees: screenshot-first requests and follow-ups, unsupported providers, forbidden DOM/AX calls, argument rejection, stale frames, single-action sequencing, cancellation, user corrections, permissions, changing completion evidence and bounded tool-call history. Frame and input tests exercise real browser image encoding and native coordinate behavior where available.

Existing installed-extension fixtures that exercise accessibility tools explicitly select `actObservation: 'accessibility'` in their setup. Their original contracts remain covered alongside the separate visual suite.

The MV3 test installs the actual extension against an owned local page and a deterministic loopback provider. It runs Act at desktop DPR 1, Retina DPR 2, and native 125% browser zoom, plus an explicit Dev case. It verifies real trusted click/type/key/scroll events, a single form submission, navigation, visual completion, cropped updates, bounded image context and the absence of accessibility reads. It also checks that screenshot pixel dimensions match the declared viewport. Evidence is written under `ci/artifacts/vision-act-mv3/`, including byte counts, frame metadata and source hashes. This test validates browser and transport behavior; it does not claim a live model quality benchmark.
