/**
 * WebBrain test runner — pure Node, no framework, no chrome.* APIs.
 *
 *   node test/run.js
 *
 * Tests are colocated with the runner. Each test is just an async function
 * that throws on failure. Output is one line per test, then a summary.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ────────────────────────────────────────────────────────────────────────
// Module loading
// ────────────────────────────────────────────────────────────────────────

// adapters.js is pure ESM with no chrome.* deps — import directly.
const { getActiveAdapter, listAdapters } = await import(
  'file://' + path.join(ROOT, 'src/chrome/src/agent/adapters.js').replace(/\\/g, '/')
);

// agent.js imports tools.js and cdp-client.js (which uses chrome.*). We need
// only the loop-detection helpers, so we extract them via a tiny standalone
// shim that mirrors the relevant Agent methods. Keep this in sync with
// agent.js _recordCall / _detectLoop / _checkLoop.
class LoopDetectorShim {
  constructor() {
    this.recentCalls = new Map();
    this.loopNudges = new Map();
    this.healthyCallsSinceLoop = new Map();
    this.recentCoordClicks = new Map();
  }
  _checkCoordClickLoop(tabId, x, y) {
    const bx = Math.round(x / 5) * 5;
    const by = Math.round(y / 5) * 5;
    const key = `${bx},${by}`;
    const buf = this.recentCoordClicks.get(tabId) || [];
    buf.push({ key, ts: Date.now() });
    if (buf.length > 12) buf.shift();
    this.recentCoordClicks.set(tabId, buf);
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    const n = counts.get(key) || 0;
    if (n >= 5) return { kind: 'stop', x: bx, y: by };
    if (n >= 3) return { kind: 'nudge', x: bx, y: by };
    return { kind: 'none' };
  }
  _recordCall(tabId, name, args, result) {
    const argsHash = JSON.stringify(args || {});
    const errored = !!(result && (result.error || result.success === false));
    const key = `${name}|${argsHash}|${errored ? 'err' : 'ok'}`;
    const buf = this.recentCalls.get(tabId) || [];
    buf.push({ key, name, ts: Date.now() });
    if (buf.length > 6) buf.shift();
    this.recentCalls.set(tabId, buf);
    return buf;
  }
  _detectLoop(buf) {
    if (!buf || buf.length < 3) return null;
    const counts = new Map();
    for (const e of buf) counts.set(e.key, (counts.get(e.key) || 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3) return { type: 'repeat', key, name: key.split('|')[0], count: n };
    }
    if (buf.length >= 4) {
      const last4 = buf.slice(-4);
      if (
        last4[0].key === last4[2].key &&
        last4[1].key === last4[3].key &&
        last4[0].key !== last4[1].key
      ) {
        return { type: 'oscillation', a: last4[0].name, b: last4[1].name };
      }
    }
    return null;
  }
  _checkLoop(tabId, name, args, result) {
    const buf = this._recordCall(tabId, name, args, result);
    const loop = this._detectLoop(buf);
    if (!loop) {
      const healthy = (this.healthyCallsSinceLoop.get(tabId) || 0) + 1;
      this.healthyCallsSinceLoop.set(tabId, healthy);
      if (healthy >= 3) {
        this.loopNudges.delete(tabId);
        this.healthyCallsSinceLoop.delete(tabId);
      }
      return { kind: 'none' };
    }
    this.healthyCallsSinceLoop.delete(tabId);
    const nudges = (this.loopNudges.get(tabId) || 0) + 1;
    this.loopNudges.set(tabId, nudges);
    if (nudges >= 4) {
      return { kind: 'stop' };
    }
    return { kind: 'nudge' };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Test framework (one function, no deps)
// ────────────────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${e.message}`);
      if (e.expected !== undefined || e.actual !== undefined) {
        console.log(`      expected: ${JSON.stringify(e.expected)}`);
        console.log(`      actual:   ${JSON.stringify(e.actual)}`);
      }
      failed++;
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed (${tests.length} total)`);
  if (failed > 0) process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────
// Adapter matching tests
// ────────────────────────────────────────────────────────────────────────

console.log('\nadapters');

test('matches github.com', () => {
  const a = getActiveAdapter('https://github.com/esokullu/webbrain');
  assert.equal(a?.name, 'github');
});

test('matches www.github.com', () => {
  const a = getActiveAdapter('https://www.github.com/');
  assert.equal(a?.name, 'github');
});

test('matches gmail.com under mail.google.com', () => {
  const a = getActiveAdapter('https://mail.google.com/mail/u/0/#inbox');
  assert.equal(a?.name, 'gmail');
});

test('matches twitter.com and x.com', () => {
  assert.equal(getActiveAdapter('https://twitter.com/elonmusk')?.name, 'twitter');
  assert.equal(getActiveAdapter('https://x.com/elonmusk')?.name, 'twitter');
});

test('matches stripe dashboard', () => {
  const a = getActiveAdapter('https://dashboard.stripe.com/payments');
  assert.equal(a?.name, 'stripe');
  assert.equal(a?.category, 'finance');
});

test('matches generic finance — coinbase', () => {
  const a = getActiveAdapter('https://www.coinbase.com/dashboard');
  assert.equal(a?.category, 'finance');
});

test('matches generic finance — chase', () => {
  const a = getActiveAdapter('https://secure01a.chase.com/web/auth/dashboard');
  assert.equal(a?.category, 'finance');
});

test('matches generic finance — robinhood', () => {
  const a = getActiveAdapter('https://robinhood.com/account/positions');
  assert.equal(a?.category, 'finance');
});

test('returns null for unknown sites', () => {
  assert.equal(getActiveAdapter('https://example.com/'), null);
  assert.equal(getActiveAdapter('https://random-site-xyz123.io/'), null);
});

test('handles missing url gracefully', () => {
  assert.equal(getActiveAdapter(''), null);
  assert.equal(getActiveAdapter(null), null);
  assert.equal(getActiveAdapter(undefined), null);
});

test('every adapter has the required fields', () => {
  for (const a of listAdapters()) {
    assert.ok(a.name, 'name missing');
    assert.ok(a.category === 'general' || a.category === 'finance', `bad category: ${a.category}`);
  }
});

test('finance adapters take precedence in order — stripe before generic', () => {
  // Stripe URL should match stripe, not the generic finance pattern.
  const a = getActiveAdapter('https://dashboard.stripe.com/');
  assert.equal(a?.name, 'stripe');
});

test('GitHub Enterprise does not match github adapter (strict)', () => {
  // The current matcher is `(www\.)?github\.com` so GHES won't match — that's
  // intentional and this test pins the behavior so a future loosening doesn't
  // accidentally apply github.com selectors to GHES.
  const a = getActiveAdapter('https://github.example-corp.com/foo/bar');
  assert.equal(a, null);
});

// ────────────────────────────────────────────────────────────────────────
// Loop detection tests
// ────────────────────────────────────────────────────────────────────────

console.log('\nloop detection');

test('no loop for distinct calls', () => {
  const d = new LoopDetectorShim();
  const tab = 1;
  assert.equal(d._checkLoop(tab, 'read_page', {}, { ok: true }).kind, 'none');
  assert.equal(d._checkLoop(tab, 'click', { selector: '#a' }, { success: true }).kind, 'none');
  assert.equal(d._checkLoop(tab, 'type_text', { text: 'hello' }, { success: true }).kind, 'none');
});

test('three identical calls trigger nudge', () => {
  const d = new LoopDetectorShim();
  const tab = 2;
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  const result = d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(result.kind, 'nudge');
});

test('three identical errored calls also trigger nudge', () => {
  const d = new LoopDetectorShim();
  const tab = 3;
  d._checkLoop(tab, 'click', { selector: '#missing' }, { success: false });
  d._checkLoop(tab, 'click', { selector: '#missing' }, { success: false });
  const result = d._checkLoop(tab, 'click', { selector: '#missing' }, { success: false });
  assert.equal(result.kind, 'nudge');
});

test('errored vs successful do not collapse together', () => {
  // Two successes + one failure of the same call should NOT trigger.
  const d = new LoopDetectorShim();
  const tab = 4;
  d._checkLoop(tab, 'click', { selector: '#x' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#x' }, { success: true });
  const result = d._checkLoop(tab, 'click', { selector: '#x' }, { success: false });
  assert.equal(result.kind, 'none');
});

test('ABAB oscillation triggers nudge', () => {
  const d = new LoopDetectorShim();
  const tab = 5;
  d._checkLoop(tab, 'click', { selector: '#next' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#prev' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#next' }, { success: true });
  const result = d._checkLoop(tab, 'click', { selector: '#prev' }, { success: true });
  assert.equal(result.kind, 'nudge');
});

test('fourth consecutive loop triggers stop', () => {
  const d = new LoopDetectorShim();
  const tab = 6;
  // First nudge
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true }).kind, 'nudge');
  // Continue looping — nudges 2 and 3 are still nudges.
  assert.equal(d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true }).kind, 'nudge');
  assert.equal(d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true }).kind, 'nudge');
  // Fourth nudge → stop.
  const result = d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(result.kind, 'stop');
});

test('nudge counter persists across one healthy call (slow loop)', () => {
  const d = new LoopDetectorShim();
  const tab = 7;
  // Get to nudge state
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true }).kind, 'nudge');
  // One healthy interleaved call — must NOT reset nudge state (need 3 to reset).
  d._checkLoop(tab, 'read_page', {}, { ok: true });
  // Resume the loop. The window still has enough #submit entries to detect.
  // loopNudges is still 1 (one healthy call doesn't reset), so this is nudge #2.
  const result = d._checkLoop(tab, 'click', { selector: '#submit' }, { success: true });
  assert.equal(result.kind, 'nudge', `expected nudge, got ${result.kind}`);
});

test('nudge counter resets after a sustained healthy streak', () => {
  const d = new LoopDetectorShim();
  const tab = 8;
  // Get to nudge state
  d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  assert.equal(d._checkLoop(tab, 'click', { selector: '#a' }, { success: true }).kind, 'nudge');
  // Four distinct healthy calls — resets nudge state (threshold is 3) AND
  // pushes old #a entries out of the 6-element buffer window.
  for (let i = 0; i < 4; i++) {
    d._checkLoop(tab, 'read_page', { i }, { ok: true });
  }
  // Now nudges should be cleared and buffer doesn't have 3× #a.
  const result = d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  assert.equal(result.kind, 'none');
});

test('tabs are isolated from each other', () => {
  const d = new LoopDetectorShim();
  // Three identical calls on tab A should NOT affect tab B.
  d._checkLoop(10, 'click', { selector: '#x' }, { success: true });
  d._checkLoop(10, 'click', { selector: '#x' }, { success: true });
  d._checkLoop(10, 'click', { selector: '#x' }, { success: true });
  const result = d._checkLoop(20, 'click', { selector: '#x' }, { success: true });
  assert.equal(result.kind, 'none');
});

// ────────────────────────────────────────────────────────────────────────
// Coordinate-click loop detector tests
// ────────────────────────────────────────────────────────────────────────

test('coord click: first call → none', () => {
  const d = new LoopDetectorShim();
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'none');
});

test('coord click: second identical → none (relaxed thresholds)', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'none');
});

test('coord click: third identical → nudge', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'nudge');
});

test('coord click: fifth identical → stop', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'stop');
});

test('coord click: 5px drift collapses to same bucket', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  // (102, 199) rounds to (100, 200) — third identical bucket → nudge
  assert.equal(d._checkCoordClickLoop(1, 102, 199).kind, 'nudge');
});

test('coord click: 10px drift = different bucket', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  // (115, 200) rounds to (115, 200) — different bucket
  assert.equal(d._checkCoordClickLoop(1, 115, 200).kind, 'none');
});

test('coord click: survives interleaved noise (the failure mode this fixes)', () => {
  // This is the exact pattern from the user trace: click(267,226), then a
  // bunch of unrelated calls, then click(267,226) again. The general
  // detector misses it because the unrelated calls fragment the buffer
  // hash. The coordinate detector should catch it.
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 267, 226); // 1st
  d._checkCoordClickLoop(1, 267, 226); // 2nd — still none
  assert.equal(d._checkCoordClickLoop(1, 267, 226).kind, 'nudge'); // 3rd → nudge
  // Even with many other coord clicks in between, the fifth (267,226) stops.
  d._checkCoordClickLoop(1, 500, 500);
  d._checkCoordClickLoop(1, 600, 100);
  d._checkCoordClickLoop(1, 50, 50);
  assert.equal(d._checkCoordClickLoop(1, 267, 226).kind, 'nudge'); // 4th → nudge
  assert.equal(d._checkCoordClickLoop(1, 267, 226).kind, 'stop'); // 5th → stop
});

test('coord click: tabs are isolated', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200);
  d._checkCoordClickLoop(1, 100, 200);
  // Same coords on a different tab — should still be 'none'
  assert.equal(d._checkCoordClickLoop(2, 100, 200).kind, 'none');
});

test('coord click: window of 12 — old entries roll out', () => {
  const d = new LoopDetectorShim();
  d._checkCoordClickLoop(1, 100, 200); // first
  // 12 distinct intervening clicks
  for (let i = 0; i < 12; i++) {
    d._checkCoordClickLoop(1, 50 + i * 20, 50);
  }
  // The original (100,200) has been pushed out. Next (100,200) is fresh.
  assert.equal(d._checkCoordClickLoop(1, 100, 200).kind, 'none');
});

test('window of 6 means a loop can fall out of the window', () => {
  const d = new LoopDetectorShim();
  const tab = 11;
  // Two #a, then 5 distinct calls — by then the buffer has rolled past #a.
  d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  for (let i = 0; i < 5; i++) {
    d._checkLoop(tab, 'read_page', { i }, { ok: true });
  }
  // The buffer is now: [a, read_page×5] — only one #a remains. Another #a
  // makes it 2× — still under the 3× threshold.
  const result = d._checkLoop(tab, 'click', { selector: '#a' }, { success: true });
  assert.equal(result.kind, 'none');
});

await run();
