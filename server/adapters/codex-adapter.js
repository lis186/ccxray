'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { normalizeEpoch } = require('./shared');

const CODEX_SCAN_MAX_FILES = 50;
const CODEX_SCAN_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

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
  const cutoff = Date.now() - CODEX_SCAN_MAX_AGE_MS;

  for (let i = 0; i < Math.min(all.length, CODEX_SCAN_MAX_FILES); i++) {
    if (all[i].mtime < cutoff) break;
    const filePath = all[i].path;
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

function buildSnap(rl, alias) {
  const id = `codex-${alias}`;
  // ponytail: business/unlimited plans have no primary/secondary, just credits
  if (!rl.primary && rl.credits?.unlimited) {
    return {
      id,
      label: alias === 'default' ? 'Codex' : `Codex · ${alias}`,
      provider: 'openai',
      planType: rl.plan_type || null,
      fiveHour: { usedPct: 0, resetsAt: null },
      sevenDay: null,
      unlimited: true,
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }
  if (!rl.primary) return null;
  return {
    id,
    label: alias === 'default' ? 'Codex' : `Codex · ${alias}`,
    provider: 'openai',
    planType: rl.plan_type || null,
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
}

function refreshCodex(sessionsDir, outDir, alias = 'default') {
  const rl = findLatestRateLimits(sessionsDir);
  if (!rl) return;
  const snap = buildSnap(rl, alias);
  if (!snap) return;

  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `${snap.id}.json`);
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(snap, null, 2));
  fs.renameSync(tmpPath, outPath);
}

async function collectJsonlsAsync(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const results = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { results.push(...await collectJsonlsAsync(full)); continue; }
    if (!ent.name.endsWith('.jsonl')) continue;
    try { results.push({ path: full, mtime: (await fsp.stat(full)).mtimeMs }); } catch {}
  }
  return results;
}

async function refreshCodexAsync(sessionsDir, outDir, alias = 'default') {
  const all = await collectJsonlsAsync(sessionsDir);
  if (!all.length) return;
  all.sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - CODEX_SCAN_MAX_AGE_MS;
  let rl = null;
  for (let i = 0; i < Math.min(all.length, CODEX_SCAN_MAX_FILES); i++) {
    if (all[i].mtime < cutoff) break;
    const content = await fsp.readFile(all[i].path, 'utf8');
    const lines = content.split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = lines[j].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'event_msg' && obj.payload?.type === 'token_count' && obj.payload?.rate_limits) {
          rl = obj.payload.rate_limits; break;
        }
      } catch {}
    }
    if (rl) break;
  }
  if (!rl) return;
  const snap = buildSnap(rl, alias);
  if (!snap) return;
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${snap.id}.json`);
  const tmpPath = outPath + '.tmp';
  await fsp.writeFile(tmpPath, JSON.stringify(snap, null, 2));
  await fsp.rename(tmpPath, outPath);
}

module.exports = { refreshCodex, refreshCodexAsync };
