'use strict';

// Per-entry and per-session git branch recording. Synthetic repos, synthetic
// entries and synthetic transcripts only.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-session-branch-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function repo(name, branch) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}

describe('entry branch field', () => {
  const { buildIndexLine } = require('../server/entry');
  const { getParser } = require('../server/wire-parsers');
  const { _clearGitBranchCache } = require('../server/git-branch');
  beforeEach(() => _clearGitBranchCache());

  it('anthropic buildEntryFields records the cwd checkout branch', () => {
    const cwd = repo('anth', 'feat/anthropic-branch');
    const f = getParser('anthropic').buildEntryFields({
      provider: 'anthropic', parsedBody: { model: 'claude-sonnet-4-6', messages: [] }, cwd,
    });
    assert.equal(f.branch, 'feat/anthropic-branch');
    assert.equal(JSON.parse(buildIndexLine({ id: 'a', ...f })).branch, 'feat/anthropic-branch');
  });

  it('openai buildEntryFields records the cwd checkout branch', () => {
    const cwd = repo('oai', 'fix/codex-branch');
    const f = getParser('openai').buildEntryFields({
      provider: 'openai', transport: 'http', parsedBody: { model: 'gpt-5.5', input: [] },
      response: {}, proxyRes: { statusCode: 200 }, cwd,
    });
    assert.equal(f.branch, 'fix/codex-branch');
  });

  it('unknown cwd → null, and a null branch is omitted from the index line', () => {
    const f = getParser('anthropic').buildEntryFields({
      provider: 'anthropic', parsedBody: { model: 'claude-sonnet-4-6', messages: [] }, cwd: null,
    });
    assert.equal(f.branch, null);
    assert.ok(!('branch' in JSON.parse(buildIndexLine({ id: 'b', ...f }))));
  });

  it('an explicit branch:null (rebuild-index replay) never reads the current checkout', () => {
    const cwd = repo('rebuild', 'today');
    const f = getParser('anthropic').buildEntryFields({
      provider: 'anthropic', parsedBody: { model: 'claude-sonnet-4-6', messages: [] }, cwd, branch: null,
    });
    assert.equal(f.branch, null);
  });

  it('responseId merge fills a missing branch from another copy', () => {
    const store = require('../server/store');
    const merged = store.mergeByResponseId([
      { id: '2026-01-01T00-00-00-000', responseId: 'msg_branch_1', sessionId: 's', receivedAt: 1, imported: true },
      { id: '2026-01-01T00-00-00-001', responseId: 'msg_branch_1', sessionId: 's', receivedAt: 2, branch: 'feat/x' },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].branch, 'feat/x');
  });
});

