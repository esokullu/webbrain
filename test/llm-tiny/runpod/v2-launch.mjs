#!/usr/bin/env node
// Deployment-side pilot launcher. The frozen v2 suite is not modified.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { main } from '../../llm-tiny-v2/run.mjs';
import { verifyManifest } from '../../llm-tiny-v2/lib/manifest.mjs';

const dir = new URL('../results/2026-09-13-six-model-matrix/', import.meta.url);
const budgetFile = new URL('.v2-budget.json', dir);
const handoffRequested = await access(new URL('../results/.v2-handoff-requested', import.meta.url))
  .then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
if (handoffRequested) throw new Error('Local v2 launches are paused for the requested single-owner cloud handoff.');
const state = JSON.parse(await readFile(new URL('.runpod-state.json', dir), 'utf8'));
const [name] = process.argv.slice(2);
const catalog = {
  'browser-use': ['browser-use', 'browser-use/bu-30b-a3b-preview'],
  deepseek: ['openai', 'deepseek/deepseek-v4.1-flash'],
  'fara-4b': ['fara', 'microsoft/Fara1.5-4B'],
  'fara-9b': ['fara', 'microsoft/Fara1.5-9B'],
  'fara-27b': ['fara', 'microsoft/Fara1.5-27B'],
  compass: ['compass', 'webbrain-one/webbrain-compass-tiny-v2'],
};
if (!catalog[name] || process.argv.length !== 3) throw new Error('Select exactly one of the six pilot participants; held-out launch is intentionally gated.');
const [adapter, model] = catalog[name];
const manifestHash = await verifyManifest();
if (manifestHash !== '60e52b1361d2f93d5cffa0b6805b06c2fbe45c9e64fca27c6431c29e536f293d') throw new Error('Manifest changed since pilot approval');
await access(new URL('../results/.v1-launch-disabled', import.meta.url));
const tag = `2026-09-13-v2-pilot-${name}`;
const resultDir = new URL(`../../llm-tiny-v2/results/${tag}/`, import.meta.url);
// An existing directory must be inspected, never silently rerun or overwritten.
if (await access(resultDir).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error(`Existing results: inspect/reuse ${tag} rather than rerun`);
const pod = [...state.pods].reverse().find(p => !p.deletedAt);
if (adapter !== 'openai' && (!pod || pod.deadline * 1000 - Date.now() < 30 * 60000)) throw new Error('Insufficient protected Pod lifetime to start a pilot');
const upstream = adapter === 'openai' ? 'https://openrouter.ai/api/v1' : `https://${pod.id}-8000.proxy.runpod.net/v1`;
if (adapter !== 'openai') {
  const r = await fetch(`https://${pod.id}-8001.proxy.runpod.net/status`, { headers: { Authorization: `Bearer ${pod.token}` }, signal: AbortSignal.timeout(15000) });
  const health = await r.json();
  if (!r.ok || !health.ready || health.model !== model || health.deadline !== pod.deadline) throw new Error('Ready model or unchanged expiry not verified');
  process.env.TINY_V2_INFERENCE_KEY = pod.token;
} else if (!process.env.OPENROUTER_API_KEY) throw new Error('Missing OpenRouter key');
let budget;
try { budget = JSON.parse(await readFile(budgetFile, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; budget = { capUsd: 30, apiLimitUsd: 2, apiChargedOrReservedUsd: 0.029319759, cleanupReserveUsd: 2, futureComputeReserveUsd: 14.67, requests: [] }; }
const reservedCompute = state.pods.reduce((sum, p) => sum + ((p.deletedAt || p.deadline * 1000) - p.createdAt) / 3600000 * p.budgetRate, 0);
if (reservedCompute + budget.futureComputeReserveUsd + budget.apiLimitUsd + budget.cleanupReserveUsd > budget.capUsd) throw new Error('Original total budget reservation is insufficient');
const saveBudget = () => writeFile(budgetFile, JSON.stringify(budget, null, 2) + '\n', { mode: 0o600 });
await saveBudget();
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== `${upstream}/chat/completions`) return nativeFetch(url, options);
  if (adapter !== 'openai' && Date.now() >= (pod.deadline - 120) * 1000) throw new Error('Protected Pod cleanup boundary reached; no new request launched');
  const body = JSON.parse(options.body);
  if (body.model !== model || body.max_tokens !== 4096) throw new Error('Unexpected model or frozen output limit');
  // Bound each OpenRouter request by the full supported context, not an optimistic
  // token estimate. Provider routing caps prices; uncertain charges retain reserve.
  const bound = adapter === 'openai' ? (1048576 * 0.30 + 4096 * 1.20) / 1e6 : 0;
  if (budget.apiChargedOrReservedUsd + bound > budget.apiLimitUsd) throw new Error('Original shared API allowance exhausted; no request launched');
  const entry = { participant: name, at: new Date().toISOString(), reservedUsd: bound };
  budget.apiChargedOrReservedUsd += bound;
  budget.requests.push(entry);
  await saveBudget(); // Reserve durably before dispatch; never retry invisibly.
  const response = await nativeFetch(url, options);
  if (adapter === 'openai' && response.ok) {
    const data = await response.clone().json();
    if (typeof data.usage?.cost === 'number' && data.usage.cost >= 0) {
      entry.chargedUsd = data.usage.cost;
      budget.apiChargedOrReservedUsd += data.usage.cost - bound;
      if (data.usage.cost > bound) throw new Error('Provider charge exceeded reserved maximum');
    }
  }
  if (!response.ok) entry.endpointError = (await response.clone().text()).replaceAll(process.env.OPENROUTER_API_KEY || '\0', '[redacted]').replaceAll(pod?.token || '\0', '[redacted]').slice(0, 3000);
  entry.status = response.status;
  await saveBudget();
  return response;
};
const config = { participants: [{ name, adapter, model, base: upstream, apiKeyEnv: adapter === 'openai' ? 'OPENROUTER_API_KEY' : 'TINY_V2_INFERENCE_KEY', ...(adapter === 'openai' ? { extraBody: { provider: { max_price: { prompt: 0.30, completion: 1.20, image: 0, request: 0 } } } } : {}) }] };
const configFile = new URL(`.v2-${name}.json`, dir);
await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ phase: 'v2-pilot', participant: name, episodes: 10, seed: 17, manifestHash, reservedExistingComputeUsd: reservedCompute, futureComputeReserveUsd: budget.futureComputeReserveUsd, apiLimitUsd: budget.apiLimitUsd, cleanupReserveUsd: budget.cleanupReserveUsd, ...(pod ? { podDeadline: new Date(pod.deadline * 1000).toISOString() } : {}) }));
await main(['--allow-paid', '--config', configFile.pathname, '--split', 'pilot', '--seeds', '17', '--tag', tag]);
await writeFile(new URL('hosting.json', resultDir), JSON.stringify({ model, revision: state.models[model] || null, provider: adapter === 'openai' ? 'OpenRouter' : 'RunPod', ...(adapter !== 'openai' ? { podId: pod.id, gpuCount: pod.gpus, gpuType: pod.gpuType, maxModelLength: 16384, dtype: 'bfloat16', eager: true, maxConcurrentSequences: 1, podDeadline: pod.deadline, quotedHourlyRateUsd: pod.quotedRate, budgetHourlyRateUsd: pod.budgetRate } : { priceCeilingPerMillionTokens: { prompt: 0.30, completion: 1.20 } }) }, null, 2) + '\n');
