import assert from 'node:assert/strict';

// These completion/memory fixtures exercise the subsequent execution loop.
// Supply its newly required model intent response separately so a classifier
// turn cannot consume the execution response queue or alter its assertions.
export function supplyReadOnlyCloudIntent(agent) {
  const chat = agent._chatWithCostAllowance;
  agent._chatWithCostAllowance = async function(provider, messages, options, costState, metadata) {
    if (metadata?.generationName !== 'planner_intent') return chat.call(this, provider, messages, options, costState, metadata);
    assert.ok(messages.some(message => message.role === 'user'));
    assert.ok(!options.tools?.length, 'Intent classification must not dispatch execution tools');
    return { content: JSON.stringify({
      request_kind: 'execute', site_job: null, requires_state_change: false, requires_submission: false, messaging: null,
      completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
      read_scope: 'visible_page', summary: 'Read the requested page.', confidence: 0.95,
      steps: [{ id: '1', action: 'Read the requested page.', tools: [] }], skill_ids: [],
      memory: { use_scratchpad: false, scratchpad_notes: [], use_progress_ledger: false, progress_action: null },
      scheduling: null, risks: [], localized: { locale: 'en', summary: 'Read the requested page.',
        steps: [{ id: '1', action: 'Read the requested page.' }], risks: [] },
      response_language: { framing_locale: 'en', deliverable_locales: ['en'], preserve_source_text: false }, mode: 'act',
    }) };
  };
}
