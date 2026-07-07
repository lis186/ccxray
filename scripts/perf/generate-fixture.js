#!/usr/bin/env node
'use strict';

/**
 * Synthetic CCXRAY_HOME generator for perf baseline work (#183).
 *
 * Usage:
 *   node scripts/perf/generate-fixture.js [--entries 5000] [--output /tmp/perf-home]
 *
 * Prints the output directory path on success.
 *
 * Fixture shapes derived from live module analysis (2026-07-07):
 *   Index entry fields: server/store.js buildEntryFields() + server/forward.js:726-743
 *   Delta _req.json:    server/restore.js:41-62 (prevId, msgOffset format)
 *   SSE _res.json:      server/sse-broadcast.js:7-48 (content_block_delta events)
 *   Field distributions: server/config.js MAX_ENTRIES=5000, typical session 20-50 turns
 */

const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_ENTRIES = 5000;
const DELTA_CHAIN_LENGTH = 8;  // 1 anchor + 7 deltas
const MSGS_PER_HOP = 4;        // each hop adds 4 messages; final turn = 32 messages
const MSG_SIZE = 500;           // chars per message
const NUM_PROJECTS = 10;
const NUM_SESSIONS = 50;
const BATCH_SIZE = 200;

// ── ID helpers ──────────────────────────────────────────────────────

