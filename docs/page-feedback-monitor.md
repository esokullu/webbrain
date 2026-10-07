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
- Passive main-frame DOM updates use a tool-specific freshness policy. Fresh
  reads, explicit navigation and read-only requests can proceed after refreshing
  observations, even when counters keep changing during the refresh. Mutating
  network requests, request replay, coordinates and arbitrary scripts retain
  strict invalidation. Model state binds the URL, document identity and steering
  revision before inference; human activity and unknown attribution still require
  a new decision. Explicit downloads normalize `url` and `urls` with the same
  precedence as their handler; both browser schemas also accept the singular
  URL and filename. Fresh PDF/capability reads and authorized generation,
  scheduling and window operations retain their own validation instead of
  being discarded for unrelated DOM updates.
- Focused social-media downloads bind the selected document, node, container and
  exact media asset before inference. The downloader validates that identity
  before fetching and again before saving. A replaced asset fails without a
  download; a bound attempt cannot fall back to another MSE or vision resource.
  A transparent backing image can bind to the same visible image painted by its
  immediate parent/sibling; the carrier, exact asset and rendered box must match.
  Binding comparison ignores object-key ordering introduced by browser API
  serialization, while preserving every key, value and array position.
  Missing capture yields a read-only `media_binding_unavailable` tool result;
  the model can inspect sources and choose an explicit URL. It does not attempt
  an unbound fetch/save or count optional capture failure as a page-change retry.
  Capture rechecks URL, document and steering identity after injection. When a
  browser omits document IDs, an active content-monitor acknowledgement must
  prove the same run/document token; a failed registration cannot verify media.
  Bulk and scrolling downloads keep their existing conservative behavior.
- Exact main-frame AX/selector actions can opt into passive revalidation on any
  HTTP(S) site. Immediately before each decision, the content monitor generates
  the current visible AX observation and captures private action footprints in
  the same synchronous task. The observation enters the model request; opaque
  tokens alone cross the monitor boundary. No private control values or files
  are added to feedback, traces or model arguments.
  The footprint binds the actual target and semantic ancestor identities,
  associated labels, recipient/entity headings in its owner, complete form and
  control/file state, exact target geometry/hit, document/base URL, viewport and
  intervention identity. Unrelated sibling text, counters, ancestor child counts
  and headings in another sidebar/entity do not invalidate an unchanged action.
  The old footprint is validated after the model response, during preparation,
  and again at local/native dispatch, including changes during each round trip.
  Focus-dependent typing and keyboard calls bind the exact focused element
  captured before inference. Repeated keys are attributed only within their
  synchronous dispatch; a page script moving focus cannot reuse a native typing
  guard for the next key. Preflight messages that sent no input preserve the
  original snapshot through native preparation. Submissions retain the existing
  authorization, form and recipient gates.
  Snapshots are bounded, expire after two minutes and are discarded with the run;
  unavailable or ambiguous targets retain conservative validation. Coordinates,
  scripts, child-frame actions, human activity, navigation and unknown feedback
  retain strict fences. Without a private snapshot, legacy AX comparisons and
  native-submit restrictions remain in force.
  A target outside the snapshot's coverage returns `action_binding_unavailable`
  instead of claiming that the page changed. The old call stays undispatched.
  The next normal decision prioritizes that target and receives a fresh bounded
  AX observation of its owner together with the new private footprint. Target
  selectors and labels retain their exact strings throughout validation and
  preparation; truncation cannot certify a different target.
- Protected conversation attachments use the existing submission and recipient
  authorization. One explicit source is bound to one exact main-frame file input
  and its local composer. Hidden inputs retain structural identity, input
  metadata, file state and recipient context; visibility alone does not make
  an input unverifiable. The final recipient/node check and native file-list
  assignment run in the same content task. Chrome reads local bytes through a
  detached input in an isolated realm; protected uploads retain the 25MB cap.
  A changed source, input, owner, document or recipient blocks attachment.
  Communication loss after dispatch and a recipient change during an input
  handler produce an uncertain result without an automatic retry. Attaching a
  file does not establish that the website sent or received it.
- Generic chat recipients can use a unique contact-name button in the local
  conversation header above the composer's footer. Sidebar, message-history
  and toolbar buttons do not establish the recipient. The private dispatch
  proof binds the contact, header, pane and composer destination label so a
  same-name conversation replacement still invalidates the action.
  Pre-inference action capture uses the same isolated, read-only evidence and
  scopes editor/control state to that footer; unrelated history updates do not
  invalidate its certified actions.
  Existing recipient approvals survive trusted Continue within the same task
  and execution scope; independent tasks and changed scope clear them. Missing live
  identity, draft, baseline or dispatch proof produces a technical blocker;
  another approval question cannot repair missing evidence. Recipient
  clarifications report `recipientBinding` separately from general user
  authorization and suppress repeated questions for known technical blockers.
- A single explicit `done` candidate survives passive DOM updates before and
  after its tool batch. Success still requires the completion verifier's fresh
  evidence; partial/failure outcomes remain incomplete. The summary does not
  establish success.
- Five consecutive passive invalidations without dispatch/progress end the run
  with `page_unstable` and an explicit incomplete result. A recovery nudge is sent
  after two. Successful reads/actions reset this budget; user intervention starts
  fresh. This also covers preparation/transport failures and text-format tool
  responses. App-owned feedback trees and captures are replaced by the latest
  observation, preserving user instructions and tool results instead of growing
  the prompt with repeated copies. Trace notes record disposition, reason,
  refresh time, stage, tool names, retention policies and retry streak without
  action arguments. `media_binding_capture` reports sanitized capture status,
  target-specific reason codes and bounded counts without URLs or page labels.
  `page_action_binding_capture` reports capture availability, bounded target
  count, focus eligibility and local capture time without tokens or field data.
  No warmup delay, heuristic DOM-location suppression or extra model call is
  required to distinguish irrelevant updates from changed action context.

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
Popover opening/closing is observed in document and open shadow roots before the
next dispatch task, after cancellable page handlers finish. The later toggle event
keeps the same action attribution; canceled openings and owned UI remain quiet.
Trusted gesture endings always release the owning frame's idle gate, including
pointer capture/release over extension-owned UI, without exposing that UI's target.

The monitor regressions are also included in `npm run test:runtime-lifecycle`.
