'use strict';

// #345: index.ndjson can exceed Node's ~512MB single-string limit (0x1fffffe8).
// readIndex() (readFile utf8) then throws ERR_STRING_TOO_LONG, which broke
// restore / cold-load / import / rebuild-index. readIndexLines() streams and
// must handle any size. These tests lock both the small-file behavior and the
// large-file fail-on-old proof.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createLocalStorage } = require('../server/storage/local');

const STRING_LIMIT = 0x1fffffe8; // ~536.87 MB — Node's max single-string length

async function collect(iter) {
  const out = [];
  for await (const line of iter) out.push(line);
  return out;
}

describe('readIndexLines: behavior', () => {
  let dir, storage;
  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ccxray-idxlines-'));
    storage = createLocalStorage(dir);
    await storage.init();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('missing index → empty iteration', async () => {
    assert.deepEqual(await collect(storage.readIndexLines()), []);
  });

  it('yields non-blank lines in file order, skipping blanks', async () => {
    fs.writeFileSync(path.join(dir, 'index.ndjson'), 'a\n\nb\n\n\nc\n');
    assert.deepEqual(await collect(storage.readIndexLines()), ['a', 'b', 'c']);
  });

  it('handles a final line with no trailing newline', async () => {
    fs.writeFileSync(path.join(dir, 'index.ndjson'), 'x\ny\nz');
    assert.deepEqual(await collect(storage.readIndexLines()), ['x', 'y', 'z']);
  });
});

describe('readIndexLines: > 512MB (fail-on-old)', () => {
  let dir, storage, indexPath, wrote = false, totalLines = 0;

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ccxray-idxbig-'));
    storage = createLocalStorage(dir);
    await storage.init();
    indexPath = path.join(dir, 'index.ndjson');

    // Build a ~4MB chunk of valid NDJSON, write it enough times to pass the
    // single-string limit by ~8MB. Padded lines keep the line count modest.
    let chunk = '', chunkLines = 0;
    for (let i = 0; i < 4000; i++) {
      chunk += JSON.stringify({
        id: `2020-01-01T00-00-00-${String(i).padStart(6, '0')}`,
        sessionId: 'sBIG', pad: 'x'.repeat(900),
      }) + '\n';
      chunkLines++;
    }
    const chunkBytes = Buffer.byteLength(chunk);
    const repeats = Math.ceil((STRING_LIMIT + 8 * 1024 * 1024) / chunkBytes);
    totalLines = chunkLines * repeats;

    try {
      const ws = fs.createWriteStream(indexPath);
      await new Promise((resolve, reject) => {
        ws.on('error', reject);
        let r = 0;
        (function pump() {
          while (r < repeats) {
            const ok = ws.write(chunk);
            r++;
            if (!ok) { ws.once('drain', pump); return; }
          }
          ws.end(resolve);
        })();
      });
      wrote = fs.statSync(indexPath).size > STRING_LIMIT;
    } catch {
      wrote = false; // constrained env (ENOSPC / EFBIG) → tests skip
    }
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('readIndex() throws ERR_STRING_TOO_LONG (the pre-fix failure)', async (t) => {
    if (!wrote) return t.skip('could not create a >512MB index in this environment');
    // readFileSync throws code ERR_STRING_TOO_LONG ("Cannot create a string
    // longer than…"); async readFile throws a bare V8 RangeError ("Invalid
    // string length") with no .code. Either proves the single-string read fails.
    await assert.rejects(
      () => storage.readIndex(),
      (err) => /ERR_STRING_TOO_LONG|string longer than|invalid string length/i.test(`${err.code || ''} ${err.message || ''}`),
      'reading a >512MB index into one string must throw',
    );
  });

  it('readIndexLines() streams every line past the 512MB ceiling', async (t) => {
    if (!wrote) return t.skip('could not create a >512MB index in this environment');
    let count = 0;
    for await (const line of storage.readIndexLines()) {
      if (line) count++;
    }
    assert.equal(count, totalLines, 'streaming reads all lines regardless of total size');
  });
});
