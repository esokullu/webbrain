import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Replay every case's saved messages, including its original mode and tool set.
// A single frozen system prompt cannot preserve both Act and Ask scenarios.
export function loadReplay(path, { browser, tier, incompatible = false } = {}) {
  if (!path) return null;
  if (incompatible) throw new Error('--replay cannot be combined with prompt/mode overrides or chat-template compatibility.');
  const bytes = readFileSync(path);
  const snapshot = JSON.parse(bytes.toString('utf8'));
  if (snapshot.schema !== 'webbrain.compact-replay.v1' || !snapshot.firstTurn || !snapshot.scenarios || !snapshot.tools) {
    throw new Error('Invalid replay snapshot.');
  }
  if (snapshot.browser !== browser || snapshot.tier !== tier) throw new Error('Replay browser/tier does not match the requested run.');
  return { snapshot, meta: { path, sha256: createHash('sha256').update(bytes).digest('hex'), ...snapshot.meta } };
}

export function replayCase(replay, track, id, model) {
  if (!replay) return null;
  const saved = replay.snapshot[track]?.[id];
  if (!saved) throw new Error(`Replay is missing ${track}/${id}.`);
  if (saved.skipped) return { skipped: saved.skipped, expected: saved.expected };
  const tools = replay.snapshot.tools[saved.mode];
  if (!Array.isArray(saved.messages) || !Array.isArray(tools)) throw new Error(`Replay payload is incomplete: ${track}/${id}.`);
  return {
    body: structuredClone({ model, temperature: saved.temperature, max_tokens: saved.max_tokens, messages: saved.messages, tools }),
    expected: saved.expected,
  };
}
