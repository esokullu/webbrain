import { normalizeRejectedToolResponse } from '../agent/model-output-diagnostics.js';
import { isErrorCode } from './error-codes.js';
import { projectVisionCaptureDiagnostics } from '../agent/vision-capture-diagnostics.js';

/**
 * Privacy projection for durable trace records.
 *
 * The default trace tier is metadata-only. Keep the policy at the recorder
 * boundary so IndexedDB, the Traces UI, JSON exports, and OTLP exports all
 * start from the same safe event log. The lossless tier is an explicit opt-in
 * and intentionally bypasses these projections.
 */

const RUN_CONTENT_FIELDS = [
  'userMessage', 'finalContent', 'tabUrl', 'tabTitle', 'attachments',
];

const RESPONSE_METADATA_FIELDS = [
  'step', 'usage', 'latencyMs', 'model', 'phase', 'attempt', 'repair', 'empty',
  'finishReason', 'contentChars', 'toolCallCount', 'reasoningPresent',
  'reasoningChars', 'reasoningTokens', 'outputTokens', 'requestedMaxTokens',
  'recoveryAttempt', 'emptyReason', 'validationFailure', 'candidateAttempt',
];

const REQUEST_METADATA_FIELDS = [
  'step', 'providerClass', 'providerId', 'model', 'phase', 'attempt', 'repair',
  'messageCount', 'toolsCount', 'imageBlockCount', 'documentBlockCount',
  'runtimeMode', 'requestedMaxTokens',
];

const STREAMING_METADATA_FIELDS = [
  'step', 'status', 'protocol', 'reason', 'errorCode', 'textDeltaCount',
  'textChars', 'firstDeltaMs', 'durationMs', 'toolCallCount',
];

const STEP_METADATA_FIELDS = ['step', 'ok', 'status', 'code', 'durationMs', 'reason', 'handoffOutcome'];

const NOTE_METADATA_FIELDS = [
  'attempt', 'delayMs', 'code', 'status', 'progress', 'loaded', 'total',
  'context', 'visionRoute', 'phase', 'failureKind', 'reason', 'queryCount',
  'matchCount', 'multiSource', 'attempted', 'archiveDates', 'durationMs',
  'success', 'approved', 'outcome', 'verification', 'count',
  'adapter', 'revision', 'notesInjected', 'workflowSchema', 'job', 'template',
  'validationFailure', 'candidateAttempt', 'stage', 'retryMode',
  'certificationFailure', 'monitoringRelaxed', 'predicate', 'targetCount', 'focusedTargetAvailable', 'captureMs',
];

// Checker diagnostics are finite protocol labels, never arbitrary model text
// or JSON property names. A malformed reply can contain private source text in
// a duplicate field name, so metadata-only traces must normalize it here.
const VALIDATION_FAILURE_CODES = new Set([
  'empty_response', 'invalid_json', 'binding_mismatch', 'invalid_aligned',
  'invalid_reason', 'unexpected_fields', 'reasoning_only', 'output_limit',
  'provider_empty', 'content_filter', 'truncated_response', 'request_failed',
  'invalid_replacement_plan', 'malformed_or_multiple_json_objects',
  'response_not_object', 'key_mismatch', 'action_mismatch',
  'authorized_not_boolean', 'reason_not_string', 'invalid_response',
  ...['key', 'actionId', 'authorized', 'reason'].map(field => 'missing_' + field),
  ...['key', 'actionId', 'authorized', 'reason', 'version', 'status', 'actions',
    'requirements', 'prohibited', 'extra_field'].map(field => 'duplicate_' + field),
]);
const PUBLICATION_CONTRACT_FAILURES = new Set([
  'object fields', 'list bounds', 'enum', 'source reference', 'anchor occurrence',
  'missing start occurrence', 'missing end occurrence', 'ambiguous start anchor',
  'ambiguous end anchor', 'anchor order', 'text exceeds supported payload size',
  'media nesting', 'media count', 'media constraint', 'version/reason',
  'duplicate prohibition', 'action id', 'prohibited destination',
  'empty body source', 'post context', 'duplicate action id',
  'requirement nesting', 'unknown or repeated action reference', 'incomplete requirements',
]);
const PUBLICATION_CONTRACT_CODES = new Set([...PUBLICATION_CONTRACT_FAILURES]
  .map(detail => 'contract_' + detail.replace(/[^a-z0-9]+/g, '_')));
