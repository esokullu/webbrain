import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

const address = 'owner@example.test';
const html = `<!doctype html><style>
  body { margin: 0; font: 16px sans-serif; }
  [role=dialog] { position: fixed; inset: 60px 80px; background: white; padding: 20px; display: flex; flex-direction: column; }
  .recipient-row { display: flex; gap: 12px; padding: 8px; }
  input { display: block; height: 26px; min-width: 180px; }
  [contenteditable] { flex: 1; min-height: 120px; width: 400px; padding: 12px; }
  button { padding: 10px; }
</style><input type=search aria-label="Search mail" value="unrelated@example.test">
<div role=dialog aria-label="New Message">
  <form><div class=recipient-row data-recipient-type=to>
    <span id=recipient email="${address}">${address}</span>
    <input id=to name=to aria-label="To recipients">
  </div><input name=subjectbox aria-label=Subject value="PR summary"></form>
  <div id=body role=textbox aria-label="Message Body" contenteditable=true>Hello, here is the PR summary.</div>
  <button id=send type=button>Send (Ctrl-Enter)</button>
  <span role=status>Draft saved</span>
</div>`;

async function call(page, action, params = {}) {
  return page.evaluate(({ action, params }) => new Promise(resolve => {
    window.__wb_handler({ target: 'content', action, params }, {}, resolve);
  }), { action, params });
}

