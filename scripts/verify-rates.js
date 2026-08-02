#!/usr/bin/env node
'use strict';

// Golden check: compare DEFAULT_PRICING against LiteLLM's live data.
// Usage:
//   node scripts/verify-rates.js          # fetch LiteLLM live
//   node scripts/verify-rates.js --cached # use pricing-cache.json

const https = require('https');
const fs = require('fs');
const path = require('path');

const { DEFAULT_PRICING, LITELLM_LAG_OVERRIDES } = require('../server/default-rates');

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_PATH = path.join(__dirname, '..', 'pricing-cache.json');
const TOLERANCE = 0.01;
const FIELDS = ['input', 'output', 'cache_create', 'cache_read'];

const lagOverrideIds = new Set(LITELLM_LAG_OVERRIDES.flatMap(e => e.wireIds));

function litellmToMTok(val) {
  return {
    input: (val.input_cost_per_token || 0) * 1_000_000,
    output: (val.output_cost_per_token || 0) * 1_000_000,
    cache_create: (val.cache_creation_input_token_cost || val.input_cost_per_token || 0) * 1_000_000,
    cache_read: (val.cache_read_input_token_cost || val.input_cost_per_token || 0) * 1_000_000,
  };
}

function mirrorXai(table) {
  const out = { ...table };
  for (const [key, val] of Object.entries(table)) {
    const slash = key.indexOf('/');
    if (slash === -1) continue;
    if (key.slice(0, slash) !== 'xai') continue;
    const bare = key.slice(slash + 1);
    if (bare && out[bare] == null) out[bare] = val;
  }
  return out;
}

function fetchLiteLLM() {
  return new Promise((resolve, reject) => {
    https.get(LITELLM_URL, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject).setTimeout(10000, function() { this.destroy(); reject(new Error('timeout')); });
  });
}

async function loadLiteLLM(useCached) {
  if (useCached) {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return cached.pricing || {};
  }
  const raw = await fetchLiteLLM();
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val.input_cost_per_token) out[key] = litellmToMTok(val);
  }
  return out;
}

function findPrefixCover(key, table) {
  // A LiteLLM key is "covered" if a DEFAULT_PRICING key is a prefix of it
  // (runtime: model.startsWith(tableKey)). NOT the reverse — a LiteLLM key
  // being a prefix of our key doesn't mean runtime would match it.
  const sorted = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const k of sorted) {
    if (key.startsWith(k)) return k;
  }
  return null;
}

async function main() {
  const useCached = process.argv.includes('--cached');
  const litellmRaw = await loadLiteLLM(useCached);
  const litellm = mirrorXai(litellmRaw);

  let mismatches = 0;
  const results = { match: [], mismatch: [], oursOnly: [], litellmOnly: [] };

  for (const [key, ours] of Object.entries(DEFAULT_PRICING)) {
    const theirs = litellm[key];
    if (!theirs) {
      const reason = lagOverrideIds.has(key) ? 'lag override' : 'not in LiteLLM';
      results.oursOnly.push({ key, reason });
      continue;
    }
    const diffs = [];
    for (const f of FIELDS) {
      if (Math.abs((ours[f] || 0) - (theirs[f] || 0)) > TOLERANCE) {
        diffs.push(`${f}: ours=${ours[f]} litellm=${theirs[f].toFixed(4)}`);
      }
    }
    if (diffs.length) {
      results.mismatch.push({ key, diffs });
      mismatches++;
    } else {
      results.match.push(key);
    }
  }

  for (const key of Object.keys(litellm)) {
    if (DEFAULT_PRICING[key]) continue;
    if (key.includes('/')) continue;
    const cover = findPrefixCover(key, DEFAULT_PRICING);
    results.litellmOnly.push({ key, cover });
  }

  for (const key of results.match) {
    const r = DEFAULT_PRICING[key];
    console.log(`✓ ${key.padEnd(25)} input=${r.input} output=${r.output} cache_create=${r.cache_create} cache_read=${r.cache_read}`);
  }
  for (const { key, diffs } of results.mismatch) {
    console.log(`✗ ${key.padEnd(25)} ${diffs.join(', ')}`);
  }
  for (const { key, reason } of results.oursOnly) {
    console.log(`? ${key.padEnd(25)} ${reason}`);
  }
  const uncovered = results.litellmOnly.filter(e => !e.cover);
  if (uncovered.length) {
    console.log(`\n○ ${uncovered.length} bare LiteLLM models not in DEFAULT_PRICING and not prefix-covered:`);
    for (const { key } of uncovered.slice(0, 10)) console.log(`  ${key}`);
    if (uncovered.length > 10) console.log(`  ... and ${uncovered.length - 10} more`);
  }

  console.log(`\nSummary: ${results.match.length} match, ${mismatches} mismatch, ${results.oursOnly.length} ours-only, ${results.litellmOnly.length} litellm-only (${uncovered.length} uncovered)`);
  process.exitCode = mismatches > 0 ? 1 : 0;
}

main().catch(e => { console.error(e.message); process.exitCode = 2; });
