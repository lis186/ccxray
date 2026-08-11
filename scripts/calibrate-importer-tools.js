#!/usr/bin/env node
'use strict';

// #500 calibration: run parseSessionFile / parseCodexSessionFile against real
// transcripts and verify turnToolCallIds / turnToolResults extraction matches
// the issue's stated data profile.
//
// Usage: node scripts/calibrate-importer-tools.js [--codex]

const { parseSessionFile, parseCodexSessionFile, discoverHomes, discoverCodexHomes } = require('../server/importer');
const fs = require('fs');
const path = require('path');

const doCodex = process.argv.includes('--codex');
const doClaude = !doCodex || process.argv.includes('--claude');

async function collectJsonlFiles(dir) {
  const results = [];
  try {
    for (const item of fs.readdirSync(dir)) {
      if (item.endsWith('.jsonl')) results.push(path.join(dir, item));
    }
  } catch {}
  return results;
}

async function collectJsonlFilesRecursive(dir, results = []) {
  try {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) await collectJsonlFilesRecursive(full, results);
      else if (item.endsWith('.jsonl')) results.push(full);
    }
  } catch {}
  return results;
}

async function run() {
  const stats = {
    files: 0,
    entries: 0,
    withToolCallIds: 0,
    totalToolCalls: 0,
    withToolResults: 0,
    totalToolResults: 0,
    toolFailTrue: 0,
    toolFailFalse: 0,
    toolFailUndefined: 0,
    emptyCallIds: 0,
    emptyResults: 0,
  };

  if (doClaude) {
    console.log('=== Claude transcripts ===');
    const homes = discoverHomes();
    for (const { dir } of homes) {
      let projectDirs;
      try { projectDirs = fs.readdirSync(dir); } catch { continue; }
      for (const slug of projectDirs) {
        const projectPath = path.join(dir, slug);
        try { if (!fs.statSync(projectPath).isDirectory()) continue; } catch { continue; }
        const files = await collectJsonlFiles(projectPath);
        for (const file of files) {
          stats.files++;
          const entries = await parseSessionFile(file, slug);
          for (const e of entries) {
            stats.entries++;
            if (e.turnToolCallIds && Object.keys(e.turnToolCallIds).length > 0) {
              stats.withToolCallIds++;
              stats.totalToolCalls += Object.keys(e.turnToolCallIds).length;
            } else if (e.turnToolCallIds !== undefined) {
              stats.emptyCallIds++;
            }
            if (Array.isArray(e.turnToolResults) && e.turnToolResults.length > 0) {
              stats.withToolResults++;
              stats.totalToolResults += e.turnToolResults.length;
              for (const r of e.turnToolResults) {
                if (r.toolFail === true) stats.toolFailTrue++;
                else if (r.toolFail === false) stats.toolFailFalse++;
                else stats.toolFailUndefined++;
              }
            } else if (Array.isArray(e.turnToolResults)) {
              stats.emptyResults++;
            }
          }
        }
      }
    }
  }

  if (doCodex) {
    console.log('=== Codex transcripts ===');
    const homes = discoverCodexHomes();
    for (const { dir } of homes) {
      const files = await collectJsonlFilesRecursive(dir);
      for (const file of files) {
        stats.files++;
        const entries = await parseCodexSessionFile(file);
        for (const e of entries) {
          stats.entries++;
          if (e.turnToolCallIds && Object.keys(e.turnToolCallIds).length > 0) {
            stats.withToolCallIds++;
            stats.totalToolCalls += Object.keys(e.turnToolCallIds).length;
          } else if (e.turnToolCallIds !== undefined) {
            stats.emptyCallIds++;
          }
          if (Array.isArray(e.turnToolResults) && e.turnToolResults.length > 0) {
            stats.withToolResults++;
            stats.totalToolResults += e.turnToolResults.length;
            for (const r of e.turnToolResults) {
              if (r.toolFail === true) stats.toolFailTrue++;
              else if (r.toolFail === false) stats.toolFailFalse++;
              else stats.toolFailUndefined++;
            }
          } else if (Array.isArray(e.turnToolResults)) {
            stats.emptyResults++;
          }
        }
      }
    }
  }

  console.log('\n--- Calibration results ---');
  console.log(`Files scanned:          ${stats.files}`);
  console.log(`Entries parsed:         ${stats.entries}`);
  console.log(`With turnToolCallIds:   ${stats.withToolCallIds} (${stats.totalToolCalls} total calls)`);
  console.log(`Empty turnToolCallIds:  ${stats.emptyCallIds} ({}, processed)`);
  console.log(`With turnToolResults:   ${stats.withToolResults} (${stats.totalToolResults} total results)`);
  console.log(`Empty turnToolResults:  ${stats.emptyResults} ([], processed)`);
  console.log(`toolFail breakdown:`);
  console.log(`  true (error):         ${stats.toolFailTrue}`);
  console.log(`  false (checked-ok):   ${stats.toolFailFalse}`);
  console.log(`  undefined (no flag):  ${stats.toolFailUndefined}`);

  // Issue #500 stated profile checks
  const totalResults = stats.toolFailTrue + stats.toolFailFalse + stats.toolFailUndefined;
  if (totalResults > 0) {
    const hasIsErrorPct = ((stats.toolFailTrue + stats.toolFailFalse) / totalResults * 100).toFixed(1);
    const noIsErrorPct = (stats.toolFailUndefined / totalResults * 100).toFixed(1);
    console.log(`\n--- Profile check (issue #500 stated: 52% have is_error, 48% don't) ---`);
    console.log(`  has is_error:  ${hasIsErrorPct}% (${stats.toolFailTrue + stats.toolFailFalse}/${totalResults})`);
    console.log(`  no is_error:   ${noIsErrorPct}% (${stats.toolFailUndefined}/${totalResults})`);
  }

  if (stats.entries === 0) {
    console.log('\n⚠ No entries found. Check transcript paths.');
    process.exit(1);
  }
  console.log('\n✓ Calibration complete');
}

run().catch(err => { console.error(err); process.exit(1); });
