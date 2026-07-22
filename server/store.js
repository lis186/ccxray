'use strict';

const { agentForProvider, getUpstreamProfile } = require('./providers');
const { extractAgentType } = require('./system-prompt');

// Synthetic session buckets that have no resumable rollout/session file.
const NON_RESUMABLE_SESSIONS = new Set(['direct-api', 'codex-raw', 'unknown']);

// ── In-memory store & SSE clients ───────────────────────────────────
const MAX_ENTRIES = parseInt(process.env.CCXRAY_MAX_ENTRIES || '5000', 10);
const SESSION_ENTRY_CAP = Math.max(1, parseInt(process.env.CCXRAY_SESSION_ENTRY_CAP || '500', 10) || 1);
const entries = [];
// INVARIANT: entryIndex must mirror entries[] — see docs/decisions/0003-entry-index-map.md
const entryIndex = new Map();
// INVARIANT: responseIndex mirrors the merged canonical set; merged-away copy ids
// stay in entryIndex as ALIASES pointing at their canonical. Push/trim sites keep
// both maps in sync — see docs/decisions/0012-response-id-read-time-merge.md (#333,
// extends ADR 0003).
const responseIndex = new Map(); // responseId → canonical entry
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

// ── Read-time merge by responseId (#333) ────────────────────────────
// When several ccxray processes observe the same traffic and write a shared
// ~/.ccxray, each logs the same logical response, so a dashboard reading the
// shared log sees 2–8 partial copies per turn — each carrying complementary
// metadata (one has agentKey, another a real usage, another convId). The
// upstream Anthropic message id (msg_01…) is assigned by Anthropic, not minted
// by any writer, so grouping by it and folding the copies into the single
// most-informative record is coordination-free and deterministic (a set union,
// not a uniqueness constraint). See docs/decisions/0012-response-id-read-time-merge.md.
//
// By construction the fold only reads an explicit field list — req/res/_loaded/
// _loadingPromise/_writePromise are NEVER folded across copies, so a released
// body can't be resurrected and load state stays with the kept object.

