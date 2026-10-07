import {
  getFeedbackDraft, listFeedbackDrafts, putFeedbackDraft, updateFeedbackDraft, deleteFeedbackDraft,
  sweepFeedbackDrafts, FEEDBACK_TTL_MS, FEEDBACK_CHUNK_BYTES,
} from './feedback-store.js';
import { buildFeedbackBody, FEEDBACK_ISSUES_URL } from './ui/store-review-prompt.js';
import { flushPendingWrites, pruneFeedbackDiagnostics } from './trace/recorder.js';

export function isFeedbackDestination(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://github.com'
      && parsed.pathname === '/webbrain-one/webbrain/issues/new';
  } catch { return false; }
}

export function mayReadFeedbackDraft(draft, sender, tabUrl, now = Date.now()) {
  return Boolean(draft && draft.authorized && draft.expiresAt > now
    && sender?.frameId === 0 && sender.tab?.id === draft.destinationTabId
    && isFeedbackDestination(sender.url) && isFeedbackDestination(tabUrl));
}

export function createFeedbackHandoff(api) {
  const inflight = new Set();
  const panelUrl = api.runtime.getURL('src/ui/sidepanel.html');
  const settingsUrl = api.runtime.getURL('src/ui/settings.html');
  const isPanel = sender => sender?.id === api.runtime.id
    && sender.url?.split(/[?#]/)[0] === panelUrl;
  async function cleanup() {
    const settings = await api.storage.local.get('feedbackDiagnosticsEnabled');
    await Promise.all([
      sweepFeedbackDrafts(),
      pruneFeedbackDiagnostics({ clear: settings.feedbackDiagnosticsEnabled === false }),
    ]);
  }
  const storeReady = cleanup().catch(() => {});

  async function inject(tabId) {
    await storeReady;
    if (inflight.has(tabId)) return;
    const tab = await api.tabs.get(tabId);
    if (!isFeedbackDestination(tab.url)) return;
    const draft = (await listFeedbackDrafts()).find(row => row.destinationTabId === tabId && row.authorized && row.expiresAt > Date.now());
    if (!draft) return;
    inflight.add(tabId);
    try {
      if (api.scripting?.executeScript) await api.scripting.executeScript({
        target: { tabId, frameIds: [0] }, files: ['src/content/feedback-attachment.js'],
      });
      else await api.tabs.executeScript(tabId, { file: 'src/content/feedback-attachment.js', frameId: 0 });
    } finally { inflight.delete(tabId); }
  }

  api.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'complete') void inject(tabId).catch(() => {});
  });
  api.tabs.onRemoved.addListener(tabId => { void sweepFeedbackDrafts({ tabId }).catch(() => {}); });
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'feedback-draft-cleanup') void cleanup().catch(() => {});
  });
  api.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.feedbackDiagnosticsEnabled?.newValue === false) {
      void pruneFeedbackDiagnostics({ clear: true }).catch(() => {});
    }
  });
  api.alarms.create('feedback-draft-cleanup', { periodInMinutes: 5 });
  // A worker may have restarted after the document loaded, without an update event.
  void storeReady.then(async () => {
    for (const draft of await listFeedbackDrafts()) {
      if (draft.destinationTabId !== null) void inject(draft.destinationTabId).catch(() => {});
    }
  }).catch(() => {});

  return {
    async handle(msg, sender) {
      await storeReady;
      if (msg.action === 'feedback_flush') {
        if (!isPanel(sender)) throw new Error('Chat panel only.');
        await flushPendingWrites();
        return { ok: true };
      }
      if (msg.action === 'feedback_clear_diagnostics') {
        if (sender?.id !== api.runtime.id || sender.url?.split(/[?#]/)[0] !== settingsUrl) throw new Error('Settings only.');
        await pruneFeedbackDiagnostics({ clear: true });
        return { ok: true };
      }
      if (msg.action === 'feedback_open') {
        if (!isPanel(sender)) throw new Error('Feedback can only be sent from the chat panel.');
        const rating = Math.max(1, Math.min(5, Math.round(Number(msg.rating) || 3)));
        const body = buildFeedbackBody({ rating, comment: msg.comment, traceNote: msg.traceNote });
        let draft = msg.includeTrace ? await getFeedbackDraft(String(msg.id || '')) : null;
        if (msg.includeTrace && (!draft?.blob || draft.expiresAt <= Date.now()
          || draft.status !== 'prepared')) throw new Error('Prepare and review the trace again before uploading.');
        // The dedicated action from the consent button authorizes these staged,
        // immutable bytes; page content cannot call this extension-page route.
        draft = draft || {
          id: crypto.randomUUID(), token: crypto.randomUUID(),
          createdAt: Date.now(), expiresAt: Date.now() + FEEDBACK_TTL_MS,
        };
        draft = { ...draft, body, initialBody: `**Rating:** ${rating}/5`,
          authorized: true, consentAt: msg.includeTrace ? Date.now() : null,
          status: 'pending', copy: msg.copy || {}, includeTrace: msg.includeTrace === true };
        if (encodeURIComponent(body).length < 6000) draft.initialBody = body;
        let tab;
        try {
          tab = await api.tabs.create({ url: 'about:blank' });
          draft.destinationTabId = tab.id;
          await putFeedbackDraft(draft);
          const url = new URL(FEEDBACK_ISSUES_URL);
          url.searchParams.set('title', `WebBrain feedback (${rating}/5)`);
          url.searchParams.set('body', draft.initialBody);
          await api.tabs.update(tab.id, { url: url.href });
          return { ok: true, tabId: tab.id };
        } catch (error) {
          await deleteFeedbackDraft(draft.id);
          if (tab) await api.tabs.remove(tab.id).catch(() => {});
          throw error;
        }
      }
      const draft = msg.action === 'feedback_claim'
        ? (await listFeedbackDrafts()).find(row => row.destinationTabId === sender?.tab?.id)
        : await getFeedbackDraft(String(msg.id || ''));
      const tab = sender?.tab ? await api.tabs.get(sender.tab.id) : null;
      if (sender?.id !== api.runtime.id || !mayReadFeedbackDraft(draft, sender, tab?.url)
        || (msg.action !== 'feedback_claim' && msg.token !== draft.token)) throw new Error('Unauthorized feedback handoff.');
      if (msg.action === 'feedback_claim') return {
        ok: true, id: draft.id, token: draft.token, body: draft.body, initialBody: draft.initialBody,
        filename: draft.filename, size: draft.blob?.size || 0, mimeType: draft.blob?.type,
        status: draft.status, includeTrace: draft.includeTrace, chunkBytes: FEEDBACK_CHUNK_BYTES,
        copy: draft.copy || {},
      };
      if (msg.action === 'feedback_preview') {
        if (!draft.includeTrace) throw new Error('No trace was selected.');
        await api.tabs.create({ url: api.runtime.getURL(`src/ui/feedback-trace-preview.html?id=${encodeURIComponent(draft.id)}`) });
        return { ok: true };
      }
      if (msg.action === 'feedback_chunk') {
        if (!draft.includeTrace || !Number.isSafeInteger(msg.offset) || msg.offset < 0 || msg.offset >= draft.blob.size) throw new Error('Invalid feedback chunk.');
        const bytes = new Uint8Array(await draft.blob.slice(msg.offset, msg.offset + FEEDBACK_CHUNK_BYTES).arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return { ok: true, base64: btoa(binary) };
      }
      if (msg.action === 'feedback_upload_started') {
        await updateFeedbackDraft(draft.id, current => {
          if (!current?.includeTrace || !['pending', 'failed'].includes(current.status)) throw new Error('Attachment already dispatched.');
          return { ...current, status: 'uploading' };
        });
        return { ok: true };
      }
      if (msg.action === 'feedback_retry') {
        if (!draft.includeTrace || !['failed', 'uploading'].includes(draft.status)) throw new Error('No failed attachment to retry.');
        await putFeedbackDraft({ ...draft, status: 'failed' });
        return { ok: true };
      }
      if (msg.action === 'feedback_result') {
        if (msg.success === true) await deleteFeedbackDraft(draft.id);
        else await putFeedbackDraft({ ...draft, status: 'failed' });
        return { ok: true };
      }
      throw new Error('Unknown feedback action.');
    },
  };
}
