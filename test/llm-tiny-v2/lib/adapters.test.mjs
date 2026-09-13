import assert from 'node:assert/strict';
import test from 'node:test';
import { createParticipant, parseAdapterResponse, parseAdapterActions, parseFaraAction, makeInitialMessages, requestForTurn, trimScreenshotHistory, normalizeComputerKey } from './adapters.mjs';

test('parses Fara XML action blocks without treating thought text as an action', () => {
  const content = 'The save button is visible.\n<tool_call>{"name":"computer_use","arguments":{"action":"left_click","coordinate":[500,625]}}</tool_call>';
  assert.deepEqual(parseFaraAction(content), {
    name: 'computer_use',
    args: { action: 'left_click', coordinate: [500, 625] },
    thoughts: 'The save button is visible.',
  });
});

test('parses Browser Use native JSON actions', () => {
  const action = parseAdapterResponse('browser-use', {
    content: '{"thinking":"click save","evaluation_previous_goal":"ready","memory":"field set","next_goal":"save","action":[{"click":{"index":3}}]}',
  });
  assert.deepEqual(action, { name: 'click', args: { index: 3 }, raw: {
    thinking: 'click save', evaluation_previous_goal: 'ready', memory: 'field set', next_goal: 'save', action: [{ click: { index: 3 } }],
  } });
});

test('parses Compass native function XML when the endpoint does not populate tool_calls', () => {
  assert.deepEqual(parseAdapterResponse('compass', {
    content: '<function name="set_field"><param name="ref_id">ref_1</param><param name="text">Atlas</param></function>',
  }), { name: 'set_field', args: { ref_id: 'ref_1', text: 'Atlas' } });
});

test('keeps specialized adapters on their model allow-list and allows an explicit baseline', () => {
  assert.throws(() => createParticipant({
    adapter: 'fara', model: 'unrelated/model', base: 'http://127.0.0.1:8000/v1',
  }), /allow-list/);
  assert.equal(createParticipant({
    adapter: 'openai', model: 'vendor/benchmark', base: 'http://127.0.0.1:8000/v1',
  }).model, 'vendor/benchmark');
});

test('preserves literal Compass CDATA parameters', () => {
  assert.deepEqual(parseAdapterResponse('compass', { content: '<function name="set_field"><param name="text"><![CDATA[A < B & C\nD]]></param></function>' }), { name: 'set_field', args: { text: 'A < B & C\nD' } });
});

test('preserves every action in native and OpenAI batches', () => {
  const xml = '<function name="set_field"><param name="text">Spring launch</param></function>\n<function name="select_option"><param name="text">Weekly</param></function>';
  assert.deepEqual(parseAdapterActions('compass', { content: xml }).map(a => a.name), ['set_field', 'select_option']);
  assert.deepEqual(parseAdapterActions('browser-use', { content: '{"action":[{"input":{"index":1,"text":"Orion"}},{"click":{"index":3}}]}' }).map(a => a.name), ['input', 'click']);
  assert.deepEqual(parseAdapterActions('openai', { tool_calls: [{ id: 'a', function: { name: 'input', arguments: '{"index":1}' } }, { id: 'b', function: { name: 'click', arguments: '{"index":2}' } }] }).map(a => a.id), ['a', 'b']);
});

test('normalizes model keyboard aliases to browser key names', () => {
  assert.equal(normalizeComputerKey('SPACE'), 'Space');
  assert.equal(normalizeComputerKey('ARROWDOWN'), 'ArrowDown');
  assert.equal(normalizeComputerKey('CTRL+A'), 'Control+A');
  assert.equal(normalizeComputerKey('CTRL+A', 'darwin'), 'Meta+a');
  assert.equal(normalizeComputerKey('Return'), 'Enter');
});

test('Fara receives its pinned identity, normalized tool space and latest three images', () => {
  const participant = createParticipant({ adapter: 'fara', model: 'microsoft/Fara1.5-4B', base: 'http://local/v1' });
  const messages = makeInitialMessages(participant, 'Click save', { withImage: text => [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'image0' } }] });
  assert.match(messages[0].content, /You are developed by Microsoft AI Frontiers/);
  assert.match(messages[0].content, /1000x1000/);
  assert.match(messages[0].content, /"name":"computer_use"/);
  for (let i = 1; i < 5; i++) messages.push({ role: 'user', content: [{ type: 'text', text: String(i) }, { type: 'image_url', image_url: { url: `image${i}` } }] });
  trimScreenshotHistory(messages);
  assert.deepEqual(messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url) : []), ['image2', 'image3', 'image4']);
  assert.equal(requestForTurn(participant, messages).temperature, 0);
});

test('request settings preserve adapter-owned schemas and common output budget',()=>{
  for(const adapter of ['openai','compass','browser-use','fara']) {
    const model=adapter==='openai'?'baseline/model':adapter==='fara'?'microsoft/Fara1.5-4B':undefined;
    const participant=createParticipant({adapter,model,base:'http://unused',extraBody:{tools:['wrong'],stream:true,max_tokens:1}});
    const body=requestForTurn(participant,[]);
    assert.equal(body.max_tokens,4096);assert.equal(body.stream,false);
    if(['fara','browser-use'].includes(adapter))assert.equal(body.tools,undefined);
    else assert.notDeepEqual(body.tools,['wrong']);
  }
});
