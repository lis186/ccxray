#!/usr/bin/env node
'use strict';

// Weather calibration replay — runs assessWeather over real index data and
// reports per-session results for toggle-ON readiness evaluation.
// Usage: node scripts/weather-replay.js [--index path/to/index.ndjson]

var fs = require('fs');
var path = require('path');
var readline = require('readline');
var { assessWeather } = require('../public/weather');

var indexPath = process.argv.includes('--index')
  ? process.argv[process.argv.indexOf('--index') + 1]
  : path.join(process.env.CCXRAY_HOME || path.join(require('os').homedir(), '.ccxray'), 'logs', 'index.ndjson');

if (!fs.existsSync(indexPath)) {
  console.error('Index not found: ' + indexPath);
  process.exit(1);
}

var bySid = Object.create(null);
var ridSeen = Object.create(null);
var rl = readline.createInterface({ input: fs.createReadStream(indexPath), crlfDelay: Infinity });

rl.on('line', function(line) {
  if (!line) return;
  try {
    var m = JSON.parse(line);
    if (!m.sessionId || m.isSubagent) return;
    // dedup by responseId (match production _rebuildCore)
    if (m.responseId) {
      if (ridSeen[m.responseId]) return;
      ridSeen[m.responseId] = true;
    }
    if (!bySid[m.sessionId]) bySid[m.sessionId] = [];
    bySid[m.sessionId].push(m);
  } catch (e) { /* skip malformed */ }
});

rl.on('close', function() {
  var sids = Object.keys(bySid);
  var counts = { sunny: 0, fair: 0, cloudy: 0, rainy: 0, stormy: 0, unavailable: 0 };
  var withEvidence = 0;
  var falsePositives = [];

  for (var i = 0; i < sids.length; i++) {
    var turns = bySid[sids[i]];
    turns.sort(function(a, b) { return (a.receivedAt || 0) - (b.receivedAt || 0); });
    var w = assessWeather(turns);
    counts[w.level] = (counts[w.level] || 0) + 1;
    if (w.stats.toolTurns >= 5) withEvidence++;
    if (w.level === 'stormy' || w.level === 'rainy') {
      falsePositives.push({ sid: sids[i].slice(0, 8), turns: turns.length, level: w.level, score: w.score, top: w.factors[0] && w.factors[0].type });
    }
  }

  console.log('\n=== Weather Replay ===');
  console.log('Sessions: ' + sids.length + ' (with ≥5 paired results: ' + withEvidence + ')');
  console.log('Distribution:');
  for (var level in counts) {
    if (counts[level]) console.log('  ' + level + ': ' + counts[level]);
  }
  if (falsePositives.length) {
    console.log('\nRainy/Stormy sessions (' + falsePositives.length + '):');
    falsePositives.forEach(function(fp) {
      console.log('  ' + fp.sid + ' (' + fp.turns + ' turns) — ' + fp.level + ' score=' + fp.score + ' top=' + fp.top);
    });
  }
  var badRate = sids.length ? (counts.rainy + counts.stormy) / sids.length : 0;
  console.log('\nBad rate: ' + (badRate * 100).toFixed(1) + '%');
  // ponytail: readiness is the owner's decision — this script provides the data
  console.log('Evidence coverage: ' + withEvidence + '/' + sids.length + ' sessions have ≥5 paired tool results');
});
