#!/usr/bin/env node
// Lean mode comparison (docs/lean-mode.md). Offline and deterministic: every
// page is a local fixture and the model is a fixed script, so repeated runs on
// one machine give the same numbers.
//
//   node scripts/lean-mode-comparison.mjs          print the tables and write docs/lean-mode-comparison.md
//                                                  (npm run compare:lean-mode)
//   node scripts/lean-mode-comparison.mjs --check  print only; exit 1 when the doc differs
//   node scripts/lean-mode-comparison.mjs --json   print the raw numbers only
//   node scripts/lean-mode-comparison.mjs --debug  also log each run's tool results and page traffic
//
// Part 1 measures what a model receives on every Act turn, system prompt and
// tool schemas, with lean mode off and on, for a Claude-class and a GPT-class
// provider at the Full tier: the agent's own prompt builder, the run loop's
// tool-list options, product default settings, and the repo's token estimate
// (Agent#_estimateAskStreamUsage, characters / 4).
//
// Part 2 replays three tasks through the Chrome build's real run loop
// (Agent#processMessage) once with Lean mode Off and once with Auto, which
// resolves to lean for the strong cloud model used here. Everything between
// the model and the page is the product's own code: planner intent gate,
// batch pipeline, permission and submit cards, every guard, text-write
// finalization, completion checks and done. The page side is real as well:
// each fixture page runs in headless Chromium (Playwright) with the Chrome
// build's content scripts injected into an isolated world, the agent's
// chrome.debugger commands go to a CDP session on that page, and its
// chrome.scripting probes run there. Requests are answered from the fixtures;
// nothing reaches the network. What a run cannot represent is listed under
// "Limits" in the generated doc.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOC = path.join(ROOT, 'docs/lean-mode-comparison.md');
const argv = new Set(process.argv.slice(2));
const CHECK = argv.has('--check');
const DEBUG = argv.has('--debug');
const debug = (...items) => { if (DEBUG) console.error(...items); };

// ── Extension APIs ─────────────────────────────────────────────────────────
// One stand-in object for chrome.*; while a replay runs, tabs, scripting,
// debugger and webNavigation go to its browser tab (BrowserTab below).
const TAB = 4100;
let tab = null;
function storageArea() {
  const items = new Map();
  return {
    items,
    async get(keys) {
      if (keys == null) return Object.fromEntries(items);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const defaults = keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
      return Object.fromEntries(list.map(key => [key, items.has(key) ? structuredClone(items.get(key)) : defaults[key]])
        .filter(([, value]) => value !== undefined));
    },
    async set(values) { for (const [key, value] of Object.entries(values || {})) items.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of [].concat(keys)) items.delete(key); },
    async clear() { items.clear(); },
  };
}
const local = storageArea();
const session = storageArea();
const event = () => ({ listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); }, hasListener(fn) { return this.listeners.has(fn); } });
const debuggerEvents = event();
const noTab = () => { throw new Error('No tab with id: ' + TAB); };
const api = {
  storage: { local, session, onChanged: event() },
  runtime: {
    id: 'lean-mode-comparison', lastError: undefined, onMessage: event(), onConnect: event(),
    getURL: value => `chrome-extension://lean-mode-comparison/${value}`,
    getManifest: () => ({ manifest_version: 3, version: '0.0.0' }),
    sendMessage: async () => undefined,
  },
  tabs: {
    get: async () => tab ? tab.tabInfo() : noTab(),
    query: async () => tab ? [await tab.tabInfo()] : [],
    sendMessage: async (_id, message) => tab ? tab.sendMessage(message) : noTab(),
    captureVisibleTab: async () => tab ? tab.capture() : noTab(),
    update: async () => tab ? tab.tabInfo() : noTab(),
    onUpdated: event(), onRemoved: event(), onActivated: event(),
  },
  windows: { get: async id => ({ id, focused: true, state: 'normal' }), getCurrent: async () => ({ id: 1, focused: true }) },
  webNavigation: {
    getAllFrames: async () => tab ? [tab.frameInfo()] : [],
    getFrame: async () => tab ? tab.frameInfo() : null,
    onCommitted: event(), onCompleted: event(), onHistoryStateUpdated: event(), onBeforeNavigate: event(),
  },
  scripting: { executeScript: async options => tab ? tab.executeScript(options) : noTab() },
  // chrome.debugger answers through callbacks and reports failures through
  // chrome.runtime.lastError, as Chrome's does.
  debugger: {
    attach(_target, _version, callback) { setTimeout(() => callback?.(), 0); },
    detach(_target, callback) { setTimeout(() => callback?.(), 0); },
    sendCommand(_target, method, params, callback) {
      const done = (result, error) => {
        api.runtime.lastError = error ? { message: error.message || String(error) } : undefined;
        try { callback?.(result); } finally { api.runtime.lastError = undefined; }
      };
      if (!tab) { setTimeout(() => done(undefined, new Error('No tab')), 0); return; }
      tab.cdp(method, params).then(result => done(result), error => done(undefined, error));
    },
    getTargets(callback) { setTimeout(() => callback?.([]), 0); },
    onEvent: debuggerEvents, onDetach: event(),
  },
  permissions: { contains: async () => true, request: async () => true },
  alarms: { create() {}, clear: async () => true, get: async () => null, onAlarm: event() },
  downloads: { onChanged: event(), search: async () => [] },
};
globalThis.chrome = api;
// The agent's own requests (Node's fetch) never leave the machine either.
const blockedRequests = [];
globalThis.fetch = async input => {
  const url = typeof input === 'string' ? input : String(input?.url || input);
  blockedRequests.push(url);
  throw new TypeError(`The comparison runs offline; no request to ${url}.`);
};

const builds = {};
for (const build of ['chrome', 'firefox']) {
  builds[build] = {
    Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
    tools: await import(`../src/${build}/src/agent/tools.js`),
    config: await import(`../src/${build}/src/config-transfer.js`),
    AnthropicProvider: (await import(`../src/${build}/src/providers/anthropic.js`)).AnthropicProvider,
    OpenAICompatibleProvider: (await import(`../src/${build}/src/providers/openai.js`)).OpenAICompatibleProvider,
  };
}
const { Agent } = builds.chrome;
const { fixtureFixedChoiceReply, fixtureControlEffectReading } = await import('../test/semantic-decision-stub.mjs');
// WebBrain's fixed-choice readings of page texts, answered by the repo's test
// oracle (test/semantic-decision-stub.mjs), the way a model reads them. One
// change: a caption that ends in an ellipsis, such as GitHub's "Commit
// changes...", may only open a dialog, so it reads as unclear rather than as
// a commit. That lets the Off run open GitHub's commit dialog as WebBrain
// intends (its reversible-launcher exemption), instead of stopping earlier.
const fixedChoiceAnswer = messages => fixtureFixedChoiceReply(messages, {
  control_effect: ({ item }) => (/(?:\.{3}|…)\s*$/u.test(String(item?.text || '')) ? 'unclear' : fixtureControlEffectReading(item?.text)),
});

