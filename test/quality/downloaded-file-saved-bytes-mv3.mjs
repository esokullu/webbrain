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
const out=path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/downloaded-file-saved-bytes-mv3');
await fs.mkdir(out,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=','base64');
function makePdf() {
  const stream='BT /F1 14 Tf 40 740 Td (WebBrain PDF download and upload QA.) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))text+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  return Buffer.from(text+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const pdf=makePdf(),changedPdf=Buffer.from(makePdf().toString().replace('QA.)', 'QB.)')),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const pageHtml='<!doctype html><title>Owned attachment QA</title><h1>Download and upload QA</h1><form><label>QA PDF attachment <input name="attachment" type="file" required accept="application/pdf"></label><button>Submit QA attachment</button></form><p role="status" id="result"></p><script>document.querySelector("form").onsubmit=async e=>{e.preventDefault();const r=await fetch("/upload",{method:"POST",body:new FormData(e.target)});if(r.ok)document.querySelector("#result").textContent="QA attachment saved";};</script>';
let base,submitRef,actionCalls=0,sourceChanged=false,pdfRequests=0; const uploads=[],calls=[],assetRequests=[];
const sourceReads=[];
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
  if(req.url==='/webbrain-qa-pixel.png'||req.url==='/webbrain-qa-report.pdf') {
    assetRequests.push({method:req.method,path:req.url});
    const isPdf=req.url.endsWith('.pdf');if(isPdf)pdfRequests++;const bytes=isPdf?(sourceChanged?changedPdf:pdf):png;
    res.writeHead(200,{'Content-Type':isPdf?'application/pdf':'image/png','Content-Length':bytes.length,'Content-Disposition':`attachment; filename="${isPdf?'webbrain-qa-report.pdf':'webbrain-qa-pixel.png'}"`});res.end(bytes);return;
  }
  if(req.url==='/upload') {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),start=body.indexOf(Buffer.from('%PDF-1.4'));
    uploads.push({containsExactPdf:start>=0&&body.subarray(start,start+pdf.length).equals(pdf),contentType:req.headers['content-type']});
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
    else if(judge)message={role:'assistant',content:JSON.stringify({outcome:'uncertain',reason:'Require browser-native downloads and actual attachment submission evidence.'})};
    else if(!action)message={role:'assistant',content:JSON.stringify({request_kind:'execute',scope_relation:'new',deliverables:['Download both exact QA assets and submit the downloaded PDF to the QA form'],requires_state_change:true,requires_submission:true,messaging:null,completion_requirements:{download:true},allows_planner_shaped_result:false,allows_app_state_tool_evidence:false,read_scope:'visible_page',summary:'Download exact PNG and PDF, attach only the PDF and verify one submission.',steps:[{id:'1',action:'Download and verify both files, upload PDF to the owned form, submit once and verify.'}],memory:{use_progress_ledger:false,progress_action:null},scheduling:null,risks:[]})};
    else {
      let downloadId;
      for(const item of input.messages||[])if(item.role==='tool') {
        const content=typeof item.content==='string'?item.content:JSON.stringify(item.content);
        try{const data=JSON.parse(content.slice(content.indexOf('{'),content.lastIndexOf('}')+1));downloadId??=data.downloads?.find(d=>d.url===`${base}/webbrain-qa-report.pdf`)?.downloadId;}catch{}
      }
      if(actionCalls===1&&!downloadId)await fs.writeFile(path.join(out,'provider-tool-diagnostic.json'),JSON.stringify(input.messages.filter(m=>m.role==='tool'),null,2));
      const steps=[{name:'download_files',args:{urls:[`${base}/webbrain-qa-pixel.png`,`${base}/webbrain-qa-report.pdf`]}},
        {name:'read_downloaded_file',args:{downloadId}},
        {name:'upload_file',args:{selector:'input[name="attachment"]',downloadId}},
        {name:'get_accessibility_tree',args:{filter:'visible'}},
        {name:'click_ax',args:{ref_id:submitRef}},
        {name:'read_page',args:{limit:3000}},
        {name:'done',args:{summary:'Both QA files downloaded and the exact PDF was submitted once.',outcome:'success'}}];
      const step=steps[actionCalls++]||steps.at(-1);
      if(step.name==='read_downloaded_file')sourceChanged=true;
      for(const item of input.messages||[])if(item.role==='tool'&&item.tool_call_id==='download-upload-2'){try{const c=typeof item.content==='string'?item.content:JSON.stringify(item.content);const r=JSON.parse(c.slice(c.indexOf('{'),c.lastIndexOf('}')+1));if(!sourceReads.length)sourceReads.push(r);}catch{}}
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
  const result=await message('chat',{tabId,text:`Download exactly ${base}/webbrain-qa-pixel.png and ${base}/webbrain-qa-report.pdf. Read the actual saved PDF bytes using read_downloaded_file even if its source changes. Attach the downloaded PDF to this owned QA form, submit exactly once and verify QA attachment saved. Do not upload the PNG or any other file.`,mode:'act',requestId:'qa-download-upload',locale:'en'});
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
  assert.equal(downloadResults.length,1,'Exactly one owned download_files result must identify both native downloads.');
  const receipt=downloadResults[0].data.result;
  assert.equal(receipt.success,true);assert.equal(receipt.succeeded,2);assert.equal(receipt.failed,0);
  assert.equal(receipt.downloads.length,2);
  const ownedReceipts=receipt.downloads;
  assert.equal(new Set(ownedReceipts.map(d=>d.downloadId)).size,2,'Each asset must have its own native download ID.');
  const files=[];
  for(const asset of [{name:'webbrain-qa-pixel.png',bytes:png,mime:'image/png'},{name:'webbrain-qa-report.pdf',bytes:pdf,mime:'application/pdf'}]) {
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
  await fs.writeFile(path.join(out,'evidence.json'),JSON.stringify({result,events,current,stored,files,assetRequests,uploads,sourceReads,sourceChanged,pdfRequests,providerCalls:calls.length,sourceStable,blockedFetches},null,2));
  assert.equal(sourceStable,true);assert.equal(blockedFetches,0);assert.equal(sourceChanged,true);assert.equal(sourceReads.length,1);
  assert.equal(sourceReads[0].success,true);assert.equal(sourceReads[0].base64,pdf.toString('base64'),'Read must return the real saved PDF A after the URL becomes B');
  assert.equal(sourceReads[0].contentSource,'saved_local_file');assert.equal(sourceReads[0].savedFileVerified,true);assert.equal(sourceReads[0].sourceRefetched,false);assert.equal(pdfRequests,1,'No second HTTP request may inspect the mutable download URL');
  assert.equal(downloads.length,2,'No unexpected or duplicate downloads.');assert.equal(uploads.length,1);assert.equal(uploads[0].containsExactPdf,true);
  assert.equal(events.findLast(e=>e.type==='run_complete')?.data?.status,'completed');
  const done=result.updates.findLast(e=>e.type==='tool_result'&&e.data?.name==='done')?.data?.result;assert.equal(done?.done,true);assert.equal(done?.outcome,'success');
  for(const snapshot of [current.runUi,stored]){
    assert.equal(snapshot?.requestId,'qa-download-upload');assert.equal(snapshot?.status,'completed');
    assert.equal(snapshot?.successfulDone,true);assert.equal(snapshot?.runSucceeded,true);
  }
  assert.equal(current.running,false);
  console.log(JSON.stringify({passed:true,files,uploads:uploads.length,providerCalls:calls.length,savedReadMatchesOriginal:true,sourceRequests:pdfRequests,sourceStable,sourceFiles:sourceStart.files,externalRequests:blockedFetches}));
} finally {
  await context?.close();await new Promise(resolve=>server.close(resolve));
  const resolved=await fs.realpath(profile);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'webbrain-download-upload-'))throw new Error('Unexpected profile path');
  await fs.rm(resolved,{recursive:true,force:true});
}
