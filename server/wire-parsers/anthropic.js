'use strict';

const crypto = require('crypto');
const { extractAgentType, splitB2IntoBlocks } = require('../system-prompt');
const store = require('../store');
const helpers = require('../helpers');
const config = require('../config');
const { calculateCost } = require('../pricing');
const { agentForProvider } = require('../providers');

// ── isNoiseRequest ──────────────────────────────────────────
function isNoiseRequest(_url, _headers, _parsedBody) {
  return false;
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

// ── detectSession ───────────────────────────────────────────
// Anthropic path: session_id from parsedBody.metadata, delegate to store.detectSession
function detectSession(_req, _headers, parsedBody) {
  return store.detectSession(parsedBody);
}

function buildEntryFields(ctx) {
  const { parsedBody } = ctx;
  const usage = ctx.usage || extractUsage(ctx.events) || null;
  const model = parsedBody?.model || null;
  const isSubagent = ctx.isSubagent != null ? ctx.isSubagent : store.isAnthropicSubagent(parsedBody);
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
    maxContext: config.inferMaxContext(model, parsedBody?.system, usage, { beta1m: ctx.beta1m }),
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

function registerPromptVersion(ctx) {
  const { parsedBody, sysHash } = ctx;
  if (!Array.isArray(parsedBody?.system) || parsedBody.system.length < 3) return null;
  const b0 = parsedBody.system[0].text || '';
  const b2 = parsedBody.system[2].text || '';
  if (b2.length < 500) return null;
  const { key: agentKey, label: agentLabel } = extractAgentType(parsedBody.system);
  const coreText = splitB2IntoBlocks(b2).coreInstructions || '';
  const coreHash = crypto.createHash('md5').update(coreText).digest('hex').slice(0, 12);
  const liveM = b0.match(/cc_version=(\S+?)[; ]/);
  const liveVer = liveM ? liveM[1] : null;
  if (liveVer) {
    const idxKey = `${agentKey}::${coreHash}`;
    const existing = store.versionIndex.get(idxKey);
    if (existing) {
      existing.version = liveVer;
      if (sysHash) existing.sharedFile = `sys_${sysHash}.json`;
    } else {
      const now = new Date().toISOString().slice(0, 10);
      const sharedFile = sysHash ? `sys_${sysHash}.json` : null;
      store.versionIndex.set(idxKey, {
        reqId: null, sharedFile, b2Len: b2.length, coreLen: coreText.length,
        coreHash, firstSeen: now, agentKey, agentLabel, version: liveVer,
      });
      const vData = JSON.stringify({ _type: 'version_detected', version: liveVer, b2Len: b2.length, agentKey, agentLabel });
      for (const res of store.sseClients) res.write(`data: ${vData}\n\n`);
    }
  }
  return { coreHash, agentKey, agentLabel };
}

module.exports = {
  isNoiseRequest,
  extractUsage,
  detectSession,
  buildEntryFields,
  registerPromptVersion,
};
