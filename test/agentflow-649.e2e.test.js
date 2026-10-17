'use strict';

// #649 report spec gaps: freshness notice, close-commit cross-check and worker
// sources in the footer. Synthetic notebooks, transcripts and index rows only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-649-')));
const ROOT = path.resolve(__dirname, '..');
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {} });

const at = s => Date.UTC(2026, 5, 1, 10, 0, s);
const iso = s => new Date(at(s)).toISOString();
const SESSION = '11111111-2222-3333-4444-000000000649';

function setup(name) {
  const base = path.join(BASE, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'ccxray-home');
  const claude = path.join(base, 'claude', 'projects');
  const codex = path.join(base, 'codex', 'sessions');
  for (const d of [path.join(repo, '.agentflow'), path.join(home, 'logs'), claude, codex]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'ag.json'), JSON.stringify({ switches: { 'target-doc': '.agentflow/devlog.md', 'workspace-dir': '.agentflow' } }));
  fs.writeFileSync(path.join(repo, '.agentflow', 'devlog.md'), [
    '# → Ask / A-001', '', '+ task', '', '# ← Reply / A-001', '', '* _2026-06-01 10:01:00 +0000 (claude/unknown)_', '', 'done', '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
  return { base, repo, home, claude, codex };
}

function writeIndex(ctx, rows) {
  fs.writeFileSync(path.join(ctx.home, 'logs', 'index.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// A Claude host whose transcript holds the owner's prompt for A-001.
function writeHost(ctx) {
  const dir = path.join(ctx.claude, ctx.repo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), [
    { type: 'user', uuid: 'u1', sessionId: SESSION, cwd: ctx.repo, timestamp: iso(10), message: { role: 'user', content: 'task' } },
    { type: 'assistant', uuid: 'a1', sessionId: SESSION, cwd: ctx.repo, timestamp: iso(15), message: { id: 'msg-host', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
}

const hostRow = (extra = {}) => ({ id: 'host', sessionId: SESSION, provider: 'anthropic', model: 'claude-test', cwd: '', receivedAt: at(15), responseId: 'msg-host', usage: { input_tokens: 10 }, cost: { cost: 0.5, confidence: 'exact' }, ...extra });

function report(ctx, { text = false } = {}) {
  const env = { ...process.env, CCXRAY_HOME: ctx.home, CCXRAY_IMPORT_HOMES: ctx.claude, CCXRAY_IMPORT_CODEX_HOMES: ctx.codex, CCXRAY_IMPORT_DISABLE: '1' };
  delete env.LOGS_DIR;
  const run = spawnSync(process.execPath, [path.join(ROOT, 'server/index.js'), 'agentflow', 'report', '--notebook', '.agentflow/devlog.md', ...(text ? [] : ['--json'])], {
    cwd: ctx.repo, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(run.status, 0, run.stderr);
  return text ? run.stdout : JSON.parse(run.stdout);
}

function commit(ctx, date, message) {
  const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
  const g = args => execFileSync('git', ['-C', ctx.repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { env, stdio: 'ignore' });
  g(['add', '-A']);
  g(['commit', '-q', '-m', message]);
}

describe('#649 report spec gaps', () => {
  it('says when the newest imported turn is older than a window end', () => {
    const ctx = setup('freshness');
    writeHost(ctx);
    writeIndex(ctx, [hostRow({ cwd: ctx.repo, imported: true, importSource: 'claude-code' })]);
    const stale = report(ctx);
    assert.equal(stale.footer.newestImportedAt, at(15));
    assert.equal(stale.footer.importStale, 1);
    assert.match(report(ctx, { text: true }), /newest imported turn .* is older than the window end of 1 Asks/u);

    // An import that reached past the window end says nothing.
    writeIndex(ctx, [hostRow({ cwd: ctx.repo, imported: true, importSource: 'claude-code' }),
      { id: 'later', sessionId: 'other', provider: 'anthropic', model: 'claude-test', cwd: '/elsewhere', receivedAt: at(600), responseId: 'msg-later', imported: true, usage: { input_tokens: 1 } }]);
    assert.equal(report(ctx).footer.importStale, 0);

    // A proxy-only index has no imported turn to be stale.
    writeIndex(ctx, [hostRow({ cwd: ctx.repo })]);
    const proxyOnly = report(ctx);
    assert.deepEqual([proxyOnly.footer.newestImportedAt, proxyOnly.footer.importStale], [null, 0]);
  });

  it('flags an Ask whose close commit disagrees with its Reply stamp by more than a minute', () => {
    const trailer = `close A-001\n\nAgentflow-Close-Id: ${'a'.repeat(64)}`;
    const far = setup('close-far');
    execFileSync('git', ['init', '-q', far.repo]);
    commit(far, '2026-06-01T10:05:00Z', trailer);
    assert.ok(report(far).asks[0].labels.includes('close commit mismatch'));

    const near = setup('close-near');
    execFileSync('git', ['init', '-q', near.repo]);
    commit(near, '2026-06-01T10:01:40Z', trailer);
    assert.ok(!report(near).asks[0].labels.includes('close commit mismatch'));

    // No `Agentflow-Close-Id` trailer: no matching close commit, no flag.
    const plain = setup('close-none');
    execFileSync('git', ['init', '-q', plain.repo]);
    commit(plain, '2026-06-01T10:05:00Z', 'notebook');
    assert.ok(!report(plain).asks[0].labels.includes('close commit mismatch'));

    // Outside a Git checkout: no flag.
    assert.ok(!report(setup('close-nogit')).asks[0].labels.includes('close commit mismatch'));
  });

  it('states the source of a Codex worker in the footer', () => {
    const ctx = setup('codex-worker-source');
    const clone = path.join(ctx.base, 'agentflow-external-runner-codex', 'clone');
    const dir = path.join(ctx.repo, '.agentflow', 'artifacts', 'A-001-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'implement-dispatch.json'), JSON.stringify({ clone, started: iso(20), finished: iso(30), stage: 'implement' }));
    writeIndex(ctx, [{ id: 'w', sessionId: 'codex-worker', provider: 'openai', model: 'gpt-test', cwd: clone, receivedAt: at(25), imported: true, importSource: 'codex', usage: { input_tokens: 1 }, cost: { cost: 0.1, confidence: 'exact' } }]);
    const r = report(ctx);
    assert.ok(r.asks[0].executors.some(x => x.kind === 'external'), JSON.stringify(r.asks[0]));
    assert.ok(r.footer.sources.includes('openai: import 1'), r.footer.sources.join(' | '));
  });

  it('shares one null-safe stripSlash', () => {
    const { stripSlash } = require('../server/paths');
    assert.deepEqual([stripSlash('/a/b//'), stripSlash('/'), stripSlash(null), stripSlash(undefined), stripSlash('')], ['/a/b', '/', null, undefined, '']);
    for (const f of ['server/agentflow/host.js', 'server/agentflow/workers.js', 'server/agentflow/runner.js', 'server/usage-query.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /function stripSlash/u, f);
    }
  });
});
