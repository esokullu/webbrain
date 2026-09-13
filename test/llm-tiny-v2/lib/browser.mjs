import { makeNextObservation, normalizeComputerKey } from './adapters.mjs';

export const VIEWPORT=Object.freeze({width:1440,height:900});
const SELECTOR='button,input,select,textarea,a,[role="button"]';

export async function observe(page,participant) {
  const snapshot=await page.evaluate(selector=>{
    const visible=element=>{
      const r=element.getBoundingClientRect(),s=getComputedStyle(element);
      return element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&s.display!=='none'&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;
    };
    const elements=[...document.querySelectorAll(selector)].flatMap((element,domIndex)=>{
      if(!visible(element))return [];
      const label=element.getAttribute('aria-label')||[...(element.labels||[])].map(l=>l.innerText).join(' ')||element.innerText||'';
      return [{domIndex,tag:element.tagName.toLowerCase(),label:label.replace(/\s+/g,' ').trim(),value:element.value||'',
        context:element.closest('article')?.innerText.replace(/\s+/g,' ')||'',
        options:element instanceof HTMLSelectElement?[...element.options].map(o=>o.text):undefined}];
    }).map((e,i)=>({...e,index:i+1,refId:`ref_${i+1}`}));
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const lines=[];
    while(walker.nextNode()) {
      const node=walker.currentNode,parent=node.parentElement;
      if(!parent||parent.closest('script,style,option,select')||!visible(parent)||!node.textContent.trim())continue;
      const range=document.createRange();range.selectNodeContents(node);
      if([...range.getClientRects()].some(r=>r.width&&r.height&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth))lines.push(node.textContent.trim());
    }
    return {elements,text:lines.join('\n')};
  },SELECTOR);
  const allHandles=await page.$$(SELECTOR);
  const handles=new Map(snapshot.elements.map(e=>[e.index,allHandles[e.domIndex]]));
  const describe=withRef=>snapshot.elements.map(e=>`${withRef?e.refId:`[${e.index}]`} <${e.tag}> ${JSON.stringify(e.label)}${e.value?` value=${JSON.stringify(e.value)}`:''}${e.context?` context=${JSON.stringify(e.context)}`:''}${e.options?` options=${JSON.stringify(e.options)}`:''}`).join('\n');
  const screenshot=participant.adapter==='compass'||participant.noScreenshot?null:await page.screenshot({type:'png'});
  const image=screenshot?`data:image/png;base64,${screenshot.toString('base64')}`:null;
  return {...snapshot,handles,screenshot,
    browserUse:`Visible viewport text:\n${snapshot.text}\n\nCurrent controls:\n${describe(false)}`,
    accessibility:`Visible viewport text:\n${snapshot.text}\n\nCurrent controls:\n${describe(true)}`,
    withImage:text=>image?[{type:'text',text},{type:'image_url',image_url:{url:image}}]:text,
    dispose:async()=>{await Promise.all(allHandles.map(h=>h.dispose().catch(()=>{})));},
  };
}

function boundElement(observation,value,isRef=false) {
  const element=observation.elements.find(e=>isRef?e.refId===value:e.index===Number(value));
  if(!element)throw new Error('Element is not in the current visible observation; scroll or observe again.');
  return {element,handle:observation.handles.get(element.index)};
}
async function indexed(page,observation,name,args) {
  if(['get_page_state','get_accessibility_tree'].includes(name))return 'Current state read.';
  if(name==='done')return 'Agent ended the task.';
  if(name==='scroll') {await page.mouse.wheel(0,Math.max(-1800,Math.min(1800,Number(args.pixels)||700)));await page.waitForTimeout(100);return 'Scrolled.';}
  const isRef=['click_ax','set_field','type_ax','select_option'].includes(name);
  const {handle,element}=boundElement(observation,isRef?args.ref_id:args.index,isRef);
  if(!await handle.evaluate(el=>el.isConnected))throw new Error('Stale element after navigation; request a fresh observation.');
  if(['click','click_ax'].includes(name))await handle.click({timeout:2500});
  else if(['input','set_field','type_ax'].includes(name))await handle.fill(String(args.text??''),{timeout:2500});
  else if(['select','select_option'].includes(name))await handle.selectOption({label:String(args.text)},{timeout:2500});
  else throw new Error(`Unsupported indexed action: ${name}`);
  await page.waitForLoadState('domcontentloaded');
  return `${name} on ${element.label}.`;
}

