'use strict';

// ── In-memory store & SSE clients ───────────────────────────────────
const MAX_ENTRIES = parseInt(process.env.CCXRAY_MAX_ENTRIES || '5000', 10);
const entries = [];
const sseClients = [];
const restoreState = {
  phase: 'idle',
  restoring: false,
  complete: false,
  error: null,
  startedAt: null,
  finishedAt: null,
  entryCount: 0,
};

function trimEntries() {
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

// ── Rate limit state (from Anthropic response headers) ──────────────
let rateLimitState = null;

// ── Session tracking ────────────────────────────────────────────────
let currentSessionId = null;
let lastMsgCount = 0;
let sessionCounter = 0;

// ── Session metadata (cwd per session) ──────────────────────────────
const sessionMeta = {}; // { sessionId: { cwd, lastSeenAt } }
const activeRequests = {}; // sessionId → in-flight count
const sessionCosts = new Map(); // sessionId → accumulated cost

// ── Version Index (cc_version → { reqId, b2Len, firstSeen }) ────────
const versionIndex = new Map();

// ── Intercept (request pause) ────────────────────────────────────────
const interceptSessions = new Set();
const pendingRequests = new Map();
let interceptTimeout = 120;

function isQuotaCheck(req) {
  return req?.max_tokens === 1 && !req?.system &&
    req?.messages?.length === 1 && req.messages[0]?.content === 'quota';
}

function extractCwd(req) {
  if (isQuotaCheck(req)) return '(quota-check)';
  if (!req?.system) return null;
  const txt = Array.isArray(req.system) ? req.system.map(b => b.text || '').join('\n') : String(req.system);
  const m = txt.match(/Primary working directory: (.+)/);
  return m ? m[1].trim() : null;
}

function extractSessionId(req) {
  const uid = req?.metadata?.user_id || '';
  // New format: user_id is JSON like {"session_id":"xxx-yyy"}
  const jsonMatch = uid.match(/"session_id"\s*:\s*"([a-f0-9-]+)"/);
  if (jsonMatch) return jsonMatch[1];
  // Legacy format: user_id is "session_xxx-yyy"
  const m = uid.match(/session_([a-f0-9-]+)/);
  return m ? m[1] : null;
}

// Bare subagent requests: no session_id, no system prompt, no tools, 1-2 messages.
// These are Claude Code's Agent tool kickoff calls that lack any identifying metadata.
function isLikelySubagent(req) {
  if (extractSessionId(req)) return false;      // has explicit session → not orphan
  if (extractCwd(req)) return false;             // has system prompt with cwd → not bare
  if (req?.tools?.length) return false;           // has tool definitions → not bare
  if ((req?.messages?.length || 0) > 2) return false;
  // Require metadata to be absent or empty (genuine API callers usually set metadata)
  const meta = req?.metadata;
  if (meta && Object.keys(meta).length > 0) return false;
  return true;
}

// Find the best parent session for an orphan subagent request.
// Scoring: inflight sessions get massive priority boost, then sorted by recency.
// Only considers sessions active within the last 30s to avoid stale attribution.
function inferParentSession() {
  const now = Date.now();
  const WINDOW_MS = 30000;
  let best = null, bestScore = -1;

  for (const [sid, meta] of Object.entries(sessionMeta)) {
    if (sid === 'direct-api') continue;
    const seenAt = meta.lastSeenAt || 0;
    if (now - seenAt > WINDOW_MS) continue;

    const inflight = (activeRequests[sid] || 0) > 0;
    // Inflight sessions score 1e13 + recency; idle sessions score just recency
    const score = (inflight ? 1e13 : 0) + seenAt;
    if (score > bestScore) {
      best = sid;
      bestScore = score;
    }
  }
  return best;
}

// Extract the first user message text from a parsed request body.
// Used as content-match anchor for title-gen attribution.
function extractFirstUserMsgText(req) {
  const first = req?.messages?.[0];
  if (!first || first.role !== 'user') return null;
  const c = first.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const tb = c.find(b => b?.type === 'text' && typeof b.text === 'string');
    return tb ? tb.text : null;
  }
  return null;
}

function recordFirstUserMsg(sid, req) {
  if (!sid || sid === 'direct-api') return;
  const meta = sessionMeta[sid] || (sessionMeta[sid] = {});
  if (meta.firstUserMsg == null) {
    const txt = extractFirstUserMsgText(req);
    if (txt != null) meta.firstUserMsg = txt;
  }
}

// Monotonic session-title setter. Returns true when the stored value changed.
function setSessionTitle(sid, title, reqTs) {
  if (!sid || !title || typeof title !== 'string') return false;
  const meta = sessionMeta[sid] || (sessionMeta[sid] = {});
  if (meta.titleReqTs && reqTs != null && reqTs <= meta.titleReqTs) return false;
  if (meta.title === title) { meta.titleReqTs = reqTs || meta.titleReqTs; return false; }
  meta.title = title;
  meta.titleReqTs = reqTs || Date.now();
  return true;
}

