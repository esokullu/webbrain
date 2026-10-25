import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import * as chromeDev from '../src/chrome/src/agent/vision-dev.js';
import * as firefoxDev from '../src/firefox/src/agent/vision-dev.js';

test('visual Dev exposes only finite diagnostic schemas identically on both browsers', () => {
  assert.deepEqual(chromeDev.VISION_DEV_TOOLS, firefoxDev.VISION_DEV_TOOLS);
  assert.deepEqual(chromeDev.VISION_DEV_TOOLS.map(tool => tool.function.name), ['read_console', 'inspect_network_requests']);
  for (const { function: tool } of chromeDev.VISION_DEV_TOOLS) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual([tool.parameters.properties.limit.minimum, tool.parameters.properties.limit.maximum], [1, 40]);
    assert.equal(tool.parameters.properties.sinceMs.maximum, 86400000);
    for (const absent of ['selector', 'ref_id', 'code', 'includeHeaders', 'includeBodies', 'bodyMaxChars'])
      assert.equal(Object.hasOwn(tool.parameters.properties, absent), false);
  }
});

test('Chrome uses buffered native diagnostic domains without DOM, AX, evaluation or response-body reads', async () => {
  const originals = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
  const tabId = 813, commands = [];
  cdpClient.attach = async tab => { assert.equal(tab, tabId); };
  cdpClient.sendCommand = async (_tab, method) => { commands.push(method); return {}; };
  try {
    assert.deepEqual(await chromeDev.startVisionDevDiagnostics(tabId), { success: true, available: true });
    assert.deepEqual(commands.sort(), ['Log.enable', 'Network.enable', 'Runtime.enable']);
    const events = cdpClient.eventHandlers.get(tabId);
    for (const handler of events['Runtime.consoleAPICalled']) handler({ type: 'error', args: [{ value: 'Fixture error' }], timestamp: Date.now() });
    for (const handler of events['Network.requestWillBeSent']) handler({ requestId: 'req-1', request: { url: 'https://fixture.test/api', method: 'POST', headers: { Authorization: 'sensitive' }, postData: 'private body' } });
    for (const handler of events['Network.responseReceived']) handler({ requestId: 'req-1', response: { status: 500, statusText: 'Failure', headers: { 'Set-Cookie': 'secret' } } });
    const console = await chromeDev.runVisionDevDiagnostic(tabId, 'read_console', { limit: 4, levels: ['error'] });
    assert.equal(console.entries[0].text, 'Fixture error');
    const network = await chromeDev.runVisionDevDiagnostic(tabId, 'inspect_network_requests', { methods: ['POST'], statusMin: 500 });
    assert.equal(network.requests[0].status, 500);
    assert.equal(network.includesHeaders, false);
    assert.equal(network.includesBodies, false);
    assert.equal(/sensitive|private body|secret/.test(JSON.stringify(network)), false);
    assert.equal(commands.length, 3, 'Reading buffered diagnostics must not issue extra page-observation commands');
  } finally {
    Object.assign(cdpClient, originals);
    cdpClient.devDiagnostics.delete(tabId); cdpClient.eventHandlers.delete(tabId);
  }
});

test('invalid or hidden arguments fail before any backend call', async () => {
  const original = cdpClient.readConsole;
  cdpClient.readConsole = async () => { throw new Error('Backend must not run'); };
  try {
    const cases = [
      ['read_console', { limit: 41 }], ['read_console', { limit: 0 }], ['read_console', { sinceMs: Infinity }],
      ['read_console', { levels: Array(6).fill('error') }], ['read_console', { selector: 'body' }],
      ['inspect_network_requests', { includeBodies: true }], ['inspect_network_requests', { includeHeaders: true }],
      ['inspect_network_requests', { statusMin: 599, statusMax: 200 }],
      ['inspect_network_requests', { methods: Array(10).fill('GET') }],
      ['inspect_network_requests', { urlPattern: 'x'.repeat(257) }], ['execute_js', { code: 'return document.body' }],
    ];
    for (const [name, args] of cases) {
      const result = await chromeDev.runVisionDevDiagnostic(1, name, args);
      assert.equal(result.success, false);
      assert.equal(result.noDispatch, true);
      assert.notEqual(result.error, 'Backend must not run');
    }
  } finally { cdpClient.readConsole = original; }
});

test('console/network payloads remain valid structured JSON under 12000 characters', async () => {
  const originals = { readConsole: cdpClient.readConsole, inspectNetworkRequests: cdpClient.inspectNetworkRequests };
  const data = Array.from({ length: 40 }, (_, index) => ({ text: `${index}:` + '\u0000"🙂'.repeat(3000),
    level: 'error', url: 'https://fixture.test/' + 'x'.repeat(3000), responseBody: 'must not be forwarded',
    requestHeaders: { Authorization: 'must not be forwarded' }, location: { url: 'x'.repeat(3000) } }));
  cdpClient.readConsole = async (_tab, options) => { assert.equal(options.limit, 20); return { success: true, entries: data }; };
  cdpClient.inspectNetworkRequests = async (_tab, options) => {
    assert.equal(options.includeHeaders, false); assert.equal(options.includeBodies, false);
    return { success: true, requests: data };
  };
  try {
    for (const name of ['read_console', 'inspect_network_requests']) {
      const result = await chromeDev.runVisionDevDiagnostic(1, name, {});
      const serialized = JSON.stringify(result);
      assert.ok(serialized.length <= 12000);
      assert.deepEqual(JSON.parse(serialized), result);
      assert.equal(result.truncated, true);
      assert.ok(result.count < 40 && result.count > 0);
      assert.equal(result.availableCount, 40);
      assert.equal(serialized.includes('must not be forwarded'), false);
    }
  } finally { Object.assign(cdpClient, originals); }
});

test('Firefox explicitly reports unavailable diagnostics and does not fall back to page scripts', async () => {
  const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
  const deniedApi = new Proxy({}, { get() { throw new Error('No browser fallback may run'); } });
  globalThis.chrome = deniedApi; globalThis.browser = deniedApi;
  try {
    assert.equal((await firefoxDev.startVisionDevDiagnostics(1)).available, false);
    for (const name of ['read_console', 'inspect_network_requests']) {
      const result = await firefoxDev.runVisionDevDiagnostic(1, name, {});
      assert.equal(result.success, false); assert.equal(result.available, false);
      assert.match(result.error, /unavailable.*Firefox/i);
    }
  } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
});

test('backend errors are bounded and diagnostic setup failure is nonfatal', async () => {
  const original = cdpClient.enableDevDiagnostics;
  cdpClient.enableDevDiagnostics = async () => { throw new Error('Failure'.repeat(1000)); };
  try {
    const setup = await chromeDev.startVisionDevDiagnostics(1);
    assert.equal(setup.success, false); assert.equal(setup.available, false); assert.equal(setup.error.length, 1000);
    const read = await chromeDev.runVisionDevDiagnostic(1, 'read_console', {});
    assert.equal(read.success, false); assert.equal(read.error.length, 1000);
  } finally { cdpClient.enableDevDiagnostics = original; }
});
