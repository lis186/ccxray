'use strict';

// Privacy sentinels: a fixture whose every free-text and identifying input
// carries a marker (prompt and bullets, Reply body, hand notes, repo and clone
// paths, host and worker session ids, tool commands and results, dispatch fields
// that fail the shape check). The report, text or JSON, must contain none.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-privacy-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {} });

const S = {
  prompt: 'zqprompt7781', reply: 'zqreply7782', hand: 'zqhand7783', dir: 'zqdir7784',
  command: 'zqcommand7785', result: 'zqresult7786', stage: 'zqstage7787', host: 'a7a7a7a7-7787-4787-8787-a7a7a7a7a7a7',
  worker: 'b7b7b7b7-7787-4787-8787-b7b7b7b7b7b7', clone: 'zqclone7788',
};
const REPO = path.join(BASE, S.dir, 'repo');
const HOME = path.join(BASE, 'ccxray-home');
const CLAUDE = path.join(BASE, 'claude', 'projects');
const CODEX = path.join(BASE, 'codex', 'sessions');
const CLONE = path.join(BASE, 'T', `agentflow-external-runner-${S.clone}`, 'clone');
const PROMPT = `please ${S.prompt} the thing`;
const t = s => Date.UTC(2026, 5, 1, 10, 0, s);
const iso = s => new Date(t(s)).toISOString();

fs.mkdirSync(path.join(REPO, '.agentflow', 'artifacts', 'A-001-x', 'dispatch'), { recursive: true });
execFileSync('git', ['init', '-q', REPO]);
fs.writeFileSync(path.join(REPO, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', `+ ${PROMPT}`, '', `hand note ${S.hand}`, '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (claude/unknown)_', '', `answer ${S.reply}`, '',
].join('\n'));
fs.writeFileSync(path.join(REPO, '.agentflow', 'artifacts', 'A-001-x', 'dispatch', 'implement-dispatch.json'), JSON.stringify({
  stage: `${S.stage} with spaces`, model: `bad model ${S.stage}`, effort: S.stage.toUpperCase(), started: iso(80), finished: iso(130), clone: CLONE,
  result: { command: S.command, stdout: S.result },
}));

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 0 };
const row = (id, sessionId, s, cwd, extra) => ({ id, sessionId, provider: 'anthropic', model: 'claude-test', receivedAt: t(s), cwd, responseId: `msg_${id}`, usage, cost: { cost: 0.5, confidence: 'exact' }, title: `${S.prompt} title`, ...extra });
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'logs', 'index.ndjson'), [
  row('h1', S.host, 60, REPO, { imported: true }), row('h1', S.host, 60, null),
  row('h2', S.host, 150, REPO, { imported: true }),
  row('w1', S.worker, 100, CLONE), row('w2', S.worker, 120, CLONE),
].map(r => JSON.stringify(r)).join('\n') + '\n');

const proj = path.join(CLAUDE, 'p');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(CODEX, { recursive: true });
const runnerResult = JSON.stringify({ status: 'completed', working_directory: CLONE, stdin_closed: true, clone: { root: CLONE }, stdout: S.result });
fs.writeFileSync(path.join(proj, `${S.host}.jsonl`), [
  { type: 'user', uuid: 'u1', sessionId: S.host, cwd: REPO, timestamp: iso(55), message: { role: 'user', content: PROMPT } },
  { type: 'assistant', uuid: 'a1', sessionId: S.host, cwd: REPO, timestamp: iso(60), message: { id: 'msg_h1', role: 'assistant', model: 'claude-test', usage, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `node external-runner.js ${S.command}` } }] } },
  { type: 'user', uuid: 'r1', sessionId: S.host, cwd: REPO, timestamp: iso(140), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: runnerResult }] } },
  { type: 'user', uuid: 'u2', sessionId: S.host, cwd: REPO, timestamp: iso(145), message: { role: 'user', content: `unmatched follow-up ${S.prompt}` } },
  { type: 'assistant', uuid: 'a2', sessionId: S.host, cwd: REPO, timestamp: iso(150), message: { id: 'msg_h2', role: 'assistant', model: 'claude-test', usage, content: [{ type: 'text', text: S.reply }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

function report(...args) {
  const env = { ...process.env, CCXRAY_HOME: HOME, CCXRAY_IMPORT_HOMES: CLAUDE, CCXRAY_IMPORT_CODEX_HOMES: CODEX };
  delete env.LOGS_DIR;
  return spawnSync(process.execPath, [path.join(__dirname, '../server/index.js'), 'agentflow', 'report', ...args], { cwd: REPO, env, encoding: 'utf8', timeout: 20000 });
}

describe('agentflow report privacy sentinels (e2e)', () => {
  const text = report();
  const json = report('--json');

  it('runs, and reports the host and the worker the sentinels ride on', () => {
    assert.equal(text.status, 0, text.stderr);
    assert.equal(json.status, 0, json.stderr);
    const a1 = JSON.parse(json.stdout).asks.find(a => a.id === 'A-001');
    assert.deepEqual(a1.executors.map(x => [x.kind, x.evidence, x.status]), [['host', 'prompt-match', 'unique'], ['external', 'dispatch', 'unique']]);
  });

  for (const [name, marker] of Object.entries({ ...S, base: BASE, repo: REPO, clone: CLONE })) {
    it(`never prints the ${name} marker`, () => {
      assert.equal(text.stdout.includes(marker), false, 'text report');
      assert.equal(json.stdout.includes(marker), false, 'JSON report');
      assert.equal(text.stderr.includes(marker) || json.stderr.includes(marker), false, 'stderr');
    });
  }
});
