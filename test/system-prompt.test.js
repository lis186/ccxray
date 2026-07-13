'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAgentType,
  extractPromptAgentType,
  splitB2IntoBlocks,
  normalizePlatform,
  computeCoreHash,
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

    it('warns once per unique unknown agent (dedup) when CCXRAY_DEBUG_CLASSIFY=1', () => {
      _resetUnknownAgentSeen();
      const originalWarn = console.warn;
      const originalFlag = process.env.CCXRAY_DEBUG_CLASSIFY;
      process.env.CCXRAY_DEBUG_CLASSIFY = '1';
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
        if (originalFlag === undefined) delete process.env.CCXRAY_DEBUG_CLASSIFY;
        else process.env.CCXRAY_DEBUG_CLASSIFY = originalFlag;
        _resetUnknownAgentSeen();
      }
    });

    it('does NOT warn when CCXRAY_DEBUG_CLASSIFY is unset (default off, avoids leaking into agent terminals)', () => {
      _resetUnknownAgentSeen();
      const originalWarn = console.warn;
      const originalFlag = process.env.CCXRAY_DEBUG_CLASSIFY;
      delete process.env.CCXRAY_DEBUG_CLASSIFY;
      const warnings = [];
      console.warn = (msg) => warnings.push(msg);
      try {
        const sys = [{ text: 'billing' }, { text: 'identity' },
          { text: 'You are a database migration expert that handles schema changes' }];
        extractAgentType(sys);
        assert.equal(warnings.length, 0, `expected 0 warnings when flag unset, got ${warnings.length}`);
      } finally {
        console.warn = originalWarn;
        if (originalFlag === undefined) delete process.env.CCXRAY_DEBUG_CLASSIFY;
        else process.env.CCXRAY_DEBUG_CLASSIFY = originalFlag;
        _resetUnknownAgentSeen();
      }
    });
  });

  describe('extractPromptAgentType', () => {
    it('classifies OpenAI Responses prompts as Codex without using Claude buckets', () => {
      const result = extractPromptAgentType('openai', {
        instructions: 'You are Codex.',
        input: 'hello',
        tools: [{ type: 'function', name: 'shell' }],
      });
      assert.deepEqual(result, { key: 'default', label: 'Codex Default' });
    });

    it('classifies Codex native subagent types from metadata', () => {
      assert.deepEqual(
        extractPromptAgentType('openai', { metadata: { agent_type: 'explorer' }, instructions: 'inspect' }),
        { key: 'explorer', label: 'Codex Explorer' }
      );
      assert.deepEqual(
        extractPromptAgentType('openai', { metadata: { agent_type: 'worker' }, instructions: 'edit' }),
        { key: 'worker', label: 'Codex Worker' }
      );
    });

    it('returns unknown for empty OpenAI payloads', () => {
      assert.deepEqual(extractPromptAgentType('openai', {}), { key: 'unknown', label: 'Unknown' });
    });

    it('preserves Claude-specific classification for Anthropic payloads', () => {
      const result = extractPromptAgentType('anthropic', {
        system: [
          { text: 'billing' },
          { text: 'identity' },
          { text: 'You are an interactive agent that helps users' },
        ],
      });
      assert.equal(result.key, 'orchestrator');
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

  // #219 — platform-variant prompts must not create false version splits.
  describe('normalizePlatform', () => {
    it('replaces shell names with a stable placeholder', () => {
      assert.equal(normalizePlatform('Prefer dedicated tools over Bash when one fits'),
        'Prefer dedicated tools over {{SHELL}} when one fits');
      assert.equal(normalizePlatform('Prefer dedicated tools over PowerShell when one fits'),
        'Prefer dedicated tools over {{SHELL}} when one fits');
      assert.equal(normalizePlatform('run via cmd.exe here'), 'run via {{SHELL}} here');
    });

    it('replaces os identifiers with a stable placeholder', () => {
      for (const os of ['darwin', 'win32', 'linux']) {
        assert.equal(normalizePlatform(`platform is ${os} today`), 'platform is {{PLATFORM}} today');
      }
    });

    it('replaces windows and unix home paths with a stable placeholder', () => {
      assert.equal(normalizePlatform('cwd C:\\Users\\alice\\proj'), 'cwd {{PATH}}');
      assert.equal(normalizePlatform('cwd /Users/alice'), 'cwd {{PATH}}');
      assert.equal(normalizePlatform('cwd /home/alice'), 'cwd {{PATH}}');
    });

    it('consumes the full unix path, not just the home prefix (symmetric with Windows)', () => {
      // deep $HOME paths (skill/plugin content leaked into coreInstructions) — the
      // forward-slash tail must collapse too, else it survives on unix but not Windows
      // and re-splits one version across platforms (#219 residual).
      assert.equal(normalizePlatform('see /Users/alice/src/tries/skill/data/runs here'), 'see {{PATH}} here');
      assert.equal(normalizePlatform('cache at /home/bob/.claude/plugins/cache/x done'), 'cache at {{PATH}} done');
    });

    it('leaves platform-neutral text untouched', () => {
      const t = 'You are an interactive agent that helps users with tasks.';
      assert.equal(normalizePlatform(t), t);
    });

    it('handles null/undefined input', () => {
      assert.equal(normalizePlatform(null), '');
      assert.equal(normalizePlatform(undefined), '');
    });
  });

  describe('computeCoreHash', () => {
    it('yields the same hash for macOS/Windows variants of one prompt version', () => {
      const mac = 'You are Claude Code.\nPrefer dedicated tools over Bash when one fits.\nPlatform: darwin';
      const win = 'You are Claude Code.\nPrefer dedicated tools over PowerShell when one fits.\nPlatform: win32';
      assert.equal(computeCoreHash(mac), computeCoreHash(win));
    });

    it('still differs when the actual instructions change', () => {
      const v1 = 'You are Claude Code.\nPrefer dedicated tools over Bash when one fits.';
      const v2 = 'You are Claude Code.\nAlways prefer dedicated tools; never shell out.';
      assert.notEqual(computeCoreHash(v1), computeCoreHash(v2));
    });

    it('collapses deep $HOME paths (skill/plugin) across platforms', () => {
      const mac = 'Skill data lives at /Users/alice/src/tries/skill/data/runs and loads on demand.';
      const win = 'Skill data lives at C:\\Users\\alice\\src\\tries\\skill\\data\\runs and loads on demand.';
      assert.equal(computeCoreHash(mac), computeCoreHash(win));
    });

    it('does not over-normalize: identical paths but different prose still differ', () => {
      // guard against a too-greedy normalize washing out real content: same path span,
      // different instruction sentence → must remain distinct versions.
      const a = 'Base at /Users/alice/proj.\nAlways run tests before committing.';
      const b = 'Base at /Users/alice/proj.\nNever run tests; ship immediately.';
      assert.notEqual(computeCoreHash(a), computeCoreHash(b));
    });

    it('returns a 12-char hex prefix', () => {
      assert.match(computeCoreHash('anything'), /^[0-9a-f]{12}$/);
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
