'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-pricing-context-cache-'));
const FIX_HOME = path.join(FIXTURE_ROOT, 'home');
const LOGS_DIR = path.join(FIX_HOME, 'logs');
const CACHE_PATH = path.join(FIXTURE_ROOT, 'pricing-cache.json');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.writeFileSync(path.join(LOGS_DIR, 'index.ndjson'), JSON.stringify({ id: 'synthetic-pricing-context-test' }) + '\n');
process.env.CCXRAY_HOME = FIX_HOME;
process.env.CCXRAY_EXPORT_DISABLE = '1';
process.env.CCXRAY_IMPORT_DISABLE = '1';
process.env.CCXRAY_PRICING_CACHE = CACHE_PATH;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.CCXRAY_HUB_CLIENT_PID;
process.on('exit', () => { try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch {} });

const context = { 'claude-sonnet-5': 200_000 };
for (let i = 0; i < 6_000; i++) context[`synthetic-model-${i}`] = 8_192;
fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context }));

const pricing = require('../server/pricing');

describe('context window lookup after cached fetch', () => {
  it('does not re-enumerate a warm context table across lookups', async () => {
    await pricing.fetchPricing();

    const originalKeys = Object.keys;
    const originalHasOwn = Object.hasOwn;
    let tableEnumerations = 0;
    Object.keys = function countedKeys(value) {
      if (value && originalHasOwn(value, 'claude-sonnet-5')) tableEnumerations++;
      return originalKeys(value);
    };

    try {
      for (let i = 0; i < 100; i++) {
        assert.equal(pricing.getModelContext('claude-sonnet-5'), 200_000);
      }
    } finally {
      Object.keys = originalKeys;
    }

    assert.ok(tableEnumerations <= 1,
      `Object.keys enumerated the warm context table ${tableEnumerations} times for 100 lookups`);
  });
});