function point(coordinate) {
  if(!Array.isArray(coordinate)||coordinate.length!==2||coordinate.some(n=>!Number.isFinite(n)||n<0||n>1000))throw new Error('Coordinates must be within the 1000x1000 display.');
  return {x:coordinate[0]*VIEWPORT.width/1000,y:coordinate[1]*VIEWPORT.height/1000};
}
async function fara(page,args,session) {
  switch(args.action) {
    case 'left_click':case 'double_click':case 'triple_click':case 'right_click': {
      const {x,y}=point(args.coordinate);
      await page.mouse.click(x,y,{clickCount:args.action==='double_click'?2:args.action==='triple_click'?3:1,button:args.action==='right_click'?'right':'left'});break;
    }
    case 'mouse_move': {const {x,y}=point(args.coordinate);await page.mouse.move(x,y);break;}
    case 'left_click_drag': {const {x,y}=point(args.coordinate);await page.mouse.down();try{await page.mouse.move(x,y);}finally{await page.mouse.up();}break;}
    case 'type':await page.keyboard.insertText(String(args.text??''));break;
    case 'key':await page.keyboard.press(normalizeComputerKey((Array.isArray(args.keys)?args.keys:[args.keys]).filter(Boolean).join('+'),process.platform));break;
    case 'scroll':await page.mouse.wheel(0,-Math.max(-2000,Math.min(2000,Number(args.pixels)||0))*VIEWPORT.height/1000);await page.waitForTimeout(100);break;
    case 'hscroll':await page.mouse.wheel(-Math.max(-2000,Math.min(2000,Number(args.pixels)||0))*VIEWPORT.width/1000,0);break;
    case 'visit_url':if(args.url!==session.url){session.state.violations.push('external_navigation');throw new Error('Navigation is limited to this exact fixture session.');}await page.goto(session.url);break;
    case 'history_back':await page.goBack({waitUntil:'domcontentloaded'});break;
    case 'wait':await page.waitForTimeout(Math.min(5,Math.max(0,Number(args.time)||0))*1000);break;
    case 'pause_and_memorize_fact':return `Remembered: ${args.fact||''}`;
    case 'terminate':return 'Agent ended the task.';
    case 'ask_user_question':return 'No human assistance is available for this self-contained task.';
    default:throw new Error(`Unsupported Fara action: ${args.action}`);
  }
  // Mouse/keyboard primitives do not auto-wait for navigation like Locator.click.
  if(['left_click','double_click','triple_click','key'].includes(args.action))await page.waitForTimeout(75);
  await page.waitForLoadState('domcontentloaded');
  return `Executed ${args.action}.`;
}

export async function performAction(page,observation,participant,action,session) {
  const args=action.args||{};
  if(participant.adapter==='fara')return fara(page,args,session);
  if(participant.adapter==='browser-use') {
    if(action.name==='select_dropdown')return indexed(page,observation,'select',args);
    if(action.name==='dropdown_options')return JSON.stringify(boundElement(observation,args.index).element.options||[]);
    if(action.name==='send_keys'){await page.keyboard.press(normalizeComputerKey(args.keys||'Enter',process.platform));await page.waitForLoadState('domcontentloaded');return 'Pressed keys.';}
    if(action.name==='scroll')return indexed(page,observation,'scroll',{pixels:(args.down===false?-1:1)*700*Math.min(2,Math.max(1,Number(args.pages)||1))});
  }
  return indexed(page,observation,action.name,args);
}

export function ended(action) {return action.name==='done'||action.name==='computer_use'&&['terminate','ask_user_question'].includes(action.args?.action);}

export function appendObservation(messages,participant,message,actions,results,observation) {
  if(message.tool_calls?.length) {
    messages.push({role:'assistant',content:message.content||null,tool_calls:message.tool_calls});
    for(let i=0;i<message.tool_calls.length;i++)messages.push({role:'tool',tool_call_id:message.tool_calls[i].id,content:results[i]||'Not executed after the preceding action ended or invalidated the batch.'});
    messages.push({role:'user',content:makeNextObservation(participant,observation,results.join('\n'))});
  } else {
    messages.push({role:'assistant',content:message.content||''});
    messages.push({role:'user',content:makeNextObservation(participant,observation,results.join('\n'))});
  }
}

export async function isolatedPage(browser,session) {
  const context=await browser.newContext({viewport:VIEWPORT,deviceScaleFactor:1,serviceWorkers:'block',acceptDownloads:false});
  await context.route('**/*',async route=>{
    if(route.request().url()===session.url)await route.continue();
    else {session.state.violations.push('external_navigation');await route.abort();}
  });
  const page=await context.newPage();page.setDefaultTimeout(2500);page.setDefaultNavigationTimeout(5000);
  await page.goto(session.url,{waitUntil:'domcontentloaded'});
  return {page,close:()=>context.close()};
}
