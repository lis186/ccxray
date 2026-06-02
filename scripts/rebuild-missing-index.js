#!/usr/bin/env node
'use strict';

// One-time script: recover missing index entries via delta chain.
//
// Finds _req.json files not in index.ndjson, follows prevId chains to
// an indexed ancestor, inherits sessionId + cwd, writes a patch file.
//
// Usage:
//   node scripts/rebuild-missing-index.js                # dry-run (report only)
//   node scripts/rebuild-missing-index.js --apply        # write index-patch.ndjson
//   cat ~/.ccxray/logs/index-patch.ndjson >> ~/.ccxray/logs/index.ndjson
//   # then restart hub

const fs = require('fs');
const path = require('path');

const CCXRAY_HOME = process.env.CCXRAY_HOME || path.join(require('os').homedir(), '.ccxray');
const logDir = path.join(CCXRAY_HOME, 'logs');
const indexPath = path.join(logDir, 'index.ndjson');
const patchPath = path.join(logDir, 'index-patch.ndjson');
const apply = process.argv.includes('--apply');

// 1. Parse existing index
const indexData = {};
const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n');
for (const line of lines) {
  try { const o = JSON.parse(line); indexData[o.id] = o; } catch {}
}
console.log(`Index: ${Object.keys(indexData).length} entries`);

// 2. Find missing entries (on disk but not in index)
const reqFiles = fs.readdirSync(logDir).filter(f => f.endsWith('_req.json'));
const resSet = new Set(fs.readdirSync(logDir).filter(f => f.endsWith('_res.json')).map(f => f.replace('_res.json', '')));
const missing = reqFiles.map(f => f.replace('_req.json', '')).filter(id => !indexData[id]);
console.log(`Disk _req.json: ${reqFiles.length}`);
console.log(`Missing from index: ${missing.length}`);

// 3. For each missing entry, try to follow prevId chain to an indexed ancestor
const recovered = [];
const sessionCounts = {};

for (const id of missing) {
  let req;
  try { req = JSON.parse(fs.readFileSync(path.join(logDir, id + '_req.json'), 'utf8')); } catch { continue; }
  if (!req.prevId) continue;

  // Follow chain
  let cur = req.prevId;
  let ancestor = null;
  for (let depth = 0; depth < 50 && cur; depth++) {
    if (indexData[cur]) { ancestor = indexData[cur]; break; }
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(logDir, cur + '_req.json'), 'utf8'));
      cur = prev.prevId || null;
    } catch { cur = null; }
  }
  if (!ancestor) continue;

  // Build index line from req + ancestor
  const ts = id.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}).*/, '$2:$3:$4');
  const msgCount = Array.isArray(req.messages) ? req.messages.length : 0;

  // Try to read _res.json for usage (rare — only ~1/716 entries have it)
  let usage = null, cost = null, stopReason = null, elapsed = null, status = 200;
  if (resSet.has(id)) {
    try {
      const resRaw = fs.readFileSync(path.join(logDir, id + '_res.json'), 'utf8');
      const res = JSON.parse(resRaw);
      if (Array.isArray(res)) {
        const msgStart = res.find(e => e.type === 'message_start');
        const msgDelta = res.find(e => e.type === 'message_delta');
        const u = msgStart?.message?.usage;
        if (u) {
          usage = {
            input_tokens: u.input_tokens || 0,
            output_tokens: msgDelta?.usage?.output_tokens || 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
            cache_read_input_tokens: u.cache_read_input_tokens || 0,
          };
        }
        stopReason = msgDelta?.delta?.stop_reason || null;
      }
    } catch {}
  }

  const entry = {
    id,
    ts,
    sessionId: ancestor.sessionId,
    provider: 'anthropic',
    agent: ancestor.agent || 'claude',
    model: req.model || ancestor.model || 'unknown',
    msgCount,
    toolCount: 0,
    toolCalls: {},
    isSubagent: ancestor.isSubagent || false,
    sessionInferred: ancestor.sessionInferred || false,
    cwd: ancestor.cwd || null,
    isSSE: true,
    usage,
    cost,
    maxContext: null,
    stopReason,
    title: null,
    thinkingDuration: null,
    toolFail: false,
    elapsed,
    status,
    receivedAt: null,
    sysHash: req.sysHash || null,
    toolsHash: req.toolsHash || null,
    coreHash: null,
    thinkingStripped: false,
    hasCredential: false,
  };

  recovered.push(entry);
  const sid = ancestor.sessionId || 'unknown';
  sessionCounts[sid] = (sessionCounts[sid] || 0) + 1;
}

// 4. Report
console.log(`\nRecovered: ${recovered.length} entries`);
console.log('Sessions:');
for (const [sid, cnt] of Object.entries(sessionCounts).sort((a, b) => b[1] - a[1])) {
  const cwd = recovered.find(e => e.sessionId === sid)?.cwd || '(no cwd)';
  console.log(`  ${sid.slice(0, 16)}... : ${cnt} entries → ${cwd}`);
}

const withRes = recovered.filter(e => e.usage !== null).length;
console.log(`\nWith response data: ${withRes}`);
console.log(`Without response data (ghost turns): ${recovered.length - withRes}`);

if (apply) {
  const patch = recovered.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(patchPath, patch);
  console.log(`\nWrote ${patchPath}`);
  console.log(`Next: cat ${patchPath} >> ${indexPath}`);
  console.log('Then restart hub to pick up new entries.');
} else {
  console.log(`\nDry run. Use --apply to write ${patchPath}`);
}
