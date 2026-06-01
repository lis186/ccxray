'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  totalContextTokens,
  parseSSEEvents,
  extractResponseTitle,
  extractLastUserText,
  extractToolResultSummary,
  extractFirstUserText,
  hasToolFail,
  extractToolCalls,
  computeThinkingDuration,
  categorizeTools,
  scanCredentials,
  entryHasCredential,
  classifyToolSource,
  buildToolSources,
  printContextBar,
} = require('../server/helpers');

describe('helpers', () => {
  describe('totalContextTokens', () => {
    it('returns 0 for null', () => {
      assert.equal(totalContextTokens(null), 0);
    });

    it('sums input + cache tokens', () => {
      const total = totalContextTokens({
        input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      });
      assert.equal(total, 600);
    });
  });

  // Terminal HUD that prints in the proxy stdout. The original user symptom
  // was a line like "Context [bar] 100% (212,625 / 200,000)" — bar clamped
  // to 100% while the textual numerator overflows the denominator. The fix
  // routes printContextBar through inferMaxContext so the denominator gets
  // bumped to 1M when usage exceeds the base for claude-* models without
  // the [1m] marker in system prompt.
  describe('printContextBar — usage-aware HUD output', () => {
    function captureStdout(fn) {
      const lines = [];
      const orig = console.log;
      console.log = (...args) => { lines.push(args.join(' ')); };
      try { fn(); } finally { console.log = orig; }
      // Strip ANSI color codes so assertions are stable
      return lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    }

    it('reproduces the reported symptom without the fix-path would show 100% — now shows real ratio', () => {
      // Exactly the entry the user pointed at: cache_read 212044 + creation 580
      // + input 1 = 212,625 total > 200,000 base.
      const out = captureStdout(() => {
        printContextBar(
          { cache_read_input_tokens: 212044, cache_creation_input_tokens: 580, input_tokens: 1 },
          'claude-opus-4-7',
          null,
        );
      });
      const joined = out.join('\n');
      // Denominator must be 1M (bumped), not 200K (the bug).
      assert.match(joined, /1,000,000/);
      assert.doesNotMatch(joined, /\/ 200,000/);
      // Percentage must reflect the real ratio (~21%), not the clamped 100%.
      assert.match(joined, /\b21%/);
      assert.doesNotMatch(joined, /\b100%/);
    });

    it('keeps 200K denominator when Claude usage genuinely fits inside 200K', () => {
      const out = captureStdout(() => {
        printContextBar(
          { input_tokens: 50_000, cache_read_input_tokens: 30_000 },
          'claude-opus-4-7',
          null,
        );
      });
      const joined = out.join('\n');
      assert.match(joined, /\/ 200,000/);
      assert.doesNotMatch(joined, /1,000,000/);
    });

    it('does not bump OpenAI models even when usage exceeds their base', () => {
      const out = captureStdout(() => {
        printContextBar(
          { input_tokens: 500_000 }, // > 400K base for gpt-5
          'gpt-5',
          null,
        );
      });
      const joined = out.join('\n');
      assert.match(joined, /\/ 400,000/);
      assert.doesNotMatch(joined, /1,000,000/);
    });
  });

  describe('parseSSEEvents', () => {
    it('parses SSE text into event objects', () => {
      const raw = 'data: {"type":"message_start"}\ndata: {"type":"content_block_delta"}\ndata: [DONE]\n';
      const events = parseSSEEvents(raw);
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'message_start');
      assert.equal(events[1].type, 'content_block_delta');
    });

    it('handles empty input', () => {
      assert.deepEqual(parseSSEEvents(''), []);
    });

    it('skips malformed JSON', () => {
      const raw = 'data: {"valid":true}\ndata: {invalid\ndata: {"also":"valid"}\n';
      const events = parseSSEEvents(raw);
      assert.equal(events.length, 2);
    });
  });

  describe('extractResponseTitle', () => {
    it('returns null for null input', () => {
      assert.equal(extractResponseTitle(null), null);
    });

    it('extracts title from SSE events', () => {
      const events = [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world. More text.' } },
      ];
      assert.equal(extractResponseTitle(events), 'Hello world');
    });

    it('truncates long titles to 80 chars', () => {
      const longText = 'A'.repeat(100);
      const events = [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: longText } },
      ];
      const title = extractResponseTitle(events);
      assert.equal(title.length, 80);
    });

    it('extracts from non-SSE response', () => {
      const res = { content: [{ type: 'text', text: 'Direct response text.' }] };
      assert.equal(extractResponseTitle(res), 'Direct response text');
    });
  });

  describe('extractToolCalls', () => {
    it('returns empty object for null/empty', () => {
      assert.deepEqual(extractToolCalls(null), {});
      assert.deepEqual(extractToolCalls([]), {});
    });

    it('counts tool calls from messages', () => {
      const messages = [
        { role: 'assistant', content: [
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Edit' },
          { type: 'tool_use', name: 'Read' },
        ]},
        { role: 'user', content: 'hello' },
      ];
      const counts = extractToolCalls(messages);
      assert.equal(counts.Read, 2);
      assert.equal(counts.Edit, 1);
    });
  });

  describe('extractOpenAIToolCalls', () => {
    const { extractOpenAIToolCalls } = require('../server/helpers');

    it('returns empty for null/empty', () => {
      assert.deepEqual(extractOpenAIToolCalls(null), {});
      assert.deepEqual(extractOpenAIToolCalls([]), {});
    });

    it('extracts from WS response.output_item.done events', () => {
      const events = [
        { type: 'response.output_item.done', item: { type: 'function_call', name: 'exec_command', call_id: 'c1' } },
        { type: 'response.output_item.done', item: { type: 'function_call', name: 'exec_command', call_id: 'c2' } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant' } },
      ];
      const counts = extractOpenAIToolCalls(events);
      assert.equal(counts.Bash, 2);
      assert.equal(Object.keys(counts).length, 1);
    });

    it('extracts from flat HTTP response.output[] items', () => {
      const output = [
        { type: 'function_call', name: 'apply_patch', call_id: 'c1' },
        { type: 'function_call', name: 'exec_command', call_id: 'c2' },
        { type: 'message', role: 'assistant' },
      ];
      const counts = extractOpenAIToolCalls(output);
      assert.equal(counts.Edit, 1);
      assert.equal(counts.Bash, 1);
    });

    it('skips meta-tools without .name', () => {
      const output = [
        { type: 'function_call', call_id: 'c1' },
        { type: 'web_search', call_id: 'c2' },
      ];
      const counts = extractOpenAIToolCalls(output);
      assert.deepEqual(counts, {});
    });

    it('deduplicates .added + .done for same call_id', () => {
      const events = [
        { type: 'response.output_item.added', item: { type: 'function_call', name: 'exec_command', call_id: 'c1' } },
        { type: 'response.output_item.done', item: { type: 'function_call', name: 'exec_command', call_id: 'c1' } },
      ];
      const counts = extractOpenAIToolCalls(events);
      assert.equal(counts.Bash, 1);
    });
  });

  describe('computeThinkingDuration', () => {
    it('returns null when no thinking events', () => {
      assert.equal(computeThinkingDuration([{ type: 'message_start' }]), null);
    });

    it('computes duration between thinking start and stop', () => {
      const events = [
        { type: 'content_block_start', content_block: { type: 'thinking' }, _ts: 1000 },
        { type: 'content_block_delta', _ts: 1500 },
        { type: 'content_block_stop', _ts: 3000 },
      ];
      assert.equal(computeThinkingDuration(events), 2);
    });
  });

  describe('scanCredentials', () => {
    it('returns false for null/empty', () => {
      assert.equal(scanCredentials(null), false);
      assert.equal(scanCredentials(''), false);
    });

    it('detects Anthropic API key', () => {
      assert.equal(scanCredentials('sk-ant-api03-' + 'a'.repeat(30)), true);
    });

    it('detects GitHub PAT', () => {
      assert.equal(scanCredentials('ghp_' + 'a'.repeat(36)), true);
    });

    it('detects AWS access key', () => {
      assert.equal(scanCredentials('AKIA' + 'A'.repeat(16)), true);
    });

    it('detects PEM private key header', () => {
      assert.equal(scanCredentials('-----BEGIN RSA PRIVATE KEY-----'), true);
    });

    it('returns false for clean text', () => {
      assert.equal(scanCredentials('hello world, no secrets here'), false);
    });

    // Fix 1: URL-encoded bypass
    it('detects URL-encoded credential', () => {
      // sk-ant-<20+ chars> with dashes encoded as %2D
      assert.equal(scanCredentials('sk%2Dant%2D' + 'a'.repeat(20)), true);
    });

    it('detects URL-encoded GitHub PAT', () => {
      assert.equal(scanCredentials('ghp%5F' + 'a'.repeat(36)), true);
    });
  });

  describe('entryHasCredential', () => {
    it('returns false for empty entry', () => {
      assert.equal(entryHasCredential({}), false);
    });

    it('detects credential in assistant SSE text delta', () => {
      const entry = {
        res: [{
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'sk-ant-api03-' + 'a'.repeat(30) },
        }],
      };
      assert.equal(entryHasCredential(entry), true);
    });

    it('detects credential in tool_result string content', () => {
      const entry = {
        req: { messages: [{
          role: 'user',
          content: [{ type: 'tool_result', content: 'AKIA' + 'A'.repeat(16) }],
        }]},
      };
      assert.equal(entryHasCredential(entry), true);
    });

    it('detects credential in tool_result array content', () => {
      const entry = {
        req: { messages: [{
          role: 'user',
          content: [{ type: 'tool_result', content: [
            { type: 'text', text: 'ghp_' + 'a'.repeat(36) },
          ]}],
        }]},
      };
      assert.equal(entryHasCredential(entry), true);
    });

    // Fix 2: tool_use input scan
    it('detects credential in tool_use input', () => {
      const entry = {
        req: { messages: [{
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'curl -H "Authorization: ghp_' + 'a'.repeat(36) + '"' },
          }],
        }]},
      };
      assert.equal(entryHasCredential(entry), true);
    });

    it('returns false for clean entry', () => {
      const entry = {
        res: [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'nothing sensitive' } }],
        req: { messages: [{
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { path: '/tmp/foo.txt' } }],
        }]},
      };
      assert.equal(entryHasCredential(entry), false);
    });
  });

  describe('categorizeTools', () => {
    it('returns empty for null/empty', () => {
      const result = categorizeTools(null);
      assert.deepEqual(result.counts, {});
    });

    it('categorizes core and MCP tools', () => {
      const tools = [
        { name: 'Read' },
        { name: 'Edit' },
        { name: 'mcp__github__create_issue' },
        { name: 'mcp__github__list_prs' },
        { name: 'mcp__slack__send_message' },
        { name: 'UnknownTool' },
      ];
      const result = categorizeTools(tools);
      assert.equal(result.counts.core, 2);
      assert.equal(result.counts.mcp, 3);
      assert.equal(result.counts.other, 1);
      assert.equal(result.mcpPlugins.length, 2); // github, slack
    });
  });

  describe('classifyToolSource', () => {
    it('classifies WebFetch as network', () => {
      assert.equal(classifyToolSource('WebFetch', { url: 'https://example.com' }), 'network');
    });

    it('classifies WebSearch as network', () => {
      assert.equal(classifyToolSource('WebSearch', { query: 'hello' }), 'network');
    });

    it('classifies mcp tool with fetch suffix as network', () => {
      assert.equal(classifyToolSource('mcp__brave__web_fetch', {}), 'network');
    });

    it('classifies mcp tool with search suffix as network', () => {
      assert.equal(classifyToolSource('mcp__tavily__search', {}), 'network');
    });

    it('classifies Read with sensitive path as local:sensitive', () => {
      assert.equal(classifyToolSource('Read', { file_path: '/Users/foo/.ssh/id_rsa' }), 'local:sensitive');
    });

    it('classifies Bash with .env path as local:sensitive', () => {
      assert.equal(classifyToolSource('Bash', { command: 'cat .env' }), 'local:sensitive');
    });

    it('classifies Read with plain path as local', () => {
      assert.equal(classifyToolSource('Read', { file_path: '/tmp/foo.txt' }), 'local');
    });

    it('classifies unknown tool as local (conservative default)', () => {
      assert.equal(classifyToolSource('SomeCustomTool', { x: 1 }), 'local');
    });
  });

  describe('buildToolSources', () => {
    it('returns empty object for entry with no tool_use', () => {
      const entry = { req: { messages: [{ role: 'user', content: 'hello' }] } };
      assert.deepEqual(buildToolSources(entry), {});
    });

    it('maps tool_use id to classified source', () => {
      const entry = {
        req: { messages: [{
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'WebFetch', input: { url: 'https://x.com' } },
            { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/tmp/a.txt' } },
          ],
        }]},
      };
      const sources = buildToolSources(entry);
      assert.equal(sources['tu_1'], 'network');
      assert.equal(sources['tu_2'], 'local');
    });

    it('handles entry with no req', () => {
      assert.deepEqual(buildToolSources({}), {});
    });
  });

  describe('extractLastUserText', () => {
    it('returns null for missing or empty input', () => {
      assert.equal(extractLastUserText(null), null);
      assert.equal(extractLastUserText({}), null);
      assert.equal(extractLastUserText({ messages: [] }), null);
    });

    it('extracts text from string-content user message', () => {
      const req = { messages: [
        { role: 'assistant', content: 'something' },
        { role: 'user', content: 'Fix the login bug please' },
      ]};
      assert.equal(extractLastUserText(req), 'Fix the login bug please');
    });

    it('extracts first sentence from block-content user message', () => {
      const req = { messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Refactor auth.  Also add tests.' }],
      }]};
      assert.equal(extractLastUserText(req), 'Refactor auth');
    });

    it('returns null when last user msg is only tool_results', () => {
      const req = { messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ]};
      assert.equal(extractLastUserText(req), null);
    });

    it('ignores non-text blocks when searching for text', () => {
      const req = { messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'noise' },
          { type: 'text', text: 'actual question' },
        ],
      }]};
      assert.equal(extractLastUserText(req), 'actual question');
    });
  });

  describe('extractToolResultSummary', () => {
    const req = (messages) => ({ messages });

    it('returns null when no tool_results', () => {
      assert.equal(extractToolResultSummary(req([
        { role: 'user', content: 'hi' },
      ])), null);
    });

    it('maps tool_use_id to name and produces summary', () => {
      const r = req([
        { role: 'user', content: 'do stuff' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'Read' },
          { type: 'tool_use', id: 't2', name: 'Bash' },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1' },
          { type: 'tool_result', tool_use_id: 't2' },
        ]},
      ]);
      assert.equal(extractToolResultSummary(r), '↩ Read · Bash');
    });

    it('dedupes repeated tool names', () => {
      const r = req([
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'Bash' },
          { type: 'tool_use', id: 't2', name: 'Bash' },
          { type: 'tool_use', id: 't3', name: 'Bash' },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1' },
          { type: 'tool_result', tool_use_id: 't2' },
          { type: 'tool_result', tool_use_id: 't3' },
        ]},
      ]);
      assert.equal(extractToolResultSummary(r), '↩ Bash');
    });

    it('caps at 5 with overflow marker', () => {
      const ids = ['a','b','c','d','e','f','g'];
      const names = ['Read','Bash','Write','Edit','Grep','Glob','WebFetch'];
      const r = req([
        { role: 'assistant', content: ids.map((id, i) => ({ type: 'tool_use', id, name: names[i] })) },
        { role: 'user', content: ids.map(id => ({ type: 'tool_result', tool_use_id: id })) },
      ]);
      assert.equal(extractToolResultSummary(r), '↩ Read · Bash · Write · Edit · Grep +2');
    });

    it('strips mcp__server__ prefix from tool names', () => {
      const r = req([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__github__list_issues' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      ]);
      assert.equal(extractToolResultSummary(r), '↩ list_issues');
    });

    it('returns null when tool_use_id has no matching tool_use', () => {
      const r = req([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown' }] },
      ]);
      assert.equal(extractToolResultSummary(r), null);
    });
  });

  describe('extractFirstUserText', () => {
    it('returns null for missing input', () => {
      assert.equal(extractFirstUserText(null), null);
      assert.equal(extractFirstUserText({ messages: [] }), null);
    });

    it('returns first user text, ignoring non-text blocks', () => {
      const req = { messages: [
        { role: 'user', content: [
          { type: 'tool_result', content: 'noise' },
          { type: 'text', text: 'Search for login bug.  Also check API.' },
        ]},
        { role: 'user', content: 'later message' },
      ]};
      assert.equal(extractFirstUserText(req), 'Search for login bug');
    });

    it('skips empty first user message and continues to next', () => {
      const req = { messages: [
        { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
        { role: 'user', content: 'real task' },
      ]};
      assert.equal(extractFirstUserText(req), 'real task');
    });
  });

  describe('hasToolFail', () => {
    it('returns false for missing input', () => {
      assert.equal(hasToolFail(null), false);
      assert.equal(hasToolFail({}), false);
      assert.equal(hasToolFail({ messages: [] }), false);
    });

    it('returns true when any tool_result has is_error: true', () => {
      const req = { messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: false },
          { type: 'tool_result', tool_use_id: 't2', is_error: true },
        ],
      }]};
      assert.equal(hasToolFail(req), true);
    });

    it('returns false when all tool_results are successful', () => {
      const req = { messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }],
      }]};
      assert.equal(hasToolFail(req), false);
    });

    it('treats undefined is_error as success', () => {
      const req = { messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1' }],
      }]};
      assert.equal(hasToolFail(req), false);
    });
  });
});