const EMPTY_OUTPUT_REASONS = new Set(['output_limit', 'reasoning_only', 'content_filter', 'provider_empty']);
const RECOVERY_STAGES = new Set([
  'model', 'inference', 'planning', 'plan_alignment', 'publication_audit',
  'completion_verification', 'verification', 'action_preparation',
  'response_generation', 'browser_interaction',
]);
const RECOVERY_RETRY_MODES = new Set(['resume', 'publication_without_audit', 'publication_audit_bypass', 'action_monitoring_relaxed']);
const CERTIFICATION_FAILURES = new Set(['owner_unresolved', 'identity_unobserved', 'capture_limit', 'identity_limit',
  'target_uncovered', 'context_uncertified']);
const ACTION_PREDICATES = new Set(['target_changed', 'target_unresolved', 'target_ambiguous', 'target_uncovered', 'focus_changed',
  'intervention_changed', 'model_snapshot_invalid', 'model_snapshot_expired', 'pending_feedback',
  'target_hidden', 'target_disabled', 'target_detached', 'parent_changed', 'form_changed',
  'relaxed_grant_expired', 'relaxed_target_changed', 'target_not_actionable', 'semantic_binding_changed',
  'target_hit_changed']);

// Visual observations have their own closed metadata protocol. Never feed
// their nested viewport/image objects through the generic note allowlist:
// those objects may also carry URLs, document IDs or screenshot bytes.
const VISION_PHASES = new Set([
  'vision_initial_capture', 'vision_after_action_capture', 'vision_requested_capture',
  'vision_completion_capture', 'vision_frame_encoding', 'vision_model',
  'vision_input', 'vision_privacy', 'vision_setup',
]);
const VISION_FRAME_REASONS = new Set([
  'initial', 'after-action', 'requested', 'completion-check', 'user-correction', 'privacy-setting-change', 'evidence-recovery',
  'initial-or-viewport-change', 'keyframe', 'full', 'delta', 'unchanged',
]);
const VISION_FAILURE_REASONS = new Set([
  'page_changed', 'viewport_changed', 'decode_failed', 'encode_failed', 'budget_exceeded',
  'privacy_scan_failed', 'capture_unavailable', 'cancelled', 'unknown',
]);
const VISION_FRAME_ID = /^vf-[a-z0-9]{1,16}-[1-9]\d{0,9}-[1-9]\d{0,9}$/;
const VISION_REVIEW_KINDS = new Set([
  'native_action', 'chat_authorization', 'chat_observe', 'chat_focus', 'chat_draft',
  'chat_delivery', 'upload_target', 'verify_form', 'extract_data', 'find_text',
  'dev_authorization', 'dev_patch', 'captcha_target', 'captcha_application',
]);
const VISION_REVIEW_CATEGORIES = new Set([
  'accepted', 'authorization_denied', 'evidence_unverified', 'chat_protocol_required',
  'draft_protected', 'invalid_verdict', 'context_changed',
]);
const VISION_REVIEW_FLAGS = [
  'verified', 'allowed', 'recipientMatches', 'composerMatches', 'atLatest',
  'delivered', 'newOutgoing', 'composerEmpty', 'completionVerified',
  'requiresChatProtocol', 'draftProtected', 'navigationOnly', 'authorMatches', 'audienceMatches',
];
const VISION_MISSING_EVIDENCE = new Set(['target', 'recipient', 'composer', 'send_control',
  'latest_context', 'author', 'audience', 'delivery', 'authorization', 'readable_pixels']);

function visionNumber(output, source, key, maximum, { integer = false, positive = false } = {}) {
  const value = source?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (positive && value === 0) || (integer && !Number.isSafeInteger(value))) return;
  output[key] = Math.min(value, maximum);
}

function visionDimensions(source) {
  const output = {};
  for (const key of ['width', 'height']) visionNumber(output, source, key, 65536, { positive: true });
  return output;
}

