'use strict';

const { extractAgentType } = require('../system-prompt');
const store = require('../store');
const helpers = require('../helpers');
const config = require('../config');
const { calculateCost } = require('../pricing');
const { agentForProvider } = require('../providers');

// ── isNoiseRequest ──────────────────────────────────────────
function isNoiseRequest(_url, _headers, _parsedBody) {
  return false;
}

// ── normalizeListMeta ───────────────────────────────────────
// READ-path only: from raw stored entry → ThinCanonical for list layer
function normalizeListMeta(entry) {
  return {
    id: entry.id,
    ts: entry.ts,
    provider: 'anthropic',
    model: entry.model || entry.req?.model || 'unknown',
    sessionId: entry.sessionId,
    msgCount: entry.msgCount ?? (Array.isArray(entry.req?.messages) ? entry.req.messages.length : 0),
    toolCount: entry.toolCount ?? (Array.isArray(entry.req?.tools) ? entry.req.tools.length : 0),
    usage: entry.usage || null,
    cost: entry.cost || null,
    agentType: entry.agentType || 'unknown',
    agentLabel: entry.agentLabel || 'Unknown',
    isSubagent: entry.isSubagent || false,
    stopReason: entry.stopReason || null,
    status: entry.status,
    elapsed: entry.elapsed,
    coreHash: entry.coreHash || null,
    thinkingDuration: entry.thinkingDuration || null,
    thinkingStripped: entry.thinkingStripped || false,
    hasCredential: entry.hasCredential || false,
  };
}

// ── extractUsage ────────────────────────────────────────────
// From helpers.js:272-292 (Anthropic SSE events → usage)
function extractUsage(resData) {
  if (!Array.isArray(resData)) return null;
  const msgStart = resData.find(e => e.type === 'message_start');
  const msgDelta = resData.find(e => e.type === 'message_delta');
  const u = msgStart?.message?.usage || {};
  const result = {
    input_tokens: u.input_tokens || 0,
    output_tokens: msgDelta?.usage?.output_tokens || u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    result.cache_creation = {
      ephemeral_5m_input_tokens: u.cache_creation.ephemeral_5m_input_tokens || 0,
      ephemeral_1h_input_tokens: u.cache_creation.ephemeral_1h_input_tokens || 0,
    };
  }
  return result;
}

// ── extractAgentType ────────────────────────────────────────
// From system-prompt.js:51-79 (Anthropic B2 prefix matching)
function extractAgentTypeMethod(systemBlob, _headers) {
  return extractAgentType(systemBlob);
}

// ── detectSession ───────────────────────────────────────────
// Anthropic path: session_id from parsedBody.metadata, delegate to store.detectSession
function detectSession(_req, _headers, parsedBody) {
  return store.detectSession(parsedBody);
}

function buildEntryFields(ctx) {
  const { parsedBody } = ctx;
  const usage = ctx.usage || extractUsage(ctx.events) || null;
  const model = parsedBody?.model || null;
  const isSubagent = ctx.isSubagent != null ? ctx.isSubagent : !store.extractCwd(parsedBody);
  return {
    provider: 'anthropic',
    agent: agentForProvider('anthropic'),
    model,
    msgCount: parsedBody?.messages?.length || 0,
    toolCount: parsedBody?.tools?.length || 0,
    toolCalls: helpers.extractToolCalls(parsedBody?.messages),
    isSubagent,
    sessionInferred: ctx.sessionInferred || false,
    cwd: ctx.cwd ?? null,
    usage,
    cost: calculateCost(usage, model),
    maxContext: config.inferMaxContext(model, parsedBody?.system, usage),
    responseMetadata: undefined,
    stopReason: ctx.stopReason || '',
    title: ctx.title || null,
    thinkingDuration: ctx.thinkingDuration ?? null,
    toolFail: ctx.toolFail != null ? ctx.toolFail : helpers.hasToolFail(parsedBody),
    sysHash: ctx.sysHash || null,
    toolsHash: ctx.toolsHash || null,
    coreHash: ctx.coreHash || null,
    thinkingStripped: ctx.thinkingStripped,
    sessionId: ctx.sessionId,
  };
}

module.exports = {
  isNoiseRequest,
  normalizeListMeta,
  extractUsage,
  extractAgentType: extractAgentTypeMethod,
  detectSession,
  buildEntryFields,
};
