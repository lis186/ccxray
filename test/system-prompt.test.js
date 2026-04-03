'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAgentType,
  splitB2IntoBlocks,
  computeBlockDiff,
  computeUnifiedDiff,
} = require('../server/system-prompt');

describe('system-prompt', () => {
  describe('extractAgentType', () => {
    it('returns unknown for invalid input', () => {
      assert.deepEqual(extractAgentType(null), { key: 'unknown', label: 'Unknown' });
      assert.deepEqual(extractAgentType([]), { key: 'unknown', label: 'Unknown' });
    });

    it('detects Claude Code from b2', () => {
      const sys = [
        { text: 'billing' },
        { text: 'identity' },
        { text: 'You are an interactive agent that helps users' },
      ];
      assert.equal(extractAgentType(sys).key, 'claude-code');
    });

    it('detects Claude Code from b1 fallback', () => {
      const sys = [
        { text: 'billing' },
        { text: 'You are Claude Code, ...' },
        { text: 'Some other text' },
      ];
      assert.equal(extractAgentType(sys).key, 'claude-code');
    });

    it('extracts custom agent type', () => {
      const sys = [
        { text: 'billing' },
        { text: 'identity' },
        { text: 'You are a code reviewer that checks pull requests' },
      ];
      const result = extractAgentType(sys);
      assert.equal(result.key, 'code-reviewer');
      assert.equal(result.label, 'Code Reviewer');
    });
  });

  describe('splitB2IntoBlocks', () => {
    it('returns just coreInstructions for plain text', () => {
      const result = splitB2IntoBlocks('Hello world');
      assert.equal(result.coreInstructions, 'Hello world');
      assert.equal(Object.keys(result).length, 1);
    });

    it('splits on known markers', () => {
      const b2 = 'Core instructions here\n# Environment\nSome env info\n# auto memory\nMemory stuff';
      const result = splitB2IntoBlocks(b2);
      assert.ok(result.coreInstructions.startsWith('Core instructions'));
      assert.ok(result.envAndGit.startsWith('# Environment'));
      assert.ok(result.autoMemory.startsWith('# auto memory'));
    });
  });

  describe('computeUnifiedDiff', () => {
    it('returns empty diff for identical text', () => {
      const diff = computeUnifiedDiff('hello\nworld', 'hello\nworld', 'a', 'b');
      assert.equal(diff, '--- a\n+++ b');
    });

    it('shows additions and removals', () => {
      const diff = computeUnifiedDiff('line1\nline2', 'line1\nline3', 'a', 'b');
      assert.ok(diff.includes('-line2'));
      assert.ok(diff.includes('+line3'));
    });
  });

  describe('computeBlockDiff', () => {
    it('marks identical blocks as same', () => {
      const text = 'Just core instructions';
      const result = computeBlockDiff(text, text);
      const core = result.find(b => b.block === 'coreInstructions');
      assert.equal(core.status, 'same');
      assert.equal(core.delta, 0);
    });

    it('marks changed blocks as changed', () => {
      const result = computeBlockDiff('version A', 'version B');
      const core = result.find(b => b.block === 'coreInstructions');
      assert.equal(core.status, 'changed');
      assert.ok(core.blockDiff.length > 0);
    });

    it('returns all expected blocks', () => {
      const result = computeBlockDiff('', '');
      const blocks = result.map(b => b.block);
      assert.ok(blocks.includes('coreInstructions'));
      assert.ok(blocks.includes('envAndGit'));
      assert.ok(blocks.includes('autoMemory'));
      assert.equal(result.length, 8);
    });
  });
});
