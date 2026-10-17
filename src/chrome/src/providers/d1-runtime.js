import { encode, temperature, imageInputs, positionMatrix, pyJSON } from './d1-preprocess.js';

export const D1_PROVIDER = 'webgpu_d1';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const checkAbort = signal => { if (signal?.aborted) throw signal.reason || new Error('D1 request cancelled.'); };
const dispose = values => { for (const value of Object.values(values || {})) value.dispose?.(); };

// Media blocks are data, never fetched from a page-chosen network URL.
export function splitD1State(state, images = []) {
  const media = [...images];
  let text = state == null ? '' : state;
  if (Array.isArray(state)) {
    text = state.filter(part => {
      if (part?.type !== 'image_url') return true;
      media.push(part.image_url?.url); return false;
    });
    if (!text.length) text = '';
  }
  if (media.length > 4 || media.some(url => typeof url !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url))) {
    throw new Error('D1 accepts at most four inline PNG/JPEG/WebP screenshots; remote image URLs are not allowed.');
  }
  if (new TextEncoder().encode(JSON.stringify([text, media])).length > 8 * 1024 * 1024) throw new Error('D1 input exceeds 8 MiB.');
  return { state: text, images: media };
}

export function d1Answers(questions, probabilities, width) {
  const answers = Object.create(null);
  const entries = Array.isArray(questions) ? questions : Object.entries(questions);
  entries.forEach(([id, question], row) => {
    const names = question.type === 'noul' ? ['no', 'yes'] : question.type === 'score' ? question.criteria.map((_, i) => String(i)) : Object.keys(question.criteria);
    const values = Array.from(probabilities.slice(row * width, row * width + names.length), Number);
    if (values.length !== names.length || values.some(value => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > .001) throw new Error('Invalid D1 probability output.');
    const selected = values.indexOf(Math.max(...values));
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: values[1] };
    else {
      const common = { type: question.type, confidence: values[selected], probabilities: Object.fromEntries(names.map((name, i) => [name, values[i]])) };
      answers[id] = question.type === 'choice' ? { ...common, choice: names[selected] } : { ...common, score: values.reduce((sum, p, i) => sum + p * i, 0), legend: Object.fromEntries(names.map((name, i) => [name, typeof question.criteria[i] === 'string' ? question.criteria[i] : pyJSON(question.criteria[i])])) };
    }
  });
  return answers;
}

// The encoder's six full-attention layers are dense: each one materializes a
// heads × length × length FP32 score tensor per row (plus elementwise copies
// of it), so memory grows with the square of the row length, not with the
// token count. Batches are bounded by that tensor, and text-only rows are
// capped on WebGPU; the source truncates the state, never the question, when
// a row is over the cap.
export const D1_ATTENTION_HEADS = 16;
export const D1_ATTENTION_BUDGET_BYTES = 256 * 1024 * 1024;
export const D1_WEBGPU_MAX_TEXT_TOKENS = 2048;
export const d1AttentionBytes = (rows, length) => rows * D1_ATTENTION_HEADS * length * length * 4;

export function d1RowBatches(rows, mediaLength, { maxTokens = 65536, budgetBytes = D1_ATTENTION_BUDGET_BYTES } = {}) {
  const order = rows.map((_, i) => i).sort((a, b) => rows[b].input_ids.length - rows[a].input_ids.length), batches = [];
  while (order.length) {
    const longest = rows[order[0]].input_ids.length + mediaLength;
    let size = 1;
    while (size < order.length && (size + 1) * longest <= maxTokens && d1AttentionBytes(size + 1, longest) <= budgetBytes) size++;
    batches.push(order.splice(0, size));
  }
  return batches;
}

const HIDDEN = 768, PATCHES = 1024, WIDTH = 1024, FLOAT_BYTES = 4, VISION_HEADS = 12;

