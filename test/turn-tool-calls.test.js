'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('#427 turnToolCalls: response-side extraction', () => {
  const { extractTurnToolCalls } = require('../server/wire-parsers/anthropic');

  describe('SSE events (array of events)', () => {
    it('counts tool_use content_block_start events', () => {
      const events = [
        { type: 'message_start', message: { id: 'msg_01', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash' } },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_2', name: 'Read' } },
        { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu_3', name: 'Bash' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      ];
      const result = extractTurnToolCalls(events);
      assert.deepEqual(result, { Bash: 2, Read: 1 });
    });

    it('returns empty object (not null) when no tool_use blocks — distinguishes from legacy', () => {
      const events = [
        { type: 'message_start', message: { id: 'msg_01', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ];
      assert.deepEqual(extractTurnToolCalls(events), {});
    });

    it('returns null for null/undefined input (legacy/missing)', () => {
      assert.equal(extractTurnToolCalls(null), null);
      assert.equal(extractTurnToolCalls(undefined), null);
    });
  });

  describe('non-SSE response (object with content[])', () => {
    it('counts tool_use content blocks', () => {
      const res = {
        id: 'msg_01',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'tu_1', name: 'Edit', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'Edit', input: {} },
          { type: 'tool_use', id: 'tu_3', name: 'Write', input: {} },
        ],
      };
      assert.deepEqual(extractTurnToolCalls(res), { Edit: 2, Write: 1 });
    });

    it('returns empty object when no tool_use in content', () => {
      const res = { id: 'msg_01', content: [{ type: 'text', text: 'done' }] };
      assert.deepEqual(extractTurnToolCalls(res), {});
    });
  });

  describe('INDEX_FIELDS includes turnToolCalls', () => {
    it('turnToolCalls is in the index field list', () => {
      const { INDEX_FIELDS } = require('../server/entry');
      assert.ok(INDEX_FIELDS.includes('turnToolCalls'));
    });

    it('buildIndexLine includes turnToolCalls when present', () => {
      const { buildIndexLine } = require('../server/entry');
      const entry = { id: 'test', turnToolCalls: { Bash: 3, Read: 1 } };
      const line = JSON.parse(buildIndexLine(entry));
      assert.deepEqual(line.turnToolCalls, { Bash: 3, Read: 1 });
    });

    it('buildIndexLine omits turnToolCalls when undefined', () => {
      const { buildIndexLine } = require('../server/entry');
      const entry = { id: 'test', toolCalls: { Bash: 10 } };
      const line = JSON.parse(buildIndexLine(entry));
      assert.equal(line.turnToolCalls, undefined);
    });
  });
});
