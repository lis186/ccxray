'use strict';

const config = require('../config');
const store = require('../store');
const { summarizeEntry } = require('../sse-broadcast');
const { loadEntryReqRes } = require('../restore');
const { tokenizeRequest } = require('../helpers');
const { computeBlockDiff } = require('../system-prompt');
const { getPlanConfig } = require('../plans');
const { getEffectivePlan } = require('../plan-detector');
const { UPSTREAM_PROFILES } = require('../providers');
const forward = require('../forward');
const { readSettings, writeSettings, serializeStars } = require('../settings');
const { SENTINEL_SESSIONS, SENTINEL_PROJECTS } = require('../helpers');
const sessionIdx = require('../session-index');

const AUTO_COMPACT_PCT = 0.835;

function computeSettings() {
  const recentUsages = store.entries
    .filter(e => e && e.usage)
    .slice(-200)
    .map(e => e.usage);
  const { plan, source, confidence } = getEffectivePlan({ recentUsages });
  const cfg = getPlanConfig(plan);

  const fromMeta = Object.values(store.sessionMeta).map(m => m.provider).filter(Boolean);
  const fromEntries = store.entries.map(e => e.provider).filter(Boolean);
  const visibleProviders = [...new Set([...fromMeta, ...fromEntries])];

  const providerProfiles = Object.fromEntries(
    Object.entries(UPSTREAM_PROFILES).map(([k, v]) => [k, { cache: v.cache, label: v.label, resume: v.resume }])
  );

  return {
    plan,
    label: cfg.label,
    source,
    confidence,
    cacheTtlMs: cfg.cacheTtlMs,
    tokens5h: cfg.tokens5h,
    monthlyUSD: cfg.monthlyUSD,
    autoCompactPct: AUTO_COMPACT_PCT,
    visibleProviders,
    providerProfiles,
  };
}

