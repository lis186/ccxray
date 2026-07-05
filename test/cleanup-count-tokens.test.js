'use strict';

// scripts/cleanup-count-tokens.js: removal requires BOTH the count_tokens
// response shape ({"input_tokens": N} only) and a request without max_tokens.
// Anything ambiguous — missing files, malformed lines, /v1/messages-shaped
// requests — must survive the rewrite.

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cleanup-count-tokens.js');
const tmpDirs = [];

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ct-clean-'));
  tmpDirs.push(home);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  return home;
}

function writeEntry(home, id, { indexExtra = {}, req, res } = {}) {
  const logs = path.join(home, 'logs');
  const line = JSON.stringify({ id, sessionId: 's1', usage: null, isSSE: false, ...indexExtra });
  fs.appendFileSync(path.join(logs, 'index.ndjson'), line + '\n');
  if (req !== undefined) fs.writeFileSync(path.join(logs, id + '_req.json'), JSON.stringify(req));
  if (res !== undefined) fs.writeFileSync(path.join(logs, id + '_res.json'), JSON.stringify(res));
}

function run(home, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, CCXRAY_HOME: home },
    encoding: 'utf8',
  });
}

function indexLines(home) {
  return fs.readFileSync(path.join(home, 'logs', 'index.ndjson'), 'utf8').split('\n').filter(Boolean);
}

describe('cleanup-count-tokens script', () => {
  after(() => {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  let home;
  beforeEach(() => {
    home = makeHome();
    // A genuine count_tokens entry (shape captured from real data).
    writeEntry(home, 'ct-1', {
      req: { model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'big doc' }] },
      res: { input_tokens: 73081 },
    });
    // A real turn: usage present — never a candidate.
    writeEntry(home, 'turn-1', {
      indexExtra: { usage: { input_tokens: 10 }, isSSE: true },
      req: { model: 'claude-opus-4-6', max_tokens: 8096, messages: [] },
      res: [{ type: 'message_start' }],
    });
    // False-positive trap: count_tokens-shaped res but the req has
    // max_tokens (i.e. a real /v1/messages call) — must be kept.
    writeEntry(home, 'trap-req', {
      req: { model: 'claude-opus-4-6', max_tokens: 8096, messages: [] },
      res: { input_tokens: 5 },
    });
    // Ambiguity trap: matching res but req file missing — must be kept.
    writeEntry(home, 'trap-noreq', { res: { input_tokens: 5 } });
    // Malformed index line — must be preserved verbatim.
    fs.appendFileSync(path.join(home, 'logs', 'index.ndjson'), 'not json\n');
  });

  it('dry run identifies only the real count_tokens entry and modifies nothing', () => {
    const before = fs.readFileSync(path.join(home, 'logs', 'index.ndjson'), 'utf8');
    const out = run(home);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /count_tokens: 1\b/);
    assert.match(out.stdout, /ct-1/);
    assert.match(out.stdout, /dry run/);
    assert.equal(fs.readFileSync(path.join(home, 'logs', 'index.ndjson'), 'utf8'), before);
  });

  it('--apply removes exactly the count_tokens entry, keeps traps, writes backup', () => {
    const out = run(home, ['--apply']);
    assert.equal(out.status, 0, out.stderr);

    const lines = indexLines(home);
    assert.equal(lines.length, 4, 'ct-1 removed, 3 entries + malformed line kept');
    assert.ok(!lines.some(l => l.includes('ct-1')));
    assert.ok(lines.some(l => l.includes('trap-req')));
    assert.ok(lines.some(l => l.includes('trap-noreq')));
    assert.ok(lines.some(l => l === 'not json'));

    const backups = fs.readdirSync(path.join(home, 'logs')).filter(f => f.startsWith('index.ndjson.bak-'));
    assert.equal(backups.length, 1);
    const backupLines = fs.readFileSync(path.join(home, 'logs', backups[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(backupLines.length, 5, 'backup preserves the pre-cleanup index');
    assert.equal(fs.readdirSync(path.join(home, 'logs')).filter(f => f.includes('.tmp-')).length, 0, 'no temp file left behind');
  });

  it('--apply refuses while a hub is alive on this home', () => {
    fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({ pid: process.pid }));
    const out = run(home, ['--apply']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /hub is running/);
    assert.equal(indexLines(home).length, 5, 'index untouched');
  });
});
