'use strict';

const store = require('./store');
const { agentForProvider } = require('./providers');

// ── Broadcast sequence + ring buffer for reconnect replay ──────────
// Monotonic seq (not entry.id — entry.id is request-start time, broadcast
// happens at completion; long turns would have id < watermark). Epoch
// distinguishes hub restarts; ring buffer holds recent events for replay.
let _broadcastSeq = 0;
const _epoch = Date.now();
const RING_SIZE = parseInt(process.env.CCXRAY_SSE_RING_SIZE || '2000', 10);
const _ring = [];

function _broadcastAll(data) {
  const seq = ++_broadcastSeq;
  const sseId = `${_epoch}:${seq}`;
  _ring.push({ seq, data });
  if (_ring.length > RING_SIZE) _ring.shift();
  for (const res of store.sseClients) {
    res.write(`id: ${sseId}\ndata: ${data}\n\n`);
  }
}

function getEpoch() { return _epoch; }
function getRing() { return _ring; }

// Strip req/res from broadcast — browser only needs summary for the turn list
function summarizeEntry(entry) {
  const tok = entry.tokens;
  // Server owns the resume-button policy. Record this turn's usage signal first,
  // then compute the per-session resume command so the client is a pure view.
  // (Deliberate side-effect in a serialize function: this is the single funnel
  // both SSE broadcast and the /api/entries restore batch pass through.)
  store.markSessionUsage(entry);
  const { resumable, resumeCommand } = store.computeSessionResume(
    entry.sessionId, entry.provider, entry.agent || agentForProvider(entry.provider),
  );
  return {
    id: entry.id, ts: entry.ts, sessionId: entry.sessionId,
    provider: entry.provider || 'anthropic',
    agent: entry.agent || agentForProvider(entry.provider),
    resumable, resumeCommand,
    method: entry.method, url: entry.url,
    elapsed: entry.elapsed, status: entry.status, isSSE: entry.isSSE,
    receivedAt: entry.receivedAt || null,
    usage: entry.usage, cost: entry.cost, maxContext: entry.maxContext, cwd: entry.cwd,
    model: entry.model || null,
    msgCount: entry.msgCount || 0,
    toolCount: entry.toolCount || 0,
    toolCalls: entry.toolCalls || [],
    isSubagent: entry.isSubagent || false,
    sessionInferred: entry.sessionInferred || false,
    title: entry.title || null,
    stopReason: entry.stopReason || '',
    thinkingDuration: entry.thinkingDuration || null,
    duplicateToolCalls: entry.duplicateToolCalls || null,
    toolFail: entry.toolFail || false,
    hasCredential: entry.hasCredential || undefined,
    coreHash: entry.coreHash || null,
    agentKey: entry.agentKey || null,
    agentLabel: entry.agentLabel || null,
    convId: entry.convId || null,
    toolsHash: entry.toolsHash || null,
    thinkingStripped: entry.thinkingStripped || false,
    imported: entry.imported || undefined,
    importSource: entry.importSource || undefined,
    parentSessionId: store.sessionMeta[entry.sessionId]?.parentSessionId || null,
    tokens: tok ? {
      system: tok.system, tools: tok.tools, messages: tok.messages, total: tok.total,
      contextBreakdown: tok.contextBreakdown,
      perMessage: tok.perMessage ? tok.perMessage.map(m => ({ tokens: m.tokens })) : null,
    } : null,
  };
}

function broadcast(entry) {
  _broadcastAll(JSON.stringify(summarizeEntry(entry)));
}

function broadcastSessionStatus(sessionId) {
  const active = (store.activeRequests[sessionId] || 0) > 0;
  const lastSeenAt = store.sessionMeta[sessionId]?.lastSeenAt || null;
  _broadcastAll(JSON.stringify({ _type: 'session_status', sessionId, active, lastSeenAt }));
}

function broadcastPendingRequest(requestId, parsedBody, sessionId) {
  _broadcastAll(JSON.stringify({ _type: 'pending_request', requestId, sessionId, body: parsedBody }));
}

function broadcastInterceptToggle(sessionId, enabled) {
  _broadcastAll(JSON.stringify({ _type: 'intercept_toggled', sessionId, enabled }));
}

function broadcastInterceptRemoved(requestId) {
  _broadcastAll(JSON.stringify({ _type: 'intercept_removed', requestId }));
}

// Per-session debounced title-update broadcast. Bursts within the window
// collapse to one outgoing event carrying whatever store.getSessionTitle
// returns at flush time (monotonic guard already applied).
const TITLE_DEBOUNCE_MS = 3000;
const titleDebounceTimers = new Map();

function flushSessionTitleUpdate(sessionId) {
  titleDebounceTimers.delete(sessionId);
  const title = store.getSessionTitle(sessionId);
  if (!title) return;
  const titleReqTs = store.sessionMeta[sessionId]?.titleReqTs || null;
  _broadcastAll(JSON.stringify({ _type: 'session_title_update', sessionId, title, titleReqTs }));
}

function broadcastSessionTitleUpdate(sessionId, { immediate = false } = {}) {
  if (!sessionId) return;
  if (immediate) {
    const timer = titleDebounceTimers.get(sessionId);
    if (timer) { clearTimeout(timer); titleDebounceTimers.delete(sessionId); }
    flushSessionTitleUpdate(sessionId);
    return;
  }
  if (titleDebounceTimers.has(sessionId)) return;
  const timer = setTimeout(() => flushSessionTitleUpdate(sessionId), TITLE_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  titleDebounceTimers.set(sessionId, timer);
}

function _resetTitleDebounce() {
  for (const t of titleDebounceTimers.values()) clearTimeout(t);
  titleDebounceTimers.clear();
}

function broadcastRaw(obj) {
  _broadcastAll(JSON.stringify(obj));
}

module.exports = {
  summarizeEntry,
  broadcast,
  broadcastRaw,
  broadcastSessionStatus,
  broadcastPendingRequest,
  broadcastInterceptToggle,
  broadcastInterceptRemoved,
  broadcastSessionTitleUpdate,
  TITLE_DEBOUNCE_MS,
  _resetTitleDebounce,
  getEpoch,
  getRing,
};