// ── Part 1: what the model receives on every Act turn ──────────────────────
// Product defaults that change the Act prompt or tool list.
function applyDefaults(agent, config) {
  const defaults = config.DEFAULT_CONFIG_SETTINGS;
  agent.webMcpEnabled = defaults.webMcpEnabled === true;
  agent.researchEscalationEnabled = defaults.researchEscalationEnabled === true;
  agent.useSiteAdapters = defaults.useSiteAdapters !== false;
  agent.captchaSolverEnabled = defaults.captchaSolverEnabled === true;
  agent.leanMode = defaults.leanMode;
  agent.strictGuards = defaults.strictGuards === true;
}
async function surface(buildName, provider, setting) {
  const { Agent: BuildAgent, tools, config } = builds[buildName];
  const agent = new BuildAgent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  applyDefaults(agent, config);
  agent.leanMode = setting;
  const tabId = 1;
  agent._runModeOverrides.set(tabId, 'act');
  const lean = agent._beginLeanRun(tabId, 'act');
  const system = agent._buildSystemPrompt('act', tabId);
  const tier = provider.promptTier;
  const readWindow = agent._readWindowLimits(provider);
  // The run loop's own options (Agent#processMessage) on an ordinary page.
  const list = tools.getToolsForMode('act', { browserBatchEnabled: agent.browserBatchEnabled, lean: agent._leanRunActive(tabId),
    strictSecretMode: false, tier, imageGenConfigured: agent.imageGenConfigured, accessibilityTreeMaxChars: readWindow.treePageChars,
    webMcpAvailable: agent.webMcpEnabled === true, skillLoaderTool: agent._skillLoaderDefinition('act', tier),
    skillTools: agent._skillToolDefinitions(tabId, 'act', tier, null), otpEmailSkillActive: false, cloudRun: false, outputSchema: null,
    watchBeep: false, carouselNavigation: false, gmailResultCounting: false, researchEscalationEnabled: agent.researchEscalationEnabled });
  const estimate = (messages, toolList) => agent._estimateAskStreamUsage(messages, { tools: toolList }, '', '', []).prompt_tokens;
  return {
    build: buildName, model: provider.model, setting, lean: lean.active, reason: lean.reason,
    promptChars: system.length, promptTokens: estimate([{ role: 'system', content: system }], []),
    toolCount: list.length, toolChars: JSON.stringify(list).length, toolTokens: estimate([], list),
    toolNames: list.map(tool => tool.function.name),
  };
}
const surfaceRows = [];
for (const buildName of ['chrome', 'firefox']) {
  const { AnthropicProvider, OpenAICompatibleProvider } = builds[buildName];
  const providers = [
    new AnthropicProvider({ type: 'anthropic', category: 'cloud', model: 'claude-sonnet-4-5', apiKey: 'offline' }),
    new OpenAICompatibleProvider({ type: 'openai', category: 'cloud', model: 'gpt-5', apiKey: 'offline', baseUrl: 'https://api.openai.com/v1' }),
  ];
  for (const provider of providers) {
    for (const setting of ['off', 'auto']) surfaceRows.push(await surface(buildName, provider, setting));
  }
}

// ── Part 2: replays ─────────────────────────────────────────────────────────
const sha256 = text => createHash('sha256').update(String(text)).digest('hex');
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const WORLD = 'webbrain-content';
const extensionFile = file => fs.readFileSync(path.join(ROOT, 'src/chrome', file), 'utf8');
// The manifest's content scripts for an ordinary page (src/chrome/manifest.json),
// without the Ollama launch handoff, which acts only on a local Ollama page.
const MANIFEST = JSON.parse(extensionFile('manifest.json'));
const allUrls = MANIFEST.content_scripts.filter(entry => entry.matches.includes('<all_urls>'));
const scriptsFor = (world, runAt) => allUrls.filter(entry => (entry.world === 'MAIN') === (world === 'MAIN') && (entry.run_at || 'document_idle') === runAt)
  .flatMap(entry => entry.js).filter(file => file !== 'src/content/ollama-launch-handoff.js');
const runSources = (files, idle) => `(() => {
  const sources = ${JSON.stringify(files.map(file => [file, extensionFile(file)]))};
  const run = () => { for (const [name, source] of sources) {
    try { (0, eval)(source + '\\n//# sourceURL=' + name); }
    catch (error) { (globalThis.__wbHarnessErrors ||= []).push(name + ': ' + (error && error.message || error)); }
  } };
  ${idle ? "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true }); else run();" : 'run();'}
})();`;
// The extension runtime as a content script sees it: onMessage listeners,
// and sendMessage to the background through a CDP binding.
const ISOLATED_SHIM = `(() => {
  if (globalThis.__wbHarness) return;
  const handlers = [];
  const pending = new Map();
  let seq = 0;
  const bridge = globalThis.__wbHarnessBridge;
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const runtime = {
    id: 'lean-mode-comparison', lastError: undefined,
    getURL: value => 'chrome-extension://lean-mode-comparison/' + value,
    getManifest: () => ({ manifest_version: 3, version: '0.0.0' }),
    onMessage: { addListener(fn) { handlers.push(fn); }, removeListener(fn) { const at = handlers.indexOf(fn); if (at >= 0) handlers.splice(at, 1); }, hasListener: fn => handlers.includes(fn) },
    onConnect: event(),
    connect: () => ({ postMessage() {}, disconnect() {}, onMessage: event(), onDisconnect: event() }),
    sendMessage(message, callback) {
      const id = ++seq;
      const promise = new Promise(resolve => pending.set(id, resolve));
      try { bridge(JSON.stringify({ id, message })); } catch { pending.delete(id); }
      if (typeof callback === 'function') { promise.then(value => callback(value)); return undefined; }
      return promise;
    },
  };
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  globalThis.chrome = { runtime, storage: { local: area, session: area, onChanged: event() },
    i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
  globalThis.__wbHarness = {
    handlerCount: () => handlers.length,
    reply(id, value) { const resolve = pending.get(id); pending.delete(id); resolve && resolve(value); },
    dispatch(message) {
      return new Promise(resolve => {
        let settled = false, open = false;
        const respond = value => { if (!settled) { settled = true; resolve({ value }); } };
        for (const handler of handlers.slice()) {
          let result;
          try { result = handler(message, { id: 'lean-mode-comparison' }, respond); }
          catch (error) { respond({ __harnessError: String(error && error.message || error) }); }
          if (result === true) open = true;
          else if (result && typeof result.then === 'function') {
            open = true;
            result.then(value => { if (value !== undefined) respond(value); }, error => respond({ __harnessError: String(error && error.message || error) }));
          }
        }
        if (!open) respond(undefined);
      });
    },
  };
})();`;

