'use strict';

// Assembling and rendering the A1a report (docs/agentflow-integration.md,
// Report). Only the fields the spec lists leave this module: no prompts, no
// session ids, no paths.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readMergedTurns, aggregate } = require('../usage-query');
const { formatAggCostText } = require('../../public/format.js');
const { loadNotebook, archivePathFor } = require('./notebook');
const { defaultNotebook } = require('./cli');
const { readClaudeTranscript, readCodexTranscript, collectSubmissions } = require('./evidence');
const { buildWindows, disclose } = require('./windows');
const { defaultRoots, findTranscripts, checkoutTranscripts, subagentTranscripts } = require('./discover');
const { readDispatchRecords, readCompletionRecords } = require('./records');
const { attributeWorkers } = require('./workers');
const { isNativeSubagent, attributeHosts } = require('./host');
const { hostCompleteness, foldCompleteness } = require('./completeness');

const DAY = 24 * 60 * 60 * 1000;

function realpath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

// The checkout the notebook lives in: the Git worktree, else the nearest folder
// holding ag.json, else the notebook's own folder.
function checkoutRootFor(notebook) {
  const dir = path.dirname(notebook);
  try {
    return realpath(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {}
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'ag.json'))) return realpath(d);
    if (path.dirname(d) === d) return realpath(dir);
  }
}

function workspaceDirFor(root) {
  try {
    const sw = JSON.parse(fs.readFileSync(path.join(root, 'ag.json'), 'utf8')).switches || {};
    if (typeof sw['workspace-dir'] === 'string') return path.resolve(root, sw['workspace-dir']);
  } catch {}
  return path.join(root, '.agentflow');
}

// Every notebook of the workspace, so a cross-notebook conflict shows as
// `ambiguous` (Attribution, Scope of candidates). The reported one comes first.
function workspaceNotebooks(workspace, reported) {
  const found = [reported];
  const add = p => { if (fs.existsSync(p) && !found.some(f => realpath(f) === realpath(p))) found.push(p); };
  const list = d => { try { return fs.readdirSync(d); } catch { return []; } };
  add(path.join(workspace, 'devlog.md'));
  for (const f of list(workspace)) if (f.endsWith('.devlog.md')) add(path.join(workspace, f));
  for (const k of list(path.join(workspace, 'features'))) {
    for (const f of list(path.join(workspace, 'features', k))) if (f.endsWith('.devlog.md')) add(path.join(workspace, 'features', k, f));
  }
  return found;
}

function readTranscript({ provider, file }) {
  try { return provider === 'openai' ? readCodexTranscript(file) : readClaudeTranscript(file); } catch { return null; }
}

// The cost of each of a host's submissions after its first matched one: its
// turns from that submission to the host's next one, capped at the window end.
function followUps(row, w, windowsResult) {
  const { after } = disclose(w, row.session, windowsResult);
  const times = [...after].sort((a, b) => a - b);
  const turns = times.map((t, i) => row.turns.filter(e => e.receivedAt >= t && e.receivedAt < (times[i + 1] ?? w.end)));
  const agg = aggregate(turns.flat());
  return { count: times.length, calls: agg.calls, cost: agg.cost, costFold: agg.costFold };
}

function executorRows(row, codexSources) {
  // Grouped by native lineage only: the proxy's isSubagent is inferred and also
  // marks title generation and prompt suggestions, which are host cost.
  const main = row.turns.filter(e => !isNativeSubagent(e));
  const groups = new Map();
  for (const e of row.turns.filter(isNativeSubagent)) {
    const role = 'subagent';
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push(e);
  }
  return {
    completeness: hostCompleteness(row.turns, codexSources),
    total: aggregate(row.turns),
    main: aggregate(main),
    subagents: [...groups].map(([role, turns]) => ({ role, ...aggregate(turns) })),
  };
}

function externalRow(run, codexSources) {
  const agg = aggregate(run.turns);
  const actual = Object.keys(agg.effort).filter(k => k !== 'unknown');
  const labels = [...run.labels];
  if (run.requested.effort && actual.length && !actual.includes(run.requested.effort)) labels.push('effort mismatch');
  return {
    kind: 'external', role: run.stage || 'unknown', evidence: run.evidence, status: run.status, labels,
    requested: run.requested, completeness: hostCompleteness(run.turns, codexSources), total: agg, main: agg, subagents: [],
  };
}

