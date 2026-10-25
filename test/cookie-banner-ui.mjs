// Automatic cookie-banner declining with the unpacked extension in Chromium
// (Playwright) and in installed Firefox (WebDriver BiDi). Local pages and a
// scripted local model only. For each browser it checks that:
// - the default 'agent' mode leaves a tab with no run alone;
// - 'everywhere' declines a banner a bundled rule recognizes, from the
//   extension's isolated world (nothing visible to page JavaScript);
// - a consent-looking iframe is injected, but the same URL on a CAPTCHA host
//   (hcaptcha.com) never is;
// - a rule whose opt-out needs a page-world eval snippet completes;
// - selector-chain rules can click buttons inside same-origin iframes;
// - WebBrain's own rules decline Efilli banners inside a shadow root (Efilli's
//   English and Turkish templates, a renamed layout found by its Turkish text,
//   hepsiburada's layout) and mediamarkt.com.tr's consent layer;
// - autoconsent's reject-only heuristic declines an English cookie popup no
//   rule knows, and leaves a popup without cookie wording alone;
// - WebBrain's Turkish rule declines Turkish banners no rule knows (also in
//   capitals), and leaves a snack offer ("çerez" also means snacks) alone;
// - 'off' leaves the banner alone;
// - 'agent' mode declines the banner in a real Act run and tells the model
//   before its first turn.
//
//   node test/cookie-banner-ui.mjs                               # both browsers
//   COOKIE_BANNER_BROWSERS=firefox node test/cookie-banner-ui.mjs
//
// Firefox needs an installed Firefox (macOS: /Applications/Firefox.app) or
// FIREFOX_BINARY; it is skipped when neither exists.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BidiSession } from '../firefox-companion/session.mjs';

