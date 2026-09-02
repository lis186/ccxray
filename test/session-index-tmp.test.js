'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-session-tmp-home-'));
process.env.CCXRAY_HOME = TEST_HOME;
process.env.CCXRAY_EXPORT_DISABLE = '1';
const config = require('../server/config');
const si = require('../server/session-index');

const logsDir = config.LOGS_DIR;
fs.mkdirSync(logsDir, { recursive: true });

describe('session-index pid-suffixed temporary files', () => {
  after(() => {
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('tmpPath contains the current process id', () => {
    assert.match(si.tmpPath(), new RegExp(`\\.${process.pid}\\.tmp$`));
  });

  it('sweeps old orphan temp files but keeps recent ones', async () => {
    const oldPath = path.join(logsDir, 'sessions.json.12345.tmp');
    const recentPath = path.join(logsDir, 'sessions.json.67890.tmp');
    fs.writeFileSync(oldPath, 'old');
    fs.writeFileSync(recentPath, 'recent');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(oldPath, old, old);

    await si.loadSessionIndex();

    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.existsSync(recentPath), true);
  });
});
