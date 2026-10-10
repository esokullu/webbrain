const OUTPUT_LIMIT_RE = /(?:^|[_\s-])(?:length|max(?:imum)?(?:[_\s-]*(?:output|completion))?[_\s-]*tokens?|output[_\s-]*limit|token[_\s-]*limit)(?:$|[_\s-])/i;
const CONTENT_FILTER_RE = /content[_\s-]*filter|safety|blocked|refusal/i;

function finiteNonNegative(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
  }
  return null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function finishReasonFor(result) {
  const raw = result?.raw || {};
  return String(
    result?.finishReason
      ?? result?.finish_reason
      ?? result?.stopReason
      ?? result?.stop_reason
      ?? raw?.choices?.[0]?.finish_reason
      ?? raw?.finish_reason
      ?? raw?.stopReason
      ?? raw?.stop_reason
      ?? '',
  ).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}

function usageFor(result) {
  return result?.usage && typeof result.usage === 'object'
    ? result.usage
    : (result?.raw?.usage && typeof result.raw.usage === 'object' ? result.raw.usage : {});
}

function responseHasReasoningItem(result) {
  const items = Array.isArray(result?.responseItems)
    ? result.responseItems
    : (Array.isArray(result?.raw?.output) ? result.raw.output : []);
  return items.some((item) => {
    if (item?.type === 'reasoning') return true;
    if (item?.type !== 'webbrain_provider_replay' || !Array.isArray(item.content)) return false;
    return item.content.some(block => block?.type === 'thinking' || block?.type === 'redacted_thinking');
  });
}

export function normalizeRejectedToolResponse(value) {
  if (value?.provider !== 'demonroute_qwen'
    || !['xml_name_args', 'json_envelope', 'function_parameters', 'other_xml'].includes(value.format)
    || !['oversized', 'incomplete_response', 'mixed_content', 'invalid_envelope'].includes(value.reason)
    || !['named', 'auto', 'required', 'unspecified'].includes(value.choice)) return null;
  const output = { provider: 'demonroute_qwen', format: value.format, reason: value.reason, choice: value.choice };
  for (const key of ['contentChars', 'offeredTools']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) output[key] = value[key];
  }
  return output;
}

export function modelOutputDiagnostics(result, { requestedMaxTokens = null, recoveryAttempt = 0 } = {}) {
  const rejectedToolResponse = normalizeRejectedToolResponse(result?.rejectedToolResponse);
  const contentChars = typeof result?.content === 'string' ? result.content.trim().length : 0;
  const toolCallCount = Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0;
  const reasoningChars = typeof result?.reasoningContent === 'string' ? result.reasoningContent.length : 0;
  const usage = usageFor(result);
  const reasoningTokens = finiteNonNegative(
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.output_tokens_details?.reasoning_tokens,
    usage?.reasoning_tokens,
  );
  const outputTokens = finiteNonNegative(
    usage?.completion_tokens,
    usage?.output_tokens,
    usage?.completionTokens,
    usage?.outputTokens,
  );
  const normalizedMaxTokens = finitePositive(requestedMaxTokens);
  const finishReason = finishReasonFor(result);
  const reasoningPresent = reasoningChars > 0
    || (reasoningTokens != null && reasoningTokens > 0)
    || responseHasReasoningItem(result);
  const empty = contentChars === 0 && toolCallCount === 0;
  let emptyReason = null;

  if (empty) {
    if (CONTENT_FILTER_RE.test(finishReason)) {
      emptyReason = 'content_filter';
    } else if (
      OUTPUT_LIMIT_RE.test(` ${finishReason} `)
      || (normalizedMaxTokens != null && outputTokens != null && outputTokens >= normalizedMaxTokens)
    ) {
      emptyReason = 'output_limit';
    } else if (reasoningPresent) {
      emptyReason = 'reasoning_only';
    } else {
      emptyReason = 'provider_empty';
    }
  }

  return {
    ...(rejectedToolResponse ? { rejectedToolResponse } : {}),
    empty,
    emptyReason,
    finishReason: finishReason || null,
    contentChars,
    toolCallCount,
    reasoningPresent,
    reasoningChars,
    reasoningTokens,
    outputTokens,
    requestedMaxTokens: normalizedMaxTokens,
    recoveryAttempt: Number.isInteger(recoveryAttempt) && recoveryAttempt > 0 ? recoveryAttempt : 0,
  };
}

export function emptyOutputFailureMessage(diagnostics = {}) {
  switch (diagnostics.emptyReason) {
    case 'output_limit':
      return '[The model reached its configured response-token limit without producing visible text or a tool call, even after a recovery nudge. Reduce reasoning effort or choose another model/provider.]';
    case 'reasoning_only':
      return '[The latest model response contained reasoning but no visible answer or tool call after the earlier empty response. Reduce reasoning effort or choose another model/provider.]';
    case 'content_filter':
      return '[The provider filtered the latest response after an earlier empty response, so no visible text or tool call was returned. Revise the request or try another provider.]';
    default:
      return '[The provider returned an empty completion with no visible text or tool call twice. Retry later or choose another model/provider.]';
  }
}
