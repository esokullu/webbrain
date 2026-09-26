import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayCase } from './replay-payload.mjs';

test('replay retains distinct Act/Ask tools and seeded history without mutating the snapshot', () => {
  const replay = { snapshot: {
    tools: { act: [{ function: { name: 'navigate' } }], ask: [{ function: { name: 'read_page' } }] },
    firstTurn: { '001': { mode: 'act', messages: [{ role: 'user', content: 'original' }], temperature: 0.15, max_tokens: 4096 } },
    scenarios: { '071': { mode: 'ask', messages: [{ role: 'tool', content: 'original result' }], temperature: 0.3, max_tokens: 4096, expected: { idealNextToolCall: { name: 'done' } } } },
  } };
  const first = replayCase(replay, 'firstTurn', '001', 'new-model');
  const scenario = replayCase(replay, 'scenarios', '071', 'new-model');
  assert.equal(first.body.tools[0].function.name, 'navigate');
  assert.equal(scenario.body.tools[0].function.name, 'read_page');
  assert.deepEqual(scenario.body.messages, replay.snapshot.scenarios['071'].messages);
  assert.equal(scenario.body.model, 'new-model');
  assert.equal(scenario.body.temperature, 0.3);
  first.body.messages[0].content = 'changed';
  assert.equal(replay.snapshot.firstTurn['001'].messages[0].content, 'original');
});

test('replay never sends skipped cases and fails on missing cases', () => {
  const replay = { snapshot: { scenarios: { '021': { skipped: 'Compact Dev', expected: {} } } } };
  assert.deepEqual(replayCase(replay, 'scenarios', '021', 'model'), { skipped: 'Compact Dev', expected: {} });
  assert.throws(() => replayCase(replay, 'scenarios', '099', 'model'), /missing/);
});
