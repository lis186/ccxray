'use strict';

// #776: transparent gzip log storage + one-way `ccxray migrate-logs`.
// Hermetic: every test builds its own temp logs dir with synthetic content.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { createLocalStorage } = require('../server/storage/local');
const { isGzip } = require('../server/storage/gzip');
const { migrateLogs } = require('../server/migrate-logs');

const OLD = new Date('2026-01-01T00:00:00Z'); // well past the 10-minute floor
const ID = (n) => `2026-01-01T00-00-00-${String(n).padStart(3, '0')}`;

// Compressible synthetic bodies: a full turn, a delta turn, an edited turn with
// its received sidecar, an OpenAI-shaped turn, and shared files.
const body = (extra = {}) => JSON.stringify({
  model: 'm', max_tokens: 100,
  messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'synthetic text '.repeat(20) + i })),
  ...extra,
});

let dir, storage, savedFlag;
beforeEach(async () => {
  savedFlag = process.env.CCXRAY_COMPRESS_DISABLE;
  delete process.env.CCXRAY_COMPRESS_DISABLE;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-compress-'));
  storage = createLocalStorage(dir);
  await storage.init();
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.CCXRAY_COMPRESS_DISABLE; else process.env.CCXRAY_COMPRESS_DISABLE = savedFlag;
  fs.rmSync(dir, { recursive: true, force: true });
});

const raw = (name, shared) => fs.readFileSync(path.join(dir, shared ? 'shared' : '.', name));
const age = (file, when = OLD) => fs.utimesSync(file, when, when);

describe('storage adapter: gzip round-trip (#776)', () => {
  it('writes gzip by default for every artifact kind and reads it back unchanged', async () => {
    const text = body();
    for (const suffix of ['_req.json', '_res.json', '_req.received.json']) {
      await storage.write(ID(1), suffix, text);
      assert.ok(isGzip(raw(ID(1) + suffix)), `${suffix} is gzip on disk`);
      assert.equal(await storage.read(ID(1), suffix), text);
    }
    await storage.writeSharedIfAbsent('sys_abc.json', text);
    assert.ok(isGzip(raw('sys_abc.json', true)));
    assert.equal(await storage.readShared('sys_abc.json'), text);
  });

  it('keeps filenames unchanged', async () => {
    await storage.write(ID(1), '_req.json', body());
    assert.ok((await storage.list()).includes(ID(1) + '_req.json'));
  });

  it('CCXRAY_COMPRESS_DISABLE=1 writes plain JSON (and shared too)', async () => {
    process.env.CCXRAY_COMPRESS_DISABLE = '1';
    const text = body();
    await storage.write(ID(1), '_req.json', text);
    await storage.writeSharedIfAbsent('tools_x.json', text);
    assert.equal(raw(ID(1) + '_req.json').toString('utf8'), text);
    assert.equal(raw('tools_x.json', true).toString('utf8'), text);
    assert.equal(await storage.read(ID(1), '_req.json'), text);
  });

  it('reads plain files written by an older build', async () => {
    fs.writeFileSync(path.join(dir, ID(2) + '_res.json'), '[{"type":"x"}]');
    fs.writeFileSync(path.join(dir, 'shared', 'sys_old.json'), '"legacy"');
    assert.equal(await storage.read(ID(2), '_res.json'), '[{"type":"x"}]');
    assert.equal(await storage.readShared('sys_old.json'), '"legacy"');
  });

  it('preserves non-ASCII text exactly', async () => {
    const text = JSON.stringify({ t: '繁體中文 ✓ 😀' });
    await storage.write(ID(1), '_req.json', text);
    assert.equal(await storage.read(ID(1), '_req.json'), text);
  });

  it('writeSharedIfAbsent stays idempotent for compressed files', async () => {
    await storage.writeSharedIfAbsent('sys_i.json', '"first"');
    await storage.writeSharedIfAbsent('sys_i.json', '"second"');
    assert.equal(await storage.readShared('sys_i.json'), '"first"');
  });

  it('an old build cannot parse a gzip file (fail-safe, D1)', async () => {
    await storage.write(ID(1), '_req.json', body());
    assert.throws(() => JSON.parse(raw(ID(1) + '_req.json').toString('utf8')));
  });
});