let browser = null;
// One fixture page in Chromium, seen by the agent as tab TAB.
class BrowserTab {
  constructor(fixture) {
    this.fixture = fixture;
    this.frameId = '';
    this.documentNumber = 0;
    this.worldContext = null;
    this.title = '';
    this.traffic = [];
    this.requests = [];
    this.agent = null;
  }
  async open() {
    this.context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await this.context.setOffline(true);
    await this.context.route('**/*', route => {
      this.requests.push(`${route.request().method()} ${route.request().url()}`);
      return this.fixture.serve(route);
    });
    this.page = await this.context.newPage();
    this.harness = await this.context.newCDPSession(this.page);
    this.devtools = await this.context.newCDPSession(this.page);
    this.harness.on('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return;
      this.frameId = frame.id;
      this.documentNumber++;
      this.worldContext = null;
      this.title = '';
    });
    this.harness.on('Runtime.executionContextCreated', ({ context }) => {
      if (context.name === WORLD && context.auxData?.frameId === this.frameId) this.worldContext = context.id;
    });
    this.harness.on('Runtime.executionContextsCleared', () => { this.worldContext = null; });
    this.harness.on('Runtime.bindingCalled', item => { this.background(item).catch(error => debug('bridge error', error)); });
    // The agent's debugger connection reports what a chrome.debugger client
    // listens for.
    for (const name of ['Page.javascriptDialogOpening', 'Page.javascriptDialogClosed', 'Runtime.executionContextCreated',
      'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Page.frameNavigated', 'Page.loadEventFired']) {
      this.devtools.on(name, params => { for (const listener of debuggerEvents.listeners) listener({ tabId: TAB }, name, params); });
    }
    await this.harness.send('Page.enable');
    await this.harness.send('Runtime.enable');
    await this.harness.send('Runtime.addBinding', { name: '__wbHarnessBridge', executionContextName: WORLD });
    await this.harness.send('Page.addScriptToEvaluateOnNewDocument', { source: ISOLATED_SHIM + runSources(scriptsFor('ISOLATED', 'document_start'), false), worldName: WORLD });
    await this.harness.send('Page.addScriptToEvaluateOnNewDocument', { source: runSources(scriptsFor('MAIN', 'document_start'), false) });
    await this.harness.send('Page.addScriptToEvaluateOnNewDocument', { source: runSources(scriptsFor('ISOLATED', 'document_idle'), true), worldName: WORLD });
    await this.page.goto(this.fixture.url, { waitUntil: 'load' });
    if (!await this.contentReady()) throw new Error(`Content scripts did not start on ${this.fixture.url}: ${JSON.stringify(await this.errors())}`);
    const errors = await this.errors();
    if (errors.length) debug(`  content script errors on ${this.fixture.url}:`, errors);
  }
  async close() { await this.context?.close(); }
  note(kind, name) { this.traffic.push(`${kind}:${name}`); }
  documentId() { return `document-${this.documentNumber}`; }
  url() { return this.page.url(); }
  async tabInfo() {
    if (!this.title) { try { this.title = await this.page.title(); } catch {} }
    return { id: TAB, windowId: 1, index: 0, active: true, status: 'complete', url: this.url(), title: this.title };
  }
  frameInfo() {
    return { frameId: 0, parentFrameId: -1, documentId: this.documentId(), url: this.url(), frameType: 'outermost_frame', documentLifecycle: 'active' };
  }
  async errors() {
    if (!this.worldContext) return ['no content world'];
    const { result } = await this.harness.send('Runtime.evaluate', { contextId: this.worldContext, expression: 'globalThis.__wbHarnessErrors || []', returnByValue: true });
    return result?.value || [];
  }
  // The content scripts answer once content.js has registered its listener.
  async contentReady(timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.worldContext) {
        try {
          const { result } = await this.harness.send('Runtime.evaluate', { contextId: this.worldContext, returnByValue: true,
            expression: "document.readyState !== 'loading' && !!globalThis.__wbHarness && globalThis.__wbHarness.handlerCount() > 2 && typeof window.__generateAccessibilityTree === 'function'" });
          if (result?.value === true) return this.worldContext;
        } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return null;
  }
  async evaluate(contextId, expression) {
    const { result, exceptionDetails } = await this.harness.send('Runtime.evaluate', { ...(contextId ? { contextId } : {}), expression,
      awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'evaluation failed');
    return result?.value;
  }
  // chrome.tabs.sendMessage to the content scripts.
  async sendMessage(message) {
    this.note('content', message?.action || '?');
    const contextId = await this.contentReady(5000);
    if (!contextId) throw new Error('Could not establish connection. Receiving end does not exist.');
    let reply;
    try { reply = await this.evaluate(contextId, `globalThis.__wbHarness.dispatch(${JSON.stringify(message)})`); }
    catch (error) {
      if (/context|destroyed|Target closed|navigat/i.test(error.message)) throw new Error('The message port closed before a response was received.');
      throw error;
    }
    if (reply?.value?.__harnessError) throw new Error(reply.value.__harnessError);
    return reply?.value;
  }
  // chrome.scripting.executeScript in the isolated world or, with MAIN, the page's.
  async executeScript(options = {}) {
    const name = options.files ? `files(${options.files.length})` : (options.func?.name || 'anonymous');
    this.note('script', name);
    const contextId = options.world === 'MAIN' ? null : await this.contentReady(5000);
    if (options.world !== 'MAIN' && !contextId) throw new Error('Cannot access contents of the page.');
    if (options.files) {
      for (const file of options.files) await this.evaluate(contextId, `(0, eval)(${JSON.stringify(extensionFile(file))})`);
      return [{ frameId: 0, documentId: this.documentId(), result: null }];
    }
    let result = null;
    try { result = await this.evaluate(contextId, `(${options.func.toString()}).apply(null, ${JSON.stringify(options.args || [])})`); }
    catch (error) { debug(`  script ${name} failed: ${error.message.split('\n')[0]}`); }
    return [{ frameId: 0, documentId: this.documentId(), result: result ?? null }];
  }
  async cdp(method, params = {}) {
    this.note('cdp', method);
    return this.devtools.send(method, params);
  }
  async capture() {
    this.note('capture', 'tab');
    const { data } = await this.harness.send('Page.captureScreenshot', { format: 'png' });
    return `data:image/png;base64,${data}`;
  }
  // What the background answers a content script (background.js).
  async background({ name, payload, executionContextId }) {
    if (name !== '__wbHarnessBridge') return;
    const { id, message } = JSON.parse(payload);
    const url = this.url();
    const sender = { id: 'lean-mode-comparison', tab: { id: TAB, url }, frameId: 0, documentId: this.documentId(), url, origin: new URL(url).origin };
    let reply;
    if (message?.action === 'get_page_monitor_state') reply = this.agent?.pageMonitorState(sender, message.documentToken, message.frameName);
    else if (message?.action === 'page_feedback') reply = this.agent?.observePageFeedback(sender, message.feedback);
    else if (message?.action === 'get_recording_state') reply = { state: { active: false } };
    this.note('background', message?.action || '?');
    try {
      await this.harness.send('Runtime.evaluate', { contextId: executionContextId,
        expression: `globalThis.__wbHarness.reply(${id}, ${reply === undefined ? 'undefined' : JSON.stringify(reply)})` });
    } catch { /* the document is gone */ }
  }
}

