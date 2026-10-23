'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { hasConflictingAuthValues } = require('../server/request-signals');

it('routing fix: multiple Authorization values', () => {
  for (const gap of [' ', '\t', '   ']) {
    const anthropic = `Bearer${gap}sk-ant-dummy-000`;
    const other = 'Bearer sk-proj-dummy-000';
    for (const values of [[other, anthropic], [anthropic, other]]) {
      const headers = { authorization: values[0] };
      assert.equal(hasConflictingAuthValues(headers, { rawHeaders: values.flatMap(value => ['Authorization', value]) }), true);
      assert.equal(hasConflictingAuthValues(headers, { headersDistinct: { authorization: values } }), true);
      assert.equal(hasConflictingAuthValues({ authorization: values.join(', ') }), true);
      assert.equal(hasConflictingAuthValues({ authorization: values }), true);
    }
  }
  assert.equal(hasConflictingAuthValues({ authorization: 'Bearer sk-proj-dummy-000, Bearer dummy-other' }), true);
});

it('routing fix: follow-up to #747', () => {
  const anthropic = 'sk-ant-dummy-000';
  for (const other of ['sk-proj-dummy-000', 'dummy-other']) {
    for (const values of [[other, anthropic], [anthropic, other]]) {
      assert.equal(hasConflictingAuthValues({}, { rawHeaders: values.flatMap(value => ['X-Api-Key', value]) }), true);
      assert.equal(hasConflictingAuthValues({}, { headersDistinct: { 'x-api-key': values } }), true);
      assert.equal(hasConflictingAuthValues({ 'x-api-key': values.join(', ') }), true);
    }
  }
  for (const value of ['Bearer sk-proj-dummy-000', 'Bearer dummy.payload.signature', 'Bearer dummy-other', 'Basic dummy']) {
    assert.equal(hasConflictingAuthValues({ authorization: value, 'x-api-key': anthropic }), true);
  }
  assert.equal(hasConflictingAuthValues({ authorization: `Bearer ${anthropic}`, 'x-api-key': 'dummy-other' }), true);
  assert.equal(hasConflictingAuthValues({ 'x-api-key': [anthropic, 'sk-ant-dummy-001'] }), true);
  for (const headers of [
    {}, { authorization: `Bearer ${anthropic}` }, { 'x-api-key': anthropic },
    { authorization: 'Bearer sk-proj-dummy-000' }, { authorization: 'Bearer xai-dummy-000' },
    { authorization: 'Bearer dummy.payload.signature' },
    { authorization: `Bearer ${anthropic}`, 'x-api-key': anthropic },
    { 'x-api-key': ['xai-dummy-000', 'xai-dummy-000'] },
    { 'x-api-key': [anthropic, anthropic] },
  ]) assert.equal(hasConflictingAuthValues(headers), false);
  assert.equal(hasConflictingAuthValues({}, {
    rawHeaders: ['X-Api-Key', 'xai-dummy-000', 'X-Api-Key', 'xai-dummy-000'],
  }), false);
});
