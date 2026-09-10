# Social publication contracts

X and Bluesky publication use the agent's selected provider for language understanding. The runtime validates a structured contract and compares app-observed values before dispatch and completion. There is no separate intent model or provider setting.

## Intent and authorization

`social-publish-contract.js` defines the schema and prompts in both browser builds. The agent caches a contract per task, with at most one repair attempt for invalid output. A direct human clarification reply refreshes an unattempted contract, using the original request, task anchor, authentic prior user turns for referenced follow-ups, and the exact question/answer pairs. Timeouts, automatic choices, and model-authored tool results cannot supply these replies. The approved plan, assistant drafts, and unanswered proposals are reference data. Plans, drafts, and page content do not independently authorize publication. The app-observed platform at request start can resolve an omitted destination for an explicit publication command; later navigation cannot change that default or override an explicit destination.

Prior user context includes at most four recent whole turns, within the remaining 120,000-character serialized source budget. Current instructions and clarification pairs take priority. Selection stops at a turn that cannot fit; it never truncates a correction or skips back to an older instruction. Refreshes also bound previously cached history. Oversized current instructions still block compilation rather than being silently truncated.

The contract records destinations, accounts, ordered post bodies, media constraints, reply/quote targets, prohibited destinations, and `all`, `any`, or conditional `fallback` requirements. Exact text uses source anchors so the runtime copies the original text instead of accepting a model-reconstructed excerpt. Repeated anchors accept optional `startOccurrence` and `endOccurrence` positive, one-based ordinals, each counted from the beginning of the named source (including overlapping matches). For a short literal with identical start/end anchors, `startOccurrence` alone selects that copy. Omitted ordinals still require unambiguous anchors; invalid or reversed selections are rejected. Unsupported or ambiguous requirements produce `clarify`; read-only or narrative requests produce `none`. Invalid contracts cannot fall back to lexical intent rules.

A ready contract is not sufficient permission to dispatch. Before a separate publish click, the same selected provider independently checks the authentic request against the concrete composer snapshot. Approval is cached only for that contract, action, payload, account, and page. The runtime rereads the composer after the audit and immediately before execution. A changed snapshot needs a new audit. Rejections retain the checker's reason (or identify invalid/mismatched output) in the tool result so recovery can resolve the actual issue instead of rewriting a matching draft. Arbitrary JavaScript, bundled editing/submission, keyboard submission, and opaque callbacks cannot substitute for the observed publish control.

## Deterministic enforcement

- Preserve exact body and alt text, accepting only NFC equivalence and CRLF normalization. Compose requests bind completion to the audited draft.
- Read ProseMirror paragraph boundaries and hard breaks as document text, excluding its trailing caret placeholder. Field verification, field digests, Chrome CDP verification, and publication snapshots preserve the same spaces and line breaks.
- Require complete composer/account/media/context observations and a pre-dispatch permalink baseline. Unassigned or shared thread media makes the observation incomplete.
- Failed preflight reports `publicationValidation.issues`, distinguishing missing account/composer/baseline evidence from body, media, or context mismatches. Body mismatches include lengths and the first differing character position/code points without copying the observed draft into diagnostics.
- Verify a new, account-bound permalink with complete authored body and media evidence. Reply, quote, and ordered thread relationships need their own observed proof.
- Bluesky detail pages can bind their current permalink to one visible matching-author thread card without a self-link. Conflicting permalinks, duplicate candidates, hidden cards, feeds, and embedded posts cannot supply that binding. Read native word-wrapped rich text within the owning card, excluding previews and controls, and preserve exact paragraphs and link destinations.
- Include the current resource URL in the pre-dispatch baseline even when a composer hides the existing post. Keep the focused detail record ahead of neighboring records when applying completion limits, so long threads retain its verification evidence.
- Exclude native Bluesky quote containers (`div[role="link"]`) from the owning post's body and media. A quote without an observed target, or a focused thread item with preceding cards but no verified parent, retains incomplete context and cannot satisfy publication. An empty parent URL alone is not proof of a standalone post.
- Track each contract action as pending, failed, or verified. Uncertain delivery never unlocks an alternative or fallback, and cannot authorize another publish attempt.
- Preserve the contract, authentic clarification pairs, and outcomes only across the existing trusted Continue boundary. A new user task gets a new contract. Clarification after an attempted publication retains its outcomes and blocks further dispatch under the stale instructions; it cannot reset delivery uncertainty or authorize a duplicate.
- Preserve bound upload evidence when clarification recompiles an unchanged, unattempted action in the same workflow. Changed action constraints or workflow bindings reset it; every refreshed contract still requires a fresh authorization audit.
- Recognize Bluesky desktop composer launchers as non-submitting controls outside forms/dialogs. Actual publish buttons retain the full contract checks.
- Recognize the modal Cancel and Keep editing controls as non-submitting recovery actions, rejecting conflicting publish labels, test IDs, or form ownership.
- A corrected replacement after an uncertain text write can proceed only after a read-only digest proves the original replacement landed in the same document and field. Changed, incomplete, or unavailable readbacks retain the block; generic page reads never clear it.
- Convert screenshot clicks to CSS coordinates before target/iframe preflight, and use that same point for dispatch.

Malformed output or failed model calls block publication. Schema validation establishes structure, not correct language understanding; the independent audit is also fallible. Missing site evidence blocks dispatch/completion rather than supplying inferred proof.

## Validation

`npm test` includes the deterministic contract/runtime tests, using mocked responses to verify selected-provider routing, validation, caching, conditional progress, and dispatch/completion enforcement. `npm run test:social-contract:dom` runs both browser implementations against local Playwright fixtures, including their actual injected completion probes. It requires installed Playwright Chromium; every fixture request is fulfilled locally.

The historical language cases from PR #340 are retained in `test/llm/fixtures/social-publication-intent.json`. They are evaluation inputs, not a claim of live-model accuracy. Evaluate the compiler and independent audit against the selected provider before drawing conclusions about multilingual understanding, false authorization rates, or latency. Some historical inputs omit the payload or parent URL and should legitimately require clarification.

### Live benchmark

`test/llm/run-social-publication.mjs` uses the production provider class, compiler/repair loop, and audit prompt. Its reviewed set contains 51 compiler cases and 20 deliberately incorrect audit proposals, plus positive audits of initially eligible reviewed actions. The historical corpus is a separate exploratory suite because some old destination labels treat opening a composer as publication intent.

```sh
node test/llm/run-social-publication.mjs --validate-only
node --test test/llm/lib/social-publication-score.test.mjs
node test/llm/run-social-publication.mjs --config /private/provider.json
node test/llm/run-social-publication.mjs --config /private/provider.json --suite legacy
```

The config accepts the existing provider fields (`providerName`, `baseUrl`, `model`, `apiKey`, and optional provider settings). Alternatively supply `--base`, `--model`, `--provider`, and an API-key environment variable named by `--api-key-env`. Use the same provider/model/settings as the agent; the runner does not silently select a replacement. Anthropic native and OpenAI-compatible transports are supported.

Calls run sequentially. Reports distinguish first-response validity, repairs, semantic contract errors, audit false accepts/rejects, token usage, and median/p95 latency. First-call latency is reported separately without assuming a cold server. Default results are ignored local artifacts under `test/llm/results-social-publication/`, with a Markdown report, per-case JSONL, and prompt/fixture hashes. The runner never invokes a browser action or publishes a post.
