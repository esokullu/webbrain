#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import { PRODUCTION_USER_TEXT, REQUEST_DEFAULTS, VISION_SYSTEM_PROMPT, userTextForCase } from './prompt.mjs';
import { scoreVisionResponse } from './lib/score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const Q_DIR = join(HERE, 'questions');
const E_DIR = join(HERE, 'expected');
const RESULTS_DIR = join(HERE, 'results');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { out.help = true; continue; }
    if (!arg.startsWith('--')) continue;
    const [inlineKey, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue != null) { out[inlineKey] = inlineValue; continue; }
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[inlineKey] = true;
    else { out[inlineKey] = next; i += 1; }
  }
  return out;
}

function help() {
  console.log(`Usage: node test/vision/run.mjs [options]

Endpoint:
  --base URL                 OpenAI-compatible base URL (default: http://127.0.0.1:8080)
  --url URL                  Full /v1/chat/completions URL
  --model NAME               Model name; omitted only when the server can choose
  --api-key KEY              Bearer/API key (prefer VISION_PROBE_KEY env)
  --auth-scheme SCHEME       Bearer or Api-Key (default: Bearer)

Selection:
  --only 1,5,42              Run selected case ids
  --difficulty 1|2|3|4|5    Run one difficulty band
  --category NAME            Run one category slug

Run:
  --prompt-mode production|question  Production uses WebBrain's exact fixed user text (default)
  --concurrency N            Parallel requests (default: 2)
  --timeout MS               Inactivity timeout per request (default: 300000; 0 disables)
  --tag NAME                 Results tag (default: timestamp)
  --resume                   Skip completed case files in the selected run dir
  --fold-system              Fold system prompt into user content

Environment:
  VISION_PROBE_KEY, VISION_PROBE_AUTH_SCHEME, VISION_PROBE_FOLD_SYSTEM

Examples:
  node test/vision/run.mjs --model Gemma-4-E2B-It
  node test/vision/run.mjs --base http://127.0.0.1:1234/v1 --model molmo2-8b --only 1,41,81
  VISION_PROBE_KEY=... node test/vision/run.mjs --base https://openrouter.ai/api/v1 --model openai/gpt-4o
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { help(); process.exit(0); }
const base = args.base || 'http://127.0.0.1:8080';
const endpoint = args.url || `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
const model = args.model && args.model !== true ? String(args.model) : '';
const apiKey = args['api-key'] || process.env.VISION_PROBE_KEY || '';
const authScheme = args['auth-scheme'] || process.env.VISION_PROBE_AUTH_SCHEME || 'Bearer';
const concurrency = Math.max(1, Number.parseInt(args.concurrency || '2', 10));
const timeoutMs = Math.max(0, Number.parseInt(args.timeout || '300000', 10));
const promptMode = args['prompt-mode'] || 'production';
if (!['production', 'question'].includes(promptMode)) throw new Error(`Invalid --prompt-mode: ${promptMode}`);
const foldSystem = !!args['fold-system'] || (process.env.VISION_PROBE_FOLD_SYSTEM ? process.env.VISION_PROBE_FOLD_SYSTEM !== '0' : /molmo/i.test(model));
const tag = String(args.tag || new Date().toISOString().replace(/[:.]/g, '-')).replace(/[^\w.-]+/g, '_');
const modelTag = (model || 'server-default').replace(/[^\w.-]+/g, '_');
const runDir = join(RESULTS_DIR, `${tag}_${modelTag}_${promptMode}`);
await mkdir(runDir, { recursive: true });

const only = args.only && args.only !== true ? new Set(String(args.only).split(',').map(v => String(parseInt(v, 10)).padStart(3, '0'))) : null;
const ids = (await readdir(Q_DIR)).filter(name => /^\d{3}\.json$/.test(name)).map(name => name.slice(0, 3)).sort();
const cases = [];
for (const id of ids) {
  const question = JSON.parse(await readFile(join(Q_DIR, `${id}.json`), 'utf8'));
  if (only && !only.has(id)) continue;
  if (args.difficulty && Number(question.difficulty.level) !== Number(args.difficulty)) continue;
  if (args.category && question.category !== args.category) continue;
  if (args.resume) {
    try {
      const previous = JSON.parse(await readFile(join(runDir, `${id}.json`), 'utf8'));
      if (!previous.error) continue;
    } catch {}
  }
  const expected = JSON.parse(await readFile(join(E_DIR, `${id}.json`), 'utf8'));
  cases.push({ id, question, expected });
}

function contentType(path) {
  return path.endsWith('.jpg') || path.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
}

function buildBody(question, imageDataUrl) {
  const userText = userTextForCase(question.question, promptMode);
  const content = [
    { type: 'text', text: foldSystem ? `${VISION_SYSTEM_PROMPT}\n\nUser request:\n${userText}` : userText },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
  const body = {
    messages: foldSystem ? [{ role: 'user', content }] : [{ role: 'system', content: VISION_SYSTEM_PROMPT }, { role: 'user', content }],
    temperature: REQUEST_DEFAULTS.temperature,
    max_tokens: REQUEST_DEFAULTS.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: REQUEST_DEFAULTS.chatTemplateKwargs,
  };
  if (model) body.model = model;
  return { body, userText };
}

async function requestVision(body) {
  const startedAt = Date.now();
  const url = new URL(endpoint);
  const transport = url.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
  if (apiKey) headers.Authorization = `${authScheme} ${apiKey}`;
  const req = transport.request({ method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, headers });
  if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
  req.write(payload);
  req.end();
  const res = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
  const headerMs = Date.now() - startedAt;
  let raw = '';
  for await (const chunk of res) raw += chunk.toString('utf8');
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`);
  let content = '';
  let reasoning = '';
  let usage = {};
  let timings = null;
  let provider = null;
  let finishReason = null;
  if (raw.includes('data: ')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.error) throw new Error(`Stream error: ${JSON.stringify(event.error)}`);
      provider = event.provider || provider;
      finishReason = event?.choices?.[0]?.finish_reason || finishReason;
      const delta = event?.choices?.[0]?.delta || {};
      content += delta.content || '';
      reasoning += delta.reasoning_content || '';
      if (event.usage) usage = event.usage;
      if (event?.choices?.[0]?.timings) timings = event.choices[0].timings;
    }
  } else {
    const json = JSON.parse(raw);
    if (json.error) throw new Error(`Response error: ${JSON.stringify(json.error)}`);
    provider = json.provider || null;
    finishReason = json?.choices?.[0]?.finish_reason || null;
    content = json?.choices?.[0]?.message?.content || '';
    reasoning = json?.choices?.[0]?.message?.reasoning_content || '';
    usage = json?.usage || {};
    timings = json?.choices?.[0]?.timings || null;
  }
  return { content, reasoning, usage, timings, provider, finishReason, raw, latencyMs: { headers: headerMs, total: Date.now() - startedAt }, status: res.statusCode };
}

async function runCase(entry) {
  const started = Date.now();
  const imagePath = join(HERE, entry.question.image);
  try {
    const bytes = await readFile(imagePath);
    const dataUrl = `data:${contentType(imagePath)};base64,${bytes.toString('base64')}`;
    const { body, userText } = buildBody(entry.question, dataUrl);
    const response = await requestVision(body);
    const score = scoreVisionResponse({ content: response.content, expected: entry.expected });
    const result = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      id: entry.id,
      model: model || null,
      endpoint,
      promptMode,
      question: entry.question,
      image: { path: entry.question.image, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      request: { systemPrompt: VISION_SYSTEM_PROMPT, userText, foldSystem, temperature: body.temperature, maxTokens: body.max_tokens, chatTemplateKwargs: body.chat_template_kwargs },
      response: { status: response.status, content: response.content, reasoningChars: response.reasoning.length, usage: response.usage, timings: response.timings, provider: response.provider, finishReason: response.finishReason, raw: response.raw },
      latencyMs: response.latencyMs,
      score,
      error: null,
    };
    await writeFile(join(runDir, `${entry.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    const result = { schemaVersion: 1, createdAt: new Date().toISOString(), id: entry.id, model: model || null, endpoint, promptMode, question: entry.question, error: error.message, latencyMs: { total: Date.now() - started }, score: null };
    await writeFile(join(runDir, `${entry.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
}

console.error(`▸ ${cases.length} vision case(s), endpoint=${endpoint}, model=${model || '(server default)'}, concurrency=${concurrency}`);
console.error(`▸ prompt mode=${promptMode}, fold system=${foldSystem}, results=${runDir}`);
const queue = [...cases];
const results = [];
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
  while (queue.length) {
    const entry = queue.shift();
    const result = await runCase(entry);
    results.push(result);
    console.error(`${result.error ? '✗' : result.score.success ? '✓' : '·'} ${entry.id} ${result.error || `${(result.score.ratio * 100).toFixed(1)}%`}`);
  }
}));
results.sort((a, b) => a.id.localeCompare(b.id));

function aggregate(items) {
  const scored = items.filter(item => item.score);
  return {
    cases: items.length,
    scored: scored.length,
    errors: items.filter(item => item.error).length,
    successes: scored.filter(item => item.score.success).length,
    successRate: scored.length ? scored.filter(item => item.score.success).length / scored.length : 0,
    meanScore: scored.length ? scored.reduce((sum, item) => sum + item.score.ratio, 0) / scored.length : 0,
    meanLatencyMs: scored.length ? scored.reduce((sum, item) => sum + (item.latencyMs?.total || 0), 0) / scored.length : 0,
  };
}

const byDifficulty = {};
const byCategory = {};
for (const item of results) {
  (byDifficulty[item.question.difficulty.slug] ||= []).push(item);
  (byCategory[item.question.category] ||= []).push(item);
}
const summary = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  model: model || null,
  endpoint,
  promptMode,
  productionUserText: PRODUCTION_USER_TEXT,
  promptSha256: createHash('sha256').update(VISION_SYSTEM_PROMPT).digest('hex'),
  overall: aggregate(results),
  byDifficulty: Object.fromEntries(Object.entries(byDifficulty).map(([key, value]) => [key, aggregate(value)])),
  byCategory: Object.fromEntries(Object.entries(byCategory).map(([key, value]) => [key, aggregate(value)])),
};
await writeFile(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
