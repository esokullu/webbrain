// Durable semantic receipts contain no screenshots, selectors or file bytes.
// Local storage survives a scheduled continuation and a service-worker restart.
const api = () => globalThis.browser || globalThis.chrome;
export async function loadVisionRuntimeState(agent, tabId) {
  const conversationId = agent.conversationIds?.get(tabId);
  const key = `webbrain.vision.receipts.v1:${conversationId || `tab-${tabId}`}`;
  const stored = (await api().storage.local.get(key))[key];
  if (stored != null && (stored.schema !== 'vision-runtime-v1'
      || !stored.files || !stored.captcha || !Array.isArray(stored.groups)))
    throw new Error('The saved visual operation ledger is damaged; no action can safely be repeated.');
  const state = stored || { schema: 'vision-runtime-v1', files: { operations: {} }, captcha: { attempts: {} }, groups: [] };
  return { state, async save() {
    if (JSON.stringify(state).length > 750000) throw new Error('The visual operation ledger is full. Pending operation receipts cannot be discarded.');
    await api().storage.local.set({ [key]: state });
    return { ok: true };
  } };
}

export function trustedVisionTask(messages, agent) {
  // Only genuine user turns authorize actions. Scheduler instructions are
  // model-authored hints, and attachment/page text is never user authority.
  const genuine = (messages || []).filter(message => !message.webbrainAppOwnedKind).flatMap(message => {
    if (message.role !== 'user') return [message];
    if (agent?._isScheduledResumeTurn?.(message)
        || typeof message.webbrainUserAuthoredText !== 'string' && /^\s*\[Scheduled resume/.test(String(message.content || ''))) return [];
    const original = message.webbrainVisionUserText ?? message.webbrainUserAuthoredText
      ?? agent?._plannerUserAuthoredText?.(message) ?? (typeof message.content === 'string' ? message.content : '');
    return typeof original === 'string' && original.trim() ? [{ ...message, content: original }] : [];
  });
  if (typeof agent?._plannerAuthenticTaskText === 'function') {
    return String(agent._plannerAuthenticTaskText(genuine) || '').slice(-24000);
  }
  // Minimal embedders have no task-binding helper. Retain only the latest
  // request plus explicit continuation replies, never all prior tasks.
  const users = genuine.filter(message => message.role === 'user');
  let root = users.length - 1;
  while (root > 0 && ['continue', 'acknowledge'].includes(users[root].webbrainTurnKind)) root--;
  return users.slice(Math.max(0, root)).map(message => message.content).join('\n\n').slice(-24000);
}
export function visionTaskScope(task) {
  // An authorization scope, not a security hash. Exact recipient/body and live
  // pixels are checked separately before every consequential semantic action.
  let hash = 2166136261;
  for (const char of String(task)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `task-${(hash >>> 0).toString(16)}`;
}
