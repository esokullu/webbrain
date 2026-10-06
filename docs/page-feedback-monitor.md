# Page feedback monitor

Browser-backed chat, cloud, scheduled tasks and saved workflow replay automatically
monitor the run's tab and accessible frames in Chrome and Firefox. Switching the
active tab does not move the run. Standalone chat has no browser monitor.

User click, typing, selection, scrolling and navigation invalidate prepared
actions. After one second of inactivity, the runtime reads the current URL and
accessibility tree and continues the original task. Pointer gestures and IME
composition keep the gate closed until they finish. External scroll/navigation
with uncertain attribution also get the idle delay; automatic DOM observations
do not extend it. Stop interrupts the wait.
Window and visual-viewport size, zoom and offset changes invalidate prepared
coordinates. Top-level viewport activity waits for geometry to settle; embedded
frame size changes are page layout observations and do not extend the user gate.

`composerDeliveryMode` only controls typed chat messages (Queue/Steer). Automatic
page feedback uses its own bounded queue and cannot promote a queued message to
Steer or grant authorization. Enter and Alt+Enter retain their existing behavior.

## Observation and dispatch boundaries

- The document-start monitor handshakes with background using a run token and a
  document token. Background validates the actual sender's tab, frame, browser
  document identity when available and monotonic sequence. Full navigation
  invalidates the previous document and its frames.
  Run startup addresses every existing accessible frame and waits for its ready
  acknowledgement; cleanup sends the owning run token to all frames. Restricted
  frames do not prevent a run, and frame enumeration failures retain broadcast
  delivery.
  Firefox also registers the monitor and MAIN-world shadow hook at document end
  to cover inherited `about:blank`/`about:srcdoc` frames skipped at document start.
  This supplemental pass preserves an existing live monitor and its expectations.
- Native CDP/BiDi and content actions register their target, input operation and
  actual dispatch before changing the page. Target and native-event phase
  matching suppress their observed effects. CDP resolves the receiving document
  and target, including process-isolated iframes, before registering input in that
  frame. Expectations are finished in every frame touched by the action. Firefox
  companion checks the live document/revision again and renews its marker between
  a shortcut's modifier and letter, as well as before each later key. A different physical intervention
  breaks the expectation, including a later click on the same target. Uncertain
  effects remain `unknown`; `isTrusted` alone does not establish human origin.
- Chrome selector resolution checks a fence without claiming scroll during its
  asynchronous search or retries. Only a resolved node's actual `scrollIntoView`
  dispatch activates attribution, with a live page revision check in both open
  and closed shadow-root paths. Read-only selector queries do not arm scrolling.
- AX rect/field preparation and content/BiDi visibility helpers register the
  exact node immediately before each actual scroll. Multiple scrolled ancestors
  remain attributed within the operation; preparation scrolling never claims
  input events on the field. Pending feedback is propagated through scroll
  fallbacks rather than permitting an extra viewport mutation.
- Meaningful visible content, control state, visibility and geometry changes are
  coalesced. Visible subtree identity changes invalidate targets even when the
  replacement has identical text and geometry. CSS animation and extension
  decoration are ignored. Extension UI roots register their actual node
  references in the isolated content-script world, preserved across monitor
  replacement; page-owned IDs and attributes cannot suppress observations.
  A MAIN-world attachment signal observes new open
  shadow roots on existing hosts before their initial rendering; shadow-root
  child-list mutations are also monitored. Inaccessible frames and closed shadow roots retain the
  existing browser-access limitations.
  Existing dialog/details `open` and subtree `inert` state changes are observed
  even when no children, classes or styles change.
- Event payloads contain bounded target identifiers and scroll positions, never
  typed keys, field values or selected text. The subsequent normal page read uses
  the existing untrusted-content and secret-handling rules.
- Feedback invalidates JEV preparations, remembered field identity and screenshot
  coordinates. It is consumed at existing model/tool boundaries after all tool
  results have matching messages. In-flight results remain; undispatched sibling
  calls receive explicit skipped results. Transport and local dispatch gates
  cover interventions during asynchronous preparation.
- Content and Firefox native preparation handshakes check the revision without
  claiming input events. Local dispatch and native markers activate expectations
  at the mutation boundary, preserving same-target intervention during preparation.
