'use strict';

const store = require('../store');
const { MAX_SSE_PER_IP } = require('../config');
const { getEpoch, getRing } = require('../sse-broadcast');

function normalizeIp(raw) {
  if (!raw) return '';
  if (raw === '::1' || raw === '::ffff:127.0.0.1') return '127.0.0.1';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

function handleSSERoute(clientReq, clientRes) {
  const pathname = clientReq.url.split('?')[0];
  if (pathname !== '/_events') return false;

  const ip = normalizeIp(clientReq.socket.remoteAddress);
  const count = store.sseClients.filter(c => normalizeIp(c.socket && c.socket.remoteAddress) === ip).length;
  if (count >= MAX_SSE_PER_IP) {
    clientRes.writeHead(429, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'SSE connection limit per IP exceeded' }));
    return true;
  }

  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  clientRes.write(':\n\n');

  // ── Reconnect replay via Last-Event-ID ──
  // Format: "<epoch>:<seq>". Epoch matches + seq in ring → replay after seq.
  // Epoch mismatch or seq evicted → stale signal → client full re-fetch.
  const lastId = clientReq.headers && clientReq.headers['last-event-id'];
  if (lastId) {
    const sep = lastId.indexOf(':');
    const reqEpoch = sep > 0 ? Number(lastId.slice(0, sep)) : 0;
    const reqSeq = sep > 0 ? Number(lastId.slice(sep + 1)) : 0;
    const ring = getRing();
    if (reqEpoch === getEpoch() && ring.length > 0 && reqSeq >= ring[0].seq) {
      for (const item of ring) {
        if (item.seq > reqSeq) {
          clientRes.write(`id: ${getEpoch()}:${item.seq}\ndata: ${item.data}\n\n`);
        }
      }
    } else {
      clientRes.write(`data: ${JSON.stringify({ _type: 'stale' })}\n\n`);
    }
  }

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

module.exports = { handleSSERoute, normalizeIp };
