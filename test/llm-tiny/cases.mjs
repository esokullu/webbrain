// These fixtures are deliberately local and deterministic.  They are not a
// claim about real-site performance: their purpose is to compare action loops
// across the supported native protocols without credentials or live-site drift.

const clickCases = [
  ['01', 'Open the quarterly report.', 'Quarterly report', ['Annual report', 'Team directory']],
  ['02', 'Show the team calendar.', 'Team calendar', ['Billing calendar', 'Holiday policy']],
  ['03', 'Open the saved searches panel.', 'Saved searches', ['Search history', 'Recent files']],
  ['04', 'View the security audit.', 'Security audit', ['Account settings', 'Usage dashboard']],
  ['05', 'Open the campaign overview.', 'Campaign overview', ['Campaign archive', 'Audience list']],
  ['06', 'Show the inventory alerts.', 'Inventory alerts', ['Inventory catalog', 'Supplier notes']],
  ['07', 'Open the delivery schedule.', 'Delivery schedule', ['Delivery history', 'Route settings']],
  ['08', 'View the customer feedback queue.', 'Customer feedback', ['Customer directory', 'Support metrics']],
].map(([id, task, target, distractors]) => ({ id, kind: 'click', task, target, distractors }));

const inputCases = [
  ['09', 'Enter "north-star" as the project code, then save it.', 'Project code', 'north-star'],
  ['10', 'Set the alert email to "ops@example.test" and save.', 'Alert email', 'ops@example.test'],
  ['11', 'Name the workspace "Atlas" and save.', 'Workspace name', 'Atlas'],
  ['12', 'Set the report title to "May pipeline" and save.', 'Report title', 'May pipeline'],
  ['13', 'Enter "priority-7" as the queue label and save.', 'Queue label', 'priority-7'],
  ['14', 'Set the budget note to "review Friday" and save.', 'Budget note', 'review Friday'],
  ['15', 'Enter "east-region" as the rollout group and save.', 'Rollout group', 'east-region'],
  ['16', 'Set the incident tag to "network" and save.', 'Incident tag', 'network'],
].map(([id, task, label, value]) => ({ id, kind: 'input', task, label, value }));

const selectCases = [
  ['17', 'Choose "High" for incident priority, then apply it.', 'Incident priority', 'High', ['Low', 'Medium', 'High']],
  ['18', 'Set the report cadence to "Weekly", then apply it.', 'Report cadence', 'Weekly', ['Daily', 'Weekly', 'Monthly']],
  ['19', 'Choose the "Europe" region, then apply it.', 'Region', 'Europe', ['Americas', 'Europe', 'Asia Pacific']],
  ['20', 'Set the archive policy to "90 days", then apply it.', 'Archive policy', '90 days', ['30 days', '90 days', '1 year']],
  ['21', 'Choose "Customer success" as the owner, then apply it.', 'Owner', 'Customer success', ['Engineering', 'Customer success', 'Sales']],
  ['22', 'Set the deployment window to "Evening", then apply it.', 'Deployment window', 'Evening', ['Morning', 'Afternoon', 'Evening']],
].map(([id, task, label, value, options]) => ({ id, kind: 'select', task, label, value, options }));

const toggleCases = [
  ['23', 'Turn on weekly digest emails, then save.', 'Weekly digest emails'],
  ['24', 'Enable the out-of-office responder, then save.', 'Out-of-office responder'],
  ['25', 'Turn on low-stock notifications, then save.', 'Low-stock notifications'],
  ['26', 'Enable release reminders, then save.', 'Release reminders'],
].map(([id, task, label]) => ({ id, kind: 'toggle', task, label }));

const formCases = [
  ['27', 'Set the project name to "Orion", choose "High" visibility, and create the project.', 'Project name', 'Orion', 'Visibility', 'High', ['Private', 'Team', 'High']],
  ['28', 'Set the queue name to "Returns", choose "Europe" as the region, and create the queue.', 'Queue name', 'Returns', 'Region', 'Europe', ['Americas', 'Europe', 'Asia Pacific']],
  ['29', 'Set the campaign name to "Spring launch", choose "Weekly" updates, and create the campaign.', 'Campaign name', 'Spring launch', 'Updates', 'Weekly', ['Daily', 'Weekly', 'Monthly']],
  ['30', 'Set the workspace name to "Northwind", choose "Team" access, and create the workspace.', 'Workspace name', 'Northwind', 'Access', 'Team', ['Private', 'Team', 'Company']],
].map(([id, task, inputLabel, inputValue, selectLabel, selectValue, options]) => ({
  id, kind: 'form', task, inputLabel, inputValue, selectLabel, selectValue, options,
}));

export const CASES = Object.freeze([...clickCases, ...inputCases, ...selectCases, ...toggleCases, ...formCases]);

