'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const adapterPath = path.join(__dirname, '../server/adapters/claude-adapter.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-'));
}

describe('claude-adapter', () => {
  let outDir;

  beforeEach(() => {
    outDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('reads statusline JSON from stdin and writes unified snapshot', () => {
    const input = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 20.0, resets_at: 1750000000 },
        seven_day: { used_percentage: 5.0, resets_at: 1750400000 },
      },
    });

    execFileSync('node', [adapterPath, '--out-dir', outDir], { input, timeout: 5000 });

    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);

    const snap = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
    assert.equal(snap.provider, 'anthropic');
    assert.equal(snap.fiveHour.usedPct, 20);
    assert.equal(snap.fiveHour.resetsAt, 1750000000);
    assert.equal(snap.sevenDay.usedPct, 5);
    assert.equal(snap.sevenDay.resetsAt, 1750400000);
    assert.equal(typeof snap.updatedAt, 'number');
    assert.ok(snap.id);
    assert.ok(snap.label);
  });

  it('does nothing when stdin has no rate_limits', () => {
    const input = JSON.stringify({ some_other_field: true });

    execFileSync('node', [adapterPath, '--out-dir', outDir], { input, timeout: 5000 });

    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 0);
  });

  it('handles missing seven_day', () => {
    const input = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 50.0, resets_at: 1750000000 },
      },
    });

    execFileSync('node', [adapterPath, '--out-dir', outDir], { input, timeout: 5000 });

    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);

    const snap = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
    assert.equal(snap.fiveHour.usedPct, 50);
    assert.equal(snap.sevenDay, null);
  });

  it('delegates stdin to --delegate command', () => {
    const delegateScript = path.join(outDir, 'delegate.sh');
    const delegateOut = path.join(outDir, 'delegate-output.txt');
    fs.writeFileSync(delegateScript, `#!/bin/sh\ncat > "${delegateOut}"\n`);
    fs.chmodSync(delegateScript, 0o755);

    const input = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 1750000000 },
        seven_day: { used_percentage: 3, resets_at: 1750400000 },
      },
    });

    execFileSync('node', [adapterPath, '--out-dir', outDir, '--delegate', delegateScript], {
      input,
      timeout: 5000,
    });

    assert.ok(fs.existsSync(delegateOut), 'delegate should have received stdin');
    const delegated = fs.readFileSync(delegateOut, 'utf8');
    assert.equal(delegated, input);

    const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
  });

  it('derives alias from CLAUDE_CONFIG_DIR and writes correct filename', () => {
    const input = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 30, resets_at: 1750000000 },
        seven_day: { used_percentage: 12, resets_at: 1750400000 },
      },
    });

    execFileSync('node', [adapterPath, '--out-dir', outDir], {
      input,
      timeout: 5000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: '/Users/test/.claude-personal' },
    });

    assert.ok(fs.existsSync(path.join(outDir, 'claude-personal.json')), 'should write claude-personal.json');
    const snap = JSON.parse(fs.readFileSync(path.join(outDir, 'claude-personal.json'), 'utf8'));
    assert.equal(snap.id, 'claude-personal');
    assert.equal(snap.label, 'Claude · personal');
  });

  it('uses "default" alias when CLAUDE_CONFIG_DIR is ~/.claude', () => {
    const input = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 15, resets_at: 1750000000 },
      },
    });

    execFileSync('node', [adapterPath, '--out-dir', outDir], {
      input,
      timeout: 5000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude') },
    });

    assert.ok(fs.existsSync(path.join(outDir, 'claude-default.json')));
    const snap = JSON.parse(fs.readFileSync(path.join(outDir, 'claude-default.json'), 'utf8'));
    assert.equal(snap.id, 'claude-default');
    assert.equal(snap.label, 'Claude');
  });

  it('uses "default" alias when CLAUDE_CONFIG_DIR is unset', () => {
    const input = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 15, resets_at: 1750000000 },
      },
    });

    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    execFileSync('node', [adapterPath, '--out-dir', outDir], {
      input, timeout: 5000, env,
    });

    assert.ok(fs.existsSync(path.join(outDir, 'claude-default.json')));
  });
});
