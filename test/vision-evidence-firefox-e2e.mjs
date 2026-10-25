import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { firefox } from 'playwright';
import { BidiSession } from '../firefox-companion/session.mjs';
import { readVisionViewport, performVisionInput, captureVision } from '../firefox-companion/vision.mjs';
import { VisionBrowser } from '../src/firefox/src/agent/vision-browser.js';
import { VisionFrameSession } from '../src/firefox/src/agent/vision-frames.js';
import { VisionEvidenceSession } from '../src/firefox/src/agent/vision-evidence.js';
import { normalizeVisionReview } from '../src/firefox/src/agent/vision-review.js';

// This exercises production evidence transactions and actual Firefox companion
// input/capture. The reviewer is an explicit deterministic pixel oracle for this
// owned canvas fixture, not a claim about a live model's visual judgment.
const html = `<!doctype html><style>body{margin:0}canvas{display:block}textarea{position:fixed;left:-10000px;top:0;width:1px;height:1px}</style>
<canvas id="page" width="640" height="480"></canvas><textarea id="editor"></textarea><script>
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),editor=document.querySelector('textarea');
const state={surface:'conversation',recipient:'Alice',author:'Alice',audience:'Private',draft:'',messages:[],sends:0,trusted:[]};
function paint(){ctx.fillStyle='#fff';ctx.fillRect(0,0,640,480);ctx.fillStyle='#000';ctx.font='20px sans-serif';
ctx.fillText(state.recipient,20,35);ctx.fillText('Author: '+state.author,20,70);ctx.fillText('Audience: '+state.audience,320,70);
state.messages.forEach((m,i)=>ctx.fillText((m.direction==='outgoing'?(state.surface==='publication'?state.author:'Me'):state.recipient)+': '+m.text,20,125+i*40));
ctx.strokeStyle='#999';ctx.strokeRect(10.5,330.5,479,69);ctx.fillText(state.draft,20,372);
if(state.draft){ctx.fillStyle='#ddeeff';ctx.fillRect(510,330,115,70);ctx.fillStyle='#000';ctx.font='bold 20px sans-serif';ctx.fillText(state.surface==='publication'?'Publish':'Send',525,372);}}
canvas.addEventListener('click',e=>{state.trusted.push(e.isTrusted);if(e.offsetY>=330&&e.offsetY<400){if(e.offsetX>=10&&e.offsetX<490)editor.focus({preventScroll:true});
else if(e.offsetX>=510&&e.offsetX<625&&state.draft){state.messages.push({direction:'outgoing',text:state.draft});state.draft='';editor.value='';state.sends++;paint();}}});
editor.addEventListener('input',e=>{state.trusted.push(e.isTrusted);state.draft=editor.value;paint();});
window.fixture={state,set:next=>{Object.assign(state,next);editor.value=state.draft;paint();}};paint();
</script>`;
const rects = { recipient: { x: 10, y: 5, width: 615, height: 38 }, author: { x: 10, y: 45, width: 300, height: 40 },
  audience: { x: 315, y: 45, width: 310, height: 40 }, composer: { x: 10, y: 330, width: 480, height: 70 },
  send: { x: 510, y: 330, width: 115, height: 70 } };

