#!/usr/bin/env node
// Vision probe — send a single screenshot to any OpenAI-compatible chat
// endpoint using the EXACT system prompt, user text, and params our vision
// sub-call uses inside the extension. Useful for sanity-checking whether
// a local vision model (llama.cpp, Ollama, LM Studio, vLLM, etc.) is
// actually capable of the terse structured caption the planner needs.
//
// Usage:
//   node test/vision-probe.mjs <image-path> [endpoint] [model]
//
// Examples:
//   node test/vision-probe.mjs ./screenshot.png
//   node test/vision-probe.mjs ./screenshot.png http://127.0.0.1:8080 Gemma-4-E2B-It
//   node test/vision-probe.mjs ./screenshot.png http://localhost:11434/v1 llava:13b
//
// The endpoint may be given with or without /v1 — we append /v1/chat/completions
// if it isn't already there.
//
// No API key handling: this script is meant for local/offline servers. If
// your endpoint needs a bearer token, set VISION_PROBE_KEY in the env.

import fs from 'node:fs/promises';
import path from 'node:path';

// Keep these two constants in sync with src/chrome/src/agent/agent.js —
// the whole point of this probe is to mirror what the extension sends.
const VISION_SYSTEM_PROMPT = `You are the vision subsystem of a web-automation agent. A screenshot of the current browser viewport is attached. Describe what is on screen so the planning agent can decide its next action.

Format — keep it terse, structured, no flowery prose:

1) Page purpose: one line (e.g. "GitHub repo issue list", "Gmail compose", "Stripe checkout form").
2) Visible text: list the EXACT strings on buttons, links, headings, tabs, and menu items. Quote them verbatim. Do not paraphrase.
3) Inputs: list each visible form field with its label, placeholder, current value, and whether it is focused/disabled.
4) State signals: loading spinners, toasts, modals, error banners, success messages, CAPTCHAs, cookie/consent banners, overlays.
5) Blockers: anything that would prevent the next likely action (overlay, disabled submit, missing data, auth prompt).
6) Unknowns: if you cannot read something clearly, say so. Do not guess numbers, names, or identifiers.

Rules: no prose intro, no conclusion, no "this screenshot shows...", no layout description unless it matters (e.g. "left nav is collapsed"). If the page is blank or still loading, say that in one line and stop.`;

const USER_TEXT = 'Describe this screenshot of the current browser viewport for a web-automation agent. Follow the format in the system prompt.';

function usage() {
  console.error(`usage: node test/vision-probe.mjs <image-path> [endpoint] [model]

Defaults:
  endpoint = http://127.0.0.1:8080
  model    = (omitted — the server decides)
`);
  process.exit(2);
}

const [, , imgArg, endpointArg, modelArg] = process.argv;
if (!imgArg) usage();

const imgPath = path.resolve(imgArg);
let endpoint = endpointArg || 'http://127.0.0.1:8080';
if (!endpoint.includes('/chat/completions')) {
  endpoint = endpoint.replace(/\/+$/, '');
  if (!/\/v\d/.test(endpoint)) endpoint += '/v1';
  endpoint += '/chat/completions';
}

let bytes;
try {
  bytes = await fs.readFile(imgPath);
} catch (e) {
  console.error(`[error] cannot read image: ${imgPath} (${e.message})`);
  process.exit(1);
}
const ext = path.extname(imgPath).slice(1).toLowerCase();
const mime = ext === 'jpg' ? 'image/jpeg' : ext ? `image/${ext}` : 'image/png';
const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
console.error(`[info] image:    ${imgPath}`);
console.error(`[info] size:     ${bytes.length} bytes  mime: ${mime}`);
console.error(`[info] endpoint: ${endpoint}`);
if (modelArg) console.error(`[info] model:    ${modelArg}`);

const body = {
  messages: [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: USER_TEXT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ],
  temperature: 0,
  max_tokens: 800,
  stream: false,
  // Qwen3/3.5-style servers: suppress chain-of-thought preambles. Harmless
  // on servers that ignore unknown fields.
  chat_template_kwargs: { enable_thinking: false },
};
if (modelArg) body.model = modelArg;

const headers = { 'Content-Type': 'application/json' };
if (process.env.VISION_PROBE_KEY) {
  headers['Authorization'] = `Bearer ${process.env.VISION_PROBE_KEY}`;
}

const t0 = Date.now();
let res;
try {
  res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
} catch (e) {
  console.error(`[error] network: ${e.message}`);
  process.exit(1);
}
const dt = Date.now() - t0;
console.error(`[info] status ${res.status}  ${dt} ms`);

const txt = await res.text();
if (!res.ok) {
  console.error('[error] response body:');
  console.error(txt.slice(0, 4000));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(txt);
} catch {
  console.error('[error] non-JSON response:');
  console.error(txt.slice(0, 4000));
  process.exit(1);
}

const content = data?.choices?.[0]?.message?.content || '';
const usage2 = data?.usage || {};
console.error(`[info] usage: ${JSON.stringify(usage2)}`);
console.log('\n========== MODEL RESPONSE ==========');
console.log(content);
console.log('====================================\n');
