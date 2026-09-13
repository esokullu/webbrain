# LLM tiny v2: reasoning-heavy browser evaluation

Independent of `test/llm-tiny`: this directory has its own copied/pinned native
adapters, fixtures, runner, frozen manifest, and ignored results. It imports no
code from the original suite. No root package scripts were changed. There is no
RunPod controller, provisioning, teardown, scheduling, or process-management code.

**Creation and local validation do not call a model endpoint. No v2 model scores
exist yet.** The existing paid run must finish under its original hard $30 cap;
this suite does not extend that approval or budget.

## Workload

| Held-out category | Tasks | What differs from basic control tests |
|---|---:|---|
| Constraint planning | 15 | Eligibility, exclusions, total cost, whole-package rounding, scheduling and optimization |
| Calculations | 15 | Split-page evidence, tax, deductions, weighted rates, invoice deduplication and rounding |
| Evidence reconciliation | 10 | Effective dates, source precedence, regional exceptions, revocations and same-name identities |
| Long workflows | 10 | Six saved stages, original requirements, distinct quantity amendments, derived totals and draft-only authority |
| Recovery | 5 | Changed validation, expired coupon, stock change, stale revision and uncertain commit outcome |
| Contextual/visual controls | 5 | Repeated Choose labels, spatial relationships, status and utilization |

There are **60 held-out task definitions**, each with three reproducible seeded
variants (`17,43,89`): **180 held-out episodes per model**. Ten separate pilot
task definitions have their own data and scenarios: 30 pilot episodes per model.
Seeds change task data and/or layout, not the underlying task definition; they
are not 180 independent task types. Full held-out coverage across six models is
1,080 episodes, so budget it before launching anything.

The fixtures are deliberately synthetic and reasoning-heavy. A stronger
reasoning model may do better, but there is no preferred winner in scoring and
no promised ranking. This does not measure open-web robustness or overall
product capability. Workflow pages can be revisited; this tests retaining and
reconciling requirements, not a strict inaccessible-memory experiment.

## What a pass means

The browser submits values to an isolated, random local session. **The Node
server owns expected answers and authoritative state.** No answer key, hidden
expected attributes, evaluator code, or future workflow stages are sent to the
browser. The model has no JavaScript execution or unrestricted navigation tool.
Browser requests are restricted to that exact session, not arbitrary localhost.

A strict pass requires all expected fields/stages, required recovery events,
terminal completion, no forbidden side effects, and completion within limits.
Judging uses exact trimmed strings; tasks state decimal formatting explicitly.
Wrong submitted answers are terminal and not corrected by the fixture. There is
no correctness feedback that allows trial-and-error guessing. “Done” alone never
passes. Deletion, publication and duplicate submissions remain sticky failures.
The unknown-commit task requires checking the ledger and acknowledging the
already-saved request instead of retrying it.

Partial credit is the fraction of individual field/recovery checks met; it is
reported separately and **never substitutes for a strict pass**. UI receipts
only confirm that a submission was recorded, not that it was correct.

## Native interfaces and fairness

| Adapter | Models | Observation |
|---|---|---|
| `compass` | WebBrain Compass Tiny v2 | Visible viewport text + accessibility controls |
| `browser-use` | BU-30B-A3B Preview | Visible viewport text + indexed controls + screenshot |
| `fara` | Fara1.5 4B / 9B / 27B | Screenshot only, 1000×1000 action coordinates |
| `openai` | Any explicitly supplied OpenAI-compatible baseline | Visible viewport text + indexed controls + screenshot |

All task facts are visibly rendered. DOM observations include table/document
text, not just interactive labels, and never include hidden form routing fields.
Spatial cards also display row/column and utilization text, making the facts
accessible to the text-only participant. Closed select options are enumerated
for DOM participants; Fara can open the in-page picker. These native access
differences are explicit: this is not an identical-input modality experiment.

