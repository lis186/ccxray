'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-health-capabilities-'));
process.env.CCXRAY_HOME = FIX_HOME;

const hub = require('../server/hub');

after(() => {
  fs.rmSync(FIX_HOME, { recursive: true, force: true });
});

describe('health capabilities', () => {
  it('advertises only implemented capabilities', () => {
    const response = {
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };

    assert.equal(hub.handleHubRoutes({ url: '/_api/health', method: 'GET' }, response), true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body).capabilities, []);
  });
});
