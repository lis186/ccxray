'use strict';

// End to end through `ccxray agentflow report`: a throwaway git checkout with a
// notebook, a synthetic index (proxy + imported twins, a proxy-only prompt
// suggestion with cwd null) and a synthetic Claude transcript. Nothing real is
// read: CCXRAY_HOME and the transcript roots point into a temp dir.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-e2e-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {} });

const REPO = path.join(BASE, 'repo');
const HOME = path.join(BASE, 'ccxray-home');
const CLAUDE = path.join(BASE, 'claude', 'projects');
const CODEX = path.join(BASE, 'codex', 'sessions');
const SID = '11111111-2222-3333-4444-555555555555';
const PROMPT = 'please build the frobnicator';
const t = s => Date.UTC(2026, 5, 1, 10, 0, s);
const iso = s => new Date(t(s)).toISOString();

fs.mkdirSync(path.join(REPO, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO]);
fs.writeFileSync(path.join(REPO, 'ag.json'), JSON.stringify({ switches: { 'target-doc': '.agentflow/devlog.md', 'workspace-dir': '.agentflow' } }));
fs.writeFileSync(path.join(REPO, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', `+ ${PROMPT}`, '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (claude/unknown)_', '', 'done', '',
  '# → Ask / A-002', '', '+', '',
].join('\n'));

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 0 };
const row = (id, s, extra) => ({ id, sessionId: SID, provider: 'anthropic', model: 'claude-test', receivedAt: t(s), usage, cost: { cost: 0.5, confidence: 'exact' }, ...extra });
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'logs', 'index.ndjson'), [
  row('i1', 61, { cwd: REPO, responseId: 'msg_1', imported: true, effort: 'high' }),
  row('p1', 60, { cwd: null, responseId: 'msg_1' }),
  row('i2', 181, { cwd: REPO, responseId: 'msg_2', imported: true, effort: 'high' }),
  row('p2', 180, { cwd: null, responseId: 'msg_2' }),
  row('p3', 200, { cwd: null, responseId: 'msg_suggestion', cost: { cost: 0.25, confidence: 'exact' } }),
].map(r => JSON.stringify(r)).join('\n') + '\n');

