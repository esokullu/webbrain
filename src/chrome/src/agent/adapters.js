/**
 * Site Adapters — per-site notes the agent receives when operating on a
 * known high-traffic site. The goal is NOT to encode every selector (those
 * rot fast), but to capture the non-obvious quirks that cost an LLM several
 * dead-end tool calls to discover on its own.
 *
 * Each adapter:
 *   - match(url): boolean — does this adapter apply to the current URL?
 *   - name: short identifier
 *   - category: 'general' | 'finance' — finance gets an extra safety warning
 *   - notes: short bulleted guidance, injected into the first user message
 *
 * Keep notes SHORT (4–8 bullets max). They cost tokens on every first turn.
 * Only encode things the model can't trivially figure out from reading the page.
 *
 * Stale adapters are worse than missing ones. If a note says "click X" and X
 * has been renamed, the model will trust the note and fail. When in doubt,
 * describe the SHAPE of the page rather than literal selectors.
 */

const ADAPTERS = [
  // ─── Code & Dev Tools ─────────────────────────────────────────────────
  {
    name: 'github',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?github\.com\//.test(url),
    notes: `
- Creating a release: navigate to /<owner>/<repo>/releases/new (not /releases). The tag selector is a combobox labeled "Choose a tag" — click({text: "Choose a tag"}) to open it, then type the tag name into the focused popup, then click({text: "Create new tag"}) to confirm.
- DO NOT use index-based clicks on the release page. GitHub's global header pollutes the index space and the release form is deep in the DOM. Always use click({text:"..."}) for buttons. Specifically: never click element #38 from memory — that's a learned anti-pattern from training data, and on the live site #38 is the "Pull requests" header link that navigates away from the release form.
- Release body is a CodeMirror editor, not a textarea. Click the editor surface (click({text:"Describe this release"}) on the placeholder works) then type with no selector.
- The green "Publish release" button is at the bottom of the form. Click it with click({text: "Publish release"}). The gray "Save draft" is right next to it — don't confuse them.
- Issue/PR comments use the same CodeMirror editor; markdown preview is on a separate tab.
- File browser: pressing "t" opens the fuzzy file finder (faster than navigating folders).
- Settings/admin actions often require re-entering the repo name as a confirmation — read the modal carefully.`,
  },
  {
    name: 'gitlab',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?gitlab\.com\//.test(url),
    notes: `
- Releases live at /<group>/<project>/-/releases/new. Tag must exist or be created via "Create tag" inline.
- Merge requests have a "Merge" button that may be disabled until pipelines pass; check the pipeline status before clicking.
- The sidebar collapses on narrow viewports — scroll horizontally or expand it before clicking sidebar items.`,
  },
  {
    name: 'stackoverflow',
    category: 'general',
    match: (url) => /^https?:\/\/(.*\.)?stackoverflow\.com\//.test(url) || /^https?:\/\/(.*\.)?stackexchange\.com\//.test(url),
    notes: `
- Answers are sorted by votes by default; the accepted answer has a green check and may not be the highest-voted.
- The question body and each answer have separate edit histories — link to "edited" timestamps for provenance.
- Code blocks use 4-space indentation OR triple-backtick fences. When extracting code, preserve indentation exactly.`,
  },
  {
    name: 'hackernews',
    category: 'general',
    match: (url) => /^https?:\/\/news\.ycombinator\.com\//.test(url),
    notes: `
- Comments are nested via indentation (the "indent" image's width tells you the depth). To find the top-level reply chain for a comment, walk back to the matching depth.
- "More" link at the bottom of comment pages loads the next page — the URL has a "next" token, not a numeric page.`,
  },

  // ─── Communication & Productivity ─────────────────────────────────────
  {
    name: 'gmail',
    category: 'general',
    match: (url) => /^https?:\/\/mail\.google\.com\//.test(url),
    notes: `
- Composing: the "Compose" button opens a floating window. The "To" field is a contact picker — type the name and pick from the dropdown, don't just type the raw email.
- The body is a contenteditable div (rich text), not a textarea. Click into it before typing.
- Sending: the "Send" button is bottom-left of the compose window; "Send + Schedule" arrow is next to it for scheduled send.
- Search uses operators: from:, to:, subject:, has:attachment, before:YYYY/MM/DD.
- Threads collapse old messages — click "Show trimmed content" or the message header to expand.`,
  },
  {
    name: 'google-docs',
    category: 'general',
    match: (url) => /^https?:\/\/docs\.google\.com\/document\//.test(url),
    notes: `
- The document body is a canvas-rendered editor (NOT a normal contenteditable). Direct DOM typing usually fails. Use the floating textbox that appears when you click into the doc, or use keyboard shortcuts.
- Comments are in the right margin; click the comment icon to open the comment panel.
- Real-time collaboration means the cursor and text shift while you read. Re-read after a delay if a write seems lost.`,
  },
  {
    name: 'google-calendar',
    category: 'general',
    match: (url) => /^https?:\/\/calendar\.google\.com\//.test(url),
    notes: `
- Creating an event: click an empty time slot OR press "c". A popover appears with title, time, guests.
- Guests field is a contact picker; type the name and pick from the dropdown.
- "More options" expands to the full event editor. The "Save" button asks about notifying guests — read the modal.
- View switching: 1=day, 2=week, 3=month, 4=year, 5=schedule, 6=4-day.`,
  },
  {
    name: 'slack',
    category: 'general',
    match: (url) => /^https?:\/\/app\.slack\.com\//.test(url) || /\.slack\.com\//.test(url),
    notes: `
- Slack is a heavily virtualized scroll list — messages off-screen aren't in the DOM. Scroll to load more.
- The message composer is a contenteditable; @mentions and #channels open a picker that requires keyboard selection.
- Threads open in a side panel; replying in a thread is different from replying in the channel.
- "Send" is implicit on Enter (Shift+Enter for newline). To pre-select "Send to channel and reply", check the box first.`,
  },
  {
    name: 'notion',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?notion\.so\//.test(url),
    notes: `
- Every block is a separate contenteditable. Pressing Enter creates a new block; "/" opens the slash menu for block types.
- Drag handles appear on hover at the left edge. Selection across blocks works with shift-click.
- Database views (tables, boards, calendars) are virtualized — rows off-screen aren't in the DOM. Use the search inside the database to filter, don't try to scroll through everything.
- Page properties (title, status, etc.) are at the top above the body and use their own widgets.`,
  },
  {
    name: 'jira',
    category: 'general',
    match: (url) => /\.atlassian\.net\//.test(url),
    notes: `
- Issue keys (PROJ-123) are everywhere — clicking them opens the issue in a side panel or new view.
- Status changes go through a workflow dropdown that may have intermediate states. Read the available transitions before clicking.
- The description editor is a rich-text editor with its own toolbar. Markdown shortcuts work but don't render until you blur.
- JQL search is at /issues/?jql=... — much more powerful than the basic search bar.`,
  },

  // ─── Social & Content ─────────────────────────────────────────────────
  {
    name: 'twitter',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//.test(url),
    notes: `
- The composer is a contenteditable, not a textarea. Character count is enforced client-side at 280 (or higher for Premium).
- The timeline is virtualized — tweets scroll out of the DOM. To find a specific tweet, use search, don't scroll.
- "Reply", "Retweet", "Like" icons are below each tweet; the share menu has "Copy link" for permalinks.
- Quote tweets vs reposts: the retweet icon opens a menu with both options.`,
  },
  {
    name: 'linkedin',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?linkedin\.com\//.test(url),
    notes: `
- LinkedIn aggressively lazy-loads everything; scroll to populate the feed/profile, but most content lives in modal-style detail panes.
- "Connect" button on profiles often has a "Send without a note" prompt — read it before clicking.
- Messages are at /messaging — the message composer is a contenteditable with image/file upload icons.
- Search has filters (People, Posts, Jobs, Companies) as tabs at the top.`,
  },
  {
    name: 'reddit',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.|old\.|new\.)?reddit\.com\//.test(url),
    notes: `
- old.reddit.com and new.reddit.com have completely different DOMs. Check the URL before assuming selectors.
- Comments are nested deeply; "load more comments" links require clicking to expand.
- Voting requires being logged in; the up/down arrows are siblings of each post/comment.
- Post composer: title, body (markdown editor), flair selector. "Submit" button is at the bottom.`,
  },
  {
    name: 'youtube',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?youtube\.com\//.test(url),
    notes: `
- The video player is a custom element. Keyboard shortcuts: space=play/pause, k=play/pause, j/l=±10s, ←/→=±5s, m=mute.
- Comments load lazily AFTER you scroll past the video — they're not in the initial DOM.
- "Show transcript" lives in the description "..." menu, not a top-level button.
- The subscribe button has a bell icon next to it for notification preferences; they're separate clicks.`,
  },
  {
    name: 'medium',
    category: 'general',
    match: (url) => /^https?:\/\/(.*\.)?medium\.com\//.test(url),
    notes: `
- Member-only articles show a paywall partway through — the agent sees "Read more" or a sign-up gate, not the full text.
- The clap button increments per click up to 50; long-press equivalent is multiple clicks.
- Highlights are inline annotations; hovering text shows the highlight popover.`,
  },
  {
    name: 'substack',
    category: 'general',
    match: (url) => /\.substack\.com\//.test(url),
    notes: `
- Most posts are public; some are paywalled mid-article. If the content suddenly stops with a "Subscribe" CTA, that's a paywall, not the end.
- Comments live below the article in a separate thread component.
- Subscribe button is a popup form — needs an email and may require email confirmation.`,
  },

  // ─── Commerce ─────────────────────────────────────────────────────────
  {
    name: 'amazon',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.|smile\.)?amazon\.(com|co\.uk|de|fr|ca|com\.au|co\.jp|in|com\.br|com\.mx|es|it|nl|pl|se|sg|ae|sa|com\.tr)\//.test(url),
    notes: `
- "Add to Cart" and "Buy Now" are different — "Buy Now" skips the cart and goes straight to checkout. Be very careful which one you click.
- Product variants (size, color) are buttons above the price; selecting them changes the URL and price.
- Reviews are paginated and may be filtered by stars; the "Top reviews" tab is the default.
- Subscribe & Save dropdown defaults to a recurring delivery — uncheck it if the user wants a one-time purchase.`,
  },

  // ─── Cloud Consoles & Infra ───────────────────────────────────────────
  {
    name: 'aws',
    category: 'general',
    match: (url) => /^https?:\/\/.*\.console\.aws\.amazon\.com\//.test(url) || /^https?:\/\/console\.aws\.amazon\.com\//.test(url),
    notes: `
- The region selector is in the top-right and persists in the URL — many resources are region-scoped, so check before searching.
- Service search: press "/" or click the top-left "Services" menu.
- Most "Create" actions span multi-page wizards. Don't click "Next" without reading; defaults often cost money (e.g. NAT gateways, larger instance sizes).
- Tags are usually on the last wizard page and easy to skip — they matter for billing.
- Deletion typically requires typing the resource name as confirmation.`,
  },
  {
    name: 'gcp',
    category: 'general',
    match: (url) => /^https?:\/\/console\.cloud\.google\.com\//.test(url),
    notes: `
- The project selector is in the top bar — every action is project-scoped. Confirm the project before doing anything destructive.
- The hamburger menu (top-left) hides most services; pinning frequently-used ones helps.
- Cloud Shell (top-right terminal icon) gives a real shell with gcloud preinstalled — often faster than the GUI for batch ops.
- Many services prompt to enable an API on first use; that's a one-time click but takes 30+ seconds to propagate.`,
  },
  {
    name: 'cloudflare',
    category: 'general',
    match: (url) => /^https?:\/\/dash\.cloudflare\.com\//.test(url),
    notes: `
- Account-level vs zone-level: the left sidebar changes depending on whether you're inside a specific domain or at the account root.
- DNS records: the "Proxy status" toggle (orange cloud / gray cloud) controls whether traffic routes through Cloudflare. Toggling it can break SSL or routing.
- Page rules and Rulesets are different systems; new sites should use Rulesets.`,
  },
  {
    name: 'vercel',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?vercel\.com\//.test(url),
    notes: `
- Deployments live under each project. The "Production" tab vs "Preview" tab matters — promoting a preview to prod is a separate action.
- Environment variables are scoped to environments (Production, Preview, Development); changing one doesn't auto-redeploy.
- The team selector is in the top-left, separate from the project selector.`,
  },

  // ─── Finance / High-Stakes ────────────────────────────────────────────
  {
    name: 'stripe',
    category: 'finance',
    match: (url) => /^https?:\/\/(dashboard\.)?stripe\.com\//.test(url),
    notes: `
- LIVE vs TEST mode toggle is in the top-right. Always confirm which mode you're in before creating, refunding, or canceling anything. Live actions move real money.
- Refunds are partial-by-default in the input — check the amount carefully.
- Customer deletion is irreversible and detaches all their payment methods. The confirmation modal is easy to click through.
- API keys: the secret key is shown once on creation. Don't reveal it in screenshots or chat output.
- Subscription edits often have proration prompts ("Charge prorated amount immediately" vs "On next invoice") — read which is selected.`,
  },
  {
    name: 'finance-generic',
    category: 'finance',
    // Match common bank, crypto exchange, and payment patterns by domain.
    match: (url) => /^https?:\/\/[^\/]*(bank|banking|chase|wellsfargo|bankofamerica|citibank|hsbc|barclays|santander|bnp|deutsche|ubs|coinbase|binance|kraken|gemini\.com|bitstamp|bitfinex|crypto\.com|metamask|paypal|venmo|wise\.com|revolut|n26|monzo|robinhood|fidelity|schwab|vanguard|etrade|interactivebrokers|nordnet|degiro)\b/i.test(url),
    notes: `
- ⚠️ HIGH-STAKES SITE (financial / banking / crypto). Real money is at stake and many actions are irreversible.
- DO NOT initiate transfers, trades, payments, withdrawals, or balance changes without an EXPLICIT, SPECIFIC instruction from the user that names the destination and amount in this conversation. Vague instructions like "send some" or "buy a bit" are NOT sufficient.
- Always read confirmation modals carefully and read them back to the user before clicking the final confirm.
- If the user asks you to "check balance" or "show transactions", do that and stop. Don't proactively click action buttons.
- Wallet connect prompts, signature requests, and 2FA codes should be surfaced to the user — never auto-approve.`,
  },
];

/**
 * Find the first adapter matching the given URL.
 */
export function getActiveAdapter(url) {
  if (!url) return null;
  for (const a of ADAPTERS) {
    try {
      if (a.match(url)) return a;
    } catch (e) { /* malformed URL or broken matcher — skip */ }
  }
  return null;
}

/**
 * Get a printable list of all registered adapters (for settings UI / docs).
 */
export function listAdapters() {
  return ADAPTERS.map(a => ({ name: a.name, category: a.category }));
}
