'use strict';

// Regression coverage for PR #646 review findings. Every report reads only
// synthetic notebooks, transcripts, dispatch records and index rows.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-pr646-')));
const ROOT = path.resolve(__dirname, '..');
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {} });

const at = s => Date.UTC(2026, 5, 1, 10, 0, s);
const iso = s => new Date(at(s)).toISOString();
const sid = n => `11111111-2222-3333-4444-${String(n).padStart(12, '0')}`;

function setup(name, prompts = ['task']) {
  const base = path.join(BASE, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'ccxray-home');
  const claude = path.join(base, 'claude', 'projects');
  const codex = path.join(base, 'codex', 'sessions');
  fs.mkdirSync(path.join(repo, '.agentflow'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(repo, 'ag.json'), JSON.stringify({ switches: { 'target-doc': '.agentflow/devlog.md', 'workspace-dir': '.agentflow' } }));
  writeNotebook(path.join(repo, '.agentflow', 'devlog.md'), prompts);
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
  return { base, repo, home, claude, codex };
}

function writeNotebook(file, prompts) {
  const lines = [];
  prompts.forEach((prompt, i) => {
    const n = String(i + 1).padStart(3, '0');
    lines.push(`# → Ask / A-${n}`, '', `+ ${prompt}`, '', `# ← Reply / A-${n}`, '', `* _2026-06-01 10:0${i + 1}:00 +0000 (claude/unknown)_`, '', 'done', '');
  });
  fs.writeFileSync(file, lines.join('\n'));
}

function writeOneAskWithBullets(file, prompts) {
  fs.writeFileSync(file, [
    '# → Ask / A-001', '', ...prompts.flatMap((prompt, i) => i ? ['', `+ ${prompt}`] : [`+ ${prompt}`]), '',
    '# ← Reply / A-001', '', '* _2026-06-01 10:01:00 +0000 (claude/unknown)_', '', 'done', '',
  ].join('\n'));
}

function writeIndex(ctx, rows) {
  fs.writeFileSync(path.join(ctx.home, 'logs', 'index.ndjson'), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function report(ctx, notebook = '.agentflow/devlog.md', { text = false } = {}) {
  const env = {
    ...process.env,
    CCXRAY_HOME: ctx.home,
    CCXRAY_IMPORT_HOMES: ctx.claude,
    CCXRAY_IMPORT_CODEX_HOMES: ctx.codex,
    CCXRAY_IMPORT_DISABLE: '1',
  };
  delete env.LOGS_DIR;
  const run = spawnSync(process.execPath, [path.join(ROOT, 'server/index.js'), 'agentflow', 'report', '--notebook', notebook, ...(text ? [] : ['--json'])], {
    cwd: ctx.repo, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(run.status, 0, run.stderr);
  return text ? run.stdout : JSON.parse(run.stdout);
}

function claudeProject(ctx, repo) {
  const dir = path.join(ctx.claude, repo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeClaudeRunnerHost(ctx, session, prompt, clone) {
  const project = claudeProject(ctx, ctx.repo);
  fs.writeFileSync(path.join(project, `${session}.jsonl`), [
    { type: 'user', uuid: 'host-owner', sessionId: session, cwd: ctx.repo, timestamp: iso(10), message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: 'host-call', sessionId: session, cwd: ctx.repo, timestamp: iso(15), message: { id: 'msg-host', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-runner', name: 'Bash', input: { command: 'node scripts/external-runner.js' } }] } },
    { type: 'user', uuid: 'host-result', sessionId: session, cwd: ctx.repo, timestamp: iso(35), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-runner', content: JSON.stringify({ working_directory: clone, clone: { root: clone } }) }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const row = { sessionId: session, provider: 'anthropic', model: 'claude-test', cwd: ctx.repo, receivedAt: at(15), responseId: 'msg-host', usage: { input_tokens: 10 }, cost: { cost: 0.5, confidence: 'exact' } };
  return [{ ...row, id: 'host-proxy' }, { ...row, id: 'host-import', imported: true, importSource: 'claude-code' }];
}

function writeDispatch(ctx, scope, ask, clone, start, finish) {
  const dir = path.join(ctx.repo, '.agentflow', scope, 'artifacts', `${ask}-test`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'implement-dispatch.json'), JSON.stringify({
    clone, started: iso(start), finished: iso(finish), stage: 'implement',
  }));
}

function writeCodex(ctx, repo, session, prompt, second = false) {
  const day = path.join(ctx.codex, '2026', '06', '01');
  fs.mkdirSync(day, { recursive: true });
  const ts = s => new Date(at(s)).toISOString();
  const events = [
    { timestamp: ts(5), type: 'session_meta', payload: { id: session, cwd: repo, thread_source: 'user' } },
    { timestamp: ts(10), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { timestamp: ts(20), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } } },
  ];
  const suffix = second ? '02' : '01';
  fs.writeFileSync(path.join(day, `rollout-2026-06-01T10-00-${suffix}-${session}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

describe('PR #646 report regressions', () => {
  it('keeps conflicting worker turns scoped to their candidate notebooks', () => {
    const ctx = setup('worker-scope');
    const feature = path.join(ctx.repo, '.agentflow', 'features', 'b');
    fs.mkdirSync(feature, { recursive: true });
    writeNotebook(path.join(feature, 'b.devlog.md'), ['feature one', 'feature two']);

    const clone = path.join(ctx.base, 'agentflow-external-runner-b-conflict', 'clone');
    writeDispatch(ctx, 'features/b', 'A-001', clone, 20, 30);
    writeDispatch(ctx, 'features/b', 'A-002', clone, 20, 30);
    writeIndex(ctx, [{ id: 'w-conflict', sessionId: 'worker-conflict', provider: 'anthropic', model: 'claude-test', cwd: clone, receivedAt: at(25), responseId: 'msg-conflict', usage: { input_tokens: 1 }, cost: { cost: 9, confidence: 'exact' } }]);

    const rootReport = report(ctx);
    const featureReport = report(ctx, '.agentflow/features/b/b.devlog.md');
    assert.equal(rootReport.workersAmbiguous, null, 'a feature-only conflict is absent from the root notebook');
    assert.equal(featureReport.workersAmbiguous.calls, 1);
    assert.equal(featureReport.workersAmbiguous.cost, 9);
  });

  it('keeps a worker whose dispatch names a nonexistent Ask in notebook-level unassigned', () => {
    const ctx = setup('worker-invalid-ask');
    const feature = path.join(ctx.repo, '.agentflow', 'features', 'b');
    fs.mkdirSync(feature, { recursive: true });
    writeNotebook(path.join(feature, 'b.devlog.md'), ['feature one']);
    const clone = path.join(ctx.base, 'agentflow-external-runner-b-invalid-ask', 'clone');
    writeDispatch(ctx, 'features/b', 'A-999', clone, 40, 50);
    writeIndex(ctx, [{ id: 'w-invalid', sessionId: 'worker-invalid', provider: 'anthropic', model: 'claude-test', cwd: clone, receivedAt: at(45), responseId: 'msg-invalid', usage: { input_tokens: 1 }, cost: { cost: 4, confidence: 'exact' } }]);
    const rootReport = report(ctx);
    const featureReport = report(ctx, '.agentflow/features/b/b.devlog.md');
    assert.equal(rootReport.workersUnassigned, null, 'a feature worker stays out of the root notebook');
    assert.equal(featureReport.workersUnassigned.calls, 1, 'a dispatch naming a nonexistent Ask remains visible');
    assert.equal(featureReport.workersUnassigned.cost, 4);
  });

  it('includes native Claude child turns in host completeness and pending-import counts', () => {
    const ctx = setup('claude-child', ['hello agent']);
    const session = sid(1);
    const child = sid(2);
    const project = claudeProject(ctx, ctx.repo);
    const transcript = [
      { type: 'user', uuid: 'owner', sessionId: session, cwd: ctx.repo, timestamp: iso(10), message: { role: 'user', content: 'hello agent' } },
      { type: 'assistant', uuid: 'main-turn', sessionId: session, cwd: ctx.repo, timestamp: iso(20), message: { id: 'msg-main', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ];
    fs.writeFileSync(path.join(project, `${session}.jsonl`), transcript.map(e => JSON.stringify(e)).join('\n') + '\n');
    const childDir = path.join(project, session, 'subagents');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, 'agent-child.jsonl'), JSON.stringify({
      type: 'assistant', uuid: 'child-turn', sessionId: child, cwd: ctx.repo, timestamp: iso(30),
      message: { id: 'msg-child', role: 'assistant', content: [{ type: 'text', text: 'child work' }] },
    }) + '\n');
    const common = { sessionId: session, provider: 'anthropic', model: 'claude-test', cwd: ctx.repo, receivedAt: at(20), responseId: 'msg-main', usage: { input_tokens: 10 }, cost: { cost: 0.5, confidence: 'exact' } };
    writeIndex(ctx, [{ ...common, id: 'proxy-main' }, { ...common, id: 'import-main', imported: true, importSource: 'claude-code' }]);

    const a1 = report(ctx).asks.find(ask => ask.id === 'A-001');
    assert.equal(a1.completeness, 'partial proxy coverage');
    assert.equal(a1.executors.find(row => row.kind === 'host').completeness, 'partial proxy coverage');
    assert.ok(a1.labels.includes('not yet imported: 1 turns'), a1.labels.join(' | '));
  });

  it('names each native subagent by its type and keeps it inside the host row', () => {
    const ctx = setup('subagent-role', ['hello agent']);
    const session = sid(6);
    fs.writeFileSync(path.join(claudeProject(ctx, ctx.repo), `${session}.jsonl`), [
      { type: 'user', uuid: 'owner', sessionId: session, cwd: ctx.repo, timestamp: iso(10), message: { role: 'user', content: 'hello agent' } },
      { type: 'assistant', uuid: 'main-turn', sessionId: session, cwd: ctx.repo, timestamp: iso(20), message: { id: 'msg-main', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    const row = { sessionId: session, provider: 'anthropic', model: 'claude-test', cwd: ctx.repo, imported: true, importSource: 'claude-code', usage: { input_tokens: 10 }, cost: { cost: 0.5, confidence: 'exact' } };
    writeIndex(ctx, [
      { ...row, id: 'main', receivedAt: at(20), responseId: 'msg-main' },
      { ...row, id: 'typed', receivedAt: at(30), responseId: 'msg-typed', isSubagent: true, subagentId: 'a1', agentKey: 'general-purpose' },
      { ...row, id: 'untyped', receivedAt: at(40), responseId: 'msg-untyped', isSubagent: true, subagentId: 'a2', agentKey: 'unknown' },
      { ...row, id: 'unshaped', receivedAt: at(45), responseId: 'msg-unshaped', isSubagent: true, subagentId: 'a3', agentKey: 'Review /secret/path' },
    ]);

    const host = report(ctx).asks.find(ask => ask.id === 'A-001').executors.find(x => x.kind === 'host');
    assert.deepEqual(host.subagents.map(s => [s.role, s.calls]).sort(), [['general-purpose', 1], ['unknown', 2]]);
    const text = report(ctx, '.agentflow/devlog.md', { text: true });
    assert.match(text, /^- host · .* · \$2\.000 · 4 calls/m, 'the host row includes its subagents');
    assert.match(text, /^ {2}- subagent general-purpose · .* · 1 calls/m);
    assert.doesNotMatch(text, /secret/, 'a subagent type that is not identifier-shaped never reaches the report');
  });

  it('leaves a Codex background thread in a worker clone out of the worker run and counts it', () => {
    const ctx = setup('worker-background');
    const clone = path.join(ctx.base, 'agentflow-external-runner-bg', 'clone');
    writeDispatch(ctx, '.', 'A-001', clone, 20, 30);
    const worker = sid(7), background = sid(8);
    const day = path.join(ctx.codex, '2026', '06', '01');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, `rollout-2026-06-01T10-00-08-${background}.jsonl`),
      JSON.stringify({ timestamp: iso(21), type: 'session_meta', payload: { id: background, cwd: clone, thread_source: 'automation' } }) + '\n');
    const row = { provider: 'openai', model: 'gpt-test', cwd: clone, imported: true, usage: { input_tokens: 1 } };
    writeIndex(ctx, [
      { ...row, id: 'w-run', sessionId: worker, receivedAt: at(25), cost: { cost: 4, confidence: 'exact' } },
      { ...row, id: 'w-background', sessionId: background, receivedAt: at(26), cost: { cost: 9, confidence: 'exact' } },
    ]);
    const r = report(ctx);
    const external = r.asks.find(ask => ask.id === 'A-001').executors.filter(x => x.kind === 'external');
    assert.deepEqual(external.map(x => [x.total.calls, x.total.cost]), [[1, 4]]);
    assert.equal(r.footer.background, 1);
  });

  it('reads a notebook named through a symlink as the checkout\'s default notebook', () => {
    const ctx = setup('symlinked-notebook');
    const clone = path.join(ctx.base, 'agentflow-external-runner-link', 'clone');
    writeDispatch(ctx, '.', 'A-001', clone, 20, 30);
    writeIndex(ctx, [{ id: 'w-link', sessionId: 'worker-link', provider: 'anthropic', model: 'claude-test', cwd: clone, receivedAt: at(25), responseId: 'msg-link', usage: { input_tokens: 1 }, cost: { cost: 4, confidence: 'exact' } }]);
    const link = path.join(ctx.base, 'repo-link');
    fs.symlinkSync(ctx.repo, link);
    const external = report(ctx, path.join(link, '.agentflow', 'devlog.md')).asks.find(ask => ask.id === 'A-001').executors.filter(x => x.kind === 'external');
    assert.deepEqual(external.map(x => [x.total.calls, x.total.cost]), [[1, 4]]);
  });

  it('labels a Claude worker from its transcript turns, as a host is labelled', () => {
    const ctx = setup('worker-completeness');
    const clone = path.join(ctx.base, 'agentflow-external-runner-wc', 'clone');
    writeDispatch(ctx, '.', 'A-001', clone, 20, 40);
    const worker = sid(9);
    const said = (uuid, s, id, cwd = clone) => ({ type: 'assistant', uuid, sessionId: worker, cwd, timestamp: iso(s), message: { id, role: 'assistant', content: [{ type: 'text', text: 'work' }] } });
    // msg-w0 ran in the checkout, not the clone: not the worker's turn, whatever its index lines.
    fs.writeFileSync(path.join(claudeProject(ctx, clone), `${worker}.jsonl`),
      [said('w0', 22, 'msg-w0', ctx.repo), said('w1', 25, 'msg-w1'), said('w2', 30, 'msg-w2')].map(e => JSON.stringify(e)).join('\n') + '\n');
    const row = { sessionId: worker, provider: 'anthropic', model: 'claude-test', cwd: clone, receivedAt: at(25), responseId: 'msg-w1', usage: { input_tokens: 1 }, cost: { cost: 4, confidence: 'exact' } };
    const external = () => report(ctx).asks.find(ask => ask.id === 'A-001').executors.filter(x => x.kind === 'external').map(x => [x.completeness, x.total.calls]);

    // msg-w2 is in no index line: the proxy never saw it, so the worker is not complete.
    writeIndex(ctx, [{ ...row, id: 'w-proxy' }, { ...row, id: 'w-import', imported: true, importSource: 'claude-code' }]);
    assert.deepEqual(external(), [['partial proxy coverage', 1]]);
    // Once the proxy has it too, every transcript turn has a twin.
    writeIndex(ctx, [{ ...row, id: 'w-proxy' }, { ...row, id: 'w-import', imported: true, importSource: 'claude-code' },
      { ...row, id: 'w-proxy-2', receivedAt: at(30), responseId: 'msg-w2' }]);
    assert.deepEqual(external(), [['complete', 2]]);
  });

  it('splits a reused worker session\'s transcript turns among its runs', () => {
    const ctx = setup('worker-reused', ['one', 'two']);
    const clone = path.join(ctx.base, 'agentflow-external-runner-reuse', 'clone');
    writeDispatch(ctx, '.', 'A-001', clone, 20, 30);
    writeDispatch(ctx, '.', 'A-002', clone, 70, 80);
    const worker = sid(10);
    const said = (uuid, s, id) => ({ type: 'assistant', uuid, sessionId: worker, cwd: clone, timestamp: iso(s), message: { id, role: 'assistant', content: [{ type: 'text', text: 'work' }] } });
    fs.writeFileSync(path.join(claudeProject(ctx, clone), `${worker}.jsonl`),
      [said('a', 25, 'msg-a'), said('c', 72, 'msg-c'), said('b', 75, 'msg-b')].map(e => JSON.stringify(e)).join('\n') + '\n');
    const row = { sessionId: worker, provider: 'anthropic', model: 'claude-test', cwd: clone, usage: { input_tokens: 1 }, cost: { cost: 1, confidence: 'exact' } };
    const both = (id, s) => [{ ...row, id: `${id}-p`, receivedAt: at(s), responseId: id }, { ...row, id: `${id}-i`, receivedAt: at(s), responseId: id, imported: true, importSource: 'claude-code' }];
    writeIndex(ctx, [...both('msg-a', 25), ...both('msg-b', 75)]);
    const label = ask => report(ctx).asks.find(a => a.id === ask).executors.filter(x => x.kind === 'external').map(x => x.completeness);
    // msg-c, in no index line, falls in the second dispatch interval, before
    // that run's first indexed turn: the second run's turn only.
    assert.deepEqual(label('A-001'), ['complete']);
    assert.deepEqual(label('A-002'), ['partial proxy coverage']);
  });

  it('gives a worker transcript turn outside every interval to its session\'s residual run', () => {
    const ctx = setup('worker-residual');
    const clone = path.join(ctx.base, 'agentflow-external-runner-res', 'clone');
    writeDispatch(ctx, '.', 'A-001', clone, 20, 30);
    const worker = sid(12);
    const said = (uuid, s, id) => ({ type: 'assistant', uuid, sessionId: worker, cwd: clone, timestamp: iso(s), message: { id, role: 'assistant', content: [{ type: 'text', text: 'work' }] } });
    fs.writeFileSync(path.join(claudeProject(ctx, clone), `${worker}.jsonl`),
      [said('0', 15, 'msg-0'), said('1', 25, 'msg-1'), said('2', 45, 'msg-2'), said('3', 50, 'msg-3')].map(e => JSON.stringify(e)).join('\n') + '\n');
    const row = { sessionId: worker, provider: 'anthropic', model: 'claude-test', cwd: clone, usage: { input_tokens: 1 }, cost: { cost: 1, confidence: 'exact' } };
    const both = (id, s) => [{ ...row, id: `${id}-p`, receivedAt: at(s), responseId: id }, { ...row, id: `${id}-i`, receivedAt: at(s), responseId: id, imported: true, importSource: 'claude-code' }];
    // msg-0 and msg-2 are outside the dispatch interval (the residual run), so
    // msg-3, in no index line, is the residual run's turn, not the dispatched run's.
    writeIndex(ctx, [...both('msg-0', 15), ...both('msg-1', 25), ...both('msg-2', 45)]);
    const external = report(ctx).asks.find(a => a.id === 'A-001').executors.filter(x => x.kind === 'external');
    assert.deepEqual(external.map(x => [x.completeness, x.total.calls]), [['complete', 1]]);
  });

  it('gives a native subagent turn of a session in two clones to neither run, as its index turns', () => {
    const ctx = setup('worker-two-clones', ['one', 'two']);
    const clone1 = path.join(ctx.base, 'agentflow-external-runner-two1', 'clone');
    const clone2 = path.join(ctx.base, 'agentflow-external-runner-two2', 'clone');
    writeDispatch(ctx, '.', 'A-001', clone1, 20, 40);
    writeDispatch(ctx, '.', 'A-002', clone2, 70, 90);
    const worker = sid(13);
    const said = (uuid, s, id, cwd) => ({ type: 'assistant', uuid, sessionId: worker, cwd, timestamp: iso(s), message: { id, role: 'assistant', content: [{ type: 'text', text: 'work' }] } });
    const project = claudeProject(ctx, clone1);
    fs.writeFileSync(path.join(project, `${worker}.jsonl`),
      [said('1', 25, 'msg-1', clone1), said('2', 75, 'msg-2', clone2)].map(e => JSON.stringify(e)).join('\n') + '\n');
    // A subagent turn in its own worktree that no index line carries: its worker
    // session ran in two clones, so it belongs to neither run.
    fs.mkdirSync(path.join(project, worker, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(project, worker, 'subagents', 'agent-x.jsonl'), JSON.stringify(said('s', 30, 'msg-s', ctx.repo)) + '\n');
    const row = { sessionId: worker, provider: 'anthropic', model: 'claude-test', usage: { input_tokens: 1 }, cost: { cost: 1, confidence: 'exact' } };
    const both = (id, s, cwd) => [{ ...row, cwd, id: `${id}-p`, receivedAt: at(s), responseId: id }, { ...row, cwd, id: `${id}-i`, receivedAt: at(s), responseId: id, imported: true, importSource: 'claude-code' }];
    writeIndex(ctx, [...both('msg-1', 25, clone1), ...both('msg-2', 75, clone2)]);
    const r = report(ctx);
    const label = ask => r.asks.find(a => a.id === ask).executors.filter(x => x.kind === 'external').map(x => x.completeness);
    assert.deepEqual([label('A-001'), label('A-002')], [['complete'], ['complete']]);
  });

  it('compares a worker\'s own transcript turns with its clone, not with where its subagents ran', () => {
    const ctx = setup('worker-subagent-cwd');
    const clone = path.join(ctx.base, 'agentflow-external-runner-sub', 'clone');
    writeDispatch(ctx, '.', 'A-001', clone, 20, 40);
    const worker = sid(11);
    const said = (uuid, s, id, cwd) => ({ type: 'assistant', uuid, sessionId: worker, cwd, timestamp: iso(s), message: { id, role: 'assistant', content: [{ type: 'text', text: 'work' }] } });
    // msg-h ran in the checkout, where the worker's subagent also ran, and msg-n
    // names no cwd; no index line carries either.
    fs.writeFileSync(path.join(claudeProject(ctx, clone), `${worker}.jsonl`),
      [said('w', 25, 'msg-w', clone), said('h', 28, 'msg-h', ctx.repo), said('n', 29, 'msg-n', undefined)].map(e => JSON.stringify(e)).join('\n') + '\n');
    const row = { sessionId: worker, provider: 'anthropic', model: 'claude-test', usage: { input_tokens: 1 }, cost: { cost: 1, confidence: 'exact' } };
    writeIndex(ctx, [
      { ...row, id: 'w-p', cwd: clone, receivedAt: at(25), responseId: 'msg-w' },
      { ...row, id: 'w-i', cwd: clone, receivedAt: at(25), responseId: 'msg-w', imported: true, importSource: 'claude-code' },
      { ...row, id: 's-p', cwd: ctx.repo, receivedAt: at(30), responseId: 'msg-s', isSubagent: true, subagentId: 'a1' },
    ]);
    const external = report(ctx).asks.find(a => a.id === 'A-001').executors.filter(x => x.kind === 'external');
    assert.deepEqual(external.map(x => [x.completeness, x.total.calls]), [['complete', 2]]);
  });

  it('labels a matched Codex transcript without index rows as transcripts only, including in a multi-host fold', () => {
    const onlyCodex = setup('codex-only', ['codex task']);
    const codexSession = sid(3);
    writeCodex(onlyCodex, onlyCodex.repo, codexSession, 'codex task');
    const codexAsk = report(onlyCodex).asks.find(ask => ask.id === 'A-001');
    assert.equal(codexAsk.completeness, 'transcripts only');
    assert.ok(codexAsk.labels.includes('not yet imported: 1 turns'), codexAsk.labels.join(' | '));

    const mixed = setup('codex-fold', ['claude task', 'codex task']);
    writeOneAskWithBullets(path.join(mixed.repo, '.agentflow', 'devlog.md'), ['claude task', 'codex task']);
    const codexMixed = sid(4);
    writeCodex(mixed, mixed.repo, codexMixed, 'codex task', true);
    const claudeSession = sid(5);
    const project = claudeProject(mixed, mixed.repo);
    fs.writeFileSync(path.join(project, `${claudeSession}.jsonl`), [
      { type: 'user', uuid: 'claude-owner', sessionId: claudeSession, cwd: mixed.repo, timestamp: iso(6), message: { role: 'user', content: 'claude task' } },
      { type: 'assistant', uuid: 'claude-turn', sessionId: claudeSession, cwd: mixed.repo, timestamp: iso(15), message: { id: 'msg-claude', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    const claudeRow = { sessionId: claudeSession, provider: 'anthropic', model: 'claude-test', cwd: mixed.repo, receivedAt: at(15), responseId: 'msg-claude', usage: { input_tokens: 10 }, cost: { cost: 0.5, confidence: 'exact' } };
    writeIndex(mixed, [{ ...claudeRow, id: 'claude-proxy' }, { ...claudeRow, id: 'claude-import', imported: true, importSource: 'claude-code' }]);
    const mixedAsk = report(mixed).asks.find(ask => ask.id === 'A-001');
    assert.equal(mixedAsk.completeness, 'partial proxy coverage', JSON.stringify({
      labels: mixedAsk.labels,
      hosts: mixedAsk.executors.filter(row => row.kind === 'host').map(row => ({ completeness: row.completeness, calls: row.total.calls })),
      missing: mixedAsk.labels.filter(label => label.startsWith('not yet imported')),
    }));
    assert.equal(mixedAsk.executors.filter(row => row.kind === 'host').length, 1);
    assert.ok(mixedAsk.labels.includes('not yet imported: 1 turns'), mixedAsk.labels.join(' | '));
  });
});
