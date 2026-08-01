#!/usr/bin/env node
// Generate a ~300k-line / ~500MB synthetic index.ndjson for #348 benchmarking.
// Usage: node scripts/bench/gen-348-fixture.js /tmp/ccxray-bench-348
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || '/tmp/ccxray-bench-348';
fs.mkdirSync(path.join(dir, 'logs', 'shared'), { recursive: true });
const out = fs.createWriteStream(path.join(dir, 'logs', 'index.ndjson'));

const TARGET = parseInt(process.argv[3] || '300000', 10);
const sessions = 200;

function pad(n, w) { return String(n).padStart(w, '0'); }

for (let i = 0; i < TARGET; i++) {
  const sid = `sess-${pad(i % sessions, 4)}`;
  const daysAgo = Math.floor(i / TARGET * 28);
  const d = new Date(Date.now() - daysAgo * 86400000 + (i % 86400) * 1000);
  const ts = d.toISOString().replace(/[:.]/g, '-').slice(0, -1);
  const meta = {
    id: ts,
    ts: d.toISOString(),
    sessionId: sid,
    provider: 'anthropic',
    model: 'claude-fable-5[1m]',
    msgCount: 10 + (i % 50),
    toolCount: i % 8,
    toolCalls: { Read: 2 + (i % 5), Edit: 1 + (i % 3), Bash: 3 + (i % 4), Write: i % 2, Grep: i % 6, Glob: i % 4 },
    skillCalls: i % 10 === 0 ? { 'code-review': 1, tdd: 1, research: 1 } : null,
    isSubagent: i % 7 === 0,
    sessionInferred: false,
    cwd: `/Users/dev/project-${i % 20}`,
    isSSE: true,
    usage: {
      input_tokens: 50000 + (i % 200000),
      output_tokens: 2000 + (i % 10000),
      cache_read_input_tokens: 30000 + (i % 100000),
      cache_creation_input_tokens: 5000 + (i % 50000),
    },
    cost: { cost: 0.05 + (i % 100) * 0.001 },
    maxContext: i % 3 === 0 ? 1000000 : 200000,
    stopReason: 'end_turn',
    title: i % 15 === 0 ? `Turn ${i} title string for realistic sizing — a longer title to pad the line toward realistic JSON byte counts per entry` : null,
    toolSources: i % 5 === 0 ? ['mcp__claude-in-chrome__computer', 'mcp__claude-in-chrome__read_page', 'mcp__argent__gesture-tap'] : null,
    editSummary: i % 20 === 0 ? ['Changed model parameter', 'Added system instruction'] : null,
    responseMetadata: i % 4 === 0 ? { id: `resp_${pad(i, 8)}`, model: 'claude-fable-5[1m]' } : null,
    thinkingDuration: `${(1.5 + i % 10).toFixed(1)}`,
    toolFail: i % 50 === 0,
    elapsed: `${(2.0 + i % 30).toFixed(1)}`,
    status: 200,
    receivedAt: d.getTime(),
    sysHash: `sh${pad(i % 40, 3)}`,
    toolsHash: `th${pad(i % 20, 3)}`,
    coreHash: `ch${pad(i % 30, 3)}`,
    agentKey: i % 7 === 0 ? 'agent' : 'orchestrator',
    agentLabel: i % 7 === 0 ? 'Agent' : 'Claude Code',
    convId: `conv-${pad(i % 150, 4)}`,
    responseId: `msg_${pad(i, 8)}`,
    beta1m: i % 3 === 0 ? true : undefined,
  };
  out.write(JSON.stringify(meta) + '\n');
}
out.end(() => {
  const stat = fs.statSync(path.join(dir, 'logs', 'index.ndjson'));
  console.log(`Generated ${TARGET} lines, ${(stat.size / 1e6).toFixed(1)} MB → ${path.join(dir, 'logs', 'index.ndjson')}`);
});
