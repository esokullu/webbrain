# LLM tiny v2: private, stopped benchmark handoff

This bundle is a snapshot, **not an executable approval to incur charges**. It contains untracked benchmark code, not merely a Git checkout. Nothing starts on extraction. Do not run provisioning commands or remove locks until a new owner has satisfied the conditions below. No commit, push, publication, cloud CPU host or remote storage was created.

## Current state and authority

The original **$30 total** authorization includes ALL prior v1/v2 inference, GPU loading and idle time, API calls, storage, retries and cleanup. It is not a fresh $30 on a new computer. At shutdown, conservative total accrued was **$1.8526796463333335**, leaving **$28.147320353666667**. RunPod billing was not settled; preserve the conservative estimate until reconciled, never replace it with zero. There are no active resource commitments or pending requests. Future planning/cleanup reservations were released after verified deletion, not erased from history.

Benchmark Pod `aisniutjszyhc4` (one A100-SXM4-80GB) was created 2026-09-13T00:52:27.575Z, deleted 2026-09-13T01:57:36.387Z, independently confirmed absent by GET 404 and an empty Pod inventory. Its original watchdog deadline was 2026-09-13T03:52:27Z and was never extended. No benchmark CPU, volume or remote archive exists. Unrelated account storage was not modified. Do not delete account resources merely because they appear in an inventory.

A later billing read at 2026-09-13T02:04:45.753Z reported $0.26553121744655073 across two buckets but only 592,817 ms of the 3,908,812 ms resource lifetime. This supersedes earlier empty-feed observations, not the conservative lifetime estimate. It is overlapping partial billing, not additional cost and not a confirmed final invoice.

Fara 4B `pilot-workflow-02-s17` completed before the local runner was stopped at 2026-09-13T01:53:37.029Z. All 106 of its dispatched requests have saved responses. The process was stopped after durable episode/summary checkpointing, not during an episode. Browser Use loading had already finished; no loading/inference was active at Pod deletion. Existing watchdogs remained active throughout cleanup; the local guard exited after deletion was recorded. The old machine has no active benchmark sequencing process and its launch fences remain in place.

There is currently **no execution owner**, automatic retry, new deployment or scheduled next run. The latest user request authorizes this transfer and safe shutdown only; another machine must re-inspect provider state and budget before requesting/starting further paid work. A machine that stays on does not by itself solve the hard-spending-cap requirement.

## What to trust and where to find it

- `handoff-state/cumulative-budget.json`: authoritative sanitized cumulative ledger, including 224 v2 request reservations/settlements, historic API totals, conservative hosting/storage estimates, unresolved billing and released-reservation history. Do not add overlapping components twice.
- `handoff-state/resume-state.json`: all six participants, exact completed and remaining pilot task/seed IDs, all 180 held-out task/seed IDs per participant, partial-run checkpoint, successes AND failures, trace/PNG references and request linkage.
- `handoff-state/legacy-runpod-state.sanitized.json`: historical resource IDs, immutable model revisions and timestamps, **no inference token**. It is not a drop-in live deployment state file.
- `handoff-state/participant-settings.json`, `hosting-runtime.json`, `launch-locks.json`, `source-inventory.json`: preserved settings, serving flags/digest, runtime, lock semantics and per-file source hashes.
- `test/llm-tiny-v2/`: exact frozen suite, all existing v2 results and reports, including partial coverage. `results/2026-09-13-v2-comparison/report.md` has strict category pass rates, latency, attempted actions, failure review and cleanup receipts. Prior snapshot links in that historical report refer to the old laptop; this transfer bundle contains the same underlying data and new checksums instead.
- `test/llm-tiny/`: exact legacy sources and deployment helpers. Its `results/` are preserved separately and **not comparable to v2**; mocks and old smoke runs are not benchmark evidence. Never launch v1.
- `evidence/runpod-timers.json`: a private copy of relevant public provider evidence and current PR status; the URLs are supplied for later live rechecking.
- `CHECKSUMS.sha256`, `verification.json`, `verify-transfer.mjs`: extraction/integrity checks. The archive SHA-256 is in a sibling `.sha256` file because an archive cannot contain its own hash without circularity.

Raw hidden `.runpod-state.json`, `.v2-budget.json`, private participant configs and `.env` files are excluded. Their necessary **sanitized** information is explicitly reconstructed under `handoff-state/` and verified inside the extracted archive. Do not copy the raw originals from the old computer. They can contain secret-bearing state. No node_modules, Git metadata, model weights, unrelated workspace files, credentials or old archives are bundled.

## Exact remaining protocol