const BROWSERS = (process.env.COOKIE_BANNER_BROWSERS || 'chrome,firefox').split(',').map(name => name.trim());
const CONSENT_HOST = 'consent.cmp-fixture.test';
const CAPTCHA_HOST = 'newassets.hcaptcha.com';
// The hepsiburada rule matches by URL, so its fixture is served under that
// name; the browsers resolve it to this machine.
const HEPSIBURADA_HOST = 'www.hepsiburada.com';
const MEDIAMARKT_TR_HOST = 'www.mediamarkt.com.tr';
const MAPPED_HOSTS = [CONSENT_HOST, CAPTCHA_HOST, HEPSIBURADA_HOST, MEDIAMARKT_TR_HOST];

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
async function until(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${label}`);
}

// --- Local pages -----------------------------------------------------------

let port = 0;
// Markup the generic "123inkt" autoconsent rule recognizes: a visible
// .c-cookie-popup with a [data-role=refuse-cookies] button. The two iframes
// share a Sourcepoint-style consent URL; only the host differs.
const shopPage = () => `<!doctype html><html><head><title>Fixture shop</title></head><body>
<h1>Fixture shop</h1>
<div class="c-cookie-popup" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff;border-top:1px solid #999">
  We use cookies.
  <button data-role="refuse-cookies" id="refuse">Refuse</button>
  <button id="accept">Accept all</button>
</div>
<iframe id="consent" src="http://${CONSENT_HOST}:${port}/index.html?message_id=1" width="300" height="80"></iframe>
<iframe id="captcha" src="http://${CAPTCHA_HOST}:${port}/index.html?message_id=1" width="300" height="80"></iframe>
<script src="/shop.js"></script>
</body></html>`;
const shopScript = `
document.getElementById('refuse').addEventListener('click', () => {
  document.documentElement.dataset.consent = 'refused';
  document.querySelector('.c-cookie-popup').remove();
});
document.getElementById('accept').addEventListener('click', () => {
  document.documentElement.dataset.consent = 'accepted';
  document.querySelector('.c-cookie-popup').remove();
});`;
// Markup the generic "cookiealert" rule recognizes. Its opt-out ends with an
// eval snippet (EVAL_COOKIEALERT_0) that the host must run in the page world;
// the decline only completes if that round trip works.
const blogPage = `<!doctype html><html><head><title>Fixture blog</title></head><body style="overflow:hidden">
<h1>Fixture blog</h1>
<div class="cookie-alert-extended">
  <div class="cookie-alert-extended-modal" style="position:fixed;left:10%;right:10%;top:20%;padding:20px;background:#fff;border:1px solid #999">
    We use cookies.
    <a href="#" data-controller="cookie-alert/extended/detail-link" id="details">Details</a>
    <label><input type="checkbox" class="cookie-alert-configuration-input" id="marketing" checked> Marketing</label>
    <button data-controller="cookie-alert/extended/button/configuration" id="save">Save</button>
    <button data-controller="cookie-alert/extended/button/accept" id="accept-all">Accept all</button>
  </div>
</div>
<script src="/blog.js"></script>
</body></html>`;
const blogScript = `
document.getElementById('details').addEventListener('click', event => event.preventDefault());
document.getElementById('save').addEventListener('click', () => {
  document.documentElement.dataset.saved = 'marketing=' + document.getElementById('marketing').checked;
  document.querySelector('.cookie-alert-extended-modal').style.display = 'none';
});
document.getElementById('accept-all').addEventListener('click', () => {
  document.documentElement.dataset.saved = 'accepted';
});`;

// Efilli renders its banner in the open shadow root of <efilli-layout-dynamic>,
// shortly after load. Only WebBrain's own rules (cookie-banner-rules.js) know
// it: Efilli's English and Turkish templates name their buttons with
// data-name (the Turkish one, as on koton.com, also holds a hidden copy of the
// banner first), and hepsiburada's layout gives them ids instead.
const efilliPage = layout => `<!doctype html><html><head><title>Fixture Efilli</title></head><body>
<h1>Fixture Efilli</h1>
<script src="/efilli-${layout}.js"></script>
</body></html>`;
const efilliLayouts = {
  stock: `<div class="banner" efl-consent-not-saved>We use cookies.
    <div data-name="Accept Button" data-choice="accepted">Tümünü Kabul Et</div>
    <div data-name="Settings Button">Çerez Ayarları</div>
    <div data-name="Reject Button" data-choice="refused">Tümünü Reddet</div>
  </div>
  <div class="popup" style="display:none"><div data-name="Accept Button" data-choice="accepted">Tümünü Kabul Et</div></div>`,
  turkish: `<div class="banner" efl-consent-not-saved>
    <div style="display:none"><div data-name="kabul et" data-choice="accepted">Kabul Ediyorum</div><div data-name="reddet" data-choice="refused">Reddediyorum</div></div>
    <div>Çerezler kullanıyoruz. <div data-name="kabul et" data-choice="accepted">Kabul Ediyorum</div><div data-name="reddet" data-choice="refused">Reddediyorum</div></div>
  </div>`,
  // A renamed layout with the refusal as a link inside the text, padded with
  // no-break spaces, as on flypgs.com.
  inline: `<div class="banner" efl-consent-not-saved><p>Zorunlu olmayan çerezler onay vermediğiniz takdirde kullanılmaz;
    <span class="cursor-pointer font-bold" data-choice="refused">&nbsp;Reddet&nbsp;</span>seçeneğine tıklayarak devam edebilirsiniz.</p>
    <div><div data-choice="accepted">Kabul Et</div></div></div>`,
  hepsiburada: `<div class="banner" efl-consent-not-saved>
    <div data-name="description">Çerezler kullanıyoruz. <span id="hb-reject-all" data-choice="refused">Reddet</span></div>
    <div data-name="Buttons"><div id="hb-open-settings">Çerez Ayarları</div><div id="hb-accept-all" data-choice="accepted">Kabul Et</div></div>
  </div>`,
};
const efilliScript = layout => `
customElements.define('efilli-layout-dynamic', class extends HTMLElement {});
setTimeout(() => {
  const host = document.createElement('efilli-layout-dynamic');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>.banner{position:fixed;left:4px;right:4px;bottom:4px;padding:16px;background:#333;color:#fff}</style>'
    + ${JSON.stringify(efilliLayouts[layout])};
  root.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-choice]')?.dataset.choice;
    if (!choice) return;
    document.documentElement.dataset.consent = choice;
    const banner = root.querySelector('.banner');
    banner.removeAttribute('efl-consent-not-saved');
    banner.style.display = 'none';
  });
  document.body.append(host);
}, 300);`;

// Plain banners: mediamarkt.com.tr's consent layer (its buttons belong to a
// form and only "Kabul et" has an id), an English cookie popup that only the
// heuristic can recognize, and a newsletter popup with a "Reject" button but no
// cookie wording, which nothing may click.
const plainBanner = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<h1>${title}</h1>
<div data-banner style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff;border-top:1px solid #999">${body}</div>
<script src="/choice.js"></script>
</body></html>`;
const plainPages = {
  mediamarkt: plainBanner('Fixture MediaMarkt', `<p>Sitemizin işleyişi için zorunlu çerezler kullanmaktayız. <a href="/tr/legal/cerez-aydinlatma-metni">çerez aydınlatma metni</a></p>
    <form id="pwa-consent-layer-form"></form>
    <button type="button" form="pwa-consent-layer-form" data-choice="refused">Reddet</button>
    <button type="button" form="pwa-consent-layer-form">Ayarlar</button>
    <button type="button" form="pwa-consent-layer-form" id="pwa-consent-layer-accept-all-button" data-choice="accepted">Kabul et</button>`),
  heuristic: plainBanner('Fixture news', `<p>We use cookies to improve your experience and to measure our audience.</p>
    <button data-choice="accepted">Accept all</button> <button data-choice="refused">Reject all</button>`),
  promo: plainBanner('Fixture promo', `<p>Join our newsletter for weekly deals and early access to sales.</p>
    <button data-choice="refused">Reject</button> <button data-choice="accepted">Join</button>`),
  // Turkish banners no rule knows, as lcw.com and defacto.com.tr show them.
  'tr-banner': plainBanner('Fixture TR', `<p>Size daha iyi bir deneyim sunmak için web sitemizde çerezler kullanıyoruz.
    Çerez Aydınlatma Metni’nden inceleyebilirsiniz.</p>
    <button>Tercihleri Yönet</button> <button data-choice="refused">Tüm Çerezleri Reddet</button>
    <button data-choice="accepted">Tüm Çerezlere İzin Ver</button>`),
  'tr-caps': plainBanner('Fixture TR caps', `<div><p>İNTERNET SİTEMİZDE ÇEREZLER YOLUYLA KİŞİSEL VERİ İŞLENMEKTEDİR.
    ÇEREZLERLE İLGİLİ DAHA DETAYLI BİLGİYE ÇEREZ AYDINLATMA METNİ’NDEN ULAŞABİLİRSİNİZ.</p>
    <div><a href="#" class="kvkk_notification_btn" data-choice="refused">TÜMÜNÜ REDDET</a>
    <a href="#" class="kvkk_notification_btn" data-choice="accepted">TÜMÜNE İZİN VER</a></div></div>`),
  'tr-snack': plainBanner('Fixture TR snacks', `<p>Kuruyemiş ve çerez çeşitlerinde bu hafta %20 indirim var. Kuponu sepette kullanabilirsiniz.</p>
    <button data-choice="refused">Reddet</button> <button data-choice="accepted">Kuponu al</button>`),
};
const choiceScript = `
document.addEventListener('click', (event) => {
  const choice = event.target.closest('[data-choice]')?.dataset.choice;
  if (!choice) return;
  event.preventDefault(); // links keep the page's URL, which the checks look tabs up by
  document.documentElement.dataset.consent = choice;
  event.target.closest('[data-banner]')?.remove();
});`;

