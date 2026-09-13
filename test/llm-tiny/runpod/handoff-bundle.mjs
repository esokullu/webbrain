#!/usr/bin/env node
// Local artifact creation only; never contacts a model, provider, or cloud host.
import { readFile, writeFile, readdir, mkdir, mkdtemp, chmod, copyFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { verifyManifest } from '../../llm-tiny-v2/lib/manifest.mjs';
import { digest, filesUnder, scanCredentials, verifyTransfer } from './handoff/verify-transfer.mjs';

process.umask(0o077);
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const matrix='test/llm-tiny/results/2026-09-13-six-model-matrix';
const readJson=async p=>JSON.parse(await readFile(join(root,p)));
const state=await readJson(`${matrix}/.runpod-state.json`),oldBudget=await readJson(`${matrix}/.v2-budget.json`);
const cleanup=await readJson('test/llm-tiny-v2/results/2026-09-13-v2-comparison/cleanup-verification.json');
assert(state.pods.every(p=>p.deletedAt),'Live Pod: refuse packaging as a completed shutdown');
assert.equal(cleanup.activePods,0);assert(oldBudget.handoffBlocked);
await access(join(root,'test/llm-tiny/results/.v1-launch-disabled'));
await access(join(root,'test/llm-tiny/results/.v2-handoff-requested'));
// Receive known credentials for exclusion scanning through stdin, never argv,
// source, logs, transfer files or generated environment files.
const rl=readline.createInterface({input:process.stdin});
const secretInput=JSON.parse(await new Promise(r=>rl.once('line',r)));rl.close();
const known=[secretInput.runpod,secretInput.openrouter,...state.pods.map(p=>p.token)].filter(Boolean);
assert(known.length>=3,'Known credential exclusion scan requires all benchmark credentials');
const manifestHash=await verifyManifest();
const manifest=await readJson('test/llm-tiny-v2/manifest.json');
const staging=await mkdtemp(join(tmpdir(),'llm-tiny-v2-transfer-source-'));
const transferDir=join(root,'test/llm-tiny-v2/results/transfers');
await mkdir(transferDir,{recursive:true,mode:0o700});
const included=[],excluded=[];
const allowedHidden=new Set(['.gitignore','.v1-launch-disabled','.v2-handoff-requested']);
async function copyTree(dir) {
  for(const e of await readdir(join(root,dir),{withFileTypes:true})) {
    const rel=join(dir,e.name);
    if(rel==='test/llm-tiny-v2/results/transfers'||e.name==='node_modules'||e.name==='__pycache__'||e.name.endsWith('.tar.gz')||e.name.startsWith('.')&&!allowedHidden.has(e.name)) {excluded.push({path:rel,reason:'archive/output/cache or raw hidden state excluded by allow-list'});continue;}
    if(e.isDirectory())await copyTree(rel);
    else {
      assert(e.isFile(),`Symlink/non-regular input refused: ${rel}`);
      const b=await readFile(join(root,rel));scanCredentials(rel,b,known);
      await mkdir(dirname(join(staging,rel)),{recursive:true});await copyFile(join(root,rel),join(staging,rel));
      included.push({path:rel,sha256:digest(b),bytes:b.length});
    }
  }
}
await copyTree('test/llm-tiny');await copyTree('test/llm-tiny-v2');
const emit=async(path,value)=>{await mkdir(dirname(join(staging,path)),{recursive:true});const b=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';scanCredentials(path,Buffer.from(b),known);await writeFile(join(staging,path),b,{mode:0o600});};
for(const name of ['HANDOFF.md','secrets.example','verify-transfer.mjs'])await emit(name,await readFile(join(root,'test/llm-tiny/runpod/handoff',name),'utf8'));
await emit('test/llm-tiny/results/V1-NON-COMPARABLE.md','# Preserved legacy v1 results\n\nThese results and mocks are historical only. They are NOT matching v2 coverage, cannot be compared directly to v2 scores, and must never trigger new or resumed v1 tests. Paid historical calls remain included in the cumulative budget.\n');
await emit('handoff-state/source-inventory.json',{sourceRootHistorical:root,gitStatus:'benchmark directories include relevant untracked files; files copied from the live workspace, not git archive',manifestHash,included,excluded,rawHiddenStateCopied:false,sanitizedStateExplicitlyIncluded:['handoff-state/cumulative-budget.json','handoff-state/resume-state.json','handoff-state/legacy-runpod-state.sanitized.json','handoff-state/participant-settings.json']});
// Carry exact relevant dependency pins without unrelated project code/scripts.
const sourcePackage=await readJson('package.json'),sourceLock=await readJson('package-lock.json');
await emit('provenance/workspace-package.json',sourcePackage);await emit('provenance/workspace-package-lock.json',sourceLock);
const pkg={name:'llm-tiny-v2-private-handoff',version:'1.0.0',private:true,type:'module',engines:{node:'22.22.3'},devDependencies:{playwright:'1.59.1'}};
const packages={'':{name:pkg.name,version:pkg.version,devDependencies:pkg.devDependencies,engines:pkg.engines}};
for(const p of ['node_modules/playwright','node_modules/playwright-core','node_modules/fsevents']) {assert(sourceLock.packages[p]);packages[p]=sourceLock.packages[p];}
await emit('package.json',pkg);await emit('package-lock.json',{name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages});
const browserSpecs=await readJson('node_modules/playwright-core/browsers.json');
const sanitizedPods=state.pods.map(p=>({id:p.id,gpus:p.gpus,gpuType:p.gpuType,createdAt:p.createdAt,createdAtIso:new Date(p.createdAt).toISOString(),deletedAt:p.deletedAt,deletedAtIso:new Date(p.deletedAt).toISOString(),deadline:p.deadline,originalDeadlineIso:new Date(p.deadline*1000).toISOString(),budgetRate:p.budgetRate,quotedRate:p.quotedRate,image:p.image,cleanupConfirmed:true}));
await emit('handoff-state/legacy-runpod-state.sanitized.json',{capUsd:30,pods:sanitizedPods,models:state.models,liveCredentialsIncluded:false,notDropInRuntimeState:true});
const catalog=[['browser-use','browser-use','browser-use/bu-30b-a3b-preview'],['deepseek','openai','deepseek/deepseek-v4.1-flash'],['fara-4b','fara','microsoft/Fara1.5-4B'],['fara-9b','fara','microsoft/Fara1.5-9B'],['fara-27b','fara','microsoft/Fara1.5-27B'],['compass','compass','webbrain-one/webbrain-compass-tiny-v2']];
const pilotIds=manifest.cases.filter(c=>c.split==='pilot'&&c.seed===17).map(c=>c.id);
const heldoutIds=manifest.cases.filter(c=>c.split==='heldout').map(c=>c.id);
const participants=[],settings=[],mappedRequests=[];
for(const [name,adapter,model] of catalog) {
  const base=`test/llm-tiny-v2/results/2026-09-13-v2-pilot-${name}`;
  let summary;try{summary=await readJson(`${base}/${name}/summary.json`);}catch(e){if(e.code!=='ENOENT')throw e;}
  const requestRows=oldBudget.requests.map((r,i)=>({...r,ledgerIndex:i})).filter(r=>r.participant===name);
  let next=0;const episodes=[];
  if(summary) {
    assert.equal(summary.protocol.manifestHash,manifestHash);
    for(const result of summary.results) {
      const path=`${base}/${name}/${result.id}.json`, bytes=await readFile(join(root,path));
      assert.deepEqual(JSON.parse(bytes),result);
      const requests=[];
      for(const trace of result.trace.filter(t=>t.response)) {
        const r=requestRows[next++];assert(r&&r.status===200,'Unreconciled request/response ordering');
        const row={ledgerIndex:r.ledgerIndex,participant:name,episodeId:result.id,turn:trace.turn,dispatchAt:r.at,status:r.status,preDispatchReservedUsd:r.reservedUsd,reportedChargedUsd:r.chargedUsd??null,chargeBasis:adapter==='openai'?'provider_response_usage':'covered by GPU rental; not a zero-cost inference assertion',responseCheckpointed:true,uncertain:false};
        requests.push(row);mappedRequests.push(row);
      }
      const pngs=included.filter(f=>f.path.startsWith(`${base}/${name}/${result.id}-`)&&f.path.endsWith('.png')).map(f=>f.path);
      episodes.push({id:result.id,taskId:result.taskId,seed:result.seed,success:result.success,status:result.status,actions:result.actions,latencyMs:result.latencyMs,path,sha256:digest(bytes),screenshots:pngs,requests});
    }
    assert.equal(next,requestRows.length,'Extra dispatched requests without checkpoint');
    const participant=await readJson(`${base}/${name}/participant.json`),hosting=await readJson(`${base}/hosting.json`);
    settings.push({name,model,adapter,recordedParticipant:participant,recordedHosting:hosting,protocol:summary.protocol,paths:{participant:`${base}/${name}/participant.json`,hosting:`${base}/hosting.json`}});
  }else settings.push({name,model,adapter,unrun:true,revision:state.models[model]??null,settingsSource:'Frozen adapter defaults; no participant run yet. Example endpoints are placeholders, not live services.'});
  participants.push({name,model,adapter,manifestHash,requiredPilotIds:pilotIds,completedPilotIds:episodes.map(e=>e.id),remainingPilotIds:pilotIds.filter(id=>!episodes.some(e=>e.id===id)),requiredHeldoutIds:heldoutIds,completedHeldoutIds:[],remainingHeldoutIds:heldoutIds,completedEpisodes:episodes,summaryPath:summary?`${base}/${name}/summary.json`:null,completePilot:episodes.length===10});
}
mappedRequests.sort((a,b)=>a.ledgerIndex-b.ledgerIndex);
assert.equal(mappedRequests.length,oldBudget.requests.length);
const checkpoint=await readJson('test/llm-tiny-v2/results/2026-09-13-v2-pilot-fara-4b/fara-4b/handoff-checkpoint.json');
await emit('handoff-state/resume-state.json',{schemaVersion:1,status:'stopped-transfer-only',owner:null,oldMachineMayResume:false,manifestHash,participants,completedEpisodeCount:28,requiredPilotEpisodeCount:60,remainingPilotEpisodeCount:32,heldoutGate:'All six matching pilots reviewed AND full 1080-episode comparison safely reserved before any heldout dispatch',interruptedEpisodeAttempts:[],potentiallyBilledUncheckpointedRequests:[],coordinatorInterruption:{at:checkpoint.at,afterCompletedEpisode:checkpoint.pausedAfter,checkpointedIds:checkpoint.completedIds,activeEpisodeInterrupted:false,localCoordinatorExited:true},nextUncompleted:{participant:'fara-4b',episodeId:'pilot-recovery-01-s17'},automaticallyQueued:false,notAuthorizedPilotSeeds:[43,89]});
await emit('handoff-state/participant-settings.json',{participants:settings});
const compute=state.pods.reduce((s,p)=>s+(p.deletedAt-p.createdAt)/3600000*p.budgetRate,0);
const quoteCompute=state.pods.reduce((s,p)=>s+(p.deletedAt-p.createdAt)/3600000*p.quotedRate,0);
const api=oldBudget.apiChargedOrReservedUsd;
const billingPartial=[{amountUsd:0.13200130581390113,timeBilledMs:294678,podId:'aisniutjszyhc4',bucketUtc:'2026-09-13 00:00:00'},{amountUsd:0.1335299116326496,timeBilledMs:298139,podId:'aisniutjszyhc4',bucketUtc:'2026-09-13 01:00:00'}];
const partialAmount=billingPartial.reduce((n,r)=>n+r.amountUsd,0);
await emit('handoff-state/cumulative-budget.json',{schemaVersion:1,currency:'USD',originalCapUsd:30,capScope:'All benchmark spending from first v1/API smoke onward, including GPU, API, storage, loading, idle, retries, cleanup. No new allocation.',totals:{conservativeAccruedUsd:compute+api,remainingAgainstConservativeAccruedUsd:30-compute-api,activeCommittedUsd:0,activeReservedUsd:0,newCpuStorageRetentionUsd:0,settledFinalInvoiceUsd:null},resources:sanitizedPods.map(p=>({...p,containerDiskGB:160,persistentVolumeGB:0,networkVolumeId:null,conservativeComputeAndStorageUsd:(p.deletedAt-p.createdAt)/3600000*p.budgetRate,storageBillingSeparatedByProvider:false})),charges:{runpod:{basis:'elapsed lifetime until deletion, rounded up by budget rate; includes v1 and v2, loading and idle',quotedComputeEstimateUsd:quoteCompute,conservativeStorageAndRateMarginUsd:compute-quoteCompute,totalConservativeUsd:compute,billingReadAt:'2026-09-13T02:04:45.753Z',billingHttpStatus:200,providerRecords:billingPartial,providerReportedPartialUsd:partialAmount,partialRecordsAreNotAdditionalCharges:true,finalInvoiceConfirmed:false,unresolved:{scope:'Final full-lifetime RunPod billing/storage settlement',amountUsd:null,conservativeAmountAlreadyCarriedUsd:compute,reason:'Provider records cover only 592817 ms of 3908812 ms wall-clock resource lifetime. Do not treat these partial amounts as a final invoice or subtract earlier compute.'}},openrouter:{reportedCumulativeKeyUsageUsd:api,reportedAt:cleanup.at,keyLimitUsd:null,v2ReportedUsd:0.031821054,preV2ReportedAndReconciledUsd:0.029319759,priorFullRuns:[{tag:'2026-09-13-six-model-matrix',reportedUsd:0.009767463},{tag:'2026-09-13-six-model-before-visible-picker',reportedUsd:0.010073382},{tag:'2026-09-13-six-model-final',reportedUsd:0.007621158000000001}],priorSmokeReconciliationUsd:0.029319759-0.009767463-0.010073382-0.007621158000000001,priorSmokeAttribution:'Difference between cumulative pre-v2 key usage and three saved full-run provider totals; original smoke traces lacked cost capture. Carried in full, not treated as zero.',settledPerRequestUsage:true,finalAccountInvoiceConfirmed:false,attributionBasis:'Entire observed cumulative key usage charged conservatively to this benchmark; historical requests remain in v1 result files.',unresolvedRequestCostUsd:0}},v2Requests:mappedRequests,unresolvedRequests:[],reservations:{activeComputeUsd:0,activeApiUsd:0,activeCleanupUsd:0,apiPolicyLimitUsd:2,apiPolicyIsNotProviderEnforced:true,released:oldBudget.reservationsReleased,originalPodFullLifetimeReserveUsd:state.pods.reduce((n,p)=>n+(p.deadline*1000-p.createdAt)/3600000*p.budgetRate,0)},cleanup:cleanup,unrelatedResourcesAffected:false,notes:['Provider partial billing overlaps the conservative estimate; do not add twice.','GPU result usage cost null/zero is not free hosting; all rental is carried above.','Reconcile fresh final invoice and fresh account state before any new reservation.','No paid work or replacement deployment is authorized by packaging.']});
await emit('handoff-state/hosting-runtime.json',{modelRevisions:state.models,servingImage:'vllm/vllm-openai@sha256:89c1d0629d377daa3f7f369cbea6167a7b48ea89aaacd12555e2b0b2f7f740d3',imageArchitecture:'linux/amd64',vllmVersion:'0.19.1',servingFlags:{dtype:'bfloat16',maxModelLength:16384,maxConcurrentSequences:1,gpuMemoryUtilization:0.90,enforceEager:true,tensorParallelSize:1,visionMaxImages:3,compassAutoToolChoice:true,compassToolCallParser:'hermes'},historicalHardware:{type:'NVIDIA A100-SXM4-80GB',gpuCount:1},node:process.version,npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),playwright:'1.59.1',chromium:'147.0.7727.15',chromiumRevision:'1217',browserSpecs,os:{name:'macOS',version:'26.0.1',build:'25A362',platform:process.platform,arch:process.arch},browser:{headless:true,viewport:{width:1440,height:900},screenshotHistory:3,deviceScaleFactor:'default Playwright context',fonts:'OS defaults; font inventory not captured',renderingMigrationVerified:false},limits:manifest.limits,upstreamBaselineRevision:'OpenRouter-managed, model ID only',replacementHostingValidated:false});
await emit('handoff-state/launch-locks.json',{owner:null,oldMachinePaidWorkAutomatic:false,markers:[{path:'test/llm-tiny/results/.v1-launch-disabled',policy:'must remain on all machines; no v1 work'},{path:'test/llm-tiny/results/.v2-handoff-requested',policy:'must remain on old machine; new coordinator may supersede only on target after explicit authorization, durable exclusive ownership and budget safety verification'}],managerBlockedCommands:['create','start','refresh','test'],guardsDisabledEarly:false,cleanupAndInspectionRemainAllowed:true,frozenRunnerReadsMarkers:false,legacyLiveStateOmitted:true});
await emit('evidence/runpod-timers.json',{observedAt:cleanup.at,providerRemoval:{url:'https://github.com/runpod/runpodctl/pull/330',merged:true,mergedDate:'2026-08-27',summary:'Provider maintainers removed stop/terminate scheduling flags because accepted GraphQL inputs were not acted on and production test Pods kept running/billing. CPU REST creation had no scheduling field.'},restoration:{url:'https://github.com/runpod/runpodctl/pull/331',state:'open',draft:true,merged:false,updatedAt:'2026-08-27T22:51:24Z',summary:'Restoration is conditional on backend timer enforcement. Client-side validation and echoing deadlines do not verify actual termination.'},ownWatchdogs:{local:'Detached Node process calls DELETE at absolute deadline, then retries.',remote:'Python thread in same controller process calls DELETE; on failure stops model process and retries.',providerNative:false,absoluteHardCap:false,independentOfLaptop:'Remote thread only; not independent of its CPU process, network or RunPod API.'},billingDocs:'https://docs.runpod.io/pods/pricing',claimScope:'Evidence of unsupported/unverified native timers at snapshot time; recheck primary sources before later decisions, do not present own watchdogs as provider guarantees.'});
await emit('verification.json',{preparedAt:new Date().toISOString(),manifestHash,preArchiveSourceManifestVerified:true,knownCredentialScanRequired:true,knownCredentialScanCount:known.length,expectedEpisodes:28,expectedV2Requests:224,expectedHeldoutEpisodes:0,rawSecretStateExcluded:true,sourceResultsPreserved:true,networkCallsByPackager:0,readMe:'Final extraction verification and archive hash are recorded in the sibling archive .verification.json and .sha256 files; rerun verify-transfer.mjs after extraction.'});
const checksumRows=[];
for(const path of await filesUnder(staging)){const b=await readFile(join(staging,path));scanCredentials(path,b,known);checksumRows.push(`${digest(b)}  ${path}`);}
await emit('CHECKSUMS.sha256',checksumRows.join('\n')+'\n');
const stagedVerification=await verifyTransfer(staging,known);
const name=`llm-tiny-v2-handoff-${new Date().toISOString().replace(/[-:.]/g,'')}`;
const archive=join(transferDir,name+'.tar.gz');
await access(archive).then(()=>{throw new Error('Archive already exists');},e=>{if(e.code!=='ENOENT')throw e;});
execFileSync('tar',['-czf',archive,'-C',staging,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}});await chmod(archive,0o600);
const restored=await mkdtemp(join(tmpdir(),'llm-tiny-v2-transfer-verify-'));
execFileSync('tar',['-xzf',archive,'-C',restored]);
const verification=await verifyTransfer(restored,known);
// Prove the extraction verifier itself runs without workspace dependencies.
execFileSync(process.execPath,[join(restored,'verify-transfer.mjs')],{cwd:restored,stdio:'pipe'});
const archiveHash=digest(await readFile(archive));
await writeFile(archive+'.sha256',`${archiveHash}  ${name}.tar.gz\n`,{mode:0o600});
const receipt={...verification,archive,archiveSha256:archiveHash,archiveMode:'0600',stagingDirectory:staging,restoredDirectory:restored,sourceFileCount:included.length,sourceBytes:included.reduce((n,f)=>n+f.bytes,0),allOriginalSelectedFilesIdentical:true,noCloudResourcesCreated:true,sourceResultsDeleted:false};
await writeFile(archive+'.verification.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(receipt,null,2));
