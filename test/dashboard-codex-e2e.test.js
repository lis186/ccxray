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
const tmpDirs = [];

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
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`http://localhost:${port}/?p=${encodeURIComponent(PROJECT_NAME)}&s=codex-raw`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const turn = document.querySelector('.turn-item[data-session-id="codex-raw"]');
        const header = document.querySelector('#col-sections .ch-line2');
        return !!turn && !!header && header.textContent.includes('completed');
      });

      const state = await page.evaluate(() => {
        const turn = document.querySelector('.turn-item[data-session-id="codex-raw"]');
        const header = document.querySelector('#col-sections .ch-line2');
        const model = turn?.querySelector('.turn-model');
        return {
          projectText: document.querySelector('.project-item.selected .pi-label')?.textContent || '',
          sessionText: document.querySelector('.session-item.selected .sid')?.textContent || '',
          url: location.search,
          hasOkDot: !!turn?.querySelector('.status-dot-ok'),
          hasErrDot: !!turn?.querySelector('.status-dot-err'),
          isCritical: turn?.classList.contains('risk-critical') || false,
          modelText: model?.textContent || '',
          sectionText: header?.textContent || '',
        };
      });

      assert.equal(state.projectText, PROJECT_NAME);
      assert.equal(state.sessionText, 'Codex Raw');
      assert.match(state.url, /s=codex-raw/);
      assert.equal(state.hasOkDot, true);
      assert.equal(state.hasErrDot, false);
      assert.equal(state.isCritical, false);
      assert.match(state.modelText, /gpt-5\.5/);
      assert.match(state.sectionText, /200/);
      assert.match(state.sectionText, /completed/);
    } finally {
      if (browser) await browser.close();
      await killAndWait(child);
    }
  });
});
