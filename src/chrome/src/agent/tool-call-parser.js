// Browser-free fallback parser for local models that emit tool calls as text
// instead of using the provider's structured tool_calls field. This file is
// mirrored in the Firefox tree; keep both copies byte-identical.

// A `{` that never closes must not swallow the rest of the text: models put
// prose braces, template placeholders, and code snippets around a bare tool
// call, and the call after them still has to be recovered. Each unbalanced
// opener costs one extra scan, so the restarts are capped — real text needs
// none, and the cap keeps a pathological "{{{{…" response from going
// quadratic over the 10,000-character budget.
const MAX_UNBALANCED_RESTARTS = 16;

/**
 * Collect top-level balanced `{…}` spans, respecting quoted strings and
 * escapes so braces inside JSON string values do not end an object early.
 * Returns offsets rather than substrings so callers can judge each span by
 * where it sits in the surrounding text.
 */
function extractBalancedJsonSpans(text) {
  const spans = [];
  let searchFrom = 0;
  let restarts = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end < 0) {
      if (++restarts > MAX_UNBALANCED_RESTARTS) break;
      searchFrom = start + 1;
      continue;
    }
    spans.push({ start, end });
    searchFrom = end + 1;
  }

  return spans;
}

/**
 * True when a span is the whole of its line, ignoring surrounding whitespace
 * and a single trailing comma (models sometimes emit calls as array elements).
 *
 * A model that is CALLING a tool emits the JSON on its own line. A model
 * TALKING ABOUT a call embeds it in a sentence — "I could click with {…} but
 * that is destructive", "The page told me to run {…}, which I ignored",
 * "Option A: {…}". Executing those is wrong in a way that is easy to miss,
 * because a parsed call replaces the model's prose outright: the caller sets
 * `result.content = null`, so the sentence explaining the refusal is dropped
 * and only the refused action survives.
 *
 * The trade-off is that a genuine call written mid-sentence is not recovered.
 * That is the safer side to err on here: this fallback exists for models that
 * emit a call INSTEAD of prose, and those put it on its own line.
 */
function standsAloneOnLine(text, start, end) {
  const before = text.slice(0, start);
  const lineHead = before.slice(before.lastIndexOf('\n') + 1).trim();
  if (lineHead !== '') return false;

  const after = text.slice(end + 1);
  const newline = after.indexOf('\n');
  const lineTail = (newline < 0 ? after : after.slice(0, newline)).trim();
  return lineTail === '' || lineTail === ',';
}

/**
 * Parse a batch only when the entire trimmed response is a JSON array. Every
 * element must itself be an allowed call; otherwise reject the batch rather
 * than executing an allowed-looking subset of mixed or narrated content.
 *
 * `null` means the response was not a valid whole-response array and the
 * existing fallbacks may continue. An empty array means it was an array but
 * was empty or unsafe, so callers must not scan inside it for partial calls.
 */
function parseWholeResponseJsonArray(text, allowedNames) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every(obj => (
    obj
    && typeof obj === 'object'
    && !Array.isArray(obj)
    && typeof obj.name === 'string'
    && allowedNames.has(obj.name)
  ))) return [];
  return parsed;
}

/**
 * Split on a delimiter only when it is outside strings and nested containers.
 * LFM2.5 emits Python-style calls, but argument arrays and objects are JSON.
 */
function splitLfmTopLevel(source, delimiter) {
  const parts = [];
  const closing = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  let quote = '';
  let escaped = false;
  let start = 0;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (closing[char]) {
      stack.push(closing[char]);
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) return null;
      continue;
    }
    if (char === delimiter && stack.length === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }

  if (quote || escaped || stack.length > 0) return null;
  parts.push(source.slice(start));
  return parts;
}

