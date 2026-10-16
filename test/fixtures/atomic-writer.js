'use strict';
// Owned by atomic-writes.test.js: barriers expose collisions without race odds.
const fs = require('node:fs');
const path = require('node:path');
const [mode, home, writer, pid] = process.argv.slice(2);
const realPid = process.pid;
Object.defineProperty(process, 'pid', { value: Number(pid) });
const logs = path.join(home, 'logs');
const index = path.join(logs, 'index.ndjson');
let temp;
function barrier(phase, facts = {}) {
  fs.writeFileSync(path.join(home, `${phase}-${writer}.json`), JSON.stringify({ realPid, ...facts }));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(home, `release-${phase}-${writer}`))) {
    if (Date.now() > deadline) throw new Error(`barrier ${phase} timed out`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (mode === 'adapter') {
  const rename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    barrier('commit', { temp: src, content: fs.readFileSync(src, 'utf8') });
    return rename(src, dest);
  };
  require('../../server/adapters/claude-adapter').processInput(JSON.stringify({
    rate_limits: { five_hour: { used_percentage: writer === 'a' ? 11 : 22, resets_at: 1750000000 } },
  }), path.join(home, 'usage-status'), 'shared');
} else if (mode === 'prune') {
  const config = require('../../server/config');
  config.storage.list = async () => [`${writer}_req.json`];
  const create = fs.createWriteStream;
  fs.createWriteStream = (file, options) => {
    temp = file;
    // Both startup sweeps must finish before either writer creates a temp.
    barrier('write', { temp });
    return create(file, options);
  };
  const stat = fs.statSync;
  let indexStats = 0;
  fs.statSync = (file, ...args) => {
    if (file === index && ++indexStats === 2) {
      barrier('commit', { temp, content: fs.readFileSync(temp, 'utf8') });
    }
    return stat(file, ...args);
  };
  require('../../server/restore').pruneLogs().catch(err => { console.error(err); process.exitCode = 1; });
} else {
  throw new Error('unknown fixture mode');
}
