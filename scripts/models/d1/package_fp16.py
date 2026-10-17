"""Assemble the d1 FP16-weight release package from the converted graphs.

    python scripts/models/d1/package_fp16.py --source <fp32-package> --converted <convert_fp16 output> \
        --parity <parity.json> --readme <README.md> --out <package dir>

The package mirrors the FP32 release layout that the extension's d1 cache
reads (package-manifest.json with 4 MiB chunk checksums, SHA256SUMS), with the
three graphs replaced by their FP16-weight versions.
"""
import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

MODEL_ID = "webbrain-one/d1-browser-decision-fp16"
SOURCE_MODEL_ID = "webbrain-one/d1-browser-decision-fp32"
SOURCE_REVISION = "71866f0ccab0b9fa92c6df64d1c34eacf2a7b2b8"
SOURCE_MANIFEST_SHA256 = "47b3a9efa02ce2cacf6da8c19607cc1179a8a2b7a339aebf3db05f2237151dbb"
CHUNK = 4 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[3]

NOTICE = """d1 FP16-weight browser-decision derivative

Original model and model implementation: Liquid AI, LiquidAI/d1-omni-600M,
revision 02b55d7076f15129e59ab3f94783f32c4b088674.
Original license: LFM Open License v1.0. The exact upstream license is retained
as LICENSE. Liquid AI does not endorse this experimental derivative.

MODIFIED MATERIALS NOTICE
This package is derived from the WebBrain FP32 release
webbrain-one/d1-browser-decision-fp32 (revision {source_revision}), whose
notice describes the earlier changes: audio components removed, decision head
and vision projector adapted, one rank-4 LoRA merged into four encoder Q/V
weights.

For this package, every FP32 weight tensor with at least 4,096 elements in the
three ONNX graphs was rounded once to FP16 and is cast back to FP32 where it is
used (scripts/models/d1/convert_fp16.py in the WebBrain repository, copied to
provenance/). The token-embedding table is gathered in FP16 and only the
gathered rows are cast. Activations, attention, softmax and accumulation stay
FP32. No training, merge, selection or re-export from PyTorch was performed.
onnx/decision.onnx, onnx/decision.data, onnx/vision.onnx, onnx/vision.data,
onnx/projector.onnx and onnx/projector.data are modified derivatives.

The immutable config.json retains a legacy dtype=float16 label from the
upstream source; package-manifest.json is authoritative (FP16 weights, FP32
arithmetic). Tokenizer, calibration temperatures and answer semantics are
unchanged.

This derivative is experimental. Synthetic labels/results and finite runtime
parity do not establish reliability on real independently developed websites.
No blanket commercial permission is granted here; consult LICENSE, including
its annual-revenue threshold terms.

Third-party runtime code retains its separate upstream notices under licenses/.
"""


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def describe(path, relative):
    size = path.stat().st_size
    entry = {"path": relative, "bytes": size, "sha256": sha256(path)}
    if size > CHUNK:
        chunks = []
        with open(path, "rb") as handle:
            offset = 0
            while True:
                block = handle.read(CHUNK)
                if not block:
                    break
                chunks.append({"offset": offset, "bytes": len(block), "sha256": hashlib.sha256(block).hexdigest()})
                offset += len(block)
        entry["chunk_bytes"] = CHUNK
        entry["chunks"] = chunks
    return entry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--converted", type=Path, required=True)
    parser.add_argument("--parity", type=Path, required=True)
    parser.add_argument("--readme", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out
    if out.exists():
        shutil.rmtree(out)
    (out / "onnx").mkdir(parents=True)
    for name in ["LICENSE", "config.json", "tokenizer.json", "tokenizer_config.json", "tiling-ratios.json"]:
        shutil.copy2(args.source / name, out / name)
    shutil.copytree(args.source / "licenses", out / "licenses")
    notice = NOTICE.format(source_revision=SOURCE_REVISION)
    (out / "NOTICE").write_text(notice)
    for role in ["decision", "vision", "projector"]:
        for suffix in [".onnx", ".data"]:
            name = f"{role}{suffix}"
            shutil.copy2(args.converted / "onnx" / name, out / "onnx" / name)
            (out / "onnx" / f"{name}.NOTICE.txt").write_text(notice)
    provenance = out / "provenance"
    provenance.mkdir()
    shutil.copy2(args.converted / "conversion-report.json", provenance / "conversion-report.json")
    if (args.converted / "hardware-eval.json").exists():
        shutil.copy2(args.converted / "hardware-eval.json", provenance / "hardware-eval.json")
    shutil.copy2(ROOT / "scripts/models/d1/convert_fp16.py", provenance / "convert_fp16.py")
    shutil.copy2(ROOT / "scripts/models/d1/parity-cpu.mjs", provenance / "parity-cpu.mjs")
    shutil.copy2(ROOT / "scripts/models/d1/decision-metrics.mjs", provenance / "decision-metrics.mjs")
    parity = json.loads(args.parity.read_text())
    parity.pop("answers", None)
    (provenance / "parity-cpu.json").write_text(json.dumps(parity, indent=2) + "\n")
    (provenance / "source-package.json").write_text(json.dumps({
        "model_id": SOURCE_MODEL_ID, "revision": SOURCE_REVISION, "package_manifest_sha256": SOURCE_MANIFEST_SHA256,
        "graphs_from": ["onnx/decision.onnx", "onnx/vision.onnx", "onnx/projector.onnx"],
    }, indent=2) + "\n")
    (out / "runtime").mkdir()
    for name in ["d1-runtime.js", "d1-preprocess.js"]:
        shutil.copy2(ROOT / "src/chrome/src/providers" / name, out / "runtime" / name)
    shutil.copy2(args.readme, out / "README.md")
    files = []
    for path in sorted(p for p in out.rglob("*") if p.is_file()):
        relative = path.relative_to(out).as_posix()
        files.append(describe(path, relative))
    conversion = json.loads((args.converted / "conversion-report.json").read_text())
    manifest = {
        "schema_version": 1,
        "complete": True,
        "model_id": MODEL_ID,
        "variant": "projector_head_text_lora",
        "selected_epoch": 6,
        "dtype": "float16",
        "weights_dtype": "float16",
        "compute_dtype": "float32",
        "audio": False,
        "audio_included": False,
        "quantization": False,
        "generates_tokens": False,
        "output_tokens": 0,
        "source_package": {"model_id": SOURCE_MODEL_ID, "revision": SOURCE_REVISION, "package_manifest_sha256": SOURCE_MANIFEST_SHA256},
        "conversion": {"script": "provenance/convert_fp16.py", "report": conversion},
        "graph_and_external_data_bytes": sum(f["bytes"] for f in files if f["path"].startswith("onnx/") and not f["path"].endswith(".txt")),
        "parity": {key: parity.get(key) for key in ("comparison",)},
        "license": {"model": "LFM Open License v1.0", "file": "LICENSE"},
        "synthetic_quality_only": True,
        "real_site_generalization_verified": False,
        "checksum_scope": "All package payload files; package-manifest.json and SHA256SUMS excluded to avoid self-hash recursion",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "files": files,
    }
    (out / "package-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (out / "SHA256SUMS").write_text("".join(f"{f['sha256']}  {f['path']}\n" for f in files))
    print("manifest sha256", sha256(out / "package-manifest.json"))
    print("bytes", sum(f["bytes"] for f in files))


if __name__ == "__main__":
    main()