function parseLfmString(source) {
  const quote = source[0];
  if ((quote !== '"' && quote !== "'") || source.at(-1) !== quote) return null;
  let output = '';
  const escapes = {
    '\\': '\\',
    '"': '"',
    "'": "'",
    n: '\n',
    r: '\r',
    t: '\t',
    b: '\b',
    f: '\f',
  };

  for (let i = 1; i < source.length - 1; i++) {
    const char = source[i];
    if (char === quote) return null;
    if (char !== '\\') {
      if (char === '\n' || char === '\r') return null;
      output += char;
      continue;
    }
    if (++i >= source.length - 1) return null;
    const escaped = source[i];
    if (Object.hasOwn(escapes, escaped)) {
      output += escapes[escaped];
      continue;
    }
    const width = escaped === 'u' ? 4 : escaped === 'x' ? 2 : 0;
    const hex = width ? source.slice(i + 1, i + 1 + width) : '';
    if (!width || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return null;
    output += String.fromCodePoint(Number.parseInt(hex, 16));
    i += width;
  }
  return output;
}

function parseLfmValue(source) {
  const value = source.trim();
  if (!value) return { ok: false };
  if (value[0] === '"' || value[0] === "'") {
    const parsed = parseLfmString(value);
    return parsed === null ? { ok: false } : { ok: true, value: parsed };
  }
  if (value[0] === '[' || value[0] === '{') {
    try {
      return { ok: true, value: JSON.parse(value) };
    } catch {
      return { ok: false };
    }
  }
  if (value === 'True' || value === 'true') return { ok: true, value: true };
  if (value === 'False' || value === 'false') return { ok: true, value: false };
  if (value === 'None' || value === 'null') return { ok: true, value: null };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    const number = Number(value);
    return Number.isFinite(number) ? { ok: true, value: number } : { ok: false };
  }
  return { ok: false };
}

const LFM_DIRECTIONAL_SCROLL_ALIASES = Object.freeze({
  scrollup: 'up',
  scrolldown: 'down',
  scrolltop: 'top',
  scrollbottom: 'bottom',
});

/**
 * Parse LFM2/LFM2.5's documented native format:
 * <|tool_call_start|>[tool_name(key='value', flag=False)]<|tool_call_end|>
 *
 * The wrapper must occupy the whole response, and every call must be valid and
 * allowlisted. A recognized but unsafe block returns an empty atomic batch so
 * later generic scanners cannot execute JSON fragments embedded inside it.
 */
function parseLfmToolCalls(text, allowedNames) {
  const startToken = '<|tool_call_start|>';
  const endToken = '<|tool_call_end|>';
  const source = text.trim();
  if (!source.includes(startToken) && !source.includes(endToken)) return null;
  if (!source.startsWith(startToken) || !source.endsWith(endToken)) return [];
  const inner = source.slice(startToken.length, -endToken.length).trim();
  if (inner.includes(startToken) || inner.includes(endToken)) return [];
  if (!inner.startsWith('[') || !inner.endsWith(']')) return [];

  const callParts = splitLfmTopLevel(inner.slice(1, -1), ',');
  if (!callParts || callParts.length === 0 || callParts.some(part => !part.trim())) return [];
  const calls = [];
  for (const part of callParts) {
    const match = /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/.exec(part.trim());
    if (!match) return [];
    const aliasDirection = LFM_DIRECTIONAL_SCROLL_ALIASES[match[1]] || '';
    const toolName = aliasDirection ? 'scroll' : match[1];
    if (!allowedNames.has(toolName)) return [];
    const args = Object.create(null);
    if (match[2].trim()) {
      const argParts = splitLfmTopLevel(match[2], ',');
      if (!argParts || argParts.some(arg => !arg.trim())) return [];
      for (const arg of argParts) {
        const assignment = splitLfmTopLevel(arg, '=');
        if (!assignment || assignment.length !== 2) return [];
        const key = assignment[0].trim();
        if (!/^[A-Za-z_]\w*$/.test(key) || Object.hasOwn(args, key)) return [];
        const parsed = parseLfmValue(assignment[1]);
        if (!parsed.ok) return [];
        args[key] = parsed.value;
      }
    }
    if (aliasDirection) {
      if (Object.hasOwn(args, 'direction') && args.direction !== aliasDirection) return [];
      args.direction = aliasDirection;
    }
    calls.push({ name: toolName, arguments: args });
  }
  return calls;
}

