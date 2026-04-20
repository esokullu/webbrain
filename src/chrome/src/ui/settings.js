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
const notifySoundToggle = document.getElementById('toggle-notify-sound');
const tracingToggle = document.getElementById('toggle-tracing');
const accountSection = document.getElementById('account-section');
const visionBaseUrlInput = document.getElementById('vision-base-url');
const visionApiKeyInput = document.getElementById('vision-api-key');
const visionModelInput = document.getElementById('vision-model');
const btnSaveVision = document.getElementById('btn-save-vision');
const btnTestVision = document.getElementById('btn-test-vision');
const btnClearVision = document.getElementById('btn-clear-vision');
const visionTestResult = document.getElementById('test-vision');
const profileEnabledToggle = document.getElementById('toggle-profile-enabled');
const profileTextArea = document.getElementById('profile-text');
const btnSaveProfile = document.getElementById('btn-save-profile');
const btnClearProfile = document.getElementById('btn-clear-profile');
const profileTestResult = document.getElementById('test-profile');

let providersData = {};
let activeProviderId = '';
let authToken = '';
let authEmail = '';
let authDefaultModel = '';

// --- Init ---

async function init() {
  // Load auth state
  const authStored = await chrome.storage.local.get(['authToken', 'authEmail', 'authDefaultModel']);
  authToken = authStored.authToken || '';
  authEmail = authStored.authEmail || '';
  authDefaultModel = authStored.authDefaultModel || '';
  renderAuthSection();

  // Load display settings
  const stored = await chrome.storage.local.get(['verboseMode', 'screenshotFallback', 'maxAgentSteps', 'autoScreenshot', 'useSiteAdapters', 'notifySound', 'tracingEnabled']);
  verboseToggle.checked = stored.verboseMode || false;
  screenshotToggle.checked = stored.screenshotFallback ?? true; // on by default
  maxStepsRange.value = stored.maxAgentSteps || 60;
  stepsValueLabel.textContent = maxStepsRange.value;
  autoScreenshotSelect.value = stored.autoScreenshot || 'state_change';
  siteAdaptersToggle.checked = stored.useSiteAdapters ?? true;
  notifySoundToggle.checked = stored.notifySound ?? true; // on by default
  tracingToggle.checked = stored.tracingEnabled === true; // off by default

  // Load vision model config
  const visionStored = await chrome.storage.local.get(['visionModel']);
  const vision = visionStored.visionModel || {};
  visionBaseUrlInput.value = vision.baseUrl || '';
  visionApiKeyInput.value = vision.apiKey || '';
  visionModelInput.value = vision.model || '';

  // Load profile (auto-fill bio + throwaway password)
  const profileStored = await chrome.storage.local.get(['profileEnabled', 'profileText']);
  if (profileEnabledToggle) profileEnabledToggle.checked = !!profileStored.profileEnabled;
  if (profileTextArea) profileTextArea.value = profileStored.profileText || '';

  // Load providers
  const res = await sendToBackground('get_providers');
  providersData = res.providers;
  activeProviderId = res.active;
  renderProviders();
}

// --- Auth ---

function renderAuthSection() {
  if (authToken && authEmail) {
    accountSection.innerHTML = `
      <div class="account-card">
        <div class="account-info">
          <div class="account-email">${authEmail}</div>
          <div class="account-provider">WebBrain Cloud</div>
        </div>
        <button class="btn-sign-out" id="btn-sign-out">Sign Out</button>
      </div>
    `;
    document.getElementById('btn-sign-out').addEventListener('click', logout);
  } else {
    accountSection.innerHTML = `
      <div class="account-card">
        <div class="account-info">
          <div class="account-email not-signed-in">Not signed in</div>
        </div>
        <button class="btn-sign-in" id="btn-sign-in">Sign In / Register</button>
      </div>
    `;
    document.getElementById('btn-sign-in').addEventListener('click', openAuthTab);
  }
}

function openAuthTab() {
  window.open('https://auth.webbrain.one', '_blank');
}

async function logout() {
  await chrome.storage.local.remove(['authToken', 'authEmail', 'authDefaultModel']);
  authToken = '';
  authEmail = '';
  authDefaultModel = '';
  renderAuthSection();
}

window.addEventListener('message', (event) => {
  if (event.data?.type === 'WB_AUTH_TOKEN') {
    const { token, email, defaultModel } = event.data;
    authToken = token;
    authEmail = email;
    authDefaultModel = defaultModel || 'openai/gpt-4o';
    chrome.storage.local.set({ authToken, authEmail, authDefaultModel });
    renderAuthSection();
    autoConfigureWebbrainProvider();
  }
});

