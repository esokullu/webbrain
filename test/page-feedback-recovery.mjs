import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

for (const browser of ['chrome', 'firefox']) {
  const recovery = await import(`../src/${browser}/src/agent/page-feedback-recovery.js`);
  const { accountFeedbackSupersession, resetFeedbackSupersession, feedbackSupersessionMetadata,
    PAGE_FEEDBACK_NUDGE_AT, PAGE_FEEDBACK_STOP_AT, PAGE_FEEDBACK_STOP_CODE } = recovery;

  test(`${browser}: repeated passive no-dispatch responses have a bounded recovery budget`, () => {
    const run = {};
    const attempts = Array.from({ length: 12 }, () => accountFeedbackSupersession(run, {
      passive: true, stage: 'response', toolNames: ['click_ax'],
    }));
    assert.equal(attempts.filter(attempt => attempt.nudge).length, 1);
    assert.equal(attempts[PAGE_FEEDBACK_NUDGE_AT - 1].nudge, true);
    assert.ok(attempts.slice(0, PAGE_FEEDBACK_STOP_AT - 1).every(attempt => !attempt.stop));
    assert.ok(attempts.slice(PAGE_FEEDBACK_STOP_AT - 1).every(attempt => attempt.stop));
    assert.equal(attempts.at(-1).streak, PAGE_FEEDBACK_STOP_AT);
    assert.equal(attempts.at(-1).code, PAGE_FEEDBACK_STOP_CODE);
    assert.match(attempts.at(-1).message, /task is incomplete/i);
    assert.match(attempts.at(-1).message, /no stale action was dispatched/i);
  });

  test(`${browser}: changing tools or moving the race into preparation cannot evade the budget`, () => {
    const run = {};
    const calls = [
      ['response', 'click_ax'], ['preparation', 'type_ax'], ['response', 'set_field'],
      ['preparation', 'click'], ['response', 'press_keys'],
    ];
    const results = calls.map(([stage, name]) => accountFeedbackSupersession(run, {
      passive: true, stage, toolNames: [name],
    }));
    assert.equal(results.at(-1).stop, true);
    assert.deepEqual(results.map(result => result.streak), [1, 2, 3, 4, 5]);
  });

  test(`${browser}: actual steering or browser intervention starts a fresh budget`, () => {
    const run = {};
    for (let i = 0; i < PAGE_FEEDBACK_STOP_AT - 1; i++) accountFeedbackSupersession(run, { passive: true });
    const intervention = accountFeedbackSupersession(run, { passive: false, stage: 'response' });
    assert.equal(intervention.stop, false);
    assert.equal(intervention.streak, 0);
    assert.equal(accountFeedbackSupersession(run, { passive: true }).streak, 1);
  });

  test(`${browser}: accepted dispatch resets the budget and long productive watches do not accumulate retries`, () => {
    const run = {};
    for (let poll = 0; poll < 1000; poll++) {
      const pending = accountFeedbackSupersession(run, { passive: true, toolNames: ['read_page'] });
      assert.equal(pending.streak, 1);
      assert.equal(pending.stop, false);
      resetFeedbackSupersession(run);
    }
    assert.equal(run.passiveSupersessionStreak, 0);
    assert.deepEqual(Object.keys(run), ['passiveSupersessionStreak'], 'The watchdog must not retain wall-clock or watch duration state');
  });

  test(`${browser}: state is run-owned and invalid inherited values cannot prematurely stop a run`, () => {
    const oldRun = {};
    for (let i = 0; i < PAGE_FEEDBACK_STOP_AT; i++) accountFeedbackSupersession(oldRun, { passive: true });
    assert.equal(accountFeedbackSupersession({}, { passive: true }).streak, 1);
    for (const invalid of [-1, 1.2, NaN, Infinity, '4']) {
      assert.equal(accountFeedbackSupersession({ passiveSupersessionStreak: invalid }, { passive: true }).streak, 1);
    }
    assert.equal(accountFeedbackSupersession(null, { passive: true }).stop, false);
  });

  test(`${browser}: recovery diagnostics exclude page data, arguments and unexpected text`, () => {
    const metadata = feedbackSupersessionMetadata({
      stage: 'https://secret.example/private', streak: Infinity,
      toolNames: ['click_ax', 'click_ax', 'read_page', 'https://secret.example/private', 'type_ax\nsecret', 'A'.repeat(100), null],
      arguments: { text: 'secret' }, pageContent: 'secret', url: 'https://secret.example/private',
    });
    assert.deepEqual(metadata, { stage: 'unknown', streak: 0, toolNames: ['click_ax', 'read_page'] });
    const manyNames = feedbackSupersessionMetadata({ toolNames: Array.from({ length: 50 }, (_, i) => `tool_${i}`) });
    assert.equal(manyNames.toolNames.length, 16);
  });
}

test('Chrome and Firefox feedback recovery stay byte-identical', () => {
  assert.equal(
    fs.readFileSync(new URL('../src/chrome/src/agent/page-feedback-recovery.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/firefox/src/agent/page-feedback-recovery.js', import.meta.url), 'utf8'),
  );
});
