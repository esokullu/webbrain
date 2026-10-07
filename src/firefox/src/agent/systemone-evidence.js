import { BROWSER_MUTATION_TOOLS } from './mutation-tools.js';
import { secureRandomBase36Token } from './random-token.js';

// Only these textual observations may leave the browser. Never serialize an
// entire tool result: it can include credentials, request bodies or attachments.
const READS = new Map([
  ['get_accessibility_tree', ['pageContent']], ['read_page', ['text', 'content', 'pageContent']],
  ['verify_form', ['fields', 'verified']], ['chat_observe', ['workflowState', 'newMessages']],
]);
const READ_NAVIGATION = new Set(['navigate', 'go_back', 'go_forward', 'scroll', 'hover', 'highlight_element', 'inspect_event_listeners', 'delegate_research', 'gmail_count_results']);
const SIDE_EFFECTS = new Set([...BROWSER_MUTATION_TOOLS, 'download_files', 'download_file', 'chrome_web_store_publish']);

export function systemOneStateBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// Include JSON escaping in the UTF-8 budget and never split a code point.
export function boundedSystemOneText(value, limit) {
  const text = String(value ?? '');
  if (systemOneStateBytes(text) <= limit) return text;
  const characters = Array.from(text);
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (systemOneStateBytes(characters.slice(0, middle).join('')) <= limit) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join('');
}

export function redactSystemOneText(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s"<>]+/gi, raw => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[url]'; }
  }).replace(/[^\n]*(?:password|passwd|api[_ -]?key|authorization|access[_ -]?token|refresh[_ -]?token|cookie|secret|recovery code)[^\n]*/gi, '[credential omitted]')
    .replace(/\bBearer\s+\S+/gi, '[credential omitted]');
}

export function wrapSystemOneData(value) {
  const id = secureRandomBase36Token(8);
  const text = String(value).replace(/<\/?untrusted_page_content\b[^>]*>/gi, '[markup stripped]');
  return `<untrusted_page_content id="${id}">\n${text}\n</untrusted_page_content id="${id}">`;
}

export function createSystemOneEvidence(wrap = (_name, text) => wrapSystemOneData(text)) {
  let observations = [];
  let sideEffect = false;
  let pendingMutation = null;
  return {
    observe(type, data = {}) {
      const name = data.name;
      const networkWrite = ['fetch_url', 'research_url'].includes(name) && /^(POST|PUT|PATCH|DELETE)$/i.test(data.args?.method || '');
      if (type === 'tool_call' && (SIDE_EFFECTS.has(name) || networkWrite)) {
        observations = [];
        pendingMutation = name;
      }
      if (type !== 'tool_result') return;
      const result = data.result;
      if (pendingMutation === name) {
        if (!READ_NAVIGATION.has(name) && result?.noDispatch !== true && result?.dispatched !== false) sideEffect = true;
        pendingMutation = null;
      }
      if (!READS.has(name) || !result || result.error || result.success === false) return;
      const fields = {};
      for (const key of READS.get(name)) {
        // Nested data is excluded; explicit scalar readback fields are allowed.
        if (typeof result[key] === 'string') fields[key] = boundedSystemOneText(redactSystemOneText(result[key]), 2500);
        if (typeof result[key] === 'boolean') fields[key] = result[key];
      }
      if (!Object.values(fields).some(v => typeof v === 'string' && v.trim())) return;
      observations.push({ tool: name, data: wrap(name, JSON.stringify(fields)) });
      observations = observations.slice(-2);
    },
    snapshot() { return { observations: observations.slice(), sideEffect: sideEffect || (!!pendingMutation && !READ_NAVIGATION.has(pendingMutation)) }; },
  };
}

export function systemOneEvidenceState(task, evidence, baseline = null) {
  if (!evidence?.observations?.length) return null;
  const state = {
    task: boundedSystemOneText(redactSystemOneText(task), 4000),
    latest_observation: evidence.observations,
    baseline: Array.isArray(baseline) ? baseline.slice(-1).filter(v => READS.has(v?.tool) && typeof v.data === 'string').map(v => ({ tool: v.tool, data: wrapSystemOneData(boundedSystemOneText(redactSystemOneText(v.data), 3000)) })) : null,
  };
  if (systemOneStateBytes(state) > 16000) state.baseline = null;
  if (systemOneStateBytes(state) > 16000) state.latest_observation = evidence.observations.slice(-1);
  if (systemOneStateBytes(state) > 16000) return null;
  return state;
}
