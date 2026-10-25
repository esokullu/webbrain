import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { firefox } from 'playwright';
import { BidiSession } from '../firefox-companion/session.mjs';
import { readVisionViewport, performVisionInput, captureVision } from '../firefox-companion/vision.mjs';
import { VisionBrowser } from '../src/firefox/src/agent/vision-browser.js';
import { VisionFrameSession, normalizeVisionViewport } from '../src/firefox/src/agent/vision-frames.js';

const html = `<!doctype html><style>body{margin:0;height:2500px}button{position:absolute;left:100px;top:100px;width:100px;height:50px}textarea{position:absolute;left:100px;top:200px;width:220px;height:60px}#drag{position:absolute;left:450px;top:100px;width:80px;height:80px;background:teal}</style>
<button id="button">Click</button><textarea id="text"></textarea><div id="drag"></div>
<script>window.events=[];window.submits=0;for(const name of ['click','input','keydown','pointermove','pointerdown','pointerup','wheel']) document.addEventListener(name,e=>{events.push({type:name,trusted:e.isTrusted,target:e.target.id,key:e.key});if(name==='keydown'&&e.key==='Enter')submits++});window.count=0;button.onclick=()=>count++;</script>`;

test('real Firefox BiDi: DPR 1/2 screenshot mapping, trusted Unicode text, literal newlines, key, drag, scroll and stale navigation', { timeout: 120000 }, async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const tempRoot = await realpath(tmpdir());
  try {
    for (const dpr of [1, 2]) {
      const profile = await mkdtemp(join(tempRoot, 'webbrain-vision-firefox-'));
      await writeFile(join(profile, 'user.js'), `user_pref("layout.css.devPixelsPerPx", "${dpr}");\n`);
      const child = spawn(process.env.FIREFOX_BINARY || firefox.executablePath(), [
        '--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const session = new BidiSession();
      try {
        const port = await new Promise((resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error(`Firefox did not open BiDi: ${output.slice(-1000)}`)), 20000);
          const read = data => {
            output += data;
            const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
          };
          child.stdout.on('data', read); child.stderr.on('data', read);
          child.on('error', error => { clearTimeout(timer); reject(error); });
          child.on('exit', code => { clearTimeout(timer); reject(new Error(`Firefox exited ${code}: ${output.slice(-1000)}`)); });
        });
        await session.connect(port);
        const tree = await session.send('browsingContext.getTree', {});
        const context = tree.contexts?.[0]?.context || (await session.send('browsingContext.create', { type: 'tab' })).context;
        await session.send('browsingContext.setViewport', { context, viewport: { width: 800, height: 600 } });
        await session.send('browsingContext.navigate', { context, url, wait: 'complete' });
        const evaluate = async expression => (await session.send('script.evaluate', { target: { context }, expression, awaitPromise: true })).result.value;
        const runId = crypto.randomUUID(), token = crypto.randomUUID();
        await evaluate(`document.documentElement.setAttribute('data-webbrain-bidi', ${JSON.stringify(token)})`);
        // The production openRun handshake has its own companion E2E suite.
        // Bind this known test context directly to isolate the vision protocol.
        session.runs.set(runId, { context, navigation: false });
        const methods = [];
        const originalSend = session.send.bind(session);
        session.send = async (method, params) => { methods.push(method); return originalSend(method, params); };
        const adapter = new VisionBrowser({ transport: {
          readViewport: () => readVisionViewport(session, runId),
          capture: async () => `data:image/png;base64,${(await captureVision(session, runId)).data}`,
          sendInput: (_tab, method, params, { viewport, release }) => performVisionInput(session, runId, method, params, viewport, release),
        } });
        const observe = async () => {
          const captured = await adapter.capture(1), bytes = Buffer.from(captured.dataUrl.split(',')[1], 'base64');
          const frame = new VisionFrameSession();
          frame.assertCurrentPixels = async () => true;
          frame.latest = { frameId: 'current', viewport: normalizeVisionViewport(captured.viewport),
            canvas: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }, images: [] };
          return frame;
        };
        let frame = await observe();
        assert.equal(frame.latest.viewport.devicePixelRatio, dpr);
        const point = (x, y) => ({ frameId: 'current', x: x / frame.latest.viewport.width * frame.latest.canvas.width,
          y: y / frame.latest.viewport.height * frame.latest.canvas.height });
        assert.equal((await adapter.perform(1, 'click', point(150, 125), frame)).success, true);
        assert.equal(await evaluate('count'), 1);
        const result = await adapter.perform(1, 'type', { ...point(150, 225), text: 'İstanbul 🙂\nliteral text', clear: true }, frame);
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(await evaluate('text.value'), 'İstanbul 🙂\nliteral text');
        assert.equal(await evaluate('submits'), 0, 'Literal typing must not synthesize Enter submissions');
        assert.equal((await adapter.perform(1, 'key', { frameId: 'current', key: 'ControlOrMeta+A' }, frame)).success, true);
        assert.equal((await adapter.perform(1, 'drag', { ...point(480, 130), toX: point(650, 300).x, toY: point(650, 300).y }, frame)).success, true);
        assert.equal((await adapter.perform(1, 'scroll', { ...point(700, 500), deltaY: 300 }, frame)).success, true);
        const deadline = Date.now() + 4000;
        while (!(await evaluate('scrollY > 0')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(await evaluate('scrollY > 0'), true);
        assert.equal((await adapter.perform(1, 'click', point(150, 125), frame)).noDispatch, true);
        assert.equal(await evaluate('events.every(e => e.trusted)'), true);
        // Firefox's wheel animation can still be settling when its native
        // action acknowledges. Wait for a stable viewport before observation.
        let previousScroll = -1;
        for (let i = 0; i < 40; i++) {
          const currentScroll = await evaluate('scrollY');
          if (currentScroll === previousScroll) break;
          previousScroll = currentScroll; await new Promise(resolve => setTimeout(resolve, 50));
        }
        frame = await observe();
        await session.send('browsingContext.navigate', { context, url, wait: 'complete' });
        assert.equal((await adapter.perform(1, 'key', { frameId: 'current', key: 'Enter' }, frame)).noDispatch, true);
        assert.equal(methods.includes('browsingContext.locateNodes'), false, 'Vision input must not bind target elements');
        await session.closeRun(runId);
      } finally {
        await session.close().catch(() => {});
        if (child.exitCode === null) {
          const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
        }
        const resolved = await realpath(profile);
        assert.equal(dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
        assert.match(basename(resolved), /^webbrain-vision-firefox-/);
        await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
