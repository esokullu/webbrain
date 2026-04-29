# WebBrain — Engineering TODOs

Living list of things we know we want to do but haven't done yet. Each item
should explain *why* it matters, not just *what* to change, so that future
contributors (or future-us) can decide whether the entry is still relevant
without re-deriving the analysis.

## 1. Resolve the compact-vs-full system prompt contradiction

**Status:** Open. Compact prompt is currently disabled in code; every provider
gets the full ACT prompt. UI checkbox and provider config still exist; routing
is commented out.

**Where the code lives:**
- Compact prompt body — [`src/chrome/src/agent/tools.js`](src/chrome/src/agent/tools.js) `SYSTEM_PROMPT_ACT_COMPACT` (~38 lines, ~5 KB, ~1.3K tokens)
- Full ACT prompt body — same file, `SYSTEM_PROMPT_ACT` (~205 lines, ~30 KB, ~7.4K tokens)
- Dispatch — [`src/chrome/src/agent/agent.js:1528`](src/chrome/src/agent/agent.js#L1528) `_getActPrompt()` — currently hard-returns the full prompt. The original branch is preserved as a code comment.
- Provider opt-in — `BaseLLMProvider.useCompactPrompt` getter + per-provider override (`openai.js`, `llamacpp.js`).

**The actual contradiction:**

The compact prompt was introduced for small models (~7B–13B). Two stated reasons:
1. Small models have shorter effective attention windows — info from the front of a 30K prompt may not influence late-conversation decisions.
2. Their context windows are smaller (often 8K–32K) so a 7K prompt eats a lot.

But small models *also* need **more direction**, not less:
1. Their reasoning is shallower — they can't infer "I shouldn't re-download" from "scratchpad facts"; you have to literally tell them.
2. They pattern-match more than they reason — examples help more than abstract rules.
3. They need scaffolding (do A, then B, then C) where larger models can plan A→B→C themselves.

So "less prompt" pulls one way and "more explicit guidance" pulls the other.

**What the compact prompt actually cuts (and why this is the wrong cut):**
- All worked examples (e.g. UI-vs-API has 5 examples in full, 0 in compact).
- Whole sections judged "edge cases small models won't encounter": IFRAMES, the `/allow-api` override, extended FORMS reasoning.
- Replaces multi-paragraph rules with single-sentence imperatives.

The "drop examples to save tokens" choice is exactly backwards: examples are how small models get unstuck. Removing nuance and reasoning while keeping bare imperatives gives the small model orders without the gradient information needed to follow them.

**The 27B trace evidence:**

`webbrain-trace-qwen3.6-27b-run_1777441198379_v1rqkk.json` — qwen3.6-27b on llama.cpp. Asked to upload `dist/*.zip` to a v5.1.0 GitHub release. Re-downloaded the same files **three times** because each auto-screenshot pushed the original `download_files` result out of recent attention, and the model re-derived "I need to fetch the files" from current visual state. Pattern-matched on intent, not on prior tool history. This is the failure mode small-model compactness was meant to address — and yet the compact prompt would have made it worse by stripping the SCRATCHPAD section that says explicitly to pin download paths.

Per-step input tokens for that run: 21K → 21K → 28K → 30K → 40K (auto-screenshot growth, not summarization growth). The model paid the tax of the full prompt (~7.4K) AND lost track of state. The current "everyone gets full prompt" decision was the right local fix.

**What an actual resolution would look like:**

Three tiers, not a binary:

| Tier | Models | Prompt shape | Approx size |
|------|--------|--------------|-------------|
| Frontier | Sonnet, Opus, GPT-4o, Gemini Pro | Trim worked examples, keep rules. Trust their planning. | ~3K tokens |
| Mid | Llama 70B, Qwen 35B, GPT-4o-mini | Full rules + 1-2 examples per rule. | ~5K tokens |
| Small | 7B–30B local (qwen3.6-27b, etc.) | Full rules + many examples + simpler imperative vocabulary, + extra failure-mode reminders. **Larger, not smaller, than current full prompt.** | ~6K-7K tokens |

Per-model-class prompt selection wired through `_getActPrompt()`. Tier inferred from provider config (`useCompactPrompt` is the wrong axis — it should be `tier: 'frontier' | 'mid' | 'small'`).

**Why this is on the TODO list and not in flight:**
- Requires picking the tier per model rather than per-provider, which means a model→tier mapping (or a heuristic).
- Examples need to be written deliberately, not extracted from the existing full prompt.
- The current "everyone gets the full prompt" works for frontier-skewed users (the dominant cohort), so the urgency is on the small-model end which is also where local-host iteration is hardest to test.

**Concrete next steps when picking this up:**
1. Define the tier enum and a `getTier()` method on each provider class. Default frontend models to `frontier`, OpenAI/Anthropic configs with non-flagship model names to `mid`, llama.cpp / lmstudio / ollama to `small`.
2. Author `SYSTEM_PROMPT_ACT_FRONTIER` (trimmed) and `SYSTEM_PROMPT_ACT_SMALL` (expanded). Keep `SYSTEM_PROMPT_ACT` as the mid-tier default.
3. Re-enable the dispatch in `_getActPrompt()` to route by tier.
4. Re-run the qwen3.6-27b trace scenario and verify the small-tier prompt prevents the re-download loop.
5. Token-budget the prompt against each model's context window so prompt + first turn fits.

---

## 2. Other small Firefox parity gaps

The Firefox build is meaningfully weaker than Chrome (already noted in the README's "Known Issues"). Some gaps are platform-real (no CDP, no Manifest V3 service worker), but several are just unported features. Worth ticking off one at a time:

- **`upload_file`** — not yet in Firefox. The dispatcher path exists for downloads but not for uploads. Likely a few hours of work; webextensions has the same `<input type="file">` mechanics.
- **`download_file` (singular)** — Firefox has plural `download_files` only. Trivial port.
- **Conversation persistence across background restarts** — Chrome persists per-tab chats to `chrome.storage.session`; Firefox keeps them in-memory only. This is why the scratchpad port deliberately skips the `_persist` call. Real fix would persist via `browser.storage.session` + restore on background page reload.
- **`full_page_screenshot`** — Chrome uses CDP `captureBeyondViewport`; Firefox would need `tabs.captureFullPage` or a scroll-and-stitch fallback. Lower priority.
- **`shadow_dom_query`** — CDP-dependent. Hardest port; may not be worth it until a concrete user case emerges.

---

## 3. Trace recorder: tool events missing step number

When inspecting any trace JSON, `kind: "tool"` events have `data.step === null` even though the surrounding `llm_request` / `llm_response` events carry the right step (1, 2, 3, …). The Compare view in the Traces page would benefit from step numbers on tool rows; currently the timeline still renders fine because `traces.js` falls back to `''` when step is missing.

**Where to fix:** [`src/chrome/src/trace/recorder.js`](src/chrome/src/trace/recorder.js) — the tool-call recording path needs to pull the current step number from the agent loop the same way `llm_request` does. Quick fix; just hasn't been done.

---

## 4. Notes from the qwen3.6-27b sahibinden run (separate from the upload run)

That trace (`webbrain-trace-gpt-4o-run_1777328860857_tb4voc.json` — model labeled `gpt-4o` but provider was `lmstudio`, so a local model in disguise) showed two re-occurring patterns the LISTINGS & PAGINATION prompt addition (commit landed already) directly targets:

- Re-fetched `?sd=2` three times in a row via three different tools (research_url ×2, fetch_url ×1) without ever extracting an item from any of them.
- Hit `get_accessibility_tree({filter:"all"})` overflow twice with different `maxChars` values, never switching to a different tool.

The prompt rules now name these failures explicitly. Worth re-running the same prompt on a fresh trace once a small-tier prompt exists to see whether the rules alone fix it or whether the model still ignores them at small parameter counts.
