'use strict';

// Ground-truth evaluation harness for extractAgentType.
// Scans ~/.ccxray/logs/shared/sys_*.json (real captured prompts) and compares
// the algorithm's prediction against a canonical prefix table.
//
// Output:
//   SCORE: <success_rate>   (correct + correctly-unknown) / total
//   PRECISION: <precision>  correct / (correct + misclassified)
// Exit code 0 if precision === 1.0, 1 otherwise (acts as guard).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractAgentType } = require('../server/system-prompt');

const SHARED_DIR = path.join(os.homedir(), '.ccxray', 'logs', 'shared');

// Canonical label table — each entry: {prefix, key}.
// Order matters; first match wins. This is the ground-truth definition,
// independent of the algorithm under test.
const TRUTH_TABLE = [
  { prefix: 'You are an interactive agent',                         key: 'orchestrator' },
  { prefix: "You are an agent for Claude Code",                     key: 'general-purpose' },
  { prefix: 'You are a file search specialist',                     key: 'explore' },
  { prefix: 'You are an assistant for performing a web search',     key: 'web-search' },
  { prefix: 'Generate a concise, sentence-case title',              key: 'title-generator' },
  { prefix: 'Generate a short kebab-case name',                     key: 'name-generator' },
  { prefix: 'You are a software architect and planning specialist', key: 'plan' },
  { prefix: 'You are a thin forwarding wrapper around the Codex',   key: 'codex-rescue' },
  { prefix: 'You are the Claude guide agent',                       key: 'claude-code-guide' },
  { prefix: 'You are a helpful AI assistant tasked with summarizing', key: 'summarizer' },
  { prefix: 'You are a translator',                                 key: 'translator' },
];

function truthLabel(sys) {
  if (!Array.isArray(sys) || sys.length < 2) return 'unknown';
  const b1 = (sys[1]?.text || '').trim();
  const b2 = (sys[2]?.text || '').trim();
  if (b2) {
    for (const t of TRUTH_TABLE) if (b2.startsWith(t.prefix)) return t.key;
    return 'unknown';
  }
  if (b1.startsWith('You are Claude Code')) return 'orchestrator';
  if (b1.startsWith('You are a Claude agent, built on Anthropic')) return 'sdk-agent';
  return 'unknown';
}

function loadShared() {
  let files;
  try { files = fs.readdirSync(SHARED_DIR); } catch (e) {
    console.error('ERROR: cannot read shared dir:', SHARED_DIR);
    process.exit(2);
  }
  return files.filter(f => f.startsWith('sys_') && f.endsWith('.json'));
}

function run() {
  const files = loadShared();
  const total = files.length;
  let correct = 0;
  let misclassified = 0;
  let correctlyUnknown = 0;
  let missedKnown = 0;  // truth != unknown, pred == unknown (under-classified, not a precision violation)
  const confusion = {};  // truth -> {pred -> count}
  const misSamples = [];

  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, f), 'utf8')); } catch { continue; }
    const sys = d.value || d;
    const truth = truthLabel(sys);
    const pred = extractAgentType(sys).key;

    if (!confusion[truth]) confusion[truth] = {};
    confusion[truth][pred] = (confusion[truth][pred] || 0) + 1;

    const predIsUnknown = pred === 'unknown' || pred === 'agent';
    if (truth === 'unknown') {
      if (predIsUnknown) correctlyUnknown++;
      else {
        // truth is unknown but algorithm assigned a specific label.
        // Since truth says "don't know", any specific assignment is a precision risk.
        // Treat as misclassification UNLESS the regex-derived label is reasonable.
        // Conservative: count as misclassified (precision violation).
        misclassified++;
        if (misSamples.length < 10) misSamples.push({f, truth, pred, b2: (sys[2]?.text||'').slice(0,80)});
      }
    } else {
      if (pred === truth) correct++;
      else if (predIsUnknown) missedKnown++;  // under-classification: not a precision violation but reduces recall
      else {
        misclassified++;
        if (misSamples.length < 10) misSamples.push({f, truth, pred, b2: (sys[2]?.text||'').slice(0,80)});
      }
    }
  }

  const successful = correct + correctlyUnknown;
  const successRate = total ? successful / total : 0;
  const precisionDenom = correct + misclassified;
  const precision = precisionDenom ? correct / precisionDenom : 1;

  // Print confusion matrix
  console.log('\n=== Ground-truth labels (by canonical prefix) ===');
  const truthCounts = {};
  for (const t of Object.keys(confusion)) {
    truthCounts[t] = Object.values(confusion[t]).reduce((a,b)=>a+b, 0);
  }
  for (const [t, n] of Object.entries(truthCounts).sort((a,b)=>b[1]-a[1])) {
    console.log(`  [${String(n).padStart(5)}] ${t}`);
  }

  console.log('\n=== Confusion (truth → pred) ===');
  for (const truth of Object.keys(confusion).sort()) {
    const preds = confusion[truth];
    for (const [pred, n] of Object.entries(preds).sort((a,b)=>b[1]-a[1])) {
      const marker = (truth === pred) ? '✓'
        : (pred === 'unknown' || pred === 'agent') ? '∼'
        : '✗';
      console.log(`  ${marker} ${truth.padEnd(20)} → ${pred.padEnd(25)} ${String(n).padStart(5)}`);
    }
  }

  if (misSamples.length) {
    console.log('\n=== Misclassification samples (precision violations) ===');
    for (const s of misSamples) {
      console.log(`  truth=${s.truth} pred=${s.pred} [${s.b2}]`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  total=${total} correct=${correct} correctlyUnknown=${correctlyUnknown}`);
  console.log(`  misclassified=${misclassified} missedKnown=${missedKnown}`);
  console.log(`\nSCORE: ${successRate.toFixed(4)}  PRECISION: ${precision.toFixed(4)}`);
  process.exit(precision >= 0.9999 ? 0 : 1);
}

run();
