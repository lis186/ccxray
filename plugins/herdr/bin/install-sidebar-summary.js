#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveHerdrConfigPath, runHerdr } = require('./lib/ccxray');

const CTX_BAR_COLOR_TOKENS = ['ctx_bar_unknown', 'ctx_bar_green', 'ctx_bar_yellow', 'ctx_bar_red'];
const CTX_BAR_ROWS = [
  '  [{ token = "$ctx_bar_unknown", fg = "#a6adc8", dim = true }],',
  '  [{ token = "$ctx_bar_green", fg = "#a6e3a1", dim = true }],',
  '  [{ token = "$ctx_bar_yellow", fg = "#f9e2af", dim = true }],',
  '  [{ token = "$ctx_bar_red", fg = "#f38ba8", dim = true }],',
].join('\n');
const OLD_CTX_BAR_ROW_RE = /^[ \t]*\[\{[^\n]*token\s*=\s*"\$ctx_bar"[^\n]*\}\],[ \t]*$/m;

const SIDEBAR_SUMMARY_SECTION = `

[ui.sidebar.agents]
row_gap = 0
rows = [
  ["state_icon", "workspace", "tab"],
  ["agent"],
  [{ token = "$summary", fg = "#89b4fa", dim = true }],
${CTX_BAR_ROWS}
]
`;

function configPath(env = process.env) {
  return resolveHerdrConfigPath(env);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
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
    console.error('Herdr already has [ui.sidebar.agents]. Add the ccxray rows manually:');
    console.error(SIDEBAR_SUMMARY_SECTION.trim());
    process.exit(1);
  }

  return writeAndReload(file, before, before.replace(/\s*$/, '') + SIDEBAR_SUMMARY_SECTION + '\n', 'installed');
}

function writeAndReload(file, before, next, action) {
  if (before === next) {
    console.log(`ccxray color sidebar summary rows already installed in ${file}`);
    process.exit(0);
  }

  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.ccxray-summary-backup-${timestamp()}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }

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
    console.error(`Herdr config check failed; backup: ${backup || 'none'}`);
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
