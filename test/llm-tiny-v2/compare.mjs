#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairedInterval } from './lib/scoring.mjs';

const pct=n=>`${(n*100).toFixed(1)}%`;
const safe=text=>String(text).replaceAll('|','/').replaceAll('\n',' ');
export function compare(summaries) {
  if(summaries.length<2)throw new Error('Provide at least two summary files');
  const reference=summaries[0];
  for(const s of summaries){
    if(!s.complete)throw new Error(`Incomplete run: ${s.name}`);
    if(JSON.stringify(s.protocol)!==JSON.stringify(reference.protocol))throw new Error('Cannot rank different manifests, limits, splits, or selected task/seed coverage');
    if(s.results.length!==s.protocol.caseIds.length)throw new Error('Coverage is incomplete');
    if(s.protocol.caseIds.some(id=>!s.results.some(r=>r.id===id)))throw new Error('Missing planned task');
  }
  if(new Set(summaries.map(s=>s.name)).size!==summaries.length)throw new Error('Participant names must be unique');
  let report=`# Reasoning-heavy browser benchmark\n\nSplit: ${reference.protocol.split}. Each seed is a variant, not an independent new task.\n\n| Model | Pass rate | Median seconds | Median actions | Reported API cost | Observation |\n|---|---:|---:|---:|---:|---|\n`;
  for(const s of [...summaries].sort((a,b)=>b.successRate-a.successRate)) report+=`| ${safe(s.name)} | ${s.passed}/${s.cases} (${pct(s.successRate)}) | ${(s.medianLatencyMs/1000).toFixed(2)} | ${s.medianActions} | ${s.reportedApiCostUsd===null?'unknown':`$${s.reportedApiCostUsd.toFixed(4)}`} | ${safe(s.observation)} |\n`;
  report+='\n## Category pass rates\n\n| Category | '+summaries.map(s=>safe(s.name)).join(' | ')+' |\n|---|'+summaries.map(()=>'---:').join('|')+'|\n';
  for(const category of Object.keys(reference.categories))report+=`| ${category} | ${summaries.map(s=>pct(s.categories[category].successRate)).join(' | ')} |\n`;
  report+='\n## Paired differences vs first supplied participant\n\nDifferences are first participant minus comparator; 95% task-cluster bootstrap intervals. An interval overlapping zero does not establish a winner.\n\n';
  for(const s of summaries.slice(1)) {
    const ci=pairedInterval(reference.results,s.results);
    report+=`- ${safe(reference.name)} minus ${safe(s.name)}: ${(ci.difference*100).toFixed(1)} percentage points [${(ci.low*100).toFixed(1)}, ${(ci.high*100).toFixed(1)}], ${ci.independentTasks} task clusters.\n`;
  }
  return report+'\nStrict pass requires all outcome checks, no forbidden actions, and completion within limits. Partial progress is retained in JSON, not counted as a pass. Hosting and native observation surfaces differ. Reported API costs exclude GPU rental/storage; unknown costs are not zero. This is a synthetic reasoning-heavy workload, not a universal browser-agent ranking.\n';
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const paths=process.argv.slice(2);const summaries=await Promise.all(paths.map(async p=>JSON.parse(await readFile(p,'utf8'))));process.stdout.write(compare(summaries));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
