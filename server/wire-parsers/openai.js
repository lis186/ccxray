'use strict';

const store = require('../store');
const helpers = require('../helpers');
const { normalizeUsageForProvider } = require('../providers');
const config = require('../config');
const { calculateCost } = require('../pricing');
const { agentForProvider } = require('../providers');
const { extractPromptAgentType, rawCoreHash } = require('../system-prompt');
const {
  getOpenAIResponseFromEvents, getOpenAIInputSummary,
  getOpenAIOutputSummary, buildResponseMetadata,
} = require('../openai-response');

// ── Low-level helpers (also exported for ws-proxy.js) ───────

function firstHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// x-codex-turn-metadata is a JSON header string that stays constant for a
// request/connection but is read by several helpers per turn (session id, cwd,
// agent type). Cache the parse per headers object so those callers share one
// JSON.parse. The WeakMap key is the request-scoped headers object, so entries
// are collected once the request ends.
const turnMetadataCache = new WeakMap();
function parseCodexTurnMetadata(headers) {
  const cacheable = headers && typeof headers === 'object';
  if (cacheable && turnMetadataCache.has(headers)) return turnMetadataCache.get(headers);
  const raw = firstHeader(headers, 'x-codex-turn-metadata');
  let parsed = null;
  if (raw) {
    try {
      const value = JSON.parse(String(raw));
      if (value && typeof value === 'object') parsed = value;
    } catch {
      parsed = null;
    }
  }
  if (cacheable) turnMetadataCache.set(headers, parsed);
  return parsed;
}

function getCodexSessionId(headers, parsedBody) {
  const direct = firstHeader(headers, 'session_id') || firstHeader(headers, 'x-openai-session-id');
  if (direct) return String(direct);
  const turnMetadata = parseCodexTurnMetadata(headers);
  if (typeof turnMetadata?.session_id === 'string') return turnMetadata.session_id;
  if (typeof parsedBody?.metadata?.session_id === 'string') return parsedBody.metadata.session_id;
  if (typeof turnMetadata?.thread_id === 'string') return turnMetadata.thread_id;
  if (typeof parsedBody?.metadata?.thread_id === 'string') return parsedBody.metadata.thread_id;
  return null;
}

function getCodexRawSessionId() {
  return 'codex-raw';
}

function getCodexWorkspaceCwd(workspaces) {
  if (!workspaces || typeof workspaces !== 'object') return null;
  if (typeof workspaces.cwd === 'string') return workspaces.cwd;
  if (typeof workspaces.current === 'string') return workspaces.current;
  const first = Object.values(workspaces).find(v => typeof v === 'string');
  if (first) return first;
  const nested = Object.values(workspaces).find(v => v && typeof v === 'object' && typeof v.cwd === 'string');
  if (nested?.cwd) return nested.cwd;
  // Codex format: keys are paths, values are metadata objects.
  const pathKey = Object.keys(workspaces).find(k => k.startsWith('/'));
  return pathKey || null;
}

function getCodexInstructionsCwd(instructions) {
  if (typeof instructions !== 'string') return null;
  const cwdMatch = instructions.match(/(?:^|\n)CWD:\s*([^\n]+)/);
  if (cwdMatch) return cwdMatch[1].trim();
  const primaryMatch = instructions.match(/Primary working directory:\s*([^\n]+)/);
  return primaryMatch ? primaryMatch[1].trim() : null;
}

function getCodexCwd(headers, parsedBody, fallback = null) {
  const turnMetadata = parseCodexTurnMetadata(headers);
  return parsedBody?.metadata?.cwd
    || getCodexWorkspaceCwd(parsedBody?.metadata?.workspaces)
    || turnMetadata?.cwd
    || getCodexWorkspaceCwd(turnMetadata?.workspaces)
    || getCodexInstructionsCwd(parsedBody?.instructions)
    || fallback;
}

// Merge Codex-derived identity into a metadata object without overwriting values
// the body already set (explicit body metadata wins over header-derived). Shared
// by withCodexMetadata (HTTP) and ws-proxy's per-turn session promotion.
function fillCodexMetadata(metadata, { sessionId, agentType, cwd }) {
  const merged = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  if (sessionId && !merged.session_id) merged.session_id = sessionId;
  if (agentType && !merged.agent_type) merged.agent_type = agentType;
  if (cwd && !merged.cwd) merged.cwd = cwd;
  return merged;
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
  const cwd = getCodexCwd(headers, parsedBody);
  if (!sessionId && !agentType && !cwd) return parsedBody;
  const metadata = fillCodexMetadata(parsedBody.metadata, { sessionId, agentType, cwd });
  return { ...parsedBody, metadata };
}

// ── WIRE_PARSERS interface ──────────────────────────────────

