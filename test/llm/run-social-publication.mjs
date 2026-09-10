#!/usr/bin/env node
// Live model calls only. This runner has no browser or publication transport.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Agent } from '../../src/chrome/src/agent/agent.js';
import { OpenAICompatibleProvider } from '../../src/chrome/src/providers/openai.js';
import { normalizePublicationContract, publicationProgress, publicationAuditMessages, publicationAuditAccepted } from '../../src/chrome/src/agent/social-publish-contract.js';
import { curated, auditChallenges } from './social-publication-cases.mjs';
import { scoreContract, snapshotFor, distribution } from './lib/social-publication-score.mjs';

const { values: args } = parseArgs({ options: {
  config: { type: 'string' }, base: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' },
  'api-key-env': { type: 'string', default: 'LLM_API_KEY' }, output: { type: 'string' },
  suite: { type: 'string', default: 'curated' }, only: { type: 'string' }, limit: { type: 'string' },
  repeat: { type: 'string', default: '1' }, timeout: { type: 'string', default: '90000' },
  'validate-only': { type: 'boolean' }, help: { type: 'boolean' },
} });
if (args.help) {
  console.log(`Usage: node test/llm/run-social-publication.mjs --config /private/provider.json
  Or: --provider openrouter --base https://openrouter.ai/api/v1 --model MODEL --api-key-env OPENROUTER_API_KEY
  --suite curated|audit|legacy|all (default curated includes positive and negative audits)
  --only exact-en,inspect --limit N --repeat N --timeout MS --output DIRECTORY
  --validate-only validates reviewed fixtures and makes no network calls.
Provider config uses WebBrain's existing provider config fields. Keys stay in the
config file/environment; they are never accepted on the command line or saved.
The actual provider class, intent compiler/repair loop, and audit prompt are used.
Browser transport, UI actions, permission prompts and dispatch are not exercised.`);
  process.exit(0);
}
const hash = text => createHash('sha256').update(text).digest('hex');
const golden = new Map(curated.map(c => [c.id, normalizePublicationContract(c.expected, c.sources)]));
for (const c of curated) for (const a of golden.get(c.id).actions) snapshotFor(a, c);
if (args['validate-only']) {
  console.log(`Validated ${curated.length} reviewed compiler cases and ${auditChallenges.length} independent audit challenges.`);
  process.exit(0);
}
if (!['curated', 'audit', 'legacy', 'all'].includes(args.suite)) throw new Error('Invalid --suite');
const config = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : {};
config.baseUrl = args.base || config.baseUrl || process.env.LLM_BASE_URL;
config.model = args.model || config.model || process.env.LLM_MODEL;
config.providerName = args.provider || config.providerName || 'openai-compatible';
config.apiKey = process.env[args['api-key-env']] || config.apiKey || '';
if (!config.baseUrl || !config.model) throw new Error('A provider base URL and model are required; no provider is chosen implicitly.');
const base = new URL(config.baseUrl);
if (base.username || base.password || base.search) throw new Error('Use a credential-free provider URL and config.apiKey or an environment variable.');
let provider;
if (config.providerName === 'anthropic') {
  const { AnthropicProvider } = await import('../../src/chrome/src/providers/anthropic.js');
  provider = new AnthropicProvider(config);
} else provider = new OpenAICompatibleProvider(config);
const repeat = Number(args.repeat), timeout = Number(args.timeout);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10 || !Number.isFinite(timeout) || timeout < 1000) throw new Error('Invalid repeat/timeout');
const output = path.resolve(args.output || `test/llm/results-social-publication/${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(output, { recursive: true });
const redact = value => String(value || '').replaceAll(config.apiKey || '\u0000', '[REDACTED]').slice(0, 600);
const manifest = { startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  provider: { name: provider.name, model: provider.model || config.model, baseUrl: base.origin + base.pathname, apiVariant: config.apiVariant || null },
  suite: args.suite, repeat, timeoutMs: timeout, concurrency: 1,
  promptSha256: hash(fs.readFileSync('src/chrome/src/agent/social-publish-contract.js')),
  fixtureSha256: hash(fs.readFileSync('test/llm/social-publication-cases.mjs')),
  limits: { compilerMaxTokens: 4096, compilerAttempts: 2, auditMaxTokens: 800, auditAttempts: 1 },
  notes: ['Sequential calls measure client-observed latency; provider cold-start/cache state is unknown.', 'No browser actions or live publication. Provider credentials and hidden reasoning are not stored.', 'Media grading uses a finite witness set; legacy destination labels are exploratory, not accuracy ground truth.'] };
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const rows = [];
const only = args.only ? new Set(args.only.split(',')) : null;
const select = values => values.filter(c => !only || only.has(c.id)).slice(0, args.limit ? Number(args.limit) : undefined);
let callNumber = 0;
async function chat(messages, options, phase, calls) {
  const started = performance.now();
  const item = { number: ++callNumber, phase, maxTokens: options.maxTokens };
  calls.push(item);
  try {
    const response = await provider.chat(messages, { ...options, signal: AbortSignal.timeout(timeout) });
    item.output = response.content || '';
    item.usage = response.usage || null;
    item.finishReason = response.finishReason || '';
    return response;
  } catch (error) {
    item.error = redact(error?.message);
    throw error;
  } finally { item.ms = Math.round(performance.now() - started); }
}
function save(row) {
  rows.push(row);
  fs.appendFileSync(path.join(output, 'cases.jsonl'), JSON.stringify(row) + '\n');
  console.log(`${row.suite} ${row.id} ${row.pass === undefined ? row.status : row.pass ? 'PASS' : 'FAIL'} ${row.ms}ms${row.errors?.length ? ' ' + row.errors.join(',') : ''}`);
  summarize();
}
async function compile(fixture, run, suite = 'curated') {
  const agent = new Agent({ getActive: () => provider });
  const tabId = 1;
  agent._planExecutionGuards.set(tabId, { enabled: true, taskKey: fixture.id });
  agent._socialPublicationSources = () => structuredClone(fixture.sources);
  const calls = [];
  agent._chatWithCostAllowance = (_provider, messages, options, _cost, meta) => chat(messages, options, meta.generationName, calls);
  const started = performance.now();
  let result, error;
  try { result = await agent._ensureSocialPublicationContract(tabId, provider); } catch (e) { error = redact(e.message); }
  const actual = result?.contract || null;
  let firstValid = false;
  try { firstValid = !!normalizePublicationContract(Agent._extractFirstJsonObject(calls[0]?.output || ''), fixture.sources); } catch {}
  const score = suite === 'curated' ? scoreContract(actual, golden.get(fixture.id)) : {};
  const row = { suite, id: fixture.id, category: fixture.category, run, ms: Math.round(performance.now() - started), firstValid,
    valid: !!actual, repaired: calls.length > 1, status: actual?.status || 'invalid', expectedStatus: golden.get(fixture.id)?.status || null, ...score,
    ...(error ? { error } : {}), request: fixture.sources.request, contract: actual, calls };
  if (suite === 'legacy') {
    row.historicalPlatforms = fixture.expectedPlatforms;
    row.proposedPlatforms = actual?.actions.map(a => a.platform) || [];
    row.historicalLabelMismatch = actual?.status === 'ready' && JSON.stringify([...new Set(row.proposedPlatforms)].sort()) !== JSON.stringify([...fixture.expectedPlatforms].sort());
  }
  save(row);
  return { actual, row };
}
async function audit({ id, sources, proposed, action, snapshot, expected, category, run }) {
  const key = hash(JSON.stringify({ id, sources, proposed, action, snapshot }));
  const calls = [], started = performance.now();
  let accepted = false, valid = false, raw = null;
  try {
    const response = await chat(publicationAuditMessages(sources, proposed, action, snapshot, key), { temperature: 0, maxTokens: 800 }, 'social_publication_authorization', calls);
    raw = Agent._extractFirstJsonObject(response.content || '');
    valid = !!raw && Object.keys(raw).length === 4 && raw.key === key && raw.actionId === action.id && typeof raw.authorized === 'boolean' && typeof raw.reason === 'string' && raw.reason.length <= 600;
    accepted = publicationAuditAccepted(raw, key, action.id);
  } catch {}
  const row = { suite: 'audit', id, category, run, expected, accepted, valid, pass: valid && accepted === expected,
    ms: Math.round(performance.now() - started), sources, proposed, actionId: action.id, snapshot, calls };
  save(row); return row;
}
function summarize() {
  const compiler = rows.filter(r => r.suite === 'curated');
  const audits = rows.filter(r => r.suite === 'audit');
  const legacy = rows.filter(r => r.suite === 'legacy');
  const allCalls = rows.flatMap(r => r.calls);
  const confusion = {};
  for (const row of compiler) {
    confusion[row.expectedStatus] ||= {};
    confusion[row.expectedStatus][row.status] = (confusion[row.expectedStatus][row.status] || 0) + 1;
  }
  const summary = { ...manifest, updatedAt: new Date().toISOString(), completed: false,
    compiler: { cases: compiler.length, passed: compiler.filter(r => r.pass).length, firstValid: compiler.filter(r => r.firstValid).length,
      finalValid: compiler.filter(r => r.valid).length, repairs: compiler.filter(r => r.repaired).length,
      unsafeProposals: compiler.filter(r => r.unsafeProposal).map(r => r.id),
      failures: compiler.filter(r => !r.pass).map(r => ({ id: r.id, status: r.status, errors: r.errors })), confusion, latency: distribution(compiler.map(r => r.ms)) },
    audit: { cases: audits.length, passed: audits.filter(r => r.pass).length, invalid: audits.filter(r => !r.valid).length,
      positive: audits.filter(r => r.expected).length, falseRejects: audits.filter(r => r.expected && !r.accepted).length,
      negative: audits.filter(r => !r.expected).length, falseAllows: audits.filter(r => !r.expected && r.accepted).length,
      failures: audits.filter(r => !r.pass).map(r => ({ id: r.id, expected: r.expected, accepted: r.accepted, valid: r.valid })), latency: distribution(audits.map(r => r.ms)) },
    legacy: { cases: legacy.length, ready: legacy.filter(r => r.status === 'ready').length, none: legacy.filter(r => r.status === 'none').length,
      clarify: legacy.filter(r => r.status === 'clarify').length, invalid: legacy.filter(r => !r.valid).length,
      historicalLabelMismatches: legacy.filter(r => r.historicalLabelMismatch).map(r => r.id), latency: distribution(legacy.map(r => r.ms)) },
    calls: allCalls.length, firstCallMs: allCalls[0]?.ms ?? null, transportErrors: allCalls.filter(c => c.error).length,
    tokenUsage: allCalls.reduce((sum, c) => ({ input: sum.input + (c.usage?.prompt_tokens || c.usage?.input_tokens || 0), output: sum.output + (c.usage?.completion_tokens || c.usage?.output_tokens || 0) }), { input: 0, output: 0 }),
  };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

console.log(`Benchmark ${provider.name}/${provider.model || config.model}; suite=${args.suite}; output=${output}`);
for (let run = 1; run <= repeat; run++) {
  if (['curated', 'all'].includes(args.suite)) for (const fixture of select(curated)) {
    const { actual } = await compile(fixture, run);
    // Audit the reviewed positive proposal separately. Compiler errors cannot
    // alter the gold snapshot or turn an audit false-allow into a positive.
    const proposed = golden.get(fixture.id);
    for (const action of proposed.actions.filter(a => publicationProgress(proposed).eligible.includes(a.id))) await audit({ id: `positive-${fixture.id}-${action.id}`, sources: fixture.sources,
      proposed, action, snapshot: snapshotFor(action, fixture), expected: true, category: 'reviewed-positive', run });
    // Inspect malformed semantic proposals from the real compiler as additional
    // audit challenges only when an independent negative rubric is available.
    if (actual?.status === 'ready' && proposed.status === 'none') for (const action of actual.actions) {
      try { await audit({ id: `compiler-unsafe-${fixture.id}-${action.id}`, sources: fixture.sources, proposed: actual,
        action, snapshot: snapshotFor(action, fixture), expected: false, category: 'compiler-unsafe-proposal', run }); } catch {}
    }
  }
  if (['curated', 'audit', 'all'].includes(args.suite)) for (const fixture of select(auditChallenges)) {
    const baseFixture = curated.find(c => c.id === fixture.base);
    const proposed = structuredClone(golden.get(fixture.base));
    const action = proposed.actions[0];
    const state = { proposed, action, snapshot: snapshotFor(action, baseFixture) };
    fixture.mutate?.(state);
    await audit({ id: fixture.id, sources: { request: fixture.request, task: fixture.request, plan: '' }, ...state, expected: false, category: 'forged-negative', run });
  }
  if (['legacy', 'all'].includes(args.suite)) {
    const historical = JSON.parse(fs.readFileSync('test/llm/fixtures/social-publication-intent.json', 'utf8')).cases;
    for (const fixture of select(historical.map((c, i) => ({ ...c, id: `legacy-${String(i + 1).padStart(3, '0')}`, sources: { request: c.request, task: c.request, plan: '' } })))) await compile(fixture, run, 'legacy');
  }
}
const summary = summarize(); summary.completed = true;
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
const seconds = ms => ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)} s`;
const md = [
  '# Social publication live benchmark', '',
  `Provider: ${manifest.provider.name}; model: ${manifest.provider.model}.`,
  `Started: ${manifest.startedAt}. Runtime commit: ${manifest.commit}.`, '',
  '| Measure | Result |', '| --- | --- |',
  `| Reviewed compiler cases passing | ${summary.compiler.passed}/${summary.compiler.cases} |`,
  `| First-response valid contracts | ${summary.compiler.firstValid}/${summary.compiler.cases} |`,
  `| Valid contracts after repair | ${summary.compiler.finalValid}/${summary.compiler.cases} |`,
  `| Compiler repairs used | ${summary.compiler.repairs} |`,
  `| Compiler median / p95 | ${seconds(summary.compiler.latency.p50Ms)} / ${seconds(summary.compiler.latency.p95Ms)} |`,
  `| Audit cases passing | ${summary.audit.passed}/${summary.audit.cases} |`,
  `| Audit false accepts on negative proposals | ${summary.audit.falseAllows}/${summary.audit.negative} |`,
  `| Audit false rejects on positive proposals | ${summary.audit.falseRejects}/${summary.audit.positive} |`,
  `| Invalid audit responses | ${summary.audit.invalid} |`,
  `| Audit median / p95 | ${seconds(summary.audit.latency.p50Ms)} / ${seconds(summary.audit.latency.p95Ms)} |`,
  `| First model-call latency | ${seconds(summary.firstCallMs)} |`,
  `| Model calls / transport errors | ${summary.calls} / ${summary.transportErrors} |`,
  `| Reported input / output tokens | ${summary.tokenUsage.input} / ${summary.tokenUsage.output} |`, '',
  'Compiler latency includes its validation repair when used. Calls are sequential. First-call latency is not proof of provider cold-start; server caching and warm state are unknown.', '',
  'Compiler grading checks the reviewed status, destinations/accounts, complete bodies, relationships, requirement ordering/conditions and media predicates. Media equivalence is checked over a finite witness set. Independent positive audits use reviewed proposals; forged negative audits measure whether the auditor rejects a coherent but unauthorized proposal. These are separate component measurements, not an end-to-end publication success rate.', '',
  'The runner uses the production provider class and compiler/repair implementation. It sends synthetic model inputs without browser dispatch. Hidden reasoning and credentials are excluded. A finite corpus, even with zero false accepts, does not establish a universal authorization guarantee.', '',
  '## Failures', '',
  ...summary.compiler.failures.map(f => `- Compiler ${f.id}: ${f.errors.join(', ')}`),
  ...summary.audit.failures.map(f => `- Audit ${f.id}: expected=${f.expected}, accepted=${f.accepted}, valid=${f.valid}`),
  ...(!summary.compiler.failures.length && !summary.audit.failures.length ? ['None in the executed reviewed cases.'] : []), '',
  '## Historical exploration', '',
  `${summary.legacy.cases} historical inputs: ${summary.legacy.ready} ready, ${summary.legacy.none} none, ${summary.legacy.clarify} clarify, ${summary.legacy.invalid} invalid.`,
  'Historical destination labels include ambiguous or obsolete expectations and are not included in the accuracy denominator.', '',
  'Raw case results: cases.jsonl. Machine-readable metrics: summary.json. Reproduction metadata and prompt/fixture hashes: manifest.json.', '',
];
fs.writeFileSync(path.join(output, 'report.md'), md.join('\n'));
console.log(JSON.stringify({ output, compiler: summary.compiler, audit: summary.audit, legacy: summary.legacy, calls: summary.calls, tokenUsage: summary.tokenUsage }, null, 2));
