'use strict';

const config = require('../config');
const store = require('../store');
const { summarizeEntry } = require('../sse-broadcast');
const { loadEntryReqRes } = require('../restore');
const { tokenizeRequest } = require('../helpers');
const { computeBlockDiff } = require('../system-prompt');

function handleApiRoutes(clientReq, clientRes) {
  if (clientReq.url === '/_api/entries') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify(store.entries.map(summarizeEntry)));
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

  return false;
}

module.exports = { handleApiRoutes };
