'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractUsage,
  totalContextTokens,
  parseSSEEvents,
  extractResponseTitle,
  extractToolCalls,
  computeThinkingDuration,
  categorizeTools,
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
});
