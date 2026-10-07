#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { messageRecipientUploadSourceKey } from '../src/chrome/src/agent/message-recipient-guard.js';

// Synthetic pages and files only. The actual content recipient probe, private
// dispatch validator, native FileList assignment and upload handlers all run.
const tests = [];
const bytes = Buffer.from('fixture attachment bytes\n');
const directory = await mkdtemp(path.join(tmpdir(), 'webbrain-recipient-upload-'));
const filePath = path.join(directory, 'fixture.txt');
await writeFile(filePath, bytes);
const originalChrome = globalThis.chrome;
const originalBrowser = globalThis.browser;
const originalFetch = globalThis.fetch;
const originalAttach = cdpClient.attach;
const originalSend = cdpClient.sendCommand;
const deliver = (page, message) => page.evaluate(message => new Promise(resolve => {
  window.__wb_handler(message, {}, resolve);
}), message);
const call = (page, action, params) => deliver(page, { target: 'content', action, params });

async function setup(page, kind, url = 'https://www.instagram.com/direct/t/123/') {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto(url);
  await page.setContent(`<!doctype html><style>
    body{margin:0;font:16px sans-serif} #composer{position:fixed;left:340px;top:390px;width:430px;height:200px}
    textarea{width:300px;height:90px} h2{position:fixed;left:350px;top:60px}
  </style><form id="composer"><h2 id="recipient">Gamze</h2><textarea id="body" aria-label="Message"></textarea>
    <input id="file" type="file" accept="image/*,.txt" multiple hidden><span id="counter">1</span>
    <button type="button">Send</button></form><input id="other" type="file" hidden>`);
  await page.evaluate(kind => {
    window.__wb_handlers = [];
    const runtime = { onMessage: { addListener(fn) { window.__wb_handlers.push(fn); } }, getURL: path => path };
    window.__wb_handler = (message, sender, response) => {
      for (const handler of window.__wb_handlers) handler(message, sender, response);
    };
    window.chrome = { runtime }; window.browser = { runtime };
    window.inputEvents = 0; window.changeEvents = 0; window.assignedFiles = [];
    document.querySelector('#file').addEventListener('input', () => window.inputEvents++);
    document.querySelector('#file').addEventListener('change', event => {
      window.changeEvents++;
      window.assignedFiles = Array.from(event.target.files).map(f => ({ name: f.name, size: f.size }));
    });
  }, kind);
  const sourceRoot = path.resolve('src', kind, 'src', 'content');
  for (const file of ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
    await page.addScriptTag({ content: await readFile(path.join(sourceRoot, file), 'utf8') });
  }
  const api = {
    runtime: {},
    tabs: {
      async get() { return { id: 71, url: page.url() }; },
      async sendMessage(_, message, options) {
        if (message.action === 'attach_message_recipient_bound_upload'
            || (message.action === 'probe_message_recipient_guard' && message.params?.tool === 'upload_file')) {
          assert.equal(options?.frameId, 0);
        }
        return deliver(page, message);
      },
      async executeScript(_, details) {
        if (details.file) { await page.addScriptTag({ content: await readFile(path.resolve('src', kind, details.file), 'utf8') }); return []; }
        return [await page.evaluate(source => window.eval(source), details.code)];
      },
    },
    downloads: kind === 'chrome' ? { async search(_, callback) {
      if (api.onFileResolution) { const hook = api.onFileResolution; api.onFileResolution = null; await hook(); }
      callback([{ id: 2024, state: 'complete', filename: filePath }]);
    } } : { async search() {
      if (api.onFileResolution) { const hook = api.onFileResolution; api.onFileResolution = null; await hook(); }
      return [{ id: 2024, state: 'complete', filename: filePath,
        url: 'https://assets.example.test/fixture.txt', mime: 'text/plain' }];
    } },
  };
  globalThis.chrome = api;
  globalThis.browser = api;
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'text/plain' } });
  let session;
  if (kind === 'chrome') {
    session = await page.context().newCDPSession(page);
    cdpClient.attach = async () => {};
    cdpClient.sendCommand = async (_, method, params = {}) => session.send(method, params);
  }
  const Agent = kind === 'chrome' ? ChromeAgent : FirefoxAgent;
  const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
  agent._resolvePromptTier = () => 'full';
  agent._currentUrl = async () => page.url();
  agent._planExecutionGuards.set(71, { messaging: { target_kind: 'named', recipients: ['Gamze'] },
    requiresSubmission: true, requiresStateChange: true });
  const args = { selector: '#file', downloadId: 2024 };
  const bind = async (customArgs = args) => {
    const context = {};
    const block = await agent._messageRecipientGuardBlock(71, 'upload_file', customArgs, page.url(), context);
    return { block, context };
  };
  const state = () => page.evaluate(() => ({ inputs: window.inputEvents, changes: window.changeEvents,
    files: window.assignedFiles, count: document.querySelector('#file')?.files?.length || 0 }));
  return { agent, args, api, bind, state, session };
}

