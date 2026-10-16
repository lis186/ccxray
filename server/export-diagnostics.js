'use strict';

const fs = require('fs');
const path = require('path');

const {
  configDirsRefusal,
  describeLoss,
  exportConfigHash,
  exportStatus,
  readEnrollment,
  readExportCursorFacts,
} = require('./export-sync');
const { INDEX_TAIL_BYTES, readIndexTailChunk, storagePaths } = require('./status');
const hub = require('./hub');

const HUB_QUERY_TIMEOUT_MS = 3000;

function safeError(error) {
  const code = typeof error?.code === 'string' && (/^[A-Z0-9_-]+$/.test(error.code) || error.code === 'parse')
    ? error.code
    : 'unreadable';
  return { error: code };
}

function readJsonTail(filePath, { lastMatch = null } = {}) {
  const tail = readIndexTailChunk(filePath, INDEX_TAIL_BYTES);
  if (tail.kind === 'missing') return null;
  if (tail.kind === 'unreadable') throw tail.error || new Error('unreadable');
  if (tail.kind === 'empty') return null;

  let text = tail.buffer.toString('utf8');
  if (tail.start > 0) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline === -1) return null;
    text = text.slice(firstNewline + 1);
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let record;
    try { record = JSON.parse(lines[i]); }
    catch {
      if (i === lines.length - 1) throw Object.assign(new Error('parse'), { code: 'parse' });
      continue;
    }
    if (!lastMatch || lastMatch(record)) return record;
  }
  return null;
}

function readLastAttempt(home) {
  const filePath = path.join(home, 'export-last.json');
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return 'none';
    return safeError(error);
  }
  try { return JSON.parse(raw); }
  catch { return { error: 'parse' }; }
}

function readCursorError(home) {
  try {
    const cursor = JSON.parse(fs.readFileSync(path.join(home, 'export-cursor.json'), 'utf8'));
    return cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? 'unreadable' : 'shape';
  } catch (error) {
    if (error instanceof SyntaxError) return 'parse';
    return safeError(error).error;
  }
}

function readLastLockLoss(home) {
  try {
    const record = readJsonTail(path.join(home, 'export-events.log'), {
      lastMatch: row => row?.event?.type === 'lock-lost',
    });
    if (!record) return 'none';
    return {
      ts: record.ts ?? null,
      pid: record.pid ?? null,
      phase: record.event?.phase ?? null,
      text: describeLoss(home, record.event),
    };
  } catch (error) {
    return safeError(error);
  }
}

function readLastFailOpen(home) {
  try {
    return readJsonTail(path.join(home, 'fail-open.log')) || 'none';
  } catch (error) {
    return safeError(error);
  }
}

function collectExportDiagnostics({ env = process.env, report = null, reportReason = null, nowMs = Date.now() } = {}) {
  const invokingShell = {
    ...exportStatus(env),
    configDirsRefusal: configDirsRefusal(env),
    exportConfigHash: exportConfigHash(env),
    provenance: "this shell's environment — not what the running exporter uses",
  };

  const runningExporter = report
    ? {
      exportState: report.exportState,
      exportReason: report.exportReason,
      credential: report.credential ?? null,
      identity: report.identity ?? null,
      exportConfigHash: report.exportConfigHash ?? null,
      provenance: `hub pid ${report.pid} (env frozen at fork)`,
    }
    : {
      state: 'unknown',
      reason: reportReason,
      provenance: 'unknown — no reachable exporter',
    };

  const configMatch = !report || typeof report.exportConfigHash !== 'string'
    ? 'unknown'
    : report.exportConfigHash === invokingShell.exportConfigHash ? 'equal' : 'differs';

  const paths = storagePaths(report, env);
  const durableHome = {
    home: paths.home,
    logsDir: paths.logsDir,
    named: paths.named,
    provenance: paths.named ? 'named by hub' : 'from this shell — no exporter named a home',
    enrollment: null,
    cursor: null,
    lastAttempt: null,
    lastLockLoss: null,
    lastFailOpen: null,
  };

  try { durableHome.enrollment = readEnrollment(paths.home) ?? 'absent'; }
  catch (error) { durableHome.enrollment = safeError(error); }
  try {
    durableHome.cursor = readExportCursorFacts(paths.home);
    if (durableHome.cursor.unreadable) durableHome.cursor.error = readCursorError(paths.home);
  }
  catch (error) { durableHome.cursor = safeError(error); }
  durableHome.lastAttempt = readLastAttempt(paths.home);
  durableHome.lastLockLoss = readLastLockLoss(paths.home);
  durableHome.lastFailOpen = readLastFailOpen(paths.home);

  // `nowMs` is accepted for deterministic callers that render age-aware views.
  // Keep the reader's result as durable facts rather than deriving new state here.
  void nowMs;
  return { invokingShell, runningExporter, configMatch, durableHome };
}

