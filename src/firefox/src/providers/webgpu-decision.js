// Firefox has no in-browser WebGPU chat runtime, so the chat model cannot
// answer decisions here; the decision settings never offer it.
export async function evaluateWebgpuDecision() {
  throw new Error('In-browser chat-model decisions are available in Chrome only.');
}
