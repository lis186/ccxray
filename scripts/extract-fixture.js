#!/usr/bin/env node
// Extract real ccxray log data into prototype fixture format
'use strict';
const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(process.env.HOME, '.ccxray/logs');
const INDEX_FILE = path.join(LOGS_DIR, 'index.ndjson');

// Sessions to extract: [sessionIdPrefix, label, description]
const TARGETS = [
  // Original 5
  ['0df173ba', 'Simple baseline (14t)', 'Single opus-4-6, no spawns, monotonic'],
  ['9e8cfc3f', 'Compaction event (30t)', 'sonnet-4-6, context fills then compacts'],
  ['00b05c48', 'Spawn-heavy (83t)', 'opus-4-6 orchestrator + 48 subagents'],
  ['e80743c5', 'Workflow audit (88t)', 'Workflow tool, opus+haiku, 18 lanes'],
  ['84895640', 'Long session (319t)', 'opus-4-6 marathon, peak 100%'],
  // New 7 — diversity dimensions
  ['d4cc4b15', 'Fable-5 near-ceiling (42t)', 'fable-5 only, peak 99%, code editing heavy'],
  ['1085045f', 'Opus-4-8 marathon (154t)', 'opus-4-8, TaskUpdate heavy, structured work'],
  ['89e613a0', 'Model upgrade + compaction (133t)', 'opus-4-6→opus-4-8, window shrink+expand'],
  ['b14c6bba', 'Low-context plateau (29t)', 'opus-4-6, never exceeds 15%, small task'],
  ['c609059b', 'Tiny rapid compaction (10t)', 'sonnet-4-6, 83→100→20% in 3 turns'],
  ['e0ef3ad0', 'Medium Bash-heavy (41t)', 'opus-4-8, degradation zone 61%, debugging'],
  ['1bd91918', 'Haiku spawn stress (72t)', 'opus-4-6+haiku, 10 Agent spawns, lane inference test'],
];

const lines = fs.readFileSync(INDEX_FILE, 'utf8').trim().split('\n');
const allEntries = lines.map(l => JSON.parse(l));

const sessions = {};
for (const e of allEntries) {
  if (!e.sessionId || e.sessionId === 'unknown') continue;
  if (!sessions[e.sessionId]) sessions[e.sessionId] = [];
  sessions[e.sessionId].push(e);
}

const fixture = { sessions: [] };

for (const [prefix, label, description] of TARGETS) {
  const match = Object.entries(sessions).find(([sid]) => sid.startsWith(prefix));
  if (!match) { console.error(`Session ${prefix} not found, skipping`); continue; }
  const [fullSid, entries] = match;

  // Sort by receivedAt, filter noise (no model or zero usage)
  entries.sort((a, b) => a.receivedAt - b.receivedAt);
  const filtered = entries.filter(e => e.model && e.model !== 'unknown' && ((e.usage?.input_tokens || 0) + (e.usage?.output_tokens || 0)) > 0);
  entries.length = 0; entries.push(...filtered);

  const turns = entries.map((e, i) => {
    const u = e.usage || {};
    const contextUsed = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const contextWindow = e.maxContext || 200000;
    const contextPercent = contextWindow > 0 ? (contextUsed / contextWindow) * 100 : 0;

    // Extract agent spawns from toolCalls
    const agentSpawns = [];
    const agentCount = (e.toolCalls || {}).Agent || 0;
    const wfCount = (e.toolCalls || {}).Workflow || 0;
    // We can't get spawn names from index alone, but we know count
    for (let j = 0; j < agentCount; j++) agentSpawns.push({ name: `agent-${i}-${j}`, subagent_type: 'fork' });
    for (let j = 0; j < wfCount; j++) agentSpawns.push({ name: `workflow-${i}-${j}`, subagent_type: 'workflow' });

    return {
      id: `${prefix}-${e.id}`,
      turnIndex: i + 1,
      timestamp: e.id,
      model: e.model || 'unknown',
      receivedAt: e.receivedAt,
      elapsed: Math.round((Number(e.elapsed) || 0) * 1000),
      usage: {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      },
      toolCalls: e.toolCalls || {},
      agentSpawns,
      contextWindow,
      contextUsed,
      contextPercent: Math.round(contextPercent * 10) / 10,
      isSubagent: e.isSubagent || false,
    };
  });

  const models = [...new Set(turns.map(t => t.model))].map(m => m.replace('claude-', '')).join(', ');
  const subs = turns.filter(t => t.isSubagent).length;

  fixture.sessions.push({
    id: fullSid.substring(0, 8),
    label: label,
    description: `${description} — ${turns.length}t (${turns.length - subs}m+${subs}s) ${models}`,
    turns,
  });

  const peak = Math.max(...turns.map(t => t.contextPercent));
  console.log(`✓ ${prefix} → ${turns.length} turns, ${subs} subs, peak ${peak.toFixed(0)}%, models: ${models}`);
}

fs.writeFileSync(path.join(__dirname, '..', 'prototype-fixture.json'), JSON.stringify(fixture, null, 2));
console.log(`\nWrote ${fixture.sessions.length} sessions to prototype-fixture.json`);
