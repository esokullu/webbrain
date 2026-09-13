import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { buildCases } from './cases.mjs';
import { startFixtureServer } from './lib/fixture.mjs';
import { scoreTask } from './lib/scoring.mjs';
import { observe,performAction,isolatedPage } from './lib/browser.mjs';
import { createParticipant } from './lib/adapters.mjs';
import { runCase } from './run.mjs';
import { DEFAULT_LIMITS } from './lib/manifest.mjs';

test('all 70 tasks are completable through rendered browser controls (no model)',{timeout:180000},async()=>{
  const browser=await chromium.launch({headless:true}),server=await startFixtureServer();
  try {
    for(const task of [...buildCases({seeds:[17]}),...buildCases({split:'pilot',seeds:[17]})]) {
      const session=server.create(task),context=await isolatedPage(browser,session),page=context.page;
      try {
        const errors=[];page.on('pageerror',e=>errors.push(e.message));
        for(const p of task.pages) {await page.getByRole('button',{name:p.title,exact:true}).click();await page.getByRole('heading',{name:p.title,exact:true}).waitFor();}
        await page.getByRole('button',{name:'Work area',exact:true}).click();
        for(const s of task.stages) {
          if(s.rejectOnce) {await page.getByRole('button',{name:s.submitLabel||'Submit step',exact:true}).click();assert.equal(await page.locator('#status').innerText(),s.rejectOnce);}
          if(s.cards) {await page.locator('article').filter({hasText:`Code ${s.expected.code} ·`}).getByRole('button',{name:'Choose',exact:true}).click();}
          else {
            for(const f of s.fields) {const input=page.getByLabel(f.label,{exact:true});if(f.options)await input.selectOption({label:s.expected[f.key]});else await input.fill(s.expected[f.key]);}
            await page.getByRole('button',{name:s.submitLabel||'Submit step',exact:true}).click();
          }
        }
        if(task.ambiguousCommit) {await page.getByRole('button',{name:'Receipt ledger',exact:true}).click();await page.getByRole('button',{name:'Acknowledge receipt',exact:true}).click();}
        assert.equal(scoreTask(task,session.state).success,true,task.id);
        assert.deepEqual(errors,[],task.id);
      } finally {await context.close();session.dispose();}
    }
  } finally {await browser.close();await server.close();}
});

test('observation includes visible evidence, excludes hidden controls and stale handles',{timeout:15000},async()=>{
  const browser=await chromium.launch({headless:true}),server=await startFixtureServer();
  const task=buildCases({seeds:[17]})[0],session=server.create(task),context=await isolatedPage(browser,session),page=context.page;
  const participant=createParticipant({adapter:'openai',model:'fake/model',base:'http://unused',name:'local'});
  let observation;
  try {
    await page.getByRole('button',{name:'Candidates',exact:true}).click();observation=await observe(page,participant);
    assert.match(observation.browserUse,/Shipping dollars/);assert.match(observation.browserUse,/Sanctioned/);
    assert.ok(observation.elements.every(e=>e.tag!=='input')); // hidden form action/view inputs excluded
    assert.doesNotMatch(observation.browserUse,/expected|caseSeed|"stages"/);
    const work=observation.elements.find(e=>e.label==='Work area');
    await performAction(page,observation,participant,{name:'click',args:{index:work.index}},session);
    await assert.rejects(()=>performAction(page,observation,participant,{name:'click',args:{index:work.index}},session),/Stale|destroyed|context|detached/i);
    await assert.rejects(()=>page.goto('http://127.0.0.1:9/not-this-session'));
    assert.ok(session.state.violations.includes('external_navigation'));
  } finally {await observation?.dispose();await context.close();await browser.close();await server.close();}
});

test('Fara can operate the in-page dropdown by screenshot-space coordinates',{timeout:15000},async()=>{
  const browser=await chromium.launch({headless:true}),server=await startFixtureServer();
  const task=buildCases({seeds:[17]}).find(c=>c.category==='workflow'),session=server.create(task),context=await isolatedPage(browser,session),page=context.page;
  const participant=createParticipant({adapter:'fara',model:'microsoft/Fara1.5-4B',base:'http://unused'});
  try {
    await page.getByRole('button',{name:'Work area',exact:true}).click();
    for(const s of task.stages.slice(0,4)){for(const f of s.fields)await page.getByLabel(f.label,{exact:true}).fill(s.expected[f.key]);await page.getByRole('button',{name:'Submit step',exact:true}).click();}
    await page.getByLabel('department',{exact:true}).fill(task.stages[4].expected.department);
    await page.getByLabel('status',{exact:true}).click();
    const rect=await page.getByRole('option',{name:'draft',exact:true}).boundingBox();assert.ok(rect&&rect.y+rect.height<900);
    await performAction(page,null,participant,{name:'computer_use',args:{action:'left_click',coordinate:[(rect.x+rect.width/2)/1440*1000,(rect.y+rect.height/2)/900*1000]}},session);
    assert.equal(await page.getByLabel('status',{exact:true}).inputValue(),'draft');
  } finally {await context.close();await browser.close();await server.close();}
});

