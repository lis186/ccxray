'use strict';
// #696: server/settings.js writes. A running server must not revert a change
// another process (`ccxray hud on|off`) made, writes keep a symlinked
// settings.json, and the tmp file is owner-only under a random name.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-settings-write-'));
const prevHome = process.env.CCXRAY_HOME;
let settings;

function file() { return path.join(home, 'settings.json'); }
function readFile(target = file()) { return JSON.parse(fs.readFileSync(target, 'utf8')); }

describe('settings writes', () => {
  before(() => {
    process.env.CCXRAY_HOME = home;
    delete require.cache[require.resolve('../server/settings')];
    settings = require('../server/settings');
    assert.equal(settings.SETTINGS_PATH, file());
  });
  after(() => {
    if (prevHome === undefined) delete process.env.CCXRAY_HOME;
    else process.env.CCXRAY_HOME = prevHome;
    delete require.cache[require.resolve('../server/settings')];
    fs.rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    for (const name of fs.readdirSync(home)) fs.rmSync(path.join(home, name), { recursive: true, force: true });
    settings._resetSettingsCache();
  });

  it('a dashboard write after `hud on` keeps the CLI statusLine', () => {
    fs.writeFileSync(file(), JSON.stringify({ statusLine: false, starredSessions: [] }));
    const cached = settings.readSettings();
    assert.equal(cached.statusLine, false);
    // Another process (`ccxray hud on`) flips the file; this cache is stale.
    fs.writeFileSync(file(), JSON.stringify({ statusLine: true, starredSessions: [], extra: 'kept' }));

    settings.writeSettings({ ...settings.readSettings(), starredSessions: ['synthetic-session'] });
    assert.deepEqual(readFile(), { statusLine: true, starredSessions: ['synthetic-session'], extra: 'kept' });
    assert.equal(settings.readSettings().statusLine, true, 'cache refreshed from disk');

    // The dashboard toggle still changes it.
    settings.writeSettings({ ...settings.readSettings(), statusLine: false });
    assert.equal(readFile().statusLine, false);
    assert.deepEqual(readFile().starredSessions, ['synthetic-session']);
  });

  it('writes keep a symlinked settings.json', { skip: process.platform === 'win32' }, () => {
    const managed = path.join(home, 'managed', 'settings.json');
    fs.mkdirSync(path.dirname(managed));
    fs.writeFileSync(managed, JSON.stringify({ hiddenProjects: ['p'] }));
    fs.symlinkSync(managed, file());

    settings.setStatusLineSync(true);
    assert.ok(fs.lstatSync(file()).isSymbolicLink());
    assert.deepEqual(readFile(managed), { hiddenProjects: ['p'], statusLine: true });

    settings.writeSettings({ ...settings.readSettings(), starredTurns: ['t'] });
    assert.ok(fs.lstatSync(file()).isSymbolicLink());
    assert.deepEqual(readFile(managed).starredTurns, ['t']);
    assert.equal(readFile(managed).statusLine, true);
    assert.deepEqual(fs.readdirSync(path.dirname(managed)), ['settings.json']);
  });

  it('a stale pid-named tmp file does not block a write, and the file is 0600', () => {
    fs.writeFileSync(`${file()}.tmp-${process.pid}`, 'stale');
    settings.setStatusLineSync(true);
    assert.equal(readFile().statusLine, true);
    settings.writeSettings({ ...settings.readSettings(), starredSteps: ['s'] });
    assert.deepEqual(readFile().starredSteps, ['s']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
    const leftovers = fs.readdirSync(home).filter(name => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [`settings.json.tmp-${process.pid}`]);
  });
});
