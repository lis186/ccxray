#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { resolveHerdrConfigPath, runHerdr } = require('./lib/ccxray');

const TOKENS = ['summary', 'ctx_bar', 'ctx_bar_unknown', 'ctx_bar_green', 'ctx_bar_yellow', 'ctx_bar_red'];

function configPath(env = process.env) {
  return resolveHerdrConfigPath(env);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
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
  if (next === before) {
    console.log(`ccxray sidebar summary rows are not installed in ${file}`);
    return;
  }

  const backup = `${file}.ccxray-summary-backup-${timestamp()}`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(file, next);

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
