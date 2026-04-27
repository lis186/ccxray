'use strict';

const store = require('./store');

// Strip req/res from broadcast — browser only needs summary for the turn list
function summarizeEntry(entry) {
  const tok = entry.tokens;
  return {
    id: entry.id, ts: entry.ts, sessionId: entry.sessionId,
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
    toolSources: entry.toolSources || undefined,
    coreHash: entry.coreHash || null,
    thinkingStripped: entry.thinkingStripped || false,
    tokens: tok ? {
      system: tok.system, tools: tok.tools, messages: tok.messages, total: tok.total,
      contextBreakdown: tok.contextBreakdown,
      perMessage: tok.perMessage || null,
    } : null,
  };
}

function broadcast(entry) {
  const data = JSON.stringify(summarizeEntry(entry));
  for (const res of store.sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}

function broadcastSessionStatus(sessionId) {
  const active = (store.activeRequests[sessionId] || 0) > 0;
  const lastSeenAt = store.sessionMeta[sessionId]?.lastSeenAt || null;
  const data = JSON.stringify({ _type: 'session_status', sessionId, active, lastSeenAt });
  for (const res of store.sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}

function broadcastPendingRequest(requestId, parsedBody, sessionId) {
  const data = JSON.stringify({
    _type: 'pending_request', requestId, sessionId,
    body: parsedBody,
  });
  for (const res of store.sseClients) res.write(`data: ${data}\n\n`);
}

function broadcastInterceptToggle(sessionId, enabled) {
  const data = JSON.stringify({ _type: 'intercept_toggled', sessionId, enabled });
  for (const res of store.sseClients) res.write(`data: ${data}\n\n`);
}

function broadcastInterceptRemoved(requestId) {
  const data = JSON.stringify({ _type: 'intercept_removed', requestId });
  for (const res of store.sseClients) res.write(`data: ${data}\n\n`);
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
  const data = JSON.stringify({ _type: 'session_title_update', sessionId, title, titleReqTs });
  for (const res of store.sseClients) res.write(`data: ${data}\n\n`);
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

module.exports = {
  summarizeEntry,
  broadcast,
  broadcastSessionStatus,
  broadcastPendingRequest,
  broadcastInterceptToggle,
  broadcastInterceptRemoved,
  broadcastSessionTitleUpdate,
  TITLE_DEBOUNCE_MS,
  _resetTitleDebounce,
};
