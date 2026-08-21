'use strict';
// Guard against the 2026-08-21 leak: CCXRAY_EXPORT_GCS_BUCKET is exported globally in the
// developer's shell so a detached hub inherits it (index.js:1108 runs flushExport() before
// pruneLogs()). An e2e that boots a full server inherited it and pushed one synthetic daily
// row to the company bucket (GCS objects 136 -> 137). CCXRAY_HOME isolates storage paths but
// NOT the bucket, and the suite has no shared env-scrub helper, so the block lives in
// flushExport itself.
//
// TWO layers, in precedence:
//   1. CCXRAY_EXPORT_DISABLE=1 — explicit; every synthetic launcher sets it.
//   2. NODE_TEST_CONTEXT — automatic net for `node --test` (what `npm test` runs).
//
// KNOWN GAP, accepted: `node test/foo.test.js` without `--test` leaves NODE_TEST_CONTEXT
// unset, and the 22 .test.js files that spawn a listening server do NOT set layer 1
// individually. Tagging all 22 was rejected: it is high-maintenance and a newly added test
// would silently miss it, which is worse than a documented gap. Normal paths (npm test, CI,
// `node --test <file>`) are covered by layer 2.
//
// A third layer that INFERRED "synthetic" from CCXRAY_HOME/LOGS_DIR being set was built and
// then deleted: ccxray-ops/scripts/deploy-stable.sh launches the real hub with
// CCXRAY_HOME="$HOME/.ccxray", so it would have disabled production exports while prune
// kept running. There is no reliable ambient signal — launchers must declare themselves.
//
// Observation point for layer 2: the guard returns BEFORE resolveCcxrayHome()/mkdirSync,
// so "the home directory was never created" proves it fired without any network call.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  flushExport, startExportSync, stopExportSync, awaitPendingFlush,
  isExportSuppressed, _setUploader,
} = require('../server/export-sync');

// Returns { root, home } where home does NOT exist yet — its creation is the signal.
// root is removed by the caller's finally (repo test-hygiene rule).
function freshHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-guard-'));
  return { root, home: path.join(root, 'home') };
}