Defaults for every participant: 80 model turns, 120 individual attempted
actions, 15 minutes per task, 90 seconds per request, 4,096 output tokens per
request, latest three screenshots, 1440×900 viewport. All actions in a batch
count, and stale DOM handles cannot silently target a new control. Native
temperature/top-p and prompts remain adapter-specific and are recorded.
No text-only OpenAI override is allowed in this frozen protocol.

## Local validation — safe while another suite runs

Use the repository's installed Node 22+ and Playwright/Chromium dependencies.
No dependency installation or global browser profile is needed.

```sh
node test/llm-tiny-v2/run.mjs --validate-only
node --test --test-concurrency=1 --test-reporter=spec test/llm-tiny-v2/*.test.mjs test/llm-tiny-v2/lib/*.test.mjs
```

Unit checks cover all 210 variants, positive and negative outcomes, sticky
violations, unknown commits, action limits, paired reporting and adapters.
Browser checks use a single test process and disposable contexts. They perform
golden scripted interactions for all 70 task definitions on seed 17, test native
dropdown coordinates, stale references, blocked external navigation, and an
offline mocked model loop. **Those are harness tests, not model capability
results.** They do not contact any model endpoint or touch the existing run.

## Later model runs — not started automatically

First review the separate pilot, verify remaining authorized budget, and obtain
approval for paid execution. A localhost model endpoint may still incur GPU
rental costs. `--allow-paid` is a deliberate launch gate, **not a billing cap**.
This runner cannot enforce a shared hard cloud-spend cap and must not be used
without a separately budgeted/protected deployment. It does not start or stop
model servers. The example ports are placeholders, not discovered services.

Create a private config from `participants.example.json`. Keep secrets in
environment variables, never in this repository or command arguments. Remove
`apiKeyEnv` only for a deliberately unauthenticated local endpoint. The `openai`
adapter can use another explicitly supplied model instead of DeepSeek; the five
specialized models remain allow-listed.

After separate approval and endpoint preparation:

```sh
node test/llm-tiny-v2/run.mjs --allow-paid \
  --config /private/tiny-v2-participants.json \
  --split pilot --seeds 17 --tag pilot-01

# Only after pilot review, freezing, and a budget decision:
node test/llm-tiny-v2/run.mjs --allow-paid \
  --config /private/tiny-v2-participants.json \
  --split heldout --tag heldout-01
```

Results go exclusively under this directory's ignored `results/<unique-tag>`.
Existing tags are rejected. Per-episode JSON retains every returned action,
outcome, usage and error; PNGs retain the screenshot observations. Partial
summaries are written after every episode, marked incomplete until coverage is
complete. Never copy incomplete or cherry-picked runs into a final comparison.

## Compare and freeze

```sh
node test/llm-tiny-v2/compare.mjs \
  test/llm-tiny-v2/results/heldout-01/deepseek/summary.json \
  test/llm-tiny-v2/results/heldout-01/fara-4b/summary.json
```

The report prints pass-rate and category tables, latency, attempted actions,
reported API cost and paired 95% task-cluster bootstrap intervals. It rejects
different manifest hashes, limits, splits or coverage. Variants stay grouped
under their task; intervals overlapping zero do not establish a winner. Costs
missing from provider usage are `null`/unknown, never zero; GPU rental and
storage are not included. Hosting differences remain separate from accuracy.

`manifest.json` pins every task variant, adapter/evaluator/runner source hash,
default seed and limit. Live runs verify it before any endpoint call. Calibrate
on the pilot only. If adapter or corpus changes are warranted, review them,
update the suite version and intentionally re-freeze:

```sh
node test/llm-tiny-v2/freeze.mjs --write --replace-existing
```

This never runs automatically. Results under different hashes cannot be ranked
together; rerun all affected participants after a genuine harness fix. Do not
change held-out tasks or weights because a particular model won or lost.

The separate pilot/holdout and deterministic outcome checks follow the dataset
and grader principles in [OpenAI's evaluation guide](https://developers.openai.com/cookbook/examples/realtime_eval_guide).
