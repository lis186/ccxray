'use strict';

const fs = require('fs');

fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
process.on('disconnect', () => process.exit(0));

const entries = Array.from({ length: 2048 }, (_, i) => ({
  id: i,
  payload: 'x'.repeat(1024),
}));

process.send({ type: 'result', entries });
