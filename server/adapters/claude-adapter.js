#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function normalizeEpoch(v) {
  return v > 1e10 ? Math.floor(v / 1000) : v;
}

function parseArgs(argv) {
  const args = { outDir: null, delegate: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out-dir' && argv[i + 1]) args.outDir = argv[++i];
    else if (argv[i] === '--delegate' && argv[i + 1]) args.delegate = argv[++i];
  }
  return args;
}

function processInput(raw, outDir) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const rl = data?.rate_limits;
  if (!rl?.five_hour) return;

  fs.mkdirSync(outDir, { recursive: true });

  const snap = {
    id: 'claude-default',
    label: 'Claude',
    provider: 'anthropic',
    planType: null,
    fiveHour: {
      usedPct: rl.five_hour.used_percentage,
      resetsAt: normalizeEpoch(rl.five_hour.resets_at),
    },
    sevenDay: rl.seven_day ? {
      usedPct: rl.seven_day.used_percentage,
      resetsAt: normalizeEpoch(rl.seven_day.resets_at),
    } : null,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  const outPath = path.join(outDir, 'claude-default.json');
  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(snap, null, 2));
  fs.renameSync(tmpPath, outPath);
}

if (require.main === module) {
  const { outDir, delegate } = parseArgs(process.argv);
  const defaultOut = path.join(process.env.CCXRAY_HOME || path.join(require('node:os').homedir(), '.ccxray'), 'usage-status');
  const targetDir = outDir || defaultOut;

  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    processInput(raw, targetDir);

    if (delegate) {
      try {
        execFileSync(delegate, [], { input: raw, stdio: ['pipe', 'inherit', 'inherit'], timeout: 5000 });
      } catch { /* delegate failure is non-fatal */ }
    }
  });
}

module.exports = { processInput };
