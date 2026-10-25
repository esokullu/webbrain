import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { chromium, firefox } from 'playwright';
import * as chromeDev from '../src/chrome/src/agent/vision-dev-capabilities.js';
import * as firefoxDev from '../src/firefox/src/agent/vision-dev-capabilities.js';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { sameVisionViewport } from '../src/chrome/src/agent/vision-browser.js';
import { visionPointToCss } from '../src/chrome/src/agent/vision-frames.js';

test('Dev schemas preserve explicit source/style/edit abilities without selectors, HTML or arbitrary scripts', () => {
  assert.deepEqual(chromeDev.VISION_DEV_CAPABILITY_TOOLS, firefoxDev.VISION_DEV_CAPABILITY_TOOLS);
  assert.deepEqual(chromeDev.VISION_DEV_CAPABILITY_TOOLS.map(t => t.function.name),
    ['read_page_source', 'inspect_element_styles', 'inspect_event_listeners', 'patch_element', 'inject_css', 'revert_patch', 'remove_injected_css']);
  for (const { function: tool } of chromeDev.VISION_DEV_CAPABILITY_TOOLS) {
    assert.equal(tool.parameters.additionalProperties, false);
    for (const key of ['selector', 'ref_id', 'code', 'html']) assert.equal(Object.hasOwn(tool.parameters.properties, key), false);
  }
});

test('explicit Dev task and closed schemas are checked before page or legacy tool access', async () => {
  const forbidden = new Proxy({}, { get() { throw new Error('No backend should run'); } });
  for (const api of [chromeDev, firefoxDev]) {
    for (const values of [{ mode: 'act', devAuthorized: true }, { mode: 'dev', devAuthorized: false },
      { mode: 'dev', devAuthorized: true, args: { frameId: '1', x: 5, y: 5, selector: '#private' } }]) {
      const { result } = await api.runVisionDevCapability(forbidden, { name: 'inspect_element_styles', args: { frameId: '1', x: 5, y: 5 },
        browser: forbidden, frames: forbidden, ...values });
      assert.equal(result.success, false); assert.equal(result.noDispatch, true);
    }
    for (const args of [{ styles: { background: 'url(https://leak.test/)' } }, { styles: { background: 'image-set("https://leak.test/")' } },
      { attributes: { onclick: 'alert(1)' } }]) {
      assert.equal((await api.runVisionDevCapability(forbidden, { name: 'patch_element', args: { frameId: '1', x: 5, y: 5, ...args },
        mode: 'dev', devAuthorized: true, frames: forbidden, browser: forbidden })).result.noDispatch, true);
    }
  }
});

test('Firefox listener inspection is explicitly unavailable without any scripting or source fallback', async () => {
  const forbidden = new Proxy({}, { get() { throw new Error('No fallback may run'); } });
  const { result } = await firefoxDev.runVisionDevCapability({}, { mode: 'dev', devAuthorized: true,
    name: 'inspect_event_listeners', args: { frameId: '1', x: 5, y: 5 }, frames: forbidden, browser: forbidden });
  assert.equal(result.available, false); assert.match(result.error, /unavailable in Firefox/);
});

test('explicit source inspection uses bounded server bytes directly, without legacy execution or DOM extraction', async () => {
  const previous = { chrome: globalThis.chrome, browser: globalThis.browser, fetch: globalThis.fetch };
  let fetched = 0, authorized, checkpoint = 0;
  globalThis.chrome = { tabs: { get: async () => ({ url: 'https://source.test/app' }) } }; delete globalThis.browser;
  globalThis.fetch = async () => { fetched++; return new Response('<html><body>' + 'source-token '.repeat(2000) + '</body></html>', { headers: { 'content-type': 'text/html' } }); };
  try {
    const { result } = await chromeDev.runVisionDevCapability({ executeTool: () => { throw new Error('Legacy forbidden'); } }, {
      mode: 'dev', devAuthorized: true, name: 'read_page_source', args: { maxChars: 1000, offset: 1000 }, tabId: 1,
      browser: { readViewport: async () => ({ url: 'https://source.test/app' }) },
      authorize: async (_name, args) => { authorized = args; return true; }, beforeDispatch: async () => { checkpoint++; },
    });
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(fetched, 1); assert.equal(checkpoint, 1);
    assert.equal(authorized.url, 'https://source.test/app'); assert.ok(result.text.length <= 1000);
    assert.equal(result.offset, 1000); assert.equal(result.truncated, true); assert.ok(result.nextOffset > 1000);
  } finally { Object.assign(globalThis, previous); }
});

