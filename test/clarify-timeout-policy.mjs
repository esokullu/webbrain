// Settings → General → "When a question times out": 'finish' (default) keeps
// an unattended run moving, 'safe' takes the safe first option. Questions
// about the short list of consequential actions always take the safe answer,
// and so does a question the model did not classify as consequence 'none'.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) } };

const read = rel => fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  policy: await import(`../src/${build}/src/agent/clarify-timeout.js`),
  Capability: (await import(`../src/${build}/src/agent/permission-gate.js`)).Capability,
})));

// Ask a question and answer it as a timeout. `answer` is what the side panel's
// backup timer sends; the agent must apply its own decided answer instead.
async function askAndTimeOut(agent, tab, args, { source = 'timeout', answer = 'whatever the panel sent' } = {}) {
  const updates = [];
  const result = await agent.executeTool(tab, 'clarify', args, (type, data) => {
    updates.push({ type, data });
    if (type === 'clarify') agent.submitClarifyResponse(tab, data.clarifyId, answer, source);
  });
  return { result, prompt: updates.find(update => update.type === 'clarify')?.data, updates };
}

test('both builds ship the same timeout policy module', async () => {
  assert.equal(await read('src/chrome/src/agent/clarify-timeout.js'), await read('src/firefox/src/agent/clarify-timeout.js'));
});

