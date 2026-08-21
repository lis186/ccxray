'use strict';

// Synthetic fixtures for README/docs screenshots — no real user data, no real
// paths. Writes an index.ndjson (plus a few _req/_res pairs and a stars entry)
// into $CCXRAY_HOME/logs, then prints the server command to view it.
//
//   CCXRAY_HOME=$(mktemp -d) node scripts/generate-screenshot-fixtures.js
//
// Index-line fields are kept in step with INDEX_FIELDS in server/entry.js.
// `method`/`url` are extra: the real write path whitelists INDEX_FIELDS so live
// lines never carry them, but no consumer reads them either — harmless.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.CCXRAY_HOME || path.join(require('os').homedir(), '.ccxray');
const LOGS = path.join(HOME, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// ── helpers ──

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function uuid() { return [8,4,4,4,12].map(n => crypto.randomBytes(n).toString('hex').slice(0, n)).join('-'); }
function hash() { return crypto.randomBytes(6).toString('hex'); }

// Upstream response id — the read-time merge key (docs/decisions/0012-*). Every
// entry needs its own, and the showcase _res.json reuses it so the fixture's
// message_start id matches its index line.
function msgId() { return 'msg_' + crypto.randomBytes(12).toString('hex'); }

const SKILLS = ['code-review', 'tdd', 'git-commit', 'research'];

function makeId(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// Opus pricing per million tokens
const RATES = { input: 15, output: 75, cache_create: 18.75, cache_read: 1.5 };
function cost(u) {
  return ((u.input_tokens || 0) * RATES.input +
          (u.output_tokens || 0) * RATES.output +
          (u.cache_creation_input_tokens || 0) * RATES.cache_create +
          (u.cache_read_input_tokens || 0) * RATES.cache_read) / 1e6;
}

const entries = [];
const now = Date.now();

// ══════════════════════════════════════════════════════════════════════════════
//  SHOWCASE SESSION — 50 main turns with realistic context/cache progression
//  Modeled after real session 59bea70a (312 main turns over 110 min)
// ══════════════════════════════════════════════════════════════════════════════

const showcaseSessionId = uuid();
const showcaseStart = now - 3 * 86400000 + 8 * 3600000; // 3 days ago, morning
const showcaseSysHash = hash();
const showcaseToolsHash = hash();
const showcaseCoreHash = hash();
const showcaseConvId = hash() + hash();
const SHOWCASE_CWD = '/home/dev/ecommerce-api';
const MAX_CTX = 1000000;

// System prompt base size ≈ 140K tokens (realistic for Claude Code with CLAUDE.md)
const SYS_PROMPT_TOKENS = 139000;

let cacheBase = 0;     // how much is cached (grows as system prompt + conversation get cached)
let msgCount = 0;
let cumulativeInput = 0;
let cacheExpired = false;

// Accumulated tool counts across the session
const sessionTools = { Bash: 0, Read: 0, Edit: 0, Write: 0, Agent: 0, Grep: 0, Glob: 0, WebSearch: 0, Skill: 0, Monitor: 0, AskUserQuestion: 0 };

function addMainTurn(turnIdx, receivedAt, opts = {}) {
  msgCount += 2;
  const isFirst = turnIdx === 0;

  // Context builds progressively
  // Fresh input per turn: varies (tool results, user messages)
  const freshInput = isFirst ? randInt(200, 500) : randInt(2, 500);
  const outputTokens = randInt(200, 4000);

  let cache_read, cache_create;

  if (isFirst || cacheExpired) {
    // First turn or cache expired: nothing cached, create everything
    cache_read = 0;
    cache_create = SYS_PROMPT_TOKENS + cumulativeInput;
    cacheBase = cache_create;
    cacheExpired = false;
  } else {
    // Subsequent: read ~98% from cache, small creation for new content
    cache_read = cacheBase + randInt(-500, 500);
    if (cache_read < 0) cache_read = cacheBase;
    const newContent = outputTokens + freshInput; // assistant output becomes next turn's input
    cache_create = Math.max(0, Math.floor(newContent * 0.3 + randInt(0, 2000)));
    cacheBase = cache_read + cache_create;
  }

  cumulativeInput += freshInput + outputTokens;

  // Tool calls — grow over session
  const toolsThisTurn = {};
  const bashCount = randInt(0, 3 + Math.floor(turnIdx / 5));
  const readCount = randInt(0, 2 + Math.floor(turnIdx / 8));
  const editCount = turnIdx > 10 ? randInt(0, 2) : 0;
  const writeCount = turnIdx > 20 ? randInt(0, 1) : 0;
  if (bashCount) { toolsThisTurn.Bash = bashCount; sessionTools.Bash += bashCount; }
  if (readCount) { toolsThisTurn.Read = readCount; sessionTools.Read += readCount; }
  if (editCount) { toolsThisTurn.Edit = editCount; sessionTools.Edit += editCount; }
  if (writeCount) { toolsThisTurn.Write = writeCount; sessionTools.Write += writeCount; }
  if (turnIdx > 15 && Math.random() < 0.15) { toolsThisTurn.Agent = 1; sessionTools.Agent++; }
  if (turnIdx > 25 && Math.random() < 0.1) { toolsThisTurn.WebSearch = randInt(1, 3); sessionTools.WebSearch += toolsThisTurn.WebSearch; }
  let skillCalls;
  if (Math.random() < 0.05) {
    toolsThisTurn.Skill = 1; sessionTools.Skill++;
    skillCalls = { [pick(SKILLS)]: 1 };
  }

  const usage = {
    input_tokens: freshInput,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cache_create,
    cache_read_input_tokens: cache_read,
  };

  const entry = {
    id: makeId(receivedAt),
    ts: new Date(receivedAt).toTimeString().slice(0, 8),
    sessionId: showcaseSessionId,
    provider: 'anthropic',
    agent: 'claude',
    model: 'claude-opus-4-8',
    responseId: msgId(),
    msgCount,
    toolCount: 106,
    toolCalls: toolsThisTurn,
    skillCalls,
    isSubagent: false,
    agentKey: 'orchestrator',
    agentLabel: opts.agentLabel,
    cwd: SHOWCASE_CWD,
    title: turnIdx === 1 ? 'Implement OAuth2 with parallel review agents' : undefined,
    stopReason: Object.keys(toolsThisTurn).length > 0 ? 'tool_use' : 'end_turn',
    elapsed: String(randInt(15, 600) / 10),
    status: 200,
    method: 'POST',
    url: '/v1/messages',
    isSSE: true,
    receivedAt,
    usage,
    cost: { cost: parseFloat(cost(usage).toFixed(4)), confidence: 'exact' },
    maxContext: MAX_CTX,
    // Authoritative 1M-window signal (docs/decisions/0013-*): written only when
    // true, so sessionCtxWindow() takes the authoritative path instead of the
    // maxContext-fossil fallback.
    beta1m: MAX_CTX === 1000000 ? true : undefined,
    sysHash: showcaseSysHash,
    toolsHash: showcaseToolsHash,
    coreHash: showcaseCoreHash,
    convId: showcaseConvId,
    toolFail: Math.random() < 0.03,
    thinkingDuration: randInt(800, 8000),
    sessionInferred: false,
  };

  entries.push(entry);
  return entry;
}

// Generate 50 main turns with timing
for (let t = 0; t < 50; t++) {
  let gap;
  if (t === 0) gap = 0;
  else if (t === 22) {
    // 1-hour gap at turn 22 → cache expires
    gap = 3700000; // ~62 minutes
    cacheExpired = true;
  } else {
    gap = randInt(8000, 45000); // 8-45 seconds between turns
  }

  const receivedAt = showcaseStart + (t === 0 ? 0 : entries.filter(e => e.sessionId === showcaseSessionId && !e.isSubagent).length > 0
    ? entries.filter(e => e.sessionId === showcaseSessionId).sort((a,b) => b.receivedAt - a.receivedAt)[0].receivedAt - showcaseStart + gap
    : gap);
  addMainTurn(t, showcaseStart + t * 25000 + (t > 22 ? 3700000 : 0) + randInt(0, 5000));
}

// ── Subagent lanes ──

function addSubagent(label, agentKey, model, maxCtx, turnCount, startTurnIdx, cwd) {
  const convId = hash() + hash();
  const coreHash = hash();
  const sysHash = hash();
  const toolsHash = hash();
  const baseTurn = entries.filter(e => e.sessionId === showcaseSessionId && !e.isSubagent)[startTurnIdx];
  if (!baseTurn) return;
  const baseTime = baseTurn.receivedAt;

  for (let t = 0; t < turnCount; t++) {
    const receivedAt = baseTime + randInt(2000, 8000) + t * randInt(5000, 20000);
    const freshInput = t === 0 ? randInt(500, 3000) : randInt(100, 800);
    const outputTokens = randInt(100, 1500);
    const cache_read = t === 0 ? 0 : randInt(2000, 10000);
    const cache_create = t === 0 ? randInt(3000, 15000) : randInt(0, 500);

    const toolsThisTurn = {};
    if (label === 'Web Search') {
      toolsThisTurn.WebSearch = randInt(1, 3);
      toolsThisTurn.WebFetch = randInt(0, 2);
    } else {
      if (Math.random() < 0.7) toolsThisTurn.Read = randInt(1, 4);
      if (Math.random() < 0.5) toolsThisTurn.Bash = randInt(1, 3);
      if (Math.random() < 0.2) toolsThisTurn.Grep = randInt(1, 2);
    }

    const usage = {
      input_tokens: freshInput,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cache_create,
      cache_read_input_tokens: cache_read,
    };

    entries.push({
      id: makeId(receivedAt),
      ts: new Date(receivedAt).toTimeString().slice(0, 8),
      sessionId: showcaseSessionId,
      provider: 'anthropic',
      agent: 'claude',
      model,
      responseId: msgId(),
      msgCount: 2 + t * 2,
      toolCount: 30,
      toolCalls: toolsThisTurn,
      isSubagent: true,
      agentKey,
      agentLabel: label,
      cwd,
      stopReason: 'end_turn',
      elapsed: String(randInt(10, 80) / 10),
      status: 200,
      method: 'POST',
      url: '/v1/messages',
      isSSE: true,
      receivedAt,
      usage,
      cost: { cost: parseFloat(cost(usage).toFixed(4)), confidence: 'exact' },
      maxContext: maxCtx,
      beta1m: maxCtx === 1000000 ? true : undefined,
      sysHash,
      toolsHash,
      coreHash,
      convId,
      toolFail: false,
      thinkingDuration: model.includes('opus') ? randInt(500, 3000) : null,
      sessionInferred: false,
    });
  }
}

// Title Generator (1 turn, very early, fable model)
addSubagent('Title Generator', 'unknown', 'claude-fable-5', 200000, 1, 0, SHOWCASE_CWD);

// Fork (5 turns, overlapping with main turns 12-18)
addSubagent('Fork', 'orchestrator', 'claude-opus-4-8', 1000000, 5, 12, SHOWCASE_CWD);

// Research Agent (7 turns, overlapping with main turns 15-25)
addSubagent('Research Agent', 'general-purpose', 'claude-fable-5', 200000, 7, 15, SHOWCASE_CWD);

// Code Reviewer (4 turns, overlapping with main turns 30-35)
addSubagent('Code Reviewer', 'code-reviewer', 'claude-opus-4-8', 1000000, 4, 30, SHOWCASE_CWD);

// Web Search burst (8 turns, overlapping with main turns 35-40)
addSubagent('Web Search', 'unknown', 'claude-opus-4-8', 1000000, 8, 35, SHOWCASE_CWD);

// Agent (3 turns at turn 42)
addSubagent('Agent', 'general-purpose', 'claude-fable-5', 200000, 3, 42, SHOWCASE_CWD);


// ══════════════════════════════════════════════════════════════════════════════
//  BACKGROUND PROJECTS — smaller sessions for dashboard project list
// ══════════════════════════════════════════════════════════════════════════════

const BG_PROJECTS = [
  { cwd: '/home/dev/mobile-app', sessions: [
    { title: 'Fix connection pool exhaustion under load', turns: 12, model: 'claude-opus-4-6', daysAgo: 1 },
    { title: 'Add push notification handler', turns: 8, model: 'claude-sonnet-4-20250514', daysAgo: 3 },
  ]},
  { cwd: '/home/dev/data-pipeline', sessions: [
    { title: 'Migrate database schema to v3', turns: 15, model: 'claude-opus-4-8', daysAgo: 2 },
  ]},
  { cwd: '/home/dev/auth-service', sessions: [
    { title: 'Refactor payment processing module', turns: 10, model: 'claude-opus-4-6', daysAgo: 4 },
    { title: 'Update token refresh logic', turns: 6, model: 'claude-sonnet-4-20250514', daysAgo: 5 },
  ]},
  { cwd: '/home/dev/docs-site', sessions: [
    { title: 'Add real-time notification system', turns: 9, model: 'claude-sonnet-4-20250514', daysAgo: 2 },
  ]},
];

for (const proj of BG_PROJECTS) {
  for (const sess of proj.sessions) {
    const sid = uuid();
    const sessStart = now - sess.daysAgo * 86400000 + randInt(0, 43200000);
    const sysH = hash(), toolsH = hash(), coreH = hash(), convH = hash() + hash();
    let bgCacheBase = 0;
    let bgMsgCount = 0;

    for (let t = 0; t < sess.turns; t++) {
      bgMsgCount += 2;
      const receivedAt = sessStart + t * randInt(12000, 60000);
      const freshInput = t === 0 ? randInt(200, 500) : randInt(2, 200);
      const outputTokens = randInt(100, 2500);

      let cache_read, cache_create;
      if (t === 0) {
        cache_read = 0;
        cache_create = randInt(80000, 140000);
        bgCacheBase = cache_create;
      } else {
        cache_read = bgCacheBase + randInt(-200, 200);
        cache_create = randInt(0, 3000);
        bgCacheBase = cache_read + cache_create;
      }

      const maxCtx = sess.model.includes('opus-4-8') ? 1000000 : 200000;
      const toolsThisTurn = {};
      if (Math.random() < 0.7) toolsThisTurn.Bash = randInt(1, 3);
      if (Math.random() < 0.6) toolsThisTurn.Read = randInt(1, 3);
      if (t > 3 && Math.random() < 0.4) toolsThisTurn.Edit = randInt(1, 2);

      const usage = {
        input_tokens: freshInput,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cache_create,
        cache_read_input_tokens: cache_read,
      };

      entries.push({
        id: makeId(receivedAt),
        ts: new Date(receivedAt).toTimeString().slice(0, 8),
        sessionId: sid,
        provider: 'anthropic',
        agent: 'claude',
        model: sess.model,
        responseId: msgId(),
        msgCount: bgMsgCount,
        toolCount: 60,
        toolCalls: toolsThisTurn,
        isSubagent: false,
        agentKey: 'orchestrator',
        cwd: proj.cwd,
        title: t === 1 ? sess.title : undefined,
        stopReason: Object.keys(toolsThisTurn).length > 0 ? 'tool_use' : 'end_turn',
        elapsed: String(randInt(10, 300) / 10),
        status: 200,
        method: 'POST',
        url: '/v1/messages',
        isSSE: true,
        receivedAt,
        usage,
        cost: { cost: parseFloat(cost(usage).toFixed(4)), confidence: 'exact' },
        maxContext: maxCtx,
        beta1m: maxCtx === 1000000 ? true : undefined,
        sysHash: sysH,
        toolsHash: toolsH,
        coreHash: coreH,
        convId: convH,
        toolFail: false,
        thinkingDuration: sess.model.includes('opus') ? randInt(500, 5000) : null,
        sessionInferred: false,
      });
    }
  }
}

// ── Sort and write ──

entries.sort((a, b) => a.receivedAt - b.receivedAt);

const ndjson = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
fs.writeFileSync(path.join(LOGS, 'index.ndjson'), ndjson);

// ── _req/_res pairs for showcase session ──

const showcaseEntries = entries.filter(e => e.sessionId === showcaseSessionId && !e.isSubagent);
const sampleIndices = [0, 1, 5, 10, 20, 30, 40, 48].filter(i => i < showcaseEntries.length);

for (const idx of sampleIndices) {
  const entry = showcaseEntries[idx];
  const req = {
    model: entry.model,
    max_tokens: 16384,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    system: [
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.\nYou are an interactive agent that helps users with software engineering tasks.\n\n# System\n - All text you output outside of tool use is displayed to the user.\n - Tools are executed in a user-selected permission mode.\n\n# Doing tasks\n - The user will primarily request you to perform software engineering tasks.\n - You are highly capable and often allow users to complete ambitious tasks.\n - Prefer editing existing files to creating new ones.\n - Be careful not to introduce security vulnerabilities.' },
      { type: 'text', text: '# CLAUDE.md\n\nGuidance for Claude Code when working with this repository.\n\n## What is this\n\nA high-performance e-commerce API built with Node.js and PostgreSQL.\n\n## Commands\n\n```bash\nnpm test                # Run test suite\nnpm run dev             # Start dev server with hot reload\nnpm run migrate         # Run database migrations\nnpm run seed            # Seed test data\n```\n\n## Architecture\n\n- `src/routes/` — Express route handlers\n- `src/models/` — Sequelize models\n- `src/middleware/` — Auth, rate limiting, validation\n- `src/services/` — Business logic layer\n- `test/` — Jest test suites\n\n## Invariants\n\n- All monetary values stored as integers (cents)\n- Auth tokens expire after 24h\n- Rate limit: 100 req/min per API key', cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      { name: 'Bash', description: 'Execute a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', description: 'Read a file from the local filesystem', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
      { name: 'Edit', description: 'Edit a file with string replacements', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
      { name: 'Write', description: 'Write a file to the local filesystem', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
      { name: 'Agent', description: 'Launch a subagent for parallel work', input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: idx === 0 ? 'Implement OAuth2 authentication with PKCE flow for the API. Use parallel agents to review the security implications.' : 'Continue with the implementation.' }] },
    ],
    metadata: { session_id: showcaseSessionId },
  };

  const res = [
    { type: 'message_start', message: { id: entry.responseId, model: entry.model, usage: { input_tokens: entry.usage.input_tokens, output_tokens: 0, cache_creation_input_tokens: entry.usage.cache_creation_input_tokens, cache_read_input_tokens: entry.usage.cache_read_input_tokens } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I need to implement OAuth2 with PKCE. Let me start by examining the existing auth middleware and then set up the OAuth2 routes. I should also check the database schema for storing authorization codes and tokens...' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'I\'ll start by reading the current auth setup and then implementing the OAuth2 PKCE flow.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_' + hash().slice(0, 6), name: 'Read', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/home/dev/ecommerce-api/src/middleware/auth.js"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: entry.usage.output_tokens } },
    { type: 'message_stop' },
  ];

  fs.writeFileSync(path.join(LOGS, entry.id + '_req.json'), JSON.stringify(req, null, 2));
  fs.writeFileSync(path.join(LOGS, entry.id + '_res.json'), JSON.stringify(res, null, 2));
}

// ── Stars ──

const starredEntry = showcaseEntries[1]; // session title turn
if (starredEntry) {
  const settings = { stars: { turns: [starredEntry.id], sessions: [showcaseSessionId] } };
  fs.writeFileSync(path.join(HOME, 'settings.json'), JSON.stringify(settings, null, 2));
}

// ── Summary ──

const mainShowcase = entries.filter(e => e.sessionId === showcaseSessionId && !e.isSubagent);
const subShowcase = entries.filter(e => e.sessionId === showcaseSessionId && e.isSubagent);
const lastMain = mainShowcase[mainShowcase.length - 1];
const totalCtx = (lastMain.usage.input_tokens + lastMain.usage.cache_read_input_tokens + lastMain.usage.cache_creation_input_tokens);
console.log(`Generated ${entries.length} entries total`);
console.log(`Showcase: ${mainShowcase.length} main + ${subShowcase.length} sub = ${mainShowcase.length + subShowcase.length} turns`);
console.log(`Showcase final context: ${(totalCtx / MAX_CTX * 100).toFixed(1)}% of ${MAX_CTX/1000}K`);
console.log(`Showcase session ID: ${showcaseSessionId}`);
console.log(`Background: ${entries.length - mainShowcase.length - subShowcase.length} turns across ${BG_PROJECTS.reduce((s, p) => s + p.sessions.length, 0)} sessions`);
console.log(`Logs written to: ${LOGS}`);
// CCXRAY_EXPORT_DISABLE is part of the printed command on purpose: people copy this
// line verbatim, and CCXRAY_HOME does not isolate CCXRAY_EXPORT_GCS_BUCKET, so a
// fixture server booted from it would ship synthetic summaries to the real bucket.
console.log(`\nStart server with:\n  CCXRAY_HOME=${HOME} RESTORE_DAYS=0 CCXRAY_IMPORT_DISABLE=1 CCXRAY_EXPORT_DISABLE=1 node server/index.js --port 5602 --no-browser`);
