/**
 * WebBrain Settings Page — provider configuration + display settings.
 */

const providersContainer = document.getElementById('providers');
const verboseToggle = document.getElementById('toggle-verbose');
const screenshotToggle = document.getElementById('toggle-screenshot-fallback');
const maxStepsRange = document.getElementById('range-max-steps');
const stepsValueLabel = document.getElementById('steps-value');

let providersData = {};
let activeProviderId = '';

// --- Init ---

async function init() {
  // Load display settings
  const stored = await chrome.storage.local.get(['verboseMode', 'screenshotFallback', 'maxAgentSteps']);
  verboseToggle.checked = stored.verboseMode || false;
  screenshotToggle.checked = stored.screenshotFallback ?? true; // on by default
  maxStepsRange.value = stored.maxAgentSteps || 25;
  stepsValueLabel.textContent = maxStepsRange.value;

  // Load providers
  const res = await sendToBackground('get_providers');
  providersData = res.providers;
  activeProviderId = res.active;
  renderProviders();
}

// --- Display Settings ---

verboseToggle.addEventListener('change', () => {
  chrome.storage.local.set({ verboseMode: verboseToggle.checked });
});

screenshotToggle.addEventListener('change', () => {
  chrome.storage.local.set({ screenshotFallback: screenshotToggle.checked });
});

maxStepsRange.addEventListener('input', () => {
  stepsValueLabel.textContent = maxStepsRange.value;
});

maxStepsRange.addEventListener('change', () => {
  chrome.storage.local.set({ maxAgentSteps: parseInt(maxStepsRange.value) });
});

// --- Provider Rendering ---

function renderProviders() {
  providersContainer.innerHTML = '';

  const providerConfigs = {
    llamacpp: {
      fields: [
        { key: 'baseUrl', label: 'Server URL', type: 'text', placeholder: 'http://localhost:8080' },
        { key: 'model', label: 'Model', type: 'text', placeholder: 'qwen/qwen3.5-9b' },
      ],
    },
    openai: {
      fields: [
        { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', label: 'Model', type: 'text', placeholder: 'gpt-4o' },
        { key: 'baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      ],
    },
    openrouter: {
      fields: [
        { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-or-...' },
        { key: 'model', label: 'Model', type: 'text', placeholder: 'anthropic/claude-sonnet-4' },
        { key: 'baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://openrouter.ai/api/v1' },
      ],
    },
    anthropic: {
      fields: [
        { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-ant-...' },
        { key: 'model', label: 'Model', type: 'text', placeholder: 'claude-sonnet-4-20250514' },
        { key: 'baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.anthropic.com' },
      ],
    },
  };

  for (const [id, config] of Object.entries(providersData)) {
    const isActive = id === activeProviderId;
    const fieldDefs = providerConfigs[id]?.fields || [];

    const card = document.createElement('div');
    card.className = `provider-card ${isActive ? 'active' : ''}`;

    let fieldsHTML = '';
    for (const field of fieldDefs) {
      fieldsHTML += `
        <div class="field">
          <label>${field.label}</label>
          <input type="${field.type}" data-provider="${id}" data-key="${field.key}"
                 value="${config[field.key] || ''}" placeholder="${field.placeholder}">
        </div>
      `;
    }

    card.innerHTML = `
      <div class="provider-header">
        <div>
          <span class="provider-name">${config.label || id}</span>
          <span class="provider-type">${config.type}</span>
        </div>
        ${isActive ? '<span style="color:var(--accent);font-size:11px;font-weight:600">ACTIVE</span>' : ''}
      </div>
      ${fieldsHTML}
      <div class="btn-row">
        <button class="btn-primary btn-save" data-provider="${id}">Save</button>
        <button class="btn-secondary btn-test" data-provider="${id}">Test Connection</button>
        ${!isActive ? `<button class="btn-secondary btn-activate" data-provider="${id}">Set Active</button>` : ''}
      </div>
      <div class="test-result" id="test-${id}"></div>
    `;

    providersContainer.appendChild(card);
  }

  document.querySelectorAll('.btn-save').forEach(btn => {
    btn.addEventListener('click', () => saveProvider(btn.dataset.provider));
  });
  document.querySelectorAll('.btn-test').forEach(btn => {
    btn.addEventListener('click', () => testProvider(btn.dataset.provider));
  });
  document.querySelectorAll('.btn-activate').forEach(btn => {
    btn.addEventListener('click', () => activateProvider(btn.dataset.provider));
  });
}

async function saveProvider(id) {
  const inputs = document.querySelectorAll(`input[data-provider="${id}"]`);
  const config = {};
  inputs.forEach(input => {
    config[input.dataset.key] = input.value;
  });

  await sendToBackground('update_provider', { providerId: id, config });

  const testEl = document.getElementById(`test-${id}`);
  testEl.className = 'test-result show ok';
  testEl.textContent = 'Saved!';
  setTimeout(() => testEl.classList.remove('show'), 2000);
}

async function testProvider(id) {
  await saveProvider(id);

  const testEl = document.getElementById(`test-${id}`);
  testEl.className = 'test-result show';
  testEl.textContent = 'Testing...';
  testEl.style.color = 'var(--text2)';

  const res = await sendToBackground('test_provider', { providerId: id });
  if (res.ok) {
    testEl.className = 'test-result show ok';
    testEl.textContent = `Connected! Model: ${res.model || 'unknown'}`;
  } else {
    testEl.className = 'test-result show fail';
    testEl.textContent = `Failed: ${res.error}`;
  }
}

async function activateProvider(id) {
  await sendToBackground('set_active_provider', { providerId: id });
  activeProviderId = id;
  renderProviders();
}

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

init();