Frozen suite `reasoning-browser-v2.1`; manifest hash:

`60e52b1361d2f93d5cffa0b6805b06c2fbe45c9e64fca27c6431c29e536f293d`

Participants and current pilot coverage:

| Model | Adapter | Completed pilot | Strict passes |
|---|---|---:|---:|
| browser-use/bu-30b-a3b-preview | browser-use | 10/10 | 6/10 |
| deepseek/deepseek-v4.1-flash via OpenRouter | openai | 10/10 | 9/10 |
| microsoft/Fara1.5-4B | fara | 8/10 | 1/8, incomplete |
| microsoft/Fara1.5-9B | fara | 0/10 | unrun |
| microsoft/Fara1.5-27B | fara | 0/10 | unrun |
| webbrain-one/webbrain-compass-tiny-v2 | compass | 0/10 | unrun |

Complete the same ten pilot tasks, **seed 17 only**, across all six; preserve completed failed episodes as completed coverage. Next missing episodes are Fara 4B `pilot-recovery-01-s17` and `pilot-visual-01-s17`, then Fara 9B, Fara 27B, Compass. Nothing is presently queued to execute. Pilot seeds 43/89 exist in the manifest but are not authorized pilot coverage. The full exact ID lists are machine-readable; do not infer coverage from summary labels alone.

Held-out remains **60 tasks × seeds 17,43,89 = 180 episodes per participant**, 1,080 total. It has not started. Require completed/reviewed matching pilots and sufficient conservatively reserved budget for ALL six before starting held-out. Do not shrink the protocol, give one model extra repetitions, or treat old v1 as coverage. Retrying a failed completed task is not resume.

Keep 80 model turns, 120 attempted actions, 900-second task limit, 90-second request limit, 4,096 output tokens, 1440×900 viewport, latest three screenshots, native prompts/temperatures/top-p, exact grading and native adapters unchanged. Native observation differences (text/accessibility vs screenshot-only) are intentional, not equal-modality inputs. `manifest.json` pins the runner, adapters, fixtures, evaluator and all task variants. Do not re-freeze, patch evaluation code, alter answers or silently blend different manifest hashes.

## Offline setup on the other owned machine

Extract into a new private directory with enough disk for the archive plus approximately 100 MB of data, dependencies/browser binaries, and future screenshots. Set restrictive directory permissions; the archive is credential-free but private, not encrypted. Use your own authenticated encrypted transfer channel. No remote copy has been made for you.

Install Node **22.22.3** and npm using your existing trusted installation method. The bundle's minimal `package.json`/lock pins Playwright **1.59.1** and its exact transitive dependencies, derived from the workspace lock. Original dependency manifests are included as provenance, not as the recommended setup entry point. Do not run the original workspace's unrelated test/build scripts.

From the bundle root, these commands are offline with respect to model/provider APIs; installation downloads dependencies but does not launch billable inference:

```sh
node verify-transfer.mjs
npm ci --ignore-scripts
./node_modules/.bin/playwright install chromium
node test/llm-tiny-v2/run.mjs --validate-only
node --test --test-concurrency=1 --test-reporter=spec test/llm-tiny-v2/*.test.mjs test/llm-tiny-v2/lib/*.test.mjs
```

On Linux, provision the OS libraries required by this pinned Playwright version using its documented `install-deps chromium` command with appropriate local privileges; do not create a cloud machine. Do not use unversioned `npx` downloads. The original full offline suite passed 235 tests. New-machine golden checks must also pass before paid inference, but passing does not prove identical rendering.

Original browser runtime was macOS **26.0.1 (25A362), arm64**, Node 22.22.3, Playwright 1.59.1, Chromium **147.0.7727.15**, browser revision **1217**, headless, default Playwright context with the fixed viewport. Record the target OS, architecture, Node/npm/Playwright/browser versions and fonts/rendering. Compare representative fixture screenshots/layouts with saved pilot PNGs. Keyboard shortcuts, font metrics, device scale and headless browser UI can differ on Linux/Windows. Flag material differences; do not silently mix them into the old pilot. The old Mac result paths are historical, not executable paths on the new computer. Saved PNG filenames remain relative within the result tree.

`secrets.example` contains ENVIRONMENT VARIABLE NAMES ONLY; it is not a shell script or dotenv file. Obtain credentials separately using your own secret manager/secure entry. `RUNPOD_BENCH_KEY` is used by the old manager; `OPENROUTER_API_KEY` by the baseline. A new inference/control bearer must be newly generated and privately stored; the deleted Pod's token must not be reused. `TINY_RUNPOD_KEY`/`TINY_TOKEN` are legacy controller inputs; `TINY_V2_*` names are participant credential references. Public model downloads presently need no bundled Hugging Face credential. Never put values in source, CLI arguments, logs, screenshots, reports or result archives.

