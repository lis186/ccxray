'use strict';

// Completeness labels (docs/agentflow-integration.md, Completeness): whether a
// host's traffic went through the proxy, judged per host, then folded per Ask.

// One host session's turns. Claude: a transcript turn with a proxy twin (same
// responseId) proves the proxy saw it; a session's base URL is fixed at launch,
// so twins for every transcript turn mean its proxy-only requests were seen too.
// Codex has no responseId and follows the one-source-per-session rule.
function hostCompleteness(turns, codexSources = {}) {
  if (!turns.length) return 'unknown';
  const provider = turns[0].provider;
  if (provider && provider !== 'anthropic') {
    return codexSources[turns[0].sessionId] === 'proxy' ? 'complete' : 'transcripts only';
  }
  const transcriptTurns = turns.filter(e => e.sources && e.sources.includes('import'));
  if (!transcriptTurns.length) return turns.some(e => e.sources && e.sources.includes('proxy')) ? 'complete' : 'unknown';
  const twins = transcriptTurns.filter(e => e.sources.includes('proxy')).length;
  if (twins === transcriptTurns.length) return 'complete';
  return twins ? 'partial proxy coverage' : 'transcripts only';
}

// Several hosts in one Ask: complete only when every host is, transcripts only
// only when every host is; no host at all is `unknown`.
function foldCompleteness(labels) {
  if (!labels.length) return 'unknown';
  if (labels.every(l => l === 'complete')) return 'complete';
  if (labels.every(l => l === 'transcripts only')) return 'transcripts only';
  return 'partial proxy coverage';
}

module.exports = { hostCompleteness, foldCompleteness };
