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

  it('attached short form -Rowner/repo is honored (codex R2)', () => {
    const r = runHook('gh pr merge 7 -Rlis186/ccxray-ops', {
      GH_BODY_CROSS: 'codex gate clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.spy, /--repo lis186\/ccxray-ops/);
  });

  it('quoted argument inside the merge invocation → fail closed (codex R2)', () => {
    // A quote defeats the separator cut (`--body 'note; ready'`), so the hook
    // must refuse to guess rather than mis-parse and validate the wrong repo.
    const r = runHook("gh pr merge 11 --body 'note; ready' --repo owner/foreign", {
      GH_BODY_LOCAL: 'codex review',
      GH_BODY_CROSS: 'codex review',
    });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /cannot be parsed safely/);
  });

  it("quoted 'gh pr merge' string shadowing a real merge → fail closed, never silently allowed (codex R2)", () => {
    // Old parsing anchored on the FIRST textual occurrence, found no number in
    // the echo argument, and exited 0 without checking the real merge.
    const r = runHook("echo 'gh pr merge' && gh pr merge 11", {
      GH_BODY_LOCAL: 'no evidence',
    });
    assert.equal(r.status, 2, 'must not silently allow the real merge');
  });

  it('two merges in one line: both are gated (loop covers every occurrence)', () => {
    const r = runHook('gh pr merge 11 --squash && gh pr merge 12 --squash', {
      GH_BODY_LOCAL: 'codex review: clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.spy, /pr view 11 /);
    assert.match(r.spy, /pr view 12 /);
  });

  it('backslash-escaped separator in merge args → fail closed (codex R3)', () => {
    // `--subject note\;ready` is ONE command targeting the foreign repo, but a
    // naive separator cut stops at the escaped semicolon and would validate the
    // cwd repo's PR instead.
    const r = runHook('gh pr merge 11 --subject note\\;ready --repo owner/foreign', {
      GH_BODY_LOCAL: 'codex review',
      GH_BODY_CROSS: 'codex review',
    });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /cannot be parsed safely/);
  });

  it('dynamic PR number ($VAR) → fail closed, the gate cannot verify what it cannot resolve', () => {
    const r = runHook('gh pr merge $PR_NUM --squash', {
      GH_BODY_LOCAL: 'codex review',
    });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /cannot be parsed safely/);
  });

  it('pull URL selector: repo and number are taken from the URL (codex R4)', () => {
    const r = runHook('gh pr merge https://github.com/lis186/ccxray-ops/pull/34 --squash', {
      GH_BODY_CROSS: 'codex gate clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.spy, /pr view 34 --repo lis186\/ccxray-ops/);
  });

  it('pull URL selector without evidence blocks (previously slipped the allow path)', () => {
    const r = runHook('gh pr merge https://github.com/lis186/ccxray-ops/pull/34', {
      GH_BODY_CROSS: 'nothing here',
    });
    assert.equal(r.status, 2);
  });

  it('branch selector cannot be verified → fail closed (codex R4)', () => {
    const r = runHook('gh pr merge feature-branch --squash', {
      GH_BODY_LOCAL: 'codex review',
    });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /unrecognized argument: feature-branch/);
  });

  it('bare merge (current-branch PR) is no longer an ungated bypass (codex R4)', () => {
    const r = runHook('gh pr merge --squash', { GH_BODY_LOCAL: 'codex review' });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /explicit PR number/);
  });

  it('merge reached via || is still gated (codex R4)', () => {
    const r = runHook('false || gh pr merge 11 --squash', { GH_BODY_LOCAL: 'no evidence' });
    assert.equal(r.status, 2);
  });

  it('shell comment cannot smuggle --repo into the invocation (codex R4)', () => {
    const r = runHook('gh pr merge 11 --squash # --repo foreign/repo', {
      GH_BODY_LOCAL: 'codex review: clean',
      GH_BODY_CROSS: 'also codex review',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.spy, /--repo/);
  });

  it('newline-separated follow-up command does not leak into the merge segment (codex R4)', () => {
    const r = runHook('gh pr merge 11 --squash\ngh pr view 12 --repo foreign/repo', {
      GH_BODY_LOCAL: 'codex review: clean',
      GH_BODY_CROSS: 'also codex review',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.spy, /--repo/);
    assert.match(r.spy, /pr view 11 /);
  });

  it('value-taking flags outside the allowlist (--subject) → fail closed', () => {
    // Removes the old numeric-flag-value misread entirely: the grammar simply
    // rejects flags the gate cannot account for.
    const r = runHook('gh pr merge --subject 11 12', { GH_BODY_LOCAL: 'codex review' });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /unrecognized argument: --subject/);
  });

  it('prose mention in a commit message does not trip the gate (command-start preceder)', () => {
    const r = runHook('git commit -m "docs: the gh pr merge <number> flow is gated" && git push', {
      GH_BODY_LOCAL: '',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.spy, '', 'gh must never be called for a prose mention');
  });

  it('env-assignment prefix (GH_TOKEN=x gh pr merge) is still gated (codex R5)', () => {
    const r = runHook('GH_TOKEN=abc gh pr merge 11 --squash', { GH_BODY_LOCAL: 'no evidence' });
    assert.equal(r.status, 2);
  });

  it('brace group and accidental double space are still gated (codex R5)', () => {
    const r1 = runHook('{ gh pr merge 11; }', { GH_BODY_LOCAL: 'no evidence' });
    assert.equal(r1.status, 2);
    const r2 = runHook('gh  pr merge 11 --squash', { GH_BODY_LOCAL: 'no evidence' });
    assert.equal(r2.status, 2);
  });

  it('11#feature is a branch selector, not a comment → fail closed (codex R5)', () => {
    const r = runHook('gh pr merge 11#feature --squash', { GH_BODY_LOCAL: 'codex review' });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /unrecognized argument: 11#feature/);
  });

  it('trailing full-word comment is still stripped (codex R4 behavior kept)', () => {
    const r = runHook('gh pr merge 11 --squash # merged after review', {
      GH_BODY_LOCAL: 'codex review: clean',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it('quoted prose that itself contains an env-prefixed merge is skipped (quote parity)', () => {
    const r = runHook(
      'git commit -m "fix: gate GH_TOKEN=x gh pr merge 11 shapes" && git push',
      { GH_BODY_LOCAL: '' }
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.spy, '', 'gh must never be called for quoted prose');
  });

  it('non-merge command is ignored (exit 0, gh never called)', () => {
    const r = runHook('gh pr view 11 --repo lis186/ccxray-ops');
    assert.equal(r.status, 0);
    assert.equal(r.spy, '');
  });
});
