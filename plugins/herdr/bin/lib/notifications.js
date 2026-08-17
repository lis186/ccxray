'use strict';

const fs = require('fs');
const path = require('path');

function notificationMode(env = process.env) {
  const value = String(env.CCXRAY_HERDR_NOTIFICATIONS || 'all').toLowerCase();
  return ['off', 'blocked', 'all'].includes(value) ? value : 'all';
}

function statePath(paneId, env = process.env) {
  if (!env.HERDR_PLUGIN_STATE_DIR) return null;
  return path.join(env.HERDR_PLUGIN_STATE_DIR, 'notifications', `${encodeURIComponent(paneId)}.json`);
}

function readState(file) {
  if (!file) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function recordAgentStatus(event, env = process.env) {
  if (!event.paneId || !event.status) return;
  const file = statePath(event.paneId, env);
  writeState(file, { status: String(event.status).toLowerCase(), updatedAt: Date.now() });
}

function agentNotification(event, summary, opts = {}) {
  const status = String(event.status || '').toLowerCase();
  const paneId = event.paneId || null;
  if (!paneId || !status) return null;

  const file = statePath(paneId, opts.env);
  const state = readState(file);
  const previous = state.status || null;

  const mode = notificationMode(opts.env);
  if (previous === status) return null;
  const shouldNotify = !opts.focused
    && mode !== 'off'
    && (status === 'blocked' || (status === 'done' && mode === 'all'));
  if (!shouldNotify) {
    recordAgentStatus({ ...event, status }, opts.env);
    return null;
  }

  const agent = event.agent || 'Agent';
  const title = status === 'blocked' ? `${agent} needs attention` : `${agent} finished`;
  const detail = String(summary || '').trim();
  return {
    title,
    body: detail ? `${detail} · ${paneId}` : paneId,
    sound: status === 'blocked' ? 'request' : 'done',
  };
}

module.exports = {
  agentNotification,
  notificationMode,
  recordAgentStatus,
};
