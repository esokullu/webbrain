/**
 * Build compact step rows from the trace event log.
 *
 * The Traces UI owns presentation; this browser-neutral module owns the
 * durable event-to-step interpretation so Chrome, Firefox, and tests share
 * one lifecycle contract. Missing lifecycle events remain `unknown` rather
 * than being guessed from a response payload.
 */

const MAX_TOOL_NAMES = 8;
const MAX_ERRORS = 8;

function eventStep(event) {
  if (event?.kind === 'turn_start' || event?.kind === 'turn_end') return null;
  return Number.isInteger(event?.data?.step) ? event.data.step : null;
}

function eventTime(event) {
  const value = Number(event?.ts);
  return Number.isFinite(value) ? value : null;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function ensureRow(rows, step) {
  if (!rows.has(step)) {
    rows.set(step, {
      step,
      status: 'unknown',
      startedAt: null,
      endedAt: null,
      durationMs: null,
      requestCount: 0,
      responseCount: 0,
      toolCount: 0,
      subCallCount: 0,
      errorCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      llmLatencyMs: 0,
      toolLatencyMs: 0,
      toolNames: [],
      errorCodes: [],
      errors: [],
      repaired: false,
    });
  }
  return rows.get(step);
}

function addUnique(list, value, limit) {
  if (!value || list.includes(value) || list.length >= limit) return;
  list.push(value);
}

function addError(row, data) {
  row.errorCount += 1;
  addUnique(row.errorCodes, data?.code, MAX_ERRORS);
  if (row.errors.length < MAX_ERRORS) {
    row.errors.push({
      code: data?.code || null,
      phase: data?.phase || null,
      message: data?.message || '',
    });
  }
  row.status = 'error';
}

// Only failure-shaped end payloads mark the row as errored. Every other end
// payload closes its row as done because a recorded end event terminates the
// step/run by definition; the agent emits terminal statuses that are not
// enumerated here (scheduled_resume, read_scope_limited,
// clarification_required, delivery-recovery fallbacks), and listing them
// would only drift out of sync with agent.js.
const FAILED_END_STATUSES = [
  'error', 'loop_stopped', 'max_steps', 'cancelled', 'cost_limit',
  'plan_only_output', 'incomplete_output', 'empty_output',
  'placeholder_output', 'required_tool_missing', 'grounding_unavailable',
  'captcha_manual_required',
];

function markEnd(row, data) {
  const failed = data?.ok === false || FAILED_END_STATUSES.includes(data?.status);
  if (failed) row.status = 'error';
  else if (row.status !== 'error') row.status = 'done';
  if (typeof data?.handoffOutcome === 'string' && data.handoffOutcome) {
    row.handoffOutcome = data.handoffOutcome;
  }
  if (data?.code && failed) addUnique(row.errorCodes, data.code, MAX_ERRORS);
  if (data?.repaired === true) row.repaired = true;
}

function finalizeRow(row) {
  if (row.startedAt != null && row.endedAt != null) {
    row.durationMs = Math.max(0, row.endedAt - row.startedAt);
  }
  return row;
}

export function buildTraceTrajectory(events) {
  const rows = new Map();
  const orderedEvents = (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event)
    .sort((a, b) => {
      const aSeq = Number(a.event.seq);
      const bSeq = Number(b.event.seq);
      if (Number.isFinite(aSeq) && Number.isFinite(bSeq)) return aSeq - bSeq;
      if (Number.isFinite(aSeq)) return -1;
      if (Number.isFinite(bSeq)) return 1;
      return a.index - b.index;
    });

  for (const { event } of orderedEvents) {
    const row = ensureRow(rows, eventStep(event));
    const ts = eventTime(event);
    if (event.kind === 'step_start' || event.kind === 'turn_start') {
      if (row.startedAt == null && ts != null) row.startedAt = ts;
      if (row.status === 'unknown') row.status = 'running';
    }
    if (event.kind === 'step_end' || event.kind === 'turn_end') {
      if (ts != null) row.endedAt = ts;
      markEnd(row, event.data);
    }
    if (event.kind === 'llm_request') row.requestCount += 1;
    if (event.kind === 'llm_response') {
      row.responseCount += 1;
      const usage = event.data?.usage;
      row.inputTokens += numeric(usage?.prompt_tokens);
      row.outputTokens += numeric(usage?.completion_tokens);
      row.cost += numeric(usage?.cost);
      row.llmLatencyMs += Math.max(0, numeric(event.data?.latencyMs));
    }
    if (event.kind === 'tool') {
      row.toolCount += 1;
      row.toolLatencyMs += Math.max(0, numeric(event.data?.latencyMs));
      addUnique(row.toolNames, event.data?.name, MAX_TOOL_NAMES);
    }
    if (event.kind === 'vision_sub_call') row.subCallCount += 1;
    if (event.kind === 'error') addError(row, event.data);
    if (event.data?.repaired === true) row.repaired = true;
  }

  return [...rows.values()].map(finalizeRow);
}
