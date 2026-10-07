import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { captureMediaDownloadBindingInPage } from '../src/chrome/src/agent/media-download-binding.js';

const html = `<!doctype html><style>img { width:500px;height:400px } body{margin:0}</style>
<div role="dialog" aria-modal="true"><button id="likes">1575 Likes</button>
<div id="media-root" data-testid="tweetPhoto"><img id="photo" src="https://pbs.twimg.com/media/binding-a.jpg"></div></div>`;
const path = '/account/status/123/photo/1';

async function fixture(engine, build) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="red"/></svg>' }));
  const page = await context.newPage();
  await page.goto(`https://x.com${path}`);
  await page.waitForFunction(() => document.getElementById('photo').naturalWidth > 0);
  const source = fs.readFileSync(new URL(`../src/${build}/src/agent/social-media-downloader.js`, import.meta.url), 'utf8');
  const inject = async () => {
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      window.effects = { fetches: 0, clicks: 0, scrolls: 0 };
      window.fetch = async () => { effects.fetches++; return { ok: true, blob: async () => new Blob(['photo']) }; };
      HTMLAnchorElement.prototype.click = () => effects.clicks++;
      window.scrollTo = () => effects.scrolls++;
    });
  };
  await inject();
  return { browser, page, inject };
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  for (const mutation of ['none', 'nested_value', 'type', 'extra_key', 'array_order']) {
    test(`${build}: binding serialization key order is harmless while ${mutation} stays exact`, async () => {
      const { browser, page } = await fixture(engine, build);
      try {
        const result = await page.evaluate(async change => {
          if (change === 'array_order') document.getElementById('photo').setAttribute('data-src', 'https://pbs.twimg.com/media/other.jpg');
          const original = SocialMediaDownloader.getMediaBinding({ mode: 'main', target: 'image', limit: 1 });
          const reorder = value => Array.isArray(value) ? value.map(reorder)
            : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().reverse()
              .map(key => [key, reorder(value[key])])) : value;
          const expectedMediaBinding = reorder(original);
          const keyOrderChanged = JSON.stringify(original) !== JSON.stringify(expectedMediaBinding);
          if (change === 'nested_value') expectedMediaBinding.sources[0].node = 'different-node';
          if (change === 'type') expectedMediaBinding.request.limit = '1';
          if (change === 'extra_key') expectedMediaBinding.sources[0].extra = true;
          if (change === 'array_order') expectedMediaBinding.sources[0].assets.reverse();
          return { keyOrderChanged, result: await SocialMediaDownloader.run({ mode: 'main', target: 'image', limit: 1,
            delayBetweenDownloads: 0, expectedMediaBinding }) };
        }, mutation);
        assert.equal(result.keyOrderChanged, true);
        if (mutation === 'none') {
          assert.equal(result.result.stats.completed, 1);
          assert.deepEqual(await page.evaluate(() => effects), { fetches: 1, clicks: 1, scrolls: 0 });
        } else {
          assert.equal(result.result.noDispatch, true);
          assert.equal(result.result.errorCode, 'media_binding_changed');
          assert.deepEqual(await page.evaluate(() => effects), { fetches: 0, clicks: 0, scrolls: 0 });
        }
      } finally { await browser.close(); }
    });
  }

  test(`${build}: media binding survives counters and downloader reinjection, then downloads once`, async () => {
    const { browser, page, inject } = await fixture(engine, build);
    try {
      const bindings = await page.evaluate(captureMediaDownloadBindingInPage);
      assert.ok(bindings.image?.documentToken);
      assert.equal(bindings.image.focused, true);
      assert.equal(bindings.video, null);
      assert.deepEqual(bindings.auto.candidates, bindings.image.candidates);
      await page.evaluate(() => { document.getElementById('likes').textContent = '1591 Likes'; });
      await inject();
      const current = await page.evaluate(captureMediaDownloadBindingInPage);
      assert.deepEqual(current, bindings);
      const result = await page.evaluate(expectedMediaBinding => SocialMediaDownloader.run({
        mode: 'main', target: 'image', limit: 1, delayBetweenDownloads: 0, expectedMediaBinding,
      }), bindings.image);
      assert.equal(result.stats.completed, 1);
      assert.deepEqual(await page.evaluate(() => effects), { fetches: 1, clicks: 1, scrolls: 0 });
    } finally { await browser.close(); }
  });

  test(`${build}: bound main download selects the open photo instead of the background timeline`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        document.querySelector('[aria-modal="true"]').style.cssText = 'position:fixed;inset:0;background:black';
        const timeline = document.createElement('main');
        timeline.innerHTML = '<article data-testid="tweet"><div data-testid="tweetPhoto"><img id="background" src="https://pbs.twimg.com/media/background.jpg"></div></article>';
        document.body.prepend(timeline);
      });
      await page.waitForFunction(() => document.getElementById('background').naturalWidth > 0);
      const binding = (await page.evaluate(captureMediaDownloadBindingInPage)).image;
      assert.equal(binding.focused, true);
      assert.match(binding.candidates[0].url, /binding-a/);
      assert.equal(binding.focusScope, 'dialog');
      const saved = await page.evaluate(async expectedMediaBinding => {
        const urls = [];
        window.fetch = async url => { urls.push(url); return { ok: true, blob: async () => new Blob(['photo']) }; };
        const result = await SocialMediaDownloader.run({ mode: 'main', target: 'image', limit: 1,
          delayBetweenDownloads: 0, expectedMediaBinding });
        return { result, urls };
      }, binding);
      assert.equal(saved.result.stats.completed, 1);
      assert.deepEqual(saved.urls, [binding.candidates[0].url]);
    } finally { await browser.close(); }
  });

  test(`${build}: equally ranked distinct photos do not create an ambiguous binding`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        document.querySelector('[aria-modal="true"]').style.cssText = 'width:800px;height:600px';
        const image = document.getElementById('photo');
        image.style.cssText = 'position:absolute;left:0;top:40px';
        const other = image.cloneNode(true);
        other.id = 'other-photo'; other.src = 'https://pbs.twimg.com/media/binding-b.jpg';
        image.parentElement.appendChild(other);
      });
      await page.waitForFunction(() => document.getElementById('other-photo').naturalWidth > 0);
      assert.equal((await page.evaluate(captureMediaDownloadBindingInPage)).image, null);
      assert.deepEqual(await page.evaluate(() => effects), { fetches: 0, clicks: 0, scrolls: 0 });
    } finally { await browser.close(); }
  });

  for (const change of ['asset', 'node', 'root', 'hidden', 'foreground', 'url', 'reload', 'bulk', 'limit', 'target']) {
    test(`${build}: changed ${change} cannot dispatch a bound media download`, async () => {
      const { browser, page, inject } = await fixture(engine, build);
      try {
        const expected = (await page.evaluate(captureMediaDownloadBindingInPage)).image;
        assert.ok(expected);
        if (change === 'reload') {
          await page.reload();
          await page.waitForFunction(() => document.getElementById('photo').naturalWidth > 0);
          await inject();
        } else await page.evaluate(kind => {
          const image = document.getElementById('photo');
          if (kind === 'asset') image.src = 'https://pbs.twimg.com/media/binding-b.jpg';
          if (kind === 'node') image.replaceWith(image.cloneNode(true));
          if (kind === 'root') {
            const root = image.parentElement;
            const replacement = root.cloneNode(false);
            replacement.appendChild(image); root.replaceWith(replacement);
          }
          if (kind === 'hidden') image.style.display = 'none';
          if (kind === 'foreground') {
            const overlay = document.createElement('div');
            overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('role', 'dialog');
            overlay.style.cssText = 'position:fixed;inset:0;background:black';
            overlay.innerHTML = '<img width="800" height="600" src="https://pbs.twimg.com/media/binding-b.jpg" style="width:100vw;height:100vh">';
            document.body.appendChild(overlay);
          }
          if (kind === 'url') history.replaceState({}, '', '/account/status/456/photo/1');
        }, change);
        const result = await page.evaluate(({ expectedMediaBinding, kind }) => SocialMediaDownloader.run({
          mode: 'main', target: kind === 'target' ? 'video' : 'image',
          limit: kind === 'limit' ? 2 : 1, all: kind === 'bulk', delayBetweenDownloads: 0, expectedMediaBinding,
        }), { expectedMediaBinding: expected, kind: change });
        assert.equal(result.noDispatch, true);
        assert.equal(result.errorCode, 'media_binding_changed');
        assert.deepEqual(await page.evaluate(() => effects), { fetches: 0, clicks: 0, scrolls: 0 });
      } finally { await browser.close(); }
    });
  }

  test(`${build}: media replacement during fetch cannot save or open a stale download`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const expected = (await page.evaluate(captureMediaDownloadBindingInPage)).image;
      const result = await page.evaluate(async expectedMediaBinding => {
        window.fetch = async () => {
          effects.fetches++;
          document.getElementById('photo').src = 'https://pbs.twimg.com/media/binding-b.jpg';
          return { ok: true, blob: async () => new Blob(['old photo']) };
        };
        return SocialMediaDownloader.run({ mode: 'main', target: 'image', limit: 1,
          delayBetweenDownloads: 0, expectedMediaBinding });
      }, expected);
      assert.equal(result.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => effects), { fetches: 1, clicks: 0, scrolls: 0 });
    } finally { await browser.close(); }
  });
}

