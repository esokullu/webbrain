#!/usr/bin/env node
// Fixtures runner for v4.0.1 overlay defenses.
//
// Loads each fixture HTML in Chromium, injects the Chrome build's content.js
// with a stubbed `chrome.runtime`, and drives `click({text})` through the
// message handler. Asserts on response shape + which DOM element actually
// got the click.
//
// No LLM, no API keys, no real sites — just deterministic regression checks
// for _findTopmostModal scoping, the occlusion hit-test, and the rich
// ambiguity payload.
//
// Run: npm run test:fixtures

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const contentJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'content.js');

function fixtureUrl(name) {
  return 'file://' + path.join(__dirname, name);
}

// Stub enough of `chrome.runtime` for content.js to register its handler
// without throwing. We capture the handler on window.__wb_handler.
const stubChrome = `
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.runtime.onMessage = {
    addListener: (fn) => { window.__wb_handler = fn; }
  };
`;

async function setup(page, fixture) {
  await page.addInitScript(stubChrome);
  await page.goto(fixtureUrl(fixture));
  const src = await readFile(contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  // Ensure handler is registered.
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function call(page, action, params) {
  return page.evaluate(({ action, params }) => new Promise((resolve) => {
    const ret = window.__wb_handler(
      { target: 'content', action, params },
      {},
      (resp) => resolve(resp),
    );
    if (ret !== true && ret !== undefined) resolve(ret);
  }), { action, params });
}

async function clickedSentinel(page) {
  return page.evaluate(() => window.__clicked);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── modal-scoping ────────────────────────────────────────────────────────
test('modal scoping: click({text:"Create"}) resolves to dialog Create', async (page) => {
  await setup(page, 'modal-scoping.html');
  const resp = await call(page, 'click', { text: 'Create' });
  if (!resp?.success) throw new Error(`expected success, got: ${JSON.stringify(resp)}`);
  const clicked = await clickedSentinel(page);
  if (clicked !== 'dlg-create') {
    throw new Error(`expected dlg-create, actually clicked: ${clicked}`);
  }
});

test('modal scoping: click({text:"Publish"}) returns no-match (scoped out)', async (page) => {
  await setup(page, 'modal-scoping.html');
  const resp = await call(page, 'click', { text: 'Publish release' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (!/scoped to the open modal/i.test(resp?.error || '')) {
    throw new Error(`expected modal-scope note in error, got: ${resp?.error}`);
  }
});

// ─── occlusion ────────────────────────────────────────────────────────────
test('occlusion: click({text:"Submit"}) refuses when covered', async (page) => {
  await setup(page, 'occlusion.html');
  const resp = await call(page, 'click', { text: 'Submit' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (!resp?.occluded) throw new Error(`expected occluded:true, got: ${JSON.stringify(resp)}`);
  if (!resp?.occludedBy) throw new Error(`expected occludedBy payload`);
  const clicked = await clickedSentinel(page);
  if (clicked !== null) throw new Error(`target should not have been clicked, got: ${clicked}`);
});

test('occlusion: click({x,y}) force-clicks (skips occlusion check)', async (page) => {
  await setup(page, 'occlusion.html');
  // Force via coords — the check is supposed to skip for x,y, so click
  // hits whatever elementFromPoint returns (the cover). Target stays unclicked.
  const resp = await call(page, 'click', { x: 180, y: 120 });
  if (!resp?.success) throw new Error(`expected success for coord click, got: ${JSON.stringify(resp)}`);
  // Either the cover or the button — we just verify no occlusion error thrown.
  if (resp?.occluded) throw new Error(`coord click should bypass occlusion check`);
});

// ─── ambiguity candidates ─────────────────────────────────────────────────
test('ambiguity: two Cancels return rich candidates with ancestor', async (page) => {
  await setup(page, 'ambiguity-candidates.html');
  const resp = await call(page, 'click', { text: 'Cancel' });
  if (resp?.success) throw new Error(`expected ambiguity, got success`);
  if (!Array.isArray(resp?.candidates)) throw new Error(`expected candidates array`);
  if (resp.candidates.length < 2) throw new Error(`expected ≥2 candidates, got ${resp.candidates.length}`);
  const ancestors = resp.candidates.map(c => c.ancestor || '');
  const hasForm = ancestors.some(a => /form/i.test(a) && /payment/i.test(a));
  const hasSection = ancestors.some(a => /section/i.test(a) && /shipping/i.test(a));
  if (!hasForm || !hasSection) {
    throw new Error(`expected form:Payment + section:Shipping ancestors, got: ${JSON.stringify(ancestors)}`);
  }
  for (const c of resp.candidates) {
    if (typeof c.cx !== 'number' || typeof c.cy !== 'number') {
      throw new Error(`candidate missing cx/cy: ${JSON.stringify(c)}`);
    }
  }
});

// ─── main ─────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  let passed = 0, failed = 0;
  for (const t of tests) {
    const page = await context.newPage();
    try {
      await t.fn(page);
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${t.name}\n    ${e.message}`);
      failed++;
    } finally {
      await page.close();
    }
  }
  await browser.close();
  console.log(`\n  ${passed} passed, ${failed} failed (${tests.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
})();
