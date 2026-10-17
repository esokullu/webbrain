# In-browser WebGPU models: checklist and lessons

Read this before adding, replacing or re-exporting a model for the Chromium
**WebGPU (In-browser)** provider (`src/chrome/src/providers/webgpu.js`,
`src/chrome/src/offscreen/inference-worker.js`). It records what made Ternary
Bonsai 2 unusable in the browser and the checks that would have caught it.

## What went wrong with Bonsai 2

Asking Bonsai 2 2B Vision to "summarize this page" took many minutes and froze
the desktop, on an RTX 5090 and on an M4 Max alike. Five independent causes
stacked up:

1. **Token-by-token prefill on the CPU.** The upstream language graph
   (`danyalmalik/Ternary-Bonsai-2-*-ONNX-WebGPU`, the same pattern as
   `onnx-community/Qwen3.5-*-ONNX`) computes every GatedDeltaNet prefill with an
   ONNX `Scan` over tokens. ONNX Runtime Web's WebGPU execution provider has no
   `Scan` (or `Loop`) kernel, so the node is placed on the CPU and its body runs
   once per token, with a GPU round trip, in each of 18 layers (24 for 4B).
   That costs about 6.5 ms per prompt token per layer: 0.13 s per prompt
   token for 2B and 0.19 s for 4B on an RTX 5090. A faster GPU barely helps,
   because the time goes to synchronisation, not compute.
2. **Logits for every prompt token.** The graph's `logits` output was
   `[batch, sequence_length, 248320]`, so prefill ran the LM head over the
   whole prompt and downloaded about 0.5 MB of FP16 scores per prompt token.
   Above roughly 4.3k tokens that output also exceeds the 2 GB maximum buffer
   size many WebGPU adapters report.
3. **The wrong GPU.** Chrome runs WebGPU on the adapter its GPU process uses.
   On a Windows machine with an RTX 5090 and a small display card (T400), every
   `powerPreference` returned the T400, which also drives the monitors. The model
   saturated it and the whole desktop stalled while the 5090 sat idle.
4. **One giant prefill pass.** Even with a fixed graph, a ~9k-token prompt in a
   single decoder pass keeps a GPU that is shared with the display (Apple
   silicon, a display-attached card) busy for seconds, and the desktop stutters.
5. **Large prompts.** Ask mode sends the full Ask system prompt (~3k tokens)
   plus 17 tool schemas (~6k tokens) to in-browser models on every call,
   because the compact tier currently only changes Act mode.

Two process gaps let this ship. The production harness
(`scripts/check-bonsai-webgpu.mjs`) only uses prompts of a few dozen tokens,
which hide prefill problems entirely. And graph files were replaced under
an already-cached URL, which installed copies never re-fetch.

## Checklist for a new or re-exported model

Do all of these on the exact files you will publish.

1. **Static graph audit.**

   ```bash
   python scripts/models/audit_webgpu_onnx.py path/to/decoder.onnx
   ```

   It exits non-zero for `Scan`/`Loop` anywhere in the graph (including `If`
   branches) and for a `logits` output that keeps the sequence dimension.
   `If` is fine; it has a WebGPU kernel. The original Bonsai 2 and
   `onnx-community/Qwen3.5` decoders fail this check. Compass Tiny,
   `Mike0021/Ternary-Bonsai-2-4B-text-ONNX` (which uses the
   `com.microsoft::LinearAttention` and `CausalConvWithState` contrib ops) and
   the rewritten Bonsai 2 Vision graphs pass.
   - A `num_logits_to_keep` input is not enough on its own. On the
     multimodal forward path Transformers.js passes `0` (keep all), so slice to
     the last position inside the graph, as `chunk_gdn_prefill.py` does.
2. **Node placement on real WebGPU.** Create the session in a browser with
   `ort.env.logLevel = 'verbose'` and `logSeverityLevel: 0`, then read the
   `Node placements` block. Small shape ops (`Shape`, `Gather`, `Equal` on
   int64) belong on the CPU. Any compute op reported as
   `webgpu kernel not found in registries` is a red flag.
3. **Long prompts and prefill scaling.** The short harness prompts cannot show
   prefill problems. Run real prompts of about 1k, 4k and 8k tokens, plus a
   long prompt with an image for vision models, through the production
   worker on hardware WebGPU:

   ```bash
   node scripts/check-webgpu-long-prompts.mjs --model <owner/repo> --vision \
     --profile <cached profile> --offline --lengths 1000,4000,8000 --slices 0,512
   ```

   It prints wall time and seconds per 1k prompt tokens for each prompt, and
   fails if the greedy answer changes between slice sizes. Seconds per 1k
   tokens should stay roughly flat and around a second or less on a desktop
   GPU. Tens of seconds per 1k tokens that scale linearly mean a CPU
   fallback. Reference for rewritten Bonsai 2 2B on an RTX 5090 (48 new
   tokens, including decode): 3k tokens in 2.5 s and 8k in 5.6 s in one pass,
   7.8 s in 512-token slices. In a decoder-only benchmark, 4B prefilled 8,192
   tokens in 16 s. The original Scan graph took 128 s for 1,024 tokens.