test('real Firefox companion: hidden Send and public publication require verified draft, visible control and single delivery', { timeout: 120000 }, async t => {
  const server = createServer(async (request, response) => {
    const module = /^\/(vision-frames|image-budget)\.js$/.exec(request.url)?.[1];
    response.setHeader('Content-Type', module ? 'text/javascript' : 'text/html; charset=utf-8');
    response.end(module ? await readFile(resolve(`src/firefox/src/agent/${module}.js`)) : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const temporary = await realpath(tmpdir()), profile = await mkdtemp(join(temporary, 'webbrain-evidence-firefox-'));
  await writeFile(join(profile, 'user.js'), 'user_pref("layout.css.devPixelsPerPx", "1");\n');
  const child = spawn(process.env.FIREFOX_BINARY || firefox.executablePath(), [
    '--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const session = new BidiSession();
  try {
    const port = await new Promise((resolvePort, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Firefox did not open BiDi: ${output.slice(-1000)}`)), 20000);
      const read = data => {
        output += data;
        const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
      };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Firefox exited ${code}: ${output.slice(-1000)}`)); });
    });
    await session.connect(port);
    const tree = await session.send('browsingContext.getTree', {});
    const context = tree.contexts?.[0]?.context || (await session.send('browsingContext.create', { type: 'tab' })).context;
    await session.send('browsingContext.setViewport', { context, viewport: { width: 640, height: 480 } });
    const runId = crypto.randomUUID(), startupUrl = `about:blank#wb-vision-${crypto.randomUUID()}`;
    await session.send('browsingContext.navigate', { context, url: startupUrl, wait: 'complete' });
    await session.openVisionStartupRun(runId, startupUrl);
    await session.send('browsingContext.navigate', { context, url, wait: 'complete' });
    const call = async (fn, value) => {
      const response = await session.send('script.callFunction', { target: { context }, functionDeclaration: fn.toString(),
        arguments: [{ type: 'string', value: JSON.stringify(value ?? null) }], awaitPromise: true });
      if (response.type === 'exception') throw new Error(response.exceptionDetails.text);
      return response.result.value;
    };
    const nativeMethods = [], originalSend = session.send.bind(session);
    session.send = (method, params) => { nativeMethods.push(method); return originalSend(method, params); };
    let inputCount = 0;
    const adapter = new VisionBrowser({ transport: {
      readViewport: () => readVisionViewport(session, runId),
      capture: async () => `data:image/png;base64,${(await captureVision(session, runId)).data}`,
      sendInput: (_tab, method, params, { viewport, release }) => {
        inputCount++; return performVisionInput(session, runId, method, params, viewport, release);
      },
    } });
    const frames = new VisionFrameSession();
    const observe = async () => {
      const captured = await adapter.capture(1);
      frames.latest = JSON.parse(await call(async payload => {
        const { VisionFrameSession } = await import('/vision-frames.js');
        globalThis.fixtureFrames ||= new VisionFrameSession();
        const captured = JSON.parse(payload);
        return JSON.stringify(await fixtureFrames.capture(captured.dataUrl, captured.viewport, { forceFull: true }));
      }, captured));
      return frames.latest;
    };
    frames.assertCurrentPixels = (dataUrl, viewport, args) => call(async payload => {
      const { dataUrl, viewport, args } = JSON.parse(payload);
      return await fixtureFrames.assertCurrentPixels(dataUrl, viewport, args);
    }, { dataUrl, viewport, args });
    const assertCurrent = async args => {
      const captured = await adapter.capture(1);
      return await call(async payload => {
        const { captured, args } = JSON.parse(payload);
        return await fixtureFrames.assertCurrentRegions(captured.dataUrl, captured.viewport, args);
      }, { captured, args });
    };
    let lastReview;
    const verify = async ({ kind, frame, claims, expected, baseline }) => {
      // This function receives only transmitted image bytes and proposed claims;
      // it never consults fixture.state, DOM text or a selected element.
      const verdict = JSON.parse(await call(async payload => {
        const { kind, dataUrl, claims, expected, baseline, rects } = JSON.parse(payload);
        const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
        const canvas = new OffscreenCanvas(640, 480), ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0); bitmap.close(); const actual = ctx.getImageData(0, 0, 640, 480).data;
        const publication = claims.surface === 'publication', author = publication ? claims.publication.author.text : 'Alice';
        const audience = publication ? claims.publication.audience.text : 'Private';
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#000'; ctx.font = '20px sans-serif';
        ctx.fillText(claims.recipient.text, 20, 35); ctx.fillText('Author: ' + author, 20, 70); ctx.fillText('Audience: ' + audience, 320, 70);
        claims.messages.forEach((message, index) => ctx.fillText((message.direction === 'outgoing' ? (publication ? author : 'Me') : claims.recipient.text)
          + ': ' + message.text, 20, 125 + index * 40));
        ctx.strokeStyle = '#999'; ctx.strokeRect(10.5, 330.5, 479, 69); ctx.fillText(claims.composer.text, 20, 372);
        if (claims.composer.text || claims.sendControl) {
          ctx.fillStyle = '#ddeeff'; ctx.fillRect(510, 330, 115, 70); ctx.fillStyle = '#000';
          ctx.font = 'bold 20px sans-serif';
          ctx.fillText(publication ? 'Publish' : 'Send', 525, 372);
        }
        const proposed = ctx.getImageData(0, 0, 640, 480).data;
        const ratios = [];
        const matches = box => {
          let ink = 0, mismatch = 0;
          for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
            const i = (y * 640 + x) * 4, a = actual[i] < 100, b = proposed[i] < 100;
            if (a || b) ink++; if (a !== b) mismatch++;
          }
          const ratio = mismatch / Math.max(ink, 1); ratios.push(ratio);
          return ratio < .12;
        };
        const recipientMatches = matches(rects.recipient) && (!expected?.recipient || expected.recipient === claims.recipient.text);
        const composerMatches = matches(rects.composer) && (expected?.text == null || expected.text === claims.composer.text || kind === 'chat_delivery');
        const authorMatches = !publication || matches(rects.author) && (!expected?.publication || expected.publication.author.text === author);
        const audienceMatches = !publication || matches(rects.audience) && (!expected?.publication || expected.publication.audience.text === audience);
        const atLatest = matches({ x: 10, y: 90, width: 615, height: 200 });
        const sendMatches = !claims.sendControl || matches(rects.send);
        const delivered = kind === 'chat_delivery' && claims.messages.filter(message => message.direction === 'outgoing' && message.text === expected.text).length
          > baseline.claims.messages.filter(message => message.direction === 'outgoing' && message.text === expected.text).length;
        return JSON.stringify({ verified: recipientMatches && composerMatches && authorMatches && audienceMatches && atLatest && sendMatches,
          allowed: true, recipientMatches, composerMatches, authorMatches, audienceMatches, atLatest,
          delivered, newOutgoing: delivered, composerEmpty: claims.composer.text === '',
          reason: 'Owned fixture pixel comparison', provenance: 'independent_visual_review', pixelRatios: ratios });
      }, { kind, dataUrl: frame.images[0].dataUrl, claims, expected, baseline, rects }));
      lastReview = verdict;
      return normalizeVisionReview(verdict, kind, claims, expected);
    };
    const truth = async () => JSON.parse(await call(() => JSON.stringify(fixture.state)));
    for (const surface of ['conversation', 'publication']) await t.test(`${surface}: omitted initial Send, native draft and exact one verified delivery`, async () => {
      const recipient = surface === 'publication' ? 'Team board' : 'Alice';
      const text = surface === 'publication' ? 'Approved public update' : 'Approved reply';
      const messages = surface === 'publication' ? [] : [{ direction: 'incoming', text: 'Hello' }];
      const base = { surface, recipient, author: 'Alice', audience: surface === 'publication' ? 'Public' : 'Private', draft: '', messages, sends: 0, trusted: [] };
      await call(payload => fixture.set(JSON.parse(payload)), base); inputCount = 0; await observe();
      let saved, evidence;
      const makeEvidence = restored => new VisionEvidenceSession({ getFrame: () => frames.latest, observe, assertCurrent, verify,
        perform: async (action, args, options) => { await options.beforeDispatch(); return adapter.perform(1, action, args, frames); },
        authorizeChat: async proposal => ({ ...proposal, allowed: proposal.recipient === recipient && proposal.text === text
          && proposal.surface === surface && (surface !== 'publication' || proposal.publication.author.text === 'Alice'
            && proposal.publication.audience.text === 'Public'), scopeId: 'owned-fixture-trusted-task' }),
        persist: async state => { saved = structuredClone(state); return true; }, state: restored ? saved : undefined,
      });
      evidence = makeEvidence(false);
      const claims = ({ draft = '', sent = false, send = !!draft } = {}) => ({
        frameId: frames.latest.frameId, surface, recipient: { text: recipient, rect: rects.recipient },
        ...(surface === 'publication' ? { publication: { author: { text: 'Alice', rect: rects.author },
          audience: { text: 'Public', rect: rects.audience } } } : {}),
        composer: { text: draft, rect: rects.composer }, ...(send ? { sendControl: { rect: rects.send } } : {}),
        messages: [...messages, ...(sent ? [{ direction: 'outgoing', text }] : [])].map((message, index) => ({
          ...message, rect: { x: 10, y: 90 + index * 40, width: 615, height: 40 } })),
        atLatest: true, userInputRequired: false,
      });
      const send = (observationId, stage = 'prepare', operationId) => evidence.execute('chat_send', {
        frameId: frames.latest.frameId, observationId, stage, recipient, text, ...(operationId ? { operationId } : {}),
      });
      assert.equal((await evidence.execute('chat_observe', claims({ send: true }))).code, 'vision_evidence_unverified', 'Invented hidden control must fail actual pixel review');
      if (surface === 'publication') {
        for (const key of ['author', 'audience']) {
          const bad = claims(); bad.publication[key].text = key === 'author' ? 'Mallory' : 'Private';
          assert.equal((await evidence.execute('chat_observe', bad)).code, 'vision_evidence_unverified');
        }
      }
      assert.equal(inputCount, 0);
      const observed = await evidence.execute('chat_observe', claims());
      assert.equal(observed.success, true, JSON.stringify(observed)); assert.equal(observed.sendControlAvailable, false);
      const prepared = await send(observed.observationId);
      assert.equal(prepared.draftPrepared, true, JSON.stringify(prepared));
      assert.equal((await truth()).sends, 0); assert.equal((await truth()).draft, text);
      const noControl = await evidence.execute('chat_observe', claims({ draft: text, send: false }));
      assert.equal(noControl.success, true, JSON.stringify(noControl));
      const beforeSubmit = inputCount;
      const blocked = await send(noControl.observationId, 'submit', prepared.operationId);
      assert.equal(blocked.code, 'vision_chat_send_control_required'); assert.equal(inputCount, beforeSubmit);
      await observe();
      const draft = await evidence.execute('chat_observe', claims({ draft: text }));
      assert.equal(draft.success, true, JSON.stringify({ draft, lastReview }));
      const submitted = await send(draft.observationId, 'submit', prepared.operationId);
      assert.equal(submitted.sent, true, JSON.stringify(submitted)); assert.equal(submitted.deliveryVerified, false);
      assert.equal((await truth()).sends, 1);
      evidence = makeEvidence(true);
      const beforeReplay = inputCount;
      const replay = await send(draft.observationId, 'submit', prepared.operationId);
      assert.equal(replay.noDispatch, true); assert.equal(inputCount, beforeReplay);
      const delivered = await evidence.execute('chat_observe', claims({ sent: true }));
      assert.equal(delivered.deliveryVerified, true, JSON.stringify(delivered)); assert.equal(delivered.pendingOutbound, false);
      const duplicate = await send(delivered.observationId);
      assert.equal(duplicate.code, 'vision_chat_already_sent'); assert.equal(inputCount, beforeReplay);
      const final = await truth(); assert.equal(final.sends, 1); assert.equal(final.draft, '');
      assert.ok(final.trusted.length >= 3 && final.trusted.every(Boolean), 'All clicks and text input are native trusted events');
    });
    assert.equal(nativeMethods.includes('browsingContext.locateNodes'), false, 'After the native run handshake, semantic input has no DOM target lookup');
    await session.closeRun(runId);
  } finally {
    await session.close().catch(() => {});
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    const resolved = await realpath(profile);
    assert.equal(dirname(resolved).toLowerCase(), temporary.toLowerCase());
    assert.match(basename(resolved), /^webbrain-evidence-firefox-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await new Promise(resolve => server.close(resolve));
  }
});
