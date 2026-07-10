'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #170 — extract-and-test pure logic from public/cost-budget-ui.js.
// These functions don't touch the DOM, so we load the file into a bare vm
// context (no document/window needed) and read the globals it defines.
function loadContext() {
  const publicDir = path.join(__dirname, '..', 'public');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'cost-budget-ui.js'), 'utf8'), context);
  return context;
}

describe('cost-budget-ui: acctColor(accountId)', () => {
  const ctx = loadContext();
  it('returns the dim color for a falsy accountId', () => {
    assert.equal(ctx.acctColor(null), 'var(--dim)');
    assert.equal(ctx.acctColor(undefined), 'var(--dim)');
    assert.equal(ctx.acctColor(''), 'var(--dim)');
  });
  it('returns the openai brand color for codex accounts', () => {
    assert.equal(ctx.acctColor('codex-default'), '#74aa9c');
    assert.equal(ctx.acctColor('codex-work'), '#74aa9c');
  });
  it('returns the anthropic brand color for anything else', () => {
    assert.equal(ctx.acctColor('claude-default'), '#e8956a');
    assert.equal(ctx.acctColor('anthropic-personal'), '#e8956a');
  });
});

describe('cost-budget-ui: acctLabel(accountId, allAccounts)', () => {
  const ctx = loadContext();
  it('returns "Unknown" for a falsy accountId', () => {
    assert.equal(ctx.acctLabel(null), 'Unknown');
    assert.equal(ctx.acctLabel(''), 'Unknown');
  });
  it('shows the alias when it is not "default"', () => {
    assert.equal(ctx.acctLabel('claude-personal', []), 'Claude · personal');
    assert.equal(ctx.acctLabel('codex-work', []), 'Codex · work');
  });
  it('collapses "default" alias to the bare provider name when it is the only account', () => {
    assert.equal(ctx.acctLabel('claude-default', ['claude-default']), 'Claude');
  });
  it('shows "· default" for the default alias only when sibling accounts of the same provider exist', () => {
    assert.equal(ctx.acctLabel('claude-default', ['claude-default', 'claude-work']), 'Claude · default');
    // sibling of a different provider must not trigger the "· default" suffix
    assert.equal(ctx.acctLabel('claude-default', ['claude-default', 'codex-work']), 'Claude');
  });
});

describe('cost-budget-ui: collectAccounts(dailyData)', () => {
  const ctx = loadContext();
  it('returns an empty array when no day has byAccount data', () => {
    assert.equal(ctx.collectAccounts([]).length, 0);
    assert.equal(ctx.collectAccounts([{ date: '2026-07-01' }]).length, 0);
  });
  it('collects and sorts unique account ids across days', () => {
    const daily = [
      { date: '2026-07-01', byAccount: { 'codex-default': {}, 'claude-personal': {} } },
      { date: '2026-07-02', byAccount: { 'claude-personal': {} } },
    ];
    // Arrays built inside the vm context aren't reference-equal to Array literals in
    // this realm (different Array.prototype) — compare via JSON like messages-ui.test.js does.
    assert.equal(JSON.stringify(ctx.collectAccounts(daily)), JSON.stringify(['claude-personal', 'codex-default']));
  });
  it('includes accounts from the cached rate-limit block data even with no cost history', () => {
    // simulate loadCostPage() having populated the module-level cache
    vm.runInContext("_costPageCache = { blockData: { accounts: [{ id: 'claude-nocost' }] } };", ctx);
    const daily = [{ date: '2026-07-01', byAccount: { 'codex-default': {} } }];
    assert.equal(JSON.stringify(ctx.collectAccounts(daily)), JSON.stringify(['claude-nocost', 'codex-default']));
  });
});

describe('cost-budget-ui: filterMatchesAccount(filter, acctId)', () => {
  const ctx = loadContext();
  it('matches everything when filter is falsy (All)', () => {
    assert.equal(ctx.filterMatchesAccount(null, 'claude-default'), true);
    assert.equal(ctx.filterMatchesAccount('', 'codex-work'), true);
  });
  it('matches by provider prefix for wildcard filters', () => {
    assert.equal(ctx.filterMatchesAccount('claude:*', 'claude-default'), true);
    assert.equal(ctx.filterMatchesAccount('claude:*', 'codex-default'), false);
  });
  it('matches exact account id for non-wildcard filters', () => {
    assert.equal(ctx.filterMatchesAccount('claude-personal', 'claude-personal'), true);
    assert.equal(ctx.filterMatchesAccount('claude-personal', 'claude-default'), false);
  });
});

describe('cost-budget-ui: filteredCost(day, filter)', () => {
  const ctx = loadContext();
  it('returns the day total cost when no filter is active', () => {
    assert.equal(ctx.filteredCost({ costUSD: 1.5 }, null), 1.5);
    assert.equal(ctx.filteredCost({}, null), 0);
  });
  it('returns 0 for a filtered day with no byAccount breakdown', () => {
    assert.equal(ctx.filteredCost({ costUSD: 2 }, 'claude-default'), 0);
  });
  it('returns the exact account cost for a non-wildcard filter', () => {
    const day = { costUSD: 3, byAccount: { 'claude-default': { costUSD: 1 }, 'codex-default': { costUSD: 2 } } };
    assert.equal(ctx.filteredCost(day, 'claude-default'), 1);
  });
  it('sums matching accounts for a wildcard provider filter', () => {
    const day = { costUSD: 5, byAccount: { 'claude-a': { costUSD: 1 }, 'claude-b': { costUSD: 2 }, 'codex-x': { costUSD: 2 } } };
    assert.equal(ctx.filteredCost(day, 'claude:*'), 3);
  });
});