function formatField(value) {
  if (value && typeof value === 'object' && 'error' in value) return `unreadable(${value.error})`;
  return String(value);
}

function enrollmentText(enrollment) {
  if (enrollment && typeof enrollment === 'object' && enrollment.state === 'removed') return 'removed';
  if (enrollment && typeof enrollment === 'object' && enrollment.state === 'invalid') {
    const reason = String(enrollment.reason || 'unknown').replace(/[\r\n]/g, ' ');
    const detail = String(enrollment.detail || 'unknown').replace(/[\r\n]/g, ' ');
    return `invalid (${reason}: ${detail})`;
  }
  return formatField(enrollment === 'absent' ? 'absent' : enrollment?.state || enrollment);
}

function cursorText(cursor) {
  if (cursor && typeof cursor === 'object' && 'error' in cursor) return formatField(cursor);
  if (!cursor?.present) return 'absent';
  if (cursor.unreadable) return `unreadable(${cursor.error || 'unreadable'})`;
  const parts = [];
  if (cursor.lastId !== null) parts.push(`lastId=${cursor.lastId}`);
  if (cursor.partial !== null) parts.push(`partial=${cursor.partial}`);
  if (cursor.cutoffDt !== null) parts.push(`cutoffDt=${cursor.cutoffDt}`);
  return parts.length ? parts.join(' ') : 'present';
}

function attemptText(attempt) {
  if (attempt === 'none') return 'none';
  if (attempt && typeof attempt === 'object' && 'error' in attempt) return formatField(attempt);
  if (!attempt || typeof attempt !== 'object') return 'unreadable(unreadable)';
  const parts = [`${attempt.attemptedAt || 'unknown time'} outcome=${attempt.outcome || 'unknown'}`];
  if (attempt.stage || attempt.category) parts.push(`[${attempt.stage || 'unknown'}/${attempt.category || 'unknown'}]`);
  parts.push(`files=${Number.isInteger(attempt.files) ? attempt.files : 'unknown'}`);
  parts.push(`rows=${Number.isInteger(attempt.rows) ? attempt.rows : 'unknown'}`);
  parts.push(`lastSuccessAt=${attempt.lastSuccessAt ?? 'none'}`);
  const count = value => Number.isInteger(value) ? value : 'unknown';
  parts.push(`eligible=${count(attempt.eligibleTurns)}`);
  parts.push(`excluded=no-account:${count(attempt.excludedTurns?.noAccount)},domain-mismatch:${count(attempt.excludedTurns?.domainMismatch)}`);
  parts.push(`candidates=${count(attempt.candidateEmails)}`);
  return parts.join(' ');
}

function lockLossText(loss) {
  if (loss === 'none') return 'none';
  if (loss && typeof loss === 'object' && 'error' in loss) return formatField(loss);
  if (!loss || typeof loss !== 'object') return 'unreadable(unreadable)';
  return `${loss.ts || 'unknown time'} pid=${loss.pid ?? 'unknown'} phase=${loss.phase || 'unknown'} — ${loss.text || 'details unavailable'}`;
}

function failOpenText(record) {
  if (record === 'none') return 'none';
  if (record && typeof record === 'object' && 'error' in record) return formatField(record);
  if (!record || typeof record !== 'object') return 'unreadable(unreadable)';
  return `${record.ts || 'unknown time'} reason=${record.reason || 'unknown'} version=${record.version || 'unknown'} agent=${record.agent || 'unknown'}`;
}

function renderExportDiagnostics(diagnostics) {
  const shell = diagnostics.invokingShell;
  const shellParts = [`exportState=${shell.exportState}`];
  if (shell.exportReason) shellParts.push(`exportReason=${shell.exportReason}`);
  shellParts.push(`hash=${shell.exportConfigHash}`);
  const config = diagnostics.configMatch === 'differs'
    ? 'DIFFERS — close every ccxray session and start again'
    : diagnostics.configMatch === 'equal' ? 'equal' : 'unknown — no reachable exporter';
  const durable = diagnostics.durableHome;
  return [
    `Shell: ${shellParts.join(' ')} — this shell's environment, not what the running exporter uses`,
    `Config: ${config}`,
    `Durable: ${durable.home} (${durable.provenance}) — enrollment=${enrollmentText(durable.enrollment)} · cursor ${cursorText(durable.cursor)} · last attempt ${attemptText(durable.lastAttempt)} · last lock loss: ${lockLossText(durable.lastLockLoss)} · last fail-open: ${failOpenText(durable.lastFailOpen)}`,
  ];
}

