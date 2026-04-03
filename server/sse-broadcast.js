'use strict';

const store = require('./store');

// Strip req/res from broadcast — browser only needs summary for the turn list
function summarizeEntry(entry) {
  const tok = entry.tokens;
  return {
    id: entry.id, ts: entry.ts, sessionId: entry.sessionId,
    method: entry.method, url: entry.url,
    elapsed: entry.elapsed, status: entry.status, isSSE: entry.isSSE,
    usage: entry.usage, cost: entry.cost, maxContext: entry.maxContext, cwd: entry.cwd,
    model: entry.model || null,
    msgCount: entry.msgCount || 0,
    toolCount: entry.toolCount || 0,
    toolCalls: entry.toolCalls || [],
    isSubagent: entry.isSubagent || false,
    title: entry.title || null,
    stopReason: entry.stopReason || '',
    thinkingDuration: entry.thinkingDuration || null,
    duplicateToolCalls: entry.duplicateToolCalls || null,
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

module.exports = {
  summarizeEntry,
  broadcast,
  broadcastSessionStatus,
  broadcastPendingRequest,
  broadcastInterceptToggle,
  broadcastInterceptRemoved,
};
