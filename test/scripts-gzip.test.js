'use strict';

// #776 (codex r1): maintenance/eval scripts read log and shared files off disk, so they
// must sniff gzip. Hermetic: synthetic temp dirs only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { discoverDeltaChain } = require('../scripts/perf/measure');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-scripts-gz-'));

describe('scripts sniff gzip (#776)', () => {
  it('agent-classify-eval counts mixed plain + gzip shared files', () => {
    const home = tmp();
    try {
      const shared = path.join(home, '.ccxray', 'logs', 'shared');
      fs.mkdirSync(shared, { recursive: true });
      const sys = JSON.stringify([{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }]);
      fs.writeFileSync(path.join(shared, 'sys_aaaaaaaaaaaa.json'), sys);
      fs.writeFileSync(path.join(shared, 'sys_bbbbbbbbbbbb.json'), zlib.gzipSync(sys));
      const out = execFileSync(process.execPath, ['scripts/agent-classify-eval.js'], {
        cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      const confusion = out.split('=== Confusion (truth → pred) ===')[1].split('===')[0];
      const counted = [...confusion.matchAll(/(\d+)\s*$/gm)].reduce((n, m) => n + Number(m[1]), 0);
      assert.equal(counted, 2, `both files classified; got:\n${out}`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('perf measure discovers a delta chain through gzip _req files', async () => {
    const dir = tmp();
    try {
      const put = (id, obj, gz) => {
        const t = JSON.stringify(obj);
        fs.writeFileSync(path.join(dir, id + '_req.json'), gz ? zlib.gzipSync(t) : t);
      };
      put('a', { model: 'm', messages: [] }, true);
      put('b', { model: 'm', prevId: 'a', msgOffset: 1, messages: [] }, true);
      put('c', { model: 'm', prevId: 'b', msgOffset: 2, messages: [] }, false); // mixed
      const r = await discoverDeltaChain(dir, ['a', 'b', 'c'].map(id => JSON.stringify({ id })));
      assert.equal(r.method, 'discovered');
      assert.deepEqual(r.deltaChainIds, ['a', 'b', 'c']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
