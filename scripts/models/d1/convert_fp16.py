"""Store the d1 browser-decision graphs with FP16 weights and FP32 arithmetic.

Input is the published FP32 package (decision, vision and projector graphs with
external data). Every large FP32 initializer is rounded to FP16 once and cast
back to FP32 where it is used, so the graphs compute exactly as before except
for that one rounding of the weights. Activations, attention scores, softmax
and accumulation stay FP32. The token-embedding table is the exception: its
Gather reads the FP16 table and casts only the gathered rows, so the 256 MiB
FP32 table becomes a 128 MiB buffer on the GPU.

ONNX Runtime folds the other weight casts at session creation, so GPU memory
for those weights is unchanged; the download and the browser cache halve.

    python scripts/models/d1/convert_fp16.py <fp32-package-dir> <out-dir>
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

GRAPHS = ("decision", "vision", "projector")
# Small tensors (norm scales, biases, position tables) stay FP32: they are a
# negligible share of the bytes and the most sensitive to rounding.
MIN_ELEMENTS = 4096
FP16_MAX = 65504.0


def convert(source: Path, target: Path):
    model = onnx.load(str(source), load_external_data=True)
    graph = model.graph
    if any(node.op_type in ("If", "Loop", "Scan") for node in graph.node) or model.functions:
        raise SystemExit(f"{source.name}: nested graphs are not expected in the d1 package")
    consumers = {}
    for node in graph.node:
        for index, name in enumerate(node.input):
            consumers.setdefault(name, []).append((node, index))
    casts, gather_casts, report = [], {}, Counter()
    for initializer in graph.initializer:
        if initializer.data_type != TensorProto.FLOAT:
            continue
        values = numpy_helper.to_array(initializer)
        if values.size < MIN_ELEMENTS:
            report["kept_small_fp32"] += 1
            continue
        if not np.isfinite(values).all() or np.abs(values).max() >= FP16_MAX:
            report["kept_out_of_range_fp32"] += 1
            continue
        half = values.astype(np.float16)
        uses = consumers.get(initializer.name, [])
        name = initializer.name
        if uses and all(node.op_type == "Gather" and index == 0 for node, index in uses):
            # Gather the FP16 rows, then cast just those rows.
            initializer.CopyFrom(numpy_helper.from_array(half, name))
            for node, _ in uses:
                gathered = node.output[0]
                node.output[0] = gathered + "__fp16"
                gather_casts[node.name] = helper.make_node(
                    "Cast", [node.output[0]], [gathered], name=node.name + "/FP32", to=TensorProto.FLOAT)
            report["fp16_gather_tables"] += 1
        else:
            stored = name + "__fp16"
            initializer.CopyFrom(numpy_helper.from_array(half, stored))
            casts.append(helper.make_node("Cast", [stored], [name], name=stored + "/FP32", to=TensorProto.FLOAT))
            report["fp16_weights"] += 1
        report["fp16_elements"] += int(values.size)
    nodes = list(casts)
    for node in graph.node:
        nodes.append(node)
        if node.name in gather_casts:
            nodes.append(gather_casts[node.name])
    del graph.node[:]
    graph.node.extend(nodes)
    del graph.value_info[:]
    data = target.with_suffix(".data")
    if data.exists():
        data.unlink()
    onnx.save_model(model, str(target), save_as_external_data=True, all_tensors_to_one_file=True,
                    location=data.name, size_threshold=1024, convert_attribute=False)
    onnx.checker.check_model(str(target))
    stored_types = Counter(TensorProto.DataType.Name(t.data_type)
                           for t in onnx.load(str(target), load_external_data=False).graph.initializer)
    return dict(report, initializer_types=dict(stored_types),
                graph_bytes=target.stat().st_size, data_bytes=data.stat().st_size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    (args.target / "onnx").mkdir(parents=True, exist_ok=True)
    reports = {}
    for role in GRAPHS:
        reports[role] = convert(args.source / "onnx" / f"{role}.onnx", args.target / "onnx" / f"{role}.onnx")
        print(role, json.dumps(reports[role]), flush=True)
    (args.target / "conversion-report.json").write_text(json.dumps(reports, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
