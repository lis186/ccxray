'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractUsage,
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
} = require('../server/helpers');

describe('helpers', () => {
  describe('extractUsage', () => {
    it('returns null for non-array input', () => {
      assert.equal(extractUsage(null), null);
      assert.equal(extractUsage('string'), null);
      assert.equal(extractUsage({}), null);
    });

    it('extracts usage from SSE events', () => {
      const events = [
        { type: 'message_start', message: { usage: {
          input_tokens: 1000,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        }}},
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        { type: 'message_delta', usage: { output_tokens: 500 } },
      ];
      const usage = extractUsage(events);
      assert.equal(usage.input_tokens, 1000);
      assert.equal(usage.output_tokens, 500); // message_delta overrides
      assert.equal(usage.cache_creation_input_tokens, 200);
      assert.equal(usage.cache_read_input_tokens, 300);
    });

    it('handles missing usage gracefully', () => {
      const usage = extractUsage([{ type: 'message_start', message: {} }]);
      assert.equal(usage.input_tokens, 0);
      assert.equal(usage.output_tokens, 0);
    });

    it('preserves nested cache_creation ephemeral TTL split', () => {
      const events = [
        { type: 'message_start', message: { usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 1632,
          cache_read_input_tokens: 332655,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 1632,
          },
        }}},
      ];
      const usage = extractUsage(events);
      assert.equal(usage.cache_creation.ephemeral_1h_input_tokens, 1632);
      assert.equal(usage.cache_creation.ephemeral_5m_input_tokens, 0);
    });

    it('omits cache_creation when not present in response', () => {
      const events = [
        { type: 'message_start', message: { usage: {
          input_tokens: 100, cache_creation_input_tokens: 0,
        }}},
      ];
      const usage = extractUsage(events);
      assert.equal(usage.cache_creation, undefined);
    });
  });

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
