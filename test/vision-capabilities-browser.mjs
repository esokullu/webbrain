import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chromium, firefox } from 'playwright';

// Real DOM selection and browser navigation; only the extension API boundary
// is bridged to Playwright. No AX or page-text discovery adapter is available.
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: native page history, explicit selection and empty selection remain visual-only`, { timeout: 30000 }, async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<p id="chosen">Explicitly selected phrase</p><p>UNSELECTED PRIVATE PAGE CONTENT</p><a href="/second">Next</a>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await engine.launch({ headless: true,
      args: engine === chromium && process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [] });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.goto(`${origin}/first`);
      let injections = 0, historyActions = 0;
      const api = {
        runtime: { getURL: path => `chrome-extension://fixture/${path}` },
        storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
        tabs: {
          get: async id => ({ id, url: page.url(), windowId: 1 }),
          goBack: async () => { historyActions++; await page.goBack(); },
          goForward: async () => { historyActions++; await page.goForward(); },
        },
        scripting: { executeScript: async ({ func }) => {
          injections++;
          assert.doesNotMatch(func.toString(), /querySelector|innerText|textContent|accessibility/);
          return [{ frameId: 0, result: await page.evaluate(func) }];
        } },
      };
      globalThis.chrome = api; globalThis.browser = api;
      const { executeVisionCapability } = await import(`../src/${build}/src/agent/vision-capabilities.js`);
      const agent = { _ensureGateSetting: async () => {}, _skipPermissionGate: true };
      const run = (name, args = {}) => executeVisionCapability(agent, { tabId: 77, name, args });
      const empty = await run('get_selection'); assert.equal(empty.result.text, '');
      await page.locator('#chosen').selectText();
      const selected = await run('get_selection');
      assert.equal(selected.result.text, 'Explicitly selected phrase');
      assert.doesNotMatch(JSON.stringify(selected), /PRIVATE PAGE/);
      await page.goto(`${origin}/second`);
      const back = await run('go_back'); assert.equal(page.url(), `${origin}/first`);
      assert.equal(back.effects.resetFrames, true); assert.equal(back.effects.observe, true);
      const forward = await run('go_forward'); assert.equal(page.url(), `${origin}/second`);
      assert.equal(forward.effects.resetFrames, true); assert.equal(historyActions, 2);
      assert.equal(injections, 2, 'Native history never executes a page script or observation');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
  });
}