const lateBannerPage = `<!doctype html><html><head><title>Fixture shop</title></head><body>
<h1>Fixture shop</h1><script src="/late-banner.js"></script></body></html>`;
const lateBannerScript = `window.showCookieBanner = () => {
  const banner = document.createElement('div');
  banner.className = 'c-cookie-popup';
  banner.style.cssText = 'position:fixed;bottom:0;padding:16px;background:white';
  banner.innerHTML = 'We use cookies. <button data-role="refuse-cookies">Refuse</button>';
  banner.querySelector('button').onclick = () => {
    document.documentElement.dataset.consent = 'refused';
    banner.remove();
  };
  document.body.append(banner);
};`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const host = String(req.headers.host || '').split(':')[0];
  const script = url.pathname.match(/^\/efilli-(stock|turkish|inline|hepsiburada)\.js$/);
  if (url.pathname === '/iframe-choice.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(`document.querySelector('button').onclick = () => {
      parent.document.documentElement.dataset.consent = 'refused';
      window.frameElement.remove();
    };`);
    return;
  }
  if (url.pathname === '/late-banner.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(lateBannerScript);
    return;
  }
  if (url.pathname === '/shop.js' || url.pathname === '/blog.js' || url.pathname === '/choice.js' || script) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(script ? efilliScript(script[1]) : url.pathname === '/choice.js' ? choiceScript
      : url.pathname === '/shop.js' ? shopScript : blogScript);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/iframe-consent') {
    res.end('<!doctype html><html><head><title>Iframe consent fixture</title></head><body><h1>Fixture shop</h1>'
      + '<div id="fast-cmp-root"><iframe id="fast-cmp-iframe" src="/iframe-button"></iframe></div></body></html>');
  } else if (url.pathname === '/iframe-button') {
    res.end('<!doctype html><html><body><div class="fast-cmp-home-refuse"><button>Refuse</button></div>'
      + '<script src="/iframe-choice.js"></script></body></html>');
  } else if (url.pathname.startsWith('/late-banner')) {
    res.end(lateBannerPage);
  } else if (url.pathname === '/index.html') {
    res.end(`<!doctype html><html><body><p>${host} frame</p></body></html>`);
  } else if (host === HEPSIBURADA_HOST) {
    res.end(efilliPage('hepsiburada'));
  } else if (host === MEDIAMARKT_TR_HOST) {
    res.end(plainPages.mediamarkt);
  } else if (Object.hasOwn(plainPages, url.pathname.slice(1)) && url.pathname !== '/mediamarkt') {
    res.end(plainPages[url.pathname.slice(1)]);
  } else if (url.pathname.startsWith('/efilli')) {
    res.end(efilliPage({ '/efilli-turkish': 'turkish', '/efilli-inline': 'inline' }[url.pathname] || 'stock'));
  } else {
    res.end(url.pathname.startsWith('/blog') ? blogPage : shopPage());
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

// --- A scripted OpenAI-compatible model for the Act run ---------------------

const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: false, requires_submission: false,
  messaging: null, deliverables: ['The page heading is reported.'], allows_planner_shaped_result: false,
  allows_app_state_tool_evidence: false, completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Report the page heading.', steps: [{ id: '1', action: 'Read the page heading.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
const modelRequests = [];
const modelServer = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = '';
  for await (const part of request) raw += part;
  const input = JSON.parse(raw);
  modelRequests.push(input);
  const system = textOf(input.messages?.[0]?.content);
  let completion;
  if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
    completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'The heading was reported.' }) };
  } else if (!input.tools?.length) {
    completion = { role: 'assistant', content: JSON.stringify(intent) };
  } else {
    completion = { role: 'assistant', content: '', tool_calls: [{ id: `cookie-run-${modelRequests.length}`, type: 'function',
      function: { name: 'done', arguments: JSON.stringify({ outcome: 'partial', summary: 'The heading is "Fixture shop".' }) } }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `response-${modelRequests.length}`, choices: [{ message: completion,
    finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
});
await new Promise(resolveListen => modelServer.listen(0, '127.0.0.1', resolveListen));
const modelOrigin = `http://127.0.0.1:${modelServer.address().port}`;