## Serving configuration and pins

Use the exact five model SHAs in `hosting-runtime.json` / `model-revisions.json`, not a fresh resolution of main. DeepSeek is identified by its supplied OpenRouter model ID; its upstream weights/revision are provider-managed and unpinned. The old GPU image was:

`vllm/vllm-openai@sha256:89c1d0629d377daa3f7f369cbea6167a7b48ea89aaacd12555e2b0b2f7f740d3`

vLLM 0.19.1, Linux amd64 container, BF16, max model length 16,384, one concurrent sequence, GPU memory utilization 0.90, eager mode, tensor-parallel size equal to GPU count. Vision participants allow three images; Compass uses auto tool choice and the Hermes parser. Original runs used one A100-SXM4-80GB. Fara 27B and remaining models have NOT been validated for capacity/startup on a replacement resource. The old v1 reporting helper's two-GPU Fara 27B assumption is not evidence of a run. A 16K serving context may truncate/reject requests before the frozen task-turn limit; preserve/disclose this hosting limitation, do not silently alter context settings. No old GPU weight cache survived deletion.

## Helpers: preserved for reference, not ready-to-run migration machinery

All orchestration lives outside frozen `test/llm-tiny-v2` code.

| Helper | What it does | Must fix before reuse |
|---|---|---|
| `test/llm-tiny/runpod/manage.mjs` | Model pinning, one temporary Pod create/start/status, local deadline guard, allow-listed deletion | Fixed dated state directory, single-live-Pod assumption, hardcoded price/three-hour lifetime/$30 arithmetic; create accounting ignores the full shared API/history ledger; price check occurs after provisioning; state creation can lose ownership on a partial failure. Never use missing-state fallback as a fresh budget. `pin` would move revisions. |
| `controller.py` | Authenticated control API, replaces one model process, background deadline delete loop | Volatile container state/logs, one model at a time, watchdog is a thread in the SAME controller process, no independent failure domain or distributed owner fencing. A failed DELETE can keep billing even if model process stops. Remote paths are `/tmp`; refresh/container restart may erase them. |
| `v2-launch.mjs` | One named participant's ten pilot tasks, request reservation accounting, no automatic model sequencing | Rejects any existing run directory; no partial resume. Fixed tags and dated state paths, defaults can recreate a stale initial budget, non-atomic/concurrency-unsafe read-modify-write ledger, no lease/fencing, mutates global fetch. It requires at least 30 minutes of remaining Pod lifetime but does not guarantee ten worst-case 15-minute episodes fit. No safe full held-out planner. |
| `v2-report.mjs` | Read-only evidence aggregation and generated reports | Needs the old hidden state location; contains fixed run names, historical narrative and prior API constants. Use the sanitized ledger as authoritative, refactor paths/accounting before reuse. It is not a scheduler or billing cap. |
| `report.mjs` | Old v1 final-report prototype | Assumes six complete 30-task v1 runs and two GPUs for Fara 27B; not usable for v2 or actual cumulative billing. Do not run it. |
| `handoff-snapshot.mjs` | Earlier pre-deletion local backup | Fixed Pod ID, expects a LIVE old controller and raw secret-bearing state; excludes hidden files. Do not reuse after deletion. It is NOT the complete transfer packager. |
| `handoff-bundle.mjs` | Offline complete transfer creation | Reads old local raw state only to emit strict allow-listed sanitized state, scans known secrets, validates restored bundle. Does not provision. It is a packaging utility, not a coordinator. |

The frozen runner's `main` writes unique tags and rejects reuse. It supports `--only` exact task/episode IDs, and exports `runCase`; an external deterministic coordinator can use those existing interfaces for missing episodes without modifying frozen code. It must preserve immutable completed outputs and generate a separate provenance-aware merged summary with exact IDs/settings/hash/coverage; do not overwrite old partial summaries or pretend the old main can resume them. Model retries/request ambiguity require explicit checkpoint records and cost reservations, not blind restarts. No such resumable coordinator is implemented in this bundle.

Other assumptions to address: stale absolute `/Users/...` paths in historical receipts; dead Pod-specific proxy URLs in settings/results; a single Pod's container cache and disk; no distributed status/archive; deletion accepted vs independently confirmed; interrupted network request cost uncertainty; own-machine uptime and backup; bounded replacement attempts and model-load costs; account billing lag. The earlier API key had no provider-enforced spending limit. The prior v2 API wrapper bounded requests with a full-context cost reserve and routing price ceilings, not a provider key cap; preserve cumulative costs and check current model/routing prices before any new dispatch.

