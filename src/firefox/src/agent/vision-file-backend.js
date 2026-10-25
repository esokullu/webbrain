import { firefoxBidi } from '../bidi/client.js';

function owner(tabId) {
  const current = firefoxBidi.runs.get(tabId);
  if (!current?.bound || current.disconnected || current.signal?.aborted)
    throw new Error('Visual file operations require the current Firefox trusted automation companion');
  return current;
}
export async function readVisionSavedDownload(tabId, item, options = {}) {
  options.signal?.throwIfAborted();
  const run = owner(tabId);
  const result = await firefoxBidi.request('visionReadSavedDownload', { runId: run.runId,
    download: { id: item.id, filename: item.filename, state: item.state, exists: item.exists, fileSize: item.fileSize, mime: item.mime },
    options: { maxBytes: options.maxBytes, readPrefixBytes: options.readPrefixBytes } });
  options.signal?.throwIfAborted();
  if (owner(tabId) !== run) throw new Error('The Firefox file-reading task changed');
  return result;
}
export function createVisionFileBackend() {
  const request = (tabId, command, args) => firefoxBidi.request(command, { runId: owner(tabId).runId, ...args });
  return {
    readSavedDownload: readVisionSavedDownload,
    async armChooser(tabId, point) {
      const runId = owner(tabId).runId;
      return { ...await firefoxBidi.request('visionFileChooserArm', { runId, point }), runId };
    },
    async takeChooser(tabId, chooser) {
      return { ...await request(tabId, 'visionFileChooserTake', { token: chooser.token }), runId: chooser.runId };
    },
    closeChooser: (_tabId, chooser) => firefoxBidi.request('visionFileChooserClose', { runId: chooser.runId, token: chooser.token }),
    // Cleanup uses the captured owner even after Stop invalidates input access.
    releaseChooser: (_tabId, chooser) => firefoxBidi.request('visionFileChooserClose', { runId: chooser.runId, token: chooser.token, release: true }),
    async bind(tabId, point, kind) {
      const runId = owner(tabId).runId;
      const result = await firefoxBidi.request('visionFileBind', { runId, point, kind });
      return result ? { ...result, runId } : null;
    },
    assertTarget: (tabId, target) => request(tabId, 'visionFileAssert', { token: target.token }),
    async upload(tabId, target, source, { signal, beforeDispatch, viewport }) {
      signal?.throwIfAborted();
      beforeDispatch();
      return request(tabId, 'visionFileUpload', { token: target.token, source, viewport });
    },
    uploadedFiles: (tabId, target) => request(tabId, 'visionFileReadback', { token: target.token }),
    readBlob: (tabId, target, maxBytes) => request(tabId, 'visionFileBlob', { token: target.token, maxBytes }),
    async release(tabId, target) {
      if (target?.token) await firefoxBidi.request('visionFileRelease', { runId: target.runId, token: target.token }).catch(() => {});
    },
  };
}
