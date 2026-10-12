'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTime, requestedFromArgs, readDispatchRecords, replyDigest, readCompletionRecords } = require('../server/agentflow/records');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-records-')));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });
const WS = path.join(ROOT, '.agentflow');
const put = (rel, body) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n'); return f; };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const CLONE = '/private/var/folders/x/T/agentflow-external-runner-AB12/clone';

describe('replyDigest', () => {
  it('matches upstream agentflow 8.4.14 (golden value computed with its completion-record.js)', () => {
    const golden = 'c5b446c8c67224149163410d7c50292540af69037fb1435dbb8894df18ab2931';
    const body = '\n\nDone.\n\n```completion-metadata\nHost review: PASS\n```\n';
    assert.equal(replyDigest('# ← Reply / A-001\n\n* _2026-06-01 10:05:00 +0000 (claude/unknown)_' + body + '\n## Questions\n\n- later answer\n\n---\n'), golden);
    assert.equal(replyDigest('# ← Reply / A-001\n\n* _2026-06-02 11:00:00 +0800 (gpt/high)_' + body), golden, 'stamp and owner answers do not change it');
  });
});

describe('readDispatchRecords', () => {
  it('reads both layouts, both record shapes, and stream artifacts', () => {
    put('.agentflow/artifacts/A-002-build/dispatch/implement-dispatch.json',
      { stage: 'implement', model: 'claude-sonnet-5', effort: 'low', started: '2026-06-01T10:00:00Z', finished: '2026-06-01 18:30:00 +0800', clone: CLONE, result: {} });
    put('.agentflow/artifacts/A-003-review/cross-check-dispatch.json',
      { status: 'completed', clone_root: CLONE, command: { executable: 'codex', args: ['exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=low'] } });
    put('.agentflow/artifacts/A-004-x/review-dispatch.json', { status: 'completed', result_file_path: `${CLONE}/review-result.json` });
    put('.agentflow/features/search/artifacts/A-001-s/plan-dispatch.json', { working_directory: '/work/c2' });
    put('.agentflow/artifacts/A-005-bad/x-dispatch.json', 'not json');
    const r = readDispatchRecords(WS).map(x => [x.scope, x.ask, x.stage, x.model, x.effort, x.started, x.finished, x.clone, !!x.unreadable]);
    assert.deepEqual(r, [
      ['workspace', 'A-002', 'implement', 'claude-sonnet-5', 'low', Date.UTC(2026, 5, 1, 10), Date.UTC(2026, 5, 1, 10, 30), CLONE, false],
      ['workspace', 'A-003', 'cross-check', 'gpt-6-astra', 'low', null, null, CLONE, false],
      ['workspace', 'A-004', 'review', null, null, null, null, CLONE, false],
      ['workspace', 'A-005', undefined, undefined, undefined, undefined, undefined, undefined, true],
      ['features/search', 'A-001', 'plan', null, null, null, null, '/work/c2', false],
    ]);
  });

  it('passes only identifier-shaped stage, model and effort on to the report', () => {
    const ws = path.join(ROOT, 'sentinel', '.agentflow');
    const f = path.join(ws, 'artifacts', 'A-001-x', 'review-dispatch.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ stage: 'SECRET prompt text', model: '/Users/someone/models/x', effort: 'high; rm -rf' }));
    fs.writeFileSync(path.join(path.dirname(f), 'plan-dispatch.json'), JSON.stringify({ model: 'openrouter/claude-opus-5-5', effort: 'xhigh' }));
    const got = readDispatchRecords(ws).map(x => [x.stage, x.model, x.effort]);
    assert.deepEqual(got.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [[null, null, null], ['plan', 'openrouter/claude-opus-5-5', 'xhigh']]);
  });

  it('parses times in ISO, agentflow stamp, seconds and milliseconds', () => {
    assert.equal(parseTime(1780000000), 1780000000000);
    assert.equal(parseTime(1780000000000), 1780000000000);
    assert.equal(parseTime('nonsense'), null);
    assert.deepEqual(requestedFromArgs(['claude', '-p', '--model=claude-opus-5-5', '--effort', 'high']), { model: 'claude-opus-5-5', effort: 'high' });
  });
});

describe('readCompletionRecords', () => {
  const reply = '# ← Reply / A-001\n\n* _2026-06-01 10:05:00 +0000 (claude/unknown)_\n\nDone.\n';
  const notebooks = [{ rel: '.agentflow/devlog.md', asks: [{ id: 'A-001', replyText: reply }, { id: 'A-002', replyText: reply }] },
    { rel: '.agentflow/notes.md', asks: [{ id: 'A-001', replyText: reply }] }];
  const record = (dir, nb, ask, metadata, { replyText = reply, tamper = false } = {}) => {
    const f = put(`${dir}/completion.json`, { version: 2, notebook: nb, ask, created_at: 'x', metadata_text: metadata });
    const bytes = fs.readFileSync(f);
    put(`${dir}/completion.ref.json`, { version: 2, sha256: tamper ? sha('x') : sha(bytes), reply_sha256: replyDigest(replyText) });
  };
  const ext = clone => `Cross-check review: PASS\n{"transport":{"runner_id":"external-runner-v1","clone":"${clone}"}}`;
  const nsHash = sha('.agentflow/notes.md').slice(0, 16);
  record('.agentflow/.tmp/A-001', '.agentflow/devlog.md', 'A-001', ext(CLONE));
  record(`.agentflow/.tmp/notebooks/${nsHash}/A-001`, '.agentflow/notes.md', 'A-001', ext('/work/c3'));
  record('.agentflow/.tmp/A-002', '.agentflow/devlog.md', 'A-002', ext(CLONE), { replyText: reply + 'edited later\n' });
  record('.agentflow/.tmp/features/gone/A-001', '.agentflow/features/gone/gone.devlog.md', 'A-001', ext(CLONE));
  record('.agentflow/.tmp/notebooks/0000000000000000/A-009', '.agentflow/x.md', 'A-009', 'Cross-check review: PASS\n{"transport":{"clone":"disposable clone under the temp directory"}}');

  it('validates digests, location and namespace, and keeps clones of invalid records for discovery', () => {
    const r = readCompletionRecords(WS, ROOT, notebooks).map(x => [x.ask, x.notebook, x.valid, x.reason, x.clones]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    assert.deepEqual(r, [
      ['A-001', '.agentflow/devlog.md', true, null, [CLONE]],
      ['A-001', '.agentflow/notes.md', true, null, ['/work/c3']],
      ['A-001', null, false, 'namespace names no notebook', [CLONE]],
      ['A-002', '.agentflow/devlog.md', false, 'Reply digest mismatch', [CLONE]],
      ['A-009', null, false, 'namespace names no notebook', []],
    ]);
  });
});
