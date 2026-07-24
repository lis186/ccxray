'use strict';

const crypto = require('crypto');
const { extractAgentType, splitB2IntoBlocks, computeCoreHash } = require('../system-prompt');
const store = require('../store');
const helpers = require('../helpers');
const config = require('../config');
const { calculateCost } = require('../pricing');
const { agentForProvider } = require('../providers');

// ── isNoiseRequest ──────────────────────────────────────────
// count_tokens (#146): Claude Code pre-counts tokens for large content. The
// body is bare {model, messages} — no system, no metadata, no tools — which
// satisfies every subagent heuristic, so each call became a fake single-turn
// subagent entry glued onto the active session (one swimlane per call).
// Forward it, but don't record an entry.
function isNoiseRequest(url, _headers, _parsedBody) {
  return typeof url === 'string' && url.split('?')[0] === '/v1/messages/count_tokens';
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

// ── extractResponseId ───────────────────────────────────────
// The upstream Anthropic message id (msg_01…) — assigned by Anthropic, not
// minted by any writer — is the dedup key for the read-time merge that
// collapses multi-instance duplicate logs (#333). SSE: message_start.message.id
// (same node extractUsage reads). Non-SSE: top-level response.id. Null when
// absent (legacy/partial captures) — the merge treats a null key as "no group".
// See docs/decisions/0012-response-id-read-time-merge.md.
function extractResponseId(resData) {
  if (!resData) return null;
  if (Array.isArray(resData)) {
    const msgStart = resData.find(e => e && e.type === 'message_start');
    return msgStart?.message?.id || null;
  }
  if (typeof resData === 'object') return resData.id || null;
  return null;
}

// ── detectSession ───────────────────────────────────────────
// Anthropic path: session_id from parsedBody.metadata, delegate to
// store.detectSession. The client socket rides along for orphan
// attribution by socket affinity (#129).
function detectSession(req, _headers, parsedBody) {
  return store.detectSession(parsedBody, req?.socket);
}

// Conversation identity: hash of the first message's text. All turns of one
// subagent instance share messages[0] verbatim (history only appends), while
// parallel instances of the same agent type differ in their task prompt —
// this is what lets the swimlane split N concurrent Explore agents into N
// lanes (#117). Null when messages[0] has no text (never key lanes on md5('')).
function computeConvId(parsedBody) {
  const c = parsedBody?.messages?.[0]?.content;
  const txt = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  if (!txt) return null;
  return crypto.createHash('md5').update(txt).digest('hex').slice(0, 8);
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
    skillCalls: helpers.extractSkillCalls(parsedBody?.messages),
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
    agentKey: ctx.agentKey || null,
    agentLabel: ctx.agentLabel || null,
    convId: computeConvId(parsedBody),
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
  // INVARIANT: coreHash via computeCoreHash (platform-normalized) — see system-prompt.js (#219)
  const coreHash = computeCoreHash(coreText);
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
        coreHash, firstSeen: now, agentKey, agentLabel, version: liveVer, provider: 'anthropic',
      });
      const vData = JSON.stringify({ _type: 'version_detected', version: liveVer, b2Len: b2.length, agentKey, agentLabel, provider: 'anthropic' });
      for (const res of store.sseClients) res.write(`data: ${vData}\n\n`);
    }
  }
  return { coreHash, agentKey, agentLabel };
}

// ── Phase 1: new interface methods ─────────────────────────

function isSubagent(parsedBody, _headers) {
  return store.isAnthropicSubagent(parsedBody);
}

function rawSessionId(headers, _parsedBody) {
  const sid = headers?.['x-session-id'];
  return sid ? String(sid) : null;
}

function systemPromptHash(parsedBody) {
  if (!parsedBody?.system) return { hash: null, filePrefix: 'sys_', content: null };
  const content = parsedBody.system;
  const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12);
  return { hash, filePrefix: 'sys_', content };
}

function toolsHash(parsedBody) {
  if (!parsedBody?.tools) return { hash: null, filePrefix: 'tools_' };
  const hash = crypto.createHash('sha256').update(JSON.stringify(parsedBody.tools)).digest('hex').slice(0, 12);
  return { hash, filePrefix: 'tools_' };
}

function getCwd(parsedBody, _headers) {
  return store.extractCwd(parsedBody) || null;
}

function turnStepCount(parsedBody) {
  const msgs = parsedBody?.messages;
  if (!Array.isArray(msgs)) return 0;
  let count = 0;
  for (const msg of msgs) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      count += msg.content.filter(b => b.type === 'tool_use').length;
    }
  }
  return count;
}

function attributionTurnStep(parsedBody) {
  return helpers.computeTurnStep(parsedBody?.messages);
}

module.exports = {
  isNoiseRequest,
  extractUsage,
  extractResponseId,
  computeConvId,
  detectSession,
  buildEntryFields,
  registerPromptVersion,
  // Phase 1: new interface
  isSubagent,
  rawSessionId,
  systemPromptHash,
  toolsHash,
  getCwd,
  turnStepCount,
  attributionTurnStep,
};
