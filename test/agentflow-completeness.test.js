'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hostCompleteness, foldCompleteness } = require('../server/agentflow/completeness');

const c = (...sources) => ({ provider: 'anthropic', sessionId: 'S1', sources });

describe('hostCompleteness', () => {
  it('Claude: complete when every transcript turn has a proxy twin, proxy-only rows included', () => {
    assert.equal(hostCompleteness([c('import', 'proxy'), c('import', 'proxy'), c('proxy')]), 'complete');
  });
  it('Claude: partial when only some transcript turns have a twin (a pruned proxy turn)', () => {
    assert.equal(hostCompleteness([c('import', 'proxy'), c('import')]), 'partial proxy coverage');
  });
  it('Claude: transcripts only when no transcript turn has a twin', () => {
    assert.equal(hostCompleteness([c('import'), c('import')]), 'transcripts only');
  });
  it('Codex follows the session\'s single source', () => {
    const t = [{ provider: 'openai', sessionId: 'C1' }];
    assert.equal(hostCompleteness(t, { C1: 'proxy' }), 'complete');
    assert.equal(hostCompleteness(t, { C1: 'import' }), 'transcripts only');
  });
});

describe('foldCompleteness', () => {
  it('folds hosts of one Ask; no host is unknown (F24)', () => {
    assert.equal(foldCompleteness(['complete', 'complete']), 'complete');
    assert.equal(foldCompleteness(['transcripts only', 'transcripts only']), 'transcripts only');
    assert.equal(foldCompleteness(['complete', 'transcripts only']), 'partial proxy coverage');
    assert.equal(foldCompleteness([]), 'unknown');
  });
});
