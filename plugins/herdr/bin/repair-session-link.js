#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveCcxrayCommand } = require('./lib/ccxray');

function writeState(file, value) {
  if (!file) return;
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    try { fs.unlinkSync(temp); } catch { /* diagnosis is best-effort */ }
  }
}

function lastJson(text) {
  const lines = String(text || '').trim().split('\n').reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* importer also emits a progress line */ }
  }
  return null;
}

function main(env = process.env) {
  let target;
  try { target = JSON.parse(env.CCXRAY_LINK_REPAIR_TARGET || ''); } catch { target = null; }
  const stateFile = env.CCXRAY_LINK_REPAIR_STATE || null;
  if (!target?.file || !target.provider || !target.sessionId || !target.cwd) {
    const finishedAt = Date.now();
    writeState(stateFile, {
      status: 'failed', finishedAt, retryAfter: finishedAt + 30000, reason: 'bad-target',
    });
    return 1;
  }

  writeState(stateFile, {
    status: 'running', startedAt: Date.now(), workerPid: process.pid,
    provider: target.provider, sessionId: target.sessionId,
  });

  const command = resolveCcxrayCommand(env);
  const result = spawnSync(command.bin, [
    ...(command.argsPrefix || []),
    'import', '--target-transcript', target.file,
    '--provider', target.provider,
    '--session-id', target.sessionId,
    '--cwd', target.cwd,
  ], {
    env,
    encoding: 'utf8',
    timeout: 35000,
    windowsHide: true,
  });
  const report = lastJson(result.stdout);
  const imported = Boolean(result.status === 0 && report?.ok && report?.ran && report?.exactEvidence);
  const finishedAt = Date.now();
  const rawRetry = Number(env.CCXRAY_LINK_REPAIR_RETRY_MS);
  const retryMs = Number.isFinite(rawRetry) && rawRetry >= 0
    ? Math.min(rawRetry, 10 * 60 * 1000)
    : 30000;
  writeState(stateFile, imported ? {
    status: 'complete',
    finishedAt,
    imported: Number(report.imported || 0),
    duplicatesSkipped: Number(report.duplicatesSkipped || 0),
    exactEvidence: report.exactEvidence,
    // Targeted import already walked the complete session history. Keep its
    // bounded display samples with the linkage proof so the next Sidebar
    // refresh does not depend on the global index tail still containing them.
    contextSamples: Array.isArray(report.contextSamples) ? report.contextSamples : null,
  } : {
    status: 'failed',
    finishedAt,
    retryAfter: finishedAt + retryMs,
    reason: result.error?.code || report?.reason || `exit-${result.status}`,
  });
  if (!imported) return 1;

  // The original event may never fire again (an already-idle pane), so publish
  // the history-only result after the append. Import is disabled in this child;
  // this refresh can classify, but can never recursively request another repair.
  spawnSync(process.execPath, [path.join(__dirname, 'refresh-badges.js')], {
    env: {
      ...env,
      CCXRAY_BADGE_IMPORT_DISABLE: '1',
      CCXRAY_BADGE_EVENT_DELAY_MS: '0',
      CCXRAY_LINK_REPAIR_CHILD: '1',
      CCXRAY_BADGE_SHARED_REPORT: '',
    },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { lastJson, main };
