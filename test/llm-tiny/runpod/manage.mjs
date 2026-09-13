#!/usr/bin/env node
// Temporary deployment helper. Keys come from the environment; only the random
// per-Pod inference token is persisted (mode 0600, under ignored results/).
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RUN_DIR = join(ROOT, 'results', '2026-09-13-six-model-matrix');
const STATE = join(RUN_DIR, '.runpod-state.json');
const KEY = process.env.RUNPOD_BENCH_KEY;
const CAP = 30;
const MODEL_NAMES = ['webbrain-one/webbrain-compass-tiny-v2', 'microsoft/Fara1.5-4B', 'microsoft/Fara1.5-9B', 'browser-use/bu-30b-a3b-preview', 'microsoft/Fara1.5-27B'];

async function api(path, method = 'GET', body) {
  if (!KEY) throw new Error('RUNPOD_BENCH_KEY is required');
  const r = await fetch(`https://rest.runpod.io/v1${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (r.status === 404 && method === 'DELETE') return {};
  if (!r.ok) throw new Error(`RunPod ${method} ${path}: HTTP ${r.status} ${(await r.text()).slice(0,400).replaceAll(KEY, '[redacted]')}`);
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}
async function state() { try { return JSON.parse(await readFile(STATE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return { capUsd: CAP, pods: [], models: {} }; } }
async function save(s) { await mkdir(RUN_DIR, { recursive: true }); await writeFile(STATE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); }
const elapsedCost = p => (Math.max(0, (p.deletedAt || Date.now()) - p.createdAt) / 3600000) * p.budgetRate;
function safePod(p) { const { token, ...safe } = p; return { ...safe, estimatedCostUsd: elapsedCost(p) }; }
async function control(pod, path, data) {
  const r = await fetch(`https://${pod.id}-8001.proxy.runpod.net${path}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${pod.token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Pod controller HTTP ${r.status}`);
  return r.json();
}
async function remove(id) {
  let s = await state();
  const p = s.pods.find(x => x.id === id);
  if (!p) throw new Error('Refusing to delete a Pod outside this run');
  await api(`/pods/${id}`, 'DELETE');
  s = await state();
  const item = s.pods.find(x => x.id === id);
  item.deletedAt ||= Date.now();
  await save(s);
  console.log(JSON.stringify({ deleted: id, estimatedCostUsd: elapsedCost(item) }));
}

const [command, arg] = process.argv.slice(2);
// Fail closed after the requested handoff was blocked. Read-only inspection and
// cleanup remain available; this marker must never disable an existing guard.
if (['create', 'start', 'refresh', 'test'].includes(command)) {
  const paused = await access(join(ROOT, 'results', '.v2-handoff-requested'))
    .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (paused) throw new Error('Benchmark launches are fenced: autonomous handoff is not approved and protected shutdown is complete. Inspection and cleanup remain available.');
}
let s = await state();
if (command === 'inventory') {
  const pods = await api('/pods');
  console.log(JSON.stringify(pods.map(p => ({ id: p.id, name: p.name, desiredStatus: p.desiredStatus, costPerHr: p.costPerHr, gpuCount: p.gpuCount }))));
} else if (command === 'pin') {
  for (const name of MODEL_NAMES) {
    const r = await fetch(`https://huggingface.co/api/models/${name}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Cannot resolve ${name}: ${r.status}`);
    const model = await r.json();
    if (!/^[a-f0-9]{40}$/.test(model.sha)) throw new Error(`No immutable revision for ${name}`);
    s.models[name] = model.sha;
  }
  await save(s);
  await writeFile(join(RUN_DIR, 'model-revisions.json'), JSON.stringify(s.models, null, 2) + '\n');
  console.log(JSON.stringify(s.models));
} else if (command === 'create') {
  const gpus = Number(arg);
  if (![1, 2].includes(gpus) || Object.keys(s.models).length !== 5) throw new Error('Pin all models before creating 1 or 2 GPUs');
  if (s.pods.some(p => !p.deletedAt)) throw new Error('An existing run Pod must be cleaned up first');
  const seconds = 3 * 3600;
  const budgetRate = 1.59 * gpus + 0.06;
  const spent = s.pods.reduce((n, p) => n + elapsedCost(p), 0);
  if (spent + budgetRate * seconds / 3600 > CAP - 2) throw new Error('Deployment reservation would exceed the $28 compute/storage allowance');
  const token = randomBytes(24).toString('hex');
  const createdAt = Date.now();
  const deadline = Math.floor(createdAt / 1000) + seconds;
  const source = await readFile(join(HERE, 'controller.py'), 'utf8');
  const pod = await api('/pods', 'POST', {
    name: `llm-tiny-benchmark-${gpus}xa100`, cloudType: 'SECURE', computeType: 'GPU', gpuTypeIds: ['NVIDIA A100 80GB PCIe', 'NVIDIA A100-SXM4-80GB'], gpuCount: gpus,
    imageName: 'vllm/vllm-openai@sha256:89c1d0629d377daa3f7f369cbea6167a7b48ea89aaacd12555e2b0b2f7f740d3',
    containerDiskInGb: 160, volumeInGb: 0, ports: ['8000/http', '8001/http'], interruptible: false,
    dockerEntrypoint: ['python3', '-u', '-c'], dockerStartCmd: ['import base64,os;exec(compile(base64.b64decode(os.environ["TINY_BOOTSTRAP"]),"controller.py","exec"))'],
    env: { TINY_BOOTSTRAP: Buffer.from(source).toString('base64'), TINY_TOKEN: token, TINY_DEADLINE: String(deadline), TINY_RUNPOD_KEY: KEY, TINY_MODELS: JSON.stringify(s.models), TINY_GPUS: String(gpus), HF_HOME: '/tmp/huggingface', VLLM_NO_USAGE_STATS: '1', DO_NOT_TRACK: '1' },
  });
  const item = { id: pod.id, gpus, token, createdAt, deadline, budgetRate, quotedRate: pod.costPerHr, image: 'vllm/vllm-openai:v0.19.1', gpuType: pod.gpu?.id || pod.machine?.gpuTypeId || null };
  s.pods.push(item);
  await save(s);
  const guard = spawn(process.execPath, [fileURLToPath(import.meta.url), 'guard', pod.id], { detached: true, stdio: 'ignore', env: process.env });
  guard.unref();
  if (!Number.isFinite(Number(pod.costPerHr)) || Number(pod.costPerHr) <= 0 || Number(pod.costPerHr) > budgetRate) { await remove(pod.id); throw new Error('Actual price is missing or exceeds the reservation; Pod removed'); }
  console.log(JSON.stringify({ ...safePod(item), guardPid: guard.pid }));
} else if (command === 'guard') {
  const p = s.pods.find(x => x.id === arg);
  if (!p) throw new Error('Unknown Pod');
  while (Date.now() < p.deadline * 1000) {
    await new Promise(resolve => setTimeout(resolve, 15000));
    if ((await state()).pods.find(x => x.id === arg)?.deletedAt) process.exit(0);
  }
  for (;;) { try { await remove(arg); break; } catch { await new Promise(resolve => setTimeout(resolve, 15000)); } }
} else if (command === 'delete') {
  await remove(arg);
} else if (command === 'ledger') {
  console.log(JSON.stringify({ capUsd: CAP, estimatedRunpodUsd: s.pods.reduce((n, p) => n + elapsedCost(p), 0), pods: s.pods.map(safePod) }, null, 2));
} else {
  const p = [...s.pods].reverse().find(x => !x.deletedAt);
  if (!p) throw new Error('No active Pod in this run');
  if (command === 'refresh') {
    const remote = await api(`/pods/${p.id}`);
    const source = await readFile(join(HERE, 'controller.py'), 'utf8');
    await api(`/pods/${p.id}`, 'PATCH', { env: { ...remote.env, TINY_BOOTSTRAP: Buffer.from(source).toString('base64') } });
    console.log(JSON.stringify({ refreshed: p.id, deadlineUnchanged: p.deadline }));
  } else if (command === 'status') {
    const remote = await api(`/pods/${p.id}`);
    let controller;
    try { controller = await control(p, '/status'); } catch (e) { controller = { error: e.message }; }
    console.log(JSON.stringify({ pod: safePod(p), desiredStatus: remote.desiredStatus, lastStatusChange: remote.lastStatusChange, controller }, null, 2));
  } else if (command === 'start') {
    if (!s.models[arg]) throw new Error('Model not allow-listed');
    console.log(JSON.stringify(await control(p, '/model', { model: arg })));
  } else if (command === 'ready') {
    const until = Math.min(Date.now() + 15 * 60000, p.deadline * 1000);
    while (Date.now() < until) {
      const health = await control(p, '/status');
      if (health.ready) { console.log(JSON.stringify(health)); process.exit(0); }
      if (health.exitCode !== null) throw new Error(`Model server exited with ${health.exitCode}: ${(await control(p, '/logs')).log.slice(-4000).replaceAll(p.token, '[redacted]')}`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    throw new Error('Model did not become ready within 15 minutes');
  } else if (command === 'logs') {
    console.log((await control(p, '/logs')).log.replaceAll(p.token, '[redacted]'));
  } else if (command === 'test') {
    const blocked = await access(join(ROOT, 'results', '.v1-launch-disabled'))
      .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (blocked) throw new Error('V1 tests are disabled: this run has moved to test/llm-tiny-v2. Deployment safeguards remain active.');
    if (!s.models[arg]) throw new Error('Model not allow-listed');
    const health = await control(p, '/status');
    if (!health.ready || health.model !== arg) throw new Error('Requested model is not ready; refusing to score startup failures');
    const adapter = arg.includes('compass') ? 'compass' : arg.includes('browser-use') ? 'browser-use' : 'fara';
    const name = arg.split('/')[1];
    const args = [join(ROOT, 'run.mjs'), '--adapter', adapter, '--model', arg, '--base', `https://${p.id}-8000.proxy.runpod.net/v1`, '--api-key-env', 'TINY_INFERENCE_KEY', '--name', name, '--tag', '2026-09-13-six-model-final', ...process.argv.slice(4)];
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, TINY_INFERENCE_KEY: p.token } });
    child.on('exit', code => process.exit(code ?? 1));
  } else throw new Error('Unknown command');
}
