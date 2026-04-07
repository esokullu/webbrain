/**
 * WebBrain Side Panel — Chat UI logic.
 * Default: human-friendly compact output. Verbose mode: full tool debug.
 */

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('user-input');
const sendBtn = document.getElementById('btn-send');
const clearBtn = document.getElementById('btn-clear');
const settingsBtn = document.getElementById('btn-settings');
const providerSelect = document.getElementById('provider-select');
const statusDot = document.getElementById('status-dot');
const agentActivity = document.getElementById('agent-activity');
const activityText = document.getElementById('activity-text');
const modeAskBtn = document.getElementById('btn-mode-ask');
const modeActBtn = document.getElementById('btn-mode-act');
const actWarning = document.getElementById('act-warning');
const inputArea = document.getElementById('input-area');
const stopBtn = document.getElementById('btn-stop');

let currentTabId = null;
let isProcessing = false;
let currentAssistantEl = null;
let verboseMode = false;
let agentMode = 'ask'; // 'ask' or 'act'
let abortRequested = false;

// Per-tab chat history (stores innerHTML of messages container).
// Also mirrored to chrome.storage.session keyed `tabChat:<tabId>` so the
// conversation survives the side panel being closed and reopened.
const tabChats = new Map();
const TAB_CHAT_PREFIX = 'tabChat:';

async function loadTabChat(tabId) {
  if (tabChats.has(tabId)) return tabChats.get(tabId);
  try {
    const key = TAB_CHAT_PREFIX + tabId;
    const stored = await chrome.storage.session.get(key);
    const html = stored?.[key];
    if (typeof html === 'string') {
      tabChats.set(tabId, html);
      return html;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function persistTabChat(tabId, html) {
  if (tabId == null) return;
  tabChats.set(tabId, html);
  try {
    chrome.storage.session.set({ [TAB_CHAT_PREFIX + tabId]: html }).catch(() => {});
  } catch (e) { /* ignore */ }
}

// Save current tab's chat to storage on a debounced cadence — we don't want
// to thrash storage on every keystroke / streamed token.
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (currentTabId != null) persistTabChat(currentTabId, messagesEl.innerHTML);
  }, 400);
}

// Observe the messages container so any DOM mutation (new message, streamed
// delta, tool step update) eventually gets persisted.
const persistObserver = new MutationObserver(schedulePersist);

// Human-friendly labels for tool names
const TOOL_LABELS = {
  read_page: 'Reading page',
  get_interactive_elements: 'Scanning interactive elements',
  click: 'Clicking',
  type_text: 'Typing',
  scroll: 'Scrolling',
  navigate: 'Navigating',
  extract_data: 'Extracting data',
  wait_for_element: 'Waiting for element',
  get_selection: 'Reading selection',
  execute_js: 'Running script',
  new_tab: 'Opening new tab',
  screenshot: 'Taking screenshot',
  done: 'Finishing up',
};

function friendlyToolLabel(name, args) {
  const base = TOOL_LABELS[name] || name;
  // Add context from args where it makes sense
  if (name === 'click' && args?.selector) return `Clicking "${truncate(args.selector, 30)}"`;
  if (name === 'click' && args?.index != null) return `Clicking element #${args.index}`;
  if (name === 'type_text' && args?.text) return `Typing "${truncate(args.text, 25)}"`;
  if (name === 'navigate' && args?.url) return `Going to ${truncate(args.url, 35)}`;
  if (name === 'new_tab' && args?.url) return `Opening ${truncate(args.url, 35)}`;
  if (name === 'scroll') return `Scrolling ${args?.direction || 'down'}`;
  if (name === 'extract_data') return `Extracting ${args?.type || 'data'}`;
  if (name === 'wait_for_element' && args?.selector) return `Waiting for "${truncate(args.selector, 30)}"`;
  return base;
}


