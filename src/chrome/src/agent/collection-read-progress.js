// Only already-seen, finite sources can earn read progress. Keep registration
// bounded so cycling through pairs of fresh URLs cannot erase the cutoff.
const MAX_SOURCES = 8;
const MIN_NEW_CHARS = 1000;

function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function deliveredWindow(args, result) {
  if (String(args.method || 'GET').toUpperCase() !== 'GET'
      || args.find || args.body || args.replayRequestId
      || Object.keys(args.headers || {}).some(key => key.toLowerCase() === 'range')
      || result?.success !== true || result.error || result.noProgress
      || result.blocked || result.denied || result.skipped || result.cancelled
      || result.outcomeUnknown || result.inconclusive || result.verified === false
      || !(result.status >= 200 && result.status < 300) || result.status === 206
      || result.contentRange) return null;
  const field = typeof result.json === 'string' ? 'json' : 'text';
  const body = result[field];
  const { offset, originalLength, maxChars, nextOffset, hasMore } = result;
  const requestedOffset = args.offset === undefined ? 0 : args.offset;
  const url = sourceUrl(result.url);
  if (!url || url !== sourceUrl(args.url)
      || typeof body !== 'string' || !body.trim()
      || !Number.isSafeInteger(originalLength) || originalLength <= 0
      || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(requestedOffset) || requestedOffset < 0
      || offset !== Math.min(requestedOffset, originalLength)
      || maxChars !== body.length || offset + body.length > originalLength) return null;
  const end = offset + body.length;
  if (hasMore !== (end < originalLength)
      || nextOffset !== (hasMore ? end : null)) return null;
  return { url, field, start: offset, end, originalLength };
}

export function recordCollectionReadProgress(state, args = {}, result = null) {
  const current = state || { sources: new Map() };
  const window = deliveredWindow(args, result);
  if (!window) return { state: current, madeProgress: false };
  const { url, field, start, end, originalLength } = window;
  let source = current.sources.get(url);
  if (!source) {
    // A first read is discovery, not evidence of advancement. Full one-shot
    // responses have no remaining ranges to track.
    if (originalLength === end - start || current.sources.size >= MAX_SOURCES) {
      return { state: current, madeProgress: false };
    }
    source = { field, originalLength, ranges: [[start, end]], retired: false };
    current.sources.set(url, source);
    return { state: current, madeProgress: false };
  }
  if (source.field !== field || source.originalLength !== originalLength) {
    // Growing/changing representations cannot continually establish a new
    // baseline. A new task/run can legitimately start coverage again.
    source.retired = true;
  }
  if (source.retired) return { state: current, madeProgress: false };

  let newChars = end - start;
  for (const [coveredStart, coveredEnd] of source.ranges) {
    newChars -= Math.max(0, Math.min(end, coveredEnd) - Math.max(start, coveredStart));
  }
  const merged = [];
  for (const range of [...source.ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  source.ranges = merged;
  return {
    state: current,
    // Tiny shifts across a mostly repeated window are still observation
    // drift. Short final/serialization-constrained pages can advance in full.
    madeProgress: newChars >= Math.min(MIN_NEW_CHARS, end - start),
  };
}