test('media download binding source stays identical across browsers', () => {
  for (const file of ['media-download-binding.js', 'social-media-downloader.js']) {
    assert.equal(fs.readFileSync(new URL(`../src/chrome/src/agent/${file}`, import.meta.url), 'utf8'),
      fs.readFileSync(new URL(`../src/firefox/src/agent/${file}`, import.meta.url), 'utf8'));
  }
});

// React Native Web paints the visible asset separately from its backing IMG.
{
  const asset = 'https://pbs.twimg.com/media/intended.jpg';
  const html = `<!doctype html><style>body{margin:0}[aria-modal=true]{position:fixed;inset:0;background:white}
  #paint{position:relative;width:500px;height:400px;background-size:cover;background-image:url("${asset}")}
  #photo{position:absolute;inset:0;width:100%;height:100%;opacity:0;z-index:-1}</style>
  <div role="dialog" aria-modal="true"><button id="likes">1575 Likes</button>
  <div data-testid="tweetPhoto"><div id="paint"><img id="photo" src="${asset}"></div></div></div>`;

  async function fixture(engine, build, shape = 'parent') {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await context.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="red"/></svg>' }));
    const page = await context.newPage();
    await page.goto('https://x.com/account/status/123/photo/1');
    await page.waitForFunction(() => document.getElementById('photo').naturalWidth > 0);
    if (shape === 'sibling') await page.evaluate(() => {
      const image = document.getElementById('photo'), parent = image.parentElement;
      const paint = document.createElement('div'); paint.id = 'paint-sibling';
      paint.style.cssText = `position:absolute;inset:0;background-image:${getComputedStyle(parent).backgroundImage};background-size:cover`;
      parent.style.backgroundImage = 'none'; parent.appendChild(paint);
    });
    await page.addScriptTag({ content: fs.readFileSync(new URL(`../src/${build}/src/agent/social-media-downloader.js`, import.meta.url), 'utf8') });
    await page.evaluate(() => {
      window.effects = { fetches: [], clicks: 0, scrolls: 0 };
      window.fetch = async url => { effects.fetches.push(url); return { ok: true, blob: async () => new Blob(['photo']) }; };
      HTMLAnchorElement.prototype.click = () => effects.clicks++;
      window.scrollTo = () => effects.scrolls++;
    });
    return { browser, page };
  }

  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    for (const phase of ['capture', 'dispatch']) for (const obstruction of ['ancestor_opacity', 'ancestor_display', 'ancestor_visibility', 'ancestor_inert', 'overlay']) {
      test(`${build}: painted media rejects ${obstruction} during ${phase}`, async () => {
        const { browser, page } = await fixture(engine, build);
        try {
          let binding;
          if (phase === 'dispatch') {
            binding = (await page.evaluate(captureMediaDownloadBindingInPage)).image;
            assert.ok(binding);
          }
          await page.evaluate(kind => {
            const media = document.querySelector('[data-testid=tweetPhoto]');
            if (kind === 'ancestor_opacity') media.style.opacity = '0';
            if (kind === 'ancestor_display') media.style.display = 'none';
            if (kind === 'ancestor_visibility') media.style.visibility = 'hidden';
            if (kind === 'ancestor_inert') media.inert = true;
            if (kind === 'overlay') {
              const overlay = document.createElement('div');
              overlay.style.cssText = 'position:fixed;inset:0;background:black;z-index:99999';
              document.body.appendChild(overlay);
            }
          }, obstruction);
          if (phase === 'capture') assert.equal((await page.evaluate(captureMediaDownloadBindingInPage)).image, null);
          else {
            const result = await page.evaluate(expectedMediaBinding => SocialMediaDownloader.run({
              mode: 'main', target: 'image', limit: 1, delayBetweenDownloads: 0, expectedMediaBinding,
            }), binding);
            assert.equal(result.noDispatch, true);
            assert.equal(result.errorCode, 'media_binding_changed');
          }
          assert.deepEqual(await page.evaluate(() => effects), { fetches: [], clicks: 0, scrolls: 0 });
        } finally { await browser.close(); }
      });
    }

    for (const shape of ['parent', 'sibling']) test(`${build}: transparent backing IMG binds and downloads its matching visible ${shape} paint`, async () => {
      const { browser, page } = await fixture(engine, build, shape);
      try {
        const binding = (await page.evaluate(captureMediaDownloadBindingInPage)).image;
        assert.ok(binding?.focused);
        assert.match(binding.candidates[0].url, /intended\.jpg/);
        assert.ok(binding.sources[0].paintCarrier?.node);
        assert.equal(binding.sources[0].paintCarrier.url, asset);
        const diagnostics = await page.evaluate(() => SocialMediaDownloader.getMediaBindingDiagnostics({ mode: 'main', target: 'image', limit: 1 }));
        assert.equal(diagnostics.status, 'bound');
        assert.equal(diagnostics.paintCarrierCount, 1);
        assert.doesNotMatch(JSON.stringify(diagnostics), /intended|pbs\.twimg|media_\d/);
        await page.evaluate(() => { document.getElementById('likes').textContent = '1591 Likes'; });
        const result = await page.evaluate(expectedMediaBinding => SocialMediaDownloader.run({
          mode: 'main', target: 'image', limit: 1, delayBetweenDownloads: 0, expectedMediaBinding,
        }), binding);
        assert.equal(result.stats.completed, 1);
        assert.deepEqual(await page.evaluate(() => effects), { fetches: [binding.candidates[0].url], clicks: 1, scrolls: 0 });
      } finally { await browser.close(); }
    });

    test(`${build}: noninteractive React Native paint accepts only its immediate image wrapper`, async () => {
      const { browser, page } = await fixture(engine, build, 'sibling');
      try {
        await page.evaluate(() => { document.getElementById('paint-sibling').style.pointerEvents = 'none'; });
        const binding = (await page.evaluate(captureMediaDownloadBindingInPage)).image;
        assert.ok(binding?.sources[0].paintCarrier);
        const result = await page.evaluate(expectedMediaBinding => SocialMediaDownloader.run({
          mode: 'main', target: 'image', limit: 1, delayBetweenDownloads: 0, expectedMediaBinding,
        }), binding);
        assert.equal(result.stats.completed, 1);
      } finally { await browser.close(); }
    });

    for (const change of ['background', 'carrier', 'image', 'hidden', 'geometry']) test(`${build}: changed ${change} paint binding cannot dispatch`, async () => {
      const { browser, page } = await fixture(engine, build);
      try {
        const binding = (await page.evaluate(captureMediaDownloadBindingInPage)).image;
        assert.ok(binding);
        await page.evaluate(kind => {
          const paint = document.getElementById('paint'), image = document.getElementById('photo');
          if (kind === 'background') paint.style.backgroundImage = 'url("https://pbs.twimg.com/media/other.jpg")';
          if (kind === 'carrier') {
            const replacement = paint.cloneNode(false); replacement.appendChild(image); paint.replaceWith(replacement);
          }
          if (kind === 'image') image.src = 'https://pbs.twimg.com/media/other.jpg';
          if (kind === 'hidden') paint.style.visibility = 'hidden';
          if (kind === 'geometry') image.style.width = '100px';
        }, change);
        const result = await page.evaluate(expectedMediaBinding => SocialMediaDownloader.run({
          mode: 'main', target: 'image', limit: 1, delayBetweenDownloads: 0, expectedMediaBinding,
        }), binding);
        assert.equal(result.noDispatch, true);
        assert.equal(result.errorCode, 'media_binding_changed');
        assert.deepEqual(await page.evaluate(() => effects), { fetches: [], clicks: 0, scrolls: 0 });
      } finally { await browser.close(); }
    });

    test(`${build}: unrelated visible background cannot make a transparent backing IMG bindable`, async () => {
      const { browser, page } = await fixture(engine, build);
      try {
        await page.evaluate(() => { document.getElementById('paint').style.backgroundImage = 'url("https://pbs.twimg.com/media/other.jpg")'; });
        assert.equal((await page.evaluate(captureMediaDownloadBindingInPage)).image, null);
        const diagnostics = await page.evaluate(() => SocialMediaDownloader.getMediaBindingDiagnostics({ target: 'image' }));
        assert.equal(diagnostics.status, 'unavailable');
        assert.equal(diagnostics.reason, 'no_visible_media');
        assert.doesNotMatch(JSON.stringify(diagnostics), /intended|other\.jpg|pbs\.twimg/);
      } finally { await browser.close(); }
    });

    test(`${build}: changing paint during fetch cannot save the obsolete resource`, async () => {
      const { browser, page } = await fixture(engine, build);
      try {
        const binding = (await page.evaluate(captureMediaDownloadBindingInPage)).image;
        const result = await page.evaluate(async expectedMediaBinding => {
          window.fetch = async url => {
            effects.fetches.push(url);
            document.getElementById('paint').style.backgroundImage = 'url("https://pbs.twimg.com/media/other.jpg")';
            return { ok: true, blob: async () => new Blob(['old image']) };
          };
          return SocialMediaDownloader.run({ mode: 'main', target: 'image', limit: 1, delayBetweenDownloads: 0, expectedMediaBinding });
        }, binding);
        assert.equal(result.noDispatch, true);
        assert.deepEqual(await page.evaluate(() => effects), { fetches: [binding.candidates[0].url], clicks: 0, scrolls: 0 });
      } finally { await browser.close(); }
    });

    test(`${build}: image binding excludes a larger focused video before scoring`, async () => {
      const { browser, page } = await fixture(engine, build);
      try {
        await page.evaluate(() => {
          const video = document.createElement('video');
          video.src = 'https://video.twimg.com/intended-video.mp4';
          video.style.cssText = 'position:fixed;left:550px;top:0;width:700px;height:700px';
          document.querySelector('[aria-modal=true]').appendChild(video);
        });
        const bindings = await page.evaluate(captureMediaDownloadBindingInPage);
        assert.match(bindings.image.candidates[0].url, /intended\.jpg/);
        assert.match(bindings.video.candidates[0].url, /intended-video\.mp4/);
        assert.equal(bindings.image.candidates[0].type, 'image');
        assert.equal(bindings.video.candidates[0].type, 'video');
      } finally { await browser.close(); }
    });
  }
}
