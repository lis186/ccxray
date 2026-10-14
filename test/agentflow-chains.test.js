'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runnerClonePaths, namesRunner, launchHandles } = require('../server/agentflow/runner');
const { reverseDiscovered, chainEvidence, cloneOrigin } = require('../server/agentflow/chains');
const { readClaudeTranscript } = require('../server/agentflow/evidence');
const { subagentTranscripts } = require('../server/agentflow/discover');

const DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-chains-')));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

const C1 = '/private/var/folders/x/T/agentflow-external-runner-AAAAAA/clone';
const C2 = '/work/chosen-clone';
// The runner's own result structure (external-runner.js), abbreviated.
const runnerResult = clone => JSON.stringify({ status: 'completed', working_directory: clone, stdin_closed: true, exit_code: 0, stdout_identity: {}, clone: { root: clone, created: true } }, null, 2);

describe('runnerClonePaths (E1 runner-shaped results)', () => {
  it('reads clone.root and working_directory from the runner result, escaped or not', () => {
    assert.deepEqual(runnerClonePaths(runnerResult(C1)), [C1]);
    assert.deepEqual(runnerClonePaths(JSON.stringify({ out: runnerResult(C2) })), [C2]);
  });
  it('reads the runner result printed as a Python dict', () => {
    assert.deepEqual(runnerClonePaths(`{'status': 'completed', 'working_directory': '${C1}', 'stdin_closed': True, 'clone': {'root': '${C1}', 'remotes': []}}`), [C1]);
  });
  it('accepts a wrapper that prints only clone.root (F14)', () => {
    assert.deepEqual(runnerClonePaths(`done; clone.root=${C2}`), [C2]);
  });
  it('ignores working_directory outside the runner structure, and never returns a checkout root (F25)', () => {
    assert.deepEqual(runnerClonePaths('{"working_directory": "/work/repo", "ok": true}'), []);
    assert.deepEqual(runnerClonePaths(runnerResult('/work/repo'), { checkoutRoots: ['/work/repo/'] }), []);
  });
});

describe('launch recognition', () => {
  it('names the runner, and reads background handles from an immediate result', () => {
    assert.equal(namesRunner('{"command":"node ~/skills/agentflow/scripts/external-runner.js"}'), true);
    assert.equal(namesRunner('{"command":"./my-wrapper.sh review"}'), false);
    assert.deepEqual(launchHandles('Command running in background with ID: bk3pxes25. Output is being written to: /tmp/tasks/bk3pxes25.output'),
      ['bk3pxes25', '/tmp/tasks/bk3pxes25.output']);
    assert.deepEqual(launchHandles('{"backgroundTaskId":"task-7"}'), ['task-7']);
    assert.deepEqual(launchHandles('Chunk ID: a1\nProcess running with session ID 4127\nOriginal token count: 3'), ['"session_id":4127']);
  });
});

