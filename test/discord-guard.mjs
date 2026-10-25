import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { getMessageRecipientGuardPolicy } from '../src/chrome/src/agent/adapters.js';
import { getMessageRecipientGuardPolicy as firefoxPolicy } from '../src/firefox/src/agent/adapters.js';
import { advanceChatSession, createChatSession, markChatSendPending } from '../src/chrome/src/agent/chat-workflow.js';
import { advanceChatSession as advanceChatSessionFirefox } from '../src/firefox/src/agent/chat-workflow.js';
import { guardProbeWithReadings, stubPageTextReadings } from './semantic-decision-stub.mjs';

const url = 'https://discord.com/channels/123/456';
const fixture = `<!doctype html><style>
body {margin:0;font:16px sans-serif} nav {width:270px} button,[role=button],[role=menuitem],a {display:block;padding:8px}
ol {min-height:30px} main {position:fixed;left:320px;top:0;width:550px;height:700px}
#composer {position:fixed;left:330px;bottom:20px;width:420px;min-height:50px}
#send {position:fixed;left:760px;bottom:20px}
[role=dialog] {position:fixed;inset:40px;background:white;z-index:100;padding:20px}
[role=dialog] main {position:static;height:auto} [role=menu] {position:fixed;left:20px;top:250px;background:white;z-index:10}
[hidden] {display:none!important}
</style><nav aria-label="Kanallar">
<header><div id="server" role="button" tabindex="0" aria-label="Test, sunucu işlemleri" aria-expanded="false"><h2>Test</h2></div></header>
<div id="channels"><button id="create" type="button" aria-label="Kanal oluştur">+</button>
<button id="category" type="button" aria-label="Metin kanalları (kategori)" aria-expanded="true">Metin kanalları</button>
<a id="channel" href="/channels/123/456" aria-label="general (metin kanalı)" aria-current="page">general</a>
<button id="edit" type="button" aria-label="Kanalı düzenle">Kanalı düzenle</button>
<button id="nav-send" type="button">Send message</button></div></nav>
<section class="panels_fixture" aria-label="User status and settings"><div class="accountPopoutButtonWrapper_fixture"><img id="profile-avatar" src="https://cdn.discordapp.com/avatars/11/self.webp?size=56"></div><div class="nameTag_fixture"><div class="panelTitleContainer_fixture">WebBrain</div><div class="panelSubtext_fixture"><span class="hovered_fixture">webbrain_one</span></div></div><div class="buttons_fixture"><button id="user-settings-trigger" aria-label="Kullanıcı ayarları">⚙</button><button id="mute" role="switch" aria-label="Sessize al">●</button></div></section>
<main aria-label="general (channel)"><h2>general chat</h2><ol role="list" aria-label="Messages in general" data-list-id="chat-messages">
<li><div id="message" role="article" data-list-item-id="chat-messages___chat-messages-456-1001"><div class="contents"><img src="https://cdn.discordapp.com/avatars/22/other.webp?size=160"><h3><span id="message-username-1001"><span data-text="Ficsit">Ficsit</span></span><time id="message-timestamp-1001" datetime="2026-09-29T01:00:00.000Z"></time></h3><div id="message-content-1001">Hello from the fixture</div></div><div role="group" aria-label="Message Actions"><button id="wave">Wave to say hi!</button><button id="lookalike" aria-expanded="false">Test, server actions</button></div></div></li>
</ol><div id="composer" role="textbox" aria-label="Message #general" contenteditable="true" data-slate-editor="true">Draft</div><button id="send" type="button">Send</button></main>`;
const call = (page, action, params={}) => page.evaluate(({action,params}) => new Promise(resolve => {
  const result = window.__wb_handler({target:'content',action,params},{},resolve);
  if (result !== true && result !== undefined) resolve(result);
}), {action,params});

