'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractOpenAIToolCalls,
  extractOpenAIToolCallIds,
  extractMcpFromExecInput,
  extractMcpFromUseToolArgs,
  OPENAI_TOOL_CALL_TYPES,
} = require('../server/helpers');

// #577: extractOpenAIToolCalls missed custom_tool_call, causing 98.9% of
// Codex tool counts to be invisible. These tests would fail on old code.

describe('#577 extractOpenAIToolCalls fixes', () => {
  // Fix 1: custom_tool_call type is counted
  it('counts custom_tool_call items (fail-on-old: old code returns {})', () => {
    const events = [
      { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'ls' },
      { type: 'custom_tool_call', call_id: 'c2', name: 'read_file', input: 'a.js' },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.ok(Object.keys(counts).length > 0, 'should have counts');
    assert.equal(counts['read_file'], 1);
  });

  // Fix 2: MCP names extracted from exec input
  it('extracts mcp__ names from exec input alongside Bash count', () => {
    const events = [
      {
        type: 'custom_tool_call',
        call_id: 'c1',
        name: 'exec',
        input: 'const r = await tools.mcp__node_repl__js({code:"1+1"});\nconst s = await tools.mcp__codex_apps__drive({q:"test"});',
      },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['Bash'], 1, 'exec itself counts as Bash');
    assert.equal(counts['mcp__node_repl__js'], 1);
    assert.equal(counts['mcp__codex_apps__drive'], 1);
  });

  it('does not extract mcp names from non-process-tool input', () => {
    const events = [
      {
        type: 'custom_tool_call',
        call_id: 'c1',
        name: 'read_file',
        input: 'tools.mcp__fake__thing()',
      },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['read_file'], 1);
    assert.equal(counts['mcp__fake__thing'], undefined, 'should not extract from non-exec');
  });

  // Fix 3: Grok use_tool gateway
  it('extracts real MCP tool name from use_tool arguments', () => {
    const events = [
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'use_tool',
        arguments: JSON.stringify({ tool_name: 'linear__save_issue', tool_input: { title: 'test' } }),
      },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['linear__save_issue'], 1);
    assert.equal(counts['use_tool'], undefined, 'use_tool itself should not be counted');
  });

  it('falls back to use_tool when arguments parsing fails', () => {
    const events = [
      { type: 'function_call', call_id: 'c1', name: 'use_tool', arguments: 'not-json' },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['use_tool'], 1);
  });

  // Fix 4: alias consistency — exec → Bash in both extractors
  it('maps exec to Bash consistently in both extractors', () => {
    const events = [
      { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'echo hi' },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['Bash'], 1, 'extractOpenAIToolCalls: exec → Bash');

    const ids = extractOpenAIToolCallIds(events);
    assert.equal(ids['c1'], 'Bash', 'extractOpenAIToolCallIds: exec → Bash');
  });

  it('maps run_terminal_command to Bash in both extractors', () => {
    const events = [
      { type: 'function_call', call_id: 'c1', name: 'run_terminal_command' },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['Bash'], 1);
    const ids = extractOpenAIToolCallIds(events);
    assert.equal(ids['c1'], 'Bash');
  });
});

describe('#577 MCP extraction helpers', () => {
  it('extractMcpFromExecInput extracts mcp__ tool names', () => {
    const input = 'const r = await tools.mcp__node_repl__js({code:"1"});';
    assert.deepEqual(extractMcpFromExecInput(input), ['mcp__node_repl__js']);
  });

  it('extractMcpFromExecInput returns empty for no matches', () => {
    assert.deepEqual(extractMcpFromExecInput('echo hello'), []);
    assert.deepEqual(extractMcpFromExecInput(null), []);
    assert.deepEqual(extractMcpFromExecInput(42), []);
  });

  it('extractMcpFromExecInput handles multiple names', () => {
    const input = 'tools.mcp__a({});\ntools.mcp__b({});';
    assert.deepEqual(extractMcpFromExecInput(input), ['mcp__a', 'mcp__b']);
  });

  it('extractMcpFromUseToolArgs extracts tool_name from JSON', () => {
    assert.equal(
      extractMcpFromUseToolArgs(JSON.stringify({ tool_name: 'linear__save_issue' })),
      'linear__save_issue'
    );
  });

  it('extractMcpFromUseToolArgs returns null for bad input', () => {
    assert.equal(extractMcpFromUseToolArgs('not json'), null);
    assert.equal(extractMcpFromUseToolArgs(null), null);
    assert.equal(extractMcpFromUseToolArgs(JSON.stringify({})), null);
  });
});

describe('#577 wrapped event format', () => {
  it('handles WS event wrappers with custom_tool_call', () => {
    const events = [
      {
        type: 'response.output_item.done',
        item: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'pwd' },
      },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['Bash'], 1);
  });

  it('handles WS event wrappers with data.item', () => {
    const events = [
      {
        type: 'response.output_item.done',
        data: { item: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'ls' } },
      },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['Bash'], 1);
  });
});

describe('#577 fable review fixes', () => {
  it('both extractors use the same OPENAI_TOOL_CALL_TYPES set', () => {
    // Pin: adding a new type to the Set covers both extractors
    assert.ok(OPENAI_TOOL_CALL_TYPES.has('custom_tool_call'));
    assert.ok(OPENAI_TOOL_CALL_TYPES.has('function_call'));
    assert.ok(OPENAI_TOOL_CALL_TYPES.has('tool_call'));
  });

  it('duplicate mcp name in one exec input counts each occurrence', () => {
    const events = [
      {
        type: 'custom_tool_call',
        call_id: 'c1',
        name: 'exec',
        input: 'await tools.mcp__a({x:1}); await tools.mcp__a({x:2});',
      },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['mcp__a'], 2, 'two calls to same MCP tool = count 2');
    assert.equal(counts['Bash'], 1);
  });

  it('extractMcpFromExecInput is safe across sequential calls (no /g/ state leak)', () => {
    const a = extractMcpFromExecInput('tools.mcp__x({})');
    const b = extractMcpFromExecInput('tools.mcp__y({})');
    assert.deepEqual(a, ['mcp__x']);
    assert.deepEqual(b, ['mcp__y']);
  });
});

describe('#577 codex review P2 fixes', () => {
  // P2-1: .done must win over .added when both carry the same call_id
  it('prefers .done over .added so MCP names in input are extracted', () => {
    const events = [
      // .added arrives first with empty input
      {
        type: 'response.output_item.added',
        item: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: '' },
      },
      // .done arrives later with real input
      {
        type: 'response.output_item.done',
        item: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.mcp__node_repl__js({code:"1"});' },
      },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['Bash'], 1);
    assert.equal(counts['mcp__node_repl__js'], 1, '.done input should be used, not .added empty input');
  });

  // P2-2: tool_name fallback for custom_tool_call items
  it('reads tool_name when name is absent (custom_tool_call shape)', () => {
    const events = [
      { type: 'custom_tool_call', call_id: 'c1', tool_name: 'exec_command' },
    ];
    const counts = extractOpenAIToolCalls(events);
    assert.equal(counts['Bash'], 1, 'tool_name should be read and aliased');
  });
});
