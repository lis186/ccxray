'use strict';

const fs = require('fs');

fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
process.on('disconnect', () => process.exit(0));

process.stderr.write('synthetic worker stderr');
process.exitCode = 1;
process.send({ type: 'error', message: 'synthetic worker failure' });
