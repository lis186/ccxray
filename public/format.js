// ── Shared formatting/color helpers (#156) ──────────────────────────────
// No-build browser globals. Loaded before miller-columns.js, workflow-timeline.js,
// entry-rendering.js, and intercept-ui.js — every function here is consumed as a
// bare global by those files.

// #142: single source for context-usage bands (pct>80 red / >=40 yellow / else safe).
function ctxZone(pct) {
  if (pct > 80) return { zone: 'danger', cssVar: 'var(--red)', hex: '#f85149' };
  if (pct >= 40) return { zone: 'warn', cssVar: 'var(--yellow)', hex: '#d29922' };
  return { zone: 'safe', cssVar: null, hex: '#3fb950' };
}

// #253: single source of truth for context-window usage — cache creation +
// cache read + input + output tokens (the full request cost the next turn pays).
function computeCtxUsed(usage) {
  if (!usage) return 0;
  return (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.input_tokens || 0)
    + (usage.output_tokens || 0);
}

// Strip the "claude-" prefix and a trailing YYYYMMDD date suffix.
function shortModel(m) {
  return (m || '?').replace('claude-', '').replace(/-[0-9]{8}$/, '');
}

const MODEL_COLORS = {
  'claude-opus-4-6': '#58a6ff', 'claude-opus-4-8': '#7ee787', 'claude-fable-5': '#d2a8ff',
  'claude-sonnet-4-6': '#ffa657', 'claude-haiku-4-5': '#f0883e', 'claude-haiku-4-5-20251001': '#f0883e',
};
// Single source of truth for model→color (exact, then prefix). Falls back to a
// concrete hex (not var(--dim)) so callers can safely alpha-suffix (color+'22').
function modelColor(m) {
  if (!m) return '#8b949e';
  return MODEL_COLORS[m] || Object.entries(MODEL_COLORS).find(function(kv) { return m.startsWith(kv[0]); })?.[1] || '#8b949e';
}

function formatGap(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), rem = s % 60;
  if (m < 60) return m + 'm' + (rem ? rem + 's' : '');
  return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}

function formatRelativeTimeFromMs(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return Math.floor(diff / 604800000) + 'w ago';
}

function formatEntryDate(id) {
  // id format: "2026-03-08T17-47-13-000"
  if (!id || id.length < 16) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = parseInt(id.slice(5, 7)) - 1;
  const day = id.slice(8, 10);
  const hour = id.slice(11, 13);
  const min = id.slice(14, 16);
  if (month < 0 || month > 11) return '';
  return months[month] + ' ' + day + '  ' + hour + ':' + min;
}

function formatRelativeTime(id) {
  if (!id || id.length < 19) return formatEntryDate(id);
  const ts = new Date(id.slice(0, 10) + 'T' + id.slice(11, 19).replace(/-/g, ':')).getTime();
  if (!ts) return formatEntryDate(id);
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return formatEntryDate(id);
}

function formatEntryDateShort(id) {
  if (!id || id.length < 10) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = parseInt(id.slice(5, 7)) - 1;
  const day = id.slice(8, 10);
  if (month < 0 || month > 11) return '';
  return months[month] + ' ' + day;
}

function fmtDur(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 3600000) return (ms / 60000).toFixed(1) + 'm';
  return (ms / 3600000).toFixed(1) + 'h';
}

function fmtMin(ms, base) {
  const s = (ms - base) / 1000;
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return (s / 60).toFixed(s < 600 ? 1 : 0) + 'm';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h + 'h' + (m ? m + 'm' : '');
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = JSON.stringify(s, null, 2);
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
