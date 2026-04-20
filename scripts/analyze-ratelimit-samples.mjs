#!/usr/bin/env node
// Analyze ~/.ccxray/ratelimit-samples.jsonl to help calibrate plan-specific
// tokens5h/monthlyUSD constants (Max 5x vs 20x etc).
//
// Usage: node scripts/analyze-ratelimit-samples.mjs
import fs from 'node:fs';
import os from 'os';
import path from 'path';

const CCXRAY_HOME = process.env.CCXRAY_HOME || path.join(os.homedir(), '.ccxray');
const SAMPLES_FILE = path.join(CCXRAY_HOME, 'ratelimit-samples.jsonl');

if (!fs.existsSync(SAMPLES_FILE)) {
  console.log(`No samples yet at ${SAMPLES_FILE}`);
  console.log('Send a few Claude Code requests through the proxy to populate.');
  process.exit(0);
}

const lines = fs.readFileSync(SAMPLES_FILE, 'utf8').split('\n').filter(Boolean);
const samples = [];
for (const line of lines) {
  try { samples.push(JSON.parse(line)); } catch { /* skip malformed */ }
}

console.log(`Total samples: ${samples.length}`);
if (samples.length === 0) process.exit(0);

// Distribution by planHint + model
const byGroup = new Map();
for (const s of samples) {
  const key = `${s.planHint || '?'}  ${s.model || '?'}`;
  if (!byGroup.has(key)) byGroup.set(key, []);
  byGroup.get(key).push(s);
}

console.log('\n=== Distribution by plan hint × model ===');
console.log('plan        model                    n   tokensLimit    inputLimit    outputLimit   requestsLimit');
console.log('-'.repeat(110));
for (const [key, arr] of byGroup) {
  const [plan, model] = key.split(/\s{2,}/);
  const tok = mostCommon(arr.map(s => s.tokensLimit));
  const inp = mostCommon(arr.map(s => s.inputLimit));
  const out = mostCommon(arr.map(s => s.outputLimit));
  const req = mostCommon(arr.map(s => s.requestsLimit));
  console.log(
    `${(plan || '?').padEnd(10)}  ${(model || '?').padEnd(24)}  ${String(arr.length).padStart(3)}   ${fmt(tok).padStart(11)}   ${fmt(inp).padStart(10)}   ${fmt(out).padStart(11)}   ${fmt(req).padStart(13)}`
  );
}

// Time range
const timestamps = samples.map(s => new Date(s.ts)).filter(d => !isNaN(d)).sort((a, b) => a - b);
if (timestamps.length > 0) {
  console.log(`\nTime range: ${timestamps[0].toISOString()} → ${timestamps[timestamps.length - 1].toISOString()}`);
}

// Unique (tokensLimit, inputLimit) pairs — these are the distinct "plans" we've observed
const uniquePairs = new Set();
for (const s of samples) {
  if (s.tokensLimit != null) uniquePairs.add(`tokens=${s.tokensLimit}, input=${s.inputLimit || '?'}, output=${s.outputLimit || '?'}`);
}
console.log('\n=== Unique limit configurations ===');
for (const p of uniquePairs) console.log('  ' + p);

// Calibration hint
console.log('\n=== Calibration hint ===');
if (uniquePairs.size === 1) {
  const sample = samples[0];
  console.log(`Single plan observed. If you're on Max 5x, suggested PLAN_CONFIG.max5x.tokens5h = ${sample.tokensLimit}`);
  console.log(`If on Max 20x, this value is probably your limit — set PLAN_CONFIG.max20x.tokens5h = ${sample.tokensLimit}`);
  console.log(`Verify by sending through a different account or switching plan.`);
} else {
  console.log(`Multiple configurations seen. Likely plan transition or multi-model. Review per-group table above.`);
}

console.log(`\nFile: ${SAMPLES_FILE}`);

// ── helpers ──
function mostCommon(arr) {
  const freq = new Map();
  for (const v of arr) {
    if (v == null) continue;
    freq.set(v, (freq.get(v) || 0) + 1);
  }
  if (!freq.size) return null;
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function fmt(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}