for (const { build, Agent, policy, Capability } of builds) {
  test(`${build}: the timeout choice follows the policy and keeps consequential questions safe`, () => {
    const { clarifyTimeoutChoice, CLARIFY_CONTINUE_ANSWER, CLARIFY_TIMEOUT_ANSWER, normalizeClarifyTimeoutPolicy } = policy;
    assert.equal(normalizeClarifyTimeoutPolicy(undefined), 'finish');
    assert.equal(normalizeClarifyTimeoutPolicy('safe'), 'safe');
    assert.equal(normalizeClarifyTimeoutPolicy('anything'), 'finish');
    const options = ['Keep the draft', 'Commit it'];
    assert.deepEqual(clarifyTimeoutChoice({ policy: 'finish', options, finishOption: 'Commit it' }),
      { policy: 'finish', answer: 'Commit it', authorized: true, chosen: 'finish_option' });
    assert.deepEqual(clarifyTimeoutChoice({ policy: 'finish', options, finishOption: 'Not an option' }),
      { policy: 'finish', answer: CLARIFY_CONTINUE_ANSWER, authorized: true, chosen: 'continue' });
    assert.deepEqual(clarifyTimeoutChoice({ policy: 'finish', options, safeFirst: true }),
      { policy: 'finish', answer: 'Keep the draft', authorized: true, chosen: 'safe_first' });
    assert.deepEqual(clarifyTimeoutChoice({ policy: 'finish', options: [] }),
      { policy: 'finish', answer: CLARIFY_CONTINUE_ANSWER, authorized: true, chosen: 'continue' });
    assert.deepEqual(clarifyTimeoutChoice({ policy: 'finish', options, finishOption: 'Commit it', hardQuestion: true }),
      { policy: 'safe', answer: 'Keep the draft', authorized: false, chosen: 'first_option' });
    assert.deepEqual(clarifyTimeoutChoice({ policy: 'safe', options, finishOption: 'Commit it' }),
      { policy: 'safe', answer: 'Keep the draft', authorized: false, chosen: 'first_option' });
    assert.deepEqual(clarifyTimeoutChoice({ policy: 'safe', options: [] }),
      { policy: 'safe', answer: CLARIFY_TIMEOUT_ANSWER, authorized: false, chosen: 'none' });
    assert.equal(clarifyTimeoutChoice({ policy: 'safe', options, safeFirst: true }).authorized, true);
    for (const policyName of ['finish', 'safe']) {
      assert.deepEqual(clarifyTimeoutChoice({ policy: policyName, options, safeFirst: true, hardQuestion: true }),
        { policy: 'safe', answer: 'Keep the draft', authorized: false, chosen: 'first_option' },
        `${policyName}: safe_first must not authorize a hard question`);
    }
  });

  test(`${build}: only a question classified 'none' may finish on its own; anything else fails closed`, () => {
    const { normalizeClarifyConsequence, clarifyQuestionIsHard, CLARIFY_NO_CONSEQUENCE } = policy;
    assert.equal(CLARIFY_NO_CONSEQUENCE, 'none');
    assert.equal(normalizeClarifyConsequence('none'), 'none');
    assert.equal(normalizeClarifyConsequence('deletion'), 'deletion');
    for (const value of [undefined, null, '', 'maybe', 'NONE', 0]) assert.equal(normalizeClarifyConsequence(value), null);
    assert.equal(clarifyQuestionIsHard('none'), false);
    for (const value of [null, 'deletion', 'money', 'credentials', 'recipient', 'publication']) {
      assert.equal(clarifyQuestionIsHard(value), true, String(value));
    }
  });

  test(`${build}: an unclassified question times out to the safe answer even on the finish setting`, async () => {
    for (const [index, consequence] of [undefined, 'maybe'].entries()) {
      const agent = new Agent({});
      agent.clarifyTimeoutSec = 30;
      const tab = 9160 + index;
      const args = { question: 'Delete the 40 archived emails?', options: ['Keep them', 'Delete them'], finish_option: 'Delete them',
        ...(consequence === undefined ? {} : { consequence }) };
      const { result, prompt } = await askAndTimeOut(agent, tab, args, { answer: 'Delete them' });
      assert.equal(prompt.timeoutPolicy, 'safe', `${consequence}: the card announces the safe answer`);
      assert.equal(result.answer, 'Keep them');
      assert.equal(result.authorized, false, `${consequence}: an unclassified question was approved by a timeout`);
      assert.ok(agent._clarificationAuthorizationBlock(tab, 'click_ax', {}, [Capability.CLICK]), 'consequential actions stay blocked');
    }
    const instant = new Agent({});
    instant.clarifyTimeoutSec = 0;
    const instantResult = await instant.executeTool(9162, 'clarify', {
      question: 'Delete the 40 archived emails?', options: ['Keep them', 'Delete them'], finish_option: 'Delete them',
    }, () => {});
    assert.equal(instantResult.answer, 'Keep them');
    assert.equal(instantResult.authorized, false, 'Instant must not approve an unclassified question');
  });

  test(`${build}: by default a timed-out question applies finish_option and the run continues`, async () => {
    const agent = new Agent({});
    assert.equal(agent.clarifyTimeoutPolicy, 'finish', 'finishing the task is the default');
    agent.clarifyTimeoutSec = 30;
    const tab = 9101;
    const { result, prompt } = await askAndTimeOut(agent, tab, {
      question: 'The editor could not be verified exactly. Commit the post as it appears?',
      options: ['Leave it uncommitted', 'Commit it'],
      finish_option: 'Commit it',
      consequence: 'none',
    });
    assert.equal(prompt.timeoutAnswer, 'Commit it', 'the card counts down to the finishing answer');
    assert.equal(prompt.timeoutPolicy, 'finish');
    assert.equal(result.source, 'timeout');
    assert.equal(result.answer, 'Commit it', 'the decided answer applies whatever the panel sent');
    assert.equal(result.authorized, true);
    assert.equal(result.requiresExplicitConfirmation, false);
    assert.match(result.note, /finish_option was selected and applies as their answer/);
    assert.equal(agent._clarificationAuthorizationGuards.has(tab), false, 'no timeout guard is armed');
    assert.equal(agent._clarificationAuthorizationBlock(tab, 'click_ax', {}, [Capability.CLICK]), null, 'the next click is not blocked');
    assert.equal(agent._clarificationAuthorizationBlock(tab, 'done', { outcome: 'success' }, []), null, 'success is not blocked');
  });

  test(`${build}: without finish_option a finish timeout lets the model continue`, async () => {
    const agent = new Agent({});
    agent.clarifyTimeoutSec = 30;
    const tab = 9102;
    const { result, prompt } = await askAndTimeOut(agent, tab, {
      question: 'Which of the two API keys did you mean?',
      options: ['The WordPress application password', 'The plugin key'],
      consequence: 'none',
    });
    assert.equal(prompt.timeoutContinues, true, 'the card says the run continues on its own');
    assert.equal(result.answer, policy.CLARIFY_CONTINUE_ANSWER);
    assert.equal(result.authorized, true);
    assert.match(result.note, /keep the task moving/);
    assert.match(result.note, /say which choice you made/);
    assert.equal(agent._clarificationAuthorizationGuards.has(tab), false);
  });

  test(`${build}: questions about consequential actions always time out to the safe answer`, async () => {
    for (const [index, args] of [
      { question: 'Delete all 40 archived emails?', options: ['Keep them', 'Delete them'], finish_option: 'Delete them', consequence: 'deletion' },
      { question: 'Pay the $49 renewal now?', options: ['Do not pay', 'Pay now'], finish_option: 'Pay now', consequence: 'money' },
      { question: 'Use the saved password to sign in?', options: ['Do not sign in', 'Sign in'], finish_option: 'Sign in', consequence: 'credentials' },
      { question: 'Post this to your public profile?', options: ['Keep it as a draft', 'Post it'], finish_option: 'Post it', consequence: 'publication' },
      { question: 'Who should get this message?', options: ['Nobody yet', 'Alex'], finish_option: 'Alex', purpose: 'message_recipient' },
    ].entries()) {
      const agent = new Agent({});
      agent.clarifyTimeoutSec = 30;
      const tab = 9110 + index;
      const { result, prompt } = await askAndTimeOut(agent, tab, args, { answer: args.finish_option });
      assert.equal(prompt.timeoutPolicy, 'safe', `${args.question}: the card announces the safe answer`);
      assert.equal(prompt.timeoutAnswer, args.options[0]);
      assert.equal(result.answer, args.options[0], `${args.question}: the panel's answer did not override the safe one`);
      assert.equal(result.authorized, false, `${args.question}: a timeout approved a consequential action`);
      assert.match(result.note, /NOT a real user confirmation/);
      assert.ok(agent._clarificationAuthorizationBlock(tab, 'click_ax', {}, [Capability.CLICK]), `${args.question}: consequential actions stay blocked`);
    }
  });

  test(`${build}: safe_first does not let a consequential or unclassified question approve itself`, async () => {
    const cases = [
      { question: 'Delete all 40 archived emails?', options: ['Delete them', 'Keep them'], safe_first: true, consequence: 'deletion' },
      { question: 'Delete all 40 archived emails?', options: ['Delete them', 'Keep them'], safe_first: true },
      { question: 'Who should get this message?', options: ['Alex', 'Nobody yet'], safe_first: true, purpose: 'message_recipient', consequence: 'none' },
    ];
    for (const [index, args] of cases.entries()) {
      for (const [mode, timeoutSec] of [['waited', 30], ['instant', 0]]) {
        for (const timeoutPolicy of ['finish', 'safe']) {
          const agent = new Agent({});
          agent.clarifyTimeoutSec = timeoutSec;
          agent.clarifyTimeoutPolicy = timeoutPolicy;
          const tab = 9170 + index * 4 + (mode === 'instant' ? 2 : 0) + (timeoutPolicy === 'safe' ? 1 : 0);
          const label = `${args.consequence || 'unclassified'}${args.purpose ? `/${args.purpose}` : ''} ${mode} ${timeoutPolicy}`;
          const result = mode === 'instant'
            ? await agent.executeTool(tab, 'clarify', args, () => {})
            : (await askAndTimeOut(agent, tab, args, { answer: args.options[0] })).result;
          assert.equal(result.answer, args.options[0], `${label}: the first option is the timed answer`);
          assert.equal(result.authorized, false, `${label}: safe_first approved a consequential question`);
          assert.equal(result.requiresExplicitConfirmation, true, label);
          assert.ok(agent._clarificationAuthorizationBlock(tab, 'click_ax', {}, [Capability.CLICK]), `${label}: consequential actions stay blocked`);
          assert.ok(agent._clarificationAuthorizationBlock(tab, 'done', { outcome: 'success' }, []), `${label}: success stays blocked`);
        }
      }
    }
  });

  test(`${build}: the safe setting keeps today's behavior`, async () => {
    const agent = new Agent({});
    agent.clarifyTimeoutPolicy = 'safe';
    agent.clarifyTimeoutSec = 30;
    const tab = 9120;
    const unsafe = await askAndTimeOut(agent, tab, {
      question: 'Commit the post?', options: ['Leave it uncommitted', 'Commit it'], finish_option: 'Commit it', consequence: 'none',
    });
    assert.equal(unsafe.prompt.timeoutPolicy, 'safe');
    assert.equal(unsafe.result.answer, 'Leave it uncommitted');
    assert.equal(unsafe.result.authorized, false);
    assert.ok(agent._clarificationAuthorizationBlock(tab, 'click_ax', {}, [Capability.CLICK]));

    const other = new Agent({});
    other.clarifyTimeoutPolicy = 'safe';
    other.clarifyTimeoutSec = 30;
    const safeFirst = await askAndTimeOut(other, 9121, {
      question: 'Continue browsing?', options: ['Continue browsing', 'Stop'], safe_first: true, consequence: 'none',
    });
    assert.equal(safeFirst.result.authorized, true, 'safe_first still applies on the safe setting');
  });

  test(`${build}: a finish timeout cannot clear a guard armed by an earlier unanswered consequential question`, async () => {
    const agent = new Agent({});
    agent.clarifyTimeoutSec = 30;
    const tab = 9130;
    await askAndTimeOut(agent, tab, {
      question: 'Delete the old drafts?', options: ['Keep them', 'Delete them'], consequence: 'deletion',
    });
    const reasked = await askAndTimeOut(agent, tab, {
      question: 'Should I go ahead?', options: ['Wait', 'Go ahead'], finish_option: 'Go ahead', consequence: 'none',
    });
    assert.equal(reasked.result.authorized, false, 're-asking without the consequence did not approve it');
    assert.ok(agent._clarificationAuthorizationBlock(tab, 'click_ax', {}, [Capability.CLICK]));
    const answered = await askAndTimeOut(agent, tab, {
      question: 'Delete the old drafts?', options: ['Keep them', 'Delete them'], consequence: 'deletion',
    }, { source: 'option', answer: 'Delete them' });
    assert.equal(answered.result.authorized, true, 'a real answer still authorizes');
    assert.equal(answered.result.answer, 'Delete them');
    assert.equal(agent._clarificationAuthorizationGuards.has(tab), false);
  });

  test(`${build}: the agent's own timer applies the decided answer and tells the panel`, async () => {
    const agent = new Agent({});
    agent.clarifyTimeoutSec = 1;
    const tab = 9140;
    const updates = [];
    const result = await agent.executeTool(tab, 'clarify', {
      question: 'Which list should I use?', options: ['The first list', 'The second list'], consequence: 'none',
    }, (type, data) => updates.push({ type, data }));
    const auto = updates.find(update => update.type === 'clarify_auto')?.data;
    assert.equal(auto?.continues, true, 'the panel learns the run continued on its own');
    assert.equal(auto?.answer, policy.CLARIFY_CONTINUE_ANSWER);
    assert.equal(result.source, 'timeout');
    assert.equal(result.authorized, true);

    const instant = new Agent({});
    instant.clarifyTimeoutSec = 0;
    const instantResult = await instant.executeTool(9141, 'clarify', {
      question: 'Which list?', options: ['First', 'Second'], finish_option: 'Second', consequence: 'none',
    }, () => {});
    assert.equal(instantResult.source, 'auto');
    assert.equal(instantResult.answer, 'Second', 'Instant picks the finishing answer too');
  });

  test(`${build}: Instant answers by the same policy, so it never approves a consequential or safe-setting question`, async () => {
    const hard = new Agent({});
    hard.clarifyTimeoutSec = 0;
    const hardResult = await hard.executeTool(9150, 'clarify', {
      question: 'Delete the 40 archived emails?', options: ['Keep them', 'Delete them'],
      finish_option: 'Delete them', consequence: 'deletion',
    }, () => {});
    assert.equal(hardResult.source, 'auto');
    assert.equal(hardResult.answer, 'Keep them', 'Instant picks the safe answer for a consequence question');
    assert.equal(hardResult.authorized, false, 'Instant must not approve a consequence question');
    assert.match(hardResult.note, /NOT a real user confirmation/);
    assert.ok(hard._clarificationAuthorizationBlock(9150, 'click_ax', {}, [Capability.CLICK]), 'consequential actions stay blocked');

    const safe = new Agent({});
    safe.clarifyTimeoutSec = 0;
    safe.clarifyTimeoutPolicy = 'safe';
    const safeResult = await safe.executeTool(9151, 'clarify', {
      question: 'Commit the post?', options: ['Leave it uncommitted', 'Commit it'], finish_option: 'Commit it', consequence: 'none',
    }, () => {});
    assert.equal(safeResult.answer, 'Leave it uncommitted');
    assert.equal(safeResult.authorized, false, 'Instant on the safe setting does not authorize');

    const finish = new Agent({});
    finish.clarifyTimeoutSec = 0;
    const finishResult = await finish.executeTool(9152, 'clarify', {
      question: 'Which list?', options: ['First', 'Second'], consequence: 'none',
    }, () => {});
    assert.equal(finishResult.authorized, true, 'Instant on the finish setting continues');
    assert.match(finishResult.note, /Instant \(source=auto\)/);
  });

  test(`${build}: a reconnecting panel gets the decided timeout answer`, async () => {
    const source = await read(`src/${build}/src/agent/agent.js`);
    const capture = source.slice(source.indexOf('  _capturePendingClarificationForUi('), source.indexOf('  _capturePendingClarificationForUi(') + 1600);
    assert.match(capture, /'timeoutAnswer', 'timeoutPolicy', 'timeoutContinues'/,
      'the public pending-clarification record keeps the decided answer');
  });

  test(`${build}: settings, background, export and the side panel carry the setting`, async () => {
    const settingsHtml = await read(`src/${build}/src/ui/settings.html`);
    const settings = await read(`src/${build}/src/ui/settings.js`);
    const background = await read(`src/${build}/src/background.js`);
    const config = await import(`../src/${build}/src/config-transfer.js`);
    const panel = await read(`src/${build}/src/ui/sidepanel.js`);
    const scheduler = await read(`src/${build}/src/agent/scheduler.js`);
    const tools = await read(`src/${build}/src/agent/tools.js`);
    const api = build === 'chrome' ? 'chrome' : 'browser';
    assert.match(settingsHtml,
      /<select id="select-clarify-timeout-policy"[^>]*>\s*<option value="finish" data-i18n="st\.display\.clarify_timeout_policy\.finish"><\/option>\s*<option value="safe"/,
      'Settings → General offers finish (first, the default) and safe');
    assert.ok(settingsHtml.indexOf('select-clarify-timeout-policy') > settingsHtml.indexOf('range-clarify-timeout'),
      'the policy sits right after the timeout slider');
    assert.match(settings, new RegExp(`await ${api}\\.storage\\.local\\.set\\(\\{ clarifyTimeoutPolicy: policy \\}\\)`));
    assert.match(settings, /clarifyTimeoutPolicySelect\.value = stored\.clarifyTimeoutPolicy === 'safe' \? 'safe' : 'finish'/);
    assert.match(background, /agent\.clarifyTimeoutPolicy = stored\.clarifyTimeoutPolicy === 'safe' \? 'safe' : 'finish'/);
    assert.match(background, /if \(changes\.clarifyTimeoutPolicy\) \{\s*agent\.clarifyTimeoutPolicy = changes\.clarifyTimeoutPolicy\.newValue === 'safe' \? 'safe' : 'finish';/);
    // A cold service worker must not start a run (side panel or schedule)
    // before the setting is loaded: the timeout answer is fixed when asked.
    assert.match(background, /const clarifyTimeoutReady = loadClarifyTimeout\(\)\.catch\(\(\) => \{\}\);/);
    assert.match(background, /await Promise\.all\(\[planBeforeActReady,[^\]]*\bclarifyTimeoutReady\]\);/);
    assert.match(background, /loadProviders: async \(\) => \{[^}]*await clarifyTimeoutReady;/);
    assert.equal(config.DEFAULT_CONFIG_SETTINGS.clarifyTimeoutPolicy, 'finish');
    assert.ok(config.CONFIG_STORAGE_KEYS.includes('clarifyTimeoutPolicy'));
    assert.match(panel, /data\.timeoutAnswer/);
    assert.match(panel, /sp\.clarify\.auto_timeout_answer/);
    assert.match(panel, /sp\.clarify\.continued/);
    assert.match(scheduler, /pending\.timeoutAnswer = obj\.timeoutAnswer\.slice\(0, 200\)/);
    assert.match(tools, /finish_option: \{/);
    assert.match(tools, /enum: \['none', 'deletion', 'money', 'credentials', 'recipient', 'publication'\]/);
    assert.match(tools, /Classify every question\. "none" when answering approves nothing below/);
    assert.match(tools, /set consequence on every question/i);
  });

  test(`${build}: a timeout setting that cannot be read leaves the safe answer`, async () => {
    const background = await read(`src/${build}/src/background.js`);
    const start = background.indexOf('async function loadClarifyTimeout()');
    assert.ok(start >= 0, 'loadClarifyTimeout is in background.js');
    const source = background.slice(start, background.indexOf('\n}\n', start) + 2);
    const api = build === 'chrome' ? 'chrome' : 'browser';
    const load = get => {
      const agent = { clarifyTimeoutPolicy: 'finish', clarifyTimeoutSec: 60 };
      const storage = { local: { get, set: async () => {} } };
      const run = new Function(api, 'agent', 'normalizeClarifyTimeoutSec', 'CLARIFY_TIMEOUT_OFF_SLIDER',
        `${source}\nreturn loadClarifyTimeout();`);
      return { agent, done: run({ storage }, agent, value => Number(value), 1201) };
    };
    const unreadable = load(async () => { throw new Error('storage unavailable'); });
    await assert.rejects(unreadable.done, /storage unavailable/, 'callers still see the failure');
    assert.equal(unreadable.agent.clarifyTimeoutPolicy, 'safe', 'an unreadable setting fails closed, not to finish');
    for (const policyName of ['finish', 'safe']) {
      const stored = load(async () => ({ clarifyTimeoutPolicy: policyName, clarifyTimeoutSemanticsV2: true }));
      await stored.done;
      assert.equal(stored.agent.clarifyTimeoutPolicy, policyName);
    }
    const unset = load(async () => ({ clarifyTimeoutSemanticsV2: true }));
    await unset.done;
    assert.equal(unset.agent.clarifyTimeoutPolicy, 'finish', 'no stored choice keeps the default');
  });
}

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

function extract(source, name) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: the side panel counts down to the decided answer and backs it up`, async () => {
    const panel = await read(`src/${build}/src/ui/sidepanel.js`);
    const en = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: `
        const EN = ${JSON.stringify(en)};
        function t(key, params = {}) { return String(EN[key] || key).replace(/\\{(\\w+)\\}/g, (_, k) => params[k] ?? ''); }
        window.submitted = [];
        function submitClarify(card, tabId, clarifyId, answer, source) { window.submitted.push({ answer, source }); }
        ${extract(panel, 'clearClarifyCountdown')}
        ${extract(panel, 'startClarifyCountdown')}
        window.makeCard = (options, timeoutAnswer, continues) => {
          const card = document.createElement('div');
          card.className = 'clarify-card';
          for (const option of options) {
            const button = document.createElement('button');
            button.className = 'clarify-option';
            button.textContent = option;
            card.appendChild(button);
          }
          card.dataset.firstOption = timeoutAnswer;
          if (continues) card.dataset.timeoutContinues = '1';
          document.getElementById('root').appendChild(card);
          return card;
        };
        window.startClarifyCountdown = startClarifyCountdown;
      ` });
      const named = await page.evaluate(() => {
        const card = window.makeCard(['Leave it uncommitted', 'Commit it'], 'Commit it', false);
        window.startClarifyCountdown(card, { tabId: 1, clarifyId: 'c1', deadlineTs: Date.now() + 30_000, firstOption: 'Commit it' });
        return card.querySelector('.clarify-timeout').textContent;
      });
      assert.match(named, /^Picks “Commit it” in (29|30)s$/);
      const continues = await page.evaluate(() => {
        const card = window.makeCard(['A', 'B'], '(no reply — continuing the task)', true);
        window.startClarifyCountdown(card, { tabId: 1, clarifyId: 'c2', deadlineTs: Date.now() + 30_000, firstOption: '(no reply — continuing the task)' });
        return card.querySelector('.clarify-timeout').textContent;
      });
      assert.match(continues, /^Continues on its own in (29|30)s$/);
      const backup = await page.evaluate(async () => {
        const card = window.makeCard(['Leave it uncommitted', 'Commit it'], 'Commit it', false);
        window.startClarifyCountdown(card, { tabId: 1, clarifyId: 'c3', deadlineTs: Date.now() + 50, firstOption: 'Commit it' });
        await new Promise(resolve => setTimeout(resolve, 400));
        return window.submitted.at(-1);
      });
      assert.deepEqual(backup, { answer: 'Commit it', source: 'timeout' }, 'the backup submits the decided answer');
    } finally {
      await page.close();
    }
  });
}
