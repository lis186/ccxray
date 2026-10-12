'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildWindows } = require('../server/agentflow/windows');
const { attributeHosts } = require('../server/agentflow/host');
const { findTranscripts } = require('../server/agentflow/discover');

const MIN = 60 * 1000;
const T = m => Date.UTC(2026, 5, 1, 10, 0, 0) + m * MIN;
const ROOT = '/work/repo';
const ask = (id, bullets, stampMin = null) => ({ id, bullets, hasReply: stampMin != null, stamp: stampMin == null ? null : T(stampMin), identity: null, stampUnreadable: false });
const sub = (key, sid, m, text) => ({ key, sessionId: sid, at: T(m), text });
const transcript = (subs, tools = []) => ({ submissions: subs, tools });
const turn = (id, sid, m, extra = {}) => ({ id, sessionId: sid, cwd: ROOT, receivedAt: T(m), ...extra });
const notebook = (asks, transcripts, rel = '.agentflow/devlog.md') => {
  const subs = [...transcripts.values()].filter(Boolean).flatMap(t => t.submissions.map(s => ({ ...s, sessionIds: [s.sessionId] })));
  return { abs: path.join(ROOT, rel), rel, workspaceAbs: path.join(ROOT, '.agentflow'), workspaceRel: '.agentflow', isDefault: rel === '.agentflow/devlog.md', windows: buildWindows(asks, subs, { now: T(1000) }).windows };
};
const summary = r => r.rows.map(x => [x.ask, x.session, x.status, x.evidence, x.labels.join(','), x.turns.map(t => t.id).join(',')]);

describe('attributeHosts: host membership (W7, Host turns)', () => {
  // F1's host part: two coordinators share A-001; only session 1's prompt was
  // recorded, session 2 ran `agf start`, which is notebook evidence.
  const transcripts = new Map([
    ['S1', transcript([sub('u1', 'S1', 1, 'build it')])],
    ['S2', transcript([sub('u2', 'S2', 2, 'a different start prompt')], [{ id: 't1', input: '{"command":"agf start"}' }])],
    ['S3', transcript([], [{ id: 't2', input: '{"command":"ls src"}' }])],
  ]);
  const asks = [ask('A-001', ['build it'], 10), ask('A-002', [])];
  const turns = [turn('a', 'S1', 1.1), turn('b', 'S2', 2.1), turn('c', 'S3', 3)];
  const r = attributeHosts({ turns, checkoutRoot: ROOT + '/', notebooks: [notebook(asks, transcripts)], transcripts });

  it('makes a prompt-match row for the matched session and a window row for a session with notebook evidence', () => {
    assert.deepEqual(summary(r), [
      ['A-001', 'S1', 'unique', 'prompt-match', '', 'a'],
      ['A-001', 'S2', 'unique', 'window', '', 'b'],
    ]);
  });

  it('excludes a session in the same checkout with no notebook evidence', () => {
    assert.equal(r.excludedSessions, 1);
  });
});

