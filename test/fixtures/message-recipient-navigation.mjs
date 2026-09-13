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
        '#',
        'javascript:void(0)',
        'mailto:alice@example.com',
        '/in/alice/',
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
