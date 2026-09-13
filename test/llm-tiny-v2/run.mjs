#!/usr/bin/env node
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve,join } from 'node:path';
import { chromium } from 'playwright';
import { buildCases,SEEDS } from './cases.mjs';
import { manifest,verifyManifest,DEFAULT_LIMITS } from './lib/manifest.mjs';
import { createParticipant,makeInitialMessages,requestForTurn,parseAdapterActions,trimScreenshotHistory,chatCompletionsUrl,ADAPTER_METADATA } from './lib/adapters.mjs';
import { startFixtureServer } from './lib/fixture.mjs';
import { scoreTask,aggregate } from './lib/scoring.mjs';
import { observe,performAction,appendObservation,ended,isolatedPage } from './lib/browser.mjs';

const HERE=fileURLToPath(new URL('.',import.meta.url));
export function parseArgs(argv) {
  const allowed=new Set(['help','validate-only','allow-paid','config','adapter','model','base','api-key-env','name','split','seeds','only','tag','max-turns','max-actions','task-timeout','request-timeout','max-tokens']);
  const flags=new Set(['help','validate-only','allow-paid']),out={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i].replace(/^--/,'');
    if(!argv[i].startsWith('--')||!allowed.has(key))throw new Error(`Unknown option ${argv[i]}`);
    if(flags.has(key))out[key]=true;
    else {if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`Missing value for --${key}`);out[key]=argv[++i];}
  }
  return out;
}
function positive(value,fallback) {const n=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new Error('Limits must be positive integers');return n;}
export function selectCases(args) {
  const seeds=args.seeds?args.seeds.split(',').map(Number):SEEDS;
  if(seeds.some(s=>!SEEDS.includes(s)))throw new Error(`Use frozen seeds ${SEEDS.join(',')}`);
  const cases=buildCases({split:args.split||'heldout',seeds});
  if(!args.only)return cases;
  const wanted=new Set(args.only.split(',')),selected=cases.filter(c=>wanted.has(c.taskId)||wanted.has(c.id));
  for(const id of wanted)if(!selected.some(c=>c.id===id||c.taskId===id))throw new Error(`Unknown selected task ${id}`);
  return selected;
}
export function limitsFrom(args) {
  return {maxTurns:positive(args['max-turns'],DEFAULT_LIMITS.maxTurns),maxActions:positive(args['max-actions'],DEFAULT_LIMITS.maxActions),taskTimeoutMs:positive(args['task-timeout'],DEFAULT_LIMITS.taskTimeoutMs),requestTimeoutMs:positive(args['request-timeout'],DEFAULT_LIMITS.requestTimeoutMs),maxTokens:positive(args['max-tokens'],DEFAULT_LIMITS.maxTokens)};
}

async function endpointRequest(participant,body,signal) {
  const headers={'content-type':'application/json'};if(participant.apiKey)headers.authorization=`Bearer ${participant.apiKey}`;
  const started=Date.now();
  const response=await fetch(chatCompletionsUrl(participant.base),{method:'POST',headers,body:JSON.stringify(body),signal});
  if(!response.ok){await response.body?.cancel();throw new Error(`Endpoint HTTP ${response.status}`);}
  const result=await response.json();
  return {response:result,latencyMs:Date.now()-started};
}

