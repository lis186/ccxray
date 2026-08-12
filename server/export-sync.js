'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { resolveCcxrayHome } = require('./paths');

// ── Constants ──────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 3_600_000; // 1 hour
const LOCK_STALE_MS = 5 * 60_000;
const NAME_MAX_LEN = 64;
const EMAIL_RE = /[@]/;
const SCHEMA_VERSION = 1;

// Session flag thresholds
const RUNAWAY_TURNS = 200;
const RUNAWAY_COST = 50;
const HIGH_COST_ABS = 30;
const HIGH_COST_FACTOR = 3;
const TOOL_FAIL_SPIKE_PCT = 0.5;

// ── Module state ───────────────────────────────────────────────────────
let _interval = null;
let _uploader = null; // test seam
let _cachedToken = null; // { accessToken, expiresAt }

function _setUploader(fn) { _uploader = fn; }

// ── Agent ID ───────────────────────────────────────────────────────────
function getAgentId(home) {
  if (process.env.CCXRAY_AGENT_ID) return process.env.CCXRAY_AGENT_ID;
  const p = path.join(home, 'export-agent-id');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch {}
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(p, id + '\n', { mode: 0o600 });
  } catch {}
  return id;
}

// ── Lock (hub.js shape) ────────────────────────────────────────────────
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(lockPath) {
  const token = crypto.randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() });
  try {
    fs.writeFileSync(lockPath, payload, { flag: 'wx' });
    return token;
  } catch (err) {
    if (err.code !== 'EEXIST') return null;
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Date.now() - lock.acquiredAt > LOCK_STALE_MS || !isPidAlive(lock.pid)) {
        const stale = lockPath + `.stale.${process.pid}`;
        try { fs.renameSync(lockPath, stale); fs.unlinkSync(stale); } catch {}
        try {
          fs.writeFileSync(lockPath, payload, { flag: 'wx' });
          return token;
        } catch { return null; }
      }
    } catch {}
    return null;
  }
}

function releaseLock(lockPath, token) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock.token === token) fs.unlinkSync(lockPath);
  } catch {}
}

// ── Cursor (temp + rename) ─────────────────────────────────────────────
function readCursor(cursorPath) {
  try { return JSON.parse(fs.readFileSync(cursorPath, 'utf8')); } catch { return null; }
}

function writeCursor(cursorPath, data) {
  const tmp = cursorPath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, cursorPath);
}

// ── Name sanitization ──────────────────────────────────────────────────
function sanitizeName(name) {
  if (typeof name !== 'string' || !name) return null;
  if (EMAIL_RE.test(name)) return null;
  return name.length > NAME_MAX_LEN ? name.slice(0, NAME_MAX_LEN) : name;
}

// ── GCS auth (RS256 JWT, zero deps) ────────────────────────────────────
function signJwt(keyFile) {
  const sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(sa.private_key, 'base64url');
  return `${header}.${payload}.${sig}`;
}

function exchangeJwt(jwt) {
  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.access_token) resolve(j);
          else reject(new Error(data));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function getAccessToken(keyFile) {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) return _cachedToken.accessToken;
  const jwt = signJwt(keyFile);
  const tok = await exchangeJwt(jwt);
  _cachedToken = { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
  return _cachedToken.accessToken;
}

function uploadToGcs(bucket, objectName, body, accessToken) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(objectName);
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encoded}`;
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-ndjson',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`GCS ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ── Aggregation ────────────────────────────────────────────────────────

function utcDateFromId(id) {
  // id format: YYYY-MM-DDTHH-MM-SS-mmm
  const m = id && id.match(/^(\d{4}-\d{2}-\d{2})T/);
  return m ? m[1] : null;
}

function addMap(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [k, v] of Object.entries(source)) {
    const name = sanitizeName(k);
    if (!name) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      target[name] = (target[name] || 0) + v;
    }
  }
}

function foldToolSources(target, sources) {
  if (!sources || typeof sources !== 'object') return;
  for (const v of Object.values(sources)) {
    if (typeof v !== 'string') continue;
    // normalize: 'local:sensitive' → 'local', 'network' stays, 'mcp' stays
    const cat = v.includes(':') ? v.split(':')[0] : v;
    const name = sanitizeName(cat);
    if (name) target[name] = (target[name] || 0) + 1;
  }
}