// ── Fixture pages ──────────────────────────────────────────────────────────
const page = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui,sans-serif;margin:24px;max-width:960px}label{display:block;margin:12px 0}input,textarea{font:inherit;padding:6px;width:420px}
button{font:inherit;padding:6px 14px;margin:8px 8px 8px 0}.cm-content{border:1px solid #888;min-height:180px;padding:8px;white-space:pre-wrap;font-family:monospace;outline:none}
.cm-line{min-height:1.2em}dialog{padding:16px}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
const html = body => ({ status: 200, contentType: 'text/html; charset=utf-8', body });

// 1. GitHub's file editor. Its CodeMirror editor owns its DOM: one block per
// line, a <br> in an empty line. The browser's innerText of such a document
// shows every blank line twice; WebBrain reads CodeMirror's lines instead
// (readCodeMirrorText), so an exact document reads back exactly.
// "Commit changes..." opens the commit dialog; its "Commit changes" posts the
// document.
const POST = [
  'Release notes for the spring build',
  '',
  'The sync engine now retries failed uploads on its own.',
  '',
  'Thanks to everyone who tested the beta.',
  '',
].join('\n');
const CODEMIRROR = String.raw`
(() => {
  const root = document.querySelector('.cm-content');
  let doc = root.dataset.initial || '';
  const render = caret => {
    root.replaceChildren(...doc.split('\n').map(text => {
      const line = document.createElement('div');
      line.className = 'cm-line';
      if (text) line.textContent = text; else line.appendChild(document.createElement('br'));
      return line;
    }));
    if (caret == null) return;
    let rest = caret, index = 0;
    const lines = doc.split('\n');
    while (index < lines.length - 1 && rest > lines[index].length) { rest -= lines[index].length + 1; index++; }
    const line = root.children[index];
    const node = line.firstChild && line.firstChild.nodeType === 3 ? line.firstChild : line;
    const selection = getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(node, node === line ? 0 : Math.min(rest, node.length));
    selection.addRange(range);
  };
  const offset = (node, at) => {
    const lines = [...root.children];
    if (node === root) return Math.min(lines.slice(0, at).reduce((sum, line) => sum + line.textContent.length + 1, 0), doc.length);
    const line = (node.nodeType === 1 && node.classList.contains('cm-line')) ? node : node.parentElement.closest('.cm-line');
    let position = lines.slice(0, lines.indexOf(line)).reduce((sum, item) => sum + item.textContent.length + 1, 0);
    const range = document.createRange();
    range.setStart(line, 0);
    range.setEnd(node, at);
    return Math.min(position + range.toString().length, doc.length);
  };
  root.addEventListener('beforeinput', event => {
    event.preventDefault();
    const selection = getSelection();
    let start = doc.length, end = doc.length;
    if (selection.rangeCount && root.contains(selection.getRangeAt(0).startContainer)) {
      const range = selection.getRangeAt(0);
      start = offset(range.startContainer, range.startOffset);
      end = offset(range.endContainer, range.endOffset);
    }
    const type = event.inputType;
    let text = '';
    if (type.startsWith('insert')) {
      text = type === 'insertParagraph' || type === 'insertLineBreak' ? '\n'
        : (event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
    } else if (type.startsWith('delete') && start === end) {
      if (type.endsWith('Backward')) start = Math.max(0, start - 1); else end = Math.min(doc.length, end + 1);
    }
    doc = doc.slice(0, start) + text.replace(/\r\n?/g, '\n') + doc.slice(end);
    render(start + text.length);
    root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: type, data: event.data }));
  });
  window.__cmDocument = () => doc;
  document.getElementById('edit-form').addEventListener('submit', event => event.preventDefault());
  document.getElementById('commit-open').addEventListener('click', () => document.getElementById('commit-dialog').showModal());
  document.getElementById('commit-cancel').addEventListener('click', () => document.getElementById('commit-dialog').close());
  document.getElementById('commit-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const response = await fetch(event.target.action, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: form.get('message'), description: form.get('description'), value: doc }) });
    const { location: next } = await response.json();
    location.assign(next);
  });
  render(null);
})();`;
class GithubEditorFixture {
  constructor() {
    this.url = 'https://github.com/owned/lean-fixture/edit/main/NOTES.md';
    this.blobUrl = 'https://github.com/owned/lean-fixture/blob/main/NOTES.md';
    this.saveUrl = 'https://github.com/owned/lean-fixture/tree-save/main/NOTES.md';
    this.file = 'Old notes\n';
    this.commits = [];
  }
  editPage() {
    // GitHub's launcher sits in the editor's form, as in the probe's own
    // fixtures (test/submit-probe-readings.mjs); the dialog commits with fetch
    // and then opens the file, as GitHub's file editor does.
    return page('Editing lean-fixture/NOTES.md at main', `
<header><a href="/owned/lean-fixture">owned / lean-fixture</a></header>
<main>
  <h1>Editing lean-fixture/NOTES.md</h1>
  <form id="edit-form">
    <div class="cm-editor"><div class="cm-scroller">
      <div class="cm-content" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Editing NOTES.md file contents"
        spellcheck="false" data-initial="${escapeHtml(this.file.replace(/\n$/, ''))}"></div>
    </div></div>
    <button type="button" id="commit-open">Commit changes...</button>
  </form>
  <dialog id="commit-dialog" aria-labelledby="commit-title">
    <form id="commit-form" method="post" action="/owned/lean-fixture/tree-save/main/NOTES.md">
      <h2 id="commit-title">Commit changes</h2>
      <label for="commit-message-input">Commit message</label>
      <input id="commit-message-input" name="message" value="Update NOTES.md">
      <label for="commit-description-input">Extended description</label>
      <textarea id="commit-description-input" name="description" placeholder="Add an optional extended description"></textarea>
      <label><input type="radio" name="commit-choice" value="direct" checked> Commit directly to the main branch</label>
      <button type="button" id="commit-cancel">Cancel</button>
      <button type="submit" id="commit-submit">Commit changes</button>
    </form>
  </dialog>
</main>`, CODEMIRROR);
  }
  blobPage() {
    return page('lean-fixture/NOTES.md at main', `
<header><a href="/owned/lean-fixture">owned / lean-fixture</a></header>
<main>
  <h1>lean-fixture / NOTES.md</h1>
  <p>Latest commit: <a href="/owned/lean-fixture/commit/${sha256(this.file).slice(0, 7)}">Update NOTES.md</a></p>
  <section aria-label="File contents"><pre>${escapeHtml(this.file)}</pre></section>
  <a href="/owned/lean-fixture/edit/main/NOTES.md">Edit this file</a>
</main>`);
  }
  async serve(route) {
    const request = route.request();
    const url = request.url();
    if (url === this.url && request.method() === 'GET') return route.fulfill(html(this.editPage()));
    if (url === this.saveUrl && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      this.file = String(body.value ?? '');
      this.commits.push({ message: body.message, value: this.file });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ location: this.blobUrl }) });
    }
    if (url === this.blobUrl && request.method() === 'GET') return route.fulfill(html(this.blobPage()));
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not part of the fixture.' });
  }
  outcome() {
    if (!this.commits.length) return { done: false, note: 'nothing committed' };
    const exact = this.commits.length === 1 && this.commits[0].value === POST;
    return { done: exact, note: exact ? 'committed once, file text exact'
      : `${this.commits.length} commit(s), last file text ${this.commits.at(-1).value === POST ? 'exact' : 'different'}` };
  }
}