async function autoConfigureWebbrainProvider() {
  const webbrainConfig = {
    type: 'openai',
    label: 'WebBrain Cloud',
    providerName: 'webbrain',
    baseUrl: 'https://auth.webbrain.one/v1',
    model: authDefaultModel || 'openai/gpt-4o',
    apiKey: authToken,
    enabled: true,
  };

  await sendToBackground('update_provider', { providerId: 'webbrain', config: webbrainConfig });
  await sendToBackground('set_active_provider', { providerId: 'webbrain' });

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

notifySoundToggle.addEventListener('change', () => {
  chrome.storage.local.set({ notifySound: notifySoundToggle.checked });
});

tracingToggle.addEventListener('change', () => {
  chrome.storage.local.set({ tracingEnabled: tracingToggle.checked });
});

// --- Vision Model ---

function flashVisionResult(className, text) {
  visionTestResult.className = `test-result show ${className}`;
  visionTestResult.textContent = text;
  setTimeout(() => visionTestResult.classList.remove('show'), 2000);
}

btnSaveVision.addEventListener('click', async () => {
  const baseUrl = visionBaseUrlInput.value.trim();
  const apiKey = visionApiKeyInput.value.trim();
  const model = visionModelInput.value.trim();

  if (!baseUrl && !apiKey && !model) {
    await chrome.storage.local.remove('visionModel');
    flashVisionResult('ok', 'Cleared.');
    return;
  }

  await chrome.storage.local.set({
    visionModel: { baseUrl, apiKey, model },
  });
  flashVisionResult('ok', 'Saved!');
});

btnTestVision.addEventListener('click', async () => {
  const baseUrl = visionBaseUrlInput.value.trim();
  const apiKey = visionApiKeyInput.value.trim();
  const model = visionModelInput.value.trim();

  if (!baseUrl || !model) {
    visionTestResult.className = 'test-result show fail';
    visionTestResult.textContent = 'Fill in Base URL and Model first.';
    setTimeout(() => visionTestResult.classList.remove('show'), 2500);
    return;
  }

  await chrome.storage.local.set({
    visionModel: { baseUrl, apiKey, model },
  });

  visionTestResult.className = 'test-result show';
  visionTestResult.textContent = 'Testing...';
  visionTestResult.style.color = 'var(--text2)';

  const res = await sendToBackground('test_vision_provider');
  if (res.ok) {
    visionTestResult.className = 'test-result show ok';
    visionTestResult.textContent = `Connected! Model: ${res.model || model}`;
  } else {
    visionTestResult.className = 'test-result show fail';
    visionTestResult.textContent = `Failed: ${res.error}`;
  }
});

btnClearVision.addEventListener('click', async () => {
  visionBaseUrlInput.value = '';
  visionApiKeyInput.value = '';
  visionModelInput.value = '';
  await chrome.storage.local.remove('visionModel');
  flashVisionResult('ok', 'Cleared.');
});

// --- Profile auto-fill ---
// Persisted to chrome.storage.local in plaintext; the agent picks the
// changes up via the storage.onChanged listener in background.js and
// refreshes open conversations' system prompts on the next turn.

function flashProfileResult(className, text) {
  if (!profileTestResult) return;
  profileTestResult.className = `test-result show ${className}`;
  profileTestResult.textContent = text;
  setTimeout(() => profileTestResult.classList.remove('show'), 2000);
}

// Enabling/disabling the toggle saves immediately — no "Save" click needed
// for the on/off state so users don't get confused when the toggle
// appears to not do anything.
if (profileEnabledToggle) {
  profileEnabledToggle.addEventListener('change', () => {
    chrome.storage.local.set({ profileEnabled: profileEnabledToggle.checked });
  });
}

if (btnSaveProfile) {
  btnSaveProfile.addEventListener('click', async () => {
    const text = (profileTextArea?.value || '').trim();
    await chrome.storage.local.set({ profileText: text });
    flashProfileResult('ok', 'Saved.');
  });
}

if (btnClearProfile) {
  btnClearProfile.addEventListener('click', async () => {
    if (profileTextArea) profileTextArea.value = '';
    await chrome.storage.local.set({ profileText: '' });
    flashProfileResult('ok', 'Cleared.');
  });
}

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
        { key: 'model', label: 'Model', type: 'text', placeholder: 'claude-sonnet-4-6' },
        { key: 'baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://api.anthropic.com' },
      ],
    },
    webbrain: {
      fields: [
        { key: 'baseUrl', label: 'API Base URL', type: 'text', placeholder: 'https://auth.webbrain.one/v1' },
        { key: 'model', label: 'Model', type: 'text', placeholder: 'openai/gpt-4o' },
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
