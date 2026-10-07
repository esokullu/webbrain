export const FEEDBACK_TTL_MS = 60 * 60 * 1000;
export const FEEDBACK_CHUNK_BYTES = 128 * 1024;
let database;

function openDB() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('webbrain_feedback', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}

async function operation(mode, action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', mode);
    const request = action(transaction.objectStore('drafts'));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Feedback storage aborted.'));
  });
}

export const getFeedbackDraft = id => operation('readonly', store => store.get(id));
export const listFeedbackDrafts = () => operation('readonly', store => store.getAll());
export const putFeedbackDraft = draft => operation('readwrite', store => store.put(draft));
export const deleteFeedbackDraft = id => operation('readwrite', store => store.delete(id));

// A single transaction prevents two restarted/injected helpers from both
// dispatching the same attachment after reading a pending state.
export async function updateFeedbackDraft(id, update) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    const store = transaction.objectStore('drafts');
    const request = store.get(id);
    let updated;
    request.onsuccess = () => {
      try { updated = update(request.result); if (updated) store.put(updated); }
      catch (error) { reject(error); transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(updated);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Feedback update aborted.'));
  });
}

export async function stageFeedbackTrace(prepared) {
  const draft = {
    ...prepared, preview: undefined,
    id: crypto.randomUUID(), token: crypto.randomUUID(),
    createdAt: Date.now(), expiresAt: Date.now() + FEEDBACK_TTL_MS,
    authorized: false, status: 'prepared', destinationTabId: null,
  };
  await putFeedbackDraft(draft);
  return draft;
}

export async function sweepFeedbackDrafts({ now = Date.now(), tabId = null } = {}) {
  for (const draft of await listFeedbackDrafts()) {
    if (draft.expiresAt <= now || (tabId !== null && draft.destinationTabId === tabId)) await deleteFeedbackDraft(draft.id);
  }
}
