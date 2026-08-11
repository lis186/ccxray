'use strict';

// Runs `scripts/weather-replay.js --golden` in CI so the gate instrument's
// acceptance is a regression test rather than a command someone remembers to type.
// The golden checks the script's three reported statistics against a synthetic
// fixture whose expected numbers were hand-counted before the implementation
// existed (docs/verification-principles.md), including the #509 case where a
// capable Bash call with no recorded result must render ❔ instead of sunny.
//
// Hermetic: --golden measures an in-memory fixture and never opens an index, but
// the env is isolated anyway — the script requires server/store → config, and a
// leaked LOGS_DIR/CCXRAY_HOME would point that at the developer's real logs
// (the ADR 0015 R4 lesson).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'weather-replay.js');

function isolatedEnv(home) {
  const env = { ...process.env, HOME: home, CCXRAY_HOME: home };
  delete env.LOGS_DIR;
  return env;
}

describe('weather-replay --golden', () => {
  it('reproduces the hand-counted gate numbers exactly', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccxray-replay-golden-'));
    try {
      const { code, stdout, stderr } = await new Promise(resolve => {
        execFile(process.execPath, [SCRIPT, '--golden'], { env: isolatedEnv(home), timeout: 60000 },
          (err, out, errOut) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: out, stderr: errOut }));
      });
      assert.equal(code, 0, `golden self-check failed:\n${stdout}\n${stderr}`);
      assert.match(stdout, /all checks passed/);
      // Guard against a vacuous pass: the fixture must actually exercise every
      // reported statistic under both dedup semantics and all three provider filters.
      for (const key of ['all.merged.falseSunny', 'all.firstSeen.falseSunny',
        'all.merged.escalatedToQuestionMark', 'all.merged.capable',
        'all.merged.prong1', 'all.merged.prong2', 'all.merged.dist.p90',
        'anthropic.merged.capable', 'openai.merged.capable']) {
        assert.ok(stdout.includes(key), `golden did not check ${key}`);
      }
      assert.doesNotMatch(stdout, /FAIL/);
      // The script must not have written into the isolated home.
      assert.deepEqual(await fsp.readdir(home), [], 'golden wrote files — it must be read-only');
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});
