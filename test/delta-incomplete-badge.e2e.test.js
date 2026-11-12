'use strict';

// #774: a delta turn whose ancestor is gone renders "history truncated: first N
// messages unavailable" in the turn column header; a complete turn (full record,
// or a delta whose ancestor is on disk) renders no badge. Synthetic fixture,
// isolated CCXRAY_HOME, cold-load path (RESTORE_DAYS=0).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tmpDirs = [];

const idFor = (d) => d.toISOString().slice(0, 23).replace(/[:.]/g, '-');
const msg = (role, content) => ({ role, content });

function entryLine(id, t, extra) {
  return {
    id, ts: t.toTimeString().slice(0, 8), sessionId: SID, provider: 'anthropic', agent: 'claude',
    model: 'claude-sonnet-4-6', msgCount: 2, toolCount: 0, toolCalls: {}, isSubagent: false,
    sessionInferred: false, cwd: '/tmp/ccxray-badge-fixture', isSSE: true,
    usage: { input_tokens: 100, output_tokens: 10 }, cost: { cost: 0.001 }, maxContext: 200000,
    stopReason: 'end_turn', elapsed: '1.0', status: 200, receivedAt: t.getTime(), coreHash: 'abcdef012345',
    agentKey: 'orchestrator', turnToolCalls: {}, contextUsageKnown: true, ...extra,
  };
}

function writeFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-delta-badge-'));
  tmpDirs.push(home);
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const base = Date.now();
  const times = [0, 1, 2, 3, 4].map(i => new Date(base + i * 1000));
  const ids = times.map(idFor);
  const put = (id, body) => {
    fs.writeFileSync(path.join(logs, id + '_req.json'), JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 100, ...body }));
    fs.writeFileSync(path.join(logs, id + '_res.json'), '[]');
  };
  // 0: delta whose ancestor never existed (6 leading messages lost) — truncated
  put(ids[0], { prevId: 'ancestor-that-is-gone', msgOffset: 6, messages: [msg('assistant', 'x'), msg('user', 'truncated suffix')] });
  // 1: full anchor, 2: delta onto it (complete), 3: delta onto a persisted-incomplete record
  put(ids[1], { messages: [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')] });
  put(ids[2], { prevId: ids[1], msgOffset: 3, messages: [msg('assistant', 'd'), msg('user', 'e')] });
  put(ids[3], { incomplete: { reason: 'missing-ancestor', prevId: 'pruned', msgOffset: 4, persisted: true }, messages: [msg('user', 'only the tail survives')] });
  // 4: persisted-incomplete from a CORRUPT offset — alignment unknown, so no count
  put(ids[4], { incomplete: { reason: 'missing-ancestor', prevId: 'pruned', msgOffset: null, persisted: true }, messages: [msg('user', 'alignment unknown')] });
  const lines = ids.map((id, i) => JSON.stringify(entryLine(id, times[i], { responseId: 'msg_badge_' + i })));
  fs.writeFileSync(path.join(logs, 'index.ndjson'), lines.join('\n') + '\n');
  return { home, ids };
}

function findFreePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/_api/health`, { timeout: 1000 }, res => { res.resume(); res.on('end', resolve); });
      const retry = () => (Date.now() - start > timeoutMs ? reject(new Error('server did not start')) : setTimeout(check, 100));
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
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

describe('#774 incomplete-turn badge', () => {
  let child, browser, page, ids;

  before(async () => {
    const fixture = writeFixtureHome();
    ids = fixture.ids;
    const port = await findFreePort();
    child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port), '--no-browser'], {
      env: {
        ...process.env, CCXRAY_HOME: fixture.home, CCXRAY_EXPORT_DISABLE: '1', LOG_RETENTION_DAYS: '0',
        CCXRAY_IMPORT_DISABLE: '1', RESTORE_DAYS: '0', BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForPort(port);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._entriesLoading === false
      && document.querySelectorAll('.project-item').length >= 1
      && !document.querySelector('.project-item .skeleton'), { timeout: 15000 });
    await page.evaluate(() => selectProject(document.querySelector('.project-item').dataset.project || null));
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate((sid) => selectSession(sid), SID);
    await new Promise(r => setTimeout(r, 500));
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await killAndWait(child);
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function badgeFor(turnIdx) {
    await page.evaluate((i) => selectTurn(i), turnIdx);
    await page.waitForFunction((i) => allEntries[i] && allEntries[i].reqLoaded, { timeout: 5000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
    return page.evaluate(() => {
      const el = document.querySelector('.col-header .ch-incomplete');
      return el ? el.textContent : null;
    });
  }

  it('shows the count on a delta whose ancestor is gone', async () => {
    assert.equal(await badgeFor(0), 'history truncated: first 6 messages unavailable');
  });

  it('shows no badge on a full record or on a delta with its ancestor on disk', async () => {
    assert.equal(await badgeFor(1), null);
    assert.equal(await badgeFor(2), null);
  });

  it('keeps showing the badge for a persisted-incomplete (re-anchored) record', async () => {
    assert.equal(await badgeFor(3), 'history truncated: first 4 messages unavailable');
  });

  it('renders a count-free warning when the lost-prefix size is unknown (corrupt offset)', async () => {
    assert.equal(await badgeFor(4), 'history truncated: earlier messages unavailable');
  });
});