export async function runCase({browser,server,participant,task,limits=DEFAULT_LIMITS,request=endpointRequest,onScreenshot=async()=>{}}) {
  const session=server.create(task),started=Date.now(),controller=new AbortController();
  let context,observation,status='max_turns',error=null,actionsTaken=0,turns=0;
  const trace=[],usage={prompt:0,completion:0,total:0,costUsd:0};
  const timer=setTimeout(()=>{controller.abort();context?.close().catch(()=>{});},limits.taskTimeoutMs);
  try {
    context=await isolatedPage(browser,session);
    const {page}=context;observation=await observe(page,participant);
    const messages=makeInitialMessages(participant,task.task,observation);
    loop:for(turns=1;turns<=limits.maxTurns;turns++) {
      if(controller.signal.aborted){status='task_timeout';break;}
      if(actionsTaken>=limits.maxActions){status='max_actions';break;}
      if(observation.screenshot)await onScreenshot(turns,observation.screenshot);
      trimScreenshotHistory(messages,3);
      const body=requestForTurn({...participant,maxTokens:limits.maxTokens},messages);
      let response,latencyMs;
      try {({response,latencyMs}=await request(participant,body,AbortSignal.any([controller.signal,AbortSignal.timeout(limits.requestTimeoutMs)])));}
      catch(e){usage.costUsd=null;status=controller.signal.aborted?'task_timeout':'endpoint_error';error=String(e.message).replaceAll(participant.apiKey||'\0','[redacted]');trace.push({turn:turns,status,error});break;}
      const u=response.usage||{};
      usage.prompt+=Number(u.prompt_tokens)||0;usage.completion+=Number(u.completion_tokens)||0;usage.total+=Number(u.total_tokens)||0;
      if(typeof u.cost==='number'&&Number.isFinite(u.cost)&&u.cost>=0){if(usage.costUsd!==null)usage.costUsd+=u.cost;}else usage.costUsd=null;
      const message=response.choices?.[0]?.message||{},actions=parseAdapterActions(participant.adapter,message),results=[];
      trace.push({turn:turns,latencyMs,response:message,usage:u});
      if(!actions.length){status='unparseable';break;}
      for(let i=0;i<actions.length;i++) {
        if(controller.signal.aborted){status='task_timeout';break loop;}
        if(actionsTaken>=limits.maxActions){status='max_actions';break loop;}
        const action=actions[i];actionsTaken++;
        try {
          const result=await performAction(page,observation,participant,action,session);results.push(result);
          trace.push({turn:turns,actionIndex:i,action,result});
        } catch(e) {
          results.push(`Action failed: ${String(e.message).slice(0,300)}. Observe again before retrying.`);
          trace.push({turn:turns,actionIndex:i,action,error:results.at(-1)});
          // Do not silently retarget stale indices or execute the rest of a failed batch.
          break;
        }
        // Judge only at task termination, NEVER auto-pass midway through a batch.
        // A later duplicate/forbidden action in the same returned batch must count.
        if(ended(action)) {status='agent_ended';break loop;}
      }
      if(session.state.violations.length){status='forbidden_action';break;}
      if(session.state.terminal){status='completed';break;}
      await observation.dispose();observation=await observe(page,participant);
      appendObservation(messages,participant,message,actions,results,observation);
    }
    if(!controller.signal.aborted&&!page.isClosed())await onScreenshot('final',await page.screenshot());
  } catch(e) {status=controller.signal.aborted?'task_timeout':'harness_error';error=String(e.message).replaceAll(participant.apiKey||'\0','[redacted]').slice(0,500);}
  finally {clearTimeout(timer);await observation?.dispose().catch(()=>{});await context?.close().catch(()=>{});session.dispose();}
  const score=scoreTask(task,session.state);
  // Operational failures and exhausted limits are failures even with correct partial UI state.
  const success=score.success&&['completed','agent_ended'].includes(status);
  return {id:task.id,taskId:task.taskId,category:task.category,split:task.split,seed:task.seed,success,status:success?'passed':status,error,score,turns:Math.min(turns,limits.maxTurns),actions:actionsTaken,latencyMs:Date.now()-started,usage,state:session.state,trace};
}