// INVARIANT(ADR 0018): turnToolCalls null-vs-empty contract.
// null/undefined = legacy, fall back to per-tool max from cumulative toolCalls.
// {} = parsed zero-tool response, contributes zero.
// non-empty object = per-turn delta, sum directly.
function getToolCalls(entry) {
  if (entry.provider !== 'anthropic') {
    // OpenAI/Codex/Grok: toolCalls is already per-turn
    return entry.toolCalls || null;
  }
  // Anthropic: prefer turnToolCalls
  const ttc = entry.turnToolCalls;
  if (ttc !== null && ttc !== undefined) return ttc; // includes {} (truthy, zero tools)
  return null; // legacy — caller handles per-tool-max fallback
}

function aggregate(lines, agentId, configDirAllowlist) {
  const dailyByDt = new Map();
  const sessionsByDt = new Map(); // dt → Map(sid → session)
  const sessionPrevMsg = new Map(); // sid → last msgCount for compaction detection
  // Per-session-per-date per-tool max for legacy fallback (Anthropic only)
  const legacyToolMax = new Map(); // "dt\0sid" → Map(tool → maxCount)

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.id || !entry.sessionId) continue;

    const dt = utcDateFromId(entry.id);
    if (!dt) continue;

    // configDir filter: unknown → include.
    // ponytail: configDir is in sessionMeta (runtime), not INDEX_FIELDS (disk).
    // Filter only excludes entries that explicitly carry a non-allowlisted configDir.
    // Currently all index entries have configDir=undefined → all pass through.
    // Adding configDir to INDEX_FIELDS is a separate concern.
    if (configDirAllowlist) {
      const cd = entry.configDir;
      if (cd && !configDirAllowlist.has(cd)) continue;
    }

    // ── Daily aggregate ────────────────────────────────────────────
    let daily = dailyByDt.get(dt);
    if (!daily) {
      daily = {
        type: 'daily',
        _summary_schema_version: SCHEMA_VERSION,
        agent_id: agentId,
        user_email: process.env.CCXRAY_USER_EMAIL || null,
        team: process.env.CCXRAY_TEAM || null,
        dt,
        local_date: entry.localDate || null,
        tz: entry.tz || null,
        provider: null,
        upload_seq: 0,
        summary_id: null,
        partial_day: false,
        cost_total: 0,
        models: {},
        first_turn_context_pcts: [], // internal, cleaned in finishDaily
        context_utilization: { '0-40': 0, '40-80': 0, '80+': 0 },
        compaction_count: 0,
        distinct_sys_hashes: new Set(),
        distinct_tools_hashes: new Set(),
        tool_usage: {},
        tool_sources: {},
        skill_usage: {},
        tool_defined_count: 0,
        tool_used_count: 0,
        tool_fail_count: 0,
        duplicate_tool_call_count: 0,
        credential_flag: false,
        error_count: 0,
        stop_reasons: {},
        session_count: 0,
        turn_count: 0,
        subagent_turn_count: 0,
        cwd_repos: new Set(),
        _sessions: new Set(),
        _providerCounts: {},
        _costConfidence: { exact: 0, prefix: 0, fallback: 0, unknown: 0 },
        _fallbackCost: 0,
      };
      dailyByDt.set(dt, daily);
    }

    // Update local_date/tz from latest entry with data
    if (entry.localDate) daily.local_date = entry.localDate;
    if (entry.tz) daily.tz = entry.tz;

    daily.turn_count++;
    if (entry.isSubagent) daily.subagent_turn_count++;

    // Provider
    const prov = entry.provider || 'anthropic';
    daily._providerCounts[prov] = (daily._providerCounts[prov] || 0) + 1;

    // Sessions
    const sid = entry.sessionId;
    if (!daily._sessions.has(sid)) {
      daily._sessions.add(sid);
      daily.session_count++;
    }

    // Model breakdown
    const model = entry.model || 'unknown';
    let mb = daily.models[model];
    if (!mb) {
      mb = { turns: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, thinking_turns: 0, beta1m_turns: 0, cost: 0 };
      daily.models[model] = mb;
    }
    mb.turns++;
    if (entry.usage) {
      mb.input += entry.usage.input_tokens || 0;
      mb.output += entry.usage.output_tokens || 0;
      mb.cache_read += entry.usage.cache_read_input_tokens || 0;
      mb.cache_creation += entry.usage.cache_creation_input_tokens || 0;
    }
    if (entry.thinkingDuration > 0) mb.thinking_turns++;
    if (entry.beta1m === true) mb.beta1m_turns++;

    // Cost
    const costObj = entry.cost;
    if (costObj && typeof costObj === 'object') {
      const c = costObj.cost;
      const conf = costObj.confidence || 'unknown';
      if (c != null && Number.isFinite(c)) {
        daily.cost_total += c;
        mb.cost += c;
      }
      daily._costConfidence[conf] = (daily._costConfidence[conf] || 0) + 1;
      if (conf === 'fallback' && c != null) daily._fallbackCost += c;
    } else if (typeof costObj === 'number') {
      // Legacy numeric cost
      daily.cost_total += costObj;
      mb.cost += costObj;
    }

    // INVARIANT(ADR 0013): context utilization denominator is raw per-turn maxContext
    if (entry.usage && entry.maxContext > 0) {
      const input = (entry.usage.input_tokens || 0)
        + (entry.usage.cache_read_input_tokens || 0)
        + (entry.usage.cache_creation_input_tokens || 0);
      const pct = input / entry.maxContext;
      if (pct < 0.4) daily.context_utilization['0-40']++;
      else if (pct < 0.8) daily.context_utilization['40-80']++;
      else daily.context_utilization['80+']++;
    }

    // First-turn context % (for median calculation)
    // A "first turn" is the first entry we see for this session in this date
    if (!sessionsByDt.has(dt)) sessionsByDt.set(dt, new Map());
    const dtSessions = sessionsByDt.get(dt);
    if (!dtSessions.has(sid) && entry.usage && entry.maxContext > 0 && !entry.isSubagent) {
      const input = (entry.usage.input_tokens || 0)
        + (entry.usage.cache_read_input_tokens || 0)
        + (entry.usage.cache_creation_input_tokens || 0);
      daily.first_turn_context_pcts.push(input / entry.maxContext);
    }

    // Compaction: msgCount drop within session
    if (entry.msgCount != null && !entry.isSubagent) {
      const prev = sessionPrevMsg.get(sid);
      if (prev != null && entry.msgCount < prev) daily.compaction_count++;
      sessionPrevMsg.set(sid, entry.msgCount);
    }

    // Hash counts
    if (entry.sysHash) daily.distinct_sys_hashes.add(entry.sysHash);
    if (entry.toolsHash) daily.distinct_tools_hashes.add(entry.toolsHash);

    // Tool usage (INVARIANT: ADR 0018 null-vs-empty)
    const tc = getToolCalls(entry);
    if (tc && typeof tc === 'object') {
      addMap(daily.tool_usage, tc);
    } else if (tc === null && entry.provider === 'anthropic' && entry.toolCalls) {
      // Legacy fallback: per-tool max within session+date
      const ltKey = `${dt}\0${sid}`;
      if (!legacyToolMax.has(ltKey)) legacyToolMax.set(ltKey, new Map());
      const stm = legacyToolMax.get(ltKey);
      for (const [tool, count] of Object.entries(entry.toolCalls)) {
        const name = sanitizeName(tool);
        if (!name) continue;
        const prev = stm.get(name) || 0;
        if (typeof count === 'number' && count > prev) stm.set(name, count);
      }
    }

    // Tool sources
    foldToolSources(daily.tool_sources, entry.toolSources);

    // Skill usage
    if (entry.skillCalls && typeof entry.skillCalls === 'object') {
      addMap(daily.skill_usage, entry.skillCalls);
    }

    // Tool fail (per-turn signal, not cumulative)
    if (entry.turnToolFail === true) daily.tool_fail_count++;

    // Duplicate tool calls
    if (entry.duplicateToolCalls > 0) daily.duplicate_tool_call_count++;

    // Credential
    if (entry.hasCredential === true) daily.credential_flag = true;

    // Error (non-200 status)
    if (entry.status && entry.status !== 200) daily.error_count++;

    // Stop reasons
    if (entry.stopReason) {
      const sr = sanitizeName(String(entry.stopReason));
      if (sr) daily.stop_reasons[sr] = (daily.stop_reasons[sr] || 0) + 1;
    }

    // CWD → repo root
    if (entry.cwd) {
      const repo = repoRoot(entry.cwd);
      if (repo) daily.cwd_repos.add(repo);
    }

    // ── Session aggregate ──────────────────────────────────────────
    let sess = dtSessions.get(sid);
    if (!sess) {
      sess = {
        type: 'session',
        _summary_schema_version: SCHEMA_VERSION,
        agent_id: agentId,
        dt,
        session_id: sid,
        cost_total: 0,
        turn_count: 0,
        model_primary: null,
        cwd: null,
        flags: [],
        summary_id: null,
        _models: {},
        _costConfidence: { exact: 0, prefix: 0, fallback: 0, unknown: 0 },
        _hasCredential: false,
        _toolFailCount: 0,
      };
      dtSessions.set(sid, sess);
    }
    sess.turn_count++;
    sess._models[model] = (sess._models[model] || 0) + 1;
    if (entry.cwd && !sess.cwd) sess.cwd = repoRoot(entry.cwd);

    if (costObj && typeof costObj === 'object') {
      const c = costObj.cost;
      const conf = costObj.confidence || 'unknown';
      if (c != null && Number.isFinite(c)) sess.cost_total += c;
      sess._costConfidence[conf] = (sess._costConfidence[conf] || 0) + 1;
    } else if (typeof costObj === 'number') {
      sess.cost_total += costObj;
    }

    if (entry.hasCredential === true) sess._hasCredential = true;
    if (entry.turnToolFail === true) sess._toolFailCount++;
  }

  // ponytail: legacy per-tool max is cumulative high-water-mark, not actual count.
  // Summing maxima across sessions over-counts (inherent — no exact per-turn data).
  for (const [ltKey, stm] of legacyToolMax) {
    const dt = ltKey.split('\0')[0];
    const daily = dailyByDt.get(dt);
    if (!daily) continue;
    for (const [name, count] of stm) {
      daily.tool_usage[name] = (daily.tool_usage[name] || 0) + count;
    }
  }

  return { dailyByDt, sessionsByDt };
}

