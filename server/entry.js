'use strict';

const INDEX_FIELDS = [
  'id','ts','sessionId','provider','agent','model','msgCount','toolCount','toolCalls','skillCalls',
  'isSubagent','sessionInferred','cwd','isSSE','usage','cost','maxContext','responseMetadata',
  'stopReason','title','thinkingDuration','toolFail','elapsed','status','receivedAt',
  'sysHash','toolsHash','coreHash','agentKey','agentLabel','convId','thinkingStripped','hasCredential','toolSources',
  'edited','editSummary',
  'imported','importSource',
];

function buildIndexLine(entry) {
  const out = {};
  for (const k of INDEX_FIELDS) if (entry[k] !== undefined) out[k] = entry[k];
  return JSON.stringify(out);
}

module.exports = { INDEX_FIELDS, buildIndexLine };
