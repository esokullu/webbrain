import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

globalThis.chrome = globalThis.browser = {
  runtime: { getURL: path => `chrome-extension://fixture/${path}` },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};
const rect = (x = 10, y = 20, w = 100, h = 30) => ({
  left: x, top: y, width: w, height: h, right: x + w, bottom: y + h,
});
const field = () => ({ tagName: 'INPUT', type: 'text', value: 'private-value-never-returned',
  getBoundingClientRect: () => rect() });
const child = tagName => ({ tagName, src: 'https://private.example/', clientLeft: 8,
  clientTop: 8, clientWidth: 104, clientHeight: 64, offsetWidth: 120, offsetHeight: 80,
  getBoundingClientRect: () => rect(200, 100, 120, 80), getAttribute: () => null });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const scanner = await readFile(new URL(`../src/${build}/src/content/redaction-regions.js`, import.meta.url), 'utf8');
  function fixture(options = {}) {
    const ownUrl = `${build === 'chrome' ? 'chrome' : 'moz'}-extension://fixture/newtab/index.html`;
    const tab = { id: 47, url: ownUrl, ...options.tab };
    let generation = 0;
    const fields = options.fields || [field()], children = options.children || [];
    const all = [...fields, ...children, ...(options.extraElements || [])];
    const messages = [];
    const window = { location: { href: tab.url }, scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600 };
    window.top = window;
    const document = { documentElement: { scrollWidth: 800, scrollHeight: 600 }, querySelectorAll(selector) {
      if (selector.startsWith('input:')) return fields;
      if (selector.startsWith('p, span,')) return [];
      if (selector === '*') return all;
      if (selector === 'iframe, frame, object, embed') return children;
      if (selector === 'iframe, frame') return children.filter(item => ['IFRAME', 'FRAME'].includes(item.tagName));
      throw new Error(`Unexpected selector: ${selector}`);
    } };
    let listener, tabReads = 0;
    const runtime = { getURL: path => ownUrl.replace('newtab/index.html', path),
      onMessage: { addListener: callback => { listener = callback; } } };
    const context = { chrome: { runtime }, browser: { runtime }, window, document, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++generation).padStart(12, '0')}` },
      URL, getComputedStyle: element => element.style || ({ display: 'block', visibility: 'visible', opacity: '1' }) };
    const replaceDocument = () => { runInNewContext(scanner, { ...context }); };
    replaceDocument();
    const api = { runtime, webNavigation: { getAllFrames: async () => {
      if (options.enumerationError) throw new Error('not exposed');
      return options.frames || [];
    } }, tabs: {
      get: async id => { assert.equal(id, 47); options.onTabRead?.(++tabReads, tab); return { ...tab }; },
      sendMessage: async (id, message, target) => {
        assert.equal(id, 47); assert.deepEqual(target, { frameId: 0 }); messages.push(structuredClone(message));
        let response; listener(message, {}, value => { response = structuredClone(value); });
        if (message.action === 'get_redaction_regions') {
          response = options.transform ? options.transform(response, { tab, replaceDocument, window }) : response;
        } else options.afterConfirm?.(tab, window);
        return response;
      },
    } };
    globalThis.chrome = globalThis.browser = api;
    const agent = Object.create(Agent.prototype);
    return { agent, tab, replaceDocument, window, messages, listener, ownUrl,
      capture: () => agent._captureScreenshotRedactionSnapshot(47, { coordinateSpace: 'page' }) };
  }

  test(`${build}: real Agent uses packaged scanner when own-newtab frames are omitted and covers child border boxes`, async () => {
    const h = fixture({ children: ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].map(child) });
    const result = await h.capture();
    assert.deepEqual(result, { coordinateSpace: 'page', viewport: { width: 800, height: 600 }, regions: [
      { kind: 'input', rect: { x: 10, y: 20, w: 100, h: 30 } },
      ...Array.from({ length: 4 }, () => ({ kind: 'frame', rect: { x: 200, y: 100, w: 120, h: 80 } })),
    ] });
    assert.deepEqual(h.messages.map(message => message.action), ['get_redaction_regions', 'confirm_redaction_document']);
    assert.equal(h.messages[0].params.ownedNewtabOnly, true);
    assert.equal(JSON.stringify(result).includes('private'), false);
  });

  test(`${build}: visible child of visibility-hidden ancestor is still conservatively covered`, async () => {
    const embedded = child('IFRAME');
    embedded.parentElement = { style: { display: 'block', visibility: 'hidden', opacity: '1' } };
    embedded.style = { display: 'block', visibility: 'visible', opacity: '1' };
    const result = await fixture({ children: [embedded] }).capture();
    assert.deepEqual(result.regions.at(-1), { kind: 'frame', rect: { x: 200, y: 100, w: 120, h: 80 } });
  });

  test(`${build}: child-only navigation enumeration still scans owned top frame and masks its children`, async () => {
    const h = fixture({ children: [child('IFRAME')], frames: [
      { frameId: 19, parentFrameId: 0, url: 'about:srcdoc' },
    ] });
    const result = await h.capture();
    assert.deepEqual(result.regions.at(-1), { kind: 'frame', rect: { x: 200, y: 100, w: 120, h: 80 } });
    assert.equal(h.messages[0].params.ownedNewtabOnly, true);
    const external = fixture({ tab: { url: 'https://ordinary.example/' }, frames: [
      { frameId: 19, parentFrameId: 0, url: 'about:srcdoc' },
    ] });
    assert.equal(await external.capture(), null);
    assert.equal(external.messages.length, 0);
  });

  test(`${build}: own-newtab exception is also safe when enumeration throws`, async () => {
    assert.equal((await fixture({ enumerationError: true }).capture()).regions.length, 1);
  });

  test(`${build}: missing frame enumeration never widens to external, foreign, internal or lookalike URLs`, async () => {
    for (const url of ['https://fixture/newtab/index.html', 'chrome://settings/',
      'chrome-extension://another/newtab/index.html', 'moz-extension://another/newtab/index.html',
      `${build === 'chrome' ? 'chrome' : 'moz'}-extension://fixture/newtab/index.html/other`,
      `${build === 'chrome' ? 'chrome' : 'moz'}-extension://fixture/newtab/index.html.evil`,
      `${build === 'chrome' ? 'chrome' : 'moz'}-extension://fixture/options.html`]) {
      const h = fixture({ tab: { url } });
      assert.equal(await h.capture(), null, url);
      assert.equal(h.messages.length, 0, url);
    }
  });

  test(`${build}: pending navigation and URL changes cannot authorize stale own-newtab geometry`, async () => {
    const before = fixture({ tab: { pendingUrl: 'https://destination.example/' } });
    assert.equal(await before.capture(), null); assert.equal(before.messages.length, 0);
    for (const onTabRead of [
      (count, tab) => { if (count === 2) tab.pendingUrl = tab.url; },
      (count, tab) => { if (count === 2) tab.url += '?changed=1'; },
      (count, tab) => { if (count === 3) tab.url = 'https://destination.example/'; },
      (count, tab) => { if (count === 2) tab.id = 48; },
    ]) assert.equal(await fixture({ onTabRead }).capture(), null);
  });

  test(`${build}: document confirmation rejects same-URL replacement and URL changes during scan`, async () => {
    for (const mutate of [
      state => { state.replaceDocument(); },
      state => { state.window.location.href += '#changed'; },
    ]) {
      const h = fixture({ transform: (response, state) => { mutate(state); return response; } });
      assert.equal(await h.capture(), null);
      assert.equal(h.messages.at(-1).action, 'confirm_redaction_document');
    }
    assert.equal(await fixture({ afterConfirm: tab => { tab.pendingUrl = 'https://later.example/'; } }).capture(), null);
  });

  test(`${build}: scanner refusal, incomplete geometry, malformed data and combined overflow all fail closed`, async () => {
    const mutations = [
      () => null, response => ({ ...response, complete: false }),
      response => ({ ...response, overflowed: true }), response => ({ ...response, ownedNewtabCoverage: false }),
      response => ({ ...response, documentUrl: 'https://foreign.example/' }),
      response => ({ ...response, documentToken: NaN }),
      response => ({ ...response, viewport: { width: Infinity, height: 600 } }),
      response => ({ ...response, elements: [{ kind: 'input', type: 'text', rect: { x: 1, y: 2, w: NaN, h: 5 } }] }),
      response => ({ ...response, childFrames: [{ rendered: true, rect: { x: 1, y: 2, w: 0, h: 5 } }] }),
      response => ({ ...response, childFrames: [{ rect: { x: 1, y: 2, w: 5, h: 5 } }] }),
      response => ({ ...response, elements: Array(401).fill(response.elements[0]) }),
      response => ({ ...response, elements: Array(400).fill(response.elements[0]),
        childFrames: [{ rendered: true, rect: { x: 1, y: 2, w: 5, h: 5 } }] }),
    ];
    for (const transform of mutations) assert.equal(await fixture({ transform }).capture(), null);
    const unavailable = fixture(); globalThis.chrome.tabs.sendMessage = async () => { throw new Error('no receiver'); };
    assert.equal(await unavailable.capture(), null);
  });

  test(`${build}: owned collector refuses uninspected shadow content and its own scan/capture caps`, async () => {
    for (const extraElements of [[{ tagName: 'DIV', shadowRoot: {} }], [{ tagName: 'PRIVATE-PANEL' }],
      Array.from({ length: 6001 }, () => ({ tagName: 'DIV' }))]) {
      assert.equal(await fixture({ extraElements }).capture(), null);
    }
    assert.equal(await fixture({ children: Array.from({ length: 401 }, () => child('OBJECT')) }).capture(), null);
  });

  test(`${build}: scanner owned opt-in rejects foreign expected URL, subframe and old document identity`, () => {
    const h = fixture();
    const ask = (action, params) => { let response; h.listener({ target: 'redaction-content', action, params }, {}, value => { response = value; }); return response; };
    const params = { ownedNewtabOnly: true, expectedUrl: h.ownUrl, coordinateSpace: 'page' };
    assert.equal(ask('get_redaction_regions', { ...params, expectedUrl: `${h.ownUrl}.evil` }).complete, false);
    assert.equal(ask('confirm_redaction_document', { ...params, documentToken: 999 }).current, false);
    h.window.top = {};
    assert.equal(ask('get_redaction_regions', params).complete, false);
  });

  test(`${build}: ordinary enumerated web page retains its existing scanner and strict frame coverage`, async () => {
    const h = fixture({ tab: { url: 'https://ordinary.example/' }, frames: [
      { frameId: 0, parentFrameId: -1, url: 'https://ordinary.example/' },
    ] });
    globalThis.chrome.tabs.get = async () => assert.fail('Ordinary pages must not use owned-page fallback');
    assert.equal((await h.capture()).regions.length, 1);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].params.ownedNewtabOnly, undefined);
    const hiddenChild = fixture({ tab: { url: 'https://ordinary.example/' }, children: [child('IFRAME')], frames: [
      { frameId: 0, parentFrameId: -1, url: 'https://ordinary.example/' },
    ] });
    assert.equal(await hiddenChild.capture(), null, 'Missing ordinary child inspection must still fail closed');
  });
}

test('owned-newtab helper and opt-in collector remain identical across browser builds', async () => {
  for (const file of ['agent/owned-newtab-redaction.js', 'content/redaction-regions.js']) {
    assert.equal(await readFile(new URL(`../src/chrome/src/${file}`, import.meta.url), 'utf8'),
      await readFile(new URL(`../src/firefox/src/${file}`, import.meta.url), 'utf8'));
  }
});
