'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('#438 turnToolFail: per-turn failure from last user message', () => {
  const { hasToolFailLastTurn } = require('../server/helpers');

  it('detects is_error in the last user message', () => {
    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'fail' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'success' }] },
    ];
    assert.equal(hasToolFailLastTurn(messages), false, 'last user message has no error');
  });

  it('returns true when last user message has is_error', () => {
    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'success' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'fail' }] },
    ];
    assert.equal(hasToolFailLastTurn(messages), true);
  });

  it('is NOT infected by earlier failures (the #427-class bug)', () => {
    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'early fail' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'recovered' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'success' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'also success' }] },
    ];
    // Old hasToolFail would return true (scans all messages). New per-turn returns false.
    assert.equal(hasToolFailLastTurn(messages), false);
  });

  it('returns false for empty/missing messages', () => {
    assert.equal(hasToolFailLastTurn(null), false);
    assert.equal(hasToolFailLastTurn([]), false);
  });

  it('turnToolFail is in INDEX_FIELDS', () => {
    const { INDEX_FIELDS } = require('../server/entry');
    assert.ok(INDEX_FIELDS.includes('turnToolFail'));
  });
});