for (const [kind, engine, AgentClass, policy] of [
  ['chrome',chromium,Agent,getMessageRecipientGuardPolicy],
  ['firefox',firefox,FirefoxAgent,firefoxPolicy],
]) {
  test(`${kind}: Discord management and observation regressions`, async t => {
    assert.deepEqual(policy(url), {adapterName:'discord',verifyActiveRecipient:true});
    assert.deepEqual(policy('https://discord.com/channels/@me/456'), {adapterName:'discord',verifyActiveRecipient:true});
    assert.deepEqual(policy('https://discord.com/channels/123/456/789'), {adapterName:'discord',verifyActiveRecipient:true});
    assert.deepEqual(policy('https://discord.com/channels/@me/456/789'), {adapterName:'discord',verifyActiveRecipient:true});
    assert.notEqual(policy('https://discord.com.evil.example/channels/123/456')?.adapterName,'discord');
    const browser = await engine.launch();
    const sources = await Promise.all(['accessibility-tree.js','rich-text-toolbar-heuristic.js','chat-observation.js','content.js']
      .map(file=>readFile(new URL(`../src/${kind}/src/content/${file}`,import.meta.url),'utf8')));
    const setup = async (extra='') => {
      const page=await browser.newPage({viewport:{width:1000,height:800}});
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture+extra}));
      await page.addInitScript(() => {
        const runtime={onMessage:{addListener:fn=>{window.__wb_handler=fn;}},getURL:path=>path};
        window.chrome={runtime};window.browser={runtime};
        window.fixtureClicks=[];
        document.addEventListener('click',event=>{event.preventDefault();window.fixtureClicks.push(event.target.closest('[id]')?.id);});
      });
      await page.goto(url);
      for (const source of sources) await page.addScriptTag({content:source});
      const agent=new AgentClass({getActive:()=>({supportsVision:false})});
      // Control names are read by the fixtures' model oracle, as the agent's
      // model reads them before the guard decides.
      stubPageTextReadings(agent);
      agent._messageRecipientContentProbe=(_,params)=>call(page,'probe_message_recipient_guard',params);
      const guard=async(tool,args)=>{
        if(tool==='set_field' && args.selector){
          await call(page,'get_accessibility_tree',{filter:'all',maxChars:30000});
          args={...args,ref_id:await page.locator(args.selector).evaluate(el=>window.__wb_ax_ref(el))};
        }
        return agent._messageRecipientGuardBlock(1,tool,args,page.url());
      };
      const probe=(tool,args)=>guardProbeWithReadings(params=>call(page,'probe_message_recipient_guard',params),{tool,args,adapterName:'discord'});
      return {page,guard,probe};
    };
    try {
      await t.test('server menu works by selector, text, AX ref, index and coordinates with or without a composer',async()=>{
        const {page,guard,probe}=await setup();
        try {
          for (const withComposer of [true,false]) {
            if(!withComposer) await page.locator('#composer').evaluate(el=>el.remove());
            await call(page,'get_accessibility_tree',{filter:'all',maxChars:30000});
            const ref=await page.locator('#server').evaluate(el=>window.__wb_ax_ref(el));
            const items=await call(page,'get_interactive_elements');
            const index=items.findIndex(el=>el.id==='server');
            assert.ok(index>=0);
            const rect=await page.locator('#server').boundingBox();
            for (const [tool,args] of [['click',{selector:'#server'}],['click',{text:'Test'}],
              ['click_ax',{ref_id:ref}],['click',{index}],['click',{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]]) {
              const classified=await probe(tool,args);
              assert.equal(classified.nonMessagingTarget,true,JSON.stringify({tool,args,classified}));
              assert.equal(await guard(tool,args),null);
              const result=await call(page,tool,args);
              assert.equal(result.success,true,JSON.stringify(result));
            }
          }
          assert.equal((await page.evaluate(()=>window.fixtureClicks)).filter(id=>id==='server').length,10);
          for(const selector of ['#create','#category','#channel','#edit']) assert.equal(await guard('click',{selector}),null);
        } finally {await page.close();}
      });
      await t.test('Discord management controls remain available on message permalink routes',async()=>{
        const {page,guard,probe}=await setup();
        try {
          for(const path of ['/channels/123/456/789','/channels/@me/456/789']) {
            await page.evaluate(path=>history.replaceState(null,'',path),path);
            for(const selector of ['#user-settings-trigger','#server']) {
              const classified=await probe('click',{selector});
              assert.equal(classified.nonMessagingTarget,true,JSON.stringify({path,selector,classified}));
              assert.equal(await guard('click',{selector}),null,`${path} ${selector}`);
            }
          }
        } finally {await page.close();}
      });
      await t.test('only the known server menu entries bypass message classification',async()=>{
        const {page,guard,probe}=await setup(`<div role="menu" id="guild-header-popout">
<div role="menuitem" id="guild-header-popout-settings">Server Settings</div>
<div role="menuitem" id="guild-header-popout-create-channel">Create Channel</div>
<div role="menuitem" id="guild-header-popout-create-category">Create Category</div>
<div role="menuitem" id="unknown">Forward</div></div>`);
        try {
          for(const id of ['settings','create-channel','create-category']) assert.equal(await guard('click',{selector:`#guild-header-popout-${id}`}),null);
          assert.equal((await guard('click',{selector:'#unknown'}))?.noDispatch,true);
          await page.locator('#guild-header-popout-settings').evaluate(el=>el.textContent='Paramètres du serveur');
          await page.locator('#guild-header-popout-create-channel').evaluate(el=>el.textContent='Kanal erstellen');
          await page.locator('#guild-header-popout-create-category').evaluate(el=>el.textContent='Kategori oluştur');
          for(const id of ['settings','create-channel','create-category']) {
            const selector=`#guild-header-popout-${id}`;
            assert.equal((await probe('click',{selector})).nonMessagingTarget,true,`${id} accepts translated labels by structural ID`);
            assert.equal(await guard('click',{selector}),null);
          }
          await page.locator('#guild-header-popout-settings').evaluate(el=>el.textContent='Send invitation');
          assert.notEqual((await probe('click',{selector:'#guild-header-popout-settings'})).nonMessagingTarget,true);
        } finally {await page.close();}
      });
      await t.test('creation dialogs allow field submission and Enter while the channel composer is still mounted',async()=>{
        for(const [id,label,radios] of [
          ['channel-create','Kanal erstellen','<div role="radiogroup"><input type="radio" checked><input type="radio"><input type="radio"></div>'],
          ['category-create','Kategori oluştur',''],
        ]) {
          const {page,guard,probe}=await setup(`<div id="${id}" data-dialog="modal" role="dialog" aria-modal="true" aria-label="${label}"><div role="log"></div><div role="log"></div>
<header><h1 id="heading-${id}">${label}</h1><button type="button" aria-label="Close">×</button></header>${radios}
<input id="name" type="text" placeholder="${label}" value="test"><input id="private" type="checkbox" role="switch">
<button id="save" type="submit">${label}</button><button id="cancel" type="button">Esc</button></div>`);
          try {
            assert.equal((await probe('click',{selector:'#save'})).nonMessagingTarget,true,'localized creation title is recognized structurally');
            assert.equal(await guard('click',{selector:'#save'}),null);
            assert.equal(await guard('click',{selector:'#cancel'}),null);
            assert.equal(await guard('set_field',{selector:'#name',value:'test',submit:true}),null);
            await page.locator('#name').focus();
            assert.equal(await guard('press_keys',{key:'Enter'}),null);
            assert.equal((await guard('click',{selector:'#server'}))?.noDispatch,true,'background menu stays blocked');
          } finally {await page.close();}
        }
      });
      await t.test('server settings are recognized by their stable layer and tab structure',async()=>{
        const {page,guard}=await setup(`<div role="dialog" data-layer="GUILD_SETTINGS" aria-label="Sunucu ayarları" aria-modal="true"><nav><div role="tablist"><div role="tab" id="roles">Rolleri yönet</div><div role="tab">Güvenlik kurulumu</div></div></nav><main><textarea id="description">Server description</textarea><button id="save">Değişiklikleri kaydet</button></main><button id="test-send">Send test message</button></div>`);
        try {
          for(const selector of ['#roles','#description','#save']) assert.equal(await guard('click',{selector}),null);
          assert.equal(await guard('set_field',{selector:'#description',value:'new',submit:true}),null);
          assert.equal((await guard('click',{selector:'#test-send'}))?.noDispatch,true);
        } finally {await page.close();}
      });
      await t.test('localized channel settings allow the Slate topic editor but not a message composer',async()=>{
        const {page,guard,probe}=await setup(`<div role="dialog" data-layer="CHANNEL_SETTINGS" aria-modal="true" aria-label="Kanal ayarları">
<nav><div role="tablist"><div role="tab">Genel</div><div id="permissions" role="tab">İzinler</div></div></nav>
<div role="tabpanel"><input type="text" aria-label="Channel Name"><div id="topic" role="textbox" contenteditable="true" data-slate-editor="true" aria-label="Let everyone know how to use this channel!">Send bug reports here</div><button id="save">Save Changes</button><input id="input-send" type="submit" value="Send"></div></div>`);
        try {
          for(const selector of ['#permissions','#topic','#save']) assert.equal(await guard('click',{selector}),null);
          assert.equal(await guard('set_field',{selector:'#topic',value:'new topic',submit:true}),null);
          await page.locator('#topic').focus();
          assert.equal(await guard('press_keys',{key:'Enter'}),null);
          assert.notEqual((await probe('click',{selector:'#input-send'})).nonMessagingTarget,true);
          // A channel composer (Discord's channelTextArea) inside the dialog,
          // whatever its localized name, denies the management classification.
          await page.locator('#topic').evaluate(el=>{
            const area=document.createElement('div');area.className='channelTextArea_fixture';el.before(area);area.append(el);
          });
          assert.notEqual((await probe('click',{selector:'#save'})).nonMessagingTarget,true);
        } finally {await page.close();}
      });
      await t.test('account settings gear and user settings surface use structural markers',async()=>{
        const {page,guard,probe}=await setup();
        try {
          assert.notEqual((await probe('click',{selector:'#mute'})).nonMessagingTarget,true,'account audio switch is not a settings action');
          assert.equal((await guard('click',{selector:'#mute'}))?.noDispatch,true);
          await page.evaluate(()=>history.replaceState(null,'','/channels/@me/789'));
          assert.equal((await probe('click',{selector:'#user-settings-trigger'})).nonMessagingTarget,true,'localized account gear is recognized by its account-panel structure');
          assert.equal(await guard('click',{selector:'#user-settings-trigger'}),null,'account settings remain available on a DM route');
          await page.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend',`<div id="user-settings-modal" role="dialog" aria-modal="true" aria-labelledby="heading-user-settings-modal"><h1 id="heading-user-settings-modal">Hesap</h1><nav aria-label="Einstellungen"><ul><li data-settings-sidebar-item="account_panel"><div role="link">Hesap</div></li><li data-settings-sidebar-item="appearance_panel"><div role="link">Görünüm</div></li></ul></nav><main><button id="theme-control">Temayı değiştir</button></main></div>`));
          assert.equal((await probe('click',{selector:'#theme-control'})).nonMessagingTarget,true,'user settings sidebar identifies the dialog without English labels');
          assert.equal(await guard('click',{selector:'#theme-control'}),null);
        } finally {await page.close();}
      });
      await t.test('DM and server rail navigation stays available outside the channel rail',async()=>{
        const {page,guard,probe}=await setup(`<nav id="guilds-sidebar" style="position:fixed;left:0;top:0;width:200px;height:80px;z-index:50;background:white"><div role="tree" data-list-id="guildsnav"><div id="guild-rail-link" role="treeitem" data-list-item-id="guildsnav___789">Server</div></div></nav>
<nav id="dm-sidebar" style="position:fixed;left:0;top:100px;width:200px;height:100px;z-index:50;background:white"><a id="dm-rail-link" data-list-item-id="private-channels-uid_11___123" href="/channels/@me/123">Direct message</a><a id="dm-wrong-route" data-list-item-id="private-channels-uid_11___124" href="/channels/123/456?unexpected=1">Unexpected route</a></nav>
<a id="dm-lookalike" href="/channels/@me/123">Lookalike</a>`);
        try {
          await page.evaluate(()=>history.replaceState(null,'','/channels/@me/456'));
          for(const selector of ['#dm-rail-link','#guild-rail-link']) {
            assert.equal((await probe('click',{selector})).nonMessagingTarget,true,`${selector} has a structurally verified Discord rail destination`);
            assert.equal(await guard('click',{selector}),null,`${selector} is not blocked as a message action`);
          }
          assert.notEqual((await probe('click',{selector:'#dm-wrong-route'})).nonMessagingTarget,true,'DM rail metadata does not authorize query-bearing routes');
          assert.notEqual((await probe('click',{selector:'#dm-lookalike'})).nonMessagingTarget,true,'an ordinary same-origin link is not a DM rail item');
        } finally {await page.close();}
      });
      await t.test('sends, message actions, lookalikes and foreign origins remain protected',async()=>{
        const {page,guard,probe}=await setup();
        try {
          for(const selector of ['#send','#nav-send','#wave','#lookalike']) {
            assert.notEqual((await probe('click',{selector})).nonMessagingTarget,true);
            assert.equal((await guard('click',{selector}))?.noDispatch,true);
          }
          await page.locator('#composer').focus();
          assert.equal((await guard('press_keys',{key:'Enter'}))?.noDispatch,true);
          assert.equal((await guard('set_field',{selector:'#composer',value:'Draft',submit:true}))?.noDispatch,true);
          await page.locator('#server').evaluate(el=>el.setAttribute('aria-disabled','true'));
          assert.notEqual((await probe('click',{selector:'#server'})).nonMessagingTarget,true);
          await page.locator('#server').evaluate(el=>{
            el.removeAttribute('aria-disabled');
            const overlay=document.createElement('div');overlay.id='overlay';
            overlay.style='position:fixed;inset:0;background:white;z-index:999';document.body.append(overlay);
          });
          assert.notEqual((await probe('click',{selector:'#server'})).nonMessagingTarget,true,'covered controls fail closed');
          await page.goto('https://discord.com.evil.example/channels/123/456');
          for(const source of sources) await page.addScriptTag({content:source});
          assert.notEqual((await probe('click',{selector:'#server'})).nonMessagingTarget,true,'origin is checked even with an adapter hint');
          await page.locator('#composer').focus();
          const result=await page.evaluate(()=>window.__wb_observe_chat_dom({}));
          assert.equal(result.success,false);
        } finally {await page.close();}
      });
      // A focus click on the message box once armed a pending send, so the
      // real Enter that followed was refused as a duplicate.
      await t.test('a click into the message box only focuses it; Enter and Send stay guarded',async()=>{
        const {page,guard,probe}=await setup();
        try {
          const clicked=await probe('click',{selector:'#composer'});
          assert.equal(clicked.messageSend,false,JSON.stringify(clicked));
          assert.equal(clicked.conclusive,true);
          assert.equal(await guard('click',{selector:'#composer'}),null);
          await call(page,'get_accessibility_tree',{filter:'all',maxChars:30000});
          const ref=await page.locator('#composer').evaluate(el=>window.__wb_ax_ref(el));
          assert.equal((await probe('click_ax',{ref_id:ref})).messageSend,false);
          assert.equal(await guard('click_ax',{ref_id:ref}),null);
          assert.equal((await guard('click',{selector:'#send'}))?.noDispatch,true);
          await page.locator('#composer').focus();
          assert.equal((await guard('press_keys',{key:'Enter'}))?.noDispatch,true);
        } finally {await page.close();}
      });
      // Discord's Slate box carries aria-autocomplete for @mentions. Taken
      // for a picker, its trusted submit pressed ArrowDown before Enter.
      if (kind==='chrome') await t.test('the trusted submit does not treat the message box as a picker',async()=>{
        const {page}=await setup('<input id="picker" role="combobox" aria-autocomplete="list" aria-label="City" style="position:fixed;left:10px;top:400px">');
        try {
          await page.locator('#composer').evaluate(el=>{
            el.setAttribute('aria-autocomplete','list');el.setAttribute('aria-haspopup','listbox');el.setAttribute('aria-multiline','true');
          });
          await call(page,'get_accessibility_tree',{filter:'all',maxChars:30000});
          const ref=selector=>page.locator(selector).evaluate(el=>window.__wb_ax_ref(el));
          const composer=await call(page,'ax_prepare_field_for_trusted_type',{ref_id:await ref('#composer')});
          assert.equal(composer.success,true,JSON.stringify(composer));
          assert.equal(composer.contentEditable,true);
          assert.equal(composer.isCombobox,false,'an @mention pop-up does not make the message box a picker');
          const picker=await call(page,'ax_prepare_field_for_trusted_type',{ref_id:await ref('#picker')});
          assert.equal(picker.isCombobox,true,'a real combobox keeps its ArrowDown nudge');
        } finally {await page.close();}
      });
      // The content script's own submit reads a rich-text box the same way:
      // its open @mention list is no picker, so Enter follows the text.
      await t.test('a rich-text box with an open suggestion list gets Enter, not a picker ArrowDown',async()=>{
        const {page}=await setup(`<div id="plain" contenteditable="true" role="textbox" aria-autocomplete="list" aria-expanded="true" aria-label="Plain message" style="position:fixed;left:10px;top:420px;width:300px;min-height:40px"></div>
<div role="listbox" style="position:fixed;left:10px;top:470px;width:200px;height:40px"><div role="option">@webbrain</div></div>
<input id="city" role="combobox" aria-autocomplete="list" aria-label="City" style="position:fixed;left:10px;top:520px">`);
        try {
          await page.evaluate(()=>{window.qaKeys=[];document.addEventListener('keydown',event=>window.qaKeys.push(`${event.target.id}:${event.key}`),true);});
          await call(page,'get_accessibility_tree',{filter:'all',maxChars:30000});
          const ref=selector=>page.locator(selector).evaluate(el=>window.__wb_ax_ref(el));
          const plain=await call(page,'set_field',{ref_id:await ref('#plain'),text:'Release notes are up',clear:true,submit:true});
          assert.equal(plain.verified,true,JSON.stringify(plain));
          const city=await call(page,'set_field',{ref_id:await ref('#city'),text:'Ista',clear:true,submit:true});
          assert.equal(city.verified,true,JSON.stringify(city));
          assert.deepEqual(await page.evaluate(()=>window.qaKeys),['plain:Enter','city:ArrowDown','city:Enter']);
        } finally {await page.close();}
      });
      await t.test('unknown dialogs and chat editors inside settings never gain management classification',async()=>{
        const {page,probe}=await setup(`<div role="dialog" aria-modal="true" aria-label="Forward"><h1>Forward</h1><input type="text"><button id="forward">Create Channel</button></div>`);
        try {
          assert.notEqual((await probe('click',{selector:'#forward'})).nonMessagingTarget,true);
          await page.locator('[role=dialog]').evaluate(el=>{
            el.setAttribute('aria-label','Create Channel');el.querySelector('h1').textContent='Create Channel';
            const editor=document.createElement('div');editor.setAttribute('data-slate-editor','true');el.append(editor);
          });
          assert.notEqual((await probe('click',{selector:'#forward'})).nonMessagingTarget,true);
        } finally {await page.close();}
      });
      await t.test('DM routes use their stable route identity and Discord transcript',async()=>{
        const {page}=await setup();
        try {
          await page.locator('#channel').evaluate(el=>{
            el.setAttribute('href','/channels/@me/456');
            el.setAttribute('aria-label','Ada direct message');
          });
          await page.locator('#composer').evaluate(el=>el.setAttribute('aria-label','Message Ada'));
          await page.locator('main').evaluate(el=>el.setAttribute('aria-label','Direct message'));
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.setAttribute('aria-label','Conversation'));
          await page.evaluate(()=>history.replaceState(null,'','/channels/@me/456/1001'));
          await page.locator('#composer').focus();
          const observe=()=>page.evaluate(()=>window.__wb_observe_chat_dom({}));
          const result=await observe();
          assert.equal(result.success,true,JSON.stringify(result));
          assert.equal(result.conversationId,'discord:dm:456');
          assert.equal(result.threadKey,'dom:discord:dm:456');
          assert.equal(result.conversationIdentity,'direct-message-456');
          assert.equal(result.messages[0].id,'discord:456:1001');
          // The selected rail link names the contact in any language: its text
          // that the composer's label also contains, not a status line beside it.
          await page.locator('#channel').evaluate(el=>{el.innerHTML='<span>Ada</span><span>Spielt gerade</span>';});
          await page.locator('#composer').evaluate(el=>el.setAttribute('aria-label','Nachricht an @Ada'));
          assert.equal((await observe()).conversationIdentity,'Ada');

          await page.locator('#channel').evaluate(el=>el.remove());
          assert.equal((await observe()).success,true,'matching message-row channel IDs bind the DM pane without an active rail link');
          await page.locator('nav').evaluate(el=>el.insertAdjacentHTML('beforeend',
            '<a aria-current="page" data-list-item-id="private-channels-uid_11___789" href="/channels/@me/789">Current DM</a>'));
          await page.evaluate(()=>history.replaceState(null,'','/channels/@me/789'));
          assert.equal((await observe()).success,false,'a matching current rail link cannot override stale transcript rows');
          await page.locator('nav [data-list-item-id="private-channels-uid_11___789"]').evaluate(el=>el.remove());
          assert.equal((await observe()).success,false,'stale transcript rows cannot bind to a different DM route without an active rail link');
          await page.evaluate(()=>history.replaceState(null,'','/channels/@me/456/1001'));
          assert.equal((await observe()).success,true,'the route succeeds again when the transcript IDs match it');
          await page.locator('nav').evaluate(el=>el.insertAdjacentHTML('beforeend',
            '<a aria-current="page" data-list-item-id="private-channels-uid_11___789" href="/channels/@me/789">Stale DM</a>'));
          assert.equal((await observe()).success,false,'a conflicting selected DM route fails closed');
        } finally {await page.close();}
      });
      await t.test('empty DMs bind only when the selected rail route confirms the pane',async()=>{
        const {page}=await setup();
        try {
          await page.locator('#channel').evaluate(el=>{
            el.setAttribute('href','/channels/@me/456');
            el.setAttribute('data-list-item-id','private-channels-uid_11___456');
          });
          await page.evaluate(()=>history.replaceState(null,'','/channels/@me/456'));
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.replaceChildren());
          await page.locator('#composer').focus();
          const observe=()=>page.evaluate(()=>window.__wb_observe_chat_dom({}));
          assert.equal((await observe()).success,true,'an empty DM can bind from its matching selected rail link');
          await page.locator('#channel').evaluate(el=>el.removeAttribute('aria-current'));
          assert.equal((await observe()).success,false,'an empty DM without pane or rail route evidence fails closed');
          await page.locator('#channel').evaluate(el=>el.setAttribute('aria-current','page'));
          await page.evaluate(()=>history.replaceState(null,'','/channels/@me/789'));
          assert.equal((await observe()).success,false,'an empty DM cannot bind to a different selected route');
        } finally {await page.close();}
      });
      await t.test('channel observation recognizes the transcript, empty channels and stable server/channel identity',async()=>{
        const {page}=await setup();
        try {
          await page.locator('#composer').focus();
          const observe=()=>page.evaluate(()=>window.__wb_observe_chat_dom({}));
          const result=await observe();
          assert.equal(result.success,true,JSON.stringify(result));
          assert.equal(result.conversationId,'discord:123:456');
          assert.equal(result.threadKey,'dom:discord:123:456');
          assert.equal(result.conversationIdentity,'#general');
          assert.deepEqual(result.messages,[{
            id:'discord:456:1001', direction:'incoming', text:'Hello from the fixture',
            authoredText:'Hello from the fixture',
            author:'Ficsit', timestamp:'2026-09-29T01:00:00.000Z',
          }]);
          await page.evaluate(()=>history.replaceState(null,'','/channels/123/456/1001'));
          const permalink=await observe();
          assert.equal(permalink.success,true,JSON.stringify(permalink));
          assert.equal(permalink.conversationId,result.conversationId);
          assert.equal(permalink.threadKey,result.threadKey);
          await page.evaluate(()=>history.replaceState(null,'','/channels/123/456'));
          await page.locator('#composer').evaluate(el=>el.setAttribute('aria-label','Nachricht #general'));
          await page.locator('main').evaluate(el=>el.setAttribute('aria-label','general (Kanal)'));
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.setAttribute('aria-label','Nachrichten in general'));
          await page.locator('#channel').evaluate(el=>el.setAttribute('aria-label','general (Textkanal)'));
          await page.locator('section').evaluate(el=>el.setAttribute('aria-label','Benutzerstatus und Einstellungen'));
          const localized=await observe();
          assert.equal(localized.success,true,JSON.stringify(localized));
          assert.equal(localized.conversationIdentity,'#general','the channel is named in any language');
          assert.equal(localized.conversationId,result.conversationId);
          assert.equal(localized.threadKey,result.threadKey);
          assert.deepEqual(localized.messages,result.messages);

          await page.locator('#channel').evaluate(el=>el.removeAttribute('aria-current'));
          assert.equal((await observe()).success,true,'a matching populated guild transcript can bind without a selected rail link');
          await page.locator('#channel').evaluate(el=>el.setAttribute('aria-current','page'));
          await page.locator('nav').evaluate(el=>el.insertAdjacentHTML('beforeend',
            '<a id="channel-b" href="/channels/123/789" aria-current="page">second channel</a>'));
          await page.evaluate(()=>history.replaceState(null,'','/channels/123/789'));
          assert.equal((await observe()).success,false,'a matching current guild rail link cannot override stale transcript rows');
          await page.locator('#channel-b').evaluate(el=>el.remove());
          await page.evaluate(()=>history.replaceState(null,'','/channels/123/456'));
          assert.equal((await observe()).success,true,'the guild route succeeds again when the transcript IDs match it');

          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/guilds/123/users/22/avatars/other.webp?size=160'));
          assert.equal((await observe()).messages[0].direction,'incoming','guild-profile avatars retain the member identity');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/guilds/123/users/11/avatars/self.webp?size=160'));
          assert.equal((await observe()).messages[0].direction,'outgoing','guild-profile avatar identity detects the signed-in user');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/22/other.webp?size=160'));

          await page.locator('#profile-avatar').evaluate(el=>el.setAttribute('src','/assets/embed/avatars/3.png'));
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/guilds/123/users/11/avatars/self.webp?size=160'));
          assert.equal((await observe()).messages[0].direction,'unknown','a default-avatar account cannot disprove a guild-profile self avatar');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/22/other.webp?size=160'));
          assert.equal((await observe()).messages[0].direction,'incoming','a global custom avatar cannot belong to a default-avatar account');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','/assets/embed/avatars/3.png'));
          const defaultAvatars=await observe();
          assert.equal(defaultAvatars.messages[0].direction,'unknown','shared Discord default avatars do not identify message authors');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/embed/avatars/4.png'));
          assert.equal((await observe()).messages[0].direction,'incoming','different default avatar indices cannot be the same account');
          await page.locator('#profile-avatar').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/11/self.webp?size=56'));
          assert.equal((await observe()).messages[0].direction,'incoming','a default avatar cannot belong to the custom-avatar account');
          await page.locator('#profile-avatar').evaluate(el=>el.setAttribute('src','/assets/embed/avatars/3.png'));
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/guilds/123/users/22/avatars/other.webp?size=160'));
          assert.equal((await observe()).messages[0].direction,'unknown','a guild-specific avatar can belong to a default-avatar account');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','/assets/embed/avatars/3.png'));
          let advanced=advanceChatSession(createChatSession({threadKey:result.threadKey}),defaultAvatars);
          await page.locator('#wave').evaluate(el=>el.textContent='Changed hover action');
          const afterHover=await observe();
          assert.deepEqual(afterHover.messages.map(item=>item.text),result.messages.map(item=>item.text),'message actions do not alter observed content');
          assert.equal(afterHover.messages[0].direction,'unknown','default-avatar direction stays unresolved after hover');
          advanced=advanceChatSession(advanced.session,afterHover);
          assert.deepEqual(advanced.newMessages,[],'hover does not create a new message');

          const attemptedAt=new Date(Date.now()-1000).toISOString();
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1002"><div class="contents">
              <img src="/assets/embed/avatars/3.png"><h3><span id="message-username-1002"><span data-text="WebBrain">WebBrain</span></span><time id="message-timestamp-1002" datetime="${new Date().toISOString()}"></time></h3>
              <div id="message-content-1002">My answer</div></div><div id="message-accessories-1002"><div class="embedTitle_fixture">My answer link preview</div><div class="embedDescription_fixture">Preview description</div></div></div></li>
            <li><div role="article" class="isSystemMessage_fixture" data-list-item-id="chat-messages___chat-messages-456-1004"><div id="message-content-1004">A member joined</div></div></li>`));
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',
            '<li id="foreign-channel-row"><div role="article" data-list-item-id="chat-messages___chat-messages-999-1003"><div id="message-content-1003">Wrong channel</div></div></li>'));
          assert.equal((await observe()).success,false,'a visible conflicting guild transcript row fails closed');
          await page.locator('#foreign-channel-row').evaluate(el=>el.remove());
          const afterDraft=await observe();
          const pending=markChatSendPending(advanced.session,{
            ok:true,messageKey:'test-pending',threadKey:result.threadKey,text:'My answer',attemptedAt,
          },Date.parse(attemptedAt));
          const dispatchedPending={...pending,pendingOutbound:{...pending.pendingOutbound,dispatchedAt:attemptedAt}};
          const blockedByDraft=advanceChatSession(dispatchedPending,afterDraft);
          assert.equal(blockedByDraft.pendingDeliveryVerified,false,'an uncleared composer draft is not delivery evidence');
          assert.ok(blockedByDraft.session.pendingOutbound,'uncertain sends stay pending when the composer is not empty');
          await page.locator('#composer').evaluate(el=>el.textContent='');
          const afterSend=await observe();
          assert.deepEqual(afterSend.messages.map(item=>item.id),['discord:456:1001','discord:456:1002']);
          assert.equal(afterSend.messages[1].direction,'unknown','nickname equality never asserts message authorship');
          assert.equal(afterSend.messages[1].authoredText,'My answer');
          assert.match(afterSend.messages[1].text,/Attachment: My answer link preview/);
          const withoutDispatchEvidence=advanceChatSession(pending,afterSend,Date.parse(afterSend.observedAt));
          assert.equal(withoutDispatchEvidence.pendingDeliveryVerified,false,'an ordinary observation cannot infer Discord message authorship');
          advanced=advanceChatSession(dispatchedPending,afterSend,Date.parse(afterSend.observedAt));
          assert.equal(advanced.newMessages[0].direction,'unknown','transaction evidence does not overwrite the message author direction');
          assert.equal(advanced.session.state,'we_responded');
          assert.equal(advanced.session.pendingOutbound,null,'self-authored default-avatar message clears pending send');
          assert.equal(advanced.pendingDeliveryVerified,true,'the unique fresh exact-text bubble and empty composer verify this pending send');
          const delayedObservedAt=Date.parse(afterSend.observedAt)+180_000;
          const delayedSnapshot={...afterSend,observedAt:new Date(delayedObservedAt).toISOString()};
          const workflow=kind==='firefox'?advanceChatSessionFirefox:advanceChatSession;
          const delayedAdvance=workflow(dispatchedPending,delayedSnapshot,delayedObservedAt);
          assert.equal(delayedAdvance.pendingDeliveryVerified,true,'a timestamp-matching bubble reconciles after a delayed observation');
          assert.equal(delayedAdvance.session.pendingOutbound,null,'delayed reconciliation clears the durable pending send');
          const lateEchoAt=Date.parse(attemptedAt)+180_000;
          const lateEchoSnapshot={...delayedSnapshot,messages:delayedSnapshot.messages.map(message=>
            message.id==='discord:456:1002'?{...message,timestamp:new Date(lateEchoAt).toISOString()}:message)};
          const lateEchoAdvance=workflow(dispatchedPending,lateEchoSnapshot,delayedObservedAt);
          assert.equal(lateEchoAdvance.pendingDeliveryVerified,false,'a later counterparty echo cannot verify our send');
          assert.ok(lateEchoAdvance.session.pendingOutbound,'late echoes leave uncertain sends pending');

          await page.locator('#profile-avatar').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/11/self.webp?size=56'));
          await page.locator('[data-list-item-id="chat-messages___chat-messages-456-1001"] .contents img')
            .evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/22/other.webp?size=160'));
          await page.locator('[data-list-item-id="chat-messages___chat-messages-456-1002"] .contents img')
            .evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/11/self.webp?size=160'));
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1005">
              <div id="message-reply-context-1005"><div id="message-content-1002">My answer</div></div>
              <div class="contents"><img src="https://cdn.discordapp.com/avatars/22/other.webp?size=160"><h3><span id="message-username-1005"><span data-text="Ficsit">Ficsit</span></span><time id="message-timestamp-1005" datetime="2026-09-29T01:02:00.000Z"></time></h3>
              <div id="message-content-1005">A new reply <span role="button"><img class="emoji" alt="🚀" src="/emoji.svg"></span></div></div><div role="group">Reply Forward Add Reaction</div></div></li>`));
          const afterReply=await observe();
          assert.equal(afterReply.messages[2].text,'A new reply 🚀');
          assert.equal(afterReply.messages[2].direction,'incoming');
          advanced=advanceChatSession(advanced.session,afterReply);
          assert.deepEqual(advanced.newMessages.map(item=>item.id),['discord:456:1005']);
          assert.equal(advanced.nextAction,'reply');
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1006"><div class="contents">
              <img src="https://cdn.discordapp.com/avatars/22/other.webp?size=160"><h3><span id="message-username-1006"><span data-text="Ficsit">Ficsit</span></span><time id="message-timestamp-1006" datetime="2026-09-29T01:03:00.000Z"></time></h3>
              <div id="message-content-1006"></div></div><div id="message-accessories-1006"><div class="attachment_fixture"><img width="64" height="64" alt="support-error.png" src="/assets/support-error.png"></div>
              <div role="img" aria-label="Sticker, Wave" style="display:block;width:24px;height:24px"></div><div class="embedTitle_fixture">Build error report</div><div class="embedDescription_fixture">Setup fails on startup</div></div></div></li>`));
          const afterAttachment=await observe();
          assert.equal(afterAttachment.messages[3].direction,'incoming');
          assert.equal(afterAttachment.messages[3].text,
            'Attachment: support-error.png\nAttachment: Sticker, Wave\nAttachment: Build error report\nAttachment: Setup fails on startup');
          advanced=advanceChatSession(advanced.session,afterAttachment);
          assert.deepEqual(advanced.newMessages.map(item=>item.id),['discord:456:1006']);
          assert.equal(advanced.nextAction,'reply');
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1008"><div class="contents">
              <img src="https://cdn.discordapp.com/avatars/22/other.webp?size=160"><h3><span id="message-username-1008"><span data-text="Ficsit">Ficsit</span></span><time id="message-timestamp-1008" datetime="2026-09-29T01:04:00.000Z"></time></h3>
              <div id="message-content-1008"></div></div><div id="message-accessories-1008"><div class="pollContainer_fixture">
                <div class="pollQuestion_fixture">Which option should we choose?</div>
                <div class="pollAnswer_fixture">Option Alpha</div><div class="pollAnswer_fixture">Option Beta</div>
                <button type="button">Vote</button>
              </div></div></div></li>`));
          const afterPoll=await observe();
          assert.equal(afterPoll.messages.at(-1).id,'discord:456:1008');
          assert.match(afterPoll.messages.at(-1).text,/Which option should we choose\?/);
          assert.match(afterPoll.messages.at(-1).text,/Option Alpha/);
          assert.match(afterPoll.messages.at(-1).text,/Option Beta/);
          advanced=advanceChatSession(advanced.session,afterPoll);
          assert.deepEqual(advanced.newMessages.map(item=>item.id),['discord:456:1008']);
          assert.equal(advanced.nextAction,'reply');
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1010"><div class="contents">
              <img src="https://cdn.discordapp.com/avatars/22/other.webp?size=160"><h3><span id="message-username-1010"><span data-text="Ficsit">Ficsit</span></span><time id="message-timestamp-1010" datetime="2026-09-29T01:05:00.000Z"></time></h3>
              <div id="message-content-1010"></div></div><div id="message-accessories-1010"><div class="embed_fixture">
                <div class="embedFieldName_fixture">Environment</div><div class="embedFieldValue_fixture">Production</div>
              </div></div></div></li>`));
          const afterFieldEmbed=await observe();
          assert.equal(afterFieldEmbed.messages.at(-1).id,'discord:456:1010');
          assert.equal(afterFieldEmbed.messages.at(-1).direction,'incoming');
          assert.equal(afterFieldEmbed.messages.at(-1).text,'Attachment: Environment\nAttachment: Production');
          advanced=advanceChatSession(advanced.session,afterFieldEmbed);
          assert.deepEqual(advanced.newMessages.map(item=>item.id),['discord:456:1010']);
          assert.equal(advanced.nextAction,'reply');
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1007"><div class="contents">
              <h3><span id="message-username-1007"><span data-text="WebBrain">WebBrain</span></span><time id="message-timestamp-1007" datetime="${new Date().toISOString()}"></time></h3>
              <div id="message-content-1007">A member with the same display name</div></div></div></li>`));
          const collidingNickname=await observe();
          assert.equal(collidingNickname.messages.at(-1).direction,'unknown','a member sharing the account display name is not called outgoing');
          const previewBody='https://example.com/release';
          const previewTimestamp=new Date().toISOString();
          const previewAttemptedAt=new Date(Date.parse(previewTimestamp)-1000).toISOString();
          await page.locator('[data-list-id=chat-messages]').evaluate((el,{previewBody,previewTimestamp})=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1009"><div class="contents">
              <img src="https://cdn.discordapp.com/avatars/11/self.webp?size=160"><h3><span id="message-username-1009"><span data-text="WebBrain">WebBrain</span></span><time id="message-timestamp-1009" datetime="${previewTimestamp}"></time></h3>
              <div id="message-content-1009">${previewBody}</div></div><div id="message-accessories-1009"><div class="embedTitle_fixture">Release notes</div><div class="embedDescription_fixture">Preview description</div></div></div></li>`),{previewBody,previewTimestamp});
          const afterPreview=await observe();
          const previewMessage=afterPreview.messages.at(-1);
          assert.equal(previewMessage.id,'discord:456:1009');
          assert.equal(previewMessage.direction,'outgoing');
          assert.equal(previewMessage.authoredText,previewBody);
          assert.match(previewMessage.text,/Attachment: Release notes/);
          const previewPending=markChatSendPending(createChatSession({threadKey:afterPreview.threadKey}),{
            ok:true,messageKey:'preview-send',threadKey:afterPreview.threadKey,text:previewBody,
            attemptedAt:previewAttemptedAt,replyAnchor:'chat_start',
          },Date.parse(previewAttemptedAt));
          const previewDispatched={...previewPending,pendingOutbound:{...previewPending.pendingOutbound,dispatchedAt:previewAttemptedAt}};
          const previewAdvance=workflow(previewDispatched,afterPreview,Date.parse(afterPreview.observedAt));
          assert.equal(previewAdvance.session.pendingOutbound,null,'ordinary outgoing verification matches authored text despite accessory text');
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.replaceChildren());
          assert.equal((await observe()).success,true);
          await page.locator('#channel').evaluate(el=>el.setAttribute('href','/channels/123/999'));
          assert.equal((await observe()).success,false,'stale channel identity fails closed');
        } finally {await page.close();}
      });
    } finally {await browser.close();}
  });
}
