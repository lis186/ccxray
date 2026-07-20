'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildGrokSnapFromBilling,
  refreshGrokFromBillingBody,
  isGrokBillingPath,
} = require('../server/adapters/grok-adapter');
const { readAllAccounts } = require('../server/local-usage-reader');

/** CLI /usage weekly SuperGrok pool: GET /v1/billing?format=credits */
const SAMPLE_CREDITS = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-07-18T11:42:32.223711+00:00',
      end: '2026-07-25T11:42:32.223711+00:00',
    },
    creditUsagePercent: 44,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [
      { product: 'GrokBuild', usagePercent: 44 },
      { product: 'Api' },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    billingPeriodStart: '2026-07-18T11:42:32.223711+00:00',
    billingPeriodEnd: '2026-07-25T11:42:32.223711+00:00',
  },
};

/** Fallback monthly credit meter: GET /v1/billing (no format=credits) */
const SAMPLE_MONTHLY = {
  config: {
    monthlyLimit: { val: 15000 },
    used: { val: 7015 },
    onDemandCap: { val: 0 },
    billingPeriodStart: '2026-07-01T00:00:00+00:00',
    billingPeriodEnd: '2026-08-01T00:00:00+00:00',
    history: [],
  },
};

describe('Grok CLI /v1/billing → account snap', () => {
  it('isGrokBillingPath matches CLI billing endpoint', () => {
    assert.equal(isGrokBillingPath('/v1/billing'), true);
    assert.equal(isGrokBillingPath('/v1/billing?format=credits'), true);
    assert.equal(isGrokBillingPath('/v1/billing?x=1'), true);
    assert.equal(isGrokBillingPath('/v1/responses'), false);
  });

  it('buildGrokSnapFromBilling maps format=credits to Weekly SuperGrok Limit', () => {
    const snap = buildGrokSnapFromBilling(SAMPLE_CREDITS, { nowMs: Date.UTC(2026, 6, 19, 12) });
    assert.ok(snap);
    assert.equal(snap.id, 'grok-default');
    assert.equal(snap.provider, 'xai');
    assert.equal(snap.fiveHour, null);
    assert.equal(snap.source, 'billing-credits');
    assert.equal(snap.sevenDay.usedPct, 44);
    assert.equal(snap.sevenDay.unit, 'pct');
    assert.equal(snap.sevenDay.windowLabel, 'Weekly SuperGrok Limit');
    assert.equal(snap.sevenDay.periodStart, '2026-07-18T11:42:32.223711+00:00');
    assert.equal(snap.sevenDay.periodEnd, '2026-07-25T11:42:32.223711+00:00');
    assert.equal(
      snap.sevenDay.resetsAt,
      Math.floor(Date.parse('2026-07-25T11:42:32.223711+00:00') / 1000),
    );
    assert.equal(snap.sevenDay.periodType, 'USAGE_PERIOD_TYPE_WEEKLY');
  });

  it('writes credits snap readable by local-usage-reader with left% + resetLabel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bill-'));
    try {
      const snap = refreshGrokFromBillingBody(SAMPLE_CREDITS, dir);
      assert.ok(snap);
      const p = path.join(dir, 'grok-default.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      j.updatedAt = Math.floor(Date.now() / 1000);
      fs.writeFileSync(p, JSON.stringify(j));

      const accounts = readAllAccounts(dir);
      assert.equal(accounts.length, 1);
      const a = accounts[0];
      assert.equal(a.fiveHour, null);
      assert.equal(a.sevenDay.usedPct, 44);
      assert.equal(a.sevenDay.leftPct, 56);
      assert.ok(a.sevenDay.resetLabel, 'should have Resets in … from period end');
      assert.equal(a.sevenDay.periodEnd, '2026-07-25T11:42:32.223711+00:00');
      assert.equal(a.sevenDay.windowLabel, 'Weekly SuperGrok Limit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to monthlyLimit/used when format=credits fields absent', () => {
    const snap = buildGrokSnapFromBilling(SAMPLE_MONTHLY, { nowMs: Date.UTC(2026, 6, 15, 12) });
    assert.ok(snap);
    assert.equal(snap.source, 'billing');
    assert.equal(snap.sevenDay.usedPct, 46.8);
    assert.equal(snap.sevenDay.used, 7015);
    assert.equal(snap.sevenDay.limit, 15000);
    assert.equal(snap.sevenDay.windowLabel, 'Monthly');
    assert.equal(snap.sevenDay.resetsAt, Math.floor(Date.parse('2026-08-01T00:00:00+00:00') / 1000));
  });

  it('returns null on malformed billing body', () => {
    assert.equal(buildGrokSnapFromBilling(null), null);
    assert.equal(buildGrokSnapFromBilling({}), null);
    assert.equal(buildGrokSnapFromBilling({ config: {} }), null);
  });
});
