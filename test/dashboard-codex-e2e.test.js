'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const PROJECT_CWD = path.resolve(__dirname, '..');
const PROJECT_NAME = path.basename(PROJECT_CWD);
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmpDirs = [];

// Mirror of the dashboard's project-label truncation (public/miller-columns.js
// truncateMiddle). The project label is the cwd basename, which is long when the
// suite runs from a git worktree (e.g. ".claude/worktrees/<branch>"), so compare
// against the same truncation the UI applies rather than the raw name.
function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const tail = Math.ceil(max * 0.6);
  const head = max - tail - 1;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

function makeOpenAISSE() {
  return [
    'event: response.created',
    'data: ' + JSON.stringify({
      type: 'response.created',
      response: { id: 'resp_dashboard', object: 'response', model: 'gpt-5.5', status: 'in_progress' },
    }),
    '',
    'event: response.completed',
    'data: ' + JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_dashboard',
        object: 'response',
        model: 'gpt-5.5',
        status: 'completed',
        usage: { input_tokens: 29096, output_tokens: 58, total_tokens: 29154 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'dashboard ok' }] }],
      },
    }),
    '',
  ].join('\n');
}

function writeFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-dashboard-codex-'));
  tmpDirs.push(home);
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(path.join(logsDir, 'shared'), { recursive: true });
  const id = '2026-05-03T23-38-05-284';
  fs.writeFileSync(path.join(logsDir, `${id}_res.json`), makeOpenAISSE());
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), JSON.stringify({
    id,
    ts: '23:38:05',
    sessionId: 'codex-raw',
    provider: 'openai',
    agent: 'codex',
    method: 'POST',
    url: '/v1/responses',
    elapsed: '2.3',
    status: 200,
    isSSE: false,
    receivedAt: 1777822685284,
    usage: null,
    cost: null,
    maxContext: null,
    cwd: PROJECT_CWD,
    model: null,
    msgCount: 0,
    toolCount: 0,
    toolCalls: {},
    isSubagent: false,
    sessionInferred: false,
    title: null,
    stopReason: '',
    responseMetadata: { provider: 'openai', status: 200 },
  }) + '\n');
  return home;
}

function writeParityFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-dashboard-codex-parity-'));
  tmpDirs.push(home);
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(path.join(logsDir, 'shared'), { recursive: true });
  const id = '2026-05-03T23-39-05-284';
  const sessionId = 'codex-thread-dashboard-001';
  fs.writeFileSync(path.join(logsDir, `${id}_res.json`), makeOpenAISSE());
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), JSON.stringify({
    id,
    ts: '23:39:05',
    sessionId,
    provider: 'openai',
    agent: 'codex',
    method: 'POST',
    url: '/v1/responses',
    elapsed: '1.1',
    status: 200,
    isSSE: false,
    receivedAt: 1777822745284,
    usage: { input_tokens: 1200, output_tokens: 24, total_tokens: 1224 },
    cost: { cost: 0.01 },
    maxContext: 400000,
    cwd: PROJECT_CWD,
    model: 'gpt-5.5',
    msgCount: 1,
    toolCount: 0,
    toolCalls: {},
    isSubagent: false,
    sessionInferred: false,
    title: 'Inspect dashboard project',
    stopReason: 'completed',
    responseMetadata: { provider: 'openai', status: 200, transport: 'websocket' },
  }) + '\n');
  return { home, sessionId };
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
        res.on('end', () => resolve());
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('server did not start'));
        setTimeout(check, 100);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('server did not start'));
        setTimeout(check, 100);
      });
    };
    check();
  });
}

function killAndWait(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
  });
}

function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

