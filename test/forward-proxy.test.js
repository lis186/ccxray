'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveProxyAgent,
  applyModelPrefix,
  stripInjectedStats,
  setStatusLineEnabled,
  getStatusLineEnabled,
  parseSSEFrame,
  parseSSEText,
  normalizeOpenAIResponseSummary,
} = require('../server/forward');

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

describe('OpenAI Responses summary normalization', () => {
  it('parses SSE-shaped text and derives completed status metadata', () => {
    const raw = [
      'event: response.created',
      'data: ' + JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_1', object: 'response', model: 'gpt-5.5', status: 'in_progress' },
      }),
      '',
      'event: response.completed',
      'data: ' + JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          object: 'response',
          model: 'gpt-5.5',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
        },
      }),
      '',
    ].join('\n');

    const events = parseSSEText(raw, 123);
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'response.completed');

    const normalized = normalizeOpenAIResponseSummary({
      provider: 'openai',
      status: 200,
      responseMetadata: { provider: 'openai', status: 200 },
    }, raw);

    assert.equal(normalized.summary.isSSE, true);
    assert.equal(normalized.summary.model, 'gpt-5.5');
    assert.equal(normalized.summary.stopReason, 'completed');
    assert.equal(normalized.summary.usage.input_tokens, 10);
    assert.equal(normalized.summary.title, 'done');
    assert.equal(normalized.summary.responseMetadata.id, 'resp_1');
    assert.equal(normalized.summary.responseMetadata.responseStatus, 'completed');
    assert.equal(Array.isArray(normalized.resData), true);
  });
});