const proj = path.join(CLAUDE, REPO.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(CODEX, { recursive: true });
fs.writeFileSync(path.join(proj, `${SID}.jsonl`), [
  { type: 'user', uuid: 'u1', sessionId: SID, cwd: REPO, timestamp: iso(55), message: { role: 'user', content: PROMPT } },
  { type: 'assistant', uuid: 'a1', sessionId: SID, cwd: REPO, timestamp: iso(61), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'agf status' } }] } },
  { type: 'user', uuid: 'r1', sessionId: SID, cwd: REPO, timestamp: iso(62), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'a2', sessionId: SID, cwd: REPO, timestamp: iso(181), message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

// A Codex host in its own checkout: the owner's prompt follows an attached
// image, and the transcript holds three usage turns of which one is imported.
// `tokens` is used again below by its subagent thread.
const REPO2 = path.join(BASE, 'repo2');
const SID2 = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const PROMPT2 = 'describe the attached mockup';
fs.mkdirSync(path.join(REPO2, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO2]);
fs.writeFileSync(path.join(REPO2, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', `+ ${PROMPT2}`, '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (gpt/high)_', '', 'done', '',
].join('\n'));
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), JSON.stringify({
  id: 'c1', sessionId: SID2, provider: 'openai', model: 'gpt-test', receivedAt: t(70), cwd: REPO2, imported: true, importSource: 'codex',
  usage, cost: { cost: 0.5, confidence: 'exact' },
}) + '\n');
const codexDay = path.join(CODEX, '2026', '06', '01');
fs.mkdirSync(codexDay, { recursive: true });
const tokens = s => ({ timestamp: iso(s), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20 } } } });
fs.writeFileSync(path.join(codexDay, `rollout-2026-06-01T10-00-00-${SID2}.jsonl`), [
  { timestamp: iso(50), type: 'session_meta', payload: { id: SID2, cwd: REPO2, thread_source: 'user' } },
  { timestamp: iso(55), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<image name="m.png"></image>\n${PROMPT2}` }] } },
  { timestamp: iso(60), type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"agf status"}' } },
  tokens(70), tokens(80), tokens(90),
].map(r => JSON.stringify(r)).join('\n') + '\n');

// A subagent thread of that host launches the runner synchronously; the worker
// turns run in the clone. Lineage files the launch under the host.
const CLONE = path.join(BASE, 'T', 'agentflow-external-runner-ABCD', 'clone');
const CHILD = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
fs.writeFileSync(path.join(codexDay, `rollout-2026-06-01T10-01-20-${CHILD}.jsonl`), [
  { timestamp: iso(80), type: 'session_meta', payload: { id: CHILD, session_id: SID2, parent_thread_id: SID2, cwd: REPO2, thread_source: 'subagent' } },
  { timestamp: iso(90), type: 'response_item', payload: { type: 'function_call', call_id: 'k1', name: 'exec_command', arguments: '{"cmd":"node external-runner.js"}' } },
  { timestamp: iso(120), type: 'response_item', payload: { type: 'function_call_output', call_id: 'k1', output: JSON.stringify({ working_directory: CLONE, clone: { root: CLONE } }) } },
  tokens(125),
].map(r => JSON.stringify(r)).join('\n') + '\n');
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), JSON.stringify({
  id: 'w1', sessionId: 'worker-1', provider: 'anthropic', model: 'claude-test', receivedAt: t(100), cwd: CLONE, responseId: 'msg_w1',
  usage, cost: { cost: 0.5, confidence: 'exact' },
}) + '\n');

function report(...args) { return reportIn(REPO, ...args); }
function reportIn(cwd, ...args) {
  const env = { ...process.env, CCXRAY_HOME: HOME, CCXRAY_IMPORT_HOMES: CLAUDE, CCXRAY_IMPORT_CODEX_HOMES: CODEX };
  delete env.LOGS_DIR;
  return spawnSync(process.execPath, [path.join(__dirname, '../server/index.js'), 'agentflow', 'report', ...args],
    { cwd, env, encoding: 'utf8', timeout: 20000 });
}

describe('ccxray agentflow report (e2e)', () => {
  it('files a proxied host, its twin-merged turns and a proxy-only request under the Ask', () => {
    const r = report('--json');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const a1 = out.asks.find(a => a.id === 'A-001');
    assert.equal(a1.completeness, 'complete');
    assert.equal(a1.attributed.calls, 3, 'two merged turns plus the proxy-only suggestion, each once');
    assert.equal(a1.attributed.cost, 1.25);
    assert.deepEqual(a1.executors.map(x => [x.kind, x.evidence, x.status]), [['host', 'prompt-match', 'unique']]);
    assert.deepEqual(a1.executors[0].main.effort, { high: 2, unknown: 1 });
    assert.equal(out.asks.find(a => a.id === 'A-002').labels.includes('empty'), true);
  });

  it('prints a text report without prompt text, session ids or paths', () => {
    const r = report();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^## A-001 · complete · /m);
    assert.match(r.stdout, /^- host · prompt-match · unique · complete · claude-test · /m);
    assert.match(r.stdout, /this machine's data only/);
    for (const secret of [PROMPT, SID, REPO, BASE]) assert.equal(r.stdout.includes(secret), false, `leaked ${secret}`);
    assert.equal(report('--json').stdout.includes(PROMPT), false);
  });

  it('matches a Codex host whose prompt follows an attached image, and counts its turns not yet imported', () => {
    const r = reportIn(REPO2, '--json');
    assert.equal(r.status, 0, r.stderr);
    const a1 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-001');
    assert.deepEqual(a1.executors.filter(x => x.kind === 'host').map(x => [x.kind, x.evidence, x.status, x.completeness]), [['host', 'prompt-match', 'unique', 'transcripts only']]);
    // Three of the host's usage turns and one of its subagent thread's; one imported.
    assert.ok(a1.labels.includes('not yet imported: 3 turns'), a1.labels.join(' | '));
  });

  it('files a worker launched by the Codex host\'s subagent thread under the host\'s Ask', () => {
    const a1 = JSON.parse(reportIn(REPO2, '--json').stdout).asks.find(a => a.id === 'A-001');
    assert.deepEqual(a1.executors.filter(x => x.kind === 'external').map(x => [x.evidence, x.status, x.total.calls]), [['launch-chain', 'unique', 1]]);
  });

  it('rejects an Ask id that is not in the notebook', () => {
    const r = report('--ask', 'A-009');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /A-009 is not in/);
  });
});