// 2. A contact form that posts with fetch and shows a confirmation in place.
class ContactFormFixture {
  constructor() {
    this.url = 'https://forms.example.test/contact';
    this.submissions = [];
    this.want = { name: 'Ada Lovelace', email: 'ada@example.com', message: 'Please call me back about my order.' };
  }
  async serve(route) {
    const request = route.request();
    if (request.url() === this.url && request.method() === 'GET') {
      return route.fulfill(html(page('Contact us', `
<main><h1>Contact us</h1>
<form id="contact" aria-label="Contact">
  <label>Name <input name="name" required autocomplete="name"></label>
  <label>Email <input name="email" type="email" required autocomplete="email"></label>
  <label>Message <textarea name="message" required rows="4"></textarea></label>
  <button type="submit">Send</button>
</form><p id="result" role="status"></p></main>`, `
document.getElementById('contact').addEventListener('submit', async event => {
  event.preventDefault();
  await fetch('/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
  event.target.remove();
  document.getElementById('result').textContent = 'Thanks, we received your message.';
});`)));
    }
    if (request.url() === 'https://forms.example.test/contact' && request.method() === 'POST') {
      this.submissions.push(JSON.parse(request.postData() || '{}'));
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not part of the fixture.' });
  }
  outcome() {
    const done = this.submissions.length === 1 && JSON.stringify(this.submissions[0]) === JSON.stringify(this.want);
    return { done, note: !this.submissions.length ? 'not sent' : done ? 'sent once with the requested values' : `${this.submissions.length} submission(s)` };
  }
}

// 3. A product page for a read-only question.
class ProductFixture {
  constructor() { this.url = 'https://shop.example.test/products/trail-runner-2'; }
  async serve(route) {
    if (route.request().url() === this.url) {
      return route.fulfill(html(page('Trail Runner 2 | Example Shop', `
<main><h1>Trail Runner 2</h1><p>Lightweight trail shoe with a rock plate.</p>
<p>Price: <strong>$129.00</strong></p><p>In stock: ships in 2 days</p><button type="button">Add to cart</button></main>`)));
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not part of the fixture.' });
  }
  outcome(answer) {
    const done = /\$129\.00/.test(String(answer || ''));
    return { done, note: done ? 'answered $129.00' : 'no price in the answer' };
  }
}

// ── Scripts ─────────────────────────────────────────────────────────────────
// A step names its target the way a model does: by role and name from its
// latest page observation, resolved to that observation's ref.
const step = (name, args = {}, target = null) => ({ name, args, target });
const SCENARIOS = [
  {
    id: 'github-codemirror-commit',
    title: 'GitHub file edit: multi-paragraph text into CodeMirror, then commit',
    short: 'GitHub edit + commit',
    about: 'The case that motivated lean mode. The task replaces NOTES.md with a three-paragraph text and commits it. `set_field` types it into the CodeMirror editor with trusted input. The browser\'s `innerText` shows each blank line twice, but WebBrain reads CodeMirror\'s lines, so the text verifies. "Commit changes..." opens the commit dialog, whose "Commit changes" commits. The fixture serves no raw file, so the check of the committed file after the commit cannot read it back.',
    task: `Replace the whole content of NOTES.md in this GitHub editor with the text below, then commit it to main with GitHub's default commit message.\n\n${POST}`,
    fixture: () => new GithubEditorFixture(),
    plan: { site_job: 'edit-file-and-commit', requires_state_change: true, requires_submission: true,
      deliverables: ['NOTES.md committed with the given text'], summary: 'Replace NOTES.md and commit it.' },
    script: [
      step('get_accessibility_tree', { filter: 'interactive' }),
      step('set_field', { text: POST }, { role: 'textbox', name: 'Editing NOTES.md file contents' }),
      step('click_ax', {}, { role: 'button', name: 'Commit changes...' }),
      step('get_accessibility_tree', { filter: 'interactive' }),
      step('click_ax', {}, { role: 'button', name: 'Commit changes' }),
      step('get_accessibility_tree', { filter: 'visible' }),
      step('done', { summary: 'NOTES.md now holds the new release notes, committed to main.', outcome: 'success' }),
    ],
  },
  {
    id: 'contact-form',
    title: 'Fill a simple form and submit it',
    short: 'Contact form',
    about: 'Three fields and a Send button on a plain page; the page posts with fetch and shows "Thanks, we received your message." in place.',
    task: 'Fill in the contact form on this page with name Ada Lovelace, email ada@example.com and the message "Please call me back about my order.", then send it.',
    fixture: () => new ContactFormFixture(),
    plan: { site_job: null, requires_state_change: true, requires_submission: true,
      deliverables: ['The contact form is sent with the given values'], summary: 'Fill and send the contact form.' },
    script: [
      step('get_accessibility_tree', { filter: 'interactive' }),
      step('set_field', { text: 'Ada Lovelace' }, { role: 'textbox', name: 'Name' }),
      step('set_field', { text: 'ada@example.com' }, { role: 'textbox', name: 'Email' }),
      step('set_field', { text: 'Please call me back about my order.' }, { role: 'textbox', name: 'Message' }),
      step('click_ax', {}, { role: 'button', name: 'Send' }),
      step('get_accessibility_tree', { filter: 'visible' }),
      step('done', { summary: 'The contact form was sent; the page says "Thanks, we received your message."', outcome: 'success' }),
    ],
  },
  {
    id: 'read-only-lookup',
    title: 'Read-only lookup on the current page',
    short: 'Read-only lookup',
    about: 'A question about the open product page: what does the Trail Runner 2 cost? The answer is in the page text.',
    task: 'What does the Trail Runner 2 cost on this page?',
    fixture: () => new ProductFixture(),
    plan: { site_job: null, requires_state_change: false, requires_submission: false,
      deliverables: ['The price of the Trail Runner 2'], summary: 'Read the price from the page.' },
    script: [
      step('read_page', {}),
      step('done', { summary: 'The Trail Runner 2 costs $129.00.', outcome: 'success' }),
    ],
  },
];

// The planner intent gate's answer: what a model reads from these tasks.
function plannerIntent(scenario) {
  return JSON.stringify({
    request_kind: 'execute', scope_relation: 'new', deliverables: scenario.plan.deliverables, expected_items: null,
    site_job: scenario.plan.site_job, conditional_site_job: null,
    requires_state_change: scenario.plan.requires_state_change, requires_submission: scenario.plan.requires_submission,
    messaging: null, completion_requirements: { download: false }, allows_planner_shaped_result: false,
    allows_app_state_tool_evidence: false, read_scope: 'visible_page', summary: scenario.plan.summary, confidence: 0.95,
    steps: [{ id: '1', action: scenario.plan.summary }], skill_ids: [],
    memory: { use_scratchpad: false, scratchpad_notes: [], use_progress_ledger: false, progress_action: null },
    scheduling: null, risks: [], response_language: { framing_locale: 'en', deliverable_locales: ['en'], preserve_source_text: false },
  });
}

// The latest accessibility tree the model received.
function latestTree(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'tool') continue;
    const text = String(message.content || '');
    const start = text.indexOf('{"pageContent"');
    if (start < 0) continue;
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try { return JSON.parse(text.slice(start, end + 1)).pageContent || ''; } catch {}
    }
  }
  return '';
}
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function refFor(messages, target) {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegex(target.role)} "${escapeRegex(target.name)}"[^\\n]*?\\[(ref_\\d+)\\]`, 'm');
  return latestTree(messages).match(pattern)?.[1] || 'ref_unknown';
}

const STRONG_MODEL = 'claude-sonnet-4-5';
async function replay(scenario, setting) {
  const fixture = scenario.fixture();
  for (const area of [local, session]) await area.clear();
  tab = new BrowserTab(fixture);
  await tab.open();
  const requests = [];
  const sideCalls = [];
  const cards = [];
  let cursor = 0;
  let agent = null;
  const provider = {
    name: 'anthropic', model: STRONG_MODEL, type: 'anthropic', category: 'cloud', promptTier: 'full',
    config: { category: 'cloud', type: 'anthropic', model: STRONG_MODEL, _providerId: 'anthropic' },
    contextWindow: 200000, supportsTools: true, supportsVision: false,
    async chat(messages, options = {}) {
      const generation = options.comparisonGeneration || 'unnamed';
      if (generation !== 'main') {
        sideCalls.push(generation);
        if (generation === 'planner_intent') return { content: plannerIntent(scenario) };
        if (generation === 'intent') {
          return { content: JSON.stringify({ mode: scenario.plan.requires_state_change ? 'inactive' : 'read_only', allowedActions: [],
            forbiddenActions: [], targets: [], excludedTargets: [], workflowFields: [], workflowRequiredLabels: [], confidence: 0.9,
            pageScopePolicy: 'none', reason: 'One task on one page.' }) };
        }
        if (generation.startsWith('semantic_')) return { content: fixedChoiceAnswer(messages) || JSON.stringify({ choice: '', evidence: '' }) };
        // The stand-in completion judge is never wrong: it answers from the
        // fixture's true end state.
        if (generation === 'completion_verification') {
          const done = fixture.outcome(scenario.lastSummary).done === true;
          return { content: JSON.stringify({ outcome: done ? 'succeeded' : 'pending', later: 'not_asked', summary: 'result',
            reason: done ? 'The resulting page shows the requested result.' : 'The resulting page does not show the requested result.' }) };
        }
        debug(`  unexpected side call ${generation}`);
        return { content: '{}' };
      }
      const offered = (options.tools || []).map(tool => tool.function.name);
      requests.push({ system: String(messages[0]?.content || ''), offered, choice: options.toolChoice ?? null,
        tokens: agent._estimateAskStreamUsage(messages, { tools: options.tools || [] }, '', '', []).prompt_tokens });
      // The model follows its script. When WebBrain narrows the tool list (a
      // forced turn), it complies: it reads the page if it may, or calls done,
      // without using up its next step. After its last step it repeats done,
      // as a model that considers the task finished does.
      let next = scenario.script[Math.min(cursor, scenario.script.length - 1)];
      if (!offered.includes(next.name)) {
        const fallback = ['get_accessibility_tree', 'read_page', 'done'].find(name => offered.includes(name));
        next = fallback === 'done' ? scenario.script.at(-1) : step(fallback, { filter: 'visible' });
      } else if (cursor < scenario.script.length) cursor++;
      const args = next.target ? { ...next.args, ref_id: refFor(messages, next.target) } : next.args;
      if (next.name === 'done') scenario.lastSummary = args.summary;
      return { toolCalls: [{ id: `call_${requests.length}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(args) } }] };
    },
  };
  agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  applyDefaults(agent, builds.chrome.config);
  // The only setting that differs between the two runs of a task.
  agent.leanMode = setting;
  // Plan before act: Off. The intent gate still runs; the planner's plan and
  // review steps are not part of lean mode and cost the same in both modes.
  agent.setPlanBeforeActMode('off');
  agent.maxSteps = 20;
  // No persistence or tracing. The run still gets its task token, which the
  // real _startTraceRun mints before tracing starts: verified editor proofs
  // are scoped to it, so without one no GitHub commit could ever bind.
  Object.assign(agent, { _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => ({ ok: true }),
    _startTraceRun: async tabId => { agent._taskTokens.set(tabId, `task_comparison_${scenario.id}_${setting}`); return null; },
    _endTraceRun: async () => {} });
  tab.agent = agent;
  const realChat = agent._chatWithCostAllowance.bind(agent);
  agent._chatWithCostAllowance = (usedProvider, messages, options, costState, requestContext) => realChat(usedProvider, messages,
    { ...options, comparisonGeneration: requestContext?.generationName || 'unnamed' }, costState, requestContext);
  const onUpdate = (type, data) => {
    if (type !== 'clarify' || !data?.clarifyId) return;
    const kind = data.promptKind || 'clarify';
    cards.push(kind);
    debug(`  card ${kind}: ${JSON.stringify(data.permission || data.submitConfirmation?.tool || data.question || '').slice(0, 160)}`);
    // The user allows what WebBrain asks for: a site permission for good
    // where the card offers that, a submit once.
    const options = Array.isArray(data.options) ? data.options : [];
    const answer = ['always', 'once', 'allow', 'yes'].find(option => options.includes(option)) || options[0] || 'yes';
    setTimeout(() => agent.submitClarifyResponse(TAB, data.clarifyId, answer, 'user'), 0);
  };
  let ended = null;
  const answer = await agent.processMessage(TAB, scenario.task, onUpdate, 'act', [], {
    detachedRequestId: `lean-comparison-${scenario.id}-${setting}`,
    onRunFinished: (status, details) => { ended = { status, ...(details || {}) }; },
  });
  const messages = agent.conversations.get(TAB) || [];
  const run = { scenario, setting, answer, ended, requests, sideCalls, cards, messages, traffic: tab.traffic, outcome: fixture.outcome(answer),
    pageRequests: tab.requests, fixture };
  await tab.close();
  tab = null;
  return run;
}

