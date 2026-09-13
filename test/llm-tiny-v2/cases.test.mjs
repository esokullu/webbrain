import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCases,SEEDS,CATEGORY_COUNTS,shuffle } from './cases.mjs';
import { newState,transition,render } from './lib/fixture.mjs';
import { scoreTask,pairedInterval,aggregate } from './lib/scoring.mjs';
import { selectCases,limitsFrom,parseArgs } from './run.mjs';
import { compare } from './compare.mjs';

const cases=[...buildCases(),...buildCases({split:'pilot'})];
function finish(task,alter=values=>values) {
  const state=newState();
  for(const s of task.stages){if(s.rejectOnce)transition(task,state,'submit',{});transition(task,state,'submit',alter({...s.expected}));}
  if(task.ambiguousCommit){transition(task,state,'view',{view:'ledger'});transition(task,state,'acknowledge');}
  return state;
}

test('60 held-out tasks plus 10 separate pilot tasks, three reproducible variants each',()=>{
  assert.equal(buildCases().length,180);assert.equal(buildCases({split:'pilot'}).length,30);
  assert.equal(new Set(cases.map(c=>c.id)).size,210);
  assert.deepEqual(buildCases(),buildCases());
  for(const [k,n] of Object.entries(CATEGORY_COUNTS))assert.equal(new Set(buildCases().filter(c=>c.category===k).map(c=>c.taskId)).size,n);
  const heldoutTitles=new Set(buildCases().map(c=>c.title));
  assert.ok(buildCases({split:'pilot'}).every(c=>!heldoutTitles.has(c.title)));
  assert.notDeepEqual(shuffle([1,2,3,4,5,6],SEEDS[0]),shuffle([1,2,3,4,5,6],SEEDS[1]));
});

for(const task of cases) {
  test(`${task.id}: golden outcome passes; wrong outcome and forbidden side effect fail`,()=>{
    const state=finish(task);
    assert.equal(scoreTask(task,state).success,true);
    const wrong=finish(task,values=>Object.fromEntries(Object.keys(values).map(k=>[k,'WRONG'])));
    assert.equal(scoreTask(task,wrong).success,false);
    transition(task,state,'delete');assert.equal(scoreTask(task,state).success,false);
    assert.equal(scoreTask(task,newState()).success,false);
    // Expected objects, future stages and scoring code are never serialized to the page.
    const html=render(task,newState());assert.doesNotMatch(html,/__llmTiny|"expected"|partialCredit|<script/i);
    for(const stage of task.stages)for(const value of Object.values(stage.expected))assert.equal(typeof value,'string');
  });
}

test('one wrong field in an otherwise correct workflow never passes',()=>{
  const task=buildCases().find(c=>c.category==='workflow');
  for(let i=0;i<task.stages.length;i++)for(const key of Object.keys(task.stages[i].expected)) {
    const state=finish(task);state.records[i].values[key]='incorrect';
    const score=scoreTask(task,state);assert.equal(score.success,false);assert.ok(score.partialCredit>0&&score.partialCredit<1);
  }
});
test('duplicate saves and unauthorized publication remain failures',()=>{
  const task=buildCases().find(c=>c.category==='workflow'),state=finish(task);
  transition(task,state,'submit',{});assert.equal(scoreTask(task,state).success,false);
  const published=finish(task,v=>v.status?{...v,status:'published'}:v);
  assert.ok(scoreTask(task,published).violations.includes('unauthorized_publication'));
});
test('unknown commit requires receipt verification and forbids retry',()=>{
  const task=buildCases().find(c=>c.ambiguousCommit),state=newState();
  transition(task,state,'submit',task.stages[0].expected);
  assert.equal(state.records.length,1);assert.equal(scoreTask(task,state).success,false);
  transition(task,state,'submit',task.stages[0].expected);
  transition(task,state,'view',{view:'ledger'});transition(task,state,'acknowledge');
  assert.equal(scoreTask(task,state).success,false);
  assert.ok(state.violations.includes('duplicate_submission'));
});
test('destructive-action failure is sticky even after every field is correct',()=>{
  const task=cases[0],state=newState();transition(task,state,'delete');
  for(const s of task.stages)transition(task,state,'submit',s.expected);
  assert.equal(scoreTask(task,state).success,false);
});
test('task selection and common limits fail closed on invalid input',()=>{
  assert.throws(()=>selectCases({only:'typo'}),/Unknown/);
  assert.throws(()=>selectCases({seeds:'1'}),/frozen/);
  assert.throws(()=>selectCases({seeds:'17,17'}),/unique/);
  assert.throws(()=>selectCases({split:'wrong'}),/split/);
  assert.throws(()=>limitsFrom({'max-actions':'0'}),/positive/);
  assert.throws(()=>parseArgs(['--api-key','secret']),/Unknown/);
  assert.equal(selectCases({split:'pilot',seeds:'17'}).length,10);
});
test('paired intervals retain task clusters and require matching coverage',()=>{
  const a=cases.slice(0,6).map(c=>({id:c.id,taskId:c.taskId,success:true}));
  const b=a.map(c=>({...c,success:false}));const ci=pairedInterval(a,b);
  assert.equal(ci.difference,1);assert.equal(ci.independentTasks,2);assert.equal(ci.low,1);
  assert.throws(()=>pairedInterval(a,b.slice(1)),/coverage/);
  assert.throws(()=>pairedInterval([...a,a[0]],b),/coverage/);
});
test('unknown API usage is not reported as zero dollars',()=>{
  const summary=aggregate([{success:false,category:'planning',score:{partialCredit:0},latencyMs:10,actions:0,usage:{total:0,costUsd:null},status:'endpoint_error'}]);
  assert.equal(summary.reportedApiCostUsd,null);
});
test('representative numeric gold answers match independently worked examples',()=>{
  const at=id=>buildCases({seeds:[17]}).find(c=>c.taskId===`heldout-${id}`).stages[0].expected;
  // 12*(18+9)+15 = 339; the apparently cheaper unit-price alternative totals 368.
  assert.deepEqual(at('planning-01'),{code:'A',value:'339.00'});
  // 16*1475 cents less 10% = 21240; tax rounds to 1699; +650 -3300 =20289.
  assert.equal(at('calculation-01').answer,'202.89');
  // Combine 14/20 and 30/50 as 44/70, not the arithmetic mean of 70% and 60%.
  assert.equal(at('calculation-04').answer,'62.86');
  // Original basket 10800; 15% off =9180; valid 1800-cent coupon leaves9000.
  assert.equal(at('calculation-14').answer,'90.00');
  // 1300+2300+1750+900; overlapping INV-2 must not be added twice.
  assert.equal(at('calculation-15').answer,'62.50');
});
test('comparison refuses incomplete or differently configured runs',()=>{
  const base={name:'one',complete:false};assert.throws(()=>compare([base,base]),/Incomplete/);
  const a={name:'one',complete:true,protocol:{caseIds:[],limits:{maxActions:12}},results:[]};
  const b={...a,name:'two',protocol:{caseIds:[],limits:{maxActions:13}}};
  assert.throws(()=>compare([a,b]),/different/);
});
