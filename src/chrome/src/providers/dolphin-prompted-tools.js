import { AGENT_TOOL_NAMES } from '../agent/tools.js';
import { parseToolCallsFromText } from '../agent/tool-call-parser.js';

const MAX_TOOL_TEXT_CHARS = 32768;
export const INVALID_DOLPHIN_TOOL_RESPONSE = 'The model returned an invalid or unavailable text tool call. No browser action was dispatched. Use only the currently offered tool schemas and emit a complete tool-call response.';

function offeredNames(options) {
  const names = new Set((options.tools || []).map(tool => tool.function?.name || tool.name).filter(Boolean));
  const choice = options.toolChoice;
  if (choice === 'none') return new Set();
  const name = choice && typeof choice === 'object' ? choice.function?.name || choice.name : null;
  return name ? new Set(names.has(name) ? [name] : []) : names;
}

function textCalls(text, names) {
  if (text.length > MAX_TOOL_TEXT_CHARS) return null;
  const source = text.trim().replace(/^```(?:json|xml)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
  const calls = [];
  let end = 0;
  for (const match of source.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    if (source.slice(end, match.index).trim() || calls.length >= 16) return null;
    let value;
    try { value = JSON.parse(match[1]); } catch { return null; }
    if (!value || Object.keys(value).length !== 2 || !names.has(value.name)
      || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) return null;
    // Execution still validates the offered schema and every permission.
    calls.push({ id: 'call_' + crypto.randomUUID().replaceAll('-', ''), type: 'function', function: { name: value.name, arguments: JSON.stringify(value.arguments) } });
    end = match.index + match[0].length;
  }
  return calls.length && !source.slice(end).trim() ? calls : null;
}

export function normalizeDolphinPromptedResult(options, result) {
  const names = offeredNames(options);
  const native = result.toolCalls;
  const candidate = typeof result.content === 'string'
    && (/<tool_call\b|<functioncall\b/.test(result.content)
      || parseToolCallsFromText(result.content, AGENT_TOOL_NAMES).length > 0);
  if (!candidate && !native?.length) return result;
  const calls = result.finishReason === 'stop' || result.finishReason === 'tool_calls'
    ? native?.length ? native.every(call => names.has(call.function?.name)) ? native : null
      : textCalls(result.content, names)
    : null;
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