function getSessionTitle(sid) {
  return sid ? (sessionMeta[sid]?.title || null) : null;
}

// Attribute a title-gen request to a parent session. Requires both temporal
// (inflight session seen within last windowMs) AND content (first user msg
// equals the title-gen request body) signals to agree. Returns null when
// zero or more than one candidate matches.
function attributeTitleGen(parsedBody, receivedAt, windowMs = 1000) {
  const target = extractFirstUserMsgText(parsedBody);
  if (target == null) return null;
  const cutoff = (receivedAt || Date.now()) - windowMs;
  const matches = [];
  for (const [sid, meta] of Object.entries(sessionMeta)) {
    if (sid === 'direct-api') continue;
    if ((meta.lastSeenAt || 0) < cutoff) continue;
    if ((activeRequests[sid] || 0) <= 0) continue;
    if (meta.firstUserMsg !== target) continue;
    matches.push(sid);
  }
  return matches.length === 1 ? matches[0] : null;
}

function detectSession(req) {
  const realId = extractSessionId(req);

  // Explicit session_id → authoritative.
  // isNewSession reflects "first time we have ever seen this sid",
  // not "different from the last sid" — switching A→B→A only banners A once.
  if (realId) {
    const meta = sessionMeta[realId] || (sessionMeta[realId] = {});
    const isNew = !meta.bannerPrinted;
    if (isNew) {
      meta.bannerPrinted = true;
      sessionCounter++;
    }
    currentSessionId = realId; // always update last-seen pointer for getCurrentSessionId fallback
    lastMsgCount = req?.messages?.length || 0;
    recordFirstUserMsg(realId, req);
    return { sessionId: currentSessionId, isNewSession: isNew };
  }

  // Likely subagent → infer parent, never pollute global state
  if (isLikelySubagent(req)) {
    const parent = inferParentSession();
    if (parent) return { sessionId: parent, isNewSession: false, inferred: true };
    // No recent session → keep as-is, don't create spurious session
    return { sessionId: currentSessionId || 'direct-api', isNewSession: false, inferred: true };
  }

  // Non-subagent without session_id: try parent attribution before creating a phantom
  // session. Title-gen and other internal requests that don't pass isLikelySubagent
  // (e.g. due to message count) still belong to an existing session when one is active.
  const parent = inferParentSession();
  if (parent) return { sessionId: parent, isNewSession: false, inferred: true };

  // True fallback: no active session within 30s → genuine new direct-api session.
  // direct-api re-banners on conversation reset (msg count drops) — that is a
  // distinct conversation under the same sentinel id, treated as a new session.
  const dMeta = sessionMeta['direct-api'] || (sessionMeta['direct-api'] = {});
  const isReset = (req?.messages?.length || 0) < lastMsgCount;
  const isNew = !dMeta.bannerPrinted || isReset;
  if (isNew) {
    dMeta.bannerPrinted = true;
    sessionCounter++;
    currentSessionId = 'direct-api';
  }
  lastMsgCount = req?.messages?.length || 0;
  return { sessionId: currentSessionId, isNewSession: isNew };
}

function printSessionBanner(sessionId) {
  const w = 60;
  const shortId = sessionId.slice(0, 8);
  const label = ` NEW SESSION ${shortId} `;
  const pad = Math.max(0, Math.floor((w - label.length) / 2));
  const line = '★'.repeat(pad) + label + '★'.repeat(w - pad - label.length);
  console.log();
  console.log('\x1b[1;35m' + line + '\x1b[0m');
  if (sessionId !== 'direct-api') {
    console.log(`\x1b[35m   claude --resume ${sessionId}\x1b[0m`);
  }
  console.log();
}

function getRateLimitState() { return rateLimitState; }
function setRateLimitState(state) { rateLimitState = state; }
function getInterceptTimeout() { return interceptTimeout; }
function setInterceptTimeout(val) { interceptTimeout = val; }
function getCurrentSessionId() { return currentSessionId; }
function setRestoreState(patch) {
  Object.assign(restoreState, patch);
  restoreState.entryCount = entries.length;
}

module.exports = {
  MAX_ENTRIES,
  entries,
  trimEntries,
  sseClients,
  restoreState,
  setRestoreState,
  getRateLimitState,
  setRateLimitState,
  sessionMeta,
  activeRequests,
  sessionCosts,
  versionIndex,
  interceptSessions,
  pendingRequests,
  getInterceptTimeout,
  setInterceptTimeout,
  getCurrentSessionId,
  isQuotaCheck,
  extractCwd,
  extractSessionId,
  detectSession,
  printSessionBanner,
  extractFirstUserMsgText,
  recordFirstUserMsg,
  setSessionTitle,
  getSessionTitle,
  attributeTitleGen,
};
