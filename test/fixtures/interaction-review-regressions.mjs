import { strict as assert } from 'node:assert';

export function registerInteractionReviewRegressions({
  test, firefoxTest, setupContentHtml, call, Agent, FirefoxAgent,
}) {
  for (const [kind, register, AgentClass] of [
    ['chrome', test, Agent],
    ['firefox', firefoxTest, FirefoxAgent],
  ]) {
    register(`${kind}: passive primary text cannot outrank an actionable Search button`, async page => {
      await setupContentHtml(page, `<!doctype html><style>
        #banner { position:fixed;top:40px;left:40px;width:100px;height:40px }
        #composer { position:fixed;bottom:20px;left:40px;width:260px;height:40px }
        #go { position:fixed;bottom:20px;left:320px;width:100px;height:40px }
      </style>
      <div id="banner" aria-label="Search">Search</div>
      <textarea id="composer">Draft</textarea>
      <button id="go" aria-label="Search">🔍</button>`, kind);
      await page.evaluate(() => {
        window.fixtureClicks = [];
        for (const id of ['banner', 'go']) {
          document.getElementById(id).addEventListener('click', () => window.fixtureClicks.push(id));
        }
      });
      const args = { text: 'Search', textMatch: 'exact' };
      const probe = await call(page, 'probe_message_recipient_guard', { tool: 'click', args, adapterName: 'gmail' });
      // Only the real button is adjacent to the composer. This also verifies
      // that preflight and dispatch resolve the same control.
      assert.equal(probe.messageSend, true, JSON.stringify(probe));
      assert.equal((await call(page, 'click', args)).success, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['go']);
    });

    register(`${kind}: attribute fallback text retains ambiguity between different controls`, async page => {
      for (const attribute of ['placeholder', 'title', 'aria-label']) {
        await setupContentHtml(page, `<!doctype html>
          <input id="q" ${attribute}="Search" ${attribute !== 'aria-label' ? 'aria-label="Search people"' : ''}>
          <button id="go" aria-label="Search">🔍</button>`, kind);
        await page.evaluate(() => {
          window.fixtureClicks = [];
          document.addEventListener('click', event => window.fixtureClicks.push(event.target.id));
        });
        const args = { text: 'Search', textMatch: 'exact' };
        const probe = await call(page, 'probe_message_recipient_guard', { tool: 'click', args, adapterName: 'gmail' });
        assert.equal(probe.conclusive, false, JSON.stringify({ attribute, probe }));
        const clicked = await call(page, 'click', args);
        assert.equal(clicked.success, false, JSON.stringify({ attribute, clicked }));
        assert.match(clicked.error, /ambiguous/i);
        assert.equal(clicked.candidates.length, 2, JSON.stringify(clicked));
        assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
      }
    });

    register(`${kind}: LinkedIn ordinary browsing remains available without a composer`, async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://www.linkedin.com/feed/');
      await setupContentHtml(page, `<!doctype html><main>
        <button id="follow">Follow</button><button id="like">Like</button>
        <button id="connect">Connect</button><button id="filters" data-action="filters">Filters</button>
        <input id="apply" type="submit" value="Apply">
        <a id="profile" href="/in/jane-doe/">Jane Doe</a>
        <a id="job" href="/jobs/view/123/">Job details</a>
        <a id="fragment" href="#details">Details</a>
        <a id="script" href="javascript:void(0)">Menu</a>
        <a id="email" href="mailto:jane@example.com">Email Jane</a>
        <div class="msg-form"><button id="message-action">Confirm delivery</button></div>
        <button id="send">Send invitation</button>
      </main>`, kind);
      await page.evaluate(() => {
        window.fixtureClicks = [];
        document.addEventListener('click', event => {
          event.preventDefault();
          window.fixtureClicks.push(event.target.id);
        });
      });
      const agent = new AgentClass({ getActive: () => ({ supportsVision: false }) });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      const ids = ['follow', 'like', 'connect', 'filters', 'apply', 'profile', 'job', 'fragment', 'script', 'email'];
      for (const route of ['/feed/', '/in/jane-doe/', '/jobs/']) {
        await page.evaluate(route => history.replaceState({}, '', route), route);
        for (const id of ids) {
          const args = { selector: '#' + id };
          const probe = await call(page, 'probe_message_recipient_guard', { tool: 'click', args, adapterName: 'linkedin' });
          assert.equal(probe.messageSend, false, JSON.stringify({ route, id, probe }));
          assert.equal(probe.conclusive, true, JSON.stringify({ route, id, probe }));
          assert.equal(await agent._messageRecipientGuardBlock(1, 'click', args, page.url()), null, id);
          assert.equal((await call(page, 'click', args)).success, true, id);
        }
        for (const id of ['message-action', 'send']) {
          assert.equal((await agent._messageRecipientGuardBlock(1, 'click', { selector: '#' + id }, page.url()))?.noDispatch, true, id);
        }
      }
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), [...ids, ...ids, ...ids]);
      await page.evaluate(() => history.replaceState({}, '', '/messaging/'));
      assert.equal((await agent._messageRecipientGuardBlock(1, 'click', { selector: '#filters' }, page.url()))?.noDispatch, true);
    });

    register(`${kind}: text clicks prefer eligible controls before visible text`, async page => {
      for (const variant of ['disabled', 'aria-disabled', 'fieldset', 'covered', 'enabled']) {
        await setupContentHtml(page, `<!doctype html>
          <style>
            body { margin: 0 }
            button { position: fixed; top: 40px; width: 100px; height: 40px }
            #primary { left: 40px } #glyph { left: 200px }
            #cover { position: fixed; top: 40px; left: 40px; width: 100px; height: 40px; z-index: 10 }
          </style>
          <fieldset ${variant === 'fieldset' ? 'disabled' : ''}>
            <button id="primary" ${variant === 'disabled' ? 'disabled' : ''}
              ${variant === 'aria-disabled' ? 'aria-disabled="true"' : ''}><span aria-label="Search">Search</span></button>
          </fieldset>
          <button id="glyph" aria-label="Search">⌕</button>
          ${variant === 'covered' ? '<div id="cover"></div>' : ''}`, kind);
        await page.evaluate(() => {
          window.fixtureClicks = [];
          document.querySelectorAll('button').forEach(button => {
            button.addEventListener('click', () => window.fixtureClicks.push(button.id));
          });
        });
        const args = { text: 'Search', textMatch: 'exact' };
        const probe = await call(page, 'probe_message_recipient_guard', {
          tool: 'click', args, adapterName: 'gmail',
        });
        assert.equal(probe.messageSend, false, JSON.stringify({ variant, probe }));
        assert.equal(probe.conclusive, true, JSON.stringify({ variant, probe }));
        const clicked = await call(page, 'click', args);
        assert.equal(clicked.success, true, JSON.stringify({ variant, clicked }));
        assert.deepEqual(await page.evaluate(() => window.fixtureClicks),
          [variant === 'enabled' ? 'primary' : 'glyph'], variant);
      }
    });

    register(`${kind}: Gmail advanced search dialog is not a message composer`, async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://mail.google.com/mail/u/0/');
      await setupContentHtml(page, `<!doctype html>
        <style>
          body { margin: 0 }
          [role=dialog] { position: fixed; top: 20px; left: 40px; width: 400px; padding: 20px; background: white }
          input, textarea { display: block; width: 300px; height: 40px }
        </style>
        <div role="dialog" aria-modal="true" aria-label="Advanced search">
          <label>Has the words <input id="words" value="budget"></label>
          <button id="search">Search</button>
        </div>`, kind);
      await page.locator('#words').focus();
      await page.evaluate(() => {
        window.fixtureClicks = 0;
        document.querySelector('#search').addEventListener('click', () => window.fixtureClicks++);
      });
      const agent = new AgentClass({ getActive: () => ({ supportsVision: false }) });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      for (const args of [{ selector: '#search' }, { text: 'Search', textMatch: 'exact' }]) {
        const probe = await call(page, 'probe_message_recipient_guard', {
          tool: 'click', args, adapterName: 'gmail',
        });
        assert.equal(probe.messageSend, false, JSON.stringify(probe));
        assert.equal(probe.conclusive, true, JSON.stringify(probe));
        assert.equal(await agent._messageRecipientGuardBlock(1, 'click', args, page.url()), null);
        assert.equal((await call(page, 'click', args)).success, true);
      }
      assert.equal(await page.evaluate(() => window.fixtureClicks), 2);
      // A multiline filter is still not compose evidence.
      await page.locator('#words').evaluate(input => {
        const textarea = document.createElement('textarea');
        textarea.id = input.id;
        textarea.value = input.value;
        input.replaceWith(textarea);
        textarea.focus();
      });
      const searchProbe = await call(page, 'probe_message_recipient_guard', {
        tool: 'click', args: { selector: '#search' }, adapterName: 'gmail',
      });
      assert.equal(searchProbe.messageSend, false, JSON.stringify(searchProbe));
      for (const disabled of ['disabled', 'aria-disabled', 'fieldset']) {
        await page.evaluate(disabled => {
          const decoy = document.createElement('div');
          decoy.id = 'decoy';
          decoy.innerHTML = disabled === 'fieldset'
            ? '<fieldset disabled><button>Send</button></fieldset>'
            : '<button ' + (disabled === 'disabled' ? 'disabled' : 'aria-disabled="true"') + '>Send</button>';
          document.querySelector('[role=dialog]').append(decoy);
        }, disabled);
        const probe = await call(page, 'probe_message_recipient_guard', {
          tool: 'click', args: { selector: '#search' }, adapterName: 'gmail',
        });
        assert.equal(probe.messageSend, false, JSON.stringify({ disabled, probe }));
        assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { selector: '#search' }, page.url()), null);
        await page.locator('#decoy').evaluate(el => el.remove());
      }
      // A real upper-page composer must still require a recipient.
      await page.evaluate(() => {
        document.querySelector('[role=dialog]').setAttribute('aria-label', 'New Message');
        const button = document.querySelector('#search');
        button.id = 'send';
        button.textContent = 'Send';
      });
      const sendProbe = await call(page, 'probe_message_recipient_guard', {
        tool: 'click', args: { selector: '#send' }, adapterName: 'gmail',
      });
      assert.equal(sendProbe.messageSend, true, JSON.stringify(sendProbe));
      assert.equal(sendProbe.composerAvailable, true, JSON.stringify(sendProbe));
      assert.equal((await agent._messageRecipientGuardBlock(1, 'click', { selector: '#send' }, page.url()))?.noDispatch, true);
      // A disabled Send button is valid in an empty real Gmail draft, where
      // the dedicated body editor supplies the missing compose evidence.
      await page.evaluate(() => {
        const editor = document.createElement('div');
        editor.contentEditable = 'true';
        editor.setAttribute('role', 'textbox');
        editor.setAttribute('g_editable', 'true');
        editor.style.cssText = 'width:300px;height:40px';
        document.querySelector('#words').replaceWith(editor);
        document.querySelector('#send').disabled = true;
        editor.focus();
      });
      const emptyDraft = await call(page, 'probe_message_recipient_guard', {
        tool: 'observe_active_conversation', adapterName: 'gmail',
      });
      assert.equal(emptyDraft.composerAvailable, true, JSON.stringify(emptyDraft));
      assert.equal(emptyDraft.composerEmpty, true, JSON.stringify(emptyDraft));
      assert.equal((await agent._messageRecipientGuardBlock(1, 'press_keys', { key: 'Enter' }, page.url()))?.noDispatch, true);
    });
  }
}
