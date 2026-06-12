'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeEpoch } = require('./shared');

function collectJsonls(dir, result) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { collectJsonls(full, result); continue; }
    if (!ent.name.endsWith('.jsonl')) continue;
    try { result.push({ path: full, mtime: fs.statSync(full).mtimeMs }); } catch {}
  }
}

function findLatestRateLimits(sessionsDir) {
  const all = [];
  collectJsonls(sessionsDir, all);
  if (!all.length) return null;

  all.sort((a, b) => b.mtime - a.mtime);
  const candidates = all.slice(0, 5);

  for (const { path: filePath } of candidates) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'event_msg' && obj.payload?.type === 'token_count' && obj.payload?.rate_limits) {
          return obj.payload.rate_limits;
        }
      } catch {}
    }
  }
  return null;
}

function refreshCodex(sessionsDir, outDir) {
  const rl = findLatestRateLimits(sessionsDir);
  if (!rl || !rl.primary) return;

  fs.mkdirSync(outDir, { recursive: true });

  const snap = {
    id: 'codex-default',
    label: 'Codex',
    provider: 'openai',
    planType: rl.plan_type || 'unknown',
    fiveHour: {
      usedPct: rl.primary.used_percent,
      resetsAt: normalizeEpoch(rl.primary.resets_at),
    },
    sevenDay: rl.secondary ? {
      usedPct: rl.secondary.used_percent,
      resetsAt: normalizeEpoch(rl.secondary.resets_at),
    } : null,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  const outPath = path.join(outDir, 'codex-default.json');
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(snap, null, 2));
  fs.renameSync(tmpPath, outPath);
}

module.exports = { refreshCodex };