async function buildReport({ notebook, archive = null, ask: onlyAsk = null, now = Date.now(), logsDir, roots = defaultRoots(), originOf }) {
  const root = checkoutRootFor(notebook);
  const workspace = workspaceDirFor(root);
  const paths = workspaceNotebooks(workspace, notebook);
  const defaultAbs = defaultNotebook(root);
  const notebooks = paths.map((abs, i) => {
    const arch = i === 0 ? archive : archivePathFor(abs);
    return { abs, rel: path.relative(root, abs), workspaceAbs: workspace, workspaceRel: path.relative(root, workspace), isDefault: abs === defaultAbs, asks: loadNotebook(abs, arch && fs.existsSync(arch) ? arch : null) };
  });

  const stamps = notebooks.flatMap(n => n.asks.map(a => a.stamp).filter(s => s != null));
  const from = (stamps.length ? Math.min(...stamps) : now) - DAY;
  const { turns, codexSources } = await readMergedTurns({ from, to: now, logsDir });
  // Symlinked paths are resolved before comparison (a worker's /var is /private/var).
  const canon = new Map();
  for (const e of turns) {
    if (!e.cwd) continue;
    if (!canon.has(e.cwd)) canon.set(e.cwd, realpath(e.cwd));
    e.cwd = canon.get(e.cwd);
  }

  // A session whose transcript records this checkout lends that cwd to its
  // index rows that have none (proxy rows from before #640 whose imported twin
  // is not in the index yet): the session's cwd, read from its own transcript.
  const local = checkoutTranscripts(root, roots, { from });
  for (const e of turns) if (!e.cwd && local.has(e.sessionId)) { e.cwd = root; e.cwdFromSession = true; }

  const sids = [...new Set(turns.filter(e => e.cwd === root && !isNativeSubagent(e)).map(e => e.sessionId))];
  const transcripts = new Map();
  const files = new Map([...local, ...findTranscripts(sids, roots)]);
  for (const [sid, f] of files) {
    const t = readTranscript(f);
    if (t) transcripts.set(sid, t);
  }
  const subs = collectSubmissions([...transcripts.values()]);
  for (const n of notebooks) { n.windowsResult = buildWindows(n.asks, subs, { now }); n.windows = n.windowsResult.windows; }
  const hosts = attributeHosts({ turns, checkoutRoot: root, notebooks, report: 0, transcripts });

  // External workers: tool evidence of every checkout host session and its
  // Task subagents, plus the workspace's dispatch and completion records.
  const toolEvents = [...transcripts.values()].flatMap(t => t.tools);
  for (const [sid, f] of files) {
    if (f.provider !== 'anthropic') continue;
    for (const sub of subagentTranscripts(f.file)) {
      try { toolEvents.push(...readClaudeTranscript(sub).tools.map(ev => ({ ...ev, sessionId: ev.sessionId || sid }))); } catch {}
    }
  }
  const workspaceRel = path.relative(root, workspace).split(path.sep).join('/');
  const workers = attributeWorkers({
    turns, checkoutRoot: root, workspaceRel, notebooks, hostOf: hosts.hostOf, toolEvents,
    dispatch: readDispatchRecords(workspace), completion: readCompletionRecords(workspace, root, notebooks),
    now, ...(originOf ? { originOf } : {}),
  });
  const ourRuns = workers.runs.filter(r => r.notebook === notebooks[0].rel);

  const reported = notebooks[0];
  // Import lags per turn, not per session (a session spans days): a transcript
  // turn inside the window whose message id no index line carries is missing.
  const indexed = new Set(turns.map(e => e.responseId).filter(Boolean));
  // Codex turns have no id to compare: count the usage turns of the session's
  // transcripts (its subagent threads' turns are filed under it) against its
  // imported lines, unless the proxy is the session's one source.
  const inWin = (w, at) => at >= w.start && at < w.end;
  const codexTurns = sid => [...transcripts.values()].filter(x => x.provider === 'openai' && (x.sessionId === sid || x.parentSessionId === sid)).flatMap(x => x.turns);
  const missingTurns = (w, sids) => sids.reduce((n, sid) => {
    const t = transcripts.get(sid);
    if (!t || !t.turns) return n;
    if (t.provider === 'openai') {
      if (codexSources[sid] === 'proxy') return n;
      const have = turns.filter(e => e.sessionId === sid && e.imported && inWin(w, e.receivedAt)).length;
      return n + Math.max(0, codexTurns(sid).filter(x => inWin(w, x.at)).length - have);
    }
    return n + t.turns.filter(x => inWin(w, x.at) && !indexed.has(x.id)).length;
  }, 0);
  const asks = [];
  for (const w of reported.windows) {
    if (onlyAsk && w.id !== onlyAsk) continue;
    const rows = hosts.rows.filter(r => r.ask === w.id);
    const unique = rows.filter(r => r.status === 'unique');
    const execs = unique.map(r => ({
      kind: 'host', evidence: r.evidence, status: r.status, labels: [...r.labels, ...(r.overlap ? ['overlap'] : [])],
      ...executorRows(r, codexSources),
      unmatchedSubmissions: disclose(w, r.session, reported.windowsResult).unmatched,
      followUps: followUps(r, w, reported.windowsResult),
    }));
    const runs = ourRuns.filter(r => r.ask === w.id);
    for (const r of runs.filter(x => x.status === 'unique')) execs.push(externalRow(r, codexSources));
    const ambiguous = aggregate([...rows.filter(r => r.status === 'ambiguous').flatMap(r => r.turns), ...runs.filter(x => x.status === 'ambiguous').flatMap(x => x.turns)]);
    const labels = [...w.labels, ...(w.unmatchedBullets ? [`unmatched bullets: ${w.unmatchedBullets}`] : [])];
    const missing = w.start != null && w.startKind !== 'no local evidence' ? missingTurns(w, [...new Set([...w.hostSessions, ...rows.map(r => r.session)])]) : 0;
    if (missing) labels.push(`not yet imported: ${missing} turns`);
    if (hosts.noLocalTurns[w.id]) labels.push(`local host turns inside bounds: ${hosts.noLocalTurns[w.id]}`);
    asks.push({
      id: w.id,
      // The Ask's label folds its hosts (Completeness); workers carry their own.
      completeness: foldCompleteness(execs.filter(x => x.kind === 'host').map(x => x.completeness)),
      askTimeMs: w.start != null && w.end != null && w.startKind !== 'no local evidence' ? w.end - w.start : null,
      labels,
      attributed: aggregate([...unique.flatMap(r => r.turns), ...runs.filter(x => x.status === 'unique').flatMap(x => x.turns)]),
      ambiguous: ambiguous.calls ? ambiguous : null,
      executors: execs,
    });
  }

  const count = l => reported.windows.filter(w => w.labels.includes(l)).length;
  return {
    notebook: reported.rel,
    generatedAt: now,
    setup: hosts.setup.length ? aggregate(hosts.setup) : null,
    unassigned: hosts.unassigned.length ? aggregate(hosts.unassigned) : null,
    // Worker runs filed under this notebook but no single Ask, never in totals.
    workersUnassigned: (() => { const t = ourRuns.filter(r => r.status === 'unassigned').flatMap(r => r.turns); return t.length ? aggregate(t) : null; })(),
    workersAmbiguous: (() => { const t = [...ourRuns.filter(r => r.status === 'ambiguous' && r.ask == null).flatMap(r => r.turns), ...workers.ambiguousTurns]; return t.length ? aggregate(t) : null; })(),
    asks,
    footer: {
      sources: Object.entries(turns.filter(e => hosts.rows.some(r => r.turns.includes(e))).reduce((acc, e) => {
        const k = `${e.provider || 'unknown'}: ${(e.sources || []).join('+') || 'unknown'}`;
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {})).map(([k, n]) => `${k} ${n}`),
      noLocalEvidence: count('no local evidence'),
      stampUnreadable: count('stamp unreadable'),
      offRootTurns: hosts.offRoot.length,
      notYetImported: asks.filter(a => a.labels.some(l => l.startsWith('not yet imported'))).length,
      matchedNoNotebook: workers.footer.matchedNoNotebook,
      checkoutUnknown: workers.footer.checkoutUnknown,
      heuristicParentIgnored: workers.footer.heuristicParentIgnored,
      background: hosts.background,
    },
  };
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}
function fmtTokens(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n); }
// No turn is not a measured zero.
function fmtCost(a) { return a.calls ? formatAggCostText(a.cost, a.costFold, 3) : '—'; }
function fmtCounts(obj, word) {
  const e = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (e.length === 1) return word ? `${word} ${e[0][0]}` : e[0][0];
  return (word ? word + ' ' : '') + e.map(([k, n]) => `${k}×${n}`).join(', ');
}
function fmtLocal(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function executorLine(a) {
  return `${fmtCounts(a.models)} · ${fmtCounts(a.effort, 'effort')} · ${fmtDuration(a.durationMs)}${a.durationEstimated ? ' (duration estimated)' : ''} · ${fmtCost(a)} · ${a.calls} calls`;
}

function renderText(report) {
  const out = [];
  if (report.setup) out.push(`## setup · ${fmtCost(report.setup)} · ${report.setup.calls} calls`, '');
  for (const a of report.asks) {
    const t = a.attributed;
    const head = [a.id, a.completeness, fmtDuration(a.askTimeMs), fmtCost(t), t.calls ? `${t.calls} calls` : 'no turns'];
    if (t.calls) head.push(`in ${fmtTokens(t.tokens.input)} · out ${fmtTokens(t.tokens.output)} · cache read ${fmtTokens(t.tokens.cacheRead)} / write ${fmtTokens(t.tokens.cacheWrite)} (read share ${t.readShare == null ? '—' : Math.round(t.readShare * 100) + '%'})`);
    out.push(`## ${head.join(' · ')}`);
    const attribution = [`unique ${fmtCost(t)}`];
    if (a.ambiguous) attribution.push(`ambiguous ${fmtCost(a.ambiguous)}`);
    out.push(`attribution: ${attribution.join(' · ')}`);
    if (a.labels.length) out.push(`labels: ${a.labels.join(' · ')}`);
    for (const x of a.executors) {
      const tail = x.labels.length ? ' · ' + x.labels.join(' · ') : '';
      if (x.kind === 'external') {
        const req = x.requested.effort || x.requested.model ? ` (requested ${[x.requested.model, x.requested.effort].filter(Boolean).join(' ')})` : '';
        out.push(`- external ${x.role} · ${x.evidence} · ${x.status} · ${x.completeness} · ${executorLine(x.total)}${req}${tail}`);
        continue;
      }
      out.push(`- host · ${x.evidence} · ${x.status} · ${x.completeness} · ${executorLine(x.main.calls ? x.main : x.total)}${tail}`);
      for (const s of x.subagents) out.push(`  - subagent ${s.role} · ${executorLine(s)}`);
      out.push(`  unmatched owner submissions: ${x.unmatchedSubmissions} · follow-up submissions: ${x.followUps.count} (${fmtCost(x.followUps)})`);
    }
    out.push('');
  }
  if (report.unassigned) out.push(`notebook-level unassigned: ${fmtCost(report.unassigned)} · ${report.unassigned.calls} calls`, '');
  if (report.workersUnassigned) out.push(`external runs, notebook-level unassigned: ${fmtCost(report.workersUnassigned)} · ${report.workersUnassigned.calls} calls`, '');
  if (report.workersAmbiguous) out.push(`external runs, ambiguous: ${fmtCost(report.workersAmbiguous)} · ${report.workersAmbiguous.calls} calls`, '');
  const f = report.footer;
  out.push('---');
  out.push(`sources (host turns): ${f.sources.join(' · ') || 'none'}`);
  out.push(`generated ${fmtLocal(report.generatedAt)} · no snapshot: figures are recomputed from data still on disk and may change after proxy pruning (14 days), transcript deletion (30 days) or a price-table update`);
  out.push(`this machine's data only · no local evidence: ${f.noLocalEvidence} · stamp unreadable: ${f.stampUnreadable} · host turns below the checkout root, not attributed: ${f.offRootTurns}`);
  out.push(`external runs not in this report · matched no notebook: ${f.matchedNoNotebook} · heuristic parent ignored: ${f.heuristicParentIgnored} · worker runs on this machine, any checkout, whose checkout is unknown, while this notebook's hosts were active: ${f.checkoutUnknown}`);
  if (f.background) out.push(`Codex background threads in this checkout, not attributed: ${f.background}`);
  if (f.notYetImported) out.push(`not yet imported: ${f.notYetImported} Asks have transcript turns the index lacks; run \`ccxray import --once\` and report again`);
  out.push('imported turns are hidden in the dashboard by default; open /?imported to see them');
  return out.join('\n') + '\n';
}

module.exports = { checkoutRootFor, workspaceNotebooks, buildReport, renderText };
