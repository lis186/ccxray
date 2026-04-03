'use strict';

// ── In-memory store & SSE clients ───────────────────────────────────
const entries = [];
const sseClients = [];

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

function detectSession(req) {
  const realId = extractSessionId(req);
  const isNew = realId ? (realId !== currentSessionId) : (!currentSessionId || (req?.messages?.length || 0) < lastMsgCount);
  if (isNew) {
    sessionCounter++;
    currentSessionId = realId || 'direct-api';
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
  console.log(`\x1b[35m   claude --continue ${sessionId}\x1b[0m`);
  console.log();
}

function getRateLimitState() { return rateLimitState; }
function setRateLimitState(state) { rateLimitState = state; }
function getInterceptTimeout() { return interceptTimeout; }
function setInterceptTimeout(val) { interceptTimeout = val; }
function getCurrentSessionId() { return currentSessionId; }

module.exports = {
  entries,
  sseClients,
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
};