for (const [kind, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(kind + ': unresolved Google account iframe controls are target errors, while Send remains blocked', async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const top = '<!doctype html><style>body{margin:0}a{display:block;width:150px;height:30px}iframe{width:600px;height:400px}</style>'
        + '<header><a id="account" role="button" aria-label="Google Account: Fixture Owner">Account</a></header>'
        + '<iframe src="https://ogs.google.com/u/0/widget/account"></iframe>';
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: route.request().url().startsWith('https://ogs.google.com/')
        ? '<!doctype html><a href="https://myaccount.google.com/">Manage your Google Account</a><a href="https://accounts.google.com/AddSession">Add another account</a>'
        : top }));
      await page.goto('https://mail.google.com/mail/u/0/#inbox');
      const runtime = kind === 'firefox' ? 'browser' : 'chrome';
      await page.addScriptTag({ content: 'window.' + runtime + '={runtime:{onMessage:{addListener(handler){window.__wb_handler=handler}}}}' });
      for (const name of ['accessibility-tree', 'rich-text-toolbar-heuristic', 'content'])
        await page.addScriptTag({ content: await readFile(new URL('../src/' + kind + '/src/content/' + name + '.js', import.meta.url), 'utf8') });
      await page.evaluate(() => {
        window.fixtureAccountOpens = 0;
        document.querySelector('#account').addEventListener('click', () => window.fixtureAccountOpens++);
      });
      const { Agent } = await import('../src/' + kind + '/src/agent/agent.js');
      const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: [{ identity: address, role: 'to' }] } });
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { selector: '#account' }, page.url()), null);
      assert.equal((await call(page, 'click', { selector: '#account' })).success, true);
      assert.equal(await page.evaluate(() => window.fixtureAccountOpens), 1);
      for (const text of ['Manage your Google Account', 'Add another account', 'Send']) {
        const probe = await call(page, 'probe_message_recipient_guard', {
          tool: 'click', args: { text }, adapterName: 'gmail', supportsRecipientSets: true,
        });
        assert.equal(probe.reasonCode, 'message_target_unresolved');
        assert.equal(probe.targetResolved, false);
        const blocked = await agent._messageRecipientGuardBlock(1, 'click', { text }, page.url());
        assert.equal(blocked?.noDispatch, true);
        assert.equal(blocked?.dispatched, false);
        assert.equal(blocked?.reasonCode, 'message_target_unresolved');
        assert.match(blocked?.error, /control could not be resolved/);
        assert.doesNotMatch(blocked?.error, /not the recipient authorized|active conversation does not exactly match/);
      }
      assert.equal(await page.evaluate(() => window.fixtureAccountOpens), 1);
    } finally { await browser.close(); }
  });
  test(`${kind}: only observed Gmail compose drafts bypass email reservation; Send and other fields stay protected`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('https://mail.google.com/mail/u/0/#inbox?compose=fixture');
      const { BotMemorySession, observeBotMemoryPage } = await import(`../src/${kind}/src/agent/bot-memory.js`);
      const api = { scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: await page.evaluate(func, args[0]) }] } };
      const config = { version: 1, policyVersion: 1, botId: 'bot', runId: 'run',
        callbackUrl: 'https://app.example.test/api/internal/bot-memory/run', callbackToken: 'fixture-private-capability-'.repeat(3),
        policy: { schemaVersion: 1, actions: [{ key: 'send-email', effect: 'write' }] }, context: {} };
      const create = () => {
        const calls = [];
        const session = new BotMemorySession(config, {
          observe: (tab, args) => observeBotMemoryPage(tab, args, api),
          fetchImpl: async (_, options) => {
            const { operation, args } = JSON.parse(options.body); calls.push({ operation, args });
            // Deliberately classify every callback as the email write: known
            // drafts must not consume that reservation even with a bad model.
            if (operation === 'prepare') return Response.json({ allowed: true, reservation: {
              attemptId: 'email-attempt', requestId: args.requestId, actionKey: 'send-email', target: args.observation.targets[0],
            } });
            if (operation === 'dispatch') return Response.json({ attempt: { id: 'email-attempt', status: 'dispatched' } });
            return Response.json({ success: true });
          },
        });
        return { session, calls };
      };
      const draft = create();
      for (const selector of ['#body', '[name="subjectbox"]', '#to']) {
        const observed = await draft.session.observation(1, 'set_field', { selector });
        assert.equal(observed.elementFacts.gmailDraftField, true, selector);
        assert.deepEqual(await draft.session.prepare(1, 'set_field', { selector, text: 'Draft only', submit: false }), {
          allowed: true, readOnly: true, draftOnly: true,
        });
      }
      assert.deepEqual(draft.calls, []);
      assert.equal((await draft.session.prepare(1, 'set_field', { selector: '#body', text: 'Default non-submitting draft' })).draftOnly, true);
      assert.deepEqual(draft.calls, [], 'omitted submit uses the tool documented false default');
      assert.equal(draft.session.pending.size, 0);
      await draft.session.close();

      for (const [tool, args, flags] of [
        ['click', { selector: '#send' }, { consequentialSubmit: true, detectedSubmit: true }],
        ['set_field', { selector: '#body', text: 'Send this', submit: true }, {}],
        ['set_field', { selector: '#body', text: 'Invalid submit flag', submit: 'false' }, {}],
        ['set_field', { selector: '#body', text: 'Draft', submit: false }, { detectedSubmit: true }],
      ]) {
        const protectedAction = create();
        const prepared = await protectedAction.session.prepare(1, tool, args, flags);
        assert.equal(prepared.draftOnly, undefined);
        assert.ok(prepared.reservation);
        assert.deepEqual(protectedAction.calls.map(call => call.operation), ['prepare', 'dispatch']);
        await protectedAction.session.close();
      }
      await page.locator('[role="dialog"]').evaluate(el => el.insertAdjacentHTML('beforeend', '<input id="business-record" name="customer_status" value="draft">'));
      const business = create();
      assert.equal((await business.session.observation(1, 'set_field', { selector: '#business-record' })).elementFacts.gmailDraftField, undefined);
      const prepared = await business.session.prepare(1, 'set_field', { selector: '#business-record', text: 'approved', submit: false, gmailDraftField: true });
      assert.ok(prepared.reservation, 'a model argument must not forge observed draft identity');
      assert.deepEqual(business.calls.map(call => call.operation), ['prepare', 'dispatch']);
      await business.session.close();

      for (const origin of ['https://mail.google.com.attacker.test', 'https://crm.example.test']) {
        await page.goto(origin + '/mail/u/0/');
        const generic = create();
        assert.equal((await generic.session.observation(1, 'set_field', { selector: '#body' })).elementFacts.gmailDraftField, undefined);
        assert.ok((await generic.session.prepare(1, 'set_field', { selector: '#body', text: 'External update', submit: false })).reservation);
        assert.deepEqual(generic.calls.map(call => call.operation), ['prepare', 'dispatch']);
        await generic.session.close();
      }
    } finally {
      await browser.close();
    }
  });
  test(`${kind}: Gmail recipient inputs and subject do not break verification or allow retargeted Send`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      // No real mailbox, credentials, HTTP requests, or external messages.
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('https://mail.google.com/mail/u/0/#inbox?compose=fixture');
      const runtime = kind === 'firefox' ? 'browser' : 'chrome';
      await page.addScriptTag({ content: `window.${runtime} = { runtime: { onMessage: {
        addListener(handler) { window.__wb_handler = handler; }
      } } };` });
      for (const name of ['accessibility-tree', 'rich-text-toolbar-heuristic', 'content']) {
        await page.addScriptTag({ content: await readFile(new URL(`../src/${kind}/src/content/${name}.js`, import.meta.url), 'utf8') });
      }
      await page.evaluate(() => {
        window.fixtureSends = 0;
        document.querySelector('#send').addEventListener('click', () => { window.fixtureSends++; });
      });
      const { Agent } = await import(`../src/${kind}/src/agent/agent.js`);
      const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      const expected = [{ identity: address, role: 'to' }];
      const authorize = recipients => agent._planExecutionGuards.set(1, {
        messaging: { target_kind: 'named', recipients },
      });
      const observe = (recipients = expected) => call(page, 'probe_message_recipient_guard', {
        tool: 'click', args: { selector: '#send' }, adapterName: 'gmail',
        supportsRecipientSets: true, expectedRecipients: recipients, bindDispatch: true,
      });
      const sendGuard = context => agent._messageRecipientGuardBlock(1, 'click', { selector: '#send' }, page.url(), context);

      const probe = await observe();
      assert.equal(probe.success, true, JSON.stringify(probe));
      assert.equal(probe.messageSend, true, JSON.stringify(probe));
      assert.equal(probe.composerSubject, 'PR summary');
      assert.deepEqual(probe.strongRecipientCandidates, expected);
      assert.ok(probe.messageRecipientDispatchBinding?.token);
      authorize(expected);
      const first = {};
      assert.equal(await sendGuard(first), null);
      const sent = await call(page, 'click', { selector: '#send', ...first });
      assert.equal(sent.success, true, JSON.stringify(sent));
      assert.equal(await page.evaluate(() => window.fixtureSends), 1);

      // Same address but a different role, or a different address, never inherits authorization.
      for (const recipients of [[{ identity: 'other@example.test', role: 'to' }], [{ identity: address, role: 'cc' }]]) {
        authorize(recipients);
        assert.equal((await sendGuard({}))?.noDispatch, true);
      }
      authorize(expected);
      const bound = {};
      assert.equal(await sendGuard(bound), null);
      await page.locator('#recipient').evaluate(el => {
        el.setAttribute('email', 'other@example.test'); el.textContent = 'other@example.test';
      });
      assert.equal((await call(page, 'click', { selector: '#send', ...bound })).noDispatch, true);
      assert.equal(await page.evaluate(() => window.fixtureSends), 1);

      // The typed To value is also authoritative before Gmail creates a chip.
      await page.locator('#recipient').evaluate(el => el.remove());
      await page.locator('#to').fill(address);
      assert.deepEqual((await observe()).strongRecipientCandidates, expected);
      assert.equal(await sendGuard({}), null);

      // CC and BCC require the complete authorized recipient-role set.
      await page.locator('#to').evaluate(el => el.closest('form').insertAdjacentHTML('beforeend', `
        <div class="recipient-row" data-recipient-type="cc"><input name="cc" aria-label="Cc recipients" value="copy@example.test"></div>
        <div class="recipient-row" data-recipient-type="bcc"><input name="bcc" aria-label="Bcc recipients" value="private@example.test"></div>`));
      assert.equal((await sendGuard({}))?.noDispatch, true, 'unapproved CC/BCC must block');
      const all = [...expected, { identity: 'copy@example.test', role: 'cc' }, { identity: 'private@example.test', role: 'bcc' }];
      authorize(all);
      assert.deepEqual((await observe(all)).strongRecipientCandidates, all);
      assert.equal(await sendGuard({}), null);
      assert.equal(await page.evaluate(() => window.fixtureSends), 1);
    } finally {
      await browser.close();
    }
  });
}
