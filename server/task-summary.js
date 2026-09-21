'use strict';

const { describeAgentModule } = require('./providers');

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

const CHARGE_COMPONENTS = Object.freeze([
  ['input', 'input_tokens'],
  ['output', 'output_tokens'],
  ['cache_read', 'cache_read_input_tokens'],
  ['cache_create', 'cache_creation_input_tokens'],
]);

// Pricing rates arrive as JSON numbers, but the aggregate must not sum their
// binary floating-point products. Keep a decimal coefficient and a base-10
// scale so quantity * rate / 1M can be rendered exactly.
function parseDecimal(value) {
  if (typeof value === 'bigint') return { coefficient: value, scale: 0 };
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : String(value).trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2] || '';
  const fraction = match[3] ?? match[4] ?? '';
  const exponent = match[5] ? Number(match[5]) : 0;
  if (!Number.isSafeInteger(exponent)) return null;
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  let coefficient;
  try { coefficient = sign * BigInt(digits); } catch { return null; }
  let scale = fraction.length - exponent;
  if (scale < 0) {
    if (-scale > 1000) return null;
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (scale > 1000) return null;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function decimalString(coefficient, scale) {
  if (coefficient === 0n) return '0';
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.length <= scale
    ? `${'0'.repeat(scale - digits.length + 1)}${digits}`
    : digits;
  const split = padded.length - scale;
  return `${negative ? '-' : ''}${padded.slice(0, split)}.${padded.slice(split)}`;
}

function addDecimal(target, value) {
  if (!value) return;
  if (target.scale < value.scale) {
    target.coefficient *= 10n ** BigInt(value.scale - target.scale);
    target.scale = value.scale;
  }
  target.coefficient += value.coefficient * 10n ** BigInt(target.scale - value.scale);
}

function roundedDecimal(coefficient, scale, places) {
  if (scale <= places) {
    return { coefficient: coefficient * 10n ** BigInt(places - scale), scale: places };
  }
  const divisor = 10n ** BigInt(scale - places);
  let rounded = coefficient / divisor;
  const remainder = coefficient < 0n ? -coefficient % divisor : coefficient % divisor;
  if (remainder * 2n >= divisor) rounded += coefficient < 0n ? -1n : 1n;
  return { coefficient: rounded, scale: places };
}

function costUsd(aggregate) {
  const rounded = roundedDecimal(aggregate.cost.coefficient, aggregate.cost.scale, 4);
  return Number(decimalString(rounded.coefficient, rounded.scale));
}

function tokenQuantity(value) {
  const parsed = parseDecimal(value ?? 0);
  if (!parsed || parsed.coefficient < 0n || parsed.scale !== 0) return 0n;
  return parsed.coefficient;
}

function rateDescriptor(value) {
  const parsed = parseDecimal(value);
  if (!parsed || parsed.coefficient < 0n) return null;
  return {
    ...parsed,
    text: decimalString(parsed.coefficient, parsed.scale),
  };
}

function chargeUsd(quantity, rate) {
  return decimalString(quantity * rate.coefficient, rate.scale + 6);
}

function billingProvider(entry) {
  for (const key of ['billing_provider', 'billingProvider', 'upstreamKey', 'upstream']) {
    if (typeof entry?.[key] === 'string' && entry[key]) return entry[key];
  }
  if (typeof entry?.agent === 'string') {
    const module = describeAgentModule(entry.agent);
    if (module?.upstreamKey) return module.upstreamKey;
  }
  return typeof entry?.provider === 'string' && entry.provider ? entry.provider : null;
}

function createAggregate() {
  return {
    calls: 0,
    cost: { coefficient: 0n, scale: 0 },
    tokens: tokenBucket(),
    confidence: confidenceBucket(),
    uncomputableRequests: 0,
    charges: new Map(),
    lastIngestedAt: null,
    pendingRequests: 0,
  };
}

function receivedAtMs(entry) {
  const value = Number(entry?.receivedAt);
  return Number.isFinite(value) ? value : null;
}

function addCharges(target, entry) {
  if (!entry?.usage || typeof entry.usage !== 'object') return false;
  const cost = entry.cost && typeof entry.cost === 'object' ? entry.cost : null;
  const model = entry.model == null ? null : String(entry.model);
  const provider = billingProvider(entry);
  let hasUnpriced = false;
  for (const [component, usageKey] of CHARGE_COMPONENTS) {
    const quantity = tokenQuantity(entry.usage[usageKey]);
    if (quantity === 0n) continue;
    const rawRate = cost?.rates && typeof cost.rates === 'object'
      ? cost.rates[component]
      : null;
    const rate = parsedCostAmount(cost) ? rateDescriptor(rawRate) : null;
    if (!rate) hasUnpriced = true;
    const basis = rate ? (cost?.confidence === 'fallback' ? 'fallback' : 'recorded') : 'unpriced';
    const rateText = rate ? rate.text : null;
    // Include provider in the identity so the bucket remains self-sufficient
    // when two upstreams price the same model differently.
    const bucketKey = JSON.stringify([model, provider, component, rateText, basis]);
    let bucket = target.charges.get(bucketKey);
    if (!bucket) {
      bucket = {
        model,
        billing_provider: provider,
        component,
        unit: 'tokens',
        quantity: 0n,
        rate,
        usd_per_unit: rate ? rate.text : null,
        basis,
        price_key: model,
        rate_source: 'ccxray',
      };
      target.charges.set(bucketKey, bucket);
    }
    bucket.quantity += quantity;
  }
  return hasUnpriced;
}

function chargesArray(charges) {
  return [...charges.values()].map(bucket => ({
    model: bucket.model,
    billing_provider: bucket.billing_provider,
    component: bucket.component,
    unit: bucket.unit,
    quantity: bucket.quantity.toString(),
    usd_per_unit: bucket.usd_per_unit,
    usd: bucket.rate ? chargeUsd(bucket.quantity, bucket.rate) : null,
    basis: bucket.basis,
    price_key: bucket.price_key,
    rate_source: bucket.rate_source,
  }));
}

function addAggregate(target, entry, tokens, facts) {
  target.calls += 1;
  addDecimal(target.cost, facts.amount);
  addTokens(target.tokens, tokens);
  addConfidence(target.confidence, facts);
  if (addCharges(target, entry)) target.uncomputableRequests += 1;
  const receivedAt = receivedAtMs(entry);
  if (receivedAt !== null && (target.lastIngestedAt === null || receivedAt > target.lastIngestedAt)) {
    target.lastIngestedAt = receivedAt;
  }
  if (entry.status === null) target.pendingRequests += 1;
}

function lastIngestedIso(timestamp) {
  return timestamp === null ? null : new Date(timestamp).toISOString();
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

function parsedCostAmount(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const raw = cost.cost;
  if (typeof raw === 'number' && !Number.isFinite(raw)) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const parsed = parseDecimal(raw);
  return parsed && parsed.coefficient >= 0n ? parsed : null;
}

// ADR 0017: an aggregate that silently sums unknown costs as zero is an
// unmarked under-count. Classify every entry so the caller can mark the total.
function costFacts(entry) {
  const hasUsage = !!(entry.usage && typeof entry.usage === 'object');
  const cost = entry.cost && typeof entry.cost === 'object' ? entry.cost : null;
  const amount = parsedCostAmount(cost);
  // Keep the recorded per-entry cost as the source of truth. Rates are only
  // used for the optional charge buckets and must not be used to fill this in.
  const priced = !!amount;
  return {
    amount,
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

function parseEpochMs(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// Unlike session specs, the public task window has no open-ended syntax. A
// missing side is an open bound; a reversed pair is an invalid window and is
// ignored as a whole.
function parseTimeWindow(fromValue, toValue) {
  const from = parseEpochMs(fromValue);
  const to = parseEpochMs(toValue);
  if (from === null && to === null) return null;
  if (from !== null && to !== null && from >= to) return null;
  return { from, to };
}

function normalizeTimeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const from = typeof window.from === 'number' ? window.from : parseEpochMs(window.from);
  const to = typeof window.to === 'number' ? window.to : parseEpochMs(window.to);
  if ((from !== null && !Number.isSafeInteger(from)) || (to !== null && !Number.isSafeInteger(to))) return null;
  if (from === null && to === null) return null;
  if (from !== null && to !== null && from >= to) return null;
  return { from, to };
}

function matchesTimeWindow(entry, window) {
  if (!window) return true;
  const receivedAt = receivedAtMs(entry);
  if (receivedAt === null) return false;
  return (window.from === null || receivedAt >= window.from)
    && (window.to === null || receivedAt < window.to);
}

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

function isCoordinatorRole(role) {
  return role === null || role === undefined || role === '' || role === 'coordinator';
}

function selectTaskEntries(labelEntries, sessionEntries, { task, role, project, sessionSpecs, window }) {
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
      // window. Session selection wins only when the first copy is eligible
      // for coordinator attribution; a labelled worker must stay a worker.
      if (sessionSelected && isCoordinatorRole(existing.entry.role)) {
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
      if (!matchesTimeWindow(entry, window)) continue;
      add(entry, false);
    }
  }

  // A session interval is an explicit coordinator assignment. It may include
  // an unlabelled entry or one carrying the requested task, but never an entry
  // labelled for a different task or carrying another role. Project filtering
  // belongs to the labelled path; Agentflow owns the session-to-Ask interval
  // binding.
  if (hasSessionSpecs && (!role || role === 'coordinator')) {
    for (const entry of sessionEntries) {
      if (!entry || !sessionSpecs.some(spec => matchesSessionSpec(entry, spec))) continue;
      if (entry.task !== undefined && entry.task !== null && entry.task !== '' && entry.task !== task) continue;
      if (!isCoordinatorRole(entry.role)) continue;
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
  const window = normalizeTimeWindow(options.window);
  const selected = selectTaskEntries(labelEntries, sessionEntries, {
    task, role, project, sessionSpecs, window,
  });
  const aggregate = createAggregate();
  const coordinatorAggregate = createAggregate();
  const byRole = new Map();
  const tools = new Map();
  const skills = new Map();
  const models = new Set();
  const agents = new Set();
  const sessions = new Set();
  let toolFailures = 0;
  let firstTs = null;
  let lastTs = null;

  for (const record of selected) {
    const e = record.entry;

    const t = entryTokens(e.usage);
    const facts = costFacts(e);
    addAggregate(aggregate, e, t, facts);

    const roleKey = record.sessionSelected ? 'coordinator' : (e.role || 'unattributed');
    let r = byRole.get(roleKey);
    if (!r) {
      r = createAggregate();
      byRole.set(roleKey, r);
    }
    addAggregate(r, e, t, facts);
    if (record.sessionSelected) addAggregate(coordinatorAggregate, e, t, facts);

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
    cost_usd: costUsd(r),
    cost_confidence: r.confidence,
    uncomputable_requests: r.uncomputableRequests,
    tokens: r.tokens,
    cache_hit_rate: cacheHitRate(r.tokens),
    charges: chargesArray(r.charges),
    last_ingested_at: lastIngestedIso(r.lastIngestedAt),
    pending_requests: r.pendingRequests,
  }]));

  const summary = {
    task,
    role: role || null,
    project: project || null,
    calls: aggregate.calls,
    cost_usd: costUsd(aggregate),
    // priced: entries whose cost is a finite non-negative number or accepted
    // decimal string; unknown: usage present but no
    // price (cost_usd under-counts them); fallback: priced with a default rate;
    // no_usage: recorded without a usage object (a still-open or usage-less
    // turn), counted in `calls` but contributing no tokens or cost.
    cost_confidence: aggregate.confidence,
    uncomputable_requests: aggregate.uncomputableRequests,
    tokens: aggregate.tokens,
    cache_hit_rate: cacheHitRate(aggregate.tokens),
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
      calls: coordinatorAggregate.calls,
      cost_usd: costUsd(coordinatorAggregate),
      cost_confidence: coordinatorAggregate.confidence,
      uncomputable_requests: coordinatorAggregate.uncomputableRequests,
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
      charges: chargesArray(coordinatorAggregate.charges),
      last_ingested_at: lastIngestedIso(coordinatorAggregate.lastIngestedAt),
      pending_requests: coordinatorAggregate.pendingRequests,
    };
  }

  summary.charges = chargesArray(aggregate.charges);
  summary.last_ingested_at = lastIngestedIso(aggregate.lastIngestedAt);
  summary.pending_requests = aggregate.pendingRequests;
  summary.window = window;

  return summary;
}

module.exports = {
  summarizeTask,
  entryTokens,
  matchesProject,
  parseSessionSpecs,
  parseTimeWindow,
};
