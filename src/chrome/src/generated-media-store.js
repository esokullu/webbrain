// Keep inline assets outside the bounded run journal and serialized chat HTML.
const DB_NAME = 'webbrain_generated_media';
const STORE_NAME = 'assets';
const MAX_BYTES = 20 * 1024 * 1024;
// A video joined from its scenes' clips: up to two minutes of generated video.
export const MAX_JOINED_VIDEO_BYTES = 160 * 1024 * 1024;
const MEDIA_MIME = /^(image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg)|video\/mp4)$/;

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storeGeneratedMedia(dataUrl) {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  if (!match || !MEDIA_MIME.test(match[1]) || match[2].length > MAX_BYTES * 1.4) throw new Error('Unsupported generated media.');
  const binary = atob(match[2]);
  if (binary.length > MAX_BYTES) throw new Error('Generated media exceeds the 20 MB inline limit.');
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return storeGeneratedMediaBlob(new Blob([bytes], { type: match[1] }));
}

// `maxBytes` above 20 MB is for videos: one joined from clips, or a clip of one.
export async function storeGeneratedMediaBlob(blob, { maxBytes = MAX_BYTES } = {}) {
  if (!(blob instanceof Blob) || !MEDIA_MIME.test(blob.type)) throw new Error('Unsupported generated media.');
  const limit = Math.min(maxBytes, blob.type === 'video/mp4' ? MAX_JOINED_VIDEO_BYTES : MAX_BYTES);
  if (blob.size > limit) throw new Error(`Generated media exceeds the ${Math.round(limit / 1024 / 1024)} MB inline limit.`);
  const id = crypto.randomUUID();
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ id, blob });
      // Wait for commit before publishing a handle to other extension contexts.
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Generated media could not be saved.'));
    });
  } finally { db.close(); }
  return { mediaId: id, mimeType: blob.type, inlineMedia: true };
}

export async function loadGeneratedMedia(id) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id || '')) return null;
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        const blob = request.result?.blob;
        const limit = blob?.type === 'video/mp4' ? MAX_JOINED_VIDEO_BYTES : MAX_BYTES;
        resolve(blob instanceof Blob && MEDIA_MIME.test(blob.type) && blob.size <= limit ? blob : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
