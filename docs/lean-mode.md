# Lean mode

Lean mode gives a strong model a small tool set and a short prompt, and turns off WebBrain's own verification of its work. WebBrain's permission and safety boundaries stay exactly as they are.

WebBrain's checks were built for small local models, which mistype, lose track and report success too early. A strong model does not need most of that help. Each check costs a page read, a model call or a forced turn, and when a check cannot verify something it may refuse an action that was right. The clearest case is GitHub's file editor: it renders blank lines in a way WebBrain's readback reads as doubled, so WebBrain can never confirm a multi-paragraph edit, and it refuses the commit that follows. [lean-mode-comparison.md](lean-mode-comparison.md) replays that case and two ordinary ones with and without lean mode.

Lean mode follows the Claude in Chrome model ([claude-chrome-comparison.md](claude-chrome-comparison.md)): a thin tool surface, and safety from permission prompts, site checks right before each action, and the model's own judgment, with no readback of typing and no completion judge.

## The setting

Settings → General → **Lean mode** (storage key `leanMode`):

- **Auto** (default): on for strong cloud models, off for local and small models (rules below).
- **On**: always, for every provider and tier.
- **Off**: never.

It applies to Act mode only. Ask, Dev and the standalone chat keep their behavior. A run decides once, when it starts, from the setting, the run's mode and its provider, and keeps that answer to the end, so a change takes effect on the next run. Settings → General → **Strict checks** has no effect on a lean run: the quality checks it would make strict do not run at all.

The resolved mode is recorded:

- in the trace's runtime config, as `lean_mode_setting` (`auto`, `on` or `off`) and `lean_mode` (`true` or `false`);
- in a `lean_mode` trace note at the start of the run, with the reason (for example `strong_cloud_model`, `local_provider`, `prompt_tier`, `model_not_listed`) and the model family;
- in the run's end details (`onRunFinished`'s `leanMode`), which the scheduler also keeps for scheduled runs.

## Auto rules

Auto turns lean mode on only when all of these hold (`src/*/src/agent/lean-mode.js`):

1. **The run is in Act mode.**
2. **The provider is a cloud or router provider.** A provider whose category is local, and llama.cpp, Ollama, LM Studio and WebGPU in any configuration, never get lean mode under Auto, whatever model they serve. A provider of unknown category does not either.
3. **The provider's prompt tier is Full.** A provider the user set to Compact or Mid keeps its tier's tools and prompt.
4. **The model id is on the strong-model list:**
   - Claude Opus and Sonnet, generation 4 and later, and Claude Fable and Mythos (`claude-sonnet-4-5`, `claude-opus-4-1-…`, `claude-fable-5-1`, `anthropic/claude-sonnet-4.5`, Bedrock ids);
   - GPT-5 and later, including gpt-6 variants, except nano models;
   - OpenAI o3, o4 and later o-series reasoning models;
   - Gemini 2.5 Pro and newer Pro or Ultra models;
   - Grok 4 and later.

   Ids are matched in lower case anywhere in the string, so router prefixes, regional prefixes and dated snapshots match. Haiku, Flash, GPT-4o, Claude 3.x and the WebBrain Cloud default model are not on the list, so Auto leaves them off.

The list is `LEAN_STRONG_MODEL_RULES` in `lean-mode.js`. That file is identical in both builds (a test checks it); add a family there when it has proven itself, and add a case to `test/lean-mode.mjs`.

## What a lean run gets

**Tools.** 17 of WebBrain's existing tools, with the same schemas as at the Full tier: `get_accessibility_tree`, `read_page`, `inspect_viewport`, `click_ax`, `click`, `set_field`, `type_ax`, `set_checked`, `type_text`, `press_keys`, `scroll`, `navigate`, `wait_for_stable`, `upload_file`, `calculate`, `clarify` and `done` (`LEAN_TOOL_NAMES` in `tools.js`). `generate_image`, `carousel_navigate`, `gmail_count_results` and the tools of enabled skills are added when they apply, as in a full run; a Compact provider set to On keeps its own `upload_file` contract.