## Ownership, locks and budget gates

1. Verify the archive, frozen manifest, every episode artifact, fresh provider resources and final charges. Reconcile the sanitized cumulative ledger without resetting its original cap or excluding old failed/mocked/paid attempts. Mocks cost no API, but historical paid smoke failures still count. Keep an uncertainty/shutdown reserve before any new billable work.
2. `test/llm-tiny/results/.v1-launch-disabled` is permanent for this benchmark and MUST remain. It disables direct v1 runs. Never migrate to v1.
3. `test/llm-tiny/results/.v2-handoff-requested` blocks v2 launcher and manager create/start/refresh/test; it must remain on the old machine. Cleanup/status/guards remain available. Keep it in the transferred tree until an explicitly approved new coordinator has durable exclusive ownership, budget and state verified. The new coordinator may supersede the migration marker ONLY on the new machine after recording owner identity/generation and fencing all old launchers. Do not simply remove it to run legacy helpers. Frozen `run.mjs` itself does not read this marker: invoking it with `--allow-paid` bypasses deployment protections. The user has not authorized that here.
4. Use transactional/atomic state, exclusive locks or leases with fencing tokens, durable pre-dispatch reservations, per-episode immutable checkpoints, checksummed backups and request IDs. No simultaneous GPU/CPU/model requests or duplicate owners. Fail closed on uncertain prices, missing/ambiguous ledger/ownership, lost state or insufficient lifetime/budget. Test restart, duplicate prevention, reserve exhaustion and deadline failure using mocks before paid requests.
5. Retain independent cleanup watchers, but do not call them an absolute provider cap. Every new resource needs its own bounded lifetime/reserve and independently verified deletion. Do not silently extend old deadlines, change payments or enable auto-top-ups. If the hard $30 ceiling still cannot be upheld, do not provision; ask the user for a decision without silently weakening the cap.

## RunPod termination evidence and limitations

RunPod's own [merged PR #330](https://github.com/runpod/runpodctl/pull/330) removed automatic stop/terminate flags on August 27, 2026. Its production tests found the API accepted deadlines but Pods continued running and billing; CPU REST creation had no scheduling field. [PR #331](https://github.com/runpod/runpodctl/pull/331) proposes client validation/restoration but remained **open, draft and unmerged** at 2026-09-13T02:00:32.994Z and says backend enforcement must land first. The evidence snapshot contains the provider-authored explanation and live status; recheck these primary sources before a later decision. An accepted input or printed deadline is not verified enforcement.

Our local Node guard was a laptop process making DELETE calls at an absolute time. The GPU controller watchdog was a Python thread that tried DELETE and, on failure, stopped its model process while retrying. Neither is a provider-native timer, a guaranteed spending cap, or independent of all network/control/process failures. A CPU host or an always-on personal computer would not change that distinction. There was no per-benchmark RunPod hard-dollar cap verified and the supplied OpenRouter key showed `limit: null`. No account payment, credit or auto-top-up settings were changed.

## Known interpretation limitations: preserve, do not silently repair

- Conference planning wording mixes base/daily dollars and a fee per session; the frozen key charges the base once. Different plausible readings explain some failed totals.
- Evidence tasks request decision/source ID but not explicitly form submission; the scorer requires submission. Fara's native authorization caution can interact with this mismatch. Source ID is effectively a document title, whereas visible controls also have numeric indices.
- Fara 4B workflow strict failures were `Draft` vs exact `draft` only, with all other checks passing. Do not call them multi-step reasoning failures.
- Browser Use workflow-01 omitted Brief evidence and invented values. Fara planning-01 selected a more expensive option; evidence-01 misread source facts. These are separate observed model errors.
- Fara browser Find shortcuts did not open Find in headless Mac Chromium; typing stayed in the page input. This adapter/browser-surface limitation produced no thrown key-dispatch error. Do not silently add unsupported browser chrome or change its frozen adapter.
- DeepSeek recovered from three navigation-invalidated handle errors and passed those episodes. No saved v2 episode had an endpoint/parsing failure.
- Exact trimmed-string grading, sticky forbidden actions and partial-credit separation stay unchanged. Strict scores are synthetic fixture performance, not open-web reliability; latency includes local browser/network overhead and changing host environments matter.

The latest user requested preparation only. Do not commit, push, publish, create storage/CPU resources, launch additional models, or start inference as part of verifying this transfer.