// --- Scenarios, shared by both browsers -------------------------------------
// The driver evaluates expression strings and returns their JSON value:
// open(url), page(expr), frame(host, expr), ext(expr) (an extension page).

const API = '(globalThis.browser || globalThis.chrome)';

async function scenarios(name, driver) {
  const tabIdFor = url => driver.ext(`${API}.tabs.query({}).then(tabs => tabs.find(tab => tab.url === ${JSON.stringify(url)})?.id)`);
  const status = tabId => driver.ext(`${API}.runtime.sendMessage({ type: 'webbrain-cookie-banner-status', tabId: ${Number(tabId)} })`);
  const setMode = async (mode) => {
    await driver.ext(mode
      ? `${API}.storage.local.set({ cookieBanners: ${JSON.stringify(mode)} })`
      : `${API}.storage.local.remove('cookieBanners')`);
    await until(async () => (await status(-1))?.mode === (mode || 'agent'), `${name}: mode ${mode || 'agent'}`);
  };
  const background = (action, data = {}) => driver.ext(
    `${API}.runtime.sendMessage(${JSON.stringify({ target: 'background', action, ...data })})`);
  const consent = () => driver.page(`document.documentElement.dataset.consent || ''`);
  const pass = message => console.log(`PASS ${name}: ${message}`);

  // Default 'agent' mode with no run in the tab: nothing runs.
  const shopUrl = `${origin}/shop`;
  await driver.open(shopUrl);
  await sleep(2500);
  assert.equal(await consent(), '', `${name}: 'agent' mode must leave a tab with no run alone`);
  assert.deepEqual((await status(await tabIdFor(shopUrl))).frames, []);
  pass("'agent' mode leaves a tab with no run alone");

  // 'everywhere': the banner is declined, from the isolated world.
  await setMode('everywhere');
  const everywhereUrl = `${origin}/shop-everywhere`;
  await driver.open(everywhereUrl);
  await until(async () => (await consent()) === 'refused', `${name}: the banner to be refused`);
  assert.equal(await driver.page(`document.querySelectorAll('.c-cookie-popup').length`), 0);
  assert.equal(await driver.page('typeof window.autoconsentSendMessage'), 'undefined',
    `${name}: autoconsent globals must stay out of the page world`);
  assert.equal(await driver.page('typeof window.__webbrainAutoconsentBridge'), 'undefined');
  const everywhereTab = await tabIdFor(everywhereUrl);
  const report = await until(async () => {
    const value = await status(everywhereTab);
    return value.frames.some(frame => new URL(frame.url).hostname === CONSENT_HOST) ? value : null;
  }, `${name}: the consent iframe to be injected`);
  const top = report.frames.find(frame => frame.frameId === 0);
  assert.ok(top && (top.done || top.result === true), `${name}: top frame ${JSON.stringify(top)}`);
  assert.equal(report.frames.some(frame => new URL(frame.url).hostname === CAPTCHA_HOST), false,
    `${name}: a frame on a CAPTCHA host must never be injected`);
  const captchaStyles = await driver.frame(CAPTCHA_HOST,
    `document.querySelectorAll('style#autoconsent-prehide, style#autoconsent-css-rules').length`);
  assert.equal(captchaStyles, 0, `${name}: autoconsent added nothing to the CAPTCHA frame`);
  pass("'everywhere' declines the banner from the isolated world; the CAPTCHA frame is untouched");

  const iframeUrl = `${origin}/iframe-consent`;
  await driver.open(iframeUrl);
  await until(async () => (await consent()) === 'refused', `${name}: the fastcmp rule to click inside its same-origin iframe`);
  pass('a bundled selector-chain rule declines a banner inside a same-origin iframe');

  // Revoking coverage must also stop a handler already searching this page.
  const lateOffUrl = `${origin}/late-banner-off`;
  await driver.open(lateOffUrl);
  const lateOffTab = await tabIdFor(lateOffUrl);
  await until(async () => (await status(lateOffTab)).frames.some(frame => frame.lifecycle === 'started'),
    `${name}: detection to start before Off`);
  await setMode('off');
  await driver.page('window.showCookieBanner()');
  await sleep(2500);
  assert.equal(await consent(), '', `${name}: a previously injected handler must stop after Off`);
  assert.equal(await driver.page(`document.querySelectorAll('.c-cookie-popup').length`), 1);
  pass('Off stops a previously injected handler before a late banner appears');
  await setMode('everywhere');

  // A rule whose opt-out needs one of autoconsent's page-world snippets.
  const blogUrl = `${origin}/blog`;
  await driver.open(blogUrl);
  await until(async () => (await driver.page(`document.documentElement.dataset.saved || ''`)) === 'marketing=false',
    `${name}: the cookiealert settings to be saved with marketing off`);
  await until(async () => driver.page(`!document.body.hasAttribute('style')`), `${name}: the eval snippet to unlock scrolling`);
  const blogTab = await tabIdFor(blogUrl);
  const blogTop = await until(async () => {
    const frame = (await status(blogTab)).frames.find(entry => entry.frameId === 0);
    return frame?.done ? frame : null;
  }, `${name}: the cookiealert decline to finish`);
  assert.deepEqual(blogTop.detected, ['cookiealert']);
  pass('a page-world eval snippet completes a decline');

  // WebBrain's own rules: Efilli banners inside a shadow root.
  for (const [rule, url] of [['Efilli', `http://${CONSENT_HOST}:${port}/efilli`], ['Efilli', `http://${CONSENT_HOST}:${port}/efilli-turkish`],
    ['Efilli', `http://${CONSENT_HOST}:${port}/efilli-inline`],
    ['hepsiburada', `http://${HEPSIBURADA_HOST}:${port}/`], ['mediamarkt.com.tr', `http://${MEDIAMARKT_TR_HOST}:${port}/`]]) {
    await driver.open(url);
    const tab = await tabIdFor(url);
    try {
      await until(async () => (await consent()) === 'refused', `${name}: the ${rule} banner at ${url} to be refused`);
    } catch (error) {
      error.message += `; host status ${JSON.stringify(await status(tab))}; banner ${JSON.stringify(await driver.page(
        `(() => { const root = document.querySelector('efilli-layout-dynamic')?.shadowRoot; return root ? root.innerHTML.length : null; })()`))}`;
      throw error;
    }
    const top = await until(async () => {
      const frame = (await status(tab)).frames.find(entry => entry.frameId === 0);
      return frame?.done ? frame : null;
    }, `${name}: the ${rule} decline to finish`);
    assert.deepEqual(top.detected, [rule], `${name}: ${url}`);
  }
  pass("WebBrain's own rules decline Efilli banners in a shadow root (English and Turkish templates, a renamed layout, hepsiburada's) and mediamarkt.com.tr's");

  // autoconsent's heuristic, reject-only: a cookie popup no rule knows.
  const heuristicUrl = `${origin}/heuristic`;
  await driver.open(heuristicUrl);
  await until(async () => (await consent()) === 'refused', `${name}: the heuristic to refuse the unknown cookie popup`);
  const heuristicTab = await tabIdFor(heuristicUrl);
  const heuristicTop = await until(async () => {
    const frame = (await status(heuristicTab)).frames.find(entry => entry.frameId === 0);
    return frame?.done ? frame : null;
  }, `${name}: the heuristic decline to finish`);
  assert.deepEqual(heuristicTop.detected, ['HEURISTIC-REJECT']);
  // A popup with a "Reject" button but no cookie wording is not a consent banner.
  const promoUrl = `${origin}/promo`;
  await driver.open(promoUrl);
  await sleep(3000);
  assert.equal(await consent(), '', `${name}: the newsletter popup must be left alone`);
  assert.equal(await driver.page(`document.querySelectorAll('[data-banner]').length`), 1);
  const promoTop = (await status(await tabIdFor(promoUrl))).frames.find(entry => entry.frameId === 0);
  assert.deepEqual(promoTop?.detected, [], `${name}: ${JSON.stringify(promoTop)}`);
  pass('the reject-only heuristic declines an unknown cookie popup and leaves other popups alone');

  // WebBrain's Turkish rule: banners no rule knows, also in capitals.
  for (const path of ['/tr-banner', '/tr-caps']) {
    const trUrl = `${origin}${path}`;
    await driver.open(trUrl);
    await until(async () => (await consent()) === 'refused', `${name}: the Turkish rule to refuse ${path}`);
    const trTop = await until(async () => {
      const frame = (await status(await tabIdFor(trUrl))).frames.find(entry => entry.frameId === 0);
      return frame?.done ? frame : null;
    }, `${name}: the Turkish decline on ${path} to finish`);
    assert.deepEqual(trTop.detected, ['heuristic-tr'], `${name}: ${path}`);
  }
  // "çerez" also means snacks: an offer with a "Reddet" button is not a banner.
  const snackUrl = `${origin}/tr-snack`;
  await driver.open(snackUrl);
  await sleep(3000);
  assert.equal(await consent(), '', `${name}: the snack offer must be left alone`);
  const snackTop = (await status(await tabIdFor(snackUrl))).frames.find(entry => entry.frameId === 0);
  assert.deepEqual(snackTop?.detected, [], `${name}: ${JSON.stringify(snackTop)}`);
  pass("WebBrain's Turkish rule declines Turkish banners no rule knows and leaves a snack offer alone");

  // 'off': nothing runs.
  await setMode('off');
  await driver.open(`${origin}/shop-off`);
  await sleep(2500);
  assert.equal(await consent(), '', `${name}: 'off' must leave the banner alone`);
  pass("'off' leaves the banner alone");

  // Default 'agent' mode in a real Act run, driven by the scripted model: the
  // banner on the already-open page is declined before the first model call,
  // and that call carries the note.
  await setMode(null);
  await driver.ext(`${API}.storage.local.set(${JSON.stringify({
    actObservation: 'accessibility',
    helpImproveWebBrain: false, tracingEnabled: false, autoScreenshot: false, screenshotFallback: false,
    planBeforeActMode: 'off', planReviewMode: 'never', maxAgentSteps: 4, systemOneEnabled: false,
    agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false,
  })})`);
  const scripted = {
    apiKey: 'cookie-fixture-fake-key', baseUrl: `${modelOrigin}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false,
  };
  const useScripted = async () => {
    assert.equal((await background('update_provider', { providerId: 'openrouter', config: scripted }))?.ok, true,
      `${name}: provider configured`);
    assert.equal((await background('set_active_provider', { providerId: 'openrouter' }))?.ok, true);
  };
  await useScripted();
  // Each storage change makes the background reload its providers. A reload
  // that read storage before these writes can put the default (WebBrain Cloud)
  // back, and can even drop the scripted provider's settings, so apply both
  // again until they hold.
  let steady = 0;
  let seen = null;
  await until(async () => {
    const state = await background('get_providers');
    const provider = state?.providers?.openrouter;
    seen = { active: state?.active, configured: provider?.configured, baseUrl: provider?.baseUrl };
    if (seen.active !== 'openrouter' || seen.configured !== true || !String(seen.baseUrl || '').startsWith(modelOrigin)) {
      steady = 0;
      await useScripted();
      return false;
    }
    steady += 1;
    return steady >= 3;
  }, `${name}: the scripted provider to stay active`, 20000).catch((error) => {
    assert.fail(`${error.message} (last seen: ${JSON.stringify(seen)})`);
  });
  const runUrl = `${origin}/shop-run`;
  await driver.open(runUrl);
  await sleep(1500);
  assert.equal(await consent(), '', `${name}: before the run starts, the banner is left alone`);
  const runTab = await tabIdFor(runUrl);
  modelRequests.length = 0;
  const runAct = async (tabId, suffix) => {
    // Started without waiting: a BiDi command must answer within 10 s.
    await driver.ext(`(() => {
    window.__cookieBannerRun = null;
    ${API}.runtime.sendMessage(${JSON.stringify({ target: 'background', action: 'chat', tabId,
    text: 'What is the heading of this page? Do not buy anything.', mode: 'act', requestId: `cookie-banner-run-${name}-${suffix}` })})
      .then((response) => {
        window.__cookieBannerRunResult = JSON.stringify(response ?? null).slice(0, 400);
        window.__cookieBannerRun = 'done';
      }, error => { window.__cookieBannerRun = 'error: ' + error; });
    return true;
  })()`);
    const outcome = await until(() => driver.ext('window.__cookieBannerRun'), `${name}: the Act run to finish`, 60000);
    assert.equal(outcome, 'done', `${name}: ${outcome}`);
  };
  await runAct(runTab, 'banner');
  assert.equal(await consent(), 'refused', `${name}: the Act run declined the banner`);
  const firstToolTurn = modelRequests.find(input => input.tools?.length);
  assert.ok(firstToolTurn, `${name}: the run reached a model turn with tools (model requests: ${modelRequests.length}; `
    + `run result: ${await driver.ext('window.__cookieBannerRunResult')})`);
  assert.ok(firstToolTurn.messages.some(entry => textOf(entry.content).includes('[Cookie banners: WebBrain automatically declined')),
    `${name}: the first model turn is told the banner was declined`);
  pass("'agent' mode declines the banner in an Act run and tells the model before its first turn");

  const lateRunUrl = `${origin}/late-banner-run`;
  await driver.open(lateRunUrl);
  const lateRunTab = await tabIdFor(lateRunUrl);
  await runAct(lateRunTab, 'late');
  await until(async () => !(await status(lateRunTab)).covered, `${name}: the run to release its tab`);
  await driver.page('window.showCookieBanner()');
  await sleep(2500);
  assert.equal(await consent(), '', `${name}: a finished run must not decline a late banner`);
  pass('a finished Act run stops its pending handler before a late banner appears');
  await runAct(lateRunTab, 'restart');
  assert.equal(await consent(), 'refused', `${name}: a new run can decline the previously untouched banner`);
  pass('a new Act run can handle banners again on the same document');
}

// --- Chromium (Playwright) --------------------------------------------------

const json = expression => `(async () => JSON.stringify(await (${expression})))()`;
const parsed = value => (value === undefined ? undefined : JSON.parse(value));

async function runChrome() {
  const profile = await mkdtemp(join(tmpdir(), 'webbrain-cookie-banners-chrome-'));
  let context;
  try {
    const extension = resolve('src/chrome');
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        `--host-resolver-rules=${MAPPED_HOSTS.map(host => `MAP ${host} 127.0.0.1`).join(', ')}`,
        // Everything that is not this machine or a fixture host goes to a
        // closed port, the extension's own background requests included.
        // Chromium never sends loopback addresses through a proxy.
        '--proxy-server=http://127.0.0.1:9',
        `--proxy-bypass-list=${MAPPED_HOSTS.join(';')}`,
      ],
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      const local = url.hostname === '127.0.0.1' || MAPPED_HOSTS.includes(url.hostname);
      return local || url.protocol === 'chrome-extension:' ? route.continue() : route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const control = await context.newPage();
    await control.goto(new URL('/src/ui/settings.html', worker.url()).href);
    const page = await context.newPage();
    await scenarios('chrome', {
      open: url => page.goto(url),
      page: async expression => parsed(await page.evaluate(json(expression))),
      frame: async (host, expression) => {
        const frame = page.frames().find(entry => { try { return new URL(entry.url()).hostname === host; } catch { return false; } });
        return frame ? parsed(await frame.evaluate(json(expression))) : null;
      },
      ext: async expression => parsed(await control.evaluate(json(expression))),
    });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

// --- Firefox (WebDriver BiDi) -----------------------------------------------

async function runFirefox() {
  const executable = process.env.FIREFOX_BINARY
    || (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox');
  const probe = spawnSync(executable, ['--version'], { stdio: 'ignore', timeout: 5000 });
  if (probe.error?.code === 'ENOENT' && !process.env.FIREFOX_BINARY) {
    console.log('SKIP firefox: Firefox is not installed and FIREFOX_BINARY is not set');
    return;
  }
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(`Firefox version check failed with status ${probe.status}`);
  const profile = await mkdtemp(join(tmpdir(), 'webbrain-cookie-banners-firefox-'));
  // Resolve the fixture hosts to this machine and send everything else to a
  // closed port, as the Chromium run's flags do: the test must never reach a
  // real site or model provider.
  await writeFile(join(profile, 'user.js'), [
    `user_pref("network.dns.localDomains", "${MAPPED_HOSTS.join(',')}");`,
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.http", "127.0.0.1");',
    'user_pref("network.proxy.http_port", 9);',
    'user_pref("network.proxy.ssl", "127.0.0.1");',
    'user_pref("network.proxy.ssl_port", 9);',
    `user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1, ${MAPPED_HOSTS.join(', ')}");`,
    '',
  ].join('\n'));
  const child = spawn(executable, ['--headless', '--remote-allow-system-access', '--no-remote', '--profile', profile,
    '--remote-debugging-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const session = new BidiSession();
  try {
    const bidiPort = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('Firefox BiDi did not start')), 20000);
      let output = '';
      child.stderr.on('data', (data) => {
        output += data;
        const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
      });
      child.on('error', reject);
    });
    await session.connect(bidiPort);
    await session.send('webExtension.install', { extensionData: { type: 'path', path: resolve('src/firefox') } });
    let control;
    for (let attempt = 0; attempt < 50 && !control; attempt += 1) {
      const tree = await session.send('browsingContext.getTree', {});
      control = tree.contexts.find(item => item.url.startsWith('moz-extension://'));
      if (!control) await sleep(100);
    }
    assert.ok(control, 'the extension onboarding page must open');
    const { context: tab } = await session.send('browsingContext.create', { type: 'tab' });
    const evaluate = async (context, expression) => {
      const result = await session.send('script.evaluate', { target: { context }, expression: json(expression), awaitPromise: true });
      if (result.type === 'exception') throw new Error(result.exceptionDetails.text);
      return parsed(result.result.value);
    };
    await scenarios('firefox', {
      open: url => session.send('browsingContext.navigate', { context: tab, url, wait: 'complete' }),
      page: expression => evaluate(tab, expression),
      frame: async (host, expression) => {
        const tree = await session.send('browsingContext.getTree', { root: tab });
        const frame = (tree.contexts[0]?.children || []).find(entry => { try { return new URL(entry.url).hostname === host; } catch { return false; } });
        return frame ? evaluate(frame.context, expression) : null;
      },
      ext: expression => evaluate(control.context, expression),
    });
  } finally {
    await session.close().catch(() => {});
    child.kill();
    await new Promise(resolveExit => { if (child.exitCode !== null) resolveExit(); else child.once('exit', resolveExit); });
    await rm(profile, { recursive: true, force: true });
  }
}

try {
  if (BROWSERS.includes('chrome')) await runChrome();
  if (BROWSERS.includes('firefox')) await runFirefox();
} finally {
  server.close();
  modelServer.close();
}
