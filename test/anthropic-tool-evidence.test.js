const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../server/helpers');

describe('#486 Anthropic tool evidence fields', () => {
  // ── hasToolFailLastTurn tri-state ──
  describe('hasToolFailLastTurn tri-state', () => {
    it('returns true when last user message has is_error tool_result', () => {
      const msgs = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'fail' }] },
      ];
      assert.equal(helpers.hasToolFailLastTurn(msgs), true);
    });

    it('returns false when last user message has successful tool_result', () => {
      const msgs = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ];
      assert.equal(helpers.hasToolFailLastTurn(msgs), false);
    });

    it('returns undefined when last user message has no tool_result blocks', () => {
      const msgs = [
        { role: 'user', content: 'just a question' },
      ];
      assert.equal(helpers.hasToolFailLastTurn(msgs), undefined);
    });

    it('returns undefined for null/empty/non-array messages', () => {
      assert.equal(helpers.hasToolFailLastTurn(null), undefined);
      assert.equal(helpers.hasToolFailLastTurn([]), undefined);
      assert.equal(helpers.hasToolFailLastTurn('not an array'), undefined);
    });
  });

  // ── extractAnthropicTurnToolResults ──
  describe('extractAnthropicTurnToolResults', () => {
    it('extracts all tool_result blocks from last user message', () => {
      const msgs = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'Bash', input: {} },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' },
          { type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'command failed' },
        ] },
      ];
      const results = helpers.extractAnthropicTurnToolResults(msgs);
      assert.equal(results.length, 2);
      assert.deepEqual(results[0], { callId: 'tu1', toolFail: false, eligible: true });
      assert.deepEqual(results[1], { callId: 'tu2', toolFail: true, eligible: true });
    });

    it('returns empty array when last user message has no tool_result', () => {
      const msgs = [{ role: 'user', content: 'plain question' }];
      assert.deepEqual(helpers.extractAnthropicTurnToolResults(msgs), []);
    });

    it('returns empty array for null/missing messages', () => {
      assert.deepEqual(helpers.extractAnthropicTurnToolResults(null), []);
      assert.deepEqual(helpers.extractAnthropicTurnToolResults([]), []);
    });

    it('writes ALL tool results, not Bash-only', () => {
      const msgs = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'Edit', input: {} },
          { type: 'tool_use', id: 'tu3', name: 'Bash', input: {} },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tu2', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tu3', content: 'ok' },
        ] },
      ];
      const results = helpers.extractAnthropicTurnToolResults(msgs);
      assert.equal(results.length, 3);
    });
  });

  // ── extractAnthropicToolCallIds ──
  describe('extractAnthropicToolCallIds', () => {
    it('extracts {id → name} from SSE events', () => {
      const events = [
        { type: 'message_start', message: { id: 'msg_01' } },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash' } },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_02', name: 'Read' } },
        { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      ];
      const ids = helpers.extractAnthropicToolCallIds(events);
      assert.deepEqual(ids, { toolu_01: 'Bash', toolu_02: 'Read' });
    });

    it('extracts {id → name} from non-SSE response object', () => {
      const resData = {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} },
          { type: 'tool_use', id: 'toolu_02', name: 'Edit', input: {} },
        ],
      };
      const ids = helpers.extractAnthropicToolCallIds(resData);
      assert.deepEqual(ids, { toolu_01: 'Bash', toolu_02: 'Edit' });
    });

    it('returns empty object for no tool_use blocks', () => {
      const events = [
        { type: 'message_start', message: { id: 'msg_01' } },
        { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      ];
      assert.deepEqual(helpers.extractAnthropicToolCallIds(events), {});
    });

    it('returns empty object for null/missing response', () => {
      assert.deepEqual(helpers.extractAnthropicToolCallIds(null), {});
      assert.deepEqual(helpers.extractAnthropicToolCallIds(undefined), {});
    });
  });

  // ── Pairing guard ──
  it('every emitted callId resolves to a known tool_use.id', () => {
    const events = [
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_A', name: 'Bash' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_B', name: 'Read' } },
    ];
    const callIds = helpers.extractAnthropicToolCallIds(events);
    const msgs = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: events.filter(e => e.content_block?.type === 'tool_use').map(e => e.content_block) },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'toolu_B', is_error: true, content: 'fail' },
      ] },
    ];
    const results = helpers.extractAnthropicTurnToolResults(msgs);
    for (const r of results) {
      assert.ok(r.callId in callIds, `callId ${r.callId} not in turnToolCallIds`);
    }
  });

  // ── INDEX_FIELDS ──
  it('turnToolCallIds and turnToolResults are in INDEX_FIELDS', () => {
    const { INDEX_FIELDS } = require('../server/entry');
    assert.ok(INDEX_FIELDS.includes('turnToolCallIds'));
    assert.ok(INDEX_FIELDS.includes('turnToolResults'));
  });
});
