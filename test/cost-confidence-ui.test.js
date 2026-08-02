'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load format.js in a VM context to test browser globals
function loadFormatModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'format.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  return ctx;
}

describe('#420 Phase 2: cost confidence UI', () => {
  describe('formatCostText', () => {
    const { formatCostText } = loadFormatModule();

    it('exact confidence → normal $', () => {
      assert.equal(formatCostText(0.1234, 'exact'), '$0.1234');
    });

    it('prefix confidence → normal $', () => {
      assert.equal(formatCostText(0.1234, 'prefix'), '$0.1234');
    });

    it('fallback confidence → ~$ prefix', () => {
      assert.equal(formatCostText(0.5678, 'fallback'), '~$0.5678');
    });

    it('unknown confidence → —', () => {
      assert.equal(formatCostText(null, 'unknown'), '—');
    });

    it('null confidence (legacy data) → normal $', () => {
      assert.equal(formatCostText(0.1234, null), '$0.1234');
    });

    it('undefined confidence (legacy data) → normal $', () => {
      assert.equal(formatCostText(0.1234, undefined), '$0.1234');
    });

    it('respects decimal override', () => {
      assert.equal(formatCostText(0.1234, 'exact', 2), '$0.12');
      assert.equal(formatCostText(0.1234, 'fallback', 2), '~$0.12');
    });

    it('cost null + confidence null → —', () => {
      assert.equal(formatCostText(null, null), '—');
    });

    it('cost zero + exact → $0.0000', () => {
      assert.equal(formatCostText(0, 'exact'), '$0.0000');
    });
  });

  describe('formatCost (HTML version)', () => {
    const { formatCost } = loadFormatModule();

    it('fallback → span with title tooltip', () => {
      const html = formatCost(0.1234, 'fallback');
      assert.ok(html.includes('~$0.1234'), 'should have ~$ prefix');
      assert.ok(html.includes('title='), 'should have title attribute');
    });

    it('exact → span without title', () => {
      const html = formatCost(0.1234, 'exact');
      assert.ok(html.includes('$0.1234'));
      assert.ok(!html.includes('title='), 'should not have title attribute');
    });

    it('unknown → — (no span wrapper)', () => {
      assert.equal(formatCost(null, 'unknown'), '—');
    });
  });

  describe('costConfidence extraction (addEntry shape)', () => {
    // Simulate the extraction logic from entry-rendering.js L380-381
    function extractCostFields(e) {
      const turnCost = e.cost?.cost != null ? e.cost.cost : (typeof e.cost === 'number' ? e.cost : null);
      const costConfidence = e.cost?.confidence || null;
      return { turnCost, costConfidence };
    }

    it('extracts cost and confidence from Phase 1 cost object', () => {
      const e = { cost: { cost: 0.1234, rates: {}, confidence: 'exact' } };
      const { turnCost, costConfidence } = extractCostFields(e);
      assert.equal(turnCost, 0.1234);
      assert.equal(costConfidence, 'exact');
    });

    it('extracts fallback confidence', () => {
      const e = { cost: { cost: 0.5678, rates: {}, confidence: 'fallback' } };
      const { turnCost, costConfidence } = extractCostFields(e);
      assert.equal(turnCost, 0.5678);
      assert.equal(costConfidence, 'fallback');
    });

    it('handles legacy bare-number cost (no confidence)', () => {
      const e = { cost: 0.1234 };
      const { turnCost, costConfidence } = extractCostFields(e);
      assert.equal(turnCost, 0.1234);
      assert.equal(costConfidence, null);
    });

    it('handles legacy cost object without confidence field', () => {
      const e = { cost: { cost: 0.1234 } };
      const { turnCost, costConfidence } = extractCostFields(e);
      assert.equal(turnCost, 0.1234);
      assert.equal(costConfidence, null);
    });

    it('handles unknown model (null cost)', () => {
      const e = { cost: { cost: null, confidence: 'unknown' } };
      const { turnCost, costConfidence } = extractCostFields(e);
      assert.equal(turnCost, null);
      assert.equal(costConfidence, 'unknown');
    });
  });

  describe('_patchEntryInPlace preserves costConfidence (as-a-unit)', () => {
    // Mirror the real patch logic from entry-rendering.js (fable MINOR-1 fix):
    // confidence only updates when cost.cost is accepted.
    function applyPatch(full, u) {
      if (u.cost != null) {
        if (u.cost && u.cost.cost != null) {
          full.cost = u.cost.cost;
          if (u.cost.confidence) full.costConfidence = u.cost.confidence;
        } else if (typeof u.cost === 'number') {
          full.cost = u.cost;
        }
      }
    }

    it('patches cost and confidence together', () => {
      const full = { cost: 0.1, costConfidence: null };
      applyPatch(full, { cost: { cost: 0.2, confidence: 'fallback' } });
      assert.equal(full.cost, 0.2);
      assert.equal(full.costConfidence, 'fallback');
    });

    it('does not overwrite costConfidence when update has no confidence', () => {
      const full = { cost: 0.1, costConfidence: 'exact' };
      applyPatch(full, { cost: { cost: 0.2 } });
      assert.equal(full.cost, 0.2);
      assert.equal(full.costConfidence, 'exact');
    });

    it('null-cost patch does NOT poison existing confidence (fable MINOR-1)', () => {
      const full = { cost: 0.1234, costConfidence: 'exact' };
      applyPatch(full, { cost: { cost: null, confidence: 'unknown' } });
      assert.equal(full.cost, 0.1234, 'cost must not change');
      assert.equal(full.costConfidence, 'exact', 'confidence must not change');
    });

    it('bare-number patch preserves existing confidence', () => {
      const full = { cost: 0.1, costConfidence: 'exact' };
      applyPatch(full, { cost: 0.2 });
      assert.equal(full.cost, 0.2);
      assert.equal(full.costConfidence, 'exact', 'confidence preserved');
    });
  });
});
