'use strict';

const { agentForProvider, getUpstreamProfile } = require('./providers');

// Synthetic session buckets that have no resumable rollout/session file.
const NON_RESUMABLE_SESSIONS = new Set(['direct-api', 'codex-raw', 'grok-raw', 'unknown']);

// ── In-memory store & SSE clients ───────────────────────────────────
const MAX_ENTRIES = parseInt(process.env.CCXRAY_MAX_ENTRIES || '5000', 10);
const entries = [];
// INVARIANT: entryIndex must mirror entries[] — see docs/decisions/0003-entry-index-map.md
const entryIndex = new Map();
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

// INVARIANT: trim must delete from entryIndex — see docs/decisions/0003-entry-index-map.md
function trimEntries() {
  if (entries.length > MAX_ENTRIES) {
    const removed = entries.splice(0, entries.length - MAX_ENTRIES);
    for (const e of removed) entryIndex.delete(e.id);
  }
}

function getEntryById(id) {
  return entryIndex.get(id) || entries.find(e => e.id === id) || null;
}

// ── Rate limit state (from Anthropic response headers) ──────────────
let rateLimitState = null;

// ── Session tracking ────────────────────────────────────────────────
let currentSessionId = null;
let lastMsgCount = 0;
let sessionCounter = 0;

// ── Socket→session affinity (#129) ─────────────────────────────────
// All requests of one Claude Code process arrive over that process's
// keep-alive connection pool. Remember which session last spoke on each
// client socket; orphans reuse those sockets, so the mapping is stronger
// evidence than temporal inference. WeakMap entries die with the socket,
// and a hub restart clears map and sockets together — no staleness path.
const socketSessions = new WeakMap();

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
  if (typeof req?.metadata?.session_id === 'string') return req.metadata.session_id;
  const uid = req?.metadata?.user_id || '';
  // New format: user_id is JSON like {"session_id":"xxx-yyy"}
  const jsonMatch = uid.match(/"session_id"\s*:\s*"([a-f0-9-]+)"/);
  if (jsonMatch) return jsonMatch[1];
  // Legacy format: user_id is "session_xxx-yyy"
  const m = uid.match(/session_([a-f0-9-]+)/);
  return m ? m[1] : null;
}

