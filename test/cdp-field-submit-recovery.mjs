import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { Agent } from '../src/chrome/src/agent/agent.js';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

// Isolate the fallback's submission boundary with real Chromium input. The
// installed WhatsApp case separately verifies the actual monitor veto, durable
// pending-send block and shipped reconciliation card before any later send.
// A combobox's ArrowDown nudge comes before Enter: a veto there is the same
// pre-Enter state (a Discord send once stayed pending behind it).
test('trusted field fallback preserves draft proof only for a pre-Enter veto', async t => {
  const browser = await chromium.launch({ headless: true });
  const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
  const originals = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const body = 'One exact native draft with spaces  and Unicode ı 🧠.';
  try {
    for (const boundary of ['before-enter', 'before-combobox-nudge', 'lost-enter-response', 'after-enter']) await t.test(boundary, async () => {
      const preEnter = boundary === 'before-enter' || boundary === 'before-combobox-nudge';
      const context = await browser.newContext();
      const posts = [], commands = [];
      await context.route('**/*', route => {
        if (route.request().method() === 'POST') {
          posts.push(route.request().postDataJSON());
          return route.fulfill({ status: 201, contentType: 'application/json', body: '{"saved":true}' });
        }
        return route.fulfill({ contentType: 'text/html', body: '<textarea id="editor" style="width:800px;height:90px"></textarea>' });
      });
      const page = await context.newPage(); await page.goto('https://owned-submit.invalid/');
      await page.evaluate(() => {
        window.qaInputs = []; window.qaEnter = 0; window.qaArrows = 0;
        const editor = document.querySelector('#editor');
        editor.addEventListener('input', event => qaInputs.push({ trusted: event.isTrusted, value: editor.value }));
        editor.addEventListener('keydown', event => {
          if (event.key === 'ArrowDown') qaArrows++;
          if (event.key !== 'Enter') return;
          event.preventDefault(); qaEnter++;
          void fetch('/owned-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: editor.value }) });
        });
      });
      globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: value => value },
        tabs: { get: async id => ({ id, url: page.url() }), sendMessage: async (_tab, message) => {
          const params = message.params || {};
          if (message.action === 'field_value_digest') return { success: false };
          if (message.action === 'consume_message_recipient_dispatch_binding') return { success: true };
          if (message.action === 'ax_prepare_field_for_trusted_type') return page.evaluate(isCombobox => {
            const editor = document.querySelector('#editor'); editor.focus(); editor.select();
            return { success: true, contentEditable: false, isCombobox };
          }, boundary === 'before-combobox-nudge');
          if (message.action === 'ax_verify_field_value') return page.evaluate(expected => {
            const editor = document.querySelector('#editor');
            return { success: true, verified: editor.value === expected, actual: editor.value };
          }, params.expected);
          throw new Error(`Unexpected fallback message ${message.action}`);
        } } };
      const session = await context.newCDPSession(page);
      cdpClient.attach = async () => {};
      cdpClient.sendCommand = async (_tab, method, params) => {
        const enterDown = method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key === 'Enter';
        const nudgeDown = method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key === 'ArrowDown';
        if (nudgeDown && boundary === 'before-combobox-nudge') throw Object.assign(new Error('Owned monitor veto before the nudge'), { code: 'page_feedback_pending' });
        const enterUp = method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && params.key === 'Enter';
        if (enterDown && boundary === 'before-enter') throw Object.assign(new Error('Owned monitor veto before dispatch'), { code: 'page_feedback_pending' });
        commands.push({ method, params });
        const result = await session.send(method, params);
        if (enterDown && boundary === 'lost-enter-response') throw new Error('Owned lost Enter acknowledgement');
        if (enterUp && boundary === 'after-enter') throw Object.assign(new Error('Owned feedback after actual Enter'), { code: 'page_feedback_pending' });
        return result;
      };
      const agent = new Agent({});
      const result = await agent._maybeFallbackFieldWithCdpImpl(10, 'set_field',
        { ref_id: 'ref_owned', text: body, clear: true, submit: true },
        { success: false, verified: false, noDispatch: true, dispatched: false, _expectedValue: body, error: 'Owned native input required' },
        { messageRecipientGuardRequired: true });
      const native = await page.evaluate(() => ({ body: document.querySelector('#editor').value, inputs: qaInputs, enter: qaEnter, arrows: qaArrows }));
      for (let attempt = 0; !preEnter && !posts.length && attempt < 20; attempt++) await page.waitForTimeout(10);
      assert.equal(native.body, body); assert.deepEqual(native.inputs, [{ trusted: true, value: body }]);
      assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 1);
      assert.equal(result.success, false); assert.equal(result.dispatched, true); assert.notEqual(result.noDispatch, true);
      assert.notEqual(result.submitted, true); assert.equal(result.pageHandledBeforeInput, undefined);
      if (preEnter) {
        assert.equal(native.enter, 0); assert.deepEqual(posts, []); assert.equal(native.arrows, 0);
        assert.equal(commands.some(command => command.params?.key === 'Enter'), false, 'Enter is never sent after a pre-Enter veto.');
        assert.equal(result.verified, true); assert.equal(result.trusted, true);
        assert.equal(result.submissionDispatched, false); assert.equal(result.submissionBlockedBeforeDispatch, true);
        assert.equal(result.submissionBlockReason, 'page_feedback_pending');
        assert.equal(result.submissionOutcomeUnknown, false); assert.equal(result.outcomeUnknown, true);
        assert.equal(result.repeatBlocked, true); assert.equal(result.retryable, false);
      } else {
        assert.equal(native.enter, 1); assert.deepEqual(posts, [{ body }]);
        assert.notEqual(result.submissionDispatched, false, 'A lost acknowledgement or post-Enter failure cannot prove no submission.');
        assert.notEqual(result.submissionBlockedBeforeDispatch, true);
      }
      await session.detach(); await context.close();
    });
  } finally {
    Object.assign(cdpClient, originals); globalThis.chrome = originalChrome; globalThis.browser = originalBrowser;
    await browser.close();
  }
});
