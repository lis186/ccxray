'use strict';

// Aggregation behind GET /_api/task-summary. Pure over an entries array so the
// arithmetic is testable without a server.
//
// Entry `usage` is already canonical by the time it reaches the store: the
// OpenAI-wire parser subtracts cached tokens from input_tokens
// (normalizeUsageForProvider), so for every provider
//   input_tokens  = uncached input
//   cache_read_input_tokens / cache_creation_input_tokens = cache traffic
// and the four fields are disjoint. The per-entry total is therefore their sum;
// never trust a provider's own total_tokens here — OpenAI's counts cached input
// inside input, which would double it against the canonical fields.

function tokenBucket() {
  return { input: 0, output: 0, cache_read: 0, cache_create: 0, reasoning: 0, total: 0 };
}

function entryTokens(usage) {
  const u = usage || {};
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  // Reasoning is a subset of output, reported for visibility — not added to total.
  const reasoning = u.output_tokens_details?.reasoning_tokens || 0;
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_create: cacheCreate,
    reasoning,
    total: input + output + cacheRead + cacheCreate,
  };
}

function addTokens(bucket, tokens) {
  for (const key of Object.keys(bucket)) bucket[key] += tokens[key];
}

// Role labels and tool names are client-supplied strings. Accumulate them in
// Maps, never as plain-object properties: `byRole['constructor']` reads
// Object.prototype.constructor (a function, so `+=` on it threw and took the
// proxy down), and assigning `obj['__proto__']` rewires the prototype.
// Object.fromEntries defines OWN properties, so the JSON output is safe too.
function addCounts(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [name, count] of Object.entries(source)) {
    target.set(name, (target.get(name) || 0) + (typeof count === 'number' ? count : 1));
  }
}

function confidenceBucket() {
  return { priced: 0, unknown: 0, fallback: 0, no_usage: 0 };
}

// ADR 0017: an aggregate that silently sums unknown costs as zero is an
// unmarked under-count. Classify every entry so the caller can mark the total.
function costFacts(entry) {
  const hasUsage = !!(entry.usage && typeof entry.usage === 'object');
  const cost = entry.cost && typeof entry.cost === 'object' ? entry.cost : null;
  const priced = !!cost && typeof cost.cost === 'number' && Number.isFinite(cost.cost);
  return {
    amount: priced ? cost.cost : 0,
    priced,
    fallback: priced && cost.confidence === 'fallback',
    unknown: hasUsage && !priced,
    noUsage: !hasUsage,
  };
}

function addConfidence(bucket, facts) {
  if (facts.noUsage) bucket.no_usage += 1;
  else if (facts.unknown) bucket.unknown += 1;
  else bucket.priced += 1;
  if (facts.fallback) bucket.fallback += 1;
}

function cacheHitRate(tokens) {
  const denom = tokens.input + tokens.cache_read + tokens.cache_create;
  return denom > 0 ? Math.round((tokens.cache_read / denom) * 1000) / 1000 : 0;
}

function roundUsd(value) {
  return Math.round(value * 10000) / 10000;
}

// An entry that declared its project must match exactly. One that did not (a
// header-only integrator that sent no project) falls back to its cwd, matched
// as a whole PATH SEGMENT: a substring test would let `ipadpos` swallow a
// worker running in `…/ipadpos-web`.
function matchesProject(entry, project) {
  if (!project) return true;
  if (entry.taskProject) return entry.taskProject === project;
  if (!entry.cwd) return true;
  return String(entry.cwd).split(/[\\/]+/).includes(project);
}

const MAX_SESSION_SPECS = 32;