function repoRoot(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  // Normalize separators
  const norm = cwd.replace(/\\/g, '/');
  // Take the last path component (repo name), not the full path
  const parts = norm.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function finishDaily(daily, summaryId, uploadSeq, partial) {
  daily.summary_id = summaryId;
  daily.upload_seq = uploadSeq;
  if (partial) daily.partial_day = true;

  // Provider: dominant
  let maxProv = null, maxCount = 0;
  for (const [p, c] of Object.entries(daily._providerCounts)) {
    if (c > maxCount) { maxCount = c; maxProv = p; }
  }
  daily.provider = maxProv;

  // Cost confidence
  daily.cost_confidence = foldConfidence(daily._costConfidence);

  // First-turn median
  const pcts = daily.first_turn_context_pcts.sort((a, b) => a - b);
  daily.first_turn_context_pct_median = pcts.length > 0
    ? Math.round(pcts[Math.floor(pcts.length / 2)] * 10000) / 10000
    : null;

  // Hash counts → integers
  daily.distinct_sys_hash_count = daily.distinct_sys_hashes.size;
  daily.distinct_tools_hash_count = daily.distinct_tools_hashes.size;

  // Tool counts
  daily.tool_used_count = Object.keys(daily.tool_usage).length;
  daily.tool_defined_count = daily.tool_used_count; // no separate source for defined count

  // cwd_repos → array
  daily.cwd_repos = [...daily.cwd_repos];

  // Clean internal fields
  delete daily._sessions;
  delete daily._providerCounts;
  delete daily._costConfidence;
  delete daily._fallbackCost;
  delete daily.first_turn_context_pcts;
  delete daily.distinct_sys_hashes;
  delete daily.distinct_tools_hashes;
}

function finishSession(sess, daily, summaryId) {
  sess.summary_id = summaryId;

  // Model primary: most turns, tie-break alphabetical
  let best = null, bestCount = 0;
  for (const [m, c] of Object.entries(sess._models)) {
    if (c > bestCount || (c === bestCount && (!best || m < best))) {
      best = m; bestCount = c;
    }
  }
  sess.model_primary = best;

  // Cost confidence
  sess.cost_confidence = foldConfidence(sess._costConfidence);

  // Flags
  const flags = [];
  if (sess._hasCredential) flags.push('credential_leak');
  if (sess.turn_count > RUNAWAY_TURNS && sess.cost_total > RUNAWAY_COST) flags.push('runaway');
  // high_cost: > daily average × 3, or > absolute threshold
  if (daily && daily.session_count > 0) {
    const avg = daily.cost_total / daily.session_count;
    if (sess.cost_total > avg * HIGH_COST_FACTOR || sess.cost_total > HIGH_COST_ABS) flags.push('high_cost');
  } else if (sess.cost_total > HIGH_COST_ABS) {
    flags.push('high_cost');
  }
  if (sess.turn_count > 0 && sess._toolFailCount / sess.turn_count > TOOL_FAIL_SPIKE_PCT) flags.push('tool_fail_spike');
  sess.flags = flags;

  // Clean internal fields
  delete sess._models;
  delete sess._costConfidence;
  delete sess._hasCredential;
  delete sess._toolFailCount;
}

function foldConfidence(counts) {
  const total = counts.exact + counts.prefix + counts.fallback + counts.unknown;
  if (total === 0) return 'unknown';
  if (counts.unknown === total) return 'unknown';
  if (counts.fallback === total) return 'fallback';
  if (counts.fallback > 0 || counts.unknown > 0) return 'mixed';
  if (counts.exact > 0 && counts.prefix === 0) return 'exact';
  return 'mixed'; // prefix-only or exact+prefix → not fully exact
}

// ── Flush ──────────────────────────────────────────────────────────────
async function flushExport() {
  const bucket = process.env.CCXRAY_EXPORT_GCS_BUCKET;
  if (!bucket) return;

  const home = resolveCcxrayHome();
  const lockPath = path.join(home, 'export.lock');
  const cursorPath = path.join(home, 'export-cursor.json');
  const agentId = getAgentId(home);

  fs.mkdirSync(home, { recursive: true });
  const token = acquireLock(lockPath);
  if (!token) return; // another process holds the lock

  try {
    // Re-read cursor inside lock (ticket: 鎖內從共享 cursor 重讀)
    let cursor = readCursor(cursorPath);
    const isFirstRun = !cursor;

    // Read index via storage adapter
    const config = require('./config');
    const lines = [];
    let lastId = null;
    for await (const line of config.storage.readIndexLines()) {
      lines.push(line);
      try {
        const parsed = JSON.parse(line);
        if (parsed.id) lastId = parsed.id;
      } catch {}
    }

    if (isFirstRun) {
      // First run: init cursor to tail, no upload
      writeCursor(cursorPath, { lastId, seq: {}, partial: true });
      console.log('[ccxray export] First run — cursor initialized to index tail. No backfill.');
      return;
    }

    // Check if there's new data
    if (cursor.lastId && lastId === cursor.lastId) return; // nothing new

    // Parse configDir allowlist
    const rawDirs = process.env.CCXRAY_EXPORT_CONFIG_DIRS || '.claude';
    const configDirAllowlist = new Set(rawDirs.split(',').map(s => s.trim()).filter(Boolean));

    // Aggregate full index (last-writer-wins = complete daily snapshot)
    const { dailyByDt, sessionsByDt } = aggregate(lines, agentId, configDirAllowlist);

    if (dailyByDt.size === 0) {
      writeCursor(cursorPath, { lastId, seq: cursor.seq || {}, partial: false });
      return;
    }

    // Upload each date
    const prefix = process.env.CCXRAY_EXPORT_GCS_PREFIX || 'summaries';
    const keyFile = process.env.CCXRAY_EXPORT_GCS_KEY_FILE;
    const seq = cursor.seq || {};

    for (const [dt, daily] of dailyByDt) {
      const dtSeq = (seq[dt] || 0) + 1;
      seq[dt] = dtSeq;

      const uuid8 = crypto.randomUUID().slice(0, 8);
      const summaryId = `${agentId}:${dt}:${uuid8}`;
      const isPartial = !!cursor.partial;

      finishDaily(daily, summaryId, dtSeq, isPartial);

      const dtSessions = sessionsByDt.get(dt) || new Map();
      for (const sess of dtSessions.values()) {
        finishSession(sess, daily, summaryId);
      }

      // Build JSONL payload
      const payload = [daily, ...dtSessions.values()]
        .map(r => JSON.stringify(r))
        .join('\n') + '\n';

      // Upload
      const objectName = `${prefix}/dt=${dt}/${agentId}--${dtSeq}--${uuid8}.jsonl`;
      const upload = _uploader || (async (b, name, body) => {
        const accessToken = await getAccessToken(keyFile);
        return uploadToGcs(b, name, body, accessToken);
      });
      await upload(bucket, objectName, payload);
    }

    // Advance cursor
    writeCursor(cursorPath, { lastId, seq, partial: false });
  } finally {
    releaseLock(lockPath, token);
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────
function startExportSync() {
  if (!process.env.CCXRAY_EXPORT_GCS_BUCKET) return;
  // Initial flush (fire and forget — errors logged, not fatal)
  flushExport().catch(err => console.error('[ccxray export] Initial flush failed:', err.message));
  _interval = setInterval(() => {
    flushExport().catch(err => console.error('[ccxray export] Periodic flush failed:', err.message));
  }, FLUSH_INTERVAL_MS);
  _interval.unref();
}

function stopExportSync() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { startExportSync, stopExportSync, flushExport, _setUploader };
