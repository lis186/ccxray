'use strict';

const https = require('https');
const http = require('http');
const tls = require('tls');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const { buildEditedReqRecord } = require('./delta-helpers');
const { calculateCost } = require('./pricing');
const helpers = require('./helpers');
const { broadcast, broadcastSessionStatus, broadcastSessionTitleUpdate } = require('./sse-broadcast');
const { appendSample, collectRatelimitHeaders } = require('./ratelimit-log');
const hub = require('./hub');
const { stripAuthParams, stripControlChars } = require('./url-sanitize');
const { getParser } = require('./wire-parsers');
const { agentForProvider } = require('./providers');
const { buildIndexLine } = require('./entry');
const {
  isOpenAIResponseObject, extractOpenAIResponse, getOpenAIResponseFromEvents,
  getOpenAIOutputSummary, getOpenAIInputSummary, buildResponseMetadata,
} = require('./openai-response');

// For title-generator subagent responses, extract the clean title from the
// JSON payload and (when attribution succeeds) stamp it onto the parent
// session. Returns the clean title string or null.
// Gate on response shape, not request agent type: title-gen requests can arrive
// without a system prompt so system-based detection is unreliable.
function resolveTitleGenTitle(parsedBody, resPayload, receivedAt) {
  const clean = helpers.extractTitleGenPayload(resPayload);
  if (!clean) return null;
  if (store.extractCwd(parsedBody)) return null; // main orchestrator, not a subagent
  const parentSid = store.attributeTitleGen(parsedBody, receivedAt);
  if (parentSid && store.setSessionTitle(parentSid, clean, receivedAt)) {
    broadcastSessionTitleUpdate(parentSid);
  }
  return clean;
}

// ── thinkingStripped: true when prev non-subagent turn had thinking but current messages lost it ──
// compaction (msgCount drop > 4) is excluded to avoid false positives on summarized history
function computeThinkingStripped(isSubagent, reqSessionId, currMsgCount, parsedBody) {
  if (isSubagent) return undefined;
  let prevThink = null;
  for (let i = store.entries.length - 1; i >= 0; i--) {
    const e = store.entries[i];
    if (e.sessionId === reqSessionId && !e.isSubagent && (e.thinkingDuration || 0) > 0) {
      prevThink = e;
      break;
    }
  }
  if (!prevThink) return undefined;
  if (currMsgCount < (prevThink.msgCount || 0) - 4) return undefined;
  const hasThinkBlocks = (parsedBody?.messages || []).some(m =>
    m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'thinking')
  );
  return hasThinkBlocks ? undefined : true;
}

// ── Status line injection flag ────────────────────────────────────────
let statusLineEnabled = true;
function setStatusLineEnabled(val) { statusLineEnabled = !!val; }
function getStatusLineEnabled() { return statusLineEnabled; }

// Track sessions where we've already logged HUD injection — keeps logs quiet.
const _hudLoggedSessions = new Set();

// ── HTTPS CONNECT tunnel agent for corporate proxies ─────────────────

