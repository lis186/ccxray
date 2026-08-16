#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { backupConfigFile, resolveHerdrConfigPath, runHerdr } = require('./lib/ccxray');

const CTX_BAR_COLOR_TOKENS = ['ctx_bar_unknown', 'ctx_bar_green', 'ctx_bar_yellow', 'ctx_bar_red'];
const CTX_BAR_ROWS = [
  '  [{ token = "$ctx_bar_unknown", fg = "#a6adc8", dim = true }],',
  '  [{ token = "$ctx_bar_green", fg = "#a6e3a1", dim = true }],',
  '  [{ token = "$ctx_bar_yellow", fg = "#f9e2af", dim = true }],',
  '  [{ token = "$ctx_bar_red", fg = "#f38ba8", dim = true }],',
].join('\n');
const OLD_CTX_BAR_ROW_RE = /^[ \t]*\[\{[^\n]*token\s*=\s*"\$ctx_bar"[^\n]*\}\],[ \t]*$/m;
const SUMMARY_ROW = '  [{ token = "$summary", fg = "#89b4fa", dim = true }],';
const CCXRAY_ROWS = `${SUMMARY_ROW}\n${CTX_BAR_ROWS}`;
const DEFAULT_ROWS = '  ["state_icon", "workspace", "tab"],\n  ["agent"],';
// Written only when this script creates the section itself, so
// remove-sidebar-summary can tell "ccxray added this whole table" from
// "the user already had a sidebar table and ccxray added rows to it".
const SECTION_MARKER = '# ccxray sidebar summary rows (managed by the ccxray Herdr plugin)';

const SIDEBAR_SUMMARY_SECTION = `

${SECTION_MARKER}
[ui.sidebar.agents]
row_gap = 0
rows = [
${DEFAULT_ROWS}
${CCXRAY_ROWS}
]
`;

function configPath(env = process.env) {
  return resolveHerdrConfigPath(env);
}

function tokenRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`token\\s*=\\s*"\\$${escaped}"`);
}

function hasToken(config, token) {
  return tokenRegex(token).test(config);
}

function hasColorRows(config) {
  return CTX_BAR_COLOR_TOKENS.every(token => hasToken(config, token));
}

function addCtxBarRows(config) {
  const summaryRow = /^[ \t]*\[\{[^\n]*token\s*=\s*"\$summary"[^\n]*\}\],[ \t]*$/m;
  if (!summaryRow.test(config)) return null;
  return config.replace(summaryRow, match => `${match}\n${CTX_BAR_ROWS}`);
}

function addMissingCtxBarRows(config) {
  const missing = CTX_BAR_COLOR_TOKENS.filter(token => !hasToken(config, token));
  if (!missing.length) return config;
  const rows = missing.map(token => {
    const colors = {
      ctx_bar_unknown: '#a6adc8',
      ctx_bar_green: '#a6e3a1',
      ctx_bar_yellow: '#f9e2af',
      ctx_bar_red: '#f38ba8',
    };
    return `  [{ token = "$${token}", fg = "${colors[token]}", dim = true }],`;
  }).join('\n');
  const summaryRow = /^[ \t]*\[\{[^\n]*token\s*=\s*"\$summary"[^\n]*\}\],[ \t]*$/m;
  if (!summaryRow.test(config)) return null;
  return config.replace(summaryRow, match => `${match}\n${rows}`);
}

function ensureColorCtxBarRows(config) {
  if (hasColorRows(config) && !OLD_CTX_BAR_ROW_RE.test(config)) return { changed: false, config };

  if (OLD_CTX_BAR_ROW_RE.test(config)) {
    return {
      changed: true,
      config: config.replace(OLD_CTX_BAR_ROW_RE, CTX_BAR_ROWS),
    };
  }

  const added = addMissingCtxBarRows(config);
  if (!added) return null;
  return { changed: true, config: added };
}

// A TOML table header is a bare dotted key in brackets at column 0, so an
// unindented `["agent"]` element inside a rows array can never be mistaken for
// the start of the next table.
const TABLE_HEADER_RE = /^\[[A-Za-z0-9_.-]+\][ \t]*$/m;

function sidebarSectionBounds(config) {
  const header = /^[ \t]*\[ui\.sidebar\.agents\][ \t]*$/m.exec(config);
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
  const bounds = sidebarSectionBounds(config);
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

function main() {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  if (hasToken(before, 'summary')) {
    const ensured = ensureColorCtxBarRows(before);
    if (!ensured) {
      console.error('Herdr already has a $summary sidebar row. Add these rows below it manually:');
      console.error(CTX_BAR_ROWS);
      process.exit(1);
    }
    if (!ensured.changed) {
      console.log(`ccxray color sidebar summary rows already installed in ${file}`);
      process.exit(0);
    }
    return writeAndReload(file, before, ensured.config, 'updated');
  }

  if (/^\s*\[ui\.sidebar\.agents\]\s*$/m.test(before)) {
    const merged = addRowsToExistingSection(before);
    if (!merged) {
      console.error(`Could not parse [ui.sidebar.agents] in ${file}; add these rows to its rows array manually:`);
      console.error(CCXRAY_ROWS);
      process.exit(1);
    }
    return writeAndReload(file, before, merged, 'installed');
  }

  return writeAndReload(file, before, before.replace(/\s*$/, '') + SIDEBAR_SUMMARY_SECTION + '\n', 'installed');
}

function writeAndReload(file, before, next, action) {
  if (before === next) {
    console.log(`ccxray color sidebar summary rows already installed in ${file}`);
    process.exit(0);
  }

  let backup = null;
  if (fs.existsSync(file)) backup = backupConfigFile(file);

  fs.writeFileSync(file, next);

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

main();
