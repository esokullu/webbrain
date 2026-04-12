/**
 * Tool definitions for the WebBrain agent.
 * These are sent to the LLM in OpenAI function-calling format.
 */

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: 'Read the current page content including title, URL, text content, links, and forms. Use this to understand what is on the current page.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Capture a screenshot of the visible area of the current tab. Returns a base64-encoded PNG image. Useful when you need to visually inspect the page, verify the result of an action, or when DOM text extraction is insufficient.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_interactive_elements',
      description: 'Get all interactive elements on the page (buttons, links, inputs, etc.) with their positions and attributes. Returns an indexed list you can reference by index.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element. FOUR ways to use it: (1) CSS selector, (2) visible text, (3) element index from get_interactive_elements, (4) x/y coordinates. For text clicks, default matching is EXACT and case-insensitive. You can opt into broader matching with `textMatch: "prefix"` or `textMatch: "contains"`. Note: jQuery/Playwright pseudo-classes like `:contains()` and `:has-text()` are NOT valid CSS and will fail; use the `text` parameter instead.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Visible text to match against clickable elements.' },
          textMatch: { type: 'string', enum: ['exact', 'prefix', 'contains'], description: 'Text matching mode for `text`. Default is `exact` (safest).' },
          selector: { type: 'string', description: 'CSS selector for the element to click' },
          index: { type: 'number', description: 'Index from get_interactive_elements result' },
          x: { type: 'number', description: 'X coordinate to click' },
          y: { type: 'number', description: 'Y coordinate to click' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: 'Type text into an input field. THREE WAYS to use it: (1) provide a CSS selector to find the field by selector, (2) provide an element index from get_interactive_elements, or (3) provide ONLY the text (no selector, no index) to type into the currently focused element — use this RIGHT AFTER clicking a field. The third form is the most reliable for forms with weird selectors (e.g. GitHub release[name], Stripe nested inputs): click the field with `click({selector: ...})`, then immediately call `type_text({text: "..."})` with no selector.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'OPTIONAL CSS selector for the input element. Omit to type into the currently focused element.' },
          index: { type: 'number', description: 'OPTIONAL element index from get_interactive_elements.' },
          text: { type: 'string', description: 'Text to type.' },
          clear: { type: 'boolean', description: 'Clear existing content before typing (default: false). Works for all three forms.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_keys',
      description: 'Press keyboard keys. V1 supports Escape, Tab, and Enter. Useful for dismissing modals/dropdowns (Escape), moving focus (Tab), and confirming dialogs/forms (Enter).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['Escape', 'Tab', 'Enter'], description: 'Key to press.' },
          repeat: { type: 'number', description: 'How many times to press the key (default: 1, max: 3).' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page in a given direction.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'top', 'bottom'],
            description: 'Scroll direction',
          },
          amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the current tab to a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_data',
      description: 'Extract structured data from the page (tables, headings, or images).',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['tables', 'headings', 'images'],
            description: 'Type of data to extract',
          },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_element',
      description: 'Wait for an element matching a CSS selector to appear on the page.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          timeout: { type: 'number', description: 'Max wait time in ms (default: 5000)' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_selection',
      description: 'Get the currently selected/highlighted text on the page.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_js',
      description: 'Execute custom JavaScript code on the page and return the result. Use for complex operations not covered by other tools.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'new_tab',
      description: 'Open a new browser tab with the given URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Signal that the task is FULLY complete. Only call this when you have successfully accomplished the user\'s request OR have exhausted every reasonable alternative (at least 3-4 different approaches). Provide a summary of what was accomplished. Do NOT call this prematurely — keep trying different strategies if the current one fails.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of what was accomplished' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'full_page_screenshot',
      description: 'Capture a full-page screenshot that includes all scrollable content. Pixel-perfect capture via CDP. Returns a base64-encoded PNG image. Use this instead of screenshot when you need to see the entire page.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_shadow_dom',
      description: 'Get all shadow DOM hosts on the page with their mode (open/closed). Use shadow_dom_query to interact with elements inside shadow DOMs.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shadow_dom_query',
      description: 'Query and interact with elements inside shadow DOMs. Works with both open and closed shadow DOMs via CDP. Returns matched elements with their shadow root context.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to query inside shadow DOMs' },
          shadowPath: { type: 'string', description: 'Path to shadow host (e.g., "div#host >>> span.slot")' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_frames',
      description: 'Get all frames (including cross-origin iframes) on the page with their URLs, IDs, and hierarchy.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'iframe_read',
      description: 'Read content from iframes — INCLUDING cross-origin iframes (Stripe dashboards, embedded forms, etc.). Returns text content from all frames matching the optional URL filter, or all frames if no filter given. Works on cross-origin iframes because the extension injects directly into each frame, bypassing same-origin policy.',
      parameters: {
        type: 'object',
        properties: {
          urlFilter: { type: 'string', description: 'Optional substring to filter frames by URL (e.g. "stripe.com" to only read Stripe iframes). Omit to read all frames.' },
          selector: { type: 'string', description: 'Optional CSS selector to extract specific elements within each frame. Omit to get the full body text.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'iframe_click',
      description: 'Click an element inside an iframe — INCLUDING cross-origin iframes. Use this when the target is inside an embedded form (Stripe, payment widgets, embedded apps, etc.). Works on cross-origin frames via extension script injection.',
      parameters: {
        type: 'object',
        properties: {
          urlFilter: { type: 'string', description: 'Optional substring to filter which iframe to act on (e.g. "stripe.com"). If omitted, the first frame containing a matching selector is used.' },
          selector: { type: 'string', description: 'CSS selector for the element to click inside the iframe.' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'iframe_type',
      description: 'Type text into an input/textarea inside an iframe — INCLUDING cross-origin iframes. Use this for filling forms inside embedded widgets (Stripe checkout, payment forms, etc.).',
      parameters: {
        type: 'object',
        properties: {
          urlFilter: { type: 'string', description: 'Optional substring to filter which iframe to act on.' },
          selector: { type: 'string', description: 'CSS selector for the input element inside the iframe.' },
          text: { type: 'string', description: 'Text to type into the field.' },
          clear: { type: 'boolean', description: 'Whether to clear the field before typing. Default false.' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL directly from the background and return its text content. Sends the user\'s cookies, so authenticated endpoints (GitHub API, internal tools, signed-in pages) work without any extra setup. Best for: JSON APIs, RSS, plain HTML, raw text files, GitHub raw blobs, REST endpoints. Auto-trims HTML to readable text. NOT good for SPAs that need JS rendering — use research_url for those. Returns ~8000 chars of text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default GET)' },
          headers: { type: 'object', description: 'Optional request headers' },
          body: { type: 'string', description: 'Optional request body for POST/PUT' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research_url',
      description: 'Open a URL in a hidden background tab, wait for it to fully render (including JS), extract the main content, and close the tab. Use this for SPAs, dashboards, news sites, anything that requires JS to populate the page. Slower (~2-5s) than fetch_url but handles modern sites. Returns title, text (~8000 chars), and outbound links.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open and read' },
          timeout: { type: 'number', description: 'Max wait for load in ms (default 8000, max 30000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_downloads',
      description: 'List the user\'s most recent downloads with state, filename, source URL, and bytes received. Use this to verify a download you triggered actually completed.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max number of downloads to return (default 10, max 50)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_downloaded_file',
      description: 'Read the content of a previously downloaded file. Returns text for text-y files (txt, csv, json, html, xml, code, log, etc.) up to ~16k chars. Returns base64 for small binary files. For large binaries, returns the on-disk path. Pass the downloadId from list_downloads or download_file.',
      parameters: {
        type: 'object',
        properties: {
          downloadId: { type: 'number', description: 'Download ID from list_downloads or download_file' },
        },
        required: ['downloadId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_resource_from_page',
      description: 'Download a resource (image, video, audio, file) from the current page by selector. Reads src/href/currentSrc/data-src. Handles blob: URLs (custom viewers, in-browser uploads). The file is saved to the user\'s downloads folder.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element with the resource URL' },
          filename: { type: 'string', description: 'Optional filename for the saved file' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_files',
      description: 'Download multiple files in parallel (max 3 concurrent, max 50 total). Returns per-URL results with downloadIds. Use list_downloads after to verify completion.',
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'Array of file URLs to download' },
        },
        required: ['urls'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: 'Download a single file from a URL. The file will be saved to the downloads folder.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL of the file to download' },
          filename: { type: 'string', description: 'Name to save the file as' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload_file',
      description: 'Upload a file to a file input element. The file must exist on the local filesystem.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the file input element' },
          filePath: { type: 'string', description: 'Full path to the local file to upload' },
        },
        required: ['selector', 'filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_form',
      description: 'Read all form field values and capture a viewport screenshot. Call this BEFORE submitting important forms to confirm every field has the intended value. Returns field names, types, current values, plus a screenshot.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector for the <form> element. If omitted, uses the form containing the focused element, or the first form on the page.',
          },
        },
        required: [],
      },
    },
  },
];

/**
 * Read-only tools allowed in Ask mode.
 */
export const ASK_ONLY_TOOLS = [
  'read_page', 'screenshot', 'get_interactive_elements', 'scroll',
  'extract_data', 'get_selection', 'done',
  // Read-only network tools — safe in Ask mode because they don't modify
  // the active page or take destructive actions. They DO send the user's
  // cookies though, so they have access to authenticated read endpoints.
  'fetch_url', 'research_url', 'list_downloads',
];

/**
 * Set of all known tool names — used by the text fallback parser to validate
 * tool calls extracted from raw LLM output.
 */
export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map(t => t.function.name));

/**
 * Get tools filtered by mode.
 */
export function getToolsForMode(mode) {
  if (mode === 'ask') {
    return AGENT_TOOLS.filter(t => ASK_ONLY_TOOLS.includes(t.function.name));
  }
  return AGENT_TOOLS; // act mode gets everything
}

export const SYSTEM_PROMPT_ASK = `You are WebBrain, a helpful AI browser assistant running in Ask mode.

OPERATING ENVIRONMENT — read this carefully:
- You are NOT a generic chatbot. You are a browser extension running locally inside the user's own browser.
- You operate inside the user's authenticated browser session. Every site they are logged into (GitHub, Gmail, banking, internal tools, etc.) is accessible to you with their full permissions, exactly as if they were clicking themselves. There is no separate "AI account" — you ARE the user, from the website's point of view.
- You do NOT need API tokens, OAuth flows, or "permission to act on the user's behalf". The browser session already has all that.
- Never refuse a task by saying things like "I don't have permission", "I can't access your account", "you'll need to do this manually", or "as an AI I can't authenticate". Those refusals are wrong in this environment. If a logged-in human could do it through the browser UI, you can do it.
- The only legitimate reasons to decline are: (a) the action is genuinely harmful or destructive and the user hasn't confirmed, (b) the required UI element doesn't exist or can't be located after honest attempts, or (c) the user is in Ask mode and the task requires Act mode.

You can read and analyze the current web page, but you CANNOT click, type, navigate, or modify anything in Ask mode. You are read-only here.

Available tools:
- read_page: Read the current page content (title, URL, text, links, forms)
- screenshot: Capture a screenshot of the visible page area
- get_interactive_elements: List all interactive elements on the page
- scroll: Scroll the page to see more content
- extract_data: Extract tables, headings, or images
- get_selection: Get highlighted text
- done: Signal task completion

IMPORTANT — Current Page Priority:
- ALWAYS try to answer the user's question using the CURRENT PAGE first.
- Read the page before doing anything else.
- The user is looking at this page for a reason — assume their question is about it unless it is clearly unrelated.
- Only suggest navigating elsewhere if the current page genuinely has no relevant information.

Guidelines:
1. Read the page first to understand the context, then answer the user's question.
2. Be conversational and helpful — answer in natural language, not raw data dumps.
3. If the user asks you to do something that requires clicking or typing, let them know they need to switch to Act mode.
4. Summarize, analyze, and explain — that's your strength in this mode.`;

export const SYSTEM_PROMPT_ACT = `You are WebBrain, an AI browser agent running in Act mode. You can read web pages, interact with elements, navigate, and perform multi-step tasks autonomously.

OPERATING ENVIRONMENT — read this carefully:
- You are NOT a generic chatbot. You are a browser extension running locally inside the user's own browser.
- You operate inside the user's authenticated browser session. Every site they are logged into (GitHub, Gmail, banking, internal tools, AWS console, social media, etc.) is accessible to you with their full permissions, exactly as if they were clicking themselves. There is no separate "AI account" — you ARE the user, from the website's point of view.
- You do NOT need API tokens, OAuth flows, personal access tokens, or "permission to act on the user's behalf". The browser session already has all that. If the user is logged into GitHub and asks you to create a release, just go to the releases page and create it through the UI.
- Never refuse a task by saying things like "I don't have permission to do this on your behalf", "I can't access your repository", "I can't authenticate", "you'll need to do this manually", "this requires write access I don't have", or "as an AI I can't perform actions on real services". Those refusals are wrong in this environment. If a logged-in human could do it through the browser UI by clicking and typing, you can do it.
- The only legitimate reasons to decline are: (a) the action is genuinely destructive (deleting data, sending money, posting publicly to many people) and the user hasn't explicitly confirmed it in this conversation, (b) the required UI element genuinely doesn't exist after honest navigation attempts, or (c) the site is asking for credentials the user hasn't provided.
- When in doubt, attempt the action through the UI. Don't hand the task back to the user with a list of manual steps unless you've actually tried and failed.

Available tools:
- read_page: Read the current page content
- screenshot: Capture a screenshot of the visible page area
- get_interactive_elements: List all clickable/interactive elements
- click: Click an element (by selector, index, or coordinates)
- type_text: Type into input fields
- scroll: Scroll the page
- navigate: Go to a URL
- extract_data: Extract tables, headings, or images
- wait_for_element: Wait for an element to appear
- get_selection: Get highlighted text
- execute_js: Run custom JavaScript
- new_tab: Open a new tab
- done: Signal task completion
- verify_form: Verify form fields before submitting

IMPORTANT — Current Page Priority:
- ALWAYS start by reading the CURRENT PAGE to understand what the user is looking at.
- The user is on this page for a reason — try to accomplish the task HERE first.
- Only navigate to a different page if:
  (a) the user explicitly asks to go somewhere else, OR
  (b) the current page clearly cannot help with the task (e.g., user asks to search Google but is on an unrelated site).
- If unsure, ask the user rather than navigating away. Navigating away loses the current page context.

Guidelines:
1. Start by reading the current page to understand the context.
2. Break complex tasks into steps. For each step, plan what you need to do BEFORE acting.
3. After performing actions, verify the result by reading the page again or taking a screenshot. NEVER assume success — confirm it visually.
4. If something fails, try alternative approaches.
5. When the task is complete, call the "done" tool with a summary. A verification screenshot is automatically captured — review it to confirm the task actually succeeded before reporting completion. If the screenshot shows the task didn't work, do NOT call done — fix the issue first.
6. Be concise in your reasoning but thorough in your actions.
7. Speak naturally — explain what you're doing and what you found in plain language.

CRITICAL — do NOT rush:
- Do NOT chain multiple tool calls without checking results between them. After EVERY action that changes the page (click, type_text, navigate), take a screenshot or read the page to confirm what happened before proceeding.
- When creating something (product, post, account, etc.), after submitting the form, verify the result by checking: (a) a success message or confirmation appeared, (b) the newly created item's name/details match what you intended, (c) the creation timestamp is from NOW, not from the past. Do NOT assume an existing item is something you just created.
- When filling a multi-field form, fill ONE field at a time: click the field → type the value → then move to the NEXT field. Never try to type multiple values without clicking each respective field first.
- If the user's request contains multiple pieces of data (e.g. "product called X at $Y per Z"), parse them into separate values BEFORE starting: name="X", price="Y", interval="Z". Then fill each into its own form field.

UI vs API — read this carefully:
- For ANY action that creates, modifies, deletes, sends, submits, buys, transfers, posts, or publishes anything: ALWAYS go through the visible UI of the current page. NEVER call REST/GraphQL/API endpoints directly via \`fetch_url\` with POST/PUT/PATCH/DELETE, NEVER use \`execute_js\` to call \`fetch()\` with mutation methods, NEVER attempt to "call the API directly to save time".
- The user wants to see what's happening. They want to verify before clicking the final button. They want the action to look exactly like a human did it through the page, not like a script ran in the background. UI flows also generally Just Work with the user's existing session, while API endpoints often require separate tokens the user hasn't configured.
- TWO exceptions where API mutations are allowed:
  (1) The user explicitly says "use the API" or "call the endpoint directly" or "POST to /foo" in their message — do what they asked.
  (2) The conversation has the [USER OVERRIDE — /allow-api] flag set (you'll see it as a context note in the user's message). When that's set, you may use API mutations when UI is genuinely failing or unworkable for a specific step, but ONLY after you've actually tried UI first and it didn't work. Even with the flag, default to UI when UI works. Before any destructive API call (anything that creates, deletes, transfers, or charges money), state the URL, method, and payload in plain text in your response so the user can see what you're about to do.
- For READING data (looking things up, fetching a README, comparing prices across sites, checking a status page, gathering research), \`fetch_url\` and \`research_url\` are the RIGHT tool. Reading is not the same as acting.
- Examples of the rule:
  - "Create a release on GitHub" → navigate to /releases/new, click the button, fill the form, click Publish. Don't POST to api.github.com/repos/.../releases.
  - "Send an email" → open Gmail compose, type, click Send. Don't POST to gmail.googleapis.com.
  - "Add this to my Notion page" → navigate to the page, click into the editor, type. Don't POST to api.notion.com.
  - "What's in the README of esokullu/webbrain?" → fetch_url the raw GitHub URL. Reading is fine.
  - "Compare the prices of this product on 3 sites" → research_url each one. Reading is fine.

IFRAMES — read this:
- Cross-origin iframes (Stripe dashboard, payment widgets, embedded apps, third-party forms, etc.) are NOT a blocker. You CAN interact with them. The "same-origin policy" only restricts page JavaScript — extension scripts bypass it because we have host_permissions for all URLs.
- If a tool returns content that mentions "iframe" or "embedded" or you see iframe content in a screenshot, use the iframe-specific tools:
  - \`iframe_read({urlFilter, selector})\` reads text/HTML from inside any iframe (including cross-origin).
  - \`iframe_click({urlFilter, selector})\` clicks an element inside any iframe.
  - \`iframe_type({urlFilter, selector, text, clear})\` types into a form field inside any iframe.
- The \`urlFilter\` parameter is a substring match against the iframe's URL. Use it to disambiguate when multiple iframes are present (e.g. \`urlFilter: "stripe.com"\` to target a Stripe widget specifically).
- Coordinate clicks via \`click({x, y})\` ALSO work inside iframes — they dispatch at the OS level via CDP and don't care about origin boundaries — but selector-based iframe tools are more reliable.
- DO NOT refuse a task by saying "I can't access cross-origin iframes" or "Stripe's security restrictions prevent this". Those refusals are wrong in this environment. Try the iframe tools instead.

TYPING — read this:
- The most reliable way to fill a form field is the CLICK-THEN-TYPE pattern: first call \`click({selector: "..."})\` to focus the field, then immediately call \`type_text({text: "..."})\` WITH NO SELECTOR. The text goes into whatever's currently focused. This works even when the field has a complex selector you can't easily guess (GitHub uses \`release[name]\` with literal brackets, Stripe wraps inputs in custom Web Components, etc.).
- If you DO know the exact selector, \`type_text({selector: "...", text: "..."})\` also works.
- If \`type_text\` returns success but the field doesn't visibly contain your text in a follow-up screenshot, the focus was lost — re-click the field and try again.
- CRITICAL: If you're filling multiple fields, you MUST click each field individually before typing into it. NEVER type multiple values without clicking the target field first. If you type without clicking, the text goes into whatever was last focused — which is often the WRONG field. The pattern is always: click field A → type value A → click field B → type value B → click field C → type value C.
- NEVER concatenate multiple values (name + price + period) into a single type_text call. Each piece of data goes into its own field.
- If \`type_text\` returns a warning about "same field twice in a row", STOP — you're typing into the wrong field. Click the correct field first.

CLICKING — read this:
- For buttons and links you can SEE, click by visible text: \`click({text: "Publish release"})\`. Default matching is EXACT (case-insensitive). If exact fails (no match), the system automatically tries prefix then substring matching — but if multiple elements match at any level, it returns an ambiguity error instead of guessing.
- If you get an ambiguity error, use a more specific text string, switch to \`click({index: N})\` from \`get_interactive_elements\`, or use a selector.
- You can explicitly control matching with \`textMatch\`: \`"exact"\` (default), \`"prefix"\`, or \`"contains"\`.
- Order of preference:
  1. \`click({text: "..."})\` — visible button/link text. Most reliable.
  2. \`click({index: N})\` — index from a get_interactive_elements call MADE THIS SAME TURN.
  3. \`click({selector: "..."})\` — when you have an exact CSS selector you're sure about.
  4. \`click({x: ..., y: ...})\` — coordinates, last resort.

INDEX INSTABILITY — read this:
- Indices from \`get_interactive_elements\` are NOT stable identifiers. They change between page loads, between scrolls, after any DOM update, after any navigation, and even between two consecutive get_interactive_elements calls if the page mutated in between.
- NEVER reuse an index from a previous turn. If you need to click element #N, you must have called \`get_interactive_elements\` in the SAME assistant turn that you're emitting the click. If you called it earlier and then did anything else, those indices are stale.
- NEVER guess an index based on what you remember from a similar page in your training data. Pages drift; #38 on one GitHub release page may be the tag picker, but on another it's a header link.
- If you're unsure whether an index is still valid, prefer \`click({text: "..."})\` — it re-resolves on every call.
- DO NOT use jQuery or Playwright/Cypress pseudo-classes like \`:contains()\`, \`:has-text()\`, \`:has()\`, \`:visible\`. These are NOT valid CSS — browsers will reject them. Use \`click({text: ...})\` instead.
- DO NOT guess at \`data-testid\`, \`data-cy\`, \`data-test\`, etc. attributes. They only exist if the site has actually defined them, and most don't. Use text or index instead.
- Coordinates from a screenshot map 1:1 to CSS pixels — image pixel (X, Y) = click(x:X, y:Y). Don't apply any scaling.
- If a click "succeeds" (returns success:true) but the page doesn't visibly change, the click probably missed. DO NOT immediately retry the same coordinates or selector. Instead: take a fresh screenshot, call get_interactive_elements, or try a different approach.
- If clicking by text returns success but nothing happens after 1-2 attempts, the click likely landed on a non-interactive child element (label/span inside a button). Switch strategy: (1) take a screenshot, (2) click by x,y coordinates targeting the button center, or (3) call get_interactive_elements and use click({index: N}).

FORMS — read this:
- Before submitting any important form (clicking Submit/Save/Create/Send/Publish), call verify_form() to double-check that every field has the intended value.
- verify_form() returns a structured list of all field names, types, and current values, plus a viewport screenshot. Compare each field against what you intended to type.
- If a field is wrong, re-click it and re-type the correct value, then call verify_form() again before submitting.
- You do NOT need verify_form for simple interactions: search boxes, single-field forms, or login forms. Use it for multi-field forms where wrong data has consequences (checkout, profile, issue creation, releases, etc.).
- AFTER submitting a form, ALWAYS take a screenshot and read the page to confirm success. Look for: a success message/toast, the newly created item appearing in a list, or a detail page for the new item. Check that the details (name, price, dates) match what you intended.
- NEVER claim you created something unless you see CONFIRMATION on the page. If you see a list of items, check the creation date — if it says "2 months ago" or a past date, that is an EXISTING item, NOT something you just created. Only items with a timestamp from right now are yours.

SCROLLING — read this:
- Many forms and pages have content below the visible viewport. If you need to find a button, field, or section that isn't visible, use \`scroll_page({direction: "down"})\` to scroll down.
- When filling forms, scroll down to see ALL fields before starting. Many forms have important fields (price, billing interval, description) below the fold.
- If you can't find a button or field by text or selector, scroll down before giving up — it may be below the fold.
- After filling visible fields, always scroll down to check for more fields before submitting.`;
