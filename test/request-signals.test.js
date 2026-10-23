'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { hasConflictingAuthValues, isAnthropicSide, isOpenAISide } = require('../server/request-signals');

it('routing fix: Anthropic and OpenAI-shaped values together', () => {
  const anthropic = 'sk-ant-dummy-000';
  const openai = 'sk-proj-dummy-000';
  const jwt = 'aaaaaaaaaaaa.bbbb.cccc';
  const cases = [
    [{ authorization: 'Bearer gw-dummy-000', 'x-api-key': anthropic }, false],
    [{ authorization: `Bearer ${anthropic}`, 'x-api-key': 'gw-dummy-000' }, false],
    [{ authorization: `Bearer ${jwt}`, 'x-api-key': anthropic }, true],
    [{ authorization: `Bearer ${anthropic}`, 'x-api-key': jwt }, true],
    [{ authorization: `Bearer ${anthropic}`, 'x-api-key': openai }, true],
    [{ authorization: 'Basic gw-dummy-000', 'x-api-key': anthropic }, false],
    [{ authorization: `Basic ${jwt}`, 'x-api-key': anthropic }, false],
    [{ authorization: `Bearer ${jwt}`, 'x-api-key': '' }, false],
    [{ authorization: 'sk-ant-dummy-000, sk-dummy-000' }, true],
    [{ authorization: 'Bearer xai-dummy-000', 'x-api-key': anthropic }, false],
    [{ authorization: `Bearer ${anthropic}`, 'x-api-key': anthropic }, false],
    [{}, false],
  ];
  for (const [headers, expected] of cases) {
    assert.equal(hasConflictingAuthValues(headers), expected, JSON.stringify(headers));
  }
  for (const gap of [' ', '\t', '   ']) {
    for (const values of [
      [`Bearer ${openai}`, `Bearer${gap}${anthropic}`],
      [`Bearer${gap}${anthropic}`, `Bearer ${openai}`],
      [`Bearer ${jwt}`, `Bearer${gap}${anthropic}`],
    ]) checkValues('authorization', values, true);
  }
  for (const values of [
    ['Bearer gw-dummy-000', 'Bearer xai-dummy-000'],
    [`Bearer ${openai}`, 'Bearer gw-dummy-000'],
    [`Bearer ${anthropic}`, 'Bearer gw-dummy-000'],
    [`Bearer ${anthropic}`, `Bearer ${anthropic}`],
    ['', 'Bearer gw-dummy-000', ''],
  ]) checkValues('authorization', values, false);
});

function checkValues(name, values, expected) {
  const label = `${name}: ${values.join(', ')}`;
  assert.equal(hasConflictingAuthValues({ [name]: values[0] }, {
    rawHeaders: values.flatMap(value => [name, value]),
  }), expected, label);
  assert.equal(hasConflictingAuthValues({}, { headersDistinct: { [name]: values } }), expected, label);
  assert.equal(hasConflictingAuthValues({ [name]: values.join(', ') }), expected, label);
  assert.equal(hasConflictingAuthValues({ [name]: values }), expected, label);
}

it('routing fix: distinct x-api-key values', () => {
  for (const values of [
    ['xai-dummy-000', 'sk-proj-dummy-000'],
    ['gw-dummy-000', 'xai-dummy-000'],
    ['sk-ant-dummy-000', 'sk-proj-dummy-000'],
    ['sk-ant-dummy-000', 'sk-ant-dummy-001'],
  ]) {
    checkValues('x-api-key', values, true);
    checkValues('x-api-key', [...values].reverse(), true);
  }
  for (const value of ['sk-ant-dummy-000', 'xai-dummy-000', 'gw-dummy-000', 'k']) {
    checkValues('x-api-key', [value, value], false);
    checkValues('x-api-key', ['', ` ${value} `, value, ''], false);
  }
});

it('routing fix: multiple Authorization values follow provider signals', () => {
  for (const values of [
    ['Bearer sk-proj-dummy-000', 'Bearer gw-dummy-000'],
    ['Bearer gw-dummy-000', 'Bearer sk-proj-dummy-000'],
  ]) {
    const headers = { authorization: values[0] };
    const req = { rawHeaders: values.flatMap(value => ['Authorization', value]) };
    assert.equal(hasConflictingAuthValues(headers, req), false);
    assert.equal(isAnthropicSide(headers, req), false);
    assert.equal(isOpenAISide(headers, req), true);
  }
  for (const values of [
    ['Bearer sk-ant-dummy-000', 'Bearer gw-dummy-000'],
    ['Bearer gw-dummy-000', 'Bearer sk-ant-dummy-000'],
  ]) {
    const headers = { authorization: values[0] };
    const req = { rawHeaders: values.flatMap(value => ['Authorization', value]) };
    assert.equal(hasConflictingAuthValues(headers, req), false);
    assert.equal(isAnthropicSide(headers, req), true);
    assert.equal(isOpenAISide(headers, req), false);
  }
});
