"""Train a frozen-backbone decision probe for the Bonsai 2 Vision readout.

Inputs are hardware-eval reports from scripts/check-webgpu-decisions.mjs run
with `--prompt verify --return-hidden` (one last-position hidden state and one
Yes-minus-No margin per option) on d1's balanced-V3 train, validation and
final-test splits, plus the split files for the labels.

Each option is scored as  a * margin + w . standardize(hidden) + b_type, and a
softmax over a question's options gives its answer, the same grouped readout
d1 uses over its option markers. Only 2048 + a few parameters are trained;
the regularization strength is chosen on validation, and the test split is
scored once with the chosen model.

    python scripts/models/bonsai/train_decision_probe.py --reports <dir> --data <split dir> --out probe.json
"""
import argparse
import base64
import json
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

TYPES = ("choice", "noul", "score")


def decode(text):
    return np.frombuffer(base64.b64decode(text), dtype=np.float16).astype(np.float32)


def load(report_path, split_path):
    report = json.loads(Path(report_path).read_text())
    answers = report["engines"]["bonsai"]["answers"]
    split = json.loads(Path(split_path).read_text())
    rows = []
    for request in split["requests"]:
        for entry in request["questions"]:
            answer = answers.get(entry["id"])
            if not answer or not answer.get("hidden") or any(h is None for h in answer["hidden"]):
                continue
            question = entry["question"]
            if question["type"] == "noul":
                names = ["no", "yes"]
            elif question["type"] == "score":
                names = [str(i) for i in range(len(question["criteria"]))]
            else:
                names = list(question["criteria"].keys())
            label = entry["label"]
            target = names.index(label["selected_option"]) if question["type"] != "score" else label["selected_index"]
            rows.append(dict(entry=entry, type=question["type"], names=names, target=target,
                             margins=np.array(answer["margins"], dtype=np.float64),
                             hidden=np.stack([decode(h) for h in answer["hidden"]]).astype(np.float64)))
    return rows


def scores(params, row, mean, std):
    width = mean.shape[0]
    a, w = params[0], params[1:1 + width]
    bias = params[1 + width + TYPES.index(row["type"])]
    return a * row["margins"] + ((row["hidden"] - mean) / std) @ w + bias


def objective(params, rows, mean, std, l2):
    width = mean.shape[0]
    loss, grad = 0.0, np.zeros_like(params)
    for row in rows:
        s = scores(params, row, mean, std)
        s = s - s.max()
        p = np.exp(s) / np.exp(s).sum()
        loss -= np.log(p[row["target"]] + 1e-12)
        d = p.copy()
        d[row["target"]] -= 1
        z = (row["hidden"] - mean) / std
        grad[0] += d @ row["margins"]
        grad[1:1 + width] += d @ z
        grad[1 + width + TYPES.index(row["type"])] += d.sum()
    n = len(rows)
    loss = loss / n + l2 * np.sum(params[1:1 + width] ** 2)
    grad = grad / n
    grad[1:1 + width] += 2 * l2 * params[1:1 + width]
    return loss, grad


def answers_for(rows, params, mean, std):
    out = {}
    for row in rows:
        s = scores(params, row, mean, std)
        p = np.exp(s - s.max())
        p /= p.sum()
        q = row["entry"]["question"]
        if q["type"] == "noul":
            out[row["entry"]["id"]] = {"type": "noul", "noul": float(p[1])}
        elif q["type"] == "score":
            out[row["entry"]["id"]] = {"type": "score", "score": float(p @ np.arange(len(p))),
                                       "probabilities": {n: float(v) for n, v in zip(row["names"], p)}}
        else:
            out[row["entry"]["id"]] = {"type": "choice", "choice": row["names"][int(p.argmax())],
                                       "probabilities": {n: float(v) for n, v in zip(row["names"], p)}}
    return out