Not offered: `browser_batch`, the scratchpad and progress ledger, `fetch_url` and the other fetch, research and download tools, iframe and shadow-DOM tools, `hover` and `drag_drop`, `verify_form`, the chat-workflow tools, scheduling, WebMCP and the CAPTCHA tools. Tabs are not model-callable in WebBrain in any mode. A call to a tool a run does not offer is refused, as in every mode.

**Prompt.** `SYSTEM_PROMPT_ACT_LEAN`, about 5,900 characters against about 49,000 for the Full Act prompt. It keeps the untrusted-page-content boundary and the prompt-injection rules in full, the hard limits (deleting, paying, sending, publishing, recipients, credentials and one-time codes, CAPTCHAs and other human checks), the sensitive-data guidance and the plan-to-execution rules. It tells the model that WebBrain will not check its typing or its result, so it must read the page again before `done`. The notes for batching, WebMCP, research escalation and the CAPTCHA solver are left out because their tools are.

[lean-mode-comparison.md](lean-mode-comparison.md) has the exact sizes; per turn a lean run sends about 70% fewer prompt and tool-schema tokens.

## What lean mode skips

Every guard of class `quality` in the guard registry (`src/*/src/agent/guard-policy.js`) is skipped, except the 13 listed under "What stays" below. A skipped guard does not refuse, adds no note to the tool result and no caveat to the answer, and forces no extra turn. The agent's guard helpers report it as `skip` (`_guardOutcome`, `_guardAdvises`, `_guardAdvisesFor`, `_guardRefusesOnce`).

The page reads and model calls that only those guards use are skipped as well:

- **At `done`:** the verification screenshot and page probes, the completion judge, the page-warning and workflow-evidence checks, the done-summary reading of a failed or partial result, and the forced read-only and done-only turns. `done` is the model's own call.
- **Typing:** the readback of text writes. A write the content script cannot read back exactly is reported as `success: true, verified: false, unverifiedWrite: true`, with no note, no lock and no text-write debt, so the next write to the field goes through.
- **Around submits:** the form-validation snapshots before and after a submit and their caption readings, and the GitHub commit gates (the editor-proof binding and the split-write rule).
- **Progress and reading:** the progress ledger (its classification and its checks), the read-coverage scope reading, the arithmetic-task reading, and the readings of upload lines, authored field labels and review-thread controls for workflow evidence.
- **Rich text:** the formatting-toolbar classification and its screenshot and vision audit.
- **Scheduled tasks:** the optional System One completion judge for a run that ran lean.

## What stays

Lean mode keeps:

- **The hard classes, with their cards:** a wrong or unverified **recipient**, **deletions**, **money**, **credentials** and **publishing** something the user did not ask for.
- **Permission gates:** site permissions, the submit confirmation card ("Ask before consequential actions"), Ask mode's read-only rule, `/allow-api`, and the refusal of tools the run does not offer.
- **Host checks:** same-site and frame checks right before each action, task authority, a person acting in the tab, the page-feedback fences, untrusted-content wrapping and the prompt-injection boundary, and the CAPTCHA boundary. With no CAPTCHA tools, a challenge goes to the user, as on the Compact tier.
- **Budgets:** the step limit and its final done-only turn, the loop detector and the observation budgets.
- **User control:** Stop, steering, and the user's answers to cards and questions.

Some steps that look like quality work feed the hard checks, so they stay too:

- the planner's intent gate (it names the recipients, the deletion intent and the site workflow the hard checks bind to);
- submit detection and the reading of a clicked control's caption (they decide the submit card and the deletion guard);
- the workflow-field classifier for message, transaction and publication workflows (the publication and recipient checks compare against its fields);
- the social publication contract;
- the rich-text toolbar probe, which pins the typing target (only its classification is skipped);
- automatic screenshots, as set in Settings;
- a delivered chat message's receipt, which must be saved before `done` reports success, or a resumed run could send it again.