async function activateMonitor(page, f, kind) {
  const sender = { tab: { id: 71 }, frameId: 0, documentId: 'fixture-main', url: page.url() };
  f.agent.isRunning = () => true;
  f.agent._checkAbort = () => false;
  f.api.webNavigation = { getAllFrames: async () => [{ frameId: 0, documentId: sender.documentId, url: page.url() }],
    getFrame: async () => ({ documentId: sender.documentId, url: page.url() }) };
  await page.exposeFunction('__monitorBackground', message => {
    if (message.action === 'get_page_monitor_state') return f.agent.pageMonitorState(sender, message.documentToken, message.frameName);
    if (message.action === 'page_feedback') return f.agent.observePageFeedback(sender, message.feedback);
    return {};
  });
  await page.evaluate(() => {
    chrome.runtime.sendMessage = message => window.__monitorBackground(message);
    browser.runtime.sendMessage = chrome.runtime.sendMessage;
  });
  await page.addScriptTag({ content: await readFile(path.resolve('src', kind, 'src/content/page-monitor.js'), 'utf8') });
  await f.agent._beginPageFeedbackRun(71, 'act');
  const messages = [{ role: 'user', content: 'Attach the downloaded file to Gamze.' }];
  await f.agent._capturePageFeedbackModelState(71, messages);
  const run = f.agent._pageFeedbackRuns.get(71);
  assert.ok(run.modelState.actionBinding?.snapshotToken, 'public observation and original hidden input must be captured before inference');
  assert.ok(messages.some(message => message.webbrainAppOwnedKind === 'page_action_observation'));
  assert.equal(JSON.stringify(messages).includes(filePath), false);
  assert.equal(JSON.stringify(messages).includes(bytes.toString('base64')), false);
  assert.equal(JSON.stringify(messages).includes(run.modelState.actionBinding.snapshotToken), false);
  return { run, messages, sender };
}

