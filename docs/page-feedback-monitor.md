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

`composerDeliveryMode` only controls typed chat messages (Queue/Steer). Automatic
page feedback uses its own bounded queue and cannot promote a queued message to
Steer or grant authorization. Enter and Alt+Enter retain their existing behavior.

## Observation and dispatch boundaries

- The document-start monitor handshakes with background using a run token and a
  document token. Background validates the actual sender's tab, frame, browser
  document identity when available and monotonic sequence. Full navigation
  invalidates the previous document and its frames.
- Native CDP/BiDi and content actions register their target, input operation and
  actual dispatch before changing the page. Target and native-event phase
  matching suppress their observed effects. CDP resolves the receiving document
  and target, including process-isolated iframes, before registering input in that
  frame. Expectations are finished in every frame touched by the action. Firefox
  companion checks the live document/revision again and renews its marker between
  a shortcut's modifier and letter, as well as before each later key. A different physical intervention
  breaks the expectation, including a later click on the same target. Uncertain
  effects remain `unknown`; `isTrusted` alone does not establish human origin.
- Meaningful visible content, control state, visibility and geometry changes are
  coalesced. Visible subtree identity changes invalidate targets even when the
  replacement has identical text and geometry. CSS animation and extension
  decoration are ignored. A MAIN-world attachment signal observes new open
  shadow roots on existing hosts before their initial rendering; shadow-root
  child-list mutations are also monitored. Inaccessible frames and closed shadow roots retain the
  existing browser-access limitations.
- Event payloads contain bounded target identifiers and scroll positions, never
  typed keys, field values or selected text. The subsequent normal page read uses
  the existing untrusted-content and secret-handling rules.
- Feedback invalidates JEV preparations, remembered field identity and screenshot
  coordinates. It is consumed at existing model/tool boundaries after all tool
  results have matching messages. In-flight results remain; undispatched sibling
  calls receive explicit skipped results. Transport and local dispatch gates
  cover interventions during asynchronous preparation.
- Both Chrome upload paths check feedback after preparation, immediately before
  attaching files. A skipped attachment retains its undispatched outcome.
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

## Verification

`npm run test:page-feedback` runs the controller/transport/workflow/cloud/scheduler
regressions and real Chromium/Firefox DOM fixtures. Fixtures exercise trusted
browser input, same-target intervention, same-shape subtree replacements, frames,
late shadow-root attachment and custom-element upgrades, window and
container scrolling, animation noise, cleanup/restart and persisted navigation
notes. Browser extension APIs are mocked in these fixtures; they are not a live
companion-session integration test.

The monitor regressions are also included in `npm run test:runtime-lifecycle`.
