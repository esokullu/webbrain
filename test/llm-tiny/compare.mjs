#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (!arg.startsWith('--')) continue;
    const next = argv[index + 1];
    out[arg.slice(2)] = next && !next.startsWith('--') ? (index += 1, next) : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.runs) {
  process.stdout.write('Usage: node test/llm-tiny/compare.mjs --runs path/to/summary.json,path/to/summary.json [--output comparison.md]\n');
  process.exit(args.help ? 0 : 1);
}
const paths = String(args.runs).split(',').map(value => resolve(value.trim())).filter(Boolean);
const summaries = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
const markdown = `# LLM tiny comparison\n\n| Participant | Model | Adapter | Observation | Action protocol | Success | Median case latency (ms) | Tokens |\n|---|---|---|---|---|---:|---:|---:|\n${summaries.map(summary => `| ${summary.name} | ${summary.model} | ${summary.adapter} | ${summary.observation} | ${summary.protocol} | ${summary.passed}/${summary.cases} (${(summary.successRate * 100).toFixed(1)}%) | ${summary.medianCaseLatencyMs ?? '-'} | ${summary.totalTokens || '-'} |`).join('\n')}\n\nThis is a deterministic local-fixture comparison. It preserves adapter-specific observation and action formats, so it is not a controlled equivalence or real-site benchmark.\n`;
if (args.output && args.output !== true) await writeFile(resolve(String(args.output)), markdown);
else process.stdout.write(markdown);
