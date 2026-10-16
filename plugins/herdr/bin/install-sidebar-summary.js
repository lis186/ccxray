#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { backupConfigFile, resolveHerdrConfigPath, runHerdr } = require('./lib/ccxray');

// Every row this installer manages, and the ONE place its colours are written.
// The colours used to be declared twice — once here and once inline in
// addMissingCtxBarRows — so a repaired config could disagree with a fresh one.
const MANAGED_ROW_BY_TOKEN = {
  who: '  [{ token = "$who", fg = "#cdd6f4" }],',
  route: '  [{ token = "$route", fg = "#a6e3a1" }],',
  ctx_bar_unknown: '  [{ token = "$ctx_bar_unknown", fg = "#a6adc8", dim = true }],',
  ctx_bar_green: '  [{ token = "$ctx_bar_green", fg = "#a6e3a1", dim = true }],',
  ctx_bar_yellow: '  [{ token = "$ctx_bar_yellow", fg = "#f9e2af", dim = true }],',
  ctx_bar_red: '  [{ token = "$ctx_bar_red", fg = "#f38ba8", dim = true }],',
  facts: '  [{ token = "$facts", fg = "#a6adc8", dim = true }],',
  alert: '  [{ token = "$alert", fg = "#f9e2af" }],',
};
const CTX_BAR_COLOR_TOKENS = ['ctx_bar_unknown', 'ctx_bar_green', 'ctx_bar_yellow', 'ctx_bar_red'];
const CTX_BAR_ROWS = CTX_BAR_COLOR_TOKENS.map(token => MANAGED_ROW_BY_TOKEN[token]).join('\n');
const OLD_CTX_BAR_ROW_RE = /^[ \t]*\[\{[^\n]*token\s*=\s*"\$ctx_bar"[^\n]*\}\],[ \t]*$/m;
// Row 3: two tokens, one meaning each, only one non-empty per refresh (see
// refresh-badges applyRow3Tokens). Herdr skips a row whose tokens are all empty
// — the four ctx_bar colour rows above have relied on that in production since
// they shipped, rendering one visible line out of four config rows — so this
// pair costs two rows and shows one line.
const ROW3_TOKENS = ['facts', 'alert'];
const ROW3_ROWS = ROW3_TOKENS.map(token => MANAGED_ROW_BY_TOKEN[token]).join('\n');
const MANAGED_TOKENS = ['who', 'route', ...CTX_BAR_COLOR_TOKENS, ...ROW3_TOKENS];
// Rows that earlier generations of this installer wrote, plus one no generation
// ever wrote. Each entry is the COMPLETE token set of a row we may delete: a row
// carrying anything else is the user's, and is left for them to edit.
//
//  - ctx/model/cost: the atomic-token generation. Its three facts are now row 2
//    (ctx) and row 3 (cost), and printing them beside $summary is what made the
//    model appear three times in one card.
//  - summary: the pre-assembled line. Every field in it now has an owning row.
//  - tg/ty/tr: this plugin has never provided these tokens. Dead config that
//    rendered nothing, which is why it survived unnoticed.
const SUPERSEDED_ROW_TOKENS = [
  ['ctx', 'model', 'cost'],
  ['summary'],
  ['tg', 'ty', 'tr'],
];
// The row 1 shape earlier installers wrote. These are bare-string arrays
// (no `$` prefix), so rowLineTokens returns `[]` for them — we match on the
// normalized text content instead.
const LEGACY_DEFAULT_ROWS_RE = [
  /^\s*\["state_icon",\s*"workspace",\s*"tab"\],?\s*$/,
  /^\s*\["agent"\],?\s*$/,
  /^\s*\["state_icon",\s*"agent",\s*"state_text"\],?\s*$/,
];
const DEFAULT_ROWS = '  ["state_icon", { token = "$who", fg = "#cdd6f4" }],';
const CCXRAY_ROWS = `${MANAGED_ROW_BY_TOKEN.route}\n${CTX_BAR_ROWS}\n${ROW3_ROWS}`;
// Written only when this script creates the section itself, so
// remove-sidebar-summary can tell "ccxray added this whole table" from
// "the user already had a sidebar table and ccxray added rows to it".
const SECTION_MARKER = '# ccxray sidebar summary rows (managed by the ccxray Herdr plugin)';
const SPACES_SECTION_MARKER = '# ccxray workspace observability row (managed by the ccxray Herdr plugin)';
const DEFAULT_SPACES_ROWS = [
  '  ["state_icon", "workspace"],',
  '  ["branch", "git_status"],',
].join('\n');
const WORKSPACE_ROW = '  [{ token = "$xray", fg = "#a6e3a1" }],';

