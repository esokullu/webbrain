#!/usr/bin/env node
// RTX 5090 comparison using official, revision-pinned Q4_K_M GGUF files.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const analysis = join(root, 'test/llm/analysis/2026-09-26-spark-minicpm-compact');
const replay = join(root, 'test/llm/freeze/compact-replay-2026-09-07.json');
const runtime = process.env.LLAMA_SERVER || 'C:/Users/esoku/.lmstudio/extensions/backends/llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.46.0/llama-server.exe';
const modelRoot = process.env.GGUF_MODEL_ROOT || 'C:/Users/esoku/.lmstudio/models';
const requested = process.argv.find(a => a.startsWith('--model='))?.slice(8);
const smokeOnly = process.argv.includes('--smoke');
const models = [
  { id: 'spark-x2.5-4b', name: 'Spark-X2.5-4B', source: 'XHToken/Spark-X2.5-4B', repo: 'XHToken/Spark-X2.5-4B-GGUF', revision: '9826e0be84e6e6e8b9668abc91421109a1df1e2d', file: 'Spark-X2.5-4B-Q4_K_M.gguf', bytes: 2600224352, sha256: 'adfcfa19a4ed6a5985da8bf565fe15f8e1a7e131d79bae2d19d48d1c40109428' },
  { id: 'minicpm5-2b', name: 'MiniCPM5-2B', source: 'openbmb/MiniCPM5-2B', repo: 'openbmb/MiniCPM5-2B-GGUF', revision: '2079a22f3beaa4e306449978533478fe0522f4b3', file: 'MiniCPM5-2B-Q4_K_M.gguf', bytes: 1561318368, sha256: 'ec2d5801640099e97d8d7e8003ad4d81f336e757811f03a26173dddf386602fd' },
  { id: 'spark-x2.5-1.7b', name: 'Spark-X2.5-1.7B', source: 'XHToken/Spark-X2.5-1.7B', repo: 'XHToken/Spark-X2.5-1.7B-GGUF', revision: '1f7fa33b1245c14730da39e125714ad3a327901b', file: 'Spark-X2.5-1.7B-Q4_K_M.gguf', bytes: 1107457856, sha256: '902bde2522394954ac17821b3e5fd0df02defbc6944f122253f2580acf0503f4' },
];
if (requested && !models.some(m => m.id === requested)) throw new Error(`Unknown model: ${requested}`);
await mkdir(analysis, { recursive: true });

const hashFile = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const run = (command, args) => new Promise((accept, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
});

for (const model of models.filter(m => !requested || m.id === requested)) {
  const metadataFile = join(analysis, `${model.id}${smokeOnly ? '-preflight' : ''}-run.json`);
  if (existsSync(metadataFile)) throw new Error(`Refusing to overwrite run metadata: ${metadataFile}`);
  const modelFile = join(modelRoot, model.repo, model.file);
  if (await hashFile(modelFile) !== model.sha256) throw new Error(`Model hash mismatch: ${model.id}`);
  const args = ['--model', modelFile, '--alias', model.name, '--host', '127.0.0.1', '--port', '18080',
    '--device', 'CUDA0', '--n-gpu-layers', '99', '--ctx-size', '32768', '--parallel', '1',
    '--flash-attn', 'on', '--jinja', '--reasoning', 'off', '--seed', '3407',
    '--top-k', '0', '--top-p', '1', '--min-p', '0', '--repeat-penalty', '1', '--no-webui'];
  const log = createWriteStream(join(analysis, `${model.id}-server.log`), { flags: 'a' });
  const server = spawn(runtime, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.pipe(log); server.stderr.pipe(log);
  let serverError = null;
  server.on('error', error => { serverError = error; });
  const metadata = { schema: 'webbrain.local-comparison-run.v1', startedAt: new Date().toISOString(),
    model, quantization: 'Q4_K_M', gpu: 'NVIDIA GeForce RTX 5090', runtime, args,
    replaySha256: await hashFile(replay), concurrency: 1, timeoutMs: 120000,
    thinking: false, seed: 3407, maxTokens: 4096, actionTemperature: 0.15, askTemperature: 0.3,
    stages: [], codeHashes: {} };
  for (const file of ['test/llm/run-llamacpp.mjs', 'test/llm/run-scenarios.mjs', 'test/llm/lib/score.mjs',
    'test/llm/lib/content-tool-call-parser.mjs', 'test/llm/lib/replay-payload.mjs']) metadata.codeHashes[file] = await hashFile(join(root, file));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (serverError || server.exitCode !== null) throw serverError || new Error(`Server exited ${server.exitCode}; see ${model.id}-server.log`);
      try {
        const response = await fetch('http://127.0.0.1:18080/health', { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(accept => setTimeout(accept, 500));
    }
    if (!ready) throw new Error('Server did not become healthy.');
    metadata.serverProperties = await fetch('http://127.0.0.1:18080/props').then(r => r.json());
    metadata.serverModels = await fetch('http://127.0.0.1:18080/v1/models').then(r => r.json());
    if (metadata.serverModels.data[0]?.id !== model.name) throw new Error('The endpoint is serving a different model.');
    for (const stage of smokeOnly ? ['smoke'] : ['smoke', 'full']) {
      for (const track of ['first-turn', 'scenarios']) {
        const tag = `2026-09-26-${model.id}-compact-${smokeOnly ? 'preflight' : stage}`;
        const runner = track === 'first-turn' ? 'run-llamacpp.mjs' : 'run-scenarios.mjs';
        const commandArgs = ['test/llm/' + runner, '--base', 'http://127.0.0.1:18080', '--model', model.name,
          '--tier', 'compact', '--browser', 'chrome', '--concurrency', '1', '--timeout', '120000', '--tag', tag, '--replay', replay];
        if (stage === 'smoke') commandArgs.push('--only', track === 'first-turn' ? '1,16,34,68,82' : '1,11,41,61,71,81,91');
        const resultDir = join(root, 'test/llm', track === 'first-turn' ? 'results' : 'results-scenarios', `${tag}_chrome_${model.name}_compact`);
        if (existsSync(join(resultDir, 'summary.json'))) throw new Error(`Refusing to overwrite results: ${resultDir}`);
        console.log(`Starting ${model.name}: ${stage} ${track}`);
        await run(process.execPath, commandArgs);
        const summary = JSON.parse(await readFile(join(resultDir, 'summary.json'), 'utf8'));
        metadata.stages.push({ stage, track, command: [process.execPath, ...commandArgs], resultDir, summary });
        await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
        if (stage === 'smoke' && (summary.errors || summary.byVerdict?.error)) throw new Error(`Preflight transport failure for ${model.name}.`);
      }
    }
    metadata.completedAt = new Date().toISOString();
  } catch (error) {
    metadata.error = error.message;
    throw error;
  } finally {
    if (server.exitCode === null) server.kill();
    await new Promise(accept => server.exitCode !== null ? accept() : server.once('exit', accept));
    log.end();
    await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + '\n');
  }
}
