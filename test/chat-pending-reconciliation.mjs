import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://owned/${value}`, sendMessage: async () => ({}) } };

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createChatSession, markChatSendPending, advanceChatSession, decideChatSend } = await import(`../src/${build}/src/agent/chat-workflow.js`);
  function fixture() {
    const provider = { name: 'owned', model: 'owned-model', config: { category: 'local' } };
    const agent = new Agent({ getActive: () => provider });
    const tab = 21;
    agent._persist = () => {}; agent._persistNow = async () => ({ ok: true });
    agent.conversationIds.set(tab, 'owned-conversation');
    agent.conversations.set(tab, [{ role: 'system', content: 'Owned runtime context.' },
      { role: 'user', content: 'Reply only in the owned QA conversation until its questions are answered.' }]);
    agent._beginCompletionInvariant(tab);
    const pending = markChatSendPending(createChatSession({ threadKey: 'owned-thread' }), {
      ok: true, messageKey: 'public-pending-key', threadKey: 'owned-thread',
      text: 'Owned uncertain outgoing body', replyAnchor: 'owned-incoming-1',
    });
    agent.chatSessions.set(tab, pending);
    const observation = { success: true, observedAt: new Date().toISOString(), threadKey: 'owned-thread',
      conversationIdentity: 'Owned QA', messages: [], composer: { available: true, empty: true, refId: 'composer' } };
    agent._readChatObservation = async () => observation;
    return { agent, tab, provider, observation, pending,
      args: { reconcile_pending_outbound: true, pending_outbound_key: pending.pendingOutbound.key } };
  }

  test(`${build}: model echo of the public pending key cannot authorize clearing an unknown send`, async () => {
    const f = fixture();
    const result = await f.agent._observeChatWorkflow(f.tab, { ...f.args, source: 'user', approved: true });
    assert.equal(result.success, false);
    assert.equal(f.agent.chatSessions.get(f.tab).pendingOutbound.key, f.pending.pendingOutbound.key);
  });

  function approve(f, source = 'user', answer = null) {
    return (type, data) => {
      assert.equal(type, 'clarify');
      assert.equal(data.requireExplicitAnswer, true);
      assert.equal(data.pendingReconciliation, true);
      assert.equal(data.timeoutSec, 0);
      assert.match(data.question, /Owned uncertain outgoing body/);
      // The card names the conversation as its page does, quoted on its own
      // line, not by WebBrain's thread key.
      assert.match(data.question, /\nConversation: “Owned QA”\n/);
      assert.doesNotMatch(data.question, /owned-thread/);
      const entry = f.agent._pendingClarifications.get(f.tab).get(data.clarifyId);
      assert.equal(entry.timer, null);
      f.prompt = data;
      assert.equal(f.agent.submitClarifyResponse(f.tab, data.clarifyId, answer ?? data.options[1], source), true);
    };
  }
  function waitForPrompt(f) {
    let resolve;
    const ready = new Promise(done => { resolve = done; });
    return { ready, emit(type, data) { assert.equal(type, 'clarify'); f.prompt = data; resolve(data); } };
  }
  function assertPending(f, key = f.pending.pendingOutbound.key) {
    assert.equal(f.agent.chatSessions.get(f.tab).pendingOutbound?.key, key);
    assert.equal(f.agent._pendingClarifications.has(f.tab), false);
  }

  for (const source of ['user', 'manual']) test(`${build}: exact ${source} UI approval clears only its scoped pending record`, async () => {
    const f = fixture();
    const result = await f.agent._executeToolImpl(f.tab, 'chat_observe', f.args, approve(f, source));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.chatWorkflow.pendingOutbound, false);
    assert.equal(f.agent.chatSessions.get(f.tab).pendingOutbound, null);
    assert.equal(f.agent._pendingClarifications.has(f.tab), false);
    assert.equal(f.agent.submitClarifyResponse(f.tab, f.prompt.clarifyId, f.prompt.options[1], 'user'), false);
    // A matching public key does not resurrect the already-used private UI answer.
    f.agent.chatSessions.set(f.tab, markChatSendPending(f.agent.chatSessions.get(f.tab), {
      ok: true, messageKey: f.args.pending_outbound_key, threadKey: 'owned-thread', text: 'A different unknown send', replyAnchor: 'next-question',
    }));
    const replay = await f.agent._observeChatWorkflow(f.tab, { ...f.args, clarifyId: f.prompt.clarifyId, answer: f.prompt.options[1], source: 'user' });
    assert.equal(replay.success, false);
    assertPending(f);
  });

  for (const source of ['auto', 'timeout', 'model', 'page', '']) test(`${build}: ${source || 'missing'} answer provenance cannot clear pending`, async () => {
    const f = fixture();
    const result = await f.agent._observeChatWorkflow(f.tab, f.args, approve(f, source));
    assert.equal(result.reason, 'pending_reconciliation_requires_confirmation');
    assertPending(f);
  });

  test(`${build}: a declined or generic yes answer cannot be overwritten by a later UI response`, async () => {
    for (const answer of ['yes', 'Keep the pending send blocked']) {
      const f = fixture();
      const result = await f.agent._observeChatWorkflow(f.tab, f.args, (type, data) => {
        approve(f, 'user', answer)(type, data);
        f.agent.submitClarifyResponse(f.tab, data.clarifyId, data.options[1], 'user');
      });
      assert.equal(result.success, false);
      assertPending(f);
    }
  });

  test(`${build}: wrong key and missing pending record never open a confirmation`, async () => {
    const f = fixture(); let prompts = 0;
    const update = () => { prompts++; };
    assert.equal((await f.agent._observeChatWorkflow(f.tab, { ...f.args, pending_outbound_key: 'wrong' }, update)).reason, 'pending_reconciliation_mismatch');
    assert.equal(prompts, 0); assertPending(f);
    f.agent.chatSessions.set(f.tab, { ...f.pending, pendingOutbound: null });
    assert.equal((await f.agent._observeChatWorkflow(f.tab, f.args, update)).reason, 'pending_reconciliation_not_needed');
    assert.equal(prompts, 0);
  });

  test(`${build}: unavailable UI and throwing UI retain the pending send without leaked prompts`, async () => {
    for (const update of [null, () => { throw new Error('owned UI unavailable'); }]) {
      const f = fixture();
      const result = await f.agent._observeChatWorkflow(f.tab, f.args, update);
      assert.equal(result.success, false); assertPending(f);
    }
  });

  test(`${build}: Instant and timeout settings never automatically approve this dialog; Stop cancels it`, async () => {
    for (const timeout of [0, 0.001, 60]) {
      const f = fixture(); f.agent.clarifyTimeoutSec = timeout;
      const prompt = waitForPrompt(f);
      const result = f.agent._observeChatWorkflow(f.tab, f.args, prompt.emit);
      const data = await prompt.ready;
      assert.equal(data.requireExplicitAnswer, true); assert.equal(data.timeoutSec, 0);
      assert.equal(f.agent._pendingClarifications.get(f.tab).get(data.clarifyId).timer, null);
      await new Promise(resolve => setTimeout(resolve, 12));
      assert.equal(f.agent.chatSessions.get(f.tab).pendingOutbound.key, f.pending.pendingOutbound.key);
      f.agent.abort(f.tab);
      assert.equal((await result).success, false); assertPending(f);
    }
  });

  const drifts = {
    conversation: f => f.agent.conversationIds.set(f.tab, 'different-conversation'),
    task: f => f.agent.conversations.set(f.tab, [{ role: 'system', content: 'Owned runtime context.' }, { role: 'user', content: 'A different owned task.' }]),
    run: f => f.agent._beginCompletionInvariant(f.tab),
    generation: f => { f.agent._systemOneGenerations ??= new Map(); f.agent._systemOneGenerations.set(f.tab, 1); },
    provider: f => { f.agent._activeProvider = () => ({ ...f.provider }); },
    model: f => { f.provider.model = 'different-model'; },
    providerConfig: f => { f.provider.config.category = 'different-local-route'; },
    endpoint: f => { f.provider.config.endpoint = 'http://127.0.0.1:20001/owned-other'; },
    account: f => { f.provider.config.account = 'different-owned-account'; },
    apiKey: f => { f.provider.config.apiKey = 'owned-fake-test-value'; },
    identicalNewTask: f => f.agent.conversations.get(f.tab).push({ role: 'user', content: f.agent.conversations.get(f.tab)[1].content }),
    pending: f => f.agent.chatSessions.set(f.tab, { ...f.pending, pendingOutbound: { ...f.pending.pendingOutbound, text: 'New pending body' } }),
    pendingMutation: f => { f.pending.pendingOutbound.text = 'Changed pending body'; },
    boundThread: f => { f.pending.threadKey = 'different-thread'; },
    steering: f => f.agent._steeringRuns.set(f.tab, { messages: [{ text: 'Stop that send' }], revision: 0, authorizedRevision: 0 }),
    unvalidatedSteering: f => f.agent._steeringRuns.set(f.tab, { messages: [], revision: 1, authorizedRevision: 0 }),
    stop: f => f.agent.abort(f.tab),
  };
  for (const [name, drift] of Object.entries(drifts)) test(`${build}: ${name} drift while awaiting approval preserves the current pending record`, async () => {
    const f = fixture(); const prompt = waitForPrompt(f);
    const result = f.agent._observeChatWorkflow(f.tab, f.args, prompt.emit);
    const data = await prompt.ready; drift(f);
    f.agent.submitClarifyResponse(f.tab, data.clarifyId, data.options[1], 'user');
    assert.equal((await result).success, false); assertPending(f);
  });

  test(`${build}: fresh observation failure or changed peer rejects even a genuine approval`, async () => {
    for (const next of [{ success: false }, { success: true, threadKey: 'different-thread' }]) {
      const f = fixture(); let reads = 0;
      f.agent._readChatObservation = async () => ++reads === 1 ? f.observation : { ...f.observation, ...next };
      assert.equal((await f.agent._observeChatWorkflow(f.tab, f.args, approve(f))).success, false);
      assertPending(f);
    }
  });

  test(`${build}: approval is invalidated by state drift during the post-answer fresh read`, async () => {
    const f = fixture(); let reads = 0, release; let reading;
    const entered = new Promise(resolve => { reading = resolve; });
    f.agent._readChatObservation = async () => {
      if (++reads === 1) return f.observation;
      reading(); return new Promise(resolve => { release = resolve; });
    };
    const result = f.agent._observeChatWorkflow(f.tab, f.args, approve(f));
    await entered; f.agent._beginCompletionInvariant(f.tab); release(f.observation);
    assert.equal((await result).success, false); assertPending(f);
  });

  test(`${build}: real delivery while a reconciliation dialog is open retains original reply provenance and dedupe`, async () => {
    const f = fixture();
    const incoming = { id: 'owned-incoming-1', direction: 'incoming', text: 'Owned question' };
    f.observation.messages = [incoming];
    const seeded = advanceChatSession(createChatSession({ threadKey: 'owned-thread' }), f.observation).session;
    const decision = decideChatSend(seeded, f.observation, f.pending.pendingOutbound.text);
    assert.equal(decision.ok, true);
    f.pending = markChatSendPending(seeded, decision); f.agent.chatSessions.set(f.tab, f.pending);
    f.args.pending_outbound_key = f.pending.pendingOutbound.key;
    const prompt = waitForPrompt(f);
    const result = f.agent._observeChatWorkflow(f.tab, f.args, prompt.emit);
    const data = await prompt.ready;
    f.observation.messages = [incoming, { id: 'owned-outgoing-1', direction: 'outgoing', text: decision.text }];
    f.agent.submitClarifyResponse(f.tab, data.clarifyId, data.options[0], 'user');
    const observed = await result;
    assert.equal(observed.success, true); assert.equal(observed.chatWorkflow.pendingOutbound, false);
    const delivered = f.agent.chatSessions.get(f.tab);
    assert.equal(delivered.deliveredReplyBindings[0].replyAnchor, incoming.id);
    assert.equal(delivered.deliveredReplyBindings[0].messageId, 'owned-outgoing-1');
    assert.equal(decideChatSend(delivered, f.observation, decision.text).reason, 'already_sent');
    assert.equal(f.agent._pendingClarifications.has(f.tab), false);
  });

  test(`${build}: ordinary observation remains read-only and does not request reconciliation approval`, async () => {
    const f = fixture(); let prompts = 0;
    const result = await f.agent._observeChatWorkflow(f.tab, {}, () => { prompts++; });
    assert.equal(result.success, true); assert.equal(result.chatWorkflow.pendingOutbound, true);
    assert.equal(prompts, 0); assertPending(f);
  });

  test(`${build}: real panel manual interactions reach Agent approval while automatic answers stay denied`, async () => {
    const engine = build === 'chrome' ? chromium : firefox;
    const browser = await engine.launch({ headless: true });
    try {
      const panel = (await readFile(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
      const extract = (name, next) => {
        const start = panel.indexOf(`function ${name}(`), end = panel.indexOf(`\nfunction ${next}(`, start);
        assert.ok(start >= 0 && end > start); return panel.slice(start, end);
      };
      const production = extract('clarificationSubmissionKey', 'invalidateUnresolvedClarifyCards') + '\n'
        + extract('renderClarifyCard', 'clearClarifyCountdown') + '\n'
        + extract('submitClarify', 'placeAnsweredClarifyCardInTimeline');
      const page = await browser.newPage(); let active, payloads;
      await page.exposeFunction('qaClarifyResponse', payload => {
        payloads.push(payload);
        return Promise.resolve({ ok: active.agent.submitClarifyResponse(payload.tabId, payload.clarifyId, payload.answer, payload.source) });
      });
      for (const interaction of ['option', 'text', 'auto', 'timeout']) {
        active = fixture(); payloads = [];
        // The complete exact body must be visible; ordinary clarify's 600-char cap cannot hide its tail.
        active.pending.pendingOutbound.text = 'Owned uncertain outgoing body\n' + 'owned '.repeat(200) + 'EXACT OWNED MESSAGE END';
        await page.setContent('<div class="message assistant"><div class="message-content"></div></div>');
        await page.evaluate(source => {
          window.currentTabId = 21; window.currentAssistantEl = document.querySelector('.message.assistant');
          window.submittedClarificationIds = new Set();
          for (const name of ['hideActivity', 'playClarifySound', 'scrollToBottom', 'clearClarifyCountdown', 'keepClarifyAliveWhileTyping', 'placeAnsweredClarifyCardInTimeline']) window[name] = () => {};
          window.t = key => key;
          window.sendToBackground = (type, payload) => { if (type !== 'clarify_response') throw new Error('Unexpected fixture action'); return qaClarifyResponse(payload); };
          window.eval(source + '\nwindow.qaRenderClarify=renderClarifyCard;window.qaSubmitClarify=submitClarify;');
        }, production);
        let render;
        const rendered = new Promise(resolve => { render = resolve; });
        const result = active.agent._observeChatWorkflow(active.tab, active.args, (_type, data) => {
          active.prompt = data; page.evaluate(data => qaRenderClarify(data), data).then(render);
        });
        await rendered;
        assert.match(await page.locator('.clarify-question').innerText(), /EXACT OWNED MESSAGE END/);
        assert.equal((await page.locator('.clarify-question').innerText()).includes(active.pending.pendingOutbound.text), true);
        if (interaction === 'option') await page.getByRole('button', { name: active.prompt.options[1], exact: true }).click();
        else if (interaction === 'text') { await page.locator('.clarify-input').fill(active.prompt.options[1]); await page.locator('.clarify-submit').click(); }
        else await page.evaluate(({ answer, source }) => qaSubmitClarify(document.querySelector('.clarify-card'), 21,
          document.querySelector('.clarify-card').dataset.clarifyId, answer, source), { answer: active.prompt.options[1], source: interaction });
        const observed = await result;
        assert.equal(payloads.length, 1);
        assert.equal(payloads[0].source, ['option', 'text'].includes(interaction) ? 'manual' : interaction);
        assert.equal(Object.hasOwn(payloads[0], 'memorySource'), false);
        assert.equal(observed.success, ['option', 'text'].includes(interaction));
        assert.equal(!!active.agent.chatSessions.get(active.tab).pendingOutbound, !observed.success);
      }
      // Generic clarification cards retain their original provenance and cannot
      // borrow this reconciliation approval by displaying the same option.
      active = fixture(); payloads = [];
      await page.setContent('<div class="message assistant"><div class="message-content"></div></div>');
      await page.evaluate(() => {
        currentAssistantEl = document.querySelector('.message.assistant');
        qaRenderClarify({ clarifyId: 'unowned-generic-question', requireExplicitAnswer: true,
          question: 'A generic fixture clarification', options: ['Keep blocked', 'I verified this message was not delivered; clear this pending send'], timeoutSec: 0 });
      });
      await page.locator('.clarify-option').nth(1).click();
      await page.waitForFunction(() => document.querySelector('.clarify-card').classList.contains('clarify-answered'));
      assert.equal(payloads.length, 1); assert.equal(payloads[0].source, 'option');
      assertPending(active);
    } finally { await browser.close(); }
  });
}
