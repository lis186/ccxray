'use strict';

// #563 — the statusline consent prompt: timing, disclosure, and defaults.
//
// Three behaviors, each verified end-to-end through a real `ccxray --port N
// claude` boot under a pty (the prompt is TTY-gated):
//   1. A Herdr-launched pane never blocks on the prompt — the agent starts,
//      the one-line hint replaces the question, and the declined marker is
//      NOT written (a later direct launch still gets to answer).
//   2. With no statusline configured (pure addition), the default is Yes —
//      plain Enter installs the adapter.
//   3. With an existing custom statusline (wrapping), the default stays No —
//      plain Enter declines and the user's settings.json is left untouched.
//
// Isolation (docs/testing.md): throwaway HOME/CCXRAY_HOME/CLAUDE_CONFIG_DIR,
// CCXRAY_IMPORT_HOMES pinned empty, CCXRAY_PRICING_CACHE pointed at a
// nonexistent path, fake `claude` binary on PATH. The pty comes from
// script(1) with the platform branch from #556 (BSD vs util-linux argv).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');
const NO_TRANSCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-slp-empty-'));

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

function makeScenario({ claudeSettings = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-slp-home-'));
  const claudeHome = path.join(home, 'claude-config');
  fs.mkdirSync(claudeHome, { recursive: true });
  if (claudeSettings) fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify(claudeSettings));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const capture = path.join(home, 'claude-ran');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho ran > ${JSON.stringify(capture)}\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  return { home, claudeHome, bin, capture };
}

// Boot `ccxray --port N claude` under a pty, feed `input` on stdin, wait for
// the fake claude to have run (or the budget to expire), then reap.
async function runLaunch(sc, { input, env = {} }) {
  const port = await findFreePort();
  const out = path.join(sc.home, 'out.log');
  const envParts = Object.entries({
    HOME: sc.home,
    CCXRAY_HOME: path.join(sc.home, '.ccxray'),
    CLAUDE_CONFIG_DIR: sc.claudeHome,
    CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
    CCXRAY_PRICING_CACHE: '/nonexistent/pricing.json',
    BROWSER: 'none',
    PATH: `${sc.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...env,
  }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  const inner = `env ${envParts} ${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER_SCRIPT)} --port ${port} --no-browser claude`;
  // BSD script (macOS) takes the command positionally; util-linux needs -c (#556).
  const pty = process.platform === 'linux'
    ? `script -qec ${JSON.stringify(inner)} /dev/null`
    : `script -q /dev/null /bin/sh -c ${JSON.stringify(inner)}`;
  // Full-server-boot budget: 45s (#538/#542 precedent), enforced here in the
  // poll loop — never as an outer tool timeout.
  const command = `{ ( printf ${JSON.stringify(input)}; sleep 40 ) | ${pty}; } > ${JSON.stringify(out)} 2>&1 &\n`
    + `for i in $(seq 1 220); do [ -f ${JSON.stringify(sc.capture)} ] && break; sleep 0.2; done\n`
    + `sleep 1\n`
    + `[ -f ${JSON.stringify(sc.capture)} ] && echo CLAUDE_RAN || echo CLAUDE_NOT_RUN\n`
    + `pkill -f "server/index.js --port ${port}" 2>/dev/null; true`;
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 60000 });
  let log = '';
  try { log = fs.readFileSync(out, 'utf8'); } catch {}
  return { marker: result.stdout.trim(), log, declined: fs.existsSync(path.join(sc.home, '.ccxray', '.statusline-declined')) };
}

function readSettings(sc) {
  try { return JSON.parse(fs.readFileSync(path.join(sc.claudeHome, 'settings.json'), 'utf8')); } catch { return {}; }
}

describe('#563 statusline consent prompt', () => {
  it('never blocks a Herdr-launched pane — hint instead of question, no declined marker', async () => {
    const sc = makeScenario();
    // No stdin answer on purpose: the old code would sit on the question forever.
    const r = await runLaunch(sc, { input: '', env: { CCXRAY_AGENT_ID: 'herdr:w1:p1' } });
    assert.match(r.marker, /CLAUDE_RAN/, `agent must start without an answer; log:\n${r.log}`);
    assert.doesNotMatch(r.log, /\[y\/N\]|\[Y\/n\]/, 'no interactive question in a Herdr pane');
    assert.match(r.log, /setup-statusline/, 'the one-line hint replaces the question');
    assert.equal(r.declined, false, 'skipping must not forge a decline');
    assert.equal(readSettings(sc).statusLine, undefined, 'nothing installed');
  });

  it('defaults to Yes when no statusline is configured — Enter installs the adapter', async () => {
    const sc = makeScenario();
    const r = await runLaunch(sc, { input: '\\n' });
    assert.match(r.marker, /CLAUDE_RAN/, r.log);
    assert.match(r.log, /\[Y\/n\]/, 'pure addition advertises Yes as default');
    assert.match(r.log, /settings\.json/, 'prompt discloses what it writes');
    assert.match(r.log, /restored on removal/, 'prompt discloses reversibility');
    const st = readSettings(sc).statusLine;
    assert.ok(st && st.command.includes('claude-adapter'), 'Enter installs the adapter');
    assert.equal(r.declined, false);
  });

  it('defaults to No when wrapping an existing statusline — Enter declines, settings untouched', async () => {
    const sc = makeScenario({ claudeSettings: { statusLine: { command: 'echo my-custom-line' } } });
    const r = await runLaunch(sc, { input: '\\n' });
    assert.match(r.marker, /CLAUDE_RAN/, r.log);
    assert.match(r.log, /\[y\/N\]/, 'wrapping keeps No as default');
    assert.match(r.log, /delegated, not replaced/, 'prompt discloses the wrap semantics');
    const st = readSettings(sc).statusLine;
    assert.equal(st.command, 'echo my-custom-line', 'existing statusline untouched');
    assert.equal(st._ccxrayDelegate, undefined, 'no delegation installed');
    assert.equal(r.declined, true, 'Enter records the decline');
  });
});
