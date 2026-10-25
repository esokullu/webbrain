import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { uploadReleaseHtml, stageSequentialReleaseUploads } from '../lib/upload-release-fixture.mjs';

// Installed Chrome executes the production model wrapper, native download,
// target recovery, CDP file assignment and one owned server submission.
const selectorRecovery = process.argv.includes('--selector-recovery');
const sequentialAssets = process.argv.includes('--sequential-assets');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || `ci/artifacts/upload-release-binding-mv3${selectorRecovery ? '-selectors' : sequentialAssets ? '-sequential' : ''}`);
await fs.mkdir(out, { recursive: true });
const zip = Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.from('Owned binary upload fixture exact bytes.')]);
const filenames = sequentialAssets ? ['owned-chrome.zip', 'owned-edge.zip', 'owned-firefox.zip', 'owned-source.zip'] : ['owned-release.zip'];
const assets = new Map(filenames.map(name => [name, sequentialAssets ? Buffer.concat([zip, Buffer.from(name)]) : zip]));
const uploads = [], decisions = [], assetRequests = [];
let base, step = 0;
let html = uploadReleaseHtml.replace('<file-attachment id="binary-widget">',
  `<div aria-hidden="true" style="display:none">${'<span></span>'.repeat(5000)}</div><file-attachment id="binary-widget">`)
  .replace("document.getElementById('release-form').onsubmit=event=>event.preventDefault();", `
document.getElementById('release-form').onsubmit=async event=>{
 event.preventDefault();const form=new FormData();
 for(const file of (window.queuedAssets || document.getElementById('releases-upload').files))form.append('binary',file);
 const response=await fetch('/upload',{method:'POST',body:form});if(response.ok)document.getElementById('binary-status').textContent='Owned binary release saved';
};`);
if (sequentialAssets) html = html.replace('</script>', `
window.queuedAssets=[];
document.getElementById('releases-upload').addEventListener('change',event=>queuedAssets.push(...event.target.files));
(${stageSequentialReleaseUploads.toString()})();</script>`);
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true, requires_submission: true,
  messaging: null, deliverables: ['Download and attach the requested owned ZIP assets only to the binary widget, submit once and verify saved.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false, completion_requirements: { download: true },
  read_scope: 'visible_page', summary: 'Download the requested ZIP assets, attach to the binary slot, submit once and verify.',
  steps: [{ id: '1', action: 'Download, inspect file inputs, attach ZIP to the binary slot, submit and verify.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
const server = http.createServer(async (request, response) => {
  const filename = request.url.slice(1), bytes = assets.get(filename);
  if (bytes) {
    assetRequests.push(request.method); response.writeHead(200, { 'Content-Type': 'application/zip',
      'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${filename}"` }); response.end(bytes); return;
  }
  if (request.url === '/upload') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    uploads.push({ exactBytes: [...assets.values()].every(bytes => body.includes(bytes)),
      contentType: request.headers['content-type'] }); response.writeHead(200).end('saved'); return;
  }
  if (request.url === '/v1/chat/completions') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), system = textOf(input.messages?.[0]?.content);
    let message;
    if (system.startsWith('Evaluate only the observable requirements of the genuine user task'))
      message = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'Owned binary release saved appears on the current form.' }) };
    else if (!input.tools?.length) message = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      let downloadId, submitRef, downloadIds = [];
      const tools = input.messages.filter(item => item.role === 'tool');
      for (const item of tools) {
        const content = textOf(item.content);
        try {
          const result = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
          downloadId ??= result.downloads?.[0]?.downloadId;
          if (result.downloads?.length) downloadIds = result.downloads.map(item => item.downloadId);
          submitRef ??= result.pageContent?.split('\n').find(line => /button "Publish release"/.test(line))?.match(/\[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
        } catch {}
      }
      // A deep DOM leaves the first exact hidden input outside the capture
      // scan. Its rejected call must return before a fresh inventory and a
      // new model decision attach the same exact source to the intended slot.
      const calls = sequentialAssets ? [
        { name: 'download_files', args: { urls: filenames.map(name => `${base}/${name}`) } },
        ...filenames.flatMap((_, index) => [
          { name: 'get_interactive_elements', args: {} },
          { name: 'upload_file', args: { selector: '#releases-upload', downloadId: downloadIds[index] } },
        ]),
        { name: 'get_accessibility_tree', args: { filter: 'visible', maxChars: 8000 } },
        { name: 'click_ax', args: { ref_id: submitRef } },
        { name: 'read_page', args: { limit: 3000 } },
        { name: 'done', args: { outcome: 'partial', summary: 'The four owned ZIPs were attached and submitted once. Local QA finished.' } },
      ] : [
        { name: 'download_files', args: { urls: [`${base}/owned-release.zip`] } },
        { name: 'upload_file', args: { selector: selectorRecovery ? 'input[type="file"]' : '#releases-upload', downloadId } },
        // Replay the trace's guessed, nonexistent selector after the ambiguous
        // call. Neither failure may dispatch or silently choose an input.
        ...(selectorRecovery ? [{ name: 'upload_file', args: { selector: 'input[name="release[release_assets_attributes][][file]"]', downloadId } }] : []),
        { name: 'get_interactive_elements', args: {} },
        { name: 'upload_file', args: { selector: '#releases-upload', downloadId } },
        { name: 'get_accessibility_tree', args: { filter: 'visible', maxChars: 8000 } },
        { name: 'click_ax', args: { ref_id: submitRef } },
        { name: 'read_page', args: { limit: 3000 } },
        { name: 'done', args: { outcome: 'partial', summary: 'The owned binary ZIP was attached and submitted once. Local QA finished.' } },
      ];
      const selected = calls[Math.min(step, calls.length - 1)];
      decisions.push({ step, selected, precedingToolIds: tools.map(item => item.tool_call_id) });
      message = { role: 'assistant', content: '', tool_calls: [{ id: `owned-release-upload-${step++}`, type: 'function',
        function: { name: selected.name, arguments: JSON.stringify(selected.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-response-${step}`, choices: [{ message,
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-upload-release-')); let context;
try {
  const extension = path.resolve('src/chrome'), downloadsPath = path.join(profile, 'downloads'); await fs.mkdir(downloadsPath);
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', acceptDownloads: true, downloadsPath,
    ...(sequentialAssets ? { viewport: { width: 1100, height: 1000 } } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)
      ? route.continue() : route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    const original = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)) return original(input, options);
      return Promise.reject(new Error('Owned release fixture blocks external requests.'));
    };
  });
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ actObservation: 'accessibility', helpImproveWebBrain: false, planBeforeActMode: 'off', planReviewMode: 'never',
    screenshotFallback: false, autoScreenshot: false, maxAgentSteps: 18, systemOneEnabled: false, tracingEnabled: false,
    agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-key', baseUrl: `${base}/v1`,
    model: 'minimax/minimax-m3', enabled: true, contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(`${base}/owned/repository/releases/new`);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  const result = await message('chat', { tabId, text: `Download ${filenames.map(name => `${base}/${name}`).join(', ')}. Attach exactly those ZIPs to the binary widget, leaving the Markdown slot empty. Submit exactly once and verify Owned binary release saved.`,
    mode: 'act', requestId: 'owned-upload-release', locale: 'en' });
  const state = await page.evaluate(() => ({ events: attachmentEvents, chooserClicks, status: document.getElementById('binary-status').textContent,
    files: [...document.getElementById('releases-upload').files].map(file => ({ name: file.name, size: file.size })),
    staged: [...document.querySelectorAll('.staged-asset input')].map(input => input.value) }));
  const toolResults = result.updates.filter(update => update.type === 'tool_result').map(update => update.data);
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, state, decisions, uploads, assetRequests,
    expectedBytes: zip.length, expectedSha256: crypto.createHash('sha256').update(zip).digest('hex') }, null, 2));
  const attachments = toolResults.filter(item => item.name === 'upload_file');
  const failures = sequentialAssets ? 0 : selectorRecovery ? 2 : 1, recoveryStep = selectorRecovery ? 4 : 3;
  assert.equal(attachments.length, failures + filenames.length, JSON.stringify(toolResults));
  for (const attachment of attachments.slice(0, failures)) {
    assert.equal(attachment.result.errorCode, 'action_binding_unavailable');
    assert.equal(attachment.result.noDispatch, true); assert.equal(attachment.result.dispatched, false);
    assert.match(attachment.result.error, /get_interactive_elements/);
    assert.doesNotMatch(attachment.result.error, /Use the ref_id/);
  }
  if (selectorRecovery) {
    assert.equal(attachments[0].result.bindingFailure, 'target_ambiguous');
    assert.equal(attachments[1].result.bindingFailure, 'target_unresolved');
  }
  for (const attachment of attachments.slice(failures)) {
    assert.equal(attachment.result.success, true, JSON.stringify(attachment));
    if (sequentialAssets) assert.equal(attachment.result.attachmentState, 'page_consumed');
  }
  if (!sequentialAssets) {
    assert.ok(decisions[recoveryStep].precedingToolIds.includes('owned-release-upload-1'), 'A rejected original call returns before the new attachment decision.');
    assert.ok(decisions[recoveryStep].precedingToolIds.includes(`owned-release-upload-${recoveryStep - 1}`), 'Fresh file inventory precedes the new decision.');
  }
  assert.deepEqual(state.events.markdown, []); assert.equal(state.events.binary.length, filenames.length); assert.equal(state.chooserClicks, 0);
  const downloaded = toolResults.find(item => item.name === 'download_files')?.result.downloads;
  assert.equal(downloaded?.length, filenames.length);
  for (const [index, item] of downloaded.entries()) {
    assert.equal(item.success, true); assert.equal(item.url, `${base}/${filenames[index]}`);
    assert.deepEqual(state.events.binary[index], [{ name: path.basename(item.filename), size: assets.get(filenames[index]).length }]);
  }
  if (sequentialAssets) {
    assert.deepEqual(state.files, []);
    assert.deepEqual(state.staged, downloaded.map(item => path.basename(item.filename)));
  } else assert.deepEqual(state.files, [{ name: path.basename(downloaded[0].filename), size: zip.length }]);
  assert.deepEqual(assetRequests, filenames.map(() => 'GET')); assert.equal(uploads.length, 1); assert.equal(uploads[0].exactBytes, true);
  assert.equal(state.status, 'Owned binary release saved');
  console.log(JSON.stringify({ passed: true, rejectedUploads: failures, attachedAssets: filenames.length, alternateSlotUploads: 0,
    chooserClicks: 0, serverSubmissions: uploads.length, exactBytes: uploads[0].exactBytes }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-upload-release-')) throw new Error('Unexpected owned profile path');
  await fs.rm(resolved, { recursive: true, force: true });
}