export function createD1Runtime({ ort, tokenizer, config, ratios, sessions, device, model, dtype = 'float32' }) {
  if (!sessions?.decision || !sessions?.vision || !sessions?.projector) throw new Error('D1 requires all three sessions.');
  const tensor = (type, data, shape) => new ort.Tensor(type, data, shape);
  // One score tensor must fit a single storage binding on this adapter.
  const rowLimit = Number(device?.limits?.maxStorageBufferBindingSize) || Infinity;
  const budgetBytes = Math.min(D1_ATTENTION_BUDGET_BYTES, rowLimit);
  const usage = globalThis.GPUBufferUsage ? GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST : 0;
  const gpuTensor = (bytes, dims) => {
    const buffer = device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage });
    return { buffer, tensor: ort.Tensor.fromGpuBuffer(buffer, { dataType: 'float32', dims, dispose: () => buffer.destroy() }) };
  };
  const copy = (pairs) => {
    const encoder = device.createCommandEncoder();
    for (const [source, sourceOffset, target, targetOffset, bytes] of pairs) encoder.copyBufferToBuffer(source, sourceOffset, target, targetOffset, bytes);
    device.queue.submit([encoder.finish()]);
  };
  // Vision and projector outputs stay on the GPU when the sessions return
  // gpu-buffer tensors: each crop is copied into the projector input and each
  // projected chunk into every row of the decision input, without a readback.
  async function mediaPrefix(images, signal) {
    const chunks = [], layouts = [];
    try {
      for (const url of images) {
        checkAbort(signal);
        const image = await imageInputs(url, ratios), crops = image.shapes.length;
        // The vision tower's attention is dense too (12 heads × 1024² per crop),
        // so a tiled screenshot runs in crop groups that fit the same budget.
        const group = Math.max(1, Math.floor(budgetBytes / (VISION_HEADS * PATCHES * PATCHES * FLOAT_BYTES)));
        for (let first = 0; first < crops; first += group) {
          const count = Math.min(group, crops - first);
          const positions = new Float32Array(count * PATCHES * 256);
          for (let i = 0; i < count; i++) positions.set(positionMatrix(...image.shapes[first + i]), i * PATCHES * 256);
          const feeds = {
            pixel_values: tensor('float32', image.pixels.slice(first * PATCHES * HIDDEN, (first + count) * PATCHES * HIDDEN), [count, PATCHES, HIDDEN]),
            pixel_mask: tensor('bool', Uint8Array.from(image.mask.slice(first * PATCHES, (first + count) * PATCHES)), [count, PATCHES]),
            position_matrix: tensor('float32', positions, [count, PATCHES, 256]),
          };
          let output;
          try {
            output = await sessions.vision.run(feeds); checkAbort(signal);
            const gpu = output.hidden.location === 'gpu-buffer' && !!device;
            const hidden = gpu ? null : await output.hidden.getData();
            for (let crop = 0; crop < count; crop++) {
              const [h, w] = image.shapes[first + crop], bytes = h * w * HIDDEN * FLOAT_BYTES;
              let input, buffer, projected;
              if (gpu) ({ tensor: input, buffer } = gpuTensor(bytes, [1, h, w, HIDDEN]));
              else input = tensor('float32', hidden.slice(crop * PATCHES * HIDDEN, crop * PATCHES * HIDDEN + h * w * HIDDEN), [1, h, w, HIDDEN]);
              try {
                if (gpu) copy([[output.hidden.gpuBuffer, crop * PATCHES * HIDDEN * FLOAT_BYTES, buffer, 0, bytes]]);
                projected = await sessions.projector.run({ hidden: input }); checkAbort(signal);
                if (gpu && projected.prefix.location === 'gpu-buffer') { chunks.push({ tensor: projected.prefix, rows: projected.prefix.dims[1] }); projected = null; }
                else { const data = new Float32Array(await projected.prefix.getData()); chunks.push({ data, rows: data.length / WIDTH }); }
              } finally { input.dispose?.(); dispose(projected); }
            }
          } finally { dispose(feeds); dispose(output); }
        }
        layouts.push({ ...image.plan, shapes: image.shapes });
      }
    } catch (error) { for (const chunk of chunks) chunk.tensor?.dispose?.(); throw error; }
    return { chunks, layouts, mediaLength: chunks.reduce((n, chunk) => n + chunk.rows, 0) };
  }
  function mediaFeed(chunks, mediaLength, batch) {
    if (!mediaLength || !chunks.some(chunk => chunk.tensor)) {
      const prefix = new Float32Array(mediaLength * WIDTH);
      let offset = 0; for (const chunk of chunks) { prefix.set(chunk.data, offset); offset += chunk.data.length; }
      const media = new Float32Array(batch * prefix.length);
      for (let row = 0; row < batch; row++) media.set(prefix, row * prefix.length);
      return tensor('float32', media, [batch, mediaLength, WIDTH]);
    }
    const rowBytes = mediaLength * WIDTH * FLOAT_BYTES, { tensor: media, buffer } = gpuTensor(batch * rowBytes, [batch, mediaLength, WIDTH]), pairs = [];
    for (let row = 0; row < batch; row++) {
      let offset = row * rowBytes;
      for (const chunk of chunks) {
        const bytes = chunk.rows * WIDTH * FLOAT_BYTES;
        if (chunk.tensor) pairs.push([chunk.tensor.gpuBuffer, 0, buffer, offset, bytes]);
        else device.queue.writeBuffer(buffer, offset, chunk.data);
        offset += bytes;
      }
    }
    copy(pairs);
    return media;
  }
  return {
    async evaluate({ state = '', images = [], questions, signal } = {}) {
      checkAbort(signal);
      if (!record(questions) || !Object.keys(questions).length || Object.keys(questions).length > 32) throw new Error('D1 requires 1 to 32 named questions.');
      const input = splitD1State(state, images);
      const { chunks, layouts, mediaLength } = await mediaPrefix(input.images, signal);
      try {
        // The longest row whose score tensor still fits one storage binding.
        const maxRow = Math.floor(Math.sqrt(rowLimit / (D1_ATTENTION_HEADS * FLOAT_BYTES)));
        const textCap = input.images.length ? config.image_text_length : Math.min(config.max_length, D1_WEBGPU_MAX_TEXT_TOKENS);
        const limit = Math.min(textCap, config.max_length - mediaLength, maxRow - mediaLength);
        if (!Number.isInteger(mediaLength) || config.max_length - mediaLength < 64) throw new Error('D1 media exceed the source context budget.');
        if (limit < 64) throw new Error(`D1 input is too large for this GPU: ${mediaLength} screenshot positions. Send fewer or smaller screenshots.`);
        const entries = Object.entries(questions), rows = entries.map(([, q]) => encode(tokenizer, input.state, q, limit, input.images.length > 0));
        const longest = Math.max(...rows.map(row => row.input_ids.length)) + mediaLength;
        if (d1AttentionBytes(1, longest) > rowLimit) throw new Error(`D1 input is too large for this GPU: ${longest} tokens including screenshots. Send fewer or smaller screenshots.`);
        const answers = Object.create(null), batches = [];
        for (const indices of d1RowBatches(rows, mediaLength, { budgetBytes })) {
          const selectedRows = indices.map(i => rows[i]), selectedEntries = indices.map(i => entries[i]);
          const batch = selectedRows.length, length = Math.max(...selectedRows.map(row => row.input_ids.length)), width = Math.max(...selectedRows.map(row => row.markers.length));
          const ids = new BigInt64Array(batch * length), mask = new Uint8Array(batch * length), markers = new BigInt64Array(batch * width), markerMask = new Uint8Array(batch * width);
          ids.fill(BigInt(tokenizer.pad_token_id ?? 0));
          selectedRows.forEach((row, i) => {
            ids.set(row.input_ids.map(BigInt), i * length); mask.fill(1, i * length, i * length + row.input_ids.length);
            markers.set(row.markers.map(BigInt), i * width); markerMask.fill(1, i * width, i * width + row.markers.length);
          });
          const feeds = { input_ids: tensor('int64', ids, [batch, length]), text_mask: tensor('bool', mask, [batch, length]), marker_pos: tensor('int64', markers, [batch, width]), marker_mask: tensor('bool', markerMask, [batch, width]), qtype: tensor('int64', BigInt64Array.from(selectedEntries, ([, q]) => BigInt({ choice: 0, score: 1, noul: 2 }[q.type])), [batch]), temperature: tensor('float32', Float32Array.from(selectedEntries, ([, q]) => temperature(q, config, input.images.length > 0)), [batch]), media_prefix: mediaFeed(chunks, mediaLength, batch) };
          let output;
          try {
            checkAbort(signal); output = await sessions.decision.run(feeds);
            const probabilities = await output.probabilities.getData(); await device?.queue.onSubmittedWorkDone(); checkAbort(signal);
            Object.assign(answers, d1Answers(selectedEntries, probabilities, width));
            batches.push({ question_ids: selectedEntries.map(([id]) => id), batch, text_length: length, options: width, attention_bytes: d1AttentionBytes(batch, length + mediaLength) });
          } finally { dispose(feeds); dispose(output); }
        }
        return { model, provider: D1_PROVIDER, answers: Object.fromEntries(entries.map(([id]) => [id, answers[id]])), usage: { input_tokens: rows.reduce((sum, row) => sum + row.input_ids.length + mediaLength, 0), output_tokens: 0 }, diagnostics: { dtype, generated_tokens: 0, batch: rows.length, text_length: Math.max(...rows.map(row => row.input_ids.length)), media_length: mediaLength, media_on_gpu: chunks.some(chunk => chunk.tensor), layouts, batches, attention_budget_bytes: budgetBytes, cpu_fallback_policy: 'CPU/WASM control/shape operators allowed; actual placement requires a separate profile.' } };
      } finally { for (const chunk of chunks) chunk.tensor?.dispose?.(); }
    },
    async dispose() { for (const session of Object.values(sessions)) await session.release(); device?.destroy(); },
  };
}