// ── Measures ────────────────────────────────────────────────────────────────
function parseToolResult(message) {
  const text = String(message?.content || '');
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let cursor = start; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, cursor + 1)); } catch { break; }
      }
    }
  }
  return null;
}
const isRefusal = result => !!result && (result.blockedDone === true || result.denied === true
  || (result.success === false && (result.noDispatch === true || result.dispatched === false || result.blocked === true)));
// The first sentence of a refusal, without WebBrain's bracketed framing.
const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, text.lastIndexOf(' ', limit)).replace(/[\s,;:]+$/, '')}…`);
const firstSentence = text => clip(String(text || 'refused').replace(/^\[([A-Z][A-Z ]+):\s*/, (_, label) => `${label.toLowerCase()}: `)
  .split(/(?<=[.!?])\s|\n/)[0].replace(/[.:]$/, ''), 120);
const tally = list => Object.entries(list.reduce((map, name) => ({ ...map, [name]: (map[name] || 0) + 1 }), {}))
  .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
function measure(run) {
  // Each tool call with what WebBrain did with it.
  const timeline = [];
  for (const message of run.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const result = parseToolResult(run.messages.find(item => item.role === 'tool' && item.tool_call_id === call.id));
      const notes = Array.isArray(result?.guardAdvisories) ? result.guardAdvisories.map(item => item.guard) : [];
      timeline.push({ tool: call.function.name, refused: isRefusal(result), why: isRefusal(result) ? firstSentence(result.error || result.reason) : '', notes });
    }
  }
  const caveat = /WebBrain could not verify everything/.test(String(run.answer || ''));
  const side = run.sideCalls.filter(name => !/^planner/.test(name));
  return {
    lean: run.ended?.leanMode === true,
    turns: run.requests.length,
    forcedTurns: run.requests.filter(request => request.choice && request.choice !== 'auto').length,
    toolCalls: timeline.length,
    refusals: timeline.filter(item => item.refused).length,
    notes: timeline.reduce((sum, item) => sum + item.notes.length, 0),
    caveat,
    sideCalls: side.length,
    sideWhat: tally(side.map(name => name.replace(/^semantic_/, 'reading: '))),
    plannerCalls: run.sideCalls.length - side.length,
    cards: run.cards.length,
    cardWhat: tally(run.cards.map(kind => ({ permission: 'site permission', submitConfirmation: 'submit confirmation' }[kind] || kind))),
    pageProbes: run.traffic.filter(item => !item.startsWith('background:')).length,
    inputTokens: run.requests.reduce((sum, request) => sum + request.tokens, 0),
    firstPromptChars: run.requests[0]?.system.length || 0,
    toolsOffered: run.requests[0]?.offered.length || 0,
    pageDone: run.outcome.done,
    pageNote: run.outcome.note,
    status: run.ended?.status || 'unknown',
    success: run.outcome.done && run.ended?.status === 'done' && !caveat,
    timeline,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────
const { chromium } = await import('playwright');
// No request leaves the machine: every name fails to resolve, the context is
// offline, and the fixtures answer every request they route.
browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
const runs = [];
try {
  for (const scenario of SCENARIOS) {
    for (const setting of ['off', 'auto']) {
      const run = await replay(scenario, setting);
      run.measure = measure(run);
      runs.push(run);
      if (DEBUG) {
        console.error(`\n=== ${scenario.id} / lean ${setting} (resolved lean: ${run.ended?.leanMode})`);
        console.error('answer:', JSON.stringify(run.answer));
        console.error('side calls:', run.sideCalls.join(', '), '| cards:', run.cards.join(', '));
        console.error('traffic:', run.traffic.join(' '));
        for (const message of run.messages) {
          if (message.role === 'tool') console.error('  <-', String(message.content).replace(/\s+/g, ' ').slice(0, 600));
          else if (message.role === 'assistant') console.error('  ->', message.tool_calls?.map(item => `${item.function.name} ${item.function.arguments}`.slice(0, 160)).join(' | ') || JSON.stringify(message.content).slice(0, 200));
        }
        console.error('page requests:', run.pageRequests.join(' | '));
        console.error('blocked agent requests so far:', blockedRequests.join(' | ') || 'none');
        if (run.fixture.commits) console.error('commits:', JSON.stringify(run.fixture.commits));
        console.error('measure:', JSON.stringify(run.measure));
      }
    }
  }
} finally {
  await browser.close();
}
if (argv.has('--json')) {
  console.log(JSON.stringify({ surface: surfaceRows.map(({ toolNames, ...row }) => row),
    replays: runs.map(run => ({ id: run.scenario.id, setting: run.setting, ...run.measure })) }, null, 2));
  process.exit(0);
}

// ── Report ──────────────────────────────────────────────────────────────────
const number = value => Number(value).toLocaleString('en-US');
const thousands = value => `≈${number(Math.round(value / 1000))}k`;
const percentLess = (lean, full) => `${Math.round((1 - lean / full) * 100)}%`;
const modeLabel = setting => (setting === 'off' ? 'Off' : 'Auto → lean');
const table = (head, rows, align = []) => [
  `| ${head.join(' | ')} |`,
  `| ${head.map((_, index) => (align[index] === 'r' ? '---:' : '---')).join(' | ')} |`,
  ...rows.map(row => `| ${row.join(' | ')} |`),
].join('\n');

// Providers that receive the same prompt and tools share a row.
const sizeKey = row => [row.build, row.lean, row.promptChars, row.toolCount, row.toolChars].join('|');
const surfaceGroups = [...surfaceRows.reduce((groups, row) => {
  const group = groups.get(sizeKey(row));
  if (group) group.models.push(row.model); else groups.set(sizeKey(row), { ...row, models: [row.model] });
  return groups;
}, new Map()).values()];
const surfaceTable = table(['Build', 'Provider model', 'Lean mode', 'System prompt', 'Tools', 'Tool schemas', 'Per turn'],
  surfaceGroups.map(row => [row.build === 'chrome' ? 'Chrome' : 'Firefox',
    row.models.map(model => `\`${model}\``).join(', '), row.lean ? `Auto → lean (${row.reason})` : 'Off',
    `${number(row.promptChars)} chars, ≈${number(row.promptTokens)} tokens`, String(row.toolCount),
    `${number(row.toolChars)} chars, ≈${number(row.toolTokens)} tokens`, `≈${number(row.promptTokens + row.toolTokens)} tokens`]),
  ['', '', '', 'r', 'r', 'r', 'r']);
