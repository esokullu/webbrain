import { isDemonRouteQwenConfig } from './provider-compatibility.js';

export const MAX_QWEN_TOOL_TEXT = 32768;
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

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (depth > MAX_DEPTH) return false;
    for (const [key, child] of Object.entries(item)) {
      if (UNSAFE_KEYS.has(key)) return false;
      if (child && typeof child === 'object') pending.push([child, depth + 1]);
    }
  }
  return true;
}

/** Parse only complete tool-only envelopes. This is transport normalization,
 * not execution: Agent schema checks, permissions and completion evidence still
 * apply. Never evaluate model text or recover a subset of a malformed batch. */
export function parseDemonRouteQwenToolCalls(config, options, content) {
  const names = offeredNames(config, options);
  if (!names || typeof content !== 'string' || content.length > MAX_QWEN_TOOL_TEXT) return null;
  const text = content.trim();
  if (!text.startsWith('<tool_call>')) return null;
  let position = 0;
  const calls = [];
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
  const envelope = (depth = 0) => {
    if (depth > MAX_DEPTH) throw new Error('Nested tool envelope is too deep.');
    consume('<tool_call>');
    whitespace();
    if (text.startsWith('<tool_call>', position)) {
      do { envelope(depth + 1); whitespace(); } while (text.startsWith('<tool_call>', position));
    } else if (text.startsWith('<tool_name>', position)) {
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
    return calls.map(({ name, args }) => ({
      id: 'call_' + crypto.randomUUID().replaceAll('-', ''),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }));
  } catch { return null; }
}

export function normalizeDemonRouteQwenResult(config, options, result) {
  if (result.toolCalls?.length || !offeredNames(config, options) || !isToolCandidate(result.content)) return result;
  const calls = result.finishReason === 'stop' ? parseDemonRouteQwenToolCalls(config, options, result.content) : null;
  // Do not leave invalid envelopes available to Agent's permissive local-model
  // parser, which could otherwise salvage one call from a rejected batch.
  const raw = result.raw || { qwenToolNormalization: { originalContent: result.content, originalFinishReason: result.finishReason } };
  return calls
    ? { ...result, content: '', toolCalls: calls, finishReason: 'tool_calls', raw }
    : { ...result, content: INVALID_QWEN_TOOL_RESPONSE, raw };
}

export async function* normalizeDemonRouteQwenStream(config, options, stream) {
  if (!offeredNames(config, options)) { yield* stream; return; }
  let content = '';
  let buffered = [];
  let nativeCalls = false;
  let tooLarge = false;
  let oversizedCandidate = false;
  let suffix = '';
  const raw = finishReason => ({ qwenToolNormalization: { originalContent: content, originalFinishReason: finishReason, ...(tooLarge ? { truncated: true } : {}) } });
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text' && !nativeCalls) {
        const delta = String(chunk.content || '');
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
        const calls = candidate && !tooLarge && chunk.finishReason === 'stop'
          ? parseDemonRouteQwenToolCalls(config, options, content)
          : null;
        if (calls) yield { type: 'tool_call', content: calls.map((call, index) => ({ ...call, index })) };
        else if (candidate) yield { type: 'text', content: INVALID_QWEN_TOOL_RESPONSE };
        else for (const text of buffered) yield text;
        yield candidate ? { ...chunk, ...(calls ? { finishReason: 'tool_calls' } : {}), raw: chunk.raw || raw(chunk.finishReason) } : chunk;
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
