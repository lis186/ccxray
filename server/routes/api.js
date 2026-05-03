'use strict';

const config = require('../config');
const store = require('../store');
const { summarizeEntry } = require('../sse-broadcast');
const { loadEntryReqRes } = require('../restore');
const { tokenizeRequest } = require('../helpers');
const { computeBlockDiff } = require('../system-prompt');
const { getPlanConfig } = require('../plans');
const { getEffectivePlan } = require('../plan-detector');
const forward = require('../forward');
const { readSettings, writeSettings } = require('../settings');
const { SENTINEL_SESSIONS, SENTINEL_PROJECTS } = require('../helpers');

const AUTO_COMPACT_PCT = 0.835;

function computeSettings() {
  const recentUsages = store.entries
    .filter(e => e && e.usage)
    .slice(-200)
    .map(e => e.usage);
  const { plan, source, confidence } = getEffectivePlan({ recentUsages });
  const cfg = getPlanConfig(plan);
  return {
    plan,
    label: cfg.label,
    source,
    confidence,
    cacheTtlMs: cfg.cacheTtlMs,
    tokens5h: cfg.tokens5h,
    monthlyUSD: cfg.monthlyUSD,
    autoCompactPct: AUTO_COMPACT_PCT,
  };
}

function handleApiRoutes(clientReq, clientRes) {
  if (clientReq.url === '/_api/entries') {
    const entries = store.entries.map(summarizeEntry);
    const sessionTitles = Object.fromEntries(
      Object.entries(store.sessionMeta).filter(([, m]) => m.title).map(([sid, m]) => [sid, m.title])
    );
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ entries, sessionTitles }));
    return true;
  }

  if (clientReq.method === 'GET' && clientReq.url === '/_api/settings') {
    const s = readSettings();
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ ...computeSettings(), statusLine: s.statusLine }));
    return true;
  }

  if (clientReq.url.startsWith('/_api/sysprompt/versions')) {
    const urlParams = new URLSearchParams(clientReq.url.split('?')[1] || '');
    const filterAgent = urlParams.get('agent') || null;
    const allAgents = [...new Set([...store.versionIndex.values()].map(v => v.agentKey))].sort();
    const vEntries = [...store.versionIndex.values()]
      .filter(v => !filterAgent || v.agentKey === filterAgent)
      .sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || '') || b.version.localeCompare(a.version));
    const versions = vEntries.map(({ version, reqId, b2Len, coreLen, coreHash, firstSeen, agentKey, agentLabel }) => ({ version, reqId, b2Len, coreLen, coreHash, firstSeen, agentKey, agentLabel }));
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ versions, agents: allAgents.map(k => ({ key: k, label: store.versionIndex.get([...store.versionIndex.keys()].find(ik => ik.startsWith(k + '::')))?.agentLabel || k })) }));
    return true;
  }

  const diffMatch = clientReq.url.match(/^\/_api\/sysprompt\/diff\?(.+)$/);
  if (diffMatch) {
    const params = new URLSearchParams(diffMatch[1]);
    const verA = params.get('a'), verB = params.get('b');
    const agentKey = params.get('agent') || 'orchestrator';
    // Look up by coreHash (new key format) with fallback to legacy version key
    const lookup = (v) => store.versionIndex.get(`${agentKey}::${v}`) || [...store.versionIndex.values()].find(e => e.agentKey === agentKey && e.version === v);
    const entA = lookup(verA), entB = lookup(verB);
    if (!entA || !entB) {
      clientRes.writeHead(404, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'version not found' }));
      return true;
    }
    const loadB2 = async (ent) => {
      // Try reqId first, fallback to shared file
      if (ent.reqId) {
        try {
          const raw = await config.storage.read(ent.reqId, '_req.json');
          const body = JSON.parse(raw);
          return Array.isArray(body.system) && body.system[2] ? (body.system[2].text || '') : '';
        } catch {}
      }
      if (ent.sharedFile) {
        try {
          const sys = JSON.parse(await config.storage.readShared(ent.sharedFile));
          return Array.isArray(sys) && sys[2] ? (sys[2].text || '') : '';
        } catch {}
      }
      return '';
    };
    (async () => {
      const [b2A, b2B] = await Promise.all([loadB2(entA), loadB2(entB)]);
      const blockDiff = computeBlockDiff(b2A, b2B, verA, verB);
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        a: { version: verA, b2Len: entA.b2Len },
        b: { version: verB, b2Len: entB.b2Len },
        blockDiff
      }));
    })().catch(e => {
      if (!clientRes.headersSent) clientRes.writeHead(500);
      clientRes.end(JSON.stringify({ error: e.message }));
    });
    return true;
  }

  // Full entry data (req + res) — lazy loaded
  const entryMatch = clientReq.url.match(/^\/_api\/entry\/(.+)$/);
  if (entryMatch) {
    const id = decodeURIComponent(entryMatch[1]);
    const entry = store.entries.find(e => e.id === id);
    if (!entry) { clientRes.writeHead(404); clientRes.end('Not found'); return true; }
    (async () => {
      await loadEntryReqRes(entry);
      const snapshot = { req: entry.req, res: entry.res, receivedAt: entry.receivedAt || null };
      if (entry.elapsed === '?') { entry.req = null; entry.res = null; entry._loaded = false; }
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify(snapshot));
    })().catch(e => {
      if (!clientRes.headersSent) clientRes.writeHead(500);
      clientRes.end(JSON.stringify({ error: e.message }));
    });
    return true;
  }

  // Lazy tokenization endpoint
  const tokMatch = clientReq.url.match(/^\/_api\/tokens\/(.+)$/);
  if (tokMatch) {
    const id = decodeURIComponent(tokMatch[1]);
    const entry = store.entries.find(e => e.id === id);
    if (!entry) { clientRes.writeHead(404); clientRes.end('Not found'); return true; }
    (async () => {
      if (!entry.tokens) {
        await loadEntryReqRes(entry);
        if (entry.req) entry.tokens = tokenizeRequest(entry.req);
        if (entry.elapsed === '?') { entry.req = null; entry.res = null; entry._loaded = false; }
      }
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify(entry.tokens));
    })().catch(e => {
      if (!clientRes.headersSent) clientRes.writeHead(500);
      clientRes.end(JSON.stringify({ error: e.message }));
    });
    return true;
  }

  if (clientReq.method === 'GET' && clientReq.url === '/_api/stars') {
    const s = readSettings();
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      projects: s.starredProjects || [],
      sessions: s.starredSessions || [],
      turns: s.starredTurns || [],
    }));
    return true;
  }

  if (clientReq.method === 'POST' && clientReq.url === '/_api/stars') {
    let body = '';
    clientReq.on('data', c => { body += c; });
    clientReq.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        clientRes.writeHead(400, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const kind = payload && payload.kind;
      const id = payload && payload.id;
      const starred = payload && payload.starred;
      const KIND_TO_KEY = { project: 'starredProjects', session: 'starredSessions', turn: 'starredTurns' };
      if (!Object.prototype.hasOwnProperty.call(KIND_TO_KEY, kind) || typeof id !== 'string' || !id || typeof starred !== 'boolean') {
        clientRes.writeHead(400, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'expected { kind: project|session|turn, id: string, starred: boolean }' }));
        return;
      }
      // Sentinel guard: catch-all session/project ids must not become starred at
      // their own level. Star individual turns inside instead. (Frontend disables
      // the button; this is the API-level backstop for direct callers and migration.)
      if ((kind === 'session' && SENTINEL_SESSIONS.has(id)) ||
          (kind === 'project' && SENTINEL_PROJECTS.has(id))) {
        clientRes.writeHead(400, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'cannot star sentinel ' + kind + ' "' + id + '" — star individual turns inside instead' }));
        return;
      }
      const current = readSettings();
      const key = KIND_TO_KEY[kind];
      const set = new Set(current[key] || []);
      if (starred) set.add(id); else set.delete(id);
      const updated = { ...current, [key]: [...set] };
      writeSettings(updated);
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        projects: updated.starredProjects || [],
        sessions: updated.starredSessions || [],
        turns: updated.starredTurns || [],
      }));
    });
    return true;
  }

  if (clientReq.method === 'POST' && clientReq.url === '/_api/settings')
  {
    let body = '';
    clientReq.on('data', c => { body += c; });
    clientReq.on('end', () =>
    {
      try
      {
        const patch = JSON.parse(body);
        const current = readSettings();
        const updated = { ...current };
        if (typeof patch.statusLine === 'boolean')
        {
          updated.statusLine = patch.statusLine;
          forward.setStatusLineEnabled(patch.statusLine);
          console.log(`\x1b[90m   Context HUD: ${patch.statusLine ? 'enabled' : 'disabled'} (toggled from dashboard)\x1b[0m`);
        }
        writeSettings(updated);
        clientRes.writeHead(200, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify(updated));
      }
      catch
      {
        clientRes.writeHead(400);
        clientRes.end();
      }
    });
    return true;
  }

  return false;
}

module.exports = { handleApiRoutes, computeSettings };
