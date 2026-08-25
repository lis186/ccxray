'use strict';

const INDEX_FIELDS = [
  'id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls','skillCalls',
  'isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','responseMetadata',
  'stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt',
  'sysHash','toolsHash','coreHash','agentKey','agentLabel','convId','thinkingStripped','hasCredential','toolSources',
  'edited','editSummary',
  'imported','importSource',
  // Dedup key for read-time merge (#333) — see docs/decisions/0012-response-id-read-time-merge.md
  'responseId',
  // #427: per-turn tool calls extracted from the response (not the cumulative
  // request history). Null on legacy entries — aggregators prefer this over
  // toolCalls when present.
  'turnToolCalls',
  // #438: per-turn tool failure from the last user message only (not cumulative).
  'turnToolFail',
  // #475: OpenAI response call ids and next-request result facts. Weather joins
  // these at read time; entries remain append-only after broadcast.
  'turnToolCallIds','turnToolResults',
  // INVARIANT: authoritative 1M-window signal — the non-lagging anthropic-beta
  // `context-1m-*` request header (#339). Persisted so restore/cold-load can
  // derive a per-session consistent context% denominator (sessionWindow) instead
  // of re-inferring from incomplete facts. Written only when true (absent = no
  // positive signal; monotone OR-fold). Classification keeps raw per-turn
  // maxContext — never derived from this. See docs/decisions/0013-beta1m-persist-session-window-derive.md
  'beta1m',
  // #504: optional deployment identity, local calendar metadata, and duplicate
  // request-history tool calls. Append-only: existing field order is stable.
  'agentId','userEmail','team','agentType','localDate','tz','duplicateToolCalls',
  // INVARIANT: `ctxBeta` is the OBSERVATION (the context-* entries of the
  // anthropic-beta header, verbatim); `beta1m` above is its INTERPRETATION, gated
  // on model capability. The two may legitimately disagree — a header on a model
  // the gate refuses stores ctxBeta and no beta1m — so reading ctxBeta presence as
  // "this turn ran 1M" reintroduces the #211 over-claim. Parse the tier with
  // config.contextBetaWindow(); never test truthiness. Whitelisted (no other
  // request header is persisted) and appended last to keep the field order
  // add-only (test/entry.test.js G1). See docs/decisions/0013-*.
  'ctxBeta',
  // #531: the parent session of a Herdr-launched agent, appended after ctxBeta to
  // keep the field order add-only on both sides of the merge.
  'parentSessionId',
  // #606: an upstream Codex `compacted` boundary, attached to the next emitted
  // turn. Append-only so existing index rows remain byte/order compatible.
  'compacted',
];

// INVARIANT: A new INDEX_FIELDS field whose no-value state is null rather than
// undefined must also be registered here, or every index row gains `"key":null`.
// Existing fields are intentionally absent and continue writing null; preserving
// that behavior is the #504 add-only guard. Tests that only feed an entry to
// buildIndexLine cannot catch caller omissions: deploymentFields is spread at
// the entry-construction paths in forward.js and ws-proxy.js, so assertions must
// exercise those construction paths.
const OMIT_IF_NULL = new Set([
  'agentId','userEmail','team','agentType','localDate','tz','duplicateToolCalls','parentSessionId',
]);

const DEPLOYMENT_ENV_FIELDS = [
  ['agentId', 'CCXRAY_AGENT_ID'], ['userEmail', 'CCXRAY_USER_EMAIL'],
  ['team', 'CCXRAY_TEAM'], ['agentType', 'CCXRAY_AGENT_TYPE'],
];

function deploymentFields(ts, opts = {}) {
  const env = opts.env || process.env;
  const identity = opts.identity || {};
  const useEnvIdentity = opts.useEnvIdentity !== false;
  const fields = {};
  for (const [key, envName] of DEPLOYMENT_ENV_FIELDS) {
    const value = identity[key] || (useEnvIdentity ? env[envName] : null);
    if (value) fields[key] = value;
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) fields.tz = tz;
  if (Number.isFinite(ts)) {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(ts));
    const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
    fields.localDate = `${byType.year}-${byType.month}-${byType.day}`;
  }
  return fields;
}

function buildIndexLine(entry) {
  const out = {};
  for (const k of INDEX_FIELDS) {
    if (entry[k] !== undefined && !(entry[k] === null && OMIT_IF_NULL.has(k))) out[k] = entry[k];
  }
  return JSON.stringify(out);
}

module.exports = { INDEX_FIELDS, buildIndexLine, deploymentFields };
