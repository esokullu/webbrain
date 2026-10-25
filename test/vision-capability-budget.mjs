import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { encodedText, boundedDownloadedFile, boundedProgress, boundedProgressUpdate, boundedRecall } from '../src/chrome/src/agent/vision-capability-budget.js';
import { executeVisionCapability, visionTaskMemory, VISION_CAPABILITY_TOOLS } from '../src/chrome/src/agent/vision-capabilities.js';

const size = value => JSON.stringify(value).length;
test('both browser budgets are identical and measure escaped JSON, not raw character counts', async () => {
  assert.equal(await readFile(new URL('../src/chrome/src/agent/vision-capability-budget.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/firefox/src/agent/vision-capability-budget.js', import.meta.url), 'utf8'));
  const text = '\u0000"\\'.repeat(10000) + 'latest';
  assert.ok(size(encodedText(text, 500)) <= 500);
  assert.ok(size(encodedText(text, 500, true)) <= 500); assert.ok(encodedText(text, 500, true).endsWith('latest'));
});

test('every downloaded text-prefix character remains retrievable with truthful unread-suffix metadata', () => {
  const source = '\u0000"\\🙂'.repeat(4000);
  let offset = 0, combined = '', calls = 0;
  do {
    const result = boundedDownloadedFile({ success: true, text: source, filename: 'x'.repeat(20000),
      sizeBytes: 400000, bytesRead: 64000, contentSource: 'saved_local_file', savedFileVerified: true,
      sourceRefetched: false, truncated: true, originalLength: null, originalLengthKnown: false }, { downloadId: 7, offset, maxChars: 7000 });
    assert.ok(size(result) <= 12000); assert.equal(result.sourceTruncated, true); assert.equal(result.originalLengthKnown, false);
    assert.match(result.continuationNote, /unread suffix/); assert.equal(result.sourceRefetched, false);
    combined += result.text; offset = result.nextOffset; calls++;
    assert.ok(calls < 100, 'Pagination must always advance');
  } while (offset !== null);
  assert.equal(combined, source); assert.ok(calls > 2);
});

test('small binary downloads paginate on exact base64 groups without dropping bytes', () => {
  const bytes = Buffer.alloc(23000, 193), source = bytes.toString('base64'); let offset = 0, combined = '';
  do {
    const result = boundedDownloadedFile({ success: true, base64: source, sizeBytes: bytes.length, savedFileVerified: true }, { downloadId: 8, offset });
    assert.ok(size(result) < 12000); assert.equal(result.base64.length % 4, 0); combined += result.base64; offset = result.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.from(combined, 'base64'), bytes);
  const first = boundedDownloadedFile({ success: true, base64: source }, { maxChars: 1 });
  assert.equal(first.nextOffset, 4, 'Even a direct helper call cannot create a non-advancing binary page');
});

test('progress row and field pagination retrieves every original field under a strict result budget', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `row-${i}`, status: 'processed', fields: Object.fromEntries(
    Array.from({ length: 20 }, (_, field) => [`field-${field}`, `${i}:${field}:` + '\u0000'.repeat(490)])) }));
  let offset = 0, total = 0;
  while (offset !== null) {
    const page = boundedProgress({ success: true, rows: rows.slice(offset), counts: { total: rows.length, processed: rows.length } }, { offset, limit: 40 });
    assert.ok(size(page) <= 12000); assert.ok(page.rows.length > 0);
    for (const [index, row] of page.rows.entries()) {
      let fields = { ...row.fields }, fieldsOffset = row.nextFieldsOffset;
      while (fieldsOffset !== null) {
        const next = boundedProgress({ success: true, rows: rows.slice(offset + index), counts: { total: rows.length } }, { offset: offset + index, limit: 1, fieldsOffset });
        assert.ok(size(next) <= 12000); assert.ok(next.rows[0].nextFieldsOffset === null || next.rows[0].nextFieldsOffset > fieldsOffset);
        Object.assign(fields, next.rows[0].fields); fieldsOffset = next.rows[0].nextFieldsOffset;
      }
      assert.deepEqual(fields, rows[offset + index].fields); total++;
    }
    offset = page.nextOffset;
  }
  assert.equal(total, rows.length);
});

test('progress updates and recall return bounded useful receipts even with escaping and hostile extra fields', () => {
  const updated = boundedProgressUpdate({ success: true, updated: Array.from({ length: 400 }, (_, index) => ({
    id: `${index}` + '\u0000'.repeat(500), status: 'processed', fields: { enormous: 'x'.repeat(200000) } })),
  warnings: Array(100).fill('\u0000'.repeat(3000)), counts: { total: 400, processed: 400 } });
  assert.ok(size(updated) <= 12000); assert.equal(updated.updatedCount, 400); assert.equal(updated.counts.processed, 400);
  assert.equal(updated.truncated, true); assert.match(updated.note, /progress_read/);
  const recall = boundedRecall({ success: true, privateUnexpected: 'x'.repeat(1000000), results: Array(300).fill({ content: '\u0000'.repeat(10000), domain: 'x'.repeat(10000) }) });
  assert.ok(size(recall) <= 12000); assert.equal(recall.results.length, 5); assert.equal(recall.executable, false); assert.equal(recall.truncated, true);
  const failed = boundedDownloadedFile({ success: false, code: 'saved_download_changed', error: '\u0000'.repeat(10000) });
  assert.equal(failed.code, 'saved_download_changed'); assert.ok(size(failed) < 2500);
});

test('automatic task memory stays below ten thousand serialized characters without losing the progress cursor', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}`, status: 'pending', fields: { value: '\u0000'.repeat(500) } }));
  const memory = visionTaskMemory({ conversations: new Map([[1, [{ content: 'notes' }]]]), _findScratchpadIndex: () => 0,
    _extractScratchpadBody: () => '\u0000'.repeat(7990) + 'latest-note',
    _progressRead: () => ({ success: true, counts: { total: 40, pending: 40 }, rows }) }, 1);
  assert.ok(size(memory) < 10000); assert.ok(memory.scratchpad.endsWith('latest-note'));
  assert.equal(memory.progress.hasMore, true); assert.ok(memory.progress.nextOffset > 0);
});

test('utility catalog exposes pagination and oversized inputs fail before notes/progress/API mutation', async () => {
  const schema = name => VISION_CAPABILITY_TOOLS.find(item => item.function.name === name).function.parameters;
  assert.equal(schema('scratchpad_write').properties.text.maxLength, 8000);
  assert.equal(schema('progress_read').properties.limit.maximum, 40);
  assert.ok(schema('progress_read').properties.fieldsOffset); assert.ok(schema('read_downloaded_file').properties.offset);
  const result = await executeVisionCapability({ executeTool: () => assert.fail('No dispatch') }, {
    tabId: 1, name: 'scratchpad_write', args: { text: '\u0000'.repeat(8000) } });
  assert.equal(result.result.noDispatch, true); assert.equal(result.result.success, false);
});