function _usageRichness(u) {
  if (!u || typeof u !== 'object') return -1;
  return (u.output_tokens || 0) + (u.input_tokens || 0)
    + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// Fold `other` into `canonical` in place. `canonical` keeps its id/ts/receivedAt/
// elapsed as a unit (the log timestamp lazy-load and date logic depend on) and
// its own req/res references; only complementary fields are pulled from `other`.
function _foldEntry(canonical, other) {
  // Identity + context + labels: a non-empty value fills a canonical gap.
  for (const k of ['agentKey', 'agentLabel', 'coreHash', 'convId', 'cwd', 'model',
    'title', 'thinkingDuration', 'thinkingStripped', 'duplicateToolCalls', 'toolSources']) {
    if ((canonical[k] == null || canonical[k] === '') && other[k] != null && other[k] !== '') {
      canonical[k] = other[k];
    }
  }
  // Numeric counts: prefer non-null, take max on conflict (same response ⇒ equal
  // in practice; rewind/compaction is a different responseId, never in one group).
  for (const k of ['msgCount', 'toolCount']) {
    if (other[k] != null) canonical[k] = canonical[k] != null ? Math.max(canonical[k], other[k]) : other[k];
  }
  // Tool/skill maps: fill only when canonical's is missing/empty.
  for (const k of ['toolCalls', 'skillCalls']) {
    const empty = canonical[k] == null || (typeof canonical[k] === 'object' && Object.keys(canonical[k]).length === 0);
    if (empty && other[k] != null) canonical[k] = other[k];
  }
  // usage/cost/maxContext/responseMetadata move as a unit to the richest usage —
  // cost is thereby counted once, never summed across copies.
  if (_usageRichness(other.usage) > _usageRichness(canonical.usage)) {
    canonical.usage = other.usage;
    canonical.cost = other.cost;
    canonical.maxContext = other.maxContext;
    canonical.responseMetadata = other.responseMetadata;
  }
  // Terminal signals: a set value beats null/empty.
  if (canonical.status == null && other.status != null) canonical.status = other.status;
  if (!canonical.stopReason && other.stopReason) canonical.stopReason = other.stopReason;
  // Prompt-identity hashes: keep canonical; a differing hash means an intercept
  // hop changed the bytes → flag edited rather than silently pick one.
  for (const k of ['sysHash', 'toolsHash']) {
    if (canonical[k] == null && other[k] != null) canonical[k] = other[k];
    else if (canonical[k] != null && other[k] != null && canonical[k] !== other[k]) canonical.edited = true;
  }
  // OR semantics — true if any copy saw it.
  if (other.toolFail) canonical.toolFail = true;
  if (other.hasCredential) canonical.hasCredential = true;
  if (other.edited) {
    canonical.edited = true;
    if (!canonical.editSummary && other.editSummary) canonical.editSummary = other.editSummary;
  }
  return canonical;
}

function _mergeGroup(copies) {
  if (copies.length === 1) return copies[0];
  const byStart = (a, b) =>
    (Number(a.receivedAt) || 0) - (Number(b.receivedAt) || 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Canonical: a proxy observation (has on-disk _req/_res) over an imported copy
  // (no files — making it canonical would break lazy-load forever); among those,
  // the earliest-receivedAt copy (closest to the real turn start).
  const proxy = copies.filter(c => !c.imported);
  const canonical = [...(proxy.length ? proxy : copies)].sort(byStart)[0];
  // Session identity comes from a real explicit session; the same copy supplies
  // isSubagent/sessionInferred so they stay mutually consistent.
  const sessionCopy = copies.find(c => c.sessionInferred === false && c.sessionId && c.sessionId !== 'direct-api')
    || copies.find(c => c.agentKey) || canonical;
  const mergedIds = [];
  for (const other of copies) {
    if (other === canonical) continue;
    _foldEntry(canonical, other);
    if (other.id && other.id !== canonical.id) mergedIds.push(other.id);
  }
  if (sessionCopy !== canonical) {
    canonical.sessionId = sessionCopy.sessionId;
    canonical.isSubagent = sessionCopy.isSubagent;
    canonical.sessionInferred = sessionCopy.sessionInferred;
  }
  // A real observation supersedes an import reconstruction.
  if (!canonical.imported) { delete canonical.imported; delete canonical.importSource; }
  // Recomputed from post-merge counts downstream, never carried.
  delete canonical.truncated;
  delete canonical.totalEntryCount;
  if (mergedIds.length) canonical._mergedIds = mergedIds;
  return canonical;
}

// Fold a flat list of entry-shaped objects so copies sharing a responseId become
// one canonical entry. Entries with a null/absent responseId are passed through
// untouched (no key ⇒ no group). Output order = first-encounter order; a group's
// canonical takes its first slot. The canonical carries `_mergedIds` (the dropped
// copy ids) so push sites can register aliases; `_mergedIds` is not an INDEX_FIELD
// and not in the summarizeEntry whitelist, so it never persists or broadcasts.
function mergeByResponseId(list) {
  const groups = new Map();
  const slots = [];
  for (const e of list) {
    const rid = e && e.responseId;
    if (!rid) { slots.push({ e }); continue; }
    if (!groups.has(rid)) { groups.set(rid, []); slots.push({ rid }); }
    groups.get(rid).push(e);
  }
  if (groups.size === 0) return list; // no dedup key anywhere — nothing to do
  const merged = new Map();
  for (const [rid, copies] of groups) merged.set(rid, _mergeGroup(copies));
  return slots.map(s => (s.e ? s.e : merged.get(s.rid)));
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
// #221: newer Claude Code builds stamp subagent requests with the parent's
// session_id, so the "no session_id" signal alone under-detects. When cwd
// is absent but session_id is present, fall back to agentKey — a known
// non-main key (e.g. 'general-purpose') still means subagent.
function isAnthropicSubagent(parsedBody) {
  const noCwd = !extractCwd(parsedBody);
  const noSid = !extractSessionId(parsedBody);
  if (noCwd && noSid) return true;
  if (noCwd) {
    const { key } = extractAgentType(parsedBody?.system);
    if (key !== 'orchestrator' && key !== 'sdk-agent' && key !== 'default'
        && key !== 'unknown' && key !== 'agent') return true;
  }
  return false;
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
    console.log(`\x1b[35m   claude --resume ${sessionId}\x1b[0m`);
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
function computeSessionResume(sessionId, provider) {
  if (!sessionId || NON_RESUMABLE_SESSIONS.has(sessionId)) {
    return { resumable: false, resumeCommand: null };
  }
  // Entries without a provider predate provider tagging — they are anthropic.
  // An unknown provider, however, fails closed: better no button than a
  // command we can't vouch for.
  const profile = provider == null ? getUpstreamProfile('anthropic') : getUpstreamProfile(provider);
  if (!profile) return { resumable: false, resumeCommand: null };
  const resume = profile.resume;
  if (!resume) return { resumable: false, resumeCommand: null };
  if (resume.condition === 'has-usage' && !sessionMeta[sessionId]?.hasUsage) {
    return { resumable: false, resumeCommand: null };
  }
  const resumeCommand = resume.template
    .replace('{agent}', agentForProvider(provider))
    .replace('{sid}', sessionId);
  return { resumable: true, resumeCommand };
}

module.exports = {
  MAX_ENTRIES,
  SESSION_ENTRY_CAP,
  entries,
  entryIndex,
  responseIndex,
  mergeByResponseId,
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
  inferParentSession,
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
