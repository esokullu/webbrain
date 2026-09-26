#!/usr/bin/env node
// Download pinned GGUF files in resumable ranges; verify the HF LFS SHA-256.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat, readFile, appendFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [url, destination, expectedBytes, expectedHash] = process.argv.slice(2);
if (!url || !destination || !expectedBytes || !expectedHash) {
  throw new Error('Usage: node test/llm/download-gguf.mjs URL DESTINATION BYTES SHA256');
}
const target = resolve(destination);
const part = `${target}.range`;
const size = Number(expectedBytes);
await mkdir(dirname(target), { recursive: true });
let offset = await stat(target).then(s => s.size).catch(() => 0);
if (offset > size) throw new Error('Existing file is larger than the expected model.');
while (offset < size) {
  const end = Math.min(size - 1, offset + 64 * 1024 * 1024 - 1);
  let success = false;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('download', 'true');
    requestUrl.searchParams.set('range_request', `${offset}-${end}-${attempt}`);
    const code = await new Promise((accept, reject) => {
      const child = spawn('curl.exe', ['--location', '--fail', '--silent', '--show-error',
        '--speed-limit', '1024', '--speed-time', '10', '--max-time', '90',
        '--range', `${offset}-${end}`, requestUrl.href, '--output', part], { stdio: 'inherit', windowsHide: true });
      child.on('error', reject);
      child.on('exit', accept);
    });
    const bytes = await stat(part).then(s => s.size).catch(() => 0);
    if (code === 0 && bytes === end - offset + 1) { success = true; break; }
    console.log(`Retry range ${offset}-${end}: exit=${code}, bytes=${bytes}`);
  }
  if (!success) throw new Error(`Range download failed at ${offset}.`);
  await appendFile(target, await readFile(part));
  await unlink(part);
  offset = end + 1;
  console.log(`${destination}: ${(100 * offset / size).toFixed(1)}% (${offset}/${size})`);
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(target)) hash.update(chunk);
const actual = hash.digest('hex');
if (actual !== expectedHash) throw new Error(`SHA-256 mismatch: ${actual}`);
console.log(`Verified SHA-256 ${actual}`);
