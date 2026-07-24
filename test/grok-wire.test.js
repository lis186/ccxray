'use strict';

// Grok CLI wire contract tests — synthetic fixtures shaped like live captures
// (Grok 0.2.93 × ccxray). No real ~/.grok or ~/.ccxray data.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const openai = require('../server/wire-parsers/openai');
const config = require('../server/config');
const { getParser } = require('../server/wire-parsers');
const { buildIndexLine } = require('../server/entry');
const { calculateCost, getModelPricing, buildPricingTable } = require('../server/pricing');
const providers = require('../server/providers');
const { extractPromptAgentType } = require('../server/system-prompt');
const { getOpenAIResponseFromEvents } = require('../server/openai-response');

const FIX = path.join(__dirname, 'fixtures', 'wire-parsers', 'grok');
const load = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

describe('Grok wire contract', () => {
  const mainReq = load('main_req.json');
  const titleReq = load('title_req.json');
  const mainHeaders = load('headers_main.json');
  const titleHeaders = load('headers_title.json');
  const sseEvents = load('main_sse_events.json');

  describe('client + routing', () => {
    it('detects Grok clients from headers', () => {
      assert.equal(config.isGrokClient(mainHeaders), true);
      assert.equal(config.isGrokClient(titleHeaders), true);
      assert.equal(config.isGrokClient({ 'user-agent': 'codex/0.133' }), false);
    });

    it('routes Grok /v1/responses to xAI upstream host', () => {
      const up = config.getUpstreamForRequestAndHeaders('/v1/responses', mainHeaders);
      assert.equal(up.host, config.UPSTREAMS.xai.host);
      assert.equal(up.provider, 'openai');
    });

    it('keeps Codex /v1/responses on OpenAI host', () => {
      const up = config.getUpstreamForRequestAndHeaders('/v1/responses', {});
      assert.equal(up.host, config.OPENAI_HOST);
    });

    it('chat/completions falls through to anthropic (no parser yet)', () => {
      assert.equal(config.getProviderForRequest('/v1/chat/completions'), 'anthropic');
    });
  });

  describe('session + agent', () => {
    it('main turn uses x-grok-session-id (not inferred)', () => {
      const body = openai.preprocessBody({ ...mainReq }, mainHeaders);
      const det = openai.detectSession(null, mainHeaders, body);
      assert.equal(det.sessionId, mainHeaders['x-grok-session-id']);
      assert.equal(det.inferred, false);
      assert.equal(body.metadata.client, 'grok');
      assert.equal(body.metadata.session_id, mainHeaders['x-grok-session-id']);
    });

    it('title-gen with empty session headers lands in grok-raw (not codex-raw)', () => {
      const body = openai.preprocessBody({ ...titleReq }, titleHeaders);
      const det = openai.detectSession(null, titleHeaders, body);
      assert.equal(det.sessionId, 'grok-raw');
      assert.equal(det.inferred, true);
      assert.equal(openai.resolveOpenAIAgent(titleHeaders, body), 'grok');
    });

    it('title-gen model alone is enough to label agent=grok', () => {
      assert.equal(openai.resolveOpenAIAgent({}, { model: 'grok-build' }), 'grok');
      assert.equal(openai.resolveOpenAIAgent({}, { model: 'gpt-5.5' }), 'codex');
    });
  });

  describe('system prompt + cwd', () => {
    it('reads system prompt from input[role=system] (not instructions)', () => {
      assert.equal(mainReq.instructions, undefined);
      const text = openai.getOpenAIInstructionsText(mainReq);
      assert.match(text, /You are Grok 4\.5/);
    });

    it('extracts Workspace Path from Grok user_info', () => {
      assert.equal(openai.extractOpenAICwd(mainReq), '/tmp/grok-ccxray-smoke');
    });

    it('extractPromptAgentType labels Grok main vs title', () => {
      const mainBody = openai.preprocessBody({ ...mainReq }, mainHeaders);
      const titleBody = openai.preprocessBody({ ...titleReq }, titleHeaders);
      const mainAt = extractPromptAgentType('openai', mainBody);
      const titleAt = extractPromptAgentType('openai', titleBody);
      assert.equal(mainAt.label, 'Grok');
      assert.equal(titleAt.label, 'Grok Title');
    });
  });

  describe('noise', () => {
    it('filters Grok control-plane under /v1/*', () => {
      for (const p of ['/v1/settings', '/v1/feedback/config', '/v1/models', '/v1/billing']) {
        assert.equal(openai.isNoiseRequest(p, mainHeaders, null), true, p);
      }
    });

    it('keeps conversation paths', () => {
      assert.equal(openai.isNoiseRequest('/v1/responses', mainHeaders, mainReq), false);
      assert.equal(openai.isNoiseRequest('/v1/chat/completions', mainHeaders, null), false);
    });

    it('does not noise-filter non-Grok /v1/settings', () => {
      assert.equal(openai.isNoiseRequest('/v1/settings', {}, null), false);
    });
  });

  describe('buildEntryFields + index + cost', () => {
    it('main turn entry is agent=grok with cost, 500k context, normalized usage', () => {
      const body = openai.preprocessBody({ ...mainReq }, mainHeaders);
      const response = getOpenAIResponseFromEvents(sseEvents);
      const fields = getParser('openai').buildEntryFields({
        provider: 'openai',
        transport: 'sse',
        parsedBody: body,
        events: sseEvents,
        response,
        proxyRes: { statusCode: 200 },
        sessionId: mainHeaders['x-grok-session-id'],
        sessionInferred: false,
        cwd: openai.extractOpenAICwd(body),
      });

      assert.equal(fields.provider, 'openai');
      assert.equal(fields.agent, 'grok');
      assert.equal(fields.model, 'grok-4.5');
      assert.equal(fields.sessionId, mainHeaders['x-grok-session-id']);
      assert.equal(fields.maxContext, 500_000);
      assert.equal(fields.cwd, '/tmp/grok-ccxray-smoke');
      assert.equal(fields.msgCount, 3);
      assert.equal(fields.toolCount, 2);
      assert.equal(fields.stopReason, 'completed');
      assert.match(fields.title || '', /pong|user_query/i);

      // usage: 30570 - 5504 cache = 25066 after normalize
      assert.ok(fields.usage);
      assert.equal(fields.usage.input_tokens, 25066);
      assert.equal(fields.usage.cache_read_input_tokens, 5504);
      assert.equal(fields.usage.output_tokens, 22);
      assert.equal(fields.usage._ccxrayUsageNormalized, true);

      assert.ok(fields.cost && fields.cost.cost != null, 'cost must resolve');
      assert.equal(fields.cost.warning, undefined);
      // 25066/1e6*2 + 22/1e6*6 + 5504/1e6*0.5
      const expected =
        (25066 / 1e6) * 2 + (22 / 1e6) * 6 + (5504 / 1e6) * 0.5;
      assert.ok(Math.abs(fields.cost.cost - expected) < 1e-12);

      const line = JSON.parse(buildIndexLine({
        id: 'test-id', ts: 't', elapsed: '1.0', status: 200, isSSE: true, receivedAt: 1,
        ...fields,
      }));
      assert.equal(line.agent, 'grok');
      assert.equal(line.maxContext, 500_000);
      assert.ok(line.cost.cost != null);
    });

    it('pricing for grok-4.5 comes from LiteLLM bare mirror; grok-build keeps lag override', () => {
      const table = buildPricingTable({
        'xai/grok-4.5': { input: 2, output: 6, cache_create: 0, cache_read: 0.5 },
      });
      assert.ok(table['grok-4.5'], 'bare wire id mirrors from xai/grok-4.5');
      assert.equal(table['grok-4.5'].input, 2);
      // Title-gen model still needs local override until LiteLLM lists it
      assert.ok(table['grok-build']);
      assert.equal(table['grok-build'].input, 1);
      const c = calculateCost({
        input_tokens: 1000, output_tokens: 10,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      }, 'grok-build');
      assert.equal(c.warning, undefined);
      assert.ok(c.cost > 0);
    });
  });

  describe('launcher', () => {
    it('ccxray grok injects GROK_CLI_CHAT_PROXY_BASE_URL', () => {
      const launch = providers.getAgentLaunch('grok', 5612, ['-p', 'hi'], { PATH: '/usr/bin' });
      assert.equal(launch.bin, 'grok');
      assert.equal(launch.env.GROK_CLI_CHAT_PROXY_BASE_URL, 'http://localhost:5612/v1');
      assert.equal(launch.upstream, 'openai');
    });
  });
});
