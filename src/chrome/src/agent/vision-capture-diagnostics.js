// Only these finite labels may leave a native capture boundary in diagnostics.
// Never retain URLs, native error text, document IDs or screenshot content.
const STAGES = new Set(['debugger_attach', 'viewport_metrics', 'document_tree',
  'viewport_evaluate', 'screenshot', 'companion_start', 'companion_bind', 'viewport_native']);
const REASONS = new Set(['restricted_target', 'debugger_conflict', 'permission_denied',
  'tab_closed', 'context_changed', 'not_ready', 'timeout', 'cancelled', 'unknown']);
const BROWSERS = new Set(['chrome', 'firefox']);

export function projectVisionCaptureDiagnostics(value) {
  const output = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  if (STAGES.has(value.stage)) output.stage = value.stage;
  if (REASONS.has(value.reason)) output.reason = value.reason;
  if (BROWSERS.has(value.browser)) output.browser = value.browser;
  return output;
}

export function annotateVisionCaptureError(error, context) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const message = String(failure.message || '');
  let reason = 'unknown';
  if (failure.name === 'AbortError' || failure.code === 'vision_aborted') reason = 'cancelled';
  else if (failure.name === 'TimeoutError' || failure.code === 'vision_capture_timeout') reason = 'timeout';
  else if (failure.code === 'vision_capture_restricted_target') reason = 'restricted_target';
  else if (['vision_stale_frame', 'vision_capture_context_changed'].includes(failure.code)) reason = 'context_changed';
  else if (failure.code === 'vision_capture_not_ready') reason = 'not_ready';
  else if (/another debugger|already being debugged|debugger.*(?:already attached|in use)|devtools.*(?:open|attached)/i.test(message)) reason = 'debugger_conflict';
  else if (/permission|denied|not allowed|not permitted|not authorized/i.test(message)) reason = 'permission_denied';
  else if (/no tab|target closed|session closed|tab (?:was |is )?closed|browser.*closed/i.test(message)) reason = 'tab_closed';
  else if (/restricted|cannot access (?:a )?(?:chrome(?:-extension|-untrusted)?|devtools):\/\//i.test(message)) reason = 'restricted_target';
  failure.captureDiagnostics = projectVisionCaptureDiagnostics({ ...context, reason });
  return failure;
}
