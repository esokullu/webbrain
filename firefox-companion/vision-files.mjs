import { open, mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { visionFileTargetAtPoint, visionInputMetadata, visionResourceMetadata, visionReadOriginalBlob,
  createVisionFileChooserTrap, visionChooserInputMatches } from '../src/firefox/src/agent/vision-file-target.js';
import '../src/firefox/src/content/file-upload-policy.js';
import { readVisionViewport } from './vision.mjs';

const { validateUploadFile } = globalThis.__wbFileUploadPolicy;
const MAX_BYTES = 25 * 1024 * 1024;
const targets = new WeakMap();
const choosers = new WeakMap();
function live(session, runId) {
  const run = session.runs.get(runId);
  if (!run) throw new Error('Firefox vision file run stopped');
  return run;
}
function targetFor(session, runId, token) {
  const target = targets.get(session)?.get(token);
  if (!target || target.runId !== runId || target.run !== live(session, runId)) throw new Error('Selected file target expired');
  return target;
}
async function call(session, target, fn, args = []) {
  const result = await session.send('script.callFunction', {
    target: { context: target.run.context, sandbox: 'webbrain-vision-files' },
    functionDeclaration: fn, arguments: [{ sharedId: target.node.sharedId }, ...args.map(value => ({ type: 'string', value: JSON.stringify(value) }))],
    awaitPromise: true,
  });
  if (result.type === 'exception') throw new Error('Selected file target is unavailable');
  return JSON.parse(result.result?.value || 'null');
}
export async function readVisionSavedDownload(session, runId, download, options = {}) {
  const run = live(session, runId);
  if (!Number.isSafeInteger(download?.id) || download.id < 0 || download.state !== 'complete'
      || download.exists === false || typeof download.filename !== 'string' || !isAbsolute(download.filename))
    throw new Error('A completed browser download with its exact saved path is required');
  const maxBytes = Math.min(MAX_BYTES, Math.max(1, Number(options.maxBytes) || MAX_BYTES));
  const prefix = Math.min(maxBytes, Math.max(0, Number(options.readPrefixBytes) || 0));
  const file = await open(download.filename, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size)
        || Number.isSafeInteger(download.fileSize) && download.fileSize >= 0 && download.fileSize !== before.size)
      throw new Error('The saved download no longer matches its browser record');
    if (!prefix && before.size > maxBytes) throw new Error('Saved file exceeds the bounded reader limit');
    const bytes = Buffer.alloc(Math.min(before.size, prefix || maxBytes));
    let offset = 0;
    while (offset < bytes.length) {
      const part = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!part.bytesRead) throw new Error('The saved file changed during reading');
      offset += part.bytesRead;
    }
    const after = await file.stat();
    if (live(session, runId) !== run || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
      throw new Error('The saved file or browser run changed during reading');
    return { exists: true, readable: true, size: before.size, filename: basename(download.filename),
      mimeType: String(download.mime || ''), base64: bytes.toString('base64'), lastModified: before.mtimeMs,
      digest: createHash('sha256').update(bytes).digest('hex'),
      dataBytesRead: bytes.length, dataTruncated: bytes.length < before.size };
  } finally { await file.close(); }
}

