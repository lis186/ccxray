'use strict';

// #776 (codex r1): SIGTERM while the compressor is slow must not leave an indexed
// entry without its payload files. gracefulExit has a 5s deadline; the compressor is
// held for 9s, so only the shutdown flip to plain writes can land the files in time.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startProxy, slowGzipEnv } = require('./helpers/proxy-fixture');
const { readLogJson } = require('./helpers/read-log');

let fx;
afterEach(async () => { if (fx) await fx.stop(); fx = null; });

const indexIds = (logs) => {
  try {
    return fs.readFileSync(path.join(logs, 'index.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id);
  } catch { return []; }
};

describe('graceful shutdown with a slow compressor (#776)', () => {
  it('every indexed entry has parseable _req/_res files after SIGTERM', async () => {
    fx = await startProxy({ env: slowGzipEnv(9000, '') });
    const N = 5;
    for (let i = 0; i < N; i++) {
      const status = await fx.post({ model: 'claude-sonnet-4-6', max_tokens: 5, messages: [{ role: 'user', content: 'hello ' + i }] });
      assert.equal(status, 200);
    }
    let ids = [];
    for (let i = 0; i < 100 && ids.length < N; i++) { ids = indexIds(fx.logs); if (ids.length < N) await new Promise(r => setTimeout(r, 50)); }
    assert.equal(ids.length, N, 'all entries indexed while their payload writes are still compressing');

    fx.child.kill('SIGTERM');
    await Promise.race([fx.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('server did not exit')), 15000))]);

    for (const id of ids) {
      for (const suffix of ['_req.json', '_res.json']) {
        const file = path.join(fx.logs, id + suffix);
        assert.ok(fs.existsSync(file), `${id}${suffix} exists`);
        assert.ok(await readLogJson(file, 200), `${id}${suffix} parses`);
      }
    }
  });
});
