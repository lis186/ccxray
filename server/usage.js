'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCcxrayHome } = require('./paths');

const HELP = `Usage: ccxray usage [options]

Options:
  --json              JSON output (for agents)
  --tools             Show all tools (default: top 7)
  --session <id>      Filter to session(s), comma-separated or repeated
  --last <duration>   Time filter: 7d, 24h, 30m (default: all)
  --cwd <path>        Filter to entries from this working directory (prefix match)
  --open              Open dashboard to the matched session after output
  --help              Show this help`;

function parseDuration(s) {
  const m = s.match(/^(\d+)(d|h|m)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = { d: 86400000, h: 3600000, m: 60000 }[m[2]];
  return n * unit;
}

function parseArgs(argv) {
  const args = { json: false, tools: false, open: false, sessionIds: [], since: null, cwds: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') { console.log(HELP); process.exit(0); }
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--tools') args.tools = true;
    else if (argv[i] === '--open') args.open = true;
    else if (argv[i] === '--session' && argv[i + 1]) {
      for (const id of argv[++i].split(',')) if (id) args.sessionIds.push(id);
    }
    else if (argv[i] === '--last' && argv[i + 1]) {
      const ms = parseDuration(argv[++i]);
      if (ms != null) args.since = Date.now() - ms;
    }
    else if (argv[i] === '--cwd' && argv[i + 1]) {
      for (const p of argv[++i].split(',')) if (p) args.cwds.push(p);
    }
  }
  return args;
}

function run(argv) {
  const args = parseArgs(argv);
  const home = resolveCcxrayHome();
  const indexPath = path.join(home, 'logs', 'index.ndjson');

  if (!fs.existsSync(indexPath)) {
    const err = { error: 'no logs found', hint: `check CCXRAY_HOME (currently ${home})` };
    if (args.json) console.log(JSON.stringify(err));
    else console.error(`No logs found at ${indexPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(indexPath, 'utf8');
  let entries = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }

  // ponytail: #1 smart --session — alias → UUID prefix → title substring
  if (args.sessionIds.length) {
    const exact = [], fuzzy = [];
    for (const id of args.sessionIds) {
      if (id === 'latest') {
        // by receivedAt, not array order: index lines are append-order and can
        // arrive out of sequence under hub concurrency or startup restoration.
        const newest = entries.reduce((a, e) => (e.receivedAt || 0) > (a?.receivedAt || 0) ? e : a, null);
        exact.push(newest?.sessionId);
      }
      else if (id === 'costliest') {
        const bySess = {};
        for (const e of entries) if (e.sessionId) bySess[e.sessionId] = (bySess[e.sessionId] || 0) + (e.cost?.cost || 0);
        exact.push(Object.entries(bySess).sort((a, b) => b[1] - a[1])[0]?.[0]);
      }
      else fuzzy.push(id);
    }
    entries = entries.filter(e => e.sessionId && (
      exact.some(id => id && e.sessionId === id) ||
      fuzzy.some(id => e.sessionId.startsWith(id) || (e.title && e.title.toLowerCase().includes(id.toLowerCase())))
    ));
  }
  if (args.since) entries = entries.filter(e => (e.receivedAt || 0) >= args.since);
  // ponytail: #4 smart --cwd — non-path values do case-insensitive substring match
  if (args.cwds.length) {
    entries = entries.filter(e => {
      if (!e.cwd) return false;
      return args.cwds.some(p => p.startsWith('/') || p.startsWith('~')
        ? e.cwd.startsWith(p)
        : e.cwd.toLowerCase().includes(p.toLowerCase()));
    });
  }

  if (!entries.length) {
    const hint = args.sessionIds.length
      ? `no match for "${args.sessionIds.join(', ')}". Try --session latest, --session costliest, or a title keyword.`
      : args.cwds.length ? `no match for "${args.cwds.join(', ')}". Try a directory name substring.`
      : 'index is empty';
    const err = { error: 'no matching entries', hint };
    if (args.json) console.log(JSON.stringify(err));
    else console.error(`${err.error} — ${hint}`);
    process.exit(1);
  }

  // ponytail: #2 multi-cwd comparison — 2+ cwds → per-project summary via analyze()
  if (args.cwds.length >= 2) {
    const groups = {};
    for (const e of entries) { const k = e.cwd || 'unknown'; if (!groups[k]) groups[k] = []; groups[k].push(e); }
    const rows = Object.entries(groups).map(([cwd, es]) => {
      const r = analyze(es);
      return { cwd, cost: r.meta.totalCost, sessions: r.meta.totalSessions, turns: r.meta.totalEntries, cacheHit: r.cache.hitRate };
    }).sort((a, b) => b.cost - a.cost);
    if (args.json) { console.log(JSON.stringify(rows)); }
    else {
      const B = '\x1b[1m', R = '\x1b[0m';
      console.log(`\n${B}Project Comparison${R}`);
      for (const r of rows) console.log(`  ${r.cwd}  $${r.cost}  ${r.sessions} sessions  ${r.turns} turns  cache ${(r.cacheHit * 100).toFixed(1)}%`);
      console.log();
    }
    return;
  }

  // Build the skill-scope map once here (it reads the filesystem) and pass it
  // in, keeping analyze() pure and deterministic for direct/test callers.
  const result = analyze(entries, { ...args, scopeMap: buildSkillScopeMap() });
  if (args.json) console.log(JSON.stringify(result));
  else printHuman(result, args);

  // ponytail: --open jumps to dashboard for the resolved session
  if (args.open) {
    const sessions = new Set(entries.map(e => e.sessionId).filter(Boolean));
    if (sessions.size === 1) {
      const sid = [...sessions][0];
      openDashboard(`s=${encodeURIComponent(sid.slice(0, 8))}`);
    } else if (sessions.size > 1) {
      console.error('--open requires a single session (got ' + sessions.size + '). Narrow with --session.');
    }
  }
}

// ── Analysis ────────────────────────────────────────────────────────────

function analyze(entries, opts = {}) {
  const timestamps = [];
  const byProvider = {};
  const bySession = {};
  const modelMap = {};
  const toolAgg = {};
  const skillMap = {}; // skill name → { invocations, sessions: Set }
  let totalCost = 0, totalToolCalls = 0, failCount = 0, subagentCount = 0, legacySkillCount = 0;
  let totalInput = 0, totalCacheCreate = 0, totalCacheRead = 0, totalOutput = 0;

  for (const e of entries) {
    if (e.receivedAt) timestamps.push(e.receivedAt);

    const p = e.provider || 'unknown';
    byProvider[p] = (byProvider[p] || 0) + 1;

    const sid = e.sessionId || 'unknown';
    if (!bySession[sid]) bySession[sid] = [];
    bySession[sid].push(e);

    if (e.isSubagent) subagentCount++;

    const m = e.model || 'unknown';
    if (!modelMap[m]) modelMap[m] = { model: m, turns: 0, cost: 0 };
    modelMap[m].turns++;
    const c = e.cost?.cost || 0;
    modelMap[m].cost += c;
    totalCost += c;

    if (e.toolCalls) {
      for (const [name, count] of Object.entries(e.toolCalls)) {
        toolAgg[name] = (toolAgg[name] || 0) + count;
        totalToolCalls += count;
      }
    }
    // Per-skill detail comes from the dedicated skillCalls field (new data).
    // Entries without it predate skill tracking → counted as (pre-tracking).
    if (e.skillCalls && Object.keys(e.skillCalls).length) {
      for (const [sn, count] of Object.entries(e.skillCalls)) {
        if (!skillMap[sn]) skillMap[sn] = { invocations: 0, sessions: new Set() };
        skillMap[sn].invocations += count;
        skillMap[sn].sessions.add(sid);
      }
    } else {
      legacySkillCount += e.toolCalls?.Skill || 0;
    }
    if (e.toolFail) failCount++;

    if (e.usage) {
      totalInput += e.usage.input_tokens || 0;
      totalCacheCreate += e.usage.cache_creation_input_tokens || 0;
      totalCacheRead += e.usage.cache_read_input_tokens || 0;
      totalOutput += e.usage.output_tokens || 0;
    }
  }

  timestamps.sort((a, b) => a - b);
  const sessionCount = Object.keys(bySession).length;

  const meta = {
    totalEntries: entries.length,
    totalSessions: sessionCount,
    totalCost: +totalCost.toFixed(2),
    timeRange: {
      from: timestamps[0] ? new Date(timestamps[0]).toISOString() : null,
      to: timestamps.at(-1) ? new Date(timestamps.at(-1)).toISOString() : null,
    },
  };

  const turnCounts = Object.values(bySession).map(a => a.length);
  const topSessions = Object.entries(bySession)
    .map(([sid, turns]) => {
      const cost = turns.reduce((s, e) => s + (e.cost?.cost || 0), 0);
      const ts = turns.map(e => e.receivedAt).filter(Boolean).sort((a, b) => a - b);
      const dur = ts.length >= 2 ? (ts.at(-1) - ts[0]) / 1000 : 0;
      const rawTitle = turns.reduce((t, e) => e.title && !e.title.startsWith('↩') ? e.title : t, null);
      const title = rawTitle ? rawTitle.slice(0, 40) : null;
      return {
        sessionId: sid, turns: turns.length, cost: +cost.toFixed(2),
        durationMin: +((dur) / 60).toFixed(1), title,
        model: turns.reduce((m, e) => { m[e.model || 'unknown'] = (m[e.model || 'unknown'] || 0) + 1; return m; }, {}),
        provider: turns[0]?.provider || 'unknown',
      };
    })
    .filter(s => s.sessionId !== 'unknown' && s.sessionId !== 'direct-api')
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)
    .map(s => {
      // collapse model map to dominant model
      const topModel = Object.entries(s.model).sort((a, b) => b[1] - a[1])[0];
      return { ...s, model: topModel ? topModel[0] : 'unknown' };
    });

  const sessions = {
    count: sessionCount,
    byProvider,
    subagentRatio: entries.length ? +(subagentCount / entries.length).toFixed(3) : 0,
    turnDistribution: percentiles(turnCounts),
    topSessions,
  };

  const models = Object.values(modelMap)
    .sort((a, b) => b.turns - a.turns)
    .slice(0, 10)
    .map(m => ({
      model: m.model, turns: m.turns,
      cost: +m.cost.toFixed(2),
      costShare: totalCost ? +(m.cost / totalCost).toFixed(3) : 0,
    }));

  const tools = {
    totalCalls: totalToolCalls,
    top: Object.entries(toolAgg).sort((a, b) => b[1] - a[1]).slice(0, opts.tools ? Infinity : 10).map(([name, count]) => ({ name, count })),
    failRate: entries.length ? +(failCount / entries.length).toFixed(3) : 0,
  };

  const totalAllInput = totalInput + totalCacheCreate + totalCacheRead;
  const cache = {
    hitRate: totalAllInput ? +(totalCacheRead / totalAllInput).toFixed(3) : 0,
    totalInputTokens: totalAllInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
  };

  const scopeMap = opts.scopeMap || {};
  const skills = Object.entries(skillMap)
    .sort((a, b) => b[1].invocations - a[1].invocations)
    .map(([name, s]) => ({
      name, invocations: s.invocations, loads: s.sessions.size,
      scope: scopeMap[name] || scopeMap[name.split(':').pop()] || null,
    }));
  // legacy: Skill tool calls from entries that predate the skillCalls field
  if (legacySkillCount) skills.push({ name: '(pre-tracking)', invocations: legacySkillCount, loads: null, scope: null });

  // sort session turns once for both hashStability and gapVsCache
  for (const turns of Object.values(bySession)) turns.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));

  return { meta, sessions, models, tools, skills, prompts: { hashStability: hashStability(bySession) }, cache, gapCache: gapVsCache(bySession) };
}

function hashStability(bySession) {
  let sysC = 0, sysP = 0, toolsC = 0, toolsP = 0, coreC = 0, coreP = 0;

  for (const turns of Object.values(bySession)) {
    for (let i = 1; i < turns.length; i++) {
      const prev = turns[i - 1], curr = turns[i];
      if (prev.sysHash && curr.sysHash) { sysP++; if (prev.sysHash !== curr.sysHash) sysC++; }
      if (prev.toolsHash && curr.toolsHash) { toolsP++; if (prev.toolsHash !== curr.toolsHash) toolsC++; }
      if (prev.coreHash && curr.coreHash) { coreP++; if (prev.coreHash !== curr.coreHash) coreC++; }
    }
  }

  const label = r => r > 0.5 ? 'every-turn' : r > 0.1 ? 'frequent' : r > 0.01 ? 'occasional' : r > 0 ? 'rare' : 'never';
  const stat = (changes, pairs) => {
    const rate = pairs ? +(changes / pairs).toFixed(4) : 0;
    return { changeRate: rate, pairs, label: label(rate) };
  };
  return { sysHash: stat(sysC, sysP), toolsHash: stat(toolsC, toolsP), coreHash: stat(coreC, coreP) };
}

function gapVsCache(bySession) {
  const BUCKETS = [
    { key: '<30s', max: 30 },
    { key: '30s-5m', max: 300 },
    { key: '5-15m', max: 900 },
    { key: '15-60m', max: 3600 },
    { key: '>60m', max: Infinity },
  ];
  const data = Object.fromEntries(BUCKETS.map(b => [b.key, []]));

  for (const turns of Object.values(bySession)) {
    if (turns.length < 2) continue;
    for (let i = 1; i < turns.length; i++) {
      const e = turns[i], prev = turns[i - 1];
      const elapsed = parseFloat(prev.elapsed) || 0;
      const gapSec = (e.receivedAt - (prev.receivedAt + elapsed * 1000)) / 1000;
      // skip non-finite gaps (missing/non-numeric receivedAt) — a NaN gap would
      // miss every bucket (even max:Infinity) and crash the bucket lookup below.
      if (!(gapSec >= 0)) continue;
      const cacheRead = e.usage?.cache_read_input_tokens || 0;
      const totalIn = (e.usage?.input_tokens || 0) + (e.usage?.cache_creation_input_tokens || 0) + cacheRead;
      if (!totalIn) continue;
      const bucket = BUCKETS.find(b => gapSec < b.max);
      data[bucket.key].push(cacheRead / totalIn);
    }
  }

  return BUCKETS.map(b => {
    const rates = data[b.key];
    if (!rates.length) return { gap: b.key, turns: 0, avgHitRate: 0, medianHitRate: 0 };
    const avg = rates.reduce((a, c) => a + c, 0) / rates.length;
    const sorted = rates.slice().sort((a, c) => a - c);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { gap: b.key, turns: rates.length, avgHitRate: +avg.toFixed(3), medianHitRate: +median.toFixed(3) };
  }).filter(b => b.turns > 0);
}

// ── Skill scope detection ────────────────────────────────────────────────
// ponytail: scan known directories at analysis time, not at index write time.
// Only reflects current state — if a skill was deleted, scope shows as null.

function buildSkillScopeMap() {
  const map = {};
  const home = process.env.HOME || '';
  const dirs = [
    { dir: path.join(home, '.claude-personal', 'skills'), scope: 'user' },
    { dir: path.join(home, '.claude', 'skills'), scope: 'user' },
    { dir: '.claude/skills', scope: 'project' },
  ];

  for (const { dir, scope } of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        if (!map[name]) map[name] = scope;
      }
    } catch {}
  }

  // plugins: ~/.claude/plugins/cache/*/*/skills/*
  try {
    const pluginCache = path.join(home, '.claude', 'plugins', 'cache');
    for (const vendor of fs.readdirSync(pluginCache)) {
      const vendorDir = path.join(pluginCache, vendor);
      try {
        for (const pkg of fs.readdirSync(vendorDir)) {
          for (const ver of fs.readdirSync(path.join(vendorDir, pkg))) {
            const skillsDir = path.join(vendorDir, pkg, ver, 'skills');
            try {
              for (const name of fs.readdirSync(skillsDir)) {
                if (!map[name]) map[name] = 'plugin';
              }
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}

  return map;
}

// ── Dashboard open ──────────────────────────────────────────────────────

function openDashboard(queryString) {
  const port = require('./hub').readHubLock()?.port || 5577;
  const url = `http://localhost:${port}/?${queryString}`;
  const { exec } = require('child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function fmtDur(min) {
  if (min < 60) return min.toFixed(0) + 'm';
  if (min < 1440) return (min / 60).toFixed(1) + 'h';
  return (min / 1440).toFixed(1) + 'd';
}

function percentiles(arr) {
  if (!arr.length) return { min: 0, median: 0, p75: 0, max: 0 };
  const s = arr.slice().sort((a, b) => a - b);
  const at = q => s[Math.min(Math.floor(q * s.length), s.length - 1)];
  return { min: s[0], median: at(0.5), p75: at(0.75), max: s.at(-1) };
}

// ── Human output ─────────────────────────────────────────────────────────

function printHuman(r, opts = {}) {
  const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m';

  console.log(`\n${B}ccxray usage${R}  ${r.meta.totalEntries} entries · ${r.meta.totalSessions} sessions · $${r.meta.totalCost}`);
  console.log(`${D}${r.meta.timeRange.from?.slice(0, 10) || '?'} → ${r.meta.timeRange.to?.slice(0, 10) || '?'}${R}\n`);

  console.log(`${B}Sessions${R}`);
  for (const [p, n] of Object.entries(r.sessions.byProvider)) console.log(`  ${p}: ${n} turns`);
  console.log(`  subagent: ${pct(r.sessions.subagentRatio)}   turns/session: ${r.sessions.turnDistribution.min}–${r.sessions.turnDistribution.max} (median ${r.sessions.turnDistribution.median})`);
  if (r.sessions.topSessions?.length) {
    console.log(`  ${D}costliest sessions:${R}`);
    for (const s of r.sessions.topSessions) {
      const id = s.sessionId.length > 16 ? s.sessionId.slice(0, 8) + '…' : s.sessionId;
      const title = s.title ? `  ${D}${s.title}${R}` : '';
      console.log(`  ${id.padEnd(10)} $${String(s.cost).padEnd(9)} ${String(s.turns).padStart(5)} turns  ${fmtDur(s.durationMin).padStart(7)}  ${s.model}${title}`);
    }
  }
  console.log();

  console.log(`${B}Models${R}`);
  for (const m of r.models.slice(0, 5)) console.log(`  ${m.model}: ${m.turns} turns · $${m.cost} (${pct(m.costShare)})`);
  console.log();

  console.log(`${B}Tools${R}  ${r.tools.totalCalls} calls · ${pct(r.tools.failRate)} fail`);
  for (const t of (opts.tools ? r.tools.top : r.tools.top.slice(0, 7))) console.log(`  ${t.name}: ${t.count}`);
  console.log();

  if (r.skills.length) {
    console.log(`${B}Skills${R}  ${D}invocations / loads (= unique sessions)${R}`);
    for (const s of r.skills) {
      const loads = s.loads != null ? `${s.loads} loads` : 'n/a';
      const scope = s.scope ? ` ${D}[${s.scope}]${R}` : '';
      console.log(`  ${s.name}: ${s.invocations} invocations · ${loads}${scope}`);
    }
    console.log();
  }

  console.log(`${B}Prompt Stability${R}`);
  for (const [k, v] of Object.entries(r.prompts.hashStability)) {
    console.log(`  ${k}: ${pct(v.changeRate)} change ${D}(${v.label}, ${v.pairs} pairs)${R}`);
  }
  console.log();

  console.log(`${B}Cache${R}  hit rate: ${pct(r.cache.hitRate)}`);
  if (r.gapCache.length) {
    console.log(`  ${D}turn gap → cache hit (avg / median)${R}`);
    for (const b of r.gapCache) {
      console.log(`  ${b.gap.padEnd(8)} ${pct(b.avgHitRate).padStart(6)} / ${pct(b.medianHitRate).padStart(6)}  ${D}(${b.turns} turns)${R}`);
    }
  }
  console.log();
}

function pct(n) { return `${(n * 100).toFixed(1)}%`; }

module.exports = { run, analyze };
