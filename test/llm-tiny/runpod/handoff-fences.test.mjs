import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const prohibitNetwork='data:text/javascript,globalThis.fetch=()=>{throw new Error("NETWORK_MUST_NOT_BE_CALLED")};';
const run=(file,args=[])=>spawnSync(process.execPath,['--import',prohibitNetwork,file,...args],{cwd:root,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
for(const command of ['create','start','refresh','test'])test(`migration fence blocks manager ${command} before network`,()=>{
  const r=run('test/llm-tiny/runpod/manage.mjs',[command,'1']);
  assert.equal(r.status,1);assert.match(r.stderr,/Benchmark launches are fenced/);assert.doesNotMatch(r.stderr,/NETWORK_MUST_NOT_BE_CALLED/);
});
test('v2 launcher is fenced before secret state and network',()=>{
  const r=run('test/llm-tiny/runpod/v2-launch.mjs',['fara-9b']);assert.equal(r.status,1);assert.match(r.stderr,/Local v2 launches are paused/);assert.doesNotMatch(r.stderr,/NETWORK_MUST_NOT_BE_CALLED/);
});
test('read-only ledger remains usable offline',()=>{
  const r=run('test/llm-tiny/runpod/manage.mjs',['ledger']);assert.equal(r.status,0);const d=JSON.parse(r.stdout);assert.equal(d.capUsd,30);assert(d.pods.every(p=>p.deletedAt));
});
