'use strict';

// The generated fixture (scripts/agentflow-fixtures/generate.js): real runner
// results, proxy index lines and importer output, with every scratch path as
// ${ROOT}. The test rebuilds the checkout and the clones under a new root, so
// each clone's `clone: from` reflog names the checkout as the runner's clone did,
// and compares the report with the hand-written expected.json.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures', 'agentflow', 'generated');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-generated-')));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const read = name => fs.readFileSync(path.join(FIXTURE, name), 'utf8').split('${ROOT}').join(ROOT);
const manifest = JSON.parse(read('manifest.json'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, stdio: 'ignore' });

const REPO = manifest.repo;
fs.mkdirSync(path.join(REPO, '.agentflow'), { recursive: true });
git(ROOT, 'init', '-q', REPO);
fs.writeFileSync(path.join(REPO, 'README.md'), 'fixture\n');
fs.writeFileSync(path.join(REPO, 'ag.json'), JSON.stringify({ switches: { 'target-doc': '.agentflow/devlog.md', 'workspace-dir': '.agentflow' } }, null, 2) + '\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'init');
fs.writeFileSync(path.join(REPO, '.agentflow', 'devlog.md'), read('devlog.md'));
for (const clone of manifest.clones) {
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  git(ROOT, 'clone', '-q', '--no-local', REPO, clone); // as the runner clones
}

const HOME = path.join(ROOT, 'ccxray');
const CLAUDE = path.join(ROOT, 'claude', 'projects');
const CODEX = path.join(ROOT, 'codex', 'sessions');
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'logs', 'index.ndjson'), read('index.ndjson'));
fs.mkdirSync(path.join(CLAUDE, 'p'), { recursive: true });
fs.mkdirSync(CODEX, { recursive: true });
for (const f of fs.readdirSync(path.join(FIXTURE, 'transcripts'))) fs.writeFileSync(path.join(CLAUDE, 'p', f), read(path.join('transcripts', f)));

function report() {
  const env = { ...process.env, CCXRAY_HOME: HOME, CCXRAY_IMPORT_HOMES: CLAUDE, CCXRAY_IMPORT_CODEX_HOMES: CODEX };
  delete env.LOGS_DIR;
  return spawnSync(process.execPath, [path.join(__dirname, '../server/index.js'), 'agentflow', 'report', '--json'], { cwd: REPO, env, encoding: 'utf8', timeout: 20000 });
}

describe('agentflow report on the generated fixture (e2e)', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8'));
  const r = report();
  const out = r.status === 0 ? JSON.parse(r.stdout) : null;

  it('was generated from the pinned upstream runner', () => assert.equal(manifest.upstream.slice(0, 7), 'd0a6dd0'));

  it('runs', () => assert.equal(r.status, 0, r.stderr));

  for (const [id, want] of Object.entries(expected.asks)) {
    it(`${id}: ${want._why}`, () => {
      const a = out.asks.find(x => x.id === id);
      assert.equal(a.completeness, want.completeness);
      assert.deepEqual(a.executors.map(x => [x.kind, x.evidence, x.status, x.completeness, x.total.calls, x.labels.join(',')]), want.executors);
      if (want.unmatchedSubmissions) assert.deepEqual(a.executors.filter(x => x.kind === 'host').map(x => x.unmatchedSubmissions), want.unmatchedSubmissions);
      assert.equal(a.labels.some(l => l.startsWith('not yet imported')), false);
    });
  }

  it('counts the reused clone\'s later run as checkout unknown, and nothing else in the footer', () => {
    const f = out.footer;
    assert.deepEqual({ checkoutUnknown: f.checkoutUnknown, matchedNoNotebook: f.matchedNoNotebook, heuristicParentIgnored: f.heuristicParentIgnored }, expected.footer);
  });
});
