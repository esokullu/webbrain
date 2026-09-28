/**
 * Emit the exact `SPARK_FILES` pin rows and verify the graph ABI for a Spark
 * export, so a new Hugging Face revision can be re-pinned without hand-typing
 * 64 hex digits per file.
 *
 *   node scripts/spark-pin-table.mjs <bundle-dir> [--context 32768]
 *
 * <bundle-dir> is the local export root: the directory holding
 * `tokenizer.json` and `onnx/model_fp16.onnx`. Nothing is uploaded and no HF
 * credential is read; this only hashes bytes already on disk.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SPARK_CONTEXT, SPARK_FILES } from '../src/chrome/src/offscreen/spark-runtime.js';

const args = process.argv.slice(2);
const dir = resolve(args.find(arg => !arg.startsWith('--')) || '');
const contextFlag = args.indexOf('--context');
const context = contextFlag === -1 ? SPARK_CONTEXT : Number(args[contextFlag + 1]);

if (!dir) {
  console.error('usage: node scripts/spark-pin-table.mjs <bundle-dir> [--context 32768]');
  process.exit(2);
}
if (!Number.isInteger(context) || context <= 0) {
  console.error(`--context must be a positive integer, got ${JSON.stringify(args[contextFlag + 1])}`);
  process.exit(2);
}

async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

const rows = [];
const missing = [];
for (const { path } of SPARK_FILES) {
  const full = join(dir, path);
  try {
    await stat(full);
  } catch {
    missing.push(path);
    continue;
  }
  const { bytes, sha256 } = await hashFile(full);
  rows.push([path, bytes, sha256]);
}

if (missing.length) {
  console.error(`Missing ${missing.length} of ${SPARK_FILES.length} required files in ${dir}:`);
  for (const path of missing) console.error(`  ${path}`);
  process.exit(1);
}

console.log('SPARK_FILES rows (paste into src/chrome/src/offscreen/spark-runtime.js):');
for (const [path, bytes, sha256] of rows) {
  console.log(`  ['${path}', ${bytes}, '${sha256}'],`);
}

// Mirror the runtime's own load-time ABI gate so a mismatched export is caught
// here rather than on a user's GPU. See createSparkRuntime in spark-runtime.js.
let abi;
try {
  abi = JSON.parse(await readFile(join(dir, 'graph-abi.json'), 'utf8'));
} catch (error) {
  console.error(`\ngraph-abi.json is not readable JSON: ${error.message}`);
  console.error('The export is incomplete; re-export before re-pinning.');
  process.exit(1);
}
const problems = [];
if (!Array.isArray(abi.inputs)) problems.push('inputs is not an array');
if (!Array.isArray(abi.outputs)) problems.push('outputs is not an array');
if (abi.numLayers !== 28) problems.push(`numLayers ${abi.numLayers} != 28`);
if (abi.inputs?.length !== 58) problems.push(`inputs ${abi.inputs?.length} != 58`);
if (abi.outputs?.length !== 57) problems.push(`outputs ${abi.outputs?.length} != 57`);
if (abi.deploymentContextTokens !== context) {
  problems.push(`deploymentContextTokens ${abi.deploymentContextTokens} != SPARK_CONTEXT ${context}`);
}

console.log('\ngraph ABI vs SPARK_CONTEXT:');
for (const key of ['numLayers', 'deploymentContextTokens']) {
  console.log(`  ${key}: ${abi[key]}`);
}
console.log(`  inputs: ${abi.inputs?.length}  outputs: ${abi.outputs?.length}`);

if (problems.length) {
  console.error(`\nABI mismatch against SPARK_CONTEXT=${context}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nSet SPARK_CONTEXT to the graph value (or re-export) before re-pinning.');
  process.exit(1);
}

console.log(`\nOK. Graph satisfies the runtime gate at SPARK_CONTEXT=${context}.`);
console.log('Remember to update SPARK_MODEL_ID and SPARK_REVISION to the new repo/revision.');