// --- Initialization ---

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  // Load verbose setting
  const stored = await chrome.storage.local.get('verboseMode');
  verboseMode = stored.verboseMode || false;

  // Restore prior conversation for this tab (if any) — survives close/reopen.
  if (currentTabId != null) {
    const html = await loadTabChat(currentTabId);
    if (html) {
      messagesEl.innerHTML = html;
      rebindCopyButtons();
      scrollToBottom();
    }
  }

  // Start observing the messages container for changes to persist.
  persistObserver.observe(messagesEl, { childList: true, subtree: true, characterData: true });

  await loadProviders();
  await testConnection();

  chrome.tabs.onActivated.addListener(async (info) => {
    switchToTab(info.tabId);
  });

  // Also handle window focus changes
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && tab.id !== currentTabId) {
      switchToTab(tab.id);
    }
  });

  // Listen for setting changes (from options page)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.verboseMode) {
      verboseMode = changes.verboseMode.newValue;
    }
  });
}

async function switchToTab(newTabId) {
  if (newTabId === currentTabId) return;
  if (isProcessing) return; // don't switch while agent is running

  // Save current tab's chat (in-memory + storage).
  if (currentTabId != null) {
    persistTabChat(currentTabId, messagesEl.innerHTML);
  }

  currentTabId = newTabId;

  // Restore new tab's chat from memory or storage.
  const html = await loadTabChat(newTabId);
  if (html) {
    messagesEl.innerHTML = html;
    rebindCopyButtons();
  } else {
    messagesEl.innerHTML = '';
    addMessage('system', 'How can I help with this page?');
  }
  scrollToBottom();
}

// After restoring innerHTML the copy buttons need their click handlers re-bound,
// since serialized HTML loses listeners.
function rebindCopyButtons() {
  document.querySelectorAll('.msg-copy-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', () => {
      const content = btn.closest('.message-content');
      const textEl = content?.querySelector('.message-text');
      if (textEl) {
        navigator.clipboard.writeText(textEl.innerText).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
        });
      }
    });
  });
  document.querySelectorAll('.code-copy-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrapper = btn.closest('.code-block-wrapper');
      const codeEl = wrapper?.querySelector('pre code');
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
        });
      }
    });
  });
}

async function loadProviders() {
  try {
    const res = await sendToBackground('get_providers');
    providerSelect.innerHTML = '';
    for (const [id, config] of Object.entries(res.providers)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = config.label || id;
      if (id === res.active) opt.selected = true;
      providerSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load providers:', e);
  }
}

async function testConnection() {
  statusDot.className = 'status-dot connecting';
  try {
    const res = await sendToBackground('test_provider', {
      providerId: providerSelect.value,
    });
    statusDot.className = `status-dot ${res.ok ? 'online' : 'offline'}`;
    statusDot.title = res.ok ? `Connected (${res.model || providerSelect.value})` : `Error: ${res.error}`;
  } catch {
    statusDot.className = 'status-dot offline';
    statusDot.title = 'Connection failed';
  }
}

// --- Message Sending ---

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isProcessing) return;

  isProcessing = true;
  abortRequested = false;
  sendBtn.disabled = true;
  inputEl.value = '';
  autoResizeInput();

  addMessage('user', text);
  showActivity('Thinking...');

  currentAssistantEl = addMessage('assistant', '');

  try {
    const res = await sendToBackground('chat', {
      tabId: currentTabId,
      text,
      mode: agentMode,
    });

    if (abortRequested) {
      // Agent was stopped — show what we got so far
      const textEl = currentAssistantEl?.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        textEl.innerHTML = formatMarkdown(res?.content || '[Stopped by user]');
        addMessageCopyButton(currentAssistantEl);
      }
    } else if (res.content && currentAssistantEl) {
      const textEl = currentAssistantEl.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        textEl.innerHTML = formatMarkdown(res.content);
        addMessageCopyButton(currentAssistantEl);
      }
    }
  } catch (e) {
    if (!abortRequested) {
      addMessage('error', `Error: ${e.message}`);
    }
  } finally {
    finalizeSteps();
    isProcessing = false;
    abortRequested = false;
    sendBtn.disabled = false;
    hideActivity();
    currentAssistantEl = null;
    scrollToBottom();
  }
}