test('native listener lookup keeps hostile metadata in typed arguments and releases handles on every path', async () => {
  const previous = { chrome: globalThis.chrome, browser: globalThis.browser };
  const backend = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
  const hostileUrl = 'https://source.test/#";globalThis.injected=true;//\\\n`${globalThis.injected=true}`\u2028\u2029';
  const hostileEpoch = '1700000000000";globalThis.injected=true;//';
  const viewport = { url: hostileUrl }, latest = { frameId: 'frame-1', viewport };
  const frames = { latest, toCssPoint: () => ({ x: 60, y: 80 }), assertViewport() {}, assertCurrentPixels() {} };
  let fixedFunction;
  globalThis.chrome = { scripting: { executeScript: async () => [{ result: { success: true, timeOrigin: hostileEpoch } }] } };
  delete globalThis.browser;
  cdpClient.attach = async () => {};
  try {
    for (const failure of ['none', 'document-exception', 'resolve', 'target-exception', 'missing-target', 'listeners', 'cleanup']) {
      const commands = [], released = [], sandbox = { injected: false };
      const element = {}, document = { defaultView: { location: { href: hostileUrl }, performance: { timeOrigin: hostileEpoch } },
        elementFromPoint: (x, y) => { assert.equal(x, 60); assert.equal(y, 80); return element; } };
      cdpClient.sendCommand = async (_tab, method, params) => {
        commands.push({ method, params });
        if (method === 'Runtime.evaluate') {
          assert.equal(params.expression, 'document', 'Runtime.evaluate source cannot contain page-controlled metadata');
          return { result: { objectId: 'document-handle' }, ...(failure === 'document-exception' ? { exceptionDetails: { text: 'Document lookup failed' } } : {}) };
        }
        if (method === 'Runtime.callFunctionOn') {
          assert.equal(params.objectId, 'document-handle');
          assert.deepEqual(params.arguments, [hostileUrl, hostileEpoch, 60, 80].map(value => ({ value })));
          fixedFunction ||= params.functionDeclaration;
          assert.equal(params.functionDeclaration, fixedFunction, 'Executable source must remain invariant');
          assert.equal(params.functionDeclaration.includes(hostileUrl), false);
          assert.equal(params.functionDeclaration.includes(hostileEpoch), false);
          const resolve = runInNewContext(`(${params.functionDeclaration})`, sandbox);
          assert.equal(resolve.call(document, ...params.arguments.map(arg => arg.value)), element);
          assert.equal(sandbox.injected, false);
          assert.equal(resolve.call(document, hostileUrl + 'changed', hostileEpoch, 60, 80), null);
          assert.equal(resolve.call(document, hostileUrl, 'different-document', 60, 80), null);
          assert.equal(resolve.call(document, hostileUrl, hostileEpoch, '60;globalThis.injected=true', 80), null);
          if (failure === 'resolve') throw new Error('Resolution failed');
          return { result: failure === 'missing-target' ? { subtype: 'null' } : { objectId: 'element-handle' },
            ...(failure === 'target-exception' ? { exceptionDetails: { text: 'Target resolution failed' } } : {}) };
        }
        if (method === 'DOMDebugger.getEventListeners') {
          assert.equal(params.objectId, 'element-handle');
          if (failure === 'listeners') throw new Error('Listener inspection failed');
          return { listeners: [{ type: 'click', passive: true }] };
        }
        assert.equal(method, 'Runtime.releaseObject'); released.push(params.objectId);
        if (failure === 'cleanup' && params.objectId === 'element-handle') throw new Error('Element cleanup failed');
        return {};
      };
      const run = () => chromeDev.runVisionDevCapability({}, { mode: 'dev', devAuthorized: true, tabId: 1,
        name: 'inspect_event_listeners', args: { frameId: latest.frameId, x: 60, y: 80 }, frames,
        browser: { readViewport: async () => viewport, capture: async () => ({ dataUrl: 'fixture', viewport }) }, authorize: async () => true });
      if (failure === 'resolve' || failure === 'listeners') await assert.rejects(run(), /failed/i);
      else {
        const { result } = await run(); assert.equal(result.success, !['missing-target', 'document-exception', 'target-exception'].includes(failure));
        if (result.success) assert.equal(result.count, 1);
      }
      assert.deepEqual(released, ['resolve', 'missing-target', 'document-exception'].includes(failure)
        ? ['document-handle'] : ['element-handle', 'document-handle']);
      assert.equal(sandbox.injected, false);
      assert.equal(commands.some(command => command.method === 'Input.insertText'), false);
    }
  } finally { Object.assign(globalThis, previous); Object.assign(cdpClient, backend); }
});