describe('session branch (session index, sessions.json, /_api/sessions)', () => {
  let tmpHome, origLogsDir, origHome;
  before(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccxray-sb-home-'));
    await fsp.mkdir(path.join(tmpHome, 'logs'), { recursive: true });
    origHome = process.env.CCXRAY_HOME;
    process.env.CCXRAY_HOME = tmpHome;
    const config = require('../server/config');
    origLogsDir = config.LOGS_DIR;
    Object.defineProperty(config, 'LOGS_DIR', { value: path.join(tmpHome, 'logs'), writable: true, configurable: true });
  });
  after(async () => {
    const config = require('../server/config');
    Object.defineProperty(config, 'LOGS_DIR', { value: origLogsDir, writable: true, configurable: true });
    if (origHome === undefined) delete process.env.CCXRAY_HOME; else process.env.CCXRAY_HOME = origHome;
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it('keeps the branch of the latest-received turn; older or branchless turns never roll it back', async () => {
    const si = require('../server/session-index');
    const sid = 'sess-branch-1';
    si.updateFromEntry({ id: '2026-01-01T00-00-01-000', sessionId: sid, receivedAt: 1000, branch: 'main' });
    si.updateFromEntry({ id: '2026-01-01T00-00-03-000', sessionId: sid, receivedAt: 3000, branch: 'feat/later' });
    // An older turn fed last (rebuild/import order) must not win.
    si.updateFromEntry({ id: '2026-01-01T00-00-02-000', sessionId: sid, receivedAt: 2000, branch: 'feat/older' });
    // A newer turn with no branch (unknown cwd) must not clear it.
    si.updateFromEntry({ id: '2026-01-01T00-00-04-000', sessionId: sid, receivedAt: 4000 });
    assert.equal(si.get(sid).branch, 'feat/later');
    si.updateFromEntry({ id: '2026-01-01T00-00-05-000', sessionId: sid, receivedAt: 5000, branch: 'feat/switched' });
    assert.equal(si.get(sid).branch, 'feat/switched');

    await si.flush();
    const config = require('../server/config');
    const rows = (await fsp.readFile(path.join(config.LOGS_DIR, 'sessions.json'), 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(rows.find(r => r.sid === sid).branch, 'feat/switched');

    const { handleApiRoutes } = require('../server/routes/api');
    let body = '';
    const res = { writeHead() {}, end(b) { body = b; }, headersSent: false };
    assert.equal(handleApiRoutes({ url: '/_api/sessions', method: 'GET', headers: {} }, res), true);
    const sess = JSON.parse(body).sessions.find(s => s.sid === sid);
    assert.equal(sess.branch, 'feat/switched');
  });
});

describe('usage --json branch exposure', () => {
  const { analyze } = require('../server/usage');
  const base = { provider: 'anthropic', model: 'claude-opus-4-6', cost: { cost: 0.1 },
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };

  it('topSessions[].branch is the latest-received recorded branch, null when none', () => {
    const r = analyze([
      { ...base, id: '1', sessionId: 'sa', receivedAt: 1, branch: 'main' },
      { ...base, id: '2', sessionId: 'sa', receivedAt: 3, branch: 'feat/pr-42' },
      { ...base, id: '3', sessionId: 'sa', receivedAt: 2, branch: 'feat/old' },
      { ...base, id: '4', sessionId: 'sb', receivedAt: 4 },
    ]);
    const by = Object.fromEntries(r.sessions.topSessions.map(s => [s.sessionId, s]));
    assert.equal(by.sa.branch, 'feat/pr-42');
    assert.equal(by.sb.branch, null);
  });

  it('CLI --json and --cwd grouping still work with branch-bearing rows', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-sb-usage-'));
    try {
      fs.mkdirSync(path.join(home, 'logs'));
      const rows = [
        { ...base, id: '2026-06-01T10-00-00-000', sessionId: 's-alpha', cwd: '/work/alpha', receivedAt: 1717236000000, branch: 'feat/alpha' },
        { ...base, id: '2026-06-01T10-01-00-000', sessionId: 's-beta', cwd: '/work/beta', receivedAt: 1717236060000 },
      ];
      fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const env = { ...process.env, HOME: home, USERPROFILE: home, CCXRAY_HOME: home, LOGS_DIR: path.join(home, 'logs'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') };
      const cli = (...a) => JSON.parse(execFileSync(process.execPath, ['server/index.js', 'usage', ...a], { env, timeout: 10000 }).toString());
      const single = cli('--json', '--cwd', '/work/alpha');
      assert.equal(single.sessions.topSessions[0].branch, 'feat/alpha');
      const multi = cli('--json', '--cwd', '/work/alpha,/work/beta');
      assert.deepEqual(multi.projects.map(p => p.cwd).sort(), ['/work/alpha', '/work/beta']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('importer records the transcript branch', () => {
  const { parseSessionFile, parseCodexSessionFile } = require('../server/importer');

  function claudeAssistant(gitBranch, msgId) {
    return JSON.stringify({
      type: 'assistant', uuid: 'u-' + msgId, timestamp: '2026-07-15T10:30:00.000Z',
      sessionId: 'synthetic-claude-sess', cwd: '/tmp/synthetic-project',
      ...(gitBranch !== undefined ? { gitBranch } : {}),
      message: { id: msgId, model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } },
    });
  }

  it('Claude transcript gitBranch → branch; "HEAD"/""/absent → no branch', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'claude-'));
    const file = path.join(dir, 'synthetic-claude-sess.jsonl');
    fs.writeFileSync(file, [
      claudeAssistant('feat/imported', 'msg_a'),
      claudeAssistant('HEAD', 'msg_b'),
      claudeAssistant('', 'msg_c'),
      claudeAssistant(undefined, 'msg_d'),
    ].join('\n'));
    const byRid = Object.fromEntries((await parseSessionFile(file, '-tmp-synthetic-project')).map(e => [e.responseId, e]));
    assert.equal(byRid.msg_a.branch, 'feat/imported');
    for (const rid of ['msg_b', 'msg_c', 'msg_d']) assert.equal(byRid[rid].branch, null, rid);
  });

  it('Codex session_meta git.branch → branch', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'codex-'));
    const file = path.join(dir, 'rollout-synthetic.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ timestamp: '2026-07-15T10:30:00.000Z', type: 'session_meta',
        payload: { session_id: 'synthetic-codex', cwd: '/tmp/synthetic-codex', git: { branch: 'fix/codex-import' } } }),
      JSON.stringify({ timestamp: '2026-07-15T10:30:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: '/tmp/synthetic-codex' } }),
      JSON.stringify({ timestamp: '2026-07-15T10:30:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
        model_context_window: 258400,
        last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 105 } } } }),
    ].join('\n'));
    const entries = await parseCodexSessionFile(file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].branch, 'fix/codex-import');
  });
});
