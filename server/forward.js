'use strict';

const https = require('https');
const http = require('http');
const tls = require('tls');
const config = require('./config');
const store = require('./store');
const { calculateCost } = require('./pricing');
const helpers = require('./helpers');
const { broadcast, broadcastSessionStatus, broadcastSessionTitleUpdate } = require('./sse-broadcast');
const { appendSample, collectRatelimitHeaders } = require('./ratelimit-log');
const hub = require('./hub');

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
      const tlsSocket = tls.connect(tlsOpts, () => callback(null, tlsSocket));
      tlsSocket.on('error', callback);
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

function buildResponseMetadata(provider, resData, proxyRes) {
  if (provider === 'openai') {
    return {
      provider: 'openai',
      id: resData && typeof resData === 'object' ? resData.id || null : null,
      object: resData && typeof resData === 'object' ? resData.object || null : null,
      model: resData && typeof resData === 'object' ? resData.model || null : null,
      status: proxyRes.statusCode,
    };
  }
  return { provider: 'anthropic', status: proxyRes.statusCode };
}

function getOpenAIInputSummary(input) {
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] || {};
    if (item.role && item.role !== 'user') continue;
    const content = item.content;
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
    if (!Array.isArray(content)) continue;
    const text = content.map(part => part?.text || '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 80);
  }
  return null;
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

