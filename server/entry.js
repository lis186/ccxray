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
  // INVARIANT: authoritative 1M-window signal — the non-lagging anthropic-beta
  // `context-1m-*` request header (#339). Persisted so restore/cold-load can
  // derive a per-session consistent context% denominator (sessionWindow) instead
  // of re-inferring from incomplete facts. Written only when true (absent = no
  // positive signal; monotone OR-fold). Classification keeps raw per-turn
  // maxContext — never derived from this. See docs/decisions/0013-beta1m-persist-session-window-derive.md
  'beta1m',
];

function buildIndexLine(entry) {
  const out = {};
  for (const k of INDEX_FIELDS) if (entry[k] !== undefined) out[k] = entry[k];
  return JSON.stringify(out);
}

module.exports = { INDEX_FIELDS, buildIndexLine };