// All Codex ChatGPT-platform paths + model-list queries are noise. None carry
// conversation data; platform paths 404 for API-key users and create garbage
// "(unknown)" / "Codex Raw" entries. /v1/models is a metadata query, not a turn.
function isNoiseRequest(url, _headers, _parsedBody) {
  const pathname = (url || '').split('?')[0];
  if (pathname === '/v1/plugins' || pathname.startsWith('/v1/plugins/')) return true;
  if (pathname === '/v1/ps/plugins' || pathname.startsWith('/v1/ps/plugins/')) return true;
  if (pathname === '/v1/connectors' || pathname.startsWith('/v1/connectors/')) return true;
  if (pathname === '/v1/api/codex' || pathname.startsWith('/v1/api/codex/')) return true;
  if (pathname === '/v1/codex' || pathname.startsWith('/v1/codex/')) return true;
  if (pathname === '/v1/models') return true;
  return false;
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
  return normalizeUsageForProvider('openai', result);
}

// From openai-session.js:58-70
function detectSession(_req, headers, parsedBody) {
  const sessionId = getCodexSessionId(headers, parsedBody);
  if (!sessionId) {
    return { sessionId: getCodexRawSessionId(), isNewSession: false, inferred: true };
  }
  const bodyForDetection = parsedBody
    ? { ...parsedBody, metadata: { ...(parsedBody.metadata || {}), session_id: sessionId } }
    : { metadata: { session_id: sessionId } };
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
      ? (ctx.lastResponseStatus || ctx.wsCloseReason || ctx.wsErrorMessage || null)
      : (response?.status || ''),
    title: isWS
      ? (getOpenAIInputSummary(parsedBody?.input) || 'Codex WebSocket session')
      : (getOpenAIInputSummary(parsedBody?.input) || getOpenAIOutputSummary(response)),
    thinkingDuration: null,
    toolFail: false,
    sysHash: ctx.sysHash || null,
    toolsHash: ctx.toolsHash || null,
    coreHash: ctx.coreHash || null,
    agentKey: ctx.agentKey || null,
    agentLabel: ctx.agentLabel || null,
    thinkingStripped: undefined,
    sessionId: ctx.sessionId,
  };
}

function registerPromptVersion(ctx) {
  const { parsedBody, sysHash, sharedFile } = ctx;
  const promptText = typeof parsedBody?.instructions === 'string' ? parsedBody.instructions : null;
  if (!promptText) return null;
  const { key: agentKey, label: agentLabel } = extractPromptAgentType('openai', parsedBody);
  const coreHash = rawCoreHash(promptText);
  const idxKey = `${agentKey}::${coreHash}`;
  const existing = store.versionIndex.get(idxKey);
  if (existing) {
    if (sharedFile || sysHash) existing.sharedFile = sharedFile || `openai_instructions_${sysHash}.json`;
    return { coreHash, agentKey, agentLabel };
  }
  const now = new Date().toISOString().slice(0, 10);
  const sf = sharedFile || (sysHash ? `openai_instructions_${sysHash}.json` : null);
  store.versionIndex.set(idxKey, {
    reqId: null, sharedFile: sf, b2Len: promptText.length,
    coreLen: promptText.length, coreHash, firstSeen: now,
    agentKey, agentLabel, version: coreHash, provider: 'openai',
  });
  const vData = JSON.stringify({ _type: 'version_detected', version: coreHash, b2Len: promptText.length, agentKey, agentLabel, provider: 'openai' });
  for (const res of store.sseClients) res.write(`data: ${vData}\n\n`);
  return { coreHash, agentKey, agentLabel };
}

// ── Phase 1: new interface methods ─────────────────────────

const crypto = require('crypto');

function isSubagent(parsedBody, headers) {
  return isOpenAISubagent(headers, parsedBody);
}

function rawSessionId(headers, parsedBody) {
  return getCodexSessionId(headers, parsedBody);
}

function systemPromptHash(parsedBody) {
  if (parsedBody?.instructions == null) return { hash: null, filePrefix: 'openai_instructions_', content: null };
  const content = parsedBody.instructions;
  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12);
  return { hash, filePrefix: 'openai_instructions_', content };
}

function toolsHash(parsedBody) {
  if (!parsedBody?.tools) return null;
  return crypto.createHash('sha256').update(JSON.stringify(parsedBody.tools)).digest('hex').slice(0, 12);
}

function getCwd(parsedBody, headers) {
  return getCodexCwd(headers, parsedBody);
}

function turnStepCount(parsedBody) {
  const input = parsedBody?.input;
  if (!Array.isArray(input)) return 0;
  return input.filter(item => item.type === 'function_call' || item.type === 'function_call_output').length;
}

module.exports = {
  // WIRE_PARSERS interface
  isNoiseRequest,
  extractUsage,
  detectSession,
  preprocessBody,
  buildEntryFields,
  registerPromptVersion,
  // Phase 1: new interface
  isSubagent,
  rawSessionId,
  systemPromptHash,
  toolsHash,
  getCwd,
  turnStepCount,
  // Low-level exports for ws-proxy.js compatibility
  getCodexRawSessionId,
  getCodexCwd,
  getCodexWorkspaceCwd,
  fillCodexMetadata,
  firstHeader,
  parseCodexTurnMetadata,
  getCodexSessionId,
  getOpenAIAgentTypeFromHeaders,
  isOpenAISubagent,
  detectOpenAISession: detectSession,
  withCodexMetadata,
};