function projectVisionFrame(data) {
  const source = data?.extra || {}, extra = {};
  if (source.protocol === 'vision-frame-v1') extra.protocol = source.protocol;
  if (['full', 'delta', 'unchanged'].includes(source.kind)) extra.kind = source.kind;
  for (const key of ['frameId', 'baseFrameId', 'previousFrameId']) {
    if (typeof source[key] === 'string' && VISION_FRAME_ID.test(source[key])) extra[key] = source[key];
    else if (key === 'previousFrameId' && source[key] === null) extra[key] = null;
  }
  for (const key of ['canvas', 'source']) {
    const dimensions = visionDimensions(source[key]);
    if (Object.keys(dimensions).length) extra[key] = dimensions;
  }
  const viewport = visionDimensions(source.viewport);
  for (const key of ['devicePixelRatio', 'zoom', 'scale']) {
    visionNumber(viewport, source.viewport, key, 64, { positive: true });
  }
  if (Object.keys(viewport).length) extra.viewport = viewport;
  for (const key of ['bytes', 'estimatedTokens']) visionNumber(extra, source, key, 100_000_000, { integer: true });
  visionNumber(extra, source, 'capturedAt', 8_640_000_000_000_000, { integer: true });
  for (const key of ['captureMs', 'encodingMs', 'durationMs']) visionNumber(extra, source, key, 600_000);
  visionNumber(extra, source, 'attempt', 100, { integer: true, positive: true });
  const imageCount = Number.isSafeInteger(source.imageCount) ? source.imageCount
    : Array.isArray(source.images) ? source.images.length : undefined;
  visionNumber(extra, { imageCount }, 'imageCount', 64, { integer: true });
  if (VISION_FRAME_REASONS.has(source.reason)) extra.reason = source.reason;
  if (VISION_PHASES.has(source.phase)) extra.phase = source.phase;
  return { step: Number.isFinite(data?.step) ? data.step : 0, note: 'vision_frame', extra };
}

function projectVisionCaptureFailure(data) {
  const source = data?.extra || {}, extra = {};
  if (VISION_PHASES.has(source.phase)) extra.phase = source.phase;
  if (isErrorCode(source.code)) extra.code = source.code;
  if (VISION_FAILURE_REASONS.has(source.reason)) extra.reason = source.reason;
  visionNumber(extra, source, 'attempt', 100, { integer: true, positive: true });
  for (const key of ['captureMs', 'encodingMs', 'durationMs']) visionNumber(extra, source, key, 600_000);
  if (typeof source.retryable === 'boolean') extra.retryable = source.retryable;
  const diagnostics = projectVisionCaptureDiagnostics(source.captureDiagnostics);
  if (Object.keys(diagnostics).length) extra.captureDiagnostics = diagnostics;
  return { step: Number.isFinite(data?.step) ? data.step : 0, note: 'vision_capture_failure', extra };
}

function projectVisionEvidenceReview(data) {
  // Even opt-in content traces use this closed review record: free-form
  // reasons can quote private task/recipient text or screenshot contents.
  const source = data?.extra && typeof data.extra === 'object' && !Array.isArray(data.extra) ? data.extra : {};
  const extra = {};
  if (VISION_REVIEW_KINDS.has(source.kind)) extra.kind = source.kind;
  if (VISION_REVIEW_CATEGORIES.has(source.category)) extra.category = source.category;
  if (typeof source.frameId === 'string' && VISION_FRAME_ID.test(source.frameId)) extra.frameId = source.frameId;
  visionNumber(extra, source, 'durationMs', 600_000);
  for (const flag of VISION_REVIEW_FLAGS) {
    if (typeof source[flag] === 'boolean') extra[flag] = source[flag];
  }
  if (Array.isArray(source.missingEvidence) && source.missingEvidence.length <= 10
      && Array.from(source.missingEvidence).every(value => VISION_MISSING_EVIDENCE.has(value)))
    extra.missingEvidence = [...new Set(source.missingEvidence)];
  return { step: Number.isFinite(data?.step) ? data.step : 0, note: 'vision_evidence_review', extra };
}

function validationFailureMetadata(value) {
  if (VALIDATION_FAILURE_CODES.has(value) || PUBLICATION_CONTRACT_CODES.has(value)) return value;
  const prefix = 'Invalid publication contract: ';
  const detail = typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : '';
  return PUBLICATION_CONTRACT_FAILURES.has(detail)
    ? 'contract_' + detail.replace(/[^a-z0-9]+/g, '_')
    : 'invalid_response';
}

