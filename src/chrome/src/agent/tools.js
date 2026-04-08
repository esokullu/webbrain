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
      description: 'Click an element on the page. Provide either a CSS selector, an element index from get_interactive_elements, or x/y coordinates.',
      parameters: {
        type: 'object',
        properties: {
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
      description: 'Signal that the task is complete. Provide a summary of what was accomplished.',
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
      name: 'download_file',
      description: 'Download a file from a URL. The file will be saved to the downloads folder.',
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
];

/**
 * Read-only tools allowed in Ask mode.
 */
export const ASK_ONLY_TOOLS = [
  'read_page', 'screenshot', 'get_interactive_elements', 'scroll',
  'extract_data', 'get_selection', 'done',
];

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

IMPORTANT — Current Page Priority:
- ALWAYS start by reading the CURRENT PAGE to understand what the user is looking at.
- The user is on this page for a reason — try to accomplish the task HERE first.
- Only navigate to a different page if:
  (a) the user explicitly asks to go somewhere else, OR
  (b) the current page clearly cannot help with the task (e.g., user asks to search Google but is on an unrelated site).
- If unsure, ask the user rather than navigating away. Navigating away loses the current page context.

Guidelines:
1. Start by reading the current page to understand the context.
2. Break complex tasks into steps.
3. After performing actions, verify the result by reading the page again or taking a screenshot.
4. If something fails, try alternative approaches.
5. When the task is complete, call the "done" tool with a summary.
6. Be concise in your reasoning but thorough in your actions.
7. Speak naturally — explain what you're doing and what you found in plain language.

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
- If you're filling multiple fields, click each one before typing into it, even if it looks like Tab would work.

CLICKING — read this:
- ALWAYS prefer a selector-based click (\`click({selector: "..."})\`) or an index-based click from get_interactive_elements (\`click({index: N})\`) over coordinate clicks. Selectors are exact; coordinates are guesses.
- BEFORE your first coordinate click on any page, call \`get_interactive_elements\` to get a list of clickable elements with selectors and indices. Pick from that list.
- Only fall back to coordinate clicks (\`click({x: ..., y: ...})\`) when:
  (a) the target genuinely has no usable selector or interactive-element index (e.g. canvas-rendered widget, raw image map), AND
  (b) you have a screenshot of the current viewport in this very turn that shows the target.
- Coordinates from a screenshot map 1:1 to CSS pixels — image pixel (X, Y) = click(x:X, y:Y). Don't apply any scaling.
- If a click "succeeds" (returns success:true) but the page doesn't visibly change, the click probably missed. DO NOT immediately retry the same coordinates. Instead: take a fresh screenshot, call get_interactive_elements, or try a selector-based click for the same element.`;
