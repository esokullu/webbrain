import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Real browser downloads and a remote form POST, through the installed Agent.
// All bytes, accounts and endpoints belong to this loopback test.
const out=path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/file-upload-accept-mv3');
await fs.mkdir(out,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=','base64');
const html=Buffer.from('<!doctype html><html><body>File viewer, not the image</body></html>'),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const pageHtml='<!doctype html><title>Owned attachment QA</title><h1>Download and upload QA</h1><form><label>QA image attachment <input name="attachment" type="file" required accept="image/*"></label><button>Submit QA attachment</button></form><p role="status" id="result"></p><script>window.nativeAttachments=[];for(const type of ["input","change"])document.querySelector("input").addEventListener(type,e=>{const f=e.target.files[0];const record={type,trusted:e.isTrusted,name:f?.name,size:f?.size,mime:f?.type};window.nativeAttachments.push(record);if(f)f.arrayBuffer().then(b=>crypto.subtle.digest("SHA-256",b)).then(b=>record.sha256=Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join(""));});document.querySelector("form").onsubmit=async e=>{e.preventDefault();const r=await fetch("/upload",{method:"POST",body:new FormData(e.target)});if(r.ok)document.querySelector("#result").textContent="QA attachment saved";};</script>';
let base,submitRef,actionCalls=0,viewerRequests=0; const uploads=[],calls=[],assetRequests=[];
const mismatches=[];
const scriptFile=new URL(import.meta.url);
async function captureSource(extension) {
  const map={};
  async function walk(directory) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isSymbolicLink())throw Error('Symlink source is not allowed');
      if(entry.isDirectory())await walk(file);else map[file]=sha(await fs.readFile(file));
    }
  }
  await walk(extension);map[scriptFile.pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')]=sha(await fs.readFile(scriptFile));
  return {capturedAt:new Date().toISOString(),extensionLoaded:extension,files:Object.keys(map).length,hashes:map};
}
const server=http.createServer(async(req,res)=>{
  if(req.url==='/viewer.htm'||req.url==='/webbrain-qa-pixel.png') {
    assetRequests.push({method:req.method,path:req.url});
    const viewer=req.url==='/viewer.htm';if(viewer)viewerRequests++;const bytes=viewer?html:png;
    res.writeHead(200,{'Content-Type':viewer?'text/html':'image/png','Content-Length':bytes.length,'Content-Disposition':`attachment; filename="${viewer?'viewer.htm':'webbrain-qa-pixel.png'}"`});res.end(bytes);return;
  }
  if(req.url==='/upload') {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),start=body.indexOf(png);
    uploads.push({containsExactPng:start>=0&&body.subarray(start,start+png.length).equals(png),contentType:req.headers['content-type']});
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"saved":true}');return;
  }
  if(req.url==='/v1/chat/completions') {
    let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);calls.push(input);
    const judge=String(input.messages?.[0]?.content||'').startsWith('Evaluate only the observable requirements of the genuine user task');
    const action=Array.isArray(input.tools)&&input.tools.length>0;
    // WebBrain's fixed-choice questions, read the way a model would read this
    // fixture: its result line says the attachment was saved.
    const fixedChoice=fixtureFixedChoiceReply(input.messages);
    let message;
    if(fixedChoice)message={role:'assistant',content:fixedChoice};
    else if(judge)message={role:'assistant',content:JSON.stringify({outcome:'uncertain',reason:'Require actual image attachment and persisted submission evidence.'})};
    else if(!action)message={role:'assistant',content:JSON.stringify({request_kind:'execute',scope_relation:'new',deliverables:['Resolve the viewer into the actual image and submit only the exact image to the QA form'],requires_state_change:true,requires_submission:true,messaging:null,completion_requirements:{download:true},allows_planner_shaped_result:false,allows_app_state_tool_evidence:false,read_scope:'visible_page',summary:'Download the viewer, reject incompatible HTML before attachment, resolve the exact PNG, submit once and verify.',steps:[{id:'1',action:'Download the viewer; use truthful mismatch recovery to obtain PNG; upload PNG to the owned form, submit once and verify.'}],memory:{use_progress_ledger:false,progress_action:null},scheduling:null,risks:[]})};
    else {
      const ids={};
      for(const item of input.messages||[])if(item.role==='tool') {
        const content=typeof item.content==='string'?item.content:JSON.stringify(item.content);
        try{const data=JSON.parse(content.slice(content.indexOf('{'),content.lastIndexOf('}')+1));
          for(const d of data.downloads||[])if(d.success&&d.downloadId!=null)ids[d.url]=d.downloadId;
          if(item.tool_call_id==='download-upload-2'&&!mismatches.length)mismatches.push(data);
        }catch{}
      }
      const steps=[{name:'download_files',args:{urls:[`${base}/viewer.htm`]}},
        {name:'upload_file',args:{selector:'input[name="attachment"]',downloadId:ids[`${base}/viewer.htm`]}},
        {name:'download_files',args:{urls:[`${base}/webbrain-qa-pixel.png`]}},
        {name:'upload_file',args:{selector:'input[name="attachment"]',downloadId:ids[`${base}/webbrain-qa-pixel.png`]}},
        {name:'get_accessibility_tree',args:{filter:'visible'}},
        {name:'click_ax',args:{ref_id:submitRef}},
        {name:'read_page',args:{limit:3000}},
        {name:'done',args:{summary:'The exact QA image was attached and submitted once; incompatible viewer HTML was not attached.',outcome:'success'}}];
      const step=steps[actionCalls++]||steps.at(-1);
      message={role:'assistant',content:'',tool_calls:[{id:`download-upload-${actionCalls}`,type:'function',function:{name:step.name,arguments:JSON.stringify(step.args)}}]};
    }
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:`qa-${calls.length}`,choices:[{message,finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20}}));return;
  }
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(pageHtml);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'webbrain-download-upload-'));let context;
try {
  const extension=path.resolve(process.env.WEBBRAIN_EXTENSION_PATH||'src/chrome'),downloadsPath=path.join(profile,'downloads');await fs.mkdir(downloadsPath);
  const sourceStart=await captureSource(extension);await fs.writeFile(path.join(out,'source-start.json'),JSON.stringify(sourceStart,null,2));
  context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',acceptDownloads:true,downloadsPath,args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  await context.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||u.protocol==='chrome-extension:'||u.protocol==='data:'?route.continue():route.abort('blockedbyclient');});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
  await worker.evaluate(()=>{const originalFetch=globalThis.fetch;globalThis.blockedFetches=0;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input.url);if(!['127.0.0.1','localhost'].includes(u.hostname)&&!['chrome-extension:','data:'].includes(u.protocol)){blockedFetches++;throw Error('Owned fixture only');}return originalFetch(input,init);};});
  const harness=await context.newPage();await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message=(action,data={})=>harness.evaluate(({action,data})=>chrome.runtime.sendMessage({target:'background',action,...data}),{action,data});
  await harness.evaluate(async()=>{window.events=[];chrome.runtime.onMessage.addListener(e=>{if(e.action==='agent_update')events.push({type:e.type,data:e.data});});await chrome.storage.local.set({ actObservation: 'accessibility',helpImproveWebBrain:false,planBeforeActMode:'off',planReviewMode:'never',screenshotFallback:false,autoScreenshot:false,maxAgentSteps:15,systemOneEnabled:false,tracingEnabled:false,agentAllowLocalNetwork:true,askBeforeConsequentialActions:false,openaiAskStreamingEnabled:false});});
  assert.equal((await message('update_provider',{providerId:'openrouter',config:{apiKey:'owned-fixture-fake-key',baseUrl:`${base}/v1`,model:'minimax/minimax-m3',contextWindow:1000000,enabled:true,supportsAskStreaming:false}})).ok,true);
  assert.equal((await message('set_active_provider',{providerId:'openrouter'})).ok,true);
  const page=await context.newPage();await page.goto(`${base}/attachment`);
  const tabId=await harness.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url)?.id,page.url());
  const tree=await harness.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{target:'content',action:'get_accessibility_tree',params:{filter:'visible'}}),tabId);
  submitRef=tree.pageContent.split('\n').find(s=>/button "Submit QA attachment"/.test(s))?.match(/\[(ref_\d+)\]/)?.[1];assert.ok(submitRef,tree.pageContent);
  const result=await message('chat',{tabId,text:`Upload the image linked through ${base}/viewer.htm as the image here. The actual image resource is ${base}/webbrain-qa-pixel.png. Preserve the viewer HTML as an ordinary download, but reject it at this image-only input before attaching anything. Obtain the actual image, submit exactly once and verify QA attachment saved.`,mode:'act',requestId:'qa-download-upload',locale:'en'});
  const events=await harness.evaluate(()=>events);
  const current=await message('agent_run_state',{tabId,requestId:'qa-download-upload'});
  let stored;
  for(let attempt=0;attempt<50;attempt++){
    stored=await harness.evaluate(async tabId=>(await chrome.storage.session.get(`runUi:${tabId}`))[`runUi:${tabId}`],tabId);
    if(stored?.status==='completed')break;await harness.waitForTimeout(100);
  }
  const downloads=await harness.evaluate(()=>chrome.downloads.search({}));
  await fs.writeFile(path.join(out,'download-metadata-before-assertions.json'),JSON.stringify({result,events,current,stored,downloads,assetRequests,uploads},null,2));
  const downloadResults=result.updates.filter(e=>e.type==='tool_result'&&e.data?.name==='download_files');
  assert.equal(downloadResults.length,2,'Exactly two owned download_files results must identify viewer and image.');
  for(const {data} of downloadResults){assert.equal(data.result.success,true);assert.equal(data.result.succeeded,1);assert.equal(data.result.failed,0);assert.equal(data.result.downloads.length,1);}
  const ownedReceipts=downloadResults.flatMap(e=>e.data.result.downloads);
  assert.equal(new Set(ownedReceipts.map(d=>d.downloadId)).size,2,'Each asset must have its own native download ID.');
  const files=[];
  for(const asset of [{name:'webbrain-qa-pixel.png',bytes:png,mime:'image/png'},{name:'viewer.htm',bytes:html,mime:'text/html'}]) {
    const remoteUrl=`${base}/${asset.name}`,owned=ownedReceipts.filter(d=>d.url===remoteUrl);
    assert.equal(owned.length,1,'Exactly one receipt must match the original owned remote URL.');
    assert.equal(owned[0].success,true);assert.equal(owned[0].finalUrl,remoteUrl);
    assert.ok(Number.isSafeInteger(owned[0].downloadId)&&owned[0].downloadId>=0);
    const matches=downloads.filter(d=>d.id===owned[0].downloadId);assert.equal(matches.length,1);
    const download=matches[0];assert.ok(download,`Missing owned ${asset.name} download`);
    assert.ok(download.url.startsWith(`blob:chrome-extension://${id}/`),'Native download must use this installed extension\'s staged local blob.');
    assert.equal(path.resolve(download.filename),path.resolve(owned[0].filename),'Receipt must identify the exact native saved file.');
    assert.deepEqual(assetRequests.filter(r=>r.path===`/${asset.name}`),[{method:'GET',path:`/${asset.name}`}],'Exactly one remote GET per asset; native saving must not fetch it again.');
    assert.equal(download.state,'complete');assert.equal(download.mime,asset.mime);
    assert.ok(path.resolve(download.filename).startsWith(path.resolve(downloadsPath)+path.sep),'Owned download must stay in the isolated download directory.');
    const bytes=await fs.readFile(download.filename);assert.deepEqual(bytes,asset.bytes);
    files.push({name:asset.name,remoteUrl,finalUrl:owned[0].finalUrl,nativeUrl:download.url,downloadId:download.id,state:download.state,mime:download.mime,bytes:bytes.length,sha256:sha(bytes)});
  }
  const sourceFinish=await captureSource(extension);const sourceStable=JSON.stringify(sourceStart.hashes)===JSON.stringify(sourceFinish.hashes);
  const blockedFetches=await worker.evaluate(()=>blockedFetches);
  await fs.writeFile(path.join(out,'source-finish.json'),JSON.stringify(sourceFinish,null,2));
  const nativeAttachments=await page.evaluate(()=>nativeAttachments);
  await fs.writeFile(path.join(out,'evidence.json'),JSON.stringify({result,events,current,stored,files,assetRequests,uploads,mismatches,viewerRequests,nativeAttachments,providerCalls:calls.length,sourceStable,blockedFetches},null,2));
  assert.equal(sourceStable,true);assert.equal(blockedFetches,0);assert.equal(mismatches.length,1);
  assert.equal(mismatches[0].success,false);assert.equal(mismatches[0].noDispatch,true);assert.equal(mismatches[0].dispatched,false);assert.equal(mismatches[0].outcomeUnknown,false);assert.equal(mismatches[0].reasonCode,'file_type_mismatch');assert.equal(mismatches[0].actualMime,'text/html');
  assert.equal(viewerRequests,1);assert.equal(downloads.length,2,'No unexpected or duplicate downloads.');assert.equal(uploads.length,1);assert.equal(uploads[0].containsExactPng,true);
  const savedImageReceipt=ownedReceipts.find(d=>d.url===`${base}/webbrain-qa-pixel.png`);
  const savedImage=downloads.find(d=>d.id===savedImageReceipt.downloadId);
  assert.deepEqual(nativeAttachments.map(e=>({type:e.type,trusted:e.trusted,name:e.name,size:e.size,sha256:e.sha256})),[{type:'input',trusted:true,name:path.basename(savedImage.filename),size:png.length,sha256:sha(png)},{type:'change',trusted:true,name:path.basename(savedImage.filename),size:png.length,sha256:sha(png)}]);
  const uploadResults=result.updates.filter(e=>e.type==='tool_result'&&e.data?.name==='upload_file');assert.equal(uploadResults.length,2);assert.equal(uploadResults[0].data.result.noDispatch,true);assert.equal(uploadResults[1].data.result.success,true);
  assert.equal(events.findLast(e=>e.type==='run_complete')?.data?.status,'completed');
  const done=result.updates.findLast(e=>e.type==='tool_result'&&e.data?.name==='done')?.data?.result;assert.equal(done?.done,true);assert.equal(done?.outcome,'success');
  for(const snapshot of [current.runUi,stored]){
    assert.equal(snapshot?.requestId,'qa-download-upload');assert.equal(snapshot?.status,'completed');
    assert.equal(snapshot?.successfulDone,true);assert.equal(snapshot?.runSucceeded,true);
  }
  assert.equal(current.running,false);
  console.log(JSON.stringify({passed:true,files,uploads:uploads.length,providerCalls:calls.length,htmlAttachmentEvents:0,actualImageAttachmentEvents:nativeAttachments.length,viewerRequests,sourceStable,sourceFiles:sourceStart.files,externalRequests:blockedFetches}));
} finally {
  await context?.close();await new Promise(resolve=>server.close(resolve));
  const resolved=await fs.realpath(profile);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'webbrain-download-upload-'))throw new Error('Unexpected profile path');
  await fs.rm(resolved,{recursive:true,force:true});
}
