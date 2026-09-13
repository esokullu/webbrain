import { ADAPTER_MODELS, MODEL_CATALOG, catalogEntryForModel } from '../models.mjs';
import { readFileSync } from 'node:fs';

const faraReference = JSON.parse(readFileSync(new URL('./fara-reference.json', import.meta.url), 'utf8'));

const OPENAI_TOOLS = [
  ['get_page_state', 'Read the current indexed interactive elements before acting.', {}],
  ['click', 'Click an interactive element by its current index.', { index: { type: 'integer', minimum: 1 } }, ['index']],
  ['input', 'Replace the text in an input by its current index.', { index: { type: 'integer', minimum: 1 }, text: { type: 'string' } }, ['index', 'text']],
  ['select', 'Choose an exact option in a select by its current index.', { index: { type: 'integer', minimum: 1 }, text: { type: 'string' } }, ['index', 'text']],
  ['scroll', 'Scroll the page. Positive pixels scroll down.', { pixels: { type: 'number' } }, ['pixels']],
  ['done', 'Finish after verifying the requested UI change completed.', { summary: { type: 'string' } }, ['summary']],
].map(([name, description, properties, required = []]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }));

const COMPASS_TOOLS = [
  ['get_accessibility_tree', 'Read visible interactive elements. Each item has a stable ref_id for this page state.', {}],
  ['click_ax', 'Click a visible element by ref_id.', { ref_id: { type: 'string' } }, ['ref_id']],
  ['set_field', 'Replace text in an input by ref_id.', { ref_id: { type: 'string' }, text: { type: 'string' } }, ['ref_id', 'text']],
  ['select_option', 'Choose an exact option in a select by ref_id.', { ref_id: { type: 'string' }, text: { type: 'string' } }, ['ref_id', 'text']],
  ['scroll', 'Scroll the viewport.', { pixels: { type: 'number' } }, ['pixels']],
  ['done', 'Finish after verifying the requested UI change completed.', { summary: { type: 'string' } }, ['summary']],
].map(([name, description, properties, required = []]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }));

// Pinned Microsoft reference prompt and schema, with its 1000x1000 display space.
const FARA_SYSTEM = `${faraReference.FARA_QWEN35_IDENTITY}\n\n${faraReference.CRITICAL_POINTS_FARA_1_5}\n\n${faraReference.FN_CALL_FORMAT.replaceAll('{{', '{').replaceAll('}}', '}').replace('{tool_descs}', JSON.stringify({ name: 'computer_use', description: faraReference.description, parameters: faraReference.parameters }))}`;

const BROWSER_USE_SYSTEM = `You are a browser-use agent operating in flash mode. You automate browser tasks by outputting structured JSON actions. Respond with valid JSON: {"memory":"Brief evaluation of the previous step and the next goal","action":[{"action_name":{...params}}]}. Return one action per turn. Use only indexed elements from the current browser state. Available actions: click {"index":number}; input {"index":number,"text":string,"clear":true}; dropdown_options {"index":number}; select_dropdown {"index":number,"text":string}; send_keys {"keys":string}; scroll {"down":boolean,"pages":number}; done {"text":string,"success":boolean}. Only report data observed in browser state or tool outputs. Never fabricate values.`;

