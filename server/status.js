'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCcxrayHome, resolveLogsDir } = require('./paths');
const { readExportCursorFacts } = require('./export-sync');
const { renderConfigWarning } = require('./importer');

// Keep this in step with export-sync.js. The exporter schedules hourly flushes;
// the home-level line uses twice that interval only for the behind qualifier.
const FLUSH_INTERVAL_MS = 3_600_000;
const INDEX_TAIL_BYTES = 64 * 1024;
const EXPORT_STATES = new Set([
  'unconfigured',
  'suppressed',
  'refused',
  'enabled',
]);

function identityText(identity) {
  if (!identity || typeof identity !== 'object') return 'identity unavailable';
  return JSON.stringify({
    kind: identity.kind ?? null,
    pid: identity.pid ?? null,
    port: identity.port ?? null,
    home: identity.home ?? null,
    logsDir: identity.logsDir ?? null,
  });
}

function warningText(warning) {
  return renderConfigWarning(warning);
}

function renderProcessStatus(report, unavailableReason = 'no discoverable hub') {
  if (!report || typeof report.exportState !== 'string' || report.exportState.length === 0) {
    return `Process: exporter state unavailable — ${unavailableReason}`;
  }

  const parts = [`exportState=${report.exportState}`];
  if (report.exportReason) parts.push(`exportReason=${report.exportReason}`);
  if (Array.isArray(report.configWarnings) && report.configWarnings.length) {
    parts.push(`configWarnings=${report.configWarnings.map(warningText).join(' | ')}`);
  }
  parts.push(`identity=${identityText(report.identity)}`);
  return `Process: ${parts.join(' ')}`;
}

function hasNamedStoragePair(identity) {
  return typeof identity?.home === 'string' && identity.home.length > 0
    && typeof identity?.logsDir === 'string' && identity.logsDir.length > 0;
}

function storagePaths(report, env = process.env) {
  const identity = report?.identity;
  const named = hasNamedStoragePair(identity);
  const home = named ? identity.home : resolveCcxrayHome(env);
  const logsDir = named ? identity.logsDir : resolveLogsDir(env);
  return {
    named,
    home,
    logsDir,
    cursorPath: path.join(home, 'export-cursor.json'),
    indexPath: path.join(logsDir, 'index.ndjson'),
  };
}

