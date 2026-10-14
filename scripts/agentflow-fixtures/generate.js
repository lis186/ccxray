#!/usr/bin/env node
'use strict';

// Generates test/fixtures/agentflow/generated from real programs, at no cost:
// the pinned upstream agentflow external runner makes real clones and prints its
// real result; fake workers (bin/) send requests through this checkout's ccxray
// proxy to a fake upstream, so the proxy writes real index lines; host
// transcripts are synthesized around those real results, and the real importer
// (`ccxray import --once`) merges them into the index. Every path under the
// scratch root is replaced by ${ROOT}; the result is checked for local paths
// before anything is written. expected.json is hand-written and never touched.
//
//   node scripts/agentflow-fixtures/generate.js <upstream>/skills/agentflow/scripts
//
// <upstream> must be agentflow at UPSTREAM_COMMIT (`git archive` of it is enough).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync, fork, execFileSync } = require('node:child_process');

const UPSTREAM_COMMIT = 'd0a6dd0a00d2d0914c900a0a5851764b32b50fb1'; // agentflow 8.4.14
const HERE = __dirname;
const SERVER = path.join(HERE, '../../server/index.js');
const OUT = path.join(HERE, '../../test/fixtures/agentflow/generated');

const upstreamDir = process.argv[2];
if (!upstreamDir || !fs.existsSync(path.join(upstreamDir, 'external-runner.js'))) {
  console.error('usage: generate.js <agentflow>/skills/agentflow/scripts   (agentflow at ' + UPSTREAM_COMMIT.slice(0, 7) + ')');
  process.exit(2);
}

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-fixtures-')));
const REPO = path.join(ROOT, 'repo');
const CCXRAY_HOME = path.join(ROOT, 'ccxray');
const CLAUDE = path.join(ROOT, 'claude', 'projects');
const CODEX = path.join(ROOT, 'codex', 'sessions');
const CLONE_PARENT = path.join(ROOT, 'tmp');
// A caller-chosen clone in the runner's own path shape, so E1 discovers it.
const CHOSEN = path.join(CLONE_PARENT, 'agentflow-external-runner-reuse', 'clone');
// The runner records the worker's executable path, so the fake workers run from
// the scratch root rather than from this checkout.
const BIN = path.join(ROOT, 'bin');
const children = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function scrubbedEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CCXRAY_|ANTHROPIC_|OPENAI_|CHATGPT_|CLAUDE|CODEX_|AGENTFLOW_)|^LOGS_DIR$/u.test(k)) delete env[k];
  // UTC keeps the machine's time zone out of the index lines (`tz`, `id`).
  return { ...env, CCXRAY_HOME, CCXRAY_EXPORT_DISABLE: '1', TZ: 'UTC', ...extra };
}

function freePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function request(port, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(Buffer.concat(chunks).toString())) : reject(new Error(`proxy ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function startUpstream() {
  const child = fork(path.join(HERE, 'fake-upstream.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.add(child);
  const { port } = await new Promise(resolve => child.once('message', resolve));
  return port;
}

async function startProxy(port, upstreamPort) {
  const env = scrubbedEnv({
    CCXRAY_IMPORT_DISABLE: '1', BROWSER: 'none',
    ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http',
    OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
  });
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--no-browser'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  children.add(child);
  for (const started = Date.now(); ;) {
    const ok = await new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${port}/_api/health`, { timeout: 800 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return child;
    if (child.exitCode !== null || Date.now() - started > 15000) throw new Error('proxy did not start');
    await sleep(100);
  }
}

function stop(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 6000).unref();
  });
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=gen', '-c', 'user.email=gen@example.test', ...args], { cwd, stdio: 'ignore' });

