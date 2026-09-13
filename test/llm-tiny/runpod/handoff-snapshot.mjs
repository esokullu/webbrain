#!/usr/bin/env node
// Private local preservation only: creates no cloud resources or public links.
import { readFile, writeFile, readdir, mkdir, mkdtemp, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { verifyManifest } from '../../llm-tiny-v2/lib/manifest.mjs';
process.umask(0o077);
const root=resolve(new URL('../../../',import.meta.url).pathname);
const state=JSON.parse(await readFile(join(root,'test/llm-tiny/results/2026-09-13-six-model-matrix/.runpod-state.json')));
const pod=state.pods.find(p=>p.id==='aisniutjszyhc4');
const secrets=[process.env.RUNPOD_BENCH_KEY,process.env.OPENROUTER_API_KEY,pod.token].filter(Boolean);
if(secrets.length!==3)throw new Error('All known credentials are required for the archive exclusion scan');
const reportDir=join(root,'test/llm-tiny-v2/results/2026-09-13-v2-comparison');
const logResponse=await fetch(`https://${pod.id}-8001.proxy.runpod.net/logs`,{headers:{Authorization:`Bearer ${pod.token}`},signal:AbortSignal.timeout(15000)});
if(!logResponse.ok)throw new Error(`Log preservation failed: ${logResponse.status}`);
let log=(await logResponse.json()).log;
for(const secret of secrets)log=log.replaceAll(secret,'[redacted]');
await writeFile(join(reportDir,'last-model-server.log'),log,{mode:0o600});
await writeFile(join(reportDir,'runtime.json'),JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,playwright:'1.59.1',chromium:'147.0.7727.15',vllm:'0.19.1',manifestHash:await verifyManifest(),cloudTransferPerformed:false},null,2)+'\n');
const files=[];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
  if(e.name.startsWith('.')&&!['.v1-launch-disabled','.v2-handoff-requested'].includes(e.name)||e.name==='node_modules'||e.name.endsWith('.tar.gz')||e.name==='archive-verification.json')continue;
  const path=join(dir,e.name);if(e.isDirectory())await walk(path);else if(e.isFile())files.push(relative(root,path));else throw new Error('Unexpected symlink in snapshot inputs');
}}
await walk(join(root,'test/llm-tiny'));await walk(join(root,'test/llm-tiny-v2'));files.sort();
const checksums={};let bytes=0;
for(const path of files){const b=await readFile(join(root,path));for(const secret of secrets)if(b.includes(Buffer.from(secret)))throw new Error(`Credential found in snapshot input: ${path}`);checksums[path]=createHash('sha256').update(b).digest('hex');bytes+=b.length;}
const archive=join(root,'test/llm-tiny-v2/results/2026-09-13-private-handoff-snapshot.tar.gz');
try{await readFile(archive);throw new Error('Refusing to overwrite an existing snapshot');}catch(e){if(e.code!=='ENOENT')throw e;}
function run(args,input){return new Promise((resolve,reject)=>{const p=spawn('tar',args,{cwd:root,stdio:['pipe','ignore','pipe']});let err='';p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error(`Archive command failed (${c}): ${err.slice(0,500)}`)));p.stdin.end(input);});}
await run(['-czf',archive,'-T','-'],files.join('\n')+'\n');await chmod(archive,0o600);
const restored=await mkdtemp(join(tmpdir(),'llm-v2-private-archive-check-'));
await run(['-xzf',archive,'-C',restored]);
for(const [path,digest] of Object.entries(checksums)){const b=await readFile(join(restored,path));if(createHash('sha256').update(b).digest('hex')!==digest)throw new Error(`Restored checksum mismatch: ${path}`);}
const restoredManifest=await import(pathToFileURL(join(restored,'test/llm-tiny-v2/lib/manifest.mjs')));
const hash=await restoredManifest.verifyManifest();if(hash!==await verifyManifest())throw new Error('Restored frozen manifest mismatch');
const receipt={at:new Date().toISOString(),archive,mode:'0600',files:files.length,uncompressedBytes:bytes,archiveSha256:createHash('sha256').update(await readFile(archive)).digest('hex'),allRestoredChecksumsVerified:true,knownCredentialScanPassed:true,manifestHash:hash,restoredVerificationDirectory:restored,cloudStorageCreated:false,sourceResultsDeleted:false};
await writeFile(join(reportDir,'archive-verification.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