- Contenteditable fallback marks its cancellable `beforeinput` before emission.
  A native edit's repeated input phases are attributed only within the synchronous
  command and its target; cancelled gates retain their undispatched outcome, and
  user intervention during the settling wait prevents the remaining insertion.
- Both Chrome upload paths check feedback after preparation, immediately before
  attaching files. A skipped attachment retains its undispatched outcome.
- Firefox companion uploads register as input and place their native marker on
  the file input, preserving attribution when a different control holds focus.
- Runtime observations use nonce-delimited `page_feedback` untrusted data. They
  do not enter the trusted text-steering authorization path. Screenshots follow
  the current capture, vision-routing and budget policies.

## Workflow and notifications

An undispatched saved step is resolved again against the current scope and target.
Valid steps continue; scope/target failures enter the existing AI fallback with
the remaining workflow intent and latest wrapped observation. The step is not
counted complete. Three preparation retries bound repeated invalidation before
falling back; existing model and screenshot budgets still apply.

Main-frame navigation adds a plain-text, persisted chat note with a deduplication
ID. UI URLs omit credentials, query and fragment. Scheduled notes carry the owning
job ID and wait for that job's assistant bubble. Cloud updates expose only event
metadata and a generic navigation message, in both secret modes. Completion and
cancellation remove the monitor and its pending run state.

Click navigation correlation starts with matching page input, rather than the
preparation handshake. Proven undispatched actions release their navigation
marker. Notice IDs capture the consumed batch revision before the asynchronous
page read, so navigation arriving during that read keeps its own persisted note.
Navigation correlation stays within the dispatched frame; a child link explicitly
targeting the top frame can correlate that target without hiding sibling changes.
Firefox arms direct navigation after URL validation and the unsaved-changes probe,
immediately before the native transport or tab update.

## Verification

`npm run test:page-feedback` runs the controller/transport/workflow/cloud/scheduler
regressions and real Chromium/Firefox DOM fixtures. Fixtures exercise trusted
browser input, same-target intervention, same-shape subtree replacements, frames,
late shadow-root attachment and custom-element upgrades, window and
container scrolling, animation noise, cleanup/restart and persisted navigation
notes. Browser extension APIs are mocked in these fixtures; they are not a live
companion-session integration test.

Visibility regressions include fixed-size ancestors changing class or CSS custom
properties to reveal or hide non-interactive content past the layout sampling and
signature seed limits. An actual inherited-state attribute change on an oversized
subtree conservatively invalidates prepared actions, while keeping layout reads
bounded; identical assignments, known animations and owned indicators are filtered.
Tab and Shift+Tab focus movement also invalidate preparation without recording keys.
Native preparation fixtures
also exercise the real companion code across an asynchronous target lookup while
the user edits the same field.
Frame lifecycle regressions cover delayed child acknowledgements and inaccessible
frames. Browser fixtures also cover page-owned marker attributes and the real
extension indicators across monitor replacement.
Real CDP regressions pause selector resolution during runtime enablement, missing
target traversal and queued evaluation, then verify external scroll feedback and
the final dispatch fence. Open and closed shadow-root agent scrolling remain
attributed. Geometry fixtures also cover modal/details/inert transitions and
viewport resizing during coordinate preparation and after cancellation.
Preparation-scroll fixtures cover the real AX handlers, nested scroll containers,
same-field human typing and an intervening DOM change. Firefox frame fixtures
model the document-start omission, apply the manifest's document-end scripts,
and verify user/DOM/late-shadow feedback in blank and srcdoc frames while keeping
an existing monitor intact. These remain mocked extension registration fixtures.
Both manifests enable origin fallback for related data/blob documents in the
monitor and MAIN shadow-hook registrations. Fixtures model these registrations
and verify private-input, DOM and late-shadow feedback inside those documents.
Document and local-action tokens use cryptographic random bytes when the document
does not expose the secure-context-only randomUUID API.
Text signatures cover the whole non-editable text with a cached fixed-size
fingerprint, so middle/suffix edits and appends beyond the first 200 characters
invalidate prepared actions even when geometry stays fixed. Accessibility-state
regressions also cover aria-pressed-only toggle changes and their agent attribution.

The monitor regressions are also included in `npm run test:runtime-lifecycle`.
