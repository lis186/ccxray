#!/usr/bin/env node
'use strict';

// Synthetic-only, opt-in performance check (not part of the test lanes).
// node scripts/weather-replay-bench.js [replay-script] [heap-MiB=48]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-bench-'));
try {
  const index = path.join(dir, 'index.ndjson');
  const fd = fs.openSync(index, 'w');
  try {
    for (let turn = 0; turn < 12; turn++) {
      for (let sid = 0; sid < 6000; sid++) {
        fs.writeSync(fd, JSON.stringify({ id: `${sid}-${turn}`, sessionId: `session-${sid}`,
          responseId: `response-${sid}-${Math.floor(turn / 2)}`, provider: 'anthropic',
          receivedAt: turn, turnToolCallIds: { bash: 'Bash' },
          turnToolResults: [{ callId: 'bash', toolFail: sid % 3 === 0, eligible: true }],
          syntheticPadding: 'x'.repeat(900) }) + '\n');
      }
    }
  } finally { fs.closeSync(fd); }
  console.log(`fixtureBytes=${fs.statSync(index).size} lines=72000 sessions=6000`);
  const env = { ...process.env, HOME: dir, CCXRAY_HOME: dir };
  for (const key of ['LOGS_DIR', 'CCXRAY_AGENT_ID', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']) delete env[key];
  const script = path.resolve(process.argv[2] || path.join(__dirname, 'weather-replay.js'));
  const probe = path.join(dir, 'memory.cjs');
  fs.writeFileSync(probe, `let peak = 0;
    const sample = () => { peak = Math.max(peak, process.memoryUsage().heapUsed);
      require('fs').writeSync(2, 'heapSampleBytes=' + peak + '\\n'); };
    setInterval(sample, 100).unref();
    process.on('exit', () => { sample(); console.error('peakRSSKiB=' + process.resourceUsage().maxRSS); });`);
  const stdout = fs.openSync(path.join(dir, 'stdout'), 'w');
  const stderrPath = path.join(dir, 'stderr');
  const stderr = fs.openSync(stderrPath, 'w');
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [
    `--max-old-space-size=${process.argv[3] || 48}`, '--require', probe, script, '--index', index],
  { cwd: dir, env, stdio: ['ignore', stdout, stderr], timeout: 120000 });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  console.log(`wallSeconds=${Number(process.hrtime.bigint() - started) / 1e9}`);
  console.log(`status=${result.status} signal=${result.signal}`);
  console.log(fs.readFileSync(stderrPath, 'utf8'));
  if (result.error) throw result.error;
  process.exitCode = result.status === 0 ? 0 : 1;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