const surfaceOf = (build, lean) => surfaceRows.find(row => row.build === build && row.model === 'claude-sonnet-4-5' && row.lean === lean);
const leanNames = surfaceOf('chrome', true).toolNames;
const fullOnly = surfaceOf('chrome', false).toolNames.filter(name => !leanNames.includes(name));
const perTurn = row => row.promptTokens + row.toolTokens;

const resultText = item => item.success ? 'success'
  : item.pageDone ? (item.caveat ? 'done, answer carries a caveat' : `ended ${item.status}`)
  : item.status === 'done' ? (item.caveat ? 'task not done; done accepted with a caveat' : 'task not done; reported done') : `task not done; ended ${item.status}`;
const summaryTable = table(['Task', 'Lean mode', 'Model turns', 'Tool calls', 'Refused', 'Notes', 'Caveat', 'LLM side calls', 'Cards', 'Page probes', 'Input tokens', 'On the page', 'Result'],
  runs.map(run => {
    const item = run.measure;
    return [run.scenario.short, modeLabel(run.setting), String(item.turns), String(item.toolCalls), String(item.refusals),
      String(item.notes), item.caveat ? 'yes' : 'no', String(item.sideCalls), String(item.cards), String(item.pageProbes),
      thousands(item.inputTokens), item.pageNote, resultText(item)];
  }), ['', '', 'r', 'r', 'r', 'r', '', 'r', 'r', 'r', 'r', '', '']);

