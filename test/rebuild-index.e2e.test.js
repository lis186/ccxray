'use strict';

// E2E: prove `ccxray rebuild-index` self-heals a lost index end-to-end, all the
// way to a real browser render. Seed log files but NO index.ndjson (the data-loss
// scenario), run the real CLI to rebuild it, boot the server, and assert the
// recovered turn renders in the dashboard's Miller columns via headless Chrome.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const PROJECT_CWD = path.resolve(__dirname, '..');
const PROJECT_NAME = path.basename(PROJECT_CWD);
const SESSION_ID = 'rebuilt-sess';
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmpDirs = [];

function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const tail = Math.ceil(max * 0.6);
  const head = max - tail - 1;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

// Seed an isolated home with real _req/_res log files + shared sys blob, but NO
// index.ndjson — exactly the "index deleted, sources survive" case.
function seedLogsWithoutIndex() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-rebuild-e2e-'));
  tmpDirs.push(home);
  const logs = path.join(home, 'logs');
  const shared = path.join(logs, 'shared');
  fs.mkdirSync(shared, { recursive: true });

  const system = [
    { type: 'text', text: 'You are Claude Code.' },
    { type: 'text', text: `Env\nPrimary working directory: ${PROJECT_CWD}\nmore env` },
  ];
  fs.writeFileSync(path.join(shared, 'sys_e2e.json'), JSON.stringify(system));

  const id = '2026-06-10T08-30-00-000';
  fs.writeFileSync(path.join(logs, `${id}_req.json`), JSON.stringify({
    model: 'claude-sonnet-4-6', max_tokens: 8096, sysHash: 'e2e',
    messages: [{ role: 'user', content: 'recover this turn please' }],
    metadata: { session_id: SESSION_ID },
  }));
  fs.writeFileSync(path.join(logs, `${id}_res.json`), JSON.stringify([
    { type: 'message_start', message: { usage: { input_tokens: 321, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 88 } },
  ]));

  return { home, logs, id };
}

async function findFreePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/_api/health`, { timeout: 1000 }, res => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('server did not start'));
        setTimeout(check, 100);
      });
      req.on('timeout', () => { req.destroy(); setTimeout(check, 100); });
    };
    check();
  });
}

function killAndWait(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

describe('rebuild-index E2E — self-heal a lost index to a real browser render', () => {
  after(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

  it('rebuilds index.ndjson from surviving log files and renders the recovered turn', async () => {
    const { home, logs, id } = seedLogsWithoutIndex();
    const indexPath = path.join(logs, 'index.ndjson');

    // BEFORE: index is absent — the data-loss state.
    assert.equal(fs.existsSync(indexPath), false, 'precondition: no index on disk');

    // Run the REAL CLI (same dispatch a user invokes) to self-heal.
    const cli = spawnSync(process.execPath, [SERVER_SCRIPT, 'rebuild-index', '--apply'], {
      env: { ...process.env, CCXRAY_HOME: home, BROWSER: 'none' },
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, `rebuild-index exited non-zero: ${cli.stderr}`);
    assert.match(cli.stdout, /recovered 1 \/ 1 turns/, `unexpected CLI output: ${cli.stdout}`);

    // AFTER: index now exists and carries the recovered line.
    assert.equal(fs.existsSync(indexPath), true, 'index rebuilt on disk');
    const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.id, id);
    assert.equal(rec.sessionId, SESSION_ID);
    assert.equal(rec.cwd, PROJECT_CWD, 'cwd recovered from rehydrated system prompt');

    // Now boot the server against the rebuilt index and render it in a browser.
    const port = await findFreePort();
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port), '--no-browser'], {
      env: { ...process.env, CCXRAY_HOME: home, BROWSER: 'none', RESTORE_DAYS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let browser;
    try {
      await waitForPort(port);
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`http://localhost:${port}/?p=${encodeURIComponent(PROJECT_NAME)}&s=${SESSION_ID}`, { waitUntil: 'domcontentloaded' });

      // The recovered turn must render under its session — proves the rebuilt
      // index flows through restore → SSE → render, not just sits on disk.
      // Projects column render is rAF-coalesced (docs/decisions/0002-dirty-check-signature.md),
      // so wait for it too — the turn-item can commit a frame before it does.
      await page.waitForFunction(
        (sid) => !!document.querySelector(`.turn-item[data-session-id="${sid}"]`) &&
                 !!document.querySelector('.project-item.selected .pi-label')?.textContent,
        { timeout: 8000 }, SESSION_ID,
      );

      const state = await page.evaluate((sid) => {
        const turn = document.querySelector(`.turn-item[data-session-id="${sid}"]`);
        return {
          projectText: document.querySelector('.project-item.selected .pi-label')?.textContent || '',
          sessionVisible: !!document.querySelector('.session-item.selected'),
          turnVisible: !!turn,
          model: turn?.querySelector('.turn-model')?.textContent || '',
        };
      }, SESSION_ID);

      assert.equal(state.turnVisible, true, 'recovered turn renders in the dashboard');
      assert.equal(state.sessionVisible, true, 'recovered session column populated');
      assert.equal(state.projectText, truncateMiddle(PROJECT_NAME, 20), 'recovered project (cwd) renders');
      assert.match(state.model, /sonnet-4-6/); // dashboard strips the claude- prefix for display
    } finally {
      if (browser) await browser.close();
      await killAndWait(child);
    }
  });
});