function xmlUnescape(value) {
  return String(value).replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function parseJsonCandidate(content) {
  if (typeof content !== 'string') return null;
  const candidates = [];
  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) candidates.push(match[1]);
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(trimmed);
  const object = trimmed.match(/(\{[\s\S]*\})\s*$/);
  if (object) candidates.push(object[1]);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function parseXmlFunction(content) {
  if (typeof content !== 'string') return null;
  const call = content.match(/<function\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/function>/i);
  if (!call) return null;
  const args = {};
  for (const param of call[2].matchAll(/<param\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/param>/gi)) {
    const raw = param[2].trim();
    const value = raw.startsWith('<![CDATA[') && raw.endsWith(']]>') ? raw.slice(9, -3) : xmlUnescape(raw);
    try { args[param[1]] = JSON.parse(value); } catch { args[param[1]] = value; }
  }
  return { name: call[1], args };
}

export function parseFaraAction(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  const parsed = parseJsonCandidate(match?.[1] || content);
  if (!parsed || parsed.name !== 'computer_use' || !parsed.arguments || typeof parsed.arguments.action !== 'string') return null;
  return { name: 'computer_use', args: parsed.arguments, thoughts: content.slice(0, match?.index || 0).trim() };
}

function parseBrowserUseAction(content) {
  const parsed = parseJsonCandidate(content);
  if (!parsed || !Array.isArray(parsed.action) || !parsed.action.length || typeof parsed.action[0] !== 'object') return null;
  const [name, args] = Object.entries(parsed.action[0])[0] || [];
  return name ? { name, args: args || {}, raw: parsed } : null;
}

function parseOpenAiToolCall(message) {
  const call = message?.tool_calls?.[0];
  if (!call?.function?.name) return null;
  let args = {};
  try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments || {}; } catch {}
  return { id: call.id || 'tool_call', name: call.function.name, args };
}

export function parseAdapterResponse(adapter, message) {
  const structured = parseOpenAiToolCall(message);
  if (adapter === 'fara') return parseFaraAction(message?.content) || structured;
  if (adapter === 'browser-use') return parseBrowserUseAction(message?.content) || structured;
  if (structured) return structured;
  const xml = parseXmlFunction(message?.content);
  if (xml) return xml;
  const json = parseJsonCandidate(message?.content);
  if (json?.name) return { name: json.name, args: json.arguments || json.args || {} };
  return null;
}

export function parseAdapterActions(adapter, message) {
  if (adapter === 'browser-use') {
    const parsed = parseJsonCandidate(message?.content);
    if (Array.isArray(parsed?.action)) return parsed.action.flatMap(item =>
      item && typeof item === 'object' ? Object.entries(item).map(([name, args]) => ({ name, args: args || {} })) : []);
  }
  if (message?.tool_calls?.length) return message.tool_calls.map(call => parseOpenAiToolCall({ tool_calls: [call] })).filter(Boolean);
  if (adapter === 'compass' && typeof message?.content === 'string') {
    const calls = [...message.content.matchAll(/<function\s+name=["'][^"']+["'][^>]*>[\s\S]*?<\/function>/gi)].map(match => parseXmlFunction(match[0])).filter(Boolean);
    if (calls.length) return calls;
  }
  const single = parseAdapterResponse(adapter, message);
  return single ? [single] : [];
}

export function createParticipant(input) {
  const adapter = String(input.adapter || '').trim().toLowerCase();
  if (!['openai', 'compass', 'browser-use', 'fara'].includes(adapter)) throw new Error(`Unknown adapter: ${adapter}`);
  const defaultModel = adapter === 'compass' ? MODEL_CATALOG.compass.model
    : adapter === 'browser-use' ? MODEL_CATALOG.browserUse.model : '';
  const model = String(input.model || defaultModel).trim();
  if (!model) throw new Error(`${adapter} requires a model`);
  if (adapter !== 'openai' && !ADAPTER_MODELS[adapter].has(model)) {
    throw new Error(`${model} is not in the test/llm-tiny-v2 ${adapter} allow-list`);
  }
  const base = String(input.base || '').trim();
  if (!base) throw new Error(`${input.name || model} requires base`);
  const apiKey = input.apiKey || (input.apiKeyEnv ? process.env[input.apiKeyEnv] : '') || '';
  return {
    name: input.name || model,
    adapter, model, base,
    apiKey,
    timeoutMs: Number(input.timeoutMs) || 90_000,
    maxSteps: Number(input.maxSteps) || 12,
    maxTokens: Number(input.maxTokens) || 4096,
    noScreenshot: !!input.noScreenshot,
    extraBody: input.extraBody && typeof input.extraBody === 'object' && !Array.isArray(input.extraBody) ? input.extraBody : {},
    catalog: catalogEntryForModel(model),
  };
}