export async function bindVisionFileTarget(session, runId, point, kind) {
  const run = live(session, runId);
  if (!['upload', 'resource'].includes(kind) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error('Invalid visual file target');
  const result = await session.send('script.evaluate', {
    target: { context: run.context, sandbox: 'webbrain-vision-files' },
    expression: `(${visionFileTargetAtPoint.toString()})(${point.x},${point.y},${JSON.stringify(kind)})`,
    awaitPromise: false,
  });
  if (!result.result?.sharedId) return null;
  const target = { runId, run, node: result.result, point, kind };
  const metadata = await call(session, target, `el=>JSON.stringify((${(kind === 'upload' ? visionInputMetadata : visionResourceMetadata).toString()})(el))`);
  if (!metadata || live(session, runId) !== run) return null;
  target.metadata = metadata;
  if (!targets.has(session)) targets.set(session, new Map());
  const store = targets.get(session);
  for (const [key, value] of store) if (session.runs.get(value.runId) !== value.run) store.delete(key);
  if (store.size >= 128) throw new Error('Too many retained visual file targets');
  const token = randomUUID(); store.set(token, target);
  return { token, key: target.node.sharedId, metadata, point, kind };
}
export async function assertVisionFileTarget(session, runId, token) {
  const target = targetFor(session, runId, token);
  if (target.chooser) {
    const holder = target.chooser;
    const result = await session.send('script.callFunction', {
      target: { context: target.run.context }, awaitPromise: false,
      functionDeclaration: `(input,holder,x,y)=>holder.count()===1&&(${visionChooserInputMatches.toString()})(input,holder.trigger(),x,y)`,
      arguments: [{ sharedId: target.node.sharedId }, { handle: holder.handle }, { type: 'number', value: target.point.x }, { type: 'number', value: target.point.y }],
    });
    if (result.type === 'exception' || result.result?.value !== true) throw new Error('The guarded file chooser target changed');
    return true;
  }
  const matches = await call(session, target,
    `(el,encoded)=>{const p=JSON.parse(encoded);return JSON.stringify(el.isConnected&&(${visionFileTargetAtPoint.toString()})(p.x,p.y,p.kind)===el)}`,
    [{ ...target.point, kind: target.kind }]);
  if (!matches) throw new Error('Selected visual file target changed');
  return true;
}

export async function armVisionFileChooser(session, runId, point) {
  const run = live(session, runId);
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error('Invalid visual chooser point');
  if (!choosers.has(session)) choosers.set(session, new Map());
  const store = choosers.get(session);
  if (store.size >= 32) throw new Error('Too many retained file chooser guards');
  const result = await session.send('script.evaluate', {
    target: { context: run.context }, awaitPromise: false, resultOwnership: 'root',
    expression: `(${createVisionFileChooserTrap.toString()})(${point.x},${point.y},3000)`,
  });
  if (result.type === 'exception' || !result.result?.handle) throw new Error('The file chooser could not be guarded');
  const token = randomUUID();
  store.set(token, { token, runId, run, handle: result.result.handle, point });
  return { token, point };
}
function chooserFor(session, runId, token) {
  const holder = choosers.get(session)?.get(token);
  if (!holder || holder.runId !== runId || holder.run !== live(session, runId)) throw new Error('File chooser guard expired');
  return holder;
}
async function callChooser(session, holder, functionDeclaration) {
  const result = await session.send('script.callFunction', { target: { context: holder.run.context },
    functionDeclaration, arguments: [{ handle: holder.handle }], awaitPromise: false });
  if (result.type === 'exception') throw new Error('The file chooser document changed');
  return result.result;
}
export async function takeVisionFileChooser(session, runId, token) {
  const holder = chooserFor(session, runId, token);
  const count = (await callChooser(session, holder, 'holder=>holder.count()'))?.value;
  if (count !== 1) throw new Error(count > 1 ? 'Multiple file choosers opened; no file was attached' : 'The upload control did not open a file chooser; no file was attached');
  const node = await callChooser(session, holder, 'holder=>holder.take()');
  if (!node?.sharedId) throw new Error('The guarded file chooser expired');
  const target = { runId, run: holder.run, node, point: holder.point, kind: 'upload', chooser: holder };
  target.metadata = await call(session, target, `el=>JSON.stringify((${visionInputMetadata.toString()})(el))`);
  if (!target.metadata) throw new Error('The selected chooser is not a live file input');
  if (!targets.has(session)) targets.set(session, new Map());
  const targetToken = randomUUID(); targets.get(session).set(targetToken, target);
  return { token: targetToken, key: node.sharedId, point: target.point, kind: 'upload', metadata: target.metadata };
}
export async function closeVisionFileChooser(session, runId, token, release = false) {
  const holder = choosers.get(session)?.get(token);
  if (!holder || holder.runId !== runId) return true;
  await callChooser(session, holder, 'holder=>{holder.close();return true}').catch(() => {});
  if (release) {
    choosers.get(session).delete(token);
    await session.send('script.disown', { target: { context: holder.run.context }, handles: [holder.handle] }).catch(() => {});
  }
  return true;
}
export async function uploadVisionFile(session, runId, token, source, expectedViewport) {
  const target = targetFor(session, runId, token);
  let dispatched = false;
  try {
    let filePath, bytes, prepared;
    if (source.download) {
      prepared = await readVisionSavedDownload(session, runId, source.download, { readPrefixBytes: 8192, maxBytes: 8192 });
      if (prepared.size !== source.size || prepared.lastModified !== source.lastModified || prepared.base64 !== source.base64)
        throw new Error('The saved file changed after its bytes were inspected');
      filePath = source.download.filename;
    } else {
      if (typeof source.base64 !== 'string' || source.base64.length > Math.ceil(MAX_BYTES / 3) * 4
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.base64)) throw new Error('Invalid attachment payload');
      bytes = Buffer.from(source.base64, 'base64');
      if (bytes.length > MAX_BYTES || bytes.length !== source.size) throw new Error('Invalid attachment size');
      prepared = source;
    }
    const metadata = await call(session, target, `el=>JSON.stringify((${visionInputMetadata.toString()})(el))`);
    if (!metadata || metadata.disabled || metadata.directory) throw new Error('The selected file input is unavailable');
    const policy = validateUploadFile(metadata.accept, prepared);
    if (!policy.success) return policy;
    if (!filePath) {
      const directory = await mkdtemp(join(tmpdir(), 'webbrain-vision-upload-'));
      session.files.push(directory);
      const name = basename(String(source.filename || 'attachment')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      filePath = join(directory, !name || name === '.' || name === '..' ? 'attachment' : name);
      await writeFile(filePath, bytes, { mode: 0o600 });
    }
    await assertVisionFileTarget(session, runId, token);
    const current = await readVisionViewport(session, runId);
    if (current.documentId !== expectedViewport.documentId || current.url !== expectedViewport.url
        || ['width', 'height', 'scrollX', 'scrollY', 'offsetLeft', 'offsetTop', 'scale', 'devicePixelRatio']
          .some(key => Math.abs(Number(current[key] || 0) - Number(expectedViewport[key] || 0)) > 0.01))
      throw new Error('Screenshot viewport changed before file attachment');
    live(session, runId);
    dispatched = true;
    await session.send('input.setFiles', { context: target.run.context, element: { sharedId: target.node.sharedId }, files: [filePath] });
    return { success: true, dispatched: true };
  } catch (error) {
    error.dispatchState = { dispatched, noDispatch: !dispatched, outcomeUnknown: dispatched, retryable: false };
    throw error;
  }
}
export async function readVisionFileTarget(session, runId, token) {
  return call(session, targetFor(session, runId, token),
    `el=>JSON.stringify(el.isConnected?Array.from(el.files||[]).slice(0,4).map(f=>({name:f.name,size:f.size})):[])`);
}
export async function readVisionBlob(session, runId, token, maxBytes) {
  const target = targetFor(session, runId, token);
  await assertVisionFileTarget(session, runId, token);
  return call(session, target, `async(el,encoded)=>{
    const {max,url}=JSON.parse(encoded);return JSON.stringify(await (${visionReadOriginalBlob.toString()})(el,url,max));
  }`, [{ max: Math.min(Number(maxBytes) || MAX_BYTES, 20 * 1024 * 1024), url: target.metadata?.url }]);
}
export function releaseVisionFileTarget(session, runId, token) {
  const target = targets.get(session)?.get(token);
  if (target?.runId === runId) targets.get(session).delete(token);
  return true;
}
