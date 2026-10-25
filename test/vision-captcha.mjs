import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const pageUrl = 'https://challenge.example/form';
const api = { runtime: { getURL: path => `chrome-extension://fixture/${path}` },
  storage: { local: { get: async () => ({ twoCaptchaEnabled: true, twoCaptchaApiKey: 'a'.repeat(32) }) } },
  tabs: { get: async () => ({ id: 77, url: pageUrl }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, url: pageUrl }] },
  scripting: { executeScript: async () => [] },
};
globalThis.chrome = api; globalThis.browser = api;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const mod = await import(`../src/${build}/src/agent/vision-captcha.js`);
  const native = await import(`../src/${build}/src/agent/captcha-native-providers.js`);
  const solver = await import(`../src/${build}/src/agent/captcha-solver.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  function fixture() {
    const controller = new AbortController(), calls = [], checkpoints = [];
    const viewport = { width: 800, height: 600, url: pageUrl, documentId: '100' };
    const target = { rootTimeOrigin: 100, timeOrigin: 100, frameUrl: pageUrl, framePath: [], elementUrl: '', websiteKey: 'observed-key' };
    const candidate = { type: 'recaptcha_v2', websiteKey: 'observed-key', frameId: 0, frameUrl: pageUrl, documentTimeOrigin: 100 };
    const state = {};
    const agent = { _ensureGateSetting: async () => {}, _skipPermissionGate: true,
      _nativeCaptchaSolutions: new Map(),
      async executeTool(tabId, name, args, update, context) {
        await context.visionBeforePaidDispatch(); calls.push({ tabId, name, args });
        agent._nativeCaptchaSolutions.set(tabId, { pageUrl, createdAt: Date.now(), taskId: 'paid-one',
          family: 'recaptcha_v2', applied: false, provider: '2captcha', documents: [{ frameId: 0, url: pageUrl, timeOrigin: target.timeOrigin }], solution: { token: 'retained-token' } });
        return { success: true, dispatched: true, token: args.type === 'image_to_text' ? 'ABC123' : 'retained-token', taskId: 'paid-one', solution: { token: 'retained-token' } };
      },
    };
    const context = { tabId: 77, state, signal: controller.signal,
      args: { frameId: 'frame-1', x: 30, y: 40 },
      frames: { latest: { frameId: 'frame-1', canvas: { width: 800, height: 600 } },
        toCssPoint(args) { assert.equal(args.frameId, 'frame-1'); return { x: args.x, y: args.y }; },
        assertViewport: value => assert.deepEqual(value, viewport), assertCurrentPixels: async () => {}, assertCurrentRegions: async () => {} },
      browser: { capture: async () => ({ dataUrl: 'data:image/png;base64,b2JzZXJ2ZWQ=', viewport }) },
      targetAt: async () => ({ ...target }), detectCaptcha: async () => ({ selected: candidate }),
      checkpoint: async () => { checkpoints.push(structuredClone(state)); return true; },
      verify: async () => ({ verified: true, allowed: true }),
      crop: async () => ({ imageBase64: 'current-screen-crop', width: 100, height: 50 }),
    };
    return { agent, context, controller, target, candidate, calls, checkpoints, state,
      run: (name = 'solve_captcha', args = {}, extra = {}) => mod.runVisionCaptchaTool(agent, { ...context, name, args: { ...context.args, ...args }, ...extra }) };
  }

  test(`${build}: CAPTCHA schemas expose screenshot targets without browser selectors or callbacks`, () => {
    for (const tool of mod.VISION_CAPTCHA_TOOLS) {
      for (const key of ['selector', 'callback', 'fields', 'cookies', 'clicks', 'websiteKey', 'frameUrl', 'imageBase64']) assert.equal(tool.function.parameters.properties[key], undefined);
    }
  });
  test(`${build}: capability discovery uses enabled providers and never exposes configured keys`, async () => {
    const f = fixture(); const result = await f.run('get_captcha_capabilities', { family: 'recaptcha_v2' });
    assert.equal(result.result.success, true); assert.equal(result.effects.observe, false);
    assert.ok(result.result.methods.some(method => method.provider === '2captcha'));
    assert.doesNotMatch(JSON.stringify(result), new RegExp('a'.repeat(32))); assert.equal(f.calls.length, 0);
  });
  test(`${build}: one paid automatic attempt is journaled, retained and never replayed`, async () => {
    const f = fixture(); const result = await f.run();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.inject, false); assert.equal(f.calls[0].args.websiteKey, 'observed-key');
    assert.equal(f.checkpoints[0].attempts[Object.keys(f.state.attempts)[0]].status, 'reserved');
    assert.equal(result.result.clearance, 'unverified'); assert.equal(result.result.token, undefined); assert.ok(result.result.solutionId);
    await assert.rejects(f.run(), /already reserved/); assert.equal(f.calls.length, 1);
  });
  test(`${build}: denied review, stale pixels and failed checkpoint cannot contact a provider`, async () => {
    const denied = fixture(); await assert.rejects(denied.run('solve_captcha', {}, { verify: async () => ({ verified: true, allowed: false }) }), /review/);
    assert.equal(denied.calls.length, 0);
    const stale = fixture(); stale.context.frames.assertCurrentPixels = async () => { throw new Error('stale pixels'); };
    await assert.rejects(stale.run(), /stale/); assert.equal(stale.calls.length, 0);
    const storage = fixture(); await assert.rejects(storage.run('solve_captcha', {}, { checkpoint: async () => false }), /could not be saved/);
    assert.equal(storage.calls.length, 0);
  });
  test(`${build}: target changed during paid preflight prevents a charge`, async () => {
    const f = fixture(); let reads = 0;
    await assert.rejects(f.run('solve_captcha', {}, { targetAt: async () => ({ ...f.target, websiteKey: ++reads > 2 ? 'changed-key' : 'observed-key' }) }), /changed/);
    assert.equal(f.calls.length, 0);
  });
  test(`${build}: a challenge changed during either paid checkpoint cannot contact a provider`, async () => {
    for (const mutateAt of [1, 2]) {
      const f = fixture(); let checkpoints = 0;
      await assert.rejects(f.run('solve_captcha', {}, { beforeDispatch: async () => {
        await Promise.resolve(); if (++checkpoints === mutateAt) f.target.websiteKey = 'rotated-key'; return true;
      } }), error => error.code === 'vision_stale_frame');
      assert.equal(f.calls.length, 0); assert.equal(checkpoints, mutateAt);
    }
  });
  test(`${build}: failed CAPTCHA storage has the terminal checkpoint error code`, async () => {
    const f = fixture();
    await assert.rejects(f.run('solve_captcha', {}, { checkpoint: async () => ({ ok: false }) }), error => error.code === 'vision_checkpoint_failed' && error.noDispatch === true);
    assert.equal(f.calls.length, 0);
  });
  test(`${build}: application rechecks a challenge changed during the applying receipt save`, async () => {
    const original = api.scripting.executeScript;
    try {
      for (const phase of ['beforeDispatch', 'applying_save']) {
        const f = fixture(); const solved = await f.run(); let applications = 0;
        api.scripting.executeScript = async spec => {
          if (spec.func.name === 'applyCaptchaValuesInPage') { applications++; throw new Error('Must not apply stale answer'); }
          return [{ frameId: 0, result: { fields: [{ selector: 'textarea[name="g-recaptcha-response"]', path: 'token' }] } }];
        };
        const mutate = async () => { await Promise.resolve(); f.target.websiteKey = 'rotated-key'; return true; };
        await assert.rejects(f.run('apply_captcha_solution', { solutionId: solved.result.solutionId }, {
          beforeDispatch: phase === 'beforeDispatch' ? mutate : async () => true,
          checkpoint: async () => { if (phase === 'applying_save' && Object.values(f.state.attempts)[0].status === 'applying') await mutate(); return true; },
        }), error => error.code === 'vision_stale_frame');
        assert.equal(applications, 0); assert.equal(f.agent._nativeCaptchaSolutions.get(77).applied, false);
        assert.equal(Object.values(f.state.attempts)[0].status, 'answered', 'The paid answer remains retained');
        assert.equal(f.calls.length, 1, 'No second solve is bought');
      }
    } finally { api.scripting.executeScript = original; }
  });
  test(`${build}: image recognition uses current screenshot crop and adds the missing paid-attempt lock`, async () => {
    const f = fixture(); const result = await f.run('solve_captcha', { strategy: 'image', crop: { x: 10, y: 10, width: 100, height: 50 } });
    assert.equal(f.calls[0].args.imageBase64, 'current-screen-crop'); assert.equal(result.result.text, 'ABC123');
    await assert.rejects(f.run('solve_captcha', { strategy: 'image', crop: { x: 10, y: 10, width: 100, height: 50 } }), /already reserved/);
  });
  test(`${build}: native request mismatch is denied and recognition images cannot be model substituted`, async () => {
    const f = fixture(); const task = { provider: '2captcha', method: 'RecaptchaV2TaskProxyless', parameters: { websiteURL: 'https://other.example/', websiteKey: 'observed-key' } };
    await assert.rejects(f.run('solve_captcha', { strategy: 'native', providerTasks: [task] }), /URL does not match/);
    assert.equal(f.calls.length, 0);
    const imageTask = { provider: '2captcha', method: 'ImageToTextTask', parameters: { body: 'invented-image' } };
    await assert.rejects(f.run('solve_captcha', { strategy: 'native', providerTasks: [imageTask] }), /screenshot crop/);
    await f.run('solve_captcha', { strategy: 'native', providerTasks: [imageTask], crop: { x: 10, y: 10, width: 100, height: 50 } });
    assert.equal(f.calls[0].args.providerTasks[0].parameters.body, 'current-screen-crop');
  });
  test(`${build}: Stop returns immediately during a paid request and leaves its uncertain lock`, { timeout: 2000 }, async () => {
    const f = fixture(); let release;
    f.agent.executeTool = async (_id, _name, _args, _update, ctx) => { await ctx.visionBeforePaidDispatch(); return new Promise(resolve => { release = resolve; }); };
    const run = f.run(); await new Promise(resolve => setImmediate(resolve));
    f.controller.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(run, /Stopped/);
    assert.equal(Object.values(f.state.attempts)[0].status, 'uncertain');
    release({ success: true, dispatched: true });
  });
  test(`${build}: native and automatic weighted fallback stop before charging another provider`, async () => {
    const original = globalThis.fetch;
    try {
      for (const kind of ['native', 'automatic']) {
        const controller = new AbortController(); let calls = 0;
        globalThis.fetch = async () => { calls++; controller.abort(new DOMException('Stopped', 'AbortError')); throw new Error('first provider failed'); };
        const providers = [{ id: 'capsolver', apiKey: 'first-key' }, { id: '2captcha', apiKey: 'second-key' }];
        const operation = kind === 'native'
          ? native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers, providers.map(provider => ({ provider: provider.id, method: 'ImageToTextTask', parameters: { body: 'image' } }))), { signal: controller.signal })
          : solver.solveCaptchaWithProviders(providers, { type: 'image_to_text', imageBase64: 'image' }, { signal: controller.signal });
        await assert.rejects(operation, /Stopped/); assert.equal(calls, 1, kind);
      }
    } finally { globalThis.fetch = original; }
  });
  test(`${build}: actual Agent native provider route preserves its durable single-charge document lock`, async () => {
    const original = { fetch: globalThis.fetch, execute: api.scripting.executeScript };
    let calls = 0;
    api.scripting.executeScript = async () => [{ frameId: 0, result: { url: pageUrl, timeOrigin: 100 } }];
    globalThis.fetch = async () => { calls++; return Response.json({ status: 'ready', taskId: 'real-native-task', solution: { gRecaptchaResponse: 'paid-token' } }); };
    try {
      const agent = new Agent({ getActive: () => ({ name: 'fixture' }) });
      agent._persistNow = async () => ({ ok: true });
      const args = { inject: false, providerTasks: [{ provider: '2captcha', method: 'RecaptchaV2TaskProxyless', parameters: { websiteURL: pageUrl, websiteKey: 'observed-key' } }] };
      const result = await agent.executeTool(77, 'solve_captcha', args, null, { visionOnly: true });
      assert.equal(result.success, true, JSON.stringify(result)); assert.equal(calls, 1);
      const second = await agent.executeTool(77, 'solve_captcha', args, null, { visionOnly: true });
      assert.equal(second.noDispatch, true); assert.equal(calls, 1);
    } finally { globalThis.fetch = original.fetch; api.scripting.executeScript = original.execute; }
  });
  test(`${build}: real browser application uses its retained answer once and never accepts a model selector`, { timeout: 30000 }, async () => {
    const browser = await engine.launch({ headless: true });
    const original = api.scripting.executeScript;
    try {
      const page = await browser.newPage();
      await page.route(pageUrl, route => route.fulfill({ contentType: 'text/html', body: '<div data-sitekey="observed-key" style="width:200px;height:100px">challenge</div><textarea name="g-recaptcha-response"></textarea>' }));
      await page.goto(pageUrl);
      const f = fixture();
      const origin = await page.evaluate(() => performance.timeOrigin);
      f.target.timeOrigin = f.target.rootTimeOrigin = f.candidate.documentTimeOrigin = origin;
      api.scripting.executeScript = async spec => [{ frameId: 0, result: await page.evaluate(([source, args]) => (0, eval)(`(${source})`)(...args), [spec.func.toString(), spec.args || []]) }];
      const solved = await f.run();
      await assert.rejects(f.run('apply_captcha_solution', { solutionId: solved.result.solutionId, selector: '#other' }), /never browser bindings/);
      const applied = await f.run('apply_captcha_solution', { solutionId: solved.result.solutionId });
      assert.equal(applied.result.success, true, JSON.stringify(applied));
      assert.equal(await page.locator('textarea').inputValue(), 'retained-token');
      assert.equal(applied.result.clearance, 'unverified');
      await assert.rejects(f.run('apply_captcha_solution', { solutionId: solved.result.solutionId }), /No unapplied answer/);
      assert.equal(f.calls.length, 1);
    } finally { api.scripting.executeScript = original; await browser.close(); }
  });
  test(`${build}: actual native paid-dispatch fence honors cancellation before contacting a provider`, async () => {
    const original = { fetch: globalThis.fetch, execute: api.scripting.executeScript };
    let calls = 0, fences = 0;
    api.scripting.executeScript = async () => [{ frameId: 0, result: { url: pageUrl, timeOrigin: 100 } }];
    globalThis.fetch = async () => { calls++; throw new Error('Paid request must not happen'); };
    try {
      const agent = new Agent({ getActive: () => ({ name: 'fixture' }) });
      agent._persistNow = async () => ({ ok: true });
      const controller = new AbortController();
      const result = await agent.executeTool(77, 'solve_captcha', { inject: false, providerTasks: [{ provider: '2captcha', method: 'RecaptchaV2TaskProxyless', parameters: { websiteURL: pageUrl, websiteKey: 'observed-key' } }] }, null,
        { visionOnly: true, _contentActionAbortSignal: controller.signal, visionBeforePaidDispatch: async () => { fences++; controller.abort(new DOMException('Stopped', 'AbortError')); } });
      assert.equal(result.success, false); assert.equal(calls, 0); assert.equal(fences, 1);
    } finally { globalThis.fetch = original.fetch; api.scripting.executeScript = original.execute; }
  });
  test(`${build}: real browser hit testing binds only the chosen widget and local response field`, { timeout: 30000 }, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div data-sitekey="site-A" style="width:200px;height:100px">challenge</div><textarea name="g-recaptcha-response"></textarea><p>unrelated secret</p>');
      const target = await page.evaluate(([fn, x, y]) => (0, eval)(`(${fn})`)(x,y), [mod.visionCaptchaTargetAtPoint.toString(), 20, 20]);
      assert.equal(target.websiteKey, 'site-A'); assert.doesNotMatch(JSON.stringify(target), /unrelated secret|challenge/);
      const bindings = await page.evaluate(([fn, candidate]) => (0, eval)(`(${fn})`)(candidate, { token: 'token' }),
        [mod.visionCaptchaApplicationBindings.toString(), { frameUrl: target.frameUrl, documentTimeOrigin: target.timeOrigin, type: 'recaptcha_v2' }]);
      assert.equal(bindings.fields.length, 1); assert.equal(bindings.fields[0].path, 'token');
      await page.locator('body').evaluate(el => el.insertAdjacentHTML('beforeend', '<textarea name="g-recaptcha-response"></textarea>'));
      assert.equal(await page.evaluate(([fn, candidate]) => (0, eval)(`(${fn})`)(candidate, { token: 'token' }),
        [mod.visionCaptchaApplicationBindings.toString(), { frameUrl: target.frameUrl, documentTimeOrigin: target.timeOrigin, type: 'recaptcha_v2' }]), null);
    } finally { await browser.close(); }
  });
}
