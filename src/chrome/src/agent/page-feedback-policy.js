/** Tool freshness policy for passive page observations. Mirror in Firefox. */
const FRESH_READS = new Set([
  'get_accessibility_tree', 'get_interactive_elements', 'read_page', 'read_page_source',
  'extract_data', 'get_selection', 'get_shadow_dom', 'shadow_dom_query', 'get_frames',
  'iframe_read', 'get_window_info', 'list_webmcp_tools', 'inspect_viewport', 'screenshot',
  'wait_for_element', 'wait_for_stable', 'read_console', 'inspect_network_requests',
  'inspect_element_styles', 'verify_form', 'chat_observe',
]);
const DETACHED_TOOLS = new Set([
  'list_downloads', 'read_downloaded_file', 'scratchpad_write', 'progress_read',
  'progress_update', 'recall_memcode', 'clarify',
]);
const AX_ACTIONS = new Set(['click_ax', 'type_ax', 'set_field', 'set_checked']);
const httpUrl = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

export function isPassivePageFeedback(events) {
  return !!events?.length && events.every(event => event.kind === 'dom' && event.source === 'page'
    && event.frameId === 0 && !/^(?:base|style|link)(?:$|[\s#.])/.test(event.target || ''));
}

function axTargetContext(page, refId) {
  if (!page || page.success === false || page.depthTruncated || page.truncated || !/^ref_[A-Za-z0-9_-]+$/.test(refId || '')) return null;
  const lines = String(page.pageContent || '').split(/\r?\n/);
  const indices = lines.flatMap((line, index) => line.includes(`[${refId}]`) ? [index] : []);
  if (indices.length !== 1) return null;
  const index = indices[0], line = lines[index];
  if (/\b(?:occluded|disabled|inert)=true\b/.test(line)) return null;
  let depth = line.length - line.trimStart().length;
  const ancestors = [];
  let scope = index, scopeRole = '';
  let navigation = false;
  const href = /\bhref=("(?:\\.|[^"\\])*")/.exec(line);
  if (/^\s*link\b/.test(line) && href) {
    try { navigation = !!httpUrl(new URL(JSON.parse(href[1]), page.url).href); } catch {}
  }
  for (let i = index - 1; i >= 0 && depth > 0; i--) {
    const ancestorDepth = lines[i].length - lines[i].trimStart().length;
    if (lines[i].trim() && ancestorDepth < depth) {
      ancestors.unshift(lines[i]); depth = ancestorDepth;
      // A form/dialog/region binds the action to its recipient/composer/entity,
      // not just to a same-labelled control elsewhere on the document.
      const role = /^\s*(form|dialog|region|article|listitem)\b/.exec(lines[i])?.[1];
      if (!navigation && role && (scope === index || (scopeRole === 'form' && role !== 'form'))) {
        scope = i; scopeRole = role;
      }
    }
  }
  const scopeDepth = lines[scope].length - lines[scope].trimStart().length;
  let end = scope + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].length - lines[end].trimStart().length > scopeDepth)) end++;
  // Conversation/entity headings often sit outside the composer form.
  // Bind their full AX subtree just as the local monitor does, so an unchanged
  // control cannot silently transfer to another recipient or resource.
  const headings = [];
  if (!navigation) for (let i = 0; i < lines.length; i++) {
    if (!/^\s*heading\b/.test(lines[i])) continue;
    const headingDepth = lines[i].length - lines[i].trimStart().length;
    let last = i + 1;
    while (last < lines.length && (!lines[last].trim() || lines[last].length - lines[last].trimStart().length > headingDepth)) last++;
    headings.push(lines.slice(i, last));
  }
  return { line, context: JSON.stringify([ancestors, lines.slice(scope, end), headings]) };
}

export function pageFeedbackCallPolicy(name, args = {}, state = {}, currentPage = null, events = []) {
  if (FRESH_READS.has(name)) return { kind: 'observe' };
  if (DETACHED_TOOLS.has(name)) return { kind: 'independent' };
  if (['fetch_url', 'research_url'].includes(name) && httpUrl(args.url)
      && ['GET', 'HEAD'].includes(String(args.method || 'GET').toUpperCase())
      && !args.replayRequestId && !args.body) return { kind: 'independent' };
  if (name === 'read_pdf' && (httpUrl(args.url) || args.download_id)) return { kind: 'independent' };
  if (name === 'download_files' && Array.isArray(args.urls) && args.urls.length && args.urls.every(httpUrl)) return { kind: 'independent' };
  if (name === 'download_public_media' && (httpUrl(args.url) || httpUrl(state.url))) return { kind: 'independent' };
  if (name === 'navigate' && httpUrl(args.url)) return { kind: 'navigate' };
  if (name === 'done' && args.outcome === 'success' && currentPage?.success !== false) return { kind: 'observe', terminal: true };
  if (name === 'download_social_media' && !args.scroll && !args.all
      && [undefined, 'main', 'auto'].includes(args.mode)
      && [undefined, 'dom', 'auto'].includes(args.strategy)
      && (args.limit == null || args.limit === 1)) {
    const target = !args.target || args.target === 'media' ? 'auto' : args.target;
    if (['auto', 'image', 'video'].includes(target)) {
      const binding = state.mediaBindings?.[target];
      if (binding && (args.mode === 'main' || binding.focused)) return { kind: 'media', binding, target };
      // An unavailable optional precapture is not a changed page. Dispatch a
      // read-only resolver result so the model can inspect actual media sources;
      // this policy never permits an unbound fetch/save or a fallback mutation.
      return { kind: 'media_resolve', target, reason: binding ? 'focus_unverified' : 'media_binding_missing' };
    }
  }
  if (!AX_ACTIONS.has(name) || !currentPage || events.some(event => /^(?:form|input|textarea|select|option)(?:$|[\s#.])/.test(event.target || ''))) return { kind: 'unsafe' };
  const before = axTargetContext(state.page && { ...state.page, url: state.page.url || state.url }, args.ref_id);
  const after = axTargetContext({ ...currentPage, url: currentPage.url || state.url }, args.ref_id);
  if (!before || before.context !== after?.context) return { kind: 'unsafe' };
  // Submissions retain all existing model, form, recipient and dispatch gates.
  // A changing submit surface must be reconsidered rather than accepted from AX alone.
  if (name === 'click_ax' && /\btype="submit"/.test(after.line)) return { kind: 'unsafe' };
  return { kind: 'target' };
}

export function canRetainPageFeedbackCalls(calls, state, currentPage, events, { pending = false } = {}) {
  if (!calls?.length || !isPassivePageFeedback(events)) return false;
  return calls.every(call => {
    let args;
    try { args = JSON.parse(call.function?.arguments); } catch { return false; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const policy = pageFeedbackCallPolicy(call.function?.name, args, state, currentPage, events);
    if (policy.terminal && calls.length !== 1) return false;
    // A target comparison only certifies the snapshot just read. Further DOM
    // changes require local revalidation; fresh readers/media have their own fences.
    if (pending && policy.kind === 'target') return false;
    return policy.kind !== 'unsafe';
  });
}
