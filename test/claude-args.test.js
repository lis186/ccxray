'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hasClaudeBackgroundFlag } = require('../server/claude-args');

describe('Claude background argument detection', () => {
  const cases = [
    { name: 'background flag before options', args: ['--bg', '--verbose'], expected: true },
    { name: 'background flag after options', args: ['--model', 'sonnet', '--background'], expected: true },
    { name: 'required value may look like a flag', args: ['-p', '--bg'], expected: false },
    { name: 'required value followed by background flag', args: ['-p', 'prompt', '--bg'], expected: true },
    { name: 'optional resume value is consumed when plain', args: ['--resume', 'session-1', '--bg'], expected: true },
    { name: 'bare optional resume does not consume the next flag', args: ['--resume', '--bg'], expected: true },
    { name: 'short optional resume does not consume the next flag', args: ['-r', '--background'], expected: true },
    { name: 'required equals form consumes inline background text', args: ['--model=--bg'], expected: false },
    { name: 'optional equals form consumes inline background text', args: ['--resume=--bg'], expected: false },
    { name: 'equals form can precede an actual background flag', args: ['--model=sonnet', '--bg'], expected: true },
    { name: 'terminator disables launcher flag inspection', args: ['--', '--bg'], expected: false },
    { name: 'terminator after regular options disables inspection', args: ['--verbose', '--', '--background'], expected: false },
    { name: 'unknown option value is not interpreted as background flag', args: ['--unknown=--bg'], expected: false },
  ];

  for (const { name, args, expected } of cases) {
    it(name, () => assert.equal(hasClaudeBackgroundFlag(args), expected));
  }
});
