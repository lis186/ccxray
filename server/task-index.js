'use strict';

const config = require('./config');

let ino = null;
let offset = 0;
let byTask = new Map();
let refreshPromise = null;
let generation = 0;
let initialized = false;

function clear() {
  ino = null;
  offset = 0;
  byTask = new Map();
  initialized = false;
}

const isTaskLine = line => line.includes('"task":');

async function refreshFromStorage(refreshGeneration) {
  let result = await config.storage.readIndexLinesFrom(offset, isTaskLine);
  if (refreshGeneration !== generation) return;
  if (initialized && (result.ino !== ino || result.size < offset)) {
    clear();
    result = await config.storage.readIndexLinesFrom(0, isTaskLine);
    if (refreshGeneration !== generation) return;
  }

  for (const line of result.lines) {
    if (!isTaskLine(line)) continue;
    let meta;
    try { meta = JSON.parse(line); } catch { continue; }
    if (typeof meta.task !== 'string') continue;
    if (!byTask.has(meta.task)) byTask.set(meta.task, []);
    byTask.get(meta.task).push(line);
  }

  ino = result.ino;
  offset = result.nextOffset;
  initialized = true;
}

function refresh() {
  if (!refreshPromise) {
    const refreshGeneration = generation;
    refreshPromise = refreshFromStorage(refreshGeneration).finally(() => {
      if (refreshGeneration === generation) refreshPromise = null;
    });
  }
  return refreshPromise;
}

function linesFor(task) {
  return byTask.get(task) || [];
}

function reset() {
  generation += 1;
  clear();
  refreshPromise = null;
}

function warm() {
  refresh().catch(err => {
    console.error('[task-index] Warm-up failed:', err.message);
  });
}

module.exports = { refresh, linesFor, reset, warm };
