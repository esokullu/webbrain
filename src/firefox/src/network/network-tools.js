/**
 * Network & download tools for the WebBrain agent (Firefox).
 *
 * Same surface as the chrome version but uses browser.* APIs and
 * browser.tabs.executeScript instead of chrome.scripting.executeScript.
 * MV2 background pages support DOMParser, but we use the same regex
 * stripping for consistency with the chrome MV3 service worker version.
 */

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&#160;': ' ',
  '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
  '&laquo;': '«', '&raquo;': '»', '&copy;': '©', '&reg;': '®',
  '&trade;': '™',
};

function decodeEntities(s) {
  return s
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => HTML_ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function htmlToText(html) {
  if (!html) return { title: '', text: '' };
  let s = html;
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
  s = s.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|article|section|header|footer)[^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: s };
}

const FETCH_TEXT_LIMIT = 8000;
const FETCH_JSON_LIMIT = 16000;

export async function fetchUrl(url, opts = {}) {
  if (!url) return { success: false, error: 'url is required' };
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body || undefined,
      credentials: 'include',
      redirect: 'follow',
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const status = res.status;
    const finalUrl = res.url;

    if (contentType.includes('json')) {
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      return {
        success: true, status, contentType, url: finalUrl,
        json: pretty.slice(0, FETCH_JSON_LIMIT),
        truncated: pretty.length > FETCH_JSON_LIMIT,
        originalLength: pretty.length,
      };
    }

    if (contentType.includes('html') || contentType.includes('xhtml')) {
      const html = await res.text();
      const { title, text } = htmlToText(html);
      return {
        success: true, status, contentType, url: finalUrl, title,
        text: text.slice(0, FETCH_TEXT_LIMIT),
        truncated: text.length > FETCH_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    if (contentType.startsWith('text/') ||
        contentType.includes('xml') ||
        contentType.includes('javascript') ||
        contentType.includes('csv') ||
        contentType.includes('markdown') ||
        contentType === '') {
      const text = await res.text();
      return {
        success: true, status, contentType, url: finalUrl,
        text: text.slice(0, FETCH_TEXT_LIMIT),
        truncated: text.length > FETCH_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    const len = res.headers.get('content-length');
    return {
      success: true, status, contentType, url: finalUrl,
      note: 'Binary content not inlined. Use download_file({url}) then read_downloaded_file({downloadId}) if you need contents.',
      sizeBytes: len ? parseInt(len, 10) : null,
    };
  } catch (e) {
    return { success: false, error: `Fetch failed: ${e.message}` };
  }
}

export async function researchUrl(url, opts = {}) {
  if (!url) return { success: false, error: 'url is required' };
  const timeoutMs = Math.min(opts.timeout || 8000, 30000);
  let createdTab = null;
  try {
    const createProps = { url, active: false };
    if (opts.sourceTabId != null) {
      try {
        const sourceTab = await browser.tabs.get(opts.sourceTabId);
        if (sourceTab?.windowId != null) createProps.windowId = sourceTab.windowId;
        if (typeof sourceTab?.index === 'number') createProps.index = sourceTab.index + 1;
        if (sourceTab?.id != null) createProps.openerTabId = sourceTab.id;
      } catch (_) {}
    }
    createdTab = await browser.tabs.create(createProps);
    const tabId = createdTab.id;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        browser.tabs.onUpdated.removeListener(listener);
        reject(new Error(`research_url timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === 'complete') {
          clearTimeout(t);
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      browser.tabs.onUpdated.addListener(listener);
    });

    await new Promise(r => setTimeout(r, 800));

    const code = `
      (() => {
        const title = document.title || '';
        const url = location.href;
        const main = document.querySelector('main, article, [role="main"]');
        let root = main || document.body;
        const clone = root.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, iframe, header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navigation, .header, .footer, .sidebar').forEach(el => el.remove());
        const text = (clone.innerText || clone.textContent || '').trim();
        const links = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 50)
          .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }))
          .filter(l => l.text && l.href && !l.href.startsWith('javascript:'));
        return { title, url, text, originalLength: text.length, links };
      })()
    `;
    const results = await browser.tabs.executeScript(tabId, { code });
    const result = results?.[0];
    if (!result) return { success: false, error: 'extraction returned nothing' };

    return {
      success: true,
      url: result.url,
      title: result.title,
      text: (result.text || '').slice(0, FETCH_TEXT_LIMIT),
      truncated: (result.originalLength || 0) > FETCH_TEXT_LIMIT,
      originalLength: result.originalLength,
      links: result.links?.slice(0, 30) || [],
    };
  } catch (e) {
    return { success: false, error: `research_url failed: ${e.message}` };
  } finally {
    if (createdTab?.id != null) {
      browser.tabs.remove(createdTab.id).catch(() => {});
    }
  }
}

export async function listDownloads(opts = {}) {
  try {
    const limit = Math.min(opts.limit || 10, 50);
    const items = await browser.downloads.search({
      orderBy: ['-startTime'],
      limit,
      exists: true,
    });
    return {
      success: true,
      count: items.length,
      downloads: items.map(d => ({
        id: d.id,
        url: d.url,
        filename: d.filename,
        state: d.state,
        bytesReceived: d.bytesReceived,
        totalBytes: d.totalBytes,
        startTime: d.startTime,
        endTime: d.endTime || null,
        mime: d.mime || '',
        paused: d.paused || false,
      })),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const READ_FILE_TEXT_LIMIT = 16000;
const READ_FILE_BASE64_LIMIT = 32000;

export async function readDownloadedFile(downloadId) {
  if (downloadId == null) return { success: false, error: 'downloadId is required' };
  try {
    const items = await browser.downloads.search({ id: downloadId });
    if (items.length === 0) return { success: false, error: `Download #${downloadId} not found` };
    const item = items[0];
    if (item.state !== 'complete') {
      return { success: false, error: `Download is in state: ${item.state}, not complete` };
    }
    const res = await fetch(item.url, { credentials: 'include' });
    if (!res.ok) {
      return { success: false, error: `Re-fetch failed with HTTP ${res.status}` };
    }
    const ct = (item.mime || res.headers.get('content-type') || '').toLowerCase();

    if (ct.startsWith('text/') ||
        ct.includes('json') ||
        ct.includes('xml') ||
        ct.includes('javascript') ||
        ct.includes('csv') ||
        ct.includes('markdown') ||
        /\.(txt|md|csv|json|xml|html|js|ts|py|css|log|yaml|yml|toml|ini|conf|sh)$/i.test(item.filename)) {
      const text = await res.text();
      return {
        success: true,
        filename: item.filename,
        contentType: ct || 'text/plain',
        text: text.slice(0, READ_FILE_TEXT_LIMIT),
        truncated: text.length > READ_FILE_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    const buf = await res.arrayBuffer();
    const sizeBytes = buf.byteLength;
    if (sizeBytes > READ_FILE_BASE64_LIMIT * 0.75) {
      return {
        success: true,
        filename: item.filename,
        contentType: ct,
        sizeBytes,
        note: `Binary file too large to inline (${sizeBytes} bytes). On disk at: ${item.filename}`,
      };
    }
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return {
      success: true,
      filename: item.filename,
      contentType: ct,
      sizeBytes,
      base64: btoa(bin),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function downloadResourceFromPage(tabId, args = {}) {
  const { selector, filename } = args;
  if (!selector) return { success: false, error: 'selector is required' };
  try {
    const code = `
      (async () => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'element not found' };
        let url = el.src || el.href || el.currentSrc ||
                  el.getAttribute('data-src') || el.getAttribute('data-url') || '';
        if (!url) return { ok: false, error: 'element has no src/href/currentSrc/data-src' };
        if (url.startsWith('blob:')) {
          try {
            const res = await fetch(url);
            const blob = await res.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.onerror = () => reject(fr.error);
              fr.readAsDataURL(blob);
            });
            return { ok: true, url: dataUrl, isBlob: true, mime: blob.type, size: blob.size };
          } catch (e) {
            return { ok: false, error: 'failed to read blob URL: ' + e.message };
          }
        }
        return { ok: true, url, isBlob: false };
      })()
    `;
    const results = await browser.tabs.executeScript(tabId, { code });
    const r = results?.[0];
    if (!r?.ok) return { success: false, error: r?.error || 'extraction failed' };

    const downloadId = await browser.downloads.download({
      url: r.url,
      filename: filename || undefined,
      conflictAction: 'uniquify',
    });
    return {
      success: true,
      downloadId,
      sourceUrl: r.isBlob ? '[blob]' : r.url,
      mime: r.mime || null,
      blob: !!r.isBlob,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const DOWNLOAD_BATCH_CONCURRENCY = 3;
const DOWNLOAD_BATCH_MAX = 50;

export async function downloadFiles(args = {}) {
  const urls = args.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return { success: false, error: 'urls array is required' };
  }
  if (urls.length > DOWNLOAD_BATCH_MAX) {
    return { success: false, error: `Too many URLs (max ${DOWNLOAD_BATCH_MAX})` };
  }

  const results = new Array(urls.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= urls.length) return;
      const url = urls[i];
      try {
        const downloadId = await browser.downloads.download({
          url, conflictAction: 'uniquify',
        });
        results[i] = { url, downloadId, success: true };
      } catch (e) {
        results[i] = { url, success: false, error: e.message };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_BATCH_CONCURRENCY, urls.length) }, () => worker())
  );

  return {
    success: true,
    total: urls.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    downloads: results,
  };
}
