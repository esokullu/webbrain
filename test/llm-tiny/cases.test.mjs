import assert from 'node:assert/strict';
import test from 'node:test';
import { CASES, renderFixture } from './cases.mjs';
import { chromium } from 'playwright';

test('contains 30 uniquely identified local browser tasks', () => {
  assert.equal(CASES.length, 30);
  assert.equal(new Set(CASES.map(item => item.id)).size, 30);
  assert.deepEqual(CASES.map(item => item.id), Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(2, '0')));
});

test('renders each task with its local completion probe and requested target', () => {
  for (const item of CASES) {
    const html = renderFixture(item);
    assert.match(html, /window\.__llmTinyFixture/);
    assert.match(html, new RegExp(item.kind === 'form' ? item.inputValue : item.target || item.value || item.label));
  }
});

test('dropdown options are rendered within screenshot coordinates and can be clicked', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(renderFixture(CASES.find(c => c.id === '17')));
    await page.locator('select').click();
    const rect = await page.getByRole('option', { name: 'High', exact: true }).boundingBox();
    assert.ok(rect && rect.width > 0 && rect.height > 0, 'Native OS popups cannot be seen in page screenshots');
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1440 && rect.y + rect.height <= 900);
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.getByRole('button', { name: 'Apply setting' }).click();
    assert.equal(await page.evaluate(() => window.__llmTinyFixture.state.complete), true);
  } finally {
    await browser.close();
  }
});