for (const [name, engine, api] of [['Chrome', chromium, chromeDev], ['Firefox', firefox, firefoxDev]]) {
  test(`${name}: real point-target CSS, reversible patches and race/conflict guards`, async t => {
    const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><style>body{margin:0}button{position:absolute;left:40px;top:60px;width:180px;height:80px;color:rgb(10,20,30)}</style><button id="target"><b>Original</b></button><script>document.querySelector("button").addEventListener("click",()=>{}, {passive:true});</script>'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await engine.launch({ headless: true,
      args: engine === chromium && process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [] });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const previous = { chrome: globalThis.chrome, browser: globalThis.browser };
    const backend = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
    let cdp, contextId, scripts = 0, inputs = 0, frameSequence = 0, originalImage;
    const nativeCommands = [];
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    if (name === 'Chrome') {
      cdp = await page.context().newCDPSession(page);
      const { frameTree } = await cdp.send('Page.getFrameTree');
      contextId = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'test-extension-isolated' })).executionContextId;
      cdpClient.attach = async () => {};
      cdpClient.sendCommand = async (_tab, method, params) => { nativeCommands.push({ method, params }); return cdp.send(method, params); };
    }
    const script = async details => {
      scripts++;
      if (!details.args[0].operation.startsWith('_') && ['patch_element', 'inject_css', 'revert_patch', 'remove_injected_css'].includes(details.args[0].operation)) inputs++;
      assert.equal(details.world, 'ISOLATED'); assert.equal(details.target.tabId, 1);
      let result;
      if (cdp) {
        const response = await cdp.send('Runtime.callFunctionOn', { functionDeclaration: `function(value){ return (${details.func.toString()})(value); }`,
          executionContextId: contextId, arguments: [{ value: details.args[0] }], returnByValue: true });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
        result = response.result.value;
      } else {
        // Firefox executes the identical trusted extension function against a
        // real Firefox document; only the extension API bridge is substituted.
        result = await page.evaluate(details.func, details.args[0]);
      }
      return [{ result }];
    };
    globalThis.chrome = { scripting: { executeScript: script } }; delete globalThis.browser;
    const viewport = async () => {
      const value = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0,
        scrollX, scrollY, scale: 1, devicePixelRatio, documentId: String(performance.timeOrigin), url: location.href }));
      // Chrome production provenance is loaderId, not performance.timeOrigin.
      if (cdp) value.documentId = (await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId;
      return value;
    };
    const capture = async () => ({ dataUrl: (await page.screenshot()).toString('base64'), viewport: await viewport() });
    const frames = { latest: null, assertViewport: current => assert.ok(sameVisionViewport(frames.latest.viewport, current), 'stale viewport'),
      toCssPoint: args => visionPointToCss(frames.latest, args),
      assertCurrentPixels: async image => { if (image !== originalImage) throw new Error('stale screenshot pixels'); } };
    const refresh = async () => { const shot = await capture(); originalImage = shot.dataUrl;
      frames.latest = { frameId: `frame-${++frameSequence}`, canvas: { width: 800, height: 600 }, viewport: shot.viewport, images: [] }; };
    const agent = { executeTool: () => { throw new Error('Legacy tool forbidden'); } };
    const run = (tool, extra = {}, options = {}) => api.runVisionDevCapability(agent, { name: tool,
      args: { frameId: frames.latest.frameId, ...(tool === 'revert_patch' || tool === 'remove_injected_css' ? {} : { x: 60, y: 80 }), ...extra },
      tabId: 1, mode: 'dev', devAuthorized: true, frames, browser: { capture, readViewport: viewport },
      authorize: async () => true, verify: async () => ({ verified: true, allowed: true }), ...options });
    try {
      await refresh();
      const style = await run('inspect_element_styles'); assert.equal(style.result.success, true); assert.equal(style.result.computed.color, 'rgb(10, 20, 30)');
      assert.equal(style.result.tag, 'button'); assert.equal(style.result.source, 'visual_target_css');
      if (cdp) {
        const listeners = await run('inspect_event_listeners', { eventTypes: ['click'] });
        assert.equal(listeners.result.success, true); assert.equal(listeners.result.count, 1);
        assert.equal(listeners.result.listeners[0].passive, true); assert.equal(Object.hasOwn(listeners.result.listeners[0], 'handler'), false);
        await t.test('hostile URL text stays typed data during real native listener inspection', async () => {
          await page.evaluate(() => { globalThis.__devInjectionExecuted = false;
            location.hash = "';globalThis.__devInjectionExecuted=true;//`${globalThis.__devInjectionExecuted=true}`\\\u2028\u2029"; });
          await refresh(); nativeCommands.length = 0;
          const hostile = await run('inspect_event_listeners', { eventTypes: ['click'] });
          assert.equal(hostile.result.success, true); assert.equal(hostile.result.count, 1);
          assert.equal(hostile.result.listeners[0].passive, true);
          assert.equal(await page.evaluate(() => globalThis.__devInjectionExecuted), false);
          assert.equal(nativeCommands.find(command => command.method === 'Runtime.evaluate').params.expression, 'document');
          const lookup = nativeCommands.find(command => command.method === 'Runtime.callFunctionOn').params;
          assert.deepEqual(lookup.arguments, [page.url(), await page.evaluate(() => String(performance.timeOrigin)), 60, 80].map(value => ({ value })));
          assert.equal(lookup.functionDeclaration.includes(page.url()), false);
          assert.equal(nativeCommands.filter(command => command.method === 'Runtime.releaseObject').length, 2);
          await page.evaluate(() => history.replaceState(null, '', location.pathname)); await refresh();
        });
      }
      const patch = await run('patch_element', { styles: { color: 'red' }, text: 'Edited', attributes: { 'aria-label': 'Edited control' } });
      assert.equal(patch.result.success, true, JSON.stringify(patch)); assert.equal(patch.effects.observe, true);
      assert.deepEqual(await page.locator('#target').evaluate(el => ({ text: el.textContent, color: getComputedStyle(el).color, aria: el.getAttribute('aria-label') })),
        { text: 'Edited', color: 'rgb(255, 0, 0)', aria: 'Edited control' });
      await refresh();
      const undo = await run('revert_patch', { patchId: patch.result.patchId }); assert.equal(undo.result.removed, true);
      assert.equal(await page.locator('#target b').textContent(), 'Original'); assert.equal(await page.locator('#target').getAttribute('aria-label'), null);
      await refresh();
      const css = await run('inject_css', { css: 'background-color: rgb(1, 2, 3); margin: 4px;' }); assert.equal(css.result.success, true);
      await refresh(); assert.equal((await run('remove_injected_css', { patchId: css.result.patchId })).result.removed, true);
      await refresh();
      const baseline = inputs;
      await assert.rejects(run('patch_element', { text: 'Must not happen' }, { verify: async () => {
        await page.locator('#target').evaluate(el => el.style.left = '300px'); return { verified: true, allowed: true };
      } }), /stale screenshot pixels/);
      assert.equal(inputs, baseline); assert.equal(await page.locator('#target b').textContent(), 'Original');
      await page.locator('#target').evaluate(el => el.style.left = '40px'); await refresh();
      const oldBeforeDispatch = inputs;
      await assert.rejects(run('patch_element', { text: 'Stopped' }, { beforeDispatch: async () => false }), /stopped before dispatch/);
      assert.equal(inputs, oldBeforeDispatch);
      const changed = await run('patch_element', { text: 'Owned edit' }); assert.equal(changed.result.success, true); await refresh();
      await page.locator('#target').evaluate(el => { el.firstChild.data = 'New user text'; }); await refresh();
      const conflict = await run('revert_patch', { patchId: changed.result.patchId });
      assert.equal(conflict.result.noDispatch, true); assert.match(conflict.result.error, /newer page or user edits/);
      assert.equal(await page.locator('#target').textContent(), 'New user text');
      const noops = inputs;
      const invalid = await run('patch_element', { styles: { color: 'not-a-color' } });
      assert.equal(invalid.result.noDispatch, true); assert.match(invalid.result.error, /invalid in this browser/);
      assert.equal(inputs, noops + 1, 'Native validation rejects invalid CSS before mutation');
      await refresh();
      globalThis.chrome.scripting.executeScript = async details => {
        const result = await script(details);
        if (details.args[0].operation === 'patch_element') throw new Error('Native response lost after dispatch');
        return result;
      };
      const lost = await run('patch_element', { text: 'Delivered despite lost reply' });
      assert.equal(lost.result.dispatched, true); assert.equal(lost.result.outcomeUnknown, true);
      assert.notEqual(lost.result.noDispatch, true); assert.equal(lost.effects.observe, true); assert.ok(lost.result.patchId);
      assert.equal(await page.locator('#target').textContent(), 'Delivered despite lost reply');
      globalThis.chrome.scripting.executeScript = script; await refresh();
      assert.equal((await run('revert_patch', { patchId: lost.result.patchId })).result.removed, true);
      await refresh();
      const stop = new AbortController();
      globalThis.chrome.scripting.executeScript = async details => {
        const result = await script(details);
        if (details.args[0].operation === 'patch_element') stop.abort(new DOMException('Stopped', 'AbortError'));
        return result;
      };
      const stopped = await run('patch_element', { text: 'Completed before Stop' }, { signal: stop.signal });
      assert.equal(stopped.result.success, true); assert.equal(stopped.result.cancelledAfterDispatch, true);
      assert.equal(stopped.effects.observe, true); assert.equal(await page.locator('#target').textContent(), 'Completed before Stop');
      globalThis.chrome.scripting.executeScript = script;
      await t.test('same-URL reload rejects a document epoch captured before the reload', async () => {
        const oldOrigin = await page.evaluate(() => String(performance.timeOrigin)); await page.reload();
        const result = await page.evaluate(api.visualDevTargetOperation, { operation: 'patch_element', point: { x: 130, y: 100 }, args: { text: 'Wrong document' },
          expectedUrl: url, expectedTimeOrigin: oldOrigin, patchId: 'stale-document' });
        assert.equal(result.noDispatch, true); assert.match(result.error, /document changed/);
        assert.equal(await page.locator('#target b').textContent(), 'Original');
      });
      assert.ok(scripts > 12);
    } finally {
      Object.assign(globalThis, previous); Object.assign(cdpClient, backend);
      await browser.close(); await new Promise(resolve => server.close(resolve));
    }
  });
}
