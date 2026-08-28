#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { backupConfigFile, resolveHerdrConfigPath, runHerdr } = require('./lib/ccxray');

const {
  DEFAULT_ROWS,
  MANAGED_TOKENS,
  SPACES_SECTION_MARKER,
  SECTION_MARKER,
} = require('./install-sidebar-summary');

// Every token the installer manages, plus the generations it migrates away from.
// `summary` and the single `ctx_bar` are gone from fresh installs but still sit
// in configs written before the three-row layout, and uninstall has to clean
// those too.
const TOKENS = [...MANAGED_TOKENS, 'xray', 'summary', 'ctx_bar'];
// The skeleton install-sidebar-summary writes when it creates the table itself.
// Removal drops the whole table only when it still matches this exactly, so a
// table the user wrote (or later edited) keeps its other rows.
//
// Derived from the installer's own DEFAULT_ROWS rather than re-typed: these two
// files disagreed the moment row 1 changed shape, and the symptom would have
// been an uninstall that silently leaves an empty table behind.
// Both the new and legacy managed row-1 shapes, so removal recognizes any
// table this installer ever created. codex round 1, P2a.
const LEGACY_DEFAULT_ROWS = [
  '["state_icon", "workspace", "tab"],',
  '["agent"],',
];
const NEW_DEFAULT_ROWS = DEFAULT_ROWS.split('\n').map(line => line.trim());
const NEW_IDENTITY_ROW_RE = /^[ \t]*(\["state_icon",\s*\{\s*token\s*=\s*"\$who"[^\n]*\}\],?)[ \t]*$/gm;
const RESTORED_IDENTITY_ROW = '  ["state_icon", "agent", "state_text"],';
function makeSkeleton(defaults) {
  return ['[ui.sidebar.agents]', 'row_gap = 0', 'rows = [', ...defaults, ']'].join('\n');
}
const MANAGED_SKELETONS = [makeSkeleton(NEW_DEFAULT_ROWS), makeSkeleton(LEGACY_DEFAULT_ROWS)];
const WORKSPACE_SKELETON = ['[ui.sidebar.spaces]', 'row_gap = 0', 'rows = [', '  [{ token = "$xray", fg = "#a6e3a1" }],', ']'].join('\n');
const EMPTY_WORKSPACE_SKELETON = ['[ui.sidebar.spaces]', 'row_gap = 0', 'rows = [', ']'].join('\n');

function normalizeBlock(block) {
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

// Removes the whole managed table (marker included) when this plugin created it
// and nothing else was added to it; otherwise returns null so the caller falls
// back to stripping only the ccxray token rows.
function removeManagedSection(config, stripped) {
  const marker = stripped.indexOf(SECTION_MARKER);
  if (marker < 0) return null;
  const header = /^[ \t]*\[ui\.sidebar\.agents\][ \t]*$/m.exec(stripped.slice(marker));
  if (!header) return null;
  const headerStart = marker + header.index;
  const bodyStart = headerStart + header[0].length;
  const next = /^\[[A-Za-z0-9_.-]+\][ \t]*$/m.exec(stripped.slice(bodyStart));
  const end = next ? bodyStart + next.index : stripped.length;
  const normalized = normalizeBlock(stripped.slice(headerStart, end).replace(/^[ \t]*#.*$/gm, ''));
  if (!MANAGED_SKELETONS.some(skel => normalized === skel)) return null;
  const before = stripped.slice(0, marker).replace(/[ \t]*$/, '');
  return `${before.replace(/\n{3,}$/, '\n\n')}${stripped.slice(end).replace(/^\n+/, '')}`;
}

function removeManagedWorkspaceSection(config, stripped) {
  const marker = stripped.indexOf(SPACES_SECTION_MARKER);
  if (marker < 0) return null;
  const header = /^[ \t]*\[ui\.sidebar\.spaces\][ \t]*$/m.exec(stripped.slice(marker));
  if (!header) return null;
  const headerStart = marker + header.index;
  const bodyStart = headerStart + header[0].length;
  const next = /^\[[A-Za-z0-9_.-]+\][ \t]*$/m.exec(stripped.slice(bodyStart));
  const end = next ? bodyStart + next.index : stripped.length;
  const normalized = normalizeBlock(stripped.slice(headerStart, end).replace(/^[ \t]*#.*$/gm, ''));
  if (normalized !== WORKSPACE_SKELETON && normalized !== EMPTY_WORKSPACE_SKELETON) return null;
  const before = stripped.slice(0, marker).replace(/[ \t]*$/, '');
  return `${before.replace(/\n{3,}$/, '\n\n')}${stripped.slice(end).replace(/^\n+/, '')}`;
}

function configPath(env = process.env) {
  return resolveHerdrConfigPath(env);
}

function tokenRowRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*\\[\\{[^\\n]*token\\s*=\\s*"\\$${escaped}"[^\\n]*\\}\\],[ \\t]*\\n?`, 'gm');
}

function main() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    console.log(`no Herdr config found at ${file}`);
    return;
  }
  const before = fs.readFileSync(file, 'utf8');
  let next = before;
  for (const token of TOKENS) next = next.replace(tokenRowRegex(token), '');
  // Remove the workspace block first. The agents block's next-table boundary
  // would otherwise consume the workspace marker comment while deleting a
  // freshly-created agents section, leaving an orphaned empty spaces table.
  next = removeManagedWorkspaceSection(before, next) || next;
  const managedSection = removeManagedSection(before, next);
  if (managedSection !== null) next = managedSection;
  if (managedSection === null) {
    next = next.replace(NEW_IDENTITY_ROW_RE, RESTORED_IDENTITY_ROW);
  }
  if (next === before) {
    console.log(`ccxray sidebar summary rows are not installed in ${file}`);
    return;
  }

  const backup = backupConfigFile(file);
  const tmpFile = `${file}.ccxray-tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, next);
  fs.renameSync(tmpFile, file);

  if (process.env.CCXRAY_HERDR_SKIP_RELOAD === '1') {
    console.log(`removed ccxray sidebar summary rows from ${file}`);
    console.log(`backup: ${backup}`);
    return;
  }

  const check = runHerdr(['config', 'check'], { timeoutMs: 5000 });
  process.stdout.write(check.stdout || '');
  process.stderr.write(check.stderr || '');
  if (check.status !== 0 || check.error) {
    fs.copyFileSync(backup, file);
    console.error(`Herdr config check failed; restored ${backup}`);
    process.exit(1);
  }

  const reload = runHerdr(['server', 'reload-config'], { timeoutMs: 5000 });
  process.stdout.write(reload.stdout || '');
  process.stderr.write(reload.stderr || '');
  if (reload.status !== 0 || reload.error) {
    console.error('Config was updated, but Herdr reload failed. Restart Herdr to apply it.');
    process.exit(1);
  }
  console.log(`removed ccxray sidebar summary rows from ${file}`);
  console.log(`backup: ${backup}`);
}

main();
