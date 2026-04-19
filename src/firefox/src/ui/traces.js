/**
 * Traces page — inspects IndexedDB runs recorded by the trace recorder.
 * Supports single-run timeline view and two-run side-by-side compare.
 */

import {
  listRuns, getRun, getRunEvents, getScreenshot,
  deleteRun, clearAllRuns,
} from '../trace/recorder.js';

const listEl = document.getElementById('run-list');
const mainPane = document.getElementById('main-pane');
const emptyState = document.getElementById('empty-state');
const countPill = document.getElementById('count-pill');
const filterText = document.getElementById('filter-text');
const filterModel = document.getElementById('filter-model');
const imgModal = document.getElementById('img-modal');
const imgModalImg = document.getElementById('img-modal-img');

let allRuns = [];
let selectedRunId = null;
let compareMode = false;
let compareIds = []; // length 0..2

// ----- List -----------------------------------------------------------------

async function refresh() {
  allRuns = await listRuns({ limit: 500 });
  countPill.textContent = `${allRuns.length} run${allRuns.length === 1 ? '' : 's'}`;
  // Populate model filter.
  const models = Array.from(new Set(allRuns.map(r => r.model).filter(Boolean))).sort();
  const prev = filterModel.value;
  filterModel.innerHTML = '<option value="">All models</option>' +
    models.map(m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join('');
  filterModel.value = models.includes(prev) ? prev : '';
  renderList();
}

function renderList() {
  const needle = filterText.value.trim().toLowerCase();
  const modelFilter = filterModel.value;
  const filtered = allRuns.filter(r => {
    if (modelFilter && r.model !== modelFilter) return false;
    if (!needle) return true;
    return [r.userMessage, r.model, r.tabUrl, r.tabTitle, r.providerId]
      .some(v => (v || '').toLowerCase().includes(needle));
  });
  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px;">No runs match.</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(r => {
    const status = r.status || 'done';
    const started = new Date(r.startedAt).toLocaleString();
    const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
    const steps = r.stepCount || 0;
    const tokens = (r.totalInputTokens || 0) + (r.totalOutputTokens || 0);
    const cls = [
      'run-item',
      selectedRunId === r.runId ? 'selected' : '',
      compareIds.includes(r.runId) ? 'compare' : '',
    ].filter(Boolean).join(' ');
    const title = r.userMessage || '(no task)';
    return `
      <div class="${cls}" data-run-id="${escapeAttr(r.runId)}">
        <div class="run-title"><span class="status-dot ${status}"></span>${escapeHtml(title.slice(0, 120))}</div>
        <div class="run-meta">
          <span class="run-model">${escapeHtml(r.model || '?')}</span>
          <span>${escapeHtml(r.providerId || '')}</span>
          <span>${steps} step${steps === 1 ? '' : 's'}</span>
          <span>${dur}</span>
          ${tokens ? `<span>${tokens.toLocaleString()} tok</span>` : ''}
        </div>
        <div class="run-meta" style="margin-top:3px;"><span>${started}</span></div>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.run-item').forEach(el => {
    el.addEventListener('click', () => handleRunClick(el.dataset.runId));
  });
}

function handleRunClick(runId) {
  if (compareMode) {
    const idx = compareIds.indexOf(runId);
    if (idx >= 0) compareIds.splice(idx, 1);
    else compareIds.push(runId);
    if (compareIds.length > 2) compareIds.shift();
    renderList();
    if (compareIds.length === 2) renderCompare(compareIds[0], compareIds[1]);
    else {
      mainPane.classList.remove('compare-mode');
      mainPane.innerHTML = '<div id="empty-state"><div><p style="font-size:14px;">Compare mode</p><p style="color:var(--text3);">Picked ' + compareIds.length + '/2. Click another run to complete the comparison.</p></div></div>';
    }
  } else {
    selectedRunId = runId;
    renderList();
    renderRun(runId);
  }
}

// ----- Single run view ------------------------------------------------------

async function renderRun(runId) {
  const run = await getRun(runId);
  if (!run) return;
  const events = await getRunEvents(runId);
  mainPane.classList.remove('compare-mode');
  mainPane.innerHTML = await buildRunView(run, events, false);
  wireTimelineImages(mainPane);
}

async function renderCompare(aId, bId) {
  const [a, b, aEv, bEv] = await Promise.all([
    getRun(aId), getRun(bId), getRunEvents(aId), getRunEvents(bId),
  ]);
  if (!a || !b) return;
  mainPane.classList.add('compare-mode');
  const aHtml = await buildRunView(a, aEv, true);
  const bHtml = await buildRunView(b, bEv, true);
  mainPane.innerHTML = `<div class="pane">${aHtml}</div><div class="pane">${bHtml}</div>`;
  wireTimelineImages(mainPane);
}

async function buildRunView(run, events, compact) {
  const header = `
    <div class="run-header">
      <h2>${escapeHtml(run.model || 'unknown')}</h2>
      <span class="meta">${escapeHtml(run.providerId || '')} · ${new Date(run.startedAt).toLocaleString()}</span>
    </div>
    <div class="stats-row">
      <span class="stat">status <b>${escapeHtml(run.status || '')}</b></span>
      <span class="stat">steps <b>${run.stepCount || 0}</b></span>
      <span class="stat">duration <b>${run.durationMs ? (run.durationMs / 1000).toFixed(1) + 's' : '—'}</b></span>
      <span class="stat">in-tokens <b>${(run.totalInputTokens || 0).toLocaleString()}</b></span>
      <span class="stat">out-tokens <b>${(run.totalOutputTokens || 0).toLocaleString()}</b></span>
    </div>
    <div class="run-task">${escapeHtml(run.userMessage || '')}</div>
    ${run.finalContent ? `<div class="run-task" style="border-left-color:var(--success);"><b style="color:var(--success);">Final:</b> ${escapeHtml(run.finalContent)}</div>` : ''}
  `;
  // Build timeline — collect screenshot blobs for img src.
  const shotCache = new Map();
  for (const ev of events) {
    if (ev.kind === 'screenshot') {
      const shot = await getScreenshot(run.runId, ev.seq);
      if (shot) shotCache.set(ev.seq, shot);
    }
  }
  const items = events.map(ev => renderEvent(ev, shotCache, compact)).join('');
  return `${header}<div class="timeline">${items}</div>`;
}

function renderEvent(ev, shotCache, compact) {
  const ts = new Date(ev.ts).toLocaleTimeString();
  const stepBadge = ev.data?.step != null ? `<span class="step">step ${ev.data.step}</span>` : '';
  switch (ev.kind) {
    case 'llm_request': {
      return `
        <div class="event llm_request">
          <div class="event-head"><span class="kind">→ LLM request</span>${stepBadge}<span class="latency">${ts}</span></div>
          <span class="tool-args">${ev.data?.messageCount || 0} messages, ${ev.data?.toolsCount || 0} tools · ${escapeHtml(ev.data?.model || '')}</span>
        </div>`;
    }
    case 'llm_response': {
      const u = ev.data?.usage;
      const usage = u ? `<span class="latency">${(u.prompt_tokens || 0).toLocaleString()} in / ${(u.completion_tokens || 0).toLocaleString()} out</span>` : '';
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const content = ev.data?.content;
      const toolCalls = ev.data?.toolCalls || [];
      let body = '';
      if (content) {
        body += `<div class="content-text">${escapeHtml(content)}</div>`;
      }
      if (toolCalls.length > 0) {
        const tcList = toolCalls.map(tc => {
          let args = tc.args || '';
          try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
          return `<details><summary><span class="tool-name">${escapeHtml(tc.name)}</span>()</summary><pre>${escapeHtml(args)}</pre></details>`;
        }).join('');
        body += `<div style="margin-top:6px;">${tcList}</div>`;
      }
      return `
        <div class="event llm_response">
          <div class="event-head"><span class="kind">← LLM response</span>${stepBadge}${usage}${lat}<span class="latency">${ts}</span></div>
          ${body}
        </div>`;
    }
    case 'tool': {
      const name = ev.data?.name || '?';
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const args = ev.data?.args ? JSON.stringify(ev.data.args, null, 2) : '';
      let result = ev.data?.result;
      try { result = typeof result === 'string' ? result : JSON.stringify(result, null, 2); } catch { result = String(result); }
      if (typeof result === 'string' && result.length > 4000 && compact) result = result.slice(0, 4000) + '\n... [truncated in compare view]';
      const ok = ev.data?.result && !ev.data.result.error && ev.data.result.success !== false;
      return `
        <div class="event tool">
          <div class="event-head">
            <span class="kind">${ok ? '✓' : '✗'} <span class="tool-name">${escapeHtml(name)}</span></span>
            ${lat}<span class="latency">${ts}</span>
          </div>
          ${args ? `<details><summary>args</summary><pre>${escapeHtml(args)}</pre></details>` : ''}
          <details ${ok ? '' : 'open'}><summary>result</summary><pre>${escapeHtml(result || '')}</pre></details>
        </div>`;
    }
    case 'screenshot': {
      const shot = shotCache.get(ev.seq);
      let src = '';
      if (shot?.blob) src = URL.createObjectURL(shot.blob);
      else if (shot?.dataUrl) src = shot.dataUrl;
      const caption = ev.data?.caption || 'screenshot';
      return `
        <div class="event screenshot">
          <div class="event-head"><span class="kind">📷 ${escapeHtml(caption)}</span>${stepBadge}<span class="latency">${ts}</span></div>
          ${src ? `<img src="${src}" alt="${escapeAttr(caption)}" loading="lazy">` : '<span class="latency">(screenshot blob missing)</span>'}
        </div>`;
    }
    case 'error': {
      return `
        <div class="event error">
          <div class="event-head"><span class="kind">⚠ error</span>${stepBadge}<span class="latency">${ts}</span></div>
          <div class="content-text">${escapeHtml(ev.data?.phase || '')}: ${escapeHtml(ev.data?.message || '')}</div>
        </div>`;
    }
    case 'vision_sub_call': {
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const model = ev.data?.model ? `<span class="latency">${escapeHtml(ev.data.model)}</span>` : '';
      const ctx = ev.data?.context ? `<span class="tool-args">${escapeHtml(ev.data.context)}</span>` : '';
      const body = ev.data?.error
        ? `<div class="content-text" style="color:#f88;">vision sub-call failed: ${escapeHtml(ev.data.error)}</div>`
        : (ev.data?.description
            ? `<details open><summary>description</summary><pre>${escapeHtml(ev.data.description)}</pre></details>`
            : '');
      return `
        <div class="event vision_sub_call">
          <div class="event-head"><span class="kind">👁 vision sub-call</span>${ctx}${model}${lat}<span class="latency">${ts}</span></div>
          ${body}
        </div>`;
    }
    case 'note':
    default: {
      return `
        <div class="event note">
          <div class="event-head"><span class="kind">${escapeHtml(ev.kind)}</span>${stepBadge}<span class="latency">${ts}</span></div>
          <pre>${escapeHtml(JSON.stringify(ev.data, null, 2))}</pre>
        </div>`;
    }
  }
}

function wireTimelineImages(root) {
  root.querySelectorAll('.event.screenshot img').forEach(img => {
    img.addEventListener('click', () => {
      imgModalImg.src = img.src;
      imgModal.classList.add('show');
    });
  });
}

imgModal.addEventListener('click', () => imgModal.classList.remove('show'));

// ----- Toolbar handlers ------------------------------------------------------

document.getElementById('btn-refresh').addEventListener('click', refresh);

document.getElementById('btn-compare').addEventListener('click', () => {
  compareMode = !compareMode;
  const btn = document.getElementById('btn-compare');
  if (compareMode) {
    btn.classList.add('primary');
    btn.textContent = '⇔ Compare (pick 2)';
    compareIds = [];
    selectedRunId = null;
    mainPane.classList.remove('compare-mode');
    mainPane.innerHTML = '<div id="empty-state"><div><p style="font-size:14px;">Compare mode</p><p style="color:var(--text3);">Click two runs in the list to compare them side-by-side.</p></div></div>';
  } else {
    btn.classList.remove('primary');
    btn.textContent = '⇔ Compare';
    compareIds = [];
    mainPane.classList.remove('compare-mode');
    mainPane.innerHTML = '<div id="empty-state"><div><p style="font-size:14px;">No run selected.</p></div></div>';
  }
  renderList();
});

document.getElementById('btn-export').addEventListener('click', async () => {
  if (!selectedRunId) return alert('Select a run first.');
  const run = await getRun(selectedRunId);
  const events = await getRunEvents(selectedRunId);
  // Resolve screenshot blobs to base64 for portability.
  for (const ev of events) {
    if (ev.kind === 'screenshot') {
      const shot = await getScreenshot(selectedRunId, ev.seq);
      if (shot?.blob) {
        ev.data = ev.data || {};
        ev.data.screenshot_base64 = await blobToBase64(shot.blob);
      } else if (shot?.dataUrl) {
        ev.data.screenshot_dataUrl = shot.dataUrl;
      }
    }
  }
  const payload = { run, events, exportedAt: Date.now(), schema: 'webbrain-trace/1' };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webbrain-trace-${run.model || 'unknown'}-${run.runId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById('btn-delete').addEventListener('click', async () => {
  if (!selectedRunId) return alert('Select a run first.');
  if (!confirm('Delete this run?')) return;
  await deleteRun(selectedRunId);
  selectedRunId = null;
  mainPane.innerHTML = '<div id="empty-state"><div><p>Deleted.</p></div></div>';
  refresh();
});

document.getElementById('btn-clear-all').addEventListener('click', async () => {
  if (!confirm('Delete ALL recorded runs? This cannot be undone.')) return;
  await clearAllRuns();
  selectedRunId = null;
  compareIds = [];
  mainPane.innerHTML = '<div id="empty-state"><div><p>All runs deleted.</p></div></div>';
  refresh();
});

filterText.addEventListener('input', renderList);
filterModel.addEventListener('change', renderList);

// ----- Utils -----------------------------------------------------------------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function blobToBase64(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

// Auto-refresh every 5s while visible (so a running job shows new steps).
let _autoTimer = null;
function startAutoRefresh() {
  stopAutoRefresh();
  _autoTimer = setInterval(() => {
    refresh();
    if (selectedRunId && !compareMode) renderRun(selectedRunId);
  }, 5000);
}
function stopAutoRefresh() { if (_autoTimer) { clearInterval(_autoTimer); _autoTimer = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoRefresh(); else startAutoRefresh();
});

refresh();
startAutoRefresh();
