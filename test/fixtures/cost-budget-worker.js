'use strict';
// Synthetic workers owned and reaped by cost-budget-worker.test.js.
const fs = require('node:fs');
const path = require('node:path');
process.channel?.unref();
fs.writeFileSync(path.join(process.env.CCXRAY_HOME, 'worker.pid'), String(process.pid));
switch (process.env.CCXRAY_WORKER_FIXTURE_MODE) {
  case 'hang':
    process.on('SIGTERM', () => {});
    process.stdout.write('[{"complete":true}]');
    setInterval(() => {}, 1000);
    break;
  case 'error':
    process.stderr.write('synthetic worker failure');
    process.exitCode = 7;
    break;
  case 'large':
    process.stdout.write(JSON.stringify(Array.from({ length: 100000 }, (_, id) => ({ id, value: 'x'.repeat(100) }))));
    break;
  default:
    throw new Error('unknown worker fixture mode');
}
