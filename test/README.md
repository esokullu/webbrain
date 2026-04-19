# Tests

Three layers, each with a different scope, speed, and cost profile.

## Setup (once)

```bash
npm install
npx playwright install chromium
```

## 1. Unit — `npm test`

`test/run.js`. Pure-JS tests of loop detection + adapter routing. No browser, no network. Already green (32 passed as of v4.0.1).

## 2. Fixtures — `npm run test:fixtures`

`test/fixtures/`. Playwright loads local HTML files that reproduce the exact failure modes v4.0.1's overlay defenses fix:

- `modal-scoping.html` — dialog with "Create" over a background that also has "Create" + "Publish release". Verifies `_findTopmostModal()` scopes the text resolver, so `click({text:"Create"})` picks the dialog's button and `click({text:"Publish release"})` returns a scoped no-match.
- `occlusion.html` — target button covered by a transparent overlay with higher z-index. Verifies the post-click `elementFromPoint` hit-test refuses with `{occluded:true}`, and that coord clicks correctly bypass the check.
- `ambiguity-candidates.html` — two "Cancel" buttons in different landmarks. Verifies the ambiguity response carries `{cx, cy, ancestor}` with the containing form / section identified.

No LLM, no API keys, no network. Deterministic, ~5 seconds. Run on every PR.

## 3. Anonymous scenarios — `npm run test:anonymous`

`test/anonymous/`. Playwright launches Chromium with the Chrome extension loaded, opens each scenario's URL, fires a `chat` message at the background service worker, waits for the agent's final reply, and runs the scenario's `check`. Uses a persistent profile (`.test-profile/`, gitignored) so configuration sticks between runs.

### First run

No providers are configured yet. The runner opens the Settings page; add a provider + API key there, close the browser, re-run. Or run `npm run test:anonymous -- --setup` just to open Settings without trying to execute.

### Scenarios

Defined in `scenarios.json` — add more by following the shape. Supported `check` types:

- `{type:"contains", value:"...", field:"content"}` — substring match against the agent's final text answer (case-insensitive). Add `minLength` to require a non-trivial reply.
- `{type:"regex", value:"...", flags:"i"}` — full regex.

Only anonymous/public sites here. Signed-in scenarios (Gmail, GitHub issue filing, Stripe) need a baked session and can be driven via the same harness once you add auth handling — but don't try to automate those in CI; keep them local.

### Usage

```bash
npm run test:anonymous                              # all scenarios
npm run test:anonymous -- --scenario=arxiv-attention-title  # just one
npm run test:anonymous -- --setup                   # open settings only
```

Headed by default so you can watch runs and intervene. Budget ≈ 10–30 seconds per scenario + LLM tokens per the configured provider.
