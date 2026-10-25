import { chromium } from 'playwright';
import { BidiSession } from '../../firefox-companion/session.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const delay = ms => new Promise(r=>setTimeout(r,ms));
const operations = {
  setStorage: async json => (globalThis.browser || chrome).storage.local.set(JSON.parse(json)),
  sendMessage: async json => (globalThis.browser || chrome).runtime.sendMessage(JSON.parse(json)),
  enablePlanApproval: async () => {
    (globalThis.browser || chrome).runtime.onMessage.addListener(msg => {
      if (msg.action !== 'agent_update' || msg.type !== 'plan_review') return;
      (globalThis.browser || chrome).runtime.sendMessage({ target: 'background', action: 'plan_response', tabId: msg.tabId, planId: msg.data.planId, decision: 'approve' });
    });
  },
  createTab: async json => (globalThis.browser || chrome).tabs.create(JSON.parse(json)),
  startTrial: async json => {
    const message = JSON.parse(json), api = globalThis.browser || chrome;
    const trace = await import(api.runtime.getURL('src/trace/recorder.js'));
    await trace.clearAllRuns();
    globalThis.__jevTrial = { done: false };
    api.runtime.sendMessage(message).then(result => { globalThis.__jevTrial = { done: true, result }; }, error => { globalThis.__jevTrial = { done: true, error: String(error) }; });
  },
  getTrial: async () => globalThis.__jevTrial,
  getMetrics: async () => {
    const api = globalThis.browser || chrome;
    const trace = await import(api.runtime.getURL('src/trace/recorder.js'));
    const runs = await trace.listRuns({ limit: 10 });
    const events = (await Promise.all(runs.map(run => trace.getRunEvents(run.runId)))).flat();
    const notes = events.filter(event => event.kind === 'note' && event.data.note === 'system_one').map(event => event.data.extra);
    const cost = await api.storage.local.get('meteredProviderCostSpentUsd');
    return { llmCalls: events.filter(event => event.kind === 'llm_request').length, jevCalls: notes.filter(note => note?.decision === 'usage').length, fallbacks: notes.filter(note => note?.decision === 'fallback').length, modelCostUsd: cost.meteredProviderCostSpentUsd || 0 };
  },
  getFixture: async json => {
    const { tabId } = JSON.parse(json), api = globalThis.browser || chrome;
    if (globalThis.chrome?.scripting) {
      const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => JSON.parse(document.documentElement.dataset.fixtureResult || '{}') });
      return results[0]?.result;
    }
    const results = await api.tabs.executeScript(tabId, { code: "document.documentElement.dataset.fixtureResult||'{}'" });
    return JSON.parse(results[0]);
  },
  getStorageCost: async () => (globalThis.browser || chrome).storage.local.get('meteredProviderCostSpentUsd'),
  removeTab: async json => (globalThis.browser || chrome).tabs.remove(JSON.parse(json)),
};
export async function launchDriver(build) {
  const profile = await mkdtemp(join(tmpdir(),'jev-benchmark-'));
  let context,child,session,extensionPage,extensionContext,extensionOrigin;
  try {
    if (build==='chrome') {
      const extension=resolve('src/chrome');
      context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
      const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
      extensionOrigin=worker.url().split('/').slice(0,3).join('/');
      extensionPage=await context.newPage();await extensionPage.goto(`${extensionOrigin}/src/ui/settings.html`);
    } else {
      child=spawn(process.env.FIREFOX_BINARY||(process.platform==='darwin'?'/Applications/Firefox.app/Contents/MacOS/firefox':'firefox'),['--headless','--remote-allow-system-access','--no-remote','--profile',profile,'--remote-debugging-port','0'],{stdio:['ignore','pipe','pipe']});
      const port=await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error('Firefox BiDi startup timeout '+output.slice(-400))),20000);let output='';const outputChunk=chunk=>{output+=chunk;const m=output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);res(+m[1]);}};child.stderr.on('data',outputChunk);child.stdout.on('data',outputChunk);child.on('exit',code=>{clearTimeout(timer);rej(Error('Firefox exited: '+code+' '+output.slice(-400)));});child.on('error',error=>{clearTimeout(timer);rej(error);});});
      session=new BidiSession();await session.connect(port);await session.send('webExtension.install',{extensionData:{type:'path',path:resolve('src/firefox')}});
      for(let i=0;i<40;i++){const tree=await session.send('browsingContext.getTree',{});const ext=tree.contexts.find(c=>c.url?.startsWith('moz-extension://'));if(ext){extensionContext=ext.context;extensionOrigin=ext.url.split('/').slice(0,3).join('/');break;}await delay(100);}
      if(!extensionContext)throw Error('Firefox extension page unavailable');
    }
    const execute=async (operation, payload)=>{
      const serialized = JSON.stringify(payload ?? null);
      if(extensionPage)return extensionPage.evaluate(operations[operation], serialized);
      const functionDeclaration=`async json => JSON.stringify(await (${operations[operation].toString()})(json))`;
      const response=await session.send('script.callFunction',{target:{context:extensionContext},functionDeclaration,arguments:[{type:'string',value:serialized}],awaitPromise:true});
      if(response.type==='exception')throw Error(response.exceptionDetails.text);
      return JSON.parse(response.result.value ?? 'null');
    };
    const invoke=(action,data={})=>execute('sendMessage',{target:'background',action,...data});
    return {
      async configure(config,settings){
        await execute('setStorage',{...settings,actObservation:'accessibility'});
        await invoke('update_provider',{providerId:'openai',config:{...config,enabled:true,type:'openai',category:'cloud',providerName:'openai-compatible',apiProtocol:'chat_completions',supportsVision:false}});
        await invoke('set_active_provider',{providerId:'openai'});
        await execute('enablePlanApproval');
      },
      async trial({url,prompt,locale,variant,budgetUsd}){
        await execute('setStorage',{systemOneFastBrowser:variant==='jev',systemOneFastClassifications:variant==='jev',wbLocale:locale,costAllowanceTotalUsd:budgetUsd,meteredProviderCostSpentUsd:0});
        const tab=await execute('createTab',{url,active:true});
        try {
          await delay(300);
          await execute('startTrial',{target:'background',action:'chat',tabId:tab.id,text:prompt,mode:'act',foreground:true});
          const start=Date.now();let status;
          while(Date.now()-start<180000){status=await execute('getTrial');if(status?.done)break;await delay(250);}
          if(!status?.done)await invoke('abort',{tabId:tab.id});
          const elapsedMs=Date.now()-start;
          const metrics=await execute('getMetrics');
          const fixture=await execute('getFixture',{tabId:tab.id});
          const doneUpdates=(status?.result?.updates||[]).filter(u=>u.type==='tool_result'&&u.data?.name==='done'&&u.data.result?.done===true);
          const reportedOutcome=doneUpdates.at(-1)?.data.result.outcome;
          const success=!!fixture?.success&&!status?.error&&status?.done&&reportedOutcome==='success';
          return {...metrics,elapsedMs,success,reportedOutcome,fixtureSuccess:!!fixture?.success,wrong:fixture?.wrong||0,duplicates:Math.max(0,(fixture?.actions||0)-1),error:status?.error||(!status?.done?'timeout':null)};
        } finally {await execute('removeTab',tab.id).catch(()=>{});}
      },
      async getCost(){return (await execute('getStorageCost'))?.meteredProviderCostSpentUsd||0;},
      async close(){await context?.close();await session?.close();child?.kill();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});},
    };
  } catch(error){await context?.close();await session?.close();child?.kill();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});throw error;}
}