// Anthropic subagent heuristic: no cwd AND no explicit session_id.
// Goal verifiers carry session_id but no cwd — they are NOT subagents.
function isAnthropicSubagent(parsedBody) {
  return !extractCwd(parsedBody) && !extractSessionId(parsedBody);
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

// Link a new session to its parent when it looks like a subagent spawn.
// Called from index.js after detectSession, where ctx.isSubagent is available.
// Idempotent: no-op if parentSessionId already set or no parent found.
function linkParentSession(sessionId, parsedBody, isSubagentHint) {
  if (!sessionId || sessionId === 'direct-api') return null;
  const meta = sessionMeta[sessionId];
  if (!meta) return null;
  if (meta.parentSessionId) return meta.parentSessionId;
  // A session that has ever shown a cwd is an established top-level session —
  // never re-parent it. Anthropic subagent kickoffs carry the PARENT's own
  // session_id (no cwd, ≤2 msgs), so without this guard every spawn re-qualifies
  // the parent itself for linking and inferParentSession may pick another
  // project's inflight session (real incident: d1997e5f → 3e419704). An explicit
  // wire-level hint (Codex subagent header) still overrides — those child
  // sessions never carry a cwd of their own.
  if (!isSubagentHint && meta.cwd) return null;
  // Unlike isLikelySubagent (which screens orphan requests without session_id),
  // this handles sessions WITH their own session_id. Tools and metadata guards
  // are intentionally absent because Codex subagents may carry both.
  const looksSubagent = isSubagentHint || (!extractCwd(parsedBody) && (parsedBody?.messages?.length || 0) <= 2);
  if (!looksSubagent) return null;
  const parent = inferParentSession();
  if (parent && parent !== sessionId) {
    meta.parentSessionId = parent;
    return parent;
  }
  return null;
}

function detectSession(req, socket) {
  const realId = extractSessionId(req);

  // Explicit session_id → authoritative.
  // isNewSession reflects "first time we have ever seen this sid",
  // not "different from the last sid" — switching A→B→A only banners A once.
  if (realId) {
    if (socket) socketSessions.set(socket, realId);
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

  // Socket affinity beats temporal inference for every orphan branch below:
  // the orphan arrived on a socket some session's own traffic used, so it
  // belongs to that session's process regardless of which session is hottest.
  const bySocket = socket ? socketSessions.get(socket) : null;

  // Likely subagent → infer parent, never pollute global state
  if (isLikelySubagent(req)) {
    if (bySocket && sessionMeta[bySocket]) {
      return { sessionId: bySocket, isNewSession: false, inferred: true };
    }
    const parent = inferParentSession();
    if (parent) return { sessionId: parent, isNewSession: false, inferred: true };
    // No recent session → fall back to currentSessionId only if it was active
    // within the inference window. An unbounded fallback silently glued orphans
    // arriving hours later onto a dead session (cross-project when the user had
    // switched). Stale → direct-api sentinel, don't create a spurious session.
    const curMeta = currentSessionId ? sessionMeta[currentSessionId] : null;
    const curFresh = curMeta?.lastSeenAt && Date.now() - curMeta.lastSeenAt <= 30000;
    return { sessionId: curFresh ? currentSessionId : 'direct-api', isNewSession: false, inferred: true };
  }

  // Non-subagent without session_id: try parent attribution before creating a phantom
  // session. Title-gen and other internal requests that don't pass isLikelySubagent
  // (e.g. due to message count) still belong to an existing session when one is active.
  if (bySocket && sessionMeta[bySocket]) {
    return { sessionId: bySocket, isNewSession: false, inferred: true };
  }
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
    // Banner is best-effort at session open (may not have usage yet). Prefer the
    // agent-aware template without enforcing has-usage.
    const meta = sessionMeta[sessionId] || {};
    const agent = meta.agent || agentForProvider(meta.provider);
    const hint = agent === 'grok' ? `grok --resume ${sessionId}`
      : agent === 'codex' ? `codex resume ${sessionId}`
      : `claude --resume ${sessionId}`;
    console.log(`\x1b[35m   ${hint}\x1b[0m`);
  }
  console.log();
}

function getRateLimitState() { return rateLimitState; }
function setRateLimitState(state) { rateLimitState = state; }
function getInterceptTimeout() { return interceptTimeout; }
function setInterceptTimeout(val) { interceptTimeout = val; }
function getCurrentSessionId() { return currentSessionId; }

// Keep loadedSkills consistent across session turns: post-compaction turns lose the
// skills system-reminder from their messages, so we cache the value in sessionMeta.
function propagateLoadedSkills(entry, sessionId) {
  if (!entry.tokens?.contextBreakdown || !sessionId) return;
  const sm = sessionMeta[sessionId] || (sessionMeta[sessionId] = {});
  const skills = entry.tokens.contextBreakdown.loadedSkills;
  if (skills?.length) {
    if (!sm.loadedSkills?.length) sm.loadedSkills = skills;
  } else {
    if (!sm.loadedSkills?.length) {
      const peer = entries.find(
        e => e !== entry && e.sessionId === sessionId &&
             e.tokens?.contextBreakdown?.loadedSkills?.length > 0
      );
      if (peer) sm.loadedSkills = peer.tokens.contextBreakdown.loadedSkills;
    }
    if (sm.loadedSkills?.length) entry.tokens.contextBreakdown.loadedSkills = sm.loadedSkills;
  }
}

function setRestoreState(patch) {
  Object.assign(restoreState, patch);
  restoreState.entryCount = entries.length;
}

// Mark a session as having produced a real completed turn. Codex only writes a
// resumable rollout file once a turn produces output; turns that billed input
// but emitted zero output (hung WS turns, cross-session retries) leave no
// rollout file, so `usage` alone is a false signal — status and stopReason are
// unreliable too (verified against ~/.codex/sessions ground truth, issue #44).
// output_tokens > 0 on a non-subagent entry is the only discriminator that
// matches. Monotonic: once true it never flips back.
function markSessionUsage(entry) {
  const sid = entry?.sessionId;
  if (!sid || NON_RESUMABLE_SESSIONS.has(sid)) return;
  if (entry.isSubagent) return;
  if (!(entry.usage?.output_tokens > 0)) return;
  const meta = sessionMeta[sid] || (sessionMeta[sid] = {});
  meta.hasUsage = true;
}

// Single source of truth for the dashboard's resume button. Interprets the
// declarative resume profile from UPSTREAM_PROFILES ({template, condition}):
// 'always' resumes unconditionally, 'has-usage' requires a completed turn.
// Returns the resume command string (null when the session can't be resumed).
function computeSessionResume(sessionId, provider, agent) {
  if (!sessionId || NON_RESUMABLE_SESSIONS.has(sessionId)) {
    return { resumable: false, resumeCommand: null };
  }
  // Entries without a provider predate provider tagging — they are anthropic.
  // An unknown provider, however, fails closed: better no button than a
  // command we can't vouch for.
  // Grok reuses the openai wire family but has its own resume CLI — prefer the
  // xai profile when the entry/session is labeled grok.
  const agentId = agent || sessionMeta[sessionId]?.agent || null;
  const profileKey = agentId === 'grok' ? 'xai'
    : (provider == null ? 'anthropic' : provider);
  const profile = getUpstreamProfile(profileKey);
  if (!profile) return { resumable: false, resumeCommand: null };
  const resume = profile.resume;
  if (!resume) return { resumable: false, resumeCommand: null };
  if (resume.condition === 'has-usage' && !sessionMeta[sessionId]?.hasUsage) {
    return { resumable: false, resumeCommand: null };
  }
  const resumeCommand = resume.template
    .replace('{agent}', agentId || agentForProvider(provider))
    .replace('{sid}', sessionId);
  return { resumable: true, resumeCommand };
}

module.exports = {
  MAX_ENTRIES,
  entries,
  entryIndex,
  trimEntries,
  getEntryById,
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
  isAnthropicSubagent,
  linkParentSession,
  detectSession,
  printSessionBanner,
  extractFirstUserMsgText,
  recordFirstUserMsg,
  setSessionTitle,
  getSessionTitle,
  attributeTitleGen,
  propagateLoadedSkills,
  markSessionUsage,
  computeSessionResume,
  NON_RESUMABLE_SESSIONS,
};
