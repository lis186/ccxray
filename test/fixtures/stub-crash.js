'use strict';

const fs = require('fs');

fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
process.stderr.write('synthetic worker crash');
process.exit(1);
