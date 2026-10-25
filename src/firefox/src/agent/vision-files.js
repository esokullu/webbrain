import { createVisionFileBackend } from './vision-file-backend.js';
import { authorizeVisionCapability, downloadVisionFiles } from './vision-capabilities.js';
import { filenameInConfiguredDownloadDirectory } from '../download-directory.js';
import { executeHttpSkillTool } from '../network/network-tools.js';
import { isDirectPublicMediaUrl } from './public-media-url.js';
import '../content/file-upload-policy.js';

const { validateUploadFile, observedFileViewerResource } = globalThis.__wbFileUploadPolicy;
const api = () => globalThis.browser || globalThis.chrome;
const MAX_BYTES = 25 * 1024 * 1024;
const point = { frameId: { type: 'string', maxLength: 160 }, x: { type: 'number' }, y: { type: 'number' },
  imageId: { type: 'string', maxLength: 160 } };
export const VISION_FILE_TOOLS = [
  { type: 'function', function: { name: 'upload_file',
    description: 'Attach the exact current user attachment or completed browser download to the file input, label or custom upload button at screenshot coordinates. A custom button gets one guarded native click and a fresh independent visual review. No selector, local path, or source refetch. This confirms local attachment only; remote upload/submit requires visible verification. Do not repeat an uncertain or consumed attachment.',
    parameters: { type: 'object', additionalProperties: false, properties: { ...point,
      attachmentId: { type: 'string', maxLength: 200 }, downloadId: { type: 'integer', minimum: 0 } }, required: ['frameId', 'x', 'y'] } } },
  ...['download_resource_from_page', 'download_social_media'].map(name => ({ type: 'function', function: { name,
    description: 'Save the original resource bytes of one visible image/video/audio/link at current screenshot coordinates. Keeps download permissions, completion receipts and saved-file IDs. Never substitutes a screenshot crop or records a video. Select each intended item separately; unsupported streaming/DRM media reports a limitation.',
    parameters: { type: 'object', additionalProperties: false, properties: { ...point,
      filename: { type: 'string', maxLength: 240 } }, required: ['frameId', 'x', 'y'] } } })),
];
export const VISION_FILE_TOOL_NAMES = new Set(VISION_FILE_TOOLS.map(tool => tool.function.name));
const failure = (message, code = 'vision_file_failed') => Object.assign(new Error(message), { code });
const identity = item => JSON.stringify([item.id, item.state, item.exists, item.filename, item.url, item.finalUrl, item.fileSize, item.mime]);
const basename = name => String(name || '').split(/[\\/]/).pop();
function selectedPublicMediaSkill(agent, context, resource) {
  if (context.name !== 'download_social_media' || resource.kind !== 'file') return null;
  let url;
  try { url = new URL(resource.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !isDirectPublicMediaUrl(url.href)) return null;
  let tool = agent._activeSkillToolForName?.(context.tabId, 'download_public_media');
  if (!tool) {
    const mode = context.mode || 'act', tier = agent._resolvePromptTier?.() || 'full';
    const owner = agent._eligibleSkillOwnerForToolName?.(context.tabId, 'download_public_media', mode, tier);
    if (owner) { agent._activateSkillsForRun(context.tabId, [owner.id], mode, tier); tool = agent._activeSkillToolForName(context.tabId, 'download_public_media'); }
  }
  // Only the enabled, declared browser-download job transport is reusable.
  // Generic skills, page scraping and arbitrary endpoints cannot enter here.
  return tool?.kind === 'httpDownloadJob' && tool.requiresDownloadPermission === true ? tool : null;
}
function active(agent, context) {
  context.signal?.throwIfAborted();
  if (agent._hasPendingSteering?.(context.tabId)) throw failure('The user changed the task before the file operation', 'vision_file_task_changed');
}
async function downloadedItem(id) {
  const items = await api().downloads.search({ id });
  const item = items?.find(value => value.id === id);
  if (!item || item.state !== 'complete' || item.exists === false || !item.filename)
    throw failure('The selected download is missing or incomplete', 'saved_download_unavailable');
  return item;
}
async function uploadSource(agent, args, context, backend) {
  const hasAttachment = typeof args.attachmentId === 'string' && !!args.attachmentId.trim();
  const hasDownload = Number.isSafeInteger(args.downloadId) && args.downloadId >= 0;
  if (hasAttachment === hasDownload) throw failure('Provide exactly one current attachmentId or completed downloadId');
  if (hasAttachment) {
    const source = agent._resolveUserAttachment(context.tabId, args.attachmentId, MAX_BYTES);
    if (!source?.ok) throw failure(source?.error || 'The attachment handle is unavailable');
    if (typeof source.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.base64)
        || source.base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw failure('Invalid attachment bytes');
    const size = atob(source.base64).length;
    if (size > MAX_BYTES) throw failure('Attachment exceeds the 25MB limit');
    return { ...source, size, key: `attachment:${args.attachmentId}`, attachmentId: args.attachmentId };
  }
  const item = await downloadedItem(args.downloadId);
  active(agent, context);
  const bytes = await backend.readSavedDownload(context.tabId, item, { maxBytes: 8192, readPrefixBytes: 8192, signal: context.signal });
  active(agent, context);
  if (bytes?.readable !== true || bytes.exists !== true || !Number.isSafeInteger(bytes.size)
      || bytes.size > MAX_BYTES || bytes.size < 0
      || typeof bytes.base64 !== 'string' || bytes.base64.length > Math.ceil(8192 / 3) * 4
      || Number.isSafeInteger(item.fileSize) && item.fileSize >= 0 && bytes.size !== item.fileSize)
    throw failure('The actual saved download bytes could not be verified', 'saved_download_unreadable');
  if (identity(await downloadedItem(args.downloadId)) !== identity(item)) throw failure('Download changed during the saved-file read', 'saved_download_changed');
  return { ...bytes, filename: basename(item.filename), mimeType: item.mime || bytes.mimeType || '',
    filePath: item.filename, download: item, downloadId: args.downloadId, sourceUrl: item.finalUrl || item.url || '',
    key: `download:${args.downloadId}`, downloadIdentity: identity(item) };
}
async function saveBlob(agent, data, filename, context, beforeDispatch) {
  if (typeof data?.dataUrl !== 'string' || !/^data:[^,]*;base64,/.test(data.dataUrl)
      || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > MAX_BYTES)
    throw failure('The selected resource did not return bounded original bytes');
  const destination = await filenameInConfiguredDownloadDirectory(api(), filename || undefined);
  active(agent, context);
  beforeDispatch();
  const id = await api().downloads.download({ url: data.dataUrl, ...(destination ? { filename: destination } : {}), conflictAction: 'uniquify' });
  agent._pinDownloadId?.(context.tabId, id);
  for (let attempt = 0; attempt < 75; attempt++) {
    if (context.signal?.aborted) { await api().downloads.cancel(id).catch(() => {}); context.signal.throwIfAborted(); }
    const [item] = await api().downloads.search({ id });
    if (item?.state === 'complete') return { success: true, downloadId: id, state: 'complete', bytesReceived: item.bytesReceived, blob: true };
    if (item?.state === 'interrupted') return { success: false, dispatched: true, downloadId: id, state: item.state, error: item.error || 'Download interrupted' };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return { success: false, dispatched: true, downloadId: id, pending: true, error: 'The download is still pending; inspect its existing ID instead of downloading again' };
}

/** A single file operation, with caller-owned durable receipts and visual review. */
export async function runVisionFileTool(agent, context) {
  const { tabId, name, args = {}, browser, frames, signal } = context;
  const backend = context.backend || createVisionFileBackend();
  let target, chooser, chooserStarted = false, dispatched = false, operationKey, actionArgs = args;
  const effects = { observe: true, consequential: true };
  const state = context.state;
  const checkpoint = async () => {
    if (typeof context.checkpoint !== 'function') throw failure('A durable file-operation checkpoint is required', 'vision_checkpoint_failed');
    const saved = await context.checkpoint();
    if (saved === false || saved?.ok === false) throw failure('The file-operation checkpoint could not be saved', 'vision_checkpoint_failed');
    active(agent, context);
  };
  const prepareDispatch = async () => {
    active(agent, context);
    if (typeof context.beforeDispatch === 'function' && await context.beforeDispatch() === false)
      throw failure('The action recovery checkpoint rejected file dispatch', 'vision_checkpoint_failed');
    active(agent, context);
  };
  const fresh = async () => {
    active(agent, context);
    const current = await browser.capture(tabId);
    frames.assertViewport(current.viewport);
    await frames.assertCurrentPixels(current.dataUrl, current.viewport, actionArgs);
    active(agent, context);
    return current.viewport;
  };
  try {
    if (!VISION_FILE_TOOL_NAMES.has(name) || args.selector != null || args.filePath != null || args.targetId != null)
      throw failure('Visual file operations accept screenshot coordinates and file handles only');
    if (!state || typeof state !== 'object') throw failure('A durable file-operation state is required');
    state.operations ||= {};
    const css = frames.toCssPoint(args);
    let viewport = await fresh();
    await authorizeVisionCapability(agent, name, args, context);
    active(agent, context);
    const source = name === 'upload_file' ? await uploadSource(agent, args, context, backend) : null;
    const duplicate = existing => ({ result: { ...(existing.result || { success: false, outcomeUnknown: true,
      error: 'This file operation was already started. Inspect its existing result before repeating it.' }),
      deduplicated: true, replayed: false, receipt: operationKey }, effects });
    if (source) {
      // Point + document-space scroll identity survives a lazily-created input
      // and a consumed/removed input. Never repeat the initializer click.
      operationKey = JSON.stringify([name, viewport.documentId, source.key, css.x + (viewport.scrollX || 0), css.y + (viewport.scrollY || 0)]);
      if (state.operations[operationKey]) return duplicate(state.operations[operationKey]);
    }
    if (Object.keys(state.operations).length >= 256) throw failure('The file receipt limit was reached; preserve existing outcomes before continuing');
    // The review sees only the current screenshot and task-selected source
    // metadata. No local path, page tree, selector or attachment bytes enter it.
    const expected = { point: { x: args.x, y: args.y, imageId: args.imageId },
      ...(source ? { source: { attachmentId: source.attachmentId, downloadId: source.downloadId, name: source.filename, size: source.size } } : {}) };
    const review = await context.verify?.({ kind: source ? 'upload_target' : 'download_target', expected, frame: frames.latest });
    if (review?.verified !== true || review?.allowed !== true)
      throw failure('Independent visual review did not authorize this file target', 'vision_file_review_rejected');
    active(agent, context);
    viewport = await fresh();
    target = await backend.bind(tabId, css, source ? 'upload' : 'resource');
    if (source && !target && backend.armChooser) {
      if (typeof context.observe !== 'function') throw failure('The upload chooser requires a privacy-aware observation callback');
      state.operations[operationKey] = { status: 'pending', source: source.key, timestamp: Date.now(), phase: 'chooser' };
      await checkpoint();
      await prepareDispatch();
      chooser = await backend.armChooser(tabId, css);
      await fresh();
      active(agent, context);
      chooserStarted = true;
      const click = await browser.perform(tabId, 'click', actionArgs, frames);
      if (click?.success === false) {
        if (click.noDispatch === true || click.dispatched === false) chooserStarted = false;
        throw failure(click.error || 'The upload chooser could not be opened');
      }
      active(agent, context);
      target = await backend.takeChooser(tabId, chooser);
      await backend.closeChooser(tabId, chooser);
      await backend.assertTarget(tabId, target);
      // The runtime owns privacy-policy transitions and keyframe invalidation.
      // Updating frames directly here could mislabel an unmasked image as private.
      const refreshed = await context.observe(true, 'file-chooser-review');
      if (refreshed.viewport.documentId !== viewport.documentId || refreshed.viewport.url !== viewport.url)
        throw failure('The upload chooser navigated to another document; no file was attached', 'vision_stale_frame');
      actionArgs = { frameId: frames.latest.frameId,
        x: (css.x - (frames.latest.viewport.offsetLeft || 0)) / frames.latest.viewport.width * frames.latest.canvas.width,
        y: (css.y - (frames.latest.viewport.offsetTop || 0)) / frames.latest.viewport.height * frames.latest.canvas.height };
      const chosenReview = await context.verify?.({ kind: 'upload_target',
        expected: { ...expected, point: { x: actionArgs.x, y: actionArgs.y }, chooserInitialized: true }, frame: frames.latest });
      if (chosenReview?.verified !== true || chosenReview?.allowed !== true)
        throw failure('Independent visual review did not authorize the initialized upload target', 'vision_file_review_rejected');
      viewport = await fresh();
      await backend.assertTarget(tabId, target);
    }
    if (!target?.metadata) throw failure(source
      ? 'No file input, associated label or guarded chooser is available at this point.'
      : 'No original resource is directly associated with this point. Select the visible image, video, audio or download link.');
    if (source && (target.metadata.disabled || target.metadata.directory)) throw failure('This file input is disabled or requires a directory');
    const resource = source ? null : { ...target.metadata };
    const mediaSkill = resource && selectedPublicMediaSkill(agent, context, resource);
    if (name === 'download_social_media' && !['image', 'video', 'audio'].includes(resource.kind) && !mediaSkill)
      throw failure('Select the media itself or a direct public post/video permalink supported by an enabled download_public_media skill. Feeds, profiles and disabled providers cannot be substituted.');
    if (!source) {
      operationKey = JSON.stringify([name, viewport.documentId, resource.url, target.key]);
      if (state.operations[operationKey]) return duplicate(state.operations[operationKey]);
      if (/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(resource.url)) throw failure('This resource is a segmented media manifest. An original downloadable media file is required; a screenshot or playlist will not be substituted.');
    }
    if (mediaSkill) {
      await authorizeVisionCapability(agent, 'download_files', { urls: [resource.url, mediaSkill.endpoint] }, context);
      const verdict = await context.verify?.({ kind: 'download_target', frame: frames.latest,
        expected: { point: expected.point, publicMediaUrl: resource.url, provider: mediaSkill.endpoint,
          requirement: 'The visible selected link is the intended public media item; the enabled provider receives only this URL, never browser cookies.' } });
      if (verdict?.verified !== true || verdict.allowed !== true) throw failure('The public media target was not independently authorized', 'vision_file_review_rejected');
    }
    if (source) {
      const policy = validateUploadFile(target.metadata.accept, source);
      if (!policy.success) {
        const observed = source.sourceUrl && policy.actualMime === 'text/html'
          ? observedFileViewerResource(source.base64, source.sourceUrl) : null;
        const result = { ...policy, ...(observed ? { sourceResolution: observed } : {}), chooserInitialized: chooserStarted, noDispatch: true };
        if (chooserStarted) { state.operations[operationKey] = { status: 'uncertain', result }; await checkpoint(); }
        return { result, effects };
      }
    }
    state.operations[operationKey] = { status: 'pending', source: source?.key, timestamp: Date.now() };
    await checkpoint();
    await prepareDispatch();
    viewport = await fresh();
    await backend.assertTarget(tabId, target);
    if (source?.download && identity(await downloadedItem(source.downloadId)) !== source.downloadIdentity)
      throw failure('The saved download record changed before attachment', 'saved_download_changed');
    active(agent, context);
    const markDispatch = () => { active(agent, context); dispatched = true; };
    let result;
    if (source) {
      const sent = await backend.upload(tabId, target, source, { signal, beforeDispatch: markDispatch, viewport });
      if (sent?.success === false) {
        if (sent.noDispatch === true || sent.dispatched === false) dispatched = false;
        result = { ...sent, dispatched, noDispatch: !dispatched, retryable: false };
      } else {
        dispatched = true;
        let files;
        try { files = await backend.uploadedFiles(tabId, target); } catch { files = null; }
        const file = files?.find(item => item.name === source.filename && item.size === source.size);
        const consumed = Array.isArray(files) && files.length === 0;
        result = file || consumed ? { success: true, dispatched: true, attached: { name: source.filename, size: source.size },
          attachmentState: file ? 'input_attached' : 'page_consumed', remoteStateVerified: false,
          note: 'Local attachment only. Inspect the preview/status and submit once if the task requires it; do not re-upload a consumed file.' }
          : { success: false, dispatched: true, outcomeUnknown: true, retryable: false,
            error: 'Attachment delivery could not be verified. Inspect the current page before any further upload.' };
      }
    } else if (mediaSkill) {
      markDispatch();
      const remote = await (context.executeMediaSkill || executeHttpSkillTool)(mediaSkill,
        { url: resource.url, ...(args.filename ? { filename: args.filename } : {}) },
        { tabId, signal, onProgress: message => context.onUpdate?.('tool_progress', { name, message }) });
      // Provider titles, format listings and response bodies do not become
      // page observation. Retain only delivery identity and bounded failures.
      result = Object.fromEntries(['success', 'downloadId', 'state', 'pending', 'filename', 'bytesReceived', 'jobId', 'jobStatus',
        'provider', 'cleanupDeferred', 'cleanupScheduled'].filter(key => remote?.[key] !== undefined).map(key => [key, remote[key]]));
      if (remote?.error) result.error = String(remote.error).slice(0, 1600);
      result.method = 'enabled_public_media_provider';
      result.browserCookiesSent = false;
      if (result.downloadId != null) agent._autoScratchpadNote?.(tabId, `Saved download IDs: ${result.downloadId}.`);
    } else if (resource.url.startsWith('blob:')) {
      const data = await backend.readBlob(tabId, target, MAX_BYTES);
      await fresh(); await backend.assertTarget(tabId, target);
      result = await saveBlob(agent, data, args.filename || resource.downloadName, context, markDispatch);
    } else {
      if (!/^https?:\/\//i.test(resource.url)) throw failure('Only observed HTTP(S) resources or original page blobs can be saved');
      const batch = await downloadVisionFiles(agent, { urls: [resource.url], ...(args.filename ? { filename: args.filename } : {}) },
        { ...context, beforeDispatch: async () => { await fresh(); await backend.assertTarget(tabId, target); markDispatch(); } });
      result = batch.downloads?.[0] || batch;
    }
    result = { ...result, dispatched, chooserInitialized: chooserStarted, receipt: operationKey, sourceRefetched: false,
      ...(source?.attachmentId ? { attachmentId: source.attachmentId } : {}), ...(source?.downloadId != null ? { downloadId: source.downloadId } : {}) };
    if (!source && result.downloadId != null) agent._pinDownloadId?.(tabId, result.downloadId);
    if (name === 'download_social_media') result = { ...result, count: 1, triggeredCount: dispatched ? 1 : 0,
      completedCount: result.success && result.state === 'complete' ? 1 : 0, failedCount: result.success ? 0 : 1,
      screenshotSubstituted: false };
    if (dispatched || chooserStarted) state.operations[operationKey] = { status: result.success ? 'delivered' : 'uncertain', result };
    else delete state.operations[operationKey];
    await checkpoint();
    return { result, effects };
  } catch (error) {
    if (error.dispatchState?.noDispatch === true) dispatched = false;
    const result = { success: false, dispatched, noDispatch: !dispatched, chooserInitialized: chooserStarted,
      outcomeUnknown: dispatched || chooserStarted, retryable: false,
      code: error.code || 'vision_file_failed', error: String(error.message || error), ...(operationKey ? { receipt: operationKey } : {}) };
    if (operationKey) {
      if (dispatched || chooserStarted) state.operations[operationKey] = { status: 'uncertain', result };
      else delete state.operations[operationKey];
      try { await context.checkpoint?.(); } catch { /* A pending durable receipt remains conservatively uncertain. */ }
    }
    return { result, effects };
  } finally {
    if (chooser) await backend.releaseChooser(tabId, chooser).catch(() => {});
    if (target) await backend.release(tabId, target).catch(() => {});
  }
}