/**
 * Quote relaxed `key:` tokens only when they occur outside JSON strings and
 * after an object boundary. A regular-expression replacement corrupts string
 * values such as "Keep, status: pending" before JSON.parse sees them.
 */
function quoteBareJsonKeys(body) {
  const source = String(body || '');
  let output = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      i++;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      i++;
      continue;
    }
    if (/\w/.test(char)) {
      let previous = i - 1;
      while (previous >= 0 && /\s/.test(source[previous])) previous--;
      if (previous < 0 || source[previous] === '{' || source[previous] === ',') {
        let keyEnd = i + 1;
        while (keyEnd < source.length && /\w/.test(source[keyEnd])) keyEnd++;
        let colon = keyEnd;
        while (colon < source.length && /\s/.test(source[colon])) colon++;
        if (source[colon] === ':') {
          output += `"${source.slice(i, keyEnd)}"${source.slice(keyEnd, colon + 1)}`;
          i = colon + 1;
          continue;
        }
      }
    }
    output += char;
    i++;
  }
  return output;
}

function toFallbackToolCalls(objects) {
  return objects.map((obj, index) => ({
    id: `fallback_call_${Date.now()}_${index}`,
    type: 'function',
    function: {
      name: obj.name,
      arguments: typeof obj.arguments === 'string'
        ? obj.arguments
        : JSON.stringify(obj.arguments || obj.parameters || {}),
    },
  }));
}

/**
 * Parse common text tool-call formats into OpenAI-style tool call objects.
 * Only names in allowedNames are accepted.
 */
