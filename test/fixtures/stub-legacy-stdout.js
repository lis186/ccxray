'use strict';

const fs = require('fs');

fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));

const entries = Array.from({ length: 2048 }, (_, i) => ({
  id: i,
  payload: 'y'.repeat(1024),
}));

process.stdout.write(JSON.stringify(entries));
