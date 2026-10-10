import { isDemonRouteQwenConfig } from './provider-compatibility.js';

export const MAX_QWEN_TOOL_TEXT = 32768;
export const MAX_QWEN_TOOL_PREFIX = 1024;
export const INVALID_QWEN_TOOL_RESPONSE = 'The model returned an invalid tool-call response. No browser action was dispatched. Return a complete tool-only response using the supplied tools.';
const MAX_CALLS = 16;
const MAX_DEPTH = 32;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const isToolCandidate = content => typeof content === 'string' && /<tool_call\b/i.test(content);

function offeredNames(config, options) {
  if (!isDemonRouteQwenConfig(config) || options.toolChoice === 'none' || !Array.isArray(options.tools)) return null;
  const names = new Set(options.tools.filter(tool => tool?.type === 'function' && typeof tool.function?.name === 'string').map(tool => tool.function.name));
  const choice = options.toolChoice;
  if (choice && typeof choice === 'object') {
    const name = choice.function?.name;
    if (typeof name !== 'string' || !names.has(name)) return null;
    return new Set([name]);
  }
  return names.size ? names : null;
}

function deniedChoice(config, options) {
  if (!isDemonRouteQwenConfig(config) || !Array.isArray(options.tools) || !options.tools.length) return false;
  if (options.toolChoice === 'none') return true;
  const name = options.toolChoice?.function?.name;
  return typeof name === 'string' && !options.tools.some(tool => tool?.type === 'function' && tool.function?.name === name);
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (depth > MAX_DEPTH) return false;
    for (const [key, child] of Object.entries(item)) {
      if (UNSAFE_KEYS.has(key)) return false;
      if (typeof child === 'number' && !Number.isFinite(child)) return false;
      if (child && typeof child === 'object') pending.push([child, depth + 1]);
    }
  }
  return true;
}

function parameterValue(text, schema) {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  const accepts = (value, type) => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
      : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value)
        : type === 'integer' ? Number.isSafeInteger(value)
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === type;
  let value;
  if (types.includes('string')) {
    // The official template writes strings verbatim between framing newlines.
    // Never infer JSON, booleans or numbers from a string-typed parameter.
    if (types.length !== 1) throw new Error('Ambiguous string parameter type.');
    value = text.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  } else {
    const source = text.trim();
    // Jinja renders standalone Python booleans as True/False. Accept exactly
    // those spellings only when the offered schema declares a boolean.
    value = types.includes('boolean') && (source === 'True' || source === 'False')
      ? source === 'True' : JSON.parse(source);
  }
  if (!types.some(type => accepts(value, type)) || !safeObject({ value })) throw new Error('Invalid parameter type or value.');
  return value;
}

/** Parse only complete envelopes. This is transport normalization,
 * not execution: Agent schema checks, permissions and completion evidence still
 * apply. Never evaluate model text or recover a subset of a malformed batch. */
