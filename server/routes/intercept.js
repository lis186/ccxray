'use strict';

const store = require('../store');
const { taipeiTime } = require('../helpers');
const { broadcastInterceptToggle, broadcastInterceptRemoved, broadcastSessionStatus } = require('../sse-broadcast');
const { forwardRequest } = require('../forward');

function handleInterceptRoutes(clientReq, clientRes) {
  if (clientReq.url === '/_api/intercept/toggle' && clientReq.method === 'POST') {
    const chunks = []; clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', () => {
      try {
        const { sessionId } = JSON.parse(Buffer.concat(chunks).toString());
        if (!sessionId) { clientRes.writeHead(400); clientRes.end('missing sessionId'); return; }
        const enabled = !store.interceptSessions.has(sessionId);
        if (enabled) store.interceptSessions.add(sessionId); else store.interceptSessions.delete(sessionId);
        broadcastInterceptToggle(sessionId, enabled);
        console.log(`\x1b[33m${enabled ? '⏸' : '▶'} INTERCEPT ${enabled ? 'ON' : 'OFF'} for session ${sessionId.slice(0, 8)}\x1b[0m`);
        clientRes.writeHead(200, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ sessionId, enabled }));
      } catch { clientRes.writeHead(400); clientRes.end('bad json'); }
    });
    return true;
  }

  const approveMatch = clientReq.url.match(/^\/_api\/intercept\/(.+)\/approve$/);
  if (approveMatch && clientReq.method === 'POST') {
    const reqId = decodeURIComponent(approveMatch[1]);
    const pending = store.pendingRequests.get(reqId);
    if (!pending) { clientRes.writeHead(404); clientRes.end('not found'); return true; }
    const chunks = []; clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', () => {
      clearTimeout(pending.timer);
      store.pendingRequests.delete(reqId);
      broadcastInterceptRemoved(reqId);
      try {
        const payload = Buffer.concat(chunks).toString();
        if (payload) {
          const { body } = JSON.parse(payload);
          if (body) { pending.parsedBody = body; pending.bodyModified = true; }
        }
      } catch {}
      console.log(`\x1b[32m✓ INTERCEPT APPROVED [${taipeiTime()}] ${reqId}\x1b[0m`);
      forwardRequest(pending);
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ ok: true }));
    });
    return true;
  }

  const rejectMatch = clientReq.url.match(/^\/_api\/intercept\/(.+)\/reject$/);
  if (rejectMatch && clientReq.method === 'POST') {
    const reqId = decodeURIComponent(rejectMatch[1]);
    const pending = store.pendingRequests.get(reqId);
    if (!pending) { clientRes.writeHead(404); clientRes.end('not found'); return true; }
    clearTimeout(pending.timer);
    store.pendingRequests.delete(reqId);
    broadcastInterceptRemoved(reqId);
    if (pending.reqSessionId) {
      store.activeRequests[pending.reqSessionId] = Math.max(0, (store.activeRequests[pending.reqSessionId] || 1) - 1);
      broadcastSessionStatus(pending.reqSessionId);
    }
    console.log(`\x1b[31m✕ INTERCEPT REJECTED [${taipeiTime()}] ${reqId}\x1b[0m`);
    if (!pending.clientRes.headersSent) {
      pending.clientRes.writeHead(499, { 'Content-Type': 'application/json' });
    }
    pending.clientRes.end(JSON.stringify({ error: 'request_rejected', message: 'Request rejected by dashboard' }));
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (clientReq.url === '/_api/intercept/timeout' && clientReq.method === 'POST') {
    const chunks = []; clientReq.on('data', c => chunks.push(c));
    clientReq.on('end', () => {
      try {
        const { timeout } = JSON.parse(Buffer.concat(chunks).toString());
        store.setInterceptTimeout(Math.max(30, Math.min(180, Number(timeout) || 120)));
        clientRes.writeHead(200, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ timeout: store.getInterceptTimeout() }));
      } catch { clientRes.writeHead(400); clientRes.end('bad json'); }
    });
    return true;
  }

  return false;
}

module.exports = { handleInterceptRoutes };