// --- Listen for Agent Updates ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'sidepanel' || msg.action !== 'agent_update') return;

  const { type, data } = msg;

  switch (type) {
    case 'thinking':
      showActivity(`Thinking (step ${data.step})...`);
      break;

    case 'text':
      if (currentAssistantEl) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl) {
          textEl.innerHTML = formatMarkdown(data.content);
          // Add copy button if not already present
          if (!currentAssistantEl.querySelector('.msg-copy-btn')) {
            addMessageCopyButton(currentAssistantEl);
          }
        }
      }
      break;

    case 'text_delta':
      if (currentAssistantEl) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl) textEl.textContent += data.content;
      }
      scrollToBottom();
      break;

    case 'tool_call':
      showActivity(friendlyToolLabel(data.name, data.args));
      showInspectionBanner(data.name);
      if (currentAssistantEl) {
        if (verboseMode) {
          appendVerboseToolCall(data.name, data.args);
        } else {
          appendCompactStep(data.name, data.args);
        }
      }
      scrollToBottom();
      break;

    case 'tool_result':
      if (currentAssistantEl) {
        if (verboseMode) {
          appendVerboseToolResult(data.name, data.result);
        } else {
          markLastStepDone(data.name, data.result);
        }
      }
      scrollToBottom();
      break;

    case 'error':
      hideActivity();
      if (currentAssistantEl) markLastStepFailed();
      addMessage('error', `Error: ${data.message}`);
      break;

    case 'max_steps_reached':
      hideActivity();
      if (currentAssistantEl) {
        showContinueButton();
      }
      break;

    case 'warning':
      hideActivity();
      break;
  }
});


// ==========================================================================
// COMPACT MODE (default) — shows tool steps as a tidy activity log
// ==========================================================================

function getOrCreateStepsContainer() {
  if (!currentAssistantEl) return null;
  const content = currentAssistantEl.querySelector('.message-content');
  let container = content.querySelector('.steps-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'steps-container';
    // Insert before the text element
    const textEl = content.querySelector('.message-text');
    content.insertBefore(container, textEl);
  }
  return container;
}

function appendCompactStep(toolName, args) {
  const container = getOrCreateStepsContainer();
  if (!container) return;

  // Mark previous active step as done if still spinning
  const prev = container.querySelector('.step-item.active');
  if (prev) {
    prev.classList.remove('active');
    prev.classList.add('done');
    const icon = prev.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon check'; icon.textContent = '\u2713'; }
  }

  const step = document.createElement('div');
  step.className = 'step-item active';
  step.dataset.tool = toolName;

  const icon = document.createElement('span');
  icon.className = 'step-icon spinning';
  icon.textContent = '';

  const label = document.createElement('span');
  label.className = 'step-label';
  label.textContent = friendlyToolLabel(toolName, args);

  // Small toggle to peek at details
  const toggle = document.createElement('button');
  toggle.className = 'step-details-toggle';
  toggle.textContent = 'details';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const details = step.nextElementSibling;
    if (details && details.classList.contains('step-details')) {
      details.classList.toggle('open');
    }
  });

  step.appendChild(icon);
  step.appendChild(label);
  step.appendChild(toggle);
  container.appendChild(step);

  // Hidden details panel (populated when result arrives)
  const details = document.createElement('div');
  details.className = 'step-details';
  details.innerHTML = `<div class="detail-label">Input</div><div class="detail-args">${escapeHtml(JSON.stringify(args, null, 2))}</div>`;
  container.appendChild(details);
}