const SIDEBAR_SUMMARY_SECTION = `

${SECTION_MARKER}
[ui.sidebar.agents]
row_gap = 0
rows = [
${DEFAULT_ROWS}
${CCXRAY_ROWS}
]
`;

const SIDEBAR_WORKSPACE_SECTION = `

${SPACES_SECTION_MARKER}
[ui.sidebar.spaces]
row_gap = 0
rows = [
${DEFAULT_SPACES_ROWS}
${WORKSPACE_ROW}
]
`;

function configPath(env = process.env) {
  return resolveHerdrConfigPath(env);
}

function tokenRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`token\\s*=\\s*"\\$${escaped}"`);
}

// Row detection must not see commented-out examples. Herdr's own documentation
// shows sidebar rows in comments, and a config carrying one dead-ended the
// install: the token test matched the commented `$summary`, so the script reported
// "Herdr already has a $summary sidebar row", while the row regexes — which
// require a real `[{ … }],` line — found nothing to insert below, leaving the
// user with a manual-add message and no way to proceed.
// Line-leading comments are what actually occur; a token hidden in a trailing
// comment after real content is not handled and would still be seen.
function stripCommentLines(config) {
  return String(config).replace(/^[ \t]*#.*$/gm, '');
}

// What "installed" means, defined once. onboarding.js used to spell out its own
// regex over `$summary` + one ctx_bar colour, so this file could change the row
// set and Quick Start would keep reporting on the old one — it did exactly that
// when $summary was retired. It also did not strip comments, so a commented-out
// example row counted as installed, the same trap stripCommentLines exists for.
function configHasManagedRows(config) {
  const body = stripCommentLines(String(config || ''));
  return MANAGED_TOKENS.every(token => tokenRegex(token).test(body));
}

// The tokens a rows-array line names, or null when the line is not a row at all.
// A line-leading comment is not a row: Herdr's own docs show example rows in
// comments, and one of them already dead-ended this installer once.
function rowLineTokens(line) {
  if (/^[ \t]*#/.test(line)) return null;
  if (!/^[ \t]*\[/.test(line)) return null;
  return [...line.matchAll(/\$([A-Za-z0-9_]+)/g)].map(match => match[1]);
}

function sameTokenSet(a, b) {
  return a.length === b.length
    && a.slice().sort().join(',') === b.slice().sort().join(',');
}

// Migrate the rows array of an existing [ui.sidebar.agents] to the three-row
// layout. This REPLACES the previous add-only behaviour: the old installer could
// only append, so a config carrying an earlier generation's rows got the new
// ones stacked on top and rendered MORE duplication, not less. The migration
// mechanism itself is not new — OLD_CTX_BAR_ROW_RE has been migrating the single
// $ctx_bar generation to the four colour variants — this widens it to the
// generations that shipped around it.
//
// Deletion is conservative in two ways: it only ever touches lines inside this
// one rows array, and only lines whose COMPLETE token set matches a superseded
// generation. A row where the user added something of their own is kept, because
// we cannot know which half they wanted.
function migrateRowsArray(config, rows) {
  const inner = config.slice(rows.open + 1, rows.close);
  const hasMarker = config.includes(SECTION_MARKER);
  const hasPluginGeneration = hasMarker
    || /\$(?:summary|ctx_bar|ctx_bar_unknown|ctx_bar_green|ctx_bar_yellow|ctx_bar_red|facts|alert)/.test(stripCommentLines(inner));
  const removed = [];
  const kept = [];
  for (const line of inner.split('\n')) {
    const tokens = rowLineTokens(line);
    if (tokens && tokens.length
      && SUPERSEDED_ROW_TOKENS.some(set => sameTokenSet(set, tokens))) {
      removed.push(tokens.map(token => `$${token}`).join(' '));
      continue;
    }
    kept.push(line);
  }

  // The old installer's DEFAULT_ROWS (`state_icon workspace tab` + `agent`) are
  // our rows, not the user's — replace them with the new shape. Without this, a
  // table emitted by the previous installer keeps two legacy rows and renders
  // four visible lines instead of three. codex round 1, P1.
  //
  // Only when the config carries the SECTION_MARKER or recognizable ccxray
  // tokens: a user-authored table may
  // have `["agent"]` as their own row and we must not touch it. A marker or
  // managed token proves this table was created by the plugin. codex round 2, P1.
  {
    const isLegacyDefault = line => hasPluginGeneration && LEGACY_DEFAULT_ROWS_RE.some(re => re.test(line));
    const keptLines = kept.filter(line => !isLegacyDefault(line));
    if (keptLines.length < kept.length) {
      const firstRemoved = kept.findIndex(isLegacyDefault);
      keptLines.splice(firstRemoved, 0, DEFAULT_ROWS);
      removed.push('legacy default rows');
    }
    kept.length = 0;
    kept.push(...keptLines);
  }

  let body = kept.join('\n');
  // The single-$ctx_bar generation becomes the four colour variants in place, so
  // row 2 keeps its position rather than jumping below row 3.
  if (OLD_CTX_BAR_ROW_RE.test(body)) body = body.replace(OLD_CTX_BAR_ROW_RE, CTX_BAR_ROWS);

  const present = token => tokenRegex(token).test(stripCommentLines(body));
  const missing = MANAGED_TOKENS.filter(token => !present(token));
  if (missing.length) {
    const trimmed = body.replace(/[ \t\r\n]*$/, '');
    const separator = trimmed.trim() && !trimmed.trim().endsWith(',') ? ',' : '';
    body = `${trimmed}${separator}\n${missing.map(token => MANAGED_ROW_BY_TOKEN[token]).join('\n')}\n`;
  }

  return {
    config: `${config.slice(0, rows.open + 1)}${body}${config.slice(rows.close)}`,
    removed,
    added: missing,
  };
}

// A TOML table header is a bare dotted key in brackets at column 0, so an
// unindented `["agent"]` element inside a rows array can never be mistaken for
// the start of the next table.
const TABLE_HEADER_RE = /^\[[A-Za-z0-9_.-]+\][ \t]*$/m;

function sidebarSectionBounds(config) {
  const header = /^[ \t]*\[ui\.sidebar\.(agents|spaces)\][ \t]*$/m.exec(config);
  if (!header) return null;
  const bodyStart = header.index + header[0].length;
  const next = TABLE_HEADER_RE.exec(config.slice(bodyStart));
  return {
    headerStart: header.index,
    bodyStart,
    bodyEnd: next ? bodyStart + next.index : config.length,
  };
}

function namedSidebarSectionBounds(config, name) {
  const header = new RegExp(`^[ \\t]*\\[ui\\.sidebar\\.${name}\\][ \\t]*$`, 'm').exec(config);
  if (!header) return null;
  const bodyStart = header.index + header[0].length;
  const next = TABLE_HEADER_RE.exec(config.slice(bodyStart));
  return {
    headerStart: header.index,
    bodyStart,
    bodyEnd: next ? bodyStart + next.index : config.length,
  };
}

function rowsArrayBounds(config, bounds) {
  const slice = config.slice(bounds.bodyStart, bounds.bodyEnd);
  const match = /^[ \t]*rows[ \t]*=[ \t]*\[/m.exec(slice);
  if (!match) return null;
  const open = bounds.bodyStart + match.index + match[0].length - 1;
  let depth = 0;
  for (let index = open; index < bounds.bodyEnd; index += 1) {
    const char = config[index];
    if (char === '#') {
      while (index < bounds.bodyEnd && config[index] !== '\n') index += 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < bounds.bodyEnd && config[index] !== '"') {
        if (config[index] === '\\') index += 1;
        index += 1;
      }
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return { open, close: index };
    }
  }
  return null;
}

// A user who already has [ui.sidebar.agents] — including one this plugin's own
// remove action left behind — must still be able to install. Refusing here made
// remove/install a one-way door.
function addRowsToExistingSection(config) {
  const bounds = namedSidebarSectionBounds(config, 'agents');
  if (!bounds) return null;
  const rows = rowsArrayBounds(config, bounds);
  if (!rows) {
    const insertion = `\nrows = [\n${DEFAULT_ROWS}\n${CCXRAY_ROWS}\n]`;
    return config.slice(0, bounds.bodyStart) + insertion + config.slice(bounds.bodyStart);
  }
  const inner = config.slice(rows.open + 1, rows.close).replace(/[ \t\r\n]*$/, '');
  const separator = inner.trim() && !inner.trim().endsWith(',') ? ',' : '';
  return `${config.slice(0, rows.open + 1)}${inner}${separator}\n${CCXRAY_ROWS}\n${config.slice(rows.close)}`;
}

function addWorkspaceRow(config) {
  const bounds = namedSidebarSectionBounds(config, 'spaces');
  if (!bounds) return `${config.replace(/\s*$/, '')}${SIDEBAR_WORKSPACE_SECTION}\n`;
  const rows = rowsArrayBounds(config, bounds);
  if (!rows) {
    const insertion = `\nrows = [\n${WORKSPACE_ROW}\n]`;
    return config.slice(0, bounds.bodyStart) + insertion + config.slice(bounds.bodyStart);
  }
  const inner = config.slice(rows.open + 1, rows.close);
  if (tokenRegex('xray').test(stripCommentLines(inner))) {
    // The previous installer's from-scratch section carried only the $xray row,
    // which replaces Herdr's built-in spaces rows and hides workspace names.
    // Upgrade exactly that shape, and only when the ownership marker directly
    // precedes this section — a marker elsewhere proves nothing about it.
    const innerRows = stripCommentLines(inner).split('\n').map(line => line.trim()).filter(Boolean);
    const ownsSection = config.slice(0, bounds.headerStart).trimEnd().endsWith(SPACES_SECTION_MARKER);
    if (ownsSection && innerRows.length === 1 && innerRows[0] === WORKSPACE_ROW.trim()) {
      return `${config.slice(0, rows.open + 1)}\n${DEFAULT_SPACES_ROWS}\n${WORKSPACE_ROW}\n${config.slice(rows.close)}`;
    }
    return config;
  }
  const trimmed = inner.replace(/[ \t\r\n]*$/, '');
  const separator = trimmed.trim() && !trimmed.trim().endsWith(',') ? ',' : '';
  return `${config.slice(0, rows.open + 1)}${trimmed}${separator}\n${WORKSPACE_ROW}\n${config.slice(rows.close)}`;
}

function main() {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  let next;
  let action = 'updated';
  // No agents section at all — write the whole compact layout.
  if (!/^\s*\[ui\.sidebar\.agents\]\s*$/m.test(before)) {
    next = before.replace(/\s*$/, '') + SIDEBAR_SUMMARY_SECTION + '\n';
    action = 'installed';
  } else {
    const bounds = namedSidebarSectionBounds(before, 'agents');
    const rows = bounds && rowsArrayBounds(before, bounds);
    if (!rows) {
      // The section exists but its rows array is missing or unparseable.
      const merged = addRowsToExistingSection(before);
      if (!merged) {
        console.error(`Could not parse [ui.sidebar.agents] in ${file}; add these rows to its rows array manually:`);
        console.error(CCXRAY_ROWS);
        process.exit(1);
      }
      next = merged;
      action = 'installed';
    } else {
      const migrated = migrateRowsArray(before, rows);
      for (const row of migrated.removed) console.log(`superseded row removed: ${row}`);
      next = migrated.config;
      action = migrated.removed.length ? 'migrated' : 'updated';
    }
  }
  const withWorkspace = addWorkspaceRow(next);
  if (withWorkspace !== next && action === 'updated') action = 'installed';
  return writeAndReload(file, before, withWorkspace, action);
}

function writeAndReload(file, before, next, action) {
  if (before === next) {
    console.log(`ccxray color sidebar summary rows already installed in ${file}`);
    process.exit(0);
  }

  let backup = null;
  if (fs.existsSync(file)) backup = backupConfigFile(file);

  const tmpFile = `${file}.ccxray-tmp-${process.pid}`;
  fs.writeFileSync(tmpFile, next);
  fs.renameSync(tmpFile, file);

  if (process.env.CCXRAY_HERDR_SKIP_RELOAD === '1') {
    console.log(`${action} sidebar summary rows in ${file}`);
    if (backup) console.log(`backup: ${backup}`);
    process.exit(0);
  }

  const check = runHerdr(['config', 'check'], { timeoutMs: 5000 });
  process.stdout.write(check.stdout || '');
  process.stderr.write(check.stderr || '');
  if (check.status !== 0 || check.error) {
    // Put the user's own config back. Printing where the backup lives and
    // leaving the rejected merge in place hands them a herdr that will not
    // start and a manual recovery step — remove-sidebar-summary has always
    // restored here, and install must be symmetric with it.
    if (backup) {
      fs.copyFileSync(backup, file);
      console.error(`Herdr config check failed; restored ${backup}`);
    } else {
      fs.rmSync(file, { force: true });
      console.error('Herdr config check failed; restored the absent config');
    }
    process.exit(1);
  }

  const reload = runHerdr(['server', 'reload-config'], { timeoutMs: 5000 });
  process.stdout.write(reload.stdout || '');
  process.stderr.write(reload.stderr || '');
  if (reload.status !== 0 || reload.error) {
    console.error('Config was updated, but Herdr reload failed. Restart Herdr to apply it.');
    process.exit(1);
  }

  console.log(`${action} sidebar summary rows in ${file}`);
  if (backup) console.log(`backup: ${backup}`);
}

// ADR 0015's two-mode shape: executed mode installs, imported mode is
// side-effect free so remove-sidebar-summary can read the managed-row constants
// from the one file that defines them, and tests can drive the migration without
// touching anybody's config. The uninstaller used to re-declare the skeleton it
// deletes, and this change already caught that drift: row 1 became
// `state_icon · agent · state_text` here while the uninstaller still matched the
// old two-row default, so removal would have left the table behind.
if (require.main === module) main();

module.exports = {
  CCXRAY_ROWS,
  DEFAULT_ROWS,
  MANAGED_ROW_BY_TOKEN,
  MANAGED_TOKENS,
  DEFAULT_SPACES_ROWS,
  SPACES_SECTION_MARKER,
  SECTION_MARKER,
  WORKSPACE_ROW,
  LEGACY_DEFAULT_ROWS_RE,
  SUPERSEDED_ROW_TOKENS,
  configHasManagedRows,
  migrateRowsArray,
  rowLineTokens,
  rowsArrayBounds,
  sameTokenSet,
  sidebarSectionBounds,
};
