import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// An owned canvas chat application makes the screenshot reviewer deterministic:
// it compares the transmitted image's actual ink with independently rasterized
// proposed text. It never reads page text/state to decide a verdict. DOM access
// below only sets up the test app or asserts its final ground truth.
const app = `<!doctype html><style>body{margin:0}canvas{display:block}textarea{position:fixed;left:-10000px;top:0;width:1px;height:1px}</style>
<canvas id="chat" width="640" height="400"></canvas><textarea id="editor"></textarea><script>
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'), editor = document.querySelector('textarea');
const state = {recipient:'Alice',draft:'',messages:[{direction:'incoming',text:'Hello'}],sends:0,trusted:[]};
function paint(){ctx.fillStyle='#fff';ctx.fillRect(0,0,640,400);ctx.fillStyle='#000';ctx.font='20px sans-serif';
ctx.fillText(state.recipient,20,42);state.messages.forEach((m,i)=>ctx.fillText((m.direction==='outgoing'?'Me':state.recipient)+': '+m.text,20,112+i*40));
ctx.strokeStyle='#999';ctx.strokeRect(10.5,300.5,499,59);ctx.fillText(state.draft,20,337);ctx.fillStyle='#ddeeff';ctx.fillRect(520,300,100,60);ctx.fillStyle='#000';ctx.fillText('Send',545,337);}
canvas.addEventListener('click',e=>{state.trusted.push(e.isTrusted);if(e.offsetY>=300&&e.offsetY<360){if(e.offsetX<510)editor.focus({preventScroll:true});else if(e.offsetX>=520&&e.offsetX<620&&state.draft){state.messages.push({direction:'outgoing',text:state.draft});state.draft='';editor.value='';state.sends++;paint();}}});
editor.addEventListener('input',e=>{state.trusted.push(e.isTrusted);state.draft=editor.value;paint();});
window.fixture={state,set:update=>{Object.assign(state,update);editor.value=state.draft;paint();}};paint();
</script>`;
let server, browser, control, target, native, origin, inputCount;
before(async () => {
  server = createServer(async (request, response) => {
    if (request.url === '/chat') { response.setHeader('Content-Type', 'text/html'); response.end(app); return; }
    if (request.url === '/control') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Evidence test controller</title>'); return; }
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (!path.startsWith('/src/chrome/src/') || path.includes('..')) throw new Error('Bad source path');
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    args: process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1' ? ['--disable-gpu', '--disable-gpu-compositing'] : [] });
  const context = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  control = await context.newPage(); target = await context.newPage();
  native = await context.newCDPSession(target);
  await target.goto(`${origin}/chat`); await control.goto(`${origin}/control`);
  await control.exposeFunction('nativeGeometry', () => target.evaluate(() => ({ width: innerWidth, height: innerHeight,
    offsetLeft: 0, offsetTop: 0, scrollX, scrollY, devicePixelRatio, scale: 1,
    url: location.href, documentId: String(performance.timeOrigin), platform: navigator.platform })));
  await control.exposeFunction('nativeScreenshot', async () => `data:image/png;base64,${(await target.screenshot()).toString('base64')}`);
  await control.exposeFunction('nativeCommand', async (method, params) => { inputCount++; return native.send(method, params); });
  await control.evaluate(async () => {
    const { VisionFrameSession } = await import('/src/chrome/src/agent/vision-frames.js');
    const { VisionBrowser } = await import('/src/chrome/src/agent/vision-browser.js');
    const { VisionEvidenceSession } = await import('/src/chrome/src/agent/vision-evidence.js');
    const rects = { recipient: { x: 10, y: 10, width: 600, height: 50 }, composer: { x: 10, y: 300, width: 500, height: 60 },
      send: { x: 520, y: 300, width: 100, height: 60 } };
    window.expectedClaims = ({ frameId, recipient = 'Alice', draft = '', messages = [{ direction: 'incoming', text: 'Hello' }] } = {}) => ({
      frameId: frameId || window.frames.latest.frameId, recipient: { text: recipient, rect: rects.recipient },
      composer: { text: draft, rect: rects.composer }, sendControl: { rect: rects.send },
      messages: messages.map((message, index) => ({ ...message, rect: { x: 10, y: 80 + index * 40, width: 600, height: 40 } })),
      atLatest: true, userInputRequired: false,
    });
    window.adapter = new VisionBrowser({ transport: { readViewport: () => window.nativeGeometry(),
      capture: () => window.nativeScreenshot(), sendInput: (_tab, method, params) => window.nativeCommand(method, params) } });
    window.captureEvidence = async () => { const screenshot = await window.adapter.capture(1);
      return window.frames.capture(screenshot.dataUrl, screenshot.viewport, { forceFull: true }); };
    window.verdictCount = 0;
    const verify = async ({ kind, frame, claims, expected, baseline }) => {
      window.verdictCount++;
      const image = await createImageBitmap(await (await fetch(frame.images[0].dataUrl)).blob());
      const canvas = new OffscreenCanvas(640, 400), ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
      const actual = ctx.getImageData(0, 0, 640, 400).data;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 400); ctx.fillStyle = '#000'; ctx.font = '20px sans-serif';
      ctx.fillText(claims.recipient.text, 20, 42);
      claims.messages.forEach((message, index) => ctx.fillText((message.direction === 'outgoing' ? 'Me' : claims.recipient.text) + ': ' + message.text, 20, 112 + index * 40));
      ctx.strokeStyle = '#999'; ctx.strokeRect(10.5, 300.5, 499, 59); ctx.fillText(claims.composer.text, 20, 337);
      ctx.fillStyle = '#ddeeff'; ctx.fillRect(520, 300, 100, 60); ctx.fillStyle = '#000'; ctx.fillText('Send', 545, 337);
      const proposed = ctx.getImageData(0, 0, 640, 400).data;
      const matches = rect => {
        let ink = 0, mismatch = 0;
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
          const position = (y * 640 + x) * 4, a = actual[position] < 100, b = proposed[position] < 100;
          if (a || b) ink++; if (a !== b) mismatch++;
        }
        return mismatch / Math.max(ink, 1) < .12;
      };
      const recipientMatches = matches(rects.recipient) && (!expected?.recipient || expected.recipient === claims.recipient.text);
      const composerMatches = matches(rects.composer) && (kind !== 'chat_draft' || expected?.text == null || expected.text === claims.composer.text);
      const messagesMatch = matches({ x: 10, y: 80, width: 600, height: 200 });
      const delivered = kind === 'chat_delivery' && claims.messages.filter(m => m.direction === 'outgoing' && m.text === expected.text).length
        > baseline.claims.messages.filter(m => m.direction === 'outgoing' && m.text === expected.text).length;
      return { verified: recipientMatches && composerMatches && messagesMatch, allowed: true, reason: 'Transmitted screenshot ink comparison',
        provenance: 'independent_visual_review', recipientMatches, composerMatches, atLatest: messagesMatch,
        delivered, newOutgoing: delivered, composerEmpty: claims.composer.text === '' };
    };
    window.resetEvidence = async (restored = false) => {
      window.frames = new VisionFrameSession(); window.verdictCount = 0;
      if (!restored) localStorage.removeItem('evidence-ledger');
      window.evidence = new VisionEvidenceSession({ getFrame: () => window.frames.latest, observe: () => window.captureEvidence(),
        assertCurrent: async args => { const screenshot = await window.adapter.capture(1);
          return window.frames.assertCurrentRegions(screenshot.dataUrl, screenshot.viewport, args); },
        perform: (action, args) => window.adapter.perform(1, action, args, window.frames), verify,
        authorizeChat: async ({ recipient, text }) => ({ allowed: recipient === 'Alice' && text === 'Approved reply', recipient, text, scopeId: 'trusted-request' }),
        persist: async value => { localStorage.setItem('evidence-ledger', JSON.stringify(value)); return true; },
        state: restored ? JSON.parse(localStorage.getItem('evidence-ledger')) : undefined,
      });
      await window.captureEvidence();
    };
    window.observeChat = values => window.evidence.execute('chat_observe', window.expectedClaims(values));
    window.sendChat = (observationId, stage = 'prepare', operationId) => window.evidence.execute('chat_send', {
      frameId: window.frames.latest.frameId, observationId, stage, recipient: 'Alice', text: 'Approved reply', ...(operationId ? { operationId } : {}) });
  });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function reset(state = {}) {
  inputCount = 0;
  await target.evaluate(state => window.fixture.set({ recipient: 'Alice', draft: '', messages: [{ direction: 'incoming', text: 'Hello' }], sends: 0, trusted: [], ...state }), state);
  await control.evaluate(() => window.resetEvidence());
}

test('real screenshot reviewer rejects a fabricated recipient before any native input', async () => {
  await reset({ recipient: 'Mallory' });
  const fabricated = await control.evaluate(() => window.observeChat());
  assert.equal(fabricated.code, 'vision_evidence_unverified'); assert.equal(inputCount, 0);
  const honest = await control.evaluate(() => window.observeChat({ recipient: 'Mallory' }));
  assert.equal(honest.success, true);
  const blocked = await control.evaluate(id => window.sendChat(id), honest.observationId);
  assert.equal(blocked.code, 'vision_chat_recipient_mismatch'); assert.equal(inputCount, 0);
});

test('real user draft is protected and lying about an empty composer fails pixel review', async () => {
  await reset({ draft: 'Private unsent note' });
  assert.equal((await control.evaluate(() => window.observeChat())).code, 'vision_evidence_unverified');
  const observed = await control.evaluate(() => window.observeChat({ draft: 'Private unsent note' }));
  const blocked = await control.evaluate(id => window.sendChat(id), observed.observationId);
  assert.equal(blocked.code, 'vision_chat_user_draft'); assert.equal(inputCount, 0);
  assert.equal(await target.evaluate(() => window.fixture.state.draft), 'Private unsent note');
});

test('recipient change after screenshot review is caught by full-region pixel guard', async () => {
  await reset(); const observed = await control.evaluate(() => window.observeChat());
  await target.evaluate(() => window.fixture.set({ recipient: 'Mallory' }));
  const result = await control.evaluate(id => window.sendChat(id), observed.observationId);
  assert.equal(result.code, 'vision_stale_frame'); assert.equal(inputCount, 0);
  assert.equal(await target.evaluate(() => window.fixture.state.sends), 0);
});

test('native coordinate draft and one Send require visible new-bubble proof; restart cannot duplicate', async () => {
  await reset(); const observed = await control.evaluate(() => window.observeChat());
  const prepared = await control.evaluate(id => window.sendChat(id), observed.observationId);
  assert.equal(prepared.draftPrepared, true, JSON.stringify(prepared)); assert.equal(prepared.sent, false);
  assert.deepEqual(await target.evaluate(() => ({ draft: window.fixture.state.draft, sends: window.fixture.state.sends })), { draft: 'Approved reply', sends: 0 });
  const draftObserved = await control.evaluate(() => window.observeChat({ draft: 'Approved reply' }));
  const sent = await control.evaluate(args => window.sendChat(args.observationId, 'submit', args.operationId), { observationId: draftObserved.observationId, operationId: prepared.operationId });
  assert.equal(sent.sent, true, JSON.stringify(sent)); assert.equal(sent.deliveryVerified, false);
  assert.equal(await target.evaluate(() => window.fixture.state.sends), 1);
  await control.evaluate(() => window.resetEvidence(true));
  const done = await control.evaluate(() => window.observeChat({ messages: [{ direction: 'incoming', text: 'Hello' }, { direction: 'outgoing', text: 'Approved reply' }] }));
  assert.equal(done.deliveryVerified, true, JSON.stringify(done)); assert.equal(done.pendingOutbound, false);
  const replay = await control.evaluate(id => window.sendChat(id), done.observationId);
  assert.equal(replay.code, 'vision_chat_already_sent');
  const final = await target.evaluate(() => window.fixture.state);
  assert.equal(final.sends, 1); assert.equal(final.messages.filter(m => m.direction === 'outgoing').length, 1);
  assert.ok(final.trusted.length >= 3); assert.ok(final.trusted.every(Boolean), 'Native browser input must deliver trusted events');
  assert.ok(await control.evaluate(() => window.verdictCount >= 2));
});
