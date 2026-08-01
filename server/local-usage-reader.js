'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FRESH_THRESHOLD_S = 90;

function formatDuration(seconds) {
  if (seconds <= 0) return '';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function enrichWindow(win, nowS) {
  if (!win) return null;
  const usedPct = win.usedPct || 0;
  // One-decimal left% (weekly quotas can be <<1% used). Null-safe resetsAt.
  const leftPct = Math.round(Math.max(0, 100 - usedPct) * 10) / 10;
  // Only emit resetLabel when upstream/provider supplied a real resetsAt.
  // (Grok leaves resetsAt null — do not invent a countdown.)
  let resetLabel = '';
  if (win.resetsAt != null) {
    const remaining = win.resetsAt - nowS;
    if (remaining > 0) resetLabel = formatDuration(remaining);
  }
  return { ...win, leftPct, resetLabel };
}

function readAllAccounts(statusDir) {
  let entries;
  try { entries = fs.readdirSync(statusDir); } catch { return []; }

  const nowS = Math.floor(Date.now() / 1000);
  const accounts = [];

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.resolve(statusDir, name);
    if (!filePath.startsWith(path.resolve(statusDir) + path.sep) && filePath !== path.resolve(statusDir)) continue;
    try { if (fs.lstatSync(filePath).isSymbolicLink()) continue; } catch { continue; }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const snap = JSON.parse(raw);
      // Allow weekly-only snaps (Grok); Claude/Codex always set fiveHour.
      if (!snap.id || (!snap.fiveHour && !snap.sevenDay && !snap.unlimited)) continue;

      accounts.push({
        ...snap,
        fiveHour: enrichWindow(snap.fiveHour, nowS),
        sevenDay: enrichWindow(snap.sevenDay, nowS),
        fresh: (nowS - snap.updatedAt) < FRESH_THRESHOLD_S,
      });
    } catch { /* skip malformed */ }
  }

  return accounts;
}

module.exports = { readAllAccounts };