These quality guards keep running, each because a hard check depends on it (`LEAN_KEPT_QUALITY_GUARDS` in `lean-mode.js`):

| Guard | Why it stays |
| --- | --- |
| `owned-native-chat-read-repair` | The recipient guard needs WebBrain's own exact read of the latest messages before a reply is sent. |
| `chat-send-evidence-unavailable` | A send whose conversation or message baseline cannot be observed cannot be checked for the right recipient or a duplicate. |
| `recipient-draft-evidence-unavailable` | The recipient guard reads the draft body and the message baseline to verify a send. |
| `recipient-guard-target-preparation` | It runs inside the recipient guard's own target resolution. |
| `preparation-timeout-action-pipeline` | The same deadline covers the publication audit, chat-send preparation and the task-attempt checkpoint. |
| `social-publication-draft-quality` | The publication audit judges the observed composer draft; a draft it cannot observe cannot be audited. |
| `steer-prior-submission-target-unresolved` | After a correction, an unidentified submit control may repeat an earlier submission. |
| `captcha-solve-detection-binding` | It keeps a paid CAPTCHA solve from going to the wrong widget. |
| `set-field-bundled-submit-outcome` | `set_field` never sends its bundled Enter for a value it could not verify. |
| `clickax-native-button-preparation` | Its vetoes include a person acting in the tab and a change of task owner (host checks). |
| `clickax-trusted-retry-vetoes` | It stops WebBrain's own automatic re-click from acting twice. |
| `action-no-progress-classification` | It feeds the loop detector, a budget. |
| `terminal-recovery-no-success` | It is the ending of the step-limit and observation budgets. |

## What to expect

- **The model checks its own work.** WebBrain does not tell it that a write could not be read back or that the page still shows a form; the prompt asks it to read the page again before `done`. A strong model does this with a tree read or `inspect_viewport`; a weak one may report success too early, which is why Auto keeps lean mode off for local and small models.
- **No caveat line.** A lean answer never carries "WebBrain could not verify everything", because WebBrain verified nothing.
- **GitHub commits go through.** The commit after a CodeMirror edit is no longer held for an exact editor proof. The submit card still asks before the commit when "Ask before consequential actions" is on, and the committed file is not read back by WebBrain.
- **Scheduled lean runs stop for the user more often.** When a scheduled run's consequential action ends with an effect WebBrain could not confirm, the task waits for the user to check the page before it runs again. In a full run the completion judge can confirm the effect and settle it; a lean run has no judge.
- **CAPTCHAs go to the user.** A lean run has no solver tools, so a challenge is handed to the user even when a CAPTCHA solver is configured.

## How to compare

```sh
node scripts/lean-mode-comparison.mjs          # or npm run compare:lean-mode; prints the tables, rewrites docs/lean-mode-comparison.md
node scripts/lean-mode-comparison.mjs --check  # exit 1 when the doc is out of date
node scripts/lean-mode-comparison.mjs --json   # the raw numbers
node scripts/lean-mode-comparison.mjs --debug  # each run's tool calls, results and page traffic
```

The script is offline and deterministic. It measures the system prompt and tool schemas a model receives per Act turn for a Claude-class and a GPT-class provider in both builds, then replays three tasks through the Chrome build's real run loop with Lean mode Off and Auto: the GitHub CodeMirror edit and commit, a simple form, and a read-only lookup. The pages run in headless Chromium (Playwright) with the extension's content scripts; the model is a fixed tool-call script. The doc explains what such a replay can and cannot show.

`test/lean-mode.mjs` covers the Auto rules, the tool list and prompt, the skipped and kept guards, run loops in both builds, and the settings, export, locale and trace wiring.
