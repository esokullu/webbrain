import assert from 'node:assert/strict';
import { test } from 'node:test';

const passive = [{ kind: 'dom', source: 'page', frameId: 0, target: 'span#views' }];
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
const page = {
  success: true,
  pageContent: 'region "Photo editor" [ref_1]\n heading "Current photo" [ref_2]\n form "Details" [ref_3]\n'
    + '  textbox "Caption" [ref_4] value="Original"\n  checkbox "Visible" [ref_5] checked=false\n'
    + '  button "Preview" [ref_6] type="button"\n  button "Save" [ref_7] type="submit"\n'
    + 'region "Timeline" [ref_8]\n text "12 views"',
};

for (const build of ['chrome', 'firefox']) {
  const { canRetainPageFeedbackCalls } = await import(`../src/${build}/src/agent/page-feedback-policy.js`);
  const keep = (name, args, current = page, events = passive) =>
    canRetainPageFeedbackCalls([call(name, args)], { url: 'https://example.com/photo/1', page }, current, events);

  for (const name of ['fetch_url', 'research_url']) {
    for (const method of [undefined, 'GET', 'HEAD', 'get', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const expected = method == null || ['GET', 'HEAD'].includes(method.toUpperCase());
      test(`${build}: passive churn ${expected ? 'retains' : 'supersedes'} explicit ${name} ${method || 'default GET'}`, () => {
        assert.equal(keep(name, { url: 'https://example.com/resource', ...(method ? { method } : {}) }), expected);
      });
    }
    for (const extra of [{ replayRequestId: 'captured-post' }, { method: 'GET', replayRequestId: 'captured-post' },
      { body: 'changed-server-data' }, { method: 'GET', body: '{}' }]) {
      test(`${build}: passive churn supersedes ${name} ${Object.keys(extra).join('+')} payload`, () => {
        assert.equal(keep(name, { url: 'https://example.com/resource', ...extra }), false,
          'A concrete URL does not make mutation/replay arguments independent of page state');
      });
    }
  }

  for (const [name, args] of [
    ['click_ax', { ref_id: 'ref_6' }],
    ['type_ax', { ref_id: 'ref_4', text: 'Updated caption' }],
    ['set_field', { ref_id: 'ref_4', text: 'Updated caption' }],
    ['set_checked', { ref_id: 'ref_5', checked: true }],
  ]) {
    test(`${build}: passive counter updates retain unchanged ${name} action context`, () => {
      assert.equal(keep(name, args, { ...page, pageContent: page.pageContent.replace('12 views', '13 views') }), true);
    });
    test(`${build}: passive changes to form values supersede ${name}`, () => {
      assert.equal(keep(name, args, { ...page, pageContent: page.pageContent.replace('value="Original"', 'value="Someone else edited this"') }), false);
    });
    test(`${build}: passive changes to the enclosing entity supersede ${name}`, () => {
      assert.equal(keep(name, args, { ...page, pageContent: page.pageContent.replace('Current photo', 'Different photo') }), false,
        'A heading outside the nearest form still identifies which entity the form acts on');
    });
  }

  test(`${build}: a changed recipient heading outside the nearest form invalidates the send button`, () => {
    const composer = { success: true, pageContent: 'region "Message composer" [ref_1]\n heading "Gamze" [ref_2]\n'
      + ' form "Message" [ref_3]\n  textbox "Message" [ref_4] value="hello"\n  button "Send" [ref_5] type="button"' };
    const changed = { ...composer, pageContent: composer.pageContent.replace('Gamze', 'Someone else') };
    assert.equal(canRetainPageFeedbackCalls([call('click_ax', { ref_id: 'ref_5' })], { page: composer }, changed,
      [{ kind: 'dom', source: 'page', frameId: 0, target: 'h2' }]), false);
  });

  test(`${build}: a native submit remains conservative even with an unchanged snapshot`, () => {
    assert.equal(keep('click_ax', { ref_id: 'ref_7' }), false);
  });
}