const timelineText = item => item.timeline.map(call => {
  if (call.refused) return `\`${call.tool}\` **refused** (${call.why})`;
  if (call.notes.length) return `\`${call.tool}\` (note: ${call.notes.join(', ')})`;
  return `\`${call.tool}\``;
}).join(' → ');
const details = SCENARIOS.map((scenario, index) => {
  const [off, lean] = ['off', 'auto'].map(setting => runs.find(run => run.scenario === scenario && run.setting === setting).measure);
  return [
    `### ${index + 1}. ${scenario.title}`,
    '',
    scenario.about,
    '',
    `- **Off:** ${timelineText(off)}${off.caveat ? '; the final answer carries "WebBrain could not verify everything"' : ''}.`,
    `- **Auto → lean:** ${timelineText(lean)}${lean.caveat ? '; the final answer carries "WebBrain could not verify everything"' : ''}.`,
    `- **LLM side calls** (besides the planner's intent call, ${off.plannerCalls} in each mode): Off ${off.sideCalls}${off.sideWhat ? ` (${off.sideWhat})` : ''}; lean ${lean.sideCalls}${lean.sideWhat ? ` (${lean.sideWhat})` : ''}.`,
    `- **Cards shown to the user:** Off ${off.cardWhat || 'none'}; lean ${lean.cardWhat || 'none'}.`,
    `- **Model input:** Off ${number(off.inputTokens)} tokens over ${off.turns} turns (${off.toolsOffered} tools offered, a ${number(off.firstPromptChars)}-character system prompt); lean ${number(lean.inputTokens)} tokens over ${lean.turns} turns (${lean.toolsOffered} tools, ${number(lean.firstPromptChars)} characters).`,
  ].join('\n');
}).join('\n\n');

const chrome = { full: surfaceOf('chrome', false), lean: surfaceOf('chrome', true) };
const firefox = { full: surfaceOf('firefox', false), lean: surfaceOf('firefox', true) };
const doc = `# Lean mode comparison

Generated by \`node scripts/lean-mode-comparison.mjs\`; do not edit by hand. The script is offline and deterministic: it uses no network, no model and no API key. Run it again after changing prompts, tools or guards (\`--check\` exits 1 when this file is out of date, \`--json\` prints the raw numbers). What lean mode is and what it skips: [lean-mode.md](lean-mode.md).

## 1. What the model receives on every Act turn

The system prompt and tool schemas a model receives on each Act turn, with product default settings at the Full tier, for a Claude-class and a GPT-class cloud provider. Tokens use the repo's estimate, characters / 4 (\`Agent#_estimateAskStreamUsage\`). Providers that receive the same prompt and tools share a row.

${surfaceTable}

Lean mode cuts this fixed per-turn input by ${percentLess(perTurn(chrome.lean), perTurn(chrome.full))} in the Chrome build (≈${number(perTurn(chrome.full))} → ≈${number(perTurn(chrome.lean))} tokens) and by ${percentLess(perTurn(firefox.lean), perTurn(firefox.full))} in the Firefox build. Tool schemas are unchanged; lean mode offers fewer of them.

The lean Act tools (${leanNames.length}): ${leanNames.map(name => `\`${name}\``).join(', ')}. \`generate_image\`, \`carousel_navigate\`, \`gmail_count_results\` and enabled skills' tools are added when they apply, as in a full run.

Offered only without lean mode (${fullOnly.length}): ${fullOnly.map(name => `\`${name}\``).join(', ')}.

## 2. Scripted replays

Each task runs twice through the Chrome build's real run loop (\`Agent#processMessage\`): once with Lean mode **Off** and once with **Auto**, which resolves to lean mode for the strong cloud model used here (\`${STRONG_MODEL}\`). Everything between the model and the page is the product's code: the planner's intent gate, the batch pipeline, permission and submit cards, every guard, text-write finalization, completion checks and \`done\`. The pages are real too: each fixture page runs in headless Chromium with the Chrome build's content scripts in an isolated world, the agent's \`chrome.debugger\` commands go to a DevTools session on that page, and its \`chrome.scripting\` probes run there. The fixtures answer every request; nothing reaches the network.

The model is a fixed script: it reads the page, acts on the targets it names by role and name (resolved to the refs of its latest page read), reads the page again and calls \`done\`. The user approves every card WebBrain shows.

- **Model turns:** requests to the model with tools. **Refused:** tool calls and \`done\` calls WebBrain did not carry out. **Notes:** guard notes on tool results. **Caveat:** the final answer carries "WebBrain could not verify everything".
- **LLM side calls:** model calls WebBrain makes on its own (readings, classifiers, the completion judge), not counting the planner's intent call, which runs once in each mode.
- **Cards:** site-permission and submit-confirmation cards WebBrain showed the user. These are permission gates, so lean mode keeps them.
- **Page probes:** content-script messages, injected scripts, DevTools commands and screenshots, including the ones that carry out the actions.
- **Input tokens:** the estimated input of all model turns of the run (system prompt, conversation and tool schemas).
- **On the page:** what the fixture recorded. **Result:** success means the page shows the task done and the answer has no caveat.

${summaryTable}

${details}

## Limits

- **A script is not a live model.** The scripted model does not react to what WebBrain tells it: after a refusal it carries on with its script, and when it has nothing left it repeats \`done\`. A live model reads each refusal and note and spends more turns on them: reading the page again, re-checking a field, asking. So the Off columns show WebBrain's own overhead, not what a live model would spend there.
- **The model's other answers are stand-ins.** The planner's intent, the workflow-field classifier and WebBrain's fixed-choice readings of page texts are answered the way the repo's tests answer them (\`test/semantic-decision-stub.mjs\`); a caption that ends in an ellipsis is read as unclear, so the Off run can open GitHub's commit dialog. The completion judge's stand-in answers from the fixture's true end state, so it is never wrong; a real judge can be.
- **Settings:** product defaults, except Plan before act (Off, so only the intent gate runs; the planner is not part of lean mode and costs the same in both modes), no vision, so no screenshots reach the model, a 20-step limit (no run comes near it), and no conversation storage or tracing. Strict checks are off; lean mode ignores them anyway.
- **Fixtures are small stand-ins.** The CodeMirror editor is a minimal one that, like GitHub's, owns its DOM and renders blank lines as \`<br>\` lines, so the browser's \`innerText\` shows each blank line twice; it is not GitHub's editor. It serves no raw file, so the check of the committed file after the commit cannot read it back. Real pages are larger, slower and change while a run reads them.
- **Chrome only.** The replays run the Chrome build; the Firefox build is measured only in part 1.
- **This branch only.** The Off columns show this branch's guards; a change to them (a card instead of a refusal, say) changes those columns, so run the script again after it.
- **Token counts are estimates** (characters / 4) and do not include the planner's or the side calls' input.
- **Timing.** The pages run in a real browser, so a much slower machine could change how often WebBrain waits for or re-reads a settling page, and with it the page-probe counts. Repeated runs on the same machine give the same numbers.
`;

console.log('What the model receives on every Act turn\n');
console.log(surfaceTable);
console.log('\nScripted replays\n');
console.log(summaryTable);
if (CHECK) {
  const current = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
  if (current !== doc) {
    console.error(`\n${path.relative(ROOT, DOC)} is out of date; run node scripts/lean-mode-comparison.mjs`);
    process.exit(1);
  }
  console.log(`\n${path.relative(ROOT, DOC)} is up to date.`);
} else {
  fs.writeFileSync(DOC, doc);
  console.log(`\nWrote ${path.relative(ROOT, DOC)}.`);
}
process.exit(0);