describe('chainEvidence (E5)', () => {
  const ev = (id, origin, input, inputAt, result, resultAt, extra = {}) => ({ id, origin, sessionId: 'S', input, inputAt, result, resultAt, ...extra });
  const clones = new Set([C1, C2]);

  it('makes a strong chain when the launch and the clone-path result are one tool call (F1, F5, F12)', () => {
    const r = chainEvidence([ev('t1', 'f', '{"command":"node external-runner.js"}', 10, runnerResult(C1), 20)], clones);
    assert.deepEqual(r.strong.map(s => [s.clone, s.launch.id, s.result.id, s.interval]), [[C1, 't1', 't1', [10, 20]]]);
  });

  it('follows a background handle from launch to the later read of its output (F13)', () => {
    const r = chainEvidence([
      ev('t1', 'f', '{"command":"node external-runner.js &"}', 10, 'Command running in background with ID: bg42.', 11),
      ev('t2', 'f', '{"bash_id":"bg42"}', 30, runnerResult(C1), 31),
    ], clones);
    assert.deepEqual(r.strong.map(s => [s.launch.id, s.result.id, s.interval]), [['t1', 't2', [10, 31]]]);
  });

  it('follows a Codex command still running to the write_stdin that reads its result, by whole session id', () => {
    const r = chainEvidence([
      ev('c1', 'f', '{"cmd":"node external-runner.js"}', 10, 'Process running with session ID 4', 11),
      ev('c2', 'f', '{"session_id":41,"chars":""}', 20, runnerResult(C2), 21),
      ev('c3', 'f', '{"session_id":4,"chars":"","yield_time_ms":30000}', 30, runnerResult(C1), 31),
    ], clones);
    assert.deepEqual(r.strong.map(s => [s.clone, s.launch.id, s.result.id]), [[C1, 'c1', 'c3']]);
  });

  it('reads a write_stdin session id however its JSON is spaced', () => {
    const r = chainEvidence([
      ev('c1', 'f', '{"cmd":"node external-runner.js"}', 10, 'Process running with session ID 4', 11),
      ev('c2', 'f', '{"session_id": 4, "chars": ""}', 30, runnerResult(C1), 31),
    ], clones);
    assert.deepEqual(r.strong.map(s => [s.clone, s.launch.id, s.result.id]), [[C1, 'c1', 'c2']]);
  });

  it('does not pair across transcripts, and a result with no launch is no chain (F4)', () => {
    const r = chainEvidence([
      ev('t1', 'host.jsonl', '{"command":"node external-runner.js &"}', 10, 'running in background with ID: bg42', 11),
      ev('t2', 'other.jsonl', '{"bash_id":"bg42"}', 30, runnerResult(C1), 31),
    ], clones);
    assert.deepEqual(r.strong, []);
    assert.equal(r.results.length, 1);
    assert.equal(r.launches.length, 1);
  });

  it('keeps a truncated preview as evidence while the path is still visible (F15a)', () => {
    const r = chainEvidence([ev('t1', 'f', 'external-runner', 10, `<persisted-output>…Preview: "clone": {"root": "${C1}"`, 20, { truncated: true })], clones);
    assert.equal(r.strong[0].truncated, true);
  });

  it('collects clones for reverse discovery', () => {
    assert.deepEqual([...reverseDiscovered([ev('t', 'f', '', 0, runnerResult(C2), 1)])], [C2]);
  });

  it('does not discover a clone from a bare `clone` key, which only proves a known clone (E1, F30)', () => {
    const summary = JSON.stringify({ summary: 'done', clone: C2 });
    assert.deepEqual([...reverseDiscovered([ev('t', 'f', '{"command":"cat notes.json"}', 0, summary, 1)])], []);
    assert.deepEqual(chainEvidence([ev('t1', 'f', '{"command":"node external-runner.js"}', 10, summary, 20)], clones).strong.map(s => s.clone), [C2]);
  });
});

describe('readClaudeTranscript: persisted results (F15)', () => {
  const write = (name, rows) => { const f = path.join(DIR, name); fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return f; };
  const rows = side => [
    { type: 'assistant', uuid: 'a', sessionId: 'S', timestamp: '2026-06-01T10:00:00Z', message: { id: 'm', content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'node external-runner.js' } }] } },
    { type: 'user', uuid: 'r', sessionId: 'S', timestamp: '2026-06-01T10:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: `<persisted-output>\nOutput too large (40KB). Full output saved to: ${side}\n\nPreview (first 2KB):\n{"status":"completed"` }] } },
  ];

  it('reads the side file the preview names', () => {
    const side = path.join(DIR, 'side.txt');
    fs.writeFileSync(side, runnerResult(C1));
    const t = readClaudeTranscript(write('p1.jsonl', rows(side)));
    assert.equal(t.tools[0].truncated, false);
    assert.deepEqual(runnerClonePaths(t.tools[0].result), [C1]);
  });

  it('keeps the preview and marks it truncated when the side file is gone', () => {
    const t = readClaudeTranscript(write('p2.jsonl', rows(path.join(DIR, 'gone.txt'))));
    assert.equal(t.tools[0].truncated, true);
    assert.match(t.tools[0].result, /persisted-output/);
  });
});

describe('subagentTranscripts', () => {
  it('lists `<session>/subagents/*.jsonl` beside a host transcript', () => {
    const host = path.join(DIR, 'proj', 'S1.jsonl');
    fs.mkdirSync(path.join(DIR, 'proj', 'S1', 'subagents'), { recursive: true });
    fs.writeFileSync(host, '');
    fs.writeFileSync(path.join(DIR, 'proj', 'S1', 'subagents', 'agent-a.jsonl'), '');
    fs.writeFileSync(path.join(DIR, 'proj', 'S1', 'subagents', 'agent-a.meta.json'), '{}');
    assert.deepEqual(subagentTranscripts(host).map(f => path.basename(f)), ['agent-a.jsonl']);
  });
});

describe('cloneOrigin (E4)', () => {
  it('finds the `clone: from` entry among all reflog entries, and returns null for a gone clone', () => {
    const src = path.join(DIR, 'src'), clone = path.join(DIR, 'clone');
    execFileSync('git', ['init', '-q', src]);
    execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    execFileSync('git', ['clone', '-q', src, clone]);
    execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'later']);
    assert.equal(cloneOrigin(clone), src);
    assert.equal(cloneOrigin(path.join(DIR, 'missing-clone')), null);
  });
});
