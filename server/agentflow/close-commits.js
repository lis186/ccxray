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
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
}

// Close commits touching `notebook`, oldest first: { sha, at, content }.
// Outside a Git checkout, or with none, the list is empty.
function closeCommits(root, notebook) {
  const rel = path.relative(root, notebook).split(path.sep).join('/');
  let log;
  try {
    log = git(root, ['log', '--reverse', '--format=%H%x1f%ct%x1f%(trailers:key=Agentflow-Close-Id,valueonly,separator=%x1f)%x1e', '--', rel]);
  } catch { return []; }
  const out = [];
  for (const rec of log.split('\x1e')) {
    const [sha, ct, ...ids] = rec.trim().split('\x1f');
    if (!sha || !ids.some(id => CLOSE_ID.test(id.trim()))) continue;
    let content;
    try { content = git(root, ['show', `${sha}:./${rel}`]); } catch { continue; }
    out.push({ sha, at: Number(ct) * 1000, content });
  }
  return out;
}

// Ask ids whose matching close commit's committer time differs from the Reply
// stamp by more than a minute. The matching commit is the earliest close commit
// whose notebook already holds the Reply; a round with none is not flagged.
function closeCommitMismatches(root, notebook, asks) {
  const flagged = new Set();
  const replied = asks.filter(a => a.stamp != null && a.replyText && a.replyText.trim());
  if (!replied.length) return flagged;
  const commits = closeCommits(root, notebook);
  for (const a of replied) {
    const reply = a.replyText.trim();
    const c = commits.find(x => x.content.includes(reply));
    if (c && Math.abs(c.at - a.stamp) > TOLERANCE_MS) flagged.add(a.id);
  }
  return flagged;
}

module.exports = { closeCommits, closeCommitMismatches };
