import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PARENT = path.resolve(DIR, '..');
const ROOT = path.resolve(DIR, '../../..');

function dataUri(relativePath, mime) {
  const bytes = readFileSync(path.join(ROOT, relativePath));
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function svgUri(name) {
  const bytes = readFileSync(path.join(PARENT, 'browser-logos', name));
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`;
}

function fontUri(name) {
  const bytes = readFileSync(path.join(PARENT, 'fonts', name));
  return `data:font/woff2;base64,${bytes.toString('base64')}`;
}

const logoMark = dataUri('assets/logo-mark.png', 'image/png');

const browserLogos = [
  ['Chrome', svgUri('chrome.svg')],
  ['Firefox', svgUri('firefox.svg')],
  ['Microsoft Edge', svgUri('edge.svg')],
  ['Opera', svgUri('opera.svg')],
  ['Vivaldi', svgUri('vivaldi.svg')],
  ['Brave Browser', svgUri('brave.svg')],
];

// Vendored so renders never depend on what happens to be installed locally.
const fonts = {
  display: fontUri('bricolage-grotesque-var.woff2'),
  sans: fontUri('instrument-sans-var.woff2'),
  mono: fontUri('geist-mono-var.woff2'),
};

const baseCss = `
  @font-face { font-family: 'Bricolage Grotesque'; font-weight: 200 800; font-style: normal;
    src: url(${fonts.display}) format('woff2'); }
  @font-face { font-family: 'Instrument Sans'; font-weight: 400 700; font-style: normal;
    src: url(${fonts.sans}) format('woff2'); }
  @font-face { font-family: 'Geist Mono'; font-weight: 400 700; font-style: normal;
    src: url(${fonts.mono}) format('woff2'); }
  :root {
    --display: 'Bricolage Grotesque', ui-sans-serif, system-ui, sans-serif;
    --ui: 'Instrument Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
    --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; font-family: var(--ui); -webkit-font-smoothing: antialiased; }
  .canvas { position: relative; overflow: hidden; background: transparent; }
`;

/* ---------- 01 LOGO LOCKUP (icon + wordmark, white / black) ---------- */
function lockup(color) {
  const W = 1600, H = 2000;
  const ink = color === 'white' ? '#ffffff' : '#0a0a0a';
  return {
    file: `01-logo-lockup-${color}.png`,
    width: W,
    height: H,
    body: `
      <main class="canvas" style="width:${W}px; height:${H}px; display:flex; flex-direction:column;
        align-items:center; justify-content:center;">
        <img src="${logoMark}" alt="" style="width:1180px; height:1180px; object-fit:contain;">
        <div style="margin-top:-40px; font-family:var(--ui); font-weight:700; letter-spacing:-0.055em;
          font-size:230px; line-height:1; color:${ink};">WebBrain</div>
      </main>`,
  };
}

/* ---------- 02 HERO TEE (hero-light layout, logo mark up top, transparent) ---------- */
function heroTee() {
  const W = 2000, H = 1250;
  const ink = '#141828', muted = '#586074', accent = '#d6417f', accent2 = '#12a06a';
  const border = 'rgba(28,34,64,0.16)', panel = 'rgba(255,255,255,0.94)';
  return {
    file: '02-hero-tee.png',
    width: W,
    height: H,
    body: `
      <main class="canvas" style="width:${W}px; height:${H}px; display:flex; flex-direction:column;
        align-items:center; justify-content:center; text-align:center; color:${ink};">
        <img src="${logoMark}" alt="" style="width:210px; height:210px; object-fit:contain;">
        <h1 style="margin:26px 0 0; font-family:var(--display); font-weight:800; letter-spacing:-0.02em;
          font-variation-settings:'opsz' 90; font-size:120px; line-height:1.03; max-width:1500px;">
          Your open-source<br>AI browser agent</h1>
        <div style="margin-top:36px; font-family:var(--ui); font-weight:600; letter-spacing:-0.005em;
          font-size:46px; color:${ink};">
          <span style="color:${accent};">Ask.</span>
          <span style="color:${accent2};">Act.</span>
          Automate. <span style="opacity:0.85;">Any LLM.</span>
        </div>
        <div style="display:flex; gap:16px; margin-top:46px;">
          ${['Chromium browsers and Firefox', 'Local or cloud models', 'GPL-3.0+ licensed'].map((c) => `
            <span style="padding:17px 25px; border:1.5px solid ${border}; background:${panel};
              border-radius:999px; font-family:var(--mono); font-size:21px; font-weight:650;
              letter-spacing:0.05em; text-transform:uppercase; color:${muted};">${c}</span>`).join('')}
        </div>
        <div style="display:flex; align-items:center; justify-content:center; gap:22px; margin-top:32px;">
          ${browserLogos.map(([name, src]) => `
            <span title="${name}" style="width:72px; height:72px; display:grid; place-items:center;
              border:1.5px solid ${border}; border-radius:22px; background:rgba(255,255,255,0.96);
              box-shadow:0 15px 36px rgba(34,40,72,0.14);">
              <img src="${src}" alt="${name}" style="display:block; width:47px; height:47px; object-fit:contain;">
            </span>`).join('')}
        </div>
      </main>`,
  };
}

const scenes = [lockup('white'), lockup('black'), heroTee()];

function html(scene) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}</style></head>
    <body>${scene.body}</body></html>`;
}

const SCALE = 3;

async function renderAll() {
  await mkdir(DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const scene of scenes) {
    const page = await browser.newPage({
      viewport: { width: scene.width, height: scene.height },
      deviceScaleFactor: SCALE,
    });
    await page.setContent(html(scene), { waitUntil: 'load' });
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map((img) => img.complete ? undefined : new Promise((res, rej) => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', rej, { once: true });
      })));
      await document.fonts.ready;
    });
    await page.screenshot({ path: path.join(DIR, scene.file), omitBackground: true });
    await page.close();
    console.log('rendered', scene.file, `${scene.width * SCALE}x${scene.height * SCALE}`);
  }
  await browser.close();
}

renderAll().catch((error) => { console.error(error); process.exit(1); });