function withEnv(fn) {
  const saved = {
    home: process.env.CCXRAY_HOME,
    bucket: process.env.CCXRAY_EXPORT_GCS_BUCKET,
    disable: process.env.CCXRAY_EXPORT_DISABLE,
    logs: process.env.LOGS_DIR,
  };
  // No test may inherit ambient suppression state; each sets what it needs.
  delete process.env.CCXRAY_EXPORT_DISABLE;
  delete process.env.LOGS_DIR;
  const restore = () => {
    for (const [k, v] of [['CCXRAY_HOME', saved.home],
                          ['CCXRAY_EXPORT_GCS_BUCKET', saved.bucket],
                          ['CCXRAY_EXPORT_DISABLE', saved.disable],
                          ['LOGS_DIR', saved.logs]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return fn(restore);
}

test('layer 2: flushExport is inert under node --test with no uploader seam', async () => {
  const { root, home } = freshHome();
  await withEnv(async (restore) => {
    try {
      process.env.CCXRAY_HOME = home;
      process.env.CCXRAY_EXPORT_GCS_BUCKET = 'should-never-be-touched';
      delete process.env.CCXRAY_EXPORT_DISABLE;
      _setUploader(null);
      assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: node --test sets NODE_TEST_CONTEXT');
      assert.strictEqual(isExportSuppressed(), true);
      await flushExport();
      assert.strictEqual(fs.existsSync(home), false,
        'flushExport must not create CCXRAY_HOME — it got past the guard');
    } finally {
      _setUploader(null); restore(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('layer 1: CCXRAY_EXPORT_DISABLE=1 suppresses even with a seam injected', async () => {
  const { root, home } = freshHome();
  await withEnv(async (restore) => {
    try {
      process.env.CCXRAY_HOME = home;
      process.env.CCXRAY_EXPORT_GCS_BUCKET = 'should-never-be-touched';
      process.env.CCXRAY_EXPORT_DISABLE = '1';
      let uploads = 0;
      _setUploader(async () => { uploads++; });
      assert.strictEqual(isExportSuppressed(), true,
        'the explicit flag must win regardless of the seam — it is what shell/perf launchers set');
      await flushExport();
      assert.strictEqual(fs.existsSync(home), false, 'explicit disable must return before any fs work');
      assert.strictEqual(uploads, 0);
    } finally {
      _setUploader(null); restore(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('an injected uploader seam still lets flushExport run (aggregation tests depend on it)', async () => {
  const { root, home } = freshHome();
  await withEnv(async (restore) => {
    try {
      process.env.CCXRAY_HOME = home;
      process.env.CCXRAY_EXPORT_GCS_BUCKET = 'seam-bucket';
      delete process.env.CCXRAY_EXPORT_DISABLE;
      let uploads = 0;
      _setUploader(async () => { uploads++; });
      assert.strictEqual(isExportSuppressed(), false);
      await flushExport();
      assert.strictEqual(fs.existsSync(home), true, 'with a seam the guard must NOT fire');
      assert.strictEqual(fs.existsSync(path.join(home, 'export-cursor.json')), true);
      assert.strictEqual(uploads, 0, 'first run is cursor-init only, so nothing uploads');
    } finally {
      _setUploader(null); restore(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// The rollout doc told users to look for "[ccxray export] exporter active"; that line did
// not exist until 2026-08-21 — startup was silent, so a mis-set env was indistinguishable
// from a working one. It must also stay silent when suppressed, or it announces an exporter
// that flushExport then refuses to run.
test('startExportSync announces itself, and stays silent when suppressed', async () => {
  const { root, home } = freshHome();
  const origLog = console.log;
  const lines = [];
  await withEnv(async (restore) => {
    try {
      // an isolated home is required: the seam branch below runs a REAL flushExport, which
      // takes the export lock and writes a cursor. Against the default home that is the
      // user's live ~/.ccxray — a fake uploader would "succeed" and advance the real cursor,
      // silently skipping data that was never actually uploaded (codex review, 2026-08-21).
      process.env.CCXRAY_HOME = home;
      process.env.CCXRAY_EXPORT_GCS_BUCKET = 'announce-bucket';
      delete process.env.CCXRAY_EXPORT_DISABLE;
      console.log = (...a) => lines.push(a.join(' '));

      _setUploader(null);                 // suppressed -> must say nothing
      startExportSync();
      stopExportSync();
      await awaitPendingFlush();
      assert.strictEqual(lines.filter(l => l.includes('exporter active')).length, 0,
        'must not announce an exporter that flushExport would refuse to run');

      lines.length = 0;
      _setUploader(async () => {});        // seam -> real startup path -> must announce
      startExportSync();
      stopExportSync();
      await awaitPendingFlush();           // settle the initial flush BEFORE clearing the seam
      const hit = lines.filter(l => l.includes('exporter active'));
      assert.strictEqual(hit.length, 1, 'exporter startup must emit exactly one positive signal');
      assert.match(hit[0], /announce-bucket/, 'the message must name the bucket it will write to');
    } finally {
      console.log = origLog;
      stopExportSync();
      await awaitPendingFlush();
      _setUploader(null); restore(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Layer 1 lives on the launchers, so its real failure mode is a launcher that forgets it.
// This asserts the known set still carries the flag: deleting it from any of them turns the
// suite red instead of leaking synthetically-generated rows to the company bucket.
test('every synthetic launcher declares CCXRAY_EXPORT_DISABLE', () => {
  const repo = path.resolve(__dirname, '..');
  const launchers = [
    'scripts/boot-smoke.sh',
    'scripts/perf/measure.js',
    'scripts/generate-screenshot-fixtures.js',
    'test/rebuild-index.browser-harness.e2e.sh',
    'docs/site/slides/coscup2026/tools/shoot-spiral.mjs',
    'CLAUDE.md',
    'docs/grok-testing.md',
    'docs/site/slides/coscup2026/README.md',
  ];
  // Look only at NON-COMMENT lines. A first version asserted merely that the file
  // contained the string, which the explanatory comments themselves satisfied — removing
  // the actual flag from boot-smoke.sh still passed. The assertion has to be about the
  // setting taking effect, not about the word appearing.
  // For shell/JS files, a non-comment line with the assignment is enough. For Markdown
  // files, the flag must appear inside a code fence — prose that DESCRIBES the flag
  // (e.g. CLAUDE.md line 58) must not satisfy the check, or removing it from the actual
  // command would go undetected (codex review, same class as the "grep catches comments"
  // bug hit three times during development).
  const setsFlag = (text, filePath) => {
    const isMd = filePath.endsWith('.md');
    if (isMd) {
      let inFence = false;
      for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('```')) { inFence = !inFence; continue; }
        if (inFence && /CCXRAY_EXPORT_DISABLE\s*[:=]\s*['"]?1/.test(line)) return true;
      }
      return false;
    }
    return text.split('\n').some((line) => {
      const t = line.trim();
      if (t.startsWith('#') || t.startsWith('//') || t.startsWith('*')) return false;
      return /CCXRAY_EXPORT_DISABLE\s*[:=]\s*['"]?1/.test(line);
    });
  };
  const missing = launchers.filter(rel => {
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs)) return false;   // moved/renamed is not this test's business
    return !setsFlag(fs.readFileSync(abs, 'utf8'), abs);
  });
  assert.deepStrictEqual(missing, [],
    'these synthetic launchers no longer neutralize exports: ' + missing.join(', '));
});
