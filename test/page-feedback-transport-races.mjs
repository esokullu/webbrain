import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const { pageFeedbackMethods } = await import(`../src/${build}/src/agent/page-feedback.js`);
  const tab = 901;
  const makeAgent = () => {
    const frame = { token: 'document-token', id: 'document-id' };
    const run = { token: 'run-token', url: 'https://example.test/task', events: new Map(), frames: new Map([[0, frame]]) };
    run.modelState = { token: run.token, url: run.url, frames: new Map([[0, { ...frame }]]), steeringRevision: 0 };
    const agent = Object.assign({ _pageFeedbackRuns: new Map([[tab, run]]), currentRunId: new Map(),
      _hasPendingSteering: () => false,
      conversations: new Map([[tab, []]]), _appOwnedUserMessage: (content, kind) => ({ role: 'user', content, webbrainAppOwnedKind: kind }) }, pageFeedbackMethods);
    return { agent, run };
  };
  const noDispatch = { success: false, pageFeedbackPending: true, noDispatch: true, dispatched: false };

  test(`${build}: preparation failures consume the retry budget before delayed DOM feedback arrives`, () => {
    const { agent, run } = makeAgent();
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(agent._accountPageFeedbackNoDispatch(tab, 'type_ax', noDispatch), true);
    }
    assert.equal(run.recoveryResult?.code, 'page_unstable', 'A content guard may reject immediately while its DOM callback is still coalesced');
    assert.equal(run.passiveSupersessionStreak, 5);
  });

  test(`${build}: later human feedback resets unresolved preparation retries`, () => {
    const { agent, run } = makeAgent();
    for (let attempt = 0; attempt < 4; attempt++) agent._accountPageFeedbackNoDispatch(tab, 'type_ax', noDispatch);
    run.events.set('human', { kind: 'click', source: 'user', frameId: 0, target: 'button#human' });
    agent._accountPageFeedbackNoDispatch(tab, 'type_ax', noDispatch);
    assert.equal(run.passiveSupersessionStreak, 0);
    assert.equal(run.recoveryResult, undefined);
  });

  test(`${build}: pending steering supersedes a terminal recovery from the previous task`, () => {
    const { agent, run } = makeAgent();
    run.passiveSupersessionStreak = 5;
    run.recoveryResult = { code: 'page_unstable', message: 'Old task could not dispatch safely.' };
    agent._hasPendingSteering = () => true;
    assert.equal(agent._pageFeedbackRecoveryResult(tab, [], () => {}), null,
      'The next user instruction must reach steering revalidation before old-task recovery can terminate');
    assert.equal(run.passiveSupersessionStreak, 0);
    assert.ok(!run.recoveryResult);
  });
}
