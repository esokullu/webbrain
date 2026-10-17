import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { getToolsForMode } = await import(`../src/${browser}/src/agent/tools.js`);
  const { validateToolArguments } = await import(`../src/${browser}/src/agent/tool-arguments.js`);
  const { projectTableSnapshot, structuredTableAnswerBlock } = await import(`../src/${browser}/src/agent/structured-table-export.js`);
  const continuation = { filter: 'all', maxDepth: 15, maxChars: 12000,
    ref_id: 'ref_42', page: 2, tree_revision: 'observed-revision' };
  const columns = [{ name: 'ID', index: 0, type: 'string' }, { name: 'stock', index: 1, type: 'integer' },
    { name: 'unit_price_cents', index: 2, type: 'integer' }, { name: 'exacttechnical_literal', index: 3, type: 'string' }];
  const snapshot = { schema: 'webbrain.table-snapshot.v1', success: true,
    documentToken: 'owned-document', pageUrl: 'https://owned.example.test/inventory', tableIndex: 1, caption: 'Synthetic inventory',
    headerRows: [['ID', 'stock', 'unit_price_cents', 'exacttechnical_literal']],
    rows: Array.from({ length: 172 }, (_, index) => [`ID-${(index * 73) % 172}`, String(index), String(index * 119),
      `  µ quote" slash\\ Ω\tline\n${index}  `]) };
  function tableAgent() {
    const agent = new Agent({ getActive: () => null });
    agent._effectiveRunMode = () => 'ask';
    agent.conversations.set(1, [{ role: 'system', content: 'Follow the authentic current task.' },
      { role: 'user', content: 'Extract every inventory row exactly.', webbrainUserAuthoredText: 'Extract every inventory row exactly.' }]);
    agent.readCompletenessStates.set(1, { runToken: 'owned-run', tablePageObserved: true });
    return agent;
  }
  function extract(agent, source = snapshot, selectedColumns = columns) {
    return agent._acceptExactTableSnapshot(1, { type: 'tables', caption: 'Synthetic inventory', columns: selectedColumns },
      source, agent._exactTableOwner(1));
  }
  test(`${browser}: literal projection copies all172 values and refuses unsafe numeric/credential conversion`, () => {
    const exported = projectTableSnapshot(snapshot, { columns });
    assert.equal(exported.success, true); assert.equal(exported.payload.rowCount, 172);
    assert.deepEqual(exported.payload.rows.map(row => row.ID), snapshot.rows.map(row => row[0]));
    assert.deepEqual(exported.payload.rows.map(row => row.exacttechnical_literal), snapshot.rows.map(row => row[3]));
    assert.ok(exported.summary.length > 12000);
    assert.equal(typeof exported.payload.rows[171].stock, 'number');
    for (const stock of ['9007199254740993', '3.2', '', '12 dollars']) {
      assert.equal(projectTableSnapshot({ ...snapshot, rows: [['ID', stock, '5', 'µ']] }, { columns }).success, false);
    }
    assert.equal(projectTableSnapshot(snapshot, { columns: [{ name: 'password', index: 3, type: 'string' }] }, true).success, false);
    assert.equal(projectTableSnapshot({ ...snapshot, headerRows: [['ID', 'stock', 'unit_price_cents', 'API key']] },
      { columns: [{ name: 'value', index: 3, type: 'string' }] }, true).success, false,
      'Renaming a native credential column cannot bypass strict secret handling');
    assert.equal(projectTableSnapshot(snapshot, { columns }, true).success, true);
    for (const literal of ['9007199254740993', '0.100000000000000000001', '1e-99999']) {
      assert.equal(projectTableSnapshot({ ...snapshot, rows: [[literal]] }, { columns: [{ name: 'n', index: 0, type: 'number' }] }).success, false);
    }
    for (const literal of ['0.1', '1.00', '+0003e2', '-2.5e-7']) {
      assert.equal(projectTableSnapshot({ ...snapshot, rows: [[literal]] }, { columns: [{ name: 'n', index: 0, type: 'number' }] }).success, true);
    }
    assert.equal(projectTableSnapshot({ ...snapshot, rows: [['missing']] }, { columns }).success, false);
    assert.equal(projectTableSnapshot({ ...snapshot, rows: [['ID', '1', '2', 'x'.repeat(2000001)]] }, { columns }).success, false);
    const beyondDeliveryCapacity = projectTableSnapshot({ ...snapshot,
      rows: [['ID', '1', '2', 'µ'.repeat(30001)]] }, { columns });
    assert.equal(beyondDeliveryCapacity.success, false,
      'An export that the terminal UI would clip must fail before creating a complete data reference');
    assert.equal(beyondDeliveryCapacity.summary, undefined);
    assert.match(beyondDeliveryCapacity.error, /limit|fit/i);
  });
  test(`${browser}: exact export returns a small reference and completes only after an independent fresh source read`, async () => {
    const agent = tableAgent(), receipt = extract(agent), events = [];
    assert.equal(receipt.rowCount, 172); assert.equal(receipt.complete, true);
    assert.ok(JSON.stringify(receipt).length < 4000);
    assert.equal(Object.hasOwn(receipt, 'rows'), false);
    let rereads = 0;
    const ordinaryTool = agent.executeTool.bind(agent);
    agent.executeTool = async (tab, name, args, onUpdate, context) => {
      if (name !== 'extract_data') return ordinaryTool(tab, name, args, onUpdate, context);
      rereads++; assert.deepEqual(args.columns, columns);
      return agent._acceptExactTableSnapshot(tab, args, structuredClone(snapshot), agent._exactTableOwner(tab),
        context._exactTableVerificationRecord);
    };
    const result = await agent.executeTool(1, 'done', { summary: 'Exact table export', data_ref: receipt.data_ref },
      (name, data) => events.push({ name, data }));
    assert.equal(result.done, true); assert.equal(rereads, 1);
    assert.deepEqual(JSON.parse(result.summary), projectTableSnapshot(snapshot, { columns }).payload);
    assert.equal(events.filter(event => event.name === 'tool_call' && event.data.verification).length, 1);
    assert.ok(structuredTableAnswerBlock(agent.readCompletenessStates.get(1), result.summary),
      'A cached matching plain answer still must pass the fresh done.data_ref check');
  });
  test(`${browser}: stale, forged, mutated, stopped and cross-task table references cannot complete`, async () => {
    for (const reason of ['forged', 'document', 'url', 'cells', 'run', 'task', 'stop']) {
      const agent = tableAgent(), receipt = extract(agent);
      const next = structuredClone(snapshot);
      if (reason === 'document') next.documentToken = 'replacement-document';
      if (reason === 'url') next.pageUrl += '?route-changed';
      if (reason === 'cells') next.rows[4][3] += 'changed';
      const ordinaryTool = agent.executeTool.bind(agent);
      agent.executeTool = async (tab, name, args, onUpdate, context) => {
        if (name !== 'extract_data') return ordinaryTool(tab, name, args, onUpdate, context);
        if (reason === 'run') agent.readCompletenessStates.set(tab, { runToken: 'new-run' });
        if (reason === 'task') agent.conversations.set(tab, [{ role: 'system', content: 'Follow the authentic current task.' },
          { role: 'user', content: 'A different task.', webbrainUserAuthoredText: 'A different task.' }]);
        if (reason === 'stop') agent._checkAbort = () => true;
        return agent._acceptExactTableSnapshot(tab, args, next, agent._exactTableOwner(tab), context._exactTableVerificationRecord);
      };
      const result = await agent.executeTool(1, 'done', { summary: 'Complete', data_ref: reason === 'forged' ? 'from-page-text' : receipt.data_ref });
      assert.equal(result.blockedDone, true, reason); assert.notEqual(result.done, true, reason);
    }
  });
  test(`${browser}: exact table tools remain typed and support all ordinary done modes`, () => {
    for (const mode of ['ask', 'act', 'dev']) for (const strictSecretMode of [true, false]) {
      const tools = getToolsForMode(mode, { tier: 'full', strictSecretMode });
      const schema = tools.find(tool => tool.function.name === 'extract_data').function.parameters;
      assert.equal(validateToolArguments('extract_data', { type: 'tables', caption: 'Synthetic inventory', columns,
        row_filter: { column: 0, equals: ['ID-4', 'ID-2'] } }, schema).ok, true);
      assert.equal(validateToolArguments('extract_data', { type: 'tables', columns: [{ name: 'x', index: 1, type: 'guess' }] }, schema).ok, false);
      const terminal = tools.find(tool => tool.function.name === 'done').function.parameters;
      assert.equal(validateToolArguments('done', { summary: 'Export', data_ref: 'table_owned', ...(mode !== 'ask' ? { outcome: 'success' } : {}) }, terminal).ok, true);
    }
    const agent = tableAgent();
    agent._recordReadCompleteness(1, 'get_accessibility_tree', {}, { tableCount: 2 });
    assert.equal(agent.readCompletenessStates.get(1).tablePageObserved, true);
    for (const [name, args, result] of [['read_page', {}, { tableCount: 2 }],
      ['extract_data', { type: 'tables' }, [{ rows: [['ID'], ['ID-1']] }]]]) {
      agent.readCompletenessStates.get(1).tablePageObserved = false;
      agent._recordReadCompleteness(1, name, args, result);
      assert.equal(agent.readCompletenessStates.get(1).tablePageObserved, true, name);
    }
    const receipt = extract(agent);
    const oldOwner = agent._exactTableOwner(1);
    agent.readCompletenessStates.set(1, { runToken: 'new-run' });
    assert.equal(agent._acceptExactTableSnapshot(1, { columns }, snapshot, oldOwner).success, false);
    assert.ok(receipt.data_ref);
  });

  test(`${browser}: sampled or corrupted table JSON cannot complete a literal extraction`, async () => {
    const agent = new Agent({ getActive: () => null });
    // Strict checks: the guard's refusal itself is under test.
    agent.strictGuards = true;
    agent._effectiveRunMode = () => 'ask';
    const rows = Array.from({ length: 172 }, (_, index) => ({
      ID: `ID-${(index * 73) % 172}`, stock: index, unit_price_cents: index * 119,
      exacttechnical_literal: `  µ quote" slash\\ Ω ${index}  `,
    }));
    agent.readCompletenessStates.set(1, { runToken: 'owned-run', tablePageObserved: true });
    for (const candidate of [rows.slice(0, 20), rows.map(row => ({
      ...row, exacttechnical_literal: row.exacttechnical_literal.replace('µ', 'յ'),
    }))]) {
      const result = await agent.executeTool(1, 'done', {
        summary: JSON.stringify({ rowCount: candidate.length, rows: candidate }), outcome: 'success',
      });
      assert.equal(result.blockedDone, true, 'Neither a prefix nor changed technical literals prove a complete source extraction');
      assert.notEqual(result.done, true);
    }
  });

  for (const mode of ['ask', 'act', 'dev']) {
    test(`${browser}: ${mode} expanded tree reads accept the exact returned continuation in both documented forms`, () => {
      for (const tier of ['mid', 'full']) {
        const schema = getToolsForMode(mode, { tier, accessibilityTreeMaxChars: 12000 })
          .find(tool => tool.function.name === 'get_accessibility_tree').function.parameters;
        for (const args of [continuation, { continuationArgs: continuation }]) {
          assert.equal(validateToolArguments('get_accessibility_tree', args, schema).ok, true,
            `${mode}/${tier} must accept the returned 12000-character continuation without a needless repair turn`);
        }
        assert.equal(validateToolArguments('get_accessibility_tree', {
          continuationArgs: { ...continuation, maxChars: 12001 },
        }, schema).ok, false, 'The expanded continuation must retain its output bound');
        assert.equal(validateToolArguments('get_accessibility_tree', {
          continuationArgs: { ...continuation, undeclared: true },
        }, schema).ok, false, 'Expansion must preserve closed argument validation');
      }
    });
  }

  test(`${browser}: direct runtime schema fallback accepts expanded continuation and keeps standard reads bounded`, () => {
    const agent = new Agent({ getActive: () => null });
    agent._readWindowLimits = () => ({ treePageChars: 12000 });
    const schema = agent._toolParametersForValidation(1, 'get_accessibility_tree');
    assert.equal(validateToolArguments('get_accessibility_tree', { continuationArgs: continuation }, schema).ok, true);
    assert.deepEqual(agent._normalizeContinuationToolArgs('get_accessibility_tree', {
      continuationArgs: continuation,
    }), continuation, 'Accepted compatibility form must preserve the exact next page and observed revision');
    for (const tier of ['compact', 'mid', 'full']) {
      const standard = getToolsForMode('act', { tier, accessibilityTreeMaxChars: tier === 'compact' ? 12000 : 6000 })
        .find(tool => tool.function.name === 'get_accessibility_tree').function.parameters;
      assert.equal(validateToolArguments('get_accessibility_tree', {
        continuationArgs: continuation,
      }, standard).ok, false, 'Standard and Compact windows must not become expanded through a nested argument');
      assert.equal(validateToolArguments('get_accessibility_tree', {
        continuationArgs: { ...continuation, maxChars: 6000 },
      }, standard).ok, true);
    }
  });

  test(`${browser}: oversized declared prose windows are bounded without losing the requested document position`, () => {
    const agent = new Agent({ getActive: () => null });
    const schema = getToolsForMode('act', { tier: 'full' })
      .find(tool => tool.function.name === 'read_page').function.parameters;
    for (const args of [{ limit: 8000, offset: 4000, includeChrome: true }, {
      continuationArgs: { limit: 8000, offset: 4000, includeChrome: true },
    }]) {
      const repaired = agent._repairToolCallArgs('read_page', args);
      assert.equal(repaired.repaired, true);
      assert.equal(validateToolArguments('read_page', repaired.args, schema).ok, true);
      assert.deepEqual(agent._normalizeContinuationToolArgs('read_page', repaired.args), {
        limit: 6000, offset: 4000, includeChrome: true,
      });
      assert.match(repaired.note, /6000/);
      assert.equal((args.continuationArgs || args).limit, 8000, 'Do not mutate provider-call arguments or persisted history');
    }
    for (const args of [{ limit: '8000' }, { limit: 8000.5 }, { limit: 400 }, { limit: 8000, url: 'https://owned.example.test/' }]) {
      assert.equal(validateToolArguments('read_page', agent._repairToolCallArgs('read_page', args).args, schema).ok, false,
        'Bound repair must retain strict type, lower bound and declared-field validation');
    }
  });

  test(`${browser}: malformed native ref suffixes fail without dispatch or invented scope; canonical reads recover`, () => {
    const agent = new Agent({ getActive: () => null });
    const tool = getToolsForMode('act', { tier: 'full', accessibilityTreeMaxChars: 12000 })
      .find(tool => tool.function.name === 'get_accessibility_tree');
    assert.equal(tool.function.parameters.properties.ref_id.pattern, '^(?:ref_[0-9]+)?$');
    assert.equal(tool.function.parameters.properties.continuationArgs.properties.ref_id.pattern, '^(?:ref_[0-9]+)?$');
    for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
      for (const args of [{ ref_id: `ref_42${suffix}` }, { continuationArgs: { ...continuation, ref_id: `ref_42${suffix}` } }]) {
        const rejected = validateToolArguments('get_accessibility_tree', args, tool.function.parameters);
        assert.equal(rejected.ok, false, 'Schema end anchors must not admit trailing line separators into native refs');
        assert.equal(rejected.result.noDispatch, true);
      }
    }
    for (const args of [{ ref_id: 'ref_42}]}]}' }, { continuationArgs: { ...continuation, ref_id: 'ref_42}]}]}' } },
      { ...continuation, ref_id: 'ref_42}]}]}', continuationArgs: continuation }]) {
      const repaired = agent._repairToolCallArgs('get_accessibility_tree', args, { treePageChars: 12000 });
      assert.equal((repaired.args.ref_id || repaired.args.continuationArgs.ref_id),
        args.ref_id || args.continuationArgs.ref_id, 'Do not silently repair an invented ref into an observed native anchor');
      const validation = validateToolArguments('get_accessibility_tree', repaired.args, tool.function.parameters);
      assert.equal(validation.ok, false); assert.equal(validation.result.noDispatch, true);
      assert.equal(validation.result.errorCode, 'invalid_tool_arguments');
      assert.ok(validation.result.invalidArgumentNames.some(name => /ref_id$/.test(name)));
    }
    for (const args of [{}, { ref_id: '' }, { ref_id: 'ref_42' }, { continuationArgs: continuation }]) {
      assert.equal(validateToolArguments('get_accessibility_tree', args, tool.function.parameters).ok, true);
    }
    const fallback = agent._toolParametersForValidation(1, 'get_accessibility_tree');
    assert.equal(validateToolArguments('get_accessibility_tree', { ref_id: 'ref_42}]}]}' }, fallback).ok, false);
  });
}