function readIndexTailChunk(indexPath, maxBytes) {
  let fd = null;
  try {
    fd = fs.openSync(indexPath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return { kind: 'empty', size: 0 };

    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
    return { kind: 'data', size: stat.size, start, buffer: buffer.subarray(0, bytesRead) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', error: err };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function parseTailChunk(chunk) {
  const text = chunk.buffer.toString('utf8');
  let end = text.length;
  if (end > 0 && text[end - 1] === '\n') end--;
  if (end > 0 && text[end - 1] === '\r') end--;

  // Empty trailing lines are harmless and the normal index reader skips them.
  // Walk back over those lines, but never skip a non-empty malformed line: it
  // may be a torn append and using the previous id would be a guess.
  while (end > 0) {
    const lineStart = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(lineStart, end);
    if (line.length > 0) {
      if (lineStart === 0 && chunk.start > 0) return { kind: 'needs-widen' };
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed.id !== 'string' || parsed.id.length === 0) {
          return { kind: 'unreadable' };
        }
        return { kind: 'tail', id: parsed.id };
      } catch {
        return { kind: 'unreadable' };
      }
    }
    end = lineStart - 1;
    if (end > 0 && text[end - 1] === '\r') end--;
  }

  if (chunk.start > 0) return { kind: 'needs-widen' };
  return { kind: 'empty' };
}

// The index can be hundreds of MB. Read only its tail, and widen once when the
// initial window cannot establish a complete final line. A malformed final
// line is never replaced by the previous valid entry.
function readIndexTailId(indexPath, options = {}) {
  const maxBytes = options.maxBytes || INDEX_TAIL_BYTES;
  let chunk = readIndexTailChunk(indexPath, maxBytes);
  if (chunk.kind === 'missing') return { kind: 'no-index' };
  if (chunk.kind === 'unreadable') return { kind: 'unreadable' };
  if (chunk.kind === 'empty') return { kind: 'empty' };

  let parsed = parseTailChunk(chunk);
  if (parsed.kind === 'needs-widen' || parsed.kind === 'unreadable') {
    // A torn final line needs the one permitted wider read before it becomes
    // an explicit unreadable result. The widened read still has a hard bound.
    const widened = readIndexTailChunk(indexPath, maxBytes * 2);
    if (widened.kind === 'missing') return { kind: 'no-index' };
    if (widened.kind === 'unreadable') return { kind: 'unreadable' };
    if (widened.kind === 'empty') return { kind: 'empty' };
    parsed = parseTailChunk(widened);
  }
  return parsed.kind === 'tail' ? parsed : { kind: 'unreadable' };
}

function ageText(ageMs) {
  const hours = Math.max(1, Math.round(ageMs / 3_600_000));
  return `${hours}h`;
}

function neverFlushedText(report) {
  const state = report?.exportState;
  if (state === 'unconfigured') {
    return 'never-flushed — expected: exporter is unconfigured';
  }
  if (state === 'suppressed') {
    const reason = report.exportReason ? ` (${report.exportReason})` : '';
    return `never-flushed — expected: exporter is suppressed${reason}`;
  }
  if (state === 'refused') {
    const reason = report.exportReason ? ` (${report.exportReason})` : '';
    return `never-flushed — exporter refusal${reason} corroborates the process state`;
  }
  if (state === 'enabled') {
    return 'never-flushed — alarm: enabled exporter has not completed a flush';
  }
  return 'never flushed; no exporter process reachable — cannot tell whether export is configured for this home';
}

function describeHomeState(report, cursor, tail, nowMs) {
  if (cursor.unreadable) return 'cursor-unreadable';
  if (tail.kind === 'no-index') return 'no-index';
  if (!cursor.present) return 'never-flushed';
  if (tail.kind === 'unreadable') return 'index tail unreadable';
  if (tail.kind === 'empty') {
    return cursor.lastId === null
      ? (cursor.partial ? 'current (partial)' : 'current')
      : 'behind-pending';
  }
  if (cursor.lastId === tail.id) return cursor.partial ? 'current (partial)' : 'current';

  const ageMs = Number.isFinite(cursor.mtimeMs) ? Math.max(0, nowMs - cursor.mtimeMs) : Infinity;
  return ageMs < (2 * FLUSH_INTERVAL_MS) ? 'behind-pending' : 'behind-overdue';
}

function renderDetermination(paths) {
  return `Home: ${paths.home} — never flushed; no exporter process reachable — cannot tell whether export is configured for this home`
    + ` (read cursor ${paths.cursorPath}; index ${paths.indexPath})`;
}

function renderHomeState(report, paths, state, cursor, nowMs) {
  let detail = state;
  if (state === 'never-flushed') detail = neverFlushedText(report);
  else if (state === 'current (partial)') {
    detail = 'current (partial — first run, no backfill)';
  } else if (state === 'current') {
    detail = 'current — cursor has consumed through the index tail';
  } else if (state === 'no-index') {
    detail = `no-index — no index file at ${paths.indexPath}`;
  } else if (state === 'cursor-unreadable') {
    detail = `cursor-unreadable — could not read ${paths.cursorPath}`;
  } else if (state === 'index tail unreadable') {
    detail = `index tail unreadable — could not establish the final index entry at ${paths.indexPath}`;
  } else if (state === 'behind-pending') {
    detail = 'behind-pending — cursor is behind the index tail; a flush may still be pending, re-check within 1h';
  } else if (state === 'behind-overdue') {
    const age = Number.isFinite(cursor.mtimeMs) ? ageText(Math.max(0, nowMs - cursor.mtimeMs)) : 'an unknown age';
    detail = `behind-overdue — conditional: if an enabled exporter remains behind after the next flush interval, uploads may be failing; re-check in 1h (cursor age ${age})`;
  }
  return `Home: ${paths.home} — ${detail} (read cursor ${paths.cursorPath}; index ${paths.indexPath})`;
}

function inspectHomeStatus(report, options = {}) {
  const env = options.env || process.env;
  const nowMs = options.nowMs ?? Date.now();
  const paths = storagePaths(report, env);
  const cursor = readExportCursorFacts(paths.home);
  const tail = readIndexTailId(paths.indexPath, options);

  // Without a report that names both sides of the storage domain, these reads
  // are only disclosed to the operator. No cursor/index comparison is allowed.
  if (!paths.named) {
    return {
      state: 'undetermined',
      paths,
      cursor,
      tail,
      line: renderDetermination(paths),
    };
  }

  const state = describeHomeState(report, cursor, tail, nowMs);
  return {
    state,
    paths,
    cursor,
    tail,
    line: renderHomeState(report, paths, state, cursor, nowMs),
  };
}

module.exports = {
  EXPORT_STATES,
  FLUSH_INTERVAL_MS,
  INDEX_TAIL_BYTES,
  hasNamedStoragePair,
  storagePaths,
  readIndexTailId,
  renderProcessStatus,
  inspectHomeStatus,
};
