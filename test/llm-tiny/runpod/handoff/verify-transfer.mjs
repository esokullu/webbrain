#!/usr/bin/env node
// Offline verification only. No imports of the live runner and no network calls.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const digest = b => createHash('sha256').update(b).digest('hex');
export async function filesUnder(root) {
  const files = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else { assert(e.isFile(), `Non-regular bundle entry: ${relative(root,path)}`); files.push(relative(root,path)); }
    }
  }
  await walk(root); return files.sort();
}
export function scanCredentials(path, bytes, known = []) {
  for (const secret of known) if (secret && bytes.includes(Buffer.from(secret))) throw new Error(`Known credential in ${path}`);
  const text = bytes.toString('utf8');
  const patterns = [/sk-or-v1-[A-Za-z0-9]{20,}/, /rpa_[A-Za-z0-9]{20,}/, /hf_[A-Za-z0-9]{20,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /Bearer\s+[a-f0-9]{40,}/i];
  if (patterns.some(p => p.test(text))) throw new Error(`Credential-shaped content in ${path}`);
  if (/(^|\/)(?:\.env(?:\.[^/]*)?|\.runpod-state\.json|\.v2-budget\.json|\.v2-(?:browser-use|deepseek|fara-4b)\.json)$/.test(path)) throw new Error(`Raw private state in bundle: ${path}`);
}
export async function verifyTransfer(root, known = []) {
  const files = await filesUnder(root);
  const checksumText = await readFile(join(root, 'CHECKSUMS.sha256'), 'utf8');
  const entries = checksumText.trim().split('\n').map(line => {
    const m = /^([a-f0-9]{64})  (.+)$/.exec(line); assert(m, 'Invalid checksum row');
    assert(!m[2].startsWith('/') && !m[2].split('/').includes('..'), 'Unsafe checksum path');
    return [m[2], m[1]];
  });
  assert.equal(new Set(entries.map(([p])=>p)).size,entries.length,'Duplicate checksum paths');
  assert.deepEqual(files.filter(p=>p!=='CHECKSUMS.sha256'),entries.map(([p])=>p).sort(),'Unlisted or missing bundle files');
  for (const [path, hash] of entries) {
    const b = await readFile(join(root,path)); assert.equal(digest(b),hash,`Checksum mismatch: ${path}`); scanCredentials(path,b,known);
  }
  const { verifyManifest } = await import(pathToFileURL(join(root,'test/llm-tiny-v2/lib/manifest.mjs')));
  const manifestHash = await verifyManifest();
  assert.equal(manifestHash,'60e52b1361d2f93d5cffa0b6805b06c2fbe45c9e64fca27c6431c29e536f293d');
  const manifest = JSON.parse(await readFile(join(root,'test/llm-tiny-v2/manifest.json')));
  const resume = JSON.parse(await readFile(join(root,'handoff-state/resume-state.json')));
  const budget = JSON.parse(await readFile(join(root,'handoff-state/cumulative-budget.json')));
  assert.equal(budget.originalCapUsd,30); assert(budget.totals.conservativeAccruedUsd>1.8);
  assert.equal(budget.v2Requests.length,224); assert.equal(budget.unresolvedRequests.length,0);
  assert.equal(budget.resources.length,1); assert.equal(budget.resources[0].id,'aisniutjszyhc4');
  assert.equal(budget.resources[0].cleanupConfirmed,true);
  const pilot = manifest.cases.filter(c=>c.split==='pilot'&&c.seed===17).map(c=>c.id);
  const heldout = manifest.cases.filter(c=>c.split==='heldout').map(c=>c.id);
  let episodes=0,requests=0,screenshots=0;
  for(const p of resume.participants) {
    assert.deepEqual(p.requiredPilotIds,pilot); assert.deepEqual(p.requiredHeldoutIds,heldout);
    assert.deepEqual([...p.completedPilotIds,...p.remainingPilotIds].sort(),[...pilot].sort());
    assert.equal(new Set(p.completedPilotIds).size,p.completedPilotIds.length);
    assert.equal(p.completedHeldoutIds.length,0); assert.deepEqual(p.remainingHeldoutIds,heldout);
    for(const e of p.completedEpisodes) {
      const saved=JSON.parse(await readFile(join(root,e.path)));
      assert.equal(saved.id,e.id);assert.equal(saved.seed,17);assert.equal(saved.split,'pilot');
      assert.equal(saved.success,e.success); assert.equal(saved.status,e.status);
      assert.equal(digest(await readFile(join(root,e.path))),e.sha256);
      const responses=saved.trace.filter(t=>t.response);
      assert.equal(responses.length,e.requests.length);requests+=responses.length;
      assert(e.screenshots.length>0,'Missing screenshots');
      for(const png of e.screenshots)assert((await lstat(join(root,png))).isFile());
      screenshots+=e.screenshots.length; episodes++;
    }
    if(p.summaryPath) {
      const s=JSON.parse(await readFile(join(root,p.summaryPath)));
      assert.equal(s.protocol.manifestHash,manifestHash); assert.deepEqual(s.protocol.limits,manifest.limits);
      assert.equal(s.protocol.screenshotHistory,3); assert.equal(s.protocol.split,'pilot');
      assert.deepEqual(s.results.map(r=>r.id),p.completedPilotIds);
      assert.equal(s.cases,p.completedPilotIds.length);
      for(const r of s.results)assert.deepEqual(r,JSON.parse(await readFile(join(root,p.completedEpisodes.find(e=>e.id===r.id).path))));
    }
  }
  assert.equal(episodes,28);assert.equal(requests,224);assert.equal(resume.participants.length,6);
  assert.equal(resume.interruptedEpisodeAttempts.length,0);
  const allEpisodeFiles=files.filter(p=>/^test\/llm-tiny-v2\/results\/.+\/(?:pilot-)?(?:planning|calculation|evidence|workflow|recovery|visual)-\d+-s\d+\.json$/.test(p));
  assert.equal(allEpisodeFiles.length,episodes,'Unindexed v2 episode artifacts');
  const names=(await readFile(join(root,'secrets.example'),'utf8')).trim().split('\n');
  assert(names.every(n=>/^[A-Z][A-Z0-9_]*$/.test(n)),'secrets.example must contain variable names only');
  for(const p of ['test/llm-tiny/results/.v1-launch-disabled','test/llm-tiny/results/.v2-handoff-requested'])assert((await readFile(join(root,p))).length>0);
  return {verifiedAt:new Date().toISOString(),files:files.length,manifestHash,v2Episodes:episodes,v2Requests:requests,v2Screenshots:screenshots,participants:6,heldoutEpisodes:0,checksumsVerified:true,sanitizedBudgetIncluded:true,sanitizedResumeIncluded:true,knownCredentialValuesScanned:known.length,genericCredentialScanPassed:true,rawPrivateStateExcluded:true,networkCalls:0};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=resolve(process.argv[2]||new URL('.',import.meta.url).pathname);
  console.log(JSON.stringify(await verifyTransfer(root),null,2));
}
