/**
 * WebBrain Settings Page — provider configuration + display settings.
 */

const providersContainer = document.getElementById('providers');
const verboseToggle = document.getElementById('toggle-verbose');
const screenshotToggle = document.getElementById('toggle-screenshot-fallback');
const maxStepsRange = document.getElementById('range-max-steps');
const stepsValueLabel = document.getElementById('steps-value');
const autoScreenshotSelect = document.getElementById('select-auto-screenshot');
const siteAdaptersToggle = document.getElementById('toggle-site-adapters');

let providersData = {};
let activeProviderId = '';

// --- Init ---

async function init() {
  // Load display settings
  const stored = await chrome.storage.local.get(['verboseMode', 'screenshotFallback', 'maxAgentSteps', 'autoScreenshot', 'useSiteAdapters']);
  verboseToggle.checked = stored.verboseMode || false;
  screenshotToggle.checked = stored.screenshotFallback ?? true; // on by default
  maxStepsRange.value = stored.maxAgentSteps || 60;
  stepsValueLabel.textContent = maxStepsRange.value;
  autoScreenshotSelect.value = stored.autoScreenshot || 'state_change';
  siteAdaptersToggle.checked = stored.useSiteAdapters ?? true;

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

autoScreenshotSelect.addEventListener('change', () => {
  chrome.storage.local.set({ autoScreenshot: autoScreenshotSelect.value });
});

siteAdaptersToggle.addEventListener('change', () => {
  chrome.storage.local.set({ useSiteAdapters: siteAdaptersToggle.checked });
});

// --- Provider Rendering ---

function renderProviders() {
  providersContainer.innerHTML = '';

  const providerConfigs = {
    llamacpp: {
      fields: [
        { key: 'baseUrl', label: 'Server URL', type: 'text', placeholder: 'http://localhost:8080' },
        { key: 'model', label: 'Model', type: 'text', placeholder: 'qwen/qwen3.5-9b' },
        { key: 'supportsVision', label: 'Model supports vision (multimodal)', type: 'checkbox' },
        { key: 'useCompactPrompt', label: 'Compact prompt (recommended for small models, on by default)', type: 'checkbox' },
      ],
    },
    ollama: {
      fields: [
        { key: 'baseUrl', label: 'Server URL', type: 'text', placeholder: 'http://localhost:11434/v1' },
        { key: 'model', label: 'Model', type: 'text', placeholder: 'llama3.1' },
        { key: 'supportsVision', label: 'Model supports vision (multimodal)', type: 'checkbox' },
        { key: 'useCompactPrompt', label: 'Compact prompt (recommended for small models, on by default)', type: 'checkbox' },
      ],
    },
    lmstudio: {
      fields: [
        { key: 'baseUrl', label: 'Server URL', type: 'text', placeholder: 'http://localhost:1234/v1' },
        { key: 'model', label: 'Model (optional)', type: 'text', placeholder: 'leave blank to use loaded model' },
        { key: 'supportsVision', label: 'Model supports vision (multimodal)', type: 'checkbox' },
        { key: 'useCompactPrompt', label: 'Compact prompt (recommended for small models, on by default)', type: 'checkbox' },
      ],
    },
    openai: {
      fields: [
        { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', label: 'Model', type: 'text', placeholder: 'gpt-5' },
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
      if (field.type === 'checkbox') {
        // For useCompactPrompt on local providers, default to checked when
        // the config key hasn't been explicitly set yet (matches provider logic).
        let isChecked = config[field.key];
        if (field.key === 'useCompactPrompt' && config[field.key] == null) {
          const localProviders = ['llamacpp', 'ollama', 'lmstudio'];
          isChecked = localProviders.includes(id);
        }
        const checked = isChecked ? 'checked' : '';
        fieldsHTML += `
          <div class="field" style="display:flex;align-items:center;gap:8px;flex-direction:row;">
            <input type="checkbox" data-provider="${id}" data-key="${field.key}" data-type="checkbox" ${checked}
                   style="width:auto;cursor:pointer;">
            <label style="margin:0;cursor:pointer;">${field.label}</label>
          </div>
        `;
      } else {
        fieldsHTML += `
          <div class="field">
            <label>${field.label}</label>
            <input type="${field.type}" data-provider="${id}" data-key="${field.key}"
                   value="${config[field.key] || ''}" placeholder="${field.placeholder || ''}">
          </div>
        `;
      }
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
    if (input.dataset.type === 'checkbox' || input.type === 'checkbox') {
      config[input.dataset.key] = input.checked;
    } else {
      config[input.dataset.key] = input.value;
    }
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

/**
 * Snapshot any unsaved field values from the current DOM back into
 * providersData so a subsequent renderProviders() preserves them.
 * Without this, clicking "Set Active" or any other action that re-renders
 * silently throws away whatever the user has typed but not yet saved.
 */
function syncInputsIntoProvidersData() {
  document.querySelectorAll('input[data-provider]').forEach((input) => {
    const id = input.dataset.provider;
    const key = input.dataset.key;
    if (!id || !key || !providersData[id]) return;
    if (input.dataset.type === 'checkbox' || input.type === 'checkbox') {
      providersData[id][key] = input.checked;
    } else {
      providersData[id][key] = input.value;
    }
  });
}

async function activateProvider(id) {
  syncInputsIntoProvidersData();
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
