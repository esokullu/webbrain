# Compass Tiny XS v3.1 WebGPU integration validation

Validated on 2026-09-26 in the `webbrain-one` worktree for the v3 package, and
re-pinned on 2026-09-29 to the v3.1 public 32k package. Tiny v2.1 remains the
default; XS is an opt-in noncommercial research preview in both Settings →
Providers → WebGPU and Apocalypse Mode → Text Model.

## Tested package and runtime

- Repository: `webbrain-one/webbrain-compass-tiny-xs-v3.1-onnx` (public).
- Pinned release revision: `fb269bc28350a646e484b97c25a7ba756c2db83b`.
- Superseded: the v3 repository was private, pinned at revision
  `c5cfd97d5ee5a94ca5dc515f09e6103c22fbe36c` at a 4,096 token deployment
  context. Its cache is keyed by that revision and is not reused.
- Spark-X2.5-1.7B fine-tune; native FP16 storage / FP32 GEMM graph, not q4f16.
- Bundled ONNX Runtime Web 1.27.0 and Transformers.js 4.2.0 tokenizer; native
  Jinja template, thinking disabled, greedy decoding, no helper/cloud fallback.
- Windows, Chromium 147.0.7727.15, NVIDIA RTX 5090 / Blackwell with `shader-f16`.
  The harness explicitly selected GPU0; it did not load the model on GPU1/T400.
- Total context 32,768 tokens; output at most 2,048 tokens. Prefill is chunked at
  the graph's validated 512 tokens. All seven model data files have fixed byte
  lengths and SHA-256 hashes in `spark-runtime.js`.

## What changed from v3 to v3.1

The context window moved from 4,096 to 32,768 tokens. Spark-X2.5 uses RoPE
rather than learned position embeddings and declares `max_position_embeddings`
of 1,048,576, so the ONNX graph and its external weight file are byte-identical
between the two releases — `onnx/model_fp16.onnx` and `onnx/model_fp16.onnx_data`
have the same SHA-256 in both, as do the tokenizer, template and generation
config. The only changed data file is `graph-abi.json`, which declares
`deploymentContextTokens: 32768`, `prefillChunkTokens: 512`,
`contextTested: [4096, 8192, 32768]` and `validationStatus: passed`.

The runtime gained 512-token chunked prefill as a result. The previous code fed
the whole prompt in one `session.run`, which at 32k would materialise a
full-context attention score matrix on each of the seven full-attention layers
and exhaust GPU memory before generation started.

## Limits of this record

The 32,768 numerical validation is the package producer's record, not an
independent run in this worktree; it reports a 32,765-token prefill against a
reference with relative RMS 0.003–0.005 and cosine 0.99999. The 4,096 and 8,192
candidates are retained in the package under
`provenance/failed-candidates/`, where relative RMS reached 0.027 against a
0.02 threshold, and the package's first 32k runtime attempt is recorded as a
local Windows transport timeout that passed on a clean rerun rather than a
numerical mismatch. Re-run `npm run test:spark-webgpu:browser` on target
hardware to reproduce; this file has not been updated with a fresh 32k
integration run. This is an integration smoke test, not a new agent benchmark
or a claim of better model quality.

## Reproduce

Run `npm run test:spark-webgpu` for the CPU unit checks. For the opt-in real GPU
smoke, point `SPARK_WEBGPU_TEST_BUNDLE` at the original verified ONNX bundle
containing tokenizer/template/ABI files and `onnx/model_fp16.onnx` plus its
external data file, then run `npm run test:spark-webgpu:browser`.

On multi-GPU Windows hosts, set `SPARK_WEBGPU_TEST_ADAPTER_LUID` to the intended
adapter's DXGI `high,low` pair before running. The current harness requires an
RTX 5090/Blackwell adapter and fails before model loading on another adapter.
It uses an isolated temporary Chromium extension profile and about 4 GB of
temporary disk cache, deletes only that profile afterward, and leaves user
browsers and model servers untouched.

The browser harness supplies local pinned bytes through the production
streaming size/hash verifier. It then runs real inference through the
background → offscreen worker → native WebGPU graph path without any token or
HF access. This is **not** an end-to-end live private-HF authentication test.
HTTP 401 handling, download-only credential forwarding, corruption and
truncation rejection are covered separately by unit tests.

## Results

- All 9 focused unit tests passed.
- Real extension cache verification, offline readiness and native graph loading
  passed. Synthetic greeting output: `Hello! How can I help?`.
- The original package's native `open_url` probe emitted the native Spark
  `<tool_call>` format and passed WebBrain's existing allowlisted parser with
  URL `https://example.com`. No actual browser action was dispatched.
- Settings stored XS with 4K context and a 2,048-token output cap (v3 run;
  the v3.1 re-pin changes this to 32k, not re-validated here). Apocalypse
  hydrated that selection and switched XS ↔ Tiny v2.1 without changing the
  active chat provider. Tiny v2.1 remained the install default.
- Stop/remove released the XS runtime and deleted its cache; an unrelated
  Tiny v2.1 cache sentinel remained intact. The temporary profile was removed.
- Provider-limit checks passed. Security checks passed (60/60); unpacked build
  checks passed (4/4).
- Main regression runner: 2,393 passed, 6 failed. The failures concern licensing
  metadata/FAQ consistency, chat-history whitespace, subscribe-error DOM
  clearing, streamed tool-text suppression, watch-alert audio, and terminal
  scheduled clarification rendering. Those source areas were not changed by
  this integration; the full suite is not green. The aggregate `npm test` also
  encountered a SystemOne Jev-trace fixture import failure on this Windows host.

## Limits retained, not repaired

A synthetic arithmetic fixture answered `7` as plain text rather than using
the requested `done` tool. The BF16 reference produced the same observed
plain-text answer. The output was retained without repair; a successful native
tool smoke does not imply universal instruction following or agent success.
This run does not establish support for other GPUs, long real-world tasks,
commercial use, or comparative model superiority. It does not replace the
separate package numerical-validation record or the published BF16 benchmark.