describe('attributeHosts: turns', () => {
  const transcripts = new Map([['S1', transcript([sub('u1', 'S1', 5, 'first'), sub('u2', 'S1', 30, 'second')])]]);
  const asks = [ask('A-001', ['first'], 10), ask('A-002', ['ran elsewhere'], 20), ask('A-003', ['second'], 40)];

  it('puts turns before the first start in setup, gap turns in unassigned, and counts those inside a no-local-evidence Ask (F24)', () => {
    const turns = [turn('boot', 'S1', 1), turn('t1', 'S1', 6), turn('wrap', 'S1', 11), turn('gap', 'S1', 15), turn('t3', 'S1', 31)];
    const r = attributeHosts({ turns, checkoutRoot: ROOT, notebooks: [notebook(asks, transcripts)], transcripts });
    assert.deepEqual(r.setup.map(e => e.id), ['boot']);
    assert.deepEqual(summary(r).map(x => [x[0], x[5]]), [['A-001', 't1,wrap'], ['A-003', 't3']]);
    assert.deepEqual(r.unassigned.map(e => e.id), ['gap']);
    assert.deepEqual(r.noLocalTurns, { 'A-002': 1 });
  });

  it('keeps a subagent turn with its host whatever its cwd, and drops a host turn outside the checkout root', () => {
    const turns = [
      turn('main', 'S1', 6),
      turn('sub-flag', 'S1', 7, { cwd: '/elsewhere', isSubagent: true }),
      turn('sub-legacy', 'S1', 7.5, { cwd: ROOT + '/.claude/worktrees/agent-x' }),
      turn('cd', 'S1', 8, { cwd: ROOT + '/scripts' }),
    ];
    const r = attributeHosts({ turns, checkoutRoot: ROOT, notebooks: [notebook(asks, transcripts)], transcripts });
    assert.deepEqual(summary(r)[0][5], 'main,sub-flag,sub-legacy');
    assert.deepEqual(r.offRoot.map(e => e.id), ['cd']);
  });

  it('falls back to cwd plus window when the transcript cannot be read', () => {
    const turns = [turn('t1', 'S1', 6), turn('x', 'S9', 7)];
    const r = attributeHosts({ turns, checkoutRoot: ROOT, notebooks: [notebook(asks, transcripts)], transcripts });
    assert.deepEqual(summary(r).find(x => x[1] === 'S9'), ['A-001', 'S9', 'unique', 'window', 'evidence unreadable', 'x']);
  });

  it('makes a turn held by windows of two notebooks of the workspace ambiguous', () => {
    const t2 = new Map([['S1', transcript([sub('u1', 'S1', 5, 'first'), sub('u9', 'S1', 6, 'other notebook')], [{ id: 't', input: 'cat .agentflow/devlog.md' }])]]);
    const other = notebook([ask('A-001', ['other notebook'], 12)], t2, '.agentflow/notes.devlog.md');
    const turns = [turn('t1', 'S1', 5.5), turn('t2', 'S1', 7)];
    const r = attributeHosts({ turns, checkoutRoot: ROOT, notebooks: [notebook(asks, t2), other], transcripts: t2 });
    assert.deepEqual(summary(r).map(x => [x[0], x[2], x[5]]), [['A-001', 'unique', 't1'], ['A-001', 'ambiguous', 't2']]);
  });

  it('counts generic evidence for the default notebook only, so a merged stream copy takes no turns (F33)', () => {
    const t2 = new Map([['S1', transcript([sub('u1', 'S1', 5, 'first')], [{ id: 't', input: '{"command":"agf status && ls .agentflow/"}' }])]]);
    const stream = notebook([ask('A-001', ['stream work'], 12)], new Map([['S9', transcript([sub('u9', 'S9', 6, 'stream work')])]]), '.agentflow/features/k/k.devlog.md');
    const turns = [turn('t1', 'S1', 5.5), turn('t2', 'S1', 7)];
    const r = attributeHosts({ turns, checkoutRoot: ROOT, notebooks: [notebook(asks, t2), stream], transcripts: t2 });
    assert.deepEqual(summary(r).map(x => [x[0], x[2], x[5]]), [['A-001', 'unique', 't1,t2']]);
    assert.deepEqual(r.hostOf.get('S1'), [0]);
  });
});

describe('findTranscripts', () => {
  it('finds Claude and Codex transcripts by session id, not by an encoded cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-discover-'));
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
    const claude = path.join(dir, 'claude/projects'), codex = path.join(dir, 'codex/sessions');
    fs.mkdirSync(path.join(claude, '-anything-at-all'), { recursive: true });
    fs.writeFileSync(path.join(claude, '-anything-at-all', 'aaaa.jsonl'), '');
    const cid = '01a10f51-b72f-7323-864e-0dfdb9a94433';
    fs.mkdirSync(path.join(codex, '2026/10/06'), { recursive: true });
    fs.writeFileSync(path.join(codex, '2026/10/06', `rollout-2026-10-06T11-46-16-${cid}.jsonl`), '');
    const found = findTranscripts(['aaaa', cid, 'missing'], { claudeDirs: [claude], codexDirs: [codex] });
    assert.deepEqual([...found].map(([k, v]) => [k, v.provider, path.basename(v.file)]),
      [['aaaa', 'anthropic', 'aaaa.jsonl'], [cid, 'openai', `rollout-2026-10-06T11-46-16-${cid}.jsonl`]]);
  });
});