function lastText(body) {
  return [...body.messages].reverse().filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:m.content.filter(p=>p.type==='text').map(p=>p.text).join('\n')).find(t=>t.includes('Current controls:'));
}
function indexOf(body,label) {
  const line=lastText(body).split('\n').find(l=>l.includes(`> ${JSON.stringify(label)}`));
  assert.ok(line,`Missing label ${label}`);return Number(line.match(/^\[(\d+)\]/)[1]);
}
const response=actions=>({response:{choices:[{message:{role:'assistant',content:null,tool_calls:actions.map((a,i)=>({id:`call-${i}`,type:'function',function:{name:a.name,arguments:JSON.stringify(a.args)}}))}}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}},latencyMs:1});

test('complete runner works offline, records missing cost and counts batched actions',{timeout:15000},async()=>{
  const browser=await chromium.launch({headless:true}),server=await startFixtureServer();
  const task=buildCases({split:'pilot',seeds:[17]}).find(c=>c.category==='calculation');
  const participant=createParticipant({adapter:'openai',model:'scripted-test',name:'scripted',base:'http://unused'});
  try {
    let calls=0;
    const request=async(p,body)=>{
      calls++;
      if(calls===1)return response([{name:'click',args:{index:indexOf(body,'Work area')}}]);
      return response([{name:'input',args:{index:indexOf(body,'answer'),text:task.stages[0].expected.answer}},{name:'click',args:{index:indexOf(body,'Submit step')}}]);
    };
    const result=await runCase({browser,server,participant,task,request});
    assert.equal(result.success,true);assert.equal(result.actions,3);assert.equal(calls,2);assert.equal(result.usage.costUsd,null);
    calls=0;
    const limited=await runCase({browser,server,participant,task,request,limits:{...DEFAULT_LIMITS,maxActions:2}});
    assert.equal(limited.success,false);assert.equal(limited.status,'max_actions');assert.equal(limited.actions,2);
  } finally {await browser.close();await server.close();}
});

test('claiming done is not success, endpoint errors remain failures',{timeout:15000},async()=>{
  const browser=await chromium.launch({headless:true}),server=await startFixtureServer(),task=buildCases({seeds:[17]})[0];
  const participant=createParticipant({adapter:'openai',model:'scripted',base:'http://unused'});
  try {
    const done=await runCase({browser,server,participant,task,request:async()=>response([{name:'done',args:{summary:'Everything succeeded'}}])});
    assert.equal(done.success,false);assert.equal(done.status,'agent_ended');
    const error=await runCase({browser,server,participant,task,request:async()=>{throw new Error('offline fake error');}});
    assert.equal(error.status,'endpoint_error');assert.equal(error.usage.costUsd,null);
  } finally {await browser.close();await server.close();}
});

test('native Compass, Browser Use and Fara protocols complete the offline loop',{timeout:20000},async()=>{
  const browser=await chromium.launch({headless:true}),server=await startFixtureServer();
  const task=buildCases({split:'pilot',seeds:[17]}).find(c=>c.category==='calculation');
  try {
    for(const adapter of ['compass','browser-use','fara']) {
      const participant=createParticipant({adapter,model:adapter==='fara'?'microsoft/Fara1.5-4B':undefined,base:'http://unused'});
      let calls=0;
      const request=async(p,body)=>{
        const turn=calls++;
        const hasImage=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(part=>part.type==='image_url'));
        assert.equal(hasImage,adapter!=='compass');
        let content;
        if(adapter==='fara') {
          // Golden test driver only: coordinates come from this test's own disposable browser.
          // The actual runner gives Fara no DOM access.
          const page=browser.contexts().at(-1).pages()[0];let args;
          if(turn===2)args={action:'type',text:task.stages[0].expected.answer};
          else {
            const locator=turn===0?page.getByRole('button',{name:'Work area',exact:true}):turn===1?page.getByLabel('answer',{exact:true}):page.getByRole('button',{name:'Submit step',exact:true});
            const rect=await locator.boundingBox();assert.ok(rect);
            args={action:'left_click',coordinate:[(rect.x+rect.width/2)/1440*1000,(rect.y+rect.height/2)/900*1000]};
          }
          content=`<tool_call>${JSON.stringify({name:'computer_use',arguments:args})}</tool_call>`;
        } else {
          const label=turn===0?'Work area':turn===1?'answer':'Submit step';
          const line=lastText(body).split('\n').find(l=>l.includes(`> ${JSON.stringify(label)}`));assert.ok(line);
          if(adapter==='compass') {
            const ref=line.match(/^(ref_\d+)/)[1];
            content=`<function name="${turn===1?'set_field':'click_ax'}"><param name="ref_id">${ref}</param>${turn===1?`<param name="text">${task.stages[0].expected.answer}</param>`:''}</function>`;
          } else content=JSON.stringify({action:[{[turn===1?'input':'click']:{index:Number(line.match(/^\[(\d+)\]/)[1]),...(turn===1?{text:task.stages[0].expected.answer}:{})}}]});
        }
        return {response:{choices:[{message:{content}}]},latencyMs:1};
      };
      const result=await runCase({browser,server,participant,task,request});
      assert.equal(result.success,true,`${adapter}: ${JSON.stringify(result.trace)}`);
    }
  } finally {await browser.close();await server.close();}
});
