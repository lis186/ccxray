'use strict';

const WebSocket = require('ws');
const config = require('./config');
const store = require('./store');
const helpers = require('./helpers');
const { calculateCost } = require('./pricing');
const { broadcast, broadcastSessionStatus } = require('./sse-broadcast');
const { isUpstreamAuthenticated } = require('./auth');
const { stripAuthParams } = require('./url-sanitize');
const { agentForProvider } = require('./providers');
const { buildIndexLine } = require('./entry');
const {
  detectSession: _detectOpenAISession3,
  getCodexSessionId,
  getOpenAIAgentTypeFromHeaders,
  parseCodexTurnMetadata,
  extractUsage: extractOpenAIUsage,
} = require('./wire-parsers/openai');
const detectOpenAISession = (headers, body) => _detectOpenAISession3(null, headers, body);

// Large envelope events skipped from responseEvents capture (~35KB each).
// usage and model are extracted before this filter (lines below), so skipping
// these loses no data. Tool-call extraction uses response.output_item.done events.
const WS_SKIP_EVENTS = new Set([
  'response.created', 'response.in_progress', 'response.completed', 'response.done',
  'codex.rate_limits',
]);

const WS_TERMINAL_STATUSES = new Set(['completed', 'incomplete', 'failed', 'cancelled']);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const WS_HANDSHAKE_HEADERS = new Set([
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
]);

const wss = new WebSocket.Server({
  noServer: true,
  handleProtocols(protocols) {
    return protocols.values().next().value || false;
  },
});

const DEFAULT_IDLE_TIMEOUT_MS = parseInt(process.env.CCXRAY_WS_IDLE_TIMEOUT_MS || '60000', 10);
const IDLE_TIMEOUT_MS = Number.isFinite(DEFAULT_IDLE_TIMEOUT_MS) && DEFAULT_IDLE_TIMEOUT_MS > 0
  ? DEFAULT_IDLE_TIMEOUT_MS
  : 60000;
const DEFAULT_MAX_QUEUE_BYTES = parseInt(process.env.CCXRAY_WS_MAX_QUEUE_BYTES || String(4 * 1024 * 1024), 10);
const MAX_QUEUE_BYTES = Number.isFinite(DEFAULT_MAX_QUEUE_BYTES) && DEFAULT_MAX_QUEUE_BYTES > 0
  ? DEFAULT_MAX_QUEUE_BYTES
  : 4 * 1024 * 1024;
const OPENAI_WS_PATHS = new Set(['/v1/responses', '/v1/realtime']);
const WS_CLOSE_REASON_MAX_BYTES = 120; // WS spec caps reason at 123 bytes; leave headroom.

// Module-level state for graceful shutdown. `activeSessions` holds a
// forceFinalize fn per upgrade that hasn't been finalized yet — the agent
// dying can race the OS-driven WS close event, so on shutdown we force-finalize
// any straggler. `pendingEntries` tracks each finalize's recordWebSocketEntry
// promise so drainWebSocketProxy() can wait for the writes to be queued in
// storage before storage.drain() runs.
const activeSessions = new Set();
const pendingEntries = new Set();

function isUpgradeRequest(req) {
  return String(req.headers.upgrade || '').toLowerCase() === 'websocket';
}

function isOpenAIWebSocket(req, upstream) {
  const pathname = (req.url || '').split('?')[0];
  return upstream?.provider === 'openai' && OPENAI_WS_PATHS.has(pathname) && isUpgradeRequest(req);
}


function writeSocketResponse(socket, statusCode, reason) {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n'
  );
  socket.destroy();
}

function isAuthorized(req) {
  // Same predicate as the HTTP gate: loopback bypass, valid X-Ccxray-Auth, or
  // the ChatGPT-OAuth carve-out scoped to ChatGPT-routed requests.
  return isUpstreamAuthenticated(req);
}

const CCXRAY_INTERNAL_HEADERS = new Set(['x-ccxray-auth', 'x-ccxray-bootstrap']);