describe('Codex dashboard status E2E', () => {
  after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renders restored Codex completed responses as successful, not critical', async () => {
    const home = writeFixtureHome();
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
      await page.goto(`http://localhost:${port}/?p=${encodeURIComponent(PROJECT_NAME)}&s=codex-raw`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        // #332: turn column removed — the selected session card, the sections
        // header, and the swimlane turn bar carry what the old .turn-item did.
        // Wait on all three (header + projLabel are rAF-coalesced, ADR 0002; the
        // swimlane SVG paints on the next frame, so wait for its bar too).
        const session = document.querySelector('.session-item[data-session-id="codex-raw"]');
        const header = document.querySelector('#col-sections .ch-line2');
        const projLabel = document.querySelector('.project-item.selected .pi-label');
        const bar = document.querySelector('#wf-main-svg .wf-b[data-turn-id="2026-05-03T23-38-05-284"]');
        return !!session && !!header && header.textContent.includes('completed')
          && !!projLabel && projLabel.textContent.trim().length > 0 && !!bar;
      });

      const state = await page.evaluate(() => {
        // sections header (ch-line1/ch-line2) reflects the deep-link-selected turn #1;
        // severity now lives on that turn's swimlane bar (data-severity), not a turn card.
        const header = document.querySelector('#col-sections .ch-line2');
        const line1 = document.querySelector('#col-sections .ch-line1');
        const bar = document.querySelector('#wf-main-svg .wf-b[data-turn-id="2026-05-03T23-38-05-284"]');
        return {
          projectText: document.querySelector('.project-item.selected .pi-label')?.textContent || '',
          sessionText: document.querySelector('.session-item.selected .sid')?.textContent || '',
          url: location.search,
          hasOkDot: !!header?.querySelector('.status-ok'),
          hasErrDot: !!header?.querySelector('.status-err'),
          severity: bar?.getAttribute('data-severity') || null,
          modelText: line1?.textContent || '',
          sectionText: header?.textContent || '',
        };
      });

      assert.equal(state.projectText, truncateMiddle(PROJECT_NAME, 20));
      assert.equal(state.sessionText, 'Codex Raw');
      assert.match(state.url, /s=codex-raw/);
      assert.equal(state.hasOkDot, true);
      assert.equal(state.hasErrDot, false);
      assert.equal(state.severity, null); // 200/completed → no severity marker at all
      assert.match(state.modelText, /gpt-5\.5/);
      assert.match(state.sectionText, /200/);
      assert.match(state.sectionText, /completed/);
    } finally {
      if (browser) await browser.close();
      await killAndWait(child);
    }
  });

  it('renders Codex metadata sessions under the real project with a normal title', async () => {
    const { home, sessionId } = writeParityFixtureHome();
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
      await page.goto(`http://localhost:${port}/?p=${encodeURIComponent(PROJECT_NAME)}&s=${encodeURIComponent(sessionId)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((sid) => {
        // #332: turn column removed — assert on the selected session card instead.
        const session = document.querySelector(`.session-item[data-session-id="${sid}"]`);
        // Wait for the rAF-coalesced selected project label too (ADR 0002) — same race
        // as the first test: this subtest also asserts projectText.
        const projLabel = document.querySelector('.project-item.selected .pi-label');
        return !!session && !!projLabel && projLabel.textContent.trim().length > 0;
      }, {}, sessionId);

      const state = await page.evaluate(() => ({
        projectText: document.querySelector('.project-item.selected .pi-label')?.textContent || '',
        sessionSidText: document.querySelector('.session-item.selected .sid')?.textContent || '',
        sessionTitleText: document.querySelector('.session-item.selected .si-title')?.textContent || '',
        selectedProjectCount: document.querySelectorAll('.project-item.selected').length,
        unknownSelected: [...document.querySelectorAll('.project-item.selected .pi-label')].some(el => el.textContent.includes('(unknown)')),
        url: location.search,
      }));

      assert.equal(state.projectText, truncateMiddle(PROJECT_NAME, 20));
      assert.equal(state.sessionSidText, sessionId.slice(0, 8));
      assert.equal(state.sessionTitleText, 'Inspect dashboard project');
      assert.equal(state.selectedProjectCount, 1);
      assert.equal(state.unknownSelected, false);
      assert.match(state.url, new RegExp(`s=${sessionId.slice(0, 8)}`));
    } finally {
      if (browser) await browser.close();
      await killAndWait(child);
    }
  });
});
