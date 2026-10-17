import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fixtureCalculationReading, withFixtureCalculationReadings } from './calculation-fixture-readings.mjs';

const ORIGINAL_CALC_CORRECTION = readFileSync(new URL('./fixtures/literal-calculation-correction.txt', import.meta.url), 'utf8').trim();

const PAGE_URL = 'https://example.com/photo/1';
const documents = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Photo' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1, documentId: documents.get(tabId) || 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 2600;

function makeAgent(Agent, next) {
  const provider = {
    name: 'feedback progress test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: withFixtureCalculationReadings(next),
    async *chatStream(messages, options) {
      const response = await next(messages, options);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._persistSubmittedTurn = async () => {};
  agent._startTraceRun = async () => null;
  agent._endTraceRun = async () => {};
  agent._beginReadCompleteness = async () => null;
  agent._manageContext = async () => {};
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => PAGE_URL;
  agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Photo' });
  agent._maybeEmitAskModeHandoff = async () => {};
  agent._maybeReinjectAdapter = async () => {};
  agent._ensureProgressSessionForCurrentTask = async () => {};
  agent._plannerMode = () => 'off';
  agent._runPlannerIntentGate = async () => ({
    proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
  });
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._isFormValidationCandidate = () => false;
  agent._preflightRichTextToolbarTarget = async () => ({ block: null });
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._pageFeedbackIdleMs = 0;
  agent.maxSteps = 5;
  return agent;
}

function bind(agent, tab) {
  const from = { tab: { id: tab }, frameId: 0, documentId: 'document-1', url: PAGE_URL };
  const state = agent.pageMonitorState(from, 'content-1');
  assert.equal(state.active, true);
  let seq = 0;
  return value => {
    const current = ++seq;
    assert.equal(agent.observePageFeedback(from, {
      ...state, seq: current, revision: current, kind: 'dom', source: 'page', target: 'span#views', ...value,
    }).accepted, true);
  };
}

const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const expression = '12345678901234567890 * 7 + 0.125';
const expected = '86419752308641975230.125';
const answer = `${expected}\nMIDRUN-CALCULATE-QA-20261008`;
const scope = { readScope: 'none', deliverables: ['Exact arithmetic result', 'Response formatting marker'] };
// The execution guard's reading of a fixture request, as the agent stores it
// after a model read the request (fixtureCalculationReading stands in for it).
function readScope(policy, task) {
  const expression = policy.literalCalculationCandidate(task);
  const { choice, form } = fixtureCalculationReading(task);
  const accepted = form ? policy.acceptCalculationAnswerForm(form, task) : null;
  return { readScope: 'none', calculationReading: { task, expression, choice, ...(accepted ? { form: accepted } : {}) } };
}

async function withNormalCompletionBrowser(agent, build, action) {
  const pageState = { url: PAGE_URL, title: 'Owned passive page', visibleFormCount: 0, relevantFormCount: 0,
    openDialogs: 0, formDescriptors: [], validationMessages: [], errorMessages: [], liveRegionMessages: [],
    workflowPageText: '', workflowResourceUrls: [], workflowResourceRecords: [] };
  agent._captureViewportProbe = async () => ({ url: PAGE_URL, title: 'Owned passive page' });
  agent._completionDocumentStamp = async () => 'owned-document-identity';
  agent._completionLiveStatusMessages = async () => [];
  agent._completionIframeSnapshot = async () => null;
  const previousExecuteScript = api.tabs.executeScript;
  api.tabs.executeScript = async () => [pageState];
  let cdp, previousCdp;
  if (build === 'chrome') {
    ({ cdpClient: cdp } = await import(ROOT_URL + 'src/chrome/src/cdp/cdp-client.js'));
    previousCdp = { attach: cdp.attach, sendCommand: cdp.sendCommand, evaluate: cdp.evaluate };
    cdp.attach = async () => {}; cdp.sendCommand = async () => ({});
    cdp.evaluate = async () => ({ result: { value: pageState } });
  }
  try { return await action(); }
  finally { if (cdp) Object.assign(cdp, previousCdp); api.tabs.executeScript = previousExecuteScript; }
}


const ROOT_URL=new URL('../',import.meta.url).href;
api.tabs.sendMessage=async(_tab,message)=> {
 if(message.action==='page_monitor_capture_model')return{ready:true,runToken:message.params.runToken,documentToken:'content-1',snapshotToken:'owned-snapshot',targetCount:1,page:{success:true,url:PAGE_URL,pageContent:'button "Owned menu" [ref_owned_menu]'}};
 if(message.action==='page_monitor_validate_model')return{ready:true,runToken:message.params.runToken,documentToken:'content-1',snapshotToken:message.params.snapshotToken};
 return{ready:true};
};
for(const build of ['chrome','firefox']){
 const {Agent}=await import(ROOT_URL+'src/'+build+'/src/agent/agent.js');
 const {RunUiJournal}=await import(ROOT_URL+'src/'+build+'/src/run-ui-journal.js');
 for(const streaming of [false,true])for(const scenario of ['rogue_after_plain','same_batch_repeat','wrong_literal','rogue_before_calculation','rogue_standing_grant'])test(build+' '+(streaming?'stream':'chat')+' '+scenario,async()=>{
  const tab=nextTab++, requestId='pure-projection-'+tab, updates=[], seen=[];let agent,send,entered,release,requests=0,calcs=0,wrongCalcs=0,clicks=0,permissions=0;
  const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  const journal=new RunUiJournal();journal.begin(tab,requestId,{mode:'act'});
  agent=makeAgent(Agent,async(messages,options={})=>{
   requests++;if(requests===1){entered();await held;return call('old-read','get_accessibility_tree',{});}
   seen.push({names:(options.tools||[]).map(t=>t.function.name),receipt:agent._pageFeedbackCalculationComplete(tab)});send({});
   const calculated=messages.some(m=>m.role==='tool'&&String(m.content).includes(expected));
   if(scenario==='rogue_before_calculation'&&requests===2)return call('new-early-browser','click_ax',{ref_id:'ref_owned_menu'});
   if(scenario==='wrong_literal'&&requests===2)return call('wrong-literal','calculate',{expression:'1 + 1'});
   if(!calculated){const c=call('actual-literal','calculate',{expression:expression.replace(/\s/g,'')});if(scenario==='same_batch_repeat')c.toolCalls.push(...call('repeat-literal','calculate',{expression}).toolCalls,...call('samebatch-browser','click_ax',{ref_id:'ref_owned_menu'}).toolCalls);return c;}
   if(scenario==='rogue_after_plain'&&requests===3)return{content:answer};
   if((scenario==='rogue_after_plain'&&requests===4)||(scenario==='rogue_standing_grant'&&requests===3))return call('new-wrong-browser','click_ax',{ref_id:'ref_owned_menu'});
   assert.ok(requests<=7);return call('actual-explicit-done','done',{summary:answer,outcome:'success'});
  });
  agent._skipPermissionGate=false;agent._ensureGateSetting=async()=>false;agent.maxSteps=12;
  // Strict checks: the guard's refusal itself is under test.
  if(scenario==='wrong_literal'||scenario==='same_batch_repeat')agent.strictGuards=true;
  agent._promptPermission=async()=>{permissions++;return 'deny';};
  agent._enrichUserMessageWithCurrentPage=async(_tab,_messages,content)=>{send=bind(agent,tab);return{role:'user',content};};
  agent._runPlannerIntentGate=async()=>({proceed:true,requestKind:'execute',requiresStateChange:false,requiresSubmission:false,...agent._plannerCompletionGateFields({read_scope:'none',deliverables:scope.deliverables})});
  agent.executeTool=async(_tab,name,args)=>{if(name==='get_accessibility_tree')return{success:true,pageContent:'text "Owned passive counter"'};if(name==='calculate'){calcs++;if(args.expression==='1 + 1')wrongCalcs++;return agent._executeToolImpl(_tab,name,args);}if(name==='click_ax'){clicks++;return{success:true,verified:true,dispatched:true};}assert.equal(name,'done');return agent._executeToolImpl(_tab,name,args);};
  const update=(type,data)=>{updates.push({type,data});journal.record(tab,requestId,type,data);};
  if(scenario==='rogue_standing_grant')await agent.permissions.record('example.com','click','allow','always',tab);
  try{const options={detachedRequestId:requestId,askStreamingEnabled:false};const running=streaming?agent.processMessageStream(tab,'Inspect the current owned page.',update,'act',options):agent.processMessage(tab,'Inspect the current owned page.',update,'act',[],options);await started;assert.equal(agent.steerMessage(tab,ORIGINAL_CALC_CORRECTION,{requestId,messageId:'single-genuine-correction'}).accepted,true);release();const result=await running;const completed=journal.finish(tab,requestId,'completed',result);const issues=[];
   for(const s of seen){const required=s.receipt?['done']:['calculate','done'];if(JSON.stringify([...s.names].sort())!==JSON.stringify([...required].sort()))issues.push('tool_projection_'+(s.receipt?'after':'before'));}
   if(permissions)issues.push('irrelevant_permission');if(clicks)issues.push('irrelevant_dispatch');if(calcs!==1)issues.push('calculator_count');if(wrongCalcs)issues.push('wrong_literal_executed');if(result!==answer||completed.successfulDone!==true||completed.runSucceeded!==true)issues.push('normal_terminal');
   assert.deepEqual(issues,[]);
  }finally{release();documents.delete(tab);}
 });
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  const { RunUiJournal } = await import(ROOT_URL + 'src/' + build + '/src/run-ui-journal.js');
  for (const streaming of [false, true]) for (const change of ['Stop', 'provider-config', 'provider-object', 'run', 'verification-debt', 'ledger']) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} captured arithmetic authority refuses ${change} during actual preparation`, async () => {
      const tab = nextTab++, requestId = `authority-${tab}`, seen = [], updates = [];
      let agent, send, requests = 0, calculations = 0, permissions = 0, changed = false;
      const journal = new RunUiJournal(); journal.begin(tab, requestId, { mode: 'act' });
      agent = makeAgent(Agent, async (_messages, options = {}) => {
        seen.push((options.tools || []).map(tool => tool.function.name));
        if (++requests === 1) return call('old-authorized-calculation', 'calculate', { expression });
        assert.ok(requests <= 4, 'An invalid authority must finish honestly within normal bounded recovery.');
        return { content: 'The calculation authority changed before execution.' };
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        send = bind(agent, tab); return { role: 'user', content };
      };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute',
        requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      agent._captchaMutationPreflight = async () => {
        if (!changed) {
          changed = true;
          const provider = agent._activeProvider(tab);
          if (change === 'Stop') agent.abort(tab);
          if (change === 'provider-config') provider.config = { ...provider.config, endpoint: 'https://changed.invalid/' };
          if (change === 'provider-object') agent.providerManager.getActive = () => ({ ...provider });
          if (change === 'run') agent.completionInvariants.get(tab).runToken = 'another-owned-run';
          if (change === 'verification-debt') agent.completionInvariants.get(tab).verificationDebt = true;
          if (change === 'ledger') agent.progressLedgers.set(tab, [{ id: 'unresolved', status: 'pending' }]);
          await Promise.resolve();
        }
        return null;
      };
      agent._promptPermission = async () => { permissions++; return 'deny'; };
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Owned page"' };
        if (name === 'calculate') { calculations++; return agent._executeToolImpl(_tab, name, args); }
        return agent._executeToolImpl(_tab, name, args);
      };
      const update = (type, data) => { updates.push({ type, data }); journal.record(tab, requestId, type, data); };
      try {
        const options = { detachedRequestId: requestId, askStreamingEnabled: false };
        const result = streaming ? await agent.processMessageStream(tab, ORIGINAL_CALC_CORRECTION, update, 'act', options)
          : await agent.processMessage(tab, ORIGINAL_CALC_CORRECTION, update, 'act', [], options);
        assert.equal(changed, true); assert.equal(calculations, 0); assert.equal(permissions, 0);
        assert.deepEqual([...seen[0]].sort(), ['calculate', 'done']);
        assert.ok(seen.slice(1).every(names => names.length === 0), 'A stale pure request must never expand back to browser tools.');
        const snapshot = journal.finish(tab, requestId, change === 'Stop' ? 'stopped' : 'completed', result);
        assert.equal(snapshot.successfulDone, false); assert.equal(snapshot.runSucceeded, false);
        assert.ok(!updates.some(event => event.type === 'tool_result' && event.data.name === 'calculate' && event.data.result.success === true));
      } finally { documents.delete(tab); }
    });
  }

  for (const streaming of [false, true]) test(`${build}: ${streaming ? 'stream' : 'chat'} same-wording genuine steering during preparation cannot dispatch the old calculation`, async () => {
    const tab = nextTab++, requestId = `new-user-authority-${tab}`, updates = []; let agent, changed = false, calculations = 0, requests = 0;
    agent = makeAgent(Agent, async () => ++requests === 1
      ? call('old-user-calculation', 'calculate', { expression })
      : { content: 'The required calculation was not executed.' });
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(agent, tab); return { role: 'user', content }; };
    agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
      ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
    agent._captchaMutationPreflight = async () => {
      if (!changed) { changed = true; assert.equal(agent.steerMessage(tab, ORIGINAL_CALC_CORRECTION,
        { requestId, messageId: 'genuine-new-same-wording-user-turn' }).accepted, true); await Promise.resolve(); }
      return null;
    };
    agent.executeTool = async (_tab, name, args) => {
      if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Owned page"' };
      if (name === 'calculate') calculations++;
      return agent._executeToolImpl(_tab, name, args);
    };
    try {
      const options = { detachedRequestId: requestId, askStreamingEnabled: false };
      if (streaming) await agent.processMessageStream(tab, ORIGINAL_CALC_CORRECTION, (type, data) => updates.push({ type, data }), 'act', options);
      else await agent.processMessage(tab, ORIGINAL_CALC_CORRECTION, (type, data) => updates.push({ type, data }), 'act', [], options);
      assert.equal(calculations, 0); assert.equal(updates.filter(event => event.type === 'steering_applied').length, 1);
      assert.equal(updates.some(event => event.type === 'tool_result' && event.data.name === 'calculate' && event.data.result.success === true), false);
    } finally { documents.delete(tab); }
  });

  test(`${build}: pure-task projection does not replace genuine mixed work with a calculator-only job`, async () => {
    for (const task of [`Only calculate ${expression}. Return the result and open the page.`,
      'Read the current page and calculate its price.', `Only calculate ${expression}. Report the result and DM someone.`]) {
      const tab = nextTab++; let observed;
      const agent = makeAgent(Agent, async (_messages, options = {}) => {
        observed = (options.tools || []).map(tool => tool.function.name);
        assert.equal(agent._pureCalculationToolPolicy(tab), null);
        return call('honest-mixed-task-failure', 'done', { summary: 'The mixed task was not executed.', outcome: 'failed' });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(agent, tab); return { role: 'user', content }; };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      agent.executeTool = async (_tab, name, args) => name === 'get_accessibility_tree'
        ? { success: true, pageContent: 'text "Owned page"' } : agent._executeToolImpl(_tab, name, args);
      try {
        await agent.processMessage(tab, task, () => {}, 'act', [], { detachedRequestId: `mixed-${tab}`, askStreamingEnabled: false });
        assert.ok(observed.includes('click_ax')); assert.ok(observed.includes('calculate')); assert.ok(observed.includes('done'));
      } finally { documents.delete(tab); }
    }
  });
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  const { RunUiJournal } = await import(ROOT_URL + 'src/' + build + '/src/run-ui-journal.js');
  for (const streaming of [false, true]) for (const phase of ['model-await', 'terminal-await']) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} owned exact completion survives unrelated page focus during ${phase}`, async () => {
      const tab = nextTab++, requestId = `independent-terminal-${tab}`;
      const updates = []; let agent, send, requests = 0, calculations = 0, doneCalls = 0;
      const journal = new RunUiJournal(); journal.begin(tab, requestId, { mode: 'act' });
      agent = makeAgent(Agent, async () => {
        requests++;
        if (requests === 1) return call('actual-owned-calculation', 'calculate', { expression });
        if (phase === 'model-await' && requests === 2) send({ kind: 'activity', source: 'page', target: 'div' });
        assert.ok(requests <= 4, 'The terminal focus fixture must retain the existing bounded recovery.');
        return call(`actual-terminal-${requests}`, 'done', { summary: requests === 2 ? answer : 'The arithmetic task was completed.', outcome: 'success' });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        send = bind(agent, tab); return { role: 'user', content };
      };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute',
        requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Owned page"' };
        if (name === 'calculate') calculations++;
        if (name === 'done') doneCalls++;
        const result = await agent._executeToolImpl(_tab, name, args);
        if (name === 'done' && phase === 'terminal-await' && doneCalls === 1) {
          assert.equal(result.done, true); assert.equal(result.outcome, 'success');
          send({ kind: 'activity', source: 'page', target: 'div' });
          send({ kind: 'dom', source: 'page', target: 'span' });
          await Promise.resolve();
        }
        return result;
      };
      const update = (type, data) => { updates.push({ type, data }); journal.record(tab, requestId, type, data); };
      try {
        const options = { detachedRequestId: requestId, askStreamingEnabled: false };
        const result = streaming ? await agent.processMessageStream(tab, ORIGINAL_CALC_CORRECTION, update, 'act', options)
          : await agent.processMessage(tab, ORIGINAL_CALC_CORRECTION, update, 'act', [], options);
        const finished = journal.finish(tab, requestId, 'completed', result);
        assert.equal(result, answer, 'The original verified useful terminal answer must remain intact.');
        assert.equal(requests, 2); assert.equal(calculations, 1); assert.equal(doneCalls, 1);
        assert.equal(finished.successfulDone, true); assert.equal(finished.runSucceeded, true);
        assert.equal(finished.finalContent, answer);
      } finally { documents.delete(tab); }
    });
  }
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  for (const streaming of [false, true]) for (const [label, taskExpression, actualValue, wrongSummary] of [
    ['omitted', expression, expected, 'The arithmetic task was completed.'],
    ['wrong sign', expression, expected, `-${expected}`],
    ['spaced wrong sign', expression, expected, `- ${expected}`],
    ['longer integer prefix', expression, expected, `9${expected}`],
    ['longer fraction suffix', expression, expected, `${expected}9`],
    ['decimal prefix', expression, expected, `1.${expected}`],
    ['exponent suffix', expression, expected, `${expected}e-3`],
    ['spaced exponent suffix', expression, expected, `${expected} e-3`],
    ['spaced uppercase exponent suffix', expression, expected, `${expected} E - 3`],
    ['fraction', expression, expected, `${expected}/2`],
    ['spaced fraction', expression, expected, `${expected} / 2`],
    ['numeric comma prefix', expression, expected, `9,${expected}`],
    ['numeric comma suffix', expression, expected, `${expected},123`],
    ['name adjacency', expression, expected, `result_${expected}`],
    ['parenthesized wrong sign', expression, expected, `-(${expected})`],
    ['parenthesized fraction', expression, expected, `(${expected})/2`],
    ['multiplication glyph', expression, expected, `${expected}×2`],
    ['division glyph', expression, expected, `${expected}÷2`],
    ['ambiguous sign glyph', expression, expected, `±${expected}`],
    ['negative sign omitted', '1 - 3', '-2', '2'],
    ['negative double sign', '1 - 3', '-2', '--2'],
  ]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} success summary rejects ${label} before terminal invocation`, async () => {
      const tab = nextTab++, updates = [];
      let agent, requests = 0, calculations = 0, doneCalls = 0;
      const correct = `Result: ${actualValue}.`;
      agent = makeAgent(Agent, async () => {
        requests++;
        if (requests === 1) return call('actual-result-calculation', 'calculate', { expression: taskExpression });
        assert.ok(requests <= 3, 'One result-summary correction must finish without a new calculation.');
        return call(`result-summary-${requests}`, 'done', { summary: requests === 2 ? wrongSummary : correct, outcome: 'success' });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(agent, tab); return { role: 'user', content }; };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false,
        requiresSubmission: false, ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: ['Exact arithmetic result'] }) });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Owned page"' };
        if (name === 'calculate') calculations++;
        if (name === 'done') doneCalls++;
        return agent._executeToolImpl(_tab, name, args);
      };
      try {
        const task = `Only calculate ${taskExpression}.`, options = { detachedRequestId: `result-${tab}`, askStreamingEnabled: false };
        const result = streaming ? await agent.processMessageStream(tab, task, (type, data) => updates.push({ type, data }), 'act', options)
          : await agent.processMessage(tab, task, (type, data) => updates.push({ type, data }), 'act', [], options);
        assert.equal(result, correct); assert.equal(requests, 3); assert.equal(calculations, 1); assert.equal(doneCalls, 1);
        const refusal = updates.find(event => event.type === 'tool_result' && event.data.name === 'done' && event.data.result.denied);
        assert.equal(refusal?.data.result.noDispatch, true); assert.equal(refusal?.data.result.dispatched, false);
        assert.equal(refusal?.data.result.outcomeUnknown, false);
      } finally { documents.delete(tab); }
    });
  }
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  for (const streaming of [false, true]) for (const [label, taskExpression, summary, outcome = 'success'] of [
    ['decimal zeros', '1 + 1', 'Result: 2.0.'],
    ['leading zeros', '1 + 1', 'Result: 002.000.'],
    ['unary positive', '1 + 1', 'Result: +2.'],
    ['equivalent exponent', '1 + 1', 'Result: 2e0.'],
    ['bold', '1 + 1', 'Result: **2**.'],
    ['inline code', '1 + 1', 'Result: `2`.'],
    ['parentheses', '1 + 1', 'Result: (2).'],
    ['signed zero', '1 - 1', 'Result: -0.'],
    ['spaced negative', '1 - 3', 'Result: - 2.'],
    ['parenthesized negative', '1 - 3', 'Result: (-2).'],
    ['actual fraction', '1 / 3', 'Result: 1/3.'],
    ['equivalent actual fraction', '1 / 3', 'Result: 2 / 6.'],
    ['returned decimal', '1 / 3', 'Result: 0.333333333333.'],
    ['huge exact precision', '123456789012345678901234567890123456789 + 1', 'Result: **123456789012345678901234567890123456790**.'],
    ['partial without numeric success claim', '1 + 1', 'The task is partial.', 'partial'],
    ['failed without numeric success claim', '1 + 1', 'The task failed.', 'failed'],
  ]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} actual receipt accepts ${label} without creating new calculation evidence`, async () => {
      const tab = nextTab++, updates = []; let agent, requests = 0, calculations = 0, doneCalls = 0;
      agent = makeAgent(Agent, async () => {
        assert.ok(++requests <= 2);
        return requests === 1 ? call('actual-display-calculation', 'calculate', { expression: taskExpression })
          : call('actual-display-terminal', 'done', { summary, outcome });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(agent, tab); return { role: 'user', content }; };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false,
        requiresSubmission: false, ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: ['Exact arithmetic result'] }) });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Owned page"' };
        if (name === 'calculate') calculations++;
        if (name === 'done') doneCalls++;
        return agent._executeToolImpl(_tab, name, args);
      };
      try {
        const options = { detachedRequestId: `display-${tab}`, askStreamingEnabled: false }, task = `Only calculate ${taskExpression}.`;
        const result = streaming ? await agent.processMessageStream(tab, task, (type, data) => updates.push({ type, data }), 'act', options)
          : await agent.processMessage(tab, task, (type, data) => updates.push({ type, data }), 'act', [], options);
        assert.equal(result, summary); assert.equal(calculations, 1); assert.equal(doneCalls, 1);
        assert.equal(updates.findLast(event => event.type === 'tool_result' && event.data.name === 'done')?.data.result.outcome, outcome);
      } finally { documents.delete(tab); }
    });
  }
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  const { RunUiJournal } = await import(ROOT_URL + 'src/' + build + '/src/run-ui-journal.js');
  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} same-batch calculation and completion finishes once despite later page focus`, async () => {
      const tab = nextTab++, requestId = `same-batch-terminal-${tab}`;
      let agent, send, requests = 0, calculations = 0, doneCalls = 0;
      const advertised = [], journal = new RunUiJournal(); journal.begin(tab, requestId, { mode: 'act' });
      agent = makeAgent(Agent, async (_messages, options = {}) => {
        advertised.push((options.tools || []).map(tool => tool.function.name)); requests++;
        if (requests === 1) {
          const batch = call('same-batch-calculation', 'calculate', { expression });
          batch.toolCalls.push(...call('same-batch-done', 'done', { summary: answer, outcome: 'success' }).toolCalls);
          return batch;
        }
        assert.fail('An executed done is terminal; page focus after it must not reopen the run.');
        return call('fresh-receipt-done', 'done', { summary: answer, outcome: 'success' });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        send = bind(agent, tab); return { role: 'user', content };
      };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute',
        requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Owned page"' };
        if (name === 'calculate') calculations++;
        if (name === 'done') doneCalls++;
        const result = await agent._executeToolImpl(_tab, name, args);
        if (name === 'done' && doneCalls === 1) {
          assert.equal(result.done, true); assert.equal(result.outcome, 'success');
          send({ kind: 'activity', source: 'page', target: 'div' }); await Promise.resolve();
        }
        return result;
      };
      const update = (type, data) => journal.record(tab, requestId, type, data);
      try {
        const options = { detachedRequestId: requestId, askStreamingEnabled: false };
        const result = streaming ? await agent.processMessageStream(tab, ORIGINAL_CALC_CORRECTION, update, 'act', options)
          : await agent.processMessage(tab, ORIGINAL_CALC_CORRECTION, update, 'act', [], options);
        const snapshot = journal.finish(tab, requestId, 'completed', result);
        // The done executed in the batch is terminal: page focus afterwards
        // neither reopens the run nor costs another model call.
        assert.equal(result, answer); assert.equal(calculations, 1); assert.equal(requests, 1); assert.equal(doneCalls, 1);
        assert.deepEqual([...advertised[0]].sort(), ['calculate', 'done']); assert.equal(advertised.length, 1);
        assert.equal(snapshot.finalContent, answer); assert.equal(snapshot.successfulDone, true); assert.equal(snapshot.runSucceeded, true);
      } finally { documents.delete(tab); }
    });
  }
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  for (const change of ['none', 'no_receipt', 'user_activity', 'unknown_activity', 'page_input', 'iframe_focus',
    'document', 'provider_config', 'run', 'queued_steering', 'verification_debt', 'ledger', 'Stop']) {
    test(`${build}: independent completion rechecks current authority after feedback callbacks: ${change}`, async () => {
      const tab = nextTab++, requestId = `terminal-current-${tab}`;
      const agent = makeAgent(Agent, async () => assert.fail('Freshness validation must not call the provider.'));
      const messages = [{ role: 'system', content: 'Owned fixture.' }, { role: 'user', content: ORIGINAL_CALC_CORRECTION }];
      agent.conversations.set(tab, messages); agent.conversationModes.set(tab, 'act');
      await agent._claimRunEntry(tab, 'interactive', { detachedRequestId: requestId }, () => {});
      let callbackObserved = false;
      try {
        agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false,
          requiresSubmission: false, ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
        await agent._prepareCalculationReading(tab); agent._beginCompletionInvariant(tab);
        if (change !== 'no_receipt') {
          const args = { expression }, result = await agent._executeToolImpl(tab, 'calculate', args);
          agent._markPlanExecutionToolCall(tab, 'calculate', result);
          agent._recordCompletionToolResult(tab, 'calculate', args, result);
        }
        const send = bind(agent, tab);
        await agent._capturePageFeedbackModelState(tab, messages);
        const captured = agent._pageFeedbackRuns.get(tab).modelState;
        assert.equal(captured.pureCalculationComplete === true, change !== 'no_receipt');
        agent.executeTool = async (_tab, name) => {
          assert.equal(name, 'get_accessibility_tree'); await Promise.resolve();
          if (change === 'document') documents.set(tab, 'changed-document');
          return { success: true, pageContent: 'text "Owned page"' };
        };
        send({ kind: 'activity', source: 'page', target: change === 'iframe_focus' ? 'iframe#owned-child' : 'div' });
        const callback = type => {
          if (type !== 'page_feedback') return;
          callbackObserved = true;
          if (change === 'user_activity') send({ kind: 'activity', source: 'user' });
          if (change === 'unknown_activity') send({ kind: 'activity', source: 'unknown' });
          if (change === 'page_input') send({ kind: 'input', source: 'page' });
          if (change === 'provider_config') agent._activeProvider(tab).config = { endpoint: 'https://changed.invalid/' };
          if (change === 'run') agent.completionInvariants.get(tab).runToken = 'new-completion-run';
          if (change === 'queued_steering') assert.equal(agent.steerMessage(tab, ORIGINAL_CALC_CORRECTION,
            { requestId, messageId: 'genuine-new-terminal-turn' }).accepted, true);
          if (change === 'verification_debt') agent.completionInvariants.get(tab).verificationDebt = true;
          if (change === 'ledger') agent.progressLedgers.set(tab, [{ id: 'pending', status: 'pending' }]);
          if (change === 'Stop') agent.abort(tab);
        };
        const blocked = await agent._applyPendingPageFeedback(tab, messages, callback,
          { responseToolCalls: call('actual-terminal-check', 'done', { summary: answer, outcome: 'success' }).toolCalls });
        assert.equal(callbackObserved, true);
        // An Act completion survives automatic page activity (page focus,
        // synthetic input, focus moved to an iframe), with or without a
        // receipt. Authority, document, user and unknown changes still block.
        assert.equal(blocked, !['none', 'no_receipt', 'page_input', 'iframe_focus'].includes(change));
        assert.equal(messages.filter(message => message.role === 'tool').length, 0,
          'Retention is not a synthesized tool result or terminal completion.');
      } finally {
        agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); documents.delete(tab);
      }
    });
  }
}

// These cases use the actual done adapter and normal completion runtime. Only
// browser transport is isolated; the provider refuses evidence-free judging.
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  const { RunUiJournal } = await import(ROOT_URL + 'src/' + build + '/src/run-ui-journal.js');
  for (const streaming of [false, true]) for (const sameBatch of [false, true])
    test(build + ': ' + (streaming ? 'stream' : 'chat') + ' actual calculator proves normal completion' + (sameBatch ? ' in one batch' : ''), async () => {
      const tab = nextTab++, requestId = 'normal-calculation-verifier-' + tab;
      let agent, send, requests = 0, judges = 0, calculations = 0, doneCalls = 0;
      const projections = [], journal = new RunUiJournal(); journal.begin(tab, requestId, { mode: 'act' });
      agent = makeAgent(Agent, async (messages, options = {}) => {
        if (String(messages[0]?.content).startsWith('Evaluate only the observable requirements')) {
          judges++; return { content: JSON.stringify({ outcome: 'failed', reason: 'Arithmetic execution evidence is missing.' }) };
        }
        projections.push((options.tools || []).map(tool => tool.function.name)); requests++;
        if (requests === 1) {
          const batch = call('actual-calculator', 'calculate', { expression });
          if (sameBatch) batch.toolCalls.push(...call('same-batch-verified-done', 'done', { summary: answer, outcome: 'success' }).toolCalls);
          return batch;
        }
        send({ kind: 'dom', source: 'page', target: 'span#passive-counter' });
        assert.ok(requests <= 3); return call('actual-useful-done', 'done', { summary: answer, outcome: 'success' });
      });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bind(agent, tab); return { role: 'user', content }; };
      agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false,
        requiresSubmission: false, ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Owned passive counter"' };
        if (name === 'calculate') calculations++; if (name === 'done') doneCalls++;
        return agent._executeToolImpl(_tab, name, args);
      };
      try { await withNormalCompletionBrowser(agent, build, async () => {
        let focused = false;
        agent._completionIframeSnapshot = async () => { await Promise.resolve(); if (!focused) { focused = true; send({ kind: 'activity', source: 'page', target: 'div' }); } return null; };
        const update = (type, data) => journal.record(tab, requestId, type, data);
        const options = { detachedRequestId: requestId, askStreamingEnabled: false };
        const result = streaming ? await agent.processMessageStream(tab, ORIGINAL_CALC_CORRECTION, update, 'act', options)
          : await agent.processMessage(tab, ORIGINAL_CALC_CORRECTION, update, 'act', [], options);
        const final = journal.finish(tab, requestId, 'completed', result);
        // A verified done in the batch is terminal; page focus during its
        // verification does not reopen the run.
        assert.equal(calculations, 1); assert.equal(doneCalls, 1); assert.equal(judges, 0);
        assert.equal(final.finalContent, answer); assert.equal(final.successfulDone, true); assert.equal(final.runSucceeded, true);
        assert.deepEqual(projections, sameBatch ? [['calculate', 'done']] : [['calculate', 'done'], ['done']]);
      }); } finally { documents.delete(tab); }
    });

  for (const streaming of [false, true]) for (const [label, task, incorrect, corrected] of [
    ['missing literal suffix', 'Only calculate 2 + 2. Return the result and finish with RESPONSE_END.', '4', '4 RESPONSE_END'],
    ['wrong literal suffix', 'Only calculate 2 + 2. Return the result and finish with RESPONSE_END.', '4 WRONG_END', '4 RESPONSE_END'],
    ['suffix embedded in longer marker', 'Only calculate 2 + 2. Return the result and finish with RESPONSE_END.', 'RESPONSE_END 4 WRONG_RESPONSE_END', '4 RESPONSE_END'],
    ['suffix not final', 'Only calculate 2 + 2. Return the result and finish with RESPONSE_END.', 'RESPONSE_END 4', '4 RESPONSE_END'],
    ['postposed only', 'Only calculate 2 + 2. Return the result only.', 'The result is 4.', '4.0'],
    ['preposed only', 'Only calculate 2 + 2. Return only the result.', 'The result is 4.', '+004.00'],
    ['numeric ending', 'Only calculate 2 + 2. Return the result and finish with the result.', '4 is the result.', 'The result is 4'],
    ['quoted marker', 'Only calculate 2 + 2. Return the result and finish with marker "COMPLETE".', '4 WRONG', '4 COMPLETE'],
  ]) test(build + ': ' + (streaming ? 'stream' : 'chat') + ' actual normal completion repairs ' + label + ' without new evidence or browser debt', async () => {
    const tab = nextTab++, requestId = 'format-recovery-' + tab, updates = []; let agent, requests = 0, calculations = 0, doneCalls = 0, judges = 0;
    const projections = [], journal = new RunUiJournal(); journal.begin(tab, requestId, { mode: 'act' });
    agent = makeAgent(Agent, async (messages, options = {}) => {
      if (String(messages[0]?.content).startsWith('Evaluate only the observable requirements')) { judges++; return { content: '{"outcome":"failed"}' }; }
      projections.push((options.tools || []).map(tool => tool.function.name)); requests++; assert.ok(requests <= 3);
      if (requests === 1) return call('actual-format-calculation', 'calculate', { expression: '2 + 2' });
      if (requests === 3) assert.equal(agent.completionInvariants.get(tab).verificationDebt, false);
      return call('explicit-format-done-' + requests, 'done', { summary: requests === 2 ? incorrect : corrected, outcome: 'success' });
    });
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(agent, tab); return { role: 'user', content }; };
    agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false,
      requiresSubmission: false, ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
    agent.executeTool = async (_tab, name, args) => { if (name === 'get_accessibility_tree') return { success: true, pageContent: 'text "Owned page"' };
      if (name === 'calculate') calculations++; if (name === 'done') doneCalls++; return agent._executeToolImpl(_tab, name, args); };
    try { await withNormalCompletionBrowser(agent, build, async () => {
      const update = (type, data) => { updates.push({ type, data }); journal.record(tab, requestId, type, data); };
      const options = { detachedRequestId: requestId, askStreamingEnabled: false };
      const result = streaming ? await agent.processMessageStream(tab, task, update, 'act', options) : await agent.processMessage(tab, task, update, 'act', [], options);
      const final = journal.finish(tab, requestId, 'completed', result);
      assert.equal(result, corrected); assert.equal(calculations, 1); assert.equal(doneCalls, 1); assert.equal(judges, 0);
      assert.deepEqual(projections, [['calculate', 'done'], ['done'], ['done']]);
      const denied = updates.find(event => event.type === 'tool_result' && event.data.name === 'done' && event.data.result.denied)?.data.result;
      assert.equal(denied?.noDispatch, true); assert.equal(denied?.dispatched, false); assert.equal(denied?.outcomeUnknown, false);
      assert.equal(final.successfulDone, true); assert.equal(final.runSucceeded, true);
    }); } finally { documents.delete(tab); }
  });
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  const policy = await import(ROOT_URL + 'src/' + build + '/src/agent/page-feedback-policy.js');
  for (const task of [
    'Only calculate 2 + 2. Return the result in plain text.',
    'Only calculate 2 + 2. Return the result with rounding.',
    'Nur berechne 2 + 2. Gib das exakte Ergebnis zurück und beende mit Markierung END.',
    'Only calculate 2 + 2. Finish with FIRST_END. Finish with SECOND_END.',
  ]) test(build + ': unsupported whole output obligation stays outside deterministic verification: ' + task, () => {
    assert.equal(policy.isLiteralCalculationTask(task, '2 + 2', readScope(policy, task)), true);
    assert.equal(policy.literalCalculationOutputRequirements(task, '2 + 2', readScope(policy, task)), null);
  });
  test(build + ': distinct marker clauses preserve the actual finish position', () => {
    const task = 'Only calculate 2 + 2. Finish with marker FIRST_END. Include marker SECOND_END.';
    const requirements = policy.literalCalculationOutputRequirements(task, '2 + 2', readScope(policy, task));
    assert.equal(requirements.suffix, 'FIRST_END');
    assert.equal(policy.literalCalculationSummaryFormatMatches('4 FIRST_END SECOND_END', requirements, '4'), false);
    assert.equal(policy.literalCalculationSummaryFormatMatches('4 SECOND_END FIRST_END', requirements, '4'), true);
  });
  for (const verdict of ['failed', 'succeeded']) test(build + ': ordinary verifier receives actual calculation evidence and controls unsupported-format verdict ' + verdict, async () => {
    const tab = nextTab++, requestId = 'ordinary-calculation-' + tab, updates = [];
    let agent, requests = 0, judgeRequests = 0, received = null;
    agent = makeAgent(Agent, async (messages) => {
      if (String(messages[0]?.content).startsWith('Evaluate only the observable requirements')) {
        judgeRequests++; received = JSON.parse(messages[1].content)[0].recorded_calculations;
        return { content: JSON.stringify({ outcome: verdict, reason: 'The ordinary output-format evidence was evaluated.' }) };
      }
      assert.ok(++requests <= 5); return requests === 1 ? call('ordinary-actual-calc', 'calculate', { expression: '2 + 2' })
        : call('ordinary-format-done-' + requests, 'done', { summary: '4', outcome: requests === 2 ? 'success' : 'failed' });
    });
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(agent, tab); return { role: 'user', content }; };
    agent._runPlannerIntentGate = async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false,
      requiresSubmission: false, ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
    agent.executeTool = async (_tab, name, args) => name === 'get_accessibility_tree'
      ? { success: true, pageContent: 'text "Owned evidence"' } : agent._executeToolImpl(_tab, name, args);
    try { await withNormalCompletionBrowser(agent, build, async () => {
      const result = await agent.processMessage(tab, 'Only calculate 2 + 2. Return the result with rounding.',
        (type, data) => updates.push({ type, data }), 'act', [], { detachedRequestId: requestId });
      assert.equal(judgeRequests, 1); assert.deepEqual(received, [{ tool: 'calculate', expression: '2 + 2', result: '4' }]);
      const doneResult = updates.find(event => event.type === 'tool_result' && event.data.name === 'done')?.data.result;
      assert.equal(doneResult?.completionDecision?.outcome || doneResult?.verification?.decision?.outcome, verdict);
      assert.equal(doneResult?.verification?.decision?.engine === 'calculation', false);
      assert.equal(doneResult?.done === true, verdict === 'succeeded');
      if (verdict === 'succeeded') assert.equal(result, '4');
    }); } finally { documents.delete(tab); }
  });

  for (const window of ['probe', 'after-verifier', 'probe-exception']) for (const change of [
    'provider-config', 'provider-object', 'same-wording-steering', 'run', 'receipt', 'result', 'document',
    'user', 'iframe', 'debt', 'ledger', 'Stop',
  ]) test(build + ': normal calculator completion rejects ' + change + ' during ' + window, async () => {
    const tab = nextTab++, requestId = 'normal-proof-freshness-' + tab;
    const agent = makeAgent(Agent, async () => assert.fail('A stale utility proof must not ask a new judge to certify it.'));
    const messages = [{ role: 'system', content: 'Owned fixture.' }, { role: 'user', content: ORIGINAL_CALC_CORRECTION }];
    agent.conversations.set(tab, messages); agent.conversationModes.set(tab, 'act');
    await agent._claimRunEntry(tab, 'interactive', { detachedRequestId: requestId }, () => {});
    let changed = false;
    try {
      agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false,
        requiresSubmission: false, ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      await agent._prepareCalculationReading(tab); agent._beginCompletionInvariant(tab);
      const args = { expression }, result = await agent._executeToolImpl(tab, 'calculate', args);
      agent._markPlanExecutionToolCall(tab, 'calculate', result); agent._recordCompletionToolResult(tab, 'calculate', args, result);
      const send = bind(agent, tab); await agent._capturePageFeedbackModelState(tab, messages);
      agent.executeTool = async (_tab, name) => { assert.equal(name, 'get_accessibility_tree'); return { success: true, pageContent: 'text "Owned page"' }; };
      await withNormalCompletionBrowser(agent, build, async () => {
        const mutate = () => {
          if (changed) return; changed = true;
          const guard = agent._planExecutionGuards.get(tab), provider = agent._activeProvider(tab);
          if (change === 'provider-config') provider.config = { endpoint: 'https://new.invalid/' };
          if (change === 'provider-object') agent.providerManager.getActive = () => ({ ...provider });
          if (change === 'same-wording-steering') assert.equal(agent.steerMessage(tab, ORIGINAL_CALC_CORRECTION,
            { requestId, messageId: 'new-authority-turn' }).accepted, true);
          if (change === 'run') agent.completionInvariants.get(tab).runToken = 'new-owned-run';
          if (change === 'receipt') guard.pureCalculationReceipt = { ...guard.pureCalculationReceipt };
          if (change === 'result') guard.pureCalculationReceipt.result = 'different-value';
          if (change === 'document') documents.set(tab, 'changed-document');
          if (change === 'user') send({ kind: 'activity', source: 'user', target: 'div' });
          if (change === 'iframe') send({ kind: 'activity', source: 'page', target: 'iframe#child' });
          if (change === 'debt') agent.completionInvariants.get(tab).verificationDebt = true;
          if (change === 'ledger') agent.progressLedgers.set(tab, [{ id: 'unfinished', status: 'pending' }]);
          if (change === 'Stop') agent.abort(tab);
        };
        if (window === 'after-verifier') agent._githubCommittedFileVerification = async () => { await Promise.resolve(); mutate(); return null; };
        else if (build === 'chrome') agent._captureViewportProbe = async () => { await Promise.resolve(); mutate();
          if (window === 'probe-exception') throw new Error('Owned isolated probe failure.'); return { url: PAGE_URL, title: 'Owned page' }; };
        else {
          const executeScript = api.tabs.executeScript;
          api.tabs.executeScript = async (...args) => { await Promise.resolve(); mutate();
            if (window === 'probe-exception') throw new Error('Owned isolated probe failure.'); return executeScript(...args); };
        }
        let completion, error;
        try { completion = await agent._executeToolImpl(tab, 'done', { summary: answer, outcome: 'success' }); }
        catch (caught) { error = caught; }
        assert.equal(changed, true); assert.equal(completion?.done === true, false);
        if (change !== 'Stop') assert.equal(completion?.blockedDone, true);
        else assert.ok(error || completion?.blockedDone);
        if (change === 'debt') assert.equal(agent.completionInvariants.get(tab).verificationDebt, true);
      });
    } finally { agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); documents.delete(tab); }
  });
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  for (const [label, idless, outcome] of [
    ['live subframe unchanged', false, 'same'], ['live subframe replaced before cached notification', false, 'changed'],
    ['original subframe disappeared', false, 'missing'], ['original frame document becomes unknown', false, 'unknown'],
    ['ID-less original monitor unchanged', true, 'same'], ['ID-less replacement same URL', true, 'changed'],
    ['ID-less monitor unavailable', true, 'missing'], ['ID-less wrong run', true, 'wrong-run'],
    ['ID-less Stop during token roundtrip', true, 'Stop'],
  ]) test(build + ': normal utility completion checks ' + label, async () => {
    const tab = nextTab++, requestId = 'frame-freshness-' + tab, originalFrames = api.webNavigation.getAllFrames, originalSend = api.tabs.sendMessage;
    let changed = false, roundtrips = 0;
    api.webNavigation.getAllFrames = async () => idless
      ? [{ frameId: 0, parentFrameId: -1, url: PAGE_URL }]
      : [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE_URL },
        ...((changed && outcome === 'missing') ? [] : [{ frameId: 7, parentFrameId: 0, documentId: changed
          ? (outcome === 'changed' ? 'child-document-2' : outcome === 'unknown' ? undefined : 'child-document-1') : 'child-document-1', url: PAGE_URL + '/frame' }])];
    const agent = makeAgent(Agent, async () => assert.fail('The utility proof needs no stochastic judge.'));
    const messages = [{ role: 'system', content: 'Owned fixture.' }, { role: 'user', content: ORIGINAL_CALC_CORRECTION }];
    agent.conversations.set(tab, messages); agent.conversationModes.set(tab, 'act');
    await agent._claimRunEntry(tab, 'interactive', { detachedRequestId: requestId }, () => {});
    try {
      agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      await agent._prepareCalculationReading(tab); agent._beginCompletionInvariant(tab);
      const args = { expression }, result = await agent._executeToolImpl(tab, 'calculate', args);
      agent._markPlanExecutionToolCall(tab, 'calculate', result); agent._recordCompletionToolResult(tab, 'calculate', args, result);
      const state = agent.pageMonitorState({ tab: { id: tab }, frameId: 0, documentId: idless ? '' : 'document-1', url: PAGE_URL }, 'original-main-token');
      if (!idless) agent.pageMonitorState({ tab: { id: tab }, frameId: 7, documentId: 'child-document-1', url: PAGE_URL + '/frame' }, 'original-child-token');
      await agent._capturePageFeedbackModelState(tab, messages);
      assert.equal(agent._pageFeedbackRuns.get(tab).modelState.frames.size, idless ? 1 : 2);
      agent.executeTool = async (_tab, name) => { assert.equal(name, 'get_accessibility_tree'); return { success: true, pageContent: 'text "Owned page"' }; };
      api.tabs.sendMessage = async (...args) => {
        if (args[1].action !== 'page_monitor_state') return originalSend(...args);
        roundtrips++; await Promise.resolve();
        if (outcome === 'Stop') agent.abort(tab);
        if (outcome === 'missing') return null;
        return { ready: true, active: true, runToken: outcome === 'wrong-run' ? 'another-run' : state.runToken,
          documentToken: outcome === 'changed' ? 'new-main-token' : 'original-main-token' };
      };
      await withNormalCompletionBrowser(agent, build, async () => {
        agent._githubCommittedFileVerification = async () => { changed = true; await Promise.resolve(); return null; };
        const completion = await agent._executeToolImpl(tab, 'done', { summary: answer, outcome: 'success' });
        assert.equal(completion.done === true, outcome === 'same');
        if (outcome !== 'same') assert.equal(completion.blockedDone, true);
        if (idless) assert.ok(roundtrips > 0, 'No browser-ID fallback may rely on a cached same-URL frame.');
      });
    } finally { api.webNavigation.getAllFrames = originalFrames; api.tabs.sendMessage = originalSend;
      agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); documents.delete(tab); }
  });

  for (const stale of ['no-receipt', 'pre-run-owner', 'old-revision', 'orphan-evidence']) test(build + ': ordinary verification excludes ' + stale + ' utility evidence', async () => {
    const tab = nextTab++, requestId = 'ordinary-stale-' + tab; let evidence, judges = 0;
    const task = 'Only calculate 2 + 2. Return the result with rounding.';
    const agent = makeAgent(Agent, async messages => {
      assert.ok(String(messages[0].content).startsWith('Evaluate only the observable requirements'));
      judges++; evidence = JSON.parse(messages[1].content)[0].recorded_calculations;
      return { content: '{"outcome":"failed","reason":"There is no current utility evidence."}' };
    });
    const messages = [{ role: 'system', content: 'Owned fixture.' }, { role: 'user', content: task }];
    agent.conversations.set(tab, messages); agent.conversationModes.set(tab, 'act');
    await agent._claimRunEntry(tab, 'interactive', { detachedRequestId: requestId }, () => {});
    try {
      agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: scope.deliverables }) });
      await agent._prepareCalculationReading(tab); agent._beginCompletionInvariant(tab);
      if (stale !== 'no-receipt') {
        const args = { expression: '2 + 2' }, result = await agent._executeToolImpl(tab, 'calculate', args);
        agent._markPlanExecutionToolCall(tab, 'calculate', result); agent._recordCompletionToolResult(tab, 'calculate', args, result);
        const guard = agent._planExecutionGuards.get(tab);
        if (stale === 'pre-run-owner') guard.pureCalculationReceipt.owner = 'previous-owner';
        if (stale === 'old-revision') guard.pureCalculationReceipt.runToken = 'previous-run';
        if (stale === 'orphan-evidence') guard.evidenceTaskKey = 'previous-evidence-task';
      }
      bind(agent, tab); await agent._capturePageFeedbackModelState(tab, messages);
      agent.executeTool = async (_tab, name) => { assert.equal(name, 'get_accessibility_tree'); return { success: true, pageContent: 'text "Owned page"' }; };
      await withNormalCompletionBrowser(agent, build, async () => {
        const result = await agent._executeToolImpl(tab, 'done', { summary: '4', outcome: 'success' });
        assert.equal(judges, 1); assert.equal(evidence, undefined); assert.equal(result.blockedDone, true); assert.equal(result.done === true, false);
      });
    } finally { agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); documents.delete(tab); }
  });

  const { literalCalculationOutputRequirements, literalCalculationSummaryFormatMatches } = await import(ROOT_URL + 'src/' + build + '/src/agent/page-feedback-policy.js');
  test(build + ': append requires a genuine suffix while include permits presence', async () => {
    const policy = await import(ROOT_URL + 'src/' + build + '/src/agent/page-feedback-policy.js');
    const appendTask = 'Only calculate 2 + 2. Append marker END.', includeTask = 'Only calculate 2 + 2. Include marker END.';
    const append = literalCalculationOutputRequirements(appendTask, '2 + 2', readScope(policy, appendTask));
    assert.equal(append.suffix, 'END'); assert.equal(literalCalculationSummaryFormatMatches('END 4', append, '4'), false);
    assert.equal(literalCalculationSummaryFormatMatches('4 END', append, '4'), true);
    const include = literalCalculationOutputRequirements(includeTask, '2 + 2', readScope(policy, includeTask));
    assert.equal(include.suffix, null); assert.equal(literalCalculationSummaryFormatMatches('END 4', include, '4'), true);
    assert.equal(literalCalculationSummaryFormatMatches('4', include, '4'), false);
  });
}

// An explicit replacement is current task authority; its prohibitions are not
// requests for chat work. Use the normal Agent steering and done adapters.
const EXPLICIT_REPLACEMENT_INSPECTION = 'Inspect the currently open Telegram conversation with my QA bot @wb_quality_20261009_2312_bot. Read its title and latest messages using read-only tools. Do not type, send, edit, navigate to other conversations, or interact with any other account. Summarize what you see.';
const EXPLICIT_REPLACEMENT_CALCULATION = 'Stop the previous inspection task. New task: use calculate to compute 12345678901234567890 * 7 + 0.125 exactly, then report the exact value and finish. Do not inspect any chat or send any messages.';
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(ROOT_URL + 'src/' + build + '/src/agent/agent.js');
  const { RunUiJournal } = await import(ROOT_URL + 'src/' + build + '/src/run-ui-journal.js');
  const policy = await import(ROOT_URL + 'src/' + build + '/src/agent/page-feedback-policy.js');
  test(build + ': explicit replacements are read as calculation-only, while other work, quotes and a second expression are not', () => {
    for (const task of [EXPLICIT_REPLACEMENT_CALCULATION,
      'New task: compute 2 + 2 exactly, then return the exact result. Do not open any page or send any messages.',
      "Cancel the previous task. Replacement task: calculate 2 + 2. Report the value and finish. Don't read any conversation."]) {
      const value = task === EXPLICIT_REPLACEMENT_CALCULATION ? expression : '2 + 2';
      assert.equal(policy.isLiteralCalculationTask(task, value, readScope(policy, task)), true);
      assert.deepEqual(policy.literalCalculationOutputRequirements(task, value, readScope(policy, task)),
        { markers: [], suffix: null, onlyScalar: false, scalarAtEnd: false });
      assert.equal(policy.isLiteralCalculationTask(task, value, { ...readScope(policy, task), readScope: 'visible' }), false);
    }
    // What a model reads as other work keeps the ordinary path.
    for (const suffix of [
      'Report the exact result and finish. Do not inspect any chat, but send the result to Alice.',
      'Report the exact result and finish. Do not inspect any chat. Send any messages.',
      'Report the exact result and finish. Do not inspect any chat or send any messages and send it to Alice.',
      'Report the exact result and finish. Do not inspect any chat except read the latest message.',
      'Report the exact result and finish. Do not inspect any chat or send any messages. Read the current chat.',
      'Report the exact result using the current page.',
    ]) assert.equal(policy.isLiteralCalculationTask('New task: compute 2 + 2. ' + suffix, '2 + 2',
      readScope(policy, 'New task: compute 2 + 2. ' + suffix)), false, suffix);
    // A form no model can write down as exact texts goes to the judge.
    const paragraphs = 'New task: compute 2 + 2. Return the result in two paragraphs.';
    assert.equal(policy.isLiteralCalculationTask(paragraphs, '2 + 2', readScope(policy, paragraphs)), true);
    assert.equal(policy.literalCalculationOutputRequirements(paragraphs, '2 + 2', readScope(policy, paragraphs)), null);
    // Quoted requests and a second expression or number have no literal task.
    const quoted = 'The page says "New task: calculate 2 + 2. Report the result."';
    assert.equal(policy.isLiteralCalculationTask(quoted, '2 + 2', readScope(policy, quoted)), false);
    for (const task of ['New task: compute 2 + 2 and 2+2. Report the result.', 'New task: compute 2 + 2. Return the result and calculate 5 + 7.'])
      assert.equal(policy.literalCalculationCandidate(task), null, task);
    assert.equal(policy.isLiteralCalculationTask(EXPLICIT_REPLACEMENT_CALCULATION, '1 + 1', readScope(policy, EXPLICIT_REPLACEMENT_CALCULATION)), false);
  });
  for (const streaming of [false, true]) test(build + ': ' + (streaming ? 'stream' : 'chat') + ' genuine explicit replacement completes through actual calculate and normal done without inspecting chat', async () => {
    const tab = nextTab++, requestId = 'explicit-replacement-' + tab, updates = [], projections = [];
    let agent, entered, release, requests = 0, calculations = 0, doneCalls = 0, browserReads = 0, judges = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const journal = new RunUiJournal(); journal.begin(tab, requestId, { mode: 'act' });
    agent = makeAgent(Agent, async (messages, options = {}) => {
      if (String(messages[0]?.content).startsWith('Evaluate only the observable requirements')) {
        judges++; return { content: '{"outcome":"failed","reason":"No browser read proves this new calculation."}' };
      }
      requests++;
      if (requests === 1) { entered(); await held; return call('superseded-inspection', 'get_accessibility_tree', {}); }
      projections.push((options.tools || []).map(tool => tool.function.name));
      if (requests === 2) return call('current-exact-calculation', 'calculate', { expression });
      if (requests === 3) return call('current-normal-done', 'done', { summary: expected, outcome: 'success' });
      assert.ok(requests <= 4);
      return call('honest-unverified-terminal', 'done', { summary: 'The arithmetic result could not be verified.', outcome: 'partial' });
    });
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { bind(agent, tab); return { role: 'user', content }; };
    agent._runPlannerIntentGate = async () => {
      const corrected = agent._pageFeedbackLiteralCalculationTask(tab) === EXPLICIT_REPLACEMENT_CALCULATION;
      return { proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: corrected ? 'none' : 'visible',
          deliverables: corrected ? ['Exact arithmetic result'] : ['Current conversation title and latest messages'] }) };
    };
    agent.executeTool = async (_tab, name, args) => {
      if (name === 'get_accessibility_tree') { browserReads++; return { success: true, pageContent: 'text "Owned neutral page"' }; }
      if (name === 'calculate') calculations++;
      if (name === 'done') doneCalls++;
      assert.ok(['calculate', 'done'].includes(name));
      return agent._executeToolImpl(_tab, name, args);
    };
    try { await withNormalCompletionBrowser(agent, build, async () => {
      const update = (type, data) => { updates.push({ type, data }); journal.record(tab, requestId, type, data); };
      const options = { detachedRequestId: requestId, askStreamingEnabled: false };
      const running = streaming ? agent.processMessageStream(tab, EXPLICIT_REPLACEMENT_INSPECTION, update, 'act', options)
        : agent.processMessage(tab, EXPLICIT_REPLACEMENT_INSPECTION, update, 'act', [], options);
      await started;
      assert.equal(agent.steerMessage(tab, EXPLICIT_REPLACEMENT_CALCULATION,
        { requestId, messageId: 'genuine-explicit-replacement' }).accepted, true);
      release();
      const result = await running;
      const completed = journal.finish(tab, requestId, 'completed', result);
      assert.equal(updates.filter(value => value.type === 'steering_applied').length, 1);
      assert.equal(calculations, 1); assert.equal(doneCalls, 1); assert.equal(browserReads, 0); assert.equal(judges, 0);
      assert.deepEqual(projections, [['calculate', 'done'], ['done']]);
      assert.equal(result, expected); assert.equal(completed.successfulDone, true); assert.equal(completed.runSucceeded, true);
    }); } finally { release(); documents.delete(tab); }
  });
  test(build + ': current replacement wording without actual calculator execution cannot complete', async () => {
    const tab = nextTab++, requestId = 'replacement-no-receipt-' + tab; let judges = 0, evidence;
    const agent = makeAgent(Agent, async messages => {
      assert.ok(String(messages[0].content).startsWith('Evaluate only the observable requirements'));
      judges++; evidence = JSON.parse(messages[1].content)[0].recorded_calculations;
      return { content: '{"outcome":"failed","reason":"There is no current utility evidence."}' };
    });
    const messages = [{ role: 'system', content: 'Owned fixture.' }, { role: 'user', content: EXPLICIT_REPLACEMENT_CALCULATION }];
    agent.conversations.set(tab, messages); agent.conversationModes.set(tab, 'act');
    await agent._claimRunEntry(tab, 'interactive', { detachedRequestId: requestId }, () => {});
    try {
      agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
        ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: ['Exact arithmetic result'] }) });
      await agent._prepareCalculationReading(tab); agent._beginCompletionInvariant(tab); bind(agent, tab); await agent._capturePageFeedbackModelState(tab, messages);
      agent.executeTool = async (_tab, name) => { assert.equal(name, 'get_accessibility_tree'); return { success: true, pageContent: 'text "Owned page"' }; };
      await withNormalCompletionBrowser(agent, build, async () => {
        const result = await agent._executeToolImpl(tab, 'done', { summary: expected, outcome: 'success' });
        assert.equal(judges, 1); assert.equal(evidence, undefined); assert.equal(result.blockedDone, true); assert.equal(result.done === true, false);
      });
    } finally { agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); documents.delete(tab); }
  });
}
