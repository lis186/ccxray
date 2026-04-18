'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAgentType,
  splitB2IntoBlocks,
  computeBlockDiff,
  computeUnifiedDiff,
  _resetUnknownAgentSeen,
} = require('../server/system-prompt');

describe('system-prompt', () => {
  describe('extractAgentType', () => {
    it('returns unknown for invalid input', () => {
      assert.deepEqual(extractAgentType(null), { key: 'unknown', label: 'Unknown' });
      assert.deepEqual(extractAgentType([]), { key: 'unknown', label: 'Unknown' });
    });

    it('detects orchestrator from b2', () => {
      const sys = [
        { text: 'billing' },
        { text: 'identity' },
        { text: 'You are an interactive agent that helps users' },
      ];
      assert.equal(extractAgentType(sys).key, 'orchestrator');
    });

    it('uses b1 identity only when b2 is empty', () => {
      // B1 is branding shared by every sub-agent — only trust it as identity
      // when B2 has no content (short-form prompt variant).
      const shortForm = [
        { text: 'billing' },
        { text: 'You are Claude Code, ...' },
        { text: '' },
      ];
      assert.equal(extractAgentType(shortForm).key, 'orchestrator');

      const sdkShortForm = [
        { text: 'billing' },
        { text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        { text: '' },
      ];
      assert.equal(extractAgentType(sdkShortForm).key, 'sdk-agent');

      // When B2 has content, the sub-agent must NOT fall back to claude-code
      // just because B1 says "You are Claude Code…" — that branding is shared.
      const subAgent = [
        { text: 'billing' },
        { text: 'You are Claude Code, ...' },
        { text: 'Some other text' },
      ];
      assert.notEqual(extractAgentType(subAgent).key, 'orchestrator');
    });

    it('detects general-purpose subagent', () => {
      const sys = [
        { text: 'billing' },
        { text: 'You are Claude Code' },
        { text: 'You are an agent for Claude Code, Anthropic\'s official CLI for Claude. Given the user\'s message...' },
      ];
      assert.equal(extractAgentType(sys).key, 'general-purpose');
      assert.equal(extractAgentType(sys).label, 'General Purpose');
    });

    it('detects explore subagent', () => {
      const sys = [
        { text: 'billing' },
        { text: 'You are Claude Code' },
        { text: 'You are a file search specialist for Claude Code...' },
      ];
      assert.equal(extractAgentType(sys).key, 'explore');
    });

    it('detects web-search subagent', () => {
      const sys = [
        { text: 'billing' },
        { text: 'You are Claude Code' },
        { text: 'You are an assistant for performing a web search tool use' },
      ];
      assert.equal(extractAgentType(sys).key, 'web-search');
    });

    it('detects name-generator', () => {
      const sys = [
        { text: 'billing' },
        { text: 'You are Claude Code' },
        { text: 'Generate a short kebab-case name (2-4 words) that captures...' },
      ];
      assert.equal(extractAgentType(sys).key, 'name-generator');
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

    it('warns once per unique unknown agent (dedup)', () => {
      _resetUnknownAgentSeen();
      const originalWarn = console.warn;
      const warnings = [];
      console.warn = (msg) => warnings.push(msg);
      try {
        const sysA = [{ text: 'billing' }, { text: 'identity' },
          { text: 'You are a database migration expert that handles schema changes' }];
        const sysB = [{ text: 'billing' }, { text: 'identity' },
          { text: 'You are a security auditor that reviews code for vulnerabilities' }];

        extractAgentType(sysA);
        extractAgentType(sysA);              // same B2 — dedup
        extractAgentType(sysB);              // different B2 — new warn
        extractAgentType(sysB);              // dedup

        // Known agents should never warn
        extractAgentType([{ text: 'b' }, { text: 'i' },
          { text: 'You are an interactive agent' }]);

        assert.equal(warnings.length, 2, `expected 2 warnings, got ${warnings.length}`);
        assert.match(warnings[0], /database-migration-expert/);
        assert.match(warnings[1], /security-auditor/);
      } finally {
        console.warn = originalWarn;
        _resetUnknownAgentSeen();
      }
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
