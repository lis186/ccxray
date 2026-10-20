'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const groups = { unit: [], heavy: [], browser: [] };
for (const name of fs.readdirSync(path.join(root, 'test')).sort()) {
  if (!name.endsWith('.test.js')) continue;
  const source = fs.readFileSync(path.join(root, 'test', name), 'utf8');
  // Conservative: even a mocked child_process import belongs in the serial lane.
  const group = /require\(['"]puppeteer['"]\)/.test(source) ? 'browser'
    : /(?:[.-]e2e[.-])/.test(name) || /child_process/.test(source) ? 'heavy' : 'unit';
  groups[group].push(`test/${name}`);
}

const mode = process.argv[2] || 'all';
if (mode !== 'all' && !Object.hasOwn(groups, mode)) {
  console.error('Usage: node scripts/run-tests.js [all|unit|heavy|browser] [--list]');
  process.exit(1);
}
let failed = false;
for (const group of mode === 'all' ? Object.keys(groups) : [mode]) {
  const files = groups[group];
  console.log(`${group}: ${files.length} test files`);
  if (process.argv.includes('--list')) {
    console.log(files.join('\n'));
    continue;
  }
  if (!files.length) continue;
  const result = spawnSync(process.execPath, [
    '--require', './test/helpers/home-guard.js',
    // Unit lane must not touch the network (#717); loopback and unix sockets stay allowed.
    ...(group === 'unit' ? ['--require', './test/helpers/no-network.js'] : []),
    '--test',
    ...(group === 'unit' ? [] : ['--test-concurrency=1']), ...files,
  ], {
    cwd: root,
    // Enforce: a blocked outbound attempt fails the test process even if the code catches the throw.
    env: group === 'unit' ? { ...process.env, CCXRAY_NETWORK_GUARD_ENFORCE: '1' } : process.env,
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) failed = true;
  if (result.signal) process.exit(1);
}
process.exitCode = failed ? 1 : 0;
