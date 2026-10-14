'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, resolveInputs, archivePathFor, UsageError } = require('../server/agentflow/cli');

const INDEX_JS = path.join(__dirname, '../server/index.js');

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function cli(args, { cwd }) {
  const home = tmp('ccxray-agentflow-cli-home-');
  const env = { ...process.env, CCXRAY_HOME: home };
  delete env.LOGS_DIR;
  const r = spawnSync(process.execPath, [INDEX_JS, ...args], { cwd, env, encoding: 'utf8', timeout: 10000 });
  return { ...r, homeEntries: fs.readdirSync(home) };
}

describe('archivePathFor', () => {
  it('follows agentflow compaction names', () => {
    assert.equal(archivePathFor('/r/.agentflow/devlog.md'), '/r/.agentflow/devlog.archive.md');
    assert.equal(archivePathFor('/r/.agentflow/features/s/s.devlog.md'), '/r/.agentflow/features/s/s.archive.md');
    assert.equal(archivePathFor('/r/notes.md'), '/r/notes.archive.md');
  });
});

describe('parseArgs', () => {
  it('requires the report command and validates options', () => {
    assert.deepEqual(parseArgs(['report', '--notebook', 'n.md', '--ask', 'A-012', '--json']),
      { notebook: 'n.md', ask: 'A-012', json: true, help: false });
    assert.throws(() => parseArgs([]), UsageError);
    assert.throws(() => parseArgs(['show']), UsageError);
    assert.throws(() => parseArgs(['report', '--ask', '12']), UsageError);
    assert.throws(() => parseArgs(['report', '--notebook']), UsageError);
    assert.throws(() => parseArgs(['report', '--write']), UsageError);
  });
});

describe('resolveInputs', () => {
  it('defaults to ag.json target-doc and picks up its archive when present', () => {
    const repo = tmp('ccxray-agentflow-repo-');
    fs.mkdirSync(path.join(repo, 'notes'));
    fs.writeFileSync(path.join(repo, 'ag.json'), JSON.stringify({ switches: { 'target-doc': 'notes/log.md' } }));
    fs.writeFileSync(path.join(repo, 'notes/log.md'), '');
    assert.deepEqual(resolveInputs(parseArgs(['report']), repo), { notebook: path.join(repo, 'notes/log.md'), archive: null });
    fs.writeFileSync(path.join(repo, 'notes/log.archive.md'), '');
    assert.equal(resolveInputs(parseArgs(['report']), repo).archive, path.join(repo, 'notes/log.archive.md'));
  });

  it('falls back to .agentflow/devlog.md and reports a missing notebook', () => {
    const repo = tmp('ccxray-agentflow-repo-');
    assert.throws(() => resolveInputs(parseArgs(['report']), repo), /notebook not found: .*\.agentflow\/devlog\.md/);
  });
});

describe('ccxray agentflow (process)', () => {
  it('prints help and exits 0 without touching CCXRAY_HOME', () => {
    const r = cli(['agentflow', 'report', '--help'], { cwd: tmp('ccxray-agentflow-cwd-') });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: ccxray agentflow report/);
    assert.deepEqual(r.homeEntries, []);
  });

  it('rejects a bad option with exit 1 instead of booting a server', () => {
    const r = cli(['--no-browser', 'agentflow', 'report', '--write'], { cwd: tmp('ccxray-agentflow-cwd-') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown option "--write"/);
    assert.deepEqual(r.homeEntries, []);
  });

  it('exits 1 when the default notebook is missing', () => {
    const r = cli(['agentflow', 'report'], { cwd: tmp('ccxray-agentflow-cwd-') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /notebook not found/);
  });
});