const CLICK_AX_TIMING_MS_FIELDS = [
  'preflightMs', 'syntheticDispatchMs', 'syntheticResponseMs',
  'postClickObservationMs', 'fallbackPreparationMs', 'fallbackDispatchMs',
  'trustedObservationMs', 'clickPathMs',
];

// Where a completion check spent its time: numbers and the verdict's own
// enums only, never what the page or the model said.
const DONE_TIMING_MS_FIELDS = ['preparationMs', 'readingMs', 'verificationMs'];
function projectDoneTiming(data) {
  const extra = {};
  for (const key of DONE_TIMING_MS_FIELDS) {
    const value = data?.extra?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) extra[key] = Math.min(value, 600_000);
  }
  const outcome = data?.extra?.outcome;
  if (['succeeded', 'pending', 'failed', 'uncertain'].includes(outcome)) extra.outcome = outcome;
  const engine = data?.extra?.engine;
  if (typeof engine === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(engine)) extra.engine = engine;
  return { step: Number.isFinite(data?.step) ? data.step : 0, note: 'done_timing', extra };
}

// Where one tool call spent its time before dispatch: the pipeline's stages
// in milliseconds, the tool's name and the call's outcome, never what the
// page or the model said.
const PREDISPATCH_TIMING_MS_FIELDS = [
  'argumentsMs', 'workflowAdoptMs', 'captchaGateMs', 'preparationMs', 'clarificationMs', 'submitPreflightMs',
  'submitProbeMs', 'submitCaptionReadingMs', 'resultBaselineMs', 'validationSnapshotMs',
  'workflowPreSubmitMs', 'resourceMutationMs', 'githubTransitionMs', 'workflowDispatchMs',
  'publicationContractMs', 'publicationAuditMs', 'publicationAuditReusedMs', 'publicationAuditAwaitedMs',
  'publicationRereadMs', 'submitDetectionMs', 'submitConfirmationMs', 'permissionMs', 'completionChecksMs',
  'recipientGuardMs', 'recipientReadingMs', 'checkpointMs', 'pipelineWaitMs', 'toolbarPreflightMs',
  'pipelinePublicationMs', 'feedbackRecheckMs', 'genericChatMs', 'attemptCheckpointMs',
  'dispatchPreparationMs', 'unverifiedStepCardMs', 'preDispatchMs', 'executeToolMs', 'stoppedMs', 'totalMs',
];
function projectPredispatchTiming(data) {
  const extra = {};
  for (const key of PREDISPATCH_TIMING_MS_FIELDS) {
    const value = data?.extra?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) extra[key] = Math.min(value, 600_000);
  }
  const tool = data?.extra?.tool;
  if (typeof tool === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(tool)) extra.tool = tool;
  const outcome = data?.extra?.outcome;
  if (['dispatched', 'not_dispatched', 'blocked'].includes(outcome)) extra.outcome = outcome;
  return { step: Number.isFinite(data?.step) ? data.step : 0, note: 'predispatch_timing', extra };
}

function projectClickAxTiming(data) {
  const extra = {};
  for (const key of CLICK_AX_TIMING_MS_FIELDS) {
    const value = data?.extra?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      extra[key] = Math.min(value, 120_000);
    }
  }
  const trustedInputEvents = data?.extra?.trustedInputEvents;
  if (Number.isSafeInteger(trustedInputEvents) && trustedInputEvents >= 0) {
    extra.trustedInputEvents = Math.min(trustedInputEvents, 16);
  }
  for (const key of ['syntheticDispatched', 'trustedFallbackAttempted', 'outcomeUnknown', 'safetyVeto', 'duplicateFallbackBlocked']) {
    if (typeof data?.extra?.[key] === 'boolean') extra[key] = data.extra[key];
  }
  const outcome = data?.extra?.outcome;
  if (['verified', 'inconclusive', 'no_progress', 'failed', 'pre_dispatch', 'unknown'].includes(outcome)) {
    extra.outcome = outcome;
  }
  return {
    step: Number.isFinite(data?.step) ? data.step : 0,
    note: 'click_ax_timing',
    extra,
  };
}

function pick(source, fields) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const output = {};
  for (const field of fields) {
    if (source[field] !== undefined) output[field] = source[field];
  }
  return output;
}

function projectUsage(usage) {
  return pick(usage, [
    'prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens',
    'cached_tokens', 'prompt_cache_hit_tokens', 'cost',
  ]);
}