function createTunnelAgent(proxyUrl) {
  const proxy = new URL(proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = parseInt(proxy.port) || 3128;

  const agent = new https.Agent({ keepAlive: false });

  agent.createConnection = function(options, callback) {
    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${options.host}:${options.port || 443}`,
      headers: { Host: `${options.host}:${options.port || 443}` },
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return callback(new Error(`Proxy CONNECT failed: ${res.statusCode} ${res.statusMessage}`));
      }
      const tlsOpts = { socket, servername: options.servername || options.host };
      if (options.rejectUnauthorized !== undefined) tlsOpts.rejectUnauthorized = options.rejectUnauthorized;
      let connected = false;
      const tlsSocket = tls.connect(tlsOpts, () => {
        connected = true;
        callback(null, tlsSocket);
      });
      tlsSocket.on('error', (err) => {
        if (!connected) return callback(err);
        console.error(`\x1b[31m❌ TUNNEL SOCKET ERROR: ${err.code || err.message}\x1b[0m`);
      });
    });

    connectReq.on('error', callback);
    connectReq.end();
  };

  agent._proxyUrl = proxyUrl;
  return agent;
}

function resolveProxyAgent(protocol, env) {
  if (protocol !== 'https') return null;
  const proxyUrl = env.HTTPS_PROXY || env.https_proxy;
  if (!proxyUrl) return null;
  return createTunnelAgent(proxyUrl);
}

// ── Model name prefix rewriting ──────────────────────────────────────
function applyModelPrefix(parsedBody, prefix) {
  if (!prefix || !parsedBody?.model || parsedBody.model.startsWith(prefix)) return false;
  parsedBody.model = prefix + parsedBody.model;
  return true;
}

function parseSSEFrame(rawFrame, receivedAt) {
  const frame = { event: null, type: null, data: null };
  if (receivedAt) frame._ts = receivedAt;

  const dataLines = [];
  for (const rawLine of String(rawFrame || '').split(/\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    const field = sep >= 0 ? line.slice(0, sep) : line;
    let value = sep >= 0 ? line.slice(sep + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') frame.event = value || null;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') frame.id = value;
    else if (field === 'retry') frame.retry = value;
  }

  const dataText = dataLines.join('\n');
  if (!dataText) {
    frame.type = frame.event || 'raw';
    frame.raw = rawFrame;
    return frame;
  }
  if (dataText === '[DONE]') {
    frame.type = frame.event || 'done';
    frame.data = '[DONE]';
    return frame;
  }

  try {
    const parsed = JSON.parse(dataText);
    frame.data = parsed;
    frame.type = parsed?.type || frame.event || null;
  } catch {
    frame.type = frame.event || 'raw';
    frame.dataRaw = dataText;
    frame.raw = rawFrame;
    frame.parseError = true;
  }
  return frame;
}

function parseSSEText(raw, receivedAt) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  if (!/^\s*(event|data):/m.test(text)) return null;
  const events = [];
  for (const part of text.split('\n\n')) {
    if (!part.trim()) continue;
    events.push(parseSSEFrame(part, receivedAt));
  }
  return events.length ? events : null;
}

function normalizeOpenAIResponseSummary(meta, resData) {
  if (meta?.responseMetadata?.transport === 'websocket') {
    return { summary: { ...meta, isSSE: false }, resData };
  }
  const events = Array.isArray(resData)
    ? resData
    : (typeof resData === 'string' ? parseSSEText(resData) : null);
  const response = events ? getOpenAIResponseFromEvents(events) : extractOpenAIResponse(resData);
  if (!response) return { summary: meta, resData };

  const responseMetadata = {
    ...(meta.responseMetadata || {}),
    provider: 'openai',
    id: response.id || meta.responseMetadata?.id || null,
    object: response.object || meta.responseMetadata?.object || null,
    model: response.model || meta.responseMetadata?.model || null,
    status: meta.status ?? meta.responseMetadata?.status ?? null,
    responseStatus: response.status || meta.responseMetadata?.responseStatus || null,
  };

  return {
    summary: {
      ...meta,
      isSSE: events ? true : meta.isSSE,
      model: meta.model || response.model || null,
      usage: meta.usage || response.usage || null,
      stopReason: meta.stopReason || response.status || '',
      title: meta.title || getOpenAIOutputSummary(response),
      responseMetadata,
    },
    resData: events || resData,
  };
}

// Tunnel agents are module-level so connection pools are reused across requests.
const TUNNEL_AGENTS = new Map();
function getTunnelAgent(upstream) {
  if (!upstream || upstream.protocol !== 'https') return null;
  const key = upstream.provider || `${upstream.protocol}:${upstream.host}:${upstream.port}`;
  if (!TUNNEL_AGENTS.has(key)) {
    TUNNEL_AGENTS.set(key, resolveProxyAgent(upstream.protocol, process.env));
  }
  return TUNNEL_AGENTS.get(key);
}

// ── Strip injected proxy stats from conversation history ─────────────
const STATS_PATTERN = /\n\n---\n📊 Context: .+$/s;

function stripInjectedStats(parsedBody) {
  if (!parsedBody?.messages) return false;
  let modified = false;
  for (const msg of parsedBody.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const block = msg.content[i];
      if (block.type !== 'text') continue;
      if (STATS_PATTERN.test(block.text)) {
        block.text = block.text.replace(STATS_PATTERN, '');
        if (!block.text) { msg.content.splice(i, 1); }
        modified = true;
      }
    }
  }
  return modified;
}

// Build the human-readable diff lines injected into the response stream when a
// request was edited via dashboard intercept. Pure function so it can be tested
// independently of the SSE plumbing. Returns an array of one-line strings.
function buildEditSummary(orig, mod, opts) {
  const MAX_SHOWN = (opts && opts.maxShown) || 5;
  const MAX_LEN = (opts && opts.maxLen) || 60;
  const diffs = [];
  if (!orig || !mod) return diffs;

  const snippet = (c) => {
    if (c == null) return '';
    const s = typeof c === 'string' ? c : JSON.stringify(c);
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_LEN ? flat.slice(0, MAX_LEN) + '…' : flat;
  };

  if (orig.model !== mod.model) diffs.push('Model: ' + orig.model + ' → ' + mod.model);

  const origMsgs = orig.messages || [];
  const modMsgs = mod.messages || [];
  if (origMsgs.length !== modMsgs.length) {
    diffs.push('Messages: ' + origMsgs.length + ' → ' + modMsgs.length);
  }

  // Per-message edits: show old → new snippet, not just a count, so the CLI
  // notice tells the user what actually changed.
  const edited = [];
  for (let i = 0; i < modMsgs.length; i++) {
    const o = origMsgs[i];
    if (!o) continue;
    const oStr = typeof o.content === 'string' ? o.content : JSON.stringify(o.content);
    const mStr = typeof modMsgs[i].content === 'string' ? modMsgs[i].content : JSON.stringify(modMsgs[i].content);
    if (oStr !== mStr) {
      edited.push((modMsgs[i].role || 'msg') + '[' + i + ']: "' + snippet(o.content) + '" → "' + snippet(modMsgs[i].content) + '"');
    }
  }
  for (const line of edited.slice(0, MAX_SHOWN)) diffs.push(line);
  if (edited.length > MAX_SHOWN) diffs.push('…and ' + (edited.length - MAX_SHOWN) + ' more message(s) edited');

  const origToolLen = (orig.tools || []).length;
  const modToolLen = (mod.tools || []).length;
  if (origToolLen !== modToolLen) {
    diffs.push('Tools: ' + origToolLen + ' → ' + modToolLen + ' (' + (modToolLen - origToolLen >= 0 ? '+' : '') + (modToolLen - origToolLen) + ')');
  }

  const origSys = typeof orig.system === 'string' ? orig.system : JSON.stringify(orig.system);
  const modSys = typeof mod.system === 'string' ? mod.system : JSON.stringify(mod.system);
  if (origSys !== modSys) diffs.push('System prompt: "' + snippet(orig.system) + '" → "' + snippet(mod.system) + '"');

  return diffs;
}

// ── Intercept-edit persistence ───────────────────────────────────────
// sessionLastReq (the per-session delta anchor) lives privately in index.js.
// It injects a narrow recorder so this module can re-anchor the chain after an
// edited rewrite (messages = clone of edited) or CLEAR it on failure (messages
// = null → next turn re-anchors full). Keeps mutable session state encapsulated.
let sessionAnchorRecorder = null;
function setSessionAnchorRecorder(fn) { sessionAnchorRecorder = fn; }

function sha12(value) {
  return value == null ? null
    : crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

// Persist an intercept-edited request. _req.json was written at receipt time
// (index.js) from the ORIGINAL body; this rewrites it as-sent so the dashboard
// shows what actually went upstream, while preserving the original in a
// non-authoritative `_req.received.json` sidecar (forensics + the "original
// before edit" view). Order matters: write the received sidecar and edited
// shared sys/tools FIRST, then overwrite the canonical _req.json, so a lazy load
// never observes a half-applied edit. On full success re-anchor the delta chain
// from a CLONE of the edited messages; on ANY failure clear the anchor so the
// next turn re-anchors full (no split-brain between disk and the in-memory anchor).
// Returns a promise; the caller folds it into ctx.reqWritePromise.
async function persistEditedRequest(ctx) {
  const { id, parsedBody, originalBody, reqSessionId } = ctx;
  if (!parsedBody) return;

  ctx.edited = true;
  ctx.editSummary = ctx.editSummary || buildEditSummary(originalBody, parsedBody);

  try {
    // 1. Forensic original, preserved before _req.json is overwritten.
    if (originalBody) {
      await config.storage.write(id, '_req.received.json', JSON.stringify(originalBody));
    }

    // 2. Edited system/tools, content-addressed. Write the shared file only when
    //    the edit actually changed it (compare against the ORIGINAL hash, not
    //    ctx.sysHash, which the forward gate may have already set to the edited
    //    value). Update ctx so entry/index metadata point at the edited content.
    const editedSysHash = parsedBody.system ? sha12(parsedBody.system) : null;
    const editedToolsHash = parsedBody.tools ? sha12(parsedBody.tools) : null;
    const origSysHash = originalBody && originalBody.system ? sha12(originalBody.system) : null;
    const origToolsHash = originalBody && originalBody.tools ? sha12(originalBody.tools) : null;
    if (editedSysHash && editedSysHash !== origSysHash) {
      await config.storage.writeSharedIfAbsent(`sys_${editedSysHash}.json`, JSON.stringify(parsedBody.system));
    }
    if (editedToolsHash && editedToolsHash !== origToolsHash) {
      await config.storage.writeSharedIfAbsent(`tools_${editedToolsHash}.json`, JSON.stringify(parsedBody.tools));
    }
    ctx.sysHash = editedSysHash;
    ctx.toolsHash = editedToolsHash;

    // 3. Canonical _req.json, as-sent, full format (no prevId/msgOffset).
    const record = buildEditedReqRecord(parsedBody, {
      sysHash: editedSysHash, toolsHash: editedToolsHash, sessionId: reqSessionId,
    });
    await config.storage.write(id, '_req.json', JSON.stringify(record));

    // 4. Re-anchor the delta chain from a CLONE (never the live parsedBody array),
    //    only for delta-eligible turns (explicit session + delta-capable storage).
    if (reqSessionId && config.storage.supportsDelta && sessionAnchorRecorder) {
      sessionAnchorRecorder(reqSessionId, id, JSON.parse(JSON.stringify(record.messages)));
    }
  } catch (e) {
    console.error('Edited request persistence failed:', e.message);
    // Split-brain mitigation: disk is uncertain → clear the anchor so the next
    // turn writes FULL rather than a delta against an unrecoverable base.
    if (reqSessionId && sessionAnchorRecorder) sessionAnchorRecorder(reqSessionId, id, null);
  }
}

// ── Upstream error classification ───────────────────────────────────
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNREFUSED', 'EAI_AGAIN']);

function describeUpstreamError(err, host) {
  const code = err.code || '';
  const labels = {
    ETIMEDOUT: 'connection timed out',
    ENOTFOUND: 'DNS lookup failed',
    EHOSTUNREACH: 'host unreachable',
    ECONNREFUSED: 'connection refused',
    EAI_AGAIN: 'DNS temporarily unavailable',
    ECONNRESET: 'connection reset by peer',
    EPIPE: 'broken pipe',
  };
  const hints = {
    ETIMEDOUT: 'check your network connection',
    ENOTFOUND: 'check your network or DNS settings',
    EHOSTUNREACH: 'check your network connection',
    ECONNREFUSED: 'is the upstream API available?',
    EAI_AGAIN: 'DNS will likely recover on its own',
  };
  const label = labels[code] || err.message || code || 'unknown error';
  const codeTag = code ? ` (${code})` : '';
  let agentVer = null;
  for (const e of store.versionIndex.values()) {
    if (e.version && (!agentVer || e.version > agentVer.v)) {
      agentVer = { v: e.version, label: e.agentLabel };
    }
  }
  const verTag = agentVer ? ` [${agentVer.label} ${agentVer.v}]` : '';
  return {
    code,
    summary: `${host}: ${label}${codeTag}${verTag}`,
    hint: hints[code] || null,
    retryable: RETRYABLE_CODES.has(code),
  };
}

// ── Forward request to Anthropic ─────────────────────────────────────
function forwardRequest(ctx) {
  const { id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId } = ctx;
  const upstream = ctx.upstream || config.getUpstreamForRequest(clientReq.url);
  const provider = upstream.provider || 'anthropic';

  // Counter + attribution prefix are committed here, not at request receipt.
  // This guarantees intercepted-then-rejected requests never advance the
  // per-session sequence number that the dashboard's displayNum mirrors.
  // Counter classification uses isAnthropicSubagent to match dashboard's isSubagent.
  if (!ctx.skipEntry && parsedBody) {
    const meta = reqSessionId ? (store.sessionMeta[reqSessionId] || (store.sessionMeta[reqSessionId] = {})) : null;
    const isSubagent = provider === 'anthropic' && store.isAnthropicSubagent(parsedBody);
    if (meta) {
      if (isSubagent) meta.subCount = (meta.subCount || 0) + 1;
      else meta.mainCount = (meta.mainCount || 0) + 1;
    }
    const sessNumStr = meta
      ? (isSubagent ? ('s' + meta.subCount) : String(meta.mainCount))
      : null;
    let cwdForPrefix = meta?.cwd || null;
    if (!cwdForPrefix && reqSessionId && reqSessionId !== 'direct-api') {
      cwdForPrefix = hub.lookupClientCwd();
    }
    const isOrphan = isSubagent && ctx.sessionInferred && !cwdForPrefix && (!reqSessionId || reqSessionId === 'direct-api');
    const turnStep = provider === 'anthropic'
      ? helpers.computeTurnStep(parsedBody.messages)
      : { turn: 0, step: 0 };
    ctx.attribPrefix = helpers.renderAttributionPrefix({
      sessionId: reqSessionId,
      cwd: cwdForPrefix,
      sessNum: sessNumStr,
      turn: turnStep.turn,
      step: turnStep.step,
      sessionInferred: ctx.sessionInferred,
      isQuotaCheck: false,
      isOrphan,
      reqId: id,
    });
    helpers.printSeparator();
    console.log(`\x1b[36m📤 [${ts}]  ${ctx.attribPrefix}  ${stripControlChars(clientReq.method)} ${stripControlChars(stripAuthParams(clientReq.url))}\x1b[0m`);
    console.log(helpers.summarizeRequest(parsedBody));
  }

  // Remove previously injected stats so they don't accumulate in conversation
  const statsStripped = stripInjectedStats(parsedBody);
  const modelPrefixed = applyModelPrefix(parsedBody, config.REWRITE_MODEL_PREFIX);
  const bodyToSend = (ctx.bodyModified || statsStripped || modelPrefixed) ? Buffer.from(JSON.stringify(parsedBody)) : rawBody;

  // Intercept-edited body: persist it as-sent (rewrite _req.json) + a forensic
  // _req.received.json. This runs AFTER stripInjectedStats/applyModelPrefix so
  // the persisted record matches the bytes actually sent. Chain after the
  // original receipt-time write (never Promise.all — the original must not land
  // last and restore stale bytes); loadEntryReqRes awaits entry._writePromise,
  // which bundles ctx.reqWritePromise, so the read path observes the rewrite.
  if (ctx.bodyModified && provider === 'anthropic' && !ctx.skipEntry) {
    // Set edited state + as-sent hashes synchronously so the entry built in the
    // response handler (and its index line) reference the edited content
    // regardless of when the async persist runs. persist decides shared-file
    // writes by comparing against the ORIGINAL hashes (from originalBody), so
    // mutating ctx.sysHash/toolsHash here does not affect that decision.
    ctx.edited = true;
    ctx.editSummary = buildEditSummary(ctx.originalBody, parsedBody);
    ctx.sysHash = parsedBody.system ? sha12(parsedBody.system) : null;
    ctx.toolsHash = parsedBody.tools ? sha12(parsedBody.tools) : null;
    const prior = ctx.reqWritePromise || Promise.resolve();
    ctx.reqWritePromise = prior.then(() => persistEditedRequest(ctx), () => persistEditedRequest(ctx));
  }

  const transport = upstream.protocol === 'http' ? http : https;
  const tunnelAgent = getTunnelAgent(upstream);

  function sendUpstream(attempt) {
    if (clientRes.destroyed) return;
    const proxyReq = transport.request({
      hostname: upstream.host, port: upstream.port,
      path: config.joinUpstreamPath(upstream, stripAuthParams(clientReq.url)), method: clientReq.method,
      headers: { ...fwdHeaders, 'content-length': bodyToSend.length },
      ...(tunnelAgent ? { agent: tunnelAgent } : {}),
    }, (proxyRes) => {
      const isSSE = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

      // Capture rate limit headers once, share with state + sample log.
      const parsedRL = collectRatelimitHeaders(proxyRes.headers);
      if (parsedRL && parsedRL.tokensLimit != null) {
        store.setRateLimitState({ ...parsedRL, updatedAt: Date.now() });
      }
      if (parsedRL) {
        appendSample({
          parsed: parsedRL,
          model: parsedBody?.model || null,
          planHint: process.env.CCXRAY_PLAN || null,
        });
      }
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);

      if (isSSE) {
        handleSSEResponse(ctx, proxyRes, clientRes);
      } else {
        handleNonSSEResponse(ctx, proxyRes, clientRes);
      }
    });

    let reqErrorHandled = false;
    proxyReq.on('error', (err) => {
      reqErrorHandled = true;
      const info = describeUpstreamError(err, upstream.host);

      if (info.retryable && attempt === 0 && !clientRes.headersSent && !clientRes.destroyed) {
        console.error(`\x1b[33m⏳ ${info.summary} — retrying…\x1b[0m`);
        setTimeout(() => sendUpstream(1), 1000);
        return;
      }

      const suffix = attempt > 0 ? ' — retry failed' : '';
      console.error(`\x1b[31m❌ ${info.summary}${suffix}\x1b[0m`);
      if (info.hint) console.error(`\x1b[31m   → ${info.hint}\x1b[0m`);
      if (reqSessionId) {
        store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
        broadcastSessionStatus(reqSessionId);
      }
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      }
      clientRes.end(JSON.stringify({ error: 'proxy_error', message: err.message }));
    });

    // Late socket errors (EPIPE / ECONNRESET after response received) may not
    // re-emit on the ClientRequest. Listener prevents uncaught-exception crash.
    // Deferred check avoids duplicate logging when proxyReq 'error' already fired.
    proxyReq.on('socket', (socket) => {
      socket.on('error', (err) => {
        setImmediate(() => {
          if (!reqErrorHandled) {
            console.error(`\x1b[31m❌ ${upstream.host}: socket error — ${err.code || err.message}\x1b[0m`);
          }
        });
      });
    });

    proxyReq.end(bodyToSend);
  }

  sendUpstream(0);
}

function handleSSEResponse(ctx, proxyRes, clientRes) {
  const provider = ctx.upstream?.provider || 'anthropic';
  if (provider === 'openai') {
    handleOpenAISSE(ctx, proxyRes, clientRes);
    return;
  }

  const { id, startTime, parsedBody, reqSessionId, fwdHeaders } = ctx;
  const resChunks = [];
  let sseLineBuf = '';
  let maxBlockIndex = -1;
  const heldEvents = [];
  const eventTimestamps = [];
  let eventSeqIdx = 0;

  proxyRes.on('error', (err) => {
    console.error(`\x1b[31m❌ UPSTREAM STREAM ERROR: ${err.message}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.writableEnded) clientRes.end();
  });

  proxyRes.on('data', chunk => {
    resChunks.push(chunk);
    sseLineBuf += chunk.toString();

    const parts = sseLineBuf.split('\n\n');
    sseLineBuf = parts.pop();

    for (const part of parts) {
      if (!part.trim()) { clientRes.write('\n\n'); continue; }

      const dataMatch = part.match(/^data: (.+)$/m);
      if (dataMatch) {
        try {
          const evt = JSON.parse(dataMatch[1]);
          eventTimestamps.push({ seqIdx: eventSeqIdx++, ts: Date.now() });
          if (evt.index != null && evt.index > maxBlockIndex) maxBlockIndex = evt.index;
          if (evt.type === 'message_delta' || evt.type === 'message_stop') {
            heldEvents.push(part + '\n\n');
            continue;
          }
        } catch {}
      }

      clientRes.write(part + '\n\n');
    }
  });

  proxyRes.on('end', () => {
    if (sseLineBuf.trim()) {
      const dataMatch = sseLineBuf.match(/^data: (.+)$/m);
      let held = false;
      if (dataMatch) {
        try {
          const evt = JSON.parse(dataMatch[1]);
          eventTimestamps.push({ seqIdx: eventSeqIdx++, ts: Date.now() });
          if (evt.index != null && evt.index > maxBlockIndex) maxBlockIndex = evt.index;
          if (evt.type === 'message_delta' || evt.type === 'message_stop') {
            heldEvents.push(sseLineBuf + '\n\n');
            held = true;
          }
        } catch {}
      }
      if (!held) clientRes.write(sseLineBuf);
    }

    // Quota-check: just flush held events and end — no logging, no entry
    if (ctx.skipEntry) {
      for (const held of heldEvents) clientRes.write(held);
      clientRes.end();
      return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const raw = Buffer.concat(resChunks).toString();
    const events = helpers.parseSSEEvents(raw);
    for (let i = 0; i < events.length && i < eventTimestamps.length; i++) {
      events[i]._ts = eventTimestamps[i].ts;
    }
    const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(events)).catch(e => console.error('Write res.json failed:', e.message));

    const usage = getParser('anthropic').extractUsage(events);
    // Inject usage text block before message_delta/message_stop
    const stopReason = heldEvents.reduce((r, raw) => {
      const m = raw.match(/^data: (.+)$/m);
      if (m) try { const e = JSON.parse(m[1]); if (e.delta?.stop_reason) return e.delta.stop_reason; } catch {}
      return r;
    }, '');
    const totalCtx = helpers.totalContextTokens(usage);
    if (usage && totalCtx && stopReason !== 'tool_use' && statusLineEnabled) {
      if (reqSessionId && !_hudLoggedSessions.has(reqSessionId)) {
        console.log(`\x1b[90m   Context HUD: injecting into session ${reqSessionId.slice(0, 8)}\x1b[0m`);
        _hudLoggedSessions.add(reqSessionId);
      }
      const maxCtx = config.inferMaxContext(parsedBody?.model, parsedBody?.system, usage, { beta1m: ctx.beta1m });
      const pct = (totalCtx / maxCtx * 100).toFixed(1);
      const newIdx = maxBlockIndex + 1;
      const costInfo = calculateCost(usage, parsedBody?.model);

      let text = '\n\n---\nContext: ' + pct + '% (' + totalCtx.toLocaleString() + ' / ' + maxCtx.toLocaleString() + ')';
      text += ' | ' + totalCtx.toLocaleString() + ' in + ' + (usage.output_tokens || 0).toLocaleString() + ' out';
      if (usage.cache_read_input_tokens) {
        const hitRate = (usage.cache_read_input_tokens / totalCtx * 100).toFixed(0);
        text += ' | Cache ' + hitRate + '% hit';
      }
      if (costInfo?.cost != null) {
        text += ' | $' + costInfo.cost.toFixed(4);
      }
      // #142: align advice bands to the unified colour thresholds (80/40).
      if (Number(pct) > helpers.CTX_RED_PCT) {
        text += '\nContext ' + pct + '% — consider /clear';
      } else if (Number(pct) >= helpers.CTX_YELLOW_PCT) {
        text += '\nContext ' + pct + '% — getting full';
      }

      const sseEvent = (eventType, data) => 'event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n';
      clientRes.write(sseEvent('content_block_start', { type: 'content_block_start', index: newIdx, content_block: { type: 'text', text: '' } }));
      clientRes.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: newIdx, delta: { type: 'text_delta', text: text } }));
      clientRes.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: newIdx }));
    }

    // Inject intercept modification summary
    if (ctx.bodyModified && ctx.originalBody) {
      const diffs = buildEditSummary(ctx.originalBody, parsedBody);
      if (diffs.length > 0) {
        const interceptIdx = maxBlockIndex + (usage && totalCtx && stopReason !== 'tool_use' ? 2 : 1);
        const iText = '\n\n---\n🔀 Request was modified by dashboard intercept:\n  ' + diffs.join('\n  ');
        const sseEvt = (eventType, data) => 'event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n';
        clientRes.write(sseEvt('content_block_start', { type: 'content_block_start', index: interceptIdx, content_block: { type: 'text', text: '' } }));
        clientRes.write(sseEvt('content_block_delta', { type: 'content_block_delta', index: interceptIdx, delta: { type: 'text_delta', text: iText } }));
        clientRes.write(sseEvt('content_block_stop', { type: 'content_block_stop', index: interceptIdx }));
      }
    }

    // Forward held events
    for (const held of heldEvents) {
      clientRes.write(held);
    }
    clientRes.end();

    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      if (store.sessionMeta[reqSessionId]) {
        store.sessionMeta[reqSessionId].lastStopReason = stopReason || null;
        // Refresh at stream END too: lastSeenAt is otherwise stamped at request
        // arrival, so after an orchestrator turn longer than the 30s inference
        // window, a subagent spawned right after the stream closes would find
        // no parent candidate and fall to the direct-api sentinel. Must happen
        // before broadcastSessionStatus so the status event carries the fresh
        // timestamp (codex R1).
        store.sessionMeta[reqSessionId].lastSeenAt = Date.now();
      }
      broadcastSessionStatus(reqSessionId);
    }

    const sessionId = reqSessionId;
    const isSubagent = store.isAnthropicSubagent(parsedBody);
    const titleGenTitle = resolveTitleGenTitle(parsedBody, events, startTime);
    const title = titleGenTitle
      || (isSubagent
        ? helpers.extractFirstUserText(parsedBody)
        : (helpers.extractResponseTitle(events)
           || helpers.extractLastUserText(parsedBody)
           || helpers.extractToolResultSummary(parsedBody)))
      || null;
    const thinkingDuration = helpers.computeThinkingDuration(events);
    const currMsgCount = parsedBody?.messages?.length || 0;
    const thinkingStripped = computeThinkingStripped(isSubagent, reqSessionId, currMsgCount, parsedBody);
    const entry = {
      id, ts: ctx.ts, method: ctx.clientReq.method, url: stripAuthParams(ctx.clientReq.url),
      req: parsedBody, res: events,
      elapsed, status: proxyRes.statusCode, isSSE: true,
      receivedAt: startTime,
      edited: ctx.edited, editSummary: ctx.editSummary,
      tokens: null,
      duplicateToolCalls: helpers.extractDuplicateToolCalls(parsedBody?.messages),
      ...getParser('anthropic').buildEntryFields({
        provider: 'anthropic', transport: 'sse', parsedBody, events, usage,
        proxyRes, sessionId, sessionInferred: ctx.sessionInferred,
        sysHash: ctx.sysHash, toolsHash: ctx.toolsHash, coreHash: ctx.coreHash,
        agentKey: ctx.agentKey || null, agentLabel: ctx.agentLabel || null,
        cwd: store.sessionMeta[sessionId]?.cwd || null,
        stopReason, title, thinkingDuration, thinkingStripped, beta1m: ctx.beta1m,
        isSubagent, toolFail: helpers.hasToolFail(parsedBody), startTime,
      }),
    };
    entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
    entry.toolSources = helpers.buildToolSources(entry) || undefined;
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    // INVARIANT: push + entryIndex.set must pair — see docs/decisions/0003-entry-index-map.md
    store.entries.push(entry);
    store.entryIndex.set(entry.id, entry);
    store.trimEntries();
    store.propagateLoadedSkills(entry, sessionId);
    broadcast(entry);

    // Persist to index (fire-and-forget after broadcast)
    const indexLine = buildIndexLine(entry);
    config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write index failed:', e.message));

    // Release req/res from memory — data is on disk (or being written), lazy-load on demand
    entry.req = null;
    entry.res = null;
    entry._loaded = false;

    // Terminal summary
    const code = proxyRes.statusCode;
    const ok = code >= 200 && code < 300;
    const glyph = ok ? '✓' : '✗';
    const color = ok ? '\x1b[32m' : '\x1b[31m';
    const outTok = usage?.output_tokens ? `  out=${usage.output_tokens.toLocaleString()} tok` : '';
    const prefix = ctx.attribPrefix || '';
    console.log(`${color}📥 [${helpers.taipeiTime()}]  ${prefix}  ${glyph} ${code}  ${elapsed}s${outTok}\x1b[0m`);
    if (usage) helpers.printContextBar(usage, parsedBody?.model, parsedBody?.system, ctx.beta1m);
    if (entry.cost?.cost != null) {
      store.sessionCosts.set(sessionId, (store.sessionCosts.get(sessionId) || 0) + entry.cost.cost);
      console.log(`  💰 $${entry.cost.cost.toFixed(4)} this turn | $${store.sessionCosts.get(sessionId).toFixed(4)} session`);
    }
    helpers.printSeparator();
    console.log();
  });
}

function handleOpenAISSE(ctx, proxyRes, clientRes) {
  const { id, startTime, parsedBody, reqSessionId } = ctx;
  const events = [];
  let sseBuf = '';

  const processFrames = (text, flush = false) => {
    sseBuf += text.replace(/\r\n/g, '\n');
    const parts = sseBuf.split('\n\n');
    sseBuf = parts.pop();
    for (const part of parts) {
      if (!part.trim()) continue;
      events.push(parseSSEFrame(part, Date.now()));
    }
    if (flush && sseBuf.trim()) {
      events.push(parseSSEFrame(sseBuf, Date.now()));
      sseBuf = '';
    }
  };

  proxyRes.on('error', (err) => {
    console.error(`\x1b[31m❌ UPSTREAM STREAM ERROR: ${err.message}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.writableEnded) clientRes.end();
  });

  proxyRes.on('data', chunk => {
    processFrames(chunk.toString('utf8'));
    clientRes.write(chunk);
  });

  proxyRes.on('end', () => {
    processFrames('', true);
    clientRes.end();

    if (ctx.skipEntry) return;

    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
      if (store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId].lastStopReason = null;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const resWritePromise = config.storage.write(id, '_res.json', JSON.stringify(events))
      .catch(e => console.error('Write res.json failed:', e.message));
    const entry = {
      id, ts: ctx.ts, method: ctx.clientReq.method, url: stripAuthParams(ctx.clientReq.url),
      req: parsedBody, res: events,
      elapsed, status: proxyRes.statusCode, isSSE: true,
      receivedAt: startTime,
      tokens: null,
      duplicateToolCalls: null,
      ...getParser('openai').buildEntryFields({
        provider: 'openai', transport: 'sse', parsedBody, events, proxyRes,
        sessionId: reqSessionId, sessionInferred: ctx.sessionInferred, isSubagent: ctx.isSubagent,
        sysHash: ctx.sysHash, toolsHash: ctx.toolsHash, coreHash: ctx.coreHash,
        agentKey: ctx.agentKey || null, agentLabel: ctx.agentLabel || null,
        cwd: store.sessionMeta[reqSessionId]?.cwd || null,
      }),
    };
    entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
    entry.toolSources = helpers.buildToolSources(entry) || undefined;
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    // INVARIANT: push + entryIndex.set must pair — see docs/decisions/0003-entry-index-map.md
    store.entries.push(entry);
    store.entryIndex.set(entry.id, entry);
    store.trimEntries();
    broadcast(entry);

    const indexLine = buildIndexLine(entry);
    config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write index failed:', e.message));

    entry.req = null;
    entry.res = null;
    entry._loaded = false;

    const code = proxyRes.statusCode;
    const ok = code >= 200 && code < 300;
    const glyph = ok ? '✓' : '✗';
    const color = ok ? '\x1b[32m' : '\x1b[31m';
    const prefix = ctx.attribPrefix || '';
    console.log(`${color}📥 [${helpers.taipeiTime()}]  ${prefix}  ${glyph} ${code}  ${elapsed}s\x1b[0m`);
    helpers.printSeparator();
    console.log();
  });
}

function handleNonSSEResponse(ctx, proxyRes, clientRes) {
  const { id, startTime, parsedBody, reqSessionId } = ctx;
  const resChunks = [];

  proxyRes.on('error', (err) => {
    console.error(`\x1b[31m❌ UPSTREAM STREAM ERROR: ${err.message}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.writableEnded) clientRes.end();
  });

  proxyRes.on('data', chunk => {
    clientRes.write(chunk);
    resChunks.push(chunk);
  });

  proxyRes.on('end', () => {
    clientRes.end();

    // Quota-check: no logging, no entry
    if (ctx.skipEntry) return;

    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
      if (store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId].lastStopReason = null;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const raw = Buffer.concat(resChunks).toString();
    let resData;
    try { resData = JSON.parse(raw); } catch { resData = raw; }

    const provider = ctx.upstream?.provider || 'anthropic';
    const sessionId = reqSessionId;
    let openAIEvents = null;
    let openAIResponse = null;
    if (provider === 'openai' && typeof resData === 'string') {
      openAIEvents = parseSSEText(resData, Date.now());
      if (openAIEvents) {
        openAIResponse = getOpenAIResponseFromEvents(openAIEvents);
        resData = openAIEvents;
      }
    }
    const resWritePromise = config.storage.write(id, '_res.json', typeof resData === 'string' ? resData : JSON.stringify(resData))
      .catch(e => console.error('Write res.json failed:', e.message));

    let entry;
    if (provider === 'openai') {
      entry = {
        id, ts: ctx.ts, method: ctx.clientReq.method, url: stripAuthParams(ctx.clientReq.url),
        req: parsedBody, res: resData,
        elapsed, status: proxyRes.statusCode, isSSE: !!openAIEvents,
        receivedAt: startTime,
        tokens: null,
        duplicateToolCalls: null,
        ...getParser('openai').buildEntryFields({
          provider: 'openai', transport: openAIEvents ? 'sse' : 'http',
          parsedBody, events: openAIEvents || [], response: openAIResponse || resData, proxyRes,
          sessionId, sessionInferred: ctx.sessionInferred, isSubagent: ctx.isSubagent,
          sysHash: ctx.sysHash, toolsHash: ctx.toolsHash, coreHash: ctx.coreHash,
        agentKey: ctx.agentKey || null, agentLabel: ctx.agentLabel || null,
          cwd: store.sessionMeta[sessionId]?.cwd || null,
        }),
      };
    } else {
      const isSubagent = store.isAnthropicSubagent(parsedBody);
      const titleGenTitle = resolveTitleGenTitle(parsedBody, resData, startTime);
      const title = titleGenTitle
        || (isSubagent
          ? helpers.extractFirstUserText(parsedBody)
          : (helpers.extractResponseTitle(resData)
             || helpers.extractLastUserText(parsedBody)
             || helpers.extractToolResultSummary(parsedBody)))
        || null;
      const stopReason = resData?.stop_reason || '';
      const nonSSEUsage = resData && typeof resData === 'object' && !Array.isArray(resData) ? (resData.usage || null) : null;
      const currMsgCount = parsedBody?.messages?.length || 0;
      const thinkingStripped = computeThinkingStripped(isSubagent, sessionId, currMsgCount, parsedBody);
      entry = {
        id, ts: ctx.ts, method: ctx.clientReq.method, url: stripAuthParams(ctx.clientReq.url),
        req: parsedBody, res: resData,
        elapsed, status: proxyRes.statusCode, isSSE: false,
        receivedAt: startTime,
        edited: ctx.edited, editSummary: ctx.editSummary,
        tokens: null,
        duplicateToolCalls: helpers.extractDuplicateToolCalls(parsedBody?.messages),
        ...getParser('anthropic').buildEntryFields({
          provider: 'anthropic', transport: 'http', parsedBody,
          usage: nonSSEUsage, proxyRes,
          sessionId, sessionInferred: ctx.sessionInferred,
          sysHash: ctx.sysHash, toolsHash: ctx.toolsHash, coreHash: ctx.coreHash,
        agentKey: ctx.agentKey || null, agentLabel: ctx.agentLabel || null,
          cwd: store.sessionMeta[sessionId]?.cwd || null,
          stopReason, title, thinkingDuration: null, thinkingStripped, beta1m: ctx.beta1m,
          isSubagent, toolFail: helpers.hasToolFail(parsedBody), startTime,
        }),
      };
    }
    entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
    entry.toolSources = helpers.buildToolSources(entry) || undefined;
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    // INVARIANT: push + entryIndex.set must pair — see docs/decisions/0003-entry-index-map.md
    store.entries.push(entry);
    store.entryIndex.set(entry.id, entry);
    store.trimEntries();
    store.propagateLoadedSkills(entry, sessionId);
    broadcast(entry);

    const indexLine = buildIndexLine(entry);
    config.storage.appendIndex(indexLine + '\n').catch(e => console.error('Write index failed:', e.message));

    // Release req/res from memory — data is on disk (or being written), lazy-load on demand
    entry.req = null;
    entry.res = null;
    entry._loaded = false;

    const code2 = proxyRes.statusCode;
    const ok2 = code2 >= 200 && code2 < 300;
    const glyph2 = ok2 ? '✓' : '✗';
    const color2 = ok2 ? '\x1b[32m' : '\x1b[31m';
    let errTag = '';
    if (!ok2 && resData && typeof resData === 'object') {
      const t = resData.error?.type || resData.type;
      if (t) errTag = '  ' + t;
    }
    const prefix2 = ctx.attribPrefix || '';
    console.log(`${color2}📥 [${helpers.taipeiTime()}]  ${prefix2}  ${glyph2} ${code2}  ${elapsed}s${errTag}\x1b[0m`);
    helpers.printSeparator();
    console.log();
  });
}

module.exports = {
  forwardRequest,
  persistEditedRequest,
  setSessionAnchorRecorder,
  resolveProxyAgent,
  applyModelPrefix,
  stripInjectedStats,
  buildEditSummary,
  describeUpstreamError,
  setStatusLineEnabled,
  getStatusLineEnabled,
  parseSSEFrame,
  parseSSEText,
  normalizeOpenAIResponseSummary,
};
