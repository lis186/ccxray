'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { resolveProxyAgent, applyModelPrefix, stripInjectedStats, setStatusLineEnabled, getStatusLineEnabled, parseSSEFrame } = require('../server/forward');

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

describe('stripInjectedStats', () => {
  it('removes the status line from the last assistant text block', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world\n\n---\n📊 Context: 10.0% (20,000 / 200,000) | 20,000 in + 5 out' }],
      }],
    };
    assert.equal(stripInjectedStats(body), true);
    assert.equal(body.messages[0].content[0].text, 'Hello world');
  });

  it('removes the block entirely when only the status line remains', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: '\n\n---\n📊 Context: 10.0% (20,000 / 200,000) | 20,000 in + 5 out' }],
      }],
    };
    assert.equal(stripInjectedStats(body), true);
    assert.equal(body.messages[0].content.length, 0);
  });

  it('leaves messages without a status line untouched', () => {
    const body = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'No stats here' }],
      }],
    };
    assert.equal(stripInjectedStats(body), false);
    assert.equal(body.messages[0].content[0].text, 'No stats here');
  });

  it('ignores non-assistant messages', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Hello\n\n---\n📊 Context: 10.0% (20,000 / 200,000) | 20,000 in + 5 out' }],
      }],
    };
    assert.equal(stripInjectedStats(body), false);
    assert.ok(body.messages[0].content[0].text.includes('📊'));
  });

  it('returns false when messages is absent', () => {
    assert.equal(stripInjectedStats({}), false);
    assert.equal(stripInjectedStats(null), false);
  });
});

describe('statusLineEnabled flag', () => {
  beforeEach(() => setStatusLineEnabled(true));

  it('defaults to true', () => {
    assert.equal(getStatusLineEnabled(), true);
  });

  it('setStatusLineEnabled(false) disables the flag', () => {
    setStatusLineEnabled(false);
    assert.equal(getStatusLineEnabled(), false);
  });

  it('setStatusLineEnabled(true) re-enables the flag', () => {
    setStatusLineEnabled(false);
    setStatusLineEnabled(true);
    assert.equal(getStatusLineEnabled(), true);
  });
});

describe('parseSSEFrame', () => {
  it('captures OpenAI Responses SSE event names and data as raw events', () => {
    const frame = parseSSEFrame(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}',
      123
    );

    assert.equal(frame.event, 'response.output_text.delta');
    assert.equal(frame.type, 'response.output_text.delta');
    assert.equal(frame.data.delta, 'hello');
    assert.equal(frame._ts, 123);
  });

  it('preserves malformed SSE data for raw inspection', () => {
    const frame = parseSSEFrame('event: response.output_text.delta\ndata: {"delta":', 123);

    assert.equal(frame.event, 'response.output_text.delta');
    assert.equal(frame.type, 'response.output_text.delta');
    assert.equal(frame.parseError, true);
    assert.equal(frame.dataRaw, '{"delta":');
  });
});
