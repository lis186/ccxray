'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const {
  calculateCostSimple,
  processGrokIndexEntry,
  processGrokIndexFile,
  scanGrokFromCcxrayIndex,
} = require('../server/cost-worker');

describe('cost-worker Grok index source', () => {
  it('processGrokIndexEntry accepts agent=grok with usage + nested cost', () => {
    const e = processGrokIndexEntry({
      id: '2026-07-19T08-55-50-786',
      agent: 'grok',
      model: 'grok-4.5-build',
      sessionId: '019f77df-36ae-7240-b081-27493814d0b5',
      receivedAt: 1_784_422_550_786,
      usage: {
        input_tokens: 19512,
        output_tokens: 30,
        cache_read_input_tokens: 4864,
        cache_creation_input_tokens: 0,
      },
      cost: { cost: 0.041636, rates: { input: 2, output: 6, cache_read: 0.5, cache_create: 0 } },
    });
    assert.ok(e);
    assert.equal(e.accountId, 'grok-default');
    assert.equal(e.model, 'grok-4.5-build');
    assert.equal(e.sessionId, '019f77df-36ae-7240-b081-27493814d0b5');
    assert.equal(e.timestamp, 1_784_422_550_786);
    assert.equal(e.costUSD, 0.041636);
    assert.equal(e.messageId, 'grok::2026-07-19T08-55-50-786');
  });

  it('processGrokIndexEntry ignores non-grok and empty usage', () => {
    assert.equal(processGrokIndexEntry({ agent: 'claude', usage: { input_tokens: 1 } }), null);
    assert.equal(processGrokIndexEntry({ agent: 'grok', usage: null }), null);
    assert.equal(processGrokIndexEntry({
      agent: 'grok',
      id: '2026-07-19T08-55-50-786',
      usage: { input_tokens: 0, output_tokens: 0 },
    }), null);
  });

  it('processGrokIndexEntry falls back to calculateCostSimple when cost missing', () => {
    const e = processGrokIndexEntry({
      id: '2026-07-19T08-55-50-786',
      agent: 'grok',
      model: 'grok-4.5-build',
      receivedAt: 1_000,
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    assert.ok(e);
    // $2 / MTok input → $2.00 for 1M tokens
    assert.equal(e.costUSD, 2);
  });

  it('calculateCostSimple longest-prefix matches grok-4.5-build to grok-4.5 rates', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    assert.equal(calculateCostSimple(usage, 'grok-4.5-build'), 2);
    assert.equal(calculateCostSimple(usage, 'grok-build'), 1);
  });

  it('processGrokIndexFile streams only grok rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cw-'));
    const indexPath = path.join(dir, 'index.ndjson');
    const lines = [
      JSON.stringify({ id: '2026-07-19T08-00-00-000', agent: 'claude', usage: { input_tokens: 10, output_tokens: 1 }, receivedAt: 1 }),
      JSON.stringify({
        id: '2026-07-19T08-55-50-786',
        agent: 'grok',
        model: 'grok-4.5-build',
        sessionId: 's1',
        receivedAt: 2,
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
        cost: { cost: 0.05 },
      }),
      'not-json',
      JSON.stringify({
        id: '2026-07-19T08-55-50-784',
        agent: 'grok',
        model: 'grok-build',
        sessionId: 'grok-raw',
        receivedAt: 3,
        usage: { input_tokens: 32, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        cost: { cost: 0.002 },
      }),
    ];
    fs.writeFileSync(indexPath, lines.join('\n') + '\n');
    const rows = await processGrokIndexFile(indexPath);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].costUSD, 0.05);
    assert.equal(rows[1].accountId, 'grok-default');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scanGrokFromCcxrayIndex respects CCXRAY_HOME', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-home-'));
    const logs = path.join(home, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'index.ndjson'), JSON.stringify({
      id: '2026-07-19T09-00-00-000',
      agent: 'grok',
      model: 'grok-4.5',
      receivedAt: 42,
      usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      cost: { cost: 0.01 },
    }) + '\n');
    const seen = new Set();
    const entries = [];
    await scanGrokFromCcxrayIndex(seen, entries, { CCXRAY_HOME: home });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].costUSD, 0.01);
    assert.ok(seen.has('grok::2026-07-19T09-00-00-000'));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('forked cost-worker emits grok-default rows from index (integration)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-home-'));
    const logs = path.join(home, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'index.ndjson'), [
      JSON.stringify({
        id: '2026-07-19T10-00-00-000',
        agent: 'grok',
        model: 'grok-4.5-build',
        sessionId: 'sess-a',
        receivedAt: Date.parse('2026-07-19T10:00:00Z'),
        usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        cost: { cost: 0.0123 },
      }),
    ].join('\n') + '\n');

    const workerPath = path.join(__dirname, '..', 'server', 'cost-worker.js');
    const rows = await new Promise((resolve, reject) => {
      const child = fork(workerPath, [], {
        silent: true,
        env: { ...process.env, CCXRAY_HOME: home, HOME: home },
      });
      const chunks = [];
      let err = '';
      child.stdout.on('data', c => chunks.push(c));
      child.stderr.on('data', c => { err += c; });
      child.on('error', reject);
      child.on('exit', code => {
        if (code !== 0) return reject(new Error(err || `exit ${code}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]'));
        } catch (e) {
          reject(e);
        }
      });
    });

    const grok = rows.filter(r => r.accountId === 'grok-default');
    assert.equal(grok.length, 1);
    assert.equal(grok[0].costUSD, 0.0123);
    assert.equal(grok[0].model, 'grok-4.5-build');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
