'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CCXRAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ws-prewarm-'));
process.on('exit', () => fs.rmSync(process.env.CCXRAY_HOME, { recursive: true, force: true }));

// The prewarm map carries a Codex prewarm's effort/model to the same session's
// later turns on other WebSocket connections. It must forget idle sessions and
// refuse oversized values.
const { rememberPrewarmTurn, lookupPrewarmTurn, PREWARM_TTL_MS } = require('../server/ws-proxy');

describe('Codex prewarm session map', () => {
  it('forgets a session idle longer than the TTL', () => {
    rememberPrewarmTurn('idle-sess', { effort: 'low', model: 'gpt-6-sol' }, 1_000);
    assert.equal(lookupPrewarmTurn('idle-sess', 1_000 + PREWARM_TTL_MS + 1), null);
    assert.equal(lookupPrewarmTurn('idle-sess', 1_000), null, 'an expired entry is removed, not just hidden');
  });

  it('keeps an actively used session alive past the TTL (sliding)', () => {
    rememberPrewarmTurn('busy-sess', { effort: 'high', model: 'gpt-6-sol' }, 0);
    const half = Math.floor(PREWARM_TTL_MS / 2);
    assert.equal(lookupPrewarmTurn('busy-sess', half)?.effort, 'high');
    assert.equal(lookupPrewarmTurn('busy-sess', half + PREWARM_TTL_MS - 1)?.effort, 'high');
  });

  it('does not store an oversized effort or model', () => {
    rememberPrewarmTurn('big-sess', { effort: 'x'.repeat(129), model: 'm'.repeat(129) }, 0);
    const hit = lookupPrewarmTurn('big-sess', 0);
    assert.equal(hit?.effort, null);
    assert.equal(hit?.model, null);
    rememberPrewarmTurn('ok-sess', { effort: 'e'.repeat(128), model: 'gpt-6-sol' }, 0);
    assert.equal(lookupPrewarmTurn('ok-sess', 0)?.effort.length, 128);
  });
});
