'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const https = require('https');
const { resolveCcxrayHome, resolveLogsDir } = require('./paths');

const LOCK_STALE_MS = 300_000;
let timer = null;
let uploader = uploadToGcs;
let _cachedToken = null;
let _cachedExpiry = 0;

function exportBucket() {
  return (process.env.CCXRAY_EXPORT_GCS_BUCKET || '').trim();
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function tryAcquireLock(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lockPath = path.join(home, 'export.lock');
  const lock = { pid: process.pid, token: crypto.randomUUID(), acquiredAt: Date.now() };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
    return lock.token;
  } catch (err) {
    if (err.code !== 'EEXIST') return null;
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Date.now() - current.acquiredAt <= LOCK_STALE_MS && isPidAlive(current.pid)) return null;
      const stalePath = `${lockPath}.stale.${process.pid}`;
      try { fs.renameSync(lockPath, stalePath); fs.unlinkSync(stalePath); } catch { return null; }
      try {
        fs.writeFileSync(lockPath, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
        return lock.token;
      } catch { return null; }
    } catch { return null; }
  }
}

function releaseLock(home, token) {
  const lockPath = path.join(home, 'export.lock');
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current.token === token) fs.unlinkSync(lockPath);
  } catch {}
}

async function* readIndex() {
  const input = fs.createReadStream(path.join(resolveLogsDir(), 'index.ndjson'), { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      try { yield JSON.parse(line); } catch {}
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  } finally {
    rl.close();
    input.destroy();
  }
}

async function writeCursor(home, cursor) {
  const target = path.join(home, 'export-cursor.json');
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomUUID()}`;
  await fsp.writeFile(tmp, JSON.stringify(cursor), { mode: 0o600 });
  await fsp.rename(tmp, target);
}

async function readCursor(home) {
  try {
    const cursor = JSON.parse(await fsp.readFile(path.join(home, 'export-cursor.json'), 'utf8'));
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, 'lastId')) return null;
    if (!cursor.seq || typeof cursor.seq !== 'object') cursor.seq = {};
    return cursor;
  } catch { return null; }
}

function sanitizeName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.slice(0, 64);
  return trimmed.includes('@') ? null : trimmed;
}

function addMap(target, values, sanitize = false) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return;
  for (const [rawName, rawCount] of Object.entries(values)) {
    const name = sanitize ? sanitizeName(rawName) : rawName;
    const count = Number(rawCount);
    if (!name || !Number.isFinite(count)) continue;
    target[name] = (target[name] || 0) + count;
  }
}

function entryDate(entry) {
  if (typeof entry.localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.localDate)) return entry.localDate;
  const ms = Number(entry.receivedAt);
  if (entry.receivedAt != null && Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  return typeof entry.id === 'string' && /^\d{4}-\d{2}-\d{2}/.test(entry.id) ? entry.id.slice(0, 10) : null;
}

function costFact(entry) {
  if (typeof entry.cost === 'number') return { value: entry.cost, confidence: 'exact' };
  if (entry.cost?.cost == null) return { value: 0, confidence: 'unknown' };
  const confidence = entry.cost.confidence;
  if (confidence === 'fallback') return { value: Number(entry.cost.cost) || 0, confidence: 'fallback' };
  if (confidence === 'exact' || confidence === 'prefix' || confidence == null) {
    return { value: Number(entry.cost.cost) || 0, confidence: 'exact' };
  }
  return { value: Number(entry.cost.cost) || 0, confidence: 'unknown' };
}

function foldConfidence(values) {
  const kinds = new Set(values);
  return kinds.size === 1 ? values[0] : 'mixed';
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function makeDaily(dt, entry, agentId) {
  return {
    type: 'daily', _summary_schema_version: 1,
    agent_id: agentId,
    user_email: entry.userEmail || process.env.CCXRAY_USER_EMAIL || null,
    team: entry.team || process.env.CCXRAY_TEAM || null,
    dt, local_date: dt,
    tz: entry.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    provider: entry.provider || 'unknown',
    cost_total: 0, turn_count: 0, subagent_turn_count: 0,
    error_count: 0, credential_flag: false, compaction_count: 0,
    models: {}, tool_usage: {}, skill_usage: {}, tool_sources: {}, stop_reasons: {},
    tool_fail_count: 0, duplicate_tool_call_count: 0,
    context_utilization: { '0-40': 0, '40-80': 0, '80+': 0 },
    _sessions: new Set(), _confidences: [], _firstContexts: [],
    _sysHashes: new Set(), _toolsHashes: new Set(), _cwdRepos: new Set(),
  };
}

function makeSession(sid, dt, agentId) {
  return {
    type: 'session', _summary_schema_version: 1, agent_id: agentId, dt,
    session_id: sid, cost_total: 0, turn_count: 0,
    _confidences: [], _models: {}, _turns: [], _credential: false, _toolFails: 0,
  };
}

function aggregate(entries, agentId) {
  const dailyByDt = new Map();
  const sessionsBySid = new Map();
  for (const entry of entries) {
    const dt = entryDate(entry);
    const sid = entry.sessionId;
    if (!dt || !sid) continue;
    let daily = dailyByDt.get(dt);
    if (!daily) { daily = makeDaily(dt, entry, agentId); dailyByDt.set(dt, daily); }
    let session = sessionsBySid.get(sid);
    if (!session) { session = makeSession(sid, dt, agentId); sessionsBySid.set(sid, session); }

    const fact = costFact(entry);
    daily.cost_total += fact.value;
    daily._confidences.push(fact.confidence);
    daily.turn_count++;
    if (entry.isSubagent) daily.subagent_turn_count++;
    daily._sessions.add(sid);
    if (Number(entry.status) >= 400) daily.error_count++;
    if (entry.hasCredential === true) daily.credential_flag = true;
    if (entry.turnToolFail === true) daily.tool_fail_count++;
    if (entry.sysHash) daily._sysHashes.add(entry.sysHash);
    if (entry.toolsHash) daily._toolsHashes.add(entry.toolsHash);
    // ponytail: cwd is almost always the repo root; would need fs.existsSync to walk up, YAGNI
    if (entry.cwd) daily._cwdRepos.add(entry.cwd);
    if (entry.stopReason) daily.stop_reasons[entry.stopReason] = (daily.stop_reasons[entry.stopReason] || 0) + 1;
    // ADR 0018: turnToolCalls is per-turn for Anthropic; OpenAI toolCalls is already per-turn
    if (entry.turnToolCalls) addMap(daily.tool_usage, entry.turnToolCalls, true);
    else if (entry.provider === 'openai' && entry.toolCalls) addMap(daily.tool_usage, entry.toolCalls, true);
    addMap(daily.skill_usage, entry.skillCalls, true);
    // toolSources shape is {callId: 'local'|'network'|...}, fold values not keys
    if (entry.toolSources && typeof entry.toolSources === 'object') {
      for (const src of Object.values(entry.toolSources)) {
        if (typeof src === 'string') daily.tool_sources[src] = (daily.tool_sources[src] || 0) + 1;
      }
    }
    if (typeof entry.duplicateToolCalls === 'number') daily.duplicate_tool_call_count += entry.duplicateToolCalls;
    else if (entry.duplicateToolCalls && typeof entry.duplicateToolCalls === 'object') {
      daily.duplicate_tool_call_count += Object.values(entry.duplicateToolCalls)
        .reduce((sum, count) => sum + (Number(count) || 0), 0);
    }

    const usage = entry.usage || {};
    const modelName = entry.model || 'unknown';
    const model = daily.models[modelName] || (daily.models[modelName] = {
      turns: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0,
      thinking_turns: 0, beta1m_turns: 0, cost: 0,
    });
    model.turns++;
    model.input += Number(usage.input_tokens) || 0;
    model.output += Number(usage.output_tokens) || 0;
    model.cache_read += Number(usage.cache_read_input_tokens) || 0;
    model.cache_creation += Number(usage.cache_creation_input_tokens) || 0;
    if (entry.thinkingDuration != null) model.thinking_turns++;
    if (entry.beta1m === true) model.beta1m_turns++;
    model.cost += fact.value;

    const maxContext = Number(entry.maxContext);
    // Full context = input + cache_read + cache_creation (Anthropic input_tokens excludes cache)
    const fullCtx = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0)
      + (Number(usage.cache_creation_input_tokens) || 0);
    if (maxContext > 0 && fullCtx > 0) {
      const pct = fullCtx / maxContext * 100;
      daily.context_utilization[pct < 40 ? '0-40' : pct < 80 ? '40-80' : '80+']++;
    }

    session.cost_total += fact.value;
    session._confidences.push(fact.confidence);
    session.turn_count++;
    session._models[modelName] = (session._models[modelName] || 0) + 1;
    session._turns.push(entry);
    if (entry.hasCredential === true) session._credential = true;
    if (entry.turnToolFail === true) session._toolFails++;
  }

  for (const session of sessionsBySid.values()) {
    session._turns.sort((a, b) => (Number(a.receivedAt) || 0) - (Number(b.receivedAt) || 0));
    const first = session._turns[0];
    const firstMax = Number(first?.maxContext);
    const fu = first?.usage || {};
    const firstCtx = (Number(fu.input_tokens) || 0) + (Number(fu.cache_read_input_tokens) || 0) + (Number(fu.cache_creation_input_tokens) || 0);
    if (firstMax > 0 && firstCtx > 0) dailyByDt.get(session.dt)?._firstContexts.push(firstCtx / firstMax * 100);
    let lastMsgCount = null;
    for (const turn of session._turns) {
      const msgCount = Number(turn.msgCount);
      if (Number.isFinite(msgCount) && lastMsgCount != null && msgCount < lastMsgCount) {
        const day = dailyByDt.get(entryDate(turn));
        if (day) day.compaction_count++;
      }
      if (Number.isFinite(msgCount)) lastMsgCount = msgCount;
    }
  }
  return { dailyByDt, sessionsBySid };
}

function finishDaily(daily) {
  daily.cost_confidence = foldConfidence(daily._confidences);
  daily.session_count = daily._sessions.size;
  daily.tool_used_count = Object.keys(daily.tool_usage).length;
  // ponytail: tool_defined_count omitted, no data source in index; add when tool definition count is indexed
  daily.first_turn_context_pct_median = median(daily._firstContexts);
  daily.sys_hash_count = daily._sysHashes.size;
  daily.tools_hash_count = daily._toolsHashes.size;
  daily.cwd_repos = [...daily._cwdRepos].sort();
  for (const key of Object.keys(daily)) if (key.startsWith('_') && key !== '_summary_schema_version') delete daily[key];
  return daily;
}

function finishSession(session, daily) {
  const first = session._turns[0];
  const flags = [];
  if (session._credential) flags.push('credential_leak');
  if (session.turn_count > 200 && session.cost_total > 50) flags.push('runaway');
  if (session.cost_total > 25) flags.push('high_cost');
  if (session.turn_count && session._toolFails / session.turn_count > 0.5) flags.push('tool_fail_spike');
  session.cost_confidence = foldConfidence(session._confidences);
  session.model_primary = Object.entries(session._models)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'unknown';
  session.cwd = first?.cwd || null;
  session.flags = flags;
  session.summary_id = daily.summary_id;
  for (const key of Object.keys(session)) if (key.startsWith('_') && key !== '_summary_schema_version') delete session[key];
  return session;
}

async function flushExport() {
  const bucket = exportBucket();
  if (!bucket) return;
  const home = resolveCcxrayHome();
  const token = tryAcquireLock(home);
  if (!token) return;
  try {
    const cursor = await readCursor(home);
    if (!cursor) {
      let lastId = null;
      for await (const entry of readIndex()) if (entry.id) lastId = entry.id;
      await writeCursor(home, { lastId, partial: true, seq: {} });
      console.warn('[export-sync] initialized cursor at index tail; no historical data uploaded');
      return;
    }
    // last-writer-wins: scan the ENTIRE index to build full daily snapshots,
    // but only upload dates that contain entries newer than cursor.lastId.
    // ponytail: retains parsed index in memory; upgrade to streaming aggregation for >500MB indexes
    const all = [];
    let found = cursor.lastId == null;
    let hasNew = cursor.lastId == null;
    for await (const entry of readIndex()) {
      all.push(entry);
      if (!found && entry.id === cursor.lastId) { found = true; continue; }
      if (found) hasNew = true;
    }
    if (!found) {
      console.warn('[export-sync] cursor id was pruned; exporting from index start');
      hasNew = all.length > 0;
    }
    if (!hasNew || !all.length) return;
    const lastId = all.at(-1)?.id;
    const allow = new Set((process.env.CCXRAY_EXPORT_CONFIG_DIRS || '.claude').split(',').map(s => s.trim()).filter(Boolean));
    const { sessionMeta } = require('./store');
    const filtered = all.filter(entry => {
      const configDir = sessionMeta[entry.sessionId]?.configDir;
      // ponytail: unknown configDir → include (not exclude). After restart,
      // sessionMeta lacks configDir; excluding would permanently lose backlog rows.
      if (!configDir) return true;
      const base = configDir.split(/[\\/]/).filter(Boolean).at(-1);
      return allow.has(configDir) || allow.has(base);
    });
    const agentId = await getAgentId(home);
    const { dailyByDt, sessionsBySid } = aggregate(filtered, agentId);
    const dates = [...dailyByDt.keys()].sort();
    for (let i = 0; i < dates.length; i++) {
      const dt = dates[i];
      const daily = dailyByDt.get(dt);
      const seq = (Number(cursor.seq[dt]) || 0) + 1;
      cursor.seq[dt] = seq;
      daily.upload_seq = seq;
      daily.summary_id = `${agentId}:${dt}:${crypto.randomUUID().slice(0, 8)}`;
      daily.partial_day = cursor.partial === true && i === 0;
      const sessions = [...sessionsBySid.values()]
        .filter(session => session.dt === dt)
        .sort((a, b) => a.session_id.localeCompare(b.session_id))
        .map(session => finishSession(session, daily));
      const records = [finishDaily(daily), ...sessions];
      const prefix = process.env.CCXRAY_EXPORT_GCS_PREFIX || 'summaries/';
      const slashPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
      const objectName = `${slashPrefix}dt=${dt}/${agentId}--${seq}--${crypto.randomUUID().slice(0, 8)}.jsonl`;
      await uploader(bucket, objectName, records.map(JSON.stringify).join('\n') + '\n');
    }
    cursor.lastId = lastId;
    if (dates.length) cursor.partial = false;
    await writeCursor(home, cursor);
  } finally {
    releaseLock(home, token);
  }
}

function startExportSync() {
  if (!exportBucket() || timer) return;
  getAgentId(resolveCcxrayHome()).then(id => console.log(`[export-sync] agent_id=${id}`))
    .catch(e => console.error('[export-sync] agent id failed:', e.message));
  timer = setInterval(() => flushExport().catch(e => console.error('Export flush failed:', e.message)), 60_000);
  timer.unref();
}

function stopExportSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function getAgentId(home) {
  if (process.env.CCXRAY_AGENT_ID) return process.env.CCXRAY_AGENT_ID;
  const file = path.join(home, 'export-agent-id');
  try {
    const id = (await fsp.readFile(file, 'utf8')).trim();
    if (id) return id;
  } catch {}
  await fsp.mkdir(home, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  await fsp.writeFile(file, id + '\n', { flag: 'wx', mode: 0o600 }).catch(() => {});
  try { return (await fsp.readFile(file, 'utf8')).trim() || id; } catch { return id; }
}

function signJwt(keyFile) {
  const { client_email, private_key } = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), private_key).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GCS HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`));
          return;
        }
        resolve(responseBody);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function getAccessToken(keyFile) {
  if (_cachedToken && Date.now() < _cachedExpiry) return _cachedToken;
  const assertion = signJwt(keyFile);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
  }).toString();
  const raw = await request({
    hostname: 'oauth2.googleapis.com', port: 443, path: '/token', method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  const token = JSON.parse(raw);
  if (!token.access_token) throw new Error('GCS token response missing access_token');
  _cachedToken = token.access_token;
  _cachedExpiry = Date.now() + (Number(token.expires_in) || 3600) * 1000 - 60_000;
  return _cachedToken;
}

async function uploadToGcs(bucket, objectName, ndjsonBody) {
  const keyFile = process.env.CCXRAY_EXPORT_GCS_KEY_FILE;
  if (!keyFile) throw new Error('CCXRAY_EXPORT_GCS_KEY_FILE is required');
  const token = await getAccessToken(keyFile);
  await request({
    hostname: 'storage.googleapis.com', port: 443,
    path: `/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Length': Buffer.byteLength(ndjsonBody),
      Authorization: `Bearer ${token}`,
    },
  }, ndjsonBody);
}

function _setUploader(fn) { uploader = fn || uploadToGcs; }

module.exports = { startExportSync, stopExportSync, flushExport, _setUploader };
