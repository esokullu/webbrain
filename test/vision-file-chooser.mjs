import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createVisionFileChooserTrap, visionChooserInputMatches } from '../src/chrome/src/agent/vision-file-target.js';

for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${name}: document-local chooser trap rejects ambiguity, expires and restores native picker methods`, { timeout: 30000 }, async () => {
    const browser = await engine.launch({ headless: true,
      ...(name === 'chrome' && process.env.WEBBRAIN_QUALITY_SOFTWARE_RENDERING === '1'
        ? { args: ['--disable-gpu', '--disable-gpu-compositing'] } : {}) });
    try {
      const page = await browser.newPage();
      await page.setContent(`<button style="position:absolute;left:20px;top:20px;width:200px;height:50px">Upload</button>
        <input id="one" type="file" hidden><input id="two" type="file" hidden>
        <script>window.originalPicker=HTMLInputElement.prototype.showPicker;
        document.querySelector('button').onclick=()=>{one.showPicker();two.click();};</script>`);
      const install = async ttl => page.evaluate(({ source, ttl }) => {
        window.trap = (0, eval)(`(${source})`)(60, 40, ttl);
      }, { source: createVisionFileChooserTrap.toString(), ttl });
      await install(2000);
      await page.mouse.click(60, 40);
      assert.deepEqual(await page.evaluate(() => ({ count: trap.count(), noTarget: trap.take() === null })), { count: 2, noTarget: true });
      await page.evaluate(() => trap.close());
      assert.equal(await page.evaluate(() => HTMLInputElement.prototype.showPicker === originalPicker), true);
      await page.evaluate(() => { document.querySelector('button').onclick = () => one.showPicker(); });
      await install(2000);
      await page.mouse.click(60, 40);
      assert.equal(await page.evaluate(source => (0, eval)(`(${source})`)(trap.take(), trap.trigger(), 60, 40), visionChooserInputMatches.toString()), true);
      // A different control replacing the reviewed point cannot inherit the input.
      await page.evaluate(() => { const mask = document.createElement('button'); mask.style='position:absolute;left:20px;top:20px;width:200px;height:50px'; document.body.append(mask); });
      assert.equal(await page.evaluate(source => (0, eval)(`(${source})`)(trap.take(), trap.trigger(), 60, 40), visionChooserInputMatches.toString()), false);
      await page.evaluate(() => { trap.close(); document.body.lastElementChild.remove(); });
      await install(250);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => trap.take() === null && HTMLInputElement.prototype.showPicker === originalPicker), true);
      // Cleanup on abort follows the same close path and leaves native chooser behavior intact.
      await install(2000);
      await page.evaluate(() => trap.close());
      const chooser = page.waitForEvent('filechooser');
      await page.mouse.click(60, 40);
      assert.ok(await chooser);
      assert.equal(await page.evaluate(() => one.files.length + two.files.length), 0);
    } finally { await browser.close(); }
  });
}
