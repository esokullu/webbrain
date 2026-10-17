import { D1_CACHE_NAME, D1_REQUIRED_FILES, D1_RELEASE, d1BaseURL } from './d1-config.js';

export const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
const encoder = new TextEncoder();
const filename = path => path.replaceAll('/', '__');

export function validateD1Manifest(manifest) {
  if (!['float32', 'float16'].includes(manifest.dtype) || manifest.audio_included !== false) throw new Error('D1 package must be audio-free FP32 or FP16.');
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const result = {};
  for (const path of D1_REQUIRED_FILES) {
    const spec = files.find(file => file.path === path);
    if (!spec || !Number.isSafeInteger(spec.bytes) || spec.bytes <= 0 || !/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error(`Invalid D1 file descriptor: ${path}`);
    if (spec.bytes > 8 * 1024 * 1024 || Object.hasOwn(spec, 'chunks')) {
      let offset = 0;
      if (!Array.isArray(spec.chunks)) throw new Error(`Invalid D1 chunks: ${path}`);
      for (const chunk of spec.chunks) {
        if (chunk.offset !== offset || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error(`Invalid bounded D1 verification chunks: ${path}`);
        offset += chunk.bytes;
      }
      if (offset !== spec.bytes) throw new Error(`D1 chunk coverage mismatch: ${path}`);
    }
    result[path] = spec;
  }
  return result;
}

const currentCacheName = () => D1_CACHE_NAME + '-' + D1_RELEASE.revision;

export async function openD1Cache() {
  if (!navigator.storage?.getDirectory) throw new Error('D1 needs browser origin-private file storage (OPFS).');
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(currentCacheName(), { create: true });
}

// Every pinned package lives in its own directory; earlier packages
// (including the FP32 release) are unreachable once the pin moves.
export async function removeStaleD1Caches() {
  const root = await navigator.storage.getDirectory(), stale = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === 'directory' && name.startsWith('webbrain-d1-') && name !== currentCacheName()) stale.push(name);
  }
  for (const name of stale) await root.removeEntry(name, { recursive: true });
  return stale;
}

export async function readD1Manifest(directory, { download = false, signal } = {}) {
  let bytes;
  try { bytes = new Uint8Array(await (await (await directory.getFileHandle('package-manifest.json')).getFile()).arrayBuffer()); }
  catch {
    if (!download) throw new Error('Download D1 explicitly in Settings > Assistive Models > Decision models first.');
    const response = await fetch(d1BaseURL() + 'package-manifest.json', { credentials: 'omit', redirect: 'follow', signal });
    if (!response.ok || Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('D1 package manifest download failed.');
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (bytes.length > 1024 * 1024 || await digest(bytes) !== D1_RELEASE.manifestSha256) throw new Error('D1 package manifest integrity failed.');
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  validateD1Manifest(manifest);
  if (download) { const writer = await (await directory.getFileHandle('package-manifest.json', { create: true })).createWritable(); await writer.write(bytes); await writer.close(); }
  return manifest;
}

export async function verifyD1File(file, spec, signal) {
  if (file.size !== spec.bytes) throw new Error(`D1 cached size mismatch: ${spec.path}`);
  for (const chunk of spec.chunks || [{ offset: 0, bytes: spec.bytes, sha256: spec.sha256 }]) {
    if (signal?.aborted) throw signal.reason;
    if (await digest(await file.slice(chunk.offset, chunk.offset + chunk.bytes).arrayBuffer()) !== chunk.sha256) throw new Error(`D1 checksum mismatch: ${spec.path} at ${chunk.offset}`);
  }
}

export async function d1CachedFile(directory, spec, { download = false, signal, onProgress = () => {} } = {}) {
  const name = filename(spec.path);
  try {
    const file = await (await directory.getFileHandle(name)).getFile();
    await verifyD1File(file, spec, signal); return file;
  } catch (error) {
    if (signal?.aborted || !download) throw error;
    await directory.removeEntry(name).catch(() => {});
  }
  const response = await fetch(d1BaseURL() + spec.path, { credentials: 'omit', redirect: 'follow', signal });
  if (!response.ok || Number(response.headers.get('content-length')) > spec.bytes) throw new Error(`D1 download failed: ${spec.path}`);
  const writer = await (await directory.getFileHandle(name, { create: true })).createWritable(), reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > spec.bytes) throw new Error(`D1 file exceeds declared size: ${spec.path}`);
      await writer.write(value); onProgress(total);
    }
    if (total !== spec.bytes) throw new Error(`D1 incomplete download: ${spec.path}`);
    await writer.close();
    const file = await (await directory.getFileHandle(name)).getFile(); await verifyD1File(file, spec, signal); return file;
  } catch (error) { await writer.abort().catch(() => {}); await directory.removeEntry(name).catch(() => {}); throw error; }
  finally { await reader.cancel().catch(() => {}); }
}

export async function setD1Ready(directory, ready) {
  if (!ready) return directory.removeEntry('ready.json').catch(() => {});
  const writer = await (await directory.getFileHandle('ready.json', { create: true })).createWritable();
  await writer.write(encoder.encode(JSON.stringify({ revision: D1_RELEASE.revision, manifestSha256: D1_RELEASE.manifestSha256 }))); await writer.close();
}
