'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hasClaudeBackgroundFlag } = require('../server/claude-args');

describe('Claude background argument detection', () => {
  const cases = [
    { name: 'background flag before options', args: ['--bg', '--verbose'], expected: true },
    { name: 'background flag after options', args: ['--model', 'sonnet', '--background'], expected: true },
    { name: '-p does not consume a following flag', args: ['-p', '--bg'], expected: true },
    { name: 'system prompt followed by a commander terminator can still bypass', args: ['--system-prompt', '--', '--bg'], expected: true },
    { name: 'short unknown option followed by a terminator can still bypass', args: ['-n', '--', '--background'], expected: true },
    { name: 'initial terminator stops inspection', args: ['--', '--bg'], expected: false },
    { name: 'plain argument then terminator stops inspection', args: ['hello', '--', '--bg'], expected: false },
    { name: 'model value then terminator stops inspection', args: ['--model', 'sonnet', '--', '--bg'], expected: false },
    { name: 'background equals form is not a background flag', args: ['--bg=1'], expected: false },
    { name: 'background text inside another equals form is ignored', args: ['--model=--bg'], expected: false },
    { name: 'combined short option is not a background flag', args: ['-rbg'], expected: false },
    { name: 'model option followed by a flag preserves the bypass direction', args: ['--model', '--bg'], expected: true },
    { name: 'verbose and terminator preserve the bypass direction', args: ['--verbose', '--', '--background'], expected: true },
  ];

  for (const { name, args, expected } of cases) {
    it(name, () => assert.equal(hasClaudeBackgroundFlag(args), expected));
  }
});