// Parse the public session interval grammar without consulting server state.
// `to` is materialized for an open-ended interval so callers can use the same
// object both for selection and for the per-session response breakdown.
function parseSessionSpecs(values, now = Date.now()) {
  const rawValues = Array.isArray(values) ? values : (values == null ? [] : [values]);
  const current = Number(now);
  const openEndedTo = Number.isSafeInteger(current) ? current : Date.now();
  const specs = [];

  for (const value of rawValues.slice(0, MAX_SESSION_SPECS)) {
    if (typeof value !== 'string') continue;
    const match = /^([^@]+)@([0-9]+)-([0-9]*)$/.exec(value);
    if (!match) continue;
    const from = Number(match[2]);
    const to = match[3] === '' ? openEndedTo : Number(match[3]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) continue;
    specs.push({ session: match[1], from, to });
  }
  return specs;
}

function validSessionSpec(spec) {
  return !!spec
    && typeof spec.session === 'string'
    && spec.session.length > 0
    && Number.isSafeInteger(spec.from)
    && Number.isSafeInteger(spec.to)
    && spec.from <= spec.to;
}

function entrySelectionKey(entry) {
  if (entry && entry.id !== undefined && entry.id !== null) return `id:${String(entry.id)}`;
  return entry;
}

function matchesSessionSpec(entry, spec) {
  if (!entry || entry.sessionId !== spec.session) return false;
  const receivedAt = Number(entry.receivedAt);
  return Number.isFinite(receivedAt) && receivedAt >= spec.from && receivedAt <= spec.to;
}

function selectTaskEntries(labelEntries, sessionEntries, { task, role, project, sessionSpecs }) {
  const selected = [];
  const byKey = new Map();
  const hasSessionSpecs = sessionSpecs.length > 0;

  const add = (entry, sessionSelected, sessionEntry = entry) => {
    if (!entry) return;
    if (!hasSessionSpecs) {
      selected.push({ entry, sessionSelected: false, sessionEntry });
      return;
    }
    const key = entrySelectionKey(entry);
    const existing = byKey.get(key);
    if (existing) {
      // A disk copy may be the same entry that is still in the in-memory
      // window. Session selection wins its role classification, but the first
      // object remains the source for the aggregate fields.
      if (sessionSelected) {
        existing.sessionSelected = true;
        existing.sessionEntry = sessionEntry;
      }
      return;
    }
    const record = { entry, sessionSelected: !!sessionSelected, sessionEntry };
    byKey.set(key, record);
    selected.push(record);
  };

  // Preserve the old labelled-task path unless this is the reserved
  // role=coordinator query with valid intervals.
  if (!(hasSessionSpecs && role === 'coordinator')) {
    for (const entry of labelEntries) {
      if (!entry || entry.task !== task) continue;
      if (role && entry.role !== role) continue;
      if (!matchesProject(entry, project)) continue;
      add(entry, false);
    }
  }

  // A session interval is an explicit coordinator assignment. It may include
  // an unlabelled entry or one carrying the requested task, but never an entry
  // labelled for a different task. Project filtering belongs to the labelled
  // path; Agentflow owns the session-to-Ask interval binding.
  if (hasSessionSpecs && (!role || role === 'coordinator')) {
    for (const entry of sessionEntries) {
      if (!entry || !sessionSpecs.some(spec => matchesSessionSpec(entry, spec))) continue;
      if (entry.task !== undefined && entry.task !== null && entry.task !== '' && entry.task !== task) continue;
      add(entry, true);
    }
  }

  return selected;
}