// A legacy home: plain files for every kind the issue lists.
function legacyHome() {
  const files = {};
  const put = (name, text, shared) => {
    const p = path.join(dir, shared ? 'shared' : '.', name);
    fs.writeFileSync(p, text); age(p); files[p] = Buffer.from(text);
  };
  put(ID(1) + '_req.json', body());                                           // full
  put(ID(2) + '_req.json', body({ prevId: ID(1), msgOffset: 2, messages: [{ role: 'user', content: 'd'.repeat(500) }] })); // delta
  put(ID(3) + '_req.json', body({ edited: true }));                           // edited
  put(ID(3) + '_req.received.json', body());                                  // …with its received sidecar
  put(ID(4) + '_req.json', JSON.stringify({ model: 'gpt-5', input: Array(30).fill({ type: 'message', content: 'o'.repeat(80) }) })); // OpenAI
  put(ID(1) + '_res.json', JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ type: 'content_block_delta', data: { i, text: 'tok '.repeat(10) } }))));
  put('sys_aaaaaaaaaaaa.json', JSON.stringify([{ type: 'text', text: 'system prompt '.repeat(200) }]), true);
  put('tools_bbbbbbbbbbbb.json', JSON.stringify(Array(8).fill({ name: 't', description: 'd'.repeat(300) })), true);
  put('openai_instructions_cccccccccccc.json', JSON.stringify('instr '.repeat(300)), true);
  return files;
}

const quiet = { log: () => {} };

