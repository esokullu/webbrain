import test from 'node:test';
import assert from 'node:assert/strict';
for (const browser of ['chrome','firefox']) {
 const {retryModelCall,retryAfterMs}=await import(`../src/${browser}/src/providers/model-retry.js`);
 const {OpenAICompatibleProvider}=await import(`../src/${browser}/src/providers/openai.js`);
 const limited=(hint=null)=>Object.assign(new Error('HTTP 429'),{httpStatus:429,retryAfterMs:hint});
 test(`${browser}: retry inference with growing cooldowns without replaying tools`,async()=>{
  const waits=[],notes=[],order=[];let inference=0,toolsAlreadyExecuted=1;
  const answer=await retryModelCall(limited(),async()=>{order.push('inference');inference++;if(inference===1)throw limited();return {toolCalls:[]};},{sleep:async ms=>{order.push('wait');waits.push(ms);},onRetry:async note=>{await Promise.resolve();order.push('record');notes.push(note);}});
  assert.deepEqual(answer,{toolCalls:[]});assert.deepEqual(waits,[5000,15000]);
  assert.equal(inference,2);assert.equal(toolsAlreadyExecuted,1);assert.deepEqual(notes.map(n=>n.attempt),[1,2]);
  assert.deepEqual(order,['record','wait','inference','record','wait','inference']);
 });
 test(`${browser}: persistent quota exhaustion stops after three recovery requests`,async()=>{
  let calls=0;const waits=[];
  await assert.rejects(retryModelCall(limited(),async()=>{calls++;throw limited();},{sleep:async ms=>waits.push(ms)}),/HTTP 429/);
  assert.equal(calls,3);assert.deepEqual(waits,[5000,15000,30000]);
 });
 test(`${browser}: honor Retry-After and reject cooldowns beyond the recovery budget`,async()=>{
  const now=Date.parse('2026-10-06T18:00:00Z');
  assert.equal(retryAfterMs('10',now),10000);assert.equal(retryAfterMs('Tue, 06 Oct 2026 18:00:20 GMT',now),20000);
  assert.equal(retryAfterMs('nonsense',now),null);assert.equal(retryAfterMs(null,now),null);
  const waits=[];await retryModelCall(limited(12000),async()=> 'OK',{sleep:async ms=>waits.push(ms)});assert.deepEqual(waits,[12000]);
  await assert.rejects(retryModelCall(limited(120000),async()=>assert.fail('Do not call before cooldown'),{sleep:async()=>assert.fail('Do not hold the browser indefinitely')}),/HTTP 429/);
 });
 test(`${browser}: cancellation during cooldown prevents another inference request`,async()=>{
  let aborted=false,calls=0;
  await assert.rejects(retryModelCall(limited(),async()=>{calls++;},{isAborted:()=>aborted,sleep:async()=>{aborted=true;}}),e=>e.name==='AbortError');
  assert.equal(calls,0);
 });
 test(`${browser}: a different error stops rate-limit recovery; other errors retain one retry`,async()=>{
  let calls=0;
  await assert.rejects(retryModelCall(limited(),async()=>{calls++;throw Object.assign(new Error('model missing'),{httpStatus:404});},{sleep:async()=>{}}),/model missing/);assert.equal(calls,1);
  const waits=[];calls=0;await assert.rejects(retryModelCall(new Error('network'),async()=>{calls++;throw new Error('still offline');},{sleep:async ms=>waits.push(ms)}),/still offline/);
  assert.equal(calls,1);assert.deepEqual(waits,[2000]);
 });
 test(`${browser}: real provider HTTP responses carry cooldown metadata and preserve request/tool choice`,async()=>{
  const native=globalThis.fetch,requests=[];
  globalThis.fetch=async(_url,options)=>{
   requests.push(JSON.parse(options.body));
   return requests.length===1?new Response('upstream capacity limit',{status:429,headers:{'Retry-After':'10'}}):Response.json({choices:[{finish_reason:'stop',message:{content:'OK'}}]});
  };
  try{
   const p=new OpenAICompatibleProvider({providerName:'webbrain_me',baseUrl:'https://openrouter.ai/api/v1',model:'inclusionai/ling-3.1-flash'});
   const opts={tools:[{type:'function',function:{name:'read_page',parameters:{type:'object',properties:{}}}}],toolChoice:'required'};
   let first;try{await p.chat([{role:'user',content:'Read this page'}],opts);}catch(e){first=e;}
   assert.equal(first.httpStatus,429);assert.equal(first.retryAfterMs,10000);
   const result=await retryModelCall(first,()=>p.chat([{role:'user',content:'Read this page'}],opts),{sleep:async()=>{}});
   assert.equal(result.content,'OK');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(requests[1].tool_choice,'required');
  }finally{globalThis.fetch=native;}
 });
}
