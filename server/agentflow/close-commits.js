'use strict';

// Close-commit cross-check (docs/agentflow-integration.md, Ask windows, End).
// `agf close` commits with an `Agentflow-Close-Id: <64 hex>` trailer. A round's
// matching close commit touches the notebook and its tree contains the round's
// Reply; its committer time only cross-checks the Reply stamp, which stays the
// window end. Git is read, never written.

const path = require('path');
const { execFileSync } = require('child_process');

const CLOSE_ID = /^[0-9a-f]{64}$/u;
const TOLERANCE_MS = 60 * 1000;

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

// Close commits touching `notebook`, oldest first: { sha, at }. Content is read
// per commit by the caller, so no more than one notebook version is held.
// Outside a Git checkout, or with none, the list is empty.
function closeCommits(root, notebook) {
  const rel = path.relative(root, notebook).split(path.sep).join('/');
  let log;
  try {
    // --no-show-signature: a user `log.showSignature` would prefix each record
    // with signature text and break the field parse.
    log = git(root, ['log', '--no-show-signature', '--reverse', '--format=%H%x1f%ct%x1f%(trailers:key=Agentflow-Close-Id,valueonly,separator=%x1f)%x1e', '--', rel]);
  } catch { return []; }
  const out = [];
  for (const rec of log.split('\x1e')) {
    const [sha, ct, ...ids] = rec.trim().split('\x1f');
    if (!sha || !ids.some(id => CLOSE_ID.test(id.trim()))) continue;
    out.push({ sha, at: Number(ct) * 1000, rel });
  }
  return out;
}

function closeCommitContent(root, c) {
  try { return git(root, ['show', `${c.sha}:./${c.rel}`]); } catch { return null; }
}

// A Reply is identified by its heading line and its stamp line (the first two
// non-blank lines), so text the owner appends after the close commit does not
// hide the round. The whole Reply text is the fallback match.
function replyMatcher(replyText) {
  const full = replyText.trim();
  const lines = replyText.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  const [heading, stamp] = lines;
  return content => {
    if (heading && stamp) {
      const cl = content.split('\n').map(l => l.trimEnd());
      for (let i = 0; i < cl.length; i++) {
        if (cl[i] !== heading) continue;
        let j = i + 1;
        while (j < cl.length && !cl[j].trim()) j++;
        if (cl[j] === stamp) return true;
      }
    }
    return content.includes(full);
  };
}

// Ask ids whose matching close commit's committer time differs from the Reply
// stamp by more than a minute. The matching commit is the earliest close commit
// whose notebook already holds the Reply; a round with none is not flagged.
// Commits are read oldest first and reading stops once every Reply is matched.
function closeCommitMismatches(root, notebook, asks) {
  const flagged = new Set();
  let pending = asks.filter(a => a.stamp != null && a.replyText && a.replyText.trim())
    .map(a => ({ a, matches: replyMatcher(a.replyText) }));
  if (!pending.length) return flagged;
  for (const c of closeCommits(root, notebook)) {
    const content = closeCommitContent(root, c);
    if (content == null) continue;
    pending = pending.filter(({ a, matches }) => {
      if (!matches(content)) return true;
      if (Math.abs(c.at - a.stamp) > TOLERANCE_MS) flagged.add(a.id);
      return false;
    });
    if (!pending.length) break;
  }
  return flagged;
}

module.exports = { closeCommits, closeCommitMismatches };
