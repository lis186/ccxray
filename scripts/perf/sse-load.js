#!/usr/bin/env node
'use strict';

// Fixture shapes derived from live module analysis (2026-07-07):
//   Entry shape: server/sse-broadcast.js summarizeEntry() field list
//   Session tracking: server/store.js markSessionUsage() + computeSessionResume()
//
// Injects synthetic entries directly into the in-process store and calls
// broadcast() to exercise the summarizeEntry → JSON.stringify → sseClients
// code path. The running server is a separate child process, so
// store.sseClients in *this* (measure.js) process is empty — no bytes
// reach a browser. The serialization path is still fully exercised.

const store = require('../../server/store');
const { broadcast } = require('../../server/sse-broadcast');

const DEFAULT_COUNT = 100;

function makeSyntheticEntry(idx) {
  const base = new Date('2026-01-15T10:00:00.000Z').getTime();
  const receivedAt = base + idx * 1000;
  const min = Math.floor(idx / 60);
  const sec = idx % 60;
  const id = `2026-01-15T10-${String(min).padStart(2, '0')}-${String(sec).padStart(2, '0')}-${String(idx % 1000).padStart(3, '0')}`;

  return {
    id,
    ts: `10:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`,
    sessionId: `sse-load-session-${String(idx % 5).padStart(4, '0')}`,
    provider: 'anthropic',
    agent: 'claude-code',
    model: 'claude-sonnet-4-6',
    elapsed: 1000 + (idx % 500),
    status: 200,
    isSSE: true,
    receivedAt,
    usage: {
      input_tokens: 100 + idx * 2,
      output_tokens: 50 + (idx % 20),
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 40,
    },
    cost: { cost: 0.001 + idx * 0.0001 },
    maxContext: 200000,
    cwd: `/mock/project-${idx % 3}`,
    msgCount: 2 + (idx % 10),
    toolCount: idx % 3,
    toolCalls: idx % 3 > 0 ? { Bash: idx % 3 } : {},
    isSubagent: false,
    sessionInferred: false,
    title: `SSE Load Turn ${idx}`,
    stopReason: 'end_turn',
    coreHash: 'aabbcc',
    agentKey: 'claude-code::aabbcc',
  };
}

/**
 * Inject `count` synthetic entries into the in-process store and broadcast
 * each one via sse-broadcast.broadcast(). Exercises the serialization path
 * (summarizeEntry) without requiring a live SSE client connection.
 *
 * Cleans up: restores store.entries to original state before returning.
 *
 * @param {number} count - entries to inject (default 100)
 * @returns {number} count of entries successfully injected
 */
function simulateSseLoad(count = DEFAULT_COUNT) {
  const saved = store.entries.splice(0);
  let injected = 0;

  try {
    for (let i = 0; i < count; i++) {
      const entry = makeSyntheticEntry(i);
      store.entries.push(entry);
      broadcast(entry);
      injected++;
    }
  } finally {
    store.entries.splice(0);
    for (const e of saved) store.entries.push(e);
  }

  return injected;
}

module.exports = { simulateSseLoad };
