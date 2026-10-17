'use strict';

// Claude Code statusline adapter install/uninstall (#687).
//
// Every rewrite of a Claude settings.json goes through writeSettingsFile:
// the original is copied to settings.json.bak-<timestamp> first, and the new
// content lands via tmp + rename in the same directory, so a crash mid-write
// can never leave a truncated settings file. A symlinked settings.json (a
// dotfile manager's) is written through to its target rather than replaced.

const fs = require('fs');
const path = require('path');

const ADAPTER_MARKER = 'claude-adapter';

function adapterCommand() {
  return `node ${path.join(__dirname, 'adapters/claude-adapter.js')}`;
}

function settingsPathFor(claudeHome) {
  return path.join(claudeHome, 'settings.json');
}

function readSettingsFile(settingsPath) {
  let raw;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch { return { exists: false, settings: {} }; }
  try { return { exists: true, settings: JSON.parse(raw) }; } catch { return { exists: true, settings: {}, unparseable: true }; }
}

function isStatuslineInstalled(claudeHome) {
  try {
    const raw = fs.readFileSync(settingsPathFor(claudeHome), 'utf8');
    return (JSON.parse(raw).statusLine?.command || '').includes(ADAPTER_MARKER);
  } catch { return false; }
}

function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Returns the backup path (null when there was no original to back up).
function writeSettingsFile(settingsPath, settings, { now = new Date() } = {}) {
  let target = settingsPath;
  try { target = fs.realpathSync(settingsPath); } catch {}
  let mode = null;
  let backup = null;
  try {
    mode = fs.statSync(target).mode & 0o777;
    backup = `${settingsPath}.bak-${backupStamp(now)}`;
    // Two runs inside one second must not overwrite the first backup.
    for (let n = 1; fs.existsSync(backup); n++) backup = `${settingsPath}.bak-${backupStamp(now)}-${n}`;
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    backup = null;
  }
  const tmp = `${target}.ccxray-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', mode == null ? undefined : { mode });
    if (mode != null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
  return backup;
}

// Pure planning step shared by the real write and --dry-run.
function planInstall(claudeHome) {
  const settingsPath = settingsPathFor(claudeHome);
  const { exists, settings, unparseable } = readSettingsFile(settingsPath);
  const existing = settings.statusLine?.command || '';
  if (existing.includes(ADAPTER_MARKER)) {
    // Legacy installs wrote no "type"; repair it in place.
    if (settings.statusLine.type === 'command') return { status: 'already', settingsPath };
    const next = { ...settings, statusLine: { ...settings.statusLine, type: 'command' } };
    return { status: 'updated', settingsPath, exists, before: settings.statusLine, after: next.statusLine, next };
  }
  const statusLine = { ...(settings.statusLine || {}), type: 'command', command: adapterCommand() };
  if (existing) statusLine._ccxrayDelegate = existing;
  const next = { ...settings, statusLine };
  return {
    status: 'installed', settingsPath, exists, unparseable: Boolean(unparseable),
    delegated: existing || null, before: settings.statusLine ?? null, after: statusLine, next,
  };
}

function planUninstall(claudeHome) {
  const settingsPath = settingsPathFor(claudeHome);
  const { exists, settings, unparseable } = readSettingsFile(settingsPath);
  if (!exists || unparseable) return { status: 'not_installed', settingsPath };
  const cmd = settings.statusLine?.command || '';
  if (!cmd.includes(ADAPTER_MARKER)) return { status: 'not_installed', settingsPath };

  const next = { ...settings };
  const delegate = settings.statusLine._ccxrayDelegate;
  // ponytail: legacy fallback for old --delegate "cmd" format installs
  const legacyMatch = cmd.match(/--delegate "(.+)"/);
  if (delegate || legacyMatch) {
    const statusLine = { ...settings.statusLine, command: delegate || legacyMatch[1] };
    delete statusLine._ccxrayDelegate;
    next.statusLine = statusLine;
  } else {
    delete next.statusLine;
  }
  return { status: 'removed', settingsPath, exists, before: settings.statusLine, after: next.statusLine ?? null, next };
}

function applyPlan(plan) {
  if (!plan.next) return plan;
  const backup = writeSettingsFile(plan.settingsPath, plan.next);
  return { ...plan, backup };
}

function installStatusline(claudeHome) {
  const { status, delegated, backup } = applyPlan(planInstall(claudeHome));
  return { status, delegated: delegated || null, backup: backup || null };
}

function uninstallStatusline(claudeHome) {
  const { status, backup } = applyPlan(planUninstall(claudeHome));
  return { status, backup: backup || null };
}

const USAGE = `Usage: ccxray setup-statusline [options]

Install (or remove) the ccxray statusline adapter in Claude Code's
settings.json so rate limits appear on the Usage page. An existing
statusline is delegated to, not replaced, and restored on removal.
The original settings.json is backed up to settings.json.bak-<timestamp>
before it is rewritten.

Options:
  --claude-home <dir>   Act on this Claude config dir only (default: every
                        ~/.claude and ~/.claude-* with a settings.json)
  --remove              Uninstall non-interactively
  --dry-run             Show the planned change without writing anything
  --help, -h            Show this help

Without --remove, a TTY shows a picker when several homes are found;
otherwise every home that lacks the adapter is installed.
`;

// Returns { help } | { error } | { claudeHome, remove, dryRun }.
function parseSetupStatuslineArgs(args) {
  const out = { claudeHome: null, remove: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--remove') out.remove = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--claude-home') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) return { error: '--claude-home requires a directory' };
      out.claudeHome = v;
      i++;
    } else return { error: `unknown argument "${a}"` };
  }
  return out;
}

function describePlan(plan, label) {
  const lines = [];
  if (plan.status === 'already') lines.push(`${label}: already configured — no change.`);
  else if (plan.status === 'not_installed') lines.push(`${label}: not installed — no change.`);
  else {
    const verb = { installed: 'would install', updated: 'would add "type": "command" to', removed: 'would remove' }[plan.status];
    lines.push(`${label}: ${verb} the statusline in ${plan.settingsPath}`);
    if (plan.unparseable) lines.push('  settings.json does not parse; it would be REWRITTEN (a backup is kept)');
    lines.push(`  before: ${JSON.stringify(plan.before ?? null)}`);
    lines.push(`  after:  ${JSON.stringify(plan.after ?? null)}`);
    if (plan.exists) lines.push(`  backup: ${plan.settingsPath}.bak-<timestamp>`);
  }
  return lines.join('\n');
}

module.exports = {
  USAGE,
  adapterCommand,
  isStatuslineInstalled,
  installStatusline,
  uninstallStatusline,
  planInstall,
  planUninstall,
  writeSettingsFile,
  parseSetupStatuslineArgs,
  describePlan,
};
