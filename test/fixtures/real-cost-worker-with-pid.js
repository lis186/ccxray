'use strict';

const fs = require('fs');

fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
require('../../server/cost-worker');