function summarizeTask(entries, optionsOrSessionEntries = {}, maybeOptions) {
  const labelEntries = Array.isArray(entries) ? entries : [];
  let options;
  let sessionEntries;
  if (Array.isArray(optionsOrSessionEntries)) {
    sessionEntries = optionsOrSessionEntries;
    options = maybeOptions || {};
  } else {
    options = optionsOrSessionEntries || {};
    sessionEntries = Object.prototype.hasOwnProperty.call(options, 'sessionEntries')
      ? options.sessionEntries
      : labelEntries;
  }
  if (!Array.isArray(sessionEntries)) sessionEntries = [];

  const { task, role = null, project = null } = options;
  const sessionSpecs = Array.isArray(options.sessionSpecs)
    ? options.sessionSpecs.filter(validSessionSpec)
    : [];
  const selected = selectTaskEntries(labelEntries, sessionEntries, {
    task, role, project, sessionSpecs,
  });
  const tokens = tokenBucket();
  const confidence = confidenceBucket();
  const byRole = new Map();
  const tools = new Map();
  const skills = new Map();
  const models = new Set();
  const agents = new Set();
  const sessions = new Set();
  let calls = 0;
  let cost = 0;
  let toolFailures = 0;
  let firstTs = null;
  let lastTs = null;

  for (const record of selected) {
    const e = record.entry;

    calls += 1;
    const t = entryTokens(e.usage);
    addTokens(tokens, t);
    const facts = costFacts(e);
    cost += facts.amount;
    addConfidence(confidence, facts);

    const roleKey = record.sessionSelected ? 'coordinator' : (e.role || 'unattributed');
    let r = byRole.get(roleKey);
    if (!r) {
      r = { calls: 0, cost: 0, tokens: tokenBucket(), confidence: confidenceBucket() };
      byRole.set(roleKey, r);
    }
    r.calls += 1;
    r.cost += facts.amount;
    addTokens(r.tokens, t);
    addConfidence(r.confidence, facts);

    // Per-turn fields are preferred: toolCalls/toolFail are cumulative over the
    // request history and would count one tool call once per later turn (#427).
    if (e.turnToolFail ?? e.toolFail) toolFailures += 1;
    addCounts(tools, e.turnToolCalls || e.toolCalls);
    addCounts(skills, e.skillCalls);

    if (e.model) models.add(e.model);
    if (e.agent) agents.add(e.agent);
    if (e.sessionId) sessions.add(e.sessionId);
    if (Number.isFinite(e.receivedAt)) {
      if (firstTs === null || e.receivedAt < firstTs) firstTs = e.receivedAt;
      if (lastTs === null || e.receivedAt > lastTs) lastTs = e.receivedAt;
    }
  }

  const by_role = Object.fromEntries([...byRole.entries()].map(([name, r]) => [name, {
    calls: r.calls,
    cost_usd: roundUsd(r.cost),
    cost_confidence: r.confidence,
    tokens: r.tokens,
    cache_hit_rate: cacheHitRate(r.tokens),
  }]));

  const summary = {
    task,
    role: role || null,
    project: project || null,
    calls,
    cost_usd: roundUsd(cost),
    // priced: entries whose cost is a number; unknown: usage present but no
    // price (cost_usd under-counts them); fallback: priced with a default rate;
    // no_usage: recorded without a usage object (a still-open or usage-less
    // turn), counted in `calls` but contributing no tokens or cost.
    cost_confidence: confidence,
    tokens,
    cache_hit_rate: cacheHitRate(tokens),
    tools: Object.fromEntries(tools),
    tool_failures: toolFailures,
    skills: Object.fromEntries(skills),
    by_role,
    models: [...models].sort(),
    agents: [...agents].sort(),
    sessions: sessions.size,
    first_ts: firstTs,
    last_ts: lastTs,
  };

  if (sessionSpecs.length > 0) {
    const sessionSelected = selected.filter(record => record.sessionSelected);
    summary.coordinator = {
      calls: sessionSelected.length,
      cost_usd: roundUsd(sessionSelected.reduce((total, record) => total + costFacts(record.entry).amount, 0)),
      sessions: sessionSpecs.map(spec => {
        const seen = new Set();
        let callsForSpec = 0;
        for (const record of sessionSelected) {
          const sessionEntry = record.sessionEntry || record.entry;
          if (!matchesSessionSpec(sessionEntry, spec)) continue;
          const key = entrySelectionKey(sessionEntry);
          if (seen.has(key)) continue;
          seen.add(key);
          callsForSpec += 1;
        }
        return { session: spec.session, from: spec.from, to: spec.to, calls: callsForSpec };
      }),
    };
  }

  return summary;
}

module.exports = { summarizeTask, entryTokens, matchesProject, parseSessionSpecs };
