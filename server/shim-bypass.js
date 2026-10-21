'use strict';

// Reader for the launcher-shim bypass log (#732). The shim helper
// (server/shim/shim-probe.js) appends one JSON line per direct launch:
// {t, tool, cwd, reason, action}. This module only reads, and only exposes
// counts — never cwd — to the dashboard and `ccxray status`.

const fs = require('fs');
const path = require('path');

const WINDOW_MS = 24 * 3_600_000;
const MAX_READ_BYTES = 2 * 1024 * 1024;

function bypassLogPath(home) { return path.join(home, 'shim-bypass.log'); }

function summarizeBypasses(home, { now = Date.now(), windowMs = WINDOW_MS, io = fs } = {}) {
  const empty = { recent: 0, total: 0, refused: 0, windowMs, lastAt: null, byReason: {}, byTool: {} };
  let text;
  try {
    const file = bypassLogPath(home);
    const size = io.statSync(file).size;
    const fd = io.openSync(file, 'r');
    try {
      const len = Math.min(size, MAX_READ_BYTES);
      const buf = Buffer.alloc(len);
      io.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { io.closeSync(fd); }
  } catch { return empty; }
  const out = { ...empty, byReason: {}, byTool: {} };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // a cut first line or junk
    if (!rec || typeof rec.t !== 'string') continue;
    if (rec.action === 'refused') { out.refused++; continue; }
    out.total++;
    const at = Date.parse(rec.t);
    if (!Number.isFinite(at)) continue;
    if (out.lastAt === null || at > Date.parse(out.lastAt)) out.lastAt = rec.t;
    if (now - at <= windowMs) {
      out.recent++;
      const reason = typeof rec.reason === 'string' ? rec.reason : 'unknown';
      out.byReason[reason] = (out.byReason[reason] || 0) + 1;
      const tool = typeof rec.tool === 'string' ? rec.tool : 'unknown';
      out.byTool[tool] = (out.byTool[tool] || 0) + 1;
    }
  }
  return out;
}

function renderBypassLine(summary) {
  if (!summary || summary.total === 0) return 'Launcher bypasses: none recorded';
  const reasons = Object.entries(summary.byReason).map(([r, n]) => `${r}×${n}`).join(', ');
  return `Launcher bypasses: ${summary.recent} in the last 24h${reasons ? ` (${reasons})` : ''}, ${summary.total} total — those launches were NOT recorded`;
}

module.exports = { bypassLogPath, summarizeBypasses, renderBypassLine };
