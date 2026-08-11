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
];

const OMIT_IF_NULL = new Set([
  'agentId','userEmail','team','agentType','localDate','tz','duplicateToolCalls',
]);

function deploymentFields(ts) {
  const fields = {};
  for (const [key, envName] of [
    ['agentId', 'CCXRAY_AGENT_ID'], ['userEmail', 'CCXRAY_USER_EMAIL'],
    ['team', 'CCXRAY_TEAM'], ['agentType', 'CCXRAY_AGENT_TYPE'],
  ]) {
    if (process.env[envName]) fields[key] = process.env[envName];
  }
  if (process.env.CCXRAY_INDEX_LOCALE !== '1') return fields;
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
