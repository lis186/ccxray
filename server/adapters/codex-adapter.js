'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizeEpoch(v) {
  return v > 1e10 ? Math.floor(v / 1000) : v;
}

function findLatestRateLimits(sessionsDir) {
  let entries;
  try { entries = fs.readdirSync(sessionsDir); } catch { return null; }

  const jsonls = entries
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      try {
        const st = fs.statSync(path.join(sessionsDir, f));
        return { name: f, mtime: st.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20);

  for (const { name } of jsonls) {
    const content = fs.readFileSync(path.join(sessionsDir, name), 'utf8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'event_msg' && obj.payload?.type === 'token_count' && obj.payload?.rate_limits) {
          return obj.payload.rate_limits;
        }
      } catch { /* skip malformed lines */ }
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
