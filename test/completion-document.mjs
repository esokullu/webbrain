import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

for (const [build, browserType] of [['chrome', chromium], ['firefox', firefox]]) {
  const { COMPLETION_DOCUMENT_STAMP_SCRIPT, COMPLETION_DOCUMENT_IDENTITY_SCRIPT } = await import(`../src/${build}/src/agent/completion-document.js`);
  const treeSource = await readFile(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8');
  const { verifyBrowserCompletion } = await import(`../src/${build}/src/agent/completion-runtime.js`);
  const { probeDecisionVision } = await import(`../src/${build}/src/agent/decision-vision-probe.js`);
  test(`${build}: completion stamp detects accessibility-only changes and rejects reverted checkbox success`, async () => {
    const browser = await browserType.launch();
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    try {
      const page = await browser.newPage();
      await page.addScriptTag({ content: treeSource });
      await page.setContent('<input id="check" type="checkbox" checked><input id="text" value="unchanged"><button id="button">Save</button><div id="state" role="status">Published</div>');
      const stamp = (_tab, documentOnly = false) => page.evaluate(documentOnly ? COMPLETION_DOCUMENT_IDENTITY_SCRIPT : COMPLETION_DOCUMENT_STAMP_SCRIPT);
      const initial = await stamp();
      for (const [selector, property] of [['#check', 'checked'], ['#check', 'indeterminate'], ['#text', 'disabled'], ['#text', 'readOnly']]) {
        await page.locator(selector).evaluate((element, property) => { element[property] = !element[property]; }, property);
        assert.notEqual(await stamp(), initial, property);
        await page.locator(selector).evaluate((element, property) => { element[property] = !element[property]; }, property);
        assert.equal(await stamp(), initial);
      }
      for (const attribute of ['aria-checked', 'aria-expanded', 'aria-busy', 'aria-disabled', 'aria-hidden', 'aria-selected', 'aria-pressed', 'aria-label', 'aria-valuenow']) {
        await page.locator('#state').evaluate((element, name) => element.setAttribute(name, 'true'), attribute);
        assert.notEqual(await stamp(), initial, attribute);
        await page.locator('#state').evaluate((element, name) => element.removeAttribute(name), attribute);
        assert.equal(await stamp(), initial);
      }
      globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
      const provider = { model: 'active', supportsVision: false, config: { category: 'local' } };
      const agent = {
        _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
        _latestTaskText: () => 'Check this checkbox', _originalTaskText: () => '', _progressTaskKeyHash: () => 'check',
        _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]),
        _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(), _completionDocumentStamp: stamp,
        executeTool: async () => ({ success: true, ...await page.evaluate(() => window.__generateAccessibilityTree('all', 15, 5500)) }), recordSystemOneVerdict() {},
        evaluateSystemOne: async () => {
          await page.locator('#check').evaluate(element => { element.checked = false; });
          return { model: 'kev-latest', answers: { task_outcome: { choice: 'succeeded', probabilities: { succeeded: .99 } } } };
        },
      };
      const verdict = await verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.outcome, 'pending');
      assert.equal(verdict.engine, 'freshness');
      assert.equal(await page.locator('#check').inputValue(), 'on', 'the value did not change with checked state');
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      await browser.close();
    }
  });
  test(`${build}: astral text and ARIA changes invalidate in-flight AX success`, async () => {
    const browser = await browserType.launch();
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    try {
      const page = await browser.newPage();
      await page.addScriptTag({ content: treeSource });
      const stamp = (_tab, documentOnly = false) => page.evaluate(documentOnly ? COMPLETION_DOCUMENT_IDENTITY_SCRIPT : COMPLETION_DOCUMENT_STAMP_SCRIPT);
      globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
      for (const attribute of [null, 'aria-label']) {
        await page.setContent('<h1 id="state">Published</h1>');
        const replace = value => page.locator('#state').evaluate((element, { attribute, value }) => {
          if (attribute) element.setAttribute(attribute, value); else element.textContent = value;
        }, { attribute, value });
        await replace('😀');
        const initial = await stamp();
        await replace('😁');
        assert.notEqual(await stamp(), initial, 'same-length emojis with a shared leading surrogate must change the stamp');
        await replace('😀');
        assert.equal(await stamp(), initial);
        const provider = { model: 'active', supportsVision: false, config: { category: 'local' } };
        const agent = {
          _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
          _latestTaskText: () => 'Verify the requested emoji', _originalTaskText: () => '', _progressTaskKeyHash: () => 'emoji',
          _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]),
          _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(), _completionDocumentStamp: stamp,
          executeTool: async () => ({ success: true, ...await page.evaluate(() => window.__generateAccessibilityTree('all', 15, 5500)) }), recordSystemOneVerdict() {},
          evaluateSystemOne: async () => {
            await replace('😁');
            return { model: 'kev-latest', answers: { task_outcome: { choice: 'succeeded', probabilities: { succeeded: .99 } } } };
          },
        };
        const verdict = await verifyBrowserCompletion(agent, 1);
        assert.equal(verdict.outcome, 'pending');
        assert.equal(verdict.engine, 'freshness');
        assert.equal(agent._completionVerdicts.get(1)?.outcome === 'succeeded', false);
      }
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      await browser.close();
    }
  });
  test(`${build}: AX freshness ignores live text outside the judge observation but rejects changed observed results`, async () => {
    const browser = await browserType.launch();
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    try {
      const page = await browser.newPage();
      await page.addScriptTag({ content: treeSource });
      await page.setContent('<h1 id="result">Requested post published</h1>' + Array.from({ length: 120 }, (_, i) => `<p>Archive item ${i}: ${'stable details '.repeat(5)}</p>`).join('') + '<div id="clock" role="timer">CLOCK_INITIAL</div>');
      const fullStamp = await page.evaluate(COMPLETION_DOCUMENT_STAMP_SCRIPT);
      globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
      let changeResult = false, requests = 0, reads = 0;
      const provider = { model: 'active', supportsVision: false, config: { category: 'local' } };
      const agent = {
        _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
        _latestTaskText: () => 'Verify the requested post was published', _originalTaskText: () => '', _progressTaskKeyHash: () => 'post',
        _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]),
        _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(),
        _completionDocumentStamp: (_tab, documentOnly) => page.evaluate(documentOnly ? COMPLETION_DOCUMENT_IDENTITY_SCRIPT : COMPLETION_DOCUMENT_STAMP_SCRIPT),
        executeTool: async () => { reads++; return { success: true, ...await page.evaluate(() => window.__generateAccessibilityTree('all', 15, 5500)) }; }, recordSystemOneVerdict() {},
        evaluateSystemOne: async (_tab, _client, args) => {
          requests++;
          assert.doesNotMatch(args.state[1].observation, /CLOCK_/);
          await page.locator('#clock').evaluate((element, value) => { element.textContent = value; }, `CLOCK_UPDATED_${requests}`);
          if (changeResult) await page.locator('#result').evaluate(element => { element.textContent = 'Requested post is an unsubmitted draft'; });
          return { model: 'kev-latest', answers: { task_outcome: { choice: 'succeeded', probabilities: { succeeded: .99 } } } };
        },
      };
      assert.equal((await verifyBrowserCompletion(agent, 1)).outcome, 'succeeded');
      assert.notEqual(await page.evaluate(COMPLETION_DOCUMENT_STAMP_SCRIPT), fullStamp, 'the old full-body fingerprint would reject the clock update');
      assert.equal(requests, 1); assert.equal(reads, 2);
      agent._completionVerdicts.clear(); changeResult = true;
      const changed = await verifyBrowserCompletion(agent, 1);
      assert.equal(changed.outcome, 'pending'); assert.equal(changed.engine, 'freshness');
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      await browser.close();
    }
  });
  test(`${build}: vision capability probe uses two distinct pixel facts and rejects constant answers`, async () => {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(async source => {
        const probe = (0, eval)(`(${source})`);
        const colors = [];
        const consume = async request => {
          const image = new Image(); image.src = request.state[0].image_url.url;
          await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          const [r, g, b] = context.getImageData(32, 32, 1, 1).data;
          const choice = r && g ? 'yellow' : r ? 'red' : g ? 'green' : b ? 'blue' : 'unknown';
          colors.push(choice);
          return { answers: { image_color: { choice, probabilities: { [choice]: .99 } } } };
        };
        const accepted = await probe({}, consume, { random: () => .999 });
        const constantRejected = !await probe({}, async () => ({ answers: { image_color: { choice: 'red', probabilities: { red: .99 } } } }), { random: () => 0 });
        return { accepted, colors, constantRejected };
      }, probeDecisionVision.toString());
      assert.equal(result.accepted, true);
      assert.equal(new Set(result.colors).size, 2);
      assert.equal(result.constantRejected, true);
    } finally { await browser.close(); }
  });
}
