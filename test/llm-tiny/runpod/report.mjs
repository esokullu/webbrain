#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'results', '2026-09-13-six-model-final');
const setup = JSON.parse(await readFile(join(root, 'results/2026-09-13-six-model-matrix/.runpod-state.json'), 'utf8'));
const names = ['webbrain-compass-tiny-v2', 'bu-30b-a3b-preview', 'Fara1.5-4B', 'Fara1.5-9B', 'Fara1.5-27B', 'openrouter-deepseek-v4.1-flash'];
const participants = [];
for (const name of names) {
  const summary = JSON.parse(await readFile(join(dir, name, 'summary.json'), 'utf8'));
  const cases = await Promise.all(Array.from({ length: 30 }, async (_, i) => JSON.parse(await readFile(join(dir, name, `${String(i + 1).padStart(2, '0')}.json`), 'utf8'))));
  if (summary.cases !== 30 || cases.some((item, i) => item.id !== String(i + 1).padStart(2, '0'))) throw new Error(`Incomplete results for ${name}`);
  participants.push({ ...summary, revision: setup.models[summary.model] || null, hardware: name.startsWith('openrouter') ? 'OpenRouter provider-managed' : name === 'Fara1.5-27B' ? '2 x A100 80GB' : '1 x A100 80GB (same Pod)', casesDetail: cases });
}
if (setup.pods.some(p => !p.deletedAt)) throw new Error('Clean up the temporary Pods before publishing the final report');
const hashes = {};
for (const file of ['run.mjs', 'cases.mjs', 'lib/adapters.mjs', 'lib/fara-reference.json', 'runpod/controller.py']) hashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
const pods = setup.pods.map(({ token, ...pod }) => ({ ...pod, billedHoursUpperEstimate: (pod.deletedAt - pod.createdAt) / 3600000, costUpperEstimateUsd: (pod.deletedAt - pod.createdAt) / 3600000 * pod.budgetRate }));
// Include all API reruns in the spend audit, not only the selected final run.
let reportedApiUsd = 0;
for (const tag of ['2026-09-13-six-model-matrix', '2026-09-13-six-model-before-visible-picker', '2026-09-13-six-model-final']) {
  try { reportedApiUsd += JSON.parse(await readFile(join(root, 'results', tag, 'openrouter-deepseek-v4.1-flash/summary.json'), 'utf8')).reportedApiCostUsd || 0; } catch {}
}
// Earlier smoke traces predate API cost capture. Reserve its uncached token estimate.
const earlierSmokeAllowanceUsd = 0.01;
const runpodUpperEstimateUsd = pods.reduce((n,p) => n + p.costUpperEstimateUsd, 0);
const billing = [];
if (process.env.RUNPOD_BENCH_KEY) for (const pod of pods) {
  const url = `https://rest.runpod.io/v1/billing/pods?podId=${encodeURIComponent(pod.id)}&grouping=podId&bucketSize=hour&startTime=${encodeURIComponent(new Date(pod.createdAt - 3600000).toISOString())}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.RUNPOD_BENCH_KEY}` }, signal: AbortSignal.timeout(20000) });
  billing.push({ podId: pod.id, status: r.status, records: r.ok ? await r.json() : null });
}
const costs = { capUsd: setup.capUsd, runpodUpperEstimateUsd, reportedApiUsd, earlierSmokeAllowanceUsd, totalUpperEstimateUsd: runpodUpperEstimateUsd + reportedApiUsd + earlierSmokeAllowanceUsd, pods, billing };
const report = { createdAt: new Date().toISOString(), fixtureCount: 30, participantCount: 6, hashes, costs, settings: { viewport: '1440x900', maxTurns: 12, maxContextTokens: 16384, dtype: 'bfloat16', eagerMode: true, recentImages: 3, vllm: '0.19.1' }, participants };
await writeFile(join(dir, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
const rows = participants.map(p => `| ${p.name} | ${p.passed}/30 | ${(p.medianCaseLatencyMs / 1000).toFixed(2)} | ${p.totalTokens.toLocaleString('en-US')} | ${p.hardware} |`).join('\n');
const kinds = ['click', 'input', 'select', 'toggle', 'form'];
const breakdown = kinds.map(kind => `| ${kind} | ${participants.map(p => { const items = p.casesDetail.filter(c => c.kind === kind); return `${items.filter(c => c.success).length}/${items.length}`; }).join(' | ')} |`).join('\n');
const failures = participants.flatMap(p => p.casesDetail.filter(c => !c.success).map(c => `- **${p.name}, case ${c.id}:** ${c.task} Outcome: ${c.status}${c.error ? ` — ${c.error}` : ''}. [Trace](${p.name}/${c.id}.json).`));
const md = `# Six-model local browser benchmark\n\n30 deterministic cases per model, one measured pass per case. Model revisions and harness hashes are recorded in comparison.json.\n\n| Model | Passed | Median case seconds | Tokens | Hardware |\n|---|---:|---:|---:|---|\n${rows}\n\n## By task type\n\n| Task | ${participants.map(p => p.name).join(' | ')} |\n|---|${participants.map(() => '---:').join('|')}|\n${breakdown}\n\n## Failures\n\n${failures.length ? failures.join('\n') : 'All selected cases passed.'}\n\n## Cost and cleanup\n\n- Authorized ceiling: $30.\n- Conservative RunPod compute/storage estimate, including startup and troubleshooting: $${runpodUpperEstimateUsd.toFixed(3)}.\n- Reported OpenRouter charges across all full runs: $${reportedApiUsd.toFixed(5)}; an additional $0.01 allowance covers the earlier smoke run.\n- Conservative combined total: $${costs.totalUpperEstimateUsd.toFixed(3)}. Billing API records, when available, are in comparison.json; an empty billing response is not treated as zero cost.\n- All ${pods.length} temporary Pods have been deleted. No persistent network volumes were created.\n\n## Interpretation and reproducibility\n\nThis measures the current 30 local browser fixtures. Compass receives accessibility text; Browser Use and DeepSeek receive indexed DOM plus screenshots; Fara receives screenshots only. Success requires the fixture's actual target state. Latencies include local browser work and network round trips; Fara 27B uses two GPUs and DeepSeek uses provider-managed infrastructure. These scores do not establish real-site reliability or equal-hardware inference speed.\n\nPreflight exposed dropped batched actions, missing visible status in text observations, keyboard-name differences, and native dropdown options absent from screenshots. The adapters were corrected, and all final runs use in-page dropdown pickers. Earlier runs remain separately under results/2026-09-13-six-model-matrix results/2026-09-13-six-model-before-visible-picker, and the native-smoke result directories. The report includes the complete final runs, rather than replacing individual failed cases with retries.\n\nPer-case JSON traces and step/final PNGs are saved in each model directory. All self-hosted weights use BF16, vLLM 0.19.1, eager execution, a 16,384-token context, and one request sequence at a time. Fara and Browser Use retain three screenshots. The first four self-hosted models share the same A100 Pod.\n`;
await writeFile(join(dir, 'comparison.md'), md);
console.log(JSON.stringify({ report: join(dir, 'comparison.md'), totalUpperEstimateUsd: costs.totalUpperEstimateUsd, results: participants.map(p => ({ model: p.name, passed: p.passed, medianMs: p.medianCaseLatencyMs })) }, null, 2));
