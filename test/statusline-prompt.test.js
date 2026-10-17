'use strict';

// #563 — the statusline consent prompt: timing, disclosure, and defaults.
//
// Behaviors are verified end-to-end through a real `ccxray --port N claude`
// boot with controlled terminal modes: PTY-backed interactive/print launches
// and a redirected-stdout launch with TTY stdin.
//   1. A Herdr-launched pane never blocks on the prompt — the agent starts,
//      the one-line hint replaces the question, and the declined marker is
//      NOT written (a later direct launch still gets to answer).
//   2. With no statusline configured (pure addition), the default is Yes —
//      plain Enter installs the adapter.
//   3. With an existing custom statusline (wrapping), the default stays No —
//      plain Enter declines and the user's settings.json is left untouched.
//
// Isolation (docs/testing.md): throwaway HOME/CCXRAY_HOME/CLAUDE_CONFIG_DIR,
// CCXRAY_IMPORT_HOMES pinned empty, CCXRAY_PRICING_CACHE pointed at a fresh
// synthetic cache, fake `claude` binary on PATH. The pty comes from
// script(1) with the platform branch from #556 (BSD vs util-linux argv).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');
const NO_TRANSCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-slp-empty-'));
const SCENARIO_DIRS = [];

after(() => {
  for (const d of [...SCENARIO_DIRS, NO_TRANSCRIPTS]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

function makeScenario({ claudeSettings = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-slp-home-'));
  SCENARIO_DIRS.push(home);
  fs.writeFileSync(path.join(home, 'pricing-cache.json'), JSON.stringify({
    fetchedAt: Date.now(),
    pricing: {},
    context: {},
  }));
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

// Boot `ccxray --port N claude` with the requested terminal shape, feed
// `input` when using a pty, wait for fake claude (or the budget), then reap.
async function runLaunch(sc, {
  input = '', agentArgs = [], env = {}, stdoutIsTTY = true,
  abortOnPrompt = false, budgetMs = 45000,
} = {}) {
  const port = await findFreePort();
  const out = path.join(sc.home, 'out.log');
  const feederPidFile = path.join(sc.home, 'stdin-feeder.pid');
  const serverPidFile = path.join(sc.home, 'server.pid');
  const preloadPath = path.join(sc.home, 'server-preload.js');
  const preloadLines = [`require('fs').writeFileSync(${JSON.stringify(serverPidFile)}, String(process.pid));`];
  if (!stdoutIsTTY) {
    // Use actual redirected stdout and simulate only the user's TTY stdin.
    preloadLines.push("Object.defineProperty(process.stdin, 'isTTY', { value: true });");
  }
  fs.writeFileSync(preloadPath, `${preloadLines.join('\n')}\n`);
  const preload = `--require ${JSON.stringify(preloadPath)} `;
  const envParts = Object.entries({
    HOME: sc.home,
    CCXRAY_HOME: path.join(sc.home, '.ccxray'),
    CLAUDE_CONFIG_DIR: sc.claudeHome,
    CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
    CCXRAY_IMPORT_DISABLE: '1',
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_PRICING_CACHE: path.join(sc.home, 'pricing-cache.json'),
    BROWSER: 'none',
    // Pinned empty: an ambient herdr:* id (suite run from a Herdr pane) would
    // silently skip the prompt in the non-Herdr scenarios — the docs/testing.md
    // §1b leak class (grok review P2). The Herdr test overrides it.
    CCXRAY_AGENT_ID: '',
    PATH: `${sc.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...env,
  }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  const quotedAgentArgs = agentArgs.map(arg => JSON.stringify(arg)).join(' ');
  const inner = `env -u ANTHROPIC_BASE_URL -u CCXRAY_HUB_CLIENT_PID ${envParts} `
    + `${JSON.stringify(process.execPath)} ${preload}${JSON.stringify(SERVER_SCRIPT)} --port ${port} --no-browser claude`
    + (quotedAgentArgs ? ` ${quotedAgentArgs}` : '');
  // BSD script (macOS) takes the command positionally; util-linux needs -c (#556).
  const pty = process.platform === 'linux'
    ? `script -qec ${JSON.stringify(inner)} /dev/null`
    : `script -q /dev/null /bin/sh -c ${JSON.stringify(inner)}`;
  // Keep script's input pipe open while the server boots. The feeder sleep is
  // terminated after the launch/question observation. The launch budget is
  // enforced in the poll loop, never as an outer timeout.
  const pollCount = Math.ceil(budgetMs / 200);
  const promptCheck = abortOnPrompt
    ? `grep -q 'Track Claude subscription limits' ${JSON.stringify(out)} 2>/dev/null && break; `
    : '';
  const launch = stdoutIsTTY
    ? `( printf ${JSON.stringify(input)}; sleep 60 & echo $! > ${JSON.stringify(feederPidFile)}; wait ) | ${pty} > ${JSON.stringify(out)} 2>&1 & pty_pid=$!\n`
    : `${inner} < /dev/null > ${JSON.stringify(out)} 2>&1 & direct_pid=$!\n`;
  const cleanup = stdoutIsTTY
    ? `if [ -f ${JSON.stringify(feederPidFile)} ]; then read feeder_pid < ${JSON.stringify(feederPidFile)}; kill "$feeder_pid" 2>/dev/null; fi\n`
      + `kill "$pty_pid" 2>/dev/null; wait "$pty_pid" 2>/dev/null; true`
    : `kill "$direct_pid" 2>/dev/null; wait "$direct_pid" 2>/dev/null; true`;
  const command = launch
    + `for i in $(seq 1 ${pollCount}); do [ -f ${JSON.stringify(sc.capture)} ] && break; ${promptCheck}sleep 0.2; done\n`
    + `sleep 1\n`
    + `[ -f ${JSON.stringify(sc.capture)} ] && echo CLAUDE_RAN || echo CLAUDE_NOT_RUN\n`
    + `if [ -f ${JSON.stringify(serverPidFile)} ]; then read server_pid < ${JSON.stringify(serverPidFile)}; kill "$server_pid" 2>/dev/null; fi\n`
    + cleanup;
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

  for (const flag of ['-p', '--print']) {
    it(`skips consent in print mode (${flag}) — launch proceeds without changes`, async () => {
      const sc = makeScenario();
      const settingsPath = path.join(sc.claudeHome, 'settings.json');
      const r = await runLaunch(sc, {
        agentArgs: [flag], abortOnPrompt: true, budgetMs: 10000,
      });
      assert.match(r.marker, /CLAUDE_RAN/, `print-mode agent must start; log:\n${r.log}`);
      assert.doesNotMatch(r.log, /Track Claude subscription limits|\[y\/N\]|\[Y\/n\]/, 'no consent question in print mode');
      assert.equal(fs.existsSync(settingsPath), false, 'settings.json is not created');
      assert.equal(r.declined, false, 'skipping must not forge a decline');
    });
  }

  it('treats -p after a bare -- as prompt text and still asks in a TTY', async () => {
    const sc = makeScenario();
    const r = await runLaunch(sc, { agentArgs: ['--', '-p'], input: '\\n' });
    assert.match(r.marker, /CLAUDE_RAN/, r.log);
    assert.match(r.log, /Track Claude subscription limits/, 'prompt text must not enable print mode');
    assert.match(r.log, /\[Y\/n\]/, 'interactive prompt remains available');
    assert.ok(readSettings(sc).statusLine?.command.includes('claude-adapter'), 'Enter installs the adapter');
    assert.equal(r.declined, false);
  });

  it('skips consent when stdout is not a TTY even with TTY stdin', async () => {
    const sc = makeScenario();
    const settingsPath = path.join(sc.claudeHome, 'settings.json');
    const r = await runLaunch(sc, {
      stdoutIsTTY: false, abortOnPrompt: true, budgetMs: 10000,
    });
    assert.match(r.marker, /CLAUDE_RAN/, `agent must start without a question; log:\n${r.log}`);
    assert.doesNotMatch(r.log, /Track Claude subscription limits|\[y\/N\]|\[Y\/n\]/, 'no consent question when stdout is not a TTY');
    assert.equal(fs.existsSync(settingsPath), false, 'settings.json is not created');
    assert.equal(r.declined, false, 'skipping must not forge a decline');
  });

  it('still prompts in an interactive TTY when no statusline is configured — Enter installs the adapter', async () => {
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

  it('an explicit y on the wrap case installs with delegation preserved', async () => {
    const sc = makeScenario({ claudeSettings: { statusLine: { command: 'echo my-custom-line' } } });
    const r = await runLaunch(sc, { input: 'y\\n' });
    assert.match(r.marker, /CLAUDE_RAN/, r.log);
    const st = readSettings(sc).statusLine;
    assert.ok(st.command.includes('claude-adapter'), 'y installs the adapter');
    assert.equal(st._ccxrayDelegate, 'echo my-custom-line', 'original command preserved as delegate');
    assert.equal(r.declined, false);
  });

  // #687: a settings.json that exists but does not parse is never rewritten —
  // the launch prints one refusal line instead of asking, and an eager "y"
  // typed ahead cannot install.
  it('refuses on an unparseable settings.json — no question, file untouched', async () => {
    const sc = makeScenario();
    const settingsPath = path.join(sc.claudeHome, 'settings.json');
    fs.writeFileSync(settingsPath, '{ this is not json');
    const r = await runLaunch(sc, { input: 'y\\n' });
    assert.match(r.marker, /CLAUDE_RAN/, r.log);
    assert.doesNotMatch(r.log, /Track Claude subscription limits|\[y\/N\]|\[Y\/n\]/, 'no consent question');
    assert.match(r.log, /Refusing to install: .*settings\.json is not valid JSON — fix or move it/);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ this is not json', 'file left byte-identical');
    assert.deepEqual(fs.readdirSync(sc.claudeHome), ['settings.json'], 'no backup or tmp file');
    assert.equal(r.declined, false, 'refusal is not a decline');
  });

  it('labels the default Claude home from HOME/.claude.json during discovery', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-statusline-discovery-home-'));
    SCENARIO_DIRS.push(home);
    const claudeHome = path.join(home, '.claude');
    const namedHome = path.join(home, '.claude-work');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(namedHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{}');
    fs.writeFileSync(path.join(namedHome, 'settings.json'), '{}');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'synthetic.user@example.test' },
    }));

    const ttyShim = path.join(home, 'tty-shim.js');
    fs.writeFileSync(ttyShim, [
      "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
      'process.stdin.setRawMode = () => {};',
      'process.stdin.resume = () => {};',
      'process.stdin.pause = () => {};',
      "process.stdin.on = (event, callback) => {",
      "  if (event === 'data') process.nextTick(() => callback(Buffer.from('\\n')));",
      '  return process.stdin;',
      '};',
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, ['-r', ttyShim, SERVER_SCRIPT, 'setup-statusline'], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        HOME: home,
        CCXRAY_HOME: path.join(home, '.ccxray'),
        CCXRAY_EXPORT_DISABLE: '1',
        PATH: process.env.PATH || '',
        TERM: 'dumb',
      },
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /synthetic\.user@example\.test/, result.stdout);
  });
});
