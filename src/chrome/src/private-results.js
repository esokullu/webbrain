export const PRIVATE_RESULT_TYPE = 'webbrain.private-result.v1';
export const PRIVATE_RESULT_CAPABILITY = 'private_results_v1';
const MAX_RESULT_BYTES = 64 * 1024;

export async function importPrivateResultRecipient(jwk) {
  if (!jwk || jwk.kty !== 'RSA' || jwk.e !== 'AQAB'
      || typeof jwk.n !== 'string' || !/^[A-Za-z0-9_-]{342,1024}$/.test(jwk.n)
      || ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(key => key in jwk)) {
    throw new Error('Private results require an RSA public key of at least 2048 bits.');
  }
  const key = await crypto.subtle.importKey('jwk', {kty: 'RSA', n: jwk.n, e: jwk.e},
    {name: 'RSA-OAEP', hash: 'SHA-256'}, false, ['encrypt']);
  if (key.algorithm.modulusLength < 2048) throw new Error('Private result key is too small.');
  return key;
}
function base64(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}
export async function encryptPrivateResult(key, runId, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAX_RESULT_BYTES) throw new Error('Private final result exceeds the 64 KiB limit.');
  const material = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey('raw', material, {name: 'AES-GCM'}, false, ['encrypt']);
  const encryptedKey = await crypto.subtle.encrypt({name: 'RSA-OAEP'}, key, material);
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(PRIVATE_RESULT_TYPE + ':' + runId)}, aes, bytes);
  material.fill(0);
  return {version: 1, algorithm: 'RSA-OAEP-256+A256GCM', encryptedKey: base64(encryptedKey),
    iv: base64(iv), ciphertext: base64(ciphertext)};
}
