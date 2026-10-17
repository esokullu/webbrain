"""Static audit of an ONNX decoder graph before shipping it on WebGPU.

Catches the problems that made Ternary Bonsai 2 prefill take minutes in the
browser (see docs/webgpu-models.md):

* control-flow ops that ONNX Runtime Web's WebGPU execution provider does not
  implement (`Scan`, `Loop`), including inside `If` branches. ONNX Runtime
  places them on the CPU and their bodies then run once per iteration with a
  GPU round trip, so a per-token recurrence becomes a per-token CPU loop;
* a `logits` output that keeps the sequence dimension, so prefill computes and
  downloads `[sequence_length, vocab]` scores (0.5 MB per prompt token for a
  248k vocabulary in FP16) and can exceed a 2 GB WebGPU buffer limit.

Only the graph structure is read (external weights are not loaded). Exit code
1 means at least one blocker was found. This is a static check: also confirm
node placement and prefill scaling on hardware WebGPU as the doc describes.

  python scripts/models/audit_webgpu_onnx.py path/to/decoder_model_merged_q4f16.onnx [--json]
"""

import argparse
import collections
import json
import sys
from pathlib import Path

import onnx

# Verified with onnxruntime-web 1.27: the WebGPU EP logs "webgpu kernel not found
# in registries for Op type: Scan" (and the same for Loop) and places them on
# the CPU. `If` has a WebGPU kernel and is fine.
CPU_ONLY_CONTROL_FLOW = {"Scan", "Loop"}
LOGITS_NAMES = {"logits"}


def walk(graph, location=""):
    for node in graph.node:
        here = f"{location}/{node.name or node.op_type}"
        yield node, here
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                yield from walk(attribute.g, f"{here}:{attribute.name}")
            elif attribute.type == onnx.AttributeProto.GRAPHS:
                for index, subgraph in enumerate(attribute.graphs):
                    yield from walk(subgraph, f"{here}:{attribute.name}[{index}]")


def dims(value_info):
    return [d.dim_param or d.dim_value for d in value_info.type.tensor_type.shape.dim]


def audit(path):
    model = onnx.load(path, load_external_data=False)
    graph = model.graph
    blockers, warnings, info = [], [], {}

    control_flow = collections.defaultdict(list)
    op_counts = collections.Counter()
    for node, location in walk(graph):
        domain = node.domain or "ai.onnx"
        op_counts[f"{domain}::{node.op_type}"] += 1
        if node.op_type in CPU_ONLY_CONTROL_FLOW and domain == "ai.onnx":
            control_flow[node.op_type].append(location)
    for op_type, locations in control_flow.items():
        blockers.append({
            "check": "cpu-only-control-flow",
            "op": op_type,
            "count": len(locations),
            "examples": locations[:3],
            "why": f"No WebGPU kernel for {op_type}: it runs on the CPU and its body is dispatched per iteration "
                   "with a GPU round trip (Bonsai 2: ~6.5 ms per prompt token per layer on an RTX 5090).",
        })

    inputs = {i.name for i in graph.input}
    for output in graph.output:
        if output.name not in LOGITS_NAMES:
            continue
        shape = dims(output)
        info["logits_shape"] = shape
        if len(shape) == 3 and shape[1] != 1:
            vocab = shape[2] if isinstance(shape[2], int) and shape[2] else None
            entry = {
                "check": "full-sequence-logits",
                "shape": shape,
                "why": "Prefill computes and downloads logits for every prompt token"
                       + (f" ({vocab * 2 / 1e6:.2f} MB per token in FP16)" if vocab else "")
                       + "; generation reads only the last position.",
            }
            if "num_logits_to_keep" in inputs:
                entry["why"] += (" The graph accepts num_logits_to_keep, but Transformers.js passes 0 (keep all) "
                                 "on its multimodal forward path, so slice to the last position in the graph.")
                warnings.append(entry)
            else:
                blockers.append(entry)

    contrib = sorted(k for k in op_counts if not k.startswith("ai.onnx::"))
    info.update({
        "opsets": {o.domain or "ai.onnx": o.version for o in model.opset_import},
        "nodes": sum(op_counts.values()),
        "if_nodes": op_counts.get("ai.onnx::If", 0),
        "contrib_ops": {k: op_counts[k] for k in contrib},
        "external_data_files": sorted({
            entry.value for tensor in graph.initializer if tensor.data_location == onnx.TensorProto.EXTERNAL
            for entry in tensor.external_data if entry.key == "location"
        }),
        "inputs": [i.name for i in graph.input if not i.name.startswith(("past", "present"))],
    })
    return {"graph": str(path), "blockers": blockers, "warnings": warnings, "info": info}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("graphs", type=Path, nargs="+")
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    args = parser.parse_args()
    failed = False
    for path in args.graphs:
        report = audit(path)
        failed = failed or bool(report["blockers"])
        if args.json:
            print(json.dumps(report, indent=2))
            continue
        status = "BLOCKED" if report["blockers"] else "ok"
        print(f"{status}: {path}")
        for item in report["blockers"]:
            print(f"  blocker  {item['check']}: {item.get('op') or item.get('shape')} "
                  f"(x{item.get('count', 1)}) - {item['why']}")
        for item in report["warnings"]:
            print(f"  warning  {item['check']}: {item.get('shape')} - {item['why']}")
        info = report["info"]
        print(f"  logits {info.get('logits_shape')}, {info['nodes']} nodes, {info['if_nodes']} If, "
              f"contrib {', '.join(info['contrib_ops']) or 'none'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