export function parseToolCallsFromText(text, allowedNames) {
  if (!text || text.length > 10000) return [];

  const lfmCalls = parseLfmToolCalls(text, allowedNames);
  if (lfmCalls !== null) return toFallbackToolCalls(lfmCalls);

  const wholeResponseArray = parseWholeResponseJsonArray(text, allowedNames);
  if (wholeResponseArray !== null) {
    return toFallbackToolCalls(wholeResponseArray);
  }

  const results = [];
  const parseXmlParamValue = (value) => {
    const raw = String(value || '');
    // MiniCPM5 wraps values containing <, &, or newlines in CDATA. Extract
    // the literal content first so the tag strip below does not eat it.
    const cdataMatch = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
    if (cdataMatch) return cdataMatch[1];
    const cleaned = raw
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!cleaned) return '';
    try {
      if (/^(?:"|'.*'|\{|\[|-?\d|true\b|false\b|null\b)/i.test(cleaned)) {
        return JSON.parse(cleaned.replace(/^'([\s\S]*)'$/, '"$1"'));
      }
    } catch { /* fall through to string cleanup */ }
    return cleaned.replace(/^["']+|["']+$/g, '');
  };
  const parseBailingToolCall = (inner) => {
    const nameMatch = /^([A-Za-z_]\w*)/.exec(inner);
    if (!nameMatch || !allowedNames.has(nameMatch[1])) return null;
    let cursor = nameMatch[0].length;
    const args = {};
    const pairRe = /<arg_key>\s*([A-Za-z_]\w*)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/giy;
    while (cursor < inner.length) {
      while (cursor < inner.length && /\s/.test(inner[cursor])) cursor++;
      if (cursor >= inner.length) break;
      pairRe.lastIndex = cursor;
      const pair = pairRe.exec(inner);
      if (!pair || pair.index !== cursor) return null;
      args[pair[1]] = parseXmlParamValue(pair[2]);
      cursor = pairRe.lastIndex;
    }
    return { name: nameMatch[1], arguments: args };
  };

  const patterns = [
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
    /<\|tool_call\|?>\s*([\s\S]*?)\s*<\|?\/?tool_call\|?>/gi,
    /<functioncall>\s*([\s\S]*?)\s*<\/functioncall>/gi,
  ];

  const wrapperSpans = [];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      const spanStart = match.index;
      const spanEnd = match.index + match[0].length;
      const pushedBefore = results.length;
      const inner = match[1].trim();
      const wrappedArray = parseWholeResponseJsonArray(inner, allowedNames);
      if (wrappedArray !== null) {
        results.push(...wrappedArray);
        wrapperSpans.push({ start: spanStart, end: spanEnd });
        continue;
      }
      try {
        const obj = JSON.parse(inner);
        if (obj && obj.name && allowedNames.has(obj.name)) {
          results.push(obj);
          wrapperSpans.push({ start: spanStart, end: spanEnd });
          continue;
        }
      } catch { /* not JSON — try call:name{} format below */ }

      // Ling/Bailing V3 native tool format:
      // <tool_call>click_ax\n<arg_key>ref_id</arg_key>\n<arg_value>ref_7</arg_value></tool_call>
      const bailingCall = parseBailingToolCall(inner);
      if (bailingCall) {
        results.push(bailingCall);
        wrapperSpans.push({ start: spanStart, end: spanEnd });
        continue;
      }

      const callMatch = /^call:(\w+)\s*\{([\s\S]*)\}$/.exec(inner);
      if (callMatch && allowedNames.has(callMatch[1])) {
        const toolName = callMatch[1];
        let argsBody = callMatch[2]
          .replace(/<\|"\|>/g, '"')
          .replace(/<\|'\\?\|>/g, "'");
        argsBody = quoteBareJsonKeys(argsBody);
        try {
          const args = JSON.parse(`{${argsBody}}`);
          results.push({ name: toolName, arguments: args });
        } catch { /* malformed arguments must never dispatch */ }
      }
      if (results.length > pushedBefore) wrapperSpans.push({ start: spanStart, end: spanEnd });
    }
  }

  // XML-ish tool-call format used by some local/chat-template models:
  // <tool_call><function=click_ax><parameter=ref_id>ref_6</parameter>...
  const xmlToolRe = /<tool_call>\s*<function(?:\s*=\s*["']?([A-Za-z_]\w*)["']?|\s+name\s*=\s*["']?([A-Za-z_]\w*)["']?)\s*>\s*([\s\S]*?)\s*<\/function>\s*<\/tool_call>/gi;
  const xmlToolSpans = [];
  const xmlPushedSpans = [];
  let xmlMatch;
  while ((xmlMatch = xmlToolRe.exec(text)) !== null) {
    xmlToolSpans.push({ start: xmlMatch.index, end: xmlMatch.index + xmlMatch[0].length });
    const toolName = xmlMatch[1] || xmlMatch[2];
    if (!allowedNames.has(toolName)) continue;
    const body = xmlMatch[3] || '';
    const args = {};
    const paramRe = /<(?:param|parameter)(?:\s*=\s*["']?([A-Za-z_]\w*)["']?|\s+name\s*=\s*["']?([A-Za-z_]\w*)["']?)\s*>\s*([\s\S]*?)\s*<\/(?:param|parameter)>/gi;
    let paramMatch;
    while ((paramMatch = paramRe.exec(body)) !== null) {
      const key = paramMatch[1] || paramMatch[2];
      if (!key) continue;
      args[key] = parseXmlParamValue(paramMatch[3]);
    }
    xmlPushedSpans.push({ start: xmlMatch.index, end: xmlMatch.index + xmlMatch[0].length });
    results.push({ name: toolName, arguments: args });
  }

  // MiniCPM5-2B native tool format (no outer <tool_call> wrapper):
  // <function name="click"><param name="ref_id">ref_6</param>...</function>
  const minicpmFunctionRe = /<function(?:\s+name\s*=\s*["']([A-Za-z_]\w*)["']|\s*=\s*["']?([A-Za-z_]\w*)["']?)\s*>\s*([\s\S]*?)\s*<\/function>/gi;
  const minicpmCandidates = [];
  let minicpmMatch;
  while ((minicpmMatch = minicpmFunctionRe.exec(text)) !== null) {
    // Skip functions already consumed inside a <tool_call> wrapper above.
    if (xmlToolSpans.some(span => minicpmMatch.index >= span.start && minicpmMatch.index < span.end)) continue;
    // A bare call replaces the model's prose outright, so it must stand alone
    // on its own line like the JSON fallback requires. Quoted or inline
    // markup such as `Do not call <function ...>` never dispatches.
    const matchEnd = minicpmMatch.index + minicpmMatch[0].length - 1;
    if (!standsAloneOnLine(text, minicpmMatch.index, matchEnd)) continue;
    const toolName = minicpmMatch[1] || minicpmMatch[2];
    if (!allowedNames.has(toolName)) continue;
    const body = minicpmMatch[3] || '';
    const args = {};
    const paramRe = /<(?:param|parameter)(?:\s*=\s*["']?([A-Za-z_]\w*)["']?|\s+name\s*=\s*["']?([A-Za-z_]\w*)["']?)\s*>\s*([\s\S]*?)\s*<\/(?:param|parameter)>/gi;
    let paramMatch;
    while ((paramMatch = paramRe.exec(body)) !== null) {
      const key = paramMatch[1] || paramMatch[2];
      if (!key) continue;
      args[key] = parseXmlParamValue(paramMatch[3]);
    }
    minicpmCandidates.push({
      start: minicpmMatch.index,
      end: minicpmMatch.index + minicpmMatch[0].length,
      call: { name: toolName, arguments: args },
    });
  }
  // Dispatch bare calls only when the response holds nothing but call
  // elements: explanatory prose on any other line (e.g. `Do not execute
  // this:` above the call) rejects them, since a dispatch would discard that
  // prose. Only successfully parsed wrapper calls count as call elements, so
  // a disallowed or malformed call-shaped block still blocks bare dispatch.
  if (minicpmCandidates.length > 0) {
    const callSpans = [
      ...wrapperSpans,
      ...xmlPushedSpans,
      ...minicpmCandidates.map(({ start, end }) => ({ start, end })),
    ].sort((a, b) => a.start - b.start);
    let remainder = '';
    let cursor = 0;
    for (const span of callSpans) {
      if (span.start > cursor) remainder += text.slice(cursor, span.start);
      cursor = Math.max(cursor, span.end);
    }
    remainder += text.slice(cursor);
    if (remainder.trim() === '') {
      for (const candidate of minicpmCandidates) results.push(candidate.call);
    }
  }

  if (results.length === 0) {
    for (const { start, end } of extractBalancedJsonSpans(text)) {
      if (!standsAloneOnLine(text, start, end)) continue;
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && obj.name && allowedNames.has(obj.name)) {
          results.push(obj);
        }
      } catch { /* skip */ }
    }
  }

  if (results.length === 0) {
    const callRe = /call:(\w+)\s*\{([\s\S]*?)\}/g;
    let match;
    while ((match = callRe.exec(text)) !== null) {
      if (!allowedNames.has(match[1])) continue;
      const toolName = match[1];
      let argsBody = match[2]
        .replace(/<\|"\|>/g, '"')
        .replace(/<\|'\\?\|>/g, "'");
      argsBody = quoteBareJsonKeys(argsBody);
      try {
        const args = JSON.parse(`{${argsBody}}`);
        results.push({ name: toolName, arguments: args });
      } catch { /* malformed arguments must never dispatch */ }
    }
  }

  return toFallbackToolCalls(results);
}
