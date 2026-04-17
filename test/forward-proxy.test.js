'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveProxyAgent, applyModelPrefix } = require('../server/forward');

describe('resolveProxyAgent', () => {
  it('returns null when no proxy env vars are set', () => {
    assert.equal(resolveProxyAgent('https', {}), null);
  });

  it('returns null when protocol is http', () => {
    assert.equal(resolveProxyAgent('http', { HTTPS_PROXY: 'http://proxy:3128' }), null);
  });

  it('returns an agent when HTTPS_PROXY is set (uppercase)', () => {
    const agent = resolveProxyAgent('https', { HTTPS_PROXY: 'http://proxy.example.com:3128' });
    assert.ok(agent != null);
    assert.equal(agent._proxyUrl, 'http://proxy.example.com:3128');
  });

  it('returns an agent when https_proxy is set (lowercase)', () => {
    const agent = resolveProxyAgent('https', { https_proxy: 'http://proxy.example.com:3128' });
    assert.ok(agent != null);
    assert.equal(agent._proxyUrl, 'http://proxy.example.com:3128');
  });

  it('HTTPS_PROXY takes precedence over https_proxy', () => {
    const agent = resolveProxyAgent('https', {
      HTTPS_PROXY: 'http://upper.proxy:3128',
      https_proxy: 'http://lower.proxy:3128',
    });
    assert.equal(agent._proxyUrl, 'http://upper.proxy:3128');
  });
});

describe('applyModelPrefix', () => {
  it('returns false when prefix is empty', () => {
    const body = { model: 'claude-sonnet-4-6' };
    assert.equal(applyModelPrefix(body, ''), false);
    assert.equal(body.model, 'claude-sonnet-4-6');
  });

  it('returns false when model already starts with prefix', () => {
    const body = { model: 'databricks-claude-sonnet-4-6' };
    assert.equal(applyModelPrefix(body, 'databricks-'), false);
  });

  it('prepends prefix and returns true', () => {
    const body = { model: 'claude-sonnet-4-6' };
    assert.equal(applyModelPrefix(body, 'databricks-'), true);
    assert.equal(body.model, 'databricks-claude-sonnet-4-6');
  });

  it('returns false when parsedBody has no model', () => {
    assert.equal(applyModelPrefix({}, 'databricks-'), false);
  });
});
