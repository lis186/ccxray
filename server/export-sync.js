'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { resolveCcxrayHome } = require('./paths');

// ── Constants ──────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 3_600_000; // 1 hour
const LOCK_STALE_MS = 5 * 60_000;
const GCS_TIMEOUT_MS = 3_000; // ponytail: 3s not 30s — shutdown deadline is 5s, at-least-once retries next flush
const NAME_MAX_LEN = 64;
const EMAIL_RE = /[@]/;
const SCHEMA_VERSION = 1;
const FLOOR_VERSION = 1;
const CUTOFF_DT_RE = /^\d{4}-\d{2}-\d{2}$/;

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
let _runningFlush = null; // in-flight flush promise for graceful shutdown

function _setUploader(fn) { _uploader = fn; }

// INVARIANT: one predicate, two callers (flushExport + startExportSync). Under
// `node --test` a real upload must be structurally impossible: the suite has no
// shared env-scrub helper and CCXRAY_HOME does NOT isolate the bucket, so any e2e
// that boots a full server inherits a developer's exported CCXRAY_EXPORT_GCS_BUCKET
// and ships synthetic summaries to it. Measured 2026-08-21:
// test/multi-agent-proxy.e2e.test.js pushed one 3-turn fake-provider daily row to
// the company bucket (GCS objects 136 -> 137). NODE_TEST_CONTEXT is set by node's
// test runner and inherited by spawned children; a real user never has it. A
// non-null `_uploader` means a test injected the seam and is asserting on
// aggregation rather than uploading — those tests must still run.
// If these two callers drift, startExportSync() announces an exporter that
// flushExport() then refuses to run — a false positive worse than no message.
function isExportSuppressed() {
  // TWO layers, in precedence. A third layer that inferred "this run is synthetic" from
  // configuration was tried and DELETED: it keyed on CCXRAY_HOME/LOGS_DIR being set, but
  // ccxray-ops/scripts/deploy-stable.sh launches the REAL hub with
  // CCXRAY_HOME="$HOME/.ccxray", so it would have switched off production exports while
  // pruneLogs kept running (codex review round 5, 2026-08-21). An earlier variant sniffed
  // for temp directories and was wrong in the other direction. There is no reliable
  // ambient signal for "synthetic" — launchers have to say so.
  //
  // CCXRAY_EXPORT_FORCE was removed with that layer: it existed only to lift it, and an
  // inherited FORCE was itself a hazard (a detached hub inherits its environment).

  // 1. Explicit opt-out. Set by every synthetic launcher: scripts/boot-smoke.sh,
  //    scripts/perf/measure.js, test/*.sh, the four full-server .test.js spawns, the
  //    command printed by scripts/generate-screenshot-fixtures.js, shoot-spiral.mjs, the
  //    smoke command in CLAUDE.md, and the documented boot commands under docs/.
  //    A new launcher MUST set it — test/export-sync-test-guard.test.js has an
  //    enumeration check so a missing one fails the suite rather than leaking silently.
  if (process.env.CCXRAY_EXPORT_DISABLE === '1') return true;

  // 2. Automatic net for `node --test`, which is what `npm test` runs — this is where the
  //    measured leak happened (GCS objects 136 -> 137 from a synthetic daily row). It is
  //    deliberately NOT liftable by any env flag. Not sufficient alone: `node
  //    test/foo.test.js` and `--test-isolation=none` leave NODE_TEST_CONTEXT unset, which
  //    is why layer 1 is on the launchers too. A non-null `_uploader` means a test injected
  //    the seam and is asserting on aggregation rather than uploading.
  if (process.env.NODE_TEST_CONTEXT && !_uploader) return true;

  return false;
}