export async function main(argv=process.argv.slice(2)) {
  const args=parseArgs(argv);
  if(args.help){console.log(`LLM tiny v2 — isolated reasoning-heavy browser benchmark

Safe local validation (no model calls):
  node test/llm-tiny-v2/run.mjs --validate-only
  node --test --test-concurrency=1 test/llm-tiny-v2/*.test.mjs test/llm-tiny-v2/lib/*.test.mjs

Live execution requires separate budget approval and explicit --allow-paid:
  node test/llm-tiny-v2/run.mjs --allow-paid --config /private/participants.json --split pilot --seeds 17 --tag pilot-01

Single participant: --adapter openai|compass|browser-use|fara --model NAME --base URL --api-key-env ENV
Selection: --split pilot|heldout --seeds 17,43,89 --only TASK_IDS --tag UNIQUE_NAME
Limits (identical for every participant): --max-turns 80 --max-actions 120
  --task-timeout 900000 --request-timeout 90000 --max-tokens 4096
No provider provisioning, background monitors, or changes to test/llm-tiny.
`);return;}
  const manifestHash=await verifyManifest(),cases=selectCases(args),limits=limitsFrom(args);
  if(args['validate-only']){const data=await manifest();console.log(`Validated frozen ${data.version}: ${data.cases.length} variants (60 held-out + 10 pilot tasks, three seeds). Selected ${cases.length}. No endpoints called.`);return;}
  if(!args['allow-paid'])throw new Error('No model calls made. Live execution requires --allow-paid and separate approval within the remaining hard spending cap.');
  const inputs=args.config?JSON.parse(await readFile(resolve(args.config),'utf8')).participants:[{name:args.name,adapter:args.adapter,model:args.model,base:args.base,apiKeyEnv:args['api-key-env']}];
  if(!Array.isArray(inputs)||!inputs.length)throw new Error('Config requires participants');
  const participants=inputs.map(input=>{
    if(input.apiKey)throw new Error('Use apiKeyEnv, not an inline API key');
    if(input.apiKeyEnv&&!process.env[input.apiKeyEnv])throw new Error(`Missing credential environment variable ${input.apiKeyEnv}`);
    if(input.extraBody&&/"(?:api_key|apiKey|authorization|password|secret|access_token)"\s*:/i.test(JSON.stringify(input.extraBody)))throw new Error('Do not put credentials in extraBody');
    if(input.noScreenshot)throw new Error('Text-only baseline changes the protocol; use the native Compass adapter for text-only runs');
    const p=createParticipant({...input,timeoutMs:limits.requestTimeoutMs,maxTokens:limits.maxTokens});
    if(!input.name)p.name=p.name.replace(/[^a-zA-Z0-9._-]+/g,'-');
    const url=new URL(p.base);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Endpoint must be HTTP(S) with no embedded secrets, query, or fragment');
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p.name))throw new Error('Set a simple unique participant name');
    return p;
  });
  if(new Set(participants.map(p=>p.name)).size!==participants.length)throw new Error('Participant names must be unique');
  const tag=args.tag||new Date().toISOString().replace(/[:.]/g,'-');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tag))throw new Error('Invalid result tag');
  const root=join(HERE,'results');await mkdir(root,{recursive:true});
  const out=join(root,tag);await mkdir(out); // Exclusive: an existing run can never be overwritten.
  const protocol={manifestHash,limits,split:args.split||'heldout',caseIds:cases.map(c=>c.id),screenshotHistory:3};
  await writeFile(join(out,'protocol.json'),JSON.stringify(protocol,null,2));
  const server=await startFixtureServer();let browser;
  try {
    browser=await chromium.launch({headless:true});
    for(const participant of participants) {
      const dir=join(out,participant.name);await mkdir(dir);const results=[];
      const {messages:unusedMessages,tools:unusedTools,...requestSettings}=requestForTurn(participant,[]);
      const metadata={name:participant.name,model:participant.model,adapter:participant.adapter,endpoint:chatCompletionsUrl(participant.base),requestSettings,...ADAPTER_METADATA[participant.adapter]};
      await writeFile(join(dir,'participant.json'),JSON.stringify(metadata,null,2));
      for(const task of cases) {
        const result=await runCase({browser,server,participant,task,limits,onScreenshot:(step,buffer)=>writeFile(join(dir,`${task.id}-${step}.png`),buffer)});
        results.push(result);await writeFile(join(dir,`${task.id}.json`),JSON.stringify(result,null,2));
        const summary={...metadata,protocol,...aggregate(results),complete:results.length===cases.length,results};
        await writeFile(join(dir,'summary.json'),JSON.stringify(summary,null,2));
        console.log(`${participant.name} ${task.id} ${result.status} (${result.actions} actions)`);
      }
    }
  } finally {await browser?.close();await server.close();}
  console.log(`Results: ${out}`);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