function buildWebSocketHeaders(clientHeaders, upstream) {
  const headers = {};
  const connectionTokens = String(clientHeaders.connection || '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);

  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (WS_HANDSHAKE_HEADERS.has(lower)) continue;
    if (CCXRAY_INTERNAL_HEADERS.has(lower)) continue;
    if (connectionTokens.includes(lower)) continue;
    if (lower === 'host') continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  return headers;
}

function getWebSocketProtocols(clientHeaders) {
  const raw = clientHeaders['sec-websocket-protocol'];
  if (!raw) return undefined;
  return String(raw).split(',').map(v => v.trim()).filter(Boolean);
}

function getWebSocketUrl(upstream, requestUrl) {
  const protocol = upstream.protocol === 'https' ? 'wss' : 'ws';
  const path = config.joinUpstreamPath(upstream, requestUrl);
  return `${protocol}://${upstream.host}:${upstream.port}${path}`;
}

function getWorkspaceCwd(turnMetadata) {
  const workspaces = turnMetadata?.workspaces;
  if (!workspaces || typeof workspaces !== 'object') return null;
  if (typeof workspaces.cwd === 'string') return workspaces.cwd;
  if (typeof workspaces.current === 'string') return workspaces.current;
  const first = Object.values(workspaces).find(v => typeof v === 'string');
  if (first) return first;
  const nested = Object.values(workspaces).find(v => v && typeof v === 'object' && typeof v.cwd === 'string');
  if (nested?.cwd) return nested.cwd;
  // Codex format: keys are paths, values are metadata objects
  const pathKey = Object.keys(workspaces).find(k => k.startsWith('/'));
  return pathKey || null;
}

function safeSend(target, data, isBinary) {
  if (target.readyState === WebSocket.OPEN) {
    target.send(data, { binary: isBinary }, () => {});
  }
}

// Buffer one frame for a CONNECTING upstream. Returns true on overflow so the
// caller can shut the pair down instead of growing memory unboundedly.
function bufferOrSend(target, state, data, isBinary) {
  if (target.readyState === WebSocket.OPEN) {
    target.send(data, { binary: isBinary }, () => {});
    return { overflow: false };
  }
  if (target.readyState !== WebSocket.CONNECTING) {
    return { overflow: false };
  }
  const size = frameSize(data);
  if (state.bufferedBytes + size > state.maxBytes) {
    return { overflow: true, size };
  }
  state.queue.push({ data, isBinary });
  state.bufferedBytes += size;
  return { overflow: false };
}

function flushQueue(target, state) {
  while (state.queue.length && target.readyState === WebSocket.OPEN) {
    const item = state.queue.shift();
    state.bufferedBytes = Math.max(0, state.bufferedBytes - frameSize(item.data));
    target.send(item.data, { binary: item.isBinary }, () => {});
  }
}

function frameSize(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

// WS close reason field is capped at 123 bytes by RFC 6455; the ws library
// throws RangeError when it overflows. Clamp by codepoint to stay UTF-8 safe.
function clampWsReason(reason) {
  const str = typeof reason === 'string' ? reason : String(reason || '');
  if (Buffer.byteLength(str) <= WS_CLOSE_REASON_MAX_BYTES) return str;
  let bytes = 0;
  let out = '';
  for (const ch of str) {
    const len = Buffer.byteLength(ch);
    if (bytes + len > WS_CLOSE_REASON_MAX_BYTES) break;
    bytes += len;
    out += ch;
  }
  return out;
}

function normalizeCloseCode(code) {
  if (!Number.isInteger(code)) return 1000;
  if (code >= 3000 && code <= 4999) return code;
  if (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) return code;
  return 1000;
}

async function recordWebSocketEntry(ctx, result, turn = null) {
  const t = turn || ctx;
  const entryId = t.id || ctx.id;
  const entryTs = t.ts || ctx.ts;
  const elapsed = ((Date.now() - (t.startTime || ctx.startTime)) / 1000).toFixed(1);
  const cr = t.clientRequest ?? ctx.clientRequest;
  const events = t.responseEvents ?? ctx.responseEvents;
  const lastUsage = t.lastUsage ?? ctx.lastUsage;
  const lastModel = t.lastModel ?? ctx.lastModel;
  const lastResponseStatus = t.lastResponseStatus ?? ctx.lastResponseStatus;
  const baseHeaders = {
    openaiBeta: ctx.req.headers['openai-beta'] || null,
    sessionId: ctx.sessionId,
    agentType: ctx.agentType,
  };
  const reqLog = cr
    ? {
      provider: 'openai',
      model: cr.model,
      instructions: cr.instructions,
      input: cr.input,
      tools: cr.tools,
      tool_choice: cr.tool_choice,
      previous_response_id: cr.previous_response_id,
      transport: 'websocket',
      method: ctx.req.method,
      url: stripAuthParams(ctx.req.url),
      endpoint: ctx.endpoint,
      headers: baseHeaders,
      metadata: ctx.turnMetadata || null,
    }
    : {
      transport: 'websocket',
      capture: 'transport-only',
      method: ctx.req.method,
      url: stripAuthParams(ctx.req.url),
      endpoint: ctx.endpoint,
      headers: baseHeaders,
      metadata: ctx.turnMetadata || null,
    };
  const hasEvents = events.length > 0;
  const resLog = hasEvents
    ? events
    : {
      transport: 'websocket',
      capture: 'transport-only',
      frameCounts: ctx.frameCounts,
      byteCounts: ctx.byteCounts,
      close: result.close || null,
      error: result.error || null,
    };

  const reqWritePromise = config.storage.write(entryId, '_req.json', JSON.stringify(reqLog))
    .catch(e => console.error('Write ws req.json failed:', e.message));
  const resWritePromise = config.storage.write(entryId, '_res.json', JSON.stringify(resLog))
    .catch(e => console.error('Write ws res.json failed:', e.message));

  const { getParser } = require('./wire-parsers');
  const responseMetadata = {
    transport: 'websocket',
    capture: 'transport-only',
    endpoint: ctx.endpoint,
    frameCounts: ctx.frameCounts,
    byteCounts: ctx.byteCounts,
    close: result.close || null,
    error: result.error || null,
  };
  const entry = {
    id: entryId,
    ts: entryTs,
    method: ctx.req.method,
    url: stripAuthParams(ctx.req.url),
    req: reqLog,
    res: resLog,
    elapsed,
    status: result.status,
    isSSE: false,
    receivedAt: t.startTime || ctx.startTime,
    tokens: cr ? helpers.tokenizeRequest(reqLog) : null,
    duplicateToolCalls: null,
    ...getParser('openai').buildEntryFields({
      provider: 'openai', transport: 'websocket',
      parsedBody: cr || {}, responseEvents: events,
      responseMetadata, lastUsage, lastModel, lastResponseStatus,
      proxyRes: { statusCode: result.status },
      sessionId: ctx.sessionId, sessionInferred: ctx.sessionInferred,
      isSubagent: ctx.agentType === 'explorer' || ctx.agentType === 'worker',
      cwd: store.sessionMeta[ctx.sessionId]?.cwd || null,
      wsCloseReason: result.close?.reason || null,
      wsErrorMessage: result.error?.message || null,
    }),
  };
  entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
  entry.toolSources = helpers.buildToolSources(entry) || undefined;
  entry._writePromise = Promise.all([reqWritePromise, resWritePromise]);
  store.entries.push(entry);
  store.trimEntries();
  broadcast(entry);

  const indexLine = buildIndexLine(entry);
  config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write ws index failed:', e.message));
  entry.req = null;
  entry.res = null;
  entry._loaded = false;
  if (!turn) ctx.clientRequest = null;
}

function handleWebSocketUpgrade(req, socket, head) {
  const upstream = config.getUpstreamForRequestAndHeaders(req.url, req.headers);
  if (!isOpenAIWebSocket(req, upstream)) {
    writeSocketResponse(socket, 404, 'Not Found');
    return true;
  }
  if (!isAuthorized(req)) {
    writeSocketResponse(socket, 401, 'Unauthorized');
    return true;
  }

  const id = helpers.timestamp();
  const ts = helpers.taipeiTime();
  const startTime = Date.now();
  const detected = detectOpenAISession(req.headers, null);
  const sessionId = detected.sessionId;
  const turnMetadata = parseCodexTurnMetadata(req.headers);
  const agentType = getOpenAIAgentTypeFromHeaders(req.headers);
  const cwd = getWorkspaceCwd(turnMetadata);
  const endpoint = (req.url || '').split('?')[0];

  if (!store.sessionMeta[sessionId]) store.sessionMeta[sessionId] = {};
  store.sessionMeta[sessionId].provider = 'openai';
  store.sessionMeta[sessionId].lastSeenAt = Date.now();
  if (cwd) store.sessionMeta[sessionId].cwd = cwd;
  if (agentType) store.sessionMeta[sessionId].agentType = agentType;
  store.activeRequests[sessionId] = (store.activeRequests[sessionId] || 0) + 1;
  broadcastSessionStatus(sessionId);
  if (detected.isNewSession) store.printSessionBanner(sessionId);

  wss.handleUpgrade(req, socket, head, clientWs => {
    const upstreamUrl = getWebSocketUrl(upstream, stripAuthParams(req.url));
    const upstreamWs = new WebSocket(upstreamUrl, getWebSocketProtocols(req.headers), {
      headers: buildWebSocketHeaders(req.headers, upstream),
    });
    const ctx = {
      id,
      ts,
      startTime,
      req,
      sessionId,
      agentType,
      turnMetadata,
      endpoint,
      sessionInferred: detected.inferred || !getCodexSessionId(req.headers, null),
      frameCounts: { clientToUpstream: 0, upstreamToClient: 0 },
      byteCounts: { clientToUpstream: 0, upstreamToClient: 0 },
      responseEvents: [],
      lastUsage: null,
      lastModel: null,
      lastResponseStatus: null,
      clientRequest: null,
    };
    // Only client→upstream needs queueing; clientWs is already OPEN inside this
    // callback so upstream→client can always send directly via safeSend().
    const upstreamBuffer = { queue: [], bufferedBytes: 0, maxBytes: MAX_QUEUE_BYTES };
    let finalized = false;
    let idleTimer = null;
    let currentTurn = null;
    let turnEmitted = false;
    const session = { forceFinalize: null };
    activeSessions.add(session);

    function startNewTurn(request) {
      currentTurn = {
        id: helpers.timestamp(),
        ts: helpers.taipeiTime(),
        startTime: Date.now(),
        clientRequest: request,
        responseEvents: [],
        lastUsage: null,
        lastModel: null,
        lastResponseStatus: null,
      };
    }

    function finalizeTurn(result) {
      if (!currentTurn) return;
      const turn = currentTurn;
      currentTurn = null;
      turnEmitted = true;
      const entryPromise = recordWebSocketEntry(ctx, result, turn)
        .catch(e => console.error('Record ws turn entry failed:', e.message));
      pendingEntries.add(entryPromise);
      entryPromise.finally(() => pendingEntries.delete(entryPromise));
    }

    function refreshIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        closeBoth(1011, 'idle timeout');
        finalize({ status: 504, error: { message: `WebSocket idle timeout after ${IDLE_TIMEOUT_MS}ms` } });
      }, IDLE_TIMEOUT_MS);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    }

    function finalize(result) {
      if (finalized) return;
      finalized = true;
      clearTimeout(idleTimer);
      activeSessions.delete(session);
      store.activeRequests[sessionId] = Math.max(0, (store.activeRequests[sessionId] || 1) - 1);
      if (store.sessionMeta[sessionId]) store.sessionMeta[sessionId].lastStopReason = null;
      broadcastSessionStatus(sessionId);
      if (currentTurn) {
        finalizeTurn(result);
      } else if (!turnEmitted) {
        const entryPromise = recordWebSocketEntry(ctx, result)
          .catch(e => console.error('Record ws entry failed:', e.message));
        pendingEntries.add(entryPromise);
        entryPromise.finally(() => pendingEntries.delete(entryPromise));
      }
    }

    session.forceFinalize = () => {
      if (finalized) return;
      closeBoth(1001, 'proxy shutting down');
      finalize({ status: 499, error: { message: 'ccxray shutdown before WebSocket closed' } });
    };

    function closeBoth(code, reason) {
      const closeCode = normalizeCloseCode(code);
      const closeReason = clampWsReason(reason);
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close(closeCode, closeReason);
      }
      if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
        upstreamWs.close(closeCode, closeReason);
      }
    }

    // Arm the idle timer before the upstream handshake completes so a stalled
    // upstream (accepts TCP, never sends 101) is bounded by IDLE_TIMEOUT_MS.
    refreshIdleTimer();

    clientWs.on('message', (data, isBinary) => {
      refreshIdleTimer();
      ctx.frameCounts.clientToUpstream += 1;
      ctx.byteCounts.clientToUpstream += frameSize(data);
      if (!isBinary) {
        try {
          const parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
          if (parsed.type === 'response.create') {
            if (parsed.generate !== false) {
              if (currentTurn) finalizeTurn({ status: 101 });
              const request = {
                model: parsed.model || null,
                instructions: parsed.instructions || null,
                input: parsed.input || null,
                tools: parsed.tools || null,
                tool_choice: parsed.tool_choice || null,
                previous_response_id: parsed.previous_response_id || null,
              };
              startNewTurn(request);
              if (!ctx.clientRequest) ctx.clientRequest = request;
            }
          } else if (parsed.type === 'session.update' && parsed.session?.instructions) {
            if (currentTurn?.clientRequest) currentTurn.clientRequest.instructions = parsed.session.instructions;
            if (ctx.clientRequest) ctx.clientRequest.instructions = parsed.session.instructions;
          }
        } catch {}
      }
      const result = bufferOrSend(upstreamWs, upstreamBuffer, data, isBinary);
      if (result.overflow) {
        closeBoth(1009, 'client buffer exceeded');
        finalize({ status: 507, error: { message: `Client send buffer exceeded ${MAX_QUEUE_BYTES} bytes while upstream was connecting` } });
      }
    });
    upstreamWs.on('message', (data, isBinary) => {
      refreshIdleTimer();
      ctx.frameCounts.upstreamToClient += 1;
      ctx.byteCounts.upstreamToClient += frameSize(data);
      if (!isBinary) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type) {
            const r = parsed.response || parsed;
            const usage = r.usage ? (extractOpenAIUsage({ usage: r.usage }) || r.usage) : null;
            const model = r.model || null;
            const isTerminal = typeof r.status === 'string' && WS_TERMINAL_STATUSES.has(r.status);

            if (currentTurn) {
              if (usage) currentTurn.lastUsage = usage;
              if (model) currentTurn.lastModel = model;
              if (isTerminal) currentTurn.lastResponseStatus = r.status;
              if (!WS_SKIP_EVENTS.has(parsed.type)) currentTurn.responseEvents.push(parsed);
            }

            if (usage) ctx.lastUsage = usage;
            if (model) ctx.lastModel = model;
            if (isTerminal) ctx.lastResponseStatus = r.status;
            if (!WS_SKIP_EVENTS.has(parsed.type)) ctx.responseEvents.push(parsed);

            if (parsed.type === 'response.completed' && currentTurn) {
              finalizeTurn({ status: 101 });
            }
          }
        } catch {}
      }
      safeSend(clientWs, data, isBinary);
    });
    clientWs.on('ping', data => {
      refreshIdleTimer();
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.ping(data, undefined, () => {});
    });
    upstreamWs.on('ping', data => {
      refreshIdleTimer();
      if (clientWs.readyState === WebSocket.OPEN) clientWs.ping(data, undefined, () => {});
    });
    clientWs.on('pong', data => {
      refreshIdleTimer();
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.pong(data, undefined, () => {});
    });
    upstreamWs.on('pong', data => {
      refreshIdleTimer();
      if (clientWs.readyState === WebSocket.OPEN) clientWs.pong(data, undefined, () => {});
    });
    upstreamWs.on('open', () => {
      refreshIdleTimer();
      flushQueue(upstreamWs, upstreamBuffer);
    });
    upstreamWs.on('unexpected-response', (request, response) => {
      // ws gives us ownership when a listener is present: drain and destroy
      // both ends so the underlying HTTP socket doesn't leak.
      const statusCode = response.statusCode || 502;
      try { response.resume(); } catch {}
      try { request.destroy(); } catch {}
      closeBoth(1011, `upstream ${statusCode}`);
      finalize({ status: statusCode, error: { message: `Upstream WebSocket rejected handshake: ${statusCode}` } });
    });
    clientWs.on('close', (code, reason) => {
      const reasonStr = reason.toString();
      if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
        upstreamWs.close(normalizeCloseCode(code), clampWsReason(reasonStr));
      }
      finalize({ status: 101, close: { side: 'client', code, reason: reasonStr } });
    });
    upstreamWs.on('close', (code, reason) => {
      const reasonStr = reason.toString();
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close(normalizeCloseCode(code), clampWsReason(reasonStr));
      }
      finalize({ status: 101, close: { side: 'upstream', code, reason: reasonStr } });
    });
    clientWs.on('error', err => {
      closeBoth(1011, 'client error');
      finalize({ status: 502, error: { side: 'client', message: err.message } });
    });
    upstreamWs.on('error', err => {
      closeBoth(1011, 'upstream error');
      finalize({ status: 502, error: { side: 'upstream', message: err.message } });
    });
  });
  return true;
}

// Force-close any active WS sessions (so their finalize runs and
// recordWebSocketEntry kicks off writes), then await all in-flight
// recordWebSocketEntry promises. Storage.drain() should be called AFTER this
// so the writes recordWebSocketEntry queued are also flushed.
async function drainWebSocketProxy() {
  for (const session of [...activeSessions]) {
    try { session.forceFinalize(); } catch {}
  }
  await Promise.allSettled([...pendingEntries]);
}

module.exports = {
  handleWebSocketUpgrade,
  buildWebSocketHeaders,
  isOpenAIWebSocket,
  normalizeCloseCode,
  drainWebSocketProxy,
};
