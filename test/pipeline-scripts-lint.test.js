'use strict';

// Meta-lint for scripts/pipeline/*.sh — 擋整類 footgun：
//   1. bash -n 語法檢查
//   2. 可執行 + shebang
//   3. `$var` 緊接非 ASCII（CJK）→ set -u 下會炸未綁定變數，必須 ${var}
// 這些 script 註解/訊息都是正體中文，第 3 類特別容易踩到。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'scripts', 'pipeline');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sh'));

describe('pipeline scripts lint', () => {
  it('has scripts to lint', () => assert.ok(files.length >= 6));

  for (const f of files) {
    const p = path.join(DIR, f);

    it(`${f}: bash -n syntax ok`, () => {
      const r = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    });

    it(`${f}: no bare $var immediately before non-ASCII (needs \${var})`, () => {
      const src = fs.readFileSync(p, 'utf8');
      // 逐行掃描，回報行號
      const bad = [];
      src.split('\n').forEach((line, i) => {
        if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) bad.push(i + 1);
      });
      assert.deepEqual(bad, [], `bare $var before non-ASCII at lines ${bad.join(',')}`);
    });
  }

  // _common.sh 是 source-only，其餘皆須可執行 + shebang
  for (const f of files.filter((x) => x !== '_common.sh')) {
    const p = path.join(DIR, f);
    it(`${f}: executable + shebang`, () => {
      assert.match(fs.readFileSync(p, 'utf8').split('\n')[0], /^#!/);
      assert.ok(fs.statSync(p).mode & 0o111, 'not executable');
    });
  }
});
