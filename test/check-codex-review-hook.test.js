'use strict';

// .claude/hooks/check-codex-review.sh — PreToolUse gate on `gh pr merge`.
// Hermetic: `gh` is a PATH stub (never hits the network); no CCXRAY_HOME involved.
// The cross-repo defect this pins down: without forwarding -R/--repo, the hook
// validated the cwd repo's same-numbered PR — a colliding number whose body
// happens to contain "codex review" silently passed an unreviewed foreign PR
// (ops docs/solutions/gate-script-vs-runbook-contradictions.md item 3).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'check-codex-review.sh');

let stubDir;

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stub-'));
  // Stub gh: `pr view` prints GH_BODY_CROSS when called with --repo, else
  // GH_BODY_LOCAL, and appends its argv to GH_SPY for forwarding assertions.
  const stub = [
    '#!/bin/bash',
    'if [ -n "$GH_SPY" ]; then echo "$@" >> "$GH_SPY"; fi',
    'case "$*" in',
    '  *--repo*) printf "%s" "$GH_BODY_CROSS" ;;',
    '  *)        printf "%s" "$GH_BODY_LOCAL" ;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(stubDir, 'gh'), stub, { mode: 0o755 });
});

after(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

function runHook(command, env = {}) {
  const spy = path.join(stubDir, `spy-${Math.random().toString(36).slice(2)}.txt`);
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_SPY: spy,
      GH_BODY_LOCAL: '',
      GH_BODY_CROSS: '',
      ...env,
    },
  });
  r.spy = fs.existsSync(spy) ? fs.readFileSync(spy, 'utf8') : '';
  return r;
}

describe('check-codex-review hook — cross-repo scope', () => {
  it('forwards --repo to gh pr view and allows when the TARGET repo PR has evidence', () => {
    const r = runHook('gh pr merge 11 --repo lis186/ccxray-ops --squash', {
      GH_BODY_CROSS: 'summary\n\ncodex review: pass, 0 findings',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.spy, /--repo lis186\/ccxray-ops/);
  });

  it('DANGER direction: cwd repo same-numbered PR has evidence, target repo PR does not → block', () => {
    // Old code read the cwd repo body (no --repo) and would silently pass.
    const r = runHook('gh pr merge 11 --repo lis186/ccxray-ops', {
      GH_BODY_LOCAL: 'unrelated old PR that mentions codex review',
      GH_BODY_CROSS: 'no second review here',
    });
    assert.equal(r.status, 2, 'must not validate against the cwd repo PR');
    assert.match(r.stdout, /missing codex review evidence/);
  });

  it('-R short flag is honored the same as --repo', () => {
    const r = runHook('gh pr merge 7 -R lis186/ccxray-ops', {
      GH_BODY_CROSS: 'codex gate clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.spy, /--repo lis186\/ccxray-ops/);
  });

  it('--repo=owner/repo (equals form) is honored', () => {
    const r = runHook('gh pr merge 7 --repo=lis186/ccxray-ops', {
      GH_BODY_CROSS: 'codex gate clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.spy, /--repo lis186\/ccxray-ops/);
  });

  it('same-repo merge is unchanged: no --repo forwarded, local body decides', () => {
    const r = runHook('gh pr merge 42 --squash', {
      GH_BODY_LOCAL: 'codex review: clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.spy, /--repo/);
  });

  it('same-repo merge without evidence still blocks', () => {
    const r = runHook('gh pr merge 42 --squash', { GH_BODY_LOCAL: 'no review here' });
    assert.equal(r.status, 2);
  });

  it('fail-closed: -R/--repo present but unparseable → block, never guess the cwd repo', () => {
    const r = runHook('gh pr merge 11 --repo', {
      GH_BODY_LOCAL: 'codex review present locally',
    });
    assert.equal(r.status, 2, 'unparseable --repo must fail closed');
    assert.match(r.stdout, /could not parse the target repo/);
  });

  it('PR number after flags (merge --repo X 12) is still gated — not silently allowed', () => {
    // Old code required the number immediately after `merge`; this form slipped
    // through the "no PR number → allow" path with zero body check.
    const r = runHook('gh pr merge --repo lis186/ccxray-ops 12', {
      GH_BODY_CROSS: 'no evidence',
    });
    assert.equal(r.status, 2, 'flags-first form must still be gated');
    assert.match(r.stdout, /PR #12 /);
  });

  it('repo name digits (lis186) are never mistaken for the PR number', () => {
    const r = runHook('gh pr merge --repo lis186/ccxray-ops 12', {
      GH_BODY_CROSS: 'codex gate clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.spy, /pr view 12 /);
  });

  it('compound command: a later gh call\'s --repo must NOT leak into the merge check', () => {
    // codex review finding (2026-08-06): scanning the whole shell command let
    // `gh pr merge 11 && gh pr view 12 --repo foreign/repo` validate foreign#11
    // while actually merging cwd#11.
    const r = runHook('gh pr merge 11 && gh pr view 12 --repo foreign/repo', {
      GH_BODY_LOCAL: 'codex review: clean',
      GH_BODY_CROSS: 'also has codex review words',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.spy, /--repo/, 'merge check must use the cwd repo');
    assert.match(r.spy, /pr view 11 /);
  });

  it('compound command: local body without evidence blocks even if a later --repo body has it', () => {
    const r = runHook('gh pr merge 11 && gh pr view 12 --repo foreign/repo', {
      GH_BODY_LOCAL: 'no evidence',
      GH_BODY_CROSS: 'codex gate clean',
    });
    assert.equal(r.status, 2);
  });

  it('compound command: --repo on the merge segment itself is still forwarded', () => {
    const r = runHook('git push && gh pr merge 11 --repo lis186/ccxray-ops --squash && echo done', {
      GH_BODY_CROSS: 'codex gate clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.spy, /--repo lis186\/ccxray-ops/);
  });

  it('non-merge command is ignored (exit 0, gh never called)', () => {
    const r = runHook('gh pr view 11 --repo lis186/ccxray-ops');
    assert.equal(r.status, 0);
    assert.equal(r.spy, '');
  });
});
