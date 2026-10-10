import { AGENT_TOOL_NAMES } from '../agent/tools.js';
import { parseToolCallsFromText } from '../agent/tool-call-parser.js';
import { validateToolArguments } from '../agent/tool-arguments.js';

const MAX_TOOL_TEXT_CHARS = 32768;
export const INVALID_DOLPHIN_TOOL_RESPONSE = 'The model returned an invalid or unavailable text tool call. No browser action was dispatched. Use only the currently offered tool schemas and emit a complete tool-call response.';

function offeredNames(options) {
  const names = new Set((options.tools || []).map(tool => tool.function?.name || tool.name).filter(Boolean));
  const choice = options.toolChoice;
  if (choice === 'none') return new Set();
  const name = choice && typeof choice === 'object' ? choice.function?.name || choice.name : null;
  return name ? new Set(names.has(name) ? [name] : []) : names;
}

function canonicalCall(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let fn = value;
  if (value.function && Object.keys(value).every(key => ['id', 'type', 'function'].includes(key)) && (!value.type || value.type === 'function')) fn = value.function;
  if (!fn || typeof fn !== 'object' || Object.keys(fn).length !== 2 || !names.has(fn.name)) return null;
  let args = fn.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { id: 'call_' + crypto.randomUUID().replaceAll('-', ''), type: 'function', function: { name: fn.name, arguments: JSON.stringify(args) } };
}

function textCalls(text, names) {
  if (text.length > MAX_TOOL_TEXT_CHARS) return null;
  const source = text.trim().replace(/^```(?:json|xml)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
  // Accept a complete JSON envelope, never scan an actionable-looking subset
  // out of prose, malformed batches, or unrelated objects.
  if (/^[{\[]/.test(source)) {
    let value;
    try { value = JSON.parse(source); } catch { return null; }
    const batch = Array.isArray(value) ? value
      : value && Object.keys(value).length === 1 && Array.isArray(value.tool_calls) ? value.tool_calls : [value];
    if (!batch.length || batch.length > 16) return null;
    const calls = batch.map(item => canonicalCall(item, names));
    return calls.every(Boolean) ? calls : null;
  }
  const calls = [];
  let end = 0;
  for (const match of source.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    if (source.slice(end, match.index).trim() || calls.length >= 16) return null;
    let value;
    try { value = JSON.parse(match[1]); } catch { return null; }
    const call = canonicalCall(value, names);
    if (!call) return null;
    calls.push(call);
    end = match.index + match[0].length;
  }
  return calls.length && !source.slice(end).trim() ? calls : null;
}

export function normalizeDolphinPromptedResult(options, result) {
  const names = offeredNames(options);
  const native = result.toolCalls;
  const candidate = typeof result.content === 'string'
    && (/<tool_call\b|<functioncall\b/.test(result.content)
      || /"tool_calls"\s*:/.test(result.content)
      || (/"(?:name|function)"\s*:/.test(result.content) && /"arguments"\s*:/.test(result.content))
      || parseToolCallsFromText(result.content, AGENT_TOOL_NAMES).length > 0);
  if (!candidate && !native?.length) return result;
  let calls = result.finishReason === 'stop' || result.finishReason === 'tool_calls'
    ? native?.length ? native.every(call => names.has(call.function?.name)) ? native : null
      : textCalls(result.content, names)
    : null;
  if (calls && !calls.every(call => {
    const tool = (options.tools || []).find(tool => (tool.function?.name || tool.name) === call.function?.name);
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { return false; }
    return !!tool && validateToolArguments(call.function.name, args, tool.function?.parameters || tool.parameters || {}).ok;
  })) calls = null;
  return calls ? { ...result, content: '', toolCalls: calls, finishReason: 'tool_calls' }
    : { ...result, content: INVALID_DOLPHIN_TOOL_RESPONSE, toolCalls: [], rejectedToolResponse: { provider: 'openrouter_dolphin_venice', reason: 'invalid_or_unavailable_tool', offeredTools: names.size } };
}

export async function* normalizeDolphinPromptedStream(options, stream) {
  let content = '', tooLarge = false;
  const toolCalls = [];
  for await (const chunk of stream) {
    if (chunk.type === 'text') {
      const delta = String(chunk.content || '');
      tooLarge ||= content.length + delta.length > MAX_TOOL_TEXT_CHARS;
      content += delta.slice(0, Math.max(0, MAX_TOOL_TEXT_CHARS - content.length));
    } else if (chunk.type === 'tool_call') toolCalls.push(...(chunk.content || []));
    else if (chunk.type === 'tool_call_start' || chunk.type === 'tool_call_delta') {
      // The route has no native tool channel; only completed calls are usable.
    } else if (chunk.type === 'done') {
      const result = tooLarge ? { content: INVALID_DOLPHIN_TOOL_RESPONSE, toolCalls: [] }
        : normalizeDolphinPromptedResult(options, { content, toolCalls, finishReason: chunk.finishReason });
      if (result.content) yield { type: 'text', content: result.content };
      if (result.toolCalls?.length) yield { type: 'tool_call', content: result.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { ...chunk, ...(result.finishReason ? { finishReason: result.finishReason } : {}), ...(result.rejectedToolResponse ? { rejectedToolResponse: result.rejectedToolResponse } : {}) };
      return;
    } else yield chunk;
  }
  // An unterminated stream must never release a potentially executable prefix.
  throw new Error('Dolphin Venice stream ended before its completion event.');
}
