"""Check that adding `decision_hidden` left the Bonsai 2 decoder unchanged.

Runs the previous and the new merged decoder graph on onnxruntime's CPU
provider with the same random `inputs_embeds`: a prefill (one below and one
across a 128-token chunk boundary) and one cached decode step after it.
Logits and every cache output must be bit-identical, and `decision_hidden`
must be a finite [1, 1, hidden] tensor. Both graphs read the same external
`decoder_model_merged_q2f16.onnx_data`, which must sit next to them.

    python scripts/models/bonsai/check_decision_hidden.py <dir> --old dec.onnx --new dec_hidden.onnx
"""
import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort


def session(path, threads):
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def feeds(sess, embeds, past, total):
    out = {}
    for spec in sess.get_inputs():
        if spec.name == "inputs_embeds":
            out[spec.name] = embeds
        elif spec.name == "attention_mask":
            out[spec.name] = np.ones((1, total), np.int64)
        elif spec.name == "position_ids":
            n = embeds.shape[1]
            positions = np.arange(total - n, total, dtype=np.int64)
            out[spec.name] = np.broadcast_to(positions, (3, 1, n)).copy()
        elif past is not None:
            out[spec.name] = past[spec.name]
        else:
            shape = [1 if dim == "batch_size" else (0 if isinstance(dim, str) else dim) for dim in spec.shape]
            out[spec.name] = np.zeros(shape, np.float16)
    return out


def past_name(name):
    return (name.replace("present_conv", "past_conv")
            .replace("present_recurrent", "past_recurrent")
            .replace("present", "past_key_values"))


def run(sess, embeds, past, total):
    names = [output.name for output in sess.get_outputs()]
    outputs = dict(zip(names, sess.run(None, feeds(sess, embeds, past, total))))
    return outputs, {past_name(k): v for k, v in outputs.items() if k.startswith("present")}


def same(left, right):
    return all(np.array_equal(left[key], right[key]) for key in left if key != "decision_hidden")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dir", type=Path)
    parser.add_argument("--old", default="dec.onnx")
    parser.add_argument("--new", default="dec_hidden.onnx")
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()
    old, new = session(args.dir / args.old, args.threads), session(args.dir / args.new, args.threads)
    rng = np.random.default_rng(0)
    width = next(spec.shape[2] for spec in old.get_inputs() if spec.name == "inputs_embeds")
    report = {"onnxruntime": ort.__version__, "inputs": "inputs_embeds ~ N(0, 0.02), seed 0", "cases": []}
    for tokens in (37, 200):
        prefill = (rng.standard_normal((1, tokens, width)) * 0.02).astype(np.float32)
        step = (rng.standard_normal((1, 1, width)) * 0.02).astype(np.float32)
        a, past_a = run(old, prefill, None, tokens)
        b, past_b = run(new, prefill, None, tokens)
        hidden = b["decision_hidden"]
        a_step, _ = run(old, step, past_a, tokens + 1)
        b_step, _ = run(new, step, past_b, tokens + 1)
        case = {
            "prefill_tokens": tokens,
            "prefill_logits_and_caches_identical": same(a, b),
            "decode_logits_and_caches_identical": same(a_step, b_step),
            "hidden_shape": list(hidden.shape),
            "hidden_finite": bool(np.isfinite(hidden).all()),
        }
        report["cases"].append(case)
        print(json.dumps(case), flush=True)
    ok = all(c["prefill_logits_and_caches_identical"] and c["decode_logits_and_caches_identical"]
             and c["hidden_finite"] and c["hidden_shape"] == [1, 1, width] for c in report["cases"])
    report["passed"] = ok
    print(json.dumps(report))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
