"""Expose the decoder's last-position hidden state as an extra output.

The Bonsai 2 chunked decoder slices the final-norm hidden state to the last
position before the LM head. This adds an Identity of that [batch, 1, hidden]
FP16 tensor as the graph output `decision_hidden`, for decision-readout probes.
Nothing else changes: logits, caches and the external weight file reference
stay as they are.

    python scripts/models/bonsai/add_decision_hidden.py <decoder.onnx> <out.onnx>
"""
import sys

import onnx
from onnx import TensorProto, helper

SOURCE_SUFFIX = "/last_position"


def main(source, target):
    model = onnx.load(source, load_external_data=False)
    graph = model.graph
    lm_head = [node for node in graph.node if node.output and node.output[0] == "logits"]
    if len(lm_head) != 1:
        raise SystemExit("expected one node producing logits")
    hidden = lm_head[0].input[0]
    if not hidden.endswith(SOURCE_SUFFIX):
        raise SystemExit(f"unexpected LM head input {hidden}")
    if any(output.name == "decision_hidden" for output in graph.output):
        raise SystemExit("graph already has decision_hidden")
    graph.node.append(helper.make_node("Identity", [hidden], ["decision_hidden"], name="/webbrain/decision_hidden"))
    graph.output.append(helper.make_tensor_value_info("decision_hidden", TensorProto.FLOAT16, ["batch_size", 1, None]))
    # The weights stay in the original external data file next to the graph,
    # so onnx.checker cannot run here without it; the browser load checks it.
    onnx.save_model(model, target)
    print("added decision_hidden from", hidden)


if __name__ == "__main__":
    main(*sys.argv[1:3])