function formatId(ms) {
  const d = new Date(ms);
  const pad2 = n => String(n).padStart(2, '0');
  const pad3 = n => String(n).padStart(3, '0');
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}-${pad2(d.getUTCSeconds())}-${pad3(d.getUTCMilliseconds())}`
  );
}

function shortHash(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 6);
}

// ── Filler content ──────────────────────────────────────────────────

const WORDS = [
  'system', 'prompt', 'tool', 'context', 'message', 'response',
  'assistant', 'user', 'code', 'model', 'request', 'token',
  'session', 'agent', 'task', 'result', 'data', 'error',
];

function filler(seed, length) {
  let s = '';
  let i = seed;
  while (s.length < length) {
    s += WORDS[i % WORDS.length] + ' ';
    i++;
  }
  return s.slice(0, length);
}

function makeMessages(startIdx, count) {
  return Array.from({ length: count }, (_, i) => ({
    role: (startIdx + i) % 2 === 0 ? 'user' : 'assistant',
    content: filler((startIdx + i) * 7, MSG_SIZE),
  }));
}

// ── Entry builders ──────────────────────────────────────────────────

function makeIndexEntry(id, sessionId, cwd, turnNum, msgCount, toolCount, hashes) {
  const { sysHash, toolsHash, coreHash } = hashes;
  const agentKey = `claude-code::${coreHash}`;
  const receivedAt = new Date(id.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})/, 'T$1:$2:$3.$4Z')).getTime();
  return {
    id,
    ts: id.slice(11, 19).replace(/-/g, ':'),
    sessionId,
    provider: 'anthropic',
    agent: 'claude-code',
    model: 'claude-sonnet-4-6',
    msgCount,
    toolCount,
    toolCalls: toolCount > 0 ? { Bash: toolCount } : {},
    isSubagent: false,
    sessionInferred: false,
    cwd,
    isSSE: true,
    usage: {
      input_tokens: msgCount * 120,
      output_tokens: 80,
      cache_creation_input_tokens: Math.floor(msgCount * 30),
      cache_read_input_tokens: Math.floor(msgCount * 60),
    },
    cost: { cost: 0.05 },
    maxContext: 200000,
    stopReason: 'end_turn',
    title: `Turn ${turnNum}`,
    receivedAt,
    elapsed: 1200 + Math.floor(Math.random() * 800),
    sysHash,
    toolsHash,
    coreHash,
    agentKey,
  };
}

function makeAnchorReq(msgCount, hashes) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    messages: makeMessages(0, msgCount),
    sysHash: hashes.sysHash,
    toolsHash: hashes.toolsHash,
  };
}

function makeDeltaReq(prevId, msgOffset, newMsgCount, msgStart, hashes) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    prevId,
    msgOffset,
    messages: makeMessages(msgStart, newMsgCount),
    sysHash: hashes.sysHash,
    toolsHash: hashes.toolsHash,
  };
}

function makeFullReq(msgCount, seed, hashes) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    messages: makeMessages(seed, msgCount),
    sysHash: hashes.sysHash,
    toolsHash: hashes.toolsHash,
  };
}

function makeRes(outputTokens) {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: filler(42, 200) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } },
  ];
}

// ── Main generator ──────────────────────────────────────────────────

async function generate({ entries: numEntries = DEFAULT_ENTRIES, output } = {}) {
  const outputDir = output || path.join(os.tmpdir(), `ccxray-perf-${Date.now()}`);
  const logsDir = path.join(outputDir, 'logs');
  const sharedDir = path.join(logsDir, 'shared');

  await fsp.mkdir(sharedDir, { recursive: true });

  const projects = Array.from({ length: NUM_PROJECTS }, (_, i) => `/mock/project-${i + 1}`);
  const sessions = Array.from({ length: NUM_SESSIONS }, (_, i) => ({
    sessionId: `session-${String(i).padStart(4, '0')}`,
    cwd: projects[i % NUM_PROJECTS],
    sysHash: shortHash(i),
    toolsHash: shortHash(i + 100),
    coreHash: shortHash(i + 200),
  }));

  // Shared hashes used by the delta chain
  const chainHashes = {
    sysHash: shortHash(9999),
    toolsHash: shortHash(9998),
    coreHash: shortHash(9997),
  };

  // ponytail: use recent dates so server's RESTORE_DAYS filter doesn't discard them
  let baseMs = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago
  const allEntries = [];  // { id, indexLine, reqJson, resJson }

  // ── 1. Delta chain (8 hops) ─────────────────────────────────────
  const deltaIds = [];
  const DELTA_SESSION = 'delta-chain-session-0001';

  for (let hop = 0; hop < DELTA_CHAIN_LENGTH; hop++) {
    const id = formatId(baseMs);
    baseMs += 1000;
    deltaIds.push(id);

    const totalMsgs = (hop + 1) * MSGS_PER_HOP;
    const msgOffset = hop * MSGS_PER_HOP;
    const msgStart = msgOffset;  // so messages don't repeat content

    let reqJson;
    if (hop === 0) {
      reqJson = makeAnchorReq(MSGS_PER_HOP, chainHashes);
    } else {
      reqJson = makeDeltaReq(deltaIds[hop - 1], msgOffset, MSGS_PER_HOP, msgStart, chainHashes);
    }

    const indexEntry = makeIndexEntry(id, DELTA_SESSION, '/mock/delta-project', hop + 1, totalMsgs, 0, chainHashes);
    allEntries.push({
      id,
      indexLine: JSON.stringify(indexEntry),
      reqJson: JSON.stringify(reqJson),
      resJson: JSON.stringify(makeRes(80 + hop * 10)),
    });
  }

  // ── 2. Bulk entries ─────────────────────────────────────────────
  const remaining = Math.max(0, numEntries - DELTA_CHAIN_LENGTH);
  for (let i = 0; i < remaining; i++) {
    const id = formatId(baseMs);
    baseMs += 1000;

    const sess = sessions[i % sessions.length];
    const msgCount = 2 + (i % 49);   // 2-50 messages
    const toolCount = i % 5;

    const indexEntry = makeIndexEntry(id, sess.sessionId, sess.cwd, i + 1, msgCount, toolCount, sess);
    const reqJson = JSON.stringify(makeFullReq(msgCount, i * 3, sess));
    const resJson = JSON.stringify(makeRes(60 + (i % 50)));

    allEntries.push({ id, indexLine: JSON.stringify(indexEntry), reqJson, resJson });
  }

  // ── 3. Write in batches ─────────────────────────────────────────
  const indexLines = [];

  for (let i = 0; i < allEntries.length; i += BATCH_SIZE) {
    const batch = allEntries.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(e =>
      Promise.all([
        fsp.writeFile(path.join(logsDir, e.id + '_req.json'), e.reqJson),
        fsp.writeFile(path.join(logsDir, e.id + '_res.json'), e.resJson),
      ])
    ));
    for (const e of batch) indexLines.push(e.indexLine);
  }

  await fsp.writeFile(path.join(logsDir, 'index.ndjson'), indexLines.join('\n') + '\n');

  return { outputDir, logsDir, entryCount: allEntries.length, deltaChainIds: deltaIds, provenance: 'module-analysis-2026-07-07' };
}

// ── CLI entry point ─────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let numEntries = DEFAULT_ENTRIES;
  let output = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--entries' && args[i + 1]) {
      numEntries = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[i + 1];
      i++;
    }
  }

  generate({ entries: numEntries, output })
    .then(({ outputDir, entryCount, deltaChainIds }) => {
      process.stdout.write(outputDir + '\n');
      process.stderr.write(`Generated ${entryCount} entries (delta chain: ${deltaChainIds.length} hops)\n`);
      process.stderr.write(`Last delta entry: ${deltaChainIds[deltaChainIds.length - 1]}\n`);
    })
    .catch(err => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { generate };
