import { WebGPUProvider, WEBGPU_DECISION_MODEL_ID } from './webgpu.js';
import { splitD1State } from './d1-runtime.js';

// Decisions on the in-browser chat model (Ternary Bonsai 2 2B Vision and its
// trained probe). Runs in the offscreen WebGPU worker; nothing leaves the browser.
export async function evaluateWebgpuDecision({ state, images, questions, config, signal } = {}) {
  if (config?.model !== WEBGPU_DECISION_MODEL_ID) throw new Error('Only Ternary Bonsai 2 2B Vision answers in-browser decisions.');
  if (signal?.aborted) throw signal.reason;
  // Callers put screenshots in the state as image_url blocks (completion
  // checks, the Settings vision probe); the model takes them as images, as
  // D1 does, never as base64 text in the prompt.
  const input = splitD1State(state, images);
  const provider = new WebGPUProvider({ model: WEBGPU_DECISION_MODEL_ID });
  const result = await provider.decide({ state: input.state, images: input.images, questions });
  if (signal?.aborted) throw signal.reason;
  return { model: result.model, provider: 'webgpu_chat', answers: result.answers, usage: result.usage };
}
