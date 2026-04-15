/**
 * Image utilities for the CDP client.
 *
 * Runs in the MV3 service worker, which has OffscreenCanvas and
 * createImageBitmap but no DOM. That's enough to decode base64 PNG tiles,
 * composite them, and re-encode.
 *
 * Nothing here throws into the caller — every utility returns either the
 * combined image or a sensible fallback so full-page captures never go
 * silently empty just because one tile failed to decode.
 */

/**
 * Stitch a grid of viewport screenshots into a single full-page image.
 *
 * @param {Array<{x:number,y:number,width:number,height:number,data:string}>} tiles
 *   Base64 PNG tiles with CSS-pixel positions. Coordinates are in CSS
 *   pixels; the tile's bitmap is at native surface resolution
 *   (CSS × dpr).
 * @param {number} cssWidth   Total content width in CSS pixels.
 * @param {number} cssHeight  Total content height in CSS pixels.
 * @param {number} [dpr=2]    Device pixel ratio used when the tiles were
 *   captured. captureFullPageScreenshot pins this at 2.
 * @returns {Promise<string>} Combined image as base64 PNG (no data: prefix),
 *   matching the return shape the caller expects.
 */
export async function combineImages(tiles, cssWidth, cssHeight, dpr = 2) {
  if (!Array.isArray(tiles) || tiles.length === 0) return '';

  // Decode every tile in parallel. Bad tiles are dropped rather than
  // aborting the whole composite — a partial full-page image is more useful
  // to the agent than nothing.
  const decoded = await Promise.all(
    tiles.map(async (t) => {
      try {
        const blob = await (await fetch(`data:image/png;base64,${t.data}`)).blob();
        const bmp = await createImageBitmap(blob);
        return { ...t, bmp };
      } catch {
        return null;
      }
    })
  );

  const goodTiles = decoded.filter(Boolean);
  if (goodTiles.length === 0) return '';

  // Canvas dims are native pixels. Guard against the occasional 0-dim input
  // (empty page, very short pages where contentHeight == 0).
  const canvasW = Math.max(1, Math.round(cssWidth * dpr));
  const canvasH = Math.max(1, Math.round(cssHeight * dpr));
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');
  if (!ctx) return goodTiles[0]?.data || tiles[0]?.data || '';

  for (const t of goodTiles) {
    const dx = Math.round(t.x * dpr);
    const dy = Math.round(t.y * dpr);
    // Draw the whole bitmap — its intrinsic size already matches the
    // tile's CSS width/height × dpr. If it's larger than the destination
    // slot (e.g. last-row or last-column tiles captured at native viewport
    // even though only part is content), clip via width/height args.
    const dw = Math.min(bmpWidth(t.bmp), canvasW - dx);
    const dh = Math.min(bmpHeight(t.bmp), canvasH - dy);
    if (dw <= 0 || dh <= 0) continue;
    try {
      ctx.drawImage(t.bmp, 0, 0, dw, dh, dx, dy, dw, dh);
    } catch {
      // Skip the tile; keep compositing the rest.
    }
  }

  // Re-encode as PNG, return base64 (no data URL prefix).
  try {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await blob.arrayBuffer();
    return arrayBufferToBase64(buf);
  } catch {
    // Final fallback: return the first tile rather than ''.
    return tiles[0]?.data || '';
  }
}

function bmpWidth(bmp) { return bmp?.width || 0; }
function bmpHeight(bmp) { return bmp?.height || 0; }

/**
 * Encode an ArrayBuffer to base64 without blowing the call stack on large
 * buffers (a full-page screenshot can easily be 10+ MB).
 */
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
