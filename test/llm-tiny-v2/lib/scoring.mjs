import { random } from '../cases.mjs';

export function scoreTask(task,state) {
  const checks=[];
  for(let i=0;i<task.stages.length;i++) {
    const records=state.records.filter(r=>r.stage===i);
    for(const [key,value] of Object.entries(task.stages[i].expected)) checks.push({stage:i,key,passed:records.length===1&&records[0].values[key]===value});
    if(task.stages[i].rejectOnce) checks.push({stage:i,key:'recovered_after_update',passed:state.rejected.includes(i)});
  }
  if(task.ambiguousCommit) checks.push({key:'receipt_checked',passed:state.ledgerSeen});
  const correct=checks.filter(c=>c.passed).length;
  const violations=[...state.violations];
  if(state.records.length>task.stages.length) violations.push('extra_records');
  return {success:state.terminal&&correct===checks.length&&violations.length===0,partialCredit:checks.length?correct/checks.length:0,correct,checks,violations,terminal:state.terminal};
}

export function percentile(values,fraction) {
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*fraction)-1))];
}

export function aggregate(results) {
  const groups={};
  for(const r of results) (groups[r.category]??=[]).push(r);
  const summarize=rows=>({cases:rows.length,passed:rows.filter(r=>r.success).length,successRate:rows.filter(r=>r.success).length/rows.length,meanPartialCredit:rows.reduce((s,r)=>s+r.score.partialCredit,0)/rows.length});
  const costs=results.map(r=>r.usage.costUsd);
  return {...summarize(results),categories:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,summarize(v)])),
    medianLatencyMs:percentile(results.map(r=>r.latencyMs),.5),p95LatencyMs:percentile(results.map(r=>r.latencyMs),.95),
    medianActions:percentile(results.map(r=>r.actions),.5),totalTokens:results.reduce((s,r)=>s+r.usage.total,0),
    reportedApiCostUsd:costs.every(c=>c!==null)?costs.reduce((a,b)=>a+b,0):null,
    errors:Object.fromEntries([...new Set(results.map(r=>r.status))].map(s=>[s,results.filter(r=>r.status===s).length]))};
}

// Paired cluster bootstrap: variants of a task remain together, never pretend
// the three seeds are independent task samples. Fixed seed keeps reports reproducible.
export function pairedInterval(left,right,{samples=4000,seed=9321}={}) {
  const l=new Map(left.map(r=>[r.id,r])),r=new Map(right.map(r=>[r.id,r]));
  if(l.size!==left.length||r.size!==right.length||l.size!==r.size||[...l.keys()].some(k=>!r.has(k))) throw new Error('Comparison requires identical, unique task/seed coverage');
  const grouped=new Map();
  for(const [id,a] of l) {if(a.taskId!==r.get(id).taskId)throw new Error('Task identity mismatch');const values=grouped.get(a.taskId)||[];values.push(Number(a.success)-Number(r.get(id).success));grouped.set(a.taskId,values);}
  const differences=[...grouped.values()].map(v=>v.reduce((a,b)=>a+b,0)/v.length);
  if(!differences.length)throw new Error('Cannot compare empty results');
  const next=random(seed),draws=[];
  for(let i=0;i<samples;i++) {let sum=0;for(let j=0;j<differences.length;j++)sum+=differences[Math.floor(next()*differences.length)];draws.push(sum/differences.length);}
  return {difference:differences.reduce((a,b)=>a+b,0)/differences.length,low:percentile(draws,.025),high:percentile(draws,.975),independentTasks:differences.length};
}
