import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Upload-only video attachment through the installed Chrome extension. The
// page input receives the exact bytes; the model never receives them.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || path.join(os.tmpdir(), 'webbrain-video-upload-mv3'));
await fs.mkdir(out, { recursive: true });

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(4), Buffer.from('mp42isom')]);
const mp4Base64 = mp4.toString('base64');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pageHtml = '<!doctype html><title>Owned video QA</title><h1>Video upload QA</h1><form><label>QA video attachment <input name="attachment" type="file" required accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"></label></form><script>window.nativeAttachments=[];document.querySelector("input").addEventListener("change",async e=>{const f=e.target.files[0];const bytes=await f.arrayBuffer();const digest=await crypto.subtle.digest("SHA-256",bytes);window.nativeAttachments.push({name:f.name,size:f.size,mime:f.type,sha256:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,"0")).join("")});});</script>';

let base;
const calls = [];
let actionCalls = 0;
const server = http.createServer(async (req, res) => {
  if (req.url === '/attachment') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let text = '';
    for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    calls.push(input);
    const judge = String(input.messages?.[0]?.content || '').startsWith('Evaluate only the observable requirements of the genuine user task');
    const action = Array.isArray(input.tools) && input.tools.length > 0;
    let message;
    if (judge) {
      message = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Require the video to reach the page input.' }) };
    } else if (!action) {
      message = { role: 'assistant', content: JSON.stringify({
        request_kind: 'execute', scope_relation: 'new', deliverables: ['Attach the uploaded video to the page input'],
        requires_state_change: true, requires_submission: false, messaging: null,
        completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
        read_scope: 'visible_page', summary: 'Attach the uploaded video clip to the QA file input.',
        steps: [{ id: '1', action: 'Use upload_file with the video attachmentId and the QA file input.' }],
        memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [],
      }) };
    } else {
      const notice = JSON.stringify(input.messages || []).match(/attachment_[A-Za-z0-9]+_\d+ \(clip\.mp4\)/);
      const attachmentId = notice?.[0].split(' ')[0];
      const steps = [
        { name: 'upload_file', args: { selector: 'input[name="attachment"]', attachmentId } },
        { name: 'get_accessibility_tree', args: { filter: 'visible' } },
        { name: 'done', args: { summary: 'The uploaded video clip was attached to the QA input.', outcome: 'success' } },
      ];
      const step = steps[actionCalls++] || steps.at(-1);
      message = { role: 'assistant', content: '', tool_calls: [{ id: `video-upload-${actionCalls}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `video-${calls.length}`, choices: [{ message, finish_reason: action ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-video-upload-'));
let context;
try {
  const extension = path.resolve(process.env.WEBBRAIN_EXTENSION_PATH || 'src/chrome');
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'chrome-extension:' || u.protocol === 'data:'
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.events = [];
    chrome.runtime.onMessage.addListener(e => { if (e.action === 'agent_update') events.push({ type: e.type, data: e.data }); });
    await chrome.storage.local.set({ actObservation: 'accessibility',
      helpImproveWebBrain: false, planBeforeActMode: 'off', planReviewMode: 'never', screenshotFallback: false, autoScreenshot: false,
      maxAgentSteps: 15, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false,
    });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `${base}/v1`, model: 'minimax/minimax-m3', contextWindow: 1000000, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);

  const page = await context.newPage();
  await page.goto(`${base}/attachment`);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, page.url());
  assert.ok(Number.isInteger(tabId), 'QA tab should be discoverable');

  const result = await message('chat', {
    tabId,
    text: 'Attach the clip I uploaded to the QA video input on this page.',
    mode: 'act',
    requestId: 'qa-video-upload',
    locale: 'en',
    attachments: [{ kind: 'video', name: 'clip.mp4', dataUrl: `data:video/mp4;base64,${mp4Base64}`, mimeType: 'video/mp4', size: mp4.length }],
  });
  const events = await harness.evaluate(() => events);
  await fs.writeFile(path.join(out, 'events.json'), JSON.stringify({ result, events }, null, 2));

  const uploadResults = (result.updates || []).filter(e => e.type === 'tool_result' && e.data?.name === 'upload_file');
  assert.equal(uploadResults.length, 1, 'upload_file should run exactly once');
  assert.equal(uploadResults[0].data.result.success, true, JSON.stringify(uploadResults[0].data.result));
  assert.equal(events.findLast(e => e.type === 'run_complete')?.data?.status, 'completed');

  const nativeAttachments = await page.evaluate(() => window.nativeAttachments);
  assert.deepEqual(nativeAttachments, [{ name: 'clip.mp4', size: mp4.length, mime: 'video/mp4', sha256: sha(mp4) }],
    'the page input must receive the exact video bytes');

  const modelPayloads = JSON.stringify(calls);
  assert.equal(modelPayloads.includes(mp4Base64), false, 'video bytes must never be sent to the model');
  assert.match(modelPayloads, /Video attachments are upload-only: their contents are not visible to you/, 'the model must be told the video is upload-only');

  console.log(JSON.stringify({ passed: true, pageAttachment: nativeAttachments[0], providerCalls: calls.length, modelReceivedVideoBytes: false }));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  const resolved = await fs.realpath(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-video-upload-')) throw new Error('Unexpected profile path');
  await fs.rm(resolved, { recursive: true, force: true });
}
