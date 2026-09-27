'use strict';

// Regression coverage for the dashboard onclick/inline-handler DOM XSS.
//
// Root cause: user/data-controlled strings (cwd-derived project name, session
// id) were concatenated into the JS source text of inline `onclick`
// handlers. A browser HTML-decodes an attribute value before compiling/running
// it as JS, so a literal `&quot;` inside the controlled value decodes back into
// a real quote and breaks out of the handler's string literal — arbitrary JS then runs on click.
//
// Fixed shape: the controlled value is written into a `data-*` attribute
// (escaped with escapeHtml, which is sufficient for an *attribute value* — the
// decode-then-parse-as-HTML step stops there), and the inline handler becomes a
// fixed string that reads `this.dataset.*` at click time (never re-embeds the
// value into JS source).

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

// Payload: a literal `&quot;` inside the controlled value. `JSON.stringify`
// does not escape `&`, so the value survives untouched into the wrapping
// quotes; `.replace(/"/g, '&quot;')` only touches the wrapping quotes it just
// added, not this literal substring. The browser's one-time entity-decode of
// the attribute value turns the literal `&quot;` into a real `"`, which closes
// the (double-quoted) `onclick="..."` attribute value early — the rest is
// interpreted as raw HTML, not JS source, but the JS the browser DID compile
// (`selectProject("p")`) has already run with a truncated argument.
const XSS_PROJECT_NAME = 'p&quot;);window.__ccxrayXss=(window.__ccxrayXss||0)+1;(&quot;';
// Same technique, targeting renderStarBadge's toggleStar(...) call. The
// requirements-acceptance correction confirms session ids are NOT
// regex-constrained server-side (server/store.js:544 accepts any string from
// metadata.session_id), so this is a real, not just theoretical, injection.
const XSS_SESSION_ID = 's&quot;,true);window.__ccxrayXss=(window.__ccxrayXss||0)+10;(&quot;';

const NORMAL_PROJECT_NAME = 'normal-project';
const NORMAL_SESSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const tmpDirs = [];

function idFor(d) {
  // Mirrors server/helpers.js timestamp() shape (YYYY-MM-DDTHH-MM-SS-mmm)
  // closely enough for display code that parses entry ids as dates.
  return d.toISOString().slice(0, 23).replace(/[:.]/g, '-');
}

function baseEntry(overrides) {
  return {
    id: null, ts: null, sessionId: null, provider: 'anthropic', agent: 'claude',
    model: 'claude-sonnet-4-6', msgCount: 2, toolCount: 0, toolCalls: {}, skillCalls: null,
    isSubagent: false, sessionInferred: false, cwd: null, isSSE: true,
    usage: { input_tokens: 100, output_tokens: 10 }, cost: { cost: 0.001 }, maxContext: 200000,
    responseMetadata: null, stopReason: 'end_turn', title: null, thinkingDuration: null,
    toolFail: null, elapsed: '1.0', status: 200, receivedAt: null,
    sysHash: null, toolsHash: null, coreHash: null, agentKey: 'orchestrator', agentLabel: null,
    convId: null, thinkingStripped: null, hasCredential: null, toolSources: null,
    edited: null, editSummary: null, imported: null, importSource: null,
    responseId: null, turnToolCalls: {}, turnToolFail: null, turnToolCallIds: null,
    turnToolResults: null, beta1m: null, agentId: null, userEmail: null, team: null,
    agentType: null, localDate: null, tz: null, duplicateToolCalls: null, ctxBeta: null,
    parentSessionId: null, compacted: null, contextUsageKnown: true,
    imported1mCostState: null, imported1mSettings: null, accountEmail: null, accountDomain: null,
    subagentId: null, subagentToolUseId: null, effort: null, thinkingTokens: null,
    turnDurationMs: null,
    ...overrides,
  };
}

function writeFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-dashboard-xss-'));
  tmpDirs.push(home);
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const now = Date.now();
  // Malicious project/session gets the LATEST receivedAt of the fixture so it
  // sorts to index 0 of the Projects column deterministically (renderProjectsCol
  // sorts by status then lastId descending) — the test locates it by position,
  // not by parsing onclick/dataset (which is exactly what's under test).
  const t1 = new Date(now);
  const t2 = new Date(now + 2000);
  const tNormal = new Date(now - 10000);

  const xssCwd = '/tmp/ccxray-xss-fixture/' + XSS_PROJECT_NAME;
  const entry1 = baseEntry({
    id: idFor(t1), ts: t1.toTimeString().slice(0, 8), sessionId: XSS_SESSION_ID,
    cwd: xssCwd, receivedAt: t1.getTime(), coreHash: 'abcdef012345',
    responseId: 'msg_xss_test_001',
  });
  const entry2 = baseEntry({
    id: idFor(t2), ts: t2.toTimeString().slice(0, 8), sessionId: XSS_SESSION_ID,
    cwd: xssCwd, receivedAt: t2.getTime(), coreHash: 'abcdef012345',
    responseId: 'msg_xss_test_002',
  });
  const entryNormal = baseEntry({
    id: idFor(tNormal), ts: tNormal.toTimeString().slice(0, 8), sessionId: NORMAL_SESSION_ID,
    cwd: '/tmp/ccxray-xss-fixture/' + NORMAL_PROJECT_NAME, receivedAt: tNormal.getTime(),
    coreHash: 'fedcba543210', responseId: 'msg_normal_test_001',
  });

  const lines = [entry1, entry2, entryNormal].map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), lines);
  return home;
}