function markLastStepDone(toolName, result) {
  const container = getOrCreateStepsContainer();
  if (!container) return;

  const active = container.querySelector('.step-item.active');
  if (active) {
    active.classList.remove('active');
    active.classList.add('done');
    const icon = active.querySelector('.step-icon');
    if (icon) {
      const success = !result?.error;
      icon.className = success ? 'step-icon check' : 'step-icon fail';
      icon.textContent = success ? '\u2713' : '\u2717';
    }

    // Append result to the details panel
    const details = active.nextElementSibling;
    if (details && details.classList.contains('step-details')) {
      const resultDiv = document.createElement('div');
      resultDiv.className = 'detail-result';
      resultDiv.innerHTML = `<div class="detail-label">Result</div>${escapeHtml(truncate(JSON.stringify(result), 300))}`;
      details.appendChild(resultDiv);
    }
  }
}

function markLastStepFailed() {
  const container = getOrCreateStepsContainer();
  if (!container) return;
  const active = container.querySelector('.step-item.active');
  if (active) {
    active.classList.remove('active');
    active.classList.add('done');
    const icon = active.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon fail'; icon.textContent = '\u2717'; }
  }
}

function finalizeSteps() {
  if (!currentAssistantEl) return;
  const actives = currentAssistantEl.querySelectorAll('.step-item.active');
  actives.forEach(step => {
    step.classList.remove('active');
    step.classList.add('done');
    const icon = step.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon check'; icon.textContent = '\u2713'; }
  });
}


// ==========================================================================
// VERBOSE MODE (opt-in) — full tool call + result blocks
// ==========================================================================

function appendVerboseToolCall(name, args) {
  if (!currentAssistantEl) return;
  const content = currentAssistantEl.querySelector('.message-content');

  const el = document.createElement('div');
  el.className = 'tool-call';

  const header = document.createElement('div');
  header.className = 'tool-call-header';
  header.innerHTML = `<span class="icon">\u26A1</span> ${name}`;

  const body = document.createElement('div');
  body.className = 'tool-call-body';
  body.textContent = JSON.stringify(args, null, 2);

  el.appendChild(header);
  el.appendChild(body);

  const textEl = content.querySelector('.message-text');
  content.insertBefore(el, textEl);
}

function appendVerboseToolResult(name, result) {
  if (!currentAssistantEl) return;
  const content = currentAssistantEl.querySelector('.message-content');
  const lastTool = content.querySelector('.tool-call:last-of-type');
  if (lastTool) {
    const resultEl = document.createElement('div');
    resultEl.className = 'tool-result';
    resultEl.textContent = truncate(JSON.stringify(result), 200);
    lastTool.appendChild(resultEl);
  }
}


// ==========================================================================
// UI Helpers
// ==========================================================================

