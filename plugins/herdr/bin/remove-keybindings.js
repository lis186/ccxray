#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { resolveHerdrConfigPath, writeConfigAndReload } = require('./lib/ccxray');
const { removeBindings } = require('./lib/keybindings');

function main() {
  const file = resolveHerdrConfigPath();
  if (!fs.existsSync(file)) {
    console.log(`no Herdr config found at ${file}`);
    return;
  }
  const before = fs.readFileSync(file, 'utf8');
  const { config } = removeBindings(before);
  const code = writeConfigAndReload(file, before, config, {
    successMessage: `removed ccxray keybindings from ${file}`,
    unchangedMessage: `ccxray keybindings are not installed in ${file}`,
  });
  process.exit(code);
}

main();
