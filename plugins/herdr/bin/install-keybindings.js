#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { resolveHerdrConfigPath, writeConfigAndReload } = require('./lib/ccxray');
const { addBindings, defaultBindings } = require('./lib/keybindings');

function main() {
  const file = resolveHerdrConfigPath();
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const bindings = defaultBindings();
  const { config, added, conflicts, unchanged } = addBindings(before, bindings);

  for (const { binding, boundTo } of conflicts) {
    console.error(`${binding.key} is already bound to ${boundTo}; leaving it alone.`);
    const override = binding.command.endsWith('mission-control')
      ? 'CCXRAY_HERDR_KEY_MISSION'
      : 'CCXRAY_HERDR_KEY_QUICK_START';
    console.error(`  Pick another key with ${override}=prefix+<key> and run this action again.`);
  }

  if (unchanged) {
    console.log(conflicts.length
      ? `no ccxray keybindings installed in ${file}`
      : `ccxray keybindings already installed in ${file}`);
    process.exit(conflicts.length ? 1 : 0);
  }

  const summary = added.map(b => `${b.key} → ${b.description}`).join(', ');
  const code = writeConfigAndReload(file, before, config, {
    successMessage: `installed ccxray keybindings in ${file}: ${summary}`,
  });
  process.exit(code);
}

main();