function projectPromptProvenance(value) {
  return pick(value, [
    'systemPromptVariant', 'promptPolicyRevision', 'systemPromptChars',
    'messageChars', 'toolPolicyRevision', 'runtimeEnvelopeMode',
    'runtimeEnvelopeRequired', 'runtimeEnvelopeMatches',
    'systemPromptMatchesRuntime',
  ]);
}

function projectNoteExtra(value) {
  const output = pick(value, NOTE_METADATA_FIELDS);
  if (Object.hasOwn(output, 'validationFailure')) {
    output.validationFailure = validationFailureMetadata(output.validationFailure);
  }
  if (Object.hasOwn(output, 'stage')) output.stage = RECOVERY_STAGES.has(output.stage) ? output.stage : 'model';
  if (Object.hasOwn(output, 'retryMode')) {
    output.retryMode = RECOVERY_RETRY_MODES.has(output.retryMode) ? output.retryMode : 'resume';
  }
  if (Object.hasOwn(output, 'certificationFailure') && !CERTIFICATION_FAILURES.has(output.certificationFailure)) delete output.certificationFailure;
  if (Object.hasOwn(output, 'predicate') && !ACTION_PREDICATES.has(output.predicate)) delete output.predicate;
  for (const key of ['monitoringRelaxed', 'focusedTargetAvailable']) {
    if (Object.hasOwn(output, key) && typeof output[key] !== 'boolean') delete output[key];
  }
  for (const key of ['targetCount', 'captureMs']) {
    if (Object.hasOwn(output, key)) {
      if (typeof output[key] !== 'number' || !Number.isFinite(output[key]) || output[key] < 0) delete output[key];
      else output[key] = Math.min(key === 'targetCount' ? 512 : 120000, output[key]);
    }
  }
  if (Object.hasOwn(output, 'candidateAttempt') && !Number.isSafeInteger(output.candidateAttempt)) {
    delete output.candidateAttempt;
  }
  if (Array.isArray(output.archiveDates)) {
    output.archiveDates = output.archiveDates.slice(0, 3).map(item => String(item).slice(0, 20));
  }
  return output;
}

function projectToolResultMetadata(result) {
  if (result == null) return { resultStatus: 'unknown' };
  const failed = typeof result === 'object'
    && (result.success === false || Boolean(result.error));
  const output = { resultStatus: failed ? 'error' : 'success' };
  const errorCode = result && typeof result === 'object'
    ? (result.errorCode || result.code)
    : '';
  if (failed && errorCode != null && String(errorCode).trim()) {
    output.resultErrorCode = String(errorCode).trim().slice(0, 120);
  }
  return output;
}

export function projectTraceRun(run, { includeContent = false } = {}) {
  const projected = run && typeof run === 'object' ? { ...run } : {};
  if (!includeContent) {
    for (const field of RUN_CONTENT_FIELDS) delete projected[field];
  }
  return projected;
}

