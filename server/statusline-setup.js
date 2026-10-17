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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A settings.json that parses to anything but a plain object ([] , 42, "x",
// null) is treated like one that does not parse: there is no object to carry
// the user's content over into, so rewriting it would drop that content.
function readSettingsFile(settingsPath) {
  let raw;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch { return { exists: false, settings: {} }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { exists: true, settings: {}, unparseable: true }; }
  if (!isPlainObject(parsed)) return { exists: true, settings: {}, unparseable: true };
  return { exists: true, settings: parsed };
}

// The existing statusLine as an object (a non-object value is not spread into
// character keys) and its command as a string.
function currentStatusLine(settings) {
  const statusLine = isPlainObject(settings.statusLine) ? settings.statusLine : null;
  const command = statusLine && typeof statusLine.command === 'string' ? statusLine.command : '';
  return { statusLine, command };
}

// What the TTY launch prompt should do, from the same reader setup uses:
// 'refused' (unparseable or non-object file — never ask, never rewrite),
// 'installed', 'existing' (a foreign statusline to delegate), or 'none'.
function launchPromptState(claudeHome) {
  const settingsPath = settingsPathFor(claudeHome);
  const { settings, unparseable } = readSettingsFile(settingsPath);
  if (unparseable) return { status: 'refused', settingsPath };
  const { command } = currentStatusLine(settings);
  if (command.includes(ADAPTER_MARKER)) return { status: 'installed', settingsPath };
  return { status: command ? 'existing' : 'none', settingsPath };
}

function isStatuslineInstalled(claudeHome) {
  try {
    const raw = fs.readFileSync(settingsPathFor(claudeHome), 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) && currentStatusLine(parsed).command.includes(ADAPTER_MARKER);
  } catch { return false; }
}

function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Create `file` exclusively (O_EXCL: never follows or reuses a pre-planted
// path) and write `content` through the fd. Unlinks only what it created.
function writeExclusive(file, content, mode) {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode); // umask may have cleared bits the original had
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
    throw err;
  }
  fs.closeSync(fd);
}

// Returns the backup path (null when there was no original to back up).
function writeSettingsFile(settingsPath, settings, { now = new Date() } = {}) {
  let target = settingsPath;
  try { target = fs.realpathSync(settingsPath); } catch {}
  let mode = null;
  let backup = null;
  let original = null;
  try {
    mode = fs.statSync(target).mode & 0o777;
    original = fs.readFileSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (original) {
    // Owner-only regardless of the source mode: settings can carry tokens.
    // Two runs inside one second must not overwrite the first backup.
    for (let n = 0; ; n++) {
      backup = `${settingsPath}.bak-${backupStamp(now)}${n ? `-${n}` : ''}`;
      try { writeExclusive(backup, original, 0o600); break; } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }
  const tmp = `${target}.ccxray-${process.pid}.tmp`;
  writeExclusive(tmp, JSON.stringify(settings, null, 2) + '\n', mode ?? 0o600);
  try {
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
  // A settings.json that does not parse holds content we cannot carry over;
  // rewriting it would silently replace the user's whole file.
  if (unparseable) return { status: 'refused', settingsPath };
  const { statusLine: current, command: existing } = currentStatusLine(settings);
  if (existing.includes(ADAPTER_MARKER)) {
    // Legacy installs wrote no "type"; repair it in place.
    if (current.type === 'command') return { status: 'already', settingsPath };
    const next = { ...settings, statusLine: { ...current, type: 'command' } };
    return { status: 'updated', settingsPath, exists, before: current, after: next.statusLine, next };
  }
  const statusLine = { ...(current || {}), type: 'command', command: adapterCommand() };
  if (existing) statusLine._ccxrayDelegate = existing;
  const next = { ...settings, statusLine };
  return {
    status: 'installed', settingsPath, exists,
    delegated: existing || null, before: settings.statusLine ?? null, after: statusLine, next,
  };
}

function planUninstall(claudeHome) {
  const settingsPath = settingsPathFor(claudeHome);
  const { exists, settings, unparseable } = readSettingsFile(settingsPath);
  // Same guard as planInstall: a non-object or unparseable file is never rewritten.
  if (!exists || unparseable) return { status: 'not_installed', settingsPath };
  const { statusLine: current, command: cmd } = currentStatusLine(settings);
  if (!cmd.includes(ADAPTER_MARKER)) return { status: 'not_installed', settingsPath };

  const next = { ...settings };
  const delegate = current._ccxrayDelegate;
  // ponytail: legacy fallback for old --delegate "cmd" format installs
  const legacyMatch = cmd.match(/--delegate "(.+)"/);
  if (delegate || legacyMatch) {
    const statusLine = { ...current, command: delegate || legacyMatch[1] };
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

function refusalMessage(settingsPath) {
  return `Refusing to install: ${settingsPath} is not valid JSON — fix or move it, then rerun ccxray setup-statusline.`;
}

// status 'refused' (unparseable settings.json) writes nothing.
function installStatusline(claudeHome) {
  const { status, delegated, backup, settingsPath } = applyPlan(planInstall(claudeHome));
  return { status, settingsPath, delegated: delegated || null, backup: backup || null };
}

function uninstallStatusline(claudeHome) {
  const { status, backup } = applyPlan(planUninstall(claudeHome));
  return { status, backup: backup || null };
}

const USAGE = `Usage: ccxray setup-statusline [options]

Install (or remove) the ccxray statusline adapter in Claude Code's
settings.json so rate limits appear on the Usage page. An existing
statusline is delegated to, not replaced, and restored on removal.
Before each rewrite the original is copied, owner-only (0600), to
settings.json.bak-<UTC timestamp> in the same directory; delete old
backups there when you no longer need them. A settings.json that is not
valid JSON is never rewritten: fix or move it first.

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
  else if (plan.status === 'refused') lines.push(`${label}: would refuse — ${plan.settingsPath} is not valid JSON; fix or move it.`);
  else {
    const verb = { installed: 'would install', updated: 'would add "type": "command" to', removed: 'would remove' }[plan.status];
    lines.push(`${label}: ${verb} the statusline in ${plan.settingsPath}`);
    lines.push(`  before: ${JSON.stringify(plan.before ?? null)}`);
    lines.push(`  after:  ${JSON.stringify(plan.after ?? null)}`);
    if (plan.exists) lines.push(`  backup: ${plan.settingsPath}.bak-<timestamp>`);
  }
  return lines.join('\n');
}

module.exports = {
  refusalMessage,
  USAGE,
  adapterCommand,
  isStatuslineInstalled,
  launchPromptState,
  installStatusline,
  uninstallStatusline,
  planInstall,
  planUninstall,
  writeSettingsFile,
  parseSetupStatuslineArgs,
  describePlan,
};