for (const kind of ['chrome', 'firefox']) {
  const test = (name, fn) => tests.push({ kind, name: `${kind}: ${name}`, fn });
  test('verified download attaches exact bytes to an empty recipient-bound composer', async page => {
    const f = await setup(page, kind);
    const { block, context } = await f.bind();
    assert.equal(block, null, JSON.stringify(block));
    assert.ok(context.messageRecipientDispatchBinding?.token);
    const result = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.remoteStateVerified, false);
    assert.equal(f.args.filePath, undefined, 'resolved private path must not mutate model/trace arguments');
    assert.equal(f.args.base64, undefined);
    assert.deepEqual(await f.state(), { inputs: 1, changes: 1, files: [{ name: 'fixture.txt', size: bytes.length }], count: 1 });
    assert.equal(await page.locator('#file').evaluate(async el => await el.files[0].text()), bytes.toString());
  });
  for (const mutation of ['recipient', 'route', 'node', 'owner', 'metadata', 'destination', 'method', 'files', 'file identity', 'selector', 'source', 'frame', 'human', 'task']) {
    test(`${mutation} change revokes upload before file assignment or events`, async page => {
      const f = await setup(page, kind);
      if (mutation === 'file identity') await page.locator('#file').evaluate(input => {
        const dt = new DataTransfer(); dt.items.add(new File(['a'], 'same.txt', { lastModified: 123 })); input.files = dt.files;
      });
      const { block, context } = await f.bind();
      assert.equal(block, null, JSON.stringify(block));
      const args = { ...f.args };
      if (mutation === 'selector') args.selector = '#other';
      else if (mutation === 'source') args.downloadId = 2025;
      else if (mutation === 'human') { await page.keyboard.press('ArrowRight'); }
      else if (mutation === 'task') f.agent._hasPendingSteering = () => true;
      else await page.evaluate(mutation => {
        const input = document.querySelector('#file');
        if (mutation === 'recipient') document.querySelector('#recipient').textContent = 'Someone else';
        if (mutation === 'route') history.pushState({}, '', '/direct/t/456/');
        if (mutation === 'node') input.replaceWith(input.cloneNode());
        if (mutation === 'owner') document.body.append(input);
        if (mutation === 'metadata') input.accept = 'video/*';
        if (mutation === 'destination') input.form.action = '/another-thread';
        if (mutation === 'method') input.form.method = 'post';
        if (mutation === 'file identity') {
          const dt = new DataTransfer(); dt.items.add(new File(['b'], 'same.txt', { lastModified: 123 })); input.files = dt.files;
        }
        if (mutation === 'files') {
          const dt = new DataTransfer(); dt.items.add(new File(['another'], 'other.txt')); input.files = dt.files;
        }
        if (mutation === 'frame') {
          const frame = document.createElement('iframe'); document.body.append(frame);
          frame.contentDocument.body.append(input);
        }
      }, mutation);
      const result = await f.agent.executeTool(71, 'upload_file', args, null, context);
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.noDispatch, true, JSON.stringify(result));
      const state = await f.state();
      assert.equal(state.inputs, 0); assert.equal(state.changes, 0); assert.deepEqual(state.files, []);
      if (!['files', 'file identity'].includes(mutation)) assert.equal(state.count, 0);
    });
  }
  test('run-scoped user attachment preserves exact bytes and source identity', async page => {
    const f = await setup(page, kind);
    const [{ attachmentId }] = f.agent._registerUserAttachments(71, [{ kind: 'document', name: 'attached.txt',
      dataUrl: `data:text/plain;base64,${bytes.toString('base64')}` }]);
    const args = { selector: '#file', attachmentId };
    const { block, context } = await f.bind(args);
    assert.equal(block, null, JSON.stringify(block));
    const result = await f.agent.executeTool(71, 'upload_file', args, null, context);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.file, 'attached.txt');
    assert.equal(await page.locator('#file').evaluate(async el => await el.files[0].text()), bytes.toString());
    assert.equal(args.base64, undefined);
  });
  for (const url of ['https://www.linkedin.com/messaging/thread/123/', 'https://chat.example.test/conversation/123/']) {
    test(`generic compose ownership applies on ${new URL(url).hostname}`, async page => {
      const f = await setup(page, kind, url);
      const { block, context } = await f.bind();
      assert.equal(block, null, JSON.stringify(block));
      const result = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal((await f.state()).changes, 1);
    });
  }
  test('LinkedIn public composer cannot borrow private-recipient upload authorization', async page => {
    const f = await setup(page, kind, 'https://www.linkedin.com/feed/');
    await page.locator('#composer').evaluate(el => { el.className = 'share-box'; });
    const { block } = await f.bind();
    assert.equal(block?.noDispatch, true, JSON.stringify(block));
    assert.equal((await f.state()).changes, 0);
  });
  test('LinkedIn inline private compose surface supports the same atomic upload', async page => {
    const f = await setup(page, kind, 'https://www.linkedin.com/feed/');
    await page.locator('#composer').evaluate(el => { el.className = 'msg-form'; });
    const { block, context } = await f.bind();
    assert.equal(block, null, JSON.stringify(block));
    const result = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal((await f.state()).changes, 1);
  });
  for (const change of ['counter', 'resolution counter', 'recipient', 'resolution recipient', 'node', 'human', 'missing snapshot']) {
    test(`original model snapshot and actual monitor validate protected upload across ${change}`, async page => {
      const f = await setup(page, kind);
      const { run } = await activateMonitor(page, f, kind);
      try {
        const { block, context } = await f.bind();
        assert.equal(block, null, JSON.stringify(block));
        const beforeValidation = await f.api.tabs.sendMessage(71, { target: 'content', action: 'page_monitor_validate_model',
          params: { tool: 'upload_file', selector: '#file', runToken: run.token, snapshotToken: run.modelState.actionBinding.snapshotToken } }, { frameId: 0 });
        if (change === 'missing snapshot') delete run.modelState.actionBinding;
        if (change === 'recipient') await page.locator('#recipient').evaluate(el => { el.textContent = 'Someone else'; });
        if (change === 'node') await page.locator('#file').evaluate(el => { el.replaceWith(el.cloneNode()); });
        if (change === 'human') await page.keyboard.press('ArrowRight');
        if (change.startsWith('resolution ')) {
          f.api.onFileResolution = async () => {
            await page.locator('#counter').evaluate(el => { el.textContent = '2'; });
            if (change === 'resolution recipient') await page.locator('#recipient').evaluate(el => { el.textContent = 'Someone else'; });
            await page.waitForTimeout(350);
          };
        } else {
          await page.locator('#counter').evaluate(el => { el.textContent = '2'; });
          await page.waitForTimeout(350);
          assert.equal(f.agent._hasPendingPageFeedback(71), true, 'actual content monitor must report pending churn');
        }
        const result = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
        if (change.endsWith('counter')) {
          assert.equal(result.success, true, JSON.stringify({ result, beforeReady: beforeValidation.ready,
            beforeReason: beforeValidation.reason, beforeUncertified: beforeValidation.uncertified }));
          assert.equal((await f.state()).changes, 1);
        } else {
          assert.equal(result.noDispatch, true, JSON.stringify(result));
          assert.equal((await f.state()).changes, 0);
        }
        assert.equal(f.args.filePath, undefined);
      } finally { f.agent._finishPageFeedbackRun(71); }
    });
  }
  test('passive counters preserve the verified upload input and recipient', async page => {
    const f = await setup(page, kind);
    const { context, block } = await f.bind();
    assert.equal(block, null, JSON.stringify(block));
    await page.locator('#counter').evaluate(el => { el.textContent = '2'; });
    const result = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal((await f.state()).changes, 1);
  });
  test('change handler consuming the input reports one unverified attachment', async page => {
    const f = await setup(page, kind);
    await page.locator('#file').evaluate(el => el.addEventListener('change', () => { el.value = ''; }));
    const { context, block } = await f.bind();
    assert.equal(block, null, JSON.stringify(block));
    const result = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.attachmentState, 'page_consumed');
    assert.equal((await f.state()).changes, 1);
    const replay = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(replay.noDispatch, true, JSON.stringify(replay));
    assert.equal((await f.state()).changes, 1);
  });
  test('recipient switch during input prevents a following change/autosend event', async page => {
    const f = await setup(page, kind);
    await page.locator('#file').evaluate(el => el.addEventListener('input', () => {
      document.querySelector('#recipient').textContent = 'Someone else';
    }));
    const { context, block } = await f.bind();
    assert.equal(block, null, JSON.stringify(block));
    const result = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.dispatched, true); assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false);
    assert.equal((await f.state()).inputs, 1); assert.equal((await f.state()).changes, 0);
  });
  for (const mutation of ['replacement', 'cleared']) {
    test(`file ${mutation} during input prevents a following change/autosend event`, async page => {
      const f = await setup(page, kind);
      await page.locator('#file').evaluate((input, mutation) => input.addEventListener('input', () => {
        if (mutation === 'cleared') { input.value = ''; return; }
        const original = input.files[0];
        const transfer = new DataTransfer();
        transfer.items.add(new File(['x'.repeat(original.size)], original.name,
          { type: original.type, lastModified: original.lastModified }));
        input.files = transfer.files;
      }), mutation);
      const { context, block } = await f.bind();
      assert.equal(block, null, JSON.stringify(block));
      const result = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.reasonCode, 'recipient_upload_file_changed_during_dispatch');
      assert.equal(result.dispatched, true); assert.equal(result.noDispatch, false);
      assert.equal(result.outcomeUnknown, true); assert.equal(result.retryable, false);
      assert.equal((await f.state()).inputs, 1); assert.equal((await f.state()).changes, 0);
      assert.equal(JSON.stringify(result).includes(filePath), false);
      assert.equal(JSON.stringify(result).includes(bytes.toString('base64')), false);
      assert.equal(f.args.filePath, undefined); assert.equal(f.args.base64, undefined);
      const replay = await f.agent.executeTool(71, 'upload_file', f.args, null, context);
      assert.equal(replay.noDispatch, true, JSON.stringify(replay));
      assert.equal((await f.state()).inputs, 1); assert.equal((await f.state()).changes, 0);
    });
  }
  for (const missing of ['recipient', 'authorization', 'submission', 'unique target', 'explicit source', 'compose owner', 'enabled input']) {
    test(`missing ${missing} keeps the unsupported path blocked`, async page => {
      const f = await setup(page, kind);
      const args = { ...f.args };
      if (missing === 'authorization') f.agent._planExecutionGuards.get(71).messaging = null;
      if (missing === 'submission') f.agent._planExecutionGuards.get(71).requiresSubmission = false;
      if (missing === 'recipient') await page.locator('#recipient').evaluate(el => el.remove());
      if (missing === 'unique target') args.selector = 'input[type=file]';
      if (missing === 'compose owner') args.selector = '#other';
      if (missing === 'enabled input') await page.locator('#file').evaluate(el => {
        const fieldset = document.createElement('fieldset'); fieldset.disabled = true;
        el.replaceWith(fieldset); fieldset.append(el);
      });
      if (missing === 'explicit source') { delete args.downloadId; args.filePath = '/missing'; args.attachmentId = 'another'; }
      const { block } = await f.bind(args);
      assert.equal(block?.noDispatch, true, JSON.stringify(block));
      assert.equal((await f.state()).changes, 0);
    });
  }
}