function validReport(report) {
  return report && report.app === 'ccxray'
    && typeof report.pid === 'number'
    && (report.exportState === undefined || typeof report.exportState === 'string');
}

async function fetchHubReport({ timeoutMs = HUB_QUERY_TIMEOUT_MS, statusCommand = false } = {}) {
  let lock;
  try { lock = hub.readHubLock(); }
  catch (error) {
    return {
      kind: 'unresponsive', lock: null, report: null, reason: error.code || 'lock-read',
      phase: 'lock', error: { code: error.code || null, message: error.message },
    };
  }
  if (!lock) return { kind: 'none', lock: null, report: null, reason: null };
  if (!hub.isPidAlive(lock.pid)) return { kind: 'dead-lockfile', lock, report: null, reason: 'dead-pid' };

  const deadline = Date.now() + Math.max(0, timeoutMs);
  const controller = new AbortController();
  let phase = 'health';
  let deadlineTimer;
  const deadlinePromise = new Promise(resolve => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      resolve({
        failure: 'timeout',
        phase,
        error: {
          code: 'ETIMEDOUT',
          message: lock.sockPath ? 'hubSocketRequest timeout' : 'timeout',
        },
      });
    }, Math.max(0, timeoutMs));
  });

  const remaining = () => Math.max(1, deadline - Date.now());
  const socketRequest = (msg, budget) => {
    return hub.hubSocketRequest(lock.sockPath, msg, budget, controller.signal);
  };
  const query = async () => {
    if (lock.sockPath) {
      phase = 'health';
      const health = await socketRequest({ cmd: 'health' }, Math.min(remaining(), 2000));
      if (!health || health.ok !== true) return { failure: 'health-failed', phase };
      phase = 'status';
      const report = await hub.hubSocketRequest(
        lock.sockPath,
        { cmd: 'status' },
        remaining(),
        controller.signal,
      );
      return { report, phase };
    }
    phase = 'health';
    const health = await hub.checkHubHealth(
      lock.port,
      Math.min(remaining(), 2000),
      controller.signal,
      statusCommand ? { detailed: true } : undefined,
    );
    if (statusCommand) {
      if (!health.ok || health.value !== true) {
        return { failure: 'health-failed', phase, error: health.error || null };
      }
    } else if (!health) {
      return { failure: 'health-failed', phase };
    }
    phase = 'status';
    if (statusCommand) {
      const result = await hub.probeHubStatus(lock.port, remaining(), controller.signal, {
        detailed: true,
      });
      if (!result.ok) {
        return {
          failure: result.error?.code || result.reason || 'status-failed',
          phase,
          error: result.error || null,
        };
      }
      return { report: result.value, phase };
    }
    const report = await hub.probeHubStatus(lock.port, remaining(), controller.signal);
    if (!report) return { failure: 'status-failed', phase };
    return { report, phase };
  };

  let result;
  try {
    result = await Promise.race([
      query(),
      deadlinePromise,
    ]);
  } catch (error) {
    result = {
      failure: error.code || 'query-failed',
      phase,
      error: { code: error.code || null, message: error.message },
    };
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
  }
  if (result?.failure) {
    const error = result.failure === 'reply-too-large'
      ? { code: 'reply-too-large', message: 'reply-too-large' }
      : result.error || null;
    return {
      kind: 'unresponsive', lock, report: null, reason: result.failure,
      phase: result.phase || phase, error,
    };
  }
  if (!validReport(result?.report)) {
    return {
      kind: 'unresponsive', lock, report: null, reason: 'malformed-report',
      phase: result?.phase || phase,
      error: { code: 'malformed-report', message: 'malformed-report' },
    };
  }
  return { kind: 'ok', lock, report: result.report, reason: null };
}

module.exports = {
  HUB_QUERY_TIMEOUT_MS,
  collectExportDiagnostics,
  renderExportDiagnostics,
  fetchHubReport,
};