function parseDemonRouteQwenResponse(config, options, content) {
  const names = offeredNames(config, options);
  if (!names || typeof content !== 'string' || content.length > MAX_QWEN_TOOL_TEXT) return null;
  let text = content.trim();
  let prefix = '';
  if (!text.startsWith('<tool_call>')) {
    const firstCall = text.indexOf('<tool_call>');
    if (firstCall <= 0 || firstCall > MAX_QWEN_TOOL_PREFIX) return null;
    prefix = text.slice(0, firstCall).trimEnd();
    // The primary Qwen template permits natural-language reasoning before
    // canonical calls. Never treat examples, code, XML or legacy formats as
    // this exception, and never release the prefix before the full batch parses.
    const code = /[<>{}\[\]`]|~~~|\btool_call\b|\b(?:function|parameter|tool_calls?)\s*[:=]/i.test(prefix);
    const exemplar = /\b(?:for example|for illustration|as an example|(?:example|sample|template|syntax)\s*(?::|call\b|tool\b|function\b|response\b|envelope\b|code\b)|(?:this|here)\s+(?:is|are)\s+(?:an?\s+)?(?:example|sample|template|format)\b|(?:format|syntax)\s+(?:is|below)\b)/i.test(prefix);
    if (!prefix || code || exemplar) return null;
    text = text.slice(firstCall);
  }
  let position = 0;
  const calls = [];
  const schemas = new Map(options.tools.filter(tool => names.has(tool?.function?.name)).map(tool => [tool.function.name, tool.function.parameters]));
  const whitespace = () => { while (/\s/.test(text[position] || '') && position < text.length) position++; };
  const consume = token => {
    if (!text.startsWith(token, position)) throw new Error('Invalid tool envelope.');
    position += token.length;
  };
  const object = () => {
    if (text[position] !== '{') throw new Error('Expected JSON object.');
    const start = position;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; position < text.length; position++) {
      const character = text[position];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        const value = JSON.parse(text.slice(start, ++position));
        if (!safeObject(value)) throw new Error('Unsafe JSON object.');
        return value;
      }
    }
    throw new Error('Incomplete JSON object.');
  };
  const call = (name, args) => {
    if (!names.has(name) || !safeObject(args) || calls.length >= MAX_CALLS) throw new Error('Invalid tool call.');
    calls.push({ name, args });
  };
  const canonicalFunction = () => {
    consume('<function=');
    const end = text.indexOf('>', position);
    if (end < 0) throw new Error('Missing function name.');
    const name = text.slice(position, end);
    if (!names.has(name)) throw new Error('Function was not offered.');
    const properties = schemas.get(name)?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new Error('Missing parameter schema.');
    position = end + 1;
    whitespace();
    const args = {};
    while (text.startsWith('<parameter=', position)) {
      consume('<parameter=');
      const keyEnd = text.indexOf('>', position);
      if (keyEnd < 0) throw new Error('Missing parameter name.');
      const key = text.slice(position, keyEnd);
      if (UNSAFE_KEYS.has(key) || !Object.hasOwn(properties, key) || Object.hasOwn(args, key)) throw new Error('Unknown or duplicate parameter.');
      position = keyEnd + 1;
      const start = position;
      const schema = properties[key];
      const stringType = schema?.type === 'string' || Array.isArray(schema?.type) && schema.type.includes('string');
      let quoted = false;
      let escaped = false;
      let parameterEnd = -1;
      for (; position < text.length; position++) {
        if (!quoted && text.startsWith('</parameter>', position)) { parameterEnd = position; break; }
        const character = text[position];
        if (!stringType) {
          if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
          } else if (character === '"') quoted = true;
        }
      }
      if (parameterEnd < 0) throw new Error('Incomplete parameter.');
      const source = text.slice(start, parameterEnd);
      if (stringType && /<\/?(?:tool_call|function|parameter)\b/.test(source)) throw new Error('Nested tool markup in string parameter.');
      args[key] = parameterValue(source, schema);
      consume('</parameter>');
      whitespace();
    }
    consume('</function>');
    call(name, args);
  };
  const envelope = (depth = 0) => {
    if (depth > MAX_DEPTH) throw new Error('Nested tool envelope is too deep.');
    consume('<tool_call>');
    whitespace();
    if (text.startsWith('<tool_call>', position)) {
      if (prefix) throw new Error('Prefixed response must use canonical envelopes.');
      do { envelope(depth + 1); whitespace(); } while (text.startsWith('<tool_call>', position));
    } else if (text.startsWith('<function=', position)) {
      canonicalFunction();
    } else if (text.startsWith('<tool_name>', position)) {
      if (prefix) throw new Error('Prefixed response must use canonical envelopes.');
      consume('<tool_name>');
      const end = text.indexOf('</tool_name>', position);
      if (end < 0) throw new Error('Missing tool name.');
      const name = text.slice(position, end).trim();
      position = end;
      consume('</tool_name>');
      whitespace();
      consume('<tool_args>');
      whitespace();
      const args = object();
      whitespace();
      consume('</tool_args>');
      call(name, args);
    } else {
      if (prefix) throw new Error('Prefixed response must use canonical envelopes.');
      const value = object();
      if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'arguments')) throw new Error('Invalid JSON tool envelope.');
      call(value.name, value.arguments);
    }
    whitespace();
    consume('</tool_call>');
  };
  try {
    while (position < text.length) { envelope(); whitespace(); }
    if (!calls.length) return null;
    return { prefix, toolCalls: calls.map(({ name, args }) => ({
      id: 'call_' + crypto.randomUUID().replaceAll('-', ''),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })) };
  } catch { return null; }
}

export function parseDemonRouteQwenToolCalls(config, options, content) {
  return parseDemonRouteQwenResponse(config, options, content)?.toolCalls || null;
}

export function normalizeDemonRouteQwenResult(config, options, result) {
  if (result.toolCalls?.length || !isToolCandidate(result.content)
    || !offeredNames(config, options) && !deniedChoice(config, options)) return result;
  const parsed = result.finishReason === 'stop' ? parseDemonRouteQwenResponse(config, options, result.content) : null;
  // Do not leave invalid envelopes available to Agent's permissive local-model
  // parser, which could otherwise salvage one call from a rejected batch.
  const raw = result.raw || { qwenToolNormalization: { originalContent: result.content, originalFinishReason: result.finishReason } };
  return parsed
    ? { ...result, content: parsed.prefix, toolCalls: parsed.toolCalls, finishReason: 'tool_calls', raw }
    : { ...result, content: INVALID_QWEN_TOOL_RESPONSE, raw, rejectedToolResponse: rejectedToolResponse(options, result.content, result.finishReason) };
}

// Only structural metadata crosses the trace/export boundary. Raw model text
// stays on the private provider result and may contain page or user secrets.
function rejectedToolResponse(options, content, finishReason, { tooLarge = false, contentChars = content.length } = {}) {
  const text = content.trim();
  const format = /<tool_name>/.test(text) ? 'xml_name_args'
    : /<tool_call>\s*\{/.test(text) ? 'json_envelope'
      : /<function=/.test(text) ? 'function_parameters' : 'other_xml';
  const choice = options.toolChoice && typeof options.toolChoice === 'object'
    ? 'named' : ['auto', 'required', 'none'].includes(options.toolChoice) ? options.toolChoice : 'unspecified';
  const reason = tooLarge || contentChars > MAX_QWEN_TOOL_TEXT ? 'oversized'
    : finishReason !== 'stop' ? 'incomplete_response'
      : !text.startsWith('<tool_call>') || /```/.test(text) ? 'mixed_content' : 'invalid_envelope';
  return { provider: 'demonroute_qwen', format, reason, choice, contentChars, offeredTools: options.tools.length };
}

export async function* normalizeDemonRouteQwenStream(config, options, stream) {
  if (!offeredNames(config, options) && !deniedChoice(config, options)) { yield* stream; return; }
  let content = '';
  let buffered = [];
  let nativeCalls = false;
  let tooLarge = false;
  let oversizedCandidate = false;
  let suffix = '';
  let contentChars = 0;
  const raw = finishReason => ({ qwenToolNormalization: { originalContent: content, originalFinishReason: finishReason, ...(tooLarge ? { truncated: true } : {}) } });
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text' && !nativeCalls) {
        const delta = String(chunk.content || '');
        contentChars = Math.min(Number.MAX_SAFE_INTEGER, contentChars + delta.length);
        if (tooLarge) {
          oversizedCandidate ||= isToolCandidate(suffix + delta);
          suffix = delta.slice(-32);
          if (!oversizedCandidate) yield chunk;
        } else if (content.length + delta.length > MAX_QWEN_TOOL_TEXT) {
          oversizedCandidate = isToolCandidate(content) || isToolCandidate(suffix + delta);
          content += delta.slice(0, Math.max(0, MAX_QWEN_TOOL_TEXT - content.length));
          tooLarge = true;
          if (!oversizedCandidate) {
            for (const text of buffered) yield text;
            yield chunk;
          }
          buffered = [];
          suffix = delta.slice(-32);
        } else {
          content += delta;
          buffered.push(chunk);
          suffix = content.slice(-32);
        }
        continue;
      }
      if ((chunk.type === 'tool_call' && chunk.content?.length) || ['tool_call_start', 'tool_call_delta'].includes(chunk.type)) {
        nativeCalls = true;
        for (const text of buffered) yield text;
        buffered = [];
        content = '';
      }
      if (chunk.type === 'done') {
        const candidate = !nativeCalls && (oversizedCandidate || isToolCandidate(content));
        const parsed = candidate && !tooLarge && chunk.finishReason === 'stop'
          ? parseDemonRouteQwenResponse(config, options, content)
          : null;
        if (parsed) {
          if (parsed.prefix) yield { type: 'text', content: parsed.prefix };
          yield { type: 'tool_call', content: parsed.toolCalls.map((call, index) => ({ ...call, index })) };
        }
        else if (candidate) yield { type: 'text', content: INVALID_QWEN_TOOL_RESPONSE };
        else for (const text of buffered) yield text;
        yield candidate ? {
          ...chunk,
          ...(parsed ? { finishReason: 'tool_calls' } : { rejectedToolResponse: rejectedToolResponse(options, content, chunk.finishReason, { tooLarge, contentChars }) }),
          raw: chunk.raw || raw(chunk.finishReason),
        } : chunk;
        return;
      }
      yield chunk;
    }
  } catch (error) {
    if (!nativeCalls && (oversizedCandidate || isToolCandidate(content))) {
      // Keep diagnostics without releasing an executable XML prefix on error.
      if (error && typeof error === 'object' && !error.raw) error.raw = raw('error');
      yield { type: 'text', content: INVALID_QWEN_TOOL_RESPONSE };
    }
    throw error;
  }
  if (!nativeCalls && (oversizedCandidate || isToolCandidate(content))) yield { type: 'text', content: INVALID_QWEN_TOOL_RESPONSE };
  else for (const text of buffered) yield text;
}
