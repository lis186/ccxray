'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ── A: API layer — tools-diff input whitelist ──────────────────────────────

describe('path-traversal #151', () => {

  describe('/_api/tools-diff input whitelist', () => {
    const { handleApiRoutes } = require('../server/routes/api');

    function callToolsDiff(url) {
      return new Promise((resolve) => {
        const clientReq = { url, method: 'GET' };
        let statusCode;
        const clientRes = {
          writeHead: (code) => { statusCode = code; },
          end: (data) => { resolve({ statusCode, body: JSON.parse(data) }); },
        };
        handleApiRoutes(clientReq, clientRes);
      });
    }

    it('rejects traversal in a param → 400', async () => {
      // ../x is not 12 hex chars → whitelist blocks it
      const result = await callToolsDiff('/_api/tools-diff?a=../x&b=0123456789ab');
      assert.equal(result.statusCode, 400, 'traversal in a must return 400');
    });

    it('rejects traversal in b param → 400', async () => {
      const result = await callToolsDiff('/_api/tools-diff?a=0123456789ab&b=../../etc/x');
      assert.equal(result.statusCode, 400, 'traversal in b must return 400');
    });

    it('rejects non-hex a param → 400', async () => {
      const result = await callToolsDiff('/_api/tools-diff?a=gggggggggggg&b=0123456789ab');
      assert.equal(result.statusCode, 400, 'non-hex a must return 400');
    });

    it('valid 12-hex hashes pass the format gate — not 400', async () => {
      // Both hashes are valid format. The shared files won't exist, so we may
      // get 404 or 500, but NOT 400 (which would mean the format check rejected them).
      const result = await callToolsDiff('/_api/tools-diff?a=0123456789ab&b=abcdef012345');
      assert.notEqual(result.statusCode, 400, 'valid hashes must not be rejected with 400');
    });
  });

  // ── B: Storage layer — safeJoin traversal guard ────────────────────────

  describe('local storage safeJoin', () => {
    // Build a temporary sharedDir so we can exercise the real adapter
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-test-'));
    const { createLocalStorage } = require('../server/storage/local');
    const storage = createLocalStorage(tmpBase);

    // init() creates logsDir/shared
    before(async () => { await storage.init(); });

    it('readShared with .. component throws traversal error', async () => {
      await assert.rejects(
        () => storage.readShared('../escape.json'),
        /traversal/,
        'should throw traversal error for ../escape.json'
      );
    });

    it('readShared with nested traversal throws traversal error', async () => {
      // 'subdir/../../../escape.json' — descends into subdir then escapes above sharedDir
      await assert.rejects(
        () => storage.readShared('subdir/../../../escape.json'),
        /traversal/,
        'should throw traversal error for subdir/../../../escape.json'
      );
    });

    it('readShared with absolute path throws traversal error', async () => {
      await assert.rejects(
        () => storage.readShared('/etc/hosts'),
        /traversal/,
        'should throw traversal error for absolute path'
      );
    });

    it('readShared with NUL byte throws', async () => {
      await assert.rejects(
        () => storage.readShared('tools_0123456789ab\0.json'),
        /NUL byte/,
        'should throw for NUL byte in filename'
      );
    });

    it('readShared with legit filename resolves within sharedDir (ENOENT, not traversal)', async () => {
      // File doesn't exist, but should reach the filesystem — not be blocked by safeJoin
      try {
        await storage.readShared('tools_0123456789ab.json');
        assert.fail('should have thrown (file does not exist)');
      } catch (e) {
        assert.ok(
          e.code === 'ENOENT',
          `expected ENOENT for missing file, got: ${e.message}`
        );
      }
    });
  });
});