// ── a synthesized Claude host: each request goes through the proxy, and its
// transcript records the assistant message under the response id the proxy saw.
class Host {
  constructor(sid, port) { this.sid = sid; this.port = port; this.messages = []; this.lines = []; this.n = 0; }
  stamp(at = Date.now()) { return new Date(at).toISOString(); }
  user(content) {
    this.lines.push({ type: 'user', uuid: `${this.sid}-u${++this.n}`, sessionId: this.sid, cwd: REPO, timestamp: this.stamp(), message: { role: 'user', content } });
    this.messages.push({ role: 'user', content });
  }
  // One request; the assistant answers with `content` (text or tool uses).
  async turn(content) {
    const res = await request(this.port, { model: 'claude-sonnet-4', max_tokens: 64, messages: this.messages,
      system: [{ type: 'text', text: 'You are Claude Code.\nPrimary working directory: ' + REPO }],
      tools: [{ name: 'Bash', description: 'x', input_schema: { type: 'object' } }],
      metadata: { user_id: JSON.stringify({ session_id: this.sid }) } }, { 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
    const message = { id: res.id, type: 'message', role: 'assistant', model: res.model, content, usage: res.usage };
    this.lines.push({ type: 'assistant', uuid: `${this.sid}-a${++this.n}`, sessionId: this.sid, cwd: REPO, timestamp: this.stamp(), message });
    this.messages.push({ role: 'assistant', content });
  }
  result(toolUseId, text) { this.user([{ type: 'tool_result', tool_use_id: toolUseId, content: text }]); }
  write() {
    const dir = path.join(CLAUDE, REPO.replace(/[^a-zA-Z0-9]/gu, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${this.sid}.jsonl`), this.lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }
}
const bash = (id, command) => [{ type: 'tool_use', id, name: 'Bash', input: { command } }];

async function main() {
  process.env.TMPDIR = CLONE_PARENT; // the runner's default clone parent is os.tmpdir()
  fs.mkdirSync(CLONE_PARENT, { recursive: true });
  fs.cpSync(path.join(HERE, 'bin'), BIN, { recursive: true });
  const runner = require(path.join(path.resolve(upstreamDir), 'external-runner.js'));

  fs.mkdirSync(path.join(REPO, '.agentflow'), { recursive: true });
  git(ROOT, 'init', '-q', REPO);
  fs.writeFileSync(path.join(REPO, 'README.md'), 'fixture\n');
  fs.writeFileSync(path.join(REPO, 'ag.json'), JSON.stringify({ switches: { 'target-doc': '.agentflow/devlog.md', 'workspace-dir': '.agentflow' } }, null, 2) + '\n');
  git(REPO, 'add', '.');
  git(REPO, 'commit', '-qm', 'init');

  const upstreamPort = await startUpstream();
  const port = await freePort();
  const proxy = await startProxy(port, upstreamPort);
  const endpoint = `http://127.0.0.1:${port}`;
  const workerEnv = sid => ({ ...scrubbedEnv({}), ANTHROPIC_BASE_URL: endpoint, GEN_OPENAI_BASE: `${endpoint}/v1`, GEN_WORKER_SESSION: sid, GEN_CALLS: '2' });
  const runWorker = (kind, sid, extra = {}) => runner.run_external_command({ source_directory: REPO, command: [path.join(BIN, kind), '-p', 'brief'],
    env: workerEnv(sid), timeout_ms: 20000, termination_grace_ms: 200, ...extra });
  const clones = [];
  const note = r => { if (!clones.includes(r.working_directory)) clones.push(r.working_directory); return JSON.stringify(r, null, 2); };
  const stamps = {};
  const RUNNER = 'node ~/.claude/skills/agentflow/scripts/external-runner.js';

  const h1 = new Host('aaaaaaaa-0000-4000-8000-000000000001', port);
  const h2 = new Host('aaaaaaaa-0000-4000-8000-000000000002', port);

  // A-001 (F1): two coordinators in one worktree; each launches a Claude worker
  // synchronously and gets the full runner result in the same tool call.
  h1.user('implement the parser');
  h2.user('a different start prompt');
  await h1.turn(bash('t1', `${RUNNER} --worker claude`));
  await h2.turn(bash('t2', `agf start --repo . && ${RUNNER} --worker claude`));
  const [r1, r2] = await Promise.all([runWorker('claude', 'bbbbbbbb-0000-4000-8000-000000000001'), runWorker('claude', 'bbbbbbbb-0000-4000-8000-000000000002')]);
  h1.result('t1', note(r1));
  h2.result('t2', note(r2));
  await h1.turn([{ type: 'text', text: 'done' }]);
  await h2.turn([{ type: 'text', text: 'done' }]);
  await sleep(1100);
  stamps['A-001'] = Date.now();
  await sleep(1100);

  // A-002 (F13): a background launch of a Codex worker, read later by its handle.
  h1.user('review the parser');
  await h1.turn(bash('t3', `${RUNNER} --worker codex &`));
  h1.result('t3', 'Command running in background with ID: bgen01. Output is being written to: /tmp/tasks/bgen01.output');
  const r3 = await runWorker('codex', 'cccccccc-0000-4000-8000-000000000003');
  await h1.turn([{ type: 'tool_use', id: 't4', name: 'BashOutput', input: { bash_id: 'bgen01' } }]);
  h1.result('t4', note(r3));
  await h1.turn([{ type: 'text', text: 'reviewed' }]);
  await sleep(1100);
  stamps['A-002'] = Date.now();
  await sleep(1100);

  // A-003 (F30): a wrapper naming the runner prints a summary whose `clone` key
  // holds the clone path.
  h1.user('document the parser');
  await h1.turn(bash('t5', `${RUNNER} --worker claude | jq '{summary: .status, clone: .working_directory}'`));
  const r5 = await runWorker('claude', 'bbbbbbbb-0000-4000-8000-000000000005');
  note(r5);
  h1.result('t5', JSON.stringify({ summary: r5.status, clone: r5.working_directory }));
  await h1.turn([{ type: 'text', text: 'documented' }]);
  await sleep(1100);
  stamps['A-003'] = Date.now();
  await sleep(1100);

  // A-004 (F26), left open: one caller-chosen clone reused for two runs through a
  // wrapper that names neither the runner nor the clone.
  h1.user('benchmark the parser');
  await h1.turn(bash('t6', './bench.sh'));
  const r6 = await runWorker('claude', 'bbbbbbbb-0000-4000-8000-000000000006', { clone_directory: CHOSEN });
  note(r6);
  h1.result('t6', 'bench finished');
  await h1.turn(bash('t7', './bench.sh again'));
  const r7 = await runWorker('claude', 'bbbbbbbb-0000-4000-8000-000000000007', { clone_directory: CHOSEN });
  h1.result('t7', 'bench finished');
  await h1.turn([{ type: 'text', text: 'benchmarked' }]);
  if (r7.working_directory !== r6.working_directory) throw new Error('the chosen clone was not reused');

  const local = at => { const d = new Date(at); const p = x => String(x).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; };
  const reply = id => ['# ← Reply / ' + id, '', `* _${local(stamps[id])} (claude/unknown)_`, '', 'done', ''];
  fs.writeFileSync(path.join(REPO, '.agentflow', 'devlog.md'), [
    '# → Ask / A-001', '', '+ implement the parser', '', ...reply('A-001'),
    '# → Ask / A-002', '', '+ review the parser', '', ...reply('A-002'),
    '# → Ask / A-003', '', '+ document the parser', '', ...reply('A-003'),
    '# → Ask / A-004', '', '+ benchmark the parser', '',
  ].join('\n'));

  h1.write();
  h2.write();
  await stop(proxy);
  fs.mkdirSync(CODEX, { recursive: true });
  const imp = spawnSync(process.execPath, [SERVER, 'import', '--once'], { encoding: 'utf8', timeout: 60000,
    env: scrubbedEnv({ CCXRAY_IMPORT_HOMES: CLAUDE, CCXRAY_IMPORT_CODEX_HOMES: CODEX, CCXRAY_IMPORT_ONCE_MIN_INTERVAL_MS: '0' }) });
  if (imp.status !== 0) throw new Error(`import --once failed: ${imp.stderr}`);

  // ── anonymize and write ──
  const files = {
    'index.ndjson': fs.readFileSync(path.join(CCXRAY_HOME, 'logs', 'index.ndjson'), 'utf8'),
    'devlog.md': fs.readFileSync(path.join(REPO, '.agentflow', 'devlog.md'), 'utf8'),
  };
  for (const h of [h1, h2]) files[`transcripts/${h.sid}.jsonl`] = h.lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  const manifest = { upstream: UPSTREAM_COMMIT, generatedAt: new Date().toISOString(), repo: '${ROOT}/repo', clones: clones.map(c => c.replace(ROOT, '${ROOT}')) };
  files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const forbidden = [ROOT, os.homedir(), os.userInfo().username, '/private/var/folders', '/Users/', zone === 'UTC' ? null : zone].filter(s => s && s.length > 2);
  for (const [name, text] of Object.entries(files)) {
    const clean = text.split(ROOT).join('${ROOT}');
    for (const f of forbidden) if (clean.includes(f)) throw new Error(`${name} still contains a local path or name (${f === os.userInfo().username ? 'username' : f})`);
    files[name] = clean;
  }
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
    fs.writeFileSync(path.join(OUT, name), text);
  }
  const rows = files['index.ndjson'].split('\n').filter(Boolean).length;
  console.log(`wrote ${Object.keys(files).length} files to ${path.relative(process.cwd(), OUT)}: ${rows} index lines, ${clones.length} clones`);
}

main().then(async () => { await Promise.all([...children].map(stop)); fs.rmSync(ROOT, { recursive: true, force: true }); },
  async e => { console.error(e && e.stack || e); await Promise.all([...children].map(stop)); console.error(`scratch kept at ${ROOT}`); process.exit(1); });
