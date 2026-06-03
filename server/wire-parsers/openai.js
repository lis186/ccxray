'use strict';

const store = require('../store');
const helpers = require('../helpers');
const config = require('../config');
const { calculateCost } = require('../pricing');
const { agentForProvider } = require('../providers');
const {
  getOpenAIResponseFromEvents, getOpenAIInputSummary,
  getOpenAIOutputSummary, buildResponseMetadata,
} = require('../openai-response');

// ── Low-level helpers (also exported for ws-proxy.js) ───────

function firstHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseCodexTurnMetadata(headers) {
  const raw = firstHeader(headers, 'x-codex-turn-metadata');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getCodexSessionId(headers, parsedBody) {
  const direct = firstHeader(headers, 'session_id') || firstHeader(headers, 'x-openai-session-id');
  if (direct) return String(direct);
  const turnMetadata = parseCodexTurnMetadata(headers);
  if (typeof turnMetadata?.session_id === 'string') return turnMetadata.session_id;
  return parsedBody?.metadata?.session_id || null;
}

function getCodexRawSessionId() {
  return 'codex-raw';
}

function getOpenAIAgentTypeFromHeaders(headers) {
  const subagent = firstHeader(headers, 'x-openai-subagent');
  const direct = firstHeader(headers, 'x-openai-agent-type') || firstHeader(headers, 'x-codex-agent-type');
  const turnMetadata = parseCodexTurnMetadata(headers);
  const value = direct || turnMetadata?.agent_type || subagent;
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  if (normalized === 'explorer' || normalized === 'worker' || normalized === 'default') return normalized;
  return null;
}

function isOpenAISubagent(headers, parsedBody) {
  const raw = firstHeader(headers, 'x-openai-subagent');
  if (raw != null) {
    const text = String(raw).toLowerCase();
    return text !== '0' && text !== 'false' && text !== 'no';
  }
  return Boolean(parsedBody?.metadata?.is_subagent || parsedBody?.metadata?.isSubagent);
}

function withCodexMetadata(parsedBody, headers) {
  if (!parsedBody || typeof parsedBody !== 'object') return parsedBody;
  const sessionId = getCodexSessionId(headers, parsedBody);
  const agentType = getOpenAIAgentTypeFromHeaders(headers);
  if (!sessionId && !agentType) return parsedBody;
  const metadata = parsedBody.metadata && typeof parsedBody.metadata === 'object'
    ? { ...parsedBody.metadata }
    : {};
  if (sessionId && !metadata.session_id) metadata.session_id = sessionId;
  if (agentType && !metadata.agent_type) metadata.agent_type = agentType;
  return { ...parsedBody, metadata };
}

// ── WIRE_PARSERS interface ──────────────────────────────────

// From config.js:169-177 (isCodexPlatformNoisePath)
function isNoiseRequest(url, _headers, _parsedBody) {
  const pathname = (url || '').split('?')[0];
  if (pathname === '/v1/plugins' || pathname.startsWith('/v1/plugins/')) return true;
  if (pathname === '/v1/ps/plugins' || pathname.startsWith('/v1/ps/plugins/')) return true;
  if (pathname === '/v1/connectors' || pathname.startsWith('/v1/connectors/')) return true;
  if (pathname === '/v1/api/codex/apps' || pathname.startsWith('/v1/api/codex/apps/')) return true;
  if (pathname === '/v1/api/codex/usage' || pathname.startsWith('/v1/api/codex/usage/')) return true;
  return false;
}

// READ-path: from raw stored entry → ThinCanonical
function normalizeListMeta(entry) {
  const inputLen = Array.isArray(entry.req?.input) ? entry.req.input.length : 0;
  return {
    id: entry.id,
    ts: entry.ts,
    provider: 'openai',
    model: entry.model || entry.res?.model || entry.req?.model || 'unknown',
    sessionId: entry.sessionId,
    msgCount: entry.msgCount ?? inputLen,
    toolCount: entry.toolCount ?? (Array.isArray(entry.req?.tools) ? entry.req.tools.length : 0),
    usage: entry.usage || null,
    cost: entry.cost || null,
    agentType: entry.agentType || 'default',
    agentLabel: entry.agentLabel || 'Codex Default',
    isSubagent: entry.isSubagent || false,
    stopReason: entry.stopReason || entry.res?.status || null,
    status: entry.status,
    elapsed: entry.elapsed,
    responseMetadata: entry.responseMetadata || null,
  };
}

// From response object's .usage field
function extractUsage(resData) {
  if (!resData) return null;
  // OpenAI response can be an object with .usage, or an array of SSE events
  const usage = resData.usage || (Array.isArray(resData) ? resData.find(e => e.usage)?.usage : null);
  if (!usage) return null;
  const result = {
    input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
    output_tokens: usage.output_tokens || usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
  // Canonical cache fields (provider-agnostic thin canonical)
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  result.cache_read_input_tokens = cached;
  result.cache_creation_input_tokens = 0;
  // Preserve provider-native detail
  if (usage.input_tokens_details) result.input_tokens_details = usage.input_tokens_details;
  if (usage.output_tokens_details) result.output_tokens_details = usage.output_tokens_details;
  return result;
}

// From system-prompt.js:82-99 + openai-session.js:33-42
function extractAgentTypeMethod(_systemBlob, headers) {
  if (headers) {
    const fromHeaders = getOpenAIAgentTypeFromHeaders(headers);
    if (fromHeaders) {
      const labelMap = { explorer: 'Codex Explorer', worker: 'Codex Worker', default: 'Codex Default' };
      return { key: fromHeaders, label: labelMap[fromHeaders] || 'Codex' };
    }
  }
  return { key: 'default', label: 'Codex Default' };
}

// From openai-session.js:58-70
function detectSession(_req, headers, parsedBody) {
  const sessionId = getCodexSessionId(headers, parsedBody);
  if (!sessionId) {
    return { sessionId: getCodexRawSessionId(), isNewSession: false, inferred: true };
  }
  const bodyForDetection = parsedBody || { metadata: { session_id: sessionId } };
  const detected = store.detectSession(bodyForDetection);
  return {
    sessionId: detected.sessionId || sessionId || getCodexRawSessionId(),
    isNewSession: detected.isNewSession || false,
    inferred: detected.inferred || false,
  };
}

// Optional preprocessor: inject header-derived metadata into parsedBody
function preprocessBody(parsedBody, headers) {
  return withCodexMetadata(parsedBody, headers);
}

function buildEntryFields(ctx) {
  const { parsedBody, proxyRes } = ctx;
  const isWS = ctx.transport === 'websocket';
  const response = isWS ? null : (ctx.response || getOpenAIResponseFromEvents(ctx.events || []));
  const usage = ctx.lastUsage || extractUsage(response);
  const model = ctx.lastModel || response?.model || parsedBody?.model || null;

  let responseMetadata;
  if (isWS) {
    responseMetadata = ctx.responseMetadata || { transport: 'websocket', capture: 'transport-only' };
  } else {
    responseMetadata = buildResponseMetadata('openai', response, proxyRes);
    if (ctx.events && ctx.events.length) responseMetadata.streaming = true;
  }

  return {
    provider: 'openai',
    agent: agentForProvider('openai'),
    model,
    msgCount: Array.isArray(parsedBody?.input) ? parsedBody.input.length : 0,
    toolCount: Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
    toolCalls: helpers.extractOpenAIToolCalls(
      isWS ? ctx.responseEvents : ((ctx.events && ctx.events.length) ? ctx.events : response?.output)
    ),
    isSubagent: ctx.isSubagent || false,
    sessionInferred: ctx.sessionInferred || false,
    cwd: ctx.cwd ?? null,
    usage,
    cost: calculateCost(usage, model),
    maxContext: model ? config.inferMaxContext(model, parsedBody?.instructions, usage) : null,
    responseMetadata,
    stopReason: isWS
      ? (ctx.wsCloseReason || ctx.wsErrorMessage || null)
      : (response?.status || ''),
    title: isWS
      ? 'Codex WebSocket session'
      : (getOpenAIInputSummary(parsedBody?.input) || getOpenAIOutputSummary(response)),
    thinkingDuration: null,
    toolFail: false,
    sysHash: ctx.sysHash || null,
    toolsHash: ctx.toolsHash || null,
    coreHash: ctx.coreHash || null,
    thinkingStripped: undefined,
    sessionId: ctx.sessionId,
  };
}

module.exports = {
  // WIRE_PARSERS interface
  isNoiseRequest,
  normalizeListMeta,
  extractUsage,
  extractAgentType: extractAgentTypeMethod,
  detectSession,
  preprocessBody,
  buildEntryFields,
  // Low-level exports for ws-proxy.js compatibility
  getCodexRawSessionId,
  firstHeader,
  parseCodexTurnMetadata,
  getCodexSessionId,
  getOpenAIAgentTypeFromHeaders,
  isOpenAISubagent,
  detectOpenAISession: detectSession,
  withCodexMetadata,
};
