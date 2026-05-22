'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { stripAuthParams, AUTH_QUERY_PARAMS } = require('../server/url-sanitize');

describe('stripAuthParams', () => {
  it('returns the URL unchanged when no query string is present', () => {
    assert.equal(stripAuthParams('/v1/messages'), '/v1/messages');
    assert.equal(stripAuthParams('/v1/responses'), '/v1/responses');
    assert.equal(stripAuthParams('/'), '/');
  });

  it('returns the URL unchanged when no auth param is present', () => {
    assert.equal(stripAuthParams('/v1/models?client_version=0.125.0'), '/v1/models?client_version=0.125.0');
    assert.equal(stripAuthParams('/v1/realtime?model=gpt-realtime'), '/v1/realtime?model=gpt-realtime');
  });

  it('strips ?token= as the sole query param and drops the question mark', () => {
    assert.equal(stripAuthParams('/v1/messages?token=secret'), '/v1/messages');
    assert.equal(stripAuthParams('/_api/entries?token=abc123'), '/_api/entries');
  });

  it('strips token when mixed with other params, preserving the rest', () => {
    assert.equal(
      stripAuthParams('/v1/realtime?model=gpt-realtime&token=secret'),
      '/v1/realtime?model=gpt-realtime'
    );
    assert.equal(
      stripAuthParams('/v1/realtime?token=secret&model=gpt-realtime'),
      '/v1/realtime?model=gpt-realtime'
    );
    assert.equal(
      stripAuthParams('/path?a=1&token=secret&b=2'),
      '/path?a=1&b=2'
    );
  });

  it('strips an empty token value as well', () => {
    assert.equal(stripAuthParams('/path?token='), '/path');
    assert.equal(stripAuthParams('/path?token=&other=1'), '/path?other=1');
  });

  it('handles repeated token params (deletes all occurrences)', () => {
    assert.equal(stripAuthParams('/path?token=a&token=b'), '/path');
    assert.equal(stripAuthParams('/path?token=a&keep=1&token=b'), '/path?keep=1');
  });

  it('does NOT strip params whose names merely contain the substring "token"', () => {
    // Upstream API keys may live in headers, but if any future query param
    // contained "token" as a substring (e.g. continuation_token), we must
    // leave it alone.
    assert.equal(stripAuthParams('/path?continuation_token=xyz'), '/path?continuation_token=xyz');
    assert.equal(stripAuthParams('/path?access_token_hint=1'), '/path?access_token_hint=1');
  });

  it('preserves URL encoding of values it keeps', () => {
    const url = '/path?greeting=hello%20world&token=secret';
    assert.equal(stripAuthParams(url), '/path?greeting=hello+world');
    // URLSearchParams normalizes %20 → + on round-trip; that's fine for forwarded
    // paths because + is also a valid space encoding in query strings.
  });

  it('returns non-string inputs unchanged', () => {
    assert.equal(stripAuthParams(undefined), undefined);
    assert.equal(stripAuthParams(null), null);
    assert.equal(stripAuthParams(''), '');
    assert.equal(stripAuthParams(123), 123);
  });

  it('exports a frozen AUTH_QUERY_PARAMS list', () => {
    assert.ok(Array.isArray(AUTH_QUERY_PARAMS));
    assert.ok(AUTH_QUERY_PARAMS.includes('token'));
    assert.ok(Object.isFrozen(AUTH_QUERY_PARAMS));
  });
});
