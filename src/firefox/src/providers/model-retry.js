export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const ms = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function cancelled(isAborted) {
  if (isAborted()) throw new DOMException('The operation was aborted', 'AbortError');
}

/** Recover a single inference turn; completed browser tools are never replayed. */
export async function retryModelCall(initialError, call, {
  isAborted = () => false,
  onRetry = async () => {},
  sleep = async ms => {
    while (ms > 0) {
      cancelled(isAborted);
      const chunk = Math.min(ms, 250);
      await new Promise(resolve => setTimeout(resolve, chunk));
      ms -= chunk;
    }
  },
} = {}) {
  const rateLimited = initialError?.httpStatus === 429;
  const delays = rateLimited ? [5000, 15000, 30000] : [2000];
  let error = initialError, waited = 0;
  for (let i = 0; i < delays.length; i++) {
    cancelled(isAborted);
    const hint = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
    const delayMs = Math.max(delays[i], hint);
    // Never disregard a provider's longer cooldown or keep a run indefinitely.
    if (waited + delayMs > 60000) throw error;
    await onRetry({ error, delayMs, attempt: i + 1 });
    await sleep(delayMs);
    waited += delayMs;
    cancelled(isAborted);
    try { return await call(); }
    catch (next) {
      error = next;
      if (!rateLimited || error?.httpStatus !== 429) throw error;
    }
  }
  throw error;
}
