import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium, firefox } from 'playwright';
import vm from 'node:vm';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { exportRecordedSession } = await import(`../src/${build}/src/trace/session-export.js`);
  const { observeAwsWafChallengeInPage } = await import(`../src/${build}/src/agent/captcha-frame-runtime.js`);
  test(`${build}: AWS observer captures SDK inputs and distinguishes visible shadow widgets from hidden remnants`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.route('**/*', async route => {
        if (route.request().url() === 'http://aws-fixture.local/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
          <div id="amzn-captcha-old" style="display:none">Old widget</div><div id="shadow"></div>
          <script src="https://site.captcha-sdk.awswaf.com/jsapi.js"></script>` });
        await route.fulfill({ contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
      });
      await page.goto('http://aws-fixture.local/');
      await page.evaluate(async () => {
        window.gokuProps = { key: 'old-key', iv: 'old-iv', context: 'old-context' };
        document.cookie = 'aws-waf-token=existing-cookie';
        document.querySelector('#shadow').attachShadow({ mode: 'open' }).innerHTML = '<div id="amzn-captcha-current" style="width:200px;height:100px">Challenge</div>';
        await (await fetch('https://site.captcha.awswaf.com/ait/problem?kind=visual&api_key=observed-sdk-key')).text();
      });
      const observed = await page.evaluate(observeAwsWafChallengeInPage);
      assert.equal(observed.active, true); assert.equal(observed.inspectionComplete, true);
      assert.equal(observed.apiKey, 'observed-sdk-key'); assert.equal(observed.existingToken, 'existing-cookie');
      assert.equal(observed.jsapiScript, 'https://site.captcha-sdk.awswaf.com/jsapi.js');
      await page.evaluate(() => { document.querySelector('#shadow').style.display = 'none'; });
      assert.equal((await page.evaluate(observeAwsWafChallengeInPage)).active, false);
      await page.evaluate(() => {
        document.querySelector('#shadow').style.display = '';
        document.querySelector('#shadow').shadowRoot.querySelector('div').style.height = '0px';
      });
      assert.equal((await page.evaluate(observeAwsWafChallengeInPage)).active, false);
    } finally { await browser.close(); }
  });
  test(`${build}: full JSON preserves all session runs, large results and portable screenshots`, async () => {
    const content = 'complete-result-'.repeat(1000);
    const exported = await exportRecordedSession({
      listRuns: async options => {
        assert.equal(options.limit, Number.MAX_SAFE_INTEGER);
        return Array.from({ length: 501 }, (_, index) => ({ runId: String(index), conversationId: 'session', startedAt: 501 - index }));
      },
      getRunEvents: async () => [{ seq: 1, kind: 'tool', data: { name: 'extract_data', result: { content } } },
        { seq: 2, kind: 'screenshot', data: { caption: 'page' } }],
      getScreenshot: async () => ({ blob: new Blob(['screenshot-bytes'], { type: 'image/png' }) }),
    }, 'session', 'test');
    const payload = JSON.parse(exported.json);
    assert.equal(payload.schema, 'webbrain-trace/1'); assert.equal(payload.session.sessionId, 'session');
    assert.equal(payload.runs.length, 501); assert.equal(payload.runs[0].run.runId, '500');
    assert.equal(payload.runs[0].events[0].data.result.content, content);
    assert.equal(payload.runs[0].events[1].data.screenshot_base64, 'data:image/png;base64,' + btoa('screenshot-bytes'));
    assert.equal(exported.recordingTruncated, false);
  });

  test(`${build}: full export reports old recording omissions instead of concealing them`, async () => {
    const result = await exportRecordedSession({ listRuns: async () => [{ conversationId: 's', runId: 'r' }],
      getRunEvents: async () => [{ kind: 'tool', data: { result: { _truncated: true, head: 'budget reached' } } }],
    }, 's');
    assert.equal(result.recordingTruncated, true);
    assert.equal(JSON.parse(result.json).runs[0].events[0].data.result._truncated, true);
    await assert.rejects(exportRecordedSession({ listRuns: async () => [{ conversationId: 's' }],
      getRunEvents: async () => { throw new Error('Unreadable log'); } }, 's'), /Unreadable log/);
  });

  test(`${build}: --full requires --traces and cannot combine with --config`, async () => {
    const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
    const metadataStart = source.indexOf("    value: '/export',");
    const metadataEnd = source.indexOf("    value: '/import',", metadataStart);
    const metadata = source.slice(metadataStart, metadataEnd).replace(/\s*},\s*\{\s*$/, '');
    // Exercise the actual parser with just the export command metadata.
    const parserStart = source.indexOf('function parseSlashInvocation(');
    const parserEnd = source.indexOf('\nfunction ', parserStart + 10);
    const helpers = ['findSlashCommand', 'slashCommandOptions'].map(name => {
      const start = source.indexOf(`function ${name}(`); return source.slice(start, source.indexOf('\nfunction ', start + 10));
    }).join('\n');
    const context = vm.createContext({});
    vm.runInContext(`const SLASH_HELP_OPTION = { value: '--help' }; const SLASH_COMMANDS = [{${metadata}}];\n` + helpers + '\n' + source.slice(parserStart, parserEnd) + '\nglobalThis.parse = parseSlashInvocation;', context);
    for (const command of ['/export --traces --full', '/export --full --traces']) {
      const result = context.parse(command);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.action, 'traces'); assert.equal(result.optionValues.has('--full'), true);
    }
    for (const command of ['/export --full', '/export --config --full', '/export --traces --full extra']) assert.ok(context.parse(command).error, command);
  });

  test(`${build}: full export returns a small descriptor only after pending writes settle`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    // Exercise the real method with a controlled recorder queue. No database
    // payload should be read or assembled in the background full-export path.
    let release;
    let hydrated = false;
    const context = vm.createContext({ trace: { flushPendingWrites: () => new Promise(resolve => { release = resolve; }) } });
    const exportTraces = vm.runInContext(`({${Agent.prototype.exportTraces.toString()}}).exportTraces`, context);
    const agent = { conversationIds: new Map(), async _hydrate(tabId) {
      hydrated = true; this.conversationIds.set(tabId, 'session');
    } };
    let finished = false;
    const pending = exportTraces.call(agent, 1, { full: true }).then(result => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hydrated, true); assert.equal(finished, false);
    release();
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { ok: true, sessionId: 'session' });
  });

  test(`${build}: slash export downloads over 64 MiB from shared IndexedDB without a large message`, async () => {
    const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
    const start = source.indexOf("  if (command.value === '/export' && action === 'traces') {");
    const end = source.indexOf("  if (command.value === '/export' && action === 'conversation') {", start);
    assert.ok(start >= 0 && end > start);
    const harness = `export async function run(response, full = true) {
      const tabId = 1, command = { value: '/export' }, action = 'traces', optionValues = new Set(full ? ['--full'] : []);
      const sendToBackground = async () => response === undefined ? globalThis.backgroundExport() : response;
      const t = key => key, addPersistentSlashMessage = message => globalThis.exportMessages.push(message);
      ${source.slice(start, end)}
    }`;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ acceptDownloads: true });
      await context.route('http://trace-download.local/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
        if (path === '/src/ui/export-harness.js') return route.fulfill({ contentType: 'text/javascript', body: harness });
        const file = resolve(`src/${build}`, '.' + path);
        if (!file.startsWith(resolve(`src/${build}`) + sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      const writer = await context.newPage();
      await writer.goto('http://trace-download.local/');
      await writer.evaluate(async () => {
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ tracingEnabled: true, losslessTrace: true }) } } };
        const trace = await import('/src/trace/recorder.js');
        const { Agent } = await import('/src/agent/agent.js');
        globalThis.exportAgent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
        exportAgent._hydrate = async tabId => exportAgent.conversationIds.set(tabId, 'large-session');
        await trace.listRuns(); // Initialize the shared database schema.
        const runId = 'large-run';
        // 200 stored screenshots, 256 KiB each: portable base64 JSON >64 MiB.
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('webbrain_traces', 2);
          req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
        const bytes = new Uint8Array(256 * 1024).fill(97); bytes[bytes.length - 1] = 122;
        const blob = new Blob([bytes], { type: 'image/png' });
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['runs', 'events', 'shots'], 'readwrite');
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
          tx.objectStore('runs').put({ runId, conversationId: 'large-session', lossless: true, startedAt: 1 });
          for (let seq = 1; seq <= 200; seq++) {
            tx.objectStore('events').put({ runId, seq, kind: 'screenshot', data: { caption: `shot-${seq}` } });
            tx.objectStore('shots').put({ runId, seq, blob });
          }
        });
        db.close();
        // Intentionally leave this queued. The descriptor must not overtake it.
        void trace.recordToolCall(runId, 201, { name: 'solve_captcha', result: { success: false, error: 'last recorded outcome' } });
      });
      const panel = await context.newPage();
      let responseBytes = 0;
      await panel.exposeFunction('backgroundExport', async () => {
        const response = await writer.evaluate(() => exportAgent.exportTraces(1, { full: true }));
        responseBytes = Buffer.byteLength(JSON.stringify(response));
        assert.ok(responseBytes < 1024, `Only a session descriptor may cross runtime messaging; got ${responseBytes} bytes`);
        return response;
      });
      await panel.goto('http://trace-download.local/');
      await panel.evaluate(() => {
        globalThis.chrome = globalThis.browser = { runtime: { getManifest: () => ({ version: 'test' }) } };
        globalThis.exportMessages = [];
      });
      const downloadPromise = panel.waitForEvent('download');
      await panel.evaluate(async () => (await import('/src/ui/export-harness.js')).run());
      const download = await downloadPromise;
      assert.match(download.suggestedFilename(), /^webbrain-traces-\d+\.json$/);
      const bytes = await readFile(await download.path());
      assert.ok(bytes.length > 64 * 1024 * 1024, `Fixture must exceed Chrome's message cap: ${bytes.length}`);
      assert.ok(responseBytes < 1024);
      const payload = JSON.parse(bytes.toString());
      assert.equal(payload.session.sessionId, 'large-session');
      assert.equal(payload.exportedByWebBrainVersion, 'test');
      const events = payload.runs[0].events;
      const shots = events.filter(event => event.kind === 'screenshot');
      assert.equal(shots.length, 200);
      for (const [index, event] of shots.entries()) {
        assert.equal(event.data.caption, `shot-${index + 1}`);
        const shot = Buffer.from(event.data.screenshot_base64.split(',')[1], 'base64');
        assert.equal(shot.length, 256 * 1024); assert.equal(shot[0], 97); assert.equal(shot.at(-1), 122);
      }
      assert.equal(events.at(-1).data.outcome.error, 'last recorded outcome');
      assert.deepEqual(await panel.evaluate(() => exportMessages), ['sp.export_traces.done']);

      // Empty/error descriptors keep their messages and never initiate downloads.
      let unexpectedDownloads = 0;
      panel.on('download', () => unexpectedDownloads++);
      await panel.evaluate(async () => {
        exportMessages.length = 0;
        const { run } = await import('/src/ui/export-harness.js');
        await run({ ok: true, reason: 'no-conversation', turnCount: 0 });
        await run({ ok: true, sessionId: 'missing-session' });
        await run({ ok: false, error: 'Unreadable log' });
      });
      assert.equal(unexpectedDownloads, 0);
      assert.deepEqual(await panel.evaluate(() => exportMessages), [
        'sp.export_traces.no_conversation', 'sp.export_traces.none', 'sp.export_traces.error (Unreadable log)',
      ]);
      const markdownPromise = panel.waitForEvent('download');
      await panel.evaluate(async () => (await import('/src/ui/export-harness.js')).run({ ok: true, markdown: '# Summary', turnCount: 1 }, false));
      const markdown = await markdownPromise;
      assert.match(markdown.suggestedFilename(), /\.md$/);
      assert.equal(await readFile(await markdown.path(), 'utf8'), '# Summary');
    } finally { await browser.close(); }
  });

  test(`${build}: exhausted recording budget retains solver outcome and exports it as JSON`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.route('http://trace-test.local/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
        const file = resolve(`src/${build}`, '.' + path);
        if (!file.startsWith(resolve(`src/${build}`) + sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      await page.goto('http://trace-test.local/');
      const result = await page.evaluate(async () => {
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ tracingEnabled: true, losslessTrace: true }) } } };
        const trace = await import('/src/trace/recorder.js');
        const { exportRecordedSession } = await import('/src/trace/session-export.js');
        const runId = await trace.startRun({ conversationId: 'session' });
        for (let step = 0; step < 30; step++) await trace.recordLLMRequest(runId, step, {}, {
          messages: [{ role: 'user', content: 'large context '.repeat(40_000) }], tools: [],
        });
        for (let step = 30; step < 33; step++) await trace.recordToolCall(runId, step, { name: 'get_accessibility_tree', args: {}, result: { pageContent: 'page '.repeat(50_000) } });
        await trace.recordToolCall(runId, 33, { name: 'solve_captcha', args: { type: 'aws_waf', websiteKey: 'must-not-be-in-summary' },
          result: { success: false, dispatched: false, noDispatch: true, error: 'All compatible AWS providers have already been attempted.', solution: { cookie: 'must-not-be-in-summary'.repeat(30000) } } });
        const events = await trace.getRunEvents(runId);
        const exported = await exportRecordedSession(trace, 'session', 'test');
        return { budget: (await trace.getRun(runId)).losslessBytes, tool: events.find(event => event.kind === 'tool' && event.data.name === 'solve_captcha'), payload: JSON.parse(exported.json), recordingTruncated: exported.recordingTruncated };
      });
      assert.equal(result.tool.data.losslessBudgetOmitted, true, JSON.stringify({ budget: result.budget, keys: Object.keys(result.tool.data), resultKeys: Object.keys(result.tool.data.result || {}) }));
      assert.equal(result.tool.data.result.success, false);
      assert.equal(result.tool.data.result.noDispatch, true);
      assert.match(result.tool.data.result.error, /already been attempted/);
      assert.equal(result.tool.data.outcome.request.type, 'aws_waf');
      assert.doesNotMatch(JSON.stringify(result.tool.data.outcome), /must-not-be-in-summary/);
      assert.equal(result.recordingTruncated, true);
      assert.equal(result.payload.runs[0].events.at(-1).data.outcome.noDispatch, true);
    } finally { await browser.close(); }
  });
}