// ── Forward request to Anthropic ─────────────────────────────────────
function forwardRequest(ctx) {
  const { id, ts, startTime, parsedBody, rawBody, clientReq, clientRes, fwdHeaders, reqSessionId } = ctx;
  const upstream = ctx.upstream || config.getUpstreamForRequest(clientReq.url);
  const provider = upstream.provider || 'anthropic';

  // Counter + attribution prefix are committed here, not at request receipt.
  // This guarantees intercepted-then-rejected requests never advance the
  // per-session sequence number that the dashboard's displayNum mirrors.
  // Counter classification uses !extractCwd to match dashboard's isSubagent.
  if (!ctx.skipEntry && parsedBody) {
    const meta = reqSessionId ? (store.sessionMeta[reqSessionId] || (store.sessionMeta[reqSessionId] = {})) : null;
    const isSubagent = provider === 'anthropic' && !store.extractCwd(parsedBody);
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
    console.log(`\x1b[36m📤 [${ts}]  ${ctx.attribPrefix}  ${clientReq.method} ${clientReq.url}\x1b[0m`);
    console.log(helpers.summarizeRequest(parsedBody));
  }

  // Remove previously injected stats so they don't accumulate in conversation
  const statsStripped = stripInjectedStats(parsedBody);
  const modelPrefixed = applyModelPrefix(parsedBody, config.REWRITE_MODEL_PREFIX);
  const bodyToSend = (ctx.bodyModified || statsStripped || modelPrefixed) ? Buffer.from(JSON.stringify(parsedBody)) : rawBody;

  const transport = upstream.protocol === 'http' ? http : https;
  const tunnelAgent = getTunnelAgent(upstream);
  const proxyReq = transport.request({
    hostname: upstream.host, port: upstream.port,
    path: config.joinUpstreamPath(upstream, clientReq.url), method: clientReq.method,
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

  proxyReq.on('error', (err) => {
    console.error(`\x1b[31m❌ PROXY ERROR: ${err.message || err.code || String(err)}\x1b[0m`);
    if (reqSessionId) {
      store.activeRequests[reqSessionId] = Math.max(0, (store.activeRequests[reqSessionId] || 1) - 1);
      broadcastSessionStatus(reqSessionId);
    }
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: 'proxy_error', message: err.message }));
  });

  proxyReq.end(bodyToSend);
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

    const usage = helpers.extractUsage(events);
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
      const maxCtx = config.getMaxContext(parsedBody?.model, parsedBody?.system);
      const pct = (totalCtx / maxCtx * 100).toFixed(1);
      const newIdx = maxBlockIndex + 1;
      const costInfo = calculateCost(usage, parsedBody?.model);

      let text = '\n\n---\n📊 Context: ' + pct + '% (' + totalCtx.toLocaleString() + ' / ' + maxCtx.toLocaleString() + ')';
      text += ' | ' + totalCtx.toLocaleString() + ' in + ' + (usage.output_tokens || 0).toLocaleString() + ' out';
      if (usage.cache_read_input_tokens) {
        const hitRate = (usage.cache_read_input_tokens / totalCtx * 100).toFixed(0);
        text += ' | Cache ' + hitRate + '% hit';
      }
      if (costInfo?.cost != null) {
        text += ' | $' + costInfo.cost.toFixed(4);
      }
      if (pct >= 90) {
        text += '\n⚠️ Context ' + pct + '% — consider /clear';
      } else if (pct >= 70) {
        text += '\n⚡ Context ' + pct + '% — getting full';
      }

      const sseEvent = (eventType, data) => 'event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n';
      clientRes.write(sseEvent('content_block_start', { type: 'content_block_start', index: newIdx, content_block: { type: 'text', text: '' } }));
      clientRes.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: newIdx, delta: { type: 'text_delta', text: text } }));
      clientRes.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: newIdx }));
    }

    // Inject intercept modification summary
    if (ctx.bodyModified && ctx.originalBody) {
      const orig = ctx.originalBody;
      const mod = parsedBody;
      const diffs = [];
      if (orig.model !== mod.model) diffs.push('Model: ' + orig.model + ' → ' + mod.model);
      const origMsgLen = (orig.messages || []).length;
      const modMsgLen = (mod.messages || []).length;
      if (origMsgLen !== modMsgLen) diffs.push('Messages: ' + origMsgLen + ' → ' + modMsgLen);
      const msgEdits = (mod.messages || []).reduce((cnt, m, i) => {
        const o = (orig.messages || [])[i];
        if (!o) return cnt;
        const oStr = typeof o.content === 'string' ? o.content : JSON.stringify(o.content);
        const mStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return oStr !== mStr ? cnt + 1 : cnt;
      }, 0);
      if (msgEdits > 0) diffs.push(msgEdits + ' message(s) edited');
      const origToolLen = (orig.tools || []).length;
      const modToolLen = (mod.tools || []).length;
      if (origToolLen !== modToolLen) diffs.push('Tools: ' + origToolLen + ' → ' + modToolLen + ' (' + (modToolLen - origToolLen) + ')');
      const origSys = typeof orig.system === 'string' ? orig.system : JSON.stringify(orig.system);
      const modSys = typeof mod.system === 'string' ? mod.system : JSON.stringify(mod.system);
      if (origSys !== modSys) diffs.push('System prompt: modified');
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
      broadcastSessionStatus(reqSessionId);
      if (store.sessionMeta[reqSessionId]) store.sessionMeta[reqSessionId].lastStopReason = stopReason || null;
    }

    const sessionId = reqSessionId;
    const costInfo = calculateCost(usage, parsedBody?.model);
    const maxContext = config.getMaxContext(parsedBody?.model, parsedBody?.system);
    const isSubagent = !store.extractCwd(parsedBody);
    const titleGenTitle = resolveTitleGenTitle(parsedBody, events, startTime);
    const title = titleGenTitle
      || (isSubagent
        ? helpers.extractFirstUserText(parsedBody)
        : (helpers.extractResponseTitle(events)
           || helpers.extractLastUserText(parsedBody)
           || helpers.extractToolResultSummary(parsedBody)))
      || null;
    const toolFail = helpers.hasToolFail(parsedBody);
    const thinkingDuration = helpers.computeThinkingDuration(events);
    const currMsgCount = parsedBody?.messages?.length || 0;
    const thinkingStripped = computeThinkingStripped(isSubagent, reqSessionId, currMsgCount, parsedBody);
    const entry = {
      id, ts: ctx.ts, sessionId, method: ctx.clientReq.method, url: ctx.clientReq.url,
      provider: 'anthropic',
      agent: 'claude',
      req: parsedBody, res: events,
      elapsed, status: proxyRes.statusCode, isSSE: true,
      tokens: helpers.tokenizeRequest(parsedBody),
      usage, cost: costInfo,
      maxContext,
      cwd: store.sessionMeta[sessionId]?.cwd || null,
      receivedAt: startTime,
      thinkingDuration,
      duplicateToolCalls: helpers.extractDuplicateToolCalls(parsedBody?.messages),
      model: parsedBody?.model || null,
      msgCount: currMsgCount,
      toolCount: parsedBody?.tools?.length || 0,
      toolCalls: helpers.extractToolCalls(parsedBody?.messages),
      isSubagent,
      sessionInferred: ctx.sessionInferred || false,
      title,
      stopReason,
      toolFail,
      sysHash: provider === 'anthropic' ? ctx.sysHash || null : null,
      toolsHash: provider === 'anthropic' ? ctx.toolsHash || null : null,
      coreHash: provider === 'anthropic' ? ctx.coreHash || null : null,
      thinkingStripped,
    };
    entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
    entry.toolSources = helpers.buildToolSources(entry) || undefined;
    // Track in-flight writes so lazy-load can await them
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    store.entries.push(entry);
    store.trimEntries();
    broadcast(entry);

    // Persist to index (fire-and-forget after broadcast)
    const indexLine = JSON.stringify({
      id, ts: ctx.ts, sessionId,
      provider: entry.provider,
      agent: entry.agent,
      model: entry.model, msgCount: entry.msgCount, toolCount: entry.toolCount,
      toolCalls: entry.toolCalls, isSubagent: entry.isSubagent, sessionInferred: entry.sessionInferred,
      cwd: entry.cwd, isSSE: true,
      usage, cost: costInfo, maxContext,
      stopReason, title, thinkingDuration,
      toolFail,
      elapsed, status: proxyRes.statusCode,
      receivedAt: startTime,
      sysHash: entry.sysHash, toolsHash: entry.toolsHash,
      coreHash: entry.coreHash,
      thinkingStripped: entry.thinkingStripped,
      hasCredential: entry.hasCredential,
      toolSources: entry.toolSources,
    });
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
    if (usage) helpers.printContextBar(usage, parsedBody?.model, parsedBody?.system);
    if (costInfo?.cost != null) {
      store.sessionCosts.set(sessionId, (store.sessionCosts.get(sessionId) || 0) + costInfo.cost);
      console.log(`  💰 $${costInfo.cost.toFixed(4)} this turn | $${store.sessionCosts.get(sessionId).toFixed(4)} session`);
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
    const responseMetadata = buildResponseMetadata('openai', null, proxyRes);
    responseMetadata.streaming = true;

    const entry = {
      id, ts: ctx.ts, sessionId: reqSessionId, method: ctx.clientReq.method, url: ctx.clientReq.url,
      provider: 'openai',
      agent: 'codex',
      req: parsedBody, res: events,
      elapsed, status: proxyRes.statusCode, isSSE: true,
      tokens: null,
      usage: null, cost: null,
      responseMetadata,
      maxContext: null,
      cwd: store.sessionMeta[reqSessionId]?.cwd || null,
      receivedAt: startTime,
      thinkingDuration: null,
      duplicateToolCalls: null,
      model: parsedBody?.model || null,
      msgCount: Array.isArray(parsedBody?.input) ? parsedBody.input.length : 0,
      toolCount: Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
      toolCalls: {},
      isSubagent: false,
      sessionInferred: true,
      title: getOpenAIInputSummary(parsedBody?.input),
      stopReason: '',
      toolFail: false,
      sysHash: null,
      toolsHash: null,
      coreHash: null,
      thinkingStripped: undefined,
    };
    entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    store.entries.push(entry);
    store.trimEntries();
    broadcast(entry);

    const indexLine = JSON.stringify({
      id, ts: ctx.ts, sessionId: reqSessionId,
      provider: entry.provider,
      agent: entry.agent,
      model: entry.model, msgCount: entry.msgCount, toolCount: entry.toolCount,
      toolCalls: entry.toolCalls, isSubagent: entry.isSubagent, sessionInferred: entry.sessionInferred,
      cwd: entry.cwd, isSSE: true,
      usage: null, cost: null, maxContext: null,
      responseMetadata,
      stopReason: '', title: entry.title, thinkingDuration: null,
      toolFail: false,
      elapsed, status: proxyRes.statusCode,
      receivedAt: startTime,
      sysHash: null, toolsHash: null,
      coreHash: null,
      hasCredential: entry.hasCredential,
    });
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
    const resWritePromise = config.storage.write(id, '_res.json', typeof resData === 'string' ? resData : JSON.stringify(resData)).catch(e => console.error('Write res.json failed:', e.message));

    const provider = ctx.upstream?.provider || 'anthropic';
    const sessionId = reqSessionId;
    const maxContext = provider === 'anthropic' ? config.getMaxContext(parsedBody?.model, parsedBody?.system) : null;
    const isSubagent = provider === 'anthropic' && !store.extractCwd(parsedBody);
    const titleGenTitle = provider === 'anthropic' ? resolveTitleGenTitle(parsedBody, resData, startTime) : null;
    const title = provider === 'openai'
      ? getOpenAIInputSummary(parsedBody?.input)
      : (titleGenTitle
        || (isSubagent
          ? helpers.extractFirstUserText(parsedBody)
          : (helpers.extractResponseTitle(resData)
             || helpers.extractLastUserText(parsedBody)
             || helpers.extractToolResultSummary(parsedBody)))
        || null);
    const toolFail = provider === 'anthropic' ? helpers.hasToolFail(parsedBody) : false;
    const stopReason = provider === 'openai' ? (resData?.status || '') : (resData?.stop_reason || '');
    const currMsgCount = provider === 'openai'
      ? (Array.isArray(parsedBody?.input) ? parsedBody.input.length : 0)
      : (parsedBody?.messages?.length || 0);
    const thinkingStripped = provider === 'anthropic'
      ? computeThinkingStripped(isSubagent, reqSessionId, currMsgCount, parsedBody)
      : undefined;
    const responseMetadata = buildResponseMetadata(provider, resData, proxyRes);
    const entry = {
      id, ts: ctx.ts, sessionId, method: ctx.clientReq.method, url: ctx.clientReq.url,
      provider,
      agent: provider === 'openai' ? 'codex' : 'claude',
      req: parsedBody, res: resData,
      elapsed, status: proxyRes.statusCode, isSSE: false,
      tokens: provider === 'anthropic' ? helpers.tokenizeRequest(parsedBody) : null,
      usage: null, cost: null,
      responseMetadata,
      maxContext,
      cwd: store.sessionMeta[sessionId]?.cwd || null,
      receivedAt: startTime,
      duplicateToolCalls: provider === 'anthropic' ? helpers.extractDuplicateToolCalls(parsedBody?.messages) : null,
      model: (provider === 'openai' && resData && typeof resData === 'object' ? resData.model : null) || parsedBody?.model || null,
      msgCount: currMsgCount,
      toolCount: parsedBody?.tools?.length || 0,
      toolCalls: provider === 'anthropic' ? helpers.extractToolCalls(parsedBody?.messages) : {},
      isSubagent,
      sessionInferred: ctx.sessionInferred || false,
      title,
      stopReason,
      toolFail,
      sysHash: ctx.sysHash || null,
      toolsHash: ctx.toolsHash || null,
      coreHash: ctx.coreHash || null,
      thinkingStripped,
    };
    entry.hasCredential = helpers.entryHasCredential(entry) || undefined;
    entry.toolSources = helpers.buildToolSources(entry) || undefined;
    entry._writePromise = Promise.all([ctx.reqWritePromise, resWritePromise].filter(Boolean));
    store.entries.push(entry);
    store.trimEntries();
    broadcast(entry);

    const indexLine = JSON.stringify({
      id, ts: ctx.ts, sessionId,
      provider: entry.provider,
      agent: entry.agent,
      model: entry.model, msgCount: entry.msgCount, toolCount: entry.toolCount,
      toolCalls: entry.toolCalls, isSubagent: entry.isSubagent, sessionInferred: entry.sessionInferred,
      cwd: entry.cwd, isSSE: false,
      usage: null, cost: null, maxContext,
      responseMetadata,
      stopReason, title, thinkingDuration: null,
      toolFail,
      elapsed, status: proxyRes.statusCode,
      receivedAt: startTime,
      sysHash: ctx.sysHash || null, toolsHash: ctx.toolsHash || null,
      coreHash: entry.coreHash,
      thinkingStripped: entry.thinkingStripped,
      hasCredential: entry.hasCredential,
      toolSources: entry.toolSources,
    });
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

module.exports = { forwardRequest, resolveProxyAgent, applyModelPrefix, stripInjectedStats, setStatusLineEnabled, getStatusLineEnabled, parseSSEFrame };