// ── Agent ID ───────────────────────────────────────────────────────────
function getAgentId(home) {
  if (process.env.CCXRAY_AGENT_ID) return process.env.CCXRAY_AGENT_ID;
  const p = path.join(home, 'export-agent-id');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch {}
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(p, id + '\n', { flag: 'wx', mode: 0o600 }); // R3: atomic
  } catch {
    // Another process won the race — read its value
    try { return fs.readFileSync(p, 'utf8').trim(); } catch {}
  }
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
    // #6: parse failure = treat as stale (corrupted lock)
    let lock;
    try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { lock = null; }
    if (!lock || !isPidAlive(lock.pid)) {
      const stale = lockPath + `.stale.${process.pid}`;
      try { fs.renameSync(lockPath, stale); fs.unlinkSync(stale); } catch {}
      try {
        fs.writeFileSync(lockPath, payload, { flag: 'wx' });
        return token;
      } catch { return null; }
    }
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
  let raw;
  try {
    raw = fs.readFileSync(cursorPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch {
    const corruptPath = `${cursorPath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(cursorPath, corruptPath);
      console.warn(`[ccxray export] Corrupt cursor moved aside to ${corruptPath}; starting first run.`);
    } catch (renameErr) {
      console.warn(`[ccxray export] Corrupt cursor could not be moved aside (${renameErr.message}); starting first run.`);
    }
    return null;
  }
}

function writeCursor(cursorPath, data) {
  const tmp = cursorPath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, cursorPath);
}

function pruneSeqBeforeFloor(seq, cutoffDt) {
  if (!seq || typeof seq !== 'object' || Array.isArray(seq)) return {};
  const kept = {};
  for (const [dt, value] of Object.entries(seq)) {
    if (dt >= cutoffDt) kept[dt] = value;
  }
  return kept;
}

function hasValidFloor(cursor) {
  const cutoffDt = cursor.cutoffDt;
  if (typeof cutoffDt !== 'string'
    || !CUTOFF_DT_RE.test(cutoffDt)
    || cursor.floorV !== FLOOR_VERSION) return false;
  const parsed = new Date(`${cutoffDt}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === cutoffDt;
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
      timeout: GCS_TIMEOUT_MS,
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
    req.on('timeout', () => { req.destroy(new Error('GCS auth timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

// ponytail: ADC fallback — reads ~/.config/gcloud/application_default_credentials.json
// and does an OAuth2 refresh. SA key file takes precedence when set.
function refreshAdc() {
  const adcPath = path.join(process.env.HOME || '', '.config', 'gcloud', 'application_default_credentials.json');
  const adc = JSON.parse(fs.readFileSync(adcPath, 'utf8'));
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: adc.client_id,
    client_secret: adc.client_secret,
    refresh_token: adc.refresh_token,
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      timeout: GCS_TIMEOUT_MS,
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
    req.on('timeout', () => { req.destroy(new Error('ADC refresh timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

async function getAccessToken(keyFile) {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) return _cachedToken.accessToken;
  const tok = keyFile ? await exchangeJwt(signJwt(keyFile)) : await refreshAdc();
  _cachedToken = { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
  return _cachedToken.accessToken;
}

function uploadToGcs(bucket, objectName, body, accessToken) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(objectName);
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encoded}`;
    const req = https.request(url, {
      method: 'POST',
      timeout: GCS_TIMEOUT_MS,
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
    req.on('timeout', () => { req.destroy(new Error('GCS upload timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

// ── Aggregation ────────────────────────────────────────────────────────

// #5+R3: prefer receivedAt (epoch ms, timezone-safe) for UTC date.
// Fallback to id only when receivedAt is absent (legacy entries).
// Entry ids are formatted in Asia/Taipei local time (server/helpers.js),
// so parsing them as local time only works when TZ matches the writer.
function utcDateFromEntry(entry) {
  if (typeof entry.receivedAt === 'number' && entry.receivedAt > 0) {
    return new Date(entry.receivedAt).toISOString().slice(0, 10);
  }
  const m = entry.id && entry.id.match(/^(\d{4}-\d{2}-\d{2})T/);
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

// #7/#8: toolSources and skillCalls are cumulative in Anthropic entries.
// Use per-session per-tool max, same shape as the ADR 0018 legacy fallback.
function maxMap(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [k, v] of Object.entries(source)) {
    const name = sanitizeName(k);
    if (!name) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      target[name] = Math.max(target[name] || 0, v);
    }
  }
}

// #7: toolSources values are strings like 'local', not numbers.
// Per-session max of string-value counts.
function maxToolSourceCounts(target, sources) {
  if (!sources || typeof sources !== 'object') return;
  const counts = {};
  for (const v of Object.values(sources)) {
    if (typeof v !== 'string') continue;
    const cat = v.includes(':') ? v.split(':')[0] : v;
    const name = sanitizeName(cat);
    if (name) counts[name] = (counts[name] || 0) + 1;
  }
  for (const [name, count] of Object.entries(counts)) {
    target[name] = Math.max(target[name] || 0, count);
  }
}

// INVARIANT(ADR 0018): turnToolCalls null-vs-empty contract.
function getToolCalls(entry) {
  if (entry.provider !== 'anthropic') {
    return entry.toolCalls || null;
  }
  const ttc = entry.turnToolCalls;
  if (ttc !== null && ttc !== undefined) return ttc;
  return null;
}

// #1(ADR 0012): field-wise merge for responseId duplicates — prefer non-null
function mergeEntry(a, b) {
  const merged = { ...a };
  if (b.usage) {
    const aOut = a.usage?.output_tokens || 0;
    const bOut = b.usage.output_tokens || 0;
    if (bOut > aOut || !a.usage) merged.usage = b.usage;
  }
  if (b.cost && typeof b.cost === 'object' && b.cost.cost != null) {
    if (!a.cost || typeof a.cost !== 'object' || a.cost.cost == null) {
      merged.cost = b.cost;
    }
  }
  for (const f of ['maxContext', 'model', 'cwd', 'stopReason', 'thinkingDuration',
    'msgCount', 'toolCount', 'turnToolCalls', 'toolCalls', 'skillCalls',
    'toolSources', 'duplicateToolCalls', 'receivedAt', 'provider',
    'agentKey', 'isSubagent', 'status', 'sysHash', 'toolsHash']) {
    if (merged[f] == null && b[f] != null) merged[f] = b[f];
  }
  // ADR 0012: prefer non-inferred session identity
  if (b.sessionInferred === false && a.sessionInferred !== false) {
    if (b.sessionId) merged.sessionId = b.sessionId;
    merged.sessionInferred = false;
  }
  if (b.hasCredential) merged.hasCredential = true;
  if (b.turnToolFail) merged.turnToolFail = true;
  if (b.beta1m) merged.beta1m = true;
  return merged;
}

function aggregate(lines, agentId, configDirAllowlist) {
  const dailyByDt = new Map();
  const sessionsByDt = new Map(); // dt → Map(sid → session)
  const sessionPrevMsg = new Map(); // sid → last msgCount for compaction detection
  const legacyToolMax = new Map(); // sid → Map(tool → maxCount)
  // #7/#8: per-session max for cumulative fields, keyed by sid only
  // #2: fold into session's home date only (no cross-midnight double-count)
  const sessToolSources = new Map(); // sid → {cat: maxCount}
  const sessSkillCalls = new Map(); // sid → {skill: maxCount}
  const sessDupToolCalls = new Map(); // sid → {tool: maxCount}
  const sessionHomeDt = new Map(); // sid → first turn UTC date
  // #1+R3(ADR 0012): responseId dedup — pre-merge keeps the entry with
  // the richest usage/cost per ADR 0012's most-informative-register principle.
  const seenRids = new Map(); // responseId → index in dedupedEntries
  const dedupedEntries = [];

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.id || !entry.sessionId) continue;

    // #1(ADR 0012): responseId dedup — field-wise merge
    if (entry.responseId) {
      const prevIdx = seenRids.get(entry.responseId);
      if (prevIdx !== undefined) {
        dedupedEntries[prevIdx] = mergeEntry(dedupedEntries[prevIdx], entry);
        continue;
      }
      seenRids.set(entry.responseId, dedupedEntries.length);
    }
    dedupedEntries.push(entry);
  }

  // R4: sort by receivedAt so compaction detection and first-turn selection
  // are not confused by out-of-order append order.
  // R5: null receivedAt sorts last (not 0 → first) so rebuild-index rows
  // don't poison first-turn/compaction detection.
  dedupedEntries.sort((a, b) => (a.receivedAt || Infinity) - (b.receivedAt || Infinity));

  // Second pass: aggregate deduped entries
  for (const entry of dedupedEntries) {
    const dt = utcDateFromEntry(entry);
    if (!dt) continue;

    // configDir filter: unknown → include.
    // ponytail: configDir is in sessionMeta (runtime), not INDEX_FIELDS (disk).
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
        models: Object.create(null),
        first_turn_context_pcts: [],
        context_utilization: { '0-40': 0, '40-80': 0, '80+': 0 },
        compaction_count: 0,
        distinct_sys_hashes: new Set(),
        distinct_tools_hashes: new Set(),
        tool_usage: {},
        tool_sources: {},
        skill_usage: {},
        tool_defined_count: 0,
        tool_used_count: 0,
        _maxToolCount: 0,
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
        _hasNewData: false,
      };
      dailyByDt.set(dt, daily);
    }

    if (entry.localDate) daily.local_date = entry.localDate;
    if (entry.tz) daily.tz = entry.tz;

    daily.turn_count++;
    if (entry.isSubagent) daily.subagent_turn_count++;

    const prov = entry.provider || 'anthropic';
    daily._providerCounts[prov] = (daily._providerCounts[prov] || 0) + 1;

    const sid = entry.sessionId;
    if (!sessionHomeDt.has(sid)) sessionHomeDt.set(sid, dt);
    if (!daily._sessions.has(sid)) {
      daily._sessions.add(sid);
      daily.session_count++;
    }

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

    // #9: cost confidence — null cost = unknown, legacy numeric = unknown confidence
    const costObj = entry.cost;
    if (costObj && typeof costObj === 'object') {
      const c = costObj.cost;
      const conf = costObj.confidence || 'unknown';
      if (c != null && Number.isFinite(c)) {
        daily.cost_total += c;
        mb.cost += c;
        daily._costConfidence[conf] = (daily._costConfidence[conf] || 0) + 1;
        if (conf === 'fallback') daily._fallbackCost += c;
      } else {
        daily._costConfidence.unknown++;
      }
    } else if (typeof costObj === 'number') {
      daily.cost_total += costObj;
      mb.cost += costObj;
      daily._costConfidence.unknown++; // #9: legacy numeric has no confidence signal
    } else {
      daily._costConfidence.unknown++; // #9: null/missing cost
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

    // First-turn context %
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

    if (entry.sysHash) daily.distinct_sys_hashes.add(entry.sysHash);
    if (entry.toolsHash) daily.distinct_tools_hashes.add(entry.toolsHash);

    // Tool usage (INVARIANT: ADR 0018 null-vs-empty)
    const tc = getToolCalls(entry);
    if (tc && typeof tc === 'object') {
      addMap(daily.tool_usage, tc);
    } else if (tc === null && entry.provider === 'anthropic' && entry.toolCalls) {
      if (!legacyToolMax.has(sid)) legacyToolMax.set(sid, new Map());
      const stm = legacyToolMax.get(sid);
      for (const [tool, count] of Object.entries(entry.toolCalls)) {
        const name = sanitizeName(tool);
        if (!name) continue;
        const prev = stm.get(name) || 0;
        if (typeof count === 'number' && count > prev) stm.set(name, count);
      }
    }

    // #7: toolSources is cumulative — per-session max, fold into home date only (#2)
    if (!sessToolSources.has(sid)) sessToolSources.set(sid, {});
    maxToolSourceCounts(sessToolSources.get(sid), entry.toolSources);

    // #8: skillCalls is cumulative — same per-session max shape (#2)
    if (entry.skillCalls && typeof entry.skillCalls === 'object') {
      if (!sessSkillCalls.has(sid)) sessSkillCalls.set(sid, {});
      maxMap(sessSkillCalls.get(sid), entry.skillCalls);
    }

    if (entry.turnToolFail === true) daily.tool_fail_count++;

    // R3: tool_defined_count from entry.toolCount (number of tools defined in request)
    if (typeof entry.toolCount === 'number' && entry.toolCount > daily._maxToolCount) {
      daily._maxToolCount = entry.toolCount;
    }

    // R4: duplicateToolCalls is cumulative {toolName: count}. Per-session max, home date only (#2).
    if (entry.duplicateToolCalls != null && typeof entry.duplicateToolCalls === 'object') {
      if (!sessDupToolCalls.has(sid)) sessDupToolCalls.set(sid, {});
      maxMap(sessDupToolCalls.get(sid), entry.duplicateToolCalls);
    }

    if (entry.hasCredential === true) daily.credential_flag = true;

    // #11: WS status 101 is not an error
    if (entry.status && entry.status !== 200 && entry.status !== 101) daily.error_count++;

    if (entry.stopReason) {
      const sr = sanitizeName(String(entry.stopReason));
      if (sr) daily.stop_reasons[sr] = (daily.stop_reasons[sr] || 0) + 1;
    }

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
        _models: Object.create(null),
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
      if (c != null && Number.isFinite(c)) {
        sess.cost_total += c;
        sess._costConfidence[conf] = (sess._costConfidence[conf] || 0) + 1;
      } else {
        sess._costConfidence.unknown++;
      }
    } else if (typeof costObj === 'number') {
      sess.cost_total += costObj;
      sess._costConfidence.unknown++;
    } else {
      sess._costConfidence.unknown++;
    }

    if (entry.hasCredential === true) sess._hasCredential = true;
    if (entry.turnToolFail === true) sess._toolFailCount++;
  }

  // #2: fold per-session maxima into the session's home date daily total
  for (const [sid, stm] of legacyToolMax) {
    const dt = sessionHomeDt.get(sid);
    const daily = dt && dailyByDt.get(dt);
    if (!daily) continue;
    for (const [name, count] of stm) {
      daily.tool_usage[name] = (daily.tool_usage[name] || 0) + count;
    }
  }

  for (const [sid, cats] of sessToolSources) {
    const dt = sessionHomeDt.get(sid);
    const daily = dt && dailyByDt.get(dt);
    if (!daily) continue;
    for (const [cat, count] of Object.entries(cats)) {
      daily.tool_sources[cat] = (daily.tool_sources[cat] || 0) + count;
    }
  }

  for (const [sid, skills] of sessSkillCalls) {
    const dt = sessionHomeDt.get(sid);
    const daily = dt && dailyByDt.get(dt);
    if (!daily) continue;
    for (const [skill, count] of Object.entries(skills)) {
      daily.skill_usage[skill] = (daily.skill_usage[skill] || 0) + count;
    }
  }

  for (const [sid, tools] of sessDupToolCalls) {
    const dt = sessionHomeDt.get(sid);
    const daily = dt && dailyByDt.get(dt);
    if (!daily) continue;
    for (const count of Object.values(tools)) {
      if (typeof count === 'number') daily.duplicate_tool_call_count += count;
    }
  }

  return { dailyByDt, sessionsByDt, sessionHomeDt };
}

// ponytail: allowlist gates which repo names leave the machine; unknown → '[other]'
const _cwdAllowlist = process.env.CCXRAY_EXPORT_CWD_ALLOWLIST
  ? new Set(process.env.CCXRAY_EXPORT_CWD_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean))
  : null;

function repoRoot(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const norm = cwd.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : null;
  if (!name) return null;
  if (!_cwdAllowlist) return name;
  return _cwdAllowlist.has(name) ? name : '[other]';
}

function finishDaily(daily, summaryId, uploadSeq, partial) {
  daily.summary_id = summaryId;
  daily.upload_seq = uploadSeq;
  if (partial) daily.partial_day = true;

  let maxProv = null, maxCount = 0;
  for (const [p, c] of Object.entries(daily._providerCounts)) {
    if (c > maxCount) { maxCount = c; maxProv = p; }
  }
  daily.provider = maxProv;

  daily.cost_confidence = foldConfidence(daily._costConfidence);

  // #6: median — proper two-middle average for even-length arrays, value is ratio 0-1
  const pcts = daily.first_turn_context_pcts.sort((a, b) => a - b);
  if (pcts.length > 0) {
    const mid = Math.floor(pcts.length / 2);
    const median = pcts.length % 2 === 1 ? pcts[mid] : (pcts[mid - 1] + pcts[mid]) / 2;
    daily.first_turn_context_pct_median = Math.round(median * 10000) / 10000;
  } else {
    daily.first_turn_context_pct_median = null;
  }

  daily.distinct_sys_hash_count = daily.distinct_sys_hashes.size;
  daily.distinct_tools_hash_count = daily.distinct_tools_hashes.size;
  daily.tool_used_count = Object.keys(daily.tool_usage).length;
  daily.tool_defined_count = daily._maxToolCount || daily.tool_used_count;
  daily.cwd_repos = [...daily.cwd_repos];

  delete daily._sessions;
  delete daily._providerCounts;
  delete daily._costConfidence;
  delete daily._fallbackCost;
  delete daily.first_turn_context_pcts;
  delete daily.distinct_sys_hashes;
  delete daily.distinct_tools_hashes;
  delete daily._hasNewData;
  delete daily._maxToolCount;
}

function finishSession(sess, daily, summaryId) {
  sess.summary_id = summaryId;

  let best = null, bestCount = 0;
  for (const [m, c] of Object.entries(sess._models)) {
    if (c > bestCount || (c === bestCount && (!best || m < best))) {
      best = m; bestCount = c;
    }
  }
  sess.model_primary = best;
  sess.cost_confidence = foldConfidence(sess._costConfidence);

  const flags = [];
  if (sess._hasCredential) flags.push('credential_leak');
  if (sess.turn_count > RUNAWAY_TURNS && sess.cost_total > RUNAWAY_COST) flags.push('runaway');
  if (daily && daily.session_count > 0) {
    const avg = daily.cost_total / daily.session_count;
    if (sess.cost_total > avg * HIGH_COST_FACTOR || sess.cost_total > HIGH_COST_ABS) flags.push('high_cost');
  } else if (sess.cost_total > HIGH_COST_ABS) {
    flags.push('high_cost');
  }
  if (sess.turn_count > 0 && sess._toolFailCount / sess.turn_count > TOOL_FAIL_SPIKE_PCT) flags.push('tool_fail_spike');
  sess.flags = flags;

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
  return 'mixed';
}

// ── Flush ──────────────────────────────────────────────────────────────
async function flushExport() {
  const bucket = process.env.CCXRAY_EXPORT_GCS_BUCKET;
  if (!bucket) return;

  // INVARIANT: see isExportSuppressed — a real upload must be impossible
  // under `node --test`, and startExportSync must agree with this same predicate.
  if (isExportSuppressed()) return;

  // Snapshot the seam ONCE. The suppression check above and the upload call below are
  // separated by async index traversal; a test's `_setUploader(null)` cleanup landing in
  // that window would otherwise let an already-permitted flush switch to the real GCS
  // uploader (codex review, 2026-08-21).
  const uploaderAtEntry = _uploader;

  const home = resolveCcxrayHome();
  const lockPath = path.join(home, 'export.lock');
  const cursorPath = path.join(home, 'export-cursor.json');
  const agentId = getAgentId(home);

  fs.mkdirSync(home, { recursive: true });
  const token = acquireLock(lockPath);
  if (!token) return;

  try {
    let cursor = readCursor(cursorPath);
    const isFirstRun = !cursor;

    // #4: cursor tracks last-processed entry id (not line count)
    const config = require('./config');
    const lines = [];
    for await (const line of config.storage.readIndexLines()) {
      lines.push(line);
    }

    // Find last entry id in index
    let currentLastId = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const p = JSON.parse(lines[i]); if (p.id) { currentLastId = p.id; break; } } catch {}
    }

    if (isFirstRun) {
      const cutoffDt = new Date().toISOString().slice(0, 10);
      // Permanent no-backfill promise: the first-run floor is today's UTC date,
      // independent of the index contents.
      writeCursor(cursorPath, {
        lastId: currentLastId, seq: {}, partial: true, cutoffDt, floorV: FLOOR_VERSION,
      });
      console.log('[ccxray export] First run — cursor initialized to index tail. No backfill.');
      return;
    }

    if (!hasValidFloor(cursor)) {
      // Preserve the permanent no-backfill promise when repairing a legacy or malformed floor.
      const cutoffDt = new Date().toISOString().slice(0, 10);
      cursor = {
        ...cursor,
        seq: pruneSeqBeforeFloor(cursor.seq, cutoffDt),
        cutoffDt,
        floorV: FLOOR_VERSION,
      };
      writeCursor(cursorPath, cursor);
    }
    const cutoffDt = cursor.cutoffDt;

    // #4: nothing new if last entry id unchanged
    if (!currentLastId || currentLastId === cursor.lastId) return;

    const rawDirs = process.env.CCXRAY_EXPORT_CONFIG_DIRS || '.claude';
    const configDirAllowlist = new Set(rawDirs.split(',').map(s => s.trim()).filter(Boolean));

    const { dailyByDt, sessionsByDt, sessionHomeDt } = aggregate(lines, agentId, configDirAllowlist);

    if (dailyByDt.size === 0) {
      // Persist the no-backfill floor even when there is no aggregate to upload.
      writeCursor(cursorPath, {
        lastId: currentLastId,
        seq: pruneSeqBeforeFloor(cursor.seq, cutoffDt),
        partial: false,
        cutoffDt,
        floorV: FLOOR_VERSION,
      });
      return;
    }

    // #4: find cursor.lastId position → lines after it have new data
    const datesWithNewData = new Set();
    const sessionsWithNewData = new Set();
    let cursorLineIdx = -1;
    if (cursor.lastId) {
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const p = JSON.parse(lines[i]); if (p.id === cursor.lastId) { cursorLineIdx = i; break; } } catch {}
      }
    }
    const startIdx = cursorLineIdx >= 0 ? cursorLineIdx + 1 : 0;
    for (let i = startIdx; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        const dt = utcDateFromEntry(parsed);
        if (dt) datesWithNewData.add(dt);
        if (parsed.sessionId) sessionsWithNewData.add(parsed.sessionId);
      } catch {}
    }

    // P1: cross-midnight cumulative fold targets home date, which may differ
    // from the new-data date. Include it so the fold is uploaded.
    for (const sid of sessionsWithNewData) {
      const homeDt = sessionHomeDt.get(sid);
      if (homeDt) datesWithNewData.add(homeDt);
    }

    const prefix = process.env.CCXRAY_EXPORT_GCS_PREFIX || 'summaries';
    const keyFile = process.env.CCXRAY_EXPORT_GCS_KEY_FILE;
    const seq = { ...(cursor.seq || {}) };

    // #3: completedDts bound to snapshot — clear if index changed since they were recorded
    const completedDts = new Set(
      cursor.snapshotLastId === currentLastId ? (cursor.completedDts || []) : []
    );

    for (const [dt, daily] of dailyByDt) {
      if (!datesWithNewData.has(dt)) continue;
      // Permanent no-backfill promise: dates before the cursor floor never upload.
      if (dt < cutoffDt) continue;
      if (completedDts.has(dt) && seq[dt] && seq[dt] === cursor.seq?.[dt]) continue;

      const dtSeq = (seq[dt] || 0) + 1;
      seq[dt] = dtSeq;

      const uuid8 = crypto.randomUUID().slice(0, 8);
      const summaryId = `${agentId}:${dt}:${uuid8}`;
      const isPartial = cursor.partial && dt === cutoffDt;

      finishDaily(daily, summaryId, dtSeq, isPartial);

      const dtSessions = sessionsByDt.get(dt) || new Map();
      for (const sess of dtSessions.values()) {
        finishSession(sess, daily, summaryId);
      }

      const payload = [daily, ...dtSessions.values()]
        .map(r => JSON.stringify(r))
        .join('\n') + '\n';

      const objectName = `${prefix}/dt=${dt}/${agentId}--${dtSeq}--${uuid8}.jsonl`;
      const upload = uploaderAtEntry || (async (b, name, body) => {
        const accessToken = await getAccessToken(keyFile);
        return uploadToGcs(b, name, body, accessToken);
      });
      await upload(bucket, objectName, payload);

      // #3: per-date checkpoint bound to current snapshot
      completedDts.add(dt);
      // Persist cutoffDt so the permanent no-backfill promise survives checkpoints.
      writeCursor(cursorPath, {
        lastId: cursor.lastId,
        seq: pruneSeqBeforeFloor(seq, cutoffDt),
        partial: false,
        completedDts: [...completedDts],
        snapshotLastId: currentLastId,
        cutoffDt,
        floorV: FLOOR_VERSION,
      });
    }

    // All dates uploaded — advance lastId to current tail, clear completedDts
    // Persist cutoffDt so the permanent no-backfill promise survives cursor advance.
    writeCursor(cursorPath, {
      lastId: currentLastId,
      seq: pruneSeqBeforeFloor(seq, cutoffDt),
      partial: false,
      cutoffDt,
      floorV: FLOOR_VERSION,
    });
  } finally {
    releaseLock(lockPath, token);
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────
function startExportSync() {
  const bucket = process.env.CCXRAY_EXPORT_GCS_BUCKET;
  if (!bucket) return;
  // INVARIANT: must share isExportSuppressed with flushExport, or this announces an
  // exporter that never flushes.
  if (isExportSuppressed()) return;
  // Until 2026-08-21 the exporter started with NO positive signal — only failures
  // printed — so a user who mis-set the env could not tell. issues/08-rollout-plan.md
  // told people to look for "exporter active", which did not exist. It does now.
  console.log(`\x1b[90m   [ccxray export] exporter active — bucket ${bucket}, flush every ${Math.round(FLUSH_INTERVAL_MS / 60000)}min\x1b[0m`);
  _runningFlush = flushExport().catch(err => console.error('[ccxray export] Initial flush failed:', err.message));
  _interval = setInterval(() => {
    // P1: chain so awaitPendingFlush waits for ALL in-flight flushes, not just the latest
    _runningFlush = Promise.resolve(_runningFlush).then(() =>
      flushExport().catch(err => console.error('[ccxray export] Periodic flush failed:', err.message))
    );
  }, FLUSH_INTERVAL_MS);
  _interval.unref();
}

function stopExportSync() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// #5: await in-flight flush before shutdown
async function awaitPendingFlush() {
  if (_runningFlush) {
    try { await _runningFlush; } catch {}
    _runningFlush = null;
  }
}

module.exports = { startExportSync, stopExportSync, flushExport, awaitPendingFlush, isExportSuppressed, _setUploader };
