'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFormatModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'format.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  return ctx;
}

describe('#420 Phase 3 aggregate cost formatting', () => {
  const ctx = loadFormatModule();

  it('#420 Phase 3 fail-on-old: aggregate helper marks fallback degradation', () => {
    assert.equal(ctx.formatAggCostText(19.58, { fallbackCost: 19.58, fallbackCount: 1, count: 1 }), '~$20');
  });

  it('marks the 10% threshold by cost share at 11%, not 9%', () => {
    assert.equal(ctx.formatAggCostText(100, { fallbackCost: 9, fallbackCount: 1, count: 20 }), '$100.00');
    assert.equal(ctx.formatAggCostText(100, { fallbackCost: 11, fallbackCount: 1, count: 20 }), '~$100.00');
  });

  it('marks the 10% threshold by count share independently', () => {
    assert.equal(ctx.formatAggCostText(100, { fallbackCost: 1, fallbackCount: 9, count: 100 }), '$100.00');
    assert.equal(ctx.formatAggCostText(100, { fallbackCost: 1, fallbackCount: 11, count: 100 }), '~$100.00');
  });

  it('degrades precision at 50% fallback share with two significant figures', () => {
    assert.equal(ctx.formatAggCostText(19.58, { fallbackCost: 19.58, fallbackCount: 1, count: 1 }), '~$20');
    assert.equal(ctx.formatAggCostText(0.0234, { fallbackCost: 0.0234, fallbackCount: 1, count: 1 }), '~$0.023');
    assert.equal(ctx.formatAggCostText(351.66, { fallbackCost: 1.05498, fallbackCount: 1, count: 100 }), '$351.66');
  });

  it('appends + for unknown turns and combines it with degradation', () => {
    assert.equal(ctx.formatAggCostText(10, { unknownCount: 1, count: 2 }), '$10.00+');
    assert.equal(ctx.formatAggCostText(19.58, { fallbackCost: 19.58, fallbackCount: 1, unknownCount: 1, count: 2 }), '~$20+');
  });

  it('renders all-unknown and null totals as — without a suffix', () => {
    assert.equal(ctx.formatAggCostText(10, { unknownCount: 2, count: 2 }), '—');
    assert.equal(ctx.formatAggCostText(null, { unknownCount: 1, count: 1 }), '—');
  });

  it('treats an empty or legacy fold as clean', () => {
    assert.equal(ctx.formatAggCostText(1.234, {}), '$1.23');
    assert.equal(ctx.formatAggCostText(1.234, { fallbackCost: undefined, fallbackCount: undefined, unknownCount: undefined, count: undefined }), '$1.23');
    assert.ok(!ctx.formatAggCost(1.234, {}).includes('title='));
  });

  it('includes fallback and unknown tooltip details on the HTML helper', () => {
    const html = ctx.formatAggCost(19.58, {
      fallbackCost: 7.832,
      fallbackCount: 2,
      unknownCount: 1,
      count: 4,
    });
    assert.ok(html.includes('<span title='));
    assert.ok(html.includes('~$19.58+'));
    assert.ok(html.includes('2/4 筆使用預設費率（佔 40.0%），可能不準確'));
    assert.ok(html.includes('1 筆無費率資料，未計入總額'));
    assert.equal(ctx.formatAggCostText(19.58, { fallbackCost: 7.832, fallbackCount: 2, unknownCount: 1, count: 4 }).includes('<'), false);
  });
});