async function findFreePort() {
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

describe('Dashboard onclick XSS regression', () => {
  let home, port, child, browser, page;

  before(async () => {
    home = writeFixtureHome();
    port = await findFreePort();
    child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port), '--no-browser'], {
      env: {
        ...process.env,
        CCXRAY_HOME: home,
        CCXRAY_EXPORT_DISABLE: '1',
        LOG_RETENTION_DAYS: '0',
        CCXRAY_IMPORT_DISABLE: '1',
        RESTORE_DAYS: '0',
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForPort(port);
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    // Fixture is normal proxy-style index lines (no `imported` field set), so
    // the default hide-imported behavior is irrelevant here — load `/` plain.
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    // Skip the transient loading-skeleton state (six placeholder `.project-item`
    // rows with no onclick/dataset) — wait for real data to replace it.
    await page.waitForFunction(() => window._entriesLoading === false
      && document.querySelectorAll('.project-item').length === 2
      && !document.querySelector('.project-item .skeleton'), { timeout: 10000 });
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await killAndWait(child);
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('T0 — fixture renders exactly the two expected project rows', async () => {
    const count = await page.evaluate(() => document.querySelectorAll('.project-item').length);
    assert.equal(count, 2, 'expected the malicious and normal project rows only');
  });

  it('T1/T2 — clicking the malicious project row selects it without executing injected code', async () => {
    const result = await page.evaluate(async () => {
      window.__ccxrayXss = 0;
      const item = document.querySelectorAll('.project-item')[0];
      const meta = item.querySelector('.pi-meta');
      meta.click();
      await new Promise(r => setTimeout(r, 300));
      return { xss: window.__ccxrayXss || 0, selected: typeof selectedProjectName !== 'undefined' ? selectedProjectName : null };
    });
    assert.equal(result.xss, 0, 'clicking the project row must not execute injected code');
    assert.equal(result.selected, XSS_PROJECT_NAME, 'selectProject must receive the full, untruncated original project name');
  });

  it('T3/T5 — the malicious project star toggles without executing injected code, and records the full name', async () => {
    const before1 = await page.evaluate(() => {
      const item = document.querySelectorAll('.project-item')[0];
      const btn = item.querySelector('.pin-btn');
      return { hasBtn: !!btn, pinned: btn ? btn.classList.contains('pinned') : null };
    });
    assert.ok(before1.hasBtn, 'malicious project row must render a star button');
    assert.equal(before1.pinned, false, 'project must start unstarred');

    const result = await page.evaluate(async (name) => {
      window.__ccxrayXss = 0;
      const item = document.querySelectorAll('.project-item')[0];
      const btn = item.querySelector('.pin-btn');
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      // DOM may have been fully replaced by the star-toggle re-render — re-query.
      const item2 = document.querySelectorAll('.project-item')[0];
      const btn2 = item2 ? item2.querySelector('.pin-btn') : null;
      return {
        xss: window.__ccxrayXss || 0,
        pinnedAfter: btn2 ? btn2.classList.contains('pinned') : null,
        fullNameStarred: window.xrayStars ? window.xrayStars.projects.has(name) : null,
      };
    }, XSS_PROJECT_NAME);

    assert.equal(result.xss, 0, 'star click must not execute injected code');
    assert.equal(result.pinnedAfter, true, 'star should toggle to pinned (toggleStar received the right args)');
    assert.equal(result.fullNameStarred, true, 'starred state must be keyed on the full original project name, not a truncated fragment');

    // Independently verify the server persisted the full name (not just the
    // client-side optimistic mirror).
    const serverStars = await page.evaluate(() => fetch('/_api/stars').then(r => r.json()));
    assert.ok(serverStars.projects.includes(XSS_PROJECT_NAME), '/_api/stars must record the full original project name');
  });

  it('T4 — the malicious session star toggles without executing injected code, and records the full id', async () => {
    // Select the malicious project first so its sessions are the ones filtered in.
    await page.evaluate((name) => { selectProject(name); }, XSS_PROJECT_NAME);
    await new Promise(r => setTimeout(r, 200));

    const found = await page.evaluate((sid) => {
      const el = [...document.querySelectorAll('.session-item')].find(x => x.dataset.sessionId === sid);
      const btn = el ? el.querySelector('.pin-btn') : null;
      return { hasEl: !!el, hasBtn: !!btn, pinned: btn ? btn.classList.contains('pinned') : null };
    }, XSS_SESSION_ID);
    assert.ok(found.hasEl, 'malicious session row must be rendered under the selected project');
    assert.ok(found.hasBtn, 'session row must render a star button');
    assert.equal(found.pinned, false, 'session must start unstarred');

    const result = await page.evaluate(async (sid) => {
      window.__ccxrayXss = 0;
      const el = [...document.querySelectorAll('.session-item')].find(x => x.dataset.sessionId === sid);
      const btn = el.querySelector('.pin-btn');
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      const el2 = [...document.querySelectorAll('.session-item')].find(x => x.dataset.sessionId === sid);
      const btn2 = el2 ? el2.querySelector('.pin-btn') : null;
      return {
        xss: window.__ccxrayXss || 0,
        pinnedAfter: btn2 ? btn2.classList.contains('pinned') : null,
        fullIdStarred: window.xrayStars ? window.xrayStars.sessions.has(sid) : null,
      };
    }, XSS_SESSION_ID);

    assert.equal(result.xss, 0, 'session star click must not execute injected code');
    assert.equal(result.pinnedAfter, true, 'session star should toggle to pinned');
    assert.equal(result.fullIdStarred, true, 'starred state must be keyed on the full original session id, not a truncated fragment');

    const serverStars = await page.evaluate(() => fetch('/_api/stars').then(r => r.json()));
    assert.ok(serverStars.sessions.includes(XSS_SESSION_ID), '/_api/stars must record the full original session id');
  });

  it('T4b — the derived-star chip on the malicious project opens its popover without executing injected code', async () => {
    // Star the session through the API (not a click) so the chip renders on old
    // and new code alike; only the chip click itself is under test here.
    await page.evaluate(async (name, sid) => {
      selectProject(name);
      if (!window.xrayStars.sessions.has(sid)) await toggleStar('session', sid, true);
    }, XSS_PROJECT_NAME, XSS_SESSION_ID);
    await new Promise(r => setTimeout(r, 300));

    const chip = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('.project-item.selected')].find(x => x.dataset.project === name || !x.dataset.project);
      const el = row ? row.querySelector('.pin-btn-count') : null;
      return { hasRow: !!row, hasChip: !!el };
    }, XSS_PROJECT_NAME);
    assert.ok(chip.hasRow, 'the malicious project row must be selected');
    assert.ok(chip.hasChip, 'a starred session must render the derived-star chip on its project');

    const result = await page.evaluate(async () => {
      window.__ccxrayXss = 0;
      document.querySelector('.project-item.selected .pin-btn-count').click();
      await new Promise(r => setTimeout(r, 300));
      const open = document.querySelectorAll('.star-popover').length;
      document.querySelector('.star-popover-close')?.click();
      return { xss: window.__ccxrayXss || 0, open };
    });
    assert.equal(result.xss, 0, 'chip click must not execute injected code');
    assert.equal(result.open, 1, 'chip click must open the starred-items popover');
  });

  it('T7 — keyboard ArrowUp/ArrowDown still navigates projects, including the malicious one, by full name', async () => {
    // Reset selection + keyboard focus state deterministically; prior tests in
    // this file already selected the malicious project.
    await page.evaluate(() => { if (typeof selectProject === 'function') selectProject(null); });
    await new Promise(r => setTimeout(r, 200));
    const initial = await page.evaluate(() => selectedProjectName);
    assert.equal(initial, null, 'no project should be selected before keyboard navigation starts');

    await page.keyboard.press('ArrowDown');
    await new Promise(r => setTimeout(r, 150));
    const sel1 = await page.evaluate(() => selectedProjectName);

    await page.keyboard.press('ArrowDown');
    await new Promise(r => setTimeout(r, 150));
    const sel2 = await page.evaluate(() => selectedProjectName);

    assert.ok(sel1, 'first ArrowDown must select a project');
    assert.ok(sel2, 'second ArrowDown must select a project');
    assert.notEqual(sel1, sel2, 'ArrowDown must move to a different project the second time');
    assert.deepEqual(
      new Set([sel1, sel2]),
      new Set([XSS_PROJECT_NAME, NORMAL_PROJECT_NAME]),
      'keyboard navigation must reach both projects by their full original names, including the malicious one'
    );
  });
});
