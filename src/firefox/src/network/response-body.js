/** Shared ownership of response readers: cancellation, idle deadlines and byte limits. */
export function responseAbortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

export function createResponseReader(response, { signal, idleTimeoutMs = 120000 } = {}) {
  const reader = response.body.getReader();
  let closed = false;
  let interrupted = null;
  let rejectRead = null;
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    // A broken source's cancel promise must not hold completion or Stop open.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  };
  const interrupt = (error) => {
    interrupted = error;
    rejectRead?.(error);
    close();
  };
  const onAbort = () => interrupt(responseAbortError(signal));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    close,
    async read() {
      if (interrupted) throw interrupted;
      if (closed) return { done: true, value: undefined };
      let timer;
      const interruption = new Promise((_, reject) => {
        rejectRead = reject;
        if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) {
          timer = setTimeout(() => {
            const error = new Error(`Response body stalled for ${idleTimeoutMs}ms.`);
            error.name = 'TimeoutError';
            error.code = 'response_body_timeout';
            // A generation may already be billed. Do not silently retry it.
            error.isAskStreamTerminalError = true;
            interrupt(error);
          }, idleTimeoutMs);
        }
      });
      try {
        return await Promise.race([reader.read(), interruption]);
      } finally {
        clearTimeout(timer);
        rejectRead = null;
      }
    },
  };
}

export async function readResponseText(response, { maxBytes, ...options } = {}) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  if (!response?.body?.getReader) {
    if (options.signal?.aborted) throw responseAbortError(options.signal);
    const text = await response.text();
    const bytesRead = new TextEncoder().encode(text).length;
    return { text, bytesRead, exceeded: !!(limit && bytesRead > limit) };
  }
  const reader = createResponseReader(response, options);
  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const allowed = limit ? Math.min(chunk.byteLength, Math.max(0, limit - bytesRead)) : chunk.byteLength;
      text += decoder.decode(chunk.subarray(0, allowed), { stream: true });
      bytesRead += allowed;
      if (allowed < chunk.byteLength) {
        return { text: text + decoder.decode(), bytesRead, exceeded: true };
      }
    }
    return { text: text + decoder.decode(), bytesRead, exceeded: false };
  } finally {
    reader.close();
  }
}

export function createRequestDeadline({ signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(responseAbortError(signal));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`Request timed out after ${timeoutMs}ms.`);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    },
  };
}
