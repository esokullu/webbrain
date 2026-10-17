export const D1_MODEL_ID = 'webbrain-one/d1-browser-decision-fp16';
export const D1_CONSENT_VERSION = 1;
export const D1_CONSENT_KEY = 'd1WebgpuConsentVersion';
export const D1_CACHE_NAME = 'webbrain-d1-fp16-v1';
// Immutable release package; downloaded data is verified before local loading.
export const D1_RELEASE = Object.freeze({ revision: 'd4916f0c47d46f16e7876e425eb12a122671d3eb', manifestSha256: 'a94fb80ba47cc6c3e05cc3dbda45f9f2b99f4f1999b0770a0a09ba59e0c861ed' });
export const D1_REQUIRED_FILES = Object.freeze(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'tiling-ratios.json', 'onnx/decision.onnx', 'onnx/decision.data', 'onnx/vision.onnx', 'onnx/vision.data', 'onnx/projector.onnx', 'onnx/projector.data']);

export function d1BaseURL() {
  if (!/^[a-f0-9]{40}$/.test(D1_RELEASE.revision) || !/^[a-f0-9]{64}$/.test(D1_RELEASE.manifestSha256)) throw new Error('The experimental D1 package is not pinned in this build.');
  return `https://huggingface.co/${D1_MODEL_ID}/resolve/${D1_RELEASE.revision}/`;
}

export function d1AdapterInfo(adapter) {
  const info = adapter?.info || {};
  return { vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '', description: info.description || '', isFallbackAdapter: adapter?.isFallbackAdapter ?? info.isFallbackAdapter ?? null };
}

export function assertD1Adapter(adapter) {
  if (!adapter) throw new Error('Hardware WebGPU is unavailable.');
  const info = d1AdapterInfo(adapter);
  if (info.isFallbackAdapter === true || /swiftshader|llvmpipe|software|lavapipe/i.test(Object.values(info).join(' '))) throw new Error('D1 requires hardware WebGPU, not a software adapter.');
  // The FP16 [65536,1024] embedding is one 128 MiB Gather storage input (the
  // WebGPU default limit). Attention batches adapt to the binding limit.
  if (adapter.limits.maxBufferSize < 134217728 || adapter.limits.maxStorageBufferBindingSize < 134217728) throw new Error('D1 requires at least 128 MiB buffer and storage-binding limits for its FP16 embedding.');
  return info;
}