function addMessage(role, content) {
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}`;

  const contentEl = document.createElement('div');
  contentEl.className = 'message-content';

  const textEl = document.createElement('div');
  textEl.className = 'message-text';
  if (role === 'user') {
    textEl.textContent = content;
  } else {
    textEl.innerHTML = content ? formatMarkdown(content) : '';
  }

  contentEl.appendChild(textEl);
  msgEl.appendChild(contentEl);
  messagesEl.appendChild(msgEl);

  // Add copy button to assistant messages
  if (role === 'assistant' && content) {
    addMessageCopyButton(msgEl);
  }

  scrollToBottom();

  return msgEl;
}

function showContinueButton() {
  // Remove any existing continue button
  document.querySelectorAll('.continue-bar').forEach(el => el.remove());

  const bar = document.createElement('div');
  bar.className = 'continue-bar';
  bar.innerHTML = `
    <span class="continue-text">Reached the step limit (${agent_maxSteps || 60} steps). Want me to keep going?</span>
    <button class="continue-btn" id="btn-continue">Continue</button>
  `;
  messagesEl.appendChild(bar);
  scrollToBottom();

  document.getElementById('btn-continue').addEventListener('click', continueAgent);
}

async function continueAgent() {
  // Remove the continue bar
  document.querySelectorAll('.continue-bar').forEach(el => el.remove());

  isProcessing = true;
  abortRequested = false;
  sendBtn.disabled = true;

  currentAssistantEl = addMessage('assistant', '');
  showActivity('Continuing...');

  try {
    const res = await sendToBackground('continue', {
      tabId: currentTabId,
      mode: agentMode,
    });

    if (res.content && currentAssistantEl) {
      const textEl = currentAssistantEl.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        textEl.innerHTML = formatMarkdown(res.content);
        addMessageCopyButton(currentAssistantEl);
      }
    }
  } catch (e) {
    if (!abortRequested) {
      addMessage('error', `Error: ${e.message}`);
    }
  } finally {
    finalizeSteps();
    isProcessing = false;
    abortRequested = false;
    sendBtn.disabled = false;
    hideActivity();
    currentAssistantEl = null;
    scrollToBottom();
  }
}

// Track max steps for display in continue bar
let agent_maxSteps = 60;
chrome.storage.local.get('maxAgentSteps').then(s => { agent_maxSteps = s.maxAgentSteps || 60; });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) agent_maxSteps = changes.maxAgentSteps.newValue;
});

// Page inspection banner — shown when agent starts interacting with the page
const PAGE_TOOLS = new Set(['read_page', 'get_interactive_elements', 'click', 'type_text', 'scroll', 'extract_data', 'wait_for_element', 'get_selection', 'execute_js', 'screenshot']);
let inspectionBannerShown = false;

function showInspectionBanner(toolName) {
  if (inspectionBannerShown || !PAGE_TOOLS.has(toolName)) return;
  inspectionBannerShown = true;

  const banner = document.getElementById('inspection-banner');
  if (banner) {
    banner.classList.remove('hidden');
  }

  // Set extension badge
  chrome.action?.setBadgeText?.({ text: '🔍' }).catch(() => {});
  chrome.action?.setBadgeBackgroundColor?.({ color: '#6c63ff' }).catch(() => {});
}

function hideInspectionBanner() {
  inspectionBannerShown = false;
  const banner = document.getElementById('inspection-banner');
  if (banner) {
    banner.classList.add('hidden');
  }
  chrome.action?.setBadgeText?.({ text: '' }).catch(() => {});
}

function showActivity(text) {
  agentActivity.classList.remove('hidden');
  activityText.textContent = text;
}

function hideActivity() {
  agentActivity.classList.add('hidden');
  hideInspectionBanner();
}

function scrollToBottom() {
  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}

function formatMarkdown(text) {
  if (!text) return '';

  // 1. Extract fenced code blocks BEFORE escaping HTML
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const id = `__CODEBLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: lang || '', code });
    return id;
  });

  // 2. Extract inline code before escaping
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const id = `__INLINE_${inlineCodes.length}__`;
    inlineCodes.push(code);
    return id;
  });

  // 3. Escape HTML in the remaining text
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 4. Inline formatting
  text = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/\n/g, '<br>');

  // 5. Restore inline code
  inlineCodes.forEach((code, i) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    text = text.replace(`__INLINE_${i}__`, `<code>${escaped}</code>`);
  });

  // 6. Restore fenced code blocks with copy button
  codeBlocks.forEach((block, i) => {
    const escaped = block.code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langLabel = block.lang ? `<span class="code-lang">${escapeHtml(block.lang)}</span>` : '';
    const copyBtn = `<button class="code-copy-btn" data-code-index="${i}" title="Copy code">Copy</button>`;
    const header = `<div class="code-block-header">${langLabel}${copyBtn}</div>`;
    text = text.replace(
      `__CODEBLOCK_${i}__`,
      `<div class="code-block-wrapper">${header}<pre><code>${escaped}</code></pre></div>`
    );
  });

  // Store raw code for copy buttons to use
  if (codeBlocks.length > 0) {
    setTimeout(() => {
      document.querySelectorAll('.code-copy-btn').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = 'true';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Get the code from the adjacent pre>code element
          const wrapper = btn.closest('.code-block-wrapper');
          const codeEl = wrapper?.querySelector('pre code');
          if (codeEl) {
            navigator.clipboard.writeText(codeEl.textContent).then(() => {
              btn.textContent = 'Copied!';
              btn.classList.add('copied');
              setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
            });
          }
        });
      });
    }, 0);
  }

  return text;
}

