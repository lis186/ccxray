'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('hiddenProjects in settings', () => {
  let tmpDir, prevHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-test-'));
    prevHome = process.env.CCXRAY_HOME;
    process.env.CCXRAY_HOME = tmpDir;
    delete require.cache[require.resolve('../server/settings')];
    delete require.cache[require.resolve('../server/paths')];
  });

  afterEach(() => {
    if (prevHome != null) process.env.CCXRAY_HOME = prevHome;
    else delete process.env.CCXRAY_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/settings')];
    delete require.cache[require.resolve('../server/paths')];
  });

  it('defaults to empty array when no settings file', () => {
    const { readSettings } = require('../server/settings');
    const s = readSettings();
    assert.deepStrictEqual(s.hiddenProjects, []);
  });

  it('reads hiddenProjects from settings.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      hiddenProjects: ['secret-project', 'personal']
    }));
    const { readSettings } = require('../server/settings');
    const s = readSettings();
    assert.deepStrictEqual(s.hiddenProjects, ['secret-project', 'personal']);
  });

  it('coerces non-array hiddenProjects to empty array', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      hiddenProjects: 'not-an-array'
    }));
    const { readSettings } = require('../server/settings');
    const s = readSettings();
    assert.deepStrictEqual(s.hiddenProjects, []);
  });

  it('filters non-string entries', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      hiddenProjects: ['valid', 42, null, 'also-valid']
    }));
    const { readSettings } = require('../server/settings');
    const s = readSettings();
    assert.deepStrictEqual(s.hiddenProjects, ['valid', 'also-valid']);
  });

  it('clone does not share reference', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      hiddenProjects: ['secret']
    }));
    const { readSettings } = require('../server/settings');
    const a = readSettings();
    const b = readSettings();
    a.hiddenProjects.push('mutated');
    assert.deepStrictEqual(b.hiddenProjects, ['secret']);
  });
});