export function chatCompletionsUrl(base) {
  const trimmed = String(base).replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return trimmed.endsWith('/v1') ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

export function makeInitialMessages(participant, task, observation) {
  if (participant.adapter === 'fara') return [
    { role: 'system', content: FARA_SYSTEM },
    { role: 'user', content: observation.withImage(`Task: ${task}\nHere is the current browser screenshot.`) },
  ];
  if (participant.adapter === 'browser-use') return [
    { role: 'system', content: BROWSER_USE_SYSTEM },
    { role: 'user', content: observation.withImage(`Task: ${task}\n\nCurrent browser state:\n${observation.browserUse}`) },
  ];
  if (participant.adapter === 'compass') return [
    { role: 'system', content: 'You are WebBrain running a local browser test. Use the available tools to complete the explicitly authorized task. Verify the visible status before calling done.' },
    { role: 'user', content: `Task: ${task}\n\nCurrent page accessibility tree:\n${observation.accessibility}` },
  ];
  return [
    { role: 'system', content: 'You are a browser agent on a local deterministic test page. Use the provided tools to complete the explicitly authorized task. Verify the visible status before calling done.' },
    { role: 'user', content: observation.withImage(`Task: ${task}\n\nCurrent indexed interactive elements:\n${observation.browserUse}`) },
  ];
}

export function makeNextObservation(participant, observation, actionResult) {
  const text = `Action result: ${actionResult}\n\nCurrent browser state:\n${participant.adapter === 'compass' ? observation.accessibility : observation.browserUse}`;
  return participant.adapter === 'fara'
    ? observation.withImage(`Action result: ${actionResult}\nHere is the next browser screenshot.`)
    : participant.adapter === 'compass' ? text : observation.withImage(text);
}

export function requestForTurn(participant, messages) {
  const body = {
    ...participant.extraBody,
    model: participant.model,
    temperature: participant.adapter === 'fara' ? 0 : participant.adapter === 'browser-use' ? 0.6 : 0.1,
    max_tokens: participant.maxTokens || 4096,
    messages,
  };
  // Native Fara/Browser Use schemas come from their system prompts, never from
  // arbitrary extraBody tools or a transport streaming override.
  delete body.tools;
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  body.stream = false;
  if (participant.adapter === 'browser-use') body.top_p = 0.95;
  if (participant.adapter === 'openai') body.tools = OPENAI_TOOLS;
  if (participant.adapter === 'compass') {
    body.tools = COMPASS_TOOLS;
    // Compass Tiny v2's native template explicitly asks callers to disable
    // thinking. vLLM forwards this object to compatible chat templates.
    body.chat_template_kwargs = { enable_thinking: false, ...(participant.extraBody.chat_template_kwargs || {}) };
  }
  return body;
}

export function trimScreenshotHistory(messages, keep = 3) {
  let remaining = keep;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!Array.isArray(messages[i].content)) continue;
    messages[i].content = messages[i].content.filter(part => part.type !== 'image_url' || remaining-- > 0);
  }
}

export function normalizeComputerKey(value, platform = '') {
  const aliases = { ctrl: 'Control', control: 'Control', return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', space: 'Space', spacebar: 'Space', tab: 'Tab', shift: 'Shift', alt: 'Alt', meta: 'Meta', cmd: 'Meta', super: 'Meta', backspace: 'Backspace', delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End' };
  const normalized = String(value).split('+').map(key => aliases[key.toLowerCase()] || key).join('+');
  return platform === 'darwin' && /^Control\+a$/i.test(normalized) ? 'Meta+a' : normalized;
}

export const ADAPTER_METADATA = Object.freeze({
  openai: { observation: 'Indexed DOM plus screenshot', protocol: 'OpenAI-compatible function tools' },
  compass: { observation: MODEL_CATALOG.compass.observation, protocol: MODEL_CATALOG.compass.protocol },
  'browser-use': { observation: MODEL_CATALOG.browserUse.observation, protocol: MODEL_CATALOG.browserUse.protocol },
  fara: { observation: 'Screenshot only', protocol: MODEL_CATALOG.fara9b.protocol },
});
