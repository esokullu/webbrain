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
      description: 'Type text into an input field or textarea. Provide either a CSS selector or element index.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the input element' },
          index: { type: 'number', description: 'Index of the input element' },
          text: { type: 'string', description: 'Text to type into the element' },
          clear: { type: 'boolean', description: 'Clear existing content before typing (default: false)' },
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
      name: 'get_shadow_dom',
      description: 'Get all shadow DOM hosts on the page (Chrome-only: use content script for Firefox).',
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
      name: 'get_frames',
      description: 'Get all iframes on the page with their URLs.',
      parameters: {
        type: 'object',
        properties: {},
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
7. Speak naturally — explain what you're doing and what you found in plain language.`;