export function getCase(id) {
  return CASES.find(item => item.id === String(id).padStart(2, '0')) || null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderFixture(caseRecord) {
  const fields = (() => {
    if (caseRecord.kind === 'click') {
      return [caseRecord.target, ...caseRecord.distractors]
        .map(label => `<button class="secondary action" data-value="${escapeHtml(label)}">${escapeHtml(label)}</button>`)
        .join('\n');
    }
    if (caseRecord.kind === 'input') {
      return `<label>${escapeHtml(caseRecord.label)}<input aria-label="${escapeHtml(caseRecord.label)}" autocomplete="off"></label>
        <button class="primary submit">Save changes</button>`;
    }
    if (caseRecord.kind === 'select') {
      return `<label>${escapeHtml(caseRecord.label)}<select aria-label="${escapeHtml(caseRecord.label)}">${caseRecord.options.map(option => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>
        <button class="primary submit">Apply setting</button>`;
    }
    if (caseRecord.kind === 'toggle') {
      return `<label class="toggle"><input type="checkbox" aria-label="${escapeHtml(caseRecord.label)}"><span>${escapeHtml(caseRecord.label)}</span></label>
        <button class="primary submit">Save preferences</button>`;
    }
    return `<label>${escapeHtml(caseRecord.inputLabel)}<input aria-label="${escapeHtml(caseRecord.inputLabel)}" autocomplete="off"></label>
      <label>${escapeHtml(caseRecord.selectLabel)}<select aria-label="${escapeHtml(caseRecord.selectLabel)}">${caseRecord.options.map(option => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>
      <button class="primary submit">Create</button>`;
  })();

  const data = JSON.stringify(caseRecord).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tiny benchmark ${caseRecord.id}</title>
<style>
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f5f7fb; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg,#eef4ff,#f7f3ff); }
  main { width: min(880px, calc(100vw - 64px)); min-height: 510px; box-sizing: border-box; border: 1px solid #d8deec; border-radius: 20px; background: #fff; box-shadow: 0 22px 50px #2937551f; overflow: hidden; }
  header { padding: 24px 32px; color: #fff; background: #293c73; display: flex; align-items: center; justify-content: space-between; }
  header strong { font-size: 18px; } header span { border-radius: 999px; padding: 5px 10px; font-size: 12px; background: #ffffff24; }
  section { padding: 42px 64px; } h1 { font-size: 30px; margin: 0 0 10px; letter-spacing: -.6px; } p { font-size: 16px; color: #56627b; line-height: 1.5; margin: 0 0 30px; }
  .card { border: 1px solid #e2e7f1; border-radius: 14px; padding: 26px; background: #fbfcff; display: grid; gap: 18px; }
  label { display: grid; gap: 8px; color: #283753; font-size: 14px; font-weight: 650; } input, select { padding: 12px 13px; border: 1px solid #bfc9df; border-radius: 9px; color: #172033; background: white; font: inherit; }
  /* Keep open options in the captured page instead of an invisible native OS popup. */
  select, ::picker(select) { appearance: base-select; }
  button { min-height: 44px; padding: 10px 15px; border: 1px solid #c8d0e0; border-radius: 9px; color: #263553; background: #fff; font: 600 14px/1 Inter, ui-sans-serif, sans-serif; cursor: pointer; text-align: left; }
  button:hover { border-color: #6978a4; background: #f0f3fa; } button.primary { color: #fff; background: #3667c8; border-color: #3667c8; text-align: center; margin-top: 4px; } button.primary:hover { background: #2858b7; }
  .toggle { display: flex; align-items: center; gap: 11px; padding: 9px 0; } .toggle input { width: 20px; height: 20px; }
  #status { min-height: 22px; margin-top: 20px; color: #63708b; font-size: 14px; } #status.good { color: #087442; font-weight: 650; } #status.bad { color: #ad3f49; }
</style></head><body><main><header><strong>Workspace demo</strong><span>Task ${escapeHtml(caseRecord.id)} / 30</span></header>
<section><h1>${escapeHtml(caseRecord.kind === 'click' ? 'Choose a workspace view' : 'Update workspace settings')}</h1>
<p>Complete the requested change using this local demonstration page.</p><div class="card">${fields}</div><div id="status" aria-live="polite">Ready for changes.</div></section></main>
<script>
  const benchmarkCase = ${data};
  const status = document.querySelector('#status');
  const state = { complete: false, attempts: 0 };
  const setStatus = (text, kind = '') => { status.textContent = text; status.className = kind; };
  const pass = () => { state.complete = true; setStatus('Saved successfully.', 'good'); };
  const fail = () => { state.attempts += 1; setStatus('That change does not match the requested setting.', 'bad'); };
  for (const button of document.querySelectorAll('button.action')) button.addEventListener('click', () => button.dataset.value === benchmarkCase.target ? pass() : fail());
  document.querySelector('.submit')?.addEventListener('click', () => {
    const input = document.querySelector('input:not([type="checkbox"])');
    const select = document.querySelector('select');
    const check = document.querySelector('input[type="checkbox"]');
    const ok = benchmarkCase.kind === 'input' ? input.value === benchmarkCase.value
      : benchmarkCase.kind === 'select' ? select.value === benchmarkCase.value
      : benchmarkCase.kind === 'toggle' ? check.checked
      : input.value === benchmarkCase.inputValue && select.value === benchmarkCase.selectValue;
    ok ? pass() : fail();
  });
  window.__llmTinyFixture = { get state() { return { ...state }; } };
</script></body></html>`;
}