def metrics(rows, answers):
    # Mirrors scripts/models/d1/decision-metrics.mjs.
    t = dict(categorical=0, correct=0, pos=0, neg=0, tp=0, fp=0, unk=0, unk_ok=0, score_n=0, score_err=0.0, nll=0.0)
    for row in rows:
        entry, answer, q = row["entry"], answers[row["entry"]["id"]], row["entry"]["question"]
        label = entry["label"]
        if q["type"] == "score":
            t["score_n"] += 1
            t["score_err"] += abs(answer["score"] - label["expected_level"])
            continue
        t["categorical"] += 1
        guess = answer["choice"] if q["type"] == "choice" else ("yes" if answer["noul"] >= 0.5 else "no")
        right = guess == label["selected_option"]
        t["correct"] += right
        if entry.get("is_completion_claim"):
            positives = entry.get("completion_positive_options", [])
            if label["selected_option"] in positives:
                t["pos"] += 1
                t["tp"] += guess in positives
            else:
                t["neg"] += 1
                t["fp"] += guess in positives
            unknown = (entry.get("uncertainty_metadata") or {}).get("unknown_option")
            if unknown and label["selected_option"] == unknown:
                t["unk"] += 1
                t["unk_ok"] += right
    return {"categorical": f"{t['correct']}/{t['categorical']}", "categorical_accuracy": t["correct"] / max(1, t["categorical"]),
            "completion_found": f"{t['tp']}/{t['pos']}",
            "false_completions": f"{t['fp']}/{t['neg']}", "unknown": f"{t['unk_ok']}/{t['unk']}",
            "score_mae": t["score_err"] / max(1, t["score_n"])}


def fit(rows, mean, std, l2):
    width = mean.shape[0]
    start = np.zeros(1 + width + len(TYPES))
    start[0] = 1.0  # begin at the zero-shot verify readout
    result = minimize(objective, start, args=(rows, mean, std, l2), jac=True, method="L-BFGS-B", options={"maxiter": 500})
    return result.x


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reports", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    train = load(args.reports / "probe-train.json", args.data / "train.json")
    val = load(args.reports / "probe-val.json", args.data / "validation.json")
    test = load(args.reports / "probe-test.json", args.data / "final_test.json")
    stacked = np.concatenate([row["hidden"] for row in train])
    mean, std = stacked.mean(0), stacked.std(0) + 1e-3
    width = mean.shape[0]
    zero = np.zeros(1 + width + len(TYPES))
    zero[0] = 1.0
    report = {"rows": {"train": len(train), "validation": len(val), "test": len(test)},
              "zero_shot_verify": {"validation": metrics(val, answers_for(val, zero, mean, std)),
                                   "test": metrics(test, answers_for(test, zero, mean, std))},
              "candidates": []}
    best = None
    for l2 in [1e-4, 1e-3, 1e-2, 3e-2, 1e-1, 3e-1, 1.0]:
        params = fit(train, mean, std, l2)
        val_loss, _ = objective(params, val, mean, std, 0.0)
        val_metrics = metrics(val, answers_for(val, params, mean, std))
        accuracy = val_metrics["categorical_accuracy"]
        candidate = {"l2": l2, "validation_nll": float(val_loss), "validation": val_metrics,
                     "train": metrics(train, answers_for(train, params, mean, std))}
        report["candidates"].append(candidate)
        print(json.dumps(candidate), flush=True)
        key = (accuracy, -val_loss)
        if best is None or key > best[0]:
            best = (key, l2, params)
    _, l2, params = best
    report["selected_l2"] = l2
    report["test"] = metrics(test, answers_for(test, params, mean, std))
    report["margin_weight"] = float(params[0])
    report["type_bias"] = {t: float(params[1 + width + i]) for i, t in enumerate(TYPES)}
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    np.savez(args.out.with_suffix(".npz"), params=params, mean=mean, std=std)
    print("selected l2", l2, "test", json.dumps(report["test"]))
    print("zero-shot verify test", json.dumps(report["zero_shot_verify"]["test"]))


if __name__ == "__main__":
    main()
