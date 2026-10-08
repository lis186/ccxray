'use strict';

// Locating the transcripts of known sessions. Sessions come from the index (by
// cwd); files are found by session id, never by encoding a cwd into a project
// directory name (Claude Code replaces every non-alphanumeric character, `_`
// included, so the encoding is not reversible).

const fs = require('fs');
const path = require('path');
const { discoverHomes, discoverCodexHomes } = require('../importer');

function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function defaultRoots() {
  return {
    claudeDirs: discoverHomes().map(h => h.dir),
    codexDirs: discoverCodexHomes().map(h => h.dir),
  };
}

// sessionIds → Map(sessionId → { provider, file }). A session missing from the
// map has no readable transcript on this machine.
function findTranscripts(sessionIds, { claudeDirs, codexDirs } = defaultRoots()) {
  const wanted = new Set(sessionIds);
  const found = new Map();
  for (const projects of claudeDirs) {
    for (const p of readdir(projects)) {
      if (!p.isDirectory()) continue;
      for (const sid of wanted) {
        if (found.has(sid)) continue;
        const file = path.join(projects, p.name, `${sid}.jsonl`);
        if (fs.existsSync(file)) found.set(sid, { provider: 'anthropic', file });
      }
    }
  }
  // Codex rollouts: sessions/YYYY/MM/DD/rollout-<time>-<sessionId>.jsonl
  const walk = (dir, depth) => {
    for (const d of readdir(dir)) {
      const full = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (d.isFile() && d.name.endsWith('.jsonl')) {
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(d.name);
        if (m && wanted.has(m[1]) && !found.has(m[1])) found.set(m[1], { provider: 'openai', file: full });
      }
    }
  };
  for (const sessions of codexDirs) walk(sessions, 0);
  return found;
}

module.exports = { defaultRoots, findTranscripts };
