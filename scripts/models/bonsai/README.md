# Bonsai 2 vision ONNX builds

`build_vision.py` creates the 2B and 4B image-capable WebBrain model bundles.
It runs independently of the extension and has no effect on packaged JavaScript
dependencies. Generated files stay in the ignored `.build/bonsai` directory.

```powershell
uv venv --python 3.12 .build/bonsai/venv
uv pip install --python .build/bonsai/venv/Scripts/python.exe -r scripts/models/bonsai/requirements.txt
.build/bonsai/venv/Scripts/python.exe scripts/models/bonsai/build_vision.py
```

The default builds both sizes. `--size 2B` or `--size 4B` selects one. Use
`--offline` after all pinned source files have been downloaded. The sources are
public and the build explicitly downloads without credentials; do not put a
Hugging Face token in this directory, a command-line argument, or a model card.
The optional `--skip-inference` only skips the CPU vision graph smoke check and
records it as unverified; it does not bypass tensor and ONNX graph checks.
Rebuilding removes previously attached successful browser/native reports from
the export folder so new artifacts cannot inherit stale validation evidence.
Keep raw reports outside that folder and rerun validation after a rebuild.

The downloads total approximately 5.4 GB. Allow additional room for generated
vision graphs and browser caches. Unchanged language graphs are hardlinked into
the export directory on supported filesystems. The build does not upload files.

## Source and conversion contract

Each size has three revision-pinned inputs in the script:

- `prism-ml/Ternary-Bonsai-2-{2B,4B}-mlx-2bit`: original vision weights and license.
- `danyalmalik/Ternary-Bonsai-2-{2B,4B}-ONNX-WebGPU`: exact ternary language graphs,
  tokenizer and model configuration, including the required Hadamard transforms.
- `onnx-community/Qwen3.5-{2B,4B}-ONNX`: compatible vision graph topology and
  processor/tokenizer sidecars.

Every learned vision initializer is replaced from the matching Prism pack.
The export checks both directions of the tensor mapping: no unexported source
weights and no unmatched learned ONNX initializers. MLX Conv3D weights use
`[out,time,height,width,channels]`; ONNX flattened patches use
`[channels,time,height,width]`. Linear kernels are transposed. FP16 source values
are preserved exactly, with FP32 widening where the graph uses FP32 norms and
position embeddings. Generated constants and rotary frequencies remain in the
pinned topology.

The existing text embedding graph already applies the inverse Hadamard transform
and returns embeddings in the original residual basis. The restored vision
embeddings therefore need no extra Hadamard rotation. The decoder already accepts
Qwen's three-axis position IDs and hybrid attention caches.

## Parallel prefill graph

The danyalmalik language graphs compute GatedDeltaNet prefill with an ONNX
`Scan` over tokens. The WebGPU execution provider has no `Scan` kernel, so ONNX
Runtime runs it as a CPU loop with a GPU round trip per token per layer: about
0.13 s per prompt token for 2B and 0.19 s for 4B on an RTX 5090; a faster GPU
barely helps.
`chunk_gdn_prefill.py` replaces each `Scan` with the chunked gated delta rule
(128-token chunks, stable recursive block inversion inside a chunk, and a
parallel prefix scan across chunks, skipped by `If` when unneeded) and makes
the decoder return logits for the last position only. It uses only ops the
WebGPU EP implements. Weights and the `.onnx_data` file are unchanged, and
decode keeps the original single-token recurrent branch.

`build_vision.py` applies the rewrite. To derive a rewritten bundle from an
already sealed one without rebuilding the vision tower:

```powershell
.build/bonsai/venv/Scripts/python.exe scripts/models/bonsai/make_chunked_bundle.py --source .build/bonsai/exports/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision --output .build/bonsai/exports-chunked/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision --evidence .build/bonsai/chunked-cpu-2B.json --evidence .build/bonsai/chunked-webgpu-2B.json
```

`validate_chunked_gdn.py` compares the two graphs on CPU with real text:
prefills across chunk boundaries, a cached continuation, last-position logits,
every cache output and the following decode step; its `--output` report is the
CPU evidence for `make_chunked_bundle.py --evidence`. Attached reports are
checked against the bundle's graph hash and FP16 tolerances, and the model card
states parity or timing results only for reports that pass; otherwise it says
the evidence is pending, and a failing report stops the build. Browser evidence
recorded against the previous graph is not carried over; rerun the WebGPU
checks below on the new bundle. For the two webbrain-one Vision repositories
the worker compares the cached graph with a pinned SHA-256. Inference stays
cache-only and keeps using a stale graph; an explicit download of the model
replaces just the 3 MB graph file and keeps the cached weights.

The general lessons and the checklist for any in-browser model are in
[`docs/webgpu-models.md`](../../../docs/webgpu-models.md). Run
`scripts/models/audit_webgpu_onnx.py` on every decoder graph and
`scripts/check-webgpu-long-prompts.mjs` on every bundle before publishing.

## Runtime contract

Load `AutoProcessor` and `AutoModelForImageTextToText` with:

```javascript
{
  device: 'webgpu',
  dtype: {
    embed_tokens: 'q2f16',
    decoder_model_merged: 'q2f16',
    vision_encoder: 'fp16',
  },
}
```

The three ONNX graphs each have one external `.onnx_data` file. The exported
configuration adds the missing `q2f16: float16` cache dtype. The runtime must
support `MatMulNBits(bits=2)` and `GatherBlockQuantized`, Qwen3.5 recurrent state,
FP16 WebGPU shaders, and the Qwen image processor/chat template. Vision graph
inputs are `pixel_values: float32[num_patches,1536]` and
`image_grid_thw: int64[num_images,3]`. Output `image_features` is
`float32[num_patches/4,2048]` for 2B and `float32[num_patches/4,2560]` for 4B.