/** Adds a copy button to an entire assistant message (for non-code text) */
function addMessageCopyButton(msgEl) {
  if (!msgEl) return;
  const content = msgEl.querySelector('.message-content');
  if (!content) return;
  const btn = document.createElement('button');
  btn.className = 'msg-copy-btn';
  btn.textContent = 'Copy';
  btn.title = 'Copy message';
  btn.addEventListener('click', () => {
    const textEl = content.querySelector('.message-text');
    if (textEl) {
      navigator.clipboard.writeText(textEl.innerText).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    }
  });
  content.appendChild(btn);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function autoResizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

// --- Communication ---

function sendToBackground(action, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: 'background', action, ...data },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      }
    );
  });
}

// --- Mode Toggle ---

function setMode(mode) {
  agentMode = mode;

  if (mode === 'ask') {
    modeAskBtn.classList.add('active');
    modeAskBtn.classList.remove('act');
    modeActBtn.classList.remove('active', 'act');
    actWarning.classList.add('hidden');
    inputArea.classList.remove('act-mode');
    inputEl.placeholder = 'Ask anything about this page...';
  } else {
    modeActBtn.classList.add('active', 'act');
    modeAskBtn.classList.remove('active');
    actWarning.classList.remove('hidden');
    inputArea.classList.add('act-mode');
    inputEl.placeholder = 'Tell me what to do on this page...';
  }
}

modeAskBtn.addEventListener('click', () => setMode('ask'));

modeActBtn.addEventListener('click', () => {
  if (agentMode === 'act') return; // already active
  // Show a one-time confirmation if this is the first switch in the session
  if (!modeActBtn.dataset.confirmed) {
    const ok = confirm(
      'Act mode lets WebBrain click, type, scroll, and navigate on your behalf.\n\n' +
      'This can modify page content, submit forms, and trigger actions.\n' +
      'The developers are not responsible for any unintended consequences.\n\n' +
      'Continue?'
    );
    if (!ok) return;
    modeActBtn.dataset.confirmed = 'true';
  }
  setMode('act');
});


// --- Stop / Abort ---

stopBtn.addEventListener('click', async () => {
  if (!isProcessing) return;
  abortRequested = true;
  showActivity('Stopping...');

  try {
    await sendToBackground('abort', { tabId: currentTabId });
  } catch {
    // Best effort
  }

  // Force UI to settle even if background doesn't respond cleanly
  setTimeout(() => {
    if (abortRequested) {
      finalizeSteps();
      if (currentAssistantEl) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl && !textEl.textContent.trim()) {
          textEl.innerHTML = '<em>Stopped by user.</em>';
        }
      }
      isProcessing = false;
      sendBtn.disabled = false;
      hideActivity();
      currentAssistantEl = null;
      abortRequested = false;
    }
  }, 3000); // safety timeout if background takes too long
});


// --- Event Listeners ---

sendBtn.addEventListener('click', sendMessage);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener('input', autoResizeInput);

clearBtn.addEventListener('click', async () => {
  await sendToBackground('clear_conversation', { tabId: currentTabId });
  messagesEl.innerHTML = '';
  addMessage('system', 'Conversation cleared. How can I help?');
  if (currentTabId != null) {
    tabChats.delete(currentTabId);
    chrome.storage.session?.remove(TAB_CHAT_PREFIX + currentTabId).catch(() => {});
  }
});

providerSelect.addEventListener('change', async () => {
  await sendToBackground('set_active_provider', { providerId: providerSelect.value });
  await testConnection();
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Start ---
init();
