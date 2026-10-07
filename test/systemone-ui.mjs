import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('.');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const server = createServer(async (req, res) => {
  try { const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname); if (!file.startsWith(root + sep)) throw Error();
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'text/plain'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.env.JEV_UI_OUTPUT || '/tmp/jev-ui-review'; await mkdir(output, { recursive: true });
async function captureDocScreenshots(page, directory) {
  await mkdir(directory, { recursive: true });
  await page.locator('#system-one-card details').evaluate(el => { el.open = false; });
  await page.locator('#test-system-one').evaluate(el => { el.textContent = ''; el.className = 'test-result'; });
  for (const [tab, name] of [['providers', 'providers'], ['display', 'general'], ['memory', 'memory'], ['permissions', 'permissions'], ['multimodal', 'assistive-models']]) {
    await page.locator(`[data-tab="${tab}"]`).click();
    if (tab === 'providers') await page.locator('#input-provider-search').fill('');
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    await page.mouse.move(0, 0);
    await page.screenshot({ animations: 'disabled', caret: 'hide', path: resolve(directory, `settings-${name}.jpg`), type: 'jpeg', quality: 85 });
  }
  await page.locator('#system-one-heading').scrollIntoViewIfNeeded();
  const clip = await page.evaluate(() => {
    const heading = document.querySelector('#system-one-heading').getBoundingClientRect();
    const card = document.querySelector('#system-one-card').getBoundingClientRect();
    return { x: card.x + scrollX, y: heading.y + scrollY, width: card.width, height: card.bottom - heading.y };
  });
  await page.screenshot({ animations: 'disabled', caret: 'hide', path: resolve(directory, 'settings-jev.jpg'), type: 'jpeg', quality: 85, fullPage: true, clip });
  await page.locator('[data-tab="display"]').click();
  await page.locator('#input-general-search').fill('Strict secret');
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  await page.mouse.move(0, 0);
  await page.screenshot({ animations: 'disabled', caret: 'hide', path: resolve(directory, 'settings-advanced.jpg'), type: 'jpeg', quality: 85 });
  await page.locator('#input-general-search').fill('');
}
try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch();
    try {
      for (const lang of ['en', 'tr']) for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ lang, build, version }) => {
          localStorage.setItem('wbLocale', lang);
          const data = { wbLocale: lang, typesafeApiKey: '', systemOneEnabled: false, systemOneWatchEnabled: true, systemOneCompletionEnabled: true };
          window.testStore = data; window.testRequests = [];
          const listeners = [];
          const storage = {
            async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)).map(k => [k, data[k]])); },
            async set(values) { Object.assign(data, values); listeners.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'local')); },
            async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
          };
          window.chrome = window.browser = {
            storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } },
            runtime: { getURL: path => `${location.origin}/src/${build}/${path}`, getManifest: () => ({ version }), onMessage: { addListener() {} }, sendMessage(msg, callback) {
              window.testRequests.push(msg);
              const result = msg.action === 'get_providers' ? { providers: { llamacpp: { label: 'llama.cpp', category: 'local', baseUrl: 'http://localhost:8080/v1', model: 'local-model', configured: true }, openai: { label: 'OpenAI', category: 'cloud', apiKey: '', model: 'gpt-4o-mini' } }, active: 'llamacpp' }
                : msg.action === 'test_system_one' ? { success: true, model: msg.settings?.decisionModel || 'jev-1.13.0', visionVerified: msg.settings?.decisionProvider === 'openrouter' }
                  : msg.action === 'list_decision_models' ? { success: true, models: [{ id: 'perplexity/pplx-decider-v1-27b', name: 'Decider', supportsVision: true, inputRate: .04, outputRate: 0 }, { id: 'another/publisher', name: 'Another decision model', supportsVision: false, inputRate: .1, outputRate: 0 }] } : {};
              callback?.(result); return Promise.resolve(result);
            } },
            commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
          };
        }, { lang, build, version });
        await page.goto(`${origin}/src/${build}/src/ui/settings.html#multimodal`);
        await page.waitForFunction(() => document.querySelector('#system-one-heading')?.textContent.trim() === (localStorage.getItem('wbLocale') === 'tr' ? 'Karar modelleri' : 'Decision models'));
        assert.equal(await page.locator('[data-tab="multimodal"]').textContent(), lang === 'tr' ? 'Yardımcı Modeller' : 'Assistive Models');
        assert.equal(await page.locator('[data-panel="multimodal"]').isVisible(), true, 'existing deep link opens Assistive Models');
        assert.equal(await page.locator('.tab-btn').evaluateAll(buttons => buttons.every(button => {
          const range = document.createRange();
          range.selectNodeContents(button);
          const lines = [...range.getClientRects()].filter(rect => rect.width > 0);
          return lines.length > 0 && lines.every(rect => Math.abs(rect.top - lines[0].top) < 1)
            && button.scrollWidth <= button.clientWidth + 1;
        })), true, 'every tab label fits on one line without clipping');
        await page.screenshot({ animations: 'disabled', path: `${output}/${build}-${lang}-${width}-tabs.png` });
        assert.equal(await page.locator('[data-panel="providers"] #system-one-card').count(), 0);
        assert.deepEqual(await page.locator('[data-panel="multimodal"] > .provider-card').evaluateAll(cards => cards.map(card => card.id)), [
          'vision-card', 'image-budget-card', 'redaction-card', 'transcription-card', 'image-gen-card', 'system-one-card', 'safesocial-card',
        ]);
        // A label change must retain saved tab selection as well as old deep links.
        await page.evaluate(() => history.replaceState(null, '', location.pathname));
        await page.locator('[data-tab="providers"]').click();
        await page.reload();
        assert.equal(await page.locator('[data-panel="providers"]').isVisible(), true);
        await page.locator('[data-tab="multimodal"]').click();
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#system-one-heading')?.textContent.trim() === (localStorage.getItem('wbLocale') === 'tr' ? 'Karar modelleri' : 'Decision models'));
        assert.equal(await page.locator('[data-panel="multimodal"]').isVisible(), true);
        assert.equal(await page.evaluate(() => testRequests.filter(r => r.action === 'test_system_one').length), 0);
        assert.equal(await page.locator('#toggle-system-one-classifications').isChecked(), false);
        assert.equal(await page.locator('#toggle-system-one-browser').isChecked(), false);
        await page.locator('#toggle-system-one-classifications').locator('..').click();
        await page.locator('#toggle-system-one-browser').locator('..').click();
        await page.locator('#decision-provider').selectOption('typesafe');
        await page.locator('#system-one-api-key').fill('synthetic-test-key');
        await page.locator('[data-tab="providers"]').click();
        const search = page.locator('#providers .provider-search input');
        if (await search.count()) await search.fill('No matching provider');
        assert.equal(await page.locator('#providers .provider-filter-bar').count(), 1);
        await page.locator('[data-tab="multimodal"]').click();
        assert.equal(await page.locator('#system-one-api-key').inputValue(), 'synthetic-test-key');
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.typesafeApiKey === 'synthetic-test-key');
        assert.equal(await page.evaluate(() => testStore.systemOneWatchEnabled), true);
        assert.equal(await page.evaluate(() => testStore.systemOneCompletionEnabled), true);
        await page.locator('#toggle-system-one').locator('..').click();
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.systemOneEnabled === true);
        await page.locator('#toggle-system-one').locator('..').click();
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.systemOneEnabled === false);
        assert.equal(await page.evaluate(() => testStore.systemOneWatchEnabled), true);
        assert.equal(await page.evaluate(() => testStore.systemOneCompletionEnabled), true);
        assert.equal(await page.evaluate(() => testStore.systemOneFastBrowser), true);
        assert.equal(await page.evaluate(() => testStore.systemOneFastClassifications), true);
        await page.locator('#btn-test-system-one').click();
        await page.waitForFunction(() => testRequests.filter(r => r.action === 'test_system_one').length === 1);
        await page.locator('#decision-provider').selectOption('openrouter');
        assert.equal(await page.locator('#decision-model').inputValue(), 'perplexity/pplx-decider-v1-27b');
        assert.equal(await page.locator('#system-one-api-key').inputValue(), '', 'TypeSafe key must not be copied into OpenRouter');
        assert.equal(await page.locator('#toggle-decision-done').isChecked(), true);
        await page.locator('#system-one-api-key').fill('synthetic-openrouter-key');
        await page.locator('#btn-decision-models').click();
        await page.waitForFunction(() => document.querySelectorAll('#decision-models option').length === 2);
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.decisionProvider === 'openrouter' && testStore.decisionApiKey === 'synthetic-openrouter-key');
        assert.equal(await page.evaluate(() => testStore.typesafeApiKey), 'synthetic-test-key');
        assert.equal(await page.evaluate(() => testStore.decisionVisionSupported), true);
        assert.equal(await page.evaluate(() => testStore.systemOneDoneThreshold), .9);
        await page.locator('#decision-provider').selectOption('local');
        assert.equal(await page.locator('#decision-model').inputValue(), 'kev-latest');
        assert.equal(await page.locator('#system-one-api-key').inputValue(), '');
        assert.equal(await page.locator('#decision-endpoint-field').isVisible(), true);
        await page.locator('#toggle-system-one').locator('..').click();
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.decisionProvider === 'local' && testStore.systemOneEnabled === true);
        assert.equal(await page.evaluate(() => testStore.decisionLocalApiKey), '', 'local key remains optional');
        await page.locator('#btn-test-system-one').click();
        await page.waitForFunction(() => testRequests.filter(r => r.action === 'test_system_one').length === 2);
        assert.equal(await page.evaluate(() => testRequests.filter(r => r.action === 'test_system_one').at(-1).settings.decisionModel), 'kev-latest');
        await page.locator('#decision-provider').selectOption('typesafe');
        assert.equal(await page.locator('#system-one-api-key').inputValue(), 'synthetic-test-key');
        await page.locator('#decision-provider').selectOption('openrouter');
        assert.equal(await page.locator('#system-one-api-key').inputValue(), 'synthetic-openrouter-key');
        await page.locator('#system-one-card details').evaluate(el => { el.open = true; });
        await page.screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}.png`, fullPage: true });
        await page.locator('#system-one-card').screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}-decision-card.png` });
        await page.locator('#btn-clear-system-one').click();
        assert.equal(await page.locator('#range-system-one-watch-threshold').inputValue(), '70');
        assert.equal(await page.locator('#toggle-system-one-watch').isChecked(), false);
        assert.equal(await page.locator('#toggle-system-one').isChecked(), false);
        assert.equal(await page.locator('#toggle-system-one-completion').isChecked(), false);
        assert.equal(await page.locator('#range-system-one-completion-threshold').inputValue(), '70');
        assert.equal(await page.locator('#toggle-system-one-browser').isChecked(), false);
        assert.equal(await page.locator('#toggle-system-one-classifications').isChecked(), false);
        assert.equal(await page.evaluate(() => testStore.typesafeApiKey), undefined);
        if (build === 'chrome' && lang === 'en' && width === 1280 && process.env.JEV_DOC_SCREENSHOTS) {
          await captureDocScreenshots(page, process.env.JEV_DOC_SCREENSHOTS);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'settings fit viewport');
        assert.deepEqual(errors, []);
        await page.close(); console.log(`${build} ${lang} ${width}: settings save/test/clear passed`);
      }
    } finally { await browser.close(); }
  }
} finally { server.close(); }
