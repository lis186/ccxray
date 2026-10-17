'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveProxyAgent,
  applyModelPrefix,
  stripInjectedStats,
  describeUpstreamError,
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

describe('describeUpstreamError', () => {
  it('classifies ETIMEDOUT as retryable with hint', () => {
    const info = describeUpstreamError({ code: 'ETIMEDOUT' }, 'api.anthropic.com');
    assert.equal(info.retryable, true);
    assert.match(info.summary, /api\.anthropic\.com.*timed out.*ETIMEDOUT/);
    assert.ok(info.hint);
  });

  it('classifies ENOTFOUND as retryable with hint', () => {
    const info = describeUpstreamError({ code: 'ENOTFOUND' }, 'api.anthropic.com');
    assert.equal(info.retryable, true);
    assert.match(info.summary, /DNS lookup failed/);
    assert.ok(info.hint);
  });

  it('classifies EHOSTUNREACH as retryable', () => {
    const info = describeUpstreamError({ code: 'EHOSTUNREACH' }, 'example.com');
    assert.equal(info.retryable, true);
    assert.match(info.summary, /unreachable/);
  });

  it('classifies ECONNRESET as non-retryable', () => {
    const info = describeUpstreamError({ code: 'ECONNRESET' }, 'example.com');
    assert.equal(info.retryable, false);
    assert.match(info.summary, /reset/);
    assert.equal(info.hint, null);
  });

  it('classifies EPIPE as non-retryable', () => {
    const info = describeUpstreamError({ code: 'EPIPE' }, 'example.com');
    assert.equal(info.retryable, false);
  });

  it('falls back to err.message for unknown codes', () => {
    const info = describeUpstreamError({ code: 'EWHATEVER', message: 'something broke' }, 'host');
    assert.equal(info.retryable, false);
    assert.match(info.summary, /something broke/);
  });

  it('handles missing code gracefully', () => {
    const info = describeUpstreamError({ message: 'oops' }, 'host');
    assert.equal(info.retryable, false);
    assert.match(info.summary, /oops/);
    assert.equal(info.code, '');
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

// Exercise both private production helpers without adding a test-only public API.
describe('request deployment identity isolation (#505, #672)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const registeredIdentity = { agentId: 'registered-client', agentType: 'codex' };

  function loadDeploymentFields(filename) {
    const file = path.join(__dirname, '../server', filename);
    const localRequire = createRequire(file);
    const realHub = localRequire('./hub');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports = requestDeploymentFields;', {
      require: name => name === './hub' ? {
        ...realHub,
        hasClients: () => true,
        // Model a registered identity supplied by hub lookup without a URL route.
        lookupClientIdentityForRequest: req => req.ccxrayAgentId
          ? { agentId: req.ccxrayAgentId }
          : registeredIdentity,
      } : localRequire(name),
      module, process, console, Buffer, __dirname: path.dirname(file),
    }, { filename: file });
    return module.exports;
  }

  for (const filename of ['forward.js', 'ws-proxy.js']) {
    for (const route of ['registered-unrouted', 'registered-routed', 'pane-url']) {
      it(`${filename}: ${route} only permits env identity for the pane URL`, () => {
        const env = {
          CCXRAY_USER_EMAIL: 'hub@example.test', CCXRAY_TEAM: 'hub-team',
          CCXRAY_AGENT_TYPE: 'codex',
        };
        const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
        Object.assign(process.env, env);
        try {
          const fieldsForRequest = loadDeploymentFields(filename);
          const req = { headers: {} };
          if (route === 'pane-url') req.ccxrayAgentId = 'herdr:w1:launch';
          if (route === 'registered-routed') req.ccxrayClientPid = 123;
          const fields = filename === 'forward.js'
            ? fieldsForRequest(1, 'openai', req, {})
            : fieldsForRequest(1, req, {});
          assert.equal(fields.agentId, route === 'pane-url' ? req.ccxrayAgentId : registeredIdentity.agentId);
          assert.equal(fields.userEmail, route === 'pane-url' ? env.CCXRAY_USER_EMAIL : undefined);
          assert.equal(fields.team, route === 'pane-url' ? env.CCXRAY_TEAM : undefined);
          assert.equal(fields.agentType, 'codex');
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
          }
        }
      });
    }
  }
});
