'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeEntry } = require('../server/sse-broadcast');

describe('sse-broadcast', () => {
  describe('summarizeEntry', () => {
    it('returns all summary fields from pre-computed entry properties when req/res are null', () => {
      const entry = {
        id: 'test-001', ts: '14:30:22', sessionId: 'sess-1',
        method: 'POST', url: '/v1/messages',
        elapsed: '1.5', status: 200, isSSE: true,
        usage: { input_tokens: 100, output_tokens: 50 },
        cost: { cost: 0.01 }, maxContext: 200000,
        cwd: '/test', receivedAt: Date.now(),
        // Pre-computed fields
        model: 'claude-sonnet-4-20250514',
        msgCount: 5,
        toolCount: 3,
        toolCalls: ['Read', 'Edit'],
        isSubagent: false,
        title: 'Test response',
        stopReason: 'end_turn',
        thinkingDuration: 1200,
        duplicateToolCalls: null,
        tokens: { system: 100, tools: 50, messages: 200, total: 350 },
        // req/res are null (released from memory)
        req: null, res: null, _loaded: false,
      };

      const summary = summarizeEntry(entry);

      assert.equal(summary.model, 'claude-sonnet-4-20250514');
      assert.equal(summary.msgCount, 5);
      assert.equal(summary.toolCount, 3);
      assert.deepEqual(summary.toolCalls, ['Read', 'Edit']);
      assert.equal(summary.isSubagent, false);
      assert.equal(summary.title, 'Test response');
      assert.equal(summary.stopReason, 'end_turn');
      assert.equal(summary.toolSources, undefined);
    });

    it('does not fall back to entry.req or entry.res for any field', () => {
      // Entry with req/res that have DIFFERENT values than pre-computed fields
      const entry = {
        id: 'test-002', ts: '14:30:22', sessionId: 'sess-1',
        method: 'POST', url: '/v1/messages',
        elapsed: '1.5', status: 200, isSSE: true,
        usage: null, cost: null, maxContext: 200000,
        cwd: '/test', receivedAt: Date.now(),
        // Pre-computed fields
        model: 'correct-model',
        msgCount: 10,
        toolCount: 5,
        toolCalls: ['Bash'],
        isSubagent: true,
        title: 'correct-title',
        stopReason: 'tool_use',
        thinkingDuration: null,
        duplicateToolCalls: null,
        tokens: null,
        // req/res have different data — should NOT be used
        req: { model: 'wrong-model', messages: [1,2,3], tools: [1] },
        res: [{ type: 'message_delta', delta: { stop_reason: 'wrong_reason' } }],
      };

      const summary = summarizeEntry(entry);

      assert.equal(summary.model, 'correct-model', 'should use pre-computed model, not req.model');
      assert.equal(summary.msgCount, 10, 'should use pre-computed msgCount, not req.messages.length');
      assert.equal(summary.toolCount, 5, 'should use pre-computed toolCount, not req.tools.length');
      assert.equal(summary.stopReason, 'tool_use', 'should use pre-computed stopReason, not res delta');
    });
  });
});