function handleApiRoutes(clientReq, clientRes) {
  const pathname = clientReq.url.split('?')[0];

  if (pathname === '/_api/entries') {
    const entries = store.entries.map(summarizeEntry);
    const sessionTitles = Object.fromEntries(
      Object.entries(store.sessionMeta).filter(([, m]) => m.title).map(([sid, m]) => [sid, m.title])
    );
    const restore = { ...store.restoreState, entryCount: store.entries.length };
    clientRes.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    clientRes.end(JSON.stringify({ entries, sessionTitles, restore }));
    return true;
  }

  if (pathname === '/_api/sessions') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    clientRes.end(JSON.stringify({ sessions: sessionIdx.getAll() }));
    return true;
  }

  if (clientReq.method === 'GET' && pathname === '/_api/settings') {
    const s = readSettings();
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ ...computeSettings(), statusLine: s.statusLine, hiddenProjects: s.hiddenProjects }));
    return true;
  }

  if (clientReq.url.startsWith('/_api/sysprompt/versions')) {
    const urlParams = new URLSearchParams(clientReq.url.split('?')[1] || '');
    const filterAgent = urlParams.get('agent') || null;
    const allAgents = [...new Set([...store.versionIndex.values()].map(v => v.agentKey))].sort();
    const sessionsByHash = {};
    for (const e of store.entries) {
      if (!e.coreHash || !e.sessionId) continue;
      if (!sessionsByHash[e.coreHash]) sessionsByHash[e.coreHash] = new Set();
      sessionsByHash[e.coreHash].add(e.sessionId);
    }
    const vEntries = [...store.versionIndex.values()]
      .filter(v => !filterAgent || v.agentKey === filterAgent)
      .sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || '') || b.version.localeCompare(a.version));
    const versions = vEntries.map(({ version, reqId, b2Len, coreLen, coreHash, firstSeen, agentKey, agentLabel, provider }) => ({
      version, reqId, b2Len, coreLen, coreHash, firstSeen, agentKey, agentLabel,
      provider: provider || 'anthropic',
      sessionCount: sessionsByHash[coreHash] ? sessionsByHash[coreHash].size : 0,
    }));
    const agentInfo = allAgents.map(k => {
      const entry = store.versionIndex.get([...store.versionIndex.keys()].find(ik => ik.startsWith(k + '::')));
      return { key: k, label: entry?.agentLabel || k, provider: entry?.provider || 'anthropic' };
    });
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ versions, agents: agentInfo }));
    return true;
  }

  if (clientReq.url.startsWith('/_api/tools-diff')) {
    const params = new URLSearchParams(clientReq.url.split('?')[1] || '');
    const hashA = params.get('a'), hashB = params.get('b');
    const HASH_RE = /^[0-9a-f]{12}$/i;
    if (!hashA || !hashB || !HASH_RE.test(hashA) || !HASH_RE.test(hashB)) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'missing a or b param' }));
      return true;
    }
    const readTools = async (h) => {
      for (const prefix of ['tools_', 'openai_tools_']) {
        try { return JSON.parse(await config.storage.readShared(`${prefix}${h}.json`)); } catch {}
      }
      return null;
    };
    const extractNames = (tools) => (tools || []).map(t => t.name || t.function?.name).filter(Boolean);
    Promise.all([readTools(hashA), readTools(hashB)]).then(([a, b]) => {
      if (!a && !b) { clientRes.writeHead(404, { 'Content-Type': 'application/json' }); clientRes.end(JSON.stringify({ error: 'shared files not found' })); return; }
      const namesA = new Set(extractNames(a)), namesB = new Set(extractNames(b));
      const added = [...namesB].filter(n => !namesA.has(n));
      const removed = [...namesA].filter(n => !namesB.has(n));
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ added, removed }));
    }).catch(() => { clientRes.writeHead(500, { 'Content-Type': 'application/json' }); clientRes.end(JSON.stringify({ error: 'internal error' })); });
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
          if (typeof sys === 'string') return sys;
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
  const entryMatch = pathname.match(/^\/_api\/entry\/(.+)$/);
  if (entryMatch) {
    const id = decodeURIComponent(entryMatch[1]);
    const entry = store.getEntryById(id);
    if (!entry) { clientRes.writeHead(404); clientRes.end('Not found'); return true; }
    (async () => {
      await loadEntryReqRes(entry);
      const snapshot = { req: entry.req, res: entry.res, receivedAt: entry.receivedAt || null, toolSources: entry.toolSources || null };
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
  const tokMatch = pathname.match(/^\/_api\/tokens\/(.+)$/);
  if (tokMatch) {
    const id = decodeURIComponent(tokMatch[1]);
    const entry = store.getEntryById(id);
    if (!entry) { clientRes.writeHead(404); clientRes.end('Not found'); return true; }
    (async () => {
      if (!entry.tokens) {
        await loadEntryReqRes(entry);
        if (entry.req) entry.tokens = tokenizeRequest(entry.req);
        if (entry.elapsed === '?') { entry.req = null; entry.res = null; entry._loaded = false; }
      }
      store.propagateLoadedSkills(entry, entry.sessionId);
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify(entry.tokens));
    })().catch(e => {
      if (!clientRes.headersSent) clientRes.writeHead(500);
      clientRes.end(JSON.stringify({ error: e.message }));
    });
    return true;
  }

  if (clientReq.method === 'GET' && pathname === '/_api/stars') {
    const s = readSettings();
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(serializeStars(s)));
    return true;
  }

  if (clientReq.method === 'POST' && pathname === '/_api/stars') {
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
      const KIND_TO_KEY = { project: 'starredProjects', session: 'starredSessions', turn: 'starredTurns', step: 'starredSteps' };
      if (!Object.prototype.hasOwnProperty.call(KIND_TO_KEY, kind) || typeof id !== 'string' || !id || typeof starred !== 'boolean') {
        clientRes.writeHead(400, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'expected { kind: project|session|turn|step, id: string, starred: boolean }' }));
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
      clientRes.end(JSON.stringify(serializeStars(updated)));
    });
    return true;
  }

  if (clientReq.method === 'POST' && pathname === '/_api/settings')
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

  if (clientReq.method === 'POST' && pathname === '/api/import/rescan') {
    const { scanAndImport } = require('../importer');
    scanAndImport().then(result => {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify(result));
    }).catch(err => {
      clientRes.writeHead(500, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  return false;
}

module.exports = { handleApiRoutes, computeSettings };
