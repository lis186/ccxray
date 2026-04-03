'use strict';

const store = require('../store');

function handleSSERoute(clientReq, clientRes) {
  if (clientReq.url !== '/_events') return false;

  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  clientRes.write(':\n\n');

  // Send current session statuses
  for (const [sid, meta] of Object.entries(store.sessionMeta)) {
    if (meta.lastSeenAt || (store.activeRequests[sid] || 0) > 0) {
      const active = (store.activeRequests[sid] || 0) > 0;
      const data = JSON.stringify({ _type: 'session_status', sessionId: sid, active, lastSeenAt: meta.lastSeenAt || null });
      clientRes.write(`data: ${data}\n\n`);
    }
  }

  // Send intercept state
  for (const sid of store.interceptSessions) {
    clientRes.write(`data: ${JSON.stringify({ _type: 'intercept_toggled', sessionId: sid, enabled: true })}\n\n`);
  }
  for (const [reqId, pending] of store.pendingRequests) {
    clientRes.write(`data: ${JSON.stringify({ _type: 'pending_request', requestId: reqId, sessionId: pending.reqSessionId, body: pending.parsedBody })}\n\n`);
  }

  // Send current interceptTimeout
  clientRes.write(`data: ${JSON.stringify({ _type: 'intercept_timeout', timeout: store.getInterceptTimeout() })}\n\n`);

  store.sseClients.push(clientRes);
  clientReq.on('close', () => {
    const idx = store.sseClients.indexOf(clientRes);
    if (idx >= 0) store.sseClients.splice(idx, 1);
  });

  return true;
}

module.exports = { handleSSERoute };
