#!/usr/bin/env node
/**
 * End-to-end local browser benchmark for the small, browser-specialized model
 * allow-list in models.mjs.  Each adapter preserves its model's action format;
 * do not use this runner as a generic model benchmark.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CASES, getCase, renderFixture } from './cases.mjs';
import {
  ADAPTER_METADATA,
  chatCompletionsUrl,
  createParticipant,
  makeInitialMessages,
  makeNextObservation,
  parseAdapterResponse,
  parseAdapterActions,
  requestForTurn,
  trimScreenshotHistory,
  normalizeComputerKey,
} from './lib/adapters.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_ROOT = join(HERE, 'results');
const VIEWPORT = { width: 1440, height: 900 };
const FARA_DISPLAY_SIZE = 1000;

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; index += 1; }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage:
  node test/llm-tiny/run.mjs --adapter compass --base http://127.0.0.1:8000/v1
  node test/llm-tiny/run.mjs --adapter fara --model microsoft/Fara1.5-9B --base http://127.0.0.1:8001/v1
  node test/llm-tiny/run.mjs --adapter openai --model anthropic/claude-sonnet-4-6 --base https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY
  node test/llm-tiny/run.mjs --config test/llm-tiny/participants.example.json

Participants:
  --adapter openai|compass|browser-use|fara
  --model NAME                 Required for OpenAI and Fara. Other adapters have fixed models.
  --base URL                   OpenAI-compatible base URL or full chat-completions URL.
  --api-key-env ENV_NAME       Read the bearer token from ENV_NAME (preferred).
  --api-key TOKEN              Bearer token (avoid putting tokens in shell history).
  --name LABEL                 Result directory label.
  --config PATH                JSON { participants: [...] }; runs all listed participants.

Selection and run controls:
  --only IDS                   Comma-separated fixture ids, e.g. 01,09,27
  --max-steps N                Per-task agent-turn limit (default 12).
  --timeout MS                 Per-request timeout (default 90000).
  --tag NAME                   Result directory tag (default current timestamp).
  --no-screenshot              OpenAI/browser-use adapter only; use only for a text-only baseline.

Adapters intentionally differ:
  compass       WebBrain accessibility text and native WebBrain functions.
  browser-use   Indexed Browser Use state plus screenshot and JSON actions.
  fara          Screenshot-only CUA loop and Fara XML computer_use actions.
  openai        Regular OpenAI-compatible benchmark endpoint with function tools.

Only the five listed Hugging Face models may use the specialized adapters.
Results state their observation surface and action protocol so scores are not
mistaken for a controlled equivalence claim.
`);
}

function safeSegment(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'participant';
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const matched = url.pathname.match(/^\/case\/(\d{2})$/);
    const fixture = matched && getCase(matched[1]);
    if (!fixture) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unknown llm-tiny fixture');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    response.end(renderFixture(fixture));
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())),
  };
}

async function interactiveElements(page) {
  return page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const labelFor = element => {
      const aria = element.getAttribute('aria-label');
      if (aria) return aria.trim();
      if (element.labels?.length) return [...element.labels].map(label => label.innerText.trim()).filter(Boolean).join(' ');
      return (element.innerText || element.value || element.textContent || '').replace(/\s+/g, ' ').trim();
    };
    return [...document.querySelectorAll('button, input, select, textarea, [role="button"]')]
      .filter(visible)
      .map((element, index) => ({
        index: index + 1,
        refId: `ref_${index + 1}`,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        role: element.getAttribute('role') || (element.tagName === 'BUTTON' ? 'button' : element.tagName.toLowerCase()),
        label: labelFor(element),
        value: element.value || '',
        checked: element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : undefined,
        options: element instanceof HTMLSelectElement ? [...element.options].map(option => option.text) : undefined,
      }));
  });
}

function browserUseState(elements) {
  return elements.map(element => {
    const value = element.value ? ` value="${element.value}"` : '';
    const checked = element.checked === undefined ? '' : ` checked=${element.checked}`;
    const options = element.options?.length ? ` options=[${element.options.map(option => JSON.stringify(option)).join(', ')}]` : '';
    return `[${element.index}] <${element.tag}> ${element.role} "${element.label}"${value}${checked}${options}`;
  }).join('\n') || '(no visible interactive elements)';
}

function accessibilityTree(elements) {
  return elements.map(element => {
    const value = element.value ? ` value="${element.value}"` : '';
    const checked = element.checked === undefined ? '' : ` checked=${element.checked}`;
    const options = element.options?.length ? ` options=[${element.options.join(' | ')}]` : '';
    return `${element.role} "${element.label}" [${element.refId}]${value}${checked}${options}`;
  }).join('\n') || '(no visible interactive elements)';
}

async function observe(page, participant) {
  const elements = await interactiveElements(page);
  const status = await page.locator('#status').innerText();
  const screenshot = participant.noScreenshot || participant.adapter === 'compass'
    ? null
    : `data:image/png;base64,${(await page.screenshot({ type: 'png' })).toString('base64')}`;
  const withImage = text => screenshot
    ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: screenshot } }]
    : text;
  return { elements, browserUse: `${browserUseState(elements)}\nVisible status: ${status}`, accessibility: `${accessibilityTree(elements)}\nVisible status: ${status}`, withImage };
}

async function endpointRequest(participant, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), participant.timeoutMs);
  const startedAt = Date.now();
  try {
    const headers = { 'content-type': 'application/json' };
    if (participant.apiKey) headers.authorization = `Bearer ${participant.apiKey}`;
    const response = await fetch(chatCompletionsUrl(participant.base), {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`Endpoint returned non-JSON: ${text.slice(0, 500)}`); }
    return { response: parsed, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const detail = error?.name === 'AbortError' ? `timeout after ${participant.timeoutMs}ms` : error?.message || String(error);
    throw new Error(detail);
  } finally {
    clearTimeout(timer);
  }
}

function elementForIndex(observation, value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) throw new Error(`Invalid element index: ${value}`);
  const element = observation.elements.find(item => item.index === index);
  if (!element) throw new Error(`No current element at index ${index}`);
  return element;
}

function elementForRef(observation, refId) {
  const element = observation.elements.find(item => item.refId === String(refId));
  if (!element) throw new Error(`No current element at ref_id ${refId}`);
  return element;
}

async function performIndexedAction(page, observation, name, args = {}) {
  if (name === 'get_page_state' || name === 'get_accessibility_tree') return 'Read the current browser state.';
  if (name === 'done') return `Agent ended the task: ${args.summary || args.text || ''}`;
  if (name === 'scroll') {
    await page.mouse.wheel(0, Number(args.pixels) || 700);
    return 'Scrolled the page.';
  }
  if (name === 'click' || name === 'click_ax') {
    const element = name === 'click_ax' ? elementForRef(observation, args.ref_id) : elementForIndex(observation, args.index);
    await page.locator('button, input, select, textarea, [role="button"]').nth(element.index - 1).click();
    return `Clicked ${element.refId} (${element.label}).`;
  }
  if (name === 'input' || name === 'set_field' || name === 'type_ax') {
    const element = name === 'input' ? elementForIndex(observation, args.index) : elementForRef(observation, args.ref_id);
    await page.locator('button, input, select, textarea, [role="button"]').nth(element.index - 1).fill(String(args.text ?? ''));
    return `Set ${element.refId} (${element.label}).`;
  }
  if (name === 'select' || name === 'select_option') {
    const element = name === 'select' ? elementForIndex(observation, args.index) : elementForRef(observation, args.ref_id);
    await page.locator('button, input, select, textarea, [role="button"]').nth(element.index - 1).selectOption({ label: String(args.text) });
    return `Selected ${args.text} in ${element.refId} (${element.label}).`;
  }
  throw new Error(`Unsupported indexed action: ${name}`);
}

async function performBrowserUseAction(page, observation, action) {
  const name = action.name;
  const args = action.args || {};
  if (name === 'done') return `Agent ended the task: ${args.text || ''}`;
  if (name === 'click') return performIndexedAction(page, observation, 'click', args);
  if (name === 'input') return performIndexedAction(page, observation, 'input', args);
  if (name === 'select_dropdown') return performIndexedAction(page, observation, 'select', args);
  if (name === 'dropdown_options') return JSON.stringify(elementForIndex(observation, args.index).options || []);
  if (name === 'scroll') {
    await page.mouse.wheel(0, args.down === false ? -700 : 700);
    return 'Scrolled the page.';
  }
  if (name === 'send_keys') {
    await page.keyboard.press(normalizeComputerKey(args.keys || 'Enter', process.platform));
    return `Pressed ${args.keys}.`;
  }
  throw new Error(`Unsupported Browser Use action: ${name}`);
}

function faraCoordinate(coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every(Number.isFinite)) throw new Error('Fara click action needs [x, y] coordinates');
  return {
    x: coordinate[0] * VIEWPORT.width / FARA_DISPLAY_SIZE,
    y: coordinate[1] * VIEWPORT.height / FARA_DISPLAY_SIZE,
  };
}

function normalizeFaraKey(key) {
  return normalizeComputerKey(key);
}

async function performFaraAction(page, action) {
  const args = action.args || {};
  switch (args.action) {
    case 'mouse_move': {
      const point = faraCoordinate(args.coordinate);
      await page.mouse.move(point.x, point.y);
      return `Moved the cursor to (${Math.round(point.x)}, ${Math.round(point.y)}).`;
    }
    case 'left_click': {
      const point = faraCoordinate(args.coordinate);
      await page.mouse.click(point.x, point.y);
      return `Clicked at (${Math.round(point.x)}, ${Math.round(point.y)}).`;
    }
    case 'double_click': {
      const point = faraCoordinate(args.coordinate);
      await page.mouse.dblclick(point.x, point.y);
      return `Double-clicked at (${Math.round(point.x)}, ${Math.round(point.y)}).`;
    }
    case 'right_click': {
      const point = faraCoordinate(args.coordinate);
      await page.mouse.click(point.x, point.y, { button: 'right' });
      return `Right-clicked at (${Math.round(point.x)}, ${Math.round(point.y)}).`;
    }
    case 'triple_click': {
      const point = faraCoordinate(args.coordinate);
      await page.mouse.click(point.x, point.y, { clickCount: 3 });
      return `Triple-clicked at (${Math.round(point.x)}, ${Math.round(point.y)}).`;
    }
    case 'left_click_drag': {
      const point = faraCoordinate(args.coordinate);
      await page.mouse.down();
      await page.mouse.move(point.x, point.y);
      await page.mouse.up();
      return `Dragged to (${Math.round(point.x)}, ${Math.round(point.y)}).`;
    }
    case 'type':
      await page.keyboard.insertText(String(args.text || ''));
      return 'Typed text.';
    case 'key': {
      const keys = Array.isArray(args.keys) ? args.keys : [args.keys];
      await page.keyboard.press(normalizeComputerKey(keys.filter(Boolean).map(normalizeFaraKey).join('+'), process.platform));
      return `Pressed ${keys.join('+')}.`;
    }
    case 'scroll':
      await page.mouse.wheel(0, -(Number(args.pixels) || 0) * VIEWPORT.height / FARA_DISPLAY_SIZE);
      return 'Scrolled the page.';
    case 'hscroll':
      await page.mouse.wheel(-(Number(args.pixels) || 0) * VIEWPORT.width / FARA_DISPLAY_SIZE, 0);
      return 'Scrolled horizontally.';
    case 'visit_url':
      if (!String(args.url || '').startsWith('http://127.0.0.1:')) throw new Error('Fixture runner rejects navigation outside its local server');
      await page.goto(args.url, { waitUntil: 'domcontentloaded' });
      return `Visited ${args.url}.`;
    case 'history_back':
      await page.goBack({ waitUntil: 'domcontentloaded' });
      return 'Returned to the previous page.';
    case 'pause_and_memorize_fact': return `Remembered: ${args.fact || ''}`;
    case 'wait':
      await page.waitForTimeout(Math.min(Math.max(Number(args.time) || 0, 0), 5) * 1000);
      return 'Waited.';
    case 'terminate': return `Agent ended the task: ${args.answer || action.thoughts || ''}`;
    case 'ask_user_question': return `Agent asked the user: ${args.question || ''}`;
    default: throw new Error(`Unsupported Fara action: ${args.action || '(missing action)'}`);
  }
}

function appendAssistantAndObservation(messages, participant, message, actions, actionResults, observation) {
  const actionResult = actionResults.join('\n');
  if (participant.adapter === 'fara' || participant.adapter === 'browser-use') {
    messages.push({ role: 'assistant', content: message.content || '' });
    messages.push({ role: 'user', content: makeNextObservation(participant, observation, actionResult) });
    return;
  }
  if (message.tool_calls?.[0]) {
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
    const stateText = participant.adapter === 'compass' ? observation.accessibility : observation.browserUse;
    for (let i = 0; i < message.tool_calls.length; i += 1) messages.push({
      role: 'tool', tool_call_id: actions[i].id || message.tool_calls[i].id,
      content: `${actionResults[i]}${i === message.tool_calls.length - 1 ? `\n\nCurrent browser state:\n${stateText}` : ''}`,
    });
    if (participant.adapter === 'openai' && !participant.noScreenshot) messages.push({ role: 'user', content: observation.withImage('Current browser screenshot after the actions.') });
  } else {
    messages.push({ role: 'assistant', content: message.content || '' });
    messages.push({ role: 'user', content: makeNextObservation(participant, observation, actionResult) });
  }
}

async function fixtureCompleted(page) {
  return page.evaluate(() => window.__llmTinyFixture?.state?.complete === true);
}

async function runCase(browser, baseUrl, participant, caseRecord, participantDir) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(5000);
  const trace = [];
  const tokenUsage = { prompt: 0, completion: 0, total: 0, costUsd: 0 };
  const startedAt = Date.now();
  try {
    await page.goto(`${baseUrl}/case/${caseRecord.id}`, { waitUntil: 'networkidle' });
    let observation = await observe(page, participant);
    const messages = makeInitialMessages(participant, caseRecord.task, observation);
    let status = 'max_steps';
    let error = null;
    turns: for (let step = 1; step <= participant.maxSteps; step += 1) {
      await page.screenshot({ path: join(participantDir, `${caseRecord.id}-step-${step}.png`) });
      if (['fara', 'browser-use'].includes(participant.adapter)) trimScreenshotHistory(messages, 3);
      const body = requestForTurn(participant, messages);
      let response, latencyMs;
      try { ({ response, latencyMs } = await endpointRequest(participant, body)); }
      catch (requestError) {
        status = 'endpoint_error';
        error = requestError.message;
        trace.push({ step, error });
        break;
      }
      const message = response?.choices?.[0]?.message || {};
      const usage = response?.usage || {};
      tokenUsage.prompt += Number(usage.prompt_tokens || 0);
      tokenUsage.completion += Number(usage.completion_tokens || 0);
      tokenUsage.total += Number(usage.total_tokens || 0);
      tokenUsage.costUsd += Number(usage.cost || 0);
      const actions = parseAdapterActions(participant.adapter, message);
      if (!actions.length) {
        status = 'unparseable';
        error = `No ${participant.adapter} action parsed from model response`;
        trace.push({ step, latencyMs, error, content: message.content || null });
        break;
      }
      const actionResults = [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
       const action = actions[actionIndex];
       try {
        const actionResult = participant.adapter === 'fara'
          ? await performFaraAction(page, action)
          : participant.adapter === 'browser-use'
            ? await performBrowserUseAction(page, observation, action)
            : await performIndexedAction(page, observation, action.name, action.args);
        actionResults.push(actionResult);
        trace.push({ step, actionIndex, latencyMs: actionIndex === 0 ? latencyMs : 0, action: { name: action.name, args: action.args }, actionResult, content: message.content || null });
        if (await fixtureCompleted(page)) { status = 'passed'; break turns; }
        if ((participant.adapter === 'fara' && ['terminate', 'ask_user_question'].includes(action.args?.action)) || ['done'].includes(action.name)) {
          status = 'ended_without_success';
          break turns;
        }
        observation = await observe(page, participant);
      } catch (actionError) {
        status = 'action_error';
        error = actionError?.message || String(actionError);
        trace.push({ step, latencyMs, action: { name: action.name, args: action.args }, error, content: message.content || null });
        break turns;
      }
      }
      appendAssistantAndObservation(messages, participant, message, actions, actionResults, observation);
    }
    await page.screenshot({ path: join(participantDir, `${caseRecord.id}-final.png`) });
    return {
      id: caseRecord.id, task: caseRecord.task, kind: caseRecord.kind,
      success: status === 'passed', status, error,
      steps: trace.length, latencyMs: Date.now() - startedAt, tokenUsage, trace,
    };
  } finally {
    await page.close();
  }
}

async function runParticipant(browser, baseUrl, participant, selectedCases, runDir) {
  const participantDir = join(runDir, safeSegment(participant.name));
  await mkdir(participantDir, { recursive: true });
  const results = [];
  for (const caseRecord of selectedCases) {
    const result = await runCase(browser, baseUrl, participant, caseRecord, participantDir);
    results.push(result);
    await writeFile(join(participantDir, `${caseRecord.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    const label = result.success ? 'PASS' : `${result.status}${result.error ? `: ${result.error}` : ''}`;
    process.stderr.write(`[${participant.name}] ${caseRecord.id} ${label} (${result.steps} step${result.steps === 1 ? '' : 's'}, ${result.latencyMs}ms)\n`);
  }
  const latencies = results.map(result => result.latencyMs);
  const summary = {
    name: participant.name,
    model: participant.model,
    adapter: participant.adapter,
    endpoint: chatCompletionsUrl(participant.base),
    observation: ADAPTER_METADATA[participant.adapter].observation,
    protocol: ADAPTER_METADATA[participant.adapter].protocol,
    source: participant.catalog?.source || null,
    cases: results.length,
    passed: results.filter(result => result.success).length,
    failed: results.filter(result => !result.success).length,
    successRate: results.length ? results.filter(result => result.success).length / results.length : 0,
    medianCaseLatencyMs: percentile(latencies, 0.5),
    p95CaseLatencyMs: percentile(latencies, 0.95),
    totalTokens: results.reduce((total, result) => total + result.tokenUsage.total, 0),
    totalPromptTokens: results.reduce((total, result) => total + result.tokenUsage.prompt, 0),
    totalCompletionTokens: results.reduce((total, result) => total + result.tokenUsage.completion, 0),
    reportedApiCostUsd: results.reduce((total, result) => total + result.tokenUsage.costUsd, 0),
  };
  await writeFile(join(participantDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { ...summary, directory: participantDir };
}

function renderComparison(tag, summaries) {
  const rows = summaries.map(summary => `| ${summary.name} | ${summary.model} | ${summary.adapter} | ${summary.observation} | ${summary.protocol} | ${summary.passed}/${summary.cases} (${(summary.successRate * 100).toFixed(1)}%) | ${summary.medianCaseLatencyMs ?? '-'} | ${summary.totalTokens || '-'} |`).join('\n');
  return `# LLM tiny benchmark: ${tag}\n\n| Participant | Model | Adapter | Observation | Action protocol | Success | Median case latency (ms) | Tokens |\n|---|---|---|---|---|---:|---:|---:|\n${rows}\n\nThis is a deterministic local-fixture comparison, not a real-site or product-capability benchmark. The adapters intentionally preserve each model family's native action format and observation surface; scores are therefore comparable as harness runs, not proof of capability equivalence.\n`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { printHelp(); process.exit(0); }

// Run-specific migration lock: keep old results readable, but fail before any
// endpoint call while the authorized benchmark has moved to the frozen v2 suite.
const v1LaunchBlocked = await access(join(RESULTS_ROOT, '.v1-launch-disabled'))
  .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
if (v1LaunchBlocked) throw new Error('V1 launches are disabled for this run. Use test/llm-tiny-v2; preserve existing results and deployment safeguards.');

let participantInputs;
if (args.config && args.config !== true) {
  const configPath = resolve(String(args.config));
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!Array.isArray(config.participants) || !config.participants.length) throw new Error('--config must contain a non-empty participants array');
  participantInputs = config.participants;
} else {
  participantInputs = [{
    name: args.name && args.name !== true ? args.name : undefined,
    adapter: args.adapter,
    model: args.model && args.model !== true ? args.model : undefined,
    base: args.base && args.base !== true ? args.base : undefined,
    apiKey: args['api-key'] && args['api-key'] !== true ? args['api-key'] : undefined,
    apiKeyEnv: args['api-key-env'] && args['api-key-env'] !== true ? args['api-key-env'] : undefined,
    timeoutMs: args.timeout && args.timeout !== true ? args.timeout : undefined,
    maxSteps: args['max-steps'] && args['max-steps'] !== true ? args['max-steps'] : undefined,
    noScreenshot: !!args['no-screenshot'],
  }];
}
const participants = participantInputs.map(createParticipant);
const only = args.only && args.only !== true
  ? new Set(String(args.only).split(',').map(value => String(Number(value)).padStart(2, '0')))
  : null;
const selectedCases = CASES.filter(caseRecord => !only || only.has(caseRecord.id));
if (!selectedCases.length) throw new Error('No cases selected');
const tag = String(args.tag && args.tag !== true ? args.tag : new Date().toISOString().replace(/[:.]/g, '-'));
const runDir = join(RESULTS_ROOT, safeSegment(tag));
await mkdir(runDir, { recursive: true });

const fixture = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
  process.stderr.write(`Running ${selectedCases.length} deterministic local cases for ${participants.length} participant(s).\n`);
  const summaries = [];
  for (const participant of participants) summaries.push(await runParticipant(browser, fixture.baseUrl, participant, selectedCases, runDir));
  const comparison = { tag, createdAt: new Date().toISOString(), cases: selectedCases.map(item => item.id), participants: summaries };
  await writeFile(join(runDir, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(join(runDir, 'comparison.md'), renderComparison(tag, summaries));
  process.stderr.write(`\nResults: ${runDir}\n`);
} finally {
  await browser.close();
  await fixture.close();
}