## Validation and publishing

Each bundle includes a model card, upstream LICENSE and NOTICE, SHA-256 manifest,
and `export-validation.json`. Validation checks full tensor coverage, serialized
tensor hashes, ONNX structural validity, finite outputs for square and rectangular
image grids, and different embeddings for different image pixels. These CPU graph
checks do not establish language answer quality or browser compatibility.

Before uploading, run `scripts/check-bonsai-webgpu.mjs` through the production
browser worker for text generation and independent image-only facts. It uses the
repository's Playwright dependency and installed Chromium; if Chromium is missing,
run `npx playwright install chromium`. Run one hardware verification at a time.
From the repository root in PowerShell:

```powershell
$bonsaiSize = '2B'
$bonsaiRepo = "webbrain-one/Ternary-Bonsai-2-$bonsaiSize-ONNX-WebGPU-Vision"
$bonsaiBundle = ".build/bonsai/exports/Ternary-Bonsai-2-$bonsaiSize-ONNX-WebGPU-Vision"
$bonsaiProfile = ".build/bonsai/vision-$bonsaiSize-profile"
node scripts/check-bonsai-webgpu.mjs --model $bonsaiRepo --vision --image-history --local-repo "$bonsaiRepo=$bonsaiBundle" --profile $bonsaiProfile --clear-model-cache --output ".build/bonsai/vision-$bonsaiSize-result.json"
node scripts/check-bonsai-webgpu.mjs --model $bonsaiRepo --vision --image-history --profile $bonsaiProfile --offline --output ".build/bonsai/vision-$bonsaiSize-offline-result.json"
```

Repeat with `$bonsaiSize = '4B'` and recalculate the three variables. The first
command serves the unpublished export locally under its intended repository ID
and clears only that model's old cached files before loading. Use it again after
rebuilding model artifacts so an earlier cached graph cannot mask a changed
export. The second command uses the same browser profile and origin (default
port 8769), rejects Hugging Face fetches, and requires the first run's cached
readiness marker. Do not combine `--offline` with `--clear-model-cache`.

The checks cover text, tool-call/result turns, separate color/shape image fixtures,
and, with `--image-history`, differently sized screenshots in one conversation.
`--ocr` runs strict exact-code OCR checks; it is a separate quality check and its
failure reports must be preserved. The 2B model has omitted/confused characters
in these fixtures even when using 1,024 visual tokens. `--compact-images` selects
lower-resolution image fixtures; the JSON evidence
records that choice. `--probe-only` checks hardware/runtime without loading
weights. `--adapter-luid high,low` can select a specific Windows GPU without
changing system settings. See `--help` for operation deadlines and output paths.
These checks establish the recorded synthetic cases on the tested browser/GPU,
not broad OCR or model-quality performance.

Record a successful result alongside the export validation and reseal the
SHA-256 manifest:

```powershell
.build/bonsai/venv/Scripts/python.exe scripts/models/bonsai/record_browser_validation.py --bundle $bonsaiBundle --evidence ".build/bonsai/vision-$bonsaiSize-result.json"
```

The recorder requires a passing hardware WebGPU run for the matching model with
text, tool round trips, and both image color/shape fixtures. It preserves the full
evidence and its practical limitation to the tested browser/GPU and synthetic
images. Publish only the export folder contents;
the source packs, environment, download caches, and browser profile are local
build inputs. Intended repository IDs are
`webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision` and
`webbrain-one/Ternary-Bonsai-2-4B-ONNX-WebGPU-Vision`.

## Native vision parity

`validate_vision_reference.py` independently loads the original Prism tower into
the native Transformers Qwen3.5 eager implementation, using FP32 calculations,
and compares it with the FP16 ONNX export. It covers square, rectangular,
multiple-image, and realistic 28×28 patch grids (448-pixel image). The report
records relative error, cosine similarity, software versions and tested graph
hashes. This checks encoder math; browser tests still cover image integration
with the language model.

It additionally needs `transformers==5.20.1` and a compatible PyTorch runtime.
The recorded run used PyTorch 2.9.1+cu128 on the RTX5090. An existing compatible
Python environment's Torch can be reused with `--torch-site-packages` without
upgrading that environment. Otherwise use a dedicated environment with Torch
already installed. For example:

```powershell
.build/bonsai/venv/Scripts/python.exe scripts/models/bonsai/validate_vision_reference.py --size 2B --device cuda:0 --grid-size 28 --output .build/bonsai/vision-native-parity-2b.json
```

Repeat with `--size 4B` and a separate output filename. The native reference
checks original source-pack hashes before loading and uses no model repository
Python code. Include its JSON evidence in the bundle before resealing the manifest.

## Decision probe

`add_decision_hidden.py` adds the decoder's last-position hidden state as a
`decision_hidden` output (an Identity of the LM-head input; logits, caches and
the external weight file are unchanged). `train_decision_probe.py` trains the
2B Vision decision probe from hardware-eval reports made with
`scripts/check-webgpu-decisions.mjs --prompt verify --return-hidden
--decoder-graph <graph>` on d1's balanced-V3 train, validation and test splits.
The selected weights live in `src/chrome/src/offscreen/bonsai-decision-probe.js`.
`check_decision_hidden.py <dir> --old <previous graph> --new <graph>` checks on
onnxruntime's CPU provider that logits and caches stay bit-identical (the
external `.onnx_data` must sit next to both graphs).
A re-exported decoder or a retrained probe must be evaluated again through the
extension before its pin or weights change.