4. **Production harness.** Run `scripts/check-bonsai-webgpu.mjs` online and
   `--offline` (with `--vision --image-history` for vision models) and record
   the evidence with `scripts/models/bonsai/record_browser_validation.py`.
5. **Memory.** Budget weights, plus KV and recurrent cache for the browser
   context, plus transient prefill buffers. Keep every single tensor under
   2 GB, the per-buffer limit on many adapters.
6. **Rollout.** Browsers keep files cached by URL. If a published file
   changes in place, existing installs never see it unless the worker
   refreshes it explicitly (see "Updating a published graph").

## Fixing a Qwen3.5 / GatedDeltaNet export

Use the tools in `scripts/models/bonsai/`:

- `chunk_gdn_prefill.py` replaces every GatedDeltaNet `Scan` with the
  chunked gated delta rule and slices the LM head to the last position.
  Weights and the `.onnx_data` file stay byte-identical; only the small graph
  file changes. Decode keeps the original single-token branch.
  - 128-token chunks. Inside a chunk, the unit lower-triangular WY inverse uses
    **recursive block inversion**. A Neumann-product inverse is shorter but
    overflows FP32 when keys in a chunk are strongly correlated.
  - Across chunks, a Hillis-Steele prefix scan over the affine state maps runs
    with `If`-skipped steps. The step count is derived from
    `text_config.max_position_embeddings`, so every accepted prompt length
    stays correct. Chunks must be powers of two from 16 to 1024.
- `validate_chunked_gdn.py` compares old and new graphs on CPU with real text.
  It covers chunk-boundary lengths, a multi-chunk prompt, a cached continuation,
  logits, every cache output (whole-tensor and worst-element error) and
  finiteness. It reads the chunk size from the rewritten graph.
- `make_chunked_bundle.py` derives a sealed bundle. It writes model-card
  parity and timing claims only from evidence that passes the verifier (both
  graph hashes, chunk coverage, top-1 and decode equality, FP16 tolerances).
  It drops browser evidence recorded against the previous graph and keeps
  native vision parity only while its encoder hashes still match.
- `build_vision.py` applies the rewrite on full rebuilds.

## Runtime behaviour to keep

- **Sliced prefill.** For the Bonsai 2 Vision presets the worker prefills
  long prompts in 512-token slices that carry the recurrent, conv and KV
  cache, then lets `generate()` continue from that cache. Greedy answers are
  identical to a single pass. Each extra slice adds roughly one decoder run of
  fixed overhead (about 0.14 s on an RTX 5090). The `chrome.storage.local` key
  `webgpuPrefillSliceTokens` overrides the slice (64–8192, `0` disables).
  Apply the same pattern to any new model that serves long prompts on shared
  GPUs.
- **Cache-only inference.** Chat never downloads. Only explicit download or
  preload flows fetch model files.

## Updating a published graph

Prefer a new repository or file name for a changed graph. If a file must
change in place, as the Bonsai 2 Vision decoders did:

- Pin the new file's SHA-256 in the worker (`BONSAI2_DECODER_GRAPH_SHA256`).
- Inference only detects a stale cached graph and keeps using it.
- An explicit download or preload replaces just that file, verified by hash,
  with a 15 s deadline and no attempt while known offline. It then drops the
  resident session built from the old graph.
- Never block or break offline use to force an update.

## Diagnosing a slow or stuttering user machine

- In a normal tab, run
  `(await navigator.gpu.requestAdapter({powerPreference: 'high-performance'})).info`
  to see the adapter Chrome uses. On Windows, compare it with `nvidia-smi` or
  Task Manager.
- To move Chrome to another GPU on Windows, use Settings → System → Display →
  Graphics → Chrome, or start Chrome with `--use-adapter-luid=<high>,<low>`.
  Use **decimal** values: the hex form gave no adapter in Chromium 147. Find a
  LUID with PowerShell, matching adapters by dedicated memory use:
  `(Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples`.
- Stutter while the GPU is shared with the display is expected for long
  single passes. Lower `webgpuPrefillSliceTokens` (for example to 256) and keep
  prompts short.

## Open items

- The Bonsai 2 2B **text** preset still points at
  `danyalmalik/Ternary-Bonsai-2-2B-ONNX-WebGPU`, which fails the audit. Publish
  a rewritten text repository or point the preset at a passing graph.
- Ask mode should use a compact prompt and a smaller tool set for in-browser
  models.
