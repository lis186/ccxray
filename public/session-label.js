'use strict';

const NAMED_SESSION_LABELS = Object.freeze({
  'direct-api': 'direct API',
  'codex-raw': 'Codex Raw',
});

function formatSessionIdLabel(sid) {
  if (!sid) return '?';
  if (NAMED_SESSION_LABELS[sid]) return NAMED_SESSION_LABELS[sid];
  return sid.slice(0, 8);
}

function formatSessionUrlToken(sid) {
  if (!sid) return '';
  if (NAMED_SESSION_LABELS[sid]) return sid;
  return sid.slice(0, 8);
}

// Returns the visible label for a session card / breadcrumb / intercept overlay.
// Prefers the Claude Code title-generator output when present; otherwise falls
// back to the short id or a friendly label for synthetic named sessions.
function formatSessionLabel(sess, sid) {
  if (sess && sess.title) return sess.title;
  return formatSessionIdLabel(sid);
}

function formatSessionTooltip(sess, sid) {
  const shortSid = formatSessionIdLabel(sid);
  if (sess && sess.title) return sess.title + ' · ' + shortSid;
  if (NAMED_SESSION_LABELS[sid]) return shortSid + ' · ' + sid;
  return sid || shortSid;
}

if (typeof window !== 'undefined') {
  window.formatSessionIdLabel = formatSessionIdLabel;
  window.formatSessionLabel = formatSessionLabel;
  window.formatSessionTooltip = formatSessionTooltip;
  window.formatSessionUrlToken = formatSessionUrlToken;
}
