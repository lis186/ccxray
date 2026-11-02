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

// Opens without ever blocking or following a link: O_NONBLOCK keeps a FIFO with no
// writer from stalling the open, O_NOFOLLOW refuses a symlink. The descriptor is
// then checked, and only a regular file is read, sized from the descriptor itself.
// Anything else counts as "no data".
function readTail(file, io) {
  let fd = null;
  try {
    const c = fs.constants;
    fd = io.openSync(file, (c.O_RDONLY || 0) | (c.O_NONBLOCK || 0) | (c.O_NOFOLLOW || 0));
    const st = io.fstatSync(fd);
    if (!st.isFile()) return '';
    const len = Math.min(st.size, MAX_READ_BYTES);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = io.readSync(fd, buf, got, len - got, st.size - len + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.toString('utf8', 0, got);
  } catch { return ''; } finally {
    if (fd !== null) { try { io.closeSync(fd); } catch { /* already closed */ } }
  }
}

// The writers rotate the active log to `<log>.1` once it passes ~1 MiB, so both
// files are the retained history: `total` means "retained", not "ever" (the
// active log plus one rotated generation, each read from its last 2 MiB).
function summarizeBypasses(home, { now = Date.now(), windowMs = WINDOW_MS, io = fs } = {}) {
  const out = { recent: 0, total: 0, refused: 0, windowMs, lastAt: null, byReason: {}, byTool: {} };
  const file = bypassLogPath(home);
  const text = readTail(`${file}.1`, io) + '\n' + readTail(file, io);
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
  return `Launcher bypasses: ${summary.recent} in the last 24h${reasons ? ` (${reasons})` : ''}, ${summary.total} retained — those launches were NOT recorded`;
}

module.exports = { bypassLogPath, summarizeBypasses, renderBypassLine };