export function projectTraceEventData(kind, data, { includeContent = false } = {}) {
  if (kind === 'llm_response' && data?.rejectedToolResponse) {
    data = { ...data, rejectedToolResponse: normalizeRejectedToolResponse(data.rejectedToolResponse) };
  }
  // Auxiliary decisions never retain evidence, even in the opt-in content tier.
  if (kind === 'note' && data?.note === 'system_one') {
    const extra = {};
    for (const key of ['decision', 'reason', 'model', 'phase', 'engine', 'modality', 'outcome']) {
      const value = data.extra?.[key];
      if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(value)) extra[key] = value;
    }
    for (const key of ['latencyMs', 'estimatedCostUsd', 'captureMs', 'evaluateMs', 'elapsedMs']) {
      const value = data.extra?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) extra[key] = value;
    }
    const usage = projectUsage(data.extra?.usage);
    for (const key of Object.keys(usage)) {
      if (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || usage[key] < 0) delete usage[key];
    }
    if (Object.keys(usage).length) extra.usage = usage;
    return { step: Number.isFinite(data.step) ? data.step : 0, note: 'system_one', extra };
  }
  if (kind === 'note' && data?.note === 'click_ax_timing') {
    return projectClickAxTiming(data);
  }
  if (kind === 'note' && data?.note === 'done_timing') {
    return projectDoneTiming(data);
  }
  if (kind === 'note' && data?.note === 'predispatch_timing') {
    return projectPredispatchTiming(data);
  }
  if (kind === 'note' && data?.note === 'vision_frame') return projectVisionFrame(data);
  if (kind === 'note' && data?.note === 'vision_capture_failure') return projectVisionCaptureFailure(data);
  if (kind === 'note' && data?.note === 'vision_evidence_review') return projectVisionEvidenceReview(data);
  if (includeContent || data == null) return data;
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  if (kind === 'llm_request') {
    const projected = pick(source, REQUEST_METADATA_FIELDS);
    if (Object.hasOwn(projected, 'requestedMaxTokens')
        && (!Number.isSafeInteger(projected.requestedMaxTokens) || projected.requestedMaxTokens < 1)) {
      delete projected.requestedMaxTokens;
    }
    if (source.promptProvenance && typeof source.promptProvenance === 'object') {
      projected.promptProvenance = projectPromptProvenance(source.promptProvenance);
    }
    if (source.localWikipediaRag && typeof source.localWikipediaRag === 'object') {
      projected.localWikipediaRag = pick(source.localWikipediaRag, [
        'status', 'attempted', 'matchCount', 'multiSource', 'archiveDates',
      ]);
    }
    return projected;
  }

  if (kind === 'llm_response') {
    const projected = pick(source, RESPONSE_METADATA_FIELDS);
    if (Object.hasOwn(projected, 'requestedMaxTokens')
        && (!Number.isSafeInteger(projected.requestedMaxTokens) || projected.requestedMaxTokens < 1)) {
      delete projected.requestedMaxTokens;
    }
    if (Object.hasOwn(projected, 'emptyReason') && !EMPTY_OUTPUT_REASONS.has(projected.emptyReason)) {
      delete projected.emptyReason;
    }
    if (Object.hasOwn(projected, 'validationFailure')) {
      projected.validationFailure = validationFailureMetadata(projected.validationFailure);
    }
    if (Object.hasOwn(projected, 'candidateAttempt') && !Number.isSafeInteger(projected.candidateAttempt)) {
      delete projected.candidateAttempt;
    }
    if (source.rejectedToolResponse) projected.rejectedToolResponse = source.rejectedToolResponse;
    if (source.usage && typeof source.usage === 'object') projected.usage = projectUsage(source.usage);
    return projected;
  }

  if (kind === 'tool') {
    return {
      ...pick(source, ['step', 'name', 'latencyMs']),
      ...(source.batch && typeof source.batch.parentId === 'string'
        && /^[a-zA-Z0-9_-]{1,200}$/.test(source.batch.parentId)
        && Number.isInteger(source.batch.index) && source.batch.index >= 0
        && Number.isInteger(source.batch.total) && source.batch.total > source.batch.index && source.batch.total <= 10
        ? { batch: pick(source.batch, ['parentId', 'index', 'total']) } : {}),
      ...projectToolResultMetadata(source.result),
    };
  }
  if (kind === 'error') return pick(source, ['step', 'phase', 'code']);
  if (kind === 'streaming') return pick(source, STREAMING_METADATA_FIELDS);
  if (kind === 'note') {
    const projected = pick(source, ['step', 'note']);
    const extra = projectNoteExtra(source.extra);
    if (Object.keys(extra).length) projected.extra = extra;
    return projected;
  }
  if (kind === 'screenshot') return pick(source, ['step', 'caption']);
  if (kind === 'vision_sub_call') {
    return pick(source, [
      'step', 'context', 'visionRoute', 'captureId', 'fallbackReason', 'model',
      'baseUrl', 'latencyMs', 'errorCode', 'recoveryOutcome',
    ]);
  }
  if (kind === 'vision_route') {
    return pick(source, ['step', 'context', 'visionRoute', 'captureId', 'model', 'fallbackReason']);
  }
  if (kind === 'turn_start' || kind === 'turn_end' || kind === 'step_start' || kind === 'step_end') {
    const projected = pick(source, STEP_METADATA_FIELDS);
    if (VISION_PHASES.has(source.phase)) projected.phase = source.phase;
    return projected;
  }
  if (kind === 'terminal_runtime') {
    return pick(source, ['step', 'status', 'toolName', 'callId', 'errorCode', 'durationMs', 'success']);
  }
  return {};
}