tests.push({ kind: 'chrome', name: 'chrome: explicit absolute local path is resolved then attached atomically', fn: async page => {
  const f = await setup(page, 'chrome');
  const args = { selector: '#file', filePath };
  const { block, context } = await f.bind(args);
  assert.equal(block, null, JSON.stringify(block));
  const result = await f.agent.executeTool(71, 'upload_file', args, null, context);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.file, 'fixture.txt');
  assert.equal(args.base64, undefined);
  assert.equal((await f.state()).changes, 1);
}});

// Verify the native detached path reader never touches a page input.
tests.push({ kind: 'chrome', name: 'chrome: isolated local bytes reader preserves page input and events', fn: async page => {
  const f = await setup(page, 'chrome');
  const payload = await cdpClient.probeLocalFile(71, filePath, { includeData: true });
  assert.equal(payload.readable, true, JSON.stringify(payload));
  assert.equal(Buffer.from(payload.base64, 'base64').toString(), bytes.toString());
  assert.equal(payload.filename, 'fixture.txt');
  assert.deepEqual(await f.state(), { inputs: 0, changes: 0, files: [], count: 0 });
  const rejected = await cdpClient.probeLocalFile(71, filePath, { includeData: true, maxBytes: 1 });
  assert.equal(rejected.readable, false); assert.equal(rejected.base64, undefined);
}});
assert.equal(messageRecipientUploadSourceKey({ downloadId: 2024 }), 'download:2024');
assert.equal(messageRecipientUploadSourceKey({ downloadId: 2024, filePath: '/fallback' }), '');
assert.equal(messageRecipientUploadSourceKey({ attachmentId: 'a', downloadId: 2024 }), '');

let passed = 0, failed = 0;
try {
  for (const [kind, type] of [['chrome', chromium], ['firefox', firefox]]) {
    const browser = await type.launch();
    for (const t of tests.filter(t => t.kind === kind)) {
      const page = await browser.newPage();
      try { await t.fn(page); passed++; console.log(`✓ ${t.name}`); }
      catch (error) { failed++; console.error(`✗ ${t.name}\n${error.stack}`); }
      finally { await page.close(); }
    }
    await browser.close();
  }
} finally {
  globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; globalThis.fetch = originalFetch;
  cdpClient.attach = originalAttach; cdpClient.sendCommand = originalSend;
  await rm(directory, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
