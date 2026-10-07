import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { DECISION_SETTINGS_KEYS } = await import(`../src/${build}/src/agent/decision-config.js`);
  test(`${build}: main execution clears the planner activity and preserves tool activity`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const source = read(build, 'src/ui/sidepanel.js');
      const activityStart = source.indexOf('const THINKING_ACTIVITY_KEYS = [');
      const activityEnd = source.indexOf('// A new turn is reading-first', activityStart);
      const thinkingStart = source.indexOf("    case 'thinking':");
      const thinkingEnd = source.indexOf("    case 'text':", thinkingStart);
      await page.setContent('<div id="activity"><span id="text"></span><span id="live"></span></div>');
      await page.addScriptTag({ content: `
        const agentActivity = document.querySelector('#activity');
        const activityText = document.querySelector('#text');
        const activityLiveStatus = document.querySelector('#live');
        const t = value => value;
        const compactProgressVisible = true;
        function hideInspectionBanner() {}
        ${source.slice(activityStart, activityEnd)}
        function update(type, data) { switch(type) { ${source.slice(thinkingStart, thinkingEnd)} } }
      ` });
      for (const step of [1, 8]) {
        await page.evaluate(step => {
          update('thinking', { step: 0, note: 'Planning…' });
          if (activityText.textContent !== 'Planning…') throw new Error('Planner status missing');
          update('thinking', { step });
        }, step);
        assert.equal(await page.locator('#text').textContent(), 'sp.activity.communicating');
        assert.equal(await page.locator('#live').textContent(), 'sp.activity.communicating');
        await page.evaluate(() => { showActivity('Opening composer'); update('thinking', { step: 9 }); });
        assert.equal(await page.locator('#text').textContent(), 'Opening composer');
      }
      await page.evaluate(() => hideActivity());
      assert.equal(await page.locator('#live').textContent(), '');
    } finally { await browser.close(); }
  });
  test(`${build}: native composer honors delivery settings, explicitly steers, and preserves drafts across races`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 380, height: 700 } });
      const html = read(build, 'src/ui/sidepanel.html');
      const source = read(build, 'src/ui/sidepanel.js');
      const settings = read(build, 'src/ui/settings.js');
      const settingsHtml = read(build, 'src/ui/settings.html');
      const preferenceStart = source.indexOf("let composerDeliveryMode = 'queue';");
      const preferenceEnd = source.indexOf('\nfunction enqueueTabChatOperation(', preferenceStart);
      const settingListenerStart = settings.indexOf("composerDeliveryModeSelect?.addEventListener('change'");
      const settingListenerEnd = settings.indexOf('\n});', settingListenerStart) + 4;
      const settingHydrationStart = settings.indexOf('  if (composerDeliveryModeSelect) {');
      const settingHydrationEnd = settings.indexOf('\n  }', settingHydrationStart) + 4;
      const settingsRead = settings.match(/  const stored = await (?:chrome|browser)\.storage\.local\.get\(\[[^\n]+/)[0];
      const settingSelectHtml = settingsHtml.match(/<select id="select-composer-delivery-mode"[\s\S]*?<\/select>/)[0];
      assert.ok(preferenceStart >= 0 && preferenceEnd > preferenceStart);
      assert.ok(settingListenerStart >= 0 && settingListenerEnd > settingListenerStart);
      const start = html.indexOf('<div id="queued-messages"');
      const end = html.indexOf('      </div>\n    </div>', start);
      assert.ok(start >= 0 && end > start);
      await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style><div id="messages"></div>${html.slice(start, end + 12)}${settingSelectHtml}`);
      const functions = [
        'sameTabId', 'getQueuedComposerMessages', 'setQueuedComposerMessages',
        'queueUnconsumedSteeringMessages', 'steerComposerMessage', 'syncComposerDeliveryState',
        'queuedComposerButton', 'renderQueuedComposerMessages', 'removeQueuedComposerMessage',
        'enqueueQueuedComposerMessage', 'syncSendButtonState', 'sendMessage',
      ].map(name => extract(source, name)).join('\n');
      const listenersStart = source.indexOf("sendBtn.addEventListener('click', sendMessage);");
      const listenersEnd = source.indexOf("inputEl.addEventListener('input', handleInput);", listenersStart);
      await page.addScriptTag({ content: `
        var inputEl = document.getElementById('user-input');
        var sendBtn = document.getElementById('btn-send');
        var queuedMessagesEl = document.getElementById('queued-messages');
        var messagesEl = document.getElementById('messages');
        var currentTabId = 1, renderedTabId = 1, isProcessing = true;
        var isStandaloneWindow = false, tabSwitchTransitionId = null;
        var visibleStateRefreshPending = false, visibleStateRefreshInProgress = false;
        var clearing = false, reviewing = false, aborting = false;
        var queuedComposerMessagesByTab = new Map(), steeringRequestsByTab = new Map();
        var queuedSteeringMessageIds = new Set(), tabInputDrafts = new Map();
        var clearedConversationRunRequestIds = new Set(), queuedComposerMessageSeq = 0;
        var sent = [], notices = [], requestSeq = 0, heldResponse = null;
        var responseMode = 'accept';
        var storageData = { composerDeliveryMode: 'steer' }, storageListeners = [];
        var chrome = { storage: {
          local: {
            async get(keys) {
              return Object.fromEntries(Object.entries(storageData).filter(([key]) => [].concat(keys).includes(key)));
            },
            async set(values) {
              Object.assign(storageData, values);
              storageListeners.forEach(listener => listener(Object.fromEntries(
                Object.entries(values).map(([key, newValue]) => [key, { newValue }])
              ), 'local'));
            },
          },
          onChanged: { addListener(listener) { storageListeners.push(listener); } },
        } };
        var browser = chrome;
        var AUTO_GROUP_TABS_KEY = 'autoGroupTabs';
        var DECISION_SETTINGS_KEYS = ${JSON.stringify(DECISION_SETTINGS_KEYS)};
        var DOWNLOAD_DIRECTORY_STORAGE_KEY = 'downloadDirectory';
        var CLOUD_BRIDGE_ENABLED_KEY = 'cloudBridgeEnabled', CLOUD_BRIDGE_URL_KEY = 'cloudBridgeUrl';
        var composerDeliveryModeSelect = document.getElementById('select-composer-delivery-mode');
        async function hydrateDeliverySetting() {
          ${settingsRead}
          ${settings.slice(settingHydrationStart, settingHydrationEnd)}
        }
        function t(key) { return ({ 'sp.steer.button': 'Yönlendir', 'sp.queue.label': 'Kuyrukta' })[key] || key; }
        function isTabProcessing(tabId) { return tabId === 1; }
        function isTabAbortRequested() { return aborting; }
        function isConversationClearInProgress() { return clearing; }
        function isAwaitingPlanReviewForTab() { return reviewing; }
        function isAttachmentReadPendingForTab() { return false; }
        function createRunRequestId() { return 'id-' + (++requestSeq); }
        function localRunRequestIdForTab() { return 'run-1'; }
        function saveInputDraftForTab(tabId, text) { tabInputDrafts.set(Number(tabId), text); }
        function resetComposerHistoryNavigation() {}
        function hideSlashCommandAutocomplete() {}
        function autoResizeInput() {}
        function drainQueuedPromptsAfterRunSettles() {}
        function showComposerToast(text) { notices.push(text); }
        function normalizeScreenshotCommandText(value) { return value; }
        function normalizeSelectionSourceGrounding() { return null; }
        function normalizeSelectionAction() { return ''; }
        function waitForVisibleSidePanelStateRefresh() { return Promise.resolve(); }
        function dismissSelectionAskAction() {}
        function stopListening() {}
        function permissionSkipCommandContextForDraft() { return null; }
        function isOutOfBandSlashDraft() { return false; }
        function showBusySlashCommandNotice() { notices.push('busy slash'); }
        function handleGlobalKeydown() {}
        function handleSlashCommandKeydown() { return false; }
        function editLastQueuedComposerMessageForCurrentTab() { return false; }
        function navigateComposerHistory() { return false; }
        function editQueuedComposerMessage() {}
        function deleteQueuedComposerMessage(tabId, id) { removeQueuedComposerMessage(tabId, id); }
        function sendToBackground(action, data) {
          sent.push({ action, ...data });
          if (responseMode === 'hold') return new Promise(resolve => { heldResponse = resolve; });
          if (responseMode === 'fail') return Promise.reject(new Error('transport failed'));
          return Promise.resolve({ accepted: responseMode !== 'inactive' });
        }
        ${functions}
        ${source.slice(listenersStart, listenersEnd)}
        ${source.slice(preferenceStart, preferenceEnd)}
        ${settings.slice(settingListenerStart, settingListenerEnd)}
        hydrateDeliverySetting();
        inputEl.addEventListener('input', syncSendButtonState);
        syncSendButtonState();
      ` });

      const input = page.locator('#user-input');
      const deliverySetting = page.locator('#select-composer-delivery-mode');
      await page.waitForFunction(() => composerDeliveryMode === 'steer'
        && composerDeliveryModeSelect.value === 'steer');
      assert.equal(await page.locator('#btn-send').getAttribute('title'), 'sp.steer.title · sp.queue.send (Alt+Shift+Enter)',
        'Saved preference hydrates both settings and composer');
      assert.equal(await page.locator('#btn-steer').count(), 0, 'No separate composer Steer button');
      await input.fill('Queue through the explicit shortcut');
      await input.press('Alt+Shift+Enter');
      await page.waitForFunction(() => getQueuedComposerMessages(1).length === 1);
      assert.equal(await page.evaluate(() => sent.length), 0, 'Alt+Shift+Enter queues even when Steer is the default');
      assert.equal(await page.evaluate(() => composerDeliveryMode), 'steer', 'The shortcut does not change the saved default');
      await page.evaluate(() => { queuedComposerMessagesByTab.clear(); renderQueuedComposerMessages(); });
      await deliverySetting.selectOption('queue');
      await page.waitForFunction(() => composerDeliveryMode === 'queue');
      assert.equal(await page.evaluate(() => storageData.composerDeliveryMode), 'queue');
      assert.equal(await page.locator('#btn-send').getAttribute('aria-label'), 'sp.queue.send');
      await input.fill('After this, check the tests');
      await input.press('Enter');
      await page.waitForFunction(() => getQueuedComposerMessages(1).length === 1);
      assert.equal(await page.evaluate(() => sent.length), 0, 'Enter queues locally');
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.locator('.queued-message-steer').count(), 1);
      assert.equal(await page.locator('.queued-message-action').evaluateAll(buttons =>
        new Set(buttons.map(button => button.getBoundingClientRect().top)).size), 1,
        'Steer, edit, and delete remain on one row in a narrow panel');

      await input.fill('Use blue instead');
      await deliverySetting.selectOption('steer');
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => sent.length === 1 && !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), '');
      assert.deepEqual(await page.evaluate(() => [sent[0].action, sent[0].text, sent[0].requestId, sent[0].tabId]),
        ['chat_steer', 'Use blue instead', 'run-1', 1]);
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 1, 'Steering preserves queued follow-ups');
      assert.equal(await page.evaluate(() => storageData.composerDeliveryMode), 'steer');

      await page.locator('.queued-message-steer').click();
      await page.waitForFunction(() => sent.length === 2 && !steeringRequestsByTab.size);
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 0);

      await input.fill('Keep the logo');
      await input.press('Enter');
      await page.waitForFunction(() => sent.length === 3 && !steeringRequestsByTab.size);
      assert.equal(await page.evaluate(() => sent.at(-1).text), 'Keep the logo');
      await deliverySetting.selectOption('queue');

      await page.evaluate(() => inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, isComposing: true })));
      assert.equal(await page.evaluate(() => sent.length), 3, 'IME confirmation does not send');

      await input.fill('/act');
      assert.equal(await page.locator('#btn-send').isDisabled(), true);
      await input.press('Alt+Enter');
      assert.equal(await page.evaluate(() => sent.length), 3, 'Busy slash commands never become steering');

      await page.evaluate(() => { responseMode = 'hold'; });
      await input.fill('First correction');
      await input.press('Alt+Enter');
      await page.waitForFunction(() => heldResponse !== null);
      await input.fill('New draft while waiting');
      await input.press('Enter');
      assert.equal(await page.evaluate(() => sent.length), 4, 'Acknowledgement wait prevents duplicate sends');
      await page.evaluate(() => { heldResponse({ accepted: true }); heldResponse = null; });
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), 'New draft while waiting');

      await page.evaluate(() => { responseMode = 'inactive'; });
      await input.fill('Missed the current turn');
      await input.press('Alt+Enter');
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1)[0].text), 'Missed the current turn');

      await page.evaluate(() => { responseMode = 'hold'; });
      await page.locator('.queued-message-steer').click();
      await page.waitForFunction(() => heldResponse !== null);
      await page.evaluate(() => {
        queueUnconsumedSteeringMessages(1, [{ id: sent.at(-1).messageId, text: sent.at(-1).text }]);
        heldResponse({ accepted: true }); heldResponse = null;
      });
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 1,
        'An unconsumed correction arriving before its acknowledgement survives promotion');

      await page.evaluate(() => { responseMode = 'fail'; });
      await input.fill('Retain on failure');
      await input.press('Alt+Enter');
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), 'Retain on failure');

      await page.evaluate(() => { responseMode = 'hold'; });
      await input.fill('Correction for tab one');
      await input.press('Alt+Enter');
      await page.waitForFunction(() => heldResponse !== null);
      await page.evaluate(() => {
        tabInputDrafts.set(1, inputEl.value);
        currentTabId = renderedTabId = 2;
        inputEl.value = 'Tab two draft';
        heldResponse({ accepted: true }); heldResponse = null;
      });
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await input.inputValue(), 'Tab two draft');
      assert.equal(await page.evaluate(() => tabInputDrafts.get(1)), '', 'Only the submitted tab draft is cleared');
      await page.evaluate(() => { currentTabId = renderedTabId = 1; syncSendButtonState(); });

      await page.evaluate(() => { responseMode = 'hold'; });
      await input.fill('Clear while awaiting acknowledgement');
      await input.press('Alt+Enter');
      await page.waitForFunction(() => heldResponse !== null);
      await page.evaluate(() => {
        queuedComposerMessagesByTab.clear();
        clearedConversationRunRequestIds.add('run-1');
        heldResponse({ accepted: false }); heldResponse = null;
      });
      await page.waitForFunction(() => !steeringRequestsByTab.size);
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 0, 'Cleared chats are not resurrected');

      await page.evaluate(() => {
        currentTabId = renderedTabId = 2;
        queueUnconsumedSteeringMessages(1, [{ id: 'fallback-1', text: 'Late correction' }]);
        queueUnconsumedSteeringMessages(1, [{ id: 'fallback-1', text: 'Late correction' }]);
      });
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(1).length), 1, 'Journal replay is deduplicated');
      assert.equal(await page.evaluate(() => getQueuedComposerMessages(2).length), 0);
      await deliverySetting.selectOption('steer');
      await page.evaluate(() => {
        delete storageData.composerDeliveryMode;
        storageListeners.forEach(listener => listener({ composerDeliveryMode: {} }, 'local'));
      });
      assert.equal(await page.evaluate(() => composerDeliveryMode), 'queue', 'Removing preference restores Queue');
      await page.evaluate(() => hydrateDeliverySetting());
      assert.equal(await deliverySetting.inputValue(), 'queue', 'Missing setting hydrates to Queue');
      await page.evaluate(() => { isProcessing = false; syncSendButtonState(); });
      assert.equal(await page.locator('#btn-steer').count(), 0);
      assert.equal(await page.locator('#btn-send').getAttribute('title'), 'sp.btn.send');
    } finally {
      await browser.close();
    }
  });
}
