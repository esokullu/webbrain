import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `Missing end of function: ${name}`);
  return source.slice(start, end + 2);
}

async function messageState(page) {
  // Waiting for a task boundary lets the production MutationObserver run.
  return page.evaluate(() => new Promise(resolve => setTimeout(() => {
    const message = currentAssistantEl;
    const box = message.getBoundingClientRect();
    resolve({
      awaiting: message.classList.contains('assistant-awaiting-content'),
      display: getComputedStyle(message).display,
      height: box.height,
      copyCount: message.querySelectorAll('.msg-copy-btn, .code-copy-btn').length,
      copyOpacity: message.querySelector('.msg-copy-btn')
        ? getComputedStyle(message.querySelector('.msg-copy-btn')).opacity : null,
    });
  }, 0)));
}

async function assertHidden(page, reason) {
  const state = await messageState(page);
  assert.equal(state.awaiting, true, `${reason}: empty assistant must keep the awaiting-content marker`);
  assert.equal(state.display, 'none', `${reason}: production CSS must hide the shell`);
  assert.equal(state.height, 0, `${reason}: hidden shell must occupy no chat space`);
}

async function assertShown(page, reason) {
  const state = await messageState(page);
  assert.equal(state.awaiting, false, `${reason}: useful content must reveal the assistant`);
  assert.notEqual(state.display, 'none', `${reason}: useful content must be visible`);
  assert.ok(state.height > 0, `${reason}: useful content must occupy chat space`);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: assistant shells track visible output instead of copy controls`, async (t) => {
    const source = read(build, 'src/ui/sidepanel.js');
    const helperStart = source.indexOf('const ASSISTANT_RENDERABLE_ELEMENT_SELECTOR =');
    const helperEnd = source.indexOf('const persistObserver =', helperStart);
    const observerEnd = source.indexOf('\n});', helperEnd) + '\n});'.length;
    const observeCall = source.match(/persistObserver\.observe\(messagesEl, \{[^\n]+\}\);/)?.[0];
    assert.ok(helperStart >= 0 && helperEnd > helperStart && observerEnd > helperEnd);
    assert.ok(observeCall, 'Missing production message observer registration');
    const functions = [
      'addMessage', 'addMessageCopyButton', 'getStreamedAssistantText',
      'hasStreamedAssistantText', 'clearStreamedAssistantText', 'renderAssistantTextUpdate',
      'isStoppedByUserStatus', 'clearTransientAssistantTextForToolCall',
      'syncProgressDisplayMode', 'setCompactProgressVisible', 'getOrCreateStepsContainer',
    ].map(name => extract(source, name)).join('\n');
    const browser = await engine.launch({ headless: true });
    try {
      async function withPage(run) {
        const page = await browser.newPage({ viewport: { width: 420, height: 500 } });
        try {
          await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style><main id="messages"></main>`);
          await page.addScriptTag({ content: `
            var messagesEl = document.getElementById('messages');
            var currentAssistantEl = null, verboseMode = false, compactProgressVisible = true;
            var activityProgressToggle = null, agentActivity = null;
            var streamedAssistantTextByEl = new WeakMap();
            var streamedAssistantRenderFrameByEl = new WeakMap();
            function schedulePersist() {}
            function scrollToBottom() {}
            function setMessageCreatedAt() {}
            function bindMessageInfoToggle() {}
            function bindMessageCopyButton() {}
            function renderCostAllowanceError() { return false; }
            function renderSubscribeError() { return false; }
            function parseCostAllowanceError() { return null; }
            function t(value) { return value; }
            // Markdown parsing has its own suite. Preserve the relevant DOM
            // shape here: whitespace-only output can include empty <br> nodes.
            function formatMarkdown(value) {
              return String(value || '').replace(/&/g, '&amp;')
                .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\n/g, '<br>');
            }
            ${source.slice(helperStart, observerEnd)}
            ${functions}
            ${observeCall}
            syncProgressDisplayMode();
          ` });
          await run(page);
        } finally { await page.close(); }
      }

      await t.test('new empty and whitespace messages never paint a shell before insertion', () => withPage(async page => {
        const insertionStates = await page.evaluate(() => {
          const nativeAppend = messagesEl.appendChild.bind(messagesEl);
          const states = [];
          messagesEl.appendChild = node => {
            states.push(node.classList.contains('assistant-awaiting-content'));
            return nativeAppend(node);
          };
          currentAssistantEl = addMessage('assistant', '');
          currentAssistantEl = addMessage('assistant', ' \n\t ');
          return states;
        });
        assert.deepEqual(insertionStates, [true, true], 'Hide empty nodes before they enter the live DOM');
        await assertHidden(page, 'Whitespace-only initial output');
      }));

      await t.test('empty and whitespace replacements hide a previously populated message with a copy button', () => withPage(async page => {
        for (const replacement of ['', ' \n\t ']) {
          await page.evaluate(() => {
            currentAssistantEl = addMessage('assistant', '');
            renderAssistantTextUpdate(currentAssistantEl, 'Revising the selected reply.');
          });
          await assertShown(page, 'Rendered assistant text');
          await page.evaluate(replacement => renderAssistantTextUpdate(currentAssistantEl, replacement, { replace: true }), replacement);
          const state = await messageState(page);
          assert.equal(state.copyCount, 1, 'Exercise the real stale-copy-button path');
          assert.equal(state.copyOpacity, '0', 'Production CSS makes the stale copy button invisible');
          if (!state.awaiting) {
            fs.mkdirSync('/tmp/webbrain-empty-bubble', { recursive: true });
            await page.screenshot({ path: `/tmp/webbrain-empty-bubble/${build}-empty-replacement-before.png`, animations: 'disabled' });
          }
          await assertHidden(page, 'Authoritative empty replacement');
          await page.evaluate(() => currentAssistantEl.remove());
        }
      }));

      await t.test('tool-call cleanup hides transient text even while hidden progress and stale copy controls remain', () => withPage(async page => {
        await page.evaluate(() => {
          currentAssistantEl = addMessage('assistant', '');
          renderAssistantTextUpdate(currentAssistantEl, 'Inspecting the reply.');
          const steps = getOrCreateStepsContainer();
          steps.innerHTML = '<div class="step-item"><span class="step-label">Read reply</span></div>';
          setCompactProgressVisible(false);
        });
        await assertShown(page, 'Text is visible with status-only progress');
        await page.evaluate(() => clearTransientAssistantTextForToolCall());
        assert.equal(await page.locator('.steps-container').evaluate(node => getComputedStyle(node).display), 'none');
        assert.equal((await messageState(page)).copyCount, 1);
        await assertHidden(page, 'Tool-call transient prose cleanup');
      }));

      await t.test('restored legacy copy-only markup is normalized and new restored markup is observed', () => withPage(async page => {
        const legacyMarkup = '<div class="message assistant"><div class="message-content"><div class="message-text"> <br> </div><button class="msg-copy-btn">Copy</button><button class="code-copy-btn">Copy code</button></div></div>';
        await page.evaluate(markup => {
          messagesEl.innerHTML = markup;
          currentAssistantEl = messagesEl.firstElementChild;
          syncAssistantMessageVisibility();
        }, legacyMarkup);
        await assertHidden(page, 'Explicit restored-chat normalization');
        await page.evaluate(markup => {
          messagesEl.innerHTML = markup;
          currentAssistantEl = messagesEl.firstElementChild;
        }, legacyMarkup);
        await assertHidden(page, 'Observer normalizes inserted restored markup');
      }));

      await t.test('compact and verbose progress reveal shells only when their production CSS displays the log', () => withPage(async page => {
        await page.evaluate(() => {
          currentAssistantEl = addMessage('assistant', '');
          getOrCreateStepsContainer().innerHTML = '<div class="step-item"><span class="step-label">Read reply</span></div>';
        });
        await assertShown(page, 'Compact steps visible');
        await page.evaluate(() => setCompactProgressVisible(false));
        await assertHidden(page, 'Compact steps hidden');
        await page.evaluate(() => { verboseMode = true; syncProgressDisplayMode(); });
        await assertShown(page, 'Verbose steps visible');
        await page.evaluate(() => {
          currentAssistantEl.querySelector('.steps-container').remove();
          const tool = document.createElement('div');
          tool.className = 'tool-call';
          tool.textContent = 'Read reply';
          currentAssistantEl.querySelector('.message-content').appendChild(tool);
        });
        await assertShown(page, 'Verbose tool call visible');
        await page.evaluate(() => { verboseMode = false; syncProgressDisplayMode(); });
        assert.equal(await page.locator('.tool-call').evaluate(node => getComputedStyle(node).display), 'none');
        await assertHidden(page, 'Verbose tool call hidden in compact mode');
      }));

      await t.test('text, action cards, and media reveal a shell and removing their useful content hides it again', () => withPage(async page => {
        await page.evaluate(() => { currentAssistantEl = addMessage('assistant', ''); });
        for (const content of [
          '<p>Updated reply</p>',
          '<div class="clarify-card"><button type="button">Continue</button></div>',
          '<div class="generated-media"><img alt="Generated image" width="80" height="50" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2250%22/%3E"></div>',
          '<div class="generated-media"><video controls width="120" height="60"></video></div>',
          '<div class="generated-media"><audio controls></audio></div>',
        ]) {
          await page.evaluate(content => {
            currentAssistantEl.querySelector('.message-text').innerHTML = content;
            addMessageCopyButton(currentAssistantEl);
          }, content);
          await assertShown(page, `Useful content: ${content.slice(0, 50)}`);
          await page.evaluate(() => currentAssistantEl.querySelector('.message-text').replaceChildren());
          await assertHidden(page, 'Useful content removed, copy control retained');
        }
      }));
    } finally { await browser.close(); }
  });
}
