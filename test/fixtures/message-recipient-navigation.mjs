import { strict as assert } from 'node:assert';

export function registerMessageRecipientNavigationFixtures({
  test, firefoxTest, setupContentHtml, call, Agent, FirefoxAgent,
}) {
  for (const [kind, register, AgentClass] of [
    ['chrome', test, Agent],
    ['firefox', firefoxTest, FirefoxAgent],
  ]) {
    const setup = async (page) => {
      // Keep the real origin and URL parsing without contacting LinkedIn.
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://www.linkedin.com/feed/');
      await setupContentHtml(page, `<!doctype html>
        <style>
          body { margin: 0; font: 16px sans-serif; }
          nav { display: flex; gap: 30px; padding: 20px; }
          a, button { display: inline-block; padding: 8px; }
          #chat { position: fixed; right: 20px; bottom: 20px; width: 360px; }
          #body { width: 260px; height: 60px; }
          #chat h2 { position: fixed; right: 200px; top: 80px; margin: 0; }
        </style>
        <nav aria-label="Primary">
          <a id="home" class="destination" href="/feed/">Home</a>
          <a id="jobs" class="destination" href="/jobs/"><span id="jobs-label">Jobs</span></a>
          <a id="messaging" href="/messaging/">Messaging</a>
        </nav>
        <main>
          <a id="portfolio" href="https://portfolio.example/"><span id="portfolio-label">View my portfolio</span></a>
          <a id="contact-info" href="/in/alice/overlay/contact-info/">Contact info</a>
        </main>
        <div id="contact-info-dialog" role="dialog" aria-modal="true" hidden>
          <button id="close-contact-info" type="button">Close</button>
          <a id="contact-profile" href="/in/alice/">linkedin.com/in/alice</a>
          <a id="safety-portfolio" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F">portfolio.example</a>
          <a id="legacy-portfolio" href="/redir/redirect?url=https%3A%2F%2Flegacy-portfolio.example%2F">legacy-portfolio.example</a>
        </div>
        <form id="chat" hidden>
          <h2>Alice</h2><textarea id="body">Hello Alice</textarea><button id="send" type="button">Send</button>
        </form>`, kind);
      await page.evaluate(() => {
        window.fixtureClicks = [];
        document.addEventListener('click', event => {
          const target = event.target.closest('a,button');
          if (target) { event.preventDefault(); window.fixtureClicks.push(target.id); }
        });
      });
      const agent = new AgentClass({ getActive: () => ({ supportsVision: false }) });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      const guard = (tool, args) => agent._messageRecipientGuardBlock(1, tool, args, page.url());
      const probe = (tool, args) => call(page, 'probe_message_recipient_guard', { tool, args, adapterName: 'linkedin' });
      return { agent, guard, probe };
    };

    register(`${kind}: X sent DM completes with the open composer and exact outgoing delivery evidence`, async (page) => {
      const { agent } = await setup(page);
      const url = 'https://x.com/i/chat/123-456';
      await page.goto(url);
      await setupContentHtml(page, `<!doctype html><style>
        body {margin:0} [dir=auto] {white-space:pre-wrap} #header {position:fixed;left:400px;top:20px}
        textarea {position:fixed;left:400px;bottom:20px;width:400px;height:50px}
        #send {position:fixed;left:820px;bottom:20px}
        [role=log] {position:fixed;left:400px;top:100px;width:400px;height:300px;overflow:auto}
      </style><a id="header" href="https://x.com/altryne"><div data-testid="dm-conversation-username">Alex Volkov</div></a>
      <div role="log" data-testid="dm-message-scroller" aria-busy="false"></div>
      <textarea data-testid="dm-composer-textarea" aria-label="Unencrypted message"></textarea>
      <button id="send" type="button">Send</button>`, kind);
      const body = 'Hey Alex, check out webbrain.one.\nHappy to share a demo.';
      const params = {tool:'observe_active_conversation',adapterName:'twitter',expectedMessageBody:body};
      const observe = () => call(page,'probe_message_recipient_guard',params);
      const addRow = async (id, status='sent', outgoing=true, text=body) => page.evaluate(({id,status,outgoing,text})=>{
        const row=document.createElement('div');row.dataset.testid='message-'+id;
        row.dataset.sendStatus=status;row.className=outgoing?'justify-end':'justify-start';
        const content=document.createElement('div');content.dataset.testid='message-text-'+id;
        const span=document.createElement('span');span.dir='auto';span.textContent=text;
        content.append(span);content.append('12:39 PM');row.append(content);
        document.querySelector('[role=log]').append(row);
      },{id,status,outgoing,text});
      await addRow('old');
      await addRow('hidden');
      await page.locator('[data-testid="message-hidden"]').evaluate(el => { el.hidden = true; });
      await addRow('already-pending', 'sending');
      const pinned=await agent._pinActiveConversationMessagingTarget(1,{target_kind:'active_conversation',recipients:[]},url);
      assert.equal(pinned.ok,true,JSON.stringify(pinned));
      assert.equal(pinned.target.recipients[0].identity,'@altryne');
      const workflow=agent._resolvePlannerSiteWorkflow(url,{
        request_kind:'execute',site_job:null,requires_submission:true,messaging:pinned.target,
      });
      assert.equal(workflow?.job.id,'send-message');
      assert.equal(agent._resolvePlannerSiteWorkflow('https://x.com/home',{
        request_kind:'execute',requires_submission:true,messaging:pinned.target,
      }),null);
      const guard=agent._startPlanExecutionGuard(1,'act',{
        requestKind:'execute',requiresStateChange:true,requiresSubmission:true,
        messaging:pinned.target,siteWorkflow:workflow,
      });
      let metadataCalls = 0;
      agent._chatWithCostAllowance = async () => {
        metadataCalls++;
        return { content: JSON.stringify({
          mode: 'inactive', allowedActions: [], forbiddenActions: [], targets: [],
          workflowFields: [{ field: 'body', value: body }], confidence: 0.99,
        }) };
      };
      const startup = {
        progressLedgerPolicy: 'disabled', taskText: 'Send the reviewed message to Alex.',
        pageScope: url, provider: { chat: async () => ({ content: '{}' }) },
      };
      await agent._ensureProgressSessionForCurrentTask(1, { ...startup, provider: {} });
      assert.notEqual(guard.workflowMetadataRequirementsResolved, true, 'missing classifier cannot resolve fields');
      const session = await agent._ensureProgressSessionForCurrentTask(1, startup);
      assert.equal(session.mode, 'inactive');
      assert.equal(guard.workflowMetadataRequirementsResolved, true);
      assert.deepEqual(guard.workflowMetadataRequirements, [{ field: 'body', value: body }]);
      await agent._ensureProgressSessionForCurrentTask(1, startup);
      assert.equal(metadataCalls, 1, 'resolved fields are not classified again');
      assert.equal(await agent._messageRecipientGuardBlock(1,'click',{selector:'textarea'},url),null);
      await page.locator('textarea').fill(body);
      const execution={};
      assert.equal(await agent._messageRecipientGuardBlock(1,'click',{selector:'#send'},url,execution),null);
      assert.equal(execution.messageRecipientBodyBaselineCount,1);
      assert.equal(execution.messageRecipientGuardRequired,true);
      await page.evaluate(() => {
        window.fixtureSends = 0;
        document.querySelector('#send').addEventListener('click', () => { window.fixtureSends++; });
      });
      await addRow('arrived-between-probe-and-dispatch', 'sent', false);
      const stale = await call(page, 'click', {selector:'#send', ...execution});
      assert.equal(stale.noDispatch, true, 'the bound message baseline must survive to dispatch');
      assert.equal(await page.evaluate(() => window.fixtureSends), 0);
      await page.locator('[data-testid="message-arrived-between-probe-and-dispatch"]').evaluate(el => el.remove());
      assert.equal(await agent._messageRecipientGuardBlock(1,'click',{selector:'#send'},url,execution),null);
      const clicked = await call(page, 'click', {selector:'#send', ...execution});
      assert.equal(clicked.success, true, JSON.stringify(clicked));
      assert.equal(await page.evaluate(() => window.fixtureSends), 1);
      // The actual UI uses type=button, not an HTML form submit.
      agent._recordCompletionSubmitAttempt(1,{isSubmit:false},'click',{selector:'#send'},url,url,
        clicked,'doc','doc',execution);
      const submit=agent._completionSubmitStates.get(1);
      assert.equal(submit.dispatched,true);
      assert.equal(submit.workflowBinding.recipientBound,true);
      assert.notEqual(submit.workflowBinding.metadataIncomplete, true);
      assert.deepEqual(submit.workflowBinding.preDispatchMessageIds,
        ['message-old', 'message-hidden', 'message-already-pending']);
      submit.observedAfterSubmit=true;
      const state={relevantFormCount:1,openDialogCount:0,liveRegionMessages:[]};
      const evidence=probe=>agent._workflowTerminalEvidenceFromDone(1,state,url,{submit,relevantForms:1,verifiedFinalSubmit:false},probe);
      await page.locator('textarea').fill('');
      assert.equal(evidence(await observe()),null,'old identical sent bubble cannot satisfy this dispatch');
      await page.locator('[data-testid="message-hidden"]').evaluate(el => { el.hidden = false; });
      assert.equal(evidence(await observe()), null, 'revealing an old matching bubble is not delivery');
      await page.locator('[data-testid="message-already-pending"]').evaluate(el => { el.dataset.sendStatus = 'sent'; });
      assert.equal(evidence(await observe()), null, 'an earlier pending send is not the current send');
      await addRow('loaded-history');
      await page.locator('[data-testid="message-loaded-history"]').evaluate(el => el.parentElement.prepend(el));
      assert.equal(evidence(await observe()), null, 'newly mounted older history is not delivery');
      await addRow('incoming','sent',false);
      await addRow('pending','sending');
      await addRow('failed','failed');
      await addRow('different','sent',true,'Something else');
      assert.equal(evidence(await observe()),null,'incoming, pending, failed or different bodies cannot prove delivery');
      assert.ok(agent._completionPageWarning(1,'Sent','success',state,url));
      await addRow('new');
      const probe=await observe();
      assert.equal(probe.matchingOutgoingMessageCount,5);
      const terminal=evidence(probe);
      assert.equal(terminal?.verificationKind,'message_sent');
      assert.equal(agent._completionPageWarning(1,'Sent','success',state,url,terminal),null);
      assert.equal(evidence({...probe,composerEmpty:false}),null);
      assert.equal(evidence({...probe,strongRecipientCandidates:[{identity:'@someoneelse',role:'to'}]}),null);
      assert.equal(agent._workflowTerminalEvidenceFromDone(1,state,'https://x.com/i/chat/123-789',
        {submit,relevantForms:1},probe),null,'another conversation cannot satisfy the dispatch');
      assert.equal(evidence({...probe,matchingOutgoingMessageIds:['message-old']}),null);
      assert.equal(evidence({...probe,existingMessageIds:['message-new']}),null, 'missing prior tail fails closed');
      assert.equal(evidence({...probe,existingMessageIds:undefined}),null, 'incomplete observation fails closed');
      delete submit.workflowBinding.preDispatchMessageIds;
      assert.equal(evidence(probe),null, 'a legacy count-only binding cannot prove an X send');
      submit.workflowBinding.preDispatchMessageIds = [];
      assert.equal(evidence(probe), null,
        'relabeling a nonempty X history as empty cannot fabricate a first-message baseline');
      await addRow('new');
      assert.equal(evidence(await observe()),null, 'duplicate message identities fail closed');
    });

    register(`${kind}: X named DM recipients resolve header aliases and retain the canonical handle`, async (page) => {
      const { agent } = await setup(page);
      const url = 'https://x.com/i/chat/123-456';
      await page.goto(url);
      await setupContentHtml(page, `<!doctype html><style>
        #header {position:fixed;left:400px;top:20px}
        textarea {position:fixed;left:400px;bottom:20px;width:400px;height:50px}
        #send {position:fixed;left:820px;bottom:20px}
        [role=log] {position:fixed;left:400px;top:100px;width:400px;height:300px}
      </style><a id="header" href="/altryne"><span data-testid="dm-conversation-username">Alex Volkov</span></a>
      <div role="log" data-testid="dm-message-scroller" aria-busy="false"></div>
      <textarea data-testid="dm-composer-textarea"></textarea><button id="send" type="button">Send</button>`, kind);
      await page.evaluate(() => {
        window.fixtureSends = 0;
        document.querySelector('#send').addEventListener('click', () => {
          const composer = document.querySelector('textarea');
          const row = document.createElement('div');
          row.dataset.testid = 'message-' + ++window.fixtureSends;
          row.dataset.sendStatus = 'sent'; row.className = 'justify-end';
          const content = document.createElement('div'); content.dataset.testid = 'message-text-' + window.fixtureSends;
          const body = document.createElement('span'); body.dir = 'auto'; body.textContent = composer.value;
          content.append(body); row.append(content); document.querySelector('[role=log]').append(row);
          composer.value = '';
        });
      });
      const named = identity => ({target_kind:'named', recipients:[{identity,role:'to'}]});
      const canonical = named('@altryne');
      const workflow = agent._resolvePlannerSiteWorkflow(url, {
        request_kind:'execute', requires_submission:true, messaging:named('Alex Volkov'),
      });
      const start = messaging => {
        const guard = agent._startPlanExecutionGuard(1, 'act', {
          requestKind:'execute', requiresStateChange:true, requiresSubmission:true, messaging, siteWorkflow:workflow,
        });
        guard.workflowMetadataRequirementsResolved = true;
        return guard;
      };
      const send = execution => agent._messageRecipientGuardBlock(1,'click',{selector:'#send'},url,execution);
      for (const timing of ['planning', 'after-navigation']) {
        for (const identity of ['Alex Volkov', 'altryne', '@altryne']) {
          // The plan can start on the conversation or reach it later.
          const pinned = await agent._pinActiveConversationMessagingTarget(
            1, named(identity), timing === 'planning' ? url : 'https://x.com/home',
          );
          assert.equal(pinned.ok, true);
          assert.deepEqual(pinned.target, timing === 'planning' ? canonical : named(identity));
          const guard = start(pinned.target);
          await page.locator('textarea').fill('Hello Alex');
          const execution = {};
          assert.equal(await send(execution), null, JSON.stringify({timing,identity}));
          assert.deepEqual(guard.messaging, canonical, 'bind the account handle before dispatch');
          const clicked = await call(page, 'click', {selector:'#send', ...execution});
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          agent._recordCompletionSubmitAttempt(1,{isSubmit:false},'click',{selector:'#send'},url,url,
            clicked,'doc','doc',execution);
          const submit = agent._completionSubmitStates.get(1);
          assert.deepEqual(submit.workflowBinding.recipientTargets, canonical.recipients);
          submit.observedAfterSubmit = true;
          const probe = await call(page,'probe_message_recipient_guard', {
            tool:'observe_active_conversation', adapterName:'twitter', expectedMessageBody:'Hello Alex',
          });
          const terminal = agent._workflowTerminalEvidenceFromDone(1,{relevantFormCount:1},url,
            {submit,relevantForms:1,verifiedFinalSubmit:false},probe);
          assert.equal(terminal?.verificationKind, 'message_sent', 'display-name sends can complete');
        }
      }
      assert.equal(await page.evaluate(() => window.fixtureSends), 6);

      await page.locator('textarea').fill('Another message');
      for (const target of [named('Alex'), named('Someone Else'), named('@someoneelse'),
        {target_kind:'named', recipients:[{identity:'Alex Volkov',role:'bcc'}]},
        {target_kind:'named', recipients:['Alex Volkov','Someone Else']}]) {
        const guard = start(target);
        const before = structuredClone(guard.messaging);
        assert.equal((await send({}))?.noDispatch, true, JSON.stringify(target));
        assert.deepEqual(guard.messaging, before, 'a mismatch cannot change the authorized target');
      }
      await page.locator('#header').evaluate(el => {
        const duplicate = el.cloneNode(true); duplicate.id='other-header';
        duplicate.href='/someoneelse'; duplicate.style.cssText='position:fixed;left:400px;top:55px'; el.after(duplicate);
      });
      start(named('Alex Volkov'));
      assert.equal((await send({}))?.noDispatch, true, 'ambiguous headers cannot resolve a name');
      await page.locator('#other-header').evaluate(el => el.remove());

      const guard = start(named('Alex Volkov'));
      const execution = {};
      assert.equal(await send(execution), null);
      assert.deepEqual(guard.messaging, canonical);
      // A different account must not inherit authorization, even when its
      // display name is the old handle or the same display-name alias.
      await page.locator('#header').evaluate(el => { el.href='/someoneelse'; });
      const stale = await call(page,'click',{selector:'#send', ...execution});
      assert.equal(stale.noDispatch, true, 'recipient changed between preflight and dispatch');
      for (const label of ['Alex Volkov','@altryne']) {
        await page.locator('#header span').evaluate((el,label) => { el.textContent=label; },label);
        assert.equal((await send({}))?.noDispatch, true, 'canonical handle cannot be rebound through an alias');
        assert.deepEqual(guard.messaging, canonical);
      }
      assert.equal(await page.evaluate(() => window.fixtureSends), 6, 'blocked retries never dispatch');
    });

    register(`${kind}: X group DMs pin the visible conversation route and header`, async (page) => {
      const { agent } = await setup(page);
      const url = 'https://x.com/i/chat/group-123';
      await page.goto(url);
      await setupContentHtml(page, `<!doctype html><style>
        #header {position:fixed;left:400px;top:20px}
        textarea {position:fixed;left:400px;bottom:20px;width:400px;height:50px}
        #send {position:fixed;left:820px;bottom:20px}
        [role=log] {position:fixed;left:400px;top:100px;width:400px;height:300px}
      </style><div id="header" data-testid="dm-conversation-username">Study Group</div>
      <div role="log" data-testid="dm-message-scroller" aria-busy="false"></div>
      <textarea data-testid="dm-composer-textarea"></textarea><button id="send" type="button">Send</button>`, kind);
      await page.evaluate(() => {
        window.fixtureSends = 0;
        document.querySelector('#send').addEventListener('click', () => {
          const composer = document.querySelector('textarea');
          const row = document.createElement('div');
          row.dataset.testid = 'message-' + ++window.fixtureSends;
          row.dataset.sendStatus = 'sent'; row.className = 'justify-end';
          const content = document.createElement('div'); content.dataset.testid = 'message-text-' + window.fixtureSends;
          const body = document.createElement('span'); body.dir = 'auto'; body.textContent = composer.value;
          content.append(body); row.append(content); document.querySelector('[role=log]').append(row);
          composer.value = '';
        });
      });
      const group = { target_kind: 'named', recipients: [{ identity: 'x-dm-group:group-123', role: 'to' }] };
      const named = identity => ({ target_kind: 'named', recipients: [{ identity, role: 'to' }] });
      const activePin = await agent._pinActiveConversationMessagingTarget(
        1, { target_kind: 'active_conversation', recipients: [] }, url,
      );
      assert.equal(activePin.ok, true, JSON.stringify(activePin));
      assert.equal(activePin.target.target_kind, 'named');
      assert.deepEqual(activePin.target.recipients.map(({ identity, role }) => ({ identity, role })), group.recipients,
        'the active group gets a route-bound identity');
      const namedPin = await agent._pinActiveConversationMessagingTarget(1, named('Study Group'), url);
      assert.deepEqual(namedPin.target, group, 'the visible group name resolves to that route');
      const handlePin = await agent._pinActiveConversationMessagingTarget(1, named('@studygroup'), url);
      assert.deepEqual(handlePin.target, named('@studygroup'), 'a group label cannot stand in for an account handle');

      const workflow = agent._resolvePlannerSiteWorkflow(url, {
        request_kind: 'execute', requires_submission: true, messaging: activePin.target,
      });
      const guard = agent._startPlanExecutionGuard(1, 'act', {
        requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
        messaging: activePin.target, siteWorkflow: workflow,
      });
      guard.workflowMetadataRequirementsResolved = true;
      await page.locator('textarea').fill('Hello Study Group');
      const execution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { selector: '#send' }, url, execution), null);
      assert.deepEqual(guard.messaging, group);
      const clicked = await call(page, 'click', { selector: '#send', ...execution });
      assert.equal(clicked.success, true, JSON.stringify(clicked));
      agent._recordCompletionSubmitAttempt(1, { isSubmit: false }, 'click', { selector: '#send' },
        url, url, clicked, 'doc', 'doc', execution);
      const submit = agent._completionSubmitStates.get(1);
      submit.observedAfterSubmit = true;
      const terminalProbe = await call(page, 'probe_message_recipient_guard', {
        tool: 'observe_active_conversation', adapterName: 'twitter', expectedMessageBody: 'Hello Study Group',
      });
      const terminal = agent._workflowTerminalEvidenceFromDone(1, { relevantFormCount: 1 }, url,
        { submit, relevantForms: 1, verifiedFinalSubmit: false }, terminalProbe);
      assert.equal(terminal?.verificationKind, 'message_sent', 'the group send has delivery evidence');

      await page.locator('textarea').fill('This must not send');
      const staleExecution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { selector: '#send' }, url, staleExecution), null);
      await page.evaluate(() => history.pushState({}, '', '/i/chat/group-456'));
      const stale = await call(page, 'click', { selector: '#send', ...staleExecution });
      assert.equal(stale.noDispatch, true, 'a changed conversation route invalidates the dispatch binding');
      assert.equal(await page.evaluate(() => window.fixtureSends), 1, 'the stale retry never dispatches');
    });

    register(`${kind}: X conversation navigation is not classified as sending a message`, async (page) => {
      const { agent } = await setup(page);
      await page.goto('https://x.com/i/chat/123-456');
      await setupContentHtml(page, `<!doctype html><style>
        a,button {display:inline-block;padding:12px} textarea {position:fixed;left:400px;bottom:20px}
      </style><nav><a id="home" href="/home">Home</a></nav>
      <header><button id="back" type="button" data-testid="dm-conversation-back-button">Back</button>
      <a id="profile" href="/altryne"><span data-testid="dm-conversation-username">Alex Volkov</span></a></header>
      <div role="log" data-testid="dm-message-scroller"><a id="message-link" href="/altryne">Message link</a></div>
      <textarea data-testid="dm-composer-textarea">Unsent draft</textarea><button id="send">Send</button>`, kind);
      await page.evaluate(() => {
        window.fixtureClicks = [];
        document.addEventListener('click', event => {
          const el = event.target.closest('a,button');
          if (el) { event.preventDefault(); window.fixtureClicks.push(el.id); }
        });
      });
      const url = page.url();
      const guard = (tool, args) => agent._messageRecipientGuardBlock(1, tool, args, url);
      // No recipient authorization exists in this read-only task.
      agent._startPlanExecutionGuard(1, 'act', {
        requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
      });
      for (const [id, label] of [['profile', 'Alex Volkov'], ['back', 'Back'], ['home', 'Home']]) {
        const ref_id = await page.locator('#' + id).evaluate(el => window.__wb_ax_ref(el));
        for (const [tool, args] of [['click', {selector:'#'+id}], ['click', {text:label}], ['click_ax', {ref_id}]]) {
          assert.equal(await guard(tool, args), null, JSON.stringify({id,tool,args}));
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
        }
      }
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks),
        ['profile','profile','profile','back','back','back','home','home','home']);
      const messageLinkProbe = await call(page, 'probe_message_recipient_guard', {
        tool:'click', args:{selector:'#message-link'}, adapterName:'twitter',
      });
      assert.notEqual(messageLinkProbe.navigation, true, 'message content is not trusted header navigation');
      for (const selector of ['#send']) {
        assert.equal((await guard('click', {selector}))?.noDispatch, true, selector);
      }
      await page.locator('#profile').evaluate(el => el.setAttribute('href', 'javascript:void(0)'));
      assert.notEqual((await call(page, 'probe_message_recipient_guard', {
        tool:'click', args:{selector:'#profile'}, adapterName:'twitter',
      })).navigation, true, 'unsafe destinations are not trusted header navigation');
      await page.locator('#back').evaluate(el => {
        const form = document.createElement('form'); el.before(form); form.append(el);
      });
      assert.equal((await guard('click', {selector:'#back'}))?.noDispatch, true, 'form lookalike');
      await page.evaluate(() => {
        const modal = document.createElement('div'); modal.role = 'dialog'; modal.setAttribute('aria-modal','true');
        modal.style.cssText = 'position:fixed;inset:0;background:white'; modal.textContent='Confirm';
        document.body.append(modal);
      });
      assert.equal((await guard('click', {selector:'#home'}))?.noDispatch, true, 'blocking modal');
      assert.equal(await page.locator('textarea').inputValue(), 'Unsent draft');
    });

    register(`${kind}: an aria-hidden assigned slot cannot make Send ambiguous`, async (page) => {
      await setup(page);
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        const host = document.createElement('div');
        const duplicate = document.createElement('button');
        duplicate.id = 'slotted-hidden-send';
        duplicate.slot = 'hidden-send';
        duplicate.type = 'button';
        duplicate.textContent = 'Send';
        host.append(duplicate);
        document.body.append(host);
        host.attachShadow({ mode: 'open' }).innerHTML = '<slot name="hidden-send" aria-hidden="true"></slot>';
      });
      const result = await call(page, 'click', { text: 'Send', textMatch: 'exact' });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['send'],
        'the assigned hidden control must not be a click candidate');
    });

    const addPostEntry = async (page, shadow = false) => page.evaluate((shadow) => {
      const host = document.createElement('section');
      host.id = 'post-entry';
      document.querySelector('main').prepend(host);
      const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
      root.innerHTML = '<button id="start-post" type="button" style="padding:12px"><span>Start a post</span></button>';
      const button = root.querySelector('button');
      button.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.id = 'post-composer';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.style.cssText = 'position:fixed;inset:100px;background:white';
        dialog.innerHTML = '<div contenteditable="true">Draft</div><button type="button">Post</button>';
        document.body.append(dialog);
      });
      const rect = button.getBoundingClientRect();
      return { ref_id: window.__wb_ax_ref(button.querySelector('span')), x: rect.x + 10, y: rect.y + 10 };
    }, shadow);

    register(`${kind}: LinkedIn Start a post opens without a message recipient across targeting methods`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const shadow of [false, true]) {
        const target = await addPostEntry(page, shadow);
        for (const chatOpen of [false, true]) {
          await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, chatOpen);
          // Both agents expose the full collector, including open shadow roots.
          const elements = await call(page, 'get_interactive_elements_cdp', {});
          const index = elements.find(element => element.text === 'Start a post')?.index;
          assert.ok(Number.isInteger(index), JSON.stringify(elements));
          const strategies = [
            ['click', { text: 'Start a post' }],
            ['click_ax', { ref_id: target.ref_id }],
            ['click', { index }],
            ['click', { x: target.x, y: target.y, coordinate_space: 'css' }],
            ...(!shadow ? [['click', { selector: '#start-post' }]] : []),
          ];
          for (const [tool, args] of strategies) {
            const result = await probe(tool, args);
            assert.equal(result.conclusive, true, JSON.stringify({ shadow, chatOpen, tool, args, result }));
            assert.equal(result.messageSend, false);
            assert.equal(await guard(tool, args), null);
            const clicked = await call(page, tool, args);
            assert.equal(clicked.success, true, JSON.stringify({ shadow, chatOpen, tool, args, clicked }));
            assert.equal(await page.locator('#post-composer').count(), 1,
              JSON.stringify({ shadow, chatOpen, tool, args, clicked }));
            // Opening a composer must not authorize its eventual publication.
            assert.equal((await guard('click', { text: 'Post' }))?.noDispatch, true);
            await page.locator('#post-composer').evaluate(el => el.remove());
          }
        }
        await page.locator('#post-entry').evaluate(el => el.remove());
      }
    });

    register(`${kind}: LinkedIn public Post is not a private-message send`, async (page) => {
      const { agent, guard, probe } = await setup(page);
      for (const route of ['/feed/','/sharing/compose']) {
        await page.evaluate(route=>history.replaceState({},'',route),route);
        for (const modal of [true,false]) {
          if (!modal && route === '/feed/') continue;
          await page.evaluate(modal=>{
            document.querySelector('main').innerHTML=`<section id="public" ${modal?'role="dialog" aria-modal="true"':''}>
              <div role="button">Post to Anyone</div><div contenteditable="true" role="textbox">Announcement</div>
              <button id="publish" type="button" data-control-name="share.post"><span>Post</span></button></section>`;
            document.getElementById('chat').hidden=true;
          },modal);
          const publishWorkflow = agent._resolvePlannerSiteWorkflow(page.url(), {
            request_kind: 'execute', site_job: 'publish-post', requires_submission: true,
          });
          assert.equal(publishWorkflow?.job?.id, 'publish-post');
          agent._startPlanExecutionGuard(1, 'act', {
            requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
            siteWorkflow: publishWorkflow,
          });
          const target=await page.evaluate(()=>{
            const span=document.querySelector('#publish span'),rect=span.getBoundingClientRect();
            return {ref_id:window.__wb_ax_ref(span),x:rect.x+2,y:rect.y+2};
          });
          const elements=await call(page,'get_interactive_elements_cdp',{});
          const index=elements.find(el=>el.text==='Post')?.index;
          for(const [tool,args] of [['click',{text:'Post'}],['click',{index}],['click_ax',{ref_id:target.ref_id}],
            ['click',{selector:'#publish span'}],['click',{x:target.x,y:target.y,coordinate_space:'css'}]]) {
            const observed=await probe(tool,args);
            assert.equal(observed.publicPost,true,JSON.stringify({route,modal,tool,args,observed}));
            assert.equal(observed.messageSend,false);
            assert.equal(await guard(tool,args),null);
          }
          // Public-composer proof cannot be borrowed by an adjacent DM, even
          // if the DM's button is misleadingly labelled Post.
          await page.evaluate(()=>{
            document.querySelector('#public').removeAttribute('aria-modal');
            document.querySelector('#public').removeAttribute('role');
            document.getElementById('chat').hidden=false;
            document.getElementById('send').textContent='Post';
          });
          assert.equal((await guard('click',{selector:'#send'}))?.noDispatch,true);
          assert.equal(agent._planExecutionGuards.get(1)?.messaging,null);
        }
      }
    });

    register(`${kind}: LinkedIn public-post classification requires matching composer evidence`, async (page) => {
      const {guard}=await setup(page);
      await page.evaluate(()=>history.replaceState({},'','/sharing/compose'));
      for(const variant of ['no-audience','two-editors','send-label','message-scope','form','hidden-audience']) {
        await page.evaluate(variant=>{
          document.querySelector('main').innerHTML=`<section role="dialog" aria-modal="true" ${variant==='message-scope'?'data-conversation-id="alice"':''}>
            ${variant==='form'?'<form>':''}
            ${variant==='no-audience'?'':`<div role="button" ${variant==='hidden-audience'?'hidden':''}>Post to Anyone</div>`}
            <div contenteditable="true">Draft</div>${variant==='two-editors'?'<div contenteditable="true">Other</div>':''}
            <button id="publish" type="button" ${variant==='send-label'?'aria-label="Send"':''}>Post</button>
            ${variant==='form'?'</form>':''}</section>`;
        },variant);
        assert.equal((await guard('click',{selector:'#publish'}))?.noDispatch,true,variant);
      }
    });

    register(`${kind}: LinkedIn post entry classification rejects send and publish lookalikes`, async (page) => {
      const { guard, probe } = await setup(page);
      await addPostEntry(page);
      for (const [attribute, value] of [
        ['type', 'submit'], ['aria-label', 'Send'], ['form', 'chat'], ['disabled', ''], ['aria-disabled', 'true'],
      ]) {
        await page.locator('#start-post').evaluate((el, [key, value]) => el.setAttribute(key, value), [attribute, value]);
        assert.notEqual((await probe('click', { selector: '#start-post' })).composerSetup, true, attribute);
        if (attribute === 'aria-label') assert.equal((await guard('click', { selector: '#start-post' }))?.noDispatch, true);
        await page.locator('#start-post').evaluate((el, key) => el.removeAttribute(key), attribute);
      }
      for (const label of ['Post', 'Send', 'Start a post and send', 'Photo']) {
        await page.locator('#start-post').evaluate((el, text) => { el.textContent = text; }, label);
        assert.notEqual((await probe('click', { selector: '#start-post' })).composerSetup, true, label);
        if (/Send|send/.test(label)) assert.equal((await guard('click', { selector: '#start-post' }))?.noDispatch, true, label);
      }
      await page.locator('#start-post').evaluate(el => { el.textContent = 'Start a post'; });
      await page.evaluate(() => history.replaceState(null, '', '/messaging/'));
      assert.equal((await guard('click', { text: 'Start a post' }))?.noDispatch, true, 'messaging route');
      await page.evaluate(() => history.replaceState(null, '', '/feed/'));
      for (const markup of ['<form></form>', '<article></article>', '<div role="dialog"></div>', '<div role="log"></div>']) {
        await page.evaluate(markup => {
          const wrapper = document.createElement('div');
          wrapper.id = 'entry-wrapper';
          wrapper.innerHTML = markup;
          document.querySelector('main').append(wrapper);
          wrapper.firstChild.append(document.querySelector('#post-entry'));
        }, markup);
        assert.notEqual((await probe('click', { text: 'Start a post' })).composerSetup, true, markup);
        await page.evaluate(() => {
          document.querySelector('main').append(document.querySelector('#post-entry'));
          document.querySelector('#entry-wrapper').remove();
        });
      }
      await page.evaluate(() => document.body.append(document.querySelector('#post-entry')));
      assert.notEqual((await probe('click', { text: 'Start a post' })).composerSetup, true, 'outside feed main');
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
    });

    register(`${kind}: LinkedIn post entry respects blocking shadow dialogs and ambiguous targets`, async (page) => {
      const { guard } = await setup(page);
      const { ref_id } = await addPostEntry(page, true);
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'shadow-modal';
        document.body.append(host);
        host.attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white"><button>Start a post</button></div>';
      });
      assert.equal((await guard('click_ax', { ref_id }))?.noDispatch, true, 'background control');
      assert.equal((await guard('click', { text: 'Start a post' }))?.noDispatch, true, 'dialog control');
      await page.locator('#shadow-modal').evaluate(el => el.remove());
      await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<button>Start a post</button>'));
      assert.equal((await guard('click', { text: 'Start a post' }))?.noDispatch, true, 'ambiguous controls');
      await page.locator('#post-entry').evaluate(el => el.remove());
      assert.equal((await guard('click_ax', { ref_id }))?.noDispatch, true, 'stale reference');
    });

    register(`${kind}: LinkedIn missing composer does not recommend alternate click retries`, async (page) => {
      const { guard } = await setup(page);
      const result = await guard('click', { selector: '#close-contact-info' });
      // Use a visible unresolved action so this is a classification failure,
      // not a stale/missing target that a fresh page read could repair.
      await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<div class="msg-form"><button id="unknown">Unknown action</button></div>'));
      const missingComposer = await guard('click', { selector: '#unknown' });
      assert.equal(missingComposer?.noDispatch, true);
      assert.equal(missingComposer?.reasonCode, 'message_send_classification_inconclusive');
      assert.equal(missingComposer?.retryable, false);
      assert.match(missingComposer?.error, /no message composer/i);
      assert.notEqual(result?.retryable, false, 'unresolved target should retain fresh-target recovery');
    });

    register(`${kind}: LinkedIn Home and Jobs navigate with closed and open message composers (#2999)`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const ref = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('#jobs-label')));
        for (const [tool, args, expected] of [
          ['click', { text: 'Jobs', textMatch: 'exact' }, 'jobs'],
          ['click', { text: 'Home' }, 'home'],
          ['click_ax', { ref_id: ref }, 'jobs'],
          ['click', { selector: '.destination', matchIndex: 1 }, 'jobs'],
          ['click', { text: 'Messag', textMatch: 'prefix' }, 'messaging'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
    });

    register(`${kind}: LinkedIn ordinary document links bypass the message recipient guard (#3010)`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const portfolioRef = await page.evaluate(
          () => window.__wb_ax_ref(document.querySelector('#portfolio-label')),
        );
        for (const [tool, args, expected] of [
          ['click', { text: 'View my portfolio', textMatch: 'exact' }, 'portfolio'],
          ['click_ax', { ref_id: portfolioRef }, 'portfolio'],
          ['click', { text: 'Contact info', textMatch: 'exact' }, 'contact-info'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(result.navigation, true);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
    });

    register(`${kind}: LinkedIn contact-info safety redirects navigate inside the modal (#3010)`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#contact-info-dialog').hidden = false;
      });
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const safetyRef = await page.evaluate(
          () => window.__wb_ax_ref(document.querySelector('#safety-portfolio')),
        );
        for (const [tool, args, expected] of [
          ['click', { text: 'portfolio.example', textMatch: 'exact' }, 'safety-portfolio'],
          ['click_ax', { ref_id: safetyRef }, 'safety-portfolio'],
          ['click', { text: 'legacy-portfolio.example', textMatch: 'exact' }, 'legacy-portfolio'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(result.navigation, true);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
      for (const href of [
        '#',
        'mailto:alice@example.com',
        'https://portfolio.example/',
        '/safety/go/',
        '/safety/go/?url=javascript%3Aalert(1)',
        '/safety/go/?url=https%3A%2F%2Flinkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com.%2Fmessaging%2Fsend',
      ]) {
        await page.locator('#safety-portfolio').evaluate((el, value) => el.setAttribute('href', value), href);
        const args = { text: 'portfolio.example', textMatch: 'exact' };
        const result = await probe('click', args);
        assert.notEqual(result.navigation, true, `${href}: ${JSON.stringify(result)}`);
        assert.equal((await guard('click', args))?.noDispatch, true, `${href}: recipient guard must fail closed`);
      }
    });

    register(`${kind}: LinkedIn contact-info redirects honor composed-tree safety boundaries`, async (page) => {
      const { guard, probe } = await setup(page);
      const refs = await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        const dialog = document.querySelector('#contact-info-dialog');
        dialog.hidden = false;
        const addShadowLink = (parent, hostId, text) => {
          const host = document.createElement('span');
          host.id = hostId;
          parent.append(host);
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.innerHTML = `<a href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F" style="display:inline-block;padding:8px">${text}</a>`;
          return window.__wb_ax_ref(shadow.querySelector('a'));
        };
        const form = document.createElement('form');
        dialog.append(form);
        const action = document.createElement('span');
        action.dataset.action = 'send';
        dialog.append(action);
        return {
          safe: addShadowLink(dialog, 'shadow-safe-host', 'Shadow safe link'),
          form: addShadowLink(form, 'shadow-form-host', 'Shadow form link'),
          action: addShadowLink(action, 'shadow-action-host', 'Shadow action link'),
        };
      });
      const safeArgs = { ref_id: refs.safe };
      const safe = await probe('click_ax', safeArgs);
      assert.equal(safe.navigation, true, JSON.stringify(safe));
      assert.equal(await guard('click_ax', safeArgs), null);
      for (const ref_id of [refs.form, refs.action]) {
        const args = { ref_id };
        const result = await probe('click_ax', args);
        assert.equal(result.navigationBlocked, true, JSON.stringify(result));
        assert.equal(result.conclusive, false, JSON.stringify(result));
        assert.equal((await guard('click_ax', args))?.noDispatch, true);
      }
    });

    register(`${kind}: LinkedIn safety redirects cannot escape a shadow-root modal`, async (page) => {
      const { guard, probe } = await setup(page);
      const ref_id = await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        const modal = document.createElement('div');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.style.cssText = 'position:fixed;inset:0;background:white';
        document.body.append(modal);
        const host = document.createElement('span');
        modal.append(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<a href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F" style="display:inline-block;padding:8px">Shadow modal link</a>';
        return window.__wb_ax_ref(shadow.querySelector('a'));
      });
      const args = { ref_id };
      const result = await probe('click_ax', args);
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click_ax', args))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn Contact info ownership crosses open shadow roots`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        const dialog = document.querySelector('#contact-info-dialog');
        dialog.hidden = false;
        const profile = document.querySelector('#contact-profile');
        const host = document.createElement('span');
        dialog.append(host);
        host.attachShadow({ mode: 'open' }).append(profile);
      });
      const args = { text: 'portfolio.example', textMatch: 'exact' };
      const result = await probe('click', args);
      assert.equal(result.navigation, true, JSON.stringify(result));
      assert.equal(await guard('click', args), null);
    });

    register(`${kind}: LinkedIn Contact info ownership follows flattened slots`, async (page) => {
      const { guard, probe } = await setup(page);
      const ref_id = await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#contact-info-dialog').remove();
        const host = document.createElement('div');
        const profile = document.createElement('a');
        profile.slot = 'profile';
        profile.href = '/in/alice/';
        profile.textContent = 'linkedin.com/in/alice';
        host.append(profile);
        document.body.append(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white">
            <slot name="profile"></slot>
            <a id="slotted-ownership-link" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F"
              style="display:inline-block;padding:8px">Slotted ownership link</a>
          </div>`;
        return window.__wb_ax_ref(shadow.querySelector('#slotted-ownership-link'));
      });
      const args = { ref_id };
      const result = await probe('click_ax', args);
      assert.equal(result.navigation, true, JSON.stringify(result));
      assert.equal(await guard('click_ax', args), null);
    });

    register(`${kind}: LinkedIn Contact info recognizes shadow-root overlay content siblings`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const [index, contentClass] of ['DialogContent', 'ModalContent'].entries()) {
        const ref_id = await page.evaluate(({ contentClass, index }) => {
          history.replaceState(null, '', '/in/alice/overlay/contact-info/');
          document.querySelector('#chat').hidden = false;
          const host = document.createElement('div');
          host.id = `shadow-sibling-modal-host-${index}`;
          document.body.append(host);
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.innerHTML = `
            <div class="DialogOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>
            <div class="${contentClass}" style="position:fixed;inset:40px;background:white">
              <a href="/in/alice/">linkedin.com/in/alice</a>
              <a id="sibling-modal-link" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F"
                style="display:inline-block;padding:8px">Sibling modal link</a>
            </div>`;
          return window.__wb_ax_ref(shadow.querySelector('#sibling-modal-link'));
        }, { contentClass, index });
        const args = { ref_id };
        const result = await probe('click_ax', args);
        assert.equal(result.navigation, true, `${contentClass}: ${JSON.stringify(result)}`);
        assert.equal(await guard('click_ax', args), null);
        await page.evaluate((index) => {
          document.querySelector(`#shadow-sibling-modal-host-${index}`)?.remove();
        }, index);
      }
      const ref_id = await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'shadow-content-without-overlay-host';
        document.body.append(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <div class="DialogContent" style="position:fixed;inset:40px;background:white">
            <a href="/in/alice/">linkedin.com/in/alice</a>
            <a id="content-without-overlay-link"
              href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F"
              style="display:inline-block;padding:8px">Unbacked content link</a>
          </div>`;
        return window.__wb_ax_ref(shadow.querySelector('#content-without-overlay-link'));
      });
      const result = await probe('click_ax', { ref_id });
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click_ax', { ref_id }))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn non-blocking dialogs cannot claim Contact info redirects`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        document.body.insertAdjacentHTML('beforeend', `
          <div role="dialog" style="position:fixed;inset:120px;background:white">
            <a href="/in/alice/">linkedin.com/in/alice</a>
            <a id="non-blocking-dialog-link" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F">Non-blocking dialog link</a>
          </div>`);
      });
      const args = { selector: '#non-blocking-dialog-link' };
      const result = await probe('click', args);
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click', args))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn safety redirects cannot escape a heuristic modal`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        const modal = document.createElement('div');
        modal.className = 'modal show';
        modal.style.cssText = 'position:fixed;inset:0;background:white';
        modal.innerHTML = '<a id="heuristic-modal-link" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F" style="display:inline-block;padding:8px">Heuristic modal link</a>';
        document.body.append(modal);
      });
      const args = { selector: '#heuristic-modal-link' };
      const result = await probe('click', args);
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click', args))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn safety redirects cannot escape a shadow-root heuristic modal`, async (page) => {
      const { guard, probe } = await setup(page);
      const ref_id = await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        const host = document.createElement('div');
        document.body.append(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <div class="modal show" style="position:fixed;inset:0;background:white">
            <a href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F" style="display:inline-block;padding:8px">Shadow heuristic modal link</a>
          </div>`;
        return window.__wb_ax_ref(shadow.querySelector('a'));
      });
      const args = { ref_id };
      const result = await probe('click_ax', args);
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click_ax', args))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn recipient guard rejects ambiguous navigation and action lookalikes`, async (page) => {
      const { guard, probe } = await setup(page);
      const messageActionHrefs = [
        '/messaging/compose/',
        '/messaging/send/',
        'https://linkedin.com/messaging/send/',
        'https://m.linkedin.com/messaging/send/',
        'https://m.linkedin.com./messaging/send/',
      ];
      await page.evaluate(() => { document.querySelector('#chat').hidden = false; });
      for (const href of messageActionHrefs) {
        await page.locator('#jobs').evaluate((el, value) => el.setAttribute('href', value), href);
        const args = { text: 'Jobs' };
        const result = await probe('click', args);
        assert.equal(result.navigationBlocked, true, `${href}: ${JSON.stringify(result)}`);
        assert.equal((await guard('click', args))?.noDispatch, true, href);
      }
      await page.evaluate(() => { document.querySelector('#chat').hidden = true; });
      for (const href of [
        '/safety/go/?url=https%3A%2F%2Fportfolio.example%2F',
        '/safety/go/',
        '/safety/go/?url=javascript%3Aalert(1)',
        '/safety/go/?url=https%3A%2F%2Fwww.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Flinkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com.%2Fmessaging%2Fsend',
      ]) {
        await page.locator('#jobs').evaluate((el, href) => el.setAttribute('href', href), href);
        assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, href);
      }
      await page.locator('#jobs').evaluate(el => el.setAttribute('href', '/jobs/'));
      for (const [attribute, value] of [['role', 'button'], ['data-action', 'send'], ['onclick', 'void(0)'], ['download', 'jobs']]) {
        await page.locator('#jobs').evaluate((el, [name, value]) => el.setAttribute(name, value), [attribute, value]);
        assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, attribute);
        await page.locator('#jobs').evaluate((el, name) => el.removeAttribute(name), attribute);
      }
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.querySelector('#send').textContent = 'Jobs';
      });
      assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, 'duplicate action label');
      // Text wins over selector at dispatch; matchIndex must also agree with
      // dispatch rather than accidentally approving the first selector match.
      await page.locator('#send').evaluate(el => { el.textContent = 'Send'; el.classList.add('destination'); });
      assert.equal((await guard('click', { text: 'Send', selector: '#jobs' }))?.noDispatch, true);
      assert.equal((await guard('click', { selector: '.destination', matchIndex: 2 }))?.noDispatch, true);
      assert.equal((await guard('click_ax', { ref_id: 'ref_missing' }))?.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
    });

    register(`${kind}: LinkedIn recipient guard disambiguates passive labels like click dispatch`, async (page) => {
      const { agent, guard } = await setup(page);
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.querySelector('#send').insertAdjacentHTML('beforebegin', '<label for="send">Send</label>');
      });
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      for (const args of [
        { text: 'Send', textMatch: 'exact' },
        { text: 'Sen', textMatch: 'prefix' },
        { text: 'end', textMatch: 'contains' },
        { text: 'Send' },
      ]) {
        const execution = {};
        assert.equal(await agent._messageRecipientGuardBlock(1, 'click', args, page.url(), execution), null);
        assert.equal(execution.messageRecipientGuardRequired, true);
        assert.ok(execution.messageRecipientDispatchBinding?.token);
        const clicked = await call(page, 'click', { ...args, ...execution });
        assert.equal(clicked.success, true, JSON.stringify(clicked));
        assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), 'send');
      }
      await page.locator('#send').evaluate(el => el.insertAdjacentHTML('afterend', '<button type="button">Send</button>'));
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'two interactive matches must remain ambiguous');
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['send', 'send', 'send', 'send']);
    });

    register(`${kind}: LinkedIn recipient guard accepts shadow controls inside the active modal`, async (page) => {
      const { agent, guard } = await setup(page);
      const ref = await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        chat.hidden = false;
        const modal = document.createElement('div');
        modal.id = 'modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.style.cssText = 'position:fixed;inset:0;background:white';
        document.body.append(modal);
        modal.append(chat);
        const host = document.createElement('span');
        host.id = 'send-host';
        document.querySelector('#send').replaceWith(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<button id="shadow-send" type="button" style="padding:8px">Send</button>';
        const send = shadow.querySelector('button');
        send.addEventListener('click', event => {
          event.preventDefault();
          window.fixtureClicks.push(send.id);
        });
        // This is exactly the distinction that ordinary contains() misses.
        if (modal.contains(send)) throw new Error('fixture target must cross a shadow boundary');
        return window.__wb_ax_ref(send);
      });
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      const args = { ref_id: ref };
      const execution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click_ax', args, page.url(), execution), null);
      assert.equal(execution.messageRecipientGuardRequired, true);
      assert.ok(execution.messageRecipientDispatchBinding?.token);
      const clicked = await call(page, 'click_ax', { ...args, ...execution });
      assert.equal(clicked.success, true, JSON.stringify(clicked));
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['shadow-send']);
      // Moving the same host outside the modal must not grant background access.
      await page.locator('#send-host').evaluate(host => document.body.append(host));
      assert.equal((await guard('click_ax', args))?.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['shadow-send']);
    });

    register(`${kind}: LinkedIn navigation respects modal scope and preserves send authorization`, async (page) => {
      const { agent, guard, probe } = await setup(page);
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.body.insertAdjacentHTML('beforeend', '<div id="modal" role="dialog" aria-modal="true" style="position:fixed;inset:80px;background:white"><button>Jobs</button></div>');
      });
      assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, 'modal text must not resolve background link');
      assert.equal((await guard('click', { selector: '#jobs' }))?.noDispatch, true, 'background selector must not bypass modal');
      await page.locator('#modal').evaluate(el => el.remove());
      const send = await probe('click', { text: 'Send' });
      assert.equal(send.messageSend, true, JSON.stringify(send));
      assert.deepEqual(send.strongIdentityCandidates, ['Alice']);
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'missing recipient');
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Bob'] } });
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'wrong recipient');
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      const execution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { text: 'Send' }, page.url(), execution), null);
      assert.equal(execution.messageRecipientGuardRequired, true);
      assert.ok(execution.messageRecipientDispatchBinding?.token);
      // A verified navigation classification must never permit replaying a
      // send binding after the action or conversation changed.
      await page.locator('#chat h2').evaluate(el => { el.textContent = 'Bob'; });
      const stale = await call(page, 'consume_message_recipient_dispatch_binding', execution);
      assert.equal(stale.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
    });
  }
}
