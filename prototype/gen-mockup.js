'use strict';
// Drives public/workflow-graph.js with a realistic synthetic Claude Code session
// (orchestrator spawns two parallel subagents, then fans in) and writes a static
// SVG + an HTML wrapper. No browser / deps needed.

const fs = require('fs');
const path = require('path');
const { buildWorkflowGraph, renderWorkflowSVG } = require('../public/workflow-graph.js');

const T0 = Date.parse('2026-06-17T10:00:00Z');
const s = ms => T0 + ms;

// Helper: an assistant message carrying tool_use blocks (so extractSpawnCalls works).
const asst = (...blocks) => ({ role: 'assistant', content: blocks });
const agentCall = (id, description) => ({ type: 'tool_use', id, name: 'Agent', input: { description } });

const entries = [
  // ── orchestrator (explicit session) ──
  {
    id: 'main-1', sessionId: 'sess-main', receivedAt: s(0), elapsed: 2600,
    agent: 'claude', displayNum: 1, title: 'Refactor auth + add tests',
    toolCalls: { Read: 1, Grep: 2 },
    req: { messages: [ asst({ type: 'tool_use', id: 't1', name: 'Read', input: {} }) ] },
  },
  {
    id: 'main-2', sessionId: 'sess-main', receivedAt: s(3200), elapsed: 800,
    agent: 'claude', displayNum: 2,
    toolCalls: { Agent: 2 },
    req: { messages: [ asst(
      agentCall('a1', 'explore auth module structure'),
      agentCall('a2', 'survey existing test coverage'),
    ) ] },
  },
  {
    id: 'main-3', sessionId: 'sess-main', receivedAt: s(8400), elapsed: 4200,
    agent: 'claude', displayNum: 3,
    toolCalls: { Edit: 2, Write: 1 },
    req: { messages: [ asst({ type: 'tool_use', id: 't9', name: 'Edit', input: {} }) ] },
  },
  {
    id: 'main-4', sessionId: 'sess-main', receivedAt: s(13200), elapsed: 5100,
    agent: 'claude', displayNum: 4,
    toolCalls: { Bash: 1 },
    req: { messages: [ asst({ type: 'tool_use', id: 't12', name: 'Bash', input: {} }) ] },
  },

  // ── subagent A: explore auth (inferred session) ──
  {
    id: 'subA-1', sessionId: 'sess-subA', receivedAt: s(4200), elapsed: 1500,
    agent: 'claude', displayNum: 1, isSubagent: true, sessionInferred: true,
    title: 'explore auth', toolCalls: { Glob: 1, Read: 2 },
    req: { messages: [] },
  },
  {
    id: 'subA-2', sessionId: 'sess-subA', receivedAt: s(6000), elapsed: 1400,
    agent: 'claude', displayNum: 2, isSubagent: true, sessionInferred: true,
    toolCalls: { Grep: 3 }, req: { messages: [] },
  },

  // ── subagent B: survey tests (inferred session, runs in parallel with A) ──
  {
    id: 'subB-1', sessionId: 'sess-subB', receivedAt: s(4500), elapsed: 2900,
    agent: 'claude', displayNum: 1, isSubagent: true, sessionInferred: true,
    title: 'survey tests', toolCalls: { Bash: 1, Read: 1 }, toolFail: true,
    req: { messages: [] },
  },
];

const graph = buildWorkflowGraph(entries);

// ── sanity: did inference recover the intended spawn structure? ──
const spawns = graph.edges.filter(e => e.type === 'spawn');
const fanins = graph.edges.filter(e => e.type === 'fanin');
console.log('lanes :', graph.lanes.map(l => `${l.sessionId}(${l.kind})`).join(', '));
console.log('spawn edges:', spawns.map(e => `${e.from}→${e.to} [${e.label}]`).join('  '));
console.log('fanin edges:', fanins.map(e => `${e.from}→${e.to}`).join('  '));
const ok = spawns.length === 2
  && spawns.every(e => e.from === 'main-2')
  && spawns.some(e => e.to === 'subA-1') && spawns.some(e => e.to === 'subB-1')
  && fanins.length === 2 && fanins.every(e => e.to === 'main-3');
console.log(ok ? '✓ spawn/fan-in inference reproduced the intended graph' : '✗ inference MISMATCH');

const svg = renderWorkflowSVG(graph, { pxPerSec: 40 });
const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'workflow-swimlane.svg'), svg);
fs.writeFileSync(path.join(outDir, 'workflow-swimlane.html'),
`<!doctype html><meta charset=utf-8><title>ccxray · Workflow Swimlane prototype</title>
<body style="margin:0;background:#0d1117;display:flex;justify-content:center;padding:24px">
${svg}
</body>`);
console.log('wrote', path.join(outDir, 'workflow-swimlane.svg'));
if (!ok) process.exit(1);