describe('migrate-logs (#776)', () => {
  it('--apply converts every kind and each file decompresses byte-identical', async () => {
    const files = legacyHome();
    const r = await migrateLogs({ apply: true, storage, ...quiet });
    assert.equal(r.converted, Object.keys(files).length);
    assert.equal(r.failed, 0);
    for (const [p, original] of Object.entries(files)) {
      const now = fs.readFileSync(p);
      assert.ok(isGzip(now), `${path.basename(p)} is gzip`);
      assert.ok(zlib.gunzipSync(now).equals(original), `${path.basename(p)} byte-identical`);
    }
    assert.ok(r.bytesAfter < r.bytesBefore);
    // …and the storage layer reads them transparently.
    assert.equal(await storage.read(ID(3), '_req.received.json'), files[path.join(dir, ID(3) + '_req.received.json')].toString());
    assert.equal(await storage.readShared('sys_aaaaaaaaaaaa.json'), files[path.join(dir, 'shared', 'sys_aaaaaaaaaaaa.json')].toString());
  });

  it('dry-run writes nothing and projects savings', async () => {
    const files = legacyHome();
    const before = fs.readdirSync(dir).sort();
    const r = await migrateLogs({ apply: false, storage, ...quiet });
    for (const [p, original] of Object.entries(files)) assert.ok(fs.readFileSync(p).equals(original));
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    assert.equal(r.converted, Object.keys(files).length);
    assert.ok(r.projectedAfter < r.projectedBefore && r.projectedBefore > 0);
    assert.equal(r.bytesAfter, 0);
  });

  it('is resumable: an interrupted run (stale tmp, mixed formats) finishes on re-run', async () => {
    const files = legacyHome();
    // Interrupted state: one file already converted, one stale tmp from a crash.
    const done = path.join(dir, ID(1) + '_req.json');
    fs.writeFileSync(done, zlib.gzipSync(files[done])); age(done);
    fs.writeFileSync(path.join(dir, ID(2) + '_req.json') + '.migrate-tmp', 'partial');
    const r = await migrateLogs({ apply: true, storage, ...quiet });
    assert.equal(r.skippedGzip, 1);
    assert.equal(r.failed, 0);
    assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.migrate-tmp')).length, 0, 'stale tmp removed');
    for (const [p, original] of Object.entries(files)) assert.ok(zlib.gunzipSync(fs.readFileSync(p)).equals(original));
    const again = await migrateLogs({ apply: true, storage, ...quiet });
    assert.equal(again.converted, 0);
    assert.equal(again.skippedGzip, Object.keys(files).length);
  });

  it('pauses when free space < reserve + 2 × file size, largest file first, and resumes later', async () => {
    const files = legacyHome();
    const sizes = Object.entries(files).map(([p, b]) => [p, b.length]).sort((a, b) => b[1] - a[1]);
    const [biggest, biggestSize] = sizes[0];
    const calls = [];
    const r = await migrateLogs({
      apply: true, storage, ...quiet, reserveBytes: 1000,
      freeBytes: () => { calls.push(1); return calls.length === 1 ? 1000 + 2 * biggestSize : 1000 + 2 * sizes[1][1] - 1; },
    });
    assert.equal(r.converted, 1, 'only the largest file fit');
    assert.equal(r.paused, true);
    assert.ok(isGzip(fs.readFileSync(biggest)), 'largest-first');
    for (const [p] of sizes.slice(1)) assert.ok(!isGzip(fs.readFileSync(p)), 'rest untouched');
    const resumed = await migrateLogs({ apply: true, storage, ...quiet, freeBytes: () => Infinity });
    assert.equal(resumed.paused, false);
    for (const [p, original] of Object.entries(files)) assert.ok(zlib.gunzipSync(fs.readFileSync(p)).equals(original));
  });

  it('skips files younger than 10 minutes', async () => {
    const young = path.join(dir, ID(9) + '_req.json');
    fs.writeFileSync(young, body()); // mtime = now
    const r = await migrateLogs({ apply: true, storage, ...quiet });
    assert.equal(r.skippedYoung, 1);
    assert.equal(r.converted, 0);
    assert.ok(!isGzip(fs.readFileSync(young)));
  });

  it('leaves a file alone when it changes mid-run (CAS), and never resurrects a deleted one', async () => {
    const a = path.join(dir, ID(1) + '_req.json'), b = path.join(dir, ID(2) + '_req.json');
    fs.writeFileSync(a, body()); age(a);
    fs.writeFileSync(b, body({ x: 1 })); age(b);
    // Hook the free-space probe (runs before each file) to mutate/delete the files
    // that have not been processed yet: lstat already recorded their fingerprint.
    const sizeA = fs.statSync(a).size, sizeB = fs.statSync(b).size;
    const first = sizeA >= sizeB ? a : b, second = first === a ? b : a;
    let n = 0;
    const r = await migrateLogs({
      apply: true, storage, ...quiet,
      freeBytes: () => { if (++n === 2) fs.rmSync(second); return Infinity; },
    });
    assert.ok(isGzip(fs.readFileSync(first)));
    assert.ok(!fs.existsSync(second), 'deleted file not resurrected');
    assert.equal(r.failed, 1); // the read of the vanished file fails and is counted, not fatal
    assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('.migrate-tmp')).length, 0);
  });

  it('keeps mtime (shared "first seen" date) and mode', async () => {
    const p = path.join(dir, 'shared', 'sys_dddddddddddd.json');
    fs.writeFileSync(p, JSON.stringify('s'.repeat(2000)), { mode: 0o600 }); age(p);
    await migrateLogs({ apply: true, storage, ...quiet });
    const st = fs.statSync(p);
    assert.equal(st.mtimeMs, OLD.getTime());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal((await storage.statShared('sys_dddddddddddd.json')).mtime.toISOString(), OLD.toISOString());
  });

  it('does not convert a file that gzip would not shrink', async () => {
    const p = path.join(dir, ID(7) + '_res.json');
    fs.writeFileSync(p, '[]'); age(p);
    const r = await migrateLogs({ apply: true, storage, ...quiet });
    assert.equal(r.skippedNoGain, 1);
    assert.equal(fs.readFileSync(p, 'utf8'), '[]');
  });

  it('refuses while another maintenance command holds the lock', async () => {
    fs.writeFileSync(path.join(dir, '.index-maintenance.lock'), JSON.stringify({ pid: process.pid, token: 't', op: 'rebuild-index' }));
    const r = await migrateLogs({ apply: true, storage, ...quiet });
    assert.equal(r.refused, true);
    assert.equal(r.reason, 'maintenance-locked');
    fs.rmSync(path.join(dir, '.index-maintenance.lock'));
  });

  it('releases the maintenance lock when done', async () => {
    legacyHome();
    await migrateLogs({ apply: true, storage, ...quiet });
    assert.ok(!fs.existsSync(path.join(dir, '.index-maintenance.lock')));
  });
});

describe('ccxray migrate-logs CLI (#776)', () => {
  const run = (home, ...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['server/index.js', 'migrate-logs', ...args], {
        cwd: path.join(__dirname, '..'), timeout: 15000, encoding: 'utf8',
        env: { ...process.env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: path.join(home, 'logs') },
      }) };
    } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
  };

  it('defaults to dry-run, --apply converts, both flags together are rejected', () => {
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const f = path.join(logs, ID(1) + '_req.json');
    fs.writeFileSync(f, body()); age(f);
    const original = fs.readFileSync(f);

    const dry = run(dir);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /Would convert 1 file/);
    assert.ok(fs.readFileSync(f).equals(original));

    assert.equal(run(dir, '--dry-run', '--apply').code, 1);

    const applied = run(dir, '--apply');
    assert.equal(applied.code, 0, applied.out);
    assert.match(applied.out, /Converted 1 file/);
    assert.ok(zlib.gunzipSync(fs.readFileSync(f)).equals(original));
  });
});

describe('npm packaging (#776)', () => {
  it('ships migrate-logs under server/ (listed in package.json files)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(pkg.files.includes('server/'));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'server', 'migrate-logs.js')));
  });
});
