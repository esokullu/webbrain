// CPU parity for two d1 packages through the extension's own runtime
// (src/chrome/src/providers/d1-runtime.js, CPU tensor path) and preprocessing,
// with onnxruntime-node. Runs the balanced-V3 final test (72 screenshots, 144
// questions), scores both packages against the labels and reports the largest
// per-option probability difference between them.
//
//   npm install --no-save onnxruntime-node@1.24.1 pngjs@7.0.0   (outside the repo is fine)
//   node scripts/models/d1/parity-cpu.mjs --left <fp32-package> --right <fp16-package> \
//     --test <final_test.json> --images <images dir> --modules <dir with node_modules> --output parity.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scoreAnswers, compareAnswers, questionsOf } from './decision-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const require = createRequire(path.join(path.resolve(option('--modules', '.')), 'node_modules', 'x.js'));
const ort = require('onnxruntime-node');
const { PNG } = require('pngjs');

// The preprocessing decodes screenshots with browser APIs; give it the same
// RGBA pixels from a PNG decoder.
globalThis.createImageBitmap = async blob => {
  const png = PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
  return { width: png.width, height: png.height, data: png.data, close() {} };
};
globalThis.OffscreenCanvas = class {
  getContext() {
    let bitmap;
    return { drawImage: image => { bitmap = image; }, getImageData: () => ({ data: bitmap.data }) };
  }
};

const { createD1Runtime } = await import(path.join(root, 'src/chrome/src/providers/d1-runtime.js'));
const { PreTrainedTokenizer } = await import(path.join(root, 'src/chrome/vendor/d1/transformers.web.js'));

async function load(dir) {
  const json = async name => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
  const tokenizer = new PreTrainedTokenizer(await json('tokenizer.json'), await json('tokenizer_config.json'));
  const sessions = {};
  for (const role of ['decision', 'vision', 'projector']) {
    sessions[role] = await ort.InferenceSession.create(path.join(dir, 'onnx', `${role}.onnx`), { graphOptimizationLevel: 'basic', intraOpNumThreads: Number(option('--threads', 8)) });
  }
  return createD1Runtime({ ort, tokenizer, config: await json('config.json'), ratios: await json('tiling-ratios.json'), sessions, model: dir });
}

const test = JSON.parse(await fs.readFile(option('--test'), 'utf8'));
const limit = Number(option('--limit', test.requests.length));
const requests = test.requests.slice(0, limit);
const images = option('--images');
const result = { startedAt: new Date().toISOString(), requests: requests.length, packages: {} };
const answers = {};
for (const [label, dir] of [['left', option('--left')], ['right', option('--right')]]) {
  const runtime = await load(path.resolve(dir));
  answers[label] = {};
  const started = Date.now();
  for (const request of requests) {
    const urls = [];
    for (const image of request.images) {
      const bytes = await fs.readFile(path.join(images, path.basename(image)));
      urls.push(`data:image/png;base64,${bytes.toString('base64')}`);
    }
    const output = await runtime.evaluate({ state: request.state, images: urls, questions: questionsOf(request) });
    Object.assign(answers[label], output.answers);
  }
  await runtime.dispose();
  result.packages[label] = { dir, seconds: (Date.now() - started) / 1000, ...scoreAnswers(requests, answers[label]) };
  console.log(label, JSON.stringify(result.packages[label]));
}
result.comparison = compareAnswers(requests, answers.left, answers.right);
result.answers = answers;
console.log(JSON.stringify(result.comparison));
await fs.writeFile(option('--output', 'parity.json'), JSON.stringify(result, null, 2));
