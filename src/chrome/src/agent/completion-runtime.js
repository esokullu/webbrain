import { DECISION_SETTINGS_KEYS, resolveDecisionConfig } from './decision-config.js';
import { createSystemOneJudge } from './systemone-judge.js';
import { redactSystemOneText, wrapSystemOneData, boundedSystemOneText as boundedText } from './systemone-evidence.js';
import { COMPLETION_INSTRUCTIONS, completionQuestions, decisionCompletionVerdict, llmCompletionVerdict, verifyCompletion, withCompletionTimeout, completionStopError } from './completion-verifier.js';

async function evidenceKey(state) {
  // Wrapper nonces delimit untrusted content; they are not evidence changes.
  const canonical = JSON.stringify(state, (_key, value) => typeof value === 'string'
    ? value.replace(/(<\/?untrusted_page_content) id="[^"]*"/g, '$1') : value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

function invalidateCompletionProof(agent, tabId) {
  const guard = agent._planExecutionGuards.get(tabId);
  if (guard?.semanticSubmissionVerified) {
    guard.verifiedSubmissionEvidence = false;
    guard.semanticSubmissionVerified = false;
  }
  agent._completionVerdicts?.delete(tabId);
}

async function evaluateBrowserCompletion(agent, tabId, { pageState = {}, pageUrl = '', summary = '' } = {}) {
  const provider = agent._activeProvider(tabId);
  if (agent.strictSecretMode || !provider) {
    invalidateCompletionProof(agent, tabId);
    return { outcome: 'uncertain', engine: 'legacy', reason: 'unavailable' };
  }
  const stored = await chrome.storage.local.get(DECISION_SETTINGS_KEYS);
  const compass = provider.config?.providerName === 'webbrain-cloud' ? provider.config : null;
  const config = resolveDecisionConfig(stored, compass);
  const context = agent.systemOneContext(tabId);
  const signal = agent._runAbortSignal(tabId);
  const guard = agent._planExecutionGuards.get(tabId);
  const task = agent._progressTaskAnchorText?.(tabId) || guard?.taskText || agent._latestTaskText(tabId) || agent._originalTaskText(tabId);
  const run = agent.completionInvariants.get(tabId);
  const scope = JSON.stringify([run?.runToken, run?.lastAction?.sequence, agent._progressTaskKeyHash(tabId), config.provider, config.model, config.url, provider.model, provider.supportsVision, JSON.stringify(config)]);
  agent._completionVerdicts ??= new Map();
  const currentRun = () => context.isCurrent() && !signal?.aborted && agent._activeProvider(tabId) === provider
    && scope === JSON.stringify([agent.completionInvariants.get(tabId)?.runToken, agent.completionInvariants.get(tabId)?.lastAction?.sequence, agent._progressTaskKeyHash(tabId), config.provider, config.model, config.url, provider.model, provider.supportsVision, JSON.stringify(config)]);
  const currentIdentity = async evidence => !!evidence.identity && currentRun()
    && JSON.stringify(resolveDecisionConfig(await chrome.storage.local.get(DECISION_SETTINGS_KEYS), compass)) === JSON.stringify(config)
    && evidence.identity === await agent._completionDocumentStamp(tabId, true) && currentRun();
  const current = async evidence => {
    if (!await currentIdentity(evidence)) return false;
    if (evidence.modality !== 'vision') {
      // Re-read the bounded AX evidence actually sent to the judge. Full-body
      // clocks/feeds outside that evidence do not establish staleness.
      const fresh = await capture('ax', true);
      return fresh?.key === (evidence.key || evidence.evidenceKey) && await currentIdentity(evidence);
    }
    // Text and input stamps cannot detect canvas, image or CSS changes. Take a
    // new redacted, budgeted capture after the request; never reuse that cache.
    let fresh;
    try { fresh = await capture('vision', true); }
    catch (error) { if (completionStopError(error, signal)) throw error; }
    if (!await currentIdentity(evidence)) return false;
    if (fresh?.key === (evidence.key || evidence.evidenceKey)) return true;
    // Moving pixels cannot certify the old image, but need not mean the task
    // changed. Discard that verdict and judge a fresh AX read instead.
    throw Object.assign(new Error('Visual evidence changed or could not be refreshed.'), { code: 'COMPLETION_VISUAL_CHANGED' });
  };
  const messages = agent.conversations.get(tabId) || [];
  // Tool IDs survive conversation compaction. Unknown provenance or reused
  // pre-run IDs cannot certify that this task performed a required read.
  const calls = run?.historyToolCallIdsBeforeRun instanceof Set
    ? messages.flatMap(m => m.tool_calls || []).filter(call => call.id && !run.historyToolCallIdsBeforeRun.has(call.id)) : [];
  const toolNames = new Map(calls.map(call => [call.id, call.function?.name]));
  const reads = messages.filter(m => m.role === 'tool' && /^(read_page|get_accessibility_tree|verify_form)$/.test(toolNames.get(m.tool_call_id) || ''));
  const selectedReads = [...new Set([...reads.filter(m => /rules|guidelines|moderation/i.test(String(m.content))).slice(-2), ...reads.slice(-2)])];
  const history = selectedReads.map(m => ({ tool: toolNames.get(m.tool_call_id) || m.name, evidence: wrapSystemOneData(boundedText(redactSystemOneText(String(m.content)), 450)) }));
  // Entered values can be secrets without recognizable labels. Action names
  // supply history without sending arbitrary tool arguments to another judge.
  const recordedActions = calls.filter(c => /^(type|fill|click|navigate|set_)/.test(c.function?.name || '')).slice(-8).map(c => ({ tool: c.function.name }));
  const captures = new Map();
  const capture = async (modality, refresh = false) => {
    const before = await agent._completionDocumentStamp(tabId, true);
    const cached = captures.get(modality);
    const reusable = cached?.identity === before && context.isCurrent();
    if (!refresh && reusable) return cached;
    // A new vision judgment needs both its evidence and its post-request
    // freshness capture. With only one slot left, use AX before paying a judge.
    if (modality === 'vision' && agent._canTakeAutoScreenshot?.(tabId, refresh || reusable ? 1 : 2) === false) return null;
    let observation;
    if (modality === 'vision') {
      let pixels = await agent._captureCompletionJudgeImage(tabId);
      if (!pixels) return null;
      const budget = agent._budgetForCapture();
      pixels = (await agent._shrinkImageForBudget(pixels, 0, 0, { ...budget, maxTargetPx: Math.min(1408, budget.maxTargetPx), maxTargetTokens: Math.min(1400, budget.maxTargetTokens) })).dataUrl;
      observation = { type: 'image_url', image_url: { url: pixels } };
    } else {
      const result = await agent.executeTool(tabId, 'get_accessibility_tree', { maxChars: 5500 });
      if (result?.success === false || !result?.pageContent) return null;
      observation = { observation: wrapSystemOneData(boundedText(redactSystemOneText(result.pageContent), 4500)) };
    }
    const identity = await agent._completionDocumentStamp(tabId, true);
    if (!identity || identity !== before || !context.isCurrent()) return null;
    const submit = agent._completionSubmitStates.get(tabId);
    const binding = submit?.workflowBinding;
    const workflowBinding = binding ? { adapterName: binding.adapterName, revision: binding.revision,
      job: binding.job, verificationKind: binding.verificationKind, recipientBound: binding.recipientBound === true } : null;
    const info = {
      task: boundedText(redactSystemOneText(String(task || '')), 2500),
      requirements: { requiresSubmission: guard?.requiresSubmission, requiresStateChange: guard?.requiresStateChange, workflow: boundedText(guard?.siteWorkflow?.job?.id, 120) },
      action: wrapSystemOneData(boundedText(redactSystemOneText(JSON.stringify({ lastAction: run?.lastAction, submit: submit ? { dispatched: submit.dispatched, originatingUrl: submit.originatingUrl, resultingUrl: submit.resultingUrl, workflowBinding } : null })), 1000)),
      recorded_reads: history, recorded_actions: recordedActions, document: boundedText(redactSystemOneText(pageUrl), 1000),
      page_errors: wrapSystemOneData(boundedText(redactSystemOneText(JSON.stringify(pageState?.validationMessages || pageState?.errorMessages || [])), 500)),
      candidate_summary_not_proof: wrapSystemOneData(boundedText(redactSystemOneText(String(summary)), 600)),
    };
    const state = [info, observation];
    const evidence = { identity, modality, state, key: await evidenceKey(state) };
    captures.set(modality, evidence);
    return evidence;
  };
  const prior = agent._completionVerdicts.get(tabId);
  const priorCurrent = prior?.scope === scope && prior.outcome !== 'uncertain' && await current(prior).catch(error => {
    if (error?.code === 'COMPLETION_VISUAL_CHANGED') return false;
    throw error;
  });
  if (priorCurrent) {
    const fresh = await capture(prior.modality);
    if (fresh?.key === prior.evidenceKey) return prior;
  }
  invalidateCompletionProof(agent, tabId);
  const online = globalThis.navigator?.onLine !== false;
  const decision = config.enabled && config.doneEnabled && (config.local || online) ? {
    name: config.provider, supportsVision: config.supportsVision,
    evaluate: async evidence => {
      const headers = compass ? { 'X-WebBrain-Device-Id': compass.deviceGuid || '', 'X-WebBrain-Client': 'extension', 'X-WebBrain-Help-Improve': compass.helpImproveWebBrain === false ? '0' : '1' } : {};
      const result = await agent.evaluateSystemOne(tabId, createSystemOneJudge({ maxRetries: 0 }), {
        config, state: evidence.state, questions: completionQuestions(), signal, headers,
        metadata: compass ? { session_id: agent.conversationIds.get(tabId), trace: { generation_name: 'completion_verification' } } : {},
      }, context);
      return decisionCompletionVerdict(result, config.threshold);
    },
  } : null;
  // These switches outsource checks to the decision sidecar. The approved
  // routing still uses the active LLM when that sidecar is off/unconfigured.
  const llm = typeof provider.chat === 'function' && (online || provider.config?.category === 'local') ? {
    name: 'llm', supportsVision: provider.supportsVision,
    evaluate: async (evidence, modality) => {
      const [info, observation] = evidence.state;
      const result = await withCompletionTimeout(requestSignal => agent._chatWithCostAllowance(provider, [
        { role: 'system', content: COMPLETION_INSTRUCTIONS + ' Return only JSON {"outcome":"succeeded|pending|failed|uncertain","reason":"brief evidence-based reason"}. Do not call tools or perform actions.' },
        { role: 'user', content: modality === 'vision' ? [{ type: 'text', text: JSON.stringify(info) }, observation] : JSON.stringify(evidence.state) },
      ], { temperature: 0, maxTokens: 256, signal: requestSignal }, context.costState || agent._newCostRunState(), { tabId, generationName: 'completion_verification' }), signal, 10000);
      if (result.costAllowanceMessage) throw agent._costAllowanceError(result.costAllowanceMessage);
      return { ...llmCompletionVerdict(result.content), model: provider.model };
    },
  } : null;
  const verdict = await verifyCompletion({ decision, llm, capture, isCurrent: current, signal,
    onAttempt: ({ reason, ...metadata }) => agent.recordSystemOneVerdict(tabId, {
      phase: 'done_verification', ...metadata,
      ...(reason ? { reason: /^(?:capture_unavailable|unavailable|http_\d{3}|JEV_[A-Z_]+)$/.test(reason) ? reason : 'insufficient_evidence' } : {}),
    }, context) });
  const accepted = { ...verdict, scope };
  agent._completionVerdicts.set(tabId, accepted);
  return accepted;
}

export async function verifyBrowserCompletion(agent, tabId, options) {
  try { return await evaluateBrowserCompletion(agent, tabId, options); }
  catch (error) {
    invalidateCompletionProof(agent, tabId);
    if ((error?.status ?? error?.httpStatus) === 402) error.code = 'WB_COST_ALLOWANCE';
    if (error?.code === 'STALE_COMPLETION') return { outcome: 'pending', engine: 'freshness', reason: 'evidence_changed' };
    if (completionStopError(error, agent._runAbortSignal(tabId))) throw error;
    return { outcome: 'uncertain', engine: 'legacy', reason: 'verifier_unavailable' };
  }
}
